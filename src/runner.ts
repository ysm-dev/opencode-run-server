import { randomUUID } from "node:crypto";
import type { Plugin } from "@opencode/plugin";
import { attachments } from "./attachments.js";
import type { Config } from "./config.js";
import { modelRef, type RunRequest } from "./request.js";

export type RunContext = {
  location: { directory: string; workspaceID?: string | undefined };
  session: Pick<
    Plugin.Context["session"],
    | "create"
    | "get"
    | "switchAgent"
    | "switchModel"
    | "rename"
    | "prompt"
    | "command"
    | "wait"
    | "interrupt"
  >;
  catalog: { model: Pick<Plugin.Context["catalog"]["model"], "default"> };
};

type Run = {
  requestId: string;
  request: RunRequest;
  controller: AbortController;
  sessionID?: string;
  cancelled?: string;
  interruption?: Promise<unknown>;
  admissions: Map<string, ReturnType<typeof Promise.withResolvers<void>>>;
  done: Promise<void>;
};

export type RunResult = {
  requestId: string;
  sessionID: string | undefined;
  error?: string;
};

export type PluginEvent =
  ReturnType<Plugin.Context["event"]["subscribe"]> extends AsyncIterable<
    infer Event
  >
    ? Event
    : never;

export class RunManager {
  readonly #runs = new Set<Run>();
  #stopped = false;

  constructor(
    readonly context: RunContext,
    readonly config: Config,
    readonly report: (result: RunResult) => void,
  ) {}

  async start(requestId: string, request: RunRequest) {
    if (this.#stopped) throw new Error("Plugin is shutting down");
    const admitted = Promise.withResolvers<void>();
    const run: Run = {
      requestId,
      request,
      controller: new AbortController(),
      admissions: new Map(),
      done: Promise.resolve(),
    };
    this.#runs.add(run);
    const timer = setTimeout(
      () => this.cancel(run, "Run timed out"),
      request.timeoutMs ?? this.config.runTimeoutMs,
    );
    run.done = this.execute(run, admitted.resolve)
      .then(
        () => this.report({ requestId, sessionID: run.sessionID }),
        (error: unknown) => {
          admitted.reject(error);
          this.report({
            requestId,
            sessionID: run.sessionID,
            error:
              run.cancelled ??
              (error instanceof Error
                ? error.message || error.name
                : String(error)),
          });
        },
      )
      .finally(() => {
        clearTimeout(timer);
        this.#runs.delete(run);
      });
    await admitted.promise;
    return { done: run.done };
  }

  async dispose() {
    this.#stopped = true;
    const runs = [...this.#runs];
    for (const run of runs) this.cancel(run, "Plugin unloaded");
    await Promise.all(runs.map((run) => run.done));
  }

  // Child sessions inherit the headless policy of their managed root run.
  async owner(sessionID: string): Promise<Run | undefined> {
    const seen = new Set<string>();
    let current: string | undefined = sessionID;
    while (current !== undefined && !seen.has(current)) {
      const owned = [...this.#runs].find((run) => run.sessionID === current);
      if (owned !== undefined) return owned;
      if (this.#runs.size === 0) return;
      seen.add(current);
      const session = await this.context.session.get({ sessionID: current });
      current = session.parentID;
    }
  }

  cancel(run: Run, reason: string) {
    if (run.cancelled !== undefined) return;
    run.cancelled = reason;
    run.controller.abort(new Error(reason));
    for (const admission of run.admissions.values())
      admission.reject(new Error(reason));
    // V2's in-process Promise adapter currently ignores request-option signals.
    // Interrupt now rather than waiting for the client wait to reject.
    if (run.sessionID !== undefined) {
      run.interruption = this.context.session.interrupt({
        sessionID: run.sessionID,
        continue: false,
      });
      void run.interruption.catch(() => {});
    }
  }

  admitting(sessionID: string, id: string) {
    const run = [...this.#runs].find((run) => run.sessionID === sessionID);
    if (run === undefined || run.admissions.has(id)) return;
    const admission = Promise.withResolvers<void>();
    void admission.promise.catch(() => {});
    run.admissions.set(id, admission);
  }

  observe(event: PluginEvent) {
    if (event.type === "session.inbox.delivered") {
      for (const run of this.#runs) {
        if (run.sessionID === event.data.sessionID)
          run.admissions.get(event.data.inboxID)?.resolve();
      }
    }
    if (
      event.type !== "session.execution.failed" &&
      event.type !== "session.execution.interrupted"
    )
      return;
    for (const run of this.#runs) {
      if (run.sessionID !== event.data.sessionID) continue;
      const message =
        event.type === "session.execution.failed"
          ? event.data.error.message
          : `Session interrupted: ${event.data.reason}`;
      for (const admission of run.admissions.values())
        admission.reject(new Error(message));
    }
  }

  private async execute(run: Run, admitted: () => void) {
    const { signal } = run.controller;
    try {
      const session = await this.target(run);
      signal.throwIfAborted();
      await this.configure(run, session.id, session.model);
      signal.throwIfAborted();
      const prompt = {
        sessionID: session.id,
        text: run.request.prompt ?? "",
        files: attachments(run.request, this.context.location.directory),
        delivery: "steer" as const,
      };
      if (run.request.command !== undefined) {
        await this.context.session.command(
          { ...prompt, command: run.request.command },
          { signal },
        );
      } else {
        const id = `msg_${randomUUID()}`;
        this.admitting(session.id, id);
        await this.context.session.prompt({ ...prompt, id }, { signal });
      }
      // A late admission may schedule work after the first interrupt was a no-op.
      if (signal.aborted) delete run.interruption;
      signal.throwIfAborted();
      admitted();
      // Admission precedes the advisory wake; delivery is the execution barrier.
      await Promise.all(
        [...run.admissions.values()].map((admission) => admission.promise),
      );
      signal.throwIfAborted();
      await this.context.session.wait({ sessionID: session.id }, { signal });
      signal.throwIfAborted();
      const result = await this.context.session.get(
        { sessionID: session.id },
        { signal },
      );
      if (result.outcome === "failed" || result.outcome === "interrupted") {
        throw new Error(`Session ${result.outcome}`);
      }
      if (run.admissions.size > 0 && result.outcome !== "succeeded")
        throw new Error("Session ended without a successful outcome");
    } finally {
      // Aborting a client wait does not stop durable server execution.
      if (run.cancelled !== undefined && run.sessionID !== undefined) {
        await (run.interruption ??
          this.context.session.interrupt({
            sessionID: run.sessionID,
            continue: false,
          }));
      }
    }
  }

  private async target(run: Run) {
    const session =
      run.request.session === undefined
        ? // Creation is allowed to finish so cleanup can interrupt the returned ID.
          await this.context.session.create({
            location: {
              directory: this.context.location.directory,
              ...(this.context.location.workspaceID === undefined
                ? {}
                : { workspaceID: this.context.location.workspaceID }),
            },
          })
        : await this.context.session.get(
            { sessionID: run.request.session },
            { signal: run.controller.signal },
          );
    if (
      session.location.directory !== this.context.location.directory ||
      session.location.workspaceID !== this.context.location.workspaceID
    ) {
      throw new Error("Session belongs to a different RPC location");
    }
    if (
      [...this.#runs].some(
        (active) => active !== run && active.sessionID === session.id,
      )
    ) {
      throw new Error("Session already has a managed run");
    }
    run.sessionID = session.id;
    return session;
  }

  private async configure(
    run: Run,
    sessionID: string,
    current: Awaited<ReturnType<RunContext["session"]["get"]>>["model"],
  ) {
    const { signal } = run.controller;
    const { request } = run;
    const selected =
      request.model !== undefined
        ? modelRef(request.model, request.variant)
        : request.variant !== undefined
          ? (current ??
            (await this.context.catalog.model.default()).data ??
            undefined)
          : undefined;
    if (request.variant !== undefined && selected === undefined) {
      throw new Error("Cannot select a variant before selecting a model");
    }
    if (selected !== undefined) {
      await this.context.session.switchModel(
        {
          sessionID,
          model: {
            ...selected,
            ...(request.variant === undefined
              ? {}
              : { variant: request.variant }),
          },
        },
        { signal },
      );
    }
    if (request.agent !== undefined)
      await this.context.session.switchAgent(
        { sessionID, agent: request.agent },
        { signal },
      );
    if (request.title !== undefined)
      await this.context.session.rename(
        { sessionID, title: request.title },
        { signal },
      );
  }
}

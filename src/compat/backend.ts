import { resolve } from "node:path";
import type { OpenCodeClient } from "@opencode/client";
import type { Config } from "../config.js";
import type { Logger } from "../log.js";
import { runRequestSchema } from "../request.js";
import { type PluginEvent, RunManager } from "../runner.js";
import type { LegacyRequest } from "./request.js";
import { selectSession } from "./selection.js";

export class LegacyBackend {
  readonly #managers = new Set<RunManager>();
  readonly #controller = new AbortController();
  #events: Promise<void> | undefined;
  constructor(
    readonly client: OpenCodeClient,
    readonly config: Config,
    readonly logger: Logger,
    readonly unavailable: () => void,
  ) {}

  async connect() {
    const iterator = this.client.event
      .subscribe({ signal: this.#controller.signal })
      [Symbol.asyncIterator]();
    const connected = await iterator.next();
    if (connected.done)
      throw new Error("OpenCode event stream closed during startup");
    this.#events = (async () => {
      try {
        while (!this.#controller.signal.aborted) {
          const next = await iterator.next();
          if (next.done) {
            if (!this.#controller.signal.aborted)
              throw new Error("OpenCode event stream closed");
            break;
          }
          await this.observe(next.value);
        }
      } catch (error) {
        if (!this.#controller.signal.aborted) {
          await this.logger.error("OpenCode event stream failed", {
            error: String(error),
          });
          this.unavailable();
        }
      } finally {
        await iterator.return?.();
      }
    })();
  }

  async start(requestId: string, legacy: LegacyRequest) {
    const began = Date.now();
    const timeoutMs = legacy.timeoutMs ?? this.config.runTimeoutMs;
    const signal = AbortSignal.any([
      this.#controller.signal,
      AbortSignal.timeout(timeoutMs),
    ]);
    const selected = await selectSession(
      this.client,
      legacy,
      resolve(legacy.dir),
      signal,
    );
    signal.throwIfAborted();
    const {
      dir: _dir,
      continue: _continue,
      fork: _fork,
      thinking: _thinking,
      ...input
    } = legacy;
    const request = runRequestSchema.parse({
      ...input,
      session: selected.id,
      timeoutMs: Math.max(1, timeoutMs - (Date.now() - began)),
      // V1 accepts standard base64 with nonzero pad bits; native data URIs require canonical encoding.
      inlineFiles: input.inlineFiles?.map((file) => ({
        ...file,
        content: Buffer.from(file.content, "base64").toString("base64"),
      })),
    });
    let failed: string | undefined;
    const manager = new RunManager(
      {
        location: selected.location,
        session: {
          ...this.client.session,
          command: async (input, options) => {
            const before = new Set(
              (
                await this.client.session.context(
                  { sessionID: input.sessionID },
                  options,
                )
              ).map((message) => message.id),
            );
            await this.client.session.command(input, options);
            await this.reconcileCommand(
              manager,
              input.sessionID,
              before,
              options?.signal,
            );
          },
        },
        catalog: {
          model: {
            default: () =>
              this.client.model.default({
                location: {
                  directory: selected.location.directory,
                  workspace: selected.location.workspaceID,
                },
              }),
          },
        },
      },
      this.config,
      (result) => {
        failed = result.error;
        void this.logger[result.error === undefined ? "info" : "error"](
          "run finished",
          {
            requestId,
            sessionId: selected.id,
            error: result.error ?? "",
            durationMs: Date.now() - began,
          },
        ).catch(console.error);
      },
    );
    this.#managers.add(manager);
    try {
      const run = await manager.start(requestId, request);
      return {
        done: run.done
          .then(() => {
            if (failed !== undefined) throw new Error(failed);
          })
          .finally(() => this.#managers.delete(manager)),
      };
    } catch (error) {
      this.#managers.delete(manager);
      throw error;
    }
  }

  async dispose() {
    this.#controller.abort();
    await Promise.all([...this.#managers].map((manager) => manager.dispose()));
    await this.#events;
  }

  private async reconcileCommand(
    manager: RunManager,
    sessionID: string,
    before: Set<string>,
    signal: AbortSignal | undefined,
  ) {
    const options = signal === undefined ? {} : { signal };
    const pending = await this.client.session.inbox.list(
      { sessionID },
      options,
    );
    for (const item of pending)
      if (item.type === "user") manager.admitting(sessionID, item.id);
    const messages = await this.client.session.context({ sessionID }, options);
    for (const message of messages) {
      if (message.type !== "user" || before.has(message.id)) continue;
      manager.admitting(sessionID, message.id);
      manager.observe({
        id: "evt_reconciled",
        type: "session.inbox.delivered",
        created: Date.now(),
        durable: { aggregateID: sessionID, seq: 0, version: 1 },
        data: { sessionID, inboxID: message.id },
      });
    }
  }

  private async observe(event: PluginEvent) {
    for (const manager of this.#managers) {
      if (
        event.type === "session.inbox.enqueued" &&
        event.data.item.type === "user"
      )
        manager.admitting(event.data.sessionID, event.data.inboxID);
      manager.observe(event);
    }
    if (event.type === "permission.asked") await this.permission(event);
    if (event.type === "form.created") await this.form(event);
  }

  private async permission(
    event: Extract<PluginEvent, { type: "permission.asked" }>,
  ) {
    for (const manager of this.#managers) {
      const run = await manager.owner(event.data.sessionID);
      if (run === undefined) continue;
      const allow =
        run.request.dangerouslySkipPermissions ??
        this.config.dangerouslySkipPermissions;
      await this.client.permission.reply({
        sessionID: event.data.sessionID,
        requestID: event.data.id,
        reply: allow ? "once" : "reject",
      });
      if (!allow)
        manager.cancel(
          run,
          "Permission requires interactive input in a headless run",
        );
      return;
    }
  }

  private async form(event: Extract<PluginEvent, { type: "form.created" }>) {
    if (event.data.form.sessionID !== "global") {
      for (const manager of this.#managers) {
        const run = await manager.owner(event.data.form.sessionID);
        if (run === undefined) continue;
        await this.client.form.cancel({
          sessionID: event.data.form.sessionID,
          formID: event.data.form.id,
        });
        manager.cancel(run, "Interactive form requested in a headless run");
        return;
      }
    }
  }
}

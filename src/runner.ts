import { spawn as nodeSpawn } from "node:child_process";
import type { Readable } from "node:stream";
import { z } from "zod";
import type { Logger } from "./log.js";

export type AttachCredentials = {
  password?: string;
  username?: string;
};

type RunSpawnOptions = {
  detached: true;
  env: Record<string, string>;
  shell: false;
  stdio: ["ignore", "pipe", "pipe"];
};

export interface SpawnedRunProcess {
  pid?: number | undefined;
  stderr: Readable;
  stdout: Readable;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "error", listener: (error: Error) => void): this;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  once(event: "spawn", listener: () => void): this;
}

export type RunSpawner = (
  file: string,
  args: string[],
  options: RunSpawnOptions,
) => SpawnedRunProcess;

export type RunManagerOptions = {
  killProcessGroup?: (pid: number, signal: NodeJS.Signals) => boolean;
  logger: Pick<Logger, "error" | "info" | "warn">;
  shutdownGraceMs: number;
  spawn?: RunSpawner;
};

export type StartRunInput = {
  argv: string[];
  attach: AttachCredentials;
  requestId: string;
  timeoutMs: number;
};

export type StartedManagedRun = {
  done: Promise<void>;
};

type ActiveRun = {
  killTimer?: ReturnType<typeof setTimeout>;
  pid: number;
  termTimer?: ReturnType<typeof setTimeout>;
};

const eventSchema = z
  .object({
    error: z.string().optional(),
    sessionID: z.string().optional(),
    sessionId: z.string().optional(),
    type: z.string().optional(),
  })
  .passthrough();

export const createRunEnvironment = (
  attach: AttachCredentials,
): Record<string, string> => ({
  OPENCODE_RUN_SERVER_CHILD: "1",
  ...(attach.password === undefined
    ? {}
    : { OPENCODE_SERVER_PASSWORD: attach.password }),
  ...(attach.username === undefined
    ? {}
    : { OPENCODE_SERVER_USERNAME: attach.username }),
});

export const killProcessGroup = (pid: number, signal: NodeJS.Signals) => {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (errorCode(error) === "ESRCH") return false;
    throw error;
  }
};

export class RunManager {
  readonly #active = new Map<string, ActiveRun>();
  readonly #killProcessGroup: (pid: number, signal: NodeJS.Signals) => boolean;
  readonly #logger: Pick<Logger, "error" | "info" | "warn">;
  readonly #shutdownGraceMs: number;
  readonly #spawn: RunSpawner;

  constructor(options: RunManagerOptions) {
    this.#killProcessGroup = options.killProcessGroup ?? killProcessGroup;
    this.#logger = options.logger;
    this.#shutdownGraceMs = options.shutdownGraceMs;
    this.#spawn = options.spawn ?? defaultSpawn;
  }

  async start(input: StartRunInput): Promise<StartedManagedRun> {
    const command = input.argv[0];
    if (command === undefined)
      throw new Error("argv must include opencode path");
    const child = this.#spawn(command, input.argv.slice(1), {
      detached: true,
      env: createRunEnvironment(input.attach),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForSpawn(child);
    if (child.pid === undefined)
      throw new Error("spawned process did not expose a pid");
    const output = new OutputTail();
    child.stdout.on("data", (chunk: Buffer | string) =>
      output.add(String(chunk)),
    );
    child.stderr.on("data", (chunk: Buffer | string) =>
      output.add(String(chunk)),
    );
    const done = this.#track(input.requestId, child, input.timeoutMs, output);
    return { done };
  }

  async killAll() {
    const active = [...this.#active.values()];
    if (active.length === 0) return;
    for (const run of active) this.#killProcessGroup(run.pid, "SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, this.#shutdownGraceMs));
    for (const run of active) this.#killProcessGroup(run.pid, "SIGKILL");
  }

  activeCount() {
    return this.#active.size;
  }

  #track(
    requestId: string,
    child: SpawnedRunProcess,
    timeoutMs: number,
    output: OutputTail,
  ) {
    const pid = child.pid ?? 0;
    const active: ActiveRun = { pid };
    this.#active.set(requestId, active);
    active.termTimer = setTimeout(() => {
      this.#killProcessGroup(pid, "SIGTERM");
      active.killTimer = setTimeout(
        () => this.#killProcessGroup(pid, "SIGKILL"),
        this.#shutdownGraceMs,
      );
    }, timeoutMs);
    return new Promise<void>((resolve) => {
      child.once("exit", (code, signal) => {
        this.#clearTimers(active);
        this.#active.delete(requestId);
        const fields = parseOutputFields(output.value());
        void this.#logger.info("run exited", {
          code: code ?? -1,
          requestId,
          signal: signal ?? "",
          ...fields,
        });
        resolve();
      });
    });
  }

  #clearTimers(active: ActiveRun) {
    if (active.termTimer !== undefined) clearTimeout(active.termTimer);
    if (active.killTimer !== undefined) clearTimeout(active.killTimer);
  }
}

class OutputTail {
  #value = "";

  add(chunk: string) {
    this.#value = `${this.#value}${chunk}`.slice(-4096);
  }

  value() {
    return this.#value;
  }
}

const parseOutputFields = (tail: string) => {
  let sessionId = "";
  let error = "";
  for (const line of tail.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const parsedJson = parseJson(line);
    if (parsedJson === undefined) continue;
    const event = eventSchema.safeParse(parsedJson);
    if (!event.success) continue;
    sessionId = event.data.sessionID ?? event.data.sessionId ?? sessionId;
    error = event.data.error ?? error;
  }
  return { error, sessionId, tail };
};

const parseJson = (line: string) => {
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed;
  } catch {
    return undefined;
  }
};

const waitForSpawn = (child: SpawnedRunProcess) =>
  new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });

/* v8 ignore next -- real spawn path is exercised by e2e subprocess tests */
const defaultSpawn: RunSpawner = (file, args, options) =>
  nodeSpawn(file, args, options);

const errorCode = (error: unknown) => {
  if (typeof error === "object" && error !== null && "code" in error)
    return String(error.code);
  /* v8 ignore next -- process.kill errors expose code in supported runtimes */
  return undefined;
};

import { type ChildProcess, spawn } from "node:child_process";
import type { Endpoint } from "@opencode/client/service";
import type { Config } from "../config.js";
import { attachEndpoint, discoverHost } from "./discovery.js";
import { checkHealth } from "./health.js";
import { discoverBind } from "./network.js";
import { childEntry, resolveRuntime } from "./runtime.js";

type Dependencies = {
  discover: () => Promise<Endpoint | undefined>;
  runtime: () => Promise<string>;
  spawn: (
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
  ) => ChildProcess;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  health: typeof checkHealth;
};

const killGroup = (pid: number, signal: NodeJS.Signals) => {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
      throw error;
  }
};

export class Supervisor {
  #disposed = false;
  #child: ChildProcess | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #pending: Promise<void> = Promise.resolve();
  #restarts: number[] = [];
  #endpoint: Endpoint | undefined;
  readonly #deps: Dependencies;
  constructor(
    readonly config: Config,
    readonly bind: string,
    readonly report: (message: string) => void,
    deps: Partial<Dependencies> = {},
  ) {
    this.#deps = {
      discover: discoverHost,
      runtime: () => resolveRuntime(config.runtime),
      spawn: (command, args, env) =>
        spawn(command, args, {
          detached: true,
          env,
          stdio: ["ignore", "ignore", "pipe"],
        }),
      kill: killGroup,
      health: checkHealth,
      ...deps,
    };
  }
  start() {
    this.#pending = this.launch().catch((error: unknown) => {
      this.report(`compatibility listener startup failed: ${String(error)}`);
      this.retry();
    });
  }
  async dispose() {
    this.#disposed = true;
    clearTimeout(this.#timer);
    await this.#pending;
    const child = this.#child;
    if (
      child?.pid === undefined ||
      child.exitCode !== null ||
      child.signalCode !== null
    )
      return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (child.pid !== undefined) this.#deps.kill(child.pid, "SIGKILL");
        resolve();
      }, this.config.shutdownGraceMs);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      this.#deps.kill(child.pid ?? 0, "SIGTERM");
    });
  }
  private schedule(ms: number) {
    if (this.#disposed) return;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.start(), ms);
  }
  private retry() {
    this.#restarts = this.#restarts.filter(
      (time) => time >= Date.now() - this.config.restart.windowMs,
    );
    if (this.#restarts.length >= this.config.restart.maxRetries) return;
    const delay = Math.min(
      this.config.restart.baseDelayMs * 2 ** this.#restarts.length,
      this.config.restart.maxDelayMs,
    );
    this.#restarts.push(Date.now());
    this.schedule(delay);
  }
  private async launch() {
    if (this.#disposed) return;
    const found = await this.#deps.discover();
    if (found === undefined) {
      this.schedule(this.config.healthCheck.intervalMs);
      return;
    }
    const command = await this.#deps.runtime();
    if (this.#disposed) return;
    const endpoint = attachEndpoint(found, this.config.attach);
    this.#endpoint = endpoint;
    const child = this.#deps.spawn(command, [childEntry(import.meta.url)], {
      ...process.env,
      OPENCODE_RUN_SERVER_CHILD: "1",
      OPENCODE_RUN_SERVER_CONFIG: JSON.stringify({
        ...this.config,
        bind: this.bind,
      }),
      OPENCODE_RUN_SERVER_ENDPOINT: JSON.stringify(endpoint),
      OPENCODE_RUN_SERVER_PARENT_PID: String(process.pid),
    });
    this.#child = child;
    child.stderr?.on("data", (data: Buffer) =>
      this.report(data.toString("utf8").slice(-4096)),
    );
    let handled = false;
    const exited = (code: number | null) => {
      if (handled) return;
      handled = true;
      this.#pending = this.exited(code).catch((error: unknown) =>
        this.report(String(error)),
      );
    };
    child.once("exit", exited);
    child.once("error", (error) => {
      this.report(error.message);
      exited(null);
    });
    this.report("compatibility listener started");
  }
  private async exited(code: number | null) {
    this.report(`compatibility listener exited (${code})`);
    if (this.#disposed || code === 3 || this.#endpoint === undefined) return;
    if (
      await this.#deps.health(
        this.#endpoint.url,
        this.config.healthCheck.timeoutMs,
      )
    )
      this.retry();
  }
}

const shared = new Map<string, { refs: number; supervisor: Supervisor }>();

export const acquireCompatibility = async (
  config: Config,
  report: (message: string) => void,
) => {
  const bind = config.bind ?? (await discoverBind());
  const key = `${bind}:${config.port}`;
  let entry = shared.get(key);
  if (entry === undefined) {
    entry = { refs: 0, supervisor: new Supervisor(config, bind, report) };
    shared.set(key, entry);
    entry.supervisor.start();
  }
  entry.refs += 1;
  const owned = entry;
  let disposed = false;
  return async () => {
    if (disposed) return;
    disposed = true;
    owned.refs -= 1;
    if (owned.refs > 0) return;
    shared.delete(key);
    await owned.supervisor.dispose();
  };
};

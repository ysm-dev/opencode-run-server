import { type ChildProcess, spawn } from "node:child_process";
import type { Endpoint } from "@opencode/client/service";
import type { Config } from "../config.js";
import { attachEndpoint, discoverHost } from "./discovery.js";
import { checkHealth, checkListener } from "./health.js";
import {
  clearOwnership,
  fingerprint,
  type Ownership,
  ownershipFile,
  readOwnership,
  running,
} from "./ownership.js";
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
  listening: typeof checkListener;
  owner: (file: string) => Promise<Ownership | undefined>;
  forget: (file: string, pid: number) => Promise<void>;
  running: (pid: number) => boolean;
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
  #adopted: number | undefined;
  #reclaimed = new Set<number>();
  #exiting: (() => void) | undefined;
  readonly print: string;
  readonly file: string;
  readonly #deps: Dependencies;
  constructor(
    readonly config: Config,
    readonly bind: string,
    readonly report: (message: string) => void,
    deps: Partial<Dependencies> = {},
  ) {
    this.print = fingerprint({ ...config, bind });
    this.file = ownershipFile(bind, config.port);
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
      listening: checkListener,
      owner: readOwnership,
      forget: clearOwnership,
      running,
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
    this.release();
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
    // Re-checks continue for the life of the host without holding it open.
    this.#timer = setTimeout(() => this.start(), ms);
    this.#timer.unref?.();
  }
  private retry() {
    this.#restarts = this.#restarts.filter(
      (time) => time >= Date.now() - this.config.restart.windowMs,
    );
    if (this.#restarts.length >= this.config.restart.maxRetries) {
      this.report("compatibility listener restart budget spent; pausing");
      this.#restarts = [];
      this.schedule(this.config.restart.windowMs);
      return;
    }
    const delay = Math.min(
      this.config.restart.baseDelayMs * 2 ** this.#restarts.length,
      this.config.restart.maxDelayMs,
    );
    this.#restarts.push(Date.now());
    this.schedule(delay);
  }
  // The listener belongs to the host process, so an existing one is adopted
  // rather than replaced whenever it already serves this configuration.
  private async claim() {
    const owner = await this.#deps.owner(this.file);
    if (owner === undefined) return true;
    // A pid alone can be reused; only an answering address proves ownership.
    if (!(this.#deps.running(owner.pid) && (await this.serving()))) {
      await this.#deps.forget(this.file, owner.pid);
      return true;
    }
    if (owner.parentPid === process.pid && owner.fingerprint === this.print) {
      if (this.#adopted !== owner.pid) {
        this.#adopted = owner.pid;
        this.report("compatibility listener already running; adopted");
      }
      this.schedule(this.config.healthCheck.intervalMs);
      return false;
    }
    if (
      owner.parentPid !== process.pid &&
      this.#deps.running(owner.parentPid)
    ) {
      this.report("compatibility listener port owned elsewhere; skipping");
      this.schedule(this.config.healthCheck.intervalMs);
      return false;
    }
    this.reclaim(owner.pid);
    return false;
  }
  private serving() {
    return this.#deps.listening(
      this.bind,
      this.config.port,
      this.config.healthCheck.timeoutMs,
    );
  }
  private reclaim(pid: number) {
    const escalate = this.#reclaimed.has(pid);
    this.#reclaimed.add(pid);
    this.report(
      `reclaiming stale compatibility listener (${escalate ? "SIGKILL" : "SIGTERM"})`,
    );
    this.#deps.kill(pid, escalate ? "SIGKILL" : "SIGTERM");
    this.schedule(this.config.shutdownGraceMs);
  }
  private async launch() {
    if (this.#disposed) return;
    if (!(await this.claim())) return;
    const found = await this.#deps.discover();
    if (found === undefined) {
      this.schedule(this.config.healthCheck.intervalMs);
      return;
    }
    const command = await this.#deps.runtime();
    if (this.#disposed) return;
    const endpoint = attachEndpoint(found, this.config.attach);
    this.#endpoint = endpoint;
    this.#adopted = undefined;
    const child = this.#deps.spawn(command, [childEntry(import.meta.url)], {
      ...process.env,
      OPENCODE_RUN_SERVER_CHILD: "1",
      OPENCODE_RUN_SERVER_CONFIG: JSON.stringify({
        ...this.config,
        bind: this.bind,
      }),
      OPENCODE_RUN_SERVER_ENDPOINT: JSON.stringify(endpoint),
      OPENCODE_RUN_SERVER_PARENT_PID: String(process.pid),
      OPENCODE_RUN_SERVER_FINGERPRINT: this.print,
    });
    this.#child = child;
    this.hold();
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
    this.#child = undefined;
    if (this.#disposed) return;
    // Port contention and an unreachable backend are both transient: keep
    // re-checking instead of leaving the endpoint permanently unserved.
    if (code === 3 || this.#endpoint === undefined) {
      this.schedule(this.config.healthCheck.intervalMs);
      return;
    }
    const status = await this.#deps.health(
      this.#endpoint.url,
      this.config.healthCheck.timeoutMs,
    );
    if (status === "down") {
      this.schedule(this.config.healthCheck.intervalMs);
      return;
    }
    this.retry();
  }
  // A clean host shutdown terminates the listener it spawned.
  private hold() {
    if (this.#exiting !== undefined) return;
    const exiting = () => {
      const child = this.#child;
      if (
        child?.pid === undefined ||
        child.exitCode !== null ||
        child.signalCode !== null
      )
        return;
      this.#deps.kill(child.pid, "SIGTERM");
    };
    this.#exiting = exiting;
    process.once("exit", exiting);
  }
  private release() {
    if (this.#exiting === undefined) return;
    process.off("exit", this.#exiting);
    this.#exiting = undefined;
  }
}

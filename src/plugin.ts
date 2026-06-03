import { spawn as nodeSpawn } from "node:child_process";
import { basename } from "node:path";
import { createServerConfig, serializeServerEnv } from "./config.js";
import { checkMainServerHealth } from "./health.js";
import { killProcessGroup } from "./runner.js";
import {
  type ResolvedRuntime,
  resolveRuntime,
  resolveServerEntries,
} from "./runtime.js";
import type { BindDiscovery } from "./tailscale.js";

const CHILD_SENTINEL = "OPENCODE_RUN_SERVER_CHILD";
const EADDRINUSE_SKIP_CODE = 3;

export type PluginLogLevel = "debug" | "info" | "warn" | "error";

export type PluginInput = {
  client?: {
    app?: {
      log?: (input: {
        body: {
          extra?: Record<string, string | number | boolean>;
          level: PluginLogLevel;
          message: string;
          service: string;
        };
      }) => Promise<void>;
    };
  };
  serverUrl: URL;
};

export type PluginHooks = {
  dispose?: () => Promise<void>;
};

export type SubprocessSpawnOptions = {
  detached: true;
  env: NodeJS.ProcessEnv;
  shell: false;
  stdio: ["ignore", "pipe", "pipe"];
};

export interface SubprocessHandle {
  pid?: number | undefined;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
}

export type CreatePluginDeps = {
  checkHealth?: (mainServerUrl: string, timeoutMs: number) => Promise<boolean>;
  discoverBind?: () => Promise<BindDiscovery>;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  killGroup?: (pid: number, signal: NodeJS.Signals) => boolean;
  moduleUrl?: string;
  now?: () => number;
  resolveRuntime?: (
    preference: "auto" | "bun" | "node",
  ) => Promise<ResolvedRuntime>;
  setTimeout?: (
    callback: () => void,
    ms: number,
  ) => ReturnType<typeof setTimeout>;
  spawnSubprocess?: (
    command: string,
    args: string[],
    options: SubprocessSpawnOptions,
  ) => SubprocessHandle;
};

export type PluginFunction = (
  input: PluginInput,
  options?: unknown,
) => Promise<PluginHooks>;

export const createPlugin = (deps: CreatePluginDeps = {}): PluginFunction => {
  return async (input, options) => {
    const env = deps.env ?? process.env;
    if (env[CHILD_SENTINEL] !== undefined) return {};
    const config = await createServerConfig(options, {
      ...(deps.discoverBind === undefined
        ? {}
        : { discoverBind: deps.discoverBind }),
      env,
      execPath: deps.execPath ?? process.execPath,
    });
    if (!looksLikeOpencode(config.opencodePath)) {
      await log(input, "warn", "opencodePath does not look like opencode", {
        opencodePath: config.opencodePath,
      });
    }
    /* v8 ignore next -- default runtime resolution is covered in runtime.ts */
    const runtime = await (
      deps.resolveRuntime ??
      ((preference) =>
        resolveRuntime(preference, {
          serverEntries: resolveServerEntries(
            deps.moduleUrl ?? import.meta.url,
          ),
        }))
    )(config.runtime);
    const supervisor = new Supervisor({ config, deps, input, runtime });
    supervisor.start();
    const removeSignals = installSignals(() => void supervisor.dispose());
    return {
      dispose: async () => {
        removeSignals();
        await supervisor.dispose();
      },
    };
  };
};

type SupervisorOptions = {
  config: Awaited<ReturnType<typeof createServerConfig>>;
  deps: CreatePluginDeps;
  input: PluginInput;
  runtime: ResolvedRuntime;
};

class Supervisor {
  #child?: SubprocessHandle;
  #disposed = false;
  #restartTimes: number[] = [];
  readonly #options: SupervisorOptions;

  constructor(options: SupervisorOptions) {
    this.#options = options;
  }

  start() {
    const env = serializeServerEnv(
      this.#options.config,
      this.#options.input.serverUrl.toString(),
      /* v8 ignore next -- process env fallback is runtime glue */
      this.#options.deps.env ?? process.env,
    );
    const child = spawnSubprocess(
      this.#options.runtime,
      env,
      this.#options.deps,
    );
    this.#child = child;
    child.once("exit", (code) => void this.#handleExit(code));
    void log(this.#options.input, "info", "run-server subprocess started");
  }

  async dispose() {
    this.#disposed = true;
    const pid = this.#child?.pid;
    if (pid !== undefined)
      (this.#options.deps.killGroup ?? killProcessGroup)(pid, "SIGTERM");
    await log(this.#options.input, "info", "run-server subprocess shutdown");
  }

  async #handleExit(code: number | null) {
    if (this.#disposed) return;
    if (code === EADDRINUSE_SKIP_CODE) {
      await log(
        this.#options.input,
        "info",
        "run-server port already owned; skipping restart",
      );
      return;
    }
    /* v8 ignore next -- default health function is covered in health.ts */
    const healthy = await (
      this.#options.deps.checkHealth ?? checkMainServerHealth
    )(
      this.#options.input.serverUrl.toString(),
      this.#options.config.healthCheck.timeoutMs,
    );
    if (!healthy || !this.#hasRestartBudget()) return;
    const delay = this.#nextDelay();
    await log(
      this.#options.input,
      "warn",
      "run-server crashed; scheduling restart",
      { delay },
    );
    (this.#options.deps.setTimeout ?? setTimeout)(() => this.start(), delay);
  }

  #hasRestartBudget() {
    const now = (this.#options.deps.now ?? Date.now)();
    const windowStart = now - this.#options.config.restart.windowMs;
    this.#restartTimes = this.#restartTimes.filter(
      (time) => time >= windowStart,
    );
    return this.#restartTimes.length < this.#options.config.restart.maxRetries;
  }

  #nextDelay() {
    const retries = this.#restartTimes.length;
    this.#restartTimes.push((this.#options.deps.now ?? Date.now)());
    return Math.min(
      this.#options.config.restart.baseDelayMs * 2 ** retries,
      this.#options.config.restart.maxDelayMs,
    );
  }
}

/* v8 ignore start -- default subprocess spawn seam is covered by e2e */
const spawnSubprocess = (
  runtime: ResolvedRuntime,
  env: NodeJS.ProcessEnv,
  deps: CreatePluginDeps,
) =>
  (deps.spawnSubprocess ?? defaultSpawn)(runtime.command, runtime.args, {
    detached: true,
    env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

/* v8 ignore next -- real subprocess spawn is exercised by e2e */
const defaultSpawn = (
  command: string,
  args: string[],
  options: SubprocessSpawnOptions,
) => nodeSpawn(command, args, options);
/* v8 ignore stop */

const looksLikeOpencode = (path: string) =>
  basename(path).toLowerCase().includes("opencode");

const log = async (
  input: PluginInput,
  level: PluginLogLevel,
  message: string,
  extra?: Record<string, string | number | boolean>,
) => {
  const body =
    extra === undefined
      ? { level, message, service: "opencode-run-server" }
      : { extra, level, message, service: "opencode-run-server" };
  await input.client?.app?.log?.({ body });
};

const installSignals = (dispose: () => void) => {
  process.once("exit", dispose);
  process.once("SIGINT", dispose);
  process.once("SIGTERM", dispose);
  return () => {
    process.off("exit", dispose);
    process.off("SIGINT", dispose);
    process.off("SIGTERM", dispose);
  };
};

export default createPlugin();

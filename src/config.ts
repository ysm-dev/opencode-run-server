import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { type BindDiscovery, discoverTailscaleIp } from "./tailscale.js";

const CONFIG_ENV = "OPENCODE_RUN_SERVER_CONFIG";
const MAIN_URL_ENV = "OPENCODE_RUN_SERVER_MAIN_URL";

const runtimeSchema = z.enum(["auto", "bun", "node"]);
const logLevelSchema = z.enum(["debug", "info", "warn", "error"]);
const positiveInt = z.number().int().positive();
const nonNegativeInt = z.number().int().min(0);

const optionsSchema = z
  .object({
    attach: z
      .object({
        password: z.string().min(1).optional(),
        username: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    bind: z.string().min(1).optional(),
    concurrency: positiveInt.optional(),
    dangerouslySkipPermissions: z.boolean().optional(),
    healthCheck: z
      .object({
        failureThreshold: positiveInt.optional(),
        intervalMs: positiveInt.optional(),
        timeoutMs: positiveInt.optional(),
      })
      .strict()
      .optional(),
    log: z
      .object({
        file: z.string().min(1).optional(),
        level: logLevelSchema.optional(),
        maxFiles: positiveInt.optional(),
        maxSize: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    maxBodyBytes: positiveInt.optional(),
    opencodePath: z.string().min(1).optional(),
    port: z.number().int().min(1).max(65_535).optional(),
    queueMax: nonNegativeInt.optional(),
    queueTtlMs: nonNegativeInt.optional(),
    restart: z
      .object({
        baseDelayMs: positiveInt.optional(),
        maxDelayMs: positiveInt.optional(),
        maxRetries: nonNegativeInt.optional(),
        windowMs: positiveInt.optional(),
      })
      .strict()
      .optional(),
    runTimeoutMs: positiveInt.optional(),
    runtime: runtimeSchema.optional(),
    shutdownGraceMs: positiveInt.optional(),
    token: z.string().min(1).optional(),
  })
  .strict();

const serverConfigSchema = z
  .object({
    attach: z
      .object({
        password: z.string().min(1).optional(),
        username: z.string().min(1).optional(),
      })
      .strict(),
    bind: z.string().min(1),
    concurrency: positiveInt,
    dangerouslySkipPermissions: z.boolean(),
    healthCheck: z
      .object({
        failureThreshold: positiveInt,
        intervalMs: positiveInt,
        timeoutMs: positiveInt,
      })
      .strict(),
    log: z
      .object({
        file: z.string().min(1),
        level: logLevelSchema,
        maxFiles: positiveInt,
        maxSize: z.string().min(1),
      })
      .strict(),
    maxBodyBytes: positiveInt,
    opencodePath: z.string().min(1),
    port: z.number().int().min(1).max(65_535),
    queueMax: nonNegativeInt,
    queueTtlMs: nonNegativeInt,
    restart: z
      .object({
        baseDelayMs: positiveInt,
        maxDelayMs: positiveInt,
        maxRetries: nonNegativeInt,
        windowMs: positiveInt,
      })
      .strict(),
    runTimeoutMs: positiveInt,
    runtime: runtimeSchema,
    shutdownGraceMs: positiveInt,
    token: z.string().min(1).optional(),
  })
  .strict();

export type ServerConfig = z.infer<typeof serverConfigSchema>;
export type RuntimePreference = z.infer<typeof runtimeSchema>;
type ConfigOptions = z.infer<typeof optionsSchema>;

export type CreateConfigDeps = {
  discoverBind?: () => Promise<BindDiscovery>;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
};

const resolveBind = async (options: ConfigOptions, deps: CreateConfigDeps) =>
  options.bind ?? (await (deps.discoverBind ?? discoverTailscaleIp)()).host;

const createAttachConfig = (attach: ConfigOptions["attach"]) => {
  const config: ServerConfig["attach"] = {};
  if (attach?.password !== undefined) config.password = attach.password;
  if (attach?.username !== undefined) config.username = attach.username;
  return config;
};

const createHealthCheckConfig = (
  healthCheck: ConfigOptions["healthCheck"],
) => ({
  failureThreshold: healthCheck?.failureThreshold ?? 3,
  intervalMs: healthCheck?.intervalMs ?? 5000,
  timeoutMs: healthCheck?.timeoutMs ?? 2000,
});

const createLogConfig = (log: ConfigOptions["log"], stateDir: string) => ({
  file: log?.file ?? join(stateDir, "opencode-run-server", "server.log"),
  level: log?.level ?? "info",
  maxFiles: log?.maxFiles ?? 5,
  maxSize: log?.maxSize ?? "10m",
});

const createRestartConfig = (restart: ConfigOptions["restart"]) => ({
  baseDelayMs: restart?.baseDelayMs ?? 500,
  maxDelayMs: restart?.maxDelayMs ?? 30_000,
  maxRetries: restart?.maxRetries ?? 10,
  windowMs: restart?.windowMs ?? 60_000,
});

const optionalToken = (token: ConfigOptions["token"]) =>
  token === undefined ? {} : { token };

export const createServerConfig = async (
  raw: unknown,
  deps: CreateConfigDeps = {},
) => {
  const options = optionsSchema.parse(raw ?? {});
  const bind = await resolveBind(options, deps);
  const env = deps.env ?? process.env;
  const stateDir = env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  const config = {
    attach: createAttachConfig(options.attach),
    bind,
    concurrency: options.concurrency ?? 10,
    dangerouslySkipPermissions: options.dangerouslySkipPermissions ?? false,
    healthCheck: createHealthCheckConfig(options.healthCheck),
    log: createLogConfig(options.log, stateDir),
    maxBodyBytes: options.maxBodyBytes ?? 10_485_760,
    opencodePath: options.opencodePath ?? deps.execPath ?? process.execPath,
    port: options.port ?? 4097,
    queueMax: options.queueMax ?? 100,
    queueTtlMs: options.queueTtlMs ?? 0,
    restart: createRestartConfig(options.restart),
    runTimeoutMs: options.runTimeoutMs ?? 1_800_000,
    runtime: options.runtime ?? "auto",
    shutdownGraceMs: options.shutdownGraceMs ?? 2000,
    ...optionalToken(options.token),
  };
  return serverConfigSchema.parse(config);
};

export const serializeServerEnv = (
  config: ServerConfig,
  mainServerUrl: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
) => ({
  ...baseEnv,
  [CONFIG_ENV]: JSON.stringify(config),
  [MAIN_URL_ENV]: new URL(mainServerUrl).toString(),
});

export const parseServerEnv = (env: NodeJS.ProcessEnv) => {
  const rawConfig = env[CONFIG_ENV];
  const rawMainUrl = env[MAIN_URL_ENV];
  if (rawConfig === undefined) throw new Error(`${CONFIG_ENV} is required`);
  if (rawMainUrl === undefined) throw new Error(`${MAIN_URL_ENV} is required`);
  const parsedJson: unknown = JSON.parse(rawConfig);
  return {
    config: serverConfigSchema.parse(parsedJson),
    mainServerUrl: new URL(rawMainUrl).toString(),
  };
};

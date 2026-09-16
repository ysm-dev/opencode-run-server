import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const positiveInt = z.number().int().positive().max(2_147_483_647);

const optionsSchema = z
  .object({
    concurrency: positiveInt.default(10),
    queueMax: z.number().int().nonnegative().default(100),
    queueTtlMs: z.number().int().min(0).max(2_147_483_647).default(0),
    runTimeoutMs: positiveInt.default(1_800_000),
    legacyHttp: z.boolean().default(true),
    bind: z.string().min(1).optional(),
    port: z.number().int().min(1).max(65_535).default(4097),
    token: z.string().min(1).optional(),
    maxBodyBytes: positiveInt.default(10_485_760),
    opencodePath: z.string().min(1).default(process.execPath),
    runtime: z.enum(["auto", "bun", "node"]).default("auto"),
    shutdownGraceMs: positiveInt.default(2000),
    attach: z
      .object({
        username: z.string().min(1).optional(),
        password: z.string().min(1).optional(),
      })
      .strict()
      .default({}),
    healthCheck: z
      .object({
        intervalMs: positiveInt.default(5000),
        timeoutMs: positiveInt.default(2000),
        failureThreshold: positiveInt.default(3),
      })
      .strict()
      .prefault({}),
    restart: z
      .object({
        maxRetries: z.number().int().nonnegative().default(10),
        baseDelayMs: positiveInt.default(500),
        maxDelayMs: positiveInt.default(30_000),
        windowMs: positiveInt.default(60_000),
      })
      .strict()
      .prefault({}),
    maxInputBytes: positiveInt.default(10_485_760),
    dangerouslySkipPermissions: z.boolean().default(false),
    log: z
      .object({
        file: z.string().min(1).optional(),
        level: z.enum(["debug", "info", "warn", "error"]).default("info"),
        maxFiles: positiveInt.default(5),
        maxSize: z
          .string()
          .regex(/^[1-9]\d*[kKmM]?$/)
          .default("10m"),
      })
      .strict()
      .prefault({}),
  })
  .strict();

export type Config = z.infer<typeof optionsSchema>;

export const parseOptions = (raw: unknown): Config => {
  const result = optionsSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `Invalid opencode-run-server options. See README.md. ${result.error.message}`,
    );
  }
  return result.data;
};

export const stateDirectory = () =>
  join(
    process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
    "opencode-run-server",
  );

export const defaultLogFile = () => join(stateDirectory(), "server.log");

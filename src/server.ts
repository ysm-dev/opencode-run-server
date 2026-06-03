import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import type { ServerConfig } from "./config.js";
import type { HealthSnapshot } from "./health.js";
import type { Logger } from "./log.js";
import { RunQueue, type StartedRun } from "./queue.js";
import { buildRunArgv, parseRunRequest } from "./request.js";
import type { AttachCredentials } from "./runner.js";

type ErrorCode =
  | "METHOD_NOT_ALLOWED"
  | "PAYLOAD_TOO_LARGE"
  | "QUEUE_FULL"
  | "SPAWN_FAILED"
  | "UNAUTHORIZED"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "VALIDATION";

export type StartRunJob = {
  argv: string[];
  attach: AttachCredentials;
  requestId: string;
  timeoutMs: number;
};

export type CreateAppOptions = {
  config: ServerConfig;
  health?: HealthSnapshot;
  logger?: Pick<Logger, "error" | "info" | "warn">;
  mainServerUrl: string;
  packageVersion: string;
  queue?: RunQueue;
  startRun: (job: StartRunJob) => Promise<StartedRun>;
};

export const createRunServerApp = (options: CreateAppOptions) => {
  const app = new Hono();
  const startedAt = Date.now();
  const queue = options.queue ?? new RunQueue(options.config);
  const health = options.health ?? { healthy: true, lastCheckAt: Date.now() };
  const stats = { failed: 0, total: 0 };

  app.get("/health", () =>
    json({ status: "ok", uptimeMs: Date.now() - startedAt }, 200),
  );
  app.all("/health", () =>
    errorResponse(405, "METHOD_NOT_ALLOWED", "method not allowed", requestId()),
  );

  app.get("/status", (context) => {
    const id = requestId();
    if (!authorized(context.req.raw, options.config.token))
      return unauthorized(id);
    const queueStats = queue.stats();
    return json(
      {
        bind: { host: options.config.bind, port: options.config.port },
        mainServer: {
          healthy: health.healthy,
          lastCheckAt: health.lastCheckAt,
          url: options.mainServerUrl,
        },
        opencodePath: options.config.opencodePath,
        runs: { ...queueStats, failed: stats.failed, total: stats.total },
        uptimeMs: Date.now() - startedAt,
        version: options.packageVersion,
      },
      200,
    );
  });
  app.all("/status", () =>
    errorResponse(405, "METHOD_NOT_ALLOWED", "method not allowed", requestId()),
  );

  app.post("/run", async (context) => {
    const id = requestId();
    if (!authorized(context.req.raw, options.config.token))
      return unauthorized(id);
    const body = await readJsonBody(
      context.req.raw,
      options.config.maxBodyBytes,
    );
    if (!body.ok) return errorResponse(body.status, body.code, body.error, id);
    const parsed = parseRunRequest(body.value);
    if (!parsed.ok) return errorResponse(400, "VALIDATION", parsed.error, id);
    const argv = buildRunArgv(parsed.value, {
      attachUrl: options.mainServerUrl,
      defaultDangerouslySkipPermissions:
        options.config.dangerouslySkipPermissions,
      opencodePath: options.config.opencodePath,
    });
    try {
      const submitted = await queue.submit(id, async () => {
        const run = await options.startRun({
          argv,
          attach: attachCredentials(options.config.attach),
          requestId: id,
          timeoutMs: parsed.value.timeoutMs ?? options.config.runTimeoutMs,
        });
        void run.done.catch(() => {
          stats.failed += 1;
        });
        return run;
      });
      if (!submitted.accepted)
        return queueFull(submitted.retryAfterSeconds, id);
      stats.total += 1;
      return json(
        { requestId: id, queued: submitted.queued, status: "accepted" },
        202,
      );
    } catch (error) {
      await options.logger?.error("spawn failed", {
        error: normalizeError(error).message,
        requestId: id,
      });
      return errorResponse(500, "SPAWN_FAILED", "spawn failed", id);
    }
  });
  app.all("/run", () =>
    errorResponse(405, "METHOD_NOT_ALLOWED", "method not allowed", requestId()),
  );

  return app;
};

const readJsonBody = async (
  request: Request,
  maxBytes: number,
): Promise<JsonBodyResult> => {
  if (!isJsonRequest(request)) {
    return {
      code: "UNSUPPORTED_MEDIA_TYPE",
      error: "request body must be application/json",
      ok: false,
      status: 415,
    };
  }
  const contentLength = Number.parseInt(
    request.headers.get("content-length") ?? "0",
    10,
  );
  if (contentLength > maxBytes)
    return {
      code: "PAYLOAD_TOO_LARGE",
      error: "request body too large",
      ok: false,
      status: 413,
    };
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > maxBytes)
    return {
      code: "PAYLOAD_TOO_LARGE",
      error: "request body too large",
      ok: false,
      status: 413,
    };
  try {
    const value: unknown = JSON.parse(Buffer.from(buffer).toString("utf8"));
    return { ok: true, value };
  } catch {
    return {
      code: "VALIDATION",
      error: "invalid JSON body",
      ok: false,
      status: 400,
    };
  }
};

type JsonBodyResult =
  | { ok: true; value: unknown }
  | { code: ErrorCode; error: string; ok: false; status: number };

const isJsonRequest = (request: Request) =>
  request.headers.get("content-type")?.toLowerCase().split(";")[0]?.trim() ===
  "application/json";

const authorized = (request: Request, token: string | undefined) => {
  if (token === undefined) return true;
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const expected = createHash("sha256").update(token).digest();
  const actual = createHash("sha256")
    .update(header.slice("Bearer ".length))
    .digest();
  return timingSafeEqual(expected, actual);
};

const unauthorized = (id: string) =>
  errorResponse(401, "UNAUTHORIZED", "missing or invalid bearer token", id, {
    "WWW-Authenticate": "Bearer",
  });

const queueFull = (retryAfterSeconds: number, id: string) =>
  errorResponse(503, "QUEUE_FULL", "queue full", id, {
    "Retry-After": String(retryAfterSeconds),
  });

const errorResponse = (
  status: number,
  code: ErrorCode,
  error: string,
  id: string,
  headers: Record<string, string> = {},
) => json({ code, error, requestId: id }, status, headers);

const json = (
  body: object,
  status: number,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...headers },
    status,
  });

const requestId = () => `rq_${randomBytes(8).toString("hex")}`;

const normalizeError = (error: unknown) =>
  error instanceof Error ? error : new Error(String(error));

const attachCredentials = (
  attach: ServerConfig["attach"],
): AttachCredentials => ({
  ...(attach.password === undefined ? {} : { password: attach.password }),
  ...(attach.username === undefined ? {} : { username: attach.username }),
});

/* v8 ignore next -- direct CLI entrypoint */
if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  const { bootstrapServer } = await import("./bootstrap.js");
  await bootstrapServer();
}

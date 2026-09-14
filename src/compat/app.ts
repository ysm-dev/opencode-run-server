import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import type { Config } from "../config.js";
import type { Logger } from "../log.js";
import type { RunQueue } from "../queue.js";
import { authorized, failure, json, readBody } from "./http.js";
import { type LegacyRequest, legacyRequest } from "./request.js";

type Options = {
  config: Config;
  bind: string;
  mainServerUrl: string;
  version: string;
  health: () => { healthy: boolean; lastCheckAt: number };
  logger: Pick<Logger, "error" | "warn">;
  queue: RunQueue;
  start: (
    id: string,
    request: LegacyRequest,
  ) => Promise<{ done: Promise<void> }>;
};

export const createLegacyApp = (options: Options) => {
  const app = new Hono();
  const started = Date.now();
  const stats = { total: 0, failed: 0 };
  options.queue.onDrop = (requestId) => {
    void options.logger
      .warn("queued run dropped", { requestId })
      .catch(console.error);
  };
  options.queue.onStartFailure = (requestId, error) => {
    stats.failed += 1;
    void options.logger
      .error("queued run startup failed", { requestId, error: String(error) })
      .catch(console.error);
  };
  const requestId = () => `rq_${randomBytes(8).toString("hex")}`;
  const unauthorized = (id: string) =>
    failure(401, "UNAUTHORIZED", "missing or invalid bearer token", id, {
      "WWW-Authenticate": "Bearer",
    });
  app.get("/health", () =>
    json({ status: "ok", uptimeMs: Date.now() - started }),
  );
  app.get("/status", (ctx) => {
    const id = requestId();
    if (!authorized(ctx.req.raw, options.config.token)) return unauthorized(id);
    return json({
      bind: { host: options.bind, port: options.config.port },
      mainServer: { ...options.health(), url: options.mainServerUrl },
      opencodePath: options.config.opencodePath,
      runs: { ...options.queue.stats(), ...stats },
      uptimeMs: Date.now() - started,
      version: options.version,
    });
  });
  app.post("/run", async (ctx) => {
    const id = requestId();
    if (!authorized(ctx.req.raw, options.config.token)) return unauthorized(id);
    const body = await readBody(ctx.req.raw, options.config.maxBodyBytes, id);
    if ("response" in body) return body.response;
    const parsed = legacyRequest.safeParse(body.value);
    if (!parsed.success)
      return failure(
        400,
        "VALIDATION",
        parsed.error.issues.map((issue) => issue.message).join("; "),
        id,
      );
    try {
      const submitted = await options.queue.submit(id, async () => {
        const run = await options.start(id, parsed.data);
        void run.done.catch(() => {
          stats.failed += 1;
        });
        return run;
      });
      if (!submitted.accepted)
        return failure(503, "QUEUE_FULL", "queue full", id, {
          "Retry-After": String(submitted.retryAfterSeconds),
        });
      stats.total += 1;
      return json(
        { requestId: id, queued: submitted.queued, status: "accepted" },
        202,
      );
    } catch (error) {
      await options.logger.error("run startup failed", {
        requestId: id,
        error: String(error),
      });
      return failure(500, "SPAWN_FAILED", "spawn failed", id);
    }
  });
  for (const path of ["/health", "/status", "/run"])
    app.all(path, () =>
      failure(405, "METHOD_NOT_ALLOWED", "method not allowed", requestId()),
    );
  return app;
};

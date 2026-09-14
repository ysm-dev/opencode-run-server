import { randomUUID } from "node:crypto";
import { Plugin } from "@opencode/plugin";
import pkg from "../package.json" with { type: "json" };
import { defaultLogFile, parseOptions } from "./config.js";
import { registerHeadless } from "./headless.js";
import { createFileLogger } from "./log.js";
import { RunQueue, type SubmitResult } from "./queue.js";
import { RunServer } from "./rpc.js";
import { type RunContext, RunManager } from "./runner.js";

type SetupContext = RunContext & {
  session: RunContext["session"] & Pick<Plugin.Context["session"], "hook">;
  options: Plugin.Context["options"];
  permission: Pick<Plugin.Context["permission"], "hook">;
  event: Plugin.Context["event"];
  rpc: Pick<Plugin.Context["rpc"], "register">;
};

export const setup = async (ctx: SetupContext) => {
  const config = parseOptions(ctx.options);
  const logger = createFileLogger({
    ...config.log,
    file: config.log.file ?? defaultLogFile(),
    secrets: [
      process.env.OPENCODE_SERVER_PASSWORD ?? "",
      config.token ?? "",
      config.attach.password ?? "",
    ],
  });
  const reportError = (error: unknown) =>
    console.error("opencode-run-server:", error);
  const logging = new Set<Promise<void>>();
  const log = (
    message: string,
    fields: Parameters<typeof logger.info>[1],
    level: "info" | "warn" | "error" = "info",
  ) => {
    const pending = logger[level](message, {
      directory: ctx.location.directory,
      ...fields,
    }).catch(reportError);
    logging.add(pending);
    void pending.then(() => logging.delete(pending));
  };
  const stats = { total: 0, failed: 0, completed: 0, dropped: 0 };
  const queue = new RunQueue(config);
  const manager = new RunManager(ctx, config, (result) => {
    if (result.error === undefined) stats.completed += 1;
    else stats.failed += 1;
    log(
      "run finished",
      {
        requestId: result.requestId,
        sessionID: result.sessionID ?? "",
        error: result.error ?? "",
      },
      result.error === undefined ? "info" : "error",
    );
  });
  queue.onDrop = (requestId) => {
    stats.dropped += 1;
    log("queued run dropped", { requestId }, "warn");
  };
  queue.onStartFailure = (requestId, error) =>
    log(
      "queued run failed to start",
      { requestId, error: error.message },
      "error",
    );
  const controller = new AbortController();
  const startedAt = Date.now();
  let cleanupEvents: (() => Promise<void>) | undefined;
  let cleanupCompatibility: (() => Promise<void>) | undefined;
  const cleanup = async () => {
    queue.stop();
    controller.abort();
    await cleanupCompatibility?.();
    await manager.dispose();
    await cleanupEvents?.();
    await Promise.all(logging);
  };
  try {
    cleanupEvents = await registerHeadless(
      ctx,
      manager,
      controller.signal,
      (error) => {
        if (error !== undefined) reportError(error);
        queue.stop();
        void manager.dispose().catch(reportError);
      },
    );
    await ctx.rpc.register(RunServer, {
      run: async (input, call) => {
        call.signal.throwIfAborted();
        if (Buffer.byteLength(JSON.stringify(input)) > config.maxInputBytes) {
          return call.error(
            "input_too_large",
            "Run input exceeds the configured limit",
            { maxInputBytes: config.maxInputBytes },
          );
        }
        const requestId = `rq_${randomUUID()}`;
        let submitted: SubmitResult;
        try {
          submitted = await queue.submit(requestId, () =>
            manager.start(requestId, input),
          );
        } catch {
          return call.error(
            "start_failed",
            "Run could not be started; see the run log",
            { requestId },
          );
        }
        if (!submitted.accepted) {
          return call.error("queue_full", "Run queue is full or stopping", {
            retryAfterSeconds: submitted.retryAfterSeconds,
          });
        }
        stats.total += 1;
        log("run accepted", { requestId, queued: submitted.queued });
        return {
          requestId,
          status: "accepted" as const,
          queued: submitted.queued,
        };
      },
      status: async () => ({
        version: pkg.version,
        uptimeMs: Date.now() - startedAt,
        location: {
          directory: ctx.location.directory,
          ...(ctx.location.workspaceID === undefined
            ? {}
            : { workspaceID: ctx.location.workspaceID }),
        },
        runs: { ...queue.stats(), ...stats },
      }),
    });
    if (config.legacyHttp) {
      const { acquireCompatibility } = await import("./compat/supervisor.js");
      cleanupCompatibility = await acquireCompatibility(config, (message) =>
        log(message, {}, "info"),
      );
    }
  } catch (error) {
    await cleanup();
    throw error;
  }
  return cleanup;
};

export default Plugin.define({ id: "opencode-run-server", setup });

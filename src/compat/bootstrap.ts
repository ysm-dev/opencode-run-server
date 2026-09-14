import { serve } from "@hono/node-server";
import { OpenCode } from "@opencode/client";
import { headers } from "@opencode/client/service";
import { z } from "zod";
import pkg from "../../package.json" with { type: "json" };
import { defaultLogFile, parseOptions } from "../config.js";
import { createFileLogger } from "../log.js";
import { RunQueue } from "../queue.js";
import { createLegacyApp } from "./app.js";
import { LegacyBackend } from "./backend.js";
import { checkHealth, HealthMonitor } from "./health.js";

const endpointSchema = z.object({
  url: z.url(),
  auth: z
    .object({
      type: z.literal("basic"),
      username: z.string(),
      password: z.string(),
    })
    .optional(),
});

export const bootstrap = async (env: NodeJS.ProcessEnv) => {
  const config = parseOptions(
    JSON.parse(env.OPENCODE_RUN_SERVER_CONFIG ?? "{}"),
  );
  const parsed = endpointSchema.parse(
    JSON.parse(env.OPENCODE_RUN_SERVER_ENDPOINT ?? "{}"),
  );
  const endpoint = {
    url: parsed.url,
    ...(parsed.auth === undefined ? {} : { auth: parsed.auth }),
  };
  const pid = z.coerce
    .number()
    .int()
    .positive()
    .parse(env.OPENCODE_RUN_SERVER_PARENT_PID);
  const logger = createFileLogger({
    ...config.log,
    file: config.log.file ?? defaultLogFile(),
    secrets: [
      config.token ?? "",
      endpoint.auth?.password ?? "",
      env.OPENCODE_SERVER_PASSWORD ?? "",
    ],
  });
  const queue = new RunQueue(config);
  const client = OpenCode.make({
    baseUrl: endpoint.url,
    headers: headers(endpoint),
    fetch: Object.assign(
      (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
        fetch(input, { ...init, ...{ timeout: false } }),
      { preconnect: fetch.preconnect },
    ),
  });
  let shuttingDown: Promise<void> | undefined;
  const backend = new LegacyBackend(client, config, logger, () => {
    void shutdown();
  });
  const monitor = new HealthMonitor(
    endpoint.url,
    config.healthCheck,
    () => {
      void shutdown();
    },
    async (url, timeout) => {
      try {
        process.kill(pid, 0);
      } catch {
        return false;
      }
      return checkHealth(url, timeout);
    },
  );
  const app = createLegacyApp({
    config,
    bind: config.bind ?? "127.0.0.1",
    mainServerUrl: endpoint.url,
    version: pkg.version,
    health: monitor.snapshot,
    logger,
    queue,
    start: (id, request) => backend.start(id, request),
  });
  const server = serve({
    fetch: app.fetch,
    hostname: config.bind ?? "127.0.0.1",
    port: config.port,
  });
  const shutdown = () => {
    shuttingDown ??= (async () => {
      queue.stop();
      monitor.stop();
      const force = setTimeout(() => process.exit(0), config.shutdownGraceMs);
      force.unref();
      server.close();
      if ("closeIdleConnections" in server) server.closeIdleConnections();
      await backend.dispose();
      clearTimeout(force);
      process.off("SIGTERM", onSignal);
      process.off("SIGINT", onSignal);
    })();
    return shuttingDown;
  };
  const onSignal = () => {
    void shutdown();
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    await backend.connect();
    monitor.start();
  } catch (error) {
    await shutdown();
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "EADDRINUSE"
    ) {
      process.exitCode = 3;
      return;
    }
    throw error;
  }
  return shutdown;
};

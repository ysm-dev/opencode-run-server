import { readFile } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { parseServerEnv } from "./config.js";
import { HealthMonitor } from "./health.js";
import { createFileLogger } from "./log.js";
import { RunQueue } from "./queue.js";
import { RunManager } from "./runner.js";
import { createRunServerApp } from "./server.js";

/* v8 ignore start -- exercised by the real subprocess e2e suite */
export const bootstrapServer = async () => {
  const { config, mainServerUrl } = parseServerEnv(process.env);
  const logger = createFileLogger({
    file: config.log.file,
    level: config.log.level,
    maxFiles: config.log.maxFiles,
    maxSize: config.log.maxSize,
    secrets: [
      config.token ?? "",
      config.attach.password ?? "",
      process.env.OPENCODE_SERVER_PASSWORD ?? "",
    ],
  });
  const manager = new RunManager({
    logger,
    shutdownGraceMs: config.shutdownGraceMs,
  });
  const queue = new RunQueue(config);
  const health = { healthy: true, lastCheckAt: Date.now() };
  let server: ReturnType<typeof serve> | undefined;
  const shutdown = async () => {
    monitor.stop();
    queue.stop();
    server?.close();
    await manager.killAll();
    process.exit(0);
  };
  const monitor = new HealthMonitor({
    ...config.healthCheck,
    mainServerUrl,
    onUnhealthy: shutdown,
  });
  const app = createRunServerApp({
    config,
    health,
    logger,
    mainServerUrl,
    packageVersion: await readPackageVersion(),
    queue,
    startRun: (job) => manager.start(job),
  });
  server = serve({
    fetch: app.fetch,
    hostname: config.bind,
    port: config.port,
  });
  server.on("error", (error) =>
    process.exit(errorCode(error) === "EADDRINUSE" ? 3 : 1),
  );
  monitor.start();
};

const errorCode = (error: unknown) => {
  if (typeof error === "object" && error !== null && "code" in error)
    return String(error.code);
  return undefined;
};

const readPackageVersion = async () => {
  const packageJson: unknown = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  if (
    typeof packageJson === "object" &&
    packageJson !== null &&
    "version" in packageJson
  ) {
    return String(packageJson.version);
  }
  return "0.0.0";
};
/* v8 ignore stop */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenCodeClient } from "@opencode/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { bootstrap } from "./bootstrap.js";
import type { HealthStatus } from "./health.js";
import { ownershipFile } from "./ownership.js";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(async () => {}),
  start: vi.fn(async () => ({ done: Promise.resolve() })),
  dispose: vi.fn(async () => {}),
  stopped: vi.fn(),
  started: vi.fn(),
  checks: [] as Array<(url: string, timeout: number) => Promise<HealthStatus>>,
  unhealthy: [] as Array<() => void>,
  reports: [] as Array<(message: string) => void>,
  check: vi.fn(async (): Promise<HealthStatus> => "ok"),
  clients: [] as OpenCodeClient[],
  unavailable: [] as Array<() => void>,
}));
vi.mock("./backend.js", () => ({
  LegacyBackend: class {
    constructor(
      client: OpenCodeClient,
      _config: object,
      _logger: object,
      unavailable: () => void,
    ) {
      mocks.clients.push(client);
      mocks.unavailable.push(unavailable);
    }
    connect = mocks.connect;
    dispose = mocks.dispose;
    start = mocks.start;
  },
}));
vi.mock("./health.js", () => ({
  checkHealth: mocks.check,
  HealthMonitor: class {
    constructor(
      _url: string,
      _config: object,
      unhealthy: () => void,
      check: (url: string, timeout: number) => Promise<HealthStatus>,
      report: (message: string) => void,
    ) {
      mocks.unhealthy.push(unhealthy);
      mocks.checks.push(check);
      mocks.reports.push(report);
    }
    start = mocks.started;
    stop = mocks.stopped;
    snapshot = () => ({ healthy: true, lastCheckAt: 0 });
  },
}));

const cleanups: Array<() => Promise<void>> = [];
const exitCode = process.exitCode;
let state = "";
beforeEach(async () => {
  state = await mkdtemp(join(tmpdir(), "ors-state-"));
  vi.stubEnv("XDG_STATE_HOME", state);
});
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  mocks.connect.mockReset().mockResolvedValue();
  mocks.dispose.mockReset().mockResolvedValue();
  mocks.check.mockReset().mockResolvedValue("ok");
  mocks.checks.length = 0;
  mocks.unhealthy.length = 0;
  mocks.reports.length = 0;
  mocks.clients.length = 0;
  mocks.unavailable.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  await rm(state, { recursive: true, force: true });
  process.exitCode = exitCode;
});
const port = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Port missing"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
const env = (port: number, extra: object = {}) => ({
  OPENCODE_RUN_SERVER_CONFIG: JSON.stringify({
    port,
    bind: "127.0.0.1",
    shutdownGraceMs: 20,
    ...extra,
  }),
  OPENCODE_RUN_SERVER_ENDPOINT: JSON.stringify({ url: "http://127.0.0.1:1" }),
  OPENCODE_RUN_SERVER_PARENT_PID: String(process.pid),
  OPENCODE_RUN_SERVER_FINGERPRINT: "print",
});

it("boots the HTTP listener and releases signals and resources on shutdown", async () => {
  const before = process.listenerCount("SIGTERM");
  const bindPort = await port();
  const cleanup = await bootstrap(env(bindPort));
  expect(cleanup).toBeTypeOf("function");
  if (cleanup === undefined) throw new Error("Missing cleanup");
  cleanups.push(cleanup);
  expect((await fetch(`http://127.0.0.1:${bindPort}/health`)).status).toBe(200);
  expect(mocks.connect).toHaveBeenCalled();
  expect(mocks.started).toHaveBeenCalled();
  expect(await mocks.checks[0]?.("http://host", 100)).toBe("ok");
  mocks.reports[0]?.("backend transport recovered");
  const ownership = ownershipFile("127.0.0.1", bindPort);
  expect(JSON.parse(await readFile(ownership, "utf8"))).toMatchObject({
    pid: process.pid,
    parentPid: process.pid,
    bind: "127.0.0.1",
    port: bindPort,
    fingerprint: "print",
  });
  mocks.unhealthy[0]?.();
  await cleanup();
  expect(mocks.dispose).toHaveBeenCalled();
  expect(process.listenerCount("SIGTERM")).toBe(before);
  await expect(readFile(ownership, "utf8")).rejects.toThrow();
  await expect(fetch(`http://127.0.0.1:${bindPort}/health`)).rejects.toThrow();
});

it("returns skip code 3 for an occupied port and cleans up failed startup", async () => {
  const bindPort = await port();
  const cleanup = await bootstrap(env(bindPort));
  if (cleanup === undefined) throw new Error("Missing cleanup");
  cleanups.push(cleanup);
  expect(await bootstrap(env(bindPort))).toBeUndefined();
  expect(process.exitCode).toBe(3);
  mocks.connect.mockRejectedValueOnce(new Error("no event stream"));
  await expect(bootstrap(env(await port()))).rejects.toThrow("no event stream");
});

it("validates bootstrap input and stops only when the owning process is gone", async () => {
  await expect(bootstrap({})).rejects.toThrow();
  const bindPort = await port();
  const values = env(bindPort);
  values.OPENCODE_RUN_SERVER_PARENT_PID = "99999999";
  const cleanup = await bootstrap({
    ...values,
    OPENCODE_RUN_SERVER_FINGERPRINT: undefined,
  });
  if (cleanup !== undefined) cleanups.push(cleanup);
  expect(await mocks.checks[0]?.("http://host", 100)).toBe("gone");
  expect(
    JSON.parse(await readFile(ownershipFile("127.0.0.1", bindPort), "utf8")),
  ).toMatchObject({ fingerprint: "unknown" });
});

it("handles its own SIGTERM callback and bounded forced shutdown", async () => {
  const before = new Set(process.listeners("SIGTERM"));
  const cleanup = await bootstrap(env(await port()));
  if (cleanup === undefined) throw new Error("Missing cleanup");
  cleanups.push(cleanup);
  const signal = process
    .listeners("SIGTERM")
    .find((listener) => !before.has(listener));
  signal?.("SIGTERM");
  await cleanup();
  const pending = Promise.withResolvers<void>();
  mocks.dispose.mockReturnValueOnce(pending.promise);
  const forced = await bootstrap(env(await port()));
  if (forced === undefined) throw new Error("Missing cleanup");
  cleanups.push(forced);
  vi.useFakeTimers();
  const exit = vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("forced exit");
  });
  const stopping = forced();
  await expect(vi.advanceTimersByTimeAsync(21)).rejects.toThrow("forced exit");
  expect(exit).toHaveBeenCalledWith(0);
  pending.resolve();
  await stopping;
});

it("wires authenticated backend transport and legacy requests with loopback defaults", async () => {
  const bindPort = await port();
  const values = env(bindPort, {
    bind: undefined,
    token: "token",
    log: { file: "/dev/null" },
  });
  values.OPENCODE_RUN_SERVER_ENDPOINT = JSON.stringify({
    url: `http://127.0.0.1:${bindPort}`,
    auth: { type: "basic", username: "user", password: "pass" },
  });
  const cleanup = await bootstrap({
    ...values,
    OPENCODE_SERVER_PASSWORD: "env-pass",
  });
  if (cleanup === undefined) throw new Error("Missing cleanup");
  cleanups.push(cleanup);
  const response = await fetch(`http://127.0.0.1:${bindPort}/run`, {
    method: "POST",
    headers: {
      authorization: "Bearer token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ dir: "/project", prompt: "test" }),
  });
  expect(response.status).toBe(202);
  expect(mocks.start).toHaveBeenCalled();
  // The actual configured transport reaches this test listener; /api/status is intentionally absent.
  await expect(mocks.clients[0]?.server.status()).rejects.toBeDefined();
  mocks.unavailable[0]?.();
  await cleanup();
});

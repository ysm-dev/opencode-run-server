import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import type { Endpoint } from "@opencode/client/service";
import { afterEach, expect, it, vi } from "vitest";
import { parseOptions } from "../config.js";
import { acquireCompatibility, Supervisor } from "./supervisor.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
const fixture = (options: object = {}) => {
  const child = new ChildProcess();
  Object.defineProperty(child, "pid", { value: 12345, configurable: true });
  child.stderr = new PassThrough();
  const discover = vi.fn<() => Promise<Endpoint | undefined>>(async () => ({
    url: "http://host",
    auth: { type: "basic" as const, username: "opencode", password: "secret" },
  }));
  const runtime = vi.fn(async () => "/bin/node");
  const spawn = vi.fn(() => child);
  const kill = vi.fn((_pid: number, _signal: NodeJS.Signals) => {
    Object.defineProperty(child, "exitCode", { value: 0, configurable: true });
    child.emit("exit", 0, null);
  });
  const health = vi.fn(async () => true);
  const report = vi.fn();
  const config = parseOptions({
    bind: "127.0.0.1",
    healthCheck: { intervalMs: 10 },
    shutdownGraceMs: 10,
    restart: { baseDelayMs: 10, maxDelayMs: 20, maxRetries: 2, windowMs: 100 },
    ...options,
  });
  const supervisor = new Supervisor(config, "127.0.0.1", report, {
    discover,
    runtime,
    spawn,
    kill,
    health,
  });
  return {
    child,
    discover,
    runtime,
    spawn,
    kill,
    health,
    report,
    supervisor,
    config,
  };
};

it("forwards resolved service auth and legacy config and cleans up its child", async () => {
  const f = fixture();
  f.supervisor.start();
  await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledOnce());
  expect(f.spawn).toHaveBeenCalledWith(
    "/bin/node",
    [expect.stringContaining("dist/compat-server.js")],
    expect.objectContaining({
      OPENCODE_RUN_SERVER_ENDPOINT: JSON.stringify({
        url: "http://host",
        auth: { type: "basic", username: "opencode", password: "secret" },
      }),
      OPENCODE_RUN_SERVER_PARENT_PID: String(process.pid),
    }),
  );
  f.child.stderr?.emit("data", Buffer.from("diagnostic"));
  expect(f.report).toHaveBeenCalledWith("diagnostic");
  await f.supervisor.dispose();
  expect(f.kill).toHaveBeenCalledWith(12345, "SIGTERM");
  await f.supervisor.dispose();
});

it("waits for managed-service discovery without starting a different server", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.discover.mockResolvedValueOnce(undefined);
  f.supervisor.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.spawn).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(11);
  expect(f.spawn).toHaveBeenCalledOnce();
  await f.supervisor.dispose();
});

it("bounds restart backoff and ignores duplicate error/exit notifications", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.supervisor.start();
  await vi.advanceTimersByTimeAsync(0);
  f.child.emit("error", new Error("spawn failed"));
  f.child.emit("exit", 1, null);
  await vi.advanceTimersByTimeAsync(11);
  expect(f.spawn).toHaveBeenCalledTimes(2);
  f.child.emit("exit", 1, null);
  await vi.advanceTimersByTimeAsync(21);
  expect(f.spawn).toHaveBeenCalledTimes(3);
  f.child.emit("exit", 1, null);
  await vi.advanceTimersByTimeAsync(50);
  expect(f.spawn).toHaveBeenCalledTimes(3);
  await f.supervisor.dispose();
});

it("does not restart an occupied port or a dead backend", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.supervisor.start();
  await vi.advanceTimersByTimeAsync(0);
  f.child.emit("exit", 3, null);
  await vi.advanceTimersByTimeAsync(30);
  expect(f.health).not.toHaveBeenCalled();
  expect(f.spawn).toHaveBeenCalledOnce();
  f.supervisor.start();
  await vi.advanceTimersByTimeAsync(0);
  f.health.mockResolvedValue(false);
  f.child.emit("exit", 1, null);
  await vi.advanceTimersByTimeAsync(30);
  expect(f.spawn).toHaveBeenCalledTimes(2);
  await f.supervisor.dispose();
});

it("cancels pending restart timers and late startup on unload", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.runtime.mockRejectedValueOnce(new Error("no runtime"));
  f.supervisor.start();
  await vi.advanceTimersByTimeAsync(0);
  await f.supervisor.dispose();
  await vi.advanceTimersByTimeAsync(100);
  f.supervisor.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.spawn).not.toHaveBeenCalled();
  const g = fixture();
  const pending = Promise.withResolvers<string>();
  g.runtime.mockReturnValueOnce(pending.promise);
  g.supervisor.start();
  await vi.advanceTimersByTimeAsync(0);
  const disposed = g.supervisor.dispose();
  pending.resolve("node");
  await disposed;
  expect(g.spawn).not.toHaveBeenCalled();
});

it("escalates termination and handles children without a pid", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.kill.mockImplementation(() => {});
  f.supervisor.start();
  await vi.advanceTimersByTimeAsync(0);
  const done = f.supervisor.dispose();
  await vi.advanceTimersByTimeAsync(11);
  await done;
  expect(f.kill).toHaveBeenLastCalledWith(12345, "SIGKILL");
  const g = fixture();
  Object.defineProperty(g.child, "pid", { value: undefined });
  g.supervisor.start();
  await vi.advanceTimersByTimeAsync(0);
  await g.supervisor.dispose();
  expect(g.kill).not.toHaveBeenCalled();
});

it("shares a listener between location instances and releases the final reference", async () => {
  const start = vi
    .spyOn(Supervisor.prototype, "start")
    .mockImplementation(() => {});
  const dispose = vi.spyOn(Supervisor.prototype, "dispose").mockResolvedValue();
  const config = parseOptions({ bind: "127.0.0.1", port: 50001 });
  const one = await acquireCompatibility(config, vi.fn());
  const two = await acquireCompatibility(config, vi.fn());
  expect(start).toHaveBeenCalledOnce();
  await one();
  await one();
  expect(dispose).not.toHaveBeenCalled();
  await two();
  expect(dispose).toHaveBeenCalledOnce();
});

it("supports default discovery and binding without registering another service", async () => {
  vi.stubEnv("XDG_STATE_HOME", "/nonexistent-opencode-test-state");
  const release = await acquireCompatibility(
    parseOptions({ port: 50002 }),
    vi.fn(),
  );
  await release();
});

it("uses the real default runtime and spawn path and observes failed companion startup", async () => {
  // The companion rejects port zero before binding any socket.
  const report = vi.fn();
  const supervisor = new Supervisor(
    { ...parseOptions({ runtime: "node" }), port: 0 },
    "127.0.0.1",
    report,
    {
      discover: async () => ({ url: "http://127.0.0.1:1" }),
      health: async () => false,
    },
  );
  supervisor.start();
  await vi.waitFor(
    () =>
      expect(report).toHaveBeenCalledWith("compatibility listener exited (1)"),
    { timeout: 5000 },
  );
  await supervisor.dispose();
});

it("uses process-group termination and tolerates an already-exited group", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const kill = vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("gone"), { code: "ESRCH" });
  });
  const supervisor = new Supervisor(f.config, "127.0.0.1", f.report, {
    discover: f.discover,
    runtime: f.runtime,
    spawn: f.spawn,
  });
  supervisor.start();
  await vi.advanceTimersByTimeAsync(0);
  const stopped = supervisor.dispose();
  await vi.advanceTimersByTimeAsync(11);
  await stopped;
  expect(kill).toHaveBeenCalledWith(-12345, "SIGTERM");
  expect(kill).toHaveBeenCalledWith(-12345, "SIGKILL");
});

it("reports health-check errors and does not kill an already-signalled child", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.health.mockRejectedValueOnce(new Error("health probe failed"));
  f.supervisor.start();
  await vi.advanceTimersByTimeAsync(0);
  f.child.emit("exit", 1);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.report).toHaveBeenCalledWith("Error: health probe failed");
  Object.defineProperty(f.child, "signalCode", { value: "SIGTERM" });
  await f.supervisor.dispose();
  expect(f.kill).not.toHaveBeenCalled();
});

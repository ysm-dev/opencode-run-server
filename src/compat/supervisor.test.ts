import { afterEach, expect, it, vi } from "vitest";
import {
  supervisorFixture as fixture,
  ownershipRecord as record,
} from "../../test/supervisor-fixture.js";
import { parseOptions } from "../config.js";
import { Supervisor } from "./supervisor.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

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
      OPENCODE_RUN_SERVER_FINGERPRINT: f.supervisor.print,
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

it("bounds restart backoff, pauses a spent budget, and ignores duplicate exits", async () => {
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
  expect(f.report).toHaveBeenCalledWith(
    "compatibility listener restart budget spent; pausing",
  );
  await vi.advanceTimersByTimeAsync(60);
  expect(f.spawn).toHaveBeenCalledTimes(4);
  await f.supervisor.dispose();
});

it("keeps re-checking after port contention and an unreachable backend", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.supervisor.start();
  await vi.advanceTimersByTimeAsync(0);
  f.child.emit("exit", 3, null);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.health).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(11);
  expect(f.spawn).toHaveBeenCalledTimes(2);
  f.health.mockResolvedValue("down");
  f.child.emit("exit", 1, null);
  await vi.advanceTimersByTimeAsync(11);
  expect(f.spawn).toHaveBeenCalledTimes(3);
  await f.supervisor.dispose();
});

it("adopts a listener this process already owns and relaunches when it stops", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.owner.mockImplementation(async () =>
    record({ fingerprint: f.supervisor.print }),
  );
  f.supervisor.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.spawn).not.toHaveBeenCalled();
  expect(f.report).toHaveBeenCalledWith(
    "compatibility listener already running; adopted",
  );
  await vi.advanceTimersByTimeAsync(11);
  expect(f.report).toHaveBeenCalledTimes(1);
  f.running.mockReturnValue(false);
  await vi.advanceTimersByTimeAsync(11);
  expect(f.spawn).toHaveBeenCalledOnce();
  await f.supervisor.dispose();
});

it("discards a registration whose address stopped answering", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.owner.mockResolvedValue(record({ fingerprint: f.supervisor.print }));
  f.listening.mockResolvedValue(false);
  f.supervisor.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.forget).toHaveBeenCalledWith(f.supervisor.file, 4321);
  expect(f.kill).not.toHaveBeenCalled();
  expect(f.spawn).toHaveBeenCalledOnce();
  await f.supervisor.dispose();
});

it("reclaims a stale listener, escalates, and skips a foreign owner", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.owner.mockResolvedValue(record({ parentPid: 999_999 }));
  f.running.mockImplementation((pid) => pid !== 999_999);
  f.supervisor.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.kill).toHaveBeenCalledWith(4321, "SIGTERM");
  await vi.advanceTimersByTimeAsync(11);
  expect(f.kill).toHaveBeenCalledWith(4321, "SIGKILL");
  expect(f.spawn).not.toHaveBeenCalled();
  f.running.mockReturnValue(true);
  await vi.advanceTimersByTimeAsync(11);
  expect(f.report).toHaveBeenCalledWith(
    "compatibility listener port owned elsewhere; skipping",
  );
  expect(f.spawn).not.toHaveBeenCalled();
  f.owner.mockResolvedValue(undefined);
  await vi.advanceTimersByTimeAsync(11);
  expect(f.spawn).toHaveBeenCalledOnce();
  await f.supervisor.dispose();
});

it("terminates its child when the host process exits", async () => {
  vi.useFakeTimers();
  const before = process.listenerCount("exit");
  const f = fixture();
  f.supervisor.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(process.listenerCount("exit")).toBe(before + 1);
  const hook = process.listeners("exit").at(-1);
  hook?.(0);
  hook?.(0);
  expect(f.kill).toHaveBeenCalledOnce();
  expect(f.kill).toHaveBeenCalledWith(12345, "SIGTERM");
  await f.supervisor.dispose();
  expect(process.listenerCount("exit")).toBe(before);
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

it("uses the real default runtime and spawn path and observes failed companion startup", async () => {
  // The companion rejects port zero before binding any socket.
  const report = vi.fn();
  const supervisor = new Supervisor(
    { ...parseOptions({ runtime: "node" }), port: 0 },
    "127.0.0.1",
    report,
    {
      discover: async () => ({ url: "http://127.0.0.1:1" }),
      health: async () => "down",
      owner: async () => undefined,
      listening: async () => false,
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
  const { kill: _kill, ...deps } = f.deps;
  const supervisor = new Supervisor(f.config, "127.0.0.1", f.report, deps);
  supervisor.start();
  await vi.advanceTimersByTimeAsync(0);
  const stopped = supervisor.dispose();
  await vi.advanceTimersByTimeAsync(11);
  await stopped;
  expect(kill).toHaveBeenCalledWith(-12345, "SIGTERM");
  expect(kill).toHaveBeenCalledWith(-12345, "SIGKILL");
});

it("surfaces unexpected termination failures", async () => {
  vi.useFakeTimers();
  const f = fixture();
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("denied"), { code: "EPERM" });
  });
  const { kill: _kill, ...deps } = f.deps;
  const supervisor = new Supervisor(f.config, "127.0.0.1", f.report, deps);
  supervisor.start();
  await vi.advanceTimersByTimeAsync(0);
  await expect(supervisor.dispose()).rejects.toThrow("denied");
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

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SubprocessHandle } from "./plugin.js";
import { createPlugin } from "./plugin.js";

class FakeSubprocess extends EventEmitter implements SubprocessHandle {
  readonly pid: number | undefined;

  constructor(pid: number | null = 4321) {
    super();
    this.pid = pid ?? undefined;
  }
}

const logs: string[] = [];

const input = {
  client: {
    app: {
      log: async (entry: { body: { level: string; message: string } }) => {
        logs.push(`${entry.body.level}:${entry.body.message}`);
      },
    },
  },
  serverUrl: new URL("http://127.0.0.1:4096/"),
};

beforeEach(() => {
  logs.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

it("does not restart after the EADDRINUSE skip exit code", async () => {
  vi.useFakeTimers();
  const child = new FakeSubprocess();
  let starts = 0;
  const plugin = createPlugin({
    discoverBind: async () => ({ host: "127.0.0.1", source: "loopback" }),
    env: {},
    execPath: "/bin/opencode",
    resolveRuntime: async () => ({
      args: ["/pkg/src/server.ts"],
      command: "bun",
      kind: "bun",
    }),
    spawnSubprocess: () => {
      starts += 1;
      return child;
    },
  });

  await plugin(input, {});
  child.emit("exit", 3, null);
  await vi.advanceTimersByTimeAsync(1000);

  expect(starts).toBe(1);
});

it("restarts crashed subprocesses with backoff while the main server is healthy", async () => {
  vi.useFakeTimers();
  const children: FakeSubprocess[] = [];
  const plugin = createPlugin({
    checkHealth: async () => true,
    discoverBind: async () => ({ host: "127.0.0.1", source: "loopback" }),
    env: {},
    execPath: "/bin/opencode",
    now: () => Date.now(),
    resolveRuntime: async () => ({
      args: ["/pkg/src/server.ts"],
      command: "bun",
      kind: "bun",
    }),
    spawnSubprocess: () => {
      const child = new FakeSubprocess();
      children.push(child);
      return child;
    },
  });

  const hooks = await plugin(input, {
    restart: {
      baseDelayMs: 10,
      maxDelayMs: 100,
      maxRetries: 2,
      windowMs: 1000,
    },
  });
  children[0]?.emit("exit", 1, null);
  await vi.advanceTimersByTimeAsync(10);

  expect(children).toHaveLength(2);
  expect(logs).toContain("warn:run-server crashed; scheduling restart");
  await hooks.dispose?.();
});

it("does not restart when the main server is unhealthy or retry budget is exhausted", async () => {
  vi.useFakeTimers();
  const child = new FakeSubprocess();
  let starts = 0;
  const plugin = createPlugin({
    checkHealth: async () => false,
    discoverBind: async () => ({ host: "127.0.0.1", source: "loopback" }),
    env: {},
    execPath: "/bin/opencode",
    resolveRuntime: async () => ({
      args: ["/pkg/src/server.ts"],
      command: "bun",
      kind: "bun",
    }),
    spawnSubprocess: () => {
      starts += 1;
      return child;
    },
  });

  const hooks = await plugin(input, { restart: { maxRetries: 0 } });
  child.emit("exit", 1, null);
  await vi.advanceTimersByTimeAsync(100);

  expect(starts).toBe(1);
  await hooks.dispose?.();
});

it("does not restart when retry budget is exhausted despite healthy main server", async () => {
  vi.useFakeTimers();
  const child = new FakeSubprocess();
  let starts = 0;
  const plugin = createPlugin({
    checkHealth: async () => true,
    discoverBind: async () => ({ host: "127.0.0.1", source: "loopback" }),
    env: {},
    execPath: "/bin/opencode",
    resolveRuntime: async () => ({
      args: ["/pkg/src/server.ts"],
      command: "bun",
      kind: "bun",
    }),
    spawnSubprocess: () => {
      starts += 1;
      return child;
    },
  });

  const hooks = await plugin(input, { restart: { maxRetries: 0 } });
  child.emit("exit", 1, null);
  await vi.advanceTimersByTimeAsync(100);

  expect(starts).toBe(1);
  await hooks.dispose?.();
});

it("ignores exits after disposal and supports injected restart timers", async () => {
  const child = new FakeSubprocess();
  const callbacks: Array<() => void> = [];
  let starts = 0;
  const plugin = createPlugin({
    checkHealth: async () => true,
    discoverBind: async () => ({ host: "127.0.0.1", source: "loopback" }),
    env: {},
    execPath: "/bin/opencode",
    resolveRuntime: async () => ({
      args: ["/pkg/src/server.ts"],
      command: "bun",
      kind: "bun",
    }),
    setTimeout: (callback) => {
      callbacks.push(callback);
      return setTimeout(() => {}, 0);
    },
    spawnSubprocess: () => {
      starts += 1;
      return child;
    },
  });

  const hooks = await plugin(input, { restart: { baseDelayMs: 1 } });
  child.emit("exit", 1, null);
  await vi.waitFor(() => expect(callbacks).toHaveLength(1));
  callbacks[0]?.();
  expect(starts).toBe(2);

  await hooks.dispose?.();
  child.emit("exit", 1, null);
  await Promise.resolve();
  expect(starts).toBe(2);
});

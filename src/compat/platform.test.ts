import type { networkInterfaces } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { parseOptions } from "../config.js";
import { checkHealth, HealthMonitor } from "./health.js";
import { discoverBind, tailscaleIP } from "./network.js";
import { childEntry, resolveRuntime } from "./runtime.js";

afterEach(() => vi.useRealTimers());

it("uses Tailscale CLI output, interfaces, then loopback", async () => {
  expect(tailscaleIP("100.64.1.2")).toBe(true);
  for (const ip of [
    "100.63.1.2",
    "100.128.1.2",
    "100.64.999.1",
    "::1",
    "100.64.1.1bad",
  ])
    expect(tailscaleIP(ip)).toBe(false);
  expect(await discoverBind(async () => "\n100.100.1.2\n")).toBe("100.100.1.2");
  const interfaces: ReturnType<typeof networkInterfaces> = {
    tail: [
      {
        address: "100.64.1.3",
        family: "IPv4",
        internal: false,
        netmask: "255.255.255.255",
        mac: "",
        cidr: null,
      },
    ],
  };
  expect(
    await discoverBind(
      async () => "bad",
      () => interfaces,
    ),
  ).toBe("100.64.1.3");
  expect(
    await discoverBind(
      async () => {
        throw new Error("missing");
      },
      () => ({ empty: undefined }),
    ),
  ).toBe("127.0.0.1");
  expect(typeof (await discoverBind())).toBe("string");
});

it("selects Bun or Node runtimes and built companion entrypoints", async () => {
  expect(
    await resolveRuntime("auto", async (path) => path === "/bin/bun", {
      PATH: "/bin",
    }),
  ).toBe("/bin/bun");
  expect(
    await resolveRuntime("auto", async (path) => path === "/bin/node", {
      PATH: "/bin",
    }),
  ).toBe("/bin/node");
  expect(await resolveRuntime("node", async () => true, { PATH: "/bin" })).toBe(
    "/bin/node",
  );
  await expect(resolveRuntime("bun", async () => false, {})).rejects.toThrow(
    "bun was not found",
  );
  await expect(resolveRuntime("node", async () => false, {})).rejects.toThrow(
    "node runtime was not found",
  );
  expect(typeof (await resolveRuntime("node"))).toBe("string");
  expect(childEntry("file:///repo/dist/plugin.js")).toBe(
    "/repo/dist/compat-server.js",
  );
  expect(childEntry("file:///repo/src/compat/supervisor.ts")).toBe(
    "/repo/dist/compat-server.js",
  );
});

it("treats any HTTP response as alive, but transport failures as unhealthy", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(null, { status: 401 }));
  expect(await checkHealth("http://host", 100, fetcher)).toBe(true);
  fetcher.mockRejectedValueOnce(new Error("disconnected"));
  expect(await checkHealth("http://host", 100, fetcher)).toBe(false);
});

it("polls health with consecutive-failure thresholds and cancels stale checks", async () => {
  vi.useFakeTimers();
  const unhealthy = vi.fn();
  const check = vi
    .fn()
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(true)
    .mockResolvedValue(false);
  const config = parseOptions({
    healthCheck: { intervalMs: 10, failureThreshold: 2 },
  });
  const monitor = new HealthMonitor(
    "http://host",
    config.healthCheck,
    unhealthy,
    check,
  );
  monitor.start();
  monitor.start();
  await vi.advanceTimersByTimeAsync(31);
  expect(unhealthy).toHaveBeenCalledOnce();
  expect(monitor.snapshot().healthy).toBe(false);
  monitor.stop();
  const pending = Promise.withResolvers<boolean>();
  const stopped = new HealthMonitor(
    "http://host",
    config.healthCheck,
    unhealthy,
    () => pending.promise,
  );
  stopped.start();
  stopped.stop();
  pending.resolve(false);
  await vi.advanceTimersByTimeAsync(100);
  expect(unhealthy).toHaveBeenCalledOnce();
});

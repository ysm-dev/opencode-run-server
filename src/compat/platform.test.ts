import type { networkInterfaces } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { parseOptions } from "../config.js";
import {
  checkHealth,
  checkListener,
  HealthMonitor,
  type HealthStatus,
} from "./health.js";
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

it("separates responses, slow answers, and transport loss", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(null, { status: 401 }));
  expect(await checkHealth("http://host", 100, fetcher)).toBe("ok");
  fetcher.mockRejectedValueOnce(new Error("disconnected"));
  expect(await checkHealth("http://host", 100, fetcher)).toBe("down");
  fetcher.mockRejectedValueOnce(
    Object.assign(new Error("timed out"), { name: "TimeoutError" }),
  );
  expect(await checkHealth("http://host", 100, fetcher)).toBe("slow");
  fetcher.mockRejectedValueOnce("transport string");
  expect(await checkHealth("http://host", 100, fetcher)).toBe("down");
  fetcher.mockImplementationOnce((_input, init) =>
    fetch("http://127.0.0.1:1", { signal: init?.signal ?? null }),
  );
  expect(await checkHealth("http://host", 1, fetcher)).not.toBe("ok");
});

it("confirms a recorded listener still answers on its own address", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok"));
  expect(await checkListener("127.0.0.1", 4097, 100, fetcher)).toBe(true);
  expect(fetcher).toHaveBeenCalledWith(
    "http://127.0.0.1:4097/health",
    expect.objectContaining({ signal: expect.anything() }),
  );
  await checkListener("::1", 4097, 100, fetcher);
  expect(fetcher).toHaveBeenLastCalledWith(
    "http://[::1]:4097/health",
    expect.anything(),
  );
  fetcher.mockResolvedValueOnce(new Response(null, { status: 500 }));
  expect(await checkListener("127.0.0.1", 4097, 100, fetcher)).toBe(false);
  fetcher.mockRejectedValueOnce(new Error("refused"));
  expect(await checkListener("127.0.0.1", 4097, 100, fetcher)).toBe(false);
});

it("keeps serving a busy or unreachable backend and stops only when its owner is gone", async () => {
  vi.useFakeTimers();
  const gone = vi.fn();
  const report = vi.fn();
  const check = vi
    .fn<() => Promise<HealthStatus>>()
    .mockResolvedValueOnce("down")
    .mockResolvedValueOnce("slow")
    .mockResolvedValueOnce("down")
    .mockResolvedValueOnce("down")
    .mockResolvedValueOnce("ok")
    .mockResolvedValue("gone");
  const config = parseOptions({
    healthCheck: { intervalMs: 10, failureThreshold: 2 },
  });
  const monitor = new HealthMonitor(
    "http://host",
    config.healthCheck,
    gone,
    check,
    report,
  );
  monitor.start();
  monitor.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(monitor.snapshot().healthy).toBe(false);
  await vi.advanceTimersByTimeAsync(11);
  // A slow answer proves the service is present.
  expect(monitor.snapshot().healthy).toBe(true);
  expect(report).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(22);
  expect(report).toHaveBeenCalledWith(
    "backend transport unavailable; still accepting requests",
  );
  expect(gone).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(11);
  expect(report).toHaveBeenCalledWith("backend transport recovered");
  await vi.advanceTimersByTimeAsync(11);
  expect(report).toHaveBeenCalledWith("owning opencode process exited");
  expect(gone).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(50);
  expect(gone).toHaveBeenCalledOnce();
  monitor.stop();
  const silent = vi.fn();
  const defaults = new HealthMonitor(
    "http://host",
    config.healthCheck,
    silent,
    async () => "gone",
  );
  defaults.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(silent).toHaveBeenCalledOnce();
  const pending = Promise.withResolvers<HealthStatus>();
  const stopped = new HealthMonitor(
    "http://host",
    config.healthCheck,
    gone,
    () => pending.promise,
  );
  stopped.start();
  stopped.stop();
  pending.resolve("gone");
  await vi.advanceTimersByTimeAsync(100);
  expect(gone).toHaveBeenCalledOnce();
});

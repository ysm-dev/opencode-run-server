import { describe, expect, it, vi } from "vitest";
import { checkMainServerHealth, HealthMonitor } from "./health.js";

describe("main-server health checks", () => {
  it("treats any HTTP response, including 401 and 500, as alive", async () => {
    await expect(
      checkMainServerHealth(
        "http://main/",
        50,
        async () => new Response("no", { status: 401 }),
      ),
    ).resolves.toBe(true);

    await expect(
      checkMainServerHealth(
        "http://main/",
        50,
        async () => new Response("err", { status: 500 }),
      ),
    ).resolves.toBe(true);
  });

  it("treats transport failures as unhealthy", async () => {
    const healthy = await checkMainServerHealth(
      "http://main/",
      50,
      async () => {
        throw new Error("ECONNREFUSED");
      },
    );

    expect(healthy).toBe(false);
  });

  it("calls the shutdown callback after the configured failure threshold", async () => {
    vi.useFakeTimers();
    let shutdowns = 0;
    const monitor = new HealthMonitor({
      intervalMs: 10,
      timeoutMs: 5,
      failureThreshold: 2,
      mainServerUrl: "http://main/",
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
      onUnhealthy: async () => {
        shutdowns += 1;
      },
    });

    monitor.start();
    await vi.advanceTimersByTimeAsync(25);

    expect(shutdowns).toBe(1);
    expect(monitor.snapshot().healthy).toBe(false);
    monitor.stop();
    vi.useRealTimers();
  });

  it("can be stopped and started idempotently", async () => {
    vi.useFakeTimers();
    let checks = 0;
    const monitor = new HealthMonitor({
      intervalMs: 10,
      timeoutMs: 5,
      failureThreshold: 3,
      mainServerUrl: "http://main/",
      fetch: async () => {
        checks += 1;
        return new Response("ok");
      },
      onUnhealthy: async () => {},
    });

    monitor.start();
    monitor.start();
    await vi.advanceTimersByTimeAsync(1);
    monitor.stop();
    await vi.advanceTimersByTimeAsync(30);

    expect(checks).toBe(1);
    expect(monitor.snapshot().healthy).toBe(true);
    vi.useRealTimers();
  });

  it("can stop before a timer has been scheduled", () => {
    const monitor = new HealthMonitor({
      intervalMs: 10,
      timeoutMs: 5,
      failureThreshold: 3,
      mainServerUrl: "http://main/",
      fetch: async () => new Response("ok"),
      onUnhealthy: async () => {},
    });

    monitor.stop();
    expect(monitor.snapshot()).toEqual({ healthy: true, lastCheckAt: 0 });
  });

  it("does not schedule another poll when stopped during an in-flight check", async () => {
    vi.useFakeTimers();
    let resolveFetch!: () => void;
    let checks = 0;
    const monitor = new HealthMonitor({
      intervalMs: 10,
      timeoutMs: 5,
      failureThreshold: 3,
      mainServerUrl: "http://main/",
      fetch: async () => {
        checks += 1;
        await new Promise<void>((resolve) => {
          resolveFetch = resolve;
        });
        return new Response("ok");
      },
      onUnhealthy: async () => {},
    });

    monitor.start();
    monitor.stop();
    resolveFetch();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(50);

    expect(checks).toBe(1);
    vi.useRealTimers();
  });
});

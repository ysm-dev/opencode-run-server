import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import type { Endpoint } from "@opencode/client/service";
import { vi } from "vitest";
import type { HealthStatus } from "../src/compat/health.js";
import type { Ownership } from "../src/compat/ownership.js";
import { Supervisor } from "../src/compat/supervisor.js";
import { parseOptions } from "../src/config.js";

export const supervisorFixture = (options: object = {}) => {
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
  const health = vi.fn<() => Promise<HealthStatus>>(async () => "ok");
  const listening = vi.fn(async () => true);
  const owner = vi.fn<() => Promise<Ownership | undefined>>(
    async () => undefined,
  );
  const forget = vi.fn(async (_file: string, _pid: number) => {});
  const running = vi.fn((_pid: number) => true);
  const report = vi.fn();
  const config = parseOptions({
    bind: "127.0.0.1",
    healthCheck: { intervalMs: 10 },
    shutdownGraceMs: 10,
    restart: { baseDelayMs: 10, maxDelayMs: 20, maxRetries: 2, windowMs: 100 },
    ...options,
  });
  const deps = {
    discover,
    runtime,
    spawn,
    kill,
    health,
    listening,
    owner,
    forget,
    running,
  };
  return {
    child,
    ...deps,
    deps,
    report,
    supervisor: new Supervisor(config, "127.0.0.1", report, deps),
    config,
  };
};
export const ownershipRecord = (
  values: Partial<Ownership> = {},
): Ownership => ({
  pid: 4321,
  parentPid: process.pid,
  bind: "127.0.0.1",
  port: 4097,
  fingerprint: "other",
  startedAt: 0,
  ...values,
});

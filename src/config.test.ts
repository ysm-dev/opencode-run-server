import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { defaultLogFile, parseOptions } from "./config.js";

afterEach(() => vi.unstubAllEnvs());

it("provides v2 defaults and supports overrides", () => {
  expect(parseOptions({})).toEqual({
    legacyHttp: true,
    port: 4097,
    maxBodyBytes: 10_485_760,
    opencodePath: process.execPath,
    runtime: "auto",
    shutdownGraceMs: 2000,
    attach: {},
    healthCheck: { intervalMs: 5000, timeoutMs: 2000, failureThreshold: 3 },
    restart: {
      maxRetries: 10,
      baseDelayMs: 500,
      maxDelayMs: 30_000,
      windowMs: 60_000,
    },
    concurrency: 10,
    queueMax: 100,
    queueTtlMs: 0,
    runTimeoutMs: 1_800_000,
    maxInputBytes: 10_485_760,
    dangerouslySkipPermissions: false,
    log: { level: "info", maxFiles: 5, maxSize: "10m" },
  });
  expect(
    parseOptions({ concurrency: 2, log: { file: "/log", level: "error" } }),
  ).toMatchObject({
    concurrency: 2,
    log: { file: "/log", level: "error", maxFiles: 5 },
  });
});

it("accepts old listener options while rejecting invalid configuration", () => {
  expect(
    parseOptions({
      port: 1234,
      bind: "127.0.0.1",
      token: "old-token",
      runtime: "node",
      attach: { username: "user", password: "secret" },
      maxBodyBytes: 1000,
      restart: { maxRetries: 0 },
    }),
  ).toMatchObject({
    port: 1234,
    bind: "127.0.0.1",
    token: "old-token",
    runtime: "node",
    maxBodyBytes: 1000,
    restart: { maxRetries: 0 },
  });
  expect(() => parseOptions({ unexpected: true })).toThrow(
    "Invalid opencode-run-server options",
  );
  for (const value of [
    { concurrency: 0 },
    { queueMax: -1 },
    { runTimeoutMs: 2_147_483_648 },
    { log: { maxSize: "bad" } },
  ]) {
    expect(() => parseOptions(value)).toThrow();
  }
});

it("uses XDG state or the home state directory for logging", () => {
  vi.stubEnv("XDG_STATE_HOME", "/state");
  expect(defaultLogFile()).toBe("/state/opencode-run-server/server.log");
  vi.stubEnv("XDG_STATE_HOME", undefined);
  expect(defaultLogFile()).toBe(
    join(homedir(), ".local/state/opencode-run-server/server.log"),
  );
});

import { describe, expect, it } from "vitest";
import { createServerConfig } from "./config.js";
import type { StartedRun } from "./queue.js";
import { createRunServerApp } from "./server.js";

const config = async (overrides: object = {}) =>
  createServerConfig(overrides, {
    env: { XDG_STATE_HOME: "/tmp/state" },
    execPath: "/bin/opencode",
    discoverBind: async () => ({ host: "127.0.0.1", source: "loopback" }),
  });

describe("run-server HTTP API", () => {
  it("keeps /health unauthenticated while protecting /status", async () => {
    const app = createRunServerApp({
      config: await config({ token: "tok" }),
      mainServerUrl: "http://main/",
      packageVersion: "0.0.2",
      startRun: async () => ({ done: Promise.resolve() }),
    });

    expect((await app.fetch(new Request("http://x/health"))).status).toBe(200);
    const status = await app.fetch(new Request("http://x/status"));
    expect(status.status).toBe(401);
    expect(status.headers.get("WWW-Authenticate")).toBe("Bearer");
  });

  it("returns method errors for health and status non-GET methods", async () => {
    const app = createRunServerApp({
      config: await config(),
      mainServerUrl: "http://main/",
      packageVersion: "0.0.2",
      startRun: async () => ({ done: Promise.resolve() }),
    });

    expect(
      (await app.fetch(new Request("http://x/health", { method: "POST" })))
        .status,
    ).toBe(405);
    expect(
      (await app.fetch(new Request("http://x/status", { method: "POST" })))
        .status,
    ).toBe(405);
  });

  it("rejects invalid bearer tokens in constant-time auth path", async () => {
    const app = createRunServerApp({
      config: await config({ token: "tok" }),
      mainServerUrl: "http://main/",
      packageVersion: "0.0.2",
      startRun: async () => ({ done: Promise.resolve() }),
    });

    expect(
      (
        await app.fetch(
          new Request("http://x/status", {
            headers: { Authorization: "Bearer nope" },
          }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await app.fetch(
          new Request("http://x/status", {
            headers: { Authorization: "Basic nope" },
          }),
        )
      ).status,
    ).toBe(401);
  });

  it("applies bearer auth to POST /run", async () => {
    const app = createRunServerApp({
      config: await config({ token: "tok" }),
      mainServerUrl: "http://main/",
      packageVersion: "0.0.2",
      startRun: async () => ({ done: Promise.resolve() }),
    });

    expect((await app.fetch(runRequest("hello"))).status).toBe(401);
    expect(
      (await app.fetch(runRequest("hello", { Authorization: "Bearer tok" })))
        .status,
    ).toBe(202);
  });

  it("accepts a valid run and reports whether it was queued", async () => {
    const calls: string[][] = [];
    const app = createRunServerApp({
      config: await config(),
      mainServerUrl: "http://main/",
      packageVersion: "0.0.2",
      startRun: async (job): Promise<StartedRun> => {
        calls.push(job.argv);
        return { done: Promise.resolve() };
      },
    });

    const response = await app.fetch(
      new Request("http://x/run", {
        body: JSON.stringify({ dir: "/repo", prompt: "hello" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      status: "accepted",
      queued: false,
    });
    expect(calls[0]).toContain("--attach");
  });

  it("returns status with valid bearer auth and run counters", async () => {
    const done = Promise.resolve();
    const app = createRunServerApp({
      config: await config({ token: "tok" }),
      health: { healthy: false, lastCheckAt: 123 },
      mainServerUrl: "http://main/",
      packageVersion: "0.0.2",
      startRun: async () => ({ done }),
    });

    await app.fetch(runRequest("hello", { Authorization: "Bearer tok" }));
    const response = await app.fetch(
      new Request("http://x/status", {
        headers: { Authorization: "Bearer tok" },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      mainServer: { healthy: false, lastCheckAt: 123, url: "http://main/" },
      runs: { failed: 0, total: 1 },
      version: "0.0.2",
    });
  });
});

describe("run-server /run API", () => {
  it("returns queued true when all concurrency slots are busy", async () => {
    const never = new Promise<void>(() => {});
    const app = createRunServerApp({
      config: await config({ concurrency: 1, queueMax: 1 }),
      mainServerUrl: "http://main/",
      packageVersion: "0.0.2",
      startRun: async () => ({ done: never }),
    });

    expect(await (await app.fetch(runRequest())).json()).toMatchObject({
      queued: false,
    });
    expect(await (await app.fetch(runRequest("queued"))).json()).toMatchObject({
      queued: true,
    });
  });

  it("counts failed runs after accepted run completion rejects", async () => {
    const app = createRunServerApp({
      config: await config(),
      mainServerUrl: "http://main/",
      packageVersion: "0.0.2",
      startRun: async () => ({ done: Promise.reject(new Error("run failed")) }),
    });

    await app.fetch(runRequest());
    await Promise.resolve();
    const status = await app.fetch(new Request("http://x/status"));

    expect(await status.json()).toMatchObject({
      runs: { failed: 1, total: 1 },
    });
  });

  it("returns validation, media type, body size, and method errors", async () => {
    const app = createRunServerApp({
      config: await config({ maxBodyBytes: 5 }),
      mainServerUrl: "http://main/",
      packageVersion: "0.0.2",
      startRun: async () => ({ done: Promise.resolve() }),
    });

    expect(
      (await app.fetch(new Request("http://x/run", { method: "GET" }))).status,
    ).toBe(405);
    expect(
      (
        await app.fetch(
          new Request("http://x/run", { body: "{}", method: "POST" }),
        )
      ).status,
    ).toBe(415);
    expect(
      (
        await app.fetch(
          new Request("http://x/run", {
            body: JSON.stringify({ dir: "/repo", prompt: "toolong" }),
            headers: { "content-type": "application/json" },
            method: "POST",
          }),
        )
      ).status,
    ).toBe(413);

    const invalidJson = await app.fetch(
      new Request("http://x/run", {
        body: "{",
        headers: { "content-type": "application/json; charset=utf-8" },
        method: "POST",
      }),
    );
    expect(invalidJson.status).toBe(400);

    const contentLengthTooLarge = await app.fetch(
      new Request("http://x/run", {
        body: "{}",
        headers: { "content-length": "6", "content-type": "application/json" },
        method: "POST",
      }),
    );
    expect(contentLengthTooLarge.status).toBe(413);
  });

  it("returns validation and spawn failure errors", async () => {
    const errors: string[] = [];
    const app = createRunServerApp({
      config: await config(),
      logger: {
        error: async (_message, fields) => {
          errors.push(String(fields?.error));
        },
        info: async () => {},
        warn: async () => {},
      },
      mainServerUrl: "http://main/",
      packageVersion: "0.0.2",
      startRun: async () => {
        return Promise.reject("ENOENT");
      },
    });

    const validation = await app.fetch(
      new Request("http://x/run", {
        body: JSON.stringify({ dir: "/repo" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    const spawn = await app.fetch(runRequest());

    expect(validation.status).toBe(400);
    expect(spawn.status).toBe(500);
    expect(errors).toEqual(["ENOENT"]);
  });

  it("returns 503 and Retry-After when concurrency and queue are exhausted", async () => {
    const never = new Promise<void>(() => {});
    const app = createRunServerApp({
      config: await config({ concurrency: 1, queueMax: 0 }),
      mainServerUrl: "http://main/",
      packageVersion: "0.0.2",
      startRun: async () => ({ done: never }),
    });

    const first = await app.fetch(runRequest());
    const second = await app.fetch(runRequest());

    expect(first.status).toBe(202);
    expect(second.status).toBe(503);
    expect(second.headers.get("Retry-After")).toBe("1");
  });
});

const runRequest = (prompt = "hello", headers: Record<string, string> = {}) =>
  new Request("http://x/run", {
    body: JSON.stringify({ dir: "/repo", prompt }),
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
  });

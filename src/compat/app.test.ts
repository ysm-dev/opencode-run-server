import { afterEach, expect, it, vi } from "vitest";
import { parseOptions } from "../config.js";
import { RunQueue } from "../queue.js";
import { createLegacyApp } from "./app.js";
import { readBody } from "./http.js";

const queues: RunQueue[] = [];
afterEach(() => {
  for (const queue of queues.splice(0)) queue.stop();
});
const fixture = (options: object = {}) => {
  const config = parseOptions({
    bind: "127.0.0.1",
    concurrency: 1,
    queueMax: 1,
    ...options,
  });
  const queue = new RunQueue(config);
  queues.push(queue);
  const done = Promise.withResolvers<void>();
  const start = vi.fn(async () => ({ done: done.promise }));
  const error = vi.fn(async () => {});
  const warn = vi.fn(async () => {});
  const app = createLegacyApp({
    config,
    queue,
    bind: "127.0.0.1",
    mainServerUrl: "http://main:4096",
    version: "0.2.0",
    health: () => ({ healthy: true, lastCheckAt: 1 }),
    logger: { error, warn },
    start,
  });
  const post = (value: object, headers: Record<string, string> = {}) =>
    app.request("/run", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(value),
    });
  return { config, queue, done, start, error, warn, app, post };
};

it("preserves the original accepted response, status fields, and global queue", async () => {
  const f = fixture();
  const response = await f.post({
    dir: "/a",
    prompt: "one",
    thinking: true,
    continue: true,
    fork: true,
  });
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({
    requestId: expect.stringMatching(/^rq_[a-f0-9]{16}$/),
    queued: false,
    status: "accepted",
  });
  expect(f.start).toHaveBeenCalledWith(expect.any(String), {
    dir: "/a",
    prompt: "one",
    thinking: true,
    continue: true,
    fork: true,
  });
  expect(
    await (await f.post({ dir: "/b", command: "review" })).json(),
  ).toMatchObject({ queued: true });
  const full = await f.post({ dir: "/c", prompt: "three" });
  expect(full.status).toBe(503);
  expect(full.headers.get("retry-after")).toBe("1");
  expect(await full.json()).toMatchObject({
    code: "QUEUE_FULL",
    error: "queue full",
  });
  expect(await (await f.app.request("/status")).json()).toEqual({
    bind: { host: "127.0.0.1", port: 4097 },
    mainServer: { url: "http://main:4096", healthy: true, lastCheckAt: 1 },
    opencodePath: process.execPath,
    runs: {
      active: 1,
      queued: 1,
      concurrency: 1,
      queueMax: 1,
      total: 2,
      failed: 0,
    },
    uptimeMs: expect.any(Number),
    version: "0.2.0",
  });
  f.done.resolve();
});

it("keeps health public and enforces optional bearer auth on status and run", async () => {
  const f = fixture({ token: "secret" });
  expect((await f.app.request("/health")).status).toBe(200);
  for (const authorization of ["", "Basic secret", "Bearer incorrect"]) {
    const response = await f.post(
      { dir: "/a", prompt: "test" },
      { authorization },
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
  }
  expect((await f.app.request("/status")).status).toBe(401);
  expect(
    (
      await f.app.request("/status", {
        headers: { authorization: "Bearer secret" },
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await f.post(
        { dir: "/a", prompt: "test" },
        { authorization: "Bearer secret" },
      )
    ).status,
  ).toBe(202);
  f.done.resolve();
});

it("preserves method and validation errors including forbidden legacy flags", async () => {
  const f = fixture();
  for (const [path, method] of [
    ["/run", "GET"],
    ["/status", "POST"],
    ["/health", "DELETE"],
  ] as const) {
    const response = await f.app.request(path ?? "", { method });
    expect(response.status).toBe(405);
    expect(await response.json()).toMatchObject({ code: "METHOD_NOT_ALLOWED" });
  }
  for (const input of [
    { prompt: "missing dir" },
    { dir: "/a" },
    { dir: "/a", prompt: "test", fork: true },
    { dir: "/a", prompt: "test", attach: "elsewhere" },
    { dir: "/a", prompt: "test", title: "--flag" },
    {
      dir: "/a",
      prompt: "test",
      inlineFiles: [{ filename: "../a", content: "YQ==" }],
    },
  ]) {
    const response = await f.post(input);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "VALIDATION" });
  }
  expect(
    (await f.app.request("/run", { method: "POST", body: "{}" })).status,
  ).toBe(415);
  expect(
    (
      await f.app.request("/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      })
    ).status,
  ).toBe(400);
});

it("enforces actual streamed body size and content-length before admission", async () => {
  const f = fixture({ maxBodyBytes: 40 });
  expect((await f.post({ dir: "/a", prompt: "x".repeat(50) })).status).toBe(
    413,
  );
  expect((await f.post({}, { "content-length": "100" })).status).toBe(413);
  expect(f.start).not.toHaveBeenCalled();
  const empty = await readBody(
    new Request("http://test", {
      method: "POST",
      headers: { "content-type": "application/json" },
    }),
    40,
    "rq_test",
  );
  expect("response" in empty && empty.response.status).toBe(400);
  expect(
    (
      await f.post(
        { dir: "/a", prompt: "yes" },
        { "content-type": "Application/JSON; charset=utf-8" },
      )
    ).status,
  ).toBe(202);
  f.done.resolve();
});

it("reports synchronous startup errors as SPAWN_FAILED and counts later failures", async () => {
  const f = fixture();
  f.start.mockRejectedValueOnce(new Error("native unavailable"));
  const failed = await f.post({ dir: "/a", prompt: "test" });
  expect(failed.status).toBe(500);
  expect(await failed.json()).toMatchObject({
    code: "SPAWN_FAILED",
    error: "spawn failed",
  });
  expect(f.error).toHaveBeenCalled();
  await f.post({ dir: "/a", prompt: "test" });
  f.done.reject(new Error("model failed"));
  await vi.waitFor(async () =>
    expect(await (await f.app.request("/status")).json()).toMatchObject({
      runs: { failed: 1, active: 0 },
    }),
  );
});

it("reports expired jobs and queued startup failures", async () => {
  const f = fixture({ queueTtlMs: 10 });
  await f.post({ dir: "/a", prompt: "active" });
  await f.post({ dir: "/b", prompt: "expires" });
  await vi.waitFor(() =>
    expect(f.warn).toHaveBeenCalledWith(
      "queued run dropped",
      expect.anything(),
    ),
  );
  await f.post({ dir: "/b", prompt: "will fail" });
  f.start.mockRejectedValueOnce(new Error("queued startup failure"));
  f.done.resolve();
  await vi.waitFor(() =>
    expect(f.error).toHaveBeenCalledWith(
      "queued run startup failed",
      expect.objectContaining({ error: "Error: queued startup failure" }),
    ),
  );
  expect(await (await f.app.request("/status")).json()).toMatchObject({
    runs: { failed: 1, queued: 0 },
  });
});

it("retains legacy inline filename and base64 validation", async () => {
  const f = fixture();
  for (const file of [
    { filename: ".", content: "YQ==" },
    { filename: "..", content: "YQ==" },
    { filename: "-flag", content: "YQ==" },
    { filename: "a", content: "xx" },
    { filename: "a", content: "%%%%" },
  ]) {
    expect(
      (await f.post({ dir: "/a", prompt: "test", inlineFiles: [file] })).status,
    ).toBe(400);
  }
});

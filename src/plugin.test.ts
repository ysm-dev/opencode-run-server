import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { sessionInfo } from "../test/fixture.js";
import { formEvent, pluginFixture } from "../test/plugin-fixture.js";
import plugin, { setup } from "./plugin.js";

const fixtures: Awaited<ReturnType<typeof pluginFixture>>[] = [];
const fixture = async (options: Record<string, unknown> = {}) => {
  const f = await pluginFixture(options);
  fixtures.push(f);
  return f;
};
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.dispose()));
  vi.restoreAllMocks();
});

it("exposes a v2 definition and location-scoped RPC with queue backpressure", async () => {
  expect(plugin.id).toBe("opencode-run-server");
  expect(plugin.setup).toBe(setup);
  const f = await fixture({ concurrency: 1, queueMax: 1 });
  expect(await f.run({ prompt: "one" })).toMatchObject({
    status: "accepted",
    queued: false,
  });
  expect(await f.run({ prompt: "two" })).toMatchObject({ queued: true });
  await expect(f.run({ prompt: "three" })).rejects.toMatchObject({
    type: "queue_full",
    data: { retryAfterSeconds: 1 },
  });
  expect(await f.status()).toMatchObject({
    version: "0.2.0",
    location: { directory: "/project" },
    runs: { active: 1, queued: 1, total: 2 },
  });
  f.complete();
  await vi.waitFor(() =>
    expect(f.context.session.prompt).toHaveBeenCalledTimes(2),
  );
  f.complete("ses_2");
  await vi.waitFor(async () =>
    expect((await f.status()).runs).toMatchObject({ active: 0, completed: 2 }),
  );
  await f.cleanup();
  expect(await readFile(join(f.directory, "runs.log"), "utf8")).toContain(
    "run finished",
  );
  expect(f.events.returned).toHaveBeenCalled();
});

it("rejects oversized input and aborted calls before creating a session", async () => {
  const f = await fixture({ maxInputBytes: 20 });
  await expect(f.run({ prompt: "long".repeat(20) })).rejects.toMatchObject({
    type: "input_too_large",
  });
  await expect(
    f.run({ prompt: "ok" }, AbortSignal.abort(new Error("cancelled"))),
  ).rejects.toThrow("cancelled");
  expect(f.context.session.create).not.toHaveBeenCalled();
});

it("does not tie accepted runs to the caller's request lifetime", async () => {
  const f = await fixture();
  const call = new AbortController();
  await f.run({ prompt: "test" }, call.signal);
  call.abort();
  expect(f.context.session.interrupt).not.toHaveBeenCalled();
  f.complete();
  await vi.waitFor(async () =>
    expect((await f.status()).runs.completed).toBe(1),
  );
});

it("reports immediate and queued admission failures", async () => {
  const f = await fixture({ concurrency: 1 });
  await expect(
    f.run({ prompt: "bad", session: "ses_missing" }),
  ).rejects.toMatchObject({ type: "start_failed" });
  await f.run({ prompt: "first" });
  await f.run({ prompt: "bad", session: "ses_missing" });
  f.complete();
  await vi.waitFor(async () => expect((await f.status()).runs.failed).toBe(2));
  await f.cleanup();
  expect(await readFile(join(f.directory, "runs.log"), "utf8")).toContain(
    "queued run failed to start",
  );
});

it("accounts for TTL expiry and unload drops and interrupts active runs", async () => {
  const f = await fixture({ concurrency: 1, queueTtlMs: 10 });
  await f.run({ prompt: "first" });
  await f.run({ prompt: "expires" });
  await vi.waitFor(async () => expect((await f.status()).runs.dropped).toBe(1));
  await f.run({ prompt: "discard" });
  await f.cleanup();
  expect((await f.status()).runs).toMatchObject({
    active: 0,
    queued: 0,
    dropped: 2,
    failed: 1,
  });
  expect(f.context.session.interrupt).toHaveBeenCalledWith({
    sessionID: "ses_1",
    continue: false,
  });
});

it("rejects interactive asks by default without changing configured allows or denials", async () => {
  const f = await fixture();
  await f.run({ prompt: "test" });
  expect((await f.permission("ses_1", "allow")).effect).toBe("allow");
  expect((await f.permission("ses_1", "deny")).effect).toBe("deny");
  expect((await f.permission("ses_1")).effect).toBe("deny");
  await vi.waitFor(() =>
    expect(f.context.session.interrupt).toHaveBeenCalled(),
  );
  await vi.waitFor(async () => expect((await f.status()).runs.failed).toBe(1));
});

it("auto-allows only managed sessions and descendants, with per-request overrides", async () => {
  const f = await fixture({ dangerouslySkipPermissions: true });
  await f.run({ prompt: "test" });
  f.sessions.set("ses_child", sessionInfo("ses_child", { parentID: "ses_1" }));
  f.sessions.set("ses_other", sessionInfo("ses_other"));
  expect((await f.permission("ses_child")).effect).toBe("allow");
  expect((await f.permission("ses_other")).effect).toBe("ask");
  expect((await f.permission("ses_child", "deny")).effect).toBe("deny");
  f.complete();
  await vi.waitFor(async () => expect((await f.status()).runs.active).toBe(0));
  await f.run({
    prompt: "deny",
    session: "ses_1",
    dangerouslySkipPermissions: false,
  });
  expect((await f.permission("ses_1")).effect).toBe("deny");
});

it("interrupts managed forms while ignoring unrelated events and global forms", async () => {
  const f = await fixture();
  await f.run({ prompt: "test" });
  f.sessions.set("ses_other", sessionInfo("ses_other"));
  f.events.push({ id: "evt_connected", type: "server.connected", data: {} });
  f.events.push(formEvent("global"));
  f.events.push(formEvent("ses_other"));
  f.events.push(formEvent("ses_1"));
  await vi.waitFor(() =>
    expect(f.context.session.interrupt).toHaveBeenCalledTimes(1),
  );
  expect((await f.status()).runs.failed).toBe(1);
});

it.each([
  "failure",
  "closed",
])("stops admission if the event stream is %s", async (kind) => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const f = await fixture();
  await f.run({ prompt: "test" });
  if (kind === "failure") f.events.fail(new Error("stream failed"));
  else await f.events.return();
  await vi.waitFor(() => expect(log).toHaveBeenCalled());
  await expect(f.run({ prompt: "late" })).rejects.toMatchObject({
    type: "queue_full",
  });
  await vi.waitFor(() =>
    expect(f.context.session.interrupt).toHaveBeenCalled(),
  );
});

it("cleans up setup resources if RPC registration fails", async () => {
  const f = await fixture();
  await f.cleanup();
  const register = vi.fn().mockRejectedValue(new Error("registration failed"));
  await expect(setup({ ...f.ctx, rpc: { register } })).rejects.toThrow(
    "registration failed",
  );
  expect(f.events.returned).toHaveBeenCalled();
});

it("keeps admission working when file logging fails", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const f = await fixture({ log: { file: "/dev/null/runs.log" } });
  await f.run({ prompt: "test" });
  f.complete();
  await vi.waitFor(() => expect(log).toHaveBeenCalled());
  await f.cleanup();
});

it("stops queued work immediately on a native shutdown event", async () => {
  const f = await fixture({ concurrency: 1 });
  await f.run({ prompt: "running" });
  await f.run({ prompt: "queued" });
  f.events.push({
    id: "evt_shutdown",
    created: 0,
    type: "session.execution.interrupted",
    durable: { aggregateID: "ses_1", seq: 1, version: 1 },
    data: { sessionID: "ses_1", reason: "shutdown" },
  });
  await vi.waitFor(async () =>
    expect((await f.status()).runs).toMatchObject({
      dropped: 1,
      failed: 1,
      active: 0,
    }),
  );
  expect(f.context.session.create).toHaveBeenCalledTimes(1);
});

it("tracks prompts admitted by a native command through the prompt hook", async () => {
  const f = await fixture();
  f.context.session.command.mockImplementation(async ({ sessionID }) => {
    await f.prompt(sessionID, "msg_command");
  });
  await f.run({ command: "fixture" });
  expect(f.context.session.wait).not.toHaveBeenCalled();
  f.events.push({
    id: "evt_command",
    created: 0,
    type: "session.inbox.delivered",
    durable: { aggregateID: "ses_1", seq: 1, version: 1 },
    data: { sessionID: "ses_1", inboxID: "msg_command" },
  });
  await vi.waitFor(() => expect(f.context.session.wait).toHaveBeenCalled());
  f.complete();
  await vi.waitFor(async () =>
    expect((await f.status()).runs.completed).toBe(1),
  );
});

it("starts and releases the legacy listener when compatibility is enabled", async () => {
  const compatibility = await import("./compat/supervisor.js");
  const released = vi.fn(async () => {});
  const acquire = vi
    .spyOn(compatibility, "acquireCompatibility")
    .mockImplementation(async (_config, report) => {
      report("legacy listener ready");
      return released;
    });
  const f = await fixture({
    legacyHttp: true,
    bind: "127.0.0.1",
    token: "secret",
    attach: { password: "password" },
  });
  expect(acquire).toHaveBeenCalledWith(
    expect.objectContaining({ legacyHttp: true, token: "secret" }),
    expect.any(Function),
  );
  await f.cleanup();
  expect(released).toHaveBeenCalled();
});

it("does not stop the RPC queue when an unrelated legacy session is interrupted", async () => {
  const f = await fixture();
  f.sessions.set("ses_legacy", sessionInfo("ses_legacy"));
  await f.run({ prompt: "rpc run" });
  f.events.push({
    id: "evt_legacy",
    created: 0,
    type: "session.execution.interrupted",
    durable: { aggregateID: "ses_legacy", seq: 1, version: 1 },
    data: { sessionID: "ses_legacy", reason: "shutdown" },
  });
  await f.run({ prompt: "another RPC run" });
  f.complete("ses_2");
  f.complete("ses_3");
  await vi.waitFor(async () =>
    expect((await f.status()).runs.completed).toBe(2),
  );
});

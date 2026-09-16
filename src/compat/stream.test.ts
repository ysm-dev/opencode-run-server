import { afterEach, expect, it, vi } from "vitest";
import { legacyFixture } from "../../test/legacy-fixture.js";

const fixtures: ReturnType<typeof legacyFixture>[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.backend.dispose()));
});
const fixture = async (options: object = {}) => {
  const f = legacyFixture(options);
  fixtures.push(f);
  await f.backend.connect();
  return f;
};

it.each([
  "closed",
  "failed",
])("signals unavailability once reconnecting keeps failing after it %s", async (kind) => {
  const f = await fixture({
    restart: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1 },
  });
  f.offline();
  if (kind === "closed") await f.events.return();
  else f.events.fail(new Error("network failure"));
  await vi.waitFor(() => expect(f.unavailable).toHaveBeenCalledOnce());
  expect(f.logger.warn).toHaveBeenCalledWith(
    "OpenCode event stream interrupted",
    expect.objectContaining({ error: expect.stringContaining("") }),
  );
  expect(f.logger.error).toHaveBeenCalledWith(
    "OpenCode event stream failed",
    expect.objectContaining({ attempts: 2 }),
  );
});

it("reconnects a dropped stream and resyncs admissions for active runs", async () => {
  const f = await fixture({ restart: { baseDelayMs: 1 } });
  f.admissions.clear();
  // The command run admits nothing, so only the prompt run needs a resync.
  f.inbox.mockResolvedValueOnce([]).mockResolvedValue([
    {
      id: "msg_queued",
      type: "user",
      timeCreated: 0,
      sessionID: "ses_1",
      payload: { text: "test" },
      delivery: "steer",
    },
  ]);
  const run = await f.backend.start("rq", { dir: "/project", prompt: "test" });
  const command = await f.backend.start("cmd", {
    dir: "/project",
    command: "review",
  });
  // The delivery event is lost while the stream is down.
  f.events.fail(new Error("network failure"));
  await vi.waitFor(() => expect(f.streams.length).toBe(2));
  expect(f.logger.info).toHaveBeenCalledWith(
    "OpenCode event stream reconnected",
    { attempts: 1 },
  );
  expect(f.inbox).toHaveBeenCalledWith({ sessionID: "ses_1" });
  expect(f.inbox).not.toHaveBeenCalledWith({ sessionID: "ses_2" });
  expect(f.unavailable).not.toHaveBeenCalled();
  f.complete();
  f.complete("ses_2");
  await run.done;
  await command.done;
  expect(f.logger.info).toHaveBeenCalledWith(
    "run finished",
    expect.objectContaining({ requestId: "rq", error: "" }),
  );
});

it("keeps serving when a reconnect attempt and an event handler fail", async () => {
  const f = await fixture({
    restart: { baseDelayMs: 5, maxDelayMs: 10, maxRetries: 50 },
  });
  f.admissions.clear();
  f.inbox.mockRejectedValueOnce(new Error("inbox unavailable"));
  f.reply.mockRejectedValueOnce(new Error("reply failed"));
  const run = await f.backend.start("rq", { dir: "/project", prompt: "test" });
  const stopped = expect(run.done).rejects.toThrow("Plugin unloaded");
  f.offline();
  f.events.fail(new Error("network failure"));
  await vi.waitFor(() =>
    expect(f.logger.warn).toHaveBeenCalledWith(
      "OpenCode event stream reconnect failed",
      expect.objectContaining({
        error: expect.stringContaining("closed during startup"),
      }),
    ),
  );
  f.offline(false);
  await vi.waitFor(() =>
    expect(f.logger.warn).toHaveBeenCalledWith(
      "OpenCode admission resync failed",
      expect.objectContaining({ error: expect.stringContaining("inbox") }),
    ),
  );
  f.events.push({
    id: "evt_ask",
    created: 0,
    type: "permission.asked",
    data: { id: "per_1", sessionID: "ses_1", action: "edit", resources: ["*"] },
  });
  await vi.waitFor(() =>
    expect(f.logger.error).toHaveBeenCalledWith(
      "OpenCode event handling failed",
      expect.objectContaining({ error: expect.stringContaining("reply") }),
    ),
  );
  expect(f.unavailable).not.toHaveBeenCalled();
  await f.backend.dispose();
  await stopped;
});

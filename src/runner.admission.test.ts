import { afterEach, expect, it, vi } from "vitest";
import { runFixture } from "../test/fixture.js";
import { parseOptions } from "./config.js";
import { RunManager } from "./runner.js";

const managers: RunManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  vi.useRealTimers();
});
const fixture = () => {
  const f = runFixture();
  const report = vi.fn();
  const manager = new RunManager(f.context, parseOptions({}), report);
  managers.push(manager);
  const messageID = () => {
    const id = f.context.session.prompt.mock.calls[0]?.[0].id;
    if (id === undefined || id === null)
      throw new Error("Prompt was not submitted");
    return id;
  };
  return {
    ...f,
    manager,
    report,
    messageID,
    deliver(sessionID = "ses_1", inboxID = messageID()) {
      manager.observe({
        id: "evt_delivery",
        created: 0,
        type: "session.inbox.delivered",
        durable: { aggregateID: sessionID, seq: 1, version: 1 },
        data: { sessionID, inboxID },
      });
    },
  };
};

it("waits for its own durable input delivery before checking for idle", async () => {
  const f = fixture();
  const run = await f.manager.start("rq", { prompt: "test" });
  f.manager.admitting("ses_unmanaged", "msg_other");
  f.manager.admitting("ses_1", f.messageID());
  f.deliver("ses_other", "msg_other");
  f.deliver("ses_1", "msg_other");
  await Promise.resolve();
  expect(f.context.session.wait).not.toHaveBeenCalled();
  f.deliver();
  await vi.waitFor(() => expect(f.context.session.wait).toHaveBeenCalled());
  f.complete();
  await run.done;
  expect(f.report).toHaveBeenCalledWith({
    requestId: "rq",
    sessionID: "ses_1",
  });
});

it("records failures before delivery without wedging the queue", async () => {
  const f = fixture();
  const run = await f.manager.start("rq", { prompt: "test" });
  const failure = (sessionID: string) =>
    f.manager.observe({
      id: "evt_failure",
      created: 0,
      type: "session.execution.failed",
      durable: { aggregateID: sessionID, seq: 1, version: 1 },
      data: {
        sessionID,
        error: { type: "unknown", message: "Model unavailable" },
      },
    });
  failure("ses_other");
  expect(f.report).not.toHaveBeenCalled();
  failure("ses_1");
  await run.done;
  expect(f.report).toHaveBeenCalledWith(
    expect.objectContaining({ error: "Model unavailable" }),
  );
  expect(f.context.session.wait).not.toHaveBeenCalled();
});

it("records external interruption before input delivery", async () => {
  const f = fixture();
  const run = await f.manager.start("rq", { prompt: "test" });
  f.manager.observe({
    id: "evt_interrupt",
    created: 0,
    type: "session.execution.interrupted",
    durable: { aggregateID: "ses_1", seq: 1, version: 1 },
    data: { sessionID: "ses_1", reason: "user" },
  });
  await run.done;
  expect(f.report).toHaveBeenCalledWith(
    expect.objectContaining({ error: "Session interrupted: user" }),
  );
});

it("does not mistake an idle wait without a terminal outcome for success", async () => {
  const f = fixture();
  const run = await f.manager.start("rq", { prompt: "test" });
  f.deliver();
  await vi.waitFor(() => expect(f.context.session.wait).toHaveBeenCalled());
  f.waits.get("ses_1")?.resolve();
  await run.done;
  expect(f.report).toHaveBeenCalledWith(
    expect.objectContaining({
      error: "Session ended without a successful outcome",
    }),
  );
});

it("interrupts on timeout even when the v2 adapter ignores the wait signal", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const waiting = Promise.withResolvers<void>();
  f.context.session.wait.mockImplementation(async () => waiting.promise);
  f.context.session.interrupt.mockImplementation(async () => {
    waiting.resolve();
    return { interrupted: true };
  });
  const run = await f.manager.start("rq", { prompt: "test", timeoutMs: 10 });
  f.deliver();
  await vi.advanceTimersByTimeAsync(11);
  await run.done;
  expect(f.context.session.interrupt).toHaveBeenCalledTimes(1);
  expect(f.report).toHaveBeenCalledWith(
    expect.objectContaining({ error: "Run timed out" }),
  );
});

it("interrupts again if durable admission finishes after cancellation", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const response =
    Promise.withResolvers<
      Awaited<ReturnType<typeof f.context.session.prompt>>
    >();
  f.context.session.prompt.mockReturnValue(response.promise);
  const start = f.manager.start("rq", { prompt: "test", timeoutMs: 10 });
  const rejected = expect(start).rejects.toThrow("Run timed out");
  await vi.advanceTimersByTimeAsync(11);
  expect(f.context.session.interrupt).toHaveBeenCalledTimes(1);
  response.resolve({
    id: "msg_late",
    sessionID: "ses_1",
    time: { created: 0 },
    type: "user",
    payload: { text: "test" },
    delivery: "steer",
  });
  await rejected;
  await f.manager.dispose();
  expect(f.context.session.interrupt).toHaveBeenCalledTimes(2);
});

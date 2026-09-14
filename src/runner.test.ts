import { afterEach, describe, expect, it, vi } from "vitest";
import { runFixture, sessionInfo } from "../test/fixture.js";
import { parseOptions } from "./config.js";
import { RunManager } from "./runner.js";

const managers: RunManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  vi.useRealTimers();
});

const fixture = (options: object = {}) => {
  const state = runFixture();
  const report = vi.fn();
  const manager = new RunManager(state.context, parseOptions(options), report);
  state.admissions.add((sessionID, inboxID) =>
    manager.observe({
      id: "evt_delivered",
      created: 0,
      type: "session.inbox.delivered",
      durable: { aggregateID: sessionID, seq: 1, version: 1 },
      data: { sessionID, inboxID },
    }),
  );
  managers.push(manager);
  return { ...state, manager, report };
};

describe("native session runs", () => {
  it("admits a configured prompt and holds capacity until session completion", async () => {
    const f = fixture();
    const run = await f.manager.start("rq_1", {
      prompt: "review",
      model: "provider/model#high",
      agent: "build",
      title: "Review",
      files: ["a.txt"],
      inlineFiles: [{ filename: "b.txt", content: "YQ==" }],
    });
    expect(f.context.session.create).toHaveBeenCalledWith({
      location: { directory: "/project" },
    });
    expect(f.context.session.switchModel).toHaveBeenCalledWith(
      {
        sessionID: "ses_1",
        model: { providerID: "provider", id: "model", variant: "high" },
      },
      expect.anything(),
    );
    expect(f.context.session.switchAgent).toHaveBeenCalledWith(
      { sessionID: "ses_1", agent: "build" },
      expect.anything(),
    );
    expect(f.context.session.rename).toHaveBeenCalledWith(
      { sessionID: "ses_1", title: "Review" },
      expect.anything(),
    );
    expect(f.context.session.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "review",
        delivery: "steer",
        files: expect.any(Array),
      }),
      expect.anything(),
    );
    expect(f.report).not.toHaveBeenCalled();
    f.complete();
    await run.done;
    expect(f.report).toHaveBeenCalledWith({
      requestId: "rq_1",
      sessionID: "ses_1",
    });
  });

  it("executes a command without requiring prompt text", async () => {
    const f = fixture();
    const run = await f.manager.start("rq", { command: "review" });
    expect(f.context.session.command).toHaveBeenCalledWith(
      {
        sessionID: "ses_1",
        command: "review",
        text: "",
        files: [],
        delivery: "steer",
      },
      expect.anything(),
    );
    expect(f.context.session.prompt).not.toHaveBeenCalled();
    f.complete();
    await run.done;
  });

  it("reuses sessions and applies variants to their current model", async () => {
    const f = fixture();
    f.sessions.set(
      "ses_existing",
      sessionInfo("ses_existing", { model: { providerID: "p", id: "m" } }),
    );
    const run = await f.manager.start("rq", {
      prompt: "next",
      session: "ses_existing",
      variant: "low",
    });
    expect(f.context.session.create).not.toHaveBeenCalled();
    expect(f.context.session.switchModel).toHaveBeenCalledWith(
      {
        sessionID: "ses_existing",
        model: { providerID: "p", id: "m", variant: "low" },
      },
      expect.anything(),
    );
    f.complete("ses_existing");
    await run.done;
  });

  it("reports startup failures and rejects variants without any model", async () => {
    const f = fixture();
    await expect(
      f.manager.start("rq", { prompt: "test", variant: "high" }),
    ).rejects.toThrow("before selecting a model");
    expect(f.report).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining("before selecting"),
      }),
    );
    await expect(
      f.manager.start("missing", { prompt: "test", session: "ses_missing" }),
    ).rejects.toThrow("Session not found");
  });

  it("rejects a different location and simultaneous managed use of a session", async () => {
    const f = fixture();
    f.sessions.set(
      "ses_other",
      sessionInfo("ses_other", { location: { directory: "/other" } }),
    );
    await expect(
      f.manager.start("other", { prompt: "test", session: "ses_other" }),
    ).rejects.toThrow("different RPC location");
    f.sessions.set("ses_one", sessionInfo("ses_one"));
    const run = await f.manager.start("one", {
      prompt: "test",
      session: "ses_one",
    });
    await expect(
      f.manager.start("two", { prompt: "test", session: "ses_one" }),
    ).rejects.toThrow("already has a managed run");
    expect(f.context.session.interrupt).not.toHaveBeenCalled();
    f.complete("ses_one");
    await run.done;
  });
});

describe("native run lifecycle", () => {
  it.each([
    "failed",
    "interrupted",
  ] as const)("counts a %s session as failure", async (outcome) => {
    const f = fixture();
    const run = await f.manager.start("rq", { prompt: "test" });
    f.complete("ses_1", outcome);
    await run.done;
    expect(f.report).toHaveBeenCalledWith(
      expect.objectContaining({ error: `Session ${outcome}` }),
    );
  });

  it("times out active runs by interrupting the actual session", async () => {
    vi.useFakeTimers();
    const f = fixture({ runTimeoutMs: 5000 });
    const run = await f.manager.start("rq", { prompt: "test", timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(11);
    await run.done;
    expect(f.context.session.interrupt).toHaveBeenCalledWith({
      sessionID: "ses_1",
      continue: false,
    });
    expect(f.report).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Run timed out" }),
    );
  });

  it("shuts down runs, rejects new work and cleans up late session creation", async () => {
    const f = fixture();
    const created = Promise.withResolvers<ReturnType<typeof sessionInfo>>();
    f.context.session.create.mockReturnValueOnce(created.promise);
    const start = f.manager.start("rq", { prompt: "test" });
    const rejected = expect(start).rejects.toThrow("Plugin unloaded");
    const stopped = f.manager.dispose();
    created.resolve(sessionInfo("ses_late"));
    await rejected;
    await stopped;
    expect(f.context.session.prompt).not.toHaveBeenCalled();
    expect(f.context.session.interrupt).toHaveBeenCalledWith({
      sessionID: "ses_late",
      continue: false,
    });
    await expect(f.manager.start("later", { prompt: "test" })).rejects.toThrow(
      "shutting down",
    );
  });

  it("finds managed roots for descendant sessions but leaves unrelated sessions alone", async () => {
    const f = fixture();
    expect(await f.manager.owner("ses_missing")).toBeUndefined();
    const run = await f.manager.start("rq", { prompt: "test" });
    f.sessions.set(
      "ses_child",
      sessionInfo("ses_child", { parentID: "ses_1" }),
    );
    f.sessions.set("ses_unrelated", sessionInfo("ses_unrelated"));
    f.sessions.set(
      "ses_cycle",
      sessionInfo("ses_cycle", { parentID: "ses_cycle" }),
    );
    expect((await f.manager.owner("ses_child"))?.requestId).toBe("rq");
    expect(await f.manager.owner("ses_unrelated")).toBeUndefined();
    expect(await f.manager.owner("ses_cycle")).toBeUndefined();
    f.complete();
    await run.done;
  });

  it("preserves workspace placement and cancels a run only once", async () => {
    const f = fixture();
    Object.assign(f.context.location, { workspaceID: "wrk_test" });
    const run = await f.manager.start("rq", { prompt: "test" });
    expect(f.context.session.create).toHaveBeenCalledWith({
      location: { directory: "/project", workspaceID: "wrk_test" },
    });
    const owned = await f.manager.owner("ses_1");
    expect(owned).toBeDefined();
    if (owned === undefined) throw new Error("Managed run missing");
    f.manager.cancel(owned, "First cancellation");
    f.manager.cancel(owned, "Second cancellation");
    await run.done;
    expect(f.report).toHaveBeenCalledWith(
      expect.objectContaining({ error: "First cancellation" }),
    );
    expect(f.context.session.interrupt).toHaveBeenCalledTimes(1);
  });

  it("normalizes non-Error admission failures", async () => {
    const f = fixture();
    f.context.session.prompt.mockRejectedValueOnce("rejected");
    await expect(f.manager.start("rq", { prompt: "test" })).rejects.toBe(
      "rejected",
    );
    expect(f.report).toHaveBeenCalledWith(
      expect.objectContaining({ error: "rejected" }),
    );
  });
});

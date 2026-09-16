import { afterEach, expect, it, vi } from "vitest";
import { sessionInfo } from "../../test/fixture.js";
import { legacyFixture } from "../../test/legacy-fixture.js";
import { formEvent } from "../../test/plugin-fixture.js";
import { selectSession } from "./selection.js";

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

it("executes old requests using native sessions and canonicalizes legacy uploads", async () => {
  const f = await fixture();
  const run = await f.backend.start("rq", {
    dir: "/project",
    prompt: "test",
    thinking: true,
    files: ["note.txt"],
    inlineFiles: [{ filename: "a", content: "YR==" }],
  });
  expect(f.context.session.prompt).toHaveBeenCalledWith(
    expect.objectContaining({
      files: [
        { uri: "file:///project/note.txt", name: "note.txt" },
        { uri: "data:application/octet-stream;base64,YQ==", name: "a" },
      ],
    }),
    expect.anything(),
  );
  f.complete();
  await run.done;
  expect(f.logger.info).toHaveBeenCalledWith(
    "run finished",
    expect.objectContaining({ requestId: "rq", sessionId: "ses_1", error: "" }),
  );
});

it("preserves explicit, continue, pagination, and fork selection", async () => {
  const f = await fixture();
  f.sessions.set("ses_existing", sessionInfo("ses_existing"));
  f.list
    .mockResolvedValueOnce({
      data: [sessionInfo("ses_other", { location: { directory: "/other" } })],
      cursor: { next: "page2" },
    })
    .mockResolvedValueOnce({ data: [sessionInfo("ses_existing")], cursor: {} });
  const signal = new AbortController().signal;
  expect(
    (
      await selectSession(
        f.client,
        { dir: "/project", continue: true, prompt: "test" },
        "/project",
        signal,
      )
    ).id,
  ).toBe("ses_existing");
  expect(f.list).toHaveBeenLastCalledWith(
    expect.objectContaining({ cursor: "page2", parentID: null }),
    { signal },
  );
  const fork = await selectSession(
    f.client,
    {
      dir: "/project",
      session: "ses_existing",
      continue: true,
      fork: true,
      prompt: "test",
    },
    "/project",
    signal,
  );
  expect(fork.parentID).toBe("ses_existing");
  expect(f.fork).toHaveBeenCalledWith(
    { sessionID: "ses_existing", boundary: { type: "through" } },
    { signal },
  );
  f.list.mockResolvedValue({ data: [], cursor: {} });
  expect(
    (
      await selectSession(
        f.client,
        { dir: "/project", continue: true, prompt: "new" },
        "/project",
        signal,
      )
    ).id,
  ).not.toBe("ses_existing");
});

it("reports admission and execution failures and disposes active jobs", async () => {
  const f = await fixture();
  f.context.session.prompt.mockRejectedValueOnce(new Error("admission failed"));
  await expect(
    f.backend.start("first", { dir: "/project", prompt: "test" }),
  ).rejects.toThrow("admission failed");
  const run = await f.backend.start("second", {
    dir: "/project",
    prompt: "test",
  });
  const failed = expect(run.done).rejects.toThrow("Session failed");
  f.complete("ses_2", "failed");
  await failed;
  const active = await f.backend.start("third", {
    dir: "/project",
    prompt: "test",
  });
  const stopped = expect(active.done).rejects.toThrow("Plugin unloaded");
  await f.backend.dispose();
  await stopped;
  await expect(
    f.backend.start("late", { dir: "/project", prompt: "test" }),
  ).rejects.toThrow();
});

it("rejects permission asks by default and supports per-request auto-approval", async () => {
  const f = await fixture();
  f.sessions.set("ses_unrelated", sessionInfo("ses_unrelated"));
  const run = await f.backend.start("rq", { dir: "/project", prompt: "test" });
  const failed = expect(run.done).rejects.toThrow(
    "Permission requires interactive",
  );
  const asked = (sessionID: string) =>
    f.events.push({
      id: "evt_ask",
      created: 0,
      type: "permission.asked",
      data: { id: "per_1", sessionID, action: "edit", resources: ["*"] },
    });
  asked("ses_unrelated");
  asked("ses_2");
  await failed;
  expect(f.reply).toHaveBeenCalledWith({
    sessionID: "ses_2",
    requestID: "per_1",
    reply: "reject",
  });
  const allowed = await f.backend.start("auto", {
    dir: "/project",
    prompt: "test",
    dangerouslySkipPermissions: true,
  });
  asked("ses_3");
  await vi.waitFor(() =>
    expect(f.reply).toHaveBeenLastCalledWith(
      expect.objectContaining({ reply: "once" }),
    ),
  );
  f.complete("ses_3");
  await allowed.done;
});

it("cancels owned forms while leaving unrelated and global forms alone", async () => {
  const f = await fixture();
  f.sessions.set("ses_other", sessionInfo("ses_other"));
  const run = await f.backend.start("rq", { dir: "/project", prompt: "test" });
  const failed = expect(run.done).rejects.toThrow("Interactive form");
  f.events.push(formEvent("global"));
  f.events.push(formEvent("ses_other"));
  f.events.push(formEvent("ses_2"));
  await failed;
  expect(f.cancelForm).toHaveBeenCalledTimes(1);
  expect(f.cancelForm).toHaveBeenCalledWith({
    sessionID: "ses_2",
    formID: "form_1",
  });
});

it("reconciles command admissions from native inbox and projected history", async () => {
  const f = await fixture();
  const user = (id: string) => ({
    id,
    type: "user" as const,
    time: { created: 0 },
    text: "test",
  });
  f.contextMessages
    .mockResolvedValueOnce([user("msg_old")])
    .mockResolvedValue([
      user("msg_old"),
      user("msg_new"),
      { id: "msg_sys", type: "synthetic", time: { created: 0 }, text: "test" },
    ]);
  f.inbox.mockResolvedValue([
    {
      id: "msg_new",
      type: "user",
      timeCreated: 0,
      sessionID: "ses_1",
      payload: { text: "test" },
      delivery: "steer",
    },
    {
      id: "msg_synthetic",
      type: "synthetic",
      timeCreated: 0,
      sessionID: "ses_1",
      payload: { text: "test" },
      delivery: "steer",
    },
  ]);
  const run = await f.backend.start("rq", {
    dir: "/project",
    command: "review",
    prompt: "args",
  });
  await vi.waitFor(() => expect(f.context.session.wait).toHaveBeenCalled());
  expect(f.context.session.command).toHaveBeenCalledWith(
    expect.objectContaining({ command: "review", text: "args" }),
    expect.anything(),
  );
  f.complete();
  await run.done;
});

it("fails startup on an empty event stream", async () => {
  const f = legacyFixture();
  fixtures.push(f);
  await f.events.next();
  await f.events.return();
  await expect(f.backend.connect()).rejects.toThrow("closed during startup");
});

it("resolves a variant against the requested location's default model", async () => {
  const f = await fixture();
  await expect(
    f.backend.start("rq", { dir: "/project", prompt: "test", variant: "high" }),
  ).rejects.toThrow("before selecting a model");
  expect(f.context.catalog.model.default).toHaveBeenCalledWith({
    location: { directory: "/project", workspace: undefined },
  });
});

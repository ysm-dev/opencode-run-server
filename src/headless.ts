import type { Plugin } from "@opencode/plugin";
import type { PluginEvent, RunManager } from "./runner.js";

export const registerHeadless = async (
  ctx: {
    permission: Pick<Plugin.Context["permission"], "hook">;
    session: Pick<Plugin.Context["session"], "hook">;
    event: Plugin.Context["event"];
  },
  manager: RunManager,
  signal: AbortSignal,
  stop: (error?: unknown) => void,
) => {
  await ctx.session.hook("prompt", (event) =>
    manager.admitting(event.sessionID, event.messageID),
  );
  await ctx.permission.hook("evaluate", async (event) => {
    const run = await manager.owner(event.sessionID);
    if (run === undefined || event.effect !== "ask") return;
    const allow =
      run.request.dangerouslySkipPermissions ??
      manager.config.dangerouslySkipPermissions;
    event.effect = allow ? "allow" : "deny";
    if (!allow) {
      event.message = "Permission requires interactive input in a headless run";
      manager.cancel(run, event.message);
    }
  });
  const iterator = ctx.event.subscribe({ signal })[Symbol.asyncIterator]();
  // The in-process plugin stream has no initial server.connected event.
  const handle = async (event: PluginEvent) => {
    if (
      event.type === "session.execution.interrupted" &&
      event.data.reason === "shutdown"
    ) {
      const run = await manager.owner(event.data.sessionID);
      if (run !== undefined && run.cancelled === undefined) stop();
    }
    manager.observe(event);
    if (event.type !== "form.created") return;
    if (event.data.form.sessionID === "global") return;
    const run = await manager.owner(event.data.form.sessionID);
    if (run !== undefined)
      manager.cancel(run, "Interactive form requested in a headless run");
  };
  const task = (async () => {
    while (!signal.aborted) {
      const next = await iterator.next();
      if (next.done) {
        if (!signal.aborted) throw new Error("Headless event stream closed");
        break;
      }
      await handle(next.value);
    }
  })().catch((error: unknown) => {
    if (!signal.aborted) stop(error);
  });
  return async () => {
    await task;
    await iterator.return?.();
  };
};

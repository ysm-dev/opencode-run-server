import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { RunManager, type SpawnedRunProcess } from "./runner.js";

class FakeChild extends EventEmitter implements SpawnedRunProcess {
  readonly stderr = new PassThrough();
  readonly stdout = new PassThrough();
  readonly pid: number | undefined = 1234;

  kill() {
    return true;
  }
}

const logger = {
  error: async () => {},
  info: async () => {},
  warn: async () => {},
};

it("rejects run starts that do not include a command argv", async () => {
  const manager = new RunManager({ logger, shutdownGraceMs: 5 });

  await expect(
    manager.start({
      argv: [],
      attach: {},
      requestId: "rq_1",
      timeoutMs: 1,
    }),
  ).rejects.toThrow("argv must include opencode path");
});

it("parses session and error fields emitted on stderr", async () => {
  const child = new FakeChild();
  const logs: string[] = [];
  const manager = new RunManager({
    killProcessGroup: () => true,
    logger: {
      error: async () => {},
      info: async (_message, fields) => {
        logs.push(`${fields?.sessionId}:${fields?.error}`);
      },
      warn: async () => {},
    },
    shutdownGraceMs: 5,
    spawn: () => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
  });

  const run = await manager.start({
    argv: ["/bin/opencode"],
    attach: {},
    requestId: "rq_2",
    timeoutMs: 1000,
  });
  child.stderr.write(
    `${JSON.stringify({ error: "stderr bad", sessionId: "ses_err" })}\n`,
  );
  child.emit("exit", 1, null);
  await run.done;

  expect(logs).toEqual(["ses_err:stderr bad"]);
});

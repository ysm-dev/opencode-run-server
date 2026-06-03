import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { SpawnedRunProcess } from "./runner.js";
import {
  createRunEnvironment,
  killProcessGroup,
  RunManager,
} from "./runner.js";

class FakeChild extends EventEmitter implements SpawnedRunProcess {
  readonly stderr = new PassThrough();
  readonly stdout = new PassThrough();
  readonly pid: number | undefined;

  constructor(pid: number | null = 1234) {
    super();
    this.pid = pid ?? undefined;
  }

  kill() {
    return true;
  }
}

describe("RunManager", () => {
  it("creates a sanitized child environment with attach credentials only", () => {
    expect(createRunEnvironment({ username: "u", password: "p" })).toEqual({
      OPENCODE_RUN_SERVER_CHILD: "1",
      OPENCODE_SERVER_PASSWORD: "p",
      OPENCODE_SERVER_USERNAME: "u",
    });
  });

  it("spawns opencode run detached, without shell interpolation", async () => {
    const spawned: string[][] = [];
    const child = new FakeChild();
    const manager = new RunManager({
      killProcessGroup: () => true,
      logger: {
        info: async () => {},
        warn: async () => {},
        error: async () => {},
      },
      shutdownGraceMs: 5,
      spawn: (file, args, options) => {
        spawned.push([
          file,
          ...args,
          String(options.detached),
          String(options.shell),
        ]);
        queueMicrotask(() => child.emit("spawn"));
        return child;
      },
    });

    await manager.start({
      attach: {},
      argv: ["/opt/opencode", "run", "--", "hi"],
      requestId: "rq_1",
      timeoutMs: 1000,
    });

    expect(spawned).toEqual([
      ["/opt/opencode", "run", "--", "hi", "true", "false"],
    ]);
    child.emit("exit", 0, null);
  });

  it("terminates timed-out runs with SIGTERM then SIGKILL", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const signals: string[] = [];
    const manager = new RunManager({
      killProcessGroup: (_pid, signal) => {
        signals.push(signal);
        return true;
      },
      logger: {
        info: async () => {},
        warn: async () => {},
        error: async () => {},
      },
      shutdownGraceMs: 5,
      spawn: () => {
        queueMicrotask(() => child.emit("spawn"));
        return child;
      },
    });

    await manager.start({
      attach: {},
      argv: ["/bin/opencode", "run"],
      requestId: "rq_1",
      timeoutMs: 10,
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(signals).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(5);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    child.emit("exit", null, "SIGKILL");
    vi.useRealTimers();
  });

  it("logs parsed session and error fields from json output", async () => {
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
      attach: {},
      argv: ["/bin/opencode", "run"],
      requestId: "rq_1",
      timeoutMs: 1000,
    });
    child.stdout.write(
      `${JSON.stringify({ sessionID: "ses_1" })}\nnot-json\n${JSON.stringify({ error: "bad" })}\n`,
    );
    child.emit("exit", 1, null);
    await run.done;

    expect(logs).toEqual(["ses_1:bad"]);
    expect(manager.activeCount()).toBe(0);
  });
});

describe("RunManager failure and shutdown", () => {
  it("reports spawn errors and missing pids before accepting a run", async () => {
    const logger = {
      info: async () => {},
      warn: async () => {},
      error: async () => {},
    };
    const errored = new FakeChild();
    const errorManager = new RunManager({
      logger,
      shutdownGraceMs: 5,
      spawn: () => {
        queueMicrotask(() => errored.emit("error", new Error("ENOENT")));
        return errored;
      },
    });

    await expect(
      errorManager.start({
        attach: {},
        argv: ["/missing"],
        requestId: "rq_1",
        timeoutMs: 1,
      }),
    ).rejects.toThrow("ENOENT");

    const missingPid = new FakeChild(null);
    const pidManager = new RunManager({
      logger,
      shutdownGraceMs: 5,
      spawn: () => {
        queueMicrotask(() => missingPid.emit("spawn"));
        return missingPid;
      },
    });
    await expect(
      pidManager.start({
        attach: {},
        argv: ["/bin/opencode"],
        requestId: "rq_2",
        timeoutMs: 1,
      }),
    ).rejects.toThrow("pid");
  });

  it("kills all active process groups on shutdown", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const signals: string[] = [];
    const manager = new RunManager({
      killProcessGroup: (_pid, signal) => {
        signals.push(signal);
        return true;
      },
      logger: {
        info: async () => {},
        warn: async () => {},
        error: async () => {},
      },
      shutdownGraceMs: 5,
      spawn: () => {
        queueMicrotask(() => child.emit("spawn"));
        return child;
      },
    });

    await manager.start({
      attach: {},
      argv: ["/bin/opencode"],
      requestId: "rq_1",
      timeoutMs: 1000,
    });
    const killed = manager.killAll();
    expect(signals).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(5);
    await killed;
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    child.emit("exit", null, "SIGKILL");
    vi.useRealTimers();
  });

  it("returns immediately when shutdown has no active runs", async () => {
    const manager = new RunManager({
      killProcessGroup: () => {
        throw new Error("should not kill");
      },
      logger: {
        info: async () => {},
        warn: async () => {},
        error: async () => {},
      },
      shutdownGraceMs: 5,
    });

    await expect(manager.killAll()).resolves.toBeUndefined();
  });

  it("parses lowercase sessionId event fields", async () => {
    const child = new FakeChild();
    const logs: string[] = [];
    const manager = new RunManager({
      killProcessGroup: () => true,
      logger: {
        error: async () => {},
        info: async (_message, fields) => {
          logs.push(String(fields?.sessionId));
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
      attach: {},
      argv: ["/bin/opencode"],
      requestId: "rq_1",
      timeoutMs: 1000,
    });
    child.stdout.write(`${JSON.stringify({ sessionId: "ses_lower" })}\n`);
    child.emit("exit", 0, null);
    await run.done;

    expect(logs).toEqual(["ses_lower"]);
  });

  it("handles ESRCH when killing a process group", () => {
    const original = vi.spyOn(process, "kill").mockImplementation(() => {
      const error = new Error("gone");
      Object.defineProperty(error, "code", { value: "ESRCH" });
      throw error;
    });

    expect(killProcessGroup(123, "SIGTERM")).toBe(false);
    original.mockRestore();
  });

  it("rethrows unexpected process-group kill errors", () => {
    const original = vi.spyOn(process, "kill").mockImplementation(() => {
      const error = new Error("denied");
      Object.defineProperty(error, "code", { value: "EPERM" });
      throw error;
    });

    expect(() => killProcessGroup(123, "SIGTERM")).toThrow("denied");
    original.mockRestore();
  });
});

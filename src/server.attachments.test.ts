import { describe, expect, it, vi } from "vitest";
import { createServerConfig } from "./config.js";
import type { StartedRun } from "./queue.js";
import { createRunServerApp } from "./server.js";

const config = async (overrides: object = {}) =>
  createServerConfig(overrides, {
    discoverBind: async () => ({ host: "127.0.0.1", source: "loopback" }),
    env: { XDG_STATE_HOME: "/tmp/state" },
    execPath: "/bin/opencode",
  });

const inlineRequest = () =>
  new Request("http://x/run", {
    body: JSON.stringify({
      dir: "/repo",
      inlineFiles: [{ content: "AAAA", filename: "shot.png" }],
      prompt: "describe",
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("run-server inline file attachments", () => {
  it("materializes inline files into -f args and cleans them up after the run", async () => {
    const cleanup = vi.fn(async () => {});
    let finish: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const calls: string[][] = [];
    const app = createRunServerApp({
      config: await config(),
      mainServerUrl: "http://main/",
      materialize: async (files) => {
        expect(files).toEqual([{ content: "AAAA", filename: "shot.png" }]);
        return { cleanup, paths: ["/tmp/ors-run-x/0-shot.png"] };
      },
      packageVersion: "0.0.2",
      startRun: async (job): Promise<StartedRun> => {
        calls.push(job.argv);
        return { done };
      },
    });

    const response = await app.fetch(inlineRequest());

    expect(response.status).toBe(202);
    expect(calls[0]).toContain("/tmp/ors-run-x/0-shot.png");
    expect(cleanup).not.toHaveBeenCalled();

    finish();
    await done;
    await tick();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("cleans up inline files when the run fails to spawn", async () => {
    const cleanup = vi.fn(async () => {});
    const app = createRunServerApp({
      config: await config(),
      mainServerUrl: "http://main/",
      materialize: async () => ({
        cleanup,
        paths: ["/tmp/ors-run-y/0-shot.png"],
      }),
      packageVersion: "0.0.2",
      startRun: async () => {
        throw new Error("ENOENT");
      },
    });

    const response = await app.fetch(inlineRequest());

    expect(response.status).toBe(500);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

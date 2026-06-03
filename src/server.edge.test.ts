import { expect, it } from "vitest";
import { createServerConfig } from "./config.js";
import { createRunServerApp } from "./server.js";

const config = async (overrides: object = {}) =>
  createServerConfig(overrides, {
    discoverBind: async () => ({ host: "127.0.0.1", source: "loopback" }),
    env: { XDG_STATE_HOME: "/tmp/state" },
    execPath: "/bin/opencode",
  });

const runRequest = () =>
  new Request("http://x/run", {
    body: JSON.stringify({ dir: "/repo", prompt: "hello" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

it("forwards configured attach credentials into started runs", async () => {
  const attaches: unknown[] = [];
  const app = createRunServerApp({
    config: await config({ attach: { password: "p", username: "u" } }),
    mainServerUrl: "http://main/",
    packageVersion: "0.0.2",
    startRun: async (job) => {
      attaches.push(job.attach);
      return { done: Promise.resolve() };
    },
  });

  expect((await app.fetch(runRequest())).status).toBe(202);
  expect(attaches).toEqual([{ password: "p", username: "u" }]);
});

it("logs Error instances from spawn failures without string coercion", async () => {
  const errors: string[] = [];
  const app = createRunServerApp({
    config: await config(),
    logger: {
      error: async (_message, fields) => {
        errors.push(String(fields?.error));
      },
      info: async () => {},
      warn: async () => {},
    },
    mainServerUrl: "http://main/",
    packageVersion: "0.0.2",
    startRun: async () => Promise.reject(new Error("boom")),
  });

  expect((await app.fetch(runRequest())).status).toBe(500);
  expect(errors).toEqual(["boom"]);
});

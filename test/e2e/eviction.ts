import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { z } from "zod";
import { RunServer } from "../../src/rpc.js";

const statusSchema = z.object({
  uptimeMs: z.number(),
  runs: z.object({ active: z.number(), queued: z.number(), total: z.number() }),
});

// plugin.awaitActivation was removed in v2.0.4; the plugin's own status RPC
// only answers once its setup() has run, so it doubles as a readiness probe.
const readyByRpc = async (
  client: ReturnType<typeof OpenCode.make>,
  directory: string,
  deadline = Date.now() + 10_000,
) => {
  const rpc = client.rpc(RunServer);
  while (true) {
    try {
      await rpc.status(undefined, { location: { directory } });
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await Bun.sleep(20);
    }
  }
};

const chunk = (delta: object, reason: string | null) => ({
  id: "evict",
  object: "chat.completion.chunk",
  created: 1,
  model: "test",
  choices: [{ index: 0, delta, finish_reason: reason }],
});

const host = async (root: string, installed: string) => {
  const { Effect, Scope, Exit, References } = await import("effect");
  const { ServerFetch } = await import("@opencode/server/fetch");
  const { LocationActivity } = await import("@opencode/core/location-activity");
  const directory = join(root, "evicted");
  await mkdir(directory);
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const port = probe.port;
  await probe.stop(true);
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response(
        `data: ${JSON.stringify(chunk({ role: "assistant", content: "Evicted verified" }, null))}\n\ndata: ${JSON.stringify(chunk({}, "stop"))}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      ),
  });
  const scope = await Effect.runPromise(Scope.make());
  const handler = await Effect.runPromise(
    ServerFetch.make(
      {
        app: { version: "2.0.3", channel: "test" },
        password: "service-secret",
        database: { path: ":memory:" },
        config: {
          directory: join(root, "config"),
          project: false,
          content: JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            model: "fixture/test",
            providers: {
              fixture: {
                package: "@opencode/ai/providers/openai-compatible",
                settings: {
                  baseURL: `http://127.0.0.1:${provider.port}/v1`,
                  apiKey: "fixture",
                },
                models: { test: {} },
              },
            },
            plugins: [
              {
                package: installed,
                options: {
                  bind: "127.0.0.1",
                  port,
                  token: "evict-secret",
                  log: { file: join(root, "eviction.log") },
                  healthCheck: {
                    intervalMs: 50,
                    timeoutMs: 500,
                    failureThreshold: 2,
                  },
                  restart: {
                    baseDelayMs: 20,
                    maxDelayMs: 100,
                    maxRetries: 3,
                    windowMs: 1000,
                  },
                },
              },
            ],
          }),
        },
        models: { fetch: false, snapshot: false },
        fs: { filewatcher: false, fff: false },
      },
      // Idle locations are evicted in seconds instead of an hour. The node keeps
      // its dependency wiring; a decorator cannot prove the rebuilt layer needs
      // exactly the same services, so the layer is handed over unchecked.
      {
        overrides: [
          LocationActivity.node.replace(
            LocationActivity.node.mapLayer(
              () =>
                LocationActivity.layer({
                  timeToLive: "3 seconds",
                  sweepInterval: "200 millis",
                }) as never,
            ),
          ),
        ],
      },
    ).pipe(
      Scope.provide(scope),
      Effect.provideService(References.MinimumLogLevel, "Error"),
    ),
  );
  if (typeof handler !== "function")
    throw new Error("V2 fetch handler unavailable");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) =>
      z.instanceof(Response).parse(await handler(request)),
  });
  const url = `http://127.0.0.1:${server.port}`;
  const state = join(process.env.XDG_STATE_HOME ?? root, "opencode");
  const registration = join(state, "service-evict.json");
  await mkdir(state, { recursive: true });
  await writeFile(
    registration,
    JSON.stringify({
      pid: process.pid,
      version: "2.0.3",
      url,
      password: "service-secret",
    }),
    { mode: 0o600 },
  );
  const client = OpenCode.make({
    baseUrl: url,
    headers: {
      authorization: `Basic ${Buffer.from("opencode:service-secret").toString("base64")}`,
    },
  });
  // plugin.awaitActivation was removed; poll the plugin's own RPC method
  // instead, which only answers once its setup() has registered it.
  await readyByRpc(client, directory);
  return {
    client,
    directory,
    base: `http://127.0.0.1:${port}`,
    async close() {
      try {
        await rm(registration, { force: true });
        await Effect.runPromise(Scope.close(scope, Exit.void));
      } finally {
        await server.stop(true);
        await provider.stop(true);
      }
    },
  };
};

/**
 * OpenCode evicts idle location instances, which unloads the plugin instances
 * that started the listener. The listener must keep serving anyway.
 */
export const verifyEviction = async (root: string, installed: string) => {
  const f = await host(root, installed);
  const authorization = "Bearer evict-secret";
  const status = async () =>
    statusSchema.parse(
      await (
        await fetch(`${f.base}/status`, { headers: { authorization } })
      ).json(),
    );
  const run = () =>
    fetch(`${f.base}/run`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ dir: f.directory, prompt: "Before eviction" }),
    });
  const idle = async (deadline = Date.now() + 15_000) => {
    while (true) {
      const value = await status();
      if (value.runs.active === 0 && value.runs.queued === 0) return value;
      assert.ok(Date.now() < deadline, "Listener queue did not become idle");
      await Bun.sleep(20);
    }
  };
  const location = { directory: f.directory };
  const rpc = f.client.rpc(RunServer);
  try {
    const listening = Date.now() + 10_000;
    while (
      !(await fetch(`${f.base}/health`).then(
        (response) => response.ok,
        () => false,
      ))
    ) {
      assert.ok(Date.now() < listening, "Listener failed to start");
      await Bun.sleep(20);
    }
    assert.equal((await run()).status, 202);
    const before = await idle();
    assert.equal(before.runs.total, 1);
    await rpc.run({ prompt: "Instance marker" }, { location });
    assert.equal((await rpc.status(undefined, { location })).runs.total, 1);

    // Location-scoped RPC counters reset only when the instance is replaced.
    const evicted = Date.now() + 30_000;
    while ((await rpc.status(undefined, { location })).runs.total !== 0) {
      assert.ok(Date.now() < evicted, "Location instance was never evicted");
      await Bun.sleep(100);
    }
    const after = await status();
    assert.equal(after.runs.total, 1, "Listener restarted across eviction");
    assert.ok(after.uptimeMs > before.uptimeMs);
    assert.equal((await run()).status, 202);
    assert.equal((await idle()).runs.total, 2);
    const sessions = await f.client.session.list({ directory: f.directory });
    assert.equal(sessions.data.length, 3);
  } catch (error) {
    console.error(await readFile(join(root, "eviction.log"), "utf8"));
    throw error;
  } finally {
    await f.close();
  }
  const stopped = Date.now() + 10_000;
  while (
    await fetch(`${f.base}/health`).then(
      () => true,
      () => false,
    )
  ) {
    assert.ok(Date.now() < stopped, "Listener outlived its service");
    await Bun.sleep(20);
  }
  console.log("Verified listener survival across idle location eviction.");
};

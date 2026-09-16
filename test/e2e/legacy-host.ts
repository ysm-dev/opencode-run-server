import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { z } from "zod";

const bodySchema = z
  .object({ messages: z.array(z.object({ role: z.string() }).passthrough()) })
  .passthrough();

const completion = (body: z.infer<typeof bodySchema>) => {
  const tool =
    JSON.stringify(body).includes("RUN_TOOL") &&
    !body.messages.some((message) => message.role === "tool");
  const delta = tool
    ? {
        tool_calls: [
          {
            index: 0,
            id: "call_1",
            type: "function",
            function: {
              name: "write",
              arguments: JSON.stringify({
                path: "permission.txt",
                content: "Legacy permission verified",
              }),
            },
          },
        ],
      }
    : { role: "assistant", content: "Legacy verified" };
  const chunk = {
    id: "legacy",
    object: "chat.completion.chunk",
    created: 1,
    model: "test",
  };
  const chunks = [
    { ...chunk, choices: [{ index: 0, delta, finish_reason: null }] },
    {
      ...chunk,
      choices: [
        { index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" },
      ],
    },
  ];
  return new Response(
    `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
};

export const createLegacyHost = async (
  root: string,
  installed: string,
  runtime: "bun" | "node",
) => {
  const { Effect, Scope, Exit, References } = await import("effect");
  const { ServerFetch } = await import("@opencode/server/fetch");
  const directory = join(root, `legacy-${runtime}`);
  await mkdir(directory);
  const portProbe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const port = portProbe.port;
  await portProbe.stop(true);
  let gate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = bodySchema.parse(await request.json());
      if (gate !== undefined) await gate.promise;
      return completion(body);
    },
  });
  const scope = await Effect.runPromise(Scope.make());
  const handler = await Effect.runPromise(
    ServerFetch.make({
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
          permissions: [
            { action: "edit", resource: "permission.txt", effect: "ask" },
          ],
          commands: { fixture: { template: "Legacy command: $ARGUMENTS" } },
          // Exercise V2's V1 configuration normalization as well as plugin options.
          plugin: [
            [
              installed,
              {
                bind: "127.0.0.1",
                port,
                runtime,
                token: "legacy-secret",
                concurrency: 1,
                queueMax: 1,
                maxBodyBytes: 4096,
                runTimeoutMs: 5000,
                opencodePath: "/legacy/opencode",
                log: { file: join(root, `legacy-${runtime}.log`) },
                healthCheck: {
                  intervalMs: 50,
                  timeoutMs: 100,
                  failureThreshold: 2,
                },
                restart: {
                  baseDelayMs: 20,
                  maxDelayMs: 100,
                  maxRetries: 3,
                  windowMs: 1000,
                },
              },
            ],
          ],
        }),
      },
      models: { fetch: false, snapshot: false },
      fs: { filewatcher: false, fff: false },
    }).pipe(
      Scope.provide(scope),
      Effect.provideService(References.MinimumLogLevel, "Error"),
    ),
  );
  if (typeof handler !== "function")
    throw new Error("V2 fetch handler unavailable");
  let health: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      // Stalls only transport probes, leaving run traffic answerable.
      if (new URL(request.url).pathname === "/api/health")
        await health?.promise;
      return z.instanceof(Response).parse(await handler(request));
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  const state = join(process.env.XDG_STATE_HOME ?? root, "opencode");
  const registration = join(state, `service-${runtime}.json`);
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
  await client.plugin.awaitActivation({ location: { directory } });
  return {
    client,
    directory,
    url,
    base: `http://127.0.0.1:${port}`,
    block() {
      gate = Promise.withResolvers<void>();
    },
    release() {
      gate?.resolve();
      gate = undefined;
    },
    blockHealth() {
      health = Promise.withResolvers<void>();
    },
    releaseHealth() {
      health?.resolve();
      health = undefined;
    },
    async close() {
      try {
        // A gone service must stop the listener; discovery cannot resurrect it.
        await rm(registration, { force: true });
        await Effect.runPromise(Scope.close(scope, Exit.void));
      } finally {
        gate?.resolve();
        health?.resolve();
        await server.stop(true);
        await provider.stop(true);
      }
    },
  };
};

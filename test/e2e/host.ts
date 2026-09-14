import { join } from "node:path";
import type { OpenCodeClient } from "@opencode/client";
import { Plugin } from "@opencode/plugin";
import { z } from "zod";

const requestSchema = z
  .object({ messages: z.array(z.object({ role: z.string() }).passthrough()) })
  .passthrough();

export const createHost = async (root: string, installed: string) => {
  const { OpenCode } = await import("@opencode/sdk");
  const requests: unknown[] = [];
  let gate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  let policy: "ask" | "deny" = "ask";
  const reloads = new Set<() => Promise<void>>();
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = requestSchema.parse(await request.json());
      requests.push(body);
      if (gate !== undefined) await gate.promise;
      const tool =
        JSON.stringify(body).includes("RUN_TOOL") &&
        !body.messages.some((message) => message.role === "tool");
      const delta = tool
        ? {
            tool_calls: [
              {
                index: 0,
                id: "call_fixture",
                type: "function",
                function: {
                  name: "write",
                  arguments: JSON.stringify({
                    path: "permission.txt",
                    content: "Permission verified",
                  }),
                },
              },
            ],
          }
        : { role: "assistant", content: "Verified response" };
      const chunk = {
        id: "test",
        object: "chat.completion.chunk",
        created: 1,
        model: "test",
      };
      const chunks = [
        { ...chunk, choices: [{ index: 0, delta, finish_reason: null }] },
        {
          ...chunk,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: tool ? "tool_calls" : "stop",
            },
          ],
        },
      ];
      return new Response(
        `${chunks.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("")}data: [DONE]\n\n`,
        {
          headers: { "content-type": "text/event-stream" },
        },
      );
    },
  });
  const fixture = Plugin.define({
    id: "fixture",
    async setup(ctx) {
      reloads.add(ctx.agent.reload);
      await ctx.agent.transform((editor) =>
        editor.update("build", (agent) => {
          agent.permissions.push({
            action: "edit",
            resource: "permission.txt",
            effect: policy,
          });
        }),
      );
      await ctx.command.transform((editor) =>
        editor.add({
          name: "fixture",
          execute: async ({ sessionID, prompt, delivery }) => {
            await ctx.session.prompt({
              sessionID,
              text: `command: ${prompt.text}`,
              delivery,
            });
          },
        }),
      );
    },
  });
  const host: OpenCodeClient & { close(): Promise<void> } =
    await OpenCode.create({
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
                legacyHttp: false,
                concurrency: 1,
                queueMax: 1,
                maxInputBytes: 4096,
                runTimeoutMs: 10_000,
                log: { file: join(root, "runs.log") },
              },
            },
          ],
        }),
      },
      plugins: [fixture],
      models: { fetch: false, snapshot: false },
      fs: { filewatcher: false, fff: false },
      log: {
        level: "error",
        emit: (entry: { message: string }) => console.error(entry),
      },
    });
  return {
    host,
    requests,
    block() {
      gate = Promise.withResolvers<void>();
    },
    release() {
      gate?.resolve();
      gate = undefined;
    },
    async deny() {
      policy = "deny";
      await Promise.all([...reloads].map((reload) => reload()));
    },
    async close() {
      try {
        await host.close();
      } finally {
        gate?.resolve();
        await provider.stop(true);
      }
    },
  };
};

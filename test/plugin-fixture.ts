import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventSubscribeOutput } from "@opencode/client";
import type { Plugin } from "@opencode/plugin";
import type { PermissionEvaluation } from "@opencode/plugin/promise/permission";
import type { RpcHandlers } from "@opencode/plugin/promise/rpc";
import type { SessionPrompt } from "@opencode/plugin/promise/session";
import { Session } from "@opencode/schema/session";
import { SessionMessage } from "@opencode/schema/session-message";
import { expect, vi } from "vitest";
import { setup } from "../src/plugin.js";
import { RunServer } from "../src/rpc.js";
import { runFixture } from "./fixture.js";

export class Events implements AsyncIterableIterator<EventSubscribeOutput> {
  readonly #queue: EventSubscribeOutput[] = [];
  #pending:
    | ReturnType<
        typeof Promise.withResolvers<IteratorResult<EventSubscribeOutput>>
      >
    | undefined;
  #closed = false;
  readonly returned = vi.fn();

  [Symbol.asyncIterator]() {
    return this;
  }
  next(): Promise<IteratorResult<EventSubscribeOutput>> {
    const value = this.#queue.shift();
    if (value !== undefined) return Promise.resolve({ done: false, value });
    if (this.#closed) return Promise.resolve({ done: true, value: undefined });
    this.#pending =
      Promise.withResolvers<IteratorResult<EventSubscribeOutput>>();
    return this.#pending.promise;
  }
  push(value: EventSubscribeOutput) {
    if (this.#pending !== undefined) {
      this.#pending.resolve({ done: false, value });
      this.#pending = undefined;
    } else this.#queue.push(value);
  }
  fail(error: Error) {
    this.#pending?.reject(error);
  }
  async return(): Promise<IteratorResult<EventSubscribeOutput>> {
    this.returned();
    this.#closed = true;
    this.#pending?.resolve({ done: true, value: undefined });
    return { done: true, value: undefined };
  }
}

export const formEvent = (sessionID: string): EventSubscribeOutput => ({
  id: "evt_form",
  created: 0,
  type: "form.created",
  data: {
    form: {
      id: "form_1",
      sessionID,
      title: "Question",
      fields: [{ type: "string", key: "answer" }],
    },
  },
});

export const pluginFixture = async (options: Record<string, unknown> = {}) => {
  const f = runFixture();
  const directory = await mkdtemp(join(tmpdir(), "ors-plugin-"));
  const events = new Events();
  let onPrompt: (event: SessionPrompt) => Promise<void> | void = () => {};
  const prompt = (sessionID: string, messageID: string) =>
    onPrompt({
      sessionID: Session.ID.make(sessionID),
      messageID: SessionMessage.ID.make(messageID),
      prompt: { text: "fixture prompt" },
      delivery: "steer",
    });
  f.admissions.add((sessionID, messageID) => {
    void prompt(sessionID, messageID);
  });
  f.admissions.add((sessionID, inboxID) =>
    events.push({
      id: "evt_delivered",
      created: 0,
      type: "session.inbox.delivered",
      durable: { aggregateID: sessionID, seq: 1, version: 1 },
      data: { sessionID, inboxID },
    }),
  );
  let evaluate: (event: PermissionEvaluation) => Promise<void> | void =
    () => {};
  let handlers: RpcHandlers<typeof RunServer> | undefined;
  const register: Plugin.Context["rpc"]["register"] = vi.fn(
    async (definition, callbacks) => {
      expect(definition.id).toBe(RunServer.id);
      // This fixture captures the one concrete contract registered by the plugin.
      handlers = callbacks as RpcHandlers<typeof RunServer>;
      return { dispose: async () => {}, events: { emit: async () => {} } };
    },
  );
  const ctx: Parameters<typeof setup>[0] = {
    ...f.context,
    session: {
      ...f.context.session,
      hook: async (name, callback) => {
        expect(name).toBe("prompt");
        onPrompt = callback as (event: SessionPrompt) => Promise<void> | void;
        return { dispose: async () => {} };
      },
    },
    options: {
      legacyHttp: false,
      log: { file: join(directory, "runs.log") },
      ...options,
    },
    permission: {
      hook: async (_name, callback) => {
        evaluate = callback;
        return { dispose: async () => {} };
      },
    },
    event: {
      subscribe: ({ signal } = {}) => {
        signal?.addEventListener(
          "abort",
          () => {
            void events.return();
          },
          { once: true },
        );
        return events;
      },
    },
    rpc: { register },
  };
  const cleanup = await setup(ctx);
  const registered = () => {
    if (handlers === undefined) throw new Error("RPC not registered");
    return handlers;
  };
  return {
    ...f,
    ctx,
    events,
    directory,
    cleanup,
    prompt,
    async dispose() {
      await cleanup();
      await rm(directory, { recursive: true, force: true });
    },
    run(input: unknown, signal = new AbortController().signal) {
      return registered().run(RunServer.methods.run.input.parse(input), {
        signal,
        error: (...args): never => {
          throw Object.assign(new Error(args[1]), {
            type: args[0],
            data: args[2],
          });
        },
      });
    },
    status() {
      return registered().status(undefined, {
        signal: new AbortController().signal,
        error: () => {
          throw new Error("Unexpected status error");
        },
      });
    },
    async permission(
      sessionID: string,
      effect: PermissionEvaluation["effect"] = "ask",
    ) {
      const event: PermissionEvaluation = {
        sessionID: Session.ID.make(sessionID),
        action: "edit",
        resources: ["*"],
        effect,
      };
      await evaluate(event);
      return event;
    },
  };
};

import { OpenCode, type OpenCodeClient } from "@opencode/client";
import { vi } from "vitest";
import { LegacyBackend } from "../src/compat/backend.js";
import { parseOptions } from "../src/config.js";
import { runFixture, sessionInfo } from "./fixture.js";
import { Events } from "./plugin-fixture.js";

export const legacyFixture = (options: object = {}) => {
  const f = runFixture();
  const events = new Events();
  events.push({ id: "evt_connected", type: "server.connected", data: {} });
  f.admissions.add((sessionID, inboxID) => {
    events.push({
      id: "evt_enqueue",
      type: "session.inbox.enqueued",
      created: 0,
      durable: { aggregateID: sessionID, seq: 1, version: 1 },
      data: {
        sessionID,
        inboxID,
        item: { type: "user", payload: { text: "test" }, delivery: "steer" },
      },
    });
    events.push({
      id: "evt_delivered",
      type: "session.inbox.delivered",
      created: 0,
      durable: { aggregateID: sessionID, seq: 2, version: 1 },
      data: { sessionID, inboxID },
    });
  });
  const native = OpenCode.make({
    baseUrl: "http://fixture.invalid",
    fetch: Object.assign(
      async () => {
        throw new Error("Unexpected network call");
      },
      { preconnect: () => {} },
    ),
  });
  const list = vi.fn<OpenCodeClient["session"]["list"]>(async () => ({
    data: [...f.sessions.values()],
    cursor: {},
  }));
  const fork = vi.fn<OpenCodeClient["session"]["fork"]>(
    async ({ sessionID }) => {
      const value = sessionInfo(`ses_${f.sessions.size + 1}`, {
        parentID: sessionID,
      });
      f.sessions.set(value.id, value);
      return value;
    },
  );
  const context = vi.fn<OpenCodeClient["session"]["context"]>(async () => []);
  const inbox = vi.fn<OpenCodeClient["session"]["inbox"]["list"]>(
    async () => [],
  );
  const reply = vi.fn<OpenCodeClient["permission"]["reply"]>(async () => {});
  const cancelForm = vi.fn<OpenCodeClient["form"]["cancel"]>(async () => {});
  const client: OpenCodeClient = {
    ...native,
    session: {
      ...native.session,
      ...f.context.session,
      list,
      fork,
      context,
      inbox: { ...native.session.inbox, list: inbox },
    },
    model: { ...native.model, default: f.context.catalog.model.default },
    location: {
      ...native.location,
      get: vi.fn(async (input) => ({
        directory: input?.location?.directory ?? "/project",
        project: {
          id: "project",
          directory: "/project",
          canonical: "/project",
        },
      })),
    },
    permission: { ...native.permission, reply },
    form: { ...native.form, cancel: cancelForm },
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
  };
  const logger = {
    debug: vi.fn(async () => {}),
    info: vi.fn(async () => {}),
    warn: vi.fn(async () => {}),
    error: vi.fn(async () => {}),
  };
  const unavailable = vi.fn();
  const backend = new LegacyBackend(
    client,
    parseOptions(options),
    logger,
    unavailable,
  );
  return {
    ...f,
    client,
    backend,
    logger,
    unavailable,
    events,
    list,
    fork,
    contextMessages: context,
    inbox,
    reply,
    cancelForm,
  };
};

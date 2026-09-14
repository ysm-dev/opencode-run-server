import type { SessionInfo } from "@opencode/client";
import type { Plugin } from "@opencode/plugin";
import { vi } from "vitest";
import type { RunContext } from "../src/runner.js";

export const sessionInfo = (
  id: string,
  overrides: Partial<SessionInfo> = {},
): SessionInfo => ({
  id,
  projectID: "project",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
  location: { directory: "/project" },
  ...overrides,
});

export const runFixture = () => {
  const sessions = new Map<string, SessionInfo>();
  const waits = new Map<
    string,
    ReturnType<typeof Promise.withResolvers<void>>
  >();
  const location = { directory: "/project" };
  const admissions = new Set<(sessionID: string, id: string) => void>();
  const hook: Plugin.Context["session"]["hook"] = async () => ({
    dispose: async () => {},
  });
  const session = {
    create: vi.fn<RunContext["session"]["create"]>(async (input) => {
      const value = sessionInfo(`ses_${sessions.size + 1}`, {
        location: input?.location ?? location,
      });
      sessions.set(value.id, value);
      return value;
    }),
    get: vi.fn<RunContext["session"]["get"]>(async ({ sessionID }) => {
      const value = sessions.get(sessionID);
      if (value === undefined) throw new Error("Session not found");
      return value;
    }),
    switchAgent: vi.fn<RunContext["session"]["switchAgent"]>(async () => {}),
    switchModel: vi.fn<RunContext["session"]["switchModel"]>(async () => {}),
    rename: vi.fn<RunContext["session"]["rename"]>(async () => {}),
    prompt: vi.fn<RunContext["session"]["prompt"]>(async (input) => {
      const id = input.id ?? "msg_1";
      waits.set(input.sessionID, Promise.withResolvers<void>());
      for (const admit of admissions) admit(input.sessionID, id);
      return {
        id,
        sessionID: input.sessionID,
        timeCreated: 0,
        type: "user",
        payload: { text: input.text },
        delivery: "steer",
      };
    }),
    hook,
    command: vi.fn<RunContext["session"]["command"]>(async () => {}),
    wait: vi.fn<RunContext["session"]["wait"]>(
      async ({ sessionID }, options) => {
        const wait = waits.get(sessionID) ?? Promise.withResolvers<void>();
        waits.set(sessionID, wait);
        const abort = () => wait.reject(options?.signal?.reason);
        options?.signal?.addEventListener("abort", abort, { once: true });
        try {
          options?.signal?.throwIfAborted();
          await wait.promise;
        } finally {
          options?.signal?.removeEventListener("abort", abort);
        }
      },
    ),
    interrupt: vi.fn<RunContext["session"]["interrupt"]>(async () => ({
      interrupted: true,
    })),
  };
  const catalog = {
    model: {
      default: vi.fn<RunContext["catalog"]["model"]["default"]>(async () => ({
        location: {
          ...location,
          project: {
            id: "project",
            directory: "/project",
            canonical: "/project",
          },
        },
        data: null,
      })),
    },
  };
  return {
    context: { location, session, catalog },
    sessions,
    admissions,
    waits,
    complete(id = "ses_1", outcome: SessionInfo["outcome"] = "succeeded") {
      const value = sessions.get(id);
      if (value !== undefined && outcome !== undefined) value.outcome = outcome;
      waits.get(id)?.resolve();
    },
  };
};

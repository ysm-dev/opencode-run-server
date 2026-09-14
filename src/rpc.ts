import { Rpc } from "@opencode/plugin/rpc";
import { z } from "zod";
import { runRequestSchema } from "./request.js";

const count = z.number().int().nonnegative();

export const RunServer = Rpc.define({
  id: "opencode-run-server",
  methods: {
    run: {
      input: runRequestSchema,
      output: z
        .object({
          requestId: z.string(),
          status: z.literal("accepted"),
          queued: z.boolean(),
        })
        .strict(),
      errors: {
        queue_full: z.object({ retryAfterSeconds: count }).strict(),
        input_too_large: z.object({ maxInputBytes: count }).strict(),
        start_failed: z.object({ requestId: z.string() }).strict(),
      },
    },
    status: {
      input: z.object({}).strict().optional(),
      output: z
        .object({
          version: z.string(),
          uptimeMs: count,
          location: z
            .object({
              directory: z.string(),
              workspaceID: z.string().optional(),
            })
            .strict(),
          runs: z
            .object({
              active: count,
              queued: count,
              concurrency: count,
              queueMax: count,
              total: count,
              failed: count,
              completed: count,
              dropped: count,
            })
            .strict(),
        })
        .strict(),
    },
  },
  events: {},
});

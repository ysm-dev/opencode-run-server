import { z } from "zod";

const flagValue = z
  .string()
  .min(1)
  .refine(
    (value) => !value.startsWith("-"),
    "flag values must not start with '-'",
  );
const filename = flagValue
  .max(255)
  .refine(
    (value) => !/[\\/\0]/.test(value) && value !== "." && value !== "..",
    "filename must be a bare name without path separators",
  );
const content = z
  .string()
  .min(1)
  .refine(
    (value) => value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value),
    "content must be standard base64",
  );

export const legacyRequest = z
  .object({
    agent: flagValue.optional(),
    command: flagValue.optional(),
    continue: z.boolean().optional(),
    dangerouslySkipPermissions: z.boolean().optional(),
    dir: flagValue,
    files: z.array(flagValue).optional(),
    fork: z.boolean().optional(),
    inlineFiles: z.array(z.object({ filename, content }).strict()).optional(),
    model: flagValue.optional(),
    prompt: z.string().min(1).optional(),
    session: flagValue.optional(),
    thinking: z.boolean().optional(),
    timeoutMs: z.number().int().positive().max(2_147_483_647).optional(),
    title: flagValue.optional(),
    variant: flagValue.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.prompt === undefined && value.command === undefined)
      ctx.addIssue({
        code: "custom",
        message: "at least one of prompt or command is required",
        path: ["prompt"],
      });
    if (value.fork && value.session === undefined && !value.continue)
      ctx.addIssue({
        code: "custom",
        message: "fork requires session or continue",
        path: ["fork"],
      });
  });

export type LegacyRequest = z.infer<typeof legacyRequest>;

import { z } from "zod";

const name = z.string().min(1);
const base64 = z
  .string()
  .min(1)
  .refine(
    (value) => Buffer.from(value, "base64").toString("base64") === value,
    "content must be canonical standard base64",
  );
const filename = name
  .max(255)
  .refine(
    (value) => !/[\\/\0]/.test(value) && value !== "." && value !== "..",
    "filename must be a bare name without path separators",
  );

export const runRequestSchema = z
  .object({
    prompt: name.optional(),
    command: name.optional(),
    session: name.optional(),
    agent: name.optional(),
    model: name
      .regex(
        /^[^/#]+\/[^#]+(?:#[^#]+)?$/,
        "model must be provider/model[#variant]",
      )
      .optional(),
    variant: name.optional(),
    title: name.optional(),
    files: z.array(name).optional(),
    inlineFiles: z
      .array(z.object({ filename, content: base64 }).strict())
      .optional(),
    dangerouslySkipPermissions: z.boolean().optional(),
    timeoutMs: z.number().int().positive().max(2_147_483_647).optional(),
  })
  .strict()
  .refine(
    (value) => value.prompt !== undefined || value.command !== undefined,
    "at least one of prompt or command is required",
  );

export type RunRequest = z.infer<typeof runRequestSchema>;

export const modelRef = (model: string, variant?: string) => {
  const slash = model.indexOf("/");
  const hash = model.indexOf("#");
  const selected = variant ?? (hash === -1 ? undefined : model.slice(hash + 1));
  return {
    providerID: model.slice(0, slash),
    id: model.slice(slash + 1, hash === -1 ? undefined : hash),
    ...(selected === undefined ? {} : { variant: selected }),
  };
};

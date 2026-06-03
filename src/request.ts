import { z } from "zod";

const flagValue = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith("-"), {
    message: "flag values must not start with '-'",
  });

const runRequestSchema = z
  .object({
    agent: flagValue.optional(),
    command: flagValue.optional(),
    continue: z.boolean().optional(),
    dangerouslySkipPermissions: z.boolean().optional(),
    dir: flagValue,
    files: z.array(flagValue).optional(),
    fork: z.boolean().optional(),
    model: flagValue.optional(),
    prompt: z.string().min(1).optional(),
    session: flagValue.optional(),
    thinking: z.boolean().optional(),
    timeoutMs: z.number().int().positive().optional(),
    title: flagValue.optional(),
    variant: flagValue.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.prompt === undefined && value.command === undefined) {
      context.addIssue({
        code: "custom",
        message: "at least one of prompt or command is required",
        path: ["prompt"],
      });
    }
    if (
      value.fork === true &&
      value.session === undefined &&
      value.continue !== true
    ) {
      context.addIssue({
        code: "custom",
        message: "fork requires session or continue",
        path: ["fork"],
      });
    }
  });

export type RunRequest = z.infer<typeof runRequestSchema>;

export type ParseRunRequestResult =
  | { ok: true; value: RunRequest }
  | { error: string; ok: false };

export type RunArgvContext = {
  attachUrl: string;
  defaultDangerouslySkipPermissions: boolean;
  opencodePath: string;
};

export const parseRunRequest = (body: unknown): ParseRunRequestResult => {
  const result = runRequestSchema.safeParse(body);
  if (result.success) return { ok: true, value: result.data };
  return {
    error: result.error.issues.map((issue) => issue.message).join("; "),
    ok: false,
  };
};

export const buildRunArgv = (request: RunRequest, context: RunArgvContext) => {
  const argv = [
    context.opencodePath,
    "run",
    "--attach",
    context.attachUrl,
    "--format",
    "json",
    "--dir",
    request.dir,
  ];
  pushOptional(argv, "-m", request.model);
  pushOptional(argv, "--agent", request.agent);
  if (request.continue === true) argv.push("-c");
  pushOptional(argv, "-s", request.session);
  if (request.fork === true) argv.push("--fork");
  pushOptional(argv, "--title", request.title);
  for (const file of request.files ?? []) pushOptional(argv, "-f", file);
  pushOptional(argv, "--variant", request.variant);
  if (request.thinking === true) argv.push("--thinking");
  if (
    (request.dangerouslySkipPermissions ??
      context.defaultDangerouslySkipPermissions) === true
  ) {
    argv.push("--dangerously-skip-permissions");
  }
  pushOptional(argv, "--command", request.command);
  argv.push("--");
  if (request.prompt !== undefined) argv.push(request.prompt);
  return argv;
};

const pushOptional = (
  argv: string[],
  flag: string,
  value: string | undefined,
) => {
  if (value !== undefined) argv.push(flag, value);
};

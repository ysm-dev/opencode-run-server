import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { discover, type Endpoint } from "@opencode/client/service";
import { z } from "zod";
import type { Config } from "../config.js";

const registration = z.object({
  pid: z.number().int().positive(),
  url: z.url(),
});

export const discoverHost = async (
  pid = process.pid,
  state = join(
    process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"),
    "opencode",
  ),
  probe: typeof discover = discover,
): Promise<Endpoint | undefined> => {
  const files = await readdir(state).catch(() => []);
  for (const name of files.filter((name) =>
    /^service(?:-[\w.-]+)?\.json$/.test(name),
  )) {
    const file = join(state, name);
    const raw = await readFile(file, "utf8").catch(() => "");
    const record = z
      .string()
      .transform((text, ctx): unknown => {
        try {
          return JSON.parse(text);
        } catch {
          ctx.addIssue({ code: "custom", message: "invalid JSON" });
          return z.NEVER;
        }
      })
      .pipe(registration)
      .safeParse(raw);
    if (!record.success || record.data.pid !== pid) continue;
    const endpoint = await probe({ file });
    if (endpoint !== undefined && endpoint.url === record.data.url)
      return {
        url: endpoint.url,
        ...(endpoint.auth === undefined ? {} : { auth: endpoint.auth }),
      };
  }
};

export const attachEndpoint = (
  endpoint: Endpoint,
  attach: Config["attach"],
  env: NodeJS.ProcessEnv = process.env,
): Endpoint => {
  const password =
    attach.password ?? env.OPENCODE_SERVER_PASSWORD ?? endpoint.auth?.password;
  const username =
    attach.username ??
    env.OPENCODE_SERVER_USERNAME ??
    endpoint.auth?.username ??
    "opencode";
  return {
    url: endpoint.url,
    ...(password === undefined
      ? {}
      : { auth: { type: "basic", username, password } }),
  };
};

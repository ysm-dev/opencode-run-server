import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../config.js";

const executable = async (path: string) =>
  access(path, constants.X_OK).then(
    () => true,
    () => false,
  );
export const resolveRuntime = async (
  preference: Config["runtime"],
  exists = executable,
  env: NodeJS.ProcessEnv = process.env,
) => {
  const paths = (env.PATH ?? "").split(delimiter);
  if (preference !== "node") {
    for (const path of [
      ...paths.map((path) => join(path, "bun")),
      join(homedir(), ".bun/bin/bun"),
    ]) {
      if (await exists(path)) return path;
    }
    if (preference === "bun")
      throw new Error("runtime bun was requested but bun was not found");
  }
  for (const path of paths.map((path) => join(path, "node")))
    if (await exists(path)) return path;
  throw new Error("node runtime was not found");
};

export const childEntry = (url: string) => {
  const directory = dirname(fileURLToPath(url));
  return resolve(
    directory,
    url.endsWith(".ts") ? "../../dist/compat-server.js" : "compat-server.js",
  );
};

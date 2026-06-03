import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimePreference } from "./config.js";

export type ServerEntries = {
  bun: string;
  node: string;
};

export type ResolvedRuntime = {
  args: string[];
  command: string;
  kind: "bun" | "node";
};

export type ResolveRuntimeDeps = {
  bunWhich?: (
    command: string,
  ) => Promise<string | undefined> | string | undefined;
  commandExists?: (command: string) => Promise<boolean>;
  homeBunPath?: string;
  isExecutable?: (path: string) => Promise<boolean>;
  pathWhich?: (command: string) => Promise<string | undefined>;
  serverEntries?: ServerEntries;
};

export const resolveRuntime = async (
  preference: RuntimePreference,
  deps: ResolveRuntimeDeps = {},
): Promise<ResolvedRuntime> => {
  /* v8 ignore next -- default entry resolution is packaging glue */
  const entries = deps.serverEntries ?? resolveServerEntries(import.meta.url);
  if (preference === "bun" || preference === "auto") {
    const bun = await findBun(deps);
    if (bun !== undefined)
      return { args: [entries.bun], command: bun, kind: "bun" };
    if (preference === "bun")
      throw new Error("runtime bun was requested but bun was not found");
  }
  if (await (deps.commandExists ?? defaultCommandExists)("node")) {
    return { args: [entries.node], command: "node", kind: "node" };
  }
  throw new Error("node runtime was not found");
};

export const resolveServerEntries = (moduleUrl: string): ServerEntries => {
  const directory = dirname(fileURLToPath(moduleUrl));
  if (directory.endsWith("/dist")) {
    return {
      bun: resolve(directory, "../src/server.ts"),
      node: resolve(directory, "server.js"),
    };
  }
  return {
    bun: resolve(directory, "server.ts"),
    node: resolve(directory, "../dist/server.js"),
  };
};

const findBun = async (deps: ResolveRuntimeDeps) => {
  const bunFromGlobal = await maybeBunWhich(deps);
  if (bunFromGlobal !== undefined) return bunFromGlobal;
  /* v8 ignore next -- default home path is environment-dependent */
  const homeBun = deps.homeBunPath ?? resolve(homedir(), ".bun", "bin", "bun");
  if (await (deps.isExecutable ?? defaultIsExecutable)(homeBun)) return homeBun;
  /* v8 ignore next -- default PATH lookup is environment-dependent */
  return (deps.pathWhich ?? whichFromPath)("bun");
};

const maybeBunWhich = async (deps: ResolveRuntimeDeps) => {
  /* v8 ignore next -- Bun global availability depends on the test runtime */
  const which =
    deps.bunWhich ?? (typeof Bun === "undefined" ? undefined : Bun.which);
  if (which === undefined) return undefined;
  const found = await which("bun");
  return found ?? undefined;
};

const defaultCommandExists = async (command: string) =>
  (await whichFromPath(command)) !== undefined;

const defaultIsExecutable = async (path: string) => {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const whichFromPath = async (command: string) => {
  for (const part of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = resolve(part, command);
    if (await defaultIsExecutable(candidate)) return candidate;
  }
  return undefined;
};

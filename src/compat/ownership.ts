import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { stateDirectory } from "../config.js";

const record = z.object({
  pid: z.number().int().positive(),
  parentPid: z.number().int().positive(),
  bind: z.string().min(1),
  port: z.number().int().positive(),
  fingerprint: z.string().min(1),
  startedAt: z.number().int().nonnegative(),
});

export type Ownership = z.infer<typeof record>;

// Identifies the configuration a running listener was started with.
export const fingerprint = (value: unknown) =>
  createHash("sha256").update(stable(value)).digest("hex").slice(0, 16);

export const ownershipFile = (
  bind: string,
  port: number,
  directory = stateDirectory(),
) =>
  join(directory, `listener-${bind.replaceAll(/[^\w.-]/g, "_")}-${port}.json`);

export const readOwnership = async (
  file: string,
): Promise<Ownership | undefined> => {
  const raw = await readFile(file, "utf8").catch(() => undefined);
  if (raw === undefined) return undefined;
  const parsed = record.safeParse(parse(raw));
  return parsed.success ? parsed.data : undefined;
};

export const writeOwnership = async (file: string, value: Ownership) => {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value)}\n`, "utf8");
};

export const clearOwnership = async (file: string, pid: number) => {
  const current = await readOwnership(file);
  if (current !== undefined && current.pid !== pid) return;
  await rm(file, { force: true });
};

// Signal zero reports liveness; a foreign owner answers with EPERM.
export const running = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EPERM"
    );
  }
};

const parse = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
};

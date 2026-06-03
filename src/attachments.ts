import {
  mkdtemp as nodeMkdtemp,
  rm as nodeRm,
  writeFile as nodeWriteFile,
} from "node:fs/promises";
import { tmpdir as nodeTmpdir } from "node:os";
import { join } from "node:path";
import type { InlineFile } from "./request.js";

export type MaterializedAttachments = {
  cleanup: () => Promise<void>;
  paths: string[];
};

export type MaterializeInlineFiles = (
  files: InlineFile[] | undefined,
) => Promise<MaterializedAttachments>;

type RmOptions = { force: boolean; recursive: boolean };

export type MaterializeDeps = {
  mkdtemp?: (prefix: string) => Promise<string>;
  rm?: (path: string, options: RmOptions) => Promise<void>;
  tmpdir?: () => string;
  writeFile?: (path: string, data: Buffer) => Promise<void>;
};

const noop = async () => {};

/**
 * Decode caller-supplied inline files (base64) into a unique per-run temporary
 * directory on the host and return their absolute paths plus an idempotent
 * cleanup that removes the directory once the run has finished. The paths are
 * passed to `opencode run` as additional `-f` attachments.
 */
export const materializeInlineFiles = async (
  files: InlineFile[] | undefined,
  deps: MaterializeDeps = {},
): Promise<MaterializedAttachments> => {
  if (files === undefined || files.length === 0)
    return { cleanup: noop, paths: [] };
  const mkdtemp = deps.mkdtemp ?? ((prefix: string) => nodeMkdtemp(prefix));
  const writeFile =
    deps.writeFile ??
    ((path: string, data: Buffer) => nodeWriteFile(path, data));
  const rm =
    deps.rm ?? ((path: string, options: RmOptions) => nodeRm(path, options));
  const tmpdir = deps.tmpdir ?? nodeTmpdir;
  const dir = await mkdtemp(join(tmpdir(), "ors-run-"));
  const cleanup = createCleanup(dir, rm);
  try {
    return { cleanup, paths: await writeAll(files, dir, writeFile) };
  } catch (error) {
    await cleanup();
    throw error;
  }
};

const writeAll = async (
  files: InlineFile[],
  dir: string,
  writeFile: (path: string, data: Buffer) => Promise<void>,
) => {
  const paths: string[] = [];
  for (const [index, file] of files.entries()) {
    const path = join(dir, `${index}-${file.filename}`);
    await writeFile(path, Buffer.from(file.content, "base64"));
    paths.push(path);
  }
  return paths;
};

const createCleanup = (
  dir: string,
  rm: (path: string, options: RmOptions) => Promise<void>,
) => {
  let removed = false;
  return async () => {
    if (removed) return;
    removed = true;
    await rm(dir, { force: true, recursive: true });
  };
};

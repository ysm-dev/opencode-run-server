import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

type LogLevel = "debug" | "info" | "warn" | "error";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

type LogFields = Record<string, JsonValue>;

export type FileLoggerOptions = {
  file: string;
  level: LogLevel;
  maxFiles: number;
  maxSize: string;
  secrets: string[];
};

export type Logger = {
  debug: (message: string, fields?: LogFields) => Promise<void>;
  error: (message: string, fields?: LogFields) => Promise<void>;
  info: (message: string, fields?: LogFields) => Promise<void>;
  warn: (message: string, fields?: LogFields) => Promise<void>;
};

const weights: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export const redactSecrets = (value: string, secrets: string[]) => {
  let redacted = value.replace(
    /Authorization:\s*Bearer\s+[^\s"']+/gi,
    "Authorization: Bearer [REDACTED]",
  );
  for (const secret of secrets.filter((item) => item.length > 0)) {
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
};

export const createFileLogger = (options: FileLoggerOptions): Logger => {
  const maxBytes = parseSize(options.maxSize);
  const write = async (
    level: LogLevel,
    message: string,
    fields: LogFields = {},
  ) => {
    if (weights[level] < weights[options.level]) return;
    const line = `${redactSecrets(JSON.stringify({ time: new Date().toISOString(), level, message, ...fields }), options.secrets)}\n`;
    await mkdir(dirname(options.file), { recursive: true });
    await rotateIfNeeded(
      options.file,
      maxBytes,
      options.maxFiles,
      Buffer.byteLength(line),
    );
    await appendFile(options.file, line, "utf8");
  };
  return {
    debug: (message, fields) => write("debug", message, fields),
    error: (message, fields) => write("error", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
  };
};

const parseSize = (value: string) => {
  const match = /^(\d+)([kKmM]?)$/.exec(value.trim());
  if (match === null) throw new Error(`invalid log size: ${value}`);
  const amount = Number.parseInt(match[1] ?? "0", 10);
  const suffix = match[2]?.toLowerCase();
  if (suffix === "m") return amount * 1024 * 1024;
  if (suffix === "k") return amount * 1024;
  return amount;
};

const rotateIfNeeded = async (
  file: string,
  maxBytes: number,
  maxFiles: number,
  incomingBytes: number,
) => {
  const current = await stat(file).catch(() => undefined);
  if (current === undefined || current.size + incomingBytes <= maxBytes) return;
  if (maxFiles <= 1) {
    await rm(file, { force: true });
    return;
  }
  await rm(`${file}.${maxFiles - 1}`, { force: true });
  for (let index = maxFiles - 2; index >= 1; index -= 1) {
    await renameIfExists(`${file}.${index}`, `${file}.${index + 1}`);
  }
  await renameIfExists(file, `${file}.1`);
};

const renameIfExists = async (from: string, to: string) => {
  await rename(from, to).catch((error) => {
    /* v8 ignore next -- non-ENOENT rename failures are surfaced by fs */
    if (errorCode(error) !== "ENOENT") throw error;
  });
};

const errorCode = (error: unknown) => {
  if (typeof error === "object" && error !== null && "code" in error)
    return String(error.code);
  /* v8 ignore next -- fs errors always expose code in supported runtimes */
  return undefined;
};

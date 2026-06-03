import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFileLogger, redactSecrets } from "./log.js";

describe("structured logging", () => {
  it("redacts tokens, passwords, bearer headers, and output tails", () => {
    const text = "Authorization: Bearer tok and password pw in tail";

    expect(redactSecrets(text, ["tok", "pw"])).toBe(
      "Authorization: Bearer [REDACTED] and password [REDACTED] in tail",
    );
  });

  it("writes redacted JSON lines to the configured rotating file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ors-log-"));
    const file = join(dir, "server.log");
    const logger = createFileLogger({
      file,
      level: "debug",
      maxFiles: 2,
      maxSize: "1k",
      secrets: ["secret"],
    });

    await logger.info("accepted", { requestId: "rq_1", tail: "secret" });
    const content = await readFile(file, "utf8");

    expect(content).toContain('"message":"accepted"');
    expect(content).toContain("[REDACTED]");
    expect(content).not.toContain("secret");
  });

  it("filters lower log levels", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ors-log-"));
    const file = join(dir, "server.log");
    const logger = createFileLogger({
      file,
      level: "warn",
      maxFiles: 2,
      maxSize: "1k",
      secrets: [],
    });

    await logger.debug("debug");
    await logger.info("info");
    await expect(readFile(file, "utf8")).rejects.toThrow();

    await logger.warn("warn");
    expect(await readFile(file, "utf8")).toContain("warn");
  });

  it("rotates files when the active log exceeds maxSize", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ors-log-"));
    const file = join(dir, "server.log");
    const logger = createFileLogger({
      file,
      level: "debug",
      maxFiles: 2,
      maxSize: "80",
      secrets: [],
    });

    await logger.info("first", { tail: "x".repeat(100) });
    await logger.info("second", { tail: "y".repeat(100) });

    expect(await readFile(`${file}.1`, "utf8")).toContain("first");
    expect(await readFile(file, "utf8")).toContain("second");
  });

  it("supports one retained file by deleting the active log before writing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ors-log-"));
    const file = join(dir, "server.log");
    const logger = createFileLogger({
      file,
      level: "debug",
      maxFiles: 1,
      maxSize: "80",
      secrets: [],
    });

    await logger.error("first", { tail: "x".repeat(100) });
    await logger.error("second", { tail: "y".repeat(100) });

    expect(await readFile(file, "utf8")).toContain("second");
    await expect(readFile(`${file}.1`, "utf8")).rejects.toThrow();
  });

  it("keeps the configured number of rotated files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ors-log-"));
    const file = join(dir, "server.log");
    const logger = createFileLogger({
      file,
      level: "debug",
      maxFiles: 3,
      maxSize: "80",
      secrets: [],
    });

    await logger.info("first", { tail: "x".repeat(100) });
    await logger.info("second", { tail: "y".repeat(100) });
    await logger.info("third", { tail: "z".repeat(100) });

    expect(await readFile(`${file}.2`, "utf8")).toContain("first");
    expect(await readFile(`${file}.1`, "utf8")).toContain("second");
    expect(await readFile(file, "utf8")).toContain("third");
  });

  it("rejects invalid size strings", () => {
    expect(() =>
      createFileLogger({
        file: "x",
        level: "debug",
        maxFiles: 1,
        maxSize: "bad",
        secrets: [],
      }),
    ).toThrow("invalid log size");
  });

  it("accepts megabyte log size suffixes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ors-log-"));
    const file = join(dir, "server.log");
    const logger = createFileLogger({
      file,
      level: "debug",
      maxFiles: 1,
      maxSize: "1m",
      secrets: [],
    });

    await logger.info("ok");
    expect(await readFile(file, "utf8")).toContain("ok");
  });
});

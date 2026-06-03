import { readFile, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { materializeInlineFiles } from "./attachments.js";

const base64 = (value: string) => Buffer.from(value).toString("base64");

describe("materializeInlineFiles", () => {
  it("returns no paths and a no-op cleanup for empty input", async () => {
    const empty = await materializeInlineFiles(undefined);
    expect(empty.paths).toEqual([]);
    await expect(empty.cleanup()).resolves.toBeUndefined();

    const none = await materializeInlineFiles([]);
    expect(none.paths).toEqual([]);
  });

  it("decodes files to a temp dir and removes it on cleanup", async () => {
    const result = await materializeInlineFiles([
      { content: base64("hello"), filename: "a.png" },
      { content: base64("world"), filename: "b.txt" },
    ]);

    const [first, second] = result.paths;
    if (first === undefined || second === undefined)
      throw new Error("expected two materialized paths");
    expect(first).toMatch(/[/\\]ors-run-[^/\\]+[/\\]0-a\.png$/);
    expect(second).toMatch(/1-b\.txt$/);
    expect(await readFile(first, "utf8")).toBe("hello");
    expect(await readFile(second, "utf8")).toBe("world");

    await result.cleanup();
    await expect(stat(first)).rejects.toThrow();
  });

  it("cleans up the temp dir when a write fails", async () => {
    const removed: string[] = [];
    await expect(
      materializeInlineFiles([{ content: "AAAA", filename: "a.png" }], {
        mkdtemp: async () => "/tmp/ors-run-fake",
        rm: async (path) => {
          removed.push(path);
        },
        tmpdir: () => "/tmp",
        writeFile: async () => {
          throw new Error("disk full");
        },
      }),
    ).rejects.toThrow("disk full");
    expect(removed).toEqual(["/tmp/ors-run-fake"]);
  });

  it("removes the temp dir only once across repeated cleanup calls", async () => {
    const removed: string[] = [];
    const result = await materializeInlineFiles(
      [{ content: "AAAA", filename: "a.png" }],
      {
        mkdtemp: async () => "/tmp/ors-run-fake",
        rm: async (path) => {
          removed.push(path);
        },
        tmpdir: () => "/tmp",
        writeFile: async () => {},
      },
    );

    await result.cleanup();
    await result.cleanup();
    expect(removed).toEqual(["/tmp/ors-run-fake"]);
  });
});

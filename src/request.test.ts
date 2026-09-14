import { describe, expect, it } from "vitest";
import { attachments } from "./attachments.js";
import { modelRef, runRequestSchema } from "./request.js";
import { RunServer } from "./rpc.js";

describe("v2 run contract", () => {
  it("requires a prompt or command and rejects removed v1 fields", () => {
    expect(runRequestSchema.safeParse({}).success).toBe(false);
    for (const field of [
      "dir",
      "continue",
      "fork",
      "thinking",
      "attach",
      "format",
      "port",
    ]) {
      expect(
        runRequestSchema.safeParse({ prompt: "test", [field]: true }).success,
      ).toBe(false);
    }
    expect(runRequestSchema.parse({ command: "review" })).toEqual({
      command: "review",
    });
    expect(
      runRequestSchema.parse({ prompt: "-literal", title: "--title" }).title,
    ).toBe("--title");
  });

  it("validates model references and bounded timeouts", () => {
    for (const model of [
      "model",
      "/model",
      "provider/",
      "provider/model#",
      "provider/model#high#low",
    ]) {
      expect(
        runRequestSchema.safeParse({ prompt: "test", model }).success,
      ).toBe(false);
    }
    for (const timeoutMs of [0, -1, 1.5, 2_147_483_648]) {
      expect(
        runRequestSchema.safeParse({ prompt: "test", timeoutMs }).success,
      ).toBe(false);
    }
    expect(modelRef("provider/org/model#high")).toEqual({
      providerID: "provider",
      id: "org/model",
      variant: "high",
    });
    expect(modelRef("provider/model")).toEqual({
      providerID: "provider",
      id: "model",
    });
    expect(modelRef("provider/model#high", "low").variant).toBe("low");
  });

  it("validates inline filenames and canonical base64", () => {
    for (const filename of ["../a", "a/b", "a\\b", "\0", ".", "..", ""]) {
      expect(
        runRequestSchema.safeParse({
          prompt: "test",
          inlineFiles: [{ filename, content: "YQ==" }],
        }).success,
      ).toBe(false);
    }
    for (const content of ["YQ", "YQ==\n", "YR==", "%%%%", ""]) {
      expect(
        runRequestSchema.safeParse({
          prompt: "test",
          inlineFiles: [{ filename: "a", content }],
        }).success,
      ).toBe(false);
    }
  });

  it("maps host files and inline files to native URI attachments", () => {
    expect(attachments({ prompt: "test" }, "/project")).toEqual([]);
    expect(
      attachments(
        {
          files: ["a b.txt", "/absolute/image.png"],
          inlineFiles: [{ filename: "note.txt", content: "YQ==" }],
        },
        "/project",
      ),
    ).toEqual([
      { uri: "file:///project/a%20b.txt", name: "a b.txt" },
      { uri: "file:///absolute/image.png", name: "image.png" },
      { uri: "data:application/octet-stream;base64,YQ==", name: "note.txt" },
    ]);
  });

  it("exports the typed RPC definition with explicit schemas and errors", () => {
    expect(RunServer.id).toBe("opencode-run-server");
    expect(RunServer.methods.status.input.parse(undefined)).toBeUndefined();
    expect(() =>
      RunServer.methods.status.input.parse({ unexpected: true }),
    ).toThrow();
    expect(Object.keys(RunServer.methods.run.errors)).toEqual([
      "queue_full",
      "input_too_large",
      "start_failed",
    ]);
  });
});

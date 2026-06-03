import { describe, expect, it } from "vitest";
import { buildRunArgv, parseRunRequest } from "./request.js";

const context = {
  attachUrl: "http://127.0.0.1:4096/",
  defaultDangerouslySkipPermissions: false,
  opencodePath: "/opt/opencode",
};

describe("run request validation and argv mapping", () => {
  it("maps every whitelisted field to an argv array without a shell", () => {
    const parsed = parseRunRequest({
      dir: "/repo",
      prompt: "fix bug",
      model: "anthropic/claude",
      agent: "builder",
      continue: true,
      title: "Bug fix",
      files: ["src/a.ts", "src/b.ts"],
      variant: "high",
      thinking: true,
      dangerouslySkipPermissions: true,
    });

    if (!parsed.ok) throw new Error(parsed.error);

    expect(buildRunArgv(parsed.value, context)).toEqual([
      "/opt/opencode",
      "run",
      "--attach",
      "http://127.0.0.1:4096/",
      "--format",
      "json",
      "--dir",
      "/repo",
      "-m",
      "anthropic/claude",
      "--agent",
      "builder",
      "-c",
      "--title",
      "Bug fix",
      "-f",
      "src/a.ts",
      "-f",
      "src/b.ts",
      "--variant",
      "high",
      "--thinking",
      "--dangerously-skip-permissions",
      "--",
      "fix bug",
    ]);
  });

  it("appends materialized attachment paths as -f after host files", () => {
    const parsed = parseRunRequest({
      dir: "/repo",
      files: ["src/a.ts"],
      prompt: "hi",
    });
    if (!parsed.ok) throw new Error(parsed.error);

    expect(
      buildRunArgv(parsed.value, {
        ...context,
        extraFiles: ["/tmp/ors-run-x/0-shot.png"],
      }).join(" "),
    ).toContain("-f src/a.ts -f /tmp/ors-run-x/0-shot.png");
  });

  it("accepts inline files and rejects malformed content or filenames", () => {
    const valid = parseRunRequest({
      dir: "/repo",
      inlineFiles: [{ content: "AAAA", filename: "shot.png" }],
      prompt: "hi",
    });
    expect(valid.ok).toBe(true);

    const bad = (filename: string, content: string) =>
      parseRunRequest({
        dir: "/repo",
        inlineFiles: [{ content, filename }],
        prompt: "hi",
      }).ok;

    expect(bad("shot.png", "not base64!!")).toBe(false);
    expect(bad("shot.png", "AAA")).toBe(false);
    expect(bad("../escape.png", "AAAA")).toBe(false);
    expect(bad("sub/shot.png", "AAAA")).toBe(false);
    expect(bad("-shot.png", "AAAA")).toBe(false);
    expect(
      parseRunRequest({
        dir: "/repo",
        inlineFiles: [{ content: "AAAA", filename: "shot.png", mime: "x" }],
        prompt: "hi",
      }).ok,
    ).toBe(false);
  });

  it("permits prompts beginning with dashes by inserting -- first", () => {
    const parsed = parseRunRequest({ dir: "/repo", prompt: "--share secrets" });
    if (!parsed.ok) throw new Error(parsed.error);

    expect(buildRunArgv(parsed.value, context).slice(-2)).toEqual([
      "--",
      "--share secrets",
    ]);
  });

  it("supports slash-command runs without a prompt", () => {
    const parsed = parseRunRequest({ dir: "/repo", command: "commit" });
    if (!parsed.ok) throw new Error(parsed.error);

    expect(buildRunArgv(parsed.value, context).slice(-3)).toEqual([
      "--command",
      "commit",
      "--",
    ]);
  });

  it("rejects unknown, forbidden, and flag-injection fields", () => {
    expect(parseRunRequest({ dir: "/repo", prompt: "x", share: true }).ok).toBe(
      false,
    );
    expect(
      parseRunRequest({ dir: "/repo", prompt: "x", format: "text" }).ok,
    ).toBe(false);
    expect(parseRunRequest({ dir: "-rf", prompt: "x" }).ok).toBe(false);
    expect(
      parseRunRequest({ dir: "/repo", prompt: "x", files: ["--flag"] }).ok,
    ).toBe(false);
  });

  it("requires prompt or command and requires fork to target a session", () => {
    expect(parseRunRequest({ dir: "/repo" }).ok).toBe(false);
    expect(parseRunRequest({ dir: "/repo", prompt: "x", fork: true }).ok).toBe(
      false,
    );
    expect(
      parseRunRequest({ dir: "/repo", prompt: "x", session: "ses", fork: true })
        .ok,
    ).toBe(true);
  });
});

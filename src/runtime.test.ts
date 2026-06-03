import { describe, expect, it } from "vitest";
import { resolveRuntime, resolveServerEntries } from "./runtime.js";

describe("resolveRuntime", () => {
  it("prefers bun in auto mode", async () => {
    await expect(
      resolveRuntime("auto", {
        commandExists: async (command) => command === "node",
        homeBunPath: "/home/me/.bun/bin/bun",
        isExecutable: async () => false,
        pathWhich: async (command) =>
          command === "bun" ? "/usr/bin/bun" : undefined,
        serverEntries: {
          bun: "/pkg/src/server.ts",
          node: "/pkg/dist/server.js",
        },
      }),
    ).resolves.toEqual({
      command: "/usr/bin/bun",
      args: ["/pkg/src/server.ts"],
      kind: "bun",
    });
  });

  it("falls back to node and the prebuilt server bundle", async () => {
    await expect(
      resolveRuntime("auto", {
        commandExists: async (command) => command === "node",
        homeBunPath: "/home/me/.bun/bin/bun",
        isExecutable: async () => false,
        pathWhich: async () => undefined,
        serverEntries: {
          bun: "/pkg/src/server.ts",
          node: "/pkg/dist/server.js",
        },
      }),
    ).resolves.toEqual({
      command: "node",
      args: ["/pkg/dist/server.js"],
      kind: "node",
    });
  });

  it("uses Bun.which before other bun lookup paths", async () => {
    await expect(
      resolveRuntime("bun", {
        bunWhich: () => "/opt/bun",
        serverEntries: {
          bun: "/pkg/src/server.ts",
          node: "/pkg/dist/server.js",
        },
      }),
    ).resolves.toEqual({
      command: "/opt/bun",
      args: ["/pkg/src/server.ts"],
      kind: "bun",
    });
  });

  it("uses ~/.bun/bin/bun when it is executable", async () => {
    await expect(
      resolveRuntime("auto", {
        homeBunPath: "/home/me/.bun/bin/bun",
        isExecutable: async (path) => path.endsWith("/bun"),
        serverEntries: {
          bun: "/pkg/src/server.ts",
          node: "/pkg/dist/server.js",
        },
      }),
    ).resolves.toEqual({
      command: "/home/me/.bun/bin/bun",
      args: ["/pkg/src/server.ts"],
      kind: "bun",
    });
  });

  it("throws when an explicitly requested runtime cannot be found", async () => {
    await expect(
      resolveRuntime("bun", {
        isExecutable: async () => false,
        pathWhich: async () => undefined,
        serverEntries: {
          bun: "/pkg/src/server.ts",
          node: "/pkg/dist/server.js",
        },
      }),
    ).rejects.toThrow("bun was not found");

    await expect(
      resolveRuntime("node", {
        commandExists: async () => false,
        serverEntries: {
          bun: "/pkg/src/server.ts",
          node: "/pkg/dist/server.js",
        },
      }),
    ).rejects.toThrow("node runtime was not found");
  });

  it("resolves source and dist server entry paths relative to the plugin module", () => {
    expect(resolveServerEntries("file:///pkg/dist/plugin.js")).toEqual({
      bun: "/pkg/src/server.ts",
      node: "/pkg/dist/server.js",
    });
    expect(resolveServerEntries("file:///pkg/src/plugin.ts")).toEqual({
      bun: "/pkg/src/server.ts",
      node: "/pkg/dist/server.js",
    });
  });

  it("uses PATH when no runtime lookup seam is injected", async () => {
    await expect(
      resolveRuntime("node", {
        serverEntries: {
          bun: "/pkg/src/server.ts",
          node: "/pkg/dist/server.js",
        },
      }),
    ).resolves.toEqual({
      command: "node",
      args: ["/pkg/dist/server.js"],
      kind: "node",
    });
  });

  it("reports node missing when PATH lookup fails", async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = "";
    await expect(
      resolveRuntime("node", {
        serverEntries: {
          bun: "/pkg/src/server.ts",
          node: "/pkg/dist/server.js",
        },
      }),
    ).rejects.toThrow("node runtime was not found");
    process.env.PATH = originalPath;
  });

  it("handles an undefined PATH during runtime lookup", async () => {
    const originalPath = process.env.PATH;
    delete process.env.PATH;
    await expect(
      resolveRuntime("node", {
        serverEntries: {
          bun: "/pkg/src/server.ts",
          node: "/pkg/dist/server.js",
        },
      }),
    ).rejects.toThrow("node runtime was not found");
    process.env.PATH = originalPath;
  });
});

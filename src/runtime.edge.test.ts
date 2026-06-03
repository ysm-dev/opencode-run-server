import { expect, it } from "vitest";
import { resolveRuntime } from "./runtime.js";

it("continues runtime lookup when Bun.which returns nothing", async () => {
  await expect(
    resolveRuntime("auto", {
      bunWhich: () => undefined,
      commandExists: async (command) => command === "node",
      homeBunPath: "/home/me/.bun/bin/bun",
      isExecutable: async () => false,
      pathWhich: async (command) =>
        command === "bun" ? "/usr/local/bin/bun" : undefined,
      serverEntries: {
        bun: "/pkg/src/server.ts",
        node: "/pkg/dist/server.js",
      },
    }),
  ).resolves.toEqual({
    args: ["/pkg/src/server.ts"],
    command: "/usr/local/bin/bun",
    kind: "bun",
  });
});

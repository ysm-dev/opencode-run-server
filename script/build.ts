import { rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
const result = await Bun.build({
  entrypoints: ["src/plugin.ts", "src/rpc.ts", "src/compat-server.ts"],
  outdir: "dist",
  target: "node",
  packages: "external",
});
if (!result.success) throw new AggregateError(result.logs, "Build failed");
const declarations = Bun.spawn(
  ["bun", "run", "tsgo", "-p", "tsconfig.build.json"],
  {
    stdout: "inherit",
    stderr: "inherit",
  },
);
if ((await declarations.exited) !== 0)
  throw new Error("Declaration build failed");

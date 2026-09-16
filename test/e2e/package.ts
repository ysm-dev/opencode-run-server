import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pkg from "../../package.json" with { type: "json" };
import { RunServer } from "../../src/rpc.js";
import { verifyEviction } from "./eviction.js";
import { installPublished } from "./install.js";
import { verifyLegacy } from "./legacy.js";
import { verify } from "./scenarios.js";

const repository = resolve(import.meta.dir, "../..");
const published = process.argv.includes("--published");
const root = await realpath(await mkdtemp(join(tmpdir(), "ors-package-")));
await Promise.all([mkdir(join(root, "project")), mkdir(join(root, "config"))]);
for (const name of ["CONFIG", "DATA", "STATE", "CACHE"]) {
  process.env[`XDG_${name}_HOME`] = join(root, name.toLowerCase());
}
delete process.env.OPENCODE_CONFIG;
delete process.env.OPENCODE_CONFIG_CONTENT;

async function command(args: string[], cwd: string) {
  const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  assert.equal(code, 0, `${args.join(" ")}\n${out}\n${err}`);
}

try {
  if (!published)
    await command(["bun", "pm", "pack", "--destination", root], repository);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        [pkg.name]: published
          ? pkg.version
          : `file:${join(root, `${pkg.name}-${pkg.version}.tgz`)}`,
        "@opencode/client": "2.0.3",
      },
    }),
  );
  const install = () =>
    command(
      [
        "bun",
        "install",
        "--ignore-scripts",
        ...(published ? ["--no-cache"] : []),
      ],
      root,
    );
  if (published) await installPublished(install, pkg);
  else await install();
  const installed = join(root, "node_modules/opencode-run-server");
  const manifest = JSON.parse(
    await readFile(join(installed, "package.json"), "utf8"),
  );
  assert.equal(manifest.version, pkg.version);
  await readFile(join(installed, "dist/plugin.d.ts"));
  await readFile(join(installed, "dist/rpc.d.ts"));
  const contract = await import(
    pathToFileURL(join(installed, "dist/rpc.js")).href
  );
  assert.equal(contract.RunServer.id, RunServer.id);
  await writeFile(
    join(root, "consumer.ts"),
    `
import plugin from "opencode-run-server";
import { RunServer } from "opencode-run-server/rpc";
import { OpenCode } from "@opencode/client";
const rpc = OpenCode.make({ baseUrl: "http://localhost:4096" }).rpc(RunServer);
const queued: boolean = (await rpc.run({ prompt: "test" })).queued;
const id: string = plugin.id;
// @ts-expect-error RPC contract must reject non-string prompts.
await rpc.run({ prompt: 123 });
void queued; void id;
`,
  );
  await command(
    [
      join(repository, "node_modules/.bin/tsgo"),
      "--noEmit",
      "--strict",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "ES2024",
      "--skipLibCheck",
      "consumer.ts",
    ],
    root,
  );
  await verify(root, installed);
  await verifyLegacy(root, installed, "node");
  await verifyLegacy(root, installed, "bun");
  await verifyEviction(root, installed);
  console.log(
    `Verified ${published ? "npm-published" : "locally packed"} ${pkg.name}@${pkg.version}: declarations, RPC, sessions, commands, attachments, permissions, queueing, timeout, idle eviction and unload.`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

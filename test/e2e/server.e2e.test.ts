import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServerConfig, serializeServerEnv } from "../../src/config.js";

const children: ReturnType<typeof spawn>[] = [];

afterEach(() => {
  for (const child of children) child.kill("SIGKILL");
  children.length = 0;
});

describe("server subprocess e2e", () => {
  it("accepts /run, spawns fake opencode with the mapped argv, and exits when main dies", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ors-e2e-"));
    const argvFile = join(dir, "argv.json");
    const fakeOpencode = join(dir, "opencode");
    await writeFile(fakeOpencode, fakeOpencodeScript(argvFile), "utf8");
    await chmod(fakeOpencode, 0o755);

    const main = createServer((_request, response) => {
      response.writeHead(401);
      response.end("auth required");
    });
    await listen(main, 0, "127.0.0.1");
    const mainPort = addressPort(main);
    const port = await reservePort();
    const config = await createServerConfig(
      {
        bind: "127.0.0.1",
        healthCheck: { failureThreshold: 2, intervalMs: 50, timeoutMs: 1000 },
        opencodePath: fakeOpencode,
        port,
        runTimeoutMs: 5000,
        shutdownGraceMs: 10,
      },
      { execPath: fakeOpencode },
    );

    const child = spawn("bun", ["src/server.ts"], {
      cwd: process.cwd(),
      env: serializeServerEnv(config, `http://127.0.0.1:${mainPort}/`),
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    await waitForHttp(`http://127.0.0.1:${port}/health`);

    const response = await fetch(`http://127.0.0.1:${port}/run`, {
      body: JSON.stringify({ dir, prompt: "hello" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(202);
    await waitForFile(argvFile);
    const argv = JSON.parse(await readFile(argvFile, "utf8"));
    expect(argv).toContain("--attach");
    expect(argv).toContain(`http://127.0.0.1:${mainPort}/`);

    await close(main);
    await waitForExit(child, 3000);
  }, 15_000);

  it("decodes inline files to disk and attaches them via -f", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ors-e2e-"));
    const argvFile = join(dir, "argv.json");
    const attachFile = join(dir, "attachments.json");
    const fakeOpencode = join(dir, "opencode");
    await writeFile(
      fakeOpencode,
      fakeOpencodeWithAttachments(argvFile, attachFile),
      "utf8",
    );
    await chmod(fakeOpencode, 0o755);

    const main = createServer((_request, response) => {
      response.writeHead(401);
      response.end("auth required");
    });
    await listen(main, 0, "127.0.0.1");
    const mainPort = addressPort(main);
    const port = await reservePort();
    const config = await createServerConfig(
      {
        bind: "127.0.0.1",
        healthCheck: { failureThreshold: 2, intervalMs: 50, timeoutMs: 1000 },
        opencodePath: fakeOpencode,
        port,
        runTimeoutMs: 5000,
        shutdownGraceMs: 10,
      },
      { execPath: fakeOpencode },
    );

    const child = spawn("bun", ["src/server.ts"], {
      cwd: process.cwd(),
      env: serializeServerEnv(config, `http://127.0.0.1:${mainPort}/`),
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    await waitForHttp(`http://127.0.0.1:${port}/health`);

    const response = await fetch(`http://127.0.0.1:${port}/run`, {
      body: JSON.stringify({
        dir,
        inlineFiles: [
          {
            content: Buffer.from("PNGDATA").toString("base64"),
            filename: "shot.png",
          },
        ],
        prompt: "describe",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(response.status).toBe(202);

    await waitForFile(attachFile);
    expect(JSON.parse(await readFile(attachFile, "utf8"))).toEqual(["PNGDATA"]);
    const argv = JSON.parse(await readFile(argvFile, "utf8")) as string[];
    expect(argv).toContain("-f");
    expect(argv.some((value) => value.endsWith("0-shot.png"))).toBe(true);

    await close(main);
    await waitForExit(child, 3000);
  }, 15_000);
});

const fakeOpencodeScript = (argvFile: string) => `#!${process.execPath}
const { writeFileSync } = require("node:fs")
writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)))
console.log(JSON.stringify({ type: "session", sessionID: "ses_1" }))
`;

const fakeOpencodeWithAttachments = (argvFile: string, attachFile: string) =>
  `#!${process.execPath}
const { writeFileSync, readFileSync } = require("node:fs")
const argv = process.argv.slice(2)
writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(argv))
const contents = []
for (let i = 0; i < argv.length - 1; i += 1) {
  if (argv[i] === "-f") contents.push(readFileSync(argv[i + 1], "utf8"))
}
writeFileSync(${JSON.stringify(attachFile)}, JSON.stringify(contents))
console.log(JSON.stringify({ type: "session", sessionID: "ses_1" }))
`;

const reservePort = async () => {
  const server = createServer();
  await listen(server, 0, "127.0.0.1");
  const port = addressPort(server);
  await close(server);
  return port;
};

const listen = (
  server: ReturnType<typeof createServer>,
  port: number,
  host: string,
) => new Promise<void>((resolve) => server.listen(port, host, resolve));

const close = (server: ReturnType<typeof createServer>) =>
  new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );

const addressPort = (server: ReturnType<typeof createServer>) => {
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("expected TCP address");
  return address.port;
};

const waitForHttp = async (url: string) => {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`server did not become ready: ${url}`);
};

const waitForFile = async (path: string) => {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    try {
      await readFile(path, "utf8");
      return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`file was not written: ${path}`);
};

const waitForExit = (child: ReturnType<typeof spawn>, timeoutMs: number) =>
  new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("child did not exit")),
      timeoutMs,
    );
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });

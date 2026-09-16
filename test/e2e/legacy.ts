import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { RunServer } from "../../src/rpc.js";
import { createLegacyHost } from "./legacy-host.js";

const statsSchema = z.object({
  version: z.string(),
  opencodePath: z.string(),
  mainServer: z.object({ url: z.string(), healthy: z.boolean() }),
  runs: z.object({
    active: z.number(),
    queued: z.number(),
    total: z.number(),
    failed: z.number(),
  }),
});
const acceptedSchema = z
  .object({
    queued: z.boolean(),
    requestId: z.string(),
    status: z.literal("accepted"),
  })
  .strict();

export const verifyLegacy = async (
  root: string,
  installed: string,
  runtime: "bun" | "node",
) => {
  const f = await createLegacyHost(root, installed, runtime);
  const authorization = "Bearer legacy-secret";
  const status = async () =>
    statsSchema.parse(
      await (
        await fetch(`${f.base}/status`, { headers: { authorization } })
      ).json(),
    );
  const post = (input: object) =>
    fetch(`${f.base}/run`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ dir: f.directory, ...input }),
    });
  const idle = async () => {
    const deadline = Date.now() + 10_000;
    while (true) {
      const value = await status();
      if (value.runs.active === 0 && value.runs.queued === 0) return value;
      assert.ok(Date.now() < deadline, "Legacy queue did not become idle");
      await Bun.sleep(20);
    }
  };
  try {
    const deadline = Date.now() + 10_000;
    while (
      !(await fetch(`${f.base}/health`).then(
        (response) => response.ok,
        () => false,
      ))
    ) {
      assert.ok(Date.now() < deadline, "Legacy listener failed to start");
      await Bun.sleep(20);
    }
    assert.equal((await fetch(`${f.base}/status`)).status, 401);
    assert.equal((await fetch(`${f.base}/run`)).status, 405);
    assert.equal(
      (await fetch(`${f.base}/health`, { method: "POST" })).status,
      405,
    );
    assert.equal((await status()).opencodePath, "/legacy/opencode");
    assert.equal((await status()).mainServer.url, f.url);
    assert.equal((await status()).version, "0.3.1");
    await verifySessions(f, post, idle);

    f.block();
    assert.equal((await post({ prompt: "Blocked" })).status, 202);
    const other = join(f.directory, "other");
    await mkdir(other);
    const queued = await post({ dir: other, prompt: "Queued elsewhere" });
    assert.equal(queued.status, 202);
    assert.equal(acceptedSchema.parse(await queued.json()).queued, true);
    const full = await post({ prompt: "Overflow" });
    assert.equal(full.status, 503);
    assert.equal(full.headers.get("retry-after"), "1");
    assert.equal(
      z.object({ code: z.string() }).parse(await full.json()).code,
      "QUEUE_FULL",
    );
    f.release();
    await idle();
    assert.equal(
      (await f.client.session.list({ directory: other })).data.length,
      1,
    );
    assert.equal((await post({ prompt: "x".repeat(5000) })).status, 413);
    assert.equal((await post({ prompt: "bad", fork: true })).status, 400);
    assert.equal((await post({ prompt: "bad", unknown: true })).status, 400);
    assert.equal(
      (await post({ prompt: "bad", session: "ses_missing" })).status,
      500,
    );

    assert.equal(
      (await post({ prompt: "RUN_TOOL", title: "legacy-denied" })).status,
      202,
    );
    await idle();
    await assert.rejects(readFile(join(f.directory, "permission.txt")), {
      code: "ENOENT",
    });
    assert.equal(
      (await post({ prompt: "RUN_TOOL", dangerouslySkipPermissions: true }))
        .status,
      202,
    );
    await idle();
    assert.equal(
      await readFile(join(f.directory, "permission.txt"), "utf8"),
      "Legacy permission verified",
    );
    await rm(join(f.directory, "permission.txt"));
    const failed = (await status()).runs.failed;
    f.block();
    assert.equal(
      (await post({ prompt: "Timeout", timeoutMs: 200 })).status,
      202,
    );
    assert.equal((await idle()).runs.failed, failed + 1);
    f.release();
    const rpc = f.client.rpc(RunServer);
    const location = { directory: f.directory };
    await rpc.run({ prompt: "RPC after legacy cancellation" }, { location });
    const rpcDeadline = Date.now() + 5000;
    while ((await rpc.status(undefined, { location })).runs.active > 0) {
      assert.ok(
        Date.now() < rpcDeadline,
        "RPC did not finish after legacy cancellation",
      );
      await Bun.sleep(20);
    }
    assert.equal((await rpc.status(undefined, { location })).runs.completed, 1);
    await verifyBusyBackend(f, post, idle, status);

    f.block();
    await post({ prompt: "Unload active" });
    await post({ prompt: "Discard pending" });
  } catch (error) {
    console.error(await readFile(join(root, `legacy-${runtime}.log`), "utf8"));
    throw error;
  } finally {
    await f.close();
  }
  // The listener belongs to the host process, so it stops only once the
  // service it attached to is gone for good.
  const stopped = Date.now() + 10_000;
  while (
    await fetch(`${f.base}/health`).then(
      () => true,
      () => false,
    )
  ) {
    assert.ok(Date.now() < stopped, "Legacy listener outlived its service");
    await Bun.sleep(20);
  }
  console.log(
    `Verified legacy HTTP/configuration on v2 with ${runtime} subprocess runtime.`,
  );
};

// A slow or briefly unreachable backend must not stop the listener or the runs
// it already accepted; only a definitive loss of the owning process does.
const verifyBusyBackend = async (
  f: Awaited<ReturnType<typeof createLegacyHost>>,
  post: (input: object) => Promise<Response>,
  idle: () => Promise<unknown>,
  status: () => Promise<z.infer<typeof statsSchema>>,
) => {
  const before = await status();
  f.blockHealth();
  // Outlast the configured probe timeout and failure threshold.
  await Bun.sleep(1000);
  assert.equal((await post({ prompt: "Busy backend" })).status, 202);
  const after = (await idle()) as z.infer<typeof statsSchema>;
  assert.equal(after.runs.total, before.runs.total + 1);
  assert.equal(after.runs.failed, before.runs.failed);
  assert.equal(after.mainServer.healthy, true);
  f.releaseHealth();
};

const verifySessions = async (
  f: Awaited<ReturnType<typeof createLegacyHost>>,
  post: (input: object) => Promise<Response>,
  idle: () => Promise<unknown>,
) => {
  await writeFile(join(f.directory, "host.txt"), "Legacy host attachment");
  const started = await post({
    prompt: "Legacy prompt",
    title: "legacy-first",
    thinking: true,
    files: ["host.txt"],
    inlineFiles: [{ filename: "inline.txt", content: "YR==" }],
  });
  assert.equal(started.status, 202);
  assert.deepEqual(
    Object.keys(acceptedSchema.parse(await started.json())).sort(),
    ["queued", "requestId", "status"],
  );
  await idle();
  const first = (
    await f.client.session.list({ directory: f.directory })
  ).data.find((session) => session.title === "legacy-first");
  assert.ok(first);
  assert.equal(first.outcome, "succeeded");
  const history = JSON.stringify(
    await f.client.session.context({ sessionID: first.id }),
  );
  assert.ok(
    history.includes(Buffer.from("Legacy host attachment").toString("base64")),
  );
  assert.ok(history.includes("YQ=="));
  assert.equal(
    (await post({ prompt: "Continue latest", continue: true })).status,
    202,
  );
  await idle();
  assert.equal(
    (await f.client.session.list({ directory: f.directory })).data.length,
    1,
  );
  assert.equal(
    (
      await post({
        prompt: "Fork explicit",
        session: first.id,
        fork: true,
        title: "legacy-fork",
      })
    ).status,
    202,
  );
  await idle();
  const fork = (
    await f.client.session.list({ directory: f.directory })
  ).data.find((session) => session.title === "legacy-fork");
  assert.equal(fork?.fork?.sessionID, first.id);
  assert.equal(
    (
      await post({
        command: "fixture",
        prompt: "command-marker",
        title: "legacy-command",
      })
    ).status,
    202,
  );
  await idle();
  const command = (
    await f.client.session.list({ directory: f.directory })
  ).data.find((session) => session.title === "legacy-command");
  assert.ok(command);
  assert.ok(
    JSON.stringify(
      await f.client.session.context({ sessionID: command.id }),
    ).includes("Legacy command: command-marker"),
  );
};

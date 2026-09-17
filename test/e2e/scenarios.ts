import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RunServer } from "../../src/rpc.js";
import { createHost } from "./host.js";

export const verify = async (root: string, installed: string) => {
  const f = await createHost(root, installed);
  const directory = join(root, "project");
  const options = { location: { directory } };
  const rpc = f.host.rpc(RunServer);
  const idle = async () => {
    const deadline = Date.now() + 15_000;
    while (true) {
      const status = await rpc.status(undefined, options);
      if (status.runs.active === 0 && status.runs.queued === 0) return status;
      assert.ok(Date.now() < deadline, "Managed run failed to finish");
      await Bun.sleep(20);
    }
  };
  try {
    const status = await rpc.status(undefined, options);
    assert.equal(status.version, "0.3.2");
    assert.equal(status.location.directory, directory);
    const plugins = await f.host.plugin.list(options);
    assert.ok(
      plugins.data.some((plugin) => plugin.id === "opencode-run-server"),
    );
    await writeFile(join(directory, "host.txt"), "Host attachment marker");
    const result = await rpc.run(
      {
        prompt: "Say verified",
        title: "Package verification",
        files: ["host.txt"],
        inlineFiles: [
          {
            filename: "inline.txt",
            content: Buffer.from("Inline attachment marker").toString("base64"),
          },
        ],
      },
      options,
    );
    assert.equal(result.status, "accepted");
    const final = await idle();
    assert.equal(final.runs.completed, 1, JSON.stringify(final));
    assert.equal(final.runs.failed, 0);
    const sessions = await f.host.session.list({ directory });
    const session = sessions.data.find(
      (value) => value.title === "Package verification",
    );
    assert.ok(session);
    assert.equal(session.outcome, "succeeded");
    const history = JSON.stringify(
      await f.host.session.context({ sessionID: session.id }),
    );
    assert.ok(history.includes("Verified response"));
    assert.ok(
      history.includes(
        Buffer.from("Host attachment marker").toString("base64"),
      ),
    );
    assert.ok(
      history.includes(
        Buffer.from("Inline attachment marker").toString("base64"),
      ),
    );
    assert.ok(f.requests.length > 0, "No model execution occurred");

    await rpc.run(
      { command: "fixture", prompt: "command marker", title: "Command" },
      options,
    );
    await idle();
    assert.ok(JSON.stringify(f.requests).includes("command: command marker"));
    await assert.rejects(rpc.run({ prompt: "" }, options), {
      type: "rpc.invalid_input",
    });
    const legacy = { prompt: "bad", thinking: true };
    await assert.rejects(rpc.run(legacy, options), {
      type: "rpc.invalid_input",
    });
    await assert.rejects(rpc.run({ prompt: "x".repeat(4096) }, options), {
      type: "input_too_large",
    });
    await assert.rejects(
      rpc.run({ prompt: "no", session: "ses_missing" }, options),
      { type: "start_failed" },
    );

    f.block();
    await rpc.run({ prompt: "Blocked", title: "Blocked" }, options);
    assert.equal(
      (await rpc.run({ prompt: "Queued", title: "Queued" }, options)).queued,
      true,
    );
    await assert.rejects(rpc.run({ prompt: "Overflow" }, options), {
      type: "queue_full",
    });
    f.release();
    await idle();

    const other = join(root, "other");
    await mkdir(other);
    assert.equal(
      (await rpc.status(undefined, { location: { directory: other } })).runs
        .total,
      0,
    );
    await assert.rejects(
      rpc.run(
        { prompt: "Wrong location", session: session.id },
        { location: { directory: other } },
      ),
      { type: "start_failed" },
    );

    await rpc.run({ prompt: "RUN_TOOL", title: "Permission denied" }, options);
    console.log("Verifying permission denial");
    await idle();
    await assert.rejects(readFile(join(directory, "permission.txt")), {
      code: "ENOENT",
    });
    await rpc.run(
      {
        prompt: "RUN_TOOL",
        title: "Permission allowed",
        dangerouslySkipPermissions: true,
      },
      options,
    );
    console.log("Verifying permission override");
    await idle();
    assert.equal(
      await readFile(join(directory, "permission.txt"), "utf8"),
      "Permission verified",
    );
    await rm(join(directory, "permission.txt"));
    await f.deny();
    await rpc.run(
      {
        prompt: "RUN_TOOL",
        title: "Explicit denial",
        dangerouslySkipPermissions: true,
      },
      options,
    );
    console.log("Verifying explicit deny");
    await idle();
    await assert.rejects(readFile(join(directory, "permission.txt")), {
      code: "ENOENT",
    });

    const before = (await rpc.status(undefined, options)).runs.failed;
    f.block();
    await rpc.run(
      { prompt: "Wait for timeout", title: "Timeout", timeoutMs: 100 },
      options,
    );
    console.log("Verifying timeout");
    assert.equal((await idle()).runs.failed, before + 1);
    f.release();
    const timed = (await f.host.session.list({ directory })).data.find(
      (value) => value.title === "Timeout",
    );
    assert.equal(timed?.outcome, "interrupted");

    f.block();
    await rpc.run({ prompt: "Unload active", title: "Unload" }, options);
    assert.equal(
      (await rpc.run({ prompt: "Drop on unload" }, options)).queued,
      true,
    );
    console.log("Verifying active unload");
  } finally {
    await f.close();
  }
  const log = await readFile(join(root, "runs.log"), "utf8");
  assert.ok(log.includes("Plugin unloaded"));
  assert.ok(log.includes("queued run dropped"), log);
};

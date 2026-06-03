import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it } from "vitest";
import type { SubprocessHandle } from "./plugin.js";
import { createPlugin } from "./plugin.js";

class FakeSubprocess extends EventEmitter implements SubprocessHandle {
  readonly pid: number | undefined;

  constructor(pid: number | null = 4321) {
    super();
    this.pid = pid ?? undefined;
  }
}

const logs: string[] = [];

const input = {
  client: {
    app: {
      log: async (entry: { body: { level: string; message: string } }) => {
        logs.push(`${entry.body.level}:${entry.body.message}`);
      },
    },
  },
  serverUrl: new URL("http://127.0.0.1:4096/"),
};

describe("plugin supervisor", () => {
  beforeEach(() => {
    logs.length = 0;
  });

  it("no-ops inside spawned opencode run children", async () => {
    let spawned = false;
    const plugin = createPlugin({
      env: { OPENCODE_RUN_SERVER_CHILD: "1" },
      execPath: "/bin/opencode",
      spawnSubprocess: () => {
        spawned = true;
        return new FakeSubprocess();
      },
    });

    expect(await plugin(input, {})).toEqual({});
    expect(spawned).toBe(false);
  });

  it("spawns the supervised server with merged config and attach URL", async () => {
    const child = new FakeSubprocess();
    const envs: NodeJS.ProcessEnv[] = [];
    const plugin = createPlugin({
      discoverBind: async () => ({ host: "127.0.0.1", source: "loopback" }),
      env: { OPENCODE_SERVER_PASSWORD: "pw" },
      execPath: "/bin/opencode",
      resolveRuntime: async () => ({
        args: ["/pkg/src/server.ts"],
        command: "bun",
        kind: "bun",
      }),
      spawnSubprocess: (_command, _args, options) => {
        envs.push(options.env);
        return child;
      },
    });

    const hooks = await plugin(input, { token: "tok" });

    expect(envs[0]?.OPENCODE_RUN_SERVER_MAIN_URL).toBe(
      "http://127.0.0.1:4096/",
    );
    expect(envs[0]?.OPENCODE_SERVER_PASSWORD).toBe("pw");
    expect(envs[0]?.OPENCODE_RUN_SERVER_CONFIG).toContain("tok");
    await hooks.dispose?.();
  });

  it("warns when process execPath does not look like opencode and kills on dispose", async () => {
    const child = new FakeSubprocess();
    const killed: string[] = [];
    const plugin = createPlugin({
      discoverBind: async () => ({ host: "127.0.0.1", source: "loopback" }),
      env: {},
      execPath: "/bin/node",
      killGroup: (_pid, signal) => {
        killed.push(signal);
        return true;
      },
      resolveRuntime: async () => ({
        args: ["/pkg/src/server.ts"],
        command: "bun",
        kind: "bun",
      }),
      spawnSubprocess: () => child,
    });

    const hooks = await plugin(input, {});
    await hooks.dispose?.();

    expect(logs).toContain("warn:opencodePath does not look like opencode");
    expect(killed).toEqual(["SIGTERM"]);
  });

  it("logs safely when no client logger is available and child has no pid", async () => {
    const child = new FakeSubprocess(null);
    const plugin = createPlugin({
      discoverBind: async () => ({ host: "127.0.0.1", source: "loopback" }),
      env: {},
      execPath: "/bin/opencode",
      resolveRuntime: async () => ({
        args: ["/pkg/src/server.ts"],
        command: "bun",
        kind: "bun",
      }),
      spawnSubprocess: () => child,
    });

    const hooks = await plugin({ serverUrl: input.serverUrl }, {});
    await hooks.dispose?.();

    expect(logs).toEqual([]);
  });

  it("can use process defaults for env and execPath", async () => {
    const child = new FakeSubprocess();
    const envs: NodeJS.ProcessEnv[] = [];
    const plugin = createPlugin({
      discoverBind: async () => ({ host: "127.0.0.1", source: "loopback" }),
      resolveRuntime: async () => ({
        args: ["/pkg/src/server.ts"],
        command: "bun",
        kind: "bun",
      }),
      spawnSubprocess: (_command, _args, options) => {
        envs.push(options.env);
        return child;
      },
    });

    const hooks = await plugin(input, {});
    await hooks.dispose?.();

    expect(envs[0]?.OPENCODE_RUN_SERVER_MAIN_URL).toBe(
      "http://127.0.0.1:4096/",
    );
  });
});

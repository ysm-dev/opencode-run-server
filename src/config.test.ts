import { describe, expect, it } from "vitest";
import {
  createServerConfig,
  parseServerEnv,
  serializeServerEnv,
} from "./config.js";
import type { BindDiscovery } from "./tailscale.js";

const discovery = async (): Promise<BindDiscovery> => ({
  host: "100.96.1.2",
  source: "tailscale",
});

describe("createServerConfig", () => {
  it("merges zero-config defaults with tailscale bind discovery", async () => {
    const config = await createServerConfig(undefined, {
      env: { XDG_STATE_HOME: "/tmp/state" },
      execPath: "/usr/local/bin/opencode",
      discoverBind: discovery,
    });

    expect(config.port).toBe(4097);
    expect(config.bind).toBe("100.96.1.2");
    expect(config.concurrency).toBe(10);
    expect(config.queueMax).toBe(100);
    expect(config.runTimeoutMs).toBe(1_800_000);
    expect(config.runtime).toBe("auto");
    expect(config.opencodePath).toBe("/usr/local/bin/opencode");
    expect(config.log.file).toBe("/tmp/state/opencode-run-server/server.log");
  });

  it("deep-merges nested options without losing defaults", async () => {
    const config = await createServerConfig(
      {
        bind: "0.0.0.0",
        token: "secret",
        attach: { password: "pw" },
        healthCheck: { intervalMs: 25 },
        log: { level: "debug", maxFiles: 2 },
      },
      { env: {}, execPath: "/bin/opencode", discoverBind: discovery },
    );

    expect(config.bind).toBe("0.0.0.0");
    expect(config.token).toBe("secret");
    expect(config.attach.password).toBe("pw");
    expect(config.attach.username).toBeUndefined();
    expect(config.healthCheck.intervalMs).toBe(25);
    expect(config.healthCheck.timeoutMs).toBe(2000);
    expect(config.log.level).toBe("debug");
    expect(config.log.maxFiles).toBe(2);
    expect(config.log.maxSize).toBe("10m");
  });

  it("preserves attach username and reports missing internal env values", async () => {
    const config = await createServerConfig(
      { attach: { username: "u" } },
      { env: {}, execPath: "/bin/opencode", discoverBind: discovery },
    );

    expect(config.attach.username).toBe("u");
    expect(() => parseServerEnv({})).toThrow("OPENCODE_RUN_SERVER_CONFIG");
    expect(() =>
      parseServerEnv({ OPENCODE_RUN_SERVER_CONFIG: JSON.stringify(config) }),
    ).toThrow("OPENCODE_RUN_SERVER_MAIN_URL");
  });

  it("rejects unknown options and invalid numeric bounds", async () => {
    await expect(
      createServerConfig({ share: true }, { execPath: "/bin/opencode" }),
    ).rejects.toThrow(/Unrecognized key/);

    await expect(
      createServerConfig({ concurrency: 0 }, { execPath: "/bin/opencode" }),
    ).rejects.toThrow(/concurrency/);
  });

  it("round-trips the internal env config without exposing public env API", async () => {
    const config = await createServerConfig(
      { token: "secret", opencodePath: "/opt/opencode" },
      { env: {}, execPath: "/bin/opencode", discoverBind: discovery },
    );

    const env = serializeServerEnv(config, "http://127.0.0.1:4096/");
    const parsed = parseServerEnv(env);

    expect(parsed.config.token).toBe("secret");
    expect(parsed.config.opencodePath).toBe("/opt/opencode");
    expect(parsed.mainServerUrl).toBe("http://127.0.0.1:4096/");
  });
});

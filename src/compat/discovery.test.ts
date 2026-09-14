import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { attachEndpoint, discoverHost } from "./discovery.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
  vi.unstubAllEnvs();
});
const temp = async () => {
  const path = await mkdtemp(join(tmpdir(), "ors-discovery-"));
  dirs.push(path);
  return path;
};

it("discovers only a healthy registration owned by the hosting process", async () => {
  const state = await temp();
  await writeFile(
    join(state, "service-other.json"),
    JSON.stringify({ pid: 123, url: "http://other" }),
  );
  await writeFile(join(state, "service-bad.json"), "{");
  await writeFile(join(state, "service-invalid.json"), "{}");
  await writeFile(join(state, "unrelated.json"), "{}");
  await mkdir(join(state, "service-directory.json"));
  await writeFile(
    join(state, "service.json"),
    JSON.stringify({ pid: process.pid, url: "http://host" }),
  );
  const probe = vi.fn(async () => ({
    url: "http://host",
    auth: { type: "basic" as const, username: "opencode", password: "secret" },
  }));
  expect(await discoverHost(process.pid, state, probe)).toMatchObject({
    url: "http://host",
    auth: { password: "secret" },
  });
  expect(probe).toHaveBeenCalledTimes(1);
  expect(
    await discoverHost(process.pid, state, async () => undefined),
  ).toBeUndefined();
  expect(
    await discoverHost(process.pid, state, async () => ({
      url: "http://replaced",
      auth: undefined,
    })),
  ).toBeUndefined();
  expect(
    await discoverHost(process.pid, state, async () => ({
      url: "http://host",
      auth: undefined,
    })),
  ).toEqual({ url: "http://host" });
});

it("handles missing registrations and uses the default XDG discovery path", async () => {
  const state = await temp();
  vi.stubEnv("XDG_STATE_HOME", state);
  expect(await discoverHost()).toBeUndefined();
  await mkdir(join(state, "opencode"));
  expect(await discoverHost()).toBeUndefined();
  vi.stubEnv("XDG_STATE_HOME", undefined);
  expect(
    await discoverHost(-1, join(homedir(), ".local/state/opencode")),
  ).toBeUndefined();
});

it("applies attach overrides, environment credentials, and service credentials in order", () => {
  const endpoint = {
    url: "http://host",
    auth: {
      type: "basic" as const,
      username: "service",
      password: "service-pass",
    },
  };
  expect(attachEndpoint(endpoint, {}, {})).toEqual(endpoint);
  expect(
    attachEndpoint(
      endpoint,
      {},
      {
        OPENCODE_SERVER_PASSWORD: "env-pass",
        OPENCODE_SERVER_USERNAME: "env-user",
      },
    ).auth,
  ).toMatchObject({ username: "env-user", password: "env-pass" });
  expect(
    attachEndpoint(endpoint, { password: "override", username: "user" }, {})
      .auth,
  ).toMatchObject({ username: "user", password: "override" });
  expect(attachEndpoint({ url: "http://host" }, {}, {})).toEqual({
    url: "http://host",
  });
  expect(
    attachEndpoint({ url: "http://host" }, { password: "pass" }, {}).auth
      ?.username,
  ).toBe("opencode");
});

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parseOptions } from "../config.js";
import {
  clearOwnership,
  fingerprint,
  ownershipFile,
  readOwnership,
  running,
  writeOwnership,
} from "./ownership.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const state = async () => {
  const path = await mkdtemp(join(tmpdir(), "ors-own-"));
  directories.push(path);
  return path;
};

it("names the registration per bind and port inside the state directory", async () => {
  vi.stubEnv("XDG_STATE_HOME", "/state");
  expect(ownershipFile("100.64.1.2", 4097)).toBe(
    "/state/opencode-run-server/listener-100.64.1.2-4097.json",
  );
  expect(ownershipFile("::1", 4097, "/tmp/x")).toBe(
    "/tmp/x/listener-__1-4097.json",
  );
});

it("round-trips a registration and ignores unreadable or invalid files", async () => {
  const file = join(await state(), "nested", "listener.json");
  expect(await readOwnership(file)).toBeUndefined();
  const value = {
    pid: 10,
    parentPid: 11,
    bind: "127.0.0.1",
    port: 4097,
    fingerprint: "abc",
    startedAt: 0,
  };
  await writeOwnership(file, value);
  expect(await readOwnership(file)).toEqual(value);
  await writeFile(file, "{not json", "utf8");
  expect(await readOwnership(file)).toBeUndefined();
  await writeFile(file, JSON.stringify({ pid: -1 }), "utf8");
  expect(await readOwnership(file)).toBeUndefined();
});

it("clears only a registration the caller still owns", async () => {
  const file = join(await state(), "listener.json");
  const value = {
    pid: 10,
    parentPid: 11,
    bind: "127.0.0.1",
    port: 4097,
    fingerprint: "abc",
    startedAt: 0,
  };
  await writeOwnership(file, value);
  await clearOwnership(file, 99);
  expect(await readFile(file, "utf8")).toContain('"pid":10');
  await clearOwnership(file, 10);
  expect(await readOwnership(file)).toBeUndefined();
  await clearOwnership(file, 10);
});

it("reports liveness for this process, missing pids, and foreign pids", () => {
  expect(running(process.pid)).toBe(true);
  expect(running(99_999_999)).toBe(false);
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("denied"), { code: "EPERM" });
  });
  expect(running(1)).toBe(true);
});

it("fingerprints options independently of key order and absent values", () => {
  const config = parseOptions({ bind: "127.0.0.1", token: "secret" });
  expect(fingerprint(config)).toBe(fingerprint({ ...config }));
  expect(fingerprint(config)).not.toBe(
    fingerprint({ ...config, token: "other" }),
  );
  expect(fingerprint({ a: 1, b: [1, { c: null }] })).toBe(
    fingerprint({ b: [1, { c: null }], a: 1 }),
  );
  expect(fingerprint({ a: 1 })).toBe(fingerprint({ a: 1, b: undefined }));
  expect(fingerprint(undefined)).toBe(fingerprint(undefined));
});

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parseOptions } from "../config.js";
import { acquireCompatibility, resetCompatibility } from "./listener.js";
import { Supervisor } from "./supervisor.js";

afterEach(async () => {
  await resetCompatibility();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("keeps the shared listener across location unloads and replaces it when options change", async () => {
  const start = vi
    .spyOn(Supervisor.prototype, "start")
    .mockImplementation(() => {});
  const dispose = vi.spyOn(Supervisor.prototype, "dispose").mockResolvedValue();
  const config = parseOptions({ bind: "127.0.0.1", port: 50001 });
  const one = await acquireCompatibility(config, vi.fn());
  const two = await acquireCompatibility(config, vi.fn());
  expect(start).toHaveBeenCalledOnce();
  await one();
  await one();
  await two();
  // Idle eviction unloads every instance; the listener must survive it.
  expect(dispose).not.toHaveBeenCalled();
  const again = await acquireCompatibility(config, vi.fn());
  expect(start).toHaveBeenCalledOnce();
  await again();
  await acquireCompatibility({ ...config, token: "changed" }, vi.fn());
  expect(dispose).toHaveBeenCalledOnce();
  expect(start).toHaveBeenCalledTimes(2);
});

it("routes listener reports to the newest instance and then to the log file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ors-report-"));
  const file = join(directory, "runs.log");
  const captured: Array<(message: string) => void> = [];
  vi.spyOn(Supervisor.prototype, "start").mockImplementation(function (
    this: Supervisor,
  ) {
    captured.push(this.report);
  });
  vi.spyOn(Supervisor.prototype, "dispose").mockResolvedValue();
  const config = parseOptions({
    bind: "127.0.0.1",
    port: 50003,
    token: "secret",
    log: { file },
  });
  const first = vi.fn();
  const second = vi.fn();
  const release = await acquireCompatibility(config, first);
  const other = await acquireCompatibility(config, second);
  const dispatch = captured.at(0);
  if (dispatch === undefined) throw new Error("Supervisor was not started");
  dispatch("newest instance");
  expect(second).toHaveBeenCalledWith("newest instance");
  await other();
  dispatch("remaining instance");
  expect(first).toHaveBeenCalledWith("remaining instance");
  await release();
  dispatch("no instance");
  await vi.waitFor(async () =>
    expect(await readFile(file, "utf8")).toContain("no instance"),
  );
  await rm(directory, { recursive: true, force: true });
});

it("reports listener log write failures without losing the listener", async () => {
  const captured: Array<(message: string) => void> = [];
  vi.spyOn(Supervisor.prototype, "start").mockImplementation(function (
    this: Supervisor,
  ) {
    captured.push(this.report);
  });
  vi.spyOn(Supervisor.prototype, "dispose").mockResolvedValue();
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const release = await acquireCompatibility(
    parseOptions({ bind: "127.0.0.1", port: 50004, log: { file: "/" } }),
    vi.fn(),
  );
  await release();
  const dispatch = captured.at(-1);
  if (dispatch === undefined) throw new Error("Supervisor was not started");
  dispatch("unwritable listener log");
  await vi.waitFor(() => expect(errors).toHaveBeenCalled());
});

it("supports default discovery and binding without registering another service", async () => {
  vi.stubEnv("XDG_STATE_HOME", "/nonexistent-opencode-test-state");
  const release = await acquireCompatibility(
    parseOptions({ port: 50002 }),
    vi.fn(),
  );
  await release();
});

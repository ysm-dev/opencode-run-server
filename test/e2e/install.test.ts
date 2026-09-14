import { afterEach, expect, it, vi } from "vitest";
import { installPublished } from "./install.js";

const pkg = { name: "opencode-run-server", version: "0.2.0" };
const missing = new Error(
  'No version matching "0.2.0" found for specifier "opencode-run-server" (but package exists)',
);
afterEach(() => vi.restoreAllMocks());

it("retries a just-published version until it is visible", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const install = vi
    .fn()
    .mockRejectedValueOnce(missing)
    .mockResolvedValue(undefined);
  const sleep = vi.fn(async () => {});
  await installPublished(install, pkg, sleep);
  expect(install).toHaveBeenCalledTimes(2);
  expect(sleep).toHaveBeenCalledWith(5000);
});

it.each([
  new Error("Registry authentication failed"),
  new Error(
    'No version matching "1.0.0" found for specifier "another-package"',
  ),
  "unexpected failure",
])("fails immediately for unrelated installation errors: %s", async (error) => {
  const install = vi.fn().mockRejectedValue(error);
  const sleep = vi.fn(async () => {});
  await expect(installPublished(install, pkg, sleep)).rejects.toBe(error);
  expect(install).toHaveBeenCalledOnce();
  expect(sleep).not.toHaveBeenCalled();
});

it("bounds the propagation wait and preserves the final error", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const install = vi.fn().mockRejectedValue(missing);
  const sleep = vi.fn(async () => {});
  await expect(installPublished(install, pkg, sleep)).rejects.toBe(missing);
  expect(install).toHaveBeenCalledTimes(12);
  expect(sleep).toHaveBeenCalledTimes(11);
});

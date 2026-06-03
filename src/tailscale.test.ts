import { describe, expect, it } from "vitest";
import {
  discoverTailscaleIp,
  findTailscaleInterfaceAddress,
  isTailscaleIpv4,
  parseTailscaleIpOutput,
} from "./tailscale.js";

describe("tailscale discovery", () => {
  it("parses the first tailscale IPv4 from command output", () => {
    expect(parseTailscaleIpOutput("100.64.0.1\nfd7a::1\n")).toBe("100.64.0.1");
  });

  it("recognizes only 100.64.0.0/10 addresses", () => {
    expect(isTailscaleIpv4("100.64.0.1")).toBe(true);
    expect(isTailscaleIpv4("100.127.255.255")).toBe(true);
    expect(isTailscaleIpv4("100.128.0.1")).toBe(false);
    expect(isTailscaleIpv4("192.168.1.2")).toBe(false);
  });

  it("falls back to a local CGNAT interface address", () => {
    const address = findTailscaleInterfaceAddress({
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      utun: [{ address: "100.100.10.20", family: "IPv4", internal: false }],
    });

    expect(address).toBe("100.100.10.20");
  });

  it("falls back to loopback when tailscale is unavailable", async () => {
    const result = await discoverTailscaleIp({
      runCommand: async () => ({ stdout: "" }),
      networkInterfaces: () => ({}),
    });

    expect(result).toEqual({ host: "127.0.0.1", source: "loopback" });
  });

  it("uses tailscale command output before interface fallback", async () => {
    const result = await discoverTailscaleIp({
      networkInterfaces: () => ({
        utun: [{ address: "100.100.10.20", family: "IPv4", internal: false }],
      }),
      runCommand: async () => ({ stdout: "100.88.1.2\n" }),
    });

    expect(result).toEqual({ host: "100.88.1.2", source: "tailscale" });
  });

  it("uses interface fallback when the tailscale command fails", async () => {
    const result = await discoverTailscaleIp({
      networkInterfaces: () => ({
        utun: [{ address: "100.100.10.20", family: 4, internal: false }],
      }),
      runCommand: async () => {
        throw new Error("missing tailscale");
      },
    });

    expect(result).toEqual({ host: "100.100.10.20", source: "interface" });
  });

  it("ignores undefined, internal, non-ipv4, and non-tailscale interfaces", () => {
    expect(
      findTailscaleInterfaceAddress({
        empty: undefined,
        eth0: [{ address: "192.168.1.2", family: "IPv4", internal: false }],
        lo0: [{ address: "100.100.10.20", family: "IPv4", internal: true }],
        utun: [{ address: "fd7a::1", family: "IPv6", internal: false }],
      }),
    ).toBeUndefined();
  });
});

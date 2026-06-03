import { execFile } from "node:child_process";
import { networkInterfaces as osNetworkInterfaces } from "node:os";

export type BindDiscovery = {
  host: string;
  source: "tailscale" | "interface" | "loopback";
};

type NetworkAddress = {
  address: string;
  family: string | number;
  internal: boolean;
};

export type NetworkInterfaceMap = Record<string, NetworkAddress[] | undefined>;

type CommandRunner = (
  command: string,
  args: string[],
) => Promise<{ stdout: string }>;

export type TailscaleDeps = {
  networkInterfaces?: () => NetworkInterfaceMap;
  runCommand?: CommandRunner;
};

export const parseTailscaleIpOutput = (stdout: string) =>
  stdout
    .split(/\s+/)
    .map((value) => value.trim())
    .find((value) => isTailscaleIpv4(value));

export const isTailscaleIpv4 = (address: string) => {
  const parts = address.split(".").map((part) => Number.parseInt(part, 10));
  const [first, second, third, fourth] = parts;
  if (
    parts.length !== 4 ||
    first === undefined ||
    second === undefined ||
    third === undefined ||
    fourth === undefined
  ) {
    return false;
  }
  return (
    parts.every((part) => part >= 0 && part <= 255) &&
    first === 100 &&
    second >= 64 &&
    second <= 127
  );
};

export const findTailscaleInterfaceAddress = (
  interfaces: NetworkInterfaceMap,
) => {
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses ?? []) {
      if (
        !address.internal &&
        isIpv4(address.family) &&
        isTailscaleIpv4(address.address)
      ) {
        return address.address;
      }
    }
  }
  return undefined;
};

export const discoverTailscaleIp = async (
  deps: TailscaleDeps = {},
): Promise<BindDiscovery> => {
  /* v8 ignore next -- default OS seams are exercised via injected tests and e2e startup */
  const runCommand = deps.runCommand ?? defaultRunCommand;
  /* v8 ignore next -- default OS seams are exercised via injected tests and e2e startup */
  const networkInterfaces = deps.networkInterfaces ?? osNetworkInterfaces;

  try {
    const result = await runCommand("tailscale", ["ip", "-4"]);
    const host = parseTailscaleIpOutput(result.stdout);
    if (host !== undefined) return { host, source: "tailscale" };
  } catch {}

  const interfaceHost = findTailscaleInterfaceAddress(networkInterfaces());
  if (interfaceHost !== undefined)
    return { host: interfaceHost, source: "interface" };

  return { host: "127.0.0.1", source: "loopback" };
};

const isIpv4 = (family: string | number) => family === "IPv4" || family === 4;

/* v8 ignore next -- external command seam covered through injected runners */
const defaultRunCommand: CommandRunner = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout });
    });
  });

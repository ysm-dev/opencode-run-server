import { execFile } from "node:child_process";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";

export const tailscaleIP = (value: string) => {
  const octets = value.split(".").map(Number);
  return (
    isIP(value) === 4 &&
    octets[0] === 100 &&
    (octets[1] ?? 0) >= 64 &&
    (octets[1] ?? 0) <= 127
  );
};

const runTailscale = () =>
  new Promise<string>((resolve, reject) => {
    execFile("tailscale", ["ip", "-4"], { timeout: 2000 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
  });

export const discoverBind = async (
  run = runTailscale,
  interfaces = networkInterfaces,
) => {
  const stdout = await run().catch(() => "");
  const direct = stdout.split(/\s+/).find(tailscaleIP);
  if (direct !== undefined) return direct;
  return (
    Object.values(interfaces())
      .flatMap((values) => values ?? [])
      .find((address) => !address.internal && tailscaleIP(address.address))
      ?.address ?? "127.0.0.1"
  );
};

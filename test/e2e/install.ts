import { setTimeout } from "node:timers/promises";

export const installPublished = async (
  install: () => Promise<void>,
  pkg: { name: string; version: string },
  sleep: (ms: number) => Promise<unknown> = setTimeout,
) => {
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    try {
      await install();
      return;
    } catch (error) {
      // npm's abbreviated metadata can lag behind a successful publish.
      // Retry only this package's missing version, never test or dependency failures.
      if (
        attempt === 12 ||
        !(error instanceof Error) ||
        !error.message.includes(
          `No version matching "${pkg.version}" found for specifier "${pkg.name}"`,
        )
      )
        throw error;
      console.log(
        `Waiting for npm to expose ${pkg.name}@${pkg.version} (${attempt}/12)`,
      );
      await sleep(5000);
    }
  }
};

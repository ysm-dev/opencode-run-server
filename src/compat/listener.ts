import { type Config, defaultLogFile } from "../config.js";
import { createFileLogger } from "../log.js";
import { discoverBind } from "./network.js";
import { fingerprint } from "./ownership.js";
import { Supervisor } from "./supervisor.js";

type Entry = {
  fingerprint: string;
  reporters: Array<(message: string) => void>;
  supervisor: Supervisor;
};

const shared = new Map<string, Entry>();

// Listener messages outlive every location instance that can report them.
const fileReporter = (config: Config) => {
  const logger = createFileLogger({
    ...config.log,
    file: config.log.file ?? defaultLogFile(),
    secrets: [
      process.env.OPENCODE_SERVER_PASSWORD ?? "",
      config.token ?? "",
      config.attach.password ?? "",
    ],
  });
  return (message: string) => {
    void logger.info(message).catch((error: unknown) => {
      console.error("opencode-run-server:", error);
    });
  };
};

/**
 * Location instances come and go with OpenCode's idle eviction, so the listener
 * they share outlives them and is released only with the host process.
 */
export const acquireCompatibility = async (
  config: Config,
  report: (message: string) => void,
) => {
  const bind = config.bind ?? (await discoverBind());
  const key = `${bind}:${config.port}`;
  const print = fingerprint({ ...config, bind });
  const stale = shared.get(key);
  if (stale !== undefined && stale.fingerprint !== print) {
    shared.delete(key);
    await stale.supervisor.dispose();
  }
  let entry = shared.get(key);
  if (entry === undefined) {
    const reporters: Array<(message: string) => void> = [];
    const fallback = fileReporter(config);
    entry = {
      fingerprint: print,
      reporters,
      supervisor: new Supervisor(config, bind, (message) =>
        (reporters.at(-1) ?? fallback)(message),
      ),
    };
    shared.set(key, entry);
    entry.supervisor.start();
  }
  const { reporters } = entry;
  reporters.push(report);
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    const index = reporters.lastIndexOf(report);
    if (index >= 0) reporters.splice(index, 1);
  };
};

/** Tears down every supervised listener owned by this process. */
export const resetCompatibility = async () => {
  const entries = [...shared.values()];
  shared.clear();
  await Promise.all(entries.map((entry) => entry.supervisor.dispose()));
};

import type { Config } from "../config.js";

/**
 * `ok` and `slow` both prove the service is present; only `down` is a transport
 * loss, and `gone` means the process that owns the listener has exited.
 */
export type HealthStatus = "ok" | "slow" | "down" | "gone";

const interrupted = (error: unknown) => {
  const name =
    typeof error === "object" && error !== null && "name" in error
      ? String(error.name)
      : "";
  return name === "TimeoutError" || name === "AbortError";
};

export const checkHealth = async (
  url: string,
  timeoutMs: number,
  fetcher: typeof fetch = fetch,
): Promise<HealthStatus> => {
  try {
    // v2.0.6 replaced /api/status with /api/info (v2.0.4 replaced /api/health
    // with /api/status); only transport reachability matters here, so the
    // response body and status code are not inspected.
    await fetcher(new URL("/api/info", url), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return "ok";
  } catch (error) {
    // A busy service answers late; that is not a reason to stop serving runs.
    return interrupted(error) ? "slow" : "down";
  }
};

/** Confirms a recorded listener still owns its address, not just its pid. */
export const checkListener = async (
  bind: string,
  port: number,
  timeoutMs: number,
  fetcher: typeof fetch = fetch,
) => {
  const host = bind.includes(":") ? `[${bind}]` : bind;
  try {
    const response = await fetcher(`http://${host}:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
};

export class HealthMonitor {
  #stopped = true;
  #failures = 0;
  #unavailable = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #snapshot = { healthy: true, lastCheckAt: Date.now() };
  constructor(
    readonly url: string,
    readonly config: Config["healthCheck"],
    readonly gone: () => void,
    readonly check: (
      url: string,
      timeoutMs: number,
    ) => Promise<HealthStatus> = checkHealth,
    readonly report: (message: string) => void = () => {},
  ) {}
  snapshot = () => this.#snapshot;
  start() {
    if (!this.#stopped) return;
    this.#stopped = false;
    void this.tick();
  }
  stop() {
    this.#stopped = true;
    clearTimeout(this.#timer);
  }
  private async tick() {
    const status = await this.check(this.url, this.config.timeoutMs);
    if (this.#stopped) return;
    this.#snapshot = { healthy: status !== "down", lastCheckAt: Date.now() };
    if (status === "gone") {
      this.#stopped = true;
      this.report("owning opencode process exited");
      this.gone();
      return;
    }
    if (status === "down") this.#failures += 1;
    if (status === "ok") this.#failures = 0;
    if (!this.#unavailable && this.#failures >= this.config.failureThreshold) {
      this.#unavailable = true;
      this.report("backend transport unavailable; still accepting requests");
    }
    if (this.#unavailable && status === "ok") {
      this.#unavailable = false;
      this.#failures = 0;
      this.report("backend transport recovered");
    }
    this.#timer = setTimeout(() => {
      void this.tick();
    }, this.config.intervalMs);
  }
}

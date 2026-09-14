import type { Config } from "../config.js";

export const checkHealth = async (
  url: string,
  timeoutMs: number,
  fetcher: typeof fetch = fetch,
) => {
  try {
    await fetcher(new URL("/api/health", url), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return true;
  } catch {
    return false;
  }
};

export class HealthMonitor {
  #stopped = true;
  #failures = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #snapshot = { healthy: true, lastCheckAt: Date.now() };
  constructor(
    readonly url: string,
    readonly config: Config["healthCheck"],
    readonly unhealthy: () => void,
    readonly check = checkHealth,
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
    const healthy = await this.check(this.url, this.config.timeoutMs);
    if (this.#stopped) return;
    this.#snapshot = { healthy, lastCheckAt: Date.now() };
    this.#failures = healthy ? 0 : this.#failures + 1;
    if (this.#failures >= this.config.failureThreshold) {
      this.#stopped = true;
      this.unhealthy();
      return;
    }
    this.#timer = setTimeout(() => {
      void this.tick();
    }, this.config.intervalMs);
  }
}

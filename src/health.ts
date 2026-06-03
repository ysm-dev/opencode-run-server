export type HealthSnapshot = {
  healthy: boolean;
  lastCheckAt: number;
};

export type HealthFetch = (
  url: URL,
  init: { signal: AbortSignal },
) => Promise<Response>;

export type HealthMonitorOptions = {
  failureThreshold: number;
  fetch?: HealthFetch;
  intervalMs: number;
  mainServerUrl: string;
  onUnhealthy: () => Promise<void>;
  timeoutMs: number;
};

export const checkMainServerHealth = async (
  mainServerUrl: string,
  timeoutMs: number,
  fetchFn: HealthFetch = fetch,
) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetchFn(new URL("/global/health", mainServerUrl), {
      signal: controller.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
};

export class HealthMonitor {
  #failures = 0;
  #running = false;
  #snapshot: HealthSnapshot = { healthy: true, lastCheckAt: 0 };
  #timer?: ReturnType<typeof setTimeout>;
  readonly #options: HealthMonitorOptions;

  constructor(options: HealthMonitorOptions) {
    this.#options = options;
  }

  start() {
    if (this.#running) return;
    this.#running = true;
    void this.#tick();
  }

  stop() {
    this.#running = false;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
  }

  snapshot() {
    return this.#snapshot;
  }

  async #tick() {
    /* v8 ignore next -- private guard for stale scheduled ticks */
    if (!this.#running) return;
    const healthy = await checkMainServerHealth(
      this.#options.mainServerUrl,
      this.#options.timeoutMs,
      /* v8 ignore next -- default fetch path is exercised through checkMainServerHealth */
      this.#options.fetch ?? fetch,
    );
    if (!this.#running) return;
    this.#snapshot = { healthy, lastCheckAt: Date.now() };
    this.#failures = healthy ? 0 : this.#failures + 1;
    if (this.#failures >= this.#options.failureThreshold) {
      this.#running = false;
      await this.#options.onUnhealthy();
      return;
    }
    this.#timer = setTimeout(() => void this.#tick(), this.#options.intervalMs);
  }
}

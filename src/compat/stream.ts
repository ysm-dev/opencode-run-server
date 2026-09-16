import type { OpenCodeClient } from "@opencode/client";
import type { Config } from "../config.js";
import type { Logger } from "../log.js";
import type { PluginEvent } from "../runner.js";

type Options = {
  client: Pick<OpenCodeClient, "event">;
  restart: Config["restart"];
  logger: Pick<Logger, "info" | "warn" | "error">;
  signal: AbortSignal;
  observe: (event: PluginEvent) => Promise<void>;
  resync: () => Promise<void>;
  unavailable: () => void;
};

/**
 * Keeps the backend event subscription alive. A dropped stream is reopened with
 * bounded backoff so accepted runs survive backend hiccups, and only an
 * exhausted budget reports the backend as unavailable.
 */
export class EventStream {
  #loop: Promise<void> | undefined;
  constructor(readonly options: Options) {}

  async connect() {
    this.#loop = this.consume(await this.open());
  }

  async done() {
    await this.#loop;
  }

  private async open() {
    const iterator = this.options.client.event
      .subscribe({ signal: this.options.signal })
      [Symbol.asyncIterator]();
    const connected = await iterator.next();
    if (connected.done) {
      await iterator.return?.();
      throw new Error("OpenCode event stream closed during startup");
    }
    return iterator;
  }

  private async consume(initial: AsyncIterator<PluginEvent>) {
    let current: AsyncIterator<PluginEvent> | undefined = initial;
    let failures = 0;
    while (!this.options.signal.aborted) {
      if (current === undefined) {
        failures += 1;
        if (failures > this.options.restart.maxRetries) {
          await this.options.logger.error("OpenCode event stream failed", {
            attempts: failures,
          });
          this.options.unavailable();
          return;
        }
        await this.pause(failures);
        if (this.options.signal.aborted) return;
        current = await this.reopen(failures);
        continue;
      }
      const next = await this.read(current);
      if (next === undefined) {
        current = undefined;
        continue;
      }
      failures = 0;
      await this.options.observe(next).catch(async (error: unknown) => {
        await this.options.logger.error("OpenCode event handling failed", {
          error: String(error),
        });
      });
    }
    await current?.return?.();
  }

  private async read(iterator: AsyncIterator<PluginEvent>) {
    try {
      const next = await iterator.next();
      if (next.done) throw new Error("OpenCode event stream closed");
      return next.value;
    } catch (error) {
      await iterator.return?.().catch(() => {});
      if (this.options.signal.aborted) return undefined;
      await this.options.logger.warn("OpenCode event stream interrupted", {
        error: String(error),
      });
      return undefined;
    }
  }

  private async reopen(attempts: number) {
    const iterator = await this.open().catch(async (error: unknown) => {
      await this.options.logger.warn("OpenCode event stream reconnect failed", {
        error: String(error),
        attempts,
      });
      return undefined;
    });
    if (iterator === undefined) return undefined;
    await this.options.logger.info("OpenCode event stream reconnected", {
      attempts,
    });
    // Deliveries observed while disconnected would otherwise stall a run.
    await this.options.resync().catch(async (error: unknown) => {
      await this.options.logger.warn("OpenCode admission resync failed", {
        error: String(error),
      });
    });
    return iterator;
  }

  private pause(attempts: number) {
    const ms = Math.min(
      this.options.restart.baseDelayMs * 2 ** (attempts - 1),
      this.options.restart.maxDelayMs,
    );
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.options.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}

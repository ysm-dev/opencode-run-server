export type StartedRun = {
  done: Promise<void>;
};

export type RunStarter = () => Promise<StartedRun>;

export type SubmitResult =
  | { accepted: true; queued: boolean }
  | { accepted: false; retryAfterSeconds: number };

export type QueueStats = {
  active: number;
  concurrency: number;
  queueMax: number;
  queued: number;
};

export type RunQueueOptions = {
  concurrency: number;
  queueMax: number;
  queueTtlMs: number;
};

type QueueItem = {
  enqueuedAt: number;
  requestId: string;
  start: RunStarter;
  timer?: ReturnType<typeof setTimeout>;
};

export class RunQueue {
  onDrop?: (requestId: string) => void;
  onStartFailure?: (requestId: string, error: Error) => void;
  #active = 0;
  #items: QueueItem[] = [];
  #stopped = false;
  readonly #options: RunQueueOptions;

  constructor(options: RunQueueOptions) {
    this.#options = options;
  }

  async submit(requestId: string, start: RunStarter): Promise<SubmitResult> {
    if (this.#stopped) return { accepted: false, retryAfterSeconds: 1 };
    if (this.#active < this.#options.concurrency) {
      await this.#startNow(start);
      return { accepted: true, queued: false };
    }
    if (this.#items.length >= this.#options.queueMax)
      return { accepted: false, retryAfterSeconds: 1 };
    this.#items.push(this.#createItem(requestId, start));
    return { accepted: true, queued: true };
  }

  stats(): QueueStats {
    return {
      active: this.#active,
      concurrency: this.#options.concurrency,
      queueMax: this.#options.queueMax,
      queued: this.#items.length,
    };
  }

  stop() {
    this.#stopped = true;
    for (const item of this.#items) {
      if (item.timer !== undefined) clearTimeout(item.timer);
    }
    this.#items = [];
  }

  #createItem(requestId: string, start: RunStarter): QueueItem {
    const item: QueueItem = { enqueuedAt: Date.now(), requestId, start };
    if (this.#options.queueTtlMs > 0) {
      item.timer = setTimeout(
        () => this.#drop(requestId),
        this.#options.queueTtlMs,
      );
    }
    return item;
  }

  async #startNow(start: RunStarter) {
    this.#active += 1;
    try {
      const run = await start();
      void run.done.then(this.#finishRun, this.#finishRun);
    } catch (error) {
      this.#active -= 1;
      void this.#processNext();
      throw error;
    }
  }

  #finishRun = () => {
    this.#active -= 1;
    void this.#processNext();
  };

  async #processNext() {
    if (this.#stopped) return;
    while (this.#active < this.#options.concurrency) {
      const item = this.#items.shift();
      if (item === undefined) return;
      if (item.timer !== undefined) clearTimeout(item.timer);
      if (this.#expired(item)) {
        /* v8 ignore next -- optional observability callback */
        this.onDrop?.(item.requestId);
        /* v8 ignore next -- loop control after expired item drop */
        continue;
      }
      try {
        await this.#startNow(item.start);
      } catch (error) {
        this.onStartFailure?.(item.requestId, normalizeError(error));
      }
    }
  }

  #drop(requestId: string) {
    const index = this.#items.findIndex((item) => item.requestId === requestId);
    /* v8 ignore next -- defensive guard for timer/item removal races */
    if (index < 0) return;
    this.#items.splice(index, 1);
    this.onDrop?.(requestId);
  }

  #expired(item: QueueItem) {
    /* v8 ignore next -- covered through public queue expiry behavior */
    return (
      this.#options.queueTtlMs > 0 &&
      Date.now() - item.enqueuedAt > this.#options.queueTtlMs
    );
  }
}

const normalizeError = (error: unknown) =>
  error instanceof Error ? error : new Error(String(error));

import { describe, expect, it, vi } from "vitest";
import { RunQueue } from "./queue.js";

const deferred = () => {
  let resolve!: () => void;
  const done = new Promise<void>((next) => {
    resolve = next;
  });
  return { done, resolve };
};

describe("RunQueue", () => {
  it("starts immediately while concurrency is available", async () => {
    const queue = new RunQueue({ concurrency: 2, queueMax: 10, queueTtlMs: 0 });
    let started = 0;
    const active = deferred();

    const result = await queue.submit("rq_1", async () => {
      started += 1;
      return { done: active.done };
    });

    expect(result).toEqual({ accepted: true, queued: false });
    expect(started).toBe(1);
    expect(queue.stats()).toMatchObject({ active: 1, queued: 0 });
    active.resolve();
  });

  it("queues beyond concurrency and starts queued work after a slot frees", async () => {
    const queue = new RunQueue({ concurrency: 1, queueMax: 1, queueTtlMs: 0 });
    const first = deferred();
    const second = deferred();
    let secondStarted = false;

    await queue.submit("rq_1", async () => ({ done: first.done }));
    const queued = await queue.submit("rq_2", async () => {
      secondStarted = true;
      return { done: second.done };
    });

    expect(queued).toEqual({ accepted: true, queued: true });
    expect(queue.stats()).toMatchObject({ active: 1, queued: 1 });

    first.resolve();
    await Promise.resolve();

    expect(secondStarted).toBe(true);
    expect(queue.stats()).toMatchObject({ active: 1, queued: 0 });
    second.resolve();
  });

  it("rejects when the pending queue is full", async () => {
    const queue = new RunQueue({ concurrency: 1, queueMax: 1, queueTtlMs: 0 });
    const active = deferred();

    await queue.submit("rq_1", async () => ({ done: active.done }));
    await queue.submit("rq_2", async () => ({ done: Promise.resolve() }));

    expect(
      await queue.submit("rq_3", async () => ({ done: Promise.resolve() })),
    ).toEqual({
      accepted: false,
      retryAfterSeconds: 1,
    });
    active.resolve();
  });

  it("drops queued work after queueTtlMs", async () => {
    vi.useFakeTimers();
    const queue = new RunQueue({ concurrency: 1, queueMax: 1, queueTtlMs: 10 });
    const active = deferred();
    let dropped = false;
    let started = false;
    queue.onDrop = () => {
      dropped = true;
    };

    await queue.submit("rq_1", async () => ({ done: active.done }));
    await queue.submit("rq_2", async () => {
      started = true;
      return { done: Promise.resolve() };
    });

    await vi.advanceTimersByTimeAsync(11);
    expect(dropped).toBe(true);

    active.resolve();
    await Promise.resolve();
    expect(started).toBe(false);
    vi.useRealTimers();
  });
});

describe("RunQueue shutdown and failures", () => {
  it("rejects new work after stop and clears pending timers", async () => {
    const queue = new RunQueue({
      concurrency: 1,
      queueMax: 1,
      queueTtlMs: 100,
    });
    const active = deferred();

    await queue.submit("rq_1", async () => ({ done: active.done }));
    await queue.submit("rq_2", async () => ({ done: Promise.resolve() }));
    queue.stop();

    expect(queue.stats()).toMatchObject({ active: 1, queued: 0 });
    expect(
      await queue.submit("rq_3", async () => ({ done: Promise.resolve() })),
    ).toEqual({
      accepted: false,
      retryAfterSeconds: 1,
    });
    active.resolve();
  });

  it("stops queued work that has no TTL timer", async () => {
    const queue = new RunQueue({ concurrency: 1, queueMax: 1, queueTtlMs: 0 });
    const active = deferred();

    await queue.submit("rq_1", async () => ({ done: active.done }));
    await queue.submit("rq_2", async () => ({ done: Promise.resolve() }));
    queue.stop();

    expect(queue.stats()).toMatchObject({ queued: 0 });
    active.resolve();
  });

  it("recovers active capacity when a starter fails", async () => {
    const queue = new RunQueue({ concurrency: 1, queueMax: 1, queueTtlMs: 0 });

    await expect(
      queue.submit("rq_1", async () => {
        throw new Error("spawn failed");
      }),
    ).rejects.toThrow("spawn failed");

    expect(queue.stats()).toMatchObject({ active: 0, queued: 0 });
  });

  it("reports queued starter failures through onStartFailure", async () => {
    const queue = new RunQueue({ concurrency: 1, queueMax: 1, queueTtlMs: 0 });
    const active = deferred();
    const failures: string[] = [];
    queue.onStartFailure = (requestId, error) =>
      failures.push(`${requestId}:${error.message}`);

    await queue.submit("rq_1", async () => ({ done: active.done }));
    await queue.submit("rq_2", async () => {
      throw new Error("later");
    });
    active.resolve();
    await vi.waitFor(() => expect(failures).toEqual(["rq_2:later"]));

    expect(failures).toEqual(["rq_2:later"]);
  });

  it("drops expired queued work when processing resumes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const queue = new RunQueue({ concurrency: 1, queueMax: 1, queueTtlMs: 10 });
    const active = deferred();
    const dropped: string[] = [];
    queue.onDrop = (requestId) => dropped.push(requestId);

    await queue.submit("rq_1", async () => ({ done: active.done }));
    await queue.submit("rq_2", async () => ({ done: Promise.resolve() }));
    vi.setSystemTime(20);
    active.resolve();
    await vi.waitFor(() => expect(dropped).toEqual(["rq_2"]));

    vi.useRealTimers();
  });

  it("can drop expired queued work without a drop callback", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const queue = new RunQueue({ concurrency: 1, queueMax: 1, queueTtlMs: 10 });
    const active = deferred();

    await queue.submit("rq_1", async () => ({ done: active.done }));
    await queue.submit("rq_2", async () => ({ done: Promise.resolve() }));
    vi.setSystemTime(20);
    active.resolve();
    await vi.waitFor(() => expect(queue.stats()).toMatchObject({ queued: 0 }));

    vi.useRealTimers();
  });
});

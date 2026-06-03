import { expect, it, vi } from "vitest";
import { RunQueue } from "./queue.js";

const deferred = () => {
  let resolve!: () => void;
  const done = new Promise<void>((next) => {
    resolve = next;
  });
  return { done, resolve };
};

it("normalizes non-Error queued starter failures", async () => {
  const queue = new RunQueue({ concurrency: 1, queueMax: 1, queueTtlMs: 0 });
  const active = deferred();
  const failures: string[] = [];
  queue.onStartFailure = (_requestId, error) => failures.push(error.message);

  await queue.submit("rq_1", async () => ({ done: active.done }));
  await queue.submit("rq_2", async () => {
    throw "later";
  });
  active.resolve();
  await vi.waitFor(() => expect(failures).toEqual(["later"]));
});

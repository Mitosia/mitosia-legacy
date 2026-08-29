import { afterEach, describe, expect, it, vi } from "vitest";
import { startLeaseHeartbeat } from "@/lib/lease-heartbeat";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  if (!resolvePromise) {
    throw new Error("Deferred promise was not initialized");
  }
  return { promise, resolve: resolvePromise };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("startLeaseHeartbeat", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("never overlaps heartbeats and waits a full interval after completion", async () => {
    vi.useFakeTimers();
    const first = deferred<boolean>();
    const heartbeat = vi
      .fn<() => Promise<boolean>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(true);
    const stop = startLeaseHeartbeat({
      heartbeat,
      intervalMs: 60_000,
      onError: vi.fn(),
    });

    vi.advanceTimersByTime(60_000);
    expect(heartbeat).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(120_000);
    expect(heartbeat).toHaveBeenCalledOnce();

    first.resolve(true);
    await flushPromises();
    vi.advanceTimersByTime(59_999);
    expect(heartbeat).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1);
    expect(heartbeat).toHaveBeenCalledTimes(2);

    await stop();
  });

  it("stops scheduling when the lease is no longer active", async () => {
    vi.useFakeTimers();
    const heartbeat = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);
    const stop = startLeaseHeartbeat({
      heartbeat,
      intervalMs: 60_000,
      onError: vi.fn(),
    });

    vi.advanceTimersByTime(60_000);
    await flushPromises();
    vi.advanceTimersByTime(120_000);

    expect(heartbeat).toHaveBeenCalledOnce();
    await stop();
  });
});

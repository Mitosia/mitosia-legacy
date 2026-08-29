export interface LeaseHeartbeatOptions {
  heartbeat: () => Promise<boolean>;
  intervalMs: number;
  onError: (error: unknown) => void;
}

// Recursive timeout instead of setInterval: a slow heartbeat never overlaps
// the next one. A false result means the lease was retired, so polling stops.
// The returned stopper also awaits the heartbeat in flight before the caller
// finalizes or records failure.
export function startLeaseHeartbeat({
  heartbeat,
  intervalMs,
  onError,
}: LeaseHeartbeatOptions): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = () => {
    if (stopped) {
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      inFlight = heartbeat()
        .then((active) => {
          if (!active) {
            stopped = true;
          }
        })
        .catch(onError)
        .finally(() => {
          inFlight = null;
          schedule();
        });
    }, intervalMs);
    timer.unref();
  };

  schedule();
  return async () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    await inFlight;
  };
}

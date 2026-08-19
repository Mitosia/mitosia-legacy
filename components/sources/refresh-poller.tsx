"use client";

import { useRouter } from "next/navigation";
import { useOffline } from "next/offline";
import { useEffect } from "react";

const POLL_INTERVAL_MS = 3500;

// While any source on the page is mid-lifecycle (uploading/processing),
// re-render the server component tree on an interval so status badges and
// step labels track the pipeline without a realtime channel. Job progress
// streaming (Trigger.dev Realtime) can replace this later.
//
// Paused while offline, and not merely as an optimisation. With
// `experimental.useOffline` a failed RSC fetch is held pending and retried on
// reconnect rather than throwing — but each tick queues its own retry, and
// Next's own docs note that pending retries all resume simultaneously once
// the connection returns. At 3.5s a two-minute tunnel would queue ~34
// refreshes and fire them at the server in one burst. `useOffline` returns
// false during SSR and before hydration, so this starts polling exactly as it
// did before.
export function RefreshPoller({ active }: { active: boolean }) {
  const router = useRouter();
  const isOffline = useOffline();

  useEffect(() => {
    if (!(active && !isOffline)) {
      return;
    }
    const timer = setInterval(() => router.refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [active, isOffline, router]);

  return null;
}

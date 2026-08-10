"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

const POLL_INTERVAL_MS = 3500;

// While any source on the page is mid-lifecycle (uploading/processing),
// re-render the server component tree on an interval so status badges and
// step labels track the pipeline without a realtime channel. Job progress
// streaming (Trigger.dev Realtime) can replace this later.
export function RefreshPoller({ active }: { active: boolean }) {
  const router = useRouter();

  useEffect(() => {
    if (!active) {
      return;
    }
    const timer = setInterval(() => router.refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [active, router]);

  return null;
}

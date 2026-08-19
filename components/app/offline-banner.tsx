"use client";

import { WifiDisconnected01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useOffline } from "next/offline";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

// `experimental.useOffline` (next.config.ts) makes Next hold failed RSC
// fetches and Server Actions pending instead of falling back to a browser
// navigation. That fixes the broken behaviour but is *invisible*: the UI
// simply stops updating, which reads as "the app is slow" rather than "you
// are offline". This is the part that tells the user which one it is.
//
// Returns false during SSR and until hydration, so it never renders on the
// server and cannot cause a hydration mismatch.
export function OfflineBanner() {
  const isOffline = useOffline();

  if (!isOffline) {
    return null;
  }

  return (
    <div className="sticky top-0 z-50 px-4 pt-2" role="status">
      <Alert variant="destructive">
        <HugeiconsIcon icon={WifiDisconnected01Icon} />
        <AlertTitle>No connection</AlertTitle>
        <AlertDescription>
          Waiting for your network. Nothing is lost — updates resume on their
          own once you are back online.
        </AlertDescription>
      </Alert>
    </div>
  );
}

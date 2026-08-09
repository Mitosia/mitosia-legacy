"use client";

import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";

const COPIED_RESET_MS = 2000;

export function CopyInviteLink({ invitationId }: { invitationId: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    const link = `${window.location.origin}/accept-invitation/${invitationId}`;
    await navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), COPIED_RESET_MS);
  }, [invitationId]);

  return (
    <Button onClick={handleCopy} size="sm" variant="outline">
      {copied ? "Copied" : "Copy invite link"}
    </Button>
  );
}

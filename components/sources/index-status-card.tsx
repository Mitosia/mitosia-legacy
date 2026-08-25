"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { retryIndexAction } from "@/lib/actions/intelligence";

// The Ask panel gates on a ready retrieval index, so while the index is
// building or failed the panel is simply absent. This card fills that slot
// with the reason — and, on failure, the retry. The retry matters because
// failed indexes are never auto-re-enqueued (a permanent failure must not
// become a paid loop); without this button the only recovery path was the
// Trigger dashboard.

export interface IndexStatus {
  error: string | null;
  status: string;
}

function RetryIndexButton({ sourceId }: { sourceId: string }) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(retryIndexAction, {});
  useEffect(() => {
    if (state.success) {
      router.refresh();
    }
  }, [state.success, router]);
  return (
    <form action={formAction} className="flex items-center gap-2">
      <input name="sourceId" type="hidden" value={sourceId} />
      <Button
        data-testid="retry-index"
        disabled={pending}
        size="sm"
        type="submit"
        variant="outline"
      >
        {pending ? "Starting…" : "Run indexing again"}
      </Button>
      {state.error ? (
        <p className="text-destructive text-sm">{state.error}</p>
      ) : null}
    </form>
  );
}

export function IndexStatusCard({
  index,
  sourceId,
}: {
  index: IndexStatus;
  sourceId: string;
}) {
  if (index.status === "pending" || index.status === "processing") {
    return (
      <Card data-testid="index-status-card">
        <CardHeader>
          <CardTitle>Ask this source</CardTitle>
          <CardDescription>
            Building the search index… This page updates automatically.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }
  if (index.status !== "failed") {
    return null;
  }
  return (
    <Card data-testid="index-status-card">
      <CardHeader>
        <CardTitle>Ask this source</CardTitle>
        <CardDescription>
          Search indexing failed. You can run it again.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {index.error ? (
          <p
            className="break-words text-muted-foreground text-xs"
            data-testid="index-error"
          >
            {index.error}
          </p>
        ) : null}
        <RetryIndexButton sourceId={sourceId} />
      </CardContent>
    </Card>
  );
}

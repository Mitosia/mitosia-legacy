"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { initialActionState } from "@/lib/action-state";
import { retryIngestAction } from "@/lib/actions/sources";

export function RetryIngestButton({ sourceId }: { sourceId: string }) {
  const [state, formAction, isPending] = useActionState(
    retryIngestAction,
    initialActionState
  );

  return (
    <form action={formAction}>
      <input name="sourceId" type="hidden" value={sourceId} />
      <Button disabled={isPending} size="sm" type="submit" variant="outline">
        {isPending ? <Spinner /> : null}
        Retry
      </Button>
      {state.error ? (
        <p className="mt-1 text-destructive text-xs">{state.error}</p>
      ) : null}
    </form>
  );
}

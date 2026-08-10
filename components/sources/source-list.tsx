import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import type { IngestStep, SourceStatus } from "@/lib/db/schema";
import { formatBytes, formatDuration } from "@/lib/format";
import { ingestStepLabel } from "@/lib/ingest-labels";
import { RetryIngestButton } from "./retry-ingest-button";

export interface SourceListItem {
  durationSeconds: number | null;
  id: string;
  ingestError: string | null;
  ingestStep: IngestStep | null;
  posterKey: string | null;
  sizeBytes: number | null;
  status: SourceStatus;
  title: string;
}

function statusBadge(item: SourceListItem) {
  switch (item.status) {
    case "uploading":
      return <Badge variant="secondary">Uploading</Badge>;
    case "uploaded":
      return <Badge variant="secondary">Queued</Badge>;
    case "processing":
      return (
        <Badge variant="secondary">{ingestStepLabel(item.ingestStep)}…</Badge>
      );
    case "ready":
      return <Badge>Ready</Badge>;
    case "failed":
      return <Badge variant="destructive">Failed</Badge>;
    default:
      return null;
  }
}

export function SourceList({ items }: { items: SourceListItem[] }) {
  if (items.length === 0) {
    return (
      <p className="rounded-md border border-dashed p-6 text-center text-muted-foreground text-sm">
        No recordings yet. Upload one above to get started.
      </p>
    );
  }

  return (
    <ul className="divide-y rounded-md border">
      {items.map((item) => {
        const meta = [
          item.durationSeconds ? formatDuration(item.durationSeconds) : null,
          item.sizeBytes ? formatBytes(item.sizeBytes) : null,
        ]
          .filter(Boolean)
          .join(" · ");

        return (
          <li
            className="flex items-center gap-4 px-4 py-3"
            data-source-status={item.status}
            key={item.id}
          >
            <Link
              className="flex min-w-0 flex-1 items-center gap-4"
              href={`/sources/${item.id}`}
            >
              <span className="h-12 w-20 shrink-0 overflow-hidden rounded bg-muted">
                {item.posterKey ? (
                  <img
                    alt=""
                    className="h-full w-full object-cover"
                    height={48}
                    src={`/api/media/${item.posterKey}`}
                    width={80}
                  />
                ) : null}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-sm">
                  {item.title}
                </span>
                {item.status === "failed" && item.ingestError ? (
                  <span className="block truncate text-destructive text-xs">
                    {item.ingestError}
                  </span>
                ) : (
                  <span className="block truncate text-muted-foreground text-xs">
                    {meta}
                  </span>
                )}
              </span>
            </Link>
            {statusBadge(item)}
            {item.status === "failed" ? (
              <RetryIngestButton sourceId={item.id} />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

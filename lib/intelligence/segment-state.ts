import { sql } from "drizzle-orm";
import { segmentClip, segmentPlanRun } from "@/lib/db/schema";

// A failed refresh must not hide the last successfully committed chapter
// plan. Segment rows are replaced only inside the successful finalization
// transaction, so their presence is the durable proof that this lifecycle
// row still owns a usable result. Every terminal failure path keeps its new
// error while restoring `ready` when those rows exist.
export const terminalSegmentFailureStatus = sql<"failed" | "ready">`
  CASE WHEN EXISTS (
    SELECT 1 FROM ${segmentClip}
    WHERE ${segmentClip.runId} = ${segmentPlanRun.id}
  ) THEN 'ready' ELSE 'failed' END
`;

import { sql } from "drizzle-orm";
import { segmentClip, segmentPlanRun } from "@/lib/db/schema";
import { SEGMENT_PLAN_ARCHITECTURE_VERSION } from "./segment-architecture";

export type TerminalSegmentStatus = "failed" | "ready";

// Pure mirror of the database policy below. A failed attempt is allowed to
// surface as ready only when the same lifecycle row still owns a previously
// committed Architecture v3 plan carrying a passed Publisher proof. In
// particular, an editorial/publisher failure on the first attempt—or while
// upgrading a legacy plan—can never turn an unverified draft into ready. This
// depends on draft/unchecked Publisher rows never being persisted: segment
// rows enter the database only in the successful finalization transaction.
//
// Keep this function and terminalSegmentFailureStatus's CASE expression in
// lockstep: the function makes the lifecycle truth table unit-testable while
// the SQL expression makes the decision atomically with the status update.
export function terminalSegmentStatus(
  hasCommittedSegments: boolean,
  architectureVersion: number | null,
  publisherStatus: string | null
): TerminalSegmentStatus {
  return hasCommittedSegments &&
    (architectureVersion ?? 0) >= SEGMENT_PLAN_ARCHITECTURE_VERSION &&
    publisherStatus === "passed"
    ? "ready"
    : "failed";
}

// A failed refresh must not hide the last successfully committed chapter
// plan. Segment rows are replaced only inside the successful finalization
// transaction; their presence plus v3/passed run facts are the durable proof
// that this lifecycle row owns a publishable result. Every terminal failure
// path keeps its new error while restoring `ready` only for that proof.
export const terminalSegmentFailureStatus = sql<TerminalSegmentStatus>`
  CASE WHEN
    CASE
      WHEN ${segmentPlanRun.counts}->>'architectureVersion' ~ '^[0-9]+$'
      THEN (${segmentPlanRun.counts}->>'architectureVersion')::integer
      ELSE 0
    END
      >= ${SEGMENT_PLAN_ARCHITECTURE_VERSION}
    AND ${segmentPlanRun.counts}->>'publisherStatus' = 'passed'
    AND EXISTS (
    SELECT 1 FROM ${segmentClip}
    WHERE ${segmentClip.runId} = ${segmentPlanRun.id}
  ) THEN 'ready' ELSE 'failed' END
`;

import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { after } from "next/server";
import { recordAudit } from "@/lib/audit";
import { transcript } from "@/lib/db/schema";
import { withOrgScope } from "@/lib/db/tenant";
import { TRANSCRIPTION_STALL_TTL_MINUTES } from "./window";

const REAP_BATCH_SIZE = 50;

const STALLED_ERROR = "Transcription stopped unexpectedly. Try again.";

// Same contract as isStalledIngest: "claims to be processing, and nothing
// has written to the row for a whole stall window", both sides evaluated in
// the database. Scoped to "processing" only — "pending" is a legitimate
// queue state (worker busy, per-org concurrency), and failing it would
// break the queue rather than clean up after it.
export const isStalledTranscription = and(
  eq(transcript.status, "processing"),
  lt(
    transcript.updatedAt,
    sql`now() - make_interval(mins => ${TRANSCRIPTION_STALL_TTL_MINUTES})`
  )
);

// A hard-killed transcription run never reaches recordTranscriptFailure, so
// the row says "processing" forever — the same failure shape the ingest
// reaper exists for (lib/ingest-reaper.ts), inherited rather than observed:
// the run lives in the same Trigger worker pool and the same dev fallback
// process as ingest, so every kill that strands an ingest can strand this.
export async function reapStalledTranscriptions(
  organizationId: string
): Promise<number> {
  const stalled = await withOrgScope(organizationId, (tx) =>
    tx
      .select({ id: transcript.id, sourceId: transcript.sourceId })
      .from(transcript)
      .where(isStalledTranscription)
      .limit(REAP_BATCH_SIZE)
  );

  if (stalled.length === 0) {
    return 0;
  }

  await withOrgScope(organizationId, async (tx) => {
    await tx
      .update(transcript)
      .set({ error: STALLED_ERROR, status: "failed" })
      .where(
        and(
          // Re-checked: a row that finished between the select and here is
          // a slow run that landed, not a dead one.
          eq(transcript.status, "processing"),
          inArray(
            transcript.id,
            stalled.map((row) => row.id)
          )
        )
      );

    await Promise.all(
      stalled.map((row) =>
        recordAudit(tx, {
          action: "transcript.stalled",
          // No actor: the sweep runs on the system's behalf
          actorUserId: null,
          entityId: row.id,
          entityType: "transcript",
          metadata: {
            sourceId: row.sourceId,
            stallMinutes: TRANSCRIPTION_STALL_TTL_MINUTES,
          },
          organizationId,
        })
      )
    );
  });

  return stalled.length;
}

// Opportunistic sweep, mirroring scheduleIngestReap: stuck transcripts are
// visible on the source page, so that page's render pays for the cleanup —
// and only when its own query flagged a stalled row, so healthy transcripts
// and the poller cost nothing.
export function scheduleTranscriptionReap(organizationId: string): void {
  after(async () => {
    try {
      const reaped = await reapStalledTranscriptions(organizationId);
      if (reaped > 0) {
        console.info(
          `[transcription] marked ${reaped} stalled transcription(s) failed in org ${organizationId}`
        );
      }
    } catch (error) {
      console.error("[transcription] stalled sweep failed:", error);
    }
  });
}

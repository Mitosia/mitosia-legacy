import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { after } from "next/server";
import { recordAudit } from "./audit";
import { source } from "./db/schema";
import { withOrgScope } from "./db/tenant";
import { INGEST_STALL_TTL_MINUTES } from "./ingest-window";

const REAP_BATCH_SIZE = 50;

const STALLED_ERROR =
  "Processing stopped unexpectedly. Try again, or re-upload the file.";

// Reusable predicate: "claims to be processing, and nothing has written to
// it for a whole stall window". Both sides evaluated in the database —
// `updated_at` is a timestamp *without* time zone, so comparing it to a JS
// Date would silently depend on the reading process's time zone.
//
// Scoped to "processing" on purpose. A row at "uploaded" is queued and not
// yet claimed, which is a legitimate state while a worker is busy or
// per-org concurrency is holding it back; failing those would break the
// queue rather than clean up after it.
export const isStalledIngest = and(
  eq(source.status, "processing"),
  lt(
    source.updatedAt,
    sql`now() - make_interval(mins => ${INGEST_STALL_TTL_MINUTES})`
  )
);

// An ingest whose process is hard-killed never runs recordFailure, so the
// row keeps saying "processing" forever and the UI shows a step that will
// never advance. Observed for real: the first Trigger run was OOM-killed
// mid-ladder and left a source stuck on "Preparing playback" with a null
// ingest_error — nothing in the row said anything was wrong.
//
// Any hard kill does this: OOM, worker eviction, a timeout, the in-process
// fallback dying with the dev server. The pipeline cannot clean up after
// itself here by definition — it is not running any more — so something
// outside it has to.
export async function reapStalledIngests(
  organizationId: string
): Promise<number> {
  const stalled = await withOrgScope(organizationId, (tx) =>
    tx
      .select({ id: source.id, step: source.ingestStep })
      .from(source)
      .where(isStalledIngest)
      .limit(REAP_BATCH_SIZE)
  );

  if (stalled.length === 0) {
    return 0;
  }

  await withOrgScope(organizationId, async (tx) => {
    await tx
      .update(source)
      .set({
        ingestError: STALLED_ERROR,
        ingestProgress: null,
        ingestStep: null,
        status: "failed",
      })
      .where(
        and(
          // Re-checked: a row that finished between the select and here is
          // a slow ingest that landed, not a dead one.
          eq(source.status, "processing"),
          inArray(
            source.id,
            stalled.map((row) => row.id)
          )
        )
      );

    await Promise.all(
      stalled.map((row) =>
        recordAudit(tx, {
          action: "source.ingest_stalled",
          // No actor: the sweep runs on the system's behalf, not a user's.
          actorUserId: null,
          entityId: row.id,
          entityType: "source",
          // The step it died on is the one diagnostic worth keeping — it is
          // the difference between "ffmpeg was killed" and "storage hung".
          metadata: {
            stallMinutes: INGEST_STALL_TTL_MINUTES,
            step: row.step,
          },
          organizationId,
        })
      )
    );
  });

  return stalled.length;
}

// Opportunistic sweep, mirroring scheduleUploadReap: the stuck rows are only
// visible on the project page, so that page's render pays for the cleanup.
// No cron to provision, and it works whether or not Trigger.dev is wired up
// — which matters, because a Trigger worker dying is one of the ways rows
// get stuck in the first place. Callers only invoke this when the page they
// just rendered actually contained one (`isStalledIngest` evaluated in the
// same query), so a healthy ingest and its 3.5s poller cost nothing.
export function scheduleIngestReap(organizationId: string): void {
  after(async () => {
    try {
      const reaped = await reapStalledIngests(organizationId);
      if (reaped > 0) {
        console.info(
          `[ingest] marked ${reaped} stalled ingest(s) failed in org ${organizationId}`
        );
      }
    } catch (error) {
      console.error("[ingest] stalled ingest sweep failed:", error);
    }
  });
}

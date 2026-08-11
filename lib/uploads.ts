import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { after } from "next/server";
import { recordAudit } from "./audit";
import { source } from "./db/schema";
import type { OrgTransaction } from "./db/tenant";
import { withOrgScope } from "./db/tenant";
import { abortMultipartUpload } from "./storage";
import {
  UPLOAD_ADOPT_GRACE_SECONDS,
  UPLOAD_IDLE_TTL_HOURS,
} from "./upload-window";

// Shared by the per-source upload routes: the row must be visible inside
// the caller's org scope (RLS) and still mid-upload. Returns null for
// anything else — cross-tenant ids are indistinguishable from missing.
export async function loadUploadingSource(tx: OrgTransaction, id: string) {
  const [row] = await tx
    .select({
      id: source.id,
      status: source.status,
      storageKey: source.storageKey,
      uploadId: source.uploadId,
    })
    .from(source)
    .where(eq(source.id, id))
    .limit(1);

  if (row?.status !== "uploading" || !row.uploadId) {
    return null;
  }
  return { id: row.id, storageKey: row.storageKey, uploadId: row.uploadId };
}

// The other half of resumability, and the one that does not depend on the
// browser keeping anything. Golden Retriever's restore is the fast path: it
// hands the file back with its source id and multipart state intact. But
// that state is destructible — dismissing the recovery card, clearing site
// data, a different browser — and once it is gone the same file re-selected
// into the same project used to start a SECOND multipart upload, stranding
// the first one's parts and leaving a duplicate row stuck at "uploading".
//
// So the server matches on what it can see for itself: same project, same
// filename, same byte size, still mid-upload, and quiet long enough that no
// other tab is plausibly writing to it.
export async function findAdoptableUpload(
  tx: OrgTransaction,
  match: { filename: string; projectId: string; sizeBytes: number }
) {
  const [row] = await tx
    .select({
      id: source.id,
      storageKey: source.storageKey,
      uploadId: source.uploadId,
    })
    .from(source)
    .where(
      and(
        eq(source.status, "uploading"),
        eq(source.projectId, match.projectId),
        eq(source.originalFilename, match.filename),
        eq(source.sizeBytes, match.sizeBytes),
        // Quiet enough to be abandoned rather than in flight…
        lt(
          source.updatedAt,
          sql`now() - make_interval(secs => ${UPLOAD_ADOPT_GRACE_SECONDS})`
        ),
        // …but not so old the reaper is about to abort it underneath us.
        sql`${source.updatedAt} > now() - make_interval(hours => ${UPLOAD_IDLE_TTL_HOURS})`
      )
    )
    .orderBy(desc(source.createdAt))
    .limit(1);

  if (!row?.uploadId) {
    return null;
  }
  return { id: row.id, storageKey: row.storageKey, uploadId: row.uploadId };
}

// Liveness signal for the reaper. Parts go straight to object storage, so
// signing a part is the only trace an in-flight upload leaves on the app
// server — without this, updated_at never moves after the source row is
// created and "idle for a day" would really mean "started a day ago",
// which would kill legitimately slow multi-hour uploads. now() (not a JS
// Date) keeps this on the same clock and time zone as the reaper's cutoff.
export async function touchUpload(
  tx: OrgTransaction,
  id: string
): Promise<void> {
  await tx
    .update(source)
    .set({ updatedAt: sql`now()` })
    .where(eq(source.id, id));
}

// One sweep never handles more than this — a pathological backlog gets
// worked off over several page loads instead of stalling one of them.
const REAP_BATCH_SIZE = 50;

const ABANDONED_ERROR =
  "Upload never finished. Upload the file again to replace it.";

// Reusable predicate: "still claims to be uploading, and nothing has
// touched it for a whole idle window". Evaluated in the database on both
// sides of the comparison — `updated_at` is a timestamp *without* time
// zone, so mixing it with a JS Date would silently depend on whichever
// time zone the reading process happens to run in.
export const isStaleUpload = and(
  eq(source.status, "uploading"),
  lt(
    source.updatedAt,
    sql`now() - make_interval(hours => ${UPLOAD_IDLE_TTL_HOURS})`
  )
);

// Abandoned uploads (tab closed, browser quit, resume window missed) leave
// a source row stuck at "uploading" forever, rendering as a permanent
// ghost in the project list — and an incomplete multipart upload that R2
// bills for. Marks them failed and releases the storage-side parts.
export async function reapStaleUploads(
  organizationId: string
): Promise<number> {
  const stale = await withOrgScope(organizationId, (tx) =>
    tx
      .select({
        id: source.id,
        storageKey: source.storageKey,
        uploadId: source.uploadId,
      })
      .from(source)
      .where(isStaleUpload)
      .limit(REAP_BATCH_SIZE)
  );

  if (stale.length === 0) {
    return 0;
  }

  // Storage first, mirroring the abort route: releasing the parts is the
  // point. A failure here is not fatal (R2's 7-day abort rule is the
  // backstop) but it must not leave the row claiming to be uploading.
  await Promise.all(
    stale.map(async (row) => {
      if (!row.uploadId) {
        return;
      }
      try {
        await abortMultipartUpload(row.storageKey, row.uploadId);
      } catch {
        // Already aborted, expired, or never created — nothing to release.
      }
    })
  );

  await withOrgScope(organizationId, async (tx) => {
    await tx
      .update(source)
      .set({ ingestError: ABANDONED_ERROR, status: "failed", uploadId: null })
      .where(
        and(
          // Re-check the status: a row that completed between the select
          // and here is a finished upload, not an abandoned one.
          eq(source.status, "uploading"),
          inArray(
            source.id,
            stale.map((row) => row.id)
          )
        )
      );

    await Promise.all(
      stale.map((row) =>
        recordAudit(tx, {
          action: "source.upload_abandoned",
          // No actor: the sweep runs on the system's behalf, not a user's.
          actorUserId: null,
          entityId: row.id,
          entityType: "source",
          metadata: { idleHours: UPLOAD_IDLE_TTL_HOURS },
          organizationId,
        })
      )
    );
  });

  return stale.length;
}

// Opportunistic sweep, scheduled after the response flushes. The ghosts
// are only visible on the project page, so that page's render is what
// triggers it — no cron infrastructure to provision, and it works whether
// or not Trigger.dev is wired up. Callers only invoke this when the page
// they just rendered actually contained a stale upload (`isStaleUpload`
// evaluated in the same query), so the project page re-rendering every
// few seconds during a healthy upload costs nothing.
export function scheduleUploadReap(organizationId: string): void {
  after(async () => {
    try {
      const reaped = await reapStaleUploads(organizationId);
      if (reaped > 0) {
        console.info(
          `[uploads] marked ${reaped} abandoned upload(s) failed in org ${organizationId}`
        );
      }
    } catch (error) {
      console.error("[uploads] stale upload sweep failed:", error);
    }
  });
}

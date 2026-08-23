import { recordAudit } from "@/lib/audit";
import { transcriptRevision } from "@/lib/db/schema";
import { withOrgScope } from "@/lib/db/tenant";
import { recordUsage } from "@/lib/ledger";
import { putJson } from "@/lib/storage";
import { applyWordEdits, type WordEdit } from "./edits";
import { loadCurrentTranscript } from "./store";

// A correction is a NEW revision: the current JSON with word edits applied,
// stored as its own object, with a revision row carrying the editor's user
// id. Never an overwrite — revisions are the audit trail for changes to the
// words, and every stored object is metered in full (AGENTS.md
// §Transcription).

export class StaleRevisionError extends Error {
  constructor() {
    super("The transcript changed since this page loaded. Reload and retry.");
  }
}

export async function createCorrectionRevision(input: {
  baseRevision: number;
  edits: readonly WordEdit[];
  organizationId: string;
  sourceId: string;
  userId: string;
}): Promise<{ revision: number }> {
  const current = await loadCurrentTranscript(
    input.organizationId,
    input.sourceId
  );
  if (!current) {
    throw new Error("No transcript to correct");
  }
  // Optimistic concurrency: the client corrected against a revision it was
  // displaying; a mismatch means someone else revised in between. The
  // unique (transcript_id, revision) index backstops the remaining race
  // between this check and the insert.
  if (current.revision !== input.baseRevision) {
    throw new StaleRevisionError();
  }

  const next = applyWordEdits(current.data, input.edits);
  const revision = current.revision + 1;
  const storageKey = `${current.sourcePrefix}transcript/rev-${revision}.json`;
  const sizeBytes = Buffer.byteLength(JSON.stringify(next));
  await putJson(storageKey, next);

  await withOrgScope(input.organizationId, async (tx) => {
    await tx.insert(transcriptRevision).values({
      createdBy: input.userId,
      metadata: { correctedWords: input.edits.length },
      organizationId: input.organizationId,
      revision,
      sizeBytes,
      storageKey,
      transcriptId: current.transcriptId,
    });

    await recordUsage(tx, {
      correlationId: `storage:transcript:${current.transcriptId}:${revision}`,
      entryType: "storage_bytes",
      metadata: { category: "transcript", revision },
      organizationId: input.organizationId,
      quantity: sizeBytes,
      sourceId: input.sourceId,
      unit: "bytes",
    });

    await recordAudit(tx, {
      action: "transcript.corrected",
      actorUserId: input.userId,
      entityId: current.transcriptId,
      entityType: "transcript",
      metadata: { correctedWords: input.edits.length, revision },
      organizationId: input.organizationId,
    });
  });

  return { revision };
}

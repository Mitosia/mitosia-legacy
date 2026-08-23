import { desc, eq } from "drizzle-orm";
import { source, transcript, transcriptRevision } from "@/lib/db/schema";
import { withOrgScope } from "@/lib/db/tenant";
import { getObject } from "@/lib/storage";
import { sourcePrefixFromOriginalKey } from "@/lib/storage/keys";
import type { TranscriptData } from "./types";

// Server-side access to the current transcript: row state from Postgres,
// word data from the canonical JSON in storage. Shared by the export route
// and the correction flow so "current revision = highest number" is decided
// in exactly one place.

export interface CurrentTranscript {
  data: TranscriptData;
  revision: number;
  sourcePrefix: string;
  speakerLabels: Record<string, string> | null;
  transcriptId: string;
}

export async function loadCurrentTranscript(
  organizationId: string,
  sourceId: string
): Promise<CurrentTranscript | null> {
  const context = await withOrgScope(organizationId, async (tx) => {
    const [transcriptRow] = await tx
      .select({
        id: transcript.id,
        speakerLabels: transcript.speakerLabels,
        status: transcript.status,
      })
      .from(transcript)
      .where(eq(transcript.sourceId, sourceId))
      .limit(1);
    if (transcriptRow?.status !== "ready") {
      return null;
    }

    const [revisionRow] = await tx
      .select({
        revision: transcriptRevision.revision,
        storageKey: transcriptRevision.storageKey,
      })
      .from(transcriptRevision)
      .where(eq(transcriptRevision.transcriptId, transcriptRow.id))
      .orderBy(desc(transcriptRevision.revision))
      .limit(1);

    const [sourceRow] = await tx
      .select({ storageKey: source.storageKey })
      .from(source)
      .where(eq(source.id, sourceId))
      .limit(1);

    return revisionRow && sourceRow
      ? { revisionRow, sourceRow, transcriptRow }
      : null;
  });

  if (!context) {
    return null;
  }

  const object = await getObject(context.revisionRow.storageKey);
  const body = await object.Body?.transformToString();
  if (!body) {
    throw new Error(
      `Transcript object ${context.revisionRow.storageKey} has no body`
    );
  }
  const data = JSON.parse(body) as TranscriptData;
  if (data.version !== 1 || !Array.isArray(data.words)) {
    throw new Error(
      `Transcript object ${context.revisionRow.storageKey} has an unexpected shape`
    );
  }

  return {
    data,
    revision: context.revisionRow.revision,
    sourcePrefix: sourcePrefixFromOriginalKey(context.sourceRow.storageKey),
    speakerLabels:
      (context.transcriptRow.speakerLabels as Record<string, string> | null) ??
      null,
    transcriptId: context.transcriptRow.id,
  };
}

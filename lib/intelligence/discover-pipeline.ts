import { and, eq } from "drizzle-orm";
import {
  type MomentAnalysisContext,
  type MomentSeed,
  runMomentDiscovery,
} from "@/lib/ai/capabilities/moment-discovery";
import {
  canonicalJson,
  hashContextPack,
  type SourceContextPack,
} from "@/lib/ai/context";
import {
  brand,
  campaign,
  client,
  contextSnapshot,
  momentCandidate,
  momentDiscoveryRun,
  organization,
  project,
  source,
  sourceAnalysis,
  sourceChapter,
  sourceExtraction,
  transcriptChunk,
} from "@/lib/db/schema";
import { withOrgScope } from "@/lib/db/tenant";
import { recordUsage } from "@/lib/ledger";
import { sanitizeIngestError } from "@/lib/media/ingest-error";
import { loadCurrentTranscript } from "@/lib/transcription/store";
import { buildMomentRows, type DedupeChunk } from "./moments";

// The S6 discovery workflow, a structural clone of extract-pipeline.ts:
// claim → assemble context + seed inventory → one capability call →
// deterministic post-processing (snap/ground/dedupe/rank in moments.ts) →
// persist rows + metering. Same claim contract, same failure recording,
// runs under Trigger or the in-process dev fallback.
//
// Grounding stays the gate (AGENTS §Source intelligence): candidates whose
// anchor fails to align inside their snapped range persist with
// grounded=false for run stats but never surface.

const DISCOVER_ERROR_MAX_CHARS = 2000;

export interface DiscoveryPayload {
  organizationId: string;
  sourceId: string;
}

interface ClaimedRun {
  attempt: number;
  runId: string;
}

async function claimRun(payload: DiscoveryPayload): Promise<ClaimedRun | null> {
  return await withOrgScope(payload.organizationId, async (tx) => {
    const [existing] = await tx
      .select({
        attempts: momentDiscoveryRun.attempts,
        id: momentDiscoveryRun.id,
        status: momentDiscoveryRun.status,
      })
      .from(momentDiscoveryRun)
      .where(eq(momentDiscoveryRun.sourceId, payload.sourceId))
      .limit(1);

    if (!existing) {
      const [created] = await tx
        .insert(momentDiscoveryRun)
        .values({
          attempts: 1,
          organizationId: payload.organizationId,
          sourceId: payload.sourceId,
          status: "processing",
        })
        .onConflictDoNothing({ target: momentDiscoveryRun.sourceId })
        .returning({ id: momentDiscoveryRun.id });
      return created ? { attempt: 1, runId: created.id } : null;
    }
    if (existing.status === "processing" || existing.status === "ready") {
      return null;
    }
    await tx
      .update(momentDiscoveryRun)
      .set({
        attempts: existing.attempts + 1,
        error: null,
        status: "processing",
      })
      .where(eq(momentDiscoveryRun.id, existing.id));
    return { attempt: existing.attempts + 1, runId: existing.id };
  });
}

// finalAttempt=false (a Trigger retry is coming) parks the row back in
// "pending" — claimable by the next attempt, rendered as still-working —
// instead of flashing a terminal "failed" between attempts (see
// extract-pipeline.ts, same contract).
async function recordRunFailure(
  payload: DiscoveryPayload,
  runId: string,
  error: unknown,
  finalAttempt: boolean
): Promise<void> {
  const message =
    error instanceof Error ? error.message : "Unknown discovery failure";
  await withOrgScope(payload.organizationId, (tx) =>
    tx
      .update(momentDiscoveryRun)
      .set({
        error: sanitizeIngestError(message).slice(0, DISCOVER_ERROR_MAX_CHARS),
        status: finalAttempt ? "failed" : "pending",
      })
      .where(eq(momentDiscoveryRun.id, runId))
  );
}

interface DiscoveryContext {
  analysis: MomentAnalysisContext | null;
  durationSeconds: number;
  pack: SourceContextPack;
  seeds: MomentSeed[];
}

const SEED_LABEL_MAX_CHARS = 100;

function seedLabel(row: { payload: unknown; text: string }): string {
  const payload = (row.payload ?? {}) as { title?: string };
  const label = payload.title ?? row.text;
  return label.length > SEED_LABEL_MAX_CHARS
    ? `${label.slice(0, SEED_LABEL_MAX_CHARS)}…`
    : label;
}

async function assembleContext(
  payload: DiscoveryPayload,
  language: string | null,
  speakerCount: number
): Promise<DiscoveryContext> {
  return await withOrgScope(payload.organizationId, async (tx) => {
    const [row] = await tx
      .select({
        brandName: brand.name,
        clientName: client.name,
        durationSeconds: source.durationSeconds,
        organizationName: organization.name,
        originalFilename: source.originalFilename,
        projectName: project.name,
        title: source.title,
      })
      .from(source)
      .innerJoin(project, eq(source.projectId, project.id))
      .innerJoin(campaign, eq(project.campaignId, campaign.id))
      .innerJoin(brand, eq(campaign.brandId, brand.id))
      .innerJoin(client, eq(brand.clientId, client.id))
      .innerJoin(organization, eq(source.organizationId, organization.id))
      .where(eq(source.id, payload.sourceId))
      .limit(1);
    if (!row?.durationSeconds) {
      throw new Error("Source is not ready for moment discovery");
    }

    // Analysis enriches the prefix when present; discovery still runs
    // without it (chained after extraction, but a failed analysis must not
    // block discovery forever).
    const [analysisRow] = await tx
      .select({
        id: sourceAnalysis.id,
        status: sourceAnalysis.status,
        summary: sourceAnalysis.summary,
      })
      .from(sourceAnalysis)
      .where(eq(sourceAnalysis.sourceId, payload.sourceId))
      .limit(1);
    let analysis: MomentAnalysisContext | null = null;
    if (analysisRow?.status === "ready") {
      const chapters = await tx
        .select({ startMs: sourceChapter.startMs, title: sourceChapter.title })
        .from(sourceChapter)
        .where(eq(sourceChapter.analysisId, analysisRow.id))
        .orderBy(sourceChapter.idx);
      analysis = { chapters, summary: analysisRow.summary };
    }

    // Seed inventory: grounded extractions only — the pass may cite their
    // ids in seedIds but is not limited to them.
    const seedRows = await tx
      .select({
        endMs: sourceExtraction.endMs,
        id: sourceExtraction.id,
        kind: sourceExtraction.kind,
        payload: sourceExtraction.payload,
        startMs: sourceExtraction.startMs,
        text: sourceExtraction.text,
      })
      .from(sourceExtraction)
      .where(
        and(
          eq(sourceExtraction.sourceId, payload.sourceId),
          eq(sourceExtraction.grounded, true)
        )
      )
      .orderBy(sourceExtraction.startMs);
    const seeds: MomentSeed[] = seedRows.map((seed) => ({
      endMs: seed.endMs,
      id: seed.id,
      kind: seed.kind,
      label: seedLabel(seed),
      startMs: seed.startMs,
    }));

    const pack: SourceContextPack = {
      brand: row.brandName ? { name: row.brandName } : null,
      client: row.clientName ? { name: row.clientName } : null,
      kind: "moment-discovery",
      organization: { name: row.organizationName },
      project: row.projectName ? { name: row.projectName } : null,
      source: {
        durationSeconds: row.durationSeconds,
        language,
        originalFilename: row.originalFilename,
        speakerCount,
        title: row.title,
      },
      version: 1,
    };
    return { analysis, durationSeconds: row.durationSeconds, pack, seeds };
  });
}

// Chunk vectors for the semantic dedupe pass. An index that isn't ready is
// not a failure — range-IoU dedupe still runs without vectors.
async function loadDedupeChunks(
  payload: DiscoveryPayload
): Promise<DedupeChunk[]> {
  return await withOrgScope(payload.organizationId, async (tx) => {
    const rows = await tx
      .select({
        embedding: transcriptChunk.embedding,
        endMs: transcriptChunk.endMs,
        startMs: transcriptChunk.startMs,
      })
      .from(transcriptChunk)
      .where(eq(transcriptChunk.sourceId, payload.sourceId))
      .orderBy(transcriptChunk.idx);
    return rows;
  });
}

export async function runDiscovery(
  payload: DiscoveryPayload,
  options: { finalAttempt?: boolean } = {}
): Promise<void> {
  const claimed = await claimRun(payload);
  if (!claimed) {
    return;
  }

  try {
    const transcript = await loadCurrentTranscript(
      payload.organizationId,
      payload.sourceId
    );
    if (!transcript) {
      throw new Error("Source has no ready transcript to discover from");
    }
    const speakerCount = new Set(
      transcript.data.words.map((word) => word.speaker).filter(Boolean)
    ).size;
    const context = await assembleContext(
      payload,
      transcript.data.language,
      speakerCount
    );
    const durationMs = Math.round(context.durationSeconds * 1000);

    const result = await runMomentDiscovery({
      analysis: context.analysis,
      contextPack: context.pack,
      durationMs,
      seeds: context.seeds,
      transcript: transcript.data,
    });

    // seedIds the model invented (not in the inventory it was shown) are
    // dropped deterministically — citations must reference real rows.
    const knownSeedIds = new Set(context.seeds.map((seed) => seed.id));
    const items = result.items.map((item) => ({
      ...item,
      seedIds: item.seedIds.filter((id) => knownSeedIds.has(id)),
    }));

    const chunks = await loadDedupeChunks(payload);
    const rows = buildMomentRows(
      items,
      transcript.data.words,
      durationMs,
      chunks
    );

    await withOrgScope(payload.organizationId, async (tx) => {
      const [snapshot] = await tx
        .insert(contextSnapshot)
        .values({
          content: JSON.parse(canonicalJson(context.pack)),
          hash: hashContextPack(context.pack),
          kind: context.pack.kind,
          organizationId: payload.organizationId,
        })
        .returning({ id: contextSnapshot.id });

      // Re-runs replace: candidates belong to exactly one run per source.
      // (The rerun ACTION refuses while human decisions exist — decided
      // rows are the M1 record — so this delete only ever clears
      // undecided proposals.)
      await tx
        .delete(momentCandidate)
        .where(eq(momentCandidate.sourceId, payload.sourceId));
      if (rows.length > 0) {
        await tx.insert(momentCandidate).values(
          rows.map((row) => ({
            ...row,
            organizationId: payload.organizationId,
            revision: transcript.revision,
            runId: claimed.runId,
            sourceId: payload.sourceId,
          }))
        );
      }

      await tx
        .update(momentDiscoveryRun)
        .set({
          contextSnapshotId: snapshot?.id ?? null,
          counts: {
            grounded: rows.filter((row) => row.grounded).length,
            proposed: rows.length,
            suppressed: rows.filter((row) => row.suppressed).length,
          },
          error: null,
          models: Object.fromEntries(
            result.usage.map((usage) => [
              usage.task,
              { model: usage.model, provider: usage.provider },
            ])
          ),
          revision: transcript.revision,
          status: "ready",
        })
        .where(eq(momentDiscoveryRun.id, claimed.runId));

      // Metering (cross-cutting rule 1): one ai_tokens entry per call.
      for (const usage of result.usage) {
        // biome-ignore lint/performance/noAwaitInLoops: at most one entry, same tx
        await recordUsage(tx, {
          correlationId: `discover:${payload.sourceId}:${claimed.attempt}`,
          entryType: "ai_tokens",
          metadata: {
            costUsd: usage.costUsd,
            inputTokens: usage.inputTokens,
            model: usage.model,
            outputTokens: usage.outputTokens,
            provider: usage.provider,
            sourceHours: context.durationSeconds / 3600,
            task: usage.task,
          },
          organizationId: payload.organizationId,
          quantity: usage.inputTokens + usage.outputTokens,
          sourceId: payload.sourceId,
          unit: "tokens",
        });
      }
    });
  } catch (error) {
    await recordRunFailure(
      payload,
      claimed.runId,
      error,
      options.finalAttempt ?? true
    );
    throw error;
  }
}

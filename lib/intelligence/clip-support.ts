import { and, eq } from "drizzle-orm";
import {
  type ClipPrefixInput,
  type EpisodeBrief,
  episodeBriefSchema,
  runEpisodeBriefPass,
  validateClipProposalMode,
  validateEpisodeBriefGrid,
} from "@/lib/ai/capabilities/episode-clips";
import type { StructuredUsage } from "@/lib/ai/generate";
import { episodeBrief, sourceArtifact } from "@/lib/db/schema";
import { withOrgScope } from "@/lib/db/tenant";
import { recordUsage } from "@/lib/ledger";
import { type ShotsArtifact, shotTimesAboveThreshold } from "@/lib/media/shots";
import { getObject } from "@/lib/storage";

// Shared plumbing for the cutting room's pipelines (docs/
// clip-cut-architecture.md §4): the persisted Director brief and the
// shot-change grid. Both can be returned as absent here; each caller owns the
// policy. Missing shots remain optional, while v3 segment publication treats
// a failed Director pass as fatal because it removes global coverage intent.

interface ClipJobPayload {
  organizationId: string;
  sourceId: string;
  usageCorrelationId?: string;
}

// Shot-change times above the decision threshold, from the ingest
// artifact. Absence (older sources, audio-only sources) is an empty grid.
export async function loadShotTimes(
  payload: ClipJobPayload
): Promise<number[]> {
  const key = await withOrgScope(payload.organizationId, async (tx) => {
    const [row] = await tx
      .select({ storageKey: sourceArtifact.storageKey })
      .from(sourceArtifact)
      .where(
        and(
          eq(sourceArtifact.sourceId, payload.sourceId),
          eq(sourceArtifact.kind, "shots")
        )
      )
      .limit(1);
    return row?.storageKey ?? null;
  });
  if (!key) {
    return [];
  }
  try {
    const object = await getObject(key);
    const body = await object.Body?.transformToString();
    if (!body) {
      return [];
    }
    const parsed = JSON.parse(body) as ShotsArtifact;
    if (parsed.version !== 1 || !Array.isArray(parsed.events)) {
      return [];
    }
    return shotTimesAboveThreshold(parsed);
  } catch (error) {
    console.error("[clips] shot grid unreadable, proceeding without:", error);
    return [];
  }
}

export interface EnsuredBrief {
  brief: EpisodeBrief | null;
  // Non-null only when the Director actually ran this call (ledger entry)
  usage: StructuredUsage | null;
}

// Deterministic mock brief so the CI chain proves the persistence path
// with zero tokens.
function mockBrief(input: ClipPrefixInput): EpisodeBrief {
  const lastParagraph = Math.max(0, input.grid.paragraphs.length - 1);
  return {
    dropZones: [],
    marqueeArcs: [
      {
        endP: Math.min(1, lastParagraph),
        note: "Mock arc note.",
        startP: 0,
        title: "Mock marquee arc",
      },
    ],
    spine: [{ endP: lastParagraph, startP: 0, topic: "Mock episode topic" }],
    tone: "Mock tone: conversational interview.",
  };
}

// The Director's brief, persisted per source + transcript revision
// (§4 Pass 1): reused when fresh, recomposed when the revision moved. Moment
// discovery may still degrade without it; Architecture v3 segment planning
// explicitly treats a missing brief as a publication-gate failure. This row
// is the durable cross-run memory the prompt cache cannot be.
export async function ensureEpisodeBrief(
  payload: ClipJobPayload,
  input: ClipPrefixInput,
  transcriptRevision: number
): Promise<EnsuredBrief> {
  const existing = await withOrgScope(payload.organizationId, async (tx) => {
    const [row] = await tx
      .select({
        brief: episodeBrief.brief,
        revision: episodeBrief.revision,
      })
      .from(episodeBrief)
      .where(eq(episodeBrief.sourceId, payload.sourceId))
      .limit(1);
    return row ?? null;
  });
  if (existing && existing.revision === transcriptRevision) {
    const parsed = episodeBriefSchema.safeParse(existing.brief);
    const gridIssues = parsed.success
      ? validateEpisodeBriefGrid(parsed.data, input.grid)
      : [];
    if (parsed.success && gridIssues.length === 0) {
      return { brief: parsed.data, usage: null };
    }
    // Name the reason: an undiagnosable warn here is how the 2026-08-30
    // recompose-every-run spend hid. Issue strings are paragraph IDs and
    // schema paths, never transcript content.
    console.warn(
      "[clips] stored episode brief failed current validation:",
      parsed.success
        ? gridIssues.join("; ")
        : parsed.error.issues
            .slice(0, 8)
            .map((issue) => `${issue.path.join(".")}: ${issue.code}`)
            .join("; ")
    );
  }

  let brief: EpisodeBrief | null = null;
  let usage: StructuredUsage | null = null;
  let model = "mock";
  if (process.env.ANALYSIS_PROVIDER === "mock") {
    brief = mockBrief(input);
  } else {
    try {
      const { output, usage: passUsage } = await runEpisodeBriefPass(input);
      const validated = validateClipProposalMode(output, "brief");
      if (!validated.proposal) {
        throw new Error(
          `Episode brief failed integrity: ${validated.issues.join("; ")}`
        );
      }
      ({ brief } = validated.proposal);
      usage = passUsage;
      ({ model } = passUsage);
    } catch (error) {
      // The brief conditions the rough passes; it is never a gate. A
      // Director outage degrades to briefless proposals, not a failed run.
      console.error(
        "[clips] episode brief pass failed, proceeding without:",
        error
      );
      return { brief: null, usage: null };
    }
  }
  if (!brief) {
    return { brief: null, usage };
  }

  const persisted = brief;
  await withOrgScope(payload.organizationId, async (tx) => {
    await tx
      .insert(episodeBrief)
      .values({
        brief: persisted,
        model,
        organizationId: payload.organizationId,
        revision: transcriptRevision,
        sourceId: payload.sourceId,
      })
      .onConflictDoUpdate({
        set: {
          brief: persisted,
          model,
          revision: transcriptRevision,
          updatedAt: new Date(),
        },
        target: episodeBrief.sourceId,
      });
    if (usage && payload.usageCorrelationId) {
      await recordUsage(tx, {
        correlationId: payload.usageCorrelationId,
        entryType: "ai_tokens",
        metadata: {
          attemptedModels: usage.attemptedModels,
          attempts: usage.attempts,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
          costUsd: usage.costUsd,
          inputTokens: usage.inputTokens,
          model: usage.model,
          outputTokens: usage.outputTokens,
          provider: usage.provider,
          task: usage.task,
          upstreamProvider: usage.upstreamProvider,
        },
        organizationId: payload.organizationId,
        quantity: usage.inputTokens + usage.outputTokens,
        sourceId: payload.sourceId,
        unit: "tokens",
      });
    }
  });
  return { brief, usage };
}

// Bounded concurrency for the per-clip Cutter calls: enough parallelism
// to keep a 20-candidate source fast, low enough to stay polite to the
// provider from one worker.
export const FINE_CUT_CONCURRENCY = 4;

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) {
          return;
        }
        const item = items[index];
        if (item === undefined) {
          return;
        }
        // biome-ignore lint/performance/noAwaitInLoops: bounded worker pool
        results[index] = await fn(item, index);
      }
    }
  );
  await Promise.all(workers);
  return results;
}

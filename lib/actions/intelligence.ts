"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { ActionState } from "@/lib/action-state";
import { recordAudit } from "@/lib/audit";
import { sourceExtractionRun } from "@/lib/db/schema";
import { withOrgScope } from "@/lib/db/tenant";
import { enqueueExtractionRerun } from "@/lib/intelligence/extract-enqueue";
import { type AskResult, askSource } from "@/lib/intelligence/qa";
import { searchSourceChunks } from "@/lib/intelligence/retrieval";
import { recordUsage } from "@/lib/ledger";
import { requireOrg } from "@/lib/org";

// Re-running extraction is a HUMAN action by design (AGENTS §Source
// intelligence): a failed run must not become a paid retry loop, and
// re-extracting after transcript corrections re-spends real model tokens.
// claimRun() in the pipeline makes double-clicks collapse to one run.
export async function rerunExtractionAction(
  _state: ActionState,
  formData: FormData
): Promise<ActionState> {
  const parsedId = z.uuid().safeParse(formData.get("sourceId"));
  if (!parsedId.success) {
    return { error: "Invalid source reference." };
  }
  const { organizationId, userId } = await requireOrg();

  const run = await withOrgScope(organizationId, async (tx) => {
    const [row] = await tx
      .select({
        id: sourceExtractionRun.id,
        status: sourceExtractionRun.status,
      })
      .from(sourceExtractionRun)
      .where(eq(sourceExtractionRun.sourceId, parsedId.data))
      .limit(1);
    return row ?? null;
  });
  // A missing row is legitimate: pre-S5 sources never had the automatic
  // chain fire (it only runs from a fresh analysis), and this button is
  // exactly how they get their first run.
  if (run && (run.status === "processing" || run.status === "pending")) {
    return { error: "Extraction is already running." };
  }

  await withOrgScope(organizationId, (tx) =>
    recordAudit(tx, {
      action: run ? "source_extraction.rerun" : "source_extraction.started",
      actorUserId: userId,
      entityId: run?.id,
      entityType: "source_extraction_run",
      organizationId,
    })
  );
  await enqueueExtractionRerun({ organizationId, sourceId: parsedId.data });

  revalidatePath(`/sources/${parsedId.data}`);
  return { success: true };
}

const askSchema = z.object({
  question: z.string().trim().min(3).max(500),
  sourceId: z.uuid(),
});

export interface AskActionState extends ActionState {
  result?: AskResult & { question: string };
}

// Interactive Q&A — synchronous by design (a human is waiting seconds, not
// a workflow running minutes), so no lifecycle row/reaper: the answer
// either returns or the error does.
export async function askSourceAction(
  _state: AskActionState,
  formData: FormData
): Promise<AskActionState> {
  const parsed = askSchema.safeParse({
    question: formData.get("question"),
    sourceId: formData.get("sourceId"),
  });
  if (!parsed.success) {
    return { error: "Ask a question between 3 and 500 characters." };
  }
  const { organizationId, userId } = await requireOrg();

  try {
    const result = await askSource({
      organizationId,
      question: parsed.data.question,
      sourceId: parsed.data.sourceId,
      userId,
    });
    return {
      result: { ...result, question: parsed.data.question },
      success: true,
    };
  } catch (error) {
    console.error("[qa] ask failed:", error);
    return {
      error:
        error instanceof Error
          ? error.message
          : "The question could not be answered. Try again.",
    };
  }
}

const searchSchema = z.object({
  query: z.string().trim().min(2).max(200),
  sourceId: z.uuid(),
});

export interface SearchActionState extends ActionState {
  results?: {
    endMs: number;
    score: number;
    snippet: string;
    startMs: number;
  }[];
}

const SEARCH_LIMIT = 8;
const SNIPPET_MAX_CHARS = 220;

export async function searchSourceAction(
  _state: SearchActionState,
  formData: FormData
): Promise<SearchActionState> {
  const parsed = searchSchema.safeParse({
    query: formData.get("query"),
    sourceId: formData.get("sourceId"),
  });
  if (!parsed.success) {
    return { error: "Search with at least 2 characters." };
  }
  const { organizationId } = await requireOrg();

  try {
    const retrieval = await searchSourceChunks(
      organizationId,
      parsed.data.sourceId,
      parsed.data.query,
      SEARCH_LIMIT
    );
    // Metering (cross-cutting rule 1): a search embeds the query — tiny,
    // but real spend is never off-ledger. Random correlation: every search
    // is its own event, there is nothing to dedupe against.
    if (retrieval.embedTokens > 0) {
      await withOrgScope(organizationId, (tx) =>
        recordUsage(tx, {
          correlationId: `search:${crypto.randomUUID()}`,
          entryType: "ai_tokens",
          metadata: {
            kind: "embedding",
            model: retrieval.embedModel,
            purpose: "search",
          },
          organizationId,
          quantity: retrieval.embedTokens,
          sourceId: parsed.data.sourceId,
          unit: "tokens",
        })
      );
    }
    return {
      results: retrieval.chunks.map((chunk) => ({
        endMs: chunk.endMs,
        score: chunk.score,
        snippet:
          chunk.text.length > SNIPPET_MAX_CHARS
            ? `${chunk.text.slice(0, SNIPPET_MAX_CHARS)}…`
            : chunk.text,
        startMs: chunk.startMs,
      })),
      success: true,
    };
  } catch (error) {
    console.error("[search] failed:", error);
    return { error: "Search is unavailable right now. Try again." };
  }
}

import { desc, eq } from "drizzle-orm";
import {
  type QaChunk,
  runSourceQa,
  verifyCitations,
} from "@/lib/ai/capabilities/source-qa";
import { estimateEmbeddingCostUsd } from "@/lib/ai/config";
import {
  captureStructuredUsage,
  type StructuredUsage,
  structuredFailureUsages,
} from "@/lib/ai/generate";
import { recordStructuredUsages } from "@/lib/ai/metering";
import {
  source,
  sourceAnalysis,
  sourceChapter,
  sourceIndex,
  sourceQuestion,
} from "@/lib/db/schema";
import { withOrgScope } from "@/lib/db/tenant";
import { recordUsage } from "@/lib/ledger";
import { sanitizeIngestError } from "@/lib/media/ingest-error";
import { searchSourceChunks } from "./retrieval";

// Ask-a-source (S5): retrieve → answer → VERIFY citations → persist +
// meter. Interactive (a server action, not a Trigger task) — seconds of
// latency, a human waiting. The verification step is the deterministic
// guardrail: every citation must overlap a retrieved chunk and is clamped
// to it, so the exit-test property — playable timestamped evidence — holds
// by construction, not by trust.

const RETRIEVAL_LIMIT = 10;
const QA_ERROR_MAX_CHARS = 500;

export interface AskResult {
  answer: string;
  answerable: boolean;
  citations: { endMs: number; quote: string; startMs: number }[];
  questionId: string;
}

async function loadQaContext(organizationId: string, sourceId: string) {
  return await withOrgScope(organizationId, async (tx) => {
    const [indexRow] = await tx
      .select({ status: sourceIndex.status })
      .from(sourceIndex)
      .where(eq(sourceIndex.sourceId, sourceId))
      .limit(1);
    const [sourceRow] = await tx
      .select({ title: source.title })
      .from(source)
      .where(eq(source.id, sourceId))
      .limit(1);
    const [analysisRow] = await tx
      .select({
        id: sourceAnalysis.id,
        status: sourceAnalysis.status,
        summary: sourceAnalysis.summary,
      })
      .from(sourceAnalysis)
      .where(eq(sourceAnalysis.sourceId, sourceId))
      .limit(1);
    const chapters =
      analysisRow?.status === "ready"
        ? await tx
            .select({
              startMs: sourceChapter.startMs,
              title: sourceChapter.title,
            })
            .from(sourceChapter)
            .where(eq(sourceChapter.analysisId, analysisRow.id))
            .orderBy(sourceChapter.idx)
        : [];
    return {
      chapters,
      indexReady: indexRow?.status === "ready",
      summary: analysisRow?.status === "ready" ? analysisRow.summary : null,
      title: sourceRow?.title ?? "Recording",
    };
  });
}

export async function askSource(input: {
  organizationId: string;
  question: string;
  sourceId: string;
  userId: string;
}): Promise<AskResult> {
  const context = await loadQaContext(input.organizationId, input.sourceId);
  if (!context.indexReady) {
    throw new Error("This source is still being indexed. Try again shortly.");
  }

  const capturedUsage: StructuredUsage[] = [];
  let retrievalMetering: {
    costUsd: number | null;
    model: string;
    tokens: number;
  } | null = null;
  try {
    return await captureStructuredUsage(capturedUsage, async () => {
      const retrieval = await searchSourceChunks(
        input.organizationId,
        input.sourceId,
        input.question,
        RETRIEVAL_LIMIT
      );
      retrievalMetering = {
        costUsd: estimateEmbeddingCostUsd(
          retrieval.embedModel,
          retrieval.embedTokens
        ),
        model: retrieval.embedModel,
        tokens: retrieval.embedTokens,
      };
      const chunks: QaChunk[] = retrieval.chunks.map((chunk) => ({
        endMs: chunk.endMs,
        idx: chunk.idx,
        startMs: chunk.startMs,
        text: chunk.text,
      }));

      const result = await runSourceQa({
        chapters: context.chapters,
        chunks,
        question: input.question,
        summary: context.summary,
        title: context.title,
      });

      const citations = result.output.answerable
        ? verifyCitations(result.output.citations, chunks)
        : [];

      const questionId = await withOrgScope(
        input.organizationId,
        async (tx) => {
          const componentCosts = [
            estimateEmbeddingCostUsd(
              retrieval.embedModel,
              retrieval.embedTokens
            ),
            ...result.usage.map((usage) => usage.costUsd),
          ];
          const totalCostUsd = componentCosts.every(
            (cost): cost is number => cost !== null
          )
            ? componentCosts.reduce((total, cost) => total + cost, 0)
            : null;
          const [row] = await tx
            .insert(sourceQuestion)
            .values({
              answer: result.output.answer,
              answerable: result.output.answerable,
              citations,
              createdBy: input.userId,
              metadata: {
                costUsd: totalCostUsd,
                embedModel: retrieval.embedModel,
                embedTokens: retrieval.embedTokens,
                models: result.usage.map((usage) => ({
                  attemptedModels: usage.attemptedModels,
                  attempts: usage.attempts,
                  cacheReadTokens: usage.cacheReadTokens,
                  cacheWriteTokens: usage.cacheWriteTokens,
                  inputTokens: usage.inputTokens,
                  model: usage.model,
                  outputTokens: usage.outputTokens,
                  provider: usage.provider,
                  upstreamProvider: usage.upstreamProvider,
                })),
              },
              organizationId: input.organizationId,
              question: input.question,
              sourceId: input.sourceId,
              status: "ready",
            })
            .returning({ id: sourceQuestion.id });
          if (!row) {
            throw new Error("Question row was not created");
          }

          // Metering (cross-cutting rule 1): the query embedding and the
          // answer call are both real spend.
          if (retrieval.embedTokens > 0) {
            await recordUsage(tx, {
              correlationId: `qa:${row.id}:embed`,
              entryType: "ai_tokens",
              metadata: {
                costUsd: estimateEmbeddingCostUsd(
                  retrieval.embedModel,
                  retrieval.embedTokens
                ),
                kind: "embedding",
                model: retrieval.embedModel,
                questionId: row.id,
              },
              organizationId: input.organizationId,
              quantity: retrieval.embedTokens,
              sourceId: input.sourceId,
              unit: "tokens",
            });
          }
          for (const usage of result.usage) {
            // biome-ignore lint/performance/noAwaitInLoops: one entry, same tx
            await recordUsage(tx, {
              correlationId: `qa:${row.id}:answer`,
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
                questionId: row.id,
                task: usage.task,
                upstreamProvider: usage.upstreamProvider,
              },
              organizationId: input.organizationId,
              quantity: usage.inputTokens + usage.outputTokens,
              sourceId: input.sourceId,
              unit: "tokens",
            });
          }
          return row.id;
        }
      );

      return {
        answer: result.output.answer,
        answerable: result.output.answerable,
        citations,
        questionId,
      };
    });
  } catch (error) {
    // A failed ask still leaves a row — history shows the miss, and the
    // question text is not lost.
    const message =
      error instanceof Error ? error.message : "Unknown Q&A failure";
    await withOrgScope(input.organizationId, async (tx) => {
      const [row] = await tx
        .insert(sourceQuestion)
        .values({
          createdBy: input.userId,
          error: sanitizeIngestError(message).slice(0, QA_ERROR_MAX_CHARS),
          organizationId: input.organizationId,
          question: input.question,
          sourceId: input.sourceId,
          status: "failed",
        })
        .returning({ id: sourceQuestion.id });
      if (!row) {
        return;
      }
      if (retrievalMetering && retrievalMetering.tokens > 0) {
        await recordUsage(tx, {
          correlationId: `qa:${row.id}:embed`,
          entryType: "ai_tokens",
          metadata: {
            costUsd: retrievalMetering.costUsd,
            failed: true,
            kind: "embedding",
            model: retrievalMetering.model,
            questionId: row.id,
          },
          organizationId: input.organizationId,
          quantity: retrievalMetering.tokens,
          sourceId: input.sourceId,
          unit: "tokens",
        });
      }
      await recordStructuredUsages(tx, {
        correlationForTask: (task) => `qa:${row.id}:failed:${task}`,
        failed: true,
        organizationId: input.organizationId,
        sourceId: input.sourceId,
        usages: structuredFailureUsages(error, capturedUsage),
      });
    }).catch(() => {
      // The original error is the one worth surfacing
    });
    throw error;
  }
}

export interface QuestionHistoryItem {
  answer: string | null;
  answerable: boolean | null;
  citations: { endMs: number; quote: string; startMs: number }[];
  id: string;
  question: string;
}

export async function listRecentQuestions(
  organizationId: string,
  sourceId: string,
  limit: number
): Promise<QuestionHistoryItem[]> {
  const rows = await withOrgScope(organizationId, (tx) =>
    tx
      .select({
        answer: sourceQuestion.answer,
        answerable: sourceQuestion.answerable,
        citations: sourceQuestion.citations,
        id: sourceQuestion.id,
        question: sourceQuestion.question,
      })
      .from(sourceQuestion)
      .where(eq(sourceQuestion.sourceId, sourceId))
      .orderBy(desc(sourceQuestion.createdAt))
      .limit(limit)
  );
  return rows
    .filter((row) => row.answer !== null)
    .map((row) => ({
      answer: row.answer,
      answerable: row.answerable,
      citations:
        (row.citations as
          | { endMs: number; quote: string; startMs: number }[]
          | null) ?? [],
      id: row.id,
      question: row.question,
    }));
}

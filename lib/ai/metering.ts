import type { OrgTransaction } from "@/lib/db/tenant";
import { recordUsage } from "@/lib/ledger";
import type { StructuredUsage } from "./generate";

interface RecordStructuredUsagesInput {
  callsForTask?: (task: StructuredUsage["task"]) => number;
  correlationForTask: (task: StructuredUsage["task"]) => string;
  failed?: boolean;
  organizationId: string;
  sourceHours?: number;
  sourceId: string;
  usages: readonly StructuredUsage[];
}

export async function recordStructuredUsages(
  tx: OrgTransaction,
  input: RecordStructuredUsagesInput
): Promise<void> {
  for (const usage of input.usages) {
    // biome-ignore lint/performance/noAwaitInLoops: few task-level entries, same transaction
    await recordUsage(tx, {
      correlationId: input.correlationForTask(usage.task),
      entryType: "ai_tokens",
      metadata: {
        attemptedModels: usage.attemptedModels,
        attempts: usage.attempts,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        ...(input.callsForTask
          ? { calls: input.callsForTask(usage.task) }
          : {}),
        costUsd: usage.costUsd,
        ...(input.failed ? { failed: true } : {}),
        inputTokens: usage.inputTokens,
        model: usage.model,
        outputTokens: usage.outputTokens,
        provider: usage.provider,
        ...(input.sourceHours === undefined
          ? {}
          : { sourceHours: input.sourceHours }),
        task: usage.task,
        upstreamProvider: usage.upstreamProvider,
      },
      organizationId: input.organizationId,
      quantity: usage.inputTokens + usage.outputTokens,
      sourceId: input.sourceId,
      unit: "tokens",
    });
  }
}

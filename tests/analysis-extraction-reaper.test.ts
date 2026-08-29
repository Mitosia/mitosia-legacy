import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  dispatchAnalysis: vi.fn(),
  dispatchExtraction: vi.fn(),
  recordAudit: vi.fn(),
  withOrgScope: vi.fn(),
}));

vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@/lib/audit", () => ({ recordAudit: mocks.recordAudit }));
vi.mock("@/lib/db/tenant", () => ({ withOrgScope: mocks.withOrgScope }));
vi.mock("@/lib/analysis/enqueue", () => ({
  dispatchAnalysis: mocks.dispatchAnalysis,
}));
vi.mock("@/lib/intelligence/extract-enqueue", () => ({
  dispatchExtraction: mocks.dispatchExtraction,
}));

import { reapStalledAnalyses } from "@/lib/analysis/reaper";
import { reapStalledExtractions } from "@/lib/intelligence/extract-reaper";

interface RunRow {
  id: string;
  sourceId: string;
}

const updateSets: Record<string, unknown>[] = [];

function selectTransaction(rows: readonly RunRow[]) {
  const builder = {
    from: () => builder,
    limit: async () => rows,
    where: () => builder,
  };
  return { select: () => builder };
}

function updateTransaction(
  results: readonly (readonly RunRow[])[],
  conditions: SQL[]
) {
  let updateIndex = 0;
  return {
    update: () => {
      const rows = results[updateIndex] ?? [];
      updateIndex += 1;
      const builder = {
        returning: async () => rows,
        set: (values: Record<string, unknown>) => {
          updateSets.push(values);
          return builder;
        },
        where: (condition: SQL) => {
          conditions.push(condition);
          return builder;
        },
      };
      return builder;
    },
  };
}

function reaperTransaction(
  selected: readonly RunRow[],
  results: readonly (readonly RunRow[])[],
  conditions: SQL[]
) {
  return {
    ...selectTransaction(selected),
    ...updateTransaction(results, conditions),
  };
}

function useTransaction(transaction: object) {
  return async (
    _organizationId: string,
    operation: (tx: object) => Promise<unknown>
  ): Promise<unknown> => await operation(transaction);
}

function sqlText(condition: SQL): string {
  return new PgDialect().sqlToQuery(condition).sql;
}

describe("analysis and extraction reaper leases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateSets.length = 0;
    mocks.dispatchAnalysis.mockResolvedValue(undefined);
    mocks.dispatchExtraction.mockResolvedValue(undefined);
    mocks.recordAudit.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not reap or audit an analysis whose heartbeat won the update race", async () => {
    const candidate = { id: "analysis-1", sourceId: "source-1" };
    const conditions: SQL[] = [];
    mocks.withOrgScope.mockImplementationOnce(
      useTransaction(reaperTransaction([candidate], [[], []], conditions))
    );

    await expect(reapStalledAnalyses("org-1")).resolves.toBe(0);

    expect(mocks.recordAudit).not.toHaveBeenCalled();
    expect(sqlText(conditions[0] as SQL)).toContain(
      '"source_analysis"."updated_at" < now() - make_interval'
    );
  });

  it("still fails processing extraction rows that win the stale update", async () => {
    const winner = { id: "extract-1", sourceId: "source-1" };
    const loser = { id: "extract-2", sourceId: "source-2" };
    const conditions: SQL[] = [];
    mocks.withOrgScope.mockImplementationOnce(
      useTransaction(
        reaperTransaction([winner, loser], [[winner], []], conditions)
      )
    );

    await expect(reapStalledExtractions("org-1")).resolves.toBe(1);

    expect(mocks.recordAudit).toHaveBeenCalledOnce();
    expect(mocks.recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "source_extraction.stalled",
        entityId: winner.id,
      })
    );
    expect(mocks.dispatchExtraction).not.toHaveBeenCalled();
    expect(sqlText(conditions[0] as SQL)).toContain(
      '"source_extraction_run"."updated_at" < now() - make_interval'
    );
  });

  it("atomically touches and redispatches a stale pending analysis", async () => {
    const pending = { id: "analysis-1", sourceId: "source-1" };
    const conditions: SQL[] = [];
    mocks.withOrgScope.mockImplementationOnce(
      useTransaction(reaperTransaction([pending], [[], [pending]], conditions))
    );

    await expect(reapStalledAnalyses("org-1")).resolves.toBe(1);

    expect(mocks.dispatchAnalysis).toHaveBeenCalledOnce();
    expect(mocks.dispatchAnalysis).toHaveBeenCalledWith({
      organizationId: "org-1",
      sourceId: pending.sourceId,
    });
    expect(mocks.recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "analysis.redispatch_scheduled" })
    );
    expect(updateSets[1]).toEqual({ updatedAt: expect.any(Date) });
  });

  it("leaves a failed redispatch pending for a later sweep", async () => {
    const pending = { id: "extract-1", sourceId: "source-1" };
    const conditions: SQL[] = [];
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.dispatchExtraction.mockRejectedValueOnce(new Error("queue offline"));
    mocks.withOrgScope.mockImplementationOnce(
      useTransaction(reaperTransaction([pending], [[], [pending]], conditions))
    );

    await expect(reapStalledExtractions("org-1")).resolves.toBe(1);

    expect(mocks.dispatchExtraction).toHaveBeenCalledOnce();
    // The pending winner is touched, not transitioned to failed; after the
    // next silence window another sweep may claim it again.
    expect(updateSets[1]).toEqual({ updatedAt: expect.any(Date) });
  });
});

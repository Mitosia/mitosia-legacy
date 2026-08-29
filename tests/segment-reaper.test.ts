import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  dispatchSegmentPlan: vi.fn(),
  recordAudit: vi.fn(),
  withOrgScope: vi.fn(),
}));

vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@/lib/audit", () => ({ recordAudit: mocks.recordAudit }));
vi.mock("@/lib/db/tenant", () => ({ withOrgScope: mocks.withOrgScope }));
vi.mock("@/lib/intelligence/segment-enqueue", () => ({
  dispatchSegmentPlan: mocks.dispatchSegmentPlan,
}));

import {
  isStalledSegmentPlan,
  reapStalledSegmentPlans,
} from "@/lib/intelligence/segment-reaper";

interface RunRow {
  id: string;
  sourceId: string;
  status: "failed" | "pending" | "processing" | "ready";
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const updateSets: unknown[] = [];

interface FakeTransaction {
  select: () => ReturnType<typeof selectBuilder>;
  update: () => ReturnType<typeof updateBuilder>;
}

function selectBuilder(rows: readonly RunRow[]) {
  const builder = {
    from: () => builder,
    limit: async () => rows,
    where: () => builder,
  };
  return builder;
}

function updateBuilder(rows: readonly { id: string }[]) {
  const builder = {
    returning: async () => rows,
    set: (values: unknown) => {
      updateSets.push(values);
      return builder;
    },
    where: () => builder,
  };
  return builder;
}

function countsSqlAt(index: number): string {
  const values = updateSets[index] as { counts?: SQL } | undefined;
  if (!values?.counts) {
    throw new Error(`expected counts SQL in update ${index}`);
  }
  return new PgDialect().sqlToQuery(values.counts).sql;
}

function fakeTransaction(
  selected: readonly RunRow[],
  updateResults: readonly (readonly { id: string }[])[]
): FakeTransaction {
  let updateIndex = 0;
  return {
    select: () => selectBuilder(selected),
    update: () => {
      const result = updateResults[updateIndex] ?? [];
      updateIndex += 1;
      return updateBuilder(result);
    },
  };
}

function useTransaction(transaction: FakeTransaction) {
  return async (
    _organizationId: string,
    operation: (tx: FakeTransaction) => Promise<unknown>
  ): Promise<unknown> => await operation(transaction);
}

function auditActions(): string[] {
  return mocks.recordAudit.mock.calls.map((call) => {
    const input = call[1] as { action: string };
    return input.action;
  });
}

describe("reapStalledSegmentPlans", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateSets.length = 0;
    mocks.recordAudit.mockResolvedValue(undefined);
  });

  it("recovers pending rows only when the undispatched marker is explicit", () => {
    expect(isStalledSegmentPlan).toBeDefined();
    if (!isStalledSegmentPlan) {
      throw new Error("expected a stalled segment-plan predicate");
    }
    const query = new PgDialect().sqlToQuery(isStalledSegmentPlan);

    expect(query.sql).toContain(
      `"segment_plan_run"."counts"->>'dispatchState' = 'pending'`
    );
    expect(query.params).toEqual(
      expect.arrayContaining(["processing", "pending"])
    );
  });

  it("dispatches only pending rows that won the guarded reaper update", async () => {
    const pending: RunRow = {
      id: "pending-run",
      sourceId: "pending-source",
      status: "pending",
    };
    const processing: RunRow = {
      id: "processing-run",
      sourceId: "processing-source",
      status: "processing",
    };
    const claimTransaction = fakeTransaction(
      [pending, processing],
      [[processing], [pending]]
    );
    const confirmationTransaction = fakeTransaction([], [[{ id: pending.id }]]);
    mocks.withOrgScope
      .mockImplementationOnce(useTransaction(claimTransaction))
      .mockImplementationOnce(useTransaction(confirmationTransaction));
    mocks.dispatchSegmentPlan.mockResolvedValue("dispatch-123");

    await expect(reapStalledSegmentPlans("org-1")).resolves.toBe(2);

    expect(mocks.dispatchSegmentPlan).toHaveBeenCalledOnce();
    expect(mocks.dispatchSegmentPlan).toHaveBeenCalledWith({
      dispatchLease: expect.stringMatching(UUID_PATTERN),
      organizationId: "org-1",
      sourceId: pending.sourceId,
    });
    expect(countsSqlAt(1)).toContain("COALESCE");
    expect(countsSqlAt(1)).toContain("jsonb_build_object");
    expect(countsSqlAt(2)).toContain("COALESCE");
    expect(countsSqlAt(2)).toContain("jsonb_build_object");
    expect(auditActions()).toEqual([
      "segment_plan.stalled",
      "segment_plan.redispatch_scheduled",
      "segment_plan.redispatched",
    ]);
  });

  it("does not dispatch a stale candidate that lost the update CAS", async () => {
    const candidate: RunRow = {
      id: "lost-run",
      sourceId: "lost-source",
      status: "pending",
    };
    mocks.withOrgScope.mockImplementationOnce(
      useTransaction(fakeTransaction([candidate], [[], []]))
    );

    await expect(reapStalledSegmentPlans("org-1")).resolves.toBe(0);

    expect(mocks.dispatchSegmentPlan).not.toHaveBeenCalled();
    expect(mocks.recordAudit).not.toHaveBeenCalled();
    expect(mocks.withOrgScope).toHaveBeenCalledOnce();
  });

  it("restores a stalled refresh when committed segments still exist", async () => {
    const processing: RunRow = {
      id: "processing-run",
      sourceId: "processing-source",
      status: "processing",
    };
    const preserved: RunRow = { ...processing, status: "ready" };
    mocks.withOrgScope.mockImplementationOnce(
      useTransaction(fakeTransaction([processing], [[preserved], []]))
    );

    await expect(reapStalledSegmentPlans("org-1")).resolves.toBe(1);

    expect(mocks.dispatchSegmentPlan).not.toHaveBeenCalled();
    expect(auditActions()).toEqual(["segment_plan.refresh_stalled_preserved"]);
  });

  it("fails only a still-pending winner when redispatch rejects", async () => {
    const pending: RunRow = {
      id: "pending-run",
      sourceId: "pending-source",
      status: "pending",
    };
    const claimTransaction = fakeTransaction([pending], [[], [pending]]);
    const failureTransaction = fakeTransaction([], [[{ id: pending.id }]]);
    mocks.withOrgScope
      .mockImplementationOnce(useTransaction(claimTransaction))
      .mockImplementationOnce(useTransaction(failureTransaction));
    mocks.dispatchSegmentPlan.mockRejectedValue(new Error("queue offline"));

    await expect(reapStalledSegmentPlans("org-1")).resolves.toBe(1);

    expect(auditActions()).toEqual([
      "segment_plan.redispatch_scheduled",
      "segment_plan.redispatch_failed",
    ]);
  });

  it("does not confirm a dispatch after another worker replaces its lease", async () => {
    const pending: RunRow = {
      id: "pending-run",
      sourceId: "pending-source",
      status: "pending",
    };
    const claimTransaction = fakeTransaction([pending], [[], [pending]]);
    // Empty RETURNING models the lease-qualified confirmation losing its CAS.
    const staleConfirmationTransaction = fakeTransaction([], [[]]);
    mocks.withOrgScope
      .mockImplementationOnce(useTransaction(claimTransaction))
      .mockImplementationOnce(useTransaction(staleConfirmationTransaction));
    mocks.dispatchSegmentPlan.mockResolvedValue("stale-dispatch");

    await expect(reapStalledSegmentPlans("org-1")).resolves.toBe(1);

    expect(mocks.dispatchSegmentPlan).toHaveBeenCalledWith({
      dispatchLease: expect.stringMatching(UUID_PATTERN),
      organizationId: "org-1",
      sourceId: pending.sourceId,
    });
    expect(auditActions()).toEqual(["segment_plan.redispatch_scheduled"]);
  });

  it("does not fail a run after another worker replaces its lease", async () => {
    const pending: RunRow = {
      id: "pending-run",
      sourceId: "pending-source",
      status: "pending",
    };
    const claimTransaction = fakeTransaction([pending], [[], [pending]]);
    // Empty RETURNING models the lease-qualified failure update losing its CAS.
    const staleFailureTransaction = fakeTransaction([], [[]]);
    mocks.withOrgScope
      .mockImplementationOnce(useTransaction(claimTransaction))
      .mockImplementationOnce(useTransaction(staleFailureTransaction));
    mocks.dispatchSegmentPlan.mockRejectedValue(new Error("late queue error"));

    await expect(reapStalledSegmentPlans("org-1")).resolves.toBe(1);

    expect(auditActions()).toEqual(["segment_plan.redispatch_scheduled"]);
  });

  it("preserves committed segments when pending redispatch fails", async () => {
    const pending: RunRow = {
      id: "pending-run",
      sourceId: "pending-source",
      status: "pending",
    };
    const claimTransaction = fakeTransaction([pending], [[], [pending]]);
    const preserved: RunRow = { ...pending, status: "ready" };
    const failureTransaction = fakeTransaction([], [[preserved]]);
    mocks.withOrgScope
      .mockImplementationOnce(useTransaction(claimTransaction))
      .mockImplementationOnce(useTransaction(failureTransaction));
    mocks.dispatchSegmentPlan.mockRejectedValue(new Error("queue offline"));

    await expect(reapStalledSegmentPlans("org-1")).resolves.toBe(1);

    expect(auditActions()).toEqual([
      "segment_plan.redispatch_scheduled",
      "segment_plan.redispatch_failed_preserved",
    ]);
  });
});

import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  dispatchDiscovery: vi.fn(),
  recordAudit: vi.fn(),
  withOrgScope: vi.fn(),
}));

vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@/lib/audit", () => ({ recordAudit: mocks.recordAudit }));
vi.mock("@/lib/db/tenant", () => ({ withOrgScope: mocks.withOrgScope }));
vi.mock("@/lib/intelligence/discover-enqueue", () => ({
  dispatchDiscovery: mocks.dispatchDiscovery,
}));

import {
  isStalledDiscovery,
  reapStalledDiscoveries,
} from "@/lib/intelligence/discover-reaper";

interface RunRow {
  id: string;
  sourceId: string;
  status: "failed" | "pending" | "processing" | "ready";
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
    set: () => builder,
    where: () => builder,
  };
  return builder;
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

describe("reapStalledDiscoveries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.recordAudit.mockResolvedValue(undefined);
  });

  it("recovers pending rows only when the undispatched marker is explicit", () => {
    expect(isStalledDiscovery).toBeDefined();
    if (!isStalledDiscovery) {
      throw new Error("expected a stalled discovery predicate");
    }
    const query = new PgDialect().sqlToQuery(isStalledDiscovery);

    expect(query.sql).toContain(
      `"moment_discovery_run"."counts"->>'dispatchState' = 'pending'`
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
    mocks.dispatchDiscovery.mockResolvedValue("dispatch-123");

    await expect(reapStalledDiscoveries("org-1")).resolves.toBe(2);

    expect(mocks.dispatchDiscovery).toHaveBeenCalledOnce();
    expect(mocks.dispatchDiscovery).toHaveBeenCalledWith({
      dispatchLease: expect.stringMatching(UUID_PATTERN),
      organizationId: "org-1",
      sourceId: pending.sourceId,
    });
    expect(auditActions()).toEqual([
      "moment_discovery.stalled",
      "moment_discovery.redispatch_scheduled",
      "moment_discovery.redispatched",
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

    await expect(reapStalledDiscoveries("org-1")).resolves.toBe(0);

    expect(mocks.dispatchDiscovery).not.toHaveBeenCalled();
    expect(mocks.recordAudit).not.toHaveBeenCalled();
    expect(mocks.withOrgScope).toHaveBeenCalledOnce();
  });

  it("restores a stalled refresh when committed candidates still exist", async () => {
    const processing: RunRow = {
      id: "processing-run",
      sourceId: "processing-source",
      status: "processing",
    };
    const preserved: RunRow = { ...processing, status: "ready" };
    mocks.withOrgScope.mockImplementationOnce(
      useTransaction(fakeTransaction([processing], [[preserved], []]))
    );

    await expect(reapStalledDiscoveries("org-1")).resolves.toBe(1);

    expect(mocks.dispatchDiscovery).not.toHaveBeenCalled();
    expect(auditActions()).toEqual([
      "moment_discovery.refresh_stalled_preserved",
    ]);
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
    mocks.dispatchDiscovery.mockRejectedValue(new Error("queue offline"));

    await expect(reapStalledDiscoveries("org-1")).resolves.toBe(1);

    expect(auditActions()).toEqual([
      "moment_discovery.redispatch_scheduled",
      "moment_discovery.redispatch_failed",
    ]);
  });

  it("does not confirm a dispatch after another worker replaces its lease", async () => {
    const pending: RunRow = {
      id: "pending-run",
      sourceId: "pending-source",
      status: "pending",
    };
    const claimTransaction = fakeTransaction([pending], [[], [pending]]);
    const staleConfirmationTransaction = fakeTransaction([], [[]]);
    mocks.withOrgScope
      .mockImplementationOnce(useTransaction(claimTransaction))
      .mockImplementationOnce(useTransaction(staleConfirmationTransaction));
    mocks.dispatchDiscovery.mockResolvedValue("stale-dispatch");

    await expect(reapStalledDiscoveries("org-1")).resolves.toBe(1);

    expect(auditActions()).toEqual(["moment_discovery.redispatch_scheduled"]);
  });

  it("does not fail a run after another worker replaces its lease", async () => {
    const pending: RunRow = {
      id: "pending-run",
      sourceId: "pending-source",
      status: "pending",
    };
    const claimTransaction = fakeTransaction([pending], [[], [pending]]);
    const staleFailureTransaction = fakeTransaction([], [[]]);
    mocks.withOrgScope
      .mockImplementationOnce(useTransaction(claimTransaction))
      .mockImplementationOnce(useTransaction(staleFailureTransaction));
    mocks.dispatchDiscovery.mockRejectedValue(new Error("late queue error"));

    await expect(reapStalledDiscoveries("org-1")).resolves.toBe(1);

    expect(auditActions()).toEqual(["moment_discovery.redispatch_scheduled"]);
  });

  it("preserves committed candidates when pending redispatch fails", async () => {
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
    mocks.dispatchDiscovery.mockRejectedValue(new Error("queue offline"));

    await expect(reapStalledDiscoveries("org-1")).resolves.toBe(1);

    expect(auditActions()).toEqual([
      "moment_discovery.redispatch_scheduled",
      "moment_discovery.redispatch_failed_preserved",
    ]);
  });
});

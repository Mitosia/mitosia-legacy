import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  terminalSegmentFailureStatus,
  terminalSegmentStatus,
} from "@/lib/intelligence/segment-state";

describe("terminalSegmentFailureStatus", () => {
  it("fails a first run when required editorial review produces no committed plan", () => {
    expect(terminalSegmentStatus(false, 3, "passed")).toBe("failed");
  });

  it("preserves the previous ready plan when a refresh fails editorial review", () => {
    expect(terminalSegmentStatus(true, 3, "passed")).toBe("ready");
  });

  it("does not resurrect a legacy plan that never passed the Publisher gate", () => {
    expect(terminalSegmentStatus(true, 2, null)).toBe("failed");
    expect(terminalSegmentStatus(true, 3, null)).toBe("failed");
  });

  it("restores ready only when the run still owns committed segment rows", () => {
    const query = new PgDialect().sqlToQuery(terminalSegmentFailureStatus);

    expect(query.sql).toContain("CASE WHEN");
    expect(query.sql).toContain('FROM "segment_clip"');
    expect(query.sql).toContain(
      '"segment_clip"."run_id" = "segment_plan_run"."id"'
    );
    expect(query.sql).toContain("'architectureVersion'");
    expect(query.sql).toContain("'publisherStatus'");
    expect(query.params).toContain(3);
    expect(query.sql).toContain("THEN 'ready' ELSE 'failed' END");
  });
});

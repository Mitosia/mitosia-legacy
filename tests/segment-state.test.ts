import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { terminalSegmentFailureStatus } from "@/lib/intelligence/segment-state";

describe("terminalSegmentFailureStatus", () => {
  it("restores ready only when the run still owns committed segment rows", () => {
    const query = new PgDialect().sqlToQuery(terminalSegmentFailureStatus);

    expect(query.sql).toContain("CASE WHEN EXISTS");
    expect(query.sql).toContain('FROM "segment_clip"');
    expect(query.sql).toContain(
      '"segment_clip"."run_id" = "segment_plan_run"."id"'
    );
    expect(query.sql).toContain("THEN 'ready' ELSE 'failed' END");
  });
});

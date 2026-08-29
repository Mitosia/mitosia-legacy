import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  clipProposalSchema,
  clipProposalTransportSchema,
  segmentPlanTransportSchema,
  validateClipProposalMode,
} from "@/lib/ai/capabilities/episode-clips";
import {
  runSegmentPlan,
  validateSegmentRoughPlan,
} from "@/lib/ai/capabilities/segment-plan";

const keep = {
  anchorText: "A verbatim phrase",
  dropReason: null,
  endP: 1,
  hook: "Why this chapter matters.",
  kind: "keep" as const,
  startP: 0,
  summary: "A complete chapter summary.",
  title: "A complete topic",
};

const drop = {
  anchorText: null,
  dropReason: "sponsor" as const,
  endP: 2,
  hook: null,
  kind: "drop" as const,
  startP: 2,
  summary: null,
  title: null,
};

const validPlan = {
  segments: [keep, drop],
  tableOfContents: [keep.title],
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("clipProposalSchema mode branches", () => {
  const proposal = {
    brief: null,
    candidates: null,
    mode: "segments" as const,
    plan: validPlan,
    reconciliation: null,
  };

  it("accepts exactly the payload branch named by mode", () => {
    expect(clipProposalSchema.safeParse(proposal).success).toBe(true);
  });

  it("rejects a missing or mismatched branch", () => {
    expect(
      clipProposalSchema.safeParse({ ...proposal, plan: null }).success
    ).toBe(false);
    expect(
      clipProposalSchema.safeParse({
        ...proposal,
        candidates: [],
        mode: "moments",
      }).success
    ).toBe(false);
  });

  it("rejects multiple populated branches and empty segment plans", () => {
    expect(
      clipProposalSchema.safeParse({ ...proposal, candidates: [] }).success
    ).toBe(false);
    expect(
      clipProposalSchema.safeParse({
        ...proposal,
        plan: { segments: [], tableOfContents: [] },
      }).success
    ).toBe(false);
  });

  it("normalizes TOC whitespace and rejects blank entries", () => {
    const normalized = clipProposalSchema.safeParse({
      ...proposal,
      plan: { ...validPlan, tableOfContents: [`  ${keep.title}  `] },
    });
    expect(normalized.success).toBe(true);
    if (normalized.success) {
      expect(normalized.data.plan?.tableOfContents).toEqual([keep.title]);
    }
    expect(
      clipProposalSchema.safeParse({
        ...proposal,
        plan: { ...validPlan, tableOfContents: ["   "] },
      }).success
    ).toBe(false);
  });
});

describe("clip proposal transport boundary", () => {
  const envelope = {
    mode: "segments",
    plan: validPlan,
  };

  it("lets a null plan reach the strict validator for a repairable issue", () => {
    const transport = clipProposalTransportSchema.parse({
      ...envelope,
      plan: null,
    });

    expect(validateClipProposalMode(transport, "segments")).toEqual({
      issues: ["plan: segments output must fill plan"],
      proposal: null,
    });
  });

  it("keeps provider-omitted length constraints behind strict validation", () => {
    const transport = clipProposalTransportSchema.parse({
      ...envelope,
      plan: {
        ...validPlan,
        segments: [{ ...keep, title: "x".repeat(121) }, drop],
      },
    });
    const validated = validateClipProposalMode(transport, "segments");

    expect(validated.proposal).toBeNull();
    expect(validated.issues).toEqual([
      "plan.segments.0.title: Too big: expected string to have <=120 characters",
    ]);
  });

  it("rejects a whitespace-only TOC entry after permissive transport", () => {
    const transport = clipProposalTransportSchema.parse({
      ...envelope,
      plan: { ...validPlan, tableOfContents: ["   "] },
    });
    const validated = validateClipProposalMode(transport, "segments");

    expect(validated.proposal).toBeNull();
    expect(validated.issues).toEqual([
      "plan.tableOfContents.0: Too small: expected string to have >=1 characters",
    ]);
  });

  it("uses a small operation-specific schema with no unrelated branches", () => {
    const jsonSchema = z.toJSONSchema(segmentPlanTransportSchema) as {
      properties?: Record<string, unknown>;
    };

    expect(Object.keys(jsonSchema.properties ?? {})).toEqual(["mode", "plan"]);
    expect(
      segmentPlanTransportSchema.safeParse({
        candidates: [],
        ...envelope,
      }).success
    ).toBe(false);
  });
});

describe("validateSegmentRoughPlan", () => {
  it("accepts an exact ordered paragraph cover with one TOC entry per keep", () => {
    expect(validateSegmentRoughPlan(validPlan, 3)).toEqual([]);
  });

  it("keeps anchorless topology valid for the final grounding gate", () => {
    expect(
      validateSegmentRoughPlan(
        {
          ...validPlan,
          segments: [{ ...keep, anchorText: null }, drop],
        },
        3
      )
    ).toEqual([]);
  });

  it("rejects out-of-range, inverted, gapped, and overlapping covers", () => {
    const invalid = {
      segments: [
        { ...keep, endP: 4, startP: 1 },
        { ...drop, endP: 0, startP: 1 },
      ],
      tableOfContents: [keep.title],
    };
    const issues = validateSegmentRoughPlan(invalid, 3);

    expect(issues).toEqual(
      expect.arrayContaining([
        "the partition must start at P000",
        "the partition must end at P002",
        "segment 0 has an invalid paragraph range",
        "segment 1 has an invalid paragraph range",
        "segment 1 does not continue the exact partition",
      ])
    );
  });

  it("rejects keep/drop packaging drift and TOC mismatch", () => {
    const issues = validateSegmentRoughPlan(
      {
        segments: [
          { ...keep, dropReason: "other", hook: null },
          { ...drop, anchorText: "not allowed on a drop", title: "Ad" },
        ],
        tableOfContents: [],
      },
      3
    );

    expect(issues).toEqual(
      expect.arrayContaining([
        "keep segment 0 has invalid packaging",
        "drop segment 1 has invalid packaging",
        "the rough table of contents must map one-to-one to keeps",
      ])
    );
  });

  it("rejects untrimmed or blank TOC entries before persistence", () => {
    for (const entry of [` ${keep.title}`, "   "]) {
      expect(
        validateSegmentRoughPlan({ ...validPlan, tableOfContents: [entry] }, 3)
      ).toContain("table of contents entry 0 must be trimmed and non-empty");
    }
  });
});

describe("mock segment plan", () => {
  it("returns one valid chapter for a short non-empty transcript", async () => {
    vi.stubEnv("ANALYSIS_PROVIDER", "mock");
    const result = await runSegmentPlan({
      analysis: null,
      contextPack: {
        brand: null,
        client: null,
        kind: "segment-plan",
        organization: { name: "Test org" },
        project: null,
        source: {
          durationSeconds: 1,
          language: "en",
          originalFilename: "short.mp4",
          speakerCount: 1,
          title: "Short source",
        },
        version: 1,
      },
      durationMs: 1000,
      momentInventory: [],
      seeds: [],
      transcript: {
        durationMs: 1000,
        language: "en",
        utterances: [],
        version: 1,
        words: [
          {
            confidence: 1,
            endMs: 900,
            speaker: "0",
            startMs: 0,
            text: "A complete thought.",
          },
        ],
      },
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.kind).toBe("keep");
    expect(result.tableOfContents).toHaveLength(1);
  });
});

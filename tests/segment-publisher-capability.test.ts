import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type PublisherDraftDossier,
  runSegmentPublisherEdit,
  runSegmentPublisherVerify,
  segmentPublisherEditSchema,
  validateSegmentPublisherVerification,
} from "@/lib/ai/capabilities/segment-publisher";
import type { SourceContextPack } from "@/lib/ai/context";
import { generateStructured } from "@/lib/ai/generate";
import { buildCutGrid } from "@/lib/intelligence/grid";

vi.mock("@/lib/ai/generate", () => ({
  generateStructured: vi.fn(),
}));

const mockGenerateStructured = vi.mocked(generateStructured);

const contextPack: SourceContextPack = {
  brand: null,
  client: null,
  kind: "segment-plan",
  organization: { name: "Test organization" },
  project: null,
  source: {
    durationSeconds: 4,
    language: "en",
    originalFilename: "publisher.mp4",
    speakerCount: 1,
    title: "Publisher fixture",
  },
  version: 1,
};

const grid = buildCutGrid([
  {
    confidence: 1,
    endMs: 900,
    speaker: "0",
    startMs: 0,
    text: "The setup lands.",
  },
  {
    confidence: 1,
    endMs: 1900,
    speaker: "0",
    startMs: 1000,
    text: "The first topic resolves.",
  },
  {
    confidence: 1,
    endMs: 2900,
    speaker: "0",
    startMs: 2000,
    text: "The second topic begins.",
  },
  {
    confidence: 1,
    endMs: 3900,
    speaker: "0",
    startMs: 3000,
    text: "The second topic resolves.",
  },
]);

const prefix = {
  analysis: null,
  contextPack,
  grid,
  seeds: [],
};

const dossier: PublisherDraftDossier = {
  boundaries: [
    {
      afterText: "The second topic begins.",
      beforeText: "The first topic resolves.",
      id: "B001",
      leftSegmentId: "SEG000",
      rightSegmentId: "SEG001",
    },
  ],
  brief: "Two independently selectable topics.",
  coverage: [
    {
      endSentenceId: 1,
      id: "ARC000",
      label: "First complete topic",
      note: "Preserve its setup and payoff.",
      startSentenceId: 0,
    },
  ],
  segments: [
    {
      anchorText: "The setup lands.",
      closesOn: "The first topic resolves.",
      dropReason: null,
      durationMs: 1900,
      endSentenceId: 1,
      hook: "Why the first topic matters.",
      id: "SEG000",
      kind: "keep",
      opensOn: "The setup lands.",
      startSentenceId: 0,
      summary: "The first complete topic.",
      title: "First topic",
    },
    {
      anchorText: "The second topic begins.",
      closesOn: "The second topic resolves.",
      dropReason: null,
      durationMs: 1900,
      endSentenceId: 3,
      hook: "Why the second topic matters.",
      id: "SEG001",
      kind: "keep",
      opensOn: "The second topic begins.",
      startSentenceId: 2,
      summary: "The second complete topic.",
      title: "Second topic",
    },
  ],
  tableOfContents: ["First topic", "Second topic"],
};

beforeEach(() => {
  mockGenerateStructured.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("segment Publisher capability", () => {
  it("keeps exact-cover semantics out of the portable wire contract but validates the local surface", () => {
    const valid = {
      revisionReason: "The draft is already coherent.",
      slices: dossier.segments.map((segment) => ({
        anchorText: segment.anchorText,
        dropReason: segment.dropReason,
        endSentenceId: segment.endSentenceId,
        hook: segment.hook,
        kind: segment.kind,
        reasonCode: "unchanged" as const,
        reasoning: "The complete topic stands on its own.",
        sourceIds: [segment.id],
        startSentenceId: segment.startSentenceId,
        summary: segment.summary,
        title: segment.title,
      })),
    };
    expect(segmentPublisherEditSchema.safeParse(valid).success).toBe(true);
    expect(
      segmentPublisherEditSchema.safeParse({
        ...valid,
        slices: [{ ...valid.slices[0], sourceIds: [] }],
      }).success
    ).toBe(false);
    expect(
      segmentPublisherEditSchema.safeParse({
        ...valid,
        slices: [{ ...valid.slices[0], startSentenceId: 0.5 }],
      }).success
    ).toBe(false);
  });

  it("provides a deterministic complete mock edit and mock verification", async () => {
    vi.stubEnv("ANALYSIS_PROVIDER", "mock");

    const edited = await runSegmentPublisherEdit(prefix, dossier);
    expect(edited.usage).toBeNull();
    expect(edited.output.slices).toHaveLength(2);
    expect(edited.output.slices.map((slice) => slice.sourceIds)).toEqual([
      ["SEG000"],
      ["SEG001"],
    ]);

    const verified = await runSegmentPublisherVerify(prefix, dossier);
    expect(verified.usage).toBeNull();
    expect(verified.output).toMatchObject({
      publishable: true,
    });
    expect(verified.output.coverageVerdicts).toEqual([
      expect.objectContaining({ coverageId: "ARC000", verdict: "pass" }),
    ]);
    expect(
      verified.output.segmentVerdicts.every(
        (verdict) => verdict.verdict === "pass"
      )
    ).toBe(true);
    expect(
      validateSegmentPublisherVerification(verified.output, dossier)
    ).toEqual([]);
    expect(mockGenerateStructured).not.toHaveBeenCalled();
  });

  it("rejects incomplete verifier coverage and a false publishable claim", () => {
    expect(
      validateSegmentPublisherVerification(
        {
          boundaryVerdicts: [],
          coverageVerdicts: [],
          publishable: true,
          segmentVerdicts: [],
        },
        dossier
      )
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("segment verdicts must cover"),
        expect.stringContaining("boundary verdicts must cover"),
        expect.stringContaining("coverage verdicts must cover"),
      ])
    );
  });

  it("rejects mislabeled boundary endpoints and omitted marquee coverage", () => {
    const passSegment = (segmentId: string) => ({
      issueCode: "none" as const,
      note: "Complete.",
      segmentId,
      suggestedAction: "none" as const,
      verdict: "pass" as const,
    });
    expect(
      validateSegmentPublisherVerification(
        {
          boundaryVerdicts: [
            {
              boundaryId: "B001",
              issueCode: "none",
              leftSegmentId: null,
              note: "Claims the wrong neighbours.",
              rightSegmentId: "SEG000",
              suggestedAction: "none",
              verdict: "pass",
            },
          ],
          coverageVerdicts: [
            {
              coverageId: "ARC000",
              note: "Retained.",
              verdict: "pass",
            },
          ],
          publishable: true,
          segmentVerdicts: [passSegment("SEG000"), passSegment("SEG001")],
        },
        dossier
      )
    ).toContain("boundary verdict B001 must name endpoints SEG000 -> SEG001");

    expect(
      validateSegmentPublisherVerification(
        {
          boundaryVerdicts: [
            {
              boundaryId: "B001",
              issueCode: "none",
              leftSegmentId: "SEG000",
              note: "Valid boundary.",
              rightSegmentId: "SEG001",
              suggestedAction: "none",
              verdict: "pass",
            },
          ],
          coverageVerdicts: [
            {
              coverageId: "ARC000",
              note: "The marquee arc is missing.",
              verdict: "blocker",
            },
          ],
          publishable: true,
          segmentVerdicts: [passSegment("SEG000"), passSegment("SEG001")],
        },
        dossier
      )
    ).toContain("publishable must be false for the supplied verdicts");
  });

  it("uses a shared exact-sentence cached prefix and forwards family exclusion", async () => {
    vi.stubEnv("ANALYSIS_PROVIDER", "openrouter");
    mockGenerateStructured.mockResolvedValueOnce({
      output: {
        boundaryVerdicts: [],
        coverageVerdicts: [],
        publishable: true,
        segmentVerdicts: [],
      },
      usage: null,
    } as never);

    await runSegmentPublisherVerify(prefix, dossier, {
      excludeModelFamilies: ["anthropic"],
    });

    expect(mockGenerateStructured).toHaveBeenCalledOnce();
    const [task, , , , options] = mockGenerateStructured.mock.calls[0] ?? [];
    expect(task).toBe("segment-publisher.verify");
    expect(options).toMatchObject({
      excludeModelFamilies: ["anthropic"],
      outputStrategy: "strictJsonSchema",
    });
    expect(options?.cachedPrefix).toContain("EXACT SENTENCE GRID");
    expect(options?.cachedPrefix).toContain("PARAGRAPH TO SENTENCE MAP");
    expect(options?.cachedPrefix).toContain("s0000");
  });
});

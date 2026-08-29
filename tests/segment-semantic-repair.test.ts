import { generateObject } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runSegmentReconcilePass,
  validateClipProposalMode,
} from "@/lib/ai/capabilities/episode-clips";
import { runSegmentPlan } from "@/lib/ai/capabilities/segment-plan";
import type { SourceContextPack } from "@/lib/ai/context";
import { buildCutGrid } from "@/lib/intelligence/grid";
import {
  applySegmentGrouping,
  numberSegmentAtoms,
} from "@/lib/intelligence/segment-reconcile";
import type { TranscriptData } from "@/lib/transcription/types";

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateObject: vi.fn() };
});

vi.mock("../lib/ai/provider", () => ({
  getModelCandidates: vi.fn(async () => [
    {
      capabilities: {
        promptCaching: "explicit",
        reasoningEffort: true,
        structuredOutputs: true,
      },
      model: { id: "anthropic/claude-opus-5" },
      modelId: "anthropic/claude-opus-5",
      provider: "openrouter",
    },
  ]),
}));

const mockGenerate = vi.mocked(generateObject);

const contextPack: SourceContextPack = {
  brand: null,
  client: null,
  kind: "segment-plan",
  organization: { name: "Test org" },
  project: null,
  source: {
    durationSeconds: 1,
    language: "en",
    originalFilename: "repair.mp4",
    speakerCount: 1,
    title: "Semantic repair fixture",
  },
  version: 1,
};

const transcript: TranscriptData = {
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
};

const validPlan = {
  segments: [
    {
      anchorText: "A complete thought.",
      dropReason: null,
      endP: 0,
      hook: "Why this complete thought matters.",
      kind: "keep" as const,
      startP: 0,
      summary: "The speaker develops one complete thought.",
      title: "One complete topic",
    },
  ],
  tableOfContents: ["One complete topic"],
};

function generated(object: unknown) {
  return {
    object,
    usage: { inputTokens: 10, outputTokens: 5 },
  } as Awaited<ReturnType<typeof generateObject>>;
}

interface CapturedGenerateOptions {
  messages?: {
    content: { text?: string }[];
  }[];
  providerOptions?: {
    openrouter?: {
      provider?: { require_parameters?: boolean };
    };
  };
}

function generatedOptions(callIndex: number): CapturedGenerateOptions {
  return mockGenerate.mock.calls[
    callIndex
  ]?.[0] as unknown as CapturedGenerateOptions;
}

function instructionAt(callIndex: number): string {
  return generatedOptions(callIndex).messages?.[0]?.content[1]?.text ?? "";
}

beforeEach(() => {
  mockGenerate.mockReset();
  vi.stubEnv("ANALYSIS_PROVIDER", "openrouter");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("segment semantic repair", () => {
  it("repairs a transport-valid null plan with the exact strict issue", async () => {
    mockGenerate
      .mockResolvedValueOnce(generated({ mode: "segments", plan: null }))
      .mockResolvedValueOnce(generated({ mode: "segments", plan: validPlan }));

    const result = await runSegmentPlan({
      analysis: null,
      contextPack,
      durationMs: 1000,
      momentInventory: [],
      seeds: [],
      transcript,
    });

    expect(mockGenerate).toHaveBeenCalledTimes(2);
    expect(result.items).toHaveLength(1);
    expect(result.tableOfContents).toEqual(["One complete topic"]);
    expect(result.usage).toHaveLength(2);
    expect(instructionAt(1)).toContain(
      "VALIDATION ERRORS:\n- plan: segments output must fill plan"
    );
    expect(instructionAt(1)).toContain("(no plan returned)");
    for (let callIndex = 0; callIndex < 2; callIndex += 1) {
      expect(generatedOptions(callIndex).providerOptions).toMatchObject({
        openrouter: { provider: { require_parameters: true } },
      });
    }
  });

  it("threads an exact-cover failure into the exported reconcile repair prompt", async () => {
    const atoms = numberSegmentAtoms([
      {
        anchorText: "First source anchor",
        dropReason: null,
        endMs: 500,
        hook: "First hook",
        kind: "keep",
        startMs: 0,
        summary: "First summary",
        title: "First atom",
      },
      {
        anchorText: "Second source anchor",
        dropReason: null,
        endMs: 900,
        hook: "Second hook",
        kind: "keep",
        startMs: 500,
        summary: "Second summary",
        title: "Second atom",
      },
    ]);
    const invalidGroups = [
      {
        atomIds: ["A000"],
        dropReason: null,
        hook: "Incomplete cover hook",
        kind: "keep" as const,
        reasoning: "The second atom was accidentally omitted.",
        summary: "Incomplete cover summary",
        title: "Incomplete cover",
      },
    ];
    const validGroups = [
      {
        atomIds: ["A000", "A001"],
        dropReason: null,
        hook: "The combined topic's hook",
        kind: "keep" as const,
        reasoning: "Both atoms develop one continuous topic.",
        summary: "Both atoms form one complete chapter.",
        title: "Combined topic",
      },
    ];
    mockGenerate
      .mockResolvedValueOnce(
        generated({
          mode: "segment_reconcile",
          reconciliation: { groups: invalidGroups },
        })
      )
      .mockResolvedValueOnce(
        generated({
          mode: "segment_reconcile",
          reconciliation: { groups: validGroups },
        })
      );
    const prefix = {
      analysis: null,
      contextPack,
      grid: buildCutGrid(transcript.words),
      seeds: [],
    };

    const first = await runSegmentReconcilePass(
      prefix,
      null,
      ["First atom", "Second atom"],
      atoms
    );
    const strict = validateClipProposalMode(first.output, "segment_reconcile");
    expect(strict.issues).toEqual([]);
    const firstGroups = strict.proposal?.reconciliation?.groups ?? [];
    const rejected = applySegmentGrouping(atoms, firstGroups);
    expect(rejected).toMatchObject({
      issues: [
        "groups must cover every atom exactly once, contiguously, and in order",
      ],
      status: "fallback",
    });

    const second = await runSegmentReconcilePass(
      prefix,
      null,
      ["First atom", "Second atom"],
      atoms,
      rejected.issues,
      firstGroups
    );
    const repaired = validateClipProposalMode(
      second.output,
      "segment_reconcile"
    );
    expect(repaired.issues).toEqual([]);
    expect(
      applySegmentGrouping(
        atoms,
        repaired.proposal?.reconciliation?.groups ?? []
      )
    ).toMatchObject({
      mergedBoundaries: 1,
      status: "applied",
      tableOfContents: ["Combined topic"],
    });
    expect(mockGenerate).toHaveBeenCalledTimes(2);
    expect(instructionAt(1)).toContain(
      "VALIDATION ERRORS:\n- groups must cover every atom exactly once, contiguously, and in order"
    );
    expect(instructionAt(1)).toContain(
      "0. KEEP A000 — The second atom was accidentally omitted."
    );
  });
});

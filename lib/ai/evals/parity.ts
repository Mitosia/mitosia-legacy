import { runMomentDiscovery } from "@/lib/ai/capabilities/moment-discovery";
import {
  runSegmentPlan,
  type SegmentPlanInput,
} from "@/lib/ai/capabilities/segment-plan";
import { runSourceAnalysis } from "@/lib/ai/capabilities/source-analysis";
import { runSourceExtraction } from "@/lib/ai/capabilities/source-extraction";
import { runSourceQa, verifyCitations } from "@/lib/ai/capabilities/source-qa";
import type { SourceContextPack } from "@/lib/ai/context";
import { createMockEmbeddingProvider } from "@/lib/ai/embeddings/mock";
import {
  type QaOutcome,
  type ScoreReport,
  scoreChapters,
  scoreExtractions,
  scoreMoments,
  scoreQa,
  scoreSegmentBoundaries,
  scoreSegments,
  scoreSpeakerSuggestions,
  scoreSummary,
  segmentBoundaryDecisions,
} from "@/lib/ai/evals/scorers";
import { buildChunks } from "@/lib/intelligence/chunks";
import {
  alignExtraction,
  groundExtractions,
  tokenizeWords,
} from "@/lib/intelligence/grounding";
import { buildMomentRows } from "@/lib/intelligence/moments";
import {
  accumulateReviewMetrics,
  emptyReviewMetrics,
  type ReviewedClipRow,
  reviewMetricsLines,
} from "@/lib/intelligence/review-metrics";
import {
  applySegmentGrouping,
  numberSegmentAtoms,
} from "@/lib/intelligence/segment-reconcile";
import { buildSegmentRows, checkPartition } from "@/lib/intelligence/segments";
import type { TranscriptData, TranscriptWord } from "@/lib/transcription/types";

// Cross-language parity harness for the Python pipeline's eval runner
// (pipeline phase A1). buildParitySnapshots() runs the SAME mock-mode flow
// as `pnpm eval` over every fixture, then records each deterministic
// scorer's exact input and the TS score it produced — plus synthetic
// literal cases that exercise every scorer branch the mock fixtures
// cannot reach. The snapshots are committed under pipeline/tests/parity/;
// `pnpm test` re-derives them so a TS-side change cannot go stale, and
// the Python suite replays them through the ported scorers asserting
// identical scores and identical issue strings. Determinism holds because
// every capability and the embedder run their mock providers.

export const PARITY_SNAPSHOT_VERSION = 1;

export interface ParityCase {
  expected:
    | ScoreReport
    | { errorMessage: string }
    | { decisions: unknown }
    | { lines: string[]; metrics: unknown };
  input: unknown;
  scorer: string;
}

export interface ParitySnapshot {
  cases: ParityCase[];
  name: string;
  version: number;
}

export interface ParityFixture {
  durationMs: number;
  name: string;
  pack: SourceContextPack;
  questions?: {
    answerable: boolean;
    goldEndMs?: number;
    goldStartMs?: number;
    question: string;
  }[];
  transcript: TranscriptData;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [i, value] of a.entries()) {
    dot += value * (b[i] ?? 0);
    normA += value * value;
    normB += (b[i] ?? 0) * (b[i] ?? 0);
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}

const QA_RETRIEVAL_LIMIT = 5;

// Mirrors the runner's evaluateQuestions, pinned to the mock embedder so
// the snapshot never depends on a provider key.
async function evaluateQuestions(fixture: ParityFixture): Promise<QaOutcome[]> {
  const questions = fixture.questions ?? [];
  if (questions.length === 0) {
    return [];
  }
  const provider = createMockEmbeddingProvider();
  const chunks = buildChunks(fixture.transcript);
  const documentVectors = await provider.embed(
    chunks.map((chunk) => chunk.text),
    "document"
  );

  const outcomes: QaOutcome[] = [];
  for (const golden of questions) {
    // biome-ignore lint/performance/noAwaitInLoops: sequential mirrors the eval runner
    const queryVectors = await provider.embed([golden.question], "query");
    const [queryVector] = queryVectors.vectors;
    const ranked = chunks
      .map((chunk, index) => ({
        chunk,
        score: queryVector
          ? cosine(queryVector, documentVectors.vectors[index] ?? [])
          : 0,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, QA_RETRIEVAL_LIMIT)
      .map(({ chunk }) => ({
        endMs: chunk.endMs,
        idx: chunk.idx,
        startMs: chunk.startMs,
        text: chunk.text,
      }));

    const result = await runSourceQa({
      chapters: [],
      chunks: ranked,
      question: golden.question,
      summary: null,
      title: fixture.pack.source.title,
    });
    outcomes.push({
      answer: result.output.answer,
      citations: result.output.answerable
        ? verifyCitations(result.output.citations, ranked)
        : [],
      expectedAnswerable: golden.answerable,
      goldEndMs: golden.goldEndMs,
      goldStartMs: golden.goldStartMs,
      gotAnswerable: result.output.answerable,
      question: golden.question,
    });
  }
  return outcomes;
}

// Strip rows to exactly the fields each scorer reads, so the snapshot is
// the scorer contract rather than whatever the production row happens to
// carry this sprint.
function momentScorerRows(rows: ReturnType<typeof buildMomentRows>) {
  return rows.map((row) => ({
    endMs: row.endMs,
    grounded: row.grounded,
    scores: row.scores,
    startMs: row.startMs,
    suppressed: row.suppressed,
  }));
}

function segmentScorerRows(rows: ReturnType<typeof buildSegmentRows>) {
  return rows.map((row) => ({
    dropReason: row.dropReason,
    endMs: row.endMs,
    grounded: row.grounded,
    kind: row.kind,
    startMs: row.startMs,
  }));
}

function extractionScorerRows(rows: ReturnType<typeof groundExtractions>) {
  return rows.map((row) => ({
    endMs: row.endMs,
    grounded: row.grounded,
    kind: row.kind,
    startMs: row.startMs,
  }));
}

export async function buildFixtureSnapshot(
  fixture: ParityFixture
): Promise<ParitySnapshot> {
  if (process.env.ANALYSIS_PROVIDER !== "mock") {
    throw new Error(
      "Parity snapshots are defined over the deterministic mock providers; set ANALYSIS_PROVIDER=mock"
    );
  }

  const result = await runSourceAnalysis({
    contextPack: fixture.pack,
    durationMs: fixture.durationMs,
    transcript: fixture.transcript,
  });
  const speakerIds = [
    ...new Set(
      fixture.transcript.words
        .map((word) => word.speaker)
        .filter((s): s is string => s !== null)
    ),
  ];

  const extraction = await runSourceExtraction({
    analysis: null,
    contextPack: { ...fixture.pack, kind: "source-extraction" },
    durationMs: fixture.durationMs,
    transcript: fixture.transcript,
  });
  const groundedRows = extractionScorerRows(
    groundExtractions(
      extraction.items,
      fixture.transcript.words,
      fixture.durationMs
    )
  );

  const discovery = await runMomentDiscovery({
    analysis: null,
    contextPack: { ...fixture.pack, kind: "moment-discovery" },
    durationMs: fixture.durationMs,
    seeds: [],
    transcript: fixture.transcript,
  });
  const momentRows = momentScorerRows(
    buildMomentRows(
      discovery.items,
      fixture.transcript.words,
      fixture.durationMs,
      []
    )
  );

  // Mock mode reconciles with identity groups, exactly like the eval
  // runner's reconcileSegmentsForEval mock branch.
  const segmentInput: SegmentPlanInput = {
    analysis: null,
    contextPack: { ...fixture.pack, kind: "segment-plan" },
    durationMs: fixture.durationMs,
    momentInventory: [],
    seeds: [],
    transcript: fixture.transcript,
  };
  const plan = await runSegmentPlan(segmentInput);
  const atoms = numberSegmentAtoms(plan.items);
  // Mirrors the eval runner's groundedSegmentAtomIds: keeps whose anchor
  // aligns verbatim inside their own range keep their anchors.
  const timedTokens = tokenizeWords(fixture.transcript.words);
  const groundedAtomIds = new Set<string>();
  for (const atom of atoms) {
    if (atom.kind !== "keep" || !atom.anchorText) {
      continue;
    }
    const aligned = alignExtraction(
      atom.anchorText,
      atom.startMs,
      atom.endMs,
      timedTokens
    );
    if (
      aligned.grounded &&
      aligned.startMs >= atom.startMs &&
      aligned.endMs <= atom.endMs
    ) {
      groundedAtomIds.add(atom.atomId);
    }
  }
  const identityGroups = atoms.map((atom) => ({
    atomIds: [atom.atomId],
    dropReason: atom.dropReason,
    hook: atom.hook,
    kind: atom.kind,
    reasoning: "Eval identity group for a rough segment atom.",
    summary: atom.summary,
    title: atom.title,
  }));
  const identity = applySegmentGrouping(atoms, identityGroups, {
    groundedAtomIds,
  });
  const builtSegmentRows = buildSegmentRows(
    identity.items,
    fixture.transcript.words,
    fixture.durationMs,
    []
  );
  const segmentRows = segmentScorerRows(builtSegmentRows);
  const partition = checkPartition(builtSegmentRows, fixture.transcript.words);

  const qaOutcomes = await evaluateQuestions(fixture);

  const cases: ParityCase[] = [
    {
      expected: scoreChapters(result.chapters, fixture.durationMs),
      input: { chapters: result.chapters, durationMs: fixture.durationMs },
      scorer: "chapters",
    },
    {
      expected: scoreSpeakerSuggestions(result.editorial.speakers, speakerIds),
      input: { speakerIds, suggestions: result.editorial.speakers },
      scorer: "speakers",
    },
    {
      expected: scoreSummary(result.editorial.summary),
      input: { summary: result.editorial.summary },
      scorer: "summary",
    },
    {
      expected: scoreExtractions(groundedRows, fixture.durationMs),
      input: { durationMs: fixture.durationMs, rows: groundedRows },
      scorer: "extraction",
    },
    {
      expected: scoreMoments(
        momentRows,
        fixture.durationMs,
        fixture.transcript.words
      ),
      input: {
        durationMs: fixture.durationMs,
        rows: momentRows,
        words: fixture.transcript.words,
      },
      scorer: "moments",
    },
    {
      expected: scoreSegments(segmentRows, partition.ok),
      input: { partitionOk: partition.ok, rows: segmentRows },
      scorer: "segments",
    },
  ];
  if (qaOutcomes.length > 0) {
    cases.push({
      expected: scoreQa(qaOutcomes),
      input: { outcomes: qaOutcomes },
      scorer: "qa",
    });
  }

  return { cases, name: fixture.name, version: PARITY_SNAPSHOT_VERSION };
}

// Words shaped so the moment grid has real structure: two sentences with a
// long pause between them, a speaker change, and clip-range durations.
const SYNTHETIC_WORDS: TranscriptWord[] = [
  { confidence: 0.9, endMs: 9000, speaker: "0", startMs: 0, text: "Opening" },
  {
    confidence: 0.9,
    endMs: 19_000,
    speaker: "0",
    startMs: 10_000,
    text: "thought.",
  },
  {
    confidence: 0.9,
    endMs: 39_000,
    speaker: "1",
    startMs: 30_000,
    text: "Second",
  },
  {
    confidence: 0.9,
    endMs: 49_000,
    speaker: "1",
    startMs: 40_000,
    text: "beat.",
  },
];

const CLEAN_MOMENT_SCORES = {
  comprehensibility: 0.8,
  hook: 0.7,
  insight: 0.6,
  relevance: 0.9,
  risk: 0.1,
};

function report(scorer: string, input: unknown, expected: ScoreReport) {
  return { expected, input, scorer };
}

function boundaryDecisionCase(input: {
  atoms: { atomId: string }[];
  groups: { atomIds: string[] }[];
}): ParityCase {
  try {
    return {
      expected: {
        decisions: segmentBoundaryDecisions(input.atoms, input.groups),
      },
      input,
      scorer: "segment-boundary-decisions",
    };
  } catch (error) {
    return {
      expected: { errorMessage: (error as Error).message },
      input,
      scorer: "segment-boundary-decisions",
    };
  }
}

function chapterCases(): ParityCase[] {
  return [
    report(
      "chapters",
      { chapters: [], durationMs: 60_000 },
      scoreChapters([], 60_000)
    ),
    report(
      "chapters",
      {
        chapters: [
          { endMs: 30_000, startMs: 0, summary: "a", title: "Intro" },
          { endMs: 60_000, startMs: 30_000, summary: "b", title: "Close" },
        ],
        durationMs: 60_000,
      },
      scoreChapters(
        [
          { endMs: 30_000, startMs: 0, summary: "a", title: "Intro" },
          { endMs: 60_000, startMs: 30_000, summary: "b", title: "Close" },
        ],
        60_000
      )
    ),
    report(
      "chapters",
      {
        chapters: [
          { endMs: 20_000, startMs: 0, summary: "a", title: " " },
          { endMs: 25_000, startMs: 10_000, summary: "b", title: "Overlap" },
        ],
        durationMs: 100_000,
      },
      scoreChapters(
        [
          { endMs: 20_000, startMs: 0, summary: "a", title: " " },
          { endMs: 25_000, startMs: 10_000, summary: "b", title: "Overlap" },
        ],
        100_000
      )
    ),
  ];
}

function speakerCases(): ParityCase[] {
  const messy = {
    speakerIds: ["0", "1", "2"],
    suggestions: [
      {
        confidence: 0.5,
        evidence: "",
        mergeWith: "9",
        speaker: "7",
        suggestedName: "Ghost",
      },
      {
        confidence: 0.5,
        evidence: "introduced at the top",
        mergeWith: null,
        speaker: "0",
        suggestedName: "Host",
      },
    ],
  };
  const clean = {
    speakerIds: ["0"],
    suggestions: [
      {
        confidence: 0.9,
        evidence: "introduced at the top",
        mergeWith: null,
        speaker: "0",
        suggestedName: "Host",
      },
    ],
  };
  return [
    report(
      "speakers",
      { speakerIds: [], suggestions: [] },
      scoreSpeakerSuggestions([], [])
    ),
    report(
      "speakers",
      messy,
      scoreSpeakerSuggestions(messy.suggestions, messy.speakerIds)
    ),
    report(
      "speakers",
      clean,
      scoreSpeakerSuggestions(clean.suggestions, clean.speakerIds)
    ),
  ];
}

function summaryCases(): ParityCase[] {
  const clean =
    "This synthetic executive summary describes the recording in enough detail to pass. " +
    "It contains exactly the structure the scorer expects from an editorial summary.";
  const rambling = `${"A sentence. ".repeat(11)}And more.`;
  return [
    report("summary", { summary: clean }, scoreSummary(clean)),
    report(
      "summary",
      { summary: "Short. **md**" },
      scoreSummary("Short. **md**")
    ),
    report("summary", { summary: rambling }, scoreSummary(rambling)),
  ];
}

function extractionCases(): ParityCase[] {
  const messy = [
    { endMs: 5000, grounded: true, kind: "quote", startMs: 1000 },
    { endMs: 900, grounded: true, kind: "quote", startMs: 1000 },
    { endMs: 70_000, grounded: true, kind: "quote", startMs: 60_000 },
    { endMs: 8000, grounded: false, kind: "quote", startMs: 6000 },
  ];
  const clean = [
    { endMs: 5000, grounded: true, kind: "quote", startMs: 1000 },
    { endMs: 9000, grounded: true, kind: "story", startMs: 6000 },
  ];
  return [
    report(
      "extraction",
      { durationMs: 60_000, rows: [] },
      scoreExtractions([], 60_000)
    ),
    report(
      "extraction",
      { durationMs: 60_000, rows: clean },
      scoreExtractions(clean, 60_000)
    ),
    report(
      "extraction",
      { durationMs: 60_000, rows: messy },
      scoreExtractions(messy, 60_000)
    ),
  ];
}

function momentCases(): ParityCase[] {
  const clean = [
    {
      endMs: 19_000,
      grounded: true,
      scores: CLEAN_MOMENT_SCORES,
      startMs: 0,
      suppressed: false,
    },
    {
      endMs: 49_000,
      grounded: true,
      scores: CLEAN_MOMENT_SCORES,
      startMs: 30_000,
      suppressed: false,
    },
  ];
  const messy = [
    {
      endMs: 19_500,
      grounded: true,
      scores: { ...CLEAN_MOMENT_SCORES, hook: 1.2 },
      startMs: 100,
      suppressed: false,
    },
    {
      endMs: 19_000,
      grounded: true,
      scores: CLEAN_MOMENT_SCORES,
      startMs: 0,
      suppressed: false,
    },
    {
      endMs: 49_000,
      grounded: false,
      scores: CLEAN_MOMENT_SCORES,
      startMs: 30_000,
      suppressed: false,
    },
  ];
  return [
    report(
      "moments",
      { durationMs: 60_000, rows: [], words: SYNTHETIC_WORDS },
      scoreMoments([], 60_000, SYNTHETIC_WORDS)
    ),
    report(
      "moments",
      { durationMs: 60_000, rows: clean, words: SYNTHETIC_WORDS },
      scoreMoments(clean, 60_000, SYNTHETIC_WORDS)
    ),
    report(
      "moments",
      { durationMs: 60_000, rows: messy, words: SYNTHETIC_WORDS },
      scoreMoments(messy, 60_000, SYNTHETIC_WORDS)
    ),
  ];
}

function segmentCases(): ParityCase[] {
  const drops = [
    {
      dropReason: "housekeeping",
      endMs: 10_000,
      grounded: false,
      kind: "drop",
      startMs: 0,
    },
    {
      dropReason: null,
      endMs: 20_000,
      grounded: false,
      kind: "drop",
      startMs: 10_000,
    },
  ];
  const clean = [
    {
      dropReason: "housekeeping",
      endMs: 10_000,
      grounded: false,
      kind: "drop",
      startMs: 0,
    },
    {
      dropReason: null,
      endMs: 60_000,
      grounded: true,
      kind: "keep",
      startMs: 10_000,
    },
  ];
  const messy = [
    {
      dropReason: null,
      endMs: 30_000,
      grounded: true,
      kind: "keep",
      startMs: 0,
    },
    {
      dropReason: null,
      endMs: 40_000,
      grounded: false,
      kind: "keep",
      startMs: 20_000,
    },
    {
      dropReason: null,
      endMs: 50_000,
      grounded: false,
      kind: "drop",
      startMs: 40_000,
    },
  ];
  return [
    report(
      "segments",
      { partitionOk: true, rows: [] },
      scoreSegments([], true)
    ),
    report(
      "segments",
      { partitionOk: true, rows: drops },
      scoreSegments(drops, true)
    ),
    report(
      "segments",
      { partitionOk: true, rows: clean },
      scoreSegments(clean, true)
    ),
    report(
      "segments",
      { partitionOk: false, rows: messy },
      scoreSegments(messy, false)
    ),
  ];
}

function boundaryCases(): ParityCase[] {
  const atoms = [{ atomId: "A000" }, { atomId: "A001" }, { atomId: "A002" }];
  const merged = {
    atoms,
    groups: [{ atomIds: ["A000", "A001"] }, { atomIds: ["A002"] }],
  };
  const gold = [
    { afterAtomId: "A000", keep: false, note: "one topic" },
    { afterAtomId: "A001", keep: true },
    { afterAtomId: "A001", keep: true },
    { afterAtomId: "A009", keep: false },
  ];
  const predicted = segmentBoundaryDecisions(merged.atoms, merged.groups);
  return [
    boundaryDecisionCase(merged),
    boundaryDecisionCase({
      atoms,
      groups: [{ atomIds: ["A000", "A000"] }, { atomIds: ["A001", "A002"] }],
    }),
    boundaryDecisionCase({ atoms, groups: [{ atomIds: ["A000", "A001"] }] }),
    {
      expected: scoreSegmentBoundaries(predicted, gold),
      input: { gold, predicted },
      scorer: "segment-boundaries",
    },
    {
      expected: scoreSegmentBoundaries(predicted, []),
      input: { gold: [], predicted },
      scorer: "segment-boundaries",
    },
    {
      expected: scoreSegmentBoundaries(
        [...predicted, { afterAtomId: "A000", keep: true }],
        gold.slice(0, 2)
      ),
      input: {
        gold: gold.slice(0, 2),
        predicted: [...predicted, { afterAtomId: "A000", keep: true }],
      },
      scorer: "segment-boundaries",
    },
  ];
}

function qaCases(): ParityCase[] {
  const outcomes: QaOutcome[] = [
    {
      citations: [{ endMs: 9000, quote: "quoted", startMs: 5000 }],
      expectedAnswerable: true,
      goldEndMs: 8000,
      goldStartMs: 4000,
      gotAnswerable: true,
      question: "Overlapping citation?",
    },
    {
      citations: [{ endMs: 20_000, quote: "elsewhere", startMs: 15_000 }],
      expectedAnswerable: true,
      goldEndMs: 8000,
      goldStartMs: 4000,
      gotAnswerable: true,
      question: "Citation misses gold?",
    },
    {
      citations: [],
      expectedAnswerable: false,
      gotAnswerable: false,
      question: "Honest miss?",
    },
    {
      citations: [],
      expectedAnswerable: false,
      gotAnswerable: true,
      question: "Wrong verdict?",
    },
  ];
  return [
    report("qa", { outcomes: [] }, scoreQa([])),
    report("qa", { outcomes }, scoreQa(outcomes)),
  ];
}

function reviewMetricsCases(): ParityCase[] {
  const rows: ReviewedClipRow[] = [
    {
      adjustedEndMs: 21_500,
      adjustedStartMs: null,
      endMs: 20_000,
      startMs: 10_000,
      status: "accepted",
    },
    {
      adjustedEndMs: null,
      adjustedStartMs: 31_000,
      endMs: 45_000,
      startMs: 30_000,
      status: "accepted",
    },
    {
      adjustedEndMs: null,
      adjustedStartMs: null,
      endMs: 70_000,
      startMs: 60_000,
      status: "accepted",
    },
    {
      adjustedEndMs: null,
      adjustedStartMs: null,
      endMs: 90_000,
      startMs: 80_000,
      status: "rejected",
    },
    {
      adjustedEndMs: null,
      adjustedStartMs: null,
      endMs: 110_000,
      startMs: 100_000,
      status: "shortlisted",
    },
    {
      adjustedEndMs: null,
      adjustedStartMs: null,
      endMs: 130_000,
      startMs: 120_000,
      status: "proposed",
    },
  ];
  const cases: ParityCase[] = [];
  for (const [label, subset] of [
    ["mixed decisions", rows],
    ["no decisions", rows.slice(4)],
    ["accepted pair", rows.slice(0, 2)],
  ] as const) {
    const metrics = emptyReviewMetrics();
    for (const row of subset) {
      accumulateReviewMetrics(metrics, row);
    }
    cases.push({
      expected: { lines: reviewMetricsLines(label, metrics), metrics },
      input: { label, rows: subset },
      scorer: "review-metrics",
    });
  }
  return cases;
}

export function buildSyntheticSnapshot(): ParitySnapshot {
  return {
    cases: [
      ...chapterCases(),
      ...speakerCases(),
      ...summaryCases(),
      ...extractionCases(),
      ...momentCases(),
      ...segmentCases(),
      ...boundaryCases(),
      ...qaCases(),
      ...reviewMetricsCases(),
    ],
    name: "synthetic",
    version: PARITY_SNAPSHOT_VERSION,
  };
}

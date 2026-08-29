import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  runSegmentReconcilePass,
  validateClipProposalMode,
} from "@/lib/ai/capabilities/episode-clips";
import {
  clipPrefixInput,
  runMomentDiscovery,
} from "@/lib/ai/capabilities/moment-discovery";
import {
  runSegmentPlan,
  type SegmentPlanInput,
  type SegmentPlanResult,
} from "@/lib/ai/capabilities/segment-plan";
import {
  runSourceAnalysis,
  transcriptToPromptText,
} from "@/lib/ai/capabilities/source-analysis";
import { runSourceExtraction } from "@/lib/ai/capabilities/source-extraction";
import { runSourceQa, verifyCitations } from "@/lib/ai/capabilities/source-qa";
import type { SourceContextPack } from "@/lib/ai/context";
import { createMockEmbeddingProvider } from "@/lib/ai/embeddings/mock";
import { getEmbeddingProvider } from "@/lib/ai/embeddings/provider";
import { judgeCitationRelevance, judgeSummary } from "@/lib/ai/evals/judge";
import {
  type QaOutcome,
  type SegmentBoundaryDecision,
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
import { buildCutGrid } from "@/lib/intelligence/grid";
import {
  alignExtraction,
  groundExtractions,
  tokenizeWords,
} from "@/lib/intelligence/grounding";
import { buildMomentRows } from "@/lib/intelligence/moments";
import {
  applySegmentGrouping,
  numberSegmentAtoms,
  type SegmentAtom,
  type SegmentGrouping,
} from "@/lib/intelligence/segment-reconcile";
import { buildSegmentRows, checkPartition } from "@/lib/intelligence/segments";
import type { TranscriptData } from "@/lib/transcription/types";

// Golden-eval runner for the source-analysis capability: every fixture in
// evals/fixtures/*.json (committed snippets + gitignored real transcripts
// dropped in locally) goes through the REAL capability, then the
// deterministic scorers and — when a provider key exists — the LLM judge.
//
// Run: `pnpm eval` (needs ANTHROPIC_API_KEY unless ANALYSIS_PROVIDER=mock,
// which smoke-tests the harness itself). Exits non-zero when any
// deterministic score lands under its threshold, so the manual GitHub
// Action (eval.yml) is a real gate. Langfuse dataset sync attaches here
// once the Langfuse account exists — the runner's report shape is already
// per-item scores over named fixtures.

const THRESHOLDS: Record<string, number> = {
  chapters: 0.7,
  // Grounding rate over the model's claimed-verbatim spans — the S5
  // provenance bar. Below 0.8 the extraction prompt is regressing on the
  // one property the product depends on.
  extraction: 0.8,
  // Discovery candidates: grounded-anchor rate with structure penalties
  // (sentence-grid bounds, dedupe, clip-range durations). Off-grid bounds
  // or a dedupe miss halves the score, so 0.8 only passes clean runs.
  moments: 0.8,
  // Answerability verdicts + citation-overlap on the golden questions.
  qa: 0.7,
  // Optional fixture gold over selected semantic boundaries. Macro-averaged
  // KEEP/REMOVE accuracy makes both uniform fragmentation and uniform merging
  // fail without imposing a duration rule.
  "segment-boundaries": 0.8,
  // Segment plan: grounded-keep rate with hard penalties for a broken
  // partition — coverage is the product.
  segments: 0.8,
  speakers: 0.6,
  summary: 0.4,
};
const JUDGE_THRESHOLD = 0.7;

interface Fixture {
  durationMs: number;
  name: string;
  pack: SourceContextPack;
  questions?: {
    answerable: boolean;
    goldEndMs?: number;
    goldStartMs?: number;
    question: string;
  }[];
  // Semantic gold owns a PINNED rough atom plan. Atom IDs are positional and
  // must never be attached to a newly generated rough plan whose topics may
  // differ between model runs. Omit until a human has labeled a stable plan;
  // the runner skips this score rather than inventing gold from duration.
  segmentBoundaryGold?: {
    decisions: SegmentBoundaryDecision[];
    roughItems: SegmentPlanResult["items"];
    tableOfContents: string[];
  };
  transcript: TranscriptData;
}

// In-memory retrieval for the Q&A goldens — the runner has no database, so
// chunking + embedding + cosine run right here, with the same chunker the
// index pipeline uses. Falls back to the mock embedder when no key is set
// (still a real test of retrieval + verification plumbing).
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

async function evaluateQuestions(fixture: Fixture): Promise<QaOutcome[]> {
  const questions = fixture.questions ?? [];
  if (questions.length === 0) {
    return [];
  }
  const provider = getEmbeddingProvider() ?? createMockEmbeddingProvider();
  const chunks = buildChunks(fixture.transcript);
  const documentVectors = await provider.embed(
    chunks.map((chunk) => chunk.text),
    "document"
  );

  const outcomes: QaOutcome[] = [];
  for (const golden of questions) {
    // biome-ignore lint/performance/noAwaitInLoops: sequential keeps rate limits calm
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

// Citation-relevance judge (S6): the deterministic qa score proves
// provenance and gold-range overlap; this grades whether each cited quote
// is actually evidence for its question — the range-valid-but-irrelevant
// rider observed at the S5 exit. Score = relevant citations / citations.
async function judgeCitations(outcomes: readonly QaOutcome[]): Promise<number> {
  const answered = outcomes.filter(
    (outcome) => outcome.gotAnswerable && outcome.citations.length > 0
  );
  if (answered.length === 0) {
    return 0;
  }
  let relevant = 0;
  let total = 0;
  const notes: string[] = [];
  for (const outcome of answered) {
    const quotes = outcome.citations.map((citation) => citation.quote ?? "");
    // biome-ignore lint/performance/noAwaitInLoops: sequential keeps rate limits calm
    const verdict = await judgeCitationRelevance(
      outcome.question,
      outcome.answer ?? "",
      quotes
    );
    total += quotes.length;
    relevant += verdict.relevant.filter(Boolean).length;
    if (verdict.relevant.some((flag) => !flag)) {
      notes.push(`"${outcome.question}": ${verdict.notes}`);
    }
  }
  const score = total === 0 ? 1 : relevant / total;
  return printScore("judge.citation-relevance", score, JUDGE_THRESHOLD, notes)
    ? 0
    : 1;
}

function printScore(
  name: string,
  score: number,
  threshold: number,
  issues: string[]
): boolean {
  const pass = score >= threshold;
  console.log(
    `   ${pass ? "PASS" : "FAIL"} ${name}: ${score.toFixed(2)} (>= ${threshold})${
      issues.length > 0 ? ` — ${issues.join("; ")}` : ""
    }`
  );
  return pass;
}

const SEGMENT_RECONCILE_ATTEMPTS = 2;

interface EvalSegmentReconciliation {
  atoms: SegmentAtom[];
  groups: SegmentGrouping[];
  issues: string[];
  items: SegmentPlanResult["items"];
  status: "applied" | "fallback" | "skipped";
  usage: SegmentPlanResult["usage"];
}

function identitySegmentGroups(
  atoms: readonly SegmentAtom[]
): SegmentGrouping[] {
  return atoms.map((atom) => ({
    atomIds: [atom.atomId],
    dropReason: atom.dropReason,
    hook: atom.hook,
    kind: atom.kind,
    reasoning: "Eval identity group for a rough segment atom.",
    summary: atom.summary,
    title: atom.title,
  }));
}

function groundedSegmentAtomIds(
  atoms: readonly SegmentAtom[],
  transcript: TranscriptData
): Set<string> {
  const tokens = tokenizeWords(transcript.words);
  const grounded = new Set<string>();
  for (const atom of atoms) {
    if (atom.kind !== "keep" || !atom.anchorText) {
      continue;
    }
    const aligned = alignExtraction(
      atom.anchorText,
      atom.startMs,
      atom.endMs,
      tokens
    );
    if (
      aligned.grounded &&
      aligned.startMs >= atom.startMs &&
      aligned.endMs <= atom.endMs
    ) {
      grounded.add(atom.atomId);
    }
  }
  return grounded;
}

async function reconcileSegmentsForEval(
  input: SegmentPlanInput,
  plan: SegmentPlanResult
): Promise<EvalSegmentReconciliation> {
  const atoms = numberSegmentAtoms(plan.items);
  const groundedAtomIds = groundedSegmentAtomIds(atoms, input.transcript);
  const groupingContext = { groundedAtomIds };
  const identityGroups = identitySegmentGroups(atoms);
  const identity = applySegmentGrouping(atoms, identityGroups, groupingContext);
  const hasMergeCandidate = atoms.some(
    (atom, index) => atom.kind === "keep" && atoms[index + 1]?.kind === "keep"
  );
  if (
    atoms.length < 2 ||
    !hasMergeCandidate ||
    process.env.ANALYSIS_PROVIDER === "mock"
  ) {
    return {
      atoms,
      groups: identityGroups,
      issues: identity.issues,
      items: identity.items,
      status: identity.status === "fallback" ? "fallback" : "skipped",
      usage: [],
    };
  }

  const prefix = clipPrefixInput(input, buildCutGrid(input.transcript.words));
  const usage: SegmentPlanResult["usage"] = [];
  let issues: string[] = [];
  let previousGroups: SegmentGrouping[] = [];
  for (let attempt = 0; attempt < SEGMENT_RECONCILE_ATTEMPTS; attempt += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: the second pass repairs the first pass's exact deterministic validation errors
    const run = await runSegmentReconcilePass(
      prefix,
      null,
      plan.tableOfContents,
      atoms.map((atom) => ({
        ...atom,
        anchorText: groundedAtomIds.has(atom.atomId) ? atom.anchorText : null,
      })),
      issues,
      previousGroups
    );
    usage.push(run.usage);
    const validated = validateClipProposalMode(run.output, "segment_reconcile");
    if (!validated.proposal) {
      ({ issues } = validated);
      previousGroups = [];
      continue;
    }
    previousGroups = validated.proposal.reconciliation?.groups ?? [];
    const applied = applySegmentGrouping(
      atoms,
      previousGroups,
      groupingContext
    );
    if (applied.status === "applied") {
      return {
        atoms,
        groups: previousGroups,
        issues: [],
        items: applied.items,
        status: "applied",
        usage,
      };
    }
    const { issues: appliedIssues } = applied;
    issues = appliedIssues;
  }

  return {
    atoms,
    groups: identityGroups,
    issues,
    items: identity.items,
    status: "fallback",
    usage,
  };
}

async function evaluateFixture(
  fixture: Fixture,
  useJudge: boolean
): Promise<number> {
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
  // Extraction runs on the same fixture; grounding uses the production
  // aligner so the eval and the pipeline can never disagree.
  const extraction = await runSourceExtraction({
    analysis: null,
    contextPack: { ...fixture.pack, kind: "source-extraction" },
    durationMs: fixture.durationMs,
    transcript: fixture.transcript,
  });
  const groundedRows = groundExtractions(
    extraction.items,
    fixture.transcript.words,
    fixture.durationMs
  );

  // Discovery runs the real capability + the production post-processing
  // (snap/ground/dedupe/rank), so the eval measures exactly what ships.
  // No seeds/chunks: the runner has no database — range-IoU dedupe still
  // runs, the cosine pass is skipped, matching a source with no index.
  const discovery = await runMomentDiscovery({
    analysis: null,
    contextPack: { ...fixture.pack, kind: "moment-discovery" },
    durationMs: fixture.durationMs,
    seeds: [],
    transcript: fixture.transcript,
  });
  const momentRows = buildMomentRows(
    discovery.items,
    fixture.transcript.words,
    fixture.durationMs,
    []
  );

  // The coverage lane runs the same fixture through the real partition
  // capability, the global semantic Reconciler, and the production tiling
  // gauntlet. Mock mode deliberately uses identity groups; it smoke-tests the
  // harness without pretending to make semantic judgments.
  const segmentInput: SegmentPlanInput = {
    analysis: null,
    contextPack: { ...fixture.pack, kind: "segment-plan" },
    durationMs: fixture.durationMs,
    momentInventory: [],
    seeds: [],
    transcript: fixture.transcript,
  };
  const plan = await runSegmentPlan(segmentInput);
  const reconciliation = await reconcileSegmentsForEval(segmentInput, plan);
  const semanticGold = fixture.segmentBoundaryGold;
  const semanticReconciliation =
    semanticGold &&
    semanticGold.decisions.length > 0 &&
    process.env.ANALYSIS_PROVIDER !== "mock"
      ? await reconcileSegmentsForEval(segmentInput, {
          items: semanticGold.roughItems,
          tableOfContents: semanticGold.tableOfContents,
          usage: [],
        })
      : null;
  const segmentRows = buildSegmentRows(
    reconciliation.items,
    fixture.transcript.words,
    fixture.durationMs,
    []
  );
  const partition = checkPartition(segmentRows, fixture.transcript.words);

  const qaOutcomes = await evaluateQuestions(fixture);

  const scores: Record<string, ReturnType<typeof scoreSummary>> = {
    chapters: scoreChapters(result.chapters, fixture.durationMs),
    extraction: scoreExtractions(groundedRows, fixture.durationMs),
    moments: scoreMoments(
      momentRows,
      fixture.durationMs,
      fixture.transcript.words
    ),
    segments: scoreSegments(segmentRows, partition.ok),
    speakers: scoreSpeakerSuggestions(result.editorial.speakers, speakerIds),
    summary: scoreSummary(result.editorial.summary),
  };
  if (qaOutcomes.length > 0) {
    scores.qa = scoreQa(qaOutcomes);
  }
  if (semanticGold && semanticReconciliation) {
    scores["segment-boundaries"] = scoreSegmentBoundaries(
      segmentBoundaryDecisions(
        semanticReconciliation.atoms,
        semanticReconciliation.groups
      ),
      semanticGold.decisions
    );
  }

  console.log(`── ${fixture.name}`);
  if (reconciliation.status === "fallback") {
    console.log(
      `   WARN segment reconciliation fell back — ${reconciliation.issues.join("; ")}`
    );
  }
  if (semanticReconciliation?.status === "fallback") {
    console.log(
      `   WARN semantic-gold reconciliation fell back — ${semanticReconciliation.issues.join("; ")}`
    );
  }
  let failed = 0;
  for (const [name, report] of Object.entries(scores)) {
    const threshold = THRESHOLDS[name as keyof typeof THRESHOLDS];
    if (!printScore(name, report.score, threshold, report.issues)) {
      failed += 1;
    }
  }

  if (useJudge) {
    const verdict = await judgeSummary(
      transcriptToPromptText(fixture.transcript),
      result.editorial.summary
    );
    if (
      !printScore("judge.faithfulness", verdict.faithfulness, JUDGE_THRESHOLD, [
        verdict.notes,
      ])
    ) {
      failed += 1;
    }
    failed += await judgeCitations(qaOutcomes);
  }

  const spentUsd = [
    ...result.usage,
    ...extraction.usage,
    ...discovery.usage,
    ...plan.usage,
    ...reconciliation.usage,
    ...(semanticReconciliation?.usage ?? []),
  ].reduce((total, usage) => total + (usage.costUsd ?? 0), 0);
  if (spentUsd > 0) {
    console.log(`   cost: $${spentUsd.toFixed(4)}`);
  }
  return failed;
}

async function main(): Promise<void> {
  const dir = join(process.cwd(), "evals", "fixtures");
  const files = readdirSync(dir).filter((file) => file.endsWith(".json"));
  if (files.length === 0) {
    throw new Error("No fixtures in evals/fixtures");
  }
  const useJudge = Boolean(
    process.env.ANTHROPIC_API_KEY && process.env.ANALYSIS_PROVIDER !== "mock"
  );
  console.log(
    `Running ${files.length} fixture(s); judge ${useJudge ? "on" : "off"}\n`
  );

  let failed = 0;
  for (const file of files) {
    const fixture = JSON.parse(
      readFileSync(join(dir, file), "utf8")
    ) as Fixture;
    // biome-ignore lint/performance/noAwaitInLoops: sequential keeps the report readable and rate limits calm
    failed += await evaluateFixture(fixture, useJudge);
  }

  console.log(
    `\n${failed === 0 ? "EVALS PASS" : `EVALS: ${failed} check(s) under threshold`}`
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

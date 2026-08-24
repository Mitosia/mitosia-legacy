import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  runSourceAnalysis,
  transcriptToPromptText,
} from "@/lib/ai/capabilities/source-analysis";
import { runSourceExtraction } from "@/lib/ai/capabilities/source-extraction";
import { runSourceQa, verifyCitations } from "@/lib/ai/capabilities/source-qa";
import type { SourceContextPack } from "@/lib/ai/context";
import { createMockEmbeddingProvider } from "@/lib/ai/embeddings/mock";
import { getEmbeddingProvider } from "@/lib/ai/embeddings/provider";
import { judgeSummary } from "@/lib/ai/evals/judge";
import {
  type QaOutcome,
  scoreChapters,
  scoreExtractions,
  scoreQa,
  scoreSpeakerSuggestions,
  scoreSummary,
} from "@/lib/ai/evals/scorers";
import { buildChunks } from "@/lib/intelligence/chunks";
import { groundExtractions } from "@/lib/intelligence/grounding";
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
  // Answerability verdicts + citation-overlap on the golden questions.
  qa: 0.7,
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

  const qaOutcomes = await evaluateQuestions(fixture);

  const scores: Record<string, ReturnType<typeof scoreSummary>> = {
    chapters: scoreChapters(result.chapters, fixture.durationMs),
    extraction: scoreExtractions(groundedRows, fixture.durationMs),
    speakers: scoreSpeakerSuggestions(result.editorial.speakers, speakerIds),
    summary: scoreSummary(result.editorial.summary),
  };
  if (qaOutcomes.length > 0) {
    scores.qa = scoreQa(qaOutcomes);
  }

  console.log(`── ${fixture.name}`);
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
  }

  const spentUsd = [...result.usage, ...extraction.usage].reduce(
    (total, usage) => total + (usage.costUsd ?? 0),
    0
  );
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

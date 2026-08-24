import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  runSourceAnalysis,
  transcriptToPromptText,
} from "@/lib/ai/capabilities/source-analysis";
import { runSourceExtraction } from "@/lib/ai/capabilities/source-extraction";
import type { SourceContextPack } from "@/lib/ai/context";
import { judgeSummary } from "@/lib/ai/evals/judge";
import {
  scoreChapters,
  scoreExtractions,
  scoreSpeakerSuggestions,
  scoreSummary,
} from "@/lib/ai/evals/scorers";
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

const THRESHOLDS = {
  chapters: 0.7,
  // Grounding rate over the model's claimed-verbatim spans — the S5
  // provenance bar. Below 0.8 the extraction prompt is regressing on the
  // one property the product depends on.
  extraction: 0.8,
  speakers: 0.6,
  summary: 0.4,
} as const;
const JUDGE_THRESHOLD = 0.7;

interface Fixture {
  durationMs: number;
  name: string;
  pack: SourceContextPack;
  transcript: TranscriptData;
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

  const scores = {
    chapters: scoreChapters(result.chapters, fixture.durationMs),
    extraction: scoreExtractions(groundedRows, fixture.durationMs),
    speakers: scoreSpeakerSuggestions(result.editorial.speakers, speakerIds),
    summary: scoreSummary(result.editorial.summary),
  };

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

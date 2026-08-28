import { buildCutGrid, resolveParagraphSpan } from "@/lib/intelligence/grid";
import { buildParagraphs } from "@/lib/transcription/paragraphs";
import type { TranscriptData } from "@/lib/transcription/types";
import type { SourceContextPack } from "../context";
import type { StructuredUsage } from "../generate";
import {
  type EpisodeBrief,
  runSegmentRoughPass,
  type SegmentRoughItem,
  type SegmentRoughPlan,
} from "./episode-clips";
import type { MomentAnalysisContext, MomentSeed } from "./moment-discovery";
import { clipPrefixInput } from "./moment-discovery";

// The chapters ROUGH pass (docs/clip-cut-architecture.md §4 Pass 2, §6):
// the keep/drop partition proposed as paragraph-ID spans with a
// table-of-contents-FIRST contract — the model commits to what the
// chapters ARE at topic altitude before placing any cut, which is the
// structural defense against beat-slicing (26 keeps of ~100s on a 58min
// episode, the measured over-segmentation). Paragraph IDs resolve to ms
// here; lib/intelligence/segments.ts rebuilds the plan as a true tiling
// so coverage holds by construction, and the per-cut Cutter refinement
// (clip-fine-cut.ts, driven by the pipeline) places exact sentences.
//
// Constraint policy unchanged: the prompt names NO counts and NO
// durations anywhere.
//
// ANALYSIS_PROVIDER=mock: deterministic keep/drop/keep partition over
// real paragraph words so grounding succeeds and the lifecycle is
// CI-provable.

export interface RawSegmentItem {
  // Internal provenance carried only after deterministic reconciliation.
  // Providers author anchorText; code derives this ordered candidate lineage
  // so final grounding can recover if a fine cut excludes the first anchor.
  anchorCandidates?: string[];
  anchorText: string | null;
  dropReason:
    | "housekeeping"
    | "sponsor"
    | "low_energy"
    | "weaker_telling"
    | "thin"
    | "other"
    | null;
  endMs: number;
  hook: string | null;
  kind: "keep" | "drop";
  startMs: number;
  summary: string | null;
  title: string | null;
}

export interface SegmentPlanInput {
  analysis: MomentAnalysisContext | null;
  contextPack: SourceContextPack;
  durationMs: number;
  // Grounded moment candidates as arc-peak hints (label + range)
  momentInventory: MomentSeed[];
  seeds: MomentSeed[];
  transcript: TranscriptData;
}

export interface SegmentPlanResult {
  items: RawSegmentItem[];
  tableOfContents: string[];
  usage: StructuredUsage[];
}

const ROUGH_PLAN_VALIDATION_ATTEMPTS = 2;

function keepPackagingComplete(item: SegmentRoughItem): boolean {
  return Boolean(
    item.title?.trim() &&
      item.hook?.trim() &&
      item.summary?.trim() &&
      item.dropReason === null
  );
}

function dropPackagingValid(item: SegmentRoughItem): boolean {
  return (
    item.anchorText === null &&
    item.title === null &&
    item.hook === null &&
    item.summary === null &&
    item.dropReason !== null
  );
}

function validateTocEntries(entries: readonly string[]): string[] {
  const issues: string[] = [];
  for (const [index, entry] of entries.entries()) {
    if (entry.length === 0 || entry !== entry.trim()) {
      issues.push(
        `table of contents entry ${index} must be trimmed and non-empty`
      );
    }
  }
  return issues;
}

export function validateSegmentRoughPlan(
  plan: SegmentRoughPlan | null,
  paragraphCount: number
): string[] {
  if (!plan) {
    return ["segments mode returned no plan"];
  }
  if (paragraphCount <= 0) {
    return ["transcript has no addressable paragraphs"];
  }
  const issues: string[] = [];
  const finalParagraph = paragraphCount - 1;
  const [first] = plan.segments;
  const last = plan.segments.at(-1);
  if (first?.startP !== 0) {
    issues.push("the partition must start at P000");
  }
  if (last?.endP !== finalParagraph) {
    issues.push(
      `the partition must end at P${String(finalParagraph).padStart(3, "0")}`
    );
  }
  for (const [index, item] of plan.segments.entries()) {
    if (
      item.startP < 0 ||
      item.endP > finalParagraph ||
      item.startP > item.endP
    ) {
      issues.push(`segment ${index} has an invalid paragraph range`);
    }
    const previous = plan.segments[index - 1];
    if (previous && item.startP !== previous.endP + 1) {
      issues.push(`segment ${index} does not continue the exact partition`);
    }
    if (item.kind === "keep" && !keepPackagingComplete(item)) {
      issues.push(`keep segment ${index} has invalid packaging`);
    }
    if (item.kind === "drop" && !dropPackagingValid(item)) {
      issues.push(`drop segment ${index} has invalid packaging`);
    }
  }
  const keepCount = plan.segments.filter((item) => item.kind === "keep").length;
  issues.push(...validateTocEntries(plan.tableOfContents));
  if (plan.tableOfContents.length !== keepCount) {
    issues.push("the rough table of contents must map one-to-one to keeps");
  }
  return issues;
}

const MOCK_ANCHOR_WORDS = 5;

function mockSegmentPlan(input: SegmentPlanInput): SegmentPlanResult {
  const paragraphs = buildParagraphs(input.transcript);
  const anchor = (index: number): string =>
    (paragraphs[index]?.words ?? [])
      .slice(0, MOCK_ANCHOR_WORDS)
      .map((word) => word.text)
      .join(" ");
  if (paragraphs.length === 0) {
    throw new Error("Transcript has no addressable paragraphs");
  }
  if (paragraphs.length < 3) {
    const [first] = paragraphs;
    const last = paragraphs.at(-1);
    if (!(first && last)) {
      throw new Error("Transcript has no addressable paragraphs");
    }
    return {
      items: [
        {
          anchorText: anchor(0) || null,
          dropReason: null,
          endMs: last.endMs,
          hook: "Mock hook: the complete chapter.",
          kind: "keep",
          startMs: first.startMs,
          summary: "Mock summary of the complete chapter.",
          title: "Mock complete chapter",
        },
      ],
      tableOfContents: ["Mock complete chapter"],
      usage: [],
    };
  }
  const [p0, p1] = paragraphs;
  const last = paragraphs.at(-1);
  if (!(p0 && p1 && last)) {
    return { items: [], tableOfContents: [], usage: [] };
  }
  return {
    items: [
      {
        anchorText: anchor(0),
        dropReason: null,
        endMs: p0.endMs,
        hook: "Mock hook: the opening chapter.",
        kind: "keep",
        startMs: p0.startMs,
        summary: "Mock summary of the opening arc.",
        title: "Mock chapter one",
      },
      {
        anchorText: null,
        dropReason: "low_energy",
        endMs: p1.endMs,
        hook: null,
        kind: "drop",
        startMs: p1.startMs,
        summary: null,
        title: null,
      },
      {
        anchorText: anchor(2),
        dropReason: null,
        endMs: last.endMs,
        hook: "Mock hook: the closing chapter.",
        kind: "keep",
        startMs: paragraphs[2].startMs,
        summary: "Mock summary of the closing arc.",
        title: "Mock chapter two",
      },
    ],
    tableOfContents: ["Mock chapter one", "Mock chapter two"],
    usage: [],
  };
}

export async function runSegmentPlan(
  input: SegmentPlanInput,
  options: { brief?: EpisodeBrief | null } = {}
): Promise<SegmentPlanResult> {
  if (process.env.ANALYSIS_PROVIDER === "mock") {
    return mockSegmentPlan(input);
  }

  const grid = buildCutGrid(input.transcript.words);
  const prefix = clipPrefixInput(input, grid);
  const usage: StructuredUsage[] = [];
  let issues: string[] = [];
  let previousPlan: SegmentRoughPlan | null = null;
  for (
    let attempt = 0;
    attempt < ROUGH_PLAN_VALIDATION_ATTEMPTS;
    attempt += 1
  ) {
    // biome-ignore lint/performance/noAwaitInLoops: the second call is one bounded structural repair using exact deterministic errors
    const run = await runSegmentRoughPass(
      prefix,
      options.brief ?? null,
      input.momentInventory,
      issues,
      previousPlan
    );
    usage.push(run.usage);
    previousPlan = run.output.plan;
    issues = validateSegmentRoughPlan(previousPlan, grid.paragraphs.length);
    if (issues.length > 0 || !previousPlan) {
      continue;
    }
    const items: RawSegmentItem[] = previousPlan.segments.map((item) => {
      const span = resolveParagraphSpan(grid, item.startP, item.endP);
      if (span.clamped) {
        throw new Error("Validated segment paragraph range was clamped");
      }
      return {
        anchorText: item.anchorText,
        dropReason: item.dropReason,
        endMs: span.endMs,
        hook: item.hook,
        kind: item.kind,
        startMs: span.startMs,
        summary: item.summary,
        title: item.title,
      };
    });
    return {
      items,
      tableOfContents: previousPlan.tableOfContents,
      usage,
    };
  }
  throw new Error(`Segment rough plan failed integrity: ${issues.join("; ")}`);
}

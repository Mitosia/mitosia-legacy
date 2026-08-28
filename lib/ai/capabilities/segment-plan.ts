import { buildCutGrid, resolveParagraphSpan } from "@/lib/intelligence/grid";
import { buildParagraphs } from "@/lib/transcription/paragraphs";
import type { TranscriptData } from "@/lib/transcription/types";
import type { SourceContextPack } from "../context";
import type { StructuredUsage } from "../generate";
import { type EpisodeBrief, runSegmentRoughPass } from "./episode-clips";
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

const MOCK_ANCHOR_WORDS = 5;

function mockSegmentPlan(input: SegmentPlanInput): SegmentPlanResult {
  const paragraphs = buildParagraphs(input.transcript);
  if (paragraphs.length < 3) {
    return { items: [], tableOfContents: [], usage: [] };
  }
  const anchor = (index: number): string =>
    (paragraphs[index]?.words ?? [])
      .slice(0, MOCK_ANCHOR_WORDS)
      .map((word) => word.text)
      .join(" ");
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
  const run = await runSegmentRoughPass(
    clipPrefixInput(input, grid),
    options.brief ?? null,
    input.momentInventory
  );
  const { plan } = run.output;
  const items: RawSegmentItem[] = (plan?.segments ?? []).map((item) => {
    const span = resolveParagraphSpan(grid, item.startP, item.endP);
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
    tableOfContents: plan?.tableOfContents ?? [],
    usage: [run.usage],
  };
}

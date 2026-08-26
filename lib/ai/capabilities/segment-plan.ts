import { z } from "zod";
import { buildParagraphs } from "@/lib/transcription/paragraphs";
import type { TranscriptData } from "@/lib/transcription/types";
import type { SourceContextPack } from "../context";
import { generateStructured, type StructuredUsage } from "../generate";
import type { MomentAnalysisContext, MomentSeed } from "./moment-discovery";
import { transcriptToPromptText } from "./source-analysis";

// The segment-plan capability (S6.5, docs/episode-to-clips.md §4/§9): ONE
// pass proposing the episode's FULL keep/drop partition — the Editor's
// coverage half, sibling of moment discovery's peak half. The model only
// proposes; lib/intelligence/segments.ts rebuilds the plan as a true
// tiling of the timeline (cut-point snapping, gap synthesis, anchor
// grounding, observability flags), so coverage holds by construction.
//
// Constraint policy (2026-08-26, the PR #90 lesson generalized): the
// prompt names NO counts and NO durations anywhere — a named number
// becomes a quota. The prompt describes what a chapter IS; the recording
// decides how many there are and how long each runs.
//
// ANALYSIS_PROVIDER=mock: deterministic keep/drop/keep partition over
// real paragraph words so grounding succeeds and the lifecycle is
// CI-provable.

// Property order is generation order: locate the span, classify it,
// then characterize it.
const segmentItemSchema = z
  .object({ startMs: z.number().int().nonnegative() })
  .extend({ endMs: z.number().int().nonnegative() })
  .extend({ kind: z.enum(["keep", "drop"]) })
  .extend({ anchorText: z.string().min(1).max(160).nullable() })
  .extend({ title: z.string().min(1).max(120).nullable() })
  .extend({ hook: z.string().min(1).max(200).nullable() })
  .extend({ summary: z.string().min(1).max(300).nullable() })
  .extend({
    dropReason: z
      .enum([
        "housekeeping",
        "sponsor",
        "low_energy",
        "weaker_telling",
        "thin",
        "other",
      ])
      .nullable(),
  });

// The bound is output-budget math only (64 rows, ~270 tokens for a maxed
// keep row — see "segment-plan.partition" in lib/ai/config.ts), never a
// target: the instructions name no counts at all.
export const segmentPlanOutputSchema = z.object({
  segments: z.array(segmentItemSchema).max(64),
});

export type RawSegmentItem = z.infer<typeof segmentItemSchema>;

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
  usage: StructuredUsage[];
}

const SYSTEM = `You are a clips editor decomposing one long recording into a plan of chapter clips for a content team.
You will be given context, sometimes an outline and inventories of known
highlights, and a diarized transcript with [mm:ss] timestamps.
Rules:
- The plan is a PARTITION: chronological, non-overlapping segments that
  together account for the ENTIRE recording. Every span is either kind
  "keep" (a chapter clip) or kind "drop" (with a reason). Nothing is
  simply omitted.
- A KEEP segment is one complete narrative arc: it opens at the question
  or setup that raises its topic, develops, and ends on the payoff — the
  punchline, conclusion, or emotional beat — BEFORE the pivot into the
  next topic. Whole arcs only, never fractions of one.
- The recording decides how many chapters there are and how long each
  one runs. An episode with six long arcs yields six long clips; one with
  many tight beats yields many short ones. Never merge unrelated arcs to
  make a segment longer; never split one arc to make segments shorter.
- anchorText (keeps only) must be copied VERBATIM from inside the segment
  — exact words, in order. It is matched back to the word timeline and
  the segment loses its grounding if it does not align.
- DROP what earns no clip — housekeeping, sponsor reads, warmup chatter,
  low-energy stretches, the weaker telling of a story told twice — each
  with its reason. Dropping is a first-class editorial decision.
- startMs/endMs come from the [mm:ss] timestamps; boundaries are snapped
  to sentence boundaries afterwards — aim for where arcs actually turn.
- Never invent content that is not in the transcript.`;

const INSTRUCTIONS = `Produce the segment plan for this recording: the chronological keep/drop partition a good clips editor would cut.

For each segment emit:
- startMs/endMs: the segment's span. Consecutive segments must share
  boundaries — the plan accounts for every second.
- kind: "keep" or "drop".
- anchorText (keep only, null on drops): a short VERBATIM phrase from
  inside the segment (its most distinctive words).
- title (keep only): names the PAYOFF, not the topic — specific enough to
  stand alone in a video list.
- hook (keep only): one sentence on why a viewer picks this chapter.
- summary (keep only): 1-2 sentences of what happens.
- dropReason (drop only): housekeeping | sponsor | low_energy |
  weaker_telling | thin | other.

Segments in chronological order. The content dictates the plan — nothing else does.`;

function contextPreamble(pack: SourceContextPack): string {
  const parts = [
    `Organization: ${pack.organization.name}`,
    pack.client ? `Client: ${pack.client.name}` : null,
    pack.brand ? `Brand: ${pack.brand.name}` : null,
    pack.project ? `Project: ${pack.project.name}` : null,
    `Recording: "${pack.source.title}" (${Math.round(pack.source.durationSeconds / 60)} minutes, ${pack.source.speakerCount} diarized speaker id(s))`,
  ];
  return parts.filter(Boolean).join("\n");
}

function stamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function analysisPreamble(analysis: MomentAnalysisContext | null): string {
  if (!analysis) {
    return "";
  }
  const parts: string[] = [];
  if (analysis.summary) {
    parts.push(`SUMMARY:\n${analysis.summary}`);
  }
  if (analysis.chapters.length > 0) {
    const outline = analysis.chapters
      .map((chapter) => `[${stamp(chapter.startMs)}] ${chapter.title}`)
      .join("\n");
    parts.push(
      `OUTLINE (approximate topic hints — trust the transcript over these):\n${outline}`
    );
  }
  return parts.length > 0 ? `\n\n${parts.join("\n\n")}` : "";
}

function inventoryPreamble(
  label: string,
  seeds: readonly MomentSeed[]
): string {
  if (seeds.length === 0) {
    return "";
  }
  const lines = seeds
    .map(
      (seed) =>
        `${seed.kind} @${stamp(seed.startMs)}-${stamp(seed.endMs)}: ${seed.label}`
    )
    .join("\n");
  return `\n\n${label}:\n${lines}`;
}

export function buildSegmentPlanPrefix(input: SegmentPlanInput): string {
  return `${contextPreamble(input.contextPack)}${analysisPreamble(input.analysis)}${inventoryPreamble("KNOWN PEAK MOMENTS (arc cores — a keep segment usually contains one or more)", input.momentInventory)}${inventoryPreamble("HIGHLIGHT INVENTORY (grounded extractions)", input.seeds)}\n\nTRANSCRIPT:\n${transcriptToPromptText(input.transcript)}`;
}

const MOCK_ANCHOR_WORDS = 5;

// Deterministic mock partition: keep / drop / keep over the first three
// paragraphs — a true tiling whose anchors are verbatim paragraph words,
// with a drop reason for the middle stretch. Exercises grounding, gap
// math, drops, and restore end to end in CI.
function mockSegmentPlan(input: SegmentPlanInput): SegmentPlanResult {
  const paragraphs = buildParagraphs(input.transcript);
  if (paragraphs.length < 3) {
    return { items: [], usage: [] };
  }
  const anchor = (index: number): string =>
    (paragraphs[index]?.words ?? [])
      .slice(0, MOCK_ANCHOR_WORDS)
      .map((word) => word.text)
      .join(" ");
  const [p0, p1] = paragraphs;
  const last = paragraphs.at(-1);
  if (!(p0 && p1 && last)) {
    return { items: [], usage: [] };
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
    usage: [],
  };
}

export async function runSegmentPlan(
  input: SegmentPlanInput
): Promise<SegmentPlanResult> {
  if (process.env.ANALYSIS_PROVIDER === "mock") {
    return mockSegmentPlan(input);
  }

  const run = await generateStructured(
    "segment-plan.partition",
    SYSTEM,
    INSTRUCTIONS,
    segmentPlanOutputSchema,
    { cachedPrefix: buildSegmentPlanPrefix(input) }
  );
  return { items: run.output.segments, usage: [run.usage] };
}

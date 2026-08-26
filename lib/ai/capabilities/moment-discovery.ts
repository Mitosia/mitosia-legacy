import { z } from "zod";
import { buildParagraphs } from "@/lib/transcription/paragraphs";
import type { TranscriptData } from "@/lib/transcription/types";
import type { SourceContextPack } from "../context";
import { generateStructured, type StructuredUsage } from "../generate";
import { transcriptToPromptText } from "./source-analysis";

// The S6 moment-discovery capability: ONE structured pass (D1) proposing
// standalone clip-worthy moments over the cached transcript prefix. The
// model only PROPOSES — every candidate then runs the deterministic
// gauntlet in lib/intelligence/moments.ts (snap to the sentence grid,
// ground the anchor through the S5 aligner, dedupe, rank), so nothing
// surfaces on model say-so alone (D3).
//
// `anchorText` must be VERBATIM transcript words from inside the moment —
// the aligner discards candidates whose anchor does not align inside the
// snapped range. startMs/endMs only steer snapping and the aligner's
// search window; the persisted range is the snapped one.
//
// ANALYSIS_PROVIDER=mock selects a deterministic fake whose anchors are
// real transcript words (grounding succeeds) and which includes one
// overlapping pair (dedupe visibly fires) and one high-risk item (the
// sensitive badge renders) — the whole lifecycle is CI-provable.

// Property order is generation order (the S4 editorial-schema lesson,
// chained .extend so formatters can't reorder): locate the span first,
// characterize it, score it last.
const momentScoresSchema = z
  .object({ comprehensibility: z.number().min(0).max(1) })
  .extend({ hook: z.number().min(0).max(1) })
  .extend({ insight: z.number().min(0).max(1) })
  .extend({ relevance: z.number().min(0).max(1) })
  .extend({ risk: z.number().min(0).max(1) });

const momentItemSchema = z
  .object({ startMs: z.number().int().nonnegative() })
  .extend({ endMs: z.number().int().nonnegative() })
  .extend({ anchorText: z.string().min(1).max(160) })
  .extend({ title: z.string().min(1).max(120) })
  .extend({ hook: z.string().min(1).max(200) })
  .extend({ summary: z.string().min(1).max(300) })
  .extend({ seedIds: z.array(z.uuid()) })
  .extend({ scores: momentScoresSchema });

// The array bound is part of the route's output-budget math (24 items ×
// ~350 tokens/item — see "moment-discovery.candidates" in lib/ai/config.ts).
// The instructions deliberately name NO target count — "at most 18"
// produced exactly 18 on every source regardless of length (M1 finding,
// 2026-08-26: models treat "at most N" as a quota to fill, padding the
// tail). The recording decides the count; this bound is only the ceiling
// the budget is sized for.
export const momentOutputSchema = z.object({
  candidates: z.array(momentItemSchema).max(24),
});

export type RawMomentItem = z.infer<typeof momentItemSchema>;

export interface MomentAnalysisContext {
  chapters: { startMs: number; title: string }[];
  summary: string | null;
}

// Compact inventory of the source's grounded extractions — the discovery
// pass may build on them (citing their ids in seedIds) but is not limited
// to them.
export interface MomentSeed {
  endMs: number;
  id: string;
  kind: string;
  label: string;
  startMs: number;
}

export interface MomentDiscoveryInput {
  analysis: MomentAnalysisContext | null;
  contextPack: SourceContextPack;
  durationMs: number;
  seeds: MomentSeed[];
  transcript: TranscriptData;
}

export interface MomentDiscoveryResult {
  items: RawMomentItem[];
  usage: StructuredUsage[];
}

const SYSTEM = `You find standalone clip-worthy moments in long recordings for a content team.
You will be given context, sometimes an outline and highlight inventory,
and a diarized transcript with [mm:ss] timestamps, then an instruction.
Rules:
- A moment must stand alone: comprehensible to a viewer with no outside
  context, roughly 20-90 seconds long.
- anchorText must be copied VERBATIM from inside the moment — exact words,
  in order, no corrections. It is matched back to the word timeline and the
  candidate is DISCARDED if it does not align inside the claimed range.
- startMs/endMs are your best estimate of the moment's position in
  milliseconds, derived from the [mm:ss] timestamps. Boundaries are snapped
  to sentence boundaries afterwards — aim for where the thought begins and
  ends.
- Score each dimension 0-1 honestly. risk flags sensitive, controversial,
  or reputationally delicate material — flag it, never censor it.
- Never invent content that is not in the transcript.`;

const INSTRUCTIONS = `Propose the standalone clip-worthy moments in this recording: self-contained spans a viewer would stop scrolling for — a sharp story, a surprising claim, a vivid answer, a crystallizing exchange.

For each candidate emit:
- startMs/endMs: the full moment's span (aim for 20-90 seconds). When the
  moment is an answer, reaction, or story told in response to the other
  speaker, START at the question or setup line that provokes it — a clip
  that opens mid-answer is not standalone.
- anchorText: a short VERBATIM phrase from inside the moment (its most
  distinctive words).
- title: specific, not generic.
- hook: one sentence on why a viewer stops scrolling.
- summary: 1-2 sentences of what happens in the moment.
- seedIds: ids from the highlight inventory you drew on (empty if none).
- scores: comprehensibility (works with zero outside context), hook
  (scroll-stopping power), insight (density of substance), relevance (to
  the recording's themes), risk (sensitive/controversial/reputational).

The RECORDING decides how many moments there are — a dense hour may support twenty, a thin one may support six. Propose every genuinely clip-worthy moment and NOTHING more: never pad toward a count, never invent weak candidates to fill out a list. A short list of strong moments is strictly better than a long list with a weak tail. Rank best first, and prefer distinct moments over near-duplicates of the same beat.`;

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
    parts.push(`OUTLINE:\n${outline}`);
  }
  return parts.length > 0 ? `\n\n${parts.join("\n\n")}` : "";
}

function seedPreamble(seeds: readonly MomentSeed[]): string {
  if (seeds.length === 0) {
    return "";
  }
  const lines = seeds
    .map(
      (seed) =>
        `[${seed.id}] ${seed.kind} @${stamp(seed.startMs)}-${stamp(seed.endMs)}: ${seed.label}`
    )
    .join("\n");
  return `\n\nHIGHLIGHT INVENTORY (grounded extractions you may build on):\n${lines}`;
}

export function buildDiscoveryPrefix(input: MomentDiscoveryInput): string {
  return `${contextPreamble(input.contextPack)}${analysisPreamble(input.analysis)}${seedPreamble(input.seeds)}\n\nTRANSCRIPT:\n${transcriptToPromptText(input.transcript)}`;
}

const MOCK_ANCHOR_WORDS = 5;

function mockDiscovery(input: MomentDiscoveryInput): MomentDiscoveryResult {
  const paragraphs = buildParagraphs(input.transcript);
  if (paragraphs.length === 0) {
    return { items: [], usage: [] };
  }
  const last = paragraphs.length - 1;
  const paragraphItem = (
    index: number,
    scores: RawMomentItem["scores"],
    ordinal: number
  ): RawMomentItem | null => {
    const paragraph = paragraphs[Math.min(index, last)];
    if (!paragraph) {
      return null;
    }
    return {
      anchorText: paragraph.words
        .slice(0, MOCK_ANCHOR_WORDS)
        .map((word) => word.text)
        .join(" "),
      endMs: paragraph.endMs,
      hook: `Mock hook ${ordinal}: a reason to stop scrolling.`,
      scores,
      seedIds: [],
      startMs: paragraph.startMs,
      summary: `Mock summary ${ordinal} of the moment's substance.`,
      title: `Mock moment ${ordinal}`,
    };
  };
  const items = [
    paragraphItem(
      0,
      {
        comprehensibility: 0.9,
        hook: 0.9,
        insight: 0.8,
        relevance: 0.9,
        risk: 0.1,
      },
      1
    ),
    paragraphItem(
      1,
      // High risk on purpose: exercises the Sensitive badge end to end.
      {
        comprehensibility: 0.8,
        hook: 0.7,
        insight: 0.7,
        relevance: 0.8,
        risk: 0.8,
      },
      2
    ),
    paragraphItem(
      2,
      {
        comprehensibility: 0.7,
        hook: 0.6,
        insight: 0.7,
        relevance: 0.7,
        risk: 0.2,
      },
      3
    ),
    // Deliberate near-duplicate of the first moment (same span, weaker
    // scores): dedupe must visibly suppress it, provable in e2e.
    paragraphItem(
      0,
      {
        comprehensibility: 0.6,
        hook: 0.5,
        insight: 0.5,
        relevance: 0.6,
        risk: 0.1,
      },
      4
    ),
  ].filter((item): item is RawMomentItem => item !== null);
  return { items, usage: [] };
}

export async function runMomentDiscovery(
  input: MomentDiscoveryInput
): Promise<MomentDiscoveryResult> {
  if (process.env.ANALYSIS_PROVIDER === "mock") {
    return mockDiscovery(input);
  }

  const run = await generateStructured(
    "moment-discovery.candidates",
    SYSTEM,
    INSTRUCTIONS,
    momentOutputSchema,
    { cachedPrefix: buildDiscoveryPrefix(input) }
  );
  return { items: run.output.candidates, usage: [run.usage] };
}

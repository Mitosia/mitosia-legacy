import { buildCutGrid, resolveParagraphSpan } from "@/lib/intelligence/grid";
import { buildParagraphs } from "@/lib/transcription/paragraphs";
import type { TranscriptData } from "@/lib/transcription/types";
import type { SourceContextPack } from "../context";
import type { StructuredUsage } from "../generate";
import {
  type ClipPrefixInput,
  type EpisodeBrief,
  runMomentRoughPass,
} from "./episode-clips";

// The moments ROUGH pass (docs/clip-cut-architecture.md §4 Pass 2): one
// structured pass over the shared cached prefix proposing candidate
// REGIONS as paragraph-ID ranges — selection, never millisecond
// generation. The per-clip Cutter (clip-fine-cut.ts) places exact
// boundaries afterwards; this pass is scored on recall of beats, which is
// what a single long-context pass is actually good at.
//
// This module keeps the stable seam the pipeline and the eval runner call
// (`runMomentDiscovery` in, millisecond-ranged items out): paragraph IDs
// resolve to ms here, so everything downstream — snapping, grounding,
// dedupe — keeps its contract.
//
// ANALYSIS_PROVIDER=mock: deterministic fake with verbatim anchors, one
// overlapping pair (dedupe fires) and one high-risk item (sensitive badge
// renders) — the whole lifecycle is CI-provable.

export interface MomentAnalysisContext {
  chapters: { startMs: number; title: string }[];
  summary: string | null;
}

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

export interface RawMomentItem {
  anchorText: string;
  endMs: number;
  hook: string;
  scores: {
    comprehensibility: number;
    hook: number;
    insight: number;
    relevance: number;
    risk: number;
  };
  seedIds: string[];
  startMs: number;
  summary: string;
  title: string;
}

export interface MomentDiscoveryResult {
  items: RawMomentItem[];
  usage: StructuredUsage[];
}

export function clipPrefixInput(
  input: Pick<MomentDiscoveryInput, "analysis" | "contextPack" | "seeds">,
  grid: ReturnType<typeof buildCutGrid>
): ClipPrefixInput {
  return {
    analysis: input.analysis,
    contextPack: input.contextPack,
    grid,
    seeds: input.seeds,
  };
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
  input: MomentDiscoveryInput,
  options: { brief?: EpisodeBrief | null } = {}
): Promise<MomentDiscoveryResult> {
  if (process.env.ANALYSIS_PROVIDER === "mock") {
    return mockDiscovery(input);
  }

  const grid = buildCutGrid(input.transcript.words);
  const run = await runMomentRoughPass(
    clipPrefixInput(input, grid),
    options.brief ?? null
  );
  const items: RawMomentItem[] = (run.output.candidates ?? []).map((item) => {
    const span = resolveParagraphSpan(grid, item.startP, item.endP);
    return {
      anchorText: item.anchorText,
      endMs: span.endMs,
      hook: item.hook,
      scores: item.scores,
      seedIds: item.seedIds,
      startMs: span.startMs,
      summary: item.summary,
      title: item.title,
    };
  });
  return { items, usage: [run.usage] };
}

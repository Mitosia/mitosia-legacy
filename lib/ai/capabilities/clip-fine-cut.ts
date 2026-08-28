import { z } from "zod";
import type { CutGrid, CutterWindow } from "@/lib/intelligence/grid";
import { renderFine, sentenceAtMs } from "@/lib/intelligence/grid";
import type { MsRange } from "@/lib/intelligence/moments";
import { generateStructured, type StructuredUsage } from "../generate";

// The Cutter (docs/clip-cut-architecture.md §4 Pass 3): the fine cut. One
// small call per clip over a ±90s two-turn window rendered at SENTENCE
// granularity, returning in/setup/payoff/out sentence IDs. This is where
// "plan like a real editor" concentrates: full attention on ONE clip's
// boundaries, with the failure neighborhood (previous topic's tail, the
// next question) visible as labeled lines instead of territory a
// milliseconds guess accidentally includes.
//
// Per-candidate small calls are cache-exempt (the Reviewer's precedent) —
// each window is unique, so there is nothing to share.
//
// ANALYSIS_PROVIDER=mock: identity cut (the sentences nearest the rough
// bounds) so CI proves the resolve path with zero tokens and the
// deterministic backstops behave exactly as they would on a real cut.

const REASONING_MAX = 300;

// Reasoning first (it constrains what follows), then the escape hatch,
// then the committed IDs. `couldNotFind` is the legal "this region is not
// one moment" (§5) — a flag for the human, never a shipped mislabel.
const momentCutSchema = z
  .object({ reasoning: z.string().min(1).max(REASONING_MAX) })
  .extend({ couldNotFind: z.boolean() })
  .extend({ inId: z.number().int().nonnegative().nullable() })
  .extend({ setupId: z.number().int().nonnegative().nullable() })
  .extend({ payoffId: z.number().int().nonnegative().nullable() })
  .extend({ outId: z.number().int().nonnegative().nullable() });

export type MomentFineCut = z.infer<typeof momentCutSchema>;

const segmentCutSchema = z
  .object({ reasoning: z.string().min(1).max(REASONING_MAX) })
  .extend({ cutId: z.number().int().nonnegative() });

export type SegmentFineCut = z.infer<typeof segmentCutSchema>;

const MOMENT_SYSTEM = `You are a short-form cutter placing the EXACT in and out points of one clip.
You see a reel: sentence lines "s0417 [14:02] S2: text" with marks —
⟲turn (opens a speaker turn), ·q (question), ¶N.Ns (pause after), ·cut
(camera cut). Sentence IDs are your only coordinates; you never output
times.

The craft:
- In-point: open where the tension starts — the setup line. Usually the
  question that provokes the moment, or its final sentence if the
  question rambles. Sometimes the strongest open trims the question
  entirely and starts on the answer's first punch — choose it when that
  sentence stands alone. NEVER open on the tail of the previous answer;
  never open on an unresolved reference ("that's when…" with an unseen
  antecedent).
- Out-point: the payoff must land inside the clip — the punchline, the
  landed line, the completed thought — and the clip ends on the first
  natural breath after it lands. Do not run into the next question. Do
  not strip the air a payoff needs.
- One beat: when a second story begins, the clip is over.

Return:
- reasoning: one or two sentences — which sentence is the setup, which is
  the payoff, why the out-point lands where it does.
- couldNotFind: true ONLY when this region does not contain one single
  setup→payoff beat (it is a whole topic, or the payoff never lands). All
  IDs null in that case.
- inId / outId: the clip plays sentence inId through sentence outId,
  inclusive.
- setupId: the sentence where the setup/hook lives (inId ≤ setupId).
- payoffId: the sentence where the payoff lands (inId ≤ payoffId ≤ outId
  — a violation is rejected by the pipeline).`;

const SEGMENT_SYSTEM = `You are an episode editor placing ONE chapter boundary exactly.
You see a reel around a proposed cut: sentence lines "s0417 [14:02] S2:
text" with marks — ⟲turn (opens a speaker turn), ·q (question), ¶N.Ns
(pause after), ·cut (camera cut). Sentence IDs are your only coordinates.

You are shown what plays BEFORE the cut and what plays AFTER it. Choose
the sentence where the second span truly begins: the first topic's payoff
has fully landed (with its breath), and the new topic's setup — usually a
question or a topic turn — starts. The chapter before the cut must end
complete; the chapter after must open on its own setup, never on the tail
of the previous topic. When the material before the cut is dropped
content (a sponsor read, housekeeping), the cut lands where the kept
chapter's actual setup begins.

Return reasoning (one sentence: what ends, what begins), then cutId — the
first sentence OF THE SECOND SPAN.`;

export interface MomentCutRequest {
  grid: CutGrid;
  hook: string;
  // Editor's note for a bounded revision re-cut (§4 Pass 6); null on the
  // first cut.
  revisionNote: string | null;
  roughRange: MsRange;
  shotTimesMs: readonly number[];
  title: string;
  window: CutterWindow;
}

export interface MomentCutOutcome {
  cut: MomentFineCut;
  usage: StructuredUsage | null;
}

function mockMomentCut(request: MomentCutRequest): MomentFineCut {
  const inSentence = sentenceAtMs(request.grid, request.roughRange.startMs);
  const outSentence = sentenceAtMs(
    request.grid,
    Math.max(request.roughRange.endMs - 1, request.roughRange.startMs)
  );
  const inId = inSentence ? inSentence.id : 0;
  const outId = outSentence ? outSentence.id : inId;
  return {
    couldNotFind: false,
    inId,
    outId,
    payoffId: outId,
    reasoning: "Mock fine cut: identity on the rough bounds.",
    setupId: inId,
  };
}

export async function fineCutMoment(
  request: MomentCutRequest
): Promise<MomentCutOutcome> {
  if (process.env.ANALYSIS_PROVIDER === "mock") {
    return { cut: mockMomentCut(request), usage: null };
  }
  const reel = renderFine(
    request.grid,
    request.window.fromSentence,
    request.window.toSentence,
    request.shotTimesMs
  );
  const roughIn = sentenceAtMs(request.grid, request.roughRange.startMs);
  const roughOut = sentenceAtMs(
    request.grid,
    Math.max(request.roughRange.endMs - 1, request.roughRange.startMs)
  );
  const rough = roughIn ? roughIn.id : 0;
  const roughEnd = roughOut ? roughOut.id : rough;
  const prompt = `CLIP: "${request.title}"\nHOOK: ${request.hook}\nROUGH REGION: sentences s${rough}–s${roughEnd} (place the exact cut; the reel extends beyond the region on both sides on purpose)${request.revisionNote ? `\nREVIEWER NOTE (one bounded revision): ${request.revisionNote}` : ""}\n\nREEL:\n${reel}`;
  const result = await generateStructured(
    "clip-fine.cut",
    MOMENT_SYSTEM,
    prompt,
    momentCutSchema
  );
  return { cut: result.output, usage: result.usage };
}

export interface SegmentCutRequest {
  afterTitle: string;
  beforeTitle: string;
  grid: CutGrid;
  roughCutMs: number;
  shotTimesMs: readonly number[];
  window: CutterWindow;
}

export interface SegmentCutOutcome {
  cut: SegmentFineCut;
  usage: StructuredUsage | null;
}

function mockSegmentCut(request: SegmentCutRequest): SegmentFineCut {
  const sentence = sentenceAtMs(request.grid, request.roughCutMs);
  return {
    cutId: sentence ? sentence.id : 0,
    reasoning: "Mock cut refinement: identity on the rough cut.",
  };
}

export async function fineCutSegmentBoundary(
  request: SegmentCutRequest
): Promise<SegmentCutOutcome> {
  if (process.env.ANALYSIS_PROVIDER === "mock") {
    return { cut: mockSegmentCut(request), usage: null };
  }
  const reel = renderFine(
    request.grid,
    request.window.fromSentence,
    request.window.toSentence,
    request.shotTimesMs
  );
  const roughSentence = sentenceAtMs(request.grid, request.roughCutMs);
  const roughId = roughSentence ? roughSentence.id : 0;
  const prompt = `BOUNDARY between "${request.beforeTitle}" (before) and "${request.afterTitle}" (after).\nROUGH CUT: near sentence s${roughId}.\n\nREEL:\n${reel}`;
  const result = await generateStructured(
    "clip-fine.cut",
    SEGMENT_SYSTEM,
    prompt,
    segmentCutSchema
  );
  return { cut: result.output, usage: result.usage };
}

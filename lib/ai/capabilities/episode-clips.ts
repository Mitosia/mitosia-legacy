import { z } from "zod";
import type { CutGrid } from "@/lib/intelligence/grid";
import { renderCoarse } from "@/lib/intelligence/grid";
import type { SourceContextPack } from "../context";
import { generateStructured, type StructuredResult } from "../generate";

// The shared half of the cutting room's episode-level passes
// (docs/clip-cut-architecture.md §4): the Director's brief and both rough
// cuts read ONE cached prefix (context + inventories + the coarse
// paragraph-ID transcript) under ONE system string and ONE union schema —
// the S5 cache-key rule: tools/schema and system precede messages in the
// Anthropic cache key, so any per-mode difference there would bust the
// cache that makes three opus passes affordable. Only the post-breakpoint
// instruction text differs per mode.
//
// Coordinates are paragraph IDs (P000…), never milliseconds: rough passes
// locate REGIONS; the per-clip Cutter (clip-fine-cut.ts) places exact
// sentence boundaries. Selection, never generation.

const REASONING_MAX = 240;

// ---- Union schema ---------------------------------------------------------

const paragraphId = z.number().int().nonnegative();

const briefArcSchema = z
  .object({ title: z.string().min(1).max(120) })
  .extend({ startP: paragraphId })
  .extend({ endP: paragraphId })
  .extend({ note: z.string().min(1).max(200) });

const briefSpineSchema = z
  .object({ topic: z.string().min(1).max(90) })
  .extend({ startP: paragraphId })
  .extend({ endP: paragraphId });

const briefDropZoneSchema = z
  .object({ startP: paragraphId })
  .extend({ endP: paragraphId })
  .extend({
    reason: z.enum([
      "housekeeping",
      "sponsor",
      "low_energy",
      "weaker_telling",
      "thin",
      "other",
    ]),
  });

export const episodeBriefSchema = z
  .object({ tone: z.string().min(1).max(240) })
  .extend({ spine: z.array(briefSpineSchema).max(40) })
  .extend({ marqueeArcs: z.array(briefArcSchema).max(12) })
  .extend({ dropZones: z.array(briefDropZoneSchema).max(24) });

export type EpisodeBrief = z.infer<typeof episodeBriefSchema>;

const momentScoresSchema = z
  .object({ comprehensibility: z.number().min(0).max(1) })
  .extend({ hook: z.number().min(0).max(1) })
  .extend({ insight: z.number().min(0).max(1) })
  .extend({ relevance: z.number().min(0).max(1) })
  .extend({ risk: z.number().min(0).max(1) });

// Reasoning precedes the committed IDs (left-to-right generation: the
// value emitted first constrains what follows), IDs precede packaging.
const momentRoughSchema = z
  .object({ reasoning: z.string().min(1).max(REASONING_MAX) })
  .extend({ startP: paragraphId })
  .extend({ endP: paragraphId })
  .extend({ anchorText: z.string().min(1).max(160) })
  .extend({ title: z.string().min(1).max(120) })
  .extend({ hook: z.string().min(1).max(200) })
  .extend({ summary: z.string().min(1).max(300) })
  .extend({ seedIds: z.array(z.uuid()).max(8) })
  .extend({ scores: momentScoresSchema });

export type MomentRoughItem = z.infer<typeof momentRoughSchema>;

const segmentRoughSchema = z
  .object({ startP: paragraphId })
  .extend({ endP: paragraphId })
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

export type SegmentRoughItem = z.infer<typeof segmentRoughSchema>;

// TOC-first (§6): the chapter list is committed BEFORE any cut — a model
// that has just written the episode's table of contents at topic altitude
// is structurally less likely to slice a chapter into beats.
const segmentPlanSchema = z
  .object({ tableOfContents: z.array(z.string().min(1).max(90)).max(40) })
  .extend({ segments: z.array(segmentRoughSchema).max(64) });

// ONE schema for all three modes: exactly one branch is non-null, named by
// `mode`. Array bounds are output-budget ceilings, never targets — the
// instructions name no counts (the count-anchoring rule).
export const clipProposalSchema = z
  .object({ mode: z.enum(["brief", "moments", "segments"]) })
  .extend({ brief: episodeBriefSchema.nullable() })
  .extend({ candidates: z.array(momentRoughSchema).max(24).nullable() })
  .extend({ plan: segmentPlanSchema.nullable() });

export type ClipProposal = z.infer<typeof clipProposalSchema>;

// ---- Shared system + prefix ----------------------------------------------

export const CLIP_SYSTEM = `You are a senior clips editor working through one long recording for a content team.
You will be given context, sometimes an outline and a highlight inventory,
and the transcript rendered as PARAGRAPH lines: "P012 [mm:ss] S2: text…".
P-numbers are paragraph IDs — your ONLY coordinates. The [mm:ss] stamps
are for your sense of pacing; you never output times.
Rules that apply to every job:
- You LOCATE regions by paragraph ID; a dedicated cutter will later place
  the exact cut inside your region. Choose the paragraphs where a thing
  genuinely begins and ends — including the setup that provokes it.
- anchorText must be copied VERBATIM from inside the region — exact words,
  in order. It is matched back to the word timeline and the item is
  DISCARDED if it does not align. Never paraphrase an anchor.
- The RECORDING decides how many items there are. Never pad toward a
  count; never invent weak items to fill a list. A short strong list beats
  a long padded one.
- Never invent content that is not in the transcript.
- The final instruction names your job: emit that mode, fill ONLY its
  field, and set the other fields to null.`;

export interface ClipInventoryItem {
  endMs: number;
  id: string;
  kind: string;
  label: string;
  startMs: number;
}

export interface ClipAnalysisContext {
  chapters: { startMs: number; title: string }[];
  summary: string | null;
}

export interface ClipPrefixInput {
  analysis: ClipAnalysisContext | null;
  contextPack: SourceContextPack;
  grid: CutGrid;
  seeds: ClipInventoryItem[];
}

function stamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

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

function analysisPreamble(analysis: ClipAnalysisContext | null): string {
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
  items: readonly ClipInventoryItem[]
): string {
  if (items.length === 0) {
    return "";
  }
  const lines = items
    .map(
      (item) =>
        `[${item.id}] ${item.kind} @${stamp(item.startMs)}-${stamp(item.endMs)}: ${item.label}`
    )
    .join("\n");
  return `\n\n${label}:\n${lines}`;
}

// The ONE cached prefix all three episode passes read. Byte-identical
// across lanes by construction (nothing lane-specific is rendered here) —
// a discovery run's cache write is a segment plan's cache read when the
// button lands within the TTL; the persisted brief row covers the cold
// case.
export function buildClipPrefix(input: ClipPrefixInput): string {
  return `${contextPreamble(input.contextPack)}${analysisPreamble(input.analysis)}${inventoryPreamble("HIGHLIGHT INVENTORY (grounded extractions you may build on)", input.seeds)}\n\nTRANSCRIPT:\n${renderCoarse(input.grid)}`;
}

// ---- Per-mode instructions (post-breakpoint) ------------------------------

const BRIEF_INSTRUCTIONS = `Your job: MODE "brief". Watch the whole episode first and write the episode brief — the document every later cut answers to.

- spine: the episode's ordered topics, each with its paragraph range —
  the table of contents as a chapter list would name them.
- marqueeArcs: the strongest complete stories/exchanges, each with its
  region (INCLUDING the question or setup that provokes it), and a note
  on why it lands.
- dropZones: regions that earn no clip (sponsor reads, housekeeping,
  warmup chatter, dead stretches), each with its reason.
- tone: two sentences on the episode's register and audience.

Set mode to "brief", fill only "brief"; candidates and plan are null.`;

function momentsInstructions(brief: string | null): string {
  return `${brief ? `EPISODE BRIEF (from the director):\n${brief}\n\n` : ""}Your job: MODE "moments". Propose the standalone scroll-stopping moments in this recording.

A moment is ONE BEAT: a single setup→payoff unit a stranger would stop
scrolling for — a sharp story, a surprising claim, a vivid answer, a
crystallizing exchange. The hook is audible in its first seconds; the
moment dies the instant a second story begins. It is the length of a held
breath, not a topic summary — when a region holds a whole topic, the
moment is the sharpest beat inside it, not the topic.

For each candidate emit:
- reasoning: one sentence — where the beat begins (the setup line) and
  where its payoff lands.
- startP/endP: the REGION the beat lives in. When the moment is an
  answer, reaction, or story provoked by the other speaker, the region
  STARTS at the paragraph carrying that question or setup — a clip that
  opens mid-answer is not standalone. The region ENDS where the payoff
  lands, before the pivot into the next topic.
- anchorText: a short VERBATIM phrase from inside the region (its most
  distinctive words).
- title: specific, not generic. hook: one sentence on why a viewer stops.
  summary: 1-2 sentences of what happens.
- seedIds: ids from the highlight inventory you drew on (empty if none).
- scores: comprehensibility, hook, insight, relevance, risk — 0-1,
  honestly. risk flags sensitive material; flag it, never censor it.

Rank best first; prefer distinct moments over near-duplicates of one
beat. Set mode to "moments", fill only "candidates"; brief and plan are
null.`;
}

function segmentsInstructions(brief: string | null): string {
  return `${brief ? `EPISODE BRIEF (from the director):\n${brief}\n\n` : ""}Your job: MODE "segments". Produce the chapter plan: the chronological keep/drop partition a good clips editor would cut this episode into.

A CHAPTER is one complete TOPIC of the episode — what a viewer picks from
a YouTube chapter list to watch that subject. It opens at the question or
setup that raises its topic, develops it fully (a topic often spans
several exchanges and stories), and ends on the payoff before the
conversation genuinely turns to a new subject. A chapter is NOT a short:
a single beat, quote, or exchange is a fraction of a chapter, never a
chapter of its own. Never split one topic to make chapters shorter;
never staple unrelated topics together to make them longer.

FIRST write tableOfContents: the episode's chapter titles at topic
altitude, in order — commit to what the chapters ARE before cutting.
THEN emit the partition:
- Segments are chronological, non-overlapping, and together account for
  the ENTIRE recording — every span is kind "keep" (a chapter) or kind
  "drop" (with a reason). Nothing is simply omitted. Consecutive segments
  share boundaries (endP of one is startP-1 of the next, or the cut falls
  between them).
- Each keep realizes one tableOfContents entry.
- anchorText (keeps only): a short VERBATIM phrase from inside the
  segment. title names the PAYOFF, not just the topic. hook: why a viewer
  picks this chapter. summary: 1-2 sentences.
- DROP what earns no chapter — housekeeping, sponsor reads, warmup
  chatter, low-energy stretches, the weaker telling of a story told twice
  — each with its reason. Dropping is a first-class editorial decision.

Set mode to "segments", fill only "plan"; brief and candidates are null.`;
}

// ---- Runners --------------------------------------------------------------

function briefToPromptText(brief: EpisodeBrief): string {
  const spine = brief.spine
    .map((entry) => `- [P${entry.startP}-P${entry.endP}] ${entry.topic}`)
    .join("\n");
  const arcs = brief.marqueeArcs
    .map((arc) => `- [P${arc.startP}-P${arc.endP}] ${arc.title} — ${arc.note}`)
    .join("\n");
  const drops = brief.dropZones
    .map((zone) => `- [P${zone.startP}-P${zone.endP}] ${zone.reason}`)
    .join("\n");
  return `TONE: ${brief.tone}\nSPINE:\n${spine}${arcs ? `\nMARQUEE ARCS:\n${arcs}` : ""}${drops ? `\nDROP ZONES:\n${drops}` : ""}`;
}

export { briefToPromptText };

export async function runEpisodeBriefPass(
  input: ClipPrefixInput
): Promise<StructuredResult<ClipProposal>> {
  return await generateStructured(
    "episode-brief.compose",
    CLIP_SYSTEM,
    BRIEF_INSTRUCTIONS,
    clipProposalSchema,
    { cachedPrefix: buildClipPrefix(input) }
  );
}

export async function runMomentRoughPass(
  input: ClipPrefixInput,
  brief: EpisodeBrief | null
): Promise<StructuredResult<ClipProposal>> {
  return await generateStructured(
    "moment-discovery.candidates",
    CLIP_SYSTEM,
    momentsInstructions(brief ? briefToPromptText(brief) : null),
    clipProposalSchema,
    { cachedPrefix: buildClipPrefix(input) }
  );
}

export async function runSegmentRoughPass(
  input: ClipPrefixInput,
  brief: EpisodeBrief | null,
  momentInventory: readonly ClipInventoryItem[]
): Promise<StructuredResult<ClipProposal>> {
  const inventory = inventoryPreamble(
    "KNOWN PEAK MOMENTS (arc cores — a chapter usually contains one or more)",
    momentInventory
  );
  return await generateStructured(
    "segment-plan.partition",
    CLIP_SYSTEM,
    `${segmentsInstructions(brief ? briefToPromptText(brief) : null)}${inventory}`,
    clipProposalSchema,
    { cachedPrefix: buildClipPrefix(input) }
  );
}

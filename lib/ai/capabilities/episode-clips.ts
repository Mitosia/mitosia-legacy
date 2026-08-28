import { z } from "zod";
import type { CutGrid } from "@/lib/intelligence/grid";
import { renderCoarse } from "@/lib/intelligence/grid";
import type { SourceContextPack } from "../context";
import { generateStructured, type StructuredResult } from "../generate";

// The shared half of the cutting room's episode-level passes
// (docs/clip-cut-architecture.md §4): the Director's brief and both rough
// cuts and the global Reconciler read ONE cached prefix (context +
// inventories + the coarse
// paragraph-ID transcript) under ONE system string and ONE union schema —
// the S5 cache-key rule: tools/schema and system precede messages in the
// Anthropic cache key, so any per-mode difference there would bust the
// cache that makes four Opus passes affordable. Only the post-breakpoint
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
  .object({
    tableOfContents: z.array(z.string().trim().min(1).max(90)).max(40),
  })
  .extend({ segments: z.array(segmentRoughSchema).min(1).max(64) });

export type SegmentRoughPlan = z.infer<typeof segmentPlanSchema>;

// The global chapter Reconciler is deliberately part of the SAME union
// schema as the Director and rough Editors. Anthropic's cache key includes
// the output schema, so a separate schema would throw away the full-episode
// cache just before the pass that most needs the Director's view.
const segmentGroupSchema = z
  .object({ reasoning: z.string().min(1).max(REASONING_MAX) })
  .extend({
    atomIds: z
      .array(z.string().regex(/^A\d{3}$/))
      .min(1)
      .max(64),
  })
  .extend({ kind: z.enum(["keep", "drop"]) })
  .extend({ title: z.string().min(1).max(120).nullable() })
  .extend({ hook: z.string().min(1).max(200).nullable() })
  .extend({ summary: z.string().min(1).max(300).nullable() })
  .extend({ dropReason: briefDropZoneSchema.shape.reason.nullable() });

const segmentReconciliationSchema = z.object({
  groups: z.array(segmentGroupSchema).max(64),
});

export type SegmentReconciliation = z.infer<typeof segmentReconciliationSchema>;

// ONE schema for all four modes: exactly one branch is non-null, named by
// `mode`. Array bounds are output-budget ceilings, never targets — the
// instructions name no counts (the count-anchoring rule).
const clipProposalBaseSchema = z
  .object({
    mode: z.enum(["brief", "moments", "segments", "segment_reconcile"]),
  })
  .extend({ brief: episodeBriefSchema.nullable() })
  .extend({ candidates: z.array(momentRoughSchema).max(24).nullable() })
  .extend({ plan: segmentPlanSchema.nullable() })
  .extend({ reconciliation: segmentReconciliationSchema.nullable() });

const MODE_BRANCH = {
  brief: "brief",
  moments: "candidates",
  segment_reconcile: "reconciliation",
  segments: "plan",
} as const;

export const clipProposalSchema = clipProposalBaseSchema.superRefine(
  (proposal, context) => {
    const selected = MODE_BRANCH[proposal.mode];
    for (const branch of [
      "brief",
      "candidates",
      "plan",
      "reconciliation",
    ] as const) {
      const present = proposal[branch] !== null;
      if ((branch === selected) === present) {
        continue;
      }
      context.addIssue({
        code: "custom",
        message:
          branch === selected
            ? `${proposal.mode} output must fill ${branch}`
            : `${proposal.mode} output must set ${branch} to null`,
        path: [branch],
      });
    }
  }
);

export type ClipProposal = z.infer<typeof clipProposalSchema>;

// ---- Shared system + prefix ----------------------------------------------

export const CLIP_SYSTEM = `You are a senior clips editor working through one long recording for a content team.
You will be given context, sometimes an outline and a highlight inventory,
and the transcript rendered as PARAGRAPH lines: "P012 [mm:ss] S2: text…".
P-numbers are paragraph IDs. Most jobs locate regions with those IDs; the
chapter Reconciler instead groups the A-numbers explicitly supplied by its
instruction. Use only the coordinate system named by the current job. The
[mm:ss] stamps are for your sense of pacing; you never output times.
Rules that apply to every job:
- When the job asks you to LOCATE regions, choose the paragraphs where a
  thing genuinely begins and ends — including the setup that provokes it.
  A dedicated cutter will later place the exact cut inside that region.
- When the job asks for anchorText, copy it VERBATIM from inside the region
  — exact words, in order. It is matched back to the word timeline; never
  paraphrase an anchor. The current job defines how a failed match is handled.
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

// The ONE cached prefix all four episode passes read. Byte-identical
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

Set mode to "brief", fill only "brief"; candidates, plan, and
reconciliation are null.`;

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
  distinctive words). A moment whose anchor does not align is discarded.
- title: specific, not generic. hook: one sentence on why a viewer stops.
  summary: 1-2 sentences of what happens.
- seedIds: ids from the highlight inventory you drew on (empty if none).
- scores: comprehensibility, hook, insight, relevance, risk — 0-1,
  honestly. risk flags sensitive material; flag it, never censor it.

Rank best first; prefer distinct moments over near-duplicates of one
beat. Set mode to "moments", fill only "candidates"; brief, plan, and
reconciliation are null.`;
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
Every outline, extraction, and moment inventory above is coverage evidence
inside topics — never a boundary seed and never a target chapter count. Only
genuine topic turns in the transcript determine chapter topology.

FIRST write tableOfContents: the episode's chapter titles at topic
altitude, in order — commit to what the chapters ARE before cutting.
THEN emit the partition:
- Segments are chronological, non-overlapping, and together account for
  the ENTIRE recording — every span is kind "keep" (a chapter) or kind
  "drop" (with a reason). Nothing is simply omitted. Consecutive segments
  share boundaries exactly: endP of one is startP-1 of the next. The first
  starts at P000 and the last ends at the final supplied paragraph.
- Each keep realizes one tableOfContents entry.
- anchorText (keeps only): a short VERBATIM phrase from inside the
  segment. title names the PAYOFF, not just the topic. hook: why a viewer
  picks this chapter. summary: 1-2 sentences. Anchor verification never
  changes keep/drop or chapter topology; code flags an unverified anchor.
- DROP what earns no chapter — housekeeping, sponsor reads, warmup
  chatter, low-energy stretches, the weaker telling of a story told twice
  — each with its reason. Dropping is a first-class editorial decision.

Set mode to "segments", fill only "plan"; brief, candidates, and
reconciliation are null.`;
}

export interface SegmentReconcileAtomInput {
  anchorText: string | null;
  atomId: string;
  dropReason: SegmentRoughItem["dropReason"];
  endMs: number;
  hook: string | null;
  kind: SegmentRoughItem["kind"];
  startMs: number;
  summary: string | null;
  title: string | null;
}

function paragraphAtMs(grid: CutGrid, ms: number): number {
  let match = 0;
  for (const paragraph of grid.paragraphs) {
    if (paragraph.startMs > ms) {
      break;
    }
    match = paragraph.id;
  }
  return match;
}

function reconcileAtomText(
  atom: SegmentReconcileAtomInput,
  grid: CutGrid
): string {
  const seconds = Math.max(0, atom.endMs - atom.startMs) / 1000;
  const paragraphRange = `P${String(paragraphAtMs(grid, atom.startMs)).padStart(3, "0")}-P${String(paragraphAtMs(grid, Math.max(atom.startMs, atom.endMs - 1))).padStart(3, "0")}`;
  if (atom.kind === "drop") {
    return `${atom.atomId} DROP [${paragraphRange}, ${stamp(atom.startMs)}-${stamp(atom.endMs)}, ${(seconds / 60).toFixed(1)}m] reason=${atom.dropReason ?? "other"}`;
  }
  return `${atom.atomId} KEEP [${paragraphRange}, ${stamp(atom.startMs)}-${stamp(atom.endMs)}, ${(seconds / 60).toFixed(1)}m]\n  TITLE: ${atom.title ?? "(untitled)"}\n  HOOK: ${atom.hook ?? ""}\n  SUMMARY: ${atom.summary ?? ""}\n  SOURCE ANCHOR: ${atom.anchorText ?? "(missing)"}`;
}

function segmentReconcileInstructions(
  brief: string | null,
  tableOfContents: readonly string[],
  atoms: readonly SegmentReconcileAtomInput[],
  validationIssues: readonly string[],
  previousGroups: SegmentReconciliation["groups"],
  grid: CutGrid
): string {
  const toc = tableOfContents
    .map((title, index) => `${index + 1}. ${title}`)
    .join("\n");
  const rough = atoms.map((atom) => reconcileAtomText(atom, grid)).join("\n");
  const rejectedGrouping = previousGroups
    .map(
      (group, index) =>
        `${index}. ${group.kind.toUpperCase()} ${group.atomIds.join("+")} — ${group.reasoning}`
    )
    .join("\n");
  const repair =
    validationIssues.length > 0
      ? `\n\nYOUR PREVIOUS GROUPING WAS REJECTED BY CODE:\n${rejectedGrouping || "(no groups returned)"}\nVALIDATION ERRORS:\n${validationIssues.map((issue) => `- ${issue}`).join("\n")}\nReturn a corrected exact cover.`
      : "";
  return `${brief ? `EPISODE BRIEF (from the director):\n${brief}\n\n` : ""}Your job: MODE "segment_reconcile". You are the supervising chapter editor. The rough Editor proposed a table of contents and an ordered set of chapter atoms. Treat EVERY boundary between adjacent atoms as a hypothesis, not a fact. Regroup the atoms into the final episode chapters before a Cutter places the surviving boundaries exactly.

Every outline, extraction, and moment inventory in the cached context is
coverage evidence inside topics — never a boundary seed or target count.

A real boundary survives only when BOTH sides are independently selectable
topics: each side has its own setup, development, and resolution. Merge
adjacent KEEP atoms when they are a question and its direct answer, a
sentence or referent that continues backward, a brief host interjection
inside the guest's same explanation, an example/definition/method supporting
the same thesis, or a weak middle fragment that needs one of its neighbors
to make sense. A short duration is a reason to inspect a boundary closely,
never a minimum-duration rule. Keep a short chapter when it truly is a
complete distinct topic. Never merge unrelated topics merely to make them
longer.

Your output is an EXACT ORDERED COVER of the atoms:
- Every atom ID appears exactly once, in the given order. A group contains
  one or more CONTIGUOUS IDs; never reorder, omit, duplicate, or invent IDs.
- KEEP and DROP atoms never share a group. Every DROP stays in its own
  singleton group: dropped material is a fixed hard barrier between chapters.
- A KEEP group gets one truthful title, hook, and summary describing the
  complete combined topic, with dropReason null.
- SOURCE ANCHOR availability is provenance, not a topic boundary signal.
  Never merge chapters merely because an atom's source anchor is missing.
- A DROP group has title/hook/summary null and retains a truthful dropReason.
- reasoning comes first and names why the internal boundaries disappear or
  why the topic stands alone.
- The final table of contents is derived by code from these KEEP groups, so
  do not output another TOC.

ROUGH TABLE OF CONTENTS:
${toc || "(empty)"}

ORDERED ATOMS:
${rough}${repair}

Set mode to "segment_reconcile", fill only "reconciliation"; brief,
candidates, and plan are null.`;
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
  momentInventory: readonly ClipInventoryItem[],
  validationIssues: readonly string[] = [],
  previousPlan: SegmentRoughPlan | null = null
): Promise<StructuredResult<ClipProposal>> {
  const inventory = inventoryPreamble(
    "KNOWN PEAK MOMENTS (coverage evidence only — never chapter boundaries or a target count)",
    momentInventory
  );
  const repair =
    validationIssues.length > 0
      ? `\n\nYOUR PREVIOUS PARTITION WAS REJECTED BY CODE:\n${
          previousPlan?.segments
            .map(
              (segment, index) =>
                `${index}. ${segment.kind.toUpperCase()} P${String(segment.startP).padStart(3, "0")}-P${String(segment.endP).padStart(3, "0")} ${segment.title ?? segment.dropReason ?? ""}`
            )
            .join("\n") ?? "(no plan returned)"
        }\nVALIDATION ERRORS:\n${validationIssues.map((issue) => `- ${issue}`).join("\n")}\nReturn a corrected exact partition.`
      : "";
  return await generateStructured(
    "segment-plan.partition",
    CLIP_SYSTEM,
    `${segmentsInstructions(brief ? briefToPromptText(brief) : null)}${inventory}${repair}`,
    clipProposalSchema,
    { cachedPrefix: buildClipPrefix(input) }
  );
}

export async function runSegmentReconcilePass(
  input: ClipPrefixInput,
  brief: EpisodeBrief | null,
  tableOfContents: readonly string[],
  atoms: readonly SegmentReconcileAtomInput[],
  validationIssues: readonly string[] = [],
  previousGroups: SegmentReconciliation["groups"] = []
): Promise<StructuredResult<ClipProposal>> {
  return await generateStructured(
    "segment-plan.reconcile",
    CLIP_SYSTEM,
    segmentReconcileInstructions(
      brief ? briefToPromptText(brief) : null,
      tableOfContents,
      atoms,
      validationIssues,
      previousGroups,
      input.grid
    ),
    clipProposalSchema,
    { cachedPrefix: buildClipPrefix(input) }
  );
}

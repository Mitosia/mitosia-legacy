import { z } from "zod";
import { buildParagraphs } from "@/lib/transcription/paragraphs";
import type { TranscriptData } from "@/lib/transcription/types";
import type { SourceContextPack } from "../context";
import { generateStructured, type StructuredUsage } from "../generate";
import { transcriptToPromptText } from "./source-analysis";

// The S5 extraction capability: four verified passes over one cached
// transcript prefix — quotes, stories, claims, and Q&A exchanges. Model
// identity comes from the provider-neutral task registry. Every pass uses
// the same portable wire contract and local exact validator; cache reads are
// recorded and measured rather than assumed from provider identity.
//
// `text` must be VERBATIM transcript words — the pipeline aligns it back to
// the word timeline (lib/intelligence/grounding.ts) and discards what
// doesn't match; ranges are snapped there too, so the model's ms values
// only steer the search window. ANALYSIS_PROVIDER=mock selects a
// deterministic fake whose spans are real transcript words, so grounding
// succeeds and the whole lifecycle is CI-provable.

export const EXTRACTION_PASS_KINDS = ["quote", "story", "claim", "qa"] as const;
export type ExtractionPassKind = (typeof EXTRACTION_PASS_KINDS)[number];

// Property order is generation order (the S4 editorial-schema lesson, built
// with chained .extend so formatters can't reorder): the span comes first —
// locating evidence before characterizing it — and confidence last.
const extractionItemSchema = z
  .object({ kind: z.enum(EXTRACTION_PASS_KINDS) })
  .extend({ startMs: z.number().int().nonnegative() })
  .extend({ endMs: z.number().int().nonnegative() })
  .extend({ text: z.string().min(1).max(1500) })
  .extend({
    // claims: the assertion as a standalone sentence; stories: the arc in
    // one sentence; qa: the question VERBATIM; quotes: null
    statement: z.string().max(500).nullable(),
  })
  .extend({ title: z.string().max(120).nullable() })
  .extend({ confidence: z.number().min(0).max(1) });

// The array bound is part of the output-budget math, not just tidiness:
// the grammar cannot stop the model over-emitting up to this bound, so
// worst case ≈ bound × ~520 tokens/item + adaptive thinking must fit the
// largest pass budget (32k for claims). 48 items ≈ 25k + thinking — the
// staging claims pass at .max(80) emitted past a 24k budget and truncated
// mid-JSON ("could not parse the response", 2026-08-24). Per-pass caps
// live in the instructions; this is the hard ceiling they trim under.
export const extractionOutputSchema = z.object({
  extractions: z.array(extractionItemSchema).max(48),
});

export type RawExtraction = z.infer<typeof extractionItemSchema>;

export interface ExtractionAnalysisContext {
  chapters: { startMs: number; title: string }[];
  summary: string | null;
}

export interface SourceExtractionInput {
  analysis: ExtractionAnalysisContext | null;
  contextPack: SourceContextPack;
  durationMs: number;
  transcript: TranscriptData;
}

export interface SourceExtractionResult {
  items: RawExtraction[];
  usage: StructuredUsage[];
}

interface PassSpec {
  instructions: string;
  kind: ExtractionPassKind;
  maxItems: number;
  task:
    | "source-extraction.claims"
    | "source-extraction.qa"
    | "source-extraction.quotes"
    | "source-extraction.stories";
}

// Caps live here AND in the instructions ("ranked by significance") — the
// S4 entity lesson: a budget squeeze must degrade the tail, never the head.
const PASSES: PassSpec[] = [
  {
    instructions: `Extract the most quotable moments: statements worth repeating word-for-word — vivid, surprising, opinionated, or crystallizing. kind="quote" for every item. text = the quote VERBATIM from the transcript. statement = null, title = null. At most 40, ranked by how quotable they are.`,
    kind: "quote",
    maxItems: 40,
    task: "source-extraction.quotes",
  },
  {
    instructions: `Extract the stories: self-contained narrative arcs (an anecdote, a case, a journey with a beginning and resolution). kind="story" for every item. Choose ONE contiguous span per story: text = the story's OPENING words VERBATIM (the first 1-3 sentences), startMs/endMs = the full story's range. statement = the arc in one sentence. title = a specific short title. At most 12, ranked by narrative strength.`,
    kind: "story",
    maxItems: 12,
    task: "source-extraction.stories",
  },
  {
    instructions: `Extract notable claims: factual or strongly-held assertions a content team could build on (numbers, predictions, contrarian positions, recommendations). kind="claim" for every item. text = the ONE sentence containing the claim VERBATIM (under 50 words — never a whole passage). statement = the assertion as one standalone sentence. title = null. At most 40, ranked by significance.`,
    kind: "claim",
    maxItems: 40,
    task: "source-extraction.claims",
  },
  {
    instructions: `Extract question-and-answer exchanges: a real question asked by one speaker and the answer given by another. kind="qa" for every item. text = the ANSWER's opening words VERBATIM (first 1-3 sentences). statement = the question VERBATIM. title = null. startMs/endMs = the answer's range. At most 40, in recording order.`,
    kind: "qa",
    maxItems: 40,
    task: "source-extraction.qa",
  },
];

const SHARED_SYSTEM = `You extract highlight-worthy material from long recordings for a content team.
You will be given context, sometimes an outline, and a diarized transcript
with [mm:ss] timestamps, then an instruction naming ONE kind of material to
extract. Rules that apply to every request:
- text must be copied VERBATIM from the transcript — exact words, in order,
  no corrections. It is matched back to the word timeline and the item is
  DISCARDED if it does not align.
- startMs/endMs are your best estimate of the span's position in
  milliseconds, derived from the [mm:ss] timestamps.
- Emit ONLY items of the requested kind. Never invent content that is not
  in the transcript.`;

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

function analysisPreamble(analysis: ExtractionAnalysisContext | null): string {
  if (!analysis) {
    return "";
  }
  const parts: string[] = [];
  if (analysis.summary) {
    parts.push(`SUMMARY:\n${analysis.summary}`);
  }
  if (analysis.chapters.length > 0) {
    const outline = analysis.chapters
      .map((chapter) => {
        const totalSeconds = Math.floor(chapter.startMs / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `[${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}] ${chapter.title}`;
      })
      .join("\n");
    parts.push(`OUTLINE:\n${outline}`);
  }
  return parts.length > 0 ? `\n\n${parts.join("\n\n")}` : "";
}

// The cached prefix must be byte-identical across passes — build it once.
export function buildCachedPrefix(input: SourceExtractionInput): string {
  return `${contextPreamble(input.contextPack)}${analysisPreamble(input.analysis)}\n\nTRANSCRIPT:\n${transcriptToPromptText(input.transcript)}`;
}

async function runPass(
  pass: PassSpec,
  cachedPrefix: string
): Promise<{ items: RawExtraction[]; usage: StructuredUsage }> {
  const run = await generateStructured(
    pass.task,
    SHARED_SYSTEM,
    pass.instructions,
    extractionOutputSchema,
    { cachedPrefix }
  );
  return {
    // Kind drift and over-emission are trimmed deterministically.
    items: run.output.extractions
      .filter((item) => item.kind === pass.kind)
      .slice(0, pass.maxItems),
    usage: run.usage,
  };
}

function mockExtraction(input: SourceExtractionInput): SourceExtractionResult {
  const paragraphs = buildParagraphs(input.transcript);
  const spanText = (index: number): string =>
    paragraphs[index]?.words.map((word) => word.text).join(" ") ?? "";
  const span = (index: number) => ({
    endMs: paragraphs[index]?.endMs ?? 0,
    startMs: paragraphs[index]?.startMs ?? 0,
  });
  if (paragraphs.length === 0) {
    return { items: [], usage: [] };
  }
  const last = paragraphs.length - 1;
  const items: RawExtraction[] = [
    {
      confidence: 0.9,
      kind: "quote",
      statement: null,
      text: spanText(0),
      title: null,
      ...span(0),
    },
    {
      confidence: 0.8,
      kind: "claim",
      statement: "A deterministic mock paraphrase of the point being made.",
      text: spanText(Math.min(1, last)),
      title: null,
      ...span(Math.min(1, last)),
    },
    {
      confidence: 0.7,
      kind: "story",
      statement: "A mock arc from start to finish.",
      text: spanText(Math.min(2, last)),
      title: "Mock story",
      ...span(Math.min(2, last)),
    },
  ];
  const [, second] = paragraphs;
  if (second) {
    items.push({
      confidence: 0.85,
      endMs: second.endMs,
      kind: "qa",
      startMs: second.startMs,
      statement: spanText(0),
      text: spanText(1),
      title: null,
    });
  }
  return { items, usage: [] };
}

export async function runSourceExtraction(
  input: SourceExtractionInput
): Promise<SourceExtractionResult> {
  if (process.env.ANALYSIS_PROVIDER === "mock") {
    return mockExtraction(input);
  }

  const cachedPrefix = buildCachedPrefix(input);
  const [primer, ...rest] = PASSES;
  if (!primer) {
    return { items: [], usage: [] };
  }

  // Prime the shared prefix with the first pass, then fan out. Await every
  // started sibling before throwing so usage capture is complete and a
  // Trigger retry cannot overlap an abandoned paid request.
  const first = await runPass(primer, cachedPrefix);
  const settled = await Promise.allSettled(
    rest.map((pass) => runPass(pass, cachedPrefix))
  );
  const rejected = settled.find((result) => result.status === "rejected");
  if (rejected?.status === "rejected") {
    throw rejected.reason;
  }
  const parallel = settled.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : []
  );

  const all = [first, ...parallel];
  return {
    items: all.flatMap((result) => result.items),
    usage: all.map((result) => result.usage),
  };
}

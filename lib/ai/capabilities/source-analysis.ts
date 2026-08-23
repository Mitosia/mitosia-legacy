import { z } from "zod";
import { buildParagraphs } from "@/lib/transcription/paragraphs";
import type { TranscriptData } from "@/lib/transcription/types";
import type { SourceContextPack } from "../context";
import { generateStructured, type StructuredUsage } from "../generate";

// The S4 source-analysis capability: chapters (haiku-tier broad pass) +
// editorial (sonnet-tier summary/topics/entities/speaker intelligence),
// each a single structured-output call over the full transcript — a 2.5h
// source is only ~30k tokens, so no map-reduce. Prompts are inline v1;
// they register into the Langfuse prompt registry with the evals PR, and
// from then on change only through the registry (cross-cutting rule 2).
//
// ANALYSIS_PROVIDER=mock selects a deterministic fake (same pattern as
// TRANSCRIPTION_PROVIDER=mock): the CI fixture's mock transcript can prove
// the whole lifecycle without a model call.

const chapterSchema = z.object({
  endMs: z.number().int().nonnegative(),
  startMs: z.number().int().nonnegative(),
  summary: z.string().max(500),
  title: z.string().min(1).max(120),
});

export const chaptersOutputSchema = z.object({
  chapters: z.array(chapterSchema).min(1).max(60),
});

// Property order is generation order for native structured output: the
// high-value scalar fields come first so a budget squeeze degrades the
// entity tail, never the summary. Entities allow 60 at the schema (models
// enumerate enthusiastically on dense content — a 2.5h geopolitics
// interview blew a 40 cap on staging) and are trimmed to 40 after.
// Built with chained .extend() so the property order SURVIVES formatters —
// each link appends one key, and single-key literals give the key-sorter
// nothing to sort.
export const editorialOutputSchema = z
  .object({ summary: z.string().min(50).max(2000) })
  .extend({ topics: z.array(z.string().min(1).max(60)).max(12) })
  .extend({
    speakers: z.array(
      z.object({
        // Confidence 0-1 in the suggestion; UI shows it, never auto-applies
        confidence: z.number().min(0).max(1),
        // Short quote from the transcript that justifies the suggestion
        evidence: z.string().max(300),
        // Another speaker id this one appears to be the same person as
        mergeWith: z.string().nullable(),
        speaker: z.string(),
        suggestedName: z.string().max(80).nullable(),
      })
    ),
  })
  .extend({
    entities: z
      .array(
        z.object({
          name: z.string().min(1).max(120),
          type: z.enum(["person", "organization", "product", "place", "other"]),
        })
      )
      .max(60),
  });

const MAX_ENTITIES = 40;

export type ChaptersOutput = z.infer<typeof chaptersOutputSchema>;
export type EditorialOutput = z.infer<typeof editorialOutputSchema>;

export type AnalysisUsage = StructuredUsage;

export interface SourceAnalysisResult {
  chapters: ChaptersOutput["chapters"];
  editorial: EditorialOutput;
  usage: AnalysisUsage[];
}

export interface SourceAnalysisInput {
  contextPack: SourceContextPack;
  durationMs: number;
  transcript: TranscriptData;
}

// The transcript as the model sees it: speaker turns with timestamps, via
// the same paragraph grouping the viewer uses (pure + already tested).
export function transcriptToPromptText(transcript: TranscriptData): string {
  return buildParagraphs(transcript)
    .map((paragraph) => {
      const totalSeconds = Math.floor(paragraph.startMs / 1000);
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      const stamp = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
      const speaker =
        paragraph.speaker === null
          ? "Speaker"
          : `Speaker ${Number(paragraph.speaker) + 1}`;
      const text = paragraph.words.map((word) => word.text).join(" ");
      return `[${stamp}] ${speaker} (id=${paragraph.speaker ?? "?"}): ${text}`;
    })
    .join("\n");
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

const CHAPTERS_INSTRUCTIONS = `You segment long recordings into chapters for a content team.
Given a diarized transcript with [mm:ss] timestamps, produce chapters that
cover the whole recording in order: 3-20 chapters for typical content,
each with a specific, concrete title (never generic like "Introduction"
unless it truly is one), a 1-2 sentence summary, and startMs/endMs in
milliseconds derived from the timestamps. Chapters must not overlap, must
be in ascending order, and the last chapter must end near the recording's
end.`;

const EDITORIAL_INSTRUCTIONS = `You are an editorial analyst for a content agency.
Given a diarized transcript, produce:
- summary: an executive summary (3-6 sentences) a strategist would trust.
- topics: up to 12 short topic tags.
- entities: the most significant people, organizations, products, and
  places actually discussed — at most 25, ranked by importance.
- speakers: for EVERY speaker id present, infer the real name when the
  transcript reveals it (introductions, addressing each other); when two
  ids clearly belong to the same person (one voice over-segmented by
  diarization — same role, mid-thought continuity), set mergeWith to the
  id it should merge into. suggestedName null when unknowable. confidence
  reflects the evidence; quote the evidence briefly.
Never invent names that are not supported by the transcript.`;

// Chapters the model got slightly wrong (overlaps, out of range) are
// repaired, not failed: clamp to the media duration, sort, and drop
// zero-length results. Deterministic post-processing beats re-prompting.
export function normalizeChapters(
  chapters: ChaptersOutput["chapters"],
  durationMs: number
): ChaptersOutput["chapters"] {
  // Unit repair first: models sometimes emit SECONDS despite instructions
  // (observed on staging — every chapter of a 44-minute source "started"
  // in the first 3 seconds). If the whole set fits inside 1% of the
  // duration, treat the values as seconds.
  const maxEndMs = Math.max(0, ...chapters.map((chapter) => chapter.endMs));
  const scale =
    durationMs > 60_000 && maxEndMs > 0 && maxEndMs <= durationMs / 100
      ? 1000
      : 1;
  const scaled = chapters.map((chapter) => ({
    ...chapter,
    endMs: chapter.endMs * scale,
    startMs: chapter.startMs * scale,
  }));
  const sorted = scaled.sort((a, b) => a.startMs - b.startMs);
  const repaired: ChaptersOutput["chapters"] = [];
  for (const chapter of sorted) {
    const startMs = Math.max(
      0,
      Math.min(chapter.startMs, durationMs),
      repaired.at(-1)?.endMs ?? 0
    );
    const endMs = Math.min(Math.max(chapter.endMs, startMs), durationMs);
    if (endMs > startMs) {
      repaired.push({ ...chapter, endMs, startMs });
    }
  }
  return repaired;
}

function mockAnalysis(input: SourceAnalysisInput): SourceAnalysisResult {
  const { durationMs, transcript } = input;
  const speakerIds = [
    ...new Set(
      transcript.words.map((word) => word.speaker).filter((s) => s !== null)
    ),
  ].sort();
  const third = Math.floor(durationMs / 3);
  return {
    chapters: [
      {
        endMs: third,
        startMs: 0,
        summary: "Deterministic mock chapter one.",
        title: "Mock chapter 1",
      },
      {
        endMs: third * 2,
        startMs: third,
        summary: "Deterministic mock chapter two.",
        title: "Mock chapter 2",
      },
      {
        endMs: durationMs,
        startMs: third * 2,
        summary: "Deterministic mock chapter three.",
        title: "Mock chapter 3",
      },
    ],
    editorial: {
      entities: [{ name: "Mitosia", type: "product" }],
      speakers: speakerIds.map((speaker, index) => ({
        confidence: 0.9,
        evidence: "Welcome to the Mitosia mock transcript.",
        mergeWith: null,
        speaker: speaker as string,
        suggestedName: index === 0 ? "Mock Host" : "Mock Guest",
      })),
      summary:
        "A deterministic mock analysis of the mock transcript, exercising the full lifecycle without a model call.",
      topics: ["mock", "pipeline"],
    },
    usage: [],
  };
}

export async function runSourceAnalysis(
  input: SourceAnalysisInput
): Promise<SourceAnalysisResult> {
  if (process.env.ANALYSIS_PROVIDER === "mock") {
    return mockAnalysis(input);
  }

  const transcriptText = transcriptToPromptText(input.transcript);
  const preamble = contextPreamble(input.contextPack);
  const userMessage = `${preamble}\n\nTRANSCRIPT:\n${transcriptText}`;

  const [chaptersRun, editorialRun] = await Promise.all([
    generateStructured(
      "source-analysis.chapters",
      CHAPTERS_INSTRUCTIONS,
      userMessage,
      chaptersOutputSchema
    ),
    generateStructured(
      "source-analysis.editorial",
      EDITORIAL_INSTRUCTIONS,
      userMessage,
      editorialOutputSchema
    ),
  ]);

  return {
    chapters: normalizeChapters(chaptersRun.output.chapters, input.durationMs),
    editorial: {
      ...editorialRun.output,
      entities: editorialRun.output.entities.slice(0, MAX_ENTITIES),
    },
    usage: [chaptersRun.usage, editorialRun.usage],
  };
}

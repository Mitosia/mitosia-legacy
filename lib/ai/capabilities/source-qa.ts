import { z } from "zod";
import { normalizeTokens } from "@/lib/intelligence/grounding";
import { generateStructured, type StructuredUsage } from "../generate";

// Source Q&A (S5): answer a question from retrieved transcript chunks,
// citing timestamp ranges. The capability sees ONLY what retrieval
// surfaced — and the pipeline afterwards clamps every citation to a
// retrieved chunk's range (lib/intelligence/qa.ts), so the model cannot
// cite what it was not shown. Honesty is first-class: answerable=false is
// a legitimate, rendered outcome, never an empty answer.

export interface QaChunk {
  endMs: number;
  idx: number;
  startMs: number;
  text: string;
}

export interface SourceQaInput {
  chapters: { startMs: number; title: string }[];
  chunks: QaChunk[];
  question: string;
  summary: string | null;
  title: string;
}

// Property order is generation order: the model decides answerability
// first, writes the answer, then cites — and citations are verified
// afterwards anyway.
const qaOutputSchema = z
  .object({ answerable: z.boolean() })
  .extend({ answer: z.string().min(1).max(3000) })
  .extend({
    citations: z
      .array(
        z
          .object({ startMs: z.number().int().nonnegative() })
          .extend({ endMs: z.number().int().nonnegative() })
          .extend({ quote: z.string().max(300) })
      )
      .max(8),
  });

export type QaOutput = z.infer<typeof qaOutputSchema>;

export interface SourceQaResult {
  output: QaOutput;
  usage: StructuredUsage[];
}

const QA_SYSTEM = `You answer questions about a recording for a content team.
You are given excerpts of its transcript, each tagged with a millisecond
range, and one question. Rules:
- Answer ONLY from the excerpts. Never use outside knowledge or guess.
- If the excerpts do not cover the question, set answerable=false and say
  briefly that the recording does not discuss it.
- When answerable, cite the supporting excerpts: each citation's
  startMs/endMs must be a range INSIDE one of the excerpt ranges, with a
  short quote of the supporting words.
- Answer in plain prose, no markdown headings.`;

function excerptBlock(chunks: QaChunk[]): string {
  return chunks
    .map(
      (chunk) =>
        `[excerpt ${chunk.idx} | ${chunk.startMs}-${chunk.endMs}ms]\n${chunk.text}`
    )
    .join("\n\n");
}

function preamble(input: SourceQaInput): string {
  const parts = [`Recording: "${input.title}"`];
  if (input.summary) {
    parts.push(`Summary: ${input.summary}`);
  }
  if (input.chapters.length > 0) {
    parts.push(
      `Outline: ${input.chapters.map((chapter) => chapter.title).join(" · ")}`
    );
  }
  return parts.join("\n");
}

// Deterministic fake for e2e/dev (ANALYSIS_PROVIDER=mock): answerable when
// the question meaningfully overlaps a chunk, citing that chunk — so the
// honest-miss path is exercised by nonsense questions. Three shared tokens,
// not two: an entity name alone ("Lumen Robotics") must not make an
// off-topic question answerable.
const MOCK_MIN_OVERLAP = 3;
// 5+ characters keeps question-stopwords ("what", "does") out of the
// overlap count.
const MOCK_TOKEN_MIN_LENGTH = 5;

function mockAnswer(input: SourceQaInput): SourceQaResult {
  const questionTokens = normalizeTokens(input.question).filter(
    (token) => token.length >= MOCK_TOKEN_MIN_LENGTH
  );
  let best: { chunk: QaChunk; overlap: number } | null = null;
  for (const chunk of input.chunks) {
    const chunkTokens = new Set(normalizeTokens(chunk.text));
    const overlap = questionTokens.filter((token) =>
      chunkTokens.has(token)
    ).length;
    if (overlap > (best?.overlap ?? 0)) {
      best = { chunk, overlap };
    }
  }
  if (!best || best.overlap < MOCK_MIN_OVERLAP) {
    return {
      output: {
        answer: "This recording does not discuss that.",
        answerable: false,
        citations: [],
      },
      usage: [],
    };
  }
  return {
    output: {
      answer: `Deterministic mock answer grounded in the excerpt at ${best.chunk.startMs}ms.`,
      answerable: true,
      citations: [
        {
          endMs: best.chunk.endMs,
          quote: best.chunk.text.slice(0, 80),
          startMs: best.chunk.startMs,
        },
      ],
    },
    usage: [],
  };
}

// Deterministic citation verification: every citation must overlap a
// retrieved chunk and is clamped to it — the model cannot cite what it was
// not shown. Pure, shared by the ask pipeline and the eval runner.
export function verifyCitations(
  citations: QaOutput["citations"],
  chunks: readonly { endMs: number; startMs: number }[]
): { endMs: number; quote: string; startMs: number }[] {
  const verified: { endMs: number; quote: string; startMs: number }[] = [];
  for (const citation of citations) {
    const host = chunks.find(
      (chunk) =>
        citation.startMs < chunk.endMs && citation.endMs > chunk.startMs
    );
    if (!host) {
      continue;
    }
    verified.push({
      endMs: Math.min(citation.endMs, host.endMs),
      quote: citation.quote,
      startMs: Math.max(citation.startMs, host.startMs),
    });
  }
  return verified;
}

export async function runSourceQa(
  input: SourceQaInput
): Promise<SourceQaResult> {
  if (process.env.ANALYSIS_PROVIDER === "mock") {
    return mockAnswer(input);
  }
  const prompt = `${preamble(input)}\n\nEXCERPTS:\n${excerptBlock(input.chunks)}\n\nQUESTION: ${input.question}`;
  const run = await generateStructured(
    "source-qa.answer",
    QA_SYSTEM,
    prompt,
    qaOutputSchema
  );
  return { output: run.output, usage: [run.usage] };
}

import type { RawExtraction } from "@/lib/ai/capabilities/source-extraction";
import type { ExtractionKind } from "@/lib/db/schema/intelligence";
import type { TranscriptWord } from "@/lib/transcription/types";

// Deterministic grounding for extractions (S5): fuzzy-match an extraction's
// claimed-verbatim text against the transcript word timeline near its
// claimed range, snap start/end to the matched word boundaries, and score
// the match. Cheap deterministic gates before model judges (tech-stack §7):
// nothing an extraction pass produces reaches the UI without aligning here,
// which is what makes every surfaced range playable and exact.
//
// Reused beyond S5: S6 boundary snapping works over the same word timeline,
// and S11's sentence-level evidence links want exactly this text→time
// mapping. Keep it pure.

// Below this position-wise token match ratio, the span is not the text.
const DEFAULT_MIN_SCORE = 0.8;
// How far outside the claimed range to search. Models place ranges roughly
// right; a window keeps repeated phrases from matching across the recording.
const SEARCH_WINDOW_MS = 30_000;
// Claim classification: the statement is the span, or a rephrasing of it.
const DIRECT_QUOTE_SIMILARITY = 0.85;

const NON_WORD = /[^\p{L}\p{N}\s]/gu;
const WHITESPACE = /\s+/;

export function normalizeTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(NON_WORD, " ")
    .split(WHITESPACE)
    .filter((token) => token.length > 0);
}

interface TimedToken {
  endMs: number;
  startMs: number;
  token: string;
}

// One transcript word can normalize to several tokens ("we'll" → we ll) or
// none ("—"); each carries its word's timing.
export function tokenizeWords(words: readonly TranscriptWord[]): TimedToken[] {
  const tokens: TimedToken[] = [];
  for (const word of words) {
    for (const token of normalizeTokens(word.text)) {
      tokens.push({ endMs: word.endMs, startMs: word.startMs, token });
    }
  }
  return tokens;
}

export interface Alignment {
  endMs: number;
  grounded: boolean;
  score: number;
  startMs: number;
}

function matchRatio(
  needle: readonly string[],
  haystack: readonly TimedToken[],
  offset: number
): number {
  let matches = 0;
  for (const [j, token] of needle.entries()) {
    if (haystack[offset + j]?.token === token) {
      matches += 1;
    }
  }
  return matches / needle.length;
}

function searchBounds(
  tokens: readonly TimedToken[],
  claimedStartMs: number,
  claimedEndMs: number,
  needleLength: number
): { from: number; to: number } {
  const windowStart = claimedStartMs - SEARCH_WINDOW_MS;
  const windowEnd = claimedEndMs + SEARCH_WINDOW_MS;
  let from = 0;
  while (from < tokens.length && (tokens[from]?.endMs ?? 0) < windowStart) {
    from += 1;
  }
  let to = tokens.length;
  while (to > from && (tokens[to - 1]?.startMs ?? 0) > windowEnd) {
    to -= 1;
  }
  // A window too small to hold the needle means the claimed range was
  // nonsense — fall back to searching the whole timeline.
  if (to - from < needleLength) {
    return { from: 0, to: tokens.length };
  }
  return { from, to };
}

// Align extraction text to the word timeline. `timedTokens` should come
// from tokenizeWords(words) — callers aligning many extractions against the
// same transcript tokenize once.
export function alignExtraction(
  text: string,
  claimedStartMs: number,
  claimedEndMs: number,
  timedTokens: readonly TimedToken[],
  minScore: number = DEFAULT_MIN_SCORE
): Alignment {
  const needle = normalizeTokens(text);
  const ungrounded: Alignment = {
    endMs: claimedEndMs,
    grounded: false,
    score: 0,
    startMs: claimedStartMs,
  };
  if (needle.length === 0 || timedTokens.length < needle.length) {
    return ungrounded;
  }

  const { from, to } = searchBounds(
    timedTokens,
    claimedStartMs,
    claimedEndMs,
    needle.length
  );
  const claimedMidMs = (claimedStartMs + claimedEndMs) / 2;
  let bestScore = 0;
  let bestOffset = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let offset = from; offset <= to - needle.length; offset += 1) {
    const score = matchRatio(needle, timedTokens, offset);
    if (score < bestScore) {
      continue;
    }
    const spanMidMs =
      ((timedTokens[offset]?.startMs ?? 0) +
        (timedTokens[offset + needle.length - 1]?.endMs ?? 0)) /
      2;
    const distance = Math.abs(spanMidMs - claimedMidMs);
    // Strictly-better score wins; equal score goes to the candidate nearest
    // the claimed range (repeated-phrase disambiguation).
    if (score > bestScore || distance < bestDistance) {
      bestScore = score;
      bestOffset = offset;
      bestDistance = distance;
    }
  }

  if (bestOffset < 0 || bestScore < minScore) {
    return { ...ungrounded, score: bestScore };
  }
  return {
    endMs: timedTokens[bestOffset + needle.length - 1]?.endMs ?? claimedEndMs,
    grounded: true,
    score: bestScore,
    startMs: timedTokens[bestOffset]?.startMs ?? claimedStartMs,
  };
}

// Order-independent token-multiset overlap, for claim classification: a
// statement that IS the span (modulo punctuation/case) is a direct quote.
export function textSimilarity(a: string, b: string): number {
  const tokensA = normalizeTokens(a);
  const tokensB = normalizeTokens(b);
  if (tokensA.length === 0 || tokensB.length === 0) {
    return 0;
  }
  const counts = new Map<string, number>();
  for (const token of tokensA) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  let overlap = 0;
  for (const token of tokensB) {
    const remaining = counts.get(token) ?? 0;
    if (remaining > 0) {
      counts.set(token, remaining - 1);
      overlap += 1;
    }
  }
  return overlap / Math.max(tokensA.length, tokensB.length);
}

export function classifyClaim(
  statement: string | null,
  spanText: string
): "direct_quote" | "paraphrase" {
  // No separate statement means the claim is the span itself.
  if (statement === null || statement.trim().length === 0) {
    return "direct_quote";
  }
  return textSimilarity(statement, spanText) >= DIRECT_QUOTE_SIMILARITY
    ? "direct_quote"
    : "paraphrase";
}

// The full grounding step the pipeline applies to a pass's raw output —
// pure, so its behavior is provable without a database. The question of a
// Q&A exchange sits shortly before its answer; only that neighborhood is
// searched so a recurring question can't match elsewhere.
const QA_QUESTION_WINDOW_MS = 120_000;

export interface GroundedExtraction {
  classification: "direct_quote" | "paraphrase" | null;
  confidence: number;
  endMs: number;
  grounded: boolean;
  groundingScore: number;
  kind: ExtractionKind;
  payload: Record<string, unknown> | null;
  speaker: string | null;
  startMs: number;
  text: string;
}

export function groundExtractions(
  items: readonly RawExtraction[],
  words: readonly TranscriptWord[],
  durationMs: number
): GroundedExtraction[] {
  const tokens = tokenizeWords(words);
  return items.map((item) => {
    const claimedStart = Math.max(0, Math.min(item.startMs, durationMs));
    const claimedEnd = Math.max(claimedStart, Math.min(item.endMs, durationMs));
    const aligned = alignExtraction(
      item.text,
      claimedStart,
      claimedEnd,
      tokens
    );

    let { endMs, startMs } = aligned;
    // Attribution span: for qa this stays on the ANSWER (the row range
    // grows to include the question below, but the highlight belongs to
    // whoever answered, not whoever asked).
    const speakerSpan = { endMs: aligned.endMs, startMs: aligned.startMs };
    const payload: Record<string, unknown> = {};
    if (item.statement) {
      payload.statement = item.statement;
    }
    if (item.title) {
      payload.title = item.title;
    }

    if (item.kind === "qa" && item.statement && aligned.grounded) {
      // The row spans question → answer; the answer's own start is kept in
      // the payload for playback that skips straight to it.
      const question = alignExtraction(
        item.statement,
        Math.max(0, aligned.startMs - QA_QUESTION_WINDOW_MS),
        aligned.startMs,
        tokens
      );
      if (question.grounded && question.startMs <= aligned.startMs) {
        payload.answerStartMs = aligned.startMs;
        ({ startMs } = question);
      }
    }
    if (item.kind === "story" && aligned.grounded) {
      // The model gives the story's full range but text is only its opening
      // words — keep the aligner's start (exact) and the model's end
      // (approximate but the only signal for where the story closes).
      endMs = Math.max(aligned.endMs, claimedEnd);
    }

    return {
      classification:
        item.kind === "claim" ? classifyClaim(item.statement, item.text) : null,
      confidence: item.confidence,
      endMs,
      grounded: aligned.grounded,
      groundingScore: aligned.score,
      kind: item.kind,
      payload: Object.keys(payload).length > 0 ? payload : null,
      speaker: majoritySpeaker(words, speakerSpan.startMs, speakerSpan.endMs),
      startMs,
      text: item.text,
    };
  });
}

// Majority diarization speaker across a span — derived from the timeline,
// never trusted from the model.
export function majoritySpeaker(
  words: readonly TranscriptWord[],
  startMs: number,
  endMs: number
): string | null {
  const counts = new Map<string, number>();
  for (const word of words) {
    if (word.endMs < startMs || word.startMs > endMs) {
      continue;
    }
    if (word.speaker !== null) {
      counts.set(word.speaker, (counts.get(word.speaker) ?? 0) + 1);
    }
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [speaker, count] of counts) {
    if (count > bestCount) {
      best = speaker;
      bestCount = count;
    }
  }
  return best;
}

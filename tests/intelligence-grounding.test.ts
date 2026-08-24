import { describe, expect, it } from "vitest";
import {
  alignExtraction,
  classifyClaim,
  groundExtractions,
  majoritySpeaker,
  normalizeTokens,
  textSimilarity,
  tokenizeWords,
} from "../lib/intelligence/grounding";
import type { TranscriptWord } from "../lib/transcription/types";

// The aligner is the provenance gate: every surfaced range is one of its
// outputs, so its boundary behavior is asserted exhaustively.

function wordsFrom(
  sentences: { speaker?: string | null; text: string }[]
): TranscriptWord[] {
  const words: TranscriptWord[] = [];
  let cursor = 0;
  for (const sentence of sentences) {
    for (const text of sentence.text.split(" ")) {
      words.push({
        confidence: 0.95,
        endMs: cursor + 250,
        speaker: sentence.speaker === undefined ? "0" : sentence.speaker,
        startMs: cursor,
        text,
      });
      cursor += 300;
    }
  }
  return words;
}

const WORDS = wordsFrom([
  { speaker: "0", text: "Welcome back to the show everyone." },
  {
    speaker: "1",
    text: "Our revenue doubled every single quarter since launch, honestly.",
  },
  { speaker: "0", text: "That is a remarkable growth story for the market." },
  { speaker: "1", text: "We nearly went bankrupt before the turnaround came." },
]);
const TOKENS = tokenizeWords(WORDS);
const DURATION_MS = (WORDS.at(-1)?.endMs ?? 0) + 500;

function spanOf(text: string): { endMs: number; startMs: number } {
  const needle = normalizeTokens(text);
  const [first] = needle;
  const startIndex = WORDS.findIndex(
    (word) => normalizeTokens(word.text)[0] === first
  );
  const endIndex = startIndex + needle.length - 1;
  return {
    endMs: WORDS[endIndex]?.endMs ?? 0,
    startMs: WORDS[startIndex]?.startMs ?? 0,
  };
}

describe("alignExtraction", () => {
  it("grounds a verbatim span and snaps to exact word boundaries", () => {
    const text = "Our revenue doubled every single quarter since launch,";
    const expected = spanOf(text);
    const aligned = alignExtraction(text, 1000, 4000, TOKENS);
    expect(aligned.grounded).toBe(true);
    expect(aligned.score).toBe(1);
    expect(aligned.startMs).toBe(expected.startMs);
    expect(aligned.endMs).toBe(expected.endMs);
  });

  it("ignores punctuation and casing differences", () => {
    const aligned = alignExtraction(
      "our REVENUE doubled — every single quarter, since launch",
      1000,
      4000,
      TOKENS
    );
    expect(aligned.grounded).toBe(true);
    expect(aligned.score).toBe(1);
  });

  it("tolerates small drift under the threshold", () => {
    // One wrong token in nine ≈ 0.89 — grounded, but not a perfect score
    const aligned = alignExtraction(
      "Our revenue tripled every single quarter since launch honestly",
      1000,
      5000,
      TOKENS
    );
    expect(aligned.grounded).toBe(true);
    expect(aligned.score).toBeLessThan(1);
    expect(aligned.score).toBeGreaterThanOrEqual(0.8);
  });

  it("rejects fabricated text", () => {
    const aligned = alignExtraction(
      "We are announcing a brand new product line today",
      0,
      DURATION_MS,
      TOKENS
    );
    expect(aligned.grounded).toBe(false);
  });

  it("recovers from a nonsense claimed range via full-timeline search", () => {
    const text = "We nearly went bankrupt before the turnaround came.";
    const expected = spanOf(text);
    const aligned = alignExtraction(text, 0, 0, TOKENS);
    expect(aligned.grounded).toBe(true);
    expect(aligned.startMs).toBe(expected.startMs);
  });

  it("disambiguates repeated phrases toward the claimed range", () => {
    const repeated = wordsFrom([
      { text: "the plan is simple and it works" },
      { text: "some filler words in the middle here to separate things" },
      { text: "the plan is simple and it works" },
    ]);
    const tokens = tokenizeWords(repeated);
    // Sentence 1 is 7 words, sentence 2 is 10 — the repeat starts at word
    // 17, and wordsFrom spaces words 300ms apart
    const secondStart = 17 * 300;
    const near = alignExtraction(
      "the plan is simple and it works",
      secondStart,
      secondStart + 2000,
      tokens
    );
    expect(near.grounded).toBe(true);
    expect(near.startMs).toBe(secondStart);

    const first = alignExtraction(
      "the plan is simple and it works",
      0,
      1500,
      tokens
    );
    expect(first.startMs).toBe(0);
  });
});

describe("classifyClaim", () => {
  const span =
    "Our revenue doubled every single quarter since launch, honestly.";

  it("marks a statement that is the span as a direct quote", () => {
    expect(
      classifyClaim(
        "our revenue doubled every single quarter since launch honestly",
        span
      )
    ).toBe("direct_quote");
  });

  it("marks a rephrasing as a paraphrase", () => {
    expect(
      classifyClaim("The company's revenue grew 2x per quarter", span)
    ).toBe("paraphrase");
  });

  it("treats a missing statement as the span itself", () => {
    expect(classifyClaim(null, span)).toBe("direct_quote");
  });
});

describe("textSimilarity", () => {
  it("is order-independent multiset overlap", () => {
    expect(textSimilarity("alpha beta gamma", "gamma beta alpha")).toBe(1);
    expect(textSimilarity("alpha beta", "alpha beta gamma delta")).toBe(0.5);
    expect(textSimilarity("", "anything")).toBe(0);
  });
});

describe("majoritySpeaker", () => {
  it("derives the dominant speaker from the timeline", () => {
    const span = spanOf(
      "Our revenue doubled every single quarter since launch,"
    );
    expect(majoritySpeaker(WORDS, span.startMs, span.endMs)).toBe("1");
  });
});

describe("groundExtractions", () => {
  it("classifies claims, derives speakers, and spans qa question→answer", () => {
    const question = "That is a remarkable growth story for the market.";
    const answer = "We nearly went bankrupt before the turnaround came.";
    const answerSpan = spanOf(answer);
    const questionSpan = spanOf(question);
    const rows = groundExtractions(
      [
        {
          confidence: 0.9,
          endMs: answerSpan.endMs,
          kind: "qa",
          startMs: answerSpan.startMs,
          statement: question,
          text: answer,
          title: null,
        },
        {
          confidence: 0.8,
          endMs: 4000,
          kind: "claim",
          startMs: 1000,
          statement: "Revenue doubled quarterly after launch",
          text: "Our revenue doubled every single quarter since launch,",
          title: null,
        },
        {
          confidence: 0.5,
          endMs: 2000,
          kind: "quote",
          startMs: 0,
          statement: null,
          text: "totally invented words never spoken",
          title: null,
        },
      ],
      WORDS,
      DURATION_MS
    );

    const [qa, claim, invented] = rows;
    expect(qa?.grounded).toBe(true);
    expect(qa?.startMs).toBe(questionSpan.startMs);
    expect(qa?.endMs).toBe(answerSpan.endMs);
    expect(qa?.payload?.answerStartMs).toBe(answerSpan.startMs);
    expect(qa?.speaker).toBe("1");

    expect(claim?.grounded).toBe(true);
    expect(claim?.classification).toBe("paraphrase");
    expect(claim?.payload?.statement).toBe(
      "Revenue doubled quarterly after launch"
    );

    expect(invented?.grounded).toBe(false);
    expect(invented?.classification).toBeNull();
  });
});

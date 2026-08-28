import { describe, expect, it } from "vitest";
import {
  buildSegmentRows,
  checkPartition,
  snapCutIndex,
} from "../lib/intelligence/segments";
import type { TranscriptWord } from "../lib/transcription/types";

// The segment plan's deterministic gauntlet: cut-point snapping, the
// tiling-by-construction slot builder, gap synthesis, anchor grounding,
// and the observability flags. Coverage is the product — these bounds are
// what a whole clips channel would render.

function makeWords(
  sentences: { gapMs?: number; speaker?: string | null; words: string[] }[]
): TranscriptWord[] {
  const out: TranscriptWord[] = [];
  let cursor = 0;
  for (const sentence of sentences) {
    cursor += sentence.gapMs ?? 200;
    for (const text of sentence.words) {
      out.push({
        confidence: 0.95,
        endMs: cursor + 250,
        speaker: sentence.speaker === undefined ? "0" : sentence.speaker,
        startMs: cursor,
        text,
      });
      cursor += 300;
    }
  }
  return out;
}

const THREE_SENTENCES = makeWords([
  { speaker: "1", words: ["One", "two", "three."] },
  { speaker: "0", words: ["Four", "five", "six."] },
  { speaker: "0", words: ["Seven", "eight", "nine."] },
]);
const DURATION = (THREE_SENTENCES.at(-1)?.endMs ?? 0) + 200;

const keepItem = (
  startMs: number,
  endMs: number,
  anchorText: string | null,
  title = "A chapter"
) => ({
  anchorText,
  dropReason: null,
  endMs,
  hook: "A hook.",
  kind: "keep" as const,
  startMs,
  summary: "A summary.",
  title,
});
const dropItem = (startMs: number, endMs: number) => ({
  anchorText: null,
  dropReason: "low_energy" as const,
  endMs,
  hook: null,
  kind: "drop" as const,
  startMs,
  summary: null,
  title: null,
});

describe("snapCutIndex", () => {
  it("prefers the nearest sentence start", () => {
    const nearSecond = THREE_SENTENCES[3].startMs + 120;
    expect(snapCutIndex(THREE_SENTENCES, nearSecond)).toBe(3);
  });

  it("falls back to the nearest word when no grid point is in reach", () => {
    const longRun = makeWords([
      { words: Array.from({ length: 80 }, (_, i) => `w${i}`) },
    ]);
    const mid = longRun[40].startMs;
    expect(snapCutIndex(longRun, mid)).toBe(40);
  });
});

describe("buildSegmentRows", () => {
  const s2Start = THREE_SENTENCES[3].startMs;
  const s2End = THREE_SENTENCES[5].endMs;
  const s3Start = THREE_SENTENCES[6].startMs;
  const lastEnd = THREE_SENTENCES[8].endMs;

  it("tiles the whole timeline and grounds keep anchors", () => {
    const rows = buildSegmentRows(
      [
        keepItem(0, s2End - 300, "One two three"),
        dropItem(s2Start, s2End),
        keepItem(s3Start, lastEnd, "Seven eight nine"),
      ],
      THREE_SENTENCES,
      DURATION,
      []
    );
    expect(rows.map((row) => row.kind)).toEqual(["keep", "drop", "keep"]);
    expect(rows.map((row) => row.idx)).toEqual([0, 1, 2]);
    expect(rows[0]?.startMs).toBe(THREE_SENTENCES[0].startMs);
    expect(rows.at(-1)?.endMs).toBe(lastEnd);
    expect(rows.every((row) => row.grounded)).toBe(true);
    expect(rows[1]?.dropReason).toBe("low_energy");
    expect(checkPartition(rows, THREE_SENTENCES).ok).toBe(true);

    const again = buildSegmentRows(
      [
        keepItem(0, s2End - 300, "One two three"),
        dropItem(s2Start, s2End),
        keepItem(s3Start, lastEnd, "Seven eight nine"),
      ],
      THREE_SENTENCES,
      DURATION,
      []
    );
    expect(again).toEqual(rows);
  });

  it("synthesizes a drop for a leading uncovered stretch", () => {
    const rows = buildSegmentRows(
      [keepItem(s2Start, lastEnd, "Four five six")],
      THREE_SENTENCES,
      DURATION,
      []
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.kind).toBe("drop");
    expect(rows[0]?.flags).toContain("gap_fill");
    expect(rows[0]?.dropReason).toBe("other");
    expect(rows[1]?.kind).toBe("keep");
    expect(checkPartition(rows, THREE_SENTENCES).ok).toBe(true);
  });

  it("merges proposals whose cuts collapse, preferring the keep", () => {
    const rows = buildSegmentRows(
      [
        dropItem(0, s2Start),
        // Both of these snap their cut to the same sentence start.
        keepItem(s2Start, s2End, "Four five six"),
        keepItem(s2Start + 60, lastEnd, "Seven eight nine", "Rival claim"),
      ],
      THREE_SENTENCES,
      DURATION,
      []
    );
    const merged = rows.find((row) => row.flags.includes("merged_neighbor"));
    expect(merged).toBeDefined();
    expect(merged?.kind).toBe("keep");
    expect(checkPartition(rows, THREE_SENTENCES).ok).toBe(true);
  });

  it("marks keeps without an anchor as ungrounded, never dropping them", () => {
    const rows = buildSegmentRows(
      [
        keepItem(0, s2End, null),
        keepItem(s3Start, lastEnd, "Seven eight nine"),
      ],
      THREE_SENTENCES,
      DURATION,
      []
    );
    expect(rows[0]?.kind).toBe("keep");
    expect(rows[0]?.grounded).toBe(false);
    expect(rows[0]?.flags).toContain("no_anchor");
    expect(rows[1]?.grounded).toBe(true);
  });

  it("flags relative duration outliers instead of enforcing lengths", () => {
    const words = makeWords([
      { words: [...Array.from({ length: 39 }, (_, i) => `a${i}`), "long."] },
      { words: ["Short", "beat", "one."] },
      { words: ["Short", "beat", "two."] },
      { words: ["Short", "beat", "three."] },
    ]);
    const starts = [0, 40, 43, 46].map((i) => words[i].startMs);
    const ends = [39, 42, 45, 48].map((i) => words[i].endMs);
    const rows = buildSegmentRows(
      [
        keepItem(starts[0], ends[0], "long."),
        keepItem(starts[1], ends[1], "Short beat one."),
        keepItem(starts[2], ends[2], "Short beat two."),
        keepItem(starts[3], ends[3], "Short beat three."),
      ],
      words,
      (words.at(-1)?.endMs ?? 0) + 100,
      []
    );
    expect(rows[0]?.flags).toContain("long_outlier");
    expect(
      rows.slice(1).every((row) => !row.flags.includes("long_outlier"))
    ).toBe(true);
    // Flags are observability: the outlier is still a keep.
    expect(rows[0]?.kind).toBe("keep");
  });

  it("merges a trailing proposal whose cut lands at the final word's end", () => {
    // The staging shape (Brett Lee, 2026-08-26): Deepgram rounds
    // sub-centisecond words to equal start/end ms, and the model's last
    // proposal cut exactly at the final word's end — the tail slot spanned
    // zero time and rendered as a "57:58–57:58" drop row with nothing to
    // review. The vacuous proposal must merge into its neighbor instead.
    const tailMs = lastEnd + 400;
    const words: TranscriptWord[] = [
      ...THREE_SENTENCES,
      {
        confidence: 0.95,
        endMs: tailMs,
        speaker: "0",
        startMs: tailMs,
        text: "Bye.",
      },
    ];
    const rows = buildSegmentRows(
      [
        keepItem(0, s2End, "One two three"),
        dropItem(s3Start, tailMs),
        dropItem(tailMs, tailMs),
      ],
      words,
      tailMs + 200,
      []
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.endMs > row.startMs)).toBe(true);
    expect(rows.at(-1)?.kind).toBe("drop");
    expect(rows.at(-1)?.flags).toContain("merged_neighbor");
    // The zero-duration word still ends the plan — tiling holds.
    expect(rows.at(-1)?.endMs).toBe(tailMs);
    expect(checkPartition(rows, words).ok).toBe(true);
  });

  it("folds zero-duration lead-in words into the first slot", () => {
    const words: TranscriptWord[] = [
      { confidence: 0.95, endMs: 150, speaker: "0", startMs: 150, text: "Uh." },
      ...THREE_SENTENCES,
    ];
    const rows = buildSegmentRows(
      [keepItem(THREE_SENTENCES[0].startMs, lastEnd, "One two three")],
      words,
      DURATION,
      []
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("keep");
    expect(rows[0]?.flags).not.toContain("gap_fill");
    expect(rows.every((row) => row.endMs > row.startMs)).toBe(true);
    // The plan still starts at the first word — tiling holds.
    expect(rows[0]?.startMs).toBe(150);
    expect(checkPartition(rows, words).ok).toBe(true);
  });

  it("flags the twice-told story on both tellings via chunk vectors", () => {
    const rows = buildSegmentRows(
      [
        keepItem(0, s2End, "One two three"),
        keepItem(s3Start, lastEnd, "Seven eight nine"),
      ],
      THREE_SENTENCES,
      DURATION,
      [
        { embedding: [1, 0, 0], endMs: s2End, startMs: 0 },
        { embedding: [0.99, 0.05, 0], endMs: lastEnd, startMs: s3Start },
      ]
    );
    expect(rows[0]?.flags).toContain("twice_told");
    expect(rows[1]?.flags).toContain("twice_told");
    expect(rows.every((row) => row.kind === "keep")).toBe(true);
  });
});

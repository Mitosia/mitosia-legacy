import { describe, expect, it } from "vitest";
import { ingestStepProgressLabel } from "../lib/ingest-labels";
import { parseProgressSeconds } from "../lib/media/ffmpeg";

// The ladder is the one step long enough that silence reads as a hang: a 2h
// source spends ~30 minutes in it, and with nothing reported the badge sat
// on "Preparing playback" while `updated_at` never moved — a healthy ingest
// was indistinguishable from a dead one, and got reported as stuck.
//
// The parser is the fragile half (it reads a text protocol from ffmpeg), so
// it is pinned here rather than only exercised through a 30-minute run.

// One whole block, exactly as `-progress pipe:1` writes it.
const BLOCK = `frame=1234
fps=30.02
stream_0_0_q=20.0
bitrate=2328.4kbits/s
total_size=12345678
out_time_us=42000000
out_time_ms=42000000
out_time=00:00:42.000000
dup_frames=0
drop_frames=0
speed=1.04x
progress=continue
`;

describe("ffmpeg progress parsing", () => {
  it("reads the output position from a progress block", () => {
    expect(parseProgressSeconds(BLOCK)).toBeCloseTo(42, 3);
  });

  it("takes the newest position when a chunk carries several blocks", () => {
    const two = `${BLOCK}${BLOCK.replace("out_time_us=42000000", "out_time_us=96500000")}`;
    expect(parseProgressSeconds(two)).toBeCloseTo(96.5, 3);
  });

  it("ignores out_time_ms, which is microseconds despite the name", () => {
    // ffmpeg's out_time_ms is a long-standing misnomer — same value as
    // out_time_us. Matching it as milliseconds would report 1000x fast.
    expect(parseProgressSeconds("out_time_ms=42000000\n")).toBeNull();
  });

  it("returns null for a chunk with no complete position line", () => {
    expect(parseProgressSeconds("frame=1\nfps=30\nout_time_us=")).toBeNull();
  });
});

describe("progress labels", () => {
  it("adds a percentage when the step reports one", () => {
    expect(ingestStepProgressLabel("hls", 0.42)).toBe("Preparing playback 42%");
  });

  it("leaves quick steps as a plain label", () => {
    expect(ingestStepProgressLabel("probe", null)).toBe("Checking recording");
  });

  it("never shows more than 100%", () => {
    // ffmpeg can report a position slightly past the duration on its final
    // flush; a badge reading 103% is worse than one that stops at 100.
    expect(ingestStepProgressLabel("hls", 1.03)).toBe(
      "Preparing playback 100%"
    );
  });

  it("survives a nonsense value rather than rendering NaN", () => {
    expect(ingestStepProgressLabel("hls", Number.NaN)).toBe(
      "Preparing playback"
    );
  });
});

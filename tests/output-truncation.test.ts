import { describe, expect, it } from "vitest";
import { inputArgs } from "../lib/media/ffmpeg";
import { buildHlsArgs } from "../lib/media/hls";
import {
  assertCoversDuration,
  durationTolerance,
  sumPlaylistSeconds,
  TruncatedOutputError,
} from "../lib/media/verify";

// Regression guards for the silent truncation found by the S2 exit test: a
// 2h source produced HLS covering 4189s of 7200s (58.2%), on every rung, and
// the pipeline marked it "ready" with no error. Two independent causes had to
// line up — ffmpeg treating a dropped HTTP read as EOF and exiting 0, and
// nothing comparing output duration against the probed duration.
//
// Both halves are guarded here because either one alone still ships corrupt
// media: reconnect flags reduce the odds, the duration check makes a miss
// loud instead of invisible.

// Both durations must appear in the message — the stored ingest_error is
// the only diagnostic a user or an on-call reader gets.
const DIAGNOSABLE_MESSAGE = /4189\.0s of a 7200\.0s source \(58\.2%\)/;

const PLAYLIST = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:6.000000,
seg00000.ts
#EXTINF:6.000000,
seg00001.ts
#EXTINF:3.500000,
seg00002.ts
#EXT-X-ENDLIST
`;

describe("playlist duration", () => {
  it("sums EXTINF durations, ignoring tags and segment paths", () => {
    expect(sumPlaylistSeconds(PLAYLIST)).toBeCloseTo(15.5, 3);
  });

  it("returns zero for a playlist with no segments", () => {
    expect(sumPlaylistSeconds("#EXTM3U\n#EXT-X-VERSION:3\n")).toBe(0);
  });
});

describe("truncation detection", () => {
  it("rejects the exact failure the exit test produced", () => {
    expect(() => assertCoversDuration("HLS variant v0", 4189, 7200)).toThrow(
      TruncatedOutputError
    );
  });

  it("names both durations so the stored error is diagnosable", () => {
    expect(() => assertCoversDuration("HLS variant v0", 4189, 7200)).toThrow(
      DIAGNOSABLE_MESSAGE
    );
  });

  it("accepts output that matches the source", () => {
    expect(() =>
      assertCoversDuration("HLS variant v0", 7200, 7200)
    ).not.toThrow();
  });

  it("tolerates a stream ending slightly before the container duration", () => {
    // Real sources do this (VFR, a video track shorter than the container).
    expect(() =>
      assertCoversDuration("HLS variant v0", 7195, 7200)
    ).not.toThrow();
  });

  it("keeps a floor so short sources are not judged by percentage alone", () => {
    expect(durationTolerance(10)).toBe(12);
    expect(durationTolerance(7200)).toBe(72);
  });

  it("ignores sources whose duration is unknown", () => {
    expect(() => assertCoversDuration("HLS variant v0", 0, 0)).not.toThrow();
  });
});

describe("remote input args", () => {
  it("reconnects on a disconnect before EOF — the truncation cause", () => {
    const args = inputArgs("https://storage.example/source.mp4?sig=abc");
    expect(args).toContain("-reconnect");
    expect(args.slice(-2)).toEqual([
      "-i",
      "https://storage.example/source.mp4?sig=abc",
    ]);
  });

  it("puts reconnect flags before -i, or ffmpeg ignores them", () => {
    const args = inputArgs("https://storage.example/source.mp4");
    expect(args.indexOf("-reconnect")).toBeLessThan(args.indexOf("-i"));
  });

  it("leaves local paths alone", () => {
    expect(inputArgs("/tmp/work/audio.m4a")).toEqual([
      "-i",
      "/tmp/work/audio.m4a",
    ]);
  });

  it("applies to the HLS ladder, the longest-running read", () => {
    const args = buildHlsArgs(
      "https://storage.example/source.mp4",
      [{ dirName: "v0", height: 1080, kind: "video", width: 1920 }],
      true,
      "/tmp/out"
    );
    expect(args.indexOf("-reconnect")).toBeLessThan(args.indexOf("-i"));
  });
});

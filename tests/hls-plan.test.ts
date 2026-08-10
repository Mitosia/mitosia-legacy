import { describe, expect, it } from "vitest";
import {
  buildHlsArgs,
  planHlsLadder,
  renderMasterPlaylist,
} from "../lib/media/hls";
import type { SourceProbe } from "../lib/media/probe";
import { thumbnailIntervalSeconds } from "../lib/media/thumbs";

function videoProbe(width: number, height: number): SourceProbe {
  return {
    audio: { channels: 2, codec: "aac", sampleRate: 48_000 },
    durationSeconds: 7200,
    video: { codec: "h264", fps: 30, height, vfr: false, width },
  };
}

describe("planHlsLadder", () => {
  it("gives a 1080p source the full proxy ladder", () => {
    const plan = planHlsLadder(videoProbe(1920, 1080));
    expect(plan).toEqual([
      { dirName: "v0", height: 720, kind: "video", width: 1280 },
      { dirName: "v1", height: 360, kind: "video", width: 640 },
    ]);
  });

  it("drops rungs above the source height", () => {
    const plan = planHlsLadder(videoProbe(854, 480));
    expect(plan).toEqual([
      { dirName: "v0", height: 360, kind: "video", width: 640 },
    ]);
  });

  it("falls back to source height for tiny videos", () => {
    const plan = planHlsLadder(videoProbe(320, 240));
    expect(plan).toEqual([
      { dirName: "v0", height: 240, kind: "video", width: 320 },
    ]);
  });

  it("rounds odd source heights down to even", () => {
    const plan = planHlsLadder(videoProbe(400, 301));
    expect(plan[0]?.height).toBe(300);
  });

  it("gives audio-only sources an audio HLS variant", () => {
    const probe: SourceProbe = {
      audio: { channels: 1, codec: "mp3", sampleRate: 44_100 },
      durationSeconds: 3600,
    };
    expect(planHlsLadder(probe)).toEqual([{ dirName: "v0", kind: "audio" }]);
  });
});

describe("buildHlsArgs", () => {
  it("encodes every variant in one invocation with keyframe alignment", () => {
    const plan = planHlsLadder(videoProbe(1920, 1080));
    const args = buildHlsArgs("http://input", plan, true, "/tmp/out");
    const joined = args.join(" ");

    expect(joined).toContain("scale=-2:720");
    expect(joined).toContain("scale=-2:360");
    expect(joined).toContain("/tmp/out/v0/index.m3u8");
    expect(joined).toContain("/tmp/out/v1/seg%05d.ts");
    expect(joined).toContain("force_key_frames");
    // Audio mapped into both variants
    expect(args.filter((arg) => arg === "0:a:0")).toHaveLength(2);
  });

  it("omits audio mapping for silent sources", () => {
    const probe = videoProbe(1920, 1080);
    probe.audio = undefined;
    const plan = planHlsLadder(probe);
    const args = buildHlsArgs("http://input", plan, false, "/tmp/out");
    expect(args).not.toContain("0:a:0");
  });
});

describe("renderMasterPlaylist", () => {
  it("renders stream entries with bandwidth and resolution", () => {
    const playlist = renderMasterPlaylist([
      {
        bandwidth: 2_800_000.4,
        height: 720,
        path: "v0/index.m3u8",
        width: 1280,
      },
      { bandwidth: 800_000, height: 360, path: "v1/index.m3u8", width: 640 },
    ]);

    expect(playlist).toBe(
      [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        "#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720",
        "v0/index.m3u8",
        "#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360",
        "v1/index.m3u8",
        "",
      ].join("\n")
    );
  });

  it("omits resolution for audio-only variants", () => {
    const playlist = renderMasterPlaylist([
      { bandwidth: 128_000, path: "v0/index.m3u8" },
    ]);
    expect(playlist).toContain("#EXT-X-STREAM-INF:BANDWIDTH=128000\n");
    expect(playlist).not.toContain("RESOLUTION");
  });
});

describe("thumbnailIntervalSeconds", () => {
  it("uses the floor interval for short sources", () => {
    expect(thumbnailIntervalSeconds(60)).toBe(10);
  });

  it("caps a two-hour source at ~120 thumbnails", () => {
    expect(thumbnailIntervalSeconds(7200)).toBe(60);
  });

  it("stretches the interval for very long sources", () => {
    expect(thumbnailIntervalSeconds(36_000)).toBe(300);
  });
});

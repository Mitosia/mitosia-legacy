import { describe, expect, it } from "vitest";
import {
  buildHlsArgs,
  planHlsLadder,
  renderMasterPlaylist,
} from "../lib/media/hls";
import type { SourceProbe } from "../lib/media/probe";
import { thumbnailIntervalSeconds } from "../lib/media/thumbs";

function videoProbe(width: number, height: number, fps = 30): SourceProbe {
  return {
    audio: { channels: 2, codec: "aac", sampleRate: 48_000 },
    durationSeconds: 7200,
    video: { codec: "h264", fps, height, vfr: false, width },
  };
}

describe("planHlsLadder", () => {
  it("gives a 1080p source a native top rung plus proxy rungs", () => {
    const plan = planHlsLadder(videoProbe(1920, 1080));
    expect(plan).toEqual([
      {
        crf: 20,
        dirName: "v0",
        height: 1080,
        kind: "video",
        maxrateK: 6000,
        preset: "fast",
        width: 1920,
      },
      {
        crf: 22,
        dirName: "v1",
        height: 720,
        kind: "video",
        maxrateK: 3000,
        preset: "veryfast",
        width: 1280,
      },
      {
        crf: 23,
        dirName: "v2",
        height: 360,
        kind: "video",
        maxrateK: 900,
        preset: "veryfast",
        width: 640,
      },
    ]);
  });

  it("caps the top rung at 1080p for 4K sources", () => {
    const plan = planHlsLadder(videoProbe(3840, 2160));
    expect(plan[0]).toMatchObject({ height: 1080, maxrateK: 6000 });
    expect(plan).toHaveLength(3);
  });

  it("gives a 720p source a quality top rung at native height", () => {
    const plan = planHlsLadder(videoProbe(1280, 720));
    expect(plan).toEqual([
      {
        crf: 20,
        dirName: "v0",
        height: 720,
        kind: "video",
        maxrateK: 4500,
        preset: "fast",
        width: 1280,
      },
      {
        crf: 23,
        dirName: "v1",
        height: 360,
        kind: "video",
        maxrateK: 900,
        preset: "veryfast",
        width: 640,
      },
    ]);
  });

  it("gives a 480p source a top rung with the 480-class cap", () => {
    const plan = planHlsLadder(videoProbe(854, 480));
    expect(plan[0]).toMatchObject({
      crf: 20,
      height: 480,
      maxrateK: 2000,
      preset: "fast",
    });
    expect(plan[1]).toMatchObject({ height: 360 });
  });

  it("small sources get a single native-quality rung", () => {
    const plan = planHlsLadder(videoProbe(320, 240));
    expect(plan).toEqual([
      {
        crf: 20,
        dirName: "v0",
        height: 240,
        kind: "video",
        maxrateK: 1200,
        preset: "fast",
        width: 320,
      },
    ]);
  });

  it("rounds odd source heights down to even", () => {
    const plan = planHlsLadder(videoProbe(400, 301));
    expect(plan[0]?.height).toBe(300);
  });

  it("scales bitrate caps up for high-fps sources", () => {
    const plan = planHlsLadder(videoProbe(1920, 1080, 60));
    expect(plan[0]?.maxrateK).toBe(9000);
    expect(plan[1]?.maxrateK).toBe(4500);
    expect(plan[2]?.maxrateK).toBe(1350);
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
  it("encodes every variant with capped CRF and 2s keyframes", () => {
    const plan = planHlsLadder(videoProbe(1920, 1080));
    const args = buildHlsArgs("http://input", plan, true, "/tmp/out");
    const joined = args.join(" ");

    expect(joined).toContain("scale=-2:1080");
    expect(joined).toContain("scale=-2:720");
    expect(joined).toContain("scale=-2:360");
    expect(joined).toContain(
      "-preset fast -crf 20 -maxrate 6000k -bufsize 12000k"
    );
    expect(joined).toContain(
      "-preset veryfast -crf 22 -maxrate 3000k -bufsize 6000k"
    );
    expect(joined).toContain(
      "-preset veryfast -crf 23 -maxrate 900k -bufsize 1800k"
    );
    // Apple authoring spec: High profile, keyframe every 2 seconds
    expect(joined).toContain("-profile:v high");
    expect(joined).toContain("expr:gte(t,n_forced*2)");
    expect(joined).toContain("/tmp/out/v0/index.m3u8");
    expect(joined).toContain("/tmp/out/v2/seg%05d.ts");
    // Audio mapped into all three variants
    expect(args.filter((arg) => arg === "0:a:0")).toHaveLength(3);
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
  it("renders stream entries with bandwidth and resolution, top first", () => {
    const playlist = renderMasterPlaylist([
      {
        bandwidth: 5_200_000.4,
        height: 1080,
        path: "v0/index.m3u8",
        width: 1920,
      },
      { bandwidth: 800_000, height: 360, path: "v1/index.m3u8", width: 640 },
    ]);

    expect(playlist).toBe(
      [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        "#EXT-X-STREAM-INF:BANDWIDTH=5200000,RESOLUTION=1920x1080",
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

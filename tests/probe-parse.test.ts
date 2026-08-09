import { describe, expect, it } from "vitest";
import { ProbeError, parseFfprobeJson } from "../lib/media/probe";

const CORRUPT_MESSAGE = /corrupt/i;
const DURATION_MESSAGE = /duration/i;
const UNREADABLE_MESSAGE = /unreadable/i;

const VIDEO_WITH_AUDIO = JSON.stringify({
  format: {
    bit_rate: "5000000",
    duration: "7200.5",
    format_name: "mov,mp4,m4a,3gp,3g2,mj2",
    size: "2147483648",
  },
  streams: [
    {
      avg_frame_rate: "30000/1001",
      codec_name: "h264",
      codec_type: "video",
      height: 1080,
      r_frame_rate: "30000/1001",
      width: 1920,
    },
    {
      channels: 2,
      codec_name: "aac",
      codec_type: "audio",
      sample_rate: "48000",
    },
  ],
});

const AUDIO_ONLY = JSON.stringify({
  format: { duration: "3600", format_name: "mp3" },
  streams: [
    {
      channels: 1,
      codec_name: "mp3",
      codec_type: "audio",
      sample_rate: "44100",
    },
  ],
});

const VFR_VIDEO = JSON.stringify({
  format: { duration: "60" },
  streams: [
    {
      avg_frame_rate: "2997/100",
      codec_name: "h264",
      codec_type: "video",
      height: 720,
      r_frame_rate: "60/1",
      width: 1280,
    },
  ],
});

describe("parseFfprobeJson", () => {
  it("parses a two-hour video with audio", () => {
    const probe = parseFfprobeJson(VIDEO_WITH_AUDIO);

    expect(probe.durationSeconds).toBeCloseTo(7200.5);
    expect(probe.container).toContain("mp4");
    expect(probe.video).toMatchObject({
      codec: "h264",
      height: 1080,
      vfr: false,
      width: 1920,
    });
    expect(probe.video?.fps).toBeCloseTo(29.97, 2);
    expect(probe.audio).toEqual({
      channels: 2,
      codec: "aac",
      sampleRate: 48_000,
    });
  });

  it("parses audio-only sources (podcasts)", () => {
    const probe = parseFfprobeJson(AUDIO_ONLY);
    expect(probe.video).toBeUndefined();
    expect(probe.audio?.codec).toBe("mp3");
    expect(probe.durationSeconds).toBe(3600);
  });

  it("flags variable frame rate when real and average rates diverge", () => {
    const probe = parseFfprobeJson(VFR_VIDEO);
    expect(probe.video?.vfr).toBe(true);
  });

  it("rejects output with no decodable streams", () => {
    const empty = JSON.stringify({ format: { duration: "10" }, streams: [] });
    expect(() => parseFfprobeJson(empty)).toThrow(ProbeError);
    expect(() => parseFfprobeJson(empty)).toThrow(CORRUPT_MESSAGE);
  });

  it("rejects output with no determinable duration", () => {
    const noDuration = JSON.stringify({
      streams: [{ channels: 2, codec_name: "aac", codec_type: "audio" }],
    });
    expect(() => parseFfprobeJson(noDuration)).toThrow(DURATION_MESSAGE);
  });

  it("rejects unreadable output", () => {
    expect(() => parseFfprobeJson("not json at all")).toThrow(
      UNREADABLE_MESSAGE
    );
  });

  it("ignores mjpeg attached pictures when finding the video stream", () => {
    const coverArt = JSON.stringify({
      format: { duration: "100" },
      streams: [
        { codec_name: "mjpeg", codec_type: "video", height: 600, width: 600 },
        {
          channels: 2,
          codec_name: "aac",
          codec_type: "audio",
          sample_rate: "44100",
        },
      ],
    });
    const probe = parseFfprobeJson(coverArt);
    expect(probe.video).toBeUndefined();
    expect(probe.audio?.codec).toBe("aac");
  });
});

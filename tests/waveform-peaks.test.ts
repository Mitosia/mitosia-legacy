import { describe, expect, it } from "vitest";
import {
  computeSamplesPerPixel,
  PEAKS_SAMPLE_RATE,
  PEAKS_TARGET_WIDTH_PX,
  PeaksAccumulator,
  padPeaksToDuration,
} from "../lib/media/peaks";

function pcmBuffer(samples: number[]): Buffer {
  const buffer = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => {
    buffer.writeInt16LE(sample, index * 2);
  });
  return buffer;
}

describe("PeaksAccumulator", () => {
  it("emits min/max pairs scaled to 8-bit", () => {
    const accumulator = new PeaksAccumulator(4);
    accumulator.push(pcmBuffer([1000, -2000, 3000, -100]));
    const result = accumulator.finish();

    expect(result.length).toBe(1);
    expect(result.data).toEqual([
      Math.floor(-2000 / 256),
      Math.floor(3000 / 256),
    ]);
    expect(result.bits).toBe(8);
    expect(result.channels).toBe(1);
  });

  it("carries a dangling byte across chunk boundaries", () => {
    const whole = pcmBuffer([500, -500, 20_000, -20_000]);
    const accumulator = new PeaksAccumulator(4);
    // Split mid-sample: 3 bytes, then the rest.
    accumulator.push(whole.subarray(0, 3));
    accumulator.push(whole.subarray(3));
    const result = accumulator.finish();

    expect(result.data).toEqual([
      Math.floor(-20_000 / 256),
      Math.floor(20_000 / 256),
    ]);
  });

  it("flushes a partial trailing bucket", () => {
    const accumulator = new PeaksAccumulator(4);
    accumulator.push(pcmBuffer([0, 0, 0, 0, 12_800, -12_800]));
    const result = accumulator.finish();

    expect(result.length).toBe(2);
    expect(result.data).toEqual([0, 0, -50, 50]);
  });

  it("covers the full s16 range without overflow", () => {
    const accumulator = new PeaksAccumulator(2);
    accumulator.push(pcmBuffer([32_767, -32_768]));
    const result = accumulator.finish();

    expect(result.data).toEqual([-128, 127]);
  });

  it("produces the waveform-data v2 shape peaks.js expects", () => {
    const accumulator = new PeaksAccumulator();
    accumulator.push(pcmBuffer(Array.from({ length: 1000 }, (_, i) => i)));
    const result = accumulator.finish();

    expect(result.sample_rate).toBe(8000);
    expect(result.samples_per_pixel).toBe(400);
    expect(result.length).toBe(Math.ceil(1000 / 400));
    expect(result.data).toHaveLength(result.length * 2);
  });
});

describe("computeSamplesPerPixel", () => {
  it("targets a constant native pixel width across durations", () => {
    for (const seconds of [30, 104, 3600, 7200]) {
      const spp = computeSamplesPerPixel(seconds);
      const nativePx = (seconds * PEAKS_SAMPLE_RATE) / spp;
      expect(nativePx).toBeLessThanOrEqual(PEAKS_TARGET_WIDTH_PX);
      // Never degenerate: stays within ~2% of the target for real sources.
      expect(nativePx).toBeGreaterThan(PEAKS_TARGET_WIDTH_PX * 0.98);
    }
  });

  it("floors the bucket size for very short clips", () => {
    expect(computeSamplesPerPixel(0.5)).toBe(4);
  });
});

describe("padPeaksToDuration", () => {
  const base = {
    bits: 8 as const,
    channels: 1 as const,
    data: [-10, 12, -8, 9],
    length: 2,
    sample_rate: 8000,
    samples_per_pixel: 400,
  };

  it("pads shorter audio with silent buckets to the media duration", () => {
    // 2 buckets = 0.1s of audio inside a 0.3s media file.
    const padded = padPeaksToDuration(base, 0.3);
    expect(padded.length).toBe(6);
    expect(padded.data).toHaveLength(12);
    expect(padded.data.slice(0, 4)).toEqual(base.data);
    expect(padded.data.slice(4)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("keeps audio that already covers the media duration", () => {
    const untouched = padPeaksToDuration(base, 0.05);
    expect(untouched).toEqual(base);
  });
});

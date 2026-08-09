import { describe, expect, it } from "vitest";
import { PeaksAccumulator } from "../lib/media/peaks";

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

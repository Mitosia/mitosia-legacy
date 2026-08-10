import { describe, expect, it } from "vitest";
import { posterFilter, thumbnailStripFilter } from "../lib/media/thumbs";

// Regression guards for two ffmpeg 8 behaviors observed during S2, both of
// which look like harmless "cleanup" targets in the filter strings:
//
// 1. The mjpeg encoder refuses limited-range YUV ("Non full-range YUV is
//    non-standard") — every jpeg output needs format=yuvj420p or the
//    pipeline fails hard at the thumbnail step.
// 2. fps=1/N emits ZERO frames for sources shorter than N seconds unless
//    round=up is set — and it exits 0, so the thumbnails just silently
//    never exist.

describe("thumbnail filter pins", () => {
  it("poster filter forces full-range YUV for the mjpeg encoder", () => {
    expect(posterFilter()).toContain("format=yuvj420p");
  });

  it("strip filter forces full-range YUV for the mjpeg encoder", () => {
    expect(thumbnailStripFilter(60)).toContain("format=yuvj420p");
  });

  it("strip filter rounds up so short sources still get a thumbnail", () => {
    expect(thumbnailStripFilter(60)).toContain("fps=1/60:round=up");
  });
});

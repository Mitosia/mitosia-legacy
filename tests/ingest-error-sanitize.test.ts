import { describe, expect, it } from "vitest";
import { sanitizeIngestError } from "../lib/media/ingest-error";

// ingestError is stored verbatim from ffmpeg/ffprobe failures and rendered in
// the source page's failed card. ffmpeg echoes its input URL into stderr, so
// without sanitizing, a presigned storage URL — live signature included —
// would be persisted and shipped to the browser.

const PRESIGNED_FAILURE =
  "ffprobe exited with code 1: http://localhost:55490/mitosia-media/org/abc/client/def/source/ghi/original/broken.mp4" +
  "?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=mitosia%2F20260810%2Fauto%2Fs3%2Faws4_request" +
  "&X-Amz-Signature=353a209d4bbad47a6840450ad70cb2596&X-Amz-SignedHeaders=host&x-id=GetObject" +
  ": Invalid data found when processing input";

describe("sanitizeIngestError", () => {
  it("strips presigned query strings from embedded URLs", () => {
    const clean = sanitizeIngestError(PRESIGNED_FAILURE);
    expect(clean).not.toContain("X-Amz");
    expect(clean).not.toContain("?");
    expect(clean).toContain("ffprobe exited with code 1");
    expect(clean).toContain("/original/broken.mp4");
  });

  it("leaves prose question marks alone", () => {
    expect(sanitizeIngestError("Is the file readable? Retry the upload.")).toBe(
      "Is the file readable? Retry the upload."
    );
    expect(sanitizeIngestError("Unknown ingest failure")).toBe(
      "Unknown ingest failure"
    );
  });
});

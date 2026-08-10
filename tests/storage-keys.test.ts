import { describe, expect, it } from "vitest";

const ORIGINAL_KEY_MESSAGE = /original/i;

import {
  orgPrefix,
  sanitizeFilename,
  sourceOriginalKey,
  sourcePrefix,
  sourcePrefixFromOriginalKey,
} from "../lib/storage/keys";

const SCOPE = {
  clientId: "11111111-1111-1111-1111-111111111111",
  organizationId: "org_abc",
  sourceId: "22222222-2222-2222-2222-222222222222",
};

describe("sanitizeFilename", () => {
  it("keeps safe names intact", () => {
    expect(sanitizeFilename("podcast-042_final.mp4")).toBe(
      "podcast-042_final.mp4"
    );
  });

  it("replaces unsafe characters and preserves the extension", () => {
    expect(sanitizeFilename("Episode 42 — final (v2).MOV")).toBe(
      "Episode-42-final-v2.MOV"
    );
  });

  it("handles names without extension", () => {
    expect(sanitizeFilename("raw recording")).toBe("raw-recording");
  });

  it("never returns an empty base name", () => {
    expect(sanitizeFilename("★★★.mp4")).toBe("file.mp4");
  });

  it("caps very long base names", () => {
    const long = `${"a".repeat(500)}.mp4`;
    const result = sanitizeFilename(long);
    expect(result.length).toBeLessThanOrEqual(124);
    expect(result.endsWith(".mp4")).toBe(true);
  });
});

describe("source key scheme", () => {
  it("prefixes keys with org/client/source", () => {
    expect(sourceOriginalKey(SCOPE, "interview.mp4")).toBe(
      `org/org_abc/client/${SCOPE.clientId}/source/${SCOPE.sourceId}/original/interview.mp4`
    );
  });

  it("recovers the source prefix from an original key", () => {
    const key = sourceOriginalKey(SCOPE, "interview.mp4");
    expect(sourcePrefixFromOriginalKey(key)).toBe(sourcePrefix(SCOPE));
  });

  it("rejects keys that are not original keys", () => {
    expect(() =>
      sourcePrefixFromOriginalKey("org/org_abc/other/file.mp4")
    ).toThrow(ORIGINAL_KEY_MESSAGE);
  });

  it("org prefix is the isolation boundary used by media delivery", () => {
    const key = sourceOriginalKey(SCOPE, "interview.mp4");
    expect(key.startsWith(orgPrefix("org_abc"))).toBe(true);
    expect(key.startsWith(orgPrefix("org_other"))).toBe(false);
  });
});

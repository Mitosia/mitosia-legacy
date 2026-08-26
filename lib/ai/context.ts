import { createHash } from "node:crypto";

// Context assembly v1 (thesis §11): the pack is everything the capability
// is told beyond the transcript itself, assembled from the hierarchy and
// stored VERBATIM as a context_snapshot row so every generation records
// what it knew. v1 is deliberately small — org/client/brand/project names
// and source facts; brand voice/vocabulary packs arrive with S7 and extend
// this shape rather than replacing it.

export interface SourceContextPack {
  brand: { name: string } | null;
  client: { name: string } | null;
  kind:
    | "moment-discovery"
    | "segment-plan"
    | "source-analysis"
    | "source-extraction";
  organization: { name: string };
  project: { name: string } | null;
  source: {
    durationSeconds: number;
    language: string | null;
    originalFilename: string;
    speakerCount: number;
    title: string;
  };
  version: 1;
}

// Key-sorted serialization so the hash is stable across property order —
// two identical packs must dedupe to one hash.
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(val).sort()) {
        sorted[k] = (val as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return val;
  });
}

export function hashContextPack(pack: SourceContextPack): string {
  return createHash("sha256").update(canonicalJson(pack)).digest("hex");
}

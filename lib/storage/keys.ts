// Object-key scheme for tenant media. The org/{orgId}/ prefix is the
// storage-side isolation boundary: the media delivery route only serves
// keys under the caller's own org prefix, and future lifecycle rules
// (archive tiers, client offboarding) operate on these prefixes.

const UNSAFE_CHARS = /[^a-zA-Z0-9._-]+/g;
const MAX_BASENAME = 120;

export function sanitizeFilename(filename: string): string {
  const trimmed = filename.trim();
  const dot = trimmed.lastIndexOf(".");
  const base = (dot > 0 ? trimmed.slice(0, dot) : trimmed)
    .replace(UNSAFE_CHARS, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_BASENAME);
  const ext = dot > 0 ? trimmed.slice(dot + 1).replace(UNSAFE_CHARS, "") : "";

  const safeBase = base.length > 0 ? base : "file";
  return ext.length > 0 ? `${safeBase}.${ext}` : safeBase;
}

interface SourceKeyScope {
  clientId: string;
  organizationId: string;
  sourceId: string;
}

export function sourcePrefix(scope: SourceKeyScope): string {
  return `org/${scope.organizationId}/client/${scope.clientId}/source/${scope.sourceId}/`;
}

export function sourceOriginalKey(
  scope: SourceKeyScope,
  filename: string
): string {
  return `${sourcePrefix(scope)}original/${sanitizeFilename(filename)}`;
}

// Artifacts (HLS, thumbnails, audio, peaks) live beside the original.
// The prefix is recovered from the original's key so pipeline code needs
// no extra joins: .../source/{id}/original/{file} → .../source/{id}/
export function sourcePrefixFromOriginalKey(originalKey: string): string {
  const marker = originalKey.lastIndexOf("/original/");
  if (marker < 0) {
    throw new Error(`Not a source original key: ${originalKey}`);
  }
  return originalKey.slice(0, marker + 1);
}

export function orgPrefix(organizationId: string): string {
  return `org/${organizationId}/`;
}

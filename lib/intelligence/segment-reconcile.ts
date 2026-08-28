import type { RawSegmentItem } from "@/lib/ai/capabilities/segment-plan";

// The chapter Reconciler works over deterministic, ordered atoms rather than
// free-form timestamps. The rough Editor supplies those atoms; the Reconciler
// may only group adjacent atoms. That gives the model authority to remove a
// false boundary without giving it authority to reorder, omit, or invent
// material.

export const SEGMENT_PLAN_ARCHITECTURE_VERSION = 2;

export interface SegmentAtom extends RawSegmentItem {
  atomId: string;
}

export interface SegmentGrouping {
  atomIds: string[];
  dropReason: RawSegmentItem["dropReason"];
  hook: string | null;
  kind: RawSegmentItem["kind"];
  reasoning: string;
  summary: string | null;
  title: string | null;
}

export interface SegmentGroupingValidation {
  issues: string[];
  ok: boolean;
}

export interface SegmentGroupingContext {
  // When present, post-topology anchor lineage includes only atoms whose
  // purported verbatim anchors aligned inside their own source span. Anchor
  // availability never changes grouping validity or repairs topology.
  groundedAtomIds?: ReadonlySet<string>;
}

export interface AppliedSegmentGrouping {
  issues: string[];
  items: RawSegmentItem[];
  mergedBoundaries: number;
  status: "applied" | "fallback";
  tableOfContents: string[];
}

function atomId(index: number): string {
  return `A${String(index).padStart(3, "0")}`;
}

export function numberSegmentAtoms(
  items: readonly RawSegmentItem[]
): SegmentAtom[] {
  return [...items]
    .sort((left, right) => left.startMs - right.startMs)
    .map((item, index) => ({ ...item, atomId: atomId(index) }));
}

function populated(value: string | null): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function groupLabel(group: SegmentGrouping, index: number): string {
  return `group ${index} (${group.atomIds.join(", ") || "empty"})`;
}

function hasGroundedAnchor(
  atom: SegmentAtom,
  context: SegmentGroupingContext
): boolean {
  return (
    populated(atom.anchorText) &&
    (context.groundedAtomIds === undefined ||
      context.groundedAtomIds.has(atom.atomId))
  );
}

function validateKeepGroup(group: SegmentGrouping, index: number): string[] {
  const issues: string[] = [];
  const label = groupLabel(group, index);
  if (
    !(
      populated(group.title) &&
      populated(group.hook) &&
      populated(group.summary)
    )
  ) {
    issues.push(`keep ${label} has incomplete packaging`);
  }
  if (group.dropReason !== null) {
    issues.push(`keep ${label} carries a drop reason`);
  }
  return issues;
}

function validateDropGroup(
  group: SegmentGrouping,
  members: readonly SegmentAtom[],
  index: number
): string[] {
  const issues: string[] = [];
  const label = groupLabel(group, index);
  if (members.length !== 1) {
    issues.push(`drop ${label} must remain a singleton barrier`);
  }
  if (group.dropReason === null) {
    issues.push(`drop ${label} has no reason`);
  }
  if (group.dropReason !== members[0]?.dropReason) {
    issues.push(`drop ${label} changed its fixed reason`);
  }
  if (group.title !== null || group.hook !== null || group.summary !== null) {
    issues.push(`drop ${label} carries keep packaging`);
  }
  return issues;
}

function validateGroup(
  group: SegmentGrouping,
  index: number,
  byId: ReadonlyMap<string, SegmentAtom>
): string[] {
  if (group.atomIds.length === 0) {
    return [`group ${index} is empty`];
  }
  const members = group.atomIds
    .map((id) => byId.get(id))
    .filter((atom): atom is SegmentAtom => atom !== undefined);
  if (members.length !== group.atomIds.length) {
    return [`group ${index} references an unknown atom`];
  }
  const issues = members.some((atom) => atom.kind !== group.kind)
    ? [`group ${index} crosses a keep/drop boundary`]
    : [];
  return [
    ...issues,
    ...(group.kind === "keep"
      ? validateKeepGroup(group, index)
      : validateDropGroup(group, members, index)),
  ];
}

function sourceAnchorCandidates(
  members: readonly SegmentAtom[],
  context: SegmentGroupingContext
): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const member of members) {
    if (
      context.groundedAtomIds !== undefined &&
      !context.groundedAtomIds.has(member.atomId)
    ) {
      continue;
    }
    for (const candidate of [
      member.anchorText,
      ...(member.anchorCandidates ?? []),
    ]) {
      const normalized = candidate?.trim();
      if (normalized && !seen.has(normalized)) {
        seen.add(normalized);
        candidates.push(normalized);
      }
    }
  }
  return candidates;
}

export function validateSegmentGrouping(
  atoms: readonly SegmentAtom[],
  groups: readonly SegmentGrouping[],
  _context: SegmentGroupingContext = {}
): SegmentGroupingValidation {
  const issues: string[] = [];
  if (atoms.length === 0) {
    return groups.length === 0
      ? { issues, ok: true }
      : { issues: ["groups exist for an empty rough plan"], ok: false };
  }
  if (groups.length === 0) {
    return { issues: ["reconciler returned no groups"], ok: false };
  }

  const expectedIds = atoms.map((atom) => atom.atomId);
  const actualIds = groups.flatMap((group) => group.atomIds);
  if (
    actualIds.length !== expectedIds.length ||
    actualIds.some((id, index) => id !== expectedIds[index])
  ) {
    issues.push(
      "groups must cover every atom exactly once, contiguously, and in order"
    );
  }

  const byId = new Map(atoms.map((atom) => [atom.atomId, atom]));
  for (const [index, group] of groups.entries()) {
    issues.push(...validateGroup(group, index, byId));
  }

  return { issues, ok: issues.length === 0 };
}

function originalToc(atoms: readonly SegmentAtom[]): string[] {
  let keepIndex = 0;
  return atoms
    .filter((atom) => atom.kind === "keep")
    .map((atom) => {
      keepIndex += 1;
      return populated(atom.title)
        ? (atom.title as string)
        : `Untitled chapter ${keepIndex}`;
    });
}

export function applySegmentGrouping(
  atoms: readonly SegmentAtom[],
  groups: readonly SegmentGrouping[],
  context: SegmentGroupingContext = {}
): AppliedSegmentGrouping {
  const validation = validateSegmentGrouping(atoms, groups, context);
  if (!validation.ok) {
    return {
      issues: validation.issues,
      items: atoms.map(({ atomId: _atomId, ...item }) => item),
      mergedBoundaries: 0,
      status: "fallback",
      tableOfContents: originalToc(atoms),
    };
  }

  const byId = new Map(atoms.map((atom) => [atom.atomId, atom]));
  const items = groups.map((group): RawSegmentItem => {
    const members = group.atomIds.map((id) => {
      const atom = byId.get(id);
      if (!atom) {
        // validateSegmentGrouping proved this cannot happen. Keep the throw
        // as a tripwire if the validator and applicator ever drift apart.
        throw new Error(`Unknown reconciler atom ${id}`);
      }
      return atom;
    });
    const [first] = members;
    const last = members.at(-1);
    if (!(first && last)) {
      throw new Error("Validated segment group is unexpectedly empty");
    }
    const isKeep = group.kind === "keep";
    const anchorCandidates = isKeep
      ? sourceAnchorCandidates(members, context)
      : [];
    const groundedAnchor = members.find((member) =>
      hasGroundedAnchor(member, context)
    )?.anchorText;
    const anchorText = groundedAnchor ?? anchorCandidates[0] ?? null;
    return {
      ...(isKeep && anchorCandidates.length > 1 ? { anchorCandidates } : {}),
      anchorText: isKeep ? anchorText : null,
      dropReason: isKeep ? null : group.dropReason,
      endMs: last.endMs,
      hook: isKeep ? group.hook : null,
      kind: group.kind,
      startMs: first.startMs,
      summary: isKeep ? group.summary : null,
      title: isKeep ? group.title : null,
    };
  });

  return {
    issues: [],
    items,
    mergedBoundaries: atoms.length - groups.length,
    status: "applied",
    tableOfContents: items
      .filter((item) => item.kind === "keep")
      .map((item) => item.title as string),
  };
}

import type { RawSegmentItem } from "@/lib/ai/capabilities/segment-plan";
import type { SegmentDropReason } from "@/lib/db/schema/intelligence";
import type { CutGrid } from "./grid";
import type { SegmentRow } from "./segments";

// Architecture v3's trust boundary. The Publisher model may replace the
// draft partition, but it may only address transcript sentences and the
// deterministic source IDs minted here. This compiler either accepts the
// complete replacement or returns no items at all; it never applies a
// partially valid editorial plan.

export const PUBLISHER_REASON_CODES = [
  "unchanged",
  "merge_false_boundary",
  "split_transition",
  "move_boundary",
  "restore_setup",
  "preserve_payoff",
  "repackage",
  "drop_filler",
  "other",
] as const;

export type PublisherReasonCode = (typeof PUBLISHER_REASON_CODES)[number];

export interface PublisherPlanSlice {
  anchorText: string | null;
  dropReason: SegmentDropReason | null;
  endSentenceId: number;
  hook: string | null;
  kind: "drop" | "keep";
  reasonCode: PublisherReasonCode;
  reasoning: string;
  sourceIds: string[];
  startSentenceId: number;
  summary: string | null;
  title: string | null;
}

export interface PublisherDraftSegment extends SegmentRow {
  endSentenceId: number;
  id: string;
  startSentenceId: number;
}

export type PublisherPlanIssueCode =
  | "dropped_coverage"
  | "drop_packaging"
  | "duplicate_source"
  | "empty_draft"
  | "empty_grid"
  | "empty_keep_plan"
  | "empty_plan"
  | "invalid_draft_coverage"
  | "invalid_coverage"
  | "invalid_reasoning"
  | "invalid_sentence_id"
  | "inverted_range"
  | "keep_packaging"
  | "lineage_mismatch"
  | "missing_source"
  | "noncontiguous_lineage"
  | "partition_end"
  | "partition_gap"
  | "partition_overlap"
  | "partition_start"
  | "source_order"
  | "unknown_source";

export interface PublisherPlanIssue {
  code: PublisherPlanIssueCode;
  message: string;
  sliceIndex?: number;
  sourceId?: string;
}

export interface PublisherMergeOperation {
  outputIndex: number;
  sourceIds: [string, string];
  type: "merge";
}

export interface PublisherSplitOperation {
  outputIndexes: number[];
  sourceIds: [string];
  type: "split";
}

export interface PublisherMoveBoundaryOperation {
  fromSentenceId: number;
  leftSourceId: string;
  outputBoundaryIndex: number;
  rightSourceId: string;
  toSentenceId: number;
  type: "move_boundary";
}

export interface PublisherDispositionOperation {
  fromKinds: Array<"drop" | "keep">;
  outputIndex: number;
  sourceIds: string[];
  toKind: "drop" | "keep";
  type: "set_disposition";
}

export interface PublisherRepackageOperation {
  changedFields: Array<"anchorText" | "hook" | "summary" | "title">;
  outputIndex: number;
  sourceIds: string[];
  type: "repackage";
}

export type PublisherPlanOperation =
  | PublisherDispositionOperation
  | PublisherMergeOperation
  | PublisherMoveBoundaryOperation
  | PublisherRepackageOperation
  | PublisherSplitOperation;

export type PublisherOperationType = PublisherPlanOperation["type"];

export type PublisherPlanCounts = Record<PublisherOperationType, number>;

export interface NumberedPublisherDraft {
  issues: PublisherPlanIssue[];
  segments: PublisherDraftSegment[];
}

export interface PublisherCoverageRange {
  endSentenceId: number;
  id: string;
  label: string;
  startSentenceId: number;
}

export interface PublisherPlanCompileResult {
  counts: PublisherPlanCounts;
  issues: PublisherPlanIssue[];
  items: RawSegmentItem[];
  ok: boolean;
  operations: PublisherPlanOperation[];
  tableOfContents: string[];
}

function draftId(index: number): string {
  return `SEG${String(index).padStart(3, "0")}`;
}

function populated(value: string | null): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function emptyCounts(): PublisherPlanCounts {
  return {
    merge: 0,
    move_boundary: 0,
    repackage: 0,
    set_disposition: 0,
    split: 0,
  };
}

function rejected(issues: PublisherPlanIssue[]): PublisherPlanCompileResult {
  return {
    counts: emptyCounts(),
    issues,
    items: [],
    ok: false,
    operations: [],
    tableOfContents: [],
  };
}

function sentencesInsideRow(
  row: SegmentRow,
  grid: CutGrid
): typeof grid.sentences {
  return grid.sentences.filter(
    (sentence) => sentence.startMs >= row.startMs && sentence.endMs <= row.endMs
  );
}

// Rows are numbered by chronology rather than their persisted idx. That
// keeps IDs stable when callers pass database rows in an arbitrary order.
// Sentence ownership is also proved here: each sentence must belong to one
// and only one draft row before a model is allowed to rewrite that draft.
export function numberPublisherDraftSegments(
  rows: readonly SegmentRow[],
  grid: CutGrid
): NumberedPublisherDraft {
  const issues: PublisherPlanIssue[] = [];
  if (grid.sentences.length === 0) {
    issues.push({ code: "empty_grid", message: "the cut grid is empty" });
  }
  if (rows.length === 0) {
    issues.push({ code: "empty_draft", message: "the draft plan is empty" });
  }

  const sorted = [...rows].sort(
    (left, right) => left.startMs - right.startMs || left.endMs - right.endMs
  );
  const ownership = new Map<number, string[]>();
  const segments: PublisherDraftSegment[] = sorted.map((row, index) => {
    const id = draftId(index);
    const covered = sentencesInsideRow(row, grid);
    for (const sentence of covered) {
      const owners = ownership.get(sentence.id) ?? [];
      owners.push(id);
      ownership.set(sentence.id, owners);
    }
    if (covered.length === 0) {
      issues.push({
        code: "invalid_draft_coverage",
        message: `${id} does not contain a complete grid sentence`,
        sourceId: id,
      });
    }
    return {
      ...row,
      endSentenceId: covered.at(-1)?.id ?? -1,
      id,
      startSentenceId: covered[0]?.id ?? -1,
    };
  });

  for (const sentence of grid.sentences) {
    const owners = ownership.get(sentence.id) ?? [];
    if (owners.length !== 1) {
      issues.push({
        code: "invalid_draft_coverage",
        message:
          owners.length === 0
            ? `sentence ${sentence.id} is not covered by the draft`
            : `sentence ${sentence.id} is covered by multiple draft rows (${owners.join(", ")})`,
      });
    }
  }

  return { issues, segments };
}

export function validatePublisherKeepCoverage(
  segments: readonly PublisherDraftSegment[],
  grid: CutGrid,
  coverageRanges: readonly PublisherCoverageRange[]
): PublisherPlanIssue[] {
  const sentencePosition = new Map(
    grid.sentences.map((sentence, position) => [sentence.id, position])
  );
  return coverageRanges.flatMap((coverage): PublisherPlanIssue[] => {
    const coverageStart = sentencePosition.get(coverage.startSentenceId);
    const coverageEnd = sentencePosition.get(coverage.endSentenceId);
    if (
      coverageStart === undefined ||
      coverageEnd === undefined ||
      coverageStart > coverageEnd
    ) {
      return [
        {
          code: "invalid_coverage",
          message: `${coverage.id} (${coverage.label}) has an invalid sentence range`,
        },
      ];
    }
    const retained = segments.some((segment) => {
      if (segment.kind !== "keep") {
        return false;
      }
      const segmentStart = sentencePosition.get(segment.startSentenceId);
      const segmentEnd = sentencePosition.get(segment.endSentenceId);
      return (
        segmentStart !== undefined &&
        segmentEnd !== undefined &&
        segmentStart <= coverageEnd &&
        segmentEnd >= coverageStart
      );
    });
    return retained
      ? []
      : [
          {
            code: "dropped_coverage",
            message: `${coverage.id} (${coverage.label}) is wholly classified as DROP`,
          },
        ];
  });
}

interface ValidatedSlice {
  endPosition: number;
  slice: PublisherPlanSlice;
  sourceIndexes: number[];
  startPosition: number;
}

function validatePackaging(
  slice: PublisherPlanSlice,
  sliceIndex: number
): PublisherPlanIssue[] {
  if (!populated(slice.reasoning)) {
    return [
      {
        code: "invalid_reasoning",
        message: `slice ${sliceIndex} has no editorial reasoning`,
        sliceIndex,
      },
    ];
  }
  if (slice.kind === "keep") {
    if (
      !(
        populated(slice.anchorText) &&
        populated(slice.title) &&
        populated(slice.hook) &&
        populated(slice.summary) &&
        slice.dropReason === null
      )
    ) {
      return [
        {
          code: "keep_packaging",
          message: `keep slice ${sliceIndex} requires anchor, title, hook, and summary and cannot carry a drop reason`,
          sliceIndex,
        },
      ];
    }
    return [];
  }
  if (
    slice.anchorText !== null ||
    slice.title !== null ||
    slice.hook !== null ||
    slice.summary !== null ||
    slice.dropReason === null
  ) {
    return [
      {
        code: "drop_packaging",
        message: `drop slice ${sliceIndex} requires a drop reason and cannot carry keep packaging`,
        sliceIndex,
      },
    ];
  }
  return [];
}

function intersects(
  slice: ValidatedSlice,
  source: PublisherDraftSegment,
  sentencePosition: ReadonlyMap<number, number>
): boolean {
  const sourceStart = sentencePosition.get(source.startSentenceId);
  const sourceEnd = sentencePosition.get(source.endSentenceId);
  return (
    sourceStart !== undefined &&
    sourceEnd !== undefined &&
    slice.startPosition <= sourceEnd &&
    slice.endPosition >= sourceStart
  );
}

interface SliceValidationContext {
  claimedAt: Map<string, number[]>;
  draft: readonly PublisherDraftSegment[];
  sentencePosition: ReadonlyMap<number, number>;
  sourceIndex: ReadonlyMap<string, number>;
}

function validateSentenceRange(
  slice: PublisherPlanSlice,
  sliceIndex: number,
  sentencePosition: ReadonlyMap<number, number>
): {
  endPosition: number | undefined;
  issues: PublisherPlanIssue[];
  startPosition: number | undefined;
} {
  const issues: PublisherPlanIssue[] = [];
  const startPosition = sentencePosition.get(slice.startSentenceId);
  const endPosition = sentencePosition.get(slice.endSentenceId);
  if (
    !(Number.isInteger(slice.startSentenceId) && startPosition !== undefined)
  ) {
    issues.push({
      code: "invalid_sentence_id",
      message: `slice ${sliceIndex} has an unknown or noninteger start sentence ID`,
      sliceIndex,
    });
  }
  if (!(Number.isInteger(slice.endSentenceId) && endPosition !== undefined)) {
    issues.push({
      code: "invalid_sentence_id",
      message: `slice ${sliceIndex} has an unknown or noninteger end sentence ID`,
      sliceIndex,
    });
  }
  if (
    startPosition !== undefined &&
    endPosition !== undefined &&
    startPosition > endPosition
  ) {
    issues.push({
      code: "inverted_range",
      message: `slice ${sliceIndex} ends before it starts`,
      sliceIndex,
    });
  }
  return { endPosition, issues, startPosition };
}

function contiguousIndexes(indexes: readonly number[]): boolean {
  return indexes.every(
    (source, index) => index === 0 || source === (indexes[index - 1] ?? 0) + 1
  );
}

function validateLineageIds(
  slice: PublisherPlanSlice,
  sliceIndex: number,
  context: SliceValidationContext
): { indexes: number[]; issues: PublisherPlanIssue[] } {
  const issues: PublisherPlanIssue[] = [];
  if (slice.sourceIds.length === 0) {
    issues.push({
      code: "lineage_mismatch",
      message: `slice ${sliceIndex} has no source lineage`,
      sliceIndex,
    });
  }
  if (new Set(slice.sourceIds).size !== slice.sourceIds.length) {
    issues.push({
      code: "duplicate_source",
      message: `slice ${sliceIndex} repeats a source ID`,
      sliceIndex,
    });
  }

  const indexes: number[] = [];
  for (const id of slice.sourceIds) {
    const index = context.sourceIndex.get(id);
    if (index === undefined) {
      issues.push({
        code: "unknown_source",
        message: `slice ${sliceIndex} references unknown source ${id}`,
        sliceIndex,
        sourceId: id,
      });
      continue;
    }
    indexes.push(index);
    const appearances = context.claimedAt.get(id) ?? [];
    appearances.push(sliceIndex);
    context.claimedAt.set(id, appearances);
  }
  if (!contiguousIndexes(indexes)) {
    issues.push({
      code: "noncontiguous_lineage",
      message: `slice ${sliceIndex} source IDs must be unique, adjacent, and chronological`,
      sliceIndex,
    });
  }
  return { indexes, issues };
}

function validateOneSlice(
  slice: PublisherPlanSlice,
  sliceIndex: number,
  context: SliceValidationContext
): { candidate: ValidatedSlice | null; issues: PublisherPlanIssue[] } {
  const range = validateSentenceRange(
    slice,
    sliceIndex,
    context.sentencePosition
  );
  const lineage = validateLineageIds(slice, sliceIndex, context);
  const issues = [
    ...range.issues,
    ...validatePackaging(slice, sliceIndex),
    ...lineage.issues,
  ];
  if (range.startPosition === undefined || range.endPosition === undefined) {
    return { candidate: null, issues };
  }

  const candidate: ValidatedSlice = {
    endPosition: range.endPosition,
    slice,
    sourceIndexes: lineage.indexes,
    startPosition: range.startPosition,
  };
  const intersectedIndexes = context.draft.flatMap((source, index) =>
    intersects(candidate, source, context.sentencePosition) ? [index] : []
  );
  if (
    intersectedIndexes.length !== lineage.indexes.length ||
    intersectedIndexes.some(
      (index, position) => index !== lineage.indexes[position]
    )
  ) {
    issues.push({
      code: "lineage_mismatch",
      message: `slice ${sliceIndex} must claim all and only the draft sources its sentence range intersects`,
      sliceIndex,
    });
  }
  return { candidate, issues };
}

function validatePartition(
  slices: readonly PublisherPlanSlice[],
  valid: readonly ValidatedSlice[],
  grid: CutGrid
): PublisherPlanIssue[] {
  const issues: PublisherPlanIssue[] = [];
  const [firstSentence] = grid.sentences;
  const lastSentence = grid.sentences.at(-1);
  if (slices[0]?.startSentenceId !== firstSentence?.id) {
    issues.push({
      code: "partition_start",
      message: "publisher plan must start at the first grid sentence",
      sliceIndex: 0,
    });
  }
  if (slices.at(-1)?.endSentenceId !== lastSentence?.id) {
    issues.push({
      code: "partition_end",
      message: "publisher plan must end at the final grid sentence",
      sliceIndex: slices.length - 1,
    });
  }
  for (let index = 1; index < valid.length; index += 1) {
    const previous = valid[index - 1];
    const current = valid[index];
    if (!(previous && current)) {
      continue;
    }
    if (current.startPosition <= previous.endPosition) {
      issues.push({
        code: "partition_overlap",
        message: `slices ${index - 1} and ${index} overlap or are reordered`,
        sliceIndex: index,
      });
    } else if (current.startPosition !== previous.endPosition + 1) {
      issues.push({
        code: "partition_gap",
        message: `slices ${index - 1} and ${index} omit grid sentences`,
        sliceIndex: index,
      });
    }
  }
  return issues;
}

function validateSourceOrder(
  valid: readonly ValidatedSlice[]
): PublisherPlanIssue[] {
  const issues: PublisherPlanIssue[] = [];
  let previousMin = -1;
  let previousMax = -1;
  for (const [sliceIndex, candidate] of valid.entries()) {
    const [currentMin] = candidate.sourceIndexes;
    const currentMax = candidate.sourceIndexes.at(-1);
    if (currentMin === undefined || currentMax === undefined) {
      continue;
    }
    if (currentMin < previousMin || currentMax < previousMax) {
      issues.push({
        code: "source_order",
        message: `slice ${sliceIndex} moves source lineage backward`,
        sliceIndex,
      });
    }
    previousMin = currentMin;
    previousMax = currentMax;
  }
  return issues;
}

function validateSourceClaims(
  draft: readonly PublisherDraftSegment[],
  claimedAt: ReadonlyMap<string, number[]>
): PublisherPlanIssue[] {
  const issues: PublisherPlanIssue[] = [];
  for (const source of draft) {
    const appearances = claimedAt.get(source.id) ?? [];
    if (appearances.length === 0) {
      issues.push({
        code: "missing_source",
        message: `publisher plan does not claim source ${source.id}`,
        sourceId: source.id,
      });
    } else if (
      appearances.some(
        (sliceIndex, index) =>
          index > 0 && sliceIndex !== (appearances[index - 1] ?? 0) + 1
      )
    ) {
      issues.push({
        code: "source_order",
        message: `source ${source.id} is reused non-adjacently`,
        sourceId: source.id,
      });
    }
  }
  return issues;
}

function validateSlices(
  slices: readonly PublisherPlanSlice[],
  draft: readonly PublisherDraftSegment[],
  grid: CutGrid
): { issues: PublisherPlanIssue[]; valid: ValidatedSlice[] } {
  const issues: PublisherPlanIssue[] = [];
  const valid: ValidatedSlice[] = [];
  if (slices.length === 0) {
    return {
      issues: [{ code: "empty_plan", message: "publisher returned no slices" }],
      valid,
    };
  }
  if (!slices.some((slice) => slice.kind === "keep")) {
    issues.push({
      code: "empty_keep_plan",
      message: "publisher plan must retain at least one chapter",
    });
  }

  const sentencePosition = new Map(
    grid.sentences.map((sentence, position) => [sentence.id, position])
  );
  const sourceIndex = new Map(draft.map((source, index) => [source.id, index]));
  const claimedAt = new Map<string, number[]>();
  const context: SliceValidationContext = {
    claimedAt,
    draft,
    sentencePosition,
    sourceIndex,
  };

  for (const [sliceIndex, slice] of slices.entries()) {
    const result = validateOneSlice(slice, sliceIndex, context);
    issues.push(...result.issues);
    if (result.candidate) {
      valid.push(result.candidate);
    }
  }

  issues.push(...validatePartition(slices, valid, grid));
  issues.push(...validateSourceOrder(valid));
  issues.push(...validateSourceClaims(draft, claimedAt));

  return { issues, valid };
}

function sameString(left: string | null, right: string | null): boolean {
  return left?.trim() === right?.trim();
}

interface DraftBoundary {
  atSentenceId: number;
  leftSourceId: string;
  rightSourceId: string;
}

interface OutputBoundary {
  atSentenceId: number;
  index: number;
  sourceIds: Set<string>;
}

function listDraftBoundaries(
  draft: readonly PublisherDraftSegment[]
): DraftBoundary[] {
  return draft.slice(1).flatMap((right, index) => {
    const left = draft[index];
    return left
      ? [
          {
            atSentenceId: right.startSentenceId,
            leftSourceId: left.id,
            rightSourceId: right.id,
          },
        ]
      : [];
  });
}

function listOutputBoundaries(
  valid: readonly ValidatedSlice[]
): OutputBoundary[] {
  return valid.slice(1).flatMap((right, index) => {
    const left = valid[index];
    return left
      ? [
          {
            atSentenceId: right.slice.startSentenceId,
            index: index + 1,
            sourceIds: new Set([
              ...left.slice.sourceIds,
              ...right.slice.sourceIds,
            ]),
          },
        ]
      : [];
  });
}

function moveCandidate(
  output: OutputBoundary,
  removed: readonly DraftBoundary[],
  usedDraftBoundaries: ReadonlySet<number>
): DraftBoundary | null {
  const candidates = removed
    .filter(
      (boundary) =>
        !usedDraftBoundaries.has(boundary.atSentenceId) &&
        output.sourceIds.has(boundary.leftSourceId) &&
        output.sourceIds.has(boundary.rightSourceId)
    )
    .sort(
      (left, right) =>
        Math.abs(left.atSentenceId - output.atSentenceId) -
        Math.abs(right.atSentenceId - output.atSentenceId)
    );
  return candidates[0] ?? null;
}

function deriveTopologyOperations(
  valid: readonly ValidatedSlice[],
  draft: readonly PublisherDraftSegment[]
): PublisherPlanOperation[] {
  const operations: PublisherPlanOperation[] = [];
  const draftBoundaries = listDraftBoundaries(draft);
  const outputBoundaries = listOutputBoundaries(valid);
  const draftPositions = new Set(
    draftBoundaries.map((boundary) => boundary.atSentenceId)
  );
  const outputPositions = new Set(
    outputBoundaries.map((boundary) => boundary.atSentenceId)
  );
  const removed = draftBoundaries.filter(
    (boundary) => !outputPositions.has(boundary.atSentenceId)
  );
  const added = outputBoundaries.filter(
    (boundary) => !draftPositions.has(boundary.atSentenceId)
  );
  const movedDraftPositions = new Set<number>();
  const movedOutputIndexes = new Set<number>();

  for (const output of added) {
    const from = moveCandidate(output, removed, movedDraftPositions);
    if (!from) {
      continue;
    }
    movedDraftPositions.add(from.atSentenceId);
    movedOutputIndexes.add(output.index);
    operations.push({
      fromSentenceId: from.atSentenceId,
      leftSourceId: from.leftSourceId,
      outputBoundaryIndex: output.index,
      rightSourceId: from.rightSourceId,
      toSentenceId: output.atSentenceId,
      type: "move_boundary",
    });
  }

  for (const boundary of removed) {
    if (movedDraftPositions.has(boundary.atSentenceId)) {
      continue;
    }
    const outputIndex = valid.findIndex(
      (candidate) =>
        candidate.slice.sourceIds.includes(boundary.leftSourceId) &&
        candidate.slice.sourceIds.includes(boundary.rightSourceId)
    );
    if (outputIndex >= 0) {
      operations.push({
        outputIndex,
        sourceIds: [boundary.leftSourceId, boundary.rightSourceId],
        type: "merge",
      });
    }
  }

  const splitSources = new Set<string>();
  for (const boundary of added) {
    if (movedOutputIndexes.has(boundary.index)) {
      continue;
    }
    const left = valid[boundary.index - 1];
    const right = valid[boundary.index];
    if (!(left && right)) {
      continue;
    }
    for (const sourceId of left.slice.sourceIds) {
      if (right.slice.sourceIds.includes(sourceId)) {
        splitSources.add(sourceId);
      }
    }
  }
  for (const sourceId of splitSources) {
    const outputIndexes = valid.flatMap((candidate, outputIndex) =>
      candidate.slice.sourceIds.includes(sourceId) ? [outputIndex] : []
    );
    operations.push({
      outputIndexes,
      sourceIds: [sourceId],
      type: "split",
    });
  }
  return operations;
}

function deriveContentOperations(
  slices: readonly PublisherPlanSlice[],
  draft: readonly PublisherDraftSegment[]
): PublisherPlanOperation[] {
  const operations: PublisherPlanOperation[] = [];
  const byId = new Map(draft.map((source) => [source.id, source]));

  for (const [outputIndex, slice] of slices.entries()) {
    const sources = slice.sourceIds
      .map((id) => byId.get(id))
      .filter(
        (source): source is PublisherDraftSegment => source !== undefined
      );
    const changedKinds = [...new Set(sources.map((source) => source.kind))];
    if (changedKinds.some((kind) => kind !== slice.kind)) {
      operations.push({
        fromKinds: changedKinds,
        outputIndex,
        sourceIds: slice.sourceIds,
        toKind: slice.kind,
        type: "set_disposition",
      });
    }

    if (slice.kind !== "keep") {
      continue;
    }
    if (sources.length === 0) {
      continue;
    }
    const packageFields = ["anchorText", "hook", "summary", "title"] as const;
    // A boundary redistribution legitimately carries both adjacent source
    // IDs. Compare against the closest contributing package, not blindly
    // against the left source, or retaining the right chapter's packaging is
    // falsely audited as four rewrites.
    const [changedFields = []] = sources
      .map((source) =>
        packageFields.filter(
          (field) => !sameString(slice[field], source[field])
        )
      )
      .sort((left, right) => left.length - right.length);
    if (changedFields.length > 0) {
      operations.push({
        changedFields,
        outputIndex,
        sourceIds: slice.sourceIds,
        type: "repackage",
      });
    }
  }

  return operations;
}

function deriveOperations(
  slices: readonly PublisherPlanSlice[],
  valid: readonly ValidatedSlice[],
  draft: readonly PublisherDraftSegment[]
): PublisherPlanOperation[] {
  return [
    ...deriveTopologyOperations(valid, draft),
    ...deriveContentOperations(slices, draft),
  ];
}

export function compilePublisherPlan(
  draftRows: readonly SegmentRow[],
  grid: CutGrid,
  slices: readonly PublisherPlanSlice[]
): PublisherPlanCompileResult {
  const numbered = numberPublisherDraftSegments(draftRows, grid);
  if (numbered.issues.length > 0) {
    return rejected(numbered.issues);
  }
  const validation = validateSlices(slices, numbered.segments, grid);
  if (validation.issues.length > 0) {
    return rejected(validation.issues);
  }

  const sentenceById = new Map(
    grid.sentences.map((sentence) => [sentence.id, sentence])
  );
  const items = slices.map((slice): RawSegmentItem => {
    const start = sentenceById.get(slice.startSentenceId);
    const end = sentenceById.get(slice.endSentenceId);
    if (!(start && end)) {
      // validateSlices proves this cannot happen. Keep the exception as a
      // tripwire if validation and compilation ever drift apart.
      throw new Error(
        "Validated publisher slice references a missing sentence"
      );
    }
    const keep = slice.kind === "keep";
    return {
      anchorText: keep ? slice.anchorText : null,
      dropReason: keep ? null : slice.dropReason,
      endMs: end.endMs,
      hook: keep ? slice.hook : null,
      kind: slice.kind,
      startMs: start.startMs,
      summary: keep ? slice.summary : null,
      title: keep ? slice.title : null,
    };
  });
  const operations = deriveOperations(
    slices,
    validation.valid,
    numbered.segments
  );
  const counts = emptyCounts();
  for (const operation of operations) {
    counts[operation.type] += 1;
  }

  return {
    counts,
    issues: [],
    items,
    ok: true,
    operations,
    tableOfContents: items
      .filter((item) => item.kind === "keep")
      .map((item) => item.title as string),
  };
}

"""Deterministic eval scorers, ported from ``lib/ai/evals/scorers.ts``.

Pure functions, no model calls. Every branch, penalty multiplier, issue
string, and float operation order mirrors the TS original — the parity
snapshots compare scores AND issue strings byte-for-byte, so "close
enough" is not the bar here.
"""

import re
from collections.abc import Sequence

from clipper.evals.jsnum import to_fixed
from clipper.substrate.grid import (
    Word,
    pause_boundaries,
    sentence_end_times,
    sentence_start_times,
    speaker_turn_start_times,
)
from clipper.wire import WireModel


class ScoreReport(WireModel):
    issues: list[str]
    # 0..1 — thresholds live in the eval runner, not here
    score: float


class Chapter(WireModel):
    end_ms: int
    start_ms: int
    title: str


def score_chapters(chapters: Sequence[Chapter], duration_ms: int) -> ScoreReport:
    issues: list[str] = []
    if len(chapters) == 0:
        return ScoreReport(issues=["no chapters"], score=0)

    covered_ms = 0
    ordered = True
    for index, chapter in enumerate(chapters):
        covered_ms += chapter.end_ms - chapter.start_ms
        if index > 0 and chapter.start_ms < chapters[index - 1].end_ms:
            ordered = False
        if len(chapter.title.strip()) == 0:
            issues.append(f"chapter {index} has an empty title")
    coverage = min(covered_ms / duration_ms, 1)
    if coverage < 0.8:
        issues.append(f"chapters cover only {to_fixed(coverage * 100, 0)}%")
    if not ordered:
        issues.append("chapters overlap or are out of order")
    last_end = chapters[-1].end_ms if chapters else 0
    if last_end < duration_ms * 0.9:
        issues.append("last chapter ends well before the recording does")

    score = coverage
    if not ordered:
        score *= 0.5
    if any("empty title" in issue for issue in issues):
        score *= 0.8
    return ScoreReport(issues=issues, score=score)


class SpeakerSuggestion(WireModel):
    evidence: str
    merge_with: str | None
    speaker: str
    suggested_name: str | None


def score_speaker_suggestions(
    suggestions: Sequence[SpeakerSuggestion],
    transcript_speaker_ids: Sequence[str],
) -> ScoreReport:
    issues: list[str] = []
    known = set(transcript_speaker_ids)
    covered: set[str] = set()

    for suggestion in suggestions:
        covered.add(suggestion.speaker)
        if suggestion.speaker not in known:
            issues.append(f"suggestion for unknown speaker id {suggestion.speaker}")
        if suggestion.merge_with is not None and suggestion.merge_with not in known:
            issues.append(f"merge target {suggestion.merge_with} is not a speaker id")
        if suggestion.suggested_name and len(suggestion.evidence.strip()) == 0:
            issues.append(f"name for speaker {suggestion.speaker} carries no evidence")
    # TS iterates the Set built from the id array: insertion order, deduped.
    for known_id in dict.fromkeys(transcript_speaker_ids):
        if known_id not in covered:
            issues.append(f"speaker id {known_id} has no suggestion entry")

    score = 1.0 if len(known) == 0 else max(0, 1 - len(issues) / max(len(known), 1))
    return ScoreReport(issues=issues, score=score)


# TS: the sentence counter matches [.!?] followed by JS \s or end. JS \s is
# a fixed character class that differs from Python's at the margins (U+FEFF
# yes, x1c-x1f no), so spell it out as regex escapes.
_JS_WHITESPACE = (
    "\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a"
    "\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff"
)
_SENTENCE_END = re.compile(f"[.!?](?:[{_JS_WHITESPACE}]|$)")


def score_summary(summary: str) -> ScoreReport:
    issues: list[str] = []
    sentences = len(_SENTENCE_END.findall(summary))
    if len(summary.strip()) < 100:
        issues.append("summary is too short to be an executive summary")
    if sentences < 2:
        issues.append("summary has fewer than 2 sentences")
    if sentences > 10:
        issues.append("summary rambles past 10 sentences")
    if "#" in summary or "**" in summary:
        issues.append("summary contains markdown formatting")
    return ScoreReport(
        issues=issues, score=1 if len(issues) == 0 else 0.5 / len(issues)
    )


class ExtractionRow(WireModel):
    end_ms: int
    grounded: bool
    kind: str
    start_ms: int


def score_extractions(rows: Sequence[ExtractionRow], duration_ms: int) -> ScoreReport:
    issues: list[str] = []
    if len(rows) == 0:
        return ScoreReport(issues=["no extractions produced"], score=0)

    grounded = [row for row in rows if row.grounded]
    grounding_rate = len(grounded) / len(rows)
    if grounding_rate < 1:
        issues.append(
            f"{len(rows) - len(grounded)}/{len(rows)} items failed verbatim grounding"
        )

    ranges_valid = True
    for row in grounded:
        if row.end_ms <= row.start_ms or row.end_ms > duration_ms:
            ranges_valid = False
            issues.append(f"{row.kind} range {row.start_ms}-{row.end_ms} is invalid")

    kinds = list(dict.fromkeys(row.kind for row in rows))
    if len(kinds) < 2:
        issues.append(f"only {', '.join(kinds) or 'nothing'} extracted")

    score = grounding_rate
    if not ranges_valid:
        score *= 0.5
    if len(kinds) < 2:
        score *= 0.8
    return ScoreReport(issues=issues, score=score)


MOMENT_MIN_DURATION_MS = 10_000
MOMENT_MAX_DURATION_MS = 120_000
MOMENT_DURATION_RATE = 0.8
MOMENT_IOU_LIMIT = 0.5


class MomentScores(WireModel):
    comprehensibility: float
    hook: float
    insight: float
    relevance: float
    risk: float


class ScoredMoment(WireModel):
    end_ms: int
    grounded: bool
    scores: MomentScores
    start_ms: int
    suppressed: bool


def _moment_iou(a: ScoredMoment, b: ScoredMoment) -> float:
    overlap = min(a.end_ms, b.end_ms) - max(a.start_ms, b.start_ms)
    if overlap <= 0:
        return 0
    return overlap / (max(a.end_ms, b.end_ms) - min(a.start_ms, b.start_ms))


def _check_moment_grid(
    survivors: Sequence[ScoredMoment],
    duration_ms: int,
    words: Sequence[Word],
    issues: list[str],
) -> bool:
    pauses = pause_boundaries(words)
    # Speaker-turn starts are valid in-points too: lead-in capture opens a
    # moment at the setup question, which begins where its speaker's turn
    # does — not necessarily on a sentence boundary of the previous speaker.
    valid_starts = {
        *sentence_start_times(words),
        *speaker_turn_start_times(words),
        *(words[index].start_ms for index in pauses),
    }
    valid_ends = {
        *sentence_end_times(words),
        *(words[index - 1].end_ms for index in pauses),
    }
    on_grid = True
    for row in survivors:
        if not (row.start_ms in valid_starts and row.end_ms in valid_ends):
            on_grid = False
            issues.append(
                f"bounds {row.start_ms}-{row.end_ms} are off the sentence grid"
            )
        if row.end_ms <= row.start_ms or row.end_ms > duration_ms:
            on_grid = False
            issues.append(f"range {row.start_ms}-{row.end_ms} is invalid")
    return on_grid


def _check_moment_overlaps(
    survivors: Sequence[ScoredMoment], issues: list[str]
) -> bool:
    deduped = True
    for a in range(len(survivors)):
        for b in range(a + 1, len(survivors)):
            if _moment_iou(survivors[a], survivors[b]) > MOMENT_IOU_LIMIT:
                deduped = False
                issues.append("surviving candidates overlap past the dedupe threshold")
    return deduped


def score_moments(
    rows: Sequence[ScoredMoment], duration_ms: int, words: Sequence[Word]
) -> ScoreReport:
    if len(rows) == 0:
        return ScoreReport(issues=["no candidates produced"], score=0)
    issues: list[str] = []
    grounded_count = len([row for row in rows if row.grounded])
    grounded_rate = grounded_count / len(rows)
    if grounded_rate < 1:
        issues.append(
            f"{len(rows) - grounded_count}/{len(rows)} anchors failed grounding"
        )
    survivors = [row for row in rows if row.grounded and not row.suppressed]
    on_grid = _check_moment_grid(survivors, duration_ms, words, issues)
    deduped = _check_moment_overlaps(survivors, issues)

    in_clip_range = [
        row
        for row in survivors
        if MOMENT_MIN_DURATION_MS <= row.end_ms - row.start_ms <= MOMENT_MAX_DURATION_MS
    ]
    duration_ok = (
        len(survivors) == 0
        or len(in_clip_range) / len(survivors) >= MOMENT_DURATION_RATE
    )
    if not duration_ok:
        issues.append(f"only {len(in_clip_range)}/{len(survivors)} moments are 10-120s")

    scores_valid = all(
        0 <= value <= 1 for row in rows for value in row.scores.model_dump().values()
    )
    if not scores_valid:
        issues.append("dimension scores fall outside 0-1")

    score = grounded_rate
    if not on_grid:
        score *= 0.5
    if not deduped:
        score *= 0.5
    if not duration_ok:
        score *= 0.85
    if not scores_valid:
        score *= 0.9
    return ScoreReport(issues=issues, score=score)


class ScoredSegment(WireModel):
    drop_reason: str | None
    end_ms: int
    grounded: bool
    kind: str
    start_ms: int


def score_segments(rows: Sequence[ScoredSegment], partition_ok: bool) -> ScoreReport:
    if len(rows) == 0:
        return ScoreReport(issues=["no segments produced"], score=0)
    issues: list[str] = []
    keeps = [row for row in rows if row.kind == "keep"]
    if len(keeps) == 0:
        return ScoreReport(issues=["plan kept nothing"], score=0)
    grounded_keeps = len([row for row in keeps if row.grounded])
    grounded_rate = grounded_keeps / len(keeps)
    if grounded_rate < 1:
        issues.append(
            f"{len(keeps) - grounded_keeps}/{len(keeps)} keeps failed anchor grounding"
        )
    if not partition_ok:
        issues.append("rows do not tile the episode")
    unreasoned_drops = len(
        [row for row in rows if row.kind == "drop" and row.drop_reason is None]
    )
    if unreasoned_drops > 0:
        issues.append(f"{unreasoned_drops} drop(s) carry no reason")
    chronological = True
    for index in range(1, len(rows)):
        if rows[index].start_ms < rows[index - 1].end_ms:
            chronological = False
    if not chronological:
        issues.append("rows overlap or are out of order")

    score = grounded_rate
    if not partition_ok:
        score *= 0.5
    if not chronological:
        score *= 0.5
    if unreasoned_drops > 0:
        score *= 0.9
    return ScoreReport(issues=issues, score=score)


class SegmentBoundaryDecision(WireModel):
    after_atom_id: str
    keep: bool
    note: str | None = None


class SegmentBoundaryAtom(WireModel):
    atom_id: str


class SegmentBoundaryGroup(WireModel):
    atom_ids: list[str]


def segment_boundary_decisions(
    atoms: Sequence[SegmentBoundaryAtom],
    groups: Sequence[SegmentBoundaryGroup],
) -> list[SegmentBoundaryDecision]:
    group_by_atom: dict[str, int] = {}
    for group_index, group in enumerate(groups):
        for atom_id in group.atom_ids:
            if atom_id in group_by_atom:
                msg = f"atom {atom_id} appears in more than one group"
                raise ValueError(msg)
            group_by_atom[atom_id] = group_index
    for atom in atoms:
        if atom.atom_id not in group_by_atom:
            msg = f"atom {atom.atom_id} is missing from reconciliation"
            raise ValueError(msg)

    return [
        SegmentBoundaryDecision(
            after_atom_id=atom.atom_id,
            keep=group_by_atom[atom.atom_id] != group_by_atom[atoms[index + 1].atom_id],
        )
        for index, atom in enumerate(atoms[:-1])
    ]


def score_segment_boundaries(
    predicted: Sequence[SegmentBoundaryDecision],
    gold: Sequence[SegmentBoundaryDecision],
) -> ScoreReport:
    if len(gold) == 0:
        return ScoreReport(issues=["no segment-boundary gold"], score=0)

    issues: list[str] = []
    predicted_by_id: dict[str, bool] = {}
    for decision in predicted:
        if decision.after_atom_id in predicted_by_id:
            issues.append(f"duplicate prediction after {decision.after_atom_id}")
            continue
        predicted_by_id[decision.after_atom_id] = decision.keep

    seen_gold: set[str] = set()
    totals: dict[bool, int] = {}
    correct: dict[bool, int] = {}
    for expected in gold:
        if expected.after_atom_id in seen_gold:
            issues.append(f"duplicate gold boundary after {expected.after_atom_id}")
            continue
        seen_gold.add(expected.after_atom_id)
        totals[expected.keep] = totals.get(expected.keep, 0) + 1
        actual = predicted_by_id.get(expected.after_atom_id)
        if actual == expected.keep:
            correct[expected.keep] = correct.get(expected.keep, 0) + 1
            continue
        note = f" ({expected.note})" if expected.note else ""
        if actual is None:
            issues.append(f"no prediction after {expected.after_atom_id}{note}")
        elif actual:
            issues.append(
                f"kept boundary after {expected.after_atom_id} that gold removes{note}"
            )
        else:
            issues.append(
                f"removed boundary after {expected.after_atom_id} that gold keeps{note}"
            )

    # Macro-average the represented classes, in the insertion order the TS
    # Map produced — the float sum below is order-sensitive.
    class_scores = [correct.get(keep, 0) / total for keep, total in totals.items()]
    score = sum(class_scores) / len(class_scores)
    return ScoreReport(issues=issues, score=score)


class QaCitation(WireModel):
    end_ms: int
    quote: str | None = None
    start_ms: int


class QaOutcome(WireModel):
    answer: str | None = None
    citations: list[QaCitation]
    expected_answerable: bool
    gold_end_ms: int | None = None
    gold_start_ms: int | None = None
    got_answerable: bool
    question: str


def score_qa(outcomes: Sequence[QaOutcome]) -> ScoreReport:
    if len(outcomes) == 0:
        return ScoreReport(issues=["no golden questions"], score=0)
    issues: list[str] = []
    total = 0.0
    for outcome in outcomes:
        if outcome.got_answerable != outcome.expected_answerable:
            expected = "true" if outcome.expected_answerable else "false"
            issues.append(f'"{outcome.question}": expected answerable={expected}')
            continue
        if not outcome.expected_answerable:
            total += 1
            continue
        hits = any(
            citation.start_ms < (outcome.gold_end_ms or 0)
            and citation.end_ms > (outcome.gold_start_ms or 0)
            for citation in outcome.citations
        )
        if hits:
            total += 1
        else:
            total += 0.5
            issues.append(f'"{outcome.question}": no citation overlaps the gold range')
    return ScoreReport(issues=issues, score=total / len(outcomes))

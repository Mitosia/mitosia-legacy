"""Replay of the cross-language parity snapshots (phase A1's gate).

Snapshots are dumped by ``pnpm eval:parity`` from the TS mock-mode eval
flow and committed under ``pipeline/tests/parity/``. Each case records one
scorer's exact input and the TS result; :func:`verify_snapshot` recomputes
every case with the ported scorers and reports mismatches. Scores must be
bit-identical (same IEEE-754 operations in the same order) and issue
strings byte-identical.
"""

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

from pydantic import BaseModel, TypeAdapter

from clipper.evals.review_metrics import (
    ReviewedClipRow,
    ReviewMetrics,
    accumulate_review_metrics,
    review_metrics_lines,
)
from clipper.evals.scorers import (
    Chapter,
    ExtractionRow,
    QaOutcome,
    ScoredMoment,
    ScoredSegment,
    ScoreReport,
    SegmentBoundaryAtom,
    SegmentBoundaryDecision,
    SegmentBoundaryGroup,
    SpeakerSuggestion,
    score_chapters,
    score_extractions,
    score_moments,
    score_qa,
    score_segment_boundaries,
    score_segments,
    score_speaker_suggestions,
    score_summary,
    segment_boundary_decisions,
)
from clipper.substrate.grid import Word

PARITY_SNAPSHOT_VERSION = 1

_chapters = TypeAdapter(list[Chapter])
_suggestions = TypeAdapter(list[SpeakerSuggestion])
_extraction_rows = TypeAdapter(list[ExtractionRow])
_moment_rows = TypeAdapter(list[ScoredMoment])
_segment_rows = TypeAdapter(list[ScoredSegment])
_words = TypeAdapter(list[Word])
_decisions = TypeAdapter(list[SegmentBoundaryDecision])
_atoms = TypeAdapter(list[SegmentBoundaryAtom])
_groups = TypeAdapter(list[SegmentBoundaryGroup])
_qa_outcomes = TypeAdapter(list[QaOutcome])
_review_rows = TypeAdapter(list[ReviewedClipRow])


def score_case_report(case: dict[str, Any]) -> ScoreReport:
    inp = case["input"]
    scorer = case["scorer"]
    if scorer == "chapters":
        return score_chapters(
            _chapters.validate_python(inp["chapters"]), inp["durationMs"]
        )
    if scorer == "speakers":
        return score_speaker_suggestions(
            _suggestions.validate_python(inp["suggestions"]), inp["speakerIds"]
        )
    if scorer == "summary":
        return score_summary(inp["summary"])
    if scorer == "extraction":
        return score_extractions(
            _extraction_rows.validate_python(inp["rows"]), inp["durationMs"]
        )
    if scorer == "moments":
        return score_moments(
            _moment_rows.validate_python(inp["rows"]),
            inp["durationMs"],
            _words.validate_python(inp["words"]),
        )
    if scorer == "segments":
        return score_segments(
            _segment_rows.validate_python(inp["rows"]), inp["partitionOk"]
        )
    if scorer == "segment-boundaries":
        return score_segment_boundaries(
            _decisions.validate_python(inp["predicted"]),
            _decisions.validate_python(inp["gold"]),
        )
    if scorer == "qa":
        return score_qa(_qa_outcomes.validate_python(inp["outcomes"]))
    msg = f"unknown scorer {scorer}"
    raise ValueError(msg)


def _dump(model: BaseModel) -> dict[str, Any]:
    return model.model_dump(by_alias=True, exclude_none=True)


def _verify_boundary_decisions(case: dict[str, Any]) -> list[str]:
    inp = case["input"]
    expected = case["expected"]
    try:
        decisions = segment_boundary_decisions(
            _atoms.validate_python(inp["atoms"]),
            _groups.validate_python(inp["groups"]),
        )
    except ValueError as error:
        if expected.get("errorMessage") != str(error):
            return [f"expected error {expected.get('errorMessage')!r}, got {error!r}"]
        return []
    if "errorMessage" in expected:
        return [f"expected error {expected['errorMessage']!r}, got a result"]
    got = [_dump(decision) for decision in decisions]
    if got != expected["decisions"]:
        return [f"decisions mismatch: expected {expected['decisions']}, got {got}"]
    return []


def _verify_review_metrics(case: dict[str, Any]) -> list[str]:
    inp = case["input"]
    expected = case["expected"]
    metrics = ReviewMetrics()
    for row in _review_rows.validate_python(inp["rows"]):
        accumulate_review_metrics(metrics, row)
    problems: list[str] = []
    got_metrics = metrics.model_dump(by_alias=True)
    if got_metrics != expected["metrics"]:
        problems.append(
            f"metrics mismatch: expected {expected['metrics']}, got {got_metrics}"
        )
    got_lines = review_metrics_lines(inp["label"], metrics)
    if got_lines != expected["lines"]:
        problems.append(
            f"lines mismatch: expected {expected['lines']}, got {got_lines}"
        )
    return problems


_SPECIAL: dict[str, Callable[[dict[str, Any]], list[str]]] = {
    "review-metrics": _verify_review_metrics,
    "segment-boundary-decisions": _verify_boundary_decisions,
}


def verify_case(case: dict[str, Any]) -> list[str]:
    """Recompute one snapshot case; return mismatch descriptions (empty = parity)."""
    special = _SPECIAL.get(case["scorer"])
    if special:
        return special(case)
    expected = case["expected"]
    got = score_case_report(case)
    problems: list[str] = []
    if got.score != expected["score"]:
        problems.append(
            f"score mismatch: expected {expected['score']!r}, got {got.score!r}"
        )
    if got.issues != expected["issues"]:
        problems.append(
            f"issues mismatch: expected {expected['issues']}, got {got.issues}"
        )
    return problems


def verify_snapshot(path: Path) -> list[str]:
    """Verify every case in one snapshot file; return mismatch descriptions."""
    snapshot = json.loads(path.read_text())
    if snapshot["version"] != PARITY_SNAPSHOT_VERSION:
        return [
            (
                f"{path.name}: snapshot version {snapshot['version']} != "
                f"{PARITY_SNAPSHOT_VERSION}"
            )
        ]
    problems: list[str] = []
    for index, case in enumerate(snapshot["cases"]):
        problems.extend(
            f"{path.name} case {index} ({case['scorer']}): {problem}"
            for problem in verify_case(case)
        )
    return problems

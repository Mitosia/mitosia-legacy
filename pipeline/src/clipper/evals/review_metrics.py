"""The Gate M1 readout's pure half, ported from ``lib/intelligence/review-metrics.ts``.

Acceptance rate and boundary-adjustment magnitude over reviewed clip rows;
report lines match the TS text byte-for-byte (the parity snapshots assert
it). The SQL feeding these rows arrives with the A2 database layer.
"""

from collections.abc import Sequence

from pydantic import Field

from clipper.evals.jsnum import to_fixed
from clipper.wire import WireModel


class ReviewedClipRow(WireModel):
    adjusted_end_ms: int | None
    adjusted_start_ms: int | None
    end_ms: int
    start_ms: int
    status: str


class ReviewMetrics(WireModel):
    accepted: int = 0
    deltas_in: list[int] = Field(default_factory=list[int])
    deltas_out: list[int] = Field(default_factory=list[int])
    proposed: int = 0
    rejected: int = 0
    shortlisted: int = 0
    total: int = 0


def accumulate_review_metrics(metrics: ReviewMetrics, row: ReviewedClipRow) -> None:
    metrics.total += 1
    if row.status == "accepted":
        metrics.accepted += 1
        adjusted_start = (
            row.adjusted_start_ms if row.adjusted_start_ms is not None else row.start_ms
        )
        adjusted_end = (
            row.adjusted_end_ms if row.adjusted_end_ms is not None else row.end_ms
        )
        metrics.deltas_in.append(abs(adjusted_start - row.start_ms))
        metrics.deltas_out.append(abs(adjusted_end - row.end_ms))
    elif row.status == "rejected":
        metrics.rejected += 1
    elif row.status == "shortlisted":
        metrics.shortlisted += 1
    else:
        metrics.proposed += 1


def median(values: Sequence[float]) -> float:
    if len(values) == 0:
        return 0
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2 == 1:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / 2


def mean(values: Sequence[float]) -> float:
    if len(values) == 0:
        return 0
    total = 0.0
    for value in values:
        total += value
    return total / len(values)


def _seconds(ms: float) -> str:
    return f"{to_fixed(ms / 1000, 1)}s"


def review_metrics_lines(label: str, metrics: ReviewMetrics) -> list[str]:
    decided = metrics.accepted + metrics.rejected
    acceptance = (
        "no decisions yet"
        if decided == 0
        else (
            f"{metrics.accepted}/{decided}"
            f" ({to_fixed((metrics.accepted / decided) * 100, 0)}%)"
        )
    )
    lines = [
        f"{label}",
        (
            f"  candidates: {metrics.total} — {metrics.accepted} accepted"
            f" · {metrics.shortlisted} shortlisted · {metrics.rejected} rejected"
            f" · {metrics.proposed} undecided"
        ),
        f"  acceptance rate: {acceptance}",
    ]
    if metrics.accepted > 0:
        lines.append(
            f"  boundary Δ (accepted) — in: mean {_seconds(mean(metrics.deltas_in))},"
            f" median {_seconds(median(metrics.deltas_in))}"
            f" · out: mean {_seconds(mean(metrics.deltas_out))},"
            f" median {_seconds(median(metrics.deltas_out))}"
        )
    return lines

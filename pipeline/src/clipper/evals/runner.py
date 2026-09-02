"""The eval runner CLI (phase A1).

Two commands today:

- ``clipper-eval verify [dir]`` — replay the cross-language parity
  snapshots through the ported scorers and fail on any mismatch (the A1
  gate; local CI runs this via pytest as well).
- ``clipper-eval score <snapshot.json ...>`` — recompute the scorer cases
  and print the same PASS/FAIL threshold report ``pnpm eval`` prints.

Live capability invocation (running lanes to produce fresh scorer inputs)
arrives with the B-phase lanes and their cassettes; the thresholds and the
report format are already the production ones.
"""

import argparse
import json
import sys
from pathlib import Path

from clipper.evals.jsnum import to_fixed
from clipper.evals.parity import score_case_report, verify_snapshot

# Thresholds ported from scripts/run-evals.ts — the gate levels are part of
# the eval semantics, not presentation.
THRESHOLDS: dict[str, float] = {
    "chapters": 0.7,
    "extraction": 0.8,
    "moments": 0.8,
    "qa": 0.7,
    "segment-boundaries": 0.8,
    "segments": 0.8,
    "speakers": 0.6,
    "summary": 0.4,
}


def _format_threshold(value: float) -> str:
    return f"{value:g}"


def _print_score(name: str, score: float, threshold: float, issues: list[str]) -> bool:
    ok = score >= threshold
    suffix = f" — {'; '.join(issues)}" if issues else ""
    sys.stdout.write(
        f"   {'PASS' if ok else 'FAIL'} {name}: {to_fixed(score, 2)}"
        f" (>= {_format_threshold(threshold)}){suffix}\n"
    )
    return ok


def _score_command(paths: list[str]) -> int:
    failed = 0
    for raw in paths:
        snapshot = json.loads(Path(raw).read_text())
        sys.stdout.write(f"── {snapshot['name']}\n")
        for case in snapshot["cases"]:
            threshold = THRESHOLDS.get(case["scorer"])
            if threshold is None:
                continue
            report = score_case_report(case)
            if not _print_score(case["scorer"], report.score, threshold, report.issues):
                failed += 1
    verdict = (
        "EVALS PASS" if failed == 0 else f"EVALS: {failed} check(s) under threshold"
    )
    sys.stdout.write(f"\n{verdict}\n")
    return 0 if failed == 0 else 1


def _verify_command(directory: str) -> int:
    parity_dir = Path(directory)
    snapshots = sorted(parity_dir.glob("*.json"))
    if not snapshots:
        sys.stderr.write(f"no parity snapshots in {parity_dir}\n")
        return 1
    problems: list[str] = []
    for snapshot in snapshots:
        problems.extend(verify_snapshot(snapshot))
    if problems:
        for problem in problems:
            sys.stderr.write(f"{problem}\n")
        sys.stderr.write(f"\nPARITY: {len(problems)} mismatch(es)\n")
        return 1
    sys.stdout.write(f"PARITY OK across {len(snapshots)} snapshot(s)\n")
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(prog="clipper-eval")
    commands = parser.add_subparsers(dest="command", required=True)

    verify = commands.add_parser(
        "verify", help="replay parity snapshots through the ported scorers"
    )
    verify.add_argument(
        "directory",
        nargs="?",
        default=str(Path(__file__).parents[3] / "tests" / "parity"),
    )

    score = commands.add_parser(
        "score", help="print the threshold report for snapshot scorer cases"
    )
    score.add_argument("paths", nargs="+")

    args = parser.parse_args()
    if args.command == "verify":
        raise SystemExit(_verify_command(args.directory))
    raise SystemExit(_score_command(args.paths))

"""The A1 gate: every parity snapshot replays through the ported scorers.

Snapshots are dumped from the TS mock-mode eval flow by ``pnpm eval:parity``
and kept honest by ``tests/eval-parity-snapshot.test.ts`` on the TS side.
Scores must match bit-for-bit and issue strings byte-for-byte — "within
rounding" is the phase gate's floor, exact equality is what the port
actually achieves by mirroring operation order.
"""

from pathlib import Path

import pytest

from clipper.evals.parity import verify_snapshot

PARITY_DIR = Path(__file__).parent / "parity"
SNAPSHOTS = sorted(PARITY_DIR.glob("*.json"))


def test_snapshots_exist() -> None:
    names = [path.name for path in SNAPSHOTS]
    assert "synthetic.json" in names
    assert "signal-boost-snippet.json" in names


@pytest.mark.parametrize("path", SNAPSHOTS, ids=lambda path: path.name)
def test_snapshot_parity(path: Path) -> None:
    problems = verify_snapshot(path)
    assert problems == []

"""Word-timeline grid helpers, ported from ``lib/intelligence/moments.ts``.

The TS file is the behavioral spec; every function here mirrors its
namesake's exact semantics (including regex character classes), which the
cross-language parity snapshots assert.
"""

import re
from collections.abc import Sequence

from clipper.wire import WireModel

# TS: /[.!?]["”'’)\]]*$/u — anchored at true end of string, so use \Z
# (Python's $ would also match before a trailing newline).
SENTENCE_TERMINAL = re.compile(r'[.!?]["”\'’)\]]*\Z')

# An inter-word gap this long reads as a pause a cut can land on.
DEFAULT_PAUSE_GAP_MS = 700


class Word(WireModel):
    """One transcript word on the integer-millisecond timeline."""

    confidence: float | None = None
    end_ms: int
    speaker: str | None = None
    start_ms: int
    text: str


def sentence_starts(words: Sequence[Word]) -> list[int]:
    """Word indices where a sentence begins.

    The first word, and every word whose predecessor ends with terminal
    punctuation.
    """
    starts: list[int] = []
    for index in range(len(words)):
        if index == 0:
            starts.append(0)
            continue
        if SENTENCE_TERMINAL.search(words[index - 1].text):
            starts.append(index)
    return starts


def pause_boundaries(
    words: Sequence[Word], min_gap_ms: int = DEFAULT_PAUSE_GAP_MS
) -> list[int]:
    """Word indices preceded by an inter-word silence of at least min_gap_ms."""
    boundaries: list[int] = []
    for index in range(1, len(words)):
        if words[index].start_ms - words[index - 1].end_ms >= min_gap_ms:
            boundaries.append(index)
    return boundaries


def sentence_start_times(words: Sequence[Word]) -> list[int]:
    """Snap-point times where a sentence starts playing."""
    return [words[index].start_ms for index in sentence_starts(words)]


def sentence_end_times(words: Sequence[Word]) -> list[int]:
    """Snap-point times where a sentence stops playing.

    The word before each subsequent sentence start, plus the final word.
    """
    times: list[int] = []
    for start in sentence_starts(words):
        if start == 0:
            continue
        times.append(words[start - 1].end_ms)
    if words:
        times.append(words[-1].end_ms)
    return times


def speaker_turn_start_times(words: Sequence[Word]) -> list[int]:
    """Return times where a speaker turn begins (first word, or speaker change)."""
    times: list[int] = []
    for index, word in enumerate(words):
        if index == 0 or words[index - 1].speaker != word.speaker:
            times.append(word.start_ms)
    return times

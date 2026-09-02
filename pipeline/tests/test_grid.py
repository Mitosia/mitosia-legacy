"""Unit tests for the substrate grid helpers (behavior-ported from TS)."""

from clipper.substrate.grid import (
    Word,
    pause_boundaries,
    sentence_end_times,
    sentence_start_times,
    sentence_starts,
    speaker_turn_start_times,
)


def word(text: str, start_ms: int, end_ms: int, speaker: str | None) -> Word:
    return Word(text=text, start_ms=start_ms, end_ms=end_ms, speaker=speaker)


WORDS = [
    word("Hello", 0, 900, "0"),
    word("there.", 1000, 1900, "0"),
    word("General", 3500, 4400, "1"),
    word('Kenobi!"', 4500, 5900, "1"),
    word("Indeed", 6000, 6500, "1"),
]


def test_sentence_starts_follow_terminal_punctuation() -> None:
    assert sentence_starts(WORDS) == [0, 2, 4]


def test_sentence_terminal_accepts_trailing_quotes_and_brackets() -> None:
    assert sentence_starts([word("Done.)", 0, 1, "0"), word("Next", 2, 3, "0")]) == [
        0,
        1,
    ]


def test_sentence_times_span_first_word_to_predecessor_end() -> None:
    assert sentence_start_times(WORDS) == [0, 3500, 6000]
    assert sentence_end_times(WORDS) == [1900, 5900, 6500]


def test_pause_boundaries_use_inter_word_gap() -> None:
    assert pause_boundaries(WORDS) == [2]
    assert pause_boundaries(WORDS, min_gap_ms=2000) == []


def test_speaker_turns_start_at_first_word_and_changes() -> None:
    assert speaker_turn_start_times(WORDS) == [0, 3500]


def test_empty_words() -> None:
    assert sentence_starts([]) == []
    assert sentence_start_times([]) == []
    assert sentence_end_times([]) == []
    assert pause_boundaries([]) == []
    assert speaker_turn_start_times([]) == []

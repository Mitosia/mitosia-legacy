"""to_fixed must match JavaScript's Number.prototype.toFixed exactly."""

from clipper.evals.jsnum import to_fixed


def test_rounds_half_away_from_zero() -> None:
    # Python's format() would give "2" and "-2" here (banker's rounding).
    assert to_fixed(2.5, 0) == "3"
    assert to_fixed(-2.5, 0) == "-3"
    assert to_fixed(0.125, 2) == "0.13"


def test_operates_on_the_binary_double() -> None:
    # 1.005 is really 1.00499999999999989..., so JS gives "1.00", not "1.01".
    assert to_fixed(1.005, 2) == "1.00"
    # 0.5 is exact, so the tie rounds up.
    assert to_fixed(0.5, 0) == "1"


def test_pads_and_carries() -> None:
    assert to_fixed(0.07, 1) == "0.1"
    assert to_fixed(9.96, 1) == "10.0"
    assert to_fixed(100.0, 0) == "100"
    assert to_fixed(0.0, 1) == "0.0"

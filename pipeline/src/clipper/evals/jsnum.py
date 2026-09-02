"""JavaScript-compatible number formatting.

The TS scorers build issue strings with ``Number.prototype.toFixed``; the
parity gate compares those strings byte-for-byte, so the port needs the
exact same rounding: operate on the double's true binary value, negate
first, and round half UP on the magnitude (ECMA-262 Number.prototype.toFixed).
Python's ``format(x, ".2f")`` rounds half to even and disagrees on ties.
"""

from decimal import ROUND_FLOOR, Decimal

_HALF = Decimal("0.5")


def to_fixed(value: float, digits: int) -> str:
    """Format ``value`` exactly like JavaScript's ``value.toFixed(digits)``."""
    sign = "-" if value < 0 else ""
    scaled = Decimal(abs(value)).scaleb(digits)
    magnitude = int((scaled + _HALF).to_integral_value(rounding=ROUND_FLOOR))
    if digits == 0:
        return f"{sign}{magnitude}"
    text = str(magnitude).zfill(digits + 1)
    return f"{sign}{text[:-digits]}.{text[-digits:]}"

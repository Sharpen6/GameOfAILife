"""Portable seeded dice (mulberry32): the same numbers in Python and in the JS port.

The map's trees and the generated cast are drawn from this generator, so both ports build the identical
city (pinned by tests/fixtures/city_seed1.json). The simulation's own dice stay `random.Random`.

JS twin (seeds are taken modulo 2**32, in JS `(Math.imul(seed, k) + c) >>> 0`):

    function mulberry32(seed) {
      let s = seed >>> 0;
      return () => {
        s = (s + 0x6D2B79F5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

Parity: the first three draws of Rng(7920) are 0.166736019310, 0.824670854257 and 0.208481384674.
"""

from __future__ import annotations

import math

_MASK = 0xFFFFFFFF


def r2(x: float) -> float:
    """Round half up to 2 decimals, as JS `Math.floor(x * 100 + 0.5) / 100` (never Python's banker's round)."""
    return math.floor(x * 100 + 0.5) / 100


class Rng:
    """mulberry32. `int(lo, hi)` is inclusive; `shuffle` is Fisher-Yates from the end."""

    r2 = staticmethod(r2)

    def __init__(self, seed: int):
        self.state = seed & _MASK

    def next_u32(self) -> int:
        self.state = (self.state + 0x6D2B79F5) & _MASK
        t = self.state
        t = ((t ^ (t >> 15)) * (t | 1)) & _MASK
        t ^= (t + (((t ^ (t >> 7)) * (t | 61)) & _MASK)) & _MASK
        return (t ^ (t >> 14)) & _MASK

    def random(self) -> float:
        """A float in [0, 1): next_u32 / 2**32."""
        return self.next_u32() / 4294967296

    def int(self, lo: int, hi: int) -> int:
        """An integer from lo to hi, both included."""
        return lo + math.floor(self.random() * (hi - lo + 1))

    def uniform(self, lo: float, hi: float) -> float:
        return lo + (hi - lo) * self.random()

    def pick(self, seq):
        return seq[math.floor(self.random() * len(seq))]

    def shuffle(self, seq: list) -> None:
        """In place: for i from n-1 down to 1, swap item i with item floor(random() * (i + 1))."""
        for i in range(len(seq) - 1, 0, -1):
            j = math.floor(self.random() * (i + 1))
            seq[i], seq[j] = seq[j], seq[i]

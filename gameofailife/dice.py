"""Keyed dice (life.md 4.1): a fresh mulberry32 stream for (seed, namespace, ids...), identical in Python and JS.

Every life, social and folk-behaviour rule draws `stream(sim.dice_seed, NS, *ids)`, so a rule's draws depend only on
who and when, never on what else happened first. Namespaces 1-18 are life's (append only); folk's are 101-106.
Parity vector (Python and node agree): key(1, 3, "dana", 12) == 4148098172, roll(1, 3, "dana", 12) ==
0.595681251725, roll(1, 1, "cafe", 1445) == 0.132828066358, roll(7, 2, "ari", "tom") == 0.755763392197.
"""

from __future__ import annotations

from .rng import Rng

_MASK, LUCK_STRENGTH, _SID = 0xFFFFFFFF, 0.6, {}
(TALK, CHEM, DAY_HEALTH, DAY_CAREER, DAY_ROMANCE, WEEK_MONEY, SHIFT, ASK, BIRTH, NAME, SETTLE, COUPLE, STORY,
 HIRE, FOLK_ANSWER, LEND, ORIENT, INCIDENT) = range(1, 19)  # namespaces: append only


def sid(x) -> int:
    """Ints as themselves; ASCII strings by FNV-1a 32, cached."""
    if isinstance(x, int):
        return x & _MASK
    h = _SID.get(x)
    if h is None:
        h = 0x811C9DC5
        for ch in x:
            h = ((h ^ ord(ch)) * 0x01000193) & _MASK
        _SID[x] = h
    return h


def _fmix(h: int) -> int:
    """The murmur3 finalizer."""
    h ^= h >> 16
    h = (h * 0x85EBCA6B) & _MASK
    h ^= h >> 13
    h = (h * 0xC2B2AE35) & _MASK
    return h ^ (h >> 16)


def key(seed: int, *parts) -> int:
    h = (seed * 0x9E3779B1) & _MASK
    for p in parts:
        h = _fmix(((h ^ sid(p)) * 0x01000193) & _MASK)
    return h


def stream(seed: int, *parts) -> Rng:
    return Rng(key(seed, *parts))


def roll(seed: int, *parts) -> float:
    return stream(seed, *parts).random()


def odds(p: float, valence: float, luck: float, k: float = 1.0) -> float:
    """Luck's push on an outcome's odds: == forks.luck_odds when k == 1 (tested)."""
    return max(0.0, min(1.0, p * (1 + LUCK_STRENGTH * k * (luck - 50) / 50 * valence)))

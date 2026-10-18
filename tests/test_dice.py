"""Keyed dice (life.md 4.1): the parity vector, odds == forks.luck_odds at k 1, and the same numbers in node."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import unittest
from pathlib import Path

from gameofailife import dice, forks

ROOT = Path(__file__).resolve().parent.parent
NODE = os.environ.get("NODE") or shutil.which("node")


def r12(x: float) -> float:
    import math
    return math.floor(x * 1e12 + 0.5) / 1e12


def python_vector() -> dict:
    vector = [dice.key(1, 3, "dana", 12), r12(dice.roll(1, 3, "dana", 12)), r12(dice.roll(1, 1, "cafe", 1445)),
              r12(dice.roll(7, 2, "ari", "tom"))]
    odds = []
    for p in (0.05, 0.4, 0.9):
        for v in (-1, 1, 0.5):
            for luck in (0, 37, 50, 100):
                odds += [r12(dice.odds(p, v, luck)), r12(dice.odds(p, v, luck, 0.5))]
    streams = []
    for seed, ns, a, b in ((1, dice.TALK, "cafe", 1445), (99, dice.CHEM, "dana", "f17"),
                           (123456789, dice.INCIDENT, "works", 7)):
        rr = dice.stream(seed, ns, a, b)
        streams.append([r12(x) for x in (rr.random(), rr.random(), rr.int(0, 9), rr.uniform(0, 0.08))])
    return {"vector": vector, "odds": odds, "streams": streams}


class DiceTest(unittest.TestCase):
    def test_parity_vector(self):
        self.assertEqual(dice.key(1, 3, "dana", 12), 4148098172)
        self.assertAlmostEqual(dice.roll(1, 3, "dana", 12), 0.595681251725, places=12)
        self.assertAlmostEqual(dice.roll(1, 1, "cafe", 1445), 0.132828066358, places=12)
        self.assertAlmostEqual(dice.roll(7, 2, "ari", "tom"), 0.755763392197, places=12)

    def test_namespaces_are_append_only(self):
        names = ("TALK", "CHEM", "DAY_HEALTH", "DAY_CAREER", "DAY_ROMANCE", "WEEK_MONEY", "SHIFT", "ASK", "BIRTH",
                 "NAME", "SETTLE", "COUPLE", "STORY", "HIRE", "FOLK_ANSWER", "LEND", "ORIENT", "INCIDENT")
        self.assertEqual([getattr(dice, n) for n in names], list(range(1, 19)))

    def test_odds_equal_luck_odds_at_full_strength(self):
        for p in (0.0, 0.01, 0.2, 0.5, 0.95, 1.0):
            for valence in (-1, 0, 1):
                for luck in (0, 10, 37.5, 50, 63, 100):
                    self.assertEqual(dice.odds(p, valence, luck), forks.luck_odds(p, valence, luck))

    def test_half_strength_is_half_the_push(self):
        self.assertAlmostEqual(dice.odds(0.4, 1, 100, 0.5), 0.4 * 1.3)
        self.assertAlmostEqual(dice.odds(0.4, -1, 100, 0.5), 0.4 * 0.7)
        self.assertEqual(dice.odds(0.9, 1, 100), 1.0)  # clamped

    def test_streams_are_keyed_not_shared(self):
        a = [dice.stream(5, dice.TALK, "cafe", t).random() for t in range(5)]
        b = [dice.stream(5, dice.TALK, "cafe", t).random() for t in range(5)]
        self.assertEqual(a, b)
        self.assertEqual(len(set(a)), 5)
        self.assertNotEqual(dice.roll(5, dice.TALK, "cafe", 1), dice.roll(5, dice.CHEM, "cafe", 1))

    @unittest.skipUnless(NODE, "node is not installed")
    def test_node_agrees(self):
        run = subprocess.run([NODE, str(ROOT / "port" / "tools" / "parity_dice.cjs")], capture_output=True, text=True,
                             timeout=120)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(json.loads(run.stdout), python_vector())


if __name__ == "__main__":
    unittest.main()

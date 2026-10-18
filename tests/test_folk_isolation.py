"""Isolated townsfolk change nothing for the named (folk.md 15): `folk_isolated=True` on the region plays the 60's
lives exactly as `folk=0` does.

Seed 1, three game days, both ways: every event about the named (sequence numbers ignored, since the townsfolk's
own events take numbers too), every decided fork (ids ignored for the same reason) and every named's hourly
position, state and activity must be the same. Isolated townsfolk never go where the named go, never talk to them
and roll their own dice, so a difference here is a leak from one tier into the other.
"""

from __future__ import annotations

import gc
import unittest

from gameofailife import people
from gameofailife.clock import MINUTES_PER_DAY
from gameofailife.sim import Simulation

DAYS = 3


def named_run(folk: int, isolated: bool) -> dict:
    sim = Simulation(1, world="region", folk=folk, folk_isolated=isolated)
    events, forks, hourly = [], [], []
    for _ in range(DAYS * MINUTES_PER_DAY):
        sim.step()
        evs, fks, _ = sim.drain()
        for ev in evs:
            ids = ([ev["agent"]] if ev.get("agent") else []) + list(ev.get("agents") or [])
            if ids and all(people.is_folk_id(x) for x in ids):
                continue  # the townsfolk's own news
            events.append({k: v for k, v in ev.items() if k != "seq"})
        forks.extend({k: v for k, v in f.items() if k != "id"} for f in fks)
        if sim.clock.tick % 60 == 0:
            hourly.extend((sim.clock.tick, a.id, a.x, a.y, a.state, a.activity, a.alive) for a in sim.agents.values())
    return {"events": events, "forks": forks, "hourly": hourly, "folk_n": sim.folk.n,
            "luck": {a.id: a.luck for a in sim.agents.values()}}


class TestFolkIsolation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.alone = named_run(0, False)
        cls.isolated = named_run(1000, True)

    @classmethod
    def tearDownClass(cls):
        cls.alone = cls.isolated = None  # three days of traces: do not keep them for the rest of the suite
        gc.collect()

    def test_the_townsfolk_were_there(self):
        self.assertEqual((self.alone["folk_n"], self.isolated["folk_n"]), (0, 1000))

    def test_hourly_positions_are_the_same(self):
        self.assertEqual(len(self.alone["hourly"]), len(self.isolated["hourly"]))
        for a, b in zip(self.alone["hourly"], self.isolated["hourly"]):
            self.assertEqual(a, b)

    def test_named_events_are_the_same(self):
        self.assertGreater(len(self.alone["events"]), 100)
        for a, b in zip(self.alone["events"], self.isolated["events"]):
            self.assertEqual(a, b)
        self.assertEqual(len(self.alone["events"]), len(self.isolated["events"]))

    def test_forks_are_the_same(self):
        self.assertTrue(self.alone["forks"])
        for a, b in zip(self.alone["forks"], self.isolated["forks"]):
            self.assertEqual(a, b)
        self.assertEqual(len(self.alone["forks"]), len(self.isolated["forks"]))

    def test_luck_is_the_same(self):
        self.assertEqual(self.alone["luck"], self.isolated["luck"])


if __name__ == "__main__":
    unittest.main()

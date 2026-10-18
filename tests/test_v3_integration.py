"""Checks the v3 integration needed where two packages' code meet (PLAN 5): each one guards a fix made on the
merged tree, so a later merge cannot quietly undo it."""

from __future__ import annotations

import unittest
from unittest import mock

from gameofailife import housing
from gameofailife.sim import Simulation


class RegionNoticeTest(unittest.TestCase):
    """v3-fixes's landlord notice sale (notice_home, landlord_notices, _landlord_sells) in the region world, where
    sim.homes also holds the townsfolk's 575 homes (R1b): it looks at the cast's 37 only (PLAN 2.9)."""

    @classmethod
    def setUpClass(cls):
        cls.sim = Simulation(1, world="region", folk=1000)

    @classmethod
    def tearDownClass(cls):
        cls.sim = None

    def test_notice_home_is_one_of_the_37(self):
        home = housing.notice_home(self.sim)
        self.assertIsNotNone(home)
        self.assertTrue(housing.is_v2_home(home.id), home.id)
        self.assertIn(home.household, self.sim.households)

    def test_the_landlord_gives_notice_in_a_drought(self):
        sim = self.sim
        sim.clock.tick = housing.NOTICE_FROM_DAY * housing.DAY + housing.NOTICE_HOUR * 60
        before = {h.id: (h.notice, h.noticed) for h in sim.homes.values()}
        try:
            with mock.patch.object(housing, "house_drought", lambda s, but=None: True):
                housing.landlord_notices(sim)
            noticed = [h for h in sim.homes.values() if h.notice is not None]
            self.assertEqual(len(noticed), 1)
            self.assertTrue(housing.is_v2_home(noticed[0].id), noticed[0].id)
        finally:
            for h in sim.homes.values():
                h.notice, h.noticed = before[h.id]


if __name__ == "__main__":
    unittest.main()

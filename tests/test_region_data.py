"""client/dev/region_data.js is the region's map_json (V1a): the dev page's region matches the sim's.

region_data.js is written by client/dev/make_region_data.py from gameofailife.region.build_region(1).map_json();
these tests parse it and compare place ids, decor rows, tile rows and every rail line's track_tiles. They skip
when gameofailife.region is not importable (a tree without the region).
"""
import json
import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "client", "dev", "region_data.js")

try:
    from gameofailife import region as REGION_MOD
except Exception:  # pragma: no cover - a tree without the region
    REGION_MOD = None


def load_region_data():
    with open(DATA, encoding="utf-8") as f:
        text = f.read()
    m = re.search(r"window\.REGION\s*=\s*(\{.*\})\s*;\s*$", text, re.S)
    if not m:
        raise AssertionError("region_data.js has no window.REGION = {...}; line")
    return json.loads(m.group(1))


@unittest.skipIf(REGION_MOD is None, "gameofailife.region is not importable")
class RegionDataTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.js = load_region_data()
        cls.mj = json.loads(json.dumps(REGION_MOD.build_region(1).map_json()))

    def test_size_and_tiles(self):
        self.assertEqual((self.js["w"], self.js["h"]), (self.mj["w"], self.mj["h"]))
        self.assertEqual(len(self.js["tiles"]), self.mj["h"])
        for y, (a, b) in enumerate(zip(self.js["tiles"], self.mj["tiles"])):
            self.assertEqual(a, b, "tile row %d differs" % y)
            self.assertEqual(len(a), self.mj["w"])

    def test_place_ids(self):
        self.assertEqual([p["id"] for p in self.js["places"]], [p["id"] for p in self.mj["places"]])

    def test_decor_rows(self):
        self.assertEqual(len(self.js["decor"]), len(self.mj["decor"]))

    def test_track_tiles(self):
        a = {line["id"]: line["track_tiles"] for line in self.js["rail"]["lines"]}
        b = {line["id"]: line["track_tiles"] for line in self.mj["rail"]["lines"]}
        self.assertEqual(a, b)
        self.assertTrue(b, "the region has rail lines")


if __name__ == "__main__":
    unittest.main()

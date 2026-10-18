"""The region generator (dev time): writes gameofailife/data/region.json, the 256 x 192 region around Millbrook.

    python3 -m gameofailife.regiongen --check    # exit 1 when data/region.json is stale
    python3 -m gameofailife.regiongen --write    # regenerate it
    python3 -m gameofailife.regiongen --stats    # counts

A port of design-v3/scratch-region/gen.py (revision 2); its tables (DISTRICTS, LINES, STATIONS, EXITS, CIVIC, PARKS,
PRICES, MILLBROOK_JOBS, DECOR) are normative (region.md). Millbrook's own tiles (x < 69, y < 50) are left as '?':
`region.build_region(seed)` fills them from `town.build_map(seed)` at load and applies the prices, so tuning
the price table never changes an id. Seed-independent: one fixed Rng(0x5EED3) draws the trees and the start
states; the decor is hash-placed. Only the simulation's loader (region.py) runs at game time.

Two railway lines (Riverton Line R with a Quayside stop, Southfield Line S to Willow Hills), offices, flats and
factories at the stations, Millbrook East flats in the strip x 69-79, folk job rows at Millbrook's own places, a
district price table, varied lot conditions, primary schools, and the decor pass (view.md 4.1).

After the region freeze (PLAN 3, `v3-region-frozen`) changes are additive only: ids and counts stay.
`ADDITIVE` lists the keys added since the hour-0 file (sha1 HOUR0_SHA1), `RAISED` the job rows whose slot count
was raised since (no row added or removed, no id changed) and `RETUNED` the line values changed since (the cars and
capacity of a train); --write output minus those keys, with those counts and values put back, reproduces the
hour-0 file byte for byte.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import time

from .rng import Rng

DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "region.json")
HOUR0_SHA1 = "29a45ed5f37906a194b6dc91ab70d1af0f492436"  # scratch-region/region.json, the v3-skel-region file
PARKING_MINUTES = {"downtown_riverton": 10, "midtown": 8}  # minutes to park a car (region.car_extra), else 0
ADDITIVE = {"districts": ("parking_minutes",)}  # keys added after the hour-0 file, by top-level key
# Job rows (title, place) whose count was raised after the hour-0 file: (hour-0 count, count now). The green's
# gardener has 2 so the named park keeper meets folk coworkers on the shift (F1, folk.md: >= 2).
RAISED = {("gardener", "green"): (1, 2)}
# Line values retuned after the hour-0 file: (line, key) -> (hour-0 value, value now). Trains of 2 cars for 120
# riders, not 4 for 240: the region's 1,000 townsfolk make about 330 train trips a weekday and the busiest train
# carries 15-20 (stage 5); the trains and the timetable are unchanged.
RETUNED = {("R", "cars"): (4, 2), ("R", "capacity"): (240, 120), ("S", "cars"): (4, 2), ("S", "capacity"): (240, 120)}

W, H = 256, 192
FROZEN_W, FROZEN_H = 69, 50  # x < 69 and y < 50: Millbrook's own tiles from town.build_map(seed)
GRASS, ROAD, BUILDING, DOOR, PARK, TREE, ENTRY, WATER = ".", "#", "B", "D", "P", "T", "e", "~"
BRIDGE, RAIL, RAIL_BRIDGE, CROSSING, HIGHWAY, HIGHWAY_BRIDGE, PLATFORM, FARM = "b", "=", "r", "x", "H", "h", "S", "F"
STREET = "#bx"

RIVER_ROWS = (46, 47, 48, 49)
NORTH_ROWS = (3, 14, 25, 36)  # Millbrook's east-west streets, continued to x 255
SOUTH_ROWS = (51, 62, 73, 84, 95, 106, 117, 128, 139, 150)  # south bank streets, x 0-255
FARM_ROWS = (172,)
COLS = tuple(3 + 13 * k for k in range(20))  # avenues 3 .. 250; Millbrook has 3..68
REGION_COLS = COLS[6:]  # 81 .. 250 on the north bank (y 0-44)
BRIDGE_COLS = (81, 120, 159, 198)
INTERCHANGE_COLS = (81, 120, 159, 198)
HWY_ROWS = (155, 156)
HWY_COLS = (231, 232)
MILLBROOK_IDS = ("cityhall", "office", "hospital", "cafe", "arcade", "bank", "school", "diner", "market", "bakery",
                 "grocer", "noodles", "works", "park", "maple_park", "square", "green")  # v2's non-home places


def block_x(c):
    x0 = COLS[c] + 1
    x1 = (COLS[c + 1] - 1) if c + 1 < len(COLS) else W - 1
    return x0, x1


def block_rows():
    tops = list(NORTH_ROWS) + list(SOUTH_ROWS)
    ends = [13, 24, 35, 44, 61, 72, 83, 94, 105, 116, 127, 138, 149, 154]
    return [(r, a + 1, b) for r, (a, b) in enumerate(zip(tops, ends))]


BLOCK_ROWS = block_rows()  # r 0-3 north bank (y 4-44), r 4-12 south bank (y 52-149), r 13 y 151-154

DISTRICTS = [  # id, name, about, block ranges (c0, c1, r0, r1)
    ("northgate", "Northgate", "row houses and flats across Mill Road", [(6, 10, 0, 3)]),
    ("the_heights", "The Heights", "big houses on the north slope", [(11, 14, 0, 2)]),
    ("north_woods", "North Woods", "woods and Mill Lake", [(15, 19, 0, 3), (11, 14, 3, 3)]),
    ("quayside", "Quayside", "terraces and flats on the south bank", [(0, 7, 4, 6)]),
    ("downtown_riverton", "Riverton Downtown", "towers, Central Station, St. Luke's", [(8, 12, 4, 7)]),
    ("midtown", "Midtown", "high-rise flats and the shopping strip", [(13, 15, 4, 7)]),
    ("ironworks", "Ironworks", "factories, warehouses and the freight yard", [(16, 19, 4, 10)]),
    ("willow_hills", "Willow Hills", "suburban houses with gardens", [(0, 7, 7, 12)]),
    ("southfield", "Southfield", "houses, schools, the stadium", [(8, 15, 8, 12)]),
    ("greenacre", "Greenacre", "farms and fields", [(0, 19, 13, 13)]),
]


def district_of_block(c, r):
    for did, _, _, rects in DISTRICTS:
        for c0, c1, r0, r1 in rects:
            if c0 <= c <= c1 and r0 <= r <= r1:
                return did
    return ""


# --- the railway: two double-track lines, each track a polyline of tile corners, buffer to buffer -----------------
LINES = [
    {"id": "R", "name": "Riverton Line", "trains": 6, "every": 10, "cars": 2, "capacity": 120, "speed": 10,
     "dwell": 1, "layover": 3, "fare": 3,
     "tracks": {"out": [(70, 33), (112, 33), (112, 68), (223, 68)], "in": [(223, 67), (113, 67), (113, 32), (70, 32)]},
     "stations": ["millbrook_station", "northgate_station", "quayside_station", "central_station", "midtown_station",
                  "ironworks_station"]},
    {"id": "S", "name": "Southfield Line", "trains": 4, "every": 10, "cars": 2, "capacity": 120, "speed": 10,
     "dwell": 1, "layover": 3, "fare": 3,
     "tracks": {"out": [(124, 74), (124, 111), (43, 111)], "in": [(43, 112), (125, 112), (125, 74)]},
     "stations": ["central_station", "southfield_station", "fairview_station", "willow_hills_station"]},
]
STATIONS = [  # id, name, district, building (x, y, w, h), face, {line: (platform rects beside out, beside in)}
    ("millbrook_station", "Millbrook Station", "the_works", (71, 27, 7, 3), "n",
     {"R": ((70, 34, 10, 1), (70, 31, 10, 1))}),
    ("northgate_station", "Northgate", "northgate", (97, 27, 7, 3), "n", {"R": ((96, 34, 10, 1), (96, 31, 10, 1))}),
    ("quayside_station", "Quayside", "quayside", (109, 54, 2, 5), "w", {"R": ((111, 53, 1, 8), (114, 53, 1, 8))}),
    ("central_station", "Riverton Central", "downtown_riverton", (122, 70, 10, 2), "s",
     {"R": ((121, 69, 12, 1), (121, 66, 12, 1)), "S": ((123, 75, 1, 8), (126, 75, 1, 8))}),
    ("midtown_station", "Midtown", "midtown", (174, 70, 10, 2), "s", {"R": ((173, 69, 12, 1), (173, 66, 12, 1))}),
    ("ironworks_station", "Ironworks", "ironworks", (213, 70, 10, 2), "s",
     {"R": ((212, 69, 12, 1), (212, 66, 12, 1))}),
    ("southfield_station", "Southfield", "southfield", (128, 98, 4, 5), "e", {"S": ((123, 97, 1, 8), (126, 97, 1, 8))}),
    ("fairview_station", "Fairview", "willow_hills", (85, 108, 6, 2), "n", {"S": ((82, 110, 12, 1), (82, 113, 12, 1))}),
    ("willow_hills_station", "Willow Hills", "willow_hills", (46, 108, 6, 2), "n",
     {"S": ((44, 110, 11, 1), (44, 113, 11, 1))}),
]
STATION_BY_ID = {s[0]: s for s in STATIONS}
EXITS = {  # station -> STREET tiles where riders enter and leave (the entry's street tile first); 1 minute to a platform
    "millbrook_station": [(74, 25), (74, 36)], "northgate_station": [(100, 25), (100, 36)],
    "quayside_station": [(107, 56), (120, 57)], "central_station": [(127, 73), (126, 62)],
    "midtown_station": [(179, 73), (178, 62)], "ironworks_station": [(218, 73), (217, 62)],
    "southfield_station": [(133, 100), (120, 100)], "fairview_station": [(88, 106), (88, 117)],
    "willow_hills_station": [(49, 106), (49, 117)]}
PLATFORM_MINUTES = 1


def track_tiles(corners):
    out = [tuple(corners[0])]
    for (x0, y0), (x1, y1) in zip(corners, corners[1:]):
        dx, dy = (x1 > x0) - (x1 < x0), (y1 > y0) - (y1 < y0)
        x, y = x0, y0
        while (x, y) != (x1, y1):
            x, y = x + dx, y + dy
            out.append((x, y))
    return out


def stop_index(tiles, rect):
    """Track index where a train's head stands at a station: the track tile beside the platform's middle tile."""
    x, y, w, h = rect
    mx, my = x + (w - 1) // 2, y + (h - 1) // 2
    for i, (tx, ty) in enumerate(tiles):
        if abs(tx - mx) + abs(ty - my) == 1:
            return i
    raise ValueError(rect)


def street_tiles(tiles):
    for y in NORTH_ROWS:
        for x in range(FROZEN_W, W):
            tiles[y][x] = ROAD
    for x in REGION_COLS:
        for y in range(0, 45):
            tiles[y][x] = ROAD
    for y in SOUTH_ROWS:
        for x in range(W):
            tiles[y][x] = ROAD
    for x in COLS:
        for y in range(51, 151):
            tiles[y][x] = ROAD
    for x in BRIDGE_COLS:
        tiles[45][x] = ROAD
        for y in RIVER_ROWS:
            tiles[y][x] = BRIDGE
        tiles[50][x] = ROAD
    for x in INTERCHANGE_COLS:
        for y in range(151, 173):
            tiles[y][x] = ROAD
    for y in FARM_ROWS:
        for x in range(W):
            tiles[y][x] = ROAD


def highway(tiles):
    for y in HWY_ROWS:
        for x in range(W):
            tiles[y][x] = ROAD if tiles[y][x] == ROAD else HIGHWAY
    for x in HWY_COLS:
        for y in range(0, HWY_ROWS[-1] + 1):
            c = tiles[y][x]
            tiles[y][x] = ROAD if c == ROAD else HIGHWAY_BRIDGE if c == WATER else HIGHWAY


def rail(tiles):
    for line in LINES:
        for corners in line["tracks"].values():
            for x, y in track_tiles(corners):
                c = tiles[y][x]
                tiles[y][x] = CROSSING if c in (ROAD, CROSSING) else RAIL_BRIDGE if c in (WATER, BRIDGE) else \
                    c if c in (HIGHWAY, HIGHWAY_BRIDGE) else RAIL
    for _, _, _, _, _, plats in STATIONS:
        for rects in plats.values():
            for x0, y0, w, h in rects:
                for y in range(y0, y0 + h):
                    for x in range(x0, x0 + w):
                        if tiles[y][x] == GRASS:
                            tiles[y][x] = PLATFORM


def stamp(tiles, x, y, w, h, face):
    if x < 1 or y < 1 or x + w >= W or y + h >= H:
        return None
    for yy in range(y, y + h):
        for xx in range(x, x + w):
            if tiles[yy][xx] != GRASS:
                return None
    if face == "s":
        door, entry = (x + w // 2, y + h - 1), (x + w // 2, y + h)
    elif face == "n":
        door, entry = (x + w // 2, y), (x + w // 2, y - 1)
    elif face == "e":
        door, entry = (x + w - 1, y + h // 2), (x + w, y + h // 2)
    else:
        door, entry = (x, y + h // 2), (x - 1, y + h // 2)
    if tiles[entry[1]][entry[0]] != GRASS:
        return None
    ex, ey = entry
    if not any(tiles[ey + dy][ex + dx] in STREET for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))):
        return None  # an entry always touches a street (v2's invariant)
    for yy in range(y, y + h):
        for xx in range(x, x + w):
            tiles[yy][xx] = BUILDING
    tiles[door[1]][door[0]] = DOOR
    tiles[entry[1]][entry[0]] = ENTRY
    return entry


def h2(x, y):
    h = (x * 374761393 + y * 668265263) & 0xffffffff
    h = ((h ^ (h >> 13)) * 1274126177) & 0xffffffff
    return h ^ (h >> 16)


OFFICE_NAMES = ["Kessler Insurance", "Northwind Logistics", "Apex Media", "Halberd Law", "Crown Telecom",
                "Meridian Bank", "Lumen Software", "Atlas Engineering", "Riverton Gazette", "Sterling Partners",
                "Orbit Games", "Harbor Shipping", "Pinnacle Health", "Granite Capital", "Vela Analytics",
                "Quarry & Sons", "Bluefin Foods", "Copperline Energy", "Juniper Design", "Tidewater Trust"]
SHOP_NAMES = ["Hardware", "Books", "Shoes", "Electronics", "Pharmacy", "Florist", "Toys", "Boutique",
              "Sports", "Music", "Furniture", "Pet Shop"]
CAFE_NAMES = ["Espresso Bar", "Tea Room", "Pizzeria", "Taqueria", "Sushi Bar", "Bistro", "Burger Joint",
              "Falafel House", "Steakhouse", "Dumpling House", "Bagel Shop", "Ice Cream Parlour"]
WORKS_NAMES = ["Riverton Steel", "Ironworks Foundry", "Valley Plastics", "Crate & Co. Warehouse",
               "Delta Freight Depot", "Brightwater Brewery", "Sunrise Bakery Plant", "Kepler Motors",
               "Anvil Tools", "Riverside Printing"]
COND = {"the_heights": (80, 15), "willow_hills": (65, 25), "southfield": (55, 30), "northgate": (45, 35),
        "quayside": (40, 35), "downtown_riverton": (60, 30), "midtown": (60, 30), "ironworks": (30, 30),
        "east_woods": (70, 20)}  # lot condition: base + hash % span

# Prices (region.json "prices"): multipliers on the base value and rent, by district, applied by region.py at load
PRICES = {"districts": {"northgate": [1.0, 1.0], "the_heights": [2.0, 1.5], "north_woods": [1.2, 1.1],
                        "quayside": [0.9, 1.0], "downtown_riverton": [1.3, 1.4], "midtown": [1.2, 1.4],
                        "ironworks": [0.7, 0.7], "willow_hills": [1.1, 1.0], "southfield": [1.0, 0.95],
                        "east_woods": [1.1, 1.1]},
          "station": {"tiles": 15, "value": 1.15, "rent": 1.10},
          "condition_rent": [0.6, 0.4]}  # rent when listed = rent * (0.6 + 0.4 * condition / 100)

MILLBROOK_JOBS = [  # folk rows at Millbrook's own places: (title, place, wage, start, end, days, count)
    ("nurse", "hospital", 30, 7, 15, (0, 1, 2, 3, 4, 5, 6), 10), ("nurse", "hospital", 30, 15, 23, (0, 1, 2, 3, 4, 5, 6), 10),
    ("porter", "hospital", 19, 7, 15, (0, 1, 2, 3, 4), 4), ("receptionist", "hospital", 20, 8, 16, (0, 1, 2, 3, 4), 4),
    ("cleaner", "hospital", 16, 14, 22, (0, 1, 2, 3, 4), 4),
    ("developer", "office", 38, 9, 17, (0, 1, 2, 3, 4), 14), ("support agent", "office", 24, 8, 16, (0, 1, 2, 3, 4), 6),
    ("office manager", "office", 30, 9, 17, (0, 1, 2, 3, 4), 2), ("cleaner", "office", 16, 14, 22, (0, 1, 2, 3, 4), 2),
    ("machine operator", "works", 23, 6, 14, (0, 1, 2, 3, 4), 10), ("machine operator", "works", 23, 14, 22, (0, 1, 2, 3, 4), 10),
    ("forklift driver", "works", 21, 7, 15, (0, 1, 2, 3, 4), 4), ("engineer", "works", 40, 8, 16, (0, 1, 2, 3, 4), 2),
    ("teacher", "school", 28, 7, 15, (0, 1, 2, 3, 4), 6), ("teaching assistant", "school", 19, 8, 15, (0, 1, 2, 3, 4), 3),
    ("caretaker", "school", 18, 7, 15, (0, 1, 2, 3, 4), 1),
    ("barista", "cafe", 17, 6, 14, (0, 1, 2, 3, 4, 5), 2), ("barista", "cafe", 17, 14, 22, (0, 1, 2, 3, 4, 5), 2),
    ("cook", "diner", 20, 6, 14, (0, 1, 2, 3, 4, 5), 2), ("waiter", "diner", 16, 14, 22, (0, 1, 2, 3, 4, 5), 2),
    ("baker", "bakery", 19, 6, 14, (0, 1, 2, 3, 4, 5), 2), ("sales assistant", "bakery", 17, 10, 18, (1, 2, 3, 4, 5), 1),
    ("cook", "noodles", 20, 11, 19, (1, 2, 3, 4, 5), 2), ("waiter", "noodles", 16, 15, 23, (1, 2, 3, 4, 5), 2),
    ("cashier", "market", 17, 7, 15, (0, 1, 2, 3, 4, 5), 3), ("cashier", "market", 17, 13, 21, (0, 1, 2, 3, 4, 5), 3),
    ("stock clerk", "market", 17, 6, 14, (0, 1, 2, 3, 4), 2),
    ("cashier", "grocer", 17, 7, 15, (0, 1, 2, 3, 4, 5), 2), ("cashier", "grocer", 17, 14, 22, (0, 1, 2, 3, 4, 5), 2),
    ("shop assistant", "arcade", 17, 9, 17, (0, 1, 2, 3, 4, 5), 4), ("shop assistant", "arcade", 17, 13, 21, (1, 2, 3, 4, 5), 3),
    ("teller", "bank", 22, 9, 17, (0, 1, 2, 3, 4), 4), ("advisor", "bank", 30, 9, 17, (0, 1, 2, 3, 4), 2),
    ("clerk", "cityhall", 24, 8, 16, (0, 1, 2, 3, 4), 5), ("inspector", "cityhall", 28, 9, 17, (0, 1, 2, 3, 4), 1),
    ("gardener", "park", 18, 7, 15, (0, 1, 2, 3, 4), 1), ("gardener", "maple_park", 18, 7, 15, (0, 1, 2, 3, 4), 1),
    ("gardener", "square", 18, 7, 15, (0, 1, 2, 3, 4), 1), ("gardener", "green", 18, 7, 15, (0, 1, 2, 3, 4), 2),
]
CIVIC_STAFF = {  # kind -> rows (title, wage, start, end, days, count)
    "hospital": [("nurse", 30, 7, 15, (0, 1, 2, 3, 4, 5, 6), 20), ("nurse", 30, 15, 23, (0, 1, 2, 3, 4, 5, 6), 20),
                 ("doctor", 55, 8, 18, (0, 1, 2, 3, 4), 8), ("porter", 19, 7, 15, (0, 1, 2, 3, 4), 6),
                 ("cleaner", 16, 14, 22, (0, 1, 2, 3, 4), 6)],
    "townhall": [("clerk", 24, 8, 16, (0, 1, 2, 3, 4), 10), ("officer", 28, 9, 17, (0, 1, 2, 3, 4), 4)],
    "bank": [("teller", 22, 9, 17, (0, 1, 2, 3, 4), 8), ("advisor", 30, 9, 17, (0, 1, 2, 3, 4), 6)],
    "shop": [("sales assistant", 17, 9, 17, (0, 1, 2, 3, 4, 5), 12), ("sales assistant", 17, 13, 21, (1, 2, 3, 4, 5), 8)],
    "market": [("cashier", 17, 7, 15, (0, 1, 2, 3, 4, 5), 6), ("cashier", 17, 14, 22, (0, 1, 2, 3, 4, 5), 6)],
    "school": [("teacher", 28, 7, 15, (0, 1, 2, 3, 4), 12), ("teaching assistant", 19, 8, 15, (0, 1, 2, 3, 4), 4)],
    "venue": [("attendant", 17, 12, 20, (1, 2, 3, 4, 5, 6), 8), ("manager", 30, 10, 18, (0, 1, 2, 3, 4), 2)],
    "office": [("receptionist", 20, 7, 15, (0, 1, 2, 3, 4, 5, 6), 8), ("housekeeper", 17, 8, 16, (0, 1, 2, 3, 4, 5, 6), 12),
               ("manager", 40, 9, 17, (0, 1, 2, 3, 4), 4)],
}


class Gen:
    def __init__(self):
        self.tiles = [[GRASS] * W for _ in range(H)]
        self.places, self.homes, self.jobs, self.decor = [], [], [], []
        self.lots = {}
        self.rng = Rng(0x5EED_3)
        self.n = {}
        self.station_entries = []
        self.exit_tiles = [e for v in EXITS.values() for e in v]

    def nid(self, prefix):
        self.n[prefix] = self.n.get(prefix, 0) + 1
        return f"{prefix}_{self.n[prefix]}"

    def place(self, pid, name, kind, style, x, y, w, h, face, floors, hours, district, tier=None, units=0,
              capacity=0):
        entry = stamp(self.tiles, x, y, w, h, face)
        if entry is None:
            return None
        self.places.append({"id": pid, "name": name, "kind": kind, "x": x, "y": y, "w": w, "h": h,
                            "entry": list(entry), "face": face, "hours": list(hours) if hours else None,
                            "district": district, "style": style, "floors": floors, "tier": tier,
                            "units": units, "capacity": capacity})
        return self.places[-1]

    def park(self, pid, name, x, y, w, h, district, density=0.12):
        for yy in range(y, y + h):
            for xx in range(x, x + w):
                if self.tiles[yy][xx] == GRASS:
                    self.tiles[yy][xx] = PARK
        entry = (x + w // 2, y)
        for yy in range(y, y + h):
            for xx in range(x, x + w):
                if self.tiles[yy][xx] == PARK and abs(xx - entry[0]) + abs(yy - entry[1]) > 1 and \
                        self.rng.random() < density:
                    self.tiles[yy][xx] = TREE
        self.tiles[entry[1]][entry[0]] = ENTRY
        self.places.append({"id": pid, "name": name, "kind": "park", "x": x, "y": y, "w": w, "h": h,
                            "entry": list(entry), "face": None, "hours": None, "district": district,
                            "style": "park", "floors": 0, "tier": None, "units": 0, "capacity": 100})

    def homes_for(self, p, tier, beds_cycle, base, rent_wk, start="let"):
        n = p["units"]
        for i in range(n):
            if n == 1:
                hid, unit = p["id"], None
            else:
                floor, letter = i // 2 + 1, "ab"[i % 2] if p["tier"] == "flat" else str(i + 1)
                unit = f"{floor}{letter.upper()}" if p["tier"] == "flat" else letter
                hid = f"{p['id']}_{unit.lower()}"
            beds = beds_cycle[i % len(beds_cycle)]
            st = start(i) if callable(start) else start
            self.homes.append([hid, p["id"], unit, tier, beds, base + 1600 * beds, rent_wk + 40 * beds, st, None])
        b, span = COND.get(p["district"], (60, 30))
        self.lots[p["id"]] = b + h2(p["x"], p["y"]) % span

    def job(self, title, place, wage, start, end, count, days=(0, 1, 2, 3, 4)):
        self.jobs.append([title, place, wage, start, end, list(days), count])

    def near_station(self, x, y, d):
        return any(abs(ex - x) + abs(ey - y) <= d for ex, ey in self.station_entries)


def split_of(t, x0, y0, x1, y1):
    """'h' when a track runs across the block, 'v' when one runs down it, else None."""
    rails = [(x, y) for y in range(y0, y1 + 1) for x in range(x0, x1 + 1) if t[y][x] in "=rx"]
    if not rails:
        return None
    xs = {x for x, _ in rails}
    return "h" if len(xs) > 4 else "v"


def p_houses(g, c, r, did, x0, y0, bw, bh, big=False):
    if big:
        for i in range(2):
            x, y = x0 + 1 + 6 * i, y0 + 1
            p = g.place(g.nid(f"{did}_villa"), "", "home", "big_house", x, y, 5, 4, "n", 2, None, did, "big_house", 1)
            if p:
                g.homes_for(p, "big_house", [5], 30000, 600, "for_sale" if g.rng.random() < 0.15 else "owned")
        p_green(g, c, r, did, x0, y0 + 6, bw, bh - 6, 0.25)
        return
    for i in range(2):
        for top in (True, False):
            x, y = x0 + 1 + 6 * i, (y0 + 1 if top else y0 + bh - 4)
            p = g.place(g.nid(f"{did}_house"), "", "home", "house", x, y, 4, 3, "n" if top else "s", 1, None, did,
                        "house", 1)
            if p:
                g.homes_for(p, "house", [3, 2, 4], 11000, 300, "let" if g.rng.random() < 0.5 else "owned")
    p_green(g, c, r, did, x0, y0 + 4, bw, bh - 8, 0.15)


def p_rows(g, c, r, did, x0, y0, bw, bh):
    for top in (True, False):
        y = y0 + 1 if top else y0 + bh - 4
        p = g.place(g.nid(f"{did}_terrace"), "", "home", "row_houses", x0 + 1, y, min(9, bw - 2), 3,
                    "n" if top else "s", 2, None, did, "house", 3)
        if p:
            g.homes_for(p, "house", [2, 3, 2], 9000, 260, "let")


def p_flats(g, c, r, did, x0, y0, bw, bh, floors=4):
    p = g.place(g.nid(f"{did}_flats"), "", "home", "apartments", x0 + 1, y0 + 1, 10, 4, "n", floors, None, did,
                "flat", floors * 2)
    if p:
        g.homes_for(p, "flat", [1, 2, 2, 3], 5000, 150, "let")
    p_green(g, c, r, did, x0, y0 + 6, bw, bh - 6, 0.2)


def p_flats2(g, c, r, did, x0, y0, bw, bh):
    """Two blocks of flats, one on each street (dense residential next to a station)."""
    for top in (True, False):
        y = y0 + 1 if top else y0 + bh - 5
        p = g.place(g.nid(f"{did}_flats"), "", "home", "apartments", x0 + 1, y, 10, 4, "n" if top else "s", 5,
                    None, did, "flat", 10)
        if p:
            g.homes_for(p, "flat", [1, 2, 2, 3, 2], 5000, 150, "let")


def p_dense(g, c, r, did, x0, y0, bw, bh):
    """A station block: a 4-floor block of flats on the north street, a 10-floor tower and a shop or cafe on the
    south one (28 homes)."""
    p = g.place(g.nid(f"{did}_flats"), "", "home", "apartments", x0 + 1, y0 + 1, 10, 3, "n", 4, None, did, "flat", 8)
    if p:
        g.homes_for(p, "flat", [1, 2, 2, 3], 5000, 150, "let")
    p = g.place(g.nid(f"{did}_tower"), "", "home", "residential_tower", x0 + 1, y0 + bh - 6, 5, 5, "s", 10,
                None, did, "flat", 20)
    if p:
        g.homes_for(p, "flat", [1, 2, 2, 3, 1], 6000, 170, "let")
    _shop_or_cafe(g, did, x0 + 7, y0 + bh - 4, 4, 3, "s")


def p_tower(g, c, r, did, x0, y0, bw, bh, floors=12):
    p = g.place(g.nid(f"{did}_tower"), "", "home", "residential_tower", x0 + 2, y0 + bh - 7, 8, 6, "s", floors, None,
                did, "flat", floors * 2)
    if p:
        g.homes_for(p, "flat", [1, 2, 2, 3], 6000, 170, "let")


def p_green(g, c, r, did, x0, y0, bw, bh, density=0.2):
    for y in range(y0, y0 + bh):
        for x in range(x0, x0 + bw):
            if g.tiles[y][x] == GRASS and g.rng.random() < density:
                g.tiles[y][x] = TREE


def _office(g, did, x, y, w, h, face, floors):
    name = OFFICE_NAMES[g.n.get("office", 0) % len(OFFICE_NAMES)]
    pid = g.nid("office")
    p = g.place(pid, name, "office", "tower", x, y, w, h, face, floors, (7, 20), did, capacity=10 * floors)
    if p:
        n = 10 + floors
        g.job("office worker", pid, 34, 9, 17, n * 6 // 10)
        g.job("manager", pid, 55, 9, 18, max(1, n // 10))
        g.job("receptionist", pid, 20, 8, 16, max(1, n // 10))
        g.job("cleaner", pid, 16, 14, 22, max(1, n // 10))
    return p


def p_office(g, c, r, did, x0, y0, bw, bh):
    for i in range(2):
        _office(g, did, x0 + 1 + 6 * i, y0 + bh - 7, 5, 6, "s", 8 + g.rng.int(0, 22))
    p_strip_top(g, c, r, did, x0, y0, bw, bh)


def p_strip_top(g, c, r, did, x0, y0, bw, bh):
    for i in (0, 2):
        x, y = x0 + 1 + 5 * i // 2 * 2, y0 + 1
        pid = g.nid("cafe")
        p = g.place(pid, CAFE_NAMES[g.n["cafe"] % len(CAFE_NAMES)], "cafe", "cafe", x, y, 4, 2, "n", 1, (7, 19), did,
                    capacity=30)
        if p:
            g.job("barista", pid, 17, 7, 15, 2, (0, 1, 2, 3, 4))


def p_strip(g, c, r, did, x0, y0, bw, bh):
    for i in (0, 2):
        for top in (True, False):
            x, y = x0 + 4 * i, (y0 + 1 if top else y0 + bh - 4)
            _shop_or_cafe(g, did, x, y, 4, 3, "n" if top else "s")


def _shop_or_cafe(g, did, x, y, w, h, face):
    if g.rng.random() < 0.45:
        pid = g.nid("cafe")
        p = g.place(pid, CAFE_NAMES[g.n["cafe"] % len(CAFE_NAMES)], "cafe", "restaurant", x, y, w, h, face, 2,
                    (7, 23), did, capacity=40)
        if p:
            g.job("waiter", pid, 16, 11, 19, 2, (1, 2, 3, 4, 5))
            g.job("cook", pid, 20, 15, 23, 1, (2, 3, 4, 5, 6))
    else:
        pid = g.nid("shop")
        p = g.place(pid, SHOP_NAMES[g.n["shop"] % len(SHOP_NAMES)], "shop", "shop", x, y, w, h, face, 2, (9, 20), did,
                    capacity=30)
        if p:
            g.job("shop assistant", pid, 17, 9, 17, 2, (0, 1, 2, 3, 4, 5))


def p_vsplit(g, c, r, did, x0, y0, bw, bh):
    """A block a track runs down: lots on the side facing the avenue to the east, stacked."""
    t = g.tiles
    xs = [x for x in range(x0, x0 + bw) if any(t[y][x] in "=rxS" for y in range(y0, y0 + bh))]
    east = max(xs) + 1
    w = x0 + bw - 1 - east  # leave the last column for the entry
    if w < 3:
        return
    for k, y in enumerate(range(y0 + 1, y0 + bh - 2, 4)):
        if did in ("downtown_riverton", "midtown") and k % 2 == 0:
            _office(g, did, east, y, w, 3, "e", 6 + h2(east, y) % 8)
        else:
            _shop_or_cafe(g, did, east, y, w, 3, "e")


def p_works(g, c, r, did, x0, y0, bw, bh):
    name = WORKS_NAMES[g.n.get("works", 0) % len(WORKS_NAMES)]
    pid = g.nid("works")
    p = g.place(pid, name, "works", "factory", x0 + 1, y0 + bh - 8, 10, 7, "s", 2, (6, 22), did, capacity=120)
    if p:
        g.job("machine operator", pid, 23, 6, 14, 14)
        g.job("machine operator", pid, 23, 14, 22, 12)
        g.job("forklift driver", pid, 21, 7, 15, 6)
        g.job("engineer", pid, 40, 8, 16, 3)


def p_woods(g, c, r, did, x0, y0, bw, bh, density=0.45):
    for y in range(y0, y0 + bh):
        for x in range(x0, x0 + bw):
            if g.tiles[y][x] == GRASS and g.rng.random() < density:
                g.tiles[y][x] = TREE


def p_farm(g, c, r, did, x0, y0, bw, bh):
    for y in range(y0, y0 + bh):
        for x in range(x0, x0 + bw):
            if g.tiles[y][x] == GRASS:
                g.tiles[y][x] = FARM


def mix(*fs):
    def f(g, c, r, did, x0, y0, bw, bh):
        fs[(c * 7 + r * 3) % len(fs)](g, c, r, did, x0, y0, bw, bh)
    return f


RESIDENTIAL = {"northgate", "quayside", "willow_hills", "southfield"}
NEAR = 20  # Manhattan tiles from a block's centre to a station entry: station-side recipes
PATTERN = {  # district -> (recipe within NEAR of a station, recipe elsewhere); a block touching an exit: p_dense
    "northgate": (mix(p_rows, p_flats, p_houses, p_strip, p_green), mix(p_rows, p_flats, p_houses, p_strip, p_green)),
    "the_heights": (lambda *a: p_houses(*a, big=True), lambda *a: p_houses(*a, big=True)),
    "north_woods": (p_woods, p_woods),
    "quayside": (mix(p_rows, p_flats, p_strip, p_houses, p_green), mix(p_rows, p_flats, p_strip, p_houses, p_green, p_woods)),
    "downtown_riverton": (p_office, mix(p_tower, p_strip, p_office, p_tower)),
    "midtown": (mix(p_office, p_tower, p_office), mix(p_tower, p_strip, p_flats, p_green, p_office)),
    "ironworks": (p_works, mix(p_works, p_works, p_woods, p_works, p_green)),
    "willow_hills": (mix(p_houses, p_green, p_rows, p_strip), mix(p_houses, p_green, p_woods, p_houses, p_green, p_woods)),
    "southfield": (mix(p_houses, p_rows, p_strip, p_green), mix(p_houses, p_green, p_woods, p_strip, p_houses, p_green)),
    "greenacre": (p_farm, p_farm),
}


def fill_block(g, c, r, did):
    x0, x1 = block_x(c)
    _, y0, y1 = BLOCK_ROWS[r]
    bw, bh = x1 - x0 + 1, y1 - y0 + 1
    if did not in PATTERN:
        return
    split = split_of(g.tiles, x0, y0, x1, y1)
    if split == "v":
        return p_vsplit(g, c, r, did, x0, y0, bw, bh)
    near = g.near_station((x0 + x1) // 2, (y0 + y1) // 2, NEAR)
    pattern = PATTERN[did][0 if near else 1]
    touch = any(x0 - 1 <= ex <= x1 + 1 and y0 - 1 <= ey <= y1 + 1 for ex, ey in g.exit_tiles)
    if split == "h":
        pattern = p_strip if did in ("downtown_riverton", "midtown", "ironworks") else mix(p_rows, p_strip, p_rows)
    elif touch and did in RESIDENTIAL:
        pattern = p_dense
    if r <= 3 and c in (6, 7):  # Millbrook's nearest cafe, shop or park stays Millbrook's: homes only
        pattern = p_flats2 if touch and not split else mix(p_rows, p_flats, p_houses, p_flats2) if not split else p_rows
    pattern(g, c, r, did, x0, y0, bw, bh)


CIVIC = [  # id, name, kind, style, block (c, r), rect within block (dx, dy, w, h), face, floors, hours, capacity
    ("st_lukes", "St. Luke's Hospital", "hospital", "hospital", (10, 6), (1, 1, 10, 7), "s", 6, None, 200),
    ("civic_center", "Riverton Civic Center", "townhall", "city_hall", (10, 4), (2, 1, 8, 5), "s", 4, (8, 17), 120),
    ("riverton_bank", "Riverton Savings & Loan", "bank", "bank", (11, 4), (3, 2, 6, 5), "s", 6, (9, 17), 60),
    ("dept_store", "Hartley's Department Store", "shop", "arcade", (11, 7), (1, 1, 10, 6), "s", 4, (9, 21), 200),
    ("supermarket_s", "Southfield Supermarket", "market", "market", (12, 8), (1, 1, 8, 5), "s", 1, (7, 22), 120),
    ("quay_market", "Quayside Market", "market", "market", (3, 5), (1, 1, 6, 4), "s", 1, (7, 21), 80),
    ("north_market", "Northgate Grocer", "market", "corner_shop", (8, 1), (1, 1, 4, 3), "n", 1, (7, 22), 30),
    ("willow_market", "Willow Farm Shop", "market", "corner_shop", (5, 10), (1, 1, 6, 3), "n", 1, (7, 21), 40),
    ("primary_n", "Northgate Primary", "school", "school", (9, 2), (1, 1, 10, 5), "s", 2, (7, 17), 180),
    ("primary_s", "Southfield Primary", "school", "school", (10, 9), (1, 1, 10, 5), "s", 2, (7, 17), 180),
    ("primary_q", "Quayside Primary", "school", "school", (2, 4), (1, 1, 10, 5), "s", 2, (7, 17), 180),
    ("primary_w", "Willow Hills Primary", "school", "school", (2, 11), (1, 1, 10, 5), "s", 2, (7, 17), 180),
    ("high_school", "Riverton High", "school", "school", (10, 8), (1, 1, 9, 7), "w", 3, (7, 17), 300),
    ("stadium", "Riverton Stadium", "venue", "stadium", (14, 10), (0, 0, 12, 9), "s", 3, (12, 23), 2000),
    ("cinema", "Roxy Cinema", "venue", "cinema", (12, 6), (1, 1, 8, 5), "s", 2, (14, 24), 150),
    ("hotel", "Grand River Hotel", "office", "hotel", (11, 6), (1, 1, 9, 6), "s", 14, None, 80),
    ("library", "Riverton Library", "townhall", "library", (8, 6), (1, 1, 8, 5), "s", 2, (9, 19), 60),
    ("police", "Riverton Police", "townhall", "police", (12, 7), (1, 1, 6, 4), "s", 2, None, 40),
    ("fire", "Fire Station 2", "townhall", "fire_station", (6, 10), (1, 1, 6, 4), "s", 2, None, 20),
    ("mall", "Southgate Mall", "shop", "mall", (11, 11), (0, 1, 12, 8), "s", 2, (9, 21), 400),
    ("golf", "Pine Ridge Golf Club", "venue", "clubhouse", (15, 2), (1, 1, 5, 3), "s", 2, (7, 20), 40),
]
PARKS = [  # id, name, block (c, r), district
    ("central_park", "Riverton Common", (12, 4), "downtown_riverton"),
    ("quay_park", "Quay Gardens", (5, 4), "quayside"),
    ("north_park", "Northgate Green", (7, 2), "northgate"),
    ("south_park", "Southfield Park", (9, 10), "southfield"),
    ("willow_park", "Willow Hills Park", (1, 10), "willow_hills"),
    ("heights_park", "Heights Overlook", (12, 1), "the_heights"),
]
EAST_FLATS = [("mill_court", "Mill Court", (70, 5, 8, 4), "n"), ("ridge_court", "Ridge Court", (70, 9, 8, 4), "s"),
              ("park_court", "Park Court", (70, 16, 8, 4), "n"), ("station_court", "Station Court", (70, 21, 8, 3), "s")]

DECOR = {  # district -> (w, h, style, floor range) tried in order at each spot; the hash picks the first to try
    "downtown_riverton": [(4, 4, "tower", (12, 30)), (5, 5, "tower", (14, 30)), (5, 4, "apartments", (6, 10)),
                          (3, 3, "shop", (2, 3))],
    "midtown": [(6, 4, "apartments", (4, 8)), (5, 5, "residential_tower", (10, 16)), (4, 4, "tower", (8, 14)),
                (3, 3, "shop", (2, 2))],
    "ironworks": [(8, 5, "factory", (2, 2)), (6, 4, "warehouse", (1, 1)), (4, 3, "warehouse", (1, 1))],
    "quayside": [(6, 3, "row_houses", (2, 2)), (6, 4, "apartments", (4, 5)), (3, 3, "house", (1, 2))],
    "northgate": [(6, 3, "row_houses", (2, 2)), (3, 3, "house", (1, 2))],
    "southfield": [(3, 3, "house", (1, 2)), (4, 3, "house", (1, 1)), (6, 3, "row_houses", (2, 2))],
    "willow_hills": [(3, 3, "house", (1, 2)), (4, 3, "house", (1, 1))],
    "the_heights": [(4, 4, "big_house", (2, 2))],
}
DECOR_BLOCKERS = set("eDS=xrhH")
DENSE = {"downtown_riverton", "midtown", "ironworks"}


def decorate(g):
    """view.md 4.1's decor pass: buildings with no sim role on empty urban grass, stamped B, never beside an entry,
    door, platform, track, crossing or highway (one-tile margin), never in Millbrook or the strip x 69-79."""
    t = g.tiles
    for r, y0, y1 in BLOCK_ROWS:
        for c in range(len(COLS)):
            x0, x1 = block_x(c)
            if r <= 3 and x1 < FROZEN_W or r <= 3 and c == 5:
                continue
            did = district_of_block(c, r)
            rec = DECOR.get(did)
            if not rec:
                continue
            for y in range(y0, y1 + 1):
                for x in range(x0, x1 + 1):
                    if t[y][x] not in ".T":
                        continue
                    k = h2(x, y)
                    for j in range(len(rec)):
                        w, hh, style, (f0, f1) = rec[(k + j) % len(rec)]
                        if x + w - 1 > x1 or y + hh - 1 > y1:
                            continue
                        cells = [t[yy][xx] for yy in range(y, y + hh) for xx in range(x, x + w)]
                        ok = all(ch in ".T" for ch in cells) and (did in DENSE or 3 * cells.count("T") <= len(cells))
                        if ok:
                            for yy in range(max(0, y - 1), min(H, y + hh + 1)):
                                for xx in range(max(0, x - 1), min(W, x + w + 1)):
                                    if t[yy][xx] in DECOR_BLOCKERS:
                                        ok = False
                        if not ok:
                            continue
                        floors = f0 + (k >> 8) % (f1 - f0 + 1)
                        g.decor.append([x, y, w, hh, style, floors, (k >> 4) % 8])
                        for yy in range(y, y + hh):
                            for xx in range(x, x + w):
                                t[yy][xx] = BUILDING
                        break


def farmsteads(g):
    """A farmhouse and a barn every 24 tiles north of the farm lane (y 172): decor, on farmland only."""
    t = g.tiles
    for x in range(6, 250, 24):
        for dx, w, style in ((0, 3, "house"), (4, 4, "warehouse")):
            cells = [t[y][xx] for y in range(167, 170) for xx in range(x + dx, x + dx + w)]
            margin = [t[y][xx] for y in range(166, 171) for xx in range(x + dx - 1, x + dx + w + 1)]
            if all(ch in "F." for ch in cells) and not any(ch in DECOR_BLOCKERS for ch in margin):
                g.decor.append([x + dx, 167, w, 3, style, 1, h2(x, 167) % 8])
                for y in range(167, 170):
                    for xx in range(x + dx, x + dx + w):
                        t[y][xx] = BUILDING


def generate():
    g = Gen()
    t = g.tiles
    for y in RIVER_ROWS:
        for x in range(W):
            t[y][x] = WATER
    for y in range(6, 22):
        for x in range(200, 222):
            if ((x - 211) / 11) ** 2 + ((y - 14) / 8) ** 2 <= 1:
                t[y][x] = WATER
    street_tiles(t)
    highway(t)
    rail(t)
    for sid, name, did, (x, y, w, h), face, _ in STATIONS:
        p = g.place(sid, name, "station", "station", x, y, w, h, face, 1, None, did, capacity=300)
        assert p, sid
        g.station_entries.append(tuple(p["entry"]))
        g.job("station staff", sid, 22, 5, 13, 2, (0, 1, 2, 3, 4, 5, 6))
        g.job("station staff", sid, 22, 13, 21, 2, (0, 1, 2, 3, 4, 5, 6))
    for pid, name, (x, y, w, h), face in EAST_FLATS:
        p = g.place(pid, name, "home", "apartments", x, y, w, h, face, 4, None, "east_woods", "flat", 8)
        assert p, pid
        g.homes_for(p, "flat", [1, 2, 2, 3], 5000, 150, "let")
    used = set()
    for pid, name, kind, style, (c, r), (dx, dy, w, h), face, floors, hours, cap in CIVIC:
        x0, _ = block_x(c)
        _, y0, y1 = BLOCK_ROWS[r]
        did = district_of_block(c, r)
        y = y1 - h if face == "s" else y0 + dy
        p = g.place(pid, name, kind, style, x0 + dx, y, w, h, face, floors, hours, did, capacity=cap)
        assert p, pid
        used.add((c, r))
        for title, wage, s, e, days, n in CIVIC_STAFF[kind]:
            g.job(title, pid, wage, s, e, n, days)
    for pid, name, (c, r), did in PARKS:
        x0, x1 = block_x(c)
        _, y0, y1 = BLOCK_ROWS[r]
        g.park(pid, name, x0, y0, x1 - x0 + 1, y1 - y0 + 1, did)
        used.add((c, r))
    for r, y0, y1 in BLOCK_ROWS:
        for c in range(len(COLS)):
            if (c, r) in used:
                continue
            x0, x1 = block_x(c)
            if r <= 3 and x1 < FROZEN_W:
                continue
            if r <= 3 and c == 5:
                continue
            fill_block(g, c, r, district_of_block(c, r))
    for y in range(4, 25):
        for x in range(69, 80):
            if t[y][x] == GRASS and g.rng.random() < 0.3:
                t[y][x] = TREE
    for y in range(157, H):
        for x in range(W):
            if t[y][x] == GRASS and (x // 6 + y // 5) % 4:
                t[y][x] = FARM
    for p in g.places:
        if not p["name"]:
            p["name"] = p["id"].replace("_", " ").title()
    for row in MILLBROOK_JOBS:
        title, place, wage, s, e, days, n = row
        g.jobs.append([title, place, wage, s, e, list(days), n])
    decorate(g)
    farmsteads(g)
    return g


def priced(g):
    """home rows with region.py's prices applied: value and rent by district, station premium."""
    pl = {p["id"]: p for p in g.places}
    st = PRICES["station"]
    out = []
    for hid, pid, unit, tier, beds, base, rent, start, cond in g.homes:
        p = pl[pid]
        vm, rm = PRICES["districts"].get(p["district"], [1.0, 1.0])
        ex, ey = p["entry"]
        if any(abs(ex - sx) + abs(ey - sy) <= st["tiles"] for sx, sy in g.station_entries):
            vm, rm = vm * st["value"], rm * st["rent"]
        out.append([hid, pid, unit, tier, beds, int(base * vm / 100 + 0.5) * 100, int(rent * rm / 5 + 0.5) * 5,
                    start, cond])
    return out


def rail_json():
    lines = []
    for ln in LINES:
        tracks = {k: track_tiles(v) for k, v in ln["tracks"].items()}
        stations = []
        for sid in ln["stations"]:
            s = STATION_BY_ID[sid]
            a, b = s[5][ln["id"]]
            stations.append({"id": sid, "name": s[1], "i": {"out": stop_index(tracks["out"], a),
                                                             "in": stop_index(tracks["in"], b)},
                             "platforms": [list(a), list(b)], "exits": [list(e) for e in EXITS[sid]]})
        lines.append({"id": ln["id"], "name": ln["name"], "cars": ln["cars"],
                      "tracks": {k: [list(p) for p in v] for k, v in ln["tracks"].items()},
                      "track_tiles": {k: len(v) for k, v in tracks.items()}, "stations": stations,
                      "trains": [f"{ln['id']}{k + 1}" for k in range(ln["trains"])],
                      "every": ln["every"], "speed": ln["speed"], "dwell": ln["dwell"], "layover": ln["layover"],
                      "capacity": ln["capacity"], "fare": ln["fare"]})
    return {"lines": lines}


def region_json(g):
    rows = ["".join(r) for r in g.tiles]
    rows = ["?" * FROZEN_W + row[FROZEN_W:] if y < FROZEN_H else row for y, row in enumerate(rows)]
    dists = []
    for did, name, about, rects in DISTRICTS:
        rr = []
        for c0, c1, r0, r1 in rects:
            xa, _ = block_x(c0)
            _, xb = block_x(c1)
            rr.append([xa, BLOCK_ROWS[r0][1], xb - xa + 1, BLOCK_ROWS[r1][2] - BLOCK_ROWS[r0][1] + 1])
        dists.append({"id": did, "name": name, "about": about, "rects": rr,
                      "parking_minutes": PARKING_MINUTES.get(did, 0)})
    inter = [[81, 155], [120, 155], [159, 155], [198, 155], [231, 155], [231, 106], [231, 62], [231, 25]]
    return {"version": 2, "w": W, "h": H, "frozen": [FROZEN_W, FROZEN_H], "rows": rows, "districts": dists,
            "places": g.places, "homes": g.homes, "lots": g.lots, "prices": PRICES, "jobs": g.jobs,
            "decor": g.decor, "rail": rail_json(),
            "highways": [{"name": "Route 9", "line": [[0, 155], [255, 155]], "width": 2},
                         {"name": "Route 9 North", "line": [[231, 0], [231, 156]], "width": 2}],
            "interchanges": inter, "highway_edges": [[inter[i], inter[i + 1]] for i in range(len(inter) - 1)]}


def dumps(data: dict) -> str:
    """region.json's text: compact separators, keys in table order, ASCII-only escapes."""
    return json.dumps(data, separators=(",", ":"))


def strip_additive(data: dict) -> dict:
    """A copy of region.json's data without the keys added after the hour-0 file, with the RAISED job rows at
    their hour-0 counts and the RETUNED line values at their hour-0 values (for the byte check)."""
    out = dict(data)
    for top, keys in ADDITIVE.items():
        out[top] = [{k: v for k, v in row.items() if k not in keys} for row in data[top]]
    hour0 = {key: was for key, (was, now) in RAISED.items()}
    out["jobs"] = [row[:6] + [hour0[(row[0], row[1])]] if (row[0], row[1]) in hour0 else row for row in data["jobs"]]
    lines = []
    for ln in data["rail"]["lines"]:
        ln = dict(ln)
        for (lid, key), (was, now) in RETUNED.items():
            if ln["id"] == lid:
                ln[key] = was
        lines.append(ln)
    out["rail"] = {**data["rail"], "lines": lines}
    return out


def text() -> str:
    """The text --write writes."""
    return dumps(region_json(generate()))


def main(argv: list[str] | None = None) -> int:
    import argparse
    ap = argparse.ArgumentParser(prog="python3 -m gameofailife.regiongen", description=__doc__.split("\n\n")[0])
    ap.add_argument("--write", action="store_true", help="regenerate gameofailife/data/region.json")
    ap.add_argument("--check", action="store_true", help="exit 1 when data/region.json is stale")
    ap.add_argument("--stats", action="store_true", help="print counts")
    ap.add_argument("--out", default=DATA, help="the file to write or check (default data/region.json)")
    args = ap.parse_args(argv)
    t0 = time.process_time()
    g = generate()
    data = region_json(g)
    body = dumps(data)
    hour0 = hashlib.sha1(dumps(strip_additive(data)).encode()).hexdigest() == HOUR0_SHA1
    status = 0
    if args.write:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(body)
        print(f"wrote {args.out} ({len(body):,} bytes; hour-0 file minus additive keys: {hour0})")
    if args.check:
        try:
            with open(args.out, encoding="utf-8") as f:
                have = f.read()
        except OSError:
            have = None
        fresh = have == body
        print(f"{args.out}: {'up to date' if fresh else 'STALE: run --write'}"
              f" ({(time.process_time() - t0) * 1000:.0f} ms cpu; hour-0 minus additive keys: {hour0})")
        status = 0 if fresh else 1
    if args.stats or not (args.write or args.check):
        from collections import Counter
        kinds = Counter(p["kind"] for p in g.places)
        print(f"generate: {(time.process_time() - t0) * 1000:.0f} ms cpu; places {len(g.places)} {dict(kinds)}")
        print("homes", len(g.homes), dict(Counter(h[3] for h in g.homes)), dict(Counter(h[7] for h in g.homes)))
        print("slots", sum(j[6] for j in g.jobs), "decor", len(g.decor),
              "10+ floors:", sum(1 for d in g.decor if d[5] >= 10), "bytes", len(body))
    return status


if __name__ == "__main__":
    sys.exit(main())

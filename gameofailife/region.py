"""The 256 x 192 region around Millbrook (design-v3/region.md): `data/region.json` plus `build_map(seed)`.

`build_region(seed)` loads the data once, overlays Millbrook's own tiles (x < 69, y < 50) from `build_map(seed)`,
and returns a RegionMap: a TownMap with the region's places after Millbrook's 39, priced homes, lot conditions,
job slots, districts, the railway, highways and decor. Like `build_map` it is memoized and shared read-only; only
the lazy caches fill in. Millbrook's places are `dataclasses.replace` copies that carry a capacity, never the
cached `build_map` objects themselves.

The region file comes from `python3 -m gameofailife.regiongen --write` (dev time, a fixed Rng); nothing here draws
a random number. Prices are applied at load (region.md 4), so tuning them never changes an id.
"""

from __future__ import annotations

import dataclasses
import functools
import json
import os

from . import town as T

W, H = 256, 192
FROZEN = (69, 50)  # x < 69 and y < 50: exactly build_map(seed)'s tiles
MILLBROOK = (0, 0, 80, 50)  # Millbrook's 80 x 50 (x, y, w, h); the strip x 69-79 is region data
WALK_CODES = ".#PebxF"  # the named tier's walkable tiles: v2's plus road bridge, level crossing and farmland
STREET_CODES = "#bx"  # streets: road, road bridge, level crossing
CAPACITY_BY_KIND = {"home": 0, "office": 150, "bank": 40, "townhall": 60, "school": 300, "hospital": 200,
                    "market": 60, "shop": 80, "cafe": 30, "works": 120, "park": 100, "station": 300, "venue": 150}
DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "region.json")

_WALK = frozenset(WALK_CODES)
_STREET = frozenset(STREET_CODES)


@functools.lru_cache(maxsize=1)
def load_data() -> dict:
    """data/region.json, parsed once and shared: callers must not change it."""
    with open(DATA, encoding="utf-8") as f:
        return json.load(f)


def _round_to(v: float, step: int) -> int:
    """v to the nearest multiple of step, halves up (v >= 0)."""
    return int(v / step + 0.5) * step


def priced_specs(data: dict, places: dict) -> list[tuple]:
    """The region's home rows as HOME_SPECS-shaped tuples with the district table and the station premium applied:
    value = round100(base x dv x sv), rent = round5(rent x dr x sr), sv/sr within `station.tiles` Manhattan tiles
    of a station entry."""
    pr = data["prices"]
    st = pr["station"]
    stations = [tuple(p["entry"]) for p in data["places"] if p["kind"] == "station"]
    out = []
    for hid, pid, unit, tier, beds, base, rent, start, cond in data["homes"]:
        p = places[pid]
        vm, rm = pr["districts"].get(p.district, [1.0, 1.0])
        ex, ey = p.entry
        if any(abs(ex - sx) + abs(ey - sy) <= st["tiles"] for sx, sy in stations):
            vm, rm = vm * st["value"], rm * st["rent"]
        out.append((hid, pid, unit, tier, beds, _round_to(base * vm, 100), _round_to(rent * rm, 5), start, cond))
    return out


class RegionMap(T.TownMap):
    """Millbrook and the region on one 256 x 192 grid. Its own walkable and street sets (WALK_CODES,
    STREET_CODES); `town.py`'s are untouched. The attributes below are set by `build_region`."""

    world = "region"

    def __post_init__(self) -> None:
        self.h = len(self.tiles)
        self.w = len(self.tiles[0]) if self.tiles else 0
        cells = [c for row in self.tiles for c in row]
        self._ok = bytes(c in _WALK for c in cells)
        self._road = bytes(c in _STREET for c in cells)
        self._fields = {}
        self._roads = {}
        self._drives = {}
        self.memo = {}
        self._tile_district = {}  # tile index -> district of the region place there (build_region fills it)
        w, h, road = self.w, self.h, self._road
        self.junctions = {(i % w, i // w) for i in range(w * h) if road[i] and
                          (i % w + 1 < w and road[i + 1]) + (i % w > 0 and road[i - 1]) +
                          (i // w + 1 < h and road[i + w]) + (i // w > 0 and road[i - w]) >= 3}

    def _is_road(self, x: int, y: int) -> bool:
        return 0 <= x < self.w and 0 <= y < self.h and bool(self._road[y * self.w + x])

    def walkable(self, x: int, y: int) -> bool:
        return 0 <= x < self.w and 0 <= y < self.h and bool(self._ok[y * self.w + x])

    def in_frozen(self, x: int, y: int) -> bool:
        """Inside the rectangle whose tiles are exactly build_map(seed)'s (Rule R's test)."""
        return x < FROZEN[0] and y < FROZEN[1]

    def district_at(self, x: int, y: int) -> str:
        """The district of the region place whose footprint or entry is the tile (so it always matches the place's
        own district, which car_extra and the prices use), else Millbrook's district for a tile of its 80 x 50
        (v2's blocks), else the region district whose rect holds it, else "" (a street, the river, a highway)."""
        if 0 <= x < self.w and 0 <= y < self.h:
            own = self._tile_district.get(y * self.w + x)
            if own is not None:
                return own
        mx, my, mw, mh = MILLBROOK
        if mx <= x < mx + mw and my <= y < my + mh:
            return T.district_at(x, y)
        for d in self.districts:
            for rx, ry, rw, rh in d["rects"]:
                if rx <= x < rx + rw and ry <= y < ry + rh:
                    return d["id"]
        return ""

    def warm(self) -> None:
        """Build only what the 60 need (region.md 6.2): the walk and road fields of Millbrook's 39 places and the
        walk fields of the bus stops. Calling it again builds nothing."""
        from .transit import STOP_XY

        for place in self.places.values():
            if place.id in self.millbrook_ids:
                self.walk_field(place.entry)
                self.road_field(place.entry)
        for xy in STOP_XY.values():
            self.walk_field(xy)

    def warm_next(self) -> bool:
        """One more region walk field per idle frame: not built tonight (PLAN 1, the 60 stay in Millbrook)."""
        return False

    def map_json(self) -> dict:
        """The map part of the region welcome's `town` (region.md 8): v2's keys at 256 x 192 without
        road_rows/road_cols/road_col_end, places with `capacity`, and the region's own keys."""
        return {
            "w": self.w, "h": self.h, "tiles": self.rows(),
            "places": [p.to_json() for p in self.places.values()],
            "districts": self.districts, "streets": T.streets_json(),
            "junctions": [[x, y] for x, y in sorted(self.junctions, key=lambda t: (t[1], t[0]))],
            "world": self.world, "millbrook": list(MILLBROOK),
            "rail": self.rail, "highways": self.highways,
            "interchanges": [list(p) for p in self.interchanges], "decor": self.decor,
        }


def _tile_districts(m: RegionMap) -> dict:
    """Tile index -> district for the region places' footprints, then their entry tiles (first place wins), so
    district_at agrees with each place's own district where the rects do not (quayside_station's footprint and
    entry lie in downtown_riverton's rect). Millbrook's places keep v2's blocks."""
    out = {}
    mine = [p for p in m.places.values() if p.id not in m.millbrook_ids]
    for p in mine:
        for y in range(p.y, p.y + p.h):
            for x in range(p.x, p.x + p.w):
                out.setdefault(y * m.w + x, p.district)
    for p in mine:
        ex, ey = p.entry
        out.setdefault(ey * m.w + ex, p.district)
    return out


@functools.lru_cache(maxsize=4)
def build_region(seed: int) -> RegionMap:
    """The region for a seed (only Millbrook's trees depend on it). Memoized: callers share the returned map and
    must never change it."""
    d = load_data()
    fw, fh = d["frozen"]
    mb = T.build_map(seed)
    tiles = [list(row) for row in d["rows"]]
    for y in range(fh):
        tiles[y][:fw] = mb.tiles[y][:fw]
    places = {pid: dataclasses.replace(p, capacity=CAPACITY_BY_KIND[p.kind]) for pid, p in mb.places.items()}
    for p in d["places"]:
        places[p["id"]] = T.Place(p["id"], p["name"], p["kind"], p["x"], p["y"], p["w"], p["h"],
                                  tuple(p["hours"]) if p["hours"] else None, tuple(p["entry"]), p["face"],
                                  p["district"], p["style"], p["floors"], p["tier"], p["units"], p["capacity"])
    m = RegionMap(tiles, places)
    m.millbrook_ids = frozenset(mb.places)
    m._tile_district = _tile_districts(m)
    m.home_specs = priced_specs(d, places)
    m.lot_conditions = dict(d["lots"])
    m.job_slots = [(t, pid, w, s, e, tuple(days), n) for t, pid, w, s, e, days, n in d["jobs"]]
    m.districts = T.districts_json() + d["districts"]
    m.rail, m.decor, m.prices = d["rail"], d["decor"], d["prices"]
    m.highways = d["highways"]
    m.interchanges = [tuple(p) for p in d["interchanges"]]
    m.highway_edges = [(tuple(a), tuple(b)) for a, b in d["highway_edges"]]
    return m


def rent_at(town, home, condition: float) -> int:
    """A region home's listed weekly rent at a lot condition: round5(rent x (0.6 + 0.4 x condition / 100)).
    `home` is a housing Home or a home_specs row."""
    rent = home[6] if isinstance(home, (tuple, list)) else home.rent
    a, b = town.prices["condition_rent"] if town.world == "region" else (0.6, 0.4)
    return _round_to(rent * (a + b * condition / 100), 5)


def car_extra(town, place_id: str) -> int:
    """Minutes to park at a place: its district's `parking_minutes` (Downtown 10, Midtown 8), else 0."""
    if town.world != "region":
        return 0
    did = town.places[place_id].district
    for d in town.districts:
        if d["id"] == did:
            return d.get("parking_minutes", 0)
    return 0

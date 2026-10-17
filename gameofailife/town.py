"""The 80 x 50 tile map of Millbrook: streets, districts, the 39 places, seeded trees, walk and road fields.

`build_map(seed)` is memoized and a TownMap is read-only after it is built: only its lazy caches (walk fields,
road fields, drive lengths and `memo`) fill in, so Simulations with the same seed share one map and its fields.
The layout and the places are the same for every seed; the seed only moves the trees. The homes live in
`housing.py` and the cast in `cast.py`; this module imports neither.
"""

from __future__ import annotations

import functools
from array import array
from dataclasses import dataclass, field

from .rng import Rng

W, H = 80, 50

# Tile codes shared with the web client. Water is new and is not walkable.
GRASS, ROAD, BUILDING, DOOR, PARK, TREE, ENTRY, WATER = ".", "#", "B", "D", "P", "T", "e", "~"
WALKABLE = {GRASS, ROAD, PARK, ENTRY}
UNREACHABLE = 65535  # walk distance of a tile no walk reaches

ROAD_ROWS = (3, 14, 25, 36)  # east-west streets, x 0 to 79
ROAD_COLS = (3, 16, 29, 42, 55, 68)  # north-south streets, y 0 to ROAD_COL_END
ROAD_COL_END = 44  # the north-south streets stop at the riverbank (y 45)
RIVER_ROWS = (46, 47, 48, 49)
STREETS = [  # (name, axis, at): a "row" street runs east-west along y = at, a "col" street north-south along x = at
    ("Ridge Road", "row", 3), ("Park Avenue", "row", 14), ("Main Street", "row", 25), ("River Road", "row", 36),
    ("Willow Lane", "col", 3), ("Oak Street", "col", 16), ("Market Street", "col", 29),
    ("Center Street", "col", 42), ("Eastgate Road", "col", 55), ("Mill Road", "col", 68),
]

# The 24 blocks between the streets: columns c0-c5 and rows r0-r3.
BLOCK_X = (4, 17, 30, 43, 56, 69)
BLOCK_Y = (4, 15, 26, 37)
BLOCK_W = (12, 12, 12, 12, 12, 11)
BLOCK_H = (10, 10, 10, 8)

DISTRICTS = [  # (id, name, about, blocks as (column, row))
    ("maple_grove", "Maple Grove", "ordinary houses, the school, Fresh Market",
     [(0, 0), (1, 0), (0, 1), (1, 1), (0, 2), (1, 2)]),
    ("hilltop", "Hilltop", "big houses with gardens", [(2, 0), (3, 0)]),
    ("downtown", "Downtown", "offices, hospital, shops, City Hall", [(2, 1), (3, 1), (2, 2), (3, 2)]),
    ("eastgate", "Eastgate", "cheap flats, corner shops", [(4, 0), (4, 1)]),
    ("the_works", "The Works", "the factory by the river", [(4, 2), (5, 2), (4, 3), (5, 3)]),
    ("riverside", "Riverside", "the park along the river", [(0, 3), (1, 3), (2, 3), (3, 3)]),
    ("east_woods", "East Woods", "woodland at the edge of town", [(5, 0), (5, 1)]),
]
DISTRICT_NAMES = {did: name for did, name, _, _ in DISTRICTS}

# Seeded woods, drawn after the park trees from the same stream: (block column, block row, tree density).
WOODS = [(5, 0, 0.30), (5, 1, 0.30), (0, 0, 0.04), (0, 3, 0.10), (3, 3, 0.08), (5, 3, 0.10)]
EDGE_TREES = 0.12  # the north strip (y 0-2) and the west strip (x 0-2, y 3-44)


@dataclass
class Place:
    id: str
    name: str
    kind: str  # home, office, bank, townhall, school, hospital, market, shop, cafe, works, park
    x: int
    y: int
    w: int
    h: int
    hours: tuple[int, int] | None = None  # open hour, close hour; None = always
    entry: tuple[int, int] = (0, 0)  # walkable tile where agents arrive; it always touches a road
    face: str | None = None  # wall with the door: "n", "s", "e" or "w"; None for parks
    district: str = ""
    style: str = ""  # the renderer's model key: house, big_house, apartments, tower, park, ...
    floors: int = 0  # building height; 0 for parks
    tier: str | None = None  # homes: "flat", "house" or "big_house"
    units: int = 0  # homes inside: 1 for a house, 6 for an apartment block, 0 for everything else

    def is_open(self, hour: float) -> bool:
        if self.hours is None:
            return True
        start, end = self.hours
        return start <= hour < end

    def to_json(self) -> dict:
        return {
            "id": self.id, "name": self.name, "kind": self.kind,
            "x": self.x, "y": self.y, "w": self.w, "h": self.h, "entry": list(self.entry), "face": self.face,
            "hours": list(self.hours) if self.hours else None, "district": self.district, "style": self.style,
            "floors": self.floors, "tier": self.tier, "units": self.units,
        }


@dataclass(eq=False)
class TownMap:
    """The tiles and places of the town. Read-only once built; only the lazy caches fill in.

    Tile index i is (i % w, i // w). Fields are arrays of w * h uint16 values, 65535 = unreachable.
    `memo` holds values other modules derive from the map alone (and from fixed module data such as the bus
    timetable), keyed by tuples that start with the module's own tag, so Simulations sharing the map share them.
    """

    tiles: list[list[str]]
    places: dict[str, Place] = field(default_factory=dict)
    w: int = field(init=False)
    h: int = field(init=False)
    junctions: set[tuple[int, int]] = field(init=False, repr=False)  # road tiles with 3 or more road neighbours
    memo: dict = field(init=False, repr=False)  # derived values other modules cache on the shared map
    _ok: bytes = field(init=False, repr=False)  # 1 where walkable, by tile index
    _road: bytes = field(init=False, repr=False)  # 1 where road, by tile index
    _fields: dict = field(init=False, repr=False)  # goal tile index -> (dist, off)
    _roads: dict = field(init=False, repr=False)  # goal tile index -> road distance
    _drives: dict = field(init=False, repr=False)  # (start x, start y, place id) -> (tiles, junctions)

    def __post_init__(self) -> None:
        self.h = len(self.tiles)
        self.w = len(self.tiles[0]) if self.tiles else 0
        cells = [c for row in self.tiles for c in row]
        self._ok = bytes(c in WALKABLE for c in cells)
        self._road = bytes(c == ROAD for c in cells)
        self._fields = {}
        self._roads = {}
        self._drives = {}
        self.memo = {}
        self.junctions = {(x, y) for y in range(self.h) for x in range(self.w)
                          if self.tiles[y][x] == ROAD and sum(self._is_road(x + dx, y + dy) for dx, dy in
                                                              ((1, 0), (-1, 0), (0, 1), (0, -1))) >= 3}

    def _is_road(self, x: int, y: int) -> bool:
        return 0 <= x < self.w and 0 <= y < self.h and self.tiles[y][x] == ROAD

    def walkable(self, x: int, y: int) -> bool:
        return 0 <= x < self.w and 0 <= y < self.h and self.tiles[y][x] in WALKABLE

    def rows(self) -> list[str]:
        return ["".join(r) for r in self.tiles]

    # --- walk distance fields -------------------------------------------------

    def walk_field(self, goal: tuple[int, int]) -> tuple[array, array]:
        """BFS from `goal` over walkable tiles, cached per goal tile: (dist, off) as array('H').

        dist[i] is the number of steps from tile i to the goal; off[i] the fewest off-road tiles (counting tile
        i and the goal) on any shortest walk from tile i. Both are 65535 where the goal can't be reached.
        """
        gx, gy = goal
        if not (0 <= gx < self.w and 0 <= gy < self.h):
            return self._blank_field()
        g = gy * self.w + gx
        f = self._fields.get(g)
        if f is None:
            f = self._fields[g] = self._build_walk_field(g)
        return f

    def _blank_field(self) -> tuple[array, array]:
        n = self.w * self.h
        return array("H", [UNREACHABLE]) * n, array("H", [UNREACHABLE]) * n

    def _build_walk_field(self, g: int) -> tuple[array, array]:
        w, n = self.w, self.w * self.h
        ok, road = self._ok, self._road
        dist, off = self._blank_field()
        if not ok[g]:
            return dist, off
        dist[g] = 0
        off[g] = 1 - road[g]
        queue = [g]
        head = 0
        while head < len(queue):
            c = queue[head]
            head += 1
            d = dist[c] + 1
            oc = off[c]
            x = c % w
            # Neighbours in the order E, W, S, N.
            for nb in (c + 1 if x + 1 < w else -1, c - 1 if x else -1, c + w if c + w < n else -1, c - w):
                if nb < 0 or not ok[nb]:
                    continue
                o = oc + 1 - road[nb]
                if dist[nb] == UNREACHABLE:
                    dist[nb] = d
                    off[nb] = o
                    queue.append(nb)
                elif dist[nb] == d and o < off[nb]:
                    off[nb] = o
        return dist, off

    def path(self, start: tuple[int, int], goal: tuple[int, int]) -> list[tuple[int, int]]:
        """A shortest walk from start to goal with the fewest off-road tiles, excluding start.

        It descends the goal's walk field, ties broken E, W, S, N; [] when start == goal or the goal is
        unreachable. The start must be a walkable tile.
        """
        if start == goal:
            return []
        dist, off = self.walk_field(goal)
        w, n = self.w, self.w * self.h
        sx, sy = start
        if not (0 <= sx < w and 0 <= sy < self.h):
            return []
        c = sy * w + sx
        if dist[c] == UNREACHABLE:
            return []
        out = []
        while dist[c]:
            want = dist[c] - 1
            x = c % w
            best = -1
            for nb in (c + 1 if x + 1 < w else -1, c - 1 if x else -1, c + w if c + w < n else -1, c - w):
                if nb >= 0 and dist[nb] == want and (best < 0 or off[nb] < off[best]):
                    best = nb
            c = best
            out.append((c % w, c // w))
        return out

    def walk_minutes(self, xy: tuple[int, int], place_id: str) -> int:
        """Minutes on foot from a tile to a place's entry (one tile a minute): O(1) once the field is built."""
        x, y = xy
        if not (0 <= x < self.w and 0 <= y < self.h):
            return UNREACHABLE
        return self.walk_field(self.places[place_id].entry)[0][y * self.w + x]

    def steps(self, start: tuple[int, int], goal: tuple[int, int]) -> int:
        """Steps on foot from one tile to another, such as a bus stop: O(1) once the goal's walk field is built."""
        x, y = start
        if not (0 <= x < self.w and 0 <= y < self.h):
            return UNREACHABLE
        return self.walk_field(goal)[0][y * self.w + x]

    # --- road fields and drive paths --------------------------------------------

    def road_field(self, goal: tuple[int, int]) -> array:
        """BFS from `goal` (a place entry) that steps only onto road tiles, cached per goal tile, as array('H').

        dist[i] is the number of steps from road tile i to the goal, where only the last step (from the road tile
        beside the goal onto the goal) leaves the road. It is 0 at the goal and 65535 on every other off-road tile.
        """
        gx, gy = goal
        if not (0 <= gx < self.w and 0 <= gy < self.h):
            return self._blank_field()[0]
        g = gy * self.w + gx
        f = self._roads.get(g)
        if f is None:
            f = self._roads[g] = self._build_road_field(g)
        return f

    def _build_road_field(self, g: int) -> array:
        w, n = self.w, self.w * self.h
        road = self._road
        dist = array("H", [UNREACHABLE]) * n
        dist[g] = 0
        queue = [g]
        head = 0
        while head < len(queue):
            c = queue[head]
            head += 1
            d = dist[c] + 1
            x = c % w
            # Neighbours in the order E, W, S, N.
            for nb in (c + 1 if x + 1 < w else -1, c - 1 if x else -1, c + w if c + w < n else -1, c - w):
                if nb >= 0 and road[nb] and dist[nb] == UNREACHABLE:
                    dist[nb] = d
                    queue.append(nb)
        return dist

    def drive_path(self, start: tuple[int, int], place_id: str) -> list[tuple[int, int]]:
        """The route a car takes to a place, excluding start: roads only, apart from the first and last step.

        From a road tile it descends the place's road field (ties E, W, S, N) to the road tile beside the entry,
        then steps onto the entry. From a tile beside a road it first steps onto the neighbouring road tile with the
        smallest road distance (ties E, W, S, N). From anywhere else, such as the middle of a park, it is the walk
        path. [] when start is the entry or the place cannot be reached.
        """
        goal = self.places[place_id].entry
        sx, sy = start
        if (sx, sy) == goal:
            return []
        w, n = self.w, self.w * self.h
        if not (0 <= sx < w and 0 <= sy < self.h):
            return []
        dist = self.road_field(goal)
        road = self._road
        c = sy * w + sx
        out = []
        if not road[c]:
            x = c % w
            best = -1
            for nb in (c + 1 if x + 1 < w else -1, c - 1 if x else -1, c + w if c + w < n else -1, c - w):
                if nb >= 0 and road[nb] and dist[nb] != UNREACHABLE and (best < 0 or dist[nb] < dist[best]):
                    best = nb
            if best < 0:
                return self.path((sx, sy), goal)
            c = best
            out.append((c % w, c // w))
        elif dist[c] == UNREACHABLE:
            return self.path((sx, sy), goal)
        while dist[c]:
            want = dist[c] - 1
            x = c % w
            for nb in (c + 1 if x + 1 < w else -1, c - 1 if x else -1, c + w if c + w < n else -1, c - w):
                if nb >= 0 and dist[nb] == want:
                    c = nb
                    break
            out.append((c % w, c // w))
        return out

    def drive_length(self, start: tuple[int, int], place_id: str) -> tuple[int, int]:
        """(tiles, junctions) on drive_path(start, place_id), memoized: (0, 0) at the entry, (65535, 0) when the
        place cannot be reached. Junctions are the crossings a car may wait at; the start tile does not count."""
        key = (start[0], start[1], place_id)
        got = self._drives.get(key)
        if got is None:
            path = self.drive_path(start, place_id)
            if not path and key[:2] != self.places[place_id].entry:
                got = (UNREACHABLE, 0)
            else:
                got = (len(path), sum(1 for tile in path if tile in self.junctions))
            self._drives[key] = got
        return got

    def warm(self) -> None:
        """Build every field a tick may need now, so no tick pays for one: the walk and road fields of every
        place entry and the walk fields of the bus stops. Calling it again builds nothing."""
        from .transit import STOP_XY  # transit imports nothing from the town; only the stop tiles are needed

        for place in self.places.values():
            self.walk_field(place.entry)
            self.road_field(place.entry)
        for xy in STOP_XY.values():
            self.walk_field(xy)

    # --- snapshot -------------------------------------------------------------

    def map_json(self) -> dict:
        """The map part of the God welcome's `town`; the simulation adds homes, housing, stops and timetable."""
        return {
            "w": self.w, "h": self.h, "tiles": self.rows(),
            "places": [p.to_json() for p in self.places.values()],
            "districts": districts_json(), "streets": streets_json(),
            "road_rows": list(ROAD_ROWS), "road_cols": list(ROAD_COLS), "road_col_end": ROAD_COL_END,
            "junctions": [[x, y] for x, y in sorted(self.junctions, key=lambda t: (t[1], t[0]))],
        }


def districts_json() -> list[dict]:
    return [{"id": did, "name": name, "about": about,
             "rects": [[BLOCK_X[c], BLOCK_Y[r], BLOCK_W[c], BLOCK_H[r]] for c, r in blocks]}
            for did, name, about, blocks in DISTRICTS]


def streets_json() -> list[dict]:
    return [{"name": name, "axis": axis, "at": at} for name, axis, at in STREETS]


def district_at(x: int, y: int) -> str:
    """The district whose block holds the tile, or "" for a street or the riverbank."""
    for did, _, _, blocks in DISTRICTS:
        for c, r in blocks:
            if BLOCK_X[c] <= x < BLOCK_X[c] + BLOCK_W[c] and BLOCK_Y[r] <= y < BLOCK_Y[r] + BLOCK_H[r]:
                return did
    return ""


def street_of(ex: int, ey: int) -> tuple[str, int] | tuple[None, None]:
    """Street and house number for an entry tile next to a road.

    On an east-west street the number is x * 2 on its north side and x * 2 + 1 on its south side; on a
    north-south street it is y * 2 on its east side and y * 2 + 1 on its west side.
    """
    rows = {at: name for name, axis, at in STREETS if axis == "row"}
    cols = {at: name for name, axis, at in STREETS if axis == "col"}
    for dx, dy in ((0, 1), (0, -1), (1, 0), (-1, 0)):
        rx, ry = ex + dx, ey + dy
        if dy and ry in rows:
            return rows[ry], ex * 2 + (1 if dy < 0 else 0)  # road to the north: the entry is on the south side
        if dx and rx in cols:
            return cols[rx], ey * 2 + (1 if dx > 0 else 0)  # road to the east: the entry is on the west side
    return None, None


# --- the places ---------------------------------------------------------------

NON_HOMES = [
    # id, name, kind, style, x, y, w, h, face, floors, hours
    # Downtown
    ("cityhall", "City Hall", "townhall", "city_hall", 32, 16, 6, 4, "n", 3, (8, 17)),
    ("office", "Brightline Tech", "office", "tower", 31, 20, 8, 4, "s", 8, (7, 20)),
    ("hospital", "City Hospital", "hospital", "hospital", 44, 17, 10, 7, "s", 4, None),
    ("cafe", "Corner Cafe", "cafe", "cafe", 31, 27, 4, 3, "n", 2, (6, 23)),
    ("arcade", "Grand Arcade", "shop", "arcade", 31, 31, 9, 4, "s", 3, (9, 21)),
    ("bank", "Millbrook Savings Bank", "bank", "bank", 44, 27, 5, 4, "n", 4, (9, 17)),
    # Maple Grove
    ("school", "Millbrook School", "school", "school", 18, 19, 10, 5, "e", 2, (7, 17)),
    ("diner", "Oak Street Diner", "cafe", "diner", 18, 16, 4, 2, "n", 1, (6, 22)),
    ("market", "Fresh Market", "market", "market", 18, 31, 5, 4, "s", 1, (7, 21)),
    ("bakery", "Maple Bakery", "cafe", "bakery", 24, 32, 4, 3, "s", 1, (6, 18)),
    # Eastgate
    ("grocer", "Eastgate Grocer", "market", "corner_shop", 57, 5, 4, 3, "n", 1, (7, 22)),
    ("noodles", "Noodle Bar", "cafe", "noodle_bar", 63, 5, 4, 3, "n", 2, (11, 24)),
    # The Works
    ("works", "Millbrook Works", "works", "factory", 57, 28, 10, 7, "s", 2, (6, 22)),
]

PARKS = [  # id, name, x, y, w, h, entry; trees are seeded in this order
    ("park", "Riverside Park", 17, 37, 25, 8, (23, 37)),
    ("maple_park", "Maple Park", 17, 4, 12, 10, (22, 13)),
    ("square", "Fountain Square", 50, 27, 5, 9, (52, 26)),
    ("green", "Eastgate Green", 63, 16, 5, 8, (65, 24)),
]

APARTMENTS = [  # id, name, x, y, w, h, face, floors; each block holds six flats
    ("birch_court", "Birch Court", 57, 10, 5, 3, "s", 3),
    ("cedar_court", "Cedar Court", 63, 10, 5, 3, "s", 3),
    ("elm_court", "Elm Court", 57, 21, 5, 3, "s", 3),
]
FLAT_UNITS = 6


def house_slots() -> list[tuple[int, int, int, int, str]]:
    """Ordinary houses (x, y, w, h, face): 3 x 3, three to a row; top rows face north, bottom rows south."""
    out = []
    for c, r, both_rows in ((0, 1, True), (0, 2, True), (1, 2, False)):
        x0, y0 = BLOCK_X[c], BLOCK_Y[r]
        for top in ((True, False) if both_rows else (True,)):
            for i in range(3):
                out.append((x0 + 1 + 4 * i, y0 + 1, 3, 3, "n") if top else (x0 + 1 + 4 * i, y0 + 6, 3, 3, "s"))
    return out


def big_house_slots() -> list[tuple[int, int, int, int, str]]:
    """Big houses on Hilltop (x, y, w, h, face): 5 x 4, two to a block, facing south over Park Avenue."""
    return [(BLOCK_X[c] + 1 + 6 * i, BLOCK_Y[0] + 5, 5, 4, "s") for c in (2, 3) for i in range(2)]


def _building(tiles: list[list[str]], x: int, y: int, w: int, h: int, face: str) -> tuple[int, int]:
    """Stamp a building with its door in the middle of the `face` wall; return its entry tile."""
    for yy in range(y, y + h):
        for xx in range(x, x + w):
            assert tiles[yy][xx] == GRASS, (x, y, xx, yy, tiles[yy][xx])
            tiles[yy][xx] = BUILDING
    if face == "s":
        door, entry = (x + w // 2, y + h - 1), (x + w // 2, y + h)
    elif face == "n":
        door, entry = (x + w // 2, y), (x + w // 2, y - 1)
    elif face == "e":
        door, entry = (x + w - 1, y + h // 2), (x + w, y + h // 2)
    else:
        door, entry = (x, y + h // 2), (x - 1, y + h // 2)
    tiles[door[1]][door[0]] = DOOR
    assert tiles[entry[1]][entry[0]] == GRASS, (x, y, face, entry)
    tiles[entry[1]][entry[0]] = ENTRY
    return entry


@functools.lru_cache(maxsize=4)
def build_map(seed: int) -> TownMap:
    """The town for a seed. Memoized: callers share the returned map and must never change it."""
    rng = Rng((seed * 0x9E3779B1 + 7) & 0xFFFFFFFF)  # the map stream: park trees, then woods
    tiles = [[GRASS] * W for _ in range(H)]
    for y in RIVER_ROWS:
        tiles[y] = [WATER] * W
    for y in ROAD_ROWS:
        tiles[y] = [ROAD] * W
    for x in ROAD_COLS:
        for y in range(ROAD_COL_END + 1):
            tiles[y][x] = ROAD

    places: dict[str, Place] = {}
    for pid, name, kind, style, x, y, w, h, face, floors, hours in NON_HOMES:
        entry = _building(tiles, x, y, w, h, face)
        places[pid] = Place(pid, name, kind, x, y, w, h, hours, entry, face, district_at(x, y), style, floors)
    for pid, name, x, y, w, h, entry in PARKS:
        for yy in range(y, y + h):
            for xx in range(x, x + w):
                if tiles[yy][xx] == GRASS:
                    tiles[yy][xx] = PARK
        for _ in range(w * h // 8):
            tx = rng.int(x, x + w - 1)
            ty = rng.int(y, y + h - 1)
            if tiles[ty][tx] == PARK and (tx, ty) != entry and abs(tx - entry[0]) + abs(ty - entry[1]) > 1:
                tiles[ty][tx] = TREE
        tiles[entry[1]][entry[0]] = ENTRY
        places[pid] = Place(pid, name, "park", x, y, w, h, None, entry, None, district_at(x, y), "park", 0)
    for pid, name, x, y, w, h, face, floors in APARTMENTS:
        entry = _building(tiles, x, y, w, h, face)
        places[pid] = Place(pid, name, "home", x, y, w, h, None, entry, face, district_at(x, y), "apartments",
                            floors, "flat", FLAT_UNITS)
    for tier, floors, slots in (("house", 1, house_slots()), ("big_house", 2, big_house_slots())):
        for x, y, w, h, face in slots:
            entry = _building(tiles, x, y, w, h, face)
            street, number = street_of(*entry)
            pid = f"{street.split()[0].lower()}_{number}"
            places[pid] = Place(pid, f"{number} {street}", "home", x, y, w, h, None, entry, face,
                                district_at(x, y), tier, floors, tier, 1)

    # Woods and edge trees: grass tiles more than one tile (Chebyshev) from every entry.
    near_entry = {(p.entry[0] + dx, p.entry[1] + dy) for p in places.values() for dx in (-1, 0, 1) for dy in (-1, 0, 1)}
    cells = []
    for c, r, density in WOODS:
        cells += [(x, y, density) for y in range(BLOCK_Y[r], BLOCK_Y[r] + BLOCK_H[r])
                  for x in range(BLOCK_X[c], BLOCK_X[c] + BLOCK_W[c])]
    cells += [(x, y, EDGE_TREES) for x in range(W) for y in range(3)]  # north strip, by column
    cells += [(x, y, EDGE_TREES) for y in range(3, 45) for x in range(3)]  # west strip, by row
    for x, y, density in cells:
        if tiles[y][x] == GRASS and (x, y) not in near_entry and rng.random() < density:
            tiles[y][x] = TREE
    return TownMap(tiles, places)


def build_cast(town: TownMap, seed: int):
    """Removed: the cast is `gameofailife.cast.build_cast(town, homes, seed)`.

    Kept only so the pre-v2 `from .town import build_cast` in sim.py still imports; delete it with that import.
    """
    raise NotImplementedError("the cast moved to gameofailife.cast.build_cast(town, homes, seed)")

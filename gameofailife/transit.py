"""Buses: two lines round the Main Street loop, eleven stops, and the timetable that God and controllers see.

The loop is Main Street (y 25) and Park Avenue (y 14), joined by Willow Lane (x 3) and Mill Road (x 68):
152 road tiles. Line 1 drives it clockwise (east on Main Street), line 2 anticlockwise, both from the depot
corner (3, 25). Each minute a bus moves up to SPEED tiles, stopping early on a stop tile or on the depot
corner, and stands DWELL extra minutes on a stop. So a lap takes 52 minutes, and the 4 buses of a line run
13 minutes apart: bus k of a line is at `route[lap[(tick + k * every) % len(lap)]]`, a pure function of
the tick that both ports compute alike. Service runs 24 hours.

P0 holds the data and the timetable. `bus_rows`, `doors_open` and `best_trip` are stubs until P1 adds
riding, so nobody boards yet and a bus option simply walks. Nothing here imports the town or the
simulation; `best_trip` is handed the town.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .town import TownMap

BUS_FARE = 2  # dollars a ride, for ages 18 to 64; children and people 65 and over ride free
SPEED = 4  # tiles a bus moves in a minute
DWELL = 1  # extra minutes a bus stands at each stop (it is on the stop tile for 2 minutes)
BUSES_PER_LINE = 4
FLIGHTS = (8 * 60, 14 * 60, 20 * 60)  # minute of the day the plane from Riverton to Lakeside takes off

# The 11 stops, all on road tiles of the loop, in line 1's driving order: (id, name, tile).
STOPS = (
    ("maple_west", "Maple Grove West", (10, 25)),  # the Main Street houses
    ("school", "Millbrook School", (28, 25)),  # school, Fresh Market, Maple Bakery
    ("downtown_west", "Brightline Tech", (36, 25)),  # Brightline, Corner Cafe, Grand Arcade
    ("downtown_east", "City Hospital", (48, 25)),  # hospital, bank, Fountain Square
    ("eastgate_south", "Elm Court", (60, 25)),  # Elm Court, Eastgate Green, the Works
    ("eastgate_north", "Birch Court", (60, 14)),  # Birch and Cedar Court
    ("hilltop_east", "Hilltop", (49, 14)),  # 92 and 104 Park Avenue
    ("city_hall", "City Hall", (36, 14)),  # City Hall, 66 and 78 Park Avenue
    ("school_north", "Millbrook School North", (28, 14)),  # the school from the north
    ("maple_park", "Maple Park", (21, 14)),  # Maple Park, Oak Street Diner
    ("maple_north", "Maple Grove North", (10, 14)),  # the Park Avenue houses
)
STOP_XY = {sid: xy for sid, _, xy in STOPS}  # stop id -> tile
STOP_AT = {xy: sid for sid, _, xy in STOPS}  # tile -> stop id


@dataclass(frozen=True, eq=False)
class Line:
    id: str  # "1" or "2"
    name: str
    corners: tuple[tuple[int, int], ...]  # the loop's corners in driving order, from the depot corner
    route: tuple[tuple[int, int], ...]  # every tile of the loop in driving order; route[0] is the depot corner
    lap: tuple[int, ...]  # the route index a bus is at in each minute of its lap
    every: int  # minutes between two buses of the line
    stops: tuple[str, ...]  # stop ids in driving order
    doors: dict[str, int]  # stop id -> minute of the lap the bus stands there with its doors open


def _sign(n: int) -> int:
    return 1 if n > 0 else -1 if n < 0 else 0


def _route(corners: tuple[tuple[int, int], ...]) -> tuple[tuple[int, int], ...]:
    """The closed loop through the corners, one tile at a time, each corner once, starting at the first."""
    tiles = []
    for i, (x, y) in enumerate(corners):
        x1, y1 = corners[(i + 1) % len(corners)]
        dx, dy = _sign(x1 - x), _sign(y1 - y)
        while (x, y) != (x1, y1):
            tiles.append((x, y))
            x, y = x + dx, y + dy
    return tuple(tiles)


def _lap(route: tuple[tuple[int, int], ...]) -> tuple[int, ...]:
    """The route index at each minute of one lap: up to SPEED tiles a minute, stopping on a stop tile
    (then DWELL more minutes there) or on the depot corner, which ends the lap."""
    out, i = [0], 0
    while True:
        for _ in range(SPEED):
            i = (i + 1) % len(route)
            if route[i] in STOP_AT or i == 0:
                break
        out.append(i)
        if route[i] in STOP_AT:
            out.extend([i] * DWELL)
        if i == 0:
            return tuple(out[:-1])


def _line(line_id: str, name: str, corners: tuple[tuple[int, int], ...]) -> Line:
    route = _route(corners)
    lap = _lap(route)
    doors = {}
    for m in range(1, len(lap)):
        if lap[m] == lap[m - 1] and route[lap[m]] in STOP_AT:
            doors[STOP_AT[route[lap[m]]]] = m
    stops = tuple(STOP_AT[t] for t in route if t in STOP_AT)
    return Line(line_id, name, corners, route, lap, len(lap) // BUSES_PER_LINE, stops, doors)


# Line id -> Line, in timetable order.
LINES = {
    "1": _line("1", "No. 1 (clockwise: Main Street east, Park Avenue west)", ((3, 25), (68, 25), (68, 14), (3, 14))),
    "2": _line("2", "No. 2 (anticlockwise: Park Avenue east, Main Street west)",
               ((3, 25), (3, 14), (68, 14), (68, 25))),
}


def fare(age: int) -> int:
    """What one ride costs a passenger of this age."""
    return BUS_FARE if 18 <= age < 65 else 0


def stops_json() -> list[dict]:
    """`town.stops`: [{id, name, x, y, lines}] in STOPS order."""
    return [{"id": sid, "name": name, "x": x, "y": y, "lines": [ln.id for ln in LINES.values() if sid in ln.stops]}
            for sid, name, (x, y) in STOPS]


def timetable_json() -> dict:
    """`town.timetable` (and the controllers' `query world` timetable), the PLAN section 3.2 shape."""
    return {
        "bus": {"lines": [{"id": ln.id, "name": ln.name, "corners": [list(c) for c in ln.corners],
                           "stops": list(ln.stops), "lap_minutes": len(ln.lap), "buses": BUSES_PER_LINE,
                           "every_minutes": ln.every, "speed": SPEED, "dwell": DWELL, "fare": BUS_FARE}
                          for ln in LINES.values()]},
        "flights": [f"{d // 60:02d}:{d % 60:02d} Riverton to Lakeside" for d in FLIGHTS],
    }


# --- P1 fills these in; the signatures are fixed --------------------------------

def bus_rows(tick: int) -> list[dict]:
    """The `state.buses` rows at a tick: [{id, line, x, y, dir, at_stop, riders}]. P0: no buses run yet."""
    return []


def doors_open(line: str, stop: str, tick: int) -> bool:
    """True when a bus of `line` stands at `stop` with its doors open at `tick`. P0: False (no buses run)."""
    return False


def best_trip(town: TownMap, xy: tuple[int, int], place_id: str, tick: int,
              worst: bool = False) -> tuple[int, str, str, str] | None:
    """The fastest single-bus trip from a tile to a place leaving at `tick`: (minutes door to door, line,
    board stop, alight stop), or None when no bus beats walking. `worst` counts the full headway as the
    wait. P0: None, so every bus option walks."""
    return None

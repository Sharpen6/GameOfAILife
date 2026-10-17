"""Buses: two lines round the Main Street loop, eleven stops, and the timetable that God and controllers see.

The loop is Main Street (y 25) and Park Avenue (y 14), joined by Willow Lane (x 3) and Mill Road (x 68):
152 road tiles. Line 1 drives it clockwise (east on Main Street), line 2 anticlockwise, both from the depot
corner (3, 25). Each minute a bus moves up to SPEED tiles, stopping early on a stop tile or on the depot
corner, and stands DWELL extra minutes on a stop. So a lap takes 52 minutes, and the 4 buses of a line run
13 minutes apart: bus k of a line is at `route[lap[(tick + k * every) % len(lap)]]`, a pure function of
the tick that both ports compute alike. Service runs 24 hours.

A bus stands on a stop tile for 2 minutes with its doors open, and a passenger gets on or off in either of
them. A rider who reaches the stop tile at tick T boards the first bus of the line standing there at T or
later, and gets off on the tick that bus first stands on the alight stop. So the timetable is exact:
`best_trip` gives the minutes door to door of the trip the simulation will really make. Every line runs a bus
every PERIOD minutes, so that answer depends only on tick % PERIOD, and `worst` takes the longest of those:
whenever the rider sets off, the best bus is at least that fast. At one stop the longest wait is 11 minutes
(a bus every 13 minutes, standing 2), but another line or stop often does better in that minute.

Nothing here imports the town or the simulation; `best_trip` is handed the town and caches what it derives
from it in `town.memo`. Riders are counted from the agents' `riding` field, so buses keep no state.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .town import TownMap

BUS_FARE = 2  # dollars a ride, for ages 18 to 64; children and people 65 and over ride free
SPEED = 4  # tiles a bus moves in a minute
DWELL = 1  # extra minutes a bus stands at each stop (it is on the stop tile for 2 minutes)
BUSES_PER_LINE = 4
BUS_LETTERS = "abcd"  # bus k of line "1" is "1" + BUS_LETTERS[k]
MIN_SAVING = 5  # minutes a bus trip must save over walking before anyone takes it
UNREACHABLE = 65535  # what the town's walk fields give for a tile that cannot reach the goal
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


# The buses of a line split its lap evenly, so the set of bus positions repeats every `every` minutes.
assert all(len(ln.lap) == ln.every * BUSES_PER_LINE for ln in LINES.values())

# Bus ids in timetable order: 1a-1d, then 2a-2d.
BUS_IDS = tuple(line_id + BUS_LETTERS[k] for line_id in LINES for k in range(BUSES_PER_LINE))
_HEADING = {(1, 0): "e", (-1, 0): "w", (0, 1): "s", (0, -1): "n"}


def _stand(line: Line, stop: str) -> tuple[int, ...]:
    """The minutes of the lap the bus stands on the stop tile, doors open: the minute it arrives and DWELL more."""
    return tuple(m for m, i in enumerate(line.lap) if line.route[i] == STOP_XY[stop])


def _offsets(line: Line, stand: tuple[int, ...]) -> tuple[int, ...]:
    """For a rider reaching the stop at a tick t, by t % every: (the tick the caught bus first stood on the stop)
    - t. It is -1 when the rider steps on in the bus's last minute there, and at most every - len(stand)."""
    first = stand[0]
    return tuple(min((s - r) % line.every - (s - first) for s in stand) for r in range(line.every))


# Derived timetable data, built once at import like LINES: line id -> stop id -> ...
_FIRST = {ln.id: {sid: _stand(ln, sid)[0] for sid in ln.stops} for ln in LINES.values()}  # arrival lap minute
_OFFSET = {ln.id: {sid: _offsets(ln, _stand(ln, sid)) for sid in ln.stops} for ln in LINES.values()}
PERIOD = math.lcm(*(ln.every for ln in LINES.values()))  # the bus timetable repeats every PERIOD minutes


def ride_minutes(line: str, board: str, alight: str) -> int:
    """Minutes on board from the bus's arrival at `board` to its arrival at `alight` (one less for a rider who
    steps on in the bus's second minute at the stop)."""
    ln = LINES[line]
    return (_FIRST[line][alight] - _FIRST[line][board]) % len(ln.lap)


def _bus(bus_id: str) -> tuple[Line, int]:
    line = LINES[bus_id[:-1]]
    return line, BUS_LETTERS.index(bus_id[-1])


def _lap_minute(line: Line, k: int, tick: int) -> int:
    return (tick + k * line.every) % len(line.lap)


def bus_xy(bus_id: str, tick: int) -> tuple[int, int]:
    """The tile a bus is on at `tick` (where its riders are too)."""
    line, k = _bus(bus_id)
    return line.route[line.lap[_lap_minute(line, k, tick)]]


def bus_at_stop(line: str, stop: str, tick: int) -> str | None:
    """The id of the bus of `line` standing at `stop` with its doors open at `tick`, or None."""
    ln, xy = LINES[line], STOP_XY[stop]
    for k in range(BUSES_PER_LINE):
        if ln.route[ln.lap[_lap_minute(ln, k, tick)]] == xy:
            return ln.id + BUS_LETTERS[k]
    return None


def bus_rows(tick: int, agents=()) -> list[dict]:
    """The `state.buses` rows at a tick: [{id, line, x, y, dir, at_stop, riders}] in BUS_IDS order.

    Positions are a pure function of the tick. `dir` is the heading to the bus's next route tile, `at_stop`
    the stop it stands at (or None) and `riders` the number of `agents` (any iterable, such as
    `sim.agents.values()`) whose `riding` is that bus; 0 for every bus when no agents are given.
    """
    riders: dict[str, int] = {}
    for agent in agents:
        if agent.riding:
            riders[agent.riding] = riders.get(agent.riding, 0) + 1
    rows = []
    for line in LINES.values():
        for k in range(BUSES_PER_LINE):
            i = line.lap[_lap_minute(line, k, tick)]
            x, y = line.route[i]
            nx, ny = line.route[(i + 1) % len(line.route)]
            bus_id = line.id + BUS_LETTERS[k]
            rows.append({"id": bus_id, "line": line.id, "x": x, "y": y, "dir": _HEADING[nx - x, ny - y],
                         "at_stop": STOP_AT.get((x, y)), "riders": riders.get(bus_id, 0)})
    return rows


def doors_open(line: str, stop: str, tick: int) -> bool:
    """True when a bus of `line` stands at `stop` with its doors open at `tick` (both minutes it stands there)."""
    return bus_at_stop(line, stop, tick) is not None


def _after(town: TownMap, line: Line, place_id: str) -> dict[str, tuple[int, str | None]]:
    """For each board stop of the line: (fewest minutes from the bus's arrival there to walking in at the place,
    the alight stop that gives it), cached on the town. Ties go to the stop the bus reaches first."""
    key = ("transit_after", line.id, place_id)
    got = town.memo.get(key)
    if got is None:
        walk_from = {sid: town.walk_minutes(STOP_XY[sid], place_id) for sid in line.stops}
        got = {}
        for a in line.stops:
            best, best_b = UNREACHABLE, None
            for b in line.stops[line.stops.index(a) + 1:] + line.stops[:line.stops.index(a)]:
                if walk_from[b] < UNREACHABLE and ride_minutes(line.id, a, b) + walk_from[b] < best:
                    best, best_b = ride_minutes(line.id, a, b) + walk_from[b], b
            got[a] = (best, best_b)
        town.memo[key] = got
    return got


def best_trip(town: TownMap, xy: tuple[int, int], place_id: str, tick: int,
              worst: bool = False) -> tuple[int, str, str, str] | None:
    """The fastest single-bus trip from a tile to a place leaving at `tick`: (minutes door to door, line,
    board stop, alight stop), or None when no bus beats walking by MIN_SAVING minutes or more.

    Door to door is the walk to the board stop, the wait, the ride and the walk from the alight stop, exactly as
    the rider makes it (see the module docstring). Ties go to line 1, then to the board stop the line reaches
    first from its depot corner. With `worst` the tick does not matter: it is the trip of the departure minute
    whose best trip is slowest (the earliest such minute), cached on the town, so whenever the rider leaves the
    best bus takes at most that long.
    """
    xy = (xy[0], xy[1])
    key = ("transit_worst", xy, place_id)
    if worst and key in town.memo:
        return town.memo[key]
    walk = town.walk_minutes(xy, place_id)
    best = None
    if walk < UNREACHABLE:
        to_stop = {sid: town.steps(xy, stop_xy) for sid, stop_xy in STOP_XY.items()}
        legs = []  # (walk to the board stop, the rest after the bus arrives there, line, board, alight)
        for line in LINES.values():
            after = _after(town, line, place_id)
            for a in line.stops:
                rest, b = after[a]
                if to_stop[a] < UNREACHABLE and b is not None:
                    legs.append((to_stop[a], rest, line, a, b))
        for t in (range(PERIOD) if worst else (tick,)):
            fastest = None
            for walk_a, rest, line, a, b in legs:
                minutes = walk_a + _OFFSET[line.id][a][(t + walk_a) % line.every] + rest
                if fastest is None or minutes < fastest[0]:
                    fastest = (minutes, line.id, a, b)
            if fastest is not None and (best is None or fastest[0] > best[0]):
                best = fastest
    if best is not None and best[0] > walk - MIN_SAVING:
        best = None
    if worst:
        town.memo[key] = best
    return best

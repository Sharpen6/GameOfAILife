"""The railway (region.md 7): two double-track lines run as a pure function of the tick, exact boarding, and the
townsfolk's trip planner over the road graph.

Each line has two tracks, "out" and "in", buffer to buffer, given as tile corners in `town.rail["lines"]`. A train
starts at the first station's stop index on "out" with its doors open, moves up to `speed` tiles a minute (stopping
early on a stop index), stands `dwell` more minutes with its doors open at each stop, lays over `layover` minutes
at the far terminus, switches to "in" at the same station (the parallel track), runs back and lays over again; the
cycle is padded at the home terminus to `trains x every` minutes. Train k of a line (id `train_ids[k]`) is at
`cycle[(tick + k * every) % cycle_minutes]`, so nothing here keeps state, and nothing draws dice.

Boarding is exact, as for the bus: a rider on the platform at tick T boards the first train on their track with its
doors open at that station at T or later (ties by train index) and alights on the first minute after boarding that
the train stands with its doors open at their station. Per-(track, station) tables of `cycle_minutes` entries make
both O(1). Capacity is reported, not enforced.

Trips (`trip_via_roads`, folk's only rail planner): access to a station is the best of walking to its entry, walking
to one of its exits plus PLATFORM_MINUTES, and, with a car, a park-and-ride drive of at most PARK_RIDE_MAX minutes to
either; the 3 best stations are kept (ties by station order), egress likewise on foot. Each pair rides the line
serving both ("out" when the board station comes first) or changes at a station both lines serve (Central:
TRANSFER_MINUTES, then a second wait). The fastest wins, ties by (minutes, board order, alight order).
`worst_minutes` is the same search with each ride's worst wait-plus-ride over the cycle, so it is never shorter
than the trip of any departure tick.
"""

from __future__ import annotations

from typing import NamedTuple

WALK, DRIVE, WAIT, RIDE = 0, 1, 2, 3  # leg kinds, as folk_model's
PLATFORM_MINUTES, TRANSFER_MINUTES, PARK_RIDE_MAX = 1, 2, 12
FARE = 3  # dollars a journey for ages 18 to 64; the transfer is free
TOP = 3  # stations kept for access and egress
CACHE_CAP = 200_000  # entries in each planner cache before it is cleared (pure caches)
_HEADING = {(1, 0): "e", (-1, 0): "w", (0, 1): "s", (0, -1): "n"}


def track_tiles(corners) -> tuple[tuple[int, int], ...]:
    """Every tile of a track from its corners, in driving order."""
    out = [(corners[0][0], corners[0][1])]
    for i in range(len(corners) - 1):
        x0, y0 = corners[i][0], corners[i][1]
        x1, y1 = corners[i + 1][0], corners[i + 1][1]
        dx, dy = (x1 > x0) - (x1 < x0), (y1 > y0) - (y1 < y0)
        x, y = x0, y0
        while (x, y) != (x1, y1):
            x, y = x + dx, y + dy
            out.append((x, y))
    return tuple(out)


class Line:
    """One line, from `town.rail["lines"][i]`: id, name, trains (count), train_ids, every, cars, speed, dwell,
    layover, capacity, fare, tracks {track: tiles}, corners {track: corners}, stations (ids in "out" order),
    names, exits, platforms, stop {(track, station): index}, cycle (one (track, i, station | None, doors_open) per
    minute) and cycle_minutes."""

    def __init__(self, data: dict) -> None:
        self.data = data
        self.id, self.name = data["id"], data["name"]
        self.train_ids = tuple(data["trains"])
        self.trains = len(self.train_ids)
        self.every, self.cars = data["every"], data["cars"]
        self.speed, self.dwell, self.layover = data["speed"], data["dwell"], data["layover"]
        self.capacity, self.fare = data["capacity"], data["fare"]
        self.corners = {k: tuple((p[0], p[1]) for p in v) for k, v in data["tracks"].items()}
        self.tracks = {k: track_tiles(v) for k, v in data["tracks"].items()}
        self.stations = tuple(s["id"] for s in data["stations"])
        self.names = {s["id"]: s["name"] for s in data["stations"]}
        self.exits = {s["id"]: tuple((e[0], e[1]) for e in s["exits"]) for s in data["stations"]}
        self.stop = {}  # (track, station) -> stop index on that track
        for s in data["stations"]:
            self.stop[("out", s["id"])] = s["i"]["out"]
            self.stop[("in", s["id"])] = s["i"]["in"]
        self.cycle = self._build()
        self.cycle_minutes = len(self.cycle)
        C = self.cycle_minutes
        doors = {}  # (track, station) -> cycle minutes with the doors open there
        for m in range(C):
            track, i, at, open_ = self.cycle[m]
            if open_:
                doors.setdefault((track, at), []).append(m)
        self.doors = {k: tuple(v) for k, v in doors.items()}
        self.first = {}  # (track, station) -> for each cycle minute, minutes until the doors are next open (>= 0)
        for key, ms in self.doors.items():
            first = [0] * C
            is_open = [False] * C
            for m in ms:
                is_open[m] = True
            d = None
            for j in range(2 * C - 1, -1, -1):
                if is_open[j % C]:
                    d = 0
                elif d is not None:
                    d += 1
                if j < C:
                    first[j] = d
            self.first[key] = tuple(first)
        self.board = {}  # (track, station) -> for each tick % cycle_minutes, (train index, wait)
        for key, first in self.first.items():
            row = []
            for c in range(C):
                best = None
                for k in range(self.trains):
                    w = first[(c + k * self.every) % C]
                    if best is None or w < best[1]:
                        best = (k, w)
                row.append(best)
            self.board[key] = tuple(row)
        self.run = {}  # track -> minutes from the departure at the first station to the doors opening at each
        for track, order in (("out", self.stations), ("in", self.stations[::-1])):
            dep = self._arrival(track, order[0], 0)
            self.run[track] = tuple(0 if s == order[0] else (self._arrival(track, s, dep) - dep) % C for s in order)
        self._rows = tuple(self._row(c) for c in range(C))  # (track, i, x, y, dir, at_station) per cycle minute
        self._worst = {}  # (track, a, b) -> the worst wait + ride over the cycle

    def _build(self) -> tuple:
        seq = []

        def run(track, order):
            stops = {self.stop[(track, s)]: s for s in order}
            i = self.stop[(track, order[0])]
            last = self.stop[(track, order[-1])]
            seq.append((track, i, order[0], True))
            while i < last:
                for _ in range(self.speed):
                    i += 1
                    if i in stops or i == last:
                        break
                here = stops.get(i)
                seq.append((track, i, here, here is not None))
                if here is not None and i != last:
                    seq.extend([(track, i, here, True)] * self.dwell)

        run("out", self.stations)
        seq.extend([seq[-1]] * self.layover)
        run("in", self.stations[::-1])
        seq.extend([seq[-1]] * self.layover)
        cycle = self.trains * self.every
        if len(seq) > cycle:
            raise ValueError(f"line {self.id}: a round trip of {len(seq)} minutes does not fit {cycle}")
        seq.extend([seq[-1]] * (cycle - len(seq)))
        return tuple(seq)

    def _arrival(self, track: str, station: str, after: int) -> int:
        """The first cycle minute at or after `after` (mod the cycle) whose doors open there after being shut, or
        the departure minute at a run's first station."""
        C = self.cycle_minutes
        ms = self.doors[(track, station)]
        for d in range(C):
            m = (after + d) % C
            if m in ms and ((m - 1) % C not in ms or len(ms) == 1):
                return m
        return ms[0]

    def _row(self, c: int) -> tuple:
        track, i, at, open_ = self.cycle[c]
        t = self.tracks[track]
        x, y = t[i]
        if i + 1 < len(t):
            nx, ny = t[i + 1]
        else:
            nx, ny = 2 * x - t[i - 1][0], 2 * y - t[i - 1][1]
        return track, i, x, y, _HEADING[(nx - x, ny - y)], at if open_ else None

    def state(self, k: int, tick: int) -> tuple[str, int, str | None, bool]:
        """(track, tile index, station or None, doors open) of train k at the tick."""
        return self.cycle[(tick + k * self.every) % self.cycle_minutes]

    def track_for(self, a: str, b: str) -> str:
        """The track a rider from station a to station b rides: "out" when a comes first."""
        return "out" if self.stations.index(a) < self.stations.index(b) else "in"

    def ride(self, track: str, b: str, k: int, tick: int) -> int:
        """Minutes after boarding train k at `tick` until it next stands with its doors open at station b."""
        C = self.cycle_minutes
        return self.first[(track, b)][(tick + k * self.every + 1) % C] + 1

    def worst(self, track: str, a: str, b: str) -> int:
        """The longest wait plus ride from a's platform to b over every tick of the cycle."""
        key = (track, a, b)
        got = self._worst.get(key)
        if got is None:
            got = 0
            table = self.board[(track, a)]
            for t in range(self.cycle_minutes):
                k, w = table[t]
                m = w + self.ride(track, b, k, t + w)
                if m > got:
                    got = m
            self._worst[key] = got
        return got

    def json(self) -> dict:
        d = self.data
        return {"id": self.id, "name": self.name, "cars": self.cars,
                "tracks": {k: [list(p) for p in v] for k, v in self.corners.items()},
                "track_tiles": {k: len(v) for k, v in self.tracks.items()}, "trains": list(self.train_ids),
                "every": self.every, "speed": self.speed, "dwell": self.dwell, "layover": self.layover,
                "capacity": self.capacity, "fare": self.fare,
                "stations": [{"id": s["id"], "name": s["name"], "i": {"out": s["i"]["out"], "in": s["i"]["in"]},
                              "platforms": [list(r) for r in s["platforms"]], "exits": [list(e) for e in s["exits"]]}
                             for s in d["stations"]]}


class _Rail:
    """The lines of one map and what is derived from them alone."""

    def __init__(self, rail: dict | None) -> None:
        self.lines = {}
        for data in (rail or {}).get("lines", ()):
            ln = Line(data)
            self.lines[ln.id] = ln
        self.train = {}  # train id -> (line, k)
        self.order = []  # every station once, in line order then station order
        for ln in self.lines.values():
            for k, tid in enumerate(ln.train_ids):
                self.train[tid] = (ln, k)
            for s in ln.stations:
                if s not in self.order:
                    self.order.append(s)
        self.rank = {s: n for n, s in enumerate(self.order)}
        self.exits = {}
        for ln in self.lines.values():
            for s in ln.stations:
                self.exits.setdefault(s, ln.exits[s])
        self.serving = {s: tuple(ln for ln in self.lines.values() if s in ln.stations) for s in self.order}
        self.hubs = tuple(s for s in self.order if len(self.serving[s]) > 1)  # where riders change lines


def _rail(town) -> _Rail:
    got = town.memo.get("rail_net")
    if got is None:
        got = town.memo["rail_net"] = _Rail(getattr(town, "rail", None))
    return got


def lines(town) -> dict[str, Line]:
    """{line id: Line}, {} in millbrook; kept in `town.memo["rail"]`."""
    got = town.memo.get("rail")
    if got is None:
        got = town.memo["rail"] = _rail(town).lines
    return got


def fare(age: int) -> int:
    """Dollars a journey: FARE for ages 18 to 64, else free; the transfer at Central is free."""
    return FARE if 18 <= age <= 64 else 0


def boarding(town, line_id: str, track: str, station: str, tick: int) -> tuple[str, int]:
    """(train id, wait) of the first train on `track` with its doors open at `station` at `tick` or later."""
    ln = lines(town)[line_id]
    k, w = ln.board[(track, station)][tick % ln.cycle_minutes]
    return ln.train_ids[k], w


def ride_minutes(town, line_id: str, track: str, a: str, b: str) -> int:
    """Timetable minutes from the train's doors opening at station a to their opening at station b on `track`."""
    ln = lines(town)[line_id]
    order = ln.stations if track == "out" else ln.stations[::-1]
    return ln.run[track][order.index(b)] - ln.run[track][order.index(a)]


def train_xy(town, train_id: str, tick: int) -> tuple[int, int]:
    ln, k = _rail(town).train[train_id]
    row = ln._rows[(tick + k * ln.every) % ln.cycle_minutes]
    return row[2], row[3]


def train_rows(town, tick: int, riders: dict[str, int] | None = None) -> list[dict]:
    """`state.trains`: one row a train, lines in order (region.md 8). Cars are drawn at i-1..i-3."""
    rows = []
    riders = riders or {}
    for ln in lines(town).values():
        C, every, rs = ln.cycle_minutes, ln.every, ln._rows
        for k, tid in enumerate(ln.train_ids):
            track, i, x, y, d, at = rs[(tick + k * every) % C]
            rows.append({"id": tid, "line": ln.id, "track": track, "i": i, "x": x, "y": y, "dir": d,
                         "at_station": at, "riders": riders.get(tid, 0)})
    return rows


def timetable_json(town) -> dict | None:
    """`timetable.train` (region.md 8): per line the stations, trains, headway, cycle, fare, capacity and run
    minutes per track; plus the transfer minutes at each station two lines serve. None in millbrook."""
    r = _rail(town)
    if not r.lines:
        return None
    return {"lines": [{"id": ln.id, "name": ln.name, "stations": list(ln.stations), "trains": ln.trains,
                       "every_minutes": ln.every, "cycle_minutes": ln.cycle_minutes, "fare": ln.fare,
                       "capacity": ln.capacity, "minutes": {"out": list(ln.run["out"]), "in": list(ln.run["in"])}}
                      for ln in r.lines.values()],
            "transfer": {s: TRANSFER_MINUTES for s in r.hubs}}


def rail_json(town) -> dict | None:
    """`welcome.town.rail` (region.md 8). None in millbrook."""
    r = _rail(town)
    if not r.lines:
        return None
    return {"lines": [ln.json() for ln in r.lines.values()]}


# --- trips ------------------------------------------------------------------------------------------------------
class TrainTrip(NamedTuple):
    minutes: int  # door to door
    board: str  # first station boarded
    alight: str  # last station left
    legs: tuple  # (kind, t0, t1, data): WALK/DRIVE Route, WAIT station id, RIDE train id; t1 of one is t0 of the next


def _store(cache: dict, key, value):
    if len(cache) >= CACHE_CAP:
        cache.clear()
    cache[key] = value
    return value


def _access(r: _Rail, net, a, car: bool) -> tuple:
    """The TOP best stations from end a: ((minutes, rank, station, via, mode), ...); via is the station id (its
    entry) or an exit tile, whose minutes include PLATFORM_MINUTES; mode "walk" or "car" (park and ride)."""
    cache = net.memo.setdefault("rail_access", {})
    key = (a, car)
    got = cache.get(key)
    if got is not None:
        return got
    best = []
    for s in r.order:
        exits = r.exits[s]
        top = (net.minutes(a, s, "walk"), s, "walk")
        for e in exits:
            m = net.minutes(a, e, "walk") + PLATFORM_MINUTES
            if m < top[0]:
                top = (m, e, "walk")
        if car:
            m = net.minutes(a, s, "car")
            if m <= PARK_RIDE_MAX and m < top[0]:
                top = (m, s, "car")
            for e in exits:
                m = net.minutes(a, e, "car")
                if m <= PARK_RIDE_MAX and m + PLATFORM_MINUTES < top[0]:
                    top = (m + PLATFORM_MINUTES, e, "car")
        best.append((top[0], r.rank[s], s, top[1], top[2]))
    best.sort(key=lambda c: (c[0], c[1]))
    return _store(cache, key, tuple(best[:TOP]))


def _egress(r: _Rail, net, b) -> tuple:
    """The TOP best stations to end b on foot: ((minutes, rank, station, via, "walk"), ...)."""
    cache = net.memo.setdefault("rail_egress", {})
    got = cache.get(b)
    if got is not None:
        return got
    best = []
    for s in r.order:
        top = (net.minutes(s, b, "walk"), s)
        for e in r.exits[s]:
            m = PLATFORM_MINUTES + net.minutes(e, b, "walk")
            if m < top[0]:
                top = (m, e)
        best.append((top[0], r.rank[s], s, top[1], "walk"))
    best.sort(key=lambda c: (c[0], c[1]))
    return _store(cache, b, tuple(best[:TOP]))


def _plans(r: _Rail, s: str, t: str) -> tuple:
    """Ways from station s to station t: ((line, track, s, t),) on one line, or two rides changing at a hub."""
    for ln in r.serving[s]:
        if t in ln.stations:
            return (((ln, ln.track_for(s, t), s, t),),)
    out = []
    for x in r.hubs:
        for l1 in r.serving[s]:
            if x not in l1.stations:
                continue
            for l2 in r.serving[t]:
                if l2 is l1 or x not in l2.stations:
                    continue
                out.append(((l1, l1.track_for(s, x), s, x), (l2, l2.track_for(x, t), x, t)))
    return tuple(out)


def trip_via_roads(town, net, a, b, tick: int, car: bool = False) -> TrainTrip | None:
    """The fastest train trip from end a to end b leaving at `tick`, or None (no railway, or no pair of stations).
    Its legs are chained from `tick` to `tick + minutes`."""
    r = _rail(town)
    if not r.lines:
        return None
    if a.__class__ is list:
        a = tuple(a)
    if b.__class__ is list:
        b = tuple(b)
    acc = _access(r, net, a, car)
    egr = _egress(r, net, b)
    best = None
    for am, arank, s, avia, amode in acc:
        for em, erank, t, evia, _ in egr:
            if s == t:
                continue
            for plan in _plans(r, s, t):
                now = tick + am
                rides = []
                for n, (ln, track, x, y) in enumerate(plan):
                    if n:
                        now += TRANSFER_MINUTES
                    k, w = ln.board[(track, x)][now % ln.cycle_minutes]
                    t0 = now + w
                    now = t0 + ln.ride(track, y, k, t0)
                    rides.append((t0, now, ln.train_ids[k], x))
                key = (now + em - tick, arank, erank)
                if best is None or key < best[0]:
                    best = (key, (am, s, avia, amode), (em, t, evia), rides)
    if best is None:
        return None
    (minutes, _, _), (am, s, avia, amode), (em, t, evia), rides = best
    legs = []
    route = net.route(a, avia, amode, keep=False)
    legs.append((DRIVE if amode == "car" else WALK, tick, tick + route.minutes, route))
    now = tick + route.minutes
    for t0, t1, tid, x in rides:
        legs.append((WAIT, now, t0, x))
        legs.append((RIDE, t0, t1, tid))
        now = t1
    if not isinstance(evia, str):
        legs.append((WAIT, now, now + PLATFORM_MINUTES, t))
        now += PLATFORM_MINUTES
    route = net.route(evia, b, "walk", keep=False)
    legs.append((WALK, now, now + route.minutes, route))
    return TrainTrip(minutes, s, t, tuple(legs))


def worst_minutes(town, net, a, b, car: bool = False) -> int | None:
    """The longest door-to-door train trip from a to b over every departure tick (never shorter than
    `trip_via_roads(...).minutes`), or None; memoized as an int."""
    r = _rail(town)
    if not r.lines:
        return None
    if a.__class__ is list:
        a = tuple(a)
    if b.__class__ is list:
        b = tuple(b)
    cache = net.memo.setdefault("rail_worst", {})
    key = (a, b, car)
    if key in cache:
        return cache[key]
    best = None
    for am, _, s, _, _ in _access(r, net, a, car):
        for em, _, t, _, _ in _egress(r, net, b):
            if s == t:
                continue
            for plan in _plans(r, s, t):
                m = am + em + TRANSFER_MINUTES * (len(plan) - 1)
                for ln, track, x, y in plan:
                    m += ln.worst(track, x, y)
                if best is None or m < best:
                    best = m
    return _store(cache, key, best)

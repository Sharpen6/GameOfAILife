"""How townsfolk get about (folk.md 5 Trips, PLAN 2.3): on foot, by car or by train, planned whole at departure.

This module is folk's only importer of `roads` and `rail`. A trip is a list of legs `(kind, t0, t1, data)` in
absolute ticks: WALK and DRIVE legs carry a `roads.Route`, WAIT the station's place id, RIDE the train id. A
person's position is a pure function of the tick: `Route.at(now - t0)` on a road leg, the station during a wait,
aboard (not on the street) during a ride. Nothing here draws dice; routes are built with `keep=False`, so they
live only on active trips.

The rule (folk.md 5): walk when the walk is at most WALK_MAX minutes; else drive when the person has a car and it
is faster; else take the train when it saves TRAIN_SAVES minutes on a walk over TRAIN_WALK (a car owner rides when
the train, park-and-ride included, is within PARK_RIDE_SLACK of the car); else walk. A commute keeps the mode the
generator chose (`p.commute`), so ridership follows region.md 7's demand rules.
"""

from __future__ import annotations

from . import rail, roads

WALK, DRIVE, WAIT, RIDE = 0, 1, 2, 3  # leg kinds, as folk_model's and rail's
WALK_MAX = 12  # minutes: always walk a trip this short
TRAIN_WALK = 20  # the train is considered only when the walk is longer than this ...
TRAIN_SAVES = 5  # ... and it must save at least this many minutes on it
PARK_RIDE_SLACK = 8  # a car owner rides when the train is within this many minutes of driving
REACH = {"walk": 45, "car": 45, "train": 60}  # the longest commute by each mode (commute_minutes; None beyond)


def net(town):
    return roads.roadnet(town)


def minutes(town, a, b, mode: str = "walk") -> int:
    """Door-to-door road minutes between two places (0 for the same place)."""
    if a == b:
        return 0
    return net(town).minutes(a, b, "car" if mode in ("car", "ambulance") else "walk")


def road_leg(town, kind: int, a, b, t0: int) -> tuple:
    """One WALK or DRIVE leg from a to b leaving at t0."""
    route = net(town).route(a, b, "walk" if kind == WALK else "car", keep=False)
    return (kind, t0, t0 + max(1, route.minutes), route)


def train_trip(town, a, b, tick: int, car: bool):
    """rail.trip_via_roads, or None while the rail planner is not there (or no line serves the pair)."""
    plan = getattr(rail, "trip_via_roads", None)
    if plan is None:
        return None
    try:
        return plan(town, net(town), a, b, tick, car=car)
    except NotImplementedError:
        return None


def _legs_of(trip, tick: int) -> list:
    """A TrainTrip's legs as absolute ticks (the planner gives them from the departure tick)."""
    legs = list(trip.legs)
    if legs and legs[0][1] < tick:  # relative minutes: shift them to the departure
        legs = [(k, tick + t0, tick + t1, d) for k, t0, t1, d in legs]
    return legs


def choose(town, a, b, tick: int, car: bool, prefer: str | None = None) -> tuple[str, list]:
    """(mode, legs) for a trip from a to b leaving at tick: "walk", "car", "train" or "ambulance".

    `prefer` (a commute's mode, or "ambulance") is kept when it can be done; otherwise the rule above decides."""
    if a == b:
        return "walk", []
    if prefer == "ambulance":
        return "ambulance", [road_leg(town, DRIVE, a, b, tick)]
    if prefer == "car" and car:
        return "car", [road_leg(town, DRIVE, a, b, tick)]
    if prefer == "train":
        trip = train_trip(town, a, b, tick, car)
        if trip is not None:
            return "train", _legs_of(trip, tick)
    if prefer == "walk":
        return "walk", [road_leg(town, WALK, a, b, tick)]
    walk = minutes(town, a, b, "walk")
    if walk <= WALK_MAX:
        return "walk", [road_leg(town, WALK, a, b, tick)]
    drive = minutes(town, a, b, "car") if car else None
    if walk > TRAIN_WALK:
        trip = train_trip(town, a, b, tick, car)
        if trip is not None and trip.minutes + TRAIN_SAVES <= walk and (
                drive is None or trip.minutes <= drive + PARK_RIDE_SLACK):
            return "train", _legs_of(trip, tick)
    if drive is not None and drive < walk:
        return "car", [road_leg(town, DRIVE, a, b, tick)]
    return "walk", [road_leg(town, WALK, a, b, tick)]


def best_minutes(town, a, b, car: bool) -> tuple[int, str] | None:
    """(minutes, mode) of the best allowed commute from a to b, the worst train wait counted; None out of reach
    (beyond REACH for every mode)."""
    if a == b:
        return 0, "walk"
    best = None
    walk = minutes(town, a, b, "walk")
    if walk <= REACH["walk"]:
        best = (walk, "walk")
    if car:
        drive = minutes(town, a, b, "car")
        if drive <= REACH["car"] and (best is None or drive < best[0]):
            best = (drive, "car")
    worst = getattr(rail, "worst_minutes", None)
    if worst is not None and walk > TRAIN_WALK:
        try:
            m = worst(town, net(town), a, b, car=car)
        except NotImplementedError:
            m = None
        if m is not None and m <= REACH["train"] and (best is None or m + TRAIN_SAVES <= best[0]):
            best = (m, "train")
    return best


def end_of(legs: list, tick: int) -> int:
    return legs[-1][2] if legs else tick


def leg_at(legs: list, now: int):
    """The leg under way at `now` (the last one once it is over), or None for no legs."""
    if not legs:
        return None
    for leg in legs:
        if now < leg[2]:
            return leg
    return legs[-1]


def boardings(legs: list) -> int:
    return sum(1 for leg in legs if leg[0] == RIDE)


def fare(age: int) -> int:
    return rail.fare(age)


def station_xy(town, station_id: str) -> tuple[int, int]:
    p = town.places[station_id]
    return p.entry[0], p.entry[1]

"""Townsfolk data model (folk.md 3, amended by PLAN 2.2-2.7): ids, constants, FolkHousehold, Trip and Person.

A townsperson is a `Person`, never an `Agent`: it lives in `sim.folk.people` (index `i`, id `"f<i>"`), duck-types
life.md 3.2's person protocol, and keeps its needs lazily: `_needs` holds the raw needs as of tick `_nt`, and the
`needs` / `mood` / `adjust` / `x` / `y` read interface settles them to `Person.clock.tick` first (`Person.clock` is
set by `Folk.__init__`). Folk's own code reads the raw fields. `people` (L1) is imported lazily (PLAN 2.16).
"""

from __future__ import annotations

from dataclasses import dataclass, field

from . import agent
from .agent import NEED_DECAY, NEEDS

FOLK_DEFAULT = 1000
NS_FOLK, NS_GEN, NS_TOWN, NS_TEXT, NS_STROLL, NS_FOLK_HOME = 101, 102, 103, 104, 105, 106  # dice; life's are 1-18
WALK, DRIVE, WAIT, RIDE = 0, 1, 2, 3  # trip leg kinds (rail.py's)
K_WALK, K_CAR, K_AMBULANCE, K_WAIT, K_OUTDOORS = 0, 2, 5, 6, 7  # crowd modes (view.md 4.2)

MEMORY_KEEP, CHOICES_KEEP, INBOX_KEEP = 10, 5, 5
# Need decay scale by busy activity: sim.py's DECAY_SCALE (folk settle with the same tables).
DECAY_SCALE = {
    "sleep": {"energy": 0.0, "hunger": 0.35, "social": 0.0, "fun": 0.0},
    "work": {"social": 0.0, "fun": 1.3, "hunger": 0.6},
    "hospital": {"social": 0.5, "fun": 0.5},
}
# Health as the named have it (sim._decay): hunger at 0 costs HUNGER_HEALTH a minute; every need above WELL_ABOVE
# heals HEAL a minute up to life.max_health. Person.settle applies both in closed form, so reading a townsperson's
# needs (a page, the hourly stats) never changes what their health comes to.
HUNGER_HEALTH, HEAL, WELL_ABOVE = 0.03, 0.004, 40.0


def folk_id(i: int) -> str:
    return f"f{i}"


def household_id(j: int) -> str:
    return f"fh{j}"


@dataclass(eq=False)
class FolkHousehold(agent.Household):
    """Every Household field, so housing's helpers take it unchanged; id "fh<j>", member_ids ["f12", ...] (filter on
    alive and not gone)."""
    j: int = -1
    gone: bool = False
    dinner_day: int = -1


@dataclass(eq=False)
class Trip:
    legs: list  # [(kind, t0, t1, data)]: WALK/DRIVE a roads.Route, WAIT a station place id, RIDE a train id
    dest: str
    then: str
    until: int
    mode: str  # "walk" | "car" | "train" | "ambulance"


class Person:
    """One townsperson. life.md 3.2's protocol plus folk.md 3's own fields."""

    __slots__ = ("id", "name", "age", "alive", "died", "luck", "health", "reputation", "money", "savings",
                 "owns_car", "job", "household_id", "inside", "activity", "activity_place", "state",
                 "relationships", "life", "memory", "traits", "sex",
                 "i", "hh", "gone", "trip", "next_tick", "worked_day", "fav", "choices", "inbox", "commute",
                 "skill", "role", "_needs", "_nt")

    clock = None  # the simulation's Clock, set by Folk.__init__ (lazy needs settle to clock.tick)
    town = None  # the TownMap, set by Folk.__init__ (positions)
    locate = None  # optional (p, tick) -> (x, y) | None, set by folk.py (strolls); None = the default below
    profile = None  # Agent read interface: no Profile, no controller
    controller = None

    def __init__(self, i: int, name: str, age: int, sex: str, hh: int):
        self.i = i
        self.id = folk_id(i)
        self.name = name
        self.age = age
        self.sex = sex  # "f" | "m"
        self.hh = hh
        self.household_id = household_id(hh)
        self.alive = True
        self.died = None  # {"tick", "time", "how"}
        self.gone = False  # left town
        self.luck = agent.START_LUCK
        self.health = 90.0
        self.reputation = 50.0
        self.money = 0.0
        self.savings = 0.0
        self.owns_car = False
        self.job = None  # agent.Job (a folk worker's job.slot is its career board slot); pupils: a "student" Job
        self.inside = None
        self.activity = "sleep"
        self.activity_place = None
        self.state = "busy"
        self.relationships = {}  # dict[str, agent.Relationship] over folk and named ids (people.set_rel)
        self.life = None  # life.LifeState, set by life.init
        self.memory = []  # last MEMORY_KEEP lines "stamp: text"
        self.traits = {}  # Profile.TRAITS keys
        self.trip = None  # Trip while travelling
        self.next_tick = 0
        self.worked_day = -1
        self.fav = {}  # LEISURE key -> [place ids] nearest first
        self.choices = []  # last CHOICES_KEEP {time, kind, options, choice, by}
        self.inbox = []  # last INBOX_KEEP messages
        self.commute = None  # (place, minutes, mode) | None
        self.skill = 0.0  # job matching (generation)
        self.role = "a"  # household role at generation: "a" head or partner, "k" child, "g" grandparent, "s" sharer
        self._needs = {n: 75.0 for n in NEEDS}
        self._nt = 0

    def __repr__(self) -> str:
        return f"Person({self.id}, {self.name!r}, {self.age})"

    # --- lazy needs ------------------------------------------------------------------------------------------

    def settle(self, tick: int | None = None) -> None:
        """Bring the raw needs forward to `tick` (default the clock's): v2's per-minute decay by activity, as a
        closed form (decay only falls, so clamping at the end equals clamping each minute), and health with them:
        HEAL a minute while every need is above WELL_ABOVE, then HUNGER_HEALTH a minute once hunger is at 0. Each
        is additive over the minutes, so settling in pieces comes to the same as settling once."""
        if tick is None:
            clock = Person.clock
            if clock is None:
                return
            tick = clock.tick
        dt = tick - self._nt
        if dt <= 0:
            return
        self._nt = tick
        if not self.alive:
            return  # the dead keep their last needs
        if self.age < 5:
            self._heal(dt)  # under-5s are held at 75 by folk.py: always well
            return
        scale = DECAY_SCALE.get(self.activity if self.state == "busy" else "", {})
        needs = self._needs
        well = dt  # the minutes every need stays above WELL_ABOVE
        starve = 0.0  # the minutes hunger spends at 0
        for n in NEEDS:
            v0 = needs[n]
            rate = NEED_DECAY[n] * scale.get(n, 1.0)
            if v0 <= WELL_ABOVE:
                well = 0
            elif rate > 0 and v0 - rate * dt <= WELL_ABOVE:
                left = (v0 - WELL_ABOVE) / rate
                if left < well:
                    well = left
            if n == "hunger" and rate > 0 and v0 - rate * dt < 0:
                starve = dt - v0 / rate
            v = v0 - rate * dt
            needs[n] = 0.0 if v < 0.0 else 100.0 if v > 100.0 else v
        if well > 0:
            self._heal(well)
        if starve > 0:
            h = self.health - HUNGER_HEALTH * starve
            self.health = 0.0 if h < 0.0 else h

    def _heal(self, minutes: float) -> None:
        from . import life  # lazy: L2's module reaches folk
        top = life.max_health(self)
        if self.health < top:
            h = self.health + HEAL * minutes
            self.health = top if h > top else h

    @property
    def needs(self) -> dict:
        self.settle()
        return self._needs

    def adjust(self, need: str, delta: float) -> None:
        self.settle()
        v = self._needs[need] + delta
        self._needs[need] = 0.0 if v < 0.0 else 100.0 if v > 100.0 else v

    @property
    def mood(self) -> float:
        self.settle()
        total = 0.0
        for n in NEEDS:
            total += self._needs[n]
        return total / len(NEEDS)

    def remember(self, stamp: str, text: str) -> None:
        self.memory.append(f"{stamp}: {text}")
        del self.memory[:-MEMORY_KEEP]

    def choose(self, entry: dict) -> None:
        self.choices.append(entry)
        del self.choices[:-CHOICES_KEEP]

    @property
    def is_adult(self) -> bool:
        return self.age >= 18

    @property
    def present(self) -> bool:
        """Alive and still in town."""
        return self.alive and not self.gone

    # --- position --------------------------------------------------------------------------------------------

    def position(self, tick: int | None = None) -> tuple[int, int]:
        """The tile: along the current trip leg, else (folk.py's `Person.locate`, e.g. a park stroll), else the entry
        of the place they are in or at."""
        if tick is None:
            clock = Person.clock
            tick = clock.tick if clock is not None else 0
        trip = self.trip
        if trip is not None and trip.legs:
            leg = trip.legs[-1]
            for lg in trip.legs:
                if tick < lg[2]:
                    leg = lg
                    break
            kind, t0, t1, data = leg
            if kind == WALK or kind == DRIVE:
                m = tick - t0
                if m < 0:
                    m = 0
                at = data.at(m)
                return at[0], at[1]
            town = Person.town
            if kind == WAIT and town is not None and data in town.places:
                e = town.places[data].entry
                return e[0], e[1]
            if kind == RIDE and town is not None:
                from . import rail  # lazy: R2's module
                xy = rail.train_xy(town, data, tick)
                return xy[0], xy[1]
        fn = Person.locate
        if fn is not None:
            xy = fn(self, tick)
            if xy is not None:
                return xy[0], xy[1]
        town = Person.town
        pid = self.inside or self.activity_place
        if town is not None and pid is not None and pid in town.places:
            e = town.places[pid].entry
            return e[0], e[1]
        return 0, 0

    @property
    def x(self) -> int:
        return self.position()[0]

    @property
    def y(self) -> int:
        return self.position()[1]


def people_module():
    """`people` (L1), imported lazily so this module imports on a branch without it (PLAN 2.16)."""
    from . import people
    return people

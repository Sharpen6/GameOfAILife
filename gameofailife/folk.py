"""Townsfolk daily life (folk.md 5, PLAN 2.3): 1,000 people who live default lives without an LLM.

`Folk` is `sim.folk` when townsfolk exist (`people.make_folk`). Days run on an event wheel: `wheel[tick]` lists the
people whose current stay or trip ends then; `tick` steps them in list order and each step plans the next stay or
trip whole, so nobody is touched between events. Positions are pure functions of the tick (folk_transit's legs, a
park stroll's hop, else the place entry), so the crowd is computed only when a frame asks for it.

Each step settles needs, then takes the first case that matches (folk.md 5): arriving; under 5; just woke; a shift
or school day not yet started; a shift just ended; bedtime; otherwise a free-time choice. Free-time choices offer
exactly 4 options scored by folk's own scorer (`score_options`: the same terms as `forks.default_scores`, read from
the Person). A lead of OBVIOUS_MARGIN is habit; otherwise a little noise from the step's dice decides ("default").
Every step draws from `dice.stream(sim.dice_seed, NS_FOLK, i, now)`; strolls from `dice.key(sim.dice_seed,
NS_STROLL, i, now // 5)`. Folk never draw `sim.rng`.

Life (L2) owns illness, death, births and careers; money at shift end and on Sundays is `folk_life`'s (F1). The
module functions below are the folk side of life.md 3.2's contract.
"""

from __future__ import annotations

import importlib
import time
from collections import deque

from . import folk_transit
from .agent import NEEDS
from .folk_model import (K_AMBULANCE, K_CAR, K_OUTDOORS, K_WAIT, K_WALK, NS_FOLK, NS_STROLL, DRIVE,
                         RIDE, WAIT, WALK, Person, Trip)

DAY = 1440
OBVIOUS_MARGIN = 0.45  # forks.OBVIOUS_MARGIN: the lead at which habit decides
NOISE = 0.08  # otherwise each option gets uniform(0, NOISE) and the best wins ("default")
TRAVEL_COST = 0.004  # forks.TRAVEL_COST: value lost per minute an option adds to the day's travel
NIGHT_TRAVEL, NIGHT_FROM, NIGHT_UNTIL = 2, 20, 7  # forks' night rate
STYLE = 0.6  # forks.default_scores' style weight
SHIFT_MARGIN = 10  # minutes spare before a shift, on average: each person keeps 10 +- SHIFT_SPREAD of their own
SHIFT_SPREAD = 5
LATE_GRACE = 5  # minutes late before reputation suffers
EVENING = 19 * 60  # choices after this are "evening" ones
DINNER_FROM, DINNER_UNTIL, DINNER_MINUTES = 17 * 60 + 30, 19 * 60 + 30, 45  # the family dinner, once a day
# Off sick (life.can_work False), a townsperson rests at home (sick_home) until the next of these meals or bedtime,
# eats at home (eat_home, a grocery) and rests again; breakfast is on waking, as every day.
LUNCH = 12 * 60 + 30
SICK_MEALS = (LUNCH, 18 * 60 + 30)
# A late shift's morning at home (they set off after LUNCH + MEAL_MINUTES) breaks for lunch at LUNCH, a meal at
# home as off sick: breakfast, the shift's own lunch break and nothing more would starve them by inches.
MEAL_MINUTES = 30
STROLL_EVERY = 5  # minutes between a park stroller's hops
STROLL_MINUTES = 10  # one way of a stroll round the block when no park is in reach
FAV_WALK, FAV_CAR, FAV_KEEP = 25, 15, 3  # favourites: the nearest FAV_KEEP within these minutes
UNAVAILABLE = -9.0  # the score of an option whose place is shut or full
CPU_KEEP = 1440  # ticks of CPU timings kept for the perf report
WARD = "ward"
FREE = ("relax_home", "eat_home", "walk_park", "coffee", "eat_out", "shopping", "hang_out", "buy_groceries",
        "idle", "stroll", "movie", "golf", "read", "order_groceries")  # activities that can be interrupted (is_free)

# activity -> (need gains over the whole stay, outdoors). Decay is folk_model's (DECAY_SCALE by activity).
ACT = {
    "sleep": ({}, False),  # energy: SLEEP_ENERGY a minute (v2's 0.17)
    "baby": ({}, False),
    "eat_home": ({"hunger": 60, "social": 4}, False),
    "relax_home": ({"fun": 25, "energy": 5}, False),
    "dinner_home": ({"hunger": 50, "social": 10, "fun": 5}, False),
    "sick_home": ({"energy": 20}, False),
    "work": ({"hunger": 30}, False),  # a lunch break
    "school": ({"hunger": 30, "social": 25, "fun": 10}, False),
    "coffee": ({"energy": 15, "social": 5}, False),
    "eat_out": ({"hunger": 55, "social": 10, "fun": 6}, False),
    "buy_groceries": ({}, False),
    "order_groceries": ({}, False),
    "shopping": ({"fun": 20}, False),
    "hang_out": ({"social": 40, "fun": 25}, False),
    "walk_park": ({"fun": 30, "social": 4}, True),
    "stroll": ({"fun": 15}, True),
    "movie": ({"fun": 45, "social": 10}, False),
    "golf": ({"fun": 40, "social": 15}, False),
    "read": ({"fun": 25}, False),
    "ward": ({"hunger": 40}, False),
    "idle": ({}, False),
}
SLEEP_ENERGY = 0.17
HOME_ACTS = ("sleep", "baby", "eat_home", "relax_home", "dinner_home", "sick_home", "order_groceries")
KEEP_OPEN = HOME_ACTS + ("work", "school", WARD, "idle")  # stays that do not end at closing time
LEISURE = {  # favourite key -> (place kind, styles or None for any)
    "coffee": ("cafe", ("cafe", "bakery")),
    "eat_out": ("cafe", None),
    "shopping": ("shop", ("shop", "arcade", "mall")),
    "groceries": ("market", None),
    "park": ("park", None),
}
GROCERY_COST, COFFEE_COST, MEAL_COST, DINNER_COST, HANG_COST = 35, 4, 14, 20, 8
# A day out (folk.md 5 day_off d), by (kind, style): (activity, label, cost or None for the shopping spend, min age)
DAY_OUT = {("shop", "mall"): ("shopping", "A day at the mall", None, 0),
           ("venue", "cinema"): ("movie", "See a film", 12, 0),
           ("venue", "clubhouse"): ("golf", "A round of golf", 40, 40),
           ("townhall", "library"): ("read", "Read at the library", 0, 0)}
DAY_OUT_WALK, DAY_OUT_CAR, DAY_OUT_MINUTES = 40, 25, 150  # reach from home, and the stay
GROCERY_MEALS = 10
# With no grocer in reach (no market or grocer's within FAV_WALK on foot, or FAV_CAR by car), groceries are
# ordered in from home: the same shop for DELIVERY_FEE more, DELIVERY_MINUTES at home to order and take them in.
DELIVERY_FEE, DELIVERY_MINUTES = 8, 15
# Outcomes of an outing (folk.md 5), keyed dice into the luck log: (what, valence, chance, money, fun)
BARGAIN = ("bargain", 1, 0.05, 15, 0)  # shopping or groceries
PICKPOCKET = ("pickpocket", -1, 0.003, -60, 0)  # any outing
RAINED_OUT = ("rained_out", -1, 0.5, 0, -10)  # a park walk or stroll in the rain


_LAZY: dict = {}  # name -> module: folk's imports that would be cycles at load time, each looked up once


def _lazy(name: str):
    got = _LAZY.get(name)
    if got is None:
        got = _LAZY[name] = importlib.import_module(f"{__package__}.{name}")
    return got


def _dice():
    return _lazy("dice")  # L1's module


def _people():
    return _lazy("people")


def _life():
    return _lazy("life")


def _career():
    return _lazy("career")


def _folk_life():
    return _lazy("folk_life")


def urgency(level: float) -> float:
    u = (100 - level) / 100
    return u * u


class Option:
    """One of a choice's 4 options: what it does, where, for how long, and what folk's scorer reads."""

    __slots__ = ("label", "activity", "place", "minutes", "cost", "tags", "gains", "base", "until", "companion")

    def __init__(self, label, activity, place, minutes, cost=0, tags=None, gains=None, base=0.0):
        self.label, self.activity, self.place, self.minutes = label, activity, place, minutes
        self.cost, self.tags, self.gains, self.base = cost, tags or {}, gains or {}, base
        self.until = None
        self.companion = None


class Folk:
    """The townsfolk of one Simulation (PLAN 2.3). n 0: empty, every call a no-op."""

    def __init__(self, sim, n: int, isolated: bool = False, *, populate=None):
        self.sim = sim
        self.n = int(n)
        self.isolated = bool(isolated)
        self.v = 0
        self.people: list[Person] = []
        self.households: list = []
        self.wheel: dict[int, list[int]] = {}
        self.out: dict[int, None] = {}  # people on a trip, in insertion order
        self.strollers: dict[int, str] = {}  # people strolling in a park -> the park
        self.luck_log = deque(maxlen=5000)
        self.counters = {"steps": 0, "choices": 0, "habit": 0, "shifts": 0, "school_days": 0, "trips": 0,
                         "boardings": 0, "train_trips": 0, "late": 0, "sick_days": 0, "starved": 0,
                         "school_runs": 0}
        self.today = {"boardings": 0, "train_trips": 0, "lines": {}}  # since midnight
        self._lines = None  # train id -> line id
        self.cpu = deque(maxlen=CPU_KEEP)  # process_time per tick, seconds
        self.cpu_total = 0.0
        self.ticks = 0
        town = sim.town
        self.town = town
        self.place_ids = list(town.places)
        self.pidx = {pid: k for k, pid in enumerate(self.place_ids)}
        self.count = [0] * len(self.place_ids)  # folk inside each place (park strollers are outdoors)
        self.occupants: dict[str, dict[int, None]] = {}
        self.where: dict[int, str] = {}  # i -> place the person is at (inside or strolling)
        self.stay: dict[int, tuple] = {}  # i -> (start tick, end tick) of the current stay
        self.ends: dict[int, int] = {}  # i -> real end of a stay longer than a day (re-checked daily)
        self.rings: dict[int, deque] = {}  # i -> hourly worth, the last 24
        self._fav_cache: dict = {}
        self._park_tiles: dict = {}
        self._bed: dict[int, int] = {}
        self._wake: dict[int, int] = {}
        self._spare: dict[int, int] = {}  # i -> minutes spare before a shift
        self._shifts: dict[int, tuple] = {}  # i -> (job, minutes its day starts and ends late: folk_gen.shift_offset)
        self._driven: dict[int, tuple] = {}  # pupil i -> (driver i, departure tick) of a school run
        self.sent: dict[int, None] = {}  # people on a send_to errand (an invite, a date): not free until its stay ends
        self._bind()
        if self.n <= 0:
            self.n = 0
            return
        if populate is None:
            from . import folk_gen
            populate = folk_gen.populate
        populate(self, sim, self.n)
        self._start(sim)

    def _bind(self) -> None:
        """Point folk_model's Person at this Simulation's clock, town and locator. They are class attributes, so
        each entry point re-binds them: with two Simulations in one process the last one built must not win."""
        Person.clock = self.sim.clock
        Person.town = self.town
        Person.locate = self._locate

    # --- lookups ---------------------------------------------------------------------------------------------

    def person(self, pid):
        if not isinstance(pid, str) or not _people().is_folk_id(pid):
            return None
        i = int(pid[1:])
        return self.people[i] if 0 <= i < len(self.people) else None

    get = person

    def _line_of(self, train_id):
        m = self._lines
        if m is None:
            m = self._lines = {t: ln["id"] for ln in ((self.town.rail or {}).get("lines") or []) for t in ln["trains"]}
        return m.get(train_id, train_id)

    def region_parts(self, sim) -> dict:
        """The townsfolk's part of `stats.region` (stats.region_block): how many, how commuters (workers and
        pupils) go, and today's train boardings in all and by line."""
        commute: dict[str, int] = {}
        folk = 0
        for p in self.people:
            if not p.alive or p.gone:
                continue
            folk += 1
            if p.job is not None and p.commute is not None:
                mode = p.commute[2]
                commute[mode] = commute.get(mode, 0) + 1
        return {"folk": folk, "commute": commute, "train_riders_today": self.today["boardings"],
                "train_lines_today": dict(self.today["lines"]), "bus_riders_today": 0}

    def living(self) -> list:
        return [p for p in self.people if p.alive and not p.gone]

    def household(self, hid):
        if not isinstance(hid, str) or not hid.startswith("fh") or not hid[2:].isdigit():
            return None
        j = int(hid[2:])
        return self.households[j] if 0 <= j < len(self.households) else None

    def hh_of(self, p):
        return self.households[p.hh] if 0 <= p.hh < len(self.households) else None

    def home_place(self, p) -> str | None:
        hh = self.hh_of(p)
        if hh is None or hh.home_id is None:
            return None
        home = getattr(self.sim, "homes", {}).get(hh.home_id)
        if home is not None:
            return home.place
        return hh.home_id if hh.home_id in self.town.places else None

    def allowed(self, place_id) -> bool:
        """Isolated folk never target a Millbrook place (PLAN 2.15)."""
        return not (self.isolated and place_id in getattr(self.town, "millbrook_ids", ()))

    # --- the wheel -------------------------------------------------------------------------------------------

    def schedule(self, p, t: int) -> None:
        now = self.sim.clock.tick
        t = max(int(t), now + 1)
        p.next_tick = t
        b = self.wheel.get(t)
        if b is None:
            self.wheel[t] = [p.i]
        else:
            b.append(p.i)

    def _start(self, sim) -> None:
        """After generation: occupancy from where everyone is, and the wheel from their next_tick."""
        now = sim.clock.tick
        self.wheel = {}
        for p in self.people:
            if not p.alive or p.gone:
                continue
            if p.trip is not None:
                self.out[p.i] = None
            else:
                place = p.inside or self.home_place(p)
                if place is not None:
                    self._enter(p, place)
            if p._nt == 0:
                p._nt = now
            if p.age < 5:
                p.activity = "baby"
            elif p.trip is None and p.activity == "sleep":
                # wake at folk's own minute when that is earlier, so the first morning has time for breakfast
                day = now // DAY
                w = day * DAY + self._wake_minute(p, day)
                if now < w < p.next_tick:
                    p.next_tick = w
            self.stay[p.i] = (now, max(p.next_tick, now + 1))
            self.schedule(p, p.next_tick if p.next_tick > now else self._wake_tick(p, now))

    def tick(self, sim) -> None:
        t0 = time.process_time()
        self._bind()
        self.n = len(self.people)  # anyone added to people (a birth, a newcomer) counts in folk_n
        now = sim.clock.tick
        if now % DAY == 0:
            self.today = {"boardings": 0, "train_trips": 0, "lines": {}}
        b = self.wheel.pop(now, None)
        if b:
            people = self.people
            for i in b:
                p = people[i]
                if p.next_tick == now and p.alive and not p.gone:
                    self.counters["steps"] += 1
                    self.step(sim, p, now)
        dt = time.process_time() - t0
        self.cpu.append(dt)
        self.cpu_total += dt
        self.ticks += 1

    def nightly(self, sim) -> None:
        fl = _folk_life_or_none()
        fn = getattr(fl, "nightly", None) if fl else None
        if fn is not None:
            fn(sim)

    def pensions(self, sim) -> None:
        fl = _folk_life_or_none()
        if fl is not None and hasattr(fl, "pensions"):
            fl.pensions(sim)

    def weekly(self, sim) -> None:
        fl = _folk_life_or_none()
        if fl is not None and hasattr(fl, "weekly"):
            fl.weekly(sim)

    def new_household(self, *args):
        """folk_life.new_household: (member_ids, home_id, how), or (sim, members, home_id, how) as
        housing.new_household passes them (members may be people or ids)."""
        if len(args) == 4:
            args = args[1:]
        member_ids, home_id, how = args
        return _folk_life().new_household(self, member_ids, home_id, how)

    def on_household_empty(self, hh) -> None:
        _folk_life().on_household_empty(self, hh)

    # --- places ----------------------------------------------------------------------------------------------

    def _enter(self, p, place_id: str) -> None:
        self._leave(p)
        p.inside = place_id
        p.activity_place = place_id
        self.where[p.i] = place_id
        self.occupants.setdefault(place_id, {})[p.i] = None
        if p.activity == "walk_park":
            self.strollers[p.i] = place_id
        else:
            k = self.pidx.get(place_id)
            if k is not None:
                self.count[k] += 1

    def _leave(self, p) -> None:
        place = self.where.pop(p.i, None)
        if place is None:
            return
        occ = self.occupants.get(place)
        if occ is not None:
            occ.pop(p.i, None)
        if self.strollers.pop(p.i, None) is None:
            k = self.pidx.get(place)
            if k is not None:
                self.count[k] -= 1
        p.inside = None

    # --- needs -----------------------------------------------------------------------------------------------

    def settle(self, p, now: int) -> None:
        """Needs and health to `now` (folk_model's Person.settle: decay, healing while well, hunger at 0 costing
        health); under-5s are held at 75."""
        p.settle(now)
        if p.age < 5:
            for n in NEEDS:
                p._needs[n] = 75.0

    def _gain(self, p, now: int) -> None:
        """The stay that ends now (or is cut short) gives its gains, pro rata."""
        start, end = self.stay.get(p.i, (now, now))
        span = end - start
        if span <= 0 or p.state != "busy":
            return
        frac = min(1.0, (now - start) / span)
        gains = ACT.get(p.activity, ({}, False))[0]
        needs = p._needs
        for n, g in gains.items():
            v = needs[n] + g * frac
            needs[n] = 0.0 if v < 0.0 else 100.0 if v > 100.0 else v
        if p.activity == "sleep":
            v = needs["energy"] + SLEEP_ENERGY * (now - start)
            needs["energy"] = 100.0 if v > 100.0 else v

    # --- the day ---------------------------------------------------------------------------------------------

    def _wake_minute(self, p, day: int) -> int:
        base = self._wake.get(p.i)
        if base is None:
            base = self._wake[p.i] = 360 + _dice().key(self.sim.dice_seed, NS_FOLK, p.i, "wake") % 91
        job = p.job
        if job is not None and day % 7 in job.workdays:
            return min(base, self._set_off(p) - 40)
        if job is not None or p.age >= 18:
            return base + 90  # a day off (the jobless and retired every day)
        return base + 90 if day % 7 >= 5 else base

    def _set_off(self, p) -> int:
        """The minute of the day p sets off for today's shift or school: start - commute - their own margin."""
        spare = self._spare.get(p.i)
        if spare is None:
            k = _dice().key(self.sim.dice_seed, NS_FOLK, p.i, "spare")
            spare = self._spare[p.i] = SHIFT_MARGIN - SHIFT_SPREAD + k % (2 * SHIFT_SPREAD + 1)
        minutes, mode = self._commute_of(p)
        if mode == "train":
            spare = SHIFT_MARGIN  # train commuters time it to the train, so they ride together
        return self._start_minute(p) - minutes - spare

    def _shift(self, p) -> int:
        """Minutes p's shift or school day starts and ends after its job's hours (folk_gen.shift_offset: their own
        on a region job row, 08:30 at a region school but Riverton High), kept while the job is the same."""
        job = p.job
        got = self._shifts.get(p.i)
        if got is not None and got[0] is job:
            return got[1]
        from . import folk_gen
        off = folk_gen.shift_offset(self.sim, p)
        self._shifts[p.i] = (job, off)
        return off

    def _start_minute(self, p) -> int:
        """The minute of the day p's shift or school day starts."""
        return p.job.start_hour * 60 + self._shift(p)

    def _end_minute(self, p) -> int:
        """The minute of the day p's shift or school day ends."""
        return p.job.end_hour * 60 + self._shift(p)

    def _bed_minute(self, p) -> int:
        bed = self._bed.get(p.i)
        if bed is None:
            k = _dice().key(self.sim.dice_seed, NS_FOLK, p.i, "bed")
            if p.age < 13:
                bed = 19 * 60 + 30 + k % 61
            elif p.age < 18:
                bed = 21 * 60 + k % 91
            else:
                bed = 21 * 60 + 30 + k % 121
            self._bed[p.i] = bed
        return bed

    def _wake_tick(self, p, now: int) -> int:
        day, m = divmod(now, DAY)
        w = self._wake_minute(p, day)
        if m < w:
            return day * DAY + w
        return (day + 1) * DAY + self._wake_minute(p, day + 1)

    def _commute_of(self, p) -> tuple[int, str | None]:
        """(minutes, mode) to the job's place: the generator's p.commute when it is for this place."""
        job = p.job
        if job is None:
            return 0, None
        c = p.commute
        if c is not None and c[0] == job.place_id:
            return c[1], c[2]
        home = self.home_place(p)
        best = folk_transit.best_minutes(self.town, home, job.place_id, self._has_car(p)) if home else None
        if best is None:
            best = (folk_transit.minutes(self.town, home, job.place_id, "walk") if home else 0, "walk")
        p.commute = (job.place_id, best[0], best[1])
        return best[0], best[1]

    def _has_car(self, p) -> bool:
        return bool(p.owns_car) and p.age >= 18

    def step(self, sim, p, now: int) -> None:
        self.settle(p, now)
        if p.health <= 0:
            # Starved when hunger at 0 took the last of their health; otherwise (the damp, a chill) they collapse,
            # as a named does at health 0.
            how = "starved" if p._needs["hunger"] <= 0 else "collapsed and could not be saved"
            if how == "starved":
                self.counters["starved"] += 1
            _life().die(sim, p, how)
            if p.alive:  # a life stub that does not kill: keep them off the wheel anyway
                kill(sim, p, how)
            return
        end = self.ends.pop(p.i, None)
        if end is not None and now < end:
            self.ends[p.i] = end
            self.schedule(p, min(end, now + DAY))
            return
        if p.trip is not None:
            self._arrive(sim, p, now)
            return
        self.sent.pop(p.i, None)  # the errand's stay is over (or it was cut short): free time is theirs again
        self._gain(p, now)
        day, m = divmod(now, DAY)
        home = self.home_place(p)
        if p.age < 5:
            if home is not None and p.inside != home:
                self._enter(p, home)
            p.activity, p.state = "baby", "busy"
            self._begin(p, now, "baby", self._wake_tick(p, now) - now)
            return
        act = p.activity
        if act in ("work", "school") and p.state == "busy":
            if act == "work":
                self.counters["shifts"] += 1
                fl = _folk_life_or_none()
                if fl is not None and hasattr(fl, "pay_shift"):
                    fl.pay_shift(sim, p)
                _career().on_shift_end(sim, p)
            else:
                self.counters["school_days"] += 1
                _career().on_shift_end(sim, p)  # a pupil's school day counts as a shift (career: v2's +0.5)
            self.choose(sim, p, now, "evening" if m >= EVENING else "after_work")
            return
        if act == "sleep" and p.state == "busy":
            hh = self.hh_of(p)
            if hh is not None and hh.groceries > 0:
                hh.groceries -= 1
            self._begin(p, now, "eat_home", 30)
            return
        job = p.job
        bed = self._bed_minute(p)
        night = m >= bed or m < self._wake_minute(p, day)
        if act == "sick_home" and p.state == "busy" and not night:
            self._home_meal(p, now)  # a rest off sick ends at a meal at home
            return
        if job is not None and day % 7 in job.workdays and p.worked_day != day and m < self._end_minute(p) - 60:
            commute, mode = self._commute_of(p)
            leave = self._set_off(p)
            early = m < leave
            if early and (p.inside == home or home is None) and not night:
                if act == "relax_home" and LUNCH <= m < LUNCH + 60 and m + MEAL_MINUTES <= leave:
                    self._home_meal(p, now)  # lunch before a late shift
                else:
                    self._begin(p, now, "relax_home", self._lunch_break(m, leave) - m)
                return
            if early and home is not None and leave - m > 60 and not night:
                self._go_home(sim, p, now, "relax_home", day * DAY + self._lunch_break(m, leave))
                return
            if not early or not night:
                p.worked_day = day
                if not _life().can_work(sim, p):
                    self.counters["sick_days"] += 1
                    self._sick_rest(sim, p, now)
                    return
                work = "school" if job.title == "student" or p.age < 18 else "work"
                if work == "school" and mode == "car":
                    self._school_run(p, now, job.place_id)
                self._go(sim, p, now, job.place_id, work, until=day * DAY + self._end_minute(p), prefer=mode)
                return
        if night:
            self._go_home(sim, p, now, "sleep", self._wake_tick(p, now))
            return
        if not _life().can_work(sim, p):  # off sick (or home from hospital) on a day off too: rest, not out
            self._sick_rest(sim, p, now)
            return
        if DINNER_FROM <= m < DINNER_UNTIL and home is not None and p.inside == home and self._dinner(p, now, day):
            return
        self.choose(sim, p, now, "evening" if m >= EVENING else "day_off")

    def _sick_rest(self, sim, p, now: int) -> None:
        """Off sick: rest at home until the next of SICK_MEALS or bedtime (overnight, until they wake)."""
        day, m = divmod(now, DAY)
        until = self._bed_minute(p)
        for meal in SICK_MEALS:
            if m < meal < until:
                until = meal
                break
        self._go_home(sim, p, now, "sick_home", day * DAY + until if until > m else self._wake_tick(p, now))

    @staticmethod
    def _lunch_break(m: int, leave: int) -> int:
        """The minute a morning at home before the shift ends: LUNCH when lunch fits before they set off, else
        when they set off."""
        return LUNCH if m < LUNCH and LUNCH + MEAL_MINUTES <= leave else leave

    def _home_meal(self, p, now: int) -> None:
        """A meal at home (off sick, or lunch before a late shift), as breakfast is (eat_home, a grocery if there is
        one); with the fridge empty the household orders groceries in first (GROCERY_COST + DELIVERY_FEE) when its
        payer can afford them."""
        hh = self.hh_of(p)
        if hh is not None:
            if hh.groceries <= 0:
                payer = self._payer(p) or p
                cost = GROCERY_COST + DELIVERY_FEE
                if payer.money + payer.savings >= cost:
                    payer.money -= cost
                    hh.groceries += GROCERY_MEALS
            if hh.groceries > 0:
                hh.groceries -= 1
        self._begin(p, now, "eat_home", MEAL_MINUTES)

    def _dinner(self, p, now: int, day: int) -> bool:
        """The family dinner (folk.md 5 case 7): once a day, 45 minutes with the members relaxing at home, one
        grocery each. Needs someone to eat with and food in the house."""
        hh = self.hh_of(p)
        if hh is None or hh.dinner_day == day or hh.groceries <= 0:
            return False
        diners = []
        for mid in hh.member_ids:
            q = self.person(mid)
            if q is not None and q is not p and q.alive and not q.gone and q.trip is None and q.inside == p.inside \
                    and q.activity == "relax_home":
                diners.append(q)
        if not diners:
            return False
        hh.dinner_day = day
        hh.groceries = max(0, hh.groceries - len(diners) - 1)
        for q in diners:
            self._gain(q, now)
            self.settle(q, now)
            self.ends.pop(q.i, None)
            self._begin(q, now, "dinner_home", DINNER_MINUTES)
        self._begin(p, now, "dinner_home", DINNER_MINUTES)
        return True

    def _begin(self, p, now: int, activity: str, minutes: int) -> None:
        """A stay where the person is. A leisure stay ends when the place shuts; at a shut place it is home."""
        until = now + max(1, int(minutes))
        if activity not in KEEP_OPEN and p.inside is not None:
            place = self.town.places.get(p.inside)
            if place is not None and place.hours:
                if not place.is_open((now % DAY) / 60):
                    self._go_home(self.sim, p, now, "relax_home", now + 60)
                    return
                close = now // DAY * DAY + place.hours[1] * 60
                if close < until:
                    until = max(now + 1, close)
        p.activity = activity
        p.state = "busy"
        if p.inside is not None:
            p.activity_place = p.inside
        self.stay[p.i] = (now, until)
        if until - now > DAY:
            self.ends[p.i] = until
            until = now + DAY
        self.schedule(p, until)

    def _go_home(self, sim, p, now: int, activity: str, until: int) -> None:
        home = self.home_place(p)
        if home is None or p.inside == home:
            self._begin(p, now, activity, until - now)
        else:
            self._go(sim, p, now, home, activity, until=until)

    def _go(self, sim, p, now: int, dest: str, then: str, until: int | None = None, stay: int = 30,
            prefer: str | None = None) -> None:
        """Plan the whole trip now: legs fixed at departure, arrival on the wheel."""
        src = self.where.get(p.i) or self.home_place(p)
        if src is None or src == dest:
            if src != dest:
                self._enter(p, dest)
            self._begin(p, now, then, (until - now) if until is not None else stay)
            return
        car = self._has_car(p) or (p.age < 18 and prefer == "car")  # a child driven to school rides along
        mode, legs = folk_transit.choose(self.town, src, dest, now, car, prefer)
        arrive = folk_transit.end_of(legs, now)
        if until is None:
            until = arrive + stay
        until = max(until, arrive + 1)
        self._leave(p)
        p.trip = Trip(legs, dest, then, until, mode)
        p.state = "travelling"
        p.activity = then
        p.activity_place = dest
        self.out[p.i] = None
        self.counters["trips"] += 1
        rides = folk_transit.boardings(legs)
        if rides:
            self.counters["boardings"] += rides
            self.counters["train_trips"] += 1
            self.today["boardings"] += rides
            self.today["train_trips"] += 1
            per = self.today["lines"]
            for leg in legs:
                if leg[0] == RIDE:
                    line = self._line_of(leg[3])
                    per[line] = per.get(line, 0) + 1
            fare = folk_transit.fare(p.age)
            if fare:
                p.money -= fare
        self.stay[p.i] = (now, arrive)
        self.schedule(p, arrive)

    def _school_run(self, child, now: int, school: str) -> None:
        """A parent with a car drives a pupil to school and straight back home (folk.md 4's school runs), so the
        car is on the street both ways and the pupil rides as its passenger. Only a member relaxing or eating at
        home, and only when they are back before they set off for their own shift."""
        hh = self.hh_of(child)
        home = self.home_place(child)
        if hh is None or home is None or child.inside != home or child.trip is not None:
            return
        day = now // DAY
        for mid in hh.member_ids:
            d = self.person(mid)
            if d is None or d.age < 18 or not d.alive or d.gone or not d.owns_car or d.trip is not None:
                continue
            if d.inside != home or d.activity not in ("relax_home", "eat_home"):
                continue
            out = folk_transit.road_leg(self.town, DRIVE, home, school, now)
            back = folk_transit.road_leg(self.town, DRIVE, school, home, out[2])
            job = d.job
            if job is not None and day % 7 in job.workdays and d.worked_day != day and \
                    back[2] - day * DAY > self._set_off(d):
                continue
            self._gain(d, now)
            self.settle(d, now)
            self.ends.pop(d.i, None)
            self._leave(d)
            d.trip = Trip([out, back], home, "relax_home", back[2] + 1, "car")
            d.state = "travelling"
            d.activity = "school_run"
            d.activity_place = school
            self.out[d.i] = None
            self.counters["trips"] += 1
            self.counters["school_runs"] += 1
            self.stay[d.i] = (now, back[2])
            self.schedule(d, back[2])
            self._driven[child.i] = (d.i, now)
            return

    def _arrive(self, sim, p, now: int) -> None:
        t = p.trip
        p.trip = None
        self._driven.pop(p.i, None)
        self.out.pop(p.i, None)
        p.activity = t.then
        p.state = "busy"
        self._enter(p, t.dest)
        job = p.job
        if t.then in ("work", "school") and job is not None:
            late = now - (now // DAY * DAY + self._start_minute(p))
            if late > LATE_GRACE:
                self.counters["late"] += 1
                p.reputation = max(0.0, p.reputation - 1)
                p.remember(self.sim.clock.stamp(), f"Got in {late} minutes late to {self._name(t.dest)}.")
        self._begin(p, now, t.then, t.until - now)  # shut on arrival: home again

    def _name(self, place_id) -> str:
        place = self.town.places.get(place_id)
        return place.name if place else str(place_id)

    # --- choices ---------------------------------------------------------------------------------------------

    def _favs(self, p, key: str) -> list[str]:
        """The person's favourites of a LEISURE key: generation's p.fav when it has them, else the nearest
        FAV_KEEP from home within FAV_WALK on foot (FAV_CAR by car with a car), allowed places only."""
        got = p.fav.get(key) if isinstance(p.fav, dict) else None
        if got:
            return [pid for pid in got if self.allowed(pid)]
        home = self.home_place(p)
        if home is None:
            return []
        car = self._has_car(p)
        ck = (home, key, car)
        got = self._fav_cache.get(ck)
        if got is not None:
            return got
        kind, styles = LEISURE[key]
        net = folk_transit.net(self.town)
        cands = []
        for pid, place in self.town.places.items():
            if place.kind != kind or (styles is not None and place.style not in styles) or not self.allowed(pid):
                continue
            w = net.minutes(home, pid, "walk")
            if w <= FAV_WALK or (car and net.minutes(home, pid, "car") <= FAV_CAR):
                cands.append((w, pid))
        cands.sort()
        got = self._fav_cache[ck] = [pid for _, pid in cands[:FAV_KEEP]]
        return got

    def _usable(self, place_id, now: int, minutes: int) -> bool:
        place = self.town.places.get(place_id)
        if place is None:
            return False
        if place.hours:
            m = now % DAY + 15  # about when they get there
            if not (place.hours[0] * 60 <= m and m + min(minutes, 30) <= place.hours[1] * 60):
                return False
        cap = getattr(place, "capacity", 0) or 0
        k = self.pidx.get(place_id)
        if cap and k is not None and self.count[k] >= cap:
            return False
        return True

    def _grocer_in_reach(self, p) -> bool:
        """A market, or a grocer's (a shop of style "shop"), among the person's favourites: within FAV_WALK on
        foot, or FAV_CAR by car with a car (opening hours aside)."""
        if self._favs(p, "groceries"):
            return True
        for pid in self._favs(p, "shopping"):
            if self.town.places[pid].style == "shop":
                return True
        return False

    def _grocery_option(self, p, now: int, home, base: float) -> Option:
        """Buy groceries at the first open grocer in reach; with none in reach, order them in from home (the
        isolated and the old in the far suburbs would starve otherwise)."""
        if self._grocer_in_reach(p):
            return Option("Buy groceries", "buy_groceries", self._pick(p, "groceries", now, 25), 25, GROCERY_COST,
                          {"thrift": 0.2, "family": 0.3}, {}, base)
        return Option("Order groceries in", "order_groceries", home, DELIVERY_MINUTES, GROCERY_COST + DELIVERY_FEE,
                      {"thrift": 0.2, "family": 0.3}, {}, base)

    def _pick(self, p, key: str, now: int, minutes: int) -> str | None:
        for pid in self._favs(p, key):
            if self._usable(pid, now, minutes):
                return pid
        if key == "groceries":
            for pid in self._favs(p, "shopping"):
                if self.town.places[pid].style == "shop" and self._usable(pid, now, minutes):
                    return pid
        return None

    def options(self, sim, p, now: int, kind: str) -> list[Option]:
        """The 4 options of a choice (folk.md 5's table)."""
        home = self.home_place(p)
        m = now % DAY
        bed = self._bed_minute(p)
        hh = self.hh_of(p)
        low = hh is not None and hh.groceries < 4
        hungry = p._needs["hunger"] < 55
        thrift = p.traits.get("thrift", 0.5)
        dinner = 17 * 60 <= m < 21 * 60 and hh is not None and hh.groceries > 0
        home_act = "dinner_home" if dinner and p._needs["hunger"] < 70 else "relax_home"
        relax_gains = ACT[home_act][0]
        if kind == "after_work":
            cafe_key = "eat_out" if hungry else "coffee"
            opts = [
                Option("Go home and relax", home_act, home, 90, 0, {"family": 0.3}, relax_gains, 0.2),
                self._grocery_option(p, now, home, 1.0 if low else -0.8),
                Option("Eat out" if hungry else "Coffee", "eat_out" if hungry else "coffee",
                       self._pick(p, cafe_key, now, 40), 40 if hungry else 20, MEAL_COST if hungry else COFFEE_COST,
                       {"social": 0.4, "thrift": -0.3}, ACT["eat_out" if hungry else "coffee"][0], 0.0),
                self._park_option(p, now, 60),
            ]
        elif kind == "day_off":
            spend = int(15 + 45 * (1 - thrift))
            # Low on groceries, the shopping trip is for groceries (L2's integrator item 1): the retired and the
            # jobless have no after_work choice, the only other place they are offered.
            shop = (self._grocery_option(p, now, home, 1.0) if low else
                    Option("Go shopping", "shopping", self._pick(p, "shopping", now, 60), 60, spend,
                           {"thrift": -0.5, "adventure": 0.2}, ACT["shopping"][0], 0.05))
            opts = [
                Option("Stay home", home_act, home, 120, 0, {"family": 0.3}, relax_gains, 0.15),
                shop,
                self._hang_option(sim, p, now, 120),
                ((self._day_out_option(p, now, spend) if (p.i + now // DAY) % 2 == 0 else None)
                 or self._park_option(p, now, 90)),
            ]
        else:  # evening
            left = max(30, bed - m) if m < bed else 30
            opts = [
                Option("Relax at home", home_act, home, left, 0, {"family": 0.3}, relax_gains, 0.25),
                Option("Dinner out", "eat_out", self._pick(p, "eat_out", now, 60), 60, DINNER_COST,
                       {"social": 0.3, "thrift": -0.4}, ACT["eat_out"][0], -0.1),
                self._hang_option(sim, p, now, 120),
                Option("Early night", "sleep", home, 0, 0, {"health": 0.4}, {"energy": 30}, 0.0),
            ]
        return opts

    def _park_option(self, p, now: int, minutes: int) -> Option:
        park = self._pick(p, "park", now, minutes)
        if park is not None:
            return Option("Walk in the park", "walk_park", park, minutes, 0, {"health": 0.4, "adventure": 0.2},
                          ACT["walk_park"][0], 0.1)
        return Option("A walk round the block", "stroll", self.home_place(p), 2 * STROLL_MINUTES, 0,
                      {"health": 0.4}, ACT["stroll"][0], 0.05)

    def _day_out_option(self, p, now: int, spend: int) -> Option | None:
        """A day out at the nearest usable mall, cinema, golf club (40+) or library in reach, or None."""
        home = self.home_place(p)
        if home is None:
            return None
        car = self._has_car(p)
        ck = (home, "day_out", car)
        got = self._fav_cache.get(ck)
        if got is None:
            net = folk_transit.net(self.town)
            cands = []
            for pid, place in self.town.places.items():
                if (place.kind, place.style) not in DAY_OUT or not self.allowed(pid):
                    continue
                w = net.minutes(home, pid, "walk")
                if w <= DAY_OUT_WALK or (car and net.minutes(home, pid, "car") <= DAY_OUT_CAR):
                    cands.append((w, pid))
            cands.sort()
            got = self._fav_cache[ck] = [pid for _, pid in cands]
        for pid in got:
            place = self.town.places[pid]
            act, label, cost, age = DAY_OUT[(place.kind, place.style)]
            if p.age >= age and self._usable(pid, now, DAY_OUT_MINUTES):
                return Option(label, act, pid, DAY_OUT_MINUTES, spend if cost is None else cost,
                              {"adventure": 0.4, "thrift": -0.2}, ACT[act][0], 0.1)
        return None

    def _hang_option(self, sim, p, now: int, minutes: int) -> Option:
        cafe = self._pick(p, "coffee", now, minutes) or self._pick(p, "eat_out", now, minutes)
        opt = Option("Hang out with a friend", "hang_out", cafe, minutes, HANG_COST, {"social": 0.6},
                     ACT["hang_out"][0], 0.0)
        return opt

    def score_options(self, sim, p, opts: list[Option], now: int) -> list[float]:
        """Folk's own scorer: forks.default_scores' terms read from the Person (base + 0.6 style + need + afford
        - travel). Style from p.traits, need from p's raw needs, afford from p's money and savings (a child's from
        the richest adult at home), travel from the road minutes there and home again, the way they would go."""
        traits = p.traits
        needs = p._needs
        own = self._purse(p)
        thrift = traits.get("thrift", 0.5)
        m = now % DAY
        rate = TRAVEL_COST * (NIGHT_TRAVEL if m >= NIGHT_FROM * 60 or m < NIGHT_UNTIL * 60 else 1)
        home = self.home_place(p)
        here = self.where.get(p.i) or home
        car = self._has_car(p)
        direct = self._trip_minutes(here, home, car)
        scores = []
        for opt in opts:
            if opt.place is None:
                scores.append(UNAVAILABLE)
                continue
            style = 0.0
            for t, v in opt.tags.items():
                style += (traits.get(t, 0.5) - 0.5) * 2 * v
            need = 0.0
            for n, g in opt.gains.items():
                if n in needs:
                    need += urgency(needs[n]) * g / 25
            afford = 0.0
            if opt.cost > 0:
                afford = -opt.cost / max(own, 50) * thrift if opt.cost <= own else -2.0
            score = opt.base + STYLE * style + need + afford
            if opt.activity == "stroll" or opt.place != home:
                if opt.activity == "stroll":
                    extra = 2 * STROLL_MINUTES
                else:
                    extra = self._trip_minutes(here, opt.place, car) + self._trip_minutes(opt.place, home, car) - direct
                if extra > 0:
                    score -= extra * rate
            scores.append(round(score, 3))
        return scores

    def _trip_minutes(self, a, b, car: bool) -> int:
        if a is None or b is None or a == b:
            return 0
        w = folk_transit.minutes(self.town, a, b, "walk")
        if car and w > folk_transit.WALK_MAX:
            return min(w, folk_transit.minutes(self.town, a, b, "car"))
        return w

    def _purse(self, p) -> float:
        if p.age >= 18:
            return p.money + p.savings
        payer = self._payer(p)
        return payer.money + payer.savings if payer is not None else p.money

    def _payer(self, p):
        if p.age >= 18:
            return p
        hh = self.hh_of(p)
        best = None
        if hh is not None:
            for mid in hh.member_ids:
                q = self.person(mid)
                if q is not None and q.alive and not q.gone and q.age >= 18:
                    if best is None or q.money + q.savings > best.money + best.savings:
                        best = q
        return best

    def choose(self, sim, p, now: int, kind: str) -> None:
        opts = self.options(sim, p, now, kind)
        scores = self.score_options(sim, p, opts, now)
        order = sorted(range(4), key=lambda k: (-scores[k], k))
        if scores[order[0]] - scores[order[1]] >= OBVIOUS_MARGIN:
            pick, by = order[0], "habit"
            self.counters["habit"] += 1
        else:
            rr = _dice().stream(sim.dice_seed, NS_FOLK, p.i, now)  # keyed: made only when the noise decides
            best, pick = None, 0
            for k in range(4):
                s = scores[k] + rr.uniform(0, NOISE)
                if best is None or s > best:
                    best, pick = s, k
            by = "default"
        self.counters["choices"] += 1
        opt = opts[pick]
        m = now % DAY
        p.choose({"time": f"{m // 60:02d}:{m % 60:02d}", "kind": kind, "options": [o.label for o in opts],
                  "choice": pick, "by": by})
        self._play(sim, p, now, opt)

    def _play(self, sim, p, now: int, opt: Option) -> None:
        if opt.place is None:
            opt = Option("Go home and relax", "relax_home", self.home_place(p), 60)
        if opt.cost > 0:
            payer = self._payer(p) or p
            payer.money -= opt.cost
        if opt.activity in ("buy_groceries", "order_groceries"):
            hh = self.hh_of(p)
            if hh is not None:
                hh.groceries += GROCERY_MEALS
        if opt.activity not in HOME_ACTS:
            self._outcomes(sim, p, now, opt.activity)
        if opt.activity == "sleep":
            self._go_home(sim, p, now, "sleep", self._wake_tick(p, now))
            return
        if opt.activity == "stroll":
            self._stroll(sim, p, now)
            return
        if opt.activity == "hang_out":
            self._companion(sim, p, opt.place, opt.minutes)
        here = self.where.get(p.i)
        if here == opt.place:
            self._begin(p, now, opt.activity, opt.minutes)
        else:
            self._go(sim, p, now, opt.place, opt.activity, stay=opt.minutes)

    def _outcomes(self, sim, p, now: int, activity: str) -> None:
        """Bargain, pickpocket, rained out: luck-shifted keyed rolls (`dice.odds`), every roll in the luck log."""
        rr = _dice().stream(sim.dice_seed, NS_FOLK, p.i, now, "luck")
        rolls = [PICKPOCKET]
        if activity in ("shopping", "buy_groceries"):
            rolls.insert(0, BARGAIN)
        if activity in ("walk_park", "stroll") and getattr(sim, "weather", None) == "rain":
            rolls.append(RAINED_OUT)
        for what, valence, chance, money, fun in rolls:
            prob = _dice().odds(chance, valence, p.luck)
            roll = rr.random()
            _people().log_roll(sim, p, what, prob, roll)
            if roll < prob:
                if money:
                    (self._payer(p) or p).money += money  # the household's purse, as the outing's cost was
                if fun:
                    p.adjust("fun", fun)

    def _companion(self, sim, p, place_id, minutes) -> None:
        try:
            from . import social
        except ImportError:
            return
        pick = getattr(social, "pick_companion", None)
        if pick is None:
            return
        c = pick(sim, p, "visit")
        if isinstance(c, str):
            c = self.person(c)
        if c is not None and isinstance(c, Person) and c is not p:
            send_to(sim, c, place_id, "hang_out", minutes)

    def _stroll(self, sim, p, now: int) -> None:
        """A walk round the block when no park is in reach: out STROLL_MINUTES toward a nearby place and back."""
        home = self.home_place(p)
        if home is None:
            self._begin(p, now, "relax_home", 30)
            return
        turn = None
        for pid in self._favs(p, "shopping") + self._favs(p, "coffee"):
            if pid != home:
                turn = pid
                break
        if turn is None:
            self._begin(p, now, "relax_home", 30)
            return
        out = folk_transit.road_leg(self.town, WALK, home, turn, now)
        back = folk_transit.road_leg(self.town, WALK, turn, home, out[2])
        self._leave(p)
        p.trip = Trip([out, back], home, "relax_home", back[2] + 30, "walk")
        p.state = "travelling"
        p.activity = "relax_home"
        p.activity_place = home
        self.out[p.i] = None
        self.counters["trips"] += 1
        self.stay[p.i] = (now, back[2])
        self.schedule(p, back[2])

    # --- frames ----------------------------------------------------------------------------------------------

    def _locate(self, p, tick: int):
        park = self.strollers.get(p.i)
        if park is None:
            return None
        tiles = self._park_tiles.get(park)
        if tiles is None:
            place = self.town.places[park]
            tiles = self._park_tiles[park] = [(x, y) for y in range(place.y, place.y + place.h)
                                              for x in range(place.x, place.x + place.w)] or [place.entry]
        return tiles[_dice().key(self.sim.dice_seed, NS_STROLL, p.i, tick // STROLL_EVERY) % len(tiles)]

    def xy(self, p, tick: int) -> tuple[int, int]:
        """The person's tile at tick: on a trip leg (a train's tile while aboard), strolling, else the entry of the
        place they are at (or home)."""
        trip = p.trip
        if trip is not None:
            leg = folk_transit.leg_at(trip.legs, tick)
            if leg is not None:
                kind, t0, t1, data = leg
                if kind == WALK or kind == DRIVE:
                    x, y, _ = data.at(max(0, tick - t0))
                    return x, y
                if kind == WAIT:
                    return folk_transit.station_xy(self.town, data)
                return folk_transit.train_xy(self.town, data, tick)
        if p.i in self.strollers:
            return self._locate(p, tick)
        place = self.town.places.get(self.where.get(p.i) or self.home_place(p) or "")
        if place is None:
            return 0, 0
        return place.entry[0], place.entry[1]

    def _leg_xy(self, p, tick: int):
        """(x, y, mode) of a traveller at tick, or None while aboard a train or a passenger."""
        trip = p.trip
        leg = folk_transit.leg_at(trip.legs, tick)
        if leg is None:
            place = self.town.places.get(trip.dest)
            return (place.entry[0], place.entry[1], K_WALK) if place else None
        kind, t0, t1, data = leg
        if kind == WALK or kind == DRIVE:
            x, y, _ = data.at(max(0, tick - t0))
            if kind == WALK:
                return x, y, K_WALK
            if trip.mode == "ambulance":
                return x, y, K_AMBULANCE
            if p.age < 18 and self._passenger(p, leg):
                return None  # a passenger: the school run's car is an older sibling's
            return x, y, K_CAR
        if kind == WAIT:
            x, y = folk_transit.station_xy(self.town, data)
            return x, y, K_WAIT
        return None  # RIDE: aboard

    def _passenger(self, p, leg) -> bool:
        """A child in a car rides in a parent's school run, or is drawn as the car itself unless a sibling it shares
        the car with is the passenger of a school run or has a lower index."""
        t0 = p.trip.legs[0][1]
        run = self._driven.get(p.i)
        if run is not None and run[1] == t0:
            return True
        hh = self.hh_of(p)
        if hh is None:
            return False
        for mid in hh.member_ids:
            q = self.people[int(mid[1:])]
            if q is p:
                continue
            if q.trip is not None and q.trip.dest == p.trip.dest and q.age < 18 and q.trip.mode == p.trip.mode:
                if q.trip.legs and q.trip.legs[0][1] == t0 and q.trip.legs[0][0] == leg[0]:
                    qr = self._driven.get(q.i)
                    if q.i < p.i or (qr is not None and qr[1] == t0):
                        return True
        return False

    def crowd(self, sim) -> list[int]:
        """[i, x, y, k, ...] for folk outdoors and not aboard, sorted by i; k = mode | child << 3."""
        self._bind()
        tick = sim.clock.tick
        out = []
        people = self.people
        for i in sorted(list(self.out) + list(self.strollers)):
            p = people[i]
            if p.trip is not None:
                got = self._leg_xy(p, tick)
                if got is None:
                    continue
                x, y, k = got
            else:
                x, y = self._locate(p, tick)
                k = K_OUTDOORS
            out += (i, x, y, k | (8 if p.age < 18 else 0))
        return out

    def counts(self, sim) -> dict:
        """The crowd invariant's terms: crowd + inside + aboard + passengers == present (living, in town)."""
        self._bind()
        tick = sim.clock.tick
        aboard = passengers = 0
        for i in self.out:
            p = self.people[i]
            if self._leg_xy(p, tick) is None:
                leg = folk_transit.leg_at(p.trip.legs, tick)
                if leg is not None and leg[0] == RIDE:
                    aboard += 1
                else:
                    passengers += 1
        inside = 0
        for c in self.count:
            inside += c
        present = 0
        for p in self.people:
            if p.alive and not p.gone:
                present += 1
        return {"crowd": len(self.crowd(sim)) // 4, "inside": inside, "aboard": aboard, "passengers": passengers,
                "present": present}

    def occ(self) -> list[int]:
        """Folk inside + named inside per place, in town.places order."""
        out = list(self.count)
        pidx = self.pidx
        for a in self.sim.agents.values():
            if a.alive and a.inside is not None:
                k = pidx.get(a.inside)
                if k is not None:
                    out[k] += 1
        return out

    def present(self, place_id) -> list[int]:
        """Sorted indices of the folk inside a place or strolling in it."""
        occ = self.occupants.get(place_id)
        return sorted(occ) if occ else []

    def riders(self, tick) -> dict[str, int]:
        out: dict[str, int] = {}
        for i in self.out:
            p = self.people[i]
            for kind, t0, t1, data in p.trip.legs:
                if kind == RIDE and t0 <= tick < t1:
                    out[data] = out.get(data, 0) + 1
                    break
        return out

    def commute_minutes(self, p, place_id) -> int | None:
        """Best allowed commute from p's home to a place (walk, car if owned, train with the worst wait); None
        when out of reach or not allowed (isolated folk and Millbrook)."""
        if not self.allowed(place_id):
            return None
        home = self.home_place(p)
        if home is None or place_id not in self.town.places:
            return None
        got = folk_transit.best_minutes(self.town, home, place_id, self._has_car(p))
        return None if got is None else got[0]

    # --- stats and pages -------------------------------------------------------------------------------------

    def worth(self, sim, p) -> int:
        """Cash + savings + the adult's share of a home the household owns."""
        w = p.money + p.savings
        hh = self.hh_of(p)
        if p.age >= 18 and hh is not None:
            homes = getattr(sim, "homes", {})
            home = homes.get(hh.home_id)
            if home is not None and home.owner == hh.id:
                adults = 0
                for mid in hh.member_ids:
                    q = self.person(mid)
                    if q is not None and q.alive and not q.gone and q.age >= 18:
                        adults += 1
                lots = getattr(sim, "lots", None)
                if lots is not None and home.place in lots:
                    from . import housing
                    value = housing.value(sim, hh.home_id)
                else:  # a home without a lot (a test world): its base value
                    value = home.base_value
                w += value / max(1, adults)
        return int(w // 1)

    def sample_hour(self, sim) -> None:
        self._bind()
        for p in self.people:
            if p.alive and not p.gone:
                r = self.rings.get(p.i)
                if r is None:
                    r = self.rings[p.i] = deque(maxlen=24)
                r.append(self.worth(sim, p))

    def stats_json(self, sim) -> dict:
        self._bind()
        n = len(self.people)
        worth, w24, mood, health, luck = [None] * n, [None] * n, [None] * n, [None] * n, [None] * n
        for p in self.people:
            if not p.alive or p.gone:
                continue
            i = p.i
            worth[i] = self.worth(sim, p)
            r = self.rings.get(i)
            w24[i] = r[0] if r else None
            mood[i] = int(p.mood + 0.5)
            health[i] = int(p.health + 0.5)
            luck[i] = int(p.luck + 0.5)
        return {"v": self.v, "worth": worth, "worth_24h": w24, "mood": mood, "health": health, "luck": luck}

    def city_parts(self, sim) -> dict:
        """Everyone's share of the city block: counts, money and moods by district (stats sums them in)."""
        self._bind()
        out = {"population": 0, "adults": 0, "children": 0, "employed": 0, "pupils": 0, "money": 0, "mood": 0,
               "health": 0, "outdoors": len(self.out) + len(self.strollers), "districts": {}}
        for p in self.people:
            if not p.alive or p.gone:
                continue
            out["population"] += 1
            if p.age >= 18:
                out["adults"] += 1
                if p.job is not None:
                    out["employed"] += 1
            else:
                out["children"] += 1
                if p.job is not None:
                    out["pupils"] += 1
            out["money"] += int(p.money + p.savings)
            out["mood"] += int(p.mood + 0.5)
            out["health"] += int(p.health + 0.5)
            home = self.home_place(p)
            place = self.town.places.get(home) if home else None
            d = place.district if place else ""
            row = out["districts"].get(d)
            if row is None:
                row = out["districts"][d] = {"population": 0, "money": 0, "mood": 0}
            row["population"] += 1
            row["money"] += int(p.money + p.savings)
            row["mood"] += int(p.mood + 0.5)
        return out

    def roster_rows(self, sim) -> list[dict]:
        rows = []
        for p in self.people:
            home = self.home_place(p)
            place = self.town.places.get(home) if home else None
            job = p.job
            rows.append({"i": p.i, "id": p.id, "name": p.name, "age": p.age, "child": p.age < 18,
                         "hh": p.household_id, "home": self._hh_home(p), "place": self.where.get(p.i),
                         "district": place.district if place else None,
                         "job": job.title if job is not None else None,
                         "work": job.place_id if job is not None else None, "alive": p.alive and not p.gone})
        return rows

    def _hh_home(self, p):
        hh = self.hh_of(p)
        return hh.home_id if hh is not None else None

    def page_json(self, sim, fid) -> dict | None:
        """The light townsperson page (view.md 4.3) plus folk.md 8's keys, `choices` and `life`."""
        self._bind()
        p = self.person(fid)
        if p is None:
            return None
        people = _people()
        hh = self.hh_of(p)
        home_id = hh.home_id if hh is not None else None
        home = getattr(sim, "homes", {}).get(home_id) if home_id else None
        x, y = self.xy(p, sim.clock.tick)
        rels = {}
        for oid, r in sorted(p.relationships.items(), key=lambda kv: (-kv[1].affinity, kv[0])):
            rels[oid] = people.rel_row(sim, oid, r)
        members = []
        if hh is not None:
            for mid in hh.member_ids:
                q = self.person(mid)
                if q is not None and q.alive and not q.gone:
                    members.append(q.name)
        try:
            life_block = _life().page(sim, p)
        except (ImportError, AttributeError):
            life_block = None
        trip = p.trip
        return {
            "kind": "folk", "luck_settable": p.alive and not p.gone, "id": p.id, "name": p.name, "age": p.age,
            "sex": p.sex, "alive": p.alive, "gone": p.gone, "state": p.state, "activity": p.activity,
            "place": p.activity_place, "inside": p.inside, "x": x, "y": y, "luck": round(p.luck, 1),
            "money": round(p.money, 2), "savings": round(p.savings, 2), "worth": self.worth(sim, p),
            "health": round(p.health, 1), "mood": round(p.mood), "reputation": round(p.reputation),
            "needs": {k: round(v, 1) for k, v in p.needs.items()},
            "job": p.job.to_json() if p.job is not None else None,
            "commute": list(p.commute) if p.commute else None,
            "home": {"id": home_id, "name": home.name if home else None,
                     "place": home.place if home else None} if home_id else None,
            "household_id": p.household_id, "household": members,
            "vehicle": trip.mode if trip is not None else ("car" if p.owns_car else "walk"),
            "relationships": rels, "memory": list(p.memory), "choices": list(p.choices),
            "traits": dict(p.traits), "life": life_block,
        }

    def set_luck(self, fid, luck) -> bool:
        p = self.person(fid)
        if p is None or not p.alive or p.gone:
            return False
        p.luck = max(0.0, min(100.0, float(luck)))
        return True

    def perf(self) -> dict:
        """Folk's own CPU per tick (process_time): mean and p99 over the last CPU_KEEP ticks, in ms."""
        xs = sorted(self.cpu)
        if not xs:
            return {"mean_ms": 0.0, "p99_ms": 0.0, "ticks": 0}
        total = 0.0
        for v in xs:
            total += v
        return {"mean_ms": total / len(xs) * 1000, "p99_ms": xs[min(len(xs) - 1, int(len(xs) * 0.99))] * 1000,
                "ticks": len(xs), "total_mean_ms": self.cpu_total / max(1, self.ticks) * 1000}


def _folk_life_or_none():
    try:
        return _lazy("folk_life")
    except ImportError:
        return None


def _folk_of(sim) -> Folk | None:
    f = getattr(sim, "folk", None)
    return f if isinstance(f, Folk) else None


# --- life.md 3.2: the folk functions life calls ------------------------------------------------------------------

def is_free(sim, p) -> bool:
    """Alive, in town, awake, not at or heading to work or school, not in hospital, in free time (and not due at
    a shift within the hour), and not on an errand someone sent them on (`send_to`: an invite, a date, a friend's
    outing) until its stay ends, so nobody pulls them off it."""
    f = _folk_of(sim)
    if f is None or not isinstance(p, Person) or not p.alive or p.gone or p.age < 5:
        return False
    act = p.activity
    if act not in FREE or p.i in f.sent:
        return False
    job = p.job
    if job is not None:
        now = sim.clock.tick
        day, m = divmod(now, DAY)
        if day % 7 in job.workdays and p.worked_day != day:
            leave = f._set_off(p)
            if leave - 60 <= m < f._end_minute(p):
                return False
    return True


def send_to(sim, p, place_id, activity, minutes) -> bool:
    """If free (or for the ward: always), interrupt what p is doing, travel there and stay `minutes`. The ward goes
    by ambulance (one DRIVE leg)."""
    f = _folk_of(sim)
    if f is None or not isinstance(p, Person) or not p.alive or p.gone:
        return False
    if place_id not in f.town.places:
        return False
    ward = activity == WARD
    if not ward and (not is_free(sim, p) or not f.allowed(place_id)):
        return False
    now = sim.clock.tick
    if p.trip is not None:
        _cut_trip(f, p, now)
    else:
        f._gain(p, now)
    f.settle(p, now)
    f.ends.pop(p.i, None)
    if ward:
        f.sent.pop(p.i, None)
    else:
        f.sent[p.i] = None
    if f.where.get(p.i) == place_id:
        f._begin(p, now, activity, minutes)
        return True
    if ward:
        src = f.where.get(p.i) or f.home_place(p)
        f._leave(p)
        legs = [folk_transit.road_leg(f.town, DRIVE, src, place_id, now)] if src and src != place_id else []
        arrive = folk_transit.end_of(legs, now)
        p.trip = Trip(legs, place_id, WARD, arrive + max(1, int(minutes)), "ambulance")
        p.state = "travelling"
        p.activity = WARD
        p.activity_place = place_id
        f.out[p.i] = None
        f.stay[p.i] = (now, arrive)
        f.schedule(p, arrive)
        return True
    f._go(sim, p, now, place_id, activity, stay=max(1, int(minutes)))
    return True


def _cut_trip(f: Folk, p, now: int) -> None:
    """Stop a trip where it is: the person is put at the trip's start or end place, whichever leg they are on is
    nearer its end (positions stay pure functions: the new trip starts from a place)."""
    t = p.trip
    p.trip = None
    f.out.pop(p.i, None)
    start = t.legs[0][1] if t.legs else now
    end = t.legs[-1][2] if t.legs else now
    rides = [leg for leg in t.legs if leg[0] == RIDE]
    if rides and now < rides[0][1]:
        # cut before the first train leaves: the fare paid at departure comes back and the boardings never were
        p.money += folk_transit.fare(p.age)
        f.counters["boardings"] -= len(rides)
        f.counters["train_trips"] -= 1
        if start // DAY == now // DAY:  # counted in today's figures (a trip set off before midnight is not)
            f.today["boardings"] -= len(rides)
            f.today["train_trips"] -= 1
            per = f.today["lines"]
            for leg in rides:
                line = f._line_of(leg[3])
                left = per.get(line, 0) - 1
                if left > 0:
                    per[line] = left
                else:
                    per.pop(line, None)
    place = t.dest if now - start >= end - now else None
    if place is None:
        place = f.home_place(p) if t.dest != f.home_place(p) else t.dest
    p.state = "busy"
    p.activity = "idle"
    f._enter(p, place)


def hospitalise(sim, p, days) -> bool:
    """To the nearest hospital by ambulance for `days` (life's ward); home afterwards."""
    f = _folk_of(sim)
    if f is None:
        return False
    src = f.where.get(p.i) or f.home_place(p)
    best = None
    for pid, place in f.town.places.items():
        if place.kind == "hospital" and f.allowed(pid):
            m = folk_transit.minutes(f.town, src, pid, "car") if src else 0
            if best is None or (m, pid) < best:
                best = (m, pid)
    if best is None:
        return False
    return send_to(sim, p, best[1], WARD, max(1, int(days * DAY)))


def kill(sim, p, how) -> None:
    """Folk bookkeeping only (life's die and folk_life's release call it): off the wheel, out of the place and
    off any trip. It never changes `alive`."""
    f = _folk_of(sim)
    if f is None:
        return
    if p.trip is not None:
        p.trip = None
    f.out.pop(p.i, None)
    f._leave(p)
    f.ends.pop(p.i, None)
    f.sent.pop(p.i, None)
    p.next_tick = -1
    p.state = "idle"
    p.activity = "idle"
    f.v += 1


def on_job_change(sim, p) -> None:
    """A new job, none, or a school: refresh the commute (the next step plans the day from it)."""
    f = _folk_of(sim)
    if f is None:
        return
    p.commute = None
    if p.job is not None:
        f._commute_of(p)
    f.v += 1


def add_person(sim, spec: dict):
    """A new townsperson in an existing household: {"household", "age", "sex", "first"?, "surname"?, "traits"?,
    "name"?}; life.init_person, then on the wheel at home."""
    f = _folk_of(sim)
    if f is None:
        return None
    hh = spec["household"]
    if isinstance(hh, str):
        hh = f.household(hh)
    i = len(f.people)
    name = spec.get("name") or f"{spec.get('first', 'Baby')} {spec.get('surname', '')}".strip()
    p = Person(i, name, int(spec.get("age", 0)), spec.get("sex", "f"), hh.j if hh.j >= 0 else f.households.index(hh))
    p.household_id = hh.id
    p.traits = dict(spec.get("traits") or {t: 0.5 for t in ("thrift", "family", "social", "diligence", "health",
                                                             "adventure")})
    p._nt = sim.clock.tick
    p.activity = "baby" if p.age < 5 else "relax_home"
    f.people.append(p)
    f.n = len(f.people)  # state.folk_n, stats.folk and the roster all have this length (PLAN 2.10)
    hh.member_ids.append(p.id)
    home = f.home_place(p)
    if home is not None:
        f._enter(p, home)
    f.stay[p.i] = (sim.clock.tick, sim.clock.tick + 1)
    f.schedule(p, sim.clock.tick + 1)
    f.v += 1
    life = _life()
    init = getattr(life, "init_person", None)
    if init is not None:
        init(sim, p)
    return p


def add_baby(sim, mother, father=None):
    """A baby in the mother's household: age 0, a unique first name (folk_gen.baby_name), traits the parents'
    mean +- .1 on stream BIRTH, then life.init_person."""
    f = _folk_of(sim)
    if f is None:
        return None
    dice = _dice()
    rr = dice.stream(sim.dice_seed, dice.BIRTH, mother.id, sim.clock.tick)
    sex = "f" if rr.random() < 0.5 else "m"
    surname = mother.name.split(" ")[-1]
    from . import folk_gen
    first = folk_gen.baby_name(sim, sex, surname, len(f.people))
    traits = {}
    mt = getattr(mother, "traits", None) or {}
    ft = (getattr(father, "traits", None) or mt) if father is not None else mt
    for t in ("thrift", "family", "social", "diligence", "health", "adventure"):
        mean = (mt.get(t, 0.5) + ft.get(t, 0.5)) / 2
        traits[t] = round(max(0.0, min(1.0, mean + rr.uniform(-0.1, 0.1))), 3)
    hh = f.household(mother.household_id)
    name = first if " " in first else f"{first} {surname}"
    return add_person(sim, {"household": hh, "age": 0, "sex": sex, "name": name, "traits": traits})


def join(sim, p, host):
    return _folk_life().join(sim, p, host)


def split(sim, p):
    return _folk_life().split(sim, p)


def release(sim, p):
    return _folk_life().release(sim, p)


def on_birthday(sim, p):
    fn = getattr(_folk_life_or_none(), "on_birthday", None)
    if fn is not None:
        return fn(sim, p)
    return None


def settle(sim, p) -> None:
    """Lazy needs to now (people.settle's folk branch)."""
    f = _folk_of(sim)
    if f is not None and isinstance(p, Person):
        f.settle(p, sim.clock.tick)

"""Townsfolk generation (folk.md 4 with region.md 7's five demand rules, PLAN 2.6 and 2.15).

`populate(folk, sim, n)` fills `folk.people` (index i, id "f<i>") and `folk.households` (index j, id "fh<j>"):
households from a deck, names, traits, needs, health and means, region homes by means, cars, schools, seekers,
Millbrook's job rows, region rows nearest-first, money, ties and the start. Every job slot of `town.job_slots` goes
on the career board (`career.board(sim).add(job, holder | None)`); the worker's `job.slot` is that slot.

Streams on `sim.seed` (dice keys): `(NS_GEN, "deck")` the household deck; `(NS_GEN, "hh", j)` household j's ages,
names, traits, needs, health, means, then cars, seeking, money and wake-up, in that order; `(NS_GEN, "match")` the
job matching jitter and then the ties; `(NS_GEN, "new", k)` newcomer k; `(NS_GEN, "baby", k)` baby names. Folk
generation never draws `sim.rng`. `life.init` runs after it (no birthdays here).

Commutes are door-to-door worst cases: walk and drive minutes from `roads.net(town)` (plus `region.car_extra` for
parking), trains from `rail.worst_minutes` (None skips the train). `python3 -m gameofailife.folk_gen --dump 1`
writes tests/fixtures/folk_seed1.json.
"""

from __future__ import annotations

import json
import math
import sys

from . import agent, cast, folk_names, housing
from .agent import NEEDS, Job, Profile, RelationKind
from .clock import Clock
from .folk_model import NS_GEN, FolkHousehold, Person, household_id
from .rng import Rng, r2

# --- households (folk.md 4.1) ----------------------------------------------------------------------------------
KINDS = [("single_young", 9), ("single_mid", 7), ("single_old", 8), ("couple_young", 8), ("couple_mid", 12),
         ("couple_old", 12), ("family", 25), ("single_parent", 7), ("sharers", 4), ("three_gen", 3),
         ("grown_kids", 5)]
DECK_SCALE = 4.21  # cards of a kind = round(weight * 4.21): one deck is about 1,000 people
OPPOSITE_SEX = 0.9
SHARED_SURNAME = 0.75  # a partner who took the household's surname
# --- region.md 7's demand rules (PLAN 2.6) ---------------------------------------------------------------------
CAR_P = {"flat": 0.2, "house": 0.55, "big_house": 0.9}
CAR_NEAR_STATION, STATION_NEAR = 0.6, 15  # car odds x .6 for a home within 15 walking minutes of a station
WALK_CAP, CAR_CAP, TRAIN_CAP = 40, 35, 50
TRAIN_SAVES, CAR_TRAIN_PREF, WALK_ONLY = 5, 8, 12  # minutes
RES_BASE, RES_SKILL = 15, 25  # reservation wage, region rows only
SKILL_W, JITTER = 25, 6
# --- Millbrook rows and schools ----------------------------------------------------------------------------------
MB_WALK, MB_CAR = 25, 30
MB_PUPILS = 40
SCHOOL_WALK = 25
TEEN_AGE, TEEN_TRAIN_CAP, HIGH_SCHOOL = 11, 45, "high_school"
SCHOOL_SEATS = 300
MILLBROOK_SCHOOL = "school"
# --- seekers and money (folk.md 4.6, 4.9) -----------------------------------------------------------------------
STUDY_P, IDLE_P = 0.3, 0.07
PENSION = 400
NO_SAVINGS_P = 0.25
SAVINGS_CAP = 20000
SAVINGS_WEEKS = {"low": (0, 4), "mid": (2, 10), "high": (10, 30), "retired": (3, 15)}
LOW_PAY, HIGH_PAY = 600, 1100
# --- ties (folk.md 4.11) -----------------------------------------------------------------------------------------
COWORKERS, CLASSMATES, NEIGHBOURS = 3, 3, 2
NAMED_COWORKERS, NAMED_CLASSMATES = 3, 2
FRIEND_AGE_GAP = 8


# --- dice ------------------------------------------------------------------------------------------------------

def stream(seed: int, *parts) -> Rng:
    """dice.stream (L1), imported lazily."""
    try:
        from . import dice
    except ImportError:  # before L1's dice.py: life.md 4.1's key, verbatim
        return Rng(_key(seed, *parts))
    return dice.stream(seed, *parts)


_MASK = 0xFFFFFFFF


def _sid(x) -> int:
    if isinstance(x, int):
        return x & _MASK
    h = 0x811C9DC5
    for ch in x:
        h = ((h ^ ord(ch)) * 0x01000193) & _MASK
    return h


def _fmix(h: int) -> int:
    h ^= h >> 16
    h = (h * 0x85EBCA6B) & _MASK
    h ^= h >> 13
    h = (h * 0xC2B2AE35) & _MASK
    return h ^ (h >> 16)


def _key(seed: int, *parts) -> int:
    h = (seed * 0x9E3779B1) & _MASK
    for p in parts:
        h = _fmix(((h ^ _sid(p)) * 0x01000193) & _MASK)
    return h


def _round(x: float) -> int:
    return math.floor(x + 0.5)


def _income_tax(wage: float) -> float:
    return min(0.45, 0.15 + 0.004 * wage)  # sim.income_tax


def shift_hours(job) -> int:
    """Hours of one shift; a night shift (end <= start) runs past midnight."""
    h = job.end_hour - job.start_hour
    return h if h > 0 else h + 24


def weekly_pay(job) -> float:
    """Take-home pay for a full week of shifts."""
    if job is None or job.hourly_wage <= 0:
        return 0.0
    return job.hourly_wage * shift_hours(job) * len(job.workdays) * (1 - _income_tax(job.hourly_wage))


# --- geography ---------------------------------------------------------------------------------------------------

class Geo:
    """Door-to-door worst-case minutes for generation (region.md 7), cached by (from, to, car)."""

    def __init__(self, sim):
        from . import roads  # lazy: R2's module
        self.town = sim.town
        self.net = roads.net(sim.town)
        try:
            from . import rail
            self.worst = getattr(rail, "worst_minutes", None)
        except ImportError:
            self.worst = None
        try:
            from . import region
            self.extra = getattr(region, "car_extra", None)
        except ImportError:
            self.extra = None
        self.stations = [pid for pid, pl in self.town.places.items() if pl.kind == "station"]
        self._train = {}
        self._commute = {}
        self._extra = {}

    def walk(self, a: str, b: str) -> int:
        return self.net.minutes(a, b, "walk")

    def car(self, a: str, b: str) -> int:
        """Drive plus the parking minutes at b's district."""
        e = self._extra.get(b)
        if e is None:
            e = self._extra[b] = self.extra(self.town, b) if self.extra is not None else 0
        return self.net.minutes(a, b, "car") + e

    def train(self, a: str, b: str, car: bool):
        if self.worst is None:
            return None
        key = (a, b, car)
        if key in self._train:
            return self._train[key]
        got = self.worst(self.town, self.net, a, b, car)
        self._train[key] = got
        return got

    def station_walk(self, a: str) -> int:
        best = 1 << 30
        for s in self.stations:
            m = self.walk(a, s)
            if m < best:
                best = m
        return best

    def commute(self, a: str, b: str, car: bool):
        """The best allowed way for job matching: (minutes, mode) or None when out of reach."""
        key = (a, b, car)
        if key in self._commute:
            return self._commute[key]
        walk = self.walk(a, b)
        best = None
        if walk <= WALK_CAP:
            best = (walk, "walk")
        drive = None
        if car:
            drive = self.car(a, b)
            if drive <= CAR_CAP and (best is None or _lt((drive, "car"), best)):
                best = (drive, "car")
        if walk > WALK_ONLY:
            tr = self.train(a, b, car)
            if (tr is not None and tr <= TRAIN_CAP and tr <= walk - TRAIN_SAVES
                    and (drive is None or tr <= drive + CAR_TRAIN_PREF)):
                if best is None or _lt((tr, "train"), best):
                    best = (tr, "train")
        self._commute[key] = best
        return best

    def mode(self, a: str, b: str, car: bool) -> tuple[int, str]:
        """How they actually go (folk.md 5): walk if <= 12; a car owner takes the train within 8 minutes of the car,
        else drives; others take the train when it saves 5 on a walk over 20; else walk."""
        walk = self.walk(a, b)
        if walk <= WALK_ONLY:
            return walk, "walk"
        tr = self.train(a, b, car)
        if car:
            drive = self.car(a, b)
            if tr is not None and tr <= drive + CAR_TRAIN_PREF and tr <= walk - TRAIN_SAVES:
                return tr, "train"
            return drive, "car"
        if tr is not None and walk > 20 and tr <= walk - TRAIN_SAVES:
            return tr, "train"
        return walk, "walk"


def _lt(a: tuple, b: tuple) -> bool:
    return a[0] < b[0] or (a[0] == b[0] and a[1] < b[1])


# --- the job board -----------------------------------------------------------------------------------------------

class ListBoard:
    """The career board's add/free/take as plain lists, for GenSim and test stubs (career.JobBoard in a sim)."""

    def __init__(self):
        self.jobs = []
        self.holder = []
        self.reopen = {}

    def add(self, job, holder=None) -> int:
        self.jobs.append(job)
        self.holder.append(holder)
        return len(self.jobs) - 1

    def take(self, slot: int, pid: str) -> None:
        self.holder[slot] = pid

    def free(self, slot: int, reopen_day=None) -> None:
        self.holder[slot] = None


def board(sim):
    """The career board: `sim.job_board` when a stub holds one, else `career.board(sim)` (L2)."""
    b = getattr(sim, "job_board", None)
    if b is not None:
        return b
    from . import career
    return career.board(sim)


def set_rel(sim, a_id: str, b_id: str, kind, affinity: float, affinity_b=None, **fields) -> None:
    """people.set_rel (L1): both sides, creates or overwrites; a plain Relationship write until it lands."""
    from . import people
    fn = getattr(people, "set_rel", None)
    if fn is not None:
        fn(sim, a_id, b_id, kind, affinity, affinity_b, **fields)
        return
    for x, y, aff in ((a_id, b_id, affinity), (b_id, a_id, affinity if affinity_b is None else affinity_b)):
        p = _person(sim, x)
        r = agent.Relationship(kind, aff)
        for k, v in fields.items():
            setattr(r, k, v)
        p.relationships[y] = r


def _person(sim, pid: str):
    a = sim.agents.get(pid)
    if a is not None:
        return a
    return sim.folk.person(pid)


# --- names -------------------------------------------------------------------------------------------------------

def named_names(sim) -> set:
    out = set()
    for a in sim.agents.values():
        out.add(a.name)
    return out


def _first(rr: Rng, sex: str) -> str:
    return rr.pick(folk_names.FEMALE if sex == "f" else folk_names.MALE)


def unique_name(rr: Rng, sex: str, surname: str, taken: set) -> str:
    """A first name for `sex` and `surname` not yet taken; after 40 tries the surname changes too."""
    for _ in range(40):
        name = _first(rr, sex) + " " + surname
        if name not in taken:
            taken.add(name)
            return name
    while True:
        name = _first(rr, sex) + " " + rr.pick(folk_names.SURNAMES)
        if name not in taken:
            taken.add(name)
            return name


def baby_name(sim, sex: str, surname: str, k: int) -> str:
    """A unique full name for baby k (F2a's add_baby), first name never a named one's."""
    taken = named_names(sim)
    for p in sim.folk.people:
        taken.add(p.name)
    return unique_name(stream(sim.seed, NS_GEN, "baby", k), sex, surname, taken)


# --- 1. households -----------------------------------------------------------------------------------------------

def _kids(rr: Rng, young: int, most: int = 3) -> list:
    u = rr.random()
    n = 1 if u < 0.5 else 2 if u < 0.9 else 3
    if n > most:
        n = most
    hi = young - 18
    if hi > 17:
        hi = 17
    if hi < 0:
        hi = 0
    out = []
    for _ in range(n):
        out.append(rr.int(0, hi))
    return out


def ages_for(rr: Rng, kind: str) -> list:
    """[(age, role)]: role "a" a partner or the head, "k" a child, "g" a grandparent, "s" a sharer."""
    if kind == "single_young":
        return [(rr.int(19, 34), "a")]
    if kind == "single_mid":
        return [(rr.int(35, 64), "a")]
    if kind == "single_old":
        return [(rr.int(65, 92), "a")]
    if kind == "couple_young":
        a = rr.int(22, 39)
        return [(a, "a"), (max(19, a + rr.int(-4, 4)), "a")]
    if kind == "couple_mid":
        a = rr.int(40, 64)
        return [(a, "a"), (max(35, a + rr.int(-5, 5)), "a")]
    if kind == "couple_old":
        a = rr.int(65, 88)
        return [(a, "a"), (max(60, a + rr.int(-5, 5)), "a")]
    if kind == "family":
        a = rr.int(25, 55)
        b = max(22, a + rr.int(-4, 4))
        return [(a, "a"), (b, "a")] + [(k, "k") for k in _kids(rr, min(a, b))]
    if kind == "single_parent":
        a = rr.int(22, 55)
        return [(a, "a")] + [(k, "k") for k in _kids(rr, a, 2)]
    if kind == "sharers":
        n = rr.int(2, 3)
        out = []
        for _ in range(n):
            out.append((rr.int(19, 30), "s"))
        return out
    if kind == "grown_kids":
        a = rr.int(44, 62)
        b = max(40, a + rr.int(-4, 4))
        hi = min(28, min(a, b) - 18)
        n = rr.int(1, 2)
        out = [(a, "a"), (b, "a")]
        for _ in range(n):
            out.append((rr.int(18, hi), "k"))
        return out
    # three generations: a family plus a grandparent
    a = rr.int(28, 50)
    b = max(24, a + rr.int(-4, 4))
    out = [(a, "a"), (b, "a")] + [(k, "k") for k in _kids(rr, min(a, b))]
    out.append((rr.int(65, 88), "g"))
    return out


def make_deck(seed: int) -> list:
    rr = stream(seed, NS_GEN, "deck")
    cards = []
    for kind, w in KINDS:
        for _ in range(_round(w * DECK_SCALE)):
            cards.append(kind)
    rr.shuffle(cards)
    return cards, rr


def make_household(sim, folk, j: int, kind: str, room: int, taken: set, rr: Rng) -> FolkHousehold:
    """Household j of `kind` (at most `room` people): members with ages, sex, names, traits, needs and health,
    and the household's means `u`, drawn in that order from `rr` = (NS_GEN, "hh", j)."""
    rows = ages_for(rr, kind)[:room]
    hh = FolkHousehold(id=household_id(j), home_id="", weekly_rent=0.0, j=j)
    hh.kind = kind
    surname = rr.pick(folk_names.SURNAMES)
    first_sex = "f" if rr.random() < 0.5 else "m"
    members = []
    for k, (age, role) in enumerate(rows):
        if k == 0:
            sex = first_sex
        elif k == 1 and role == "a":
            same = rr.random() >= OPPOSITE_SEX
            sex = first_sex if same else ("m" if first_sex == "f" else "f")
        else:
            sex = "f" if rr.random() < 0.5 else "m"
        own = surname
        if role == "s" and k > 0:
            own = rr.pick(folk_names.SURNAMES)
        elif k == 1 and role == "a" and rr.random() >= SHARED_SURNAME:
            own = rr.pick(folk_names.SURNAMES)
        elif role == "g" and rr.random() < 0.5:
            own = rr.pick(folk_names.SURNAMES)
        name = unique_name(rr, sex, own, taken)
        p = Person(len(folk.people), name, age, sex, j)
        p.role = role
        folk.people.append(p)
        members.append(p)
        hh.member_ids.append(p.id)
    for p in members:
        traits = {}
        for t in Profile.TRAITS:
            traits[t] = rr.uniform(0.2, 0.8)
        p.traits = traits
    for p in members:
        for nd in NEEDS:
            p._needs[nd] = rr.uniform(60, 90)
    for p in members:
        h = rr.uniform(75, 100) - 0.3 * max(0, p.age - 60)
        p.health = h
    hh.u = rr.random()
    return hh


# --- populate ----------------------------------------------------------------------------------------------------

def populate(folk, sim, n: int) -> None:
    """Fill `folk.people` and `folk.households` with n townsfolk in the region's homes (folk.md 4)."""
    isolated = bool(getattr(folk, "isolated", False))
    sim.folk = folk  # people.person(sim, "f<i>") must find the people being made (make_folk assigns it after)
    seed = sim.seed
    geo = Geo(sim)
    taken = named_names(sim)
    # 1-2. households, members and names
    cards, deck_rr = make_deck(seed)
    hh_rr = []
    total = 0
    while total < n:
        if not cards:
            cards, deck_rr = _reshuffle(deck_rr)
        kind = cards.pop()
        j = len(folk.households)
        rr = stream(seed, NS_GEN, "hh", j)
        hh = make_household(sim, folk, j, kind, n - total, taken, rr)
        folk.households.append(hh)
        hh_rr.append(rr)
        total += len(hh.member_ids)
    people = folk.people
    hhs = folk.households
    # 3. homes first: region homes by value, every 10th held back
    move_in(sim, folk)
    # 4. cars
    station_near = {}
    for hh in hhs:
        home = sim.homes[hh.home_id]
        near = station_near.get(home.place)
        if near is None:
            near = station_near[home.place] = geo.station_walk(home.place) <= STATION_NEAR
        p_car = CAR_P[home.tier] * (CAR_NEAR_STATION if near else 1.0)
        rr = hh_rr[hh.j]
        for pid in hh.member_ids:
            p = people[int(pid[1:])]
            if p.age >= 18:
                p.owns_car = rr.random() < p_car
    # 5. schools
    assign_schools(sim, folk, geo, isolated)
    # 6. seekers
    seekers = []
    for hh in hhs:
        rr = hh_rr[hh.j]
        for pid in hh.member_ids:
            p = people[int(pid[1:])]
            if p.age < 18 or p.age > 64:
                continue
            study = p.age <= 21 and rr.random() < STUDY_P
            seek = rr.random() >= IDLE_P
            p.skill = 0.6 * hh.u + 0.4 * rr.random() + (0.1 if 30 <= p.age <= 55 else 0.0)
            if seek and not study:
                seekers.append(p)
    try:
        folk.seekers = len(seekers)
    except AttributeError:
        pass
    # 7-8. jobs
    match_rr = stream(seed, NS_GEN, "match")
    match_jobs(sim, folk, geo, seekers, isolated, match_rr)
    # 9. money
    for hh in hhs:
        rr = hh_rr[hh.j]
        for pid in hh.member_ids:
            p = people[int(pid[1:])]
            give_money(p, rr)
    # 11. ties
    make_ties(sim, folk, match_rr, isolated)
    # 12. the start: asleep at home
    now = sim.clock.tick
    day0 = now - sim.clock.minute_of_day
    for hh in hhs:
        rr = hh_rr[hh.j]
        place = sim.homes[hh.home_id].place
        for pid in hh.member_ids:
            p = people[int(pid[1:])]
            p.inside = place
            p.activity_place = place
            p.activity = "sleep"
            p.state = "busy"
            p._nt = now
            wake = day0 + rr.int(360, 450)
            job = p.job
            if job is not None and job.hourly_wage > 0 and sim.clock.weekday in job.workdays and p.commute is not None:
                leave = day0 + job.start_hour * 60 - p.commute[1] - 15
                if leave < wake:
                    wake = leave
            p.next_tick = wake if wake > now else now + 1
    lv = getattr(housing, "list_vacancies", None)
    if lv is not None:
        lv(sim)
    if hasattr(folk, "v"):
        folk.v += 1


def _reshuffle(rr: Rng):
    cards = []
    for kind, w in KINDS:
        for _ in range(_round(w * DECK_SCALE)):
            cards.append(kind)
    rr.shuffle(cards)
    return cards, rr


def region_homes(sim) -> list:
    """Start-occupiable region homes (let or owned) by base value, highest first (ids break ties)."""
    v2 = set()
    for spec in housing.HOME_SPECS:
        v2.add(spec[0])
    out = []
    for home in sim.homes.values():
        if home.id in v2 or home.start not in ("let", "owned") or home.household is not None:
            continue
        out.append(home)
    out.sort(key=lambda h: (-h.base_value, h.id))
    return out


def need_of(folk, hh) -> float:
    total = 0.0
    for pid in hh.member_ids:
        total += 0.5 if folk.people[int(pid[1:])].age < 10 else 1.0
    return total


def move_in(sim, folk) -> None:
    """Households by means (u desc, j) take the first free home with 2 x bedrooms >= need; every 10th home in value
    order is held back and used only when nothing else fits. A shortfall raises."""
    homes = region_homes(sim)
    free, held = [], []
    for k, h in enumerate(homes):
        (held if k % 10 == 9 else free).append(h)
    order = sorted(folk.households, key=lambda hh: (-hh.u, hh.j))
    for hh in order:
        need = need_of(folk, hh)
        pick = None
        for k, h in enumerate(free):
            if 2 * h.bedrooms >= need:
                pick = h
                del free[k]
                break
        if pick is None:
            for k, h in enumerate(held):
                if 2 * h.bedrooms >= need:
                    pick = h
                    del held[k]
                    break
        if pick is None:
            raise RuntimeError(f"no region home fits household {hh.id} ({len(hh.member_ids)} people)")
        hh.home_id = pick.id
        pick.household = hh.id
        if pick.start == "owned":
            pick.owner = hh.id
            hh.weekly_rent = 0.0
        else:
            hh.weekly_rent = float(pick.rent)


# --- 5. schools --------------------------------------------------------------------------------------------------

def student_job(age: int, school: str) -> Job:
    return Job("student", school, 0, 8, 13 if age < 9 else 14 if age < 13 else 15, (0, 1, 2, 3, 4))


def seats(sim, pid: str) -> int:
    cap = getattr(sim.town.places[pid], "capacity", 0) or SCHOOL_SEATS
    for a in sim.agents.values():
        if a.alive and a.job is not None and a.job.title == "student" and a.job.place_id == pid:
            cap -= 1
    return cap


def assign_schools(sim, folk, geo: Geo, isolated: bool) -> None:
    """Millbrook's school takes the 40 folk children 5-17 nearest by car (not when isolated). Of the rest, 11-17s go
    to Riverton High while it has seats and 5-10s to the nearest other region school with seats by walk. A pupil
    walks up to 25 minutes; past that a teen takes the train to Riverton High when it saves 5 minutes on the walk
    and takes at most 45 (region.md 7), else they are driven."""
    town = sim.town
    mb_ids = town.millbrook_ids or frozenset()
    people = folk.people
    home_of = {}
    for hh in folk.households:
        home_of[hh.j] = sim.homes[hh.home_id].place
    kids = [p for p in people if 5 <= p.age <= 17]
    left = {}
    schools = []
    for pid, pl in town.places.items():
        if pl.kind == "school":
            left[pid] = seats(sim, pid)
            if pid not in mb_ids:
                schools.append(pid)
    if not isolated and MILLBROOK_SCHOOL in town.places and MILLBROOK_SCHOOL in mb_ids:
        near = sorted(kids, key=lambda p: (geo.car(home_of[p.hh], MILLBROOK_SCHOOL), p.i))
        k = 0
        for p in near:
            if k >= MB_PUPILS or left[MILLBROOK_SCHOOL] <= 0:
                break
            place = home_of[p.hh]
            p.job = student_job(p.age, MILLBROOK_SCHOOL)
            left[MILLBROOK_SCHOOL] -= 1
            walk = geo.walk(place, MILLBROOK_SCHOOL)
            p.commute = (MILLBROOK_SCHOOL, walk, "walk") if walk <= SCHOOL_WALK else \
                (MILLBROOK_SCHOOL, geo.car(place, MILLBROOK_SCHOOL), "car")
            k += 1
    high = HIGH_SCHOOL if HIGH_SCHOOL in left else None
    for p in kids:
        if p.job is not None:
            continue
        place = home_of[p.hh]
        school = None
        if p.age >= TEEN_AGE and high is not None and left[high] > 0:
            school = high
        else:
            best = None
            for s in schools:
                if left[s] <= 0 or (s == high and p.age < TEEN_AGE and len(schools) > 1):
                    continue
                key = (geo.walk(place, s), s)
                if best is None or _lt(key, best):
                    best = key
            if best is None:
                continue  # no seat anywhere: home-schooled
            school = best[1]
        walk = geo.walk(place, school)
        mode, minutes = "walk", walk
        if walk > SCHOOL_WALK:
            mode, minutes = "car", geo.car(place, school)
            if school == high:
                tr = geo.train(place, high, False)
                if tr is not None and tr <= TEEN_TRAIN_CAP and tr <= walk - TRAIN_SAVES:
                    mode, minutes = "train", tr
        p.job = student_job(p.age, school)
        left[school] -= 1
        p.commute = (school, minutes, mode)


# --- 7-8. jobs ---------------------------------------------------------------------------------------------------

def job_rows(sim, isolated: bool) -> list:
    """[(row index, title, place, wage, start, end, days, count, millbrook)] of `town.job_slots`, Millbrook rows
    dropped when isolated."""
    town = sim.town
    mb_ids = town.millbrook_ids or frozenset()
    out = []
    for r, row in enumerate(town.job_slots):
        title, place, wage, start, end, days, count = row
        mb = place in mb_ids
        if mb and isolated:
            continue
        out.append((r, title, place, wage, start, end, tuple(days), count, mb))
    return out


def match_jobs(sim, folk, geo: Geo, seekers: list, isolated: bool, rr: Rng) -> None:
    """Millbrook rows slot by slot (nearest seeker within walk 25 or car 30, any wage), then region rows seeker by
    seeker (skill desc: least commute + jitter + 25 |wage pct - skill|, reservation wage first), then the nearest
    open slot by car buying a car; finally every slot onto the board."""
    people = folk.people
    home_of = {}
    for hh in folk.households:
        home_of[hh.j] = sim.homes[hh.home_id].place
    rows = job_rows(sim, isolated)
    # wage percentiles over every slot
    counts = {}
    total = 0
    for row in rows:
        counts[row[3]] = counts.get(row[3], 0) + row[7]
        total += row[7]
    pct = {}
    below = 0
    for w in sorted(counts):
        pct[w] = below / total if total else 0.0
        below += counts[w]
    holders = {}  # row index -> [folk id | None] * count
    left = {}  # row index -> open count
    for row in rows:
        holders[row[0]] = [None] * row[7]
        left[row[0]] = row[7]
    jit = {}
    for p in seekers:
        jit[p.i] = rr.int(0, JITTER)
    hired = set()
    # Millbrook rows: places with the fewest seekers in reach first
    mb_rows = [row for row in rows if row[8]]
    reach_lists = {}
    for row in mb_rows:
        place = row[2]
        if place in reach_lists:
            continue
        cand = []
        for p in seekers:
            home = home_of[p.hh]
            w = geo.walk(home, place)
            if w <= MB_WALK:
                cand.append((w + jit[p.i], p.i, w, "walk"))
                continue
            c = geo.car(home, place)
            if c <= MB_CAR:
                cand.append((c + jit[p.i], p.i, c, "car"))
        cand.sort()
        reach_lists[place] = cand
    mb_rows.sort(key=lambda row: (len(reach_lists[row[2]]), row[2], row[0]))
    for row in mb_rows:
        cand = reach_lists[row[2]]
        for k in range(row[7]):
            got = None
            for c in cand:
                if c[1] not in hired:
                    got = c
                    break
            if got is None:
                break
            p = people[got[1]]
            hired.add(p.i)
            holders[row[0]][k] = p.id
            left[row[0]] -= 1
            p.job = _job(row)
            p.commute = (row[2], got[2], got[3])
            if got[3] == "car":
                p.owns_car = True
    # region rows, seekers by skill desc
    by_place = {}
    places = []
    for row in rows:
        if row[8]:
            continue
        if row[2] not in by_place:
            by_place[row[2]] = []
            places.append(row[2])
        by_place[row[2]].append(row)
    rest = sorted((p for p in seekers if p.i not in hired), key=lambda p: (-p.skill, p.i))
    for p in rest:
        home = home_of[p.hh]
        res = RES_BASE + RES_SKILL * p.skill
        s = p.skill if p.skill < 1 else 1.0
        best = None
        for strict in (True, False):
            for place in places:
                c = None
                for row in by_place[place]:
                    if left[row[0]] <= 0 or (strict and row[3] < res):
                        continue
                    if c is None:
                        c = geo.commute(home, place, p.owns_car)
                        if c is None:
                            break
                        j = rr.int(0, JITTER)
                    cost = c[0] + j + SKILL_W * abs(pct[row[3]] - s)
                    if best is None or cost < best[0]:
                        best = (cost, row, c)
            if best is not None:
                break
        if best is None:
            for place in places:
                for row in by_place[place]:
                    if left[row[0]] <= 0:
                        continue
                    c = geo.car(home, place)
                    if c > CAR_CAP:
                        break
                    cost = c + rr.int(0, JITTER)
                    if best is None or cost < best[0]:
                        best = (cost, row, (c, "car"))
                    break
            if best is None:
                continue
            p.owns_car = True
        row = best[1]
        k = row[7] - left[row[0]]
        holders[row[0]][k] = p.id
        left[row[0]] -= 1
        hired.add(p.i)
        p.job = _job(row)
        m = geo.mode(home, row[2], p.owns_car)
        p.commute = (row[2], m[0], m[1])
    # every slot onto the board, in row order
    b = board(sim)
    for row in rows:
        hs = holders[row[0]]
        for k in range(row[7]):
            holder = hs[k]
            if holder is None:
                job = _job(row)
            else:
                job = people[int(holder[1:])].job
            slot = b.add(job, holder)
            job.slot = slot


def _job(row) -> Job:
    job = Job(row[1], row[2], row[3], row[4], row[5], tuple(row[6]))
    job.slot = -1
    return job


# --- 9. money ----------------------------------------------------------------------------------------------------

def give_money(p, rr: Rng) -> None:
    """Cash and savings on cast.SAVINGS_RANGE's scale (folk.md 4.9): kids $0-40."""
    if p.age < 18:
        p.money = float(rr.int(0, 40))
        p.savings = 0.0
        return
    w = weekly_pay(p.job)
    retired = p.job is None and p.age >= 65
    if retired:
        band = "retired"
    elif w < LOW_PAY:
        band = "low"
    elif w < HIGH_PAY:
        band = "mid"
    else:
        band = "high"
    lo, hi = SAVINGS_WEEKS[band]
    base = w if w > 0 else PENSION
    sav = 0.0 if rr.random() < NO_SAVINGS_P else min(SAVINGS_CAP, base * rr.uniform(lo, hi))
    if w > 0 or retired:
        cash = base * rr.uniform(0.5, 1.5)
    else:
        cash = float(rr.int(50, 300))
    p.money = r2(cash)
    p.savings = r2(sav)


# --- 11. ties ----------------------------------------------------------------------------------------------------

def make_ties(sim, folk, rr: Rng, isolated: bool) -> None:
    people = folk.people
    # partners and family
    for hh in folk.households:
        mem = [people[int(pid[1:])] for pid in hh.member_ids]
        heads = [p for p in mem if p.role == "a"]
        if len(heads) >= 2 and hh.kind != "single_parent":
            a, b = heads[0], heads[1]
            set_rel(sim, a.id, b.id, RelationKind.PARTNER, rr.uniform(60, 85), None, romance=70.0,
                    married=rr.random() < 0.7)
        for x in range(len(mem)):
            for y in range(x + 1, len(mem)):
                a, b = mem[x], mem[y]
                if a.role == "a" and b.role == "a" and hh.kind != "single_parent":
                    continue
                if a.role == "s" or b.role == "s":
                    set_rel(sim, a.id, b.id, RelationKind.FRIEND, rr.uniform(30, 60))
                    continue
                set_rel(sim, a.id, b.id, RelationKind.FAMILY, rr.uniform(70, 85))
    # coworkers on the same shift
    shifts = {}
    keys = []
    for p in people:
        j = p.job
        if j is None or j.hourly_wage <= 0:
            continue
        key = (j.place_id, j.start_hour, j.end_hour)
        if key not in shifts:
            shifts[key] = []
            keys.append(key)
        shifts[key].append(p)
    keys.sort()
    count = {}
    for key in keys:
        _ring_ties(sim, shifts[key], COWORKERS, count, "w", RelationKind.COWORKER, 15, 35, rr, None)
    # classmates within a year
    by_school = {}
    skeys = []
    for p in people:
        j = p.job
        if j is None or j.title != "student":
            continue
        if j.place_id not in by_school:
            by_school[j.place_id] = []
            skeys.append(j.place_id)
        by_school[j.place_id].append(p)
    skeys.sort()
    for s in skeys:
        _ring_ties(sim, by_school[s], CLASSMATES, count, "c", RelationKind.FRIEND, 30, 60, rr, 1)
    # neighbours in the same building
    by_place = {}
    pkeys = []
    for hh in folk.households:
        place = sim.homes[hh.home_id].place
        if place not in by_place:
            by_place[place] = []
            pkeys.append(place)
        for pid in hh.member_ids:
            p = people[int(pid[1:])]
            if p.age >= 18:
                by_place[place].append(p)
    pkeys.sort()
    for place in pkeys:
        _ring_ties(sim, by_place[place], NEIGHBOURS, count, "n", RelationKind.ACQUAINTANCE, 10, 30, rr, None)
    # 1-2 friends in the home district, within 8 years
    by_district = {}
    dkeys = []
    for hh in folk.households:
        d = sim.town.places[sim.homes[hh.home_id].place].district
        if d not in by_district:
            by_district[d] = []
            dkeys.append(d)
        for pid in hh.member_ids:
            p = people[int(pid[1:])]
            if p.age >= 18:
                by_district[d].append(p)
    dkeys.sort()
    for d in dkeys:
        pool = by_district[d]
        if len(pool) < 2:
            continue
        for p in pool:
            want = rr.int(1, 2)
            have = count.get((p.i, "d"), 0)
            tries = 0
            while have < want and tries < 12:
                tries += 1
                q = pool[rr.int(0, len(pool) - 1)]
                if q is p or q.hh == p.hh or abs(q.age - p.age) > FRIEND_AGE_GAP or q.id in p.relationships:
                    continue
                if count.get((q.i, "d"), 0) >= 3:
                    continue
                set_rel(sim, p.id, q.id, RelationKind.FRIEND, rr.uniform(30, 60))
                have += 1
                count[(p.i, "d")] = have
                count[(q.i, "d")] = count.get((q.i, "d"), 0) + 1
    if isolated:
        return
    # named and folk: coworkers on overlapping shifts at Millbrook places, classmates at Millbrook's school
    for a in sim.agents.values():
        j = a.job
        if not a.alive or j is None:
            continue
        if j.title == "student":
            mates = []
            for p in by_school.get(j.place_id, ()):
                if abs(p.age - a.age) <= 1:
                    mates.append(p)
            _pick_named(sim, a, mates, NAMED_CLASSMATES, RelationKind.FRIEND, 30, 60, rr)
            continue
        if j.hourly_wage <= 0:
            continue
        mates = []
        for key in keys:
            if key[0] != j.place_id or not _overlap(key[1], key[2], j.start_hour, j.end_hour):
                continue
            for p in shifts[key]:
                mates.append(p)
        mates.sort(key=lambda p: p.i)
        _pick_named(sim, a, mates, NAMED_COWORKERS, RelationKind.COWORKER, 15, 35, rr)


def _overlap(s1: int, e1: int, s2: int, e2: int) -> bool:
    """Two shifts share an hour (night shifts run past midnight)."""
    for h in range(24):
        if _on(h, s1, e1) and _on(h, s2, e2):
            return True
    return False


def _on(h: int, s: int, e: int) -> bool:
    return s <= h < e if s < e else (h >= s or h < e)


def _ring_ties(sim, group: list, cap: int, count: dict, tag: str, kind, lo: float, hi: float, rr: Rng, age_gap):
    """Up to `cap` ties each inside a group: shuffle, then each member asks the next ones round the ring."""
    n = len(group)
    if n < 2:
        return
    order = list(group)
    rr.shuffle(order)
    for x in range(n):
        p = order[x]
        for d in range(1, n):
            if count.get((p.i, tag), 0) >= cap:
                break
            q = order[(x + d) % n]
            if count.get((q.i, tag), 0) >= cap or q.id in p.relationships:
                continue
            if age_gap is not None and abs(q.age - p.age) > age_gap:
                continue
            set_rel(sim, p.id, q.id, kind, rr.uniform(lo, hi))
            count[(p.i, tag)] = count.get((p.i, tag), 0) + 1
            count[(q.i, tag)] = count.get((q.i, tag), 0) + 1


def _pick_named(sim, a, mates: list, cap: int, kind, lo: float, hi: float, rr: Rng) -> None:
    pool = list(mates)
    rr.shuffle(pool)
    k = 0
    for p in pool:
        if k >= cap:
            break
        if p.id in a.relationships:
            continue
        set_rel(sim, a.id, p.id, kind, rr.uniform(lo, hi))
        k += 1


# --- newcomers ---------------------------------------------------------------------------------------------------

def newcomer(sim, folk, home_id: str, k: int):
    """Newcomer household k in vacant `home_id`, jobless or retired (folk.md 4: stream (NS_GEN, "new", k))."""
    rr = stream(sim.seed, NS_GEN, "new", k)
    kind = rr.pick(["single_young", "single_mid", "single_old", "couple_young", "couple_old", "family"])
    taken = named_names(sim)
    for p in folk.people:
        taken.add(p.name)
    j = len(folk.households)
    hh = make_household(sim, folk, j, kind, 6, taken, rr)
    folk.households.append(hh)
    home = sim.homes[home_id]
    hh.home_id = home_id
    home.household = hh.id
    if home.owner == "market":
        home.owner = hh.id
        hh.weekly_rent = 0.0
    else:
        hh.weekly_rent = float(home.rent)
    place = home.place
    for pid in hh.member_ids:
        p = folk.people[int(pid[1:])]
        if p.age >= 18:
            p.owns_car = rr.random() < CAR_P.get(home.tier, 0.2)
        if 5 <= p.age <= 17:
            p.job = student_job(p.age, _nearest_school(sim, place))
        give_money(p, rr)
        p.inside = place
        p.activity_place = place
        p.activity = "relax_home"
        p.state = "busy"
        p._nt = sim.clock.tick
        p.next_tick = sim.clock.tick + 1
    return hh


def _nearest_school(sim, place: str) -> str:
    from . import roads
    net = roads.net(sim.town)
    mb_ids = sim.town.millbrook_ids or frozenset()
    best = None
    for pid, pl in sim.town.places.items():
        if pl.kind != "school" or pid in mb_ids:
            continue
        key = (net.minutes(place, pid, "walk"), pid)
        if best is None or _lt(key, best):
            best = key
    return best[1] if best else MILLBROOK_SCHOOL


# --- a minimal sim for generation alone (the fixture, tests) -------------------------------------------------------

class GenFolk:
    """The people and households `populate` fills, without Folk's daily life (F2a)."""

    def __init__(self, n: int, isolated: bool = False):
        self.n = n
        self.isolated = isolated
        self.v = 0
        self.people = []
        self.households = []
        self.seekers = 0

    def person(self, pid):
        if isinstance(pid, str) and len(pid) > 1 and pid[0] == "f" and pid[1:].isdigit():
            i = int(pid[1:])
            if i < len(self.people):
                return self.people[i]
        return None

    get = person

    def household(self, hid):
        if isinstance(hid, str) and hid.startswith("fh") and hid[2:].isdigit():
            j = int(hid[2:])
            if j < len(self.households):
                return self.households[j]
        return None

    def living(self) -> list:
        return [p for p in self.people if p.alive and not p.gone]


class GenSim:
    """What populate reads: seed, clock, the region town, homes (v2's and the region's), the cast, a list board."""

    def __init__(self, seed: int = 1, isolated: bool = False, with_cast: bool = True):
        from . import region
        self.seed = seed
        self.dice_seed = seed
        self.world = "region"
        self.clock = Clock()
        self.town = region.build_region(seed)
        self.homes = housing.build_homes(self.town)
        add_region_homes(self)
        self.lots = build_lots(self.town, self.homes)
        self.agents, self.households = cast.build_cast(self.town, self.homes, seed) if with_cast else ({}, {})
        housing.init(self)
        self.job_board = ListBoard()
        self.folk_isolated = isolated
        self.folk = GenFolk(0, isolated)
        self.events = []

    def person(self, pid):
        a = self.agents.get(pid)
        return a if a is not None else self.folk.person(pid)

    def household_by_id(self, hid):
        hh = self.households.get(hid)
        return hh if hh is not None else self.folk.household(hid)


def build_lots(town, homes: dict) -> dict:
    """housing.build_lots, or (before R1b) v2's lots plus the region's from `town.lot_conditions`."""
    try:
        return housing.build_lots(town, homes)
    except KeyError:
        v2 = {}
        for spec in housing.HOME_SPECS:
            v2[spec[0]] = homes[spec[0]]
        lots = housing.build_lots(town, v2)
        conds = getattr(town, "lot_conditions", {}) or {}
        for home in homes.values():
            if home.place not in lots:
                c = float(conds.get(home.place, 70))
                lots[home.place] = housing.Lot(home.place, c, reported=housing.stage_of(c), worst=housing.stage_of(c))
        return lots


def add_region_homes(sim) -> None:
    """Region homes (town.home_specs) into sim.homes when housing.build_homes leaves them out (before R1b)."""
    for spec in getattr(sim.town, "home_specs", ()):
        hid, place_id, unit, tier, beds, base, rent, start = spec[:8]
        if hid in sim.homes:
            continue
        place = sim.town.places[place_id]
        name = f"{place.name}, flat {unit}" if unit else place.name
        owner = "landlord" if start in ("let", "for_rent") else "market" if start == "for_sale" else None
        sim.homes[hid] = housing.Home(hid, place_id, unit, name, tier, beds, base, rent, start, owner=owner)


def generate(seed: int = 1, n: int = 1000, isolated: bool = False) -> GenSim:
    sim = GenSim(seed, isolated)
    sim.folk = GenFolk(n, isolated)
    Person.clock = sim.clock
    Person.town = sim.town
    populate(sim.folk, sim, n)
    return sim


def dump(sim) -> dict:
    """The fixture: every person and household as plain JSON (money as r2, ties as [kind, round affinity])."""
    people = []
    for p in sim.folk.people:
        rels = {}
        for oid in sorted(p.relationships):
            r = p.relationships[oid]
            kind = r.kind.value if hasattr(r.kind, "value") else r.kind
            rels[oid] = [kind, _round(r.affinity)]
        j = p.job
        people.append({
            "id": p.id, "name": p.name, "age": p.age, "sex": p.sex, "hh": p.household_id,
            "traits": [r2(p.traits[t]) for t in Profile.TRAITS], "needs": [r2(p._needs[nd]) for nd in NEEDS],
            "health": r2(p.health), "money": r2(p.money), "savings": r2(p.savings), "car": p.owns_car,
            "job": None if j is None else [j.title, j.place_id, j.hourly_wage, j.start_hour, j.end_hour,
                                           list(j.workdays), getattr(j, "slot", -1)],
            "commute": None if p.commute is None else list(p.commute), "next": p.next_tick, "rel": rels})
    hhs = []
    for hh in sim.folk.households:
        hhs.append({"id": hh.id, "kind": hh.kind, "home": hh.home_id, "rent": hh.weekly_rent,
                    "members": list(hh.member_ids)})
    return {"seed": sim.seed, "people": people, "households": hhs}


def summary(sim) -> dict:
    """The numbers folk.md 12 checks and the handoff reports."""
    folk = sim.folk
    people = folk.people
    n = len(people)
    kids = adults = old = 0
    for p in people:
        if p.age < 18:
            kids += 1
        elif p.age < 65:
            adults += 1
        else:
            old += 1
    modes = {}
    comm = []
    workers = 0
    for p in people:
        if p.job is not None and p.job.hourly_wage > 0:
            workers += 1
            if p.commute is not None:
                comm.append(p.commute[1])
                modes[p.commute[2]] = modes.get(p.commute[2], 0) + 1
    comm.sort()
    teen_rail = 0
    for p in people:
        if p.job is not None and p.job.title == "student" and p.commute is not None and p.commute[2] == "train":
            teen_rail += 1
    region_ids = [h.id for h in sim.homes.values() if h.id not in {s[0] for s in housing.HOME_SPECS}]
    vacant = 0
    for hid in region_ids:
        if sim.homes[hid].household is None:
            vacant += 1
    mb_ids = sim.town.millbrook_ids or frozenset()
    mb_rows = mb_filled = 0
    b = board(sim)
    for slot, job in enumerate(b.jobs):
        if job.place_id in mb_ids and job.title != "student" and _folk_slot(b, slot):
            mb_rows += 1
            if b.holder[slot] is not None:
                mb_filled += 1
    return {"people": n, "households": len(folk.households), "kids": kids, "adults": adults, "old": old,
            "workers": workers, "modes": modes, "commute_median": comm[len(comm) // 2] if comm else 0,
            "teen_riders": teen_rail, "vacant": vacant, "region_homes": len(region_ids),
            "mb_rows": mb_rows, "mb_filled": mb_filled, "seekers": getattr(folk, "seekers", None)}


def _folk_slot(b, slot: int) -> bool:
    h = b.holder[slot]
    return h is None or (isinstance(h, str) and h[:1] == "f" and h[1:].isdigit())


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv[:1] == ["--dump"]:
        seed = int(argv[1]) if len(argv) > 1 else 1
        sim = generate(seed)
        path = argv[2] if len(argv) > 2 else "tests/fixtures/folk_seed1.json"
        with open(path, "w") as f:
            json.dump(dump(sim), f, separators=(",", ":"))
            f.write("\n")
        print(json.dumps(summary(sim)))
        return 0
    seed = int(argv[0]) if argv else 1
    print(json.dumps(summary(generate(seed))))
    return 0


if __name__ == "__main__":
    sys.exit(main())

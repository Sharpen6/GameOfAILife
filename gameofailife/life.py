"""The life course for both tiers (life.md 5.5-5.9): illness, doctors and hospital stays, death, pregnancy and
births, babies and birthdays, splits and widowing.

Every person (a named Agent or a folk Person) holds a `LifeState` in `p.life`; the city holds a `LifeCity` in
`sim.life`. Each person's daily rolls run once a game day in their own slot minute (`LifeState.slot`), so the work
is spread over the day; things due at a set time (a birth at 08:00, a discharge, a bill) wait in
`sim.life.agenda`. Dice come from `dice.stream(sim.dice_seed, NS, id, day)`, never `sim.rng`; every luck-shifted
roll goes through `people.log_roll`. Folk are reached only through `folk.py`'s functions (life.md 3.2).
"""

from __future__ import annotations

from collections import Counter, deque
from dataclasses import dataclass, field

from . import career, life_tables, money

FORK_AGE = 5  # under this age a named child gets no forks: `toddle` runs their day
PACE = {"health": 1.0, "death": 1.0, "birth": 2.5, "romance": 2.0, "career": 2.0}  # life.md 3.4, a 360-day year
YEAR_DAYS = 360
DAY = 24 * 60
LUCK_LOG_SIZE = 5000
SEASON_INDEX = {"spring": 0, "summer": 1, "autumn": 2, "winter": 3}

# Acute conditions (life.md 5.5): (id, adult rate a year, x under 18, x 65+, x by season (spring, summer, autumn,
# winter), days, days off work, health lost, contagious days, home spread a day, label)
ACUTE = (
    ("cold", 2.0, 2.0, 0.8, (0.8, 0.45, 1.2, 1.8), (4, 8), (0, 1), 4, 3, 0.08, "a cold"),
    ("flu", 0.12, 1.5, 1.2, (0.6, 0.15, 1.5, 3.0), (6, 10), (3, 5), 20, 4, 0.15, "the flu"),
    ("stomach_bug", 0.4, 1.5, 1.0, (1.0, 1.0, 1.0, 1.0), (2, 3), (1, 1), 6, 2, 0.10, "a stomach bug"),
    ("back_pain", 0.12, 0.1, 1.3, (1.0, 1.0, 1.0, 1.0), (7, 14), (0, 1), 8, 0, 0.0, "back pain"),
    ("fracture", 0.02, 1.0, 2.5, (1.0, 1.0, 1.0, 1.0), (28, 42), (10, 21), 15, 0, 0.0, "a broken bone"),
)
HEART = (("heart_attack", 0.6, "a heart attack"), ("stroke", 0.4, "a stroke"))  # shares of HEART_YEAR
HEART_DAYS, HEART_WARD, HEART_HEALTH, HEART_FATAL = (10, 20), (5, 10), 40, 0.15
BACK_PAIN_MANUAL = (2, 5)  # days off with back pain in a manual job (a place of kind "works")
CHRONIC = ("hypertension", "diabetes", "arthritis", "heart_disease")
LABELS = {c[0]: c[10] for c in ACUTE} | {h[0]: h[2] for h in HEART} | {"sprain": "a sprain"} \
    | {c: c.replace("_", " ") for c in CHRONIC}
SPRAIN = ((7, 14), (0, 3))  # a v2 outcome costing 8+ health: days, days off
DOCTOR_FEE = 40.0
DOCTOR_DAYS = 0.7  # a doctor shortens an illness by 30% ...
DOCTOR_COMPLICATIONS = 0.5  # ... and halves its complications
WARD_FEE = 60.0  # a day in hospital
ILL_CAP = 85.0  # health while an acute condition lasts
WARD_HEAL = 6.0  # health an hour in the ward
LOW_HEALTH = 40  # below this, death odds x3
FRAIL_AGE, FRAIL_RATE = 55, 0.8  # max_health falls this much a year past this age
CHRONIC_HEALTH = 5  # ... and this much for each chronic condition
GRIEF_DAYS = 30
# Births (life.md 5.6)
CONCEPTION = ((20, 0.0), (25, 0.10), (35, 0.14), (40, 0.08), (45, 0.025))  # (under this age, yearly b)
CHILDREN_MULT = (1.3, 1.0, 0.45, 0.15)  # by the children already in the household (0, 1, 2, 3+)
PREGNANCY_DAYS = 90
BIRTH_MINUTE = 8 * 60
WANT_EVERY = 30  # days between thinking about a child
NEW_BABY_DAYS = 180  # parents of a baby this young lose BABY_ENERGY a day
BABY_ENERGY = 8
FAMILY_AFFINITY = 75
SCHOOL_AGE, ADULT_AGE = 5, 18
# The start (life.md 5.9)
SHIRA_DUE = (3, BIRTH_MINUTE)  # Shira Peretz's baby: day index 3 ("Day 4"), 08:00
ARI_BILL = (1, 10 * 60)  # Ari Ben-David's bill: day index 1 ("Day 2"), 10:00
SEED_PREGNANT = 0.03  # of partnered townswomen 20-44 at the start, due days 5-90


class _Spec(dict):
    """An activity spec read either way: spec["minutes"] (housing.ACTIVITIES_EXTRA's style) or spec.minutes."""
    __slots__ = ()
    minutes = property(lambda s: s["minutes"])
    gains = property(lambda s: s["gains"])
    inside = property(lambda s: s["inside"])


ACTIVITIES_EXTRA = {
    "ward": _Spec(minutes=1440, gains={"hunger": 40}, inside=True),  # a hospital stay: lasts until ward_until
    "doctor": _Spec(minutes=45, gains={}, inside=True),
    "baby": _Spec(minutes=1440, gains={}, inside=True),  # an under-5's day at home (toddle)
}


@dataclass(slots=True)
class Condition:
    id: str
    since: int  # tick
    until: int  # tick it clears
    off_until: int  # tick until which it keeps the person off work or school
    contagious_until: int
    severity: int  # health lost at onset
    doctor: bool = False


@dataclass(slots=True)
class LifeState:
    birthday: int  # day of the 360-day year: sid(id) % 360
    slot: int  # minute of the day of the daily rolls: sid(id) % 1380
    review_day: int  # sid(id) % 90
    conditions: list = field(default_factory=list)  # Conditions (one acute at a time)
    chronic: list = field(default_factory=list)  # chronic condition ids
    treated: list = field(default_factory=list)  # the chronic ids under treatment
    ward_until: int = 0
    pregnant: tuple | None = None  # (due_day, other_parent_id)
    trying: bool = False
    lifestyle: float = 0.0
    pay: float = 0.0
    tight_until: int = 0
    job_since: int = 0
    jobless_since: int | None = None
    last_wage: float = 0.0
    warnings: int = 0
    grief_until: int = 0
    widowed_day: int | None = None
    talks_today: int = 0
    talks: list = field(default_factory=list)  # talk ring (12)
    pending: list = field(default_factory=list)  # prompts
    cooldowns: dict = field(default_factory=dict)  # kind -> day
    recent: dict = field(default_factory=dict)  # tag -> day


@dataclass(slots=True)
class LifeCity:
    board: career.JobBoard
    by_slot: dict = field(default_factory=dict)  # minute of the day -> ids rolled then
    agenda: dict = field(default_factory=dict)  # tick -> [(kind, id, arg)]
    loans: list = field(default_factory=list)
    counts: Counter = field(default_factory=Counter)
    today: Counter = field(default_factory=Counter)
    yesterday: Counter = field(default_factory=Counter)
    luck_log: deque = field(default_factory=lambda: deque(maxlen=LUCK_LOG_SIZE))


# --- small helpers (other packages' modules are imported lazily: PLAN 2.16) -------------------------------

def _stream(sim, ns_name: str, *parts):
    from . import dice, people

    return dice.stream(people.dice_seed(sim), getattr(dice, ns_name), *parts)


def _sid(x) -> int:
    from . import dice

    return dice.sid(x)


def _hit(sim, p, what: str, base: float, valence: int, rr, k: float = 1.0) -> bool:
    """One luck-shifted roll, logged (people.log_roll): True when it comes up."""
    from . import dice, people

    prob = dice.odds(base, valence, p.luck, k)
    roll = rr.random()
    people.log_roll(sim, p, what, prob, roll)
    return roll < prob


def _named(sim, p) -> bool:
    return p.id in sim.agents


def _person(sim, pid):
    from . import people

    return people.person(sim, pid)


def _folk():
    from . import folk

    return folk


def _members(sim, p) -> list:
    from . import people

    return people.members(sim, p)


def _traits(p) -> dict:
    from . import people

    return people.traits(p)


def _sex(p) -> str:
    s = getattr(p, "sex", None)
    if s:
        return s
    from . import people

    return people.sex(p)


def _event(sim, p, text: str, tag: str, importance: int | None = None, agents: list | None = None) -> None:
    """A life event: named through `sim.event`; folk only from importance 1 (`news_gate` caps them)."""
    if _named(sim, p):
        sim.event(text, p, tag=tag, importance=importance, agents=agents)
    elif importance is not None and importance >= 1:
        sim.event(text, None, tag=tag, importance=importance, agents=[p.id] + [a for a in (agents or [])
                                                                               if a != p.id])


def _agenda(sim, tick: int, kind: str, pid: str, arg=None) -> None:
    sim.life.agenda.setdefault(tick, []).append((kind, pid, arg))


def _place_name(sim, place_id: str) -> str:
    place = sim.town.places.get(place_id)
    return place.name if place else place_id


def _hospital_id(sim, p) -> str:
    """Millbrook's hospital for a named (Rule R through `sim.nearest`), else the town's first hospital."""
    if _named(sim, p):
        place = sim.nearest(p, ("hospital",))
        if place is not None:
            return place.id
    return "hospital"


def _partner(sim, p):
    """The living partner in `p`'s household (a PARTNER relationship), or None."""
    for oid, rel in p.relationships.items():
        if getattr(rel.kind, "value", rel.kind) == "partner":
            other = _person(sim, oid)
            if other is not None and other.alive and other.household_id == p.household_id:
                return other
    return None


def _children(sim, p) -> list:
    """`p`'s household's living under-18s other than `p`."""
    return [m for m in _members(sim, p) if m is not p and m.age < ADULT_AGE]


# --- setup -------------------------------------------------------------------------------------------------

def pre_init(sim) -> None:
    """`sim.life` and the job board with the named v2 jobs as slots 0..k-1 (paid jobs, in cast order)."""
    board = career.JobBoard()
    for a in sim.agents.values():
        if a.job is not None and a.job.hourly_wage > 0:
            board.add(a.job, a.id)
    board.named = len(board.jobs)
    sim.life = LifeCity(board)


def init(sim) -> None:
    """A LifeState for everyone, then the start (seed_story)."""
    from . import people

    for p in people.everyone(sim):
        init_person(sim, p)
    seed_story(sim)


def init_person(sim, p) -> None:
    """Give a person (named, folk, newcomer or newborn) a LifeState and a daily slot."""
    h = _sid(p.id)
    p.life = LifeState(birthday=h % YEAR_DAYS, slot=h % 1380, review_day=h % 90)
    if p.job is not None and p.job.hourly_wage > 0:
        p.life.last_wage = p.job.hourly_wage
    elif p.job is None and ADULT_AGE <= p.age < 65:
        p.life.jobless_since = sim.clock.day  # an adult under 65 with no job looks for one
    sim.life.by_slot.setdefault(p.life.slot, []).append(p.id)


def seed_story(sim) -> None:
    """The start (life.md 5.9): L1's social half (`social.seed_story`), then the health and pregnancy half:
    chronic conditions by age for everyone 30+, a few townswomen expecting, Shira Peretz due on day 4 at 08:00
    and Ari Ben-David's bill on day 2 at 10:00."""
    from . import people, social

    fn = getattr(social, "seed_story", None)
    if fn is not None:
        fn(sim)
    for p in people.everyone(sim):
        rr = _stream(sim, "STORY", p.id, "life")
        if p.age >= 30:
            cum = 0.0
            for age in range(30, min(p.age, life_tables.AGE_MAX) + 1):
                cum += life_tables.CHRONIC_YEAR[age]
            for cid in CHRONIC:
                if rr.random() < cum / len(CHRONIC):
                    p.life.chronic.append(cid)
                    if rr.random() < 0.4 + 0.5 * _traits(p)["health"]:
                        p.life.treated.append(cid)
        if (not _named(sim, p) and _sex(p) == "f" and 20 <= p.age <= 44 and rr.random() < SEED_PREGNANT
                and _partner(sim, p) is not None):
            _conceive(sim, p, _partner(sim, p), rr.int(5, PREGNANCY_DAYS), quiet=True)
    shira, eli = sim.agents.get("shira"), sim.agents.get("eli")
    if shira is not None and eli is not None and shira.alive:
        _conceive(sim, shira, eli, SHIRA_DUE[0], quiet=True)
    ari = sim.agents.get("ari")
    if ari is not None:
        _agenda(sim, ARI_BILL[0] * DAY + ARI_BILL[1], "bill", ari.id, None)


def _conceive(sim, mother, other, due_day: int, quiet: bool = False) -> None:
    mother.life.pregnant = (due_day, other.id if other is not None else None)
    mother.life.trying = False
    _agenda(sim, due_day * DAY + BIRTH_MINUTE, "birth", mother.id, None)
    if not quiet:
        with_ = f" and {other.name}" if other is not None else ""
        _event(sim, mother, f"{mother.name}{with_} are expecting a baby." if other is not None
               else f"{mother.name} is expecting a baby.", "expecting", agents=[other.id] if other else None)


# --- the clock ---------------------------------------------------------------------------------------------

def tick(sim) -> None:
    """Each tick: the agenda, then the daily rolls of the people whose slot is this minute, and on Sundays
    09:00-19:00 the money week of each adult (`money.weekly`) at minute 09:00 + slot % 600."""
    lc = sim.life
    t = sim.clock.tick
    m = sim.clock.minute_of_day
    if m == 0:
        lc.yesterday = lc.today
        lc.today = Counter()
    if m % 60 == 0:
        _ward_care(sim, t)
    due = lc.agenda.pop(t, None)
    if due:
        for kind, pid, arg in due:
            _run_agenda(sim, kind, pid, arg)
    ids = lc.by_slot.get(m)
    if ids:
        day = sim.clock.day
        for pid in list(ids):
            p = _person(sim, pid)
            if p is not None and p.alive:
                daily(sim, p, day)
    if sim.clock.weekday == money.SUNDAY and money.WINDOW[0] <= m < money.WINDOW[1]:
        k = m - money.WINDOW[0]
        for base in (k, k + 600, k + 1200):
            for pid in list(lc.by_slot.get(base, ())):
                p = _person(sim, pid)
                if p is not None and p.alive and p.is_adult:
                    money.weekly(sim, p)


def _run_agenda(sim, kind: str, pid: str, arg) -> None:
    p = _person(sim, pid)
    if p is None or not p.alive:
        return
    if kind == "birth":
        if p.life.pregnant is not None:
            other = p.life.pregnant[1]
            p.life.pregnant = None
            birth(sim, p, other)
    elif kind == "discharge":
        _discharge(sim, p, arg)
    elif kind == "hospital":
        hospitalise(sim, p, arg[0], arg[1])
    elif kind == "bill":
        amount = int(max(0.0, p.money + p.savings) + 300)
        p.money -= amount
        _event(sim, p, f"{p.name} gets a bill for ${amount:,} that they cannot pay.", "expense",
               importance=2 if amount >= 2000 else 1)


def _ward_care(sim, t: int) -> None:
    """Hourly, for the named in a hospital ward: fed, rested and treated (v2's `hospital` activity heals .15 a
    minute; a stay of days would otherwise starve on the ward's spread-out gains)."""
    for a in sim.agents.values():
        life = a.life
        if a.alive and life is not None and life.ward_until > t:
            for n in ("hunger", "energy"):
                a.needs[n] = max(a.needs[n], 60.0)
            a.health = min(max_health(a), a.health + WARD_HEAL)


def legacy_ageing(sim) -> None:
    """v2's old-age roll and yearly birthday (v3-fixes sim.py `_new_day`, lines 316-326): emptied, because
    birthdays (each person's own day) and mortality (5.5) replace them."""
    return None


def daily(sim, p, day: int) -> None:
    """`p`'s daily rolls: birthday, health and death, family, work."""
    life = p.life
    if day and day % YEAR_DAYS == life.birthday:
        birthday(sim, p)
    if life.grief_until > day:
        p.adjust("fun", -1)
    rr = _stream(sim, "DAY_HEALTH", p.id, day)
    _health(sim, p, rr, day)
    if not p.alive:
        return
    _family(sim, p, day)
    career.daily(sim, p, _stream(sim, "DAY_CAREER", p.id, day))


def birthday(sim, p) -> None:
    """A year older (life.md 5.6): folk to `folk.on_birthday` then `folk.on_job_change`; a named child starts
    school at 5 and finishes at 18 (`came_of_age`), and a pupil's school day follows their age."""
    from . import cast

    p.age += 1
    if not _named(sim, p):
        folk = _folk()
        folk.on_birthday(sim, p)
        folk.on_job_change(sim, p)
        return
    student = p.job is not None and p.job.hourly_wage == 0 and p.job.place_id == "school"
    if p.age == SCHOOL_AGE and p.job is None:
        p.job = cast._student_job(p.age)
    elif student and p.age >= ADULT_AGE:
        p.job = None
        p.life.jobless_since = sim.clock.day
        _event(sim, p, f"{p.name} turns {p.age} and finishes school.", "came_of_age")
    elif student:
        p.job = cast._student_job(p.age)


def toddle(sim, p) -> None:
    """An under-5's next step (no forks): a day at home doing `baby`, needs held at 75."""
    for n in p.needs:
        p.needs[n] = max(p.needs[n], 75.0)
    sim.start_plan(p, [("baby", "home")])


# --- health ------------------------------------------------------------------------------------------------

def _health(sim, p, rr, day: int) -> None:
    life = p.life
    t = sim.clock.tick
    # Recovery.
    for c in list(life.conditions):
        if c.until <= t:
            life.conditions.remove(c)
            _event(sim, p, f"{p.name} has got over {LABELS.get(c.id, c.id)}.", "recovered")
    if life.conditions:
        p.health = min(p.health, ILL_CAP)
    # Onset: one roll on the sum of the acute rates, then a plain draw by weight (life.md 5.5).
    if not life.conditions and life.ward_until == 0:
        season = SEASON_INDEX[sim.clock.season]
        weights = []
        total = 0.0
        for row in ACUTE:
            w = row[1] * row[4][season] * (row[2] if p.age < ADULT_AGE else row[3] if p.age >= 65 else 1.0)
            weights.append(w)
            total += w
        heart = life_tables.HEART_YEAR[min(p.age, life_tables.AGE_MAX)] \
            * life_tables.MULT_UNTREATED[min(_untreated(p), 6)]
        for _, share, _label in HEART:
            weights.append(heart * share)
            total += heart * share
        if _hit(sim, p, "ill", total * PACE["health"] / YEAR_DAYS, -1, rr):
            x = rr.random() * total
            i = 0
            while i < len(weights) - 1 and x >= weights[i]:
                x -= weights[i]
                i += 1
            if i < len(ACUTE):
                _fall_ill(sim, p, ACUTE[i], rr)
            else:
                _heart(sim, p, HEART[i - len(ACUTE)], rr)
    # Catching it at home (life.md 5.5: home .08/.15/.10 a day while a housemate is contagious).
    if not life.conditions and life.ward_until == 0:
        for m in _members(sim, p):
            if m is p or m.life is None:
                continue
            c = next((c for c in m.life.conditions if c.contagious_until > t), None)
            if c is not None:
                row = next((r for r in ACUTE if r[0] == c.id), None)
                if row is not None and row[9] > 0 and _hit(sim, p, "catch", row[9], -1, rr):
                    _fall_ill(sim, p, row, rr)
                break
    # Chronic onset (permanent).
    if p.age >= 30 and len(life.chronic) < len(CHRONIC):
        if _hit(sim, p, "chronic", life_tables.CHRONIC_YEAR[min(p.age, life_tables.AGE_MAX)] / YEAR_DAYS, -1, rr):
            left = [c for c in CHRONIC if c not in life.chronic]
            cid = left[int(rr.random() * len(left))]
            life.chronic.append(cid)
            treated = rr.random() < 0.4 + 0.5 * _traits(p)["health"]
            if treated:
                life.treated.append(cid)
            _event(sim, p, f"{p.name} is diagnosed with {LABELS[cid]}" + (" and starts treatment." if treated
                                                                           else "."), "chronic")
    # Mortality (life.md 5.5): daily, luck -1.
    q = life_tables.DEATH_YEAR[min(p.age, life_tables.AGE_MAX)] * PACE["death"] / YEAR_DAYS \
        * life_tables.MULT_UNTREATED[min(_untreated(p), 6)] * life_tables.MULT_TREATED[min(len(life.treated), 6)]
    if p.health < LOW_HEALTH:
        q *= 3
    heart_ward = life.ward_until > t and any(c.id in ("heart_attack", "stroke") for c in life.conditions)
    if heart_ward:
        q *= 10
    if _hit(sim, p, "death", q, -1, rr):
        die(sim, p, _cause(p, heart_ward))


def _untreated(p) -> int:
    return len([c for c in p.life.chronic if c not in p.life.treated])


def _cause(p, heart_ward: bool) -> str:
    if heart_ward:
        return "died in hospital after a heart attack"
    if p.life.chronic and p.age >= 50:
        return "died after a long illness"
    if p.age >= 80:
        return "passed away peacefully in their sleep"
    if p.age < 40:
        return "died in a road accident"
    return "died suddenly"


def _fall_ill(sim, p, row, rr) -> None:
    cid, days, off, hit, contagious = row[0], row[5], row[6], row[7], row[8]
    t = sim.clock.tick
    d = rr.int(days[0], days[1])
    if cid == "back_pain" and p.job is not None and _manual(sim, p):
        off = BACK_PAIN_MANUAL
    o = rr.int(off[0], off[1])
    doctor = cid != "cold" and rr.random() < 0.3 + 0.5 * _traits(p)["health"]
    if doctor:
        d = max(1, int(d * DOCTOR_DAYS + 0.5))
        o = min(o, d)
    c = Condition(cid, t, t + d * DAY, t + o * DAY, t + contagious * DAY, hit, doctor)
    p.life.conditions.append(c)
    p.health = max(1.0, p.health - hit)
    _event(sim, p, f"{p.name} comes down with {LABELS[cid]}.", "ill", importance=0 if cid == "cold" else None)
    if doctor:
        _see_doctor(sim, p)
    if cid == "fracture":
        hospitalise(sim, p, 1, "a broken bone")


def _heart(sim, p, row, rr) -> None:
    cid = row[0]
    t = sim.clock.tick
    d = rr.int(HEART_DAYS[0], HEART_DAYS[1])
    c = Condition(cid, t, t + d * DAY, t + d * DAY, t, HEART_HEALTH, True)
    p.life.conditions.append(c)
    p.health = max(1.0, p.health - HEART_HEALTH)
    hospitalise(sim, p, rr.int(HEART_WARD[0], HEART_WARD[1]), LABELS[cid])
    if _hit(sim, p, "heart_fatal", HEART_FATAL * DOCTOR_COMPLICATIONS, -1, rr):
        die(sim, p, f"died after {LABELS[cid]}")


def _manual(sim, p) -> bool:
    place = sim.town.places.get(p.job.place_id)
    return place is not None and place.kind == "works"


def _see_doctor(sim, p) -> None:
    """A doctor's visit ($40): a named who is free goes to Millbrook's hospital; anyone else is seen without a
    trip on the map (a phone or a home visit)."""
    payer = _payer(sim, p, DOCTOR_FEE)
    payer.money -= DOCTOR_FEE
    if _named(sim, p):
        _event(sim, p, f"{p.name} sees a doctor.", "doctor")
        if p.state == "idle" and not p.plan and p.fork_id is None and p.age >= FORK_AGE:
            sim.start_plan(p, [("doctor", _hospital_id(sim, p))])


def _payer(sim, p, cost: float):
    """Who pays `p`'s bill: an adult pays their own; a child's goes to the household's richest adult."""
    if p.is_adult or cost <= max(p.money, 0):
        return p
    adults = [m for m in _members(sim, p) if m.is_adult]
    best = None
    for a in adults:
        if best is None or a.money > best.money:
            best = a
    return best if best is not None else p


def note_injury(sim, p, health_lost: float) -> None:
    """A v2 outcome costing 8+ health starts a sprain (7-14 days, 0-3 off), if nothing acute is on."""
    if health_lost < 8 or p.life.conditions:
        return
    rr = _stream(sim, "DAY_HEALTH", p.id, "sprain", sim.clock.tick)
    t = sim.clock.tick
    d = rr.int(SPRAIN[0][0], SPRAIN[0][1])
    o = rr.int(SPRAIN[1][0], SPRAIN[1][1])
    p.life.conditions.append(Condition("sprain", t, t + d * DAY, t + o * DAY, t, int(health_lost)))


def hospitalise(sim, p, days: int, why: str) -> None:
    """Take `p` to hospital for `days` (life.md 5.5): a named by ambulance to Millbrook's hospital, staying in the
    `ward` until `ward_until`; a townsperson through `folk.hospitalise`. $60 a day, paid at the discharge."""
    t = sim.clock.tick
    life = p.life
    if life.ward_until > t:
        return
    if not _named(sim, p):
        life.ward_until = t + days * DAY
        _folk().hospitalise(sim, p, days)
        _event(sim, p, f"{p.name} is taken to hospital ({why}).", "hospital", importance=1)
        _agenda(sim, life.ward_until, "discharge", p.id, days)
        return
    if days <= 1 and why == "very unwell":
        # v2's ambulance for health below 25 (sim._next): an afternoon on the `hospital` activity, its $50 fee paid
        # by sim._end_activity.
        sim.event(f"{p.name} feels very unwell, and an ambulance takes them to "
                  f"{sim.town.places['hospital'].name}.", p, tag="hospital")
        sim.start_plan(p, [("hospital", "hospital")], "ambulance")  # free; the hospital's fee stays
        return
    if p.trip is not None or p.riding is not None:
        _agenda(sim, t + 10, "hospital", p.id, (days, why))  # off the bus first
        return
    sim._withdraw_fork(p)
    life.ward_until = t + days * DAY
    place_id = _hospital_id(sim, p)
    sim.event(f"{p.name} feels very unwell, and an ambulance takes them to "
              f"{_place_name(sim, place_id)} ({why}).", p, tag="hospital")
    sim.start_plan(p, [("ward", place_id)], "ambulance")
    _agenda(sim, life.ward_until, "discharge", p.id, days)


def _discharge(sim, p, days: int) -> None:
    if p.life.ward_until == 0:
        return
    p.life.ward_until = 0
    fee = WARD_FEE * days
    payer = _payer(sim, p, fee)
    payer.money -= fee
    if _named(sim, p):
        by = "" if payer is p else f" by {payer.name.split()[0]}"
        sim.event(f"{p.name} leaves {_place_name(sim, 'hospital')} (paid ${fee:,.0f}{by}).", p, tag="discharged")


def max_health(p) -> float:
    """The most health `p` heals to: 100, less .8 a year past 55 and 5 for each chronic condition."""
    life = getattr(p, "life", None)
    n = len(life.chronic) if life is not None else 0
    return 100.0 - max(0, p.age - FRAIL_AGE) * FRAIL_RATE - CHRONIC_HEALTH * n


def can_work(sim, p) -> bool:
    """False while an illness keeps `p` off work or school, or in hospital."""
    life = getattr(p, "life", None)
    if life is None:
        return True
    if life.ward_until > 0:
        return False
    t = sim.clock.tick
    for c in life.conditions:
        if c.off_until > t:
            return False
    return True


def in_hospital(p) -> bool:
    life = getattr(p, "life", None)
    return life is not None and life.ward_until > 0


def ill(a) -> bool:
    life = getattr(a, "life", None)
    return bool(life and life.conditions)


def stage(a) -> str:
    age = a.age
    return "baby" if age < 3 else "child" if age < 13 else "teen" if age < 18 else "adult" if age < 65 else "senior"


def infect(sim, a, b) -> None:
    """A talk between `a` and `b` (L1's social.tick): a contagious cold passes at .03, flu at .06 (luck -1)."""
    for src, dst in ((a, b), (b, a)):
        if dst.life is None or dst.life.conditions or src.life is None or dst.life.ward_until:
            continue
        c = next((c for c in src.life.conditions if c.contagious_until > sim.clock.tick), None)
        if c is None or c.id not in ("cold", "flu"):
            continue
        rr = _stream(sim, "DAY_HEALTH", dst.id, "talk", sim.clock.tick)
        if _hit(sim, dst, "catch", 0.03 if c.id == "cold" else 0.06, -1, rr):
            _fall_ill(sim, dst, next(r for r in ACUTE if r[0] == c.id), rr)


# --- death ---------------------------------------------------------------------------------------------------

def die(sim, p, how: str) -> None:
    """Every death goes through here: a named through `sim._die` (whose last line calls `on_death`), a townsperson
    through `folk.kill`, its death event and `on_death`."""
    if not p.alive:
        return
    if _named(sim, p):
        sim._die(p, how)
        on_death(sim, p)  # a no-op once sim._die has called it (the hooks)
        return
    _folk().kill(sim, p, how)
    loved = False
    for oid, r in p.relationships.items():
        o = _person(sim, oid)
        if o is not None and o.alive and _named(sim, o) and r.affinity >= 40:
            loved = True
    _event(sim, p, f"{p.name} {how}, aged {p.age}.", "death", importance=2 if loved else 1)
    on_death(sim, p)


def on_death(sim, p) -> None:
    """After a death: the slot is freed (reopening 7-30 days later), a partner is widowed, friends grieve (folk
    too: v2's grief in `sim._die` covers named friends of a named), loans close, the agenda forgets them. Runs
    once per death."""
    lc = sim.life
    life = p.life
    if life is None:
        return
    ids = lc.by_slot.get(life.slot, [])
    if p.id not in ids:
        return
    ids.remove(p.id)
    lc.counts["deaths"] += 1
    day = sim.clock.day
    rr = _stream(sim, "DAY_CAREER", p.id, "death", day)
    if p.job is not None and getattr(p.job, "slot", -1) >= 0:
        b = lc.board
        if b.holder[p.job.slot] == p.id:
            b.free(p.job.slot, day + rr.int(career.REOPEN_DAYS[0], career.REOPEN_DAYS[1]))
    named = _named(sim, p)
    for oid, rel in p.relationships.items():
        other = _person(sim, oid)
        if other is None or not other.alive or other.life is None:
            continue
        if getattr(rel.kind, "value", rel.kind) == "partner":
            other.life.widowed_day = day
            other.life.grief_until = day + GRIEF_DAYS
        if rel.affinity > 30 and not (named and _named(sim, other)):
            other.adjust("fun", -40)
            other.adjust("social", -20)
            other.remember(sim.clock.stamp(), f"Lost {p.name}.")
    lc.loans = [row for row in lc.loans if row.get("lender") != p.id and row.get("borrower") != p.id]
    for t in list(lc.agenda):
        rows = [row for row in lc.agenda[t] if row[1] != p.id]
        if rows:
            lc.agenda[t] = rows
        else:
            del lc.agenda[t]
    life.pregnant = None
    life.ward_until = 0


# --- births and family -----------------------------------------------------------------------------------------

def _family(sim, p, day: int) -> None:
    """Wanting a child (every 30 days) and conception (daily, no luck) for a partnered woman 20-44; a new baby's
    parents tire."""
    life = p.life
    if p.is_adult and _named(sim, p) and any(c.age == 0 for c in _children(sim, p)):
        p.adjust("energy", -BABY_ENERGY)  # named parents of a newborn (folk needs are folk's own)
    if life.pregnant is not None or not (20 <= p.age < 45) or _sex(p) != "f":
        return
    other = _partner(sim, p)
    if other is None or other.age < ADULT_AGE:
        if life.trying:
            life.trying = False
        return
    rr = _stream(sim, "BIRTH", p.id, day)
    if day % WANT_EVERY == life.slot % WANT_EVERY:
        younger = min(p.age, other.age)
        family = (_traits(p)["family"] + _traits(other)["family"]) / 2
        life.trying = 20 <= younger <= 44 and rr.random() < min(0.9, 1.2 * family) and _can_afford_child(sim, p)
    if not life.trying:
        return
    b = 0.0
    for under, rate in CONCEPTION:
        if p.age < under:
            b = rate
            break
    n = min(len(_children(sim, p)), 3)
    if rr.random() < b * CHILDREN_MULT[n] * PACE["birth"] / YEAR_DAYS:
        _conceive(sim, p, other, day + PREGNANCY_DAYS)


def _can_afford_child(sim, p) -> bool:
    """Funds of at least 4 weeks' outgo (named households; folk: their own money)."""
    from . import housing

    if not _named(sim, p):
        return p.money + p.savings > 0
    hh = sim.households[p.household_id]
    return housing.funds(sim, hh) >= 4 * housing.weekly_outgo(sim, hh)


def birth(sim, mother, other) -> None:
    """A baby is born to `mother` (`other`: the other parent's id or None): a named mother's baby is a named
    Agent (life.md 5.6), a townswoman's comes from `folk.add_baby`."""
    lc = sim.life
    father = _person(sim, other) if other else None
    lc.counts["births"] += 1
    if not _named(sim, mother):
        baby = _folk().add_baby(sim, mother, father)
        loved = False
        for oid, r in mother.relationships.items():
            o = _person(sim, oid)
            if o is not None and _named(sim, o) and getattr(r.kind, "value", r.kind) == "family":
                loved = True
        name = baby.name.split()[0] if baby is not None else "a baby"
        _event(sim, mother, f"{mother.name} has a baby: {name}.", "birth", importance=2 if loved else 1,
               agents=[baby.id] if baby is not None else None)
        return
    baby = _named_baby(sim, mother, father)
    with_ = f" and {father.name}" if father is not None else ""
    sim.event(f"{mother.name}{with_} welcome a baby, {baby.name}.", mother, tag="birth",
              agents=[baby.id] + ([father.id] if father is not None else []))


def _named_baby(sim, mother, father):
    """A new named Agent in the mother's household, at its home's entry (life.md 5.6)."""
    from . import cast
    from .agent import Agent, Profile, RelationKind
    from .rng import r2

    rr = _stream(sim, "NAME", mother.id, sim.clock.day)
    female = rr.random() < 0.5
    used = {a.name.split()[0] for a in sim.agents.values()}
    pool = [n for n in (cast.FEMALE if female else cast.MALE) if n not in used] \
        or list(cast.FEMALE if female else cast.MALE)
    first = rr.pick(pool)
    surname = (father if father is not None and _named(sim, father) else mother).name.split()[-1]
    bid = first.lower()
    if bid in sim.agents:
        bid = f"{first}_{surname}".lower().replace("-", "_")
    n = 2
    while bid in sim.agents:
        bid = f"{first}_{surname}_{'x' * n}".lower()
        n += 1
    ta, tb = _traits(mother), _traits(father if father is not None else mother)
    traits = {}
    for k in Profile.TRAITS:
        traits[k] = r2(max(0.0, min(1.0, (ta[k] + tb[k]) / 2 + rr.uniform(-0.1, 0.1))))
    hh = sim.households[mother.household_id]
    place = sim.town.places[sim.homes[hh.home_id].place]
    baby = Agent(id=bid, name=f"{first} {surname}", age=0, household_id=hh.id, money=0.0, job=None,
                 owns_car=False, x=place.entry[0], y=place.entry[1], inside=place.id, profile=Profile(traits))
    baby.sex = "f" if female else "m"
    for m in _members(sim, mother):
        if m.id in sim.agents:
            m.relate(bid, RelationKind.FAMILY, FAMILY_AFFINITY)
            baby.relate(m.id, RelationKind.FAMILY, FAMILY_AFFINITY)
    sim.agents[bid] = baby
    hh.member_ids.append(bid)
    init_person(sim, baby)
    baby.life.jobless_since = None
    return baby


def split(sim, p) -> bool:
    """A named leaves their household after a split (life.md 5.3): the cheapest vacant rental as a new household
    (`housing.new_household`), else a parent's household elsewhere; named never leave town. False when there is
    nowhere to go."""
    from . import housing

    old = sim.households[p.household_id]
    leaving = [p] + [k for k in _children(sim, p) if _partner(sim, p) is None]
    home = housing.cheapest_rental(sim, old)
    if home is not None and housing.new_household(sim, leaving, home.id, "rent") is not None:
        return True
    for oid, rel in p.relationships.items():
        o = sim.agents.get(oid)
        if (o is not None and o.alive and getattr(rel.kind, "value", rel.kind) == "family" and o.age > p.age
                and o.household_id != p.household_id):
            old.member_ids.remove(p.id)
            p.household_id = o.household_id
            sim.households[o.household_id].member_ids.append(p.id)
            return True
    return False


# --- pages -------------------------------------------------------------------------------------------------

def _partner_row(sim, p) -> dict | None:
    for oid, rel in p.relationships.items():
        kind = getattr(rel.kind, "value", rel.kind)
        if kind in ("partner", "dating"):
            other = _person(sim, oid)
            if other is None or not other.alive:
                continue
            since = getattr(rel, "since", 0) or 0
            return {"id": oid, "name": other.name, "kind": kind, "married": bool(getattr(rel, "married", False)),
                    "days": max(0, (sim.clock.tick - since) // DAY)}
    return None


def _debt(p) -> int:
    return int(max(0.0, -(p.money + p.savings)))


def page(sim, p) -> dict:
    """The `life` block of a character page (life.md 8.1)."""
    life = p.life
    t = sim.clock.tick
    partner = _partner_row(sim, p)
    kids = []
    friends, rivals = 0, []
    for oid, rel in p.relationships.items():
        kind = getattr(rel.kind, "value", rel.kind)
        o = _person(sim, oid)
        if o is None:
            continue
        if kind == "family" and o.age < p.age - 14:
            kids.append({"id": oid, "name": o.name, "age": o.age})
        elif kind == "friend" and o.alive:
            friends += 1
        elif kind == "rival" and o.alive:
            rivals.append({"id": oid, "name": o.name})
    conds = [{"id": c.id, "label": LABELS.get(c.id, c.id), "days_left": max(0, -(-(c.until - t) // DAY)),
              "off_work": c.off_until > t} for c in life.conditions]
    preg = None
    if life.pregnant is not None:
        other = _person(sim, life.pregnant[1]) if life.pregnant[1] else None
        preg = {"with": life.pregnant[1], "name": other.name if other is not None else None,
                "days_left": max(0, life.pregnant[0] - sim.clock.day)}
    day = sim.clock.day
    loans = []
    for row in sim.life.loans:
        if row.get("lender") == p.id or row.get("borrower") == p.id:
            lent = row.get("lender") == p.id
            oid = row["borrower"] if lent else row["lender"]
            o = _person(sim, oid)
            loans.append({"id": row["id"], "with": oid, "name": o.name if o is not None else oid,
                          "dir": "lent" if lent else "borrowed", "amount": int(row["amount"])})
    return {"stage": stage(p), "birthday": life.birthday, "partner": partner, "children": kids, "friends": friends,
            "rivals": rivals, "conditions": conds, "chronic": list(life.chronic), "pregnant": preg,
            "work": {"standing": int(p.reputation + 0.5), "warnings": life.warnings,
                     "days_in_job": day - life.job_since if p.job is not None else None,
                     "jobless_days": day - life.jobless_since if life.jobless_since is not None else None,
                     "benefit": career.benefit(sim, p) > 0},
            "money": {"lifestyle": int(life.lifestyle + 0.5), "debt": _debt(p), "loans": loans},
            "talks": [dict(x) for x in life.talks] if life.talks and isinstance(life.talks[0], dict) else []}


def fork_you(sim, agent) -> dict:
    """`you.life` in a fork message (life.md 8.2)."""
    life = agent.life
    partner = _partner_row(sim, agent)
    kids = sum(1 for oid, rel in agent.relationships.items()
               if getattr(rel.kind, "value", rel.kind) == "family" and _person(sim, oid) is not None
               and _person(sim, oid).age < agent.age - 14)
    return {"partner": {k: partner[k] for k in ("id", "name", "kind", "married")} if partner else None,
            "children": kids, "conditions": [LABELS.get(c.id, c.id) for c in life.conditions],
            "standing": int(agent.reputation + 0.5),
            "jobless_days": sim.clock.day - life.jobless_since if life.jobless_since is not None else None,
            "debt": _debt(agent)}


def stats_block(sim) -> dict:
    """`stats.city.life` (life.md 8.2), all ints."""
    from . import people

    ill_now = in_hosp = jobless = in_debt = partnered = 0
    for p in people.everyone(sim):
        life = p.life
        if life is None:
            continue
        if life.conditions:
            ill_now += 1
        if life.ward_until:
            in_hosp += 1
        if p.is_adult and p.age < 65 and p.job is None and life.jobless_since is not None:
            jobless += 1
        if p.is_adult and p.money + p.savings < 0:
            in_debt += 1
        if _partner_row(sim, p) is not None:
            partnered += 1
    lc = sim.life
    return {"ill_now": ill_now, "in_hospital": in_hosp, "couples": partnered // 2, "births": lc.counts["births"],
            "deaths": lc.counts["deaths"], "jobless": jobless, "in_debt": in_debt,
            "talks_today": lc.today["talks"], "friendships_today": lc.today["new_friend"]}

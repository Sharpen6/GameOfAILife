"""The life course for both tiers (life.md 5.5-5.9): illness, doctors and hospital stays, death, pregnancy and
births, babies and birthdays, splits and widowing.

Every person (a named Agent or a folk Person) holds a `LifeState` in `p.life`; the city holds a `LifeCity` in
`sim.life`. Each person's daily rolls run once a game day in their own slot minute (`LifeState.slot`), so the work
is spread over the day; things due at a set time (a birth at 08:00, a bill) wait in `sim.life.agenda`. Dice come
from `dice.stream(sim.dice_seed, NS, id, day)`, never `sim.rng`; every luck-shifted roll goes through
`people.log_roll`.

v3-skel-life: every function F3's hooks call exists with its final signature and v2's behaviour.
"""

from __future__ import annotations

from collections import Counter, deque
from dataclasses import dataclass, field

from . import career

FORK_AGE = 5  # under this age a named child gets no forks: `toddle` runs their day
PACE = {"health": 1.0, "death": 1.0, "birth": 2.5, "romance": 2.0, "career": 2.0}  # life.md 3.4, a 360-day year
YEAR_DAYS = 360
DAY = 24 * 60
LUCK_LOG_SIZE = 5000


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
    agenda: dict = field(default_factory=dict)  # tick -> [entry]
    loans: list = field(default_factory=list)
    counts: Counter = field(default_factory=Counter)
    today: Counter = field(default_factory=Counter)
    yesterday: Counter = field(default_factory=Counter)
    luck_log: deque = field(default_factory=lambda: deque(maxlen=LUCK_LOG_SIZE))


def _sid(x) -> int:
    """dice.sid (L1's dice.py): ints as themselves, ASCII strings by FNV-1a 32."""
    try:
        from . import dice
    except ImportError:
        dice = None
    if dice is not None:
        return dice.sid(x)
    if isinstance(x, int):
        return x & 0xFFFFFFFF
    h = 0x811C9DC5
    for ch in x:
        h = ((h ^ ord(ch)) * 0x01000193) & 0xFFFFFFFF
    return h


# --- setup ---------------------------------------------------------------------------------------------

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
    for p in _everyone(sim):
        init_person(sim, p)
    seed_story(sim)


def init_person(sim, p) -> None:
    """Give a person (named, folk, newcomer or newborn) a LifeState and a daily slot."""
    h = _sid(p.id)
    p.life = LifeState(birthday=h % YEAR_DAYS, slot=h % 1380, review_day=h % 90)
    if p.job is not None:
        p.life.last_wage = p.job.hourly_wage
    sim.life.by_slot.setdefault(p.life.slot, []).append(p.id)


def seed_story(sim) -> None:
    """The start (life.md 5.9). Skeleton: L1's social half only."""
    try:
        from . import social
    except ImportError:
        social = None
    fn = getattr(social, "seed_story", None)
    if fn is not None:
        fn(sim)


def _everyone(sim) -> list:
    """Living named in cast order, then living folk (people.everyone once L1's contract lands)."""
    try:
        from . import people
    except ImportError:
        people = None
    fn = getattr(people, "everyone", None)
    if fn is not None:
        return fn(sim)
    return [a for a in sim.agents.values() if a.alive]


# --- the clock -------------------------------------------------------------------------------------------

def tick(sim) -> None:
    """Each tick: the daily rolls of the people whose slot is this minute, and the agenda. Skeleton: nothing."""
    return None


def legacy_ageing(sim) -> None:
    """v2's old-age roll and yearly birthday (v3-fixes sim.py `_new_day`, lines 316-326), with `self` -> `sim`
    and the same `sim.rng` order. Emptied when birthdays and mortality land."""
    from .clock import DAYS_PER_SEASON, SEASONS
    from .forks import luck_odds

    for agent in sim.living():
        # Old age: a small daily chance from 70, which Luck softens.
        if agent.age >= 70:
            # About 0.75% a month at 74 and 3.6% at 80 (at Luck 50), so a death in the first weeks is rare.
            p = luck_odds(0.00001 * (agent.age - 69) ** 2, -1, agent.luck)
            sim._log_roll(agent, "old_age", p, roll := sim.rng.random())
            if roll < p:
                sim._die(agent, "passed away peacefully in their sleep")
    if sim.clock.day % (DAYS_PER_SEASON * len(SEASONS)) == 0 and sim.clock.day:
        for agent in sim.living():
            agent.age += 1


def toddle(sim, p) -> None:
    """An under-5's next step (no forks): a day at home doing `baby`, needs held at 75."""
    for n in p.needs:
        p.needs[n] = max(p.needs[n], 75.0)
    sim.start_plan(p, [("baby", "home")])


# --- health ------------------------------------------------------------------------------------------------

def hospitalise(sim, p, days: int, why: str) -> None:
    """Take `p` to hospital for `days`. Skeleton: v2's health < 25 ambulance (sim.py lines 397-399)."""
    sim.event(f"{p.name} feels very unwell, and an ambulance takes them to "
              f"{sim.town.places['hospital'].name}.", p, tag="hospital")
    sim.start_plan(p, [("hospital", "hospital")], "ambulance")  # free; the hospital's fee stays


def max_health(p) -> float:
    """The most health `p` heals to. Skeleton: 100."""
    return 100.0


def can_work(sim, p) -> bool:
    """False while an illness keeps `p` off work or school, or in hospital. Skeleton: True."""
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
    """A talk between `a` and `b` (L1's social.tick): a contagious condition may pass. Skeleton: nothing."""
    return None


# --- death, births and households ----------------------------------------------------------------------------

def die(sim, p, how: str) -> None:
    """Every death goes through here: a named through `sim._die` (which then calls `on_death`), a townsperson
    through `folk.kill` and then `on_death`."""
    if p.id in sim.agents:
        sim._die(p, how)
    else:
        from . import folk

        folk.kill(sim, p, how)
        on_death(sim, p)


def on_death(sim, p) -> None:
    """After a death (`sim._die`'s last line, or `die` for a townsperson): widowing and grief, the job slot, loans,
    the agenda. Skeleton: nothing (v2's grief stays in `_die`)."""
    return None


def birth(sim, mother, other) -> None:
    """A baby is born to `mother` (and `other`, the other parent's id or None). Skeleton: nothing."""
    return None


def split(sim, p) -> bool:
    """A named leaves their household after a split (life.md 5.3). Skeleton: nothing."""
    return False


# --- pages -------------------------------------------------------------------------------------------------

def page(sim, p) -> dict:
    """The `life` block of a character page (life.md 8.1)."""
    return {"stage": stage(p), "birthday": p.life.birthday if getattr(p, "life", None) else None,
            "partner": None, "children": [], "friends": 0, "rivals": [], "conditions": [], "chronic": [],
            "pregnant": None,
            "work": {"standing": round(p.reputation), "warnings": 0, "days_in_job": None, "jobless_days": None,
                     "benefit": False},
            "money": {"lifestyle": 0, "debt": 0, "loans": []}, "talks": []}


def fork_you(sim, agent) -> dict:
    """`you.life` in a fork message (life.md 8.2)."""
    return {"partner": None, "children": 0, "conditions": [], "standing": round(agent.reputation),
            "jobless_days": None, "debt": 0}


def stats_block(sim) -> dict:
    """`stats.city.life` (life.md 8.2), all ints."""
    return {"ill_now": 0, "in_hospital": 0, "couples": 0, "births": 0, "deaths": 0, "jobless": 0, "in_debt": 0,
            "talks_today": 0, "friendships_today": 0}

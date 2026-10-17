"""City statistics: God's `stats` push (PLAN 3.8), its hourly samples, the decision counters and the LLM log.

One CityStats belongs to each Simulation (`sim.stats`). The simulation counts every fork it asks a
controller about and how each fork was decided; `today` restarts at midnight, `total` never does. On every
whole game hour `sample(sim)` records one sample of the city (7 days are kept), each person's worth (25
hours are kept, for the 24 h change) and checks who is the richest person in town.

`stats_json(sim, full)` builds the `stats` message and `decisions(sim, ...)` the `get_decisions` reply. Both
only read the city, never change it, and carry no odds, rolls, scores, outcome tables or valence.

Portability (the JS port is a line-by-line copy): every number is rounded with floor(x + 0.5), never
Python's banker's round; ties sort by id in code-unit order; rings are lists, oldest first. `sim.py` imports
this module, so it loads nothing from the engine (tests/test_seams.py): the builders import `housing` and
`town` when they run, by which time the simulation has loaded both.
"""

from __future__ import annotations

import math
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .agent import Agent
    from .sim import Simulation

# The decision counters, as in the `stats.llm.today` and `stats.llm.total` blocks:
#   asked          forks sent to a controller
#   in_time        answered within the deadline (count with the answer's seconds)
#   timeouts       no answer in time: the profile default played
#   late           answered after the deadline but in time to teach the profile
#   withdrawn      asked, then withdrawn (the character or the host died)
#   against_habit  in-time answers that differ from the profile's own first choice
#   habit, default forks nobody was asked about, decided by habit or by the profile
COUNTERS = ("asked", "in_time", "timeouts", "late", "withdrawn", "against_habit", "habit", "default")
SHOWN_COUNTERS = ("asked", "in_time", "timeouts", "late", "withdrawn", "against_habit")  # in llm.today and total

# A fork summary's `decided_by` -> the counter its decision adds to.
DECIDED_BY = {"habit": "habit", "default": "default", "model": "in_time", "timeout": "timeouts",
              "withdrawn": "withdrawn"}

SAMPLES_KEPT = 168  # hourly samples: 7 game days
WORTH_HOURS = 25  # each person's worth at the last 25 whole hours, so the oldest is 24 hours ago
RICHEST_GAIN, RICHEST_MARGIN = 0.02, 50  # a challenger needs the richest person's worth x 1.02 + $50 to take over
TOWN = "Millbrook"
RECENT_DEATHS = 5
LOG_DECIDERS = ("model", "timeout")  # the LLM log: forks a controller was asked about and answered or missed
DECISIONS_LIMIT, DECISIONS_MAX = 30, 100  # get_decisions: forks per page by default, and at most


def _zeros() -> dict:
    """A fresh counter block: every counter at 0, plus `seconds`, the summed seconds of in-time answers."""
    block: dict = {name: 0 for name in COUNTERS}
    block["seconds"] = 0.0
    return block


def avg_seconds(block: dict) -> float | None:
    """Mean seconds of a block's in-time answers to one decimal (floor(x * 10 + 0.5) / 10), or None."""
    if not block["in_time"]:
        return None
    return math.floor(block["seconds"] / block["in_time"] * 10 + 0.5) / 10


# --- number rules ------------------------------------------------------------------------------------------

def _int(x: float) -> int:
    """Portable rounding to an integer: floor(x + 0.5), as JS Math.round."""
    return math.floor(x + 0.5)


def _mean(xs: list[float]) -> float:
    """The mean, or 0 for an empty list."""
    return sum(xs) / len(xs) if xs else 0.0


def median(xs: list[float]) -> float:
    """The middle value; the mean of the two middle values for an even count; 0 for none."""
    s = sorted(xs)
    n = len(s)
    if not n:
        return 0.0
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2


def gini(xs: list[float]) -> float:
    """The Gini coefficient to two decimals, negatives clipped to 0: 2 * sum(i * x_i) / (n * sum x) - (n + 1) / n
    with x ascending and i from 1. 0 when nobody has anything."""
    s = sorted(max(0.0, x) for x in xs)
    n, total = len(s), sum(s)
    if not n or total <= 0:
        return 0.0
    g = 2 * sum((i + 1) * x for i, x in enumerate(s)) / (n * total) - (n + 1) / n
    return math.floor(g * 100 + 0.5) / 100


def top_share(xs: list[float]) -> int:
    """Percent of the positive wealth held by the richest ceil(n / 10): 0 when nobody has anything."""
    s = sorted((max(0.0, x) for x in xs), reverse=True)
    total = sum(s)
    if total <= 0:
        return 0
    k = -(-len(s) // 10)
    return _int(100 * sum(s[:k]) / total)


def _money(x: int) -> str:
    return f"{'−' if x < 0 else ''}${abs(x):,}"


# --- who is who ----------------------------------------------------------------------------------------------

class _Person:
    """One living person's worth parts, in whole dollars (housing.worth_parts)."""

    __slots__ = ("agent", "cash", "savings", "home", "worth")

    def __init__(self, sim: Simulation, agent: Agent, parts: dict):
        self.agent = agent
        self.cash, self.savings, self.home = parts["cash"], parts["savings"], parts["home"]
        self.worth = self.cash + self.savings + self.home


def _people(sim: Simulation) -> list[_Person]:
    """Every living person, richest first, ties by id."""
    from . import housing  # here, not at the top: see the module docstring
    rows = [_Person(sim, a, housing.worth_parts(sim, a)) for a in sim.living()]
    rows.sort(key=lambda p: (-p.worth, p.agent.id))
    return rows


def _district_of_place(sim: Simulation) -> dict[str, str]:
    return {p.id: p.district for p in sim.town.places.values()}


def _homes_at(sim: Simulation) -> dict[str, list]:
    """Residential place id -> its homes (one for a house, six for a block of flats)."""
    out: dict[str, list] = {}
    for h in sim.homes.values():
        out.setdefault(h.place, []).append(h)
    return out


# --- the stats message (PLAN 3.8) -----------------------------------------------------------------------------

def _wealth_block(people: list[_Person]) -> dict:
    adults = [p.worth for p in people if p.agent.is_adult]
    return {"total": sum(p.worth for p in people), "median": _int(median(adults)), "top10_share": top_share(adults),
            "gini": gini(adults),
            "in_debt": sum(1 for p in people if p.agent.is_adult and p.cash + p.savings < 0)}


def _homes_block(sim: Simulation) -> dict:
    from . import housing
    homes = list(sim.homes.values())
    by_stage = [0] * len(housing.STAGES)
    lived_in = {h.place for h in homes if h.household is not None}
    neglected = 0
    for pid, lot in sim.lots.items():
        st = housing.stage_of(lot.condition)
        by_stage[st] += 1
        if st >= 3 and pid in lived_in:
            neglected += 1
    listings = [housing.listed(sim, h) for h in homes]
    return {"total": len(homes),
            "owned": sum(1 for h in homes if h.household is not None and h.owner == h.household),
            "rented": sum(1 for h in homes if h.household is not None and h.owner != h.household),
            "for_sale": listings.count("for_sale"), "for_rent": listings.count("for_rent"),
            "lots_by_stage": by_stage, "neglected_lived_in": neglected}


def _city_block(sim: Simulation, people: list[_Person]) -> dict:
    alive = [p.agent for p in people]
    adults = [a for a in alive if a.is_adult]
    dead = [a for a in sim.agents.values() if not a.alive]
    died = sorted((a for a in dead if a.died), key=lambda a: (-a.died["tick"], a.id))[:RECENT_DEATHS]
    lucks = [a.luck for a in alive]
    return {
        "population": len(alive), "start_population": len(sim.agents), "deaths": len(dead), "births": 0,  # nobody is born yet
        "adults": len(adults), "children": len(alive) - len(adults),
        "working": sum(1 for a in alive if a.job and a.job.hourly_wage > 0),
        "students": sum(1 for a in alive if a.job and a.job.hourly_wage <= 0),
        "retired": sum(1 for a in alive if not a.job and a.age >= 65),
        "out_of_work": sum(1 for a in adults if not a.job and a.age < 65),
        "mood": _int(_mean([a.mood for a in alive])), "health": _int(_mean([a.health for a in alive])),
        "needs": {n: _int(_mean([a.needs[n] for a in alive])) for n in ("hunger", "energy", "social", "fun")},
        "wealth": _wealth_block(people),
        "homes": _homes_block(sim),
        "luck": {"touched": sum(1 for x in lucks if x != 50), "raised": sum(1 for x in lucks if x > 50),
                 "lowered": sum(1 for x in lucks if x < 50), "mean": _int(_mean(lucks))},
        "recent_deaths": [{"id": a.id, "name": a.name, "age": a.age, "time": a.died["time"], "how": a.died["how"]}
                          for a in died],
    }


def _counter_json(block: dict) -> dict:
    return {**{k: block[k] for k in SHOWN_COUNTERS}, "avg_seconds": avg_seconds(block)}


def _llm_block(sim: Simulation) -> dict:
    alive = sim.living()
    playing = [a for a in alive if a.controller]
    return {
        "controllers": [{"name": name, "model": entry.get("model"),
                         "characters": sum(1 for a in playing if a.controller == name)}
                        for name, entry in sim.controllers.items()],
        "playing": len(playing), "thinking": sum(1 for a in playing if a.state == "deciding"),
        "today": _counter_json(sim.stats.today), "total": _counter_json(sim.stats.total),
        "habit_today": sim.stats.today["habit"], "default_today": sim.stats.today["default"],
    }


def _districts(sim: Simulation, people: list[_Person]) -> list[dict]:
    """Every district with at least one home, in town order."""
    from . import housing
    from .town import DISTRICTS
    district = _district_of_place(sim)
    out = []
    for did, name, _, _ in DISTRICTS:
        homes = [h for h in sim.homes.values() if district.get(h.place) == did]
        if not homes:
            continue
        here = [p for p in people if district.get(sim.homes[sim.households[p.agent.household_id].home_id].place) == did]
        out.append({
            "id": did, "name": name, "people": len(here), "mood": _int(_mean([p.agent.mood for p in here])),
            "median_worth": _int(median([p.worth for p in here if p.agent.is_adult])),
            "homes": len(homes), "vacant": sum(1 for h in homes if h.household is None),
            "shabby_plus": sum(1 for pid, lot in sim.lots.items() if district.get(pid) == did
                               and housing.stage_of(lot.condition) >= 2),
        })
    return out


def _households(sim: Simulation) -> list[dict]:
    """Every household with a living member, in creation order (housing.household_summary rows)."""
    from . import housing
    return [housing.household_summary(sim, hh) for hh in sim.households.values()
            if any(sim.agents[m].alive for m in hh.member_ids)]


def _people_rows(sim: Simulation, people: list[_Person]) -> list[dict]:
    rings = sim.stats.worth
    rows = []
    for p in people:
        a = p.agent
        ring = rings.get(a.id)
        rows.append({"id": a.id, "household": a.household_id, "worth": p.worth,
                     "worth_24h": ring[0] if ring else p.worth, "cash": p.cash, "savings": p.savings,
                     "home_equity": p.home, "job": a.job.title if a.job else None, "health": _int(a.health)})
    return rows


def stats_json(sim: Simulation, full: bool = False) -> dict:
    """The `stats` message (PLAN 3.8).

    full=True (the God welcome and `get_stats`) carries every kept sample. full=False is the push: it carries
    the samples recorded since the previous push, and each sample goes in one push only.
    """
    people = _people(sim)
    samples = list(sim.stats.samples) if full else sim.stats.take_new_samples()
    return {"type": "stats", "full": bool(full), "tick": sim.clock.tick, "time": sim.clock.stamp(),
            "day": sim.clock.day, "city": _city_block(sim, people), "llm": _llm_block(sim),
            "districts": _districts(sim, people), "households": _households(sim),
            "people": _people_rows(sim, people), "samples": samples}


# --- the LLM log ----------------------------------------------------------------------------------------------

def decisions(sim: Simulation, agent_id: str | None = None, before: str | None = None,
              limit: int | None = DECISIONS_LIMIT) -> dict | None:
    """The `get_decisions` reply: decided fork summaries a controller answered or missed, newest first.

    With agent_id, that character's ring (the last 30); otherwise the city's (the last 500). `before` is a
    fork id: only forks older than it (none when it is not in the ring, which only ever drops the oldest).
    `limit` defaults to 30 and is held to 1-100. `more` says whether older forks remain. None for an unknown
    character.
    """
    if limit is None:
        limit = DECISIONS_LIMIT
    if isinstance(limit, bool) or not isinstance(limit, (int, float)) or not math.isfinite(limit):
        raise TypeError("limit must be a number")
    limit = max(1, min(DECISIONS_MAX, int(limit)))
    if before is not None and not isinstance(before, str):
        raise TypeError("before must be a fork id")
    if agent_id is None:
        ring = sim.llm_log
    else:
        agent = sim.agents.get(str(agent_id))
        if agent is None:
            return None
        ring = agent.llm_forks
    forks = [f for f in reversed(ring) if f.get("decided_by") in LOG_DECIDERS]
    if before is not None:
        at = next((i for i, f in enumerate(forks) if f["id"] == before), None)
        forks = forks[at + 1:] if at is not None else []
    return {"type": "decisions", "agent_id": None if agent_id is None else str(agent_id), "forks": forks[:limit],
            "more": len(forks) > limit}


# --- the counters, samples and rings ----------------------------------------------------------------------------

class CityStats:
    """The city's decision counters, hourly samples, worth rings and the richest person's title."""

    def __init__(self) -> None:
        self.today: dict = _zeros()  # since midnight
        self.total: dict = _zeros()  # since the city began
        self.samples: list[dict] = []  # the last SAMPLES_KEPT hourly samples, oldest first
        self.worth: dict[str, list[int]] = {}  # agent id -> worth at the last WORTH_HOURS samples, oldest first
        self.richest: str | None = None  # who holds the title
        self._richest_known = False  # the first sample records the leader without a headline
        self._pushed = -1  # the tick of the newest sample a push has carried
        self._hour_asked = 0  # total asked and in_time at the previous sample
        self._hour_in_time = 0

    def count(self, name: str, seconds: float | None = None) -> None:
        """Add one to a counter, today and in total. `seconds` goes with `in_time` only: the answer time."""
        if name not in COUNTERS:
            raise KeyError(f"unknown counter {name!r}; one of {', '.join(COUNTERS)}")
        if seconds is not None and name != "in_time":
            raise ValueError("only in_time answers carry seconds")
        for block in (self.today, self.total):
            block[name] += 1
            if seconds is not None:
                block["seconds"] += seconds

    def reset_day(self) -> None:
        """Midnight: today's counters start again from 0."""
        self.today = _zeros()

    def take_new_samples(self) -> list[dict]:
        """The samples recorded since the last call, oldest first; each one is handed out once."""
        new = [s for s in self.samples if s["tick"] > self._pushed]
        if new:
            self._pushed = new[-1]["tick"]
        return new

    def sample(self, sim: Simulation) -> None:
        """Called on every whole game hour, after the agents moved: one sample of the city, everyone's worth for
        the 24 h change, and the richest person check. A city with nobody in it records nothing."""
        if not getattr(sim, "agents", None):
            return None
        people = _people(sim)
        city = _city_block(sim, people)
        homes = city["homes"]
        self.samples.append({
            "tick": sim.clock.tick, "day": sim.clock.day, "pop": city["population"], "mood": city["mood"],
            "health": city["health"], "wealth": city["wealth"]["total"], "median": city["wealth"]["median"],
            "top10": city["wealth"]["top10_share"], "in_debt": city["wealth"]["in_debt"], "working": city["working"],
            "owned": homes["owned"], "shabby_plus": sum(homes["lots_by_stage"][2:]),
            "asked": self.total["asked"] - self._hour_asked, "in_time": self.total["in_time"] - self._hour_in_time,
        })
        del self.samples[:-SAMPLES_KEPT]
        self._hour_asked, self._hour_in_time = self.total["asked"], self.total["in_time"]
        for p in people:
            ring = self.worth.setdefault(p.agent.id, [])
            ring.append(p.worth)
            del ring[:-WORTH_HOURS]
        self._check_richest(sim, [p for p in people if p.agent.is_adult])
        return None

    def _check_richest(self, sim: Simulation, adults: list[_Person]) -> None:
        """A new richest adult makes a headline (God-only), with hysteresis: a challenger takes the title only with
        at least RICHEST_GAIN more worth plus RICHEST_MARGIN, or when the title holder has died."""
        if not adults:
            return
        top = adults[0]
        if not self._richest_known:
            self._richest_known = True
            self.richest = top.agent.id
            return
        holder = next((p for p in adults if p.agent.id == self.richest), None)
        if holder is top:
            return
        if holder is not None and top.worth < holder.worth * (1 + RICHEST_GAIN) + RICHEST_MARGIN:
            return
        behind = holder if holder is not None else (adults[1] if len(adults) > 1 else None)
        self.richest = top.agent.id
        text = f"{top.agent.name} is now the richest person in {TOWN} ({_money(top.worth)})"
        text += f", ahead of {behind.agent.name}." if behind is not None else "."
        sim.event(text, top.agent, tag="richest", agents=[behind.agent.id] if behind is not None else None,
                  remember=False)

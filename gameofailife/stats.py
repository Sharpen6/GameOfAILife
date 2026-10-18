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

v3 (F3's hooks): `city.births` and `city.deaths` come from `sim.life.counts`, `city.life` is `life.stats_block`;
with townsfolk, `stats.folk` is `sim.folk.stats_json(sim)` (ints) and `city`/`districts` add `folk_parts(sim)`
(`sim.folk.city_parts` plus the townsfolk's needs, luck, worths, retired and out of work; see `_add_parts`); in the
region world `stats.region` (view.md 4.3). `stats.people` and the richest title stay
the 60 named. The hourly sample calls `sim.folk.sample_hour(sim)`.
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


def _city_block(sim: Simulation, people: list[_Person], parts: dict | None = None) -> dict:
    from . import life  # here, not at the top: see the module docstring
    alive = [p.agent for p in people]
    adults = [a for a in alive if a.is_adult]
    dead = [a for a in sim.agents.values() if not a.alive]
    died = sorted((a for a in dead if a.died), key=lambda a: (-a.died["tick"], a.id))[:RECENT_DEATHS]
    lucks = [a.luck for a in alive]
    counts = sim.life.counts  # every birth and death of both tiers, once life counts them
    block = {
        "population": len(alive), "start_population": len(sim.agents),
        "deaths": counts["deaths"] if "deaths" in counts else len(dead), "births": counts.get("births", 0),
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
        "life": life.stats_block(sim),
    }
    if parts:
        _add_parts(block, people, parts)
    return block


# The city counters the townsfolk's `city_parts` adds to (people counted, never means or money).
PART_COUNTS = ("population", "start_population", "adults", "children", "working", "students", "retired",
               "out_of_work")


# F2a's `Folk.city_parts` keys that name the same thing as `_add_parts`'s (its mood and health are sums).
PART_ALIASES = {"employed": "working", "pupils": "students", "mood": "mood_sum", "health": "health_sum",
                "money": "money_sum"}
DISTRICT_ALIASES = {"population": "people", "mood": "mood_sum", "money": "money_sum"}


def canon_parts(parts: dict | None) -> dict | None:
    """`Folk.city_parts(sim)` with F2a's key names mapped onto `_add_parts`'s and `_districts`'s."""
    if not parts:
        return parts
    out = {PART_ALIASES.get(k, k): v for k, v in parts.items() if k != "districts"}
    out["districts"] = {did: {DISTRICT_ALIASES.get(k, k): v for k, v in row.items()}
                        for did, row in (parts.get("districts") or {}).items()}
    return out


CITY_NEEDS = ("hunger", "energy", "social", "fun")


def folk_parts(sim: Simulation, hourly: bool = False) -> dict | None:
    """The townsfolk's part of `city` and `districts`, or None without townsfolk: `Folk.city_parts(sim)` (F2a,
    through `canon_parts`) plus what it leaves out, over the same people (`sim.folk.living()`): `needs_sum` (each
    need brought forward to now without settling anyone), `luck` ({touched, raised, lowered, sum}), `adult_worths`
    (city-wide and per district), `in_debt`, `worth_sum` (everyone's worth, the wealth total), `retired` (65+
    without a job) and `out_of_work` (18-64 without a job). A key `city_parts` already sends is kept as sent.
    stats_json and CityStats.sample both use this one helper. `hourly` is CityStats.sample's call, right after
    `folk.sample_hour` at the same tick: each worth comes from the ring sample_hour just filled, and the needs,
    luck and district worths, which a sample does not keep, are left out (the step stays within perf_folk's p99)."""
    f = sim.folk
    if not f.n:
        return None
    from .agent import NEED_DECAY
    from .folk_model import DECAY_SCALE
    parts = canon_parts(f.city_parts(sim)) or {"districts": {}}
    tick = sim.clock.tick
    places = sim.town.places
    rings = getattr(f, "rings", None) if hourly else None
    full = not hourly
    needs = {n: 0.0 for n in CITY_NEEDS}
    luck = {"touched": 0, "raised": 0, "lowered": 0, "sum": 0.0}
    worths: list[int] = []
    by_district: dict[str, list[int]] = {}
    worth_sum = in_debt = retired = out_of_work = 0
    for p in f.living():
        if full:
            raw = p._needs  # the lazy raw needs as of p._nt, projected to now and never written (no settling)
            dt = tick - p._nt
            if dt > 0 and p.age >= 5:
                scale = DECAY_SCALE.get(p.activity if p.state == "busy" else "", {})
                for n in CITY_NEEDS:
                    v = raw[n] - NEED_DECAY[n] * scale.get(n, 1.0) * dt
                    needs[n] += 0.0 if v < 0.0 else 100.0 if v > 100.0 else v
            else:
                for n in CITY_NEEDS:
                    needs[n] += raw[n]
            x = p.luck
            luck["sum"] += x
            if x != 50:
                luck["touched"] += 1
                luck["raised" if x > 50 else "lowered"] += 1
        ring = rings.get(p.i) if rings is not None else None
        w = ring[-1] if ring else f.worth(sim, p)
        worth_sum += w
        if p.age >= 18:
            worths.append(w)
            if p.money + p.savings < 0:
                in_debt += 1
            if p.job is None:
                if p.age >= 65:
                    retired += 1
                else:
                    out_of_work += 1
            if full:
                home = f.home_place(p)
                place = places.get(home) if home else None
                by_district.setdefault(place.district if place else "", []).append(w)
    extra = {"adult_worths": worths, "worth_sum": worth_sum, "in_debt": in_debt, "retired": retired,
             "out_of_work": out_of_work}
    if full:
        extra["needs_sum"], extra["luck"] = needs, luck
    for k, v in extra.items():
        parts.setdefault(k, v)
    districts = parts.setdefault("districts", {})
    for d, ws in by_district.items():
        districts.setdefault(d, {"people": 0, "mood_sum": 0.0}).setdefault("adult_worths", ws)
    return parts


def _add_parts(block: dict, people: list[_Person], parts: dict) -> None:
    """Add the townsfolk to a city block (`Folk.city_parts(sim)`, F2a). Every key is optional:
    PART_COUNTS ints (added); `mood_sum`, `health_sum` (floats) and `needs_sum` ({need: float}) over the folk
    counted in `population` (the means then cover everyone; without `needs_sum` the named needs means stand);
    `adult_worths` (the folk adults' worths, ints: median, top-10 share and gini cover everyone) and `worth_sum`
    (all the folk's worth, the wealth total; else the adults' worths); `in_debt` (int); `luck` ({touched, raised,
    lowered}, ints, and `sum`; without it the named luck stands); `money_sum` (cash and savings, added to the
    wealth total when there are no worths). `folk_parts` builds all of these. F2a's own names (`employed`,
    `pupils`, `mood`, `health`, `money`) arrive through `canon_parts`. Named-only stays named-only:
    `recent_deaths`, `homes`, `life` (life counts both tiers itself)."""
    named_n = block["population"]
    for k in PART_COUNTS:
        block[k] += int(parts.get(k, 0))
    n = block["population"]
    if n and parts.get("population"):
        alive = [p.agent for p in people]
        block["mood"] = _int((sum(a.mood for a in alive) + parts.get("mood_sum", 0.0)) / n)
        block["health"] = _int((sum(a.health for a in alive) + parts.get("health_sum", 0.0)) / n)
        needs = parts.get("needs_sum")
        if needs is not None:  # without the townsfolk's needs the named means stand (never diluted by n)
            block["needs"] = {k: _int((sum(a.needs[k] for a in alive) + needs.get(k, 0.0)) / n)
                              for k in block["needs"]}
        luck = parts.get("luck")
        if luck is not None:
            for k in ("touched", "raised", "lowered"):
                block["luck"][k] += int(luck.get(k, 0))
            block["luck"]["mean"] = _int((sum(a.luck for a in alive) + luck.get("sum", 50.0 * (n - named_n))) / n)
    worths = parts.get("adult_worths")
    if worths:
        adults = [p.worth for p in people if p.agent.is_adult] + list(worths)
        w = block["wealth"]
        w["total"] += int(parts.get("worth_sum", sum(worths)))
        w["median"], w["top10_share"], w["gini"] = _int(median(adults)), top_share(adults), gini(adults)
        w["in_debt"] += int(parts.get("in_debt", 0))
    elif parts.get("money_sum"):  # no worths: the townsfolk's cash and savings still count in the total
        block["wealth"]["total"] += int(parts["money_sum"])


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


def _districts(sim: Simulation, people: list[_Person], parts: dict | None = None) -> list[dict]:
    """Every district with at least one home, in town order (the region's after Millbrook's in the region).
    `parts["districts"]` ({district id: {"people": int, "mood_sum": float, "adult_worths": [ints]}}, the
    townsfolk's `city_parts`) adds the townsfolk living there."""
    from . import housing
    from .town import DISTRICTS
    district = _district_of_place(sim)
    folk = (parts or {}).get("districts", {})
    out = []
    names = ([(d["id"], d["name"]) for d in sim.town.districts] if getattr(sim, "world", "millbrook") == "region"
             else [(did, name) for did, name, _, _ in DISTRICTS])
    for did, name in names:
        homes = [h for h in sim.homes.values() if district.get(h.place) == did]
        if not homes:
            continue
        here = [p for p in people if district.get(sim.homes[sim.households[p.agent.household_id].home_id].place) == did]
        f = folk.get(did, {})
        n = len(here) + int(f.get("people", 0))
        worths = [p.worth for p in here if p.agent.is_adult] + list(f.get("adult_worths", ()))
        out.append({
            "id": did, "name": name, "people": n,
            "mood": _int((sum(p.agent.mood for p in here) + f.get("mood_sum", 0.0)) / n) if n else 0,
            "median_worth": _int(median(worths)),
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
                     "home_equity": p.home, "job": a.job.title if a.job else None, "health": _int(a.health),
                     "llm": a.llm_count})
    return rows


def stats_json(sim: Simulation, full: bool = False) -> dict:
    """The `stats` message (PLAN 3.8).

    full=True (the God welcome and `get_stats`) carries every kept sample. full=False is the push: it carries
    the samples recorded since the previous push, and each sample goes in one push only.
    """
    people = _people(sim)
    parts = folk_parts(sim)
    samples = list(sim.stats.samples) if full else sim.stats.take_new_samples()
    out = {"type": "stats", "full": bool(full), "tick": sim.clock.tick, "time": sim.clock.stamp(),
           "day": sim.clock.day, "city": _city_block(sim, people, parts), "llm": _llm_block(sim),
           "districts": _districts(sim, people, parts), "households": _households(sim),
           "people": _people_rows(sim, people), "samples": samples}
    if sim.folk.n:
        out["folk"] = sim.folk.stats_json(sim)  # {v, worth, worth_24h, mood, health, luck}: ints by index
    if getattr(sim, "world", "millbrook") == "region":
        out["region"] = region_block(sim, out["city"])
    return out


def region_block(sim: Simulation, city: dict) -> dict:
    """`stats.region` (view.md 4.3), region world only: everyone, the jobs board, how people get to work, and the
    trains and buses now and today. Folk-side numbers come from `Folk.region_parts(sim)` when the townsfolk have it
    ({folk, commute: {walk, car, bus, train, bike}, train_riders_today, train_lines_today: {line id: n},
    bus_riders_today}); otherwise they are 0."""
    named = sum(1 for a in sim.agents.values() if a.alive)
    get = getattr(sim.folk, "region_parts", None)
    fp = get(sim) if get is not None else {}
    board = sim.life.board
    filled = sum(1 for h in board.holder if h is not None)
    trains = sim.trains()
    counts, today = sim.life.counts, sim.life.today
    commute = {"walk": 0, "car": 0, "bus": 0, "train": 0, "bike": 0}
    for k, v in fp.get("commute", {}).items():
        commute[k] = commute.get(k, 0) + int(v)
    lines = fp.get("train_lines_today", {})
    return {
        "population": city["population"], "named": named, "folk": int(fp.get("folk", len(sim.folk.living()))),
        "births": counts.get("births", 0), "deaths": counts.get("deaths", 0),
        "births_today": today.get("births", 0), "deaths_today": today.get("deaths", 0),
        "jobs": {"total": len(board.jobs), "filled": filled, "open": len(board.jobs) - filled},
        "commute": commute,
        "train": {"riders_now": sum(t.get("riders", 0) for t in trains),
                  "riders_today": int(fp.get("train_riders_today", 0)),
                  "lines": [{"id": line["id"], "riders_today": int(lines.get(line["id"], 0))}
                            for line in ((sim.town.rail or {}).get("lines") or [])]},
        "bus": {"riders_now": sum(1 for a in sim.agents.values() if a.alive and a.riding),
                "riders_today": int(fp.get("bus_riders_today", 0))},
    }


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
        """Midnight: today's counters start again from 0, except `asked`, which starts at the forks asked before
        midnight and still open. They are decided today, so today keeps asked >= in_time + timeouts + withdrawn
        (dashboard.md 6.2). The totals know how many: every ask ends in time, timed out or withdrawn."""
        t = self.total
        self.today = _zeros()
        self.today["asked"] = max(0, t["asked"] - t["in_time"] - t["timeouts"] - t["withdrawn"])

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
        sim.folk.sample_hour(sim)  # the townsfolk's worth rings (stats.folk.worth_24h); folk_parts reads them
        city = _city_block(sim, people, folk_parts(sim, hourly=True))
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

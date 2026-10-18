"""The 60 in the region (region.md 11, R1b; PLAN 2.9 and 2.17).

1. Identity: `Simulation(s, world="region")` lives the same days as `Simulation(s)`: every event, decision and
   hourly position, seeds 1-2 for 7 days (seeds 1-5 for 14 days with GOAL_SLOW=1; SOAK_SEEDS and SOAK_DAYS override
   both), and no region tick takes over 50 ms of CPU. It skips itself until `Simulation` accepts `world=`.
2. Rule R in `travel.nearest` and `travel.named_may_visit`.
3. `list_vacancies` lists the 575 region homes of a fresh region sim, and nothing is listed without the call.
4. Region homes follow the 37; `nightly` and `tick` draw `sim.rng` exactly as millbrook does; a townsfolk household
   (a carless train commuter, a car commuter and a child in a region house) goes through every housing helper
   without an exception, and `commute()` is the hand-worked folk cost.
5. The cast is offered only the 37: candidate lists, `market_json` and `house_drought` ignore region homes (and the
   60-day house-hunt soak, GOAL_SLOW=1).

Until F3's hooks land, the region town (region.build_region) is swapped into a millbrook `Simulation` (its `town`,
`homes` and `lots`); R1B_PATCHED=1 runs the identity test that way too.
"""

from __future__ import annotations

import inspect
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

from gameofailife import housing, travel
from gameofailife.agent import Job, Profile
from gameofailife.clock import MINUTES_PER_DAY
from gameofailife.rng import r2
from gameofailife.sim import Simulation

SLOW = os.environ.get("GOAL_SLOW") == "1"
WORLD_KW = "world" in inspect.signature(Simulation).parameters
TICK_CPU_CAP = 0.050  # seconds of process_time a region tick may take
REGION_HOMES = 575


def _seeds(default: str) -> list[int]:
    return [int(s) for s in os.environ.get("SOAK_SEEDS", default).split(",") if s.strip()]


def _days(default: int) -> int:
    return int(os.environ.get("SOAK_DAYS", default))


def region_town(seed: int):
    """The region map for a seed (R1a's region.build_region), or None on a branch without it."""
    try:
        from gameofailife import region
    except ImportError:
        return None
    return region.build_region(seed)


def region_sim(seed: int, patched: bool = False) -> Simulation:
    """A region-world Simulation: `world="region"` once the hooks land, else (or with `patched`) a millbrook one
    whose town, homes and lots are the region's (the cast keeps its 37 homes and their lots)."""
    if WORLD_KW and not patched:
        return Simulation(seed, world="region")
    town = region_town(seed)
    sim = Simulation(seed)
    homes = housing.build_homes(town)
    for hid in housing.V2_HOME_IDS:
        homes[hid] = sim.homes[hid]
    lots = housing.build_lots(town, homes)
    lots.update(sim.lots)
    sim.town, sim.homes, sim.lots = town, homes, lots
    return sim


def needs_region(test):
    return unittest.skipUnless(region_town(1) is not None, "no region map (R1a's region.py)")(test)


def trace(sim: Simulation, days: int, cpu: list | None = None) -> dict:
    """Every event, decision and hourly position of the 60 over `days` (test_port's trace, without the stats)."""
    out = {"events": [], "forks": [], "hours": []}
    agents = list(sim.agents.values())
    seen: dict[str, str] = {}  # fork ids come from one counter shared by every Simulation: number them per run

    def drain():
        events, forks, _ = sim.drain()
        out["events"] += [[e["tick"], e["tag"], e["text"], e.get("agent"), e.get("agents"), e.get("place")]
                          for e in events]
        out["forks"] += [[f["tick"], seen.setdefault(f["id"], f"#{len(seen)}"), f["agent"], f["kind"], f["choice"],
                          f["decided_by"], f["happened"]] for f in forks]

    drain()
    end = sim.clock.tick + days * MINUTES_PER_DAY

    while sim.clock.tick < end:
        if cpu is not None:
            c = time.process_time()
            sim.step()
            cpu.append(time.process_time() - c)
        else:
            sim.step()
        drain()
        if sim.clock.minute_of_day % 60 == 0:
            out["hours"].append([sim.clock.tick, [
                [a.id, a.x, a.y, a.state, a.activity, a.inside, round(a.money, 2), round(a.savings, 2),
                 round(a.health, 2), a.household_id, sim.households[a.household_id].home_id, a.vehicle, a.riding]
                for a in agents]])
    return out


def first_difference(a: dict, b: dict) -> str | None:
    for key in ("events", "forks", "hours"):
        for i, (x, y) in enumerate(zip(a[key], b[key])):
            if x != y:
                return f"{key}[{i}]: millbrook {x!r} vs region {y!r}"
        if len(a[key]) != len(b[key]):
            return f"{key}: {len(a[key])} in millbrook vs {len(b[key])} in the region"
    return None


# --- 1. identity ---------------------------------------------------------------------------------------------------

@needs_region
class IdentityTest(unittest.TestCase):
    """The region world changes nothing for the 60 (folk 0): Rule R and the housing hunks keep v2's days."""

    def check(self, seeds: list[int], days: int, patched: bool = False) -> None:
        for seed in seeds:
            with self.subTest(seed=seed):
                base = trace(Simulation(seed), days)
                sim = region_sim(seed, patched)
                sim.town.warm()  # what the server does at start: Millbrook's fields (region.md 6.2)
                cpu = []
                got = trace(sim, days, cpu)
                load = os.getloadavg()[0]
                worst = max(cpu)
                print(f"\n[R1b identity] seed {seed}, {days} d: {len(base['events'])} events, {len(base['forks'])} "
                      f"forks; region tick max {worst * 1000:.1f} ms, mean {sum(cpu) / len(cpu) * 1000:.2f} ms CPU "
                      f"(load {load:.1f})", file=sys.stderr)
                self.assertIsNone(first_difference(base, got))
                self.assertGreater(len(base["forks"]), 100)
                self.assertLessEqual(worst, TICK_CPU_CAP, f"a region tick took {worst * 1000:.1f} ms of CPU")

    @unittest.skipUnless(WORLD_KW or os.environ.get("R1B_PATCHED") == "1",
                         "Simulation does not accept world= yet (F3's v3-skel-hooks)")
    def test_region_world_lives_the_same_days(self):
        if SLOW:
            self.check(_seeds("1,2,3,4,5"), _days(14), patched=not WORLD_KW)
        else:
            self.check(_seeds("1,2"), _days(7), patched=not WORLD_KW)


# --- 2. Rule R -----------------------------------------------------------------------------------------------------

@needs_region
class RuleRTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sim = region_sim(1, patched=True)
        cls.sim.town.warm()
        cls.town = cls.sim.town

    def far_places(self, kind: str) -> list:
        return [p for p in self.town.places.values() if p.kind == kind and p.id not in self.town.millbrook_ids]

    def test_in_millbrook_only_millbrook_places(self):
        sim, town = self.sim, self.town
        agents = list(sim.agents.values())
        kinds = [("cafe",), ("market",), ("shop", "market"), ("park",), ("hospital",), ("school",), ("bank",)]
        seen = 0
        for hour in (7, 9, 12, 15, 18, 21):
            sim.clock.tick = hour * 60
            for i, a in enumerate(agents):
                for k in kinds[i % len(kinds):] + kinds[:i % len(kinds)][:2]:
                    p = travel.nearest(sim, a, k)
                    if p is not None:
                        seen += 1
                        self.assertIn(p.id, town.millbrook_ids, (a.id, k, hour))
        self.assertGreater(seen, 500)

    def test_edge_of_millbrook(self):
        """From the grass at (68, 45) a region park is 26 walking minutes away (region.md 3.4): never offered."""
        sim, town = self.sim, self.town
        a = next(iter(sim.agents.values()))
        x0, y0, inside0 = a.x, a.y, a.inside
        try:
            for xy in ((68, 45), (68, 49), (60, 49)):
                if not town.walkable(*xy):
                    continue
                a.x, a.y, a.inside = xy[0], xy[1], None
                for kinds in (("park",), ("cafe",), ("shop", "market")):
                    p = travel.nearest(sim, a, kinds, stay=30)
                    self.assertTrue(p is None or p.id in town.millbrook_ids, (xy, kinds, p and p.id))
                for p in self.far_places("park") + self.far_places("cafe"):
                    self.assertFalse(travel.named_may_visit(sim, a, p.id))
        finally:
            a.x, a.y, a.inside = x0, y0, inside0

    def test_outside_millbrook_region_places_within_the_walk_cap(self):
        """A character outside the frozen rectangle may be offered a region place, but only within the cap."""
        sim, town = self.sim, self.town
        a = next(iter(sim.agents.values()))
        x0, y0, inside0 = a.x, a.y, a.inside
        sim.clock.tick = 11 * 60
        cafes = sorted(self.far_places("cafe"), key=lambda p: p.id)
        try:
            near = cafes[0]
            a.x, a.y, a.inside = near.entry[0], near.entry[1], None
            self.assertFalse(town.in_frozen(a.x, a.y))
            self.assertTrue(travel.named_may_visit(sim, a, near.id))
            got = travel.nearest(sim, a, ("cafe",))
            self.assertIsNotNone(got)
            self.assertLessEqual(town.walk_minutes((a.x, a.y), got.id), travel.MAX_OUTING_MINUTES)
            far = max(cafes, key=lambda p: abs(p.entry[0] - a.x) + abs(p.entry[1] - a.y))
            self.assertGreater(abs(far.entry[0] - a.x) + abs(far.entry[1] - a.y), travel.MAX_OUTING_MINUTES)
            self.assertFalse(travel.named_may_visit(sim, a, far.id))
            self.assertTrue(travel.named_may_visit(sim, a, far.id, max_minutes=10_000)
                            or town.walk_minutes((a.x, a.y), far.id) >= travel.UNREACHABLE)
            tight = travel.nearest(sim, a, ("cafe",), max_minutes=0)
            self.assertTrue(tight is None or tight.id in town.millbrook_ids or tight.id == near.id)
        finally:
            a.x, a.y, a.inside = x0, y0, inside0

    def test_millbrook_places_always_visitable_and_unknown_never(self):
        a = next(iter(self.sim.agents.values()))
        for pid in sorted(self.town.millbrook_ids):
            self.assertTrue(travel.named_may_visit(self.sim, a, pid))
        self.assertFalse(travel.named_may_visit(self.sim, a, "no_such_place"))

    def test_millbrook_world_unchanged(self):
        sim = Simulation(1)
        sim.clock.tick = 11 * 60
        a = next(iter(sim.agents.values()))
        for pid in sim.town.places:
            self.assertTrue(travel.named_may_visit(sim, a, pid))
        self.assertEqual(travel.nearest(sim, a, ("cafe",)).id, travel.nearest(sim, a, ("cafe",), max_minutes=0).id)


# --- 3 and 4. region homes, list_vacancies, the dice, townsfolk households --------------------------------------

class _Folk:
    """Just enough of `sim.folk` for a scripted townsfolk household."""

    n, isolated, v = 0, False, 0

    def __init__(self, people: dict, households: dict):
        self.people, self.households = people, households

    def person(self, pid):
        return self.people.get(pid)

    get = person

    def household(self, hid):
        return self.households.get(hid)

    def living(self):
        return [p for p in self.people.values() if p.alive]


def install_folk(sim: Simulation, people: dict, households: dict) -> None:
    """Make the townsfolk findable by id the way the hooks do (sim.person, sim.household_by_id, sim.folk)."""
    folk = _Folk(people, households)
    sim.folk = folk
    sim.person = lambda pid: sim.agents.get(pid) or folk.person(pid)
    sim.household_by_id = lambda hid: sim.households.get(hid) or folk.household(hid)


@needs_region
class RegionHomesTest(unittest.TestCase):
    def test_region_homes_follow_the_37_empty_and_unlisted(self):
        sim = region_sim(1)
        ids = list(sim.homes)
        self.assertEqual(ids[:37], list(housing.V2_HOME_IDS))
        self.assertEqual(len(ids), 37 + REGION_HOMES)
        mb = Simulation(1)
        for hid in housing.V2_HOME_IDS:
            a, b = mb.homes[hid], sim.homes[hid]
            self.assertEqual((a.owner, a.household, a.listing, a.rent), (b.owner, b.household, b.listing, b.rent))
        for h in list(sim.homes.values())[37:]:
            self.assertIsNone(h.household)
            self.assertIsNone(h.listing)
            self.assertIn(h.owner, ("landlord", "market"))
            self.assertIn(h.place, sim.lots)
        self.assertEqual(housing.market_json(sim), housing.market_json(mb))

    def test_list_vacancies_lists_the_575(self):
        sim = region_sim(1)
        region = [h for h in sim.homes.values() if not housing.is_v2_home(h.id)]
        before = {h.id: (h.listing, h.rent) for h in sim.homes.values() if housing.is_v2_home(h.id)}
        self.assertEqual(housing.list_vacancies(sim), REGION_HOMES)
        self.assertEqual(before, {h.id: (h.listing, h.rent) for h in sim.homes.values() if housing.is_v2_home(h.id)})
        rent = {s[0]: s[6] for s in sim.town.home_specs}
        for h in region:
            self.assertEqual(h.listing, "for_rent" if h.owner == "landlord" else "for_sale", h.id)
            if h.listing == "for_rent":
                c = sim.lots[h.place].condition
                self.assertEqual(h.rent, int(rent[h.id] * (0.6 + 0.4 * c / 100) / 5 + 0.5) * 5, h.id)
        self.assertGreater(sum(h.listing == "for_rent" for h in region), 400)
        self.assertGreater(sum(h.listing == "for_sale" for h in region), 50)
        # Idempotent: listing again from the base rent never compounds the condition discount.
        rents = {h.id: h.rent for h in region}
        self.assertEqual(housing.list_vacancies(sim), REGION_HOMES)
        self.assertEqual(rents, {h.id: h.rent for h in region})
        # An occupied home is unlisted.
        region[0].household = "fh0"
        self.assertEqual(housing.list_vacancies(sim), REGION_HOMES - 1)
        self.assertIsNone(region[0].listing)

    def test_nightly_and_tick_draw_the_dice_as_millbrook(self):
        mb, sim = Simulation(1), region_sim(1)
        self.check_same_draws(mb, sim)
        # With a townsfolk household in a derelict region house (with an emergency pending and one live): still
        # the same draws, and no news of it.
        mb, sim = Simulation(2), region_sim(2)
        hh, home, _ = scripted_folk(sim)
        sim.lots[home.place].condition = 5.0
        home.pending_emergency = {"kind": "leak", "due": 0}
        self.check_same_draws(mb, sim)
        self.assertIsNotNone(home.pending_emergency)

    def check_same_draws(self, mb: Simulation, sim: Simulation) -> None:
        for name in ("nightly", "tick"):
            for day in range(3):
                for s in (mb, sim):
                    s.clock.tick = day * MINUTES_PER_DAY
                    getattr(housing, name)(s)
                self.assertEqual(mb.rng.getstate(), sim.rng.getstate(), (name, day))
                self.assertEqual([e["text"] for e in mb.events], [e["text"] for e in sim.events], (name, day))


def scripted_folk(sim: Simulation, house_id: str | None = None, work: str | None = None):
    """A townsfolk household in a region house it owns: Ada (34, no car, the train to work, five days), Ben (40, his
    car, six days) and Cal (9)."""
    from gameofailife.folk_model import FolkHousehold, Person

    house = sim.homes[house_id] if house_id else next(h for h in sim.homes.values()
                                                       if not housing.is_v2_home(h.id) and h.tier == "house")
    work = work or next(p.id for p in sim.town.places.values() if p.kind == "office")
    hh = FolkHousehold("fh0", house.id, 0.0, member_ids=["f0", "f1", "f2"], j=0)
    ada, ben, cal = Person(0, "Ada Moss", 34, "f", 0), Person(1, "Ben Moss", 40, "m", 0), Person(2, "Cal Moss", 9, "m", 0)
    ada.job, ada.commute, ada.money, ada.savings = Job("clerk", work, 22.0, 9, 17, (0, 1, 2, 3, 4)), (work, 34, "train"), 400.0, 2600.0
    ben.job, ben.commute, ben.owns_car, ben.money = Job("fitter", work, 24.0, 7, 15, (0, 1, 2, 3, 4, 5)), (work, 21, "car"), True, 250.0
    cal.job = Job("student", "school", 0.0, 8, 15, (0, 1, 2, 3, 4))
    for i, p in enumerate((ada, ben, cal)):
        p.traits = {t: 0.3 + 0.1 * i for t in Profile.TRAITS}
    house.household = house.owner = hh.id
    install_folk(sim, {p.id: p for p in (ada, ben, cal)}, {hh.id: hh})
    return hh, house, (ada, ben, cal)


@needs_region
class FolkHouseholdTest(unittest.TestCase):
    """PLAN 2.17: housing's helpers take a FolkHousehold, and the nightly and per-tick rules skip it."""

    def setUp(self):
        self.sim = region_sim(1)
        self.hh, self.home, self.people = scripted_folk(self.sim)

    def test_commute_is_the_folk_cost(self):
        sim, hh = self.sim, self.hh
        # Ada: 5 workdays x 2 train fares of $3; Ben: 6 workdays x TRIP_COST["car"]; Cal: school is free.
        self.assertEqual(housing.commute(sim, hh), 5 * 2 * 3 + 6 * travel.TRIP_COST["car"])
        ada = self.people[0]
        ada.age = 66
        self.assertEqual(housing.commute(sim, hh), 6 * travel.TRIP_COST["car"])  # the train is free from 65
        ada.age, ada.commute = 34, (ada.job.place_id, 12, "walk")
        self.assertEqual(housing.commute(sim, hh), 6 * travel.TRIP_COST["car"])
        ada.commute = None
        self.assertEqual(housing.commute(sim, hh), 6 * travel.TRIP_COST["car"])

    def test_helpers_take_a_folk_household(self):
        sim, hh, home = self.sim, self.hh, self.home
        housing.list_vacancies(sim)
        self.assertEqual([a.id for a in housing.adults(sim, hh)], ["f0", "f1"])
        self.assertEqual(housing.residents(sim, hh), 3)
        self.assertEqual(housing.household_name(sim, hh), "The Mosses")
        self.assertEqual(housing.living(sim, hh), 3 * housing.LIVING_PER_PERSON)
        self.assertGreater(housing.weekly_income(sim, hh), 0)
        outgo = housing.weekly_outgo(sim, hh)
        self.assertGreater(outgo, housing.commute(sim, hh))
        other = next(h for h in sim.homes.values() if not housing.is_v2_home(h.id) and h.listing and h.id != home.id)
        for f in (housing.fits, housing.is_upgrade):
            f(sim, hh, other) if f is housing.fits else f(sim, hh, other.id)
        housing.affordable(sim, hh, other.id)
        housing.reno_cost(sim, home.id)
        housing.value(sim, home.id)
        housing.sale_proceeds(sim, home.id)
        self.assertEqual(housing.weekly_cost(sim, hh), housing.property_tax(home))
        housing.comfort(sim, hh)
        housing.crowded(sim, hh)
        housing.funds(sim, hh)
        housing.tenure(sim, hh)
        page = housing.home_page(sim, home.id)
        self.assertEqual(page["residents"], ["Ada Moss", "Ben Moss", "Cal Moss"])
        self.assertEqual(page["household_name"], "The Mosses")
        for household_pays in (False, True):
            for cost in (0, 50, 900, 10 ** 6):
                opt = SimpleNamespace(cost=cost, household_pays=household_pays, charge=True)
                self.assertLessEqual(housing.afford_score(sim, self.people[0], opt), 0.0)
        self.people[0].alive = False
        self.assertEqual(housing.residents(sim, hh), 2)
        self.assertEqual(housing.commute(sim, hh), 6 * travel.TRIP_COST["car"])

    def test_nightly_tick_decay_emergency_and_stage_change_raise_nothing(self):
        sim, hh, home = self.sim, self.hh, self.home
        lot = sim.lots[home.place]
        sim.events.clear()
        lot.condition = 61.0
        home.emergency = {"kind": "boiler", "since": 0}
        home.pending_emergency = {"kind": "roof", "due": 0}
        for day in range(4):
            sim.clock.tick = day * MINUTES_PER_DAY
            housing.nightly(sim)
            housing.tick(sim)
        self.assertLess(lot.condition, 61.0)  # the house still wears
        housing._change_condition(sim, lot, -45)  # a stage change: no news for a townsfolk home
        housing._change_condition(sim, lot, +90)
        self.assertEqual([e for e in sim.events if e.get("place") == home.place], [])
        housing.fix_emergency(sim, hh)
        self.assertIsNone(home.emergency)
        housing.list_vacancies(sim)
        self.assertIsNone(home.listing)


# --- 2b. Node: the JS twins answer the same ---------------------------------------------------------------------

NODE = os.environ.get("NODE") or shutil.which("node")
PARITY = Path(__file__).resolve().parent.parent / "port" / "tools" / "parity_travel.cjs"
KIND_SETS = [["cafe"], ["market"], ["shop", "market"], ["park"], ["hospital"], ["school"], ["bank"], ["office"],
             ["works"], ["townhall"], ["cafe", "shop"]]


def parity_spec(sim, n: int = 200) -> dict:
    """n nearest queries (half from tiles in Millbrook, half from region places' doors, so the walk cap is met),
    named_may_visit on 60 (character, place) pairs, and the scripted folk household's homes."""
    town = sim.town
    inside = [(x, y) for y in range(0, 50, 3) for x in range(0, 69, 3) if town.walkable(x, y)]
    far = sorted((p for p in town.places.values() if p.id not in town.millbrook_ids and p.kind != "home"),
                 key=lambda p: p.id)
    queries = []
    for k in range(n):
        if k % 2 == 0:
            x, y = inside[(k * 37) % len(inside)]
        else:
            e = far[(k * 13) % len(far)].entry
            x, y = e[0] + (k % 5) - 2, e[1]
            if not town.walkable(x, y):
                x, y = e
        queries.append({"agent": k % len(sim.agents), "x": x, "y": y, "tick": (6 + k % 17) * 60 + (k * 7) % 60,
                        "kinds": KIND_SETS[k % len(KIND_SETS)], "stay": (0, 30, 60)[k % 3],
                        "max": (None, None, 20, 60)[k % 4]})
    visits = []
    for k in range(60):
        q = queries[(k * 7) % n]
        visits.append({**q, "place": far[(k * 11) % len(far)].id if k % 3 else sorted(town.millbrook_ids)[k % 39]})
    house = next(h for h in sim.homes.values() if not housing.is_v2_home(h.id) and h.tier == "house")
    work = next(p.id for p in town.places.values() if p.kind == "office")
    other = next(h.id for h in list(sim.homes.values())[37:] if h.id != house.id and h.owner == "market")
    return {"seed": 1, "queries": queries, "visits": visits, "folk": {"house": house.id, "work": work, "other": other}}


def parity_python(spec: dict) -> dict:
    """What parity_travel.cjs computes, in Python."""
    sim = region_sim(spec["seed"], patched=True)
    sim.town.warm()
    agents = list(sim.agents.values())
    out = {"nearest": [], "visits": []}

    def place_at(a, q):
        a.x, a.y, a.inside = q["x"], q["y"], None
        sim.clock.tick = q["tick"]

    for q in spec["queries"]:
        a = agents[q["agent"]]
        place_at(a, q)
        p = travel.nearest(sim, a, tuple(q["kinds"]), None, None, q["stay"], q["max"])
        out["nearest"].append(None if p is None else p.id)
    for v in spec["visits"]:
        a = agents[v["agent"]]
        place_at(a, v)
        out["visits"].append(travel.named_may_visit(sim, a, v["place"], v["max"]))
    out["listed"] = housing.list_vacancies(sim)
    out["region_homes"] = [[h.id, h.owner, h.listing, h.rent] for h in sim.homes.values()
                           if not housing.is_v2_home(h.id)]
    out["market"] = housing.market_json(sim)
    hh, house, (ada, ben, cal) = scripted_folk(sim, spec["folk"]["house"], spec["folk"]["work"])
    other = spec["folk"]["other"]
    out["folk"] = {
        "commute": housing.commute(sim, hh), "outgo": housing.weekly_outgo(sim, hh),
        "income": housing.weekly_income(sim, hh), "living": housing.living(sim, hh),
        "residents": housing.residents(sim, hh), "name": housing.household_name(sim, hh),
        "affordable": housing.affordable(sim, hh, other), "upgrade": housing.is_upgrade(sim, hh, other),
        "weekly_cost": housing.weekly_cost(sim, hh), "page": housing.home_page(sim, house.id)["residents"],
        "afford": [housing.afford_score(sim, ada, SimpleNamespace(cost=c, household_pays=False, charge=True))
                   for c in (0, 50, 900, 10 ** 6)],
    }
    house.emergency = {"kind": "boiler", "since": 0}
    house.pending_emergency = {"kind": "roof", "due": 0}
    sim.lots[house.place].condition = 61.0
    for day in range(4):
        sim.clock.tick = day * MINUTES_PER_DAY
        housing.nightly(sim)
        housing.tick(sim)
    out["folk"]["condition"] = sim.lots[house.place].condition
    out["folk"]["listed_after"] = housing.list_vacancies(sim)
    v2_places = {row[1] for row in housing.HOME_SPECS}
    out["lots"] = [[pid, r2(lot.condition)] for pid, lot in sim.lots.items() if pid not in v2_places]
    return out


@needs_region
@unittest.skipUnless(NODE, "node is not installed")
class NodeParityTest(unittest.TestCase):
    """region.md 11 R1b 2: the JS nearest answers 200 queries as Python does; the JS housing hunks agree too."""

    def test_node_equals_python(self):
        spec = parity_spec(region_sim(1, patched=True))
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "spec.json"
            path.write_text(json.dumps(spec))
            run = subprocess.run([NODE, str(PARITY), str(path)], capture_output=True, text=True, timeout=300)
        self.assertEqual(run.returncode, 0, run.stderr)
        js = json.loads(run.stdout)
        py = json.loads(json.dumps(parity_python(spec)))
        found = sum(1 for p in py["nearest"] if p is not None)
        far = sum(1 for p in py["nearest"] if p is not None and p not in region_town(1).millbrook_ids)
        self.assertGreater(found, 150)
        self.assertGreater(far, 20)  # the cap branch is exercised
        for key in ("nearest", "visits", "listed", "region_homes", "market", "folk", "lots"):
            if key in ("nearest", "visits"):
                for i, (a, b) in enumerate(zip(py[key], js[key])):
                    self.assertEqual(a, b, (key, i, spec["queries" if key == "nearest" else "visits"][i]))
            self.assertEqual(py[key], js[key], key)


# --- 5. the cast is offered only the 37 ---------------------------------------------------------------------------

@needs_region
class CastMarketTest(unittest.TestCase):
    def test_candidate_lists_and_market_never_show_region_homes(self):
        sim = region_sim(1)
        self.assertEqual(housing.list_vacancies(sim), REGION_HOMES)
        rich = list(sim.agents.values())
        for a in rich:
            a.savings += 500_000  # every region home would be affordable
        for hh in sim.households.values():
            for h in housing.hunt_candidates(sim, hh) + housing.downsize_candidates(sim, hh):
                self.assertTrue(housing.is_v2_home(h.id), (hh.id, h.id))
            for per_bedroom in (2, 3):
                r = housing.cheapest_rental(sim, hh, per_bedroom=per_bedroom)
                self.assertTrue(r is None or housing.is_v2_home(r.id), (hh.id, r and r.id))
        self.assertTrue(all(housing.is_v2_home(h.id) for h in housing.vacancies(sim)))
        market = housing.market_json(sim)
        for row in market["for_sale"] + market["for_rent"]:
            self.assertTrue(housing.is_v2_home(row["home"]), row)
        self.assertEqual(market, housing.market_json(Simulation(1)))

    def test_house_drought_ignores_region_homes(self):
        sim = region_sim(1)
        housing.list_vacancies(sim)
        self.assertTrue(any(h.listing == "for_sale" and h.tier != "flat" for h in sim.homes.values()
                            if not housing.is_v2_home(h.id)))
        for hid in housing.V2_HOME_IDS:  # no v2 house for sale, and none bought lately
            h = sim.homes[hid]
            if h.household is None and h.listing == "for_sale":
                h.owner, h.listing = "landlord", "for_rent"
            h.history.clear()
        sim.clock.tick = (housing.LANDLORD_SELLS_DAYS + 1) * MINUTES_PER_DAY
        self.assertTrue(housing.house_drought(sim))


@needs_region
@unittest.skipUnless(SLOW, "the 60-day house-hunt soak runs with GOAL_SLOW=1")
class CastMarketSoak(unittest.TestCase):
    def test_sixty_days_no_cast_household_in_a_region_home(self):
        days = _days(60)
        for seed in _seeds("1"):
            with self.subTest(seed=seed):
                sim = region_sim(seed)
                sim.town.warm()
                housing.list_vacancies(sim)
                moves, worst, longest = 0, 0.0, 0
                for _ in range(days):
                    for _ in range(MINUTES_PER_DAY):
                        c = time.process_time()
                        sim.step()
                        worst = max(worst, time.process_time() - c)
                    events, _, _ = sim.drain()
                    moves += sum(e["tag"] in ("home_bought", "home_rented", "evicted", "forced_sale") for e in events)
                    for hh in sim.households.values():
                        self.assertTrue(housing.is_v2_home(hh.home_id), (seed, sim.clock.tick, hh.id, hh.home_id))
                    self.assertEqual(housing.list_vacancies(sim), REGION_HOMES)
                    for a in sim.agents.values():  # region.md 11 R1b 3: no named commute over an hour
                        if a.alive and a.job and a.job.hourly_wage > 0:
                            longest = max(longest, travel.commute_minutes(sim, a))
                print(f"\n[R1b soak] seed {seed}, {days} d: {moves} cast moves, all in the 37; longest commute "
                      f"{longest} min; tick max {worst * 1000:.1f} ms CPU (load {os.getloadavg()[0]:.1f})",
                      file=sys.stderr)
                self.assertLessEqual(longest, 60)
                self.assertLessEqual(worst, TICK_CPU_CAP)


if __name__ == "__main__":
    unittest.main()

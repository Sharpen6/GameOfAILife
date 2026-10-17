"""The 60-person seeded cast, the 37 homes they start in, and the housing data built on them."""

from __future__ import annotations

import collections
import hashlib
import json
import random
import subprocess
import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

from gameofailife import housing, housing_forks
from gameofailife.cast import (CAST_SIZE, MONEY, NAMED, NAMED_HOMES, SAVINGS, SAVINGS_RANGE, SLOTS, TEMPLATES,
                               build_cast, dump)
from gameofailife.clock import Clock
from gameofailife.town import build_map

SEED = 1
ROOT = Path(__file__).resolve().parent.parent
GOLDEN = ROOT / "tests" / "fixtures" / "city_seed1.json"

PLACEMENTS = {  # PLAN 4.3: household -> (home, start, weekly rent)
    "cohen": ("main_20", "let", 420), "levi": ("main_28", "owned", 0), "mizrahi": ("main_13", "let", 520),
    "haddad": ("main_21", "let", 410), "katz": ("park_21", "owned", 0), "friedman": ("park_78", "owned", 0),
    "bendavid": ("birch_court_2b", "let", 220), "peretz": ("cedar_court_1b", "let", 220),
}
NAMED_SAVINGS = {"dana": 15000, "yossi": 5000, "miriam": 2000, "tom": 0, "ari": 2500, "avi": 2500, "rina": 19000,
                 "eli": 0, "shira": 1500, "ruth": 4000, "david": 2000, "omer": 5000, "gal": 1500, "nadia": 3000,
                 "sami": 500}


def make_sim(seed: int = SEED) -> SimpleNamespace:
    """Just enough of a Simulation for the housing helpers: the town, the homes, the cast, a clock and dice."""
    town = build_map(seed)
    sim = SimpleNamespace(town=town, clock=Clock(), logged=[], rng=random.Random(seed), weather="clear",
                          _log_roll=lambda *args, **kw: None)
    sim.homes = housing.build_homes(town)
    sim.lots = housing.build_lots(town, sim.homes)
    sim.agents, sim.households = build_cast(town, sim.homes, seed)
    housing.init(sim)
    sim.event = lambda text, agent=None, kind=None, **kw: sim.logged.append(
        {"text": text, "agent": agent.id if agent else None, **kw})
    return sim


def walk_keys(obj):
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield k
            yield from walk_keys(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from walk_keys(v)


class GoldenTest(unittest.TestCase):
    def test_golden_file_equals_dump_of_seed_1(self):
        self.assertEqual(dump(SEED), GOLDEN.read_text())

    def test_dump_command_writes_the_golden_file(self):
        out = subprocess.run([sys.executable, "-m", "gameofailife.cast", "--dump", "1"], cwd=ROOT,
                             capture_output=True, text=True, check=True).stdout
        self.assertEqual(out, GOLDEN.read_text())

    def test_tiles_sha1_pins_the_map(self):
        golden = json.loads(GOLDEN.read_text())
        rows = build_map(SEED).rows()
        self.assertEqual(golden["tiles_sha1"], hashlib.sha1("\n".join(rows).encode()).hexdigest())
        self.assertEqual(len(golden["people"]), CAST_SIZE)
        self.assertEqual(len(golden["homes"]), 37)
        self.assertEqual(set(golden["people"][0]), {"id", "name", "age", "household", "home", "job_place", "title",
                                                    "wage", "car", "money", "savings"})
        self.assertEqual(set(golden["homes"][0]), {"id", "tier", "bedrooms", "base_value", "rent", "start", "condition"})

    def test_other_seeds_keep_the_named_20_and_the_homes(self):
        one, two = json.loads(dump(1)), json.loads(dump(2))
        named = {row[0] for row in NAMED}
        pick = lambda d: [p for p in d["people"] if p["id"] in named]  # noqa: E731
        self.assertEqual(pick(one), pick(two))
        self.assertEqual(one["homes"], two["homes"])
        self.assertNotEqual([p["name"] for p in one["people"]], [p["name"] for p in two["people"]])
        self.assertNotEqual(one["tiles_sha1"], two["tiles_sha1"])


class CastTest(unittest.TestCase):
    def setUp(self):
        self.town = build_map(SEED)
        self.homes = housing.build_homes(self.town)
        self.agents, self.households = build_cast(self.town, self.homes, SEED)

    def test_sixty_people_38_workers_15_students_7_retirees(self):
        agents = list(self.agents.values())
        self.assertEqual(len(agents), CAST_SIZE)
        self.assertEqual(CAST_SIZE, 60)
        workers = [a for a in agents if a.job and a.job.hourly_wage > 0]
        students = [a for a in agents if a.job and a.job.title == "student"]
        retirees = [a for a in agents if a.job is None]
        self.assertEqual((len(workers), len(students), len(retirees)), (38, 15, 7))
        self.assertEqual(len(self.households), 27)
        self.assertTrue(all(a.luck == 50 for a in agents))
        self.assertEqual(len({a.id for a in agents}), 60)
        self.assertTrue(all(a.id == a.name.split()[0].lower() for a in agents))

    def test_named_20_keep_who_they_are(self):
        for aid, name, age, hid, money, job, car in NAMED:
            a = self.agents[aid]
            with self.subTest(agent=aid):
                self.assertEqual((a.name, a.age, a.household_id, a.money, a.owns_car), (name, age, hid, money, car))
                self.assertEqual(a.job, job)
        self.assertEqual(self.agents["eli"].job.place_id, "grocer")
        self.assertEqual(list(self.agents)[:20], [row[0] for row in NAMED])

    def test_named_placements(self):
        self.assertEqual({hid: home for hid, home in NAMED_HOMES.items()}, {k: v[0] for k, v in PLACEMENTS.items()})
        for hid, (home_id, start, rent) in PLACEMENTS.items():
            hh = self.households[hid]
            with self.subTest(household=hid):
                self.assertEqual(hh.home_id, home_id)
                self.assertEqual(self.homes[home_id].start, start)
                self.assertEqual(hh.weekly_rent, rent)
                place = self.town.places[self.homes[home_id].place]
                for m in hh.member_ids:
                    a = self.agents[m]
                    self.assertEqual((a.inside, a.x, a.y), (place.id, *place.entry))

    def test_home_ids_reach_a_place_only_through_the_homes(self):
        # A flat's home id is not a place id, so sim.home_of must be homes[hh.home_id].place (PLAN 3.10).
        flats = [hh for hh in self.households.values() if self.homes[hh.home_id].unit]
        self.assertIn("bendavid", {hh.id for hh in flats})
        for hh in self.households.values():
            with self.subTest(household=hh.id):
                home = self.homes[hh.home_id]
                self.assertEqual(hh.home_id in self.town.places, home.unit is None)
                self.assertEqual(self.town.places[home.place].kind, "home")
        self.assertNotIn(self.households["bendavid"].home_id, self.town.places)
        self.assertEqual(self.homes[self.households["bendavid"].home_id].place, "birch_court")

    def test_named_savings(self):
        self.assertEqual(SAVINGS, NAMED_SAVINGS)
        for aid, _, age, *_ in NAMED:
            self.assertEqual(self.agents[aid].savings, NAMED_SAVINGS.get(aid, 0) if age >= 18 else 0, aid)

    def test_generated_people_draw_money_and_savings_by_band(self):
        named = {row[0] for row in NAMED}
        bands = {}
        for home_id, roles in TEMPLATES:
            hh = next(h for h in self.households.values() if h.home_id == home_id)
            adults = [r for r in roles if r != "kid"]
            members = [self.agents[m] for m in hh.member_ids]
            self.assertEqual(len(members), len(roles), home_id)
            bands.update({a.id: role for a, role in zip(members, adults + ["kid"] * roles.count("kid"))})
        self.assertEqual(set(bands), set(self.agents) - named)
        for aid, role in bands.items():
            a = self.agents[aid]
            lo, hi = MONEY[role]
            self.assertTrue(lo <= a.money <= hi, (aid, role, a.money))
            if role == "kid":
                self.assertEqual(a.savings, 0)
                self.assertLess(a.age, 18)
            else:
                lo, hi = SAVINGS_RANGE[role]
                self.assertTrue(lo <= a.savings <= hi, (aid, role, a.savings))
                self.assertGreaterEqual(a.age, 66 if role == "retired" else 20)

    def test_every_job_slot_is_filled_once(self):
        named = {row[0] for row in NAMED}
        held = collections.Counter((a.job.title, a.job.place_id, a.job.hourly_wage, a.job.start_hour, a.job.end_hour)
                                   for a in self.agents.values()
                                   if a.id not in named and a.job and a.job.hourly_wage > 0)
        slots = collections.Counter(s[:5] for band in SLOTS.values() for s in band)
        self.assertEqual(held, slots)

    def test_children_are_students_and_retirees_have_no_job(self):
        for a in self.agents.values():
            if not a.is_adult:
                self.assertEqual((a.job.title, a.job.place_id, a.job.hourly_wage, a.job.start_hour),
                                 ("student", "school", 0, 8), a.id)
                self.assertFalse(a.owns_car)
            elif a.job is None:
                self.assertGreaterEqual(a.age, 65, a.id)

    def test_worker_walks_stay_under_50_minutes(self):
        for seed in (1, 2, 3, 4, 5):
            town = build_map(seed)
            homes = housing.build_homes(town)
            agents, households = build_cast(town, homes, seed)
            for a in agents.values():
                if a.job:
                    entry = town.places[homes[households[a.household_id].home_id].place].entry
                    self.assertLessEqual(town.walk_minutes(entry, a.job.place_id), 50, (seed, a.id))

    def test_same_seed_same_cast(self):
        again, _ = build_cast(self.town, housing.build_homes(self.town), SEED)
        self.assertEqual([(a.id, a.age, a.money, a.savings, a.profile.traits, a.job, a.goal)
                          for a in self.agents.values()],
                         [(a.id, a.age, a.money, a.savings, a.profile.traits, a.job, a.goal) for a in again.values()])

    def test_build_cast_reads_but_never_changes_the_homes(self):
        homes = housing.build_homes(self.town)
        before = [vars(h).copy() for h in homes.values()]
        build_cast(self.town, homes, SEED)
        self.assertEqual([vars(h) for h in homes.values()], before)

    def test_build_cast_is_fast_on_a_warm_map(self):
        self.town.warm()
        homes = housing.build_homes(self.town)
        t0 = time.perf_counter()
        build_cast(self.town, homes, SEED)
        elapsed = time.perf_counter() - t0
        self.assertLess(elapsed, 0.2, f"build_cast took {elapsed:.3f} s")


class StockTest(unittest.TestCase):
    """PLAN 4.2 and decision 37: the homes everyone starts in, and what is free."""

    def setUp(self):
        self.sim = make_sim()
        self.homes = self.sim.homes

    def test_37_homes_in_place_order(self):
        tiers = collections.Counter(h.tier for h in self.homes.values())
        self.assertEqual(tiers, {"flat": 18, "house": 15, "big_house": 4})
        places = [h.place for h in self.homes.values()]
        self.assertEqual(list(dict.fromkeys(places)), [p.id for p in self.sim.town.places.values() if p.kind == "home"])
        for block in ("birch_court", "cedar_court", "elm_court"):
            units = [h.unit for h in self.homes.values() if h.place == block]
            self.assertEqual(units, ["1A", "1B", "2A", "2B", "3A", "3B"])
        self.assertEqual(self.homes["birch_court_2b"].name, "Birch Court, flat 2B")
        self.assertEqual(self.homes["main_20"].name, "20 Main Street")
        self.assertEqual(self.homes["main_20"].unit, None)

    def test_prices_and_rents(self):
        for h in self.homes.values():
            with self.subTest(home=h.id):
                if h.rent:
                    self.assertEqual(h.base_value, 40 * h.rent)
                    self.assertIn(h.start, ("let", "for_rent"))
                else:
                    self.assertIn(h.start, ("owned", "for_sale"))
                if h.tier == "flat":
                    self.assertEqual(h.rent, {1: 180, 2: 220, 3: 260}[h.bedrooms])
                if h.tier == "big_house":
                    self.assertEqual(h.rent, 0)

    def test_start_conditions(self):
        lots = self.sim.lots
        self.assertEqual(len(lots), 22)
        self.assertEqual((lots["birch_court"].condition, lots["cedar_court"].condition, lots["elm_court"].condition),
                         (84, 71, 62))
        self.assertEqual(lots["river_28"].condition, 30)
        self.assertEqual(lots["main_28"].condition, 66)
        for lot in lots.values():
            self.assertEqual(lot.reported, housing.stage_of(lot.condition))

    def test_stock_rules(self):
        vacant = [h for h in self.homes.values() if h.household is None]
        self.assertEqual(len(vacant), 10)
        self.assertGreaterEqual(len(vacant) / len(self.homes), 0.25)
        to_let = [h for h in vacant if h.tier == "flat" and h.listing == "for_rent"]
        self.assertGreaterEqual(len(to_let), 3)
        self.assertEqual(sorted(h.bedrooms for h in to_let), [1, 2, 2, 3])
        houses_for_sale = [h for h in vacant if h.tier == "house" and h.listing == "for_sale"]
        self.assertGreaterEqual(len(houses_for_sale), 2)
        self.assertTrue(any(self.sim.lots[h.place].condition < 40 for h in houses_for_sale))
        self.assertEqual(len([h for h in vacant if h.tier == "big_house" and h.listing == "for_sale"]), 2)
        crowded = [hh.home_id for hh in self.sim.households.values() if housing.crowded(self.sim, hh)]
        self.assertEqual(crowded, ["cedar_court_2a"])

    def test_who_owns_what(self):
        houses = [h for h in self.homes.values() if h.tier == "house"]
        self.assertEqual(sum(h.owner == "landlord" for h in houses), 7)
        self.assertEqual(sum(h.owner == h.household and h.household is not None for h in houses), 5)
        self.assertEqual(sum(h.owner == "market" for h in houses), 3)
        self.assertEqual({h.id for h in self.homes.values() if h.owner == "market"},
                         {"river_12", "river_28", "main_55", "park_66", "park_104"})
        for h in self.homes.values():
            with self.subTest(home=h.id):
                if h.start == "owned":
                    self.assertEqual(h.owner, h.household)
                    self.assertEqual(self.sim.households[h.household].weekly_rent, 0)
                elif h.start == "let":
                    self.assertEqual(h.owner, "landlord")
                    self.assertEqual(self.sim.households[h.household].weekly_rent, h.rent)
                else:
                    self.assertIsNone(h.household)
                    self.assertEqual(h.listing, h.start)
        homes_of = collections.Counter(hh.home_id for hh in self.sim.households.values())
        self.assertEqual(max(homes_of.values()), 1)
        self.assertEqual(len(homes_of), 27)

    def test_templates_and_named_homes_cover_the_occupied_homes(self):
        occupied = {h.id for h in self.homes.values() if h.start in ("let", "owned")}
        self.assertEqual(occupied, {home for home, _ in TEMPLATES} | set(NAMED_HOMES.values()))


class HousingDataTest(unittest.TestCase):
    """Group A: the helpers and serializers the engine, the dashboard and controllers read."""

    def setUp(self):
        self.sim = make_sim()

    def test_value_and_sale(self):
        self.assertEqual(housing.value(self.sim, "river_28"), 14550)  # PLAN 4.2's worked example
        self.assertEqual(housing.value(self.sim, "main_55"), 18100)
        self.assertEqual(housing.value(self.sim, "main_28"), 13650)
        self.assertEqual(housing.sale_proceeds(self.sim, "main_28"), round(13650 * 0.95))
        self.sim.lots["park_66"].condition = 100
        self.assertEqual(housing.value(self.sim, "park_66"), 46000)
        self.sim.lots["park_66"].condition = 0
        self.assertEqual(housing.value(self.sim, "park_66"), 32200)

    def test_stages(self):
        self.assertEqual([housing.stage_of(c) for c in (100, 80, 79.9, 60, 40, 39.5, 20, 19, 0)], [0, 0, 1, 1, 2, 3, 3, 4, 4])
        self.assertEqual([housing.stage_name(i) for i in range(5)], ["kept", "worn", "shabby", "neglected", "derelict"])

    def test_household_money_and_names(self):
        hh = self.sim.households
        self.assertEqual(housing.funds(self.sim, hh["cohen"]), 21500)
        self.assertEqual(housing.household_name(self.sim, hh["cohen"]), "The Cohens")
        self.assertEqual(housing.household_name(self.sim, hh["katz"]), "The Katzes")
        self.assertEqual(housing.household_name(self.sim, hh["bendavid"]), "Ari Ben-David")
        self.assertEqual(housing.tenure(self.sim, hh["levi"]), "owned")
        self.assertEqual(housing.weekly_cost(self.sim, hh["levi"]), 76)
        self.assertEqual(housing.weekly_cost(self.sim, hh["cohen"]), 420)
        hh["cohen"].hardship_rent = 60
        self.assertEqual(housing.weekly_cost(self.sim, hh["cohen"]), 60)
        hh["levi"].tax_deferred = True
        self.assertEqual(housing.weekly_cost(self.sim, hh["levi"]), 0)
        self.assertEqual(housing.comfort(self.sim, hh["levi"]), 1.0)
        self.assertAlmostEqual(housing.comfort(self.sim, hh["rosen"]), 0.95 * 1.0 * 0.9)

    def test_worth(self):
        a = self.sim.agents
        self.assertEqual(housing.worth_parts(self.sim, a["dana"]), {"cash": 900, "savings": 15000, "home": 0})
        self.assertEqual(housing.worth_parts(self.sim, a["miriam"]), {"cash": 1500, "savings": 2000, "home": 6825})
        self.assertEqual(housing.net_worth(self.sim, a["miriam"]), 10325)
        self.assertEqual(housing.worth_parts(self.sim, a["yael"])["home"], 0)  # children hold no share
        a["tom"].goal["saved"] = 120.4
        self.assertEqual(housing.worth_parts(self.sim, a["tom"])["savings"], 120)

    def test_pay_household(self):
        hh = self.sim.households["cohen"]
        dana, yossi, noa = (self.sim.agents[m] for m in hh.member_ids)
        housing.pay_household(self.sim, hh, 2150)
        self.assertAlmostEqual(housing.funds(self.sim, hh), 21500 - 2150)
        self.assertAlmostEqual(dana.savings, 15000 - 2150 * 15900 / 21500)  # in proportion to funds, savings first
        self.assertEqual((dana.money, yossi.money, noa.money), (900, 600, 20))
        housing.pay_household(self.sim, hh, -1000)  # money in goes to savings, equally
        self.assertAlmostEqual(housing.funds(self.sim, hh), 21500 - 1150)
        for a in (dana, yossi):
            a.money, a.savings = -10.0, 0.0
        housing.pay_household(self.sim, hh, 100)
        self.assertEqual((dana.money, yossi.money), (-60, -60))  # all broke: split equally, out of money

    def test_serializers_follow_the_contract(self):
        sim = self.sim
        tom = sim.agents["tom"]
        home = housing.possessions_json(sim, tom)["home"]
        self.assertEqual(set(home), {"id", "place", "name", "tier", "tier_label", "district", "bedrooms", "tenure",
                                     "landlord", "weekly_rent", "property_tax", "weekly_cost", "value", "condition",
                                     "stage", "stage_name", "comfort", "moved_in", "emergency"})
        self.assertEqual((home["id"], home["tenure"], home["property_tax"], home["value"], home["stage_name"]),
                         ("main_28", "owned", 76, 13650, "worn"))
        self.assertEqual(set(housing.possessions_json(sim, tom)), {"home", "car", "phone", "money", "savings",
                                                                     "household_funds", "savings_goal",
                                                                     "groceries_at_home"})
        you = housing.fork_you(sim, sim.agents["ari"])
        self.assertEqual(you["household_funds"], 2912)
        self.assertEqual(set(you["home"]), {"name", "tier", "tenure", "weekly_cost", "condition", "stage_name", "value"})
        self.assertEqual(set(housing.agent_page_fields(sim, tom)), {"savings", "household_funds", "net_worth",
                                                                    "worth_parts", "home_history"})
        lots, homes = housing.lots_json(sim), housing.homes_json(sim)
        self.assertEqual(lots["cedar_court"], {"condition": 71, "stage": 1, "works": False, "moving": False})
        self.assertEqual(homes["park_66"], {"hh": None, "owner": "market", "listing": "for_sale", "price": 44900,
                                            "value": 44900, "emergency": None})
        self.assertEqual(homes["main_39"]["price"], 330)
        self.assertEqual(homes["main_20"], {"hh": "cohen", "owner": "landlord", "listing": None, "price": None,
                                            "value": housing.value(sim, "main_20"), "emergency": None})
        town_homes = housing.town_homes_json(sim)
        self.assertEqual(town_homes[3], {"id": "birch_court_2b", "place": "birch_court", "unit": "2B",
                                         "name": "Birch Court, flat 2B", "tier": "flat", "bedrooms": 2,
                                         "base_value": 8800, "rent": 220})
        self.assertEqual(housing.town_housing_json()["tiers"]["big_house"], {"label": "big house", "rank": 3})
        self.assertEqual(housing.household_summary(sim, sim.households["levi"])["tier_label"], "house")
        market = housing.market_json(sim)
        self.assertEqual([r["home"] for r in market["for_sale"]], ["river_12", "river_28", "main_55", "park_66", "park_104"])
        self.assertEqual(len(market["for_rent"]), 5)
        sim.homes["park_66"].under_offer_until = sim.clock.tick + 60
        self.assertIsNone(housing.homes_json(sim)["park_66"]["listing"])
        self.assertNotIn("park_66", [r["home"] for r in housing.market_json(sim)["for_sale"]])
        page = housing.home_page(sim, "cedar_court_2a")
        self.assertEqual((page["household_name"], page["residents"], page["stage_name"]),
                         ("The Rosens", ["Gil Rosen", "Mor Rosen", "Tomer Rosen"], "worn"))
        self.assertIsNone(housing.home_page(sim, "home_levi"))

    def test_a_pending_emergency_never_shows(self):
        sim = self.sim
        tom = sim.agents["tom"]
        sim.homes["main_28"].pending_emergency = {"kind": "leak", "due": sim.clock.tick + 90}

        def everything():
            return [housing.homes_json(sim), housing.lots_json(sim), housing.possessions_json(sim, tom),
                    housing.fork_you(sim, tom), housing.agent_page_fields(sim, tom), housing.market_json(sim),
                    housing.home_page(sim, "main_28"), housing.town_homes_json(sim)]

        self.assertTrue({"pending_emergency", "due"}.isdisjoint(walk_keys(everything())))
        self.assertIsNone(housing.homes_json(sim)["main_28"]["emergency"])
        self.assertIsNone(housing.possessions_json(sim, tom)["home"]["emergency"])
        self.assertIsNone(housing.home_page(sim, "main_28")["emergency"])
        sim.homes["main_28"].emergency = {"kind": "leak", "since": sim.clock.tick}
        self.assertEqual(housing.homes_json(sim)["main_28"]["emergency"], "leak")
        live = housing.possessions_json(sim, tom)["home"]["emergency"]
        self.assertEqual(live, {"kind": "leak", "text": housing.EMERGENCY_TEXT["leak"], "since": sim.clock.stamp()})
        self.assertTrue({"pending_emergency", "due"}.isdisjoint(walk_keys(everything())))


class HousingHooksTest(unittest.TestCase):
    """The hooks the engine calls, on a quiet first morning (P2 fills them; tests/test_housing.py pins the rest)."""

    def setUp(self):
        self.sim = make_sim()

    def test_weekly_charges_owners_pay_tax_not_rent(self):
        sim = self.sim
        before = {a.id: a.money for a in sim.agents.values()}
        housing.weekly_charges(sim)
        a = sim.agents
        self.assertEqual(before["dana"] - a["dana"].money, 420 / 2 + 80 + 40)  # renters split the rent
        self.assertEqual(before["yossi"] - a["yossi"].money, 420 / 2 + 80)
        tax = housing.property_tax(sim.homes["main_28"])  # the Levis own 28 Main Street
        self.assertEqual(before["tom"] - a["tom"].money, tax / 2 + 80)
        self.assertEqual(before["noa"], a["noa"].money)
        paid = [e for e in sim.logged if e["tag"] == "bills_paid"]
        self.assertEqual(len(paid), 27)
        self.assertTrue(all(e["place"] in sim.town.places for e in paid))
        self.assertIn(f"The Levis paid ${tax} property tax and $160 in bills.", [e["text"] for e in paid])
        self.assertIn("The Cohens paid $420 rent and $200 in bills.", [e["text"] for e in paid])
        red = [e for e in sim.logged if e["tag"] == "in_the_red"]
        self.assertTrue(all(sim.agents[e["agent"]].money < 0 for e in red))

    def test_quiet_hooks(self):
        sim, dana = self.sim, self.sim.agents["dana"]
        self.assertIsNone(housing.nightly(sim))
        self.assertIsNone(housing.tick(sim))
        self.assertIsNone(housing.on_death(sim, dana))
        self.assertIsNone(housing.apply_extra(sim, dana, None, None))
        self.assertTrue(housing.apply_effect(sim, dana, "home_condition", 5))
        self.assertFalse(housing.apply_effect(sim, dana, "not_housing", 5))
        self.assertEqual(housing.activity_gain_scale(sim, dana), 1.0)
        thrift = dana.profile.traits["thrift"]
        own = dana.money + dana.savings  # what she pays with (tests/test_housing.py pins the -2 beyond reach)
        self.assertAlmostEqual(housing.afford_score(sim, dana, SimpleNamespace(cost=1000)), -1000 / own * thrift)
        self.assertAlmostEqual(housing.afford_score(sim, dana, SimpleNamespace(cost=90)), -90 / own * thrift)
        dana.money, dana.savings = 10, 0
        self.assertAlmostEqual(housing.afford_score(sim, dana, SimpleNamespace(cost=5)), -5 / 50 * thrift)
        for builder in (housing_forks.repair_fork, housing_forks.housing_trouble_fork, housing_forks.house_hunt_fork,
                        housing_forks.upkeep_fork):
            self.assertIsNone(builder(sim, dana))
        self.assertEqual(housing_forks.MAJOR_KINDS, {"house_hunt", "housing_trouble"})

    def test_extra_activities_build_as_sim_activities(self):
        from gameofailife.sim import Activity

        self.assertEqual(list(housing.ACTIVITIES_EXTRA), ["move_house", "viewing", "let_builders_in", "diy", "tidy",
                                                          "fix_it", "help_out", "odd_jobs"])
        for name, spec in housing.ACTIVITIES_EXTRA.items():
            act = Activity(spec["minutes"], dict(spec["gains"]), spec["inside"])
            self.assertGreater(act.minutes, 0, name)
        self.assertFalse(housing.ACTIVITIES_EXTRA["odd_jobs"]["inside"])


if __name__ == "__main__":
    unittest.main()

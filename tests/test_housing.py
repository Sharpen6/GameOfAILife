"""Housing mechanics: affordability, moves, decay and stages, emergencies, the Sunday charges, arrears, hardship,
forced moves, the four housing forks and how the engine plays them.

Most tests run on `FakeSim`, the town, homes and seed-1 cast with the engine calls housing makes recorded, so
they pin the mechanics exactly. `EngineTest` and `ForkShapeTest` run the real Simulation and need the engine
hooks of PLAN 3.10/3.11 (P0c).
"""

from __future__ import annotations

import collections
import json
import math
import os
import random
import re
import shutil
import subprocess
import unittest
from pathlib import Path
from types import SimpleNamespace

from gameofailife import chronicle, forks, housing, housing_forks, travel
from gameofailife.agent import RelationKind
from gameofailife.cast import build_cast
from gameofailife.clock import Clock
from gameofailife.housing import DAY
from gameofailife.town import build_map

SEED = 1
ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which("node")
SECRET = {"pending_emergency", "due", "p", "base_p", "roll", "hit", "odds", "outcomes", "scores", "valence"}


def at(day: int, hour: int, minute: int = 0) -> int:
    """The tick of a day (0 is the first Monday) and time."""
    return day * DAY + hour * 60 + minute


SUNDAY = at(6, 23)  # the first Sunday charge
MONDAY_EVENING = at(7, 18, 30)  # the household window after it
SATURDAY = at(5, 10)


class Dice(random.Random):
    """A random.Random whose random() hands out queued values first (choice and randrange are unaffected)."""

    def __init__(self, seed: int = SEED, rolls=()):
        super().__init__(seed)
        self.queue = list(rolls)

    def random(self):
        return self.queue.pop(0) if self.queue else super().random()

    def getrandbits(self, k):  # keeps choice/randrange on getrandbits, not on the queued random()
        return super().getrandbits(k)


class FakeSim:
    """Just enough of a Simulation for housing: the town, homes, lots, cast, clock and dice, with the engine calls
    housing makes (events, plans, rolls, meetings) recorded."""

    def __init__(self, seed: int = SEED, tick: int | None = None):
        self.town = build_map(seed)
        self.clock = Clock() if tick is None else Clock(tick)
        self.rng = Dice(seed)
        self.weather = "clear"
        self.homes = housing.build_homes(self.town)
        self.lots = housing.build_lots(self.town, self.homes)
        self.agents, self.households = build_cast(self.town, self.homes, seed)
        housing.init(self)
        self.logged: list[dict] = []
        self.plans: list[tuple[str, list]] = []
        self.rolls: list[dict] = []
        self.met: list[tuple[str, list | None]] = []
        self.busy: set[str] = set()  # characters not free to drop what they are doing

    def event(self, text, agent=None, kind=None, *, tag="other", importance=None, agents=None, place=None,
              remember=True):
        assert tag in chronicle.EVENT_TAGS, tag
        assert place is None or place in self.town.places, place
        self.logged.append({"text": text, "agent": agent.id if agent else None, "tag": tag, "agents": agents or [],
                            "place": place})

    def household(self, agent):
        return self.households[agent.household_id]

    def home_of(self, agent):
        return self.homes[self.household(agent).home_id].place

    def on_shift_now(self, agent):
        return False

    def _interruptible(self, agent):
        return agent.id not in self.busy

    def start_plan(self, agent, steps, vehicle="walk"):
        self.plans.append((agent.id, list(steps)))

    def _meet_someone(self, agent, pool=None):
        self.met.append((agent.id, None if pool is None else [a.id for a in pool]))

    def _log_roll(self, agent, what, p, roll, base=None):
        self.rolls.append({"agent": agent.id, "what": what, "p": p, "roll": roll, "base_p": base})

    def tagged(self, tag):
        return [e for e in self.logged if e["tag"] == tag]

    def texts(self, tag, who: str | None = None, place: str | None = None):
        """The texts of the events with this tag, about a character or at a place when given."""
        return [e["text"] for e in self.tagged(tag) if (who is None or who == e["agent"] or who in e["agents"])
                and (place is None or e["place"] == place)]


def walk_keys(obj):
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield k
            yield from walk_keys(v)
    elif isinstance(obj, (list, tuple)):
        for v in obj:
            yield from walk_keys(v)


def set_funds(sim, hh_id: str, total: float) -> None:
    """Give a household exactly `total` in funds: all of it in the first adult's money, no savings anywhere."""
    adults = housing.adults(sim, sim.households[hh_id])
    for a in adults:
        a.money, a.savings = 0.0, 0.0
    adults[0].money = float(total)


def before_charges(sim, hh_id: str, after: float) -> None:
    """Fund a household so that it holds `after` once this Sunday's rent or tax and bills are paid."""
    hh = sim.households[hh_id]
    set_funds(sim, hh_id, after + housing.weekly_cost(sim, hh) + housing.bills(sim, hh))


def lonely(sim, agent_id: str) -> None:
    """Drop every relationship outside the character's household."""
    agent = sim.agents[agent_id]
    members = sim.households[agent.household_id].member_ids
    agent.relationships = {k: v for k, v in agent.relationships.items() if k in members}


def gone(sim, agent_id: str) -> None:
    """A character dies, as far as the household is concerned (sim._die without the rest)."""
    agent = sim.agents[agent_id]
    agent.alive = False
    hh = sim.households[agent.household_id]
    hh.member_ids = [m for m in hh.member_ids if m != agent_id]


def hide(sim, *home_ids: str, days: int = 30) -> None:
    """Take listings off the market for a while (as if under offer)."""
    for hid in home_ids:
        sim.homes[hid].under_offer_until = sim.clock.tick + days * DAY


def labels(fork):
    return [o.label for o in fork.options]


# --- affordability --------------------------------------------------------------------------

class AffordabilityTest(unittest.TestCase):
    def setUp(self):
        self.sim = FakeSim()

    def test_tick_0_candidates(self):
        sim = self.sim
        self.assertIn("river_28", [h.id for h in housing.hunt_candidates(sim, sim.households["cohen"])])
        self.assertIn("main_55", [h.id for h in housing.hunt_candidates(sim, sim.households["mizrahi"])])

    def test_living_costs_count_retirees_double(self):
        sim, hh = self.sim, self.sim.households
        self.assertEqual(housing.living(sim, hh["tal"]), housing.LIVING_PER_RETIREE)  # Lea, 67, retired
        self.assertEqual(housing.living(sim, hh["cohen"]), 3 * housing.LIVING_PER_PERSON)
        self.assertEqual(housing.living(sim, hh["levi"]), housing.LIVING_PER_RETIREE + housing.LIVING_PER_PERSON)
        self.assertEqual(housing.weekly_outgo(sim, hh["tal"]), 180 + 80 + 150)

    def test_outgo_counts_the_commute(self):
        sim, cohen = self.sim, self.sim.households["cohen"]
        commute = sum(travel.weekly_commute_cost(sim, a) for a in housing.adults(sim, cohen))
        self.assertGreater(commute, 0)  # Dana drives to work
        self.assertEqual(housing.weekly_outgo(sim, cohen),
                         420 + housing.bills(sim, cohen) + housing.living(sim, cohen) + commute)
        yossi = sim.agents["yossi"]
        before, fare = housing.weekly_outgo(sim, cohen), travel.weekly_commute_cost(sim, yossi)  # on foot or the bus
        yossi.owns_car = True
        from gameofailife.sim import CAR_BILL
        self.assertEqual(housing.weekly_outgo(sim, cohen) - before,
                         CAR_BILL + travel.weekly_commute_cost(sim, yossi) - fare)

    def test_a_rental_needs_the_income_to_carry_it(self):
        sim, tal = self.sim, self.sim.households["tal"]
        sim.agents["lea"].savings = 100000.0  # rich in savings, but a $400 pension
        self.assertLess(housing.weekly_income(sim, tal), housing.weekly_outgo(sim, tal, "main_39"))
        self.assertFalse(housing.affordable(sim, tal, "main_39"))
        self.assertTrue(housing.affordable(sim, tal, "river_12"))  # buying needs no weekly income test
        barak = sim.households["barak"]
        self.assertGreaterEqual(housing.weekly_income(sim, barak), housing.weekly_outgo(sim, barak, "main_39"))
        self.assertTrue(housing.affordable(sim, barak, "main_39"))

    def test_the_reserve_after_a_purchase(self):
        sim, cohen = self.sim, self.sim.households["cohen"]
        price = housing.value(sim, "river_28") + housing.MOVING_COST + housing.reno_cost(sim, "river_28")
        reserve = housing.RESERVE_WEEKS * housing.weekly_outgo(sim, cohen, "river_28")
        set_funds(sim, "cohen", price + reserve)
        self.assertTrue(housing.affordable(sim, cohen, "river_28"))
        set_funds(sim, "cohen", price + reserve - 1)
        self.assertFalse(housing.affordable(sim, cohen, "river_28"))
        set_funds(sim, "cohen", 0.9 * housing.value(sim, "river_28") + 150 + housing.reno_cost(sim, "river_28")
                  + reserve)
        self.assertTrue(housing.affordable(sim, cohen, "river_28", factor=0.9))  # a 90% deal needs 10% less

    def test_upgrades(self):
        sim, hh = self.sim, self.sim.households
        self.assertFalse(housing.is_upgrade(sim, hh["katz"], "elm_court_1a"))  # never down a tier
        self.assertTrue(housing.is_upgrade(sim, hh["rosen"], "elm_court_2b"))  # crowded: more bedrooms
        self.assertTrue(housing.is_upgrade(sim, hh["cohen"], "river_28"))  # owning instead of renting
        sim.homes["cedar_court_2a"].owner = "rosen"  # a crowded owner may still rent somewhere bigger
        self.assertTrue(housing.is_upgrade(sim, hh["rosen"], "elm_court_2b"))

    def test_retirees_may_buy_bigger_but_not_a_household_that_downsized(self):
        sim, hh = self.sim, self.sim.households
        set_funds(sim, "segal", 60000)  # retired, in a two-bedroom house, with the money for better
        self.assertEqual([h.id for h in housing.hunt_candidates(sim, hh["segal"])],
                         ["river_28", "main_55", "park_66", "park_104"])
        set_funds(sim, "tal", 60000)  # Lea, retired, in a one-bedroom flat (66 Park Avenue costs more than a pension)
        self.assertEqual([h.id for h in housing.hunt_candidates(sim, hh["tal"])],
                         ["river_12", "river_28", "main_55", "park_104"])
        peretz = hh["peretz"]
        set_funds(sim, "peretz", 60000)
        self.assertIn("river_28", [h.id for h in housing.hunt_candidates(sim, peretz)])  # three bedrooms for two
        peretz.cooldowns["downsized"] = sim.clock.tick + DAY  # just downsized
        self.assertEqual([h.id for h in housing.hunt_candidates(sim, peretz)], ["river_12", "main_39"])  # two
        sim.clock.tick += DAY
        self.assertIn("river_28", [h.id for h in housing.hunt_candidates(sim, peretz)])

    def test_owners_never_sell_up_to_rent(self):
        """The first evening: the Cohens and the Mizrahis buy, and 20 and 13 Main Street go back to let. Both
        are worth 15% more than the Levis' and the Elbazes' own homes, but an owner who isn't crowded looks
        only at homes for sale (housing.md 11, point 4): selling to rent dearer is never a step up."""
        sim, hh = self.sim, self.sim.households
        for who, to in (("cohen", "river_28"), ("mizrahi", "main_55")):
            self.assertTrue(housing.move_household(sim, hh[who], to, "buy"))
        rentals = [h.id for h in housing.vacancies(sim, "for_rent")]
        for owner, rental in (("levi", "main_20"), ("elbaz", "main_13")):
            self.assertIn(rental, rentals)
            self.assertFalse(housing.crowded(sim, hh[owner]))
            self.assertGreaterEqual(housing.value(sim, rental), 1.15 * housing.value(sim, hh[owner].home_id))
            self.assertFalse(housing.is_upgrade(sim, hh[owner], rental), owner)
            self.assertEqual([h.id for h in housing.hunt_candidates(sim, hh[owner]) if not housing.buys(h)], [],
                             owner)
        for owner in ("levi", "elbaz", "segal", "katz", "friedman", "ezra", "halabi"):  # every owner, all evening
            self.assertTrue(all(housing.buys(h) for h in housing.hunt_candidates(sim, hh[owner])), owner)
        self.assertTrue(housing.is_upgrade(sim, hh["amar"], "main_20"))  # a renter still moves up by 15%


# --- moves ----------------------------------------------------------------------------------

class MoveTest(unittest.TestCase):
    def setUp(self):
        self.sim = FakeSim(tick=at(0, 18, 30))

    def test_an_owner_sells_lists_and_buys(self):
        sim, levi = self.sim, self.sim.households["levi"]
        sale, price = housing.sale_proceeds(sim, "main_28"), housing.value(sim, "river_12")
        self.assertEqual(sale, housing._int(housing.value(sim, "main_28") * 0.95))
        funds = housing.funds(sim, levi)
        self.assertTrue(housing.move_household(sim, levi, "river_12", "buy", decider=sim.agents["tom"]))
        old, new = sim.homes["main_28"], sim.homes["river_12"]
        self.assertEqual((old.owner, old.listing, old.household), ("market", "for_sale", None))
        self.assertEqual((new.owner, new.listing, new.household), ("levi", None, "levi"))
        self.assertEqual(levi.home_id, "river_12")
        self.assertEqual(levi.weekly_rent, 0)
        self.assertEqual(levi.moved_tick, sim.clock.tick)
        self.assertAlmostEqual(housing.funds(sim, levi), funds + sale - price - housing.MOVING_COST)
        self.assertEqual([(r["event"], r["home"], r["price"]) for r in levi.history],
                         [("sold", "main_28", sale), ("bought", "river_12", price)])
        self.assertEqual([r["event"] for r in old.history], ["sold"])
        self.assertEqual(sim.lots["river_12"].moving_until, sim.clock.tick + housing.MOVE_VAN_MINUTES)
        listed = {row["home"]: row["price"] for row in housing.market_json(sim)["for_sale"]}
        self.assertEqual(listed["main_28"], housing.value(sim, "main_28"))  # for sale at its value
        self.assertNotIn("river_12", listed)
        self.assertEqual(sim.texts("home_bought"),
                         [f"The Levis buy 12 River Road (house, {housing.district_name(sim, new)}) for ${price:,}, "
                          f"selling 28 Main Street for ${sale:,}."])
        self.assertEqual(sorted(p[0] for p in sim.plans), ["miriam", "tom"])
        self.assertTrue(all(p[1] == [("move_house", "river_12")] for p in sim.plans))

    def test_a_renter_hands_the_old_home_back(self):
        sim, cohen = self.sim, self.sim.households["cohen"]
        sim.busy.add("noa")  # at a friend's: she goes to the new home the next time she heads home
        self.assertTrue(housing.move_household(sim, cohen, "river_28", "buy", decider=sim.agents["dana"],
                                               plan_decider=False))
        old = sim.homes["main_20"]
        self.assertEqual((old.owner, old.listing, old.household), ("landlord", "for_rent", None))
        self.assertEqual(cohen.weekly_rent, 0)
        self.assertEqual([p[0] for p in sim.plans], ["yossi"])  # not the decider, not the busy child
        self.assertEqual([r["event"] for r in old.history], ["left"])
        self.assertTrue(any("Moved to 28 River Road." in m for m in sim.agents["yossi"].memory))

    def test_a_landlord_sells_a_let_house_when_no_house_is_for_sale(self):
        """The four houses for sale bar one go on day 20; two weeks later the Cohens buy the last one, and the
        landlord puts the house they rented on the market instead of letting it again. Once that one is bought, the
        next let house left empty is let again, until two more weeks pass without a house for sale."""
        sim = self.sim
        sim.clock.tick = at(20, 18, 30)
        for hh_id, home_id in (("weiss", "river_12"), ("shapiro", "main_55"), ("peretz", "park_66"),
                               ("amar", "park_104")):
            set_funds(sim, hh_id, 60000)
            self.assertTrue(housing.move_household(sim, sim.households[hh_id], home_id, "buy"))
        self.assertEqual([h.id for h in housing.vacancies(sim, "for_sale") if h.tier != "flat"], ["river_28"])
        sim.clock.tick += housing.LANDLORD_SELLS_DAYS * DAY - 1
        self.assertFalse(housing.house_drought(sim, "river_28"))  # a house was bought less than 14 days ago
        sim.clock.tick += 1
        self.assertFalse(housing.house_drought(sim))  # 28 River Road is for sale
        self.assertTrue(housing.house_drought(sim, "river_28"))  # and nothing else
        self.assertTrue(housing.move_household(sim, sim.households["cohen"], "river_28", "buy"))
        main_20 = sim.homes["main_20"]
        self.assertEqual((main_20.owner, main_20.listing, main_20.household), ("market", "for_sale", None))
        self.assertEqual(sim.texts("home_listed", place="main_20"),
                         [f"Millbrook Homes puts 20 Main Street up for sale (${housing.value(sim, 'main_20'):,})."])
        self.assertIn("main_20", [h.id for h in housing.vacancies(sim, "for_sale")])
        self.assertFalse(housing.house_drought(sim))
        set_funds(sim, "gold", 60000)
        self.assertTrue(housing.move_household(sim, sim.households["gold"], "main_20", "buy"))
        self.assertTrue(housing.move_household(sim, sim.households["golan"], "main_39", "rent"))
        main_47 = sim.homes["main_47"]
        self.assertEqual((main_47.owner, main_47.listing), ("landlord", "for_rent"))  # 20 Main Street just sold
        self.assertEqual(len(sim.texts("home_listed")), 1)
        sim.clock.tick += housing.LANDLORD_SELLS_DAYS * DAY
        self.assertTrue(housing.house_drought(sim))

    def test_no_landlord_sale_in_the_first_two_weeks_or_for_a_flat(self):
        sim = self.sim
        for h in housing.vacancies(sim, "for_sale"):  # every home for sale let instead: no house on the market
            h.owner, h.listing = "landlord", "for_rent"
        sim.clock.tick = housing.LANDLORD_SELLS_DAYS * DAY - 1
        self.assertFalse(housing.house_drought(sim))
        sim.clock.tick += 1
        self.assertTrue(housing.house_drought(sim))
        barak = sim.households["barak"]  # renting a flat
        self.assertTrue(housing.move_household(sim, barak, "main_39", "rent"))
        self.assertEqual(sim.homes["elm_court_2a"].listing, "for_rent")  # flats are always let
        self.assertEqual(sim.texts("home_listed"), [])

    def test_renting_sets_the_rent(self):
        sim, barak = self.sim, self.sim.households["barak"]
        self.assertTrue(housing.move_household(sim, barak, "main_39", "rent", factor=0.9))
        self.assertEqual(barak.weekly_rent, 297)
        self.assertEqual(sim.homes["main_39"].owner, "landlord")
        self.assertEqual(sim.texts("home_rented"), ["Sara Barak moves into 39 Main Street (house) at $297/week."])

    def test_too_late(self):
        sim = self.sim
        self.assertTrue(housing.move_household(sim, sim.households["mizrahi"], "main_55", "buy"))
        cohen = sim.households["cohen"]
        funds = housing.funds(sim, cohen)
        self.assertFalse(housing.move_household(sim, cohen, "main_55", "buy"))
        self.assertEqual(sim.texts("too_late"), ["The Cohens were too late: 55 Main Street has been sold."])
        self.assertEqual((cohen.home_id, housing.funds(sim, cohen)), ("main_20", funds))
        set_funds(sim, "cohen", 1000)
        self.assertFalse(housing.move_household(sim, cohen, "river_28", "buy"))
        self.assertEqual(sim.texts("too_late")[-1], "The Cohens can't raise the money for 28 River Road after all.")

    def test_the_move_extra_and_a_failed_move(self):
        sim, dana = self.sim, self.sim.agents["dana"]
        fork = SimpleNamespace(kind="house_hunt")
        opt = SimpleNamespace(extra={"move": "river_28", "how": "buy"}, outcomes=["promised"])
        housing.apply_extra(sim, dana, fork, opt)
        self.assertEqual(sim.households["cohen"].home_id, "river_28")
        self.assertEqual(opt.outcomes, ["promised"])
        tom = sim.agents["tom"]
        tom.plan = [("move_house", "river_28")]
        opt = SimpleNamespace(extra={"move": "river_28", "how": "buy"}, steps=[("move_house", "river_28")],
                              outcomes=["promised"])
        housing.apply_extra(sim, tom, fork, opt)
        self.assertEqual(sim.households["levi"].home_id, "main_28")
        self.assertEqual(opt.steps, [("idle", "home")])  # nothing to move into: the option now goes home,
        self.assertEqual(tom.plan, [("idle", "home")])  # and so does the plan
        self.assertEqual(opt.outcomes, [])  # and nothing the move promised happens

    def test_the_upkeep_and_repair_cooldowns_stay_with_the_old_home(self):
        sim = self.sim
        sim.clock.tick = SATURDAY
        levi, tom = sim.households["levi"], sim.agents["tom"]
        self.assertIn("28 Main Street", housing_forks.upkeep_fork(sim, tom).question)  # sets the upkeep cooldown
        levi.cooldowns["repair"] = sim.clock.tick + 30
        self.assertIsNone(housing_forks.upkeep_fork(sim, tom))  # the household was asked this weekend
        set_funds(sim, "levi", 40000)
        self.assertLess(housing.condition_of(sim, "main_55"), housing_forks.UPKEEP_BELOW)
        self.assertTrue(housing.move_household(sim, levi, "main_55", "buy"))
        self.assertNotIn("upkeep", levi.cooldowns)
        self.assertNotIn("repair", levi.cooldowns)
        fork = housing_forks.upkeep_fork(sim, tom)  # the new home is another question
        self.assertIsNotNone(fork)
        self.assertTrue(fork.question.startswith("55 Main Street is looking worn"), fork.question)

    def test_a_deal_buys_at_the_agreed_price(self):
        sim, dana = self.sim, self.sim.agents["dana"]
        cohen = sim.households["cohen"]
        funds = housing.funds(sim, cohen)
        price = housing._int(housing.value(sim, "river_28") * 0.9)
        for key, value in {"factor": 0.9, "buy": "river_28"}.items():
            self.assertTrue(housing.apply_effect(sim, dana, key, value))
        self.assertEqual(cohen.home_id, "river_28")
        self.assertAlmostEqual(housing.funds(sim, cohen), funds - price - housing.MOVING_COST)
        self.assertEqual(cohen.history[-1]["price"], price)
        self.assertIn(("dana", [("move_house", "river_28")]), sim.plans)

    def offer(self, agent_id: str, home_id: str = "river_28"):
        """Choose a haggle: its extra holds the listing (what house_hunt's option 1 carries)."""
        opt = SimpleNamespace(extra={"hold": home_id}, steps=[("viewing", self.sim.homes[home_id].place)],
                              outcomes=["the seller's answer"])
        housing.apply_extra(self.sim, self.sim.agents[agent_id], SimpleNamespace(kind="house_hunt"), opt)
        return opt

    def test_an_offer_holds_the_listing_until_the_answer(self):
        sim, dana = self.sim, self.sim.agents["dana"]
        cohen, peretz = sim.households["cohen"], sim.households["peretz"]
        set_funds(sim, "peretz", 60000)
        self.assertIn("river_28", [h.id for h in housing.hunt_candidates(sim, peretz)])  # the Peretzes want it too
        price = housing._int(housing.value(sim, "river_28") * 0.9)
        opt = self.offer("dana")
        home = sim.homes["river_28"]
        self.assertEqual((home.held_for, home.under_offer_until), ("cohen", sim.clock.tick + housing.OFFER_HOLD_MINUTES))
        self.assertEqual((opt.steps, opt.outcomes), ([("viewing", "river_28")], ["the seller's answer"]))
        self.assertNotIn("river_28", [h.id for h in housing.vacancies(sim)])
        self.assertNotIn("river_28", [h.id for h in housing.hunt_candidates(sim, peretz)])
        self.assertIsNone(housing.homes_json(sim)["river_28"]["listing"])  # under offer
        self.assertFalse(housing.move_household(sim, peretz, "river_28", "buy"))
        self.assertEqual(sim.texts("too_late"), ["The Peretzes were too late: 28 River Road is under offer."])
        sim.clock.tick += 60  # the viewing is over and the seller says yes
        for key, value in {"factor": 0.9, "buy": "river_28"}.items():
            self.assertTrue(housing.apply_effect(sim, dana, key, value))
        self.assertEqual((cohen.home_id, cohen.history[-1]["price"]), ("river_28", price))
        self.assertEqual((home.held_for, home.under_offer_until, home.household), (None, 0, "cohen"))
        self.assertEqual(len(sim.texts("too_late")), 1)

    def test_a_refusal_or_a_rival_ends_the_hold(self):
        sim, dana = self.sim, self.sim.agents["dana"]
        home = sim.homes["river_28"]
        self.offer("dana")
        housing.apply_effect(sim, sim.agents["tom"], "release", "river_28")  # only the Cohens' answer frees it
        self.assertEqual(home.held_for, "cohen")
        self.assertTrue(housing.apply_effect(sim, dana, "release", "river_28"))  # the seller turns them down
        self.assertEqual((home.held_for, home.under_offer_until), (None, 0))
        self.assertIn("river_28", [h.id for h in housing.vacancies(sim)])
        self.offer("dana")
        housing.apply_effect(sim, dana, "withdraw", "river_28")  # another buyer snaps it up first
        self.assertEqual((home.held_for, home.under_offer_until), (None, sim.clock.tick + 3 * DAY))
        self.assertFalse(housing.move_household(sim, sim.households["cohen"], "river_28", "buy"))
        self.assertEqual(sim.texts("too_late"), ["The Cohens were too late: 28 River Road has been sold."])

    def test_a_hold_runs_out_and_a_failed_purchase_frees_it(self):
        sim, dana = self.sim, self.sim.agents["dana"]
        home = sim.homes["river_28"]
        self.offer("dana")
        sim.clock.tick += housing.OFFER_HOLD_MINUTES - 1
        self.assertNotIn("river_28", [h.id for h in housing.vacancies(sim)])
        sim.clock.tick += 1  # no answer came (the decider died, say): the seller stops waiting
        self.assertIn("river_28", [h.id for h in housing.vacancies(sim)])
        self.offer("dana")
        set_funds(sim, "cohen", 1000)  # the money went meanwhile
        housing.apply_effect(sim, dana, "buy", "river_28")
        self.assertEqual(sim.texts("too_late"), ["The Cohens can't raise the money for 28 River Road after all."])
        self.assertEqual((home.held_for, home.under_offer_until), (None, 0))
        self.assertIn("river_28", [h.id for h in housing.vacancies(sim)])

    def test_an_offer_on_a_home_already_gone(self):
        """Another household took the home while the controller was thinking: no viewing, no answer."""
        sim, dana = self.sim, self.sim.agents["dana"]
        self.assertTrue(housing.move_household(sim, sim.households["segal"], "river_28", "buy"))
        opt = self.offer("dana")
        self.assertEqual(sim.texts("too_late"), ["The Cohens were too late: 28 River Road has been sold."])
        self.assertEqual((opt.steps, dana.plan, opt.outcomes), ([("idle", "home")], [("idle", "home")], []))
        self.assertEqual(sim.homes["river_28"].held_for, None)

    def test_withdraw_takes_a_listing_off_for_three_days(self):
        sim = self.sim
        housing.apply_effect(sim, sim.agents["dana"], "withdraw", "river_28")
        self.assertNotIn("river_28", [h.id for h in housing.vacancies(sim)])
        self.assertIsNone(housing.homes_json(sim)["river_28"]["listing"])
        sim.clock.tick += 3 * DAY
        self.assertIn("river_28", [h.id for h in housing.vacancies(sim)])

    def test_history_keeps_the_last_20(self):
        sim, barak = self.sim, self.sim.households["barak"]
        for i in range(12):
            target = "main_39" if barak.home_id != "main_39" else "elm_court_2b"
            self.assertTrue(housing.move_household(sim, barak, target, "rent", forced="evicted"))
        self.assertEqual(len(barak.history), 20)
        self.assertLessEqual(len(sim.homes["main_39"].history), 20)

    def test_an_estate_sale_after_the_last_death(self):
        sim = self.sim
        friedman = sim.households["friedman"]
        money = {a.id: a.money + a.savings for a in sim.agents.values()}
        for who in ("ruth", "david"):
            a = sim.agents[who]
            a.alive = False
            friedman.member_ids = [m for m in friedman.member_ids if m != who]  # as _die does
            housing.on_death(sim, a)
            if who == "ruth":
                self.assertEqual(sim.homes["park_78"].household, "friedman")
        home = sim.homes["park_78"]
        self.assertEqual((home.owner, home.listing, home.household), ("market", "for_sale", None))
        self.assertEqual(sim.texts("home_listed"), ["78 Park Avenue goes on the market after David Friedman's death."])
        self.assertEqual({a.id: a.money + a.savings for a in sim.agents.values()}, money)  # nobody inherits
        self.assertIn("park_78", [h.id for h in housing.vacancies(sim, "for_sale")])


# --- condition, stages and comfort -------------------------------------------------------

class ConditionTest(unittest.TestCase):
    def setUp(self):
        self.sim = FakeSim(tick=at(1, 0))

    def night(self, n: int = 1):
        for _ in range(n):
            self.sim.clock.tick += DAY
            housing.nightly(self.sim)

    def cond(self, place):
        return self.sim.lots[place].condition

    def test_decay_rates(self):
        sim = self.sim
        start = {p: lot.condition for p, lot in sim.lots.items()}
        self.night()
        self.assertAlmostEqual(self.cond("main_28"), start["main_28"] - 1.5)  # the Levis: two in a house
        self.assertAlmostEqual(self.cond("park_21"), start["park_21"] - 1.5 * 1.1)  # three: crowding +10%
        self.assertAlmostEqual(self.cond("park_92"), start["park_92"] - 2.0 * 1.2)  # a big house, four
        self.assertAlmostEqual(self.cond("main_39"), start["main_39"] - housing.VACANT_DECAY)  # empty
        self.assertAlmostEqual(self.cond("birch_court"), start["birch_court"] - 1.0)  # a block of flats
        sim.homes["main_28"].emergency = {"kind": "leak", "since": sim.clock.tick}
        before = self.cond("main_28")
        self.night()
        self.assertAlmostEqual(self.cond("main_28"), before - 1.5 - housing.EMERGENCY_DECAY)

    def test_winter_wears_faster(self):
        sim = self.sim
        sim.clock.tick = at(270, 0)
        self.assertEqual(sim.clock.season, "winter")
        before = self.cond("main_28")
        housing.nightly(sim)
        self.assertAlmostEqual(self.cond("main_28"), before - 1.5 * housing.WINTER_DECAY)

    def test_the_landlord_repaints_below_the_floor(self):
        sim = self.sim
        sim.lots["park_29"].condition = 60.5  # let to the Navons
        sim.lots["main_39"].condition = 60.3  # empty, to let
        sim.lots["elm_court"].condition = 45.5
        self.night()
        for place in ("park_29", "main_39", "elm_court"):
            self.assertEqual(self.cond(place), housing.LANDLORD_RESTORE, place)
            self.assertEqual(sim.lots[place].works_until, sim.clock.tick + housing.LANDLORD_WORKS_MINUTES)
        self.assertEqual(sorted(e["place"] for e in sim.tagged("repaint")), ["elm_court", "park_29"])
        self.assertIn("Millbrook Homes repaints 29 Park Avenue.", sim.texts("repaint"))

    def test_a_home_for_sale_never_drops_below_the_market_floor(self):
        sim = self.sim
        self.assertEqual(self.cond("river_28"), 30)
        self.night(20)
        self.assertEqual(self.cond("river_28"), housing.MARKET_FLOOR)
        sim.lots["main_28"].condition = 20.5  # lived in: no floor
        self.night()
        self.assertAlmostEqual(self.cond("main_28"), 19.0)

    def test_stage_news_has_hysteresis(self):
        sim = self.sim
        lot = sim.lots["main_28"]
        lot.condition, lot.reported = 60.4, 1
        self.night()
        self.assertEqual(sim.texts("shabby", place="main_28"), ["28 Main Street is looking shabby."])
        lot.condition = 40.6
        self.night()
        self.assertEqual(sim.texts("neglect", place="main_28"), ["28 Main Street is falling into neglect."])
        housing._change_condition(sim, lot, 1.5)  # back to shabby, briefly
        self.night()  # and down again: already announced
        self.assertEqual(len(sim.texts("neglect", place="main_28")), 1)
        self.assertEqual(len(sim.texts("shabby", place="main_28")), 1)
        housing._change_condition(sim, lot, 30)  # worn: reported resets at stage 0-1 (housing.md 7.2)
        self.assertEqual((lot.reported, lot.worst), (1, 3))
        self.night()
        self.assertEqual(sim.texts("restored", place="main_28"), [])
        lot.condition = 60.9
        self.night()  # let slip to shabby again: news again
        self.assertEqual(sim.texts("shabby", place="main_28"), ["28 Main Street is looking shabby."] * 2)
        housing._change_condition(sim, lot, 15)  # worn
        self.assertEqual(sim.texts("restored", place="main_28"), [])
        housing._change_condition(sim, lot, 15)  # kept, after being shabby or worse
        self.assertEqual(sim.texts("restored", place="main_28"), ["28 Main Street looks as good as new."])
        self.assertEqual((lot.reported, lot.worst), (0, 0))
        lot.condition = 80.5
        self.night()  # just worn ...
        housing._change_condition(sim, lot, 5)  # ... and kept again: nothing to celebrate
        self.assertEqual(len(sim.texts("restored", place="main_28")), 1)
        lot.condition = 20.8
        self.night()
        self.assertEqual(sim.texts("falling_apart", place="main_28"), ["28 Main Street is close to falling apart."])

    def test_rentals_and_empty_homes_are_silent(self):
        sim = self.sim
        sim.lots["river_12"].condition = 40.3  # for sale
        sim.lots["birch_court"].condition = 46  # flats wear past shabby at 1 a night
        self.night(7)
        self.assertEqual([e for e in sim.logged if e["tag"] in ("shabby", "neglect", "falling_apart")
                          and e["place"] in ("river_12", "birch_court")], [])

    def test_no_stage_news_on_the_first_day_in_a_new_home(self):
        sim = self.sim
        sim.clock.tick = at(1, 19)  # Tuesday evening
        sim.lots["river_28"].condition = housing.MARKET_FLOOR + 0.5  # a fixer-upper held at the market floor
        cohen = sim.households["cohen"]
        self.assertTrue(housing.move_household(sim, cohen, "river_28", "buy"))
        lot = sim.lots["river_28"]
        sim.clock.tick = at(2, 0)
        housing.nightly(sim)  # its first night in use: the decay still happens ...
        self.assertAlmostEqual(lot.condition, housing.MARKET_FLOOR + 0.5 - 1.5 * 1.1)
        self.assertEqual(housing.stage_of(lot.condition), 4)
        self.assertEqual(sim.texts("falling_apart"), [])  # ... but it isn't news yet
        self.assertEqual(lot.reported, 3)
        housing._change_condition(sim, lot, -3)  # nor a hidden fault found that evening
        self.assertEqual(sim.texts("falling_apart"), [])
        sim.clock.tick = at(2, 19) - 1
        housing._change_condition(sim, lot, -1)
        self.assertEqual(sim.texts("falling_apart"), [])
        sim.clock.tick = at(3, 0)
        housing.nightly(sim)  # a day on, it is still falling apart: now it is news
        self.assertEqual(sim.texts("falling_apart"), ["28 River Road is close to falling apart."])
        self.assertEqual(lot.reported, 4)
        # Renovated that first evening instead, a fixer-upper is never announced as falling apart.
        sim = FakeSim(tick=at(1, 19))
        sim.lots["river_28"].condition = housing.MARKET_FLOOR
        housing.move_household(sim, sim.households["cohen"], "river_28", "buy")
        housing._change_condition(sim, sim.lots["river_28"], 80)
        sim.clock.tick = at(2, 0)
        housing.nightly(sim)
        self.assertEqual([e for e in sim.logged if e["tag"] in ("shabby", "neglect", "falling_apart")
                          and e["place"] == "river_28"], [])
        self.assertEqual(sim.texts("restored", place="river_28"), ["28 River Road looks as good as new."])

    def test_comfort_scales_home_activities(self):
        sim = self.sim
        rosen = sim.households["rosen"]  # three in a one-bedroom flat at 71
        self.assertTrue(housing.crowded(sim, rosen))
        self.assertAlmostEqual(housing.comfort(sim, rosen), 0.95 * 1.00 * 0.9)
        gil = sim.agents["gil"]
        gil.activity_place = "cedar_court"
        self.assertAlmostEqual(housing.activity_gain_scale(sim, gil), 0.95 * 0.9)
        gil.activity_place = "cafe"
        self.assertEqual(housing.activity_gain_scale(sim, gil), 1.0)
        omer = sim.agents["omer"]
        omer.activity_place = "park_21"  # a house at 90, kept
        self.assertAlmostEqual(housing.activity_gain_scale(sim, omer), 1.00 * 1.05)

    def test_damp_costs_health_and_may_bring_a_chill(self):
        sim = self.sim
        sim.lots["main_28"].condition = 25  # neglected
        health = {m: sim.agents[m].health for m in ("miriam", "tom")}
        self.night()
        chilled = {e["agent"] for e in sim.tagged("damp_chill")}
        for m in ("miriam", "tom"):
            loss = housing.DAMP_HEALTH[3] - (housing.CHILL["health"] if m in chilled else 0)
            self.assertAlmostEqual(sim.agents[m].health, health[m] - loss)
        self.assertEqual([r["agent"] for r in sim.rolls if r["what"] == "damp_chill"], ["miriam", "tom"])
        sim.rng = Dice(rolls=[0.0] * 100)  # every roll comes up
        health = {m: sim.agents[m].health for m in ("miriam", "tom")}
        sim.logged.clear()
        self.night()
        self.assertEqual(sim.texts("damp_chill"), ["Miriam Levi catches a chill in the damp house.",
                                                   "Tom Levi catches a chill in the damp house."])
        self.assertAlmostEqual(sim.agents["tom"].health, health["tom"] - housing.DAMP_HEALTH[3] + housing.CHILL["health"])

    def test_the_neighbours_notice(self):
        sim = self.sim
        sim.clock.tick = SUNDAY
        sim.lots["main_28"].condition = 30  # the Levis, neglected
        rep = {a.id: a.reputation for a in sim.agents.values()}
        housing.weekly_charges(sim)
        self.assertEqual(sim.agents["tom"].reputation, rep["tom"] - 2)
        self.assertEqual(sim.agents["shai"].reputation, rep["shai"] + housing.KEPT_BIG_HOUSE_PRIDE)  # park_92, kept
        self.assertEqual(sim.agents["dana"].reputation, rep["dana"])  # a kept house: nothing to say


# --- emergencies ------------------------------------------------------------------------------

class EmergencyTest(unittest.TestCase):
    def setUp(self):
        self.sim = FakeSim(tick=at(1, 0))

    def everything(self, agent_id="tom"):
        sim, agent = self.sim, self.sim.agents[agent_id]
        return [housing.homes_json(sim), housing.lots_json(sim), housing.possessions_json(sim, agent),
                housing.fork_you(sim, agent), housing.agent_page_fields(sim, agent), housing.market_json(sim),
                housing.home_page(sim, "main_28"), housing.town_homes_json(sim)]

    def test_the_roll_stays_hidden_until_it_goes_live(self):
        sim = self.sim
        sim.rng = Dice(rolls=[0.0] * 50)
        housing.nightly(sim)
        owned = {h.id for h in sim.homes.values() if housing.owner_occupied(h)}
        self.assertEqual({h.id for h in sim.homes.values() if h.pending_emergency}, owned)
        self.assertEqual(len([r for r in sim.rolls if r["what"] == "home_emergency"]), len(owned))
        pending = sim.homes["main_28"].pending_emergency
        self.assertTrue(sim.clock.tick + 7 * 60 <= pending["due"] < sim.clock.tick + 21 * 60)
        self.assertTrue(SECRET.isdisjoint(walk_keys(self.everything())))
        self.assertIsNone(housing.homes_json(sim)["main_28"]["emergency"])
        self.assertEqual(sim.tagged("emergency"), [])
        sim.clock.tick = pending["due"] - 1
        housing.tick(sim)
        self.assertIsNone(sim.homes["main_28"].emergency)
        sim.clock.tick += 1
        housing.tick(sim)
        live = sim.homes["main_28"].emergency
        self.assertEqual(live, {"kind": pending["kind"], "since": sim.clock.tick})
        self.assertIsNone(sim.homes["main_28"].pending_emergency)
        self.assertEqual(housing.homes_json(sim)["main_28"]["emergency"], pending["kind"])
        self.assertEqual(housing.possessions_json(sim, sim.agents["tom"])["home"]["emergency"]["kind"], pending["kind"])
        self.assertTrue(SECRET.isdisjoint(walk_keys(self.everything())))
        self.assertIn("main_28", [e["place"] for e in sim.tagged("emergency")])

    def test_no_second_roll_while_one_is_pending_or_live(self):
        sim = self.sim
        sim.homes["main_28"].pending_emergency = {"kind": "leak", "due": sim.clock.tick + DAY}
        sim.homes["park_21"].emergency = {"kind": "boiler", "since": sim.clock.tick}
        housing.nightly(sim)
        rolled = {r["agent"] for r in sim.rolls if r["what"] == "home_emergency"}
        self.assertTrue(rolled.isdisjoint({"miriam", "tom", "omer", "gal"}))

    def test_left_alone_it_settles_as_damage(self):
        sim = self.sim
        sim.homes["main_28"].emergency = {"kind": "boiler", "since": sim.clock.tick}
        before = sim.lots["main_28"].condition
        sim.clock.tick += housing.EMERGENCY_DAYS * DAY - 1
        housing.tick(sim)
        self.assertIsNotNone(sim.homes["main_28"].emergency)
        sim.clock.tick += 1
        housing.tick(sim)
        self.assertIsNone(sim.homes["main_28"].emergency)
        self.assertEqual(sim.texts("emergency_settled"), ["The broken boiler at 28 Main Street is never properly fixed."])
        self.assertEqual(sim.lots["main_28"].condition, before - housing.SETTLE_DAMAGE)

    def test_fixing_it(self):
        sim, tom = self.sim, self.sim.agents["tom"]
        sim.homes["main_28"].emergency = {"kind": "leak", "since": sim.clock.tick}
        housing.apply_extra(sim, tom, SimpleNamespace(kind="repair"),
                            SimpleNamespace(extra={"fix_emergency": True, "works": 120}))
        self.assertIsNone(sim.homes["main_28"].emergency)
        self.assertEqual(sim.texts("emergency_settled"), ["The leak at 28 Main Street is fixed."])
        self.assertEqual(sim.lots["main_28"].works_until, sim.clock.tick + 120)
        sim.homes["main_28"].emergency = {"kind": "roof", "since": sim.clock.tick}
        self.assertTrue(housing.apply_effect(sim, tom, "fix_emergency", True))
        self.assertIsNone(sim.homes["main_28"].emergency)


# --- the Sunday charges ----------------------------------------------------------------------

class ChargesTest(unittest.TestCase):
    def setUp(self):
        self.sim = FakeSim(tick=SUNDAY)

    def sunday(self):
        housing.weekly_charges(self.sim)
        self.sim.clock.tick += 7 * DAY

    def test_rent_tax_and_bills(self):
        sim, a = self.sim, self.sim.agents
        before = {x.id: x.money + x.savings for x in a.values()}
        self.sunday()
        self.assertEqual(before["dana"] - (a["dana"].money + a["dana"].savings), 420 / 2 + 80 + 40)
        self.assertEqual(before["tom"] - (a["tom"].money + a["tom"].savings), 76 / 2 + 80)  # tax on $15,200
        self.assertEqual(before["noa"], a["noa"].money + a["noa"].savings)
        paid = sim.texts("bills_paid")
        self.assertEqual(len(paid), 27)
        self.assertIn("The Cohens paid $420 rent and $200 in bills.", paid)
        self.assertIn("The Levis paid $76 property tax and $160 in bills.", paid)
        self.assertTrue(all(e["place"] in sim.town.places for e in sim.tagged("bills_paid")))

    def test_savings_cover_a_shortfall(self):
        sim, tom = self.sim, self.sim.agents["tom"]
        tom.money, tom.savings = 50.0, 500.0
        self.sunday()
        self.assertEqual((tom.money, tom.savings), (0.0, 432.0))

    def test_arrears_count_stalled_weeks(self):
        sim, hh = self.sim, self.sim.households["avraham"]  # Tamar and Yoni, $180 a week
        before_charges(sim, "avraham", -100)
        self.sunday()
        self.assertEqual((hh.arrears, hh.last_funds), (1, -100))
        self.assertEqual(sim.texts("in_the_red", "tamar")[-1], "Tamar Avraham is $100 in the red after the week's bills.")
        before_charges(sim, "avraham", -100)
        self.sunday()
        self.assertEqual(hh.arrears, 2)
        self.assertEqual(sim.texts("in_the_red_again", "tamar"), [
            "Tamar Avraham is $100 in the red for a second week. Millbrook Homes sends a final warning."])
        before_charges(sim, "avraham", -50)  # $50 better: recovering, so it holds
        self.sunday()
        self.assertEqual(hh.arrears, 2)
        before_charges(sim, "avraham", -60)
        hh.grace_until = sim.clock.tick + 1  # granted grace: it holds
        self.sunday()
        self.assertEqual(hh.arrears, 2)
        # Weeks that hold at 2 are quiet: in_the_red only at arrears 1 (PLAN 5.3 step 6).
        self.assertEqual(len(sim.texts("in_the_red", "tamar")), 1)
        self.assertEqual(len(sim.texts("in_the_red_again", "tamar")), 1)
        before_charges(sim, "avraham", -30)  # only $30 better: it climbs
        self.sunday()
        self.assertEqual(hh.arrears, 3)
        self.assertEqual(sim.texts("in_the_red_again", "tamar")[-1],
                         "Tamar Avraham is $30 in the red for a third week. Millbrook Homes sends a final warning.")
        before_charges(sim, "avraham", 0)
        self.sunday()
        self.assertEqual((hh.arrears, hh.clean_sundays), (0, 1))

    def test_a_red_week_under_grace_is_quiet(self):
        sim, hh = self.sim, self.sim.households["avraham"]
        hh.grace_until = sim.clock.tick + 2 * DAY
        before_charges(sim, "avraham", -100)
        self.sunday()
        self.assertEqual((hh.arrears, hh.last_funds), (0, -100))
        self.assertEqual(sim.texts("in_the_red") + sim.texts("in_the_red_again"), [])
        before_charges(sim, "avraham", -100)  # grace is over: the first counted week
        self.sunday()
        self.assertEqual(hh.arrears, 1)
        self.assertEqual(sim.texts("in_the_red", "tamar"), ["Tamar Avraham is $100 in the red after the week's bills."])

    def test_owners_get_the_banks_warning(self):
        sim, levi = self.sim, self.sim.households["levi"]
        levi.arrears, levi.last_funds = 1, -100
        before_charges(sim, "levi", -100)
        self.sunday()
        self.assertEqual(sim.texts("in_the_red_again", "tom"),
                         ["The Levis are $100 in the red for a second week. The bank warns them: pay up or sell."])

    def test_hardship_rent_and_its_exit(self):
        sim, hh = self.sim, self.sim.households["avraham"]
        hh.arrears, hh.last_funds = 2, -300
        before_charges(sim, "avraham", -300)
        income = housing.weekly_income(sim, hh)
        self.sunday()
        self.assertEqual(hh.arrears, 3)
        expect = min(180, max(0, housing.round10(income - 80 - 150 - housing.HARDSHIP_REPAY)))
        self.assertEqual(hh.hardship_rent, expect)
        self.assertEqual(expect, 170)
        self.assertEqual(sim.texts("hardship", "tamar"),
                         ["Millbrook Homes lowers Tamar Avraham's rent to $170/week until they are back on their feet."])
        self.assertEqual(hh.tight_until, SUNDAY + 8 * DAY)
        self.assertEqual(hh.home_id, "birch_court_2a")  # no cheaper home, and not deep enough for a forced move
        before_charges(sim, "avraham", 10)
        self.assertEqual(housing.weekly_cost(sim, hh), 170)
        self.sunday()
        self.assertIn("Tamar Avraham paid $170 rent (hardship rate) and $80 in bills.", sim.texts("bills_paid"))
        self.assertEqual((hh.clean_sundays, hh.hardship_rent), (1, 170))
        before_charges(sim, "avraham", 10)
        self.sunday()
        self.assertIsNone(hh.hardship_rent)

    def test_the_hardship_formula_stays_within_the_rent(self):
        sim = self.sim
        self.assertEqual(housing.hardship_rent(sim, sim.households["cohen"]), 420)  # never above the rent
        self.assertEqual(housing.hardship_rent(sim, sim.households["tal"]), 70)  # $400 - $80 - $150 - $100
        sim.agents["tamar"].job = None  # no income at all
        self.assertEqual(housing.hardship_rent(sim, sim.households["avraham"]), 0)

    def test_tax_deferral_and_its_exit(self):
        sim, levi = self.sim, self.sim.households["levi"]
        levi.arrears, levi.last_funds = 2, -100
        before_charges(sim, "levi", -100)
        self.sunday()
        self.assertTrue(levi.tax_deferred)
        self.assertEqual(sim.texts("hardship", "tom"), ["The council defers the Levis' property tax."])
        before_charges(sim, "levi", 5)
        self.assertEqual(housing.weekly_cost(sim, levi), 0)
        self.sunday()
        self.assertIn("The Levis paid $160 in bills (property tax deferred).", sim.texts("bills_paid"))
        self.assertTrue(levi.tax_deferred)
        before_charges(sim, "levi", 5)
        self.sunday()
        self.assertFalse(levi.tax_deferred)

    def deep(self, hh_id: str, extra: float = 100.0):
        """Third stalled week, deeper than twice the weekly outgo: the forced-move line."""
        sim, hh = self.sim, self.sim.households[hh_id]
        f = -2 * housing.weekly_outgo(sim, hh) - extra
        hh.arrears, hh.last_funds = 2, f  # no progress
        before_charges(sim, hh_id, f)
        return f

    def test_forced_move_1_a_cheaper_rental(self):
        sim, cohen = self.sim, self.sim.households["cohen"]
        f = self.deep("cohen")
        self.sunday()
        self.assertEqual(cohen.home_id, "elm_court_2b")  # the cheapest that fits three ($220; ties by id)
        self.assertEqual(cohen.weekly_rent, 220)
        self.assertAlmostEqual(housing.funds(sim, cohen), f)  # the landlord moves them for free
        self.assertEqual(sim.texts("evicted"),
                         ["Millbrook Homes evicts the Cohens from 20 Main Street. They move into Elm Court, flat 2B "
                          "at $220/week."])
        self.assertEqual(sim.homes["main_20"].listing, "for_rent")
        self.assertEqual(cohen.history[-1]["event"], "rented")
        self.assertEqual(cohen.history[-2]["event"], "evicted")

    def test_forced_move_1_an_owner_sells_and_rents(self):
        sim, levi = self.sim, self.sim.households["levi"]
        f = self.deep("levi")
        sale = housing.sale_proceeds(sim, "main_28")
        self.sunday()
        self.assertEqual(levi.home_id, "elm_court_1a")  # any fitting rental for an owner: two fit one bedroom
        self.assertEqual(sim.homes["main_28"].listing, "for_sale")
        self.assertEqual(sim.texts("forced_sale"), [f"The Levis are forced to sell 28 Main Street (${sale:,}) and move "
                                                    f"into Elm Court, flat 1A at $180/week."])
        self.assertAlmostEqual(housing.funds(sim, levi), f + sale)

    def test_forced_move_2_an_owner_buys_something_cheaper(self):
        sim, levi = self.sim, self.sim.households["levi"]
        hide(sim, *[h.id for h in housing.vacancies(sim, "for_rent")])
        f = self.deep("levi")
        sale = housing.sale_proceeds(sim, "main_28")
        self.sunday()
        self.assertEqual(levi.home_id, "river_12")
        price = sim.homes["river_12"].history[-1]["price"]
        self.assertAlmostEqual(housing.funds(sim, levi), f + sale - price - housing.MOVING_COST)
        self.assertEqual([e["tag"] for e in sim.logged if e["tag"] in ("forced_sale", "home_bought")],
                         ["forced_sale", "home_bought"])

    def test_forced_move_3_crowding_relaxed(self):
        sim, cohen = self.sim, self.sim.households["cohen"]
        hide(sim, "cedar_court_3b", "elm_court_2b", "elm_court_3a", "main_39")
        self.deep("cohen")
        self.sunday()
        self.assertEqual(cohen.home_id, "elm_court_1a")  # three in one bedroom, rather than nowhere

    def test_forced_move_4_nowhere_to_go(self):
        sim = self.sim
        avraham = sim.households["avraham"]  # already in the cheapest kind of flat
        self.deep("avraham")
        hide(sim, *[h.id for h in housing.vacancies(sim)])
        levi = sim.households["levi"]
        self.deep("levi")
        self.sunday()
        self.assertEqual(avraham.home_id, "birch_court_2a")
        self.assertIsNotNone(avraham.hardship_rent)
        self.assertEqual(levi.home_id, "main_28")
        self.assertTrue(levi.tax_deferred)
        self.assertEqual(sim.texts("nowhere_to_go"), ["The Levis are deep in debt and nowhere cheaper is free."])
        self.assertEqual(len(sim.texts("hardship", "tamar")), 1)
        self.assertEqual(sim.texts("hardship", "tom"), ["The council defers the Levis' property tax."])
        self.assertGreater(levi.tight_until, sim.clock.tick)


# --- the money term of the default scores ---------------------------------------------------

class AffordScoreTest(unittest.TestCase):
    def setUp(self):
        self.sim = FakeSim()

    def test_free_is_free(self):
        sim, dana = self.sim, self.sim.agents["dana"]
        dana.money = -500.0
        self.assertEqual(housing.afford_score(sim, dana, SimpleNamespace(cost=0, household_pays=False)), 0.0)
        self.assertEqual(housing.afford_score(sim, dana, SimpleNamespace(cost=0, household_pays=True)), 0.0)

    def test_household_costs_are_weighed_against_spare_funds(self):
        sim, dana = self.sim, self.sim.agents["dana"]
        cohen = sim.households["cohen"]
        spare = housing.funds(sim, cohen) - 2 * housing.weekly_outgo(sim, cohen)
        thrift = dana.profile.traits["thrift"]
        opt = SimpleNamespace(cost=1000, household_pays=True)
        self.assertAlmostEqual(housing.afford_score(sim, dana, opt), -thrift * (1000 / spare) ** 2)
        self.assertEqual(housing.afford_score(sim, dana, SimpleNamespace(cost=spare + 1, household_pays=True)), -1.5)
        cohen.tight_until = sim.clock.tick + DAY  # belt-tightening triples thrift
        self.assertAlmostEqual(housing.afford_score(sim, dana, opt), -3 * thrift * (1000 / spare) ** 2)

    def test_own_costs(self):
        sim, dana = self.sim, self.sim.agents["dana"]
        thrift = dana.profile.traits["thrift"]
        own = dana.money + dana.savings  # what she pays with: her money and her savings
        cohen = sim.households["cohen"]
        spare = housing.funds(sim, cohen) - 2 * housing.weekly_outgo(sim, cohen)  # else the household's spare funds
        self.assertEqual(housing.afford_score(sim, dana, SimpleNamespace(cost=max(own, spare) + 1)), -2.0)
        self.assertAlmostEqual(housing.afford_score(sim, dana, SimpleNamespace(cost=90)), -90 / own * thrift)
        dana.money, dana.savings = 10, 0
        self.assertAlmostEqual(housing.afford_score(sim, dana, SimpleNamespace(cost=5)), -5 / 50 * thrift)


# --- the four forks ------------------------------------------------------------------------------

class ForkTest(unittest.TestCase):
    """The builders on FakeSim (they need the contract's Outcome.group, Option.household_pays/charge and
    Fork.major, from P0c)."""

    def check(self, fork, kind, major):
        self.assertIsNotNone(fork, kind)
        self.assertEqual(fork.kind, kind)
        self.assertEqual(len(fork.options), 4)
        self.assertEqual(len(set(labels(fork))), 4, labels(fork))
        self.assertEqual(fork.major, major)
        self.assertEqual(kind in housing_forks.MAJOR_KINDS, major)
        for opt in fork.options:
            for o in opt.outcomes:
                for key in o.effects:
                    self.assertTrue(isinstance(key, str) or (isinstance(key, tuple) and key[0] == "rel"), key)
        return fork

    # house_hunt

    def test_house_hunt_for_the_cohens(self):
        sim = FakeSim(tick=at(0, 18, 30))
        fork = self.check(housing_forks.house_hunt_fork(sim, sim.agents["dana"]), "house_hunt", True)
        reno = housing.reno_cost(sim, "river_28")  # 28 River Road is bought with its renovation
        self.assertEqual(reno, 880)
        self.assertEqual(labels(fork), [
            "Buy 28 River Road (house, neglected) for $14,550 and do it up ($880)",
            "Offer $13,095 for 28 River Road (and $880 to do it up) and see what the seller says",
            "Keep looking for the right place",
            "Stay in 20 Main Street and keep the money"])
        buy, haggle, look, stay = fork.options
        self.assertEqual(fork.question, "Your household has $21,500 put by. You live in 20 Main Street (rented, "
                                        "$420/week). There are homes on the market you could afford. Do you move?")
        self.assertEqual(buy.extra, {"move": "river_28", "how": "buy", "renovate": reno})
        self.assertEqual(buy.cost, 14550 + 150 + reno)
        self.assertEqual(haggle.cost, 14550 + 150 - 1455 + reno)
        for opt in (buy, haggle):
            self.assertTrue(opt.household_pays)
            self.assertFalse(opt.charge)
        self.assertEqual([o.group for o in haggle.outcomes], ["deal"] * 4)
        self.assertEqual(haggle.outcomes[0].effects, {"factor": 0.9, "renovate": reno, "buy": "river_28"})
        self.assertEqual(list(haggle.outcomes[1].effects), ["factor", "renovate", "buy"])  # the companions first
        self.assertEqual(haggle.extra, {"hold": "river_28"})  # nobody else takes it during the viewing ...
        self.assertEqual(haggle.outcomes[3].effects, {"fun": -4, "release": "river_28"})  # ... until a refusal
        self.assertEqual(look.extra, {"hh_cooldown": 3 * DAY})
        self.assertEqual(stay.extra, {"hh_cooldown": 14 * DAY})
        self.assertEqual(stay.tags["thrift"], 0.0)  # buying would lower their weekly outgo
        self.assertEqual(sim.households["cohen"].cooldowns["house_hunt"], sim.clock.tick + 7 * DAY)
        self.assertEqual(buy.tags["thrift"], -0.2)  # owning costs them less a week than the rent
        self.assertNotIn("partner_doubts", [o.id for o in buy.outcomes])

    def test_house_hunt_partner_doubts(self):
        sim = FakeSim(tick=at(0, 18, 30))
        sim.agents["mor"].savings += 2000
        fork = self.check(housing_forks.house_hunt_fork(sim, sim.agents["gil"]), "house_hunt", True)
        best = fork.options[0]
        self.assertEqual(best.label, "Move into 39 Main Street (house) for $330/week")
        self.assertEqual(best.tags["thrift"], -0.6)  # the weekly outgo rises
        doubts = [o for o in best.outcomes if o.id == "partner_doubts"]
        self.assertEqual(len(doubts), 1)
        self.assertEqual(doubts[0].label, "Mor worries it's too expensive")
        self.assertAlmostEqual(doubts[0].p, 0.6 * sim.agents["mor"].profile.traits["thrift"])
        self.assertEqual(doubts[0].effects, {("rel", "mor"): -3, "fun": -3})
        self.assertAlmostEqual(best.base, 0.35 + 0.3)  # crowded, and more bedrooms
        cheaper, hh = fork.options[2], sim.households[sim.agents["gil"].household_id]
        self.assertEqual(cheaper.label, "Move into the cheaper Elm Court, flat 2B (flat) for $220/week")
        self.assertGreater(housing.weekly_outgo(sim, hh, "elm_court_2b"), housing.weekly_outgo(sim, hh))  # rises too
        self.assertEqual([o.id for o in cheaper.outcomes],  # but the doubts are option 0's alone (housing.md 9.1)
                         ["bargain", "hidden_fault", "nice_neighbours", "moving_chaos"])

    def test_house_hunt_best_and_cheaper(self):
        sim = FakeSim(tick=at(0, 18, 30))
        sim.agents["dana"].savings += 5000
        fork = self.check(housing_forks.house_hunt_fork(sim, sim.agents["dana"]), "house_hunt", True)
        self.assertEqual(labels(fork)[0], "Buy 55 Main Street (house) for $18,100")  # 68: no renovation
        self.assertEqual(fork.options[0].extra, {"move": "main_55", "how": "buy"})
        self.assertEqual(labels(fork)[1], "Offer $16,290 for 55 Main Street and see what the seller says")
        self.assertEqual(fork.options[1].outcomes[0].effects, {"factor": 0.9, "buy": "main_55"})
        self.assertEqual(labels(fork)[2], "Buy the cheaper 28 River Road (house, neglected) for $14,550 and do it up "
                                          "($880)")
        self.assertEqual(fork.options[2].extra, {"move": "river_28", "how": "buy", "renovate": 880})

    def test_house_hunt_rentals(self):
        sim = FakeSim(tick=at(0, 18, 30))
        fork = self.check(housing_forks.house_hunt_fork(sim, sim.agents["sara"]), "house_hunt", True)
        self.assertEqual(labels(fork), [
            "Move into 39 Main Street (house) for $330/week",
            "Ask the landlord to let 39 Main Street for $297/week",
            "Move into the cheaper Elm Court, flat 2B (flat) for $220/week",
            "Stay in Elm Court, flat 2A and keep the money"])
        self.assertEqual(fork.options[0].extra, {"move": "main_39", "how": "rent"})
        self.assertEqual(fork.options[1].outcomes[0].effects, {"factor": 0.9, "buy": "main_39"})
        self.assertEqual(fork.options[1].extra, {"hold": "main_39"})

    def test_house_hunt_gates(self):
        sim = FakeSim(tick=at(0, 18, 30))
        cohen = sim.households["cohen"]
        dana = sim.agents["dana"]
        self.assertIsNone(housing_forks.house_hunt_fork(sim, sim.agents["noa"]))  # children don't decide
        cohen.arrears = 1
        self.assertIsNone(housing_forks.house_hunt_fork(sim, dana))
        cohen.arrears, cohen.moved_tick = 0, sim.clock.tick - 27 * DAY
        self.assertIsNone(housing_forks.house_hunt_fork(sim, dana))
        cohen.moved_tick = sim.clock.tick - 28 * DAY
        sim.clock.tick = at(1, 14)  # Tuesday afternoon: not the household's time
        self.assertIsNone(housing_forks.house_hunt_fork(sim, dana))
        sim.clock.tick = at(5, 11)  # Saturday morning
        self.assertIsNotNone(housing_forks.house_hunt_fork(sim, dana))

    def test_house_hunt_with_nothing_on_the_market(self):
        sim = FakeSim(tick=at(0, 18, 30))
        tal = sim.households["tal"]
        self.assertIsNone(housing_forks.house_hunt_fork(sim, sim.agents["lea"]))
        self.assertEqual(tal.cooldowns["house_hunt"], sim.clock.tick + housing_forks.NO_CANDIDATE_RETRY)

    # house_hunt's downsizing variant

    def test_who_has_outgrown_their_home(self):
        sim = FakeSim(tick=at(0, 18, 30))
        hh = sim.households
        self.assertTrue(housing.outgrown(sim, hh["friedman"]))  # retired, in a big house
        self.assertTrue(housing.outgrown(sim, hh["segal"]))  # retired, in a two-bedroom house
        self.assertFalse(housing.outgrown(sim, hh["levi"]))  # Tom still works
        self.assertFalse(housing.outgrown(sim, hh["elbaz"]))  # two in three bedrooms
        self.assertFalse(housing.outgrown(sim, hh["halabi"]))  # four in five
        self.assertFalse(housing.outgrown(sim, hh["tal"]))  # retired, but renting
        set_funds(sim, "bendavid", 60000)
        self.assertTrue(housing.move_household(sim, hh["bendavid"], "main_55", "buy"))
        self.assertTrue(housing.outgrown(sim, hh["bendavid"]))  # one in four bedrooms
        set_funds(sim, "mizrahi", 60000)
        mizrahi = hh["mizrahi"]
        self.assertTrue(housing.move_household(sim, mizrahi, "park_66", "buy"))
        self.assertFalse(housing.outgrown(sim, mizrahi))  # four in five
        gone(sim, "maya")
        self.assertTrue(housing.outgrown(sim, mizrahi))  # three in five
        set_funds(sim, "katz", 60000)
        katz = hh["katz"]
        self.assertTrue(housing.move_household(sim, katz, "river_12", "buy"))
        self.assertFalse(housing.outgrown(sim, katz))  # three in two bedrooms
        for a in housing.adults(sim, katz):
            a.job, a.age = None, 65
        self.assertTrue(housing.outgrown(sim, katz))  # every adult retired

    def test_downsize_candidates(self):
        sim = FakeSim(tick=at(95, 18, 30))
        friedman = sim.households["friedman"]
        self.assertEqual([h.id for h in housing.downsize_candidates(sim, friedman)], ["river_12", "main_55"])
        sim.lots["river_12"].condition = housing.DOWNSIZE_CONDITION - 1  # too run-down
        sim.lots["main_55"].condition = 30
        self.assertEqual(housing.downsize_candidates(sim, friedman), [])
        sim.lots["main_55"].condition = 95
        self.assertEqual([h.id for h in housing.downsize_candidates(sim, friedman)], ["main_55"])
        set_funds(sim, "friedman", -30000)  # the sale wouldn't leave enough to carry it
        self.assertEqual(housing.downsize_candidates(sim, friedman), [])
        segal = sim.households["segal"]  # nothing for sale is worth DOWNSIZE_SHARE of 12 Main Street or less
        self.assertGreater(min(housing.value(sim, h.id) for h in housing.vacancies(sim, "for_sale")),
                           housing.DOWNSIZE_SHARE * housing.value(sim, "main_12"))
        self.assertEqual(housing.downsize_candidates(sim, segal), [])

    def test_house_hunt_downsizing_for_the_friedmans(self):
        sim = FakeSim(tick=at(95, 18, 30))  # a Friday evening, past DOWNSIZE_AFTER_DAYS
        friedman, ruth = sim.households["friedman"], sim.agents["ruth"]
        self.assertEqual(housing.hunt_candidates(sim, friedman), [])
        fork = self.check(housing_forks.house_hunt_fork(sim, ruth), "house_hunt", True)
        sale = housing.sale_proceeds(sim, "park_78")
        self.assertEqual(labels(fork), [
            f"Sell 78 Park Avenue (about ${sale:,}) and buy the smaller 12 River Road for $11,550",
            f"Sell 78 Park Avenue (about ${sale:,}) and rent Elm Court, flat 1A for $180/week",
            "Keep looking for the right smaller place",
            "Stay in 78 Park Avenue: it's home"])
        self.assertEqual(fork.question, "Your household has $10,000 put by. You own 78 Park Avenue, worth about "
                                        "$31,900: more home than you need in retirement. Nothing better is on the "
                                        "market, but a smaller place is. Do you downsize?")
        buy, rent, look, stay = fork.options
        settle = {"house_hunt": housing_forks.DOWNSIZE_SETTLE, "downsized": housing_forks.DOWNSIZE_SETTLED}
        self.assertEqual(buy.extra, {"move": "river_12", "how": "buy", "settle": settle})  # once the move goes through
        self.assertEqual(rent.extra, {"move": "elm_court_1a", "how": "rent", "settle": settle})
        self.assertEqual((buy.cost, rent.cost), (0, 0))  # the sale pays for it
        self.assertTrue(all(o.household_pays and not o.charge for o in (buy, rent)))
        self.assertEqual([o.id for o in buy.outcomes], ["fresh_start", "homesick"])  # no children to upset
        self.assertEqual(buy.tags, {"thrift": 0.6, "family": -0.1, "adventure": 0.2})  # housing_trouble's options
        self.assertEqual(rent.tags, {"thrift": 0.7, "family": -0.3, "adventure": 0.2})
        retired = housing_forks.DOWNSIZE_BASE + housing_forks.DOWNSIZE_RETIRED
        self.assertAlmostEqual(buy.base, retired)
        self.assertAlmostEqual(rent.base, retired - 0.05)
        self.assertEqual(look.extra, {"hh_cooldown": 14 * DAY})
        self.assertEqual(stay.extra, {"hh_cooldown": housing_forks.DOWNSIZE_STAY})
        self.assertEqual(friedman.cooldowns["house_hunt"], sim.clock.tick + housing_forks.HUNT_COOLDOWN)
        self.assertIsNone(housing_forks.house_hunt_fork(sim, sim.agents["david"]))  # one fork a household
        scores = forks.default_scores(ruth, fork, sim)
        self.assertEqual(scores.index(max(scores)), 0)  # Ruth would sell up and buy the smaller house

    def test_house_hunt_downsizing_by_bedrooms(self):
        """The Cohens buy a four-bedroom house, three of them: one bedroom to spare. Once Noa is gone they have two to
        spare, but downsizing crosses their minds only DOWNSIZE_AFTER_MOVE_DAYS after they moved in."""
        sim = FakeSim(tick=at(10, 18, 30))
        dana = sim.agents["dana"]
        cohen = sim.households["cohen"]
        set_funds(sim, "cohen", 25000)
        self.assertTrue(housing.move_household(sim, cohen, "main_55", "buy"))
        set_funds(sim, "cohen", 3000)
        cohen.cooldowns.clear()
        after = cohen.moved_tick + housing_forks.DOWNSIZE_AFTER_MOVE_DAYS * DAY  # a Friday, 18:30
        sim.clock.tick = after
        self.assertIsNone(housing_forks.house_hunt_fork(sim, dana))  # three in four bedrooms
        gone(sim, "noa")  # now two in four
        cohen.cooldowns.clear()
        sim.clock.tick = after - DAY
        self.assertIsNone(housing_forks.house_hunt_fork(sim, dana))  # 129 days into the game, 119 in the house
        cohen.cooldowns.clear()
        sim.clock.tick = after
        fork = self.check(housing_forks.house_hunt_fork(sim, dana), "house_hunt", True)
        self.assertIn("more home than you need with 4 bedrooms for the 2 of you.", fork.question)
        self.assertTrue(labels(fork)[0].endswith("buy the smaller 12 River Road for $11,550"), labels(fork))
        self.assertAlmostEqual(fork.options[0].base, housing_forks.DOWNSIZE_BASE)  # not retired: no lift
        scores = forks.default_scores(dana, fork, sim)
        self.assertEqual(scores.index(max(scores)), 3, scores)  # Dana stays: it's home

    def test_house_hunt_downsizing_with_one_move(self):
        sim = FakeSim(tick=at(95, 18, 30))
        hide(sim, "river_12", "main_55")
        fork = self.check(housing_forks.house_hunt_fork(sim, sim.agents["ruth"]), "house_hunt", True)
        self.assertEqual(labels(fork)[0], "Talk it over and decide another time")  # no smaller home for sale
        self.assertEqual(fork.options[0].extra, {"hh_cooldown": 7 * DAY})
        self.assertTrue(labels(fork)[1].endswith("and rent Elm Court, flat 1A for $180/week"))
        sim = FakeSim(tick=at(95, 18, 30))
        hide(sim, *[h.id for h in housing.vacancies(sim, "for_rent")])
        fork = self.check(housing_forks.house_hunt_fork(sim, sim.agents["ruth"]), "house_hunt", True)
        self.assertTrue(labels(fork)[0].endswith("buy the smaller 12 River Road for $11,550"))
        self.assertEqual(labels(fork)[1], "Talk it over and decide another time")
        hide(sim, "river_12", "main_55")
        sim.households["friedman"].cooldowns.clear()
        self.assertIsNone(housing_forks.house_hunt_fork(sim, sim.agents["ruth"]))  # nowhere smaller to go
        self.assertEqual(sim.households["friedman"].cooldowns["house_hunt"],
                         sim.clock.tick + housing_forks.NO_CANDIDATE_RETRY)

    def test_house_hunt_downsizing_gates(self):
        sim = FakeSim(tick=at(88, 18, 30))  # a Friday evening
        friedman, ruth = sim.households["friedman"], sim.agents["ruth"]
        self.assertIsNone(housing_forks.house_hunt_fork(sim, ruth))  # too early in the game
        friedman.cooldowns.clear()
        sim.clock.tick = at(91, 18, 30)  # Monday
        self.assertIsNotNone(housing_forks.house_hunt_fork(sim, ruth))
        friedman.cooldowns.clear()
        set_funds(sim, "friedman", 60000)  # now a better big house is within reach: the usual hunt
        fork = housing_forks.house_hunt_fork(sim, ruth)
        self.assertTrue(labels(fork)[0].startswith("Buy "), labels(fork))
        sim = FakeSim(tick=at(95, 18, 30))
        self.assertIsNone(housing_forks.house_hunt_fork(sim, sim.agents["tom"]))  # the Levis haven't outgrown theirs
        self.assertIsNone(housing_forks.house_hunt_fork(sim, sim.agents["lea"]))  # retired, but renting
        sim.households["friedman"].cooldowns["downsized"] = sim.clock.tick + DAY  # downsized once this year
        self.assertIsNone(housing_forks.house_hunt_fork(sim, sim.agents["ruth"]))
        sim.clock.tick += 3 * DAY  # Monday evening
        self.assertIsNotNone(housing_forks.house_hunt_fork(sim, sim.agents["ruth"]))

    def test_downsizing_gets_more_inviting_month_by_month(self):
        sim = FakeSim()
        friedman, ruth = sim.households["friedman"], sim.agents["ruth"]
        retired = housing_forks.DOWNSIZE_BASE + housing_forks.DOWNSIZE_RETIRED
        drift, most = housing_forks.DOWNSIZE_DRIFT, housing_forks.DOWNSIZE_DRIFT_MAX
        for day, months in ((95, 0), (119, 0), (120, 1), (155, 2), (400, 10)):  # weekday evenings
            with self.subTest(day=day):
                friedman.cooldowns.clear()
                sim.clock.tick = at(day, 18, 30)
                buy, rent, look, stay = self.check(housing_forks.house_hunt_fork(sim, ruth), "house_hunt", True).options
                self.assertAlmostEqual(buy.base, retired + min(most, drift * months))
                self.assertAlmostEqual(rent.base, retired - 0.05 + min(most, drift * months))
                self.assertEqual((look.base, stay.base), (0.1, 0.15))  # staying doesn't drift

    def test_downsizing_is_more_inviting_when_no_house_is_for_sale(self):
        """Every house for sale is bought on day 60. By day 95 none has been for sale for two weeks: selling up is
        more inviting, and the Friedmans hear why. The day another house comes up, it is as before."""
        sim = FakeSim(tick=at(60, 18, 30))
        for hh_id, home_id in (("weiss", "river_12"), ("shapiro", "main_55"), ("peretz", "park_66"),
                               ("amar", "park_104"), ("cohen", "river_28")):
            self.assertTrue(housing.move_household(sim, sim.households[hh_id], home_id, "buy", check=False))
        self.assertEqual(housing.vacancies(sim, "for_sale"), [])
        sim.clock.tick = at(74, 18, 29)
        self.assertFalse(housing.house_drought(sim))  # 13 days, 23 hours and 59 minutes
        sim.clock.tick = at(95, 18, 30)
        self.assertTrue(housing.house_drought(sim))
        ruth = sim.agents["ruth"]
        later, rent, look, stay = self.check(housing_forks.house_hunt_fork(sim, ruth), "house_hunt", True).options
        self.assertEqual(later.label, "Talk it over and decide another time")  # nothing smaller for sale
        retired = housing_forks.DOWNSIZE_BASE + housing_forks.DOWNSIZE_RETIRED
        self.assertAlmostEqual(rent.base, retired - 0.05 + housing_forks.DOWNSIZE_SCARCE)
        self.assertEqual((look.base, stay.base), (0.1, 0.15))
        fork = housing_forks.house_hunt_fork(sim, ruth) or self.fork_again(sim, ruth)
        self.assertTrue(fork.question.endswith("Nothing better is on the market, but a smaller place is, and no "
                                               "house has been for sale in Millbrook for 2 weeks. Do you downsize?"),
                        fork.question)
        self.assertTrue(housing.move_household(sim, sim.households["weiss"], "elm_court_1a", "rent", check=False))
        self.assertFalse(housing.house_drought(sim))  # 12 River Road is back on the market
        fork = self.fork_again(sim, ruth)
        self.assertTrue(fork.question.endswith("but a smaller place is. Do you downsize?"), fork.question)
        self.assertAlmostEqual(fork.options[1].base, retired - 0.05)

    def fork_again(self, sim, agent):
        sim.households[agent.household_id].cooldowns.clear()
        return self.check(housing_forks.house_hunt_fork(sim, agent), "house_hunt", True)

    # upkeep

    def test_upkeep(self):
        sim = FakeSim(tick=SATURDAY)
        fork = self.check(housing_forks.upkeep_fork(sim, sim.agents["tom"]), "upkeep", False)
        self.assertEqual(labels(fork), ["Hire Millbrook Builders for a proper job ($240)",
                                        "Do it yourself this weekend ($50 in materials)",
                                        "Just tidy up and patch the worst bits ($10)", "Leave it for another time"])
        self.assertEqual(fork.question, "28 Main Street is looking worn (condition 66/100). What do you do about it "
                                        "this weekend?")
        self.assertEqual([o.household_pays for o in fork.options], [True, True, True, False])
        self.assertEqual(fork.options[0].extra, {"repair": 34, "works": 240})
        self.assertEqual(sim.households["levi"].cooldowns["upkeep"], sim.clock.tick + 5 * DAY)
        self.assertIsNone(housing_forks.upkeep_fork(sim, sim.agents["miriam"]))  # one fork a household

    def test_upkeep_a_full_renovation(self):
        sim = FakeSim(tick=SATURDAY)
        sim.lots["park_78"].condition = 30
        fork = self.check(housing_forks.upkeep_fork(sim, sim.agents["ruth"]), "upkeep", False)
        self.assertEqual(labels(fork)[0], "Hire Millbrook Builders for a full renovation ($2,140)")
        self.assertEqual(labels(fork)[1], "Do it yourself this weekend ($120 in materials)")
        self.assertEqual(fork.options[3].outcomes[0].p, 0.7)  # the neighbours talk about a neglected house

    def test_upkeep_gates(self):
        sim = FakeSim(tick=at(1, 10))
        self.assertIsNone(housing_forks.upkeep_fork(sim, sim.agents["tom"]))  # a weekday
        sim.clock.tick = SATURDAY
        self.assertIsNone(housing_forks.upkeep_fork(sim, sim.agents["dana"]))  # renters don't
        self.assertIsNone(housing_forks.upkeep_fork(sim, sim.agents["omer"]))  # park_21 is at 90
        sim.homes["main_28"].emergency = {"kind": "leak", "since": sim.clock.tick}
        self.assertIsNone(housing_forks.upkeep_fork(sim, sim.agents["tom"]))  # the emergency comes first

    def test_upkeep_on_the_first_evenings_in_a_run_down_home(self):
        sim = FakeSim(tick=at(1, 18))  # Tuesday 18:00
        sim.lots["river_28"].condition = housing.MARKET_FLOOR  # bought at the market floor
        cohen, dana = sim.households["cohen"], sim.agents["dana"]
        self.assertTrue(housing.move_household(sim, cohen, "river_28", "buy"))
        fork = self.check(housing_forks.upkeep_fork(sim, dana), "upkeep", False)
        self.assertEqual(fork.question, "28 River Road is looking run-down (condition 20/100). You have only just "
                                        "moved in. What do you do about it?")
        self.assertEqual(labels(fork), ["Hire Millbrook Builders for a full renovation ($1,000)",
                                        "Do it yourself this evening ($50 in materials)",
                                        "Just tidy up and patch the worst bits ($10)", "Leave it for another time"])
        self.assertEqual(fork.options[0].extra, {"repair": 80, "works": housing_forks.BUILDERS_WORKS})
        scores = forks.default_scores(dana, fork, sim)
        self.assertEqual(scores.index(max(scores)), 0)  # the builders, that same evening
        self.assertEqual(cohen.cooldowns["upkeep"], sim.clock.tick + housing_forks.UPKEEP_COOLDOWN)

    def test_upkeep_on_weekday_evenings_only_while_fresh_and_run_down(self):
        sim = FakeSim(tick=at(1, 18))
        cohen, dana = sim.households["cohen"], sim.agents["dana"]
        sim.lots["main_55"].condition = 45  # shabby, not run-down: it waits for the weekend
        set_funds(sim, "cohen", 40000)
        self.assertTrue(housing.move_household(sim, cohen, "main_55", "buy"))
        self.assertIsNone(housing_forks.upkeep_fork(sim, dana))
        sim.lots["main_55"].condition = 39
        sim.clock.tick = at(1, 17)  # not the household's time
        self.assertIsNone(housing_forks.upkeep_fork(sim, dana))
        sim.clock.tick = at(1, 21)
        self.assertIsNone(housing_forks.upkeep_fork(sim, dana))
        sim.clock.tick = at(8, 18)  # a week on, it waits for the weekend like any other
        self.assertIsNone(housing_forks.upkeep_fork(sim, dana))
        sim.clock.tick = at(7, 20, 59)  # the last evening of the first week
        self.assertIsNotNone(housing_forks.upkeep_fork(sim, dana))
        cohen.cooldowns.clear()
        sim.clock.tick = at(12, 9)  # Saturday morning: the usual weekend upkeep
        fork = housing_forks.upkeep_fork(sim, dana)
        self.assertEqual(labels(fork)[1], "Do it yourself this weekend ($50 in materials)")
        self.assertTrue(fork.question.endswith("What do you do about it this weekend?"))

    # repair

    def test_repair_with_and_without_a_friend(self):
        sim = FakeSim(tick=at(1, 10))
        sim.homes["main_28"].emergency = {"kind": "leak", "since": sim.clock.tick}
        lonely(sim, "tom")
        fork = self.check(housing_forks.repair_fork(sim, sim.agents["tom"]), "repair", False)
        self.assertEqual(labels(fork), ["Call an emergency plumber now ($180)", "Try to fix it yourself ($30 in parts)",
                                        "Call the cheapest handyman in the paper ($90)",
                                        "Put a bucket under it and deal with it later"])
        self.assertEqual(fork.question, "Trouble at home: a pipe has burst in the kitchen at 28 Main Street. "
                                        "What do you do?")
        self.assertEqual(sim.households["levi"].cooldowns["repair"], sim.clock.tick + 60)
        self.assertIsNone(housing_forks.repair_fork(sim, sim.agents["miriam"]))
        self.assertEqual(fork.options[3].extra, {"hh_cooldown": DAY})
        self.assertEqual([o.group for o in fork.options[1].outcomes], ["diy", "diy", None])
        sim.households["levi"].cooldowns.clear()
        sim.agents["tom"].relate("dana", RelationKind.FRIEND, 40)
        fork = self.check(housing_forks.repair_fork(sim, sim.agents["tom"]), "repair", False)
        self.assertEqual(labels(fork)[2], "Ask Dana to come and help ($20 for pizza)")
        self.assertEqual(fork.options[2].extra, {"ask_help": "dana"})

    def test_repair_by_kind(self):
        sim = FakeSim(tick=at(1, 10))
        for kind, trade, wait in (("boiler", "heating engineer", "Wrap up warm and deal with it later"),
                                  ("roof", "roofer", "Put a bucket under it and deal with it later"),
                                  ("electrics", "electrician", "Use candles and deal with it later")):
            sim.homes["park_92"].emergency = {"kind": kind, "since": sim.clock.tick}
            sim.households["halabi"].cooldowns.clear()
            fork = self.check(housing_forks.repair_fork(sim, sim.agents["shai"]), "repair", False)
            self.assertEqual(labels(fork)[0], f"Call an emergency {trade} now ($300)")
            self.assertEqual(labels(fork)[1], "Try to fix it yourself ($50 in parts)")
            self.assertEqual(labels(fork)[3], wait)

    # housing_trouble

    def test_trouble_an_owner_in_the_red(self):
        sim = FakeSim(tick=MONDAY_EVENING)
        levi = sim.households["levi"]
        set_funds(sim, "levi", -500)
        levi.arrears = 1
        lonely(sim, "tom")
        fork = self.check(housing_forks.housing_trouble_fork(sim, sim.agents["tom"]), "housing_trouble", True)
        sale = housing.sale_proceeds(sim, "main_28")
        self.assertEqual(labels(fork), [
            f"Sell 28 Main Street (about ${sale:,}) and rent Elm Court, flat 1A for $180/week",
            "Sell some furniture and belongings (about $300)",
            "Cut back hard for a few weeks: no treats, no repairs",
            "Hope things pick up on their own"])
        self.assertEqual(fork.question, "Money is tight: your household is $500 in the red after this week's bills. "
                                        "What do you do?")
        down = fork.options[0]
        self.assertEqual((down.cost, down.household_pays, down.charge), (0, True, False))
        self.assertEqual(down.extra, {"move": "elm_court_1a", "how": "rent"})
        self.assertEqual(fork.options[2].extra, {"belt_tighten": 14 * DAY})
        self.assertEqual(levi.cooldowns["housing_trouble"], sim.clock.tick + 3 * DAY)
        self.assertEqual(levi.trouble_seen, 1)
        self.assertIsNone(housing_forks.housing_trouble_fork(sim, sim.agents["miriam"]))  # one a household
        levi.cooldowns.clear()
        sim.agents["tom"].relate("rina", RelationKind.FRIEND, 50)  # $20,100 put by
        fork = self.check(housing_forks.housing_trouble_fork(sim, sim.agents["tom"]), "housing_trouble", True)
        self.assertEqual(labels(fork)[1], "Ask Rina to help out with $800")
        helps = fork.options[1].outcomes
        self.assertEqual([o.group for o in helps], ["help"] * 3)
        self.assertEqual(list(helps[0].effects)[:2], ["amount", "gift_from"])
        self.assertEqual(helps[0].effects["amount"], 800)

    def test_trouble_downsizing_a_big_house(self):
        sim = FakeSim(tick=MONDAY_EVENING)
        halabi = sim.households["halabi"]
        set_funds(sim, "halabi", -500)
        halabi.arrears = 2
        fork = self.check(housing_forks.housing_trouble_fork(sim, sim.agents["shai"]), "housing_trouble", True)
        sale = housing.sale_proceeds(sim, "park_92")
        self.assertEqual(labels(fork)[:2], [
            f"Sell 92 Park Avenue (about ${sale:,}) and buy the smaller 12 River Road for $11,550",
            f"Sell 92 Park Avenue (about ${sale:,}) and rent Elm Court, flat 2B for $220/week"])
        self.assertTrue(fork.question.endswith("The bank wants its money. What do you do?"))
        self.assertAlmostEqual(fork.options[0].base, 0.35 + 0.25)  # second week: esc 1
        self.assertAlmostEqual(fork.options[2].base, 0.3 - 0.2)
        self.assertAlmostEqual(fork.options[3].base, -0.1 - 0.2)
        self.assertIn("kids_upset", [o.id for o in fork.options[0].outcomes])

    def test_decision_53_always_four(self):
        sim = FakeSim(tick=MONDAY_EVENING)
        hh = sim.households["avraham"]  # Tamar has no car and rents a $180 flat, the cheapest there is
        tamar = sim.agents["tamar"]
        set_funds(sim, "avraham", -1000)
        hh.arrears = 1
        lonely(sim, "tamar")
        tamar.relate("ari", RelationKind.FRIEND, 60)  # $2,912 put by: not enough to ask for $1,300
        hh.cooldowns["sell_stuff"] = sim.clock.tick + 10 * DAY
        fork = self.check(housing_forks.housing_trouble_fork(sim, tamar), "housing_trouble", True)
        self.assertEqual(labels(fork), ["Ask Millbrook Homes for a few weeks' grace",
                                        "Pick up odd jobs around the neighbourhood (about $100)",
                                        "Cut back hard for a few weeks: no treats, no repairs",
                                        "Hope things pick up on their own"])
        grace, odd = fork.options[:2]
        self.assertEqual(grace.steps, [("phone_call", None)])
        self.assertEqual(odd.steps, [("odd_jobs", None)])
        self.assertEqual((grace.cost, odd.cost), (0, 0))
        self.assertAlmostEqual(grace.base, 0.2)
        self.assertAlmostEqual(odd.base, 0.25)
        self.assertEqual(grace.tags, {"thrift": 0.3, "diligence": 0.2, "social": 0.2})
        self.assertEqual(odd.tags, {"diligence": 0.6, "thrift": 0.4, "adventure": 0.2, "health": -0.2})
        self.assertEqual([(o.id, o.p, o.valence, o.effects, o.group) for o in grace.outcomes],
                         [("granted", 0.6, 1, {"grace": 14}, "grace"), ("refused", 1.0, 0, {"fun": -6}, "grace")])
        self.assertEqual([(o.id, o.p, o.valence, o.effects, o.group) for o in odd.outcomes],
                         [("paid", 0.65, 1, {"money": 100}, "odd"), ("no_takers", 1.0, 0, {"fun": -4}, "odd")])
        self.assertEqual(odd.extra, {"odd_jobs": True})
        # One chain item left: belongings, then grace.
        hh.cooldowns.clear()
        fork = self.check(housing_forks.housing_trouble_fork(sim, tamar), "housing_trouble", True)
        self.assertEqual(labels(fork)[:2], ["Sell some furniture and belongings (about $300)",
                                            "Ask Millbrook Homes for a few weeks' grace"])

    def test_the_fallbacks_ration_their_good_outcomes(self):
        sim = FakeSim(tick=MONDAY_EVENING)
        hh, tamar = sim.households["avraham"], sim.agents["tamar"]
        set_funds(sim, "avraham", -1000)
        hh.arrears = 1
        lonely(sim, "tamar")
        hh.cooldowns["sell_stuff"] = sim.clock.tick + 10 * DAY
        fork = housing_forks.housing_trouble_fork(sim, tamar)
        now = sim.clock.tick
        self.assertTrue(housing.apply_effect(sim, tamar, "grace", 14))
        self.assertEqual(hh.grace_until, now + 14 * DAY)
        self.assertEqual(hh.cooldowns["grace"], now + housing.GRACE_DAYS * DAY)
        housing.apply_extra(sim, tamar, fork, fork.options[1])
        self.assertEqual(hh.cooldowns["odd_jobs"], now + housing.ODD_JOBS_DAYS * DAY)
        sim.clock.tick += 3 * DAY
        fork = self.check(housing_forks.housing_trouble_fork(sim, tamar), "housing_trouble", True)
        self.assertEqual([o.p for o in fork.options[0].outcomes], [0.0, 1.0])  # asked too recently
        self.assertEqual([o.p for o in fork.options[1].outcomes], [0.0, 1.0])

    def test_belongings_once_in_28_days(self):
        sim = FakeSim(tick=MONDAY_EVENING)
        hh, tamar = sim.households["avraham"], sim.agents["tamar"]
        set_funds(sim, "avraham", -1000)
        hh.arrears = 1
        lonely(sim, "tamar")
        fork = housing_forks.housing_trouble_fork(sim, tamar)
        stuff = fork.options[0]
        self.assertEqual(stuff.extra, {"sell_stuff": 300})
        money = tamar.money
        housing.apply_extra(sim, tamar, fork, stuff)
        self.assertEqual(tamar.money, money + 300)
        self.assertEqual(sim.texts("stuff_sold"), ["Tamar Avraham sells some furniture for $300."])
        self.assertEqual(hh.cooldowns["sell_stuff"], sim.clock.tick + 28 * DAY)
        for days in (3, 21):  # Thursday, then 24 days on: a Thursday again
            sim.clock.tick += days * DAY
            fork = self.check(housing_forks.housing_trouble_fork(sim, tamar), "housing_trouble", True)
            self.assertNotIn("Sell some furniture and belongings (about $300)", labels(fork))
        sim.clock.tick += 4 * DAY  # 28 days on
        hh.cooldowns["housing_trouble"] = 0
        fork = housing_forks.housing_trouble_fork(sim, tamar)
        self.assertIn("Sell some furniture and belongings (about $300)", labels(fork))

    def test_trouble_a_house_falling_apart(self):
        sim = FakeSim(tick=MONDAY_EVENING)
        friedman = sim.households["friedman"]
        sim.lots["park_78"].condition = 30
        set_funds(sim, "friedman", 2000)
        fork = self.check(housing_forks.housing_trouble_fork(sim, sim.agents["ruth"]), "housing_trouble", True)
        self.assertEqual(fork.question, "78 Park Avenue is falling apart and a proper renovation would cost about "
                                        "$2,140, more than you can spare. What do you do?")
        self.assertEqual(labels(fork)[3], "Live with it for now")
        self.assertEqual(friedman.cooldowns["housing_trouble"], sim.clock.tick + 7 * DAY)
        sale = housing.sale_proceeds(sim, "park_78")
        self.assertEqual(labels(fork)[:2], [
            f"Sell 78 Park Avenue (about ${sale:,}) and buy the smaller 12 River Road for $11,550",
            f"Sell 78 Park Avenue (about ${sale:,}) and rent Elm Court, flat 1A for $180/week"])
        friedman.cooldowns.clear()
        fork = housing_forks.housing_trouble_fork(sim, sim.agents["ruth"])
        self.assertAlmostEqual(fork.options[3].base, -0.1 - 0.2)  # the second time: esc 1

    def test_no_trouble(self):
        sim = FakeSim(tick=MONDAY_EVENING)
        for agent in sim.agents.values():
            self.assertIsNone(housing_forks.housing_trouble_fork(sim, agent), agent.id)
        sim.households["avraham"].arrears = 1  # arrears but back in the black
        self.assertIsNone(housing_forks.housing_trouble_fork(sim, sim.agents["tamar"]))

    def test_the_downsize_move_skips_the_gate(self):
        sim = FakeSim(tick=MONDAY_EVENING)
        levi = sim.households["levi"]
        set_funds(sim, "levi", -500)
        levi.arrears = 1
        lonely(sim, "tom")
        sim.agents["tom"].job = None  # Miriam's pension can't carry the flat by the house_hunt rule
        fork = housing_forks.housing_trouble_fork(sim, sim.agents["tom"])
        self.assertFalse(housing.affordable(sim, levi, "elm_court_1a"))
        housing.apply_extra(sim, sim.agents["tom"], fork, fork.options[0])
        self.assertEqual(levi.home_id, "elm_court_1a")
        self.assertEqual(sim.tagged("too_late"), [])

    def test_the_household_cooldown_is_shared(self):
        sim = FakeSim(tick=at(0, 18, 30))
        self.assertIsNotNone(housing_forks.house_hunt_fork(sim, sim.agents["dana"]))
        self.assertIsNone(housing_forks.house_hunt_fork(sim, sim.agents["yossi"]))
        sim.clock.tick += 7 * DAY
        fork = housing_forks.house_hunt_fork(sim, sim.agents["yossi"])
        self.assertIsNotNone(fork)
        housing.apply_extra(sim, sim.agents["yossi"], fork, fork.options[3])  # stay: not again for 14 days
        self.assertEqual(sim.households["cohen"].cooldowns["house_hunt"], sim.clock.tick + 14 * DAY)


# --- the real engine (needs P0c's hooks) -------------------------------------------------------

class EngineTest(unittest.TestCase):
    def setUp(self):
        from gameofailife.sim import Simulation
        self.sim = Simulation(seed=SEED, now=lambda: 0.0)

    def option(self, label, base, **kw):
        from gameofailife.forks import Option
        return Option(label, [("relax_home", "home")], base=base, **kw)

    def test_a_major_fork_needs_a_lead_of_1_to_be_habit(self):
        from gameofailife.forks import Fork
        sim = self.sim
        cases = [("dana", True, 0.45, "asked"), ("yossi", True, 0.99, "asked"), ("avi", True, 1.0, "habit"),
                 ("rina", True, 1.3, "habit"), ("omer", False, 0.45, "habit"), ("gal", False, 0.3, "asked")]
        for who, major, lead, expect in cases:
            agent = sim.agents[who]
            agent.controller = "tester"
            fork = Fork(agent.id, "house_hunt" if major else "free_time", "?",
                        [self.option(f"{who} {i}", b) for i, b in enumerate((lead, 0.0, -0.1, -0.2))],
                        sim.clock.tick, major=major)
            sim.director(agent, fork)
            if expect == "asked":
                self.assertEqual(fork.status, "asked", (who, lead))
                self.assertIn(("tester", fork.id), [(c, m.get("fork_id")) for c, m in sim.outbox])
                self.assertEqual(fork.controller, "tester")  # the controller asked (PLAN 3.6) ...
            else:
                self.assertEqual((fork.status, fork.decided_by), ("decided", "habit"), (who, lead))
                self.assertIsNone(fork.controller, who)  # ... or none, when habit settled it
            self.assertEqual(fork.profile_choice, 0)

    def test_outcome_groups_are_exclusive(self):
        from gameofailife.forks import Fork, Outcome
        sim, dana = self.sim, self.sim.agents["dana"]
        opt = self.option("Group test", 0.0, outcomes=[
            Outcome("g_first", "First", 1.0, +1, {"fun": 1}, group="g"),
            Outcome("g_second", "Second", 1.0, +1, {"fun": 1}, group="g"),
            Outcome("loose_one", "Loose", 1.0, +1, {"fun": 1}),
            Outcome("h_miss", "Miss", 1e-12, +1, {"fun": 1}, group="h"),
            Outcome("h_sure", "Sure", 1.0, 0, {"fun": 1}, group="h")])
        fork = Fork(dana.id, "free_time", "?", [opt] + [self.option(f"x{i}", 0) for i in range(3)], sim.clock.tick)
        sim._decide(dana, fork, 0, "default", "test")
        self.assertEqual([p["outcome"].id for p in dana.pending_outcomes], ["g_first", "loose_one", "h_sure"])
        rolled = " ".join(str(e.get("what")) for e in sim.luck_log)
        for oid in ("g_first", "loose_one", "h_miss", "h_sure"):
            self.assertIn(oid, rolled)
        self.assertNotIn("g_second", rolled)  # neither rolled nor logged

    def test_household_pays_and_charge(self):
        from gameofailife.forks import Fork
        sim, tom = self.sim, self.sim.agents["tom"]
        levi = sim.households["levi"]
        funds, money = housing.funds(sim, levi), tom.money
        pot = self.option("From the pot", 0, cost=300, household_pays=True)
        fork = Fork(tom.id, "upkeep", "?", [pot] + [self.option(f"y{i}", 0) for i in range(3)], sim.clock.tick)
        sim._decide(tom, fork, 0, "default", "")
        self.assertAlmostEqual(housing.funds(sim, levi), funds - 300)
        self.assertGreater(tom.money, money - 300)  # split by what each adult has; Miriam has more
        self.assertIsNone(getattr(tom, "paid", None))
        funds = housing.funds(sim, levi)
        free = self.option("Paid elsewhere", 0, cost=500, household_pays=True, charge=False)
        fork = Fork(tom.id, "upkeep", "?", [free] + [self.option(f"z{i}", 0) for i in range(3)], sim.clock.tick)
        tom.state = "idle"
        sim._decide(tom, fork, 0, "default", "")
        self.assertAlmostEqual(housing.funds(sim, levi), funds)

    def test_buying_through_the_fork_pays_once(self):
        sim = self.sim
        sim.clock.tick = at(0, 18, 30)
        dana = sim.agents["dana"]
        cohen = sim.households["cohen"]
        fork = housing_forks.house_hunt_fork(sim, dana)
        funds = housing.funds(sim, cohen)
        price, reno = housing.value(sim, "river_28"), housing.reno_cost(sim, "river_28")
        self.assertGreater(reno, 0)  # bought run-down, with its renovation
        sim._decide(dana, fork, 0, "model", "")
        self.assertEqual(cohen.home_id, "river_28")
        self.assertAlmostEqual(housing.funds(sim, cohen), funds - price - housing.MOVING_COST - reno)
        self.assertEqual(housing.condition_of(sim, "river_28"), 100)
        self.assertEqual(dana.activity_place, "river_28")
        self.assertEqual(sim.homes["main_20"].listing, "for_rent")

    def test_a_failed_move_sends_the_decider_home(self):
        """The listing goes while the controller thinks: _decide's start_plan(opt.steps) must not take the decider
        to move house in a home that isn't theirs, and nothing the move promised is rolled."""
        sim = self.sim
        sim.clock.tick = at(0, 18, 30)
        dana = sim.agents["dana"]
        cohen = sim.households["cohen"]
        fork = housing_forks.house_hunt_fork(sim, dana)
        self.assertEqual(fork.options[0].extra,
                         {"move": "river_28", "how": "buy", "renovate": housing.reno_cost(sim, "river_28")})
        funds, cond = housing.funds(sim, cohen), housing.condition_of(sim, "river_28")
        hide(sim, "river_28")  # another buyer has it under offer
        sim._decide(dana, fork, 0, "model", "")
        self.assertEqual(cohen.home_id, "main_20")
        self.assertAlmostEqual(housing.funds(sim, cohen), funds)  # no price, no van, no renovation
        self.assertEqual(housing.condition_of(sim, "river_28"), cond)
        self.assertIn("The Cohens were too late: 28 River Road has been sold.", [e["text"] for e in sim.events])
        self.assertEqual(dana.activity_place, "main_20")
        self.assertNotIn(fork.id, " ".join(str(e.get("what")) for e in sim.luck_log))
        for _ in range(120):
            sim.step()
            self.assertFalse(dana.activity == "move_house" or dana.activity_place == "river_28", sim.clock.stamp())

    def haggle(self, hit: str):
        """Dana offers 90% for 28 River Road on the first evening, and the seller's answer will be `hit`."""
        sim = self.sim
        sim.clock.tick = at(0, 18, 30)
        dana = sim.agents["dana"]
        fork = housing_forks.house_hunt_fork(sim, dana)
        haggle = fork.options[1]
        for out in haggle.outcomes:
            out.p = 1.0 if out.id == hit else 0.0
        sim._decide(dana, fork, 1, "model", "")
        return dana, fork

    def test_a_haggle_holds_the_home_through_the_viewing(self):
        """Without the hold the Segals buy 28 River Road a minute later, and the record says the Cohens were too
        late and then that the seller accepted."""
        sim = self.sim
        dana, fork = self.haggle("offer_accepted")
        cohen = sim.households["cohen"]
        price = housing._int(housing.value(sim, "river_28") * 0.9)
        for _ in range(6 * 60):
            sim.step()
            if cohen.home_id == "river_28":
                break
        self.assertEqual(sim.homes["river_28"].household, "cohen")  # not the Segals
        self.assertEqual((cohen.home_id, cohen.history[-1]["price"]), ("river_28", price))
        self.assertEqual([e["text"] for e in sim.events if e["tag"] == "too_late" and "River Road" in e["text"]
                          and "Cohens" in e["text"]], [])
        summary = next(f for f in dana.forks if f["id"] == fork.id)
        self.assertEqual(summary["happened"], ["The seller accepts the offer"])

    def test_a_refused_haggle_puts_the_home_back_on_the_market(self):
        sim = self.sim
        dana, fork = self.haggle("refused")
        home = sim.homes["river_28"]
        self.assertEqual(home.held_for, "cohen")
        summary = next(f for f in dana.forks if f["id"] == fork.id)
        for _ in range(6 * 60):
            sim.step()
            if summary["happened"]:
                break
        self.assertEqual(summary["happened"], ["The seller turns the offer down"])
        self.assertEqual(sim.households["cohen"].home_id, "main_20")
        self.assertIsNone(home.held_for)
        self.assertTrue(home.household is not None or "river_28" in [h.id for h in housing.vacancies(sim)])

    def test_build_fork_asks_one_partner(self):
        from gameofailife.forks import build_fork
        sim = self.sim
        sim.clock.tick = at(0, 18, 30)
        fork = build_fork(sim, sim.agents["dana"])
        self.assertEqual(fork.kind, "house_hunt")
        self.assertTrue(fork.major)
        again = build_fork(sim, sim.agents["yossi"])
        self.assertTrue(again is None or again.kind != "house_hunt")

    def test_a_pending_emergency_never_leaks_from_the_engine(self):
        sim = self.sim
        sim.clock.tick = at(0, 18, 30)
        home = sim.homes["main_28"]
        home.pending_emergency = {"kind": "leak", "due": sim.clock.tick + 90}
        dana = sim.agents["dana"]
        fork = housing_forks.house_hunt_fork(sim, dana)
        frames = [sim.state_json(), sim.agent_json("tom"), sim.agent_json("miriam"), sim.fork_message(dana, fork),
                  housing.home_page(sim, "main_28")]
        self.assertTrue(SECRET.isdisjoint(walk_keys(frames)))
        self.assertIsNone(sim.state_json()["homes"]["main_28"]["emergency"])
        self.assertIsNone(sim.agent_json("tom")["possessions"]["home"]["emergency"])
        for _ in range(90):
            sim.step()
        self.assertEqual(sim.state_json()["homes"]["main_28"]["emergency"], "leak")
        self.assertEqual(sim.agent_json("tom")["possessions"]["home"]["emergency"]["kind"], "leak")
        self.assertTrue(SECRET.isdisjoint(walk_keys([sim.state_json(), sim.agent_json("tom")])))


    def test_a_fixer_upper_is_renovated_the_evening_it_is_bought(self):
        sim = self.sim
        while sim.clock.tick < at(0, 17):  # a Monday
            sim.step()
        cohen = sim.households["cohen"]
        sim.lots["river_28"].condition = float(housing.MARKET_FLOOR)  # bought at the market floor
        self.assertTrue(housing.move_household(sim, cohen, "river_28", "buy"))
        played = []
        director = sim.director

        def watch(agent, fork):
            played.append((agent.household_id, fork))
            director(agent, fork)

        sim.director = watch
        events = sim.drain()[0]
        while sim.clock.tick < at(1, 1):  # past the first midnight
            sim.step()
            events += sim.drain()[0]
        upkeep = [f for hh, f in played if hh == "cohen" and f.kind == "upkeep"]
        self.assertEqual(len(upkeep), 1)
        self.assertTrue(upkeep[0].tick < at(0, 21) and upkeep[0].choice == 0, (upkeep[0].tick, upkeep[0].choice))
        self.assertGreaterEqual(housing.condition_of(sim, "river_28"), 40)  # never neglected in use, let alone derelict
        news = [e["text"] for e in events if e["place"] == "river_28" and e["tag"] in ("neglect", "falling_apart")]
        self.assertEqual(news, [])

    def test_downsizing_through_the_engine(self):
        sim = self.sim
        sim.clock.tick = at(95, 18, 30)
        ruth, friedman = sim.agents["ruth"], sim.households["friedman"]
        fork = housing_forks.house_hunt_fork(sim, ruth)
        funds, sale, price = housing.funds(sim, friedman), housing.sale_proceeds(sim, "park_78"), 11550
        sim._decide(ruth, fork, 0, "model", "")
        self.assertEqual(friedman.home_id, "river_12")
        self.assertAlmostEqual(housing.funds(sim, friedman), funds + sale - price - housing.MOVING_COST)
        self.assertEqual(friedman.cooldowns["house_hunt"], sim.clock.tick + housing_forks.DOWNSIZE_SETTLE)
        self.assertEqual(friedman.cooldowns["downsized"], sim.clock.tick + housing_forks.DOWNSIZE_SETTLED)
        park_78 = sim.homes["park_78"]
        self.assertEqual((park_78.owner, housing.listed(sim, park_78)), ("market", "for_sale"))
        self.assertIn(f"The Friedmans buy 12 River Road (house, {housing.district_name(sim, sim.homes['river_12'])}) "
                      f"for ${price:,}, selling 78 Park Avenue for ${sale:,}.", [e["text"] for e in sim.history])
        self.assertEqual(ruth.activity_place, "river_12")
        # Retired, they have still "outgrown" a two-bedroom house. For a year they are not asked to downsize again,
        # nor shown a home with more bedrooms, though they could afford one: no moving back up.
        self.assertTrue(housing.outgrown(sim, friedman))
        sim.clock.tick += (housing_forks.DOWNSIZE_AFTER_MOVE_DAYS + 6) * DAY  # a Friday evening
        friedman.cooldowns.pop("house_hunt")
        self.assertIsNone(housing_forks.house_hunt_fork(sim, ruth))
        self.assertEqual(friedman.cooldowns["house_hunt"], sim.clock.tick + housing_forks.NO_CANDIDATE_RETRY)
        friedman.cooldowns.pop("house_hunt")
        friedman.cooldowns.pop("downsized")
        fork = housing_forks.house_hunt_fork(sim, ruth)
        self.assertTrue(fork.question.endswith("There are homes on the market you could afford. Do you move?"))
        self.assertTrue(all(sim.homes[o.extra["move"]].bedrooms > 2 for o in fork.options if "move" in o.extra))

    def test_a_downsizing_move_that_fails_does_not_settle(self):
        """Another household buys the smaller home while the Friedmans' answer is on its way: they stay where they
        are, with house_hunt's usual cooldown, not DOWNSIZE_SETTLE, and may still look at bigger homes."""
        sim = self.sim
        sim.clock.tick = at(95, 18, 30)
        ruth, friedman = sim.agents["ruth"], sim.households["friedman"]
        fork = housing_forks.house_hunt_fork(sim, ruth)
        self.assertTrue(fork.question.endswith("Do you downsize?"))
        self.assertEqual(fork.options[0].extra["move"], "river_12")
        rival = sim.households["bendavid"]
        set_funds(sim, "bendavid", 60000)
        self.assertTrue(housing.move_household(sim, rival, "river_12", "buy"))
        sim._decide(ruth, fork, 0, "model", "")
        self.assertEqual(friedman.home_id, "park_78")
        self.assertEqual(friedman.cooldowns["house_hunt"], sim.clock.tick + housing_forks.HUNT_COOLDOWN)
        self.assertNotIn("downsized", friedman.cooldowns)
        self.assertIn("The Friedmans were too late: 12 River Road has been sold.", [e["text"] for e in sim.history])
        self.assertTrue(housing.outgrown(sim, friedman))  # still: the question comes round again

    def test_a_fixer_upper_bought_on_a_weekday_evening_is_done_up_at_once(self):
        """house_hunt at 19:00 on a Monday: the move takes the rest of the evening and then it is bedtime, so no
        upkeep fork could renovate the house before its first night in use. The renovation comes with the purchase:
        the house is done up the moment it is bought, and never neglected in use."""
        sim = self.sim
        sim.clock.tick = at(0, 19)
        dana, cohen = sim.agents["dana"], sim.households["cohen"]
        self.assertLess(housing.condition_of(sim, "river_28"), 40)  # neglected
        price, reno = housing.value(sim, "river_28"), housing.reno_cost(sim, "river_28")
        fork = housing_forks.house_hunt_fork(sim, dana)
        self.assertEqual(labels(fork)[0],
                         f"Buy 28 River Road (house, neglected) for ${price:,} and do it up (${reno:,})")
        self.assertEqual(fork.options[0].cost, price + housing.MOVING_COST + reno)
        funds = housing.funds(sim, cohen)
        sim._decide(dana, fork, 0, "model", "")
        self.assertEqual(cohen.home_id, "river_28")
        self.assertAlmostEqual(housing.funds(sim, cohen), funds - price - housing.MOVING_COST - reno)
        self.assertEqual(housing.condition_of(sim, "river_28"), 100)
        self.assertEqual(sim.lots["river_28"].works_until, sim.clock.tick + housing.RENOVATE_WORKS_MINUTES)
        events, low, played = sim.drain()[0], 100.0, []
        director = sim.director

        def watch(agent, f):
            played.append((agent.household_id, f.kind))
            director(agent, f)

        sim.director = watch
        while sim.clock.tick < at(1, 1):  # past the first midnight
            sim.step()
            events += sim.drain()[0]
            low = min(low, housing.condition_of(sim, "river_28"))
        self.assertNotIn(("cohen", "upkeep"), played)  # nothing left to do up
        self.assertGreater(low, 90)
        self.assertEqual([e["text"] for e in events if e["place"] == "river_28"
                          and e["tag"] in ("shabby", "neglect", "falling_apart")], [])
        self.assertEqual([a.activity_place for a in housing.adults(sim, cohen)], ["river_28", "river_28"])

    def test_a_haggle_buys_with_the_renovation(self):
        """The seller accepts the Cohens' offer: they pay 90% of the price, and the renovation on top."""
        sim = self.sim
        cohen = sim.households["cohen"]
        price, reno = housing._int(housing.value(sim, "river_28") * 0.9), housing.reno_cost(sim, "river_28")
        funds = housing.funds(sim, cohen)
        dana, fork = self.haggle("offer_accepted")
        self.assertEqual(fork.options[1].outcomes[0].effects, {"factor": 0.9, "renovate": reno, "buy": "river_28"})
        for _ in range(6 * 60):
            sim.step()
            if cohen.home_id == "river_28":
                break
        self.assertEqual((cohen.home_id, cohen.history[-1]["price"]), ("river_28", price))
        self.assertAlmostEqual(housing.funds(sim, cohen), funds - price - housing.MOVING_COST - reno, delta=1)
        self.assertGreater(housing.condition_of(sim, "river_28"), 99)
        self.assertEqual(getattr(dana, "effect_args", None) or {}, {})  # the companions went with the purchase

class ForkShapeTest(unittest.TestCase):
    """Every housing builder, probed for every character every half hour over 2 game days (Friday morning to
    Sunday morning, so the weekday window, the weekend window and upkeep all come round) on seeds 1-3, with an
    emergency, a household in the red and a house falling apart planted: 4 options with distinct labels."""

    BUILDERS = ("house_hunt_fork", "upkeep_fork", "repair_fork", "housing_trouble_fork")
    KINDS = {"house_hunt", "upkeep", "repair", "housing_trouble"}

    def probe(self, sim, built):
        for agent in sim.agents.values():
            hh = sim.households[agent.household_id]
            for name in self.BUILDERS:
                saved, seen = dict(hh.cooldowns), hh.trouble_seen
                hh.cooldowns.pop(name.removesuffix("_fork"), None)  # whatever the engine already asked
                fork = getattr(housing_forks, name)(sim, agent)
                hh.cooldowns, hh.trouble_seen = saved, seen
                if fork:
                    built.setdefault(fork.kind, 0)
                    built[fork.kind] += 1
                    self.assertEqual(len(fork.options), 4, (fork.kind, labels(fork)))
                    self.assertEqual(len(set(labels(fork))), 4, (fork.kind, labels(fork)))

    def test_four_distinct_options_over_two_days(self):
        from gameofailife.sim import Simulation
        for seed in (1, 2, 3):
            with self.subTest(seed=seed):
                sim = Simulation(seed=seed, now=lambda: 0.0)
                sim.clock.tick = at(4, 6)  # Friday 06:00
                sim.homes["main_28"].emergency = {"kind": "leak", "since": sim.clock.tick}
                set_funds(sim, "peretz", -800)
                sim.households["peretz"].arrears = 1
                sim.lots["park_78"].condition = 30
                set_funds(sim, "friedman", 2000)
                played = []
                director = sim.director

                def watch(agent, fork):
                    played.append(fork)
                    director(agent, fork)

                sim.director = watch
                built = {}
                for minute in range(2 * DAY):
                    if minute % 30 == 0:
                        self.probe(sim, built)
                    sim.step()
                self.assertEqual(set(built), {"house_hunt", "upkeep", "repair", "housing_trouble"})
                for fork in played:
                    self.assertEqual(len(fork.options), 4, fork.kind)
                    if fork.kind in self.KINDS:
                        self.assertEqual(len(set(labels(fork))), 4, (fork.kind, labels(fork)))


    def test_the_downsizing_variant_over_two_days(self):
        """house_hunt's downsizing variant on seeds 1-3, from a Friday morning past DOWNSIZE_AFTER_MOVE_DAYS: the
        retired Friedmans and a couple who bought a four-bedroom house and then lost one of the two, probed with the
        smaller homes on the market and without."""
        from gameofailife.sim import Simulation
        downsized = 0
        for seed in (1, 2, 3):
            with self.subTest(seed=seed):
                sim = Simulation(seed=seed, now=lambda: 0.0)
                sim.clock.tick = at(123, 6)
                single = next(hh for hh in sim.households.values() if housing.residents(sim, hh) == 2
                              and len(housing.adults(sim, hh)) == 2
                              and not any(housing.retired(a) for a in housing.adults(sim, hh)))
                set_funds(sim, single.id, 25000)
                self.assertTrue(housing.move_household(sim, single, "main_55", "buy"))
                single.moved_tick = 0
                sim._die(housing.adults(sim, single)[1], "dies")
                set_funds(sim, single.id, 3000)
                played, built = [], collections.Counter()

                def watch(agent, fork, played=played, director=sim.director):
                    played.append(fork)
                    director(agent, fork)

                sim.director = watch
                for minute in range(2 * DAY):
                    if minute % 30 == 0:
                        for hidden in (False, True):
                            saved = {h.id: h.under_offer_until for h in sim.homes.values()}
                            if hidden:
                                hide(sim, "river_12")
                            for agent in sim.agents.values():
                                hh = sim.households[agent.household_id]
                                cooldowns = dict(hh.cooldowns)
                                hh.cooldowns.pop("house_hunt", None)
                                fork = housing_forks.house_hunt_fork(sim, agent)
                                hh.cooldowns = cooldowns
                                if fork and fork.question.endswith("Do you downsize?"):
                                    built[(hh.id, hidden)] += 1
                                    self.assertEqual(len(set(labels(fork))), 4, labels(fork))
                                    self.assertEqual(fork.major, True)
                            for h in sim.homes.values():
                                h.under_offer_until = saved[h.id]
                    sim.step()
                self.assertTrue({("friedman", False), ("friedman", True), (single.id, False)} <= set(built), built)
                for fork in played:
                    self.assertEqual(len(fork.options), 4, fork.kind)
                    self.assertEqual(len(set(labels(fork))), 4, (fork.kind, labels(fork)))
                self.assertTrue(any(f.question.endswith("Do you downsize?") for f in played))  # the engine asks too
                downsized += sim.households["friedman"].home_id != "park_78"
        self.assertGreater(downsized, 0)  # and some say yes (the decider's play style decides)


@unittest.skipUnless(NODE, "node is not installed")
class PortParityTest(unittest.TestCase):
    """The housing builders this file pins, built in the same state by the Python engine and its JS port
    (port/src): every option, outcome and default score the same, and what a choice, a death or a move leaves
    behind. The lockstep runs of tests/test_port.py are a few days long, too short to reach a downsizing, a
    landlord's sale or a fixer-upper's first evening."""

    JS = r"""
    const G = require(process.argv[1]).load();
    const H = G.housing, DAY = H.DAY;
    const out = [];
    const opt = o => ({label: o.label, steps: o.steps, cost: o.cost, base: o.base, tags: o.tags, gains: o.gains,
      extra: o.extra, household_pays: o.household_pays, charge: o.charge,
      outcomes: o.outcomes.map(x => ({id: x.id, label: x.label, p: x.p, valence: x.valence, effects: x.effects,
        group: x.group}))});
    for (const ops of JSON.parse(require("fs").readFileSync(0, "utf8"))) {
      const sim = new G.sim.Simulation(1);
      const got = [];
      let last = null;
      for (const [op, ...a] of ops) {
        const hh = id => sim.households.get(id);
        if (op === "tick") sim.clock.tick = a[0];
        else if (op === "funds") {
          const people = H.adults(sim, hh(a[0]));
          for (const p of people) { p.money = 0.0; p.savings = 0.0; }
          people[0].money = a[1];
        } else if (op === "condition") sim.lots.get(a[0]).condition = a[1];
        else if (op === "hide") sim.homes.get(a[0]).under_offer_until = sim.clock.tick + a[1] * DAY;
        else if (op === "move") got.push(H.move_household(sim, hh(a[0]), a[1], a[2], 1.0, null, null, true, false));
        else if (op === "arrears") hh(a[0]).arrears = a[1];
        else if (op === "gone") {
          const agent = sim.agents.get(a[0]), house = hh(agent.household_id);
          agent.alive = false;
          house.member_ids = house.member_ids.filter(m => m !== a[0]);
        } else if (op === "cooldown") hh(a[0]).cooldowns[a[1]] = sim.clock.tick + a[2];
        else if (op === "home") {
          const h = sim.homes.get(a[0]);
          got.push({owner: h.owner, listing: h.listing, household: h.household,
            condition: H.condition_of(sim, a[0])});
        } else if (op === "news") got.push(sim.history.filter(e => e.tag === a[0]).map(e => e.text));
        else if (op === "decide") {
          const agent = sim.agents.get(a[0]), house = hh(agent.household_id);
          sim._decide(agent, last, a[1], "model", "");
          got.push({home: house.home_id, cooldowns: house.cooldowns});
        } else if (op === "build") {
          const agent = sim.agents.get(a[1]);
          const fork = G.housing_forks[a[0]](sim, agent);
          last = fork;
          got.push(fork === null ? null : {kind: fork.kind, question: fork.question, major: fork.major,
            options: fork.options.map(opt), scores: G.forks.default_scores(agent, fork, sim),
            cooldowns: hh(agent.household_id).cooldowns});
        }
      }
      out.push(got);
    }
    process.stdout.write(JSON.stringify(out));
    """

    def python(self, cases):
        from gameofailife.sim import Simulation

        def opt(o):
            return {"label": o.label, "steps": o.steps, "cost": o.cost, "base": o.base, "tags": o.tags,
                    "gains": o.gains, "extra": o.extra, "household_pays": o.household_pays, "charge": o.charge,
                    "outcomes": [{"id": x.id, "label": x.label, "p": x.p, "valence": x.valence,
                                  "effects": {f"rel:{k[1]}" if isinstance(k, tuple) else k: v
                                              for k, v in x.effects.items()}, "group": x.group}
                                 for x in o.outcomes]}

        out = []
        for ops in cases:
            sim = Simulation(seed=1, now=lambda: 0.0)
            got, last = [], None
            for op, *a in ops:
                if op == "tick":
                    sim.clock.tick = a[0]
                elif op == "funds":
                    set_funds(sim, a[0], a[1])
                elif op == "condition":
                    sim.lots[a[0]].condition = a[1]
                elif op == "hide":
                    hide(sim, a[0], days=a[1])
                elif op == "move":
                    got.append(housing.move_household(sim, sim.households[a[0]], a[1], a[2], check=False))
                elif op == "arrears":
                    sim.households[a[0]].arrears = a[1]
                elif op == "gone":
                    gone(sim, a[0])
                elif op == "cooldown":
                    sim.households[a[0]].cooldowns[a[1]] = sim.clock.tick + a[2]
                elif op == "home":
                    h = sim.homes[a[0]]
                    got.append({"owner": h.owner, "listing": h.listing, "household": h.household,
                                "condition": housing.condition_of(sim, a[0])})
                elif op == "news":
                    got.append([e["text"] for e in sim.history if e["tag"] == a[0]])
                elif op == "decide":
                    agent = sim.agents[a[0]]
                    hh = sim.households[agent.household_id]
                    sim._decide(agent, last, a[1], "model", "")
                    got.append({"home": hh.home_id, "cooldowns": hh.cooldowns})
                elif op == "build":
                    agent = sim.agents[a[1]]
                    fork = last = getattr(housing_forks, a[0])(sim, agent)
                    got.append(None if fork is None else {
                        "kind": fork.kind, "question": fork.question, "major": fork.major,
                        "options": [opt(o) for o in fork.options], "scores": forks.default_scores(agent, fork, sim),
                        "cooldowns": sim.households[agent.household_id].cooldowns})
            out.append(got)
        return json.loads(json.dumps(out))

    def test_the_builders_match(self):
        evening, monday = at(95, 18, 30), at(7, 18, 30)
        rentals = [h.id for h in housing.vacancies(FakeSim(tick=evening), "for_rent")]
        cases = [
            # house_hunt's downsizing variant: both moves, then one of them, then none.
            [["tick", evening], ["build", "house_hunt_fork", "ruth"], ["build", "house_hunt_fork", "david"]],
            [["tick", evening], ["hide", "river_12", 30], ["hide", "main_55", 30],
             ["build", "house_hunt_fork", "ruth"]],
            [["tick", evening]] + [["hide", h, 30] for h in rentals] + [["build", "house_hunt_fork", "ruth"]],
            [["tick", evening]] + [["hide", h, 30] for h in rentals + ["river_12", "main_55"]]
            + [["build", "house_hunt_fork", "ruth"]],
            # two months on: more inviting
            [["tick", at(155, 18, 30)], ["build", "house_hunt_fork", "ruth"]],
            # by bedrooms: three in a four-bedroom house, who lose one; too soon and then settled in
            [["tick", at(10, 18, 30)], ["funds", "cohen", 25000], ["move", "cohen", "main_55", "buy"],
             ["funds", "cohen", 3000], ["gone", "noa"], ["tick", at(129, 18, 30)], ["build", "house_hunt_fork", "dana"],
             ["tick", at(130, 18, 30)], ["build", "house_hunt_fork", "dana"]],
            # upkeep: a fixer-upper's first evening, and the weekend after
            [["tick", at(1, 18)], ["condition", "river_28", 20.0], ["move", "cohen", "river_28", "buy"],
             ["build", "upkeep_fork", "dana"], ["tick", at(5, 10)], ["build", "upkeep_fork", "yossi"]],
            # housing_trouble's downsize moves, for an owner and for a renter
            [["tick", monday], ["funds", "halabi", -500], ["arrears", "halabi", 2],
             ["build", "housing_trouble_fork", "shai"]],
            [["tick", monday], ["funds", "peretz", -800], ["arrears", "peretz", 1],
             ["build", "housing_trouble_fork", "eli"]],
            # the usual hunt, with a rental and a purchase (of a run-down house, with its renovation)
            [["tick", at(0, 18, 30)], ["build", "house_hunt_fork", "dana"], ["build", "house_hunt_fork", "sara"]],
            # downsizing: the move goes through and settles them; another buyer is first, and it doesn't
            [["tick", evening], ["build", "house_hunt_fork", "ruth"], ["decide", "ruth", 0], ["home", "river_12"]],
            [["tick", evening], ["build", "house_hunt_fork", "ruth"], ["move", "bendavid", "river_12", "buy"],
             ["decide", "ruth", 0], ["home", "park_78"]],
            # retirees with money to spare may look at bigger homes; for a while, a household that downsized may not
            [["tick", evening], ["funds", "segal", 60000], ["build", "house_hunt_fork", "yuval"]],
            [["tick", at(0, 18, 30)], ["funds", "peretz", 60000], ["cooldown", "peretz", "downsized", 30 * DAY],
             ["build", "house_hunt_fork", "eli"]],
            # no house for sale for 14 days: the landlord sells the house the Cohens leave (on a Monday evening)
            [["tick", at(20, 18, 30)], ["move", "weiss", "river_12", "buy"], ["move", "shapiro", "main_55", "buy"],
             ["move", "peretz", "park_66", "buy"], ["move", "amar", "park_104", "buy"], ["tick", at(35, 18, 30)],
             ["move", "cohen", "river_28", "buy"], ["home", "main_20"], ["news", "home_listed"],
             ["funds", "gold", 60000], ["build", "house_hunt_fork", "lina"]],
            # a fixer-upper bought through the fork on a weekday evening, done up at once
            [["tick", at(0, 19)], ["build", "house_hunt_fork", "dana"], ["decide", "dana", 0], ["home", "river_28"]],
            # every house for sale bought on day 60: by day 95 none has been for sale for two weeks
            [["tick", at(60, 18, 30)], ["move", "weiss", "river_12", "buy"], ["move", "shapiro", "main_55", "buy"],
             ["move", "peretz", "park_66", "buy"], ["move", "amar", "park_104", "buy"],
             ["move", "cohen", "river_28", "buy"], ["tick", at(95, 18, 30)], ["build", "house_hunt_fork", "ruth"]],
        ]
        run = subprocess.run([NODE, "-e", self.JS, str(ROOT / "port" / "tools" / "engine.cjs")],
                             input=json.dumps(cases), capture_output=True, text=True, timeout=300, check=False)
        self.assertEqual(run.returncode, 0, run.stderr)
        js, py = json.loads(run.stdout), self.python(cases)
        self.assertEqual(len(js), len(py))
        for i, (got, want) in enumerate(zip(js, py)):
            self.assertEqual(got, want, f"case {i} differs (JS first)")
        variants = [r for case in py for r in case
                    if isinstance(r, dict) and r.get("question", "").endswith("downsize?")]
        self.assertEqual(len(variants), 8)  # the cases do reach the downsizing variant: cases 0-2, 4, 5, 10, 11 and 16
        self.assertEqual([py[1][0]["options"][0]["label"], py[2][0]["options"][1]["label"]],
                         ["Talk it over and decide another time"] * 2)
        self.assertIsNone(py[3][0])  # nowhere smaller for the Friedmans: no fork
        self.assertAlmostEqual(py[4][0]["options"][0]["base"] - py[0][0]["options"][0]["base"],
                               2 * housing_forks.DOWNSIZE_DRIFT)
        self.assertIsNone(py[5][1])  # the Cohens, 119 days in
        self.assertIn("with 4 bedrooms for the 2 of you", py[5][2]["question"])
        self.assertEqual(py[6][1]["options"][0]["extra"]["repair"], 80)  # the fixer-upper's first evening
        self.assertIn("and do it up ($880)", py[9][0]["options"][0]["label"])
        evening = at(95, 18, 30)
        self.assertEqual((py[10][1]["home"], py[10][1]["cooldowns"]),
                         ("river_12", {"house_hunt": evening + housing_forks.DOWNSIZE_SETTLE,
                                       "downsized": evening + housing_forks.DOWNSIZE_SETTLED}))
        self.assertEqual((py[11][2]["home"], py[11][2]["cooldowns"]),
                         ("park_78", {"house_hunt": evening + housing_forks.HUNT_COOLDOWN}))
        self.assertTrue(py[12][0]["question"].endswith("Do you move?"))  # the Segals may take a bigger home
        self.assertIn("river_28", json.dumps(py[12][0]["options"]))
        self.assertNotIn("river_28", json.dumps(py[13][0]["options"]))  # three bedrooms: the Peretzes have two
        self.assertEqual((py[14][5]["owner"], py[14][5]["listing"]), ("market", "for_sale"))
        self.assertEqual(len(py[14][6]), 1)  # the landlord's sale is news
        self.assertIn("20 Main Street", json.dumps(py[14][7]["options"]))  # and on the market for the Golds
        self.assertEqual(py[15][2]["condition"], 100)
        self.assertIn("no house has been for sale in Millbrook for 2 weeks", py[16][5]["question"])
        self.assertAlmostEqual(py[16][5]["options"][1]["base"] - py[0][0]["options"][1]["base"],
                               housing_forks.DOWNSIZE_SCARCE)


# --- the cheaper home, and who owns how much of a home (review fixes ENG-3 and F4) ------------------------------

def spend(sim, hh, home_id: str) -> tuple[float, float]:
    """What moving to a home costs a household: the cash (with the renovation a run-down home is bought with), then
    a week's outgo there."""
    reno = housing.reno_cost(sim, home_id) if housing.buys(sim.homes[home_id]) else 0
    return housing.net_cost(sim, hh, home_id) + reno, housing.weekly_outgo(sim, hh, home_id)


def worths(sim, hh) -> dict[str, int]:
    return {a.id: housing.net_worth(sim, a) for a in housing.adults(sim, hh)}


def give(sim, **cash) -> None:
    """Set adults' money (and no savings): give(sim, avi=700.0, rina=1100.0)."""
    for agent_id, money in cash.items():
        sim.agents[agent_id].money, sim.agents[agent_id].savings = float(money), 0.0


class CheaperHomeTest(unittest.TestCase):
    """house_hunt's option 2 is "the cheaper" home only when it really is: less cash to move into than option 0's
    home (the renovation counted), or as much and less a week. Otherwise the slot keeps looking (housing.md 9.1's
    fallback). Before the fix two flats at the same rent were offered as "the cheaper" one of each other."""

    def test_the_cheaper_home_always_costs_less(self):
        seen = collections.Counter()
        for hidden in [(), ("main_39",), ("main_39", "cedar_court_3b"), ("river_28",), ("main_55", "river_12")]:
            for extra in (0, 20000, 60000):
                sim = FakeSim(tick=at(0, 18, 30))
                hide(sim, *hidden)
                for hh in sim.households.values():
                    people = housing.adults(sim, hh)
                    if people:
                        people[0].savings += extra
                for hh in sim.households.values():
                    people = housing.adults(sim, hh)
                    if not people:
                        continue
                    fork = housing_forks.house_hunt_fork(sim, people[0])
                    if fork is None or not fork.question.endswith("Do you move?"):
                        continue
                    best, cheaper = fork.options[0], fork.options[2]
                    if "the cheaper" in cheaper.label:
                        a, b = spend(sim, hh, best.extra["move"]), spend(sim, hh, cheaper.extra["move"])
                        self.assertLess(b, a, labels(fork))
                        self.assertTrue(b[0] < a[0] or b[1] < a[1], labels(fork))  # less cash, or less a week
                        self.assertLessEqual(cheaper.cost, best.cost, labels(fork))
                        seen["cheaper"] += 1
                    else:
                        self.assertEqual(cheaper.label, "Keep looking for the right place")
                        seen["keep looking"] += 1
        self.assertGreater(seen["cheaper"], 10)
        self.assertGreater(seen["keep looking"], 10)

    def test_the_same_rent_is_not_cheaper(self):
        sim = FakeSim(tick=at(0, 18, 30))
        hide(sim, "main_39", "cedar_court_3b")  # left: three two-bedroom flats at $220, all in Elm Court
        fork = housing_forks.house_hunt_fork(sim, sim.agents["sara"])
        self.assertEqual(labels(fork), [  # before: "Move into the cheaper Elm Court, flat 2B (flat) for $220/week"
            "Move into Elm Court, flat 3A (flat) for $220/week",
            "Ask the landlord to let Elm Court, flat 3A for $198/week",
            "Keep looking for the right place",
            "Stay in Elm Court, flat 2A and keep the money"])
        self.assertEqual(fork.options[2].extra, {"hh_cooldown": 3 * DAY})

    def test_a_lower_rent_is_cheaper(self):
        sim = FakeSim(tick=at(0, 18, 30))
        fork = housing_forks.house_hunt_fork(sim, sim.agents["sara"])
        hh = sim.households[sim.agents["sara"].household_id]
        self.assertEqual(labels(fork)[2], "Move into the cheaper Elm Court, flat 2B (flat) for $220/week")
        self.assertEqual(spend(sim, hh, "elm_court_2b")[0], spend(sim, hh, "main_39")[0])  # the same van ...
        self.assertLess(spend(sim, hh, "elm_court_2b")[1], spend(sim, hh, "main_39")[1])  # ... and $110 less a week

    def test_the_renovation_counts(self):
        """A run-down big house priced below the best one but dearer once it is done up is not "the cheaper"."""
        sim = FakeSim(tick=at(0, 18, 30))
        hide(sim, "river_12", "river_28", "main_55", "main_39")  # leaves the two big houses for sale
        sim.lots["park_104"].condition = 55  # $34,600
        sim.lots["park_66"].condition = 0  # $32,200, and $3,040 to do it up
        sim.agents["dana"].savings += 100000
        hh = sim.households["cohen"]
        fork = housing_forks.house_hunt_fork(sim, sim.agents["dana"])
        self.assertEqual(labels(fork)[0], "Buy 104 Park Avenue (big house, shabby) for $34,600")
        self.assertEqual((housing.value(sim, "park_66"), housing.reno_cost(sim, "park_66")), (32200, 3040))
        self.assertLess(housing.net_cost(sim, hh, "park_66"), housing.net_cost(sim, hh, "park_104"))
        self.assertGreater(spend(sim, hh, "park_66"), spend(sim, hh, "park_104"))
        self.assertEqual(labels(fork)[2], "Keep looking for the right place")
        sim.lots["park_104"].condition = 100  # $40,000: now the run-down one is cheaper, done up and all
        hh.cooldowns.clear()
        fork = housing_forks.house_hunt_fork(sim, sim.agents["dana"])
        self.assertEqual(labels(fork)[2], "Buy the cheaper 66 Park Avenue (big house, derelict) for $32,200 and do it "
                                          "up ($3,040)")


class EquityTest(unittest.TestCase):
    """A home a household buys is shared by what each adult paid of the price (Home.shares), so buying moves each
    adult's money into their own equity; a sale pays out in the same shares; the share of an adult who dies passes
    to the others in proportion. A home the household had at the start is shared equally, as before."""

    def setUp(self):
        self.sim = FakeSim(tick=at(0, 18, 30))

    def test_pay_household_says_who_paid(self):
        sim, hh = self.sim, self.sim.households["mizrahi"]
        give(sim, avi=1000, rina=3000)
        self.assertEqual(housing.pay_household(sim, hh, 400), {"avi": 100.0, "rina": 300.0})
        self.assertEqual(housing.pay_household(sim, hh, -400, {"avi": 0.75, "rina": 0.25}), {})  # money in ...
        self.assertEqual((sim.agents["avi"].savings, sim.agents["rina"].savings), (300.0, 100.0))  # ... by shares
        self.assertEqual(housing.pay_household(sim, hh, 0), {})

    def test_the_starting_owners_share_equally(self):
        sim = self.sim
        self.assertTrue(all(h.shares == {} for h in sim.homes.values()))
        owners = 0
        for agent in sim.agents.values():
            hh = sim.households[agent.household_id]
            people = housing.adults(sim, hh)
            equal = housing.value(sim, hh.home_id) / len(people) if housing.tenure(sim, hh) == "owned" else 0
            home = housing._int(equal) if agent.is_adult else 0
            self.assertEqual(housing.worth_parts(sim, agent)["home"], home, agent.id)  # the day-0 ranking stands
            owners += home > 0
        self.assertGreater(owners, 10)
        levi = sim.households["levi"]
        self.assertEqual(housing.home_shares(sim, levi), {"tom": 0.5, "miriam": 0.5})
        proceeds = housing.sale_proceeds(sim, "main_28")
        savings = {a.id: a.savings for a in housing.adults(sim, levi)}
        self.assertTrue(housing.move_household(sim, levi, "cedar_court_3b", "rent", forced="forced_sale"))
        for a in housing.adults(sim, levi):  # a forced move to a rental pays no van: the sale alone
            self.assertAlmostEqual(a.savings, savings[a.id] + proceeds / 2)

    def test_a_couples_purchase_leaves_each_ones_worth(self):
        """The review's case: the Mizrahis buy 55 Main Street, which Rina pays most of. An equal split of the equity
        made Avi about $6,500 richer and Rina $6,600 poorer; now each only pays their part of the van."""
        sim, hh = self.sim, self.sim.households["mizrahi"]
        before, funds = worths(sim, hh), {a.id: a.money + a.savings for a in housing.adults(sim, hh)}
        self.assertEqual(funds, {"avi": 3200.0, "rina": 20100.0})
        self.assertTrue(housing.move_household(sim, hh, "main_55", "buy"))
        home = sim.homes["main_55"]
        self.assertAlmostEqual(home.shares["avi"], 3200 / 23300)
        self.assertAlmostEqual(home.shares["rina"], 20100 / 23300)
        self.assertAlmostEqual(sum(home.shares.values()), 1.0)
        after = worths(sim, hh)
        for agent_id, share in home.shares.items():
            self.assertLessEqual(abs(after[agent_id] - (before[agent_id] - housing.MOVING_COST * share)), 2, agent_id)
            self.assertEqual(housing.worth_parts(sim, sim.agents[agent_id])["home"],
                             housing._int(housing.value(sim, "main_55") * share))
        self.assertLessEqual(abs(sum(after.values()) - (sum(before.values()) - housing.MOVING_COST)), 2)

    def test_a_sale_pays_out_in_the_same_shares(self):
        sim, hh = self.sim, self.sim.households["mizrahi"]
        self.assertTrue(housing.move_household(sim, hh, "main_55", "buy"))
        shares, people = dict(sim.homes["main_55"].shares), housing.adults(sim, hh)
        proceeds = housing.sale_proceeds(sim, "main_55")
        funds = {a.id: a.money + a.savings for a in people}
        before = worths(sim, hh)
        self.assertTrue(housing.move_household(sim, hh, "cedar_court_3b", "rent", check=False))
        self.assertEqual(sim.homes["main_55"].shares, {})  # back on the market
        got = {a.id: funds[a.id] + proceeds * shares[a.id] for a in people}  # the sale, by shares ...
        weights = {k: max(0.0, v) for k, v in got.items()}
        after = worths(sim, hh)
        for a in people:  # ... then the van, by funds
            van = housing.MOVING_COST * weights[a.id] / sum(weights.values())
            self.assertAlmostEqual(a.money + a.savings, got[a.id] - van)
            fee = (housing.value(sim, "main_55") - proceeds) * shares[a.id]
            self.assertLessEqual(abs(after[a.id] - (before[a.id] - fee - van)), 2, a.id)

    def test_a_share_passes_to_the_others_in_proportion(self):
        sim, hh = self.sim, self.sim.households["golan"]
        give(sim, avigail=2000, yaniv=6000, yasmin=12000)
        self.assertTrue(housing.move_household(sim, hh, "river_12", "buy", check=False))
        worth = housing.value(sim, "river_12")
        self.assertEqual({k: round(v, 9) for k, v in sim.homes["river_12"].shares.items()},
                         {"avigail": 0.1, "yaniv": 0.3, "yasmin": 0.6})

        def check(expected):  # adult id -> their share of the value
            got = {a.id: housing.worth_parts(sim, a)["home"] for a in housing.adults(sim, hh)}
            self.assertEqual(set(got), set(expected))
            for agent_id, share in expected.items():
                self.assertAlmostEqual(got[agent_id], worth * share, delta=1, msg=agent_id)

        check({"avigail": 0.1, "yaniv": 0.3, "yasmin": 0.6})
        gone(sim, "yasmin")
        check({"avigail": 0.25, "yaniv": 0.75})
        gone(sim, "yaniv")
        check({"avigail": 1.0})

    def test_an_adult_who_paid_nothing_holds_no_share(self):
        sim, hh = self.sim, self.sim.households["mizrahi"]
        give(sim, avi=-500, rina=20000)
        self.assertTrue(housing.move_household(sim, hh, "main_55", "buy", check=False))
        self.assertEqual(sim.homes["main_55"].shares, {"avi": 0.0, "rina": 1.0})
        self.assertEqual(housing.worth_parts(sim, sim.agents["avi"])["home"], 0)
        self.assertEqual(housing.worth_parts(sim, sim.agents["rina"])["home"], housing.value(sim, "main_55"))
        gone(sim, "rina")  # nobody who paid is left: the adults left share it equally
        self.assertEqual(housing.worth_parts(sim, sim.agents["avi"])["home"], housing.value(sim, "main_55"))

    def test_when_nobody_can_pay_the_shares_are_equal(self):
        sim, hh = self.sim, self.sim.households["mizrahi"]
        give(sim, avi=0, rina=0)
        self.assertTrue(housing.move_household(sim, hh, "main_55", "buy", check=False))
        self.assertEqual(sim.homes["main_55"].shares, {"avi": 0.5, "rina": 0.5})

    def test_a_fixer_upper_and_its_renovation(self):
        """The Cohens buy 28 River Road through house_hunt on a weekday evening and do it up at once: the renovation
        is paid in the same proportions, and what it adds to the value is shared alike."""
        sim = FakeSim(tick=at(0, 19))
        hh, dana = sim.households["cohen"], sim.agents["dana"]
        before = worths(sim, hh)
        fork = housing_forks.house_hunt_fork(sim, dana)
        housing.apply_extra(sim, dana, fork, fork.options[0])
        self.assertEqual((hh.home_id, housing.condition_of(sim, "river_28")), ("river_28", 100))
        shares, after = sim.homes["river_28"].shares, worths(sim, hh)
        self.assertAlmostEqual(shares["dana"], 15900 / 21500)
        change = sum(after.values()) - sum(before.values())
        self.assertGreater(change, 2500)  # done up, it is worth $2,970 more than it cost, less the van
        for agent_id, share in shares.items():
            self.assertLessEqual(abs(after[agent_id] - before[agent_id] - share * change), 2, agent_id)

    def test_the_purchases_of_a_run(self):
        """Seed 1, two game days: households that rented buy homes (the Cohens and the Mizrahis on the first
        evening). Each adult's worth moves by their own share of the household's change, never more."""
        from unittest import mock

        from gameofailife.sim import Simulation

        sim = Simulation(seed=SEED, now=lambda: 0.0)
        bought = []

        def watched(real):
            def run(s, agent, *args):
                hh = s.households[agent.household_id]
                home, rented = hh.home_id, housing.tenure(s, hh) == "rented"
                before = worths(s, hh)
                out = real(s, agent, *args)
                if hh.home_id != home and rented and housing.tenure(s, hh) == "owned":
                    bought.append((hh.id, before, worths(s, hh), housing.home_shares(s, hh)))
                return out
            return run

        with mock.patch.object(housing, "apply_extra", watched(housing.apply_extra)), \
                mock.patch.object(housing, "apply_effect", watched(housing.apply_effect)):
            sim.run_days(2)
        couples = [b for b in bought if len(b[1]) >= 2]
        self.assertGreaterEqual(len(couples), 2, [b[0] for b in bought])
        for hh_id, before, after, shares in bought:
            change = sum(after.values()) - sum(before.values())
            for agent_id, share in shares.items():
                self.assertLessEqual(abs(after[agent_id] - before[agent_id] - share * change), 3, (hh_id, agent_id))


@unittest.skipUnless(NODE, "node is not installed")
class EquityParityTest(unittest.TestCase):
    """The shares of a home bought, sold, outlived and done up, in the Python engine and its JS port (port/src):
    every adult's money, savings and worth parts, and the home's recorded shares, the same."""

    JS = r"""
    const G = require(process.argv[1]).load();
    const H = G.housing;
    const out = [];
    for (const ops of JSON.parse(require("fs").readFileSync(0, "utf8"))) {
      const sim = new G.sim.Simulation(1);
      const got = [];
      let last = null;
      for (const [op, ...a] of ops) {
        const hh = id => sim.households.get(id);
        if (op === "tick") sim.clock.tick = a[0];
        else if (op === "cash") {
          const agent = sim.agents.get(a[0]);
          agent.money = a[1];
          agent.savings = 0.0;
        } else if (op === "move") got.push(H.move_household(sim, hh(a[0]), a[1], a[2], 1.0, null, a[3], true, false));
        else if (op === "gone") {
          const agent = sim.agents.get(a[0]), house = hh(agent.household_id);
          agent.alive = false;
          house.member_ids = house.member_ids.filter(m => m !== a[0]);
        } else if (op === "worth") {
          const house = hh(a[0]), people = H.adults(sim, house);
          const row = {home: house.home_id, shares: sim.homes.get(house.home_id).shares, people: {}};
          for (const p of people) {
            row.people[p.id] = {money: p.money, savings: p.savings, parts: H.worth_parts(sim, p)};
          }
          got.push(row);
        } else if (op === "hide") sim.homes.get(a[0]).under_offer_until = sim.clock.tick + a[1] * H.DAY;
        else if (op === "condition") sim.lots.get(a[0]).condition = a[1];
        else if (op === "build") { // asked afresh, whatever the household was asked before
          const agent = sim.agents.get(a[0]);
          delete hh(agent.household_id).cooldowns.house_hunt;
          last = G.housing_forks.house_hunt_fork(sim, agent);
          got.push(last === null ? null : last.options.map(o => o.label));
        } else if (op === "decide") sim._decide(sim.agents.get(a[0]), last, a[1], "model", "");
      }
      out.push(got);
    }
    process.stdout.write(JSON.stringify(out));
    """

    def python(self, cases):
        from gameofailife.sim import Simulation

        out = []
        for ops in cases:
            sim = Simulation(seed=1, now=lambda: 0.0)
            got, last = [], None
            for op, *a in ops:
                if op == "tick":
                    sim.clock.tick = a[0]
                elif op == "cash":
                    give(sim, **{a[0]: a[1]})
                elif op == "move":
                    got.append(housing.move_household(sim, sim.households[a[0]], a[1], a[2], forced=a[3], check=False))
                elif op == "gone":
                    gone(sim, a[0])
                elif op == "worth":
                    hh = sim.households[a[0]]
                    got.append({"home": hh.home_id, "shares": sim.homes[hh.home_id].shares,
                                "people": {p.id: {"money": p.money, "savings": p.savings,
                                                  "parts": housing.worth_parts(sim, p)}
                                           for p in housing.adults(sim, hh)}})
                elif op == "hide":
                    hide(sim, a[0], days=a[1])
                elif op == "condition":
                    sim.lots[a[0]].condition = a[1]
                elif op == "build":  # asked afresh, whatever the household was asked before
                    sim.households[sim.agents[a[0]].household_id].cooldowns.pop("house_hunt", None)
                    last = housing_forks.house_hunt_fork(sim, sim.agents[a[0]])
                    got.append(None if last is None else labels(last))
                elif op == "decide":
                    sim._decide(sim.agents[a[0]], last, a[1], "model", "")
            out.append(got)
        return json.loads(json.dumps(out))

    def test_the_shares_match(self):
        evening = at(0, 18, 30)
        cases = [
            # a couple buys (Rina pays most), then sells up to rent
            [["tick", evening], ["worth", "mizrahi"], ["move", "mizrahi", "main_55", "buy", None], ["worth", "mizrahi"],
             ["move", "mizrahi", "cedar_court_3b", "rent", None], ["worth", "mizrahi"]],
            # three adults buy; one dies, then a forced sale pays the other two out by their shares
            [["tick", evening], ["cash", "avigail", 2000.0], ["cash", "yaniv", 6000.0], ["cash", "yasmin", 12000.0],
             ["move", "golan", "river_12", "buy", None], ["worth", "golan"], ["gone", "yasmin"], ["worth", "golan"],
             ["move", "golan", "elm_court_3a", "rent", "forced_sale"], ["worth", "golan"]],
            # starting owners: an equal split of the sale, then shares by what each paid; then a death
            [["tick", evening], ["worth", "levi"], ["move", "levi", "river_12", "buy", None], ["worth", "levi"],
             ["gone", "tom"], ["worth", "levi"]],
            # an adult in debt pays nothing and holds nothing; nobody able to pay: equal shares
            [["tick", evening], ["cash", "avi", -500.0], ["move", "mizrahi", "main_55", "buy", None],
             ["worth", "mizrahi"]],
            [["tick", evening], ["cash", "avi", 0.0], ["cash", "rina", 0.0],
             ["move", "mizrahi", "main_55", "buy", None], ["worth", "mizrahi"]],
            # a fixer-upper bought through the fork and done up the same evening
            [["tick", at(0, 19)], ["worth", "cohen"], ["build", "dana"], ["decide", "dana", 0], ["worth", "cohen"]],
            # a lower rent is cheaper; the same rent is not (option 2 keeps looking); the renovation counts
            [["tick", evening], ["build", "sara"], ["hide", "main_39", 30], ["hide", "cedar_court_3b", 30],
             ["build", "sara"]],
            [["tick", evening], ["cash", "dana", 120000.0], ["hide", "river_12", 30], ["hide", "river_28", 30],
             ["hide", "main_55", 30], ["build", "dana"], ["condition", "park_66", 0.0], ["condition", "park_104", 55.0],
             ["build", "dana"], ["condition", "park_104", 100.0], ["build", "dana"]],
        ]
        run = subprocess.run([NODE, "-e", self.JS, str(ROOT / "port" / "tools" / "engine.cjs")],
                             input=json.dumps(cases), capture_output=True, text=True, timeout=300, check=False)
        self.assertEqual(run.returncode, 0, run.stderr)
        js, py = json.loads(run.stdout), self.python(cases)
        self.assertEqual(len(js), len(py))
        for i, (got, want) in enumerate(zip(js, py)):
            self.assertEqual(got, want, f"case {i} differs (JS first)")
        self.assertEqual(set(py[0][2]["shares"]), {"avi", "rina"})
        self.assertGreater(py[0][2]["people"]["rina"]["parts"]["home"], 5 * py[0][2]["people"]["avi"]["parts"]["home"])
        self.assertAlmostEqual(py[1][2]["people"]["yaniv"]["parts"]["home"],
                               3 * py[1][2]["people"]["avigail"]["parts"]["home"], delta=2)  # Yasmin's share, split 1:3
        self.assertEqual(py[3][1]["shares"], {"avi": 0.0, "rina": 1.0})
        self.assertEqual(py[4][1]["shares"], {"avi": 0.5, "rina": 0.5})
        self.assertEqual([py[6][0][2], py[6][1][2]], ["Move into the cheaper Elm Court, flat 2B (flat) for $220/week",
                                                      "Keep looking for the right place"])
        self.assertEqual([labels[2] for labels in py[7]], [
            "Buy the cheaper 104 Park Avenue (big house) for $36,400", "Keep looking for the right place",
            "Buy the cheaper 66 Park Avenue (big house, derelict) for $32,200 and do it up ($3,040)"])


# --- the landlord sells a let house with notice (review fix: the market is never only flats for long) -----------

FIVE_BUYERS = (("weiss", "river_12"), ("shapiro", "main_55"), ("peretz", "park_66"), ("amar", "park_104"),
               ("bendavid", "river_28"))  # every house for sale in seed 1, bought by households in flats


def drought(day: int = 120, hour: int = 9, minute: int = 0, bought: int = 60) -> FakeSim:
    """Seed 1 with every house for sale bought on day `bought` (FIVE_BUYERS), then the clock at `day`: from 14 days
    after the purchases no house has been for sale (house_drought). Six households rent houses from the landlord."""
    sim = FakeSim(tick=at(bought, 18, 30))
    for hh_id, home_id in FIVE_BUYERS:
        assert housing.move_household(sim, sim.households[hh_id], home_id, "buy", check=False)
    sim.clock.tick = at(day, hour, minute)
    sim.logged.clear()
    return sim


def noticed(sim) -> list[str]:
    """The homes under the landlord's notice."""
    return [h.id for h in sim.homes.values() if h.notice is not None]


class NoticeTest(unittest.TestCase):
    """From day 120, while no house has been for sale for two weeks (house_drought), the landlord sells a let house
    with notice (housing.landlord_notices, at 09:00): its settled tenants get house_hunt's notice variant at once and
    have 14 days to move to a home to let; then the house goes on the market. One notice at a time, at most one every
    30 days, never to tenants who moved in less than 120 days ago."""

    def test_notice_from_day_120_in_a_drought(self):
        sim = drought(119)
        self.assertTrue(housing.house_drought(sim))
        housing.tick(sim)
        self.assertEqual((noticed(sim), sim.tagged("home_listed")), ([], []))  # not before day 120 ...
        sim.clock.tick = at(120, 8, 59)
        housing.tick(sim)
        self.assertEqual((noticed(sim), sim.tagged("home_listed")), ([], []))  # ... nor before 09:00
        hh, home = sim.households["mizrahi"], sim.homes["main_13"]
        hh.cooldowns["house_hunt"] = at(125, 0)
        sim.clock.tick = at(120, 9)
        housing.tick(sim)
        self.assertEqual(noticed(sim), ["main_13"])
        self.assertEqual(home.notice, {"household": "mizrahi", "since": at(120, 9), "due": at(134, 9)})
        self.assertEqual(home.noticed, at(120, 9))
        self.assertEqual((home.owner, home.household, home.listing), ("landlord", "mizrahi", None))
        self.assertIs(housing.under_notice(sim, hh), home)
        self.assertNotIn("house_hunt", hh.cooldowns)  # asked where to go at once
        self.assertEqual(sim.texts("home_listed"),
                         ["Millbrook Homes is selling 13 Main Street and gives the Mizrahis 2 weeks' notice."])
        self.assertEqual(sim.tagged("home_listed")[0]["agents"], ["avi", "rina", "lior", "maya"])

    def test_no_notice_while_a_house_is_for_sale_or_was_just_bought(self):
        sim = drought(120, bought=110)
        self.assertFalse(housing.house_drought(sim))  # bought ten days ago
        housing.tick(sim)
        self.assertEqual(noticed(sim), [])
        sim.clock.tick = at(124, 9)
        housing.tick(sim)
        self.assertEqual(noticed(sim), [])  # 13 days and 14 1/2 hours after
        sim.clock.tick = at(125, 9)
        housing.tick(sim)
        self.assertEqual(noticed(sim), ["main_13"])
        sim = drought(120)
        self.assertTrue(housing.move_household(sim, sim.households["levi"], "cedar_court_3b", "rent", check=False))
        self.assertEqual(sim.homes["main_28"].listing, "for_sale")
        housing.tick(sim)
        self.assertEqual(noticed(sim), [])
        hide(sim, "main_28")  # under offer is still for sale
        housing.tick(sim)
        self.assertEqual(noticed(sim), [])

    def test_one_notice_at_a_time_thirty_days_apart(self):
        sim = drought(120)
        housing.tick(sim)
        sim.clock.tick = at(121, 9)
        housing.tick(sim)
        self.assertEqual(noticed(sim), ["main_13"])  # one at a time
        sim.clock.tick = at(134, 9)
        housing.tick(sim)
        self.assertEqual((noticed(sim), sim.homes["main_13"].listing), ([], "for_sale"))
        sim.clock.tick = at(134, 18, 30)
        self.assertTrue(housing.move_household(sim, sim.households["rosen"], "main_13", "buy", check=False))
        sim.clock.tick = at(149, 9)
        self.assertTrue(housing.house_drought(sim))
        housing.tick(sim)
        self.assertEqual(noticed(sim), [])  # 29 days after the last notice
        sim.clock.tick = at(150, 9)
        housing.tick(sim)
        self.assertEqual(noticed(sim), ["main_20"])  # the Cohens'
        self.assertEqual(sim.texts("home_listed")[-1], "Millbrook Homes is selling 20 Main Street and gives the "
                                                       "Cohens 2 weeks' notice.")

    def test_who_is_given_notice(self):
        """Tenants who have been there since the start or for 120 days, the longest-standing first (ties: the house's
        id), with a fitting home to let to go to."""
        sim = drought(200)
        hhs = sim.households
        self.assertEqual(housing.notice_home(sim).id, "main_13")  # all there since the start: the first id
        hhs["mizrahi"].moved_tick = at(80, 9, 1)  # 120 days less a minute ago: not yet
        for hh_id in ("cohen", "haddad", "golan", "navon", "nassar"):
            hhs[hh_id].moved_tick = at(150, 0)
        self.assertIsNone(housing.notice_home(sim))
        hhs["cohen"].moved_tick = at(80, 9)  # exactly 120 days ago
        self.assertEqual(housing.notice_home(sim).id, "main_20")
        hhs["haddad"].moved_tick = None
        self.assertEqual(housing.notice_home(sim).id, "main_21")  # there since the start
        hhs["haddad"].moved_tick = at(150, 0)
        hhs["nassar"].moved_tick = at(70, 0)
        self.assertEqual(housing.notice_home(sim).id, "river_20")  # moved in before the Cohens
        hide(sim, *[h.id for h in housing.vacancies(sim, "for_rent")])
        self.assertIsNone(housing.notice_home(sim))  # nowhere to go
        sim.clock.tick = at(200, 9)
        housing.tick(sim)
        self.assertEqual(noticed(sim), [])

    def test_the_notice_fork(self):
        sim = drought(120)
        housing.tick(sim)
        sim.clock.tick = at(120, 18, 30)  # a Tuesday evening
        hh, avi = sim.households["mizrahi"], sim.agents["avi"]
        fork = housing_forks.house_hunt_fork(sim, avi)
        self.assertEqual((fork.kind, fork.major), ("house_hunt", True))
        self.assertEqual(fork.question, "Millbrook Homes is selling 13 Main Street, the house you rent ($520/week), "
                                        "and has given your household notice: you have to move out by Day 135 Tue "
                                        "09:00. Your household has $23,300 put by. What do you do?")
        self.assertEqual(labels(fork), ["Rent 39 Main Street (house) for $330/week",
                                        "Rent the cheaper Birch Court, flat 1B (flat) for $220/week",
                                        "Talk it over and decide another time",
                                        "Ask Millbrook Homes for more time"])
        self.assertEqual([o.cost for o in fork.options], [housing.MOVING_COST, housing.MOVING_COST, 0, 0])
        self.assertEqual([o.extra for o in fork.options], [
            {"move": "main_39", "how": "rent"}, {"move": "birch_court_1b", "how": "rent"},
            {"hh_cooldown": housing_forks.NOTICE_RETRY}, {"hh_cooldown": housing_forks.NOTICE_LATER}])
        self.assertTrue(all(housing.affordable(sim, hh, h) for h in ("main_39", "birch_court_1b")))
        self.assertLess(housing.weekly_outgo(sim, hh, "birch_court_1b"), housing.weekly_outgo(sim, hh, "main_39"))
        self.assertEqual(hh.cooldowns["house_hunt"], at(121, 18, 30))  # asked again tomorrow if nothing comes of it
        self.assertIsNone(housing_forks.house_hunt_fork(sim, sim.agents["rina"]))  # one ask for the household
        housing.apply_extra(sim, avi, fork, fork.options[3])  # more time: asked again in three days
        self.assertEqual(hh.cooldowns["house_hunt"], at(123, 18, 30))
        self.assertEqual(sim.homes["main_13"].notice["due"], at(134, 9))  # the notice stands
        sim.agents["rina"].savings += 40000  # with the money to buy the house, the third option is to buy it
        hh.cooldowns.clear()
        fork = housing_forks.house_hunt_fork(sim, avi)
        self.assertEqual(labels(fork)[2], "Buy 13 Main Street from Millbrook Homes for $19,850")
        self.assertEqual((fork.options[2].cost, fork.options[2].extra), (19850, {"buy_let": "main_13"}))
        self.assertEqual(len(set(labels(fork))), 4)

    def test_asked_in_the_household_window_off_shift(self):
        sim = drought(120)
        housing.tick(sim)
        sim.clock.tick = at(120, 12)
        self.assertIsNone(housing_forks.house_hunt_fork(sim, sim.agents["avi"]))
        sim.clock.tick = at(120, 18, 30)
        sim.on_shift_now = lambda agent: agent.id == "avi"
        self.assertIsNone(housing_forks.house_hunt_fork(sim, sim.agents["avi"]))
        self.assertIsNotNone(housing_forks.house_hunt_fork(sim, sim.agents["rina"]))
        self.assertIsNone(housing_forks.house_hunt_fork(sim, sim.agents["lior"]))  # a child

    def test_tenants_in_arrears_are_asked_and_offered_what_they_can_carry(self):
        """The ordinary house_hunt skips a household in arrears; under notice it is asked. The rentals it is offered
        pass the affordability gate of every house_hunt move (PLAN decision 57): with $5,000 the Mizrahis can carry
        only the flats, and broke none, so they keep looking, and the landlord moves them into the cheapest fitting
        home to let when the notice runs out (no van to pay)."""
        sim = drought(120)
        housing.tick(sim)
        sim.clock.tick = at(120, 18, 30)
        hh, avi = sim.households["mizrahi"], sim.agents["avi"]
        hh.arrears = 2
        set_funds(sim, "mizrahi", 5000)
        fork = housing_forks.house_hunt_fork(sim, avi)
        self.assertFalse(housing.affordable(sim, hh, "main_39"))
        self.assertEqual(labels(fork)[:2], ["Rent Birch Court, flat 3B (flat) for $260/week",
                                            "Rent the cheaper Birch Court, flat 1B (flat) for $220/week"])
        self.assertTrue(all(housing.affordable(sim, hh, o.extra["move"]) for o in fork.options[:2]))
        set_funds(sim, "mizrahi", 0)
        hh.cooldowns.clear()
        fork = housing_forks.house_hunt_fork(sim, avi)
        self.assertEqual(labels(fork), ["Look for somewhere else to rent", "Keep looking for the right place",
                                        "Talk it over and decide another time", "Ask Millbrook Homes for more time"])
        housing.apply_extra(sim, avi, fork, fork.options[0])
        self.assertEqual(hh.home_id, "main_13")
        sim.clock.tick = at(134, 9)
        housing.tick(sim)
        self.assertEqual((hh.home_id, housing.funds(sim, hh)), ("birch_court_1b", 0))
        self.assertEqual(sim.texts("evicted"), ["Millbrook Homes evicts the Mizrahis from 13 Main Street. They move "
                                                "into Birch Court, flat 1B at $220/week."])

    def test_no_rental_offered_that_the_income_does_not_cover(self):
        """The Nassars' income ($532 a week) covers neither the house nor the flat to let (with bills, living and
        the commute): with $6,000 put by they are offered no rental, rather than the dearer house."""
        sim = drought(120)
        hh, home = sim.households["nassar"], sim.homes["river_20"]
        set_funds(sim, "nassar", 6000)
        housing.give_notice(sim, home)
        sim.clock.tick = at(120, 18, 30)
        self.assertEqual(round(housing.weekly_income(sim, hh)), 532)
        for home_id in ("main_39", "birch_court_1b"):
            self.assertLess(housing.weekly_income(sim, hh), housing.weekly_outgo(sim, hh, home_id))
            self.assertFalse(housing.affordable(sim, hh, home_id))
        fork = housing_forks.house_hunt_fork(sim, housing.adults(sim, hh)[0])
        self.assertEqual(labels(fork)[:2], ["Look for somewhere else to rent", "Keep looking for the right place"])
        self.assertEqual(len(set(labels(fork))), 4)

    def test_nothing_to_let_keeps_looking(self):
        sim = drought(120)
        housing.tick(sim)
        sim.clock.tick = at(120, 18, 30)
        hide(sim, *[h.id for h in housing.vacancies(sim, "for_rent") if h.id != "cedar_court_3b"])
        fork = housing_forks.house_hunt_fork(sim, sim.agents["avi"])
        self.assertEqual(labels(fork)[:2], ["Rent Cedar Court, flat 3B (flat) for $260/week",
                                            "Keep looking for the right place"])  # nothing cheaper
        self.assertEqual(fork.options[1].extra, {"hh_cooldown": housing_forks.NOTICE_LATER})
        hide(sim, "cedar_court_3b")
        sim.households["mizrahi"].cooldowns.clear()
        fork = housing_forks.house_hunt_fork(sim, sim.agents["avi"])
        self.assertEqual(labels(fork), ["Look for somewhere else to rent", "Keep looking for the right place",
                                        "Talk it over and decide another time", "Ask Millbrook Homes for more time"])

    def test_the_cheaper_rental_costs_less_a_week(self):
        """Every notice fork's "the cheaper" home costs as much to move into as option 0's and less a week."""
        seen = collections.Counter()
        for home_id in ("main_13", "main_20", "main_21", "main_47", "park_29", "river_20"):
            for hidden in [(), ("main_39",), ("main_39", "birch_court_1b", "birch_court_2b", "cedar_court_1b"),
                           ("elm_court_1a",)]:
                for extra in (0, 40000):
                    sim = drought(120)
                    home = sim.homes[home_id]
                    hh = sim.households[home.household]
                    housing.adults(sim, hh)[0].savings += extra
                    hide(sim, *hidden)
                    housing.give_notice(sim, home)
                    sim.clock.tick = at(120, 18, 30)
                    fork = housing_forks.house_hunt_fork(sim, housing.adults(sim, hh)[0])
                    self.assertEqual(len(set(labels(fork))), 4, labels(fork))
                    for option in fork.options:  # every rental offered passes the affordability gate
                        if "move" in option.extra:
                            self.assertTrue(housing.affordable(sim, hh, option.extra["move"]), labels(fork))
                            seen["rentals"] += 1
                    first, second = fork.options[0], fork.options[1]
                    if "the cheaper" in second.label:
                        self.assertLess(spend(sim, hh, second.extra["move"]), spend(sim, hh, first.extra["move"]))
                        self.assertLess(housing.weekly_outgo(sim, hh, second.extra["move"]),
                                        housing.weekly_outgo(sim, hh, first.extra["move"]), labels(fork))
                        self.assertEqual(second.cost, first.cost)
                        seen["cheaper"] += 1
                    else:
                        self.assertEqual(second.label, "Keep looking for the right place")
                        seen["keep looking"] += 1
                    seen["buy"] += labels(fork)[2].startswith("Buy ")
        self.assertGreater(seen["cheaper"], 10)
        self.assertGreater(seen["buy"], 5)
        self.assertGreater(seen["rentals"], 40)

    def test_moving_out_leaves_the_house_empty_until_the_notice_runs_out(self):
        sim = drought(120)
        housing.tick(sim)
        sim.clock.tick = at(120, 18, 30)
        hh, avi, home = sim.households["mizrahi"], sim.agents["avi"], sim.homes["main_13"]
        fork = housing_forks.house_hunt_fork(sim, avi)
        housing.apply_extra(sim, avi, fork, fork.options[1])
        self.assertEqual(hh.home_id, "birch_court_1b")
        self.assertIsNone(housing.under_notice(sim, hh))
        # Empty and not to let: the landlord sells it when the notice runs out, not before (the sale of a let house
        # left empty in a drought waits for it), so its sales are as far apart as its notices.
        self.assertEqual((home.household, home.owner, home.listing), (None, "landlord", None))
        self.assertNotIn(home, housing.vacancies(sim))
        sim.clock.tick = at(134, 8)
        housing.tick(sim)
        self.assertEqual((home.owner, home.listing), ("landlord", None))
        sim.clock.tick = at(134, 9)
        housing.tick(sim)
        self.assertEqual((home.owner, home.listing, home.notice), ("market", "for_sale", None))
        self.assertEqual(home.noticed, at(120, 9))
        self.assertIn(home, housing.vacancies(sim))
        self.assertEqual(sim.texts("home_listed")[-1], "Millbrook Homes puts 13 Main Street up for sale ($19,850).")
        self.assertEqual(sim.tagged("evicted"), [])

    def test_tenants_still_there_are_moved_out_when_it_runs_out(self):
        sim = drought(120)
        housing.tick(sim)
        hh, home = sim.households["mizrahi"], sim.homes["main_13"]
        sim.clock.tick = at(134, 9)
        rentals = [h.id for h in housing.vacancies(sim, "for_rent")]
        hide(sim, *rentals, days=1)
        housing.tick(sim)  # nothing to let: they stay another day
        self.assertEqual((hh.home_id, home.listing, home.notice["due"]), ("main_13", None, at(135, 9)))
        self.assertEqual(home.noticed, at(121, 9))  # the next notice waits a day too: the sales stay 30 days apart
        self.assertEqual(sim.tagged("evicted"), [])
        sim.clock.tick = at(135, 9)
        before = housing.funds(sim, hh)
        housing.tick(sim)
        self.assertEqual(hh.home_id, "birch_court_1b")  # the cheapest that fits
        self.assertEqual(housing.funds(sim, hh), before)  # the landlord's van
        self.assertEqual(sim.texts("evicted"), ["Millbrook Homes evicts the Mizrahis from 13 Main Street. They move "
                                                "into Birch Court, flat 1B at $220/week."])
        self.assertEqual((home.household, home.owner, home.listing, home.notice), (None, "market", "for_sale", None))

    def test_the_tenants_buy_the_house(self):
        sim = drought(120)
        hh, dana, home = sim.households["cohen"], sim.agents["dana"], sim.homes["main_20"]
        housing.give_notice(sim, home)
        sim.clock.tick = at(120, 18, 30)
        fork = housing_forks.house_hunt_fork(sim, dana)
        self.assertEqual(labels(fork)[2], "Buy 20 Main Street from Millbrook Homes for $15,900")
        funds = {a.id: a.money + a.savings for a in housing.adults(sim, hh)}
        before = worths(sim, hh)
        housing.apply_extra(sim, dana, fork, fork.options[2])
        self.assertEqual((home.owner, home.household, home.listing, home.notice), ("cohen", "cohen", None, None))
        self.assertEqual((housing.tenure(sim, hh), hh.weekly_rent), ("owned", 0))
        self.assertAlmostEqual(housing.funds(sim, hh), sum(funds.values()) - 15900)
        for agent_id, paid in funds.items():  # each one's share is what they paid
            self.assertAlmostEqual(home.shares[agent_id], paid / sum(funds.values()))
        after = worths(sim, hh)
        for agent_id in funds:  # their money is now their share of the house, at its value
            self.assertLessEqual(abs(after[agent_id] - before[agent_id]), 1, agent_id)
        self.assertEqual(sim.texts("home_bought"), ["The Cohens buy 20 Main Street (house, Maple Grove) from Millbrook "
                                                    "Homes for $15,900."])
        self.assertEqual([hh.history[-1]["event"], home.history[-1]["event"]], ["bought", "bought"])
        sim.clock.tick = at(134, 9)
        housing.tick(sim)
        self.assertEqual((home.owner, home.listing), ("cohen", None))  # nothing goes on the market
        self.assertFalse(housing.buy_let_home(sim, hh, dana))
        self.assertEqual(sim.texts("too_late"), ["The Cohens can't buy 20 Main Street after all."])

    def test_they_cannot_buy_without_the_money(self):
        sim = drought(120)
        hh, dana = sim.households["cohen"], sim.agents["dana"]
        housing.give_notice(sim, sim.homes["main_20"])
        sim.clock.tick = at(120, 18, 30)
        fork = housing_forks.house_hunt_fork(sim, dana)
        set_funds(sim, "cohen", 9000)  # spent before the money moved
        housing.apply_extra(sim, dana, fork, fork.options[2])
        self.assertEqual((sim.homes["main_20"].owner, housing.funds(sim, hh)), ("landlord", 9000))
        self.assertEqual(sim.texts("too_late"), ["The Cohens can't buy 20 Main Street after all."])
        self.assertEqual(dana.plan, [("idle", "home")])

    def test_a_purchase_hands_the_sale_date_to_the_next_notice(self):
        """Tenants who buy the house leave the drought standing (the house was never on the market) and don't hold up
        the landlord's sales: it gives notice on the next let house at once, to move out by the same date."""
        sim = drought(120)
        hh, dana, home = sim.households["cohen"], sim.agents["dana"], sim.homes["main_20"]
        housing.give_notice(sim, home)
        sim.clock.tick = at(120, 18, 30)
        fork = housing_forks.house_hunt_fork(sim, dana)
        housing.apply_extra(sim, dana, fork, fork.options[2])
        self.assertEqual((home.owner, home.notice, home.noticed), ("cohen", None, None))
        self.assertEqual(home.history[-1], {"tick": at(120, 18, 30), "time": sim.clock.stamp(), "event": "bought",
                                            "household": "cohen", "price": 15900, "off_market": True})
        self.assertTrue(housing.house_drought(sim))
        self.assertEqual(noticed(sim), ["main_13"])  # at once, not 30 days on
        nxt, mizrahi = sim.homes["main_13"], sim.households["mizrahi"]
        self.assertEqual(nxt.notice, {"household": "mizrahi", "since": at(120, 18, 30), "due": at(134, 9)})
        self.assertEqual(nxt.noticed, at(120, 9))  # the sale it took over was noticed then
        self.assertEqual(sim.texts("home_listed"), [
            "Millbrook Homes is selling 20 Main Street and gives the Cohens 2 weeks' notice.",
            "Millbrook Homes is selling 13 Main Street and gives the Mizrahis notice to move out by Day 135 Tue "
            "09:00."])
        fork = housing_forks.house_hunt_fork(sim, sim.agents["avi"])  # asked that evening
        self.assertIn("you have to move out by Day 135 Tue 09:00.", fork.question)
        self.assertEqual(mizrahi.cooldowns["house_hunt"], at(121, 18, 30))
        sim.clock.tick = at(134, 9)
        housing.tick(sim)
        self.assertEqual((nxt.owner, nxt.listing, mizrahi.home_id), ("market", "for_sale", "birch_court_1b"))
        sim.clock.tick = at(134, 18, 30)
        self.assertTrue(housing.move_household(sim, sim.households["rosen"], "main_13", "buy", check=False))
        sim.clock.tick = at(149, 9)
        housing.tick(sim)
        self.assertEqual(noticed(sim), [])  # the next sale is 30 days after this one, as ever
        sim.clock.tick = at(150, 9)
        housing.tick(sim)
        self.assertEqual(noticed(sim), ["main_21"])

    def test_a_late_purchase_still_gives_a_week(self):
        sim = drought(120)
        housing.give_notice(sim, sim.homes["main_20"])
        sim.clock.tick = at(130, 18, 30)
        self.assertTrue(housing.buy_let_home(sim, sim.households["cohen"]))
        nxt = sim.homes["main_13"]
        self.assertEqual((nxt.notice["due"], nxt.noticed), (at(137, 18, 30), at(123, 18, 30)))
        self.assertEqual(sim.texts("home_listed")[-1], "Millbrook Homes is selling 13 Main Street and gives the "
                                                       "Mizrahis notice to move out by Day 138 Fri 18:30.")
        sim.clock.tick = at(137, 9)
        housing.tick(sim)
        self.assertEqual((nxt.owner, nxt.listing), ("landlord", None))
        sim.clock.tick = at(138, 9)
        housing.tick(sim)
        self.assertEqual((nxt.owner, nxt.listing, sim.households["mizrahi"].home_id),
                         ("market", "for_sale", "birch_court_1b"))

    def test_no_next_notice_once_a_house_is_for_sale(self):
        sim = drought(120)
        housing.give_notice(sim, sim.homes["main_20"])
        self.assertTrue(housing.move_household(sim, sim.households["levi"], "cedar_court_3b", "rent", check=False))
        self.assertEqual(sim.homes["main_28"].listing, "for_sale")
        sim.clock.tick = at(120, 18, 30)
        self.assertTrue(housing.buy_let_home(sim, sim.households["cohen"]))
        self.assertEqual(noticed(sim), [])

    def test_a_death_under_notice(self):
        sim = drought(120)
        home = sim.homes["river_20"]
        housing.give_notice(sim, home)
        for agent_id in ("noam", "ronit", "amira"):  # the Nassars
            gone(sim, agent_id)
        housing.on_death(sim, sim.agents["noam"])
        self.assertEqual((home.household, home.owner, home.listing), (None, "landlord", None))
        sim.clock.tick = at(134, 9)
        housing.tick(sim)
        self.assertEqual((home.owner, home.listing, home.notice), ("market", "for_sale", None))
        self.assertEqual(sim.tagged("evicted"), [])


class NoticeEngineTest(unittest.TestCase):
    """The real Simulation: the landlord's notice at 09:00 on day 120, the tenants' fork that evening, and the sale."""

    def test_a_notice_in_the_engine(self):
        from gameofailife.sim import Simulation

        sim = Simulation(seed=SEED, now=lambda: 0.0)
        sim.clock.tick = at(60, 18, 30)
        for hh_id, home_id in FIVE_BUYERS:
            self.assertTrue(housing.move_household(sim, sim.households[hh_id], home_id, "buy", check=False))
        sim.drain()
        asked = []
        director = sim.director

        def watch(agent, fork):
            asked.append((agent.id, fork.kind, fork.question, labels(fork)))
            return director(agent, fork)

        sim.director = watch
        hh, home = sim.households["mizrahi"], sim.homes["main_13"]
        sim.clock.tick = at(120, 8, 59)
        events = []
        while sim.clock.tick < at(120, 21):
            sim.step()
            events += sim.drain()[0]
        self.assertIn(f"{at(120, 9)} home_listed Millbrook Homes is selling 13 Main Street and gives the Mizrahis 2 "
                      "weeks' notice.", [f"{e['tick']} {e['tag']} {e['text']}" for e in events])
        notices = [row for row in asked if row[1] == "house_hunt" and "given your household notice" in row[2]]
        self.assertEqual([row[0] in ("avi", "rina") for row in notices], [True])  # asked once, that evening
        self.assertEqual(len(notices[0][3]), 4)
        if hh.home_id != "main_13":  # they moved to a home to let
            self.assertEqual(housing.tenure(sim, hh), "rented")
            self.assertEqual((home.household, home.listing), (None, None))
        sim.clock.tick = at(134, 8, 59)
        sim.step()
        self.assertNotEqual(hh.home_id, "main_13")
        self.assertEqual((home.owner, home.listing, home.notice), ("market", "for_sale", None))
        self.assertIn(home, housing.vacancies(sim))


def notice_trace(dice: int, legs: list) -> dict:
    """NoticeLockstepTest.JS in Python, on the JS port's dice (tests.test_port.DiceSim)."""
    from gameofailife.agent import NEEDS
    from tests.test_port import DiceSim

    sim = DiceSim(SEED, dice)
    sim.clock.tick = at(60, 18, 30)
    for hh_id, home_id in FIVE_BUYERS:
        housing.move_household(sim, sim.households[hh_id], home_id, "buy", check=False)
    out = {"events": [], "forks": [], "asked": [], "hours": []}
    director = sim.director

    def asked(agent, fork):
        options = sim.fork_message(agent, fork)["options"]
        result = director(agent, fork)
        out["asked"].append([fork.kind, options, fork.scores])
        return result

    sim.director = asked

    def drain():
        events, forks, _ = sim.drain()
        out["events"] += [f"{e['tick']} {e['tag']} {e['text']}" for e in events]
        out["forks"] += [f"{f['tick']} {f['agent']} {f['kind']} {f['choice']} {f['decided_by']} "
                         f"{'|'.join(f['happened'])}" for f in forks]

    drain()
    for start, minutes in legs:
        sim.clock.tick = start
        for _ in range(minutes):
            sim.step()
            drain()
            if sim.clock.minute_of_day % 60 == 0:
                out["hours"].append([sim.clock.tick, [
                    [a.id, a.x, a.y, a.state, a.activity, a.inside, round(a.money, 2), round(a.savings, 2),
                     round(a.health, 2), [round(a.needs[n], 2) for n in NEEDS], a.household_id,
                     sim.households[a.household_id].home_id, a.vehicle, a.riding] for a in sim.agents.values()]])
    notice, mizrahi = sim.homes["main_13"], sim.households["mizrahi"]
    out["end"] = [notice.owner, notice.listing, notice.household, mizrahi.home_id, mizrahi.weekly_rent]
    return json.loads(json.dumps(out))


@unittest.skipUnless(NODE, "node is not installed")
class NoticeLockstepTest(unittest.TestCase):
    """With the same dice, the two engines live the landlord's notice the same way: every event, decided fork, fork
    as the Director gets it and hourly row (as tests/test_port.py's LockstepRun, from day 120 after the day-60
    purchases; the clock is set forward between legs, the same way in both)."""

    JS = r"""
    const G = require(process.argv[1]).load();
    const H = G.housing, pr = G.py.pyRound;
    const { dice, start, buyers, legs } = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const sim = new G.sim.Simulation(1, null, null, dice);
    sim.clock.tick = start;
    for (const [hh, home] of buyers) {
      H.move_household(sim, sim.households.get(hh), home, "buy", 1.0, null, null, true, false);
    }
    const out = { events: [], forks: [], asked: [], hours: [] };
    const director = sim.director.bind(sim);
    sim.director = (agent, fork) => {
      const options = sim.fork_message(agent, fork).options;
      const result = director(agent, fork);
      out.asked.push([fork.kind, options, fork.scores]);
      return result;
    };
    const drain = () => {
      const [events, forks] = sim.drain();
      for (const e of events) out.events.push(`${e.tick} ${e.tag} ${e.text}`);
      for (const f of forks) {
        out.forks.push(`${f.tick} ${f.agent} ${f.kind} ${f.choice} ${f.decided_by} ${f.happened.join("|")}`);
      }
    };
    drain();
    for (const [tick, minutes] of legs) {
      sim.clock.tick = tick;
      for (let i = 0; i < minutes; i++) {
        sim.step();
        drain();
        if (sim.clock.minute_of_day % 60 === 0) {
          out.hours.push([sim.clock.tick, Array.from(sim.agents.values(), a => [a.id, a.x, a.y, a.state, a.activity,
            a.inside, pr(a.money, 2), pr(a.savings, 2), pr(a.health, 2), G.agent.NEEDS.map(n => pr(a.needs[n], 2)),
            a.household_id, sim.households.get(a.household_id).home_id, a.vehicle, a.riding])]);
        }
      }
    }
    const notice = sim.homes.get("main_13"), mizrahi = sim.households.get("mizrahi");
    out.end = [notice.owner, notice.listing, notice.household, mizrahi.home_id, mizrahi.weekly_rent];
    process.stdout.write(JSON.stringify(out));
    """

    def assertLockstep(self, dice: int, legs: list) -> tuple[dict, dict]:
        case = {"dice": dice, "start": at(60, 18, 30), "buyers": FIVE_BUYERS, "legs": legs}
        run = subprocess.run([NODE, "-e", self.JS, str(ROOT / "port" / "tools" / "engine.cjs")],
                             input=json.dumps(case), capture_output=True, text=True, timeout=300, check=False)
        self.assertEqual(run.returncode, 0, run.stderr)
        js, py = json.loads(run.stdout), notice_trace(dice, legs)
        for name in ("events", "forks", "asked", "hours", "end"):
            a, b = py[name], js[name]
            first = next((i for i, (x, y) in enumerate(zip(a, b)) if x != y), min(len(a), len(b)))
            self.assertEqual(a[first:first + 1], b[first:first + 1], f"{name} differ first at #{first} (Python first)")
            self.assertEqual(len(a), len(b), f"{name}: Python has {len(a)}, JS {len(b)}")
        for trace in (py, js):
            self.assertIn(f"{at(120, 9)} home_listed Millbrook Homes is selling 13 Main Street and gives the Mizrahis 2 "
                          "weeks' notice.", trace["events"])
            sale = f"{at(134, 9)} home_listed Millbrook Homes puts 13 Main Street up for sale ($"
            self.assertTrue(any(e.startswith(sale) for e in trace["events"]), trace["events"][-20:])
        return py, js

    def test_they_move_and_it_is_sold(self):
        # The tenants under notice move out before the notice runs out, into a rental the notice fork offered them
        # (every rental it offers passed housing.affordable), and when it runs out the landlord sells the empty house:
        # it goes to the market, for sale. Both engines alike. Which rental they take is their profile's pick among
        # those offered (package D's scores took the house to let, option 0; v2's took the cheaper flat), so it is
        # not pinned.
        py, js = self.assertLockstep(3, [[at(120, 8, 59), 15 * 60], [at(134, 8, 59), 15 * 60]])
        notice = [r for r in py["asked"] if r[0] == "house_hunt" and r[1][3]["label"].startswith("Ask Millbrook")]
        self.assertEqual(len(notice), 1)  # asked once
        offered = {}
        for o in notice[0][1]:
            m = re.match(r"Rent (?:the cheaper )?(.+?) \(.*\) for \$(\d+)/week$", o["label"])
            if m:
                offered[m.group(1)] = int(m.group(2))
        self.assertTrue(offered, notice[0][1])
        due = at(134, 9)
        for trace in (py, js):
            moves = [m for m in (re.match(r"(\d+) home_rented The Mizrahis move into (.+?) \(.*\) at \$(\d+)/week\.$", e)
                                 for e in trace["events"]) if m]
            self.assertEqual(len(moves), 1, [e for e in trace["events"] if "Mizrahis" in e])
            tick, name, rent = int(moves[0].group(1)), moves[0].group(2), int(moves[0].group(3))
            self.assertLess(tick, due)
            self.assertEqual(offered.get(name), rent, (name, rent, offered))
            owner, listing, household, home_id, weekly_rent = trace["end"]
            self.assertEqual((owner, listing, household), ("market", "for_sale", None))  # the landlord sold it
            self.assertNotEqual(home_id, "main_13")
            self.assertEqual(weekly_rent, rent)

    def test_they_stay_and_are_moved_out(self):
        py, _ = self.assertLockstep(3, [[at(120, 8, 59), 120], [at(134, 8, 59), 15 * 60]])
        self.assertIn(f"{at(134, 9)} evicted Millbrook Homes evicts the Mizrahis from 13 Main Street. They move into "
                      "Birch Court, flat 1B at $220/week.", py["events"])

    @unittest.skipUnless(os.environ.get("GOAL_SLOW") == "1", "runs with GOAL_SLOW=1")
    def test_sixteen_days_from_the_notice(self):
        for dice in (2, 5):
            with self.subTest(dice=dice):
                self.assertLockstep(dice, [[at(120, 8, 59), 16 * DAY]])


@unittest.skipUnless(NODE, "node is not installed")
class NoticeParityTest(unittest.TestCase):
    """The landlord's notice, step by step, in the Python engine and its JS port: who gets it, the fork the tenants
    are offered with each choice played, the sale or the eviction when it runs out, a purchase by the tenants and a
    death under notice; every state and event (but the outcome dice's) the same."""

    JS = r"""
    const G = require(process.argv[1]).load();
    const H = G.housing, F = G.housing_forks, pr = G.py.pyRound;
    const { buyers, cases } = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const out = [];
    for (const ops of cases) {
      const sim = new G.sim.Simulation(1);
      const hh = id => sim.households.get(id);
      const got = [];
      let last = null;
      for (const [op, ...a] of ops) {
        if (op === "tick") sim.clock.tick = a[0];
        else if (op === "buyers") {
          for (const [h, home] of buyers) H.move_household(sim, hh(h), home, "buy", 1.0, null, null, true, false);
        } else if (op === "office") H.tick(sim);
        else if (op === "notice") H.give_notice(sim, sim.homes.get(a[0]));
        else if (op === "move") got.push(H.move_household(sim, hh(a[0]), a[1], a[2], 1.0, null, null, true, false));
        else if (op === "cash") {
          sim.agents.get(a[0]).money = a[1];
          sim.agents.get(a[0]).savings = 0.0;
        } else if (op === "hide") sim.homes.get(a[0]).under_offer_until = sim.clock.tick + a[1] * H.DAY;
        else if (op === "moved") hh(a[0]).moved_tick = a[1];
        else if (op === "die") {
          for (const id of a) {
            const agent = sim.agents.get(id), house = hh(agent.household_id);
            agent.alive = false;
            house.member_ids = house.member_ids.filter(m => m !== id);
          }
          H.on_death(sim, sim.agents.get(a[0]));
        } else if (op === "candidate") {
          const home = H.notice_home(sim);
          got.push([home === null ? null : home.id, H.house_drought(sim)]);
        } else if (op === "build") {
          const agent = sim.agents.get(a[0]);
          delete hh(agent.household_id).cooldowns.house_hunt;
          last = F.house_hunt_fork(sim, agent);
          got.push(last === null ? null : { question: last.question, labels: last.options.map(o => o.label),
            costs: last.options.map(o => o.cost), extras: last.options.map(o => o.extra) });
        } else if (op === "decide") sim._decide(sim.agents.get(a[0]), last, a[1], "model", "");
        else if (op === "buy_let") got.push(H.buy_let_home(sim, hh(a[0]), null));
        else if (op === "state") {
          const house = hh(a[0]), home = sim.homes.get(a[1]), at = H.under_notice(sim, house);
          got.push({ home: { owner: home.owner, household: home.household, listing: home.listing, notice: home.notice,
            noticed: home.noticed, shares: home.shares }, hh: { home_id: house.home_id, rent: house.weekly_rent,
            cooldown: house.cooldowns.house_hunt ?? null, funds: pr(H.funds(sim, house), 2),
            moved: house.moved_tick }, under_notice: at === null ? null : at.id,
            can_buy: H.can_buy_let_home(sim, house) });
        }
      }
      got.push(sim.drain()[0].filter(e => e.tag !== "outcome").map(e => `${e.tick} ${e.tag} ${e.text}`));
      out.push(got);
    }
    process.stdout.write(JSON.stringify(out));
    """

    def python(self, cases):
        from gameofailife.sim import Simulation

        out = []
        for ops in cases:
            sim = Simulation(seed=1, now=lambda: 0.0)
            hhs = sim.households
            got, last = [], None
            for op, *a in ops:
                if op == "tick":
                    sim.clock.tick = a[0]
                elif op == "buyers":
                    for hh_id, home_id in FIVE_BUYERS:
                        housing.move_household(sim, hhs[hh_id], home_id, "buy", check=False)
                elif op == "office":
                    housing.tick(sim)
                elif op == "notice":
                    housing.give_notice(sim, sim.homes[a[0]])
                elif op == "move":
                    got.append(housing.move_household(sim, hhs[a[0]], a[1], a[2], check=False))
                elif op == "cash":
                    give(sim, **{a[0]: a[1]})
                elif op == "hide":
                    hide(sim, a[0], days=a[1])
                elif op == "moved":
                    hhs[a[0]].moved_tick = a[1]
                elif op == "die":
                    for agent_id in a:
                        gone(sim, agent_id)
                    housing.on_death(sim, sim.agents[a[0]])
                elif op == "candidate":
                    home = housing.notice_home(sim)
                    got.append([None if home is None else home.id, housing.house_drought(sim)])
                elif op == "build":
                    hhs[sim.agents[a[0]].household_id].cooldowns.pop("house_hunt", None)
                    last = housing_forks.house_hunt_fork(sim, sim.agents[a[0]])
                    got.append(None if last is None else {
                        "question": last.question, "labels": labels(last), "costs": [o.cost for o in last.options],
                        "extras": [o.extra for o in last.options]})
                elif op == "decide":
                    sim._decide(sim.agents[a[0]], last, a[1], "model", "")
                elif op == "buy_let":
                    got.append(housing.buy_let_home(sim, hhs[a[0]], None))
                elif op == "state":
                    hh, home = hhs[a[0]], sim.homes[a[1]]
                    under = housing.under_notice(sim, hh)
                    got.append({"home": {"owner": home.owner, "household": home.household, "listing": home.listing,
                                         "notice": home.notice, "noticed": home.noticed, "shares": home.shares},
                                "hh": {"home_id": hh.home_id, "rent": hh.weekly_rent,
                                       "cooldown": hh.cooldowns.get("house_hunt"),
                                       "funds": round(housing.funds(sim, hh), 2), "moved": hh.moved_tick},
                                "under_notice": None if under is None else under.id,
                                "can_buy": housing.can_buy_let_home(sim, hh)})
            got.append([f"{e['tick']} {e['tag']} {e['text']}" for e in sim.drain()[0] if e["tag"] != "outcome"])
            out.append(got)
        return json.loads(json.dumps(out))

    def test_the_notices_match(self):
        start = [["tick", at(60, 18, 30)], ["buyers"]]
        rentals = ["birch_court_1b", "birch_court_2b", "birch_court_3b", "cedar_court_1b", "cedar_court_2b",
                   "cedar_court_3b", "elm_court_1a", "elm_court_2b", "elm_court_3a", "main_39"]
        evening = ["tick", at(120, 18, 30)]
        mizrahi = ["state", "mizrahi", "main_13"]
        cases = [
            # the notice at 09:00 on day 120, after 08:59 and day 119; each of the tenants' four choices
            *[start + [["tick", at(119, 9)], ["office"], ["tick", at(120, 8, 59)], ["office"], ["candidate"],
                       ["tick", at(120, 9)], ["office"], mizrahi, evening, ["build", "avi"], ["decide", "avi", i],
                       mizrahi, ["state", "mizrahi", "birch_court_1b"], ["tick", at(134, 9)], ["office"], mizrahi,
                       ["candidate"]] for i in range(4)],
            # the Cohens buy the house they rent, then a second try is too late; then a broke try
            start + [["tick", at(120, 9)], ["notice", "main_20"], evening, ["build", "dana"], ["decide", "dana", 2],
                     ["state", "cohen", "main_20"], ["buy_let", "cohen"], ["tick", at(134, 9)], ["office"],
                     ["state", "cohen", "main_20"]],
            start + [["tick", at(120, 9)], ["notice", "main_20"], evening, ["build", "dana"], ["cash", "dana", 100.0],
                     ["decide", "dana", 2], ["state", "cohen", "main_20"]],
            # who is given notice; nothing to let; another day's wait for the eviction
            start + [["tick", at(200, 9)], ["candidate"], ["moved", "mizrahi", at(80, 9, 1)],
                     *[["moved", h, at(150, 0)] for h in ("cohen", "haddad", "golan", "navon", "nassar")],
                     ["candidate"], ["moved", "cohen", at(80, 9)], ["candidate"], ["moved", "nassar", at(70, 0)],
                     ["candidate"], ["office"], ["state", "nassar", "river_20"]],
            start + [["tick", at(120, 9)], ["office"], evening, *[["hide", h, 1] for h in rentals[1:]],
                     ["build", "avi"], ["tick", at(134, 9)], *[["hide", h, 1] for h in rentals], ["office"], mizrahi,
                     ["tick", at(135, 9)], ["office"], mizrahi],
            # one notice at a time, 30 days apart: the next in line on day 150, not 149
            start + [["tick", at(120, 9)], ["office"], ["tick", at(121, 9)], ["office"], ["tick", at(134, 9)],
                     ["office"], ["tick", at(134, 18, 30)], ["move", "rosen", "main_13", "buy"], ["tick", at(149, 9)],
                     ["office"], ["candidate"], ["state", "cohen", "main_20"], ["tick", at(150, 9)], ["office"],
                     ["state", "cohen", "main_20"]],
            # broke: no rental offered, and the landlord moves them out when the notice runs out; a death under notice
            start + [["tick", at(120, 9)], ["office"], evening, ["cash", "avi", 0.0], ["cash", "rina", 0.0],
                     ["build", "avi"], ["decide", "avi", 0], mizrahi, ["tick", at(134, 9)], ["office"], mizrahi],
            start + [["tick", at(120, 9)], ["notice", "river_20"], ["die", "noam", "ronit", "amira"],
                     ["state", "nassar", "river_20"], ["tick", at(134, 9)], ["office"],
                     ["state", "nassar", "river_20"]],
            # a purchase by the tenants hands the sale date to the next notice: the same day, or a week from a late one
            start + [["tick", at(120, 9)], ["notice", "main_20"], evening, ["build", "dana"], ["decide", "dana", 2],
                     mizrahi, ["candidate"], evening, ["build", "avi"], ["tick", at(134, 9)], ["office"], mizrahi],
            start + [["tick", at(120, 9)], ["notice", "main_20"], ["tick", at(130, 18, 30)], ["buy_let", "cohen"],
                     mizrahi, ["tick", at(137, 9)], ["office"], mizrahi, ["tick", at(138, 9)], ["office"], mizrahi],
        ]
        payload = {"buyers": FIVE_BUYERS, "cases": cases}
        run = subprocess.run([NODE, "-e", self.JS, str(ROOT / "port" / "tools" / "engine.cjs")],
                             input=json.dumps(payload), capture_output=True, text=True, timeout=300, check=False)
        self.assertEqual(run.returncode, 0, run.stderr)
        js, py = json.loads(run.stdout), self.python(cases)
        self.assertEqual(len(js), len(py))
        for i, (got, want) in enumerate(zip(js, py)):
            for j, (g, w) in enumerate(zip(got, want)):
                self.assertEqual(g, w, f"case {i}, row {j} differs (JS first)")
            self.assertEqual(len(got), len(want), f"case {i}")
        self.assertEqual([rows[0] for rows in py[:4]], [["main_13", True]] * 4)
        self.assertEqual([rows[2]["labels"] for rows in py[:4]], [[
            "Rent 39 Main Street (house) for $330/week", "Rent the cheaper Birch Court, flat 1B (flat) for $220/week",
            "Talk it over and decide another time", "Ask Millbrook Homes for more time"]] * 4)
        self.assertEqual([rows[3]["hh"]["home_id"] for rows in py[:4]],  # where each choice took the Mizrahis ...
                         ["main_39", "birch_court_1b", "main_13", "main_13"])
        self.assertEqual([rows[5]["hh"]["home_id"] for rows in py[:4]],  # ... and where they were on day 134
                         ["main_39", "birch_court_1b", "birch_court_1b", "birch_court_1b"])
        self.assertEqual([rows[5]["home"]["listing"] for rows in py[:4]], ["for_sale"] * 4)
        self.assertEqual([rows[6] for rows in py[:4]], [["main_20", False]] * 4)  # next in line; a house for sale
        self.assertEqual((py[4][1]["home"]["owner"], py[4][2], py[4][3]["home"]["listing"]), ("cohen", False, None))
        self.assertEqual(py[5][1]["home"]["owner"], "landlord")
        self.assertEqual([row[0] for row in py[6][:4]], ["main_13", None, "main_20", "river_20"])
        self.assertEqual(py[6][4]["home"]["notice"]["household"], "nassar")
        self.assertEqual(py[7][0]["labels"][:2], ["Rent Birch Court, flat 1B (flat) for $220/week",
                                                  "Keep looking for the right place"])
        self.assertEqual([py[7][1]["hh"]["home_id"], py[7][1]["home"]["notice"]["due"], py[7][1]["home"]["noticed"],
                          py[7][2]["hh"]["home_id"]], ["main_13", at(135, 9), at(121, 9), "birch_court_1b"])
        self.assertEqual([py[8][1], py[8][2]["home"]["notice"], py[8][3]["home"]["notice"]["due"]],
                         [["main_20", True], None, at(164, 9)])
        self.assertEqual(py[9][0]["labels"][:2], ["Look for somewhere else to rent",
                                                  "Keep looking for the right place"])
        self.assertEqual([py[9][1]["hh"]["home_id"], py[9][2]["hh"]["home_id"]], ["main_13", "birch_court_1b"])
        self.assertEqual((py[10][0]["home"]["listing"], py[10][1]["home"]["listing"]), (None, "for_sale"))
        self.assertEqual([py[11][1]["home"]["notice"], py[11][1]["home"]["noticed"], py[11][2]],
                         [{"household": "mizrahi", "since": at(120, 18, 30), "due": at(134, 9)}, at(120, 9),
                          ["main_13", True]])  # the drought stands
        self.assertIn("you have to move out by Day 135 Tue 09:00.", py[11][3]["question"])
        self.assertEqual(py[11][4]["home"]["listing"], "for_sale")
        self.assertEqual([py[12][0], py[12][1]["home"]["notice"]["due"], py[12][2]["home"]["listing"],
                          py[12][3]["home"]["listing"]], [True, at(137, 18, 30), None, "for_sale"])


if __name__ == "__main__":
    unittest.main()

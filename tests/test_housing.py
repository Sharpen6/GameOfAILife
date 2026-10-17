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
import random
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
        cohen, segal = sim.households["cohen"], sim.households["segal"]
        self.assertIn("river_28", [h.id for h in housing.hunt_candidates(sim, segal)])  # the Segals want it too
        price = housing._int(housing.value(sim, "river_28") * 0.9)
        opt = self.offer("dana")
        home = sim.homes["river_28"]
        self.assertEqual((home.held_for, home.under_offer_until), ("cohen", sim.clock.tick + housing.OFFER_HOLD_MINUTES))
        self.assertEqual((opt.steps, opt.outcomes), ([("viewing", "river_28")], ["the seller's answer"]))
        self.assertNotIn("river_28", [h.id for h in housing.vacancies(sim)])
        self.assertNotIn("river_28", [h.id for h in housing.hunt_candidates(sim, segal)])
        self.assertIsNone(housing.homes_json(sim)["river_28"]["listing"])  # under offer
        self.assertFalse(housing.move_household(sim, segal, "river_28", "buy"))
        self.assertEqual(sim.texts("too_late"), ["The Segals were too late: 28 River Road is under offer."])
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
        self.assertEqual(housing.afford_score(sim, dana, SimpleNamespace(cost=dana.money + 1)), -2.0)
        self.assertAlmostEqual(housing.afford_score(sim, dana, SimpleNamespace(cost=90)), -90 / dana.money * thrift)
        dana.money = 10
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
        self.assertEqual(labels(fork), [
            "Buy 28 River Road (house, neglected) for $14,550",
            "Offer $13,095 for 28 River Road and see what the seller says",
            "Keep looking for the right place",
            "Stay in 20 Main Street and keep the money"])
        buy, haggle, look, stay = fork.options
        self.assertEqual(fork.question, "Your household has $21,500 put by. You live in 20 Main Street (rented, "
                                        "$420/week). There are homes on the market you could afford. Do you move?")
        self.assertEqual(buy.extra, {"move": "river_28", "how": "buy"})
        self.assertEqual(buy.cost, 14550 + 150)
        self.assertEqual(haggle.cost, 14550 + 150 - 1455)
        for opt in (buy, haggle):
            self.assertTrue(opt.household_pays)
            self.assertFalse(opt.charge)
        self.assertEqual([o.group for o in haggle.outcomes], ["deal"] * 4)
        self.assertEqual(haggle.outcomes[0].effects, {"factor": 0.9, "buy": "river_28"})
        self.assertEqual(list(haggle.outcomes[1].effects), ["factor", "buy"])  # the companion comes first
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
        self.assertEqual(labels(fork)[0], "Buy 55 Main Street (house) for $18,100")
        self.assertEqual(labels(fork)[1], "Offer $16,290 for 55 Main Street and see what the seller says")
        self.assertEqual(labels(fork)[2], "Buy the cheaper 28 River Road (house, neglected) for $14,550")
        self.assertEqual(fork.options[2].extra, {"move": "river_28", "how": "buy"})

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
                                        "$31,900: more home than you need now that you are retired. Nothing better "
                                        "is on the market, but a smaller place is. Do you downsize?")
        buy, rent, look, stay = fork.options
        settle = housing_forks.DOWNSIZE_SETTLE
        self.assertEqual(buy.extra, {"move": "river_12", "how": "buy", "hh_cooldown": settle})
        self.assertEqual(rent.extra, {"move": "elm_court_1a", "how": "rent", "hh_cooldown": settle})
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
        sim = FakeSim(tick=at(10, 18, 30))
        ari = sim.agents["ari"]
        bendavid = sim.households["bendavid"]
        set_funds(sim, "bendavid", 25000)
        self.assertTrue(housing.move_household(sim, bendavid, "main_55", "buy"))
        set_funds(sim, "bendavid", 3000)
        sim.clock.tick = at(95, 18, 30)
        self.assertIsNone(housing_forks.house_hunt_fork(sim, ari))  # 95 days into the game, but 85 in the house
        bendavid.cooldowns.clear()
        sim.clock.tick = bendavid.moved_tick + housing_forks.DOWNSIZE_AFTER_DAYS * DAY  # a Wednesday, 18:30
        fork = self.check(housing_forks.house_hunt_fork(sim, ari), "house_hunt", True)
        self.assertIn("more home than you need with 4 bedrooms for just you.", fork.question)
        self.assertTrue(labels(fork)[0].endswith("buy the smaller 12 River Road for $11,550"), labels(fork))
        self.assertAlmostEqual(fork.options[0].base, housing_forks.DOWNSIZE_BASE)  # not retired: no lift
        scores = forks.default_scores(ari, fork, sim)
        self.assertEqual(scores.index(max(scores)), 2)  # Ari keeps looking for the right smaller place

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
        price = housing.value(sim, "river_28")
        sim._decide(dana, fork, 0, "model", "")
        self.assertEqual(cohen.home_id, "river_28")
        self.assertAlmostEqual(housing.funds(sim, cohen), funds - price - housing.MOVING_COST)
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
        self.assertEqual(fork.options[0].extra, {"move": "river_28", "how": "buy"})
        funds = housing.funds(sim, cohen)
        hide(sim, "river_28")  # another buyer has it under offer
        sim._decide(dana, fork, 0, "model", "")
        self.assertEqual(cohen.home_id, "main_20")
        self.assertAlmostEqual(housing.funds(sim, cohen), funds)
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
        park_78 = sim.homes["park_78"]
        self.assertEqual((park_78.owner, housing.listed(sim, park_78)), ("market", "for_sale"))
        self.assertIn(f"The Friedmans buy 12 River Road (house, {housing.district_name(sim, sim.homes['river_12'])}) "
                      f"for ${price:,}, selling 78 Park Avenue for ${sale:,}.", [e["text"] for e in sim.history])
        self.assertEqual(ruth.activity_place, "river_12")

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
        """house_hunt's downsizing variant on seeds 1-3, from a Friday morning past DOWNSIZE_AFTER_DAYS: the retired
        Friedmans and a single in a four-bedroom house, probed with the smaller homes on the market and without."""
        from gameofailife.sim import Simulation
        downsized = 0
        for seed in (1, 2, 3):
            with self.subTest(seed=seed):
                sim = Simulation(seed=seed, now=lambda: 0.0)
                sim.clock.tick = at(95, 6)
                single = next(hh for hh in sim.households.values() if housing.residents(sim, hh) == 1
                              and housing.adults(sim, hh) and not housing.retired(housing.adults(sim, hh)[0]))
                set_funds(sim, single.id, 25000)
                self.assertTrue(housing.move_household(sim, single, "main_55", "buy"))
                single.moved_tick = 0
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
    (port/src): every option, outcome and default score the same. The lockstep runs of tests/test_port.py are a
    few days long, too short to reach a downsizing or a fixer-upper's first evening."""

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
        else if (op === "build") {
          const agent = sim.agents.get(a[1]);
          const fork = G.housing_forks[a[0]](sim, agent);
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
            got = []
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
                elif op == "build":
                    agent = sim.agents[a[1]]
                    fork = getattr(housing_forks, a[0])(sim, agent)
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
            # by bedrooms: a single in a four-bedroom house, too soon and then settled in
            [["tick", at(10, 18, 30)], ["funds", "bendavid", 25000], ["move", "bendavid", "main_55", "buy"],
             ["funds", "bendavid", 3000], ["tick", at(95, 18, 30)], ["build", "house_hunt_fork", "ari"],
             ["tick", at(100, 18, 30)], ["build", "house_hunt_fork", "ari"]],
            # upkeep: a fixer-upper's first evening, and the weekend after
            [["tick", at(1, 18)], ["condition", "river_28", 20.0], ["move", "cohen", "river_28", "buy"],
             ["build", "upkeep_fork", "dana"], ["tick", at(5, 10)], ["build", "upkeep_fork", "yossi"]],
            # housing_trouble's downsize moves, for an owner and for a renter
            [["tick", monday], ["funds", "halabi", -500], ["arrears", "halabi", 2],
             ["build", "housing_trouble_fork", "shai"]],
            [["tick", monday], ["funds", "peretz", -800], ["arrears", "peretz", 1],
             ["build", "housing_trouble_fork", "eli"]],
            # the usual hunt, with a rental and a purchase
            [["tick", at(0, 18, 30)], ["build", "house_hunt_fork", "dana"], ["build", "house_hunt_fork", "sara"]],
        ]
        run = subprocess.run([NODE, "-e", self.JS, str(ROOT / "port" / "tools" / "engine.cjs")],
                             input=json.dumps(cases), capture_output=True, text=True, timeout=300, check=False)
        self.assertEqual(run.returncode, 0, run.stderr)
        js, py = json.loads(run.stdout), self.python(cases)
        self.assertEqual(len(js), len(py))
        for i, (got, want) in enumerate(zip(js, py)):
            self.assertEqual(got, want, f"case {i} differs (JS first)")
        variants = [r for case in py for r in case if isinstance(r, dict) and r["question"].endswith("downsize?")]
        self.assertEqual(len(variants), 5)  # the cases do reach the downsizing variant
        self.assertEqual([py[1][0]["options"][0]["label"], py[2][0]["options"][1]["label"]],
                         ["Talk it over and decide another time"] * 2)
        self.assertIsNone(py[3][0])  # nowhere smaller for the Friedmans: no fork
        self.assertAlmostEqual(py[4][0]["options"][0]["base"] - py[0][0]["options"][0]["base"],
                               2 * housing_forks.DOWNSIZE_DRIFT)
        self.assertIsNone(py[5][1])  # Ari, 85 days in
        self.assertEqual(py[6][1]["options"][0]["extra"]["repair"], 80)  # the fixer-upper's first evening

if __name__ == "__main__":
    unittest.main()

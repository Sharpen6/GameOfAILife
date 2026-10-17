"""The city-life fixes of the v2 final review (package F-city), on the real seed-1 city unless a test says otherwise.

F1 savings and the household pay for what cash can't (no money trap), F2 the sleep fork only for the tired, F3 no far
or shift-breaking errands and a travel cost in the scores, F4 a trip there and back the usual way (the car goes
where its owner drives it), F5 one fender bender a month in the news, F6 free play for children who can't pay and a
pull outdoors after a day in, F7 strolls across the whole park, F9 the world starts on Monday at 05:00, F10 a cafe
worker's cup at work never holds up the shift, F11 no fork offers the same thing twice.
"""

from __future__ import annotations

import json
import unittest
from unittest import mock

from gameofailife import forks, housing, sim as sim_module, travel
from gameofailife.agent import RelationKind
from gameofailife.clock import MINUTES_PER_DAY, Clock
from gameofailife.forks import Option, Outcome
from gameofailife.sim import ACTIVITIES, SHIFT_MARGIN, Simulation
from gameofailife.town import PARK, build_map

SEED = 1
MINE = ("invite_fork", "work_fork", "hunger_fork", "sleep_fork", "payday_fork", "groceries_fork", "lonely_fork",
        "free_time_fork")  # the builders this package owns (the housing builders are another's)
OUTINGS = ("hunger", "payday", "groceries", "lonely", "free_time")  # the forks that send people to cafes and shops
LOW_NEEDS = {"hunger": 20, "social": 20, "fun": 20, "energy": 10}


def at(sim: Simulation, day: int, minute: int) -> None:
    sim.clock.tick = day * MINUTES_PER_DAY + minute


def at_home(sim: Simulation, agent) -> None:
    """Idle at the front door of home, with nothing planned and the car on the driveway."""
    home = sim.home_of(agent)
    agent.inside, (agent.x, agent.y) = home, sim.town.places[home].entry
    agent.state, agent.plan, agent.activity, agent.fork_id, agent.path = "idle", [], "idle", None, []
    agent.vehicle, agent.speed, agent.car_at = "walk", 1, None


def step_one(sim: Simulation, agent, done, limit: int = 600) -> None:
    """Tick only this character (nobody else moves) until done(), with no new forks."""
    with mock.patch.object(sim_module, "build_fork", lambda sim, agent: None):
        for _ in range(limit):
            sim.clock.advance()
            sim._tick_agent(agent)
            if done():
                return
    raise AssertionError(f"{agent.id}: never happened in {limit} minutes")


def profile_pick(sim: Simulation, agent, fork) -> Option:
    scores = forks.default_scores(agent, fork, sim)
    return fork.options[scores.index(max(scores))]


# --- F1 ---------------------------------------------------------------------------------------------------------------

class MoneyTrapTest(unittest.TestCase):
    """Cash at $0 no longer makes every paid way to work cost the flat -2, so 'Call in sick' stops winning by habit."""

    def setUp(self):
        self.sim = Simulation(seed=SEED)

    def work_fork_at_home(self, agent):
        at(self.sim, min(agent.job.workdays), agent.job.start_hour * 60 - forks.WORK_LEAD)
        at_home(self.sim, agent)
        agent.worked_today = -1
        return forks.work_fork(self.sim, agent)

    def test_savings_pay_for_the_bus_to_work(self):
        ari = self.sim.agents["ari"]  # lives alone, 35 minutes' walk from the office: the bus is her usual way
        self.assertEqual(self.sim.usual_mode(ari), "bus")
        ari.money, ari.savings = 0.0, 500.0
        fork = self.work_fork_at_home(ari)
        self.assertEqual(fork.options[0].vehicle, "bus")
        self.assertFalse(profile_pick(self.sim, ari, fork).extra.get("skip_work"))
        self.assertGreater(min(forks.default_scores(ari, fork, self.sim)[:3]), -1.5)  # no flat -2 anywhere

    def test_a_partner_s_money_keeps_a_driver_in_debt_driving(self):
        dana, yossi = self.sim.agents["dana"], self.sim.agents["yossi"]
        dana.money, dana.savings, yossi.money = -200.0, 0.0, 5000.0
        fork = self.work_fork_at_home(dana)
        drive = fork.options[1]
        self.assertEqual((drive.vehicle, drive.cost), ("car", 2))
        self.assertGreater(housing.afford_score(self.sim, dana, drive), -0.1)  # the household's spare funds cover it
        self.assertFalse(profile_pick(self.sim, dana, fork).extra.get("skip_work"))

    def test_a_fare_paid_on_boarding_is_never_out_of_reach(self):
        ari = self.sim.agents["ari"]
        ari.money, ari.savings = -50.0, 0.0  # nothing of her own and nobody to fall back on
        thrift = ari.profile.traits["thrift"]
        bus = Option("bus", [("work", "job")], cost=2, vehicle="bus", charge=False)
        self.assertAlmostEqual(housing.afford_score(self.sim, ari, bus), -2 / 50 * thrift)
        self.assertEqual(housing.afford_score(self.sim, ari, Option("taxi", [("work", "job")], cost=12)), -2.0)
        fork = self.work_fork_at_home(ari)
        self.assertFalse(profile_pick(self.sim, ari, fork).extra.get("skip_work"))


# --- F2 ---------------------------------------------------------------------------------------------------------------

class SleepForkTest(unittest.TestCase):
    def setUp(self):
        self.sim = Simulation(seed=SEED)
        self.ben = self.sim.agents["ben"]  # the baker: 06:00, Monday to Saturday
        self.assertEqual(self.ben.job.start_hour, 6)

    def test_a_rested_early_worker_is_not_sent_back_to_bed(self):
        sim, ben = self.sim, self.ben
        at(sim, 1, 4 * 60 + 36)  # Tuesday: up for the 06:00 shift
        at_home(sim, ben)
        ben.needs["energy"] = 100
        self.assertIsNone(forks.sleep_fork(sim, ben))
        ben.needs["energy"] = 15  # exhausted, but the shift starts within two hours
        self.assertIsNone(forks.sleep_fork(sim, ben))
        ben.worked_today = sim.clock.day  # once the shift is done or called off, exhaustion asks again
        self.assertIsNotNone(forks.sleep_fork(sim, ben))

    def test_after_midnight_only_the_tired_are_asked(self):
        sim, ben = self.sim, self.ben
        at(sim, 6, 2 * 60)  # Sunday 02:00, no shift
        at_home(sim, ben)
        ben.needs["energy"] = 80
        self.assertIsNone(forks.sleep_fork(sim, ben))
        ben.needs["energy"] = 50
        self.assertIsNotNone(forks.sleep_fork(sim, ben))

    def test_not_within_two_hours_of_waking(self):
        sim, ben = self.sim, self.ben
        at(sim, 6, 23 * 60)  # Sunday 23:00: late enough for anyone
        at_home(sim, ben)
        ben.needs["energy"] = 90
        ben.woke_tick = sim.clock.tick - 60  # up from a long nap an hour ago
        self.assertIsNone(forks.sleep_fork(sim, ben))
        ben.woke_tick = sim.clock.tick - forks.WOKE_GAP
        self.assertIsNotNone(forks.sleep_fork(sim, ben))

    def test_waking_is_recorded(self):
        sim, ben = self.sim, self.ben
        at(sim, 6, 23 * 60)
        at_home(sim, ben)
        sim.start_plan(ben, [("sleep", "home")])
        self.assertEqual(ben.activity, "sleep")
        step_one(sim, ben, lambda: ben.activity != "sleep", limit=12 * 60)
        self.assertEqual(ben.woke_tick, sim.clock.tick)

    def test_no_sleep_fork_between_four_and_five_in_three_days(self):
        sim = Simulation(seed=SEED)
        seen = []
        build = sim_module.build_fork

        def on_build(sim, agent):
            fork = build(sim, agent)
            if fork is not None and fork.kind == "sleep" and 4 <= sim.clock.hour < 5:
                seen.append((sim.clock.stamp(), agent.id, round(agent.needs["energy"])))
            return fork

        with mock.patch.object(sim_module, "build_fork", on_build):
            sim.run_days(3)
        self.assertTrue(all(energy < 70 for _, _, energy in seen), seen)
        self.assertLessEqual(len(seen), 2, seen)  # 33 in 14 days before the fix, nearly all at energy 94-100


# --- F3 ---------------------------------------------------------------------------------------------------------------

class TravelCostTest(unittest.TestCase):
    def test_the_far_outing_loses_value_by_the_minute_and_twice_at_night(self):
        sim = Simulation(seed=SEED)
        ari = sim.agents["ari"]  # no car
        at(sim, 2, 12 * 60)
        at_home(sim, ari)
        cafes = sorted((p for p in sim.town.places.values() if p.kind == "cafe"),
                       key=lambda p: sim.walk_minutes(ari, p.id))
        near, far = cafes[0], cafes[-1]
        same = dict(tags={"social": 0.5}, gains={"fun": 20})
        opts = [Option("near", [("hang_out", near.id)], **same), Option("far", [("hang_out", far.id)], **same),
                Option("home", [("relax_home", "home")], **same), Option("here", [("read", None)], **same)]
        extra = [forks.extra_travel(sim, ari, o) for o in opts]
        self.assertEqual(extra[2:], [0, 0])  # home and here add no travel
        self.assertGreater(extra[1], extra[0])
        for minute, rate in ((12 * 60, forks.TRAVEL_COST), (21 * 60, forks.TRAVEL_COST * forks.NIGHT_TRAVEL)):
            at(sim, 2, minute)
            extra = [forks.extra_travel(sim, ari, o) for o in opts]
            outing = forks.default_scores(ari, forks.Fork(ari.id, "free_time", "?", opts, sim.clock.tick), sim)
            plain = forks.default_scores(ari, forks.Fork(ari.id, "test", "?", opts, sim.clock.tick), sim)
            self.assertEqual(plain[0], plain[1])  # outside the outing forks, distance is free
            cooped = forks.cooped_up(sim, ari)  # both cafes are out of the house alike
            for i in range(4):
                gain = cooped if i < 2 else 0.0
                self.assertAlmostEqual(outing[i], plain[i] - extra[i] * rate + gain, delta=0.0011)

    def test_errands_never_go_far_or_into_a_shift(self):
        """Every outing the builders offer on seeds 1 and 2 over two days (each probed every 150 minutes as well) is a
        trip of MAX_OUTING_MINUTES or less the way the character will go, and leaves time for any shift ahead."""
        bad = []

        def check(sim, agent, fork):
            if fork.kind not in OUTINGS:
                return
            start = sim._shift_start_tick(agent)
            for opt in fork.options:
                place_id = sim._resolve_place(agent, opt.steps[0][1]) if opt.steps else None
                place = sim.town.places.get(place_id or "")
                if place is None or place.kind not in ("cafe", "market", "shop") or agent.inside == place_id:
                    continue
                trip, mode = forks._trip(sim, agent, place_id)
                if trip > forks.MAX_OUTING_MINUTES:
                    bad.append((sim.clock.stamp(), agent.id, opt.label, trip, mode))
                if start is not None:
                    on = travel.leg_minutes(sim, place_id, agent.job.place_id, "car" if mode == "car" else "bus")
                    stay = ACTIVITIES[opt.steps[0][0]].minutes
                    if sim.clock.tick + trip + stay + on + SHIFT_MARGIN > start:
                        bad.append((sim.clock.stamp(), agent.id, opt.label, "into the shift"))

        for seed in (1, 2):
            sweep(seed, 2, check)
        self.assertEqual(bad, [])


# --- F4 ---------------------------------------------------------------------------------------------------------------

class RoundTripTest(unittest.TestCase):
    def setUp(self):
        self.sim = Simulation(seed=SEED)
        self.dana = self.sim.agents["dana"]  # owns a car; the office is 25 minutes' walk
        self.assertTrue(self.dana.owns_car)

    def drive_to_work(self):
        sim, dana = self.sim, self.dana
        at(sim, 0, 9 * 60 - forks.WORK_LEAD)
        at_home(sim, dana)
        dana.worked_today = -1
        fork = forks.work_fork(sim, dana)
        drive = next(i for i, o in enumerate(fork.options) if o.vehicle == "car")
        sim._decide(dana, fork, drive, "model", "")
        step_one(sim, dana, lambda: dana.activity == "work" and dana.state == "busy")
        self.assertEqual((dana.inside, dana.car_at), ("office", "office"))

    def test_a_driver_drives_home_after_a_free_time_fork_at_work(self):
        sim, dana = self.sim, self.dana
        self.drive_to_work()
        dana.state, dana.activity, dana.plan = "idle", "idle", []  # the shift is over
        dana.needs["fun"] = 20
        at(sim, 0, 17 * 60 + 5)
        fork = forks.free_time_fork(sim, dana)
        relax = next(i for i, o in enumerate(fork.options) if o.steps == [("relax_home", "home")])
        self.assertEqual(fork.options[relax].vehicle, travel.USUAL)
        msg = sim.fork_message(dana, fork)
        self.assertEqual(msg["options"][relax]["travel_minutes"],
                         travel.travel_minutes(sim, dana, sim.home_of(dana), "car"))
        sim._decide(dana, fork, relax, "model", "")
        self.assertEqual((dana.vehicle, dana.state), ("car", "travelling"))
        home = sim.home_of(dana)
        step_one(sim, dana, lambda: dana.inside == home)
        self.assertEqual((dana.vehicle, dana.car_at), ("walk", None))  # parked on the driveway

    def test_the_car_waits_where_it_was_left(self):
        sim, dana = self.sim, self.dana
        self.drive_to_work()
        park = sim.town.places["park"]
        dana.state, dana.activity, dana.plan = "idle", "idle", []
        sim.start_plan(dana, [("walk_park", park.id)], travel.USUAL)  # she drives there and parks at the gate
        self.assertEqual(dana.vehicle, "car")
        step_one(sim, dana, lambda: dana.activity == "walk_park" and dana.state == "busy")
        self.assertEqual((dana.vehicle, dana.car_at), ("walk", park.id))
        self.assertTrue(travel.car_here(sim, dana))  # strolling in the park she parked at
        step_one(sim, dana, lambda: dana.state == "travelling")  # done: home the usual way
        self.assertEqual(dana.vehicle, "car")
        # Leave the car at a cafe and walk home: it is not with her there, and comes home overnight.
        at_home(sim, dana)
        dana.car_at = "cafe"
        self.assertFalse(travel.car_here(sim, dana))
        self.assertNotEqual(travel.trip_mode(sim, dana, "hospital"), "car")
        at(sim, 1, MINUTES_PER_DAY - 1)
        sim.step()  # midnight
        self.assertIsNone(dana.car_at)
        self.assertTrue(travel.car_here(sim, dana))

    def test_trip_mode(self):
        sim, dana, ari = self.sim, self.dana, self.sim.agents["ari"]
        at(sim, 2, 12 * 60)
        for agent in (dana, ari):
            at_home(sim, agent)
        home = sim.home_of(dana)
        short = [p.id for p in sim.town.places.values()
                 if p.id != home and sim.walk_minutes(dana, p.id) <= travel.SHORT_WALK and not p.hours]
        long_ = [p.id for p in sim.town.places.values() if sim.walk_minutes(dana, p.id) > 20 and not p.hours]
        self.assertTrue(long_)
        for place_id in short:
            self.assertEqual(travel.trip_mode(sim, dana, place_id), "walk", place_id)  # the car stays on the drive
        self.assertEqual(travel.trip_mode(sim, dana, long_[0]), "car")
        self.assertEqual(travel.trip_mode(sim, dana, home), "walk")  # already there
        self.assertEqual(travel.trip_mode(sim, ari, ari.job.place_id), "bus")  # no car, a long walk, a bus saves time
        # A car can beat the walk to a place before it opens: then she walks, as the opening times were judged.
        market = sim.town.places["market"]
        walk = sim.walk_minutes(dana, market.id)
        at(sim, 2, market.hours[0] * 60 - walk + 1)
        self.assertEqual(travel.trip_mode(sim, dana, market.id), "walk")
        at(sim, 2, market.hours[0] * 60 + 30)
        self.assertEqual(travel.trip_mode(sim, dana, market.id), "car")

    def test_others_sent_on_an_errand_go_the_usual_way(self):
        sim, dana, yossi = self.sim, self.dana, self.sim.agents["yossi"]
        at(sim, 5, 10 * 60)  # Saturday
        for agent in (dana, yossi):
            at_home(sim, agent)
        yossi.state, yossi.activity, yossi.busy_until = "busy", "relax_home", sim.clock.tick + 60
        sim.household(dana).groceries = 1
        fork = forks.groceries_fork(sim, dana)
        ask = next(i for i, o in enumerate(fork.options) if "ask_shop" in o.extra)
        sim._decide(dana, fork, ask, "model", "")
        self.assertEqual(yossi.activity, "buy_groceries")
        self.assertTrue(yossi.usual_plan)
        self.assertEqual(yossi.vehicle, travel.trip_mode(sim, yossi, yossi.activity_place) if yossi.path else "walk")


# --- F5 ---------------------------------------------------------------------------------------------------------------

class FenderNewsTest(unittest.TestCase):
    def test_one_fender_bender_a_month_makes_the_news(self):
        sim = Simulation(seed=SEED)
        dana, omer = sim.agents["dana"], sim.agents["omer"]
        fender = Outcome("fender", "Minor fender bender", 0.02, -1, {"money": -150, "fun": -10})

        def crash(agent, day: int) -> dict:
            at(sim, day, 9 * 60)
            sim._apply_outcome(agent, {"fork": "f0", "outcome": fender})
            return sim.events[-1]

        before = dana.money
        first = crash(dana, 1)
        self.assertIn("fender bender", first["text"])
        self.assertGreaterEqual(first["importance"], 1)
        self.assertEqual(dana.money, before - 150)
        again = crash(dana, 10)
        self.assertEqual((again["importance"], again["tag"]), (0, first["tag"]))  # in the history, not the news
        self.assertNotIn(again, sim.news)
        self.assertEqual(dana.money, before - 2 * 150)  # the cost still lands
        self.assertGreaterEqual(crash(omer, 10)["importance"], 1)  # someone else's is news
        self.assertGreaterEqual(crash(dana, 31)["importance"], 1)  # a month after the first
        self.assertEqual(sim_module.NEWS_EVERY["fender"], 30 * MINUTES_PER_DAY)


# --- F6 ---------------------------------------------------------------------------------------------------------------

class KidsOutdoorsTest(unittest.TestCase):
    def setUp(self):
        self.sim = Simulation(seed=SEED)
        at(self.sim, 5, 10 * 60)  # Saturday morning
        self.ido = self.sim.agents["ido"]  # 17, $4
        self.assertFalse(self.ido.is_adult)
        at_home(self.sim, self.ido)
        self.ido.needs.update(LOW_NEEDS)

    def plays(self, fork):
        return [o for o in fork.options if o.steps and o.steps[0][0] == "play"]

    def test_a_child_short_of_the_cafe_gets_a_free_game_in_the_park(self):
        sim, ido = self.sim, self.ido
        ido.money, ido.savings = 3.0, 0.0
        for fork in (forks.free_time_fork(sim, ido), forks.lonely_fork(sim, ido)):
            labels = [o.label for o in fork.options]
            self.assertEqual(len(set(labels)), 4, labels)
            self.assertEqual([o.cost for o in fork.options if o.cost > 0], [], labels)  # nothing out of reach
            [play] = self.plays(fork)
            self.assertEqual(sim.town.places[play.steps[0][1]].kind, "park")
            self.assertNotIn("hang_out", [s[0] for o in fork.options for s in o.steps])
        ido.money = 10.0  # with the money for it, the cafe is back
        self.assertEqual(self.plays(forks.free_time_fork(sim, ido)), [])

    def test_a_play_invite_is_answered_with_a_game(self):
        sim, ido = self.sim, self.ido
        ido.money = 0.0
        friend = sim.agents["yoni"]  # 11
        ido.relate(friend.id, RelationKind.FRIEND, 60)
        friend.relate(ido.id, RelationKind.FRIEND, 60)
        at_home(sim, friend)
        fork = forks.free_time_fork(sim, ido)
        [play] = self.plays(fork)
        self.assertEqual(play.label, f"Ask Yoni to play in {sim.town.places[play.steps[0][1]].name}")
        self.assertEqual(play.extra["invite_to"], friend.id)
        sim._decide(ido, fork, fork.options.index(play), "model", "")
        invite = forks.invite_fork(sim, friend)
        self.assertEqual(invite.options[0].steps, [("play", play.steps[0][1])])
        step_one(sim, ido, lambda: ido.activity == "play" and ido.state == "busy")
        self.assertEqual(sim.pending_invite_for(friend)["status"], "pending")  # the host waits there, playing

    def test_a_day_indoors_pulls_them_outside(self):
        sim, ido = self.sim, self.ido
        for hours, want in ((6, 0.0), (12, 0.0), (18, forks.COOPED_UP / 2), (24, forks.COOPED_UP), (48, forks.COOPED_UP)):
            ido.out_tick = sim.clock.tick - hours * 60
            self.assertAlmostEqual(forks.cooped_up(sim, ido), want, msg=hours)
        fork = forks.free_time_fork(sim, ido)
        ido.out_tick = sim.clock.tick
        fresh = forks.default_scores(ido, fork, sim)
        ido.out_tick = sim.clock.tick - 30 * 60
        cooped = forks.default_scores(ido, fork, sim)
        home = sim.home_of(ido)
        for opt, a, b in zip(fork.options, fresh, cooped):
            out = any(sim._resolve_place(ido, w) not in (home, None) for _, w in opt.steps)
            self.assertAlmostEqual(b - a, forks.COOPED_UP if out else 0.0, delta=0.0011, msg=opt.label)
        ido.inside, ido.x, ido.y = None, ido.x + 1, ido.y  # out of the house: nothing to make up for
        self.assertEqual(forks.cooped_up(sim, ido), 0.0)

    def test_a_child_cooped_up_at_home_gets_restless_without_being_bored(self):
        sim, ido, dana = self.sim, self.ido, self.sim.agents["dana"]
        for agent in (ido, dana):
            at_home(sim, agent)
            agent.needs.update(LOW_NEEDS)
            agent.needs["fun"] = 80  # not bored
            agent.out_tick = sim.clock.tick - 6 * 60
        self.assertIsNone(forks.free_time_fork(sim, ido))  # out this morning: nothing to make up for
        for agent in (ido, dana):
            agent.out_tick = sim.clock.tick - 20 * 60
        self.assertGreater(forks.cooped_up(sim, ido), 0.0)
        fork = forks.free_time_fork(sim, ido)
        self.assertEqual(len(fork.options), 4)
        self.assertIsNone(forks.free_time_fork(sim, dana))  # an adult who isn't bored stays put
        at(sim, 5, 21 * 60)
        self.assertIsNone(forks.free_time_fork(sim, ido))  # not in the evening


# --- F7 ---------------------------------------------------------------------------------------------------------------

class ParkStrollTest(unittest.TestCase):
    def test_a_long_stroll_crosses_the_park_and_ends_at_its_gate(self):
        sim = Simulation(seed=SEED)
        park = sim.town.places["park"]  # Riverside Park, x 17 to 41, gate at the west end
        agent = sim.agents["ari"]
        at(sim, 6, 9 * 60)  # Sunday: no shift to cut it short
        at_home(sim, agent)
        agent.inside, (agent.x, agent.y) = None, park.entry
        sim.start_plan(agent, [("walk_park", park.id)], "walk")
        self.assertEqual((agent.activity, agent.state), ("walk_park", "busy"))
        agent.busy_until = sim.clock.tick + 600
        seen, last = set(), None
        with mock.patch.object(sim_module, "build_fork", lambda sim, agent: None):
            while agent.activity == "walk_park":
                last = (agent.x, agent.y)
                seen.add(last)
                sim.clock.advance()
                sim._tick_agent(agent)
        for x, y in seen:
            self.assertTrue(park.x <= x < park.x + park.w and park.y <= y < park.y + park.h and sim.town.walkable(x, y))
        self.assertGreater(len(seen), 60)
        self.assertGreaterEqual(max(x for x, _ in seen), 33)  # the east half too (before: never past x 34 in 180 days)
        self.assertLessEqual(abs(last[0] - park.entry[0]) + abs(last[1] - park.entry[1]), 2)  # walked back to the gate
        self.assertEqual((agent.x, agent.y), tuple(park.entry))
        lawns = sim._lawns_of(park)
        self.assertTrue(lawns and all(sim.town.tiles[y][x] == PARK for x, y in lawns))


# --- F9 ---------------------------------------------------------------------------------------------------------------

class StartTimeTest(unittest.TestCase):
    def test_the_world_starts_on_monday_at_0500(self):
        self.assertEqual(Clock().tick, 5 * 60)
        sim = Simulation(seed=SEED)
        self.assertEqual(sim.clock.stamp(), "Day 1 Mon 05:00")

    def test_nobody_calls_in_sick_on_the_first_morning(self):
        """Before, the world started at 06:00 as the earliest shifts began, and their workers called in sick at 06:01."""
        sick = []
        for seed in range(1, 7):
            build_map(seed).warm()
            sim = Simulation(seed=seed)
            decide = Simulation._decide

            def on_decide(sim, agent, fork, choice, by, *args, **kwargs):
                if fork.kind == "work" and fork.options[choice].extra.get("skip_work"):
                    sick.append((seed, sim.clock.stamp(), agent.id, by))
                return decide(sim, agent, fork, choice, by, *args, **kwargs)

            with mock.patch.object(Simulation, "_decide", on_decide):
                for _ in range(4 * 60):  # to 09:00
                    sim.step()
        self.assertEqual(sick, [])


# --- F10 --------------------------------------------------------------------------------------------------------------

class OwnCafeCoffeeTest(unittest.TestCase):
    def setUp(self):
        self.sim = Simulation(seed=SEED)
        self.tom = self.sim.agents["tom"]  # Corner Cafe's barista, at 07:00
        self.assertEqual((self.tom.job.place_id, self.tom.job.start_hour), ("cafe", 7))

    def coffee_fork(self, minute: int):
        sim, tom = self.sim, self.tom
        at(sim, min(tom.job.workdays), minute)
        at_home(sim, tom)
        tom.worked_today = -1
        fork = forks.work_fork(sim, tom)
        self.assertEqual(fork.options[2].steps, [("coffee", "cafe"), ("work", "job")])
        return fork

    def test_a_cup_at_work_starts_the_shift_on_time(self):
        sim, tom = self.sim, self.tom
        walk = sim.walk_minutes(tom, "cafe")
        fork = self.coffee_fork(7 * 60 - walk - SHIFT_MARGIN)  # when he must set off
        coffee = fork.options[2]
        self.assertEqual(coffee.base, 0.35)  # the cup itself makes him no later
        self.assertEqual({o.id: o.p for o in coffee.outcomes}["late"], forks.COFFEE_LATE)
        sim._decide(tom, fork, 2, "model", "")
        step_one(sim, tom, lambda: tom.activity == "coffee" and tom.state == "busy")
        self.assertEqual(tom.busy_until, sim.clock.tick - sim.clock.minute_of_day + 7 * 60)  # drunk by 07:00
        step_one(sim, tom, lambda: tom.activity == "work" and tom.state == "busy")
        self.assertEqual(sim.clock.minute_of_day, 7 * 60)

    def test_running_late_the_cup_takes_no_time(self):
        sim, tom = self.sim, self.tom
        walk = sim.walk_minutes(tom, "cafe")
        fork = self.coffee_fork(7 * 60 - walk + 5)  # he can only get there 5 minutes late
        late_by = walk - (7 * 60 - sim.clock.minute_of_day)
        self.assertEqual(fork.options[2].base, round(0.35 - late_by / forks.LATE_BASE_DROP, 3))  # the walk's lateness only
        sim._decide(tom, fork, 2, "model", "")
        step_one(sim, tom, lambda: tom.activity == "work" and tom.state == "busy")
        self.assertEqual(sim.clock.minute_of_day, 7 * 60 + late_by)  # straight to work on arrival


# --- F11 --------------------------------------------------------------------------------------------------------------

def signature(sim: Simulation, agent, opt: Option) -> tuple:
    """What choosing an option does: its steps (places resolved, "here" as where the character is), how it travels,
    what it costs and its side effects."""
    steps = tuple((act, sim._resolve_place(agent, where) or agent.inside) for act, where in opt.steps)
    return steps, opt.vehicle, opt.cost, opt.household_pays, json.dumps(opt.extra, sort_keys=True, default=str)


def sweep(seed: int, days: int, check) -> None:
    """Run a city for `days` with default plays, calling check(sim, agent, fork) on every fork built and, every 150
    minutes, on each of this package's builders for everyone as they are but hungry, lonely, bored, tired, with an
    empty fridge, the day's shift still ahead and (for payday) on a Friday."""
    sim = Simulation(seed=seed)
    build = sim_module.build_fork

    def on_build(sim, agent):
        fork = build(sim, agent)
        if fork is not None:
            check(sim, agent, fork)
        return fork

    with mock.patch.object(sim_module, "build_fork", on_build):
        for t in range(days * MINUTES_PER_DAY):
            sim.step()
            sim.drain()
            if t % 150:
                continue
            for agent in sim.living():
                hh = sim.household(agent)
                keep = dict(agent.needs), hh.groceries, agent.worked_today, agent.last_payday, sim.clock.tick
                agent.needs.update(LOW_NEEDS)
                hh.groceries, agent.worked_today = 0, -1
                for name in MINE:
                    if name == "payday_fork":
                        at(sim, 4, sim.clock.minute_of_day)
                    fork = getattr(forks, name)(sim, agent)
                    if fork is not None:
                        check(sim, agent, fork)
                    sim.clock.tick = keep[4]
                agent.needs.clear()
                agent.needs.update(keep[0])
                hh.groceries, agent.worked_today, agent.last_payday = keep[1:4]


class DistinctOptionsTest(unittest.TestCase):
    def test_no_fork_offers_the_same_thing_twice(self):
        """Seeds 1, 2 and 5 for two days each: no two options of a fork share their steps, vehicle, cost and effects
        (before: 'Ask a neighbour for help' was 'Leave it for tomorrow', the board game was 'Relax at home')."""
        dups, kinds = [], set()

        def check(sim, agent, fork):
            if fork.kind not in {name.removesuffix("_fork") for name in MINE}:
                return
            kinds.add(fork.kind)
            sigs = [signature(sim, agent, o) for o in fork.options]
            if len(set(sigs)) < len(sigs):
                dups.append((sim.clock.stamp(), agent.id, fork.kind, [o.label for o in fork.options]))

        for seed in (1, 2, 5):
            sweep(seed, 2, check)
        self.assertEqual(dups, [])
        self.assertEqual(kinds, {name.removesuffix("_fork") for name in MINE})

    def test_the_fallbacks_are_their_own_activities(self):
        sim = Simulation(seed=SEED)
        alone = next(a for a in sim.living() if a.is_adult and len(sim.household(a).member_ids) == 1)
        at(sim, 2, 12 * 60)
        at_home(sim, alone)
        alone.money = 500.0
        sim.household(alone).groceries = 0
        fork = forks.groceries_fork(sim, alone)
        labels = [o.label for o in fork.options]
        self.assertIn("Make do with what's in the cupboard", labels)
        self.assertNotIn("Ask a neighbour for help", labels)
        self.assertEqual(fork.options[labels.index("Make do with what's in the cupboard")].steps,
                         [("leftovers", "home")])
        with mock.patch.object(Simulation, "nearest", lambda *args, **kwargs: None):  # every cafe shut
            alone.needs.update(LOW_NEEDS)
            board = next(o for o in forks.free_time_fork(sim, alone).options if o.label == "Play a board game at home")
            raid = next(o for o in forks.hunger_fork(sim, alone).options if o.label == "Raid the cupboard for leftovers")
        self.assertEqual((board.steps, raid.steps), ([("board_game", "home")], [("leftovers", "home")]))
        self.assertIn("board_game", sim_module.LEISURE)
        self.assertNotEqual(ACTIVITIES["board_game"].gains, ACTIVITIES["relax_home"].gains)


if __name__ == "__main__":
    unittest.main()

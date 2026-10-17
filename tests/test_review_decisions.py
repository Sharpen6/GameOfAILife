"""Regression tests for review findings in the decision, answer, invite, message and profile paths."""

from __future__ import annotations

import json
import unittest
from unittest import mock

from gameofailife import sim as sim_module
from gameofailife.clock import MINUTES_PER_DAY
from gameofailife.forks import Fork, Option, Outcome, build_fork, groceries_fork, hunger_fork, invite_fork, payday_fork, work_fork
from gameofailife.server import GameServer
from gameofailife.sim import ANSWER_SECONDS, GROCERY_COST, SHIFT_MARGIN, Simulation


class FakeClock:
    def __init__(self, t: float = 1000.0):
        self.t = t

    def __call__(self) -> float:
        return self.t

    def advance(self, seconds: float) -> None:
        self.t += seconds


def close_fork(agent_id: str, tick: int, outcomes: list | None = None) -> Fork:
    """Four options with identical scores for neutral traits, so the Director asks."""
    opts = [Option(label, [("idle", None)], tags={tag: 1.0}, outcomes=list(outcomes or []) if i == 0 else [])
            for i, (label, tag) in enumerate((("Option A", "social"), ("Option B", "thrift"),
                                               ("Option C", "health"), ("Option D", "adventure")))]
    return Fork(agent_id, "test", "What do you do?", opts, tick)


def always_ask():
    """Make every fork close enough that the Director asks the controller."""
    return mock.patch.object(sim_module, "OBVIOUS_MARGIN", 99.0)


class Case(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.sim = Simulation(seed=1, now=self.clock)

    def at(self, day: int, hour: int, minute: int = 0) -> None:
        self.sim.clock.tick = day * MINUTES_PER_DAY + hour * 60 + minute

    def ask(self, agent_id: str = "dana", outcomes: list | None = None) -> Fork:
        agent = self.sim.agents[agent_id]
        for t in agent.profile.traits:
            agent.profile.traits[t] = 0.5
        agent.controller = "bot"
        fork = close_fork(agent.id, self.sim.clock.tick, outcomes)
        self.sim.director(agent, fork)
        self.assertEqual(fork.status, "asked")
        return fork

    def step_until(self, done, limit: int = 300) -> None:
        for _ in range(limit):
            if done():
                return
            self.sim.step()
        self.fail("condition never came true")

    def leave_tick(self, agent_id: str) -> int:
        agent = self.sim.agents[agent_id]
        return self.sim._shift_start_tick(agent) - self.sim.walk_minutes(agent, agent.job.place_id) - SHIFT_MARGIN


class TestChoiceHappensAtLeaveTime(Case):
    """Finding 0: a choice made once it's time to leave for work is still carried out."""

    def test_answer_after_leave_time_still_goes_shopping(self):
        sami = self.sim.agents["sami"]
        self.at(5, 10)  # Saturday; his chef shift starts at 11:00
        sami.controller = "bot"
        fork = payday_fork(self.sim, sami)
        with always_ask():
            self.sim.director(sami, fork)
        self.assertEqual(fork.status, "asked")
        self.at(5, 10, 38)  # the game ran on while the controller thought
        self.assertTrue(self.sim._must_leave_for_work(sami))
        self.clock.advance(4)
        self.assertEqual(self.sim.answer(fork.id, 2, controller="bot"), {"accepted": True, "applied": True})
        sami.controller = None  # the work fork afterwards plays by habit
        self.assertEqual(fork.options[2].label, "Buy something nice for yourself")
        self.assertEqual(sami.money, 340)
        self.assertEqual(sami.activity, "shopping")
        self.step_until(lambda: sami.state == "busy" and sami.activity == "shopping")
        self.assertEqual(sami.inside, "market")
        self.step_until(lambda: sami.activity != "shopping")
        self.assertNotEqual(sami.activity, "relax_home")  # the rest of the plan gives way to work
        self.assertEqual(sami.forks[-1]["kind"], "work")

    def test_meal_chosen_at_leave_time_is_eaten(self):
        avi = self.sim.agents["avi"]
        self.at(0, 7, 52)  # Monday; school starts at 08:00
        self.assertTrue(self.sim._must_leave_for_work(avi))
        avi.needs["hunger"] = 16.6
        fork = hunger_fork(self.sim, avi)
        self.assertEqual(fork.options[1].label, "Eat at Corner Cafe")
        self.sim._decide(avi, fork, 1, "model", "")
        self.assertEqual(avi.money, 700 - 14)
        self.assertEqual(avi.activity, "eat_out")
        self.step_until(lambda: avi.activity not in ("eat_out", "idle"))
        self.assertGreater(avi.needs["hunger"], 60)

    def test_invite_is_not_accepted_at_leave_time(self):
        ari, tom = self.sim.agents["ari"], self.sim.agents["tom"]
        self.at(0, 9)
        self.sim.clock.tick = self.leave_tick("ari")
        inv = self.sim.invite(tom, "ari", "cafe")
        self.assertIsNone(invite_fork(self.sim, ari))
        self.assertEqual(build_fork(self.sim, ari).kind, "work")
        self.sim._next(ari)
        self.assertEqual(ari.forks[-1]["kind"], "work")
        self.assertEqual(inv["status"], "pending")  # it waits (or expires) while Ari is at work
        self.assertNotIn(("hang_out", "cafe"), tom.plan)

    def test_invite_offered_while_there_is_time(self):
        ari, tom = self.sim.agents["ari"], self.sim.agents["tom"]
        self.at(0, 8)
        self.sim.invite(tom, "ari", "cafe")
        self.assertEqual(build_fork(self.sim, ari).kind, "invite")

    def test_work_fork_and_calling_in_sick_unchanged_at_leave_time(self):
        ari = self.sim.agents["ari"]
        self.at(0, 9)
        self.sim.clock.tick = self.leave_tick("ari")
        self.sim._decide(ari, work_fork(self.sim, ari), 0, "model", "")
        self.assertEqual((ari.activity, ari.state), ("work", "travelling"))

        sim = self.sim = Simulation(seed=1, now=self.clock)
        ari = sim.agents["ari"]
        self.at(0, 9)
        sim.clock.tick = self.leave_tick("ari")
        fork = work_fork(sim, ari)
        self.assertIn("sick", fork.options[3].label)
        sim._decide(ari, fork, 3, "model", "")
        self.assertEqual((ari.activity, ari.state), ("rest", "busy"))
        self.assertEqual(ari.busy_until - sim.clock.tick, 240)  # a full rest, not cut short


class TestAskPartnerToShop(Case):
    """Finding 2: the groceries someone else buys for you are paid for."""

    def setUp(self):
        super().setUp()
        self.dana, self.yossi = self.sim.agents["dana"], self.sim.agents["yossi"]
        self.home = self.sim.household(self.dana)
        self.home.groceries = 1
        for m in self.home.member_ids:
            self.sim.agents[m].needs["hunger"] = 100.0  # nobody eats the shopping while we watch

    def relaxing(self, agent) -> None:
        agent.state, agent.activity, agent.busy_until = "busy", "relax_home", self.sim.clock.tick + 60

    def ask_yossi(self) -> None:
        fork = groceries_fork(self.sim, self.dana)
        self.assertEqual(fork.options[2].label, "Ask Yossi to do the shopping")
        self.sim._decide(self.dana, fork, 2, "model", "")

    def test_shopper_pays_and_shops(self):
        self.at(5, 10)
        self.relaxing(self.yossi)
        self.ask_yossi()
        self.assertEqual(self.yossi.money, 600 - GROCERY_COST)
        self.assertEqual(self.dana.money, 900)
        self.assertEqual(GROCERY_COST, 35)  # the same as 'Buy groceries now'
        self.assertEqual(self.yossi.activity, "buy_groceries")
        self.step_until(lambda: self.yossi.state == "busy" and self.yossi.activity == "buy_groceries")
        self.step_until(lambda: self.yossi.activity != "buy_groceries")
        self.assertEqual(self.home.groceries, 11)

    def test_asker_pays_when_shopper_cannot(self):
        self.at(5, 10)
        self.relaxing(self.yossi)
        self.yossi.money = 10.0
        self.ask_yossi()
        self.assertEqual(self.yossi.money, 10.0)
        self.assertEqual(self.dana.money, 900 - GROCERY_COST)
        self.assertEqual(self.yossi.activity, "buy_groceries")

    def test_partner_due_at_work_is_not_sent_or_charged(self):
        self.at(0, 6, 40)  # Monday; Yossi's 07:00 shift at the hospital is too close for a detour
        self.relaxing(self.yossi)
        self.assertTrue(self.sim._must_leave_for_work(self.yossi, "market"))
        self.ask_yossi()
        self.assertEqual((self.dana.money, self.yossi.money), (900, 600))
        self.assertNotEqual(self.yossi.activity, "buy_groceries")
        self.assertFalse(any("heads to Fresh Market" in e["text"] for e in self.sim.events))


class TestSavingsWithoutGoal(Case):
    """Finding 3: 'Put $X toward savings' with no goal moves real money where players can see it."""

    def test_money_moves_into_savings(self):
        dana = self.sim.agents["dana"]
        self.at(4, 18)
        fork = payday_fork(self.sim, dana)
        self.assertIsNone(dana.goal)
        self.assertEqual(fork.options[0].label, "Put $100 toward savings")
        self.sim._decide(dana, fork, 0, "model", "")
        self.assertEqual(dana.money, 800)
        self.assertEqual(dana.savings, 100)
        possessions = self.sim.agent_json("dana")["possessions"]
        self.assertEqual((possessions["money"], possessions["savings"]), (800, 100))
        self.assertTrue(any("puts $100 into savings" in e["text"] for e in self.sim.events))

    def test_goal_saving_unchanged(self):
        ari = self.sim.agents["ari"]
        self.at(4, 18)
        fork = payday_fork(self.sim, ari)
        self.sim._decide(ari, fork, 0, "model", "")
        self.assertEqual(ari.goal["saved"], 100)
        self.assertEqual(ari.money, 312)
        self.assertEqual(ari.savings, 0)


class TestDeadCharactersDoNotAct(Case):
    """Findings 5, 14, 21: the dead cannot invite, their invites lapse and their forks can't be answered."""

    def test_dead_host_cannot_invite(self):
        tom, ari = self.sim.agents["tom"], self.sim.agents["ari"]
        self.at(5, 11)
        self.sim._die(tom, "collapsed and could not be saved")
        inbox = list(ari.inbox)
        self.assertIsNone(self.sim.invite(tom, "ari", "cafe"))
        self.assertEqual(self.sim.invites, {})
        self.assertEqual(ari.inbox, inbox)
        self.assertIsNone(invite_fork(self.sim, ari))

    def test_dead_character_controller_cannot_invite_through_the_server(self):
        tom = self.sim.agents["tom"]
        tom.controller = "bot"
        self.sim._die(tom, "collapsed and could not be saved")
        reply = GameServer(self.sim)._controller("bot", {"type": "invite", "agent_id": "tom", "to": "ari"})
        self.assertEqual(reply, {"type": "invited", "ok": False, "invite": None})
        self.assertFalse(any("invites" in e["text"] for e in self.sim.events))

    def test_pending_invite_lapses_when_host_dies(self):
        tom, ari = self.sim.agents["tom"], self.sim.agents["ari"]
        self.at(5, 11)
        inv = self.sim.invite(tom, "ari", "cafe")
        self.sim._die(tom, "collapsed and could not be saved")
        self.assertEqual(inv["status"], "expired")
        self.assertIsNone(invite_fork(self.sim, ari))
        for _ in range(60):
            self.sim.step()
        self.assertFalse(any(f["kind"] == "invite" for f in ari.forks))

    def test_open_fork_cannot_be_answered_after_death(self):
        fork = self.ask()
        dana = self.sim.agents["dana"]
        traits = dict(dana.profile.traits)
        self.sim._die(dana, "collapsed and could not be saved")
        self.assertNotEqual(fork.status, "asked")
        self.clock.advance(1)
        self.assertEqual(self.sim.answer(fork.id, 1, controller="bot"),
                         {"accepted": False, "error": "character is dead"})
        self.assertEqual(dana.profile.learned, [])
        self.assertEqual(dana.profile.traits, traits)
        self.clock.advance(ANSWER_SECONDS)
        self.sim._check_timeouts()
        self.assertIsNone(fork.decided_by)  # nothing is played for the dead
        self.assertFalse(any(f["id"] == fork.id for f in self.sim.fork_log))

    def test_late_answer_refused_after_death(self):
        fork = self.ask()
        dana = self.sim.agents["dana"]
        self.clock.advance(ANSWER_SECONDS + 0.1)
        self.sim._check_timeouts()
        self.assertEqual(fork.decided_by, "timeout")
        self.sim._die(dana, "collapsed and could not be saved")
        self.clock.advance(1)
        self.assertEqual(self.sim.answer(fork.id, 1, controller="bot"),
                         {"accepted": False, "error": "character is dead"})
        self.assertEqual(dana.profile.learned, [])


class TestNoSelfInvitesOrMessages(Case):
    """Findings 6, 15: a character can't invite or text themselves."""

    def test_cannot_invite_yourself(self):
        dana = self.sim.agents["dana"]
        self.at(5, 10)
        inbox = list(dana.inbox)
        self.assertIsNone(self.sim.invite(dana, "dana", "cafe"))
        self.assertEqual(self.sim.invites, {})
        self.assertEqual(dana.inbox, inbox)
        self.assertIsNone(invite_fork(self.sim, dana))

    def test_cannot_message_yourself(self):
        dana = self.sim.agents["dana"]
        social, inbox = dana.needs["social"], list(dana.inbox)
        self.assertEqual(self.sim.send_message("dana", "dana", "hi me"),
                         {"ok": False, "error": "can't message yourself"})
        self.assertEqual(dana.needs["social"], social)
        self.assertEqual(dana.inbox, inbox)
        self.assertFalse(any(e["kind"] == "message" for e in self.sim.events))

    def test_server_refuses_both(self):
        self.sim.agents["ari"].controller = "bot"
        server = GameServer(self.sim)
        self.assertEqual(server._controller("bot", {"type": "send_message", "agent_id": "ari", "to": "ari", "text": "x"}),
                         {"type": "sent", "ok": False, "error": "can't message yourself"})
        self.assertEqual(server._controller("bot", {"type": "invite", "agent_id": "ari", "to": "ari"}),
                         {"type": "invited", "ok": False, "invite": None})


class TestOneLateAnswer(Case):
    """Finding 7: in the late window only the first answer counts and teaches."""

    def test_repeated_late_answers_rejected(self):
        fork = self.ask()
        dana = self.sim.agents["dana"]
        self.clock.advance(ANSWER_SECONDS + 0.1)
        self.sim._check_timeouts()
        late = (fork.choice + 1) % 4
        tag = next(iter(fork.options[late].tags))
        self.clock.advance(1)
        self.assertTrue(self.sim.answer(fork.id, late, "first", controller="bot")["accepted"])
        for _ in range(5):
            self.assertEqual(self.sim.answer(fork.id, late, "again", controller="bot"),
                             {"accepted": False, "error": "too late"})
        self.assertEqual(dana.profile.traits[tag], 0.54)  # moved once: 0.5 + 0.04
        self.assertEqual(len(dana.profile.learned), 1)
        self.assertEqual(fork.late_answer, {"choice": late, "reason": "first"})


class TestLeaveTimeCountsTheDetour(Case):
    """Finding 8: a plan step that walks away from work is dropped if the detour would make them late."""

    def test_rina_goes_straight_to_the_hospital(self):
        rina = self.sim.agents["rina"]
        self.at(7, 7, 37)  # Monday; her shift starts at 08:00
        market = self.sim.town.places["market"]
        rina.x, rina.y = market.entry
        rina.inside = "market"
        rina.plan = [("relax_home", "home")]
        self.assertFalse(self.sim._must_leave_for_work(rina))
        self.assertTrue(self.sim._must_leave_for_work(rina, "home"))
        rina.controller = "bot"
        with always_ask():
            self.sim._next(rina)
        fork = self.sim.forks[rina.fork_id]
        self.assertEqual(fork.kind, "work")
        self.assertEqual(self.sim.answer(fork.id, 0, controller="bot"), {"accepted": True, "applied": True})
        seen = set()

        def at_work() -> bool:
            seen.add(rina.activity)
            return rina.activity == "work" and rina.state == "busy"

        self.step_until(at_work)
        self.assertNotIn("relax_home", seen)
        self.assertEqual(rina.work_started % MINUTES_PER_DAY, 8 * 60)  # paid from the shift start


class TestSetProfileIsAtomic(Case):
    """Finding 20: a bad trait value changes nothing."""

    def test_bad_trait_leaves_profile_untouched(self):
        dana = self.sim.agents["dana"]
        traits, prompt = dict(dana.profile.traits), dana.profile.prompt
        with self.assertRaises(ValueError):
            self.sim.set_profile("dana", prompt="New prompt", traits={"thrift": 0.0, "social": "lots"})
        self.assertEqual(dana.profile.traits, traits)
        self.assertEqual(dana.profile.prompt, prompt)
        self.assertFalse(dana.profile.prompt_edited)

    def test_good_traits_still_apply(self):
        dana = self.sim.agents["dana"]
        self.assertTrue(self.sim.set_profile("dana", traits={"thrift": 0.0, "social": "0.9"}))
        self.assertEqual((dana.profile.traits["thrift"], dana.profile.traits["social"]), (0.0, 0.9))
        self.assertEqual(dana.profile.prompt, dana.profile.describe(dana))


class TestForkSentAgainWithOutcomes(Case):
    """Findings 23, 29: once outcomes land, the fork is sent again with the same id and its 'happened'."""

    OUTCOMES = [Outcome("one", "First thing", 1.0, 0, {"fun": -1}), Outcome("two", "Second thing", 1.0, 0, {"fun": -1})]

    def test_resent_after_outcomes_land(self):
        fork = self.ask(outcomes=self.OUTCOMES)
        self.sim.answer(fork.id, 0, controller="bot")
        first = json.loads(json.dumps(self.sim.drain()[1]))  # as the server serializes the frame
        self.assertEqual([(f["id"], f["happened"]) for f in first], [(fork.id, [])])
        for _ in range(25):  # the idle step lasts 20 minutes
            self.sim.step()
        again = [f for f in json.loads(json.dumps(self.sim.drain()[1])) if f["id"] == fork.id]
        self.assertEqual(len(again), 1)
        self.assertEqual(again[0]["happened"], ["First thing", "Second thing"])
        self.assertEqual(again[0]["choice"], 0)
        self.sim.step()
        self.assertFalse(any(f["id"] == fork.id for f in self.sim.drain()[1]))

    def test_listed_once_when_decided_and_landed_in_one_frame(self):
        fork = self.ask(outcomes=self.OUTCOMES)
        self.sim.answer(fork.id, 0, controller="bot")
        for _ in range(25):
            self.sim.step()
        logged = [f for f in self.sim.drain()[1] if f["id"] == fork.id]
        self.assertEqual(len(logged), 1)
        self.assertEqual(logged[0]["happened"], ["First thing", "Second thing"])


class TestOldAgeOdds(Case):
    """Finding 54: the comment's odds match the code."""

    def test_monthly_odds_at_74_and_80(self):
        for age, monthly in ((74, 0.0075), (80, 0.036)):
            sim = Simulation(seed=1)
            sim.agents["david"].age = age
            odds = {}

            def record(agent, what, p, roll, base=None):
                odds[agent.id, what] = p  # the unrounded daily chance

            with mock.patch.object(sim, "_log_roll", record):
                sim._new_day()
            self.assertAlmostEqual(1 - (1 - odds["david", "old_age"]) ** 30, monthly, delta=0.001)


if __name__ == "__main__":
    unittest.main()

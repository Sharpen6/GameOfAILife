"""Tests for the Decision Director: habit, asking, answer windows, learning and hidden luck."""

from __future__ import annotations

import unittest

from gameofailife.forks import Fork, Option, Outcome
from gameofailife.sim import ANSWER_SECONDS, LEARN_SECONDS, Simulation

HIDDEN_KEYS = {"p", "base_p", "roll"}


class FakeClock:
    def __init__(self, t: float = 1000.0):
        self.t = t

    def __call__(self) -> float:
        return self.t

    def advance(self, seconds: float) -> None:
        self.t += seconds


def option(label: str, base: float = 0.0, tags: dict | None = None, outcomes: list | None = None) -> Option:
    return Option(label, [("idle", None)], base=base, tags=tags or {}, outcomes=outcomes or [])


def close_fork(agent_id: str, tick: int, outcomes: list | None = None) -> Fork:
    """Four options with identical scores: never obvious, so the Director must ask or play the default."""
    opts = [option("Option A", tags={"social": 1.0}, outcomes=outcomes),
            option("Option B", tags={"thrift": 1.0}),
            option("Option C", tags={"health": 1.0}),
            option("Option D", tags={"adventure": 1.0})]
    return Fork(agent_id, "test", "What do you do?", opts, tick)


def obvious_fork(agent_id: str, tick: int) -> Fork:
    opts = [option("Clearly best", base=2.0), option("Meh"), option("Meh too"), option("Also meh")]
    return Fork(agent_id, "test", "An easy one?", opts, tick)


def find_keys(obj, keys: set[str], path: str = "") -> list[str]:
    """Every path in a JSON-like structure whose dict key is one of `keys`."""
    found = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in keys:
                found.append(f"{path}.{k}")
            found += find_keys(v, keys, f"{path}.{k}")
    elif isinstance(obj, (list, tuple)):
        for i, v in enumerate(obj):
            found += find_keys(v, keys, f"{path}[{i}]")
    return found


class DirectorTestCase(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.sim = Simulation(seed=7, now=self.clock)
        self.agent = next(iter(self.sim.agents.values()))
        # Neutral traits so tags don't tilt the scores of close_fork.
        for t in self.agent.profile.traits:
            self.agent.profile.traits[t] = 0.5

    def ask(self, controller: str = "bot", outcomes: list | None = None) -> Fork:
        self.agent.controller = controller
        fork = close_fork(self.agent.id, self.sim.clock.tick, outcomes)
        self.sim.director(self.agent, fork)
        return fork


class TestDirectorRouting(DirectorTestCase):
    def test_obvious_fork_decided_by_habit_without_asking(self):
        self.agent.controller = "bot"
        fork = obvious_fork(self.agent.id, self.sim.clock.tick)
        self.sim.director(self.agent, fork)
        self.assertEqual(fork.status, "decided")
        self.assertEqual(fork.decided_by, "habit")
        self.assertEqual(fork.choice, 0)
        self.assertEqual(self.sim.outbox, [])
        self.assertNotIn(fork.id, self.sim.asked_at)
        self.assertNotEqual(self.agent.state, "deciding")
        self.assertEqual(self.sim.answer(fork.id, 1, controller="bot"), {"accepted": False, "error": "unknown fork"})

    def test_close_fork_with_controller_is_asked(self):
        fork = self.ask("bot")
        self.assertEqual(fork.status, "asked")
        self.assertEqual(self.agent.state, "deciding")
        self.assertEqual(self.agent.fork_id, fork.id)
        self.assertEqual(len(self.sim.outbox), 1)
        to, msg = self.sim.outbox[0]
        self.assertEqual(to, "bot")
        self.assertEqual(msg["type"], "fork")
        self.assertEqual(msg["fork_id"], fork.id)
        self.assertEqual(msg["agent_id"], self.agent.id)
        self.assertEqual(len(msg["options"]), 4)
        self.assertEqual(msg["deadline_seconds"], ANSWER_SECONDS)

    def test_no_controller_plays_default(self):
        self.agent.controller = None
        fork = close_fork(self.agent.id, self.sim.clock.tick)
        self.sim.director(self.agent, fork)
        self.assertEqual(fork.status, "decided")
        self.assertEqual(fork.decided_by, "default")
        self.assertIn(fork.choice, range(4))
        self.assertEqual(self.sim.outbox, [])
        self.assertNotIn(fork.id, self.sim.asked_at)

    def test_decided_fork_logged(self):
        fork = self.ask()
        self.sim.answer(fork.id, 2, "why not", controller="bot")
        logged = [f for f in self.sim.fork_log if f["id"] == fork.id]
        self.assertEqual(len(logged), 1)
        self.assertEqual(logged[0]["choice"], 2)
        self.assertEqual(logged[0]["decided_by"], "model")


class TestAnswerWindows(DirectorTestCase):
    def test_answer_in_time_applies_and_teaches(self):
        fork = self.ask()
        before = self.agent.profile.traits["thrift"]
        self.clock.advance(ANSWER_SECONDS - 0.5)
        res = self.sim.answer(fork.id, 1, "saving up", controller="bot")
        self.assertEqual(res, {"accepted": True, "applied": True})
        self.assertEqual(fork.status, "decided")
        self.assertEqual(fork.decided_by, "model")
        self.assertEqual(fork.choice, 1)
        self.assertEqual(fork.reason, "saving up")
        self.assertGreater(self.agent.profile.traits["thrift"], before)
        self.assertTrue(any("Option B" in n and "saving up" in n for n in self.agent.profile.learned))
        self.assertNotEqual(self.agent.state, "deciding")

    def test_answer_exactly_at_deadline_applies(self):
        fork = self.ask()
        self.clock.advance(ANSWER_SECONDS)
        self.assertTrue(self.sim.answer(fork.id, 3, controller="bot")["applied"])
        self.assertEqual(fork.decided_by, "model")

    def test_no_timeout_before_deadline(self):
        fork = self.ask()
        self.clock.advance(ANSWER_SECONDS - 0.1)
        self.sim._check_timeouts()
        self.assertEqual(fork.status, "asked")
        self.assertEqual(self.agent.state, "deciding")

    def test_timeout_plays_default(self):
        fork = self.ask()
        traits = dict(self.agent.profile.traits)
        self.clock.advance(ANSWER_SECONDS + 0.1)
        self.sim._check_timeouts()
        self.assertEqual(fork.status, "decided")
        self.assertEqual(fork.decided_by, "timeout")
        self.assertIn(fork.choice, range(4))
        self.assertEqual(self.agent.profile.traits, traits)  # a timeout teaches nothing
        self.assertNotEqual(self.agent.state, "deciding")

    def test_timeout_also_fires_from_step(self):
        fork = self.ask()
        self.clock.advance(ANSWER_SECONDS + 1)
        self.sim.step()
        self.assertEqual(fork.decided_by, "timeout")

    def test_late_answer_saved_and_teaches_but_does_not_change_action(self):
        fork = self.ask()
        self.clock.advance(ANSWER_SECONDS + 0.1)
        self.sim._check_timeouts()
        played = fork.choice
        late = (played + 1) % 4
        tag = next(iter(fork.options[late].tags))
        before = self.agent.profile.traits[tag]
        plan = list(self.agent.plan)
        self.clock.advance(2)
        res = self.sim.answer(fork.id, late, "changed my mind", controller="bot")
        self.assertTrue(res["accepted"])
        self.assertFalse(res["applied"])
        self.assertEqual(fork.late_answer, {"choice": late, "reason": "changed my mind"})
        self.assertEqual(fork.choice, played)
        self.assertEqual(fork.decided_by, "timeout")
        self.assertEqual(self.agent.plan, plan)
        self.assertGreater(self.agent.profile.traits[tag], before)
        self.assertTrue(any("changed my mind" in n for n in self.agent.profile.learned))

    def test_answer_after_learn_window_rejected(self):
        fork = self.ask()
        self.clock.advance(ANSWER_SECONDS + 0.1)
        self.sim._check_timeouts()
        self.clock.advance(LEARN_SECONDS - ANSWER_SECONDS + 0.5)  # past 10s, cleanup not yet run
        learned = list(self.agent.profile.learned)
        res = self.sim.answer(fork.id, 0, controller="bot")
        self.assertEqual(res, {"accepted": False, "error": "too late"})
        self.assertFalse(hasattr(fork, "late_answer"))
        self.assertEqual(self.agent.profile.learned, learned)

    def test_fork_forgotten_after_learn_window(self):
        fork = self.ask()
        self.clock.advance(ANSWER_SECONDS + 0.1)
        self.sim._check_timeouts()
        self.clock.advance(LEARN_SECONDS)
        self.sim._check_timeouts()
        self.assertNotIn(fork.id, self.sim.asked_at)
        self.assertNotIn(fork.id, self.sim.forks)
        self.assertFalse(self.sim.answer(fork.id, 0, controller="bot")["accepted"])

    def test_second_answer_rejected(self):
        fork = self.ask()
        self.assertTrue(self.sim.answer(fork.id, 0, controller="bot")["applied"])
        res = self.sim.answer(fork.id, 1, controller="bot")
        self.assertFalse(res["accepted"])
        self.assertEqual(fork.choice, 0)

    @unittest.expectedFailure
    def test_answer_after_deadline_before_timeout_check_is_still_saved(self):
        # BUG: between the 5s deadline and the next _check_timeouts() call the fork is still
        # "asked", so answer() falls through to "too late" instead of timing it out and saving
        # the answer as a late answer that teaches the profile.
        fork = self.ask()
        self.clock.advance(ANSWER_SECONDS + 1)
        res = self.sim.answer(fork.id, 0, "slow", controller="bot")
        self.assertTrue(res["accepted"])
        self.assertFalse(res["applied"])


class TestAnswerValidation(DirectorTestCase):
    def test_wrong_controller_rejected(self):
        fork = self.ask("bot")
        res = self.sim.answer(fork.id, 0, controller="intruder")
        self.assertEqual(res, {"accepted": False, "error": "not your character"})
        self.assertEqual(fork.status, "asked")
        self.assertEqual(self.agent.state, "deciding")

    def test_unknown_fork(self):
        self.assertEqual(self.sim.answer("nope", 0, controller="bot"), {"accepted": False, "error": "unknown fork"})

    def test_choice_out_of_range_rejected(self):
        fork = self.ask()
        for bad in (-1, 4, 99, "1", 1.0, None):
            with self.subTest(choice=bad):
                res = self.sim.answer(fork.id, bad, controller="bot")
                self.assertFalse(res["accepted"])
                self.assertEqual(res["error"], "choice must be 0 to 3")
        self.assertEqual(fork.status, "asked")
        self.assertTrue(self.sim.answer(fork.id, 3, controller="bot")["applied"])

    @unittest.expectedFailure
    def test_boolean_choice_rejected(self):
        # BUG: bool is a subclass of int, so a JSON `true` from a controller passes the
        # isinstance(choice, int) check and is applied as option 1.
        fork = self.ask()
        self.assertFalse(self.sim.answer(fork.id, True, controller="bot")["accepted"])


class TestHiddenLuck(DirectorTestCase):
    def test_outcomes_rolled_and_logged(self):
        outs = [Outcome("good", "Something good", 0.5, +1, {"fun": 1}),
                Outcome("bad", "Something bad", 0.5, -1, {"fun": -1}),
                Outcome("never", "Never happens", 0.0, -1, {})]
        self.sim.set_luck(self.agent.id, 100)
        fork = self.ask(outcomes=outs)
        self.sim.answer(fork.id, 0, controller="bot")
        entries = {e["what"]: e for e in self.sim.luck_log if e["what"].startswith(fork.id + ":")}
        self.assertEqual(set(entries), {f"{fork.id}:good", f"{fork.id}:bad"})  # p=0 is not rolled
        good, bad = entries[f"{fork.id}:good"], entries[f"{fork.id}:bad"]
        self.assertEqual(good["base_p"], 0.5)
        self.assertAlmostEqual(good["p"], 0.8)  # luck 100 lifts good odds by 60%
        self.assertAlmostEqual(bad["p"], 0.2)  # and cuts bad odds by 60%
        for e in (good, bad):
            self.assertEqual(e["agent"], self.agent.id)
            self.assertEqual(e["luck"], 100)
            self.assertTrue(0 <= e["roll"] < 1)
            self.assertEqual(e["hit"], e["roll"] < e["p"])

    def test_no_probabilities_leak_to_controllers_or_views(self):
        outs = [Outcome("good", "Something good", 0.5, +1, {"fun": 1}),
                Outcome("bad", "Something bad", 0.5, -1, {"fun": -1})]
        fork = self.ask(outcomes=outs)
        _, msg = self.sim.outbox[0]
        self.assertEqual(find_keys(msg, HIDDEN_KEYS), [])
        self.assertEqual(find_keys(self.sim.fork_message(self.agent, fork), HIDDEN_KEYS), [])
        for opt in msg["options"]:
            self.assertNotIn("outcomes", opt)
        self.sim.answer(fork.id, 0, controller="bot")
        for _ in range(30):
            self.sim.step()
        self.assertTrue(self.sim.luck_log)  # rolls did happen
        self.assertEqual(find_keys(self.sim.outbox, HIDDEN_KEYS), [])
        self.assertEqual(find_keys(self.sim.state_json(), HIDDEN_KEYS), [])
        for aid in self.sim.agents:
            self.assertEqual(find_keys(self.sim.agent_json(aid), HIDDEN_KEYS), [], aid)
        self.assertEqual(find_keys(self.sim.fork_log, HIDDEN_KEYS), [])
        self.assertEqual(find_keys(self.sim.events, HIDDEN_KEYS), [])

    def test_set_luck_clamps(self):
        aid = self.agent.id
        self.assertTrue(self.sim.set_luck(aid, 150))
        self.assertEqual(self.agent.luck, 100.0)
        self.assertTrue(self.sim.set_luck(aid, -20))
        self.assertEqual(self.agent.luck, 0.0)
        self.assertTrue(self.sim.set_luck(aid, 42.5))
        self.assertEqual(self.agent.luck, 42.5)
        self.assertFalse(self.sim.set_luck("nobody", 50))

    def test_delayed_outcome_lands_later(self):
        out = Outcome("later", "Feels it later", 1.0, 0, {"fun": -1, "delay": 60, "memory": "The delayed thing."})
        fork = self.ask(outcomes=[out])
        self.sim.answer(fork.id, 0, controller="bot")
        decided_at = self.sim.clock.tick
        pending = [p for p in self.agent.pending_outcomes if p["fork"] == fork.id]
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]["due"], decided_at + 60)

        def landed() -> bool:
            return any("Feels it later" in e["text"] for e in self.sim.history)

        # The plan (a 20-minute idle) finishes well before the delay is up.
        for _ in range(59):
            self.sim.step()
        self.assertFalse(landed())
        self.assertFalse(any("The delayed thing." in m for m in self.agent.memory))
        self.sim.step()
        self.assertTrue(landed())
        self.assertTrue(any("The delayed thing." in m for m in self.agent.memory))
        self.assertFalse(any(p["fork"] == fork.id for p in self.agent.pending_outcomes))

    def test_immediate_outcome_lands_when_plan_done(self):
        out = Outcome("now", "Feels it now", 1.0, 0, {"fun": -1})
        fork = self.ask(outcomes=[out])
        self.sim.answer(fork.id, 0, controller="bot")
        pending = [p for p in self.agent.pending_outcomes if p["fork"] == fork.id]
        self.assertEqual(len(pending), 1)
        self.assertIsNone(pending[0]["due"])
        for _ in range(25):  # the idle step lasts 20 minutes
            self.sim.step()
        self.assertTrue(any("Feels it now" in e["text"] for e in self.sim.history))


class TestProfileEditing(DirectorTestCase):
    def test_learning_rewrites_unedited_prompt(self):
        self.agent.profile.prompt = "placeholder"
        fork = self.ask()
        self.sim.answer(fork.id, 1, controller="bot")
        self.assertEqual(self.agent.profile.prompt, self.agent.profile.describe(self.agent))

    def test_edited_prompt_survives_learning(self):
        self.assertTrue(self.sim.set_profile(self.agent.id, prompt="  Always takes the bus.  "))
        self.assertTrue(self.agent.profile.prompt_edited)
        self.assertEqual(self.agent.profile.prompt, "Always takes the bus.")
        before = self.agent.profile.traits["thrift"]
        fork = self.ask()
        self.sim.answer(fork.id, 1, "cheap", controller="bot")
        self.assertGreater(self.agent.profile.traits["thrift"], before)  # traits still learn
        self.assertEqual(self.agent.profile.prompt, "Always takes the bus.")
        # A late answer doesn't overwrite it either.
        fork2 = self.ask()
        self.clock.advance(ANSWER_SECONDS + 0.1)
        self.sim._check_timeouts()
        self.assertTrue(self.sim.answer(fork2.id, 2, controller="bot")["accepted"])
        self.assertEqual(self.agent.profile.prompt, "Always takes the bus.")
        self.assertTrue(self.sim.agent_json(self.agent.id)["profile"]["edited"])

    def test_set_profile_traits_clamped_and_blank_prompt_ignored(self):
        self.assertTrue(self.sim.set_profile(self.agent.id, prompt="   ", traits={"thrift": 3, "social": -1, "bogus": 1}))
        self.assertEqual(self.agent.profile.traits["thrift"], 1.0)
        self.assertEqual(self.agent.profile.traits["social"], 0.0)
        self.assertNotIn("bogus", self.agent.profile.traits)
        self.assertFalse(self.agent.profile.prompt_edited)
        self.assertFalse(self.sim.set_profile("nobody", prompt="x"))


if __name__ == "__main__":
    unittest.main()

"""Regression tests for review findings in the example controllers (examples/)."""

from __future__ import annotations

import asyncio
import contextlib
import io
import json
import random
import re
import sys
import threading
import time
import types
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "examples"))

import claude_controller as cc  # noqa: E402
import simple_controller as sc  # noqa: E402
from gameofailife.town import CAST  # noqa: E402

ANSWER = '{"choice": 0, "reason": "fine"}'


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeWS:
    def __init__(self):
        self.sent: list[dict] = []

    async def send(self, text: str) -> None:
        self.sent.append(json.loads(text))


def controller(**overrides) -> cc.ClaudeController:
    args = types.SimpleNamespace(fake=True, model="claude-haiku-5-5", chat=False, characters="all",
                                 name="claude", url="ws://localhost:8000/ws")
    for k, v in overrides.items():
        setattr(args, k, v)
    ctl = cc.ClaudeController(args, "")
    ctl.ws = FakeWS()
    return ctl


def fork(agent_id: str, deadline: float = 5.0) -> dict:
    return {"type": "fork", "fork_id": f"fork-{agent_id}", "agent_id": agent_id, "kind": "test",
            "time": "Day 1 Mon 08:00", "deadline_seconds": deadline, "question": "What now?",
            "options": [{"index": i, "label": f"Option {i}", "cost": 0} for i in range(4)],
            "you": {"name": agent_id.title(), "needs": {}, "money": 100}}


def work_fork(money: float, social: int) -> dict:
    """The work fork's options as the city sends them (labels from forks.work_fork)."""
    return {"options": [{"index": 0, "label": "Walk to work", "cost": 0, "travel_minutes": 12},
                        {"index": 1, "label": "Run to work", "cost": 0, "travel_minutes": 6},
                        {"index": 2, "label": "Grab a coffee at Corner Cafe first", "cost": 4, "travel_minutes": 5},
                        {"index": 3, "label": "Call in sick and stay home", "cost": 0}],
            "you": {"money": money, "needs": {"hunger": 80, "energy": 80, "social": social, "fun": 80}}}


def play(ctl: cc.ClaudeController, ids: list[str], forks: list[dict]) -> str:
    """Welcome the controller as the player of `ids`, hand it all `forks` at once; return what it printed."""
    async def burst():
        ctl.handle({"type": "welcome", "name": "claude", "characters": ids})
        await asyncio.gather(*(ctl.decide(f) for f in forks))

    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        asyncio.run(burst())
    ctl.pool.shutdown()
    return out.getvalue()


def chosen(ctl: cc.ClaudeController) -> list[str]:
    return sorted(m["fork_id"] for m in ctl.ws.sent if m["type"] == "choose")


class TestClaudeRequestAndReply(unittest.TestCase):
    """Finding 38: Haiku 5.5 thinks by default, and thinking counts toward max_tokens."""

    def call(self, reply: dict) -> tuple[str | Exception, dict]:
        seen = {}

        def urlopen(req, timeout=None):
            seen["body"] = json.loads(req.data)
            return FakeResponse(json.dumps(reply).encode())

        with mock.patch.object(cc.urllib.request, "urlopen", urlopen):
            try:
                return cc.call_claude("key", "claude-haiku-5-5", "system", "user"), seen["body"]
            except RuntimeError as exc:
                return exc, seen["body"]

    def test_request_asks_for_low_effort_with_room_to_think(self):
        _, body = self.call({"content": [{"type": "text", "text": ANSWER}], "stop_reason": "end_turn"})
        self.assertEqual(body["output_config"], {"effort": "low"})
        self.assertGreaterEqual(body["max_tokens"], 1024)
        self.assertNotIn("thinking", body)  # 'disabled' is a 400 on Opus 5.5 and Sonnet 5.5

    def test_text_after_a_thinking_block_is_read(self):
        out, _ = self.call({"content": [{"type": "thinking", "thinking": "", "signature": "sig"},
                                        {"type": "text", "text": ANSWER}], "stop_reason": "end_turn"})
        self.assertEqual(out, ANSWER)

    def test_thinking_only_reply_names_the_stop_reason(self):
        out, _ = self.call({"content": [{"type": "thinking", "thinking": "", "signature": "sig"}],
                            "stop_reason": "max_tokens"})
        self.assertIsInstance(out, RuntimeError)
        self.assertIn("max_tokens", str(out))

    def test_refusal_is_not_read_as_an_answer(self):
        out, _ = self.call({"content": [{"type": "text", "text": "I can't help with that. 2"}],
                            "stop_reason": "refusal"})
        self.assertIsInstance(out, RuntimeError)
        self.assertIn("refusal", str(out))

    def test_fork_with_thinking_only_reply_says_why_the_profile_decides(self):
        reply = {"content": [{"type": "thinking", "thinking": "", "signature": "sig"}], "stop_reason": "max_tokens"}
        ctl = controller()
        ctl.ask = cc.call_claude
        out = io.StringIO()
        with mock.patch.object(cc.urllib.request, "urlopen", lambda req, timeout=None: FakeResponse(json.dumps(reply).encode())), \
                contextlib.redirect_stdout(out):
            asyncio.run(ctl.decide(fork("ari")))
        self.assertEqual(ctl.ws.sent, [])
        self.assertIn("max_tokens", out.getvalue())
        self.assertNotIn("could not read a choice from ''", out.getvalue())


class TestClaudeWorkerPool(unittest.TestCase):
    """Finding 39: a burst of forks must not queue behind the default thread pool."""

    def test_every_claimed_character_can_be_asked_at_once(self):
        # More forks than the default pool ever has threads (32 at most): each call waits until
        # all of them are running at the same time, which only a pool sized for the cast allows.
        ids = [f"c{i}" for i in range(40)]
        barrier = threading.Barrier(len(ids), timeout=3)
        ctl = controller()
        ctl.ask = lambda *a: (barrier.wait(), ANSWER)[1]
        play(ctl, ids, [fork(aid) for aid in ids])
        self.assertEqual(chosen(ctl), sorted(f"fork-{aid}" for aid in ids))

    def test_fork_whose_deadline_passed_in_the_queue_is_dropped(self):
        calls = []
        ctl = controller()
        ctl.ask = lambda *a: (calls.append(1), time.sleep(0.5), ANSWER)[2]
        # One character means two threads: the third fork waits 0.5s for one, past its 0.2s deadline.
        out = play(ctl, ["ari"], [fork(f"ari{i}", deadline=0.2) for i in range(3)])
        self.assertEqual(len(calls), 2)
        self.assertEqual(len(chosen(ctl)), 2)
        self.assertIn("no free worker before the deadline", out)

    def test_ask_in_time_skips_the_api_once_the_deadline_passed(self):
        ctl = controller()
        ctl.ask = mock.Mock(return_value=ANSWER)
        self.assertIsNone(ctl.ask_in_time(time.monotonic() - 0.1, "system", "user"))
        ctl.ask.assert_not_called()
        self.assertEqual(ctl.ask_in_time(time.monotonic() + 5, "system", "user"), ANSWER)


class TestSimpleControllerKeywords(unittest.TestCase):
    """Finding 40: 'call' must not make 'Call in sick' a social option."""

    def test_thrifty_goes_to_work_when_social_is_lowest(self):
        for social in (38, 30, 20):
            idx, why = sc.choose(work_fork(300, social), "thrifty", random.Random(1))
            self.assertNotEqual(idx, 3, f"social {social}: {why}")
            self.assertNotIn("social is lowest", why)

    def test_social_style_does_not_call_in_sick_to_be_around_people(self):
        for social in (38, 30, 20):
            idx, why = sc.choose(work_fork(300, social), "social", random.Random(1))
            self.assertNotEqual(idx, 3, f"social {social}: {why}")

    def test_calling_someone_still_helps_social(self):
        lonely = {"options": [{"index": 0, "label": "Go people-watching at Corner Cafe", "cost": 6},
                              {"index": 1, "label": "Call Miriam", "cost": 0},
                              {"index": 2, "label": "Write in a diary", "cost": 0},
                              {"index": 3, "label": "Stay home alone", "cost": 0}],
                  "you": {"money": 300, "needs": {"hunger": 80, "energy": 80, "social": 20, "fun": 80}}}
        self.assertEqual(sc.choose(lonely, "thrifty", random.Random(1)), (1, "social is lowest (20); free"))

    def test_skipping_a_meal_does_not_count_as_food(self):
        self.assertFalse(sc.helps("Skip the meal and push on", sc.NEED_WORDS["hunger"]))
        self.assertTrue(sc.helps("Cook at home", sc.NEED_WORDS["hunger"]))

    def test_keywords_match_whole_words_from_their_start(self):
        self.assertFalse(sc.mentions("Treat yourself", ("eat",)))
        self.assertFalse(sc.mentions("Recall the trip", ("call",)))
        self.assertTrue(sc.mentions("Eat at Corner Cafe", ("eat",)))
        self.assertTrue(sc.mentions("Go people-watching at Corner Cafe", ("watch",)))
        self.assertTrue(sc.mentions("Hang out at Corner Cafe", ("hang out",)))


class TestSimpleControllerMoney(unittest.TestCase):
    """Finding 41: in debt, free options stay affordable and paid ones don't."""

    def test_random_style_in_debt_picks_only_free_options(self):
        rng = random.Random(3)
        picks = {sc.choose(work_fork(-15.85, 60), "random", rng)[0] for _ in range(200)}
        self.assertEqual(picks, {0, 1, 3})

    def test_thrifty_in_debt_picks_a_free_option(self):
        idx, _ = sc.choose(work_fork(-15.85, 60), "thrifty", random.Random(1))
        self.assertIn(idx, (0, 1, 3))

    def test_nothing_affordable_falls_back_to_the_cheapest(self):
        pricey = {"options": [{"index": i, "label": f"Option {i}", "cost": c} for i, c in enumerate((40, 25, 60, 50))],
                  "you": {"money": 10, "needs": {}}}
        rng = random.Random(3)
        self.assertEqual({sc.choose(pricey, "random", rng)[0] for _ in range(50)}, {1})


class TestClaudeControllerBadUrl(unittest.TestCase):
    """Finding 42: a URL that isn't ws:// ends with a clear message, not a traceback."""

    def test_non_ws_urls_exit_with_a_message(self):
        for url in ("http://127.0.0.1:8000/ws", "wss://127.0.0.1:8000/ws"):
            argv = ["claude_controller.py", "--fake", "--url", url]
            with mock.patch.object(sys, "argv", argv), self.assertRaises(SystemExit) as cm:
                cc.main()
            self.assertEqual(str(cm.exception.code),
                             f"Could not reach the city at {url}: only ws:// URLs are supported")


class TestUsageExamples(unittest.TestCase):
    """Findings 43 and 55: the documented commands must claim real characters."""

    def test_documented_character_ids_exist(self):
        ids = {row[0] for row in CAST}
        for module in (cc, sc):
            examples = re.findall(r"--characters (\S+)", module.__doc__)
            self.assertTrue(examples, module.__name__)
            for arg in examples:
                if arg != "all":
                    self.assertLessEqual(set(arg.split(",")), ids, f"{module.__name__}: --characters {arg}")


if __name__ == "__main__":
    unittest.main()

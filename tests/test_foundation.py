"""The P0 foundation: the PLAN section 3 contracts, the hook seams, hidden information and frame sizes.

One three-day run of seed 1 (made once, in setUpModule) feeds the shape, event and size checks; the rest
build small scenes of their own. Ids, places and times come from the city at run time.
"""

from __future__ import annotations

import asyncio
import collections
import dataclasses
import heapq
import json
import random
import subprocess
import sys
import time
import unittest
from pathlib import Path
from unittest import mock

from gameofailife import (chronicle, forks, housing, housing_forks, people, sim as sim_module, social_forks, stats,
                          transit, travel, ws)
from gameofailife.cast import CAST_SIZE
from gameofailife.clock import MINUTES_PER_DAY, TICKS_PER_REAL_SECOND
from gameofailife.forks import Fork, Option, Outcome, default_scores, payday_fork
from gameofailife.server import GOD_ONLY, HOUSING_EVERY, GameServer
from gameofailife.sim import ANSWER_SECONDS, Simulation
from gameofailife.town import ROAD, UNREACHABLE, WATER, build_map

SEED = 1
DAYS = 3
ROOT = Path(__file__).resolve().parent.parent
SECRET_KEYS = {"p", "outcomes", "odds", "probability", "probabilities", "luck_log", "scores", "valence",
               "due", "pending_emergency", "roll", "base_p", "hit"}
# Six ticks of the run whose state is measured: morning rush, midday and evening on each of the days.
SAMPLED = (8 * 60, 12 * 60 + 30, 18 * 60, MINUTES_PER_DAY + 9 * 60, 2 * MINUTES_PER_DAY + 13 * 60,
           2 * MINUTES_PER_DAY + 21 * 60)
STATE_BYTES, STATE_BYTES_LEAN = 24 * 1024, 19 * 1024
SUMMARY_KEYS = {"id", "agent", "kind", "tick", "time", "question", "options", "choice", "decided_by", "reason",
                "happened", "major", "controller", "model", "answer_seconds", "late", "profile_choice", "place"}
EVENT_KEYS = {"seq", "tick", "time", "kind", "tag", "importance", "major", "text", "agent", "agents", "place", "at"}
PLAN_BUILDERS = ["invite", "work", "hunger", "sleep", "pending", "repair", "payday", "groceries", "housing_trouble",
                 "house_hunt", "upkeep", "lonely", "free_time"]  # v3: life's prompts (people.pending_fork) after sleep

RUN: dict = {}


def find_secret_keys(obj, path="") -> list[str]:
    """Every key anywhere in a JSON value that would reveal odds, rolls or a hidden emergency."""
    found = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in SECRET_KEYS:
                found.append(f"{path}.{k}")
            found += find_secret_keys(v, f"{path}.{k}")
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            found += find_secret_keys(v, f"{path}[{i}]")
    return found


def recording_build_fork(built: list):
    real = forks.build_fork

    def recording(sim, agent):
        fork = real(sim, agent)
        if fork is not None:
            built.append(fork)
        return fork

    return recording


def run_city(seed: int, days: int, sample: tuple[int, ...] = ()) -> dict:
    """Run a city, keeping what God would have been sent: every event, every decided fork, some states."""
    sim = Simulation(seed=seed)
    out = {"sim": sim, "built": [], "events": [], "summaries": [], "sizes": []}
    start = sim.clock.tick
    with mock.patch.object(sim_module, "build_fork", recording_build_fork(out["built"])):
        for _ in range(days * MINUTES_PER_DAY):
            sim.step()
            events, decided, _ = sim.drain()
            out["events"] += events
            out["summaries"] += decided
            if sim.clock.tick - start in sample:
                full, lean = sim.state_json(), sim.state_json(housing=False)
                out["sizes"].append((sim.clock.stamp(), len(json.dumps(full).encode()),
                                     len(json.dumps(lean).encode()), full))
    return out


def setUpModule():
    build_map(SEED).warm()
    RUN.update(run_city(SEED, DAYS, SAMPLED))


class FakeClock:
    def __init__(self, t: float = 1000.0):
        self.t = t

    def __call__(self) -> float:
        return self.t

    def advance(self, seconds: float) -> None:
        self.t += seconds


def tied_fork(agent_id: str, tick: int, bases=(0.0, 0.0, 0.0, 0.0), kind: str = "test", major: bool = False,
              outcomes: list | None = None) -> Fork:
    """Four plain options scored only by their `base` (no tags, gains or cost), so the lead is exact."""
    opts = [Option(f"Option {'ABCD'[i]}", [("idle", None)], base=b, outcomes=list(outcomes or []) if i == 0 else [])
            for i, b in enumerate(bases)]
    return Fork(agent_id, kind, "What do you do?", opts, tick, major=major)


def is_int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def is_num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


# --- section 3.2-3.7 shapes ----------------------------------------------------------------------------------


class TownJsonTest(unittest.TestCase):
    def test_town_json_fields(self):
        sim = RUN["sim"]
        town = json.loads(json.dumps(sim.town_json()))
        self.assertEqual((town["w"], town["h"]), (80, 50))
        self.assertEqual(len(town["tiles"]), 50)
        self.assertTrue(all(isinstance(r, str) and len(r) == 80 for r in town["tiles"]))
        self.assertLessEqual(set("".join(town["tiles"])), set(".#BDPTe~"))
        self.assertIn(WATER, "".join(town["tiles"]))
        kinds = {"home", "office", "bank", "townhall", "school", "hospital", "market", "shop", "cafe", "works", "park"}
        districts = {d["id"] for d in town["districts"]}
        for p in town["places"]:
            with self.subTest(place=p["id"]):
                self.assertEqual(set(p), {"id", "name", "kind", "x", "y", "w", "h", "entry", "face", "hours",
                                          "district", "style", "floors", "tier", "units"})
                self.assertIn(p["kind"], kinds)
                self.assertTrue(all(is_int(p[k]) for k in ("x", "y", "w", "h", "floors", "units")))
                self.assertTrue(isinstance(p["entry"], list) and len(p["entry"]) == 2)
                self.assertIn(p["face"], ("n", "s", "e", "w") if p["kind"] != "park" else (None,))
                self.assertTrue(p["hours"] is None or (len(p["hours"]) == 2 and all(map(is_int, p["hours"]))))
                self.assertIn(p["district"], districts)
                self.assertEqual(p["tier"] is None, p["kind"] != "home")
                self.assertEqual(p["units"], {None: 0, "flat": 6}.get(p["tier"], 1))
        self.assertEqual([p["id"] for p in town["places"]], list(sim.town.places))
        self.assertEqual(len(town["homes"]), 37)
        for h in town["homes"]:
            self.assertEqual(set(h), {"id", "place", "unit", "name", "tier", "bedrooms", "base_value", "rent"})
            self.assertIn(h["id"], sim.homes)
            self.assertIn(h["place"], sim.town.places)
        self.assertEqual(set(town["housing"]), {"tiers", "stages", "landlord"})
        self.assertEqual([s["name"] for s in town["housing"]["stages"]],
                         ["kept", "worn", "shabby", "neglected", "derelict"])
        for d in town["districts"]:
            self.assertEqual(set(d), {"id", "name", "about", "rects"})
        for s in town["streets"]:
            self.assertEqual(set(s), {"name", "axis", "at"})
        self.assertEqual((town["road_rows"], town["road_cols"], town["road_col_end"]),
                         ([3, 14, 25, 36], [3, 16, 29, 42, 55, 68], 44))
        self.assertEqual(len(town["junctions"]), 24)
        self.assertEqual(len(town["stops"]), 11)
        for s in town["stops"]:
            self.assertEqual(set(s), {"id", "name", "x", "y", "lines"})
        self.assertEqual(town["timetable"], json.loads(json.dumps(transit.timetable_json())))
        self.assertEqual(set(town["timetable"]), {"bus", "flights"})
        for line in town["timetable"]["bus"]["lines"]:
            self.assertLessEqual({"id", "name", "corners", "stops", "lap_minutes", "buses", "every_minutes", "speed",
                                  "dwell", "fare"}, set(line))
        self.assertTrue(all(isinstance(f, str) for f in town["timetable"]["flights"]))


class StateJsonTest(unittest.TestCase):
    def check_state(self, state: dict, housing_maps: bool = True) -> None:
        sim = RUN["sim"]
        keys = {"tick", "time", "minute", "day", "season", "weather", "lights", "plane", "buses", "agents",
                "trains", "crowd", "folk_n", "talks"}  # v3 (PLAN 2.10): in both worlds
        self.assertEqual(set(state), keys | ({"lots", "homes"} if housing_maps else set()))
        self.assertNotIn("bus", state)  # replaced by buses
        self.assertIsInstance(state["buses"], list)
        self.assertEqual(set(state["lights"]), {"ns", "ew"})
        self.assertTrue(state["plane"] is None or set(state["plane"]) == {"progress", "from", "to"})
        self.assertEqual(len(state["agents"]), CAST_SIZE)
        for row in state["agents"]:
            self.assertEqual(set(row), {"id", "name", "x", "y", "inside", "state", "activity", "vehicle", "mood",
                                        "luck", "controller", "alive", "age", "home", "car", "riding", "ill", "stage"})
            self.assertTrue(all(is_int(row[k]) for k in ("x", "y", "mood", "luck", "age")))
            self.assertIn(row["vehicle"], ("walk", "run", "car", "taxi", "ambulance", "bus"))
            self.assertIn(row["home"], sim.homes)
            self.assertIsInstance(row["car"], bool)
            self.assertTrue(row["riding"] is None or row["riding"] in transit.BUS_IDS, row["riding"])
            if row["riding"] is not None:  # a rider rides on the bus's tile
                self.assertEqual(row["vehicle"], "bus")
            self.assertTrue(row["inside"] is None or row["inside"] in sim.town.places)
        if housing_maps:
            self.assertEqual(set(state["lots"]), set(sim.lots))
            self.assertEqual(len(state["lots"]), 22)
            for lot in state["lots"].values():
                self.assertEqual(set(lot), {"condition", "stage", "works", "moving"})
                self.assertIn(lot["stage"], range(5))
            self.assertEqual(list(state["homes"]), list(sim.homes))
            for home in state["homes"].values():
                self.assertEqual(set(home), {"hh", "owner", "listing", "price", "value", "emergency"})
                self.assertIn(home["listing"], (None, "for_sale", "for_rent"))

    def test_state_json_fields(self):
        sim = RUN["sim"]
        self.check_state(json.loads(json.dumps(sim.state_json())))
        self.check_state(json.loads(json.dumps(sim.state_json(housing=False))), housing_maps=False)
        self.assertEqual({**sim.state_json(housing=False), **sim.housing_maps()}, sim.state_json())

    def test_sampled_states_fit_the_frame_budget(self):
        self.assertEqual(len(RUN["sizes"]), len(SAMPLED))
        for stamp, full, lean, state in RUN["sizes"]:
            with self.subTest(time=stamp):
                self.assertLess(full, STATE_BYTES)
                self.assertLess(lean, STATE_BYTES_LEAN)
                self.check_state(json.loads(json.dumps(state)))


class AgentPageTest(unittest.TestCase):
    def test_agent_page_fields(self):
        sim = RUN["sim"]
        for agent in sim.agents.values():
            page = json.loads(json.dumps(sim.agent_json(agent.id)))
            with self.subTest(agent=agent.id):
                self.assertLessEqual({"savings", "household_funds", "net_worth", "worth_parts", "home_history",
                                      "possessions", "forks"}, set(page))
                self.assertEqual(set(page["worth_parts"]), {"cash", "savings", "home"})
                self.assertEqual(page["net_worth"], sum(page["worth_parts"].values()))
                self.assertIsInstance(page["home_history"], list)
                pos = page["possessions"]
                self.assertEqual(set(pos), {"home", "car", "phone", "money", "savings", "household_funds",
                                            "savings_goal", "groceries_at_home"})
                self.assertEqual(set(pos["home"]), {"id", "place", "name", "tier", "tier_label", "district",
                                                    "bedrooms", "tenure", "landlord", "weekly_rent", "property_tax",
                                                    "weekly_cost", "value", "condition", "stage", "stage_name",
                                                    "comfort", "moved_in", "emergency"})
                self.assertEqual(pos["home"]["id"], sim.household(agent).home_id)
                self.assertEqual(pos["home"]["place"], sim.home_of(agent))
                self.assertIn(pos["home"]["tenure"], ("owned", "rented"))
                self.assertEqual(pos, json.loads(json.dumps(sim.possessions(agent))))
                self.assertLessEqual(len(page["forks"]), 10)
                for summary in page["forks"]:
                    self.assertEqual(set(summary), SUMMARY_KEYS)
                self.assertEqual(find_secret_keys(page), [])


class ForkMessageTest(unittest.TestCase):
    def test_fork_message_fields(self):
        sim = RUN["sim"]
        checked = 0
        for fork in RUN["built"][:200]:
            agent = sim.agents[fork.agent_id]
            if not agent.alive:
                continue
            msg = json.loads(json.dumps(sim.fork_message(agent, fork)))
            checked += 1
            self.assertEqual(len(msg["options"]), 4)
            for i, opt in enumerate(msg["options"]):
                self.assertLessEqual(set(opt), {"index", "label", "cost", "travel_minutes", "household", "home"})
                self.assertEqual(opt["index"], i)
                self.assertEqual("household" in opt, fork.options[i].household_pays)
                if "travel_minutes" in opt:
                    self.assertTrue(is_int(opt["travel_minutes"]))
            you = msg["you"]
            self.assertLessEqual({"name", "profile", "money", "needs", "health", "where", "groceries_at_home", "goal",
                                  "recent_memory", "savings", "where_name", "home_name", "home", "household_funds"},
                                 set(you))
            here = sim.town.places.get(agent.inside or "")
            self.assertEqual(you["where_name"], here.name if here else "outside")
            self.assertEqual(you["home_name"], sim.homes[sim.household(agent).home_id].name)
            self.assertEqual(set(you["home"]),
                             {"name", "tier", "tenure", "weekly_cost", "condition", "stage_name", "value"})
            self.assertEqual(find_secret_keys(msg), [])
        self.assertGreater(checked, 50)

    def test_travel_minutes_come_from_travel(self):
        sim = Simulation(seed=SEED)
        dana = sim.agents["dana"]
        opts = [Option("Walk to the office", [("idle", "office")], vehicle="walk"),
                Option("Drive to the office", [("idle", "office")], vehicle="car"),
                Option("Stay in", [("idle", "home")]), Option("Wait here", [("idle", None)])]
        fork = Fork(dana.id, "test", "?", opts, sim.clock.tick)
        msg = sim.fork_message(dana, fork)
        self.assertEqual([o.get("travel_minutes") for o in msg["options"]],
                         [travel.travel_minutes(sim, dana, "office", "walk"),
                          travel.travel_minutes(sim, dana, "office", "car"),
                          None, None])  # she is at home already
        with mock.patch.object(travel, "travel_minutes", return_value=99) as tm:
            msg = sim.fork_message(dana, fork)
        self.assertEqual([o.get("travel_minutes") for o in msg["options"]], [99, 99, None, None])
        self.assertEqual(tm.call_args_list[1], mock.call(sim, dana, "office", "car", False))


class SummaryTest(unittest.TestCase):
    def check_summary(self, s: dict) -> None:
        sim = RUN["sim"]
        self.assertEqual(set(s), SUMMARY_KEYS)
        self.assertIn(s["decided_by"], ("habit", "default", "model", "timeout"))
        self.assertTrue(is_int(s["tick"]) and is_int(s["choice"]) and is_int(s["profile_choice"]))
        self.assertEqual(len(s["options"]), 4)
        self.assertIn(s["choice"], range(4))
        self.assertIn(s["profile_choice"], range(4))
        self.assertIsInstance(s["major"], bool)
        self.assertIsInstance(s["happened"], list)
        self.assertTrue(s["place"] is None or s["place"] in sim.town.places)
        self.assertEqual(s["answer_seconds"] is None, s["decided_by"] != "model")
        self.assertTrue(s["late"] is None or set(s["late"]) == {"choice", "reason", "seconds"})

    def test_run_summaries(self):
        self.assertGreater(len(RUN["summaries"]), 500)
        for s in RUN["summaries"]:
            self.check_summary(json.loads(json.dumps(s)))
            self.assertEqual((s["controller"], s["model"]), (None, None))  # nobody played anyone
        self.assertEqual(find_secret_keys(RUN["summaries"]), [])

    def test_profile_choice_is_the_first_best_score(self):
        sim = Simulation(seed=SEED)
        dana = sim.agents["dana"]
        fork = tied_fork(dana.id, sim.clock.tick, (0.2, 0.5, 0.5, 0.1))
        sim.director(dana, fork)
        self.assertEqual(fork.profile_choice, 1)
        self.assertEqual(dana.forks[-1]["profile_choice"], 1)

    def test_model_timeout_and_late_answers(self):
        clock = FakeClock()
        sim = Simulation(seed=SEED, now=clock)
        dana = sim.agents["dana"]
        sim.claim("dana", "bot")
        sim.controller_joined("bot", "test-model", ["dana"])
        fork = tied_fork(dana.id, sim.clock.tick)
        sim.director(dana, fork)
        self.assertEqual((fork.status, fork.controller, fork.model, fork.profile_choice),
                         ("asked", "bot", "test-model", 0))
        clock.advance(2.34)
        self.assertEqual(sim.answer(fork.id, 2, "because", controller="bot"), {"accepted": True, "applied": True})
        s = dana.forks[-1]
        self.assertEqual((s["decided_by"], s["choice"], s["controller"], s["model"], s["answer_seconds"], s["late"]),
                         ("model", 2, "bot", "test-model", 2.3, None))
        self.check_summary(s)

        sim.drain()
        fork2 = tied_fork(dana.id, sim.clock.tick)
        sim.director(dana, fork2)
        clock.advance(ANSWER_SECONDS + 0.1)
        sim._check_timeouts()
        s2 = dana.forks[-1]
        self.assertEqual((s2["id"], s2["decided_by"], s2["answer_seconds"]), (fork2.id, "timeout", None))
        sim.drain()
        clock.advance(1.9)  # 7.0 s after asking: too late to act on, in time to teach
        late = (fork2.choice + 1) % 4
        self.assertEqual(sim.answer(fork2.id, late, "slow", controller="bot")["applied"], False)
        self.assertEqual(s2["late"], {"choice": late, "reason": "slow", "seconds": 7.0})
        resent = [f for f in sim.drain()[1] if f["id"] == fork2.id]
        self.assertEqual(len(resent), 1)  # sent again with the late answer
        self.assertEqual(resent[0]["late"]["seconds"], 7.0)

        self.assertEqual([x["id"] for x in sim.llm_log], [fork.id, fork2.id])
        self.assertEqual([x["id"] for x in dana.llm_forks], [fork.id, fork2.id])
        today = sim.stats.today
        self.assertEqual({k: today[k] for k in ("asked", "in_time", "timeouts", "late", "against_habit")},
                         {"asked": 2, "in_time": 1, "timeouts": 1, "late": 1, "against_habit": 1})
        self.assertAlmostEqual(today["seconds"], 2.34)
        self.assertEqual(stats.avg_seconds(today), 2.3)

    def test_habit_and_default_are_counted(self):
        sim = RUN["sim"]
        decided = {s["id"]: s["decided_by"] for s in RUN["summaries"]}
        self.assertEqual(sim.stats.total["habit"], sum(1 for d in decided.values() if d == "habit"))
        self.assertEqual(sim.stats.total["default"], sum(1 for d in decided.values() if d == "default"))
        self.assertEqual(sim.stats.total["asked"], 0)

    def test_llm_rings(self):
        sim = Simulation(seed=SEED)
        dana = sim.agents["dana"]
        for _ in range(sim_module.LLM_LOG_SIZE + 5):
            sim._decide(dana, tied_fork(dana.id, sim.clock.tick), 0, "timeout",
                        "No answer in time; played the default.")
        self.assertEqual(len(sim.llm_log), 500)
        self.assertEqual(len(dana.llm_forks), 30)
        self.assertEqual(dana.llm_forks[-1], sim.llm_log[-1])
        sim._decide(dana, tied_fork(dana.id, sim.clock.tick), 0, "habit", "Obvious from the character's habits.")
        self.assertEqual(sim.llm_log[-1]["decided_by"], "timeout")  # habit and default stay out of the LLM log


class EventsTest(unittest.TestCase):
    def test_event_fields_and_places(self):
        sim, events = RUN["sim"], RUN["events"]
        self.assertGreater(len(events), 150)  # was 300: routine good nights, meals and rest are no lines (v3 D 14)
        for ev in events:
            with self.subTest(seq=ev["seq"]):
                self.assertEqual(set(ev), EVENT_KEYS)
                self.assertIn(ev["tag"], chronicle.EVENT_TAGS)
                self.assertNotEqual(ev["tag"], "other")
                self.assertIn(ev["importance"], (0, 1, 2))
                self.assertEqual(ev["major"], ev["importance"] == 2)
                self.assertTrue(ev["place"] is None or ev["place"] in sim.town.places, ev["place"])
                if ev["agent"] is not None:
                    self.assertEqual(ev["agents"][0], ev["agent"])
                    self.assertTrue(len(ev["at"]) == 2 and all(map(is_int, ev["at"])))
                else:
                    self.assertIsNone(ev["at"])
                self.assertLessEqual(set(ev["agents"]), set(sim.agents))
        self.assertEqual([ev["seq"] for ev in events], list(range(1, len(events) + 1)))
        self.assertEqual(find_secret_keys(events), [])

    def test_rings(self):
        sim, events = RUN["sim"], RUN["events"]
        self.assertEqual(sim.history, events[-300:])
        self.assertEqual(sim.news, [e for e in events if e["importance"] >= 1][-300:])
        self.assertEqual(sim.headlines, [e for e in events if e["importance"] == 2][-100:])

    def test_god_only_lines_stay_out_of_memory(self):
        sim = Simulation(seed=SEED)
        dana = sim.agents["dana"]
        before = len(dana.memory)
        sim.event("Dana Cohen is now the richest person in town.", dana, tag="richest")
        sim.event("Not for Dana's ears.", dana, tag="outcome", remember=False)
        sim.event("Dana Cohen: Sleeps well.", dana, tag="outcome")
        self.assertEqual([m.split(": ", 1)[1] for m in dana.memory[before:]], ["Dana Cohen: Sleeps well."])

    def test_place_is_given_or_where_the_character_is(self):
        sim = Simulation(seed=SEED)
        dana = sim.agents["dana"]
        self.assertEqual(sim.event("x", dana, tag="outcome")["place"], dana.inside)
        self.assertEqual(sim.event("x", dana, tag="outcome", place="cafe")["place"], "cafe")
        self.assertIsNone(sim.event("x", tag="weather")["place"])
        sim._die(dana, "collapsed and could not be saved")
        death = [e for e in sim.events if e["tag"] == "death"][-1]
        self.assertEqual(death["place"], sim.home_of(dana))  # captured before `inside` was cleared

    def test_outcome_events_are_classified(self):
        sim = Simulation(seed=SEED)
        dana = sim.agents["dana"]
        texts = []
        for effects, tag in (({"money": -150}, "big_money"), ({"health": -8}, "injury"), ({"money": 40}, "money_swing"),
                             ({"fun": 5}, "outcome")):
            sim._apply_outcome(dana, {"fork": "f0", "outcome": Outcome("x", "Something", 1.0, 0, effects), "due": None})
            self.assertEqual((sim.events[-1]["tag"], sim.events[-1]["kind"]), (tag, "outcome"))
            texts.append(sim.events[-1]["text"])
        self.assertEqual(texts, ["Dana Cohen: Something (−$150).", "Dana Cohen: Something.",
                                 "Dana: Something (+$40).", "Dana: Something."])


# --- hook seams (PLAN 3.10) --------------------------------------------------------------------------------


class HookTest(unittest.TestCase):
    def setUp(self):
        self.sim = Simulation(seed=SEED)
        self.dana = self.sim.agents["dana"]

    def at(self, day: int, minute: int) -> None:
        self.sim.clock.tick = day * MINUTES_PER_DAY + minute

    def test_weekly_charges_on_sunday_at_23(self):
        with mock.patch.object(housing, "weekly_charges") as weekly:
            self.at(6, 23 * 60 - 1)
            self.sim.step()
            weekly.assert_called_once_with(self.sim)
            self.at(5, 23 * 60 - 1)  # Saturday
            self.sim.step()
            self.assertEqual(weekly.call_count, 1)
        self.assertFalse(hasattr(self.sim, "_charge_rent"))

    def test_tick_before_the_agents_and_sample_after_them_on_the_hour(self):
        order = []
        real = self.sim._tick_agent
        self.sim._tick_agent = lambda agent: (order.append("agent"), real(agent))
        with mock.patch.object(housing, "tick", side_effect=lambda sim: order.append("housing.tick")), \
                mock.patch.object(self.sim.stats, "sample", side_effect=lambda sim: order.append("sample")):
            self.at(0, 10 * 60 - 2)
            self.sim.step()  # 09:59
            self.assertEqual(order, ["housing.tick"] + ["agent"] * CAST_SIZE)
            order.clear()
            self.sim.step()  # 10:00
            self.assertEqual(order, ["housing.tick"] + ["agent"] * CAST_SIZE + ["sample"])

    def test_nightly_after_old_age_then_reset_day(self):
        order = []
        real_roll, real_reset = self.sim._log_roll, self.sim.stats.reset_day
        self.sim._log_roll = lambda agent, what, *a, **k: (order.append(what), real_roll(agent, what, *a, **k))
        self.sim.stats.count("habit")
        habit = self.sim.stats.total["habit"]
        reset = lambda: (order.append("reset"), real_reset())  # noqa: E731
        with mock.patch.object(housing, "nightly", side_effect=lambda sim: order.append("nightly")), \
                mock.patch.object(self.sim.stats, "reset_day", side_effect=reset):
            self.at(1, -1)
            self.sim.step()  # midnight
        # v3 (L2): no old-age roll at midnight any more; life's daily rolls (mortality among them) run in each
        # person's own slot minute (life.tick), so nothing but v2's old-age roll, if any, comes before nightly.
        nightly = order.index("nightly")
        self.assertEqual(order[nightly:nightly + 2], ["nightly", "reset"])
        self.assertTrue(all(what == "old_age" for what in order[:nightly]))
        self.assertEqual(order.count("reset"), 1)
        self.assertEqual(self.sim.stats.today["habit"], self.sim.stats.total["habit"] - habit)  # only after midnight

    def test_on_death_after_the_household_update(self):
        hh = self.sim.household(self.dana)
        self.dana.trip, self.dana.riding = {"mode": "bus"}, "1a"
        seen = []
        with mock.patch.object(housing, "on_death",
                               side_effect=lambda sim, agent: seen.append(("dana" in hh.member_ids, agent.died))):
            self.sim._die(self.dana, "collapsed and could not be saved")
        self.assertEqual(seen, [(False, {"tick": self.sim.clock.tick, "time": self.sim.clock.stamp(),
                                         "how": "collapsed and could not be saved"})])
        self.assertEqual((self.dana.trip, self.dana.riding), (None, None))

    def test_home_gains_scale(self):
        def gain(scale: float, activity: str, where: str) -> dict:
            sim = Simulation(seed=SEED)
            dana = sim.agents["dana"]
            sim._start_step(dana, activity, where)
            dana.state, dana.activity_minutes = "busy", 60
            dana.needs.update({n: 50.0 for n in dana.needs})  # room to go up or down
            dana.busy_until = sim.clock.tick + 60
            before = dict(dana.needs)
            with mock.patch.object(housing, "activity_gain_scale", return_value=scale) as hook:
                sim._do_activity(dana)
            return {n: dana.needs[n] - before[n] for n in before}, hook.call_count

        (one, n1), (two, n2) = gain(1.0, "relax_home", "home"), gain(2.0, "relax_home", "home")
        self.assertEqual((n1, n2), (1, 1))
        self.assertAlmostEqual(two["fun"], 2 * one["fun"])
        (one, _), (two, _) = gain(1.0, "stay_up", "home"), gain(2.0, "stay_up", "home")
        self.assertAlmostEqual(two["energy"], one["energy"])  # costs are not scaled
        self.assertAlmostEqual(two["fun"], 2 * one["fun"])
        (one, _), (two, _) = gain(1.0, "sleep", "home"), gain(2.0, "sleep", "home")
        self.assertAlmostEqual(two["energy"], 2 * one["energy"])
        (one, n1), (two, n2) = gain(1.0, "coffee", "cafe"), gain(2.0, "coffee", "cafe")
        self.assertEqual((one, n1, n2), (two, 0, 0))  # away from home the hook is not asked

    def test_apply_extra_runs_last(self):
        fork = tied_fork(self.dana.id, self.sim.clock.tick)
        fork.options[0].extra = {"save": 10}
        savings = self.dana.savings
        seen = []
        with mock.patch.object(housing, "apply_extra",
                               side_effect=lambda sim, agent, f, opt: seen.append((agent.savings, f, opt))):
            self.sim._decide(self.dana, fork, 0, "model", "")
        self.assertEqual(seen, [(savings + 10, fork, fork.options[0])])

    def test_unknown_string_effects_go_to_housing(self):
        out = Outcome("x", "Something", 1.0, 0, {"fun": 1, "home_condition": -5, "delay": 30, ("rel", "yossi"): 2})
        with mock.patch.object(housing, "apply_effect", return_value=True) as effect:
            self.sim._apply_outcome(self.dana, {"fork": "f0", "outcome": out, "due": None})
        effect.assert_called_once_with(self.sim, self.dana, "home_condition", -5)

    def test_bump_reports_affinity(self):
        rel = self.dana.relationships["yossi"]
        before = rel.affinity
        with mock.patch.object(chronicle, "on_affinity") as hook:
            self.sim._bump(self.dana, "yossi", 5)
        hook.assert_called_once_with(self.sim, "dana", "yossi", before, rel.affinity)
        self.assertAlmostEqual(rel.affinity, min(100.0, before + 5))
        stranger = next(a for a in self.sim.agents.values()
                        if a.id not in self.dana.relationships and a is not self.dana)
        with mock.patch.object(chronicle, "on_affinity") as hook:
            self.sim._bump(self.dana, stranger.id, 3)
        hook.assert_called_once_with(self.sim, "dana", stranger.id, 10, 13)  # a new acquaintance starts at 10

    def test_afford_score_is_the_money_term(self):
        fork = tied_fork(self.dana.id, self.sim.clock.tick, (0.5, 0.0, 0.0, 0.0))
        with mock.patch.object(housing, "afford_score", return_value=-0.25) as afford:
            scores = default_scores(self.dana, fork, self.sim)
        self.assertEqual(scores, [0.25, -0.25, -0.25, -0.25])
        self.assertEqual(afford.call_args_list, [mock.call(self.sim, self.dana, o) for o in fork.options])

    def test_fork_you_is_merged(self):
        fork = tied_fork(self.dana.id, self.sim.clock.tick)
        with mock.patch.object(housing, "fork_you", return_value={"home": {"name": "X"}, "household_funds": 7}) as you:
            msg = self.sim.fork_message(self.dana, fork)
        you.assert_called_once_with(self.sim, self.dana)
        self.assertEqual((msg["you"]["home"], msg["you"]["household_funds"]), ({"name": "X"}, 7))

    def test_household_pays_and_charge(self):
        hh = self.sim.household(self.dana)
        fork = tied_fork(self.dana.id, self.sim.clock.tick)
        fork.options[0].cost, fork.options[0].household_pays = 100.0, True
        fork.options[0].steps = [("coffee", "cafe")]  # `paid` lasts until she gets there
        money = self.dana.money
        with mock.patch.object(housing, "pay_household") as pay:
            self.sim._decide(self.dana, fork, 0, "model", "")
        pay.assert_called_once_with(self.sim, hh, 100.0)
        self.assertEqual(self.dana.money, money)
        self.assertIsNone(self.dana.paid)
        self.assertEqual(fork.options[0].public(0), {"index": 0, "label": "Option A", "cost": 100.0, "household": True})

        fork = tied_fork(self.dana.id, self.sim.clock.tick)
        fork.options[1].cost, fork.options[1].charge = 500.0, False
        with mock.patch.object(housing, "pay_household") as pay:
            self.sim._decide(self.dana, fork, 1, "model", "")
        pay.assert_not_called()
        self.assertEqual(self.dana.money, money)  # a move pays its own way when it goes through

        fork = tied_fork(self.dana.id, self.sim.clock.tick)
        fork.options[2].cost, fork.options[2].steps = 12.0, [("coffee", "cafe")]
        self.sim._decide(self.dana, fork, 2, "model", "")
        self.assertEqual(self.dana.money, money - 12)
        self.assertEqual(self.dana.paid, ("dana", 12.0))

    def test_outcome_groups_first_hit_wins(self):
        outs = [Outcome("a", "A", 1.0, 0, {"fun": 1}, group="g"), Outcome("b", "B", 1.0, 0, {"fun": 1}, group="g"),
                Outcome("c", "C", 1.0, 0, {"fun": 1}), Outcome("d", "D", 0.0, -1, {"fun": 1}, group="h"),
                Outcome("e", "E", 1.0, 0, {"fun": 1}, group="h")]
        fork = tied_fork(self.dana.id, self.sim.clock.tick, outcomes=outs)
        self.sim._decide(self.dana, fork, 0, "model", "")
        rolled = [r["what"].split(":")[1] for r in self.sim.luck_log if r["what"].startswith(fork.id + ":")]
        self.assertEqual(rolled, ["a", "c", "e"])  # b is neither rolled nor logged; d has no chance at all
        self.assertEqual([p["outcome"].id for p in self.dana.pending_outcomes], ["a", "c", "e"])

    def test_start_plan(self):
        self.sim.start_plan(self.dana, [("coffee", "cafe"), ("work", "job")], "car")
        self.assertEqual((self.dana.vehicle, self.dana.speed, self.dana.state, self.dana.activity),
                         ("car", 4, "travelling", "coffee"))
        self.assertEqual(self.dana.plan, [("work", "job")])
        self.sim.start_plan(self.dana, [("relax_home", "home")], "hoverboard")
        self.assertEqual((self.dana.vehicle, self.dana.speed), ("walk", 1))

    def test_speeds_and_fares(self):
        self.assertEqual(sim_module.SPEEDS, {"walk": 1, "run": 2, "car": 4, "taxi": 4, "ambulance": 4, "bus": 1})
        self.assertEqual((sim_module.TAXI_FARE, sim_module.BUS_FARE, sim_module.WORK_LEAD, sim_module.SHIFT_MARGIN),
                         (12, 2, 45, 10))
        self.assertEqual((forks.OBVIOUS_MARGIN, forks.MAJOR_MARGIN), (0.45, 1.0))
        for name, spec in housing.ACTIVITIES_EXTRA.items():
            self.assertEqual(sim_module.ACTIVITIES[name].minutes, spec["minutes"])
            self.assertNotIn(name, sim_module.LEISURE)

    def test_builders_in_plan_order_resolved_lazily(self):
        self.assertEqual([b.rpartition(".")[2].removesuffix("_fork") for b in forks.BUILDERS], PLAN_BUILDERS)
        self.assertEqual([f.__name__.removesuffix("_fork") for f in forks.builders()], PLAN_BUILDERS)
        sim, dana = self.sim, self.dana
        hunt = lambda s, a: tied_fork(a.id, s.clock.tick, (0.6, 0, 0, 0), kind="house_hunt")  # noqa: E731
        with mock.patch.object(housing_forks, "house_hunt_fork", hunt), \
                mock.patch.object(forks, "BUILDERS", ["housing_forks.house_hunt_fork"]):
            fork = forks.build_fork(sim, dana)
        self.assertEqual((fork.kind, fork.major), ("house_hunt", True))


class MajorMarginTest(unittest.TestCase):
    def decided_by(self, lead: float, major: bool) -> str:
        sim = Simulation(seed=SEED)
        dana = sim.agents["dana"]
        sim.claim("dana", "bot")
        fork = tied_fork(dana.id, sim.clock.tick, (lead, 0.0, 0.0, 0.0), kind="house_hunt" if major else "test",
                         major=major)
        sim.director(dana, fork)
        return "asked" if fork.status == "asked" else fork.decided_by

    def test_major_forks_need_a_lead_of_one(self):
        self.assertEqual(self.decided_by(0.6, major=True), "asked")
        self.assertEqual(self.decided_by(0.99, major=True), "asked")
        self.assertEqual(self.decided_by(1.0, major=True), "habit")
        self.assertEqual(self.decided_by(1.1, major=True), "habit")
        self.assertEqual(self.decided_by(0.6, major=False), "habit")
        self.assertEqual(self.decided_by(0.4, major=False), "asked")

    def test_major_shows_in_the_summary(self):
        sim = Simulation(seed=SEED)
        dana = sim.agents["dana"]
        sim.director(dana, tied_fork(dana.id, sim.clock.tick, (1.1, 0, 0, 0), kind="house_hunt", major=True))
        self.assertTrue(dana.forks[-1]["major"])


# --- hidden information ----------------------------------------------------------------------------------------


class HiddenEmergencyTest(unittest.TestCase):
    def test_a_planted_emergency_never_shows(self):
        sim = Simulation(seed=SEED)
        dana = sim.agents["dana"]
        home = sim.homes[sim.household(dana).home_id]
        home.pending_emergency = {"kind": "boiler", "due": sim.clock.tick + 60}
        server = GameServer(sim)
        frames = []
        server.god = object()
        server._push = lambda ws_, text, inbox=None: frames.append(text)
        server._flush(True)
        sim.claim("dana", "bot")
        shown = {
            "get_home": server._god({"type": "get_home", "home_id": home.id}),
            "get_agent": server._god({"type": "get_agent", "agent_id": "dana"}),
            "state frame": json.loads(frames[0]),
            "fork message": sim.fork_message(dana, tied_fork(dana.id, sim.clock.tick)),
            "welcome": server._welcome_god(),
            "possessions": server._controller("bot", {"type": "query", "agent_id": "dana", "what": "possessions"}),
            "market": server._controller("bot", {"type": "query", "agent_id": "dana", "what": "market"}),
        }
        self.assertIsNone(shown["get_home"]["home"]["emergency"])
        self.assertIsNone(shown["get_agent"]["agent"]["possessions"]["home"]["emergency"])
        self.assertIsNone(shown["state frame"]["state"]["homes"][home.id]["emergency"])
        for what, msg in shown.items():
            with self.subTest(what=what):
                self.assertEqual(find_secret_keys(msg), [])
                self.assertNotIn("boiler", json.dumps(msg))

    def test_a_running_city_never_shows_secrets(self):
        """PLAN 3.13's walk over a running city: the welcome before and after, every state frame of twelve hours
        (one a minute, as the server flushes), every fork message pushed to a controller with its ack, every agent
        page and every home, and every controller query. A pending emergency is planted in every third home, and
        a controller plays everyone who lives in one, so every fork message comes with a planted emergency."""
        kind = "planted_test_emergency"
        clock = FakeClock()
        sim = Simulation(seed=SEED, now=clock)
        planted = [h for n, h in enumerate(sim.homes.values()) if n % 3 == 0 and h.household]
        for home in planted:
            home.pending_emergency = {"kind": kind, "due": sim.clock.tick + 30 * MINUTES_PER_DAY}
        played = sorted(m for h in planted for m in sim.households[h.household].member_ids)
        server = GameServer(sim)
        server.god, bot = object(), object()
        server.controllers["bot"] = bot
        for aid in played:
            self.assertTrue(sim.claim(aid, "bot"))
        pushed: list = []
        server._push = lambda ws_, text, inbox=None: pushed.append((ws_, text))
        shown = [("welcome", server._welcome_god())]
        counts = collections.Counter()
        for _ in range(12 * 60):
            sim.step()
            clock.advance(1 / TICKS_PER_REAL_SECOND)
            server._flush(True)
            for ws_, text in pushed:
                msg = json.loads(text)
                counts[msg["type"]] += 1
                shown.append((msg["type"], msg))
                if ws_ is bot and msg["type"] == "fork" and counts["fork"] % 2:  # the rest time out
                    shown.append(("ack", server._controller("bot", {"type": "choose", "fork_id": msg["fork_id"],
                                                                    "choice": 0, "reason": "test"})))
            pushed.clear()
        shown.append(("welcome", server._welcome_god()))
        for home_id in sim.homes:
            shown.append((f"get_home {home_id}", server._god({"type": "get_home", "home_id": home_id})))
        for aid in sim.agents:
            shown.append((f"get_agent {aid}", server._god({"type": "get_agent", "agent_id": aid})))
        for aid in played:
            for what in ("possessions", "attributes", "relationships", "memory", "inbox", "world", "people", "market"):
                shown.append((f"query {what}", server._controller("bot", {"type": "query", "agent_id": aid,
                                                                          "what": what})))
        self.assertGreaterEqual(counts["state"], 12)
        self.assertGreater(counts["fork"], 10)
        self.assertEqual(len([s for s in shown if s[0].startswith("get_home")]), len(sim.homes))
        self.assertTrue(all(h.pending_emergency for h in planted))  # still pending: never shown
        for what, msg in shown:
            text = json.dumps(msg)
            if find_secret_keys(msg) or kind in text:
                self.fail(f"{what}: {find_secret_keys(msg)} {kind in text}")


# --- fork shape over whole days -------------------------------------------------------------------------------


class ForkShapeTest(unittest.TestCase):
    P0_KINDS = {"invite", "work", "hunger", "sleep", "payday", "groceries", "lonely", "free_time"}
    PROBE_EVERY = 20  # minutes between probes

    def test_every_builder_gives_four_distinct_options(self):
        """Every builder in forks.builders(), called directly for every living character every PROBE_EVERY
        minutes of two days from Thursday 06:00 (so Friday's payday evening is in), on seeds 1-3."""
        scalars = (bool, int, float, str, type(None))
        seen = collections.Counter()
        for seed in (1, 2, 3):
            sim = Simulation(seed=seed)
            sim.clock.tick += 3 * MINUTES_PER_DAY  # nothing has happened yet: only the weekday changes
            for n in range(2 * MINUTES_PER_DAY):
                sim.step()
                if n % self.PROBE_EVERY:
                    continue
                for agent in sim.living():
                    for name, builder in zip(forks.BUILDERS, forks.builders()):
                        # What a builder notes on the character (payday's last_payday) is put back, so the
                        # city runs on as if nobody had asked.
                        kept = {k: v for k, v in vars(agent).items() if isinstance(v, scalars)}
                        fork = builder(sim, agent)
                        vars(agent).update(kept)
                        if fork is None:
                            continue
                        seen[fork.kind] += 1
                        labels = [o.label for o in fork.options]
                        if len(labels) != 4 or len(set(labels)) != 4:
                            self.fail(f"seed {seed} {sim.clock.stamp()} {agent.id} {fork.kind}: {labels}")
                        if name == "people.pending_fork":  # v3 L1: life's prompts build their own kinds
                            self.assertIn(fork.kind, people.PROMPTS)
                        else:
                            self.assertEqual(fork.kind, name.rpartition(".")[2].removesuffix("_fork"))
        self.assertLessEqual(self.P0_KINDS, set(seen), seen)

    def test_forks_the_run_built_have_four_options_and_the_major_flag(self):
        built = RUN["built"]  # seed 1, three days from Monday, through build_fork
        self.assertLessEqual({"work", "hunger", "sleep", "free_time"}, {f.kind for f in built})
        for fork in built:
            labels = [o.label for o in fork.options]
            major = fork.kind in housing_forks.MAJOR_KINDS or fork.kind in social_forks.KINDS  # v3 L1: social are major
            if len(set(labels)) != 4 or fork.major != major:
                self.fail(f"{fork.kind} {fork.id}: {labels}, major {fork.major}")


# --- the server -------------------------------------------------------------------------------------------------


class FramesTest(unittest.TestCase):
    def setUp(self):
        self.sim = Simulation(seed=SEED)
        self.server = GameServer(self.sim)
        self.server.god, watcher = object(), object()
        self.server.observers.add(watcher)
        self.pushed = []
        self.server._push = lambda ws_, text, inbox=None: self.pushed.append(text)

    def frame(self) -> dict:
        self.pushed.clear()
        self.server._flush(True)
        self.assertEqual(len(self.pushed), 2)
        self.assertIs(self.pushed[0], self.pushed[1])  # encoded once, sent to every view
        return json.loads(self.pushed[0])["state"]

    def test_lots_and_homes_only_when_changed_and_every_40th_frame(self):
        self.assertEqual(HOUSING_EVERY, 40)
        first = self.frame()
        self.assertEqual((first["lots"], first["homes"]), (housing.lots_json(self.sim), housing.homes_json(self.sim)))
        with_maps = [n for n in range(2, 82) if "lots" in self.frame()]
        self.assertEqual(with_maps, [40, 80])
        self.sim.lots["birch_court"].works_until = self.sim.clock.tick + 100  # builders on site: lots only
        state = self.frame()
        self.assertEqual(("lots" in state, "homes" in state), (True, False))
        self.assertTrue(state["lots"]["birch_court"]["works"])
        self.assertNotIn("lots", self.frame())
        home = next(iter(self.sim.homes.values()))
        home.emergency = {"kind": "leak", "since": self.sim.clock.tick}  # a live emergency: homes only
        state = self.frame()
        self.assertEqual(("lots" in state, "homes" in state), (False, True))
        self.assertEqual(state["homes"][home.id]["emergency"], "leak")

    def test_welcome_always_has_them(self):
        for _ in range(3):
            self.frame()
        welcome = self.server._welcome_god()
        self.assertLessEqual({"lots", "homes"}, set(welcome["state"]))
        self.assertEqual(welcome["host"], {"kind": "server", "controllers": True})
        self.assertLessEqual({"news", "headlines", "llm_log", "history"}, set(welcome))


class ServerMessagesTest(unittest.TestCase):
    def setUp(self):
        self.sim = Simulation(seed=SEED)
        self.server = GameServer(self.sim)

    def test_get_home(self):
        reply = self.server._god({"type": "get_home", "home_id": "birch_court_2b"})
        self.assertEqual(reply["type"], "home")
        self.assertEqual(reply["home"], self.sim.home_page("birch_court_2b"))
        self.assertEqual(self.server._god({"type": "get_home", "home_id": "nowhere"}),
                         {"type": "error", "error": "unknown home"})
        self.assertNotIn("get_home", GOD_ONLY)  # watchers may look too

    def test_controller_queries(self):
        self.sim.claim("tom", "bot")

        def ask(what):
            return self.server._controller("bot", {"type": "query", "agent_id": "tom", "what": what})

        self.assertEqual(ask("market")["data"], self.sim.market_json())
        self.assertEqual(set(ask("market")["data"]), {"for_sale", "for_rent"})
        world = ask("world")["data"]
        self.assertEqual(world["timetable"], transit.timetable_json())
        for pid, p in world["places"].items():
            self.assertEqual(p["district"], self.sim.town.places[pid].district)
        self.assertEqual(ask("possessions")["data"], self.sim.possessions(self.sim.agents["tom"]))


class ControllerEventsTest(unittest.IsolatedAsyncioTestCase):
    TIMEOUT = 3.0

    async def asyncSetUp(self):
        self.sim = Simulation(seed=SEED)
        self.server = GameServer(self.sim, speed=0)
        self.port = await self.server.start("127.0.0.1", 0)
        self.socks = []

    async def asyncTearDown(self):
        for s in self.socks:
            await s.close()
        await asyncio.wait_for(self.server.stop(), self.TIMEOUT)

    async def connect(self):
        sock = await asyncio.wait_for(ws.connect(f"ws://127.0.0.1:{self.port}/ws"), self.TIMEOUT)
        self.socks.append(sock)
        return sock

    async def request(self, sock, msg: dict) -> dict:
        await sock.send(json.dumps({**msg, "req_id": "r"}))
        while True:
            reply = json.loads(await asyncio.wait_for(sock.recv(), self.TIMEOUT))
            if reply.get("req_id") == "r":
                return reply

    def controller_events(self) -> list[dict]:
        return [e for e in self.sim.history if e["kind"] == "controller"]

    async def wait_until(self, cond) -> None:
        for _ in range(int(self.TIMEOUT / 0.02)):
            if cond():
                return
            await asyncio.sleep(0.02)
        self.fail("condition never came true")

    async def test_one_event_per_hello_claim_release_and_disconnect(self):
        bot = await self.connect()
        welcome = await self.request(bot, {"type": "hello", "role": "controller", "name": "bot", "model": "m" * 80,
                                           "characters": ["dana", "yossi", "noa"]})
        self.assertEqual(welcome["characters"], ["dana", "yossi", "noa"])
        self.assertEqual(self.sim.controllers, {"bot": {"model": "m" * 60, "characters": ["dana", "yossi", "noa"]}})
        joined, = self.controller_events()
        self.assertEqual((joined["tag"], joined["importance"], joined["agent"], joined["agents"]),
                         ("controller_joined", 1, None, ["dana", "yossi", "noa"]))
        self.assertEqual(joined["text"], "Dana Cohen, Yossi Cohen and Noa Cohen are now played by bot.")

        await self.request(bot, {"type": "claim", "agent_id": "ari"})
        await self.request(bot, {"type": "claim", "agent_id": "ari"})  # already his: nothing new to say
        events = self.controller_events()
        self.assertEqual(len(events), 2)
        self.assertEqual((events[1]["agent"], events[1]["agents"], events[1]["text"]),
                         ("ari", ["ari"], "Ari Ben-David is now played by bot."))

        await self.request(bot, {"type": "release", "agent_id": "noa"})
        left = self.controller_events()[-1]
        self.assertEqual((left["tag"], left["importance"], left["agents"]), ("controller_left", 0, ["noa"]))
        self.assertEqual(self.sim.controllers["bot"]["characters"], ["dana", "yossi", "ari"])

        dana = self.sim.agents["dana"]
        self.assertEqual(dana.controller, "bot")
        self.sim.director(dana, tied_fork(dana.id, self.sim.clock.tick))
        self.assertEqual(self.sim.forks[dana.fork_id].model, "m" * 60)  # the model its hello declared

        await bot.close()
        await self.wait_until(lambda: "bot" not in self.sim.controllers)
        gone = self.controller_events()[-1]
        self.assertEqual((gone["tag"], gone["importance"], gone["agents"]),
                         ("controller_left", 1, ["dana", "yossi", "ari"]))
        self.assertEqual(gone["text"], "Dana Cohen, Yossi Cohen and Ari Ben-David are no longer played by bot.")
        self.assertEqual(len(self.controller_events()), 4)
        for agent in self.sim.agents.values():
            self.assertFalse(any("played by" in m for m in agent.memory), agent.id)

    async def test_hello_of_many_names_three(self):
        bot = await self.connect()
        welcome = await self.request(bot, {"type": "hello", "role": "controller", "name": "all", "characters": "all"})
        self.assertEqual(len(welcome["characters"]), CAST_SIZE)
        joined, = self.controller_events()
        self.assertEqual(len(joined["agents"]), CAST_SIZE)
        self.assertTrue(joined["text"].endswith(f" and {CAST_SIZE - 3} others are now played by all."), joined["text"])
        self.assertIsNone(self.sim.controllers["all"]["model"])

    async def test_god_welcome(self):
        dana = self.sim.agents["dana"]
        for i in range(130):
            self.sim.event(f"Dana Cohen accepts invite {i}.", dana, tag="invite_accepted")  # importance 1
            self.sim.event(f"Dana Cohen invites someone {i}.", dana, tag="invite")  # importance 0
        for i in range(25):
            self.sim.event(f"Dana Cohen finally buys thing {i}!", dana, tag="goal_reached")  # importance 2
        self.sim._decide(dana, tied_fork(dana.id, self.sim.clock.tick), 0, "timeout", "No answer in time.")
        self.sim._decide(dana, tied_fork(dana.id, self.sim.clock.tick), 0, "habit", "Obvious.")
        god = await self.connect()
        welcome = await self.request(god, {"type": "hello", "role": "god"})
        self.assertEqual(welcome["host"], {"kind": "server", "controllers": True})
        self.assertEqual(welcome["history"], json.loads(json.dumps(self.sim.history[-80:])))
        self.assertEqual(len(welcome["news"]), 120)
        self.assertEqual(welcome["news"], json.loads(json.dumps(self.sim.news[-120:])))
        self.assertTrue(all(e["importance"] >= 1 for e in welcome["news"]))
        self.assertEqual(welcome["headlines"], json.loads(json.dumps(self.sim.headlines[-20:])))
        self.assertEqual([e["seq"] for e in welcome["headlines"]], sorted(e["seq"] for e in welcome["headlines"]))
        self.assertEqual([s["decided_by"] for s in welcome["llm_log"]], ["timeout"])
        self.assertLessEqual({"lots", "homes"}, set(welcome["state"]))
        self.assertEqual(find_secret_keys(welcome), [])


# --- the payday shopping trip --------------------------------------------------------------------------------


class PaydayShoppingTest(unittest.TestCase):
    """The shopping trip goes to the nearest shop or market that stays open for all of it (it was cut off at 21:00),
    and is offered there only while it fits before closing: Fresh Market for Dana, then a shop further away."""

    @staticmethod
    def fits(sim: Simulation, agent, place) -> bool:
        """Open when the character walks in and still open SHOP_MINUTES later (travel.nearest's stay rule)."""
        arrive = sim.clock.hour + sim.walk_minutes(agent, place.id) / 60
        return place.is_open(arrive) and place.is_open(arrive + forks.SHOP_MINUTES / 60)

    def nearest_shop(self, sim: Simulation, agent):
        fit = [(sim.walk_minutes(agent, p.id), p.id) for p in sim.town.places.values()
               if p.kind in ("shop", "market") and self.fits(sim, agent, p)]
        return sim.town.places[min(fit)[1]] if fit else None

    @staticmethod
    def shopping(fork: Fork) -> int:
        return next(i for i, o in enumerate(fork.options) if o.steps and o.steps[0][0] == "shopping")

    @staticmethod
    def last_at_market(sim: Simulation) -> int:
        """The last minute the trip to Fresh Market is offered to Dana."""
        return (sim.town.places["market"].hours[1] * 60 - sim.walk_minutes(sim.agents["dana"], "market")
                - forks.SHOP_MINUTES - 1)

    def test_shopping_is_offered_only_when_it_fits_before_closing(self):
        sim = Simulation(seed=SEED)
        dana = sim.agents["dana"]
        market = sim.town.places["market"]
        friday = 4 * MINUTES_PER_DAY

        def offer(minute: int) -> Fork | None:
            sim.clock.tick = friday + minute
            dana.last_payday, dana.money = -1, 900.0
            return payday_fork(sim, dana)

        def labels(fork: Fork | None) -> list[str]:
            return [o.label for o in fork.options] if fork else []

        offered = collections.defaultdict(list)  # place id -> the minutes the trip there is offered
        for m in range(17 * 60, 20 * 60):
            fork = offer(m)
            self.assertEqual(len(set(labels(fork))), 4)
            shop = self.nearest_shop(sim, dana)
            if shop is None:
                self.assertIn("Order something nice online", labels(fork))
                continue
            buy = fork.options[self.shopping(fork)]
            self.assertEqual((buy.label, buy.steps[0]), (f"Buy something nice at {shop.name}", ("shopping", shop.id)))
            offered[shop.id].append(m)
        last = self.last_at_market(sim)
        self.assertEqual(offered["market"], list(range(17 * 60, min(last, 20 * 60 - 1) + 1)))
        self.assertLess(last, 20 * 60 - 1)  # so the evening's last minutes go somewhere else
        late = offer(last + 1)
        self.assertNotEqual(late.options[self.shopping(late)].steps[0][1], "market")
        self.assertEqual(len(set(labels(late))), 4)
        with mock.patch.object(Simulation, "nearest", lambda *args, **kwargs: None):  # nothing fits: shop online
            nowhere = labels(offer(last + 1))
        self.assertIn("Order something nice online", nowhere)
        self.assertEqual(len(set(nowhere)), 4)

        fork = offer(last)  # the latest the trip to Fresh Market is offered: it must still fit
        self.assertEqual(fork.options[self.shopping(fork)].steps[0], ("shopping", "market"))
        sim._decide(dana, fork, self.shopping(fork), "model", "")
        shopped = 0
        for _ in range(2 * sim.walk_minutes(dana, "market") + 120):
            sim.clock.advance()
            sim._tick_agent(dana)
            if dana.activity == "shopping" and dana.state == "busy":
                shopped += 1
                self.assertTrue(market.is_open(sim.clock.hour))
            elif shopped:
                break
        self.assertEqual(shopped, forks.SHOP_MINUTES)  # the whole trip, not cut off at closing time
        self.assertEqual(sim_module.ACTIVITIES["shopping"].minutes, forks.SHOP_MINUTES)

    def ask_and_answer(self, minute: int, delay: float) -> tuple[Simulation, list[dict], int]:
        """Dana's Friday payday fork at `minute`, asked of her controller, who picks the shopping trip (to Fresh
        Market) `delay` real seconds later; returns the sim, its events and the minutes she then shops."""
        clock = FakeClock()
        sim = Simulation(seed=SEED, now=clock)
        dana = sim.agents["dana"]
        dana.owns_car = False  # on foot, as the walk-timed offer assumes (with her car she would get there in time)
        sim.clock.tick = 4 * MINUTES_PER_DAY + minute
        dana.last_payday, dana.money, dana.state, dana.plan = -1, 900.0, "idle", []
        fork = payday_fork(sim, dana)
        buy = self.shopping(fork)
        self.assertEqual(fork.options[buy].steps[0], ("shopping", "market"))
        sim.claim(dana.id, "bot")
        with mock.patch.object(sim_module, "default_scores", lambda agent, fork, sim: [0.0] * 4):
            sim.director(dana, fork)  # tied: no habit, so the controller is asked
        self.assertEqual(fork.status, "asked")
        for _ in range(int(delay * TICKS_PER_REAL_SECOND)):  # speed 1: the city goes on while the model thinks
            sim.clock.advance()
            sim._tick_agent(dana)
        clock.advance(delay)
        self.assertEqual(sim.answer(fork.id, buy, "treat myself", controller="bot"),
                         {"accepted": True, "applied": True})
        self.assertEqual(dana.money, 840.0)
        shopped = 0
        with mock.patch.object(sim_module, "build_fork", lambda sim, agent: None):  # nothing else to spend it on
            for _ in range(sim.walk_minutes(dana, "market") + 2 * forks.SHOP_MINUTES):
                sim.clock.advance()
                sim._tick_agent(dana)
                if dana.activity == "shopping" and dana.state == "busy":
                    shopped += 1
                    self.assertTrue(sim.town.places["market"].is_open(sim.clock.hour))
        events = sim.drain()[0]
        if shopped:
            self.assertEqual(dana.money, 840.0)
        else:  # called off: the money is back and nothing it promised happens
            self.assertEqual(dana.money, 900.0)
            self.assertFalse([p for p in dana.pending_outcomes if p["fork"] == fork.id])
            self.assertFalse([e for e in events if e["tag"] == "outcome" and e["agent"] == dana.id])
        return sim, events, shopped

    def test_a_late_answer_calls_off_a_trip_that_no_longer_fits(self):
        """The controller answers 4 real seconds (9 game minutes) after the last minute the trip is offered:
        Fresh Market would shut before the 45 minutes are up, so the trip is off and the $60 comes back."""
        last = self.last_at_market(Simulation(seed=SEED))
        sim, events, shopped = self.ask_and_answer(last, 4.0)
        self.assertEqual(shopped, 0)
        closed = [e for e in events if e["tag"] == "closed"]
        self.assertEqual([e["text"] for e in closed], ["Dana Cohen finds Fresh Market about to close ($60 refunded)."])
        self.assertEqual(closed[0]["place"], "market")

    def test_an_answer_that_still_fits_shops_for_the_whole_trip(self):
        last = self.last_at_market(Simulation(seed=SEED))
        delay = 4.0
        sim, events, shopped = self.ask_and_answer(last - int(delay * TICKS_PER_REAL_SECOND) + 1, delay)
        self.assertEqual(shopped, forks.SHOP_MINUTES)  # it ends as the doors shut: not cut short
        self.assertFalse([e for e in events if e["tag"] == "closed"])


class CafeClosingTest(unittest.TestCase):
    """A cafe hang-out is offered only when Corner Cafe stays open for all 90 minutes; one that no longer fits
    when the character walks in (a late answer, a slow trip) is off and refunded if it was paid for."""

    def setUp(self):
        self.sim = Simulation(seed=SEED)
        cafe = self.sim.town.places["cafe"]
        far = max((a for a in self.sim.living() if a.is_adult), key=lambda a: self.sim.walk_minutes(a, "cafe"))
        self.far, self.cafe = far, cafe
        self.walk = self.sim.walk_minutes(far, "cafe")
        self.last = cafe.hours[1] * 60 - self.walk - forks.HANG_OUT_MINUTES - 1  # the last minute it is offered
        self.assertEqual(sim_module.ACTIVITIES["hang_out"].minutes, forks.HANG_OUT_MINUTES)
        self.assertLess(self.last, 21 * 60 - 1)  # inside the free-time and lonely evenings

    def at(self, minute: int) -> None:
        self.sim.clock.tick = 2 * MINUTES_PER_DAY + minute  # Wednesday
        self.far.state, self.far.plan, self.far.cooldowns = "idle", [], {}

    def test_free_time_and_lonely_offer_the_cafe_only_while_it_fits(self):
        """Each builder's hang-out goes to the cafe nearest the character (or nearest both, with a friend) that is
        open when they walk in and for all 90 minutes; with none, or with the shift still ahead, the fixed fallback."""
        far = self.far
        far.needs["fun"], far.needs["social"], far.money = 20, 20, 500.0

        def fits(place) -> bool:
            arrive = self.sim.clock.hour + self.sim.walk_minutes(far, place.id) / 60
            return place.is_open(arrive) and place.is_open(arrive + forks.HANG_OUT_MINUTES / 60)

        offered = {"free_time": [], "lonely": []}
        expected = []
        for minute in range(9 * 60, 21 * 60):
            self.at(minute)
            cafes = [p for p in self.sim.town.places.values() if p.kind == "cafe" and fits(p)]
            if cafes and self.sim._shift_start_tick(far) is None:
                expected.append(minute)
            for kind, builder in (("free_time", forks.free_time_fork), ("lonely", forks.lonely_fork)):
                fork = builder(self.sim, far)
                if fork is None and forks.in_work_window(self.sim, far):  # package D item 11: none in that window
                    continue
                labels = [o.label for o in fork.options]
                self.assertEqual(len(set(labels)), 4, labels)
                going = [step[1] for o in fork.options for step in o.steps if step[0] == "hang_out"]
                if going:
                    offered[kind].append(minute)
                    self.assertIn(self.sim.town.places[going[0]], cafes, (kind, minute))
                    name = self.sim.town.places[going[0]].name
                    self.assertTrue(any(name in label for label in labels), labels)
                elif kind == "free_time":
                    self.assertIn("Play a board game at home", labels)
                else:
                    self.assertIn("Message a few people from home", labels)
        self.assertTrue(expected)
        for kind, minutes in offered.items():
            self.assertEqual(minutes, expected, kind)
        self.assertIn(self.last, expected)  # Corner Cafe's last minute, and later ones too: the Noodle Bar is open
        with mock.patch.object(Simulation, "nearest", lambda *args, **kwargs: None):  # every cafe shut
            self.at(self.last + 1)
            self.assertIn("Play a board game at home", [o.label for o in forks.free_time_fork(self.sim, far).options])
            self.assertIn("Message a few people from home", [o.label for o in forks.lonely_fork(self.sim, far).options])

    def decide_late(self, cost: float, minutes_late: int) -> tuple[int, list[dict]]:
        """A cafe hang-out costing `cost`, offered at the last minute and decided `minutes_late` later; returns the
        minutes spent hanging out there, and the events."""
        far = self.far
        self.at(self.last + minutes_late)
        far.money = 500.0
        fork = Fork(far.id, "test", "What now?", [Option(f"Hang out {i}", [("hang_out", "cafe")], cost=cost,
                                                         vehicle="walk",  # timed by the walk (no bus)
                                                         outcomes=[Outcome("fun", "Has fun", 1.0, +1, {"fun": 5})])
                                                  for i in range(4)], self.sim.clock.tick)
        self.sim._decide(far, fork, 0, "model", "")
        self.assertEqual(far.money, 500.0 - cost)
        minutes = 0
        with mock.patch.object(sim_module, "build_fork", lambda sim, agent: None), \
                mock.patch.object(sim_module.transit, "fare", lambda age: 0):  # the bus home is not what is weighed
            for _ in range(self.walk + forks.HANG_OUT_MINUTES + 30):
                self.sim.clock.advance()
                self.sim._tick_agent(far)
                if far.activity == "hang_out" and far.state == "busy":
                    minutes += 1
        return minutes, self.sim.drain()[0]

    def test_a_paid_hang_out_that_no_longer_fits_is_off_and_refunded(self):
        minutes, events = self.decide_late(6.0, 5)
        self.assertEqual(minutes, 0)
        self.assertEqual(self.far.money, 500.0)
        self.assertIn(f"{self.far.name} finds Corner Cafe about to close ($6 refunded).",
                      [e["text"] for e in events if e["tag"] == "closed"])
        self.assertFalse([e for e in events if e["tag"] == "outcome" and e["agent"] == self.far.id])

    def test_a_paid_hang_out_that_fits_runs_its_full_time(self):
        minutes, events = self.decide_late(6.0, 1)  # one minute later still ends as the doors shut
        self.assertEqual(minutes, forks.HANG_OUT_MINUTES)
        self.assertEqual(self.far.money, 494.0)

    def test_a_free_hang_out_still_goes_and_ends_at_closing_time(self):
        minutes, events = self.decide_late(0.0, 5)
        self.assertEqual(minutes, forks.HANG_OUT_MINUTES - 4)  # nothing to refund: they stay until closing
        self.assertFalse([e for e in events if e["tag"] == "closed"])


class ErrandTest(unittest.TestCase):
    def test_nobody_is_sent_shopping_where_the_market_shuts_first(self):
        """'Ask X to do the shopping' sends X only if Fresh Market is still open for the 20-minute shop after X's
        walk there (the $35 was spent at a shut door before)."""
        for late, sent in ((0, True), (1, False)):
            with self.subTest(late=late):
                sim = Simulation(seed=SEED)
                hh = next(h for h in sim.households.values() if sum(sim.agents[m].is_adult for m in h.member_ids) > 1)
                asker, other = [sim.agents[m] for m in hh.member_ids if sim.agents[m].is_adult][:2]
                latest = (sim.town.places["market"].hours[1] * 60 - sim.walk_minutes(other, "market")
                          - sim_module.ACTIVITIES["buy_groceries"].minutes)
                sim.clock.tick = 2 * MINUTES_PER_DAY + latest + late
                for a in (asker, other):
                    a.state, a.plan, a.activity, a.money = "idle", [], "idle", 300.0
                fork = Fork(asker.id, "test", "Who shops?", [Option(f"Ask {i}", [("relax_home", "home")],
                                                                    extra={"ask_shop": other.id}) for i in range(4)],
                            sim.clock.tick)
                sim._decide(asker, fork, 0, "model", "")
                self.assertEqual(other.activity_place == "market", sent)
                self.assertEqual(other.money, 300.0 - sim_module.GROCERY_COST if sent else 300.0)


class WorkCoffeeTest(unittest.TestCase):
    """PLAN decision 55: the work fork's third option is a coffee at the cafe on the way (at most
    forks.COFFEE_DETOUR minutes out of it) when it is open for the whole cup, otherwise "Make a coffee at home, then
    go" with the cafe option's tags, lateness by timing and no meet_new; either only while the cup fits before the
    shift (F10 of the v2 review), and with no time for one a bite to eat on the way out."""

    def setUp(self):
        self.sim = Simulation(seed=SEED)
        self.cafe = self.sim.town.places["cafe"]
        self.assertEqual(sim_module.ACTIVITIES["coffee"].minutes, forks.COFFEE_MINUTES)
        # Shifts that start so early that, when the fork first comes, Corner Cafe is still shut on arrival.
        self.early = [a for a in self.sim.living() if a.job and a.job.hourly_wage
                      and a.job.start_hour * 60 - forks.WORK_LEAD + self.sim.walk_minutes(a, "cafe")
                      < self.cafe.hours[0] * 60]
        self.assertTrue(self.early)  # the 06:00 hospital cleaner in seed 1

    def at(self, agent, minute: int) -> None:
        day = min(agent.job.workdays)
        self.sim.clock.tick = day * MINUTES_PER_DAY + minute
        agent.worked_today, agent.state, agent.plan = -1, "idle", []

    def options(self, agent, minute: int):
        self.at(agent, minute)
        fork = forks.work_fork(self.sim, agent)
        if fork is not None:
            self.assertEqual(len({o.label for o in fork.options}), 4, [o.label for o in fork.options])
        return fork

    def on_the_way(self, agent) -> list:
        """The cafes adding at most forks.COFFEE_DETOUR minutes to the walk from home to work."""
        town, job = self.sim.town, agent.job.place_id
        home = town.places[self.sim.home_of(agent)].entry
        return [c for c in town.places.values() if c.kind == "cafe"
                and town.walk_minutes(home, c.id) + (0 if c.id == job else town.walk_minutes(c.entry, job))
                <= town.walk_minutes(home, job) + forks.COFFEE_DETOUR]

    def expected_late(self, agent) -> float:
        home = self.sim.home_of(agent)
        trip = (self.sim.walk_minutes(agent, home) + forks.COFFEE_MINUTES
                + self.sim.town.walk_minutes(self.sim.town.places[home].entry, agent.job.place_id))
        late_by = trip - (agent.job.start_hour * 60 - self.sim.clock.minute_of_day)
        return max(0.0, min(0.5, late_by / 40))

    def test_an_early_shift_makes_its_coffee_at_home(self):
        for agent in self.early:
            with self.subTest(agent=agent.id):
                fork = self.options(agent, agent.job.start_hour * 60 - forks.WORK_LEAD)
                coffee = fork.options[2]
                self.assertEqual(coffee.label, "Make a coffee at home, then go")
                self.assertEqual(coffee.steps, [("coffee", "home"), ("work", "job")])
                self.assertEqual((coffee.cost, coffee.vehicle), (0, "walk"))
                self.assertNotIn("meet_new", [o.id for o in coffee.outcomes])
                late = {o.id: o.p for o in coffee.outcomes}["late"]
                self.assertEqual(late, self.expected_late(agent))
                # Later, once a cafe on the way is open, the same slot is that cafe, with the same tags. A job far
                # from every cafe (the hospital, the warehouses) keeps the cup at home all the way to the shift.
                on_the_way = self.on_the_way(agent)
                if not on_the_way:
                    start = agent.job.start_hour * 60
                    fits = start - forks.COFFEE_MINUTES - self.sim.walk_minutes(agent, agent.job.place_id)  # its last
                    self.assertEqual({self.options(agent, m).options[2].label for m in range(start - forks.WORK_LEAD,
                                                                                               fits + 1)},
                                     {coffee.label})
                    self.assertEqual({self.options(agent, m).options[2].label for m in range(fits + 1, start + 1)},
                                     {"Grab a bite to eat, then go"})
                    continue
                minute = min(c.hours[0] * 60 - self.sim.walk_minutes(agent, c.id) for c in on_the_way)
                cafe = self.options(agent, minute).options[2]
                self.assertIn(cafe.label, ["Have a coffee at work" if c.id == agent.job.place_id
                                           else f"Grab a coffee at {c.name} first" for c in on_the_way])
                self.assertEqual(cafe.tags, coffee.tags)
                self.assertNotEqual(self.options(agent, minute - 1).options[2].label, cafe.label)
        self.assertTrue([a for a in self.early if self.on_the_way(a)])  # the 06:00 baker, at Maple Bakery

    def test_lateness_follows_the_timing(self):
        """The late odds are 0 while the cup at home still gets the character in on time, and once it would not, it
        is not offered (a bite to eat instead): checked at home and standing at the cafe door, far from home."""
        agent = self.early[0]
        start = agent.job.start_hour * 60
        seen = []
        for where in ("home", "cafe door"):
            if where == "cafe door":
                agent.inside, (agent.x, agent.y) = None, self.cafe.entry
            for minute in range(start - 180, start + forks.WORK_LATE + 1):
                fork = self.options(agent, minute)
                if fork is not None and fork.options[2].steps[0] == ("snack", None):
                    self.assertGreater(self.expected_late(agent), 0, (where, minute))  # no time for the cup
                    seen.append("bite")
                if fork is None or fork.options[2].steps[0] != ("coffee", "home"):
                    continue
                late = {o.id: o.p for o in fork.options[2].outcomes}["late"]
                self.assertEqual(late, self.expected_late(agent), (where, minute))
                seen.append(late)
        self.assertIn(0.0, seen)
        self.assertIn("bite", seen)
        self.assertEqual(set(seen), {0.0, "bite"})  # the cup at home only while it gets them in on time

    def test_the_cup_must_fit_before_the_cafe_shuts(self):
        """With a shift starting an hour after Maple Bakery shuts (and the work fork opening three hours ahead, so
        the cup there would still fit before the shift), the bakery is offered up to the last minute the 15-minute
        cup still fits on arrival; after that it is the coffee at home, though the bakery is still open when they
        walk in. (Someone with only Maple Bakery on the way, so no other cafe takes its place.)"""
        bakery = self.sim.town.places["bakery"]
        agent = next(a for a in self.sim.living() if a.job and a.job.hourly_wage and self.on_the_way(a) == [bakery])
        agent.job = dataclasses.replace(agent.job, start_hour=bakery.hours[1] + 1)
        walk = self.sim.walk_minutes(agent, "bakery")
        last = bakery.hours[1] * 60 - walk - forks.COFFEE_MINUTES - 1
        start = agent.job.start_hour * 60
        cafe_minutes, home_minutes = [], []
        with mock.patch.object(forks, "WORK_LEAD", 180):
            for minute in range(start - 180, start + forks.WORK_LATE + 1):
                fork = self.options(agent, minute)
                if fork is not None:
                    (cafe_minutes if fork.options[2].steps[0] == ("coffee", "bakery") else home_minutes).append(minute)
        self.assertTrue(cafe_minutes)
        self.assertEqual(cafe_minutes[-1], last)
        self.assertEqual(home_minutes[0], last + 1)
        self.at(agent, last + 1)
        self.assertTrue(forks._open_on_arrival(self.sim, agent, "bakery"))  # open on arrival, but not for the cup


class CastDumpTest(unittest.TestCase):
    def test_the_dump_command_runs_cast_once(self):
        """`python3 -m gameofailife.cast --dump 1`: no runpy warning that the package had already imported cast."""
        out = subprocess.run([sys.executable, "-m", "gameofailife.cast", "--dump", "1"], cwd=ROOT,
                             capture_output=True, text=True, check=True)
        self.assertEqual(out.stderr, "")
        self.assertTrue(out.stdout.startswith("{"))


# --- the map and the timing ---------------------------------------------------------------------------------------


class MapInvariantsTest(unittest.TestCase):
    def test_plan_4_1_invariants(self):
        sim = RUN["sim"]
        town = sim.town
        districts = {d["id"] for d in town.map_json()["districts"]}
        for p in town.places.values():
            x, y = p.entry
            around = ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1))
            self.assertTrue(any(town.tiles[ny][nx] == ROAD for nx, ny in around
                                if 0 <= nx < town.w and 0 <= ny < town.h), p.id)
            self.assertIn(p.district, districts)
        self.assertEqual(len(town.junctions), 24)
        for y, row in enumerate(town.tiles):
            for x, c in enumerate(row):
                if c == WATER:
                    self.assertFalse(town.walkable(x, y))
        homes = [p for p in town.places.values() if p.kind == "home"]
        for home in homes:
            for place in town.places:
                self.assertLess(town.walk_minutes(home.entry, place), UNREACHABLE, (home.id, place))

    def test_paths_are_shortest_with_fewest_off_road_tiles(self):
        town = RUN["sim"].town
        rng = random.Random(7)
        tiles = [(x, y) for y in range(town.h) for x in range(town.w) if town.walkable(x, y)]
        pairs = 0
        for start in rng.sample(tiles, 10):
            best = {start: (0, 0)}
            heap = [(0, 0, start)]
            while heap:  # lexicographic Dijkstra: (steps, off-road tiles)
                steps, off, cur = heapq.heappop(heap)
                if best[cur] != (steps, off):
                    continue
                x, y = cur
                for nxt in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                    if town.walkable(*nxt):
                        key = (steps + 1, off + (town.tiles[nxt[1]][nxt[0]] != ROAD))
                        if key < best.get(nxt, (10 ** 9, 0)):
                            best[nxt] = key
                            heapq.heappush(heap, (*key, nxt))
            for goal in rng.sample(tiles, 20):
                path = town.path(start, goal)
                got = (len(path), sum(town.tiles[y][x] != ROAD for x, y in path))
                self.assertEqual(got, best[goal] if goal != start else (0, 0))
                pairs += 1
        self.assertEqual(pairs, 200)


class TimingTest(unittest.TestCase):
    def test_simulation_on_a_warm_map_is_quick(self):
        build_map(SEED).warm()
        start = time.perf_counter()
        Simulation(seed=SEED)
        self.assertLess(time.perf_counter() - start, 0.3)


if __name__ == "__main__":
    unittest.main()

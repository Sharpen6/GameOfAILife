"""The P0 foundation: the PLAN section 3 contracts, the hook seams, hidden information and frame sizes.

One three-day run of seed 1 (made once, in setUpModule) feeds the shape, event and size checks; the rest
build small scenes of their own. Ids, places and times come from the city at run time.
"""

from __future__ import annotations

import asyncio
import heapq
import json
import random
import time
import unittest
from unittest import mock

from gameofailife import chronicle, forks, housing, housing_forks, sim as sim_module, stats, transit, travel, ws
from gameofailife.cast import CAST_SIZE
from gameofailife.clock import MINUTES_PER_DAY
from gameofailife.forks import Fork, Option, Outcome, default_scores, payday_fork
from gameofailife.server import GOD_ONLY, HOUSING_EVERY, GameServer
from gameofailife.sim import ANSWER_SECONDS, Simulation
from gameofailife.town import ROAD, UNREACHABLE, WATER, build_map

SEED = 1
DAYS = 3
SECRET_KEYS = {"p", "outcomes", "odds", "probability", "probabilities", "luck_log", "scores", "valence",
               "due", "pending_emergency", "roll", "base_p", "hit"}
# Six ticks of the run whose state is measured: morning rush, midday and evening on each of the days.
SAMPLED = (8 * 60, 12 * 60 + 30, 18 * 60, MINUTES_PER_DAY + 9 * 60, 2 * MINUTES_PER_DAY + 13 * 60,
           2 * MINUTES_PER_DAY + 21 * 60)
STATE_BYTES, STATE_BYTES_LEAN = 24 * 1024, 19 * 1024
SUMMARY_KEYS = {"id", "agent", "kind", "tick", "time", "question", "options", "choice", "decided_by", "reason",
                "happened", "major", "controller", "model", "answer_seconds", "late", "profile_choice", "place"}
EVENT_KEYS = {"seq", "tick", "time", "kind", "tag", "importance", "major", "text", "agent", "agents", "place", "at"}
PLAN_BUILDERS = ["invite", "work", "hunger", "sleep", "repair", "payday", "groceries", "housing_trouble",
                 "house_hunt", "upkeep", "lonely", "free_time"]

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
        self.assertEqual([s["name"] for s in town["housing"]["stages"]], ["kept", "worn", "shabby", "neglected", "derelict"])
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
        keys = {"tick", "time", "minute", "day", "season", "weather", "lights", "plane", "buses", "agents"}
        self.assertEqual(set(state), keys | ({"lots", "homes"} if housing_maps else set()))
        self.assertNotIn("bus", state)  # replaced by buses
        self.assertIsInstance(state["buses"], list)
        self.assertEqual(set(state["lights"]), {"ns", "ew"})
        self.assertTrue(state["plane"] is None or set(state["plane"]) == {"progress", "from", "to"})
        self.assertEqual(len(state["agents"]), CAST_SIZE)
        for row in state["agents"]:
            self.assertEqual(set(row), {"id", "name", "x", "y", "inside", "state", "activity", "vehicle", "mood",
                                        "luck", "controller", "alive", "age", "home", "car", "riding"})
            self.assertTrue(all(is_int(row[k]) for k in ("x", "y", "mood", "luck", "age")))
            self.assertIn(row["vehicle"], ("walk", "run", "car", "taxi", "ambulance", "bus"))
            self.assertIn(row["home"], sim.homes)
            self.assertIsInstance(row["car"], bool)
            self.assertIsNone(row["riding"])  # no buses run until P1
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
                self.assertLessEqual(set(opt), {"index", "label", "cost", "travel_minutes", "household"})
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
            self.assertEqual(set(you["home"]), {"name", "tier", "tenure", "weekly_cost", "condition", "stage_name", "value"})
            self.assertEqual(find_secret_keys(msg), [])
        self.assertGreater(checked, 50)

    def test_travel_minutes_come_from_travel(self):
        sim = Simulation(seed=SEED)
        dana = sim.agents["dana"]
        opts = [Option("Walk to the office", [("idle", "office")]), Option("Drive to the office", [("idle", "office")], vehicle="car"),
                Option("Stay in", [("idle", "home")]), Option("Wait here", [("idle", None)])]
        fork = Fork(dana.id, "test", "?", opts, sim.clock.tick)
        msg = sim.fork_message(dana, fork)
        self.assertEqual([o.get("travel_minutes") for o in msg["options"]],
                         [travel.travel_minutes(sim, dana, "office", "walk"), travel.travel_minutes(sim, dana, "office", "car"),
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
        self.assertEqual((fork.status, fork.controller, fork.model, fork.profile_choice), ("asked", "bot", "test-model", 0))
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
            sim._decide(dana, tied_fork(dana.id, sim.clock.tick), 0, "timeout", "No answer in time; played the default.")
        self.assertEqual(len(sim.llm_log), 500)
        self.assertEqual(len(dana.llm_forks), 30)
        self.assertEqual(dana.llm_forks[-1], sim.llm_log[-1])
        sim._decide(dana, tied_fork(dana.id, sim.clock.tick), 0, "habit", "Obvious from the character's habits.")
        self.assertEqual(sim.llm_log[-1]["decided_by"], "timeout")  # habit and default stay out of the LLM log


class EventsTest(unittest.TestCase):
    def test_event_fields_and_places(self):
        sim, events = RUN["sim"], RUN["events"]
        self.assertGreater(len(events), 300)
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
        self.assertEqual(texts, ["Dana Cohen: Something (−$150).", "Dana Cohen: Something.", "Dana: Something (+$40).",
                                 "Dana: Something."])


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
        with mock.patch.object(housing, "nightly", side_effect=lambda sim: order.append("nightly")), \
                mock.patch.object(self.sim.stats, "reset_day", side_effect=lambda: (order.append("reset"), real_reset())):
            self.at(1, -1)
            self.sim.step()  # midnight
        self.assertIn("old_age", order)
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
        stranger = next(a for a in self.sim.agents.values() if a.id not in self.dana.relationships and a is not self.dana)
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


# --- fork shape over whole days -------------------------------------------------------------------------------


class ForkShapeTest(unittest.TestCase):
    def test_every_builder_gives_four_distinct_options(self):
        built = [f for f in RUN["built"] if f.tick < RUN["sim"].clock.tick - MINUTES_PER_DAY]  # seed 1, two days
        for seed in (2, 3):
            built += run_city(seed, 2)["built"]
        kinds = {f.kind for f in built}
        self.assertLessEqual({"work", "hunger", "sleep", "free_time"}, kinds)  # payday is a Friday: PaydayShoppingTest
        for fork in built:
            with self.subTest(kind=fork.kind, fork=fork.id):
                labels = [o.label for o in fork.options]
                self.assertEqual(len(labels), 4)
                self.assertEqual(len(set(labels)), 4, labels)
                self.assertEqual(fork.major, fork.kind in housing_forks.MAJOR_KINDS)


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
        ask = lambda what: self.server._controller("bot", {"type": "query", "agent_id": "tom", "what": what})  # noqa: E731
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
        self.assertEqual((gone["tag"], gone["importance"], gone["agents"]), ("controller_left", 1, ["dana", "yossi", "ari"]))
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
    """The shopping trip is offered only when Fresh Market stays open for it (it was cut off at 21:00)."""

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

        offered = [m for m in range(17 * 60, 20 * 60) if "Buy something nice for yourself" in labels(offer(m))]
        last = market.hours[1] * 60 - sim.walk_minutes(dana, "market") - forks.SHOP_MINUTES - 1
        self.assertEqual(offered, list(range(17 * 60, min(last, 20 * 60 - 1) + 1)))
        self.assertLess(last, 20 * 60 - 1)  # so the evening's last minutes offer something else
        late = labels(offer(last + 1))
        self.assertIn("Order something nice online", late)
        self.assertEqual(len(set(late)), 4)

        fork = offer(last)  # the latest the trip is offered: it must still fit
        sim._decide(dana, fork, labels(fork).index("Buy something nice for yourself"), "model", "")
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


# --- the map and the timing ---------------------------------------------------------------------------------------


class MapInvariantsTest(unittest.TestCase):
    def test_plan_4_1_invariants(self):
        sim = RUN["sim"]
        town = sim.town
        districts = {d["id"] for d in town.map_json()["districts"]}
        for p in town.places.values():
            x, y = p.entry
            self.assertTrue(any(town.tiles[ny][nx] == ROAD for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1))
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

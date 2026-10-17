"""The simulation: the world clockwork, the agents' days, and the Decision Director.

The simulation is synchronous and knows nothing about the network. The server
calls `step()` on a timer, hands controller answers to `answer()`, and drains
`outbox` (messages for controllers) and `events` (for God's view) after each step.
"""

from __future__ import annotations

import json
import random
import time
from dataclasses import dataclass, field
from typing import Callable

from .agent import NEED_DECAY, NEEDS, Agent, Household, RelationKind
from .clock import MINUTES_PER_DAY, Clock
from .forks import COOLDOWN, OBVIOUS_MARGIN, RAIN_CHANCE, Fork, build_fork, default_scores, luck_odds
from .town import ROAD_COLS, ROAD_ROWS, TownMap, build_cast, build_map

ANSWER_SECONDS = 5.0  # a controller's answer applies if it arrives within this
LEARN_SECONDS = 10.0  # a later answer is still saved and teaches the profile
INVITE_MINUTES = 120  # an unanswered invite expires after this
SPEEDS = {"walk": 1, "run": 2, "car": 3}


@dataclass
class Activity:
    minutes: int
    gains: dict[str, float] = field(default_factory=dict)  # spread evenly over the activity
    inside: bool = True  # happens inside the place (hidden from the map)


ACTIVITIES = {
    "work": Activity(0),  # lasts until the shift ends
    "sleep": Activity(0),  # lasts until morning
    "coffee": Activity(15, {"energy": 15, "social": 5}),
    "rest": Activity(240, {"energy": 30, "fun": 25}),
    "stay_up": Activity(90, {"fun": 30, "energy": -8}),
    "text": Activity(15, {"social": 12}),
    "read": Activity(40, {"fun": 14}),
    "eat_home": Activity(30, {"hunger": 60, "social": 4}),
    "buy_groceries": Activity(20, {}),
    "order_food": Activity(45, {"hunger": 50}),
    "eat_out": Activity(40, {"hunger": 55, "social": 10, "fun": 6}),
    "snack": Activity(5, {"hunger": 25}, inside=False),
    "wait": Activity(30, {}, inside=False),
    "hang_out": Activity(90, {"social": 40, "fun": 25}),
    "relax_home": Activity(60, {"fun": 25, "energy": 5}),
    "shopping": Activity(45, {"fun": 20}),
    "family_dinner": Activity(90, {"hunger": 50, "social": 30, "fun": 10}),
    "phone_call": Activity(30, {"social": 30}, inside=False),
    "walk_park": Activity(60, {"fun": 30, "social": 4}, inside=False),
    "side_project": Activity(90, {"fun": 20}),
    "idle": Activity(20, {}),
    "hospital": Activity(180, {}),
}

# How fast needs drop during some activities (default 1.0).
DECAY_SCALE = {
    "sleep": {"energy": 0.0, "hunger": 0.35, "social": 0.0, "fun": 0.0},
    "work": {"social": 0.0, "fun": 1.3, "hunger": 0.6},
    "hospital": {"social": 0.5, "fun": 0.5},
}

LIGHT_CYCLE = 6  # minutes: N-S green 0-2, yellow 2-3, E-W green 3-5, yellow 5-6
BUS_STOPS = [(3, 3), (14, 3), (25, 3), (36, 3), (36, 12), (36, 21), (25, 21), (14, 21), (3, 21), (3, 12)]
FLIGHTS = (8 * 60, 14 * 60, 20 * 60)  # daily plane from Riverton to Lakeside
FLIGHT_MINUTES = 12


def _bus_loop() -> list[tuple[int, int]]:
    """The bus drives the outer ring road clockwise, one tile per minute."""
    x0, x1, y0, y1 = ROAD_COLS[0], ROAD_COLS[-1], ROAD_ROWS[0], ROAD_ROWS[-1]
    loop = [(x, y0) for x in range(x0, x1)] + [(x1, y) for y in range(y0, y1)]
    loop += [(x, y1) for x in range(x1, x0, -1)] + [(x0, y) for y in range(y1, y0, -1)]
    return loop


BUS_LOOP = _bus_loop()
BUS_DWELL = 2  # minutes the bus waits at each stop


class Simulation:
    def __init__(self, seed: int = 1, now: Callable[[], float] = time.monotonic,
                 luck_log_path: str | None = None):
        self.seed = seed
        self.rng = random.Random(seed)
        self.now = now
        self.clock = Clock()
        self.town: TownMap = build_map(seed)
        self.agents, self.households = build_cast(self.town, seed)
        self.weather = "clear"
        self.forks: dict[str, Fork] = {}  # every fork still asked or recently decided
        self.asked_at: dict[str, float] = {}
        self.invites: dict[str, dict] = {}
        self.events: list[dict] = []  # new events since the server last drained them
        self.history: list[dict] = []  # the last few hundred events, for new God views
        self.fork_log: list[dict] = []  # decided forks since last drain
        self.outbox: list[tuple[str, dict]] = []  # (controller name, message)
        self.luck_log: list[dict] = []  # hidden: odds and rolls, never sent to anyone
        self.luck_log_path = luck_log_path
        self._invite_ids = 0
        self._bus_pos = 0
        self._bus_wait = 0
        self._roll_weather()

    # --- lookups used by the fork builders -----------------------------------

    def household(self, agent: Agent) -> Household:
        return self.households[agent.household_id]

    def home_of(self, agent: Agent) -> str:
        return self.household(agent).home_id

    def pending_invite_for(self, agent: Agent) -> dict | None:
        for inv in self.invites.values():
            if inv["to"] == agent.id and inv["status"] == "pending":
                return inv
        return None

    def on_shift_now(self, agent: Agent) -> bool:
        job = agent.job
        return bool(job and job.on_shift(self.clock.weekday, self.clock.hour) and agent.worked_today == self.clock.day
                    and agent.activity == "work")

    def living(self) -> list[Agent]:
        return [a for a in self.agents.values() if a.alive]

    # --- events ---------------------------------------------------------------

    def event(self, text: str, agent: Agent | None = None, kind: str = "life") -> None:
        ev = {"tick": self.clock.tick, "time": self.clock.stamp(), "kind": kind, "text": text,
              "agent": agent.id if agent else None}
        self.events.append(ev)
        self.history.append(ev)
        del self.history[:-300]
        if agent:
            agent.remember(self.clock.stamp(), text)

    def drain(self) -> tuple[list[dict], list[dict], list[tuple[str, dict]]]:
        out = self.events, self.fork_log, self.outbox
        self.events, self.fork_log, self.outbox = [], [], []
        return out

    # --- the main loop --------------------------------------------------------

    def step(self) -> None:
        self.clock.advance()
        m = self.clock.minute_of_day
        if m in (6 * 60, 14 * 60):
            self._roll_weather()
        if m == 0:
            self._new_day()
        if self.clock.weekday == 6 and m == 23 * 60:
            self._charge_rent()
        self._move_bus()
        self._check_timeouts()
        self._expire_invites()
        for agent in self.living():
            self._tick_agent(agent)

    def run_days(self, days: float) -> None:
        for _ in range(int(days * MINUTES_PER_DAY)):
            self.step()

    # --- world clockwork ------------------------------------------------------

    def _roll_weather(self) -> None:
        old = self.weather
        self.weather = "rain" if self.rng.random() < RAIN_CHANCE[self.clock.season] else "clear"
        if old != self.weather:
            self.event("It starts to rain." if self.weather == "rain" else "The sky clears up.", kind="weather")

    def _new_day(self) -> None:
        for agent in self.living():
            # Old age: a small daily chance from 70, which Luck softens.
            if agent.age >= 70:
                p = luck_odds(0.00005 * (agent.age - 69) ** 2, -1, agent.luck)
                self._log_roll(agent, "old_age", p, roll := self.rng.random())
                if roll < p:
                    self._die(agent, "passed away peacefully in their sleep")
        if self.clock.day % 365 == 0 and self.clock.day:
            for agent in self.living():
                agent.age += 1

    def _charge_rent(self) -> None:
        for hh in self.households.values():
            payers = [self.agents[m] for m in hh.member_ids if self.agents[m].alive and self.agents[m].is_adult]
            if not payers:
                continue
            share = hh.weekly_rent / len(payers)
            for a in payers:
                a.money -= share
            names = " and ".join(a.name.split()[0] for a in payers)
            self.event(f"{names} paid ${hh.weekly_rent:.0f} rent.", kind="money")
            for a in payers:
                if a.money < 0:
                    self.event(f"{a.name} is behind on money after rent.", a, kind="money")

    def lights(self) -> dict:
        """Traffic light phase for north-south traffic; east-west is the opposite."""
        phase = self.clock.tick % LIGHT_CYCLE
        ns = "green" if phase < 2 else "yellow" if phase < 3 else "red"
        ew = "red" if phase < 3 else "green" if phase < 5 else "yellow"
        return {"ns": ns, "ew": ew}

    def _move_bus(self) -> None:
        if self._bus_wait > 0:
            self._bus_wait -= 1
            return
        self._bus_pos = (self._bus_pos + 1) % len(BUS_LOOP)
        if BUS_LOOP[self._bus_pos] in BUS_STOPS:
            self._bus_wait = BUS_DWELL

    def bus(self) -> dict:
        x, y = BUS_LOOP[self._bus_pos]
        return {"x": x, "y": y, "stopped": self._bus_wait > 0}

    def plane(self) -> dict | None:
        m = self.clock.minute_of_day
        for dep in FLIGHTS:
            if dep <= m < dep + FLIGHT_MINUTES:
                return {"progress": round((m - dep) / FLIGHT_MINUTES, 3), "from": "Riverton", "to": "Lakeside"}
        return None

    def timetable(self) -> dict:
        return {"bus": {"route": "Ring road loop", "stops": [list(s) for s in BUS_STOPS],
                        "minutes_per_loop": len(BUS_LOOP) + BUS_DWELL * len(BUS_STOPS)},
                "flights": [f"{d // 60:02d}:{d % 60:02d} Riverton to Lakeside" for d in FLIGHTS]}

    # --- agents ---------------------------------------------------------------

    def _tick_agent(self, agent: Agent) -> None:
        self._decay(agent)
        if agent.state == "travelling":
            self._travel(agent)
        elif agent.state == "busy":
            self._do_activity(agent)
        self._apply_due_outcomes(agent)
        if not agent.alive:
            return
        if agent.health <= 0:
            self._die(agent, "collapsed and could not be saved")
            return
        if agent.state == "idle":
            self._next(agent)

    def _decay(self, agent: Agent) -> None:
        scale = DECAY_SCALE.get(agent.activity if agent.state == "busy" else "", {})
        for n in NEEDS:
            agent.adjust(n, -NEED_DECAY[n] * scale.get(n, 1.0))
        if agent.needs["hunger"] <= 0:
            agent.health -= 0.03
        if agent.needs["energy"] <= 0:
            agent.health -= 0.02
        if min(agent.needs.values()) > 40 and agent.health < 100:
            agent.health = min(100.0, agent.health + 0.004)

    def _next(self, agent: Agent) -> None:
        """Start the next planned step, or let the Director find the next decision."""
        if agent.plan:
            self._start_step(agent, *agent.plan.pop(0))
            return
        if agent.fork_id:
            self._finish_fork(agent)
        if agent.health < 25 and agent.inside != "hospital":
            self.event(f"{agent.name} feels very unwell and goes to City Hospital.", agent, kind="health")
            agent.plan = [("hospital", "hospital")]
            self._start_step(agent, *agent.plan.pop(0))
            return
        fork = build_fork(self, agent)
        if fork:
            self.director(agent, fork)
            return
        home = self.home_of(agent)
        if agent.inside != home:
            agent.plan = [("idle", "home")]
        else:
            agent.plan = [("idle", None)]
        self._start_step(agent, *agent.plan.pop(0))

    def _resolve_place(self, agent: Agent, where: str | None) -> str | None:
        if where == "home":
            return self.home_of(agent)
        if where == "job":
            return agent.job.place_id if agent.job else self.home_of(agent)
        return where

    def _start_step(self, agent: Agent, activity: str, where: str | None) -> None:
        place_id = self._resolve_place(agent, where)
        agent.activity = activity
        agent.activity_place = place_id
        if place_id and agent.inside != place_id:
            place = self.town.places[place_id]
            start = (agent.x, agent.y)
            agent.path = self.town.path(start, place.entry)
            agent.inside = None
            if agent.path:
                agent.state = "travelling"
                return
            agent.x, agent.y = place.entry
        self._begin_activity(agent)

    def _travel(self, agent: Agent) -> None:
        light = self.lights()
        for _ in range(agent.speed):
            if not agent.path:
                break
            nxt = agent.path[0]
            if agent.vehicle == "car" and nxt[0] in ROAD_COLS and nxt[1] in ROAD_ROWS:
                axis = "ns" if nxt[0] == agent.x else "ew"
                if light[axis] == "red":
                    break  # wait at the intersection
            agent.x, agent.y = agent.path.pop(0)
        if not agent.path:
            self._begin_activity(agent)

    def _begin_activity(self, agent: Agent) -> None:
        act = ACTIVITIES[agent.activity]
        place_id = agent.activity_place
        agent.state = "busy"
        agent.path = []
        if place_id:
            agent.inside = place_id if act.inside and self.town.places[place_id].kind != "park" else None
        tick = self.clock.tick
        if agent.activity == "work":
            end = agent.job.end_hour * 60 if agent.job else self.clock.minute_of_day + 60
            minutes = max(30, end - self.clock.minute_of_day)
            agent.busy_until = tick + minutes
            agent.work_started = tick  # type: ignore[attr-defined]
        elif agent.activity == "sleep":
            wake = 6 * 60 if agent.job and agent.job.start_hour <= 8 else 7 * 60
            wake += self.rng.randrange(0, 25)
            m = self.clock.minute_of_day
            minutes = (wake - m) % MINUTES_PER_DAY
            if minutes > 11 * 60 or minutes < 60:  # a nap in the daytime
                minutes = 180
            agent.busy_until = tick + minutes
        else:
            agent.busy_until = tick + act.minutes
        agent.activity_minutes = max(1, agent.busy_until - tick)  # type: ignore[attr-defined]
        if agent.activity == "eat_home":
            hh = self.household(agent)
            hh.groceries = max(0, hh.groceries - 1)

    def _do_activity(self, agent: Agent) -> None:
        act = ACTIVITIES[agent.activity]
        minutes = getattr(agent, "activity_minutes", 1)
        for need, gain in act.gains.items():
            agent.adjust(need, gain / minutes)
        if agent.activity == "sleep":
            agent.adjust("energy", 0.17)
        elif agent.activity == "hospital":
            agent.health = min(100.0, agent.health + 0.15)
        elif agent.activity == "walk_park" and self.clock.tick % 3 == 0:
            self._wander_park(agent)
        if self.clock.tick >= agent.busy_until:
            self._end_activity(agent)

    def _wander_park(self, agent: Agent) -> None:
        park = self.town.places["park"]
        x, y = agent.x + self.rng.choice((-1, 0, 1)), agent.y + self.rng.choice((-1, 0, 1))
        if park.x <= x < park.x + park.w and park.y <= y < park.y + park.h and self.town.walkable(x, y):
            agent.x, agent.y = x, y

    def _end_activity(self, agent: Agent) -> None:
        if agent.activity == "work" and agent.job:
            hours = (self.clock.tick - getattr(agent, "work_started", self.clock.tick)) / 60
            pay = round(agent.job.hourly_wage * hours, 2)
            if pay:
                agent.money += pay
                agent.week_earnings += pay
            agent.reputation = min(100.0, agent.reputation + 0.5)
        elif agent.activity == "buy_groceries":
            self.household(agent).groceries += 10
        elif agent.activity == "hospital":
            agent.money -= 50
            self.event(f"{agent.name} leaves City Hospital feeling better (paid $50).", agent, kind="health")
        elif agent.activity == "walk_park":
            park = self.town.places["park"]
            agent.x, agent.y = park.entry
        agent.state = "idle"
        agent.activity = "idle" if not agent.plan else agent.activity

    def _die(self, agent: Agent, how: str) -> None:
        agent.alive = False
        agent.state = "dead"
        agent.activity = "dead"
        agent.plan = []
        agent.path = []
        agent.inside = None
        self.event(f"{agent.name} {how}, aged {agent.age}.", agent, kind="death")
        for other_id, rel in agent.relationships.items():
            other = self.agents.get(other_id)
            if other and other.alive and rel.affinity > 30:
                other.adjust("fun", -40)
                other.adjust("social", -20)
                other.remember(self.clock.stamp(), f"Lost {agent.name}.")
        self.household(agent).member_ids = [m for m in self.household(agent).member_ids if m != agent.id]

    # --- the Decision Director -------------------------------------------------

    def director(self, agent: Agent, fork: Fork) -> None:
        fork.scores = default_scores(agent, fork)
        ranked = sorted(fork.scores, reverse=True)
        self.forks[fork.id] = fork
        if ranked[0] - ranked[1] >= OBVIOUS_MARGIN:
            self._decide(agent, fork, fork.scores.index(ranked[0]), "habit", "Obvious from the character's habits.")
        elif agent.controller:
            fork.status = "asked"
            agent.state = "deciding"
            agent.activity = "deciding"
            agent.fork_id = fork.id
            self.asked_at[fork.id] = self.now()
            self.outbox.append((agent.controller, self.fork_message(agent, fork)))
        else:
            self._decide(agent, fork, self.default_choice(fork), "default", "Played from the character's profile.")

    def default_choice(self, fork: Fork) -> int:
        noisy = [s + self.rng.uniform(0, 0.08) for s in fork.scores]
        return noisy.index(max(noisy))

    def fork_message(self, agent: Agent, fork: Fork) -> dict:
        hh = self.household(agent)
        options = []
        for i, opt in enumerate(fork.options):
            minutes = None
            first = opt.steps[0][1] if opt.steps else None
            place_id = self._resolve_place(agent, first)
            if place_id and agent.inside != place_id:
                minutes = -(-len(self.town.path((agent.x, agent.y), self.town.places[place_id].entry))
                            // SPEEDS.get(opt.vehicle, 1))
            options.append(opt.public(i, minutes))
        return {
            "type": "fork", "fork_id": fork.id, "agent_id": agent.id, "kind": fork.kind,
            "question": fork.question, "options": options, "time": self.clock.stamp(),
            "deadline_seconds": ANSWER_SECONDS, "weather": self.weather, "season": self.clock.season,
            "you": {"name": agent.name, "profile": agent.profile.prompt, "money": round(agent.money, 2),
                    "needs": {k: round(v) for k, v in agent.needs.items()}, "health": round(agent.health),
                    "where": agent.inside or "outside", "groceries_at_home": hh.groceries,
                    "goal": agent.goal, "recent_memory": agent.memory[-5:]},
        }

    def answer(self, fork_id: str, choice: int, reason: str = "", controller: str | None = None) -> dict:
        """A controller's answer. Applies within 5s; within 10s it only teaches the profile."""
        fork = self.forks.get(fork_id)
        if not fork:
            return {"accepted": False, "error": "unknown fork"}
        agent = self.agents[fork.agent_id]
        if controller is not None and agent.controller != controller:
            return {"accepted": False, "error": "not your character"}
        if not isinstance(choice, int) or isinstance(choice, bool) or not 0 <= choice < len(fork.options):
            return {"accepted": False, "error": "choice must be 0 to 3"}
        elapsed = self.now() - self.asked_at.get(fork_id, self.now())
        if fork.status == "asked" and elapsed > ANSWER_SECONDS:
            self._check_timeouts()  # the deadline passed before the next tick noticed
        if fork.status == "asked" and elapsed <= ANSWER_SECONDS:
            self._learn(agent, fork, choice, reason)
            self._decide(agent, fork, choice, "model", reason)
            return {"accepted": True, "applied": True}
        if fork.status == "decided" and fork.decided_by == "timeout" and elapsed <= LEARN_SECONDS:
            self._learn(agent, fork, choice, reason)
            fork.late_answer = {"choice": choice, "reason": reason}  # type: ignore[attr-defined]
            return {"accepted": True, "applied": False, "note": "too late to act on; saved to the profile"}
        return {"accepted": False, "error": "too late"}

    def _learn(self, agent: Agent, fork: Fork, choice: int, reason: str) -> None:
        opt = fork.options[choice]
        note = f"{fork.kind}: chose '{opt.label}'" + (f" because {reason}" if reason else "")
        agent.profile.learn(opt.tags, note[:200])
        if not agent.profile.prompt_edited:
            agent.profile.prompt = agent.profile.describe(agent)

    def _check_timeouts(self) -> None:
        now = self.now()
        for fid, asked in list(self.asked_at.items()):
            fork = self.forks.get(fid)
            if fork and fork.status == "asked" and now - asked > ANSWER_SECONDS:
                agent = self.agents[fork.agent_id]
                self._decide(agent, fork, self.default_choice(fork), "timeout", "No answer in time; played the default.")
            if now - asked > LEARN_SECONDS:
                del self.asked_at[fid]
                self.forks.pop(fid, None)

    def _decide(self, agent: Agent, fork: Fork, choice: int, by: str, reason: str) -> None:
        opt = fork.options[choice]
        fork.status, fork.choice, fork.decided_by, fork.reason = "decided", choice, by, reason
        if fork.id not in self.asked_at:
            self.forks.pop(fork.id, None)
        if not agent.alive:
            return
        agent.money -= opt.cost
        agent.vehicle = opt.vehicle if opt.vehicle in SPEEDS else "walk"
        agent.speed = SPEEDS[agent.vehicle]
        agent.plan = list(opt.steps)
        agent.fork_id = fork.id
        agent.state = "idle"
        if fork.kind in COOLDOWN:
            agent.cooldowns[fork.kind] = self.clock.tick + COOLDOWN[fork.kind]
        if any(step[0] == "work" for step in opt.steps) or opt.extra.get("skip_work"):
            agent.worked_today = self.clock.day
        self._apply_extra(agent, fork, opt)
        # Roll the hidden outcomes now; most land when the plan is done, some later.
        for out in opt.outcomes:
            if out.p <= 0:
                continue
            p = luck_odds(out.p, out.valence, agent.luck)
            roll = self.rng.random()
            self._log_roll(agent, f"{fork.id}:{out.id}", p, roll, base=out.p)
            if roll < p:
                delay = out.effects.get("delay")
                agent.pending_outcomes.append({"fork": fork.id, "outcome": out,
                                               "due": self.clock.tick + delay if delay else None})
        summary = {"id": fork.id, "agent": agent.id, "kind": fork.kind, "time": self.clock.stamp(),
                   "question": fork.question, "options": [o.label for o in fork.options],
                   "choice": choice, "decided_by": by, "reason": reason, "happened": fork.happened}
        agent.forks.append(summary)
        del agent.forks[:-20]
        self.fork_log.append(summary)
        self._next(agent)

    def _log_roll(self, agent: Agent, what: str, p: float, roll: float, base: float | None = None) -> None:
        entry = {"tick": self.clock.tick, "agent": agent.id, "luck": round(agent.luck, 1), "what": what,
                 "base_p": base, "p": round(p, 4), "roll": round(roll, 4), "hit": roll < p}
        self.luck_log.append(entry)
        del self.luck_log[:-5000]
        if self.luck_log_path:
            with open(self.luck_log_path, "a") as f:
                f.write(json.dumps(entry) + "\n")

    def _finish_fork(self, agent: Agent) -> None:
        fid = agent.fork_id
        agent.fork_id = None
        due_now = [p for p in agent.pending_outcomes if p["fork"] == fid and p["due"] is None]
        agent.pending_outcomes = [p for p in agent.pending_outcomes if p not in due_now]
        for p in due_now:
            self._apply_outcome(agent, p)

    def _apply_due_outcomes(self, agent: Agent) -> None:
        due = [p for p in agent.pending_outcomes if p["due"] is not None and p["due"] <= self.clock.tick]
        if due:
            agent.pending_outcomes = [p for p in agent.pending_outcomes if p not in due]
            for p in due:
                self._apply_outcome(agent, p)

    def _apply_outcome(self, agent: Agent, pending: dict) -> None:
        out = pending["outcome"]
        for key, value in out.effects.items():
            if key in NEEDS:
                agent.adjust(key, value)
            elif key == "money":
                agent.money += value
            elif key == "health":
                agent.health = max(0.0, min(100.0, agent.health + value))
            elif key == "reputation":
                agent.reputation = max(0.0, min(100.0, agent.reputation + value))
            elif key == "memory":
                agent.remember(self.clock.stamp(), value)
            elif key == "meet_new":
                self._meet_someone(agent)
            elif key == "family_bond":
                for m in self.household(agent).member_ids:
                    if m != agent.id and m in agent.relationships:
                        agent.relationships[m].bump(value)
                        back = self.agents[m].relationships.get(agent.id)
                        if back:
                            back.bump(value)
            elif isinstance(key, tuple) and key[0] == "rel":
                self._bump(agent, key[1], value)
        self.event(f"{agent.name.split()[0]}: {out.label}.", agent, kind="outcome")
        for summary in agent.forks:
            if summary["id"] == pending["fork"]:
                summary["happened"].append(out.label)

    def _bump(self, agent: Agent, other_id: str, value: float) -> None:
        other = self.agents.get(other_id)
        if not other:
            return
        for a, b in ((agent, other), (other, agent)):
            if b.id not in a.relationships:
                a.relate(b.id, RelationKind.ACQUAINTANCE, 10)
            a.relationships[b.id].bump(value if a is agent else value / 2)

    def _meet_someone(self, agent: Agent) -> None:
        strangers = [a for a in self.living() if a.id != agent.id and a.id not in agent.relationships
                     and (a.is_adult == agent.is_adult)]
        if not strangers:
            return
        other = self.rng.choice(strangers)
        agent.relate(other.id, RelationKind.ACQUAINTANCE, 15)
        other.relate(agent.id, RelationKind.ACQUAINTANCE, 15)
        other.remember(self.clock.stamp(), f"Met {agent.name}.")
        self.event(f"{agent.name} meets {other.name} for the first time.", agent, kind="social")

    def _apply_extra(self, agent: Agent, fork: Fork, opt) -> None:
        extra = opt.extra
        if "invite" in extra:
            inv = self.invites.get(extra["invite"])
            if inv:
                inv["status"] = extra["answer"]
                host = self.agents[inv["from"]]
                words = {"accept": "accepts", "decline": "declines", "later": "suggests another day for",
                         "ignore": "ignores"}[extra["answer"]]
                self.event(f"{agent.name} {words} {host.name.split()[0]}'s invite.", agent, kind="social")
                self._deliver(host, {"type": "invite_answer", "invite_id": inv["id"], "from": agent.id,
                                     "answer": extra["answer"]})
        if "invite_to" in extra:
            self.invite(agent, extra["invite_to"], extra["place"])
        if "save" in extra and agent.goal:
            amount = min(extra["save"], max(agent.money, 0))
            agent.money -= amount
            agent.goal["saved"] = round(agent.goal["saved"] + amount, 2)
            if agent.goal["saved"] >= agent.goal["target"]:
                self.event(f"{agent.name} finally buys {agent.goal['name']} with their savings!", agent, kind="goal")
                agent.adjust("fun", 40)
                agent.goal = None
            else:
                self.event(f"{agent.name} saves ${amount:.0f} toward {agent.goal['name']} "
                           f"(${agent.goal['saved']:.0f} of ${agent.goal['target']:.0f}).", agent, kind="money")
        elif "save" in extra:
            agent.savings = getattr(agent, "savings", 0) + extra["save"]  # type: ignore[attr-defined]
        if "ask_shop" in extra:
            other = self.agents.get(extra["ask_shop"])
            if other and other.alive and other.state == "busy" and other.activity in ("idle", "relax_home", "read"):
                other.plan = [("buy_groceries", "market"), ("relax_home", "home")]
                other.state = "idle"
                self.event(f"{other.name} heads to Fresh Market for {agent.name.split()[0]}.", other, kind="social")
        if "call" in extra:
            other = self.agents.get(extra["call"])
            if other and other.alive:
                other.adjust("social", 15)
                self.event(f"{agent.name} calls {other.name}.", agent, kind="social")
        if extra.get("family"):
            for m in self.household(agent).member_ids:
                other = self.agents[m]
                if other is not agent and other.state == "busy" and other.activity in ("idle", "relax_home", "read"):
                    other.plan = [("family_dinner", "cafe")]
                    other.state = "idle"
            self.event(f"{agent.name} takes the family out to dinner.", agent, kind="social")

    # --- invites and messages ---------------------------------------------------

    def invite(self, host: Agent, guest_id: str, place_id: str) -> dict | None:
        guest = self.agents.get(guest_id)
        if not guest or not guest.alive or place_id not in self.town.places:
            return None
        self._invite_ids += 1
        inv = {"id": f"i{self._invite_ids}", "from": host.id, "to": guest_id, "place": place_id,
               "tick": self.clock.tick, "status": "pending"}
        self.invites[inv["id"]] = inv
        place = self.town.places[place_id].name
        self.event(f"{host.name} invites {guest.name} to {place}.", host, kind="social")
        guest.inbox.append({"time": self.clock.stamp(), "from": host.id, "text": f"Want to meet at {place}?"})
        return inv

    def _expire_invites(self) -> None:
        for inv in list(self.invites.values()):
            if inv["status"] == "pending" and self.clock.tick - inv["tick"] > INVITE_MINUTES:
                inv["status"] = "expired"
            if inv["status"] != "pending" and self.clock.tick - inv["tick"] > INVITE_MINUTES * 2:
                del self.invites[inv["id"]]

    def send_message(self, from_id: str, to_id: str, text: str) -> dict:
        a, b = self.agents.get(from_id), self.agents.get(to_id)
        if not a or not b or not a.alive or not b.alive:
            return {"ok": False, "error": "unknown or dead character"}
        text = text[:500]
        b.inbox.append({"time": self.clock.stamp(), "from": a.id, "text": text})
        del b.inbox[:-30]
        a.adjust("social", 3)
        b.adjust("social", 3)
        self.event(f"{a.name} texts {b.name}: “{text[:80]}”", a, kind="message")
        self._deliver(b, {"type": "message", "from": a.id, "from_name": a.name, "to": b.id, "text": text,
                          "time": self.clock.stamp()})
        return {"ok": True}

    def _deliver(self, agent: Agent, msg: dict) -> None:
        if agent.controller:
            self.outbox.append((agent.controller, {**msg, "agent_id": agent.id}))

    # --- God's only power, and the character pages -----------------------------

    def set_luck(self, agent_id: str, luck: float) -> bool:
        agent = self.agents.get(agent_id)
        if not agent:
            return False
        agent.luck = max(0.0, min(100.0, float(luck)))
        return True

    def set_profile(self, agent_id: str, prompt: str | None = None, traits: dict | None = None) -> bool:
        agent = self.agents.get(agent_id)
        if not agent:
            return False
        for t, v in (traits if isinstance(traits, dict) else {}).items():
            if t in agent.profile.traits:
                agent.profile.traits[t] = round(max(0.0, min(1.0, float(v))), 3)
        if isinstance(prompt, str) and prompt.strip():
            agent.profile.prompt = prompt.strip()[:1000]
            agent.profile.prompt_edited = True
        elif traits and not agent.profile.prompt_edited:
            agent.profile.prompt = agent.profile.describe(agent)
        return True

    # --- controllers ------------------------------------------------------------

    def claim(self, agent_id: str, controller: str) -> bool:
        agent = self.agents.get(agent_id)
        if not agent or not agent.alive or (agent.controller and agent.controller != controller):
            return False
        agent.controller = controller
        return True

    def release(self, controller: str, agent_id: str | None = None) -> None:
        for agent in self.agents.values():
            if agent.controller == controller and (agent_id is None or agent.id == agent_id):
                agent.controller = None

    # --- snapshots ---------------------------------------------------------------

    def town_json(self) -> dict:
        return {"w": len(self.town.tiles[0]), "h": len(self.town.tiles), "tiles": self.town.rows(),
                "places": [p.to_json() for p in self.town.places.values()],
                "road_rows": list(ROAD_ROWS), "road_cols": list(ROAD_COLS), "timetable": self.timetable()}

    def state_json(self) -> dict:
        return {
            "tick": self.clock.tick, "time": self.clock.stamp(), "minute": self.clock.minute_of_day,
            "day": self.clock.day, "season": self.clock.season, "weather": self.weather,
            "lights": self.lights(), "bus": self.bus(), "plane": self.plane(),
            "agents": [{"id": a.id, "name": a.name, "x": a.x, "y": a.y, "inside": a.inside, "state": a.state,
                        "activity": a.activity, "vehicle": a.vehicle, "mood": round(a.mood), "luck": round(a.luck),
                        "controller": a.controller, "alive": a.alive, "age": a.age}
                       for a in self.agents.values()],
        }

    def agent_json(self, agent_id: str) -> dict | None:
        a = self.agents.get(agent_id)
        if not a:
            return None
        hh = self.household(a)
        return {
            "id": a.id, "name": a.name, "age": a.age, "alive": a.alive, "state": a.state,
            "activity": a.activity, "place": a.activity_place, "inside": a.inside, "luck": round(a.luck, 1),
            "money": round(a.money, 2), "health": round(a.health, 1), "mood": round(a.mood),
            "reputation": round(a.reputation), "needs": {k: round(v, 1) for k, v in a.needs.items()},
            "job": a.job.to_json() if a.job else None, "controller": a.controller,
            "profile": {"prompt": a.profile.prompt, "traits": a.profile.traits, "edited": a.profile.prompt_edited,
                        "learned": a.profile.learned},
            "possessions": a.possessions(hh, self.town.places[hh.home_id].name),
            "relationships": {oid: {**r.to_json(), "name": self.agents[oid].name}
                              for oid, r in sorted(a.relationships.items(), key=lambda kv: -kv[1].affinity)},
            "memory": a.memory[-15:], "inbox": a.inbox[-10:], "forks": a.forks[-10:],
            "household": [self.agents[m].name for m in hh.member_ids],
        }

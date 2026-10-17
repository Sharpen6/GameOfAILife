"""Decision making. A Brain looks at an agent's situation and picks what to do next.

The simulation only talks to the `Brain` protocol, so the built-in utility brain
can later be swapped (per agent) for an LLM-driven one without touching the loop.
"""

from __future__ import annotations

import random
from dataclasses import dataclass
from typing import TYPE_CHECKING, Protocol

from .activities import ACTIVITIES, Activity
from .agent import Agent, Message, RelationKind
from .clock import TICKS_PER_HOUR
from .world import PlaceKind

if TYPE_CHECKING:
    from .sim import Simulation


@dataclass
class Decision:
    activity: str
    place_id: str | None = None  # None means "where I am now"
    partner_id: str | None = None  # e.g. who to phone
    reason: str = ""


class Brain(Protocol):
    def decide(self, agent: Agent, sim: Simulation) -> Decision: ...

    def handle_message(self, agent: Agent, msg: Message, sim: Simulation) -> Message | None:
        """React to an incoming message, optionally replying."""
        ...


def urgency(level: float) -> float:
    """Low needs matter disproportionately more than mildly unmet ones."""
    return ((100 - level) / 100) ** 2


class UtilityBrain:
    """Scores every reachable (activity, place) option and picks the best, with a little noise."""

    def __init__(self, rng: random.Random, noise: float = 0.05):
        self.rng = rng
        self.noise = noise

    # --- messages ---------------------------------------------------------

    def handle_message(self, agent: Agent, msg: Message, sim: Simulation) -> Message | None:
        if msg.kind == "invite" and msg.place_id:
            rel = agent.relationships.get(msg.sender_id)
            affinity = rel.affinity if rel else 0
            busy = agent.job is not None and sim.on_shift_soon(agent, within_ticks=8)
            keen = agent.needs["social"] < 85 or affinity > 60
            if not busy and keen and agent.needs["energy"] > 20:
                agent.meetup = (msg.place_id, msg.sender_id, sim.clock.tick + 3 * TICKS_PER_HOUR)
                return Message(agent.id, msg.sender_id, sim.clock.tick, "accept", msg.place_id)
            return Message(agent.id, msg.sender_id, sim.clock.tick, "decline", msg.place_id)
        if msg.kind == "accept" and msg.place_id:
            agent.meetup = (msg.place_id, msg.sender_id, sim.clock.tick + 3 * TICKS_PER_HOUR)
        return None

    # --- choosing an activity --------------------------------------------

    def decide(self, agent: Agent, sim: Simulation) -> Decision:
        options: list[tuple[float, Decision]] = []
        for activity in ACTIVITIES.values():
            for place_id in sim.candidate_places(agent, activity):
                score = self.score(agent, activity, place_id, sim)
                if score is None:
                    continue
                score *= 1 + self.rng.uniform(-self.noise, self.noise)
                options.append((score, Decision(activity.name, place_id)))

        call = self._phone_option(agent, sim)
        if call:
            options.append(call)

        invite = self._maybe_invite(agent, sim)
        if invite:
            sim.send(invite)

        if not options:
            return Decision("idle", reason="nothing to do")
        best = max(options, key=lambda o: o[0])
        return best[1]

    def score(self, agent: Agent, activity: Activity, place_id: str, sim: Simulation) -> float | None:
        if not sim.can_do(agent, activity, place_id):
            return None
        travel = sim.travel_ticks(agent, place_id)
        duration = sim.planned_duration(agent, activity)
        total_ticks = duration + travel

        gain = 0.0
        for need, per_tick in activity.effects.items():
            level = agent.needs[need]
            delta = per_tick * duration
            delta = min(delta, 100 - level) if delta > 0 else delta
            weight = urgency(level)
            if need == "social":
                weight *= 0.5 + agent.sociability
            gain += weight * delta / 100

        if activity.name == "eat_home" or activity.name == "eat_out":
            gain *= 1.3  # food is the most basic need
        if activity.name == "buy_groceries":
            stock = sim.household(agent).groceries
            gain += max(0, 4 - stock) * 0.12 + (0.1 if stock < 2 else 0)
        if activity.name == "sleep":
            hour = sim.clock.hour
            night = hour >= 22 or hour < 6
            gain *= 1.6 if night else 0.5
        if activity.name == "work":
            gain += 0.55 + 0.6 * agent.diligence + (0.3 if agent.money < 50 else 0)
        if activity.social and agent.meetup and agent.meetup[0] == place_id:
            gain += 0.6
        elif activity.name == "hang_out":
            company = sim.friends_at(agent, place_id)
            gain += 0.15 * len(company)

        cost = activity.cost + sim.fare(agent, place_id)
        if cost:
            gain -= cost / max(agent.money, 20) * (0.3 + agent.frugality)

        return gain / max(total_ticks, 1) * min(duration, 4)

    def _phone_option(self, agent: Agent, sim: Simulation) -> tuple[float, Decision] | None:
        if agent.needs["social"] > 55 or sim.clock.hour < 8 or sim.clock.hour >= 22:
            return None
        contacts = [(r.affinity, oid) for oid, r in agent.relationships.items() if r.affinity > 20]
        if not contacts:
            return None
        _, who = max(contacts)
        score = urgency(agent.needs["social"]) * 0.06 * (0.5 + agent.sociability) * 4
        return score, Decision("phone_call", partner_id=who, reason="catching up")

    def _maybe_invite(self, agent: Agent, sim: Simulation) -> Message | None:
        hour = sim.clock.hour
        if agent.meetup or agent.needs["social"] > 60 or not (9 <= hour < 20):
            return None
        if sim.on_shift_soon(agent, within_ticks=8):
            return None
        if self.rng.random() > 0.25 + 0.5 * agent.sociability:
            return None
        candidates = [
            (r.affinity, oid)
            for oid, r in agent.relationships.items()
            if r.kind != RelationKind.CHILD and r.affinity > 10 and oid not in sim.household(agent).member_ids
        ]
        if not candidates:
            return None
        _, who = max(candidates, key=lambda c: c[0] + self.rng.uniform(0, 30))
        venues = sim.city.of_kind(PlaceKind.CAFE) + sim.city.of_kind(PlaceKind.PARK)
        venue = min(venues, key=lambda p: sim.city.distance(agent.location_id, p.id))
        return Message(agent.id, who, sim.clock.tick, "invite", venue.id, f"Meet at {venue.name}?")

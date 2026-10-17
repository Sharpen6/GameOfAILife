"""The core loop: advance the clock, deliver messages, let every agent live one tick."""

from __future__ import annotations

import math
import random
from dataclasses import dataclass, field

from .activities import ACTIVITIES, GROCERY_MEALS, Activity
from .agent import NEED_DECAY, Agent, Household, Message, RelationKind, Relationship
from .brain import Brain, Decision
from .clock import MINUTES_PER_TICK, TICKS_PER_DAY, TICKS_PER_HOUR, Clock
from .world import BUS, CAR, WALK, City, TransportMode


@dataclass
class Event:
    tick: int
    stamp: str
    agent_id: str | None
    text: str


@dataclass
class Simulation:
    city: City
    agents: dict[str, Agent]
    households: dict[str, Household]
    brains: dict[str, Brain]
    rng: random.Random
    clock: Clock = field(default_factory=Clock)
    events: list[Event] = field(default_factory=list)
    outbox: list[Message] = field(default_factory=list)
    verbose: bool = False

    # --- queries used by brains ------------------------------------------

    def household(self, agent: Agent) -> Household:
        return self.households[agent.household_id]

    def home_of(self, agent: Agent) -> str:
        return self.household(agent).home_id

    def on_shift_soon(self, agent: Agent, within_ticks: int) -> bool:
        if agent.job is None:
            return False
        for t in range(within_ticks + 1):
            tick = self.clock.tick + t
            hour = (tick % TICKS_PER_DAY) / TICKS_PER_HOUR
            if agent.job.on_shift((tick // TICKS_PER_DAY) % 7, hour):
                return True
        return False

    def candidate_places(self, agent: Agent, activity: Activity) -> list[str]:
        if activity.own_place:
            if activity.name == "work":
                return [agent.job.workplace_id] if agent.job else []
            return [self.home_of(agent)]
        return [p.id for kind in activity.place_kinds for p in self.city.of_kind(kind)]

    def choose_mode(self, agent: Agent, place_id: str) -> TransportMode:
        dist = self.city.distance(agent.location_id, place_id)
        if dist < 1.2:
            return WALK
        if agent.owns_car:
            return CAR
        if agent.money >= BUS.fare:
            return BUS
        return WALK

    def travel_ticks(self, agent: Agent, place_id: str) -> int:
        if place_id == agent.location_id:
            return 0
        minutes = self.city.travel_minutes(agent.location_id, place_id, self.choose_mode(agent, place_id))
        return math.ceil(minutes / MINUTES_PER_TICK)

    def fare(self, agent: Agent, place_id: str) -> float:
        if place_id == agent.location_id:
            return 0.0
        return self.choose_mode(agent, place_id).fare

    def planned_duration(self, agent: Agent, activity: Activity) -> int:
        if activity.name == "work" and agent.job:
            remaining = (agent.job.end_hour - self.clock.hour) * TICKS_PER_HOUR
            return max(1, math.ceil(remaining))
        if activity.name == "sleep":
            missing = 100 - agent.needs["energy"]
            return max(4, min(activity.duration, math.ceil(missing / activity.effects["energy"])))
        return activity.duration

    def can_do(self, agent: Agent, activity: Activity, place_id: str) -> bool:
        place = self.city.places[place_id]
        arrival_tick = self.clock.tick + self.travel_ticks(agent, place_id)
        arrival_hour = (arrival_tick % TICKS_PER_DAY) / TICKS_PER_HOUR
        if not place.is_open(arrival_hour):
            return False
        if agent.money < activity.cost + self.fare(agent, place_id):
            return False
        if activity.name == "eat_home" and self.household(agent).groceries <= 0:
            return False
        if activity.name == "eat_home" and agent.needs["hunger"] > 80:
            return False
        if activity.name == "eat_out" and agent.needs["hunger"] > 75:
            return False
        if activity.name == "sleep" and agent.needs["energy"] > 85:
            return False
        if activity.name == "buy_groceries" and agent.age < 16:
            return False
        if activity.name == "work":
            day = (arrival_tick // TICKS_PER_DAY) % 7
            if not agent.job or not agent.job.on_shift(day, arrival_hour):
                return False
        return True

    def friends_at(self, agent: Agent, place_id: str) -> list[str]:
        return [
            oid
            for oid in self.city.places[place_id].occupants
            if oid != agent.id and oid in agent.relationships and agent.relationships[oid].affinity > 20
        ]

    # --- actions ----------------------------------------------------------

    def log(self, agent: Agent | None, text: str) -> None:
        ev = Event(self.clock.tick, self.clock.stamp(), agent.id if agent else None, text)
        self.events.append(ev)
        if agent:
            agent.remember(f"{ev.stamp}: {text}")
        if self.verbose:
            who = f"{agent.name}: " if agent else ""
            print(f"[{ev.stamp}] {who}{text}")

    def send(self, msg: Message) -> None:
        self.outbox.append(msg)

    def _deliver_messages(self) -> None:
        pending, self.outbox = self.outbox, []
        for msg in pending:
            sender, recipient = self.agents[msg.sender_id], self.agents[msg.recipient_id]
            if msg.kind == "invite":
                self.log(sender, f"invited {recipient.name} to {self.city.places[msg.place_id].name}")
            elif msg.kind in ("accept", "decline"):
                self.log(sender, f"{msg.kind}ed {recipient.name}'s invitation")
            reply = self.brains[recipient.id].handle_message(recipient, msg, self)
            if reply:
                self.send(reply)

    def _move(self, agent: Agent, place_id: str) -> None:
        self.city.places[agent.location_id].occupants.discard(agent.id)
        agent.location_id = place_id
        self.city.places[place_id].occupants.add(agent.id)

    def _begin(self, agent: Agent, decision: Decision) -> None:
        tick = self.clock.tick
        if decision.activity == "idle":
            agent.activity, agent.busy_until = "idle", tick + 1
            return
        activity = ACTIVITIES[decision.activity]
        place_id = decision.place_id or agent.location_id

        if place_id != agent.location_id:
            mode = self.choose_mode(agent, place_id)
            agent.money -= mode.fare
            agent.travel_to, agent.pending = place_id, decision.activity
            agent.activity = f"travelling by {mode.name}"
            agent.busy_until = tick + max(1, self.travel_ticks(agent, place_id))
            self.city.places[agent.location_id].occupants.discard(agent.id)
            return

        agent.money -= activity.cost
        agent.activity, agent.activity_place = activity.name, place_id
        agent.busy_until = tick + self.planned_duration(agent, activity)
        place = self.city.places[place_id]

        if activity.name == "eat_home":
            self.household(agent).groceries -= 1
        elif activity.name == "buy_groceries":
            self.household(agent).groceries += GROCERY_MEALS
            self.log(agent, f"bought groceries at {place.name} (${activity.cost:.0f})")
        elif activity.name == "phone_call" and decision.partner_id:
            other = self.agents[decision.partner_id]
            other.adjust_need("social", 5)
            for a, b in ((agent, other), (other, agent)):
                if b.id in a.relationships:
                    a.relationships[b.id].bump(1.5)
            self.log(agent, f"phoned {other.name}")
        elif activity.name == "work":
            self.log(agent, f"started {'school' if agent.job and agent.job.hourly_wage == 0 else 'work'} at {place.name}")
        elif activity.name in ("eat_out", "hang_out"):
            self.log(agent, f"{activity.name.replace('_', ' ')} at {place.name}")
        self._apply(agent, activity)

    def _apply(self, agent: Agent, activity: Activity) -> None:
        for need, delta in activity.effects.items():
            agent.adjust_need(need, delta)
        if activity.name == "work" and agent.job:
            agent.money += agent.job.hourly_wage / TICKS_PER_HOUR
        if activity.social:
            self._socialise(agent, activity)

    def _socialise(self, agent: Agent, activity: Activity) -> None:
        place = self.city.places[agent.location_id]
        for oid in place.occupants:
            other = self.agents[oid]
            if oid == agent.id or other.activity not in ACTIVITIES or not ACTIVITIES[other.activity].social:
                continue
            rel = agent.relationships.get(oid)
            if rel:
                rel.bump(0.25 * (0.5 + agent.sociability))
                if rel.kind == RelationKind.ACQUAINTANCE and rel.affinity >= 35:
                    rel.kind = RelationKind.FRIEND
                    self.log(agent, f"became friends with {other.name}")
            elif self.rng.random() < 0.03 * (0.5 + agent.sociability):
                kind = RelationKind.COWORKER if activity.name == "work" else RelationKind.ACQUAINTANCE
                agent.relate(oid, kind, 10)
                other.relationships.setdefault(agent.id, Relationship(kind, 10))
                self.log(agent, f"met {other.name} at {place.name}")

        if agent.meetup and agent.meetup[0] == place.id and agent.meetup[1] in place.occupants:
            other = self.agents[agent.meetup[1]]
            agent.adjust_need("social", 10)
            if other.id in agent.relationships:
                agent.relationships[other.id].bump(3)
            self.log(agent, f"met up with {other.name} at {place.name}")
            agent.meetup = None

    def _economy(self) -> None:
        """Weekly rent, split across the earning adults of each household."""
        if self.clock.tick == 0 or self.clock.tick % (7 * TICKS_PER_DAY) != 0:
            return
        for hh in self.households.values():
            payers = [self.agents[m] for m in hh.member_ids if self.agents[m].age >= 18]
            share = hh.weekly_rent / max(len(payers), 1)
            for p in payers:
                p.money -= share
                self.log(p, f"paid ${share:.0f} rent" + (" and is now in debt" if p.money < 0 else ""))

    # --- the loop ---------------------------------------------------------

    def step(self) -> None:
        tick = self.clock.tick
        self._economy()
        self._deliver_messages()
        for agent in self.agents.values():
            asleep = agent.activity == "sleep"
            for need, rate in NEED_DECAY.items():
                if asleep and need == "energy":
                    continue
                agent.adjust_need(need, -rate * (0.35 if asleep else 1))
            if agent.meetup and agent.meetup[2] < tick:
                agent.meetup = None

            if agent.busy_until > tick:
                if not agent.in_transit and agent.activity in ACTIVITIES:
                    self._apply(agent, ACTIVITIES[agent.activity])
                continue

            if agent.in_transit:
                dest, pending = agent.travel_to, agent.pending
                agent.travel_to = agent.pending = None
                self._move(agent, dest)
                activity = ACTIVITIES[pending]
                if self.can_do(agent, activity, dest):
                    self._begin(agent, Decision(pending, dest))
                    continue

            self._begin(agent, self.brains[agent.id].decide(agent, self))
        self.clock.advance()

    def run(self, days: float) -> None:
        for _ in range(int(days * TICKS_PER_DAY)):
            self.step()

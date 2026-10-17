"""Agents: who they are, what they need, what they own and whom they know."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum

# Needs run from 0 (desperate) to 100 (fully satisfied).
NEED_NAMES = ("hunger", "energy", "social", "fun")

# How much each need drops per tick when nothing is done about it.
NEED_DECAY = {"hunger": 1.0, "energy": 0.55, "social": 0.35, "fun": 0.45}


@dataclass
class Job:
    title: str
    workplace_id: str
    hourly_wage: float
    start_hour: int
    end_hour: int
    workdays: tuple[int, ...] = (0, 1, 2, 3, 4)  # Mon..Fri

    def on_shift(self, weekday: int, hour: float) -> bool:
        return weekday in self.workdays and self.start_hour <= hour < self.end_hour


@dataclass
class Household:
    """People who share a home, a fridge and the rent."""

    id: str
    home_id: str
    weekly_rent: float
    groceries: int = 6  # meals stocked at home
    member_ids: list[str] = field(default_factory=list)


class RelationKind(str, Enum):
    PARTNER = "partner"
    PARENT = "parent"
    CHILD = "child"
    SIBLING = "sibling"
    FRIEND = "friend"
    COWORKER = "coworker"
    ACQUAINTANCE = "acquaintance"


@dataclass
class Relationship:
    kind: RelationKind
    affinity: float  # -100 .. 100

    def bump(self, amount: float) -> None:
        self.affinity = max(-100.0, min(100.0, self.affinity + amount))


@dataclass
class Message:
    sender_id: str
    recipient_id: str
    sent_tick: int
    kind: str  # "invite", "accept", "decline", "chat"
    place_id: str | None = None
    text: str = ""


@dataclass
class Agent:
    id: str
    name: str
    age: int
    household_id: str
    location_id: str
    money: float = 100.0
    job: Job | None = None
    owns_car: bool = False
    # Personality traits in 0..1 shape how the brain weighs options.
    sociability: float = 0.5
    diligence: float = 0.5
    frugality: float = 0.5
    needs: dict[str, float] = field(
        default_factory=lambda: {n: 75.0 for n in NEED_NAMES}
    )
    relationships: dict[str, Relationship] = field(default_factory=dict)
    inbox: list[Message] = field(default_factory=list)
    # Accepted plan to meet someone: (place_id, other_agent_id, expires_tick).
    meetup: tuple[str, str, int] | None = None
    # What the agent is doing right now (set by the simulation).
    activity: str = "idle"
    activity_place: str | None = None
    busy_until: int = 0
    travel_to: str | None = None
    pending: str | None = None  # activity to start on arrival
    memory: list[str] = field(default_factory=list)

    def relate(self, other_id: str, kind: RelationKind, affinity: float) -> None:
        self.relationships[other_id] = Relationship(kind, affinity)

    def adjust_need(self, need: str, delta: float) -> None:
        self.needs[need] = max(0.0, min(100.0, self.needs[need] + delta))

    def remember(self, line: str, limit: int = 50) -> None:
        self.memory.append(line)
        if len(self.memory) > limit:
            del self.memory[0]

    @property
    def in_transit(self) -> bool:
        return self.travel_to is not None

    @property
    def wellbeing(self) -> float:
        return sum(self.needs.values()) / len(self.needs)

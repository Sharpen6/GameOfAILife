"""Characters: who they are, what they need, own and know, and how they play by default."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum

NEEDS = ("hunger", "energy", "social", "fun")

# Points lost per game minute while awake.
NEED_DECAY = {"hunger": 0.09, "energy": 0.065, "social": 0.035, "fun": 0.045}

START_LUCK = 50.0


class RelationKind(str, Enum):
    PARTNER = "partner"
    FAMILY = "family"
    FRIEND = "friend"
    COWORKER = "coworker"
    ACQUAINTANCE = "acquaintance"


@dataclass
class Relationship:
    kind: RelationKind
    affinity: float  # -100 .. 100
    trust: float = 50.0

    def bump(self, amount: float) -> None:
        self.affinity = max(-100.0, min(100.0, self.affinity + amount))

    def to_json(self) -> dict:
        return {"kind": self.kind.value, "affinity": round(self.affinity), "trust": round(self.trust)}


@dataclass
class Job:
    title: str
    place_id: str
    hourly_wage: float
    start_hour: int
    end_hour: int
    workdays: tuple[int, ...]

    def on_shift(self, weekday: int, hour: float) -> bool:
        return weekday in self.workdays and self.start_hour <= hour < self.end_hour

    def to_json(self) -> dict:
        return {"title": self.title, "place": self.place_id, "hourly_wage": self.hourly_wage,
                "hours": [self.start_hour, self.end_hour], "workdays": list(self.workdays)}


@dataclass
class Household:
    id: str
    home_id: str
    weekly_rent: float
    groceries: int = 8  # meals in the fridge
    member_ids: list[str] = field(default_factory=list)


@dataclass
class Profile:
    """The character's default play style.

    `traits` drive the Decision Director's default answers; `prompt` is the
    plain-language version shown on the character page and sent to controllers.
    Both update as the character's controller makes choices.
    """

    TRAITS = ("thrift", "family", "social", "diligence", "health", "adventure")

    traits: dict[str, float]
    prompt: str = ""
    prompt_edited: bool = False  # the player wrote the prompt by hand
    learned: list[str] = field(default_factory=list)

    def learn(self, tags: dict[str, float], note: str, rate: float = 0.04) -> None:
        for trait, value in tags.items():
            if trait in self.traits:
                self.traits[trait] = round(max(0.0, min(1.0, self.traits[trait] + rate * value)), 3)
        self.learned.append(note)
        del self.learned[:-10]

    def describe(self, agent: Agent) -> str:
        t = self.traits
        words = {
            "thrift": ("careful with money", "spends freely"),
            "family": ("puts family first", "values independence"),
            "social": ("loves company", "enjoys time alone"),
            "diligence": ("never late for work", "takes work lightly"),
            "health": ("looks after their health", "ignores their health"),
            "adventure": ("tries new things", "sticks to routine"),
        }
        strong = sorted(t, key=lambda k: abs(t[k] - 0.5), reverse=True)[:4]
        parts = [words[k][0] if t[k] >= 0.5 else words[k][1] for k in strong]
        role = agent.job.title if agent.job else "retired"
        return f"{agent.name}, {agent.age}, {role}. " + ", ".join(parts).capitalize() + "."


@dataclass
class Agent:
    id: str
    name: str
    age: int
    household_id: str
    money: float
    job: Job | None
    owns_car: bool
    x: int
    y: int
    profile: Profile
    inside: str | None = None  # place id when inside a building
    luck: float = START_LUCK
    health: float = 90.0
    reputation: float = 50.0  # at work or school
    needs: dict[str, float] = field(default_factory=lambda: {n: 75.0 for n in NEEDS})
    relationships: dict[str, Relationship] = field(default_factory=dict)
    goal: dict | None = None  # {"name", "target", "saved"}
    controller: str | None = None  # name of the connected controller, if any
    # Movement and activity state, run by the simulation.
    state: str = "idle"  # idle, deciding, travelling, busy
    activity: str = "idle"
    activity_place: str | None = None
    busy_until: int = 0
    path: list[tuple[int, int]] = field(default_factory=list)
    speed: int = 1  # tiles per minute while travelling
    vehicle: str = "walk"
    plan: list = field(default_factory=list)  # remaining (activity, place) steps
    fork_id: str | None = None  # the fork whose choice is being carried out
    alive: bool = True
    cooldowns: dict[str, int] = field(default_factory=dict)  # fork kind -> tick it may come up again
    pending_outcomes: list = field(default_factory=list)
    worked_today: int = -1  # day number of the last shift started
    last_payday: int = -1
    week_earnings: float = 0.0
    memory: list[str] = field(default_factory=list)
    inbox: list[dict] = field(default_factory=list)
    forks: list[dict] = field(default_factory=list)  # recent decided forks

    def relate(self, other_id: str, kind: RelationKind, affinity: float) -> None:
        self.relationships[other_id] = Relationship(kind, affinity)

    def adjust(self, need: str, delta: float) -> None:
        self.needs[need] = max(0.0, min(100.0, self.needs[need] + delta))

    def remember(self, stamp: str, text: str) -> None:
        self.memory.append(f"{stamp}: {text}")
        del self.memory[:-60]

    @property
    def is_adult(self) -> bool:
        return self.age >= 18

    @property
    def mood(self) -> float:
        return sum(self.needs.values()) / len(self.needs)

    def possessions(self, household: Household, home_name: str) -> dict:
        return {
            "home": {"place": household.home_id, "name": home_name, "tenure": "rented",
                     "weekly_rent": household.weekly_rent},
            "car": self.owns_car,
            "phone": {"condition": "cracked" if self.goal and "phone" in self.goal["name"] else "fine"},
            "money": round(self.money, 2),
            "savings_goal": self.goal,
            "groceries_at_home": household.groceries,
        }

    def attributes(self) -> dict:
        return {
            "age": self.age,
            "health": round(self.health),
            "mood": round(self.mood),
            "needs": {k: round(v) for k, v in self.needs.items()},
            "reputation": round(self.reputation),
            "job": self.job.to_json() if self.job else None,
            "traits": dict(self.profile.traits),
        }

"""The chronicle: every event's tag, kind and importance, and how decision outcomes are classified.

Each event the simulation logs carries a `tag` from EVENT_TAGS. The tag gives the event's default `kind`
and `importance` (0 routine, 1 notable, 2 major; `major` is importance 2). The News tab's topic chips
come from TOPIC_OF_TAG. Outcome events are classified from their effects by `outcome_tag`, with the
money amount appended to the text.

Pure data and pure functions, except `on_affinity`, the friendship rule run after every relationship bump.
Nothing here imports the simulation or the engine (not even `agent` or `clock`), so `sim.py` can import this
module, and `chronicle.js` is a line-by-line port.
"""

from __future__ import annotations

import math
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .sim import Simulation

BIG_MONEY = 150  # an outcome that moves at least this much money is major news
MONEY_SWING = 40  # ... and at least this much is notable
INJURY = -8  # an outcome whose health effect is this or worse is an injury
FRIEND_AT = 40  # an acquaintance or coworker becomes a friend when affinity rises to this
RIFT_AT = 0  # a friend or partner falls out when affinity drops below this
RIFT_GAP_DAYS = 7  # at most one falling-out per pair in this many game days
TICKS_PER_DAY = 24 * 60  # a tick is a game minute (clock.MINUTES_PER_DAY; not imported, see the module docstring)

# tag -> (kind, default importance). Every event uses one of these tags; a call may override importance.
EVENT_TAGS: dict[str, tuple[str, int]] = {
    # life and death
    "death": ("death", 2),
    "hospital": ("health", 2),
    "discharged": ("health", 1),
    # outcomes of decisions, picked by outcome_tag()
    "injury": ("outcome", 1),
    "big_money": ("outcome", 2),
    "money_swing": ("outcome", 1),
    "outcome": ("outcome", 0),
    # money
    "goal_reached": ("goal", 2),
    "saving": ("money", 0),
    "bills_paid": ("money", 0),  # rent or property tax, and bills
    "pension": ("money", 0),
    "in_the_red": ("money", 1),
    "in_the_red_again": ("money", 2),
    "hardship": ("money", 1),
    "help_given": ("money", 2),
    "car_sold": ("money", 1),
    "stuff_sold": ("money", 1),
    "richest": ("money", 2),  # God-only (remember=False)
    # people
    "first_meet": ("social", 1),
    "new_friend": ("social", 2),
    "falling_out": ("social", 2),
    "invite": ("social", 0),
    "invite_accepted": ("social", 1),
    "invite_declined": ("social", 0),  # decline, another day, ignore
    "meetup": ("social", 0),
    "family_dinner": ("social", 1),
    "errand": ("social", 0),
    "call": ("social", 0),
    "text": ("message", 0),
    # the world
    "weather": ("weather", 0),
    "closed": ("life", 0),  # a place shut on arrival
    # homes
    "home_bought": ("home", 2),
    "home_rented": ("home", 2),
    "evicted": ("home", 2),
    "forced_sale": ("home", 2),
    "nowhere_to_go": ("home", 2),
    "home_listed": ("home", 2),
    "neglect": ("home", 2),
    "falling_apart": ("home", 2),
    "shabby": ("home", 1),
    "restored": ("home", 1),
    "too_late": ("home", 1),
    "emergency": ("home", 1),
    "emergency_settled": ("home", 0),
    "repaint": ("home", 0),
    "damp_chill": ("health", 1),
    # AI players, God-only (remember=False)
    "controller_joined": ("controller", 1),
    "controller_left": ("controller", 1),  # importance 0 for a single release
    # reserved for the areas that add jobs, romance, births and growing up; nothing emits them yet
    "job_new": ("life", 2),
    "job_lost": ("life", 2),
    "promotion": ("life", 2),
    "retired": ("life", 2),
    "partner": ("social", 2),
    "breakup": ("social", 2),
    "wedding": ("social", 2),
    "birth": ("life", 2),
    "moved_out": ("home", 2),
    "came_of_age": ("life", 1),
    # the fallback; a test keeps it unused
    "other": ("life", 0),
}

# Lines only God may see: never written into a character's memory, whatever the call says.
GOD_ONLY_TAGS = frozenset({"richest", "controller_joined", "controller_left"})

# Outcome events naming the character in full ("Dana Cohen: ..."); the rest use the first name ("Dana: ...").
FULL_NAME_TAGS = frozenset({"big_money", "injury"})

# The News tab's topic chips, in display order: (id, label).
TOPICS = (("homes", "Homes"), ("money", "Money"), ("people", "People"), ("health", "Health"), ("ai", "AI"))
TOPIC_OF_KIND = {"home": "homes", "money": "money", "goal": "money", "social": "people", "message": "people",
                 "health": "health", "death": "health", "controller": "ai"}
_TOPIC_BY_TAG = {"injury": "health", "big_money": "money", "money_swing": "money"}  # outcome tags with a topic
# tag -> topic chip id, or None for tags no chip covers (weather, plain outcomes, life).
TOPIC_OF_TAG: dict[str, str | None] = {tag: _TOPIC_BY_TAG.get(tag, TOPIC_OF_KIND.get(kind))
                                       for tag, (kind, _) in EVENT_TAGS.items()}


def _spec(tag: str) -> tuple[str, int]:
    spec = EVENT_TAGS.get(tag)
    if spec is None:
        raise KeyError(f"unknown event tag {tag!r}: add it to chronicle.EVENT_TAGS first")
    return spec


def kind_of(tag: str) -> str:
    """The kind an event with this tag gets when the call names none."""
    return _spec(tag)[0]


def importance_of(tag: str) -> int:
    """The default importance of a tag: 0 routine, 1 notable, 2 major."""
    return _spec(tag)[1]


def _number(value) -> float:
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else 0


def money_of(effects: dict) -> float:
    """The money an outcome moves: its `money` effect plus its `hh_money` effect (0 when it has neither)."""
    return _number(effects.get("money")) + _number(effects.get("hh_money"))


def outcome_tag(effects: dict) -> tuple[str, int]:
    """Classify an outcome by its effects: (tag, importance).

    big_money when it moves BIG_MONEY or more, else injury when its health effect is INJURY or worse,
    else money_swing when it moves MONEY_SWING or more, else outcome.
    """
    money = abs(money_of(effects))
    if money >= BIG_MONEY:
        tag = "big_money"
    elif _number(effects.get("health")) <= INJURY:
        tag = "injury"
    elif money >= MONEY_SWING:
        tag = "money_swing"
    else:
        tag = "outcome"
    return tag, EVENT_TAGS[tag][1]


def money_suffix(amount: float) -> str:
    """' (−$150)' or ' (+$1,400)' for an amount of money, '' when it rounds to $0.

    Rounds with floor(x + 0.5) on the size, as the JS port does, never Python's banker's round.
    """
    dollars = math.floor(abs(_number(amount)) + 0.5)
    if not dollars:
        return ""
    return f" ({'−' if amount < 0 else '+'}${dollars:,})"


def outcome_event(name: str, label: str, effects: dict) -> tuple[str, str, int]:
    """The text, tag and importance of the event for an outcome that came true.

    "Dana Cohen: Minor fender bender (−$150)." for big_money and injury, "Ari: Sleeps deeply." otherwise.
    """
    tag, importance = outcome_tag(effects)
    who = name if tag in FULL_NAME_TAGS else name.split()[0]
    return f"{who}: {label}{money_suffix(money_of(effects))}.", tag, importance


def make_event(seq: int, tick: int, time: str, text: str, tag: str = "other", kind: str | None = None,
               importance: int | None = None, agent: str | None = None, agents: list[str] | None = None,
               place: str | None = None, at: tuple[int, int] | list[int] | None = None) -> dict:
    """One event record in the section 3.7 shape, with the defaults filled in.

    `kind` and `importance` default to the tag's; `agents` always starts with `agent` when it is set (no
    duplicates); `place` is a place id or None; `at` is the agent's tile or None. An unknown tag raises
    KeyError even when the call gives both `kind` and `importance`.
    """
    tag_kind, tag_importance = _spec(tag)
    kind = kind or tag_kind
    importance = tag_importance if importance is None else importance
    ids = [agent] if agent else []
    for other in agents or []:
        if other not in ids:
            ids.append(other)
    return {"seq": seq, "tick": tick, "time": time, "kind": kind, "tag": tag, "importance": importance,
            "major": importance == 2, "text": text, "agent": agent, "agents": ids, "place": place,
            "at": list(at) if at is not None else None}


FRIENDS_FROM = ("acquaintance", "coworker")  # the kinds of relationship that can grow into a friendship
RIFT_KINDS = ("friend", "partner")  # ... and the ones that can end in a falling-out


def rift_key(a_id: str, b_id: str) -> str:
    """The pair's key in sim._rifts: both ids in code-unit order, joined by "|" (ids never contain it)."""
    return f"{a_id}|{b_id}" if a_id < b_id else f"{b_id}|{a_id}"


def on_affinity(sim: Simulation, a_id: str, b_id: str, before: float, after: float) -> None:
    """Called at the end of every relationship bump with a's affinity to b before and after it.

    An acquaintance or coworker whose affinity rises to FRIEND_AT becomes a friend, on both sides (a side that
    is family or a partner keeps its kind), with one `new_friend` event. A friend or partner whose affinity
    drops below RIFT_AT falls out (`falling_out`; the kind stays), at most once per pair in RIFT_GAP_DAYS game
    days: sim._rifts maps rift_key(a, b) to the tick of the pair's last falling-out. No fork reads a
    relationship's kind, so no decision changes. Unknown characters (or a city with nobody) do nothing.
    """
    agents = getattr(sim, "agents", None) or {}
    a, b = agents.get(a_id), agents.get(b_id)
    rel = a.relationships.get(b_id) if a is not None and b is not None else None
    if rel is None:
        return None
    kind = rel.kind.value
    if kind in FRIENDS_FROM and before < FRIEND_AT <= after:
        friend = type(rel.kind)("friend")  # RelationKind.FRIEND, without importing agent
        rel.kind = friend
        back = b.relationships.get(a_id)
        if back is not None and back.kind.value in FRIENDS_FROM:
            back.kind = friend
        text = f"{a.name} and {b.name} have become friends."
        sim.event(text, a, tag="new_friend", agents=[b.id])
        b.remember(sim.clock.stamp(), text)
    elif kind in RIFT_KINDS and before >= RIFT_AT > after:
        rifts = getattr(sim, "_rifts", None)
        if rifts is None:
            rifts = sim._rifts = {}
        key = rift_key(a_id, b_id)
        last = rifts.get(key)
        if last is not None and sim.clock.tick - last < RIFT_GAP_DAYS * TICKS_PER_DAY:
            return None
        rifts[key] = sim.clock.tick
        text = f"{a.name} and {b.name} have fallen out."
        sim.event(text, a, tag="falling_out", agents=[b.id])
        b.remember(sim.clock.stamp(), text)
    return None

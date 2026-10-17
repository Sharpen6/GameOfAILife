"""The catalogue of things an agent can spend time doing."""

from __future__ import annotations

from dataclasses import dataclass, field

from .world import PlaceKind


@dataclass(frozen=True)
class Activity:
    name: str
    place_kinds: tuple[PlaceKind, ...]
    duration: int  # ticks
    effects: dict[str, float] = field(default_factory=dict)  # need delta per tick
    cost: float = 0.0  # paid once when the activity starts
    # "own" means the agent's own home or workplace rather than any place of the kind.
    own_place: bool = False
    social: bool = False  # builds relationships with others doing the same thing nearby


ACTIVITIES: dict[str, Activity] = {
    a.name: a
    for a in [
        Activity("sleep", (PlaceKind.HOME,), 32, {"energy": 2.6}, own_place=True),
        Activity("eat_home", (PlaceKind.HOME,), 2, {"hunger": 24, "social": 1}, own_place=True, social=True),
        Activity("relax_home", (PlaceKind.HOME,), 4, {"fun": 3.5, "energy": 0.4, "social": 0.5}, own_place=True, social=True),
        Activity("eat_out", (PlaceKind.CAFE,), 3, {"hunger": 17, "social": 2, "fun": 2}, cost=14, social=True),
        Activity("buy_groceries", (PlaceKind.SHOP,), 2, {}, cost=30),
        Activity("hang_out", (PlaceKind.CAFE, PlaceKind.PARK), 6, {"social": 5, "fun": 3}, social=True),
        Activity("walk_park", (PlaceKind.PARK,), 4, {"fun": 4.5, "energy": -0.3}),
        Activity("work", (PlaceKind.OFFICE, PlaceKind.SCHOOL), 4, {"social": 0.6, "fun": -0.3, "energy": -0.2}, own_place=True, social=True),
        Activity("phone_call", (), 1, {"social": 6}),  # anywhere, needs someone to call
    ]
}

GROCERY_MEALS = 8  # meals bought per shopping trip

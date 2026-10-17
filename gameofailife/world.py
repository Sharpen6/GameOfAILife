"""The city: places agents can be, and how they get between them."""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from enum import Enum


class PlaceKind(str, Enum):
    HOME = "home"
    OFFICE = "office"
    SCHOOL = "school"
    SHOP = "shop"
    CAFE = "cafe"
    PARK = "park"


@dataclass
class Place:
    id: str
    name: str
    kind: PlaceKind
    x: float  # km
    y: float  # km
    # Opening hours as (open_hour, close_hour); None means always open.
    hours: tuple[int, int] | None = None
    occupants: set[str] = field(default_factory=set)

    def is_open(self, hour: float) -> bool:
        if self.hours is None:
            return True
        open_h, close_h = self.hours
        return open_h <= hour < close_h


@dataclass(frozen=True)
class TransportMode:
    name: str
    speed_kmh: float
    fare: float  # flat cost per trip
    wait_minutes: int = 0  # e.g. waiting at the bus stop


WALK = TransportMode("walk", speed_kmh=5, fare=0)
BUS = TransportMode("bus", speed_kmh=25, fare=2.5, wait_minutes=8)
CAR = TransportMode("car", speed_kmh=40, fare=1.5)  # fuel + parking


@dataclass
class City:
    name: str
    places: dict[str, Place] = field(default_factory=dict)

    def add(self, place: Place) -> Place:
        self.places[place.id] = place
        return place

    def distance(self, a: str, b: str) -> float:
        pa, pb = self.places[a], self.places[b]
        return math.hypot(pa.x - pb.x, pa.y - pb.y)

    def travel_minutes(self, a: str, b: str, mode: TransportMode) -> int:
        if a == b:
            return 0
        return mode.wait_minutes + math.ceil(self.distance(a, b) / mode.speed_kmh * 60)

    def of_kind(self, kind: PlaceKind) -> list[Place]:
        return [p for p in self.places.values() if p.kind == kind]

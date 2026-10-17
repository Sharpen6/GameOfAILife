"""Simulation time. One tick is a fixed slice of in-game minutes."""

from dataclasses import dataclass

MINUTES_PER_TICK = 15
TICKS_PER_HOUR = 60 // MINUTES_PER_TICK
TICKS_PER_DAY = 24 * TICKS_PER_HOUR
DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


@dataclass
class Clock:
    tick: int = 0

    def advance(self) -> None:
        self.tick += 1

    @property
    def day(self) -> int:
        return self.tick // TICKS_PER_DAY

    @property
    def minute_of_day(self) -> int:
        return (self.tick % TICKS_PER_DAY) * MINUTES_PER_TICK

    @property
    def hour(self) -> float:
        return self.minute_of_day / 60

    @property
    def weekday(self) -> int:
        return self.day % 7

    @property
    def is_weekend(self) -> bool:
        return self.weekday >= 5

    def stamp(self) -> str:
        m = self.minute_of_day
        return f"Day {self.day + 1} {DAY_NAMES[self.weekday]} {m // 60:02d}:{m % 60:02d}"

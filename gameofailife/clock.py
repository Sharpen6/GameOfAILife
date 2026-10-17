"""Game time. One tick is one in-game minute."""

from __future__ import annotations

from dataclasses import dataclass

MINUTES_PER_DAY = 24 * 60
DAYS_PER_SEASON = 90
SEASONS = ("spring", "summer", "autumn", "winter")
DAY_NAMES = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")

# At 1x speed one game day lasts about ten real minutes (like SimCity).
TICKS_PER_REAL_SECOND = MINUTES_PER_DAY / 600


@dataclass
class Clock:
    tick: int = 6 * 60  # the world starts on Monday at 06:00

    def advance(self) -> None:
        self.tick += 1

    @property
    def day(self) -> int:
        return self.tick // MINUTES_PER_DAY

    @property
    def minute_of_day(self) -> int:
        return self.tick % MINUTES_PER_DAY

    @property
    def hour(self) -> float:
        return self.minute_of_day / 60

    @property
    def weekday(self) -> int:
        return self.day % 7

    @property
    def is_weekend(self) -> bool:
        return self.weekday >= 5

    @property
    def season(self) -> str:
        return SEASONS[(self.day // DAYS_PER_SEASON) % 4]

    def stamp(self) -> str:
        m = self.minute_of_day
        return f"Day {self.day + 1} {DAY_NAMES[self.weekday]} {m // 60:02d}:{m % 60:02d}"

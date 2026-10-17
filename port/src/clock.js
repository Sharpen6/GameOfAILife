// Port of gameofailife/clock.py: game time. One tick is one in-game minute.
(function (G) {
  "use strict";
  const { pyMod, pad2 } = G.py;

  const MINUTES_PER_DAY = 24 * 60;
  const DAYS_PER_SEASON = 90;
  const SEASONS = ["spring", "summer", "autumn", "winter"];
  const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  // At 1x speed one game day lasts about ten real minutes (like SimCity).
  const TICKS_PER_REAL_SECOND = MINUTES_PER_DAY / 600;

  class Clock {
    constructor(tick = 5 * 60) { this.tick = tick; } // the world starts on Monday at 05:00, an hour before the earliest shifts

    advance() { this.tick += 1; }

    get day() { return Math.floor(this.tick / MINUTES_PER_DAY); }
    get minute_of_day() { return pyMod(this.tick, MINUTES_PER_DAY); }
    get hour() { return this.minute_of_day / 60; }
    get weekday() { return pyMod(this.day, 7); }
    get is_weekend() { return this.weekday >= 5; }
    get season() { return SEASONS[pyMod(Math.floor(this.day / DAYS_PER_SEASON), 4)]; }

    stamp() {
      const m = this.minute_of_day;
      return `Day ${this.day + 1} ${DAY_NAMES[this.weekday]} ${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
    }
  }

  G.clock = { MINUTES_PER_DAY, DAYS_PER_SEASON, SEASONS, DAY_NAMES, TICKS_PER_REAL_SECOND, Clock };
})(globalThis.GameOfAILife || (globalThis.GameOfAILife = {}));

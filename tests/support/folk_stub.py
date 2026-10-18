"""SimStub: the townsfolk on the region without a Simulation (folk.md 12).

It holds what folk generation and folk money read: `seed`, `dice_seed`, `clock`, the region `town`, `homes` (v2's 37
and the region's), `lots`, the cast (`agents`, `households`, moved in by `housing.init`), `rng` (housing's own
draws), `weather`, a list job board (`job_board`, `folk_gen.ListBoard`), `folk` (a `folk_gen.GenFolk` filled by
`folk_gen.populate`), `person` / `household_by_id`, and `event` that records into `events`.

    sim = SimStub(1)                      # 1,000 townsfolk, cast included
    sim = SimStub(1, isolated=True)       # folk_isolated: no Millbrook rows, schools or named ties
    sim = SimStub(1, n=0, populate=False) # an empty town to populate by hand
"""

from __future__ import annotations

import random

from gameofailife import folk_gen
from gameofailife.folk_model import Person


class SimStub(folk_gen.GenSim):
    def __init__(self, seed: int = 1, n: int = 1000, isolated: bool = False, with_cast: bool = True,
                 populate: bool = True):
        super().__init__(seed, isolated, with_cast)
        self.rng = random.Random(seed)
        self.weather = "clear"
        self.events: list[dict] = []
        self.folk_isolated = isolated
        Person.clock = self.clock
        Person.town = self.town
        self.folk = folk_gen.GenFolk(n, isolated)
        if populate and n:
            folk_gen.populate(self.folk, self, n)

    def event(self, text, agent=None, kind=None, *, tag="news", importance=None, agents=None, **_kw):
        ev = {"text": text, "tag": tag, "kind": kind, "agent": getattr(agent, "id", agent), "importance": importance,
              "agents": [getattr(a, "id", a) for a in (agents or ())], "tick": self.clock.tick}
        self.events.append(ev)
        return ev

    def living(self) -> list:
        return [a for a in self.agents.values() if a.alive]

    def advance(self, minutes: int = 1) -> None:
        for _ in range(minutes):
            self.clock.advance()

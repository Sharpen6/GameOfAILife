"""Work for both tiers (life.md 5.7): one job board holding every job slot in town, standing at work, reviews,
layoffs and hiring.

The board is the one list of jobs: the named v2 jobs are slots 0..k-1 (`life.pre_init`), folk generation adds every
`town.job_slots` row after them. A job lost (layoff, firing, death) frees its slot, which reopens 7-30 days later,
so jobs are conserved. `on_shift_end` takes a named Agent or a folk Person, so it reads only Person-protocol
fields (`reputation`, `job`, `luck`, `life`, traits via `people.traits`).
"""

from __future__ import annotations

LAYOFF_YEAR = 0.03  # a worker's yearly odds of being laid off, before PACE["career"]
REOPEN_DAYS = (7, 30)  # an emptied slot is advertised again after this many days
HIRE_BASE = 0.035  # a seeker's daily odds of a job ...
HIRE_REP = 0.0005  # ... plus this per point of standing
HIRE_NETWORK = 0.02  # ... plus this with a friend at affinity 40+ where a slot is open
HIRE_AGES = (18, 64)
PAY_CAP = 1.25  # a seeker takes the best open slot paying at most this much more than the last wage
BENEFIT = 200.0  # a week, for BENEFIT_WEEKS after losing a job (paid by money.weekly)
BENEFIT_WEEKS = 13
STANDING_GOOD = (0.15, 0.3, 1.2)  # good shift: odds .15 + .3 diligence (luck +1), standing +1.2
STANDING_BAD = (0.08, -1.5)  # bad shift: odds .08 (luck -1), standing -1.5
STANDING_PLAIN = 0.1
STANDING_DRIFT = 0.02  # daily pull toward 50
NETWORK_AT = 40
COWORKER_AFFINITY = (15, 25)
NEW_COWORKERS = 4


class JobBoard:
    """Every job slot: `jobs[slot]` (an agent.Job, whose `slot` is set), `holder[slot]` (a person id or None) and
    `reopen[slot]` (the game day an emptied slot is advertised again). `named` counts the named v2 slots (0..k-1),
    the named tier's own in isolated mode."""

    def __init__(self) -> None:
        self.jobs: list = []
        self.holder: list[str | None] = []
        self.reopen: dict[int, int] = {}
        self.named = 0

    def add(self, job, holder: str | None) -> int:
        slot = len(self.jobs)
        job.slot = slot
        self.jobs.append(job)
        self.holder.append(holder)
        return slot

    def vacant(self, sim, p) -> list[int]:
        """Open slots `p` may take today, in slot order: unheld and not waiting to reopen. A named sees only
        Millbrook's slots (PLAN 2.9: v2's named slots or slots at `town.millbrook_ids`); with isolated townsfolk
        each tier sees only its own tier's slots."""
        day = sim.clock.day
        named = p.id in sim.agents
        isolated = bool(getattr(getattr(sim, "folk", None), "isolated", False))
        millbrook = getattr(sim.town, "millbrook_ids", None)
        out = []
        for slot, holder in enumerate(self.holder):
            if holder is not None or self.reopen.get(slot, 0) > day:
                continue
            if isolated and named != (slot < self.named):
                continue
            if named and slot >= self.named and millbrook is not None and self.jobs[slot].place_id not in millbrook:
                continue
            out.append(slot)
        return out

    def take(self, slot: int, pid: str) -> None:
        self.holder[slot] = pid
        self.reopen.pop(slot, None)

    def free(self, slot: int, reopen_day: int | None = None) -> None:
        if slot < 0 or slot >= len(self.holder):
            return
        self.holder[slot] = None
        if reopen_day is None:
            self.reopen.pop(slot, None)
        else:
            self.reopen[slot] = reopen_day


def board(sim) -> JobBoard:
    return sim.life.board


def on_shift_end(sim, p) -> None:
    """A shift ends (named: `sim._end_activity`; folk: F2a's shift end, after `folk_life.pay_shift`): standing.
    Skeleton: v2's flat +0.5 a shift for both tiers."""
    p.reputation = min(100.0, p.reputation + 0.5)


def daily(sim, p, rr) -> None:
    """The person's daily career roll (life.tick, in their slot minute): standing drift, review, layoff, hiring.
    Skeleton: nothing (v2)."""
    return None


def benefit(sim, p) -> float:
    """This week's unemployment benefit for `p` (money.weekly pays it): BENEFIT for BENEFIT_WEEKS after a job loss.
    Skeleton: none."""
    return 0.0

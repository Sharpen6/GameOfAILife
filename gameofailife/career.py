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


def _hit(sim, p, what: str, base: float, valence: int, rr) -> bool:
    from . import life

    return life._hit(sim, p, what, base, valence, rr)


def _place_name(sim, job) -> str:
    place = sim.town.places.get(job.place_id)
    return place.name if place else job.place_id


def _event(sim, p, text: str, tag: str, importance: int | None = None) -> None:
    from . import life

    life._event(sim, p, text, tag, importance)


def worker(p) -> bool:
    """An adult holding a paid job on the board."""
    return p.job is not None and p.job.hourly_wage > 0 and getattr(p.job, "slot", -1) >= 0


def on_shift_end(sim, p) -> None:
    """A shift ends (named: `sim._end_activity`; folk: F2a's shift end, after `folk_life.pay_shift`): standing
    (life.md 5.7): a good shift `odds(.15 + .3 diligence, +1)` +1.2, a bad one `odds(.08, -1)` -1.5, else +.1."""
    from . import dice, people

    if not worker(p):
        p.reputation = min(100.0, p.reputation + 0.5)  # a pupil's school day: v2's +0.5
        return
    rr = dice.stream(people.dice_seed(sim), dice.SHIFT, p.id, sim.clock.day)
    good = dice.odds(STANDING_GOOD[0] + STANDING_GOOD[1] * people.traits(p)["diligence"], +1, p.luck)
    bad = dice.odds(STANDING_BAD[0], -1, p.luck)
    x = rr.random()
    people.log_roll(sim, p, "shift", good, x)
    if x < good:
        delta = STANDING_GOOD[2]
    elif x < good + bad:
        delta = STANDING_BAD[1]
    else:
        delta = STANDING_PLAIN
    p.reputation = max(0.0, min(100.0, p.reputation + delta))


def daily(sim, p, rr) -> None:
    """The person's daily career roll (life.tick, in their slot minute): standing drifts toward 50; a worker may
    be laid off (`odds(.03 x PACE / 360, -1)`); a seeker 18-64 may be hired (`odds(.035 + .0005 rep, +1)`)."""
    from . import life

    if not p.is_adult:
        return
    day = sim.clock.day
    if worker(p):
        p.reputation += STANDING_DRIFT * (50.0 - p.reputation)
        if day % 90 == p.life.review_day and day - p.life.job_since >= 30:
            review(sim, p, rr)
            if not worker(p):
                return
        if _hit(sim, p, "layoff", LAYOFF_YEAR * life.PACE["career"] / life.YEAR_DAYS, -1, rr):
            lose_job(sim, p, rr, "laid_off")
    elif (p.job is None and p.life.jobless_since is not None and HIRE_AGES[0] <= p.age <= HIRE_AGES[1]
          and life.can_work(sim, p)):
        if _hit(sim, p, "hire", HIRE_BASE + HIRE_REP * p.reputation, +1, rr):
            hire(sim, p, rr)


def review(sim, p, rr) -> None:
    """Every 90 days (life.md 5.7): 50+ a 4-7% raise at `odds(.5, +1)`; under 25 a warning; 40+ clears them;
    under 20 with 2 warnings, fired."""
    life = p.life
    rep = p.reputation
    if rep >= 50 and _hit(sim, p, "raise", 0.5, +1, rr):
        pct = rr.int(4, 7)
        p.job.hourly_wage = round(p.job.hourly_wage * (100 + pct) / 100, 2)
        _event(sim, p, f"{p.name} gets a {pct}% raise at {_place_name(sim, p.job)}.", "raise",
               None if p.id in sim.agents else 0)
    if rep >= 40:
        life.warnings = 0
    elif rep < 25:
        life.warnings += 1
        if rep < 20 and life.warnings >= 2:
            lose_job(sim, p, rr, "fired")
            return
        _event(sim, p, f"{p.name} gets a warning at work.", "warning", None if p.id in sim.agents else 0)


def lose_job(sim, p, rr, why: str) -> None:
    """`p` loses their job: the slot reopens 7-30 days later; benefit for 13 weeks; folk `on_job_change`."""
    job = p.job
    b = board(sim)
    day = sim.clock.day
    b.free(job.slot, day + rr.int(REOPEN_DAYS[0], REOPEN_DAYS[1]))
    p.life.last_wage = job.hourly_wage
    p.life.jobless_since = day
    p.life.warnings = 0
    p.job = None
    place = _place_name(sim, job)
    text = (f"{p.name} is laid off from the job as {job.title} at {place}." if why == "laid_off"
            else f"{p.name} is fired from the job as {job.title} at {place}.")
    _event(sim, p, text, "job_lost", None if p.id in sim.agents else 1)
    if p.id not in sim.agents:
        from . import folk

        folk.on_job_change(sim, p)


def hire(sim, p, rr) -> bool:
    """`p` takes the best open slot paying at most 1.25x their last wage (a named: the best paid; folk: the
    nearest by `sim.folk.commute_minutes`, None skipped). False when none will do."""
    b = board(sim)
    cap = PAY_CAP * p.life.last_wage if p.life.last_wage > 0 else None
    best, best_key = None, None
    named = p.id in sim.agents
    for slot in b.vacant(sim, p):
        job = b.jobs[slot]
        if cap is not None and job.hourly_wage > cap:
            continue
        if named:
            key = (-job.hourly_wage, slot)
        else:
            minutes = sim.folk.commute_minutes(p, job.place_id)
            if minutes is None:
                continue
            key = (minutes, slot)
        if best_key is None or key < best_key:
            best, best_key = slot, key
    if best is None:
        return False
    b.take(best, p.id)
    p.job = b.jobs[best]
    p.life.job_since = sim.clock.day
    p.life.jobless_since = None
    p.life.warnings = 0
    p.reputation = 50.0
    _event(sim, p, f"{p.name} starts a new job as {p.job.title} at {_place_name(sim, p.job)}.", "job_new",
           None if named else 0)
    if not named:
        from . import folk

        folk.on_job_change(sim, p)
    return True


def benefit(sim, p) -> float:
    """This week's unemployment benefit for `p` (money.weekly pays it): BENEFIT for BENEFIT_WEEKS after a job loss,
    under 65."""
    life = p.life
    if p.job is not None or life is None or life.jobless_since is None or p.age >= 65 or not p.is_adult:
        return 0.0
    if sim.clock.day - life.jobless_since >= 7 * BENEFIT_WEEKS:
        return 0.0
    return BENEFIT

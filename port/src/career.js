// Port of gameofailife/career.py: one job board for both tiers (life.md 5.7), standing at work, reviews, layoffs
// and hiring. `on_shift_end` takes a named Agent or a folk Person, so it reads only Person-protocol fields.
(function (G) {
  "use strict";

  const LAYOFF_YEAR = 0.03; // a worker's yearly odds of being laid off, before PACE["career"]
  const REOPEN_DAYS = [7, 30]; // an emptied slot is advertised again after this many days
  const HIRE_BASE = 0.035; // a seeker's daily odds of a job ...
  const HIRE_REP = 0.0005; // ... plus this per point of standing
  const HIRE_NETWORK = 0.02; // ... plus this with a friend at affinity 40+ where a slot is open
  const HIRE_AGES = [18, 64];
  const PAY_CAP = 1.25; // a seeker takes the best open slot paying at most this much more than the last wage
  const BENEFIT = 200.0; // a week, for BENEFIT_WEEKS after losing a job (paid by money.weekly)
  const BENEFIT_WEEKS = 13;
  const STANDING_GOOD = [0.15, 0.3, 1.2]; // good shift: odds .15 + .3 diligence (luck +1), standing +1.2
  const STANDING_BAD = [0.08, -1.5]; // bad shift: odds .08 (luck -1), standing -1.5
  const STANDING_PLAIN = 0.1;
  const STANDING_DRIFT = 0.02; // daily pull toward 50
  const NETWORK_AT = 40;
  const COWORKER_AFFINITY = [15, 25];
  const NEW_COWORKERS = 4;

  // Every job slot: jobs[slot] (an agent.Job, whose `slot` is set), holder[slot] (a person id or null) and
  // reopen[slot] (the game day an emptied slot is advertised again). `named` counts the named v2 slots (0..k-1).
  class JobBoard {
    constructor() {
      this.jobs = [];
      this.holder = [];
      this.reopen = new Map();
      this.named = 0;
    }

    add(job, holder) {
      const slot = this.jobs.length;
      job.slot = slot;
      this.jobs.push(job);
      this.holder.push(holder);
      return slot;
    }

    // Open slots `p` may take today, in slot order (see career.py).
    vacant(sim, p) {
      const day = sim.clock.day;
      const named = sim.agents.has(p.id);
      const isolated = Boolean(sim.folk && sim.folk.isolated);
      const millbrook = sim.town.millbrook_ids ?? null;
      const out = [];
      for (let slot = 0; slot < this.holder.length; slot++) {
        if (this.holder[slot] !== null || (this.reopen.get(slot) ?? 0) > day) continue;
        if (isolated && named !== (slot < this.named)) continue;
        if (named && slot >= this.named && millbrook !== null
          && !(millbrook instanceof Set ? millbrook.has(this.jobs[slot].place_id) : millbrook.includes(this.jobs[slot].place_id))) continue;
        out.push(slot);
      }
      return out;
    }

    take(slot, pid) {
      this.holder[slot] = pid;
      this.reopen.delete(slot);
    }

    free(slot, reopen_day = null) {
      if (slot < 0 || slot >= this.holder.length) return;
      this.holder[slot] = null;
      if (reopen_day === null) this.reopen.delete(slot);
      else this.reopen.set(slot, reopen_day);
    }
  }

  const board = sim => sim.life.board;

  const _hit = (sim, p, what, base, valence, rr) => G.life._hit(sim, p, what, base, valence, rr);

  function _place_name(sim, job) {
    const place = sim.town.places.get(job.place_id);
    return place ? place.name : job.place_id;
  }

  const _event = (sim, p, text, tag, importance = null) => G.life._event(sim, p, text, tag, importance);

  // An adult holding a paid job on the board.
  const worker = p => p.job !== null && p.job.hourly_wage > 0 && (p.job.slot ?? -1) >= 0;

  // A shift ends: standing (life.md 5.7): see career.py.
  function on_shift_end(sim, p) {
    const { dice, people } = G;
    if (!worker(p)) {
      p.reputation = Math.min(100.0, p.reputation + 0.5); // a pupil's school day: v2's +0.5
      return;
    }
    const rr = dice.stream(people.dice_seed(sim), dice.SHIFT, p.id, sim.clock.day);
    const good = dice.odds(STANDING_GOOD[0] + STANDING_GOOD[1] * people.traits(p).diligence, +1, p.luck);
    const bad = dice.odds(STANDING_BAD[0], -1, p.luck);
    const x = rr.random();
    people.log_roll(sim, p, "shift", good, x);
    let delta;
    if (x < good) delta = STANDING_GOOD[2];
    else if (x < good + bad) delta = STANDING_BAD[1];
    else delta = STANDING_PLAIN;
    p.reputation = Math.max(0.0, Math.min(100.0, p.reputation + delta));
  }

  // The person's daily career roll (life.tick, in their slot minute): see career.py.
  function daily(sim, p, rr) {
    const L = G.life;
    if (!p.is_adult) return;
    const day = sim.clock.day;
    if (worker(p)) {
      p.reputation += STANDING_DRIFT * (50.0 - p.reputation);
      if (day % 90 === p.life.review_day && day - p.life.job_since >= 30) {
        review(sim, p, rr);
        if (!worker(p)) return;
      }
      if (_hit(sim, p, "layoff", LAYOFF_YEAR * L.PACE.career / L.YEAR_DAYS, -1, rr)) lose_job(sim, p, rr, "laid_off");
    } else if (p.job === null && p.life.jobless_since !== null && HIRE_AGES[0] <= p.age && p.age <= HIRE_AGES[1]
      && L.can_work(sim, p)) {
      if (_hit(sim, p, "hire", HIRE_BASE + HIRE_REP * p.reputation, +1, rr)) hire(sim, p, rr);
    }
  }

  // Every 90 days (life.md 5.7): see career.py.
  function review(sim, p, rr) {
    const life = p.life;
    const rep = p.reputation;
    const named = sim.agents.has(p.id);
    if (rep >= 50 && _hit(sim, p, "raise", 0.5, +1, rr)) {
      const pct = rr.int(4, 7);
      p.job.hourly_wage = G.py.pyRound(p.job.hourly_wage * (100 + pct) / 100, 2);
      _event(sim, p, `${p.name} gets a ${pct}% raise at ${_place_name(sim, p.job)}.`, "raise", named ? null : 0);
    }
    if (rep >= 40) {
      life.warnings = 0;
    } else if (rep < 25) {
      life.warnings += 1;
      if (rep < 20 && life.warnings >= 2) {
        lose_job(sim, p, rr, "fired");
        return;
      }
      _event(sim, p, `${p.name} gets a warning at work.`, "warning", named ? null : 0);
    }
  }

  // `p` loses their job: the slot reopens 7-30 days later; benefit for 13 weeks; folk `on_job_change`.
  function lose_job(sim, p, rr, why) {
    const job = p.job;
    const b = board(sim);
    const day = sim.clock.day;
    b.free(job.slot, day + rr.int(REOPEN_DAYS[0], REOPEN_DAYS[1]));
    p.life.last_wage = job.hourly_wage;
    p.life.jobless_since = day;
    p.life.warnings = 0;
    p.job = null;
    const place = _place_name(sim, job);
    const text = why === "laid_off" ? `${p.name} is laid off from the job as ${job.title} at ${place}.`
      : `${p.name} is fired from the job as ${job.title} at ${place}.`;
    _event(sim, p, text, "job_lost", sim.agents.has(p.id) ? null : 1);
    if (!sim.agents.has(p.id)) G.folk.on_job_change(sim, p);
  }

  // `p` takes the best open slot paying at most 1.25x their last wage: see career.py.
  function hire(sim, p, rr) {
    const b = board(sim);
    const cap = p.life.last_wage > 0 ? PAY_CAP * p.life.last_wage : null;
    let best = null, k0 = null, k1 = null;
    const named = sim.agents.has(p.id);
    for (const slot of b.vacant(sim, p)) {
      const job = b.jobs[slot];
      if (cap !== null && job.hourly_wage > cap) continue;
      let key;
      if (named) {
        key = -job.hourly_wage;
      } else {
        const minutes = sim.folk.commute_minutes(p, job.place_id);
        if (minutes === null || minutes === undefined) continue;
        key = minutes;
      }
      if (best === null || key < k0 || (key === k0 && slot < k1)) {
        best = slot;
        k0 = key;
        k1 = slot;
      }
    }
    if (best === null) return false;
    b.take(best, p.id);
    p.job = b.jobs[best];
    p.life.job_since = sim.clock.day;
    p.life.jobless_since = null;
    p.life.warnings = 0;
    p.reputation = 50.0;
    _event(sim, p, `${p.name} starts a new job as ${p.job.title} at ${_place_name(sim, p.job)}.`, "job_new",
      named ? null : 0);
    if (!named) G.folk.on_job_change(sim, p);
    return true;
  }

  // This week's unemployment benefit for `p`: see career.py.
  function benefit(sim, p) {
    const life = p.life ?? null;
    if (p.job !== null || life === null || life.jobless_since === null || p.age >= 65 || !p.is_adult) return 0.0;
    if (sim.clock.day - life.jobless_since >= 7 * BENEFIT_WEEKS) return 0.0;
    return BENEFIT;
  }

  G.career = {
    LAYOFF_YEAR, REOPEN_DAYS, HIRE_BASE, HIRE_REP, HIRE_NETWORK, HIRE_AGES, PAY_CAP, BENEFIT, BENEFIT_WEEKS,
    STANDING_GOOD, STANDING_BAD, STANDING_PLAIN, STANDING_DRIFT, NETWORK_AT, COWORKER_AFFINITY, NEW_COWORKERS,
    JobBoard, board, _hit, _place_name, _event, worker, on_shift_end, daily, review, lose_job, hire, benefit,
  };
})(globalThis.GameOfAILife || (globalThis.GameOfAILife = {}));

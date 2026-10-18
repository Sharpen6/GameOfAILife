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
  const NETWORK_AT = 40; // a friend at this affinity who works where a slot is open makes the network term
  const [PROMOTE_AT, PROMOTE_DAYS, PROMOTE_ODDS, PROMOTE_PAY] = [85, 120, 0.3, 1.2]; // at a review
  const PROMOTE_TITLES = ["senior ", "head "];
  const [OFFER_AT, OFFER_YEAR, OFFER_RAISE] = [50, 0.15, [1.10, 1.25]]; // daily offer odds (x PACE / 360), pay band
  const [RETIRE_AGE, RETIRE_ODDS] = [65, [0.4, 0.6, 1.0]]; // at each review from 65: 65, 66, 67+
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
      if (_hit(sim, p, "layoff", LAYOFF_YEAR * L.PACE.career / L.YEAR_DAYS, -1, rr)) {
        lose_job(sim, p, rr, "laid_off");
      } else if (p.reputation >= OFFER_AT && _hit(sim, p, "offer", OFFER_YEAR * L.PACE.career / L.YEAR_DAYS, +1, rr)) {
        offer(sim, p, rr);
      }
    } else if (p.job === null && p.life.jobless_since !== null && HIRE_AGES[0] <= p.age && p.age <= HIRE_AGES[1]
      && L.can_work(sim, p)) {
      const lead = p.relationships.size ? network_slot(sim, p, board(sim).vacant(sim, p), _cap(p)) : null;
      if (_hit(sim, p, "hire", HIRE_BASE + HIRE_REP * p.reputation + (lead !== null ? HIRE_NETWORK : 0.0), +1, rr)) {
        hire(sim, p, rr, lead);
      }
    }
  }

  // A job offer (life.md 5.7): an open slot paying 10-25% more, taken or not as people.settle_choice settles it.
  function offer(sim, p, rr) {
    const b = board(sim);
    const wage = p.job.hourly_wage;
    const slot = _pick(sim, p, b.vacant(sim, p), OFFER_RAISE[1] * wage, OFFER_RAISE[0] * wage);
    if (slot === null) return false;
    const neu = b.jobs[slot];
    G.life.cadd(sim.life.counts, "offers");
    const Option = G.forks.Option;
    const options = [new Option(`Take the job as ${neu.title}`, [], { base: 0.3, tags: { adventure: 0.5, diligence: 0.3 } }),
      new Option(`Stay as ${p.job.title}`, [], { base: 0.2, tags: { family: 0.3 } })];
    if (G.people.settle_choice(sim, p, "job_offer", options) !== 0) return false;
    const old = p.job;
    b.free(old.slot, sim.clock.day + rr.int(REOPEN_DAYS[0], REOPEN_DAYS[1]));
    p.life.last_wage = old.hourly_wage;
    p.job = null;
    hire(sim, p, rr, slot);
    return true;
  }

  // Every 90 days (life.md 5.7): see career.py.
  function review(sim, p, rr) {
    const life = p.life;
    const rep = p.reputation;
    const named = sim.agents.has(p.id);
    const counts = sim.life.counts;
    G.life.cadd(counts, "reviews");
    if (p.age >= RETIRE_AGE && rr.random() < RETIRE_ODDS[Math.min(p.age - RETIRE_AGE, RETIRE_ODDS.length - 1)]) {
      retire(sim, p, rr);
      return;
    }
    if (rep >= 50 && _hit(sim, p, "raise", 0.5, +1, rr)) {
      G.life.cadd(counts, "raises");
      const pct = rr.int(4, 7);
      p.job.hourly_wage = G.py.pyRound(p.job.hourly_wage * (100 + pct) / 100, 2);
      _event(sim, p, `${p.name} gets a ${pct}% raise at ${_place_name(sim, p.job)}.`, "raise", named ? null : 0);
    }
    if (rep >= PROMOTE_AT && sim.clock.day - life.job_since >= PROMOTE_DAYS
      && !p.job.title.startsWith(PROMOTE_TITLES[PROMOTE_TITLES.length - 1])
      && _hit(sim, p, "promotion", PROMOTE_ODDS, +1, rr)) {
      promote(sim, p);
    }
    if (rep >= 40) {
      life.warnings = 0;
    } else if (rep < 25) {
      life.warnings += 1;
      G.life.cadd(counts, "warnings");
      if (rep < 20 && life.warnings >= 2) {
        lose_job(sim, p, rr, "fired");
        return;
      }
      _event(sim, p, `${p.name} gets a warning at work.`, "warning", named ? null : 0);
    }
  }

  // `p` loses their job: the slot reopens 7-30 days later; benefit for 13 weeks; folk `on_job_change`.
  // "senior <title>", then "head <title>", at 1.2x the pay (life.md 5.7).
  function promote(sim, p) {
    const job = p.job;
    G.life.cadd(sim.life.counts, "promotions");
    if (job.title.startsWith(PROMOTE_TITLES[0])) job.title = PROMOTE_TITLES[1] + job.title.slice(PROMOTE_TITLES[0].length);
    else job.title = PROMOTE_TITLES[0] + job.title;
    job.hourly_wage = G.py.pyRound(job.hourly_wage * PROMOTE_PAY, 2);
    _event(sim, p, `${p.name} is promoted to ${job.title} at ${_place_name(sim, job)}.`, "promotion",
      sim.agents.has(p.id) ? null : 0);
  }

  // `p` retires: the slot reopens 7-30 days later; no benefit and no job hunt (the pension follows from 65).
  function retire(sim, p, rr) {
    const job = p.job;
    G.life.cadd(sim.life.counts, "retired");
    board(sim).free(job.slot, sim.clock.day + rr.int(REOPEN_DAYS[0], REOPEN_DAYS[1]));
    p.life.last_wage = job.hourly_wage;
    p.life.jobless_since = null;
    p.life.warnings = 0;
    p.job = null;
    const named = sim.agents.has(p.id);
    _event(sim, p, `${p.name} retires from the job as ${job.title} at ${_place_name(sim, job)}.`, "retired",
      named ? null : 0);
    if (!named) G.folk.on_job_change(sim, p);
  }

  function lose_job(sim, p, rr, why) {
    const job = p.job;
    const b = board(sim);
    const day = sim.clock.day;
    G.life.cadd(sim.life.counts, why); // "laid_off" or "fired"
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
  // The open slot `p` would take among `slots` paying at most `cap` (null: any) and more than `floor`: a named the
  // best paid, folk the nearest by sim.folk.commute_minutes (null skipped); null when none will do.
  function _pick(sim, p, slots, cap, floor = 0.0) {
    const b = board(sim);
    let best = null, k0 = null, k1 = null;
    const named = sim.agents.has(p.id);
    for (const slot of slots) {
      const job = b.jobs[slot];
      if (job.hourly_wage <= floor || (cap !== null && job.hourly_wage > cap)) continue;
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
    return best;
  }

  // The first of `slots` (at most `cap`) at a place where a friend of p's at affinity 40+ works, else null.
  function network_slot(sim, p, slots, cap) {
    const b = board(sim);
    const places = new Set();
    for (const [oid, rel] of p.relationships) {
      if ((rel.affinity ?? 0) >= NETWORK_AT) {
        const o = G.life._person(sim, oid);
        if (o && o.alive && o.job && o.job.hourly_wage > 0) places.add(o.job.place_id);
      }
    }
    if (places.size === 0) return null;
    for (const slot of slots) {
      const job = b.jobs[slot];
      if (places.has(job.place_id) && (cap === null || job.hourly_wage <= cap)) return slot;
    }
    return null;
  }

  const _cap = p => (p.life.last_wage > 0 ? PAY_CAP * p.life.last_wage : null);

  function hire(sim, p, rr, slot = null) {
    const b = board(sim);
    const named = sim.agents.has(p.id);
    const best = slot !== null ? slot : _pick(sim, p, b.vacant(sim, p), _cap(p));
    if (best === null) return false;
    b.take(best, p.id);
    G.life.cadd(sim.life.counts, "hired");
    p.job = b.jobs[best];
    p.life.job_since = sim.clock.day;
    p.life.jobless_since = null;
    p.life.warnings = 0;
    p.reputation = 50.0;
    _event(sim, p, `${p.name} starts a new job as ${p.job.title} at ${_place_name(sim, p.job)}.`, "job_new",
      named ? null : 0);
    coworkers(sim, p, rr);
    if (!named) G.folk.on_job_change(sim, p);
    return true;
  }

  // A new hire meets up to 4 coworkers at the same place they have no tie with yet (slot order): coworkers at 15-25
  // both ways. With isolated townsfolk only within the tier.
  function coworkers(sim, p, rr) {
    const b = board(sim);
    const place = p.job.place_id;
    const named = sim.agents.has(p.id);
    const isolated = Boolean(sim.folk && sim.folk.isolated);
    let met = 0;
    for (let slot = 0; slot < b.holder.length; slot++) {
      if (met >= NEW_COWORKERS) break;
      const holder = b.holder[slot];
      if (holder === null || holder === p.id || p.relationships.has(holder) || b.jobs[slot].place_id !== place) continue;
      if (isolated && sim.agents.has(holder) !== named) continue;
      G.people.set_rel(sim, p.id, holder, "coworker", rr.int(COWORKER_AFFINITY[0], COWORKER_AFFINITY[1]));
      met += 1;
    }
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
    PROMOTE_AT, PROMOTE_DAYS, PROMOTE_ODDS, PROMOTE_PAY, PROMOTE_TITLES, OFFER_AT, OFFER_YEAR, OFFER_RAISE, RETIRE_AGE,
    RETIRE_ODDS, JobBoard, board, _hit, _place_name, _event, worker, on_shift_end, daily, review, promote, retire,
    lose_job, _pick, network_slot, _cap, hire, coworkers, offer, benefit,
  };
})(globalThis.GameOfAILife || (globalThis.GameOfAILife = {}));

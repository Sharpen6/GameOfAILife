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

  // A shift ends: standing. Skeleton: v2's flat +0.5 a shift for both tiers.
  function on_shift_end(sim, p) {
    p.reputation = Math.min(100.0, p.reputation + 0.5);
  }

  // The person's daily career roll (life.tick). Skeleton: nothing (v2).
  function daily(sim, p, rr) { return null; }

  // This week's unemployment benefit for `p`. Skeleton: none.
  function benefit(sim, p) { return 0.0; }

  G.career = {
    LAYOFF_YEAR, REOPEN_DAYS, HIRE_BASE, HIRE_REP, HIRE_NETWORK, HIRE_AGES, PAY_CAP, BENEFIT, BENEFIT_WEEKS,
    STANDING_GOOD, STANDING_BAD, STANDING_PLAIN, STANDING_DRIFT, NETWORK_AT, COWORKER_AFFINITY, NEW_COWORKERS,
    JobBoard, board, on_shift_end, daily, benefit,
  };
})(globalThis.GameOfAILife || (globalThis.GameOfAILife = {}));

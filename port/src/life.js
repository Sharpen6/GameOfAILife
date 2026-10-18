// Port of gameofailife/life.py: the life course for both tiers (life.md 5.5-5.9): illness, doctors and hospital
// stays, death, pregnancy and births, babies and birthdays, splits and widowing.
(function (G) {
  "use strict";

  const FORK_AGE = 5; // under this age a named child gets no forks: `toddle` runs their day
  const PACE = { health: 1.0, death: 1.0, birth: 2.5, romance: 2.0, career: 2.0 }; // life.md 3.4, a 360-day year
  const YEAR_DAYS = 360;
  const DAY = 24 * 60;
  const LUCK_LOG_SIZE = 5000;

  const ACTIVITIES_EXTRA = {
    ward: { minutes: 1440, gains: { hunger: 40 }, inside: true }, // a hospital stay: lasts until ward_until
    doctor: { minutes: 45, gains: {}, inside: true },
    baby: { minutes: 1440, gains: {}, inside: true }, // an under-5's day at home (toddle)
  };

  class Condition {
    constructor(id, since, until, off_until, contagious_until, severity, doctor = false) {
      this.id = id;
      this.since = since; // tick
      this.until = until; // tick it clears
      this.off_until = off_until; // tick until which it keeps the person off work or school
      this.contagious_until = contagious_until;
      this.severity = severity; // health lost at onset
      this.doctor = doctor;
    }
  }

  class LifeState {
    constructor(birthday, slot, review_day) {
      this.birthday = birthday; // day of the 360-day year: sid(id) % 360
      this.slot = slot; // minute of the day of the daily rolls: sid(id) % 1380
      this.review_day = review_day; // sid(id) % 90
      this.conditions = []; // Conditions (one acute at a time)
      this.chronic = []; // chronic condition ids
      this.treated = []; // the chronic ids under treatment
      this.ward_until = 0;
      this.pregnant = null; // [due_day, other_parent_id]
      this.trying = false;
      this.lifestyle = 0.0;
      this.pay = 0.0;
      this.tight_until = 0;
      this.job_since = 0;
      this.jobless_since = null;
      this.last_wage = 0.0;
      this.warnings = 0;
      this.grief_until = 0;
      this.widowed_day = null;
      this.talks_today = 0;
      this.talks = []; // talk ring (12)
      this.pending = []; // prompts
      this.cooldowns = {}; // kind -> day
      this.recent = {}; // tag -> day
    }
  }

  class LifeCity {
    constructor(board) {
      this.board = board;
      this.by_slot = new Map(); // minute of the day -> ids rolled then
      this.agenda = new Map(); // tick -> [entry]
      this.loans = [];
      this.counts = {}; // a Counter in Python
      this.today = {};
      this.yesterday = {};
      this.luck_log = []; // a deque(maxlen=LUCK_LOG_SIZE) in Python
    }
  }

  // dice.sid (L1's dice.js): ints as themselves, ASCII strings by FNV-1a 32.
  function _sid(x) {
    if (G.dice && G.dice.sid) return G.dice.sid(x);
    if (typeof x === "number") return x >>> 0;
    let h = 0x811C9DC5;
    for (let i = 0; i < x.length; i++) h = Math.imul(h ^ x.charCodeAt(i), 0x01000193) >>> 0;
    return h >>> 0;
  }

  // --- setup -------------------------------------------------------------------------------------------

  // `sim.life` and the job board with the named v2 jobs as slots 0..k-1 (paid jobs, in cast order).
  function pre_init(sim) {
    const board = new G.career.JobBoard();
    for (const a of sim.agents.values()) {
      if (a.job !== null && a.job.hourly_wage > 0) board.add(a.job, a.id);
    }
    board.named = board.jobs.length;
    sim.life = new LifeCity(board);
  }

  // A LifeState for everyone, then the start (seed_story).
  function init(sim) {
    for (const p of _everyone(sim)) init_person(sim, p);
    seed_story(sim);
  }

  // Give a person (named, folk, newcomer or newborn) a LifeState and a daily slot.
  function init_person(sim, p) {
    const h = _sid(p.id);
    p.life = new LifeState(h % YEAR_DAYS, h % 1380, h % 90);
    if (p.job !== null) p.life.last_wage = p.job.hourly_wage;
    let ids = sim.life.by_slot.get(p.life.slot);
    if (ids === undefined) { ids = []; sim.life.by_slot.set(p.life.slot, ids); }
    ids.push(p.id);
  }

  // The start (life.md 5.9). Skeleton: L1's social half only.
  function seed_story(sim) {
    const fn = G.social ? G.social.seed_story : undefined;
    if (fn) fn(sim);
  }

  // Living named in cast order, then living folk (people.everyone once L1's contract lands).
  function _everyone(sim) {
    if (G.people && G.people.everyone) return G.people.everyone(sim);
    return sim.living();
  }

  // --- the clock ---------------------------------------------------------------------------------------

  // Each tick: the daily rolls of the people whose slot is this minute, and the agenda. Skeleton: nothing.
  function tick(sim) { return null; }

  // v2's old-age roll and yearly birthday (v3-fixes sim.js `_new_day`), the same `sim.rng` order.
  function legacy_ageing(sim) {
    const { DAYS_PER_SEASON, SEASONS } = G.clock;
    for (const agent of sim.living()) {
      // Old age: a small daily chance from 70, which Luck softens.
      if (agent.age >= 70) {
        // About 0.75% a month at 74 and 3.6% at 80 (at Luck 50), so a death in the first weeks is rare.
        const p = G.forks.luck_odds(0.00001 * (agent.age - 69) ** 2, -1, agent.luck);
        const roll = sim.rng.random();
        sim._log_roll(agent, "old_age", p, roll);
        if (roll < p) sim._die(agent, "passed away peacefully in their sleep");
      }
    }
    if (sim.clock.day % (DAYS_PER_SEASON * SEASONS.length) === 0 && sim.clock.day) {
      for (const agent of sim.living()) agent.age += 1;
    }
  }

  // An under-5's next step (no forks): a day at home doing `baby`, needs held at 75.
  function toddle(sim, p) {
    for (const n of Object.keys(p.needs)) p.needs[n] = Math.max(p.needs[n], 75.0);
    sim.start_plan(p, [["baby", "home"]]);
  }

  // --- health --------------------------------------------------------------------------------------------

  // Take `p` to hospital for `days`. Skeleton: v2's health < 25 ambulance.
  function hospitalise(sim, p, days, why) {
    sim.event(`${p.name} feels very unwell, and an ambulance takes them to `
      + `${sim.town.places.get("hospital").name}.`, p, null, { tag: "hospital" });
    sim.start_plan(p, [["hospital", "hospital"]], "ambulance"); // free; the hospital's fee stays
  }

  // The most health `p` heals to. Skeleton: 100.
  function max_health(p) { return 100.0; }

  // False while an illness keeps `p` off work or school, or in hospital. Skeleton: true.
  function can_work(sim, p) { return true; }

  function in_hospital(p) {
    const life = p.life ?? null;
    return life !== null && life.ward_until > 0;
  }

  function ill(a) {
    const life = a.life ?? null;
    return Boolean(life && life.conditions.length);
  }

  function stage(a) {
    const age = a.age;
    return age < 3 ? "baby" : age < 13 ? "child" : age < 18 ? "teen" : age < 65 ? "adult" : "senior";
  }

  // A talk between `a` and `b` (L1's social.tick): a contagious condition may pass. Skeleton: nothing.
  function infect(sim, a, b) { return null; }

  // --- death, births and households ------------------------------------------------------------------------

  // Every death goes through here: a named through `sim._die` (which then calls `on_death`), a townsperson
  // through `folk.kill` and then `on_death`.
  function die(sim, p, how) {
    if (sim.agents.has(p.id)) {
      sim._die(p, how);
    } else {
      G.folk.kill(sim, p, how);
      on_death(sim, p);
    }
  }

  // After a death: widowing and grief, the job slot, loans, the agenda. Skeleton: nothing.
  function on_death(sim, p) { return null; }

  // A baby is born to `mother` (and `other`, the other parent's id or null). Skeleton: nothing.
  function birth(sim, mother, other) { return null; }

  // A named leaves their household after a split (life.md 5.3). Skeleton: nothing.
  function split(sim, p) { return false; }

  // --- pages ---------------------------------------------------------------------------------------------

  // The `life` block of a character page (life.md 8.1).
  function page(sim, p) {
    return { stage: stage(p), birthday: p.life ? p.life.birthday : null,
      partner: null, children: [], friends: 0, rivals: [], conditions: [], chronic: [],
      pregnant: null,
      work: { standing: G.py.pyRound(p.reputation), warnings: 0, days_in_job: null, jobless_days: null,
        benefit: false },
      money: { lifestyle: 0, debt: 0, loans: [] }, talks: [] };
  }

  // `you.life` in a fork message (life.md 8.2).
  function fork_you(sim, agent) {
    return { partner: null, children: 0, conditions: [], standing: G.py.pyRound(agent.reputation),
      jobless_days: null, debt: 0 };
  }

  // `stats.city.life` (life.md 8.2), all ints.
  function stats_block(sim) {
    return { ill_now: 0, in_hospital: 0, couples: 0, births: 0, deaths: 0, jobless: 0, in_debt: 0,
      talks_today: 0, friendships_today: 0 };
  }

  G.life = {
    FORK_AGE, PACE, YEAR_DAYS, DAY, LUCK_LOG_SIZE, ACTIVITIES_EXTRA, Condition, LifeState, LifeCity, _sid,
    pre_init, init, init_person, seed_story, _everyone, tick, legacy_ageing, toddle, hospitalise, max_health,
    can_work, in_hospital, ill, stage, infect, die, on_death, birth, split, page, fork_you, stats_block,
  };
})(globalThis.GameOfAILife || (globalThis.GameOfAILife = {}));

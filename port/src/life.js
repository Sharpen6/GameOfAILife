// Port of gameofailife/life.py: the life course for both tiers (life.md 5.5-5.9): illness, doctors and hospital
// stays, death, pregnancy and births, babies and birthdays, splits and widowing.
(function (G) {
  "use strict";
  const { commas, fmtc, firstName, lastName } = G.py;

  const FORK_AGE = 5; // under this age a named child gets no forks: `toddle` runs their day
  const PACE = { health: 1.0, death: 1.0, birth: 2.5, romance: 2.0, career: 2.0 }; // life.md 3.4, a 360-day year
  const YEAR_DAYS = 360;
  const DAY = 24 * 60;
  const LUCK_LOG_SIZE = 5000;
  const SEASON_INDEX = { spring: 0, summer: 1, autumn: 2, winter: 3 };

  // Acute conditions (life.md 5.5): [id, adult rate a year, x under 18, x 65+, x by season, days, days off work,
  // health lost, contagious days, home spread a day, label]
  const ACUTE = [
    ["cold", 2.0, 2.0, 0.8, [0.8, 0.45, 1.2, 1.8], [4, 8], [0, 1], 4, 3, 0.08, "a cold"],
    ["flu", 0.12, 1.5, 1.2, [0.6, 0.15, 1.5, 3.0], [6, 10], [3, 5], 20, 4, 0.15, "the flu"],
    ["stomach_bug", 0.4, 1.5, 1.0, [1.0, 1.0, 1.0, 1.0], [2, 3], [1, 1], 6, 2, 0.10, "a stomach bug"],
    ["back_pain", 0.12, 0.1, 1.3, [1.0, 1.0, 1.0, 1.0], [7, 14], [0, 1], 8, 0, 0.0, "back pain"],
    ["fracture", 0.02, 1.0, 2.5, [1.0, 1.0, 1.0, 1.0], [28, 42], [10, 21], 15, 0, 0.0, "a broken bone"],
  ];
  const HEART = [["heart_attack", 0.6, "a heart attack"], ["stroke", 0.4, "a stroke"]]; // shares of HEART_YEAR
  const HEART_DAYS = [10, 20], HEART_WARD = [5, 10], HEART_HEALTH = 40, HEART_FATAL = 0.15;
  const BACK_PAIN_MANUAL = [2, 5]; // days off with back pain in a manual job (a place of kind "works")
  const CHRONIC = ["hypertension", "diabetes", "arthritis", "heart_disease"];
  const LABELS = {};
  for (const c of ACUTE) LABELS[c[0]] = c[10];
  for (const h of HEART) LABELS[h[0]] = h[2];
  LABELS.sprain = "a sprain";
  for (const c of CHRONIC) LABELS[c] = c.replace("_", " ");
  const SPRAIN = [[7, 14], [0, 3]]; // a v2 outcome costing 8+ health: days, days off
  const DOCTOR_FEE = 40.0;
  const DOCTOR_DAYS = 0.7; // a doctor shortens an illness by 30% ...
  const DOCTOR_COMPLICATIONS = 0.5; // ... and halves its complications
  const WARD_FEE = 60.0; // a day in hospital
  const ILL_CAP = 85.0; // health while an acute condition lasts
  const WARD_HEAL = 6.0; // health an hour in the ward
  const LOW_HEALTH = 40; // below this, death odds x3
  const FRAIL_AGE = 55, FRAIL_RATE = 0.8; // max_health falls this much a year past this age
  const CHRONIC_HEALTH = 5; // ... and this much for each chronic condition
  const GRIEF_DAYS = 30;
  // Births (life.md 5.6)
  const CONCEPTION = [[20, 0.0], [25, 0.10], [35, 0.14], [40, 0.08], [45, 0.025]]; // [under this age, yearly b]
  const CHILDREN_MULT = [1.3, 1.0, 0.45, 0.15]; // by the children already in the household (0, 1, 2, 3+)
  const PREGNANCY_DAYS = 90;
  const BIRTH_MINUTE = 8 * 60;
  const WANT_EVERY = 30; // days between thinking about a child
  const NEW_BABY_DAYS = 180; // parents of a baby this young lose BABY_ENERGY a day
  const BABY_ENERGY = 8;
  const FAMILY_AFFINITY = 75;
  const SCHOOL_AGE = 5, ADULT_AGE = 18;
  // The start (life.md 5.9)
  const SHIRA_DUE = [3, BIRTH_MINUTE]; // Shira Peretz's baby: day index 3 ("Day 4"), 08:00
  const ARI_BILL = [1, 10 * 60]; // Ari Ben-David's bill: day index 1 ("Day 2"), 10:00
  const SEED_PREGNANT = 0.03; // of partnered townswomen 20-44 at the start, due days 5-90

  const TODDLE_MINUTES = 120; // an under-5 is looked after in 2-hour spells: toddle tops their needs back up to 75

  // An activity spec: spec.minutes and spec["minutes"] are the same in JS.
  const ACTIVITIES_EXTRA = {
    ward: { minutes: 1440, gains: { hunger: 40 }, inside: true }, // a hospital stay: lasts until ward_until
    doctor: { minutes: 45, gains: {}, inside: true },
    baby: { minutes: TODDLE_MINUTES, gains: {}, inside: true }, // an under-5 at home (toddle tops needs up)
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

  // A Counter's get-with-default and +=.
  const cget = (c, k) => c[k] ?? 0;
  const cadd = (c, k, n = 1) => { c[k] = (c[k] ?? 0) + n; };

  class LifeCity {
    constructor(board) {
      this.board = board;
      this.by_slot = new Map(); // minute of the day -> ids rolled then
      this.agenda = new Map(); // tick -> [[kind, id, arg]]
      this.loans = [];
      this.counts = {}; // a Counter in Python
      this.today = {};
      this.yesterday = {};
      this.luck_log = []; // a deque(maxlen=LUCK_LOG_SIZE) in Python
    }
  }

  // --- small helpers -------------------------------------------------------------------------------------

  const _stream = (sim, ns_name, ...parts) => G.dice.stream(G.people.dice_seed(sim), G.dice[ns_name], ...parts);
  const _sid = x => G.dice.sid(x);

  // One luck-shifted roll, logged (people.log_roll): true when it comes up.
  function _hit(sim, p, what, base, valence, rr, k = 1.0) {
    const prob = G.dice.odds(base, valence, p.luck, k);
    const roll = rr.random();
    G.people.log_roll(sim, p, what, prob, roll);
    return roll < prob;
  }

  const _named = (sim, p) => sim.agents.has(p.id);
  const _person = (sim, pid) => G.people.person(sim, pid);
  const _members = (sim, p) => G.people.members(sim, p);
  const _traits = p => G.people.traits(p);
  const _sex = p => p.sex || G.people.sex(p);
  const _kind = rel => rel.kind;

  // A life event: named through `sim.event`; folk only from importance 1 (`news_gate` caps them).
  function _event(sim, p, text, tag, importance = null, agents = null) {
    if (_named(sim, p)) {
      const o = { tag, agents };
      if (importance !== null) o.importance = importance;
      sim.event(text, p, null, o);
    } else if (importance !== null && importance >= 1) {
      sim.event(text, null, null, { tag, importance, agents: [p.id].concat((agents || []).filter(a => a !== p.id)) });
    }
  }

  function _agenda(sim, tick, kind, pid, arg = null) {
    let rows = sim.life.agenda.get(tick);
    if (rows === undefined) { rows = []; sim.life.agenda.set(tick, rows); }
    rows.push([kind, pid, arg]);
  }

  function _place_name(sim, place_id) {
    const place = sim.town.places.get(place_id);
    return place ? place.name : place_id;
  }

  // Millbrook's hospital for a named (Rule R through `sim.nearest`), else the town's first hospital.
  function _hospital_id(sim, p) {
    if (_named(sim, p)) {
      const place = sim.nearest(p, ["hospital"]);
      if (place !== null && place !== undefined) return place.id;
    }
    return "hospital";
  }

  // The living partner in `p`'s household (a PARTNER relationship), or null.
  function _partner(sim, p) {
    for (const [oid, rel] of p.relationships) {
      if (_kind(rel) === "partner") {
        const other = _person(sim, oid);
        if (other !== null && other !== undefined && other.alive && other.household_id === p.household_id) return other;
      }
    }
    return null;
  }

  // `p`'s household's living under-18s other than `p`.
  const _children = (sim, p) => _members(sim, p).filter(m => m !== p && m.age < ADULT_AGE);

  // --- setup ---------------------------------------------------------------------------------------------

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
    for (const p of G.people.everyone(sim)) init_person(sim, p);
    seed_story(sim);
  }

  // Give a person (named, folk, newcomer or newborn) a LifeState and a daily slot.
  function init_person(sim, p) {
    const h = _sid(p.id);
    p.life = new LifeState(h % YEAR_DAYS, h % 1380, h % 90);
    if (p.job !== null && p.job.hourly_wage > 0) {
      p.life.last_wage = p.job.hourly_wage;
    } else if (p.job === null && ADULT_AGE <= p.age && p.age < 65) {
      p.life.jobless_since = sim.clock.day; // an adult under 65 with no job looks for one
    }
    let ids = sim.life.by_slot.get(p.life.slot);
    if (ids === undefined) { ids = []; sim.life.by_slot.set(p.life.slot, ids); }
    ids.push(p.id);
  }

  // The start (life.md 5.9): see life.py.
  function seed_story(sim) {
    G.social.seed_story(sim);
    for (const p of G.people.everyone(sim)) {
      const rr = _stream(sim, "STORY", p.id, "life");
      if (p.age >= 30) {
        let cum = 0.0;
        for (let age = 30; age <= Math.min(p.age, G.life_tables.AGE_MAX); age++) cum += G.life_tables.CHRONIC_YEAR[age];
        for (const cid of CHRONIC) {
          if (rr.random() < cum / CHRONIC.length) {
            p.life.chronic.push(cid);
            if (rr.random() < 0.4 + 0.5 * _traits(p).health) p.life.treated.push(cid);
          }
        }
      }
      if (!_named(sim, p) && _sex(p) === "f" && p.age >= 20 && p.age <= 44 && rr.random() < SEED_PREGNANT
        && _partner(sim, p) !== null) {
        _conceive(sim, p, _partner(sim, p), rr.int(5, PREGNANCY_DAYS), true);
      }
    }
    const shira = sim.agents.get("shira") ?? null, eli = sim.agents.get("eli") ?? null;
    if (shira !== null && eli !== null && shira.alive) _conceive(sim, shira, eli, SHIRA_DUE[0], true);
    const ari = sim.agents.get("ari") ?? null;
    if (ari !== null) _agenda(sim, ARI_BILL[0] * DAY + ARI_BILL[1], "bill", ari.id, null);
  }

  function _conceive(sim, mother, other, due_day, quiet = false) {
    mother.life.pregnant = [due_day, other !== null ? other.id : null];
    mother.life.trying = false;
    _agenda(sim, due_day * DAY + BIRTH_MINUTE, "birth", mother.id, null);
    if (!quiet) {
      _event(sim, mother, other !== null ? `${mother.name} and ${other.name} are expecting a baby.`
        : `${mother.name} is expecting a baby.`, "expecting", null, other !== null ? [other.id] : null);
    }
  }

  // --- the clock -----------------------------------------------------------------------------------------

  // Each tick: the agenda, then the daily rolls of the people whose slot is this minute, and on Sundays
  // 09:00-19:00 the money week of each adult (`money.weekly`) at minute 09:00 + slot % 600.
  function tick(sim) {
    const lc = sim.life;
    const t = sim.clock.tick;
    const m = sim.clock.minute_of_day;
    if (m === 0) {
      lc.yesterday = lc.today;
      lc.today = {};
    }
    if (m % 60 === 0) _ward_care(sim, t);
    const due = lc.agenda.get(t);
    if (due !== undefined) {
      lc.agenda.delete(t);
      for (const [kind, pid, arg] of due) _run_agenda(sim, kind, pid, arg);
    }
    const ids = lc.by_slot.get(m);
    if (ids !== undefined && ids.length) {
      const day = sim.clock.day;
      for (const pid of ids.slice()) {
        const p = _person(sim, pid);
        if (p !== null && p !== undefined && p.alive) daily(sim, p, day);
      }
    }
    const M = G.money;
    if (sim.clock.weekday === M.SUNDAY && M.WINDOW[0] <= m && m < M.WINDOW[1]) {
      const k = m - M.WINDOW[0];
      for (const base of [k, k + 600, k + 1200]) {
        for (const pid of (lc.by_slot.get(base) ?? []).slice()) {
          const p = _person(sim, pid);
          if (p !== null && p !== undefined && p.alive && p.is_adult) M.weekly(sim, p);
        }
      }
    }
  }

  // Hourly, for the named in a hospital ward: fed, rested and treated.
  function _ward_care(sim, t) {
    for (const a of sim.agents.values()) {
      const life = a.life;
      if (a.alive && life !== null && life.ward_until > t) {
        for (const n of ["hunger", "energy"]) a.needs[n] = Math.max(a.needs[n], 60.0);
        a.health = Math.min(max_health(a), a.health + WARD_HEAL);
      }
    }
  }

  function _run_agenda(sim, kind, pid, arg) {
    const p = _person(sim, pid);
    if (p === null || p === undefined || !p.alive) return;
    if (kind === "birth") {
      if (p.life.pregnant !== null) {
        const other = p.life.pregnant[1];
        p.life.pregnant = null;
        birth(sim, p, other);
      }
    } else if (kind === "discharge") {
      _discharge(sim, p, arg);
    } else if (kind === "hospital") {
      hospitalise(sim, p, arg[0], arg[1]);
    } else if (kind === "bill") {
      const amount = Math.trunc(Math.max(0.0, p.money + p.savings) + 300);
      p.money -= amount;
      _event(sim, p, `${p.name} gets a bill for $${commas(amount)} that they cannot pay.`, "expense",
        amount >= 2000 ? 2 : 1);
    }
  }

  // v2's old-age roll and yearly birthday: emptied, because birthdays and mortality replace them.
  function legacy_ageing(sim) { return null; }

  // `p`'s daily rolls: birthday, health and death, family, work.
  function daily(sim, p, day) {
    const life = p.life;
    if (day && day % YEAR_DAYS === life.birthday) birthday(sim, p);
    if (life.grief_until > day) p.adjust("fun", -1);
    const rr = _stream(sim, "DAY_HEALTH", p.id, day);
    _health(sim, p, rr, day);
    if (!p.alive) return;
    _family(sim, p, day);
    G.career.daily(sim, p, _stream(sim, "DAY_CAREER", p.id, day));
  }

  // A year older (life.md 5.6): see life.py.
  function birthday(sim, p) {
    p.age += 1;
    if (!_named(sim, p)) {
      G.folk.on_birthday(sim, p);
      G.folk.on_job_change(sim, p);
      return;
    }
    const student = p.job !== null && p.job.hourly_wage === 0 && p.job.place_id === "school";
    if (p.age === SCHOOL_AGE && p.job === null) {
      p.job = G.cast._student_job(p.age);
    } else if (student && p.age >= ADULT_AGE) {
      p.job = null;
      p.life.jobless_since = sim.clock.day;
      _event(sim, p, `${p.name} turns ${p.age} and finishes school.`, "came_of_age");
    } else if (student) {
      p.job = G.cast._student_job(p.age);
    }
  }

  // An under-5's next step (no forks): two hours at home doing `baby`, needs topped back up to 75.
  function toddle(sim, p) {
    for (const n of Object.keys(p.needs)) p.needs[n] = Math.max(p.needs[n], 75.0);
    sim.start_plan(p, [["baby", "home"]]);
  }

  // --- health --------------------------------------------------------------------------------------------

  function _health(sim, p, rr, day) {
    const life = p.life;
    const t = sim.clock.tick;
    const T = G.life_tables;
    for (const c of life.conditions.slice()) {
      if (c.until <= t) {
        life.conditions.splice(life.conditions.indexOf(c), 1);
        _event(sim, p, `${p.name} has got over ${LABELS[c.id] ?? c.id}.`, "recovered");
      }
    }
    if (life.conditions.length) p.health = Math.min(p.health, ILL_CAP);
    if (!life.conditions.length && life.ward_until === 0) {
      const season = SEASON_INDEX[sim.clock.season];
      const weights = [];
      let total = 0.0;
      for (const row of ACUTE) {
        const w = row[1] * row[4][season] * (p.age < ADULT_AGE ? row[2] : p.age >= 65 ? row[3] : 1.0);
        weights.push(w);
        total += w;
      }
      const heart = T.HEART_YEAR[Math.min(p.age, T.AGE_MAX)] * T.MULT_UNTREATED[Math.min(_untreated(p), 6)];
      for (const [, share] of HEART) {
        weights.push(heart * share);
        total += heart * share;
      }
      if (_hit(sim, p, "ill", total * PACE.health / YEAR_DAYS, -1, rr)) {
        let x = rr.random() * total;
        let i = 0;
        while (i < weights.length - 1 && x >= weights[i]) {
          x -= weights[i];
          i += 1;
        }
        if (i < ACUTE.length) _fall_ill(sim, p, ACUTE[i], rr);
        else _heart(sim, p, HEART[i - ACUTE.length], rr);
      }
    }
    // Catching it at home (life.md 5.5: home .08/.15/.10 a day while a housemate is contagious).
    if (!life.conditions.length && life.ward_until === 0) {
      for (const m of _members(sim, p)) {
        if (m === p || m.life === null) continue;
        const c = m.life.conditions.find(c => c.contagious_until > t);
        if (c !== undefined) {
          const row = ACUTE.find(r => r[0] === c.id);
          if (row !== undefined && row[9] > 0 && _hit(sim, p, "catch", row[9], -1, rr)) _fall_ill(sim, p, row, rr);
          break;
        }
      }
    }
    // Chronic onset (permanent).
    if (p.age >= 30 && life.chronic.length < CHRONIC.length) {
      if (_hit(sim, p, "chronic", T.CHRONIC_YEAR[Math.min(p.age, T.AGE_MAX)] / YEAR_DAYS, -1, rr)) {
        const left = CHRONIC.filter(c => !life.chronic.includes(c));
        const cid = left[Math.trunc(rr.random() * left.length)];
        life.chronic.push(cid);
        const treated = rr.random() < 0.4 + 0.5 * _traits(p).health;
        if (treated) life.treated.push(cid);
        _event(sim, p, `${p.name} is diagnosed with ${LABELS[cid]}` + (treated ? " and starts treatment." : "."),
          "chronic");
      }
    }
    // Mortality (life.md 5.5): daily, luck -1.
    let q = T.DEATH_YEAR[Math.min(p.age, T.AGE_MAX)] * PACE.death / YEAR_DAYS
      * T.MULT_UNTREATED[Math.min(_untreated(p), 6)] * T.MULT_TREATED[Math.min(life.treated.length, 6)];
    if (p.health < LOW_HEALTH) q *= 3;
    const heart_ward = life.ward_until > t && life.conditions.some(c => c.id === "heart_attack" || c.id === "stroke");
    if (heart_ward) q *= 10;
    if (_hit(sim, p, "death", q, -1, rr)) die(sim, p, _cause(p, heart_ward));
  }

  const _untreated = p => p.life.chronic.filter(c => !p.life.treated.includes(c)).length;

  function _cause(p, heart_ward) {
    if (heart_ward) return "died in hospital after a heart attack";
    if (p.life.chronic.length && p.age >= 50) return "died after a long illness";
    if (p.age >= 80) return "passed away peacefully in their sleep";
    if (p.age < 40) return "died in a road accident";
    return "died suddenly";
  }

  function _fall_ill(sim, p, row, rr) {
    const cid = row[0], days = row[5], hit = row[7], contagious = row[8];
    let off = row[6];
    const t = sim.clock.tick;
    let d = rr.int(days[0], days[1]);
    if (cid === "back_pain" && p.job !== null && _manual(sim, p)) off = BACK_PAIN_MANUAL;
    let o = rr.int(off[0], off[1]);
    const doctor = cid !== "cold" && rr.random() < 0.3 + 0.5 * _traits(p).health;
    if (doctor) {
      d = Math.max(1, Math.trunc(d * DOCTOR_DAYS + 0.5));
      o = Math.min(o, d);
    }
    const c = new Condition(cid, t, t + d * DAY, t + o * DAY, t + contagious * DAY, hit, doctor);
    p.life.conditions.push(c);
    p.health = Math.max(1.0, p.health - hit);
    _event(sim, p, `${p.name} comes down with ${LABELS[cid]}.`, "ill", cid === "cold" ? 0 : null);
    if (doctor) _see_doctor(sim, p);
    if (cid === "fracture") hospitalise(sim, p, 1, "a broken bone");
  }

  function _heart(sim, p, row, rr) {
    const cid = row[0];
    const t = sim.clock.tick;
    const d = rr.int(HEART_DAYS[0], HEART_DAYS[1]);
    const c = new Condition(cid, t, t + d * DAY, t + d * DAY, t, HEART_HEALTH, true);
    p.life.conditions.push(c);
    p.health = Math.max(1.0, p.health - HEART_HEALTH);
    hospitalise(sim, p, rr.int(HEART_WARD[0], HEART_WARD[1]), LABELS[cid]);
    if (_hit(sim, p, "heart_fatal", HEART_FATAL * DOCTOR_COMPLICATIONS, -1, rr)) die(sim, p, `died after ${LABELS[cid]}`);
  }

  function _manual(sim, p) {
    const place = sim.town.places.get(p.job.place_id);
    return place !== undefined && place.kind === "works";
  }

  // A doctor's visit ($40): a named who is free goes to Millbrook's hospital; anyone else is seen without a trip.
  function _see_doctor(sim, p) {
    const payer = _payer(sim, p, DOCTOR_FEE);
    payer.money -= DOCTOR_FEE;
    if (_named(sim, p)) {
      _event(sim, p, `${p.name} sees a doctor.`, "doctor");
      if (p.state === "idle" && !p.plan.length && p.fork_id === null && p.age >= FORK_AGE) {
        sim.start_plan(p, [["doctor", _hospital_id(sim, p)]]);
      }
    }
  }

  // Who pays `p`'s bill: an adult pays their own; a child's goes to the household's richest adult.
  function _payer(sim, p, cost) {
    if (p.is_adult || cost <= Math.max(p.money, 0)) return p;
    const adults = _members(sim, p).filter(m => m.is_adult);
    let best = null;
    for (const a of adults) {
      if (best === null || a.money > best.money) best = a;
    }
    return best !== null ? best : p;
  }

  // A v2 outcome costing 8+ health starts a sprain (7-14 days, 0-3 off), if nothing acute is on.
  function note_injury(sim, p, health_lost) {
    if (health_lost < 8 || p.life.conditions.length) return;
    const rr = _stream(sim, "DAY_HEALTH", p.id, "sprain", sim.clock.tick);
    const t = sim.clock.tick;
    const d = rr.int(SPRAIN[0][0], SPRAIN[0][1]);
    const o = rr.int(SPRAIN[1][0], SPRAIN[1][1]);
    p.life.conditions.push(new Condition("sprain", t, t + d * DAY, t + o * DAY, t, Math.trunc(health_lost)));
  }

  // Take `p` to hospital for `days` (life.md 5.5): see life.py.
  function hospitalise(sim, p, days, why) {
    const t = sim.clock.tick;
    const life = p.life;
    if (life.ward_until > t) return;
    if (!_named(sim, p)) {
      life.ward_until = t + days * DAY;
      G.folk.hospitalise(sim, p, days);
      _event(sim, p, `${p.name} is taken to hospital (${why}).`, "hospital", 1);
      _agenda(sim, life.ward_until, "discharge", p.id, days);
      return;
    }
    if (days <= 1 && why === "very unwell") {
      // v2's ambulance for health below 25 (sim._next): an afternoon on the `hospital` activity.
      sim.event(`${p.name} feels very unwell, and an ambulance takes them to `
        + `${sim.town.places.get("hospital").name}.`, p, null, { tag: "hospital" });
      sim.start_plan(p, [["hospital", "hospital"]], "ambulance"); // free; the hospital's fee stays
      return;
    }
    if (p.trip !== null || p.riding !== null) {
      _agenda(sim, t + 10, "hospital", p.id, [days, why]); // off the bus first
      return;
    }
    sim._withdraw_fork(p);
    life.ward_until = t + days * DAY;
    const place_id = _hospital_id(sim, p);
    sim.event(`${p.name} feels very unwell, and an ambulance takes them to `
      + `${_place_name(sim, place_id)} (${why}).`, p, null, { tag: "hospital" });
    sim.start_plan(p, [["ward", place_id]], "ambulance");
    _agenda(sim, life.ward_until, "discharge", p.id, days);
  }

  function _discharge(sim, p, days) {
    if (p.life.ward_until === 0) return;
    p.life.ward_until = 0;
    const fee = WARD_FEE * days;
    const payer = _payer(sim, p, fee);
    payer.money -= fee;
    if (_named(sim, p)) {
      const by = payer === p ? "" : ` by ${firstName(payer.name)}`;
      sim.event(`${p.name} leaves ${_place_name(sim, "hospital")} (paid $${fmtc(fee, 0)}${by}).`, p, null,
        { tag: "discharged" });
    }
  }

  // The most health `p` heals to: 100, less .8 a year past 55 and 5 for each chronic condition.
  function max_health(p) {
    const life = p.life ?? null;
    const n = life !== null ? life.chronic.length : 0;
    return 100.0 - Math.max(0, p.age - FRAIL_AGE) * FRAIL_RATE - CHRONIC_HEALTH * n;
  }

  // False while an illness keeps `p` off work or school, or in hospital.
  function can_work(sim, p) {
    const life = p.life ?? null;
    if (life === null) return true;
    if (life.ward_until > 0) return false;
    const t = sim.clock.tick;
    for (const c of life.conditions) {
      if (c.off_until > t) return false;
    }
    return true;
  }

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

  // A talk between `a` and `b` (L1's social.tick): a contagious cold passes at .03, flu at .06 (luck -1).
  function infect(sim, a, b) {
    for (const [src, dst] of [[a, b], [b, a]]) {
      if (dst.life === null || dst.life.conditions.length || src.life === null || dst.life.ward_until) continue;
      const c = src.life.conditions.find(c => c.contagious_until > sim.clock.tick);
      if (c === undefined || (c.id !== "cold" && c.id !== "flu")) continue;
      const rr = _stream(sim, "DAY_HEALTH", dst.id, "talk", sim.clock.tick);
      if (_hit(sim, dst, "catch", c.id === "cold" ? 0.03 : 0.06, -1, rr)) _fall_ill(sim, dst, ACUTE.find(r => r[0] === c.id), rr);
    }
  }

  // --- death ---------------------------------------------------------------------------------------------

  // Every death goes through here: see life.py.
  function die(sim, p, how) {
    if (!p.alive) return;
    if (_named(sim, p)) {
      sim._die(p, how);
      on_death(sim, p); // a no-op once sim._die has called it (the hooks)
      return;
    }
    G.folk.kill(sim, p, how);
    let loved = false;
    for (const [oid, r] of p.relationships) {
      const o = _person(sim, oid);
      if (o !== null && o !== undefined && o.alive && _named(sim, o) && r.affinity >= 40) loved = true;
    }
    _event(sim, p, `${p.name} ${how}, aged ${p.age}.`, "death", loved ? 2 : 1);
    on_death(sim, p);
  }

  // After a death: see life.py. Runs once per death.
  function on_death(sim, p) {
    const lc = sim.life;
    const life = p.life;
    if (life === null || life === undefined) return;
    const ids = lc.by_slot.get(life.slot) ?? [];
    if (!ids.includes(p.id)) return;
    ids.splice(ids.indexOf(p.id), 1);
    cadd(lc.counts, "deaths");
    const day = sim.clock.day;
    const rr = _stream(sim, "DAY_CAREER", p.id, "death", day);
    if (p.job !== null && (p.job.slot ?? -1) >= 0) {
      const b = lc.board;
      if (b.holder[p.job.slot] === p.id) b.free(p.job.slot, day + rr.int(G.career.REOPEN_DAYS[0], G.career.REOPEN_DAYS[1]));
    }
    const named = _named(sim, p);
    for (const [oid, rel] of p.relationships) {
      const other = _person(sim, oid);
      if (other === null || other === undefined || !other.alive || other.life === null) continue;
      if (_kind(rel) === "partner") {
        other.life.widowed_day = day;
        other.life.grief_until = day + GRIEF_DAYS;
      }
      if (rel.affinity > 30 && !(named && _named(sim, other))) {
        other.adjust("fun", -40);
        other.adjust("social", -20);
        other.remember(sim.clock.stamp(), `Lost ${p.name}.`);
      }
    }
    lc.loans = lc.loans.filter(row => row.lender !== p.id && row.borrower !== p.id);
    for (const t of Array.from(lc.agenda.keys())) {
      const rows = lc.agenda.get(t).filter(row => row[1] !== p.id);
      if (rows.length) lc.agenda.set(t, rows);
      else lc.agenda.delete(t);
    }
    life.pregnant = null;
    life.ward_until = 0;
  }

  // --- births and family ---------------------------------------------------------------------------------

  function _family(sim, p, day) {
    const life = p.life;
    if (p.is_adult && _named(sim, p) && _children(sim, p).some(c => c.age === 0)) p.adjust("energy", -BABY_ENERGY); // named parents of a newborn
    if (life.pregnant !== null || !(p.age >= 20 && p.age < 45) || _sex(p) !== "f") return;
    const other = _partner(sim, p);
    if (other === null || other.age < ADULT_AGE) {
      if (life.trying) life.trying = false;
      return;
    }
    const rr = _stream(sim, "BIRTH", p.id, day);
    if (day % WANT_EVERY === life.slot % WANT_EVERY) {
      const younger = Math.min(p.age, other.age);
      const family = (_traits(p).family + _traits(other).family) / 2;
      life.trying = younger >= 20 && younger <= 44 && rr.random() < Math.min(0.9, 1.2 * family) && _can_afford_child(sim, p);
    }
    if (!life.trying) return;
    let b = 0.0;
    for (const [under, rate] of CONCEPTION) {
      if (p.age < under) { b = rate; break; }
    }
    const n = Math.min(_children(sim, p).length, 3);
    if (rr.random() < b * CHILDREN_MULT[n] * PACE.birth / YEAR_DAYS) _conceive(sim, p, other, day + PREGNANCY_DAYS);
  }

  // Funds of at least 4 weeks' outgo (named households; folk: their own money).
  function _can_afford_child(sim, p) {
    if (!_named(sim, p)) return p.money + p.savings > 0;
    const hh = sim.households.get(p.household_id);
    return G.housing.funds(sim, hh) >= 4 * G.housing.weekly_outgo(sim, hh);
  }

  // A baby is born to `mother`: see life.py.
  function birth(sim, mother, other) {
    const lc = sim.life;
    const father = other ? (_person(sim, other) ?? null) : null;
    cadd(lc.counts, "births");
    if (!_named(sim, mother)) {
      const baby = G.folk.add_baby(sim, mother, father);
      let loved = false;
      for (const [oid, r] of mother.relationships) {
        const o = _person(sim, oid);
        if (o !== null && o !== undefined && _named(sim, o) && _kind(r) === "family") loved = true;
      }
      const name = baby !== null && baby !== undefined ? firstName(baby.name) : "a baby";
      _event(sim, mother, `${mother.name} has a baby: ${name}.`, "birth", loved ? 2 : 1,
        baby !== null && baby !== undefined ? [baby.id] : null);
      return;
    }
    const baby = _named_baby(sim, mother, father);
    const with_ = father !== null ? ` and ${father.name}` : "";
    sim.event(`${mother.name}${with_} welcome a baby, ${baby.name}.`, mother, null,
      { tag: "birth", agents: [baby.id].concat(father !== null ? [father.id] : []) });
  }

  // A new named Agent in the mother's household, at its home's entry (life.md 5.6).
  function _named_baby(sim, mother, father) {
    const { Agent, Profile, RelationKind } = G.agent;
    const rr = _stream(sim, "NAME", mother.id, sim.clock.day);
    const female = rr.random() < 0.5;
    const used = new Set(Array.from(sim.agents.values(), a => firstName(a.name)));
    const names = female ? G.cast.FEMALE : G.cast.MALE;
    let pool = names.filter(n => !used.has(n));
    if (!pool.length) pool = names.slice();
    const first = rr.pick(pool);
    const surname = lastName((father !== null && _named(sim, father) ? father : mother).name);
    let bid = first.toLowerCase();
    if (sim.agents.has(bid)) bid = `${first}_${surname}`.toLowerCase().replace(/-/g, "_");
    let n = 2;
    while (sim.agents.has(bid)) {
      bid = `${first}_${surname}_${"x".repeat(n)}`.toLowerCase();
      n += 1;
    }
    const ta = _traits(mother), tb = _traits(father !== null ? father : mother);
    const traits = {};
    for (const k of Profile.TRAITS) {
      traits[k] = G.rng.r2(Math.max(0.0, Math.min(1.0, (ta[k] + tb[k]) / 2 + rr.uniform(-0.1, 0.1))));
    }
    const hh = sim.households.get(mother.household_id);
    const place = sim.town.places.get(sim.homes.get(hh.home_id).place);
    const baby = new Agent({ id: bid, name: `${first} ${surname}`, age: 0, household_id: hh.id, money: 0.0, job: null,
      owns_car: false, x: place.entry[0], y: place.entry[1], inside: place.id, profile: new Profile(traits) });
    baby.sex = female ? "f" : "m";
    for (const m of _members(sim, mother)) {
      if (sim.agents.has(m.id)) {
        m.relate(bid, RelationKind.FAMILY, FAMILY_AFFINITY);
        baby.relate(m.id, RelationKind.FAMILY, FAMILY_AFFINITY);
      }
    }
    sim.agents.set(bid, baby);
    hh.member_ids.push(bid);
    init_person(sim, baby);
    baby.life.jobless_since = null;
    return baby;
  }

  // A named leaves their household after a split (life.md 5.3): see life.py.
  function split(sim, p) {
    const old = sim.households.get(p.household_id);
    const leaving = [p].concat(_children(sim, p).filter(() => _partner(sim, p) === null));
    const home = G.housing.cheapest_rental(sim, old);
    if (home !== null && home !== undefined && G.housing.new_household(sim, leaving, home.id, "rent") !== null) return true;
    for (const [oid, rel] of p.relationships) {
      const o = sim.agents.get(oid);
      if (o !== undefined && o.alive && _kind(rel) === "family" && o.age > p.age && o.household_id !== p.household_id) {
        old.member_ids.splice(old.member_ids.indexOf(p.id), 1);
        p.household_id = o.household_id;
        sim.households.get(o.household_id).member_ids.push(p.id);
        return true;
      }
    }
    return false;
  }

  // --- pages ---------------------------------------------------------------------------------------------

  function _partner_row(sim, p) {
    for (const [oid, rel] of p.relationships) {
      const kind = _kind(rel);
      if (kind === "partner" || kind === "dating") {
        const other = _person(sim, oid);
        if (other === null || other === undefined || !other.alive) continue;
        const since = rel.since || 0;
        return { id: oid, name: other.name, kind, married: Boolean(rel.married),
          days: Math.max(0, Math.floor((sim.clock.tick - since) / DAY)) };
      }
    }
    return null;
  }

  const _debt = p => Math.trunc(Math.max(0.0, -(p.money + p.savings)));

  // The `life` block of a character page (life.md 8.1).
  function page(sim, p) {
    const life = p.life;
    const t = sim.clock.tick;
    const partner = _partner_row(sim, p);
    const kids = [];
    let friends = 0;
    const rivals = [];
    for (const [oid, rel] of p.relationships) {
      const kind = _kind(rel);
      const o = _person(sim, oid);
      if (o === null || o === undefined) continue;
      if (kind === "family" && o.age < p.age - 14) kids.push({ id: oid, name: o.name, age: o.age });
      else if (kind === "friend" && o.alive) friends += 1;
      else if (kind === "rival" && o.alive) rivals.push({ id: oid, name: o.name });
    }
    const conds = life.conditions.map(c => ({ id: c.id, label: LABELS[c.id] ?? c.id,
      days_left: Math.max(0, Math.ceil((c.until - t) / DAY)), off_work: c.off_until > t }));
    let preg = null;
    if (life.pregnant !== null) {
      const other = life.pregnant[1] ? (_person(sim, life.pregnant[1]) ?? null) : null;
      preg = { with: life.pregnant[1], name: other !== null ? other.name : null,
        days_left: Math.max(0, life.pregnant[0] - sim.clock.day) };
    }
    const day = sim.clock.day;
    const loans = [];
    for (const row of sim.life.loans) {
      if (row.lender === p.id || row.borrower === p.id) {
        const lent = row.lender === p.id;
        const oid = lent ? row.borrower : row.lender;
        const o = _person(sim, oid);
        loans.push({ id: row.id, with: oid, name: o !== null && o !== undefined ? o.name : oid, dir: lent ? "lent" : "borrowed",
          amount: Math.trunc(row.amount) });
      }
    }
    return { stage: stage(p), birthday: life.birthday, partner, children: kids, friends, rivals, conditions: conds,
      chronic: life.chronic.slice(), pregnant: preg,
      work: { standing: Math.trunc(p.reputation + 0.5), warnings: life.warnings,
        days_in_job: p.job !== null ? day - life.job_since : null,
        jobless_days: life.jobless_since !== null ? day - life.jobless_since : null,
        benefit: G.career.benefit(sim, p) > 0 },
      money: { lifestyle: Math.trunc(life.lifestyle + 0.5), debt: _debt(p), loans },
      talks: life.talks.length && typeof life.talks[0] === "object" && !Array.isArray(life.talks[0])
        ? life.talks.map(x => Object.assign({}, x)) : [] };
  }

  // `you.life` in a fork message (life.md 8.2).
  function fork_you(sim, agent) {
    const life = agent.life;
    const partner = _partner_row(sim, agent);
    let kids = 0;
    for (const [oid, rel] of agent.relationships) {
      const o = _person(sim, oid);
      if (_kind(rel) === "family" && o !== null && o !== undefined && o.age < agent.age - 14) kids += 1;
    }
    return { partner: partner ? { id: partner.id, name: partner.name, kind: partner.kind, married: partner.married } : null,
      children: kids, conditions: life.conditions.map(c => LABELS[c.id] ?? c.id),
      standing: Math.trunc(agent.reputation + 0.5),
      jobless_days: life.jobless_since !== null ? sim.clock.day - life.jobless_since : null,
      debt: _debt(agent) };
  }

  // `stats.city.life` (life.md 8.2), all ints.
  function stats_block(sim) {
    let ill_now = 0, in_hosp = 0, jobless = 0, in_debt = 0, partnered = 0;
    for (const p of G.people.everyone(sim)) {
      const life = p.life;
      if (life === null || life === undefined) continue;
      if (life.conditions.length) ill_now += 1;
      if (life.ward_until) in_hosp += 1;
      if (p.is_adult && p.age < 65 && p.job === null && life.jobless_since !== null) jobless += 1;
      if (p.is_adult && p.money + p.savings < 0) in_debt += 1;
      if (_partner_row(sim, p) !== null) partnered += 1;
    }
    const lc = sim.life;
    return { ill_now, in_hospital: in_hosp, couples: Math.floor(partnered / 2), births: cget(lc.counts, "births"),
      deaths: cget(lc.counts, "deaths"), jobless, in_debt, talks_today: cget(lc.today, "talks"),
      friendships_today: cget(lc.today, "new_friend") };
  }

  G.life = {
    FORK_AGE, PACE, YEAR_DAYS, DAY, LUCK_LOG_SIZE, SEASON_INDEX, ACUTE, HEART, HEART_DAYS, HEART_WARD, HEART_HEALTH,
    HEART_FATAL, BACK_PAIN_MANUAL, CHRONIC, LABELS, SPRAIN, DOCTOR_FEE, DOCTOR_DAYS, DOCTOR_COMPLICATIONS, WARD_FEE,
    ILL_CAP, WARD_HEAL, LOW_HEALTH, FRAIL_AGE, FRAIL_RATE, CHRONIC_HEALTH, GRIEF_DAYS, CONCEPTION, CHILDREN_MULT,
    PREGNANCY_DAYS, BIRTH_MINUTE, WANT_EVERY, NEW_BABY_DAYS, BABY_ENERGY, FAMILY_AFFINITY, SCHOOL_AGE, ADULT_AGE,
    SHIRA_DUE, ARI_BILL, SEED_PREGNANT, TODDLE_MINUTES, ACTIVITIES_EXTRA, Condition, LifeState, LifeCity, cget, cadd,
    _stream, _sid,
    _hit, _named, _person, _event, _agenda, _hospital_id, _partner, _children, pre_init, init, init_person,
    seed_story, _conceive, tick, _ward_care, _run_agenda, legacy_ageing, daily, birthday, toddle, _health, _cause,
    _fall_ill, _heart, _see_doctor, _payer, note_injury, hospitalise, _discharge, max_health, can_work, in_hospital,
    ill, stage, infect, die, on_death, _family, birth, _named_baby, split, page, fork_you, stats_block,
  };
})(globalThis.GameOfAILife || (globalThis.GameOfAILife = {}));

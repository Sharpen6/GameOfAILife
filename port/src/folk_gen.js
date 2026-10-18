// Port of gameofailife/folk_gen.py: townsfolk generation (folk.md 4 with region.md 7's five demand rules, PLAN 2.6
// and 2.15). `populate(folk, sim, n)` fills `folk.people` and `folk.households`; every job slot of
// `town.job_slots` goes on the career board. Streams on `sim.seed`: (NS_GEN, "deck"), (NS_GEN, "hh", j),
// (NS_GEN, "match"), (NS_GEN, "new", k), (NS_GEN, "baby", k). Function by function with folk_gen.py.
(function (G) {
  "use strict";
  const { cmp, sortedBy } = G.py;
  const { r2 } = G.rng;

  // --- households (folk.md 4.1) ---
  const KINDS = [["single_young", 9], ["single_mid", 7], ["single_old", 8], ["couple_young", 8], ["couple_mid", 12],
    ["couple_old", 12], ["family", 25], ["single_parent", 7], ["sharers", 4], ["three_gen", 3], ["grown_kids", 5]];
  const DECK_SCALE = 4.21;
  const OPPOSITE_SEX = 0.9;
  const SHARED_SURNAME = 0.75;
  // --- region.md 7's demand rules (PLAN 2.6) ---
  const CAR_P = { flat: 0.2, house: 0.55, big_house: 0.9 };
  const CAR_NEAR_STATION = 0.6, STATION_NEAR = 15;
  const WALK_CAP = 40, CAR_CAP = 35, TRAIN_CAP = 50;
  const TRAIN_SAVES = 5, CAR_TRAIN_PREF = 8, WALK_ONLY = 12;
  const RES_BASE = 15, RES_SKILL = 25;
  const SKILL_W = 25, JITTER = 6;
  // --- Millbrook rows and schools ---
  const MB_WALK = 25, MB_CAR = 30;
  const MB_PUPILS = 40;
  const SCHOOL_WALK = 25;
  const TEEN_AGE = 11, TEEN_TRAIN_CAP = 45, HIGH_SCHOOL = "high_school";
  const SCHOOL_SEATS = 300;
  const MILLBROOK_SCHOOL = "school";
  // --- staggered starts: not everyone on the street on the hour ---
  const SHIFT_OFFSETS = [-30, -15, 0, 15, 30]; // minutes: a region worker's own start (and end) against the row's hours
  // minutes: the region's schools start at 08:30, Riverton High (HIGH_SCHOOL) and Millbrook's at 08:00
  const SCHOOL_LATE = 30;
  // --- seekers and money ---
  const STUDY_P = 0.3, IDLE_P = 0.07;
  const PENSION = 400;
  const NO_SAVINGS_P = 0.25;
  const SAVINGS_CAP = 20000;
  const SAVINGS_WEEKS = { low: [0, 4], mid: [2, 10], high: [10, 30], retired: [3, 15] };
  const LOW_PAY = 600, HIGH_PAY = 1100;
  // --- ties ---
  const COWORKERS = 3, CLASSMATES = 3, NEIGHBOURS = 2;
  const NAMED_COWORKERS = 3, NAMED_CLASSMATES = 2;
  const FRIEND_AGE_GAP = 8;

  const FM = () => G.folk_model;

  // --- dice ---
  const stream = (seed, ...parts) => G.dice.stream(seed, ...parts);

  // Minutes p's working or school day starts and ends after its job's hours. A townsperson on a region job row keeps
  // their own of SHIFT_OFFSETS (the key (NS_GEN, "shift", i) on sim.seed); a pupil at a region school but HIGH_SCHOOL
  // starts SCHOOL_LATE later; Millbrook's rows and school (where the 60 work and learn) and no job: 0.
  function shift_offset(sim, p) {
    const job = p.job;
    if (job === null || job === undefined) return 0;
    const mb = sim.town.millbrook_ids;
    if (mb && mb.has(job.place_id)) return 0;
    if (job.title === "student") return job.place_id === HIGH_SCHOOL ? 0 : SCHOOL_LATE;
    if (job.hourly_wage <= 0) return 0;
    return SHIFT_OFFSETS[G.dice.key(sim.seed, FM().NS_GEN, "shift", p.i) % SHIFT_OFFSETS.length];
  }

  const _round = x => Math.floor(x + 0.5);

  const _income_tax = wage => Math.min(0.45, 0.15 + 0.004 * wage); // sim.income_tax

  // Hours of one shift; a night shift (end <= start) runs past midnight.
  function shift_hours(job) {
    const h = job.end_hour - job.start_hour;
    return h > 0 ? h : h + 24;
  }

  // Take-home pay for a full week of shifts.
  function weekly_pay(job) {
    if (job === null || job === undefined || job.hourly_wage <= 0) return 0.0;
    return job.hourly_wage * shift_hours(job) * job.workdays.length * (1 - _income_tax(job.hourly_wage));
  }

  // --- geography ---

  // Door-to-door worst-case minutes for generation (region.md 7), cached by (from, to, car).
  class Geo {
    constructor(sim) {
      this.town = sim.town;
      this.net = G.roads.net(sim.town);
      this.worst = G.rail && G.rail.worst_minutes ? G.rail.worst_minutes : null;
      this.extra = G.region && G.region.car_extra ? G.region.car_extra : null;
      this.stations = [];
      for (const [pid, pl] of this.town.places) if (pl.kind === "station") this.stations.push(pid);
      this._train = new Map();
      this._commute = new Map();
      this._extra = new Map();
    }

    walk(a, b) { return this.net.minutes(a, b, "walk"); }

    // Drive plus the parking minutes at b's district.
    car(a, b) {
      let e = this._extra.get(b);
      if (e === undefined) {
        e = this.extra !== null ? this.extra(this.town, b) : 0;
        this._extra.set(b, e);
      }
      return this.net.minutes(a, b, "car") + e;
    }

    train(a, b, car) {
      if (this.worst === null) return null;
      const key = `${a}|${b}|${car ? 1 : 0}`;
      if (this._train.has(key)) return this._train.get(key);
      const got = this.worst(this.town, this.net, a, b, car);
      this._train.set(key, got);
      return got;
    }

    station_walk(a) {
      let best = 1 << 30;
      for (const s of this.stations) {
        const m = this.walk(a, s);
        if (m < best) best = m;
      }
      return best;
    }

    // The best allowed way for job matching: [minutes, mode] or null when out of reach.
    commute(a, b, car) {
      const key = `${a}|${b}|${car ? 1 : 0}`;
      if (this._commute.has(key)) return this._commute.get(key);
      const walk = this.walk(a, b);
      let best = null;
      if (walk <= WALK_CAP) best = [walk, "walk"];
      let drive = null;
      if (car) {
        drive = this.car(a, b);
        if (drive <= CAR_CAP && (best === null || _lt([drive, "car"], best))) best = [drive, "car"];
      }
      if (walk > WALK_ONLY) {
        const tr = this.train(a, b, car);
        if (tr !== null && tr <= TRAIN_CAP && tr <= walk - TRAIN_SAVES
            && (drive === null || tr <= drive + CAR_TRAIN_PREF)) {
          if (best === null || _lt([tr, "train"], best)) best = [tr, "train"];
        }
      }
      this._commute.set(key, best);
      return best;
    }

    // How they actually go (folk.md 5).
    mode(a, b, car) {
      const walk = this.walk(a, b);
      if (walk <= WALK_ONLY) return [walk, "walk"];
      const tr = this.train(a, b, car);
      if (car) {
        const drive = this.car(a, b);
        if (tr !== null && tr <= drive + CAR_TRAIN_PREF && tr <= walk - TRAIN_SAVES) return [tr, "train"];
        return [drive, "car"];
      }
      if (tr !== null && walk > 20 && tr <= walk - TRAIN_SAVES) return [tr, "train"];
      return [walk, "walk"];
    }
  }

  const _lt = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);

  // --- the job board ---

  // The career board's add/free/take as plain lists, for GenSim and test stubs (career.JobBoard in a sim).
  class ListBoard {
    constructor() {
      this.jobs = [];
      this.holder = [];
      this.reopen = new Map();
    }

    add(job, holder = null) {
      this.jobs.push(job);
      this.holder.push(holder);
      return this.jobs.length - 1;
    }

    take(slot, pid) { this.holder[slot] = pid; }

    free(slot) { this.holder[slot] = null; }
  }

  // The career board: `sim.job_board` when a stub holds one, else career.board(sim) (L2).
  function board(sim) {
    const b = sim.job_board;
    if (b !== null && b !== undefined) return b;
    return G.career.board(sim);
  }

  // people.set_rel (L1): both sides, creates or overwrites.
  function set_rel(sim, a_id, b_id, kind, affinity, affinity_b = null, fields = {}) {
    G.people.set_rel(sim, a_id, b_id, kind, affinity, affinity_b, fields);
  }

  // --- names ---

  function named_names(sim) {
    const out = new Set();
    for (const a of sim.agents.values()) out.add(a.name);
    return out;
  }

  const _first = (rr, sex) => rr.pick(sex === "f" ? G.folk_names.FEMALE : G.folk_names.MALE);

  // A first name for `sex` and `surname` not yet taken; after 40 tries the surname changes too.
  function unique_name(rr, sex, surname, taken) {
    for (let t = 0; t < 40; t++) {
      const name = _first(rr, sex) + " " + surname;
      if (!taken.has(name)) {
        taken.add(name);
        return name;
      }
    }
    for (;;) {
      const name = _first(rr, sex) + " " + rr.pick(G.folk_names.SURNAMES);
      if (!taken.has(name)) {
        taken.add(name);
        return name;
      }
    }
  }

  // A unique full name for baby k (F2a's add_baby), first name never a named one's.
  function baby_name(sim, sex, surname, k) {
    const taken = named_names(sim);
    for (const p of sim.folk.people) taken.add(p.name);
    return unique_name(stream(sim.seed, FM().NS_GEN, "baby", k), sex, surname, taken);
  }

  // --- 1. households ---

  function _kids(rr, young, most = 3) {
    const u = rr.random();
    let n = u < 0.5 ? 1 : u < 0.9 ? 2 : 3;
    if (n > most) n = most;
    let hi = young - 18;
    if (hi > 17) hi = 17;
    if (hi < 0) hi = 0;
    const out = [];
    for (let k = 0; k < n; k++) out.push(rr.int(0, hi));
    return out;
  }

  const _asKids = ks => ks.map(k => [k, "k"]);

  // [[age, role]]: role "a" a partner or the head, "k" a child, "g" a grandparent, "s" a sharer.
  function ages_for(rr, kind) {
    if (kind === "single_young") return [[rr.int(19, 34), "a"]];
    if (kind === "single_mid") return [[rr.int(35, 64), "a"]];
    if (kind === "single_old") return [[rr.int(65, 92), "a"]];
    if (kind === "couple_young") {
      const a = rr.int(22, 39);
      return [[a, "a"], [Math.max(19, a + rr.int(-4, 4)), "a"]];
    }
    if (kind === "couple_mid") {
      const a = rr.int(40, 64);
      return [[a, "a"], [Math.max(35, a + rr.int(-5, 5)), "a"]];
    }
    if (kind === "couple_old") {
      const a = rr.int(65, 88);
      return [[a, "a"], [Math.max(60, a + rr.int(-5, 5)), "a"]];
    }
    if (kind === "family") {
      const a = rr.int(25, 55);
      const b = Math.max(22, a + rr.int(-4, 4));
      return [[a, "a"], [b, "a"]].concat(_asKids(_kids(rr, Math.min(a, b))));
    }
    if (kind === "single_parent") {
      const a = rr.int(22, 55);
      return [[a, "a"]].concat(_asKids(_kids(rr, a, 2)));
    }
    if (kind === "sharers") {
      const n = rr.int(2, 3);
      const out = [];
      for (let k = 0; k < n; k++) out.push([rr.int(19, 30), "s"]);
      return out;
    }
    if (kind === "grown_kids") {
      const a = rr.int(44, 62);
      const b = Math.max(40, a + rr.int(-4, 4));
      const hi = Math.min(28, Math.min(a, b) - 18);
      const n = rr.int(1, 2);
      const out = [[a, "a"], [b, "a"]];
      for (let k = 0; k < n; k++) out.push([rr.int(18, hi), "k"]);
      return out;
    }
    // three generations: a family plus a grandparent
    const a = rr.int(28, 50);
    const b = Math.max(24, a + rr.int(-4, 4));
    const out = [[a, "a"], [b, "a"]].concat(_asKids(_kids(rr, Math.min(a, b))));
    out.push([rr.int(65, 88), "g"]);
    return out;
  }

  function _cards() {
    const cards = [];
    for (const [kind, w] of KINDS) for (let k = 0; k < _round(w * DECK_SCALE); k++) cards.push(kind);
    return cards;
  }

  function make_deck(seed) {
    const rr = stream(seed, FM().NS_GEN, "deck");
    const cards = _cards();
    rr.shuffle(cards);
    return [cards, rr];
  }

  // Household j of `kind` (at most `room` people), drawn from rr = (NS_GEN, "hh", j).
  function make_household(sim, folk, j, kind, room, taken, rr) {
    const { FolkHousehold, Person, household_id } = FM();
    const { NEEDS, Profile } = G.agent;
    const rows = ages_for(rr, kind).slice(0, room);
    const hh = new FolkHousehold(household_id(j), "", 0.0, j);
    hh.kind = kind;
    const surname = rr.pick(G.folk_names.SURNAMES);
    const first_sex = rr.random() < 0.5 ? "f" : "m";
    const members = [];
    rows.forEach(([age, role], k) => {
      let sex;
      if (k === 0) {
        sex = first_sex;
      } else if (k === 1 && role === "a") {
        const same = rr.random() >= OPPOSITE_SEX;
        sex = same ? first_sex : (first_sex === "f" ? "m" : "f");
      } else {
        sex = rr.random() < 0.5 ? "f" : "m";
      }
      let own = surname;
      if (role === "s" && k > 0) {
        own = rr.pick(G.folk_names.SURNAMES);
      } else if (k === 1 && role === "a" && rr.random() >= SHARED_SURNAME) {
        own = rr.pick(G.folk_names.SURNAMES);
      } else if (role === "g" && rr.random() < 0.5) {
        own = rr.pick(G.folk_names.SURNAMES);
      }
      const name = unique_name(rr, sex, own, taken);
      const p = new Person(folk.people.length, name, age, sex, j);
      p.role = role;
      folk.people.push(p);
      members.push(p);
      hh.member_ids.push(p.id);
    });
    for (const p of members) {
      const traits = {};
      for (const t of Profile.TRAITS) traits[t] = rr.uniform(0.2, 0.8);
      p.traits = traits;
    }
    for (const p of members) for (const nd of NEEDS) p._needs[nd] = rr.uniform(60, 90);
    for (const p of members) p.health = rr.uniform(75, 100) - 0.3 * Math.max(0, p.age - 60);
    hh.u = rr.random();
    return hh;
  }

  const _idx = pid => Number(pid.slice(1));

  // --- populate ---

  // Fill `folk.people` and `folk.households` with n townsfolk in the region's homes (folk.md 4).
  function populate(folk, sim, n) {
    const isolated = Boolean(folk.isolated);
    sim.folk = folk; // people.person(sim, "f<i>") must find the people being made
    if (folk.sim === null || folk.sim === undefined) folk.sim = sim;
    const seed = sim.seed;
    const geo = new Geo(sim);
    const taken = named_names(sim);
    // 1-2. households, members and names
    let [cards, deck_rr] = make_deck(seed);
    const hh_rr = [];
    let total = 0;
    while (total < n) {
      if (!cards.length) [cards, deck_rr] = _reshuffle(deck_rr);
      const kind = cards.pop();
      const j = folk.households.length;
      const rr = stream(seed, FM().NS_GEN, "hh", j);
      const hh = make_household(sim, folk, j, kind, n - total, taken, rr);
      folk.households.push(hh);
      hh_rr.push(rr);
      total += hh.member_ids.length;
    }
    const people = folk.people;
    const hhs = folk.households;
    // 3. homes first
    move_in(sim, folk);
    // 4. cars
    const station_near = new Map();
    for (const hh of hhs) {
      const home = sim.homes.get(hh.home_id);
      let near = station_near.get(home.place);
      if (near === undefined) {
        near = geo.station_walk(home.place) <= STATION_NEAR;
        station_near.set(home.place, near);
      }
      const p_car = CAR_P[home.tier] * (near ? CAR_NEAR_STATION : 1.0);
      const rr = hh_rr[hh.j];
      for (const pid of hh.member_ids) {
        const p = people[_idx(pid)];
        if (p.age >= 18) p.owns_car = rr.random() < p_car;
      }
    }
    // 5. schools
    assign_schools(sim, folk, geo, isolated);
    // 6. seekers
    const seekers = [];
    for (const hh of hhs) {
      const rr = hh_rr[hh.j];
      for (const pid of hh.member_ids) {
        const p = people[_idx(pid)];
        if (p.age < 18 || p.age > 64) continue;
        const study = p.age <= 21 && rr.random() < STUDY_P;
        const seek = rr.random() >= IDLE_P;
        p.skill = 0.6 * hh.u + 0.4 * rr.random() + (30 <= p.age && p.age <= 55 ? 0.1 : 0.0);
        if (seek && !study) seekers.push(p);
      }
    }
    folk.seekers = seekers.length;
    // 7-8. jobs
    const match_rr = stream(seed, FM().NS_GEN, "match");
    match_jobs(sim, folk, geo, seekers, isolated, match_rr);
    // 9. money
    for (const hh of hhs) {
      const rr = hh_rr[hh.j];
      for (const pid of hh.member_ids) give_money(people[_idx(pid)], rr);
    }
    // 11. ties
    make_ties(sim, folk, match_rr, isolated);
    // 12. the start: asleep at home
    const now = sim.clock.tick;
    const day0 = now - sim.clock.minute_of_day;
    for (const hh of hhs) {
      const rr = hh_rr[hh.j];
      const place = sim.homes.get(hh.home_id).place;
      for (const pid of hh.member_ids) {
        const p = people[_idx(pid)];
        p.inside = place;
        p.activity_place = place;
        p.activity = "sleep";
        p.state = "busy";
        p._nt = now;
        let wake = day0 + rr.int(360, 450);
        const job = p.job;
        if (job !== null && job.hourly_wage > 0 && job.workdays.includes(sim.clock.weekday) && p.commute !== null) {
          const leave = day0 + job.start_hour * 60 + shift_offset(sim, p) - p.commute[1] - 15;
          if (leave < wake) wake = leave;
        }
        p.next_tick = wake > now ? wake : now + 1;
      }
    }
    if (G.housing.list_vacancies) G.housing.list_vacancies(sim);
    if (folk.v !== undefined) folk.v += 1;
  }

  function _reshuffle(rr) {
    const cards = _cards();
    rr.shuffle(cards);
    return [cards, rr];
  }

  const _V2 = () => new Set(G.housing.HOME_SPECS.map(spec => spec[0]));

  // Start-occupiable region homes (let or owned) by base value, highest first (ids break ties).
  function region_homes(sim) {
    const v2 = _V2();
    const out = [];
    for (const home of sim.homes.values()) {
      if (v2.has(home.id) || (home.start !== "let" && home.start !== "owned") || home.household !== null) continue;
      out.push(home);
    }
    return sortedBy(out, h => [-h.base_value, h.id]);
  }

  function need_of(folk, hh) {
    let total = 0.0;
    for (const pid of hh.member_ids) total += folk.people[_idx(pid)].age < 10 ? 0.5 : 1.0;
    return total;
  }

  // Households by means (u desc, j) take the first free home with 2 x bedrooms >= need; every 10th home is held.
  function move_in(sim, folk) {
    const homes = region_homes(sim);
    const free = [], held = [];
    homes.forEach((h, k) => (k % 10 === 9 ? held : free).push(h));
    const order = sortedBy(folk.households, hh => [-hh.u, hh.j]);
    for (const hh of order) {
      const need = need_of(folk, hh);
      let pick = null;
      for (let k = 0; k < free.length; k++) {
        if (2 * free[k].bedrooms >= need) {
          pick = free[k];
          free.splice(k, 1);
          break;
        }
      }
      if (pick === null) {
        for (let k = 0; k < held.length; k++) {
          if (2 * held[k].bedrooms >= need) {
            pick = held[k];
            held.splice(k, 1);
            break;
          }
        }
      }
      if (pick === null) throw new Error(`no region home fits household ${hh.id} (${hh.member_ids.length} people)`);
      hh.home_id = pick.id;
      pick.household = hh.id;
      if (pick.start === "owned") {
        pick.owner = hh.id;
        hh.weekly_rent = 0.0;
      } else {
        hh.weekly_rent = pick.rent;
      }
    }
  }

  // --- 5. schools ---

  const student_job = (age, school) =>
    new G.agent.Job("student", school, 0, 8, age < 9 ? 13 : age < 13 ? 14 : 15, [0, 1, 2, 3, 4]);

  function seats(sim, pid) {
    let cap = sim.town.places.get(pid).capacity || SCHOOL_SEATS;
    for (const a of sim.agents.values()) {
      if (a.alive && a.job !== null && a.job.title === "student" && a.job.place_id === pid) cap -= 1;
    }
    return cap;
  }

  function assign_schools(sim, folk, geo, isolated) {
    const town = sim.town;
    const mb_ids = town.millbrook_ids || new Set();
    const people = folk.people;
    const home_of = new Map();
    for (const hh of folk.households) home_of.set(hh.j, sim.homes.get(hh.home_id).place);
    const kids = people.filter(p => 5 <= p.age && p.age <= 17);
    const left = new Map();
    const schools = [];
    for (const [pid, pl] of town.places) {
      if (pl.kind === "school") {
        left.set(pid, seats(sim, pid));
        if (!mb_ids.has(pid)) schools.push(pid);
      }
    }
    if (!isolated && town.places.has(MILLBROOK_SCHOOL) && mb_ids.has(MILLBROOK_SCHOOL)) {
      const near = sortedBy(kids, p => [geo.car(home_of.get(p.hh), MILLBROOK_SCHOOL), p.i]);
      let k = 0;
      for (const p of near) {
        if (k >= MB_PUPILS || left.get(MILLBROOK_SCHOOL) <= 0) break;
        const place = home_of.get(p.hh);
        p.job = student_job(p.age, MILLBROOK_SCHOOL);
        left.set(MILLBROOK_SCHOOL, left.get(MILLBROOK_SCHOOL) - 1);
        const walk = geo.walk(place, MILLBROOK_SCHOOL);
        p.commute = walk <= SCHOOL_WALK ? [MILLBROOK_SCHOOL, walk, "walk"]
          : [MILLBROOK_SCHOOL, geo.car(place, MILLBROOK_SCHOOL), "car"];
        k += 1;
      }
    }
    const high = left.has(HIGH_SCHOOL) ? HIGH_SCHOOL : null;
    for (const p of kids) {
      if (p.job !== null) continue;
      const place = home_of.get(p.hh);
      let school = null;
      if (p.age >= TEEN_AGE && high !== null && left.get(high) > 0) {
        school = high;
      } else {
        let best = null;
        for (const s of schools) {
          if (left.get(s) <= 0 || (s === high && p.age < TEEN_AGE && schools.length > 1)) continue;
          const key = [geo.walk(place, s), s];
          if (best === null || _lt(key, best)) best = key;
        }
        if (best === null) continue; // no seat anywhere: home-schooled
        school = best[1];
      }
      const walk = geo.walk(place, school);
      let mode = "walk", minutes = walk;
      if (walk > SCHOOL_WALK) {
        mode = "car";
        minutes = geo.car(place, school);
        if (school === high) {
          const tr = geo.train(place, high, false);
          if (tr !== null && tr <= TEEN_TRAIN_CAP && tr <= walk - TRAIN_SAVES) {
            mode = "train";
            minutes = tr;
          }
        }
      }
      p.job = student_job(p.age, school);
      left.set(school, left.get(school) - 1);
      p.commute = [school, minutes, mode];
    }
  }

  // --- 7-8. jobs ---

  function job_rows(sim, isolated) {
    const town = sim.town;
    const mb_ids = town.millbrook_ids || new Set();
    const out = [];
    town.job_slots.forEach((row, r) => {
      const [title, place, wage, start, end, days, count] = row;
      const mb = mb_ids.has(place);
      if (mb && isolated) return;
      out.push([r, title, place, wage, start, end, days.slice(), count, mb]);
    });
    return out;
  }

  function match_jobs(sim, folk, geo, seekers, isolated, rr) {
    const people = folk.people;
    const home_of = new Map();
    for (const hh of folk.households) home_of.set(hh.j, sim.homes.get(hh.home_id).place);
    const rows = job_rows(sim, isolated);
    // wage percentiles over every slot
    const counts = new Map();
    let total = 0;
    for (const row of rows) {
      counts.set(row[3], (counts.get(row[3]) || 0) + row[7]);
      total += row[7];
    }
    const pct = new Map();
    let below = 0;
    for (const w of Array.from(counts.keys()).sort((a, b) => a - b)) {
      pct.set(w, total ? below / total : 0.0);
      below += counts.get(w);
    }
    const holders = new Map();
    const left = new Map();
    for (const row of rows) {
      holders.set(row[0], new Array(row[7]).fill(null));
      left.set(row[0], row[7]);
    }
    const jit = new Map();
    for (const p of seekers) jit.set(p.i, rr.int(0, JITTER));
    const hired = new Set();
    // Millbrook rows: places with the fewest seekers in reach first
    let mb_rows = rows.filter(row => row[8]);
    const reach_lists = new Map();
    for (const row of mb_rows) {
      const place = row[2];
      if (reach_lists.has(place)) continue;
      const cand = [];
      for (const p of seekers) {
        const home = home_of.get(p.hh);
        const w = geo.walk(home, place);
        if (w <= MB_WALK) {
          cand.push([w + jit.get(p.i), p.i, w, "walk"]);
          continue;
        }
        const c = geo.car(home, place);
        if (c <= MB_CAR) cand.push([c + jit.get(p.i), p.i, c, "car"]);
      }
      cand.sort(cmp);
      reach_lists.set(place, cand);
    }
    mb_rows = sortedBy(mb_rows, row => [reach_lists.get(row[2]).length, row[2], row[0]]);
    for (const row of mb_rows) {
      const cand = reach_lists.get(row[2]);
      for (let k = 0; k < row[7]; k++) {
        let got = null;
        for (const c of cand) {
          if (!hired.has(c[1])) {
            got = c;
            break;
          }
        }
        if (got === null) break;
        const p = people[got[1]];
        hired.add(p.i);
        holders.get(row[0])[k] = p.id;
        left.set(row[0], left.get(row[0]) - 1);
        p.job = _job(row);
        p.commute = [row[2], got[2], got[3]];
        if (got[3] === "car") p.owns_car = true;
      }
    }
    // region rows, seekers by skill desc
    const by_place = new Map();
    const places = [];
    for (const row of rows) {
      if (row[8]) continue;
      if (!by_place.has(row[2])) {
        by_place.set(row[2], []);
        places.push(row[2]);
      }
      by_place.get(row[2]).push(row);
    }
    const rest = sortedBy(seekers.filter(p => !hired.has(p.i)), p => [-p.skill, p.i]);
    for (const p of rest) {
      const home = home_of.get(p.hh);
      const res = RES_BASE + RES_SKILL * p.skill;
      const s = p.skill < 1 ? p.skill : 1.0;
      let best = null;
      for (const strict of [true, false]) {
        for (const place of places) {
          let c = null, jj = 0;
          for (const row of by_place.get(place)) {
            if (left.get(row[0]) <= 0 || (strict && row[3] < res)) continue;
            if (c === null) {
              c = geo.commute(home, place, p.owns_car);
              if (c === null) break;
              jj = rr.int(0, JITTER);
            }
            const cost = c[0] + jj + SKILL_W * Math.abs(pct.get(row[3]) - s);
            if (best === null || cost < best[0]) best = [cost, row, c];
          }
        }
        if (best !== null) break;
      }
      if (best === null) {
        for (const place of places) {
          for (const row of by_place.get(place)) {
            if (left.get(row[0]) <= 0) continue;
            const c = geo.car(home, place);
            if (c > CAR_CAP) break;
            const cost = c + rr.int(0, JITTER);
            if (best === null || cost < best[0]) best = [cost, row, [c, "car"]];
            break;
          }
        }
        if (best === null) continue;
        p.owns_car = true;
      }
      const row = best[1];
      const k = row[7] - left.get(row[0]);
      holders.get(row[0])[k] = p.id;
      left.set(row[0], left.get(row[0]) - 1);
      hired.add(p.i);
      p.job = _job(row);
      const m = geo.mode(home, row[2], p.owns_car);
      p.commute = [row[2], m[0], m[1]];
    }
    // every slot onto the board, in row order
    const b = board(sim);
    for (const row of rows) {
      const hs = holders.get(row[0]);
      for (let k = 0; k < row[7]; k++) {
        const holder = hs[k];
        const job = holder === null ? _job(row) : people[_idx(holder)].job;
        const slot = b.add(job, holder);
        job.slot = slot;
      }
    }
  }

  function _job(row) {
    const job = new G.agent.Job(row[1], row[2], row[3], row[4], row[5], row[6].slice());
    job.slot = -1;
    return job;
  }

  // --- 9. money ---

  // Cash and savings on cast.SAVINGS_RANGE's scale (folk.md 4.9): kids $0-40.
  function give_money(p, rr) {
    if (p.age < 18) {
      p.money = rr.int(0, 40);
      p.savings = 0.0;
      return;
    }
    const w = weekly_pay(p.job);
    const retired = p.job === null && p.age >= 65;
    const band = retired ? "retired" : w < LOW_PAY ? "low" : w < HIGH_PAY ? "mid" : "high";
    const [lo, hi] = SAVINGS_WEEKS[band];
    const base = w > 0 ? w : PENSION;
    const sav = rr.random() < NO_SAVINGS_P ? 0.0 : Math.min(SAVINGS_CAP, base * rr.uniform(lo, hi));
    const cash = w > 0 || retired ? base * rr.uniform(0.5, 1.5) : rr.int(50, 300);
    p.money = r2(cash);
    p.savings = r2(sav);
  }

  // --- 11. ties ---

  function _push(map, keys, key, p) {
    if (!map.has(key)) {
      map.set(key, []);
      keys.push(key);
    }
    map.get(key).push(p);
  }

  function make_ties(sim, folk, rr, isolated) {
    const people = folk.people;
    const RK = G.agent.RelationKind;
    // partners and family
    for (const hh of folk.households) {
      const mem = hh.member_ids.map(pid => people[_idx(pid)]);
      const heads = mem.filter(p => p.role === "a");
      if (heads.length >= 2 && hh.kind !== "single_parent") {
        const a = heads[0], b = heads[1];
        set_rel(sim, a.id, b.id, RK.PARTNER, rr.uniform(60, 85), null, { romance: 70.0, married: rr.random() < 0.7 });
      }
      for (let x = 0; x < mem.length; x++) {
        for (let y = x + 1; y < mem.length; y++) {
          const a = mem[x], b = mem[y];
          if (a.role === "a" && b.role === "a" && hh.kind !== "single_parent") continue;
          if (a.role === "s" || b.role === "s") {
            set_rel(sim, a.id, b.id, RK.FRIEND, rr.uniform(30, 60));
            continue;
          }
          set_rel(sim, a.id, b.id, RK.FAMILY, rr.uniform(70, 85));
        }
      }
    }
    // coworkers on the same shift
    const shifts = new Map(); // "place|start|end" -> people
    let keys = [];
    for (const p of people) {
      const j = p.job;
      if (j === null || j.hourly_wage <= 0) continue;
      const key = [j.place_id, j.start_hour, j.end_hour];
      const ks = key.join("|");
      if (!shifts.has(ks)) {
        shifts.set(ks, []);
        keys.push(key);
      }
      shifts.get(ks).push(p);
    }
    keys = keys.sort(cmp);
    const count = new Map();
    for (const key of keys) {
      _ring_ties(sim, shifts.get(key.join("|")), COWORKERS, count, "w", RK.COWORKER, 15, 35, rr, null);
    }
    // classmates within a year
    const by_school = new Map();
    let skeys = [];
    for (const p of people) {
      const j = p.job;
      if (j === null || j.title !== "student") continue;
      _push(by_school, skeys, j.place_id, p);
    }
    skeys = skeys.sort(cmp);
    for (const s of skeys) _ring_ties(sim, by_school.get(s), CLASSMATES, count, "c", RK.FRIEND, 30, 60, rr, 1);
    // neighbours in the same building
    const by_place = new Map();
    let pkeys = [];
    for (const hh of folk.households) {
      const place = sim.homes.get(hh.home_id).place;
      if (!by_place.has(place)) {
        by_place.set(place, []);
        pkeys.push(place);
      }
      for (const pid of hh.member_ids) {
        const p = people[_idx(pid)];
        if (p.age >= 18) by_place.get(place).push(p);
      }
    }
    pkeys = pkeys.sort(cmp);
    for (const place of pkeys) {
      _ring_ties(sim, by_place.get(place), NEIGHBOURS, count, "n", RK.ACQUAINTANCE, 10, 30, rr, null);
    }
    // 1-2 friends in the home district, within 8 years
    const by_district = new Map();
    let dkeys = [];
    for (const hh of folk.households) {
      const d = sim.town.places.get(sim.homes.get(hh.home_id).place).district;
      if (!by_district.has(d)) {
        by_district.set(d, []);
        dkeys.push(d);
      }
      for (const pid of hh.member_ids) {
        const p = people[_idx(pid)];
        if (p.age >= 18) by_district.get(d).push(p);
      }
    }
    dkeys = dkeys.sort(cmp);
    const ck = (i, tag) => `${i}|${tag}`;
    for (const d of dkeys) {
      const pool = by_district.get(d);
      if (pool.length < 2) continue;
      for (const p of pool) {
        const want = rr.int(1, 2);
        let have = count.get(ck(p.i, "d")) || 0;
        let tries = 0;
        while (have < want && tries < 12) {
          tries += 1;
          const q = pool[rr.int(0, pool.length - 1)];
          if (q === p || q.hh === p.hh || Math.abs(q.age - p.age) > FRIEND_AGE_GAP) continue;
          if (p.relationships.has(q.id)) continue;
          if ((count.get(ck(q.i, "d")) || 0) >= 3) continue;
          set_rel(sim, p.id, q.id, RK.FRIEND, rr.uniform(30, 60));
          have += 1;
          count.set(ck(p.i, "d"), have);
          count.set(ck(q.i, "d"), (count.get(ck(q.i, "d")) || 0) + 1);
        }
      }
    }
    if (isolated) return;
    // named and folk: coworkers on overlapping shifts at Millbrook places, classmates at Millbrook's school
    for (const a of sim.agents.values()) {
      const j = a.job;
      if (!a.alive || j === null) continue;
      if (j.title === "student") {
        const mates = [];
        for (const p of by_school.get(j.place_id) || []) if (Math.abs(p.age - a.age) <= 1) mates.push(p);
        _pick_named(sim, a, mates, NAMED_CLASSMATES, RK.FRIEND, 30, 60, rr);
        continue;
      }
      if (j.hourly_wage <= 0) continue;
      let mates = [];
      for (const key of keys) {
        if (key[0] !== j.place_id || !_overlap(key[1], key[2], j.start_hour, j.end_hour)) continue;
        for (const p of shifts.get(key.join("|"))) mates.push(p);
      }
      mates = sortedBy(mates, p => p.i);
      _pick_named(sim, a, mates, NAMED_COWORKERS, RK.COWORKER, 15, 35, rr);
    }
  }

  // Two shifts share an hour (night shifts run past midnight).
  function _overlap(s1, e1, s2, e2) {
    for (let h = 0; h < 24; h++) if (_on(h, s1, e1) && _on(h, s2, e2)) return true;
    return false;
  }

  const _on = (h, s, e) => (s < e ? s <= h && h < e : h >= s || h < e);

  // Up to `cap` ties each inside a group: shuffle, then each member asks the next ones round the ring.
  function _ring_ties(sim, group, cap, count, tag, kind, lo, hi, rr, age_gap) {
    const n = group.length;
    if (n < 2) return;
    const order = group.slice();
    rr.shuffle(order);
    const ck = i => `${i}|${tag}`;
    for (let x = 0; x < n; x++) {
      const p = order[x];
      for (let d = 1; d < n; d++) {
        if ((count.get(ck(p.i)) || 0) >= cap) break;
        const q = order[(x + d) % n];
        if ((count.get(ck(q.i)) || 0) >= cap || p.relationships.has(q.id)) continue;
        if (age_gap !== null && Math.abs(q.age - p.age) > age_gap) continue;
        set_rel(sim, p.id, q.id, kind, rr.uniform(lo, hi));
        count.set(ck(p.i), (count.get(ck(p.i)) || 0) + 1);
        count.set(ck(q.i), (count.get(ck(q.i)) || 0) + 1);
      }
    }
  }

  function _pick_named(sim, a, mates, cap, kind, lo, hi, rr) {
    const pool = mates.slice();
    rr.shuffle(pool);
    let k = 0;
    for (const p of pool) {
      if (k >= cap) break;
      if (a.relationships.has(p.id)) continue;
      set_rel(sim, a.id, p.id, kind, rr.uniform(lo, hi));
      k += 1;
    }
  }

  // --- newcomers ---

  // Newcomer household k in vacant `home_id`, jobless or retired (stream (NS_GEN, "new", k)).
  function newcomer(sim, folk, home_id, k) {
    const rr = stream(sim.seed, FM().NS_GEN, "new", k);
    const kind = rr.pick(["single_young", "single_mid", "single_old", "couple_young", "couple_old", "family"]);
    const taken = named_names(sim);
    for (const p of folk.people) taken.add(p.name);
    const j = folk.households.length;
    const hh = make_household(sim, folk, j, kind, 6, taken, rr);
    folk.households.push(hh);
    const home = sim.homes.get(home_id);
    hh.home_id = home_id;
    home.household = hh.id;
    if (home.owner === "market") {
      home.owner = hh.id;
      hh.weekly_rent = 0.0;
    } else {
      hh.weekly_rent = home.rent;
    }
    const place = home.place;
    for (const pid of hh.member_ids) {
      const p = folk.people[_idx(pid)];
      if (p.age >= 18) p.owns_car = rr.random() < (CAR_P[home.tier] === undefined ? 0.2 : CAR_P[home.tier]);
      if (5 <= p.age && p.age <= 17) p.job = student_job(p.age, _nearest_school(sim, place));
      give_money(p, rr);
      p.inside = place;
      p.activity_place = place;
      p.activity = "relax_home";
      p.state = "busy";
      p._nt = sim.clock.tick;
      p.next_tick = sim.clock.tick + 1;
    }
    return hh;
  }

  function _nearest_school(sim, place) {
    const net = G.roads.net(sim.town);
    const mb_ids = sim.town.millbrook_ids || new Set();
    let best = null;
    for (const [pid, pl] of sim.town.places) {
      if (pl.kind !== "school" || mb_ids.has(pid)) continue;
      const key = [net.minutes(place, pid, "walk"), pid];
      if (best === null || _lt(key, best)) best = key;
    }
    return best ? best[1] : MILLBROOK_SCHOOL;
  }

  // --- a minimal sim for generation alone (the fixture, tests) ---

  // The people and households `populate` fills, without Folk's daily life (F2a).
  class GenFolk {
    constructor(n, isolated = false) {
      this.n = n;
      this.isolated = isolated;
      this.v = 0;
      this.people = [];
      this.households = [];
      this.seekers = 0;
      this.sim = null;
    }

    person(pid) {
      if (typeof pid === "string" && pid.length > 1 && pid[0] === "f" && /^[0-9]+$/.test(pid.slice(1))) {
        const i = Number(pid.slice(1));
        if (i < this.people.length) return this.people[i];
      }
      return null;
    }

    get(pid) { return this.person(pid); }

    household(hid) {
      if (typeof hid === "string" && hid.startsWith("fh") && /^[0-9]+$/.test(hid.slice(2))) {
        const j = Number(hid.slice(2));
        if (j < this.households.length) return this.households[j];
      }
      return null;
    }

    living() { return this.people.filter(p => p.alive && !p.gone); }
  }

  // What populate reads: seed, clock, the region town, homes (v2's and the region's), the cast, a list board.
  class GenSim {
    constructor(seed = 1, isolated = false, with_cast = true) {
      this.seed = seed;
      this.dice_seed = seed;
      this.world = "region";
      this.clock = new G.clock.Clock();
      this.town = G.region.build_region(seed);
      this.homes = G.housing.build_homes(this.town);
      add_region_homes(this);
      this.lots = build_lots(this.town, this.homes);
      if (with_cast) {
        [this.agents, this.households] = G.cast.build_cast(this.town, this.homes, seed);
      } else {
        this.agents = new Map();
        this.households = new Map();
      }
      G.housing.init(this);
      this.job_board = new ListBoard();
      this.folk_isolated = isolated;
      this.folk = new GenFolk(0, isolated);
      this.events = [];
    }

    person(pid) {
      const a = this.agents.get(pid);
      return a !== undefined ? a : this.folk.person(pid);
    }

    household_by_id(hid) {
      const hh = this.households.get(hid);
      return hh !== undefined ? hh : this.folk.household(hid);
    }

    event(text, agent = null, kind = null, opts = {}) {
      const ev = { text, tag: opts.tag || "news", agents: (opts.agents || []).map(a => (a && a.id) || a),
        tick: this.clock.tick };
      this.events.push(ev);
      return ev;
    }
  }

  // housing.build_lots, then the region's lots from `town.lot_conditions` where it left them without a condition.
  function build_lots(town, homes) {
    const lots = G.housing.build_lots(town, homes);
    const conds = town.lot_conditions || {};
    for (const [pid, lot] of lots) {
      if (typeof lot.condition !== "number" || Number.isNaN(lot.condition)) {
        const c = conds[pid] === undefined ? 70 : conds[pid];
        lots.set(pid, new G.housing.Lot(pid, c, { reported: G.housing.stage_of(c), worst: G.housing.stage_of(c) }));
      }
    }
    return lots;
  }

  // Region homes (town.home_specs) into sim.homes when housing.build_homes leaves them out (before R1b's JS).
  function add_region_homes(sim) {
    for (const spec of sim.town.home_specs || []) {
      const [hid, place_id, unit, tier, beds, base, rent, start] = spec;
      if (sim.homes.has(hid)) continue;
      const place = sim.town.places.get(place_id);
      const name = unit ? `${place.name}, flat ${unit}` : place.name;
      const owner = start === "let" || start === "for_rent" ? "landlord" : start === "for_sale" ? "market" : null;
      sim.homes.set(hid, new G.housing.Home(hid, place_id, unit, name, tier, beds, base, rent, start, { owner }));
    }
  }

  function generate(seed = 1, n = 1000, isolated = false) {
    const sim = new GenSim(seed, isolated);
    sim.folk = new GenFolk(n, isolated);
    FM().Person.clock = sim.clock;
    FM().Person.town = sim.town;
    populate(sim.folk, sim, n);
    return sim;
  }

  // The fixture: every person and household as plain JSON (money as r2, ties as [kind, round affinity]).
  function dump(sim) {
    const { NEEDS, Profile } = G.agent;
    const people = [];
    for (const p of sim.folk.people) {
      const rels = {};
      for (const oid of Array.from(p.relationships.keys()).sort(cmp)) {
        const r = p.relationships.get(oid);
        rels[oid] = [r.kind, _round(r.affinity)];
      }
      const j = p.job;
      people.push({
        id: p.id, name: p.name, age: p.age, sex: p.sex, hh: p.household_id,
        traits: Profile.TRAITS.map(t => r2(p.traits[t])), needs: NEEDS.map(nd => r2(p._needs[nd])),
        health: r2(p.health), money: r2(p.money), savings: r2(p.savings), car: p.owns_car,
        job: j === null ? null : [j.title, j.place_id, j.hourly_wage, j.start_hour, j.end_hour, j.workdays.slice(),
          j.slot === undefined ? -1 : j.slot],
        shift: shift_offset(sim, p), commute: p.commute === null ? null : p.commute.slice(), next: p.next_tick,
        rel: rels,
      });
    }
    const hhs = sim.folk.households.map(hh => ({ id: hh.id, kind: hh.kind, home: hh.home_id, rent: hh.weekly_rent,
      members: hh.member_ids.slice() }));
    return { seed: sim.seed, people, households: hhs };
  }

  G.folk_gen = {
    KINDS, DECK_SCALE, CAR_P, WALK_CAP, CAR_CAP, TRAIN_CAP, MB_PUPILS, HIGH_SCHOOL, MILLBROOK_SCHOOL, PENSION,
    SHIFT_OFFSETS, SCHOOL_LATE, stream, shift_offset, shift_hours, weekly_pay, Geo, ListBoard, board, set_rel,
    named_names, unique_name, baby_name, ages_for,
    make_deck, make_household, populate, region_homes, need_of, move_in, student_job, seats, assign_schools,
    job_rows, match_jobs, give_money, make_ties, newcomer, GenFolk, GenSim, build_lots, add_region_homes, generate,
    dump, _overlap,
  };
})(globalThis.GameOfAILife || (globalThis.GameOfAILife = {}));

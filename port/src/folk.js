// Port of gameofailife/folk.py: townsfolk daily life (folk.md 5, PLAN 2.3), 1,000 people who live default lives
// without an LLM.
//
// Days run on an event wheel: `wheel` (a Map tick -> indices) lists the people whose current stay or trip ends then;
// `tick` steps them in list order and each step plans the next stay or trip whole. Positions are pure functions of
// the tick. Free-time choices offer exactly 4 options scored by folk's own scorer; a lead of OBVIOUS_MARGIN is habit,
// otherwise a little noise from the step's dice decides ("default"). Every step draws from
// `dice.stream(sim.dice_seed, NS_FOLK, i, now)`; strolls from `dice.key(sim.dice_seed, NS_STROLL, i, now // 5)`.
// Other packages' modules are read from `G` at call time (PLAN 2.16).
(function (G) {
  "use strict";

  const DAY = 1440;
  const OBVIOUS_MARGIN = 0.45; // forks.OBVIOUS_MARGIN: the lead at which habit decides
  const NOISE = 0.08; // otherwise each option gets uniform(0, NOISE) and the best wins ("default")
  const TRAVEL_COST = 0.004; // forks.TRAVEL_COST
  const NIGHT_TRAVEL = 2, NIGHT_FROM = 20, NIGHT_UNTIL = 7; // forks' night rate
  const STYLE = 0.6; // forks.default_scores' style weight
  const SHIFT_MARGIN = 10; // minutes spare before a shift, on average: each person keeps 10 +- SHIFT_SPREAD of their own
  const SHIFT_SPREAD = 5;
  const LATE_GRACE = 5; // minutes late before reputation suffers
  const EVENING = 19 * 60; // choices after this are "evening" ones
  const DINNER_FROM = 17 * 60 + 30, DINNER_UNTIL = 19 * 60 + 30, DINNER_MINUTES = 45; // the family dinner, once a day
  // Off sick (life.can_work false), a townsperson rests at home (sick_home) until the next of these meals or bedtime,
  // eats at home (eat_home, a grocery) and rests again; breakfast is on waking, as every day.
  const LUNCH = 12 * 60 + 30;
  const SICK_MEALS = [LUNCH, 18 * 60 + 30];
  // A late shift's morning at home (they set off after LUNCH + MEAL_MINUTES) breaks for lunch at LUNCH, a meal at
  // home as off sick: breakfast, the shift's own lunch break and nothing more would starve them by inches.
  const MEAL_MINUTES = 30;
  const STROLL_EVERY = 5; // minutes between a park stroller's hops
  const STROLL_MINUTES = 10; // one way of a stroll round the block when no park is in reach
  const FAV_WALK = 25, FAV_CAR = 15, FAV_KEEP = 3; // favourites: the nearest FAV_KEEP within these minutes
  const UNAVAILABLE = -9.0; // the score of an option whose place is shut or full
  const CPU_KEEP = 1440; // ticks of timings kept for the perf report
  const WARD = "ward";
  const FREE = ["relax_home", "eat_home", "walk_park", "coffee", "eat_out", "shopping", "hang_out", "buy_groceries",
    "idle", "stroll", "movie", "golf", "read", "order_groceries"]; // activities that can be interrupted (is_free)

  // activity -> [need gains over the whole stay, outdoors]. Decay is folk_model's (DECAY_SCALE by activity).
  const ACT = {
    sleep: [{}, false], // energy: SLEEP_ENERGY a minute (v2's 0.17)
    baby: [{}, false],
    eat_home: [{ hunger: 60, social: 4 }, false],
    relax_home: [{ fun: 25, energy: 5 }, false],
    dinner_home: [{ hunger: 50, social: 10, fun: 5 }, false],
    sick_home: [{ energy: 20 }, false],
    work: [{ hunger: 30 }, false], // a lunch break
    school: [{ hunger: 30, social: 25, fun: 10 }, false],
    coffee: [{ energy: 15, social: 5 }, false],
    eat_out: [{ hunger: 55, social: 10, fun: 6 }, false],
    buy_groceries: [{}, false],
    order_groceries: [{}, false],
    shopping: [{ fun: 20 }, false],
    hang_out: [{ social: 40, fun: 25 }, false],
    walk_park: [{ fun: 30, social: 4 }, true],
    stroll: [{ fun: 15 }, true],
    movie: [{ fun: 45, social: 10 }, false],
    golf: [{ fun: 40, social: 15 }, false],
    read: [{ fun: 25 }, false],
    ward: [{ hunger: 40 }, false],
    idle: [{}, false],
  };
  const SLEEP_ENERGY = 0.17;
  const HOME_ACTS = ["sleep", "baby", "eat_home", "relax_home", "dinner_home", "sick_home", "order_groceries"];
  const KEEP_OPEN = HOME_ACTS.concat(["work", "school", WARD, "idle"]); // stays that do not end at closing time
  const LEISURE = { // favourite key -> [place kind, styles or null for any]
    coffee: ["cafe", ["cafe", "bakery"]],
    eat_out: ["cafe", null],
    shopping: ["shop", ["shop", "arcade", "mall"]],
    groceries: ["market", null],
    park: ["park", null],
  };
  const GROCERY_COST = 35, COFFEE_COST = 4, MEAL_COST = 14, DINNER_COST = 20, HANG_COST = 8;
  const GROCERY_MEALS = 10;
  // With no grocer in reach (no market or grocer's within FAV_WALK on foot, or FAV_CAR by car), groceries are
  // ordered in from home: the same shop for DELIVERY_FEE more, DELIVERY_MINUTES at home to order and take them in.
  const DELIVERY_FEE = 8, DELIVERY_MINUTES = 15;
  // A day out (folk.md 5 day_off d), by "kind/style": [activity, label, cost or null for the shopping spend, min age]
  const DAY_OUT = {
    "shop/mall": ["shopping", "A day at the mall", null, 0],
    "venue/cinema": ["movie", "See a film", 12, 0],
    "venue/clubhouse": ["golf", "A round of golf", 40, 40],
    "townhall/library": ["read", "Read at the library", 0, 0],
  };
  const DAY_OUT_WALK = 40, DAY_OUT_CAR = 25, DAY_OUT_MINUTES = 150; // reach from home, and the stay
  // Outcomes of an outing (folk.md 5), keyed dice into the luck log: [what, valence, chance, money, fun]
  const BARGAIN = ["bargain", 1, 0.05, 15, 0]; // shopping or groceries
  const PICKPOCKET = ["pickpocket", -1, 0.003, -60, 0]; // any outing
  const RAINED_OUT = ["rained_out", -1, 0.5, 0, -10]; // a park walk or stroll in the rain

  const actOf = a => ACT[a] || [{}, false];
  const fm = () => G.folk_model;
  const ft = () => G.folk_transit;

  function urgency(level) {
    const u = (100 - level) / 100;
    return u * u;
  }

  function divmod(a, b) {
    const q = Math.floor(a / b);
    return [q, a - q * b];
  }

  // One of a choice's 4 options: what it does, where, for how long, and what folk's scorer reads.
  class Option {
    constructor(label, activity, place, minutes, cost = 0, tags = null, gains = null, base = 0.0) {
      this.label = label;
      this.activity = activity;
      this.place = place;
      this.minutes = minutes;
      this.cost = cost;
      this.tags = tags || {};
      this.gains = gains || {};
      this.base = base;
      this.until = null;
      this.companion = null;
    }
  }

  // The townsfolk of one Simulation (PLAN 2.3). n 0: empty, every call a no-op.
  class Folk {
    constructor(sim, n, isolated = false, populate = null) {
      this.sim = sim;
      this.n = Math.trunc(n);
      this.isolated = !!isolated;
      this.v = 0;
      this.people = [];
      this.households = [];
      this.wheel = new Map();
      this.out = new Map(); // people on a trip, in insertion order
      this.strollers = new Map(); // people strolling in a park -> the park
      this.luck_log = []; // the last 5000 luck changes (folk_life appends and trims)
      this.counters = { steps: 0, choices: 0, habit: 0, shifts: 0, school_days: 0, trips: 0, boardings: 0,
        train_trips: 0, late: 0, sick_days: 0, starved: 0,
        school_runs: 0 };
      this.today = { boardings: 0, train_trips: 0, lines: {} }; // since midnight
      this._lines = null; // train id -> line id
      this.cpu = []; // ms per tick, the last CPU_KEEP
      this.cpu_total = 0.0;
      this.ticks = 0;
      const town = sim.town;
      this.town = town;
      this.place_ids = Array.from(town.places.keys());
      this.pidx = new Map(this.place_ids.map((pid, k) => [pid, k]));
      this.count = new Array(this.place_ids.length).fill(0); // folk inside each place (park strollers are outdoors)
      this.occupants = new Map();
      this.where = new Map(); // i -> place the person is at (inside or strolling)
      this.stay = new Map(); // i -> [start tick, end tick] of the current stay
      this.ends = new Map(); // i -> real end of a stay longer than a day (re-checked daily)
      this.rings = new Map(); // i -> hourly worth, the last 24
      this._fav_cache = new Map();
      this._park_tiles = new Map();
      this._bed = new Map();
      this._wake = new Map();
      this._spare = new Map(); // i -> minutes spare before a shift
      this._shifts = new Map(); // i -> [job, minutes its day starts and ends late: folk_gen.shift_offset]
      this._driven = new Map(); // pupil i -> [driver i, departure tick] of a school run
      this.sent = new Set(); // people on a send_to errand (an invite, a date): not free until its stay ends
      this._locator = (p, tick) => this._locate(p, tick);
      this._bind();
      if (this.n <= 0) {
        this.n = 0;
        return;
      }
      if (populate === null) populate = G.folk_gen.populate;
      populate(this, sim, this.n);
      this._start(sim);
    }

    // --- lookups ---

    person(pid) {
      if (typeof pid !== "string" || !G.people.is_folk_id(pid)) return null;
      const i = Number(pid.slice(1));
      return i >= 0 && i < this.people.length ? this.people[i] : null;
    }

    get(pid) { return this.person(pid); }

    _line_of(train_id) {
      let m = this._lines;
      if (m === null) {
        m = this._lines = new Map();
        for (const ln of ((this.town.rail || {}).lines || [])) for (const t of ln.trains) m.set(t, ln.id);
      }
      return m.has(train_id) ? m.get(train_id) : train_id;
    }

    // The townsfolk's part of `stats.region` (stats.region_block): how many, how commuters (workers and pupils)
    // go, and today's train boardings in all and by line.
    region_parts(sim) {
      const commute = {};
      let folk = 0;
      for (const p of this.people) {
        if (!p.alive || p.gone) continue;
        folk += 1;
        if (p.job !== null && p.commute !== null && p.commute !== undefined) {
          const mode = p.commute[2];
          commute[mode] = (commute[mode] || 0) + 1;
        }
      }
      return { folk, commute, train_riders_today: this.today.boardings,
        train_lines_today: Object.assign({}, this.today.lines), bus_riders_today: 0 };
    }

    living() { return this.people.filter(p => p.alive && !p.gone); }

    household(hid) {
      if (typeof hid !== "string" || !hid.startsWith("fh") || !/^\d+$/.test(hid.slice(2))) return null;
      const j = Number(hid.slice(2));
      return j >= 0 && j < this.households.length ? this.households[j] : null;
    }

    hh_of(p) { return p.hh >= 0 && p.hh < this.households.length ? this.households[p.hh] : null; }

    home_place(p) {
      const hh = this.hh_of(p);
      if (hh === null || hh.home_id === null || hh.home_id === undefined) return null;
      const homes = this.sim.homes;
      const home = homes ? homes.get(hh.home_id) : undefined;
      if (home !== undefined) return home.place;
      return this.town.places.has(hh.home_id) ? hh.home_id : null;
    }

    // Isolated folk never target a Millbrook place (PLAN 2.15).
    allowed(place_id) {
      const ids = this.town.millbrook_ids;
      return !(this.isolated && ids && ids.has(place_id));
    }

    // --- the wheel ---

    schedule(p, t) {
      const now = this.sim.clock.tick;
      t = Math.max(Math.trunc(t), now + 1);
      p.next_tick = t;
      const b = this.wheel.get(t);
      if (b === undefined) this.wheel.set(t, [p.i]);
      else b.push(p.i);
    }

    // After generation: occupancy from where everyone is, and the wheel from their next_tick.
    _start(sim) {
      const now = sim.clock.tick;
      this.wheel = new Map();
      for (const p of this.people) {
        if (!p.alive || p.gone) continue;
        if (p.trip !== null) {
          this.out.set(p.i, null);
        } else {
          const place = p.inside || this.home_place(p);
          if (place !== null) this._enter(p, place);
        }
        if (p._nt === 0) p._nt = now;
        if (p.age < 5) {
          p.activity = "baby";
        } else if (p.trip === null && p.activity === "sleep") {
          // wake at folk's own minute when that is earlier, so the first morning has time for breakfast
          const day = Math.floor(now / DAY);
          const w = day * DAY + this._wake_minute(p, day);
          if (now < w && w < p.next_tick) p.next_tick = w;
        }
        this.stay.set(p.i, [now, Math.max(p.next_tick, now + 1)]);
        this.schedule(p, p.next_tick > now ? p.next_tick : this._wake_tick(p, now));
      }
    }

    // Point folk_model's Person at this Simulation's clock, town and locator. They are class attributes, so
    // each entry point re-binds them: with two Simulations in one process the last one built must not win.
    _bind() {
      const { Person } = fm();
      Person.clock = this.sim.clock;
      Person.town = this.town;
      Person.locate = this._locator;
    }

    tick(sim) {
      const t0 = (typeof performance !== "undefined" ? performance : Date).now();
      this._bind();
      this.n = this.people.length; // anyone added to people (a birth, a newcomer) counts in folk_n
      const now = sim.clock.tick;
      if (now % DAY === 0) this.today = { boardings: 0, train_trips: 0, lines: {} };
      const b = this.wheel.get(now);
      if (b !== undefined) {
        this.wheel.delete(now);
        const people = this.people;
        for (const i of b) {
          const p = people[i];
          if (p.next_tick === now && p.alive && !p.gone) {
            this.counters.steps += 1;
            this.step(sim, p, now);
          }
        }
      }
      const dt = (typeof performance !== "undefined" ? performance : Date).now() - t0;
      this.cpu.push(dt);
      if (this.cpu.length > CPU_KEEP) this.cpu.shift();
      this.cpu_total += dt;
      this.ticks += 1;
    }

    nightly(sim) {
      const fl = G.folk_life;
      if (fl && fl.nightly) fl.nightly(sim);
    }

    pensions(sim) {
      const fl = G.folk_life;
      if (fl && fl.pensions) fl.pensions(sim);
    }

    weekly(sim) {
      const fl = G.folk_life;
      if (fl && fl.weekly) fl.weekly(sim);
    }

    // folk_life.new_household: (member_ids, home_id, how), or (sim, members, home_id, how) as
    // housing.new_household passes them (members may be people or ids).
    new_household(...args) {
      const [member_ids, home_id, how] = args.length === 4 ? args.slice(1) : args;
      return G.folk_life.new_household(this, member_ids, home_id, how);
    }

    on_household_empty(hh) { G.folk_life.on_household_empty(this, hh); }

    // --- places ---

    _enter(p, place_id) {
      this._leave(p);
      p.inside = place_id;
      p.activity_place = place_id;
      this.where.set(p.i, place_id);
      let occ = this.occupants.get(place_id);
      if (occ === undefined) {
        occ = new Map();
        this.occupants.set(place_id, occ);
      }
      occ.set(p.i, null);
      if (p.activity === "walk_park") {
        this.strollers.set(p.i, place_id);
      } else {
        const k = this.pidx.get(place_id);
        if (k !== undefined) this.count[k] += 1;
      }
    }

    _leave(p) {
      const place = this.where.get(p.i);
      if (place === undefined) return;
      this.where.delete(p.i);
      const occ = this.occupants.get(place);
      if (occ !== undefined) occ.delete(p.i);
      if (!this.strollers.has(p.i)) {
        const k = this.pidx.get(place);
        if (k !== undefined) this.count[k] -= 1;
      } else {
        this.strollers.delete(p.i);
      }
      p.inside = null;
    }

    // --- needs ---

    // Needs and health to `now` (folk_model's Person.settle: decay, healing while well, hunger at 0 costing health);
    // under-5s are held at 75.
    settle(p, now) {
      p.settle(now);
      if (p.age < 5) for (const n of G.agent.NEEDS) p._needs[n] = 75.0;
    }

    // The stay that ends now (or is cut short) gives its gains, pro rata.
    _gain(p, now) {
      const [start, end] = this.stay.get(p.i) || [now, now];
      const span = end - start;
      if (span <= 0 || p.state !== "busy") return;
      const frac = Math.min(1.0, (now - start) / span);
      const gains = actOf(p.activity)[0];
      const needs = p._needs;
      for (const [n, g] of Object.entries(gains)) {
        const v = needs[n] + g * frac;
        needs[n] = v < 0.0 ? 0.0 : v > 100.0 ? 100.0 : v;
      }
      if (p.activity === "sleep") {
        const v = needs.energy + SLEEP_ENERGY * (now - start);
        needs.energy = v > 100.0 ? 100.0 : v;
      }
    }

    // --- the day ---

    _wake_minute(p, day) {
      let base = this._wake.get(p.i);
      if (base === undefined) {
        base = 360 + G.dice.key(this.sim.dice_seed, fm().NS_FOLK, p.i, "wake") % 91;
        this._wake.set(p.i, base);
      }
      const job = p.job;
      if (job !== null && job.workdays.includes(day % 7)) {
        return Math.min(base, this._set_off(p) - 40);
      }
      if (job !== null || p.age >= 18) return base + 90; // a day off (the jobless and retired every day)
      return day % 7 >= 5 ? base + 90 : base;
    }

    // The minute of the day p sets off for today's shift or school: start - commute - their own margin.
    _set_off(p) {
      let spare = this._spare.get(p.i);
      if (spare === undefined) {
        const k = G.dice.key(this.sim.dice_seed, fm().NS_FOLK, p.i, "spare");
        spare = SHIFT_MARGIN - SHIFT_SPREAD + k % (2 * SHIFT_SPREAD + 1);
        this._spare.set(p.i, spare);
      }
      const [minutes, mode] = this._commute_of(p);
      if (mode === "train") spare = SHIFT_MARGIN; // train commuters time it to the train, so they ride together
      return this._start_minute(p) - minutes - spare;
    }

    // Minutes p's shift or school day starts and ends after its job's hours (folk_gen.shift_offset: their own on a
    // region job row, 08:30 at a region school but Riverton High), kept while the job is the same.
    _shift(p) {
      const job = p.job;
      const got = this._shifts.get(p.i);
      if (got !== undefined && got[0] === job) return got[1];
      const off = G.folk_gen.shift_offset(this.sim, p);
      this._shifts.set(p.i, [job, off]);
      return off;
    }

    // The minute of the day p's shift or school day starts.
    _start_minute(p) { return p.job.start_hour * 60 + this._shift(p); }

    // The minute of the day p's shift or school day ends.
    _end_minute(p) { return p.job.end_hour * 60 + this._shift(p); }

    _bed_minute(p) {
      let bed = this._bed.get(p.i);
      if (bed === undefined) {
        const k = G.dice.key(this.sim.dice_seed, fm().NS_FOLK, p.i, "bed");
        if (p.age < 13) bed = 19 * 60 + 30 + k % 61;
        else if (p.age < 18) bed = 21 * 60 + k % 91;
        else bed = 21 * 60 + 30 + k % 121;
        this._bed.set(p.i, bed);
      }
      return bed;
    }

    _wake_tick(p, now) {
      const [day, m] = divmod(now, DAY);
      const w = this._wake_minute(p, day);
      if (m < w) return day * DAY + w;
      return (day + 1) * DAY + this._wake_minute(p, day + 1);
    }

    // [minutes, mode] to the job's place: the generator's p.commute when it is for this place.
    _commute_of(p) {
      const job = p.job;
      if (job === null) return [0, null];
      const c = p.commute;
      if (c !== null && c !== undefined && c[0] === job.place_id) return [c[1], c[2]];
      const home = this.home_place(p);
      let best = home ? ft().best_minutes(this.town, home, job.place_id, this._has_car(p)) : null;
      if (best === null) best = [home ? ft().minutes(this.town, home, job.place_id, "walk") : 0, "walk"];
      p.commute = [job.place_id, best[0], best[1]];
      return [best[0], best[1]];
    }

    _has_car(p) { return !!p.owns_car && p.age >= 18; }

    step(sim, p, now) {
      this.settle(p, now);
      if (p.health <= 0) {
        // Starved when hunger at 0 took the last of their health; otherwise (the damp, a chill) they collapse, as a
        // named does at health 0.
        const how = p._needs.hunger <= 0 ? "starved" : "collapsed and could not be saved";
        if (how === "starved") this.counters.starved += 1;
        G.life.die(sim, p, how);
        if (p.alive) kill(sim, p, how); // a life stub that does not kill: keep them off the wheel anyway
        return;
      }
      const end = this.ends.get(p.i);
      this.ends.delete(p.i);
      if (end !== undefined && now < end) {
        this.ends.set(p.i, end);
        this.schedule(p, Math.min(end, now + DAY));
        return;
      }
      if (p.trip !== null) {
        this._arrive(sim, p, now);
        return;
      }
      this.sent.delete(p.i); // the errand's stay is over (or it was cut short): free time is theirs again
      this._gain(p, now);
      const [day, m] = divmod(now, DAY);
      const home = this.home_place(p);
      if (p.age < 5) {
        if (home !== null && p.inside !== home) this._enter(p, home);
        p.activity = "baby";
        p.state = "busy";
        this._begin(p, now, "baby", this._wake_tick(p, now) - now);
        return;
      }
      const act = p.activity;
      if ((act === "work" || act === "school") && p.state === "busy") {
        if (act === "work") {
          this.counters.shifts += 1;
          const fl = G.folk_life;
          if (fl && fl.pay_shift) fl.pay_shift(sim, p);
          G.career.on_shift_end(sim, p);
        } else {
          this.counters.school_days += 1;
          G.career.on_shift_end(sim, p); // a pupil's school day counts as a shift (career: v2's +0.5)
        }
        this.choose(sim, p, now, m >= EVENING ? "evening" : "after_work");
        return;
      }
      if (act === "sleep" && p.state === "busy") {
        const hh = this.hh_of(p);
        if (hh !== null && hh.groceries > 0) hh.groceries -= 1;
        this._begin(p, now, "eat_home", 30);
        return;
      }
      const job = p.job;
      const bed = this._bed_minute(p);
      const night = m >= bed || m < this._wake_minute(p, day);
      if (act === "sick_home" && p.state === "busy" && !night) {
        this._home_meal(p, now); // a rest off sick ends at a meal at home
        return;
      }
      if (job !== null && job.workdays.includes(day % 7) && p.worked_day !== day && m < this._end_minute(p) - 60) {
        const [commute, mode] = this._commute_of(p);
        const leave = this._set_off(p);
        const early = m < leave;
        if (early && (p.inside === home || home === null) && !night) {
          if (act === "relax_home" && LUNCH <= m && m < LUNCH + 60 && m + MEAL_MINUTES <= leave) {
            this._home_meal(p, now); // lunch before a late shift
          } else {
            this._begin(p, now, "relax_home", Folk._lunch_break(m, leave) - m);
          }
          return;
        }
        if (early && home !== null && leave - m > 60 && !night) {
          this._go_home(sim, p, now, "relax_home", day * DAY + Folk._lunch_break(m, leave));
          return;
        }
        if (!early || !night) {
          p.worked_day = day;
          if (!G.life.can_work(sim, p)) {
            this.counters.sick_days += 1;
            this._sick_rest(sim, p, now);
            return;
          }
          const work = job.title === "student" || p.age < 18 ? "school" : "work";
          if (work === "school" && mode === "car") this._school_run(p, now, job.place_id);
          this._go(sim, p, now, job.place_id, work, day * DAY + this._end_minute(p), 30, mode);
          return;
        }
      }
      if (night) {
        this._go_home(sim, p, now, "sleep", this._wake_tick(p, now));
        return;
      }
      if (!G.life.can_work(sim, p)) { // off sick (or home from hospital) on a day off too: rest, not out
        this._sick_rest(sim, p, now);
        return;
      }
      if (DINNER_FROM <= m && m < DINNER_UNTIL && home !== null && p.inside === home && this._dinner(p, now, day)) return;
      this.choose(sim, p, now, m >= EVENING ? "evening" : "day_off");
    }

    // Off sick: rest at home until the next of SICK_MEALS or bedtime (overnight, until they wake).
    _sick_rest(sim, p, now) {
      const [day, m] = divmod(now, DAY);
      let until = this._bed_minute(p);
      for (const meal of SICK_MEALS) {
        if (m < meal && meal < until) {
          until = meal;
          break;
        }
      }
      this._go_home(sim, p, now, "sick_home", until > m ? day * DAY + until : this._wake_tick(p, now));
    }

    // The minute a morning at home before the shift ends: LUNCH when lunch fits before they set off, else when they
    // set off.
    static _lunch_break(m, leave) {
      return m < LUNCH && LUNCH + MEAL_MINUTES <= leave ? LUNCH : leave;
    }

    // A meal at home (off sick, or lunch before a late shift), as breakfast is (eat_home, a grocery if there is one);
    // with the fridge empty the household orders groceries in first (GROCERY_COST + DELIVERY_FEE) when its payer can
    // afford them.
    _home_meal(p, now) {
      const hh = this.hh_of(p);
      if (hh !== null) {
        if (hh.groceries <= 0) {
          const payer = this._payer(p) || p;
          const cost = GROCERY_COST + DELIVERY_FEE;
          if (payer.money + payer.savings >= cost) {
            payer.money -= cost;
            hh.groceries += GROCERY_MEALS;
          }
        }
        if (hh.groceries > 0) hh.groceries -= 1;
      }
      this._begin(p, now, "eat_home", MEAL_MINUTES);
    }

    // The family dinner (folk.md 5 case 7): once a day, 45 minutes with the members relaxing at home, one grocery
    // each. Needs someone to eat with and food in the house.
    _dinner(p, now, day) {
      const hh = this.hh_of(p);
      if (hh === null || hh.dinner_day === day || hh.groceries <= 0) return false;
      const diners = [];
      for (const mid of hh.member_ids) {
        const q = this.person(mid);
        if (q !== null && q !== p && q.alive && !q.gone && q.trip === null && q.inside === p.inside &&
            q.activity === "relax_home") diners.push(q);
      }
      if (!diners.length) return false;
      hh.dinner_day = day;
      hh.groceries = Math.max(0, hh.groceries - diners.length - 1);
      for (const q of diners) {
        this._gain(q, now);
        this.settle(q, now);
        this.ends.delete(q.i);
        this._begin(q, now, "dinner_home", DINNER_MINUTES);
      }
      this._begin(p, now, "dinner_home", DINNER_MINUTES);
      return true;
    }

    // A stay where the person is. A leisure stay ends when the place shuts; at a shut place it is home.
    _begin(p, now, activity, minutes) {
      let until = now + Math.max(1, Math.trunc(minutes));
      if (!KEEP_OPEN.includes(activity) && p.inside !== null) {
        const place = this.town.places.get(p.inside);
        if (place !== undefined && place.hours) {
          if (!place.is_open((now % DAY) / 60)) {
            this._go_home(this.sim, p, now, "relax_home", now + 60);
            return;
          }
          const close = Math.floor(now / DAY) * DAY + place.hours[1] * 60;
          if (close < until) until = Math.max(now + 1, close);
        }
      }
      p.activity = activity;
      p.state = "busy";
      if (p.inside !== null) p.activity_place = p.inside;
      this.stay.set(p.i, [now, until]);
      if (until - now > DAY) {
        this.ends.set(p.i, until);
        until = now + DAY;
      }
      this.schedule(p, until);
    }

    _go_home(sim, p, now, activity, until) {
      const home = this.home_place(p);
      if (home === null || p.inside === home) this._begin(p, now, activity, until - now);
      else this._go(sim, p, now, home, activity, until);
    }

    // Plan the whole trip now: legs fixed at departure, arrival on the wheel.
    _go(sim, p, now, dest, then, until = null, stay = 30, prefer = null) {
      const src = this.where.get(p.i) || this.home_place(p);
      if (src === null || src === undefined || src === dest) {
        if (src !== dest) this._enter(p, dest);
        this._begin(p, now, then, until !== null ? until - now : stay);
        return;
      }
      const car = this._has_car(p) || (p.age < 18 && prefer === "car"); // a child driven to school rides along
      const [mode, legs] = ft().choose(this.town, src, dest, now, car, prefer);
      const arrive = ft().end_of(legs, now);
      if (until === null) until = arrive + stay;
      until = Math.max(until, arrive + 1);
      this._leave(p);
      p.trip = new (fm().Trip)(legs, dest, then, until, mode);
      p.state = "travelling";
      p.activity = then;
      p.activity_place = dest;
      this.out.set(p.i, null);
      this.counters.trips += 1;
      const rides = ft().boardings(legs);
      if (rides) {
        this.counters.boardings += rides;
        this.counters.train_trips += 1;
        this.today.boardings += rides;
        this.today.train_trips += 1;
        const per = this.today.lines;
        for (const leg of legs) {
          if (leg[0] === fm().RIDE) {
            const line = this._line_of(leg[3]);
            per[line] = (per[line] || 0) + 1;
          }
        }
        const fare = ft().fare(p.age);
        if (fare) p.money -= fare;
      }
      this.stay.set(p.i, [now, arrive]);
      this.schedule(p, arrive);
    }

    // A parent with a car drives a pupil to school and straight back home (folk.md 4's school runs), so the car
    // is on the street both ways and the pupil rides as its passenger. Only a member relaxing or eating at home,
    // and only when they are back before they set off for their own shift.
    _school_run(child, now, school) {
      const hh = this.hh_of(child);
      const home = this.home_place(child);
      if (hh === null || home === null || child.inside !== home || child.trip !== null) return;
      const day = Math.floor(now / DAY);
      const { DRIVE, Trip } = fm();
      for (const mid of hh.member_ids) {
        const d = this.person(mid);
        if (d === null || d.age < 18 || !d.alive || d.gone || !d.owns_car || d.trip !== null) continue;
        if (d.inside !== home || (d.activity !== "relax_home" && d.activity !== "eat_home")) continue;
        const out = ft().road_leg(this.town, DRIVE, home, school, now);
        const back = ft().road_leg(this.town, DRIVE, school, home, out[2]);
        const job = d.job;
        if (job !== null && job.workdays.includes(day % 7) && d.worked_day !== day &&
            back[2] - day * DAY > this._set_off(d)) continue;
        this._gain(d, now);
        this.settle(d, now);
        this.ends.delete(d.i);
        this._leave(d);
        d.trip = new Trip([out, back], home, "relax_home", back[2] + 1, "car");
        d.state = "travelling";
        d.activity = "school_run";
        d.activity_place = school;
        this.out.set(d.i, null);
        this.counters.trips += 1;
        this.counters.school_runs += 1;
        this.stay.set(d.i, [now, back[2]]);
        this.schedule(d, back[2]);
        this._driven.set(child.i, [d.i, now]);
        return;
      }
    }

    _arrive(sim, p, now) {
      const t = p.trip;
      p.trip = null;
      this._driven.delete(p.i);
      this.out.delete(p.i);
      p.activity = t.then;
      p.state = "busy";
      this._enter(p, t.dest);
      const job = p.job;
      if ((t.then === "work" || t.then === "school") && job !== null) {
        const late = now - (Math.floor(now / DAY) * DAY + this._start_minute(p));
        if (late > LATE_GRACE) {
          this.counters.late += 1;
          p.reputation = Math.max(0.0, p.reputation - 1);
          p.remember(this.sim.clock.stamp(), `Got in ${late} minutes late to ${this._name(t.dest)}.`);
        }
      }
      this._begin(p, now, t.then, t.until - now); // shut on arrival: home again
    }

    _name(place_id) {
      const place = this.town.places.get(place_id);
      return place ? place.name : String(place_id);
    }

    // --- choices ---

    // The person's favourites of a LEISURE key: generation's p.fav when it has them, else the nearest FAV_KEEP
    // from home within FAV_WALK on foot (FAV_CAR by car with a car), allowed places only.
    _favs(p, key) {
      let got = p.fav && !(p.fav instanceof Map) ? p.fav[key] : null;
      if (got && got.length) return got.filter(pid => this.allowed(pid));
      const home = this.home_place(p);
      if (home === null) return [];
      const car = this._has_car(p);
      const ck = `${home}|${key}|${car}`;
      got = this._fav_cache.get(ck);
      if (got !== undefined) return got;
      const [kind, styles] = LEISURE[key];
      const net = ft().net(this.town);
      const cands = [];
      for (const [pid, place] of this.town.places) {
        if (place.kind !== kind || (styles !== null && !styles.includes(place.style)) || !this.allowed(pid)) continue;
        const w = net.minutes(home, pid, "walk");
        if (w <= FAV_WALK || (car && net.minutes(home, pid, "car") <= FAV_CAR)) cands.push([w, pid]);
      }
      cands.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
      got = cands.slice(0, FAV_KEEP).map(c => c[1]);
      this._fav_cache.set(ck, got);
      return got;
    }

    _usable(place_id, now, minutes) {
      const place = this.town.places.get(place_id);
      if (place === undefined) return false;
      if (place.hours) {
        const m = now % DAY + 15; // about when they get there
        if (!(place.hours[0] * 60 <= m && m + Math.min(minutes, 30) <= place.hours[1] * 60)) return false;
      }
      const cap = place.capacity || 0;
      const k = this.pidx.get(place_id);
      if (cap && k !== undefined && this.count[k] >= cap) return false;
      return true;
    }

    // A market, or a grocer's (a shop of style "shop"), among the person's favourites: within FAV_WALK on foot, or
    // FAV_CAR by car with a car (opening hours aside).
    _grocer_in_reach(p) {
      if (this._favs(p, "groceries").length) return true;
      for (const pid of this._favs(p, "shopping")) if (this.town.places.get(pid).style === "shop") return true;
      return false;
    }

    // Buy groceries at the first open grocer in reach; with none in reach, order them in from home (the isolated and
    // the old in the far suburbs would starve otherwise).
    _grocery_option(p, now, home, base) {
      if (this._grocer_in_reach(p)) {
        return new Option("Buy groceries", "buy_groceries", this._pick(p, "groceries", now, 25), 25, GROCERY_COST,
          { thrift: 0.2, family: 0.3 }, {}, base);
      }
      return new Option("Order groceries in", "order_groceries", home, DELIVERY_MINUTES, GROCERY_COST + DELIVERY_FEE,
        { thrift: 0.2, family: 0.3 }, {}, base);
    }

    _pick(p, key, now, minutes) {
      for (const pid of this._favs(p, key)) if (this._usable(pid, now, minutes)) return pid;
      if (key === "groceries") {
        for (const pid of this._favs(p, "shopping")) {
          if (this.town.places.get(pid).style === "shop" && this._usable(pid, now, minutes)) return pid;
        }
      }
      return null;
    }

    // The 4 options of a choice (folk.md 5's table).
    options(sim, p, now, kind) {
      const home = this.home_place(p);
      const m = now % DAY;
      const bed = this._bed_minute(p);
      const hh = this.hh_of(p);
      const low = hh !== null && hh.groceries < 4;
      const hungry = p._needs.hunger < 55;
      const thrift = "thrift" in p.traits ? p.traits.thrift : 0.5;
      const dinner = 17 * 60 <= m && m < 21 * 60 && hh !== null && hh.groceries > 0;
      const home_act = dinner && p._needs.hunger < 70 ? "dinner_home" : "relax_home";
      const relax_gains = ACT[home_act][0];
      let opts;
      if (kind === "after_work") {
        const cafe_key = hungry ? "eat_out" : "coffee";
        opts = [
          new Option("Go home and relax", home_act, home, 90, 0, { family: 0.3 }, relax_gains, 0.2),
          this._grocery_option(p, now, home, low ? 1.0 : -0.8),
          new Option(hungry ? "Eat out" : "Coffee", hungry ? "eat_out" : "coffee",
            this._pick(p, cafe_key, now, 40), hungry ? 40 : 20, hungry ? MEAL_COST : COFFEE_COST,
            { social: 0.4, thrift: -0.3 }, ACT[hungry ? "eat_out" : "coffee"][0], 0.0),
          this._park_option(p, now, 60),
        ];
      } else if (kind === "day_off") {
        const spend = Math.trunc(15 + 45 * (1 - thrift));
        // Low on groceries, the shopping trip is for groceries: see folk.py.
        const shop = low
          ? this._grocery_option(p, now, home, 1.0)
          : new Option("Go shopping", "shopping", this._pick(p, "shopping", now, 60), 60, spend,
            { thrift: -0.5, adventure: 0.2 }, ACT.shopping[0], 0.05);
        opts = [
          new Option("Stay home", home_act, home, 120, 0, { family: 0.3 }, relax_gains, 0.15),
          shop,
          this._hang_option(sim, p, now, 120),
          ((p.i + Math.floor(now / DAY)) % 2 === 0 ? this._day_out_option(p, now, spend) : null) ||
            this._park_option(p, now, 90),
        ];
      } else { // evening
        const left = m < bed ? Math.max(30, bed - m) : 30;
        opts = [
          new Option("Relax at home", home_act, home, left, 0, { family: 0.3 }, relax_gains, 0.25),
          new Option("Dinner out", "eat_out", this._pick(p, "eat_out", now, 60), 60, DINNER_COST,
            { social: 0.3, thrift: -0.4 }, ACT.eat_out[0], -0.1),
          this._hang_option(sim, p, now, 120),
          new Option("Early night", "sleep", home, 0, 0, { health: 0.4 }, { energy: 30 }, 0.0),
        ];
      }
      return opts;
    }

    _park_option(p, now, minutes) {
      const park = this._pick(p, "park", now, minutes);
      if (park !== null) {
        return new Option("Walk in the park", "walk_park", park, minutes, 0, { health: 0.4, adventure: 0.2 },
          ACT.walk_park[0], 0.1);
      }
      return new Option("A walk round the block", "stroll", this.home_place(p), 2 * STROLL_MINUTES, 0,
        { health: 0.4 }, ACT.stroll[0], 0.05);
    }

    // A day out at the nearest usable mall, cinema, golf club (40+) or library in reach, or null.
    _day_out_option(p, now, spend) {
      const home = this.home_place(p);
      if (home === null) return null;
      const car = this._has_car(p);
      const ck = `${home}|day_out|${car}`;
      let got = this._fav_cache.get(ck);
      if (got === undefined) {
        const net = ft().net(this.town);
        const cands = [];
        for (const [pid, place] of this.town.places) {
          if (!(`${place.kind}/${place.style}` in DAY_OUT) || !this.allowed(pid)) continue;
          const w = net.minutes(home, pid, "walk");
          if (w <= DAY_OUT_WALK || (car && net.minutes(home, pid, "car") <= DAY_OUT_CAR)) cands.push([w, pid]);
        }
        cands.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
        got = cands.map(c => c[1]);
        this._fav_cache.set(ck, got);
      }
      for (const pid of got) {
        const place = this.town.places.get(pid);
        const [act, label, cost, age] = DAY_OUT[`${place.kind}/${place.style}`];
        if (p.age >= age && this._usable(pid, now, DAY_OUT_MINUTES)) {
          return new Option(label, act, pid, DAY_OUT_MINUTES, cost === null ? spend : cost,
            { adventure: 0.4, thrift: -0.2 }, ACT[act][0], 0.1);
        }
      }
      return null;
    }

    _hang_option(sim, p, now, minutes) {
      const cafe = this._pick(p, "coffee", now, minutes) || this._pick(p, "eat_out", now, minutes);
      return new Option("Hang out with a friend", "hang_out", cafe, minutes, HANG_COST, { social: 0.6 },
        ACT.hang_out[0], 0.0);
    }

    // Folk's own scorer: forks.default_scores' terms read from the Person (base + 0.6 style + need + afford
    // - travel).
    score_options(sim, p, opts, now) {
      const traits = p.traits;
      const needs = p._needs;
      const own = this._purse(p);
      const thrift = "thrift" in traits ? traits.thrift : 0.5;
      const m = now % DAY;
      const rate = TRAVEL_COST * (m >= NIGHT_FROM * 60 || m < NIGHT_UNTIL * 60 ? NIGHT_TRAVEL : 1);
      const home = this.home_place(p);
      const here = this.where.get(p.i) || home;
      const car = this._has_car(p);
      const direct = this._trip_minutes(here, home, car);
      const scores = [];
      for (const opt of opts) {
        if (opt.place === null || opt.place === undefined) {
          scores.push(UNAVAILABLE);
          continue;
        }
        let style = 0.0;
        for (const [t, v] of Object.entries(opt.tags)) style += ((t in traits ? traits[t] : 0.5) - 0.5) * 2 * v;
        let need = 0.0;
        for (const [n, g] of Object.entries(opt.gains)) if (n in needs) need += urgency(needs[n]) * g / 25;
        let afford = 0.0;
        if (opt.cost > 0) afford = opt.cost <= own ? -opt.cost / Math.max(own, 50) * thrift : -2.0;
        let score = opt.base + STYLE * style + need + afford;
        if (opt.activity === "stroll" || opt.place !== home) {
          const extra = opt.activity === "stroll" ? 2 * STROLL_MINUTES
            : this._trip_minutes(here, opt.place, car) + this._trip_minutes(opt.place, home, car) - direct;
          if (extra > 0) score -= extra * rate;
        }
        scores.push(G.py.pyRound(score, 3));
      }
      return scores;
    }

    _trip_minutes(a, b, car) {
      if (a === null || b === null || a === undefined || b === undefined || a === b) return 0;
      const w = ft().minutes(this.town, a, b, "walk");
      if (car && w > ft().WALK_MAX) return Math.min(w, ft().minutes(this.town, a, b, "car"));
      return w;
    }

    _purse(p) {
      if (p.age >= 18) return p.money + p.savings;
      const payer = this._payer(p);
      return payer !== null ? payer.money + payer.savings : p.money;
    }

    _payer(p) {
      if (p.age >= 18) return p;
      const hh = this.hh_of(p);
      let best = null;
      if (hh !== null) {
        for (const mid of hh.member_ids) {
          const q = this.person(mid);
          if (q !== null && q.alive && !q.gone && q.age >= 18) {
            if (best === null || q.money + q.savings > best.money + best.savings) best = q;
          }
        }
      }
      return best;
    }

    choose(sim, p, now, kind) {
      const opts = this.options(sim, p, now, kind);
      const scores = this.score_options(sim, p, opts, now);
      const order = [0, 1, 2, 3].sort((a, b) => scores[b] - scores[a] || a - b);
      let pick, by;
      if (scores[order[0]] - scores[order[1]] >= OBVIOUS_MARGIN) {
        pick = order[0];
        by = "habit";
        this.counters.habit += 1;
      } else {
        const rr = G.dice.stream(sim.dice_seed, fm().NS_FOLK, p.i, now); // keyed: made only when the noise decides
        let best = null;
        pick = 0;
        for (let k = 0; k < 4; k++) {
          const s = scores[k] + rr.uniform(0, NOISE);
          if (best === null || s > best) {
            best = s;
            pick = k;
          }
        }
        by = "default";
      }
      this.counters.choices += 1;
      const opt = opts[pick];
      const m = now % DAY;
      const pad = x => String(x).padStart(2, "0");
      p.choose({ time: `${pad(Math.floor(m / 60))}:${pad(m % 60)}`, kind, options: opts.map(o => o.label),
        choice: pick, by });
      this._play(sim, p, now, opt);
    }

    // Bargain, pickpocket, rained out: luck-shifted keyed rolls (`dice.odds`), every roll in the luck log.
    _outcomes(sim, p, now, activity) {
      const rr = G.dice.stream(sim.dice_seed, fm().NS_FOLK, p.i, now, "luck");
      const rolls = [PICKPOCKET];
      if (activity === "shopping" || activity === "buy_groceries") rolls.unshift(BARGAIN);
      if ((activity === "walk_park" || activity === "stroll") && sim.weather === "rain") rolls.push(RAINED_OUT);
      for (const [what, valence, chance, money, fun] of rolls) {
        const prob = G.dice.odds(chance, valence, p.luck);
        const roll = rr.random();
        G.people.log_roll(sim, p, what, prob, roll);
        if (roll < prob) {
          if (money) (this._payer(p) || p).money += money; // the household's purse, as the outing's cost was
          if (fun) p.adjust("fun", fun);
        }
      }
    }

    _play(sim, p, now, opt) {
      if (opt.place === null || opt.place === undefined) {
        opt = new Option("Go home and relax", "relax_home", this.home_place(p), 60);
      }
      if (opt.cost > 0) {
        const payer = this._payer(p) || p;
        payer.money -= opt.cost;
      }
      if (opt.activity === "buy_groceries" || opt.activity === "order_groceries") {
        const hh = this.hh_of(p);
        if (hh !== null) hh.groceries += GROCERY_MEALS;
      }
      if (!HOME_ACTS.includes(opt.activity)) this._outcomes(sim, p, now, opt.activity);
      if (opt.activity === "sleep") {
        this._go_home(sim, p, now, "sleep", this._wake_tick(p, now));
        return;
      }
      if (opt.activity === "stroll") {
        this._stroll(sim, p, now);
        return;
      }
      if (opt.activity === "hang_out") this._companion(sim, p, opt.place, opt.minutes);
      const here = this.where.get(p.i);
      if (here === opt.place) this._begin(p, now, opt.activity, opt.minutes);
      else this._go(sim, p, now, opt.place, opt.activity, null, opt.minutes);
    }

    _companion(sim, p, place_id, minutes) {
      const social = G.social;
      const pick = social && social.pick_companion;
      if (!pick) return;
      let c = pick(sim, p, "visit");
      if (typeof c === "string") c = this.person(c);
      if (c !== null && c !== undefined && c instanceof fm().Person && c !== p) send_to(sim, c, place_id, "hang_out",
        minutes);
    }

    // A walk round the block when no park is in reach: out STROLL_MINUTES toward a nearby place and back.
    _stroll(sim, p, now) {
      const home = this.home_place(p);
      if (home === null) {
        this._begin(p, now, "relax_home", 30);
        return;
      }
      let turn = null;
      for (const pid of this._favs(p, "shopping").concat(this._favs(p, "coffee"))) {
        if (pid !== home) {
          turn = pid;
          break;
        }
      }
      if (turn === null) {
        this._begin(p, now, "relax_home", 30);
        return;
      }
      const out = ft().road_leg(this.town, fm().WALK, home, turn, now);
      const back = ft().road_leg(this.town, fm().WALK, turn, home, out[2]);
      this._leave(p);
      p.trip = new (fm().Trip)([out, back], home, "relax_home", back[2] + 30, "walk");
      p.state = "travelling";
      p.activity = "relax_home";
      p.activity_place = home;
      this.out.set(p.i, null);
      this.counters.trips += 1;
      this.stay.set(p.i, [now, back[2]]);
      this.schedule(p, back[2]);
    }

    // --- frames ---

    _locate(p, tick) {
      const park = this.strollers.get(p.i);
      if (park === undefined) return null;
      let tiles = this._park_tiles.get(park);
      if (tiles === undefined) {
        const place = this.town.places.get(park);
        tiles = [];
        for (let y = place.y; y < place.y + place.h; y++) {
          for (let x = place.x; x < place.x + place.w; x++) tiles.push([x, y]);
        }
        if (!tiles.length) tiles.push(place.entry);
        this._park_tiles.set(park, tiles);
      }
      return tiles[G.dice.key(this.sim.dice_seed, fm().NS_STROLL, p.i, Math.floor(tick / STROLL_EVERY)) %
        tiles.length];
    }

    // The person's tile at tick: on a trip leg (a train's tile while aboard), strolling, else the entry of the
    // place they are at (or home).
    xy(p, tick) {
      const trip = p.trip;
      const { WALK, DRIVE, WAIT } = fm();
      if (trip !== null) {
        const leg = ft().leg_at(trip.legs, tick);
        if (leg !== null) {
          const [kind, t0, , data] = leg;
          if (kind === WALK || kind === DRIVE) {
            const at = data.at(Math.max(0, tick - t0));
            return [at[0], at[1]];
          }
          if (kind === WAIT) return ft().station_xy(this.town, data);
          return ft().train_xy(this.town, data, tick);
        }
      }
      if (this.strollers.has(p.i)) return this._locate(p, tick);
      const place = this.town.places.get(this.where.get(p.i) || this.home_place(p) || "");
      if (place === undefined) return [0, 0];
      return [place.entry[0], place.entry[1]];
    }

    // A child in a car rides in a parent's school run, or is drawn as the car itself unless a sibling it shares the
    // car with is the passenger of a school run or has a lower index.
    _passenger(p, leg) {
      const t0 = p.trip.legs[0][1];
      const run = this._driven.get(p.i);
      if (run !== undefined && run[1] === t0) return true;
      const hh = this.hh_of(p);
      if (hh === null) return false;
      for (const mid of hh.member_ids) {
        const q = this.people[Number(mid.slice(1))];
        if (q === p) continue;
        if (q.trip !== null && q.trip.dest === p.trip.dest && q.age < 18 && q.trip.mode === p.trip.mode) {
          if (q.trip.legs.length && q.trip.legs[0][1] === t0 && q.trip.legs[0][0] === leg[0]) {
            const qr = this._driven.get(q.i);
            if (q.i < p.i || (qr !== undefined && qr[1] === t0)) return true;
          }
        }
      }
      return false;
    }

    // [x, y, mode] of a traveller at tick, or null while aboard a train or a passenger.
    _leg_xy(p, tick) {
      const { WALK, DRIVE, WAIT, K_WALK, K_CAR, K_AMBULANCE, K_WAIT } = fm();
      const trip = p.trip;
      const leg = ft().leg_at(trip.legs, tick);
      if (leg === null) {
        const place = this.town.places.get(trip.dest);
        return place ? [place.entry[0], place.entry[1], K_WALK] : null;
      }
      const [kind, t0, , data] = leg;
      if (kind === WALK || kind === DRIVE) {
        const at = data.at(Math.max(0, tick - t0));
        if (kind === WALK) return [at[0], at[1], K_WALK];
        if (trip.mode === "ambulance") return [at[0], at[1], K_AMBULANCE];
        if (p.age < 18 && this._passenger(p, leg)) return null; // a passenger: the school run's car is an older sibling's
        return [at[0], at[1], K_CAR];
      }
      if (kind === WAIT) {
        const [x, y] = ft().station_xy(this.town, data);
        return [x, y, K_WAIT];
      }
      return null; // RIDE: aboard
    }

    // [i, x, y, k, ...] for folk outdoors and not aboard, sorted by i; k = mode | child << 3.
    crowd(sim) {
      this._bind();
      const tick = sim.clock.tick;
      const out = [];
      const people = this.people;
      const ids = Array.from(this.out.keys()).concat(Array.from(this.strollers.keys())).sort((a, b) => a - b);
      for (const i of ids) {
        const p = people[i];
        let x, y, k;
        if (p.trip !== null) {
          const got = this._leg_xy(p, tick);
          if (got === null) continue;
          [x, y, k] = got;
        } else {
          [x, y] = this._locate(p, tick);
          k = fm().K_OUTDOORS;
        }
        out.push(i, x, y, k | (p.age < 18 ? 8 : 0));
      }
      return out;
    }

    // The crowd invariant's terms: crowd + inside + aboard + passengers == present (living, in town).
    counts(sim) {
      this._bind();
      const tick = sim.clock.tick;
      let aboard = 0, passengers = 0;
      for (const i of this.out.keys()) {
        const p = this.people[i];
        if (this._leg_xy(p, tick) === null) {
          const leg = ft().leg_at(p.trip.legs, tick);
          if (leg !== null && leg[0] === fm().RIDE) aboard += 1;
          else passengers += 1;
        }
      }
      let inside = 0;
      for (const c of this.count) inside += c;
      let present = 0;
      for (const p of this.people) if (p.alive && !p.gone) present += 1;
      return { crowd: Math.floor(this.crowd(sim).length / 4), inside, aboard, passengers, present };
    }

    // Folk inside + named inside per place, in town.places order.
    occ() {
      const out = this.count.slice();
      const pidx = this.pidx;
      for (const a of this.sim.agents.values()) {
        if (a.alive && a.inside !== null) {
          const k = pidx.get(a.inside);
          if (k !== undefined) out[k] += 1;
        }
      }
      return out;
    }

    // Sorted indices of the folk inside a place or strolling in it.
    present(place_id) {
      const occ = this.occupants.get(place_id);
      return occ ? Array.from(occ.keys()).sort((a, b) => a - b) : [];
    }

    riders(tick) {
      const out = {};
      const { RIDE } = fm();
      for (const i of this.out.keys()) {
        const p = this.people[i];
        for (const [kind, t0, t1, data] of p.trip.legs) {
          if (kind === RIDE && t0 <= tick && tick < t1) {
            out[data] = (out[data] || 0) + 1;
            break;
          }
        }
      }
      return out;
    }

    // Best allowed commute from p's home to a place; null when out of reach or not allowed.
    commute_minutes(p, place_id) {
      if (!this.allowed(place_id)) return null;
      const home = this.home_place(p);
      if (home === null || !this.town.places.has(place_id)) return null;
      const got = ft().best_minutes(this.town, home, place_id, this._has_car(p));
      return got === null ? null : got[0];
    }

    // --- stats and pages ---

    // Cash + savings + the adult's share of a home the household owns. sample_hour adds the same up inline, once
    // per household for the share (see the Python twin).
    worth(sim, p) {
      let w = p.money + p.savings;
      const hh = this.hh_of(p);
      if (p.age >= 18 && hh !== null) {
        const share = this._home_share(sim, hh);
        if (share !== null) w += share;
      }
      return Math.floor(w);
    }

    // Each adult's share of the home the household owns (its value over its adults), null if it owns none.
    _home_share(sim, hh) {
      const home = sim.homes ? sim.homes.get(hh.home_id) : undefined;
      if (home === undefined || home.owner !== hh.id) return null;
      let adults = 0;
      for (const mid of hh.member_ids) {
        const q = this.person(mid);
        if (q !== null && q.alive && !q.gone && q.age >= 18) adults += 1;
      }
      const lots = sim.lots;
      let value;
      if (lots && lots.has(home.place)) value = G.housing.value(sim, hh.home_id);
      else value = home.base_value; // a home without a lot (a test world): its base value
      return value / Math.max(1, adults);
    }

    // stats.sample's call on every whole hour: each living townsperson's worth goes into their 24-hour ring
    // (stats.folk.worth_24h) and, in the same pass, their share of the hourly sample comes back (see the Python
    // twin): population, working, mood_sum, health_sum, money_sum (rounded as city_parts rounds them),
    // adult_worths, worth_sum and in_debt. Mood and health are read with Person.peek, settling nobody.
    sample_hour(sim) {
      this._bind();
      const rings = this.rings;
      const tick = sim.clock.tick;
      const households = this.households;
      const nh = households.length;
      const shares = new Map(); // household index -> each adult's share of the home it owns (null: it owns none)
      let pop = 0, working = 0, in_debt = 0, money_sum = 0, mood_sum = 0, health_sum = 0, worth_sum = 0;
      const worths = [];
      for (const p of this.people) {
        if (!p.alive || p.gone) continue;
        const cash = p.money + p.savings;
        let w = cash; // worth(sim, p), inline
        const adult = p.age >= 18;
        if (adult && 0 <= p.hh && p.hh < nh) {
          let share = shares.get(p.hh);
          if (share === undefined) {
            share = this._home_share(sim, households[p.hh]);
            shares.set(p.hh, share);
          }
          if (share !== null) w += share;
        }
        w = Math.floor(w);
        let r = rings.get(p.i);
        if (r === undefined) {
          r = [];
          rings.set(p.i, r);
        }
        r.push(w);
        if (r.length > 24) r.shift();
        pop += 1;
        money_sum += Math.trunc(cash);
        const [mood, health] = p.peek(tick);
        mood_sum += Math.floor(mood + 0.5);
        health_sum += Math.floor(health + 0.5);
        worth_sum += w;
        if (adult) {
          worths.push(w);
          if (p.job !== null) working += 1;
          if (cash < 0) in_debt += 1;
        }
      }
      return { population: pop, working, mood_sum, health_sum, money_sum, adult_worths: worths, worth_sum, in_debt };
    }

    stats_json(sim) {
      this._bind();
      const n = this.people.length;
      const worth = new Array(n).fill(null), w24 = new Array(n).fill(null), mood = new Array(n).fill(null);
      const health = new Array(n).fill(null), luck = new Array(n).fill(null);
      for (const p of this.people) {
        if (!p.alive || p.gone) continue;
        const i = p.i;
        worth[i] = this.worth(sim, p);
        const r = this.rings.get(i);
        w24[i] = r && r.length ? r[0] : null;
        mood[i] = Math.floor(p.mood + 0.5);
        health[i] = Math.floor(p.health + 0.5);
        luck[i] = Math.floor(p.luck + 0.5);
      }
      return { v: this.v, worth, worth_24h: w24, mood, health, luck };
    }

    // Everyone's share of the city block: counts, money and moods by district (stats sums them in).
    city_parts(sim) {
      this._bind();
      const out = { population: 0, adults: 0, children: 0, employed: 0, pupils: 0, money: 0, mood: 0, health: 0,
        outdoors: this.out.size + this.strollers.size, districts: {} };
      for (const p of this.people) {
        if (!p.alive || p.gone) continue;
        out.population += 1;
        if (p.age >= 18) {
          out.adults += 1;
          if (p.job !== null) out.employed += 1;
        } else {
          out.children += 1;
          if (p.job !== null) out.pupils += 1;
        }
        out.money += Math.trunc(p.money + p.savings);
        out.mood += Math.floor(p.mood + 0.5);
        out.health += Math.floor(p.health + 0.5);
        const home = this.home_place(p);
        const place = home ? this.town.places.get(home) : undefined;
        const d = place ? place.district : "";
        let row = out.districts[d];
        if (row === undefined) {
          row = { population: 0, money: 0, mood: 0 };
          out.districts[d] = row;
        }
        row.population += 1;
        row.money += Math.trunc(p.money + p.savings);
        row.mood += Math.floor(p.mood + 0.5);
      }
      return out;
    }

    roster_rows(sim) {
      const rows = [];
      for (const p of this.people) {
        const home = this.home_place(p);
        const place = home ? this.town.places.get(home) : undefined;
        const job = p.job;
        const where = this.where.get(p.i);
        rows.push({ i: p.i, id: p.id, name: p.name, age: p.age, child: p.age < 18, hh: p.household_id,
          home: this._hh_home(p), place: where === undefined ? null : where,
          district: place ? place.district : null, job: job !== null ? job.title : null,
          work: job !== null ? job.place_id : null, alive: p.alive && !p.gone });
      }
      return rows;
    }

    _hh_home(p) {
      const hh = this.hh_of(p);
      return hh !== null ? hh.home_id : null;
    }

    // The light townsperson page (view.md 4.3) plus folk.md 8's keys, `choices` and `life`.
    page_json(sim, fid) {
      this._bind();
      const p = this.person(fid);
      if (p === null) return null;
      const people = G.people;
      const { pyRound } = G.py;
      const hh = this.hh_of(p);
      const home_id = hh !== null ? hh.home_id : null;
      const home = home_id && sim.homes ? sim.homes.get(home_id) : undefined;
      const [x, y] = this.xy(p, sim.clock.tick);
      const rels = {};
      const entries = Array.from(p.relationships.entries()).sort((a, b) => b[1].affinity - a[1].affinity ||
        (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      for (const [oid, r] of entries) rels[oid] = people.rel_row(sim, oid, r);
      const members = [];
      if (hh !== null) {
        for (const mid of hh.member_ids) {
          const q = this.person(mid);
          if (q !== null && q.alive && !q.gone) members.push(q.name);
        }
      }
      const life_block = G.life && G.life.page ? G.life.page(sim, p) : null;
      const trip = p.trip;
      const needs = {};
      for (const [k, v] of Object.entries(p.needs)) needs[k] = pyRound(v, 1);
      return {
        kind: "folk", luck_settable: p.alive && !p.gone, id: p.id, name: p.name, age: p.age,
        sex: p.sex, alive: p.alive, gone: p.gone, state: p.state, activity: p.activity,
        place: p.activity_place, inside: p.inside, x, y, luck: pyRound(p.luck, 1),
        money: pyRound(p.money, 2), savings: pyRound(p.savings, 2), worth: this.worth(sim, p),
        health: pyRound(p.health, 1), mood: pyRound(p.mood), reputation: pyRound(p.reputation),
        needs,
        job: p.job !== null ? p.job.to_json() : null,
        commute: p.commute ? Array.from(p.commute) : null,
        home: home_id ? { id: home_id, name: home ? home.name : null, place: home ? home.place : null } : null,
        household_id: p.household_id, household: members,
        vehicle: trip !== null ? trip.mode : (p.owns_car ? "car" : "walk"),
        relationships: rels, memory: Array.from(p.memory), choices: Array.from(p.choices),
        traits: Object.assign({}, p.traits), life: life_block,
      };
    }

    set_luck(fid, luck) {
      const p = this.person(fid);
      if (p === null || !p.alive || p.gone) return false;
      p.luck = Math.max(0.0, Math.min(100.0, Number(luck)));
      return true;
    }

    // Folk's own time per tick (ms; wall clock in JS): mean and p99 over the last CPU_KEEP ticks.
    perf() {
      const xs = this.cpu.slice().sort((a, b) => a - b);
      if (!xs.length) return { mean_ms: 0.0, p99_ms: 0.0, ticks: 0 };
      let total = 0.0;
      for (const v of xs) total += v;
      return { mean_ms: total / xs.length, p99_ms: xs[Math.min(xs.length - 1, Math.floor(xs.length * 0.99))],
        ticks: xs.length, total_mean_ms: this.cpu_total / Math.max(1, this.ticks) };
    }
  }

  function _folk_of(sim) {
    const f = sim.folk;
    return f instanceof Folk ? f : null;
  }

  // --- life.md 3.2: the folk functions life calls ---

  // Alive, in town, awake, not at or heading to work or school, not in hospital, in free time (and not due at a
  // shift within the hour), and not on an errand someone sent them on (`send_to`: an invite, a date, a friend's
  // outing) until its stay ends, so nobody pulls them off it.
  function is_free(sim, p) {
    const f = _folk_of(sim);
    if (f === null || !(p instanceof fm().Person) || !p.alive || p.gone || p.age < 5) return false;
    if (!FREE.includes(p.activity) || f.sent.has(p.i)) return false;
    const job = p.job;
    if (job !== null) {
      const now = sim.clock.tick;
      const [day, m] = divmod(now, DAY);
      if (job.workdays.includes(day % 7) && p.worked_day !== day) {
        const leave = f._set_off(p);
        if (leave - 60 <= m && m < f._end_minute(p)) return false;
      }
    }
    return true;
  }

  // If free (or for the ward: always), interrupt what p is doing, travel there and stay `minutes`. The ward goes by
  // ambulance (one DRIVE leg).
  function send_to(sim, p, place_id, activity, minutes) {
    const f = _folk_of(sim);
    if (f === null || !(p instanceof fm().Person) || !p.alive || p.gone) return false;
    if (!f.town.places.has(place_id)) return false;
    const ward = activity === WARD;
    if (!ward && (!is_free(sim, p) || !f.allowed(place_id))) return false;
    const now = sim.clock.tick;
    if (p.trip !== null) _cut_trip(f, p, now);
    else f._gain(p, now);
    f.settle(p, now);
    f.ends.delete(p.i);
    if (ward) f.sent.delete(p.i);
    else f.sent.add(p.i);
    if (f.where.get(p.i) === place_id) {
      f._begin(p, now, activity, minutes);
      return true;
    }
    if (ward) {
      const src = f.where.get(p.i) || f.home_place(p);
      f._leave(p);
      const legs = src && src !== place_id ? [ft().road_leg(f.town, fm().DRIVE, src, place_id, now)] : [];
      const arrive = ft().end_of(legs, now);
      p.trip = new (fm().Trip)(legs, place_id, WARD, arrive + Math.max(1, Math.trunc(minutes)), "ambulance");
      p.state = "travelling";
      p.activity = WARD;
      p.activity_place = place_id;
      f.out.set(p.i, null);
      f.stay.set(p.i, [now, arrive]);
      f.schedule(p, arrive);
      return true;
    }
    f._go(sim, p, now, place_id, activity, null, Math.max(1, Math.trunc(minutes)));
    return true;
  }

  // Stop a trip where it is: the person is put at the trip's start or end place, whichever is nearer.
  function _cut_trip(f, p, now) {
    const t = p.trip;
    p.trip = null;
    f.out.delete(p.i);
    const start = t.legs.length ? t.legs[0][1] : now;
    const end = t.legs.length ? t.legs[t.legs.length - 1][2] : now;
    const RIDE = fm().RIDE;
    const rides = t.legs.filter((leg) => leg[0] === RIDE);
    if (rides.length && now < rides[0][1]) {
      // cut before the first train leaves: the fare paid at departure comes back and the boardings never were
      p.money += ft().fare(p.age);
      f.counters.boardings -= rides.length;
      f.counters.train_trips -= 1;
      if (Math.floor(start / DAY) === Math.floor(now / DAY)) { // counted in today's figures (not a trip from before midnight)
        f.today.boardings -= rides.length;
        f.today.train_trips -= 1;
        const per = f.today.lines;
        for (const leg of rides) {
          const line = f._line_of(leg[3]);
          const left = (per[line] || 0) - 1;
          if (left > 0) per[line] = left;
          else delete per[line];
        }
      }
    }
    let place = now - start >= end - now ? t.dest : null;
    if (place === null) place = t.dest !== f.home_place(p) ? f.home_place(p) : t.dest;
    p.state = "busy";
    p.activity = "idle";
    f._enter(p, place);
  }

  // To the nearest hospital by ambulance for `days` (life's ward); home afterwards.
  function hospitalise(sim, p, days) {
    const f = _folk_of(sim);
    if (f === null) return false;
    const src = f.where.get(p.i) || f.home_place(p);
    let best = null;
    for (const [pid, place] of f.town.places) {
      if (place.kind === "hospital" && f.allowed(pid)) {
        const m = src ? ft().minutes(f.town, src, pid, "car") : 0;
        if (best === null || m < best[0] || (m === best[0] && pid < best[1])) best = [m, pid];
      }
    }
    if (best === null) return false;
    return send_to(sim, p, best[1], WARD, Math.max(1, Math.trunc(days * DAY)));
  }

  // Folk bookkeeping only (life's die and folk_life's release call it): off the wheel, out of the place and off any
  // trip. It never changes `alive`.
  function kill(sim, p, how) {
    const f = _folk_of(sim);
    if (f === null) return;
    if (p.trip !== null) p.trip = null;
    f.out.delete(p.i);
    f._leave(p);
    f.ends.delete(p.i);
    f.sent.delete(p.i);
    p.next_tick = -1;
    p.state = "idle";
    p.activity = "idle";
    f.v += 1;
  }

  // A new job, none, or a school: refresh the commute (the next step plans the day from it).
  function on_job_change(sim, p) {
    const f = _folk_of(sim);
    if (f === null) return;
    p.commute = null;
    if (p.job !== null) f._commute_of(p);
    f.v += 1;
  }

  // A new townsperson in an existing household: {household, age, sex, first?, surname?, traits?, name?};
  // life.init_person, then on the wheel at home.
  function add_person(sim, spec) {
    const f = _folk_of(sim);
    if (f === null) return null;
    let hh = spec.household;
    if (typeof hh === "string") hh = f.household(hh);
    const i = f.people.length;
    const name = spec.name || `${spec.first || "Baby"} ${spec.surname || ""}`.trim();
    const p = new (fm().Person)(i, name, Math.trunc(spec.age || 0), spec.sex || "f",
      hh.j >= 0 ? hh.j : f.households.indexOf(hh));
    p.household_id = hh.id;
    p.traits = Object.assign({}, spec.traits || { thrift: 0.5, family: 0.5, social: 0.5, diligence: 0.5, health: 0.5,
      adventure: 0.5 });
    p._nt = sim.clock.tick;
    p.activity = p.age < 5 ? "baby" : "relax_home";
    f.people.push(p);
    f.n = f.people.length; // state.folk_n, stats.folk and the roster all have this length (PLAN 2.10)
    hh.member_ids.push(p.id);
    const home = f.home_place(p);
    if (home !== null) f._enter(p, home);
    f.stay.set(p.i, [sim.clock.tick, sim.clock.tick + 1]);
    f.schedule(p, sim.clock.tick + 1);
    f.v += 1;
    const life = G.life;
    if (life && life.init_person) life.init_person(sim, p);
    return p;
  }

  // A baby in the mother's household: age 0, a unique first name (folk_gen.baby_name), traits the parents' mean +- .1
  // on stream BIRTH, then life.init_person.
  function add_baby(sim, mother, father = null) {
    const f = _folk_of(sim);
    if (f === null) return null;
    const dice = G.dice;
    const rr = dice.stream(sim.dice_seed, dice.BIRTH, mother.id, sim.clock.tick);
    const sex = rr.random() < 0.5 ? "f" : "m";
    const parts = mother.name.split(" ");
    const surname = parts[parts.length - 1];
    const first = G.folk_gen.baby_name(sim, sex, surname, f.people.length);
    const traits = {};
    const mt = mother.traits || {};
    const ftr = father !== null && father !== undefined ? (father.traits || mt) : mt;
    for (const t of ["thrift", "family", "social", "diligence", "health", "adventure"]) {
      const mean = ((t in mt ? mt[t] : 0.5) + (t in ftr ? ftr[t] : 0.5)) / 2;
      traits[t] = G.py.pyRound(Math.max(0.0, Math.min(1.0, mean + rr.uniform(-0.1, 0.1))), 3);
    }
    const hh = f.household(mother.household_id);
    const name = first.includes(" ") ? first : `${first} ${surname}`;
    return add_person(sim, { household: hh, age: 0, sex, name, traits });
  }

  const join = (sim, p, host) => G.folk_life.join(sim, p, host);
  const split = (sim, p) => G.folk_life.split(sim, p);
  const release = (sim, p) => G.folk_life.release(sim, p);

  function on_birthday(sim, p) {
    const fl = G.folk_life;
    if (fl && fl.on_birthday) return fl.on_birthday(sim, p);
    return null;
  }

  // Lazy needs to now (people.settle's folk branch).
  function settle(sim, p) {
    const f = _folk_of(sim);
    if (f !== null && p instanceof fm().Person) f.settle(p, sim.clock.tick);
  }

  G.folk = {
    DAY_OUT, DAY_OUT_WALK, DAY_OUT_CAR, DAY_OUT_MINUTES, BARGAIN, PICKPOCKET, RAINED_OUT, DINNER_FROM, DINNER_UNTIL, DINNER_MINUTES, DAY, OBVIOUS_MARGIN, NOISE, TRAVEL_COST, NIGHT_TRAVEL, NIGHT_FROM, NIGHT_UNTIL, STYLE, SHIFT_MARGIN, SHIFT_SPREAD, LATE_GRACE,
    EVENING, STROLL_EVERY, STROLL_MINUTES, FAV_WALK, FAV_CAR, FAV_KEEP, UNAVAILABLE, CPU_KEEP, WARD, FREE, ACT,
    SLEEP_ENERGY, HOME_ACTS, KEEP_OPEN, LEISURE, GROCERY_COST, COFFEE_COST, MEAL_COST, DINNER_COST, HANG_COST,
    GROCERY_MEALS, urgency, Option, Folk, is_free, send_to, hospitalise, kill, on_job_change, add_person, add_baby,
    join, split, release, on_birthday, settle,
  };
})(globalThis.GameOfAILife || (globalThis.GameOfAILife = {}));

// Port of gameofailife/sim.py: the simulation: the world clockwork, the agents' days, and the Decision Director.
//
// The simulation is synchronous and knows nothing about the network. The host calls `step()` on a timer, hands
// controller answers to `answer()`, and drains `outbox` (messages for controllers) and `events` (for God's view)
// after each step.
//
// The city's other parts plug in through hook functions this module calls at fixed points (PLAN 3.10):
// `housing` (homes, rent, upkeep), `travel` and `transit` (getting around), `chronicle` (event tags) and
// `stats` (counters and samples).
//
// Port notes: Python's random.Random(seed) is SimDice here (mulberry32 with the same four helpers), so the
// outcome dice differ from Python's while every probability is the same (PLAN decision 22). `luck_log_path` is
// a function that receives each JSON line, or null. Fork ids come from `_fork_ids` (see forks.js).
(function (G) {
  "use strict";
  const { getd, hasOwn, pyMod, pyRound, fmt, firstName, cut, keepLast, argmax, sortedBy, maxBy, pyFloat,
    pyClamp, pyStrip, pyTruthy, PyError, REL } = G.py;

  const ANSWER_SECONDS = 5.0; // a controller's answer applies if it arrives within this
  const LEARN_SECONDS = 10.0; // a later answer is still saved and teaches the profile
  const INVITE_MINUTES = 120; // an unanswered invite expires after this
  // SPEEDS, TAXI_FARE, BUS_FARE and WORK_LEAD come from travel, transit and forks: one copy of each.
  const PENSION = 400.0; // paid every Friday morning to retirees (65+ with no job)
  const BILLS_PER_ADULT = 80.0; // weekly phone, power and transport, charged with the rent
  const CAR_BILL = 40.0; // weekly fuel and insurance for a car owner
  const HOSPITAL_FEE = 50.0;
  const GROCERY_COST = 35.0; // ten meals from Fresh Market: the price of 'Buy groceries now' in the groceries fork
  const SHIFT_MARGIN = 10; // minutes spare a character keeps before setting off for a shift
  const LEISURE = ["idle", "relax_home", "read", "side_project", "text", "rest"]; // activities that can be interrupted
  const HISTORY_SIZE = 300, NEWS_SIZE = 300, HEADLINES_SIZE = 100; // events kept: all, importance >= 1, importance 2
  const LLM_LOG_SIZE = 500; // the city's ring of fork summaries decided by a model or a timeout
  const AGENT_LLM_FORKS = 30; // ... and each character's

  // Share of pay withheld: about 22% for a cashier, 43% for a doctor.
  const income_tax = hourly_wage => Math.min(0.45, 0.15 + 0.004 * hourly_wage);

  class Activity {
    constructor(minutes, gains = {}, inside = true) {
      this.minutes = minutes;
      this.gains = gains; // spread evenly over the activity
      this.inside = inside; // happens inside the place (hidden from the map)
    }
  }

  const ACTIVITIES = {
    work: new Activity(0), // lasts until the shift ends
    sleep: new Activity(0), // lasts until morning
    coffee: new Activity(15, { energy: 15, social: 5 }),
    rest: new Activity(240, { energy: 30, fun: 25 }),
    stay_up: new Activity(90, { fun: 30, energy: -8 }),
    text: new Activity(15, { social: 12 }),
    read: new Activity(40, { fun: 14 }),
    eat_home: new Activity(30, { hunger: 60, social: 4 }),
    buy_groceries: new Activity(20, {}),
    order_food: new Activity(45, { hunger: 50 }),
    eat_out: new Activity(40, { hunger: 55, social: 10, fun: 6 }),
    snack: new Activity(5, { hunger: 25 }, false),
    wait: new Activity(30, {}, false),
    hang_out: new Activity(90, { social: 40, fun: 25 }),
    relax_home: new Activity(60, { fun: 25, energy: 5 }),
    shopping: new Activity(45, { fun: 20 }),
    family_dinner: new Activity(90, { hunger: 50, social: 30, fun: 10 }),
    phone_call: new Activity(30, { social: 30 }, false),
    walk_park: new Activity(60, { fun: 30, social: 4 }, false),
    side_project: new Activity(90, { fun: 20 }),
    idle: new Activity(20, {}),
    hospital: new Activity(180, { hunger: 40 }), // the ward feeds its patients
  };
  // The housing forks' activities (moving house, viewings, DIY, ...): none of them is leisure.
  for (const [name, spec] of Object.entries(G.housing.ACTIVITIES_EXTRA)) {
    ACTIVITIES[name] = new Activity(spec.minutes, Object.assign({}, spec.gains), spec.inside);
  }

  // How fast needs drop during some activities (default 1.0).
  const DECAY_SCALE = {
    sleep: { energy: 0.0, hunger: 0.35, social: 0.0, fun: 0.0 },
    work: { social: 0.0, fun: 1.3, hunger: 0.6 },
    hospital: { social: 0.5, fun: 0.5 },
  };

  const LIGHT_CYCLE = 6; // minutes: N-S green 0-2, yellow 2-3, E-W green 3-5, yellow 5-6
  const STOP_AT_LIGHTS = ["car", "taxi"]; // they wait at a red light on entering a junction; buses and ambulances don't
  const ONE_WAY = ["taxi", "ambulance"]; // vehicles that take a character to one place: on arrival they are on foot again
  const BUS_GIVE_UP = 26; // minutes at a stop (two headways, which the exact timetable never allows) before walking instead
  const FLIGHT_MINUTES = 12; // the daily planes (transit.FLIGHTS) take this long to cross the sky

  // One decimal, rounding half up (floor(x * 10 + 0.5) / 10), as the Python twin does.
  const _r1 = x => Math.floor(x * 10 + 0.5) / 10;

  // The simulation's dice: Python's random.Random helpers over mulberry32.
  class SimDice {
    constructor(seed) { this.rng = new G.rng.Rng(G.rng.mix(seed, 0x2545F491, 0x6A09E667)); }
    random() { return this.rng.random(); }
    uniform(a, b) { return a + (b - a) * this.rng.random(); }
    randrange(a, b) { return a + Math.floor(this.rng.random() * (b - a)); }
    choice(seq) {
      if (!seq.length) throw new PyError("IndexError", "Cannot choose from an empty sequence");
      return seq[Math.floor(this.rng.random() * seq.length)];
    }
  }

  const defaultNow = () => (globalThis.performance ? globalThis.performance.now() / 1000 : Date.now() / 1000);

  class Simulation {
    // new Simulation(seed = 1, now = monotonic seconds, luck_log_path = null, dice = seed): `dice` seeds the
    // outcome dice on their own (the page rolls fresh dice for the same city on every load).
    constructor(seed = 1, now = null, luck_log_path = null, dice = null) {
      const { housing, stats, town, cast } = G;
      this.seed = seed;
      this.rng = new SimDice(dice === null || dice === undefined ? seed : dice);
      this.now = now || defaultNow;
      this.clock = new G.clock.Clock();
      this.town = town.build_map(seed); // shared with every Simulation of this seed: never changed
      this.homes = housing.build_homes(this.town); // home id -> Home
      this.lots = housing.build_lots(this.town, this.homes); // residential place id -> Lot (its condition)
      [this.agents, this.households] = cast.build_cast(this.town, this.homes, seed);
      housing.init(this);
      this.stats = new stats.CityStats();
      this.weather = "clear";
      this.forks = new Map(); // every fork still asked or recently decided
      this.asked_at = new Map();
      this.invites = new Map();
      this.events = []; // new events since the host last drained them
      this.history = []; // the last HISTORY_SIZE events, for new God views
      this.news = []; // ... of importance 1 or 2
      this.headlines = []; // ... of importance 2
      this.fork_log = []; // decided forks since last drain
      this.llm_log = []; // the last LLM_LOG_SIZE summaries decided by a model or a timeout
      this.outbox = []; // [controller name, message]
      this.controllers = new Map(); // name -> {model, characters: [ids]}
      this.luck_log = []; // hidden: odds and rolls, never sent to anyone
      this.luck_log_path = luck_log_path;
      this._event_seq = 0;
      this._invite_ids = 0;
      this._fork_ids = 0; // forks.build_fork numbers forks from here (Python: a module-wide counter)
      this._host_hold = new Map(); // host id -> tick they wait at an invite place until
      this._roll_weather();
    }

    // --- lookups used by the fork builders -----------------------------------

    household(agent) { return this.households.get(agent.household_id); }

    // The place id of the character's home: the house, or the apartment block of a flat.
    home_of(agent) { return this.homes.get(this.household(agent).home_id).place; }

    pending_invite_for(agent) {
      for (const inv of this.invites.values()) if (inv.to === agent.id && inv.status === "pending") return inv;
      return null;
    }

    on_shift_now(agent) {
      const job = agent.job;
      return Boolean(job && job.on_shift(this.clock.weekday, this.clock.hour) && agent.worked_today === this.clock.day
        && agent.activity === "work");
    }

    // Minutes on foot from where the character is to a place.
    walk_minutes(agent, place_id) {
      if (agent.inside === place_id) return 0;
      return this.town.walk_minutes([agent.x, agent.y], place_id);
    }

    // Tick today's shift starts, while the character can still turn up for it (up to WORK_LATE late).
    _shift_start_tick(agent) {
      const job = agent.job;
      if (!job || agent.worked_today === this.clock.day || !job.workdays.includes(this.clock.weekday)
        || this.clock.minute_of_day > job.start_hour * 60 + G.forks.WORK_LATE) return null;
      return this.clock.tick - this.clock.minute_of_day + job.start_hour * 60;
    }

    // True when the place is open `walk` minutes from now and stays open for `minutes` after that, to the minute
    // (an activity that ends as the doors shut is not cut short). A place with no hours always fits.
    _fits_before_closing(place, minutes, walk = 0) {
      if (!place.hours) return true;
      const start = this.clock.minute_of_day + walk;
      return place.hours[0] * 60 <= start && start + minutes <= place.hours[1] * 60;
    }

    // Children's costs they can't cover are paid by an adult in the household.
    _payer_for(agent, cost) {
      if (agent.is_adult || cost <= Math.max(agent.money, 0)) return agent;
      const adults = this.household(agent).member_ids.map(m => this.agents.get(m)).filter(a => a.alive && a.is_adult);
      return adults.length ? maxBy(adults, a => a.money) : agent;
    }

    living() { return Array.from(this.agents.values()).filter(a => a.alive); }

    // --- getting around, homes and statistics (delegated to their modules) ----

    travel_minutes(agent, place_id, mode, worst = false) { return G.travel.travel_minutes(this, agent, place_id, mode, worst); }

    usual_mode(agent) { return G.travel.usual_mode(this, agent); }

    commute_minutes(agent) { return G.travel.commute_minutes(this, agent); }

    weekly_commute_cost(agent) { return G.travel.weekly_commute_cost(this, agent); }

    nearest(agent, kinds, origin = null, meet = null, stay = 0) { return G.travel.nearest(this, agent, kinds, origin, meet, stay); }

    pay_household(hh, amount) { G.housing.pay_household(this, hh, amount); }

    // What the character owns: the agent page's and `query possessions`' block.
    possessions(agent) { return G.housing.possessions_json(this, agent); }

    // The homes for sale and to let (controller `query market`).
    market_json() { return G.housing.market_json(this); }

    // God's `get_home` reply body, or null for an unknown home.
    home_page(home_id) { return G.housing.home_page(this, home_id); }

    // `state.buses`: positions are a pure function of the tick; riders are counted from `agent.riding`.
    buses() { return G.transit.bus_rows(this.clock.tick, this.agents.values()); }

    // God's `stats` push (PLAN 3.8), built by stats.stats_json.
    stats_json(full = false) { return G.stats.stats_json(this, full); }

    // The `get_decisions` reply body, built by stats.decisions.
    decisions(agent_id = null, before = null, limit = 30) { return G.stats.decisions(this, agent_id, before, limit); }

    // --- events ---------------------------------------------------------------

    // Log something that happened, for God's views and the character's memory.
    //
    // event(text, agent, kind, {tag, importance, agents, place, remember}): `tag` is a key of
    // chronicle.EVENT_TAGS and gives the kind and importance unless the call names them. `place` is a place id:
    // the one given, else where the character is or is headed, else null. remember=false (and the God-only
    // tags) keeps the line out of the character's memory.
    event(text, agent = null, kind = null, o = {}) {
      const tag = o.tag ?? "other";
      const remember = o.remember ?? true;
      let place = o.place ?? null;
      if (place === null && agent) place = agent.inside || agent.activity_place;
      this._event_seq += 1;
      const stamp = this.clock.stamp();
      const ev = G.chronicle.make_event(this._event_seq, this.clock.tick, stamp, text, tag, kind, o.importance ?? null,
        agent ? agent.id : null, o.agents ?? null, place, agent ? [agent.x, agent.y] : null);
      this.events.push(ev);
      this.history.push(ev);
      keepLast(this.history, HISTORY_SIZE);
      if (ev.importance >= 1) {
        this.news.push(ev);
        keepLast(this.news, NEWS_SIZE);
        if (ev.importance >= 2) {
          this.headlines.push(ev);
          keepLast(this.headlines, HEADLINES_SIZE);
        }
      }
      if (agent && remember && !G.chronicle.GOD_ONLY_TAGS.has(tag)) agent.remember(stamp, text);
      return ev;
    }

    drain() {
      const out = [this.events, this.fork_log, this.outbox];
      this.events = [];
      this.fork_log = [];
      this.outbox = [];
      return out;
    }

    // --- the main loop --------------------------------------------------------

    step() {
      this.clock.advance();
      const m = this.clock.minute_of_day;
      if (m === 6 * 60 || m === 14 * 60) this._roll_weather();
      if (m === 0) this._new_day();
      if (this.clock.weekday === 6 && m === 23 * 60) G.housing.weekly_charges(this); // rent or property tax, and bills
      if (this.clock.weekday === 4 && m === 9 * 60) this._pay_pensions();
      this._check_timeouts();
      this._expire_invites();
      G.housing.tick(this);
      for (const agent of this.living()) this._tick_agent(agent);
      if (m % 60 === 0) this.stats.sample(this);
    }

    run_days(days) {
      const n = Math.trunc(days * G.clock.MINUTES_PER_DAY);
      for (let i = 0; i < n; i++) this.step();
    }

    // --- world clockwork ------------------------------------------------------

    _roll_weather() {
      const old = this.weather;
      this.weather = this.rng.random() < G.forks.RAIN_CHANCE[this.clock.season] ? "rain" : "clear";
      if (old !== this.weather) {
        this.event(this.weather === "rain" ? "It starts to rain." : "The sky clears up.", null, null, { tag: "weather" });
      }
    }

    _new_day() {
      const { DAYS_PER_SEASON, SEASONS } = G.clock;
      for (const agent of this.living()) {
        // Old age: a small daily chance from 70, which Luck softens.
        if (agent.age >= 70) {
          // About 0.75% a month at 74 and 3.6% at 80 (at Luck 50), so a death in the first weeks is rare.
          const p = G.forks.luck_odds(0.00001 * (agent.age - 69) ** 2, -1, agent.luck);
          const roll = this.rng.random();
          this._log_roll(agent, "old_age", p, roll);
          if (roll < p) this._die(agent, "passed away peacefully in their sleep");
        }
      }
      if (this.clock.day % (DAYS_PER_SEASON * SEASONS.length) === 0 && this.clock.day) {
        for (const agent of this.living()) agent.age += 1;
      }
      G.housing.nightly(this);
      this.stats.reset_day();
    }

    _pay_pensions() {
      for (const a of this.living()) {
        if (a.job === null && a.age >= 65) {
          a.money += PENSION;
          this.event(`${a.name} receives a $${fmt(PENSION)} pension.`, a, null, { tag: "pension" });
        }
      }
    }

    // Traffic light phase for north-south traffic; east-west is the opposite.
    lights() {
      const phase = pyMod(this.clock.tick, LIGHT_CYCLE);
      const ns = phase < 2 ? "green" : phase < 3 ? "yellow" : "red";
      const ew = phase < 3 ? "red" : phase < 5 ? "green" : "yellow";
      return { ns, ew };
    }

    plane() {
      const m = this.clock.minute_of_day;
      for (const dep of G.transit.FLIGHTS) {
        if (dep <= m && m < dep + FLIGHT_MINUTES) {
          return { progress: pyRound((m - dep) / FLIGHT_MINUTES, 3), from: "Riverton", to: "Lakeside" };
        }
      }
      return null;
    }

    timetable() { return G.transit.timetable_json(); }

    // --- agents ---------------------------------------------------------------

    _tick_agent(agent) {
      this._decay(agent);
      if (agent.state === "travelling") this._travel(agent);
      else if (agent.state === "busy") this._do_activity(agent);
      this._apply_due_outcomes(agent);
      if (!agent.alive) return;
      if (agent.health <= 0) {
        this._die(agent, "collapsed and could not be saved");
        return;
      }
      if (agent.state === "idle") this._next(agent);
    }

    _decay(agent) {
      const { NEEDS, NEED_DECAY } = G.agent;
      const scale = getd(DECAY_SCALE, agent.state === "busy" ? agent.activity : "", {});
      for (const n of NEEDS) agent.adjust(n, -NEED_DECAY[n] * getd(scale, n, 1.0));
      if (agent.needs.hunger <= 0) agent.health -= 0.03;
      if (agent.needs.energy <= 0) agent.health -= 0.02;
      if (Math.min(...Object.values(agent.needs)) > 40 && agent.health < 100) agent.health = Math.min(100.0, agent.health + 0.004);
    }

    // Start the next planned step, or let the Director find the next decision.
    _next(agent) {
      if (agent.plan.length && this._must_leave_for_work(agent, agent.plan[0][1])
        && !agent.plan.some(s => s[0] === "work")) {
        agent.plan = []; // drop the rest of the plan: it's time to head to work
      }
      if (agent.plan.length) {
        const [activity, where] = agent.plan.shift();
        this._start_step(agent, activity, where);
        return;
      }
      if (agent.fork_id) {
        this._finish_fork(agent);
        if (agent.state !== "idle" || agent.plan.length) return; // an outcome set the character off (a haggle's deal: moving house)
      }
      if (agent.health < 25 && agent.inside !== "hospital") {
        this.event(`${agent.name} feels very unwell, and an ambulance takes them to `
          + `${this.town.places.get("hospital").name}.`, agent, null, { tag: "hospital" });
        this.start_plan(agent, [["hospital", "hospital"]], "ambulance"); // free; the hospital's fee stays
        return;
      }
      const fork = G.forks.build_fork(this, agent);
      if (fork) {
        this.director(agent, fork);
        return;
      }
      const home = this.home_of(agent);
      agent.plan = agent.inside !== home ? [["idle", "home"]] : [["idle", null]];
      const [activity, where] = agent.plan.shift();
      this._start_step(agent, activity, where);
    }

    // True once it's time to set off for today's shift: SHIFT_MARGIN minutes before the commute by the usual
    // way (car, bus with its worst wait, or on foot) would start it, counting the trip by way of `via` if given.
    _must_leave_for_work(agent, via = null) {
      const start = this._shift_start_tick(agent);
      if (start === null) return false;
      const place_id = this._resolve_place(agent, via);
      let route;
      if (place_id && agent.inside !== place_id) {
        const mode = this.usual_mode(agent);
        route = (this.travel_minutes(agent, place_id, mode, true)
          + G.travel.leg_minutes(this, place_id, agent.job.place_id, mode));
      } else {
        route = this.commute_minutes(agent);
      }
      return this.clock.tick >= start - route - SHIFT_MARGIN;
    }

    _resolve_place(agent, where) {
      if (where === "home") return this.home_of(agent);
      if (where === "job") return agent.job ? agent.job.place_id : this.home_of(agent);
      return where ?? null;
    }

    _start_step(agent, activity, where) {
      const place_id = this._resolve_place(agent, where);
      agent.activity = activity;
      agent.activity_place = place_id;
      agent.trip = agent.riding = null; // a new step is a new trip (a bus ride in progress ends here too)
      if (place_id && agent.inside !== place_id) {
        const place = this.town.places.get(place_id);
        const start = [agent.x, agent.y];
        if (agent.vehicle === "bus" && this._take_bus(agent, place_id)) return;
        if (G.travel.ROAD_MODES.includes(agent.vehicle)) agent.path = this.town.drive_path(start, place_id);
        else agent.path = this.town.path(start, place.entry);
        agent.inside = null;
        if (agent.path.length) {
          agent.state = "travelling";
          return;
        }
        [agent.x, agent.y] = place.entry;
      }
      this._begin_activity(agent);
    }

    // Set off by bus: the trip `travel.bus_trip` finds leaving now, or false (walk) when no bus saves time.
    //
    // The rider walks to the board stop (`to_stop`), waits there (`waiting`) until a bus of the line stands at it,
    // boards and pays (`riding`, `agent.riding` = the bus id, riding on the bus's tile), gets off on the first tick
    // that bus stands at the alight stop and walks in (`from_stop`). So they walk in at departure + the trip's
    // minutes, exactly as transit.best_trip counts them.
    _take_bus(agent, place_id) {
      const found = G.travel.bus_trip(this, agent, place_id);
      if (found === null) return false;
      const [, line, board, alight] = found;
      agent.inside = null;
      agent.state = "travelling";
      agent.trip = { mode: "bus", line, board, alight, phase: "to_stop", since: this.clock.tick };
      agent.path = this.town.path([agent.x, agent.y], G.transit.STOP_XY[board]);
      if (!agent.path.length) { // already at the stop: a bus may be standing there now
        this._bus_phase(agent, "waiting");
        this._bus_step(agent, agent.trip);
      }
      return true;
    }

    _bus_phase(agent, phase) {
      agent.trip.phase = phase;
      agent.trip.since = this.clock.tick;
    }

    // One minute at the stop or on board (buses are a pure function of the tick, so they have moved already).
    _bus_step(agent, trip) {
      const tick = this.clock.tick;
      if (trip.phase === "waiting") {
        const bus = G.transit.bus_at_stop(trip.line, trip.board, tick);
        if (bus) {
          const fare = G.transit.fare(agent.age); // paid once, on boarding
          if (fare) this._payer_for(agent, fare).money -= fare;
          agent.riding = bus;
          this._bus_phase(agent, "riding");
        } else if (tick - trip.since >= BUS_GIVE_UP) {
          agent.trip = null; // no bus came: walk the rest of the way
          this._walk_on(agent);
        }
        return;
      }
      [agent.x, agent.y] = G.transit.bus_xy(agent.riding, tick);
      if (G.transit.bus_at_stop(trip.line, trip.alight, tick) === agent.riding) {
        agent.riding = null;
        this._bus_phase(agent, "from_stop");
        this._walk_on(agent);
      }
    }

    // From a bus stop, walk to the step's place (starting next minute).
    _walk_on(agent) {
      agent.path = this.town.path([agent.x, agent.y], this.town.places.get(agent.activity_place).entry);
      if (!agent.path.length) {
        agent.trip = null;
        this._begin_activity(agent);
      }
    }

    _travel(agent) {
      const trip = agent.trip;
      if (trip && (trip.phase === "waiting" || trip.phase === "riding")) {
        this._bus_step(agent, trip);
        return;
      }
      let light = null;
      for (let i = 0; i < agent.speed; i++) {
        if (!agent.path.length) break;
        const nxt = agent.path[0];
        if (STOP_AT_LIGHTS.includes(agent.vehicle) && this.town.junctions.has(G.town.xy(nxt[0], nxt[1]))) {
          light = light || this.lights();
          const axis = nxt[0] === agent.x ? "ns" : "ew";
          if (light[axis] === "red") break; // wait at the junction
        }
        [agent.x, agent.y] = agent.path.shift();
      }
      if (agent.path.length) return;
      if (trip && trip.phase === "to_stop") { // at the stop: a bus may be standing there now
        this._bus_phase(agent, "waiting");
        this._bus_step(agent, trip);
        return;
      }
      agent.trip = null;
      this._begin_activity(agent);
    }

    _begin_activity(agent) {
      if (ONE_WAY.includes(agent.vehicle)) { // the taxi or ambulance has gone: the next trip is on foot unless chosen
        agent.vehicle = "walk";
        agent.speed = G.travel.SPEEDS.walk;
      }
      const act = ACTIVITIES[agent.activity];
      const place_id = agent.activity_place;
      const paid = agent.paid ?? null;
      agent.paid = null;
      const place = this.town.places.get(place_id || "");
      if (place && place.hours && agent.activity !== "work") {
        if (!place.is_open(this.clock.hour)) {
          this._find_shut(agent, place, paid);
          return;
        }
        if (paid && paid[1] > 0 && !this._fits_before_closing(place, act.minutes)) {
          // A paid outing goes ahead only if the place stays open for all of it. The fork offered it only then,
          // but a controller's answer can come seconds (game minutes) later, and a trip can run slow.
          this._find_shut(agent, place, paid, true);
          return;
        }
      }
      agent.state = "busy";
      agent.path = [];
      if (place_id) agent.inside = act.inside && this.town.places.get(place_id).kind !== "park" ? place_id : null;
      const tick = this.clock.tick;
      if (agent.activity === "work") {
        const end = agent.job ? agent.job.end_hour * 60 : this.clock.minute_of_day + 60;
        const minutes = Math.max(30, end - this.clock.minute_of_day);
        agent.busy_until = tick + minutes;
        // Paid from the shift start, not for turning up early.
        const start = agent.job ? tick - this.clock.minute_of_day + agent.job.start_hour * 60 : tick;
        agent.work_started = Math.max(tick, Math.min(start, agent.busy_until - 30));
      } else if (agent.activity === "sleep") {
        // Up with time for breakfast before the shift: 7:00 starters at about 5:30, an hour more than the
        // commute from home (the usual way, the worst bus wait counted) for the long ones.
        let wake = 7 * 60;
        if (agent.job) {
          wake = Math.min(wake, agent.job.start_hour * 60 - Math.max(90, (this.commute_minutes(agent) || 0) + 60));
        }
        wake += this.rng.randrange(0, 25);
        const m = this.clock.minute_of_day;
        let minutes = pyMod(wake - m, G.clock.MINUTES_PER_DAY);
        if (minutes > 11 * 60 || minutes < 60) minutes = 180; // a nap in the daytime
        agent.busy_until = tick + minutes;
      } else {
        agent.busy_until = tick + act.minutes;
      }
      if (agent.activity === "hang_out" && (this._host_hold.get(agent.id) ?? 0) > tick) {
        agent.busy_until = Math.max(agent.busy_until, this._host_hold.get(agent.id));
        this._host_hold.delete(agent.id);
      }
      // Nothing runs into today's shift (a coffee on the way to work is the player's own risk).
      const start = this._shift_start_tick(agent);
      if (agent.activity !== "work" && agent.activity !== "hospital" && start !== null
        && !agent.plan.some(s => s[0] === "work")) {
        const leave = start - this.commute_minutes(agent) - SHIFT_MARGIN; // as _must_leave_for_work counts it
        agent.busy_until = Math.max(tick + 1, Math.min(agent.busy_until, leave));
      }
      agent.activity_minutes = Math.max(1, agent.busy_until - tick);
      if (agent.activity === "eat_home") {
        const hh = this.household(agent);
        hh.groceries = Math.max(0, hh.groceries - 1);
      }
    }

    _do_activity(agent) {
      const act = ACTIVITIES[agent.activity];
      const minutes = agent.activity_minutes ?? 1;
      let scale = 1.0; // at home, how good the home is scales what an activity gives
      if ((Object.keys(act.gains).length || agent.activity === "sleep") && agent.activity_place === this.home_of(agent)) {
        scale = G.housing.activity_gain_scale(this, agent);
      }
      for (const [need, gain] of Object.entries(act.gains)) agent.adjust(need, (gain > 0 ? gain * scale : gain) / minutes);
      if (agent.activity === "sleep") agent.adjust("energy", 0.17 * scale);
      else if (agent.activity === "hospital") agent.health = Math.min(100.0, agent.health + 0.15);
      else if (agent.activity === "walk_park" && this.clock.tick % 3 === 0) this._wander_park(agent);
      const place = this.town.places.get(agent.activity_place || "");
      if (place && place.hours && agent.activity !== "work" && !place.is_open(this.clock.hour)) {
        agent.busy_until = this.clock.tick; // closing time: everyone out
      }
      if (this.clock.tick >= agent.busy_until) this._end_activity(agent);
    }

    // Nothing is served at a shut place: the money comes back and the outing is off (a shift still stands).
    //
    // closing=true: the place is open but shuts before a paid outing there could be over, which is just as off.
    _find_shut(agent, place, paid, closing = false) {
      const refund = paid ? paid[1] : 0.0;
      if (paid) { // the first stop of the character's own choice: none of what it promised happens either
        this.agents.get(paid[0]).money += refund;
        agent.pending_outcomes = agent.pending_outcomes.filter(p => p.fork !== agent.fork_id);
      }
      this.event(`${agent.name} finds ${place.name} ${closing ? "about to close" : "closed"}`
        + (refund ? ` ($${fmt(refund)} refunded).` : "."), agent, null, { tag: "closed", place: place.id });
      agent.path = [];
      agent.plan = agent.plan.filter(s => s[0] === "work");
      agent.state = "idle";
      agent.activity = !agent.plan.length ? "idle" : agent.activity;
    }

    // The park of the character's walk: the activity's own, else Riverside Park.
    _park_of(agent) {
      const place = this.town.places.get(agent.activity_place || "");
      return place !== undefined && place.kind === "park" ? place : this.town.places.get("park");
    }

    _wander_park(agent) {
      const park = this._park_of(agent);
      const x = agent.x + this.rng.choice([-1, 0, 1]), y = agent.y + this.rng.choice([-1, 0, 1]);
      if (park.x <= x && x < park.x + park.w && park.y <= y && y < park.y + park.h && this.town.walkable(x, y)) {
        agent.x = x;
        agent.y = y;
      }
    }

    _end_activity(agent) {
      if (agent.activity === "work" && agent.job) {
        const hours = (this.clock.tick - (agent.work_started ?? this.clock.tick)) / 60;
        const pay = pyRound(agent.job.hourly_wage * Math.max(0.0, hours) * (1 - income_tax(agent.job.hourly_wage)), 2);
        if (pay) {
          agent.money += pay;
          agent.week_earnings += pay;
        }
        agent.reputation = Math.min(100.0, agent.reputation + 0.5);
      } else if (agent.activity === "buy_groceries") {
        this.household(agent).groceries += 10;
      } else if (agent.activity === "hospital") {
        const payer = this._payer_for(agent, HOSPITAL_FEE);
        payer.money -= HOSPITAL_FEE;
        const by = payer === agent ? "" : ` by ${firstName(payer.name)}`;
        this.event(`${agent.name} leaves City Hospital feeling better (paid $${fmt(HOSPITAL_FEE)}${by}).`,
          agent, null, { tag: "discharged" });
      } else if (agent.activity === "walk_park") {
        [agent.x, agent.y] = this._park_of(agent).entry;
      }
      agent.state = "idle";
      agent.activity = !agent.plan.length ? "idle" : agent.activity;
    }

    _die(agent, how) {
      const place = agent.inside || agent.activity_place; // where it happened, before `inside` is cleared
      agent.alive = false;
      agent.state = "dead";
      agent.activity = "dead";
      agent.plan = [];
      agent.path = [];
      agent.inside = null;
      agent.trip = null;
      agent.riding = null;
      agent.died = { tick: this.clock.tick, time: this.clock.stamp(), how };
      this._withdraw_fork(agent); // nothing is played for the dead
      for (const inv of this.invites.values()) {
        if (inv.from === agent.id && inv.status === "pending") {
          inv.status = "expired";
          const guest = this.agents.get(inv.to);
          const asked = this.forks.get(guest.fork_id || "");
          if (asked && asked.kind === "invite" && getd(asked.options[0].extra, "invite", null) === inv.id) {
            this._withdraw_fork(guest); // the guest can't accept a dead host's invite
          }
        }
      }
      this.event(`${agent.name} ${how}, aged ${agent.age}.`, agent, null, { tag: "death", place });
      for (const [other_id, rel] of agent.relationships) {
        const other = this.agents.get(other_id);
        if (other && other.alive && rel.affinity > 30) {
          other.adjust("fun", -40);
          other.adjust("social", -20);
          other.remember(this.clock.stamp(), `Lost ${agent.name}.`);
        }
      }
      this.household(agent).member_ids = this.household(agent).member_ids.filter(m => m !== agent.id);
      G.housing.on_death(this, agent);
    }

    // Stop asking a character's open fork: nothing is played for it and answers are refused.
    _withdraw_fork(agent) {
      const fork = this.forks.get(agent.fork_id || "");
      if (fork && fork.status === "asked") {
        fork.status = "withdrawn";
        this.stats.count("withdrawn");
        agent.fork_id = null;
        if (agent.state === "deciding") agent.state = agent.activity = "idle"; // the Director finds their next decision
      }
    }

    // --- the Decision Director -------------------------------------------------

    director(agent, fork) {
      const { MAJOR_MARGIN, OBVIOUS_MARGIN, default_scores } = G.forks;
      fork.scores = default_scores(agent, fork, this);
      fork.profile_choice = argmax(fork.scores); // first on ties
      const ranked = fork.scores.slice().sort((a, b) => b - a);
      this.forks.set(fork.id, fork);
      const margin = fork.major ? MAJOR_MARGIN : OBVIOUS_MARGIN; // a move needs a clearer lead than a coffee
      if (ranked[0] - ranked[1] >= margin - 1e-9) {
        this._decide(agent, fork, fork.profile_choice, "habit", "Obvious from the character's habits.");
      } else if (agent.controller) {
        fork.status = "asked";
        fork.controller = agent.controller;
        fork.model = (this.controllers.get(agent.controller) || {}).model ?? null;
        agent.state = "deciding";
        agent.activity = "deciding";
        agent.fork_id = fork.id;
        this.asked_at.set(fork.id, this.now());
        this.stats.count("asked");
        this.outbox.push([agent.controller, this.fork_message(agent, fork)]);
      } else {
        this._decide(agent, fork, this.default_choice(fork), "default", "Played from the character's profile.");
      }
    }

    default_choice(fork) {
      const noisy = fork.scores.map(s => s + this.rng.uniform(0, 0.08));
      return argmax(noisy);
    }

    fork_message(agent, fork) {
      const hh = this.household(agent);
      const options = [];
      fork.options.forEach((opt, i) => {
        let minutes = null;
        const first = opt.steps.length ? opt.steps[0][1] : null;
        const place_id = this._resolve_place(agent, first);
        const mode = hasOwn(G.travel.SPEEDS, opt.vehicle) ? opt.vehicle : "walk";
        if (place_id && agent.inside !== place_id) minutes = this.travel_minutes(agent, place_id, mode);
        if (place_id && agent.job && place_id !== agent.job.place_id && opt.steps.some(s => s[0] === "work")) {
          // A stop on the way to work (a coffee first): the minutes count the leg on to work too.
          minutes = (minutes || 0) + G.travel.leg_minutes(this, place_id, agent.job.place_id, mode);
        }
        options.push(opt.public(i, minutes));
      });
      const here = this.town.places.get(agent.inside || "");
      const needs = {};
      for (const [k, v] of Object.entries(agent.needs)) needs[k] = pyRound(v);
      return {
        type: "fork", fork_id: fork.id, agent_id: agent.id, kind: fork.kind,
        question: fork.question, options, time: this.clock.stamp(),
        deadline_seconds: ANSWER_SECONDS, weather: this.weather, season: this.clock.season,
        profile_scores: fork.scores.slice(),
        you: Object.assign({ name: agent.name, profile: agent.profile.prompt, money: pyRound(agent.money, 2),
          needs, health: pyRound(agent.health),
          where: agent.inside || "outside", groceries_at_home: hh.groceries,
          goal: agent.goal, recent_memory: agent.memory.slice(-5),
          savings: G.rng.r2(agent.savings), where_name: here ? here.name : "outside",
          home_name: this.homes.get(hh.home_id).name }, G.housing.fork_you(this, agent)),
      };
    }

    // A controller's answer. Applies within 5s; within 10s it only teaches the profile.
    answer(fork_id, choice, reason = "", controller = null) {
      const fork = this.forks.get(fork_id);
      if (!fork) return { accepted: false, error: "unknown fork" };
      const agent = this.agents.get(fork.agent_id);
      if (controller !== null && agent.controller !== controller) return { accepted: false, error: "not your character" };
      if (!agent.alive) return { accepted: false, error: "character is dead" };
      if (fork.status === "withdrawn") return { accepted: false, error: "fork withdrawn" };
      if (typeof choice !== "number" || !Number.isInteger(choice) || !(0 <= choice && choice < fork.options.length)) {
        return { accepted: false, error: "choice must be 0 to 3" };
      }
      const elapsed = this.now() - (this.asked_at.has(fork_id) ? this.asked_at.get(fork_id) : this.now());
      if (fork.status === "asked" && elapsed > ANSWER_SECONDS) this._check_timeouts(); // the deadline passed before the next tick noticed
      if (fork.status === "asked" && elapsed <= ANSWER_SECONDS) {
        this._learn(agent, fork, choice, reason);
        this._decide(agent, fork, choice, "model", reason);
        return { accepted: true, applied: true };
      }
      if (fork.status === "decided" && fork.decided_by === "timeout" && elapsed <= LEARN_SECONDS
        && (fork.late_answer ?? null) === null) { // only the first late answer teaches
        this._learn(agent, fork, choice, reason);
        fork.late_answer = { choice, reason };
        this.stats.count("late");
        for (const summary of agent.forks) {
          if (summary.id === fork.id) {
            summary.late = { choice, reason, seconds: _r1(elapsed) };
            if (!this.fork_log.includes(summary)) this.fork_log.push(summary); // sent again, same id, so viewers see the late answer
          }
        }
        return { accepted: true, applied: false, note: "too late to act on; saved to the profile" };
      }
      return { accepted: false, error: "too late" };
    }

    _learn(agent, fork, choice, reason) {
      const opt = fork.options[choice];
      const note = `${fork.kind}: chose '${opt.label}'` + (reason ? ` because ${reason}` : "");
      agent.profile.learn(opt.tags, cut(note, 200));
      if (!agent.profile.prompt_edited) agent.profile.prompt = agent.profile.describe(agent);
    }

    _check_timeouts() {
      const now = this.now();
      for (const [fid, asked] of Array.from(this.asked_at)) {
        const fork = this.forks.get(fid);
        if (fork && fork.status === "asked" && now - asked > ANSWER_SECONDS) {
          const agent = this.agents.get(fork.agent_id);
          this._decide(agent, fork, this.default_choice(fork), "timeout", "No answer in time; played the default.");
        }
        if (now - asked > LEARN_SECONDS) {
          this.asked_at.delete(fid);
          this.forks.delete(fid);
        }
      }
    }

    _decide(agent, fork, choice, by, reason) {
      const opt = fork.options[choice];
      const asked = this.asked_at.has(fork.id) ? this.asked_at.get(fork.id) : null;
      const seconds = asked !== null ? this.now() - asked : null;
      fork.status = "decided";
      fork.choice = choice;
      fork.decided_by = by;
      fork.reason = reason;
      if (!this.asked_at.has(fork.id)) this.forks.delete(fork.id);
      if (!agent.alive) return;
      if (fork.profile_choice === null) { // decided without going through the Director
        fork.scores = fork.scores.length ? fork.scores : G.forks.default_scores(agent, fork, this);
        fork.profile_choice = argmax(fork.scores);
      }
      this.stats.count(G.stats.DECIDED_BY[by], by === "model" && seconds !== null ? seconds : null);
      if (by === "model" && choice !== fork.profile_choice) this.stats.count("against_habit");
      const place = agent.inside || agent.activity_place; // where the character was when it was decided
      const hh = this.household(agent);
      if (!opt.charge) {
        agent.paid = null; // a move pays its own way when it goes through
      } else if (opt.household_pays) {
        if (opt.cost) this.pay_household(hh, opt.cost); // the adults' pooled money and savings
        agent.paid = null; // nothing is handed back to the pool at a shut door
      } else {
        const payer = this._payer_for(agent, opt.cost);
        payer.money -= opt.cost;
        agent.paid = [payer.id, opt.cost]; // handed back if the place is shut
      }
      agent.fork_id = fork.id;
      agent.state = "idle";
      const COOLDOWN = G.forks.COOLDOWN;
      if (hasOwn(COOLDOWN, fork.kind)) agent.cooldowns[fork.kind] = this.clock.tick + COOLDOWN[fork.kind];
      if (opt.steps.some(step => step[0] === "work") || getd(opt.extra, "skip_work", null)) agent.worked_today = this.clock.day;
      this._apply_extra(agent, fork, opt);
      // Roll the hidden outcomes now; most land when the plan is done, some later. Within a group the first hit
      // wins: the group's later outcomes are neither rolled nor logged.
      const hit_groups = new Set();
      for (const out of opt.outcomes) {
        if (out.p <= 0 || (out.group !== null && hit_groups.has(out.group))) continue;
        const p = G.forks.luck_odds(out.p, out.valence, agent.luck);
        const roll = this.rng.random();
        this._log_roll(agent, `${fork.id}:${out.id}`, p, roll, out.p);
        if (roll < p) {
          if (out.group !== null) hit_groups.add(out.group);
          const delay = getd(out.effects, "delay", null);
          agent.pending_outcomes.push({ fork: fork.id, outcome: out, due: delay ? this.clock.tick + delay : null });
        }
      }
      const summary = { id: fork.id, agent: agent.id, kind: fork.kind, tick: this.clock.tick,
        time: this.clock.stamp(), question: fork.question, options: fork.options.map(o => o.label),
        choice, decided_by: by, reason, happened: fork.happened,
        major: fork.major, controller: fork.controller, model: fork.model,
        answer_seconds: by === "model" && seconds !== null ? _r1(seconds) : null,
        late: null, profile_choice: fork.profile_choice, place };
      agent.forks.push(summary);
      keepLast(agent.forks, 20);
      if (by === "model" || by === "timeout") {
        this.llm_log.push(summary);
        keepLast(this.llm_log, LLM_LOG_SIZE);
        agent.llm_forks.push(summary);
        keepLast(agent.llm_forks, AGENT_LLM_FORKS);
        agent.llm_count += 1;
      }
      this.fork_log.push(summary);
      // The choice is paid for and its outcomes rolled, so it happens even if it's now time to leave for work:
      // _begin_activity cuts it short (even once the shift has begun), and _next drops any later steps.
      this.start_plan(agent, opt.steps, opt.vehicle);
    }

    // Give the character a plan and start its first step now; with no steps the Director looks for the next
    // fork. Housing uses it too (moving a household, sending a helper).
    start_plan(agent, steps, vehicle = "walk") {
      const SPEEDS = G.travel.SPEEDS;
      agent.vehicle = hasOwn(SPEEDS, vehicle) ? vehicle : "walk";
      agent.speed = SPEEDS[agent.vehicle];
      agent.plan = steps.map(s => [s[0], s[1]]);
      agent.state = "idle";
      if (agent.plan.length) {
        const [activity, where] = agent.plan.shift();
        this._start_step(agent, activity, where);
      } else {
        this._next(agent);
      }
    }

    _log_roll(agent, what, p, roll, base = null) {
      const entry = { tick: this.clock.tick, agent: agent.id, luck: pyRound(agent.luck, 1), what,
        base_p: base, p: pyRound(p, 4), roll: pyRound(roll, 4), hit: roll < p };
      this.luck_log.push(entry);
      keepLast(this.luck_log, 5000);
      if (typeof this.luck_log_path === "function") this.luck_log_path(JSON.stringify(entry) + "\n");
    }

    _finish_fork(agent) {
      const fid = agent.fork_id;
      agent.fork_id = null;
      const due_now = agent.pending_outcomes.filter(p => p.fork === fid && p.due === null);
      agent.pending_outcomes = agent.pending_outcomes.filter(p => !due_now.includes(p));
      for (const p of due_now) this._apply_outcome(agent, p);
    }

    _apply_due_outcomes(agent) {
      const due = agent.pending_outcomes.filter(p => p.due !== null && p.due <= this.clock.tick);
      if (due.length) {
        agent.pending_outcomes = agent.pending_outcomes.filter(p => !due.includes(p));
        for (const p of due) this._apply_outcome(agent, p);
      }
    }

    _apply_outcome(agent, pending) {
      const out = pending.outcome;
      for (const [key, value] of Object.entries(out.effects)) {
        if (G.agent.NEEDS.includes(key)) {
          agent.adjust(key, value);
        } else if (key === "money") {
          agent.money += value;
        } else if (key === "health") {
          agent.health = Math.max(0.0, Math.min(100.0, agent.health + value));
        } else if (key === "reputation") {
          agent.reputation = Math.max(0.0, Math.min(100.0, agent.reputation + value));
        } else if (key === "memory") {
          agent.remember(this.clock.stamp(), value);
        } else if (key === "meet_new") {
          this._meet_someone(agent);
        } else if (key === "family_bond") {
          for (const m of this.household(agent).member_ids) {
            if (m !== agent.id && agent.relationships.has(m)) {
              agent.relationships.get(m).bump(value);
              const back = this.agents.get(m).relationships.get(agent.id);
              if (back) back.bump(value);
            }
          }
        } else if (key.startsWith(REL)) {
          this._bump(agent, key.slice(REL.length), value);
        } else if (key === "delay") {
          continue; // when it lands, not what it does
        } else {
          G.housing.apply_effect(this, agent, key, value); // home_condition, hh_money, buy, ... (P2)
        }
      }
      const [text, tag, importance] = G.chronicle.outcome_event(agent.name, out.label, out.effects);
      this.event(text, agent, null, { tag, importance });
      for (const summary of agent.forks) {
        if (summary.id === pending.fork) {
          summary.happened.push(out.label);
          if (!this.fork_log.includes(summary)) this.fork_log.push(summary); // sent again, same id, so viewers see what came of it
        }
      }
    }

    _bump(agent, other_id, value) {
      const other = this.agents.get(other_id);
      if (!other) return;
      for (const [a, b] of [[agent, other], [other, agent]]) {
        if (!a.relationships.has(b.id)) a.relate(b.id, G.agent.RelationKind.ACQUAINTANCE, 10);
      }
      const before = agent.relationships.get(other_id).affinity;
      for (const [a, b] of [[agent, other], [other, agent]]) a.relationships.get(b.id).bump(a === agent ? value : value / 2);
      G.chronicle.on_affinity(this, agent.id, other_id, before, agent.relationships.get(other_id).affinity);
    }

    // A first meeting with a stranger of the same age group, drawn from `pool` (Agents or ids) if given.
    _meet_someone(agent, pool = null) {
      const candidates = pool === null ? this.living()
        : pool.map(p => (typeof p === "string" ? this.agents.get(p) ?? null : p));
      const strangers = candidates.filter(a => a !== null && a !== undefined && a.alive && a.id !== agent.id
        && !agent.relationships.has(a.id) && a.is_adult === agent.is_adult);
      if (!strangers.length) return;
      const other = this.rng.choice(strangers);
      agent.relate(other.id, G.agent.RelationKind.ACQUAINTANCE, 15);
      other.relate(agent.id, G.agent.RelationKind.ACQUAINTANCE, 15);
      other.remember(this.clock.stamp(), `Met ${agent.name}.`);
      this.event(`${agent.name} meets ${other.name} for the first time.`, agent, null, { tag: "first_meet",
        agents: [other.id] });
    }

    _apply_extra(agent, fork, opt) {
      const extra = opt.extra;
      if (hasOwn(extra, "invite")) {
        const inv = this.invites.get(extra.invite);
        if (inv) {
          inv.status = extra.answer;
          const host = this.agents.get(inv.from);
          const words = { accept: "accepts", decline: "declines", later: "suggests another day for",
            ignore: "ignores" }[extra.answer];
          this.event(`${agent.name} ${words} ${firstName(host.name)}'s invite.`, agent, null,
            { tag: extra.answer === "accept" ? "invite_accepted" : "invite_declined",
              agents: [host.id], place: inv.place });
          this._deliver(host, { type: "invite_answer", invite_id: inv.id, from: agent.id, answer: extra.answer });
          if (extra.answer === "accept") this._host_waits(host, agent, inv.place);
        }
      }
      if (hasOwn(extra, "invite_to")) {
        const inv = this.invite(agent, extra.invite_to, extra.place);
        if (inv) inv.host_goes = true; // the host is on the way; the invite lapses once they leave
      }
      if (hasOwn(extra, "save") && agent.goal) {
        const amount = Math.min(extra.save, Math.max(agent.money, 0));
        agent.money -= amount;
        agent.goal.saved = pyRound(agent.goal.saved + amount, 2);
        if (agent.goal.saved >= agent.goal.target) {
          this.event(`${agent.name} finally buys ${agent.goal.name} with their savings!`, agent, null,
            { tag: "goal_reached" });
          agent.adjust("fun", 40);
          agent.goal = null;
        } else {
          this.event(`${agent.name} saves $${fmt(amount)} toward ${agent.goal.name} `
            + `($${fmt(agent.goal.saved)} of $${fmt(agent.goal.target)}).`, agent, null, { tag: "saving" });
        }
      } else if (hasOwn(extra, "save")) {
        const amount = Math.min(extra.save, Math.max(agent.money, 0));
        agent.money -= amount;
        agent.savings = pyRound(agent.savings + amount, 2);
        this.event(`${agent.name} puts $${fmt(amount)} into savings ($${fmt(agent.savings)} saved).`, agent, null,
          { tag: "saving" });
      }
      if (hasOwn(extra, "ask_shop")) {
        const other = this.agents.get(extra.ask_shop) ?? null;
        // The market nearest the shopper's home that is open when they get there; it must stay open for the shop.
        const market = other && other.alive ? this.nearest(other, ["market"], this.home_of(other)) : null;
        if (market && this._interruptible(other)
          && !this._must_leave_for_work(other, market.id)
          && this._fits_before_closing(market, ACTIVITIES.buy_groceries.minutes, this.walk_minutes(other, market.id))) {
          const payer = other.money >= GROCERY_COST ? other : agent; // the asker covers it if the shopper can't
          payer.money -= GROCERY_COST;
          other.plan = [["relax_home", "home"]];
          this._start_step(other, "buy_groceries", market.id); // started now so the paid shop happens
          this.event(`${other.name} heads to ${market.name} for ${firstName(agent.name)}.`, other, null, { tag: "errand",
            agents: [agent.id] });
        }
      }
      if (hasOwn(extra, "call")) {
        const other = this.agents.get(extra.call);
        if (other && other.alive) {
          other.adjust("social", 15);
          this.event(`${agent.name} calls ${other.name}.`, agent, null, { tag: "call", agents: [other.id] });
        }
      }
      if (getd(extra, "family", null)) {
        const where = getd(extra, "place", null) || "cafe"; // the family dinner's place
        const family = [];
        for (const m of this.household(agent).member_ids) {
          const other = this.agents.get(m);
          if (other !== agent && other.alive && this._interruptible(other)) {
            other.plan = [["family_dinner", where]];
            other.state = "idle";
            family.push(other.id);
          }
        }
        this.event(`${agent.name} takes the family out to dinner.`, agent, null, { tag: "family_dinner", agents: family,
          place: where });
      }
      G.housing.apply_extra(this, agent, fork, opt); // move, repair, works, belt_tighten, ... (P2)
    }

    // Free to be asked along: idle or doing something leisurely, not asleep, working or deciding.
    _interruptible(other) {
      if (other.state === "idle") return !other.plan.length;
      return other.state === "busy" && LEISURE.includes(other.activity) && !this.on_shift_now(other);
    }

    // An accepted invite: keep the host at the place until the guest has arrived and had some time.
    _host_waits(host, guest, place_id) {
      if (!host.alive) return;
      const hold = this.clock.tick + this.walk_minutes(guest, place_id) + 60;
      if (host.activity === "hang_out" && host.activity_place === place_id) {
        if (host.state === "busy") host.busy_until = Math.max(host.busy_until, hold);
        else this._host_hold.set(host.id, hold);
      } else if (this._interruptible(host)) {
        host.plan = [["hang_out", place_id]];
        host.state = "idle";
        this._host_hold.set(host.id, hold + this.walk_minutes(host, place_id));
        this.event(`${host.name} heads to ${this.town.places.get(place_id).name} to meet ${firstName(guest.name)}.`,
          host, null, { tag: "meetup", agents: [guest.id], place: place_id });
      }
    }

    // --- invites and messages ---------------------------------------------------

    invite(host, guest_id, place_id) {
      const guest = this.agents.get(guest_id);
      if (!host.alive || !guest || guest === host || !guest.alive || !this.town.places.has(place_id)) return null;
      this._invite_ids += 1;
      const inv = { id: `i${this._invite_ids}`, from: host.id, to: guest_id, place: place_id,
        tick: this.clock.tick, status: "pending" };
      this.invites.set(inv.id, inv);
      const place = this.town.places.get(place_id).name;
      this.event(`${host.name} invites ${guest.name} to ${place}.`, host, null, { tag: "invite", agents: [guest_id],
        place: place_id });
      guest.inbox.push({ time: this.clock.stamp(), from: host.id, text: `Want to meet at ${place}?` });
      keepLast(guest.inbox, 30);
      return inv;
    }

    _expire_invites() {
      for (const inv of Array.from(this.invites.values())) {
        if (inv.status === "pending" && this.clock.tick - inv.tick > INVITE_MINUTES) {
          inv.status = "expired";
        } else if (inv.status === "pending" && inv.host_goes) {
          const host = this.agents.get(inv.from);
          if (!host.alive || host.activity !== "hang_out" || host.activity_place !== inv.place) {
            inv.status = "expired"; // the host has already left
          }
        }
        if (inv.status !== "pending" && this.clock.tick - inv.tick > INVITE_MINUTES * 2) this.invites.delete(inv.id);
      }
    }

    send_message(from_id, to_id, text) {
      const a = this.agents.get(from_id), b = this.agents.get(to_id);
      if (!a || !b || !a.alive || !b.alive) return { ok: false, error: "unknown or dead character" };
      if (a === b) return { ok: false, error: "can't message yourself" };
      text = cut(text, 500);
      b.inbox.push({ time: this.clock.stamp(), from: a.id, text });
      keepLast(b.inbox, 30);
      a.adjust("social", 3);
      b.adjust("social", 3);
      this.event(`${a.name} texts ${b.name}: “${cut(text, 80)}”`, a, null, { tag: "text", agents: [b.id] });
      this._deliver(b, { type: "message", from: a.id, from_name: a.name, to: b.id, text, time: this.clock.stamp() });
      return { ok: true };
    }

    _deliver(agent, msg) {
      if (agent.controller) this.outbox.push([agent.controller, Object.assign({}, msg, { agent_id: agent.id })]);
    }

    // --- God's only power, and the character pages -----------------------------

    set_luck(agent_id, luck) {
      const agent = this.agents.get(agent_id);
      if (!agent) return false;
      agent.luck = pyClamp(pyFloat(luck), 0.0, 100.0);
      return true;
    }

    set_profile(agent_id, prompt = null, traits = null) {
      const agent = this.agents.get(agent_id);
      if (!agent) return false;
      // Convert every trait before changing any, so a bad value raises with the profile untouched.
      const isDict = traits !== null && typeof traits === "object" && !Array.isArray(traits);
      const fresh = {};
      for (const [t, v] of Object.entries(isDict ? traits : {})) {
        if (hasOwn(agent.profile.traits, t)) fresh[t] = pyRound(pyClamp(pyFloat(v), 0.0, 1.0), 3);
      }
      Object.assign(agent.profile.traits, fresh);
      if (typeof prompt === "string" && pyStrip(prompt)) {
        agent.profile.prompt = cut(pyStrip(prompt), 1000);
        agent.profile.prompt_edited = true;
      } else if (pyTruthy(traits) && !agent.profile.prompt_edited) {
        agent.profile.prompt = agent.profile.describe(agent);
      }
      return true;
    }

    // --- controllers ------------------------------------------------------------

    claim(agent_id, controller) {
      const agent = this.agents.get(agent_id);
      if (!agent || !agent.alive || (agent.controller && agent.controller !== controller)) return false;
      agent.controller = controller;
      return true;
    }

    // Free a controller's characters (or just one); returns the ids it let go, in cast order.
    release(controller, agent_id = null) {
      const freed = [];
      for (const agent of this.agents.values()) {
        if (agent.controller === controller && (agent_id === null || agent.id === agent_id)) {
          agent.controller = null;
          freed.push(agent.id);
        }
      }
      if (this.controllers.has(controller)) this.controllers.get(controller).characters = this._played_by(controller);
      return freed;
    }

    _played_by(controller) { return Array.from(this.agents.values()).filter(a => a.controller === controller).map(a => a.id); }

    // A controller said hello (or claimed one more character): register it, and tell God in one event.
    controller_joined(name, model, ids) {
      if (!this.controllers.has(name)) this.controllers.set(name, { model: null, characters: [] });
      const entry = this.controllers.get(name);
      if (model !== null && model !== undefined) entry.model = model;
      entry.characters = this._played_by(name);
      if (!ids.length) return null;
      const agent = ids.length === 1 ? this.agents.get(ids[0]) ?? null : null;
      return this.event(`${this._names(ids)} ${ids.length === 1 ? "is" : "are"} now played by ${name}.`, agent, null,
        { tag: "controller_joined", agents: ids.slice(), remember: false });
    }

    // A controller let characters go: all of them when it disconnects (it leaves the registry), or one with a
    // `release` message (importance 0).
    controller_left(name, ids, release = false) {
      if (release) {
        if (this.controllers.has(name)) this.controllers.get(name).characters = this._played_by(name);
      } else {
        this.controllers.delete(name);
      }
      if (!ids.length) return null;
      const agent = ids.length === 1 ? this.agents.get(ids[0]) ?? null : null;
      return this.event(`${this._names(ids)} ${ids.length === 1 ? "is" : "are"} no longer played by ${name}.`,
        agent, null, { tag: "controller_left", importance: release ? 0 : null, agents: ids.slice(), remember: false });
    }

    // Who an event names: "A", "A and B", "A, B and C", or "A, B, C and 57 others".
    _names(ids) {
      const names = ids.map(i => (this.agents.has(i) ? this.agents.get(i).name : i));
      if (names.length <= 2) return names.join(" and ");
      if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
      return `${names.slice(0, 3).join(", ")} and ${names.length - 3} others`;
    }

    // --- snapshots ---------------------------------------------------------------

    // God's map, sent once in `welcome` (PLAN 3.2).
    town_json() {
      return Object.assign(this.town.map_json(), { homes: G.housing.town_homes_json(this),
        housing: G.housing.town_housing_json(), stops: G.transit.stops_json(), timetable: this.timetable() });
    }

    // One `state` frame (PLAN 3.3); with_housing=false leaves out `lots` and `homes` (see housing_maps).
    state_json(with_housing = true) {
      const state = {
        tick: this.clock.tick, time: this.clock.stamp(), minute: this.clock.minute_of_day,
        day: this.clock.day, season: this.clock.season, weather: this.weather,
        lights: this.lights(), plane: this.plane(), buses: this.buses(),
        agents: Array.from(this.agents.values(), a => ({ id: a.id, name: a.name, x: a.x, y: a.y, inside: a.inside,
          state: a.state, activity: a.activity, vehicle: a.vehicle, mood: pyRound(a.mood), luck: pyRound(a.luck),
          controller: a.controller, alive: a.alive, age: a.age,
          home: this.households.get(a.household_id).home_id, car: a.owns_car, riding: a.riding })),
      };
      if (with_housing) Object.assign(state, this.housing_maps());
      return state;
    }

    // The state's `lots` and `homes` maps, which the host sends only when they change (and every 40th frame).
    housing_maps() { return { lots: G.housing.lots_json(this), homes: G.housing.homes_json(this) }; }

    agent_json(agent_id) {
      const a = this.agents.get(agent_id);
      if (!a) return null;
      const hh = this.household(a);
      const needs = {};
      for (const [k, v] of Object.entries(a.needs)) needs[k] = pyRound(v, 1);
      const relationships = {};
      for (const [oid, r] of sortedBy(Array.from(a.relationships), kv => -kv[1].affinity)) {
        relationships[oid] = Object.assign(r.to_json(), { name: this.agents.get(oid).name });
      }
      return Object.assign({
        id: a.id, name: a.name, age: a.age, alive: a.alive, state: a.state,
        activity: a.activity, place: a.activity_place, inside: a.inside, luck: pyRound(a.luck, 1),
        money: pyRound(a.money, 2), health: pyRound(a.health, 1), mood: pyRound(a.mood),
        reputation: pyRound(a.reputation), needs,
        job: a.job ? a.job.to_json() : null, controller: a.controller,
        profile: { prompt: a.profile.prompt, traits: a.profile.traits, edited: a.profile.prompt_edited,
          learned: a.profile.learned },
      }, G.housing.agent_page_fields(this, a), {
        possessions: this.possessions(a),
        relationships,
        memory: a.memory.slice(-15), inbox: a.inbox.slice(-10), forks: a.forks.slice(-10),
        household: hh.member_ids.map(m => this.agents.get(m).name),
      });
    }
  }

  G.sim = {
    ANSWER_SECONDS, LEARN_SECONDS, INVITE_MINUTES, PENSION, BILLS_PER_ADULT, CAR_BILL, HOSPITAL_FEE, GROCERY_COST,
    SHIFT_MARGIN, LEISURE, HISTORY_SIZE, NEWS_SIZE, HEADLINES_SIZE, LLM_LOG_SIZE, AGENT_LLM_FORKS, income_tax,
    Activity, ACTIVITIES, DECAY_SCALE, LIGHT_CYCLE, STOP_AT_LIGHTS, ONE_WAY, BUS_GIVE_UP, FLIGHT_MINUTES, _r1, SimDice,
    Simulation,
  };
})(globalThis.GameOfAILife || (globalThis.GameOfAILife = {}));

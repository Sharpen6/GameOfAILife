// Port of gameofailife/folk_model.py: the townsfolk data model (folk.md 3, amended by PLAN 2.2-2.7): ids,
// constants, FolkHousehold, Trip and Person.
//
// A townsperson is a `Person`, never an `Agent`: it lives in `sim.folk.people` (index `i`, id `"f<i>"`), duck-types
// life.md 3.2's person protocol, and keeps its needs lazily: `_needs` holds the raw needs as of tick `_nt`, and the
// `needs` / `mood` / `adjust` / `x` / `y` read interface settles them to `Person.clock.tick` first. `G.people` is
// read at call time (PLAN 2.16).
(function (G) {
  "use strict";

  const FOLK_DEFAULT = 1000;
  const NS_FOLK = 101, NS_GEN = 102, NS_TOWN = 103, NS_TEXT = 104, NS_STROLL = 105, NS_FOLK_HOME = 106;
  const WALK = 0, DRIVE = 1, WAIT = 2, RIDE = 3; // trip leg kinds (rail.js's)
  const K_WALK = 0, K_CAR = 2, K_AMBULANCE = 5, K_WAIT = 6, K_OUTDOORS = 7; // crowd modes (view.md 4.2)

  const MEMORY_KEEP = 10, CHOICES_KEEP = 5, INBOX_KEEP = 5;
  // Need decay scale by busy activity: sim.py's DECAY_SCALE (folk settle with the same tables).
  const DECAY_SCALE = {
    sleep: { energy: 0.0, hunger: 0.35, social: 0.0, fun: 0.0 },
    work: { social: 0.0, fun: 1.3, hunger: 0.6 },
    hospital: { social: 0.5, fun: 0.5 },
    ward: { social: 0.5, fun: 0.5 }, // life's hospital stay (life._ward_care feeds and heals them hourly)
  };
  // Health as the named have it (sim._decay): hunger at 0 costs HUNGER_HEALTH a minute; every need above WELL_ABOVE
  // heals HEAL a minute up to life.max_health. Person.settle applies both in closed form, so reading a townsperson's
  // needs (a page, the hourly stats) never changes what their health comes to.
  const HUNGER_HEALTH = 0.03, HEAL = 0.004, WELL_ABOVE = 40.0;

  const folk_id = i => `f${i}`;
  const household_id = j => `fh${j}`;

  // Every Household field, so housing's helpers take it unchanged; id "fh<j>", member_ids ["f12", ...].
  class FolkHousehold extends G.agent.Household {
    constructor(id, home_id, weekly_rent, j = -1) {
      super(id, home_id, weekly_rent);
      this.j = j;
      this.gone = false;
      this.dinner_day = -1;
      this.parcel_day = -1000; // the day a food parcel was last remembered (folk.FOOD_PARCEL)
    }
  }

  class Trip {
    constructor(legs, dest, then, until, mode) {
      this.legs = legs; // [[kind, t0, t1, data]]: WALK/DRIVE a roads Route, WAIT a station place id, RIDE a train id
      this.dest = dest;
      this.then = then;
      this.until = until;
      this.mode = mode; // "walk" | "car" | "train" | "ambulance"
    }
  }

  // One townsperson. life.md 3.2's protocol plus folk.md 3's own fields.
  class Person {
    constructor(i, name, age, sex, hh) {
      const { NEEDS, START_LUCK } = G.agent;
      this.i = i;
      this.id = folk_id(i);
      this.name = name;
      this.age = age;
      this.sex = sex; // "f" | "m"
      this.hh = hh;
      this.household_id = household_id(hh);
      this.alive = true;
      this.died = null; // {tick, time, how}
      this.gone = false; // left town
      this.luck = START_LUCK;
      this.health = 90.0;
      this.reputation = 50.0;
      this.money = 0.0;
      this.savings = 0.0;
      this.owns_car = false;
      this.job = null; // agent Job (a folk worker's job.slot is its career board slot); pupils: a "student" Job
      this.inside = null;
      this.activity = "sleep";
      this.activity_place = null;
      this.state = "busy";
      this.relationships = new Map(); // id -> agent Relationship over folk and named ids (people.set_rel)
      this.life = null; // life LifeState, set by life.init
      this.memory = []; // last MEMORY_KEEP lines "stamp: text"
      this.traits = {}; // Profile.TRAITS keys
      this.trip = null; // Trip while travelling
      this.next_tick = 0;
      this.worked_day = -1;
      this.out_day = -1; // the day of their last outing (folk.OUTING_BONUS)
      this.fav = {}; // LEISURE key -> [place ids] nearest first
      this.choices = []; // last CHOICES_KEEP {time ("Day 12 21:45"), kind, options, choice, by}
      this.inbox = []; // last INBOX_KEEP messages
      this.commute = null; // [place, minutes, mode] | null
      this.skill = 0.0; // job matching (generation)
      this.role = "a"; // household role at generation: "a" head or partner, "k" child, "g" grandparent, "s" sharer
      this._needs = {};
      for (const n of NEEDS) this._needs[n] = 75.0;
      this._nt = 0;
    }

    // --- lazy needs ---

    // Bring the raw needs forward to `tick` (default the clock's): v2's per-minute decay by activity, as a closed
    // form (decay only falls, so clamping at the end equals clamping each minute).
    settle(tick = null) {
      if (tick === null || tick === undefined) {
        const clock = Person.clock;
        if (clock === null) return;
        tick = clock.tick;
      }
      const dt = tick - this._nt;
      if (dt <= 0) return;
      this._nt = tick;
      if (!this.alive || this.gone) return; // the dead, and those who left town, keep their last needs
      if (this.age < 5) {
        this._heal(dt); // under-5s are held at 75 by folk.js: always well
        return;
      }
      const { NEEDS, NEED_DECAY } = G.agent;
      const scale = DECAY_SCALE[this.state === "busy" ? this.activity : ""] || {};
      const needs = this._needs;
      let well = dt; // the minutes every need stays above WELL_ABOVE
      let starve = 0.0; // the minutes hunger spends at 0
      for (const n of NEEDS) {
        const v0 = needs[n];
        const rate = NEED_DECAY[n] * (n in scale ? scale[n] : 1.0);
        if (v0 <= WELL_ABOVE) {
          well = 0;
        } else if (rate > 0 && v0 - rate * dt <= WELL_ABOVE) {
          const left = (v0 - WELL_ABOVE) / rate;
          if (left < well) well = left;
        }
        if (n === "hunger" && rate > 0 && v0 - rate * dt < 0) starve = dt - v0 / rate;
        const v = v0 - rate * dt;
        needs[n] = v < 0.0 ? 0.0 : v > 100.0 ? 100.0 : v;
      }
      if (well > 0) this._heal(well);
      if (starve > 0) {
        const h = this.health - HUNGER_HEALTH * starve;
        this.health = h < 0.0 ? 0.0 : h;
      }
    }

    _heal(minutes) {
      const top = G.life.max_health(this);
      if (this.health < top) {
        const h = this.health + HEAL * minutes;
        this.health = h > top ? top : h;
      }
    }

    get needs() {
      this.settle();
      return this._needs;
    }

    adjust(need, delta) {
      this.settle();
      const v = this._needs[need] + delta;
      this._needs[need] = v < 0.0 ? 0.0 : v > 100.0 ? 100.0 : v;
    }

    get mood() {
      this.settle();
      const { NEEDS } = G.agent;
      let total = 0.0;
      for (const n of NEEDS) total += this._needs[n];
      return total / NEEDS.length;
    }

    // [mood, health] exactly as settle(tick) then a read would give them, settling nobody: settle runs on a copy
    // of the raw needs and what it writes (the needs, _nt, health) is put back (see the Python twin).
    peek(tick = null) {
      const needs = this._needs, nt = this._nt, health = this.health;
      this._needs = Object.assign({}, needs);
      try {
        this.settle(tick);
        const { NEEDS } = G.agent;
        const got = this._needs;
        let total = 0.0;
        for (const n of NEEDS) total += got[n];
        return [total / NEEDS.length, this.health];
      } finally {
        this._needs = needs;
        this._nt = nt;
        this.health = health;
      }
    }

    remember(stamp, text) {
      this.memory.push(`${stamp}: ${text}`);
      if (this.memory.length > MEMORY_KEEP) this.memory.splice(0, this.memory.length - MEMORY_KEEP);
    }

    choose(entry) {
      this.choices.push(entry);
      if (this.choices.length > CHOICES_KEEP) this.choices.splice(0, this.choices.length - CHOICES_KEEP);
    }

    get is_adult() { return this.age >= 18; }

    // Alive and still in town.
    get present() { return this.alive && !this.gone; }

    // --- position ---

    // The tile: along the current trip leg, else (folk.js's `Person.locate`, e.g. a park stroll), else the entry of
    // the place they are in or at.
    position(tick = null) {
      if (tick === null || tick === undefined) {
        const clock = Person.clock;
        tick = clock !== null ? clock.tick : 0;
      }
      const trip = this.trip;
      const town = Person.town;
      if (trip !== null && trip.legs.length) {
        let leg = trip.legs[trip.legs.length - 1];
        for (const lg of trip.legs) {
          if (tick < lg[2]) { leg = lg; break; }
        }
        const [kind, t0, , data] = leg;
        if (kind === WALK || kind === DRIVE) {
          let m = tick - t0;
          if (m < 0) m = 0;
          const at = data.at(m);
          return [at[0], at[1]];
        }
        if (kind === WAIT && town !== null && town.places.has(data)) {
          const e = town.places.get(data).entry;
          return [e[0], e[1]];
        }
        if (kind === RIDE && town !== null) {
          const xy = G.rail.train_xy(town, data, tick);
          return [xy[0], xy[1]];
        }
      }
      const fn = Person.locate;
      if (fn !== null) {
        const xy = fn(this, tick);
        if (xy !== null && xy !== undefined) return [xy[0], xy[1]];
      }
      const pid = this.inside !== null ? this.inside : this.activity_place;
      if (town !== null && pid !== null && town.places.has(pid)) {
        const e = town.places.get(pid).entry;
        return [e[0], e[1]];
      }
      return [0, 0];
    }

    get x() { return this.position()[0]; }

    get y() { return this.position()[1]; }

    toString() { return `Person(${this.id}, '${this.name}', ${this.age})`; }
  }
  Person.clock = null; // the simulation's Clock, set by Folk's constructor
  Person.town = null; // the TownMap, set by Folk's constructor (positions)
  Person.locate = null; // optional (p, tick) -> [x, y] | null, set by folk.js (strolls)
  Person.prototype.profile = null; // Agent read interface: no Profile, no controller
  Person.prototype.controller = null;

  // `G.people` (L1), read at call time (PLAN 2.16).
  const people_module = () => G.people;

  G.folk_model = { FOLK_DEFAULT, NS_FOLK, NS_GEN, NS_TOWN, NS_TEXT, NS_STROLL, NS_FOLK_HOME, WALK, DRIVE, WAIT, RIDE,
    K_WALK, K_CAR, K_AMBULANCE, K_WAIT, K_OUTDOORS, MEMORY_KEEP, CHOICES_KEEP, INBOX_KEEP, DECAY_SCALE, HUNGER_HEALTH, HEAL,
    WELL_ABOVE, folk_id,
    household_id, FolkHousehold, Trip, Person, people_module };
})(globalThis.GameOfAILife || (globalThis.GameOfAILife = {}));

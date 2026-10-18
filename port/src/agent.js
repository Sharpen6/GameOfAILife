// Port of gameofailife/agent.py: characters, what they need, own and know, and how they play by default.
(function (G) {
  "use strict";
  const { hasOwn, pyRound, sum, capitalize, keepLast, sortedBy } = G.py;

  const NEEDS = ["hunger", "energy", "social", "fun"];

  // Points lost per game minute while awake.
  const NEED_DECAY = { hunger: 0.09, energy: 0.065, social: 0.035, fun: 0.045 };

  const START_LUCK = 50.0;

  // Python's RelationKind(str, Enum): the values are the strings, so `r.kind.value` is `r.kind` here.
  const RelationKind = { PARTNER: "partner", FAMILY: "family", FRIEND: "friend", COWORKER: "coworker",
    ACQUAINTANCE: "acquaintance", DATING: "dating", EX: "ex", RIVAL: "rival" };

  class Relationship {
    constructor(kind, affinity, trust = 50.0) {
      this.kind = kind;
      this.affinity = affinity; // -100 .. 100
      this.trust = trust;
      this.romance = 0.0; // 0 .. 100, this side's
      this.since = 0; // tick the relationship (or the current kind of it, for dating and partners) began
      this.seen = 0; // tick the two last talked
      this.married = false;
      this.talks = 0; // talks so far
    }

    bump(amount) { this.affinity = Math.max(-100.0, Math.min(100.0, this.affinity + amount)); }

    to_json() { return { kind: this.kind, affinity: pyRound(this.affinity), trust: pyRound(this.trust) }; }
  }

  class Job {
    constructor(title, place_id, hourly_wage, start_hour, end_hour, workdays, slot = -1) {
      this.title = title;
      this.place_id = place_id;
      this.hourly_wage = hourly_wage;
      this.start_hour = start_hour;
      this.end_hour = end_hour;
      this.workdays = workdays; // an array of weekdays (a tuple in Python)
      this.slot = slot; // its slot on career.JobBoard (not in the JSON)
    }

    // On a workday inside the hours; a night shift (end <= start) runs from start to midnight and from midnight to end.
    on_shift(weekday, hour) {
      if (!this.workdays.includes(weekday)) return false;
      if (this.end_hour <= this.start_hour) return this.start_hour <= hour || hour < this.end_hour;
      return this.start_hour <= hour && hour < this.end_hour;
    }

    to_json() {
      return { title: this.title, place: this.place_id, hourly_wage: this.hourly_wage,
        hours: [this.start_hour, this.end_hour], workdays: this.workdays.slice() };
    }
  }

  class Household {
    constructor(id, home_id, weekly_rent) {
      this.id = id;
      this.home_id = home_id; // a home id (housing.Home): a house's place id, or "<block>_<unit>" for a flat
      this.weekly_rent = weekly_rent; // 0 while the household owns its home
      this.groceries = 8; // meals in the fridge
      this.member_ids = [];
      // Housing state, run by housing.js.
      this.cooldowns = {}; // housing fork kind or extra -> tick it may come again
      this.arrears = 0; // Sundays in a row the household ended in the red without recovering
      this.last_funds = null; // funds at the last Sunday charge
      this.grace_until = 0; // tick a granted grace ends
      this.hardship_rent = null; // lowered rent while getting back on their feet
      this.clean_sundays = 0; // Sundays in a row out of the red
      this.tax_deferred = false;
      this.moved_tick = null; // tick of the last move; null = never moved
      this.tight_until = 0; // belt-tightening until this tick
      this.trouble_seen = 0;
      this.history = []; // {tick, time, event, home, name, price}
    }
  }

  const TRAITS = ["thrift", "family", "social", "diligence", "health", "adventure"];
  const TRAIT_WORDS = {
    thrift: ["careful with money", "spends freely"],
    family: ["puts family first", "values independence"],
    social: ["loves company", "enjoys time alone"],
    diligence: ["never late for work", "takes work lightly"],
    health: ["looks after their health", "ignores their health"],
    adventure: ["tries new things", "sticks to routine"],
  };

  // The character's default play style. `traits` drive the Decision Director's default answers; `prompt` is the
  // plain-language version shown on the character page and sent to controllers. Both update as the character's
  // controller makes choices.
  class Profile {
    constructor(traits, prompt = "") {
      this.traits = traits;
      this.prompt = prompt;
      this.prompt_edited = false; // the player wrote the prompt by hand
      this.learned = [];
      this.start = null; // the traits before the first lesson (set then, and by set_traits)
    }

    // One lesson from a controller's choice: every trait first eases DRIFT_DECAY of the way back to its start, then
    // moves by `rate` x its tag, staying within DRIFT_CAP of the start (and within 0-1).
    learn(tags, note, rate = 0.04) {
      if (this.start === null) this.start = Object.assign({}, this.traits);
      for (const [trait, value] of Object.entries(this.traits)) {
        const start = hasOwn(this.start, trait) ? this.start[trait] : value;
        const step = rate * (hasOwn(tags, trait) ? tags[trait] : 0.0);
        const x = start + (value - start) * (1 - Profile.DRIFT_DECAY) + step;
        this.traits[trait] = pyRound(Math.max(0.0, start - Profile.DRIFT_CAP,
          Math.min(1.0, start + Profile.DRIFT_CAP, x)), 3);
      }
      this.learned.push(note);
      keepLast(this.learned, 10);
    }

    // Traits set by hand (set_profile): the new values are where learning starts from from now on.
    set_traits(fresh) {
      Object.assign(this.traits, fresh);
      if (this.start !== null) Object.assign(this.start, fresh);
    }

    describe(agent) {
      const t = this.traits;
      const strong = sortedBy(Object.keys(t), k => Math.abs(t[k] - 0.5), true).slice(0, 4);
      const parts = strong.map(k => (t[k] >= 0.5 ? TRAIT_WORDS[k][0] : TRAIT_WORDS[k][1]));
      const role = agent.job ? agent.job.title : "retired";
      return `${agent.name}, ${agent.age}, ${role}. ` + capitalize(parts.join(", ")) + ".";
    }
  }
  Profile.TRAITS = TRAITS;
  Profile.DRIFT_CAP = 0.25; // learning moves a trait at most this far from where the character started ...
  Profile.DRIFT_DECAY = 0.03; // ... and each lesson first eases every trait this share of the way back there

  // new Agent({id, name, age, household_id, money, job, owns_car, x, y, profile, inside?, savings?}): Python's
  // keyword arguments.
  class Agent {
    constructor(f) {
      this.id = f.id;
      this.name = f.name;
      this.age = f.age;
      this.household_id = f.household_id;
      this.money = f.money;
      this.job = f.job;
      this.owns_car = f.owns_car;
      this.x = f.x;
      this.y = f.y;
      this.profile = f.profile;
      this.inside = f.inside ?? null; // place id when inside a building
      this.luck = START_LUCK;
      this.health = 90.0;
      this.reputation = 50.0; // at work or school
      this.needs = {};
      for (const n of NEEDS) this.needs[n] = 75.0;
      this.relationships = new Map(); // other id -> Relationship, in the order first related
      this.goal = null; // {name, target, saved}
      this.savings = f.savings ?? 0.0; // money put aside on payday with no goal to save for
      this.controller = null; // name of the connected controller, if any
      // Movement and activity state, run by the simulation.
      this.state = "idle"; // idle, deciding, travelling, busy
      this.activity = "idle";
      this.activity_place = null;
      this.busy_until = 0;
      this.path = [];
      this.speed = 1; // tiles per minute while travelling
      this.vehicle = "walk";
      this.plan = []; // remaining [activity, place] steps
      this.fork_id = null; // the fork whose choice is being carried out
      this.alive = true;
      this.cooldowns = {}; // fork kind -> tick it may come up again
      this.pending_outcomes = [];
      this.worked_today = -1; // day number of the last shift started
      this.last_payday = -1;
      this.week_earnings = 0.0;
      this.memory = [];
      this.inbox = [];
      this.forks = []; // recent decided forks
      this.llm_forks = []; // the last 30 decided by a model or timed out
      this.llm_count = 0; // every fork ever decided by a model or timed out (llm_forks keeps only the last 30)
      this.trip = null; // {mode: "bus", line, board, alight, phase, since} while on a bus trip
      this.riding = null; // bus id while on board
      this.died = null; // {tick, time, how}
      this.life = null; // life.LifeState, set by life.init (not in the v2 JSON)
      // Python sets these on the fly (getattr(agent, name, default)); undefined means "not set yet".
      this.paid = undefined; // [payer id, cost] of the choice being carried out
      this.work_started = undefined;
      this.activity_minutes = undefined;
      this.effect_args = undefined; // housing: an effect's companion values between keys
    }

    relate(other_id, kind, affinity) { this.relationships.set(other_id, new Relationship(kind, affinity)); }

    adjust(need, delta) { this.needs[need] = Math.max(0.0, Math.min(100.0, this.needs[need] + delta)); }

    remember(stamp, text) {
      this.memory.push(`${stamp}: ${text}`);
      keepLast(this.memory, 60);
    }

    get is_adult() { return this.age >= 18; }

    get mood() { return sum(Object.values(this.needs)) / Object.keys(this.needs).length; }

    possessions(household, home_name) {
      return {
        home: { place: household.home_id, name: home_name, tenure: "rented", weekly_rent: household.weekly_rent },
        car: this.owns_car,
        phone: { condition: this.goal && this.goal.name.includes("phone") ? "cracked" : "fine" },
        money: pyRound(this.money, 2),
        savings: pyRound(this.savings, 2),
        savings_goal: this.goal,
        groceries_at_home: household.groceries,
      };
    }

    attributes() {
      const needs = {};
      for (const [k, v] of Object.entries(this.needs)) needs[k] = pyRound(v);
      return {
        age: this.age,
        health: pyRound(this.health),
        mood: pyRound(this.mood),
        needs,
        reputation: pyRound(this.reputation),
        job: this.job ? this.job.to_json() : null,
        traits: Object.assign({}, this.profile.traits),
      };
    }
  }

  G.agent = { NEEDS, NEED_DECAY, START_LUCK, RelationKind, Relationship, Job, Household, Profile, Agent };
})(globalThis.GameOfAILife || (globalThis.GameOfAILife = {}));

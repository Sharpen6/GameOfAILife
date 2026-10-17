// Port of gameofailife/stats.py: city statistics: the decision counters now, and God's `stats` push.
//
// One CityStats belongs to each Simulation (`sim.stats`). The simulation counts every fork it asks a
// controller about and how each fork was decided; `today` restarts at midnight, `total` never does.
//
// The counters (COUNTERS, DECIDED_BY, _zeros, avg_seconds, CityStats) are a line-by-line port of the Python
// module. `stats_json` and `decisions` (which P3 adds to stats.py) are a THIN STAND-IN here, written from the
// PLAN 3.8 and 3.9 message shapes and dashboard.md 3.1 and 4 so the browser page has a real `stats` push and
// `get_decisions` reply now. Re-port them line by line from stats.py once P3 lands (see the P5a handoff).
(function (G) {
  "use strict";
  const { sum, sortedBy, count, PyError, pyInt, pyStr } = G.py;

  // The decision counters, as in the `stats.llm.today` and `stats.llm.total` blocks:
  //   asked          forks sent to a controller
  //   in_time        answered within the deadline (count with the answer's seconds)
  //   timeouts       no answer in time: the profile default played
  //   late           answered after the deadline but in time to teach the profile
  //   withdrawn      asked, then withdrawn (the character or the host died)
  //   against_habit  in-time answers that differ from the profile's own first choice
  //   habit, default forks nobody was asked about, decided by habit or by the profile
  const COUNTERS = ["asked", "in_time", "timeouts", "late", "withdrawn", "against_habit", "habit", "default"];

  // A fork summary's `decided_by` -> the counter its decision adds to.
  const DECIDED_BY = { habit: "habit", default: "default", model: "in_time", timeout: "timeouts",
    withdrawn: "withdrawn" };

  // A fresh counter block: every counter at 0, plus `seconds`, the summed seconds of in-time answers.
  function _zeros() {
    const block = {};
    for (const name of COUNTERS) block[name] = 0;
    block.seconds = 0.0;
    return block;
  }

  // Mean seconds of a block's in-time answers to one decimal (floor(x * 10 + 0.5) / 10), or null.
  function avg_seconds(block) {
    if (!block.in_time) return null;
    return Math.floor(block.seconds / block.in_time * 10 + 0.5) / 10;
  }

  // The city's counters (P0) and, from P3, its hourly samples, worth rings and `stats_json`.
  class CityStats {
    constructor() {
      this.today = _zeros(); // since midnight
      this.total = _zeros(); // since the city began
    }

    // Add one to a counter, today and in total. `seconds` goes with `in_time` only: the answer time.
    count(name, seconds = null) {
      if (!COUNTERS.includes(name)) throw new PyError("KeyError", `unknown counter '${name}'; one of ${COUNTERS.join(", ")}`);
      if (seconds !== null && name !== "in_time") throw new PyError("ValueError", "only in_time answers carry seconds");
      for (const block of [this.today, this.total]) {
        block[name] += 1;
        if (seconds !== null) block.seconds += seconds;
      }
    }

    // Midnight: today's counters start again from 0.
    reset_day() { this.today = _zeros(); }

    // Called on every whole game hour, after the agents moved. P0: records nothing; P3 fills it in.
    sample(sim) { return null; }
  }

  // --- THIN STAND-IN for P3's stats_json and decisions (PLAN 3.8, 3.9) ------------------------------------

  const SHOWN_COUNTERS = ["asked", "in_time", "timeouts", "late", "withdrawn", "against_habit"];
  const LOG_DECIDERS = ["model", "timeout"];
  const DECISIONS_LIMIT = 30, DECISIONS_MAX = 100;
  const RECENT_DEATHS = 5;

  const _int = x => Math.floor(x + 0.5); // every stats number: floor(x + 0.5)
  const _mean = xs => (xs.length ? sum(xs) / xs.length : 0.0);
  function median(xs) {
    const s = xs.slice().sort((a, b) => a - b);
    const n = s.length;
    if (!n) return 0.0;
    return n % 2 ? s[Math.floor(n / 2)] : (s[n / 2 - 1] + s[n / 2]) / 2;
  }
  function gini(xs) {
    const s = xs.map(x => Math.max(0.0, x)).sort((a, b) => a - b);
    const n = s.length, total = sum(s);
    if (!n || total <= 0) return 0.0;
    const g = 2 * sum(s.map((x, i) => (i + 1) * x)) / (n * total) - (n + 1) / n;
    return Math.floor(g * 100 + 0.5) / 100;
  }
  function top_share(xs) {
    const s = xs.map(x => Math.max(0.0, x)).sort((a, b) => b - a);
    const total = sum(s);
    if (total <= 0) return 0;
    return _int(100 * sum(s.slice(0, Math.ceil(s.length / 10))) / total);
  }

  // Every living person with their worth parts, richest first, ties by id.
  function _people(sim) {
    const rows = sim.living().map(a => {
      const parts = G.housing.worth_parts(sim, a);
      return { agent: a, cash: parts.cash, savings: parts.savings, home: parts.home,
        worth: parts.cash + parts.savings + parts.home };
    });
    return sortedBy(rows, p => [-p.worth, p.agent.id]);
  }

  function _homes_block(sim) {
    const { stage_of, listed, STAGES } = G.housing;
    const homes = Array.from(sim.homes.values());
    const by_stage = STAGES.map(() => 0);
    const lived_in = new Set(homes.filter(h => h.household !== null).map(h => h.place));
    let neglected = 0;
    for (const [pid, lot] of sim.lots) {
      const st = stage_of(lot.condition);
      by_stage[st] += 1;
      if (st >= 3 && lived_in.has(pid)) neglected += 1;
    }
    const listings = homes.map(h => listed(sim, h));
    return {
      total: homes.length,
      owned: count(homes, h => h.household !== null && h.owner === h.household),
      rented: count(homes, h => h.household !== null && h.owner !== h.household),
      for_sale: count(listings, l => l === "for_sale"), for_rent: count(listings, l => l === "for_rent"),
      lots_by_stage: by_stage, neglected_lived_in: neglected,
    };
  }

  function _city_block(sim, people) {
    const alive = people.map(p => p.agent);
    const adults = alive.filter(a => a.is_adult);
    const dead = Array.from(sim.agents.values()).filter(a => !a.alive);
    const died = sortedBy(dead.filter(a => a.died), a => [-a.died.tick, a.id]).slice(0, RECENT_DEATHS);
    const lucks = alive.map(a => a.luck);
    const adult_worth = people.filter(p => p.agent.is_adult).map(p => p.worth);
    const needs = {};
    for (const n of G.agent.NEEDS) needs[n] = _int(_mean(alive.map(a => a.needs[n])));
    return {
      population: alive.length, start_population: sim.agents.size, deaths: dead.length, births: 0,
      adults: adults.length, children: alive.length - adults.length,
      working: count(alive, a => a.job && a.job.hourly_wage > 0),
      students: count(alive, a => a.job && a.job.hourly_wage <= 0),
      retired: count(alive, a => !a.job && a.age >= 65),
      out_of_work: count(adults, a => !a.job && a.age < 65),
      mood: _int(_mean(alive.map(a => a.mood))), health: _int(_mean(alive.map(a => a.health))), needs,
      wealth: { total: sum(people.map(p => p.worth)), median: _int(median(adult_worth)),
        top10_share: top_share(adult_worth), gini: gini(adult_worth),
        in_debt: count(people, p => p.agent.is_adult && p.cash + p.savings < 0) },
      homes: _homes_block(sim),
      luck: { touched: count(lucks, x => x !== 50), raised: count(lucks, x => x > 50), lowered: count(lucks, x => x < 50),
        mean: _int(_mean(lucks)) },
      recent_deaths: died.map(a => ({ id: a.id, name: a.name, age: a.age, time: a.died.time, how: a.died.how })),
    };
  }

  function _counter_json(block) {
    const out = {};
    for (const k of SHOWN_COUNTERS) out[k] = block[k];
    out.avg_seconds = avg_seconds(block);
    return out;
  }

  function _llm_block(sim) {
    const playing = sim.living().filter(a => a.controller);
    return {
      controllers: Array.from(sim.controllers, ([name, entry]) => ({ name, model: entry.model ?? null,
        characters: count(playing, a => a.controller === name) })),
      playing: playing.length, thinking: count(playing, a => a.state === "deciding"),
      today: _counter_json(sim.stats.today), total: _counter_json(sim.stats.total),
      habit_today: sim.stats.today.habit, default_today: sim.stats.today.default,
    };
  }

  // Every district with at least one home, in town order.
  function _districts(sim, people) {
    const district = new Map(Array.from(sim.town.places.values(), p => [p.id, p.district]));
    const out = [];
    for (const [did, name] of G.town.DISTRICTS) {
      const homes = Array.from(sim.homes.values()).filter(h => district.get(h.place) === did);
      if (!homes.length) continue;
      const here = people.filter(p => district.get(sim.homes.get(sim.households.get(p.agent.household_id).home_id).place) === did);
      out.push({
        id: did, name, people: here.length, mood: _int(_mean(here.map(p => p.agent.mood))),
        median_worth: _int(median(here.filter(p => p.agent.is_adult).map(p => p.worth))),
        homes: homes.length, vacant: count(homes, h => h.household === null),
        shabby_plus: count(Array.from(sim.lots), ([pid, lot]) => district.get(pid) === did && G.housing.stage_of(lot.condition) >= 2),
      });
    }
    return out;
  }

  // The `stats` message (PLAN 3.8). full=true (the God welcome and `get_stats`) carries every kept sample;
  // pushes carry the samples recorded since the previous push. This port keeps no samples yet (CityStats.sample
  // records nothing until P3), so `samples` is [] and `worth_24h` is today's worth.
  function stats_json(sim, full = false) {
    const people = _people(sim);
    return {
      type: "stats", full: Boolean(full), tick: sim.clock.tick, time: sim.clock.stamp(), day: sim.clock.day,
      city: _city_block(sim, people), llm: _llm_block(sim), districts: _districts(sim, people),
      households: Array.from(sim.households.values())
        .filter(hh => hh.member_ids.some(m => sim.agents.get(m).alive))
        .map(hh => G.housing.household_summary(sim, hh)),
      people: people.map(p => ({ id: p.agent.id, household: p.agent.household_id, worth: p.worth, worth_24h: p.worth,
        cash: p.cash, savings: p.savings, home_equity: p.home, job: p.agent.job ? p.agent.job.title : null,
        health: _int(p.agent.health) })),
      samples: [],
    };
  }

  // The `get_decisions` reply (PLAN 3.9): summaries a controller answered or missed, newest first, from the
  // character's ring (30) or the city's (500); `before` is a fork id; `limit` defaults to 30, at most 100.
  // null for an unknown character. In the browser nobody is asked, so the rings stay empty.
  function decisions(sim, agent_id = null, before = null, limit = DECISIONS_LIMIT) {
    if (limit === null || limit === undefined) limit = DECISIONS_LIMIT;
    if (typeof limit !== "number" || !Number.isFinite(limit)) throw new PyError("TypeError", "limit must be a number");
    limit = Math.max(1, Math.min(DECISIONS_MAX, pyInt(limit)));
    if (before !== null && before !== undefined && typeof before !== "string") throw new PyError("TypeError", "before must be a fork id");
    let ring;
    if (agent_id === null || agent_id === undefined) {
      ring = sim.llm_log;
    } else {
      const agent = sim.agents.get(pyStr(agent_id));
      if (!agent) return null;
      ring = agent.llm_forks;
    }
    let forks = ring.slice().reverse().filter(f => LOG_DECIDERS.includes(f.decided_by));
    if (before !== null && before !== undefined) {
      const at = forks.findIndex(f => f.id === before);
      forks = at >= 0 ? forks.slice(at + 1) : [];
    }
    return { type: "decisions", agent_id: agent_id === null || agent_id === undefined ? null : pyStr(agent_id),
      forks: forks.slice(0, limit), more: forks.length > limit };
  }

  G.stats = { COUNTERS, DECIDED_BY, _zeros, avg_seconds, CityStats, stats_json, decisions, median, gini, top_share };
})(globalThis.GameOfAILife || (globalThis.GameOfAILife = {}));

// Port of gameofailife/stats.py: God's `stats` push (PLAN 3.8), its hourly samples, the decision counters and
// the LLM log.
//
// One CityStats belongs to each Simulation (`sim.stats`). The simulation counts every fork it asks a
// controller about and how each fork was decided; `today` restarts at midnight, `total` never does. On every
// whole game hour `sample(sim)` records one sample of the city (7 days are kept), each person's worth (25
// hours are kept, for the 24 h change) and checks who is the richest person in town.
//
// `stats_json(sim, full)` builds the `stats` message and `decisions(sim, ...)` the `get_decisions` reply. Both
// only read the city, never change it, and carry no odds, rolls, scores, outcome tables or valence.
//
// A line-by-line port of the Python module, in its order: every number is rounded with floor(x + 0.5); ties
// sort by id in code-unit order; rings are arrays, oldest first; the worth rings are a Map by agent id. The
// builders read G.housing and G.town when they run, by which time every engine script has loaded.
(function (G) {
  "use strict";
  const { sum, sortedBy, count, commas, keepLast, PyError, pyInt, pyStr } = G.py;

  // The decision counters, as in the `stats.llm.today` and `stats.llm.total` blocks:
  //   asked          forks sent to a controller
  //   in_time        answered within the deadline (count with the answer's seconds)
  //   timeouts       no answer in time: the profile default played
  //   late           answered after the deadline but in time to teach the profile
  //   withdrawn      asked, then withdrawn (the character or the host died)
  //   against_habit  in-time answers that differ from the profile's own first choice
  //   habit, default forks nobody was asked about, decided by habit or by the profile
  const COUNTERS = ["asked", "in_time", "timeouts", "late", "withdrawn", "against_habit", "habit", "default"];
  const SHOWN_COUNTERS = ["asked", "in_time", "timeouts", "late", "withdrawn", "against_habit"]; // in llm.today and total

  // A fork summary's `decided_by` -> the counter its decision adds to.
  const DECIDED_BY = { habit: "habit", default: "default", model: "in_time", timeout: "timeouts",
    withdrawn: "withdrawn" };

  const SAMPLES_KEPT = 168; // hourly samples: 7 game days
  const WORTH_HOURS = 25; // each person's worth at the last 25 whole hours, so the oldest is 24 hours ago
  const RICHEST_GAIN = 0.02, RICHEST_MARGIN = 50; // a challenger needs the richest person's worth x 1.02 + $50 to take over
  const TOWN = "Millbrook";
  const RECENT_DEATHS = 5;
  const LOG_DECIDERS = ["model", "timeout"]; // the LLM log: forks a controller was asked about and answered or missed
  const DECISIONS_LIMIT = 30, DECISIONS_MAX = 100; // get_decisions: forks per page by default, and at most

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

  // --- number rules ------------------------------------------------------------------------------------------

  // Portable rounding to an integer: floor(x + 0.5), as JS Math.round.
  const _int = x => Math.floor(x + 0.5);

  // The mean, or 0 for an empty list.
  const _mean = xs => (xs.length ? sum(xs) / xs.length : 0.0);

  // The middle value; the mean of the two middle values for an even count; 0 for none.
  function median(xs) {
    const s = xs.slice().sort((a, b) => a - b);
    const n = s.length;
    if (!n) return 0.0;
    return n % 2 ? s[Math.floor(n / 2)] : (s[n / 2 - 1] + s[n / 2]) / 2;
  }

  // The Gini coefficient to two decimals, negatives clipped to 0: 2 * sum(i * x_i) / (n * sum x) - (n + 1) / n
  // with x ascending and i from 1. 0 when nobody has anything.
  function gini(xs) {
    const s = xs.map(x => Math.max(0.0, x)).sort((a, b) => a - b);
    const n = s.length, total = sum(s);
    if (!n || total <= 0) return 0.0;
    const g = 2 * sum(s.map((x, i) => (i + 1) * x)) / (n * total) - (n + 1) / n;
    return Math.floor(g * 100 + 0.5) / 100;
  }

  // Percent of the positive wealth held by the richest ceil(n / 10): 0 when nobody has anything.
  function top_share(xs) {
    const s = xs.map(x => Math.max(0.0, x)).sort((a, b) => b - a);
    const total = sum(s);
    if (total <= 0) return 0;
    const k = Math.ceil(s.length / 10);
    return _int(100 * sum(s.slice(0, k)) / total);
  }

  const _money = x => `${x < 0 ? "−" : ""}$${commas(Math.abs(x))}`;

  // --- who is who ----------------------------------------------------------------------------------------------

  // One living person's worth parts, in whole dollars (housing.worth_parts).
  class _Person {
    constructor(sim, agent, parts) {
      this.agent = agent;
      this.cash = parts.cash;
      this.savings = parts.savings;
      this.home = parts.home;
      this.worth = this.cash + this.savings + this.home;
    }
  }

  // Every living person, richest first, ties by id.
  function _people(sim) {
    const rows = sim.living().map(a => new _Person(sim, a, G.housing.worth_parts(sim, a)));
    return sortedBy(rows, p => [-p.worth, p.agent.id]);
  }

  const _district_of_place = sim => new Map(Array.from(sim.town.places.values(), p => [p.id, p.district]));

  // Residential place id -> its homes (one for a house, six for a block of flats).
  function _homes_at(sim) {
    const out = new Map();
    for (const h of sim.homes.values()) {
      if (!out.has(h.place)) out.set(h.place, []);
      out.get(h.place).push(h);
    }
    return out;
  }

  // --- the stats message (PLAN 3.8) -----------------------------------------------------------------------------

  function _wealth_block(people) {
    const adults = people.filter(p => p.agent.is_adult).map(p => p.worth);
    return { total: sum(people.map(p => p.worth)), median: _int(median(adults)), top10_share: top_share(adults),
      gini: gini(adults),
      in_debt: count(people, p => p.agent.is_adult && p.cash + p.savings < 0) };
  }

  function _homes_block(sim) {
    const { STAGES, stage_of, listed } = G.housing;
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
    return { total: homes.length,
      owned: count(homes, h => h.household !== null && h.owner === h.household),
      rented: count(homes, h => h.household !== null && h.owner !== h.household),
      for_sale: count(listings, l => l === "for_sale"), for_rent: count(listings, l => l === "for_rent"),
      lots_by_stage: by_stage, neglected_lived_in: neglected };
  }

  function _city_block(sim, people) {
    const alive = people.map(p => p.agent);
    const adults = alive.filter(a => a.is_adult);
    const dead = Array.from(sim.agents.values()).filter(a => !a.alive);
    const died = sortedBy(dead.filter(a => a.died), a => [-a.died.tick, a.id]).slice(0, RECENT_DEATHS);
    const lucks = alive.map(a => a.luck);
    const needs = {};
    for (const n of ["hunger", "energy", "social", "fun"]) needs[n] = _int(_mean(alive.map(a => a.needs[n])));
    return {
      population: alive.length, start_population: sim.agents.size, deaths: dead.length, births: 0, // nobody is born yet
      adults: adults.length, children: alive.length - adults.length,
      working: count(alive, a => a.job && a.job.hourly_wage > 0),
      students: count(alive, a => a.job && a.job.hourly_wage <= 0),
      retired: count(alive, a => !a.job && a.age >= 65),
      out_of_work: count(adults, a => !a.job && a.age < 65),
      mood: _int(_mean(alive.map(a => a.mood))), health: _int(_mean(alive.map(a => a.health))),
      needs,
      wealth: _wealth_block(people),
      homes: _homes_block(sim),
      luck: { touched: count(lucks, x => x !== 50), raised: count(lucks, x => x > 50),
        lowered: count(lucks, x => x < 50), mean: _int(_mean(lucks)) },
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
    const alive = sim.living();
    const playing = alive.filter(a => a.controller);
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
    const district = _district_of_place(sim);
    const out = [];
    for (const [did, name] of G.town.DISTRICTS) {
      const homes = Array.from(sim.homes.values()).filter(h => district.get(h.place) === did);
      if (!homes.length) continue;
      const here = people.filter(p =>
        district.get(sim.homes.get(sim.households.get(p.agent.household_id).home_id).place) === did);
      out.push({
        id: did, name, people: here.length, mood: _int(_mean(here.map(p => p.agent.mood))),
        median_worth: _int(median(here.filter(p => p.agent.is_adult).map(p => p.worth))),
        homes: homes.length, vacant: count(homes, h => h.household === null),
        shabby_plus: count(sim.lots, ([pid, lot]) => district.get(pid) === did
          && G.housing.stage_of(lot.condition) >= 2),
      });
    }
    return out;
  }

  // Every household with a living member, in creation order (housing.household_summary rows).
  function _households(sim) {
    return Array.from(sim.households.values())
      .filter(hh => hh.member_ids.some(m => sim.agents.get(m).alive))
      .map(hh => G.housing.household_summary(sim, hh));
  }

  function _people_rows(sim, people) {
    const rings = sim.stats.worth;
    const rows = [];
    for (const p of people) {
      const a = p.agent;
      const ring = rings.get(a.id);
      rows.push({ id: a.id, household: a.household_id, worth: p.worth,
        worth_24h: ring && ring.length ? ring[0] : p.worth, cash: p.cash, savings: p.savings,
        home_equity: p.home, job: a.job ? a.job.title : null, health: _int(a.health),
        llm: a.llm_count });
    }
    return rows;
  }

  // The `stats` message (PLAN 3.8).
  //
  // full=true (the God welcome and `get_stats`) carries every kept sample. full=false is the push: it carries
  // the samples recorded since the previous push, and each sample goes in one push only.
  function stats_json(sim, full = false) {
    const people = _people(sim);
    const samples = full ? sim.stats.samples.slice() : sim.stats.take_new_samples();
    return { type: "stats", full: Boolean(full), tick: sim.clock.tick, time: sim.clock.stamp(),
      day: sim.clock.day, city: _city_block(sim, people), llm: _llm_block(sim),
      districts: _districts(sim, people), households: _households(sim),
      people: _people_rows(sim, people), samples };
  }

  // --- the LLM log ----------------------------------------------------------------------------------------------

  // The `get_decisions` reply: decided fork summaries a controller answered or missed, newest first.
  //
  // With agent_id, that character's ring (the last 30); otherwise the city's (the last 500). `before` is a
  // fork id: only forks older than it (none when it is not in the ring, which only ever drops the oldest).
  // `limit` defaults to 30 and is held to 1-100. `more` says whether older forks remain. null for an unknown
  // character.
  function decisions(sim, agent_id = null, before = null, limit = DECISIONS_LIMIT) {
    if (limit === null || limit === undefined) limit = DECISIONS_LIMIT;
    if (typeof limit !== "number" || !Number.isFinite(limit)) throw new PyError("TypeError", "limit must be a number");
    limit = Math.max(1, Math.min(DECISIONS_MAX, pyInt(limit)));
    if (before !== null && before !== undefined && typeof before !== "string") {
      throw new PyError("TypeError", "before must be a fork id");
    }
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

  // --- the counters, samples and rings ----------------------------------------------------------------------------

  // The city's decision counters, hourly samples, worth rings and the richest person's title.
  class CityStats {
    constructor() {
      this.today = _zeros(); // since midnight
      this.total = _zeros(); // since the city began
      this.samples = []; // the last SAMPLES_KEPT hourly samples, oldest first
      this.worth = new Map(); // agent id -> worth at the last WORTH_HOURS samples, oldest first
      this.richest = null; // who holds the title
      this._richest_known = false; // the first sample records the leader without a headline
      this._pushed = -1; // the tick of the newest sample a push has carried
      this._hour_asked = 0; // total asked and in_time at the previous sample
      this._hour_in_time = 0;
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

    // Midnight: today's counters start again from 0, except `asked`, which starts at the forks asked before
    // midnight and still open. They are decided today, so today keeps asked >= in_time + timeouts + withdrawn
    // (dashboard.md 6.2). The totals know how many: every ask ends in time, timed out or withdrawn.
    reset_day() {
      const t = this.total;
      this.today = _zeros();
      this.today.asked = Math.max(0, t.asked - t.in_time - t.timeouts - t.withdrawn);
    }

    // The samples recorded since the last call, oldest first; each one is handed out once.
    take_new_samples() {
      const nw = this.samples.filter(s => s.tick > this._pushed);
      if (nw.length) this._pushed = nw[nw.length - 1].tick;
      return nw;
    }

    // Called on every whole game hour, after the agents moved: one sample of the city, everyone's worth for
    // the 24 h change, and the richest person check. A city with nobody in it records nothing.
    sample(sim) {
      if (!sim.agents || !sim.agents.size) return null;
      const people = _people(sim);
      const city = _city_block(sim, people);
      const homes = city.homes;
      this.samples.push({
        tick: sim.clock.tick, day: sim.clock.day, pop: city.population, mood: city.mood,
        health: city.health, wealth: city.wealth.total, median: city.wealth.median,
        top10: city.wealth.top10_share, in_debt: city.wealth.in_debt, working: city.working,
        owned: homes.owned, shabby_plus: sum(homes.lots_by_stage.slice(2)),
        asked: this.total.asked - this._hour_asked, in_time: this.total.in_time - this._hour_in_time,
      });
      keepLast(this.samples, SAMPLES_KEPT);
      this._hour_asked = this.total.asked;
      this._hour_in_time = this.total.in_time;
      for (const p of people) {
        if (!this.worth.has(p.agent.id)) this.worth.set(p.agent.id, []);
        const ring = this.worth.get(p.agent.id);
        ring.push(p.worth);
        keepLast(ring, WORTH_HOURS);
      }
      this._check_richest(sim, people.filter(p => p.agent.is_adult));
      return null;
    }

    // A new richest adult makes a headline (God-only), with hysteresis: a challenger takes the title only with
    // at least RICHEST_GAIN more worth plus RICHEST_MARGIN, or when the title holder has died.
    _check_richest(sim, adults) {
      if (!adults.length) return;
      const top = adults[0];
      if (!this._richest_known) {
        this._richest_known = true;
        this.richest = top.agent.id;
        return;
      }
      const holder = adults.find(p => p.agent.id === this.richest) ?? null;
      if (holder === top) return;
      if (holder !== null && top.worth < holder.worth * (1 + RICHEST_GAIN) + RICHEST_MARGIN) return;
      const behind = holder !== null ? holder : (adults.length > 1 ? adults[1] : null);
      this.richest = top.agent.id;
      let text = `${top.agent.name} is now the richest person in ${TOWN} (${_money(top.worth)})`;
      text += behind !== null ? `, ahead of ${behind.agent.name}.` : ".";
      sim.event(text, top.agent, null, { tag: "richest", agents: behind !== null ? [behind.agent.id] : null,
        remember: false });
    }
  }

  G.stats = {
    COUNTERS, SHOWN_COUNTERS, DECIDED_BY, SAMPLES_KEPT, WORTH_HOURS, RICHEST_GAIN, RICHEST_MARGIN, TOWN,
    RECENT_DEATHS, LOG_DECIDERS, DECISIONS_LIMIT, DECISIONS_MAX, _zeros, avg_seconds, _int, _mean, median, gini,
    top_share, _money, _Person, _people, _district_of_place, _homes_at, _wealth_block, _homes_block, _city_block,
    _counter_json, _llm_block, _districts, _households, _people_rows, stats_json, decisions, CityStats,
  };
})(globalThis.GameOfAILife || (globalThis.GameOfAILife = {}));

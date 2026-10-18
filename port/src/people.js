// Port of gameofailife/people.py: the one person contract (life.md 3.2, PLAN 2.2) for the named and the townsfolk.
// Named prompts queue in agent.life.pending (prompt) and are built by pending_fork through PROMPTS[kind]; an option's
// extra.life goes to HANDLERS[fork.kind], outcome keys starting with "life_" to EFFECTS.
(function (G) {
  "use strict";
  const { hasOwn, pyRound } = G.py;

  const FOLK_NEWS_CAP = 60; // notable events about townsfolk alone a game day; the 61st on is dropped
  const PROMPT_MAX = 3; // prompts queued at once (one per kind)
  const PROMPT_DAYS = 2; // ... dropped after this many game days unasked
  const REL_CAP = 60; // relationships a person keeps (social's upkeep enforces it)

  // The 60 named characters' sex, for romance (life.md 5.3): the fixed cast, then every name cast.js can draw.
  const NAMED_SEX = {
    dana: "f", yossi: "m", noa: "f", miriam: "f", tom: "m", ari: "m", avi: "m", rina: "f",
    lior: "m", maya: "f", eli: "m", shira: "f", ruth: "f", david: "m", omer: "m", gal: "f",
    yael: "f", nadia: "f", sami: "m", leila: "f",
    // cast.FEMALE
    adi: "f", tamar: "f", noga: "f", hila: "f", michal: "f", yarden: "f", shani: "f", ronit: "f",
    dalia: "f", orly: "f", sara: "f", hana: "f", rana: "f", amira: "f", lina: "f", talia: "f",
    inbal: "f", keren: "f", liat: "f", efrat: "f", mor: "f", neta: "f", yasmin: "f", rotem: "f",
    avigail: "f", merav: "f", sivan: "f", galit: "f", dina: "f", lea: "f",
    // cast.MALE
    itai: "m", yoni: "m", amir: "m", nir: "m", guy: "m", ido: "m", roee: "m", eitan: "m",
    uri: "m", moshe: "m", rami: "m", karim: "m", fadi: "m", omar: "m", ziv: "m", erez: "m",
    boaz: "m", ronen: "m", shai: "m", gil: "m", asaf: "m", dror: "m", yuval: "m", noam: "m",
    tomer: "m", hadi: "m", elad: "m", yaniv: "m", oren: "m", ben: "m",
  };

  const PROMPTS = {}; // prompt kind -> builder(sim, agent, ctx) -> Fork | null
  const HANDLERS = {}; // fork kind -> handler(sim, agent, fork, opt, value) for an option's extra.life
  const EFFECTS = {}; // outcome key ("life_rel", "life_rom", ...) -> fn(sim, agent, value)

  // --- ids and lookups ---------------------------------------------------------------------------------------------

  // A townsperson's id: "f" followed by digits. Named ids hold no digits.
  const is_folk_id = x => typeof x === "string" && x.length > 1 && x[0] === "f" && /^[0-9]+$/.test(x.slice(1));

  // The index in Folk.people of a townsperson's id ("f17" -> 17).
  const folk_index = pid => parseInt(pid.slice(1), 10);

  const _folk = sim => (sim.folk !== undefined && sim.folk !== null ? sim.folk : _NOBODY);

  // The behaviour dice's seed: sim.dice_seed, else the city's seed.
  const dice_seed = sim => (sim.dice_seed === undefined || sim.dice_seed === null ? sim.seed : sim.dice_seed);

  // sim.agents[pid], else sim.folk.person(pid), else null.
  function person(sim, pid) {
    const a = sim.agents.get(pid);
    if (a !== undefined) return a;
    if (is_folk_id(pid)) return _folk(sim).person(pid);
    return null;
  }

  function household_by_id(sim, hid) {
    const hh = sim.households.get(hid);
    if (hh !== undefined) return hh;
    return _folk(sim).household(hid);
  }

  // The full name, or the id itself for nobody known.
  function name_of(sim, pid) {
    const p = person(sim, pid);
    return p !== null && p !== undefined ? p.name : pid;
  }

  // The living named in cast order, then the living townsfolk by index.
  const everyone = sim => [...Array.from(sim.agents.values()).filter(a => a.alive), ..._folk(sim).living()];

  const is_named = p => !is_folk_id(p.id);

  // Townsfolk exist and are not isolated: named rooms, romance and lending may take them in.
  function mixed(sim) {
    const folk = _folk(sim);
    return folk.n > 0 && !folk.isolated;
  }

  const isolated = sim => _folk(sim).isolated;

  const traits = p => (p.profile !== null && p.profile !== undefined ? p.profile.traits : p.traits);

  function sex(p) {
    let s = hasOwn(NAMED_SEX, p.id) ? NAMED_SEX[p.id] : undefined;
    if (s === undefined) s = p.sex || "f";
    return s;
  }

  const household = (sim, p) => household_by_id(sim, p.household_id);

  // The home unit: "cedar_court_1b", "main_20", a folk home; null without a household.
  function home_id(sim, p) {
    const hh = household(sim, p);
    return hh !== null && hh !== undefined ? hh.home_id : null;
  }

  // The living people of p's household, p included.
  function members(sim, p) {
    const hh = household(sim, p);
    if (hh === null || hh === undefined) return p.alive ? [p] : [];
    const out = [];
    for (const m of hh.member_ids) {
      const q = person(sim, m);
      if (q !== null && q !== undefined && q.alive) out.push(q);
    }
    return out;
  }

  // A townsperson's lazy needs brought forward to now; an Agent needs nothing.
  function settle(sim, p) {
    if (is_folk_id(p.id)) p.settle(sim.clock.tick);
  }

  // --- relationships -----------------------------------------------------------------------------------------------

  const rel = (p, oid) => p.relationships.get(oid) ?? null;

  const REL_FIELDS = ["trust", "romance", "since", "seen", "married", "talks"];

  // Both sides of a relationship, created or overwritten: a's toward b at `affinity`, b's toward a at `affinity_b`
  // (default the same). `fields` ({trust, romance, since, seen, married, talks}) go on both sides.
  function set_rel(sim, a_id, b_id, kind, affinity, affinity_b = null, fields = {}) {
    const a = person(sim, a_id), b = person(sim, b_id);
    if (a === null || a === undefined || b === null || b === undefined || a === b) return;
    const make = aff => {
      const r = new G.agent.Relationship(kind, aff, hasOwn(fields, "trust") ? fields.trust : 50.0);
      for (const f of REL_FIELDS) if (f !== "trust" && hasOwn(fields, f)) r[f] = fields[f];
      return r;
    };
    a.relationships.set(b_id, make(affinity));
    b.relationships.set(a_id, make(affinity_b === null || affinity_b === undefined ? affinity : affinity_b));
  }

  // One relationship row for pages and the server's "relationships" answer (no odds, no chemistry).
  function rel_row(sim, oid, r) {
    return Object.assign({ id: oid, name: name_of(sim, oid), named: !is_folk_id(oid) }, r.to_json(),
      { romance: pyRound(r.romance), married: r.married });
  }

  // --- hidden odds and the news cap --------------------------------------------------------------------------------

  // One luck-shifted roll (life.md 5.11): [tick, id, luck, what, p, roll] into sim.life.luck_log (named) or
  // sim.folk.luck_log (rings of 5000); with a luck log writer, also as v2's JSON lines once each game hour.
  function log_roll(sim, p, what, prob, roll) {
    const tick = sim.clock.tick;
    const row = [tick, p.id, p.luck, what, prob, roll];
    const owner = is_folk_id(p.id) ? sim.folk : sim.life;
    const log = owner !== undefined && owner !== null ? owner.luck_log : undefined;
    if (log !== undefined && log !== null) {
      log.push(row);
      if (log.length > 5000) log.splice(0, log.length - 5000);
    }
    if (typeof sim.luck_log_path === "function") {
      if (sim._luck_rows === undefined) sim._luck_rows = [Math.floor(tick / 60), []];
      if (sim._luck_rows[0] !== Math.floor(tick / 60)) {
        flush_luck_log(sim);
        sim._luck_rows[0] = Math.floor(tick / 60);
      }
      sim._luck_rows[1].push(row);
    }
  }

  function flush_luck_log(sim) {
    const buf = sim._luck_rows;
    if (!buf || !buf[1].length || typeof sim.luck_log_path !== "function") return;
    sim.luck_log_path(buf[1].map(([t, pid, luck, what, prob, roll]) => JSON.stringify({ tick: t, agent: pid,
      luck: pyRound(luck, 1), what, base_p: null, p: pyRound(prob, 4), roll: pyRound(roll, 4), hit: roll < prob }) + "\n").join(""));
    buf[1].length = 0;
  }

  // sim.event's first line (PLAN 2.8): false drops the event. A notable event (importance 1+) about townsfolk alone
  // (it names a townsperson and no named) counts in sim.life.today.folk_news; from the 61st of the day it is dropped.
  function news_gate(sim, tag, importance, agent, agents) {
    importance = importance === null || importance === undefined ? G.chronicle.EVENT_TAGS[tag][1] : importance;
    if (importance < 1) return true;
    let folk_seen = false;
    if (agent !== null && agent !== undefined) {
      if (!is_folk_id(agent.id)) return true;
      folk_seen = true;
    }
    for (const x of agents || []) {
      if (!is_folk_id(x)) return true;
      folk_seen = true;
    }
    if (!folk_seen) return true;
    const today = sim.life !== undefined && sim.life !== null ? sim.life.today : undefined;
    if (today === undefined || today === null) {
      const day = sim.clock.day;
      if (sim._folk_news === undefined || sim._folk_news[0] !== day) sim._folk_news = [day, 0];
      sim._folk_news[1] += 1;
      return sim._folk_news[1] <= FOLK_NEWS_CAP;
    }
    const day = sim.clock.day;
    if (sim._folk_news_day !== day) { // a new game day, whoever clears sim.life.today
      sim._folk_news_day = day;
      if (today instanceof Map) today.set("folk_news", 0); else today.folk_news = 0;
    }
    const n = (today instanceof Map ? (today.get("folk_news") || 0) : (today.folk_news || 0)) + 1;
    if (today instanceof Map) today.set("folk_news", n); else today.folk_news = n;
    return n <= FOLK_NEWS_CAP;
  }

  // --- choices: named prompts and settled folk choices -------------------------------------------------------------

  // Queue a named prompt (life.md 6): at most PROMPT_MAX, one per kind, dropped after PROMPT_DAYS unasked.
  function prompt(sim, agent, kind, ctx) {
    if (is_folk_id(agent.id) || !agent.alive) return false;
    const pending = agent.life !== null && agent.life !== undefined ? agent.life.pending : undefined;
    if (pending === undefined || pending === null) return false;
    for (const q of pending) if (q.kind === kind) return false;
    if (pending.length >= PROMPT_MAX) return false;
    pending.push({ kind, ctx, tick: sim.clock.tick });
    return true;
  }

  const _urgency = level => ((100 - level) / 100) ** 2;

  // A choice settled at once, without a fork: argmax(base + .6 style + need + afford + U(0, .08)), SETTLE stream.
  function settle_choice(sim, p, kind, options) {
    const t = traits(p);
    const needs = p.needs;
    const rr = G.dice.stream(dice_seed(sim), G.dice.SETTLE, p.id, kind, sim.clock.tick);
    let best = 0, best_score = null;
    options.forEach((opt, i) => {
      let style = 0.0;
      for (const [k, v] of Object.entries(opt.tags)) style += ((hasOwn(t, k) ? t[k] : 0.5) - 0.5) * 2 * v;
      let need = 0.0;
      for (const [n, g] of Object.entries(opt.gains)) if (hasOwn(needs, n)) need += _urgency(needs[n]) * g / 25;
      const afford = is_folk_id(p.id) ? (opt.cost > p.money + p.savings ? -1.0 : 0.0) : G.housing.afford_score(sim, p, opt);
      const score = opt.base + 0.6 * style + need + afford + rr.uniform(0, 0.08);
      if (best_score === null || score > best_score) { best = i; best_score = score; }
    });
    return best;
  }

  function _awake_and_free(sim, agent) {
    if (!agent.alive || agent.state === "deciding" || ["sleep", "hospital", "ward"].includes(agent.activity)) return false;
    if (agent.inside === "hospital") return false;
    return !sim.on_shift_now(agent);
  }

  // The oldest queued prompt built as a fork (forks.BUILDERS, after sleep_fork), when the person is awake, off shift,
  // not deciding and not in hospital. Stale prompts and ones whose builder declines go.
  function pending_fork(sim, agent) {
    const pending = agent.life !== null && agent.life !== undefined ? agent.life.pending : undefined;
    if (!pending || !pending.length) return null;
    const tick = sim.clock.tick;
    const keep = pending.filter(q => tick - q.tick <= PROMPT_DAYS * 1440 && hasOwn(PROMPTS, q.kind));
    pending.length = 0;
    pending.push(...keep);
    if (!pending.length || !_awake_and_free(sim, agent)) return null;
    while (pending.length) {
      const q = pending.shift();
      const fork = PROMPTS[q.kind](sim, agent, q.ctx);
      if (fork !== null && fork !== undefined) {
        fork.major = true;
        return fork;
      }
    }
    return null;
  }

  // sim._apply_extra's last line: an option's extra.life goes to HANDLERS[fork.kind].
  function apply_extra(sim, agent, fork, opt) {
    if (!hasOwn(opt.extra, "life")) return;
    const value = opt.extra.life;
    if (value === null || value === undefined) return;
    if (hasOwn(HANDLERS, fork.kind)) HANDLERS[fork.kind](sim, agent, fork, opt, value);
  }

  // sim._apply_outcome: true when `key` is one of life's outcome keys (and it was applied).
  function apply_effect(sim, agent, key, value) {
    if (!hasOwn(EFFECTS, key)) return false;
    EFFECTS[key](sim, agent, value);
    return true;
  }

  // --- townsfolk -----------------------------------------------------------------------------------------------------

  // sim.folk while there are no townsfolk (folk 0): every method of PLAN 2.3 as a no-op.
  class NoFolk {
    constructor() {
      this.n = 0;
      this.isolated = false;
      this.v = 0;
      this.luck_log = [];
    }

    person(pid) { return null; }
    get(pid) { return null; }
    living() { return []; }
    present(place_id) { return []; }
    crowd(sim) { return []; }
    occ() { return []; }
    riders(tick) { return {}; }
    commute_minutes(p, place_id) { return null; }
    tick(sim) {}
    nightly(sim) {}
    pensions(sim) {}
    weekly(sim) {}
    stats_json(sim) { return null; }
    city_parts(sim) { return {}; }
    sample_hour(sim) {}
    roster_rows(sim) { return []; }
    page_json(sim, fid) { return null; }
    set_luck(fid, luck) { return false; }
    worth(sim, p) { return 0; }
    household(hid) { return null; }
    new_household(member_ids, home_id, how) { return null; }
    on_household_empty(hh) {}
  }

  const _NOBODY = new NoFolk(); // read-only stand-in for a Simulation without folk

  // sim.folk: a NoFolk for n 0, else the townsfolk (G.folk.Folk, read at call time).
  function make_folk(sim, n, isolated = false) {
    if (!n) return new NoFolk();
    return new G.folk.Folk(sim, n, isolated);
  }

  G.people = {
    FOLK_NEWS_CAP, PROMPT_MAX, PROMPT_DAYS, REL_CAP, NAMED_SEX, PROMPTS, HANDLERS, EFFECTS,
    is_folk_id, folk_index, dice_seed, person, household_by_id, name_of, everyone, is_named, mixed, isolated, traits,
    sex, household, home_id, members, settle, rel, set_rel, rel_row, log_roll, flush_luck_log, news_gate, prompt,
    settle_choice, pending_fork, apply_extra, apply_effect, NoFolk, make_folk,
  };
})(globalThis.GameOfAILife || (globalThis.GameOfAILife = {}));

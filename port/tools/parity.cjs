// Node side of tests/test_port.py: runs the browser engine and prints JSON for the Python test to compare.
//
//   node port/tools/parity.cjs rng SEED N           the first N draws of Rng(SEED)
//   node port/tools/parity.cjs dice SEED            each Rng helper's draws, in a fixed order
//   node port/tools/parity.cjs golden SEED          the golden city (tests/fixtures/city_seed1.json's data)
//   node port/tools/parity.cjs messages SEED DAYS   LocalHost's messages for a God view, after DAYS game days
//   node port/tools/parity.cjs god SEED TEXTS       LocalHost's replies to a God view's raw messages (a JSON list)
//   node port/tools/parity.cjs affinity SEED STEPS  chronicle.on_affinity on scripted bumps (a JSON list)
//   node port/tools/parity.cjs quiet SEED FRAMES    LocalHost's stats cadence with no view, then a God view
//   node port/tools/parity.cjs run SEED DAYS DICE   a run through LocalHost, with every fork checked
//   node port/tools/parity.cjs trace SEED DAYS DICE [LUCK|-] [SCENARIO]  every event, fork and hourly agent
//                                                   row, each midnight's stats push samples and the last stats
"use strict";
const crypto = require("crypto");
const G = require("./engine.cjs").load();

const sha1 = text => crypto.createHash("sha1").update(text, "utf8").digest("hex");

// A God view's socket as LocalHost sees it: it keeps every message it is sent, decoded.
class Client {
  constructor() { this.got = []; this.closed = false; }
  _deliver(text) { this.got.push(JSON.parse(text)); }
  _serverClose() { this.closed = true; }
  take(type) {
    const i = this.got.findIndex(m => m.type === type);
    return i < 0 ? null : this.got.splice(i, 1)[0];
  }
}

// A host on a hand-driven clock: `tick(seconds)` moves real time on.
function hostFor(sim, speed) {
  const clock = { t: 1000.0 };
  const host = new G.host.LocalHost(sim, speed, () => clock.t);
  host.sim.town.warm();
  return { host, clock };
}

function messages(seed, days) {
  const sim = new G.sim.Simulation(seed, null, null, seed);
  if (days) sim.run_days(days);
  const { host, clock } = hostFor(sim, 16);
  const god = new Client();
  host.connect(god);
  host.receive(god, JSON.stringify({ type: "hello", role: "god", req_id: 1 }));
  const welcome = god.take("welcome");
  let state = null, stats = null;
  for (let i = 0; i < 200 && !(state && stats); i++) {
    clock.t += G.host.FRAME_SECONDS;
    host.frame();
    state = state || god.take("state");
    stats = stats || god.take("stats");
  }
  const ask = msg => {
    host.receive(god, JSON.stringify(msg));
    return god.got.pop();
  };
  const speeds = [sim.speed]; // sim.speed as the host set it at start and after each speed message
  const askSpeed = msg => {
    const reply = ask(msg);
    speeds.push(sim.speed);
    return reply;
  };
  return {
    welcome, state, stats,
    get_stats: ask({ type: "get_stats" }),
    agent: ask({ type: "get_agent", agent_id: "dana" }),
    home: ask({ type: "get_home", home_id: "main_20" }),
    decisions: ask({ type: "get_decisions", limit: 5 }),
    decisions_agent: ask({ type: "get_decisions", agent_id: "dana" }),
    errors: {
      unknown_agent: ask({ type: "get_agent", agent_id: "nobody" }),
      unknown_home: ask({ type: "get_home", home_id: "nowhere" }),
      unknown_decisions: ask({ type: "get_decisions", agent_id: "nobody" }),
      bad_luck: ask({ type: "set_luck", agent_id: "dana", luck: "lots" }),
      unknown_type: ask({ type: "fly" }),
    },
    luck: ask({ type: "set_luck", agent_id: "dana", luck: 80, req_id: "r1" }),
    speed: askSpeed({ type: "set_speed", speed: 4 }),
    pause: askSpeed({ type: "pause" }),
    resume: askSpeed({ type: "resume" }),
    sim_speeds: speeds,
    profile: ask({ type: "set_profile", agent_id: "dana", traits: { thrift: 0.9 } }),
    protocol: protocol(host),
    agent_ids: Array.from(sim.agents.keys()),
  };
}

// A God view's raw messages, one reply each, then the luck sim.set_luck("dana", "nan") leaves: the odd values
// a hand-written message can carry (NaN, Infinity, numbers as strings) answered as GameServer answers them.
function god(seed, texts) {
  const sim = new G.sim.Simulation(seed, null, null, seed);
  const { host } = hostFor(sim, 16);
  const view = new Client();
  host.connect(view);
  host.receive(view, JSON.stringify({ type: "hello", role: "god" }));
  view.take("welcome");
  const out = texts.map(text => {
    view.got = [];
    host.receive(view, text);
    return view.got.pop();
  });
  sim.set_luck("dana", "nan");
  out.push({ direct_luck: sim.agents.get("dana").luck });
  return out;
}

// chronicle.on_affinity on scripted relationship bumps, for the Python twin to repeat. Each step is
// [a_id, b_id, before, after, tick, kind_ab, kind_ba]: at game minute `tick`, a's affinity to b went from
// `before` to `after`; a kind sets that side's relationship kind first ("-" removes b's side, null leaves it).
// After each step: the events, both sides' kinds and b's newest memory; at the end, sim._rifts.
function affinity(seed, steps) {
  const sim = new G.sim.Simulation(seed, null, null, seed);
  sim.drain();
  const rel = (x, y) => (sim.agents.has(x) ? sim.agents.get(x).relationships.get(y) ?? null : null);
  const out = steps.map(([a_id, b_id, before, after, tick, kind_ab, kind_ba]) => {
    sim.clock.tick = tick;
    if (kind_ab) rel(a_id, b_id).kind = kind_ab;
    if (kind_ba === "-") sim.agents.get(b_id).relationships.delete(a_id);
    else if (kind_ba) rel(b_id, a_id).kind = kind_ba;
    if (rel(a_id, b_id)) rel(a_id, b_id).affinity = after;
    G.chronicle.on_affinity(sim, a_id, b_id, before, after);
    const [events] = sim.drain();
    const b = sim.agents.get(b_id);
    return { events: events.map(e => [e.tick, e.tag, e.importance, e.text, e.agent, e.agents, e.place]),
      kinds: [rel(a_id, b_id) && rel(a_id, b_id).kind, rel(b_id, a_id) && rel(b_id, a_id).kind],
      memory: b ? b.memory[b.memory.length - 1] ?? null : null };
  });
  out.push({ rifts: Array.from(sim._rifts || new Map()).sort() });
  return out;
}

// The stats cadence with nobody watching: FRAMES frames at speed 16 on a hand-driven clock, then a God view
// joins. A push that falls due with no viewer hands its samples to nobody, so the view's first push carries only
// what came after (its welcome has them all).
function quiet(seed, frames) {
  const sim = new G.sim.Simulation(seed, null, null, seed);
  const { host, clock } = hostFor(sim, 16);
  const step = () => {
    clock.t += G.host.FRAME_SECONDS;
    host.frame();
  };
  for (let i = 0; i < frames; i++) step();
  const out = { tick: sim.clock.tick, samples: sim.stats.samples.length, pushed: sim.stats._pushed,
    stats_at: host._stats_at };
  const god = new Client();
  host.connect(god);
  host.receive(god, JSON.stringify({ type: "hello", role: "god" }));
  out.welcome_samples = god.take("welcome").stats.samples.map(s => s.tick);
  let push = null;
  for (let i = 0; i < 400 && !push; i++) {
    step();
    push = god.take("stats");
  }
  out.push_samples = push.samples.map(s => s.tick);
  return out;
}

// The session rules GameServer keeps: hello first, JSON objects only, one God (the old one watches), no
// controllers in the browser.
function protocol(host) {
  const out = {};
  const a = new Client(), b = new Client(), c = new Client();
  host.connect(a);
  host.receive(a, "not json");
  out.not_json = a.got.pop();
  host.receive(a, "[1, 2]");
  out.not_object = a.got.pop();
  host.receive(a, JSON.stringify({ type: "get_stats", req_id: 7 }));
  out.before_hello = a.got.pop();
  host.receive(a, JSON.stringify({ type: "hello", role: "god" }));
  a.got = [];
  host.connect(b);
  host.receive(b, JSON.stringify({ type: "hello", role: "god" }));
  out.demoted = a.got.pop();
  host.receive(a, JSON.stringify({ type: "set_luck", agent_id: "dana", luck: 10 }));
  out.watcher_luck = a.got.pop();
  host.receive(a, JSON.stringify({ type: "get_agent", agent_id: "dana" }));
  out.watcher_agent = a.got.pop().type;
  host.connect(c);
  host.receive(c, JSON.stringify({ type: "hello", role: "controller", name: "claude", characters: "all" }));
  out.controller = c.got.pop();
  out.controller_closed = c.closed;
  return out;
}

// Each Rng helper in turn, for the Python twin to repeat: random, int, uniform, pick and shuffle.
function dice(seed) {
  const r = new G.rng.Rng(seed);
  const items = Array.from({ length: 10 }, (_, i) => i);
  const out = { random: [], int: [], uniform: [], pick: [] };
  for (let i = 0; i < 5; i++) out.random.push(r.random());
  for (let i = 0; i < 5; i++) out.int.push(r.int(-4, 4));
  for (let i = 0; i < 5; i++) out.uniform.push(r.uniform(60, 90));
  for (let i = 0; i < 5; i++) out.pick.push(r.pick(items));
  r.shuffle(items);
  out.shuffle = items;
  out.r2 = out.uniform.map(G.rng.r2);
  return out;
}

// Run DAYS game days through LocalHost with a God view attached, checking every fork the Director gets.
function run(seed, days, dice) {
  const sim = new G.sim.Simulation(seed, null, null, dice);
  const people = sim.agents.size;
  const { host, clock } = hostFor(sim, 16);
  const god = new Client();
  host.connect(god);
  host.receive(god, JSON.stringify({ type: "hello", role: "god" }));
  const kinds = {};
  let forks = 0;
  const bad = [];
  const director = sim.director.bind(sim);
  sim.director = (agent, fork) => {
    forks += 1;
    kinds[fork.kind] = (kinds[fork.kind] || 0) + 1;
    if (fork.options.length !== 4) bad.push(`${fork.id} ${fork.kind}: ${fork.options.length} options`);
    return director(agent, fork);
  };
  const end = sim.clock.tick + days * G.clock.MINUTES_PER_DAY;
  let frames = 0, states = 0, statsPushes = 0, summaries = 0;
  const t0 = Date.now();
  while (sim.clock.tick < end) {
    clock.t += G.host.FRAME_SECONDS;
    host.frame();
    frames += 1;
    for (const m of god.got) {
      if (m.type === "state") {
        states += 1;
        for (const f of m.forks) {
          summaries += 1;
          if (f.options.length !== 4) bad.push(`summary ${f.id}: ${f.options.length} options`);
        }
      } else if (m.type === "stats") {
        statsPushes += 1;
      }
    }
    god.got = [];
  }
  return {
    people, alive: sim.living().length, ticks: sim.clock.tick, forks, kinds, bad, frames, states,
    stats_pushes: statsPushes, summaries, events: sim.history.length, ms: Date.now() - t0,
    moves: Array.from(sim.households.values()).filter(hh => hh.moved_tick !== null).length,
  };
}

// The whole run, step by step, for the Python twin to repeat with the same dice (tests/test_port.py gives the
// Python Simulation these SimDice): every event and decided fork, each fork's options and scores as the Director
// gets it, a checksum of everyone's tile and who rides which bus each minute, every agent at each whole hour, the
// samples a stats push would carry at each midnight, and the full stats message at the end.
// SCENARIO "hard": adults start broke and the over-40s 30 years older, to reach arrears and deaths; "debt":
// adults start $3,000 in debt, to reach housing trouble, evictions and forced sales; "bonds": acquaintances
// and coworkers start one point short of friends, friends and partners one point from falling out; "ill":
// every fifth character starts at health 20, so the ambulance takes them to hospital; "taxi": every other
// worker sets off for work by taxi at the start.
function trace(seed, days, dice, luck = null, scenario = "") {
  const sim = new G.sim.Simulation(seed, null, null, dice);
  if (luck !== null) for (const a of sim.agents.values()) sim.set_luck(a.id, luck); // God's hand on everyone
  if (scenario === "debt") for (const a of sim.agents.values()) if (a.is_adult) { a.money = -3000.0; a.savings = 0.0; }
  if (scenario === "hard") {
    for (const a of sim.agents.values()) {
      if (a.is_adult) { a.money = 30.0; a.savings = 0.0; }
      if (a.age >= 40) a.age += 30;
    }
  }
  if (scenario === "bonds") {
    const { FRIEND_AT, RIFT_AT, FRIENDS_FROM, RIFT_KINDS } = G.chronicle;
    for (const a of sim.agents.values()) {
      for (const rel of a.relationships.values()) {
        if (FRIENDS_FROM.includes(rel.kind)) rel.affinity = FRIEND_AT - 1.0;
        else if (RIFT_KINDS.includes(rel.kind)) rel.affinity = RIFT_AT + 1.0;
      }
    }
  }
  if (scenario === "ill") Array.from(sim.agents.values()).forEach((a, i) => { if (i % 5 === 0) a.health = 20.0; });
  if (scenario === "taxi") {
    Array.from(sim.agents.values()).filter(a => a.job && a.job.hourly_wage > 0)
      .forEach((a, i) => { if (i % 2 === 0) sim.start_plan(a, [["work", "job"]], "taxi"); });
  }
  const out = { events: [], forks: [], hours: [], pushes: [], ticks: [], asked: [] };
  // Every fork the Director gets: its kind, the options as a controller would be offered them (labels, costs,
  // travel minutes) and the profile's scores.
  const director = sim.director.bind(sim);
  sim.director = (agent, fork) => {
    const options = sim.fork_message(agent, fork).options;
    const result = director(agent, fork);
    out.asked.push([fork.kind, options, fork.scores]);
    return result;
  };
  const end = sim.clock.tick + days * G.clock.MINUTES_PER_DAY;
  const drain = () => {
    const [events, forks] = sim.drain();
    for (const e of events) out.events.push(`${e.tick} ${e.tag} ${e.text}`);
    for (const f of forks) out.forks.push(`${f.tick} ${f.id} ${f.agent} ${f.kind} ${f.choice} ${f.decided_by} ${f.happened.join("|")}`);
  };
  drain();
  const agents = Array.from(sim.agents.values());
  while (sim.clock.tick < end) {
    sim.step();
    drain();
    // Every minute: a checksum of where everyone is, and who is on which bus.
    let where = 0;
    agents.forEach((a, i) => { where += (i + 1) * (a.x * 131 + a.y); });
    out.ticks.push(`${sim.clock.tick} ${where} ${agents.filter(a => a.riding).map(a => `${a.id}@${a.riding}`).join(",")}`);
    if (sim.clock.minute_of_day % 60 === 0) {
      out.hours.push([sim.clock.tick, Array.from(sim.agents.values(), a => [a.id, a.x, a.y, a.state, a.activity,
        a.inside, G.py.pyRound(a.money, 2), G.py.pyRound(a.savings, 2), G.py.pyRound(a.health, 2),
        G.agent.NEEDS.map(n => G.py.pyRound(a.needs[n], 2)), a.household_id,
        sim.households.get(a.household_id).home_id, a.vehicle, a.riding, a.trip ? a.trip.phase : null])
        .map(r => JSON.stringify(r)).join(";")]);
    }
    if (sim.clock.minute_of_day === 0) out.pushes.push(sim.stats_json(false).samples);
  }
  out.stats = sim.stats_json(true);
  out.richest = sim.stats.richest;
  return out;
}

function main(argv) {
  const [cmd, ...args] = argv;
  const n = i => Number(args[i]);
  let out;
  if (cmd === "rng") {
    const r = new G.rng.Rng(n(0));
    out = Array.from({ length: n(1) }, () => r.random());
  } else if (cmd === "dice") {
    out = dice(n(0));
  } else if (cmd === "golden") {
    out = G.cast.golden(n(0), sha1);
  } else if (cmd === "messages") {
    out = messages(n(0), n(1) || 0);
  } else if (cmd === "god") {
    out = god(n(0), JSON.parse(args[1]));
  } else if (cmd === "quiet") {
    out = quiet(n(0), n(1));
  } else if (cmd === "affinity") {
    out = affinity(n(0), JSON.parse(args[1]));
  } else if (cmd === "trace") {
    out = trace(n(0), n(1), n(2), args.length > 3 && args[3] !== "-" ? n(3) : null, args[4] || "");
  } else if (cmd === "run") {
    out = run(n(0), n(1), n(2));
  } else {
    process.stderr.write("usage: parity.cjs rng|dice|golden|messages|god|affinity|quiet|run|trace ...\n");
    process.exit(2);
  }
  process.stdout.write(JSON.stringify(out) + "\n");
}

main(process.argv.slice(2));

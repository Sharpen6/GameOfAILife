// Node side of tests/test_port.py: runs the browser engine and prints JSON for the Python test to compare.
//
//   node port/tools/parity.cjs rng SEED N           the first N draws of Rng(SEED)
//   node port/tools/parity.cjs dice SEED            each Rng helper's draws, in a fixed order
//   node port/tools/parity.cjs golden SEED          the golden city (tests/fixtures/city_seed1.json's data)
//   node port/tools/parity.cjs messages SEED DAYS   LocalHost's messages for a God view, after DAYS game days
//   node port/tools/parity.cjs run SEED DAYS DICE   a run through LocalHost, with every fork checked
//   node port/tools/parity.cjs trace SEED DAYS DICE [LUCK|-] [hard]  every event, fork and hourly agent row
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
    speed: ask({ type: "set_speed", speed: 4 }),
    pause: ask({ type: "pause" }),
    resume: ask({ type: "resume" }),
    profile: ask({ type: "set_profile", agent_id: "dana", traits: { thrift: 0.9 } }),
    protocol: protocol(host),
    agent_ids: Array.from(sim.agents.keys()),
  };
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
// Python Simulation these SimDice): every event and decided fork, and every agent at each whole hour.
// SCENARIO "hard": adults start broke and the over-40s 30 years older, to reach arrears and deaths; "debt":
// adults start $3,000 in debt, to reach housing trouble, evictions and forced sales.
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
  const out = { events: [], forks: [], hours: [] };
  const end = sim.clock.tick + days * G.clock.MINUTES_PER_DAY;
  const drain = () => {
    const [events, forks] = sim.drain();
    for (const e of events) out.events.push(`${e.tick} ${e.tag} ${e.text}`);
    for (const f of forks) out.forks.push(`${f.tick} ${f.id} ${f.agent} ${f.kind} ${f.choice} ${f.decided_by} ${f.happened.join("|")}`);
  };
  drain();
  while (sim.clock.tick < end) {
    sim.step();
    drain();
    if (sim.clock.minute_of_day % 60 === 0) {
      out.hours.push([sim.clock.tick, Array.from(sim.agents.values(), a => [a.id, a.x, a.y, a.state, a.activity,
        a.inside, G.py.pyRound(a.money, 2), G.py.pyRound(a.savings, 2), G.py.pyRound(a.health, 2),
        G.agent.NEEDS.map(n => G.py.pyRound(a.needs[n], 2)), a.household_id,
        sim.households.get(a.household_id).home_id]).map(r => JSON.stringify(r)).join(";")]);
    }
  }
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
  } else if (cmd === "trace") {
    out = trace(n(0), n(1), n(2), args.length > 3 && args[3] !== "-" ? n(3) : null, args[4] || "");
  } else if (cmd === "run") {
    out = run(n(0), n(1), n(2));
  } else {
    process.stderr.write("usage: parity.cjs rng|dice|golden|messages|run|trace ...\n");
    process.exit(2);
  }
  process.stdout.write(JSON.stringify(out) + "\n");
}

main(process.argv.slice(2));

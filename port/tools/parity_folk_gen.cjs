// Node side of tests/test_folk_gen.py's fixture check: generates the townsfolk with port/src/folk_gen.js and
// compares them, parsed, with tests/fixtures/folk_seed1.json (python3 -m gameofailife.folk_gen --dump 1).
//
//   node port/tools/parity_folk_gen.cjs [SEED] [FIXTURE]   prints "folk_gen parity ok" or the first difference
//   node port/tools/parity_folk_gen.cjs --money [SEED]     prints, as one JSON line, folk_life.js's books after
//     tests/test_folk_money.py's scripted three weeks (rehearse there; the test compares it with Python's)
"use strict";
const fs = require("fs");
const path = require("path");
const G = require("./engine.cjs").load();

// Three scripted weeks of folk_life on generated townsfolk: each midnight's damp and emergency rolls; joins,
// splits and leavers on day 3; broke households (some laid off, so the third Sunday moves them somewhere cheaper)
// on day 5; birthdays on day 10; every workday's shift pay, Friday pensions and Sunday books. Line by line with
// rehearse in tests/test_folk_money.py.
function rehearse(sim, days = 22) {
  const FL = G.folk_life, MPD = G.clock.MINUTES_PER_DAY, { r2 } = G.rng;
  const folk = sim.folk;
  folk.luck_log = []; // F2a's Folk has one; people.log_roll fills it
  sim.lots.get(sim.homes.get(folk.households[0].home_id).place).condition = 5.0; // one derelict home: damp and chills
  for (let day = 0; day < days; day++) {
    const weekday = day % 7;
    sim.clock.tick = day * MPD;
    FL.nightly(sim);
    sim.clock.tick = day * MPD + 8 * 60;
    if (day === 3) {
      const adults = folk.people.filter(p => p.age >= 25 && !p.gone);
      const hosts = adults.filter((_, k) => k % 9 === 0);
      const picks = adults.filter((_, k) => k % 37 === 0).slice(0, 15);
      picks.forEach((p, k) => {
        if (p.gone) return;
        if (k % 3 === 0) {
          const host = hosts[(k * 7) % hosts.length];
          if (!host.gone) FL.join(sim, p, host);
        } else if (k % 3 === 1) {
          FL.split(sim, p);
        } else {
          FL.release(sim, p);
        }
      });
    }
    if (day === 5) {
      folk.households.forEach((hh, k) => {
        if (k % 30 !== 0 && k % 50 !== 7) return;
        for (const p of FL.adults(folk, hh)) {
          p.money = r2(p.money - 4000);
          p.savings = 0.0;
          if (k % 50 === 7 && p.job !== null && p.job.hourly_wage > 0) {
            G.folk_gen.board(sim).free(p.job.slot); // laid off: no pay to climb back with
            p.job = null;
          }
        }
      });
    }
    if (day === 10) {
      folk.people.forEach((p, k) => {
        if (k % 40 === 0 && p.alive && !p.gone) {
          p.age += 1;
          FL.on_birthday(sim, p);
        }
      });
    }
    for (const p of folk.people) {
      const job = p.job;
      if (p.gone || job === null || job.hourly_wage <= 0 || !job.workdays.includes(weekday)) continue;
      FL.pay_shift(sim, p);
    }
    if (weekday === 4) {
      sim.clock.tick = day * MPD + 9 * 60;
      FL.pensions(sim);
    }
    if (weekday === 6) {
      sim.clock.tick = day * MPD + 23 * 60;
      FL.weekly(sim);
    }
  }
  const out = G.folk_gen.dump(sim);
  out.gone = folk.people.filter(p => p.gone).map(p => p.id);
  out.books = folk.households.map(hh => [hh.id, hh.arrears, hh.clean_sundays, hh.gone, hh.last_funds]);
  out.homes = [...sim.homes.values()].map(h => [h.id, h.household, h.owner, h.listing, h.rent]);
  out.events = sim.events.map(ev => ev.text);
  out.memory = folk.people.map(p => [...p.memory]);
  out.luck = folk.luck_log.map(row => [...row]);
  out.positions = folk.people.map(p => [...p.position()]);
  return out;
}

if (process.argv[2] === "--money") {
  const sim = G.folk_gen.generate(Number(process.argv[3] || 1));
  fs.writeSync(1, JSON.stringify(rehearse(sim)) + "\n"); // synchronous: the line is long
  process.exit(0);
}

const seed = Number(process.argv[2] || 1);
const fixture = process.argv[3] || path.join(__dirname, "..", "..", "tests", "fixtures", `folk_seed${seed}.json`);

// The first path where a and b differ, or null.
function diff(a, b, at) {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return at;
    if (a.length !== b.length) return `${at} (length ${a.length} vs ${b.length})`;
    for (let i = 0; i < a.length; i++) {
      const d = diff(a[i], b[i], `${at}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    const d = diff(ka, kb, `${at}.keys`);
    if (d) return d;
    for (const k of ka) {
      const dk = diff(a[k], b[k], `${at}.${k}`);
      if (dk) return dk;
    }
    return null;
  }
  return a === b ? null : `${at}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
}

const t0 = process.cpuUsage();
const sim = G.folk_gen.generate(seed);
const used = process.cpuUsage(t0);
const got = G.folk_gen.dump(sim);
const want = JSON.parse(fs.readFileSync(fixture, "utf8"));
const d = diff(got, want, "folk");
console.log(`generated ${got.people.length} people in ${got.households.length} households,`
  + ` ${((used.user + used.system) / 1e6).toFixed(2)} s cpu`);
if (d) {
  console.log(`folk_gen parity FAILED at ${d}`);
  process.exit(1);
}
console.log("folk_gen parity ok");

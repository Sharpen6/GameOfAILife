// Node side of tests/test_run_fixes.py's DecisionsParity: a city whose 60 people are all played by a fake
// controller that answers every fork SECONDS after it is asked at speed 8 (the profile's favourite, and every third
// answer the next option round), with the Python engine's dice, so the two engines' think-time plans can be
// compared: every event, decided fork (with its reason) and hourly agent row.
//
//   node port/tools/parity_decisions.cjs SEED DAYS DICE SECONDS
"use strict";
const G = require("./engine.cjs").load();

function played(seed, days, dice, seconds) {
  const clock = { t: 1000.0 };
  const sim = new G.sim.Simulation(seed, () => clock.t, null, dice);
  for (const a of sim.agents.values()) sim.claim(a.id, "fake");
  const per_tick = 1 / (G.clock.TICKS_PER_REAL_SECOND * 8);
  const due = [];
  let asked = 0;
  const out = { events: [], forks: [], hours: [] };
  const end = sim.clock.tick + days * G.clock.MINUTES_PER_DAY;
  while (sim.clock.tick < end) {
    clock.t += per_tick;
    for (const d of due.filter(d => d[0] <= clock.t)) {
      due.splice(due.indexOf(d), 1);
      sim.answer(d[1], d[2], "because", "fake");
    }
    sim.step();
    const [events, forks, outbox] = sim.drain();
    for (const e of events) out.events.push(`${e.tick} ${e.tag} ${e.text}`);
    for (const f of forks) out.forks.push(`${f.tick} ${f.id} ${f.agent} ${f.kind} ${f.choice} ${f.decided_by} ${f.reason} ${f.happened.join("|")}`);
    for (const [, msg] of outbox) {
      if (msg.type !== "fork") continue;
      const s = msg.profile_scores;
      let pick = s.indexOf(Math.max(...s));
      asked += 1;
      if (asked % 3 === 0) pick = (pick + 1) % 4;
      due.push([clock.t + seconds, msg.fork_id, pick]);
    }
    if (sim.clock.minute_of_day % 60 === 0) {
      out.hours.push(JSON.stringify([sim.clock.tick, Array.from(sim.agents.values(), a => [a.id, a.x, a.y, a.state,
        a.activity, a.inside, G.py.pyRound(a.money, 2), a.vehicle])]));
    }
  }
  return out;
}

const [seed, days, dice, seconds] = process.argv.slice(2).map(Number);
process.stdout.write(JSON.stringify(played(seed, days, dice, seconds)) + "\n");

// The life lockstep (L2): the 60 with life on (illness, births, deaths, birthdays, work, money) for DAYS game days,
// every event and every agent's life state at each whole hour, for tests/test_life.py's Python twin to repeat with
// the same dice.
//
//   node port/tools/parity_life.cjs SEED DAYS [DICE]   -> JSON {events, hours, counts, board}
//
// Before F3's hooks land the Simulation has no `life`: the script sets it up and calls life.tick after each step,
// as the Python twin does.
"use strict";
const G = require("./engine.cjs").load();

function row(sim, a) {
  const L = a.life;
  const r2 = x => G.py.pyRound(x, 2);
  return [a.id, a.age, a.alive, a.state, a.activity, a.inside, r2(a.money), r2(a.savings), r2(a.health),
    r2(a.reputation), a.job ? [a.job.title, a.job.slot, r2(a.job.hourly_wage)] : null, a.household_id,
    L ? [L.conditions.map(c => [c.id, c.until, c.off_until, c.doctor]), L.chronic.slice(), L.treated.slice(),
      L.ward_until, L.pregnant, L.trying, r2(L.lifestyle), r2(L.pay), L.jobless_since, L.warnings, L.grief_until]
      : null];
}

function trace(seed, days, dice) {
  const sim = new G.sim.Simulation(seed, null, null, dice);
  const hooked = sim.life !== undefined && sim.life !== null;
  if (!hooked) {
    G.life.pre_init(sim);
    G.life.init(sim);
  }
  const out = { events: [], hours: [] };
  const drain = () => {
    const [events] = sim.drain();
    for (const e of events) out.events.push(`${e.tick} ${e.tag} ${e.importance} ${e.text}`);
  };
  drain();
  const end = sim.clock.tick + days * G.clock.MINUTES_PER_DAY;
  while (sim.clock.tick < end) {
    sim.step();
    if (!hooked) G.life.tick(sim);
    drain();
    if (sim.clock.minute_of_day % 60 === 0) out.hours.push([sim.clock.tick, Array.from(sim.agents.values(), a => row(sim, a))]);
  }
  out.counts = Object.assign({}, sim.life.counts);
  out.board = sim.life.board.holder.slice();
  out.block = G.life.stats_block(sim);
  return out;
}

if (require.main === module) {
  const [seed, days, dice] = process.argv.slice(2).map(Number);
  process.stdout.write(JSON.stringify(trace(seed || 1, days || 8, Number.isFinite(dice) ? dice : (seed || 1))));
}

module.exports = { trace, row };

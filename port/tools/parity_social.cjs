// Social parity in node: the 60 live DAYS days with social on (rooms, talk, romance, dates, lending, incidents);
// at each midnight every relationship, the couples, engagements, queued prompts, counters and state.talks, plus every
// social event. tests/test_social.py runs the Python engine on the same dice (DiceSim) and compares.
//
//   node port/tools/parity_social.cjs SEED DAYS DICE   -> {"days": [...], "events": [...]}
"use strict";
const G = require("./engine.cjs").load();

const SOCIAL_TAGS = new Set(["talk", "flirt", "new_friend", "falling_out", "rival", "row", "partner", "breakup",
  "divorce", "moved_in", "engaged", "wedding", "loan", "meetup", "invite", "invite_accepted", "invite_declined",
  "text"]);
const r6 = x => Math.floor(x * 1e6 + 0.5) / 1e6;

function snapshot(sim) {
  const rels = [];
  for (const a of [...sim.agents.values()].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))) {
    for (const oid of [...a.relationships.keys()].sort()) {
      const r = a.relationships.get(oid);
      rels.push([a.id, oid, r.kind, r6(r.affinity), r6(r.trust), r6(r.romance), r.since, r.seen, r.talks, r.married]);
    }
  }
  const st = sim.social;
  const counts = {};
  for (const k of Object.keys(st.counts).sort()) counts[k] = st.counts[k];
  const pending = [];
  for (const a of sim.agents.values()) {
    if (a.life && a.life.pending.length) pending.push([a.id, a.life.pending.map(q => q.kind)]);
  }
  return {
    tick: sim.clock.tick, counts, rels, couples: st.couples.map(c => c.join("|")).sort(),
    engaged: [...st.engaged.entries()].sort(), pending, talks: G.social.talks_json(sim),
    households: [...sim.households.values()].map(h => [h.id, [...h.member_ids].sort()]).sort(),
  };
}

function run(seed, days, dice) {
  const sim = new G.sim.Simulation(seed, null, null, dice);
  const out = { days: [], events: [] };
  for (let i = 0; i < days * 24 * 60; i++) {
    sim.step();
    const [events] = sim.drain();
    for (const e of events) if (SOCIAL_TAGS.has(e.tag)) out.events.push([e.tick, e.tag, e.text]);
    if (sim.clock.minute_of_day === 0) out.days.push(snapshot(sim));
  }
  return out;
}

const [seed, days, dice] = process.argv.slice(2).map(Number);
process.stdout.write(JSON.stringify(run(seed || 1, days || 8, dice || 5)));

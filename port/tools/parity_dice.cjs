// The dice parity vector in node (tests/test_dice.py compares it with Python's).
//
//   node port/tools/parity_dice.cjs   -> {"vector": [...], "odds": [...], "streams": [...]}
"use strict";
const G = require("./engine.cjs").load();
const d = G.dice;
const r12 = x => Math.floor(x * 1e12 + 0.5) / 1e12;
const vector = [d.key(1, 3, "dana", 12), r12(d.roll(1, 3, "dana", 12)), r12(d.roll(1, 1, "cafe", 1445)),
  r12(d.roll(7, 2, "ari", "tom"))];
const odds = [];
for (const p of [0.05, 0.4, 0.9]) for (const v of [-1, 1, 0.5]) for (const luck of [0, 37, 50, 100]) {
  odds.push(r12(d.odds(p, v, luck)), r12(d.odds(p, v, luck, 0.5)));
}
const streams = [];
for (const [seed, ns, a, b] of [[1, d.TALK, "cafe", 1445], [99, d.CHEM, "dana", "f17"], [123456789, d.INCIDENT, "works", 7]]) {
  const rr = d.stream(seed, ns, a, b);
  streams.push([rr.random(), rr.random(), rr.int(0, 9), rr.uniform(0, 0.08)].map(r12));
}
process.stdout.write(JSON.stringify({ vector, odds, streams }));

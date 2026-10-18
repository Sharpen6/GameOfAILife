// Node side of tests/test_folk_gen.py's fixture check: generates the townsfolk with port/src/folk_gen.js and
// compares them, parsed, with tests/fixtures/folk_seed1.json (python3 -m gameofailife.folk_gen --dump 1).
//
//   node port/tools/parity_folk_gen.cjs [SEED] [FIXTURE]   prints "folk_gen parity ok" or the first difference
"use strict";
const fs = require("fs");
const path = require("path");
const G = require("./engine.cjs").load();

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

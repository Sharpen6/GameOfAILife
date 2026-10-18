// Node side of tests/test_regiongen.py: builds the region in the browser engine and prints JSON for the Python
// test to compare with gameofailife.region.
//
//   node port/tools/parity_region.cjs SEED     map_json, priced home_specs, job_slots, lot_conditions, rent_at and
//                                              car_extra samples, district_at on a grid, build time
"use strict";
const G = require("./engine.cjs").load();

function region(seed) {
  const t0 = process.hrtime.bigint();
  const m = G.region.build_region(seed);
  const build_ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const rents = m.home_specs.map(spec => [
    G.region.rent_at(m, spec, m.lot_conditions[spec[1]] === undefined ? 100 : m.lot_conditions[spec[1]]),
    G.region.rent_at(m, spec, 0), G.region.rent_at(m, spec, 37.5)]);
  const parking = Array.from(m.places.keys(), pid => G.region.car_extra(m, pid));
  const districts = [];
  for (let y = 0; y < m.h; y += 7) for (let x = 0; x < m.w; x += 5) districts.push(m.district_at(x, y));
  const frozen = [[0, 0], [68, 49], [69, 0], [0, 50], [200, 100]].map(([x, y]) => m.in_frozen(x, y));
  const walk = [], street = [];
  for (let i = 0; i < m.w * m.h; i += 97) {
    walk.push(m.walkable(i % m.w, Math.floor(i / m.w)) ? 1 : 0);
    street.push(m._road[i]);
  }
  return {
    world: m.world, map: m.map_json(), home_specs: m.home_specs, job_slots: m.job_slots,
    lot_conditions: m.lot_conditions, millbrook_ids: Array.from(m.millbrook_ids).sort(), rents, parking,
    districts, frozen, walk, street, warm_next: m.warm_next(), build_ms,
    millbrook: { world: G.town.build_map(seed).world, in_frozen: G.town.build_map(seed).in_frozen(200, 100),
                 car_extra: G.region.car_extra(G.town.build_map(seed), "cafe") },
  };
}

const [what, seed] = process.argv.slice(2);
if (what !== "region") throw new Error(`usage: node parity_region.cjs region SEED (got ${what})`);
process.stdout.write(JSON.stringify(region(Number(seed))));

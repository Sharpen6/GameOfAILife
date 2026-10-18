// Node side of tests/test_rail_contract.py: runs port/src/roads.js and rail.js on the region and prints JSON for
// the Python test to compare with gameofailife/roads.py and rail.py.
//
//   node port/tools/parity_rail.cjs net                 node and edge counts, the first nodes, the highway nodes
//   node port/tools/parity_rail.cjs routes N            N routes (pairs as in test_rail_contract.pairs), minutes
//                                                       both ways, corners, t8, tiles and Route.at samples
//   node port/tools/parity_rail.cjs starts N            the start [cost, node] of N pairs, walk and car
//   node port/tools/parity_rail.cjs nearby N            nearby() from N homes: cafes on foot, offices by car
//   node port/tools/parity_rail.cjs trains TICKS        state.trains rows for ticks 0..TICKS-1 (riders by tick)
//   node port/tools/parity_rail.cjs trips N             trip_via_roads at 3 ticks, worst_minutes, both car modes
//   node port/tools/parity_rail.cjs boarding            every (line, track, station) boarding table and run minutes
//   node port/tools/parity_rail.cjs bench N             report-only timings (minutes hits, routes, train_rows)
//
// The map is G.region.build_region(1) (REGION_DATA comes from engine.cjs); while R1a's loader is absent it is
// built here from RAIL_REGION_JSON (or gameofailife/data/region.json) over build_map(1), as region_load.py does.
"use strict";
const fs = require("fs");
const path = require("path");
const G = require("./engine.cjs").load();

function regionTown() {
  if (G.region && G.region.build_region) return G.region.build_region(1);
  const file = process.env.RAIL_REGION_JSON || path.join(__dirname, "..", "..", "gameofailife", "data", "region.json");
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const [fw, fh] = d.frozen;
  const mb = G.town.build_map(1);
  const tiles = d.rows.map(r => Array.from(r));
  for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) tiles[y][x] = mb.tiles[y][x];
  const places = new Map(mb.places);
  for (const p of d.places) {
    places.set(p.id, new G.town.Place(p.id, p.name, p.kind, p.x, p.y, p.w, p.h, p.hours ? Array.from(p.hours) : null,
      Array.from(p.entry), p.face, p.district, p.style, p.floors, p.tier, p.units));
  }
  return {
    tiles, places, memo: new Map(), rail: d.rail, world: "region", w: tiles[0].length, h: tiles.length,
    highway_edges: d.highway_edges, interchanges: d.interchanges,
  };
}

// The same pairs as test_rail_contract.pairs: homes and destinations in place order, strided.
function pairs(town, n) {
  const homes = [], dest = [];
  for (const [pid, p] of town.places) {
    if (p.kind === "home") homes.push(pid);
    else if (p.kind !== "park") dest.push(pid);
  }
  const out = [];
  for (let i = 0; i < n; i++) out.push([homes[(i * 37 + 11) % homes.length], dest[(i * 53 + 7) % dest.length]]);
  return out;
}

const AT = [0, 0.5, 1, 2.25, 3.7, 7, 12.5, 20, 33.3, 61, 999];
const legJson = leg => [leg[0], leg[1], leg[2], leg[3] instanceof G.roads.Route ? { mode: leg[3].mode, pts: leg[3].pts, minutes: leg[3].minutes } : leg[3]];

function main() {
  const [cmd, arg] = process.argv.slice(2);
  const town = regionTown();
  const net = G.roads.roadnet(town);
  let out;
  if (cmd === "net") {
    out = {
      nodes: net.nodes.length, edges: net.adj.reduce((s, a) => s + a.length, 0) / 2, first: net.nodes.slice(0, 20),
      last: net.nodes.slice(-10),
    };
  } else if (cmd === "routes") {
    out = pairs(town, Number(arg)).map(([a, b], i) => {
      const mode = i % 3 === 0 ? "car" : "walk";
      const r = net.route(a, b, mode, i % 2 === 0);
      return [a, b, mode, net.minutes(a, b, mode), net.minutes(b, a, mode), r.pts, r.t8, r.tiles, r.minutes,
        AT.map(m => r.at(m))];
    });
  } else if (cmd === "starts") {
    out = pairs(town, Number(arg)).map(([a, b]) => {
      const [ra] = net._end(a), [rb] = net._end(b);
      return [net._start(ra, rb, "walk"), net._start(ra, rb, "car")];
    });
  } else if (cmd === "nearby") {
    out = pairs(town, Number(arg)).map(([a]) => [net.nearby(a, ["cafe"], "walk", 3),
      net.nearby(a, ["office", "works"], "car", 5, 25)]);
  } else if (cmd === "trains") {
    out = [];
    for (let t = 0; t < Number(arg); t++) {
      const riders = { R1: t % 7, S2: t % 5 };
      out.push(G.rail.train_rows(town, t, riders));
    }
  } else if (cmd === "trips") {
    out = pairs(town, Number(arg)).map(([a, b], i) => {
      const car = i % 4 === 0;
      const trips = [i % 1440, 420 + i % 180, 1000 + (i * 7) % 60].map(t => {
        const tr = G.rail.trip_via_roads(town, net, a, b, t, car);
        return tr === null ? null : [tr.minutes, tr.board, tr.alight, tr.legs.map(legJson)];
      });
      return [a, b, car, G.rail.worst_minutes(town, net, a, b, car), trips];
    });
  } else if (cmd === "boarding") {
    out = [];
    for (const ln of G.rail.lines(town).values()) {
      for (const track of ["out", "in"]) {
        for (const s of ln.stations) {
          const row = [];
          for (let t = 0; t < ln.cycle_minutes; t++) row.push(G.rail.boarding(town, ln.id, track, s, t));
          out.push([ln.id, track, s, row]);
        }
      }
      out.push([ln.id, "run", ln.run, ln.cycle_minutes]);
    }
    out.push(["timetable", G.rail.timetable_json(town)]);
    out.push(["rail", G.rail.rail_json(town)]);
  } else if (cmd === "bench") {
    const n = Number(arg);
    const ps = pairs(town, 300);
    for (const [a, b] of ps) net.minutes(a, b);
    let t0 = process.hrtime.bigint();
    for (let i = 0; i < n; i++) { const [a, b] = ps[i % 300]; net.minutes(a, b); }
    const hit = Number(process.hrtime.bigint() - t0) / n / 1000;
    t0 = process.hrtime.bigint();
    for (let i = 0; i < 300; i++) net.route(ps[i][0], ps[i][1], "walk", false);
    const route = Number(process.hrtime.bigint() - t0) / 300 / 1000;
    t0 = process.hrtime.bigint();
    for (let i = 0; i < 5000; i++) G.rail.train_rows(town, i);
    const rows = Number(process.hrtime.bigint() - t0) / 5000 / 1000;
    t0 = process.hrtime.bigint();
    for (let i = 0; i < 3000; i++) G.rail.trip_via_roads(town, net, ps[i % 300][0], ps[i % 300][1], i);
    const trip = Number(process.hrtime.bigint() - t0) / 3000 / 1000;
    out = { minutes_hit_us: hit, route_us: route, train_rows_us: rows, trip_us: trip };
  } else {
    throw new Error(`unknown command ${cmd}`);
  }
  process.stdout.write(JSON.stringify(out));
}

main();

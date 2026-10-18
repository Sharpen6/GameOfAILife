// Node side of tests/test_region_named.py's parity check: Rule R (travel.nearest, travel.named_may_visit) and the
// housing region hunks in the browser engine, on a millbrook Simulation whose town, homes and lots are the
// region's (as the Python test builds it), answering the same queries.
//
//   node port/tools/parity_travel.cjs SPEC.json     SPEC: {seed, queries: [...], visits: [...], folk: {...}}
"use strict";
const fs = require("fs");
const G = require("./engine.cjs").load();

function region_sim(seed) {
  const town = G.region.build_region(seed);
  const sim = new G.sim.Simulation(seed);
  const homes = G.housing.build_homes(town);
  for (const hid of G.housing.V2_HOME_IDS) homes.set(hid, sim.homes.get(hid));
  const lots = G.housing.build_lots(town, homes);
  for (const [pid, lot] of sim.lots) lots.set(pid, lot);
  sim.town = town;
  sim.homes = homes;
  sim.lots = lots;
  town.warm();
  return sim;
}

function place_at(sim, agent, q) {
  agent.x = q.x;
  agent.y = q.y;
  agent.inside = null;
  sim.clock.tick = q.tick;
}

function scripted_folk(sim, spec) {
  const { FolkHousehold, Person } = G.folk_model;
  const { Job } = G.agent;
  const house = sim.homes.get(spec.house);
  const hh = new FolkHousehold("fh0", house.id, 0.0, 0);
  hh.member_ids = ["f0", "f1", "f2"];
  const ada = new Person(0, "Ada Moss", 34, "f", 0), ben = new Person(1, "Ben Moss", 40, "m", 0);
  const cal = new Person(2, "Cal Moss", 9, "m", 0);
  ada.job = new Job("clerk", spec.work, 22.0, 9, 17, [0, 1, 2, 3, 4]);
  ada.commute = [spec.work, 34, "train"];
  ada.money = 400.0;
  ada.savings = 2600.0;
  ben.job = new Job("fitter", spec.work, 24.0, 7, 15, [0, 1, 2, 3, 4, 5]);
  ben.commute = [spec.work, 21, "car"];
  ben.owns_car = true;
  ben.money = 250.0;
  cal.job = new Job("student", "school", 0.0, 8, 15, [0, 1, 2, 3, 4]);
  [ada, ben, cal].forEach((p, i) => {
    p.traits = {};
    for (const t of G.agent.Profile.TRAITS) p.traits[t] = 0.3 + 0.1 * i;
  });
  house.household = hh.id;
  house.owner = hh.id;
  const people = new Map([ada, ben, cal].map(p => [p.id, p]));
  const folk = { n: 0, isolated: false, v: 0, person: pid => people.get(pid) ?? null,
    get: pid => people.get(pid) ?? null, household: hid => (hid === hh.id ? hh : null),
    living: () => [ada, ben, cal].filter(p => p.alive) };
  sim.folk = folk;
  sim.person = pid => sim.agents.get(pid) ?? folk.person(pid);
  sim.household_by_id = hid => sim.households.get(hid) ?? folk.household(hid);
  return [hh, house, [ada, ben, cal]];
}

function run(spec) {
  const sim = region_sim(spec.seed);
  const agents = Array.from(sim.agents.values());
  const out = { nearest: [], visits: [] };
  for (const q of spec.queries) {
    const a = agents[q.agent];
    place_at(sim, a, q);
    const p = G.travel.nearest(sim, a, q.kinds, null, null, q.stay, q.max);
    out.nearest.push(p === null ? null : p.id);
  }
  for (const v of spec.visits) {
    const a = agents[v.agent];
    place_at(sim, a, v);
    out.visits.push(G.travel.named_may_visit(sim, a, v.place, v.max));
  }
  const H = G.housing;
  out.listed = H.list_vacancies(sim);
  out.region_homes = Array.from(sim.homes.values()).filter(h => !H.is_v2_home(h.id))
    .map(h => [h.id, h.owner, h.listing, h.rent]);
  out.market = H.market_json(sim);
  const [hh, house] = scripted_folk(sim, spec.folk);
  const other = sim.homes.get(spec.folk.other);
  out.folk = {
    commute: H.commute(sim, hh), outgo: H.weekly_outgo(sim, hh), income: H.weekly_income(sim, hh),
    living: H.living(sim, hh), residents: H.residents(sim, hh), name: H.household_name(sim, hh),
    affordable: H.affordable(sim, hh, other.id), upgrade: H.is_upgrade(sim, hh, other.id),
    weekly_cost: H.weekly_cost(sim, hh), page: H.home_page(sim, house.id).residents,
    afford: [0, 50, 900, 1000000].map(cost => H.afford_score(sim, sim.person("f0"),
      { cost, household_pays: false, charge: true })),
  };
  house.emergency = { kind: "boiler", since: 0 };
  house.pending_emergency = { kind: "roof", due: 0 };
  sim.lots.get(house.place).condition = 61.0;
  for (let day = 0; day < 4; day++) {
    sim.clock.tick = day * 24 * 60;
    H.nightly(sim);
    H.tick(sim);
  }
  out.folk.condition = sim.lots.get(house.place).condition;
  out.folk.listed_after = H.list_vacancies(sim);
  const v2_places = new Set(H.HOME_SPECS.map(row => row[1])); // the cast's lots wear with the dice's emergencies
  out.lots = Array.from(sim.lots.entries()).filter(([pid]) => !v2_places.has(pid))
    .map(([pid, lot]) => [pid, G.rng.r2(lot.condition)]);
  return out;
}

const spec = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
process.stdout.write(JSON.stringify(run(spec)));

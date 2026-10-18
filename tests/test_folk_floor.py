"""The townsfolk's floor (stage 5 repair): nobody starves on the ward or for want of money, homes the household can
pay for at generation, children left with no adult go to family, the region's capacity, and the page's health.

- Ward: a townsperson on a long hospital stay is fed, rested and treated hourly like a named (life._ward_care), so
  health rises and hunger stays at 60 or more; the same numbers in the JS port.
- Food parcel: a meal at home with an empty fridge orders groceries in when the payer can pay, else the food bank
  hands over FOOD_PARCEL meals (no money, a memory line once a week); an empty fridge never feeds anyone for free.
- Lifestyle spending comes only out of what the pay leaves after the housing charge and the bills.
- At generation no pensioner-only household pays more for its home, bills and food than its pension.
- Orphans: children left with no adult move to an adult relative's household, else leave town to family.
- Capacity: more townsfolk than the region's homes take raise folk_gen.TooManyFolk (a ValueError naming the limit),
  the same limit in JS; `python3 -m gameofailife --folk N` runs with the limit and says so.
- Page: a townsperson page settles before it reads health, so two reads agree.
- stats.city.start_population counts the cast and the townsfolk generated at the start (not the newborns).
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

from gameofailife import folk, folk_gen, folk_life, housing, life, money
from gameofailife.agent import RelationKind
from gameofailife.sim import Simulation

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which("node")
DAY = 1440


def node(code: str) -> dict:
    js = 'const G = require(process.argv[1] + "/port/tools/engine.cjs").load();\n' + code
    out = subprocess.run([NODE, "-e", js, str(ROOT)], capture_output=True, text=True, timeout=600)
    if out.returncode != 0:
        raise AssertionError(out.stderr[-3000:])
    return json.loads(out.stdout.strip().splitlines()[-1])


WARD_DAYS = 4


def ward_py() -> dict:
    sim = Simulation(1, world="region", folk=200)
    for _ in range(600):
        sim.step()
    p = next(q for q in sim.folk.living() if q.age >= 30 and q.job is not None)
    p.settle(sim.clock.tick)
    p.health = 40.0
    life.hospitalise(sim, p, WARD_DAYS, "a fall")
    health, low = [], 100.0
    for h in range(WARD_DAYS * 24 + 6):
        for _ in range(60):
            sim.step()
        if h >= 2 and p.life.ward_until > sim.clock.tick:
            low = min(low, p.needs["hunger"], p.needs["energy"])
        if h % 24 == 23:
            health.append(round(p.health, 6))
    return {"id": p.id, "alive": p.alive, "health": health, "low": round(low, 6)}, p.activity


WARD_JS = f"""
const sim = new G.sim.Simulation(1, null, null, null, {{ world: "region", folk: 200 }});
for (let i = 0; i < 600; i++) sim.step();
const p = sim.folk.living().find(q => q.age >= 30 && q.job !== null);
p.settle(sim.clock.tick);
p.health = 40.0;
G.life.hospitalise(sim, p, {WARD_DAYS}, "a fall");
const health = []; let low = 100;
for (let h = 0; h < {WARD_DAYS} * 24 + 6; h++) {{
  for (let i = 0; i < 60; i++) sim.step();
  if (h >= 2 && p.life.ward_until > sim.clock.tick) low = Math.min(low, p.needs.hunger, p.needs.energy);
  if (h % 24 === 23) health.push(Math.round(p.health * 1e6) / 1e6);
}}
console.log(JSON.stringify({{ id: p.id, alive: p.alive, health, low: Math.round(low * 1e6) / 1e6 }}));
"""


class WardCareTest(unittest.TestCase):
    def test_a_long_stay_is_fed_and_healed(self):
        got, after = ward_py()
        self.assertTrue(got["alive"], got)
        self.assertGreaterEqual(got["low"], 60.0, got)
        self.assertGreater(got["health"][0], 60.0, got)  # treated from 40
        self.assertEqual(got["health"], sorted(got["health"]), got)  # never falls on the ward
        self.assertNotEqual(after, "ward", got)  # discharged after the stay
        if NODE:  # the stay only: after it the named sim's weather (random.Random vs SimDice) may differ
            self.assertEqual(node(WARD_JS), got)


def parcel_py() -> dict:
    sim = Simulation(1, world="region", folk=200)
    f = sim.folk
    p = next(q for q in f.living() if q.age >= 18 and f.hh_of(q) is not None and len(f.hh_of(q).member_ids) >= 2)
    hh = f.hh_of(p)
    members = [f.person(m) for m in hh.member_ids]
    for q in members:
        q.money, q.savings = 0.0, 0.0
    hh.groceries = 0
    f._eat_in(p)
    first = (f.counters["food_parcels"], hh.groceries, p.money)
    hh.groceries = 0
    f._eat_in(p)  # the same day: a second parcel, no second memory line
    notes = [sum("food parcel" in line for line in q.memory) for q in members if q.age >= 5]
    p.money = 100.0
    hh.groceries = 0
    f._eat_in(p)  # with money: ordered in
    return {"first": list(first), "parcels": f.counters["food_parcels"], "notes": notes, "money": p.money,
            "groceries": hh.groceries}


PARCEL_JS = """
const sim = new G.sim.Simulation(1, null, null, null, { world: "region", folk: 200 });
const f = sim.folk;
const p = f.living().find(q => q.age >= 18 && f.hh_of(q) !== null && f.hh_of(q).member_ids.length >= 2);
const hh = f.hh_of(p);
const members = hh.member_ids.map(m => f.person(m));
for (const q of members) { q.money = 0; q.savings = 0; }
hh.groceries = 0;
f._eat_in(p);
const first = [f.counters.food_parcels, hh.groceries, p.money];
hh.groceries = 0;
f._eat_in(p);
const notes = members.filter(q => q.age >= 5).map(q => q.memory.filter(l => l.includes("food parcel")).length);
p.money = 100;
hh.groceries = 0;
f._eat_in(p);
console.log(JSON.stringify({ first, parcels: f.counters.food_parcels, notes, money: p.money, groceries: hh.groceries }));
"""


class FoodFloorTest(unittest.TestCase):
    def test_a_broke_household_gets_a_parcel(self):
        got = parcel_py()
        self.assertEqual(got["first"], [1, folk.FOOD_PARCEL - 1, 0.0])  # free food, one meal eaten
        self.assertEqual(got["parcels"], 2)
        self.assertTrue(got["notes"] and all(n == 1 for n in got["notes"]), got)  # once a week
        self.assertEqual(got["money"], 100.0 - folk.GROCERY_COST - folk.DELIVERY_FEE)
        self.assertEqual(got["groceries"], folk.GROCERY_MEALS - 1)
        if NODE:
            self.assertEqual(node(PARCEL_JS), got)

    def test_lifestyle_spending_leaves_the_bills(self):
        from unittest import mock

        from gameofailife import career
        sim = Simulation(1, world="region", folk=200)
        f = sim.folk
        checked = 0
        for hh in f.households:
            mem = [f.person(m) for m in hh.member_ids]
            if len(mem) != 1 or mem[0].age < 18 or mem[0].life is None:
                continue
            p = mem[0]
            pay = money._income(sim, p) + career.benefit(sim, p)
            cap = max(0.0, pay - money._fixed(sim, hh)) + money.CHRONIC_COST * len(p.life.treated)
            p.life.lifestyle, p.life.pay = 10_000.0, pay  # a habit far above the pay
            p.money, p.savings, hh.last_funds = pay, 0.0, 0.0
            before = p.money
            with mock.patch.object(money, "_shock", return_value=0), \
                    mock.patch.object(career, "benefit", return_value=0):
                money.weekly(sim, p)
            self.assertAlmostEqual(before - p.money + (pay - money._income(sim, p)), cap, places=6, msg=p.id)
            checked += 1
        self.assertGreater(checked, 10)

    def test_pensioners_can_pay_for_their_homes(self):
        for seed in (1, 2, 3):
            sim = Simulation(seed, world="region", folk=1000)
            f = sim.folk
            short = 0
            for hh in f.households:
                mem = [f.person(m) for m in hh.member_ids]
                budget = folk_gen.pension_budget(f, hh)
                if budget is None or hh.home_id not in sim.homes:
                    continue
                if folk_gen.home_cost(sim.homes[hh.home_id]) > budget + 1e-9:
                    short += 1
            self.assertEqual(short, 0, seed)


def orphans_py() -> dict:
    sim = Simulation(1, world="region", folk=300)
    f = sim.folk
    fams = []
    for hh in f.households:
        mem = [f.person(m) for m in hh.member_ids]
        kids = [q for q in mem if q.age < folk_life.ADULT_AGE]
        grown = [q for q in mem if q.age >= folk_life.ADULT_AGE]
        if kids and grown and not any(q.age >= folk_life.ADULT_AGE and q.household_id != hh.id
                                      for k in kids for q in map(f.person, k.relationships)
                                      if q is not None and k.relationships[q.id].kind in (RelationKind.FAMILY,
                                                                                          "family")):
            fams.append((hh, kids, grown))
    (hh1, kids1, grown1), (hh2, kids2, grown2) = fams[:2]
    host = next(q for q in f.living() if q.age >= 30 and q.household_id not in (hh1.id, hh2.id))
    folk_gen.set_rel(sim, kids1[0].id, host.id, RelationKind.FAMILY, 70.0)
    for q in grown1 + grown2:
        life.die(sim, q, "died in a test")
    left = [e["text"] for e in sim.history if e["tag"] == "left_town"]
    return {"moved": [k.household_id == host.household_id for k in kids1],
            "note": [any(f"Moved in with {host.name}." in line for line in k.memory) for k in kids1],
            "gone": [k.gone for k in kids2], "left": left[-1:]}


ORPHANS_JS = """
const sim = new G.sim.Simulation(1, null, null, null, { world: "region", folk: 300 });
const f = sim.folk;
const A = G.folk_life.ADULT_AGE;
const fams = [];
for (const hh of f.households) {
  const mem = hh.member_ids.map(m => f.person(m));
  const kids = mem.filter(q => q.age < A), grown = mem.filter(q => q.age >= A);
  const out = kids.some(k => [...k.relationships.keys()].some(o => {
    const q = f.person(o);
    return q && q.age >= A && q.household_id !== hh.id && k.relationships.get(o).kind === "family";
  }));
  if (kids.length && grown.length && !out) fams.push([hh, kids, grown]);
}
const [[hh1, kids1, grown1], [hh2, kids2, grown2]] = fams;
const host = f.living().find(q => q.age >= 30 && q.household_id !== hh1.id && q.household_id !== hh2.id);
G.folk_gen.set_rel(sim, kids1[0].id, host.id, G.agent.RelationKind.FAMILY, 70.0);
for (const q of grown1.concat(grown2)) G.life.die(sim, q, "died in a test");
const left = sim.history.filter(e => e.tag === "left_town").map(e => e.text);
console.log(JSON.stringify({ moved: kids1.map(k => k.household_id === host.household_id),
  note: kids1.map(k => k.memory.some(l => l.includes(`Moved in with ${host.name}.`))),
  gone: kids2.map(k => k.gone), left: left.slice(-1) }));
"""


class OrphansTest(unittest.TestCase):
    def test_children_go_to_family(self):
        got = orphans_py()
        self.assertTrue(got["moved"] and all(got["moved"]), got)
        self.assertTrue(all(got["note"]), got)
        self.assertTrue(got["gone"] and all(got["gone"]), got)
        self.assertTrue(got["left"] and got["left"][0].endswith("go to live with family out of town."), got)
        if NODE:
            self.assertEqual(node(ORPHANS_JS), got)


CAP_JS = """
let limit = null, name = null, msg = null;
try { new G.sim.Simulation(1, null, null, null, { world: "region", folk: 2500 }); }
catch (err) { limit = err.limit; name = err.name; msg = err.message; }
console.log(JSON.stringify({ limit, name, msg }));
"""


class CapacityTest(unittest.TestCase):
    def test_too_many_folk_names_the_limit(self):
        with self.assertRaises(folk_gen.TooManyFolk) as cm:
            Simulation(1, world="region", folk=2500)
        err = cm.exception
        self.assertIsInstance(err, ValueError)
        self.assertEqual(err.n, 2500)
        self.assertGreater(err.limit, 1000)
        self.assertIn(f"at most {err.limit} townsfolk", str(err))
        sim = Simulation(1, world="region", folk=err.limit)  # the limit itself fits
        self.assertEqual(len(sim.folk.people), err.limit)
        with self.assertRaises(folk_gen.TooManyFolk):
            Simulation(1, world="region", folk=err.limit + 1)
        if NODE:
            self.assertEqual(node(CAP_JS), {"limit": err.limit, "name": "TooManyFolk", "msg": str(err)})

    def test_main_runs_with_the_limit(self):
        out = subprocess.run([sys.executable, "-m", "gameofailife", "--headless", "--days", "0.01", "--folk", "2500"],
                             cwd=ROOT, capture_output=True, text=True, timeout=300)
        self.assertEqual(out.returncode, 0, out.stderr[-2000:])
        self.assertRegex(out.stderr, r"--folk 2500: the region has homes for at most \d+ townsfolk \(asked for 2500\);"
                                     r" running with --folk \d+\.")


START_JS = """
const sim = new G.sim.Simulation(1, null, null, null, { world: "region", folk: 200 });
const st = sim.stats_json(true);
console.log(JSON.stringify({ start: st.city.start_population, population: st.city.population }));
"""


class StartPopulationTest(unittest.TestCase):
    def test_the_cast_and_the_townsfolk_at_the_start(self):
        sim = Simulation(1, world="region", folk=200)
        city = sim.stats_json(full=True)["city"]
        self.assertEqual(city["start_population"], len(sim.agents) + 200)
        self.assertEqual(city["population"], city["start_population"])
        if NODE:
            self.assertEqual(node(START_JS), {"start": city["start_population"], "population": city["population"]})
        v2 = Simulation(1)  # Millbrook alone: the cast
        self.assertEqual(v2.stats_json(full=True)["city"]["start_population"], len(v2.agents))


class PageHealthTest(unittest.TestCase):
    def test_two_reads_agree(self):
        sim = Simulation(2, world="region", folk=200)
        for _ in range(600):
            sim.step()
        f = sim.folk
        for p in f.living()[:50]:
            a, b = f.page_json(sim, p.id), f.page_json(sim, p.id)
            self.assertEqual((a["health"], a["needs"]), (b["health"], b["needs"]), p.id)


if __name__ == "__main__":
    unittest.main()

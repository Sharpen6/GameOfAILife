"""money.py (L2, life.md 5.8): lifestyle spending, shocks, debt interest, child and chronic costs, benefit."""

import json
import unittest
from collections import Counter
from unittest import mock

from gameofailife import career, dice, life, money, people
from gameofailife.sim import Simulation
from tests.test_life import NODE, life_sim, node_eval


def no_shocks():
    return mock.patch.object(money, "_shock", return_value=0)


class LifestyleTest(unittest.TestCase):
    def test_first_week_spends_the_target(self):
        sim = life_sim()
        a = sim.agents["ari"]
        t = people.traits(a)
        pay = money._income(sim, a)
        target = (0.25 + 0.30 * (1 - t["thrift"]) + 0.10 * (t["adventure"] - 0.5)) * pay
        before = a.money + a.savings
        with no_shocks():
            money.weekly(sim, a)
        self.assertAlmostEqual(a.life.lifestyle, target)
        self.assertAlmostEqual(a.life.pay, pay)
        self.assertLess(a.money + a.savings, before - target + 1)

    def test_lifestyle_rises_fast_and_falls_slowly(self):
        sim = life_sim()
        a = sim.agents["ari"]
        with no_shocks():
            money.weekly(sim, a)
            target = a.life.lifestyle
            a.life.lifestyle = target - 100
            money.weekly(sim, a)
            self.assertAlmostEqual(a.life.lifestyle, target - 75)
            a.life.lifestyle = target + 100
            money.weekly(sim, a)
            self.assertAlmostEqual(a.life.lifestyle, target + 94)

    def test_halved_while_belt_tightening(self):
        sim = life_sim()
        a = sim.agents["ari"]
        sim.households[a.household_id].tight_until = sim.clock.tick + 10_000
        with no_shocks():
            m0 = a.money
            money.weekly(sim, a)
            spent_tight = m0 - a.money
        sim2 = life_sim()
        c = sim2.agents["ari"]
        with no_shocks():
            m2 = c.money
            money.weekly(sim2, c)
        self.assertAlmostEqual(spent_tight, (m2 - c.money) / 2, places=6)

    def test_no_extras_while_in_the_red(self):
        """A household in the red after last Sunday's bills spends nothing on its lifestyle until it is out of it,
        tightening its belt or not; the habit itself keeps following the pay."""
        for tight in (False, True):
            sim = life_sim()
            a = sim.agents["ari"]
            hh = sim.households[a.household_id]
            hh.last_funds = -50.0  # the last Sunday's charges left the household in the red (arrears or grace)
            if tight:
                hh.tight_until = sim.clock.tick + 10_000
            with no_shocks():
                m0 = a.money
                money.weekly(sim, a)
            self.assertGreater(a.life.lifestyle, 0)
            self.assertAlmostEqual(a.money, m0, places=6)  # ari has no children, debt or treated conditions


class ShockTest(unittest.TestCase):
    def test_bad_and_good_rolls_are_luck_shifted_and_logged(self):
        sim = life_sim()
        a = sim.agents["dana"]
        seen = []
        with mock.patch.object(people, "log_roll", lambda s, p, what, prob, roll: seen.append((what, prob))):
            money.weekly(sim, a)
        whats = [w for w, _ in seen]
        self.assertIn("shock_bad", whats)
        self.assertIn("shock_good", whats)
        bad = dict(seen)["shock_bad"]
        owner = money._owns_home(sim, a)
        total = sum(r[1] for r in money.BAD if (r[4] != "car" or a.owns_car) and (r[4] != "owner" or owner))
        self.assertAlmostEqual(bad, dice.odds(total, -1, a.luck))

    def test_a_let_homes_appliances_are_the_landlords(self):
        sim = life_sim()
        renter = next(a for a in sim.agents.values() if a.is_adult and not money._owns_home(sim, a))
        owner = next(a for a in sim.agents.values() if a.is_adult and money._owns_home(sim, a))
        self.assertEqual(sim.homes[sim.households[owner.household_id].home_id].owner, owner.household_id)
        for a, odds in ((renter, 0.0), (owner, 0.015)):
            seen = []
            with mock.patch.object(people, "log_roll", lambda s, p, what, prob, roll: seen.append((what, prob))):
                money.weekly(sim, a)
            others = sum(r[1] for r in money.BAD if r[4] not in ("car", "owner") or (r[4] == "car" and a.owns_car))
            self.assertAlmostEqual(dict(seen)["shock_bad"], dice.odds(others + odds, -1, a.luck))

    def test_importance_by_amount(self):
        sim = life_sim()
        a = sim.agents["dana"]
        self.assertEqual([money._importance(sim, a, x) for x in (299, 300, 1999, 2000)], [0, 1, 1, 2])

        class Folk:
            id = "f1"
        self.assertEqual([money._importance(sim, Folk, x) for x in (999, 1000, 4999, 5000)], [0, 1, 1, 2])


class DebtTest(unittest.TestCase):
    def test_interest_on_debt(self):
        sim = life_sim()
        a = sim.agents["ari"]
        with no_shocks(), mock.patch.object(money, "_income", return_value=0.0):
            a.money, a.savings = -1000.0, 0.0
            a.life.lifestyle, a.life.pay = 0.0, 0.0
            money.weekly(sim, a)
        self.assertAlmostEqual(a.money, -1000.0 * (1 + money.DEBT_RATE))

    def test_savings_cover_a_negative_purse(self):
        sim = life_sim()
        a = sim.agents["ari"]
        with no_shocks():
            a.money, a.savings = -50.0, 5000.0
            money.weekly(sim, a)
        self.assertGreaterEqual(a.money, 0.0)

    def test_children_cost_the_richest_adult(self):
        sim = life_sim()
        shira, eli = sim.agents["shira"], sim.agents["eli"]
        for q in (shira, eli):
            q.life.chronic, q.life.treated = [], []  # chronic costs are their own line
        kids = [m for m in people.members(sim, shira) if m.age < 18]
        cost = sum(next(c for u, c in money.CHILD_COST if k.age < u) for k in kids)
        richer, poorer = (shira, eli) if shira.money + shira.savings >= eli.money + eli.savings else (eli, shira)
        with no_shocks(), mock.patch.object(money, "_income", return_value=0.0):
            m = poorer.money
            money.weekly(sim, poorer)
            self.assertAlmostEqual(poorer.money, m)  # nothing for the poorer partner (and no pay: no lifestyle)
            r = richer.money
            money.weekly(sim, richer)
        if kids:
            self.assertLessEqual(richer.money, r - cost + 1e-9)

    def test_benefit_is_paid_to_the_laid_off(self):
        sim = life_sim()
        a = next(a for a in sim.agents.values() if career.worker(a))
        career.lose_job(sim, a, dice.stream(1, 0), "laid_off")
        with no_shocks():
            money.weekly(sim, a)
        self.assertEqual(a.life.pay, career.BENEFIT)


# Twelve Sundays of money.weekly for every adult, with a third of the households in the red after the last
# Sunday's bills and another third tightening their belts: the same purses, habits and expense lines in the port.
TWIN = """
const sim = new G.sim.Simulation(1);
const ids = [...sim.households.keys()].sort();
ids.forEach((id, i) => {
  const hh = sim.households.get(id);
  if (i % 3 === 0) hh.last_funds = -120.0; else if (i % 3 === 1) hh.tight_until = 100 * 1440;
});
const adults = [...sim.agents.values()].filter(a => a.is_adult).sort((a, b) => (a.id < b.id ? -1 : 1));
sim.drain();
const shocks = (until) => {  // the money shocks due by `until`, in tick order (life's agenda; nothing else runs)
  for (const t of [...sim.life.agenda.keys()].filter(t => t <= until).sort((a, b) => a - b)) {
    const rows = sim.life.agenda.get(t), keep = rows.filter(r => r[0] !== "shock");
    sim.clock.tick = t;
    for (const [kind, pid, arg] of rows) if (kind === "shock") G.life._run_agenda(sim, kind, pid, arg);
    if (keep.length) sim.life.agenda.set(t, keep); else sim.life.agenda.delete(t);
  }
};
for (let week = 0; week < 12; week++) {
  shocks((7 * week + 6) * 1440 + 600);
  sim.clock.tick = (7 * week + 6) * 1440 + 600;
  for (const a of adults) G.money.weekly(sim, a);
}
shocks(100 * 1440);
const [events] = sim.drain();
console.log(JSON.stringify({
  people: adults.map(a => [a.id, a.money, a.savings, a.life.lifestyle]),
  events: events.map(e => [e.tick, e.agent, e.tag, e.importance, e.text]),
}));
"""


def due_shocks(sim, until: int) -> None:
    """The money shocks on life's agenda due by `until`, in tick order, at their ticks (nothing else runs)."""
    for t in sorted(k for k in sim.life.agenda if k <= until):
        rows = sim.life.agenda[t]
        keep = [r for r in rows if r[0] != "shock"]
        sim.clock.tick = t
        for kind, pid, arg in rows:
            if kind == "shock":
                life._run_agenda(sim, kind, pid, arg)
        if keep:
            sim.life.agenda[t] = keep
        else:
            del sim.life.agenda[t]


def twin_py() -> dict:
    sim = Simulation(1)
    for i, hid in enumerate(sorted(sim.households)):
        hh = sim.households[hid]
        if i % 3 == 0:
            hh.last_funds = -120.0
        elif i % 3 == 1:
            hh.tight_until = 100 * 1440
    adults = sorted((a for a in sim.agents.values() if a.is_adult), key=lambda a: a.id)
    sim.drain()
    for week in range(12):
        due_shocks(sim, (7 * week + 6) * 1440 + 600)
        sim.clock.tick = (7 * week + 6) * 1440 + 600
        for a in adults:
            money.weekly(sim, a)
    due_shocks(sim, 100 * 1440)
    events, _, _ = sim.drain()
    return {"people": [[a.id, a.money, a.savings, a.life.lifestyle] for a in adults],
            "events": [[e["tick"], e["agent"], e["tag"], e["importance"], e["text"]] for e in events]}, sim


class ShockTimingTest(unittest.TestCase):
    """A shock rolled in the Sunday slot comes in the week ahead: a garage, a dentist, an employer or the tax office
    on a weekday in DAY_HOURS, the rest any day in ANY_HOURS (they all came on Sundays)."""

    def test_shocks_come_in_their_hours(self):
        import re
        py, _ = twin_py()
        rows = [(re.compile(re.escape(r[5]).replace(re.escape("${a}"), r"\$[\d,]+")), r[6]) for r in money.BAD + money.GOOD]
        seen = {"day": 0, "any": 0}
        for tick, _agent, tag, _imp, text in py["events"]:
            if tag not in ("expense", "windfall") or "cannot pay" in text:
                continue
            when = next(w for rx, w in rows if rx.search(text))
            seen[when] += 1
            day, m = divmod(tick, 1440)
            hours = money.DAY_HOURS if when == "day" else money.ANY_HOURS
            self.assertTrue(hours[0] <= m < hours[1], (tick, text))
            if when == "day":
                self.assertLess(day % 7, 5, (tick, text))
        self.assertGreater(seen["day"], 5)
        self.assertGreater(seen["any"], 5)
        weekdays = Counter(t // 1440 % 7 for t, _a, tag, _i, _x in py["events"] if tag in ("expense", "windfall"))
        self.assertLess(weekdays[money.SUNDAY], sum(weekdays.values()) / 4, weekdays)


@unittest.skipUnless(NODE, "node is not installed")
class MoneyTwinTest(unittest.TestCase):
    def test_the_port_keeps_the_same_books(self):
        py, sim = twin_py()
        appliances = [e for e in py["events"] if "broken appliance" in e[4]]
        self.assertTrue(appliances)  # the run has the owner-only shock ...
        for e in appliances:  # ... and only in homes their households own
            self.assertTrue(money._owns_home(sim, sim.agents[e[1]]), e)
        self.assertEqual(node_eval(TWIN), json.loads(json.dumps(py)))


if __name__ == "__main__":
    unittest.main()

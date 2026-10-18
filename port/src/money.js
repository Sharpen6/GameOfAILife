// Port of gameofailife/money.py: lifestyle spending, money shocks, debt interest, children's and chronic costs and
// the unemployment benefit (life.md 5.8), in each adult's Sunday slot between 09:00 and 19:00.
(function (G) {
  "use strict";

  const SUNDAY = 6;
  const WINDOW = [9 * 60, 19 * 60]; // the Sunday minutes money.weekly runs in

  const LIFESTYLE_BASE = 0.25, LIFESTYLE_THRIFT = 0.30, LIFESTYLE_ADVENTURE = 0.10;
  const LIFESTYLE_UP = 0.25, LIFESTYLE_DOWN = 0.06;
  const WEALTH_SPEND = 0.004;
  const DEBT_RATE = 0.004; // a week, on -(cash + savings)
  const CHRONIC_COST = 15.0; // a week, each treated chronic condition
  const CHILD_COST = [[3, 70.0], [5, 60.0], [18, 30.0]]; // (under this age, a week): baby, 3-4, 5-17
  // Shocks (WEEK_MONEY): [id, weekly odds, lo, hi, needs: "car" | "job" | "owner" | null, text, when]. "owner": only
  // in a home the household owns, since the landlord replaces a let home's appliances as it does its repairs
  // (housing). Rolled in the Sunday slot, the shock comes in the week ahead (life's agenda, `apply_shock`): "day" on a
  // weekday in DAY_HOURS, "any" on any day in ANY_HOURS.
  const BAD = [["car_repair", 0.02, 300, 1200, "car", "pays ${a} for car repairs", "day"],
    ["appliance", 0.015, 200, 600, "owner", "replaces a broken appliance for ${a}", "day"],
    ["dentist", 0.015, 100, 800, null, "has a ${a} dentist's bill", "day"],
    ["phone", 0.01, 150, 400, null, "replaces a broken phone for ${a}", "any"],
    ["fine", 0.01, 80, 200, "car", "gets a ${a} traffic fine", "any"],
    ["burglary", 0.003, 300, 1500, null, "is burgled and loses ${a}", "any"]];
  const GOOD = [["bonus", 0.012, 200, 800, "job", "gets a ${a} bonus at work", "day"],
    ["scratch_card", 0.0005, 100, 3000, null, "wins ${a} on a scratch card", "any"],
    ["tax_refund", 0.01, 150, 600, null, "gets a ${a} tax refund", "day"],
    ["sold", 0.01, 50, 300, null, "sells something online for ${a}", "any"],
    ["gift", 0.005, 100, 500, null, "gets a ${a} gift from family", "any"]];
  const DAY_HOURS = [9 * 60, 18 * 60], ANY_HOURS = [9 * 60, 21 * 60]; // [from, until) minutes a shock comes in

  // `p`'s take-home pay for a full week of shifts, else the pension at 65+ with no job, else nothing.
  function _income(sim, p) {
    const job = p.job;
    if (job !== null && job.hourly_wage > 0) {
      const hours = G.py.pyMod(job.end_hour - job.start_hour, 24) * job.workdays.length;
      return job.hourly_wage * hours * (1 - G.sim.income_tax(job.hourly_wage));
    }
    if (G.housing.retired(p)) return G.sim.PENSION;
    return 0.0;
  }

  // Named: 0 under $300, 1, 2 from $2,000; folk: 0 under $1,000, 1, 2 from $5,000 (life.md 5.8).
  function _importance(sim, p, amount) {
    if (sim.agents.has(p.id)) return amount >= 2000 ? 2 : amount >= 300 ? 1 : 0;
    return amount >= 5000 ? 2 : amount >= 1000 ? 1 : 0;
  }

  // `p`'s household owns the home it lives in.
  function _owns_home(sim, p) {
    const hh = G.people.household(sim, p);
    const home = hh !== null && hh !== undefined ? sim.homes.get(hh.home_id) : undefined;
    return home !== undefined && home !== null && home.owner === hh.id;
  }

  // One roll on the sum of the eligible shocks' odds, then a plain draw by weight, the amount and when in the week
  // ahead it comes: onto life's agenda (`apply_shock`). Returns the amount.
  function _shock(sim, p, rr, table, valence, what) {
    const rows = [];
    let total = 0.0;
    for (const row of table) {
      const need = row[4];
      if (need === "car" && !p.owns_car) continue;
      if (need === "job" && !(p.job !== null && p.job.hourly_wage > 0)) continue;
      if (need === "owner" && !_owns_home(sim, p)) continue;
      rows.push(row);
      total += row[1];
    }
    if (!rows.length || !G.life._hit(sim, p, what, total, valence, rr)) return 0;
    let x = rr.random() * total;
    let i = 0;
    while (i < rows.length - 1 && x >= rows[i][1]) {
      x -= rows[i][1];
      i += 1;
    }
    const row = rows[i];
    const amount = rr.int(row[2], row[3]);
    const hours = row[6] === "day" ? DAY_HOURS : ANY_HOURS;
    const ahead = rr.int(1, row[6] === "day" ? 5 : 7); // days after this Sunday
    const minute = rr.int(hours[0], hours[1] - 1);
    G.life._agenda(sim, (sim.clock.day + ahead) * G.life.DAY + minute, "shock", p.id, [row[0], amount, valence]);
    return amount;
  }

  // A money shock rolled last Sunday comes in (life's agenda): the money and the line.
  function apply_shock(sim, p, sid, amount, valence) {
    const row = BAD.concat(GOOD).find(r => r[0] === sid);
    p.money += amount * valence;
    const tag = valence > 0 ? "windfall" : "expense";
    const text = row[5].replace("${a}", `$${G.py.commas(amount)}`);
    G.life._event(sim, p, `${p.name} ${text}.`, tag, _importance(sim, p, amount));
  }

  // The household's charges on Sunday night: the housing charge (housing.weekly_cost) and the adults' bills and cars.
  function _fixed(sim, hh) {
    return G.housing.weekly_cost(sim, hh) + G.housing.bills(sim, hh);
  }

  // `p`'s money week (an adult's Sunday slot, life.md 5.8): see money.py.
  function weekly(sim, p) {
    const { career, dice, housing, people } = G;
    const life = p.life ?? null;
    if (life === null) return;
    const benefit = career.benefit(sim, p);
    if (benefit) p.money += benefit;
    const pay = _income(sim, p) + benefit;
    const t = people.traits(p);
    const target = (LIFESTYLE_BASE + LIFESTYLE_THRIFT * (1 - t.thrift) + LIFESTYLE_ADVENTURE * (t.adventure - 0.5))
      * pay;
    if (life.pay === 0.0 && life.lifestyle === 0.0) life.lifestyle = target;
    else if (target > life.lifestyle) life.lifestyle += LIFESTYLE_UP * (target - life.lifestyle);
    else life.lifestyle -= LIFESTYLE_DOWN * (life.lifestyle - target);
    life.pay = pay;
    let spend = life.lifestyle;
    const hh = people.household(sim, p);
    const adults = people.members(sim, p).filter(m => m.is_adult);
    if (hh !== null && hh !== undefined) { // the habit only out of what the pay leaves after housing and the bills
      spend = Math.min(spend, Math.max(0.0, pay - _fixed(sim, hh) / Math.max(1, adults.length)));
    }
    let tight;
    if (hh !== null && hh !== undefined && sim.agents.has(p.id)) {
      const spare = housing.funds(sim, hh) - 10 * housing.weekly_outgo(sim, hh);
      if (spare > 0) spend += WEALTH_SPEND * spare / Math.max(1, adults.length);
      tight = hh.tight_until > sim.clock.tick;
    } else {
      const spare = p.money + p.savings - 10 * 2 * pay;
      if (spare > 0) spend += WEALTH_SPEND * spare;
      tight = life.tight_until > sim.clock.tick;
    }
    // In the red after last Sunday's bills: no extras until out of it (the habit itself still follows the pay).
    if (hh !== null && hh !== undefined && hh.last_funds !== null && hh.last_funds !== undefined && hh.last_funds < 0) {
      spend = 0.0;
    } else if (hh !== null && hh !== undefined && (hh.last_funds === null || hh.last_funds === undefined)
      && housing.funds(sim, hh) < _fixed(sim, hh)) {
      spend = 0.0; // the first Sunday (no bills paid yet), already short of tonight's charges
    } else if (tight) spend *= 0.5;
    p.money -= spend;
    const rr = dice.stream(people.dice_seed(sim), dice.WEEK_MONEY, p.id, sim.clock.day);
    _shock(sim, p, rr, BAD, -1, "shock_bad");
    _shock(sim, p, rr, GOOD, +1, "shock_good");
    p.money -= CHRONIC_COST * life.treated.length;
    let richest = null;
    for (const a of adults) {
      if (richest === null || a.money + a.savings > richest.money + richest.savings) richest = a;
    }
    if (richest === p) {
      for (const k of people.members(sim, p)) {
        if (k.age < 18) {
          for (const [under, cost] of CHILD_COST) {
            if (k.age < under) { p.money -= cost; break; }
          }
        }
      }
    }
    const worth = p.money + p.savings;
    if (worth < 0) p.money -= DEBT_RATE * -worth;
    if (p.money < 0 && 0 < p.savings) {
      const take = Math.min(p.savings, -p.money);
      p.savings -= take;
      p.money += take;
    }
  }

  G.money = {
    SUNDAY, WINDOW, LIFESTYLE_BASE, LIFESTYLE_THRIFT, LIFESTYLE_ADVENTURE, LIFESTYLE_UP, LIFESTYLE_DOWN, WEALTH_SPEND,
    DEBT_RATE, CHRONIC_COST, CHILD_COST, BAD, GOOD, DAY_HOURS, ANY_HOURS, _income, _importance, _owns_home, _shock,
    apply_shock, _fixed, weekly,
  };
})(globalThis.GameOfAILife || (globalThis.GameOfAILife = {}));

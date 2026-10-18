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
  // Shocks (WEEK_MONEY): [id, weekly odds, lo, hi, needs: "car" | "job" | null, text]
  const BAD = [["car_repair", 0.02, 300, 1200, "car", "pays ${a} for car repairs"],
    ["appliance", 0.015, 200, 600, null, "replaces a broken appliance for ${a}"],
    ["dentist", 0.015, 100, 800, null, "has a ${a} dentist's bill"],
    ["phone", 0.01, 150, 400, null, "replaces a broken phone for ${a}"],
    ["fine", 0.01, 80, 200, "car", "gets a ${a} traffic fine"],
    ["burglary", 0.003, 300, 1500, null, "is burgled and loses ${a}"]];
  const GOOD = [["bonus", 0.012, 200, 800, "job", "gets a ${a} bonus at work"],
    ["scratch_card", 0.003, 100, 3000, null, "wins ${a} on a scratch card"],
    ["tax_refund", 0.01, 150, 600, null, "gets a ${a} tax refund"],
    ["sold", 0.01, 50, 300, null, "sells something online for ${a}"],
    ["gift", 0.005, 100, 500, null, "gets a ${a} gift from family"]];

  // `p`'s money week (an adult's Sunday slot). Skeleton: nothing (v2).
  function weekly(sim, p) { return null; }

  G.money = {
    SUNDAY, WINDOW, LIFESTYLE_BASE, LIFESTYLE_THRIFT, LIFESTYLE_ADVENTURE, LIFESTYLE_UP, LIFESTYLE_DOWN, WEALTH_SPEND,
    DEBT_RATE, CHRONIC_COST, CHILD_COST, BAD, GOOD, weekly,
  };
})(globalThis.GameOfAILife || (globalThis.GameOfAILife = {}));

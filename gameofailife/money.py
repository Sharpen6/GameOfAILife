"""Money for both tiers beyond wages and rent (life.md 5.8): lifestyle spending, money shocks, debt interest,
children's and chronic costs, and the unemployment benefit. Each adult's week is settled once, in their Sunday
slot between 09:00 and 19:00 (`life.tick`), before the 23:00 charges.

v3-skel-life: `weekly` exists with its final signature and v2's behaviour (nothing).
"""

from __future__ import annotations

SUNDAY = 6
WINDOW = (9 * 60, 19 * 60)  # the Sunday minutes money.weekly runs in

# Lifestyle: target share of take-home pay .25 + .30 (1 - thrift) + .10 (adventure - .5); moves up a quarter of the
# gap a week, down 6%; plus WEALTH_SPEND a week of funds above 10 weeks of outgo, halved while belt-tightening.
LIFESTYLE_BASE, LIFESTYLE_THRIFT, LIFESTYLE_ADVENTURE = 0.25, 0.30, 0.10
LIFESTYLE_UP, LIFESTYLE_DOWN = 0.25, 0.06
WEALTH_SPEND = 0.004
DEBT_RATE = 0.004  # a week, on -(cash + savings)
CHRONIC_COST = 15.0  # a week, each treated chronic condition
CHILD_COST = ((3, 70.0), (5, 60.0), (18, 30.0))  # (under this age, a week): baby, 3-4, 5-17
# Shocks (WEEK_MONEY): (id, weekly odds, lo, hi, needs: "car" | "job" | None, text)
BAD = (("car_repair", 0.02, 300, 1200, "car", "pays ${a} for car repairs"),
       ("appliance", 0.015, 200, 600, None, "replaces a broken appliance for ${a}"),
       ("dentist", 0.015, 100, 800, None, "has a ${a} dentist's bill"),
       ("phone", 0.01, 150, 400, None, "replaces a broken phone for ${a}"),
       ("fine", 0.01, 80, 200, "car", "gets a ${a} traffic fine"),
       ("burglary", 0.003, 300, 1500, None, "is burgled and loses ${a}"))
GOOD = (("bonus", 0.012, 200, 800, "job", "gets a ${a} bonus at work"),
        ("scratch_card", 0.003, 100, 3000, None, "wins ${a} on a scratch card"),
        ("tax_refund", 0.01, 150, 600, None, "gets a ${a} tax refund"),
        ("sold", 0.01, 50, 300, None, "sells something online for ${a}"),
        ("gift", 0.005, 100, 500, None, "gets a ${a} gift from family"))


def weekly(sim, p) -> None:
    """`p`'s money week (an adult's Sunday slot). Skeleton: nothing (v2)."""
    return None

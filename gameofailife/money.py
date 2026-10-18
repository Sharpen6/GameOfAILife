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


def _income(sim, p) -> float:
    """`p`'s take-home pay for a full week of shifts (housing.weekly_income's rule for one adult), else the pension
    at 65+ with no job, else nothing (the benefit is added by `weekly`)."""
    from . import housing
    from .sim import PENSION, income_tax

    job = p.job
    if job is not None and job.hourly_wage > 0:
        hours = (job.end_hour - job.start_hour) % 24 * len(job.workdays)
        return job.hourly_wage * hours * (1 - income_tax(job.hourly_wage))
    if housing.retired(p):
        return PENSION
    return 0.0


def _importance(sim, p, amount: int) -> int:
    """Named: 0 under $300, 1, 2 from $2,000; folk: 0 under $1,000, 1, 2 from $5,000 (life.md 5.8)."""
    if p.id in sim.agents:
        return 2 if amount >= 2000 else 1 if amount >= 300 else 0
    return 2 if amount >= 5000 else 1 if amount >= 1000 else 0


def _shock(sim, p, rr, table, valence: int, what: str) -> int:
    """One roll on the sum of the eligible shocks' odds (luck-shifted, logged), then a plain draw by weight;
    returns the amount (0 for none)."""
    from . import life

    rows = []
    total = 0.0
    for row in table:
        need = row[4]
        if need == "car" and not p.owns_car:
            continue
        if need == "job" and not (p.job is not None and p.job.hourly_wage > 0):
            continue
        rows.append(row)
        total += row[1]
    if not rows or not life._hit(sim, p, what, total, valence, rr):
        return 0
    x = rr.random() * total
    i = 0
    while i < len(rows) - 1 and x >= rows[i][1]:
        x -= rows[i][1]
        i += 1
    row = rows[i]
    amount = rr.int(row[2], row[3])
    p.money += amount * valence
    tag = "windfall" if valence > 0 else "expense"
    text = row[5].replace("${a}", f"${amount:,}")
    life._event(sim, p, f"{p.name} {text}.", tag, _importance(sim, p, amount))
    return amount


def weekly(sim, p) -> None:
    """`p`'s money week (an adult's Sunday slot, life.md 5.8): the benefit; lifestyle spending; one bad and one
    good shock; interest on debt; treated chronic conditions; and, for the household's richest adult, the
    children's costs."""
    from . import career, dice, housing, people

    life = p.life
    if life is None:
        return
    benefit = career.benefit(sim, p)
    if benefit:
        p.money += benefit
    pay = _income(sim, p) + benefit
    t = people.traits(p)
    target = (LIFESTYLE_BASE + LIFESTYLE_THRIFT * (1 - t["thrift"]) + LIFESTYLE_ADVENTURE * (t["adventure"] - 0.5)) \
        * pay
    if life.pay == 0.0 and life.lifestyle == 0.0:
        life.lifestyle = target
    elif target > life.lifestyle:
        life.lifestyle += LIFESTYLE_UP * (target - life.lifestyle)
    else:
        life.lifestyle -= LIFESTYLE_DOWN * (life.lifestyle - target)
    life.pay = pay
    spend = life.lifestyle
    hh = people.household(sim, p)
    adults = [m for m in people.members(sim, p) if m.is_adult]
    if hh is not None and p.id in sim.agents:
        spare = housing.funds(sim, hh) - 10 * housing.weekly_outgo(sim, hh)
        if spare > 0:
            spend += WEALTH_SPEND * spare / max(1, len(adults))
        tight = hh.tight_until > sim.clock.tick
    else:
        spare = p.money + p.savings - 10 * 2 * pay
        if spare > 0:
            spend += WEALTH_SPEND * spare
        tight = life.tight_until > sim.clock.tick
    if tight:
        spend *= 0.5
    p.money -= spend
    rr = dice.stream(people.dice_seed(sim), dice.WEEK_MONEY, p.id, sim.clock.day)
    _shock(sim, p, rr, BAD, -1, "shock_bad")
    _shock(sim, p, rr, GOOD, +1, "shock_good")
    p.money -= CHRONIC_COST * len(life.treated)
    richest = None
    for a in adults:
        if richest is None or a.money + a.savings > richest.money + richest.savings:
            richest = a
    if richest is p:
        for k in people.members(sim, p):
            if k.age < 18:
                for under, cost in CHILD_COST:
                    if k.age < under:
                        p.money -= cost
                        break
    worth = p.money + p.savings
    if worth < 0:
        p.money -= DEBT_RATE * -worth
    if p.money < 0 < p.savings:
        take = min(p.savings, -p.money)
        p.savings -= take
        p.money += take

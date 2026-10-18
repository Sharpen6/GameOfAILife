"""Townsfolk money and households (folk.md 6, PLAN 2.3 and 2.5): pay at shift end, Friday pensions, Sunday rent and
bills, saving, arrears, and household joins, splits and leaving town; the folk side of birthdays (school at 5, Riverton
High at 11, school ends at 18) and the folk homes' moves.

folk_life never rolls illness, death or births, ages anyone, hires, fires or promotes (life, career and money own
those for both tiers). `folk.py` (F2a) calls `pay_shift` at every folk shift end and delegates `pensions`, `weekly`,
`new_household`, `on_household_empty`, `join`, `split`, `release` and `on_birthday` here. Money is kept in cents
(`r2`), so each household's books balance to the cent. Nothing here draws `sim.rng`.
"""

from __future__ import annotations

import math

from . import housing
from .folk_model import FolkHousehold, household_id
from .rng import r2

BILLS_PER_ADULT = 80.0  # sim.BILLS_PER_ADULT
CAR_BILL = 40.0  # sim.CAR_BILL
PENSION = 400.0  # sim.PENSION: Friday 09:00, to folk 65+ without a job
PENSION_AGE = 65
SAVE_BASE, SAVE_THRIFT = 0.1, 0.4  # each adult saves (.1 + .4 thrift) x max(0, money - 2 weekly outgo)
ARREARS_MOVE = 3  # Sundays in the red: move somewhere cheaper, else leave town
FORCED_PER_BEDROOM = 3  # a forced move may crowd up to 3 a bedroom
FIX_FACTOR = 2  # an emergency is fixed once the household holds twice its cost
RENT_SHARE = 0.45  # a rental is affordable at most this share of weekly income ...
RENT_WEEKS = 12  # ... or with this many weeks of its rent in hand
SCHOOL_AGE, TEEN_AGE, ADULT_AGE = 5, 11, 18
PARENT_GAP = 16


def _folk(sim):
    return sim.folk


def _sim_of(folk):
    return folk.sim


def _cents(x: float) -> int:
    return math.floor(x * 100 + 0.5)


def _income_tax(wage: float) -> float:
    return min(0.45, 0.15 + 0.004 * wage)  # sim.income_tax


def _shift_hours(job) -> int:
    h = job.end_hour - job.start_hour
    return h if h > 0 else h + 24


def _here(p) -> bool:
    return p is not None and p.alive and not p.gone


def members(folk, hh) -> list:
    """The household's people still alive and in town, in member order."""
    out = []
    for pid in hh.member_ids:
        p = folk.person(pid)
        if _here(p):
            out.append(p)
    return out


def adults(folk, hh) -> list:
    return [p for p in members(folk, hh) if p.age >= ADULT_AGE]


def funds(folk, hh) -> float:
    total = 0.0
    for p in adults(folk, hh):
        total += p.money + p.savings
    return r2(total)


def weekly_income(p) -> float:
    """Take-home pay for a full week of shifts, or the pension."""
    job = p.job
    if job is not None and job.hourly_wage > 0:
        return job.hourly_wage * _shift_hours(job) * len(job.workdays) * (1 - _income_tax(job.hourly_wage))
    if p.age >= PENSION_AGE:
        return PENSION
    return 0.0


def _pay(p, amount: float) -> None:
    """Take `amount` from cash, then savings (cash may go below zero)."""
    p.money = r2(p.money - amount)
    if p.money < 0 < p.savings:
        move = min(p.savings, -p.money)
        p.savings = r2(p.savings - move)
        p.money = r2(p.money + move)


# --- pay, pensions, the Sunday charges ----------------------------------------------------------------------------

def pay_shift(sim, p) -> float:
    """A shift's take-home pay at its end: wage x hours x (1 - income tax)."""
    job = p.job
    if job is None or job.hourly_wage <= 0 or not _here(p):
        return 0.0
    pay = r2(job.hourly_wage * _shift_hours(job) * (1 - _income_tax(job.hourly_wage)))
    p.money = r2(p.money + pay)
    p.worked_day = sim.clock.day
    return pay


def pensions(sim) -> None:
    """Friday 09:00: the pension to every townsperson 65 or over without a paid job."""
    folk = _folk(sim)
    for p in folk.people:
        if _here(p) and p.age >= PENSION_AGE and (p.job is None or p.job.hourly_wage <= 0):
            p.money = r2(p.money + PENSION)


def weekly(sim) -> None:
    """Sunday 23:00, after housing.weekly_charges, for every folk household with an adult: housing (rent, hardship
    rent or property tax) split by the adults to the cent, bills, savings covering a negative balance, v2's arrears
    rule (silent), saving, then an emergency fixed once affordable twice over. Three Sundays in arrears: a cheaper
    rental at up to 3 a bedroom, else the household leaves town."""
    folk = _folk(sim)
    now = sim.clock.tick
    for hh in list(folk.households):
        if hh.gone:
            continue
        payers = adults(folk, hh)
        if not payers:
            continue
        home = sim.homes[hh.home_id]
        charge = housing.weekly_cost(sim, hh)
        n = len(payers)
        c = _cents(charge)
        base, extra = c // n, c % n
        for k, p in enumerate(payers):
            share = (base + (1 if k < extra else 0)) / 100
            p.money = r2(p.money - share - BILLS_PER_ADULT - (CAR_BILL if p.owns_car else 0.0))
        for p in payers:
            if p.money < 0 < p.savings:
                move = min(p.savings, -p.money)
                p.savings = r2(p.savings - move)
                p.money = r2(p.money + move)
        f = funds(folk, hh)
        if f >= 0:
            hh.arrears = 0
            hh.clean_sundays += 1
        else:
            hh.clean_sundays = 0
            if hh.grace_until > now:
                pass
            elif hh.arrears > 0 and hh.last_funds is not None and f >= hh.last_funds + housing.ARREARS_PROGRESS:
                pass
            else:
                hh.arrears += 1
        hh.last_funds = f
        if hh.clean_sundays >= 2:
            hh.hardship_rent = None
            hh.tax_deferred = False
        if hh.arrears >= ARREARS_MOVE:
            fall_behind(sim, hh)
            continue
        outgo = housing.weekly_outgo(sim, hh)
        share = outgo / n
        for p in payers:
            t = p.traits.get("thrift", 0.5)
            amount = r2((SAVE_BASE + SAVE_THRIFT * t) * max(0.0, p.money - 2 * share))
            if amount > 0:
                p.money = r2(p.money - amount)
                p.savings = r2(p.savings + amount)
        live = home.emergency
        if live is not None and home.household == hh.id:
            cost = housing.TIERS[home.tier]["emergency_cost"]
            if funds(folk, hh) >= FIX_FACTOR * cost:
                payer = richest(payers)
                _pay(payer, cost)
                housing.fix_emergency(sim, hh)


def richest(people: list):
    best = None
    for p in people:
        if best is None or p.money + p.savings > best.money + best.savings:
            best = p
    return best


def fall_behind(sim, hh) -> None:
    """Three Sundays in the red: the cheapest vacant rental cheaper than today's that fits at 3 a bedroom, else
    everyone leaves town."""
    folk = _folk(sim)
    mem = members(folk, hh)
    home = sim.homes[hh.home_id]
    now_cost = housing.weekly_cost(sim, hh) if home.owner != hh.id else math.inf
    best = None
    for h in vacancies(sim):
        if h.listing != "for_rent" or h.owner != "landlord":
            continue
        if FORCED_PER_BEDROOM * h.bedrooms < len(mem) or h.rent >= now_cost:
            continue
        if best is None or (h.rent, h.id) < (best.rent, best.id):
            best = h
    if best is not None:
        folk_move(sim, hh, best.id, "rent")
        hh.arrears = 0
        hh.last_funds = None
        return
    ids = [p.id for p in mem]
    names = ", ".join(p.name for p in mem)
    for p in mem:
        release(sim, p, quiet=True)
    _left_event(sim, hh, ids, f"{names} can no longer pay for {home.name} and leave town.")


# --- birthdays ----------------------------------------------------------------------------------------------------

def on_birthday(sim, p) -> None:
    """After life's birthday (p.age already the new age): school at 5 (the nearest region school with seats),
    Riverton High at 11 when it has seats, school ends at 18 (job None: career's hiring applies). folk.on_job_change
    follows from life."""
    from . import folk_gen
    if p.age == SCHOOL_AGE and p.job is None:
        school = nearest_school(sim, p)
        if school is not None:
            p.job = folk_gen.student_job(p.age, school)
    elif p.age == TEEN_AGE and p.job is not None and p.job.title == "student":
        high = folk_gen.HIGH_SCHOOL
        if (p.job.place_id != high and p.job.place_id not in (sim.town.millbrook_ids or ())
                and high in sim.town.places and _seats(sim, high) > 0):
            p.job = folk_gen.student_job(p.age, high)
        else:
            p.job = folk_gen.student_job(p.age, p.job.place_id)
    elif p.job is not None and p.job.title == "student" and p.age < ADULT_AGE:
        p.job = folk_gen.student_job(p.age, p.job.place_id)  # school hours by age
    elif p.age >= ADULT_AGE and p.job is not None and p.job.title == "student":
        p.job = None
        p.commute = None


def _seats(sim, pid: str) -> int:
    from . import folk_gen
    cap = getattr(sim.town.places[pid], "capacity", 0) or folk_gen.SCHOOL_SEATS
    for a in sim.agents.values():
        if a.alive and a.job is not None and a.job.title == "student" and a.job.place_id == pid:
            cap -= 1
    for q in _folk(sim).people:
        if _here(q) and q.job is not None and q.job.title == "student" and q.job.place_id == pid:
            cap -= 1
    return cap


def nearest_school(sim, p) -> str | None:
    """The nearest region school with seats from p's home, on foot (Millbrook's school only for the 40 at the start)."""
    from . import roads
    folk = _folk(sim)
    hh = folk.household(p.household_id)
    home = sim.homes[hh.home_id].place
    net = roads.net(sim.town)
    mb = sim.town.millbrook_ids or frozenset()
    best = None
    for pid, pl in sim.town.places.items():
        if pl.kind != "school" or pid in mb or _seats(sim, pid) <= 0:
            continue
        key = (net.minutes(home, pid, "walk"), pid)
        if best is None or key < best:
            best = key
    return best[1] if best is not None else None


# --- households: join, split, leave -------------------------------------------------------------------------------

def _kids_of(folk, hh, p) -> list:
    """p's under-18s in hh: family ties 16+ years younger, or every under-18 when p is the last adult."""
    mem = members(folk, hh)
    left = [q for q in mem if q.age >= ADULT_AGE and q is not p]
    out = []
    for q in mem:
        if q is p or q.age >= ADULT_AGE:
            continue
        r = p.relationships.get(q.id)
        kind = getattr(getattr(r, "kind", None), "value", getattr(r, "kind", None))
        if not left or (kind == "family" and p.age - q.age >= PARENT_GAP):
            out.append(q)
    return out


def _move_people(folk, people: list, dst) -> None:
    """Move people into household dst, emptying (and vacating) the households they leave."""
    left = []
    for p in people:
        src = folk.household(p.household_id)
        if src is dst:
            continue
        if src is not None and p.id in src.member_ids:
            src.member_ids.remove(p.id)
        if src is not None and src not in left:
            left.append(src)
        p.household_id = dst.id
        p.hh = dst.j
        dst.member_ids.append(p.id)
    for src in left:
        if not members(folk, src):
            on_household_empty(folk, src)
    _touch(folk)


def join(sim, p, host) -> None:
    """p and p's under-18s join host's household; a home left empty is vacated."""
    folk = _folk(sim)
    src = folk.household(p.household_id)
    dst = folk.household(host.household_id)
    if dst is None or src is dst:
        return
    movers = [p] + (_kids_of(folk, src, p) if src is not None else [])
    _move_people(folk, movers, dst)
    _refresh(sim, movers)


def split(sim, p) -> bool:
    """p (and p's under-18s when nobody else would look after them) leaves the household: the cheapest affordable
    vacant rental, else a parent's household, else town. True while p stays in town."""
    folk = _folk(sim)
    src = folk.household(p.household_id)
    if src is None or not _here(p):
        return False
    kids = _kids_of(folk, src, p)
    others = [q for q in adults(folk, src) if q is not p]
    if others:
        kids = []  # the children stay with the other adult
    if len(members(folk, src)) == 1 + len(kids):
        return True  # nobody to split from
    home = cheapest_rental(sim, p, 1 + len(kids))
    if home is not None:
        new_household(folk, [p.id] + [q.id for q in kids], home.id, "rent")
        return True
    parent = None
    for oid in sorted(p.relationships):
        q = folk.person(oid)
        if not _here(q) or q.household_id == p.household_id:
            continue
        r = p.relationships[oid]
        kind = getattr(r.kind, "value", r.kind)
        if kind == "family" and q.age - p.age >= PARENT_GAP:
            parent = q
            break
    if parent is not None:
        join(sim, p, parent)
        return True
    ids = [p.id] + [q.id for q in kids]
    for q in [p] + kids:
        release(sim, q, quiet=True)
    _left_event(sim, src, ids, f"{p.name} leaves town.")
    return False


def cheapest_rental(sim, p, people: int):
    """The cheapest vacant region rental that fits `people` at 2 a bedroom and p can afford: rent at most 45% of
    weekly income, or 12 weeks of rent in hand."""
    income = weekly_income(p)
    have = p.money + p.savings
    best = None
    for h in vacancies(sim):
        if h.listing != "for_rent" or h.owner != "landlord" or 2 * h.bedrooms < people:
            continue
        if h.rent > RENT_SHARE * income and have < RENT_WEEKS * h.rent:
            continue
        if best is None or (h.rent, h.id) < (best.rent, best.id):
            best = h
    return best


def release(sim, p, quiet: bool = False) -> None:
    """p leaves town: gone, job slot freed, off the wheel and occupancy (folk.kill), an emptied home vacated, and a
    `left_town` event (importance 1) unless `quiet`."""
    if p.gone or not p.alive:
        return
    folk = _folk(sim)
    p.gone = True
    job = p.job
    slot = getattr(job, "slot", -1) if job is not None else -1
    if job is not None and job.hourly_wage > 0 and slot is not None and slot >= 0:
        from . import folk_gen
        b = folk_gen.board(sim)
        if slot < len(b.holder) and b.holder[slot] == p.id:
            b.free(slot)
    kill = _folk_fn("kill")
    if kill is not None and hasattr(folk, "wheel"):  # folk.py's Folk (not generation's GenFolk)
        kill(sim, p, "left_town")
    p.trip = None
    p.inside = None
    p.activity, p.state = "away", "idle"
    hh = folk.household(p.household_id)
    if hh is not None and not members(folk, hh):
        on_household_empty(folk, hh)
    _touch(folk)
    if not quiet:
        _left_event(sim, hh, [p.id], f"{p.name} leaves town.")


def _left_event(sim, hh, ids: list, text: str) -> None:
    place = sim.homes[hh.home_id].place if hh is not None and hh.home_id in sim.homes else None
    sim.event(text, None, tag="left_town", agents=ids, place=place)


def _folk_fn(name: str):
    try:
        from . import folk
    except ImportError:
        return None
    return getattr(folk, name, None)


def _refresh(sim, people: list) -> None:
    """A new home or household: folk.on_job_change refreshes each one's commute."""
    fn = _folk_fn("on_job_change")
    if fn is None or not hasattr(_folk(sim), "wheel"):
        return
    for p in people:
        fn(sim, p)


def _touch(folk) -> None:
    if hasattr(folk, "v"):
        folk.v += 1


# --- homes --------------------------------------------------------------------------------------------------------

def vacancies(sim) -> list:
    """Vacant, listed region homes in town order."""
    v2 = _v2_ids()
    out = []
    for h in sim.homes.values():
        if h.id not in v2 and h.household is None and h.listing is not None:
            out.append(h)
    return out


_V2 = []


def _v2_ids() -> set:
    if not _V2:
        _V2.append({spec[0] for spec in housing.HOME_SPECS})
    return _V2[0]


def new_household(folk, member_ids: list, home_id, how: str):
    """Move `member_ids` (ids or people, the first the head) out of their households into vacant `home_id` (None:
    the cheapest fitting rental) as a new household; `how` "rent" or "buy". None when no home is free."""
    sim = _sim_of(folk)
    people = []
    for m in member_ids:
        p = folk.person(m) if isinstance(m, str) else m
        if p is not None:
            people.append(p)
    if not people:
        return None
    if home_id is None:
        h = cheapest_rental(sim, people[0], len(people))
        if h is None:
            return None
        home_id, how = h.id, "rent"
    home = sim.homes.get(home_id)
    if home is None or home.household is not None:
        return None
    j = len(folk.households)
    hh = FolkHousehold(id=household_id(j), home_id="", weekly_rent=0.0, j=j)
    hh.kind = "split"
    hh.u = 0.5
    folk.households.append(hh)
    _move_people(folk, people, hh)
    folk_move(sim, hh, home_id, how)
    _refresh(sim, people)
    return hh


def on_household_empty(folk, hh) -> None:
    """Nobody left in town: the household is gone and its home vacated."""
    if hh.gone:
        return
    hh.gone = True
    folk_vacate(_sim_of(folk), hh)


def folk_move(sim, hh, home_id: str, how: str) -> None:
    """hh moves into vacant `home_id` (renting at its listed rent, or buying at its value), leaving its old home."""
    folk = _folk(sim)
    home = sim.homes[home_id]
    now, stamp = sim.clock.tick, sim.clock.stamp()
    if hh.home_id and hh.home_id in sim.homes:
        _leave_home(sim, hh, sell=True)
    hh.home_id = home_id
    home.household = hh.id
    home.listing = None
    if how == "buy":
        price = housing.value(sim, home_id)
        payer = richest(adults(folk, hh))
        if payer is not None:
            _pay(payer, price)
        home.owner = hh.id
        hh.weekly_rent = 0.0
    else:
        hh.weekly_rent = float(home.rent)
    hh.moved_tick = now
    hh.hardship_rent = None
    housing._history(home.history, {"tick": now, "time": stamp, "event": "moved_in", "household": hh.id,
                                    "price": None})
    housing._history(hh.history, {"tick": now, "time": stamp, "event": "moved_in", "home": home.id,
                                  "name": home.name, "price": None})
    _list(sim)
    _touch(folk)


def folk_vacate(sim, hh) -> None:
    """hh's home is left empty (an owner's goes on the market)."""
    _leave_home(sim, hh, sell=False)
    _list(sim)
    _touch(_folk(sim))


def _leave_home(sim, hh, sell: bool) -> None:
    home = sim.homes.get(hh.home_id)
    if home is None or home.household != hh.id:
        return
    now, stamp = sim.clock.tick, sim.clock.stamp()
    if home.owner == hh.id:
        if sell:
            payer = richest(adults(_folk(sim), hh))
            if payer is not None:
                payer.money = r2(payer.money + housing.sale_proceeds(sim, home.id))
        home.owner = "market"
    home.household = None
    home.pending_emergency = None
    home.emergency = None
    housing._history(home.history, {"tick": now, "time": stamp, "event": "left", "household": hh.id, "price": None})
    housing._history(hh.history, {"tick": now, "time": stamp, "event": "left", "home": home.id, "name": home.name,
                                  "price": None})


def _list(sim) -> None:
    fn = getattr(housing, "list_vacancies", None)
    if fn is not None:
        fn(sim)

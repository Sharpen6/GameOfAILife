"""Homes: the 37 dwellings of Millbrook, who owns and lives in them, their condition, and household money.

Group A is the data, the read-side helpers and the serializers. Group B is the mechanics behind the hooks the
simulation calls: the Sunday charges (rent or property tax, bills, arrears, hardship rent, tax deferral and
forced moves), nightly decay with the landlord's repairs and the neglect stages, emergencies (rolled at night,
hidden until they go live), moves, deaths, the housing extras and effects of fork options, home comfort and the
money term of the Director's default scores. The four housing forks are built in `housing_forks.py`.

Vocabulary: a Home is one dwelling (a house, or one flat of an apartment block); a Lot is the building a home
stands on (one per residential place) and holds its condition. Owners are "landlord" (Millbrook Homes),
"market" (vacant and for sale) or a household id. Everything is keyed by string ids and kept in plain
fields, so the JS port mirrors it one to one.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from . import travel
from .clock import Clock
from .rng import r2
from .town import DISTRICT_NAMES

if TYPE_CHECKING:
    from .agent import Agent, Household
    from .town import TownMap

# --- constants -----------------------------------------------------------------

TIERS = {
    "flat": {"label": "flat", "rank": 1, "decay": 1.0, "comfort": 0.95},
    "house": {"label": "house", "rank": 2, "decay": 1.5, "comfort": 1.00, "pro_rate": 6, "diy_pts": 18,
              "diy_cost": 50, "tidy_cost": 10, "emergency_p": 0.015, "emergency_cost": 180, "parts": 30,
              "upkeep_est": 70},
    "big_house": {"label": "big house", "rank": 3, "decay": 2.0, "comfort": 1.15, "pro_rate": 15, "diy_pts": 16,
                  "diy_cost": 120, "tidy_cost": 25, "emergency_p": 0.02, "emergency_cost": 300, "parts": 50,
                  "upkeep_est": 230},
}
STAGES = [("kept", 80), ("worn", 60), ("shabby", 40), ("neglected", 20), ("derelict", 0)]  # index = stage
STAGE_COMFORT = [1.05, 1.00, 0.92, 0.80, 0.65]
LANDLORD = "Millbrook Homes"
LANDLORD_FLOOR = {"flat": 45, "house": 60}  # the landlord repairs a let building below this ...
LANDLORD_RESTORE = 85  # ... back up to this
VACANT_DECAY = 0.7  # per day, any tier, nobody living there
MARKET_FLOOR = 20  # a home held for sale never drops below "neglected"
NEWS_SETTLE_DAYS = 1  # a home's poor stage is not news until its household has lived there this long
LANDLORD_SELLS_DAYS = 14  # with no other house for sale this long, the landlord sells a let house left empty
NOTICE_FROM_DAY = 120  # from this game day, while no house is for sale (house_drought), the landlord sells a let house
NOTICE_DAYS = 14  # ... with notice: the tenants have this long to move out, and then it goes on the market ...
NOTICE_GAP_DAYS = 30  # ... at most once in this many days in the town ...
NOTICE_SETTLED_DAYS = 120  # ... and never to tenants who moved in less than this long ago
NOTICE_MIN_DAYS = 7  # when tenants buy the house, the next notice keeps its sale date but gives at least this long
NOTICE_HOUR = 9  # it gives notice (but at once after tenants buy), and lists a house whose notice ran out, at this hour
WINTER_DECAY = 1.25
CROWD_DECAY = 0.10  # +10% decay per resident beyond two
EMERGENCY_DECAY = 4.0  # extra decay per day while an emergency is unfixed
PROPERTY_TAX = 0.005  # of base value, weekly, owners only
SALE_FEE = 0.05  # a seller gets value x 0.95
MOVING_COST = 150
CALLOUT = 40  # added to every builders' quote
RENO_FACTOR = 2.0  # per-point price multiplier when condition < 50 (a full renovation)
RESERVE_WEEKS = 6
MOVE_GAP_DAYS = 28
DOWNSIZE_SHARE = 0.8  # an owner downsizes to a home worth at most this share of today's ...
DOWNSIZE_CONDITION = 50  # ... in at least this condition
SPARE_BEDROOMS = 2  # an owner household with this many more bedrooms than residents has outgrown its home
CAR_SALE = 2500
EMERGENCY_DAYS = 3
LIVING_PER_PERSON = 75  # weekly living estimate (affordability, hardship)
LIVING_PER_RETIREE = 150
ARREARS_PROGRESS = 50
HARDSHIP_REPAY = 100
FORCED_CROWDING = 3  # residents per bedroom allowed in a forced move
STUFF_DAYS = 28
GRACE_DAYS = 28
GRACE_HOLD_DAYS = 14
ODD_JOBS_DAYS = 7
ODD_JOBS_PAY = 100
STUFF_PRICE = 300

EMERGENCY_KINDS = ("leak", "boiler", "roof", "electrics")
EMERGENCY_TEXT = {"leak": "A pipe has burst in the kitchen.", "boiler": "The boiler has broken down.",
                  "roof": "The roof is letting the rain in.", "electrics": "The electrics keep tripping."}

DAY = 24 * 60  # minutes
MOVE_VAN_MINUTES = 180  # the moving van stays at the curb this long after a move
LANDLORD_WORKS_MINUTES = 8 * 60  # builders on site while the landlord repaints
RENOVATE_WORKS_MINUTES = 4 * 60  # builders on site doing up a home bought run-down
UNDER_OFFER_DAYS = 3  # a listing another buyer snapped up is off the market this long
OFFER_HOLD_MINUTES = 6 * 60  # a listing is held for a household's offer until the answer lands, at most this long
SETTLE_DAMAGE = 10  # condition lost when an emergency is never properly fixed, or left behind in a move
EMERGENCY_STAGE_P = {2: 0.015, 3: 0.045, 4: 0.045}  # extra nightly emergency odds of a shabby or worse home
WINTER_EMERGENCY = 1.5
DAMP_HEALTH = {3: 0.3, 4: 1.0}  # health lost a night by residents of a neglected or derelict home
DAMP_CHILL = {3: 0.02, 4: 0.06}  # nightly odds of catching a chill there (doubled in winter, like the health loss)
CHILL = {"health": -8, "fun": -6}
STAGE_REPUTATION = [0, 0, -1, -2, -3]  # each resident, every Sunday
KEPT_BIG_HOUSE_PRIDE = 1  # owners of a kept big house: people talk
# Stage news, owner-occupied homes only: stage -> (tag, text).
STAGE_NEWS = {2: ("shabby", "{home} is looking shabby."), 3: ("neglect", "{home} is falling into neglect."),
              4: ("falling_apart", "{home} is close to falling apart.")}
EMERGENCY_NEWS = {"leak": "A pipe bursts in the kitchen at {home}.", "boiler": "The boiler at {home} breaks down.",
                  "roof": "Rain is coming in through the roof at {home}.",
                  "electrics": "The electrics at {home} keep tripping out."}
EMERGENCY_NAME = {"leak": "leak", "boiler": "broken boiler", "roof": "leaking roof", "electrics": "electrical fault"}
ORDINALS = ["first", "second", "third", "fourth", "fifth"]

# The 37 homes, in town.homes order. start: "let" (a tenant household, landlord owner), "owned"
# (owner-occupied), "for_rent" (vacant, landlord) or "for_sale" (vacant, market). rent is the weekly rent
# of a landlord-owned home, else 0. A house's condition is its lot's; flats take LOT_CONDITION.
HOME_SPECS = [
    # id, place, unit, tier, bedrooms, base_value, rent, start, condition
    ("birch_court_1a", "birch_court", "1A", "flat", 1, 7200, 180, "let", None),
    ("birch_court_1b", "birch_court", "1B", "flat", 2, 8800, 220, "let", None),
    ("birch_court_2a", "birch_court", "2A", "flat", 1, 7200, 180, "let", None),
    ("birch_court_2b", "birch_court", "2B", "flat", 2, 8800, 220, "let", None),
    ("birch_court_3a", "birch_court", "3A", "flat", 2, 8800, 220, "let", None),
    ("birch_court_3b", "birch_court", "3B", "flat", 3, 10400, 260, "let", None),
    ("cedar_court_1a", "cedar_court", "1A", "flat", 1, 7200, 180, "let", None),
    ("cedar_court_1b", "cedar_court", "1B", "flat", 2, 8800, 220, "let", None),
    ("cedar_court_2a", "cedar_court", "2A", "flat", 1, 7200, 180, "let", None),
    ("cedar_court_2b", "cedar_court", "2B", "flat", 2, 8800, 220, "let", None),
    ("cedar_court_3a", "cedar_court", "3A", "flat", 2, 8800, 220, "let", None),
    ("cedar_court_3b", "cedar_court", "3B", "flat", 3, 10400, 260, "for_rent", None),
    ("elm_court_1a", "elm_court", "1A", "flat", 1, 7200, 180, "for_rent", None),
    ("elm_court_1b", "elm_court", "1B", "flat", 2, 8800, 220, "let", None),
    ("elm_court_2a", "elm_court", "2A", "flat", 1, 7200, 180, "let", None),
    ("elm_court_2b", "elm_court", "2B", "flat", 2, 8800, 220, "for_rent", None),
    ("elm_court_3a", "elm_court", "3A", "flat", 2, 8800, 220, "for_rent", None),
    ("elm_court_3b", "elm_court", "3B", "flat", 3, 10400, 260, "let", None),
    ("park_13", "park_13", None, "house", 4, 19600, 0, "owned", 80),
    ("park_21", "park_21", None, "house", 3, 19200, 0, "owned", 90),
    ("park_29", "park_29", None, "house", 3, 16000, 400, "let", 84),
    ("main_12", "main_12", None, "house", 2, 13600, 0, "owned", 57),
    ("main_20", "main_20", None, "house", 3, 16800, 420, "let", 82),
    ("main_28", "main_28", None, "house", 3, 15200, 0, "owned", 66),
    ("main_13", "main_13", None, "house", 4, 20800, 520, "let", 85),
    ("main_21", "main_21", None, "house", 3, 16400, 410, "let", 80),
    ("main_29", "main_29", None, "house", 3, 16800, 0, "owned", 75),
    ("river_12", "river_12", None, "house", 2, 13200, 0, "for_sale", 58),
    ("river_20", "river_20", None, "house", 3, 15600, 390, "let", 80),
    ("river_28", "river_28", None, "house", 3, 18400, 0, "for_sale", 30),
    ("main_39", "main_39", None, "house", 2, 13200, 330, "for_rent", 85),
    ("main_47", "main_47", None, "house", 3, 16000, 400, "let", 78),
    ("main_55", "main_55", None, "house", 4, 20000, 0, "for_sale", 68),
    ("park_66", "park_66", None, "big_house", 5, 46000, 0, "for_sale", 92),
    ("park_78", "park_78", None, "big_house", 5, 36000, 0, "owned", 62),
    ("park_92", "park_92", None, "big_house", 5, 44000, 0, "owned", 88),
    ("park_104", "park_104", None, "big_house", 5, 40000, 0, "for_sale", 70),
]
LOT_CONDITION = {"birch_court": 84, "cedar_court": 71, "elm_court": 62}  # apartment blocks at the start
START_OWNER = {"let": "landlord", "owned": None, "for_rent": "landlord", "for_sale": "market"}  # owned: the household
START_LISTING = {"let": None, "owned": None, "for_rent": "for_rent", "for_sale": "for_sale"}

# Activities the housing forks use, merged into sim.ACTIVITIES as Activity(minutes, gains, inside).
# None of them is leisure.
ACTIVITIES_EXTRA = {
    "move_house": {"minutes": 120, "gains": {"fun": 10, "energy": -15}, "inside": True},
    "viewing": {"minutes": 45, "gains": {"fun": 5}, "inside": True},
    "let_builders_in": {"minutes": 30, "gains": {"fun": 5}, "inside": True},
    "diy": {"minutes": 180, "gains": {"fun": 10, "energy": -20}, "inside": True},
    "tidy": {"minutes": 60, "gains": {"fun": 5}, "inside": True},
    "fix_it": {"minutes": 120, "gains": {"fun": 5, "energy": -10}, "inside": True},
    "help_out": {"minutes": 90, "gains": {"social": 20}, "inside": True},
    "odd_jobs": {"minutes": 180, "gains": {"energy": -15}, "inside": False},
}


@dataclass(eq=False)
class Home:
    # Static: never changes after build_homes.
    id: str  # a house's place id, or "<block>_<unit lowercase>" for a flat
    place: str
    unit: str | None  # "1A" ... "3B" for a flat (1A and 1B on the ground floor), None for a house
    name: str  # "20 Main Street" or "Birch Court, flat 2B"
    tier: str  # "flat", "house" or "big_house"
    bedrooms: int
    base_value: int
    rent: int  # weekly rent while the landlord owns it, else 0
    start: str  # "let", "owned", "for_rent" or "for_sale"
    # Dynamic.
    owner: str | None = None  # "landlord", "market" or a household id
    household: str | None = None  # who lives there
    listing: str | None = None  # None, "for_sale" or "for_rent"
    under_offer_until: int = 0  # tick a listing shows again after another buyer's offer
    held_for: str | None = None  # the household whose offer holds it while under offer (None: another buyer)
    pending_emergency: dict | None = None  # hidden {"kind", "due"}: never serialised
    emergency: dict | None = None  # live {"kind", "since"}: public
    history: list[dict] = field(default_factory=list)  # {"tick", "time", "event", "household", "price"}; "off_market"
    # on the "bought" row of a let house its tenants bought from the landlord (`buy_let_home`)
    # The owner household's adults' shares of the home, adult id -> share summing to 1: what each one paid of the
    # price when the household bought it. Empty (equal shares) for a home a household had at the start, or one
    # nobody paid for; emptied when the home goes back on the market.
    shares: dict[str, float] = field(default_factory=dict)
    # The landlord's notice on a let house it is selling, {"household", "since", "due"} (ticks): the tenants move out
    # by "due" and the house goes on the market then (`give_notice`), unless they buy it. `noticed` is NOTICE_DAYS
    # before the sale of the last notice given here (when it was given, unless it took over the date of a sale the
    # tenants bought out), kept after that and moved on a day for each day its sale waits for the tenants to go, so
    # the landlord's sales are NOTICE_GAP_DAYS apart (`landlord_notices`); cleared when the tenants buy the house.
    notice: dict | None = None
    noticed: int | None = None


@dataclass(eq=False)
class Lot:
    place: str  # a residential place id
    condition: float  # 0-100
    works_until: int = 0  # builders on site until this tick
    moving_until: int = 0  # a moving van at the curb until this tick
    reported: int = 0  # worst stage already announced; starts at the current stage, back to it at stage 0-1
    worst: int = 0  # worst stage since the lot was last kept (stage 0), for "looks as good as new"


def build_homes(town: TownMap) -> dict[str, Home]:
    """Every home in HOME_SPECS order, unoccupied; `init(sim)` moves the cast in."""
    homes = {}
    for hid, place_id, unit, tier, beds, base, rent, start, _ in HOME_SPECS:
        place = town.places[place_id]
        assert place.kind == "home" and place.tier == tier, (hid, place.kind, place.tier)
        name = f"{place.name}, flat {unit}" if unit else place.name
        homes[hid] = Home(hid, place_id, unit, name, tier, beds, base, rent, start,
                          owner=START_OWNER[start], listing=START_LISTING[start])
    return homes


def build_lots(town: TownMap, homes: dict[str, Home]) -> dict[str, Lot]:
    """One lot per residential place that has homes, in place order, at its starting condition."""
    start = dict(LOT_CONDITION)
    for hid, place_id, unit, *_, condition in HOME_SPECS:
        if condition is not None:
            start[place_id] = condition
    used = {h.place for h in homes.values()}
    lots = {}
    for place in town.places.values():
        if place.id in used:
            c = float(start[place.id])
            lots[place.id] = Lot(place.id, c, reported=stage_of(c), worst=stage_of(c))
    return lots


def init(sim) -> None:
    """Move the cast into its homes. Call once, after `build_cast`, with sim.homes, sim.lots and the cast set.

    Each household's home records it as the household, and an owner-occupied home records it as the owner.
    """
    for hh in sim.households.values():
        home = sim.homes[hh.home_id]
        assert home.household in (None, hh.id) and home.start in ("let", "owned"), (hh.id, home.id)
        home.household = hh.id
        if home.start == "owned":
            home.owner = hh.id


# --- helpers ------------------------------------------------------------------

def _int(x: float) -> int:
    """Portable rounding to an integer: floor(x + 0.5), as JS Math.round."""
    return math.floor(x + 0.5)


def round50(x: float) -> int:
    return math.floor(x / 50 + 0.5) * 50


def stamp_of(tick: int) -> str:
    """The clock stamp ("Day 3 Tue 10:00") of a tick."""
    return Clock(tick).stamp()


def stage_of(c: float) -> int:
    """0 kept (>= 80), 1 worn (>= 60), 2 shabby (>= 40), 3 neglected (>= 20), 4 derelict."""
    for i, (_, lo) in enumerate(STAGES):
        if c >= lo:
            return i
    return len(STAGES) - 1


def stage_name(i: int) -> str:
    return STAGES[i][0]


def condition_of(sim, home_id: str) -> float:
    return sim.lots[sim.homes[home_id].place].condition


def value(sim, home_id: str) -> int:
    """Market value: base value x (0.7 + 0.003 x condition), to the nearest $50. Condition 0 is 70% of base."""
    home = sim.homes[home_id]
    return round50(home.base_value * (0.7 + 0.003 * condition_of(sim, home_id)))


def sale_proceeds(sim, home_id: str) -> int:
    """What a seller gets: value less the sale fee."""
    return _int(value(sim, home_id) * (1 - SALE_FEE))


def property_tax(home: Home) -> int:
    return _int(home.base_value * PROPERTY_TAX)


def listed(sim, home: Home, hh: Household | None = None) -> str | None:
    """The home's listing as buyers see it (as household `hh` sees it, when given): None while it is under
    offer, except to the household the listing is held for."""
    free = home.under_offer_until <= sim.clock.tick or (hh is not None and home.held_for == hh.id)
    return home.listing if free else None


def hold(sim, home: Home, hh: Household | None, minutes: int) -> None:
    """Take a listing off the market for `minutes`: for household `hh`'s offer, or for another buyer (None)."""
    home.under_offer_until = sim.clock.tick + minutes
    home.held_for = hh.id if hh is not None else None


def release(home: Home) -> None:
    """Back on the market (if it is still listed): no offer holds it."""
    home.under_offer_until = 0
    home.held_for = None


def adults(sim, hh: Household) -> list[Agent]:
    """The household's living adults: the ones who pay and decide."""
    return [a for a in (sim.agents[m] for m in hh.member_ids) if a.alive and a.is_adult]


def residents(sim, hh: Household) -> int:
    return sum(1 for m in hh.member_ids if sim.agents[m].alive)


def crowded(sim, hh: Household) -> bool:
    """More than two residents per bedroom."""
    return residents(sim, hh) > 2 * sim.homes[hh.home_id].bedrooms


def funds(sim, hh: Household) -> float:
    """The living adults' money plus savings; savings-goal pots are not counted."""
    return sum(a.money + a.savings for a in adults(sim, hh))


def tenure(sim, hh: Household) -> str:
    return "owned" if sim.homes[hh.home_id].owner == hh.id else "rented"


def weekly_cost(sim, hh: Household) -> int:
    """This week's housing charge: rent (or hardship rent) for renters, property tax for owners."""
    home = sim.homes[hh.home_id]
    if home.owner == hh.id:
        return 0 if hh.tax_deferred else property_tax(home)
    return _int(hh.hardship_rent if hh.hardship_rent is not None else hh.weekly_rent)


def comfort(sim, hh: Household) -> float:
    """How good home activities feel: tier comfort x stage comfort, x 0.9 when crowded."""
    home = sim.homes[hh.home_id]
    c = TIERS[home.tier]["comfort"] * STAGE_COMFORT[stage_of(condition_of(sim, home.id))]
    return c * 0.9 if crowded(sim, hh) else c


def home_shares(sim, hh: Household) -> dict[str, float]:
    """Each living adult's share of the household's home, adult id -> share summing to 1: the shares recorded when
    the household bought it (`Home.shares`), so the share of an adult who has died passes to the others in
    proportion to theirs, and an adult who paid nothing holds none. Equal shares when none is recorded (a home the
    household had at the start) or nobody who paid is left."""
    people = adults(sim, hh)
    recorded = sim.homes[hh.home_id].shares
    held = sum(recorded.get(a.id, 0.0) for a in people)
    if held <= 0:
        return {a.id: 1 / len(people) for a in people}
    return {a.id: recorded.get(a.id, 0.0) / held for a in people}


def worth_parts(sim, agent: Agent) -> dict:
    """{"cash", "savings", "home"} in whole dollars. Savings include the savings-goal pot; home is an adult's
    share of an owned home's value (`home_shares`: by what each adult paid for it, equal for a starting home)."""
    hh = sim.households[agent.household_id]
    home = 0.0
    if agent.alive and agent.is_adult and tenure(sim, hh) == "owned":
        home = value(sim, hh.home_id) * home_shares(sim, hh).get(agent.id, 0.0)
    saved = agent.goal["saved"] if agent.goal else 0.0
    return {"cash": _int(agent.money), "savings": _int(agent.savings + saved), "home": _int(home)}


def net_worth(sim, agent: Agent) -> int:
    """Cash + savings + home equity: the sum of `worth_parts`."""
    return sum(worth_parts(sim, agent).values())


def _surname(name: str) -> str:
    return name.split()[-1]


def household_name(sim, hh: Household) -> str:
    """"Ari Ben-David" for one adult, "The Cohens" when the adults share a surname, else "Dana and Yossi"."""
    people = adults(sim, hh) or [a for a in (sim.agents[m] for m in hh.member_ids) if a.alive] \
        or [sim.agents[m] for m in hh.member_ids]
    if not people:
        return hh.id
    if len(people) == 1:
        return people[0].name
    surnames = {_surname(a.name) for a in people}
    if len(surnames) == 1:
        s = surnames.pop()
        return f"The {s}{'es' if s.endswith(('s', 'z', 'x', 'ch', 'sh')) else 's'}"
    firsts = [a.name.split()[0] for a in people]
    return ", ".join(firsts[:-1]) + " and " + firsts[-1]


def household_summary(sim, hh: Household) -> dict:
    """The stats push's households[] row."""
    home = sim.homes[hh.home_id]
    return {"id": hh.id, "name": household_name(sim, hh),
            "members": [m for m in hh.member_ids if sim.agents[m].alive],
            "home": home.id, "home_name": home.name, "place": home.place, "tier_label": TIERS[home.tier]["label"],
            "tenure": tenure(sim, hh), "weekly_cost": weekly_cost(sim, hh)}


def pay_household(sim, hh: Household, amount: float, shares: dict[str, float] | None = None) -> dict[str, float]:
    """Pay `amount` from the household's living adults, in proportion to each one's max(0, money + savings)
    (equally when every one is at or below zero), and return what each paid, adult id -> dollars. Each share comes
    out of savings first, then money, which may go negative. A negative amount (money coming in) goes into the
    adults' savings: by `shares` (adult id -> share, as `home_shares` gives them) when given, else equally; nobody
    pays anything then, so the return is empty."""
    payers = adults(sim, hh)
    if not payers or not amount:
        return {}
    if amount < 0:
        for a in payers:
            a.savings += -amount * shares.get(a.id, 0.0) if shares is not None else -amount / len(payers)
        return {}
    weights = [max(0.0, a.money + a.savings) for a in payers]
    total = sum(weights)
    paid = {}
    for a, wt in zip(payers, weights):
        due = amount * (wt / total if total > 0 else 1 / len(payers))
        take = min(max(a.savings, 0.0), due)
        a.savings -= take
        a.money -= due - take
        paid[a.id] = due
    return paid


# --- money, affordability and the market -------------------------------------------------

def round10(x: float) -> int:
    return math.floor(x / 10 + 0.5) * 10


def retired(agent: Agent) -> bool:
    """65 or over with no job: lives on the pension."""
    return agent.job is None and agent.age >= 65


def weekly_income(sim, hh: Household) -> float:
    """The adults' take-home pay for a full week of shifts, plus pensions."""
    from .sim import PENSION, income_tax  # sim imports this module, so not at the top

    total = 0.0
    for a in adults(sim, hh):
        job = a.job
        if job and job.hourly_wage > 0:
            hours = (job.end_hour - job.start_hour) * len(job.workdays)
            total += job.hourly_wage * hours * (1 - income_tax(job.hourly_wage))
        elif retired(a):
            total += PENSION
    return total


def bills(sim, hh: Household) -> float:
    """The adults' weekly bills: BILLS_PER_ADULT each, and CAR_BILL for each car."""
    from .sim import BILLS_PER_ADULT, CAR_BILL

    return sum(BILLS_PER_ADULT + (CAR_BILL if a.owns_car else 0.0) for a in adults(sim, hh))


def living(sim, hh: Household) -> float:
    """The weekly living estimate: LIVING_PER_PERSON a resident, LIVING_PER_RETIREE for a retiree."""
    return sum(LIVING_PER_RETIREE if retired(a) else LIVING_PER_PERSON
               for a in (sim.agents[m] for m in hh.member_ids) if a.alive)


def commute(sim, hh: Household) -> float:
    """The adults' weekly commuting costs by their usual way to work."""
    return sum(travel.weekly_commute_cost(sim, a) for a in adults(sim, hh))


def buys(home: Home) -> bool:
    """Moving into this vacant home means buying it (the market holds it), not renting it."""
    return home.owner == "market"


def housing_cost(sim, hh: Household, home: Home, factor: float = 1.0) -> float:
    """A week of living in `home`: property tax plus the tier's upkeep estimate when owning, else the rent."""
    if home.owner == hh.id or buys(home):
        return home.base_value * PROPERTY_TAX + TIERS[home.tier].get("upkeep_est", 0)
    if home.id == hh.home_id:
        return hh.weekly_rent
    return home.rent * factor


def weekly_outgo(sim, hh: Household, home_id: str | None = None, factor: float = 1.0) -> float:
    """What a week costs the household in `home_id` (default: where it lives): housing, bills, living, commute."""
    home = sim.homes[home_id or hh.home_id]
    return housing_cost(sim, hh, home, factor) + bills(sim, hh) + living(sim, hh) + commute(sim, hh)


def fits(sim, hh: Household, home: Home, per_bedroom: int = 2) -> bool:
    return residents(sim, hh) <= per_bedroom * home.bedrooms


def reno_cost(sim, home_id: str) -> int:
    """A full renovation of a run-down house (condition under 50); 0 for anything better, and for flats."""
    home = sim.homes[home_id]
    c = condition_of(sim, home_id)
    if c >= 50 or home.tier == "flat":
        return 0
    return round10((100 - c) * TIERS[home.tier]["pro_rate"] * RENO_FACTOR) + CALLOUT


def net_cost(sim, hh: Household, home_id: str) -> int:
    """The cash a move costs: the price (when buying) and the van, less the sale of the home they own now."""
    home, cur = sim.homes[home_id], sim.homes[hh.home_id]
    price = value(sim, home_id) if buys(home) else 0
    back = sale_proceeds(sim, cur.id) if cur.owner == hh.id else 0
    return price + MOVING_COST - back


def affordable(sim, hh: Household, home_id: str, factor: float = 1.0) -> bool:
    """The affordability gate of every offered move.

    After the move (a purchase also pays for the renovation it needs) the household keeps RESERVE_WEEKS of the
    new weekly outgo and can carry the new home for a year. A rental also needs the week's income to cover the
    new outgo.
    """
    home = sim.homes[home_id]
    left = funds(sim, hh) - net_cost(sim, hh, home_id)
    if buys(home):
        left += (1 - factor) * value(sim, home_id) - reno_cost(sim, home_id)
    outgo = weekly_outgo(sim, hh, home_id, factor)
    income = weekly_income(sim, hh)
    if left < RESERVE_WEEKS * outgo or (income - outgo) * 52 + left < 0:
        return False
    return buys(home) or income >= outgo


def is_upgrade(sim, hh: Household, home_id: str) -> bool:
    """Not a lower tier, and: more room for a crowded household; owning instead of renting a home worth at
    least 90% of today's; or a home worth at least 15% more.

    Owners look only at homes for sale unless they are crowded: selling up to rent a pricier place gives away
    the home and the sale fee for a higher weekly outgo, never a step up (housing.md 11, point 4). For a year after
    it has downsized (its "downsized" cooldown), a household doesn't take more bedrooms unless it is crowded."""
    cur, new = sim.homes[hh.home_id], sim.homes[home_id]
    if TIERS[new.tier]["rank"] < TIERS[cur.tier]["rank"]:
        return False
    if crowded(sim, hh) and new.bedrooms > cur.bedrooms:
        return True
    if new.bedrooms > cur.bedrooms and hh.cooldowns.get("downsized", 0) > sim.clock.tick:
        return False
    owner = cur.owner == hh.id
    if owner and not buys(new):
        return False
    if not owner and buys(new):
        return value(sim, home_id) >= 0.9 * value(sim, cur.id)
    return value(sim, home_id) >= 1.15 * value(sim, cur.id)


def vacancies(sim, listing: str | None = None) -> list[Home]:
    """Vacant homes buyers and renters can see now (not under offer), in town.homes order."""
    return [h for h in sim.homes.values()
            if h.household is None and listed(sim, h) and (listing is None or listed(sim, h) == listing)]


def hunt_candidates(sim, hh: Household) -> list[Home]:
    """The homes `house_hunt` offers: listed, vacant, fitting, an upgrade and affordable."""
    return [h for h in vacancies(sim) if fits(sim, hh, h) and is_upgrade(sim, hh, h.id) and affordable(sim, hh, h.id)]


def outgrown(sim, hh: Household) -> bool:
    """An owner household that has outgrown its home: every adult is retired, or it has at least SPARE_BEDROOMS more
    bedrooms than residents. `house_hunt` asks it now and then whether to downsize, once it has lived there a while
    and when nothing better is on the market."""
    home = sim.homes[hh.home_id]
    people = adults(sim, hh)
    if home.owner != hh.id or not people:
        return False
    return all(retired(a) for a in people) or residents(sim, hh) <= home.bedrooms - SPARE_BEDROOMS


def downsize_candidates(sim, hh: Household) -> list[Home]:
    """The smaller homes an owner could sell up and buy: for sale, vacant, fitting, in at least DOWNSIZE_CONDITION,
    worth at most DOWNSIZE_SHARE of the home they own now, and affordable (hunt_candidates' rules)."""
    worth = value(sim, hh.home_id)
    return [h for h in vacancies(sim, "for_sale") if fits(sim, hh, h) and condition_of(sim, h.id) >= DOWNSIZE_CONDITION
            and value(sim, h.id) <= DOWNSIZE_SHARE * worth and affordable(sim, hh, h.id)]


def house_drought(sim, but: str | None = None) -> bool:
    """No house or big house other than `but` has been for sale for LANDLORD_SELLS_DAYS: none is for sale now
    (under offer included) and none was bought in that time (a home is for sale until it is bought; one its tenants
    bought from the landlord, marked off_market, never was). The landlord then sells a let house its tenants leave,
    and owners who have outgrown their homes think harder about selling."""
    now = sim.clock.tick
    if now < LANDLORD_SELLS_DAYS * DAY:
        return False
    for h in sim.homes.values():
        if h.tier == "flat" or h.id == but:
            continue
        if h.household is None and h.listing == "for_sale":
            return False
        if any(r["event"] == "bought" and not r.get("off_market") and now - r["tick"] < LANDLORD_SELLS_DAYS * DAY
               for r in h.history):
            return False
    return True


def cheapest_rental(sim, hh: Household, below: float | None = None, per_bedroom: int = 2) -> Home | None:
    """The cheapest fitting home to let, with rent under `below` when given (ties: better condition, then id)."""
    pool = [h for h in vacancies(sim, "for_rent") if fits(sim, hh, h, per_bedroom) and (below is None or h.rent < below)]
    return min(pool, key=lambda h: (h.rent, -condition_of(sim, h.id), h.id)) if pool else None


def under_notice(sim, hh: Household) -> Home | None:
    """The let house the household lives in while the landlord is selling it with notice (`give_notice`), else None."""
    home = sim.homes[hh.home_id]
    return home if home.notice is not None and home.household == hh.id else None


def can_buy_let_home(sim, hh: Household) -> bool:
    """Tenants under notice could buy the let house they live in from the landlord at its value: `affordable`'s rules
    for a purchase (the reserve of the new weekly outgo is left, and the home is carried for a year). The landlord
    keeps a let house above LANDLORD_FLOOR, so it needs no renovation."""
    home = sim.homes[hh.home_id]
    left = funds(sim, hh) - value(sim, home.id)
    outgo = (home.base_value * PROPERTY_TAX + TIERS[home.tier].get("upkeep_est", 0) + bills(sim, hh) + living(sim, hh)
             + commute(sim, hh))
    return left >= RESERVE_WEEKS * outgo and (weekly_income(sim, hh) - outgo) * 52 + left >= 0


def notice_home(sim) -> Home | None:
    """The let house the landlord sells with notice: one whose tenants have lived there since the start or for at least
    NOTICE_SETTLED_DAYS and have a fitting home to let to go to; the longest-standing tenants first (ties: id)."""
    now = sim.clock.tick
    pool = []
    for h in sim.homes.values():
        if h.owner != "landlord" or h.tier == "flat" or h.household is None:
            continue
        hh = sim.households[h.household]
        if hh.moved_tick is not None and now - hh.moved_tick < NOTICE_SETTLED_DAYS * DAY:
            continue
        if adults(sim, hh) and cheapest_rental(sim, hh) is not None:
            pool.append((-1 if hh.moved_tick is None else hh.moved_tick, h.id, h))
    return min(pool, key=lambda row: row[:2])[2] if pool else None


def owner_occupied(home: Home) -> bool:
    return home.household is not None and home.owner == home.household


def lot_homes(sim, place_id: str) -> list[Home]:
    return [h for h in sim.homes.values() if h.place == place_id]


def hardship_rent(sim, hh: Household) -> int:
    """The rent a renter at the bottom of the market pays until back on their feet: what is left of the week's
    income after bills, living and HARDSHIP_REPAY, to the nearest $10, never above the rent."""
    spare = weekly_income(sim, hh) - bills(sim, hh) - living(sim, hh) - HARDSHIP_REPAY
    return min(_int(hh.weekly_rent), max(0, round10(spare)))


def _one(sim, hh: Household) -> bool:
    """The household is one adult (so the verb is singular)."""
    return len(adults(sim, hh)) <= 1


def _hh_lower(sim, hh: Household) -> str:
    """The household's name in the middle of a sentence: "the Cohens"."""
    name = household_name(sim, hh)
    return "t" + name[1:] if name.startswith("The ") else name


def _hh_possessive(sim, hh: Household) -> str:
    name = _hh_lower(sim, hh)
    return name + "'" if name.endswith("s") and name.startswith("the ") else name + "'s"


def district_name(sim, home: Home) -> str:
    district = sim.town.places[home.place].district
    return DISTRICT_NAMES.get(district, district.replace("_", " ").title())


# --- serializers (only the live `emergency` is ever sent; pending_emergency stays hidden) --------------

def _condition_json(lot: Lot) -> int:
    """Condition as a whole number that always agrees with its stage (floored)."""
    return math.floor(lot.condition)


def _emergency_json(home: Home) -> dict | None:
    em = home.emergency
    if not em:
        return None
    since = em.get("since")
    return {"kind": em["kind"], "text": EMERGENCY_TEXT.get(em["kind"], "Something has broken."),
            "since": stamp_of(since) if isinstance(since, int) else since}


def _price(sim, home: Home) -> int | None:
    shown = listed(sim, home)
    if shown == "for_sale":
        return value(sim, home.id)
    if shown == "for_rent":
        return home.rent
    return None


def town_homes_json(sim) -> list[dict]:
    """The static part of every home, for the God welcome's town.homes."""
    return [{"id": h.id, "place": h.place, "unit": h.unit, "name": h.name, "tier": h.tier, "bedrooms": h.bedrooms,
             "base_value": h.base_value, "rent": h.rent} for h in sim.homes.values()]


def town_housing_json() -> dict:
    return {"tiers": {tid: {"label": t["label"], "rank": t["rank"]} for tid, t in TIERS.items()},
            "stages": [{"name": name, "min": lo} for name, lo in STAGES],
            "landlord": LANDLORD}


def lots_json(sim) -> dict:
    """state.lots: every residential place's condition, stage and the builders' and movers' vans."""
    tick = sim.clock.tick
    return {pid: {"condition": _condition_json(lot), "stage": stage_of(lot.condition),
                  "works": lot.works_until > tick, "moving": lot.moving_until > tick}
            for pid, lot in sim.lots.items()}


def homes_json(sim) -> dict:
    """state.homes: who lives where, the owner, the listing and price, the value and a live emergency's kind."""
    return {h.id: {"hh": h.household, "owner": h.owner, "listing": listed(sim, h), "price": _price(sim, h),
                   "value": value(sim, h.id), "emergency": h.emergency["kind"] if h.emergency else None}
            for h in sim.homes.values()}


def _home_block(sim, hh: Household) -> dict:
    home = sim.homes[hh.home_id]
    lot = sim.lots[home.place]
    owned = home.owner == hh.id
    st = stage_of(lot.condition)
    return {
        "id": home.id, "place": home.place, "name": home.name, "tier": home.tier,
        "tier_label": TIERS[home.tier]["label"], "district": sim.town.places[home.place].district,
        "bedrooms": home.bedrooms, "tenure": "owned" if owned else "rented",
        "landlord": None if owned else LANDLORD, "weekly_rent": 0 if owned else _int(hh.weekly_rent),
        "property_tax": property_tax(home) if owned else 0, "weekly_cost": weekly_cost(sim, hh),
        "value": value(sim, home.id), "condition": _condition_json(lot), "stage": st, "stage_name": stage_name(st),
        "comfort": r2(comfort(sim, hh)), "moved_in": stamp_of(hh.moved_tick) if hh.moved_tick is not None else None,
        "emergency": _emergency_json(home),
    }


def possessions_json(sim, agent: Agent) -> dict:
    """The agent page's and `query possessions`' possessions."""
    hh = sim.households[agent.household_id]
    return {
        "home": _home_block(sim, hh),
        "car": agent.owns_car,
        "phone": {"condition": "cracked" if agent.goal and "phone" in agent.goal["name"] else "fine"},
        "money": r2(agent.money),
        "savings": r2(agent.savings),
        "household_funds": _int(funds(sim, hh)),
        "savings_goal": agent.goal,
        "groceries_at_home": hh.groceries,
    }


def fork_you(sim, agent: Agent) -> dict:
    """The home and household money lines of a fork message's `you`."""
    hh = sim.households[agent.household_id]
    block = _home_block(sim, hh)
    return {"home": {k: block[k] for k in ("name", "tier", "tenure", "weekly_cost", "condition", "stage_name", "value")},
            "household_funds": _int(funds(sim, hh))}


def agent_page_fields(sim, agent: Agent) -> dict:
    """Money and housing fields of the agent page (get_agent)."""
    hh = sim.households[agent.household_id]
    parts = worth_parts(sim, agent)
    history = [{"time": row.get("time"), "event": row.get("event"), "home": row.get("home"),
                "name": row.get("name"), "price": row.get("price")} for row in hh.history[-20:]]
    return {"savings": r2(agent.savings), "household_funds": _int(funds(sim, hh)), "net_worth": sum(parts.values()),
            "worth_parts": parts, "home_history": history}


def market_json(sim) -> dict:
    """Controller `query market`: the vacant homes listed for sale and to let, in town.homes order."""
    out = {"for_sale": [], "for_rent": []}
    for h in sim.homes.values():
        shown = listed(sim, h)
        if h.household is not None or shown is None:
            continue
        row = {"home": h.id, "name": h.name, "tier": h.tier, "district": sim.town.places[h.place].district,
               "bedrooms": h.bedrooms}
        if shown == "for_sale":
            out["for_sale"].append({**row, "price": value(sim, h.id), "stage_name": stage_name(stage_of(condition_of(sim, h.id)))})
        else:
            out["for_rent"].append({**row, "rent": h.rent, "stage_name": stage_name(stage_of(condition_of(sim, h.id)))})
    return out


def home_page(sim, home_id: str) -> dict | None:
    """God's `get_home` reply body, or None for an unknown home."""
    h = sim.homes.get(home_id)
    if h is None:
        return None
    lot = sim.lots[h.place]
    st = stage_of(lot.condition)
    hh = sim.households.get(h.household) if h.household else None
    history = [{"time": row.get("time"), "event": row.get("event"), "household": row.get("household"),
                "price": row.get("price")} for row in h.history[-20:]]
    return {
        "id": h.id, "place": h.place, "unit": h.unit, "name": h.name, "tier": h.tier, "bedrooms": h.bedrooms,
        "base_value": h.base_value, "rent": h.rent, "district": sim.town.places[h.place].district,
        "hh": h.household, "household_name": household_name(sim, hh) if hh else None, "owner": h.owner,
        "listing": listed(sim, h), "price": _price(sim, h), "value": value(sim, h.id),
        "emergency": _emergency_json(h), "condition": _condition_json(lot), "stage": st, "stage_name": stage_name(st),
        "residents": [sim.agents[m].name for m in hh.member_ids if sim.agents[m].alive] if hh else [],
        "history": history,
    }


# --- group B: moves --------------------------------------------------------------------------

def _history(rows: list[dict], row: dict) -> None:
    rows.append(row)
    del rows[:-20]


def _event(sim, text: str, tag: str, place: str, agent: Agent | None = None, agents: list[str] | None = None) -> None:
    sim.event(text, agent, tag=tag, agents=agents or [], place=place)


def _members(sim, hh: Household) -> list[Agent]:
    return [a for a in (sim.agents[m] for m in hh.member_ids) if a.alive]


def available(sim, hh: Household, home: Home) -> bool:
    """The household can still move into this home: vacant and listed as the household sees it."""
    return home.household is None and listed(sim, home, hh) is not None


def too_late(sim, hh: Household, home: Home, agent: Agent | None) -> None:
    """The news that a home the household wanted has gone: taken, or held for someone else's offer."""
    if home.household is None and home.listing and home.held_for not in (None, hh.id):
        gone = "is under offer"
    else:
        gone = "has been " + ("sold" if buys(home) or home.owner not in ("landlord", "market") else "let")
    _event(sim, f"{household_name(sim, hh)} {'was' if _one(sim, hh) else 'were'} too late: {home.name} {gone}.",
           "too_late", home.place, agent)


def move_household(sim, hh: Household, home_id: str, how: str, factor: float = 1.0, decider: Agent | None = None,
                   forced: str | None = None, plan_decider: bool = True, check: bool = True) -> bool:
    """Move a household into a vacant listed home: `how` is "buy" or "rent", at `factor` times the asking price
    or rent. `forced` is None for the household's own choice, else "evicted" or "forced_sale" (no affordability
    check, no van fee for a rental). Returns False, with a too_late event, when the home has gone or the
    household can't raise the money after all (`check=False` skips the affordability gate, for a step down to a
    rental out of housing trouble).

    The old home is freed and listed (an owned one for sale at its value, with the sale credited to the adults'
    savings by their shares of it; a rented one back to let, unless it is a house and no other house has been for
    sale for LANDLORD_SELLS_DAYS: then the landlord sells it; one the landlord gave the household notice on stays
    empty until the notice runs out, `landlord_notices`). The van and the price are paid from the household
    pot, and a home bought records each adult's share of it as their part of that payment, so buying moves an
    adult's money into their own equity, never into another's. Members free to drop what they are doing set off
    for the new home; the rest go there the next time they head home. `plan_decider=False` leaves the decider
    alone, for a fork option whose own steps go there.
    """
    new = sim.homes[home_id]
    now, stamp = sim.clock.tick, sim.clock.stamp()
    who = household_name(sim, hh)
    agent = decider or (adults(sim, hh) or _members(sim, hh) or [None])[0]
    if not available(sim, hh, new):
        too_late(sim, hh, new, agent)
        return False
    if check and not forced and not affordable(sim, hh, home_id, factor):
        _event(sim, f"{who} can't raise the money for {new.name} after all.", "too_late", new.place, agent)
        if new.held_for == hh.id:
            release(new)  # their own offer no longer holds it
        return False
    old = sim.homes[hh.home_id]
    owned = old.owner == hh.id
    buy = how == "buy"
    proceeds = sale_proceeds(sim, old.id) if owned else 0
    sells = old.owner == "landlord" and old.tier != "flat" and old.notice is None and house_drought(sim, new.id)
    # Leave the old home: an owned one goes on the market, a rented one back to the landlord (who sells a
    # house when there has been none for sale for a while, and keeps one it gave notice on empty until the
    # notice runs out).
    if owned:
        pay_household(sim, hh, -proceeds, home_shares(sim, hh))
        old.owner, old.listing = "market", "for_sale"
        old.shares = {}
    elif sells:
        old.owner, old.listing = "market", "for_sale"
    else:
        old.listing = None if old.notice is not None else "for_rent"
    old.household = None
    release(old)
    old.pending_emergency = None
    if old.emergency:  # the problem stays with the house, as lost condition
        old.emergency = None
        _change_condition(sim, sim.lots[old.place], -SETTLE_DAMAGE)
    left = forced or ("sold" if owned else "left")
    # Pay and take the new home.
    price = _int(value(sim, home_id) * factor) if buy else 0
    van = MOVING_COST if buy or not (forced or (hh.arrears > 0 and not owned)) else 0
    dues = pay_household(sim, hh, price + van)
    if buy:
        new.owner = hh.id
        new.shares = {aid: due / (price + van) for aid, due in dues.items()}  # one split pays the price and the van
        hh.weekly_rent = 0
    else:
        hh.weekly_rent = _int(new.rent * factor)
    new.listing = None
    new.household = hh.id
    release(new)
    hh.home_id = new.id
    hh.moved_tick = now
    hh.trouble_seen = 0
    hh.cooldowns.pop("upkeep", None)  # the upkeep and repair cooldowns were the old home's
    hh.cooldowns.pop("repair", None)
    hh.hardship_rent = None
    hh.tax_deferred = False
    sim.lots[new.place].moving_until = now + MOVE_VAN_MINUTES
    arrived = "bought" if buy else "rented"
    paid = price if buy else hh.weekly_rent
    _history(hh.history, {"tick": now, "time": stamp, "event": left, "home": old.id, "name": old.name,
                          "price": proceeds or None})
    _history(hh.history, {"tick": now, "time": stamp, "event": arrived, "home": new.id, "name": new.name, "price": paid})
    _history(old.history, {"tick": now, "time": stamp, "event": left, "household": hh.id, "price": proceeds or None})
    _history(new.history, {"tick": now, "time": stamp, "event": arrived, "household": hh.id, "price": paid})
    # The news.
    people = _members(sim, hh)
    ids = [a.id for a in people]
    tier = TIERS[new.tier]["label"]
    sold = f", selling {old.name} for ${proceeds:,}" if owned else ""
    one = _one(sim, hh)
    if forced == "evicted":
        _event(sim, f"{LANDLORD} evicts {_hh_lower(sim, hh)} from {old.name}. They move into {new.name} at "
                    f"${hh.weekly_rent}/week.", "evicted", new.place, agent, ids)
    elif forced == "forced_sale" and not buy:
        _event(sim, f"{who} {'is' if one else 'are'} forced to sell {old.name} (${proceeds:,}) and move into "
                    f"{new.name} at ${hh.weekly_rent}/week.", "forced_sale", new.place, agent, ids)
    else:
        if forced == "forced_sale":
            _event(sim, f"{who} {'is' if one else 'are'} forced to sell {old.name} (${proceeds:,}).", "forced_sale",
                   old.place, agent, ids)
            sold = ""
        if buy:
            _event(sim, f"{who} {'buys' if one else 'buy'} {new.name} ({tier}, {district_name(sim, new)}) for "
                        f"${price:,}{sold}.", "home_bought", new.place, agent, ids)
        else:
            _event(sim, f"{who} {'moves' if one else 'move'} into {new.name} ({tier}) at ${hh.weekly_rent}/week{sold}.",
                   "home_rented", new.place, agent, ids)
    if sells:
        _event(sim, f"{LANDLORD} puts {old.name} up for sale (${value(sim, old.id):,}).", "home_listed", old.place)
    for a in people:
        if a is not agent:
            a.remember(stamp, f"Moved to {new.name}.")
        if (a is not decider or plan_decider) and sim._interruptible(a):
            sim.start_plan(a, [("move_house", new.place)])
    return True


def renovate(sim, hh: Household, cost: int) -> None:
    """Builders do the household's home up to condition 100 for `cost`, paid from the household pot: the
    renovation a run-down home is bought with, done the day it is bought."""
    lot = sim.lots[sim.homes[hh.home_id].place]
    pay_household(sim, hh, cost)
    lot.works_until = max(lot.works_until, sim.clock.tick + RENOVATE_WORKS_MINUTES)
    _change_condition(sim, lot, 100 - lot.condition)


# --- group B: the landlord sells a let house with notice --------------------------------------

def give_notice(sim, home: Home, due: int | None = None) -> None:
    """The landlord is selling a let house: its tenants have NOTICE_DAYS to move out, or until `due` when the notice
    takes over the date of a sale the last tenants bought out (`buy_let_home`); house_hunt's notice variant asks them
    where to go at once, and the house goes on the market when the notice runs out (`landlord_notices`)."""
    hh = sim.households[home.household]
    now = sim.clock.tick
    due = now + NOTICE_DAYS * DAY if due is None else due
    home.notice = {"household": hh.id, "since": now, "due": due}
    home.noticed = due - NOTICE_DAYS * DAY
    hh.cooldowns.pop("house_hunt", None)
    notice = (f"{NOTICE_DAYS // 7} weeks' notice" if due - now == NOTICE_DAYS * DAY
              else f"notice to move out by {stamp_of(due)}")
    _event(sim, f"{LANDLORD} is selling {home.name} and gives {_hh_lower(sim, hh)} {notice}.", "home_listed",
           home.place, (adults(sim, hh) or [None])[0], [a.id for a in _members(sim, hh)])


def landlord_notices(sim) -> None:
    """NOTICE_HOUR every day. A house whose notice has run out goes on the market, its tenants moved first into the
    cheapest fitting home to let if they are still there (an eviction: the landlord's van, no affordability gate;
    crowding relaxed to FORCED_CROWDING when nothing else fits, and another day's wait when nothing is free, which
    the next notice waits too). The sale is when the notice runs out however soon the tenants go, so the landlord's
    sales are as far apart as its notices. Then the landlord may give a notice (`_landlord_sells`)."""
    now = sim.clock.tick
    for home in sim.homes.values():
        if home.notice is None or home.notice["due"] > now:
            continue
        if home.household is not None:
            hh = sim.households[home.household]
            rental = cheapest_rental(sim, hh) or cheapest_rental(sim, hh, per_bedroom=FORCED_CROWDING)
            if rental is None or not move_household(sim, hh, rental.id, "rent", forced="evicted"):
                home.notice["due"] += DAY
                home.noticed += DAY
                continue
        home.notice = None
        home.owner, home.listing = "market", "for_sale"
        _event(sim, f"{LANDLORD} puts {home.name} up for sale (${value(sim, home.id):,}).", "home_listed", home.place)
    _landlord_sells(sim)


def _landlord_sells(sim, due: int | None = None) -> None:
    """From day NOTICE_FROM_DAY, while no house has been for sale for LANDLORD_SELLS_DAYS (`house_drought`), no notice
    is running and none was given in the last NOTICE_GAP_DAYS (counted from NOTICE_DAYS before its sale,
    `Home.noticed`), the landlord gives notice on one let house (`notice_home`), to move out by `due` when given."""
    now = sim.clock.tick
    if now < NOTICE_FROM_DAY * DAY or any(h.notice is not None for h in sim.homes.values()) or not house_drought(sim):
        return
    if any(h.noticed is not None and now - h.noticed < NOTICE_GAP_DAYS * DAY for h in sim.homes.values()):
        return
    home = notice_home(sim)
    if home is not None:
        give_notice(sim, home, due)


def buy_let_home(sim, hh: Household, agent: Agent | None = None) -> bool:
    """Tenants under notice buy the let house they live in from the landlord at its value, paid from the household
    pot; each adult's share of it is what they paid, and the notice ends. The house was never on the market, so the
    purchase leaves a house drought standing (its "bought" row is marked off_market) and doesn't count towards the
    gap between the landlord's sales: the landlord gives notice on the next let house at once (`_landlord_sells`),
    to move out by the same date, so its sale is not put off (but never less than NOTICE_MIN_DAYS from now). Returns
    False, with a too_late event, when the notice is over or they can't raise the money after all."""
    home = sim.homes[hh.home_id]
    who = household_name(sim, hh)
    if under_notice(sim, hh) is None or not can_buy_let_home(sim, hh):
        _event(sim, f"{who} can't buy {home.name} after all.", "too_late", home.place, agent)
        return False
    now, stamp = sim.clock.tick, sim.clock.stamp()
    price = value(sim, home.id)
    sale = home.notice["due"]
    dues = pay_household(sim, hh, price)
    home.owner, home.listing, home.notice, home.noticed = hh.id, None, None, None
    home.shares = {aid: due / price for aid, due in dues.items()}
    hh.weekly_rent = 0
    hh.hardship_rent = None
    _history(hh.history, {"tick": now, "time": stamp, "event": "bought", "home": home.id, "name": home.name,
                          "price": price})
    _history(home.history, {"tick": now, "time": stamp, "event": "bought", "household": hh.id, "price": price,
                            "off_market": True})
    _event(sim, f"{who} {'buys' if _one(sim, hh) else 'buy'} {home.name} ({TIERS[home.tier]['label']}, "
                f"{district_name(sim, home)}) from {LANDLORD} for ${price:,}.", "home_bought", home.place, agent,
           [a.id for a in _members(sim, hh)])
    _landlord_sells(sim, max(sale, now + NOTICE_MIN_DAYS * DAY))
    return True


def forced_move(sim, hh: Household) -> bool:
    """The floor under a household deep in the red (PLAN 5.5): a cheaper rental (owners: any rental, after a
    forced sale), else for owners a cheaper home the sale pays for, then both again with crowding relaxed to
    FORCED_CROWDING a bedroom; else hardship rent for renters, and nowhere_to_go with tax deferral for owners.
    Returns True when the household moved."""
    cur = sim.homes[hh.home_id]
    owner = cur.owner == hh.id
    how = "forced_sale" if owner else "evicted"
    for per_bedroom in (2, FORCED_CROWDING):
        rental = cheapest_rental(sim, hh, below=None if owner else hh.weekly_rent, per_bedroom=per_bedroom)
        if rental:
            return move_household(sim, hh, rental.id, "rent", forced=how)
        if owner:
            budget = sale_proceeds(sim, cur.id) + max(0.0, funds(sim, hh))
            pool = [h for h in vacancies(sim, "for_sale")
                    if fits(sim, hh, h, per_bedroom) and value(sim, h.id) + MOVING_COST <= budget]
            if pool:
                home = min(pool, key=lambda h: (value(sim, h.id), -condition_of(sim, h.id), h.id))
                return move_household(sim, hh, home.id, "buy", forced=how)
    if owner:
        _event(sim, f"{household_name(sim, hh)} {'is' if _one(sim, hh) else 'are'} deep in debt and nowhere cheaper "
                    f"is free.", "nowhere_to_go", cur.place, (adults(sim, hh) or [None])[0],
               [a.id for a in _members(sim, hh)])
        _defer_tax(sim, hh)
    else:
        _set_hardship_rent(sim, hh)
    return False


def _set_hardship_rent(sim, hh: Household) -> None:
    rent = hardship_rent(sim, hh)
    if rent == hh.hardship_rent:
        return
    hh.hardship_rent = rent
    home = sim.homes[hh.home_id]
    _event(sim, f"{LANDLORD} lowers {_hh_possessive(sim, hh)} rent to ${rent}/week until they are back on their feet.",
           "hardship", home.place, (adults(sim, hh) or [None])[0], [a.id for a in _members(sim, hh)])


def _defer_tax(sim, hh: Household) -> None:
    if hh.tax_deferred:
        return
    hh.tax_deferred = True
    home = sim.homes[hh.home_id]
    _event(sim, f"The council defers {_hh_possessive(sim, hh)} property tax.", "hardship", home.place,
           (adults(sim, hh) or [None])[0], [a.id for a in _members(sim, hh)])


# --- group B: the Sunday charges --------------------------------------------------------------

def weekly_charges(sim) -> None:
    """Sunday 23:00, for every household with a living adult (PLAN 5.3):

    1. housing: rent (or hardship rent), or property tax for owners (none while deferred), split equally
    2. bills, each adult their own   3. adults below zero dip into their savings   4. the bills_paid event
    5. arrears (decision 58)   6. in_the_red / in_the_red_again   7. hardship rent and tax deferral end after
    two clean Sundays   8. the floor at arrears >= 3: a forced move, hardship rent or tax deferral, and
    belt-tightening   9. the home's weekly effect on its residents' reputation.
    """
    from .sim import BILLS_PER_ADULT, CAR_BILL  # sim imports this module, so not at the top

    now = sim.clock.tick
    for hh in sim.households.values():
        payers = adults(sim, hh)
        if not payers:
            continue
        home = sim.homes[hh.home_id]
        owned = home.owner == hh.id
        who = household_name(sim, hh)
        one = _one(sim, hh)
        # 1-3. Housing, bills, then savings cover any shortfall.
        charge = weekly_cost(sim, hh)
        paid_bills = 0.0
        for a in payers:
            bill = BILLS_PER_ADULT + (CAR_BILL if a.owns_car else 0.0)
            a.money -= charge / len(payers) + bill
            paid_bills += bill
        for a in payers:
            if a.money < 0 < a.savings:
                move = min(a.savings, -a.money)
                a.savings -= move
                a.money += move
        # 4. The receipt.
        if owned:
            what = f"${charge} property tax and " if not hh.tax_deferred else ""
            tail = " (property tax deferred)" if hh.tax_deferred else ""
        else:
            what = f"${charge} rent{' (hardship rate)' if hh.hardship_rent is not None else ''} and "
            tail = ""
        _event(sim, f"{who} paid {what}${paid_bills:.0f} in bills{tail}.", "bills_paid", home.place,
               agents=[a.id for a in payers])
        # 5. Arrears count the weeks in the red that show no recovery.
        f = funds(sim, hh)
        went_up = False
        if f >= 0:
            hh.arrears = 0
            hh.clean_sundays += 1
        else:
            hh.clean_sundays = 0
            if hh.grace_until > now:
                pass
            elif hh.arrears > 0 and hh.last_funds is not None and f >= hh.last_funds + ARREARS_PROGRESS:
                pass
            else:
                hh.arrears += 1
                went_up = True
        hh.last_funds = f
        # 6. The news: in_the_red at arrears 1, in_the_red_again each time arrears climbs past it. A red week that
        # holds (grace, or paying it down) at 0 or 2+ is quiet.
        if f < 0 and (hh.arrears == 1 or (hh.arrears >= 2 and went_up)):
            worst = min(payers, key=lambda a: a.money)
            ids = [a.id for a in payers]
            red = f"{who} {'is' if one else 'are'} ${-f:,.0f} in the red"
            if hh.arrears >= 2:
                warning = "The bank warns them: pay up or sell." if owned else f"{LANDLORD} sends a final warning."
                nth = ORDINALS[hh.arrears - 1] if hh.arrears <= len(ORDINALS) else f"{hh.arrears}th"
                _event(sim, f"{red} for a {nth} week. {warning}", "in_the_red_again", home.place, worst, ids)
            else:
                _event(sim, f"{red} after the week's bills.", "in_the_red", home.place, worst, ids)
        # 7. Back on their feet.
        if hh.clean_sundays >= 2:
            hh.hardship_rent = None
            hh.tax_deferred = False
        # 8. The floor.
        if hh.arrears >= 3:
            if f < -2 * weekly_outgo(sim, hh):
                forced_move(sim, hh)
            elif not owned and cheapest_rental(sim, hh, below=hh.weekly_rent) is None:
                _set_hardship_rent(sim, hh)
            elif owned:
                _defer_tax(sim, hh)
            hh.tight_until = max(hh.tight_until, now + 8 * DAY)
    # 9. What the neighbours think of the place.
    for hh in sim.households.values():
        home = sim.homes[hh.home_id]
        if home.household != hh.id:
            continue
        st = stage_of(condition_of(sim, home.id))
        delta = STAGE_REPUTATION[st]
        if st == 0 and home.tier == "big_house" and home.owner == hh.id:
            delta = KEPT_BIG_HOUSE_PRIDE
        if delta:
            for a in _members(sim, hh):
                a.reputation = max(0.0, min(100.0, a.reputation + delta))


# --- group B: condition, stages and emergencies ----------------------------------------------

def _stage_news(sim, lot: Lot) -> None:
    """Announce a newly reached shabby, neglected or derelict stage, or a return to kept, for an owner-occupied
    home (housing.md 7.2). `lot.reported` is the worst stage announced, so a home bouncing between two of the
    poor stages is announced once; it resets when the lot gets back to stage 0-1. "Looks as good as new" comes
    when a home that had reached stage 2+ (`lot.worst`) climbs back to stage 0. Rentals and vacant homes are
    silent. So is a home whose household moved in less than NEWS_SETTLE_DAYS ago: a poor stage it reaches then
    is announced only if it is still there afterwards (it stays unreported), so a fixer-upper renovated on its
    first evening never makes the news as falling apart."""
    st = stage_of(lot.condition)
    homes = lot_homes(sim, lot.place)
    home = homes[0] if len(homes) == 1 and owner_occupied(homes[0]) else None
    lot.worst = max(lot.worst, st)
    if st <= 1:
        if st == 0:
            if home and lot.worst >= 2:
                _event(sim, f"{home.name} looks as good as new.", "restored", lot.place,
                       agents=[a.id for a in _members(sim, sim.households[home.household])])
            lot.worst = 0
        lot.reported = st
    elif st > lot.reported:
        if home and _just_moved_in(sim, sim.households[home.household]):
            return  # not news yet
        if home and st in STAGE_NEWS:
            tag, text = STAGE_NEWS[st]
            _event(sim, text.format(home=home.name), tag, lot.place,
                   agents=[a.id for a in _members(sim, sim.households[home.household])])
        lot.reported = st


def _just_moved_in(sim, hh: Household) -> bool:
    """The household moved into its home less than NEWS_SETTLE_DAYS ago."""
    return hh.moved_tick is not None and sim.clock.tick - hh.moved_tick < NEWS_SETTLE_DAYS * DAY


def _change_condition(sim, lot: Lot, delta: float) -> None:
    lot.condition = max(0.0, min(100.0, lot.condition + delta))
    _stage_news(sim, lot)


def _decay(sim, lot: Lot, homes: list[Home], winter: bool) -> None:
    """One night of wear on a building, then the landlord's repairs and the market floor."""
    tier = homes[0].tier
    season = WINTER_DECAY if winter else 1.0
    lived_in = [h for h in homes if h.household]
    if tier == "flat":  # a block wears at the flat rate whether or not its flats are let
        rate = TIERS["flat"]["decay"] * season
    elif lived_in:
        hh = sim.households[lived_in[0].household]
        rate = TIERS[tier]["decay"] * season * (1 + CROWD_DECAY * max(0, residents(sim, hh) - 2))
        if lived_in[0].emergency:
            rate += EMERGENCY_DECAY
    else:
        rate = VACANT_DECAY
    before = lot.condition
    lot.condition = max(0.0, before - rate)
    if not lived_in and all(h.owner == "market" for h in homes):
        lot.condition = max(lot.condition, min(before, MARKET_FLOOR))  # a home for sale never drops below neglected
    floor = LANDLORD_FLOOR.get(tier)
    if floor is not None and all(h.owner == "landlord" for h in homes) and lot.condition < floor:
        lot.condition = float(LANDLORD_RESTORE)
        lot.works_until = sim.clock.tick + LANDLORD_WORKS_MINUTES
        if lived_in:
            _event(sim, f"{LANDLORD} repaints {sim.town.places[lot.place].name}.", "repaint", lot.place)
    _stage_news(sim, lot)


def nightly(sim) -> None:
    """Midnight: every building wears; residents of neglected homes lose health and may catch a chill; every
    owner-occupied home without an emergency rolls for one, which stays hidden until it goes live."""
    from .forks import luck_odds  # forks reaches housing through default_scores, so not at the top

    winter = sim.clock.season == "winter"
    for lot in sim.lots.values():
        _decay(sim, lot, lot_homes(sim, lot.place), winter)
    for home in sim.homes.values():
        if not home.household:
            continue
        hh = sim.households[home.household]
        st = stage_of(condition_of(sim, home.id))
        if st in DAMP_HEALTH:
            for a in _members(sim, hh):
                a.health = max(0.0, a.health - DAMP_HEALTH[st] * (2 if winter else 1))
                p0 = DAMP_CHILL[st] * (2 if winter else 1)
                p = luck_odds(p0, -1, a.luck)
                roll = sim.rng.random()
                sim._log_roll(a, "damp_chill", p, roll, base=p0)
                if roll < p:
                    a.health = max(0.0, a.health + CHILL["health"])
                    a.adjust("fun", CHILL["fun"])
                    sim.event(f"{a.name} catches a chill in the damp house.", a, tag="damp_chill", place=home.place)
        payers = adults(sim, hh)
        if home.owner != hh.id or home.emergency or home.pending_emergency or not payers:
            continue
        p0 = (TIERS[home.tier]["emergency_p"] + EMERGENCY_STAGE_P.get(st, 0.0)) * (WINTER_EMERGENCY if winter else 1)
        p = luck_odds(p0, -1, sum(a.luck for a in payers) / len(payers))
        roll = sim.rng.random()
        sim._log_roll(payers[0], "home_emergency", p, roll, base=p0)
        if roll < p:
            kinds = ["leak", "electrics", "boiler"] + (["boiler", "boiler"] if winter else []) + \
                    (["roof"] if sim.weather == "rain" else [])
            kind = sim.rng.choice(kinds)
            home.pending_emergency = {"kind": kind, "due": sim.clock.tick + sim.rng.randrange(7 * 60, 21 * 60)}


def tick(sim) -> None:
    """Every tick, before the agents: a pending emergency whose time has come goes live, and one left unfixed
    for EMERGENCY_DAYS settles as lost condition; at NOTICE_HOUR, the landlord's notices (`landlord_notices`)."""
    now = sim.clock.tick
    if sim.clock.minute_of_day == NOTICE_HOUR * 60:
        landlord_notices(sim)
    for home in sim.homes.values():
        pending = home.pending_emergency
        if pending and pending["due"] <= now:
            home.pending_emergency = None
            if owner_occupied(home):
                home.emergency = {"kind": pending["kind"], "since": now}
                hh = sim.households[home.household]
                _event(sim, EMERGENCY_NEWS[pending["kind"]].format(home=home.name), "emergency", home.place,
                       agents=[a.id for a in _members(sim, hh)])
        live = home.emergency
        if live and now - live["since"] >= EMERGENCY_DAYS * DAY:
            home.emergency = None
            _event(sim, f"The {EMERGENCY_NAME[live['kind']]} at {home.name} is never properly fixed.",
                   "emergency_settled", home.place)
            _change_condition(sim, sim.lots[home.place], -SETTLE_DAMAGE)


def fix_emergency(sim, hh: Household, agent: Agent | None = None) -> None:
    home = sim.homes[hh.home_id]
    live = home.emergency
    if not live:
        return
    home.emergency = None
    _event(sim, f"The {EMERGENCY_NAME[live['kind']]} at {home.name} is fixed.", "emergency_settled", home.place, agent)


def on_death(sim, agent: Agent) -> None:
    """After a death and the household update: a home with nobody left alive goes back on the market (an estate
    sale; nobody inherits) or back to the landlord. Children left on their own keep the home."""
    hh = sim.households[agent.household_id]
    if _members(sim, hh):
        return
    home = sim.homes[hh.home_id]
    if home.household != hh.id:
        return
    now, stamp = sim.clock.tick, sim.clock.stamp()
    home.household = None
    home.pending_emergency = None
    home.emergency = None
    release(home)
    _history(home.history, {"tick": now, "time": stamp, "event": "left", "household": hh.id, "price": None})
    _history(hh.history, {"tick": now, "time": stamp, "event": "left", "home": home.id, "name": home.name,
                          "price": None})
    if home.owner == hh.id:
        home.owner, home.listing = "market", "for_sale"
        home.shares = {}
        _event(sim, f"{home.name} goes on the market after {agent.name}'s death.", "home_listed", home.place,
               agents=[agent.id])
    else:
        home.listing = None if home.notice is not None else "for_rent"  # a notice's sale goes ahead when it runs out


# --- group B: fork extras and outcome effects ------------------------------------------------

def _call_off(agent: Agent, opt) -> None:
    """The home an option was about has gone: the decider goes home instead. _decide starts the option's own
    steps once the extras are done (PLAN 3.11), so those are what must change; the plan is set too for a caller
    that doesn't. None of what the option promised happens."""
    opt.steps = [("idle", "home")]
    agent.plan = [("idle", "home")]
    opt.outcomes = []


def apply_extra(sim, agent: Agent, fork, opt) -> None:
    """The housing extras of a chosen option, at decision time (PLAN 3.11): move (with what comes only if the move
    goes through: settle, household cooldowns {key: minutes}, and renovate, the price of doing up the home
    bought), buy_let (tenants under notice buy the house they rent), hold, repair, works, fix_emergency, hh_cooldown,
    belt_tighten, sell_car, sell_stuff, ask_help and odd_jobs."""
    extra = getattr(opt, "extra", None) or {}
    if not extra:
        return
    hh = sim.households[agent.household_id]
    now = sim.clock.tick
    if "hh_cooldown" in extra and fork is not None:
        hh.cooldowns[fork.kind] = now + extra["hh_cooldown"]
    if "move" in extra:
        how = extra.get("how", "buy")
        down = how == "rent" and fork is not None and fork.kind == "housing_trouble"
        if move_household(sim, hh, extra["move"], how, decider=agent, plan_decider=False, check=not down):
            for key, minutes in (extra.get("settle") or {}).items():
                hh.cooldowns[key] = now + minutes
            if extra.get("renovate"):
                renovate(sim, hh, extra["renovate"])
        else:
            _call_off(agent, opt)  # nothing to move into
    if "buy_let" in extra and not buy_let_home(sim, hh, agent):
        _call_off(agent, opt)
    if "hold" in extra:  # an offer: nobody else takes the home while the seller thinks it over
        home = sim.homes[extra["hold"]]
        if available(sim, hh, home):
            hold(sim, home, hh, OFFER_HOLD_MINUTES)
        else:
            too_late(sim, hh, home, agent)
            _call_off(agent, opt)
    lot = sim.lots[sim.homes[hh.home_id].place]
    if "repair" in extra:
        _change_condition(sim, lot, extra["repair"])
    if "works" in extra:
        lot.works_until = max(lot.works_until, now + extra["works"])
    if extra.get("fix_emergency"):
        fix_emergency(sim, hh, agent)
    if "belt_tighten" in extra:
        hh.tight_until = max(hh.tight_until, now + extra["belt_tighten"])
    if extra.get("sell_car"):
        seller = next((a for a in [agent] + adults(sim, hh) if a.owns_car), None)
        if seller:
            seller.owns_car = False
            seller.savings += CAR_SALE
            sim.event(f"{seller.name} sells the car for ${CAR_SALE:,}.", seller, tag="car_sold")
    if "sell_stuff" in extra:
        agent.money += extra["sell_stuff"]
        hh.cooldowns["sell_stuff"] = now + STUFF_DAYS * DAY
        _event(sim, f"{household_name(sim, hh)} {'sells' if _one(sim, hh) else 'sell'} some furniture for "
                    f"${extra['sell_stuff']:,}.", "stuff_sold", sim.homes[hh.home_id].place, agent)
    if "ask_help" in extra:
        friend = sim.agents.get(extra["ask_help"])
        if friend and friend.alive and sim._interruptible(friend):
            sim.start_plan(friend, [("help_out", sim.homes[hh.home_id].place)])
    if extra.get("odd_jobs"):
        hh.cooldowns["odd_jobs"] = now + ODD_JOBS_DAYS * DAY


# An effect's companion value (a deal's "factor" and "renovate", a gift's "amount") comes before its main key
# ("buy", "gift_from") in the effects dict; the main key takes it from here. Kept on the agent, between keys only.
COMPANIONS = ("factor", "amount", "renovate")


def _take(agent: Agent, key: str, default):
    held = getattr(agent, "effect_args", None) or {}
    out = held.pop(key, default)
    agent.effect_args = held
    return out


def apply_effect(sim, agent: Agent, key, value) -> bool:
    """Apply a housing outcome effect for the agent's household; True when `key` was a housing one."""
    hh = sim.households[agent.household_id]
    now = sim.clock.tick
    if key in COMPANIONS:
        held = getattr(agent, "effect_args", None) or {}
        held[key] = value
        agent.effect_args = held
    elif key == "home_condition":
        _change_condition(sim, sim.lots[sim.homes[hh.home_id].place], value)
    elif key == "hh_money":
        pay_household(sim, hh, -value)
    elif key == "buy":
        home = sim.homes[value]
        factor, cost = _take(agent, "factor", 1.0), _take(agent, "renovate", 0)
        if move_household(sim, hh, value, "buy" if buys(home) else "rent", factor, decider=agent) and cost:
            renovate(sim, hh, cost)
    elif key == "withdraw":
        hold(sim, sim.homes[value], None, UNDER_OFFER_DAYS * DAY)
    elif key == "release":
        if sim.homes[value].held_for == hh.id:
            release(sim.homes[value])
    elif key == "gift_from":
        giver = sim.agents[value]
        amount = min(_take(agent, "amount", 0), max(0.0, giver.money + giver.savings))
        if amount > 0:
            take = min(max(giver.savings, 0.0), amount)
            giver.savings -= take
            giver.money -= amount - take
            agent.money += amount
            sim.event(f"{giver.name} gives {agent.name} ${amount:,.0f} to help with the bills.", agent,
                      tag="help_given", agents=[agent.id, giver.id])
    elif key == "meet_neighbour":
        district = sim.town.places[sim.homes[hh.home_id].place].district
        pool = [a for a in sim.agents.values() if a.alive and a.id != agent.id and a.id not in agent.relationships
                and a.is_adult == agent.is_adult
                and sim.town.places[sim.homes[sim.households[a.household_id].home_id].place].district == district]
        if pool:
            sim._meet_someone(agent, pool)
        else:
            sim._meet_someone(agent)
    elif key == "fix_emergency":
        if value:
            fix_emergency(sim, hh, agent)
    elif key == "grace":
        hh.grace_until = max(hh.grace_until, now + value * DAY)
        hh.cooldowns["grace"] = now + GRACE_DAYS * DAY
    else:
        return False
    return True


# --- group B: comfort and the money term of default scores ------------------------------------

def activity_gain_scale(sim, agent: Agent) -> float:
    """Multiplier on the positive gains of activities at the agent's own home: the home's comfort."""
    hh = sim.households[agent.household_id]
    if agent.activity_place != sim.homes[hh.home_id].place:
        return 1.0
    return comfort(sim, hh)


def afford_score(sim, agent: Agent, opt) -> float:
    """The money term of default_scores (housing.md 10.3).

    Free options score 0. A household-paid cost is weighed against the household's spare funds (funds less two
    weeks of outgo): -1.5 above spare, else -thrift x (cost / spare)^2. Any other cost is weighed against what
    the character can pay it with: their own money and savings, else the household's spare funds (the pool the
    Sunday charges draw on; a child's costs fall to an adult), as -thrift x cost / max(that, 50), and -2 when
    neither covers it. A cost not charged on deciding (the work fork's bus, whose fare is paid on boarding) is
    never out of reach: then it is -thrift x cost / 50. Thrift counts triple while the household is
    belt-tightening.
    """
    cost = opt.cost
    if cost <= 0:
        return 0.0
    hh = sim.households[agent.household_id]
    thrift = agent.profile.traits["thrift"] * (3 if hh.tight_until > sim.clock.tick else 1)
    if getattr(opt, "household_pays", False):
        spare = funds(sim, hh) - 2 * weekly_outgo(sim, hh)
        return -1.5 if cost > spare else -thrift * (cost / spare) ** 2
    own = agent.money + agent.savings
    if cost <= own:
        return -cost / max(own, 50) * thrift
    spare = funds(sim, hh) - 2 * weekly_outgo(sim, hh)
    if cost <= spare:
        return -cost / max(spare, 50) * thrift
    if not getattr(opt, "charge", True):
        return -cost / 50 * thrift
    return -2.0

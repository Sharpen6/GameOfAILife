"""Homes: the 37 dwellings of Millbrook, who owns and lives in them, their condition, and household money.

Group A (data, helpers and serializers) is complete. Group B (the mechanics hooks the simulation calls:
weekly charges, nightly decay, emergencies, effects) holds today's behaviour as stubs; the housing package
fills them in without changing a signature or a call site.

Vocabulary: a Home is one dwelling (a house, or one flat of an apartment block); a Lot is the building a home
stands on (one per residential place) and holds its condition. Owners are "landlord" (Millbrook Homes),
"market" (vacant and for sale) or a household id. Everything is keyed by string ids and kept in plain
fields, so the JS port mirrors it one to one.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from .clock import Clock
from .rng import r2

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
    pending_emergency: dict | None = None  # hidden {"kind", "due"}: never serialised
    emergency: dict | None = None  # live {"kind", "since"}: public
    history: list[dict] = field(default_factory=list)  # {"tick", "time", "event", "household", "price"}


@dataclass(eq=False)
class Lot:
    place: str  # a residential place id
    condition: float  # 0-100
    works_until: int = 0  # builders on site until this tick
    moving_until: int = 0  # a moving van at the curb until this tick
    reported: int = 0  # worst stage already announced; starts at the current stage


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
            lots[place.id] = Lot(place.id, c, reported=stage_of(c))
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


def listed(sim, home: Home) -> str | None:
    """The home's listing as buyers see it: None while it is under offer."""
    return home.listing if home.under_offer_until <= sim.clock.tick else None


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


def worth_parts(sim, agent: Agent) -> dict:
    """{"cash", "savings", "home"} in whole dollars. Savings include the savings-goal pot; home is an adult's
    equal share of an owned home's value."""
    hh = sim.households[agent.household_id]
    home = 0.0
    if agent.alive and agent.is_adult and tenure(sim, hh) == "owned":
        home = value(sim, hh.home_id) / max(1, len(adults(sim, hh)))
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


def pay_household(sim, hh: Household, amount: float) -> None:
    """Pay `amount` from the household's living adults, in proportion to each one's max(0, money + savings)
    (equally when every one is at or below zero). Each share comes out of savings first, then money, which may
    go negative. A negative amount (money coming in) is split equally into the adults' savings."""
    payers = adults(sim, hh)
    if not payers or not amount:
        return
    if amount < 0:
        for a in payers:
            a.savings += -amount / len(payers)
        return
    weights = [max(0.0, a.money + a.savings) for a in payers]
    total = sum(weights)
    for a, wt in zip(payers, weights):
        due = amount * (wt / total if total > 0 else 1 / len(payers))
        take = min(max(a.savings, 0.0), due)
        a.savings -= take
        a.money -= due - take


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


# --- group B: mechanics hooks (stubs with today's behaviour) ----------------------------------

def weekly_charges(sim) -> None:
    """Sunday 23:00: each household's living adults split the rent (owners pay none) and pay their bills."""
    from .sim import BILLS_PER_ADULT, CAR_BILL  # sim imports this module, so not at the top

    for hh in sim.households.values():
        payers = adults(sim, hh)
        if not payers:
            continue
        rent = 0.0 if tenure(sim, hh) == "owned" else hh.weekly_rent
        bills = 0.0
        for a in payers:
            bill = BILLS_PER_ADULT + (CAR_BILL if a.owns_car else 0.0)
            a.money -= rent / len(payers) + bill
            bills += bill
        names = " and ".join(a.name.split()[0] for a in payers)
        text = f"{names} paid ${rent:.0f} rent and ${bills:.0f} in bills." if rent else f"{names} paid ${bills:.0f} in bills."
        sim.event(text, tag="bills_paid", place=sim.homes[hh.home_id].place)
        for a in payers:
            if a.money < 0:
                sim.event(f"{a.name} is behind on money after the week's bills.", a, tag="in_the_red")


def nightly(sim) -> None:
    """Midnight: decay, the landlord's repairs, emergencies rolled. Nothing yet."""


def tick(sim) -> None:
    """Every tick, before the agents: emergencies going live. Nothing yet."""


def on_death(sim, agent: Agent) -> None:
    """After a death and the household update: an emptied home goes back on the market. Nothing yet."""


def apply_extra(sim, agent: Agent, fork, opt) -> None:
    """The housing extras of a chosen option (move, repair, works, ...). Nothing yet."""


def apply_effect(sim, agent: Agent, key, value) -> bool:
    """Apply a housing outcome effect; True when the key was a housing one. None yet."""
    return False


def activity_gain_scale(sim, agent: Agent) -> float:
    """Multiplier on the positive gains of activities at the agent's own home (comfort). 1.0 for now."""
    return 1.0


def afford_score(sim, agent: Agent, opt) -> float:
    """The money term of default_scores: what an option's cost does to its appeal."""
    if opt.cost > agent.money:
        return -2.0
    return -opt.cost / max(agent.money, 50) * agent.profile.traits["thrift"]

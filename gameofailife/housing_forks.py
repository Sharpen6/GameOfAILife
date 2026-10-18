"""The four housing forks: house hunting, upkeep, emergency repairs and housing trouble (housing.md section 9).

Each builder returns a Fork with exactly four options, or None when the fork doesn't come up. Every
conditional option has a fixed fallback in its slot, so four is guaranteed by construction (decision 56).
The fork is the household's: the builder sets a household cooldown when it builds one, so a partner is not
asked the same question again. `forks.build_fork` resolves these lazily, so this module may import `forks`
freely.
"""

from __future__ import annotations

import math
from typing import TYPE_CHECKING

from . import housing
from .forks import Fork, Option, Outcome
from .housing import (CAR_SALE, DAY, GRACE_HOLD_DAYS, LANDLORD, MOVING_COST, ODD_JOBS_PAY, RENO_FACTOR, STAGES,
                      STUFF_PRICE, TIERS, round10, stage_of)

if TYPE_CHECKING:
    from .agent import Agent, Household
    from .sim import Simulation

MAJOR_KINDS = {"house_hunt", "housing_trouble"}  # forks the Director settles by habit only with a lead of MAJOR_MARGIN

NO_CANDIDATE_RETRY = 6 * 60  # minutes before house_hunt looks again when nothing on the market will do
HUNT_COOLDOWN = 7 * DAY
UPKEEP_COOLDOWN = 5 * DAY  # once a weekend
REPAIR_COOLDOWN = 60  # one adult answers the emergency
TROUBLE_COOLDOWN = {"arrears": 3 * DAY, "cant_fix": 7 * DAY}
RENT_CUT = 40  # a renter downsizes only to a home at least this much cheaper a week
DOWNSIZE_AFTER_DAYS = 90  # a household thinks of downsizing only after this long in its home (or in the game)
DOWNSIZE_BASE = 0.1  # house_hunt's downsizing variant: the base of selling up and buying smaller (renting: less) ...
DOWNSIZE_RETIRED = 0.35  # ... and how much more inviting it is once every adult is retired
DOWNSIZE_DRIFT = 0.05  # ... and this much more for every 30 days beyond DOWNSIZE_AFTER_DAYS in the home ...
DOWNSIZE_DRIFT_MAX = 0.4  # ... up to this: the spare rooms weigh more as the months go by
DOWNSIZE_SETTLE = 120 * DAY  # after downsizing, a household doesn't look at the market again for this long ...
DOWNSIZE_NO_BIGGER = 360 * DAY  # ... nor at a home with more bedrooms for this long, unless it gets crowded
DOWNSIZE_STAY = 60 * DAY  # a household that decides to stay put isn't asked about downsizing again for this long
HELP_MARGIN = 300  # asking a friend for the deficit plus this ...
HELP_RICH = 3  # ... of a friend with at least this many times that put by
REPAIR_FRIEND = 30  # affinity of a friend who would come and help fix it
HELP_FRIEND = 20  # affinity of a friend one could ask for money
HANDYMAN = 90
PIZZA = 20
BUILDERS_WORKS = 240  # minutes the builders' van stands at the lot
EMERGENCY_WORKS = 120
UPKEEP_BELOW = 75  # upkeep comes up below this condition
FRESH_DAYS = 7  # for this long after moving into a home ...
FRESH_BELOW = 40  # ... below this condition, upkeep comes up on weekday evenings too

TRADE = {"leak": "plumber", "boiler": "heating engineer", "roof": "roofer", "electrics": "electrician"}
WAIT = {"leak": "Put a bucket under it and deal with it later", "roof": "Put a bucket under it and deal with it later",
        "boiler": "Wrap up warm and deal with it later", "electrics": "Use candles and deal with it later"}
TROUBLE = {"leak": "a pipe has burst in the kitchen at {home}.",
           "boiler": "the boiler has broken down: no heating or hot water.",
           "roof": "rain is coming in through the roof.", "electrics": "the electrics keep tripping out."}
LOOKS = ["a little tired", "worn", "shabby", "run-down", "close to falling apart"]  # by stage
GOSSIP = [0.05, 0.1, 0.4, 0.7, 0.7]  # by stage


# --- shared helpers ------------------------------------------------------------

def _hh_window(sim: Simulation) -> bool:
    """When the household sits down to talk money: weekday evenings 18-21, weekend days 10-18."""
    h, wd = sim.clock.hour, sim.clock.weekday
    return (wd >= 5 and 10 <= h < 18) or (wd < 5 and 18 <= h < 21)


def _ready(sim: Simulation, agent: Agent, hh: Household, kind: str) -> bool:
    """An adult whose household's cooldown for this kind is over (the shift check comes last: it is the dear one)."""
    return agent.alive and agent.is_adult and hh.cooldowns.get(kind, 0) <= sim.clock.tick


def _first(agent: Agent) -> str:
    return agent.name.split()[0]


def _stage_note(sim: Simulation, home_id: str) -> str:
    """', shabby' or ', neglected' (or ', derelict') for a home in poor shape, else ''."""
    st = stage_of(housing.condition_of(sim, home_id))
    return f", {STAGES[st][0]}" if st >= 2 else ""


def _has_kids(sim: Simulation, hh: Household) -> bool:
    return any(not a.is_adult for a in housing._members(sim, hh))


def _friend(sim: Simulation, agent: Agent, hh: Household, above: float, rich: float | None = None) -> Agent | None:
    """The adult outside the household the character likes best, above `above` affinity, with at least `rich`
    put by when given (ties: id)."""
    pool = []
    for oid, rel in agent.relationships.items():
        other = sim.agents.get(oid)
        if (other is None or oid in hh.member_ids or not other.alive or not other.is_adult or rel.affinity <= above
                or (rich is not None and other.money + other.savings < rich)):
            continue
        pool.append((rel.affinity, oid))
    return sim.agents[max(pool)[1]] if pool else None


def _partner(sim: Simulation, agent: Agent, hh: Household) -> Agent | None:
    """Another adult of the household: the partner if there is one."""
    others = [a for a in housing.adults(sim, hh) if a is not agent]
    partners = [a for a in others if (r := agent.relationships.get(a.id)) and r.kind.value == "partner"]
    return (partners or others or [None])[0]


def _move_outcomes(sim: Simulation, hh: Household, agent: Agent, home_id: str, bargain: bool,
                   doubts: bool) -> list[Outcome]:
    worse = 0.3 if stage_of(housing.condition_of(sim, home_id)) >= 2 else 0.15
    outs = [Outcome("bargain", "Turns out to be a real bargain", 0.4, +1, {"fun": 15, "family_bond": 2}) if bargain
            else Outcome("dream_home", "Falls in love with the new place", 0.5, +1, {"fun": 15, "family_bond": 2}),
            Outcome("hidden_fault", "The survey missed a fault: repairs needed", worse, -1, {"home_condition": -15}),
            Outcome("nice_neighbours", "Meets friendly new neighbours", 0.3, +1, {"meet_neighbour": True}),
            Outcome("moving_chaos", "A box of dishes breaks in the move", 0.25, -1, {"money": -80, "fun": -5})]
    partner = _partner(sim, agent, hh) if doubts else None
    if partner:
        outs.append(Outcome("partner_doubts", f"{_first(partner)} worries it's too expensive",
                            0.6 * partner.profile.traits.get("thrift", 0.5), -1, {("rel", partner.id): -3, "fun": -3}))
    return outs


# --- house_hunt (major) -----------------------------------------------------------

def house_hunt_fork(sim: Simulation, agent: Agent) -> Fork | None:
    """A better home the household can afford is on the market: buy (or rent) the best, haggle for it, take the
    cheaper one (or keep looking), or stay put. A run-down home is bought with its renovation, done the day it is
    bought (the affordability gate already counts it), so it is never derelict in use. With nothing better on the
    market, an owner household that has outgrown its home gets the downsizing variant instead, when a smaller home
    will do (`_downsize_hunt`)."""
    hh = sim.households[agent.household_id]
    now = sim.clock.tick
    if (not _hh_window(sim) or not _ready(sim, agent, hh, "house_hunt") or hh.arrears
            or (hh.moved_tick is not None and now - hh.moved_tick < housing.MOVE_GAP_DAYS * DAY)
            or sim.on_shift_now(agent)):
        return None
    cands = housing.hunt_candidates(sim, hh)
    if not cands:
        settled = now - (hh.moved_tick or 0) >= DOWNSIZE_AFTER_DAYS * DAY
        fork = _downsize_hunt(sim, agent, hh) if settled and housing.outgrown(sim, hh) else None
        if fork is None:
            hh.cooldowns["house_hunt"] = now + NO_CANDIDATE_RETRY
        return fork
    hh.cooldowns["house_hunt"] = now + HUNT_COOLDOWN
    cur = sim.homes[hh.home_id]
    renting = cur.owner != hh.id
    crowded = housing.crowded(sim, hh)
    funds = housing.funds(sim, hh)
    outgo = housing.weekly_outgo(sim, hh)
    cond = {h.id: housing.condition_of(sim, h.id) for h in cands}
    worth = {h.id: housing.value(sim, h.id) for h in cands}
    reno = {h.id: housing.reno_cost(sim, h.id) if housing.buys(h) else 0 for h in cands}
    a = max(cands, key=lambda h: (TIERS[h.tier]["rank"], worth[h.id], cond[h.id], h.id))
    rest = [h for h in cands if h is not a]
    b = min(rest, key=lambda h: (housing.net_cost(sim, hh, h.id), cond[h.id], h.id)) if rest else None

    def rises(h) -> bool:
        return housing.weekly_outgo(sim, hh, h.id) > outgo

    def bonus(h) -> float:
        return (0.2 if renting and housing.buys(h) else 0.0) + (0.3 if crowded and h.bedrooms > cur.bedrooms else 0.0)

    def label(h, cheaper: bool) -> str:
        the = "the cheaper " if cheaper else ""
        tier = TIERS[h.tier]["label"]
        if housing.buys(h):
            done_up = f" and do it up (${reno[h.id]:,})" if reno[h.id] else ""
            return f"Buy {the}{h.name} ({tier}{_stage_note(sim, h.id)}) for ${worth[h.id]:,}{done_up}"
        return f"Move into {the}{h.name} ({tier}{_stage_note(sim, h.id)}) for ${h.rent}/week"

    def move(h, cheaper: bool) -> Option:
        how = "buy" if housing.buys(h) else "rent"
        if cheaper:
            tags = {"thrift": 0.3 if rises(h) else 0.7, "family": 0.3}
            if stage_of(cond[h.id]) >= 2:
                tags["diligence"] = 0.3
        else:
            tags = {"family": 0.6, "adventure": 0.4, "thrift": -0.6 if rises(h) else -0.2}
        extra = {"move": h.id, "how": how, "renovate": reno[h.id]} if reno[h.id] else {"move": h.id, "how": how}
        return Option(label(h, cheaper), [("move_house", h.place)],
                      cost=max(0, housing.net_cost(sim, hh, h.id)) + reno[h.id],
                      base=(0.30 if cheaper else 0.35) + bonus(h), tags=tags, gains={"fun": 15 if cheaper else 20},
                      outcomes=_move_outcomes(sim, hh, agent, h.id, cheaper, rises(h) and not cheaper),
                      extra=extra, household_pays=True, charge=False)

    best = move(a, False)
    deal = {"renovate": reno[a.id]} if reno[a.id] else {}  # the deal's renovation, a companion of "buy"
    if housing.buys(a):
        offer = housing._int(worth[a.id] * 0.9)
        done_up = f" (and ${reno[a.id]:,} to do it up)" if reno[a.id] else ""
        haggle_label = f"Offer ${offer:,} for {a.name}{done_up} and see what the seller says"
        cost = housing.net_cost(sim, hh, a.id) - 0.1 * worth[a.id] + reno[a.id]
        says = ("The seller accepts the offer", "The seller meets them halfway", "Another buyer snaps it up first",
                "The seller turns the offer down")
    else:
        offer = housing._int(a.rent * 0.9)
        haggle_label = f"Ask the landlord to let {a.name} for ${offer}/week"
        cost = housing.net_cost(sim, hh, a.id)
        says = (f"{LANDLORD} agrees to the lower rent", f"{LANDLORD} meets them halfway",
                "Another family takes it first", f"{LANDLORD} turns the offer down")
    # The listing is held for the offer from the decision until the answer lands after the viewing, so the
    # answer is never about a home somebody else took meanwhile; a refusal hands it back to the market.
    haggle = Option(haggle_label, [("viewing", a.place)], cost=max(0, _whole(cost)), base=0.30 + bonus(a),
                    tags={"thrift": 0.5, "adventure": 0.4, "diligence": -0.1}, gains={"fun": 10},
                    outcomes=[Outcome("offer_accepted", says[0], 0.40, +1, {"factor": 0.9, **deal, "buy": a.id},
                                      group="deal"),
                              Outcome("meet_halfway", says[1], 0.35, +1, {"factor": 0.95, **deal, "buy": a.id},
                                      group="deal"),
                              Outcome("outbid", says[2], 0.25, -1, {"withdraw": a.id, "fun": -10}, group="deal"),
                              Outcome("refused", says[3], 1.0, 0, {"fun": -4, "release": a.id}, group="deal")],
                    extra={"hold": a.id}, household_pays=True, charge=False)
    cheaper = move(b, True) if b else _keep_looking("Keep looking for the right place", 0.15, 3 * DAY)
    saves = renting and any(housing.buys(h) and not rises(h) for h in cands)
    stay_tags = {"thrift": 0.0 if saves else 0.5, "adventure": -0.5}
    if crowded:
        stay_tags["family"] = -0.2
    stay = Option(f"Stay in {cur.name} and keep the money", [("relax_home", "home")],
                  base=0.25 - (0.4 if crowded else 0.0), tags=stay_tags, gains={"fun": 10},
                  outcomes=[Outcome("content", "Feels content at home", 0.5, +1, {"fun": 5}),
                            Outcome("itchy_feet", "Keeps thinking about that place", 0.3, -1, {"fun": -5})],
                  extra={"hh_cooldown": 14 * DAY})
    tenure = (f"rented, ${housing._int(hh.weekly_rent)}/week" if renting
              else f"yours, worth about ${housing.value(sim, cur.id):,}")
    question = (f"Your household has ${_whole(funds):,} put by. You live in {cur.name} ({tenure}). "
                f"There are homes on the market you could afford. Do you move?")
    return Fork(agent.id, "house_hunt", question, [best, haggle, cheaper, stay], now, major=True)


def _keep_looking(label: str, base: float, cooldown: int) -> Option:
    return Option(label, [("read", "home")], base=base, tags={"thrift": 0.3, "diligence": 0.2, "adventure": -0.2},
                  gains={"fun": 10},
                  outcomes=[Outcome("new_listing", "Spots a promising new listing", 0.3, +1, {"fun": 4})],
                  extra={"hh_cooldown": cooldown})


def _downsize_hunt(sim: Simulation, agent: Agent, hh: Household) -> Fork | None:
    """house_hunt for an owner household that has outgrown its home (`housing.outgrown`) and lived there at least
    DOWNSIZE_AFTER_DAYS, when nothing better is on the market: sell up and buy the smaller home `housing_trouble`
    would offer, sell up and rent the cheapest fitting home to let, keep looking, or stay (not asked again for
    DOWNSIZE_STAY). Either move, once it goes through, settles the household for DOWNSIZE_SETTLE and keeps it out
    of bigger homes for DOWNSIZE_NO_BIGGER. A move that isn't available (no smaller home for sale, or no rental
    the household can carry) gives its slot to "decide another time"; with neither there is no fork. Selling up
    is the thrifty choice; it gets easier to make once everyone is retired and with every month (DOWNSIZE_DRIFT)
    the household has lived there, so it comes now and then, not for all."""
    now = sim.clock.tick
    cur = sim.homes[hh.home_id]
    people = housing.adults(sim, hh)
    retired = all(housing.retired(a) for a in people)
    smaller = housing.downsize_candidates(sim, hh)
    rental = housing.cheapest_rental(sim, hh)
    if rental is not None and not housing.affordable(sim, hh, rental.id):
        rental = None
    if not smaller and rental is None:
        return None
    hh.cooldowns["house_hunt"] = now + HUNT_COOLDOWN
    months = (now - (hh.moved_tick or 0) - DOWNSIZE_AFTER_DAYS * DAY) // (30 * DAY)
    lift = (DOWNSIZE_RETIRED if retired else 0.0) + min(DOWNSIZE_DRIFT_MAX, DOWNSIZE_DRIFT * months)
    moves = [_sell_and_buy(sim, hh, _smallest(sim, smaller), DOWNSIZE_BASE + lift) if smaller else None,
             _sell_and_rent(sim, hh, rental, DOWNSIZE_BASE - 0.05 + lift) if rental else None]
    later = Option("Talk it over and decide another time", [("relax_home", "home")], base=0.05,
                   tags={"family": 0.2, "diligence": -0.2}, gains={"fun": 5},
                   outcomes=[Outcome("talk", "A long talk about the future", 0.4, +1, {"fun": 4})] if len(people) > 1
                   else [], extra={"hh_cooldown": 7 * DAY})
    for opt in moves:
        if opt:
            opt.extra["settle"] = {"house_hunt": DOWNSIZE_SETTLE, "bigger_home": DOWNSIZE_NO_BIGGER}
    look = _keep_looking("Keep looking for the right smaller place", 0.1, 14 * DAY)
    stay = Option(f"Stay in {cur.name}: it's home", [("relax_home", "home")], base=0.15,
                  tags={"family": 0.3, "thrift": -0.3, "adventure": -0.4}, gains={"fun": 10},
                  outcomes=[Outcome("content", "Feels content at home", 0.5, +1, {"fun": 5}),
                            Outcome("too_quiet", "The place feels big and quiet", 0.3, -1, {"fun": -5})],
                  extra={"hh_cooldown": DOWNSIZE_STAY})
    n = housing.residents(sim, hh)
    whom = "just you" if n == 1 else f"the {n} of you"
    retiring = retired and (cur.arrived is None or not cur.arrived["retired"])  # else they have shrunk
    why = "now that you are retired" if retiring else f"with {cur.bedrooms} bedrooms for {whom}"
    question = (f"Your household has ${_whole(housing.funds(sim, hh)):,} put by. You own {cur.name}, worth about "
                f"${housing.value(sim, cur.id):,}: more home than you need {why}. Nothing better is on the market, "
                f"but a smaller place is. Do you downsize?")
    return Fork(agent.id, "house_hunt", question, [m or later for m in moves] + [look, stay], now, major=True)


def _whole(x: float) -> int:
    return housing._int(x)


# --- upkeep -----------------------------------------------------------------------

def upkeep_fork(sim: Simulation, agent: Agent) -> Fork | None:
    """An owned home is wearing: builders, DIY, a tidy-up, or leave it. Weekends 09-17, below condition 75; and in
    the household's usual window on any day of its first FRESH_DAYS in a home bought below condition FRESH_BELOW,
    so a fixer-upper can be renovated before its first nights in use take it below neglected."""
    hh = sim.households[agent.household_id]
    home = sim.homes[hh.home_id]
    hour = sim.clock.hour
    weekend = sim.clock.weekday >= 5 and 9 <= hour < 17
    fresh = hh.moved_tick is not None and sim.clock.tick - hh.moved_tick < FRESH_DAYS * DAY
    if (not (weekend or (fresh and _hh_window(sim))) or home.owner != hh.id
            or home.tier not in ("house", "big_house") or home.emergency or not _ready(sim, agent, hh, "upkeep")):
        return None
    c = housing.condition_of(sim, home.id)
    if c >= UPKEEP_BELOW or (not weekend and c >= FRESH_BELOW) or sim.on_shift_now(agent):
        return None
    hh.cooldowns["upkeep"] = sim.clock.tick + UPKEEP_COOLDOWN
    t = TIERS[home.tier]
    st = stage_of(c)
    reno = c < 50
    pts = _whole(100 - c) if reno else min(40, _whole(100 - c))
    quote = round10(pts * t["pro_rate"] * (RENO_FACTOR if reno else 1.0)) + housing.CALLOUT
    when = "this weekend" if weekend else "this evening"
    pro_base = 0.3 + (0.4 if c < 40 else 0.0) + (0.3 if c < 20 else 0.0)
    leave_base = 0.0 - (0.3 if c < 40 else 0.0) - (0.3 if c < 20 else 0.0)
    opts = [
        Option(f"Hire Millbrook Builders for {'a full renovation' if reno else 'a proper job'} (${quote:,})",
               [("let_builders_in", "home")], cost=quote, base=pro_base,
               tags={"thrift": -0.5, "diligence": 0.5, "family": 0.3}, gains={"fun": 10},
               outcomes=[Outcome("fine_job", "The builders do a beautiful job", 0.35, +1, {"home_condition": 8}),
                         Outcome("cowboys", "Cowboy builders: the work is shoddy", 0.12, -1,
                                 {"home_condition": -_whole(pts / 2)}),
                         Outcome("hidden_damp", "They find hidden damp: the bill goes up", 0.15, -1,
                                 {"hh_money": -_whole(0.4 * quote)})],
               extra={"repair": pts, "works": BUILDERS_WORKS}, household_pays=True),
        Option(f"Do it yourself {when} (${t['diy_cost']} in materials)", [("diy", "home")], cost=t["diy_cost"],
               base=0.3 - (0.1 if c < 40 else 0.0),
               tags={"thrift": 0.6, "diligence": 0.5, "adventure": 0.3, "health": -0.2}, gains={"fun": 10},
               outcomes=[Outcome("proud", "Proud of the work", 0.5, +1, {"fun": 10}),
                         Outcome("botched", "Botches part of the job", 0.18, -1, {"home_condition": -8}),
                         Outcome("hurt", "Hurts their back on the ladder", 0.12 if agent.age >= 65 else 0.06, -1,
                                 {"health": -8, "energy": -10}),
                         Outcome("help_arrives", "A neighbour pops over to help", 0.15, +1,
                                 {"meet_neighbour": True, "home_condition": 5})],
               extra={"repair": t["diy_pts"]}, household_pays=True),
        Option(f"Just tidy up and patch the worst bits (${t['tidy_cost']})", [("tidy", "home")], cost=t["tidy_cost"],
               base=0.2, tags={"thrift": 0.4, "diligence": 0.2, "adventure": -0.3}, gains={"fun": 5},
               outcomes=[Outcome("compliment", "A neighbour compliments the garden", 0.2, +1, {"social": 6}),
                         Outcome("drop_in_ocean", "Feels like a drop in the ocean", 0.3 if c < 50 else 0.1, -1,
                                 {"fun": -4})],
               extra={"repair": 6}, household_pays=True),
        Option("Leave it for another time", [("relax_home", "home")], base=leave_base,
               tags={"thrift": 0.5, "diligence": -0.6, "adventure": 0.2}, gains={"fun": 20},
               outcomes=[Outcome("gossip", "The neighbours gossip about the state of the place", GOSSIP[st], -1,
                                 {"reputation": -2}),
                         Outcome("damage_spreads", "A small problem gets worse", 0.2, -1, {"home_condition": -5}),
                         Outcome("lazy_weekend", f"A lovely lazy {'weekend' if weekend else 'evening'}", 0.4, +1,
                                 {"fun": 8})]),
    ]
    question = (f"{home.name} is looking {LOOKS[st]} (condition {math.floor(c)}/100). "
                + ("What do you do about it this weekend?" if weekend else
                   "You have only just moved in. What do you do about it?"))
    return Fork(agent.id, "upkeep", question, opts, sim.clock.tick)


# --- repair (a live emergency) ----------------------------------------------------------

def repair_fork(sim: Simulation, agent: Agent) -> Fork | None:
    """A live emergency at an owner-occupied home: call the trade, fix it yourself, ask a friend (or a cheap
    handyman), or wait. 07:00-22:00."""
    hh = sim.households[agent.household_id]
    home = sim.homes[hh.home_id]
    live = home.emergency
    if (not live or not 7 <= sim.clock.hour < 22 or home.tier not in ("house", "big_house")
            or not _ready(sim, agent, hh, "repair") or sim.on_shift_now(agent)):
        return None
    hh.cooldowns["repair"] = sim.clock.tick + REPAIR_COOLDOWN
    t = TIERS[home.tier]
    kind = live["kind"]
    friend = _friend(sim, agent, hh, REPAIR_FRIEND)
    if friend:
        rel = ("rel", friend.id)
        name = _first(friend)
        helper = Option(f"Ask {name} to come and help (${PIZZA} for pizza)", [("fix_it", "home")], cost=PIZZA,
                        base=0.3, tags={"social": 0.7, "family": 0.3, "thrift": 0.4},
                        outcomes=[Outcome("fixed_together", f"Fixes it together with {name}", 0.5, +1,
                                          {"fix_emergency": True, rel: 4}, group="fix"),
                                  Outcome("friend_busy", f"{name} can't make it", 1.0, -1, {rel: -1, "fun": -4},
                                          group="fix")],
                        extra={"ask_help": friend.id}, household_pays=True)
    else:
        helper = Option(f"Call the cheapest handyman in the paper (${HANDYMAN})", [("let_builders_in", "home")],
                        cost=HANDYMAN, base=0.3, tags={"thrift": 0.5, "adventure": 0.3},
                        outcomes=[Outcome("fixed_cheap", "The handyman sorts it out", 0.6, +1, {"fix_emergency": True},
                                          group="fix"),
                                  Outcome("botched_cheap", "The handyman makes a mess of it", 0.8, -1,
                                          {"home_condition": -5}, group="fix")],
                        household_pays=True)
    opts = [
        Option(f"Call an emergency {TRADE[kind]} now (${t['emergency_cost']})", [("let_builders_in", "home")],
               cost=t["emergency_cost"], base=0.45,
               tags={"thrift": -0.5, "diligence": 0.3, "family": 0.4, "health": 0.2},
               outcomes=[Outcome("quick_fix", "Fixed in no time", 0.5, +1, {"fun": 5}),
                         Outcome("more_damage", "They find more damage behind the wall", 0.2, -1,
                                 {"hh_money": -120, "home_condition": -3}),
                         Outcome("overcharged", "The bill is bigger than quoted", 0.15, -1, {"hh_money": -60})],
               extra={"fix_emergency": True, "works": EMERGENCY_WORKS}, household_pays=True),
        Option(f"Try to fix it yourself (${t['parts']} in parts)", [("fix_it", "home")], cost=t["parts"], base=0.3,
               tags={"thrift": 0.6, "diligence": 0.4, "adventure": 0.4, "health": -0.2},
               outcomes=[Outcome("fixed_it", "Fixes it!", 0.55, +1, {"fix_emergency": True, "fun": 10}, group="diy"),
                         Outcome("made_worse", "Makes it worse", 0.45, -1, {"home_condition": -8}, group="diy"),
                         Outcome("hurt", "Gets hurt doing it", 0.14 if agent.age >= 65 else 0.07, -1, {"health": -10})],
               household_pays=True),
        helper,
        Option(WAIT[kind], [("relax_home", "home")], base=-0.2, tags={"thrift": 0.5, "diligence": -0.5, "adventure": 0.2},
               gains={"fun": 10},
               outcomes=[Outcome("gets_worse", "It gets worse overnight", 0.5, -1, {"home_condition": -6}),
                         Outcome("holds_up", "It holds up for now", 0.4, +1, {})],
               extra={"hh_cooldown": DAY}),
    ]
    question = f"Trouble at home: {TROUBLE[kind].format(home=home.name)} What do you do?"
    return Fork(agent.id, "repair", question, opts, sim.clock.tick)


# --- housing_trouble (major) ---------------------------------------------------------

def _trouble(sim: Simulation, hh: Household) -> tuple[str, float, int] | None:
    """(reason, deficit, renovation quote) when the household is in trouble, else None."""
    f = housing.funds(sim, hh)
    if hh.arrears >= 1 and f < 0:
        return "arrears", -f, 0
    home = sim.homes[hh.home_id]
    if home.owner == hh.id and housing.condition_of(sim, home.id) < 40:
        reno = housing.reno_cost(sim, home.id)
        spare = f - 2 * housing.weekly_outgo(sim, hh)
        if reno > spare:
            return "cant_fix", reno - max(spare, 0.0), reno
    return None


def _downsize_outcomes(sim: Simulation, hh: Household) -> list[Outcome]:
    outs = [Outcome("fresh_start", "Feels like a fresh start", 0.35, +1, {"fun": 10}),
            Outcome("homesick", "Misses the old place", 0.4, -1, {"fun": -10})]
    if _has_kids(sim, hh):
        outs.append(Outcome("kids_upset", "The children are upset about moving", 0.5, -1, {"family_bond": -3}))
    return outs


def _move_down(sim: Simulation, hh: Household, home, how: str, text: str, cost: float, base: float) -> Option:
    """A move to a smaller or cheaper home (housing.md 9.4's downsize-buy and downsize-rent)."""
    tags = ({"thrift": 0.6, "family": -0.1, "adventure": 0.2} if how == "buy"
            else {"thrift": 0.7, "family": -0.3, "adventure": 0.2})
    return Option(text, [("move_house", home.place)], cost=cost, base=base, tags=tags,
                  outcomes=_downsize_outcomes(sim, hh), extra={"move": home.id, "how": how}, household_pays=True,
                  charge=False)


def _smallest(sim: Simulation, homes: list):
    """The one to downsize to: the cheapest (ties: better condition, then id)."""
    return min(homes, key=lambda h: (housing.value(sim, h.id), -housing.condition_of(sim, h.id), h.id))


def _sell_and_buy(sim: Simulation, hh: Household, home, base: float) -> Option:
    cur = sim.homes[hh.home_id]
    return _move_down(sim, hh, home, "buy", f"Sell {cur.name} (about ${housing.sale_proceeds(sim, cur.id):,}) and "
                      f"buy the smaller {home.name} for ${housing.value(sim, home.id):,}",
                      max(0, housing.net_cost(sim, hh, home.id)), base)


def _sell_and_rent(sim: Simulation, hh: Household, home, base: float) -> Option:
    cur = sim.homes[hh.home_id]
    return _move_down(sim, hh, home, "rent", f"Sell {cur.name} (about ${housing.sale_proceeds(sim, cur.id):,}) and "
                      f"rent {home.name} for ${home.rent}/week", 0, base)


def _chain(sim: Simulation, agent: Agent, hh: Household, reason: str, deficit: float, esc: int) -> list[Option]:
    """The trouble options that are available now, in order: downsize-buy, downsize-rent, ask for help, sell the
    car, sell belongings (housing.md 9.4, PLAN 5.4)."""
    now = sim.clock.tick
    owner = sim.homes[hh.home_id].owner == hh.id
    chain = []
    if owner:
        smaller = housing.downsize_candidates(sim, hh)
        if smaller:
            chain.append(_sell_and_buy(sim, hh, _smallest(sim, smaller), 0.35 + 0.25 * esc))
    # Rents are whole tens, so "under rent - RENT_CUT + 1" is "at least RENT_CUT cheaper".
    r = housing.cheapest_rental(sim, hh, below=None if owner else hh.weekly_rent - RENT_CUT + 1)
    if r:
        if owner:
            chain.append(_sell_and_rent(sim, hh, r, 0.35 + 0.25 * esc))
        else:
            cost = 0 if reason == "arrears" and hh.arrears > 0 else MOVING_COST  # the landlord moves them free
            chain.append(_move_down(sim, hh, r, "rent", f"Move to the cheaper {r.name} (${r.rent}/week instead of "
                                    f"${housing._int(hh.weekly_rent)})", cost, 0.35 + 0.25 * esc))
    friend = _friend(sim, agent, hh, HELP_FRIEND, rich=HELP_RICH * (deficit + HELP_MARGIN))
    if friend:
        amount = int(math.ceil((deficit + HELP_MARGIN) / 100) * 100)
        rel = ("rel", friend.id)
        name = _first(friend)
        chain.append(Option(f"Ask {name} to help out with ${amount:,}", [("phone_call", None)], base=0.3,
                            tags={"family": 0.6, "social": 0.4, "thrift": 0.2, "diligence": -0.2},
                            outcomes=[Outcome("helps", f"{name} helps out", 0.55, +1,
                                              {"amount": amount, "gift_from": friend.id, rel: 2}, group="help"),
                                      Outcome("lecture", f"{name} helps, with a lecture about money", 0.6, 0,
                                              {"amount": amount, "gift_from": friend.id, rel: -3, "fun": -5},
                                              group="help"),
                                      Outcome("refuses", f"{name} says no", 1.0, 0, {rel: -4, "fun": -8}, group="help")]))
    if any(a.owns_car for a in housing.adults(sim, hh)):
        chain.append(Option(f"Sell the car (about ${CAR_SALE:,})", [("relax_home", "home")], base=0.25,
                            tags={"thrift": 0.6, "adventure": -0.2, "health": 0.2},
                            outcomes=[Outcome("miss_car", "Misses having the car", 0.5, -1, {"fun": -6})],
                            extra={"sell_car": True}))
    if hh.cooldowns.get("sell_stuff", 0) <= now:
        chain.append(Option(f"Sell some furniture and belongings (about ${STUFF_PRICE})", [("relax_home", "home")],
                            base=0.2, tags={"thrift": 0.5, "family": -0.2},
                            outcomes=[Outcome("sad_to_see", "Sad to see their things go", 0.5, -1, {"fun": -8})],
                            extra={"sell_stuff": STUFF_PRICE}))
    return chain


def _fallbacks(sim: Simulation, hh: Household, esc: int) -> list[Option]:
    """Grace and odd jobs: always available, their good outcome rationed by a household cooldown (PLAN 5.4)."""
    now = sim.clock.tick
    owner = sim.homes[hh.home_id].owner == hh.id
    granted = 0.0 if hh.cooldowns.get("grace", 0) > now else 0.6
    paid = 0.0 if hh.cooldowns.get("odd_jobs", 0) > now else 0.65
    grace = Option("Ask the bank for a few weeks' grace" if owner else f"Ask {LANDLORD} for a few weeks' grace",
                   [("phone_call", None)], base=0.2 + 0.1 * esc, tags={"thrift": 0.3, "diligence": 0.2, "social": 0.2},
                   outcomes=[Outcome("granted", "They agree to give it a few weeks", granted, +1,
                                     {"grace": GRACE_HOLD_DAYS}, group="grace"),
                             Outcome("refused", "They say no", 1.0, 0, {"fun": -6}, group="grace")])
    odd = Option(f"Pick up odd jobs around the neighbourhood (about ${ODD_JOBS_PAY})", [("odd_jobs", None)], base=0.25,
                 tags={"diligence": 0.6, "thrift": 0.4, "adventure": 0.2, "health": -0.2},
                 outcomes=[Outcome("paid", f"Earns ${ODD_JOBS_PAY} doing odd jobs", paid, +1, {"money": ODD_JOBS_PAY},
                                   group="odd"),
                           Outcome("no_takers", "Nobody needs a hand this week", 1.0, 0, {"fun": -4}, group="odd")],
                 extra={"odd_jobs": True})
    return [grace, odd]


def housing_trouble_fork(sim: Simulation, agent: Agent) -> Fork | None:
    """In the red after the Sunday charge, or a home falling apart that can't be fixed. Options:
    (chain + FALLBACKS)[:2] + [cut back, hope], so always four."""
    hh = sim.households[agent.household_id]
    if not _hh_window(sim) or not _ready(sim, agent, hh, "housing_trouble"):
        return None
    trouble = _trouble(sim, hh)
    if trouble is None or sim.on_shift_now(agent):
        return None
    reason, deficit, reno = trouble
    now = sim.clock.tick
    hh.cooldowns["housing_trouble"] = now + TROUBLE_COOLDOWN[reason]
    hh.trouble_seen += 1
    esc = min(2, max(0, hh.arrears - 1) if reason == "arrears" else hh.trouble_seen - 1)
    others = [a for a in housing.adults(sim, hh) if a is not agent]
    cut = Option("Cut back hard for a few weeks: no treats, no repairs", [("relax_home", "home")], base=0.3 - 0.2 * esc,
                 tags={"thrift": 0.8, "diligence": 0.3, "adventure": -0.3, "family": -0.1},
                 outcomes=[Outcome("scrapes_by", "Manages to scrape by", 0.5, +1, {"fun": 4})]
                 + ([Outcome("money_rows", "Arguments about money at home", 0.35, -1, {"family_bond": -3, "fun": -6})]
                    if others else []),
                 extra={"belt_tighten": 14 * DAY})
    hope = Option("Hope things pick up on their own" if reason == "arrears" else "Live with it for now",
                  [("relax_home", "home")], base=-0.1 - 0.2 * esc, tags={"thrift": -0.5, "adventure": 0.3, "diligence": -0.4},
                  gains={"fun": 10},
                  outcomes=[Outcome("windfall", "A forgotten refund turns up", 0.1, +1, {"money": 150}),
                            Outcome("sleepless", "Lies awake worrying", 0.6, -1, {"energy": -15})])
    opts = (_chain(sim, agent, hh, reason, deficit, esc) + _fallbacks(sim, hh, esc))[:2] + [cut, hope]
    cur = sim.homes[hh.home_id]
    if reason == "arrears":
        question = f"Money is tight: your household is ${_whole(deficit):,} in the red after this week's bills."
        if hh.arrears >= 2:
            question += " The bank wants its money." if cur.owner == hh.id else f" {LANDLORD} has sent a final warning."
        question += " What do you do?"
    else:
        question = (f"{cur.name} is falling apart and a proper renovation would cost about ${reno:,}, more than you "
                    f"can spare. What do you do?")
    return Fork(agent.id, "housing_trouble", question, opts, now, major=True)

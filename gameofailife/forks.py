"""Forks: the moments an agent's day needs a real decision.

Each fork has exactly four options. Every option carries a hidden table of
possible outcomes with probabilities; the agent's Luck shifts those odds. The
same outcome can appear under several options at different odds.
"""

from __future__ import annotations

import itertools
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from . import housing, transit, travel

if TYPE_CHECKING:
    from .agent import Agent
    from .sim import Simulation

RAIN_CHANCE = {"spring": 0.35, "summer": 0.10, "autumn": 0.40, "winter": 0.60}
OBVIOUS_MARGIN = 0.45  # default-score lead at which the Director decides on its own
MAJOR_MARGIN = 1.0  # the lead a major fork (a move, housing trouble) needs before habit settles it
LUCK_STRENGTH = 0.6  # Luck 100 multiplies good odds by 1.6 and bad odds by 0.4
KID_CURFEW = 19  # hour after which characters under 18 stay home for the night
WORK_LEAD = 45  # minutes before a shift the work fork opens (more if the walk is long)
WORK_LATE = 60  # minutes after a shift starts that the work fork still opens, for a late arrival
SHOP_MINUTES = 45  # how long the payday shopping trip takes (sim.ACTIVITIES["shopping"])
HANG_OUT_MINUTES = 90  # how long hanging out at a cafe takes (sim.ACTIVITIES["hang_out"])
COFFEE_MINUTES = 15  # how long a coffee takes (sim.ACTIVITIES["coffee"])
COFFEE_DETOUR = 15  # minutes a cafe may add to the walk to work and still be on the way (PLAN decision 55)
COFFEE_LATE = 0.15  # the cafe's "Arrives late" odds when the cup still gets them in on time (a queue at the counter)
EAT_OUT_MINUTES = 40  # how long a meal out takes (sim.ACTIVITIES["eat_out"])
GROCERY_MINUTES = 20  # how long the grocery shopping takes (sim.ACTIVITIES["buy_groceries"])
DINNER_MINUTES = 90  # how long a family dinner out takes (sim.ACTIVITIES["family_dinner"])
LATE_BASE_DROP = 20  # minutes late at which an option's common-sense value has dropped by 1 (the most it drops)
LATE_ODDS = 40  # minutes late per +1 of the option's "Arrives late" odds (at most +0.5)
TAXI_NO_HURRY = 0.4  # how much the taxi's common-sense value drops while the usual way still gets them in on time
WOKE_GAP = 120  # minutes after waking up before the sleep fork can come up again
SHIFT_SOON = 120  # ... and the minutes before a shift starts within which it never comes up
MAX_OUTING_MINUTES = 40  # the longest trip (the way the character will go, the worst bus wait) to an outing's place
TRAVEL_KINDS = ("invite", "hunger", "payday", "groceries", "lonely", "free_time")  # forks whose scores weigh the trip
TRAVEL_COST = 0.004  # common-sense value lost per minute an option adds to the day's travel, there and home again
NIGHT_TRAVEL = 2  # ... times this from NIGHT_FROM in the evening until NIGHT_UNTIL in the morning
NIGHT_FROM, NIGHT_UNTIL = 20, 7
COOPED_KINDS = ("invite", "lonely", "free_time")  # forks whose options out of the house gain after a day indoors
COOPED_UP = 0.3  # the most a day indoors adds to such an option ...
COOPED_HOURS = 12  # ... rising from 0 after this many hours since the character was last out, to COOPED_UP 12 later

_ids = itertools.count(1)


@dataclass
class Outcome:
    id: str
    label: str
    p: float
    valence: int  # +1 good, -1 bad, 0 neutral; Luck pushes good up and bad down
    effects: dict = field(default_factory=dict)
    group: str | None = None  # within a group the first hit wins; later ones are neither rolled nor logged


@dataclass
class Option:
    label: str
    steps: list[tuple[str, str | None]]  # (activity, place: "home" | "job" | place id | None = here)
    cost: float = 0.0
    vehicle: str = travel.USUAL  # "usual": each trip the usual way (travel.trip_mode); or a mode for every trip
    tags: dict[str, float] = field(default_factory=dict)  # how it fits each play-style trait
    gains: dict[str, float] = field(default_factory=dict)  # expected need gains, for default scoring
    outcomes: list[Outcome] = field(default_factory=list)
    extra: dict = field(default_factory=dict)
    base: float = 0.0  # common-sense value whatever the personality (going to work beats skipping it)
    household_pays: bool = False  # the cost comes from the pooled adults' money and savings
    charge: bool = True  # False: deciding charges nothing (a move pays its own way when it goes through)

    def public(self, index: int, minutes: int | None = None) -> dict:
        """What the agent (and God) may see: never the outcome table."""
        out = {"index": index, "label": self.label, "cost": round(self.cost, 2)}
        if minutes is not None:
            out["travel_minutes"] = minutes
        if self.household_pays:
            out["household"] = True
        return out


@dataclass
class Fork:
    agent_id: str
    kind: str
    question: str
    options: list[Option]
    tick: int
    id: str = field(default_factory=lambda: f"f{next(_ids)}")
    status: str = "open"  # open, asked, decided, withdrawn (no longer asked, nothing played)
    choice: int | None = None
    decided_by: str | None = None  # habit, default, model, timeout
    reason: str = ""
    happened: list[str] = field(default_factory=list)
    scores: list[float] = field(default_factory=list)
    major: bool = False  # a move or housing trouble: habit settles it only with a lead of MAJOR_MARGIN
    controller: str | None = None  # the controller asked, if one was
    model: str | None = None  # the model that controller declared in its hello
    profile_choice: int | None = None  # the option the profile scores highest (first on ties), set when asked


def luck_odds(p: float, valence: int, luck: float) -> float:
    shift = LUCK_STRENGTH * (luck - 50) / 50 * valence
    return max(0.0, min(1.0, p * (1 + shift)))


def urgency(level: float) -> float:
    return ((100 - level) / 100) ** 2


def default_scores(agent: Agent, fork: Fork, sim: Simulation) -> list[float]:
    """How the character's play-style profile rates each option.

    In the outing forks (TRAVEL_KINDS) an option loses TRAVEL_COST for each minute it adds to the day's travel
    (extra_travel), twice that in the evening and at night; in COOPED_KINDS one out of the house gains up to
    COOPED_UP after a day indoors (cooped_up)."""
    weigh = fork.kind in TRAVEL_KINDS
    cooped = cooped_up(sim, agent) if fork.kind in COOPED_KINDS else 0.0
    rate = TRAVEL_COST * (NIGHT_TRAVEL if sim.clock.hour >= NIGHT_FROM or sim.clock.hour < NIGHT_UNTIL else 1)
    home = sim.home_of(agent) if weigh or cooped > 0 else None
    direct = _trip(sim, agent, home)[0] if weigh else 0
    scores = []
    for opt in fork.options:
        style = sum((agent.profile.traits.get(t, 0.5) - 0.5) * 2 * v for t, v in opt.tags.items())
        need = sum(urgency(agent.needs[n]) * g / 25 for n, g in opt.gains.items() if n in agent.needs)
        afford = housing.afford_score(sim, agent, opt)
        score = opt.base + 0.6 * style + need + afford
        if weigh:
            minutes = extra_travel(sim, agent, opt, direct)
            if minutes > 0:
                score -= minutes * rate
        if cooped > 0 and _goes_out(sim, agent, opt, home):
            score += cooped
        scores.append(round(score, 3))
    return scores


def _trip(sim: Simulation, agent: Agent, place_id: str) -> tuple[int, str]:
    """(minutes, mode) of the trip from here to a place the way the character will go (travel.trip_mode), counting
    the worst bus wait; (0, "walk") when they are inside it."""
    if agent.inside == place_id:
        return 0, "walk"
    mode = travel.trip_mode(sim, agent, place_id)
    return sim.travel_minutes(agent, place_id, mode, worst=True), mode


def extra_travel(sim: Simulation, agent: Agent, opt: Option, direct: int | None = None) -> int:
    """Minutes an option adds to the character's travel today: to its first stop the way they will go, and home
    from its last (by car if they drove, else by bus when the walk is long), less the trip straight home
    (`direct`, worked out when not given). 0 for an option that stays here or goes straight home."""
    stops = [p for p in (sim._resolve_place(agent, where) for _, where in opt.steps) if p]
    if not stops:
        return 0
    home = sim.home_of(agent)
    there, mode = _trip(sim, agent, stops[0])
    last = stops[-1]
    back = 0
    if last != home:
        walk = sim.town.walk_minutes(sim.town.places[last].entry, home)
        back = travel.leg_minutes(sim, last, home, "car" if mode == "car" else
                                  "bus" if travel.BUS_MIN_WALK < walk < travel.UNREACHABLE else "walk")
    if direct is None:
        direct = _trip(sim, agent, home)[0]
    return max(0, there + back - direct)


def cooped_up(sim: Simulation, agent: Agent) -> float:
    """What a day indoors adds to an option out of the house: 0 until COOPED_HOURS since the character was last
    out (agent.out_tick, kept by the simulation; the world's first midnight before that), rising evenly to
    COOPED_UP over the next COOPED_HOURS. 0 while they are out."""
    if agent.inside != sim.home_of(agent):
        return 0.0
    hours = (sim.clock.tick - getattr(agent, "out_tick", 0)) / 60
    return COOPED_UP * min(1.0, max(0.0, (hours - COOPED_HOURS) / COOPED_HOURS))


def _goes_out(sim: Simulation, agent: Agent, opt: Option, home: str) -> bool:
    """True when one of the option's steps is somewhere other than home (a step "here" counts as where they are)."""
    for _, where in opt.steps:
        place_id = sim._resolve_place(agent, where) or agent.inside
        if place_id != home:
            return True
    return False


# --- helpers ------------------------------------------------------------------

def _late(p: float) -> Outcome:
    return Outcome("late", "Arrives late", p, -1, {"reputation": -3, "memory": "Got in late and the boss noticed."})


def _meet_new(p: float) -> Outcome:
    return Outcome("meet_new", "Meets someone new", p, +1, {"meet_new": True})


def _on_time(opt: Option, trip: int, minutes_left: int) -> Option:
    """City.md 7.7's timing-aware default: an option whose trip (travel minutes, and any stop on the way) takes
    longer than the minutes left before the shift loses up to 1 of its common-sense value, a twentieth for each
    minute it would be late, and its hidden "Arrives late" odds rise by a fortieth a minute, at most 0.5."""
    late_by = trip - minutes_left
    if late_by > 0:
        opt.base = round(opt.base - min(1.0, late_by / LATE_BASE_DROP), 3)
        for out in opt.outcomes:
            if out.id == "late":
                out.p = min(1.0, out.p + min(0.5, late_by / LATE_ODDS))
    return opt


def _curfew(sim: Simulation, agent: Agent, hours_ahead: float = 0.0) -> bool:
    """True when a child should not be heading out (now or within `hours_ahead`)."""
    hour = sim.clock.hour + hours_ahead
    return not agent.is_adult and (hour >= KID_CURFEW or sim.clock.hour < 6)


def _open_on_arrival(sim: Simulation, agent: Agent, place_id: str, stay: int = 0) -> bool:
    """True when the place is open by the time the character walks in, and still open `stay` minutes later."""
    place = sim.town.places[place_id]
    arrive = sim.clock.hour + sim.walk_minutes(agent, place_id) / 60
    return place.is_open(arrive) and place.is_open(arrive + stay / 60)


def _open_place(sim: Simulation, agent: Agent, kinds: tuple[str, ...], stay: int, meet=None, origin=None):
    """The place of `kinds` an outing goes to: travel.nearest's pick (open when the character walks in and still
    open `stay` minutes later; nearest them, or nearest both them and `meet`, or nearest `origin`), or None when
    there is none, when the trip there the way they will go (by car, bus or on foot, the worst bus wait counted)
    is over MAX_OUTING_MINUTES, or when the trip, the stay and the way on to today's shift (by car if they drove,
    else the bus when it saves time) would not leave SHIFT_MARGIN minutes before it starts. With every place of
    a kind shut, the nearest open one can be far across town; the builder then offers its fixed home fallback."""
    from .sim import SHIFT_MARGIN  # sim imports this module

    place = sim.nearest(agent, kinds, origin=origin, meet=meet, stay=stay)
    if place is None:
        return None
    trip, mode = _trip(sim, agent, place.id)
    if trip > MAX_OUTING_MINUTES:
        return None
    start = sim._shift_start_tick(agent)
    if start is not None:
        on = travel.leg_minutes(sim, place.id, agent.job.place_id, "car" if mode == "car" else "bus")
        if sim.clock.tick + trip + stay + on + SHIFT_MARGIN > start:
            return None
    return place


def _park(sim: Simulation, agent: Agent):
    """The park nearest the character (parks are always open, so it is always near)."""
    return sim.nearest(agent, ("park",)) or sim.town.places["park"]


def _best_friend(sim: Simulation, agent: Agent, exclude_household: bool = True,
                 adults_only: bool = False) -> Agent | None:
    hh = sim.household(agent).member_ids
    pool = [(r.affinity, oid) for oid, r in agent.relationships.items()
            if not (exclude_household and oid in hh) and r.affinity > 10
            and sim.agents[oid].alive and (not adults_only or sim.agents[oid].is_adult)]
    if not pool:
        return None
    return sim.agents[max(pool)[1]]


def _playmate(sim: Simulation, agent: Agent) -> Agent | None:
    """A child's best friend among the other children outside the household (affinity over 10), or None."""
    hh = sim.household(agent).member_ids
    pool = [(r.affinity, oid) for oid, r in agent.relationships.items()
            if oid not in hh and r.affinity > 10 and sim.agents[oid].alive and not sim.agents[oid].is_adult]
    if not pool:
        return None
    return sim.agents[max(pool)[1]]


def _play(sim: Simulation, agent: Agent) -> Option:
    """A child's free outing in place of a paid one they can't pay for: playing in the park nearest them, with
    their best friend among the other children (an invite) or with whoever is there."""
    park = _park(sim, agent)
    friend = _playmate(sim, agent)
    knee = Outcome("scraped_knee", "Scrapes a knee", 0.08, -1, {"health": -2, "fun": -4})
    if friend:
        rel = ("rel", friend.id)
        return Option(f"Ask {friend.name.split()[0]} to play in {park.name}", [("play", park.id)],
                      tags={"social": 0.8, "adventure": 0.4, "health": 0.3}, gains={"fun": 30, "social": 25},
                      outcomes=[Outcome("great_game", "A great game together", 0.6, +1, {rel: 5, "fun": 6}), knee],
                      extra={"invite_to": friend.id, "place": park.id})
    return Option(f"Find some kids to play with in {park.name}", [("play", park.id)],
                  tags={"social": 0.7, "adventure": 0.5, "health": 0.3}, gains={"fun": 30, "social": 20},
                  outcomes=[_meet_new(0.3), knee])


def _short_of(agent: Agent, cost: float) -> bool:
    """True for a child who can't pay `cost` themselves (an adult would have to)."""
    return not agent.is_adult and agent.money + agent.savings < cost


def _closest_family(sim: Simulation, agent: Agent) -> Agent | None:
    pool = [(r.affinity, oid) for oid, r in agent.relationships.items()
            if r.kind.value in ("family", "partner") and sim.agents[oid].alive]
    return sim.agents[max(pool)[1]] if pool else None


# --- the fork builders, in priority order -------------------------------------

def invite_fork(sim: Simulation, agent: Agent) -> Fork | None:
    invite = sim.pending_invite_for(agent)
    if not invite:
        return None
    hour = sim.clock.hour
    if hour >= 22 or hour < 6 or _curfew(sim, agent):
        return None  # sleep on it; the invite waits or expires
    if sim._must_leave_for_work(agent, invite["place"]):
        return None  # off to work first; the invite waits or expires
    if not _open_on_arrival(sim, agent, invite["place"]):
        return None  # the place is shut by then; the invite waits or expires
    host = sim.agents[invite["from"]]
    place = sim.town.places[invite["place"]]
    rel = ("rel", host.id)
    meet = "play" if place.kind == "park" else "hang_out"  # children ask each other to play in a park
    opts = [
        Option(f"Accept and meet {host.name.split()[0]} at {place.name}", [(meet, place.id)],
               tags={"social": 1.0, "adventure": 0.3}, gains={"social": 40, "fun": 20},
               outcomes=[Outcome("great_time", "Has a great time together", 0.6, +1, {rel: 6, "fun": 8}),
                         Outcome("awkward", "Conversation feels awkward", 0.12, -1, {rel: -3}),
                         _meet_new(0.06)],
               extra={"invite": invite["id"], "answer": "accept"}),
        Option("Decline politely", [("relax_home", "home")], tags={"social": -0.5, "thrift": 0.2},
               gains={"fun": 10}, outcomes=[Outcome("brushed_off", f"{host.name.split()[0]} feels brushed off", 0.35, -1, {rel: -3})],
               extra={"invite": invite["id"], "answer": "decline"}),
        Option("Suggest another day instead", [("relax_home", "home")], tags={"diligence": 0.2, "social": 0.2},
               gains={"fun": 10}, outcomes=[Outcome("understood", f"{host.name.split()[0]} is happy to wait", 0.7, +1, {rel: 1})],
               extra={"invite": invite["id"], "answer": "later"}),
        Option("Ignore the message", [("relax_home", "home")], tags={"social": -1.0},
               gains={"fun": 10}, outcomes=[Outcome("hurt", f"{host.name.split()[0]} is hurt", 0.7, -1, {rel: -6})],
               extra={"invite": invite["id"], "answer": "ignore"}),
    ]
    return Fork(agent.id, "invite", f"{host.name} invites you to {place.name}. What do you do?", opts, sim.clock.tick)


def work_fork(sim: Simulation, agent: Agent) -> Fork | None:
    job = agent.job
    if not job or agent.worked_today == sim.clock.day:
        return None
    minutes_to_start = job.start_hour * 60 - sim.clock.minute_of_day
    if not job.workdays.count(sim.clock.weekday) or not -WORK_LATE <= minutes_to_start <= 180:
        return None
    walk_minutes = sim.walk_minutes(agent, job.place_id)
    if minutes_to_start > max(WORK_LEAD, walk_minutes + 15):  # walking is the slowest way: always in time to walk
        return None
    place = sim.town.places[job.place_id]
    school = job.hourly_wage == 0
    where = "school" if school else "work"
    rain = RAIN_CHANCE[sim.clock.season] if sim.weather == "rain" else 0.0
    # 1. The usual way: on foot, or the bus when the walk is long and a bus leaving now saves time.
    bus = travel.bus_trip(sim, agent, job.place_id) if walk_minutes > travel.BUS_MIN_WALK else None
    if bus:
        usual = Option(f"Take the No. {bus[1]} bus to {where}", [("work", "job")], cost=transit.fare(agent.age),
                       vehicle="bus", base=0.6, charge=False,  # the fare is paid on boarding
                       tags={"diligence": 0.5, "thrift": 0.3, "social": 0.2},
                       outcomes=[_late(0.06), Outcome("bus_chat", "Chats with a neighbour on the bus", 0.12, +1,
                                                      {"social": 8}),
                                 Outcome("packed", "The bus is packed and stuffy", 0.15, -1, {"fun": -5})])
        usual_trip = bus[0]
    else:
        usual = Option(f"Walk to {where}", [("work", "job")], vehicle="walk", base=0.6,
                       tags={"diligence": 0.5, "health": 0.4, "thrift": 0.3},
                       outcomes=[_late(0.12), Outcome("neighbour", "Chats with a neighbour on the way", 0.10, +1, {"social": 8}),
                                 Outcome("soaked", "Gets soaked in the rain", rain * 0.8, -1, {"fun": -8})])
        usual_trip = walk_minutes
    # 2. The fast way: the car, else running (always for a child), else a taxi for a walk too long to run.
    if agent.owns_car:
        fast = Option(f"Drive to {where}", [("work", "job")], cost=2, vehicle="car", base=0.6,
                      tags={"diligence": 0.7, "thrift": -0.3},
                      outcomes=[_late(0.04), Outcome("fender", "Minor fender bender", 0.02, -1, {"money": -150, "fun": -10}),
                                Outcome("ticket", "Parking ticket", 0.05, -1, {"money": -40})])
    elif not agent.is_adult or walk_minutes <= travel.TAXI_MIN_WALK:
        fast = Option(f"Run to {where}", [("work", "job")], vehicle="run", base=0.5,
                      tags={"diligence": 0.7, "health": 0.5, "adventure": 0.2},
                      outcomes=[_late(0.03), Outcome("ankle", "Twists an ankle", 0.03, -1, {"health": -8, "fun": -6}),
                                Outcome("buzz", "Arrives buzzing with energy", 0.3, +1, {"energy": 6, "fun": 4})])
    else:  # PLAN decision 63: dear, so it is rarely the default
        fast = Option(f"Take a taxi to {where} (${travel.TAXI_FARE})", [("work", "job")], cost=travel.TAXI_FARE,
                      vehicle="taxi", base=0.3, tags={"thrift": -0.6, "diligence": 0.5, "adventure": 0.1},
                      outcomes=[_late(0.03), Outcome("chatty_driver", "A chatty taxi driver", 0.3, +1, {"social": 6}),
                                Outcome("traffic", "Sits in traffic, watching the meter", 0.1, -1, {"fun": -5})])
    fast_trip = sim.travel_minutes(agent, job.place_id, fast.vehicle)
    if fast.vehicle == "taxi" and usual_trip <= minutes_to_start:  # decision 63 again: no need to pay for speed
        fast.base = round(fast.base - TAXI_NO_HURRY, 3)
    # 3. Coffee first (PLAN decision 55, city.md 7.7): at the cafe open for the cup that adds least to the way to
    # work, when it is on the way (at most COFFEE_DETOUR minutes out of it) or a cup there is still quicker than one
    # at home; otherwise (an early shift, with the only open cafes across town) a cup at home first. Either way the
    # timing sets the defaults and the late odds (_on_time below).
    coffee_tags = {"social": 0.4, "diligence": -0.5, "thrift": -0.3}
    spill = Outcome("spill", "Spills coffee on their shirt", 0.05, -1, {"fun": -5})
    home = sim.home_of(agent)
    coffee_trip = (sim.walk_minutes(agent, home) + COFFEE_MINUTES
                   + sim.town.walk_minutes(sim.town.places[home].entry, job.place_id))
    cafe = sim.nearest(agent, ("cafe",), meet=place, stay=COFFEE_MINUTES)
    way = (sim.walk_minutes(agent, cafe.id) + (0 if cafe.id == job.place_id
                                               else sim.town.walk_minutes(cafe.entry, job.place_id))) if cafe else None
    if cafe and (way <= walk_minutes + COFFEE_DETOUR or way + COFFEE_MINUTES <= coffee_trip):
        coffee = Option(f"Grab a coffee at {cafe.name} first", [("coffee", cafe.id), ("work", "job")], cost=4,
                        vehicle="walk", base=0.35, tags=coffee_tags, gains={"energy": 10, "social": 5},
                        outcomes=[_late(COFFEE_LATE), _meet_new(0.12),
                                  Outcome("barista", "Friendly chat at the counter", 0.3, +1, {"social": 6}), spill])
        # A cup at their own workplace never holds up the shift (the simulation ends it as the shift starts).
        coffee_trip = way if cafe.id == job.place_id else way + COFFEE_MINUTES
    else:
        coffee = Option("Make a coffee at home, then go", [("coffee", "home"), ("work", "job")], vehicle="walk",
                        base=0.35, tags=coffee_tags, gains={"energy": 10}, outcomes=[_late(0.0), spill])
    # 4. Skip it.
    skip = Option(f"Call in sick and stay home" if not school else "Pretend to be sick and stay home",
                  [("rest", "home")], tags={"diligence": -1.0, "health": 0.3, "adventure": 0.2}, base=-0.4,
                  gains={"energy": 30, "fun": 25},
                  outcomes=[Outcome("annoyed", "The boss is annoyed" if not school else "The teacher calls home", 0.5, -1, {"reputation": -6}),
                            Outcome("lazy_day", "A lovely lazy day", 0.5, +1, {"fun": 12})],
                  extra={"skip_work": True})
    options = [_on_time(usual, usual_trip, minutes_to_start), _on_time(fast, fast_trip, minutes_to_start),
               _on_time(coffee, coffee_trip, minutes_to_start), skip]
    return Fork(agent.id, "work", f"It's {sim.clock.stamp()[-5:]} and {where} starts at {job.start_hour:02d}:00 at {place.name}. How do you go?",
                options, sim.clock.tick)


def sleep_fork(sim: Simulation, agent: Agent) -> Fork | None:
    """Late in the evening, after midnight for someone tired, or whenever exhausted; never within WOKE_GAP minutes
    of waking up (agent.woke_tick, kept by the simulation) nor SHIFT_SOON minutes of a shift (or once it began)."""
    hour, energy = sim.clock.hour, agent.needs["energy"]
    if not (hour >= 22 or (hour < 5 and energy < 70) or energy < 18):
        return None
    tick = sim.clock.tick
    woke = getattr(agent, "woke_tick", None)
    if woke is not None and tick - woke < WOKE_GAP:
        return None
    start = sim._shift_start_tick(agent)
    if start is not None and start - tick <= SHIFT_SOON:
        return None
    friend = _best_friend(sim, agent)
    rel = ("rel", friend.id) if friend else None
    text_outcomes = [Outcome("warm_reply", "Gets a warm reply", 0.6, +1, {"social": 8, **({rel: 2} if rel else {})}),
                     Outcome("no_reply", "No reply comes", 0.3, -1, {"social": -4})]
    opts = [
        Option("Go to sleep now", [("sleep", "home")], tags={"health": 0.8, "diligence": 0.3}, gains={"energy": 70}, base=0.2,
               outcomes=[Outcome("deep_sleep", "Sleeps deeply", 0.6, +1, {"energy": 10}),
                         Outcome("insomnia", "Lies awake for hours", 0.1, -1, {"energy": -15})]),
        Option("Stay up watching a show", [("stay_up", "home"), ("sleep", "home")],
               tags={"health": -0.6, "adventure": 0.3, "diligence": -0.3}, gains={"fun": 35},
               outcomes=[Outcome("hooked", "Loves the show", 0.45, +1, {"fun": 10}),
                         Outcome("groggy", "Wakes up groggy", 0.7, -1, {"energy": -10, "delay": 480})]),
        Option(f"Text {friend.name.split()[0]}, then sleep" if friend else "Scroll the phone, then sleep",
               [("text", "home"), ("sleep", "home")], tags={"social": 0.8, "health": -0.2}, gains={"social": 15},
               outcomes=text_outcomes if friend else [Outcome("doomscroll", "Feels worse after scrolling", 0.5, -1, {"fun": -5})]),
        Option("Read a book, then sleep", [("read", "home"), ("sleep", "home")],
               tags={"health": 0.3, "adventure": -0.2, "social": -0.3}, gains={"fun": 15, "energy": 50},
               outcomes=[Outcome("great_chapter", "Reads a gripping chapter", 0.5, +1, {"fun": 6})]),
    ]
    return Fork(agent.id, "sleep", "It's late and you're tired. What now?", opts, sim.clock.tick)


def hunger_fork(sim: Simulation, agent: Agent) -> Fork | None:
    if agent.needs["hunger"] >= 35:
        return None
    hh = sim.household(agent)
    if hh.groceries > 0:
        cook = Option("Cook at home", [("eat_home", "home")], tags={"thrift": 0.6, "family": 0.5, "health": 0.4},
                      gains={"hunger": 60},
                      outcomes=[Outcome("tasty", "Makes a really tasty meal", 0.5, +1, {"fun": 6}),
                                Outcome("burnt", "Burns the food", 0.08, -1, {"fun": -6})])
    elif agent.is_adult and agent.money >= 35 and (market := _open_place(sim, agent, ("market",), GROCERY_MINUTES)):
        cook = Option(f"Buy groceries at {market.name}, then cook", [("buy_groceries", market.id), ("eat_home", "home")],
                      cost=35, tags={"thrift": 0.4, "family": 0.6, "diligence": 0.3}, gains={"hunger": 60},
                      outcomes=[_meet_new(0.05), Outcome("tasty", "Makes a really tasty meal", 0.5, +1, {"fun": 6})])
    else:
        cook = Option("Order food to the house", [("order_food", "home")], cost=25,
                      tags={"thrift": -0.4, "family": 0.3}, gains={"hunger": 50},
                      outcomes=[Outcome("late_delivery", "The delivery is very late", 0.2, -1, {"fun": -6})])
    cafe = (_open_place(sim, agent, ("cafe",), EAT_OUT_MINUTES)
            if agent.money >= 14 and not _curfew(sim, agent, 0.7) else None)
    if cafe:
        out = Option(f"Eat at {cafe.name}", [("eat_out", cafe.id)], cost=14,
                     tags={"thrift": -0.5, "social": 0.5, "adventure": 0.3}, gains={"hunger": 55, "social": 10},
                     outcomes=[_meet_new(0.08), Outcome("friend_there", "Bumps into a friend", 0.15, +1, {"social": 8}),
                               Outcome("food_poisoning", "Gets food poisoning", 0.02, -1, {"health": -10, "fun": -10})])
    else:
        out = Option("Raid the cupboard for leftovers", [("leftovers", "home")],
                     tags={"thrift": 0.5, "health": -0.2}, gains={"hunger": 30},
                     outcomes=[Outcome("stale", "Everything is stale", 0.3, -1, {"fun": -4})])
    snack = Option("Grab a quick snack", [("snack", None)], cost=3 if agent.money >= 3 else 0,
                   tags={"thrift": 0.2, "health": -0.4, "diligence": 0.3}, gains={"hunger": 25},
                   outcomes=[Outcome("sugar_crash", "Sugar crash later", 0.3, -1, {"energy": -8, "delay": 60})])
    skip = Option("Skip the meal and push on", [("wait", None)], tags={"diligence": 0.4, "health": -0.7, "thrift": 0.4}, base=-0.2,
                  outcomes=[Outcome("headache", "Gets a headache", 0.4, -1, {"fun": -10})])
    return Fork(agent.id, "hunger", "You're getting hungry. What do you do?", [cook, out, snack, skip], sim.clock.tick)


def payday_fork(sim: Simulation, agent: Agent) -> Fork | None:
    week = sim.clock.day // 7
    hour, weekday = sim.clock.hour, sim.clock.weekday
    # Friday evening, or Saturday for anyone who works Friday evenings; retirees get their pension that day.
    evening = (weekday == 4 and hour >= 17) or (weekday == 5 and hour >= 9)
    if (not agent.is_adult or not (agent.job or agent.age >= 65) or agent.last_payday == week or not evening
            or hour >= 20 or agent.money < 80 or sim.on_shift_now(agent)):
        return None
    agent.last_payday = week
    friend = _best_friend(sim, agent, adults_only=True)
    amount = float(min(100, round(agent.money * 0.25 / 10) * 10))
    goal_name = agent.goal["name"] if agent.goal else "savings"
    save = Option(f"Put ${amount:.0f} toward {goal_name}", [("relax_home", "home")],
                  tags={"thrift": 1.0, "diligence": 0.4, "adventure": -0.3}, gains={"fun": 10},
                  outcomes=[Outcome("proud", "Feels proud of the progress", 0.6, +1, {"fun": 5})],
                  extra={"save": amount})
    # The cafe nearest both (with a friend) or nearest the character, open for the whole evening out.
    cafe = _open_place(sim, agent, ("cafe",), HANG_OUT_MINUTES, meet=friend)
    if friend and cafe:
        rel = ("rel", friend.id)
        out = Option(f"Go out for drinks with {friend.name.split()[0]} at {cafe.name}", [("hang_out", cafe.id)], cost=40,
                     tags={"social": 1.0, "thrift": -0.6, "adventure": 0.4}, gains={"social": 40, "fun": 30},
                     outcomes=[_meet_new(0.18), Outcome("friendship", f"Friendship with {friend.name.split()[0]} grows", 0.55, +1, {rel: 6}),
                               Outcome("hangover", "Wakes up with a hangover", 0.2, -1, {"energy": -12, "delay": 720})],
                     extra={"invite_to": friend.id, "place": cafe.id})
    elif cafe:
        out = Option(f"Go out alone to {cafe.name}", [("hang_out", cafe.id)], cost=25,
                     tags={"social": 0.6, "thrift": -0.5}, gains={"social": 25, "fun": 20}, outcomes=[_meet_new(0.2)])
    else:  # every cafe would shut before the evening is over: a drink at home
        out = Option("Open a nice bottle at home", [("relax_home", "home")], cost=15,
                     tags={"social": 0.2, "thrift": -0.3, "adventure": -0.2}, gains={"fun": 25},
                     outcomes=[Outcome("cosy_drink", "A relaxed evening in", 0.6, +1, {"fun": 6}),
                               Outcome("hangover", "Wakes up with a hangover", 0.15, -1, {"energy": -12, "delay": 720})])
    bought = [Outcome("love_it", "Loves the purchase", 0.6, +1, {"fun": 15}),
              Outcome("regret", "Regrets the spending", 0.3, -1, {"fun": -8})]
    shop = _open_place(sim, agent, ("shop", "market"), SHOP_MINUTES)  # open until the shopping is done
    if shop:
        buy = Option(f"Buy something nice at {shop.name}", [("shopping", shop.id), ("relax_home", "home")], cost=60,
                     tags={"thrift": -1.0, "adventure": 0.5}, gains={"fun": 35}, outcomes=bought)
    else:  # every shop would shut before the shopping is done: order it from home instead
        buy = Option("Order something nice online", [("relax_home", "home")], cost=60,
                     tags={"thrift": -1.0, "adventure": 0.3}, gains={"fun": 30}, outcomes=bought)
    family = any(m != agent.id for m in sim.household(agent).member_ids)
    # The family goes to the cafe nearest home (extra["place"], so everyone heads to the same one).
    dinner = _open_place(sim, agent, ("cafe",), DINNER_MINUTES, origin=sim.home_of(agent)) if family else None
    if dinner:
        treat = Option(f"Treat the family to dinner at {dinner.name}", [("family_dinner", dinner.id)], cost=50,
                       tags={"family": 1.0, "thrift": -0.4, "social": 0.3}, gains={"hunger": 40, "social": 30},
                       outcomes=[Outcome("bonding", "A warm family evening", 0.7, +1, {"family_bond": 4, "fun": 8}),
                                 Outcome("argument", "An argument at the table", 0.1, -1, {"family_bond": -3})],
                       extra={"family": True, "place": dinner.id})
    elif family:  # every cafe would shut before dinner is over: a takeaway for everyone
        treat = Option("Order a takeaway feast for the family", [("order_food", "home"), ("relax_home", "home")],
                       cost=40, tags={"family": 0.8, "thrift": -0.3}, gains={"hunger": 40, "fun": 20},
                       outcomes=[Outcome("feast", "Everyone loves the feast", 0.6, +1, {"fun": 6}),
                                 Outcome("late_delivery", "The delivery is very late", 0.2, -1, {"fun": -6})])
    else:  # nobody at home to treat
        treat = Option("Treat yourself to a takeaway night in", [("order_food", "home"), ("relax_home", "home")], cost=25,
                       tags={"thrift": -0.4, "social": -0.4, "adventure": -0.2}, gains={"hunger": 40, "fun": 25},
                       outcomes=[Outcome("cosy_night", "A cosy night in", 0.6, +1, {"fun": 6}),
                                 Outcome("late_delivery", "The delivery is very late", 0.2, -1, {"fun": -6})])
    return Fork(agent.id, "payday", f"It's payday and you have ${agent.money:.0f}. What do you do with it?",
                [save, out, buy, treat], sim.clock.tick)


def groceries_fork(sim: Simulation, agent: Agent) -> Fork | None:
    hh = sim.household(agent)
    if hh.groceries > 1 or not agent.is_adult or sim.on_shift_now(agent):
        return None
    market = _open_place(sim, agent, ("market",), GROCERY_MINUTES) if agent.money >= 35 else None
    if market is None:
        return None
    other = next((sim.agents[m] for m in hh.member_ids if m != agent.id and sim.agents[m].is_adult), None)
    opts = [
        Option(f"Buy groceries at {market.name} now", [("buy_groceries", market.id), ("relax_home", "home")], cost=35, base=0.4,
               tags={"family": 0.6, "diligence": 0.5, "thrift": 0.3}, gains={"hunger": 10},
               outcomes=[_meet_new(0.05), Outcome("sale", "Finds a great sale", 0.15, +1, {"money": 10})]),
        Option("Order food for tonight", [("order_food", "home")], cost=25, tags={"thrift": -0.5, "family": 0.2},
               gains={"hunger": 20}, outcomes=[Outcome("late_delivery", "The delivery is very late", 0.2, -1, {"fun": -6})]),
        Option(f"Ask {other.name.split()[0]} to do the shopping", [("relax_home", "home")],
               tags={"family": -0.3, "thrift": 0.4}, extra={"ask_shop": other.id},
               outcomes=[Outcome("annoyed_partner", "They're annoyed at being asked", 0.4, -1, {("rel", other.id): -3})])
        if other else  # nobody to send: eat what there is
        Option("Make do with what's in the cupboard", [("leftovers", "home")], tags={"thrift": 0.6, "health": -0.2},
               gains={"hunger": 30}, outcomes=[Outcome("stale", "Everything is stale", 0.3, -1, {"fun": -4})]),
        Option("Leave it for tomorrow", [("relax_home", "home")], tags={"diligence": -0.6, "thrift": 0.3}, base=-0.2,
               outcomes=[Outcome("empty_fridge", "Opens an empty fridge later", 0.6, -1, {"fun": -5})]),
    ]
    return Fork(agent.id, "groceries", "The fridge is almost empty. What do you do?", opts, sim.clock.tick)


def lonely_fork(sim: Simulation, agent: Agent) -> Fork | None:
    hour = sim.clock.hour
    if agent.needs["social"] >= 35 or not (9 <= hour < 21) or sim.on_shift_now(agent) or _curfew(sim, agent, 1):
        return None
    friend = _best_friend(sim, agent)
    family = _closest_family(sim, agent)
    opts = []
    # The cafe nearest both (with a friend to invite) or nearest the character, open for the whole hang-out.
    short = _short_of(agent, 6)
    cafe = _open_place(sim, agent, ("cafe",), HANG_OUT_MINUTES, meet=friend) if not short else None
    if short:  # a child without the $6: off to play instead
        opts.append(_play(sim, agent))
    elif friend and cafe:
        opts.append(Option(f"Invite {friend.name.split()[0]} to {cafe.name}", [("hang_out", cafe.id)], cost=6,
                           tags={"social": 1.0, "adventure": 0.3}, gains={"social": 45, "fun": 20},
                           outcomes=[_meet_new(0.05)], extra={"invite_to": friend.id, "place": cafe.id}))
    elif cafe:
        opts.append(Option(f"Go people-watching at {cafe.name}", [("hang_out", cafe.id)], cost=6,
                           tags={"social": 0.6}, gains={"social": 25}, outcomes=[_meet_new(0.15)]))
    else:  # every cafe would shut before a hang-out there is over
        opts.append(Option("Message a few people from home", [("text", "home")], tags={"social": 0.6, "thrift": 0.2},
                           gains={"social": 15},
                           outcomes=[Outcome("warm_replies", "Gets some warm replies", 0.6, +1, {"social": 6}),
                                     Outcome("no_reply", "No reply comes", 0.3, -1, {"social": -4})]))
    who = family or friend
    if who:
        opts.append(Option(f"Call {who.name.split()[0]}", [("phone_call", None)], tags={"family": 0.8, "social": 0.4},
                           gains={"social": 30},
                           outcomes=[Outcome("lovely_talk", "A lovely long talk", 0.7, +1, {("rel", who.id): 3}),
                                     Outcome("argue", "The call turns into an argument", 0.08, -1, {("rel", who.id): -5, "fun": -6})],
                           extra={"call": who.id}))
    else:
        opts.append(Option("Write in a diary", [("read", "home")], tags={"social": -0.2}, gains={"fun": 10},
                           outcomes=[Outcome("clarity", "Writing brings some clarity", 0.5, +1, {"fun": 5})]))
    park = _park(sim, agent)
    opts.append(Option(f"Walk in {park.name}", [("walk_park", park.id)], tags={"health": 0.6, "adventure": 0.4},
                       gains={"fun": 30, "social": 5},
                       outcomes=[_meet_new(0.12), Outcome("rained_out", "Caught in the rain", RAIN_CHANCE[sim.clock.season] * (sim.weather == "rain"), -1, {"fun": -8})]))
    opts.append(Option("Stay home alone", [("relax_home", "home")], tags={"social": -1.0, "thrift": 0.3},
                       gains={"fun": 20},
                       outcomes=[Outcome("peaceful", "A peaceful evening", 0.5, +1, {"fun": 5}),
                                 Outcome("lonely", "Feels lonely", 0.4, -1, {"social": -5})]))
    return Fork(agent.id, "lonely", "You haven't talked to anyone in a while. What do you do?", opts, sim.clock.tick)


def free_time_fork(sim: Simulation, agent: Agent) -> Fork | None:
    """When bored (fun under 40) or, for a child, cooped up at home (cooped_up), from 08:00 to 21:00 off shift."""
    hour = sim.clock.hour
    if not (8 <= hour < 21) or sim.on_shift_now(agent) or _curfew(sim, agent, 1):
        return None
    if agent.needs["fun"] >= 40 and (agent.is_adult or cooped_up(sim, agent) <= 0):
        return None
    park = _park(sim, agent)
    short = _short_of(agent, 6)
    cafe = _open_place(sim, agent, ("cafe",), HANG_OUT_MINUTES) if not short else None  # open for all of it
    if short:  # a child without the $6: off to play instead
        out = _play(sim, agent)
    elif cafe:
        out = Option(f"Hang out at {cafe.name}", [("hang_out", cafe.id)], cost=6, tags={"social": 0.8, "thrift": -0.3},
                     gains={"fun": 25, "social": 30}, outcomes=[_meet_new(0.12)])
    else:  # every cafe would shut before the hang-out is over
        out = Option("Play a board game at home", [("board_game", "home")], tags={"family": 0.8}, gains={"fun": 25, "social": 10},
                     outcomes=[Outcome("bonding", "Laughs with the family", 0.5, +1, {"family_bond": 2})])
    opts = [
        Option(f"Walk in {park.name}", [("walk_park", park.id)], tags={"health": 0.7, "adventure": 0.3},
               gains={"fun": 35}, outcomes=[_meet_new(0.1)]),
        Option("Relax at home", [("relax_home", "home")], tags={"thrift": 0.4, "family": 0.4, "adventure": -0.4},
               gains={"fun": 30, "energy": 5},
               outcomes=[Outcome("unwind", "Properly unwinds", 0.5, +1, {"fun": 6}),
                         Outcome("restless", "Gets restless and bored", 0.3, -1, {"fun": -6})]),
        out,
        Option("Work on a side project", [("side_project", "home")], tags={"diligence": 0.6, "adventure": 0.5, "social": -0.3},
               gains={"fun": 25},
               outcomes=[Outcome("breakthrough", "Makes a breakthrough", 0.15, +1,
                                 {"fun": 15, "money": 50} if agent.is_adult else {"fun": 20}),
                         Outcome("stuck", "Gets stuck and frustrated", 0.3, -1, {"fun": -6})]),
    ]
    return Fork(agent.id, "free_time", "You have some free time and feel a bit bored. What do you do?", opts, sim.clock.tick)


# The fork builders in priority order, by name: "housing_forks." names live in housing_forks.py, which imports
# this module, so build_fork looks them up when it runs rather than at import.
BUILDERS = ["invite_fork", "work_fork", "hunger_fork", "sleep_fork", "housing_forks.repair_fork", "payday_fork",
            "groceries_fork", "housing_forks.housing_trouble_fork", "housing_forks.house_hunt_fork",
            "housing_forks.upkeep_fork", "lonely_fork", "free_time_fork"]


# Minutes before the same kind of fork can come up again for a character.
COOLDOWN = {"groceries": 360, "lonely": 150, "free_time": 90, "hunger": 45, "sleep": 20}


def builders() -> list:
    """BUILDERS resolved to the builder functions, in order, at call time (so a patched builder is used too)."""
    from . import housing_forks  # it imports this module, so not at the top

    here = globals()
    return [getattr(housing_forks, name[len("housing_forks."):]) if name.startswith("housing_forks.") else here[name]
            for name in BUILDERS]


def build_fork(sim: Simulation, agent: Agent) -> Fork | None:
    from .housing_forks import MAJOR_KINDS

    for name, builder in zip(BUILDERS, builders()):
        if agent.cooldowns.get(name.rpartition(".")[2].removesuffix("_fork"), 0) > sim.clock.tick:
            continue
        fork = builder(sim, agent)
        if fork:
            assert len(fork.options) == 4, f"{fork.kind} fork must offer exactly four options"
            fork.major = fork.major or fork.kind in MAJOR_KINDS
            return fork
    return None

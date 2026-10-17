"""Forks: the moments an agent's day needs a real decision.

Each fork has exactly four options. Every option carries a hidden table of
possible outcomes with probabilities; the agent's Luck shifts those odds. The
same outcome can appear under several options at different odds.
"""

from __future__ import annotations

import itertools
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .agent import Agent
    from .sim import Simulation

RAIN_CHANCE = {"spring": 0.35, "summer": 0.10, "autumn": 0.40, "winter": 0.60}
OBVIOUS_MARGIN = 0.45  # default-score lead at which the Director decides on its own
LUCK_STRENGTH = 0.6  # Luck 100 multiplies good odds by 1.6 and bad odds by 0.4

_ids = itertools.count(1)


@dataclass
class Outcome:
    id: str
    label: str
    p: float
    valence: int  # +1 good, -1 bad, 0 neutral; Luck pushes good up and bad down
    effects: dict = field(default_factory=dict)


@dataclass
class Option:
    label: str
    steps: list[tuple[str, str | None]]  # (activity, place: "home" | "job" | place id | None = here)
    cost: float = 0.0
    vehicle: str = "walk"
    tags: dict[str, float] = field(default_factory=dict)  # how it fits each play-style trait
    gains: dict[str, float] = field(default_factory=dict)  # expected need gains, for default scoring
    outcomes: list[Outcome] = field(default_factory=list)
    extra: dict = field(default_factory=dict)
    base: float = 0.0  # common-sense value whatever the personality (going to work beats skipping it)

    def public(self, index: int, minutes: int | None = None) -> dict:
        """What the agent (and God) may see: never the outcome table."""
        out = {"index": index, "label": self.label, "cost": round(self.cost, 2)}
        if minutes is not None:
            out["travel_minutes"] = minutes
        return out


@dataclass
class Fork:
    agent_id: str
    kind: str
    question: str
    options: list[Option]
    tick: int
    id: str = field(default_factory=lambda: f"f{next(_ids)}")
    status: str = "open"  # open, asked, decided
    choice: int | None = None
    decided_by: str | None = None  # habit, default, model, timeout
    reason: str = ""
    happened: list[str] = field(default_factory=list)
    scores: list[float] = field(default_factory=list)


def luck_odds(p: float, valence: int, luck: float) -> float:
    shift = LUCK_STRENGTH * (luck - 50) / 50 * valence
    return max(0.0, min(1.0, p * (1 + shift)))


def urgency(level: float) -> float:
    return ((100 - level) / 100) ** 2


def default_scores(agent: Agent, fork: Fork) -> list[float]:
    """How the character's play-style profile rates each option."""
    scores = []
    for opt in fork.options:
        style = sum((agent.profile.traits.get(t, 0.5) - 0.5) * 2 * v for t, v in opt.tags.items())
        need = sum(urgency(agent.needs[n]) * g / 25 for n, g in opt.gains.items() if n in agent.needs)
        afford = -2.0 if opt.cost > agent.money else -opt.cost / max(agent.money, 50) * agent.profile.traits["thrift"]
        scores.append(round(opt.base + 0.6 * style + need + afford, 3))
    return scores


# --- helpers ------------------------------------------------------------------

def _late(p: float) -> Outcome:
    return Outcome("late", "Arrives late", p, -1, {"reputation": -3, "memory": "Got in late and the boss noticed."})


def _meet_new(p: float) -> Outcome:
    return Outcome("meet_new", "Meets someone new", p, +1, {"meet_new": True})


def _best_friend(sim: Simulation, agent: Agent, exclude_household: bool = True) -> Agent | None:
    hh = sim.household(agent).member_ids
    pool = [(r.affinity, oid) for oid, r in agent.relationships.items()
            if not (exclude_household and oid in hh) and r.affinity > 10]
    if not pool:
        return None
    return sim.agents[max(pool)[1]]


def _closest_family(sim: Simulation, agent: Agent) -> Agent | None:
    pool = [(r.affinity, oid) for oid, r in agent.relationships.items() if r.kind.value in ("family", "partner")]
    return sim.agents[max(pool)[1]] if pool else None


# --- the fork builders, in priority order -------------------------------------

def invite_fork(sim: Simulation, agent: Agent) -> Fork | None:
    invite = sim.pending_invite_for(agent)
    if not invite:
        return None
    host = sim.agents[invite["from"]]
    place = sim.town.places[invite["place"]]
    rel = ("rel", host.id)
    opts = [
        Option(f"Accept and meet {host.name.split()[0]} at {place.name}", [("hang_out", place.id)],
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
    if not (job.workdays.count(sim.clock.weekday) and -60 <= minutes_to_start <= 45):
        return None
    place = sim.town.places[job.place_id]
    school = job.hourly_wage == 0
    where = "school" if school else "work"
    rain = RAIN_CHANCE[sim.clock.season] if sim.weather == "rain" else 0.0
    walk = Option(f"Walk to {where}", [("work", "job")], vehicle="walk", base=0.6,
                  tags={"diligence": 0.5, "health": 0.4, "thrift": 0.3},
                  outcomes=[_late(0.12), Outcome("neighbour", "Chats with a neighbour on the way", 0.10, +1, {"social": 8}),
                            Outcome("soaked", "Gets soaked in the rain", rain * 0.8, -1, {"fun": -8})])
    if agent.owns_car:
        fast = Option(f"Drive to {where}", [("work", "job")], cost=2, vehicle="car", base=0.6,
                      tags={"diligence": 0.7, "thrift": -0.3},
                      outcomes=[_late(0.04), Outcome("fender", "Minor fender bender", 0.02, -1, {"money": -150, "fun": -10}),
                                Outcome("ticket", "Parking ticket", 0.05, -1, {"money": -40})])
    else:
        fast = Option(f"Run to {where}", [("work", "job")], vehicle="run", base=0.5,
                      tags={"diligence": 0.7, "health": 0.5, "adventure": 0.2},
                      outcomes=[_late(0.03), Outcome("ankle", "Twists an ankle", 0.03, -1, {"health": -8, "fun": -6}),
                                Outcome("buzz", "Arrives buzzing with energy", 0.3, +1, {"energy": 6, "fun": 4})])
    coffee = Option("Grab a coffee at Corner Cafe first", [("coffee", "cafe"), ("work", "job")], cost=4, base=0.35,
                    tags={"social": 0.4, "diligence": -0.5, "thrift": -0.3},
                    gains={"energy": 10, "social": 5},
                    outcomes=[_late(0.7), _meet_new(0.12), Outcome("barista", "Friendly chat at the counter", 0.3, +1, {"social": 6}),
                              Outcome("spill", "Spills coffee on their shirt", 0.05, -1, {"fun": -5})])
    skip = Option(f"Call in sick and stay home" if not school else "Pretend to be sick and stay home",
                  [("rest", "home")], tags={"diligence": -1.0, "health": 0.3, "adventure": 0.2}, base=-0.4,
                  gains={"energy": 30, "fun": 25},
                  outcomes=[Outcome("annoyed", "The boss is annoyed" if not school else "The teacher calls home", 0.5, -1, {"reputation": -6}),
                            Outcome("lazy_day", "A lovely lazy day", 0.5, +1, {"fun": 12})],
                  extra={"skip_work": True})
    return Fork(agent.id, "work", f"It's {sim.clock.stamp()[-5:]} and {where} starts at {job.start_hour:02d}:00 at {place.name}. How do you go?",
                [walk, fast, coffee, skip], sim.clock.tick)


def sleep_fork(sim: Simulation, agent: Agent) -> Fork | None:
    hour = sim.clock.hour
    if not (hour >= 22 or hour < 5 or agent.needs["energy"] < 18):
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
    cafe_open = sim.town.places["cafe"].is_open(sim.clock.hour)
    market_open = sim.town.places["market"].is_open(sim.clock.hour)
    if hh.groceries > 0:
        cook = Option("Cook at home", [("eat_home", "home")], tags={"thrift": 0.6, "family": 0.5, "health": 0.4},
                      gains={"hunger": 60},
                      outcomes=[Outcome("tasty", "Makes a really tasty meal", 0.5, +1, {"fun": 6}),
                                Outcome("burnt", "Burns the food", 0.08, -1, {"fun": -6})])
    elif market_open and agent.is_adult and agent.money >= 35:
        cook = Option("Buy groceries, then cook", [("buy_groceries", "market"), ("eat_home", "home")], cost=35,
                      tags={"thrift": 0.4, "family": 0.6, "diligence": 0.3}, gains={"hunger": 60},
                      outcomes=[_meet_new(0.05), Outcome("tasty", "Makes a really tasty meal", 0.5, +1, {"fun": 6})])
    else:
        cook = Option("Order food to the house", [("order_food", "home")], cost=25,
                      tags={"thrift": -0.4, "family": 0.3}, gains={"hunger": 50},
                      outcomes=[Outcome("late_delivery", "The delivery is very late", 0.2, -1, {"fun": -6})])
    if cafe_open and agent.money >= 14:
        out = Option("Eat at Corner Cafe", [("eat_out", "cafe")], cost=14,
                     tags={"thrift": -0.5, "social": 0.5, "adventure": 0.3}, gains={"hunger": 55, "social": 10},
                     outcomes=[_meet_new(0.08), Outcome("friend_there", "Bumps into a friend", 0.15, +1, {"social": 8}),
                               Outcome("food_poisoning", "Gets food poisoning", 0.02, -1, {"health": -10, "fun": -10})])
    else:
        out = Option("Raid the cupboard for leftovers", [("snack", "home")],
                     tags={"thrift": 0.5, "health": -0.2}, gains={"hunger": 25},
                     outcomes=[Outcome("stale", "Everything is stale", 0.3, -1, {"fun": -4})])
    snack = Option("Grab a quick snack", [("snack", None)], cost=3 if agent.money >= 3 else 0,
                   tags={"thrift": 0.2, "health": -0.4, "diligence": 0.3}, gains={"hunger": 25},
                   outcomes=[Outcome("sugar_crash", "Sugar crash later", 0.3, -1, {"energy": -8, "delay": 60})])
    skip = Option("Skip the meal and push on", [("wait", None)], tags={"diligence": 0.4, "health": -0.7, "thrift": 0.4}, base=-0.2,
                  outcomes=[Outcome("headache", "Gets a headache", 0.4, -1, {"fun": -10})])
    return Fork(agent.id, "hunger", "You're getting hungry. What do you do?", [cook, out, snack, skip], sim.clock.tick)


def payday_fork(sim: Simulation, agent: Agent) -> Fork | None:
    week = sim.clock.day // 7
    if (not agent.is_adult or not agent.job or agent.last_payday == week or sim.clock.weekday != 4
            or sim.clock.hour < 17 or sim.clock.hour >= 21 or agent.money < 80):
        return None
    agent.last_payday = week
    friend = _best_friend(sim, agent)
    amount = float(min(100, round(agent.money * 0.25 / 10) * 10))
    goal_name = agent.goal["name"] if agent.goal else "savings"
    save = Option(f"Put ${amount:.0f} toward {goal_name}", [("relax_home", "home")],
                  tags={"thrift": 1.0, "diligence": 0.4, "adventure": -0.3}, gains={"fun": 10},
                  outcomes=[Outcome("proud", "Feels proud of the progress", 0.6, +1, {"fun": 5})],
                  extra={"save": amount})
    if friend:
        rel = ("rel", friend.id)
        out = Option(f"Go out for drinks with {friend.name.split()[0]}", [("hang_out", "cafe")], cost=40,
                     tags={"social": 1.0, "thrift": -0.6, "adventure": 0.4}, gains={"social": 40, "fun": 30},
                     outcomes=[_meet_new(0.18), Outcome("friendship", f"Friendship with {friend.name.split()[0]} grows", 0.55, +1, {rel: 6}),
                               Outcome("hangover", "Wakes up with a hangover", 0.2, -1, {"energy": -12, "delay": 720})],
                     extra={"invite_to": friend.id, "place": "cafe"})
    else:
        out = Option("Go out alone to Corner Cafe", [("hang_out", "cafe")], cost=25,
                     tags={"social": 0.6, "thrift": -0.5}, gains={"social": 25, "fun": 20}, outcomes=[_meet_new(0.2)])
    buy = Option("Buy something nice for yourself", [("shopping", "market"), ("relax_home", "home")], cost=60,
                 tags={"thrift": -1.0, "adventure": 0.5}, gains={"fun": 35},
                 outcomes=[Outcome("love_it", "Loves the purchase", 0.6, +1, {"fun": 15}),
                           Outcome("regret", "Regrets the spending", 0.3, -1, {"fun": -8})])
    family = Option("Treat the family to dinner at Corner Cafe", [("family_dinner", "cafe")], cost=50,
                    tags={"family": 1.0, "thrift": -0.4, "social": 0.3}, gains={"hunger": 40, "social": 30},
                    outcomes=[Outcome("bonding", "A warm family evening", 0.7, +1, {"family_bond": 4, "fun": 8}),
                              Outcome("argument", "An argument at the table", 0.1, -1, {"family_bond": -3})],
                    extra={"family": True})
    return Fork(agent.id, "payday", f"It's payday and you have ${agent.money:.0f}. What do you do with it?",
                [save, out, buy, family], sim.clock.tick)


def groceries_fork(sim: Simulation, agent: Agent) -> Fork | None:
    hh = sim.household(agent)
    market = sim.town.places["market"]
    if hh.groceries > 1 or not agent.is_adult or not market.is_open(sim.clock.hour + 0.5) or sim.on_shift_now(agent):
        return None
    if agent.money < 35:
        return None
    other = next((sim.agents[m] for m in hh.member_ids if m != agent.id and sim.agents[m].is_adult), None)
    opts = [
        Option("Buy groceries now", [("buy_groceries", "market"), ("relax_home", "home")], cost=35, base=0.4,
               tags={"family": 0.6, "diligence": 0.5, "thrift": 0.3}, gains={"hunger": 10},
               outcomes=[_meet_new(0.05), Outcome("sale", "Finds a great sale", 0.15, +1, {"money": 10})]),
        Option("Order food for tonight", [("order_food", "home")], cost=25, tags={"thrift": -0.5, "family": 0.2},
               gains={"hunger": 20}, outcomes=[Outcome("late_delivery", "The delivery is very late", 0.2, -1, {"fun": -6})]),
        Option(f"Ask {other.name.split()[0]} to do the shopping" if other else "Ask a neighbour for help",
               [("relax_home", "home")], tags={"family": -0.3, "thrift": 0.4},
               extra={"ask_shop": other.id} if other else {},
               outcomes=[Outcome("annoyed_partner", "They're annoyed at being asked", 0.4, -1,
                                 {("rel", other.id): -3} if other else {"social": -3})]),
        Option("Leave it for tomorrow", [("relax_home", "home")], tags={"diligence": -0.6, "thrift": 0.3}, base=-0.2,
               outcomes=[Outcome("empty_fridge", "Opens an empty fridge later", 0.6, -1, {"fun": -5})]),
    ]
    return Fork(agent.id, "groceries", "The fridge is almost empty. What do you do?", opts, sim.clock.tick)


def lonely_fork(sim: Simulation, agent: Agent) -> Fork | None:
    hour = sim.clock.hour
    if agent.needs["social"] >= 35 or not (9 <= hour < 21) or sim.on_shift_now(agent):
        return None
    friend = _best_friend(sim, agent)
    family = _closest_family(sim, agent)
    opts = []
    if friend and sim.town.places["cafe"].is_open(hour + 1):
        opts.append(Option(f"Invite {friend.name.split()[0]} to Corner Cafe", [("hang_out", "cafe")], cost=6,
                           tags={"social": 1.0, "adventure": 0.3}, gains={"social": 45, "fun": 20},
                           outcomes=[_meet_new(0.05)], extra={"invite_to": friend.id, "place": "cafe"}))
    else:
        opts.append(Option("Go people-watching at Corner Cafe", [("hang_out", "cafe")], cost=6,
                           tags={"social": 0.6}, gains={"social": 25}, outcomes=[_meet_new(0.15)]))
    who = family or friend
    if who:
        opts.append(Option(f"Call {who.name.split()[0]}", [("phone_call", None)], tags={"family": 0.8, "social": 0.4},
                           gains={"social": 30},
                           outcomes=[Outcome("lovely_talk", "A lovely long talk", 0.7, +1, {("rel", who.id): 3}),
                                     Outcome("argue", "The call turns into an argument", 0.08, -1, {("rel", who.id): -5, "fun": -6})],
                           extra={"call": who.id}))
    else:
        opts.append(Option("Write in a diary", [("read", "home")], tags={"social": -0.2}, gains={"fun": 10}))
    opts.append(Option("Walk in Riverside Park", [("walk_park", "park")], tags={"health": 0.6, "adventure": 0.4},
                       gains={"fun": 30, "social": 5},
                       outcomes=[_meet_new(0.12), Outcome("rained_out", "Caught in the rain", RAIN_CHANCE[sim.clock.season] * (sim.weather == "rain"), -1, {"fun": -8})]))
    opts.append(Option("Stay home alone", [("relax_home", "home")], tags={"social": -1.0, "thrift": 0.3},
                       gains={"fun": 20},
                       outcomes=[Outcome("peaceful", "A peaceful evening", 0.5, +1, {"fun": 5}),
                                 Outcome("lonely", "Feels lonely", 0.4, -1, {"social": -5})]))
    return Fork(agent.id, "lonely", "You haven't talked to anyone in a while. What do you do?", opts, sim.clock.tick)


def free_time_fork(sim: Simulation, agent: Agent) -> Fork | None:
    hour = sim.clock.hour
    if agent.needs["fun"] >= 40 or not (8 <= hour < 21) or sim.on_shift_now(agent):
        return None
    opts = [
        Option("Walk in Riverside Park", [("walk_park", "park")], tags={"health": 0.7, "adventure": 0.3},
               gains={"fun": 35}, outcomes=[_meet_new(0.1)]),
        Option("Relax at home", [("relax_home", "home")], tags={"thrift": 0.4, "family": 0.4, "adventure": -0.4},
               gains={"fun": 30, "energy": 5}),
        Option("Hang out at Corner Cafe", [("hang_out", "cafe")], cost=6, tags={"social": 0.8, "thrift": -0.3},
               gains={"fun": 25, "social": 30}, outcomes=[_meet_new(0.12)]),
        Option("Work on a side project", [("side_project", "home")], tags={"diligence": 0.6, "adventure": 0.5, "social": -0.3},
               gains={"fun": 25},
               outcomes=[Outcome("breakthrough", "Makes a breakthrough", 0.15, +1, {"fun": 15, "money": 50}),
                         Outcome("stuck", "Gets stuck and frustrated", 0.3, -1, {"fun": -6})]),
    ]
    if not sim.town.places["cafe"].is_open(hour + 1):
        opts[2] = Option("Play a board game at home", [("relax_home", "home")], tags={"family": 0.8}, gains={"fun": 25, "social": 10},
                         outcomes=[Outcome("bonding", "Laughs with the family", 0.5, +1, {"family_bond": 2})])
    return Fork(agent.id, "free_time", "You have some free time and feel a bit bored. What do you do?", opts, sim.clock.tick)


BUILDERS = [invite_fork, work_fork, sleep_fork, hunger_fork, payday_fork, groceries_fork, lonely_fork, free_time_fork]


# Minutes before the same kind of fork can come up again for a character.
COOLDOWN = {"groceries": 360, "lonely": 150, "free_time": 90, "hunger": 45, "sleep": 20}


def build_fork(sim: Simulation, agent: Agent) -> Fork | None:
    for builder in BUILDERS:
        if agent.cooldowns.get(builder.__name__.removesuffix("_fork"), 0) > sim.clock.tick:
            continue
        fork = builder(sim, agent)
        if fork:
            assert len(fork.options) == 4, f"{fork.kind} fork must offer exactly four options"
            return fork
    return None

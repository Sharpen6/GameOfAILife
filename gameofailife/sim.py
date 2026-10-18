"""The simulation: the world clockwork, the agents' days, and the Decision Director.

The simulation is synchronous and knows nothing about the network. The server
calls `step()` on a timer, hands controller answers to `answer()`, and drains
`outbox` (messages for controllers) and `events` (for God's view) after each step.

The city's other parts plug in through hook functions this module calls at fixed points (PLAN 3.10):
`housing` (homes, rent, upkeep), `travel` and `transit` (getting around), `chronicle` (event tags) and
`stats` (counters and samples). Their packages change those functions, never the call sites.

v3 (PLAN 2.1-2.4): `world="region"` builds the region (`region.build_region`) with its trains (`rail`), and
`folk=N` townsfolk (`people.make_folk`, `sim.folk`); `life`, `career`, `money` and `social` run the life rules for
both tiers through the hook lines of life.md 7, each a one-line call into its module. `world="millbrook"`, folk 0
(the default) is v2's city.
"""

from __future__ import annotations

import json
import math
import random
import time
from dataclasses import dataclass, field
from typing import Callable

from . import career, chronicle, housing, life, money, people, social, stats, transit, travel
from . import social_forks  # noqa: F401  # registers its fork builders and handlers in people
from .agent import NEED_DECAY, NEEDS, Agent, Household, RelationKind
from .clock import DAYS_PER_SEASON, MINUTES_PER_DAY, SEASONS, TICKS_PER_REAL_SECOND, Clock
from .forks import (COOLDOWN, MAJOR_MARGIN, OBVIOUS_MARGIN, RAIN_CHANCE, WORK_LATE, WORK_LEAD, Fork, build_fork,
                    default_scores, luck_odds, names, personal, retime_late, today_line, work_lead)
from .rng import r2
from .town import PARK, TownMap, build_map
from .transit import BUS_FARE, FLIGHTS
from .travel import ROAD_MODES, SPEEDS, TAXI_FARE, USUAL

ANSWER_SECONDS = 5.0  # a controller's answer applies if it arrives within this
LEARN_SECONDS = 10.0  # a later answer is still saved and teaches the profile
INVITE_MINUTES = 120  # an unanswered invite expires after this
# SPEEDS (tiles a minute by vehicle: walk 1, run 2, car/taxi/ambulance 4, and bus 1 for the rider's own walking
# legs), TAXI_FARE (12), BUS_FARE (2) and WORK_LEAD (45) come from travel, transit and forks: one copy of each.
PENSION = 400.0  # paid every Friday morning to retirees (65+ with no job)
BILLS_PER_ADULT = 80.0  # weekly phone, power and transport, charged with the rent
CAR_BILL = 40.0  # weekly fuel and insurance for a car owner
HOSPITAL_FEE = 50.0
GROCERY_COST = 35.0  # ten meals from Fresh Market: the price of 'Buy groceries now' in the groceries fork
SHIFT_MARGIN = 10  # minutes spare a character keeps before setting off for a shift
LEISURE = ("idle", "relax_home", "read", "side_project", "text", "rest", "board_game")  # activities that can be interrupted
HISTORY_SIZE, NEWS_SIZE, HEADLINES_SIZE = 300, 300, 100  # events kept: all, importance >= 1, importance 2
LLM_LOG_SIZE = 500  # the city's ring of fork summaries decided by a model or a timeout
AGENT_LLM_FORKS = 30  # ... and each character's


def income_tax(hourly_wage: float) -> float:
    """Share of pay withheld: about 22% for a cashier, 43% for a doctor."""
    return min(0.45, 0.15 + 0.004 * hourly_wage)


@dataclass
class Activity:
    minutes: int
    gains: dict[str, float] = field(default_factory=dict)  # spread evenly over the activity
    inside: bool = True  # happens inside the place (hidden from the map)


ACTIVITIES = {
    "work": Activity(0),  # lasts until the shift ends
    "sleep": Activity(0),  # lasts until morning
    "coffee": Activity(15, {"energy": 15, "social": 5}),
    "rest": Activity(240, {"energy": 30, "fun": 25}),
    "stay_up": Activity(90, {"fun": 30, "energy": -8}),
    "text": Activity(15, {"social": 12}),
    "read": Activity(40, {"fun": 14}),
    "eat_home": Activity(30, {"hunger": 60, "social": 4}),
    "buy_groceries": Activity(20, {}),
    "order_food": Activity(45, {"hunger": 50}),
    "eat_out": Activity(40, {"hunger": 55, "social": 10, "fun": 6}),
    "snack": Activity(5, {"hunger": 25}, inside=False),
    "wait": Activity(30, {}, inside=False),
    "hang_out": Activity(90, {"social": 40, "fun": 25}),
    "relax_home": Activity(60, {"fun": 25, "energy": 5}),
    "shopping": Activity(45, {"fun": 20}),
    "family_dinner": Activity(90, {"hunger": 50, "social": 30, "fun": 10}),
    "phone_call": Activity(30, {"social": 30}, inside=False),
    "walk_park": Activity(60, {"fun": 30, "social": 4}, inside=False),
    "play": Activity(60, {"fun": 30, "social": 20}, inside=False),  # children playing in a park
    "board_game": Activity(60, {"fun": 25, "social": 10}),
    "leftovers": Activity(15, {"hunger": 35}),  # whatever is left in the cupboard
    "side_project": Activity(90, {"fun": 20}),
    "idle": Activity(20, {}),
    "hospital": Activity(180, {"hunger": 40}),  # the ward feeds its patients
}
# The housing forks' activities (moving house, viewings, DIY, ...): none of them is leisure.
ACTIVITIES.update({name: Activity(spec["minutes"], dict(spec["gains"]), spec["inside"])
                   for name, spec in housing.ACTIVITIES_EXTRA.items()})
# life's activities (life.md 7): the ward, a doctor's visit, a newborn's day.
ACTIVITIES.update({name: Activity(spec["minutes"], dict(spec["gains"]), spec["inside"])
                   for name, spec in life.ACTIVITIES_EXTRA.items()})

# How fast needs drop during some activities (default 1.0).
DECAY_SCALE = {
    "sleep": {"energy": 0.0, "hunger": 0.35, "social": 0.0, "fun": 0.0},
    "work": {"social": 0.0, "fun": 1.3, "hunger": 0.6},
    "hospital": {"social": 0.5, "fun": 0.5},
    "ward": {"social": 0.5, "fun": 0.5},  # life's hospital stay, like v2's afternoon in hospital
}

LIGHT_CYCLE = 6  # minutes: N-S green 0-2, yellow 2-3, E-W green 3-5, yellow 5-6
STOP_AT_LIGHTS = ("car", "taxi")  # they wait at a red light on entering a junction; buses and ambulances don't
ONE_WAY = ("taxi", "ambulance")  # vehicles that take a character to one place: on arrival they are on foot again
BUS_GIVE_UP = 26  # minutes at a stop (two headways, which the exact timetable never allows) before walking instead
FLIGHT_MINUTES = 12  # the daily planes (transit.FLIGHTS) take this long to cross the sky
WANDER = ("walk_park", "play")  # activities that stroll around their park
WANDER_EVERY = 1  # minutes per tile of a stroll in the park (walking pace, so an hour reaches its far end and back)
MEET = ("hang_out", "play")  # activities an invite meets at: the host waits doing it, the guest comes to do it
MEET_TILES = 3  # how near two people outdoors must be for a first meeting (_meet_someone)
IDLE_FUN = 1.6  # how much faster fun drains while sitting idle (FIXLISTS 8)
RECENT_FORKS = 8  # decisions the fork message's `you.recent` carries, with what came of each
DAY_OFF_WAKE = 8 * 60  # the alarm before a day off: 08:00 plus a personal 0-89 minutes (FIXLISTS 7)
NEWS_EVERY = {"fender": 30 * MINUTES_PER_DAY}  # outcome id -> the least time between two of one person's in the news
PHRASINGS = {  # outcome id -> the ways its event line reads, one picked by sim.rng when it lands (FIXLISTS 17)
    "stuck": ("Gets stuck and frustrated", "Hits a wall with the project", "Can't make the pieces fit", "Gives up on it for today"),
    "burnt": ("Burns the food", "Burns dinner to a crisp", "Sets off the smoke alarm cooking", "Overcooks everything"),
    "insomnia": ("Lies awake for hours", "Can't get to sleep", "Tosses and turns half the night", "Stares at the ceiling for hours"),
    "lovely_talk": ("A lovely long talk", "Talks for an hour and laughs a lot", "Catches up on all the news", "A warm, long chat"),
    "buzz": ("Arrives buzzing with energy", "Arrives glowing from the run", "Gets in wide awake and ready"),
    "late": ("Arrives late", "Gets in late", "Slips in after the start", "Turns up late, flustered"),
    "restless": ("Gets restless and bored", "Can't settle to anything", "Paces round the house, bored", "Gets fidgety and fed up"),
    "friend_there": ("Bumps into a friend", "Runs into a friend", "Spots a friend and stops to chat"),
    "groggy": ("Wakes up groggy", "Wakes up foggy-headed", "Drags themselves out of bed"),
    "great_time": ("Has a great time together", "They have a brilliant time", "Laughs the whole time together"),
    "breakthrough": ("Makes a breakthrough", "Cracks the hard part", "Gets it working at last", "Has a eureka moment"),
}
QUIET = ("tasty", "deep_sleep", "unwind", "bonding", "feast", "cosy_night")  # routine good meals, sleep, rest and
# dinners: kept in the decision's `happened` only, unless the outcome is news (importance 1 or more); a dinner out is its own one line
VARIED_MONEY = {"breakthrough": (20, 120)}  # outcome id -> the whole-dollar range its money is drawn from as it lands
WORLDS = ("millbrook", "region")  # Simulation(world=...): v2's 80 x 50 town, or the region around it (PLAN 2.1)


def _r1(x: float) -> float:
    """One decimal, rounding half up (floor(x * 10 + 0.5) / 10), as the JS port does."""
    return math.floor(x * 10 + 0.5) / 10


class Simulation:
    def __init__(self, seed: int = 1, now: Callable[[], float] = time.monotonic,
                 luck_log_path: str | None = None, *, world: str = "millbrook", folk: int = 0,
                 folk_isolated: bool = False, dice_seed: int | None = None):
        from . import cast  # here, not at the top, so `python3 -m gameofailife.cast` runs it only once

        if world not in WORLDS:
            raise ValueError(f"world must be one of {', '.join(WORLDS)}")
        self.seed = seed
        self.dice_seed = seed if dice_seed is None else dice_seed  # the keyed behaviour streams (dice.stream)
        self.world = world
        self.folk_isolated = bool(folk_isolated)
        folk = max(0, int(folk)) if world == "region" else 0  # townsfolk live in the region only
        self.rng = random.Random(seed)
        self.now = now
        self.clock = Clock()
        if world == "region":
            from . import region  # lazy: millbrook never loads the region's data
            self.town: TownMap = region.build_region(seed)  # shared and read-only, like build_map's
        else:
            self.town = build_map(seed)  # shared with every Simulation of this seed: never changed
        self.homes = housing.build_homes(self.town)  # home id -> Home
        self.lots = housing.build_lots(self.town, self.homes)  # residential place id -> Lot (its condition)
        self.agents, self.households = cast.build_cast(self.town, self.homes, seed)
        housing.init(self)
        self.stats = stats.CityStats()
        self.weather = "clear"
        self.forks: dict[str, Fork] = {}  # every fork still asked or recently decided
        self.asked_at: dict[str, float] = {}
        self.invites: dict[str, dict] = {}
        self.events: list[dict] = []  # new events since the server last drained them
        self.history: list[dict] = []  # the last HISTORY_SIZE events, for new God views
        self.news: list[dict] = []  # ... of importance 1 or 2
        self.headlines: list[dict] = []  # ... of importance 2
        self.fork_log: list[dict] = []  # decided forks since last drain
        self.llm_log: list[dict] = []  # the last LLM_LOG_SIZE summaries decided by a model or a timeout
        self.outbox: list[tuple[str, dict]] = []  # (controller name, message)
        self.controllers: dict[str, dict] = {}  # name -> {"model": str | None, "characters": [ids]}
        self.luck_log: list[dict] = []  # hidden: odds and rolls, never sent to anyone
        self.luck_log_path = luck_log_path
        self._event_seq = 0
        self._invite_ids = 0
        self._host_hold: dict[str, int] = {}  # host id -> tick they wait at an invite place until
        self._lawns: dict[str, list[tuple[int, int]]] = {}  # park id -> its lawn tiles, where a stroll heads
        self.folk = people.NoFolk()  # until make_folk below: nobody, every call a no-op
        life.pre_init(self)  # sim.life, and the job board with the named jobs
        self.folk = people.make_folk(self, folk, self.folk_isolated)  # folk_gen fills the board
        life.init(self)  # everyone's LifeState, and the start
        social.init(self)
        self._roll_weather()

    # --- lookups used by the fork builders -----------------------------------

    def household(self, agent: Agent) -> Household:
        return self.households[agent.household_id]

    def person(self, pid: str):
        """A named Agent or a townsperson by id, or None (people.person)."""
        return people.person(self, pid)

    def household_by_id(self, hid: str):
        """A named Household or a townsfolk household by id, or None (people.household_by_id)."""
        return people.household_by_id(self, hid)

    def home_of(self, agent: Agent) -> str:
        """The place id of the character's home: the house, or the apartment block of a flat."""
        return self.homes[self.household(agent).home_id].place

    def pending_invite_for(self, agent: Agent) -> dict | None:
        for inv in self.invites.values():
            if inv["to"] == agent.id and inv["status"] == "pending":
                return inv
        return None

    def on_shift_now(self, agent: Agent) -> bool:
        job = agent.job
        return bool(job and job.on_shift(self.clock.weekday, self.clock.hour) and agent.worked_today == self.clock.day
                    and agent.activity == "work")

    def walk_minutes(self, agent: Agent, place_id: str) -> int:
        """Minutes on foot from where the character is to a place."""
        if agent.inside == place_id:
            return 0
        return self.town.walk_minutes((agent.x, agent.y), place_id)

    def _shift_start_tick(self, agent: Agent) -> int | None:
        """Tick today's shift starts, while the character can still turn up for it (up to WORK_LATE late)."""
        job = agent.job
        if (not job or agent.worked_today == self.clock.day or self.clock.weekday not in job.workdays
                or self.clock.minute_of_day > job.start_hour * 60 + WORK_LATE):
            return None
        return self.clock.tick - self.clock.minute_of_day + job.start_hour * 60

    def _fits_before_closing(self, place, minutes: int, walk: int = 0) -> bool:
        """True when the place is open `walk` minutes from now and stays open for `minutes` after that, to the
        minute (an activity that ends as the doors shut is not cut short). A place with no hours always fits."""
        if not place.hours:
            return True
        start = self.clock.minute_of_day + walk
        return place.hours[0] * 60 <= start and start + minutes <= place.hours[1] * 60

    def _payer_for(self, agent: Agent, cost: float) -> Agent:
        """Children's costs they can't cover are paid by an adult in the household."""
        if agent.is_adult or cost <= max(agent.money, 0):
            return agent
        adults = [self.agents[m] for m in self.household(agent).member_ids
                  if self.agents[m].alive and self.agents[m].is_adult]
        return max(adults, key=lambda a: a.money) if adults else agent

    def living(self) -> list[Agent]:
        return [a for a in self.agents.values() if a.alive]

    # --- getting around, homes and statistics (delegated to their modules) ----

    def travel_minutes(self, agent: Agent, place_id: str, mode: str, worst: bool = False) -> int:
        return travel.travel_minutes(self, agent, place_id, mode, worst)

    def usual_mode(self, agent: Agent) -> str:
        return travel.usual_mode(self, agent)

    def commute_minutes(self, agent: Agent) -> int | None:
        return travel.commute_minutes(self, agent)

    def weekly_commute_cost(self, agent: Agent) -> int:
        return travel.weekly_commute_cost(self, agent)

    def nearest(self, agent: Agent, kinds: tuple[str, ...], origin=None, meet=None, stay: int = 0):
        return travel.nearest(self, agent, kinds, origin, meet, stay)

    def pay_household(self, hh: Household, amount: float) -> None:
        housing.pay_household(self, hh, amount)

    def possessions(self, agent: Agent) -> dict:
        """What the character owns: the agent page's and `query possessions`' block."""
        return housing.possessions_json(self, agent)

    def market_json(self) -> dict:
        """The homes for sale and to let (controller `query market`)."""
        return housing.market_json(self)

    def home_page(self, home_id: str) -> dict | None:
        """God's `get_home` reply body, or None for an unknown home."""
        return housing.home_page(self, home_id)

    def buses(self) -> list[dict]:
        """`state.buses`: positions are a pure function of the tick; riders are counted from `agent.riding`."""
        return transit.bus_rows(self.clock.tick, self.agents.values())

    def stats_json(self, full: bool = False) -> dict:
        """God's `stats` push (PLAN 3.8), built by stats.stats_json."""
        return stats.stats_json(self, full)

    def decisions(self, agent_id: str | None = None, before: str | None = None, limit: int = 30) -> dict | None:
        """The `get_decisions` reply body, built by stats.decisions; None for an unknown character."""
        return stats.decisions(self, agent_id, before, limit)

    # --- events ---------------------------------------------------------------

    def event(self, text: str, agent: Agent | None = None, kind: str | None = None, *, tag: str = "other",
              importance: int | None = None, agents: list[str] | None = None, place: str | None = None,
              remember: bool = True) -> dict | None:
        """Log something that happened, for God's views and the character's memory.

        `tag` is a key of chronicle.EVENT_TAGS and gives the kind and importance unless the call names them.
        `place` is a place id: the one given, else where the character is or is headed, else None.
        remember=False (and the God-only tags) keeps the line out of the character's memory.
        Returns None when people.news_gate drops it (the townsfolk-only news cap, PLAN 2.8).
        """
        if not people.news_gate(self, tag, importance, agent, agents):
            return None
        if place is None and agent is not None:
            place = agent.inside or agent.activity_place
        self._event_seq += 1
        stamp = self.clock.stamp()
        ev = chronicle.make_event(self._event_seq, self.clock.tick, stamp, text, tag, kind, importance,
                                  agent.id if agent else None, agents, place,
                                  (agent.x, agent.y) if agent else None)
        self.events.append(ev)
        self.history.append(ev)
        del self.history[:-HISTORY_SIZE]
        if ev["importance"] >= 1:
            self.news.append(ev)
            del self.news[:-NEWS_SIZE]
            if ev["importance"] >= 2:
                self.headlines.append(ev)
                del self.headlines[:-HEADLINES_SIZE]
        if agent and remember and tag not in chronicle.GOD_ONLY_TAGS:
            agent.remember(stamp, text)
        return ev

    def drain(self) -> tuple[list[dict], list[dict], list[tuple[str, dict]]]:
        out = self.events, self.fork_log, self.outbox
        self.events, self.fork_log, self.outbox = [], [], []
        return out

    # --- the main loop --------------------------------------------------------

    def step(self) -> None:
        self.clock.advance()
        m = self.clock.minute_of_day
        if m in (6 * 60, 14 * 60):
            self._roll_weather()
        if m == 0:
            self._new_day()
        if self.clock.weekday == 6 and m == 23 * 60:
            housing.weekly_charges(self)  # rent or property tax, and bills
            self.folk.weekly(self)
        if self.clock.weekday == 4 and m == 9 * 60:
            self._pay_pensions()
            self.folk.pensions(self)
        self._check_timeouts()
        self._expire_invites()
        housing.tick(self)
        life.tick(self)
        for agent in self.living():
            self._tick_agent(agent)
        self.folk.tick(self)
        social.tick(self)
        if m % 60 == 0:
            self.stats.sample(self)

    def run_days(self, days: float) -> None:
        for _ in range(int(days * MINUTES_PER_DAY)):
            self.step()

    # --- world clockwork ------------------------------------------------------

    def _roll_weather(self) -> None:
        old = self.weather
        self.weather = "rain" if self.rng.random() < RAIN_CHANCE[self.clock.season] else "clear"
        if old != self.weather:
            self.event("It starts to rain." if self.weather == "rain" else "The sky clears up.", tag="weather")

    def _new_day(self) -> None:
        life.legacy_ageing(self)  # v2's old-age roll and yearly birthday, until life's own rules replace them
        for agent in self.living():
            if getattr(agent, "car_at", None) and not travel.car_here(self, agent):
                agent.car_at = None  # type: ignore[attr-defined]  # a car left elsewhere is fetched home overnight
        housing.nightly(self)
        self.folk.nightly(self)
        self.stats.reset_day()

    def _pay_pensions(self) -> None:
        for a in self.living():
            if a.job is None and a.age >= 65:
                a.money += PENSION
                self.event(f"{a.name} receives a ${PENSION:.0f} pension.", a, tag="pension")

    def lights(self) -> dict:
        """Traffic light phase for north-south traffic; east-west is the opposite."""
        phase = self.clock.tick % LIGHT_CYCLE
        ns = "green" if phase < 2 else "yellow" if phase < 3 else "red"
        ew = "red" if phase < 3 else "green" if phase < 5 else "yellow"
        return {"ns": ns, "ew": ew}

    def plane(self) -> dict | None:
        m = self.clock.minute_of_day
        for dep in FLIGHTS:
            if dep <= m < dep + FLIGHT_MINUTES:
                return {"progress": round((m - dep) / FLIGHT_MINUTES, 3), "from": "Riverton", "to": "Lakeside"}
        return None

    def timetable(self) -> dict:
        table = transit.timetable_json()
        if self.world == "region":
            from . import rail  # lazy: millbrook has no railway
            table = {**table, "train": rail.timetable_json(self.town)}
        return table

    def trains(self) -> list[dict]:
        """`state.trains` (region.md 8): a pure function of the tick, riders from the townsfolk; [] in millbrook."""
        if self.world != "region":
            return []
        from . import rail
        return rail.train_rows(self.town, self.clock.tick, self.folk.riders(self.clock.tick))

    # --- agents ---------------------------------------------------------------

    def _tick_agent(self, agent: Agent) -> None:
        self._decay(agent)
        if agent.state == "travelling":
            self._travel(agent)
        elif agent.state == "busy":
            self._do_activity(agent)
        self._apply_due_outcomes(agent)
        if not agent.alive:
            return
        if agent.health <= 0:
            self._die(agent, "collapsed and could not be saved")
            return
        if agent.state == "idle":
            self._next(agent)

    def _decay(self, agent: Agent) -> None:
        scale = DECAY_SCALE.get(agent.activity if agent.state == "busy" else "", {})
        idle = agent.state == "busy" and agent.activity == "idle"
        for n in NEEDS:
            agent.adjust(n, -NEED_DECAY[n] * scale.get(n, 1.0) * (IDLE_FUN if idle and n == "fun" else 1.0))
        if idle and agent.inside == self.home_of(agent):  # waking minutes idle at home (forks.free_time_fork)
            agent.idle_home = getattr(agent, "idle_home", 0) + 1  # type: ignore[attr-defined]
        elif agent.activity == "sleep" or agent.inside is None and agent.state != "deciding":
            agent.idle_home = 0  # type: ignore[attr-defined]  # asleep, or out of the house
        if agent.needs["hunger"] <= 0:
            agent.health -= 0.03
        if agent.needs["energy"] <= 0:
            agent.health -= 0.02
        top = life.max_health(agent)  # 100, less with a chronic condition
        if min(agent.needs.values()) > 40 and agent.health < top:
            agent.health = min(top, agent.health + 0.004)

    def _next(self, agent: Agent) -> None:
        """Start the next planned step, or let the Director find the next decision."""
        if agent.age < life.FORK_AGE:
            life.toddle(self, agent)  # too young for forks: life's day for a small child
            return
        if (agent.plan and self._must_leave_for_work(agent, agent.plan[0][1])
                and not any(s[0] == "work" for s in agent.plan)):
            agent.plan = []  # drop the rest of the plan: it's time to head to work
        if agent.plan:
            self._start_step(agent, *agent.plan.pop(0))
            return
        if agent.fork_id:
            self._finish_fork(agent)
            if agent.state != "idle" or agent.plan:
                return  # an outcome set the character off (a haggle's deal: moving house)
        if agent.health < 25 and agent.inside != "hospital":
            life.hospitalise(self, agent, 1, "very unwell")  # the ambulance (v2: an afternoon; life: the ward)
            return
        fork = build_fork(self, agent)
        if fork:
            self.director(agent, fork)
            return
        home = self.home_of(agent)
        if agent.inside != home:
            agent.plan = [("idle", "home")]
            agent.usual_plan = True  # type: ignore[attr-defined]  # home the usual way: by car, bus or on foot
        else:
            agent.plan = [("idle", None)]
        self._start_step(agent, *agent.plan.pop(0))

    def _must_leave_for_work(self, agent: Agent, via: str | None = None) -> bool:
        """True once it's time to set off for today's shift: SHIFT_MARGIN minutes before the commute by the usual
        way (car, bus with its worst wait, or on foot) would start it, counting the trip by way of `via` if given."""
        start = self._shift_start_tick(agent)
        if start is None:
            return False
        place_id = self._resolve_place(agent, via)
        if place_id and agent.inside != place_id:
            mode = self.usual_mode(agent)
            route = (self.travel_minutes(agent, place_id, mode, worst=True)
                     + travel.leg_minutes(self, place_id, agent.job.place_id, mode))
        else:
            route = self.commute_minutes(agent)
        return self.clock.tick >= start - route - SHIFT_MARGIN

    def _resolve_place(self, agent: Agent, where: str | None) -> str | None:
        if where == "home":
            return self.home_of(agent)
        if where == "job":
            return agent.job.place_id if agent.job else self.home_of(agent)
        return where

    def _start_step(self, agent: Agent, activity: str, where: str | None) -> None:
        place_id = self._resolve_place(agent, where)
        home = self.home_of(agent)
        if place_id and agent.inside != place_id and getattr(agent, "usual_plan", False):
            agent.vehicle = travel.trip_mode(self, agent, place_id)  # a plan the usual way picks it trip by trip
            agent.speed = SPEEDS[agent.vehicle]
        agent.activity = activity
        agent.activity_place = place_id
        agent.trip = agent.riding = None  # a new step is a new trip (a bus ride in progress ends here too)
        if place_id and agent.inside != place_id:
            place = self.town.places[place_id]
            start = (agent.x, agent.y)
            if agent.vehicle == "car":  # the car goes where they go (and stays there when they leave on foot)
                agent.car_at = None if place_id == home else place_id  # type: ignore[attr-defined]
            if agent.vehicle == "bus" and self._take_bus(agent, place_id):
                return
            if agent.vehicle in ROAD_MODES:
                agent.path = self.town.drive_path(start, place_id)
            else:
                agent.path = self.town.path(start, place.entry)
            agent.inside = None
            if agent.path:
                agent.state = "travelling"
                return
            agent.x, agent.y = place.entry
        self._begin_activity(agent)

    def _take_bus(self, agent: Agent, place_id: str) -> bool:
        """Set off by bus: the trip `travel.bus_trip` finds leaving now, or False (walk) when no bus saves time.

        The rider walks to the board stop (`to_stop`), waits there (`waiting`) until a bus of the line stands at it,
        boards and pays (`riding`, `agent.riding` = the bus id, riding on the bus's tile), gets off on the first tick
        that bus stands at the alight stop and walks in (`from_stop`). So they walk in at departure + the trip's
        minutes, exactly as transit.best_trip counts them.
        """
        found = travel.bus_trip(self, agent, place_id)
        if found is None:
            return False
        _, line, board, alight = found
        agent.inside = None
        agent.state = "travelling"
        agent.trip = {"mode": "bus", "line": line, "board": board, "alight": alight, "phase": "to_stop",
                      "since": self.clock.tick}
        agent.path = self.town.path((agent.x, agent.y), transit.STOP_XY[board])
        if not agent.path:  # already at the stop: a bus may be standing there now
            self._bus_phase(agent, "waiting")
            self._bus_step(agent, agent.trip)
        return True

    def _bus_phase(self, agent: Agent, phase: str) -> None:
        agent.trip["phase"], agent.trip["since"] = phase, self.clock.tick

    def _bus_step(self, agent: Agent, trip: dict) -> None:
        """One minute at the stop or on board (buses are a pure function of the tick, so they have moved already)."""
        tick = self.clock.tick
        if trip["phase"] == "waiting":
            bus = transit.bus_at_stop(trip["line"], trip["board"], tick)
            if bus:
                fare = transit.fare(agent.age)  # paid once, on boarding
                if fare:
                    self._payer_for(agent, fare).money -= fare
                agent.riding = bus
                self._bus_phase(agent, "riding")
            elif tick - trip["since"] >= BUS_GIVE_UP:
                agent.trip = None  # no bus came: walk the rest of the way
                self._walk_on(agent)
            return
        agent.x, agent.y = transit.bus_xy(agent.riding, tick)
        if transit.bus_at_stop(trip["line"], trip["alight"], tick) == agent.riding:
            agent.riding = None
            self._bus_phase(agent, "from_stop")
            self._walk_on(agent)

    def _walk_on(self, agent: Agent) -> None:
        """From a bus stop, walk to the step's place (starting next minute)."""
        agent.path = self.town.path((agent.x, agent.y), self.town.places[agent.activity_place].entry)
        if not agent.path:
            agent.trip = None
            self._begin_activity(agent)

    def _travel(self, agent: Agent) -> None:
        trip = agent.trip
        if trip and trip["phase"] in ("waiting", "riding"):
            self._bus_step(agent, trip)
            return
        light = None
        for _ in range(agent.speed):
            if not agent.path:
                break
            nxt = agent.path[0]
            if agent.vehicle in STOP_AT_LIGHTS and nxt in self.town.junctions:
                light = light or self.lights()
                axis = "ns" if nxt[0] == agent.x else "ew"
                if light[axis] == "red":
                    break  # wait at the junction
            agent.x, agent.y = agent.path.pop(0)
        if agent.path:
            return
        if trip and trip["phase"] == "to_stop":  # at the stop: a bus may be standing there now
            self._bus_phase(agent, "waiting")
            self._bus_step(agent, trip)
            return
        agent.trip = None
        self._begin_activity(agent)

    def _begin_activity(self, agent: Agent) -> None:
        if agent.vehicle in ONE_WAY:  # the taxi or ambulance has gone: the next trip is on foot unless chosen
            agent.vehicle, agent.speed = "walk", SPEEDS["walk"]
        act = ACTIVITIES[agent.activity]
        place_id = agent.activity_place
        home = self.home_of(agent)
        if (agent.vehicle == "car" and (place_id == home or agent.activity in WANDER)
                and (not agent.plan or getattr(agent, "usual_plan", False))):
            agent.vehicle, agent.speed = "walk", SPEEDS["walk"]  # parked: on the driveway, or at the park gate
        if agent.inside != home:  # out of the house until now (forks.cooped_up)
            agent.out_tick = self.clock.tick  # type: ignore[attr-defined]
        paid, agent.paid = getattr(agent, "paid", None), None  # type: ignore[attr-defined]
        place = self.town.places.get(place_id or "")
        if place and place.hours and agent.activity != "work":
            if not place.is_open(self.clock.hour):
                self._find_shut(agent, place, paid)
                return
            if paid and paid[1] > 0 and not self._fits_before_closing(place, act.minutes):
                # A paid outing goes ahead only if the place stays open for all of it. The fork offered it only
                # then, but a controller's answer can come seconds (game minutes) later, and a trip can run slow.
                self._find_shut(agent, place, paid, closing=True)
                return
        agent.state = "busy"
        agent.path = []
        if place_id:
            agent.inside = place_id if act.inside and self.town.places[place_id].kind != "park" else None
        tick = self.clock.tick
        if agent.activity == "work":
            end = agent.job.end_hour * 60 if agent.job else self.clock.minute_of_day + 60
            minutes = max(30, end - self.clock.minute_of_day)
            agent.busy_until = tick + minutes
            # Paid from the shift start, not for turning up early.
            start = tick - self.clock.minute_of_day + agent.job.start_hour * 60 if agent.job else tick
            agent.work_started = max(tick, min(start, agent.busy_until - 30))  # type: ignore[attr-defined]
        elif agent.activity == "ward":
            agent.busy_until = agent.life.ward_until  # life's hospital stay: until the ward lets them go
        elif agent.activity == "sleep":
            # Up with time for breakfast before the shift: 7:00 starters at about 5:30, an hour more than the
            # commute from home (the usual way, the worst bus wait counted) for the long ones.
            m = self.clock.minute_of_day
            weekday = (self.clock.weekday + (1 if m >= 12 * 60 else 0)) % 7  # the day they wake up on
            if not agent.job or weekday not in agent.job.workdays:  # a day off (school: the weekend): a lie-in
                wake = DAY_OFF_WAKE + personal(agent, 90)
            else:
                wake = min(7 * 60, agent.job.start_hour * 60 - max(90, (self.commute_minutes(agent) or 0) + 60))
            wake += self.rng.randrange(0, 25)
            minutes = (wake - m) % MINUTES_PER_DAY
            if minutes > 11 * 60 or minutes < 60:  # a nap in the daytime
                minutes = 180
            agent.busy_until = tick + minutes
        else:
            agent.busy_until = tick + act.minutes
        if (agent.activity == "coffee" and agent.job and place_id == agent.job.place_id
                and any(s[0] == "work" for s in agent.plan)):
            # A cup at one's own workplace never holds up the shift: drunk by its start (today's, at once if late).
            start = tick - self.clock.minute_of_day + agent.job.start_hour * 60
            agent.busy_until = max(tick, min(agent.busy_until, start))
        if agent.activity in MEET and self._host_hold.get(agent.id, 0) > tick:
            agent.busy_until = max(agent.busy_until, self._host_hold.pop(agent.id))
        # Nothing runs into today's shift (the work fork offers a coffee on the way only while it fits before it).
        start = self._shift_start_tick(agent)
        if (agent.activity not in ("work", "hospital", "ward") and start is not None
                and not any(s[0] == "work" for s in agent.plan)):
            leave = start - self.commute_minutes(agent) - SHIFT_MARGIN  # as _must_leave_for_work counts it
            agent.busy_until = max(tick + 1, min(agent.busy_until, leave))
            if agent.activity == "idle":  # with nothing to do, the work fork comes as soon as it opens
                opens = start - work_lead(self, agent)
                if opens > tick:
                    agent.busy_until = min(agent.busy_until, opens)
        agent.activity_minutes = max(1, agent.busy_until - tick)  # type: ignore[attr-defined]
        if agent.activity == "eat_home":
            hh = self.household(agent)
            hh.groceries = max(0, hh.groceries - 1)
        if agent.busy_until <= tick:  # nothing to stay for (the cup at work as the shift starts): straight on
            self._end_activity(agent)

    def _do_activity(self, agent: Agent) -> None:
        act = ACTIVITIES[agent.activity]
        minutes = getattr(agent, "activity_minutes", 1)
        scale = 1.0  # at home, how good the home is scales what an activity gives
        if (act.gains or agent.activity == "sleep") and agent.activity_place == self.home_of(agent):
            scale = housing.activity_gain_scale(self, agent)
        for need, gain in act.gains.items():
            agent.adjust(need, (gain * scale if gain > 0 else gain) / minutes)
        if agent.activity == "sleep":
            agent.adjust("energy", 0.17 * scale)
        elif agent.activity == "hospital":
            agent.health = min(100.0, agent.health + 0.15)
        elif agent.activity in WANDER and self.clock.tick % WANDER_EVERY == 0:
            self._wander_park(agent)
        place = self.town.places.get(agent.activity_place or "")
        if place and place.hours and agent.activity != "work" and not place.is_open(self.clock.hour):
            agent.busy_until = self.clock.tick  # closing time: everyone out
        if self.clock.tick >= agent.busy_until:
            self._end_activity(agent)

    def _find_shut(self, agent: Agent, place, paid: tuple[str, float] | None, closing: bool = False) -> None:
        """Nothing is served at a shut place: the money comes back and the outing is off (a shift still stands).

        closing=True: the place is open but shuts before a paid outing there could be over, which is just as off.
        """
        refund = paid[1] if paid else 0.0
        if paid:  # the first stop of the character's own choice: none of what it promised happens either
            self.agents[paid[0]].money += refund
            agent.pending_outcomes = [p for p in agent.pending_outcomes if p["fork"] != agent.fork_id]
        self.event(f"{agent.name} finds {place.name} {'about to close' if closing else 'closed'}"
                   + (f" (${refund:.0f} refunded)." if refund else "."), agent, tag="closed", place=place.id)
        agent.path = []
        agent.plan = [s for s in agent.plan if s[0] == "work"]
        agent.state = "idle"
        agent.activity = "idle" if not agent.plan else agent.activity

    def _park_of(self, agent: Agent):
        """The park of the character's walk: the activity's own, else Riverside Park."""
        place = self.town.places.get(agent.activity_place or "")
        return place if place is not None and place.kind == "park" else self.town.places["park"]

    def _lawns_of(self, park) -> list[tuple[int, int]]:
        """The park's lawn tiles, row by row: where a stroll may head (cached per park)."""
        lawns = self._lawns.get(park.id)
        if lawns is None:
            lawns = self._lawns[park.id] = [(x, y) for y in range(park.y, park.y + park.h)
                                            for x in range(park.x, park.x + park.w) if self.town.tiles[y][x] == PARK]
        return lawns

    def _wander_park(self, agent: Agent) -> None:
        """One tile of a stroll: toward a lawn tile of the park picked at random, then another, and back to the
        gate for the last stretch, so the visit ends where it began. A tree in the way sends them somewhere else.
        The last stretch descends the gate's walk field (ties E, W, S, N), through the park where a shortest way
        back allows."""
        park = self._park_of(agent)
        gate = (park.entry[0], park.entry[1])
        x, y = agent.x, agent.y
        left = self.town.steps((x, y), gate)
        if (agent.busy_until - self.clock.tick) // WANDER_EVERY <= left + 1:
            down = [(nx, ny) for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1))
                    if self.town.walkable(nx, ny) and self.town.steps((nx, ny), gate) == left - 1]
            if down:
                agent.x, agent.y = next((t for t in down if park.x <= t[0] < park.x + park.w
                                         and park.y <= t[1] < park.y + park.h), down[0])
            return
        goal = getattr(agent, "wander_to", None)
        if goal is None or goal == (x, y):
            goal = agent.wander_to = self.rng.choice(self._lawns_of(park))  # type: ignore[attr-defined]
        dx, dy = goal[0] - x, goal[1] - y
        sx, sy = (dx > 0) - (dx < 0), (dy > 0) - (dy < 0)
        for nx, ny in (((x + sx, y), (x, y + sy)) if abs(dx) >= abs(dy) else ((x, y + sy), (x + sx, y))):
            if ((nx, ny) != (x, y) and park.x <= nx < park.x + park.w and park.y <= ny < park.y + park.h
                    and self.town.walkable(nx, ny)):
                agent.x, agent.y = nx, ny
                return
        agent.wander_to = None  # type: ignore[attr-defined]  # there already, or blocked: pick another spot

    def _end_activity(self, agent: Agent) -> None:
        if agent.activity == "work" and agent.job:
            hours = (self.clock.tick - getattr(agent, "work_started", self.clock.tick)) / 60
            pay = round(agent.job.hourly_wage * max(0.0, hours) * (1 - income_tax(agent.job.hourly_wage)), 2)
            if pay:
                agent.money += pay
                agent.week_earnings += pay
            career.on_shift_end(self, agent)  # standing at work (v2: reputation +0.5 a shift)
        elif agent.activity == "buy_groceries":
            self.household(agent).groceries += 10
        elif agent.activity == "hospital":
            payer = self._payer_for(agent, HOSPITAL_FEE)
            payer.money -= HOSPITAL_FEE
            by = "" if payer is agent else f" by {payer.name.split()[0]}"
            self.event(f"{agent.name} leaves City Hospital feeling better (paid ${HOSPITAL_FEE:.0f}{by}).",
                       agent, tag="discharged")
        elif agent.activity in WANDER:
            agent.x, agent.y = self._park_of(agent).entry  # back at the gate (the stroll's last stretch heads there)
            agent.wander_to = None  # type: ignore[attr-defined]
        elif agent.activity == "sleep":
            agent.woke_tick = self.clock.tick  # type: ignore[attr-defined]
        agent.state = "idle"
        agent.activity = "idle" if not agent.plan else agent.activity

    def _die(self, agent: Agent, how: str) -> None:
        place = agent.inside or agent.activity_place  # where it happened, before `inside` is cleared
        agent.alive = False
        agent.state = "dead"
        agent.activity = "dead"
        agent.plan = []
        agent.path = []
        agent.inside = None
        agent.trip = None
        agent.riding = None
        agent.died = {"tick": self.clock.tick, "time": self.clock.stamp(), "how": how}
        self._withdraw_fork(agent)  # nothing is played for the dead
        for inv in self.invites.values():
            if inv["from"] == agent.id and inv["status"] == "pending":
                inv["status"] = "expired"
                guest = people.person(self, inv["to"])
                if guest is None:
                    continue
                asked = self.forks.get(getattr(guest, "fork_id", None) or "")
                if asked and asked.kind == "invite" and asked.options[0].extra.get("invite") == inv["id"]:
                    self._withdraw_fork(guest)  # the guest can't accept a dead host's invite
        self.event(f"{agent.name} {how}, aged {agent.age}.", agent, tag="death", place=place)
        for other_id, rel in agent.relationships.items():
            other = self.agents.get(other_id)
            if other and other.alive and rel.affinity > 30:
                other.adjust("fun", -40)
                other.adjust("social", -20)
                other.remember(self.clock.stamp(), f"Lost {agent.name}.")
        self.household(agent).member_ids = [m for m in self.household(agent).member_ids if m != agent.id]
        housing.on_death(self, agent)
        life.on_death(self, agent)  # widowhood, grief, the job slot, loans, the agenda (both tiers)

    def _withdraw_fork(self, agent: Agent) -> None:
        """Stop asking a character's open fork: nothing is played for it and answers are refused."""
        fork = self.forks.get(agent.fork_id or "")
        if fork and fork.status == "asked":
            fork.status = "withdrawn"
            self.stats.count("withdrawn")
            agent.fork_id = None
            if agent.state == "deciding":
                agent.state = agent.activity = "idle"  # the Director finds their next decision

    # --- the Decision Director -------------------------------------------------

    def director(self, agent: Agent, fork: Fork) -> None:
        fork.scores = default_scores(agent, fork, self)
        fork.profile_choice = fork.scores.index(max(fork.scores))  # first on ties
        ranked = sorted(fork.scores, reverse=True)
        self.forks[fork.id] = fork
        margin = MAJOR_MARGIN if fork.major else OBVIOUS_MARGIN  # a move needs a clearer lead than a coffee
        if ranked[0] - ranked[1] >= margin - 1e-9:
            self._decide(agent, fork, fork.profile_choice, "habit", "Obvious from the character's habits.")
        elif agent.controller:
            fork.status = "asked"
            fork.controller = agent.controller
            fork.model = (self.controllers.get(agent.controller) or {}).get("model")
            agent.state = "deciding"
            agent.activity = "deciding"
            agent.fork_id = fork.id
            self.asked_at[fork.id] = self.now()
            self.stats.count("asked")
            self.outbox.append((agent.controller, self.fork_message(agent, fork)))
            self._set_off_thinking(agent, fork)
        else:
            self._decide(agent, fork, self.default_choice(fork), "default", "Played from the character's profile.")

    def _set_off_thinking(self, agent: Agent, fork: Fork) -> None:
        """While the controller thinks, the work fork's character sets off the usual way at once (FIXLISTS 1: a
        character who stood still for the answer arrived late): the usual way's first step (by car for a driver,
        else option 0), unpaid, nothing rolled.
        When the answer lands, _decide re-times it from where they are (_retime). Already at work, the shift
        begins. Other forks wait where they are."""
        if fork.kind != "work":
            return
        mode = self.usual_mode(agent)
        prov = next((i for i in (0, 1) if fork.options[i].vehicle == mode), 0)
        opt = fork.options[prov]
        if not opt.steps or not self._resolve_place(agent, opt.steps[0][1]):
            return
        agent.provisional = prov  # type: ignore[attr-defined]
        agent.thinking = fork.id  # type: ignore[attr-defined]  # the asked fork whose provisional plan is under way
        agent.provisional_eta = self.clock.tick + (self._option_minutes(agent, opt) or 0)  # type: ignore[attr-defined]
        agent.usual_plan = opt.vehicle == USUAL  # type: ignore[attr-defined]
        if not agent.usual_plan:
            agent.vehicle = opt.vehicle if opt.vehicle in SPEEDS else "walk"
            agent.speed = SPEEDS[agent.vehicle]
        agent.plan = []
        agent.paid = None  # type: ignore[attr-defined]
        self._start_step(agent, *opt.steps[0])

    def _on_provisional(self, agent: Agent, opt) -> bool:
        """True while the character is on (travelling to or doing) the option's first step."""
        act, where = opt.steps[0]
        return (agent.state in ("travelling", "busy") and agent.activity == act
                and agent.activity_place == self._resolve_place(agent, where))

    def _option_minutes(self, agent: Agent, opt, stays: bool = False) -> int | None:
        """The minutes an option's first trip takes from here (the fork message's `travel_minutes`): to its first
        place, by its vehicle or the usual way, and for a stop on the way to work the leg on to work too; None
        when it goes nowhere. stays=True adds the stops' own minutes before the work step (a coffee, a snack)."""
        minutes = None
        first = next((where for _, where in opt.steps if where is not None), None)  # the first trip's place
        place_id = self._resolve_place(agent, first)
        if opt.vehicle == USUAL:  # the way the plan will go: by car, bus or on foot (travel.trip_mode)
            mode = travel.trip_mode(self, agent, place_id) if place_id else "walk"
        else:
            mode = opt.vehicle if opt.vehicle in SPEEDS else "walk"
        if place_id and agent.inside != place_id:
            minutes = self.travel_minutes(agent, place_id, mode)
        if place_id and agent.job and place_id != agent.job.place_id and any(s[0] == "work" for s in opt.steps):
            # A stop on the way to work (a coffee first): the minutes count the leg on to work too.
            minutes = (minutes or 0) + travel.leg_minutes(self, place_id, agent.job.place_id, mode)
        if stays and agent.job:
            for act, where in opt.steps:
                if act == "work":
                    break
                if (self._resolve_place(agent, where) or agent.inside) != agent.job.place_id:
                    minutes = (minutes or 0) + ACTIVITIES[act].minutes
        return minutes

    def _retime(self, agent: Agent, fork: Fork, choice: int) -> tuple[int, str]:
        """The option to play when an answer lands after the character set off for work (FIXLISTS 1), and why when
        it is not the one chosen. Any way to work: already at work, the way they went; the chosen way when it
        still gets them in on time from here; else the fastest way still on time (or simply the fastest). The
        played option's hidden late odds are worked out again for when they get in. A choice to stay home stands."""
        goes = [i for i, o in enumerate(fork.options) if any(s[0] == "work" for s in o.steps)]
        start = self._shift_start_tick(agent)
        if start is None or choice not in goes:
            return choice, ""
        tick = self.clock.tick
        working = agent.state == "busy" and agent.activity == "work"
        mins = {}
        prov = getattr(agent, "provisional", 0)
        for i in goes:
            if i == prov and self._on_provisional(agent, fork.options[prov]):
                mins[i] = 0 if agent.state == "busy" else max(0, getattr(agent, "provisional_eta", tick) - tick)
            else:
                mins[i] = self._option_minutes(agent, fork.options[i], stays=True) or 0
        left = start - tick
        if working:
            played = prov
        elif mins[choice] <= left:
            played = choice
        else:
            on_time = [i for i in goes if mins[i] <= left]
            played = min(on_time or goes, key=lambda i: (mins[i], i))
        late_by = getattr(agent, "work_started", tick) - start if working else mins[played] - left
        retime_late(fork.options[played], late_by)
        if played == choice:
            return choice, ""
        why = "already at work by then" if working else "too late for that by then"
        return played, f"{why}: {fork.options[played].label.lower()} instead"

    def default_choice(self, fork: Fork) -> int:
        noisy = [s + self.rng.uniform(0, 0.08) for s in fork.scores]
        return noisy.index(max(noisy))

    def fork_message(self, agent: Agent, fork: Fork) -> dict:
        hh = self.household(agent)
        options = []
        for i, opt in enumerate(fork.options):
            options.append(opt.public(i, self._option_minutes(agent, opt)))
        here = self.town.places.get(agent.inside or "")
        payer = self._payer_for(agent, float("inf")) if not agent.is_adult else agent
        extra = {"minutes_per_second": TICKS_PER_REAL_SECOND * self.speed} if getattr(self, "speed", 0) else {}
        recent = [{"id": f["id"], "time": f["time"], "kind": f["kind"], "question": f["question"],
                   "label": f["options"][f["choice"]], "by": f["decided_by"], "happened": list(f["happened"])}
                  for f in agent.forks[-RECENT_FORKS:]]  # what came of each, keyed by fork id (FIXLISTS 2)
        return {
            "type": "fork", "fork_id": fork.id, "agent_id": agent.id, "kind": fork.kind,
            "question": fork.question, "about": fork.about, "options": options, "time": self.clock.stamp(),
            "deadline_seconds": ANSWER_SECONDS, "weather": self.weather, "season": self.clock.season,
            "profile_scores": list(fork.scores),
            "you": {"name": agent.name, "profile": agent.profile.prompt, "money": round(agent.money, 2),
                    "needs": {k: round(v) for k, v in agent.needs.items()}, "health": round(agent.health),
                    "where": agent.inside or "outside", "groceries_at_home": hh.groceries,
                    "goal": agent.goal, "recent_memory": agent.memory[-5:],
                    "savings": r2(agent.savings), "where_name": here.name if here else "outside",
                    "home_name": self.homes[hh.home_id].name, **housing.fork_you(self, agent),
                    "today": today_line(self, agent), "recent": recent,
                    "payer": ({"name": payer.name, "money": round(payer.money, 2)} if payer is not agent else None),
                    "life": life.fork_you(self, agent)},
            **extra,
        }

    def answer(self, fork_id: str, choice: int, reason: str = "", controller: str | None = None) -> dict:
        """A controller's answer. Applies within 5s; within 10s it only teaches the profile."""
        fork = self.forks.get(fork_id)
        if not fork:
            return {"accepted": False, "error": "unknown fork"}
        agent = self.agents[fork.agent_id]
        if controller is not None and agent.controller != controller:
            return {"accepted": False, "error": "not your character"}
        if not agent.alive:
            return {"accepted": False, "error": "character is dead"}
        if fork.status == "withdrawn":
            return {"accepted": False, "error": "fork withdrawn"}
        if not isinstance(choice, int) or isinstance(choice, bool) or not 0 <= choice < len(fork.options):
            return {"accepted": False, "error": "choice must be 0 to 3"}
        elapsed = self.now() - self.asked_at.get(fork_id, self.now())
        if fork.status == "asked" and elapsed > ANSWER_SECONDS:
            self._check_timeouts()  # the deadline passed before the next tick noticed
        if fork.status == "asked" and elapsed <= ANSWER_SECONDS:
            self._learn(agent, fork, choice, reason)
            self._decide(agent, fork, choice, "model", reason)
            return {"accepted": True, "applied": True}
        if (fork.status == "decided" and fork.decided_by == "timeout" and elapsed <= LEARN_SECONDS
                and getattr(fork, "late_answer", None) is None):  # only the first late answer teaches
            self._learn(agent, fork, choice, reason)
            fork.late_answer = {"choice": choice, "reason": reason}  # type: ignore[attr-defined]
            self.stats.count("late")
            for summary in agent.forks:
                if summary["id"] == fork.id:
                    summary["late"] = {"choice": choice, "reason": reason, "seconds": _r1(elapsed)}
                    if not any(s is summary for s in self.fork_log):
                        self.fork_log.append(summary)  # sent again, same id, so viewers see the late answer
            return {"accepted": True, "applied": False, "note": "too late to act on; saved to the profile"}
        return {"accepted": False, "error": "too late"}

    def _learn(self, agent: Agent, fork: Fork, choice: int, reason: str) -> None:
        opt = fork.options[choice]
        note = f"{fork.kind}: chose '{opt.label}'" + (f" because {reason}" if reason else "")
        # What the choice says beyond the fork's options on average (FIXLISTS 9): picking one of four thrifty ways
        # teaches no thrift. (The cap and the slow drift back to the start are agent.py's.)
        tags = {}
        for k in sorted({k for o in fork.options for k in o.tags}):
            total = 0.0
            for o in fork.options:
                total += o.tags.get(k, 0.0)
            tags[k] = opt.tags.get(k, 0.0) - total / len(fork.options)
        agent.profile.learn(tags, note[:200])
        if not agent.profile.prompt_edited:
            agent.profile.prompt = agent.profile.describe(agent)

    def _check_timeouts(self) -> None:
        now = self.now()
        for fid, asked in list(self.asked_at.items()):
            fork = self.forks.get(fid)
            if fork and fork.status == "asked" and now - asked > ANSWER_SECONDS:
                agent = self.agents[fork.agent_id]
                self._decide(agent, fork, self.default_choice(fork), "timeout", "No answer in time; played the default.")
            elif (fork and fork.status == "asked" and fork.kind != "work"
                  and self._must_leave_for_work(self.agents[fork.agent_id])):
                # Life does not wait: still thinking when it is time to set off for the shift (FIXLISTS 1).
                self._decide(self.agents[fork.agent_id], fork, self.default_choice(fork), "timeout",
                             "Time to leave for work; played the default.")
            if now - asked > LEARN_SECONDS:
                del self.asked_at[fid]
                self.forks.pop(fid, None)

    def _decide(self, agent: Agent, fork: Fork, choice: int, by: str, reason: str) -> None:
        moving = getattr(agent, "thinking", None) == fork.id and agent.alive  # set off while the controller thought
        if moving:
            agent.thinking = None  # type: ignore[attr-defined]
            choice, note = self._retime(agent, fork, choice)
            if note:
                reason = f"{reason} ({note})" if reason else note[0].upper() + note[1:] + "."
        opt = fork.options[choice]
        carry = moving and choice == getattr(agent, "provisional", 0) and self._on_provisional(agent, opt)  # under way
        asked = self.asked_at.get(fork.id)
        seconds = self.now() - asked if asked is not None else None
        fork.status, fork.choice, fork.decided_by, fork.reason = "decided", choice, by, reason
        if fork.id not in self.asked_at:
            self.forks.pop(fork.id, None)
        if not agent.alive:
            return
        if fork.profile_choice is None:  # decided without going through the Director
            fork.scores = fork.scores or default_scores(agent, fork, self)
            fork.profile_choice = fork.scores.index(max(fork.scores))
        self.stats.count(stats.DECIDED_BY[by], seconds if by == "model" and seconds is not None else None)
        if by == "model" and choice != fork.profile_choice:
            self.stats.count("against_habit")
        place = agent.inside or agent.activity_place  # where the character was when it was decided
        hh = self.household(agent)
        if not opt.charge:
            agent.paid = None  # type: ignore[attr-defined]  # a move pays its own way when it goes through
        elif opt.household_pays:
            if opt.cost:
                self.pay_household(hh, opt.cost)  # the adults' pooled money and savings
            agent.paid = None  # type: ignore[attr-defined]  # nothing is handed back to the pool at a shut door
        else:
            payer = self._payer_for(agent, opt.cost)
            payer.money -= opt.cost
            agent.paid = (payer.id, opt.cost)  # type: ignore[attr-defined]  # handed back if the place is shut
        agent.fork_id = fork.id
        if carry and agent.state == "busy":
            agent.paid = None  # type: ignore[attr-defined]  # the step it pays for has begun
        if not carry:
            agent.state = "idle"
        if fork.kind in COOLDOWN:  # longer after a choice that does not help (FIXLISTS 5)
            agent.cooldowns[fork.kind] = self.clock.tick + opt.extra.get("cooldown", COOLDOWN[fork.kind])
        if fork.kind == "free_time":
            agent.idle_home = 0  # type: ignore[attr-defined]
        if any(step[0] == "work" for step in opt.steps) or opt.extra.get("skip_work"):
            agent.worked_today = self.clock.day
        self._apply_extra(agent, fork, opt)
        # Roll the hidden outcomes now; most land when the plan is done, some later. Within a group the first
        # hit wins: the group's later outcomes are neither rolled nor logged.
        hit_groups: set[str] = set()
        for out in opt.outcomes:
            if out.p <= 0 or (out.group is not None and out.group in hit_groups):
                continue
            p = luck_odds(out.p, out.valence, agent.luck)
            roll = self.rng.random()
            self._log_roll(agent, f"{fork.id}:{out.id}", p, roll, base=out.p)
            if roll < p:
                if out.group is not None:
                    hit_groups.add(out.group)
                delay = out.effects.get("delay")
                agent.pending_outcomes.append({"fork": fork.id, "outcome": out,
                                               "due": self.clock.tick + delay if delay else None})
        summary = {"id": fork.id, "agent": agent.id, "kind": fork.kind, "tick": self.clock.tick,
                   "time": self.clock.stamp(), "question": fork.question, "options": [o.label for o in fork.options],
                   "choice": choice, "decided_by": by, "reason": reason, "happened": fork.happened,
                   "major": fork.major, "controller": fork.controller, "model": fork.model,
                   "answer_seconds": _r1(seconds) if by == "model" and seconds is not None else None,
                   "late": None, "profile_choice": fork.profile_choice, "place": place}
        agent.forks.append(summary)
        del agent.forks[:-20]
        if by in ("model", "timeout"):
            self.llm_log.append(summary)
            del self.llm_log[:-LLM_LOG_SIZE]
            agent.llm_forks.append(summary)
            del agent.llm_forks[:-AGENT_LLM_FORKS]
            agent.llm_count += 1
        self.fork_log.append(summary)
        # The choice is paid for and its outcomes rolled, so it happens even if it's now time to leave for work:
        # _begin_activity cuts it short (even once the shift has begun), and _next drops any later steps.
        if carry:  # the provisional plan already does its first step: the rest follows it
            agent.plan = [tuple(step) for step in opt.steps[1:]]
        else:
            self.start_plan(agent, opt.steps, opt.vehicle)

    def start_plan(self, agent: Agent, steps: list, vehicle: str = "walk") -> None:
        """Give the character a plan and start its first step now; with no steps the Director looks for the
        next fork. Housing uses it too (moving a household, sending a helper).

        `vehicle` travel.USUAL (an option's default) makes each trip of the plan the usual way, picked as it sets
        off (travel.trip_mode: the car where it is parked, the bus, or on foot); any other mode is the plan's for
        every trip, and an unknown one walks."""
        agent.usual_plan = vehicle == USUAL  # type: ignore[attr-defined]
        if not agent.usual_plan:
            agent.vehicle = vehicle if vehicle in SPEEDS else "walk"
            agent.speed = SPEEDS[agent.vehicle]
        agent.plan = list(steps)
        agent.state = "idle"
        if agent.plan:
            self._start_step(agent, *agent.plan.pop(0))
        else:
            self._next(agent)

    def _log_roll(self, agent: Agent, what: str, p: float, roll: float, base: float | None = None) -> None:
        if people.is_folk_id(agent.id):
            people.log_roll(self, agent, what, p, roll)  # a townsperson's roll goes to the folk luck log
            return
        entry = {"tick": self.clock.tick, "agent": agent.id, "luck": round(agent.luck, 1), "what": what,
                 "base_p": base, "p": round(p, 4), "roll": round(roll, 4), "hit": roll < p}
        self.luck_log.append(entry)
        del self.luck_log[:-5000]
        if self.luck_log_path:
            with open(self.luck_log_path, "a") as f:
                f.write(json.dumps(entry) + "\n")

    def _finish_fork(self, agent: Agent) -> None:
        fid = agent.fork_id
        agent.fork_id = None
        due_now = [p for p in agent.pending_outcomes if p["fork"] == fid and p["due"] is None]
        agent.pending_outcomes = [p for p in agent.pending_outcomes if p not in due_now]
        for p in due_now:
            self._apply_outcome(agent, p)

    def _apply_due_outcomes(self, agent: Agent) -> None:
        due = [p for p in agent.pending_outcomes if p["due"] is not None and p["due"] <= self.clock.tick]
        if due:
            agent.pending_outcomes = [p for p in agent.pending_outcomes if p not in due]
            for p in due:
                self._apply_outcome(agent, p)

    def _apply_outcome(self, agent: Agent, pending: dict) -> None:
        out = pending["outcome"]
        label = out.label
        effects = out.effects
        if out.id in VARIED_MONEY and "money" in effects:  # not the same amount every time (FIXLISTS 17)
            lo, hi = VARIED_MONEY[out.id]
            effects = {**effects, "money": float(lo + int(self.rng.random() * (hi - lo + 1)))}
        for key, value in effects.items():
            if key in NEEDS:
                agent.adjust(key, value)
            elif key == "money":
                agent.money += value
            elif key == "health":
                agent.health = max(0.0, min(100.0, agent.health + value))
            elif key == "reputation":
                agent.reputation = max(0.0, min(100.0, agent.reputation + value))
            elif key == "memory":
                agent.remember(self.clock.stamp(), value)
            elif key == "meet_new":
                met = self._meet_someone(agent)
                if met is None:
                    return  # nobody new nearby: nothing happened, and nothing is logged
                label = f"Meets {met.name}"  # the meeting's own line is the event (FIXLISTS 4)
            elif key == "family_bond":
                for m in self.household(agent).member_ids:
                    if m != agent.id and m in agent.relationships:
                        agent.relationships[m].bump(value)
                        back = self.agents[m].relationships.get(agent.id)
                        if back:
                            back.bump(value)
            elif isinstance(key, tuple) and key[0] == "rel":
                self._bump(agent, key[1], value)
            elif key == "delay":
                continue  # when it lands, not what it does
            elif isinstance(key, str) and people.apply_effect(self, agent, key, value):
                pass  # a life effect (people.EFFECTS)
            elif isinstance(key, str):
                housing.apply_effect(self, agent, key, value)  # home_condition, hh_money, buy, ... (P2)
        if "meet_new" in out.effects:
            self._happened(agent, pending, label)
            return
        text, tag, importance = chronicle.outcome_event(agent.name, out.label, effects)
        if out.id in QUIET and importance == 0:  # a routine good night or meal: no log line (FIXLISTS 17)
            self._happened(agent, pending, label)
            return
        if out.id in PHRASINGS:
            ways = PHRASINGS[out.id]
            text = chronicle.outcome_event(agent.name, ways[int(self.rng.random() * len(ways))], effects)[0]
        if out.id in NEWS_EVERY and importance >= 1:  # news once in a while: the rest stay in the history only
            seen = getattr(agent, "news_ticks", None)
            if seen is None:
                seen = agent.news_ticks = {}  # type: ignore[attr-defined]  # outcome id -> tick it was last news
            if out.id in seen and self.clock.tick - seen[out.id] < NEWS_EVERY[out.id]:
                importance = 0
            else:
                seen[out.id] = self.clock.tick
        self.event(text, agent, tag=tag, importance=importance)
        self._happened(agent, pending, label)

    def _happened(self, agent: Agent, pending: dict, label: str) -> None:
        """Add what came true to its fork's summary (`happened`), sent again so viewers see what came of it."""
        for summary in agent.forks:
            if summary["id"] == pending["fork"]:
                summary["happened"].append(label)
                if not any(s is summary for s in self.fork_log):
                    self.fork_log.append(summary)  # sent again, same id, so viewers see what came of it

    def _bump(self, agent: Agent, other_id: str, value: float) -> None:
        other = self.agents.get(other_id)
        if not other:
            return
        for a, b in ((agent, other), (other, agent)):
            if b.id not in a.relationships:
                a.relate(b.id, RelationKind.ACQUAINTANCE, 10)
        before = agent.relationships[other_id].affinity
        for a, b in ((agent, other), (other, agent)):
            a.relationships[b.id].bump(value if a is agent else value / 2)
        chronicle.on_affinity(self, agent.id, other_id, before, agent.relationships[other_id].affinity)

    def _meet_someone(self, agent: Agent, pool: list | None = None) -> Agent | None:
        """A first meeting with a stranger of the same age group, drawn from `pool` (Agents or ids) if given, else
        from the people right here (FIXLISTS 4): in the same building, or outdoors within MEET_TILES tiles of an
        outdoor character. Returns who they met, or None (nobody new nearby: nothing happens)."""
        if pool is None:
            candidates = [a for a in self.living() if self._nearby(agent, a)]
        else:
            candidates = [self.agents.get(p) if isinstance(p, str) else p for p in pool]
        strangers = [a for a in candidates if a is not None and a.alive and a.id != agent.id
                     and a.id not in agent.relationships and (a.is_adult == agent.is_adult)]
        if not strangers:
            return None
        other = self.rng.choice(strangers)
        agent.relate(other.id, RelationKind.ACQUAINTANCE, 15)
        other.relate(agent.id, RelationKind.ACQUAINTANCE, 15)
        other.remember(self.clock.stamp(), f"Met {agent.name}.")
        where = self.town.places.get(agent.inside or agent.activity_place or "")
        self.event(f"{agent.name} meets {other.name} for the first time" + (f" at {where.name}." if where else "."),
                   agent, tag="first_meet", agents=[other.id])
        return other

    def _nearby(self, agent: Agent, other: Agent) -> bool:
        """True when two characters could fall into talk: in the same building, or both outdoors within
        MEET_TILES tiles of each other."""
        if agent.inside or other.inside:
            return agent.inside == other.inside
        return max(abs(agent.x - other.x), abs(agent.y - other.y)) <= MEET_TILES

    def _apply_extra(self, agent: Agent, fork: Fork, opt) -> None:
        extra = opt.extra
        if "invite" in extra:
            inv = self.invites.get(extra["invite"])
            host = people.person(self, inv["from"]) if inv else None
            if inv and host is not None:
                inv["status"] = extra["answer"]
                words = {"accept": "accepts", "decline": "declines", "later": "suggests another day for",
                         "ignore": "ignores"}[extra["answer"]]
                self.event(f"{agent.name} {words} {host.name.split()[0]}'s invite.", agent,
                           tag="invite_accepted" if extra["answer"] == "accept" else "invite_declined",
                           agents=[host.id], place=inv["place"])
                host.remember(self.clock.stamp(), f"{agent.name.split()[0]} {words} my invite to "
                                                  f"{self.town.places[inv['place']].name}.")  # the host's page (FIXLISTS 14)
                self._deliver(host, {"type": "invite_answer", "invite_id": inv["id"], "from": agent.id,
                                     "answer": extra["answer"]})
                if extra["answer"] == "accept":
                    self._host_waits(host, agent, inv["place"])
        if "invite_to" in extra:
            inv = self.invite(agent, extra["invite_to"], extra["place"])
            if inv:
                inv["host_goes"] = True  # the host is on the way; the invite lapses once they leave
        if "save" in extra and agent.goal:
            amount = min(extra["save"], max(agent.money, 0))
            agent.money -= amount
            agent.goal["saved"] = round(agent.goal["saved"] + amount, 2)
            if agent.goal["saved"] >= agent.goal["target"]:
                self.event(f"{agent.name} finally buys {agent.goal['name']} with their savings!", agent,
                           tag="goal_reached")
                agent.adjust("fun", 40)
                agent.goal = None
            else:
                self.event(f"{agent.name} saves ${amount:.0f} toward {agent.goal['name']} "
                           f"(${agent.goal['saved']:.0f} of ${agent.goal['target']:.0f}).", agent, tag="saving")
        elif "save" in extra:
            amount = min(extra["save"], max(agent.money, 0))
            agent.money -= amount
            agent.savings = round(agent.savings + amount, 2)
            self.event(f"{agent.name} puts ${amount:.0f} into savings (${agent.savings:.0f} saved).", agent,
                       tag="saving")
        if "ask_shop" in extra:
            other = self.agents.get(extra["ask_shop"])
            # The market nearest the shopper's home that is open when they get there; it must stay open for the shop.
            market = self.nearest(other, ("market",), origin=self.home_of(other)) if other and other.alive else None
            if (market and self._interruptible(other)
                    and not self._must_leave_for_work(other, market.id)
                    and self._fits_before_closing(market, ACTIVITIES["buy_groceries"].minutes,
                                                  self.walk_minutes(other, market.id))):
                payer = other if other.money >= GROCERY_COST else agent  # the asker covers it if the shopper can't
                payer.money -= GROCERY_COST
                other.plan = [("relax_home", "home")]
                other.usual_plan = True  # type: ignore[attr-defined]  # there and back the usual way
                self._start_step(other, "buy_groceries", market.id)  # started now so the paid shop happens
                self.event(f"{other.name} heads to {market.name} for {agent.name.split()[0]}.", other, tag="errand",
                           agents=[agent.id])
        if "call" in extra:
            other = self.agents.get(extra["call"])
            if other and other.alive:
                other.adjust("social", 15)
                self.event(f"{agent.name} calls {other.name}.", agent, tag="call", agents=[other.id])
        if extra.get("family"):
            where = extra.get("place") or "cafe"  # the family dinner's place
            family = []
            for m in self.household(agent).member_ids:
                other = self.agents[m]
                other.family_week = self.clock.day // 7  # type: ignore[attr-defined]  # this week's family evening
                if other is not agent and other.alive and self._interruptible(other):
                    other.plan = [("family_dinner", where)]
                    other.usual_plan = True  # type: ignore[attr-defined]
                    other.state = "idle"
                    family.append(other.id)
            place = self.town.places[where].name if where in self.town.places else where
            who = names([self.agents[m] for m in family]) if family else ""
            self.event(f"{agent.name} takes {who} out to dinner at {place}." if family else
                       f"{agent.name} goes out to dinner at {place}.", agent, tag="family_dinner", agents=family,
                       place=where)
        if "together" in extra:  # time at home together: the other joins in if free (FIXLISTS 5, 6)
            other = self.agents.get(extra["together"])
            if other and other.alive and other.inside == self.home_of(other) and self._interruptible(other):
                other.plan = [(opt.steps[-1][0], "home")]
                other.state = "idle"
        if extra.get("buy_goal") and agent.goal:  # bought outright (the cost paid the rest; FIXLISTS 13)
            self.event(f"{agent.name} finally buys {agent.goal['name']}!", agent, tag="goal_reached")
            agent.goal = None
        housing.apply_extra(self, agent, fork, opt)  # move, repair, works, belt_tighten, ... (P2)
        people.apply_extra(self, agent, fork, opt)  # life's forks' extras (people.HANDLERS)

    def _interruptible(self, other: Agent) -> bool:
        """Free to be asked along: idle or doing something leisurely, not asleep, working or deciding."""
        if other.state == "idle":
            return not other.plan
        return other.state == "busy" and other.activity in LEISURE and not self.on_shift_now(other)

    def _host_waits(self, host: Agent, guest: Agent, place_id: str) -> None:
        """An accepted invite: keep the host at the place until the guest has arrived and had some time."""
        if not host.alive:
            return
        hold = self.clock.tick + self.walk_minutes(guest, place_id) + 60
        if host.activity in MEET and host.activity_place == place_id:
            if host.state == "busy":
                host.busy_until = max(host.busy_until, hold)
            else:
                self._host_hold[host.id] = hold
        elif self._interruptible(host):
            host.plan = [("play" if self.town.places[place_id].kind == "park" else "hang_out", place_id)]
            host.usual_plan = True  # type: ignore[attr-defined]
            host.state = "idle"
            self._host_hold[host.id] = hold + self.walk_minutes(host, place_id)
            self.event(f"{host.name} heads to {self.town.places[place_id].name} to meet {guest.name.split()[0]}.",
                       host, tag="meetup", agents=[guest.id], place=place_id)

    # --- invites and messages ---------------------------------------------------

    def invite(self, host: Agent, guest_id: str, place_id: str) -> dict | None:
        if people.is_folk_id(getattr(host, "id", None)):
            return None  # townsfolk invite nobody through here
        if people.is_folk_id(guest_id):
            return social.invite_folk(self, host, guest_id, place_id)
        guest = self.agents.get(guest_id)
        if not host.alive or not guest or guest is host or not guest.alive or place_id not in self.town.places:
            return None
        self._invite_ids += 1
        inv = {"id": f"i{self._invite_ids}", "from": host.id, "to": guest_id, "place": place_id,
               "tick": self.clock.tick, "status": "pending"}
        self.invites[inv["id"]] = inv
        place = self.town.places[place_id].name
        self.event(f"{host.name} invites {guest.name} to {place}.", host, tag="invite", agents=[guest_id],
                   place=place_id)
        guest.inbox.append({"time": self.clock.stamp(), "from": host.id, "text": f"Want to meet at {place}?"})
        del guest.inbox[:-30]
        return inv

    def _expire_invites(self) -> None:
        for inv in list(self.invites.values()):
            if inv["status"] == "pending" and self.clock.tick - inv["tick"] > INVITE_MINUTES:
                inv["status"] = "expired"
            elif inv["status"] == "pending" and inv.get("host_goes"):
                host = people.person(self, inv["from"])
                if host is None or not host.alive or host.activity not in MEET or host.activity_place != inv["place"]:
                    inv["status"] = "expired"  # the host has already left
            if inv["status"] != "pending" and self.clock.tick - inv["tick"] > INVITE_MINUTES * 2:
                del self.invites[inv["id"]]

    def send_message(self, from_id: str, to_id: str, text: str) -> dict:
        a = self.agents.get(from_id)
        if a is not None and a.alive and people.is_folk_id(to_id):
            return social.message_folk(self, a, to_id, text)  # a text to a townsperson
        b = self.agents.get(to_id)
        if not a or not b or not a.alive or not b.alive:
            return {"ok": False, "error": "unknown or dead character"}
        if a is b:
            return {"ok": False, "error": "can't message yourself"}
        text = text[:500]
        b.inbox.append({"time": self.clock.stamp(), "from": a.id, "text": text})
        del b.inbox[:-30]
        a.adjust("social", 3)
        b.adjust("social", 3)
        self.event(f"{a.name} texts {b.name}: “{text[:80]}”", a, tag="text", agents=[b.id])
        self._deliver(b, {"type": "message", "from": a.id, "from_name": a.name, "to": b.id, "text": text,
                          "time": self.clock.stamp()})
        return {"ok": True}

    def _deliver(self, agent: Agent, msg: dict) -> None:
        if agent.controller:
            self.outbox.append((agent.controller, {**msg, "agent_id": agent.id}))

    # --- God's only power, and the character pages -----------------------------

    def set_luck(self, agent_id: str, luck: float) -> bool:
        if people.is_folk_id(agent_id):
            return bool(self.folk.set_luck(agent_id, max(0.0, min(100.0, float(luck)))))
        agent = self.agents.get(agent_id)
        if not agent:
            return False
        agent.luck = max(0.0, min(100.0, float(luck)))
        return True

    def luck_of(self, pid: str) -> float | None:
        """Anyone's Luck (named or townsperson), or None for an unknown id."""
        p = people.person(self, pid)
        return p.luck if p is not None else None

    def set_profile(self, agent_id: str, prompt: str | None = None, traits: dict | None = None) -> bool:
        agent = self.agents.get(agent_id)
        if not agent:
            return False
        # Convert every trait before changing any, so a bad value raises with the profile untouched.
        new = {t: round(max(0.0, min(1.0, float(v))), 3)
               for t, v in (traits if isinstance(traits, dict) else {}).items() if t in agent.profile.traits}
        agent.profile.traits.update(new)
        if isinstance(prompt, str) and prompt.strip():
            agent.profile.prompt = prompt.strip()[:1000]
            agent.profile.prompt_edited = True
        elif traits and not agent.profile.prompt_edited:
            agent.profile.prompt = agent.profile.describe(agent)
        return True

    # --- controllers ------------------------------------------------------------

    def claim(self, agent_id: str, controller: str) -> bool:
        agent = self.agents.get(agent_id)
        if not agent or not agent.alive or (agent.controller and agent.controller != controller):
            return False
        agent.controller = controller
        return True

    def release(self, controller: str, agent_id: str | None = None) -> list[str]:
        """Free a controller's characters (or just one); returns the ids it let go, in cast order."""
        freed = []
        for agent in self.agents.values():
            if agent.controller == controller and (agent_id is None or agent.id == agent_id):
                agent.controller = None
                freed.append(agent.id)
        if controller in self.controllers:
            self.controllers[controller]["characters"] = self._played_by(controller)
        return freed

    def _played_by(self, controller: str) -> list[str]:
        return [a.id for a in self.agents.values() if a.controller == controller]

    def controller_joined(self, name: str, model: str | None, ids: list[str]) -> dict | None:
        """A controller said hello (or claimed one more character): register it, and tell God in one event.

        `model` is what its hello declared (God-only); a later claim passes the model already registered.
        """
        entry = self.controllers.setdefault(name, {"model": None, "characters": []})
        if model is not None:
            entry["model"] = model
        entry["characters"] = self._played_by(name)
        if not ids:
            return None
        agent = self.agents.get(ids[0]) if len(ids) == 1 else None
        return self.event(f"{self._names(ids)} {'is' if len(ids) == 1 else 'are'} now played by {name}.", agent,
                          tag="controller_joined", agents=list(ids), remember=False)

    def controller_left(self, name: str, ids: list[str], release: bool = False) -> dict | None:
        """A controller let characters go: all of them when it disconnects (it leaves the registry), or one
        with a `release` message (importance 0)."""
        if release:
            if name in self.controllers:
                self.controllers[name]["characters"] = self._played_by(name)
        else:
            self.controllers.pop(name, None)
        if not ids:
            return None
        agent = self.agents.get(ids[0]) if len(ids) == 1 else None
        return self.event(f"{self._names(ids)} {'is' if len(ids) == 1 else 'are'} no longer played by {name}.",
                          agent, tag="controller_left", importance=0 if release else None, agents=list(ids),
                          remember=False)

    def _names(self, ids: list[str]) -> str:
        """Who an event names: "A", "A and B", "A, B and C", or "A, B, C and 57 others"."""
        names = [self.agents[i].name if i in self.agents else i for i in ids]
        if len(names) <= 2:
            return " and ".join(names)
        if len(names) == 3:
            return f"{names[0]}, {names[1]} and {names[2]}"
        return f"{', '.join(names[:3])} and {len(names) - 3} others"

    # --- snapshots ---------------------------------------------------------------

    def town_json(self) -> dict:
        """God's map, sent once in `welcome` (PLAN 3.2; in the region, region.md 8: RegionMap.map_json + v2's keys)."""
        return {**self.town.map_json(), "homes": housing.town_homes_json(self), "housing": housing.town_housing_json(),
                "stops": transit.stops_json(), "timetable": self.timetable()}

    def state_json(self, housing: bool = True) -> dict:
        """One `state` frame (PLAN 3.3); housing=False leaves out `lots` and `homes` (see housing_maps)."""
        state = {
            "tick": self.clock.tick, "time": self.clock.stamp(), "minute": self.clock.minute_of_day,
            "day": self.clock.day, "season": self.clock.season, "weather": self.weather,
            "lights": self.lights(), "plane": self.plane(), "buses": self.buses(),
            "agents": [{"id": a.id, "name": a.name, "x": a.x, "y": a.y, "inside": a.inside, "state": a.state,
                        "activity": a.activity, "vehicle": a.vehicle, "mood": round(a.mood), "luck": round(a.luck),
                        "controller": a.controller, "alive": a.alive, "age": a.age,
                        "home": self.households[a.household_id].home_id, "car": a.owns_car, "riding": a.riding,
                        "ill": life.ill(a), "stage": life.stage(a)}
                       for a in self.agents.values()],
            "trains": self.trains(), "crowd": self.folk.crowd(self), "folk_n": self.folk.n,
            "talks": social.talks_json(self),
        }
        if housing:
            state.update(self.housing_maps())
        return state

    def housing_maps(self) -> dict:
        """The state's `lots` and `homes` maps, which the server sends only when they change (and every 40th frame)."""
        return {"lots": housing.lots_json(self), "homes": housing.homes_json(self)}

    def agent_json(self, agent_id: str) -> dict | None:
        if people.is_folk_id(agent_id):
            return self.folk.page_json(self, agent_id)  # a townsperson's page (view.md 4.3)
        a = self.agents.get(agent_id)
        if not a:
            return None
        hh = self.household(a)
        return {
            "id": a.id, "kind": "named", "name": a.name, "age": a.age, "alive": a.alive, "state": a.state,
            "activity": a.activity, "place": a.activity_place, "inside": a.inside, "luck": round(a.luck, 1),
            "money": round(a.money, 2), "health": round(a.health, 1), "mood": round(a.mood),
            "reputation": round(a.reputation), "needs": {k: round(v, 1) for k, v in a.needs.items()},
            "job": a.job.to_json() if a.job else None, "controller": a.controller,
            "profile": {"prompt": a.profile.prompt, "traits": a.profile.traits, "edited": a.profile.prompt_edited,
                        "learned": a.profile.learned},
            **housing.agent_page_fields(self, a),
            "possessions": self.possessions(a),
            "relationships": {oid: people.rel_row(self, oid, r)
                              for oid, r in sorted(a.relationships.items(), key=lambda kv: -kv[1].affinity)},
            "memory": a.memory[-15:], "inbox": a.inbox[-10:], "forks": a.forks[-10:],
            "household": [self.agents[m].name for m in hh.member_ids],
            "life": life.page(self, a),
        }

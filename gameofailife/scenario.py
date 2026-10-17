"""A small starter town with three households. Edit freely or build your own."""

from __future__ import annotations

import random

from .agent import Agent, Household, Job, RelationKind
from .brain import UtilityBrain
from .sim import Simulation
from .world import City, Place, PlaceKind


def build_city() -> City:
    city = City("Millbrook")
    for place in [
        Place("home_cohen", "Cohen apartment", PlaceKind.HOME, 0.5, 0.5),
        Place("home_levi", "Levi house", PlaceKind.HOME, 3.5, 1.0),
        Place("home_ari", "Ari's studio", PlaceKind.HOME, 1.0, 3.0),
        Place("office_tech", "Brightline Tech", PlaceKind.OFFICE, 5.0, 4.0, hours=(7, 20)),
        Place("hospital", "City Hospital", PlaceKind.OFFICE, 2.5, 5.5),
        Place("school", "Millbrook School", PlaceKind.SCHOOL, 1.5, 1.5, hours=(7, 17)),
        Place("market", "Fresh Market", PlaceKind.SHOP, 2.0, 2.0, hours=(8, 21)),
        Place("cafe", "Corner Cafe", PlaceKind.CAFE, 2.5, 2.5, hours=(7, 23)),
        Place("park", "Riverside Park", PlaceKind.PARK, 3.0, 3.0),
    ]:
        city.add(place)
    return city


def build_simulation(seed: int = 7, verbose: bool = False) -> Simulation:
    rng = random.Random(seed)
    city = build_city()

    households = {
        "cohen": Household("cohen", "home_cohen", weekly_rent=420),
        "levi": Household("levi", "home_levi", weekly_rent=380),
        "ari": Household("ari", "home_ari", weekly_rent=260, groceries=3),
    }

    people = [
        Agent("dana", "Dana Cohen", 38, "cohen", "home_cohen", money=900,
              job=Job("software engineer", "office_tech", 55, 9, 17), owns_car=True,
              sociability=0.4, diligence=0.8, frugality=0.4),
        Agent("yossi", "Yossi Cohen", 40, "cohen", "home_cohen", money=600,
              job=Job("nurse", "hospital", 38, 7, 15, workdays=(0, 1, 2, 3, 6)),
              sociability=0.7, diligence=0.7, frugality=0.6),
        Agent("noa", "Noa Cohen", 10, "cohen", "home_cohen", money=20,
              job=Job("student", "school", 0, 8, 14), sociability=0.8, diligence=0.5),
        Agent("miriam", "Miriam Levi", 67, "levi", "home_levi", money=1500,
              sociability=0.6, diligence=0.3, frugality=0.8),
        Agent("tom", "Tom Levi", 29, "levi", "home_levi", money=250,
              job=Job("barista", "cafe", 18, 7, 14, workdays=(1, 2, 3, 4, 5)),
              sociability=0.9, diligence=0.4, frugality=0.2),
        Agent("ari", "Ari Ben-David", 24, "ari", "home_ari", money=120,
              job=Job("junior developer", "office_tech", 32, 10, 18),
              sociability=0.5, diligence=0.6, frugality=0.7),
    ]
    agents = {a.id: a for a in people}
    for a in people:
        households[a.household_id].member_ids.append(a.id)
        city.places[a.location_id].occupants.add(a.id)
        a.needs = {n: rng.uniform(55, 90) for n in a.needs}

    def link(a: str, b: str, kind_ab: RelationKind, kind_ba: RelationKind, affinity: float) -> None:
        agents[a].relate(b, kind_ab, affinity)
        agents[b].relate(a, kind_ba, affinity)

    link("dana", "yossi", RelationKind.PARTNER, RelationKind.PARTNER, 80)
    link("dana", "noa", RelationKind.CHILD, RelationKind.PARENT, 90)
    link("yossi", "noa", RelationKind.CHILD, RelationKind.PARENT, 85)
    link("miriam", "tom", RelationKind.CHILD, RelationKind.PARENT, 75)
    link("tom", "ari", RelationKind.FRIEND, RelationKind.FRIEND, 55)
    link("dana", "ari", RelationKind.COWORKER, RelationKind.COWORKER, 30)
    link("yossi", "miriam", RelationKind.FRIEND, RelationKind.FRIEND, 40)

    brains = {a.id: UtilityBrain(random.Random(rng.random())) for a in people}
    return Simulation(city, agents, households, brains, rng, verbose=verbose)

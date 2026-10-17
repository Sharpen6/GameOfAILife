"""The 60 people of Millbrook: the 20 named characters and 40 more generated from the seed.

The named 20 and the homes everyone starts in are the same for every seed; the seed picks the generated
people's names, ages, money, savings, cars, jobs, traits and goals. The draws come from one mulberry32
stream in a fixed order (see `build_cast`), so the JS port builds the same cast; `--seed 1` is canonical
Millbrook, pinned by tests/fixtures/city_seed1.json:

    python3 -m gameofailife.cast --dump 1 > tests/fixtures/city_seed1.json
"""

from __future__ import annotations

import collections
from typing import TYPE_CHECKING

from .agent import Agent, Household, Job, Profile, RelationKind
from .rng import Rng, r2

if TYPE_CHECKING:
    from .housing import Home
    from .town import TownMap

CAST_SIZE = 60


def job(title: str, place: str, wage: float, start: int, end: int, days=(0, 1, 2, 3, 4)) -> Job:
    return Job(title, place, wage, start, end, tuple(days))


NAMED = [
    # id, name, age, household, money, job, owns car
    ("dana", "Dana Cohen", 38, "cohen", 900, job("software engineer", "office", 55, 9, 17), True),
    ("yossi", "Yossi Cohen", 40, "cohen", 600, job("nurse", "hospital", 38, 7, 15, (0, 1, 2, 3, 6)), False),
    ("noa", "Noa Cohen", 10, "cohen", 20, job("student", "school", 0, 8, 14), False),
    ("miriam", "Miriam Levi", 67, "levi", 1500, None, False),
    ("tom", "Tom Levi", 29, "levi", 250, job("barista", "cafe", 18, 7, 14, (1, 2, 3, 4, 5)), False),
    ("ari", "Ari Ben-David", 24, "bendavid", 412, job("junior developer", "office", 32, 10, 18), False),
    ("avi", "Avi Mizrahi", 45, "mizrahi", 700, job("teacher", "school", 30, 8, 15), True),
    ("rina", "Rina Mizrahi", 43, "mizrahi", 1100, job("doctor", "hospital", 70, 8, 16), False),
    ("lior", "Lior Mizrahi", 16, "mizrahi", 60, job("student", "school", 0, 8, 15), False),
    ("maya", "Maya Mizrahi", 8, "mizrahi", 10, job("student", "school", 0, 8, 13), False),
    ("eli", "Eli Peretz", 33, "peretz", 300, job("cashier", "grocer", 17, 8, 16, (0, 1, 2, 4, 5)), False),
    ("shira", "Shira Peretz", 31, "peretz", 450, job("nurse", "hospital", 38, 14, 22), False),
    ("ruth", "Ruth Friedman", 72, "friedman", 2200, None, False),
    ("david", "David Friedman", 74, "friedman", 1800, None, True),
    ("omer", "Omer Katz", 36, "katz", 1300, job("product manager", "office", 60, 9, 18), True),
    ("gal", "Gal Katz", 35, "katz", 800, job("graphic designer", "office", 40, 10, 16), False),
    ("yael", "Yael Katz", 6, "katz", 5, job("student", "school", 0, 8, 13), False),
    ("nadia", "Nadia Haddad", 41, "haddad", 950, job("store manager", "market", 28, 7, 15, (0, 1, 2, 3, 4, 5)), False),
    ("sami", "Sami Haddad", 44, "haddad", 400, job("chef", "cafe", 24, 11, 20, (0, 2, 3, 4, 5)), False),
    ("leila", "Leila Haddad", 12, "haddad", 25, job("student", "school", 0, 8, 14), False),
]

# Named household -> home id. Tenure follows the home's start: let (rent) or owned.
NAMED_HOMES = {"cohen": "main_20", "levi": "main_28", "bendavid": "birch_court_2b", "mizrahi": "main_13",
               "peretz": "cedar_court_1b", "friedman": "park_78", "katz": "park_21", "haddad": "main_21"}

SAVINGS = {"dana": 15000, "yossi": 5000, "miriam": 2000, "tom": 0, "ari": 2500, "avi": 2500, "rina": 19000,
           "eli": 0, "shira": 1500, "ruth": 4000, "david": 2000, "omer": 5000, "gal": 1500, "nadia": 3000,
           "sami": 500}  # named adults' starting savings; children have none

FRIENDS = [("tom", "ari", 55), ("dana", "ari", 30), ("yossi", "miriam", 40), ("rina", "shira", 50),
           ("gal", "dana", 45), ("omer", "avi", 35), ("noa", "leila", 60), ("maya", "yael", 50),
           ("lior", "tom", 25), ("ruth", "miriam", 65), ("sami", "eli", 40), ("nadia", "rina", 30)]

GOALS = {"ari": ("a new phone", 300), "tom": ("a guitar", 450), "lior": ("a bike", 200),
         "eli": ("a weekend trip", 600), "gal": ("a drawing tablet", 350)}

GOAL_POOL = [("a new laptop", 500), ("a holiday", 800), ("a sofa", 400), ("driving lessons", 600),
             ("a bike", 250), ("a camera", 450), ("a games console", 350), ("a new coat", 200)]

SLOTS = {  # job slots for the generated workers, by wage band: (title, place, wage, start, end[, workdays])
    "low": [
        ("barista", "cafe", 18, 14, 22, (2, 3, 4, 5, 6)),
        ("counter assistant", "bakery", 16, 7, 14, (3, 4, 5, 6, 0)),
        ("waiter", "noodles", 16, 16, 23, (1, 2, 3, 4, 5)),
        ("cashier", "grocer", 16, 14, 22),
        ("cashier", "market", 17, 13, 21, (1, 2, 3, 4, 5)),
        ("shop assistant", "arcade", 17, 9, 17),
        ("shop assistant", "arcade", 17, 13, 21, (2, 3, 4, 5, 6)),
        ("hospital cleaner", "hospital", 16, 6, 14),
        ("warehouse worker", "works", 21, 6, 14),
        ("warehouse worker", "works", 21, 14, 22),
        ("packer", "works", 18, 8, 16),
        ("park keeper", "green", 19, 7, 15),
        ("receptionist", "office", 20, 8, 16),
    ],
    "mid": [
        ("cook", "noodles", 22, 15, 23, (1, 2, 3, 4, 5)),
        ("shopkeeper", "grocer", 24, 7, 15, (0, 1, 2, 3, 4, 5)),
        ("baker", "bakery", 22, 6, 14, (0, 1, 2, 3, 4, 5)),
        ("foreman", "works", 32, 7, 15),
        ("teacher", "school", 30, 8, 15),
        ("teacher", "school", 30, 8, 15),
        ("nurse", "hospital", 38, 7, 15),
        ("paramedic", "hospital", 30, 10, 18, (5, 6, 0, 1, 2)),
        ("clerk", "cityhall", 26, 8, 16),
        ("bank teller", "bank", 24, 9, 17),
        ("data analyst", "office", 42, 9, 17),
    ],
    "high": [
        ("surgeon", "hospital", 85, 8, 16, (0, 1, 2, 3)),
        ("branch manager", "bank", 55, 9, 17),
    ],
}

TEMPLATES = [  # generated households, in draw order: (home id, roles); adults are wage bands or "retired"
    ("birch_court_1a", ["retired"]), ("birch_court_1b", ["low", "low"]), ("birch_court_2a", ["low", "kid"]),
    ("birch_court_3a", ["low"]), ("birch_court_3b", ["mid"]), ("cedar_court_1a", ["low", "low"]),
    ("cedar_court_2a", ["low", "mid", "kid"]), ("cedar_court_2b", ["mid", "kid"]), ("cedar_court_3a", ["low"]),
    ("elm_court_1b", ["low"]), ("elm_court_2a", ["mid"]), ("elm_court_3b", ["low", "low", "kid"]),
    ("park_13", ["mid", "mid", "kid"]), ("park_29", ["mid", "low", "kid"]), ("main_12", ["retired", "retired"]),
    ("main_29", ["mid", "mid"]), ("river_20", ["mid", "kid", "kid"]), ("main_47", ["low", "mid", "retired"]),
    ("park_92", ["high", "high", "kid", "kid"]),
]

SURNAMES = ["Avraham", "Biton", "Dahan", "Golan", "Shapiro", "Azoulay", "Amar", "Ohana", "Weiss", "Rosen",
            "Klein", "Barak", "Sasson", "Nassar", "Khoury", "Mansour", "Elbaz", "Tal", "Carmel", "Navon",
            "Segal", "Halabi", "Ezra", "Gold"]
FEMALE = ["Adi", "Tamar", "Noga", "Hila", "Michal", "Yarden", "Shani", "Ronit", "Dalia", "Orly", "Sara", "Hana",
          "Rana", "Amira", "Lina", "Talia", "Inbal", "Keren", "Liat", "Efrat", "Mor", "Neta", "Yasmin", "Rotem",
          "Avigail", "Merav", "Sivan", "Galit", "Dina", "Lea"]
MALE = ["Itai", "Yoni", "Amir", "Nir", "Guy", "Ido", "Roee", "Eitan", "Uri", "Moshe", "Rami", "Karim", "Fadi",
        "Omar", "Ziv", "Erez", "Boaz", "Ronen", "Shai", "Gil", "Asaf", "Dror", "Yuval", "Noam", "Tomer",
        "Hadi", "Elad", "Yaniv", "Oren", "Ben"]

CAR_ODDS = {"flat": 0.15, "house": 0.5, "big_house": 1.0}  # a generated worker's chance of a car, by home tier
RETIREE_CAR = 0.4  # a generated retiree outside a flat
MONEY = {"low": (100, 400), "mid": (300, 1200), "high": (1500, 4000), "retired": (800, 3000), "kid": (0, 40)}
SAVINGS_RANGE = {"low": (0, 800), "mid": (500, 4000), "high": (8000, 20000), "retired": (1000, 6000)}
GOAL_CHANCE = 0.35  # a generated adult under 60 is saving for something


def _student_job(age: int) -> Job:
    return job("student", "school", 0, 8, 13 if age < 9 else 14 if age < 13 else 15)


def build_cast(town: TownMap, homes: dict[str, Home], seed: int) -> tuple[dict[str, Agent], dict[str, Household]]:
    """The people and households for a seed. Reads `homes` (it never changes them); `housing.init` moves
    everyone in. Everybody starts inside their home, at its entry.

    Draw order (the JS port makes the same draws in the same order), all from Rng(seed * 7919 + 1):
      1. Named people in NAMED order: 6 traits uniform(0.2, 0.8) in Profile.TRAITS order, then 4 needs
         uniform(60, 90) in NEEDS order.
      2. shuffle(SURNAMES).
      3. Generated households in TEMPLATES order: base age, adult ages, kid ages, first_female; then each member
         (adults, then kids): gender (members 2+), first name, money, savings (adults), car, traits, needs.
      4. Jobs: one jitter int(0, 8) per (worker, band, slot), then greedy matching and a swap pass (no draws).
      5. Relationships: coworkers int(15, 35), classmates int(30, 60), then a friend for every generated adult
         who has none: pick, then int(30, 60).
      6. Goals: random() < 0.35 for each generated adult under 60, then a pick from GOAL_POOL.
    """
    rng = Rng((seed * 7919 + 1) & 0xFFFFFFFF)
    agents: dict[str, Agent] = {}
    households: dict[str, Household] = {}

    def new_household(hid: str, home_id: str) -> None:
        home = homes[home_id]
        assert home.start in ("let", "owned"), (hid, home_id, home.start)
        households[hid] = Household(hid, home_id, float(home.rent) if home.start == "let" else 0.0)

    def make(aid: str, name: str, age: int, hid: str, money: float, savings: float, jb: Job | None,
             car: bool) -> Agent:
        place = town.places[homes[households[hid].home_id].place]
        traits = {t: r2(rng.uniform(0.2, 0.8)) for t in Profile.TRAITS}
        agent = Agent(id=aid, name=name, age=age, household_id=hid, money=float(money), job=jb, owns_car=car,
                      x=place.entry[0], y=place.entry[1], inside=place.id, profile=Profile(traits),
                      savings=float(savings))
        agent.needs = {n: rng.uniform(60, 90) for n in agent.needs}
        households[hid].member_ids.append(aid)
        agents[aid] = agent
        return agent

    # 1. The named 20, in households in order of first appearance.
    for aid, name, age, hid, money, jb, car in NAMED:
        if hid not in households:
            new_household(hid, NAMED_HOMES[hid])
        make(aid, name, age, hid, money, SAVINGS.get(aid, 0) if age >= 18 else 0, jb, car)
    named = set(agents)

    # 2-3. The generated households.
    surnames = list(SURNAMES)
    rng.shuffle(surnames)
    used = {a.name.split()[0] for a in agents.values()}

    def first_name(female: bool) -> str:
        pool = [n for n in (FEMALE if female else MALE) if n not in used] \
            or [n for n in (MALE if female else FEMALE) if n not in used]
        n = rng.pick(pool)
        used.add(n)
        return n

    workers: list[tuple[str, str, tuple[int, int]]] = []  # (agent id, band, home entry)
    for home_id, roles in TEMPLATES:
        surname = surnames.pop()
        hid = surname.lower()
        new_household(hid, home_id)
        home = homes[home_id]
        entry = town.places[home.place].entry
        adult_roles = [r for r in roles if r != "kid"]
        n_kids = roles.count("kid")
        all_retired = all(r == "retired" for r in adult_roles)
        base = rng.int(66, 80) if all_retired else rng.int(24 if n_kids == 0 else 30, 50)
        ages = []
        for i, role in enumerate(adult_roles):
            if role == "retired" and not all_retired:
                ages.append(rng.int(68, 82))
            else:
                ages.append(max(66 if all_retired else 20, base + (rng.int(-4, 4) if i else 0)))
        if n_kids:
            youngest = min(age for role, age in zip(adult_roles, ages) if role != "retired")
            ages += [rng.int(max(5, youngest - 42), min(17, youngest - 20)) for _ in range(n_kids)]
        first_female = rng.random() < 0.5
        for i, (role, age) in enumerate(zip(adult_roles + ["kid"] * n_kids, ages)):
            female = first_female if i == 0 else (not first_female) if i == 1 else rng.random() < 0.5
            name = f"{first_name(female)} {surname}"
            aid = name.split()[0].lower()
            money = rng.int(*MONEY[role])
            savings = rng.int(*SAVINGS_RANGE[role]) if role != "kid" else 0
            if role == "kid":
                jb, car = _student_job(age), False
            elif role == "retired":
                jb, car = None, home.tier != "flat" and rng.random() < RETIREE_CAR
            else:
                jb, car = None, rng.random() < CAR_ODDS[home.tier]
                workers.append((aid, role, entry))
            make(aid, name, age, hid, money, savings, jb, car)

    # 4. Jobs: nearest-first greedy matching with seeded jitter, then swaps that shorten the walks.
    pairs = []
    for aid, band, entry in workers:
        for sband in (("high",) if band == "high" else ("low", "mid")):
            for i, slot in enumerate(SLOTS[sband]):
                cost = town.walk_minutes(entry, slot[1]) + rng.int(0, 8) + (0 if sband == band else 20)
                pairs.append((cost, aid, sband, i))
    pairs.sort()
    taken, done = set(), set()
    for _, aid, sband, i in pairs:
        if aid not in done and (sband, i) not in taken:
            taken.add((sband, i))
            done.add(aid)
            agents[aid].job = job(*SLOTS[sband][i])
    entry_of = {aid: entry for aid, _, entry in workers}
    high = {aid for aid, band, _ in workers if band == "high"}

    def walk2(aid: str, jb: Job) -> int:
        return town.walk_minutes(entry_of[aid], jb.place_id) ** 2

    ids = [aid for aid, _, _ in workers]
    changed = True
    while changed:
        changed = False
        for i, a_id in enumerate(ids):
            for b_id in ids[i + 1:]:
                if (a_id in high) != (b_id in high):
                    continue
                a, b = agents[a_id], agents[b_id]
                if walk2(a_id, b.job) + walk2(b_id, a.job) < walk2(a_id, a.job) + walk2(b_id, b.job):
                    a.job, b.job = b.job, a.job
                    changed = True

    # 5. Relationships.
    for hh in households.values():
        members = [agents[m] for m in hh.member_ids]
        for a in members:
            for b in members:
                if a is not b:
                    partners = a.is_adult and b.is_adult and abs(a.age - b.age) < 10
                    a.relate(b.id, RelationKind.PARTNER if partners else RelationKind.FAMILY, 75)
    staff = collections.defaultdict(list)  # workplaces in order of their first paid worker
    for a in agents.values():
        if a.job and a.job.hourly_wage > 0:
            staff[a.job.place_id].append(a)
    for people in staff.values():
        for i, a in enumerate(people):
            for b in people[i + 1:]:
                if b.id not in a.relationships:
                    aff = rng.int(15, 35)
                    a.relate(b.id, RelationKind.COWORKER, aff)
                    b.relate(a.id, RelationKind.COWORKER, aff)
    students = sorted((a for a in agents.values() if a.job and a.job.place_id == "school" and a.job.hourly_wage == 0),
                      key=lambda a: (a.age, a.id))
    for a, b in zip(students, students[1:]):
        if a.household_id != b.household_id and b.id not in a.relationships:
            aff = rng.int(30, 60)
            a.relate(b.id, RelationKind.FRIEND, aff)
            b.relate(a.id, RelationKind.FRIEND, aff)
    for a_id, b_id, aff in FRIENDS:
        agents[a_id].relate(b_id, RelationKind.FRIEND, aff)
        agents[b_id].relate(a_id, RelationKind.FRIEND, aff)

    def district(agent: Agent) -> str:
        return town.places[homes[households[agent.household_id].home_id].place].district

    for a in [x for x in agents.values() if x.id not in named and x.is_adult]:
        if any(r.kind == RelationKind.FRIEND for r in a.relationships.values()):
            continue
        pool = sorted((b for b in agents.values() if b.is_adult and b.household_id != a.household_id
                       and abs(b.age - a.age) <= 8 and b.id not in a.relationships), key=lambda b: b.id)
        if pool:
            b = rng.pick([c for c in pool if district(c) == district(a)] or pool)
            aff = rng.int(30, 60)
            a.relate(b.id, RelationKind.FRIEND, aff)
            b.relate(a.id, RelationKind.FRIEND, aff)

    # 6. Goals and profiles.
    for aid, (goal, target) in GOALS.items():
        agents[aid].goal = {"name": goal, "target": target, "saved": 0.0}
    for a in agents.values():
        if a.id not in named and a.is_adult and a.age < 60 and rng.random() < GOAL_CHANCE:
            goal, target = rng.pick(GOAL_POOL)
            a.goal = {"name": goal, "target": target, "saved": 0.0}
        a.profile.prompt = a.profile.describe(a)
    assert len(agents) == CAST_SIZE, len(agents)
    return agents, households


# --- the golden file ------------------------------------------------------------

def golden(seed: int) -> dict:
    """The city for a seed as pinned by tests/fixtures/city_seed1.json."""
    import hashlib

    from .housing import HOME_SPECS, LOT_CONDITION, build_homes
    from .town import build_map

    town = build_map(seed)
    homes = build_homes(town)
    agents, households = build_cast(town, homes, seed)
    condition = dict(LOT_CONDITION)
    condition.update({place: c for _, place, _, _, _, _, _, _, c in HOME_SPECS if c is not None})
    return {
        "tiles_sha1": hashlib.sha1("\n".join(town.rows()).encode()).hexdigest(),
        "people": [{"id": a.id, "name": a.name, "age": a.age, "household": a.household_id,
                    "home": households[a.household_id].home_id, "job_place": a.job.place_id if a.job else None,
                    "title": a.job.title if a.job else None, "wage": a.job.hourly_wage if a.job else 0,
                    "car": a.owns_car, "money": round(a.money), "savings": round(a.savings)}
                   for a in agents.values()],
        "homes": [{"id": h.id, "tier": h.tier, "bedrooms": h.bedrooms, "base_value": h.base_value, "rent": h.rent,
                   "start": h.start, "condition": condition[h.place]} for h in homes.values()],
    }


def dump(seed: int) -> str:
    """The golden JSON text: one person or home per line."""
    import json

    data = golden(seed)
    row = lambda r: json.dumps(r, separators=(", ", ": "))  # noqa: E731
    lines = ["{", f' "tiles_sha1": {json.dumps(data["tiles_sha1"])},', ' "people": [']
    lines += [f"  {row(p)}," for p in data["people"]]
    lines[-1] = lines[-1].rstrip(",")
    lines += [" ],", ' "homes": [']
    lines += [f"  {row(h)}," for h in data["homes"]]
    lines[-1] = lines[-1].rstrip(",")
    lines += [" ]", "}"]
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> None:
    import argparse
    import sys

    ap = argparse.ArgumentParser(prog="python3 -m gameofailife.cast", description="Print the generated city.")
    ap.add_argument("--dump", type=int, metavar="SEED", required=True, help="write the golden JSON for SEED")
    args = ap.parse_args(argv)
    sys.stdout.write(dump(args.dump))


if __name__ == "__main__":
    main()

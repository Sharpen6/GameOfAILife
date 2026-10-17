"""The tile map and the generated starter town of about 20 characters."""

from __future__ import annotations

import random
from collections import deque
from dataclasses import dataclass, field

from .agent import Agent, Household, Job, Profile, RelationKind

W, H = 40, 25

# Tile codes shared with the web client.
GRASS, ROAD, BUILDING, DOOR, PARK, TREE, ENTRY = ".", "#", "B", "D", "P", "T", "e"
WALKABLE = {GRASS, ROAD, PARK, ENTRY}

ROAD_ROWS = (3, 12, 21)
ROAD_COLS = (3, 14, 25, 36)


@dataclass
class Place:
    id: str
    name: str
    kind: str  # home, office, school, hospital, market, cafe, park
    x: int
    y: int
    w: int
    h: int
    hours: tuple[int, int] | None = None  # open hour, close hour; None = always
    entry: tuple[int, int] = (0, 0)  # walkable tile where agents arrive

    def is_open(self, hour: float) -> bool:
        if self.hours is None:
            return True
        start, end = self.hours
        return start <= hour < end

    def to_json(self) -> dict:
        return {
            "id": self.id, "name": self.name, "kind": self.kind,
            "x": self.x, "y": self.y, "w": self.w, "h": self.h,
            "entry": list(self.entry), "hours": list(self.hours) if self.hours else None,
        }


@dataclass
class TownMap:
    tiles: list[list[str]]
    places: dict[str, Place] = field(default_factory=dict)

    def walkable(self, x: int, y: int) -> bool:
        return 0 <= x < W and 0 <= y < H and self.tiles[y][x] in WALKABLE

    def path(self, start: tuple[int, int], goal: tuple[int, int]) -> list[tuple[int, int]]:
        """Shortest walkable path from start to goal (excluding start), preferring roads on ties."""
        if start == goal:
            return []
        prev: dict[tuple[int, int], tuple[int, int] | None] = {start: None}
        off_road = {start: 0}  # fewest non-road tiles on a shortest path to each tile
        layer = [start]
        while layer and goal not in prev:
            ahead: dict[tuple[int, int], None] = {}  # one step further out, in the order found
            for cur in layer:
                x, y = cur
                for nxt in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                    if nxt in ahead:
                        if off_road[cur] < off_road[prev[nxt]]:
                            prev[nxt] = cur  # just as short, and more of it on the road
                    elif nxt not in prev and self.walkable(*nxt):
                        prev[nxt] = cur
                        ahead[nxt] = None
            for x, y in ahead:
                off_road[x, y] = off_road[prev[x, y]] + (self.tiles[y][x] != ROAD)
            layer = list(ahead)
        if goal not in prev:
            return []
        out = []
        node: tuple[int, int] | None = goal
        while node is not None and node != start:
            out.append(node)
            node = prev[node]
        return out[::-1]

    def rows(self) -> list[str]:
        return ["".join(r) for r in self.tiles]


def _building(tiles: list[list[str]], x: int, y: int, w: int, h: int) -> tuple[int, int]:
    """Stamp a building with a door in the middle of its bottom wall; return its entry tile."""
    for yy in range(y, y + h):
        for xx in range(x, x + w):
            tiles[yy][xx] = BUILDING
    door_x = x + w // 2
    tiles[y + h - 1][door_x] = DOOR
    tiles[y + h][door_x] = ENTRY
    return door_x, y + h


PLACE_SPECS = [
    # id, name, kind, x, y, w, h, hours
    ("home_cohen", "Cohen house", "home", 5, 4, 3, 3, None),
    ("home_levi", "Levi house", "home", 9, 4, 3, 3, None),
    ("home_bendavid", "Ari's flat", "home", 5, 8, 3, 3, None),
    ("home_mizrahi", "Mizrahi house", "home", 9, 8, 3, 3, None),
    ("home_peretz", "Peretz house", "home", 5, 13, 3, 3, None),
    ("home_friedman", "Friedman house", "home", 9, 13, 3, 3, None),
    ("home_katz", "Katz house", "home", 5, 17, 3, 3, None),
    ("home_haddad", "Haddad house", "home", 9, 17, 3, 3, None),
    ("office", "Brightline Tech", "office", 16, 5, 8, 5, (7, 20)),
    ("school", "Millbrook School", "school", 27, 5, 7, 5, (7, 17)),
    ("market", "Fresh Market", "market", 16, 14, 4, 3, (7, 21)),
    ("cafe", "Corner Cafe", "cafe", 21, 14, 3, 3, (6, 23)),
    ("hospital", "City Hospital", "hospital", 16, 18, 8, 3, None),
]


def build_map(seed: int) -> TownMap:
    rng = random.Random(seed)
    tiles = [[GRASS] * W for _ in range(H)]
    for y in ROAD_ROWS:
        for x in range(W):
            tiles[y][x] = ROAD
    for x in ROAD_COLS:
        for y in range(H):
            tiles[y][x] = ROAD

    town = TownMap(tiles)
    for pid, name, kind, x, y, w, h, hours in PLACE_SPECS:
        entry = _building(tiles, x, y, w, h)
        town.places[pid] = Place(pid, name, kind, x, y, w, h, hours, entry)

    # Riverside Park fills the south-east block, with a scatter of trees.
    px, py, pw, ph = 26, 13, 10, 8
    for yy in range(py, py + ph):
        for xx in range(px, px + pw):
            tiles[yy][xx] = PARK
    town.places["park"] = Place("park", "Riverside Park", "park", px, py, pw, ph, None, (30, 16))
    for _ in range(14):
        tx, ty = rng.randrange(px, px + pw), rng.randrange(py, py + ph)
        if (tx, ty) != (30, 16):
            tiles[ty][tx] = TREE
            if not all(_reaches_road(town, p.entry) for p in town.places.values()):
                tiles[ty][tx] = PARK  # never wall in a place's entry
    return town


def _reaches_road(town: TownMap, start: tuple[int, int]) -> bool:
    """True when a walk from `start` gets to the road, and so to every other place."""
    seen, queue = {start}, deque([start])
    while queue:
        x, y = queue.popleft()
        if town.tiles[y][x] == ROAD:
            return True
        for nxt in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if nxt not in seen and town.walkable(*nxt):
                seen.add(nxt)
                queue.append(nxt)
    return False


# --- the starter cast ---------------------------------------------------------

def _job(title: str, place: str, wage: float, start: int, end: int, days=(0, 1, 2, 3, 4)) -> Job:
    return Job(title, place, wage, start, end, tuple(days))


CAST = [
    # id, name, age, household, money, job, owns car
    ("dana", "Dana Cohen", 38, "cohen", 900, _job("software engineer", "office", 55, 9, 17), True),
    ("yossi", "Yossi Cohen", 40, "cohen", 600, _job("nurse", "hospital", 38, 7, 15, (0, 1, 2, 3, 6)), False),
    ("noa", "Noa Cohen", 10, "cohen", 20, _job("student", "school", 0, 8, 14), False),
    ("miriam", "Miriam Levi", 67, "levi", 1500, None, False),
    ("tom", "Tom Levi", 29, "levi", 250, _job("barista", "cafe", 18, 7, 14, (1, 2, 3, 4, 5)), False),
    ("ari", "Ari Ben-David", 24, "bendavid", 412, _job("junior developer", "office", 32, 10, 18), False),
    ("avi", "Avi Mizrahi", 45, "mizrahi", 700, _job("teacher", "school", 30, 8, 15), True),
    ("rina", "Rina Mizrahi", 43, "mizrahi", 1100, _job("doctor", "hospital", 70, 8, 16), False),
    ("lior", "Lior Mizrahi", 16, "mizrahi", 60, _job("student", "school", 0, 8, 15), False),
    ("maya", "Maya Mizrahi", 8, "mizrahi", 10, _job("student", "school", 0, 8, 13), False),
    ("eli", "Eli Peretz", 33, "peretz", 300, _job("cashier", "market", 17, 8, 16, (0, 1, 2, 4, 5)), False),
    ("shira", "Shira Peretz", 31, "peretz", 450, _job("nurse", "hospital", 38, 14, 22), False),
    ("ruth", "Ruth Friedman", 72, "friedman", 2200, None, False),
    ("david", "David Friedman", 74, "friedman", 1800, None, True),
    ("omer", "Omer Katz", 36, "katz", 1300, _job("product manager", "office", 60, 9, 18), True),
    ("gal", "Gal Katz", 35, "katz", 800, _job("graphic designer", "office", 40, 10, 16), False),
    ("yael", "Yael Katz", 6, "katz", 5, _job("student", "school", 0, 8, 13), False),
    ("nadia", "Nadia Haddad", 41, "haddad", 950, _job("store manager", "market", 28, 7, 15, (0, 1, 2, 3, 4, 5)), False),
    ("sami", "Sami Haddad", 44, "haddad", 400, _job("chef", "cafe", 24, 11, 20, (0, 2, 3, 4, 5)), False),
    ("leila", "Leila Haddad", 12, "haddad", 25, _job("student", "school", 0, 8, 14), False),
]

RENT = {"cohen": 420, "levi": 380, "bendavid": 260, "mizrahi": 520,
        "peretz": 330, "friedman": 300, "katz": 480, "haddad": 410}

FRIENDS = [("tom", "ari", 55), ("dana", "ari", 30), ("yossi", "miriam", 40), ("rina", "shira", 50),
           ("gal", "dana", 45), ("omer", "avi", 35), ("noa", "leila", 60), ("maya", "yael", 50),
           ("lior", "tom", 25), ("ruth", "miriam", 65), ("sami", "eli", 40), ("nadia", "rina", 30)]

GOALS = {"ari": ("a new phone", 300), "tom": ("a guitar", 450), "lior": ("a bike", 200),
         "eli": ("a weekend trip", 600), "gal": ("a drawing tablet", 350)}


def build_cast(town: TownMap, seed: int) -> tuple[dict[str, Agent], dict[str, Household]]:
    rng = random.Random(seed * 7919 + 1)
    households: dict[str, Household] = {}
    agents: dict[str, Agent] = {}
    for hid, rent in RENT.items():
        households[hid] = Household(hid, f"home_{hid}", rent)

    for aid, name, age, hid, money, job, car in CAST:
        home = town.places[f"home_{hid}"]
        traits = {t: round(rng.uniform(0.2, 0.8), 2) for t in Profile.TRAITS}
        agent = Agent(
            id=aid, name=name, age=age, household_id=hid, money=float(money), job=job,
            owns_car=car, x=home.entry[0], y=home.entry[1], inside=home.id,
            profile=Profile(traits),
        )
        agent.needs = {n: rng.uniform(60, 90) for n in agent.needs}
        if aid in GOALS:
            agent.goal = {"name": GOALS[aid][0], "target": GOALS[aid][1], "saved": 0.0}
        agent.profile.prompt = agent.profile.describe(agent)
        agents[aid] = agent
        households[hid].member_ids.append(aid)

    for hh in households.values():
        members = [agents[m] for m in hh.member_ids]
        for a in members:
            for b in members:
                if a is b:
                    continue
                if a.age >= 18 and b.age >= 18:
                    kind = RelationKind.PARTNER if abs(a.age - b.age) < 10 else RelationKind.FAMILY
                else:
                    kind = RelationKind.FAMILY
                a.relate(b.id, kind, 75)
    for a, b, aff in FRIENDS:
        agents[a].relate(b, RelationKind.FRIEND, aff)
        agents[b].relate(a, RelationKind.FRIEND, aff)
    return agents, households

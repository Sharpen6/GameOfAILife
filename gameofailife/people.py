"""The one person contract (life.md 3.2, PLAN 2.2): both tiers, the 60 named and the townsfolk.

Every rule that can meet a townsperson looks people up here, so a folk id ("f17") and a named id ("dana") are
handled alike. Until the townsfolk land, `sim.folk` is a `NoFolk`: no one, every call a no-op.
"""

from __future__ import annotations

from collections import deque


def is_folk_id(x) -> bool:
    """A townsperson's id: "f" followed by digits. Named ids hold no digits."""
    return isinstance(x, str) and len(x) > 1 and x[0] == "f" and x[1:].isdigit()


def folk_index(pid: str) -> int:
    """The index in `Folk.people` of a townsperson's id ("f17" -> 17)."""
    return int(pid[1:])


class NoFolk:
    """`sim.folk` while there are no townsfolk (folk 0): every method of PLAN 2.3 as a no-op."""

    n = 0
    isolated = False
    v = 0

    def __init__(self) -> None:
        self.luck_log = deque(maxlen=5000)

    def person(self, pid):
        return None

    get = person

    def living(self) -> list:
        return []

    def present(self, place_id) -> list:
        return []

    def crowd(self, sim) -> list:
        return []

    def occ(self) -> list:
        return []

    def riders(self, tick) -> dict:
        return {}

    def commute_minutes(self, p, place_id):
        return None

    def tick(self, sim) -> None:
        pass

    def nightly(self, sim) -> None:
        pass

    def pensions(self, sim) -> None:
        pass

    def weekly(self, sim) -> None:
        pass

    def stats_json(self, sim):
        return None

    def city_parts(self, sim) -> dict:
        return {}

    def sample_hour(self, sim) -> None:
        pass

    def roster_rows(self, sim) -> list:
        return []

    def page_json(self, sim, fid):
        return None

    def set_luck(self, fid, luck) -> bool:
        return False

    def worth(self, sim, p) -> int:
        return 0

    def household(self, hid):
        return None

    def new_household(self, member_ids, home_id, how):
        return None

    def on_household_empty(self, hh) -> None:
        pass


def make_folk(sim, n: int, isolated: bool = False):
    """`sim.folk`: a `NoFolk` for n 0, else the townsfolk (`folk.Folk`, imported lazily)."""
    if not n:
        return NoFolk()
    from .folk import Folk  # lazy: folk imports people
    return Folk(sim, n, isolated)

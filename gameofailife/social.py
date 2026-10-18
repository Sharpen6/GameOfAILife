"""Social life for both tiers (life.md 5.1-5.4): talk in rooms, friends, rivals, romance, texts and invites to
townsfolk, lending, incidents, upkeep. Stub (v3-skel-people): final signatures, no behaviour yet."""

from __future__ import annotations

from collections import deque


class SocialState:
    """`sim.social`: `buckets` (10 lists of place ids), `talks` (deque 40 of (tick, a, b, tone, place)),
    `folk_invites` ("fi<n>" -> record)."""

    def __init__(self) -> None:
        self.buckets = [[] for _ in range(10)]
        self.talks = deque(maxlen=40)
        self.folk_invites = {}


def init(sim) -> None:
    sim.social = SocialState()


def tick(sim) -> None:
    pass


def on_affinity(sim, a_id, b_id, before, after) -> None:
    pass


def talks_json(sim) -> list:
    return []


def message_folk(sim, a, fid, text) -> dict:
    return {"ok": False, "error": "unknown or dead character"}


def invite_folk(sim, host, guest_id, place_id):
    return None


def pick_companion(sim, p, why):
    return None


def seed_story(sim) -> None:
    pass

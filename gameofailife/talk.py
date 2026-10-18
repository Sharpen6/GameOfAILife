"""What people say (life.md 5.2), pure: a topic, an opener and a reply, a text's answer. Stub (v3-skel-people)."""

from __future__ import annotations


def topic(ctx, u) -> str:
    return "weather"


def line(topic, tone, ctx, rng) -> str:
    return ""


def reply(affinity, mood, rng) -> str:
    return "Thanks!"

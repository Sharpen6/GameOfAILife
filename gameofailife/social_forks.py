"""The eight social forks of the named (life.md 6): crush, asked_out, date, move_in, propose / proposal,
relationship_trouble, partner_split and friend_in_need. Each has exactly four distinct options and is major.

social.py queues them with `people.prompt`; `people.pending_fork` builds them through PROMPTS (here) when the
character is free. An option's `extra["life"]` ({"act", "with", ...}) goes to HANDLERS[fork.kind]; the outcome keys
`life_rel` ([other id, d]: the other's affinity toward the character by d, the character's by d / 2) and `life_rom`
([other id, d]: both sides' romance) go to EFFECTS. Odds stay hidden: no label or `about` line shows one.
"""

from __future__ import annotations

from . import people, social
from .forks import Fork, Option, Outcome

DAY = 24 * 60
KINDS = ("crush", "asked_out", "date", "move_in", "propose", "proposal", "relationship_trouble", "partner_split",
         "friend_in_need")
STAY = [("idle", None)]  # a decision that keeps the character where they are for a moment


def _first(p) -> str:
    return p.name.split()[0]


def _other(sim, agent, ctx):
    q = people.person(sim, ctx.get("with"))
    if q is None or not q.alive or q is agent:
        return None
    return q


def about(sim, agent, q) -> list:
    """Fork.about: who the other is, and how the two stand (no odds)."""
    job = q.job
    if job is None:
        role = "retired" if q.age >= 60 else "not working"
    elif job.title == "student":
        role = "at school"
    else:
        place = sim.town.places.get(job.place_id)
        role = f"{job.title} at {place.name}" if place is not None else job.title
    lines = [f"{q.name}, {q.age}, {role}."]
    r = agent.relationships.get(q.id)
    if r is not None:
        days = max(0, (sim.clock.tick - r.since) // DAY)
        pron = "her" if people.sex(q) == "f" else "him"
        feel = "like" if r.affinity >= 0 else "don't like"
        if r.kind.value in ("dating", "partner"):
            lines.append(f"Together {days} days; you have talked {r.talks} times, and {feel} {pron} "
                         f"({round(r.affinity)}).")
        else:
            lines.append(f"You met {days} days ago, have talked {r.talks} times, and {feel} {pron} "
                         f"({round(r.affinity)}).")
    return lines


# The hidden aftertaste of each option that has no outcome of its own, by fork kind and option index (Luck shifts it
# like any other outcome): (id, label, p, valence, effects); "life_rel"/"life_rom" values are bumps with the other one.
MOODS = {
    "crush": [("nervous_ask", "Nervous, but glad they asked", 0.5, +1, {"fun": 5}), None,
              ("daydream", "A pleasant daydream", 0.5, +1, {"fun": 3}),
              ("lets_go", "Letting go feels lighter", 0.4, +1, {"fun": 4})],
    "asked_out": [("excited", "Excited about Friday", 0.6, +1, {"fun": 8}),
                  ("nice_coffee", "A nice easy coffee", 0.5, +1, {"life_rel": 3}),
                  ("still_friends", "Still friends, no hard feelings", 0.5, +1, {"life_rel": 2}),
                  ("guilty", "Feels a little guilty", 0.4, -1, {"fun": -4})],
    "date": [("good_food", "The food is good", 0.5, +1, {"fun": 6}),
             ("understanding", "They understand", 0.5, +1, {"life_rel": 1}),
             ("quiet_night", "A quiet night in", 0.5, +1, {"energy": 6}),
             ("relief", "Relieved it's over", 0.4, 0, {"fun": -5})],
    "move_in": [("happy_news", "Happy news", 0.5, +1, {"life_rom": 3}),
                ("warm_welcome", "A warm welcome", 0.5, +1, {"life_rom": 3}),
                ("house_hunting", "House hunting is fun", 0.5, +1, {"fun": 6}),
                ("disappointed", "They seem disappointed", 0.4, -1, {"life_rel": -3})],
    "propose": [("ring_fits", "The ring fits", 0.6, +1, {"fun": 10}),
                ("sweet_moment", "A sweet moment", 0.6, +1, {"fun": 8}),
                ("doubts", "Doubts creep in", 0.4, -1, {"fun": -3}),
                ("relieved", "Relieved to have decided", 0.4, 0, {"fun": 2})],
    "proposal": [("overjoyed", "Overjoyed", 0.6, +1, {"fun": 10}),
                 ("planning", "Starts planning", 0.5, +1, {"fun": 6}),
                 ("hurt", "They look hurt", 0.5, -1, {"life_rel": -3}),
                 ("tears", "Tears all round", 0.5, -1, {"fun": -8})],
    "relationship_trouble": [None, None, ("clear_head", "A clearer head", 0.5, +1, {"energy": 5}),
                             ("hard_end", "Ending it is hard", 0.5, -1, {"fun": -8})],
    "partner_split": [("amicable", "It ends amicably", 0.5, +1, {"life_rel": 5}), None, None,
                      ("regret", "Regrets storming out", 0.5, -1, {"fun": -6})],
    "friend_in_need": [("grateful", "They are grateful", 0.6, +1, {"life_rel": 3}),
                       ("grateful_half", "They are grateful for the help", 0.6, +1, {"life_rel": 2}),
                       ("touched", "They are touched", 0.6, +1, {"life_rel": 4}),
                       ("awkward_refusal", "An awkward moment", 0.5, -1, {"life_rel": -2})],
}


def _moods(kind, opts, q) -> None:
    for opt, mood in zip(opts, MOODS.get(kind, [])):
        if mood is None or opt.outcomes:
            continue
        oid, label, p, valence, effects = mood
        eff = {k: ([q.id, v] if k in ("life_rel", "life_rom") else v) for k, v in effects.items()}
        opt.outcomes = [Outcome(oid, label, p, valence, eff)]


def _fork(sim, agent, kind, question, opts, q) -> Fork:
    _moods(kind, opts, q)
    fork = Fork(agent.id, kind, question, opts, sim.clock.tick)
    fork.major = True
    fork.about = about(sim, agent, q)
    return fork


def _life(act, q, **more) -> dict:
    out = {"act": act, "with": q.id}
    out.update(more)
    return {"life": out}


def _rel(sim, agent, q):
    return agent.relationships.get(q.id)


# --- the builders -------------------------------------------------------------------------------------------------

def crush_fork(sim, agent, ctx):
    q = _other(sim, agent, ctx)
    r = _rel(sim, agent, q) if q is not None else None
    if q is None or r is None or social.partner_of(sim, agent) is not None or social.partner_of(sim, q) is not None:
        return None
    x = _first(q)
    keen = 0.01 * (r.romance - 30) + 0.005 * (r.affinity - 20)
    opts = [
        Option(f"Ask {x} out to dinner", [("phone_call", None)], tags={"social": 0.6, "adventure": 0.7},
               gains={"social": 10}, base=0.1 + keen, extra=_life("ask", q)),
        Option(f"Text {x} something flirty", [("text", None)], tags={"social": 0.5, "adventure": 0.3},
               gains={"social": 8}, base=0.05 + keen / 2,
               outcomes=[Outcome("flirty_reply", f"{x} texts back with a smile", 0.75, +1,
                                 {"life_rel": [q.id, 8], "life_rom": [q.id, 4]}, group="text"),
                         Outcome("awkward_text", "The text lands awkwardly", 0.25, -1, {"life_rel": [q.id, -10]},
                                 group="text")]),
        Option("Wait and see", STAY, tags={"adventure": -0.4, "thrift": 0.1}, base=0.05),
        Option("Let it go", STAY, tags={"adventure": -0.6, "family": 0.2}, base=-0.05, extra=_life("let_go", q)),
    ]
    return _fork(sim, agent, "crush", f"You can't stop thinking about {x}.", opts, q)


def asked_out_fork(sim, agent, ctx):
    q = _other(sim, agent, ctx)
    if q is None or social.partner_of(sim, agent) is not None or social.partner_of(sim, q) is not None:
        return None
    r = _rel(sim, agent, q)
    aff, rom = (r.affinity, r.romance) if r is not None else (0.0, 0.0)
    x = _first(q)
    keen = 0.01 * (aff - 20) + 0.01 * rom
    cafe = sim.nearest(agent, ("cafe",), stay=60)
    coffee = [("hang_out", cafe.id)] if cafe is not None else [("text", None)]
    opts = [
        Option("Say yes", [("text", None)], tags={"social": 0.6, "adventure": 0.5}, gains={"social": 10},
               base=keen, extra=_life("yes", q)),
        Option("Suggest a coffee instead", coffee, cost=4 if cafe is not None else 0,
               tags={"social": 0.4, "adventure": -0.1, "thrift": 0.1}, gains={"social": 20}, base=keen / 2 + 0.05,
               extra=_life("coffee", q, place=cafe.id if cafe is not None else None)),
        Option("Rather stay friends", [("text", None)], tags={"family": 0.1, "adventure": -0.3}, base=0.15 - keen / 2,
               extra=_life("friends", q)),
        Option(f"Turn {x} down flat", STAY, tags={"social": -0.5}, base=-0.2 - keen, extra=_life("flat", q)),
    ]
    return _fork(sim, agent, "asked_out", f"{x} asks you out on Friday.", opts, q)


def date_fork(sim, agent, ctx):
    q = _other(sim, agent, ctx)
    r = _rel(sim, agent, q) if q is not None else None
    place = sim.town.places.get(ctx.get("place") or "")
    if q is None or r is None or r.kind.value != "dating" or place is None:
        return None
    x = _first(q)
    keen = 0.01 * (r.romance - 40)
    opts = [
        Option("Go", [("hang_out", place.id)], cost=20, tags={"social": 0.7, "adventure": 0.3, "thrift": -0.2},
               gains={"social": 40, "fun": 25}, base=0.2 + keen, extra=_life("go", q, place=place.id)),
        Option("Coffee tomorrow instead", [("text", None)], tags={"thrift": 0.3, "diligence": 0.2}, base=0.0,
               extra=_life("later", q)),
        Option("Not tonight", STAY, tags={"social": -0.4, "thrift": 0.2}, base=-0.1, extra=_life("no", q)),
        Option("End it", STAY, tags={"adventure": 0.2, "family": -0.2}, base=-0.4 - keen, extra=_life("end", q)),
    ]
    return _fork(sim, agent, "date", f"{x} suggests dinner at {place.name} at 19:00.", opts, q)


def move_in_fork(sim, agent, ctx):
    q = _other(sim, agent, ctx)
    r = _rel(sim, agent, q) if q is not None else None
    if q is None or r is None or r.kind.value != "dating" or not people.is_named(q):
        return None
    x = _first(q)
    weeks = max(1, (sim.clock.tick - r.since) // (7 * DAY))
    mine = len(people.members(sim, agent))
    theirs = len(people.members(sim, q))
    opts = [
        Option(f"Ask {x} to move in", STAY, tags={"family": 0.7, "adventure": 0.3}, base=0.15 + 0.05 * (theirs - mine),
               extra=_life("host", q)),
        Option(f"Move into {x}'s place", STAY, tags={"family": 0.6, "adventure": 0.5},
               base=0.15 + 0.05 * (mine - theirs), extra=_life("join", q)),
        Option("Look for a place together", STAY, tags={"adventure": 0.7, "thrift": -0.4}, base=0.0,
               extra=_life("together", q)),
        Option("Not yet", STAY, tags={"adventure": -0.5, "thrift": 0.2}, base=0.05, extra=_life("wait", q)),
    ]
    return _fork(sim, agent, "move_in", f"Seeing {x} {weeks} weeks. Move in?", opts, q)


def propose_fork(sim, agent, ctx):
    q = _other(sim, agent, ctx)
    r = _rel(sim, agent, q) if q is not None else None
    if q is None or r is None or r.kind.value != "partner" or r.married:
        return None
    x = _first(q)
    opts = [
        Option("Propose with a ring ($1,200)", STAY, cost=1200, tags={"family": 0.8, "thrift": -0.6},
               gains={"fun": 20}, base=0.1, extra=_life("propose", q, ring=True)),
        Option("Propose simply", STAY, tags={"family": 0.7, "thrift": 0.4}, gains={"fun": 15}, base=0.1,
               extra=_life("propose", q, ring=False)),
        Option("Wait a while", STAY, tags={"adventure": -0.3}, base=0.05, extra=_life("wait", q)),
        Option("Rather not", STAY, tags={"family": -0.6, "adventure": 0.2}, base=-0.1, extra=_life("never", q)),
    ]
    return _fork(sim, agent, "propose", f"Propose to {x}?", opts, q)


def proposal_fork(sim, agent, ctx):
    q = _other(sim, agent, ctx)
    r = _rel(sim, agent, q) if q is not None else None
    if q is None or r is None or r.kind.value != "partner" or r.married:
        return None
    x = _first(q)
    keen = 0.01 * (r.romance - 50) + 0.005 * (r.affinity - 50)
    opts = [
        Option("Yes!", STAY, tags={"family": 0.8, "adventure": 0.3}, gains={"fun": 30}, base=0.2 + keen,
               extra=_life("yes", q)),
        Option("Yes, but a long engagement", STAY, tags={"family": 0.5, "thrift": 0.3}, gains={"fun": 20},
               base=0.1 + keen / 2, extra=_life("long", q)),
        Option("Not yet", STAY, tags={"adventure": -0.4}, base=0.0, extra=_life("not_yet", q)),
        Option("No", STAY, tags={"family": -0.7}, base=-0.3 - keen, extra=_life("no", q)),
    ]
    return _fork(sim, agent, "proposal", f"{x} proposes!", opts, q)


def relationship_trouble_fork(sim, agent, ctx):
    q = _other(sim, agent, ctx)
    r = _rel(sim, agent, q) if q is not None else None
    if q is None or r is None or r.kind.value not in ("dating", "partner"):
        return None
    x = _first(q)
    opts = [
        Option("Talk it through", [("phone_call", None)], tags={"family": 0.5, "social": 0.4}, base=0.15,
               outcomes=[Outcome("talked_out", f"They talk it through with {x}", 0.55, +1, {"life_rel": [q.id, 6]},
                                 group="talk"),
                         Outcome("talk_row", "It turns into a row", 0.25, -1, {"life_rel": [q.id, -6]},
                                 group="talk")]),
        Option("Plan a special evening ($80)", STAY, cost=80, tags={"family": 0.6, "thrift": -0.5}, gains={"fun": 15},
               base=0.1, outcomes=[Outcome("special_evening", "A lovely evening together", 0.6, +1,
                                           {"life_rel": [q.id, 8], "life_rom": [q.id, 5]})]),
        Option("Take a week's space", STAY, tags={"social": -0.4, "adventure": -0.2}, base=0.0,
               extra=_life("space", q)),
        Option("End it", STAY, tags={"adventure": 0.4, "family": -0.4}, base=-0.2 + 0.01 * (20 - r.affinity),
               extra=_life("end", q)),
    ]
    return _fork(sim, agent, "relationship_trouble", f"Things with {x} have been rocky.", opts, q)


def partner_split_fork(sim, agent, ctx):
    q = _other(sim, agent, ctx)
    r = _rel(sim, agent, q) if q is not None else None
    if q is None or r is None or r.kind.value != "partner":
        return None
    x = _first(q)
    opts = [
        Option("Agree calmly", STAY, tags={"diligence": 0.3, "adventure": 0.2}, base=0.1, extra=_life("agree", q)),
        Option("Try counselling ($320)", STAY, cost=320, tags={"family": 0.8, "thrift": -0.4}, base=0.05,
               outcomes=[Outcome("counselling_helps", "Counselling helps", 0.45, +1, {"life_rel": [q.id, 15]})]),
        Option(f"Plead with {x}", STAY, tags={"family": 0.6, "social": 0.3}, base=0.0,
               outcomes=[Outcome("plea_works", f"{x} agrees to try again", 0.25, +1, {"life_rel": [q.id, 12]})]),
        Option("Storm out", STAY, tags={"family": -0.5, "adventure": 0.4}, base=-0.3, extra=_life("storm", q)),
    ]
    return _fork(sim, agent, "partner_split", f"{x} wants to split up.", opts, q)


def friend_in_need_fork(sim, agent, ctx):
    q = _other(sim, agent, ctx)
    if q is None:
        return None
    a = int(ctx.get("amount") or 0)
    if a <= 0 or q.money >= -200:
        return None
    half, quarter = a // 2, a // 4
    r = _rel(sim, agent, q)
    warm = 0.005 * ((r.affinity if r is not None else 0) - 50)
    x = _first(q)
    opts = [
        Option(f"Lend ${a:,}", STAY, cost=a, charge=False, tags={"social": 0.6, "family": 0.4, "thrift": -0.6},
               base=0.1 + warm, extra=_life("lend", q, amount=a)),
        Option(f"Lend half (${half:,})", STAY, cost=half, charge=False, tags={"social": 0.4, "thrift": -0.2},
               base=0.1 + warm / 2, extra=_life("lend", q, amount=half)),
        Option(f"Give ${quarter:,}, no strings", STAY, cost=quarter, charge=False,
               tags={"social": 0.5, "family": 0.3, "thrift": -0.3}, base=0.0, extra=_life("give", q, amount=quarter)),
        Option("Say you can't help", STAY, tags={"thrift": 0.8, "social": -0.3}, base=-0.05, extra=_life("no", q)),
    ]
    return _fork(sim, agent, "friend_in_need", f"{x} asks to borrow ${a:,}.", opts, q)


# --- what the choices do -----------------------------------------------------------------------------------------

def _q(sim, value):
    q = people.person(sim, value.get("with"))
    return q if q is not None and q.alive else None


def _crush(sim, agent, fork, opt, value) -> None:
    q = _q(sim, value)
    if q is None:
        return
    if value["act"] == "ask":
        sim.event(f"{agent.name} asks {q.name} out to dinner.", agent, tag="flirt", importance=1, agents=[q.id])
        if people.is_named(q):
            day = sim.clock.day
            if people.prompt(sim, q, "asked_out", {"with": agent.id}):
                social._set_cool(q, "asked_out", day)
        else:
            if not social.folk_answer(sim, agent, q):
                sim.event(f"{q.name} turns {agent.name.split()[0]} down.", agent, tag="flirt", agents=[q.id])
    elif value["act"] == "let_go":
        r = agent.relationships.get(q.id)
        if r is not None:
            r.romance = min(r.romance, 10.0)


def _asked_out(sim, agent, fork, opt, value) -> None:
    q = _q(sim, value)
    if q is None:
        return
    act = value["act"]
    ra, rq = agent.relationships.get(q.id), q.relationships.get(agent.id)
    if act == "yes":
        social.start_dating(sim, q, agent)
    elif act == "coffee":
        for r in (ra, rq):
            if r is not None:
                r.romance = min(100.0, r.romance + 4)
        social.bump(sim, agent, q, 3, 3)
        place = value.get("place")
        if place and not people.is_named(q):
            f = social._folk_mod()
            if f is not None and f.is_free(sim, q):
                f.send_to(sim, q, place, "hang_out", 60)
        elif place and people.is_named(q) and sim.pending_invite_for(q) is None:
            sim.invite(agent, q.id, place)
    elif act == "friends":
        if rq is not None:
            rq.romance = max(0.0, rq.romance - 20)
        if ra is not None:
            ra.romance = min(ra.romance, 10.0)
    elif act == "flat":
        if rq is not None:
            rq.romance = max(0.0, rq.romance - 30)
        social.bump(sim, q, agent, -8, -2)


def _date(sim, agent, fork, opt, value) -> None:
    q = _q(sim, value)
    if q is None:
        return
    act = value["act"]
    if act == "go":
        place = value.get("place")
        f = social._folk_mod()
        if place and not people.is_named(q) and f is not None and f.is_free(sim, q):
            f.send_to(sim, q, place, "hang_out", 120)
        how = social.date_roll(sim, agent, q)
        words = {"warm": "a wonderful evening", "bad": "an evening that goes badly", "fine": "a pleasant evening"}
        sim.event(f"{agent.name} and {q.name} have {words.get(how, 'an evening out')}.", agent, tag="meetup",
                  agents=[q.id], place=place)
    elif act == "later":
        for r in (agent.relationships.get(q.id), q.relationships.get(agent.id)):
            if r is not None:
                r.romance = min(100.0, r.romance + 1)
    elif act == "no":
        social.bump(sim, q, agent, -3, 0)
    elif act == "end":
        social.end_couple(sim, agent, q)


def _move_in(sim, agent, fork, opt, value) -> None:
    q = _q(sim, value)
    if q is None:
        return
    act = value["act"]
    if act == "host":
        social.move_in(sim, q, agent)
    elif act == "join":
        social.move_in(sim, agent, q)
    elif act == "together":
        if not _place_together(sim, agent, q):
            social.move_in(sim, q, agent)
    elif act == "wait":
        social.bump(sim, q, agent, -5, 0)


def _place_together(sim, a, b) -> bool:
    """A new household for the two, and the children under 18 each has at home, in the cheapest rental that fits
    them all; False when none is free. A household they leave empty gives its home back (an owned one is sold)."""
    from . import housing
    from types import SimpleNamespace

    fn = getattr(housing, "cheapest_rental", None)
    olds = [people.household(sim, a), people.household(sim, b)]
    if fn is None or None in olds or getattr(housing, "new_household", None) is None:
        return False
    members = social.with_kids(sim, a)
    for m in social.with_kids(sim, b):
        if all(m.id != x.id for x in members):
            members.append(m)
    home = fn(sim, SimpleNamespace(member_ids=[m.id for m in members]))
    if home is None:
        return False
    came = {m.id: m.household_id for m in members}
    try:
        new = housing.new_household(sim, members, home.id, "rent")
    except NameError:  # housing.new_household before its Household import is fixed (see L1's handoff)
        return False
    if new is None:
        return False
    for i, old in enumerate(olds):
        if old is not new and not (i == 1 and old is olds[0]):
            social.vacate(sim, old, [m for m in members if came[m.id] == old.id])
    for r in (a.relationships.get(b.id), b.relationships.get(a.id)):
        if r is not None:
            r.kind = social.PARTNER
            r.since = sim.clock.tick
    social._count(sim, "moved_in")
    sim.event(f"{a.name} and {b.name} move in together at {home.name}.", a, tag="moved_in", agents=[b.id],
              place=home.place)
    return True


def _propose(sim, agent, fork, opt, value) -> None:
    q = _q(sim, value)
    if q is None:
        return
    act = value["act"]
    if act == "propose":
        if people.is_named(q):
            if not people.prompt(sim, q, "proposal", {"with": agent.id, "ring": bool(value.get("ring"))}):
                social.engage(sim, agent, q)
        else:
            social.engage(sim, agent, q)
    elif act == "never":
        r = agent.relationships.get(q.id)
        if r is not None:
            r.romance = max(0.0, r.romance - 5)


def _proposal(sim, agent, fork, opt, value) -> None:
    q = _q(sim, value)
    if q is None:
        return
    act = value["act"]
    if act == "yes":
        social.engage(sim, q, agent, 14)
    elif act == "long":
        social.engage(sim, q, agent, 90)
    elif act == "not_yet":
        social.bump(sim, q, agent, -10, 0)
    elif act == "no":
        social.bump(sim, q, agent, -15, -5)
        for r in (agent.relationships.get(q.id), q.relationships.get(agent.id)):
            if r is not None:
                r.romance = max(0.0, r.romance - 20)


def _trouble(sim, agent, fork, opt, value) -> None:
    q = _q(sim, value)
    if q is None:
        return
    if value["act"] == "space":
        if agent.life is not None:
            agent.life.cooldowns["breakup"] = sim.clock.day + 7
    elif value["act"] == "end":
        social.end_couple(sim, agent, q)


def _split(sim, agent, fork, opt, value) -> None:
    q = _q(sim, value)
    if q is None:
        return
    if value["act"] == "agree":
        social.end_couple(sim, q, agent)
    elif value["act"] == "storm":
        social.bump(sim, agent, q, -20, -20)
        social.end_couple(sim, agent, q)


def _friend_in_need(sim, agent, fork, opt, value) -> None:
    q = _q(sim, value)
    if q is None:
        return
    act = value["act"]
    if act == "lend":
        social.lend(sim, agent, q, value["amount"])
    elif act == "give":
        amount = value["amount"]
        agent.money -= amount
        q.money += amount
        social.bump(sim, q, agent, 6, 2)
        sim.event(f"{agent.name} gives {q.name} ${amount:,}.", agent, tag="loan", agents=[q.id])
    elif act == "no":
        social.bump(sim, q, agent, -8, 0)


# --- outcome keys ------------------------------------------------------------------------------------------------

def _life_rel(sim, agent, value) -> None:
    q = people.person(sim, value[0])
    if q is not None and q.alive:
        social.bump(sim, q, agent, value[1])


def _life_rom(sim, agent, value) -> None:
    q = people.person(sim, value[0])
    if q is None:
        return
    for r in (agent.relationships.get(q.id), q.relationships.get(agent.id)):
        if r is not None:
            r.romance = max(0.0, min(100.0, r.romance + value[1]))


people.PROMPTS.update({"crush": crush_fork, "asked_out": asked_out_fork, "date": date_fork, "move_in": move_in_fork,
                       "propose": propose_fork, "proposal": proposal_fork,
                       "relationship_trouble": relationship_trouble_fork, "partner_split": partner_split_fork,
                       "friend_in_need": friend_in_need_fork})
people.HANDLERS.update({"crush": _crush, "asked_out": _asked_out, "date": _date, "move_in": _move_in,
                        "propose": _propose, "proposal": _proposal, "relationship_trouble": _trouble,
                        "partner_split": _split, "friend_in_need": _friend_in_need})
people.EFFECTS.update({"life_rel": _life_rel, "life_rom": _life_rom})

"""Social life for both tiers (life.md 5.1-5.4): talk in rooms, friends, rivals, romance, dates, moving in,
engagements and weddings, texts and invites to townsfolk, lending, incidents and upkeep.

Every tick one tenth of the places run their rooms (`buckets[tick % 10]`, `sid(place) % 10`). A room is a home unit
(its residents), a block or house's visitors, or a whole place; it holds the named there plus `folk.present(place)`
when `people.mixed(sim)`. With `sim.folk.isolated` townsfolk never join a named room, romance, lending or incidents
(their own rooms still run). Every draw is `dice.stream(dice_seed, NS, ...)`; luck works through `dice.odds` and every
luck-shifted outcome except talk tone is logged with `people.log_roll`. The named meet the big moments as forks
(social_forks.py, queued with `people.prompt`); townsfolk settle them at once.
"""

from __future__ import annotations

import math
from collections import Counter, deque

from . import chronicle, dice, people, talk
from .agent import Profile, RelationKind, Relationship

ACQ, COWORKER, FRIEND = RelationKind.ACQUAINTANCE, RelationKind.COWORKER, RelationKind.FRIEND
FAMILY, PARTNER, DATING = RelationKind.FAMILY, RelationKind.PARTNER, RelationKind.DATING
EX, RIVAL = RelationKind.EX, RelationKind.RIVAL
TRAITS = Profile.TRAITS
DAY = 24 * 60

TALK_P = {"home": 0.13, "block": 0.027, "work": 0.06, "school": 0.08, "cafe": 0.29, "park": 0.11}
STRANGER_W = {"home": 0.3, "block": 0.6, "work": 0.25, "school": 0.4, "cafe": 0.5, "park": 0.5}
CLASS_OF_KIND = {"cafe": "cafe", "venue": "cafe", "park": "park", "school": "school", "station": "block"}
STEP = {"warm": 1.6, "pleasant": 0.5, "awkward": -1.5, "argument": -5.0}
SOCIAL_GAIN = {"warm": 10, "pleasant": 6, "awkward": 6, "argument": 2}  # named: g * (1 - need/100)**2
TONE_CODE = {"warm": 1, "pleasant": 0, "awkward": -1, "argument": -1}
TALKS_A_DAY = 10
CANDIDATES = 6
FIRST_AFFINITY = 10.0
FRIEND_AT = chronicle.FRIEND_AT  # 40
RIVAL_AT, RIVAL_OFF = -15.0, 0.0
REL_CAP = people.REL_CAP
CHEM_MIN = 0.7
ASK_ROMANCE, ASK_AFFINITY = 30.0, 20.0
SKIP_ACTS = ("sleep", "hospital", "ward", "dead", "baby")
WANDER = ("walk_park", "play")
RING = 12  # a person's talk ring (life.talks)
TALKS_SHOWN = 20  # state.talks rows
TALKS_WINDOW = 10  # ... begun in the last 10 game minutes
DATE_HOUR = 17  # dates are arranged at 17:00 for the evening
WEDDING_HOUR = 14
COOL = {"crush": 5, "asked_out": 3, "date": 2, "move_in": 14, "propose": 30, "proposal": 30,
        "relationship_trouble": 7, "partner_split": 7, "friend_in_need": 7, "borrow": 7}


class SocialState:
    """`sim.social`: `buckets` (10 sorted lists of place ids), `talks` (deque 40 of (tick, a, b, tone, place)),
    `folk_invites` ("fi<n>" -> record), the day's couples, engagements and counters."""

    def __init__(self) -> None:
        self.buckets = [[] for _ in range(10)]
        self.talks = deque(maxlen=40)
        self.folk_invites = {}
        self.invite_ids = 0
        self.loan_ids = 0
        self.couples = []  # [lo id, hi id] of every dating or partner pair, rebuilt each night
        self.engaged = {}  # "lo|hi" -> wedding day
        self.counts = Counter()  # talks, friendships, rivals, couples, flirts, ... since the start
        self.place_index = {}  # place id -> index in town.places
        self.kind = {}  # place id -> talk class of a non-home place
        self.loans = []  # rows when sim.life has none


def _ds(sim) -> int:
    return people.dice_seed(sim)


def init(sim) -> None:
    st = SocialState()
    for i, (pid, place) in enumerate(sim.town.places.items()):
        st.place_index[pid] = i
        st.buckets[dice.sid(pid) % 10].append(pid)
        if place.kind != "home":
            st.kind[pid] = CLASS_OF_KIND.get(place.kind, "work")
    for b in st.buckets:
        b.sort()
    sim.social = st
    _rebuild_couples(sim)


def _folk_mod():
    try:
        from . import folk
    except ImportError:
        return None
    return folk


def _life_mod():
    from . import life
    return life


def _loans(sim) -> list:
    loans = getattr(getattr(sim, "life", None), "loans", None)
    return loans if loans is not None else sim.social.loans


def _count(sim, key: str, n: int = 1) -> None:
    sim.social.counts[key] += n
    today = getattr(getattr(sim, "life", None), "today", None)
    if today is not None:
        today[key] = today.get(key, 0) + n


def _first(name: str) -> str:
    return name.split()[0]


# --- who is where ----------------------------------------------------------------------------------------------

def _named_place(a):
    """The place a named character's room is in now, or None (asleep, travelling, in hospital, under 3, dead)."""
    if not a.alive or a.age < 3 or a.state == "travelling" or a.activity in SKIP_ACTS:
        return None
    if a.inside:
        return a.inside
    if a.state == "busy" and a.activity in WANDER:
        return a.activity_place
    return None


def _folk_ok(p) -> bool:
    return p.alive and p.age >= 3 and p.activity not in SKIP_ACTS and p.state != "travelling"


def _home_place(sim, hid):
    home = sim.homes.get(hid) if hid is not None else None
    return home.place if home is not None else None


def _rooms(sim, place_id, group):
    """`group` (the people at one place) split into rooms: [(key parts, class, people), ...]."""
    st = sim.social
    cls = st.kind.get(place_id)
    if cls is not None:
        return [((place_id,), cls, group)]
    units = {}
    visitors = []
    for p in group:
        hid = people.home_id(sim, p)
        if hid is not None and _home_place(sim, hid) == place_id:
            units.setdefault(hid, []).append(p)
        else:
            visitors.append(p)
    block = []
    for v in visitors:
        best, best_aff = None, None
        for hid in sorted(units):
            for r_ in units[hid]:
                r = v.relationships.get(r_.id)
                if r is not None and (best_aff is None or r.affinity > best_aff):
                    best, best_aff = hid, r.affinity
        if best is not None and best_aff > 0:
            units[best].append(v)
        else:
            block.append(v)
    rooms = [((hid,), "home", units[hid]) for hid in sorted(units)]
    if block:
        rooms.append(((place_id, "block"), "block", block))
    return rooms


# --- the tick ----------------------------------------------------------------------------------------------------

def tick(sim) -> None:
    st = getattr(sim, "social", None)
    if st is None:
        return
    clock = sim.clock
    t = clock.tick
    m = clock.minute_of_day
    if m == 0:
        _nightly(sim)
    elif m == DATE_HOUR * 60:
        _dates(sim)
    elif m == 9 * 60:
        _lending(sim)
    elif m == WEDDING_HOUR * 60 and st.engaged:
        _weddings(sim)
    if clock.weekday == 2 and m == 11 * 60:
        _incidents(sim, ("work", "school"))
    elif clock.weekday == 6 and m == 20 * 60:
        _incidents(sim, ("home",))
    elif clock.weekday == 5 and m == 12 * 60:
        _folk_texts(sim)
    if st.folk_invites:
        _answer_folk_invites(sim)
    b = t % 10
    named_at = {}
    for a in sim.agents.values():
        pl = _named_place(a)
        if pl is not None and dice.sid(pl) % 10 == b:
            named_at.setdefault(pl, []).append(a)
    folk = getattr(sim, "folk", None)
    has_folk = folk is not None and folk.n > 0
    mixed = has_folk and not folk.isolated
    places = st.buckets[b] if has_folk else sorted(named_at)
    for place_id in places:
        named = named_at.get(place_id)
        if has_folk:
            idx = folk.present(place_id)
            crowd = [folk.people[i] for i in idx] if idx else []
            crowd = [p for p in crowd if _folk_ok(p)]
        else:
            crowd = []
        if mixed or not named:
            group = (named or []) + crowd
            if len(group) >= 2:
                for parts, cls, room in _rooms(sim, place_id, group):
                    if len(room) >= 2:
                        _run_room(sim, place_id, parts, cls, room, t)
        else:  # isolated: the named and the folk at one place never share a room
            if len(named) >= 2:
                for parts, cls, room in _rooms(sim, place_id, named):
                    if len(room) >= 2:
                        _run_room(sim, place_id, parts, cls, room, t)
            if len(crowd) >= 2:
                for parts, cls, room in _rooms(sim, place_id, crowd):
                    if len(room) >= 2:
                        _run_room(sim, place_id, parts + ("folk",), cls, room, t)


def _talks_today(p) -> int:
    life = p.life
    return life.talks_today if life is not None else TALKS_A_DAY


def _may_talk(sim, a, b) -> bool:
    """Under-13s talk only to under-18s and their own household."""
    if a.age < 13 or b.age < 13:
        return (a.age < 18 and b.age < 18) or a.household_id == b.household_id
    return True


def _run_room(sim, place_id, parts, cls, room, t) -> None:
    rr = dice.stream(_ds(sim), dice.TALK, *parts, t)
    n = len(room)
    k = math.floor(TALK_P[cls] * n + rr.random())
    if k <= 0:
        return
    busy = set()
    for _ in range(k):
        a = room[math.floor(rr.random() * n)]
        if a.id in busy or _talks_today(a) >= TALKS_A_DAY:
            continue
        if rr.random() >= 0.5 + 0.5 * people.traits(a).get("social", 0.5):
            continue
        best, best_w = None, -1.0
        for _ in range(min(CANDIDATES, n - 1)):
            b = room[math.floor(rr.random() * n)]
            if b is a or b.id in busy or _talks_today(b) >= TALKS_A_DAY or not _may_talk(sim, a, b):
                continue
            r = a.relationships.get(b.id)
            if r is None:
                w = STRANGER_W[cls]
            else:
                w = 1 + max(0.0, r.affinity) / 10
                if r.kind is PARTNER or r.kind is DATING or r.kind is FAMILY:
                    w *= 2
                if r.romance > 0:
                    w *= 1 + r.romance / 10
            w *= 0.5 + rr.random()
            if w > best_w:
                best, best_w = b, w
        if best is None:
            continue
        busy.add(a.id)
        busy.add(best.id)
        converse(sim, a, best, cls, place_id, t, rr)


# --- one talk ------------------------------------------------------------------------------------------------------

def _evict(sim, p) -> bool:
    """Room for one more relationship: the acquaintance or coworker with |affinity| < 25 seen longest ago goes."""
    weakest, wseen = None, None
    for oid, r in p.relationships.items():
        if (r.kind is ACQ or r.kind is COWORKER) and abs(r.affinity) < 25:
            if wseen is None or r.seen < wseen or (r.seen == wseen and oid < weakest):
                weakest, wseen = oid, r.seen
    if weakest is None:
        return False
    _drop(sim, p, weakest)
    return True


def _drop(sim, p, oid) -> None:
    p.relationships.pop(oid, None)
    q = people.person(sim, oid)
    if q is not None:
        q.relationships.pop(p.id, None)


def _ensure(sim, a, b, t):
    """Both sides of a and b's relationship, created as acquaintances at FIRST_AFFINITY on a first talk; None when
    either is full (REL_CAP) with nobody to let go."""
    ra, rb = a.relationships.get(b.id), b.relationships.get(a.id)
    if ra is not None and rb is not None:
        return ra, rb
    if ra is None and len(a.relationships) >= REL_CAP and not _evict(sim, a):
        return None
    if rb is None and len(b.relationships) >= REL_CAP and not _evict(sim, b):
        return None
    if ra is None:
        ra = a.relationships[b.id] = Relationship(ACQ, FIRST_AFFINITY, since=t, seen=t)
    if rb is None:
        rb = b.relationships[a.id] = Relationship(ACQ, FIRST_AFFINITY, since=t, seen=t)
    _count(sim, "met")
    return ra, rb


def trait_gap(a, b) -> float:
    ta, tb = people.traits(a), people.traits(b)
    d = 0.0
    for k in TRAITS:
        d += abs(ta.get(k, 0.5) - tb.get(k, 0.5))
    return d / len(TRAITS)


def compat(a, b) -> float:
    return 0.6 * (0.33 - trait_gap(a, b))


def _stressed(sim, p, t) -> bool:
    life = p.life
    if life is not None:
        if life.conditions or life.grief_until > t:
            return True
    hh = people.household(sim, p)
    return hh is not None and hh.arrears > 0


def _clamp(x, lo, hi):
    return lo if x < lo else hi if x > hi else x


def converse(sim, a, b, cls, place_id, t, rr) -> str | None:
    """One talk between a and b: tone, both sides' affinity, needs, kinds, romance, contagion and, with a named,
    the talk ring and an event. Returns the tone (None when neither had room for a new relationship)."""
    pair = _ensure(sim, a, b, t)
    if pair is None:
        return None
    ra, rb = pair
    d = trait_gap(a, b)
    stress = 0.1 if (_stressed(sim, a, t) or _stressed(sim, b, t)) else 0.0
    s = 0.004 * (ra.affinity + rb.affinity) / 2 + 0.6 * (0.33 - d) + 0.004 * (a.mood + b.mood - 120) - stress
    luck = (a.luck + b.luck) / 2
    p_warm = dice.odds(_clamp(0.40 + s, 0.05, 0.85), +1, luck, 0.5)
    p_arg = dice.odds(_clamp(0.06 - 0.5 * s, 0.01, 0.30), -1, luck, 0.5)
    x = rr.random()
    tone = ("warm" if x < p_warm else "argument" if x < p_warm + p_arg else "awkward" if x < p_warm + p_arg + 0.12
            else "pleasant")
    step = STEP[tone]
    if tone == "argument":
        if d > 0.33:
            step *= 1.6
        if ra.affinity < 0 or rb.affinity < 0:
            step *= 2
    ra.seen = rb.seen = t
    ra.talks += 1
    rb.talks += 1
    for r, me, other in ((ra, a, b), (rb, b, a)):
        before = r.affinity
        gain = step * (1 - max(0.0, before) / 100) if step > 0 else step
        r.affinity = _clamp(before + gain, -100.0, 100.0)
        if tone == "argument":
            r.trust = max(0.0, r.trust - 3)
        on_affinity(sim, me.id, other.id, before, r.affinity)
    g = SOCIAL_GAIN[tone]
    for x in (a, b):  # a named's gain shrinks as the need fills, so a chatty day can still end lonely (v2's forks)
        if people.is_named(x):
            f = 1 - x.needs["social"] / 100
            x.adjust("social", g * f * f)
        else:
            x.adjust("social", g)
    if tone == "argument":
        a.adjust("fun", -4)
        b.adjust("fun", -4)
    if a.life is not None:
        a.life.talks_today += 1
    if b.life is not None:
        b.life.talks_today += 1
    _count(sim, "talks")
    sim.social.talks.append((t, a.id, b.id, TONE_CODE[tone], place_id))
    infect = getattr(_life_mod(), "infect", None)
    if infect is not None:
        infect(sim, a, b)
    if tone == "warm":
        if ra.kind is PARTNER or ra.kind is DATING:
            ra.romance = min(100.0, ra.romance + 2)
            rb.romance = min(100.0, rb.romance + 2)
        elif eligible(sim, a, b):
            _flirt(sim, a, b, ra, rb, place_id)
    if people.is_named(a) or people.is_named(b):
        _named_talk(sim, a, b, ra, tone, cls, place_id)
    return tone


def on_affinity(sim, a_id, b_id, before, after) -> None:
    """Kinds after a's affinity toward b moved from `before` to `after` (life.md 5.1.6): named pairs through
    chronicle.on_affinity (v2's texts), others by the same rule (friend at FRIEND_AT, falling-out below 0, events only
    with a named); for all, rival at RIVAL_AT and back to acquaintance above RIVAL_OFF."""
    a, b = people.person(sim, a_id), people.person(sim, b_id)
    if a is None or b is None:
        return
    r = a.relationships.get(b_id)
    if r is None:
        return
    back = b.relationships.get(a_id)
    named_a, named_b = people.is_named(a), people.is_named(b)
    was = r.kind
    if named_a and named_b:
        chronicle.on_affinity(sim, a_id, b_id, before, after)
        if was is not FRIEND and r.kind is FRIEND:
            _count(sim, "friendships")
            _count(sim, "friendships_named")
    elif (was is ACQ or was is COWORKER) and before < FRIEND_AT <= after:
        r.kind = FRIEND
        if back is not None and (back.kind is ACQ or back.kind is COWORKER):
            back.kind = FRIEND
        _count(sim, "friendships")
        if named_a or named_b:
            _count(sim, "friendships_named")
            who, other = (a, b) if named_a else (b, a)
            text = f"{a.name} and {b.name} have become friends."
            sim.event(text, who, tag="new_friend", importance=1, agents=[other.id], place=_where_of(who))
            other.remember(sim.clock.stamp(), text)
    elif (was is FRIEND or was is PARTNER) and before >= 0 > after and (named_a or named_b):
        who, other = (a, b) if named_a else (b, a)
        sim.event(f"{a.name} and {b.name} have fallen out.", who, tag="falling_out", importance=1,
                  agents=[other.id], place=_where_of(who))
    if r.kind in (ACQ, COWORKER, FRIEND) and before > RIVAL_AT >= after:
        r.kind = RIVAL
        if back is not None and back.kind in (ACQ, COWORKER, FRIEND):
            back.kind = RIVAL
        _count(sim, "rivals")
        if named_a or named_b:
            who, other = (a, b) if named_a else (b, a)
            sim.event(f"{a.name} and {b.name} can't stand each other now.", who, tag="rival", agents=[other.id],
                      place=_where_of(who))
    elif r.kind is RIVAL and before <= RIVAL_OFF < after:
        r.kind = ACQ
        if back is not None and back.kind is RIVAL:
            back.kind = ACQ


def _where_of(p):
    return p.inside or p.activity_place


def bump(sim, a, b, value, back=None) -> None:
    """a's affinity toward b by `value` and b's toward a by `back` (default value / 2), kinds updated."""
    pair = _ensure(sim, a, b, sim.clock.tick)
    if pair is None:
        return
    for r, me, other, v in ((pair[0], a, b, value), (pair[1], b, a, value / 2 if back is None else back)):
        before = r.affinity
        r.affinity = _clamp(before + v, -100.0, 100.0)
        on_affinity(sim, me.id, other.id, before, r.affinity)


# --- what the named say ---------------------------------------------------------------------------------------------

def _recent(p, tags, days, day) -> bool:
    life = p.life
    if life is None:
        return False
    for tg in tags:
        d = life.recent.get(tg)
        if d is not None and day - d <= days:
            return True
    return False


def _headline(sim):
    """A usable headline for talk (life.md 5.2): importance 2, within 2 days, never God-only or a controller's."""
    t = sim.clock.tick
    for ev in reversed(sim.headlines):
        if t - ev["tick"] > 2 * DAY:
            return None
        if ev["tag"] in chronicle.GOD_ONLY_TAGS or ev["kind"] in ("controller", "social"):
            continue
        return ev["text"]
    return None


def _told(p, headline) -> bool:
    """p has talked about this headline already (in their last RING talks)."""
    life = p.life
    if life is None:
        return False
    for t in life.talks:
        if t["topic"] == "news" and headline in t["text"]:
            return True
    return False


def _kid_of(sim, p):
    for m in people.members(sim, p):
        if m is not p and m.age < 18:
            r = p.relationships.get(m.id)
            if r is not None and r.kind is FAMILY and p.age - m.age >= 16:
                return m
    return None


def talk_ctx(sim, a, b, ra, cls, place_id) -> dict:
    day = sim.clock.day
    partner = None  # someone's partner who is not in the talk
    for x, y in ((a, b), (b, a)):
        q = partner_of(sim, x)
        if q is not None and q is not y:
            partner = q
            break
    kid = _kid_of(sim, a) or _kid_of(sim, b)
    life_mod = _life_mod()
    ill = (life_mod.ill(a) or life_mod.ill(b) or _recent(a, ("discharged",), 7, day)
           or _recent(b, ("discharged",), 7, day))
    illness = None
    for p in (a, b):
        if p.life is not None and p.life.conditions:
            illness = p.life.conditions[0].id.replace("_", " ")
            break
    headline = _headline(sim)
    if headline is not None and (_told(a, headline) or _told(b, headline)):
        headline = None  # old news to one of them
    place = sim.town.places.get(place_id)
    job = a.job if a.job is not None else b.job
    work = sim.town.places.get(job.place_id) if job is not None else None
    return {
        "rain": sim.weather == "rain",
        "coworkers": a.job is not None and b.job is not None and a.job.place_id == b.job.place_id
        and a.job.title != "student" and cls == "work",
        "pupils": cls == "school" and a.age < 18 and b.age < 18,
        "money": _recent(a, ("laid_off", "job_lost", "in_red", "raise", "windfall"), 7, day)
        or _recent(b, ("laid_off", "job_lost", "in_red", "raise", "windfall"), 7, day),
        "family": partner is not None or kid is not None,
        "baby": kid is not None and kid.age == 0,
        "health": ill,
        "love": ra.kind is DATING or ra.romance >= 20,
        "headline": headline,
        "place": place.name if place is not None else None,
        "work": work.name if work is not None else None,
        "kid": _first(kid.name) if kid is not None else None,
        "partner": _first(partner.name) if partner is not None else None,
        "illness": illness,
    }


TOPIC_WORDS = {"weather": "the weather", "work": "work", "school": "school", "money": "money",
               "family": "family", "health": "how they feel", "news": "the news", "love": "how they feel"}


def _named_talk(sim, a, b, ra, tone, cls, place_id) -> None:
    rr = dice.stream(_ds(sim), dice.TALK, a.id, b.id, sim.clock.tick)
    ctx = talk_ctx(sim, a, b, ra, cls, place_id)
    tp = talk.topic(ctx, rr.random())
    text = talk.line(tp, tone, ctx, rr)
    place = sim.town.places.get(place_id)
    where = f" at {place.name}" if place is not None and cls != "home" else " at home" if cls == "home" else ""
    stamp = sim.clock.stamp()
    for x, y in ((a, b), (b, a)):
        if people.is_named(x) and x.life is not None:
            x.life.talks.append({"time": stamp, "with": y.id, "name": y.name, "topic": tp, "tone": tone,
                                 "text": text, "place": place_id})
            del x.life.talks[:-RING]
    if tone == "argument" or (cls != "home" and (tone == "warm" or tp in ("news", "love") or ctx["baby"])):
        who, other = (a, b) if people.is_named(a) else (b, a)
        verb = "argue about" if tone == "argument" else "chat about"
        sim.event(f"{a.name} and {b.name} {verb} {TOPIC_WORDS[tp]}{where}: {text}", who, tag="talk",
                  agents=[other.id], place=place_id, remember=False)


# --- romance -------------------------------------------------------------------------------------------------------

def partner_of(sim, p):
    """p's living partner or date, or None."""
    for oid, r in p.relationships.items():
        if r.kind is PARTNER or r.kind is DATING:
            q = people.person(sim, oid)
            if q is not None and q.alive:
                return q
    return None


def _orient(sim, p) -> bool:
    return dice.roll(_ds(sim), dice.ORIENT, p.id) < 0.08


def attracted(sim, a, b) -> bool:
    return people.sex(a) != people.sex(b) or (_orient(sim, a) and _orient(sim, b))


def eligible(sim, a, b) -> bool:
    """Both 18+, single, not family or one household, the age gap at most max(4, younger // 4), neither widowed in
    90 days, attracted; never across tiers while the townsfolk are isolated."""
    if a.age < 18 or b.age < 18 or a.household_id == b.household_id:
        return False
    if abs(a.age - b.age) > max(4, min(a.age, b.age) // 4):
        return False
    if people.is_named(a) != people.is_named(b) and people.isolated(sim):
        return False
    r = a.relationships.get(b.id)
    if r is not None and (r.kind is FAMILY or r.kind is EX):
        return False
    day = sim.clock.day
    for p in (a, b):
        if p.life is not None and p.life.widowed_day is not None and day - p.life.widowed_day < 90:
            return False
    if not attracted(sim, a, b):
        return False
    return partner_of(sim, a) is None and partner_of(sim, b) is None


def chemistry(sim, a, b) -> float:
    """Never stored or shown."""
    lo, hi = (a.id, b.id) if a.id < b.id else (b.id, a.id)
    return dice.roll(_ds(sim), dice.CHEM, lo, hi)


def _flirt(sim, a, b, ra, rb, place_id) -> None:
    chem = chemistry(sim, a, b)
    if chem < CHEM_MIN:
        return
    g = 6 + 14 * (chem - CHEM_MIN) / (1 - CHEM_MIN)
    ra.romance = min(100.0, ra.romance + g)
    rb.romance = min(100.0, rb.romance + g)
    _count(sim, "flirts")
    if people.is_named(a) or people.is_named(b):
        _count(sim, "flirts_named")
        who, other = (a, b) if people.is_named(a) else (b, a)
        sim.event(f"{a.name} and {b.name} flirt a little.", who, tag="flirt", agents=[other.id], place=place_id,
                  remember=False)
    asker, target, rs = (a, b, ra) if ra.romance >= rb.romance else (b, a, rb)
    if rs.romance >= ASK_ROMANCE and rs.affinity >= ASK_AFFINITY:
        ask_out(sim, asker, target)


def _cool(p, kind, day) -> bool:
    """True while `kind` is cooling down for p (life.cooldowns: kind -> first day it may come again)."""
    life = p.life
    return life is not None and life.cooldowns.get(kind, -1) > day


def _set_cool(p, kind, day) -> None:
    if p.life is not None:
        p.life.cooldowns[kind] = day + COOL[kind]


def ask_out(sim, asker, target) -> None:
    """The ask-out (life.md 5.3): a named asker gets `crush`, a named target `asked_out`; between townsfolk the
    answer is rolled at once."""
    day = sim.clock.day
    if people.is_named(asker):
        if not _cool(asker, "crush", day) and people.prompt(sim, asker, "crush", {"with": target.id}):
            _set_cool(asker, "crush", day)
        return
    if people.is_named(target):
        if not _cool(target, "asked_out", day) and people.prompt(sim, target, "asked_out", {"with": asker.id}):
            _set_cool(target, "asked_out", day)
        return
    folk_answer(sim, asker, target)


def folk_answer(sim, asker, target) -> bool:
    """A townsperson asked out: yes at odds(min(.95, .35 + .5 (chem - .7)/.3 + .004 (aff - 20) + .004 rom), +1,
    asker luck). Yes: dating; no: the asker's romance -20, affinity -3."""
    ra, rt = asker.relationships.get(target.id), target.relationships.get(asker.id)
    if ra is None or rt is None:
        return False
    chem = chemistry(sim, asker, target)
    p = dice.odds(min(0.95, 0.35 + 0.5 * (chem - CHEM_MIN) / (1 - CHEM_MIN) + 0.004 * (rt.affinity - 20)
                      + 0.004 * rt.romance), +1, asker.luck)
    roll = dice.roll(_ds(sim), dice.ASK, asker.id, target.id, sim.clock.tick)
    people.log_roll(sim, asker, "ask_out", p, roll)
    if roll < p:
        start_dating(sim, asker, target)
        return True
    ra.romance = max(0.0, ra.romance - 20)
    bump(sim, asker, target, -3, 0)
    return False


def start_dating(sim, a, b) -> None:
    t = sim.clock.tick
    pair = _ensure(sim, a, b, t)
    if pair is None:
        return
    ra, rb = pair
    ra.kind = rb.kind = DATING
    ra.since = rb.since = t
    ra.romance = max(ra.romance, ASK_ROMANCE)
    rb.romance = max(rb.romance, ASK_ROMANCE)
    _count(sim, "couples")
    st = sim.social
    lo, hi = (a.id, b.id) if a.id < b.id else (b.id, a.id)
    if [lo, hi] not in st.couples:
        st.couples.append([lo, hi])
    if people.is_named(a) or people.is_named(b):
        _count(sim, "couples_named")
        who, other = (a, b) if people.is_named(a) else (b, a)
        sim.event(f"{a.name} and {b.name} are going out!", who, tag="partner", agents=[other.id],
                  place=_where_of(who))
    _jealousy(sim, a, b)
    _jealousy(sim, b, a)


def _jealousy(sim, x, y) -> None:
    """A new couple costs everyone with romance 20+ toward x 20 affinity toward y (life.md 5.1.7)."""
    for zid in list(x.relationships):
        if zid == y.id:
            continue
        z = people.person(sim, zid)
        if z is None or not z.alive:
            continue
        rz = z.relationships.get(x.id)
        if rz is None or rz.romance < 20:
            continue
        if people.is_named(z) != people.is_named(y) and people.isolated(sim):
            continue
        bump(sim, z, y, -20, -5)
        _count(sim, "jealous")


def end_couple(sim, a, b, why="breakup") -> None:
    """Both sides become exes, affinity -15 each; a married couple divorces ($1,500 each)."""
    ra, rb = a.relationships.get(b.id), b.relationships.get(a.id)
    if ra is None or rb is None:
        return
    married = ra.married or rb.married
    cohabit = ra.kind is PARTNER
    ra.kind = rb.kind = EX
    ra.married = rb.married = False
    ra.romance = rb.romance = 0.0
    ra.since = rb.since = sim.clock.tick
    bump(sim, a, b, -15, -15)
    lo, hi = (a.id, b.id) if a.id < b.id else (b.id, a.id)
    st = sim.social
    if [lo, hi] in st.couples:
        st.couples.remove([lo, hi])
    st.engaged.pop(f"{lo}|{hi}", None)
    _count(sim, "breakups")
    tag = "divorce" if married else "breakup"
    if married:
        a.money -= 1500
        b.money -= 1500
    named = people.is_named(a) or people.is_named(b)
    if named or married:
        who, other = (a, b) if people.is_named(a) or not people.is_named(b) else (b, a)
        text = (f"{a.name} and {b.name} are divorcing." if married else
                f"{a.name} and {b.name} have split up." if cohabit else f"{a.name} and {b.name} have broken up.")
        sim.event(text, who, tag=tag, importance=None if named else 1, agents=[other.id], place=_where_of(who))
    if cohabit:
        leaver = b if why == "b_leaves" else a
        _leave_home(sim, leaver)


def _leave_home(sim, p) -> None:
    """After a split the leaver moves out: a named through life.split, a townsperson through folk.split."""
    if people.is_named(p):
        split = getattr(_life_mod(), "split", None)
        if split is not None:
            split(sim, p)
        return
    f = _folk_mod()
    if f is not None and hasattr(f, "split"):
        try:
            f.split(sim, p)
        except ImportError:  # folk.split lives in folk_life (F2b): until it lands the leaver stays put
            pass


def with_kids(sim, a) -> list:
    """a and their own children under 18 who live with them: the ones who move when a moves."""
    return [a] + [m for m in people.members(sim, a)
                  if m is not a and m.age < 18 and (a.relationships.get(m.id) is not None
                                                    and a.relationships[m.id].kind is FAMILY)]


def vacate(sim, old, leavers) -> None:
    """`leavers` have moved out of household `old`. If nobody alive is left, its home goes back: an owned one is
    sold first, the proceeds into the savings of the adults who left (as housing.move_household credits a sale)."""
    if old is None or old.id not in sim.households or any(
            people.person(sim, x) is not None and people.person(sim, x).alive for x in old.member_ids):
        return
    from . import housing
    home = sim.homes.get(old.home_id)
    if home is not None and home.owner == old.id and home.household == old.id:
        payees = [m for m in leavers if m.is_adult] or list(leavers)
        proceeds = housing.sale_proceeds(sim, home.id)
        for m in payees:
            m.savings += proceeds / len(payees)
    housing.on_household_empty(sim, old)
    sim.households.pop(old.id, None)


def move_in(sim, mover, host) -> bool:
    """mover (and their children under 18) join host's household; an emptied household's home goes back."""
    if people.is_named(mover) != people.is_named(host):
        return False
    if not people.is_named(mover):
        f = _folk_mod()
        if f is None or not hasattr(f, "join"):
            return False
        try:
            f.join(sim, mover, host)
        except ImportError:  # folk.join lives in folk_life (F2b): until it lands townsfolk couples stay dating
            return False
    else:
        old = people.household(sim, mover)
        new = people.household(sim, host)
        if old is None or new is None or old is new:
            return False
        movers = with_kids(sim, mover)
        for m in movers:
            if m.id in old.member_ids:
                old.member_ids.remove(m.id)
            m.household_id = new.id
            new.member_ids.append(m.id)
        vacate(sim, old, movers)
    ra, rb = mover.relationships.get(host.id), host.relationships.get(mover.id)
    if ra is not None and rb is not None:
        ra.kind = rb.kind = PARTNER
        ra.since = rb.since = sim.clock.tick
    _count(sim, "moved_in")
    if people.is_named(mover):
        sim.event(f"{mover.name} moves in with {host.name}.", mover, tag="moved_in", agents=[host.id],
                  place=people.home_id(sim, host) and _home_place(sim, people.home_id(sim, host)))
    return True


def engage(sim, a, b, days=14) -> None:
    """Engaged: the wedding is the Saturday at least `days` on, 14:00, in the nearest park."""
    lo, hi = (a.id, b.id) if a.id < b.id else (b.id, a.id)
    day = sim.clock.day + days
    while day % 7 != 5:
        day += 1
    sim.social.engaged[f"{lo}|{hi}"] = day
    _count(sim, "engaged")
    if people.is_named(a) or people.is_named(b):
        who, other = (a, b) if people.is_named(a) else (b, a)
        sim.event(f"{a.name} and {b.name} are engaged!", who, tag="engaged", agents=[other.id], place=_where_of(who))


def _weddings(sim) -> None:
    st = sim.social
    day = sim.clock.day
    for key in sorted(st.engaged):
        if st.engaged[key] != day:
            continue
        del st.engaged[key]
        lo, hi = key.split("|")
        a, b = people.person(sim, lo), people.person(sim, hi)
        if a is None or b is None or not a.alive or not b.alive:
            continue
        ra, rb = a.relationships.get(b.id), b.relationships.get(a.id)
        if ra is None or rb is None or ra.kind is not PARTNER:
            continue
        ra.married = rb.married = True
        ra.romance = min(100.0, ra.romance + 10)
        rb.romance = min(100.0, rb.romance + 10)
        _count(sim, "weddings")
        named = people.is_named(a) or people.is_named(b)
        park = None
        if people.is_named(a):
            park = sim.nearest(a, ("park",))
            for x in (a, b):
                if sim._interruptible(x) and park is not None:
                    sim.start_plan(x, [("hang_out", park.id)])
        else:
            f = _folk_mod()
            parks = [pid for pid, kind in st.kind.items() if kind == "park"]
            if f is not None and parks:
                park_id = parks[dice.key(_ds(sim), dice.COUPLE, lo, hi, day) % len(parks)]
                park = sim.town.places[park_id]
                for x in (a, b):
                    if f.is_free(sim, x):
                        f.send_to(sim, x, park_id, "hang_out", 120)
        who, other = (a, b) if people.is_named(a) or not named else (b, a)
        where = f" in {park.name}" if park is not None else ""
        sim.event(f"{a.name} and {b.name} get married{where}!", who, tag="wedding",
                  importance=None if named else 1, agents=[other.id], place=park.id if park is not None else None)


# --- the nightly pass: upkeep and the couples ----------------------------------------------------------------------

def _rebuild_couples(sim) -> None:
    out = []
    for p in people.everyone(sim):
        for oid, r in p.relationships.items():
            if (r.kind is DATING or r.kind is PARTNER) and p.id < oid:
                q = people.person(sim, oid)
                if q is not None and q.alive:
                    out.append([p.id, oid])
    sim.social.couples = out


def _nightly(sim) -> None:
    t = sim.clock.tick
    day = sim.clock.day
    for p in people.everyone(sim):
        if p.life is not None:
            p.life.talks_today = 0
        _upkeep(sim, p, t)
    _rebuild_couples(sim)
    for lo, hi in list(sim.social.couples):
        a, b = people.person(sim, lo), people.person(sim, hi)
        if a is None or b is None:
            continue
        ra, rb = a.relationships.get(hi), b.relationships.get(lo)
        if ra is None or rb is None:
            continue
        if ra.kind is DATING:
            _dating_day(sim, a, b, ra, rb, day)
        elif ra.kind is PARTNER:
            _home_day(sim, a, b, ra, rb, day)
    _crushes(sim, day)
    _repay(sim, day)


def _upkeep(sim, p, t) -> None:
    """At most REL_CAP relationships; an unseen friend fades (.3 a day after 14 days, an acquaintance again below
    FRIEND_AT - 15); an acquaintance unseen 60 days with |affinity| < 15 is dropped."""
    rels = p.relationships
    while len(rels) > REL_CAP and _evict(sim, p):
        pass
    gone = []
    for oid, r in rels.items():
        unseen = t - r.seen
        if r.kind is FRIEND and unseen > 14 * DAY:
            r.affinity -= 0.3
            if r.affinity < FRIEND_AT - 15:
                r.kind = ACQ
        elif r.kind is ACQ and unseen > 60 * DAY and abs(r.affinity) < 15:
            gone.append(oid)
    for oid in gone:
        _drop(sim, p, oid)


def _dating_day(sim, a, b, ra, rb, day) -> None:
    """Breakups (lower romance < 25 or affinity < 15; a named leaver first gets relationship_trouble below 25) and
    moving in (after 28 days at romance and affinity 65 / 55 both, .025 a day; same tier only)."""
    leaver, other = (a, b) if (ra.affinity, ra.romance) <= (rb.affinity, rb.romance) else (b, a)
    rl = leaver.relationships[other.id]
    low_rom, low_aff = min(ra.romance, rb.romance), min(ra.affinity, rb.affinity)
    if people.is_named(leaver) and rl.affinity < 25 and not _cool(leaver, "relationship_trouble", day):
        if people.prompt(sim, leaver, "relationship_trouble", {"with": other.id}):
            _set_cool(leaver, "relationship_trouble", day)
            return
    if low_rom < 25 or low_aff < 15:
        if not (people.is_named(leaver) and _cool(leaver, "breakup", day)):
            end_couple(sim, leaver, other)
        return
    if people.is_named(a) != people.is_named(b):
        return  # across tiers it stops at dating
    if (sim.clock.tick - ra.since > 28 * DAY and min(ra.romance, rb.romance) >= 65
            and min(ra.affinity, rb.affinity) >= 55):
        rr = dice.stream(_ds(sim), dice.COUPLE, a.id, b.id, day)
        roll = rr.random()
        if roll >= 0.025:
            return
        if people.is_named(a):
            asker, x = (a, b) if ra.romance >= rb.romance else (b, a)
            if not _cool(asker, "move_in", day) and people.prompt(
                    sim, asker, "move_in", {"with": x.id, "weeks": (sim.clock.tick - ra.since) // (7 * DAY)}):
                _set_cool(asker, "move_in", day)
        else:
            mover, host = _mover(sim, a, b)
            move_in(sim, mover, host)


def _mover(sim, a, b):
    """The townsperson who moves: from the smaller household, renters first."""
    ha, hb = people.household(sim, a), people.household(sim, b)
    na = len(people.members(sim, a))
    nb = len(people.members(sim, b))
    rent_a = ha is not None and ha.weekly_rent > 0
    rent_b = hb is not None and hb.weekly_rent > 0
    if (na, not rent_a, a.id) <= (nb, not rent_b, b.id):
        return a, b
    return b, a


def _home_day(sim, a, b, ra, rb, day) -> None:
    """Home climate, splits and engagements of a couple living together."""
    rr = dice.stream(_ds(sim), dice.COUPLE, a.id, b.id, day)
    hh = people.household(sim, a)
    money = 0.1 if hh is not None and hh.arrears > 0 else 0.0
    baby = 0.0
    kid = _kid_of(sim, a)
    if kid is not None and kid.age == 0:
        baby = 0.05
    s_home = compat(a, b) + 0.003 * (a.mood + b.mood - 120) - money - baby
    luck = (a.luck + b.luck) / 2
    p_arg = dice.odds(_clamp(0.03 - 0.3 * s_home, 0.005, 0.25), -1, luck)
    x = rr.random()
    people.log_roll(sim, a, "home_argument", p_arg, x)
    if x < p_arg:
        bump(sim, a, b, -4, -4)
    elif rr.random() < 0.3 + s_home:
        bump(sim, a, b, 0.6, 0.6)
    for r in (ra, rb):
        r.romance = max(0.0, r.romance - 0.1)
    leaver, other = (a, b) if ra.affinity <= rb.affinity else (b, a)
    if min(ra.affinity, rb.affinity) < 10:
        if people.is_named(other) and not _cool(other, "partner_split", day):
            if people.prompt(sim, other, "partner_split", {"with": leaver.id}):
                _set_cool(other, "partner_split", day)
            return
        if people.is_named(leaver) and leaver.relationships[other.id].affinity < 25 and \
                not _cool(leaver, "relationship_trouble", day):
            if people.prompt(sim, leaver, "relationship_trouble", {"with": other.id}):
                _set_cool(leaver, "relationship_trouble", day)
                return
        end_couple(sim, leaver, other)
        return
    lo, hi = (a.id, b.id) if a.id < b.id else (b.id, a.id)
    if f"{lo}|{hi}" in sim.social.engaged or ra.married:
        return
    if sim.clock.tick - ra.since > 45 * DAY and min(ra.romance, rb.romance) >= 70 and rr.random() < 0.002:
        if people.is_named(a):
            asker, x2 = (a, b) if ra.romance >= rb.romance else (b, a)
            if not _cool(asker, "propose", day) and people.prompt(sim, asker, "propose", {"with": x2.id}):
                _set_cool(asker, "propose", day)
        else:
            p = dice.odds(0.8, +1, b.luck)
            roll = rr.random()
            people.log_roll(sim, a, "proposal", p, roll)
            if roll < p:
                engage(sim, a, b)


def _crushes(sim, day) -> None:
    """A named with a standing crush (romance 30+, affinity 20+ toward a single adult) gets the crush fork."""
    for a in sim.agents.values():
        if not a.alive or a.age < 18 or a.life is None or _cool(a, "crush", day):
            continue
        if partner_of(sim, a) is not None:
            continue
        best, best_rom = None, None
        for oid, r in a.relationships.items():
            if r.romance >= ASK_ROMANCE and r.affinity >= ASK_AFFINITY and r.kind not in (FAMILY, EX, PARTNER, DATING):
                q = people.person(sim, oid)
                if q is None or not q.alive or q.age < 18 or partner_of(sim, q) is not None:
                    continue
                if best_rom is None or r.romance > best_rom:
                    best, best_rom = q, r.romance
        if best is not None and people.prompt(sim, a, "crush", {"with": best.id}):
            _set_cool(a, "crush", day)


def _dates(sim) -> None:
    """Dating couples meet every third day: the evening goes well or badly (romance +5 / -9, affinity half that).
    Named pairs meet through a v2 invite to the cafe nearest the host; a named dating a townsperson gets the date
    fork; townsfolk just go."""
    day = sim.clock.day
    for lo, hi in list(sim.social.couples):
        if (dice.sid(lo) + dice.sid(hi) + day) % 3:
            continue
        a, b = people.person(sim, lo), people.person(sim, hi)
        if a is None or b is None or not a.alive or not b.alive:
            continue
        ra, rb = a.relationships.get(hi), b.relationships.get(lo)
        if ra is None or rb is None or ra.kind is not DATING:
            continue
        named_a, named_b = people.is_named(a), people.is_named(b)
        if named_a and named_b:
            cafe = sim.nearest(a, ("cafe",), stay=90)
            if cafe is not None and sim.pending_invite_for(b) is None:
                sim.invite(a, b.id, cafe.id)
            date_roll(sim, a, b)
        elif named_a or named_b:
            named, other = (a, b) if named_a else (b, a)
            if _cool(named, "date", day):
                continue
            cafe = sim.nearest(named, ("cafe",), stay=120)
            if cafe is not None and people.prompt(sim, named, "date", {"with": other.id, "place": cafe.id}):
                _set_cool(named, "date", day)
        else:
            date_roll(sim, a, b)


def date_roll(sim, a, b) -> str:
    """One date: s' = .2 + compat + .004 (aff - 50); warm at odds(.5 + s'), bad at odds(.1 - .5 s')."""
    ra, rb = a.relationships.get(b.id), b.relationships.get(a.id)
    if ra is None or rb is None:
        return "none"
    s2 = 0.2 + compat(a, b) + 0.004 * ((ra.affinity + rb.affinity) / 2 - 50)
    luck = (a.luck + b.luck) / 2
    pw = dice.odds(_clamp(0.5 + s2, 0.05, 0.9), +1, luck)
    pb = dice.odds(_clamp(0.1 - 0.5 * s2, 0.02, 0.4), -1, luck)
    x = dice.roll(_ds(sim), dice.COUPLE, a.id, b.id, sim.clock.tick)
    people.log_roll(sim, a, "date", pw, x)
    d = 5.0 if x < pw else -9.0 if x < pw + pb else 0.0
    if d:
        for r in (ra, rb):
            r.romance = _clamp(r.romance + d, 0.0, 100.0)
        bump(sim, a, b, d / 2, d / 2)
    _count(sim, "dates")
    return "warm" if d > 0 else "bad" if d < 0 else "fine"


# --- lending -------------------------------------------------------------------------------------------------------

def _lending(sim) -> None:
    """A person below -$200 asks family, then a friend at affinity 50+ who holds 3x (a named lender: half) for
    min(need, 1000) in $50s: a named lender gets friend_in_need; a townsperson lends at odds(.3 + .006 (aff - 50)
    + .3 (1 - thrift), +1, borrower luck)."""
    day = sim.clock.day
    loans = _loans(sim)
    owing = {row.get("borrower") for row in loans}
    iso = people.isolated(sim)
    for p in people.everyone(sim):
        if p.money >= -200 or not p.is_adult or p.id in owing or _cool(p, "borrow", day):
            continue
        amount = min(1000, int(math.ceil(-p.money / 50)) * 50)
        fam, friends = [], []
        for oid, r in p.relationships.items():
            q = people.person(sim, oid)
            if q is None or not q.alive or not q.is_adult or q.household_id == p.household_id:
                continue
            if iso and people.is_named(q) != people.is_named(p):
                continue
            need = amount / 2 if people.is_named(q) else amount * 3
            if q.money + q.savings < need:
                continue
            if r.kind is FAMILY:
                fam.append((-r.affinity, oid, q))
            elif r.kind is FRIEND and r.affinity >= 50:
                friends.append((-r.affinity, oid, q))
        fam.sort(key=lambda x: (x[0], x[1]))
        friends.sort(key=lambda x: (x[0], x[1]))
        pool = fam + friends
        if not pool:
            continue
        _set_cool(p, "borrow", day)
        lender = pool[0][2]
        if people.is_named(lender):
            if not _cool(lender, "friend_in_need", day) and people.prompt(
                    sim, lender, "friend_in_need", {"with": p.id, "amount": amount}):
                _set_cool(lender, "friend_in_need", day)
            continue
        r = lender.relationships.get(p.id)
        thrift = people.traits(lender).get("thrift", 0.5)
        prob = dice.odds(_clamp(0.3 + 0.006 * (r.affinity - 50) + 0.3 * (1 - thrift), 0.0, 1.0), +1, p.luck)
        roll = dice.roll(_ds(sim), dice.LEND, lender.id, p.id, day)
        people.log_roll(sim, p, "loan", prob, roll)
        if roll < prob:
            lend(sim, lender, p, amount)


def lend(sim, lender, borrower, amount) -> dict:
    st = sim.social
    st.loan_ids += 1
    row = {"id": f"l{st.loan_ids}", "lender": lender.id, "borrower": borrower.id, "amount": int(amount),
           "since": sim.clock.day}
    _loans(sim).append(row)
    lender.money -= amount
    borrower.money += amount
    bump(sim, borrower, lender, 5, 2)
    _count(sim, "loans")
    if people.is_named(lender) or people.is_named(borrower):
        who, other = (lender, borrower) if people.is_named(lender) else (borrower, lender)
        sim.event(f"{lender.name} lends {borrower.name} ${int(amount):,}.", who, tag="loan", agents=[other.id])
    return row


def _repay(sim, day) -> None:
    """A loan is repaid in one sum once the borrower holds 3x; forgiven after 90 days (lender affinity -15)."""
    loans = _loans(sim)
    keep = []
    for row in loans:
        if "lender" not in row:
            keep.append(row)
            continue
        lender, borrower = people.person(sim, row["lender"]), people.person(sim, row["borrower"])
        if lender is None or borrower is None or not lender.alive or not borrower.alive:
            continue
        amount = row["amount"]
        if borrower.money >= 3 * amount:
            borrower.money -= amount
            lender.money += amount
            bump(sim, lender, borrower, 3, 3)
            if people.is_named(lender) or people.is_named(borrower):
                who, other = (borrower, lender) if people.is_named(borrower) else (lender, borrower)
                sim.event(f"{borrower.name} pays {lender.name} back ${amount:,}.", who, tag="loan",
                          importance=0, agents=[other.id])
            continue
        if day - row["since"] >= 90:
            bump(sim, lender, borrower, -15, 0)
            continue
        keep.append(row)
    loans[:] = keep


# --- incidents ------------------------------------------------------------------------------------------------------

def _incidents(sim, classes) -> None:
    """Weekly, each workplace and school (Wednesday 11:00) and each block of homes (Sunday 20:00) with 3+ tied pairs
    present (acquaintances, coworkers, friends): an incident at odds(.04, -1, mean luck) between the pair who get on
    worst (lowest affinity both ways, then ids), affinity -15 and trust -5 both."""
    folk = getattr(sim, "folk", None)
    mixed = people.mixed(sim)
    present = {}
    for a in sim.agents.values():
        pl = _named_place(a)
        if pl is not None:
            present.setdefault(pl, []).append(a)
    st = sim.social
    week = sim.clock.day // 7
    for place_id, place in sim.town.places.items():
        cls = st.kind.get(place_id, "home")
        if cls not in classes:
            continue
        named = present.get(place_id, [])
        crowd = []
        if folk is not None and folk.n > 0:
            crowd = [folk.people[i] for i in folk.present(place_id)]
            crowd = [p for p in crowd if _folk_ok(p) and p.is_adult]
        groups = [named + crowd] if mixed else [named, crowd]
        for group in groups:
            group = [p for p in group if p.is_adult]
            if len(group) < 2:
                continue
            ids = {p.id for p in group}
            pairs = []
            for p in group:
                for oid, r in p.relationships.items():
                    if oid in ids and p.id < oid and r.kind in (COWORKER, ACQ, FRIEND):
                        back = people.person(sim, oid).relationships.get(p.id)
                        pairs.append((r.affinity + (back.affinity if back is not None else 0.0), p.id, oid))
            if len(pairs) < 3:
                continue
            luck = 0.0
            for p in group:
                luck += p.luck
            luck /= len(group)
            rr = dice.stream(_ds(sim), dice.INCIDENT, place_id, week, len(group))
            prob = dice.odds(0.04, -1, luck)
            roll = rr.random()
            if roll >= prob:
                continue
            _, lo, hi = min(pairs)  # it flares up between the two who get on worst
            a, b = people.person(sim, lo), people.person(sim, hi)
            people.log_roll(sim, a, "incident", prob, roll)
            bump(sim, a, b, -15, -15)
            for x, y in ((a, b), (b, a)):
                r = x.relationships.get(y.id)
                if r is not None:
                    r.trust = max(0.0, r.trust - 5)
            _count(sim, "incidents")
            if people.is_named(a) or people.is_named(b):
                who, other = (a, b) if people.is_named(a) else (b, a)
                why = ("over a missed shift" if cls == "work" else "over a broken pencil case" if cls == "school"
                       else "over the noise on the stairs")
                sim.event(f"{_first(a.name)} and {_first(b.name)} fall out {why} at {place.name}.", who, tag="row",
                          agents=[other.id], place=place_id)


# --- texts and invites to townsfolk ---------------------------------------------------------------------------------

def message_folk(sim, a, fid, text) -> dict:
    """sim.send_message to a townsperson: refused without a relationship; one reply by talk.reply as a v2 message
    from the townsperson; affinity +1 both."""
    folk = getattr(sim, "folk", None)
    b = folk.person(fid) if folk is not None else None
    if a is None or b is None or not a.alive or not b.alive:
        return {"ok": False, "error": "unknown or dead character"}
    r, back = a.relationships.get(fid), b.relationships.get(a.id)
    if r is None or back is None:
        return {"ok": False, "error": "you don't know them"}
    text = str(text)[:500]
    a.adjust("social", 3)
    b.adjust("social", 3)
    bump(sim, a, b, 1, 1)
    sim.event(f"{a.name} texts {b.name}: “{text[:80]}”", a, tag="text", agents=[fid])
    rr = dice.stream(_ds(sim), dice.FOLK_ANSWER, fid, a.id, sim.clock.tick)
    answer = talk.reply(back.affinity, b.mood, rr)
    b.remember(sim.clock.stamp(), f"Texted by {a.name}.")
    sim._deliver(a, {"type": "message", "from": fid, "from_name": b.name, "to": a.id, "text": answer,
                     "time": sim.clock.stamp()})
    a.inbox.append({"time": sim.clock.stamp(), "from": fid, "text": answer})
    del a.inbox[:-30]
    return {"ok": True}


FOLK_TEXTS = ["Hey! Thinking of you. How are things?", "Coffee sometime this week?", "Saw something that made me "
              "think of you!", "Hope your week is going well.", "Are you free on the weekend?"]


def _folk_texts(sim) -> None:
    """Weekly (Saturday 12:00): each townsperson friend at affinity 40+ texts a named friend at .3."""
    if not people.mixed(sim):
        return
    week = sim.clock.day // 7
    for a in sim.agents.values():
        if not a.alive:
            continue
        for oid, r in list(a.relationships.items()):
            if not people.is_folk_id(oid) or r.kind is not FRIEND:
                continue
            f = people.person(sim, oid)
            back = f.relationships.get(a.id) if f is not None else None
            if f is None or not f.alive or back is None or back.affinity < 40:
                continue
            rr = dice.stream(_ds(sim), dice.FOLK_ANSWER, oid, a.id, week)
            if rr.random() >= 0.3:
                continue
            text = FOLK_TEXTS[math.floor(rr.random() * len(FOLK_TEXTS))]
            a.inbox.append({"time": sim.clock.stamp(), "from": oid, "text": text})
            del a.inbox[:-30]
            a.adjust("social", 3)
            sim._deliver(a, {"type": "message", "from": oid, "from_name": f.name, "to": a.id, "text": text,
                             "time": sim.clock.stamp()})
            _count(sim, "folk_texts")


def _named_may_go(sim, a, place_id) -> bool:
    try:
        from . import travel
    except ImportError:
        return True
    fn = getattr(travel, "named_may_visit", None)
    return True if fn is None else bool(fn(sim, a, place_id))


def invite_folk(sim, host, guest_id, place_id):
    """sim.invite to a townsperson: a record "fi<n>" in sim.social.folk_invites (never sim.invites), answered on
    the next tick. A townsperson host never invites."""
    folk = getattr(sim, "folk", None)
    guest = folk.person(guest_id) if folk is not None else None
    if (host is None or not people.is_named(host) or not host.alive or guest is None or not guest.alive
            or place_id not in sim.town.places or not _named_may_go(sim, host, place_id)):
        return None
    if people.isolated(sim):
        return None
    st = sim.social
    st.invite_ids += 1
    inv = {"id": f"fi{st.invite_ids}", "from": host.id, "to": guest_id, "place": place_id, "tick": sim.clock.tick,
           "status": "pending"}
    st.folk_invites[inv["id"]] = inv
    place = sim.town.places[place_id].name
    sim.event(f"{host.name} invites {guest.name} to {place}.", host, tag="invite", agents=[guest_id], place=place_id)
    return inv


def _answer_folk_invites(sim) -> None:
    st = sim.social
    f = _folk_mod()
    for iid in sorted(st.folk_invites, key=lambda k: int(k[2:])):
        inv = st.folk_invites[iid]
        if inv["status"] != "pending":
            if sim.clock.tick - inv["tick"] > 120:
                del st.folk_invites[iid]
            continue
        if sim.clock.tick <= inv["tick"]:
            continue
        host, guest = people.person(sim, inv["from"]), people.person(sim, inv["to"])
        place = sim.town.places[inv["place"]]
        yes = False
        if host is not None and guest is not None and host.alive and guest.alive and f is not None:
            if f.is_free(sim, guest) and place.is_open(sim.clock.hour + 0.5):
                r = guest.relationships.get(host.id)
                aff = r.affinity if r is not None else 0.0
                prob = dice.odds(_clamp(0.4 + 0.4 * people.traits(guest).get("social", 0.5) + aff / 200, 0.0, 1.0),
                                 +1, host.luck)
                roll = dice.roll(_ds(sim), dice.FOLK_ANSWER, iid)
                people.log_roll(sim, host, "folk_invite", prob, roll)
                yes = roll < prob
        inv["status"] = "accept" if yes else "decline"
        if host is None or guest is None:
            continue
        if yes:
            f.send_to(sim, guest, inv["place"], "hang_out", 90)
        words = "accepts" if yes else "declines"
        sim.event(f"{guest.name} {words} {_first(host.name)}'s invite.", host,
                  tag="invite_accepted" if yes else "invite_declined", agents=[guest.id], place=inv["place"])
        sim._deliver(host, {"type": "invite_answer", "invite_id": iid, "from": guest.id,
                            "answer": "accept" if yes else "decline"})


def pick_companion(sim, p, why):
    """A townsperson's company for an outing (folk's day_off / evening hang_out): their closest free townsperson
    friend or date (affinity 30+), or None. Never a named."""
    f = _folk_mod()
    if f is None:
        return None
    best, best_key = None, None
    for oid, r in p.relationships.items():
        if not people.is_folk_id(oid) or r.kind not in (FRIEND, DATING, PARTNER) or r.affinity < 30:
            continue
        q = people.person(sim, oid)
        if q is None or not q.alive or q.household_id == p.household_id or not f.is_free(sim, q):
            continue
        key = (-r.affinity, oid)
        if best_key is None or key < best_key:
            best, best_key = q, key
    return best


# --- the view ---------------------------------------------------------------------------------------------------------

def talks_json(sim) -> list:
    """state.talks (PLAN 2.10): [[place_index | -1, a_id, b_id, tone, tick], ...] for the talks begun in the last
    10 game minutes: every talk with a named first, then townsfolk-only talks (at most one per place), newest
    first, at most 20 rows."""
    st = getattr(sim, "social", None)
    if st is None:
        return []
    t = sim.clock.tick
    named, folk_rows, seen = [], [], set()
    for tk, a, b, tone, place in reversed(st.talks):
        if t - tk >= TALKS_WINDOW:
            break
        idx = st.place_index.get(place, -1)
        row = [idx, a, b, tone, tk]
        if not people.is_folk_id(a) or not people.is_folk_id(b):
            named.append(row)
        elif idx < 0 or idx not in seen:
            seen.add(idx)
            folk_rows.append(row)
    return (named + folk_rows)[:TALKS_SHOWN]


# --- the start ----------------------------------------------------------------------------------------------------------

def _closest_eligible(sim, p):
    best, best_key = None, None
    for oid, r in p.relationships.items():
        q = people.person(sim, oid)
        if q is None or not q.alive or not eligible(sim, p, q):
            continue
        key = (-r.affinity, oid)
        if best_key is None or key < best_key:
            best, best_key = q, key
    return best


def seed_story(sim) -> None:
    """The social half of the start (life.md 5.9), on the STORY stream: 25% of people 13+ get one tie 5-10 below
    FRIEND_AT; 3% a rival among their ties (-20 to -40); 4% of single adults 18-50 are dating an eligible tie
    (romance and affinity 45-60, 5-40 days in); 6% have a one-sided crush (romance 20-40). Named couples sharing a
    surname start married at romance 70. Fixed: Efrat Sasson and Amir Amar dating 20 days (romance 55, affinity
    50); Tom Levi's crush (romance 32, affinity 25) on his closest eligible tie, else Ari Ben-David."""
    ds = _ds(sim)
    t = sim.clock.tick
    everyone = people.everyone(sim)
    for p in everyone:
        if p.age < 13:
            continue
        rr = dice.stream(ds, dice.STORY, p.id, "ties")
        x = rr.random()
        ties = sorted(oid for oid, r in p.relationships.items()
                      if r.kind in (COWORKER, ACQ, FRIEND) and r.affinity < FRIEND_AT)
        if not ties:
            continue
        q = people.person(sim, ties[math.floor(rr.random() * len(ties))])
        if q is None or q.relationships.get(p.id) is None:
            continue
        if x < 0.25:
            v = FRIEND_AT - rr.int(5, 10)
            p.relationships[q.id].affinity = v
            q.relationships[p.id].affinity = v
        elif x < 0.28:
            v = -rr.int(20, 40)
            for r in (p.relationships[q.id], q.relationships[p.id]):
                r.affinity = v
                r.kind = RIVAL
    for p in everyone:
        if p.age < 18 or p.age > 50:
            continue
        rr = dice.stream(ds, dice.STORY, p.id, "love")
        x = rr.random()
        if x >= 0.10 or partner_of(sim, p) is not None:
            continue
        cands = sorted(oid for oid, r in p.relationships.items() if r.kind in (COWORKER, ACQ, FRIEND))
        cands = [people.person(sim, oid) for oid in cands]
        cands = [q for q in cands if q is not None and eligible(sim, p, q)]
        if not cands:
            continue
        q = cands[math.floor(rr.random() * len(cands))]
        if x < 0.04:
            rom, aff = rr.int(45, 60), rr.int(45, 60)
            people.set_rel(sim, p.id, q.id, DATING, aff, romance=float(rom), since=t - rr.int(5, 40) * DAY, seen=t)
        else:
            r = p.relationships[q.id]
            r.romance = float(rr.int(20, 40))
            r.affinity = max(r.affinity, 22.0)
    for a in sim.agents.values():  # named couples sharing a surname are married
        for oid, r in a.relationships.items():
            b = sim.agents.get(oid)
            if r.kind is PARTNER and b is not None and a.name.split()[-1] == b.name.split()[-1]:
                r.married = True
                r.romance = max(r.romance, 70.0)
    efrat, amir = sim.agents.get("efrat"), sim.agents.get("amir")
    if efrat is not None and amir is not None and partner_of(sim, efrat) is None and partner_of(sim, amir) is None:
        people.set_rel(sim, "efrat", "amir", DATING, 50, romance=55.0, since=t - 20 * DAY, seen=t)
    tom = sim.agents.get("tom")
    if tom is not None and partner_of(sim, tom) is None:
        target = _closest_eligible(sim, tom) or sim.agents.get("ari")
        if target is not None:
            if tom.relationships.get(target.id) is None or target.relationships.get(tom.id) is None:
                people.set_rel(sim, tom.id, target.id, ACQ, 25, seen=t, since=t)
            r = tom.relationships[target.id]
            r.romance = 32.0
            r.affinity = 25.0
    if getattr(sim, "social", None) is not None:
        _rebuild_couples(sim)

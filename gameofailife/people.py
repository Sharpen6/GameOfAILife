"""The one person contract (life.md 3.2, PLAN 2.2): both tiers, the 60 named and the townsfolk.

Every rule that can meet a townsperson looks people up here, so a folk id ("f17") and a named id ("dana") are
handled alike. Until the townsfolk land, `sim.folk` is a `NoFolk`: no one, every call a no-op.

Both kinds hold `relationships: dict[str, Relationship]` (written only through `set_rel` or the social rules) and
`life` (life.LifeState). Named prompts (forks that come from life's rules, life.md 6) queue in `agent.life.pending`
through `prompt` and are built by `pending_fork` (in `forks.BUILDERS` after `sleep_fork`) through `PROMPTS[kind]`;
an option's `extra["life"]` goes to `HANDLERS[fork.kind]`, and outcome keys starting with `life_` to `EFFECTS`.
"""

from __future__ import annotations

import json
from collections import deque

from . import chronicle, dice
from .agent import Relationship, RelationKind

FOLK_NEWS_CAP = 60  # notable events about townsfolk alone a game day; the 61st on is dropped (life.md 3.4)
PROMPT_MAX = 3  # prompts queued at once (one per kind)
PROMPT_DAYS = 2  # ... dropped after this many game days unasked
REL_CAP = 60  # relationships a person keeps (social's upkeep enforces it)

# The 60 named characters' sex, for romance (life.md 5.3): the fixed cast, then every name cast.py can draw.
NAMED_SEX = {
    "dana": "f", "yossi": "m", "noa": "f", "miriam": "f", "tom": "m", "ari": "m", "avi": "m", "rina": "f",
    "lior": "m", "maya": "f", "eli": "m", "shira": "f", "ruth": "f", "david": "m", "omer": "m", "gal": "f",
    "yael": "f", "nadia": "f", "sami": "m", "leila": "f",
    # cast.FEMALE
    "adi": "f", "tamar": "f", "noga": "f", "hila": "f", "michal": "f", "yarden": "f", "shani": "f", "ronit": "f",
    "dalia": "f", "orly": "f", "sara": "f", "hana": "f", "rana": "f", "amira": "f", "lina": "f", "talia": "f",
    "inbal": "f", "keren": "f", "liat": "f", "efrat": "f", "mor": "f", "neta": "f", "yasmin": "f", "rotem": "f",
    "avigail": "f", "merav": "f", "sivan": "f", "galit": "f", "dina": "f", "lea": "f",
    # cast.MALE
    "itai": "m", "yoni": "m", "amir": "m", "nir": "m", "guy": "m", "ido": "m", "roee": "m", "eitan": "m",
    "uri": "m", "moshe": "m", "rami": "m", "karim": "m", "fadi": "m", "omar": "m", "ziv": "m", "erez": "m",
    "boaz": "m", "ronen": "m", "shai": "m", "gil": "m", "asaf": "m", "dror": "m", "yuval": "m", "noam": "m",
    "tomer": "m", "hadi": "m", "elad": "m", "yaniv": "m", "oren": "m", "ben": "m",
}

PROMPTS: dict = {}  # prompt kind -> builder(sim, agent, ctx) -> forks.Fork | None
HANDLERS: dict = {}  # fork kind -> handler(sim, agent, fork, opt, value) for an option's extra["life"]
EFFECTS: dict = {}  # outcome key ("life_rel", "life_rom", ...) -> fn(sim, agent, value)


# --- ids and lookups ---------------------------------------------------------------------------------------------

def is_folk_id(x) -> bool:
    """A townsperson's id: "f" followed by digits. Named ids hold no digits."""
    return isinstance(x, str) and len(x) > 1 and x[0] == "f" and x[1:].isdigit()


def folk_index(pid: str) -> int:
    """The index in `Folk.people` of a townsperson's id ("f17" -> 17)."""
    return int(pid[1:])


def _folk(sim):
    folk = getattr(sim, "folk", None)
    return folk if folk is not None else _NOBODY


def dice_seed(sim) -> int:
    """The behaviour dice's seed: `sim.dice_seed`, else the city's seed (a v2 Simulation)."""
    ds = getattr(sim, "dice_seed", None)
    return sim.seed if ds is None else ds


def person(sim, pid):
    """sim.agents[pid], else sim.folk.person(pid), else None."""
    a = sim.agents.get(pid)
    if a is not None:
        return a
    if is_folk_id(pid):
        return _folk(sim).person(pid)
    return None


def household_by_id(sim, hid):
    hh = sim.households.get(hid)
    if hh is not None:
        return hh
    return _folk(sim).household(hid)


def name_of(sim, pid) -> str:
    """The full name, or the id itself for nobody known."""
    p = person(sim, pid)
    return p.name if p is not None else pid


def everyone(sim) -> list:
    """The living named in cast order, then the living townsfolk by index."""
    return [a for a in sim.agents.values() if a.alive] + list(_folk(sim).living())


def is_named(p) -> bool:
    return not is_folk_id(p.id)


def mixed(sim) -> bool:
    """Townsfolk exist and are not isolated: named rooms, romance and lending may take them in."""
    folk = _folk(sim)
    return folk.n > 0 and not folk.isolated


def isolated(sim) -> bool:
    return _folk(sim).isolated


def traits(p) -> dict:
    if p.profile is not None:
        return p.profile.traits
    return p.traits


def sex(p) -> str:
    s = NAMED_SEX.get(p.id)
    if s is None:
        s = getattr(p, "sex", None) or "f"
    return s


def household(sim, p):
    return household_by_id(sim, p.household_id)


def home_id(sim, p) -> str | None:
    """The home unit: "cedar_court_1b", "main_20", a folk home; None without a household."""
    hh = household(sim, p)
    return hh.home_id if hh is not None else None


def members(sim, p) -> list:
    """The living people of p's household, p included."""
    hh = household(sim, p)
    if hh is None:
        return [p] if p.alive else []
    out = []
    for m in hh.member_ids:
        q = person(sim, m)
        if q is not None and q.alive:
            out.append(q)
    return out


def settle(sim, p) -> None:
    """A townsperson's lazy needs brought forward to now; an Agent needs nothing."""
    if is_folk_id(p.id):
        p.settle(sim.clock.tick)


# --- relationships -----------------------------------------------------------------------------------------------

def rel(p, oid):
    return p.relationships.get(oid)


def _kind(kind) -> RelationKind:
    return kind if isinstance(kind, RelationKind) else RelationKind(kind)


def set_rel(sim, a_id, b_id, kind, affinity, affinity_b=None, **fields) -> None:
    """Both sides of a relationship, created or overwritten: a's toward b at `affinity`, b's toward a at
    `affinity_b` (default the same). `fields` (trust, romance, since, seen, married, talks) go on both sides."""
    a, b = person(sim, a_id), person(sim, b_id)
    if a is None or b is None or a is b:
        return
    k = _kind(kind)
    a.relationships[b_id] = Relationship(k, float(affinity), **fields)
    b.relationships[a_id] = Relationship(k, float(affinity if affinity_b is None else affinity_b), **fields)


def rel_row(sim, oid, r) -> dict:
    """One relationship row for pages and the server's "relationships" answer (no odds, no chemistry)."""
    return {"id": oid, "name": name_of(sim, oid), "named": not is_folk_id(oid), **r.to_json(),
            "romance": round(r.romance), "married": r.married}


# --- hidden odds and the news cap --------------------------------------------------------------------------------

def log_roll(sim, p, what, prob, roll) -> None:
    """One luck-shifted roll (life.md 5.11): `(tick, id, luck, what, p, roll)` into sim.life.luck_log (named) or
    sim.folk.luck_log; with `--luck-log`, also into a buffer written as v2's JSON lines once each game hour."""
    tick = sim.clock.tick
    row = (tick, p.id, p.luck, what, prob, roll)
    owner = getattr(sim, "folk", None) if is_folk_id(p.id) else getattr(sim, "life", None)
    log = getattr(owner, "luck_log", None)
    if log is not None:
        log.append(row)
    if getattr(sim, "luck_log_path", None):
        buf = sim.__dict__.get("_luck_rows")
        if buf is None:
            buf = sim._luck_rows = [tick // 60, []]
        if buf[0] != tick // 60:
            flush_luck_log(sim)
            buf[0] = tick // 60
        buf[1].append(row)


def flush_luck_log(sim) -> None:
    """Write the buffered rolls to `sim.luck_log_path` as v2's JSON lines."""
    buf = sim.__dict__.get("_luck_rows")
    path = getattr(sim, "luck_log_path", None)
    if not buf or not buf[1] or not path:
        return
    with open(path, "a") as f:
        f.write("".join(json.dumps({"tick": t, "agent": pid, "luck": round(luck, 1), "what": what, "base_p": None,
                                    "p": round(prob, 4), "roll": round(roll, 4), "hit": roll < prob}) + "\n"
                        for t, pid, luck, what, prob, roll in buf[1]))
    buf[1].clear()


def news_gate(sim, tag, importance, agent, agents) -> bool:
    """sim.event's first line (PLAN 2.8): False drops the event. A notable event (importance 1+) about townsfolk
    alone (it names a townsperson and no named) counts in sim.life.today["folk_news"]; from the 61st of the game
    day it is dropped. Everything else passes."""
    importance = chronicle.EVENT_TAGS[tag][1] if importance is None else importance
    if importance < 1:
        return True
    folk_seen = False
    if agent is not None:
        if not is_folk_id(agent.id):
            return True
        folk_seen = True
    for x in agents or ():
        if not is_folk_id(x):
            return True
        folk_seen = True
    if not folk_seen:
        return True
    today = getattr(getattr(sim, "life", None), "today", None)
    if today is None:  # no life yet: a counter of our own, by game day
        day = sim.clock.day
        state = sim.__dict__.get("_folk_news")
        if state is None or state[0] != day:
            state = sim._folk_news = [day, 0]
        state[1] += 1
        return state[1] <= FOLK_NEWS_CAP
    day = sim.clock.day
    if sim.__dict__.get("_folk_news_day") != day:  # a new game day, whoever clears sim.life.today
        sim._folk_news_day = day
        today["folk_news"] = 0
    today["folk_news"] = today.get("folk_news", 0) + 1
    return today["folk_news"] <= FOLK_NEWS_CAP


# --- choices: named prompts and settled folk choices -------------------------------------------------------------

def prompt(sim, agent, kind, ctx) -> bool:
    """Queue a named prompt (life.md 6): at most PROMPT_MAX, one per kind, dropped after PROMPT_DAYS unasked.
    False when it is not queued (a townsperson, no life yet, already queued, full)."""
    if is_folk_id(agent.id) or not agent.alive:
        return False
    life = agent.life
    pending = getattr(life, "pending", None)
    if pending is None:
        return False
    for q in pending:
        if q["kind"] == kind:
            return False
    if len(pending) >= PROMPT_MAX:
        return False
    pending.append({"kind": kind, "ctx": ctx, "tick": sim.clock.tick})
    return True


def _urgency(level: float) -> float:
    return ((100 - level) / 100) ** 2


def settle_choice(sim, p, kind, options) -> int:
    """A choice settled at once, without a fork: argmax(base + .6 style + need + afford + U(0, .08)), the U from
    the SETTLE stream. Townsfolk use it for every big moment; L2 for the named's deferred forks."""
    from . import housing  # lazy: housing imports forks, which may import this module

    t = traits(p)
    needs = p.needs
    rr = dice.stream(dice_seed(sim), dice.SETTLE, p.id, kind, sim.clock.tick)
    best, best_score = 0, None
    for i, opt in enumerate(options):
        style = 0.0
        for k, v in opt.tags.items():
            style += (t.get(k, 0.5) - 0.5) * 2 * v
        need = 0.0
        for n, g in opt.gains.items():
            if n in needs:
                need += _urgency(needs[n]) * g / 25
        if is_folk_id(p.id):
            afford = -1.0 if opt.cost > p.money + p.savings else 0.0
        else:
            afford = housing.afford_score(sim, p, opt)
        score = opt.base + 0.6 * style + need + afford + rr.uniform(0, 0.08)
        if best_score is None or score > best_score:
            best, best_score = i, score
    return best


def _awake_and_free(sim, agent) -> bool:
    if not agent.alive or agent.state == "deciding" or agent.activity in ("sleep", "hospital", "ward"):
        return False
    if agent.inside == "hospital":
        return False
    return not sim.on_shift_now(agent)


def pending_fork(sim, agent):
    """The oldest queued prompt built as a fork (forks.BUILDERS, after sleep_fork), when the person is awake, off
    shift, not deciding and not in hospital. Stale prompts (PROMPT_DAYS) and ones whose builder declines go."""
    pending = getattr(agent.life, "pending", None)
    if not pending:
        return None
    tick = sim.clock.tick
    pending[:] = [q for q in pending if tick - q["tick"] <= PROMPT_DAYS * 1440 and q["kind"] in PROMPTS]
    if not pending or not _awake_and_free(sim, agent):
        return None
    while pending:
        q = pending.pop(0)
        fork = PROMPTS[q["kind"]](sim, agent, q["ctx"])
        if fork is not None:
            fork.major = True
            return fork
    return None


def apply_extra(sim, agent, fork, opt) -> None:
    """sim._apply_extra's last line: an option's extra["life"] goes to HANDLERS[fork.kind]."""
    value = opt.extra.get("life")
    if value is None:
        return
    handler = HANDLERS.get(fork.kind)
    if handler is not None:
        handler(sim, agent, fork, opt, value)


def apply_effect(sim, agent, key, value) -> bool:
    """sim._apply_outcome: True when `key` is one of life's outcome keys (and it was applied)."""
    fn = EFFECTS.get(key)
    if fn is None:
        return False
    fn(sim, agent, value)
    return True


# --- townsfolk -----------------------------------------------------------------------------------------------------

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
        return None  # no townsfolk: no share of the hourly sample

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


_NOBODY = NoFolk()  # read-only stand-in for a Simulation without `folk` (never written: no state is kept on it)


def make_folk(sim, n: int, isolated: bool = False):
    """`sim.folk`: a `NoFolk` for n 0, else the townsfolk (`folk.Folk`, imported lazily)."""
    if not n:
        return NoFolk()
    from .folk import Folk  # lazy: folk imports people
    return Folk(sim, n, isolated)

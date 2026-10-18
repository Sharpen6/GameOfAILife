// Port of gameofailife/social.py: social life for both tiers (life.md 5.1-5.4): talk in rooms, friends, rivals,
// romance, dates, moving in, engagements and weddings, texts and invites to townsfolk, lending, incidents and upkeep.
// Same draws in the same order as the Python; relationships are Maps, kinds the RelationKind strings.
(function (G) {
  "use strict";
  const { hasOwn, getd, cmp, commas, cut, keepLast, firstName, lastName } = G.py;

  const RK = G.agent.RelationKind;
  const ACQ = RK.ACQUAINTANCE, COWORKER = RK.COWORKER, FRIEND = RK.FRIEND;
  const FAMILY = RK.FAMILY, PARTNER = RK.PARTNER, DATING = RK.DATING;
  const EX = RK.EX, RIVAL = RK.RIVAL;
  const TRAITS = G.agent.Profile.TRAITS;
  const DAY = 24 * 60;

  const TALK_P = { home: 0.13, block: 0.027, work: 0.06, school: 0.08, cafe: 0.29, park: 0.11 };
  const STRANGER_W = { home: 0.3, block: 0.6, work: 0.25, school: 0.4, cafe: 0.5, park: 0.5 };
  const CLASS_OF_KIND = { cafe: "cafe", venue: "cafe", park: "park", school: "school", station: "block" };
  const STEP = { warm: 1.6, pleasant: 0.5, awkward: -1.5, argument: -5.0 };
  const SOCIAL_GAIN = { warm: 10, pleasant: 6, awkward: 6, argument: 2 }; // a named gets g * (1 - need/100)**2 of it (converse)
  const TONE_CODE = { warm: 1, pleasant: 0, awkward: -1, argument: -1 };
  const TALKS_A_DAY = 10;
  const CANDIDATES = 6;
  const FIRST_AFFINITY = 10.0;
  const FRIEND_AT = G.chronicle.FRIEND_AT; // 40
  const RIVAL_AT = -15.0, RIVAL_OFF = 0.0;
  const REL_CAP = G.people.REL_CAP;
  const CHEM_MIN = 0.7;
  const ASK_ROMANCE = 30.0, ASK_AFFINITY = 20.0;
  const SKIP_ACTS = ["sleep", "hospital", "ward", "dead", "baby"];
  const WANDER = ["walk_park", "play"];
  const RING = 12; // a person's talk ring (life.talks)
  const TALKS_SHOWN = 20; // state.talks rows
  const TALKS_WINDOW = 10; // ... begun in the last 10 game minutes
  const TALKS_KEEP = 40; // sim.social.talks
  const DATE_HOUR = 17; // dates are arranged at 17:00 for the evening
  const WEDDING_HOUR = 14;
  const COOL = { crush: 5, asked_out: 3, date: 2, move_in: 14, propose: 30, proposal: 30,
    relationship_trouble: 7, partner_split: 7, friend_in_need: 7, borrow: 7 };

  const P = () => G.people;
  const D = () => G.dice;
  const nil = x => x === null || x === undefined;

  // sim.social: buckets (10 sorted lists of place ids), talks (the last 40 [tick, a, b, tone, place]),
  // folk_invites ("fi<n>" -> record), the day's couples, engagements and counters.
  class SocialState {
    constructor() {
      this.buckets = Array.from({ length: 10 }, () => []);
      this.talks = [];
      this.folk_invites = new Map();
      this.invite_ids = 0;
      this.loan_ids = 0;
      this.couples = []; // [lo id, hi id] of every dating or partner pair, rebuilt each night
      this.engaged = new Map(); // "lo|hi" -> wedding day
      this.counts = {}; // talks, friendships, rivals, couples, flirts, ... since the start
      this.place_index = new Map(); // place id -> index in town.places
      this.kind = new Map(); // place id -> talk class of a non-home place
      this.loans = []; // rows when sim.life has none
    }
  }

  const _ds = sim => P().dice_seed(sim);

  function init(sim) {
    const st = new SocialState();
    let i = 0;
    for (const [pid, place] of sim.town.places) {
      st.place_index.set(pid, i);
      i += 1;
      st.buckets[D().sid(pid) % 10].push(pid);
      if (place.kind !== "home") st.kind.set(pid, hasOwn(CLASS_OF_KIND, place.kind) ? CLASS_OF_KIND[place.kind] : "work");
    }
    for (const b of st.buckets) b.sort();
    sim.social = st;
    _rebuild_couples(sim);
  }

  const _folk_mod = () => (G.folk !== undefined ? G.folk : null);
  const _life_mod = () => G.life;

  function _loans(sim) {
    const loans = !nil(sim.life) ? sim.life.loans : undefined;
    return !nil(loans) ? loans : sim.social.loans;
  }

  function _bump_counter(c, key, n) {
    if (c instanceof Map) c.set(key, (c.get(key) || 0) + n);
    else c[key] = (c[key] || 0) + n;
  }

  function _count(sim, key, n = 1) {
    _bump_counter(sim.social.counts, key, n);
    const today = !nil(sim.life) ? sim.life.today : undefined;
    if (!nil(today)) _bump_counter(today, key, n);
  }

  const _first = name => firstName(name);
  const _lo_hi = (a, b) => (a < b ? [a, b] : [b, a]);
  const _has_pair = (list, lo, hi) => list.findIndex(x => x[0] === lo && x[1] === hi);

  // --- who is where ----------------------------------------------------------------------------------------------

  // The place a named character's room is in now, or null (asleep, travelling, in hospital, under 3, dead).
  function _named_place(a) {
    if (!a.alive || a.age < 3 || a.state === "travelling" || SKIP_ACTS.includes(a.activity)) return null;
    if (a.inside) return a.inside;
    if (a.state === "busy" && WANDER.includes(a.activity)) return a.activity_place;
    return null;
  }

  const _folk_ok = p => p.alive && p.age >= 3 && !SKIP_ACTS.includes(p.activity) && p.state !== "travelling";

  function _home_place(sim, hid) {
    const home = !nil(hid) ? sim.homes.get(hid) : undefined;
    return !nil(home) ? home.place : null;
  }

  // `group` (the people at one place) split into rooms: [[key parts, class, people], ...].
  function _rooms(sim, place_id, group) {
    const st = sim.social;
    const cls = st.kind.get(place_id);
    if (cls !== undefined) return [[[place_id], cls, group]];
    const units = new Map();
    const visitors = [];
    for (const p of group) {
      const hid = P().home_id(sim, p);
      if (!nil(hid) && _home_place(sim, hid) === place_id) {
        if (!units.has(hid)) units.set(hid, []);
        units.get(hid).push(p);
      } else {
        visitors.push(p);
      }
    }
    const hids = [...units.keys()].sort();
    const block = [];
    for (const v of visitors) {
      let best = null, best_aff = null;
      for (const hid of hids) {
        for (const r_ of units.get(hid)) {
          const r = v.relationships.get(r_.id);
          if (r !== undefined && (best_aff === null || r.affinity > best_aff)) { best = hid; best_aff = r.affinity; }
        }
      }
      if (best !== null && best_aff > 0) units.get(best).push(v);
      else block.push(v);
    }
    const rooms = hids.map(hid => [[hid], "home", units.get(hid)]);
    if (block.length) rooms.push([[place_id, "block"], "block", block]);
    return rooms;
  }

  // --- the tick ----------------------------------------------------------------------------------------------------

  function tick(sim) {
    const st = sim.social;
    if (nil(st)) return;
    const clock = sim.clock;
    const t = clock.tick;
    const m = clock.minute_of_day;
    if (m === 0) _nightly(sim);
    else if (m === DATE_HOUR * 60) _dates(sim);
    else if (m === 9 * 60) _lending(sim);
    else if (m === WEDDING_HOUR * 60 && st.engaged.size) _weddings(sim);
    const wd = clock.weekday;
    if (wd === 2 && m === 11 * 60) _incidents(sim, ["work", "school"]);
    else if (wd === 6 && m === 20 * 60) _incidents(sim, ["home"]);
    else if (wd === 5 && m === 12 * 60) _folk_texts(sim);
    if (st.folk_invites.size) _answer_folk_invites(sim);
    const b = t % 10;
    const named_at = new Map();
    for (const a of sim.agents.values()) {
      const pl = _named_place(a);
      if (pl !== null && pl !== undefined && D().sid(pl) % 10 === b) {
        if (!named_at.has(pl)) named_at.set(pl, []);
        named_at.get(pl).push(a);
      }
    }
    const folk = sim.folk;
    const has_folk = !nil(folk) && folk.n > 0;
    const mixed = has_folk && !folk.isolated;
    const places = has_folk ? st.buckets[b] : [...named_at.keys()].sort();
    for (const place_id of places) {
      const named = named_at.get(place_id);
      let crowd = [];
      if (has_folk) {
        const idx = folk.present(place_id);
        if (idx && idx.length) crowd = idx.map(i => folk.people[i]).filter(_folk_ok);
      }
      if (mixed || !named || !named.length) {
        const group = (named || []).concat(crowd);
        if (group.length >= 2) {
          for (const [parts, cls, room] of _rooms(sim, place_id, group)) {
            if (room.length >= 2) _run_room(sim, place_id, parts, cls, room, t);
          }
        }
      } else { // isolated: the named and the folk at one place never share a room
        if (named.length >= 2) {
          for (const [parts, cls, room] of _rooms(sim, place_id, named)) {
            if (room.length >= 2) _run_room(sim, place_id, parts, cls, room, t);
          }
        }
        if (crowd.length >= 2) {
          for (const [parts, cls, room] of _rooms(sim, place_id, crowd)) {
            if (room.length >= 2) _run_room(sim, place_id, parts.concat(["folk"]), cls, room, t);
          }
        }
      }
    }
  }

  const _talks_today = p => (!nil(p.life) ? p.life.talks_today : TALKS_A_DAY);

  // Under-13s talk only to under-18s and their own household.
  function _may_talk(sim, a, b) {
    if (a.age < 13 || b.age < 13) return (a.age < 18 && b.age < 18) || a.household_id === b.household_id;
    return true;
  }

  function _run_room(sim, place_id, parts, cls, room, t) {
    const rr = D().stream(_ds(sim), D().TALK, ...parts, t);
    const n = room.length;
    const k = Math.floor(TALK_P[cls] * n + rr.random());
    if (k <= 0) return;
    const busy = new Set();
    for (let i = 0; i < k; i++) {
      const a = room[Math.floor(rr.random() * n)];
      if (busy.has(a.id) || _talks_today(a) >= TALKS_A_DAY) continue;
      if (rr.random() >= 0.5 + 0.5 * getd(P().traits(a), "social", 0.5)) continue;
      let best = null, best_w = -1.0;
      const tries = Math.min(CANDIDATES, n - 1);
      for (let j = 0; j < tries; j++) {
        const b = room[Math.floor(rr.random() * n)];
        if (b === a || busy.has(b.id) || _talks_today(b) >= TALKS_A_DAY || !_may_talk(sim, a, b)) continue;
        const r = a.relationships.get(b.id);
        let w;
        if (r === undefined) {
          w = STRANGER_W[cls];
        } else {
          w = 1 + Math.max(0.0, r.affinity) / 10;
          if (r.kind === PARTNER || r.kind === DATING || r.kind === FAMILY) w *= 2;
          if (r.romance > 0) w *= 1 + r.romance / 10;
        }
        w *= 0.5 + rr.random();
        if (w > best_w) { best = b; best_w = w; }
      }
      if (best === null) continue;
      busy.add(a.id);
      busy.add(best.id);
      converse(sim, a, best, cls, place_id, t, rr);
    }
  }

  // --- one talk ------------------------------------------------------------------------------------------------------

  // Room for one more relationship: the acquaintance or coworker with |affinity| < 25 seen longest ago goes.
  function _evict(sim, p) {
    let weakest = null, wseen = null;
    for (const [oid, r] of p.relationships) {
      if ((r.kind === ACQ || r.kind === COWORKER) && Math.abs(r.affinity) < 25) {
        if (wseen === null || r.seen < wseen || (r.seen === wseen && oid < weakest)) { weakest = oid; wseen = r.seen; }
      }
    }
    if (weakest === null) return false;
    _drop(sim, p, weakest);
    return true;
  }

  function _drop(sim, p, oid) {
    p.relationships.delete(oid);
    const q = P().person(sim, oid);
    if (!nil(q)) q.relationships.delete(p.id);
  }

  // Both sides of a and b's relationship, created as acquaintances at FIRST_AFFINITY on a first talk; null when
  // either is full (REL_CAP) with nobody to let go.
  function _ensure(sim, a, b, t) {
    let ra = a.relationships.get(b.id), rb = b.relationships.get(a.id);
    if (ra !== undefined && rb !== undefined) return [ra, rb];
    if (ra === undefined && a.relationships.size >= REL_CAP && !_evict(sim, a)) return null;
    if (rb === undefined && b.relationships.size >= REL_CAP && !_evict(sim, b)) return null;
    const make = () => {
      const r = new G.agent.Relationship(ACQ, FIRST_AFFINITY);
      r.since = t;
      r.seen = t;
      return r;
    };
    if (ra === undefined) { ra = make(); a.relationships.set(b.id, ra); }
    if (rb === undefined) { rb = make(); b.relationships.set(a.id, rb); }
    _count(sim, "met");
    return [ra, rb];
  }

  function trait_gap(a, b) {
    const ta = P().traits(a), tb = P().traits(b);
    let d = 0.0;
    for (const k of TRAITS) d += Math.abs(getd(ta, k, 0.5) - getd(tb, k, 0.5));
    return d / TRAITS.length;
  }

  const compat = (a, b) => 0.6 * (0.33 - trait_gap(a, b));

  function _stressed(sim, p, t) {
    const life = p.life;
    if (!nil(life)) {
      if (life.conditions.length || life.grief_until > t) return true;
    }
    const hh = P().household(sim, p);
    return !nil(hh) && hh.arrears > 0;
  }

  const _clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

  // One talk between a and b: tone, both sides' affinity, needs, kinds, romance, contagion and, with a named, the
  // talk ring and an event. Returns the tone (null when neither had room for a new relationship).
  function converse(sim, a, b, cls, place_id, t, rr) {
    const pair = _ensure(sim, a, b, t);
    if (pair === null) return null;
    const [ra, rb] = pair;
    const d = trait_gap(a, b);
    const stress = (_stressed(sim, a, t) || _stressed(sim, b, t)) ? 0.1 : 0.0;
    const s = 0.004 * (ra.affinity + rb.affinity) / 2 + 0.6 * (0.33 - d) + 0.004 * (a.mood + b.mood - 120) - stress;
    const luck = (a.luck + b.luck) / 2;
    const p_warm = D().odds(_clamp(0.40 + s, 0.05, 0.85), +1, luck, 0.5);
    const p_arg = D().odds(_clamp(0.06 - 0.5 * s, 0.01, 0.30), -1, luck, 0.5);
    const x = rr.random();
    const tone = x < p_warm ? "warm" : x < p_warm + p_arg ? "argument" : x < p_warm + p_arg + 0.12 ? "awkward"
      : "pleasant";
    let step = STEP[tone];
    if (tone === "argument") {
      if (d > 0.33) step *= 1.6;
      if (ra.affinity < 0 || rb.affinity < 0) step *= 2;
    }
    ra.seen = rb.seen = t;
    ra.talks += 1;
    rb.talks += 1;
    for (const [r, me, other] of [[ra, a, b], [rb, b, a]]) {
      const before = r.affinity;
      const gain = step > 0 ? step * (1 - Math.max(0.0, before) / 100) : step;
      r.affinity = _clamp(before + gain, -100.0, 100.0);
      if (tone === "argument") r.trust = Math.max(0.0, r.trust - 3);
      on_affinity(sim, me.id, other.id, before, r.affinity);
    }
    const g = SOCIAL_GAIN[tone];
    for (const x of [a, b]) { // a named's gain shrinks as the need fills, so a chatty day can still end lonely (v2's forks)
      if (P().is_named(x)) {
        const f = 1 - x.needs.social / 100;
        x.adjust("social", g * f * f);
      } else x.adjust("social", g);
    }
    if (tone === "argument") {
      a.adjust("fun", -4);
      b.adjust("fun", -4);
    }
    if (!nil(a.life)) a.life.talks_today += 1;
    if (!nil(b.life)) b.life.talks_today += 1;
    _count(sim, "talks");
    const talks = sim.social.talks;
    talks.push([t, a.id, b.id, TONE_CODE[tone], place_id]);
    keepLast(talks, TALKS_KEEP);
    const life = _life_mod();
    if (life && life.infect) life.infect(sim, a, b);
    if (tone === "warm") {
      if (ra.kind === PARTNER || ra.kind === DATING) {
        ra.romance = Math.min(100.0, ra.romance + 2);
        rb.romance = Math.min(100.0, rb.romance + 2);
      } else if (eligible(sim, a, b)) {
        _flirt(sim, a, b, ra, rb, place_id);
      }
    }
    if (P().is_named(a) || P().is_named(b)) _named_talk(sim, a, b, ra, tone, cls, place_id);
    return tone;
  }

  // Kinds after a's affinity toward b moved from `before` to `after` (life.md 5.1.6): named pairs through
  // chronicle.on_affinity (v2's texts), others by the same rule (friend at FRIEND_AT, falling-out below 0, events
  // only with a named); for all, rival at RIVAL_AT and back to acquaintance above RIVAL_OFF.
  function on_affinity(sim, a_id, b_id, before, after) {
    const a = P().person(sim, a_id), b = P().person(sim, b_id);
    if (nil(a) || nil(b)) return;
    const r = a.relationships.get(b_id);
    if (r === undefined) return;
    const back = b.relationships.get(a_id);
    const named_a = P().is_named(a), named_b = P().is_named(b);
    const was = r.kind;
    if (named_a && named_b) {
      G.chronicle.on_affinity(sim, a_id, b_id, before, after);
      if (was !== FRIEND && r.kind === FRIEND) {
        _count(sim, "friendships");
        _count(sim, "friendships_named");
      }
    } else if ((was === ACQ || was === COWORKER) && before < FRIEND_AT && FRIEND_AT <= after) {
      r.kind = FRIEND;
      if (back !== undefined && (back.kind === ACQ || back.kind === COWORKER)) back.kind = FRIEND;
      _count(sim, "friendships");
      if (named_a || named_b) {
        _count(sim, "friendships_named");
        const [who, other] = named_a ? [a, b] : [b, a];
        const text = `${a.name} and ${b.name} have become friends.`;
        sim.event(text, who, null, { tag: "new_friend", importance: 1, agents: [other.id], place: _where_of(who) });
        other.remember(sim.clock.stamp(), text);
      }
    } else if ((was === FRIEND || was === PARTNER) && before >= 0 && 0 > after && (named_a || named_b)) {
      const [who, other] = named_a ? [a, b] : [b, a];
      sim.event(`${a.name} and ${b.name} have fallen out.`, who, null,
        { tag: "falling_out", importance: 1, agents: [other.id], place: _where_of(who) });
    }
    const kind = r.kind;
    if ((kind === ACQ || kind === COWORKER || kind === FRIEND) && before > RIVAL_AT && RIVAL_AT >= after) {
      r.kind = RIVAL;
      if (back !== undefined && (back.kind === ACQ || back.kind === COWORKER || back.kind === FRIEND)) back.kind = RIVAL;
      _count(sim, "rivals");
      if (named_a || named_b) {
        const [who, other] = named_a ? [a, b] : [b, a];
        sim.event(`${a.name} and ${b.name} can't stand each other now.`, who, null,
          { tag: "rival", agents: [other.id], place: _where_of(who) });
      }
    } else if (kind === RIVAL && before <= RIVAL_OFF && RIVAL_OFF < after) {
      r.kind = ACQ;
      if (back !== undefined && back.kind === RIVAL) back.kind = ACQ;
    }
  }

  const _where_of = p => p.inside || p.activity_place;

  // a's affinity toward b by `value` and b's toward a by `back` (default value / 2), kinds updated.
  function bump(sim, a, b, value, back = null) {
    const pair = _ensure(sim, a, b, sim.clock.tick);
    if (pair === null) return;
    for (const [r, me, other, v] of [[pair[0], a, b, value], [pair[1], b, a, back === null ? value / 2 : back]]) {
      const before = r.affinity;
      r.affinity = _clamp(before + v, -100.0, 100.0);
      on_affinity(sim, me.id, other.id, before, r.affinity);
    }
  }

  // --- what the named say ---------------------------------------------------------------------------------------------

  function _recent(p, tags, days, day) {
    const life = p.life;
    if (nil(life)) return false;
    for (const tg of tags) {
      const d = getd(life.recent, tg, null);
      if (d !== null && day - d <= days) return true;
    }
    return false;
  }

  // A usable headline for talk (life.md 5.2): importance 2, within 2 days, never God-only or a controller's.
  function _headline(sim) {
    const t = sim.clock.tick;
    const hl = sim.headlines;
    for (let i = hl.length - 1; i >= 0; i--) {
      const ev = hl[i];
      if (t - ev.tick > 2 * DAY) return null;
      if (G.chronicle.GOD_ONLY_TAGS.has(ev.tag) || ev.kind === "controller" || ev.kind === "social") continue;
      return ev.text;
    }
    return null;
  }

  // p has talked about this headline already (in their last RING talks).
  function _told(p, headline) {
    const life = p.life;
    if (nil(life)) return false;
    for (const t of life.talks) if (t.topic === "news" && t.text.includes(headline)) return true;
    return false;
  }

  function _kid_of(sim, p) {
    for (const m of P().members(sim, p)) {
      if (m !== p && m.age < 18) {
        const r = p.relationships.get(m.id);
        if (r !== undefined && r.kind === FAMILY && p.age - m.age >= 16) return m;
      }
    }
    return null;
  }

  const MONEY_TAGS = ["laid_off", "job_lost", "in_red", "raise", "windfall"];

  function talk_ctx(sim, a, b, ra, cls, place_id) {
    const day = sim.clock.day;
    let partner = null; // someone's partner who is not in the talk
    for (const [x, y] of [[a, b], [b, a]]) {
      const q = partner_of(sim, x);
      if (q !== null && q !== y) { partner = q; break; }
    }
    const kid = _kid_of(sim, a) || _kid_of(sim, b);
    const lm = _life_mod();
    const ill = Boolean(lm.ill(a) || lm.ill(b) || _recent(a, ["discharged"], 7, day) || _recent(b, ["discharged"], 7, day));
    let illness = null;
    for (const p of [a, b]) {
      if (!nil(p.life) && p.life.conditions.length) { illness = p.life.conditions[0].id.replace(/_/g, " "); break; }
    }
    let headline = _headline(sim);
    if (headline !== null && (_told(a, headline) || _told(b, headline))) headline = null; // old news to one of them
    const place = sim.town.places.get(place_id);
    const job = !nil(a.job) ? a.job : b.job;
    const work = !nil(job) ? sim.town.places.get(job.place_id) : undefined;
    return {
      rain: sim.weather === "rain",
      coworkers: !nil(a.job) && !nil(b.job) && a.job.place_id === b.job.place_id && a.job.title !== "student"
        && cls === "work",
      pupils: cls === "school" && a.age < 18 && b.age < 18,
      money: _recent(a, MONEY_TAGS, 7, day) || _recent(b, MONEY_TAGS, 7, day),
      family: partner !== null || kid !== null,
      baby: kid !== null && kid.age === 0,
      health: ill,
      love: ra.kind === DATING || ra.romance >= 20,
      headline,
      place: !nil(place) ? place.name : null,
      work: !nil(work) ? work.name : null,
      kid: kid !== null ? _first(kid.name) : null,
      partner: partner !== null ? _first(partner.name) : null,
      illness,
    };
  }

  const TOPIC_WORDS = { weather: "the weather", work: "work", school: "school", money: "money",
    family: "family", health: "how they feel", news: "the news", love: "how they feel" };

  function _named_talk(sim, a, b, ra, tone, cls, place_id) {
    const rr = D().stream(_ds(sim), D().TALK, a.id, b.id, sim.clock.tick);
    const ctx = talk_ctx(sim, a, b, ra, cls, place_id);
    const tp = G.talk.topic(ctx, rr.random());
    const text = G.talk.line(tp, tone, ctx, rr);
    const place = sim.town.places.get(place_id);
    const where = !nil(place) && cls !== "home" ? ` at ${place.name}` : cls === "home" ? " at home" : "";
    const stamp = sim.clock.stamp();
    for (const [x, y] of [[a, b], [b, a]]) {
      if (P().is_named(x) && !nil(x.life)) {
        x.life.talks.push({ time: stamp, with: y.id, name: y.name, topic: tp, tone, text, place: place_id });
        keepLast(x.life.talks, RING);
      }
    }
    if (tone === "argument" || (cls !== "home" && (tone === "warm" || tp === "news" || tp === "love" || ctx.baby))) {
      const [who, other] = P().is_named(a) ? [a, b] : [b, a];
      const verb = tone === "argument" ? "argue about" : "chat about";
      sim.event(`${a.name} and ${b.name} ${verb} ${TOPIC_WORDS[tp]}${where}: ${text}`, who, null,
        { tag: "talk", agents: [other.id], place: place_id, remember: false });
    }
  }

  // --- romance -------------------------------------------------------------------------------------------------------

  // p's living partner or date, or null.
  function partner_of(sim, p) {
    for (const [oid, r] of p.relationships) {
      if (r.kind === PARTNER || r.kind === DATING) {
        const q = P().person(sim, oid);
        if (!nil(q) && q.alive) return q;
      }
    }
    return null;
  }

  const _orient = (sim, p) => D().roll(_ds(sim), D().ORIENT, p.id) < 0.08;

  const attracted = (sim, a, b) => P().sex(a) !== P().sex(b) || (_orient(sim, a) && _orient(sim, b));

  // Both 18+, single, not family or one household, the age gap at most max(4, younger // 4), neither widowed in
  // 90 days, attracted; never across tiers while the townsfolk are isolated.
  function eligible(sim, a, b) {
    if (a.age < 18 || b.age < 18 || a.household_id === b.household_id) return false;
    if (Math.abs(a.age - b.age) > Math.max(4, Math.floor(Math.min(a.age, b.age) / 4))) return false;
    if (P().is_named(a) !== P().is_named(b) && P().isolated(sim)) return false;
    const r = a.relationships.get(b.id);
    if (r !== undefined && (r.kind === FAMILY || r.kind === EX)) return false;
    const day = sim.clock.day;
    for (const p of [a, b]) {
      if (!nil(p.life) && !nil(p.life.widowed_day) && day - p.life.widowed_day < 90) return false;
    }
    if (!attracted(sim, a, b)) return false;
    return partner_of(sim, a) === null && partner_of(sim, b) === null;
  }

  // Never stored or shown.
  function chemistry(sim, a, b) {
    const [lo, hi] = _lo_hi(a.id, b.id);
    return D().roll(_ds(sim), D().CHEM, lo, hi);
  }

  function _flirt(sim, a, b, ra, rb, place_id) {
    const chem = chemistry(sim, a, b);
    if (chem < CHEM_MIN) return;
    const g = 6 + 14 * (chem - CHEM_MIN) / (1 - CHEM_MIN);
    ra.romance = Math.min(100.0, ra.romance + g);
    rb.romance = Math.min(100.0, rb.romance + g);
    _count(sim, "flirts");
    if (P().is_named(a) || P().is_named(b)) {
      _count(sim, "flirts_named");
      const [who, other] = P().is_named(a) ? [a, b] : [b, a];
      sim.event(`${a.name} and ${b.name} flirt a little.`, who, null,
        { tag: "flirt", agents: [other.id], place: place_id, remember: false });
    }
    const [asker, target, rs] = ra.romance >= rb.romance ? [a, b, ra] : [b, a, rb];
    if (rs.romance >= ASK_ROMANCE && rs.affinity >= ASK_AFFINITY) ask_out(sim, asker, target);
  }

  // True while `kind` is cooling down for p (life.cooldowns: kind -> first day it may come again).
  function _cool(p, kind, day) {
    const life = p.life;
    return !nil(life) && getd(life.cooldowns, kind, -1) > day;
  }

  function _set_cool(p, kind, day) {
    if (!nil(p.life)) p.life.cooldowns[kind] = day + COOL[kind];
  }

  // The ask-out (life.md 5.3): a named asker gets `crush`, a named target `asked_out`; between townsfolk the answer
  // is rolled at once.
  function ask_out(sim, asker, target) {
    const day = sim.clock.day;
    if (P().is_named(asker)) {
      if (!_cool(asker, "crush", day) && P().prompt(sim, asker, "crush", { with: target.id })) _set_cool(asker, "crush", day);
      return;
    }
    if (P().is_named(target)) {
      if (!_cool(target, "asked_out", day) && P().prompt(sim, target, "asked_out", { with: asker.id })) {
        _set_cool(target, "asked_out", day);
      }
      return;
    }
    folk_answer(sim, asker, target);
  }

  // A townsperson asked out: yes at odds(min(.95, .35 + .5 (chem - .7)/.3 + .004 (aff - 20) + .004 rom), +1, asker
  // luck). Yes: dating; no: the asker's romance -20, affinity -3.
  function folk_answer(sim, asker, target) {
    const ra = asker.relationships.get(target.id), rt = target.relationships.get(asker.id);
    if (ra === undefined || rt === undefined) return false;
    const chem = chemistry(sim, asker, target);
    const p = D().odds(Math.min(0.95, 0.35 + 0.5 * (chem - CHEM_MIN) / (1 - CHEM_MIN) + 0.004 * (rt.affinity - 20)
      + 0.004 * rt.romance), +1, asker.luck);
    const roll = D().roll(_ds(sim), D().ASK, asker.id, target.id, sim.clock.tick);
    P().log_roll(sim, asker, "ask_out", p, roll);
    if (roll < p) {
      start_dating(sim, asker, target);
      return true;
    }
    ra.romance = Math.max(0.0, ra.romance - 20);
    bump(sim, asker, target, -3, 0);
    return false;
  }

  function start_dating(sim, a, b) {
    const t = sim.clock.tick;
    const pair = _ensure(sim, a, b, t);
    if (pair === null) return;
    const [ra, rb] = pair;
    ra.kind = rb.kind = DATING;
    ra.since = rb.since = t;
    ra.romance = Math.max(ra.romance, ASK_ROMANCE);
    rb.romance = Math.max(rb.romance, ASK_ROMANCE);
    _count(sim, "couples");
    const st = sim.social;
    const [lo, hi] = _lo_hi(a.id, b.id);
    if (_has_pair(st.couples, lo, hi) < 0) st.couples.push([lo, hi]);
    if (P().is_named(a) || P().is_named(b)) {
      _count(sim, "couples_named");
      const [who, other] = P().is_named(a) ? [a, b] : [b, a];
      sim.event(`${a.name} and ${b.name} are going out!`, who, null,
        { tag: "partner", agents: [other.id], place: _where_of(who) });
    }
    _jealousy(sim, a, b);
    _jealousy(sim, b, a);
  }

  // A new couple costs everyone with romance 20+ toward x 20 affinity toward y (life.md 5.1.7).
  function _jealousy(sim, x, y) {
    for (const zid of [...x.relationships.keys()]) {
      if (zid === y.id) continue;
      const z = P().person(sim, zid);
      if (nil(z) || !z.alive) continue;
      const rz = z.relationships.get(x.id);
      if (rz === undefined || rz.romance < 20) continue;
      if (P().is_named(z) !== P().is_named(y) && P().isolated(sim)) continue;
      bump(sim, z, y, -20, -5);
      _count(sim, "jealous");
    }
  }

  // Both sides become exes, affinity -15 each; a married couple divorces ($1,500 each).
  function end_couple(sim, a, b, why = "breakup") {
    const ra = a.relationships.get(b.id), rb = b.relationships.get(a.id);
    if (ra === undefined || rb === undefined) return;
    const married = ra.married || rb.married;
    const cohabit = ra.kind === PARTNER;
    ra.kind = rb.kind = EX;
    ra.married = rb.married = false;
    ra.romance = rb.romance = 0.0;
    ra.since = rb.since = sim.clock.tick;
    bump(sim, a, b, -15, -15);
    const [lo, hi] = _lo_hi(a.id, b.id);
    const st = sim.social;
    const i = _has_pair(st.couples, lo, hi);
    if (i >= 0) st.couples.splice(i, 1);
    st.engaged.delete(`${lo}|${hi}`);
    _count(sim, "breakups");
    const tag = married ? "divorce" : "breakup";
    if (married) {
      a.money -= 1500;
      b.money -= 1500;
    }
    const named = P().is_named(a) || P().is_named(b);
    if (named || married) {
      const [who, other] = P().is_named(a) || !P().is_named(b) ? [a, b] : [b, a];
      const text = married ? `${a.name} and ${b.name} are divorcing.`
        : cohabit ? `${a.name} and ${b.name} have split up.` : `${a.name} and ${b.name} have broken up.`;
      sim.event(text, who, null, { tag, importance: named ? null : 1, agents: [other.id], place: _where_of(who) });
    }
    if (cohabit) _leave_home(sim, why === "b_leaves" ? b : a);
  }

  // After a split the leaver moves out: a named through life.split, a townsperson through folk.split.
  function _leave_home(sim, p) {
    if (P().is_named(p)) {
      const lm = _life_mod();
      if (lm && lm.split) lm.split(sim, p);
      return;
    }
    const f = _folk_mod();
    if (f !== null && f.split) f.split(sim, p);
  }

  // a and their own children under 18 who live with them: the ones who move when a moves.
  function with_kids(sim, a) {
    return [a].concat(P().members(sim, a).filter(m => m !== a && m.age < 18
      && a.relationships.get(m.id) !== undefined && a.relationships.get(m.id).kind === FAMILY));
  }

  // `leavers` have moved out of household `old`. If nobody alive is left, its home goes back: an owned one is
  // sold first, the proceeds into the savings of the adults who left (as housing.move_household credits a sale).
  function vacate(sim, old, leavers) {
    if (nil(old) || !sim.households.has(old.id)
      || old.member_ids.some(x => { const q = P().person(sim, x); return !nil(q) && q.alive; })) return;
    const H = G.housing;
    const home = sim.homes.get(old.home_id);
    if (home !== undefined && home.owner === old.id && home.household === old.id) {
      let payees = leavers.filter(m => m.is_adult);
      if (!payees.length) payees = leavers.slice();
      const proceeds = H.sale_proceeds(sim, home.id);
      for (const m of payees) m.savings += proceeds / payees.length;
    }
    H.on_household_empty(sim, old);
    sim.households.delete(old.id);
  }

  // mover (and their children under 18) join host's household; an emptied household's home goes back.
  function move_in(sim, mover, host) {
    if (P().is_named(mover) !== P().is_named(host)) return false;
    if (!P().is_named(mover)) {
      const f = _folk_mod();
      if (f === null || !f.join) return false;
      f.join(sim, mover, host);
    } else {
      const old = P().household(sim, mover);
      const nw = P().household(sim, host);
      if (nil(old) || nil(nw) || old === nw) return false;
      const movers = with_kids(sim, mover);
      for (const m of movers) {
        const i = old.member_ids.indexOf(m.id);
        if (i >= 0) old.member_ids.splice(i, 1);
        m.household_id = nw.id;
        nw.member_ids.push(m.id);
      }
      vacate(sim, old, movers);
    }
    const ra = mover.relationships.get(host.id), rb = host.relationships.get(mover.id);
    if (ra !== undefined && rb !== undefined) {
      ra.kind = rb.kind = PARTNER;
      ra.since = rb.since = sim.clock.tick;
    }
    _count(sim, "moved_in");
    if (P().is_named(mover)) {
      const hid = P().home_id(sim, host);
      sim.event(`${mover.name} moves in with ${host.name}.`, mover, null,
        { tag: "moved_in", agents: [host.id], place: hid ? _home_place(sim, hid) : hid });
    }
    return true;
  }

  // Engaged: the wedding is the Saturday at least `days` on, 14:00, in the nearest park.
  function engage(sim, a, b, days = 14) {
    const [lo, hi] = _lo_hi(a.id, b.id);
    let day = sim.clock.day + days;
    while (day % 7 !== 5) day += 1;
    sim.social.engaged.set(`${lo}|${hi}`, day);
    _count(sim, "engaged");
    if (P().is_named(a) || P().is_named(b)) {
      const [who, other] = P().is_named(a) ? [a, b] : [b, a];
      sim.event(`${a.name} and ${b.name} are engaged!`, who, null,
        { tag: "engaged", agents: [other.id], place: _where_of(who) });
    }
  }

  function _weddings(sim) {
    const st = sim.social;
    const day = sim.clock.day;
    for (const key of [...st.engaged.keys()].sort()) {
      if (st.engaged.get(key) !== day) continue;
      st.engaged.delete(key);
      const [lo, hi] = key.split("|");
      const a = P().person(sim, lo), b = P().person(sim, hi);
      if (nil(a) || nil(b) || !a.alive || !b.alive) continue;
      const ra = a.relationships.get(b.id), rb = b.relationships.get(a.id);
      if (ra === undefined || rb === undefined || ra.kind !== PARTNER) continue;
      ra.married = rb.married = true;
      ra.romance = Math.min(100.0, ra.romance + 10);
      rb.romance = Math.min(100.0, rb.romance + 10);
      _count(sim, "weddings");
      const named = P().is_named(a) || P().is_named(b);
      let park = null;
      if (P().is_named(a)) {
        park = sim.nearest(a, ["park"]);
        for (const x of [a, b]) {
          if (sim._interruptible(x) && !nil(park)) sim.start_plan(x, [["hang_out", park.id]]);
        }
      } else {
        const f = _folk_mod();
        const parks = [];
        for (const [pid, kind] of st.kind) if (kind === "park") parks.push(pid);
        if (f !== null && parks.length) {
          const park_id = parks[D().key(_ds(sim), D().COUPLE, lo, hi, day) % parks.length];
          park = sim.town.places.get(park_id);
          for (const x of [a, b]) if (f.is_free(sim, x)) f.send_to(sim, x, park_id, "hang_out", 120);
        }
      }
      const [who, other] = P().is_named(a) || !named ? [a, b] : [b, a];
      const where = !nil(park) ? ` in ${park.name}` : "";
      sim.event(`${a.name} and ${b.name} get married${where}!`, who, null,
        { tag: "wedding", importance: named ? null : 1, agents: [other.id], place: !nil(park) ? park.id : null });
    }
  }

  // --- the nightly pass: upkeep and the couples ----------------------------------------------------------------------

  function _rebuild_couples(sim) {
    const out = [];
    for (const p of P().everyone(sim)) {
      for (const [oid, r] of p.relationships) {
        if ((r.kind === DATING || r.kind === PARTNER) && p.id < oid) {
          const q = P().person(sim, oid);
          if (!nil(q) && q.alive) out.push([p.id, oid]);
        }
      }
    }
    sim.social.couples = out;
  }

  function _nightly(sim) {
    const t = sim.clock.tick;
    const day = sim.clock.day;
    for (const p of P().everyone(sim)) {
      if (!nil(p.life)) p.life.talks_today = 0;
      _upkeep(sim, p, t);
    }
    _rebuild_couples(sim);
    for (const [lo, hi] of sim.social.couples.slice()) {
      const a = P().person(sim, lo), b = P().person(sim, hi);
      if (nil(a) || nil(b)) continue;
      const ra = a.relationships.get(hi), rb = b.relationships.get(lo);
      if (ra === undefined || rb === undefined) continue;
      if (ra.kind === DATING) _dating_day(sim, a, b, ra, rb, day);
      else if (ra.kind === PARTNER) _home_day(sim, a, b, ra, rb, day);
    }
    _crushes(sim, day);
    _repay(sim, day);
  }

  // At most REL_CAP relationships; an unseen friend fades (.3 a day after 14 days, an acquaintance again below
  // FRIEND_AT - 15); an acquaintance unseen 60 days with |affinity| < 15 is dropped.
  function _upkeep(sim, p, t) {
    const rels = p.relationships;
    while (rels.size > REL_CAP && _evict(sim, p)) { /* evict */ }
    const gone = [];
    for (const [oid, r] of rels) {
      const unseen = t - r.seen;
      if (r.kind === FRIEND && unseen > 14 * DAY) {
        r.affinity -= 0.3;
        if (r.affinity < FRIEND_AT - 15) r.kind = ACQ;
      } else if (r.kind === ACQ && unseen > 60 * DAY && Math.abs(r.affinity) < 15) {
        gone.push(oid);
      }
    }
    for (const oid of gone) _drop(sim, p, oid);
  }

  // Breakups (lower romance < 25 or affinity < 15; a named leaver first gets relationship_trouble below 25) and
  // moving in (after 28 days at romance and affinity 65 / 55 both, .025 a day; same tier only).
  function _dating_day(sim, a, b, ra, rb, day) {
    const [leaver, other] = cmp([ra.affinity, ra.romance], [rb.affinity, rb.romance]) <= 0 ? [a, b] : [b, a];
    const rl = leaver.relationships.get(other.id);
    const low_rom = Math.min(ra.romance, rb.romance), low_aff = Math.min(ra.affinity, rb.affinity);
    if (P().is_named(leaver) && rl.affinity < 25 && !_cool(leaver, "relationship_trouble", day)) {
      if (P().prompt(sim, leaver, "relationship_trouble", { with: other.id })) {
        _set_cool(leaver, "relationship_trouble", day);
        return;
      }
    }
    if (low_rom < 25 || low_aff < 15) {
      if (!(P().is_named(leaver) && _cool(leaver, "breakup", day))) end_couple(sim, leaver, other);
      return;
    }
    if (P().is_named(a) !== P().is_named(b)) return; // across tiers it stops at dating
    if (sim.clock.tick - ra.since > 28 * DAY && Math.min(ra.romance, rb.romance) >= 65
      && Math.min(ra.affinity, rb.affinity) >= 55) {
      const rr = D().stream(_ds(sim), D().COUPLE, a.id, b.id, day);
      const roll = rr.random();
      if (roll >= 0.025) return;
      if (P().is_named(a)) {
        const [asker, x] = ra.romance >= rb.romance ? [a, b] : [b, a];
        if (!_cool(asker, "move_in", day) && P().prompt(sim, asker, "move_in",
          { with: x.id, weeks: Math.floor((sim.clock.tick - ra.since) / (7 * DAY)) })) {
          _set_cool(asker, "move_in", day);
        }
      } else {
        const [mover, host] = _mover(sim, a, b);
        move_in(sim, mover, host);
      }
    }
  }

  // The townsperson who moves: from the smaller household, renters first.
  function _mover(sim, a, b) {
    const ha = P().household(sim, a), hb = P().household(sim, b);
    const na = P().members(sim, a).length;
    const nb = P().members(sim, b).length;
    const rent_a = !nil(ha) && ha.weekly_rent > 0;
    const rent_b = !nil(hb) && hb.weekly_rent > 0;
    if (cmp([na, !rent_a, a.id], [nb, !rent_b, b.id]) <= 0) return [a, b];
    return [b, a];
  }

  // Home climate, splits and engagements of a couple living together.
  function _home_day(sim, a, b, ra, rb, day) {
    const rr = D().stream(_ds(sim), D().COUPLE, a.id, b.id, day);
    const hh = P().household(sim, a);
    const money = !nil(hh) && hh.arrears > 0 ? 0.1 : 0.0;
    let baby = 0.0;
    const kid = _kid_of(sim, a);
    if (kid !== null && kid.age === 0) baby = 0.05;
    const s_home = compat(a, b) + 0.003 * (a.mood + b.mood - 120) - money - baby;
    const luck = (a.luck + b.luck) / 2;
    const p_arg = D().odds(_clamp(0.03 - 0.3 * s_home, 0.005, 0.25), -1, luck);
    const x = rr.random();
    P().log_roll(sim, a, "home_argument", p_arg, x);
    if (x < p_arg) bump(sim, a, b, -4, -4);
    else if (rr.random() < 0.3 + s_home) bump(sim, a, b, 0.6, 0.6);
    for (const r of [ra, rb]) r.romance = Math.max(0.0, r.romance - 0.1);
    const [leaver, other] = ra.affinity <= rb.affinity ? [a, b] : [b, a];
    if (Math.min(ra.affinity, rb.affinity) < 10) {
      if (P().is_named(other) && !_cool(other, "partner_split", day)) {
        if (P().prompt(sim, other, "partner_split", { with: leaver.id })) _set_cool(other, "partner_split", day);
        return;
      }
      if (P().is_named(leaver) && leaver.relationships.get(other.id).affinity < 25
        && !_cool(leaver, "relationship_trouble", day)) {
        if (P().prompt(sim, leaver, "relationship_trouble", { with: other.id })) {
          _set_cool(leaver, "relationship_trouble", day);
          return;
        }
      }
      end_couple(sim, leaver, other);
      return;
    }
    const [lo, hi] = _lo_hi(a.id, b.id);
    if (sim.social.engaged.has(`${lo}|${hi}`) || ra.married) return;
    if (sim.clock.tick - ra.since > 45 * DAY && Math.min(ra.romance, rb.romance) >= 70 && rr.random() < 0.002) {
      if (P().is_named(a)) {
        const [asker, x2] = ra.romance >= rb.romance ? [a, b] : [b, a];
        if (!_cool(asker, "propose", day) && P().prompt(sim, asker, "propose", { with: x2.id })) {
          _set_cool(asker, "propose", day);
        }
      } else {
        const p = D().odds(0.8, +1, b.luck);
        const roll = rr.random();
        P().log_roll(sim, a, "proposal", p, roll);
        if (roll < p) engage(sim, a, b);
      }
    }
  }

  // A named with a standing crush (romance 30+, affinity 20+ toward a single adult) gets the crush fork.
  function _crushes(sim, day) {
    for (const a of sim.agents.values()) {
      if (!a.alive || a.age < 18 || nil(a.life) || _cool(a, "crush", day)) continue;
      if (partner_of(sim, a) !== null) continue;
      let best = null, best_rom = null;
      for (const [oid, r] of a.relationships) {
        if (r.romance >= ASK_ROMANCE && r.affinity >= ASK_AFFINITY
          && r.kind !== FAMILY && r.kind !== EX && r.kind !== PARTNER && r.kind !== DATING) {
          const q = P().person(sim, oid);
          if (nil(q) || !q.alive || q.age < 18 || partner_of(sim, q) !== null) continue;
          if (best_rom === null || r.romance > best_rom) { best = q; best_rom = r.romance; }
        }
      }
      if (best !== null && P().prompt(sim, a, "crush", { with: best.id })) _set_cool(a, "crush", day);
    }
  }

  // Dating couples meet every third day: the evening goes well or badly (romance +5 / -9, affinity half that).
  // Named pairs meet through a v2 invite to the cafe nearest the host; a named dating a townsperson gets the date
  // fork; townsfolk just go.
  function _dates(sim) {
    const day = sim.clock.day;
    for (const [lo, hi] of sim.social.couples.slice()) {
      if ((D().sid(lo) + D().sid(hi) + day) % 3) continue;
      const a = P().person(sim, lo), b = P().person(sim, hi);
      if (nil(a) || nil(b) || !a.alive || !b.alive) continue;
      const ra = a.relationships.get(hi), rb = b.relationships.get(lo);
      if (ra === undefined || rb === undefined || ra.kind !== DATING) continue;
      const named_a = P().is_named(a), named_b = P().is_named(b);
      if (named_a && named_b) {
        const cafe = sim.nearest(a, ["cafe"], null, null, 90);
        if (!nil(cafe) && nil(sim.pending_invite_for(b))) sim.invite(a, b.id, cafe.id);
        date_roll(sim, a, b);
      } else if (named_a || named_b) {
        const [named, other] = named_a ? [a, b] : [b, a];
        if (_cool(named, "date", day)) continue;
        const cafe = sim.nearest(named, ["cafe"], null, null, 120);
        if (!nil(cafe) && P().prompt(sim, named, "date", { with: other.id, place: cafe.id })) _set_cool(named, "date", day);
      } else {
        date_roll(sim, a, b);
      }
    }
  }

  // One date: s' = .2 + compat + .004 (aff - 50); warm at odds(.5 + s'), bad at odds(.1 - .5 s').
  function date_roll(sim, a, b) {
    const ra = a.relationships.get(b.id), rb = b.relationships.get(a.id);
    if (ra === undefined || rb === undefined) return "none";
    const s2 = 0.2 + compat(a, b) + 0.004 * ((ra.affinity + rb.affinity) / 2 - 50);
    const luck = (a.luck + b.luck) / 2;
    const pw = D().odds(_clamp(0.5 + s2, 0.05, 0.9), +1, luck);
    const pb = D().odds(_clamp(0.1 - 0.5 * s2, 0.02, 0.4), -1, luck);
    const x = D().roll(_ds(sim), D().COUPLE, a.id, b.id, sim.clock.tick);
    P().log_roll(sim, a, "date", pw, x);
    const d = x < pw ? 5.0 : x < pw + pb ? -9.0 : 0.0;
    if (d) {
      for (const r of [ra, rb]) r.romance = _clamp(r.romance + d, 0.0, 100.0);
      bump(sim, a, b, d / 2, d / 2);
    }
    _count(sim, "dates");
    return d > 0 ? "warm" : d < 0 ? "bad" : "fine";
  }

  // --- lending -------------------------------------------------------------------------------------------------------

  // A person below -$200 asks family, then a friend at affinity 50+ who holds 3x (a named lender: half) for
  // min(need, 1000) in $50s: a named lender gets friend_in_need; a townsperson lends at odds(.3 + .006 (aff - 50)
  // + .3 (1 - thrift), +1, borrower luck).
  function _lending(sim) {
    const day = sim.clock.day;
    const loans = _loans(sim);
    const owing = new Set(loans.map(row => row.borrower));
    const iso = P().isolated(sim);
    for (const p of P().everyone(sim)) {
      if (p.money >= -200 || !p.is_adult || owing.has(p.id) || _cool(p, "borrow", day)) continue;
      const amount = Math.min(1000, Math.ceil(-p.money / 50) * 50);
      const fam = [], friends = [];
      for (const [oid, r] of p.relationships) {
        const q = P().person(sim, oid);
        if (nil(q) || !q.alive || !q.is_adult || q.household_id === p.household_id) continue;
        if (iso && P().is_named(q) !== P().is_named(p)) continue;
        const need = P().is_named(q) ? amount / 2 : amount * 3;
        if (q.money + q.savings < need) continue;
        if (r.kind === FAMILY) fam.push([-r.affinity, oid, q]);
        else if (r.kind === FRIEND && r.affinity >= 50) friends.push([-r.affinity, oid, q]);
      }
      const by = (x, y) => cmp([x[0], x[1]], [y[0], y[1]]);
      fam.sort(by);
      friends.sort(by);
      const pool = fam.concat(friends);
      if (!pool.length) continue;
      _set_cool(p, "borrow", day);
      const lender = pool[0][2];
      if (P().is_named(lender)) {
        if (!_cool(lender, "friend_in_need", day) && P().prompt(sim, lender, "friend_in_need", { with: p.id, amount })) {
          _set_cool(lender, "friend_in_need", day);
        }
        continue;
      }
      const r = lender.relationships.get(p.id);
      const thrift = getd(P().traits(lender), "thrift", 0.5);
      const prob = D().odds(_clamp(0.3 + 0.006 * (r.affinity - 50) + 0.3 * (1 - thrift), 0.0, 1.0), +1, p.luck);
      const roll = D().roll(_ds(sim), D().LEND, lender.id, p.id, day);
      P().log_roll(sim, p, "loan", prob, roll);
      if (roll < prob) lend(sim, lender, p, amount);
    }
  }

  function lend(sim, lender, borrower, amount) {
    const st = sim.social;
    st.loan_ids += 1;
    const row = { id: `l${st.loan_ids}`, lender: lender.id, borrower: borrower.id, amount: Math.trunc(amount),
      since: sim.clock.day };
    _loans(sim).push(row);
    lender.money -= amount;
    borrower.money += amount;
    bump(sim, borrower, lender, 5, 2);
    _count(sim, "loans");
    if (P().is_named(lender) || P().is_named(borrower)) {
      const [who, other] = P().is_named(lender) ? [lender, borrower] : [borrower, lender];
      sim.event(`${lender.name} lends ${borrower.name} $${commas(Math.trunc(amount))}.`, who, null,
        { tag: "loan", agents: [other.id] });
    }
    return row;
  }

  // A loan is repaid in one sum once the borrower holds 3x; forgiven after 90 days (lender affinity -15).
  function _repay(sim, day) {
    const loans = _loans(sim);
    const keep = [];
    for (const row of loans) {
      if (!hasOwn(row, "lender")) { keep.push(row); continue; }
      const lender = P().person(sim, row.lender), borrower = P().person(sim, row.borrower);
      if (nil(lender) || nil(borrower) || !lender.alive || !borrower.alive) continue;
      const amount = row.amount;
      if (borrower.money >= 3 * amount) {
        borrower.money -= amount;
        lender.money += amount;
        bump(sim, lender, borrower, 3, 3);
        if (P().is_named(lender) || P().is_named(borrower)) {
          const [who, other] = P().is_named(borrower) ? [borrower, lender] : [lender, borrower];
          sim.event(`${borrower.name} pays ${lender.name} back $${commas(amount)}.`, who, null,
            { tag: "loan", importance: 0, agents: [other.id] });
        }
        continue;
      }
      if (day - row.since >= 90) {
        bump(sim, lender, borrower, -15, 0);
        continue;
      }
      keep.push(row);
    }
    loans.splice(0, loans.length, ...keep);
  }

  // --- incidents ------------------------------------------------------------------------------------------------------

  // Weekly, each workplace and school (Wednesday 11:00) and each block of homes (Sunday 20:00) with 3+ tied pairs
  // present (acquaintances, coworkers, friends): an incident at odds(.04, -1, mean luck) between the pair who get on
  // worst (lowest affinity both ways, then ids), affinity -15 and trust -5 both.
  function _incidents(sim, classes) {
    const folk = sim.folk;
    const mixed = P().mixed(sim);
    const present = new Map();
    for (const a of sim.agents.values()) {
      const pl = _named_place(a);
      if (pl !== null && pl !== undefined) {
        if (!present.has(pl)) present.set(pl, []);
        present.get(pl).push(a);
      }
    }
    const st = sim.social;
    const week = Math.floor(sim.clock.day / 7);
    for (const [place_id, place] of sim.town.places) {
      const cls = st.kind.has(place_id) ? st.kind.get(place_id) : "home";
      if (!classes.includes(cls)) continue;
      const named = present.get(place_id) || [];
      let crowd = [];
      if (!nil(folk) && folk.n > 0) {
        crowd = folk.present(place_id).map(i => folk.people[i]).filter(p => _folk_ok(p) && p.is_adult);
      }
      const groups = mixed ? [named.concat(crowd)] : [named, crowd];
      for (let group of groups) {
        group = group.filter(p => p.is_adult);
        if (group.length < 2) continue;
        const ids = new Set(group.map(p => p.id));
        const pairs = [];
        for (const p of group) {
          for (const [oid, r] of p.relationships) {
            if (ids.has(oid) && p.id < oid && (r.kind === COWORKER || r.kind === ACQ || r.kind === FRIEND)) {
              const back = P().person(sim, oid).relationships.get(p.id);
              pairs.push([r.affinity + (back !== undefined ? back.affinity : 0.0), p.id, oid]);
            }
          }
        }
        if (pairs.length < 3) continue;
        let luck = 0.0;
        for (const p of group) luck += p.luck;
        luck /= group.length;
        const rr = D().stream(_ds(sim), D().INCIDENT, place_id, week, group.length);
        const prob = D().odds(0.04, -1, luck);
        const roll = rr.random();
        if (roll >= prob) continue;
        let worst = pairs[0];
        for (const pr of pairs) if (cmp(pr, worst) < 0) worst = pr; // it flares up between the two who get on worst
        const [, lo, hi] = worst;
        const a = P().person(sim, lo), b = P().person(sim, hi);
        P().log_roll(sim, a, "incident", prob, roll);
        bump(sim, a, b, -15, -15);
        for (const [x, y] of [[a, b], [b, a]]) {
          const r = x.relationships.get(y.id);
          if (r !== undefined) r.trust = Math.max(0.0, r.trust - 5);
        }
        _count(sim, "incidents");
        if (P().is_named(a) || P().is_named(b)) {
          const [who, other] = P().is_named(a) ? [a, b] : [b, a];
          const why = cls === "work" ? "over a missed shift" : cls === "school" ? "over a broken pencil case"
            : "over the noise on the stairs";
          sim.event(`${_first(a.name)} and ${_first(b.name)} fall out ${why} at ${place.name}.`, who, null,
            { tag: "row", agents: [other.id], place: place_id });
        }
      }
    }
  }

  // --- texts and invites to townsfolk ---------------------------------------------------------------------------------

  // sim.send_message to a townsperson: refused without a relationship; one reply by talk.reply as a v2 message from
  // the townsperson; affinity +1 both.
  function message_folk(sim, a, fid, text) {
    const folk = sim.folk;
    const b = !nil(folk) ? folk.person(fid) : null;
    if (nil(a) || nil(b) || !a.alive || !b.alive) return { ok: false, error: "unknown or dead character" };
    const r = a.relationships.get(fid), back = b.relationships.get(a.id);
    if (r === undefined || back === undefined) return { ok: false, error: "you don't know them" };
    text = cut(String(text), 500);
    a.adjust("social", 3);
    b.adjust("social", 3);
    bump(sim, a, b, 1, 1);
    sim.event(`${a.name} texts ${b.name}: “${cut(text, 80)}”`, a, null, { tag: "text", agents: [fid] });
    const rr = D().stream(_ds(sim), D().FOLK_ANSWER, fid, a.id, sim.clock.tick);
    const answer = G.talk.reply(back.affinity, b.mood, rr);
    b.remember(sim.clock.stamp(), `Texted by ${a.name}.`);
    sim._deliver(a, { type: "message", from: fid, from_name: b.name, to: a.id, text: answer,
      time: sim.clock.stamp() });
    a.inbox.push({ time: sim.clock.stamp(), from: fid, text: answer });
    keepLast(a.inbox, 30);
    return { ok: true };
  }

  const FOLK_TEXTS = ["Hey! Thinking of you. How are things?", "Coffee sometime this week?",
    "Saw something that made me think of you!", "Hope your week is going well.", "Are you free on the weekend?"];

  // Weekly (Saturday 12:00): each townsperson friend at affinity 40+ texts a named friend at .3.
  function _folk_texts(sim) {
    if (!P().mixed(sim)) return;
    const week = Math.floor(sim.clock.day / 7);
    for (const a of sim.agents.values()) {
      if (!a.alive) continue;
      for (const [oid, r] of [...a.relationships]) {
        if (!P().is_folk_id(oid) || r.kind !== FRIEND) continue;
        const f = P().person(sim, oid);
        const back = !nil(f) ? f.relationships.get(a.id) : undefined;
        if (nil(f) || !f.alive || back === undefined || back.affinity < 40) continue;
        const rr = D().stream(_ds(sim), D().FOLK_ANSWER, oid, a.id, week);
        if (rr.random() >= 0.3) continue;
        const text = FOLK_TEXTS[Math.floor(rr.random() * FOLK_TEXTS.length)];
        a.inbox.push({ time: sim.clock.stamp(), from: oid, text });
        keepLast(a.inbox, 30);
        a.adjust("social", 3);
        sim._deliver(a, { type: "message", from: oid, from_name: f.name, to: a.id, text, time: sim.clock.stamp() });
        _count(sim, "folk_texts");
      }
    }
  }

  function _named_may_go(sim, a, place_id) {
    const fn = G.travel ? G.travel.named_may_visit : undefined;
    return fn === undefined ? true : Boolean(fn(sim, a, place_id));
  }

  // sim.invite to a townsperson: a record "fi<n>" in sim.social.folk_invites (never sim.invites), answered on the
  // next tick. A townsperson host never invites.
  function invite_folk(sim, host, guest_id, place_id) {
    const folk = sim.folk;
    const guest = !nil(folk) ? folk.person(guest_id) : null;
    if (nil(host) || !P().is_named(host) || !host.alive || nil(guest) || !guest.alive
      || !sim.town.places.has(place_id) || !_named_may_go(sim, host, place_id)) return null;
    if (P().isolated(sim)) return null;
    const st = sim.social;
    st.invite_ids += 1;
    const inv = { id: `fi${st.invite_ids}`, from: host.id, to: guest_id, place: place_id, tick: sim.clock.tick,
      status: "pending" };
    st.folk_invites.set(inv.id, inv);
    const place = sim.town.places.get(place_id).name;
    sim.event(`${host.name} invites ${guest.name} to ${place}.`, host, null,
      { tag: "invite", agents: [guest_id], place: place_id });
    return inv;
  }

  function _answer_folk_invites(sim) {
    const st = sim.social;
    const f = _folk_mod();
    const ids = [...st.folk_invites.keys()].sort((x, y) => parseInt(x.slice(2), 10) - parseInt(y.slice(2), 10));
    for (const iid of ids) {
      const inv = st.folk_invites.get(iid);
      if (inv.status !== "pending") {
        if (sim.clock.tick - inv.tick > 120) st.folk_invites.delete(iid);
        continue;
      }
      if (sim.clock.tick <= inv.tick) continue;
      const host = P().person(sim, inv.from), guest = P().person(sim, inv.to);
      const place = sim.town.places.get(inv.place);
      let yes = false;
      if (!nil(host) && !nil(guest) && host.alive && guest.alive && f !== null) {
        if (f.is_free(sim, guest) && place.is_open(sim.clock.hour + 0.5)) {
          const r = guest.relationships.get(host.id);
          const aff = r !== undefined ? r.affinity : 0.0;
          const prob = D().odds(_clamp(0.4 + 0.4 * getd(P().traits(guest), "social", 0.5) + aff / 200, 0.0, 1.0),
            +1, host.luck);
          const roll = D().roll(_ds(sim), D().FOLK_ANSWER, iid);
          P().log_roll(sim, host, "folk_invite", prob, roll);
          yes = roll < prob;
        }
      }
      inv.status = yes ? "accept" : "decline";
      if (nil(host) || nil(guest)) continue;
      if (yes) f.send_to(sim, guest, inv.place, "hang_out", 90);
      const words = yes ? "accepts" : "declines";
      sim.event(`${guest.name} ${words} ${_first(host.name)}'s invite.`, host, null,
        { tag: yes ? "invite_accepted" : "invite_declined", agents: [guest.id], place: inv.place });
      sim._deliver(host, { type: "invite_answer", invite_id: iid, from: guest.id, answer: yes ? "accept" : "decline" });
    }
  }

  // A townsperson's company for an outing (folk's day_off / evening hang_out): their closest free townsperson
  // friend or date (affinity 30+), or null. Never a named.
  function pick_companion(sim, p, why) {
    const f = _folk_mod();
    if (f === null) return null;
    let best = null, best_key = null;
    for (const [oid, r] of p.relationships) {
      if (!P().is_folk_id(oid) || (r.kind !== FRIEND && r.kind !== DATING && r.kind !== PARTNER) || r.affinity < 30) {
        continue;
      }
      const q = P().person(sim, oid);
      if (nil(q) || !q.alive || q.household_id === p.household_id || !f.is_free(sim, q)) continue;
      const key = [-r.affinity, oid];
      if (best_key === null || cmp(key, best_key) < 0) { best = q; best_key = key; }
    }
    return best;
  }

  // --- the view ---------------------------------------------------------------------------------------------------------

  // state.talks (PLAN 2.10): [[place_index | -1, a_id, b_id, tone, tick], ...] for the talks begun in the last 10
  // game minutes: every talk with a named first, then townsfolk-only talks (at most one per place), newest first,
  // at most 20 rows.
  function talks_json(sim) {
    const st = sim.social;
    if (nil(st)) return [];
    const t = sim.clock.tick;
    const named = [], folk_rows = [], seen = new Set();
    for (let i = st.talks.length - 1; i >= 0; i--) {
      const [tk, a, b, tone, place] = st.talks[i];
      if (t - tk >= TALKS_WINDOW) break;
      const idx = st.place_index.has(place) ? st.place_index.get(place) : -1;
      const row = [idx, a, b, tone, tk];
      if (!P().is_folk_id(a) || !P().is_folk_id(b)) {
        named.push(row);
      } else if (idx < 0 || !seen.has(idx)) {
        seen.add(idx);
        folk_rows.push(row);
      }
    }
    return named.concat(folk_rows).slice(0, TALKS_SHOWN);
  }

  // --- the start ----------------------------------------------------------------------------------------------------------

  function _closest_eligible(sim, p) {
    let best = null, best_key = null;
    for (const [oid, r] of p.relationships) {
      const q = P().person(sim, oid);
      if (nil(q) || !q.alive || !eligible(sim, p, q)) continue;
      const key = [-r.affinity, oid];
      if (best_key === null || cmp(key, best_key) < 0) { best = q; best_key = key; }
    }
    return best;
  }

  // The social half of the start (life.md 5.9), on the STORY stream: 25% of people 13+ get one tie 5-10 below
  // FRIEND_AT; 3% a rival among their ties (-20 to -40); 4% of single adults 18-50 are dating an eligible tie
  // (romance and affinity 45-60, 5-40 days in); 6% have a one-sided crush (romance 20-40). Named couples sharing a
  // surname start married at romance 70. Fixed: Efrat Sasson and Amir Amar dating 20 days (romance 55, affinity
  // 50); Tom Levi's crush (romance 32, affinity 25) on his closest eligible tie, else Ari Ben-David.
  function seed_story(sim) {
    const ds = _ds(sim);
    const t = sim.clock.tick;
    const everyone = P().everyone(sim);
    for (const p of everyone) {
      if (p.age < 13) continue;
      const rr = D().stream(ds, D().STORY, p.id, "ties");
      const x = rr.random();
      const ties = [];
      for (const [oid, r] of p.relationships) {
        if ((r.kind === COWORKER || r.kind === ACQ || r.kind === FRIEND) && r.affinity < FRIEND_AT) ties.push(oid);
      }
      ties.sort();
      if (!ties.length) continue;
      const q = P().person(sim, ties[Math.floor(rr.random() * ties.length)]);
      if (nil(q) || q.relationships.get(p.id) === undefined) continue;
      if (x < 0.25) {
        const v = FRIEND_AT - rr.int(5, 10);
        p.relationships.get(q.id).affinity = v;
        q.relationships.get(p.id).affinity = v;
      } else if (x < 0.28) {
        const v = -rr.int(20, 40);
        for (const r of [p.relationships.get(q.id), q.relationships.get(p.id)]) {
          r.affinity = v;
          r.kind = RIVAL;
        }
      }
    }
    for (const p of everyone) {
      if (p.age < 18 || p.age > 50) continue;
      const rr = D().stream(ds, D().STORY, p.id, "love");
      const x = rr.random();
      if (x >= 0.10 || partner_of(sim, p) !== null) continue;
      const ids = [];
      for (const [oid, r] of p.relationships) {
        if (r.kind === COWORKER || r.kind === ACQ || r.kind === FRIEND) ids.push(oid);
      }
      ids.sort();
      const cands = ids.map(oid => P().person(sim, oid)).filter(q => !nil(q) && eligible(sim, p, q));
      if (!cands.length) continue;
      const q = cands[Math.floor(rr.random() * cands.length)];
      if (x < 0.04) {
        const rom = rr.int(45, 60), aff = rr.int(45, 60);
        P().set_rel(sim, p.id, q.id, DATING, aff, null, { romance: rom, since: t - rr.int(5, 40) * DAY, seen: t });
      } else {
        const r = p.relationships.get(q.id);
        r.romance = rr.int(20, 40);
        r.affinity = Math.max(r.affinity, 22.0);
      }
    }
    for (const a of sim.agents.values()) { // named couples sharing a surname are married
      for (const [oid, r] of a.relationships) {
        const b = sim.agents.get(oid);
        if (r.kind === PARTNER && b !== undefined && lastName(a.name) === lastName(b.name)) {
          r.married = true;
          r.romance = Math.max(r.romance, 70.0);
        }
      }
    }
    const efrat = sim.agents.get("efrat"), amir = sim.agents.get("amir");
    if (efrat !== undefined && amir !== undefined && partner_of(sim, efrat) === null && partner_of(sim, amir) === null) {
      P().set_rel(sim, "efrat", "amir", DATING, 50, null, { romance: 55.0, since: t - 20 * DAY, seen: t });
    }
    const tom = sim.agents.get("tom");
    if (tom !== undefined && partner_of(sim, tom) === null) {
      let target = _closest_eligible(sim, tom);
      if (target === null) target = sim.agents.get("ari") || null;
      if (target !== null) {
        if (tom.relationships.get(target.id) === undefined || target.relationships.get(tom.id) === undefined) {
          P().set_rel(sim, tom.id, target.id, ACQ, 25, null, { seen: t, since: t });
        }
        const r = tom.relationships.get(target.id);
        r.romance = 32.0;
        r.affinity = 25.0;
      }
    }
    if (!nil(sim.social)) _rebuild_couples(sim);
  }

  G.social = {
    TALK_P, STRANGER_W, CLASS_OF_KIND, STEP, SOCIAL_GAIN, TONE_CODE, TALKS_A_DAY, CANDIDATES, FIRST_AFFINITY,
    FRIEND_AT, RIVAL_AT, RIVAL_OFF, REL_CAP, CHEM_MIN, ASK_ROMANCE, ASK_AFFINITY, RING, TALKS_SHOWN, TALKS_WINDOW,
    DATE_HOUR, WEDDING_HOUR, COOL, FOLK_TEXTS, TOPIC_WORDS, SocialState,
    init, tick, converse, on_affinity, bump, trait_gap, compat, talk_ctx, partner_of, attracted, eligible, chemistry,
    ask_out, folk_answer, start_dating, end_couple, move_in, with_kids, vacate, engage, date_roll, lend, message_folk, invite_folk,
    pick_companion, talks_json, seed_story, _cool, _set_cool, _rooms, _run_room, _nightly, _dates, _lending,
    _incidents, _weddings, _folk_texts, _crushes, _rebuild_couples, _named_place, _ensure, _drop, _evict, _count,
    _home_day, _dating_day, _mover, _leave_home, _closest_eligible, _headline, _named_talk, _upkeep,
  };
})(globalThis.GameOfAILife || (globalThis.GameOfAILife = {}));

// Port of gameofailife/social_forks.py: the eight social forks of the named (life.md 6): crush, asked_out, date,
// move_in, propose / proposal, relationship_trouble, partner_split and friend_in_need. Each has exactly four distinct
// options and is major. An option's extra.life goes to HANDLERS[fork.kind]; the outcome keys life_rel ([other id,
// d]: the other's affinity toward the character by d, the character's by d / 2) and life_rom ([other id, d]: both
// sides' romance) go to EFFECTS. Odds stay hidden: no label or `about` line shows one.
(function (G) {
  "use strict";
  const { getd, commas, pyRound, firstName } = G.py;

  const DAY = 24 * 60;
  const KINDS = ["crush", "asked_out", "date", "move_in", "propose", "proposal", "relationship_trouble",
    "partner_split", "friend_in_need"];
  const STAY = [["idle", null]]; // a decision that keeps the character where they are for a moment

  const P = () => G.people;
  const S = () => G.social;
  const nil = x => x === null || x === undefined;
  const Option = (label, steps, o) => new G.forks.Option(label, steps, o);
  const Outcome = (id, label, p, valence, effects, group = null) => new G.forks.Outcome(id, label, p, valence, effects, group);

  const _first = p => firstName(p.name);

  function _other(sim, agent, ctx) {
    const q = P().person(sim, getd(ctx, "with", null));
    if (nil(q) || !q.alive || q === agent) return null;
    return q;
  }

  // Fork.about: who the other is, and how the two stand (no odds).
  function about(sim, agent, q) {
    const job = q.job;
    let role;
    if (nil(job)) {
      role = q.age >= 60 ? "retired" : "not working";
    } else if (job.title === "student") {
      role = "at school";
    } else {
      const place = sim.town.places.get(job.place_id);
      role = place !== undefined ? `${job.title} at ${place.name}` : job.title;
    }
    const lines = [`${q.name}, ${q.age}, ${role}.`];
    const r = agent.relationships.get(q.id);
    if (r !== undefined) {
      const days = Math.max(0, Math.floor((sim.clock.tick - r.since) / DAY));
      const pron = P().sex(q) === "f" ? "her" : "him";
      const feel = r.affinity >= 0 ? "like" : "don't like";
      if (r.kind === "dating" || r.kind === "partner") {
        lines.push(`Together ${days} days; you have talked ${r.talks} times, and ${feel} ${pron} (${pyRound(r.affinity)}).`);
      } else {
        lines.push(`You met ${days} days ago, have talked ${r.talks} times, and ${feel} ${pron} (${pyRound(r.affinity)}).`);
      }
    }
    return lines;
  }

  // The hidden aftertaste of each option that has no outcome of its own, by fork kind and option index (Luck shifts
  // it like any other outcome): [id, label, p, valence, effects]; life_rel/life_rom values are bumps with the other one.
  const MOODS = {
    crush: [["nervous_ask", "Nervous, but glad they asked", 0.5, +1, { fun: 5 }], null,
      ["daydream", "A pleasant daydream", 0.5, +1, { fun: 3 }],
      ["lets_go", "Letting go feels lighter", 0.4, +1, { fun: 4 }]],
    asked_out: [["excited", "Excited about Friday", 0.6, +1, { fun: 8 }],
      ["nice_coffee", "A nice easy coffee", 0.5, +1, { life_rel: 3 }],
      ["still_friends", "Still friends, no hard feelings", 0.5, +1, { life_rel: 2 }],
      ["guilty", "Feels a little guilty", 0.4, -1, { fun: -4 }]],
    date: [["good_food", "The food is good", 0.5, +1, { fun: 6 }],
      ["understanding", "They understand", 0.5, +1, { life_rel: 1 }],
      ["quiet_night", "A quiet night in", 0.5, +1, { energy: 6 }],
      ["relief", "Relieved it's over", 0.4, 0, { fun: -5 }]],
    move_in: [["happy_news", "Happy news", 0.5, +1, { life_rom: 3 }],
      ["warm_welcome", "A warm welcome", 0.5, +1, { life_rom: 3 }],
      ["house_hunting", "House hunting is fun", 0.5, +1, { fun: 6 }],
      ["disappointed", "They seem disappointed", 0.4, -1, { life_rel: -3 }]],
    propose: [["ring_fits", "The ring fits", 0.6, +1, { fun: 10 }],
      ["sweet_moment", "A sweet moment", 0.6, +1, { fun: 8 }],
      ["doubts", "Doubts creep in", 0.4, -1, { fun: -3 }],
      ["relieved", "Relieved to have decided", 0.4, 0, { fun: 2 }]],
    proposal: [["overjoyed", "Overjoyed", 0.6, +1, { fun: 10 }],
      ["planning", "Starts planning", 0.5, +1, { fun: 6 }],
      ["hurt", "They look hurt", 0.5, -1, { life_rel: -3 }],
      ["tears", "Tears all round", 0.5, -1, { fun: -8 }]],
    relationship_trouble: [null, null, ["clear_head", "A clearer head", 0.5, +1, { energy: 5 }],
      ["hard_end", "Ending it is hard", 0.5, -1, { fun: -8 }]],
    partner_split: [["amicable", "It ends amicably", 0.5, +1, { life_rel: 5 }], null, null,
      ["regret", "Regrets storming out", 0.5, -1, { fun: -6 }]],
    friend_in_need: [["grateful", "They are grateful", 0.6, +1, { life_rel: 3 }],
      ["grateful_half", "They are grateful for the help", 0.6, +1, { life_rel: 2 }],
      ["touched", "They are touched", 0.6, +1, { life_rel: 4 }],
      ["awkward_refusal", "An awkward moment", 0.5, -1, { life_rel: -2 }]],
  };

  function _moods(kind, opts, q) {
    const table = MOODS[kind] || [];
    for (let i = 0; i < Math.min(opts.length, table.length); i++) {
      const opt = opts[i], mood = table[i];
      if (mood === null || opt.outcomes.length) continue;
      const [oid, label, p, valence, effects] = mood;
      const eff = {};
      for (const [k, v] of Object.entries(effects)) eff[k] = (k === "life_rel" || k === "life_rom") ? [q.id, v] : v;
      opt.outcomes = [Outcome(oid, label, p, valence, eff)];
    }
  }

  function _fork(sim, agent, kind, question, opts, q) {
    _moods(kind, opts, q);
    const fork = new G.forks.Fork(agent.id, kind, question, opts, sim.clock.tick);
    fork.major = true;
    fork.about = about(sim, agent, q);
    return fork;
  }

  const _life = (act, q, more = {}) => ({ life: Object.assign({ act, with: q.id }, more) });

  const _rel = (sim, agent, q) => { const r = agent.relationships.get(q.id); return r === undefined ? null : r; };

  // --- the builders -------------------------------------------------------------------------------------------------

  function crush_fork(sim, agent, ctx) {
    const q = _other(sim, agent, ctx);
    const r = q !== null ? _rel(sim, agent, q) : null;
    if (q === null || r === null || S().partner_of(sim, agent) !== null || S().partner_of(sim, q) !== null) return null;
    const x = _first(q);
    const keen = 0.01 * (r.romance - 30) + 0.005 * (r.affinity - 20);
    const opts = [
      Option(`Ask ${x} out to dinner`, [["phone_call", null]], { tags: { social: 0.6, adventure: 0.7 },
        gains: { social: 10 }, base: 0.1 + keen, extra: _life("ask", q) }),
      Option(`Text ${x} something flirty`, [["text", null]], { tags: { social: 0.5, adventure: 0.3 },
        gains: { social: 8 }, base: 0.05 + keen / 2,
        outcomes: [Outcome("flirty_reply", `${x} texts back with a smile`, 0.75, +1,
          { life_rel: [q.id, 8], life_rom: [q.id, 4] }, "text"),
        Outcome("awkward_text", "The text lands awkwardly", 0.25, -1, { life_rel: [q.id, -10] }, "text")] }),
      Option("Wait and see", STAY, { tags: { adventure: -0.4, thrift: 0.1 }, base: 0.05 }),
      Option("Let it go", STAY, { tags: { adventure: -0.6, family: 0.2 }, base: -0.05, extra: _life("let_go", q) }),
    ];
    return _fork(sim, agent, "crush", `You can't stop thinking about ${x}.`, opts, q);
  }

  function asked_out_fork(sim, agent, ctx) {
    const q = _other(sim, agent, ctx);
    if (q === null || S().partner_of(sim, agent) !== null || S().partner_of(sim, q) !== null) return null;
    const r = _rel(sim, agent, q);
    const [aff, rom] = r !== null ? [r.affinity, r.romance] : [0.0, 0.0];
    const x = _first(q);
    const keen = 0.01 * (aff - 20) + 0.01 * rom;
    const cafe = sim.nearest(agent, ["cafe"], null, null, 60);
    const coffee = !nil(cafe) ? [["hang_out", cafe.id]] : [["text", null]];
    const opts = [
      Option("Say yes", [["text", null]], { tags: { social: 0.6, adventure: 0.5 }, gains: { social: 10 },
        base: keen, extra: _life("yes", q) }),
      Option("Suggest a coffee instead", coffee, { cost: !nil(cafe) ? 4 : 0,
        tags: { social: 0.4, adventure: -0.1, thrift: 0.1 }, gains: { social: 20 }, base: keen / 2 + 0.05,
        extra: _life("coffee", q, { place: !nil(cafe) ? cafe.id : null }) }),
      Option("Rather stay friends", [["text", null]], { tags: { family: 0.1, adventure: -0.3 }, base: 0.15 - keen / 2,
        extra: _life("friends", q) }),
      Option(`Turn ${x} down flat`, STAY, { tags: { social: -0.5 }, base: -0.2 - keen, extra: _life("flat", q) }),
    ];
    return _fork(sim, agent, "asked_out", `${x} asks you out ${_date_when(sim, agent, q)}.`, opts, q);
  }

  const DAY_FULL = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

  // When the first date would be (social.first_date_day): "tonight", "tomorrow evening" or "on Wednesday".
  function _date_when(sim, a, b) {
    const day = S().first_date_day(sim, a.id, b.id);
    if (day === sim.clock.day) return "tonight";
    if (day === sim.clock.day + 1) return "tomorrow evening";
    return `on ${DAY_FULL[day % 7]}`;
  }

  function date_fork(sim, agent, ctx) {
    const q = _other(sim, agent, ctx);
    const r = q !== null ? _rel(sim, agent, q) : null;
    const place = sim.town.places.get(getd(ctx, "place", null) || "");
    if (q === null || r === null || r.kind !== "dating" || place === undefined) return null;
    const x = _first(q);
    const keen = 0.01 * (r.romance - 40);
    const opts = [
      Option("Go", [["hang_out", place.id]], { cost: 20, tags: { social: 0.7, adventure: 0.3, thrift: -0.2 },
        gains: { social: 40, fun: 25 }, base: 0.2 + keen, extra: _life("go", q, { place: place.id }) }),
      Option("Coffee tomorrow instead", [["text", null]], { tags: { thrift: 0.3, diligence: 0.2 }, base: 0.0,
        extra: _life("later", q) }),
      Option("Not tonight", STAY, { tags: { social: -0.4, thrift: 0.2 }, base: -0.1, extra: _life("no", q) }),
      Option("End it", STAY, { tags: { adventure: 0.2, family: -0.2 }, base: -0.4 - keen, extra: _life("end", q) }),
    ];
    return _fork(sim, agent, "date", `${x} suggests dinner at ${place.name} at 19:00.`, opts, q);
  }

  function move_in_fork(sim, agent, ctx) {
    const q = _other(sim, agent, ctx);
    const r = q !== null ? _rel(sim, agent, q) : null;
    if (q === null || r === null || r.kind !== "dating" || !P().is_named(q)) return null;
    const x = _first(q);
    const weeks = Math.max(1, Math.floor((sim.clock.tick - r.since) / (7 * DAY)));
    const mine = P().members(sim, agent).length;
    const theirs = P().members(sim, q).length;
    const opts = [
      Option(`Ask ${x} to move in`, STAY, { tags: { family: 0.7, adventure: 0.3 }, base: 0.15 + 0.05 * (theirs - mine),
        extra: _life("host", q) }),
      Option(`Move into ${x}'s place`, STAY, { tags: { family: 0.6, adventure: 0.5 },
        base: 0.15 + 0.05 * (mine - theirs), extra: _life("join", q) }),
      Option("Look for a place together", STAY, { tags: { adventure: 0.7, thrift: -0.4 }, base: 0.0,
        extra: _life("together", q) }),
      Option("Not yet", STAY, { tags: { adventure: -0.5, thrift: 0.2 }, base: 0.05, extra: _life("wait", q) }),
    ];
    return _fork(sim, agent, "move_in", `Seeing ${x} ${weeks} weeks. Move in?`, opts, q);
  }

  function propose_fork(sim, agent, ctx) {
    const q = _other(sim, agent, ctx);
    const r = q !== null ? _rel(sim, agent, q) : null;
    if (q === null || r === null || r.kind !== "partner" || r.married) return null;
    const x = _first(q);
    const opts = [
      Option("Propose with a ring ($1,200)", STAY, { cost: 1200, tags: { family: 0.8, thrift: -0.6 },
        gains: { fun: 20 }, base: 0.1, extra: _life("propose", q, { ring: true }) }),
      Option("Propose simply", STAY, { tags: { family: 0.7, thrift: 0.4 }, gains: { fun: 15 }, base: 0.1,
        extra: _life("propose", q, { ring: false }) }),
      Option("Wait a while", STAY, { tags: { adventure: -0.3 }, base: 0.05, extra: _life("wait", q) }),
      Option("Rather not", STAY, { tags: { family: -0.6, adventure: 0.2 }, base: -0.1, extra: _life("never", q) }),
    ];
    return _fork(sim, agent, "propose", `Propose to ${x}?`, opts, q);
  }

  function proposal_fork(sim, agent, ctx) {
    const q = _other(sim, agent, ctx);
    const r = q !== null ? _rel(sim, agent, q) : null;
    if (q === null || r === null || r.kind !== "partner" || r.married) return null;
    const x = _first(q);
    const keen = 0.01 * (r.romance - 50) + 0.005 * (r.affinity - 50);
    const opts = [
      Option("Yes!", STAY, { tags: { family: 0.8, adventure: 0.3 }, gains: { fun: 30 }, base: 0.2 + keen,
        extra: _life("yes", q) }),
      Option("Yes, but a long engagement", STAY, { tags: { family: 0.5, thrift: 0.3 }, gains: { fun: 20 },
        base: 0.1 + keen / 2, extra: _life("long", q) }),
      Option("Not yet", STAY, { tags: { adventure: -0.4 }, base: 0.0, extra: _life("not_yet", q) }),
      Option("No", STAY, { tags: { family: -0.7 }, base: -0.3 - keen, extra: _life("no", q) }),
    ];
    return _fork(sim, agent, "proposal", `${x} proposes!`, opts, q);
  }

  function relationship_trouble_fork(sim, agent, ctx) {
    const q = _other(sim, agent, ctx);
    const r = q !== null ? _rel(sim, agent, q) : null;
    if (q === null || r === null || (r.kind !== "dating" && r.kind !== "partner")) return null;
    const x = _first(q);
    const opts = [
      Option("Talk it through", [["phone_call", null]], { tags: { family: 0.5, social: 0.4 }, base: 0.15,
        outcomes: [Outcome("talked_out", `They talk it through with ${x}`, 0.55, +1, { life_rel: [q.id, 6] }, "talk"),
          Outcome("talk_row", "It turns into a row", 0.25, -1, { life_rel: [q.id, -6] }, "talk")] }),
      Option("Plan a special evening ($80)", STAY, { cost: 80, tags: { family: 0.6, thrift: -0.5 }, gains: { fun: 15 },
        base: 0.1, outcomes: [Outcome("special_evening", "A lovely evening together", 0.6, +1,
          { life_rel: [q.id, 8], life_rom: [q.id, 5] })] }),
      Option("Take a week's space", STAY, { tags: { social: -0.4, adventure: -0.2 }, base: 0.0,
        extra: _life("space", q) }),
      Option("End it", STAY, { tags: { adventure: 0.4, family: -0.4 }, base: -0.2 + 0.01 * (20 - r.affinity),
        extra: _life("end", q) }),
    ];
    return _fork(sim, agent, "relationship_trouble", `Things with ${x} have been rocky.`, opts, q);
  }

  function partner_split_fork(sim, agent, ctx) {
    const q = _other(sim, agent, ctx);
    const r = q !== null ? _rel(sim, agent, q) : null;
    if (q === null || r === null || r.kind !== "partner") return null;
    const x = _first(q);
    const opts = [
      Option("Agree calmly", STAY, { tags: { diligence: 0.3, adventure: 0.2 }, base: 0.1, extra: _life("agree", q) }),
      Option("Try counselling ($320)", STAY, { cost: 320, tags: { family: 0.8, thrift: -0.4 }, base: 0.05,
        outcomes: [Outcome("counselling_helps", "Counselling helps", 0.45, +1, { life_rel: [q.id, 15] })] }),
      Option(`Plead with ${x}`, STAY, { tags: { family: 0.6, social: 0.3 }, base: 0.0,
        outcomes: [Outcome("plea_works", `${x} agrees to try again`, 0.25, +1, { life_rel: [q.id, 12] })] }),
      Option("Storm out", STAY, { tags: { family: -0.5, adventure: 0.4 }, base: -0.3, extra: _life("storm", q) }),
    ];
    return _fork(sim, agent, "partner_split", `${x} wants to split up.`, opts, q);
  }

  function friend_in_need_fork(sim, agent, ctx) {
    const q = _other(sim, agent, ctx);
    if (q === null) return null;
    const a = Math.trunc(Number(getd(ctx, "amount", 0) || 0));
    if (a <= 0 || q.money >= -200) return null;
    const half = Math.floor(a / 2), quarter = Math.floor(a / 4);
    const r = _rel(sim, agent, q);
    const warm = 0.005 * ((r !== null ? r.affinity : 0) - 50);
    const x = _first(q);
    const opts = [
      Option(`Lend $${commas(a)}`, STAY, { cost: a, charge: false, tags: { social: 0.6, family: 0.4, thrift: -0.6 },
        base: 0.1 + warm, extra: _life("lend", q, { amount: a }) }),
      Option(`Lend half ($${commas(half)})`, STAY, { cost: half, charge: false, tags: { social: 0.4, thrift: -0.2 },
        base: 0.1 + warm / 2, extra: _life("lend", q, { amount: half }) }),
      Option(`Give $${commas(quarter)}, no strings`, STAY, { cost: quarter, charge: false,
        tags: { social: 0.5, family: 0.3, thrift: -0.3 }, base: 0.0, extra: _life("give", q, { amount: quarter }) }),
      Option("Say you can't help", STAY, { tags: { thrift: 0.8, social: -0.3 }, base: -0.05, extra: _life("no", q) }),
    ];
    return _fork(sim, agent, "friend_in_need", `${x} asks to borrow $${commas(a)}.`, opts, q);
  }

  // --- what the choices do -----------------------------------------------------------------------------------------

  function _q(sim, value) {
    const q = P().person(sim, getd(value, "with", null));
    return !nil(q) && q.alive ? q : null;
  }

  function _crush(sim, agent, fork, opt, value) {
    const q = _q(sim, value);
    if (q === null) return;
    if (value.act === "ask") {
      sim.event(`${agent.name} asks ${q.name} out to dinner.`, agent, null, { tag: "flirt", importance: 1, agents: [q.id] });
      if (P().is_named(q)) {
        const day = sim.clock.day;
        if (P().prompt(sim, q, "asked_out", { with: agent.id })) S()._set_cool(q, "asked_out", day);
      } else if (!S().folk_answer(sim, agent, q)) {
        sim.event(`${q.name} turns ${firstName(agent.name)} down.`, agent, null, { tag: "flirt", agents: [q.id] });
      }
    } else if (value.act === "let_go") {
      const r = agent.relationships.get(q.id);
      if (r !== undefined) r.romance = Math.min(r.romance, 10.0);
    }
  }

  function _asked_out(sim, agent, fork, opt, value) {
    const q = _q(sim, value);
    if (q === null) return;
    const act = value.act;
    const ra = agent.relationships.get(q.id), rq = q.relationships.get(agent.id);
    if (act === "yes") {
      S().start_dating(sim, q, agent);
    } else if (act === "coffee") {
      for (const r of [ra, rq]) if (r !== undefined) r.romance = Math.min(100.0, r.romance + 4);
      S().bump(sim, agent, q, 3, 3);
      const place = getd(value, "place", null);
      if (place && !P().is_named(q)) {
        const f = G.folk !== undefined ? G.folk : null;
        if (f !== null && f.is_free(sim, q)) f.send_to(sim, q, place, "hang_out", 60);
      } else if (place && P().is_named(q) && nil(sim.pending_invite_for(q))) {
        sim.invite(agent, q.id, place);
      }
    } else if (act === "friends") {
      if (rq !== undefined) rq.romance = Math.max(0.0, rq.romance - 20);
      if (ra !== undefined) ra.romance = Math.min(ra.romance, 10.0);
    } else if (act === "flat") {
      if (rq !== undefined) rq.romance = Math.max(0.0, rq.romance - 30);
      S().bump(sim, q, agent, -8, -2);
    }
  }

  const DATE_WORDS = { warm: "a wonderful evening", bad: "an evening that goes badly", fine: "a pleasant evening" };

  function _date(sim, agent, fork, opt, value) {
    const q = _q(sim, value);
    if (q === null) return;
    const act = value.act;
    if (act === "go") {
      const place = getd(value, "place", null);
      const f = G.folk !== undefined ? G.folk : null;
      if (place && !P().is_named(q) && f !== null && f.is_free(sim, q)) f.send_to(sim, q, place, "hang_out", 120);
      const how = S().date_roll(sim, agent, q);
      sim.event(`${agent.name} and ${q.name} have ${getd(DATE_WORDS, how, "an evening out")}.`, agent, null,
        { tag: "meetup", agents: [q.id], place });
    } else if (act === "later") {
      for (const r of [agent.relationships.get(q.id), q.relationships.get(agent.id)]) {
        if (r !== undefined) r.romance = Math.min(100.0, r.romance + 1);
      }
    } else if (act === "no") {
      S().bump(sim, q, agent, -3, 0);
    } else if (act === "end") {
      S().end_couple(sim, agent, q);
    }
  }

  function _move_in(sim, agent, fork, opt, value) {
    const q = _q(sim, value);
    if (q === null) return;
    const act = value.act;
    if (act === "host") S().move_in(sim, q, agent);
    else if (act === "join") S().move_in(sim, agent, q);
    else if (act === "together") { if (!_place_together(sim, agent, q)) S().move_in(sim, q, agent); }
    else if (act === "wait") S().bump(sim, q, agent, -5, 0);
  }

  // A new household for the two, and the children under 18 each has at home, in the cheapest rental that fits
  // them all; false when none is free. A household they leave empty gives its home back (an owned one is sold).
  function _place_together(sim, a, b) {
    const H = G.housing;
    const olds = [P().household(sim, a), P().household(sim, b)];
    if (!H.cheapest_rental || olds.some(nil) || !H.new_household) return false;
    const members = S().with_kids(sim, a);
    for (const m of S().with_kids(sim, b)) if (members.every(x => x.id !== m.id)) members.push(m);
    const home = H.cheapest_rental(sim, { member_ids: members.map(m => m.id) });
    if (nil(home)) return false;
    const came = new Map(members.map(m => [m.id, m.household_id]));
    const nw = H.new_household(sim, members, home.id, "rent");
    if (nil(nw)) return false;
    olds.forEach((old, i) => {
      if (old !== nw && !(i === 1 && old === olds[0])) S().vacate(sim, old, members.filter(m => came.get(m.id) === old.id));
    });
    for (const r of [a.relationships.get(b.id), b.relationships.get(a.id)]) {
      if (r !== undefined) {
        r.kind = G.agent.RelationKind.PARTNER;
        r.since = sim.clock.tick;
      }
    }
    S()._count(sim, "moved_in");
    sim.event(`${a.name} and ${b.name} move in together at ${home.name}.`, a, null,
      { tag: "moved_in", agents: [b.id], place: home.place });
    return true;
  }

  function _propose(sim, agent, fork, opt, value) {
    const q = _q(sim, value);
    if (q === null) return;
    const act = value.act;
    if (act === "propose") {
      if (P().is_named(q)) {
        if (!P().prompt(sim, q, "proposal", { with: agent.id, ring: Boolean(getd(value, "ring", false)) })) {
          S().engage(sim, agent, q);
        }
      } else {
        S().engage(sim, agent, q);
      }
    } else if (act === "never") {
      const r = agent.relationships.get(q.id);
      if (r !== undefined) r.romance = Math.max(0.0, r.romance - 5);
    }
  }

  function _proposal(sim, agent, fork, opt, value) {
    const q = _q(sim, value);
    if (q === null) return;
    const act = value.act;
    if (act === "yes") {
      S().engage(sim, q, agent, 14);
    } else if (act === "long") {
      S().engage(sim, q, agent, 90);
    } else if (act === "not_yet") {
      S().bump(sim, q, agent, -10, 0);
    } else if (act === "no") {
      S().bump(sim, q, agent, -15, -5);
      for (const r of [agent.relationships.get(q.id), q.relationships.get(agent.id)]) {
        if (r !== undefined) r.romance = Math.max(0.0, r.romance - 20);
      }
    }
  }

  function _trouble(sim, agent, fork, opt, value) {
    const q = _q(sim, value);
    if (q === null) return;
    if (value.act === "space") {
      if (!nil(agent.life)) agent.life.cooldowns.breakup = sim.clock.day + 7;
    } else if (value.act === "end") {
      S().end_couple(sim, agent, q);
    }
  }

  function _split(sim, agent, fork, opt, value) {
    const q = _q(sim, value);
    if (q === null) return;
    if (value.act === "agree") {
      S().end_couple(sim, q, agent);
    } else if (value.act === "storm") {
      S().bump(sim, agent, q, -20, -20);
      S().end_couple(sim, agent, q);
    }
  }

  function _friend_in_need(sim, agent, fork, opt, value) {
    const q = _q(sim, value);
    if (q === null) return;
    const act = value.act;
    if (act === "lend") {
      S().lend(sim, agent, q, value.amount);
    } else if (act === "give") {
      const amount = value.amount;
      agent.money -= amount;
      q.money += amount;
      S().bump(sim, q, agent, 6, 2);
      sim.event(`${agent.name} gives ${q.name} $${commas(amount)}.`, agent, null, { tag: "loan", agents: [q.id] });
    } else if (act === "no") {
      S().bump(sim, q, agent, -8, 0);
    }
  }

  // --- outcome keys ------------------------------------------------------------------------------------------------

  function _life_rel(sim, agent, value) {
    const q = P().person(sim, value[0]);
    if (!nil(q) && q.alive) S().bump(sim, q, agent, value[1]);
  }

  function _life_rom(sim, agent, value) {
    const q = P().person(sim, value[0]);
    if (nil(q)) return;
    for (const r of [agent.relationships.get(q.id), q.relationships.get(agent.id)]) {
      if (r !== undefined) r.romance = Math.max(0.0, Math.min(100.0, r.romance + value[1]));
    }
  }

  Object.assign(G.people.PROMPTS, { crush: crush_fork, asked_out: asked_out_fork, date: date_fork,
    move_in: move_in_fork, propose: propose_fork, proposal: proposal_fork,
    relationship_trouble: relationship_trouble_fork, partner_split: partner_split_fork,
    friend_in_need: friend_in_need_fork });
  Object.assign(G.people.HANDLERS, { crush: _crush, asked_out: _asked_out, date: _date, move_in: _move_in,
    propose: _propose, proposal: _proposal, relationship_trouble: _trouble, partner_split: _split,
    friend_in_need: _friend_in_need });
  Object.assign(G.people.EFFECTS, { life_rel: _life_rel, life_rom: _life_rom });

  G.social_forks = { DAY, KINDS, STAY, about, crush_fork, asked_out_fork, date_fork, move_in_fork, propose_fork,
    proposal_fork, relationship_trouble_fork, partner_split_fork, friend_in_need_fork, _place_together, DAY_FULL,
    _date_when };
})(globalThis.GameOfAILife || (globalThis.GameOfAILife = {}));

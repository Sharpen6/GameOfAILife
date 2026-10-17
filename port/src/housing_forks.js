// Port of gameofailife/housing_forks.py: the four housing forks: house hunting, upkeep, emergency repairs and
// housing trouble (housing.md section 9).
//
// Each builder returns a Fork with exactly four options, or null when the fork doesn't come up. Every
// conditional option has a fixed fallback in its slot, so four is guaranteed by construction (decision 56).
// The fork is the household's: the builder sets a household cooldown when it builds one, so a partner is not
// asked the same question again. `forks.build_fork` resolves these lazily.
(function (G) {
  "use strict";
  const { getd, commas, firstName, minBy, maxBy, relKey } = G.py;
  const H = () => G.housing;
  const { Fork, Option, Outcome } = G.forks;
  const { CAR_SALE, DAY, GRACE_HOLD_DAYS, LANDLORD, MOVING_COST, ODD_JOBS_PAY, RENO_FACTOR, STAGES, STUFF_PRICE,
    TIERS, round10, stage_of } = G.housing;

  const MAJOR_KINDS = new Set(["house_hunt", "housing_trouble"]); // forks the Director settles by habit only with a lead of MAJOR_MARGIN

  const NO_CANDIDATE_RETRY = 6 * 60; // minutes before house_hunt looks again when nothing on the market will do
  const HUNT_COOLDOWN = 7 * DAY;
  const UPKEEP_COOLDOWN = 5 * DAY; // once a weekend
  const REPAIR_COOLDOWN = 60; // one adult answers the emergency
  const TROUBLE_COOLDOWN = { arrears: 3 * DAY, cant_fix: 7 * DAY };
  const RENT_CUT = 40; // a renter downsizes only to a home at least this much cheaper a week
  const DOWNSIZE_SHARE = 0.8; // an owner downsizes to a home worth at most this share of today's
  const DOWNSIZE_CONDITION = 50; // ... in at least this condition
  const HELP_MARGIN = 300; // asking a friend for the deficit plus this ...
  const HELP_RICH = 3; // ... of a friend with at least this many times that put by
  const REPAIR_FRIEND = 30; // affinity of a friend who would come and help fix it
  const HELP_FRIEND = 20; // affinity of a friend one could ask for money
  const HANDYMAN = 90;
  const PIZZA = 20;
  const BUILDERS_WORKS = 240; // minutes the builders' van stands at the lot
  const EMERGENCY_WORKS = 120;
  const UPKEEP_BELOW = 75; // upkeep comes up below this condition

  const TRADE = { leak: "plumber", boiler: "heating engineer", roof: "roofer", electrics: "electrician" };
  const WAIT = { leak: "Put a bucket under it and deal with it later", roof: "Put a bucket under it and deal with it later",
    boiler: "Wrap up warm and deal with it later", electrics: "Use candles and deal with it later" };
  const TROUBLE = { leak: "a pipe has burst in the kitchen at {home}.",
    boiler: "the boiler has broken down: no heating or hot water.",
    roof: "rain is coming in through the roof.", electrics: "the electrics keep tripping out." };
  const LOOKS = ["a little tired", "worn", "shabby", "run-down", "close to falling apart"]; // by stage
  const GOSSIP = [0.05, 0.1, 0.4, 0.7, 0.7]; // by stage

  // --- shared helpers ------------------------------------------------------------

  // When the household sits down to talk money: weekday evenings 18-21, weekend days 10-18.
  function _hh_window(sim) {
    const h = sim.clock.hour, wd = sim.clock.weekday;
    return (wd >= 5 && 10 <= h && h < 18) || (wd < 5 && 18 <= h && h < 21);
  }

  // An adult whose household's cooldown for this kind is over (the shift check comes last: it is the dear one).
  const _ready = (sim, agent, hh, kind) => agent.alive && agent.is_adult && getd(hh.cooldowns, kind, 0) <= sim.clock.tick;

  const _first = agent => firstName(agent.name);

  // ', shabby' or ', neglected' (or ', derelict') for a home in poor shape, else ''.
  function _stage_note(sim, home_id) {
    const st = stage_of(H().condition_of(sim, home_id));
    return st >= 2 ? `, ${STAGES[st][0]}` : "";
  }

  const _has_kids = (sim, hh) => H()._members(sim, hh).some(a => !a.is_adult);

  // The adult outside the household the character likes best, above `above` affinity, with at least `rich` put
  // by when given (ties: id).
  function _friend(sim, agent, hh, above, rich = null) {
    const pool = [];
    for (const [oid, rel] of agent.relationships) {
      const other = sim.agents.get(oid);
      if (!other || hh.member_ids.includes(oid) || !other.alive || !other.is_adult || rel.affinity <= above
        || (rich !== null && other.money + other.savings < rich)) continue;
      pool.push([rel.affinity, oid]);
    }
    return pool.length ? sim.agents.get(maxBy(pool)[1]) : null;
  }

  // Another adult of the household: the partner if there is one.
  function _partner(sim, agent, hh) {
    const others = H().adults(sim, hh).filter(a => a !== agent);
    const partners = others.filter(a => { const r = agent.relationships.get(a.id); return r && r.kind === "partner"; });
    return (partners.length ? partners : others.length ? others : [null])[0];
  }

  function _move_outcomes(sim, hh, agent, home_id, bargain, doubts) {
    const worse = stage_of(H().condition_of(sim, home_id)) >= 2 ? 0.3 : 0.15;
    const outs = [bargain ? new Outcome("bargain", "Turns out to be a real bargain", 0.4, +1, { fun: 15, family_bond: 2 })
      : new Outcome("dream_home", "Falls in love with the new place", 0.5, +1, { fun: 15, family_bond: 2 }),
    new Outcome("hidden_fault", "The survey missed a fault: repairs needed", worse, -1, { home_condition: -15 }),
    new Outcome("nice_neighbours", "Meets friendly new neighbours", 0.3, +1, { meet_neighbour: true }),
    new Outcome("moving_chaos", "A box of dishes breaks in the move", 0.25, -1, { money: -80, fun: -5 })];
    const partner = doubts ? _partner(sim, agent, hh) : null;
    if (partner) {
      outs.push(new Outcome("partner_doubts", `${_first(partner)} worries it's too expensive`,
        0.6 * getd(partner.profile.traits, "thrift", 0.5), -1, { [relKey(partner.id)]: -3, fun: -3 }));
    }
    return outs;
  }

  // --- house_hunt (major) -----------------------------------------------------------

  // A better home the household can afford is on the market: buy (or rent) the best, haggle for it, take the
  // cheaper one (or keep looking), or stay put.
  function house_hunt_fork(sim, agent) {
    const housing = H();
    const hh = sim.households.get(agent.household_id);
    const now = sim.clock.tick;
    if (!_hh_window(sim) || !_ready(sim, agent, hh, "house_hunt") || hh.arrears
      || (hh.moved_tick !== null && now - hh.moved_tick < housing.MOVE_GAP_DAYS * DAY)
      || sim.on_shift_now(agent)) return null;
    const cands = housing.hunt_candidates(sim, hh);
    if (!cands.length) {
      hh.cooldowns.house_hunt = now + NO_CANDIDATE_RETRY;
      return null;
    }
    hh.cooldowns.house_hunt = now + HUNT_COOLDOWN;
    const cur = sim.homes.get(hh.home_id);
    const renting = cur.owner !== hh.id;
    const crowded = housing.crowded(sim, hh);
    const funds = housing.funds(sim, hh);
    const outgo = housing.weekly_outgo(sim, hh);
    const cond = {}, worth = {};
    for (const h of cands) cond[h.id] = housing.condition_of(sim, h.id);
    for (const h of cands) worth[h.id] = housing.value(sim, h.id);
    const a = maxBy(cands, h => [TIERS[h.tier].rank, worth[h.id], cond[h.id], h.id]);
    const rest = cands.filter(h => h !== a);
    const b = rest.length ? minBy(rest, h => [housing.net_cost(sim, hh, h.id), cond[h.id], h.id]) : null;

    const rises = h => housing.weekly_outgo(sim, hh, h.id) > outgo;

    const bonus = h => (renting && housing.buys(h) ? 0.2 : 0.0) + (crowded && h.bedrooms > cur.bedrooms ? 0.3 : 0.0);

    function label(h, cheaper) {
      const the = cheaper ? "the cheaper " : "";
      const tier = TIERS[h.tier].label;
      if (housing.buys(h)) return `Buy ${the}${h.name} (${tier}${_stage_note(sim, h.id)}) for $${commas(worth[h.id])}`;
      return `Move into ${the}${h.name} (${tier}${_stage_note(sim, h.id)}) for $${h.rent}/week`;
    }

    function move(h, cheaper) {
      const how = housing.buys(h) ? "buy" : "rent";
      let tags;
      if (cheaper) {
        tags = { thrift: rises(h) ? 0.3 : 0.7, family: 0.3 };
        if (stage_of(cond[h.id]) >= 2) tags.diligence = 0.3;
      } else {
        tags = { family: 0.6, adventure: 0.4, thrift: rises(h) ? -0.6 : -0.2 };
      }
      return new Option(label(h, cheaper), [["move_house", h.place]], { cost: Math.max(0, housing.net_cost(sim, hh, h.id)),
        base: (cheaper ? 0.30 : 0.35) + bonus(h), tags, gains: { fun: cheaper ? 15 : 20 },
        outcomes: _move_outcomes(sim, hh, agent, h.id, cheaper, rises(h) && !cheaper),
        extra: { move: h.id, how }, household_pays: true, charge: false });
    }

    const best = move(a, false);
    let offer, haggle_label, cost, says;
    if (housing.buys(a)) {
      offer = housing._int(worth[a.id] * 0.9);
      haggle_label = `Offer $${commas(offer)} for ${a.name} and see what the seller says`;
      cost = housing.net_cost(sim, hh, a.id) - 0.1 * worth[a.id];
      says = ["The seller accepts the offer", "The seller meets them halfway", "Another buyer snaps it up first",
        "The seller turns the offer down"];
    } else {
      offer = housing._int(a.rent * 0.9);
      haggle_label = `Ask the landlord to let ${a.name} for $${offer}/week`;
      cost = housing.net_cost(sim, hh, a.id);
      says = [`${LANDLORD} agrees to the lower rent`, `${LANDLORD} meets them halfway`,
        "Another family takes it first", `${LANDLORD} turns the offer down`];
    }
    // The listing is held for the offer from the decision until the answer lands after the viewing, so the
    // answer is never about a home somebody else took meanwhile; a refusal hands it back to the market.
    const haggle = new Option(haggle_label, [["viewing", a.place]], { cost: Math.max(0, _whole(cost)), base: 0.30 + bonus(a),
      tags: { thrift: 0.5, adventure: 0.4, diligence: -0.1 }, gains: { fun: 10 },
      outcomes: [new Outcome("offer_accepted", says[0], 0.40, +1, { factor: 0.9, buy: a.id }, "deal"),
        new Outcome("meet_halfway", says[1], 0.35, +1, { factor: 0.95, buy: a.id }, "deal"),
        new Outcome("outbid", says[2], 0.25, -1, { withdraw: a.id, fun: -10 }, "deal"),
        new Outcome("refused", says[3], 1.0, 0, { fun: -4, release: a.id }, "deal")],
      extra: { hold: a.id }, household_pays: true, charge: false });
    let cheaper;
    if (b) {
      cheaper = move(b, true);
    } else {
      cheaper = new Option("Keep looking for the right place", [["read", "home"]], { base: 0.15,
        tags: { thrift: 0.3, diligence: 0.2, adventure: -0.2 }, gains: { fun: 10 },
        outcomes: [new Outcome("new_listing", "Spots a promising new listing", 0.3, +1, { fun: 4 })],
        extra: { hh_cooldown: 3 * DAY } });
    }
    const saves = renting && cands.some(h => housing.buys(h) && !rises(h));
    const stay_tags = { thrift: saves ? 0.0 : 0.5, adventure: -0.5 };
    if (crowded) stay_tags.family = -0.2;
    const stay = new Option(`Stay in ${cur.name} and keep the money`, [["relax_home", "home"]],
      { base: 0.25 - (crowded ? 0.4 : 0.0), tags: stay_tags, gains: { fun: 10 },
        outcomes: [new Outcome("content", "Feels content at home", 0.5, +1, { fun: 5 }),
          new Outcome("itchy_feet", "Keeps thinking about that place", 0.3, -1, { fun: -5 })],
        extra: { hh_cooldown: 14 * DAY } });
    const tenure = renting ? `rented, $${housing._int(hh.weekly_rent)}/week`
      : `yours, worth about $${commas(housing.value(sim, cur.id))}`;
    const question = `Your household has $${commas(_whole(funds))} put by. You live in ${cur.name} (${tenure}). `
      + "There are homes on the market you could afford. Do you move?";
    return new Fork(agent.id, "house_hunt", question, [best, haggle, cheaper, stay], now, { major: true });
  }

  const _whole = x => H()._int(x);

  // --- upkeep -----------------------------------------------------------------------

  // An owned home is wearing: builders, DIY, a tidy-up, or leave it. Weekends 09-17, below condition 75.
  function upkeep_fork(sim, agent) {
    const housing = H();
    const hh = sim.households.get(agent.household_id);
    const home = sim.homes.get(hh.home_id);
    const hour = sim.clock.hour;
    if (sim.clock.weekday < 5 || !(9 <= hour && hour < 17) || home.owner !== hh.id
      || !(home.tier === "house" || home.tier === "big_house") || home.emergency || !_ready(sim, agent, hh, "upkeep")) return null;
    const c = housing.condition_of(sim, home.id);
    if (c >= UPKEEP_BELOW || sim.on_shift_now(agent)) return null;
    hh.cooldowns.upkeep = sim.clock.tick + UPKEEP_COOLDOWN;
    const t = TIERS[home.tier];
    const st = stage_of(c);
    const reno = c < 50;
    const pts = reno ? _whole(100 - c) : Math.min(40, _whole(100 - c));
    const quote = round10(pts * t.pro_rate * (reno ? RENO_FACTOR : 1.0)) + housing.CALLOUT;
    const pro_base = 0.3 + (c < 40 ? 0.4 : 0.0) + (c < 20 ? 0.3 : 0.0);
    const leave_base = 0.0 - (c < 40 ? 0.3 : 0.0) - (c < 20 ? 0.3 : 0.0);
    const opts = [
      new Option(`Hire Millbrook Builders for ${reno ? "a full renovation" : "a proper job"} ($${commas(quote)})`,
        [["let_builders_in", "home"]], { cost: quote, base: pro_base,
          tags: { thrift: -0.5, diligence: 0.5, family: 0.3 }, gains: { fun: 10 },
          outcomes: [new Outcome("fine_job", "The builders do a beautiful job", 0.35, +1, { home_condition: 8 }),
            new Outcome("cowboys", "Cowboy builders: the work is shoddy", 0.12, -1,
              { home_condition: -_whole(pts / 2) }),
            new Outcome("hidden_damp", "They find hidden damp: the bill goes up", 0.15, -1,
              { hh_money: -_whole(0.4 * quote) })],
          extra: { repair: pts, works: BUILDERS_WORKS }, household_pays: true }),
      new Option(`Do it yourself this weekend ($${t.diy_cost} in materials)`, [["diy", "home"]], { cost: t.diy_cost,
        base: 0.3 - (c < 40 ? 0.1 : 0.0),
        tags: { thrift: 0.6, diligence: 0.5, adventure: 0.3, health: -0.2 }, gains: { fun: 10 },
        outcomes: [new Outcome("proud", "Proud of the work", 0.5, +1, { fun: 10 }),
          new Outcome("botched", "Botches part of the job", 0.18, -1, { home_condition: -8 }),
          new Outcome("hurt", "Hurts their back on the ladder", agent.age >= 65 ? 0.12 : 0.06, -1,
            { health: -8, energy: -10 }),
          new Outcome("help_arrives", "A neighbour pops over to help", 0.15, +1,
            { meet_neighbour: true, home_condition: 5 })],
        extra: { repair: t.diy_pts }, household_pays: true }),
      new Option(`Just tidy up and patch the worst bits ($${t.tidy_cost})`, [["tidy", "home"]], { cost: t.tidy_cost,
        base: 0.2, tags: { thrift: 0.4, diligence: 0.2, adventure: -0.3 }, gains: { fun: 5 },
        outcomes: [new Outcome("compliment", "A neighbour compliments the garden", 0.2, +1, { social: 6 }),
          new Outcome("drop_in_ocean", "Feels like a drop in the ocean", c < 50 ? 0.3 : 0.1, -1,
            { fun: -4 })],
        extra: { repair: 6 }, household_pays: true }),
      new Option("Leave it for another time", [["relax_home", "home"]], { base: leave_base,
        tags: { thrift: 0.5, diligence: -0.6, adventure: 0.2 }, gains: { fun: 20 },
        outcomes: [new Outcome("gossip", "The neighbours gossip about the state of the place", GOSSIP[st], -1,
          { reputation: -2 }),
        new Outcome("damage_spreads", "A small problem gets worse", 0.2, -1, { home_condition: -5 }),
        new Outcome("lazy_weekend", "A lovely lazy weekend", 0.4, +1, { fun: 8 })] }),
    ];
    const question = `${home.name} is looking ${LOOKS[st]} (condition ${Math.floor(c)}/100). `
      + "What do you do about it this weekend?";
    return new Fork(agent.id, "upkeep", question, opts, sim.clock.tick);
  }

  // --- repair (a live emergency) ----------------------------------------------------------

  // A live emergency at an owner-occupied home: call the trade, fix it yourself, ask a friend (or a cheap
  // handyman), or wait. 07:00-22:00.
  function repair_fork(sim, agent) {
    const hh = sim.households.get(agent.household_id);
    const home = sim.homes.get(hh.home_id);
    const live = home.emergency;
    if (!live || !(7 <= sim.clock.hour && sim.clock.hour < 22) || !(home.tier === "house" || home.tier === "big_house")
      || !_ready(sim, agent, hh, "repair") || sim.on_shift_now(agent)) return null;
    hh.cooldowns.repair = sim.clock.tick + REPAIR_COOLDOWN;
    const t = TIERS[home.tier];
    const kind = live.kind;
    const friend = _friend(sim, agent, hh, REPAIR_FRIEND);
    let helper;
    if (friend) {
      const rel = relKey(friend.id);
      const name = _first(friend);
      helper = new Option(`Ask ${name} to come and help ($${PIZZA} for pizza)`, [["fix_it", "home"]], { cost: PIZZA,
        base: 0.3, tags: { social: 0.7, family: 0.3, thrift: 0.4 },
        outcomes: [new Outcome("fixed_together", `Fixes it together with ${name}`, 0.5, +1,
          { fix_emergency: true, [rel]: 4 }, "fix"),
        new Outcome("friend_busy", `${name} can't make it`, 1.0, -1, { [rel]: -1, fun: -4 }, "fix")],
        extra: { ask_help: friend.id }, household_pays: true });
    } else {
      helper = new Option(`Call the cheapest handyman in the paper ($${HANDYMAN})`, [["let_builders_in", "home"]],
        { cost: HANDYMAN, base: 0.3, tags: { thrift: 0.5, adventure: 0.3 },
          outcomes: [new Outcome("fixed_cheap", "The handyman sorts it out", 0.6, +1, { fix_emergency: true }, "fix"),
            new Outcome("botched_cheap", "The handyman makes a mess of it", 0.8, -1, { home_condition: -5 }, "fix")],
          household_pays: true });
    }
    const opts = [
      new Option(`Call an emergency ${TRADE[kind]} now ($${t.emergency_cost})`, [["let_builders_in", "home"]],
        { cost: t.emergency_cost, base: 0.45,
          tags: { thrift: -0.5, diligence: 0.3, family: 0.4, health: 0.2 },
          outcomes: [new Outcome("quick_fix", "Fixed in no time", 0.5, +1, { fun: 5 }),
            new Outcome("more_damage", "They find more damage behind the wall", 0.2, -1,
              { hh_money: -120, home_condition: -3 }),
            new Outcome("overcharged", "The bill is bigger than quoted", 0.15, -1, { hh_money: -60 })],
          extra: { fix_emergency: true, works: EMERGENCY_WORKS }, household_pays: true }),
      new Option(`Try to fix it yourself ($${t.parts} in parts)`, [["fix_it", "home"]], { cost: t.parts, base: 0.3,
        tags: { thrift: 0.6, diligence: 0.4, adventure: 0.4, health: -0.2 },
        outcomes: [new Outcome("fixed_it", "Fixes it!", 0.55, +1, { fix_emergency: true, fun: 10 }, "diy"),
          new Outcome("made_worse", "Makes it worse", 0.45, -1, { home_condition: -8 }, "diy"),
          new Outcome("hurt", "Gets hurt doing it", agent.age >= 65 ? 0.14 : 0.07, -1, { health: -10 })],
        household_pays: true }),
      helper,
      new Option(WAIT[kind], [["relax_home", "home"]], { base: -0.2, tags: { thrift: 0.5, diligence: -0.5, adventure: 0.2 },
        gains: { fun: 10 },
        outcomes: [new Outcome("gets_worse", "It gets worse overnight", 0.5, -1, { home_condition: -6 }),
          new Outcome("holds_up", "It holds up for now", 0.4, +1, {})],
        extra: { hh_cooldown: DAY } }),
    ];
    const question = `Trouble at home: ${TROUBLE[kind].replace("{home}", home.name)} What do you do?`;
    return new Fork(agent.id, "repair", question, opts, sim.clock.tick);
  }

  // --- housing_trouble (major) ---------------------------------------------------------

  // [reason, deficit, renovation quote] when the household is in trouble, else null.
  function _trouble(sim, hh) {
    const housing = H();
    const f = housing.funds(sim, hh);
    if (hh.arrears >= 1 && f < 0) return ["arrears", -f, 0];
    const home = sim.homes.get(hh.home_id);
    if (home.owner === hh.id && housing.condition_of(sim, home.id) < 40) {
      const reno = housing.reno_cost(sim, home.id);
      const spare = f - 2 * housing.weekly_outgo(sim, hh);
      if (reno > spare) return ["cant_fix", reno - Math.max(spare, 0.0), reno];
    }
    return null;
  }

  function _downsize_outcomes(sim, hh) {
    const outs = [new Outcome("fresh_start", "Feels like a fresh start", 0.35, +1, { fun: 10 }),
      new Outcome("homesick", "Misses the old place", 0.4, -1, { fun: -10 })];
    if (_has_kids(sim, hh)) outs.push(new Outcome("kids_upset", "The children are upset about moving", 0.5, -1, { family_bond: -3 }));
    return outs;
  }

  // The trouble options that are available now, in order: downsize-buy, downsize-rent, ask for help, sell the
  // car, sell belongings (housing.md 9.4, PLAN 5.4).
  function _chain(sim, agent, hh, reason, deficit, esc) {
    const housing = H();
    const now = sim.clock.tick;
    const cur = sim.homes.get(hh.home_id);
    const owner = cur.owner === hh.id;
    const sale = owner ? housing.sale_proceeds(sim, cur.id) : 0;
    const chain = [];
    if (owner) {
      const worth = housing.value(sim, cur.id);
      const smaller = housing.vacancies(sim, "for_sale").filter(h => housing.fits(sim, hh, h)
        && housing.condition_of(sim, h.id) >= DOWNSIZE_CONDITION
        && housing.value(sim, h.id) <= DOWNSIZE_SHARE * worth && housing.affordable(sim, hh, h.id));
      if (smaller.length) {
        const s = minBy(smaller, h => [housing.value(sim, h.id), -housing.condition_of(sim, h.id), h.id]);
        chain.push(new Option(`Sell ${cur.name} (about $${commas(sale)}) and buy the smaller ${s.name} for `
          + `$${commas(housing.value(sim, s.id))}`, [["move_house", s.place]],
        { cost: Math.max(0, housing.net_cost(sim, hh, s.id)), base: 0.35 + 0.25 * esc,
          tags: { thrift: 0.6, family: -0.1, adventure: 0.2 },
          outcomes: _downsize_outcomes(sim, hh), extra: { move: s.id, how: "buy" },
          household_pays: true, charge: false }));
      }
    }
    // Rents are whole tens, so "under rent - RENT_CUT + 1" is "at least RENT_CUT cheaper".
    const r = housing.cheapest_rental(sim, hh, owner ? null : hh.weekly_rent - RENT_CUT + 1);
    if (r) {
      let text, cost;
      if (owner) {
        text = `Sell ${cur.name} (about $${commas(sale)}) and rent ${r.name} for $${r.rent}/week`;
        cost = 0;
      } else {
        text = `Move to the cheaper ${r.name} ($${r.rent}/week instead of $${housing._int(hh.weekly_rent)})`;
        cost = reason === "arrears" && hh.arrears > 0 ? 0 : MOVING_COST; // the landlord moves them free
      }
      chain.push(new Option(text, [["move_house", r.place]], { cost, base: 0.35 + 0.25 * esc,
        tags: { thrift: 0.7, family: -0.3, adventure: 0.2 }, outcomes: _downsize_outcomes(sim, hh),
        extra: { move: r.id, how: "rent" }, household_pays: true, charge: false }));
    }
    const friend = _friend(sim, agent, hh, HELP_FRIEND, HELP_RICH * (deficit + HELP_MARGIN));
    if (friend) {
      const amount = Math.ceil((deficit + HELP_MARGIN) / 100) * 100;
      const rel = relKey(friend.id);
      const name = _first(friend);
      chain.push(new Option(`Ask ${name} to help out with $${commas(amount)}`, [["phone_call", null]], { base: 0.3,
        tags: { family: 0.6, social: 0.4, thrift: 0.2, diligence: -0.2 },
        outcomes: [new Outcome("helps", `${name} helps out`, 0.55, +1,
          { amount, gift_from: friend.id, [rel]: 2 }, "help"),
        new Outcome("lecture", `${name} helps, with a lecture about money`, 0.6, 0,
          { amount, gift_from: friend.id, [rel]: -3, fun: -5 }, "help"),
        new Outcome("refuses", `${name} says no`, 1.0, 0, { [rel]: -4, fun: -8 }, "help")] }));
    }
    if (housing.adults(sim, hh).some(a => a.owns_car)) {
      chain.push(new Option(`Sell the car (about $${commas(CAR_SALE)})`, [["relax_home", "home"]], { base: 0.25,
        tags: { thrift: 0.6, adventure: -0.2, health: 0.2 },
        outcomes: [new Outcome("miss_car", "Misses having the car", 0.5, -1, { fun: -6 })],
        extra: { sell_car: true } }));
    }
    if (getd(hh.cooldowns, "sell_stuff", 0) <= now) {
      chain.push(new Option(`Sell some furniture and belongings (about $${STUFF_PRICE})`, [["relax_home", "home"]],
        { base: 0.2, tags: { thrift: 0.5, family: -0.2 },
          outcomes: [new Outcome("sad_to_see", "Sad to see their things go", 0.5, -1, { fun: -8 })],
          extra: { sell_stuff: STUFF_PRICE } }));
    }
    return chain;
  }

  // Grace and odd jobs: always available, their good outcome rationed by a household cooldown (PLAN 5.4).
  function _fallbacks(sim, hh, esc) {
    const now = sim.clock.tick;
    const owner = sim.homes.get(hh.home_id).owner === hh.id;
    const granted = getd(hh.cooldowns, "grace", 0) > now ? 0.0 : 0.6;
    const paid = getd(hh.cooldowns, "odd_jobs", 0) > now ? 0.0 : 0.65;
    const grace = new Option(owner ? "Ask the bank for a few weeks' grace" : `Ask ${LANDLORD} for a few weeks' grace`,
      [["phone_call", null]], { base: 0.2 + 0.1 * esc, tags: { thrift: 0.3, diligence: 0.2, social: 0.2 },
        outcomes: [new Outcome("granted", "They agree to give it a few weeks", granted, +1,
          { grace: GRACE_HOLD_DAYS }, "grace"),
        new Outcome("refused", "They say no", 1.0, 0, { fun: -6 }, "grace")] });
    const odd = new Option(`Pick up odd jobs around the neighbourhood (about $${ODD_JOBS_PAY})`, [["odd_jobs", null]], { base: 0.25,
      tags: { diligence: 0.6, thrift: 0.4, adventure: 0.2, health: -0.2 },
      outcomes: [new Outcome("paid", `Earns $${ODD_JOBS_PAY} doing odd jobs`, paid, +1, { money: ODD_JOBS_PAY }, "odd"),
        new Outcome("no_takers", "Nobody needs a hand this week", 1.0, 0, { fun: -4 }, "odd")],
      extra: { odd_jobs: true } });
    return [grace, odd];
  }

  // In the red after the Sunday charge, or a home falling apart that can't be fixed. Options:
  // (chain + FALLBACKS)[:2] + [cut back, hope], so always four.
  function housing_trouble_fork(sim, agent) {
    const housing = H();
    const hh = sim.households.get(agent.household_id);
    if (!_hh_window(sim) || !_ready(sim, agent, hh, "housing_trouble")) return null;
    const trouble = _trouble(sim, hh);
    if (trouble === null || sim.on_shift_now(agent)) return null;
    const [reason, deficit, reno] = trouble;
    const now = sim.clock.tick;
    hh.cooldowns.housing_trouble = now + TROUBLE_COOLDOWN[reason];
    hh.trouble_seen += 1;
    const esc = Math.min(2, reason === "arrears" ? Math.max(0, hh.arrears - 1) : hh.trouble_seen - 1);
    const others = housing.adults(sim, hh).filter(a => a !== agent);
    const cut = new Option("Cut back hard for a few weeks: no treats, no repairs", [["relax_home", "home"]], { base: 0.3 - 0.2 * esc,
      tags: { thrift: 0.8, diligence: 0.3, adventure: -0.3, family: -0.1 },
      outcomes: [new Outcome("scrapes_by", "Manages to scrape by", 0.5, +1, { fun: 4 })]
        .concat(others.length ? [new Outcome("money_rows", "Arguments about money at home", 0.35, -1, { family_bond: -3, fun: -6 })] : []),
      extra: { belt_tighten: 14 * DAY } });
    const hope = new Option(reason === "arrears" ? "Hope things pick up on their own" : "Live with it for now",
      [["relax_home", "home"]], { base: -0.1 - 0.2 * esc, tags: { thrift: -0.5, adventure: 0.3, diligence: -0.4 },
        gains: { fun: 10 },
        outcomes: [new Outcome("windfall", "A forgotten refund turns up", 0.1, +1, { money: 150 }),
          new Outcome("sleepless", "Lies awake worrying", 0.6, -1, { energy: -15 })] });
    const opts = _chain(sim, agent, hh, reason, deficit, esc).concat(_fallbacks(sim, hh, esc)).slice(0, 2).concat([cut, hope]);
    const cur = sim.homes.get(hh.home_id);
    let question;
    if (reason === "arrears") {
      question = `Money is tight: your household is $${commas(_whole(deficit))} in the red after this week's bills.`;
      if (hh.arrears >= 2) question += cur.owner === hh.id ? " The bank wants its money." : ` ${LANDLORD} has sent a final warning.`;
      question += " What do you do?";
    } else {
      question = `${cur.name} is falling apart and a proper renovation would cost about $${commas(reno)}, more than you `
        + "can spare. What do you do?";
    }
    return new Fork(agent.id, "housing_trouble", question, opts, now, { major: true });
  }

  G.housing_forks = {
    MAJOR_KINDS, NO_CANDIDATE_RETRY, HUNT_COOLDOWN, UPKEEP_COOLDOWN, REPAIR_COOLDOWN, TROUBLE_COOLDOWN, RENT_CUT,
    DOWNSIZE_SHARE, DOWNSIZE_CONDITION, HELP_MARGIN, HELP_RICH, REPAIR_FRIEND, HELP_FRIEND, HANDYMAN, PIZZA,
    BUILDERS_WORKS, EMERGENCY_WORKS, UPKEEP_BELOW, TRADE, WAIT, TROUBLE, LOOKS, GOSSIP, _hh_window, _ready, _first,
    _stage_note, _has_kids, _friend, _partner, _move_outcomes, house_hunt_fork, _whole, upkeep_fork, repair_fork,
    _trouble, _downsize_outcomes, _chain, _fallbacks, housing_trouble_fork,
  };
})(globalThis.GameOfAILife || (globalThis.GameOfAILife = {}));

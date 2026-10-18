// Port of gameofailife/forks.py: forks: the moments an agent's day needs a real decision.
//
// Each fork has exactly four options. Every option carries a hidden table of possible outcomes with
// probabilities; the agent's Luck shifts those odds. The same outcome can appear under several options at
// different odds.
//
// Port notes: Python's ("rel", id) effect key is the string "rel:<id>" (G.py.relKey). Python numbers forks from a
// module-wide counter; this port keeps no module state, so `build_fork` numbers them from the simulation's own
// counter (sim._fork_ids), which gives the same "f1", "f2", ... within one city.
(function (G) {
  "use strict";
  const { getd, hasOwn, sum, pyRound, fmt, pad2, firstName, maxBy, relKey, PyError } = G.py;

  const RAIN_CHANCE = { spring: 0.35, summer: 0.10, autumn: 0.40, winter: 0.60 };
  const OBVIOUS_MARGIN = 0.45; // default-score lead at which the Director decides on its own
  const MAJOR_MARGIN = 1.0; // the lead a major fork (a move, housing trouble) needs before habit settles it
  const LUCK_STRENGTH = 0.6; // Luck 100 multiplies good odds by 1.6 and bad odds by 0.4
  const KID_CURFEW = 19; // hour after which characters under 18 stay home for the night
  const WORK_LEAD = 45; // minutes before a shift the work fork opens (more if the walk is long)
  const WORK_LATE = 60; // minutes after a shift starts that the work fork still opens, for a late arrival
  const SHOP_MINUTES = 45; // how long the payday shopping trip takes (sim.ACTIVITIES["shopping"])
  const HANG_OUT_MINUTES = 90; // how long hanging out at a cafe takes (sim.ACTIVITIES["hang_out"])
  const COFFEE_MINUTES = 15; // how long a coffee takes (sim.ACTIVITIES["coffee"])
  const COFFEE_DETOUR = 15; // minutes a cafe may add to the walk to work and still be on the way (PLAN decision 55)
  const COFFEE_LATE = 0.15; // the cafe's "Arrives late" odds when the cup still gets them in on time (a queue at the counter)
  const SNACK_MINUTES = 5; // how long a snack takes (sim.ACTIVITIES["snack"])
  const EAT_OUT_MINUTES = 40; // how long a meal out takes (sim.ACTIVITIES["eat_out"])
  const GROCERY_MINUTES = 20; // how long the grocery shopping takes (sim.ACTIVITIES["buy_groceries"])
  const DINNER_MINUTES = 90; // how long a family dinner out takes (sim.ACTIVITIES["family_dinner"])
  const LATE_BASE_DROP = 20; // minutes late at which an option's common-sense value has dropped by 1 (the most it drops)
  const LATE_ODDS = 40; // minutes late per +1 of the option's "Arrives late" odds (at most +0.5)
  const TAXI_NO_HURRY = 0.4; // how much the taxi's common-sense value drops while the usual way still gets them in on time
  const WOKE_GAP = 120; // minutes after waking up before the sleep fork can come up again
  const SHIFT_SOON = 120; // ... and the minutes before a shift starts within which it never comes up
  const MAX_OUTING_MINUTES = 40; // the longest trip (the way the character will go, the worst bus wait) to an outing's place
  const TRAVEL_KINDS = ["invite", "hunger", "payday", "groceries", "lonely", "free_time"]; // forks whose scores weigh the trip
  const TRAVEL_COST = 0.004; // common-sense value lost per minute an option adds to the day's travel, there and home again
  const NIGHT_TRAVEL = 2; // ... times this from NIGHT_FROM in the evening until NIGHT_UNTIL in the morning
  const NIGHT_FROM = 20, NIGHT_UNTIL = 7;
  const COOPED_KINDS = ["invite", "lonely", "free_time"]; // forks whose options out of the house gain after a day indoors
  const COOPED_UP = 0.3; // the most a day indoors adds to such an option ...
  const COOPED_HOURS = 12; // ... rising from 0 after this many hours since the character was last out, to COOPED_UP 12 later
  const IDLE_HOME = 120; // waking minutes idle at home after which an adult's free time comes up whatever their fun ...
  const IDLE_SPREAD = 60; // ... plus a personal 0-59 (FIXLISTS 8)
  const OUTDOOR = ["walk_park", "play"]; // activities out in the weather
  const RAIN_PENALTY = { spring: 0.3, summer: 0.25, autumn: 0.35, winter: 0.5 }; // what rain takes off an outdoor option
  const BEDTIME = 22 * 60; // the minute the sleep fork can come up on most evenings ...
  const WEEKEND_BED = 23 * 60; // ... and on Friday and Saturday evenings, plus a personal 0-59 (FIXLISTS 7)
  const DINNER_FROM = 17, DINNER_UNTIL = 20; // Saturday hours a family dinner out happens in (FIXLISTS 6)
  const LONELY_IDLE_COOLDOWN = 360; // minutes before the lonely fork returns after a choice that does not help

  class Outcome {
    constructor(id, label, p, valence, effects = {}, group = null) {
      this.id = id;
      this.label = label;
      this.p = p;
      this.valence = valence; // +1 good, -1 bad, 0 neutral; Luck pushes good up and bad down
      this.effects = effects;
      this.group = group; // within a group the first hit wins; later ones are neither rolled nor logged
    }
  }

  // new Option(label, steps, {cost, vehicle, tags, gains, outcomes, extra, base, household_pays, charge}).
  // `steps` are [activity, place] pairs, place "home" | "job" | a place id | null (here).
  class Option {
    constructor(label, steps, o = {}) {
      this.label = label;
      this.steps = steps;
      this.cost = o.cost ?? 0.0;
      this.vehicle = o.vehicle ?? G.travel.USUAL; // "usual": each trip the usual way (travel.trip_mode); or a mode for every trip
      this.tags = o.tags ?? {}; // how it fits each play-style trait
      this.gains = o.gains ?? {}; // expected need gains, for default scoring
      this.outcomes = o.outcomes ?? [];
      this.extra = o.extra ?? {};
      this.base = o.base ?? 0.0; // common-sense value whatever the personality (going to work beats skipping it)
      this.household_pays = o.household_pays ?? false; // the cost comes from the pooled adults' money and savings
      this.charge = o.charge ?? true; // false: deciding charges nothing (a move pays its own way when it goes through)
      this.late_by = o.late_by ?? 0; // minutes late the work fork's timing found when it was built (_on_time; sim._retime redoes it)
    }

    // What the agent (and God) may see: never the outcome table.
    public(index, minutes = null) {
      const out = { index, label: this.label, cost: pyRound(this.cost, 2) };
      if (minutes !== null && minutes !== undefined) out.travel_minutes = minutes;
      if (this.household_pays) out.household = true;
      const places = this.steps.map(s => s[1] ?? null).filter(where => where !== null);
      if (places.length && places.every(where => where === "home")) out.home = true; // it all happens at home: any minutes are the way home (FIXLISTS 16)
      return out;
    }
  }

  // new Fork(agent_id, kind, question, options, tick, {major, id}). `id` is set by build_fork (see the header).
  class Fork {
    constructor(agent_id, kind, question, options, tick, o = {}) {
      this.agent_id = agent_id;
      this.kind = kind;
      this.question = question;
      this.options = options;
      this.tick = tick;
      this.id = o.id ?? null;
      this.status = "open"; // open, asked, decided, withdrawn (no longer asked, nothing played)
      this.choice = null;
      this.decided_by = null; // habit, default, model, timeout
      this.reason = "";
      this.happened = [];
      this.scores = [];
      this.major = o.major ?? false; // a move or housing trouble: habit settles it only with a lead of MAJOR_MARGIN
      this.controller = null; // the controller asked, if one was
      this.model = null; // the model that controller declared in its hello
      this.profile_choice = null; // the option the profile scores highest (first on ties), set when asked
    }
  }

  function luck_odds(p, valence, luck) {
    const shift = LUCK_STRENGTH * (luck - 50) / 50 * valence;
    return Math.max(0.0, Math.min(1.0, p * (1 + shift)));
  }

  const urgency = level => ((100 - level) / 100) ** 2;

  // How the character's play-style profile rates each option.
  //
  // In the outing forks (TRAVEL_KINDS) an option loses TRAVEL_COST for each minute it adds to the day's travel
  // (extra_travel), twice that in the evening and at night; in COOPED_KINDS one out of the house gains up to
  // COOPED_UP after a day indoors (cooped_up).
  function default_scores(agent, fork, sim) {
    const weigh = TRAVEL_KINDS.includes(fork.kind);
    const cooped = COOPED_KINDS.includes(fork.kind) ? cooped_up(sim, agent) : 0.0;
    const rate = TRAVEL_COST * (sim.clock.hour >= NIGHT_FROM || sim.clock.hour < NIGHT_UNTIL ? NIGHT_TRAVEL : 1);
    const home = weigh || cooped > 0 ? sim.home_of(agent) : null;
    const direct = weigh ? _trip(sim, agent, home)[0] : 0;
    const rain = sim.weather === "rain" ? RAIN_PENALTY[sim.clock.season] : 0.0; // outdoor options in the rain (FIXLISTS 12)
    const scores = [];
    for (const opt of fork.options) {
      const style = sum(Object.entries(opt.tags).map(([t, v]) => (getd(agent.profile.traits, t, 0.5) - 0.5) * 2 * v));
      const need = sum(Object.entries(opt.gains).filter(([n]) => hasOwn(agent.needs, n))
        .map(([n, g]) => urgency(agent.needs[n]) * g / 25));
      const afford = G.housing.afford_score(sim, agent, opt);
      let score = opt.base + 0.6 * style + need + afford;
      if (weigh) {
        const minutes = extra_travel(sim, agent, opt, direct);
        if (minutes > 0) score -= minutes * rate;
      }
      if (cooped > 0 && _goes_out(sim, agent, opt, home)) score += cooped;
      if (rain && opt.steps.some(s => OUTDOOR.includes(s[0]))) score -= rain;
      scores.push(pyRound(score, 3));
    }
    return scores;
  }

  // [minutes, mode] of the trip from here to a place the way the character will go (travel.trip_mode), counting
  // the worst bus wait; [0, "walk"] when they are inside it.
  function _trip(sim, agent, place_id) {
    if (agent.inside === place_id) return [0, "walk"];
    const mode = G.travel.trip_mode(sim, agent, place_id);
    return [sim.travel_minutes(agent, place_id, mode, true), mode];
  }

  // Minutes an option adds to the character's travel today: to its first stop the way they will go, and home
  // from its last (by car if they drove, else by bus when the walk is long), less the trip straight home
  // (`direct`, worked out when not given). 0 for an option that stays here or goes straight home.
  function extra_travel(sim, agent, opt, direct = null) {
    const stops = opt.steps.map(s => sim._resolve_place(agent, s[1])).filter(p => p);
    if (!stops.length) return 0;
    const home = sim.home_of(agent);
    const [there, mode] = _trip(sim, agent, stops[0]);
    const last = stops[stops.length - 1];
    let back = 0;
    if (last !== home) {
      const walk = sim.town.walk_minutes(sim.town.places.get(last).entry, home);
      back = G.travel.leg_minutes(sim, last, home, mode === "car" ? "car"
        : G.travel.BUS_MIN_WALK < walk && walk < G.travel.UNREACHABLE ? "bus" : "walk");
    }
    if (direct === null || direct === undefined) direct = _trip(sim, agent, home)[0];
    return Math.max(0, there + back - direct);
  }

  // What a day indoors adds to an option out of the house: 0 until COOPED_HOURS since the character was last
  // out (agent.out_tick, kept by the simulation; the world's first midnight before that), rising evenly to
  // COOPED_UP over the next COOPED_HOURS. 0 while they are out.
  function cooped_up(sim, agent) {
    if (agent.inside !== sim.home_of(agent)) return 0.0;
    const hours = (sim.clock.tick - (agent.out_tick ?? 0)) / 60;
    return COOPED_UP * Math.min(1.0, Math.max(0.0, (hours - COOPED_HOURS) / COOPED_HOURS));
  }

  // True when one of the option's steps is somewhere other than home (a step "here" counts as where they are).
  function _goes_out(sim, agent, opt, home) {
    for (const [, where] of opt.steps) {
      const place_id = sim._resolve_place(agent, where) || agent.inside;
      if (place_id !== home) return true;
    }
    return false;
  }

  // --- helpers ------------------------------------------------------------------

  // A character's own fixed number in 0..span-1 (from their id), so habits like a lie-in differ person to person.
  function personal(agent, span) {
    let total = 0;
    for (let i = 0; i < agent.id.length; i++) total += agent.id.charCodeAt(i) * (i + 1);
    return total % span;
  }

  // First names as a list: "Noa", "Noa and Tom", "Noa, Tom and Eli".
  function names(people) {
    const first = people.map(p => firstName(p.name));
    return first.length === 1 ? first[0] : first.slice(0, -1).join(", ") + " and " + first[first.length - 1];
  }

  // True from the moment today's work fork can open until the shift is under way or missed (FIXLISTS 10): no
  // leisure fork starts then.
  function in_work_window(sim, agent) {
    const start = sim._shift_start_tick(agent);
    return start !== null && sim.clock.tick >= start - work_lead(sim, agent);
  }

  // The fork message's `you.today` (FIXLISTS 10): "work 09:00-17:00 (in 46 min)", "work 09:00-17:00 (started 5 min
  // ago)", "work done; next shift Wed 09:00", "Day off; next shift Tue 16:00", or "No work or school".
  function today_line(sim, agent) {
    const DAY_NAMES = G.clock.DAY_NAMES;
    const job = agent.job;
    if (!job || !job.workdays.length) return "No work or school";
    const what = job.hourly_wage === 0 ? "school" : "work";
    const hours = `${pad2(job.start_hour)}:00-${pad2(job.end_hour)}:00`;
    const m = sim.clock.minute_of_day, today = sim.clock.weekday;
    if (job.workdays.includes(today) && m < job.end_hour * 60 && agent.worked_today !== sim.clock.day) {
      if (m < job.start_hour * 60) return `${what} ${hours} (in ${job.start_hour * 60 - m} min)`;
      return `${what} ${hours} (started ${m - job.start_hour * 60} min ago)`;
    }
    if (job.workdays.includes(today) && agent.worked_today === sim.clock.day && m < job.end_hour * 60) {
      return agent.activity === "work" ? `${what} ${hours} (there now)` : `${what} ${hours} (not going today)`;
    }
    let nxt = 1;
    while (!job.workdays.includes((today + nxt) % 7)) nxt += 1;
    const label = nxt === 1 ? "tomorrow" : DAY_NAMES[(today + nxt) % 7];
    const done = job.workdays.includes(today) ? `${what} done` : "Day off";
    return `${done}; next ${what === "school" ? "school" : "shift"} ${label} ${pad2(job.start_hour)}:00`;
  }

  // The closest family member or partner outside the household (someone to phone), or null.
  function _family_away(sim, agent) {
    const hh = sim.household(agent).member_ids;
    const pool = [];
    for (const [oid, r] of agent.relationships) {
      const other = sim.agents.get(oid);
      if ((r.kind === "family" || r.kind === "partner") && !hh.includes(oid) && other !== undefined && other !== null
        && other.alive) pool.push([r.affinity, oid]);
    }
    return pool.length ? sim.agents.get(maxBy(pool)[1]) : null;
  }

  // The friend (outside the household, affinity over 10, the same age group) the character likes most after
  // `taken`, the one already asked along: someone to ask on a walk (FIXLISTS 5), or null.
  function _walk_friend(sim, agent, taken) {
    const hh = sim.household(agent).member_ids;
    const pool = [];
    for (const [oid, r] of agent.relationships) {
      const o = sim.agents.get(oid);
      if (!hh.includes(oid) && oid !== taken && r.affinity > 10 && o !== undefined && o !== null && o.alive
        && o.is_adult === agent.is_adult) pool.push([r.affinity, oid]);
    }
    return pool.length ? sim.agents.get(maxBy(pool)[1]) : null;
  }

  // The household member at home and free to spend time with (the one the character likes most), or null.
  function _housemate_home(sim, agent) {
    const home = sim.home_of(agent);
    const pool = [];
    for (const m of sim.household(agent).member_ids) {
      const o = sim.agents.get(m);
      if (m !== agent.id && o.alive && o.inside === home && sim._interruptible(o)) {
        pool.push([agent.relationships.has(m) ? agent.relationships.get(m).affinity : 0, m]);
      }
    }
    return pool.length ? sim.agents.get(maxBy(pool)[1]) : null;
  }

  // Who comes to a family dinner out now: the household members free to come (FIXLISTS 6), or null when nobody is,
  // when it is not Saturday DINNER_FROM-DINNER_UNTIL with time for the meal, or when a child under 10 would be left
  // at home with no adult.
  function _dinner_party(sim, agent) {
    const minute = sim.clock.minute_of_day;
    if (sim.clock.weekday !== 5 || !(DINNER_FROM * 60 <= minute && minute <= DINNER_UNTIL * 60 - DINNER_MINUTES)) return null;
    const home = sim.home_of(agent);
    const others = sim.household(agent).member_ids.filter(m => m !== agent.id && sim.agents.get(m).alive)
      .map(m => sim.agents.get(m));
    const party = others.filter(o => sim._interruptible(o));
    const staying = others.filter(o => !party.includes(o) && o.is_adult && o.inside === home);
    if (!party.length || others.some(o => o.age < 10 && !party.includes(o) && !staying.length)) return null;
    return party;
  }

  const _late = p => new Outcome("late", "Arrives late", p, -1, { reputation: -3, memory: "Got in late and the boss noticed." }, "arrival");

  const _meet_new = p => new Outcome("meet_new", "Meets someone new", p, +1, { meet_new: true });

  // City.md 7.7's timing-aware default: an option whose trip (travel minutes, and any stop on the way) takes
  // longer than the minutes left before the shift loses up to 1 of its common-sense value, a twentieth for each
  // minute it would be late, and its hidden "Arrives late" odds rise by a fortieth a minute, at most 0.5.
  function _on_time(opt, trip, minutes_left) {
    const late_by = trip - minutes_left;
    if (late_by > 0) {
      opt.base = pyRound(opt.base - Math.min(1.0, late_by / LATE_BASE_DROP), 3);
      retime_late(opt, late_by);
    }
    return opt;
  }

  // Set the option's hidden "Arrives late" odds for arriving `late_by` minutes late (none when on time): the late
  // odds it was built with, plus a fortieth a minute, at most 0.5 (sim._retime calls it again when an answer lands
  // after the character set off).
  function retime_late(opt, late_by) {
    for (const out of opt.outcomes) {
      if (out.id === "late") {
        out.p = Math.max(0.0, Math.min(1.0, out.p - Math.min(0.5, Math.max(0, opt.late_by) / LATE_ODDS)
          + Math.min(0.5, Math.max(0, late_by) / LATE_ODDS)));
      }
    }
    opt.late_by = Math.max(0, late_by);
  }

  // True when a child should not be heading out (now or within `hours_ahead`).
  function _curfew(sim, agent, hours_ahead = 0.0) {
    const hour = sim.clock.hour + hours_ahead;
    return !agent.is_adult && (hour >= KID_CURFEW || sim.clock.hour < 6);
  }

  // True when the place is open by the time the character walks in, and still open `stay` minutes later.
  function _open_on_arrival(sim, agent, place_id, stay = 0) {
    const place = sim.town.places.get(place_id);
    const arrive = sim.clock.hour + sim.walk_minutes(agent, place_id) / 60;
    return place.is_open(arrive) && place.is_open(arrive + stay / 60);
  }

  // The place of `kinds` an outing goes to: travel.nearest's pick (open when the character walks in and still
  // open `stay` minutes later; nearest them, or nearest both them and `meet`, or nearest `origin`), or null when
  // there is none, when the trip there the way they will go (by car, bus or on foot, the worst bus wait counted)
  // is over MAX_OUTING_MINUTES, or when the trip, the stay and the way on to today's shift (by car if they drove,
  // else the bus when it saves time) would not leave SHIFT_MARGIN minutes before it starts. With every place of
  // a kind shut, the nearest open one can be far across town; the builder then offers its fixed home fallback.
  function _open_place(sim, agent, kinds, stay, meet = null, origin = null) {
    const place = sim.nearest(agent, kinds, origin, meet, stay);
    if (place === null || place === undefined) return null;
    const [trip, mode] = _trip(sim, agent, place.id);
    if (trip > MAX_OUTING_MINUTES) return null;
    const start = sim._shift_start_tick(agent);
    if (start !== null) {
      const on = G.travel.leg_minutes(sim, place.id, agent.job.place_id, mode === "car" ? "car" : "bus");
      if (sim.clock.tick + trip + stay + on + G.sim.SHIFT_MARGIN > start) return null;
    }
    return place;
  }

  // The park nearest the character (parks are always open, so it is always near).
  const _park = (sim, agent) => sim.nearest(agent, ["park"]) || sim.town.places.get("park");

  function _best_friend(sim, agent, exclude_household = true, adults_only = false) {
    const hh = sim.household(agent).member_ids;
    const pool = [];
    for (const [oid, r] of agent.relationships) {
      if (!(exclude_household && hh.includes(oid)) && r.affinity > 10
        && sim.agents.get(oid).alive && (!adults_only || sim.agents.get(oid).is_adult)) pool.push([r.affinity, oid]);
    }
    if (!pool.length) return null;
    return sim.agents.get(maxBy(pool)[1]);
  }

  // A child's best friend among the other children outside the household (affinity over 10), or null.
  function _playmate(sim, agent) {
    const hh = sim.household(agent).member_ids;
    const pool = [];
    for (const [oid, r] of agent.relationships) {
      if (!hh.includes(oid) && r.affinity > 10 && sim.agents.get(oid).alive && !sim.agents.get(oid).is_adult) {
        pool.push([r.affinity, oid]);
      }
    }
    if (!pool.length) return null;
    return sim.agents.get(maxBy(pool)[1]);
  }

  // A child's free outing in place of a paid one they can't pay for: playing in the park nearest them, with
  // their best friend among the other children (an invite) or with whoever is there.
  function _play(sim, agent) {
    const park = _park(sim, agent);
    const friend = _playmate(sim, agent);
    const knee = new Outcome("scraped_knee", "Scrapes a knee", 0.08, -1, { health: -2, fun: -4 });
    if (friend) {
      const rel = relKey(friend.id);
      return new Option(`Ask ${firstName(friend.name)} to play in ${park.name}`, [["play", park.id]],
        { tags: { social: 0.8, adventure: 0.4, health: 0.3 }, gains: { fun: 30, social: 25 },
          outcomes: [new Outcome("great_game", "A great game together", 0.6, +1, { [rel]: 5, fun: 6 }), knee],
          extra: { invite_to: friend.id, place: park.id } });
    }
    return new Option(`Find some kids to play with in ${park.name}`, [["play", park.id]],
      { tags: { social: 0.7, adventure: 0.5, health: 0.3 }, gains: { fun: 30, social: 20 },
        outcomes: [_meet_new(0.3), knee] });
  }

  // True for a child who can't pay `cost` themselves (an adult would have to).
  const _short_of = (agent, cost) => !agent.is_adult && agent.money + agent.savings < cost;

  function _closest_family(sim, agent) {
    const pool = [];
    for (const [oid, r] of agent.relationships) {
      if ((r.kind === "family" || r.kind === "partner") && sim.agents.get(oid).alive) pool.push([r.affinity, oid]);
    }
    return pool.length ? sim.agents.get(maxBy(pool)[1]) : null;
  }

  // --- the fork builders, in priority order -------------------------------------

  function invite_fork(sim, agent) {
    const invite = sim.pending_invite_for(agent);
    if (!invite) return null;
    const hour = sim.clock.hour;
    if (hour >= 22 || hour < 6 || _curfew(sim, agent)) return null; // sleep on it; the invite waits or expires
    if (sim._must_leave_for_work(agent, invite.place)) return null; // off to work first; the invite waits or expires
    if (!_open_on_arrival(sim, agent, invite.place)) return null; // the place is shut by then; the invite waits or expires
    const host = sim.agents.get(invite.from);
    const place = sim.town.places.get(invite.place);
    const rel = relKey(host.id);
    const first = firstName(host.name);
    const meet = place.kind === "park" ? (agent.is_adult ? "walk_park" : "play") : "hang_out"; // a walk or a game
    const opts = [
      new Option(`Accept and meet ${first} at ${place.name}`, [[meet, place.id]],
        { tags: { social: 1.0, adventure: 0.3 }, gains: { social: 40, fun: 20 },
          outcomes: [new Outcome("great_time", "Has a great time together", 0.6, +1, { [rel]: 6, fun: 8 }, "hang_out"),
            new Outcome("awkward", "Conversation feels awkward", 0.12, -1, { [rel]: -3 }, "hang_out"),
            _meet_new(0.06)],
          extra: { invite: invite.id, answer: "accept" } }),
      new Option("Decline politely", [["relax_home", "home"]], { tags: { social: -0.5, thrift: 0.2 }, base: 0.1,
        gains: { fun: 10 }, outcomes: [new Outcome("brushed_off", `${first} feels brushed off`, 0.35, -1, { [rel]: -3 })],
        extra: { invite: invite.id, answer: "decline" } }),
      new Option("Suggest another day instead", [["relax_home", "home"]], { tags: { diligence: 0.2, social: 0.2 },
        gains: { fun: 10 }, outcomes: [new Outcome("understood", `${first} is happy to wait`, 0.7, +1, { [rel]: 1 })],
        extra: { invite: invite.id, answer: "later" } }),
      new Option("Ignore the message", [["relax_home", "home"]], { tags: { social: -1.0 }, base: -0.4,
        gains: { fun: 10 }, outcomes: [new Outcome("hurt", `${first} is hurt`, 0.7, -1, { [rel]: -6 })],
        extra: { invite: invite.id, answer: "ignore" } }),
    ];
    return new Fork(agent.id, "invite", `${host.name} invites you to ${place.name}. What do you do?`, opts, sim.clock.tick);
  }

  // The work fork's third option when no cup of coffee fits before the shift: a bite to eat where they are, then
  // the usual way (its mode and fare; `late` is its own "Arrives late" odds).
  function _bite_first(usual, late) {
    return new Option("Grab a bite to eat, then go", [["snack", null], ...usual.steps.map((step) => [...step])], {
      cost: usual.cost, vehicle: usual.vehicle, charge: usual.charge, base: 0.3,
      tags: { health: 0.2, thrift: 0.2, diligence: -0.1 }, gains: { hunger: 25 },
      outcomes: [_late(late), new Outcome("crumbs", "Gets crumbs all down their front", 0.1, -1, { fun: -3 })] });
  }

  // Minutes before the shift that the work fork opens, from where the character is: WORK_LEAD, or the walk and 15
  // more when that is longer (walking is the slowest way: always in time to walk, or to have a cup at home first).
  function work_lead(sim, agent) {
    return Math.max(WORK_LEAD, sim.walk_minutes(agent, agent.job.place_id) + 15);
  }

  function work_fork(sim, agent) {
    const job = agent.job;
    if (!job || agent.worked_today === sim.clock.day) return null;
    const minutes_to_start = job.start_hour * 60 - sim.clock.minute_of_day;
    if (!job.workdays.includes(sim.clock.weekday) || !(-WORK_LATE <= minutes_to_start && minutes_to_start <= 180)) return null;
    const walk_minutes = sim.walk_minutes(agent, job.place_id);
    if (minutes_to_start > work_lead(sim, agent)) return null;
    const place = sim.town.places.get(job.place_id);
    const school = job.hourly_wage === 0;
    const where = school ? "school" : "work";
    const rain = sim.weather === "rain" ? RAIN_CHANCE[sim.clock.season] : 0.0;
    // 1. The usual way: on foot, or the bus when the walk is long and a bus leaving now saves time.
    const bus = walk_minutes > G.travel.BUS_MIN_WALK ? G.travel.bus_trip(sim, agent, job.place_id) : null;
    let usual, usual_trip, usual_late;
    if (bus) {
      usual_late = 0.06;
      usual = new Option(`Take the No. ${bus[1]} bus to ${where}`, [["work", "job"]], { cost: G.transit.fare(agent.age),
        vehicle: "bus", base: 0.6, charge: false, // the fare is paid on boarding
        tags: { diligence: 0.5, thrift: 0.3, social: 0.2 },
        outcomes: [_late(usual_late), new Outcome("bus_chat", "Chats with a neighbour on the bus", 0.12, +1,
          { social: 8 }),
        new Outcome("packed", "The bus is packed and stuffy", 0.15, -1, { fun: -5 })] });
      usual_trip = bus[0];
    } else {
      usual_late = 0.12;
      usual = new Option(`Walk to ${where}`, [["work", "job"]], { vehicle: "walk", base: 0.6,
        tags: { diligence: 0.5, health: 0.4, thrift: 0.3 },
        outcomes: [_late(usual_late), new Outcome("neighbour", "Chats with a neighbour on the way", 0.10, +1, { social: 8 }),
          new Outcome("soaked", "Gets soaked in the rain", rain * 0.8, -1, { fun: -8 })] });
      usual_trip = walk_minutes;
    }
    // 2. The fast way: the car, else running (always for a child), else a taxi for a walk too long to run.
    let fast;
    if (agent.owns_car) {
      fast = new Option(`Drive to ${where}`, [["work", "job"]], { cost: 2, vehicle: "car", base: 0.6,
        tags: { diligence: 0.7, thrift: -0.3 },
        outcomes: [_late(0.04), new Outcome("fender", "Minor fender bender", 0.02, -1, { money: -150, fun: -10 }),
          new Outcome("ticket", "Parking ticket", 0.05, -1, { money: -40 })] });
    } else if (!agent.is_adult || walk_minutes <= G.travel.TAXI_MIN_WALK) {
      fast = new Option(`Run to ${where}`, [["work", "job"]], { vehicle: "run", base: 0.5,
        tags: { diligence: 0.7, health: 0.5, adventure: 0.2 },
        outcomes: [_late(0.03), new Outcome("ankle", "Twists an ankle", 0.03, -1, { health: -8, fun: -6 }),
          new Outcome("buzz", "Arrives buzzing with energy", 0.3, +1, { energy: 6, fun: 4 }, "arrival")] });
    } else { // PLAN decision 63: dear, so it is rarely the default
      fast = new Option(`Take a taxi to ${where} ($${G.travel.TAXI_FARE})`, [["work", "job"]], { cost: G.travel.TAXI_FARE,
        vehicle: "taxi", base: 0.3, tags: { thrift: -0.6, diligence: 0.5, adventure: 0.1 },
        outcomes: [_late(0.03), new Outcome("chatty_driver", "A chatty taxi driver", 0.3, +1, { social: 6 }),
          new Outcome("traffic", "Sits in traffic, watching the meter", 0.1, -1, { fun: -5 })] });
    }
    const fast_trip = sim.travel_minutes(agent, job.place_id, fast.vehicle);
    if (fast.vehicle === "taxi" && usual_trip <= minutes_to_start) { // decision 63 again: no need to pay for speed
      fast.base = pyRound(fast.base - TAXI_NO_HURRY, 3);
    }
    // 3. Coffee first (PLAN decision 55, city.md 7.7), only while the cup fits before the shift: at the cafe open for
    // the cup that adds least to the way to work, when it is on the way (at most COFFEE_DETOUR minutes out of it) or a
    // cup there is still quicker than one at home; at their own cafe a cafe worker has a coffee at work (the
    // simulation ends it as the shift starts, so it holds nothing up). Otherwise (an early shift, with the only open
    // cafes across town) a cup at home first, and with no time for either a bite to eat on the way out (_bite_first).
    const coffee_tags = { social: 0.4, diligence: -0.5, thrift: -0.3 };
    const spill = new Outcome("spill", "Spills coffee on their shirt", 0.05, -1, { fun: -5 });
    const home = sim.home_of(agent);
    const home_trip = (sim.walk_minutes(agent, home) + COFFEE_MINUTES
      + sim.town.walk_minutes(sim.town.places.get(home).entry, job.place_id));
    const cafe = sim.nearest(agent, ["cafe"], null, place, COFFEE_MINUTES);
    const at_work = Boolean(cafe) && cafe.id === job.place_id;
    const way = cafe ? (sim.walk_minutes(agent, cafe.id) + (at_work ? 0
      : sim.town.walk_minutes(cafe.entry, job.place_id))) : null;
    let coffee, coffee_trip;
    if (school && !agent.is_adult) { // no cafe stop for a pupil (FIXLISTS 11): breakfast at home, else a bite
      if (home_trip <= minutes_to_start) {
        coffee = new Option("Have breakfast at home, then go", [["coffee", "home"], ["work", "job"]], { vehicle: "walk",
          base: 0.35, tags: { health: 0.3, family: 0.3, diligence: -0.3 },
          gains: { energy: 5, hunger: 20 },
          outcomes: [_late(0.0), new Outcome("spill", "Spills milk all over the table", 0.05, -1,
            { fun: -3 })] });
        coffee_trip = home_trip;
      } else {
        coffee = _bite_first(usual, usual_late);
        coffee_trip = usual_trip + SNACK_MINUTES;
      }
    } else if (cafe && (way <= walk_minutes + COFFEE_DETOUR || way + COFFEE_MINUTES <= home_trip)
      && (at_work ? way : way + COFFEE_MINUTES) <= minutes_to_start) {
      coffee = new Option(at_work ? "Have a coffee at work" : `Grab a coffee at ${cafe.name} first`,
        [["coffee", cafe.id], ["work", "job"]], { cost: 4,
          vehicle: "walk", base: 0.35, tags: coffee_tags, gains: { energy: 10, social: 5 },
          outcomes: [_late(COFFEE_LATE), _meet_new(0.12),
            new Outcome("barista", "Friendly chat at the counter", 0.3, +1, { social: 6 }), spill] });
      coffee_trip = at_work ? way : way + COFFEE_MINUTES;
    } else if (home_trip <= minutes_to_start) {
      coffee = new Option("Make a coffee at home, then go", [["coffee", "home"], ["work", "job"]], { vehicle: "walk",
        base: 0.35, tags: coffee_tags, gains: { energy: 10 }, outcomes: [_late(0.0), spill] });
      coffee_trip = home_trip;
    } else {
      coffee = _bite_first(usual, usual_late);
      coffee_trip = usual_trip + SNACK_MINUTES;
    }
    // 4. Skip it.
    const skip = new Option(!school ? "Call in sick and stay home" : "Pretend to be sick and stay home",
      [["rest", "home"]], { tags: { diligence: -1.0, health: 0.3, adventure: 0.2 }, base: -0.4,
        gains: { energy: 30, fun: 25 },
        outcomes: [new Outcome("annoyed", !school ? "The boss is annoyed" : "The teacher calls home", 0.5, -1, { reputation: -6 }, "skip"),
          new Outcome("lazy_day", "A lovely lazy day", 0.5, +1, { fun: 12 }, "skip")],
        extra: { skip_work: true } });
    const options = [_on_time(usual, usual_trip, minutes_to_start), _on_time(fast, fast_trip, minutes_to_start),
      _on_time(coffee, coffee_trip, minutes_to_start), skip];
    return new Fork(agent.id, "work", `It's ${sim.clock.stamp().slice(-5)} and ${where} starts at ${pad2(job.start_hour)}:00 at ${place.name}. How do you go?`,
      options, sim.clock.tick);
  }

  // Late in the evening, after midnight for someone tired, or whenever exhausted; never within WOKE_GAP minutes
  // of waking up (agent.woke_tick, kept by the simulation) nor SHIFT_SOON minutes of a shift (or once it began).
  function sleep_fork(sim, agent) {
    const hour = sim.clock.hour, energy = agent.needs.energy;
    const weekend = sim.clock.weekday === 4 || sim.clock.weekday === 5; // Friday and Saturday evenings run later
    const bed = weekend ? WEEKEND_BED + personal(agent, 60) : BEDTIME;
    if (!(sim.clock.minute_of_day >= bed || (hour < 5 && energy < 70) || energy < 18)) return null;
    const tick = sim.clock.tick;
    const woke = agent.woke_tick ?? null;
    if (woke !== null && tick - woke < WOKE_GAP) return null;
    const start = sim._shift_start_tick(agent);
    if (start !== null && start - tick <= SHIFT_SOON) return null;
    const friend = _best_friend(sim, agent);
    const rel = friend ? relKey(friend.id) : null;
    const text_outcomes = [new Outcome("warm_reply", "Gets a warm reply", 0.6, +1, Object.assign({ social: 8 }, rel ? { [rel]: 2 } : {}), "text"),
      new Outcome("no_reply", "No reply comes", 0.3, -1, { social: -4 }, "text")];
    const opts = [
      new Option("Go to sleep now", [["sleep", "home"]], { tags: { health: 0.8, diligence: 0.3 }, gains: { energy: 70 }, base: 0.2,
        outcomes: [new Outcome("deep_sleep", "Sleeps deeply", 0.6, +1, { energy: 10 }, "sleep"),
          new Outcome("insomnia", "Lies awake for hours", 0.1, -1, { energy: -15 }, "sleep")] }),
      new Option("Stay up watching a show", [["stay_up", "home"], ["sleep", "home"]],
        { tags: { health: -0.6, adventure: 0.3, diligence: -0.3 }, gains: { fun: 35 },
          outcomes: [new Outcome("hooked", "Loves the show", 0.45, +1, { fun: 10 }),
            new Outcome("groggy", "Wakes up groggy", 0.7, -1, { energy: -10, delay: 480 })] }),
      new Option(friend ? `Text ${firstName(friend.name)}, then sleep` : "Scroll the phone, then sleep",
        [["text", "home"], ["sleep", "home"]], { tags: { social: 0.8, health: -0.2 }, gains: { social: 15 },
          outcomes: friend ? text_outcomes : [new Outcome("doomscroll", "Feels worse after scrolling", 0.5, -1, { fun: -5 })] }),
      new Option("Read a book, then sleep", [["read", "home"], ["sleep", "home"]],
        { tags: { health: 0.3, adventure: -0.2, social: -0.3 }, gains: { fun: 15, energy: 50 },
          outcomes: [new Outcome("great_chapter", "Reads a gripping chapter", 0.5, +1, { fun: 6 })] }),
    ];
    const late = hour >= 21 || hour < 5; // worn out in the daytime is another question (FIXLISTS 16)
    return new Fork(agent.id, "sleep", late ? "It's late and you're tired. What now?"
      : "You're worn out and can barely keep your eyes open. What now?", opts, sim.clock.tick);
  }

  function hunger_fork(sim, agent) {
    if (agent.needs.hunger >= 35) return null;
    const hh = sim.household(agent);
    let cook, market;
    if (hh.groceries > 0) {
      cook = new Option("Cook at home", [["eat_home", "home"]], { tags: { thrift: 0.6, family: 0.5, health: 0.4 },
        gains: { hunger: 60 },
        outcomes: [new Outcome("tasty", "Makes a really tasty meal", 0.5, +1, { fun: 6 }, "cook"),
          new Outcome("burnt", "Burns the food", 0.08, -1, { fun: -6 }, "cook")] });
    } else if (agent.is_adult && agent.money >= 35 && (market = _open_place(sim, agent, ["market"], GROCERY_MINUTES))) {
      cook = new Option(`Buy groceries at ${market.name}, then cook`, [["buy_groceries", market.id], ["eat_home", "home"]],
        { cost: 35, tags: { thrift: 0.4, family: 0.6, diligence: 0.3 }, gains: { hunger: 60 },
          outcomes: [_meet_new(0.05), new Outcome("tasty", "Makes a really tasty meal", 0.5, +1, { fun: 6 })] });
    } else {
      cook = new Option("Order food to the house", [["order_food", "home"]], { cost: 25,
        tags: { thrift: -0.4, family: 0.3 }, gains: { hunger: 50 },
        outcomes: [new Outcome("late_delivery", "The delivery is very late", 0.2, -1, { fun: -6 })] });
    }
    const cafe = (agent.money >= 14 && !_curfew(sim, agent, 0.7)
      ? _open_place(sim, agent, ["cafe"], EAT_OUT_MINUTES) : null);
    let out;
    if (cafe) {
      out = new Option(`Eat at ${cafe.name}`, [["eat_out", cafe.id]], { cost: 14,
        tags: { thrift: -0.5, social: 0.5, adventure: 0.3 }, gains: { hunger: 55, social: 10 },
        outcomes: [_meet_new(0.08), new Outcome("friend_there", "Bumps into a friend", 0.15, +1, { social: 8 }),
          new Outcome("food_poisoning", "Gets food poisoning", 0.02, -1, { health: -10, fun: -10 })] });
    } else {
      out = new Option("Raid the cupboard for leftovers", [["leftovers", "home"]],
        { tags: { thrift: 0.5, health: -0.2 }, gains: { hunger: 30 },
          outcomes: [new Outcome("stale", "Everything is stale", 0.3, -1, { fun: -4 })] });
    }
    const snack = new Option("Grab a quick snack", [["snack", null]], { cost: agent.money >= 3 ? 3 : 0,
      tags: { thrift: 0.2, health: -0.4, diligence: 0.3 }, gains: { hunger: 25 },
      outcomes: [new Outcome("sugar_crash", "Sugar crash later", 0.3, -1, { energy: -8, delay: 60 })] });
    const skip = new Option("Skip the meal and push on", [["wait", null]], { tags: { diligence: 0.4, health: -0.7, thrift: 0.4 }, base: -0.2,
      outcomes: [new Outcome("headache", "Gets a headache", 0.4, -1, { fun: -10 })] });
    return new Fork(agent.id, "hunger", "You're getting hungry. What do you do?", [cook, out, snack, skip], sim.clock.tick);
  }

  function payday_fork(sim, agent) {
    const week = Math.floor(sim.clock.day / 7);
    const hour = sim.clock.hour, weekday = sim.clock.weekday;
    // Friday evening, or Saturday for anyone who works Friday evenings; retirees get their pension that day.
    const evening = (weekday === 4 && hour >= 17) || (weekday === 5 && hour >= 9);
    if (!agent.is_adult || !(agent.job || agent.age >= 65) || agent.last_payday === week || !evening
      || hour >= 20 || agent.money < 80 || sim.on_shift_now(agent)) return null;
    agent.last_payday = week;
    const friend = _best_friend(sim, agent, true, true);
    const amount = Math.min(100, pyRound(agent.money * 0.25 / 10) * 10);
    const goal_name = agent.goal ? agent.goal.name : "savings";
    const left = agent.goal ? pyRound(agent.goal.target - agent.goal.saved, 2) : 0;
    let save;
    if (agent.goal && 0 < left && left <= agent.money) { // the cash on hand covers the rest: buy it now (FIXLISTS 13)
      save = new Option(`Buy ${goal_name} now`, [["relax_home", "home"]], { cost: left,
        tags: { thrift: 0.4, adventure: 0.4, diligence: 0.2 }, gains: { fun: 40 }, base: 0.3,
        outcomes: [new Outcome("love_it", "Loves the purchase", 0.7, +1, { fun: 15 }, "purchase"),
          new Outcome("regret", "Regrets the spending", 0.15, -1, { fun: -8 }, "purchase")],
        extra: { buy_goal: true } });
    } else {
      save = new Option(`Put $${fmt(amount)} toward ${goal_name}`, [["relax_home", "home"]],
        { tags: { thrift: 1.0, diligence: 0.4, adventure: -0.3 }, gains: { fun: 10 },
          outcomes: [new Outcome("proud", "Feels proud of the progress", 0.6, +1, { fun: 5 })],
          extra: { save: amount } });
    }
    // The cafe nearest both (with a friend) or nearest the character, open for the whole evening out.
    const cafe = _open_place(sim, agent, ["cafe"], HANG_OUT_MINUTES, friend);
    let out;
    if (friend && cafe) {
      const rel = relKey(friend.id);
      out = new Option(`Go out for drinks with ${firstName(friend.name)} at ${cafe.name}`, [["hang_out", cafe.id]], { cost: 40,
        tags: { social: 1.0, thrift: -0.6, adventure: 0.4 }, gains: { social: 40, fun: 30 },
        outcomes: [_meet_new(0.18), new Outcome("friendship", `Friendship with ${firstName(friend.name)} grows`, 0.55, +1, { [rel]: 6 }),
          new Outcome("hangover", "Wakes up with a hangover", 0.2, -1, { energy: -12, delay: 720 })],
        extra: { invite_to: friend.id, place: cafe.id } });
    } else if (cafe) {
      out = new Option(`Go out alone to ${cafe.name}`, [["hang_out", cafe.id]], { cost: 25,
        tags: { social: 0.6, thrift: -0.5 }, gains: { social: 25, fun: 20 }, outcomes: [_meet_new(0.2)] });
    } else { // every cafe would shut before the evening is over: a drink at home
      out = new Option("Open a nice bottle at home", [["relax_home", "home"]], { cost: 15,
        tags: { social: 0.2, thrift: -0.3, adventure: -0.2 }, gains: { fun: 25 },
        outcomes: [new Outcome("cosy_drink", "A relaxed evening in", 0.6, +1, { fun: 6 }),
          new Outcome("hangover", "Wakes up with a hangover", 0.15, -1, { energy: -12, delay: 720 })] });
    }
    const bought = [new Outcome("love_it", "Loves the purchase", 0.6, +1, { fun: 15 }, "purchase"),
      new Outcome("regret", "Regrets the spending", 0.3, -1, { fun: -8 }, "purchase")];
    const shop = _open_place(sim, agent, ["shop", "market"], SHOP_MINUTES); // open until the shopping is done
    let buy;
    if (shop) {
      buy = new Option(`Buy something nice at ${shop.name}`, [["shopping", shop.id], ["relax_home", "home"]], { cost: 60,
        tags: { thrift: -1.0, adventure: 0.5 }, gains: { fun: 35 }, outcomes: bought });
    } else { // every shop would shut before the shopping is done: order it from home instead
      buy = new Option("Order something nice online", [["relax_home", "home"]], { cost: 60,
        tags: { thrift: -1.0, adventure: 0.3 }, gains: { fun: 30 }, outcomes: bought });
    }
    const family = sim.household(agent).member_ids.some(m => m !== agent.id);
    const party = family ? _dinner_party(sim, agent) : null; // Saturday evening, with whoever is free (FIXLISTS 6)
    // The family goes to the cafe nearest home (extra["place"], so everyone heads to the same one).
    const dinner = party ? _open_place(sim, agent, ["cafe"], DINNER_MINUTES, null, sim.home_of(agent)) : null;
    let treat;
    if (dinner) {
      treat = _dinner_out(`Treat ${names(party)} to dinner at ${dinner.name}`, dinner);
    } else if (family) { // every cafe would shut before dinner is over: a takeaway for everyone
      treat = new Option("Order a takeaway feast for the family", [["order_food", "home"], ["relax_home", "home"]],
        { cost: 40, tags: { family: 0.8, thrift: -0.3 }, gains: { hunger: 40, fun: 20 },
          outcomes: [new Outcome("feast", "Everyone loves the feast", 0.6, +1, { fun: 6 }, "dinner"),
            new Outcome("late_delivery", "The delivery is very late", 0.2, -1, { fun: -6 }, "dinner")] });
    } else { // nobody at home to treat
      treat = new Option("Treat yourself to a takeaway night in", [["order_food", "home"], ["relax_home", "home"]], { cost: 25,
        tags: { thrift: -0.4, social: -0.4, adventure: -0.2 }, gains: { hunger: 40, fun: 25 },
        outcomes: [new Outcome("cosy_night", "A cosy night in", 0.6, +1, { fun: 6 }, "dinner"),
          new Outcome("late_delivery", "The delivery is very late", 0.2, -1, { fun: -6 }, "dinner")] });
    }
    return new Fork(agent.id, "payday", `It's payday and you have $${fmt(agent.money)}. What do you do with it?`,
      [save, out, buy, treat], sim.clock.tick);
  }

  // A family dinner out at `cafe` (the household members free to come join, _apply_extra's "family").
  function _dinner_out(label, cafe) {
    return new Option(label, [["family_dinner", cafe.id]], { cost: 50,
      tags: { family: 1.0, thrift: -0.4, social: 0.3 }, gains: { hunger: 40, social: 30 },
      outcomes: [new Outcome("bonding", "A warm family evening", 0.7, +1, { family_bond: 4, fun: 8 }, "dinner"),
        new Outcome("argument", "An argument at the table", 0.1, -1, { family_bond: -3 }, "dinner")],
      extra: { family: true, place: cafe.id } });
  }

  // Saturday evening with the family (FIXLISTS 6): once a week for a household's adults, when someone is free to come
  // and no small child would be left alone; the dinner names who comes.
  function family_fork(sim, agent) {
    const week = Math.floor(sim.clock.day / 7);
    if (!agent.is_adult || (agent.family_week ?? -1) === week || sim.on_shift_now(agent)) return null;
    const party = _dinner_party(sim, agent);
    if (!party || agent.inside !== sim.home_of(agent) || agent.money < 50) return null;
    const cafe = _open_place(sim, agent, ["cafe"], DINNER_MINUTES, null, sim.home_of(agent));
    if (cafe === null) return null;
    for (const m of sim.household(agent).member_ids) sim.agents.get(m).family_week = week; // one family evening a week, whoever brings it up
    const who = names(party);
    const hh = sim.household(agent);
    let home;
    if (hh.groceries >= party.length + 1) {
      home = new Option(`Cook a big dinner for ${who}`, [["eat_home", "home"], ["board_game", "home"]],
        { tags: { family: 0.9, thrift: 0.6, diligence: 0.3 }, gains: { hunger: 40, social: 20 },
          outcomes: [new Outcome("tasty", "Makes a really tasty meal", 0.5, +1, { fun: 6, family_bond: 2 }, "cook"),
            new Outcome("burnt", "Burns the food", 0.08, -1, { fun: -6 }, "cook")],
          extra: { together: party[0].id } });
    } else {
      home = new Option(`Order a takeaway for ${who}`, [["order_food", "home"], ["board_game", "home"]], { cost: 40,
        tags: { family: 0.8, thrift: -0.3 }, gains: { hunger: 40, social: 20 },
        outcomes: [new Outcome("feast", "Everyone loves the feast", 0.6, +1, { fun: 6 }, "dinner"),
          new Outcome("late_delivery", "The delivery is very late", 0.2, -1, { fun: -6 }, "dinner")],
        extra: { together: party[0].id } });
    }
    const opts = [
      _dinner_out(`Take ${who} out to dinner at ${cafe.name}`, cafe),
      home,
      new Option(`A games night at home with ${who}`, [["board_game", "home"]],
        { tags: { family: 0.7, thrift: 0.5, adventure: -0.2 }, gains: { fun: 25, social: 20 },
          outcomes: [new Outcome("bonding", "Laughs with the family", 0.5, +1, { family_bond: 2 })],
          extra: { together: party[0].id } }),
      new Option("Let everyone do their own thing tonight", [["relax_home", "home"]],
        { tags: { family: -0.6, thrift: 0.3, social: -0.3 }, gains: { fun: 15 },
          outcomes: [new Outcome("quiet_night", "A quiet night in", 0.5, +1, { fun: 4 })] }),
    ];
    return new Fork(agent.id, "family", "It's Saturday evening and everyone's home. What shall we do?", opts, sim.clock.tick);
  }

  function groceries_fork(sim, agent) {
    const hh = sim.household(agent);
    if (hh.groceries > 1 || !agent.is_adult || sim.on_shift_now(agent)) return null;
    const market = agent.money >= 35 ? _open_place(sim, agent, ["market"], GROCERY_MINUTES) : null;
    if (market === null) return null;
    const m = hh.member_ids.find(m => m !== agent.id && sim.agents.get(m).is_adult);
    const other = m === undefined ? null : sim.agents.get(m);
    const opts = [
      new Option(`Buy groceries at ${market.name} now`, [["buy_groceries", market.id], ["relax_home", "home"]], { cost: 35, base: 0.4,
        tags: { family: 0.6, diligence: 0.5, thrift: 0.3 }, gains: { hunger: 10 },
        outcomes: [_meet_new(0.05), new Outcome("sale", "Finds a great sale", 0.15, +1, { money: 10 })] }),
      new Option("Order food for tonight", [["order_food", "home"]], { cost: 25, tags: { thrift: -0.5, family: 0.2 },
        gains: { hunger: 20 }, outcomes: [new Outcome("late_delivery", "The delivery is very late", 0.2, -1, { fun: -6 })] }),
      other
        ? new Option(`Ask ${firstName(other.name)} to do the shopping`, [["relax_home", "home"]],
          { tags: { family: -0.3, thrift: 0.4 }, extra: { ask_shop: other.id },
            outcomes: [new Outcome("annoyed_partner", "They're annoyed at being asked", 0.4, -1, { [relKey(other.id)]: -3 })] })
        : new Option("Make do with what's in the cupboard", [["leftovers", "home"]], { tags: { thrift: 0.6, health: -0.2 },
          gains: { hunger: 30 }, outcomes: [new Outcome("stale", "Everything is stale", 0.3, -1, { fun: -4 })] }), // nobody to send: eat what there is
      new Option("Leave it for tomorrow", [["relax_home", "home"]], { tags: { diligence: -0.6, thrift: 0.3 }, base: -0.2,
        outcomes: [new Outcome("empty_fridge", "Opens an empty fridge later", 0.6, -1, { fun: -5 })] }),
    ];
    return new Fork(agent.id, "groceries", "The fridge is almost empty. What do you do?", opts, sim.clock.tick);
  }

  function lonely_fork(sim, agent) {
    const hour = sim.clock.hour;
    if (agent.needs.social >= 35 || !(9 <= hour && hour < 21) || sim.on_shift_now(agent) || _curfew(sim, agent, 1)
      || in_work_window(sim, agent)) return null;
    const friend = _best_friend(sim, agent);
    const family = _family_away(sim, agent); // never a phone call to someone in the same home (FIXLISTS 5)
    const opts = [];
    // The cafe nearest both (with a friend to invite) or nearest the character, open for the whole hang-out.
    const short = _short_of(agent, 6) || !agent.is_adult; // children play with friends (FIXLISTS 5)
    const cafe = !short ? _open_place(sim, agent, ["cafe"], HANG_OUT_MINUTES, friend) : null;
    if (short) { // a child: off to play instead
      opts.push(_play(sim, agent));
    } else if (friend && cafe) {
      opts.push(new Option(`Invite ${firstName(friend.name)} to ${cafe.name}`, [["hang_out", cafe.id]], { cost: 6,
        tags: { social: 1.0, adventure: 0.3 }, gains: { social: 45, fun: 20 },
        outcomes: [_meet_new(0.05)], extra: { invite_to: friend.id, place: cafe.id } }));
    } else if (cafe) {
      opts.push(new Option(`Go people-watching at ${cafe.name}`, [["hang_out", cafe.id]], { cost: 6,
        tags: { social: 0.6 }, gains: { social: 25 }, outcomes: [_meet_new(0.15)] }));
    } else { // every cafe would shut before a hang-out there is over
      opts.push(new Option("Message a few people from home", [["text", "home"]], { tags: { social: 0.6, thrift: 0.2 },
        gains: { social: 15 },
        outcomes: [new Outcome("warm_replies", "Gets some warm replies", 0.6, +1, { social: 6 }, "call"),
          new Outcome("no_reply", "No reply comes", 0.3, -1, { social: -4 }, "call")] }));
    }
    const who = family || friend;
    if (who) {
      opts.push(new Option(`Call ${firstName(who.name)}`, [["phone_call", null]], { tags: { family: 0.8, social: 0.4 },
        gains: { social: 30 },
        outcomes: [new Outcome("lovely_talk", "A lovely long talk", 0.7, +1, { [relKey(who.id)]: 3 }, "call"),
          new Outcome("argue", "The call turns into an argument", 0.08, -1, { [relKey(who.id)]: -5, fun: -6 }, "call")],
        extra: { call: who.id } }));
    } else {
      opts.push(new Option("Write in a diary", [["read", "home"]], { tags: { social: -0.2 }, gains: { fun: 10 },
        outcomes: [new Outcome("clarity", "Writing brings some clarity", 0.5, +1, { fun: 5 })],
        extra: { cooldown: LONELY_IDLE_COOLDOWN } }));
    }
    const park = _park(sim, agent);
    const rained = new Outcome("rained_out", "Caught in the rain",
      RAIN_CHANCE[sim.clock.season] * (sim.weather === "rain" ? 1 : 0), -1, { fun: -8 });
    const walker = _walk_friend(sim, agent, getd(opts[0].extra, "invite_to", null));
    if (walker && agent.is_adult) { // a named friend on the walk (FIXLISTS 5)
      opts.push(new Option(`Ask ${firstName(walker.name)} to walk in ${park.name}`, [["walk_park", park.id]],
        { tags: { health: 0.6, adventure: 0.3, social: 0.6 }, gains: { fun: 30, social: 30 },
          outcomes: [new Outcome("good_walk", `A good walk and talk with ${firstName(walker.name)}`, 0.6, +1,
            { [relKey(walker.id)]: 4 }), rained],
          extra: { invite_to: walker.id, place: park.id } }));
    } else {
      opts.push(new Option(`Walk in ${park.name}`, [["walk_park", park.id]], { tags: { health: 0.6, adventure: 0.4 },
        gains: { fun: 30, social: 5 }, outcomes: [_meet_new(0.12), rained] }));
    }
    const mate = agent.inside === sim.home_of(agent) ? _housemate_home(sim, agent) : null;
    if (mate) { // someone at home: time together, not a phone call across the hall (FIXLISTS 5)
      const rel = relKey(mate.id);
      const when = hour >= 17 ? "the evening" : "some time";
      opts.push(new Option(`Spend ${when} with ${firstName(mate.name)}`, [["board_game", "home"]],
        { tags: { family: 0.8, social: 0.6, thrift: 0.3 }, gains: { social: 30, fun: 20 },
          outcomes: [new Outcome("together", `A lovely time with ${firstName(mate.name)}`, 0.65, +1,
            { [rel]: 3, social: 10 }, "together"),
          new Outcome("bicker", `Bickers with ${firstName(mate.name)}`, 0.1, -1, { [rel]: -3, fun: -4 }, "together")],
          extra: { together: mate.id } }));
    } else {
      opts.push(new Option("Stay home alone", [["relax_home", "home"]], { tags: { social: -1.0, thrift: 0.3 },
        gains: { fun: 20 },
        outcomes: [new Outcome("peaceful", "A peaceful evening", 0.5, +1, { fun: 5 }, "stay_home"),
          new Outcome("lonely", "Feels lonely", 0.4, -1, { social: -5 }, "stay_home")],
        extra: { cooldown: LONELY_IDLE_COOLDOWN } }));
    }
    return new Fork(agent.id, "lonely", "You haven't talked to anyone in a while. What do you do?", opts, sim.clock.tick);
  }

  // When bored (fun under 40) or, for a child, cooped up at home (cooped_up), from 08:00 to 21:00 off shift.
  function free_time_fork(sim, agent) {
    const hour = sim.clock.hour;
    if (!(8 <= hour && hour < 21) || sim.on_shift_now(agent) || _curfew(sim, agent, 1) || in_work_window(sim, agent)) return null;
    const family = family_fork(sim, agent); // Saturday evening: the family first (FIXLISTS 6)
    if (family) return family;
    const idle = agent.is_adult && (agent.idle_home ?? 0) >= IDLE_HOME + personal(agent, IDLE_SPREAD);
    if (agent.needs.fun >= 40 && !idle && (agent.is_adult || cooped_up(sim, agent) <= 0)) return null;
    const park = _park(sim, agent);
    const short = _short_of(agent, 6);
    const cafe = !short ? _open_place(sim, agent, ["cafe"], HANG_OUT_MINUTES) : null; // open for all of it
    let out;
    if (short) { // a child without the $6: off to play instead
      out = _play(sim, agent);
    } else if (cafe) {
      out = new Option(`Hang out at ${cafe.name}`, [["hang_out", cafe.id]], { cost: 6, tags: { social: 0.8, thrift: -0.3 },
        gains: { fun: 25, social: 30 }, outcomes: [_meet_new(0.12)] });
    } else { // every cafe would shut before the hang-out is over
      out = new Option("Play a board game at home", [["board_game", "home"]], { tags: { family: 0.8 }, gains: { fun: 25, social: 10 },
        outcomes: [new Outcome("bonding", "Laughs with the family", 0.5, +1, { family_bond: 2 })] });
    }
    const opts = [
      new Option(`Walk in ${park.name}`, [["walk_park", park.id]], { tags: { health: 0.7, adventure: 0.3 },
        gains: { fun: 35 }, outcomes: [_meet_new(0.1)] }),
      new Option("Relax at home", [["relax_home", "home"]], { tags: { thrift: 0.4, family: 0.4, adventure: -0.4 },
        gains: { fun: 30, energy: 5 },
        outcomes: [new Outcome("unwind", "Properly unwinds", 0.5, +1, { fun: 6 }, "relax"),
          new Outcome("restless", "Gets restless and bored", 0.3, -1, { fun: -6 }, "relax")] }),
      out,
      new Option("Work on a side project", [["side_project", "home"]], { tags: { diligence: 0.6, adventure: 0.5, social: -0.3 },
        gains: { fun: 25 },
        outcomes: [new Outcome("breakthrough", "Makes a breakthrough", 0.15, +1,
          agent.is_adult ? { fun: 15, money: 50 } : { fun: 20 }, "project"),
        new Outcome("stuck", "Gets stuck and frustrated", 0.3, -1, { fun: -6 }, "project")] }),
    ];
    const shop = sim.clock.is_weekend && agent.is_adult && agent.money >= 40
      ? _open_place(sim, agent, ["shop"], SHOP_MINUTES) : null;
    if (shop) { // a weekend wander round the shops (FIXLISTS 18): in place of the side project
      opts[3] = new Option(`Buy something nice at ${shop.name}`, [["shopping", shop.id], ["relax_home", "home"]], { cost: 40, base: -0.2,
        tags: { thrift: -1.0, adventure: 0.5, social: 0.2 }, gains: { fun: 35 },
        outcomes: [new Outcome("love_it", "Loves the purchase", 0.6, +1, { fun: 15 }, "purchase"),
          new Outcome("regret", "Regrets the spending", 0.3, -1, { fun: -8 }, "purchase"), _meet_new(0.08)] });
    }
    return new Fork(agent.id, "free_time", "You have some free time and feel a bit bored. What do you do?", opts, sim.clock.tick);
  }

  // The fork builders in priority order, by name: "housing_forks." names live in housing_forks.js, so build_fork
  // looks them up when it runs rather than at load.
  const BUILDERS = ["invite_fork", "work_fork", "hunger_fork", "sleep_fork", "housing_forks.repair_fork", "payday_fork",
    "groceries_fork", "housing_forks.housing_trouble_fork", "housing_forks.house_hunt_fork",
    "housing_forks.upkeep_fork", "lonely_fork", "free_time_fork"];

  // Minutes before the same kind of fork can come up again for a character.
  const COOLDOWN = { groceries: 360, lonely: 150, free_time: 90, hunger: 45, sleep: 20 };

  // BUILDERS resolved to the builder functions, in order, at call time (so a patched builder is used too).
  function builders() {
    return BUILDERS.map(name => (name.startsWith("housing_forks.")
      ? G.housing_forks[name.slice("housing_forks.".length)] : G.forks[name]));
  }

  function build_fork(sim, agent) {
    const MAJOR_KINDS = G.housing_forks.MAJOR_KINDS;
    const fns = builders();
    for (let i = 0; i < BUILDERS.length; i++) {
      const name = BUILDERS[i];
      const kind = name.slice(name.lastIndexOf(".") + 1).replace(/_fork$/, "");
      if (getd(agent.cooldowns, kind, 0) > sim.clock.tick) continue;
      const fork = fns[i](sim, agent);
      if (fork) {
        if (fork.options.length !== 4) throw new PyError("AssertionError", `${fork.kind} fork must offer exactly four options`);
        fork.major = fork.major || MAJOR_KINDS.has(fork.kind);
        sim._fork_ids = (sim._fork_ids || 0) + 1;
        fork.id = `f${sim._fork_ids}`;
        return fork;
      }
    }
    return null;
  }

  G.forks = {
    RAIN_CHANCE, OBVIOUS_MARGIN, MAJOR_MARGIN, LUCK_STRENGTH, KID_CURFEW, WORK_LEAD, WORK_LATE, SHOP_MINUTES,
    HANG_OUT_MINUTES, COFFEE_MINUTES, COFFEE_DETOUR, COFFEE_LATE, SNACK_MINUTES, EAT_OUT_MINUTES, GROCERY_MINUTES, DINNER_MINUTES,
    LATE_BASE_DROP, LATE_ODDS, TAXI_NO_HURRY, WOKE_GAP, SHIFT_SOON, MAX_OUTING_MINUTES, TRAVEL_KINDS, TRAVEL_COST,
    NIGHT_TRAVEL, NIGHT_FROM, NIGHT_UNTIL, COOPED_KINDS, COOPED_UP, COOPED_HOURS, Outcome, Option, Fork, luck_odds,
    urgency, default_scores, _trip, extra_travel, cooped_up, _goes_out, _late, _meet_new, _on_time, retime_late, personal, names, today_line, in_work_window, _family_away, _walk_friend, _housemate_home,
    _dinner_party, _dinner_out, family_fork, IDLE_HOME, IDLE_SPREAD, OUTDOOR, RAIN_PENALTY, BEDTIME, WEEKEND_BED,
    DINNER_FROM, DINNER_UNTIL, LONELY_IDLE_COOLDOWN, _curfew,
    _open_on_arrival, _open_place, _park, _best_friend, _playmate, _play, _short_of, _closest_family, invite_fork,
    work_lead, work_fork, sleep_fork, hunger_fork,
    payday_fork, groceries_fork, lonely_fork, free_time_fork, BUILDERS, COOLDOWN, builders, build_fork,
  };
})(globalThis.GameOfAILife || (globalThis.GameOfAILife = {}));

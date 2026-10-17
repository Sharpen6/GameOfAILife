// Port of gameofailife/chronicle.py: every event's tag, kind and importance, and how decision outcomes are
// classified.
//
// Each event the simulation logs carries a `tag` from EVENT_TAGS. The tag gives the event's default `kind`
// and `importance` (0 routine, 1 notable, 2 major; `major` is importance 2). The News tab's topic chips
// come from TOPIC_OF_TAG. Outcome events are classified from their effects by `outcome_tag`, with the
// money amount appended to the text.
//
// Pure data and pure functions, except `on_affinity`, the friendship rule run after every relationship bump.
// Nothing here reads the rest of the engine (not even G.agent or G.clock), as in the Python module.
(function (G) {
  "use strict";
  const { hasOwn, commas, firstName, PyError } = G.py;

  const BIG_MONEY = 150; // an outcome that moves at least this much money is major news
  const MONEY_SWING = 40; // ... and at least this much is notable
  const INJURY = -8; // an outcome whose health effect is this or worse is an injury
  const FRIEND_AT = 30; // an acquaintance or coworker becomes a friend when affinity rises to this
  const RIFT_AT = 0; // a friend or partner falls out when affinity drops below this
  const RIFT_GAP_DAYS = 7; // at most one falling-out per pair in this many game days
  const TICKS_PER_DAY = 24 * 60; // a tick is a game minute (clock.MINUTES_PER_DAY; not read, see the header)

  // tag -> [kind, default importance]. Every event uses one of these tags; a call may override importance.
  const EVENT_TAGS = {
    // life and death
    death: ["death", 2],
    hospital: ["health", 2],
    discharged: ["health", 1],
    // outcomes of decisions, picked by outcome_tag()
    injury: ["outcome", 1],
    big_money: ["outcome", 2],
    money_swing: ["outcome", 1],
    outcome: ["outcome", 0],
    // money
    goal_reached: ["goal", 2],
    saving: ["money", 0],
    bills_paid: ["money", 0], // rent or property tax, and bills
    pension: ["money", 0],
    in_the_red: ["money", 1],
    in_the_red_again: ["money", 2],
    hardship: ["money", 1],
    help_given: ["money", 2],
    car_sold: ["money", 1],
    stuff_sold: ["money", 1],
    richest: ["money", 2], // God-only (remember=False)
    // people
    first_meet: ["social", 1],
    new_friend: ["social", 2],
    falling_out: ["social", 2],
    invite: ["social", 0],
    invite_accepted: ["social", 1],
    invite_declined: ["social", 0], // decline, another day, ignore
    meetup: ["social", 0],
    family_dinner: ["social", 1],
    errand: ["social", 0],
    call: ["social", 0],
    text: ["message", 0],
    // the world
    weather: ["weather", 0],
    closed: ["life", 0], // a place shut on arrival
    // homes
    home_bought: ["home", 2],
    home_rented: ["home", 2],
    evicted: ["home", 2],
    forced_sale: ["home", 2],
    nowhere_to_go: ["home", 2],
    home_listed: ["home", 2],
    neglect: ["home", 2],
    falling_apart: ["home", 2],
    shabby: ["home", 1],
    restored: ["home", 1],
    too_late: ["home", 1],
    emergency: ["home", 1],
    emergency_settled: ["home", 0],
    repaint: ["home", 0],
    damp_chill: ["health", 1],
    // AI players, God-only (remember=False)
    controller_joined: ["controller", 1],
    controller_left: ["controller", 1], // importance 0 for a single release
    // reserved for the areas that add jobs, romance, births and growing up; nothing emits them yet
    job_new: ["life", 2],
    job_lost: ["life", 2],
    promotion: ["life", 2],
    retired: ["life", 2],
    partner: ["social", 2],
    breakup: ["social", 2],
    wedding: ["social", 2],
    birth: ["life", 2],
    moved_out: ["home", 2],
    came_of_age: ["life", 1],
    // the fallback; a test keeps it unused
    other: ["life", 0],
  };

  // Lines only God may see: never written into a character's memory, whatever the call says.
  const GOD_ONLY_TAGS = new Set(["richest", "controller_joined", "controller_left"]);

  // Outcome events naming the character in full ("Dana Cohen: ..."); the rest use the first name ("Dana: ...").
  const FULL_NAME_TAGS = new Set(["big_money", "injury"]);

  // The News tab's topic chips, in display order: [id, label].
  const TOPICS = [["homes", "Homes"], ["money", "Money"], ["people", "People"], ["health", "Health"], ["ai", "AI"]];
  const TOPIC_OF_KIND = { home: "homes", money: "money", goal: "money", social: "people", message: "people",
    health: "health", death: "health", controller: "ai" };
  const _TOPIC_BY_TAG = { injury: "health", big_money: "money", money_swing: "money" }; // outcome tags with a topic
  // tag -> topic chip id, or null for tags no chip covers (weather, plain outcomes, life).
  const TOPIC_OF_TAG = {};
  for (const [tag, [kind]] of Object.entries(EVENT_TAGS)) {
    TOPIC_OF_TAG[tag] = hasOwn(_TOPIC_BY_TAG, tag) ? _TOPIC_BY_TAG[tag] : hasOwn(TOPIC_OF_KIND, kind) ? TOPIC_OF_KIND[kind] : null;
  }

  function _spec(tag) {
    if (!hasOwn(EVENT_TAGS, tag)) throw new PyError("KeyError", `unknown event tag '${tag}': add it to chronicle.EVENT_TAGS first`);
    return EVENT_TAGS[tag];
  }

  // The kind an event with this tag gets when the call names none.
  const kind_of = tag => _spec(tag)[0];

  // The default importance of a tag: 0 routine, 1 notable, 2 major.
  const importance_of = tag => _spec(tag)[1];

  const _number = value => (typeof value === "number" ? value : 0);

  // The money an outcome moves: its `money` effect plus its `hh_money` effect (0 when it has neither).
  const money_of = effects => _number(effects.money) + _number(effects.hh_money);

  // Classify an outcome by its effects: [tag, importance].
  //
  // big_money when it moves BIG_MONEY or more, else injury when its health effect is INJURY or worse,
  // else money_swing when it moves MONEY_SWING or more, else outcome.
  function outcome_tag(effects) {
    const money = Math.abs(money_of(effects));
    let tag;
    if (money >= BIG_MONEY) tag = "big_money";
    else if (_number(effects.health) <= INJURY) tag = "injury";
    else if (money >= MONEY_SWING) tag = "money_swing";
    else tag = "outcome";
    return [tag, EVENT_TAGS[tag][1]];
  }

  // ' (−$150)' or ' (+$1,400)' for an amount of money, '' when it rounds to $0.
  //
  // Rounds with floor(x + 0.5) on the size, as the Python twin does.
  function money_suffix(amount) {
    const dollars = Math.floor(Math.abs(_number(amount)) + 0.5);
    if (!dollars) return "";
    return ` (${amount < 0 ? "−" : "+"}$${commas(dollars)})`;
  }

  // The [text, tag, importance] of the event for an outcome that came true.
  //
  // "Dana Cohen: Minor fender bender (−$150)." for big_money and injury, "Ari: Sleeps deeply." otherwise.
  function outcome_event(name, label, effects) {
    const [tag, importance] = outcome_tag(effects);
    const who = FULL_NAME_TAGS.has(tag) ? name : firstName(name);
    return [`${who}: ${label}${money_suffix(money_of(effects))}.`, tag, importance];
  }

  // One event record in the PLAN section 3.7 shape, with the defaults filled in.
  //
  // `kind` and `importance` default to the tag's; `agents` always starts with `agent` when it is set (no
  // duplicates); `place` is a place id or null; `at` is the agent's tile or null. An unknown tag raises
  // KeyError even when the call gives both `kind` and `importance`.
  function make_event(seq, tick, time, text, tag = "other", kind = null, importance = null, agent = null,
    agents = null, place = null, at = null) {
    const [tag_kind, tag_importance] = _spec(tag);
    kind = kind || tag_kind;
    importance = importance === null || importance === undefined ? tag_importance : importance;
    const ids = agent ? [agent] : [];
    for (const other of agents || []) if (!ids.includes(other)) ids.push(other);
    return { seq, tick, time, kind, tag, importance, major: importance === 2, text, agent: agent ?? null,
      agents: ids, place: place ?? null, at: at !== null && at !== undefined ? [at[0], at[1]] : null };
  }

  const FRIENDS_FROM = ["acquaintance", "coworker"]; // the kinds of relationship that can grow into a friendship
  const RIFT_KINDS = ["friend", "partner"]; // ... and the ones that can end in a falling-out

  // The pair's key in sim._rifts: both ids in code-unit order, joined by "|" (ids never contain it).
  const rift_key = (a_id, b_id) => (a_id < b_id ? `${a_id}|${b_id}` : `${b_id}|${a_id}`);

  // Called at the end of every relationship bump with a's affinity to b before and after it.
  //
  // An acquaintance or coworker whose affinity rises to FRIEND_AT becomes a friend, on both sides (a side that
  // is family or a partner keeps its kind), with one `new_friend` event. A friend or partner whose affinity
  // drops below RIFT_AT falls out (`falling_out`; the kind stays), at most once per pair in RIFT_GAP_DAYS game
  // days: sim._rifts maps rift_key(a, b) to the tick of the pair's last falling-out (a Map, made on first use).
  // No fork reads a relationship's kind, so no decision changes. Unknown characters (or a city with nobody)
  // do nothing.
  function on_affinity(sim, a_id, b_id, before, after) {
    const agents = (sim && sim.agents) || new Map();
    const a = agents.get(a_id) ?? null, b = agents.get(b_id) ?? null;
    const rel = a !== null && b !== null ? a.relationships.get(b_id) ?? null : null;
    if (rel === null) return null;
    const kind = rel.kind; // RelationKind values are the strings themselves
    if (FRIENDS_FROM.includes(kind) && before < FRIEND_AT && FRIEND_AT <= after) {
      const friend = "friend"; // RelationKind.FRIEND, without reading G.agent
      rel.kind = friend;
      const back = b.relationships.get(a_id) ?? null;
      if (back !== null && FRIENDS_FROM.includes(back.kind)) back.kind = friend;
      const text = `${a.name} and ${b.name} have become friends.`;
      sim.event(text, a, null, { tag: "new_friend", agents: [b.id] });
      b.remember(sim.clock.stamp(), text);
    } else if (RIFT_KINDS.includes(kind) && before >= RIFT_AT && RIFT_AT > after) {
      let rifts = sim._rifts ?? null;
      if (rifts === null) rifts = sim._rifts = new Map();
      const key = rift_key(a_id, b_id);
      const last = rifts.get(key) ?? null;
      if (last !== null && sim.clock.tick - last < RIFT_GAP_DAYS * TICKS_PER_DAY) return null;
      rifts.set(key, sim.clock.tick);
      const text = `${a.name} and ${b.name} have fallen out.`;
      sim.event(text, a, null, { tag: "falling_out", agents: [b.id] });
      b.remember(sim.clock.stamp(), text);
    }
    return null;
  }

  G.chronicle = {
    BIG_MONEY, MONEY_SWING, INJURY, FRIEND_AT, RIFT_AT, RIFT_GAP_DAYS, TICKS_PER_DAY, EVENT_TAGS, GOD_ONLY_TAGS,
    FULL_NAME_TAGS, TOPICS, TOPIC_OF_KIND, TOPIC_OF_TAG, kind_of, importance_of, money_of, outcome_tag,
    money_suffix, outcome_event, make_event, FRIENDS_FROM, RIFT_KINDS, rift_key, on_affinity,
  };
})(globalThis.GameOfAILife || (globalThis.GameOfAILife = {}));

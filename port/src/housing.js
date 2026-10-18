// Port of gameofailife/housing.py: homes: the 37 dwellings of Millbrook, who owns and lives in them, their
// condition, and household money.
//
// Group A is the data, the read-side helpers and the serializers. Group B is the mechanics behind the hooks the
// simulation calls: the Sunday charges (rent or property tax, bills, arrears, hardship rent, tax deferral and
// forced moves), nightly decay with the landlord's repairs and the neglect stages, emergencies (rolled at night,
// hidden until they go live), moves, deaths, the housing extras and effects of fork options, home comfort and the
// money term of the Director's default scores. The four housing forks are built in housing_forks.js.
//
// Vocabulary: a Home is one dwelling (a house, or one flat of an apartment block); a Lot is the building a home
// stands on (one per residential place) and holds its condition. Owners are "landlord" (Millbrook Homes),
// "market" (vacant and for sale) or a household id. Everything is keyed by string ids and kept in plain
// fields, mirrored one to one from the Python module.
(function (G) {
  "use strict";
  const { getd, sum, fmt, fmtc, commas, firstName, lastName, title, minBy, count } = G.py;
  const r2 = G.rng.r2;

  // --- constants -----------------------------------------------------------------

  const TIERS = {
    flat: { label: "flat", rank: 1, decay: 1.0, comfort: 0.95 },
    house: { label: "house", rank: 2, decay: 1.5, comfort: 1.00, pro_rate: 6, diy_pts: 18,
      diy_cost: 50, tidy_cost: 10, emergency_p: 0.015, emergency_cost: 180, parts: 30,
      upkeep_est: 70 },
    big_house: { label: "big house", rank: 3, decay: 2.0, comfort: 1.15, pro_rate: 15, diy_pts: 16,
      diy_cost: 120, tidy_cost: 25, emergency_p: 0.02, emergency_cost: 300, parts: 50,
      upkeep_est: 230 },
  };
  const STAGES = [["kept", 80], ["worn", 60], ["shabby", 40], ["neglected", 20], ["derelict", 0]]; // index = stage
  const STAGE_COMFORT = [1.05, 1.00, 0.92, 0.80, 0.65];
  const LANDLORD = "Millbrook Homes";
  const LANDLORD_FLOOR = { flat: 45, house: 60 }; // the landlord repairs a let building below this ...
  const LANDLORD_RESTORE = 85; // ... back up to this
  const VACANT_DECAY = 0.7; // per day, any tier, nobody living there
  const MARKET_FLOOR = 20; // a home held for sale never drops below "neglected"
  const NEWS_SETTLE_DAYS = 1; // a home's poor stage is not news until its household has lived there this long
  const LANDLORD_SELLS_DAYS = 14; // with no other house for sale this long, the landlord sells a let house left empty
  const NOTICE_FROM_DAY = 120; // from this game day, while no house is for sale (house_drought), the landlord sells a let house
  const NOTICE_DAYS = 14; // ... with notice: the tenants have this long to move out, and then it goes on the market ...
  const NOTICE_GAP_DAYS = 30; // ... at most once in this many days in the town ...
  const NOTICE_SETTLED_DAYS = 120; // ... and never to tenants who moved in less than this long ago
  // when tenants buy the house, the next notice keeps its sale date but gives at least this long
  const NOTICE_MIN_DAYS = 7;
  // it gives notice (but at once after tenants buy), and lists a house whose notice ran out, at this hour
  const NOTICE_HOUR = 9;
  const WINTER_DECAY = 1.25;
  const CROWD_DECAY = 0.10; // +10% decay per resident beyond two
  const EMERGENCY_DECAY = 4.0; // extra decay per day while an emergency is unfixed
  const PROPERTY_TAX = 0.005; // of base value, weekly, owners only
  const SALE_FEE = 0.05; // a seller gets value x 0.95
  const MOVING_COST = 150;
  const CALLOUT = 40; // added to every builders' quote
  const RENO_FACTOR = 2.0; // per-point price multiplier when condition < 50 (a full renovation)
  const RESERVE_WEEKS = 6;
  const MOVE_GAP_DAYS = 28;
  const DOWNSIZE_SHARE = 0.8; // an owner downsizes to a home worth at most this share of today's ...
  const DOWNSIZE_CONDITION = 50; // ... in at least this condition
  const SPARE_BEDROOMS = 2; // an owner household with this many more bedrooms than residents has outgrown its home
  const CAR_SALE = 2500;
  const EMERGENCY_DAYS = 3;
  const LIVING_PER_PERSON = 75; // weekly living estimate (affordability, hardship)
  const LIVING_PER_RETIREE = 150;
  const ARREARS_PROGRESS = 50;
  const HARDSHIP_REPAY = 100;
  const FORCED_CROWDING = 3; // residents per bedroom allowed in a forced move
  const STUFF_DAYS = 28;
  const GRACE_DAYS = 28;
  const GRACE_HOLD_DAYS = 14;
  const ODD_JOBS_DAYS = 7;
  const ODD_JOBS_PAY = 100;
  const STUFF_PRICE = 300;

  const EMERGENCY_KINDS = ["leak", "boiler", "roof", "electrics"];
  const EMERGENCY_TEXT = { leak: "A pipe has burst in the kitchen.", boiler: "The boiler has broken down.",
    roof: "The roof is letting the rain in.", electrics: "The electrics keep tripping." };

  const DAY = 24 * 60; // minutes
  const MOVE_VAN_MINUTES = 180; // the moving van stays at the curb this long after a move
  const LANDLORD_WORKS_MINUTES = 8 * 60; // builders on site while the landlord repaints
  const RENOVATE_WORKS_MINUTES = 4 * 60; // builders on site doing up a home bought run-down
  const UNDER_OFFER_DAYS = 3; // a listing another buyer snapped up is off the market this long
  const OFFER_HOLD_MINUTES = 6 * 60; // a listing is held for a household's offer until the answer lands, at most this long
  const SETTLE_DAMAGE = 10; // condition lost when an emergency is never properly fixed, or left behind in a move
  const EMERGENCY_STAGE_P = { 2: 0.015, 3: 0.045, 4: 0.045 }; // extra nightly emergency odds of a shabby or worse home
  const WINTER_EMERGENCY = 1.5;
  const DAMP_HEALTH = { 3: 0.3, 4: 1.0 }; // health lost a night by residents of a neglected or derelict home
  const DAMP_CHILL = { 3: 0.02, 4: 0.06 }; // nightly odds of catching a chill there (doubled in winter, like the health loss)
  const CHILL = { health: -8, fun: -6 };
  const STAGE_REPUTATION = [0, 0, -1, -2, -3]; // each resident, every Sunday
  const KEPT_BIG_HOUSE_PRIDE = 1; // owners of a kept big house: people talk
  // Stage news, owner-occupied homes only: stage -> [tag, text].
  const STAGE_NEWS = { 2: ["shabby", "{home} is looking shabby."], 3: ["neglect", "{home} is falling into neglect."],
    4: ["falling_apart", "{home} is close to falling apart."] };
  const EMERGENCY_NEWS = { leak: "A pipe bursts in the kitchen at {home}.", boiler: "The boiler at {home} breaks down.",
    roof: "Rain is coming in through the roof at {home}.",
    electrics: "The electrics at {home} keep tripping out." };
  const EMERGENCY_NAME = { leak: "leak", boiler: "broken boiler", roof: "leaking roof", electrics: "electrical fault" };
  const ORDINALS = ["first", "second", "third", "fourth", "fifth"];
  const _home = (text, home) => text.replace("{home}", home); // str.format(home=...)

  // The 37 homes, in town.homes order. start: "let" (a tenant household, landlord owner), "owned"
  // (owner-occupied), "for_rent" (vacant, landlord) or "for_sale" (vacant, market). rent is the weekly rent
  // of a landlord-owned home, else 0. A house's condition is its lot's; flats take LOT_CONDITION.
  const HOME_SPECS = [
    // id, place, unit, tier, bedrooms, base_value, rent, start, condition
    ["birch_court_1a", "birch_court", "1A", "flat", 1, 7200, 180, "let", null],
    ["birch_court_1b", "birch_court", "1B", "flat", 2, 8800, 220, "let", null],
    ["birch_court_2a", "birch_court", "2A", "flat", 1, 7200, 180, "let", null],
    ["birch_court_2b", "birch_court", "2B", "flat", 2, 8800, 220, "let", null],
    ["birch_court_3a", "birch_court", "3A", "flat", 2, 8800, 220, "let", null],
    ["birch_court_3b", "birch_court", "3B", "flat", 3, 10400, 260, "let", null],
    ["cedar_court_1a", "cedar_court", "1A", "flat", 1, 7200, 180, "let", null],
    ["cedar_court_1b", "cedar_court", "1B", "flat", 2, 8800, 220, "let", null],
    ["cedar_court_2a", "cedar_court", "2A", "flat", 1, 7200, 180, "let", null],
    ["cedar_court_2b", "cedar_court", "2B", "flat", 2, 8800, 220, "let", null],
    ["cedar_court_3a", "cedar_court", "3A", "flat", 2, 8800, 220, "let", null],
    ["cedar_court_3b", "cedar_court", "3B", "flat", 3, 10400, 260, "for_rent", null],
    ["elm_court_1a", "elm_court", "1A", "flat", 1, 7200, 180, "for_rent", null],
    ["elm_court_1b", "elm_court", "1B", "flat", 2, 8800, 220, "let", null],
    ["elm_court_2a", "elm_court", "2A", "flat", 1, 7200, 180, "let", null],
    ["elm_court_2b", "elm_court", "2B", "flat", 2, 8800, 220, "for_rent", null],
    ["elm_court_3a", "elm_court", "3A", "flat", 2, 8800, 220, "for_rent", null],
    ["elm_court_3b", "elm_court", "3B", "flat", 3, 10400, 260, "let", null],
    ["park_13", "park_13", null, "house", 4, 19600, 0, "owned", 80],
    ["park_21", "park_21", null, "house", 3, 19200, 0, "owned", 90],
    ["park_29", "park_29", null, "house", 3, 16000, 400, "let", 84],
    ["main_12", "main_12", null, "house", 2, 13600, 0, "owned", 57],
    ["main_20", "main_20", null, "house", 3, 16800, 420, "let", 82],
    ["main_28", "main_28", null, "house", 3, 15200, 0, "owned", 66],
    ["main_13", "main_13", null, "house", 4, 20800, 520, "let", 85],
    ["main_21", "main_21", null, "house", 3, 16400, 410, "let", 80],
    ["main_29", "main_29", null, "house", 3, 16800, 0, "owned", 75],
    ["river_12", "river_12", null, "house", 2, 13200, 0, "for_sale", 58],
    ["river_20", "river_20", null, "house", 3, 15600, 390, "let", 80],
    ["river_28", "river_28", null, "house", 3, 18400, 0, "for_sale", 30],
    ["main_39", "main_39", null, "house", 2, 13200, 330, "for_rent", 85],
    ["main_47", "main_47", null, "house", 3, 16000, 400, "let", 78],
    ["main_55", "main_55", null, "house", 4, 20000, 0, "for_sale", 68],
    ["park_66", "park_66", null, "big_house", 5, 46000, 0, "for_sale", 92],
    ["park_78", "park_78", null, "big_house", 5, 36000, 0, "owned", 62],
    ["park_92", "park_92", null, "big_house", 5, 44000, 0, "owned", 88],
    ["park_104", "park_104", null, "big_house", 5, 40000, 0, "for_sale", 70],
  ];
  const LOT_CONDITION = { birch_court: 84, cedar_court: 71, elm_court: 62 }; // apartment blocks at the start
  const START_OWNER = { let: "landlord", owned: null, for_rent: "landlord", for_sale: "market" }; // owned: the household
  const START_LISTING = { let: null, owned: null, for_rent: "for_rent", for_sale: "for_sale" };

  // Activities the housing forks use, merged into sim.ACTIVITIES as Activity(minutes, gains, inside).
  // None of them is leisure.
  const ACTIVITIES_EXTRA = {
    move_house: { minutes: 120, gains: { fun: 10, energy: -15 }, inside: true },
    viewing: { minutes: 45, gains: { fun: 5 }, inside: true },
    let_builders_in: { minutes: 30, gains: { fun: 5 }, inside: true },
    diy: { minutes: 180, gains: { fun: 10, energy: -20 }, inside: true },
    tidy: { minutes: 60, gains: { fun: 5 }, inside: true },
    fix_it: { minutes: 120, gains: { fun: 5, energy: -10 }, inside: true },
    help_out: { minutes: 90, gains: { social: 20 }, inside: true },
    odd_jobs: { minutes: 180, gains: { energy: -15 }, inside: false },
  };

  class Home {
    constructor(id, place, unit, name, tier, bedrooms, base_value, rent, start, o = {}) {
      // Static: never changes after build_homes.
      this.id = id; // a house's place id, or "<block>_<unit lowercase>" for a flat
      this.place = place;
      this.unit = unit; // "1A" ... "3B" for a flat (1A and 1B on the ground floor), null for a house
      this.name = name; // "20 Main Street" or "Birch Court, flat 2B"
      this.tier = tier; // "flat", "house" or "big_house"
      this.bedrooms = bedrooms;
      this.base_value = base_value;
      this.rent = rent; // weekly rent while the landlord owns it, else 0
      this.start = start; // "let", "owned", "for_rent" or "for_sale"
      // Dynamic.
      this.owner = o.owner ?? null; // "landlord", "market" or a household id
      this.household = null; // who lives there
      this.listing = o.listing ?? null; // null, "for_sale" or "for_rent"
      this.under_offer_until = 0; // tick a listing shows again after another buyer's offer
      this.held_for = null; // the household whose offer holds it while under offer (null: another buyer)
      this.pending_emergency = null; // hidden {kind, due}: never serialised
      this.emergency = null; // live {kind, since}: public
      this.history = []; // {tick, time, event, household, price}; off_market on the "bought" row of a let house its
      // tenants bought from the landlord (`buy_let_home`)
      // The owner household's adults' shares of the home, adult id -> share summing to 1: what each one paid of the
      // price when the household bought it. Empty (equal shares) for a home a household had at the start, or one
      // nobody paid for; emptied when the home goes back on the market.
      this.shares = {};
      // The landlord's notice on a let house it is selling, {household, since, due} (ticks): the tenants move out
      // by "due" and the house goes on the market then (`give_notice`), unless they buy it. `noticed` is NOTICE_DAYS
      // before the sale of the last notice given here (when it was given, unless it took over the date of a sale the
      // tenants bought out), kept after that and moved on a day for each day its sale waits for the tenants to go, so
      // the landlord's sales are NOTICE_GAP_DAYS apart (`landlord_notices`); cleared when the tenants buy the house.
      this.notice = null;
      this.noticed = null;
    }
  }

  class Lot {
    constructor(place, condition, o = {}) {
      this.place = place; // a residential place id
      this.condition = condition; // 0-100
      this.works_until = 0; // builders on site until this tick
      this.moving_until = 0; // a moving van at the curb until this tick
      this.reported = o.reported ?? 0; // worst stage already announced; starts at the current stage, back to it at stage 0-1
      this.worst = o.worst ?? 0; // worst stage since the lot was last kept (stage 0), for "looks as good as new"
    }
  }

  function check(ok, what) {
    if (!ok) throw new G.py.PyError("AssertionError", String(what));
  }

  // Every home in HOME_SPECS order, unoccupied; `init(sim)` moves the cast in.
  function build_homes(town) {
    const homes = new Map();
    for (const [hid, place_id, unit, tier, beds, base, rent, start] of HOME_SPECS) {
      const place = town.places.get(place_id);
      check(place.kind === "home" && place.tier === tier, [hid, place.kind, place.tier]);
      const name = unit ? `${place.name}, flat ${unit}` : place.name;
      homes.set(hid, new Home(hid, place_id, unit, name, tier, beds, base, rent, start,
        { owner: START_OWNER[start], listing: START_LISTING[start] }));
    }
    return homes;
  }

  // One lot per residential place that has homes, in place order, at its starting condition.
  function build_lots(town, homes) {
    const start = Object.assign({}, LOT_CONDITION);
    for (const spec of HOME_SPECS) {
      const place_id = spec[1], condition = spec[8];
      if (condition !== null) start[place_id] = condition;
    }
    const used = new Set(Array.from(homes.values(), h => h.place));
    const lots = new Map();
    for (const place of town.places.values()) {
      if (used.has(place.id)) {
        const c = start[place.id];
        lots.set(place.id, new Lot(place.id, c, { reported: stage_of(c), worst: stage_of(c) }));
      }
    }
    return lots;
  }

  // Move the cast into its homes. Call once, after `build_cast`, with sim.homes, sim.lots and the cast set.
  //
  // Each household's home records it as the household, and an owner-occupied home records it as the owner.
  function init(sim) {
    for (const hh of sim.households.values()) {
      const home = sim.homes.get(hh.home_id);
      check((home.household === null || home.household === hh.id) && (home.start === "let" || home.start === "owned"),
        [hh.id, home.id]);
      home.household = hh.id;
      if (home.start === "owned") home.owner = hh.id;
    }
  }

  // --- helpers ------------------------------------------------------------------

  // Portable rounding to an integer: floor(x + 0.5), as JS Math.round.
  const _int = x => Math.floor(x + 0.5);

  const round50 = x => Math.floor(x / 50 + 0.5) * 50;

  // The clock stamp ("Day 3 Tue 10:00") of a tick.
  const stamp_of = tick => new G.clock.Clock(tick).stamp();

  // 0 kept (>= 80), 1 worn (>= 60), 2 shabby (>= 40), 3 neglected (>= 20), 4 derelict.
  function stage_of(c) {
    for (let i = 0; i < STAGES.length; i++) if (c >= STAGES[i][1]) return i;
    return STAGES.length - 1;
  }

  const stage_name = i => STAGES[i][0];

  const condition_of = (sim, home_id) => sim.lots.get(sim.homes.get(home_id).place).condition;

  // Market value: base value x (0.7 + 0.003 x condition), to the nearest $50. Condition 0 is 70% of base.
  function value(sim, home_id) {
    const home = sim.homes.get(home_id);
    return round50(home.base_value * (0.7 + 0.003 * condition_of(sim, home_id)));
  }

  // What a seller gets: value less the sale fee.
  const sale_proceeds = (sim, home_id) => _int(value(sim, home_id) * (1 - SALE_FEE));

  const property_tax = home => _int(home.base_value * PROPERTY_TAX);

  // The home's listing as buyers see it (as household `hh` sees it, when given): null while it is under
  // offer, except to the household the listing is held for.
  function listed(sim, home, hh = null) {
    const free = home.under_offer_until <= sim.clock.tick || (hh !== null && home.held_for === hh.id);
    return free ? home.listing : null;
  }

  // Take a listing off the market for `minutes`: for household `hh`'s offer, or for another buyer (null).
  function hold(sim, home, hh, minutes) {
    home.under_offer_until = sim.clock.tick + minutes;
    home.held_for = hh !== null ? hh.id : null;
  }

  // Back on the market (if it is still listed): no offer holds it.
  function release(home) {
    home.under_offer_until = 0;
    home.held_for = null;
  }

  // The household's living adults: the ones who pay and decide.
  const adults = (sim, hh) => hh.member_ids.map(m => sim.agents.get(m)).filter(a => a.alive && a.is_adult);

  const residents = (sim, hh) => count(hh.member_ids, m => sim.agents.get(m).alive);

  // More than two residents per bedroom.
  const crowded = (sim, hh) => residents(sim, hh) > 2 * sim.homes.get(hh.home_id).bedrooms;

  // The living adults' money plus savings; savings-goal pots are not counted.
  const funds = (sim, hh) => sum(adults(sim, hh).map(a => a.money + a.savings));

  const tenure = (sim, hh) => (sim.homes.get(hh.home_id).owner === hh.id ? "owned" : "rented");

  // This week's housing charge: rent (or hardship rent) for renters, property tax for owners.
  function weekly_cost(sim, hh) {
    const home = sim.homes.get(hh.home_id);
    if (home.owner === hh.id) return hh.tax_deferred ? 0 : property_tax(home);
    return _int(hh.hardship_rent !== null ? hh.hardship_rent : hh.weekly_rent);
  }

  // How good home activities feel: tier comfort x stage comfort, x 0.9 when crowded.
  function comfort(sim, hh) {
    const home = sim.homes.get(hh.home_id);
    const c = TIERS[home.tier].comfort * STAGE_COMFORT[stage_of(condition_of(sim, home.id))];
    return crowded(sim, hh) ? c * 0.9 : c;
  }

  // Each living adult's share of the household's home, adult id -> share summing to 1: the shares recorded when
  // the household bought it (`Home.shares`), so the share of an adult who has died passes to the others in
  // proportion to theirs, and an adult who paid nothing holds none. Equal shares when none is recorded (a home the
  // household had at the start) or nobody who paid is left.
  function home_shares(sim, hh) {
    const people = adults(sim, hh);
    const recorded = sim.homes.get(hh.home_id).shares;
    const held = sum(people.map(a => getd(recorded, a.id, 0.0)));
    const out = {};
    for (const a of people) out[a.id] = held <= 0 ? 1 / people.length : getd(recorded, a.id, 0.0) / held;
    return out;
  }

  // {cash, savings, home} in whole dollars. Savings include the savings-goal pot; home is an adult's share of an
  // owned home's value (`home_shares`: by what each adult paid for it, equal for a starting home).
  function worth_parts(sim, agent) {
    const hh = sim.households.get(agent.household_id);
    let home = 0.0;
    if (agent.alive && agent.is_adult && tenure(sim, hh) === "owned") {
      home = value(sim, hh.home_id) * getd(home_shares(sim, hh), agent.id, 0.0);
    }
    const saved = agent.goal ? agent.goal.saved : 0.0;
    return { cash: _int(agent.money), savings: _int(agent.savings + saved), home: _int(home) };
  }

  // Cash + savings + home equity: the sum of `worth_parts`.
  const net_worth = (sim, agent) => sum(Object.values(worth_parts(sim, agent)));

  const _surname = name => lastName(name);

  // "Ari Ben-David" for one adult, "The Cohens" when the adults share a surname, else "Dana and Yossi".
  function household_name(sim, hh) {
    let people = adults(sim, hh);
    if (!people.length) people = hh.member_ids.map(m => sim.agents.get(m)).filter(a => a.alive);
    if (!people.length) people = hh.member_ids.map(m => sim.agents.get(m));
    if (!people.length) return hh.id;
    if (people.length === 1) return people[0].name;
    const surnames = new Set(people.map(a => _surname(a.name)));
    if (surnames.size === 1) {
      const s = surnames.values().next().value;
      return `The ${s}${["s", "z", "x", "ch", "sh"].some(e => s.endsWith(e)) ? "es" : "s"}`;
    }
    const firsts = people.map(a => firstName(a.name));
    return firsts.slice(0, -1).join(", ") + " and " + firsts[firsts.length - 1];
  }

  // The stats push's households[] row.
  function household_summary(sim, hh) {
    const home = sim.homes.get(hh.home_id);
    return { id: hh.id, name: household_name(sim, hh),
      members: hh.member_ids.filter(m => sim.agents.get(m).alive),
      home: home.id, home_name: home.name, place: home.place, tier_label: TIERS[home.tier].label,
      tenure: tenure(sim, hh), weekly_cost: weekly_cost(sim, hh) };
  }

  // Pay `amount` from the household's living adults, in proportion to each one's max(0, money + savings)
  // (equally when every one is at or below zero), and return what each paid, adult id -> dollars. Each share comes
  // out of savings first, then money, which may go negative. A negative amount (money coming in) goes into the
  // adults' savings: by `shares` (adult id -> share, as `home_shares` gives them) when given, else equally; nobody
  // pays anything then, so the return is empty.
  function pay_household(sim, hh, amount, shares = null) {
    const payers = adults(sim, hh);
    if (!payers.length || !amount) return {};
    if (amount < 0) {
      for (const a of payers) {
        a.savings += shares !== null ? -amount * getd(shares, a.id, 0.0) : -amount / payers.length;
      }
      return {};
    }
    const weights = payers.map(a => Math.max(0.0, a.money + a.savings));
    const total = sum(weights);
    const paid = {};
    payers.forEach((a, i) => {
      const due = amount * (total > 0 ? weights[i] / total : 1 / payers.length);
      const take = Math.min(Math.max(a.savings, 0.0), due);
      a.savings -= take;
      a.money -= due - take;
      paid[a.id] = due;
    });
    return paid;
  }

  // --- money, affordability and the market -------------------------------------------------

  const round10 = x => Math.floor(x / 10 + 0.5) * 10;

  // 65 or over with no job: lives on the pension.
  const retired = agent => agent.job === null && agent.age >= 65;

  // The adults' take-home pay for a full week of shifts, plus pensions.
  function weekly_income(sim, hh) {
    const { PENSION, income_tax } = G.sim; // sim uses this module, so it is looked up when needed
    let total = 0.0;
    for (const a of adults(sim, hh)) {
      const job = a.job;
      if (job && job.hourly_wage > 0) {
        const hours = (job.end_hour - job.start_hour) * job.workdays.length;
        total += job.hourly_wage * hours * (1 - income_tax(job.hourly_wage));
      } else if (retired(a)) {
        total += PENSION;
      }
    }
    return total;
  }

  // The adults' weekly bills: BILLS_PER_ADULT each, and CAR_BILL for each car.
  function bills(sim, hh) {
    const { BILLS_PER_ADULT, CAR_BILL } = G.sim;
    return sum(adults(sim, hh).map(a => BILLS_PER_ADULT + (a.owns_car ? CAR_BILL : 0.0)));
  }

  // The weekly living estimate: LIVING_PER_PERSON a resident, LIVING_PER_RETIREE for a retiree.
  function living(sim, hh) {
    return sum(hh.member_ids.map(m => sim.agents.get(m)).filter(a => a.alive)
      .map(a => (retired(a) ? LIVING_PER_RETIREE : LIVING_PER_PERSON)));
  }

  // The adults' weekly commuting costs by their usual way to work.
  const commute = (sim, hh) => sum(adults(sim, hh).map(a => G.travel.weekly_commute_cost(sim, a)));

  // Moving into this vacant home means buying it (the market holds it), not renting it.
  const buys = home => home.owner === "market";

  // A week of living in `home`: property tax plus the tier's upkeep estimate when owning, else the rent.
  function housing_cost(sim, hh, home, factor = 1.0) {
    if (home.owner === hh.id || buys(home)) return home.base_value * PROPERTY_TAX + getd(TIERS[home.tier], "upkeep_est", 0);
    if (home.id === hh.home_id) return hh.weekly_rent;
    return home.rent * factor;
  }

  // What a week costs the household in `home_id` (default: where it lives): housing, bills, living, commute.
  function weekly_outgo(sim, hh, home_id = null, factor = 1.0) {
    const home = sim.homes.get(home_id || hh.home_id);
    return housing_cost(sim, hh, home, factor) + bills(sim, hh) + living(sim, hh) + commute(sim, hh);
  }

  const fits = (sim, hh, home, per_bedroom = 2) => residents(sim, hh) <= per_bedroom * home.bedrooms;

  // A full renovation of a run-down house (condition under 50); 0 for anything better, and for flats.
  function reno_cost(sim, home_id) {
    const home = sim.homes.get(home_id);
    const c = condition_of(sim, home_id);
    if (c >= 50 || home.tier === "flat") return 0;
    return round10((100 - c) * TIERS[home.tier].pro_rate * RENO_FACTOR) + CALLOUT;
  }

  // The cash a move costs: the price (when buying) and the van, less the sale of the home they own now.
  function net_cost(sim, hh, home_id) {
    const home = sim.homes.get(home_id), cur = sim.homes.get(hh.home_id);
    const price = buys(home) ? value(sim, home_id) : 0;
    const back = cur.owner === hh.id ? sale_proceeds(sim, cur.id) : 0;
    return price + MOVING_COST - back;
  }

  // The affordability gate of every offered move.
  //
  // After the move (a purchase also pays for the renovation it needs) the household keeps RESERVE_WEEKS of the
  // new weekly outgo and can carry the new home for a year. A rental also needs the week's income to cover the
  // new outgo.
  function affordable(sim, hh, home_id, factor = 1.0) {
    const home = sim.homes.get(home_id);
    let left = funds(sim, hh) - net_cost(sim, hh, home_id);
    if (buys(home)) left += (1 - factor) * value(sim, home_id) - reno_cost(sim, home_id);
    const outgo = weekly_outgo(sim, hh, home_id, factor);
    const income = weekly_income(sim, hh);
    if (left < RESERVE_WEEKS * outgo || (income - outgo) * 52 + left < 0) return false;
    return buys(home) || income >= outgo;
  }

  // Not a lower tier, and: more room for a crowded household; owning instead of renting a home worth at
  // least 90% of today's; or a home worth at least 15% more.
  //
  // Owners look only at homes for sale unless they are crowded: selling up to rent a pricier place gives away
  // the home and the sale fee for a higher weekly outgo, never a step up (housing.md 11, point 4). For a year after
  // it has downsized (its "downsized" cooldown), a household doesn't take more bedrooms unless it is crowded.
  function is_upgrade(sim, hh, home_id) {
    const cur = sim.homes.get(hh.home_id), nw = sim.homes.get(home_id);
    if (TIERS[nw.tier].rank < TIERS[cur.tier].rank) return false;
    if (crowded(sim, hh) && nw.bedrooms > cur.bedrooms) return true;
    if (nw.bedrooms > cur.bedrooms && getd(hh.cooldowns, "downsized", 0) > sim.clock.tick) return false;
    const owner = cur.owner === hh.id;
    if (owner && !buys(nw)) return false;
    if (!owner && buys(nw)) return value(sim, home_id) >= 0.9 * value(sim, cur.id);
    return value(sim, home_id) >= 1.15 * value(sim, cur.id);
  }

  // Vacant homes buyers and renters can see now (not under offer), in town.homes order.
  function vacancies(sim, listing = null) {
    return Array.from(sim.homes.values()).filter(h => h.household === null && listed(sim, h)
      && (listing === null || listed(sim, h) === listing));
  }

  // The homes `house_hunt` offers: listed, vacant, fitting, an upgrade and affordable.
  function hunt_candidates(sim, hh) {
    return vacancies(sim).filter(h => fits(sim, hh, h) && is_upgrade(sim, hh, h.id) && affordable(sim, hh, h.id));
  }

  // An owner household that has outgrown its home: every adult is retired, or it has at least SPARE_BEDROOMS more
  // bedrooms than residents. `house_hunt` asks it now and then whether to downsize, once it has lived there a while
  // and when nothing better is on the market.
  function outgrown(sim, hh) {
    const home = sim.homes.get(hh.home_id);
    const people = adults(sim, hh);
    if (home.owner !== hh.id || !people.length) return false;
    return people.every(a => retired(a)) || residents(sim, hh) <= home.bedrooms - SPARE_BEDROOMS;
  }

  // The smaller homes an owner could sell up and buy: for sale, vacant, fitting, in at least DOWNSIZE_CONDITION,
  // worth at most DOWNSIZE_SHARE of the home they own now, and affordable (hunt_candidates' rules).
  function downsize_candidates(sim, hh) {
    const worth = value(sim, hh.home_id);
    return vacancies(sim, "for_sale").filter(h => fits(sim, hh, h) && condition_of(sim, h.id) >= DOWNSIZE_CONDITION
      && value(sim, h.id) <= DOWNSIZE_SHARE * worth && affordable(sim, hh, h.id));
  }

  // No house or big house other than `but` has been for sale for LANDLORD_SELLS_DAYS: none is for sale now
  // (under offer included) and none was bought in that time (a home is for sale until it is bought; one its tenants
  // bought from the landlord, marked off_market, never was). The landlord then sells a let house its tenants leave,
  // and owners who have outgrown their homes think harder about selling.
  function house_drought(sim, but = null) {
    const now = sim.clock.tick;
    if (now < LANDLORD_SELLS_DAYS * DAY) return false;
    for (const h of sim.homes.values()) {
      if (h.tier === "flat" || h.id === but) continue;
      if (h.household === null && h.listing === "for_sale") return false;
      if (h.history.some(r => r.event === "bought" && !r.off_market && now - r.tick < LANDLORD_SELLS_DAYS * DAY)) {
        return false;
      }
    }
    return true;
  }

  // The cheapest fitting home to let, with rent under `below` when given (ties: better condition, then id).
  function cheapest_rental(sim, hh, below = null, per_bedroom = 2) {
    const pool = vacancies(sim, "for_rent").filter(h => fits(sim, hh, h, per_bedroom) && (below === null || h.rent < below));
    return pool.length ? minBy(pool, h => [h.rent, -condition_of(sim, h.id), h.id]) : null;
  }

  // The let house the household lives in while the landlord is selling it with notice (`give_notice`), else null.
  function under_notice(sim, hh) {
    const home = sim.homes.get(hh.home_id);
    return home.notice !== null && home.household === hh.id ? home : null;
  }

  // Tenants under notice could buy the let house they live in from the landlord at its value: `affordable`'s rules
  // for a purchase (the reserve of the new weekly outgo is left, and the home is carried for a year). The landlord
  // keeps a let house above LANDLORD_FLOOR, so it needs no renovation.
  function can_buy_let_home(sim, hh) {
    const home = sim.homes.get(hh.home_id);
    const left = funds(sim, hh) - value(sim, home.id);
    const outgo = home.base_value * PROPERTY_TAX + getd(TIERS[home.tier], "upkeep_est", 0) + bills(sim, hh)
      + living(sim, hh) + commute(sim, hh);
    return left >= RESERVE_WEEKS * outgo && (weekly_income(sim, hh) - outgo) * 52 + left >= 0;
  }

  // The let house the landlord sells with notice: one whose tenants have lived there since the start or for at least
  // NOTICE_SETTLED_DAYS and have a fitting home to let to go to; the longest-standing tenants first (ties: id).
  function notice_home(sim) {
    const now = sim.clock.tick;
    const pool = [];
    for (const h of sim.homes.values()) {
      if (h.owner !== "landlord" || h.tier === "flat" || h.household === null) continue;
      const hh = sim.households.get(h.household);
      if (hh.moved_tick !== null && now - hh.moved_tick < NOTICE_SETTLED_DAYS * DAY) continue;
      if (adults(sim, hh).length && cheapest_rental(sim, hh) !== null) {
        pool.push([hh.moved_tick === null ? -1 : hh.moved_tick, h.id, h]);
      }
    }
    return pool.length ? minBy(pool, row => [row[0], row[1]])[2] : null;
  }

  const owner_occupied = home => home.household !== null && home.owner === home.household;

  const lot_homes = (sim, place_id) => Array.from(sim.homes.values()).filter(h => h.place === place_id);

  // The rent a renter at the bottom of the market pays until back on their feet: what is left of the week's
  // income after bills, living and HARDSHIP_REPAY, to the nearest $10, never above the rent.
  function hardship_rent(sim, hh) {
    const spare = weekly_income(sim, hh) - bills(sim, hh) - living(sim, hh) - HARDSHIP_REPAY;
    return Math.min(_int(hh.weekly_rent), Math.max(0, round10(spare)));
  }

  // The household is one adult (so the verb is singular).
  const _one = (sim, hh) => adults(sim, hh).length <= 1;

  // The household's name in the middle of a sentence: "the Cohens".
  function _hh_lower(sim, hh) {
    const name = household_name(sim, hh);
    return name.startsWith("The ") ? "t" + name.slice(1) : name;
  }

  function _hh_possessive(sim, hh) {
    const name = _hh_lower(sim, hh);
    return name.endsWith("s") && name.startsWith("the ") ? name + "'" : name + "'s";
  }

  function district_name(sim, home) {
    const district = sim.town.places.get(home.place).district;
    return getd(G.town.DISTRICT_NAMES, district, title(district.replace(/_/g, " ")));
  }

  // --- serializers (only the live `emergency` is ever sent; pending_emergency stays hidden) --------------

  // Condition as a whole number that always agrees with its stage (floored).
  const _condition_json = lot => Math.floor(lot.condition);

  function _emergency_json(home) {
    const em = home.emergency;
    if (!em) return null;
    const since = em.since;
    return { kind: em.kind, text: getd(EMERGENCY_TEXT, em.kind, "Something has broken."),
      since: Number.isInteger(since) ? stamp_of(since) : since };
  }

  function _price(sim, home) {
    const shown = listed(sim, home);
    if (shown === "for_sale") return value(sim, home.id);
    if (shown === "for_rent") return home.rent;
    return null;
  }

  // The static part of every home, for the God welcome's town.homes.
  function town_homes_json(sim) {
    return Array.from(sim.homes.values(), h => ({ id: h.id, place: h.place, unit: h.unit, name: h.name, tier: h.tier,
      bedrooms: h.bedrooms, base_value: h.base_value, rent: h.rent }));
  }

  function town_housing_json() {
    const tiers = {};
    for (const [tid, t] of Object.entries(TIERS)) tiers[tid] = { label: t.label, rank: t.rank };
    return { tiers, stages: STAGES.map(([name, lo]) => ({ name, min: lo })), landlord: LANDLORD };
  }

  // state.lots: every residential place's condition, stage and the builders' and movers' vans.
  function lots_json(sim) {
    const tick = sim.clock.tick;
    const out = {};
    for (const [pid, lot] of sim.lots) {
      out[pid] = { condition: _condition_json(lot), stage: stage_of(lot.condition),
        works: lot.works_until > tick, moving: lot.moving_until > tick };
    }
    return out;
  }

  // state.homes: who lives where, the owner, the listing and price, the value and a live emergency's kind.
  function homes_json(sim) {
    const out = {};
    for (const h of sim.homes.values()) {
      out[h.id] = { hh: h.household, owner: h.owner, listing: listed(sim, h), price: _price(sim, h),
        value: value(sim, h.id), emergency: h.emergency ? h.emergency.kind : null };
    }
    return out;
  }

  function _home_block(sim, hh) {
    const home = sim.homes.get(hh.home_id);
    const lot = sim.lots.get(home.place);
    const owned = home.owner === hh.id;
    const st = stage_of(lot.condition);
    return {
      id: home.id, place: home.place, name: home.name, tier: home.tier,
      tier_label: TIERS[home.tier].label, district: sim.town.places.get(home.place).district,
      bedrooms: home.bedrooms, tenure: owned ? "owned" : "rented",
      landlord: owned ? null : LANDLORD, weekly_rent: owned ? 0 : _int(hh.weekly_rent),
      property_tax: owned ? property_tax(home) : 0, weekly_cost: weekly_cost(sim, hh),
      value: value(sim, home.id), condition: _condition_json(lot), stage: st, stage_name: stage_name(st),
      comfort: r2(comfort(sim, hh)), moved_in: hh.moved_tick !== null ? stamp_of(hh.moved_tick) : null,
      emergency: _emergency_json(home),
    };
  }

  // The agent page's and `query possessions`' possessions.
  function possessions_json(sim, agent) {
    const hh = sim.households.get(agent.household_id);
    return {
      home: _home_block(sim, hh),
      car: agent.owns_car,
      phone: { condition: agent.goal && agent.goal.name.includes("phone") ? "cracked" : "fine" },
      money: r2(agent.money),
      savings: r2(agent.savings),
      household_funds: _int(funds(sim, hh)),
      savings_goal: agent.goal,
      groceries_at_home: hh.groceries,
    };
  }

  // The home and household money lines of a fork message's `you`.
  function fork_you(sim, agent) {
    const hh = sim.households.get(agent.household_id);
    const block = _home_block(sim, hh);
    const home = {};
    for (const k of ["name", "tier", "tenure", "weekly_cost", "condition", "stage_name", "value"]) home[k] = block[k];
    return { home, household_funds: _int(funds(sim, hh)) };
  }

  // Money and housing fields of the agent page (get_agent).
  function agent_page_fields(sim, agent) {
    const hh = sim.households.get(agent.household_id);
    const parts = worth_parts(sim, agent);
    const history = hh.history.slice(-20).map(row => ({ time: row.time ?? null, event: row.event ?? null,
      home: row.home ?? null, name: row.name ?? null, price: row.price ?? null }));
    return { savings: r2(agent.savings), household_funds: _int(funds(sim, hh)), net_worth: sum(Object.values(parts)),
      worth_parts: parts, home_history: history };
  }

  // Controller `query market`: the vacant homes listed for sale and to let, in town.homes order.
  function market_json(sim) {
    const out = { for_sale: [], for_rent: [] };
    for (const h of sim.homes.values()) {
      const shown = listed(sim, h);
      if (h.household !== null || shown === null) continue;
      const row = { home: h.id, name: h.name, tier: h.tier, district: sim.town.places.get(h.place).district,
        bedrooms: h.bedrooms };
      const st = stage_name(stage_of(condition_of(sim, h.id)));
      if (shown === "for_sale") out.for_sale.push(Object.assign(row, { price: value(sim, h.id), stage_name: st }));
      else out.for_rent.push(Object.assign(row, { rent: h.rent, stage_name: st }));
    }
    return out;
  }

  // God's `get_home` reply body, or null for an unknown home.
  function home_page(sim, home_id) {
    const h = sim.homes.get(home_id);
    if (h === undefined) return null;
    const lot = sim.lots.get(h.place);
    const st = stage_of(lot.condition);
    const hh = h.household ? sim.households.get(h.household) ?? null : null;
    const history = h.history.slice(-20).map(row => ({ time: row.time ?? null, event: row.event ?? null,
      household: row.household ?? null, price: row.price ?? null }));
    return {
      id: h.id, place: h.place, unit: h.unit, name: h.name, tier: h.tier, bedrooms: h.bedrooms,
      base_value: h.base_value, rent: h.rent, district: sim.town.places.get(h.place).district,
      hh: h.household, household_name: hh ? household_name(sim, hh) : null, owner: h.owner,
      listing: listed(sim, h), price: _price(sim, h), value: value(sim, h.id),
      emergency: _emergency_json(h), condition: _condition_json(lot), stage: st, stage_name: stage_name(st),
      residents: hh ? hh.member_ids.filter(m => sim.agents.get(m).alive).map(m => sim.agents.get(m).name) : [],
      history,
    };
  }

  // --- group B: moves --------------------------------------------------------------------------

  function _history(rows, row) {
    rows.push(row);
    G.py.keepLast(rows, 20);
  }

  function _event(sim, text, tag, place, agent = null, agents = null) {
    sim.event(text, agent, null, { tag, agents: agents || [], place });
  }

  const _members = (sim, hh) => hh.member_ids.map(m => sim.agents.get(m)).filter(a => a.alive);

  // The household can still move into this home: vacant and listed as the household sees it.
  const available = (sim, hh, home) => home.household === null && listed(sim, home, hh) !== null;

  // The news that a home the household wanted has gone: taken, or held for someone else's offer.
  function too_late(sim, hh, home, agent) {
    let gone;
    if (home.household === null && home.listing && home.held_for !== null && home.held_for !== hh.id) {
      gone = "is under offer";
    } else {
      gone = "has been " + (buys(home) || (home.owner !== "landlord" && home.owner !== "market") ? "sold" : "let");
    }
    _event(sim, `${household_name(sim, hh)} ${_one(sim, hh) ? "was" : "were"} too late: ${home.name} ${gone}.`,
      "too_late", home.place, agent);
  }

  // Move a household into a vacant listed home: `how` is "buy" or "rent", at `factor` times the asking price
  // or rent. `forced` is null for the household's own choice, else "evicted" or "forced_sale" (no affordability
  // check, no van fee for a rental). Returns false, with a too_late event, when the home has gone or the
  // household can't raise the money after all (`check=false` skips the affordability gate, for a step down to a
  // rental out of housing trouble).
  //
  // The old home is freed and listed (an owned one for sale at its value, with the sale credited to the adults'
  // savings by their shares of it; a rented one back to let, unless it is a house and no other house has been for
  // sale for LANDLORD_SELLS_DAYS: then the landlord sells it; one the landlord gave the household notice on stays
  // empty until the notice runs out, `landlord_notices`). The van and the price are paid from the household
  // pot, and a home bought records each adult's share of it as their part of that payment, so buying moves an
  // adult's money into their own equity, never into another's. Members free to drop what they are doing set off
  // for the new home; the rest go there the next time they head home. `plan_decider=false` leaves the decider
  // alone, for a fork option whose own steps go there.
  function move_household(sim, hh, home_id, how, factor = 1.0, decider = null, forced = null, plan_decider = true,
    check_money = true) {
    const nw = sim.homes.get(home_id);
    const now = sim.clock.tick, stamp = sim.clock.stamp();
    const who = household_name(sim, hh);
    const agent = decider || (adults(sim, hh)[0] || _members(sim, hh)[0] || null);
    if (!available(sim, hh, nw)) {
      too_late(sim, hh, nw, agent);
      return false;
    }
    if (check_money && !forced && !affordable(sim, hh, home_id, factor)) {
      _event(sim, `${who} can't raise the money for ${nw.name} after all.`, "too_late", nw.place, agent);
      if (nw.held_for === hh.id) release(nw); // their own offer no longer holds it
      return false;
    }
    const old = sim.homes.get(hh.home_id);
    const owned = old.owner === hh.id;
    const buy = how === "buy";
    const proceeds = owned ? sale_proceeds(sim, old.id) : 0;
    const sells = old.owner === "landlord" && old.tier !== "flat" && old.notice === null && house_drought(sim, nw.id);
    // Leave the old home: an owned one goes on the market, a rented one back to the landlord (who sells a
    // house when there has been none for sale for a while, and keeps one it gave notice on empty until the
    // notice runs out).
    if (owned) {
      pay_household(sim, hh, -proceeds, home_shares(sim, hh));
      old.owner = "market";
      old.listing = "for_sale";
      old.shares = {};
    } else if (sells) {
      old.owner = "market";
      old.listing = "for_sale";
    } else {
      old.listing = old.notice !== null ? null : "for_rent";
    }
    old.household = null;
    release(old);
    old.pending_emergency = null;
    if (old.emergency) { // the problem stays with the house, as lost condition
      old.emergency = null;
      _change_condition(sim, sim.lots.get(old.place), -SETTLE_DAMAGE);
    }
    const left = forced || (owned ? "sold" : "left");
    // Pay and take the new home.
    const price = buy ? _int(value(sim, home_id) * factor) : 0;
    const van = buy || !(forced || (hh.arrears > 0 && !owned)) ? MOVING_COST : 0;
    const dues = pay_household(sim, hh, price + van);
    if (buy) {
      nw.owner = hh.id;
      nw.shares = {}; // one split pays the price and the van
      for (const [aid, due] of Object.entries(dues)) nw.shares[aid] = due / (price + van);
      hh.weekly_rent = 0;
    } else {
      hh.weekly_rent = _int(nw.rent * factor);
    }
    nw.listing = null;
    nw.household = hh.id;
    release(nw);
    hh.home_id = nw.id;
    hh.moved_tick = now;
    hh.trouble_seen = 0;
    delete hh.cooldowns.upkeep; // the upkeep and repair cooldowns were the old home's
    delete hh.cooldowns.repair;
    hh.hardship_rent = null;
    hh.tax_deferred = false;
    sim.lots.get(nw.place).moving_until = now + MOVE_VAN_MINUTES;
    const arrived = buy ? "bought" : "rented";
    const paid = buy ? price : hh.weekly_rent;
    _history(hh.history, { tick: now, time: stamp, event: left, home: old.id, name: old.name, price: proceeds || null });
    _history(hh.history, { tick: now, time: stamp, event: arrived, home: nw.id, name: nw.name, price: paid });
    _history(old.history, { tick: now, time: stamp, event: left, household: hh.id, price: proceeds || null });
    _history(nw.history, { tick: now, time: stamp, event: arrived, household: hh.id, price: paid });
    // The news.
    const people = _members(sim, hh);
    const ids = people.map(a => a.id);
    const tier = TIERS[nw.tier].label;
    let sold = owned ? `, selling ${old.name} for $${commas(proceeds)}` : "";
    const one = _one(sim, hh);
    if (forced === "evicted") {
      _event(sim, `${LANDLORD} evicts ${_hh_lower(sim, hh)} from ${old.name}. They move into ${nw.name} at `
        + `$${hh.weekly_rent}/week.`, "evicted", nw.place, agent, ids);
    } else if (forced === "forced_sale" && !buy) {
      _event(sim, `${who} ${one ? "is" : "are"} forced to sell ${old.name} ($${commas(proceeds)}) and move into `
        + `${nw.name} at $${hh.weekly_rent}/week.`, "forced_sale", nw.place, agent, ids);
    } else {
      if (forced === "forced_sale") {
        _event(sim, `${who} ${one ? "is" : "are"} forced to sell ${old.name} ($${commas(proceeds)}).`, "forced_sale",
          old.place, agent, ids);
        sold = "";
      }
      if (buy) {
        _event(sim, `${who} ${one ? "buys" : "buy"} ${nw.name} (${tier}, ${district_name(sim, nw)}) for `
          + `$${commas(price)}${sold}.`, "home_bought", nw.place, agent, ids);
      } else {
        _event(sim, `${who} ${one ? "moves" : "move"} into ${nw.name} (${tier}) at $${hh.weekly_rent}/week${sold}.`,
          "home_rented", nw.place, agent, ids);
      }
    }
    if (sells) {
      _event(sim, `${LANDLORD} puts ${old.name} up for sale ($${commas(value(sim, old.id))}).`, "home_listed",
        old.place);
    }
    for (const a of people) {
      if (a !== agent) a.remember(stamp, `Moved to ${nw.name}.`);
      if ((a !== decider || plan_decider) && sim._interruptible(a)) sim.start_plan(a, [["move_house", nw.place]]);
    }
    return true;
  }

  // Builders do the household's home up to condition 100 for `cost`, paid from the household pot: the
  // renovation a run-down home is bought with, done the day it is bought.
  function renovate(sim, hh, cost) {
    const lot = sim.lots.get(sim.homes.get(hh.home_id).place);
    pay_household(sim, hh, cost);
    lot.works_until = Math.max(lot.works_until, sim.clock.tick + RENOVATE_WORKS_MINUTES);
    _change_condition(sim, lot, 100 - lot.condition);
  }

  // --- group B: the landlord sells a let house with notice --------------------------------------

  // The landlord is selling a let house: its tenants have NOTICE_DAYS to move out, or until `due` when the notice
  // takes over the date of a sale the last tenants bought out (`buy_let_home`); house_hunt's notice variant asks them
  // where to go at once, and the house goes on the market when the notice runs out (`landlord_notices`).
  function give_notice(sim, home, due = null) {
    const hh = sim.households.get(home.household);
    const now = sim.clock.tick;
    due = due === null ? now + NOTICE_DAYS * DAY : due;
    home.notice = { household: hh.id, since: now, due };
    home.noticed = due - NOTICE_DAYS * DAY;
    delete hh.cooldowns.house_hunt;
    const notice = due - now === NOTICE_DAYS * DAY ? `${Math.floor(NOTICE_DAYS / 7)} weeks' notice`
      : `notice to move out by ${stamp_of(due)}`;
    _event(sim, `${LANDLORD} is selling ${home.name} and gives ${_hh_lower(sim, hh)} ${notice}.`, "home_listed",
      home.place, adults(sim, hh)[0] || null, _members(sim, hh).map(a => a.id));
  }

  // NOTICE_HOUR every day. A house whose notice has run out goes on the market, its tenants moved first into the
  // cheapest fitting home to let if they are still there (an eviction: the landlord's van, no affordability gate;
  // crowding relaxed to FORCED_CROWDING when nothing else fits, and another day's wait when nothing is free, which
  // the next notice waits too). The sale is when the notice runs out however soon the tenants go, so the landlord's
  // sales are as far apart as its notices. Then the landlord may give a notice (`_landlord_sells`).
  function landlord_notices(sim) {
    const now = sim.clock.tick;
    for (const home of sim.homes.values()) {
      if (home.notice === null || home.notice.due > now) continue;
      if (home.household !== null) {
        const hh = sim.households.get(home.household);
        const rental = cheapest_rental(sim, hh) || cheapest_rental(sim, hh, null, FORCED_CROWDING);
        if (rental === null || !move_household(sim, hh, rental.id, "rent", 1.0, null, "evicted")) {
          home.notice.due += DAY;
          home.noticed += DAY;
          continue;
        }
      }
      home.notice = null;
      home.owner = "market";
      home.listing = "for_sale";
      _event(sim, `${LANDLORD} puts ${home.name} up for sale ($${commas(value(sim, home.id))}).`, "home_listed",
        home.place);
    }
    _landlord_sells(sim);
  }

  // From day NOTICE_FROM_DAY, while no house has been for sale for LANDLORD_SELLS_DAYS (`house_drought`), no notice
  // is running and none was given in the last NOTICE_GAP_DAYS (counted from NOTICE_DAYS before its sale,
  // `Home.noticed`), the landlord gives notice on one let house (`notice_home`), to move out by `due` when given.
  function _landlord_sells(sim, due = null) {
    const now = sim.clock.tick;
    const homes = Array.from(sim.homes.values());
    if (now < NOTICE_FROM_DAY * DAY || homes.some(h => h.notice !== null) || !house_drought(sim)) return;
    if (homes.some(h => h.noticed !== null && now - h.noticed < NOTICE_GAP_DAYS * DAY)) return;
    const home = notice_home(sim);
    if (home !== null) give_notice(sim, home, due);
  }

  // Tenants under notice buy the let house they live in from the landlord at its value, paid from the household
  // pot; each adult's share of it is what they paid, and the notice ends. The house was never on the market, so the
  // purchase leaves a house drought standing (its "bought" row is marked off_market) and doesn't count towards the
  // gap between the landlord's sales: the landlord gives notice on the next let house at once (`_landlord_sells`),
  // to move out by the same date, so its sale is not put off (but never less than NOTICE_MIN_DAYS from now). Returns
  // false, with a too_late event, when the notice is over or they can't raise the money after all.
  function buy_let_home(sim, hh, agent = null) {
    const home = sim.homes.get(hh.home_id);
    const who = household_name(sim, hh);
    if (under_notice(sim, hh) === null || !can_buy_let_home(sim, hh)) {
      _event(sim, `${who} can't buy ${home.name} after all.`, "too_late", home.place, agent);
      return false;
    }
    const now = sim.clock.tick, stamp = sim.clock.stamp();
    const price = value(sim, home.id);
    const sale = home.notice.due;
    const dues = pay_household(sim, hh, price);
    home.owner = hh.id;
    home.listing = null;
    home.notice = null;
    home.noticed = null;
    home.shares = {};
    for (const [aid, due] of Object.entries(dues)) home.shares[aid] = due / price;
    hh.weekly_rent = 0;
    hh.hardship_rent = null;
    _history(hh.history, { tick: now, time: stamp, event: "bought", home: home.id, name: home.name, price });
    _history(home.history, { tick: now, time: stamp, event: "bought", household: hh.id, price, off_market: true });
    _event(sim, `${who} ${_one(sim, hh) ? "buys" : "buy"} ${home.name} (${TIERS[home.tier].label}, `
      + `${district_name(sim, home)}) from ${LANDLORD} for $${commas(price)}.`, "home_bought", home.place, agent,
    _members(sim, hh).map(a => a.id));
    _landlord_sells(sim, Math.max(sale, now + NOTICE_MIN_DAYS * DAY));
    return true;
  }

  // The floor under a household deep in the red (PLAN 5.5): a cheaper rental (owners: any rental, after a
  // forced sale), else for owners a cheaper home the sale pays for, then both again with crowding relaxed to
  // FORCED_CROWDING a bedroom; else hardship rent for renters, and nowhere_to_go with tax deferral for owners.
  // Returns true when the household moved.
  function forced_move(sim, hh) {
    const cur = sim.homes.get(hh.home_id);
    const owner = cur.owner === hh.id;
    const how = owner ? "forced_sale" : "evicted";
    for (const per_bedroom of [2, FORCED_CROWDING]) {
      const rental = cheapest_rental(sim, hh, owner ? null : hh.weekly_rent, per_bedroom);
      if (rental) return move_household(sim, hh, rental.id, "rent", 1.0, null, how);
      if (owner) {
        const budget = sale_proceeds(sim, cur.id) + Math.max(0.0, funds(sim, hh));
        const pool = vacancies(sim, "for_sale")
          .filter(h => fits(sim, hh, h, per_bedroom) && value(sim, h.id) + MOVING_COST <= budget);
        if (pool.length) {
          const home = minBy(pool, h => [value(sim, h.id), -condition_of(sim, h.id), h.id]);
          return move_household(sim, hh, home.id, "buy", 1.0, null, how);
        }
      }
    }
    if (owner) {
      _event(sim, `${household_name(sim, hh)} ${_one(sim, hh) ? "is" : "are"} deep in debt and nowhere cheaper `
        + "is free.", "nowhere_to_go", cur.place, adults(sim, hh)[0] || null, _members(sim, hh).map(a => a.id));
      _defer_tax(sim, hh);
    } else {
      _set_hardship_rent(sim, hh);
    }
    return false;
  }

  function _set_hardship_rent(sim, hh) {
    const rent = hardship_rent(sim, hh);
    if (rent === hh.hardship_rent) return;
    hh.hardship_rent = rent;
    const home = sim.homes.get(hh.home_id);
    _event(sim, `${LANDLORD} lowers ${_hh_possessive(sim, hh)} rent to $${rent}/week until they are back on their feet.`,
      "hardship", home.place, adults(sim, hh)[0] || null, _members(sim, hh).map(a => a.id));
  }

  function _defer_tax(sim, hh) {
    if (hh.tax_deferred) return;
    hh.tax_deferred = true;
    const home = sim.homes.get(hh.home_id);
    _event(sim, `The council defers ${_hh_possessive(sim, hh)} property tax.`, "hardship", home.place,
      adults(sim, hh)[0] || null, _members(sim, hh).map(a => a.id));
  }

  // --- group B: the Sunday charges --------------------------------------------------------------

  // Sunday 23:00, for every household with a living adult (PLAN 5.3):
  //
  // 1. housing: rent (or hardship rent), or property tax for owners (none while deferred), split equally
  // 2. bills, each adult their own   3. adults below zero dip into their savings   4. the bills_paid event
  // 5. arrears (decision 58)   6. in_the_red / in_the_red_again   7. hardship rent and tax deferral end after
  // two clean Sundays   8. the floor at arrears >= 3: a forced move, hardship rent or tax deferral, and
  // belt-tightening   9. the home's weekly effect on its residents' reputation.
  function weekly_charges(sim) {
    const { BILLS_PER_ADULT, CAR_BILL } = G.sim;
    const now = sim.clock.tick;
    for (const hh of sim.households.values()) {
      const payers = adults(sim, hh);
      if (!payers.length) continue;
      const home = sim.homes.get(hh.home_id);
      const owned = home.owner === hh.id;
      const who = household_name(sim, hh);
      const one = _one(sim, hh);
      // 1-3. Housing, bills, then savings cover any shortfall.
      const charge = weekly_cost(sim, hh);
      let paid_bills = 0.0;
      for (const a of payers) {
        const bill = BILLS_PER_ADULT + (a.owns_car ? CAR_BILL : 0.0);
        a.money -= charge / payers.length + bill;
        paid_bills += bill;
      }
      for (const a of payers) {
        if (a.money < 0 && 0 < a.savings) {
          const move = Math.min(a.savings, -a.money);
          a.savings -= move;
          a.money += move;
        }
      }
      // 4. The receipt.
      let what, tail;
      if (owned) {
        what = !hh.tax_deferred ? `$${charge} property tax and ` : "";
        tail = hh.tax_deferred ? " (property tax deferred)" : "";
      } else {
        what = `$${charge} rent${hh.hardship_rent !== null ? " (hardship rate)" : ""} and `;
        tail = "";
      }
      _event(sim, `${who} paid ${what}$${fmt(paid_bills)} in bills${tail}.`, "bills_paid", home.place, null,
        payers.map(a => a.id));
      // 5. Arrears count the weeks in the red that show no recovery.
      const f = funds(sim, hh);
      let went_up = false;
      if (f >= 0) {
        hh.arrears = 0;
        hh.clean_sundays += 1;
      } else {
        hh.clean_sundays = 0;
        if (hh.grace_until > now) {
          // a granted grace holds arrears
        } else if (hh.arrears > 0 && hh.last_funds !== null && f >= hh.last_funds + ARREARS_PROGRESS) {
          // paying it down holds arrears
        } else {
          hh.arrears += 1;
          went_up = true;
        }
      }
      hh.last_funds = f;
      // 6. The news: in_the_red at arrears 1, in_the_red_again each time arrears climbs past it. A red week that
      // holds (grace, or paying it down) at 0 or 2+ is quiet.
      if (f < 0 && (hh.arrears === 1 || (hh.arrears >= 2 && went_up))) {
        const worst = minBy(payers, a => a.money);
        const ids = payers.map(a => a.id);
        const red = `${who} ${one ? "is" : "are"} $${fmtc(-f)} in the red`;
        if (hh.arrears >= 2) {
          const warning = owned ? "The bank warns them: pay up or sell." : `${LANDLORD} sends a final warning.`;
          const nth = hh.arrears <= ORDINALS.length ? ORDINALS[hh.arrears - 1] : `${hh.arrears}th`;
          _event(sim, `${red} for a ${nth} week. ${warning}`, "in_the_red_again", home.place, worst, ids);
        } else {
          _event(sim, `${red} after the week's bills.`, "in_the_red", home.place, worst, ids);
        }
      }
      // 7. Back on their feet.
      if (hh.clean_sundays >= 2) {
        hh.hardship_rent = null;
        hh.tax_deferred = false;
      }
      // 8. The floor.
      if (hh.arrears >= 3) {
        if (f < -2 * weekly_outgo(sim, hh)) forced_move(sim, hh);
        else if (!owned && cheapest_rental(sim, hh, hh.weekly_rent) === null) _set_hardship_rent(sim, hh);
        else if (owned) _defer_tax(sim, hh);
        hh.tight_until = Math.max(hh.tight_until, now + 8 * DAY);
      }
    }
    // 9. What the neighbours think of the place.
    for (const hh of sim.households.values()) {
      const home = sim.homes.get(hh.home_id);
      if (home.household !== hh.id) continue;
      const st = stage_of(condition_of(sim, home.id));
      let delta = STAGE_REPUTATION[st];
      if (st === 0 && home.tier === "big_house" && home.owner === hh.id) delta = KEPT_BIG_HOUSE_PRIDE;
      if (delta) {
        for (const a of _members(sim, hh)) a.reputation = Math.max(0.0, Math.min(100.0, a.reputation + delta));
      }
    }
  }

  // --- group B: condition, stages and emergencies ----------------------------------------------

  // Announce a newly reached shabby, neglected or derelict stage, or a return to kept, for an owner-occupied
  // home (housing.md 7.2). `lot.reported` is the worst stage announced, so a home bouncing between two of the
  // poor stages is announced once; it resets when the lot gets back to stage 0-1. "Looks as good as new" comes
  // when a home that had reached stage 2+ (`lot.worst`) climbs back to stage 0. Rentals and vacant homes are
  // silent. So is a home whose household moved in less than NEWS_SETTLE_DAYS ago: a poor stage it reaches then
  // is announced only if it is still there afterwards (it stays unreported), so a fixer-upper renovated on its
  // first evening never makes the news as falling apart.
  function _stage_news(sim, lot) {
    const st = stage_of(lot.condition);
    const homes = lot_homes(sim, lot.place);
    const home = homes.length === 1 && owner_occupied(homes[0]) ? homes[0] : null;
    lot.worst = Math.max(lot.worst, st);
    if (st <= 1) {
      if (st === 0) {
        if (home && lot.worst >= 2) {
          _event(sim, `${home.name} looks as good as new.`, "restored", lot.place, null,
            _members(sim, sim.households.get(home.household)).map(a => a.id));
        }
        lot.worst = 0;
      }
      lot.reported = st;
    } else if (st > lot.reported) {
      if (home && _just_moved_in(sim, sim.households.get(home.household))) return; // not news yet
      if (home && STAGE_NEWS[st]) {
        const [tag, text] = STAGE_NEWS[st];
        _event(sim, _home(text, home.name), tag, lot.place, null,
          _members(sim, sim.households.get(home.household)).map(a => a.id));
      }
      lot.reported = st;
    }
  }

  // The household moved into its home less than NEWS_SETTLE_DAYS ago.
  const _just_moved_in = (sim, hh) => hh.moved_tick !== null && sim.clock.tick - hh.moved_tick < NEWS_SETTLE_DAYS * DAY;

  function _change_condition(sim, lot, delta) {
    lot.condition = Math.max(0.0, Math.min(100.0, lot.condition + delta));
    _stage_news(sim, lot);
  }

  // One night of wear on a building, then the landlord's repairs and the market floor.
  function _decay(sim, lot, homes, winter) {
    const tier = homes[0].tier;
    const season = winter ? WINTER_DECAY : 1.0;
    const lived_in = homes.filter(h => h.household);
    let rate;
    if (tier === "flat") { // a block wears at the flat rate whether or not its flats are let
      rate = TIERS.flat.decay * season;
    } else if (lived_in.length) {
      const hh = sim.households.get(lived_in[0].household);
      rate = TIERS[tier].decay * season * (1 + CROWD_DECAY * Math.max(0, residents(sim, hh) - 2));
      if (lived_in[0].emergency) rate += EMERGENCY_DECAY;
    } else {
      rate = VACANT_DECAY;
    }
    const before = lot.condition;
    lot.condition = Math.max(0.0, before - rate);
    if (!lived_in.length && homes.every(h => h.owner === "market")) {
      lot.condition = Math.max(lot.condition, Math.min(before, MARKET_FLOOR)); // a home for sale never drops below neglected
    }
    const floor = getd(LANDLORD_FLOOR, tier, null);
    if (floor !== null && homes.every(h => h.owner === "landlord") && lot.condition < floor) {
      lot.condition = LANDLORD_RESTORE;
      lot.works_until = sim.clock.tick + LANDLORD_WORKS_MINUTES;
      if (lived_in.length) _event(sim, `${LANDLORD} repaints ${sim.town.places.get(lot.place).name}.`, "repaint", lot.place);
    }
    _stage_news(sim, lot);
  }

  // Midnight: every building wears; residents of neglected homes lose health and may catch a chill; every
  // owner-occupied home without an emergency rolls for one, which stays hidden until it goes live.
  function nightly(sim) {
    const { luck_odds } = G.forks;
    const winter = sim.clock.season === "winter";
    for (const lot of sim.lots.values()) _decay(sim, lot, lot_homes(sim, lot.place), winter);
    for (const home of sim.homes.values()) {
      if (!home.household) continue;
      const hh = sim.households.get(home.household);
      const st = stage_of(condition_of(sim, home.id));
      if (DAMP_HEALTH[st] !== undefined) {
        for (const a of _members(sim, hh)) {
          a.health = Math.max(0.0, a.health - DAMP_HEALTH[st] * (winter ? 2 : 1));
          const p0 = DAMP_CHILL[st] * (winter ? 2 : 1);
          const p = luck_odds(p0, -1, a.luck);
          const roll = sim.rng.random();
          sim._log_roll(a, "damp_chill", p, roll, p0);
          if (roll < p) {
            a.health = Math.max(0.0, a.health + CHILL.health);
            a.adjust("fun", CHILL.fun);
            sim.event(`${a.name} catches a chill in the damp house.`, a, null, { tag: "damp_chill", place: home.place });
          }
        }
      }
      const payers = adults(sim, hh);
      if (home.owner !== hh.id || home.emergency || home.pending_emergency || !payers.length) continue;
      const p0 = (TIERS[home.tier].emergency_p + getd(EMERGENCY_STAGE_P, st, 0.0)) * (winter ? WINTER_EMERGENCY : 1);
      const p = luck_odds(p0, -1, sum(payers.map(a => a.luck)) / payers.length);
      const roll = sim.rng.random();
      sim._log_roll(payers[0], "home_emergency", p, roll, p0);
      if (roll < p) {
        const kinds = ["leak", "electrics", "boiler"].concat(winter ? ["boiler", "boiler"] : [],
          sim.weather === "rain" ? ["roof"] : []);
        const kind = sim.rng.choice(kinds);
        home.pending_emergency = { kind, due: sim.clock.tick + sim.rng.randrange(7 * 60, 21 * 60) };
      }
    }
  }

  // Every tick, before the agents: a pending emergency whose time has come goes live, and one left unfixed
  // for EMERGENCY_DAYS settles as lost condition; at NOTICE_HOUR, the landlord's notices (`landlord_notices`).
  function tick(sim) {
    const now = sim.clock.tick;
    if (sim.clock.minute_of_day === NOTICE_HOUR * 60) landlord_notices(sim);
    for (const home of sim.homes.values()) {
      const pending = home.pending_emergency;
      if (pending && pending.due <= now) {
        home.pending_emergency = null;
        if (owner_occupied(home)) {
          home.emergency = { kind: pending.kind, since: now };
          const hh = sim.households.get(home.household);
          _event(sim, _home(EMERGENCY_NEWS[pending.kind], home.name), "emergency", home.place, null,
            _members(sim, hh).map(a => a.id));
        }
      }
      const live = home.emergency;
      if (live && now - live.since >= EMERGENCY_DAYS * DAY) {
        home.emergency = null;
        _event(sim, `The ${EMERGENCY_NAME[live.kind]} at ${home.name} is never properly fixed.`,
          "emergency_settled", home.place);
        _change_condition(sim, sim.lots.get(home.place), -SETTLE_DAMAGE);
      }
    }
  }

  function fix_emergency(sim, hh, agent = null) {
    const home = sim.homes.get(hh.home_id);
    const live = home.emergency;
    if (!live) return;
    home.emergency = null;
    _event(sim, `The ${EMERGENCY_NAME[live.kind]} at ${home.name} is fixed.`, "emergency_settled", home.place, agent);
  }

  // After a death and the household update: a household with nobody left alive is emptied
  // (`on_household_empty`). Children left on their own keep the home.
  function on_death(sim, agent) {
    const hh = _life_household(sim, agent.household_id);
    if (hh === null || _members(sim, hh).length) return;
    on_household_empty(sim, hh, agent);
  }

  // --- group B: fork extras and outcome effects ------------------------------------------------

  // The home an option was about has gone: the decider goes home instead. _decide starts the option's own
  // steps once the extras are done (PLAN 3.11), so those are what must change; the plan is set too for a caller
  // that doesn't. None of what the option promised happens.
  function _call_off(agent, opt) {
    opt.steps = [["idle", "home"]];
    agent.plan = [["idle", "home"]];
    opt.outcomes = [];
  }

  // The housing extras of a chosen option, at decision time (PLAN 3.11): move (with what comes only if the move
  // goes through: settle, household cooldowns {key: minutes}, and renovate, the price of doing up the home
  // bought), buy_let (tenants under notice buy the house they rent), hold, repair, works, fix_emergency, hh_cooldown,
  // belt_tighten, sell_car, sell_stuff, ask_help and odd_jobs.
  function apply_extra(sim, agent, fork, opt) {
    const extra = (opt && opt.extra) || {};
    if (!Object.keys(extra).length) return;
    const hh = sim.households.get(agent.household_id);
    const now = sim.clock.tick;
    if ("hh_cooldown" in extra && fork !== null) hh.cooldowns[fork.kind] = now + extra.hh_cooldown;
    if ("move" in extra) {
      const how = getd(extra, "how", "buy");
      const down = how === "rent" && fork !== null && fork.kind === "housing_trouble";
      if (move_household(sim, hh, extra.move, how, 1.0, agent, null, false, !down)) {
        for (const [key, minutes] of Object.entries(extra.settle || {})) hh.cooldowns[key] = now + minutes;
        if (extra.renovate) renovate(sim, hh, extra.renovate);
      } else {
        _call_off(agent, opt); // nothing to move into
      }
    }
    if ("buy_let" in extra && !buy_let_home(sim, hh, agent)) _call_off(agent, opt);
    if ("hold" in extra) { // an offer: nobody else takes the home while the seller thinks it over
      const home = sim.homes.get(extra.hold);
      if (available(sim, hh, home)) {
        hold(sim, home, hh, OFFER_HOLD_MINUTES);
      } else {
        too_late(sim, hh, home, agent);
        _call_off(agent, opt);
      }
    }
    const lot = sim.lots.get(sim.homes.get(hh.home_id).place);
    if ("repair" in extra) _change_condition(sim, lot, extra.repair);
    if ("works" in extra) lot.works_until = Math.max(lot.works_until, now + extra.works);
    if (extra.fix_emergency) fix_emergency(sim, hh, agent);
    if ("belt_tighten" in extra) hh.tight_until = Math.max(hh.tight_until, now + extra.belt_tighten);
    if (extra.sell_car) {
      const seller = [agent].concat(adults(sim, hh)).find(a => a.owns_car) || null;
      if (seller) {
        seller.owns_car = false;
        seller.savings += CAR_SALE;
        sim.event(`${seller.name} sells the car for $${commas(CAR_SALE)}.`, seller, null, { tag: "car_sold" });
      }
    }
    if ("sell_stuff" in extra) {
      agent.money += extra.sell_stuff;
      hh.cooldowns.sell_stuff = now + STUFF_DAYS * DAY;
      _event(sim, `${household_name(sim, hh)} ${_one(sim, hh) ? "sells" : "sell"} some furniture for `
        + `$${commas(extra.sell_stuff)}.`, "stuff_sold", sim.homes.get(hh.home_id).place, agent);
    }
    if ("ask_help" in extra) {
      const friend = sim.agents.get(extra.ask_help);
      if (friend && friend.alive && sim._interruptible(friend)) {
        sim.start_plan(friend, [["help_out", sim.homes.get(hh.home_id).place]]);
      }
    }
    if (extra.odd_jobs) hh.cooldowns.odd_jobs = now + ODD_JOBS_DAYS * DAY;
  }

  // An effect's companion value (a deal's "factor" and "renovate", a gift's "amount") comes before its main key
  // ("buy", "gift_from") in the effects dict; the main key takes it from here. Kept on the agent, between keys only.
  const COMPANIONS = ["factor", "amount", "renovate"];

  function _take(agent, key, dflt) {
    const held = agent.effect_args || {};
    const out = key in held ? held[key] : dflt;
    delete held[key];
    agent.effect_args = held;
    return out;
  }

  // Apply a housing outcome effect for the agent's household; true when `key` was a housing one.
  function apply_effect(sim, agent, key, val) {
    const hh = sim.households.get(agent.household_id);
    const now = sim.clock.tick;
    if (COMPANIONS.includes(key)) {
      const held = agent.effect_args || {};
      held[key] = val;
      agent.effect_args = held;
    } else if (key === "home_condition") {
      _change_condition(sim, sim.lots.get(sim.homes.get(hh.home_id).place), val);
    } else if (key === "hh_money") {
      pay_household(sim, hh, -val);
    } else if (key === "buy") {
      const home = sim.homes.get(val);
      const factor = _take(agent, "factor", 1.0), cost = _take(agent, "renovate", 0);
      if (move_household(sim, hh, val, buys(home) ? "buy" : "rent", factor, agent) && cost) renovate(sim, hh, cost);
    } else if (key === "withdraw") {
      hold(sim, sim.homes.get(val), null, UNDER_OFFER_DAYS * DAY);
    } else if (key === "release") {
      if (sim.homes.get(val).held_for === hh.id) release(sim.homes.get(val));
    } else if (key === "gift_from") {
      const giver = sim.agents.get(val);
      const amount = Math.min(_take(agent, "amount", 0), Math.max(0.0, giver.money + giver.savings));
      if (amount > 0) {
        const take = Math.min(Math.max(giver.savings, 0.0), amount);
        giver.savings -= take;
        giver.money -= amount - take;
        agent.money += amount;
        sim.event(`${giver.name} gives ${agent.name} $${fmtc(amount)} to help with the bills.`, agent, null,
          { tag: "help_given", agents: [agent.id, giver.id] });
      }
    } else if (key === "meet_neighbour") {
      const district = sim.town.places.get(sim.homes.get(hh.home_id).place).district;
      const pool = Array.from(sim.agents.values()).filter(a => a.alive && a.id !== agent.id
        && !agent.relationships.has(a.id) && a.is_adult === agent.is_adult
        && sim.town.places.get(sim.homes.get(sim.households.get(a.household_id).home_id).place).district === district);
      if (pool.length) sim._meet_someone(agent, pool);
      else sim._meet_someone(agent);
    } else if (key === "fix_emergency") {
      if (val) fix_emergency(sim, hh, agent);
    } else if (key === "grace") {
      hh.grace_until = Math.max(hh.grace_until, now + val * DAY);
      hh.cooldowns.grace = now + GRACE_DAYS * DAY;
    } else {
      return false;
    }
    return true;
  }

  // --- group B: comfort and the money term of default scores ------------------------------------

  // Multiplier on the positive gains of activities at the agent's own home: the home's comfort.
  function activity_gain_scale(sim, agent) {
    const hh = sim.households.get(agent.household_id);
    if (agent.activity_place !== sim.homes.get(hh.home_id).place) return 1.0;
    return comfort(sim, hh);
  }

  // The money term of default_scores (housing.md 10.3).
  //
  // Free options score 0. A household-paid cost is weighed against the household's spare funds (funds less two
  // weeks of outgo): -1.5 above spare, else -thrift x (cost / spare)^2. Any other cost is weighed against what
  // the character can pay it with: their own money and savings, else the household's spare funds (the pool the
  // Sunday charges draw on; a child's costs fall to an adult), as -thrift x cost / max(that, 50), and -2 when
  // neither covers it. A cost not charged on deciding (the work fork's bus, whose fare is paid on boarding) is
  // never out of reach: then it is -thrift x cost / 50. Thrift counts triple while the household is
  // belt-tightening.
  function afford_score(sim, agent, opt) {
    const cost = opt.cost;
    if (cost <= 0) return 0.0;
    const hh = sim.households.get(agent.household_id);
    const thrift = agent.profile.traits.thrift * (hh.tight_until > sim.clock.tick ? 3 : 1);
    if (opt.household_pays) {
      const spare = funds(sim, hh) - 2 * weekly_outgo(sim, hh);
      return cost > spare ? -1.5 : -thrift * (cost / spare) ** 2;
    }
    const own = agent.money + agent.savings;
    if (cost <= own) return -cost / Math.max(own, 50) * thrift;
    const spare = funds(sim, hh) - 2 * weekly_outgo(sim, hh);
    if (cost <= spare) return -cost / Math.max(spare, 50) * thrift;
    if (!(opt.charge ?? true)) return -cost / 50 * thrift;
    return -2.0;
  }

  G.housing = {
    TIERS, STAGES, STAGE_COMFORT, LANDLORD, LANDLORD_FLOOR, LANDLORD_RESTORE, VACANT_DECAY, MARKET_FLOOR,
    NEWS_SETTLE_DAYS, LANDLORD_SELLS_DAYS, NOTICE_FROM_DAY, NOTICE_DAYS, NOTICE_GAP_DAYS, NOTICE_SETTLED_DAYS,
    NOTICE_MIN_DAYS, NOTICE_HOUR, WINTER_DECAY, CROWD_DECAY, EMERGENCY_DECAY, PROPERTY_TAX, SALE_FEE, MOVING_COST,
    CALLOUT, RENO_FACTOR, RESERVE_WEEKS, MOVE_GAP_DAYS, DOWNSIZE_SHARE, DOWNSIZE_CONDITION, SPARE_BEDROOMS, CAR_SALE,
    EMERGENCY_DAYS, LIVING_PER_PERSON, LIVING_PER_RETIREE, ARREARS_PROGRESS, HARDSHIP_REPAY, FORCED_CROWDING,
    STUFF_DAYS, GRACE_DAYS, GRACE_HOLD_DAYS, ODD_JOBS_DAYS, ODD_JOBS_PAY, STUFF_PRICE, EMERGENCY_KINDS,
    EMERGENCY_TEXT, DAY, MOVE_VAN_MINUTES, LANDLORD_WORKS_MINUTES, RENOVATE_WORKS_MINUTES, UNDER_OFFER_DAYS,
    OFFER_HOLD_MINUTES, SETTLE_DAMAGE, EMERGENCY_STAGE_P, WINTER_EMERGENCY, DAMP_HEALTH, DAMP_CHILL, CHILL,
    STAGE_REPUTATION, KEPT_BIG_HOUSE_PRIDE, STAGE_NEWS, EMERGENCY_NEWS, EMERGENCY_NAME, ORDINALS, HOME_SPECS,
    LOT_CONDITION, START_OWNER, START_LISTING, ACTIVITIES_EXTRA, Home, Lot, build_homes, build_lots, init, _int,
    round50, stamp_of, stage_of, stage_name, condition_of, value, sale_proceeds, property_tax, listed, hold, release,
    adults, residents, crowded, funds, tenure, weekly_cost, comfort, home_shares, worth_parts, net_worth,
    household_name, household_summary, pay_household, round10, retired, weekly_income, bills, living, commute, buys,
    housing_cost, weekly_outgo, fits, reno_cost, net_cost, affordable, is_upgrade, vacancies, hunt_candidates,
    outgrown, downsize_candidates, house_drought, cheapest_rental, under_notice, can_buy_let_home, notice_home,
    owner_occupied, lot_homes, hardship_rent, _one, _hh_lower, _hh_possessive, district_name, town_homes_json,
    town_housing_json, lots_json, homes_json, possessions_json, fork_you, agent_page_fields, market_json, home_page,
    _members, available, too_late, move_household, renovate, give_notice, landlord_notices, _landlord_sells,
    buy_let_home, forced_move, weekly_charges, _stage_news, _just_moved_in, _change_condition, nightly, tick,
    fix_emergency, on_death, apply_extra, COMPANIONS, apply_effect, activity_gain_scale, afford_score,
  };

  // --- life: households ---
  // life.js's (L2) household changes: a new household for a named who leaves one (a split, moving out), and an
  // emptied household's home going back on the market or to the landlord. Townsfolk ids dispatch to the folk first.

  // The household `hid` of either tier (`sim.household_by_id`, else v2's `sim.households`).
  function _life_household(sim, hid) {
    if (typeof sim.household_by_id === "function") return sim.household_by_id(hid) ?? null;
    return sim.households.get(hid) ?? null;
  }

  // Move `members` (people of one tier, the first the head) out of their households into the vacant home
  // `home_id`, as a new household; `how` is "rent" or "buy". Folk go to `sim.folk.new_household`. null when the
  // home is not vacant.
  function new_household(sim, members, home_id, how) {
    if (!members.length) return null;
    if (!sim.agents.has(members[0].id)) return sim.folk.new_household(sim, members, home_id, how);
    const home = sim.homes.get(home_id);
    if (home === undefined || home.household !== null) return null;
    const base = G.py.lastName(members[0].name).toLowerCase();
    let hid = base, n = 2;
    while (sim.households.has(hid)) { hid = `${base}_${n}`; n += 1; }
    const hh = new G.agent.Household(hid, home_id, how === "rent" ? home.rent : 0.0);
    sim.households.set(hid, hh);
    for (const a of members) {
      const old = sim.households.get(a.household_id);
      if (old !== undefined && old.member_ids.includes(a.id)) old.member_ids.splice(old.member_ids.indexOf(a.id), 1);
      a.household_id = hid;
      hh.member_ids.push(a.id);
    }
    const now = sim.clock.tick, stamp = sim.clock.stamp();
    home.household = hid;
    if (how === "buy") home.owner = hid;
    release(home);
    home.listing = null;
    hh.moved_tick = now;
    _history(home.history, { tick: now, time: stamp, event: "moved_in", household: hid, price: null });
    _history(hh.history, { tick: now, time: stamp, event: "moved_in", home: home.id, name: home.name, price: null });
    return hh;
  }

  // A household with nobody left alive: its home goes back on the market (an estate sale; nobody inherits) or
  // back to the landlord. `agent` is the last to die, if a death emptied it. Folk households go to the folk.
  function on_household_empty(sim, hh, agent = null) {
    if (!sim.households.has(hh.id)) { sim.folk.on_household_empty(hh); return; }
    const home = sim.homes.get(hh.home_id);
    if (home.household !== hh.id) return;
    const now = sim.clock.tick, stamp = sim.clock.stamp();
    home.household = null;
    home.pending_emergency = null;
    home.emergency = null;
    release(home);
    _history(home.history, { tick: now, time: stamp, event: "left", household: hh.id, price: null });
    _history(hh.history, { tick: now, time: stamp, event: "left", home: home.id, name: home.name, price: null });
    if (home.owner === hh.id) {
      home.owner = "market";
      home.listing = "for_sale";
      home.shares = {};
      if (agent !== null) {
        _event(sim, `${home.name} goes on the market after ${agent.name}'s death.`, "home_listed", home.place, null,
          [agent.id]);
      } else {
        _event(sim, `${home.name} goes on the market.`, "home_listed", home.place);
      }
    } else {
      home.listing = home.notice !== null ? null : "for_rent"; // a notice's sale goes ahead when it runs out
    }
  }

  Object.assign(G.housing, { _life_household, new_household, on_household_empty });
  // --- end life: households ---
})(globalThis.GameOfAILife || (globalThis.GameOfAILife = {}));

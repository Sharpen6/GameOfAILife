// Port of gameofailife/cast.py: the 60 people of Millbrook: the 20 named characters and 40 more generated from
// the seed.
//
// The named 20 and the homes everyone starts in are the same for every seed; the seed picks the generated
// people's names, ages, money, savings, cars, jobs, traits and goals. The draws come from one mulberry32 stream
// in the same fixed order as the Python module (see `build_cast`), so both ports build the same cast; seed 1 is
// canonical Millbrook, pinned by tests/fixtures/city_seed1.json (port/tools/parity.js golden checks it).
(function (G) {
  "use strict";
  const { getd, cmp, sortedBy, firstName, pyRound, PyError } = G.py;
  const { Agent, Household, Job, Profile, RelationKind } = G.agent;
  const { Rng, r2, mix } = G.rng;

  const CAST_SIZE = 60;
  const START_ENERGY = 85; // the city starts at 05:00, just after waking: energy 85-100 (the drawn 60-90 halved onto it)

  const job = (title, place, wage, start, end, days = [0, 1, 2, 3, 4]) => new Job(title, place, wage, start, end, days.slice());

  const NAMED = [
    // id, name, age, household, money, job, owns car
    ["dana", "Dana Cohen", 38, "cohen", 900, () => job("software engineer", "office", 55, 9, 17), true],
    ["yossi", "Yossi Cohen", 40, "cohen", 600, () => job("nurse", "hospital", 38, 7, 15, [0, 1, 2, 3, 6]), false],
    ["noa", "Noa Cohen", 10, "cohen", 20, () => job("student", "school", 0, 8, 14), false],
    ["miriam", "Miriam Levi", 67, "levi", 1500, () => null, false],
    ["tom", "Tom Levi", 29, "levi", 250, () => job("barista", "cafe", 18, 7, 14, [1, 2, 3, 4, 5]), false],
    ["ari", "Ari Ben-David", 24, "bendavid", 412, () => job("junior developer", "office", 32, 10, 18), false],
    ["avi", "Avi Mizrahi", 45, "mizrahi", 700, () => job("teacher", "school", 30, 8, 15), true],
    ["rina", "Rina Mizrahi", 43, "mizrahi", 1100, () => job("doctor", "hospital", 70, 8, 16), false],
    ["lior", "Lior Mizrahi", 16, "mizrahi", 60, () => job("student", "school", 0, 8, 15), false],
    ["maya", "Maya Mizrahi", 8, "mizrahi", 10, () => job("student", "school", 0, 8, 13), false],
    ["eli", "Eli Peretz", 33, "peretz", 300, () => job("cashier", "grocer", 17, 8, 16, [0, 1, 2, 4, 5]), false],
    ["shira", "Shira Peretz", 31, "peretz", 450, () => job("nurse", "hospital", 38, 14, 22), false],
    ["ruth", "Ruth Friedman", 72, "friedman", 2200, () => null, false],
    ["david", "David Friedman", 74, "friedman", 1800, () => null, true],
    ["omer", "Omer Katz", 36, "katz", 1300, () => job("product manager", "office", 60, 9, 18), true],
    ["gal", "Gal Katz", 35, "katz", 800, () => job("graphic designer", "office", 40, 10, 16), false],
    ["yael", "Yael Katz", 6, "katz", 5, () => job("student", "school", 0, 8, 13), false],
    ["nadia", "Nadia Haddad", 41, "haddad", 950, () => job("store manager", "market", 28, 7, 15, [0, 1, 2, 3, 4, 5]), false],
    ["sami", "Sami Haddad", 44, "haddad", 400, () => job("chef", "cafe", 24, 11, 20, [0, 2, 3, 4, 5]), false],
    ["leila", "Leila Haddad", 12, "haddad", 25, () => job("student", "school", 0, 8, 14), false],
  ];
  // (Python builds each named Job once at import and every cast shares it; a JS cast gets fresh ones, since jobs
  // are swapped and changed in play and nothing else may be shared between cities.)

  // Named household -> home id. Tenure follows the home's start: let (rent) or owned.
  const NAMED_HOMES = { cohen: "main_20", levi: "main_28", bendavid: "birch_court_2b", mizrahi: "main_13",
    peretz: "cedar_court_1b", friedman: "park_78", katz: "park_21", haddad: "main_21" };

  const SAVINGS = { dana: 15000, yossi: 5000, miriam: 2000, tom: 0, ari: 2500, avi: 2500, rina: 19000,
    eli: 0, shira: 1500, ruth: 4000, david: 2000, omer: 5000, gal: 1500, nadia: 3000,
    sami: 500 }; // named adults' starting savings; children have none

  const FRIENDS = [["tom", "ari", 55], ["dana", "ari", 30], ["yossi", "miriam", 40], ["rina", "shira", 50],
    ["gal", "dana", 45], ["omer", "avi", 35], ["noa", "leila", 60], ["maya", "yael", 50],
    ["lior", "tom", 25], ["ruth", "miriam", 65], ["sami", "eli", 40], ["nadia", "rina", 30]];

  const GOALS = { ari: ["a new phone", 300], tom: ["a guitar", 450], lior: ["a bike", 200],
    eli: ["a weekend trip", 600], gal: ["a drawing tablet", 350] };

  const GOAL_POOL = [["a new laptop", 500], ["a holiday", 800], ["a sofa", 400], ["driving lessons", 600],
    ["a bike", 250], ["a camera", 450], ["a games console", 350], ["a new coat", 200]];

  const SLOTS = { // job slots for the generated workers, by wage band: [title, place, wage, start, end(, workdays)]
    low: [
      ["barista", "cafe", 18, 14, 22, [2, 3, 4, 5, 6]],
      ["counter assistant", "bakery", 16, 7, 14, [3, 4, 5, 6, 0]],
      ["waiter", "noodles", 16, 16, 23, [1, 2, 3, 4, 5]],
      ["cashier", "grocer", 16, 14, 22],
      ["cashier", "market", 17, 13, 21, [1, 2, 3, 4, 5]],
      ["shop assistant", "arcade", 17, 9, 17],
      ["shop assistant", "arcade", 17, 13, 21, [2, 3, 4, 5, 6]],
      ["hospital cleaner", "hospital", 16, 6, 14],
      ["warehouse worker", "works", 21, 6, 14],
      ["warehouse worker", "works", 21, 14, 22],
      ["packer", "works", 18, 8, 16],
      ["park keeper", "green", 19, 7, 15],
      ["receptionist", "office", 20, 8, 16],
    ],
    mid: [
      ["cook", "noodles", 22, 15, 23, [1, 2, 3, 4, 5]],
      ["shopkeeper", "grocer", 24, 7, 15, [0, 1, 2, 3, 4, 5]],
      ["baker", "bakery", 22, 6, 14, [0, 1, 2, 3, 4, 5]],
      ["foreman", "works", 32, 7, 15],
      ["teacher", "school", 30, 8, 15],
      ["teacher", "school", 30, 8, 15],
      ["nurse", "hospital", 38, 7, 15],
      ["paramedic", "hospital", 30, 10, 18, [5, 6, 0, 1, 2]],
      ["clerk", "cityhall", 26, 8, 16],
      ["bank teller", "bank", 24, 9, 17],
      ["data analyst", "office", 42, 9, 17],
    ],
    high: [
      ["surgeon", "hospital", 85, 8, 16, [0, 1, 2, 3]],
      ["branch manager", "bank", 55, 9, 17],
    ],
  };

  const TEMPLATES = [ // generated households, in draw order: [home id, roles]; adults are wage bands or "retired"
    ["birch_court_1a", ["retired"]], ["birch_court_1b", ["low", "low"]], ["birch_court_2a", ["low", "kid"]],
    ["birch_court_3a", ["low"]], ["birch_court_3b", ["mid"]], ["cedar_court_1a", ["low", "low"]],
    ["cedar_court_2a", ["low", "mid", "kid"]], ["cedar_court_2b", ["mid", "kid"]], ["cedar_court_3a", ["low"]],
    ["elm_court_1b", ["low"]], ["elm_court_2a", ["mid"]], ["elm_court_3b", ["low", "low", "kid"]],
    ["park_13", ["mid", "mid", "kid"]], ["park_29", ["mid", "low", "kid"]], ["main_12", ["retired", "retired"]],
    ["main_29", ["mid", "mid"]], ["river_20", ["mid", "kid", "kid"]], ["main_47", ["low", "mid", "retired"]],
    ["park_92", ["high", "high", "kid", "kid"]],
  ];

  const SURNAMES = ["Avraham", "Biton", "Dahan", "Golan", "Shapiro", "Azoulay", "Amar", "Ohana", "Weiss", "Rosen",
    "Klein", "Barak", "Sasson", "Nassar", "Khoury", "Mansour", "Elbaz", "Tal", "Carmel", "Navon",
    "Segal", "Halabi", "Ezra", "Gold"];
  const FEMALE = ["Adi", "Tamar", "Noga", "Hila", "Michal", "Yarden", "Shani", "Ronit", "Dalia", "Orly", "Sara", "Hana",
    "Rana", "Amira", "Lina", "Talia", "Inbal", "Keren", "Liat", "Efrat", "Mor", "Neta", "Yasmin", "Rotem",
    "Avigail", "Merav", "Sivan", "Galit", "Dina", "Lea"];
  const MALE = ["Itai", "Yoni", "Amir", "Nir", "Guy", "Ido", "Roee", "Eitan", "Uri", "Moshe", "Rami", "Karim", "Fadi",
    "Omar", "Ziv", "Erez", "Boaz", "Ronen", "Shai", "Gil", "Asaf", "Dror", "Yuval", "Noam", "Tomer",
    "Hadi", "Elad", "Yaniv", "Oren", "Ben"];

  const CAR_ODDS = { flat: 0.15, house: 0.5, big_house: 1.0 }; // a generated worker's chance of a car, by home tier
  const RETIREE_CAR = 0.4; // a generated retiree outside a flat
  const MONEY = { low: [100, 400], mid: [300, 1200], high: [1500, 4000], retired: [800, 3000], kid: [0, 40] };
  const SAVINGS_RANGE = { low: [0, 800], mid: [500, 4000], high: [8000, 20000], retired: [1000, 6000] };
  const GOAL_CHANCE = 0.35; // a generated adult under 60 is saving for something

  const _student_job = age => job("student", "school", 0, 8, age < 9 ? 13 : age < 13 ? 14 : 15);

  function check(ok, what) {
    if (!ok) throw new PyError("AssertionError", String(what));
  }

  // [agents Map, households Map] for a seed. Reads `homes` (it never changes them); `housing.init` moves everyone
  // in. Everybody starts inside their home, at its entry.
  //
  // Draw order (the same draws in the same order as the Python module), all from Rng(seed * 7919 + 1):
  //   1. Named people in NAMED order: 6 traits uniform(0.2, 0.8) in Profile.TRAITS order, then 4 needs
  //      uniform(60, 90) in NEEDS order.
  //   2. shuffle(SURNAMES).
  //   3. Generated households in TEMPLATES order: base age, adult ages, kid ages, first_female; then each member
  //      (adults, then kids): gender (members 2+), first name, money, savings (adults), car, traits, needs.
  //   4. Jobs: one jitter int(0, 8) per (worker, band, slot), then greedy matching and a swap pass (no draws).
  //   5. Relationships: coworkers int(15, 35), classmates int(30, 60), then a friend for every generated adult
  //      who has none: pick, then int(30, 60).
  //   6. Goals: random() < 0.35 for each generated adult under 60, then a pick from GOAL_POOL.
  function build_cast(town, homes, seed) {
    const rng = new Rng(mix(seed, 7919, 1));
    const agents = new Map();
    const households = new Map();

    function new_household(hid, home_id) {
      const home = homes.get(home_id);
      check(home.start === "let" || home.start === "owned", [hid, home_id, home.start]);
      households.set(hid, new Household(hid, home_id, home.start === "let" ? home.rent : 0.0));
    }

    function make(aid, name, age, hid, money, savings, jb, car) {
      const place = town.places.get(homes.get(households.get(hid).home_id).place);
      const traits = {};
      for (const t of Profile.TRAITS) traits[t] = r2(rng.uniform(0.2, 0.8));
      const agent = new Agent({ id: aid, name, age, household_id: hid, money, job: jb, owns_car: car,
        x: place.entry[0], y: place.entry[1], inside: place.id, profile: new Profile(traits), savings });
      const needs = {};
      for (const n of Object.keys(agent.needs)) needs[n] = rng.uniform(60, 90);
      needs.energy = START_ENERGY + (needs.energy - 60) / 2; // the day starts like a morning
      agent.needs = needs;
      households.get(hid).member_ids.push(aid);
      agents.set(aid, agent);
      return agent;
    }

    // 1. The named 20, in households in order of first appearance.
    for (const [aid, name, age, hid, money, jb, car] of NAMED) {
      if (!households.has(hid)) new_household(hid, NAMED_HOMES[hid]);
      make(aid, name, age, hid, money, age >= 18 ? getd(SAVINGS, aid, 0) : 0, jb(), car);
    }
    const named = new Set(agents.keys());

    // 2-3. The generated households.
    const surnames = SURNAMES.slice();
    rng.shuffle(surnames);
    const used = new Set(Array.from(agents.values(), a => firstName(a.name)));

    function first_name(female) {
      let pool = (female ? FEMALE : MALE).filter(n => !used.has(n));
      if (!pool.length) pool = (female ? MALE : FEMALE).filter(n => !used.has(n));
      const n = rng.pick(pool);
      used.add(n);
      return n;
    }

    const workers = []; // [agent id, band, home entry]
    for (const [home_id, roles] of TEMPLATES) {
      const surname = surnames.pop();
      const hid = surname.toLowerCase();
      new_household(hid, home_id);
      const home = homes.get(home_id);
      const entry = town.places.get(home.place).entry;
      const adult_roles = roles.filter(r => r !== "kid");
      const n_kids = roles.filter(r => r === "kid").length;
      const all_retired = adult_roles.every(r => r === "retired");
      const base = all_retired ? rng.int(66, 80) : rng.int(n_kids === 0 ? 24 : 30, 50);
      const ages = [];
      adult_roles.forEach((role, i) => {
        if (role === "retired" && !all_retired) ages.push(rng.int(68, 82));
        else ages.push(Math.max(all_retired ? 66 : 20, base + (i ? rng.int(-4, 4) : 0)));
      });
      if (n_kids) {
        const youngest = Math.min(...adult_roles.map((role, i) => [role, ages[i]]).filter(([role]) => role !== "retired")
          .map(([, age]) => age));
        for (let k = 0; k < n_kids; k++) ages.push(rng.int(Math.max(5, youngest - 42), Math.min(17, youngest - 20)));
      }
      const first_female = rng.random() < 0.5;
      const member_roles = adult_roles.concat(Array(n_kids).fill("kid"));
      member_roles.forEach((role, i) => {
        const age = ages[i];
        const female = i === 0 ? first_female : i === 1 ? !first_female : rng.random() < 0.5;
        const name = `${first_name(female)} ${surname}`;
        const aid = firstName(name).toLowerCase();
        const money = rng.int(...MONEY[role]);
        const savings = role !== "kid" ? rng.int(...SAVINGS_RANGE[role]) : 0;
        let jb, car;
        if (role === "kid") {
          jb = _student_job(age);
          car = false;
        } else if (role === "retired") {
          jb = null;
          car = home.tier !== "flat" && rng.random() < RETIREE_CAR;
        } else {
          jb = null;
          car = rng.random() < CAR_ODDS[home.tier];
          workers.push([aid, role, entry]);
        }
        make(aid, name, age, hid, money, savings, jb, car);
      });
    }

    // 4. Jobs: nearest-first greedy matching with seeded jitter, then swaps that shorten the walks.
    const pairs = [];
    for (const [aid, band, entry] of workers) {
      for (const sband of band === "high" ? ["high"] : ["low", "mid"]) {
        SLOTS[sband].forEach((slot, i) => {
          const cost = town.walk_minutes(entry, slot[1]) + rng.int(0, 8) + (sband === band ? 0 : 20);
          pairs.push([cost, aid, sband, i]);
        });
      }
    }
    pairs.sort(cmp);
    const taken = new Set(), done = new Set();
    for (const [, aid, sband, i] of pairs) {
      if (!done.has(aid) && !taken.has(`${sband}:${i}`)) {
        taken.add(`${sband}:${i}`);
        done.add(aid);
        agents.get(aid).job = job(...SLOTS[sband][i]);
      }
    }
    const entry_of = new Map(workers.map(([aid, , entry]) => [aid, entry]));
    const high = new Set(workers.filter(([, band]) => band === "high").map(([aid]) => aid));

    const walk2 = (aid, jb) => town.walk_minutes(entry_of.get(aid), jb.place_id) ** 2;

    const ids = workers.map(([aid]) => aid);
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < ids.length; i++) {
        const a_id = ids[i];
        for (const b_id of ids.slice(i + 1)) {
          if (high.has(a_id) !== high.has(b_id)) continue;
          const a = agents.get(a_id), b = agents.get(b_id);
          if (walk2(a_id, b.job) + walk2(b_id, a.job) < walk2(a_id, a.job) + walk2(b_id, b.job)) {
            [a.job, b.job] = [b.job, a.job];
            changed = true;
          }
        }
      }
    }

    // 5. Relationships.
    for (const hh of households.values()) {
      const members = hh.member_ids.map(m => agents.get(m));
      for (const a of members) {
        for (const b of members) {
          if (a !== b) {
            const partners = a.is_adult && b.is_adult && Math.abs(a.age - b.age) < 10;
            a.relate(b.id, partners ? RelationKind.PARTNER : RelationKind.FAMILY, 75);
          }
        }
      }
    }
    const staff = new Map(); // workplaces in order of their first paid worker
    for (const a of agents.values()) {
      if (a.job && a.job.hourly_wage > 0) {
        if (!staff.has(a.job.place_id)) staff.set(a.job.place_id, []);
        staff.get(a.job.place_id).push(a);
      }
    }
    for (const people of staff.values()) {
      people.forEach((a, i) => {
        for (const b of people.slice(i + 1)) {
          if (!a.relationships.has(b.id)) {
            const aff = rng.int(15, 35);
            a.relate(b.id, RelationKind.COWORKER, aff);
            b.relate(a.id, RelationKind.COWORKER, aff);
          }
        }
      });
    }
    const students = sortedBy(Array.from(agents.values()).filter(a => a.job && a.job.place_id === "school" && a.job.hourly_wage === 0),
      a => [a.age, a.id]);
    for (let i = 0; i + 1 < students.length; i++) {
      const a = students[i], b = students[i + 1];
      if (a.household_id !== b.household_id && !a.relationships.has(b.id)) {
        const aff = rng.int(30, 60);
        a.relate(b.id, RelationKind.FRIEND, aff);
        b.relate(a.id, RelationKind.FRIEND, aff);
      }
    }
    for (const [a_id, b_id, aff] of FRIENDS) {
      agents.get(a_id).relate(b_id, RelationKind.FRIEND, aff);
      agents.get(b_id).relate(a_id, RelationKind.FRIEND, aff);
    }

    const district = agent => town.places.get(homes.get(households.get(agent.household_id).home_id).place).district;

    for (const a of Array.from(agents.values()).filter(x => !named.has(x.id) && x.is_adult)) {
      if (Array.from(a.relationships.values()).some(r => r.kind === RelationKind.FRIEND)) continue;
      const pool = sortedBy(Array.from(agents.values()).filter(b => b.is_adult && b.household_id !== a.household_id
        && Math.abs(b.age - a.age) <= 8 && !a.relationships.has(b.id)), b => b.id);
      if (pool.length) {
        const near = pool.filter(c => district(c) === district(a));
        const b = rng.pick(near.length ? near : pool);
        const aff = rng.int(30, 60);
        a.relate(b.id, RelationKind.FRIEND, aff);
        b.relate(a.id, RelationKind.FRIEND, aff);
      }
    }

    // 6. Goals and profiles.
    for (const [aid, [goal, target]] of Object.entries(GOALS)) agents.get(aid).goal = { name: goal, target, saved: 0.0 };
    for (const a of agents.values()) {
      if (!named.has(a.id) && a.is_adult && a.age < 60 && rng.random() < GOAL_CHANCE) {
        const [goal, target] = rng.pick(GOAL_POOL);
        a.goal = { name: goal, target, saved: 0.0 };
      }
      a.profile.prompt = a.profile.describe(a);
    }
    check(agents.size === CAST_SIZE, agents.size);
    return [agents, households];
  }

  // --- the golden file ------------------------------------------------------------

  // The city for a seed as pinned by tests/fixtures/city_seed1.json. `sha1` turns text into its hex SHA-1 (the
  // node tool passes node's crypto; the page never needs this).
  function golden(seed, sha1) {
    const { HOME_SPECS, LOT_CONDITION, build_homes } = G.housing;
    const town = G.town.build_map(seed);
    const homes = build_homes(town);
    const [agents, households] = build_cast(town, homes, seed);
    const condition = Object.assign({}, LOT_CONDITION);
    for (const spec of HOME_SPECS) if (spec[8] !== null) condition[spec[1]] = spec[8];
    return {
      tiles_sha1: sha1(town.rows().join("\n")),
      people: Array.from(agents.values(), a => ({ id: a.id, name: a.name, age: a.age, household: a.household_id,
        home: households.get(a.household_id).home_id, job_place: a.job ? a.job.place_id : null,
        title: a.job ? a.job.title : null, wage: a.job ? a.job.hourly_wage : 0,
        car: a.owns_car, money: pyRound(a.money), savings: pyRound(a.savings) })),
      homes: Array.from(homes.values(), h => ({ id: h.id, tier: h.tier, bedrooms: h.bedrooms, base_value: h.base_value,
        rent: h.rent, start: h.start, condition: condition[h.place] })),
    };
  }

  G.cast = {
    CAST_SIZE, START_ENERGY, job, NAMED, NAMED_HOMES, SAVINGS, FRIENDS, GOALS, GOAL_POOL, SLOTS, TEMPLATES, SURNAMES, FEMALE, MALE,
    CAR_ODDS, RETIREE_CAR, MONEY, SAVINGS_RANGE, GOAL_CHANCE, _student_job, build_cast, golden,
  };
})(globalThis.GameOfAILife || (globalThis.GameOfAILife = {}));

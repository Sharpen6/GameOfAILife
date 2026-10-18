// Port of gameofailife/folk_life.py: townsfolk money and households (folk.md 6, PLAN 2.3 and 2.5): pay at shift
// end, Friday pensions, Sunday rent and bills, saving, arrears, and household joins, splits and leaving town; the
// folk side of birthdays (school at 5, Riverton High at 11, school ends at 18) and the folk homes' moves. Money is
// kept in cents (`r2`), so each household's books balance to the cent. Nothing here draws `sim.rng`. Function by
// function with folk_life.py.
(function (G) {
  "use strict";
  const { r2 } = G.rng;

  const BILLS_PER_ADULT = 80.0; // sim.BILLS_PER_ADULT
  const CAR_BILL = 40.0; // sim.CAR_BILL
  const PENSION = 400.0; // sim.PENSION: Friday 09:00, to folk 65+ without a job
  const PENSION_AGE = 65;
  const SAVE_BASE = 0.1, SAVE_THRIFT = 0.4; // each adult saves (.1 + .4 thrift) x max(0, money - 2 weekly outgo)
  const ARREARS_MOVE = 3; // Sundays in the red: move somewhere cheaper, else leave town
  const FORCED_PER_BEDROOM = 3; // a forced move may crowd up to 3 a bedroom
  const FIX_FACTOR = 2; // an emergency is fixed once the household holds twice its cost
  const RENT_SHARE = 0.45; // a rental is affordable at most this share of weekly income ...
  const RENT_WEEKS = 12; // ... or with this many weeks of its rent in hand
  const SCHOOL_AGE = 5, TEEN_AGE = 11, ADULT_AGE = 18;
  const PARENT_GAP = 16;

  const housing = () => G.housing;
  const _folk = sim => sim.folk;
  const _sim_of = folk => folk.sim;
  const _cents = x => Math.floor(x * 100 + 0.5);
  const _income_tax = wage => Math.min(0.45, 0.15 + 0.004 * wage); // sim.income_tax
  const _lt = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);

  function _shift_hours(job) {
    const h = job.end_hour - job.start_hour;
    return h > 0 ? h : h + 24;
  }

  const _here = p => p !== null && p !== undefined && p.alive && !p.gone;

  // The household's people still alive and in town, in member order.
  function members(folk, hh) {
    const out = [];
    for (const pid of hh.member_ids) {
      const p = folk.person(pid);
      if (_here(p)) out.push(p);
    }
    return out;
  }

  const adults = (folk, hh) => members(folk, hh).filter(p => p.age >= ADULT_AGE);

  function funds(folk, hh) {
    let total = 0.0;
    for (const p of adults(folk, hh)) total += p.money + p.savings;
    return r2(total);
  }

  // Take-home pay for a full week of shifts, or the pension.
  function weekly_income(p) {
    const job = p.job;
    if (job !== null && job.hourly_wage > 0) {
      return job.hourly_wage * _shift_hours(job) * job.workdays.length * (1 - _income_tax(job.hourly_wage));
    }
    if (p.age >= PENSION_AGE) return PENSION;
    return 0.0;
  }

  // Take `amount` from cash, then savings (cash may go below zero).
  function _pay(p, amount) {
    p.money = r2(p.money - amount);
    if (p.money < 0 && 0 < p.savings) {
      const move = Math.min(p.savings, -p.money);
      p.savings = r2(p.savings - move);
      p.money = r2(p.money + move);
    }
  }

  // --- pay, pensions, the Sunday charges ---

  // A shift's take-home pay at its end: wage x hours x (1 - income tax).
  function pay_shift(sim, p) {
    const job = p.job;
    if (job === null || job.hourly_wage <= 0 || !_here(p)) return 0.0;
    const pay = r2(job.hourly_wage * _shift_hours(job) * (1 - _income_tax(job.hourly_wage)));
    p.money = r2(p.money + pay);
    p.worked_day = sim.clock.day;
    return pay;
  }

  // Friday 09:00: the pension to every townsperson 65 or over without a paid job.
  function pensions(sim) {
    for (const p of _folk(sim).people) {
      if (_here(p) && p.age >= PENSION_AGE && (p.job === null || p.job.hourly_wage <= 0)) {
        p.money = r2(p.money + PENSION);
      }
    }
  }

  // Sunday 23:00, after housing.weekly_charges, for every folk household with an adult: housing split by the
  // adults to the cent, bills, savings covering a negative balance, v2's arrears rule (silent), saving, then an
  // emergency fixed once affordable twice over. Three Sundays in arrears: a cheaper rental at up to 3 a bedroom,
  // else the household leaves town.
  function weekly(sim) {
    const H = housing();
    const folk = _folk(sim);
    const now = sim.clock.tick;
    for (const hh of [...folk.households]) {
      if (hh.gone) continue;
      const payers = adults(folk, hh);
      if (!payers.length) continue;
      const home = sim.homes.get(hh.home_id);
      const charge = H.weekly_cost(sim, hh);
      const n = payers.length;
      const c = _cents(charge);
      const base = Math.floor(c / n), extra = c % n;
      payers.forEach((p, k) => {
        const share = (base + (k < extra ? 1 : 0)) / 100;
        p.money = r2(p.money - share - BILLS_PER_ADULT - (p.owns_car ? CAR_BILL : 0.0));
      });
      for (const p of payers) {
        if (p.money < 0 && 0 < p.savings) {
          const move = Math.min(p.savings, -p.money);
          p.savings = r2(p.savings - move);
          p.money = r2(p.money + move);
        }
      }
      const f = funds(folk, hh);
      if (f >= 0) {
        hh.arrears = 0;
        hh.clean_sundays += 1;
      } else {
        hh.clean_sundays = 0;
        if (home.owner === hh.id) hh.tax_deferred = true; // a broke owner's property tax waits (hardship)
        if (hh.grace_until > now) {
          // in grace
        } else if (hh.arrears > 0 && hh.last_funds !== null && f >= hh.last_funds + H.ARREARS_PROGRESS) {
          // paying it down
        } else {
          hh.arrears += 1;
        }
      }
      hh.last_funds = f;
      if (hh.clean_sundays >= 2) {
        hh.hardship_rent = null;
        hh.tax_deferred = false;
      }
      if (hh.arrears >= ARREARS_MOVE) {
        fall_behind(sim, hh);
        continue;
      }
      const outgo = H.weekly_outgo(sim, hh);
      const share = outgo / n;
      for (const p of payers) {
        const t = p.traits.thrift ?? 0.5;
        const amount = r2((SAVE_BASE + SAVE_THRIFT * t) * Math.max(0.0, p.money - 2 * share));
        if (amount > 0) {
          p.money = r2(p.money - amount);
          p.savings = r2(p.savings + amount);
        }
      }
      if (home.emergency !== null && home.emergency !== undefined && home.household === hh.id) {
        _fix(sim, folk, hh, home);
      }
    }
  }

  // A live emergency is fixed, by the richest adult, once the household holds twice its cost (Sundays after the
  // charges and every midnight).
  function _fix(sim, folk, hh, home) {
    const H = housing();
    const payers = adults(folk, hh);
    const cost = H.TIERS[home.tier].emergency_cost ?? 0;
    if (!payers.length || funds(folk, hh) < FIX_FACTOR * cost) return false;
    const payer = richest(payers);
    _pay(payer, cost);
    const live = home.emergency;
    home.emergency = null; // housing.fix_emergency's effect; its emergency_settled news is importance 0 (memory only)
    _remember(sim, members(folk, hh), `The ${H.EMERGENCY_NAME[live.kind]} at ${home.name} is fixed.`);
    return true;
  }

  // A townsfolk importance-0 happening (PLAN 2.8): each one's memory, never `sim.event`.
  function _remember(sim, people, text) {
    const stamp = sim.clock.stamp();
    for (const p of people) p.remember(stamp, text);
  }

  // Midnight, after housing.nightly (which leaves the townsfolk homes alone): an emergency left unfixed for
  // EMERGENCY_DAYS settles as lost condition; the residents of a neglected or derelict folk home lose health to
  // damp (doubled in winter) and may catch a chill; an owner-occupied folk home without an emergency rolls for one,
  // which goes live at once. A live one is fixed first when affordable (`_fix`). Rolls on (NS_FOLK_HOME, home_id,
  // day) of `sim.dice_seed`, drawn only where needed.
  function nightly(sim) {
    const H = housing();
    const luck_odds = G.forks.luck_odds;
    const folk = _folk(sim);
    const households = folk.households;
    if (!households || !households.length) return;
    const winter = sim.clock.season === "winter";
    const now = sim.clock.tick, day = sim.clock.day;
    for (const hh of households) {
      if (hh.gone) continue;
      const home = sim.homes.get(hh.home_id);
      if (home === undefined || home.household !== hh.id) continue;
      const mem = members(folk, hh);
      let live = home.emergency;
      if (live && _fix(sim, folk, hh, home)) live = null;
      if (live && now - live.since >= H.EMERGENCY_DAYS * H.DAY) {
        home.emergency = null;
        _remember(sim, mem, `The ${H.EMERGENCY_NAME[live.kind]} at ${home.name} is never properly fixed.`);
        H._change_condition(sim, sim.lots.get(home.place), -H.SETTLE_DAMAGE);
      }
      if (!mem.length) continue;
      const st = H.stage_of(H.condition_of(sim, home.id));
      const payers = mem.filter(p => p.age >= ADULT_AGE);
      const roll_emergency = payers.length > 0 && home.owner === hh.id && !home.emergency && !home.pending_emergency;
      const damp = H.DAMP_HEALTH[st] !== undefined;
      if (!damp && !roll_emergency) continue;
      const rr = G.dice.stream(sim.dice_seed, G.folk_model.NS_FOLK_HOME, home.id, day);
      if (damp) {
        const k = winter ? 2 : 1;
        for (const p of mem) {
          p.health = Math.max(0.0, p.health - H.DAMP_HEALTH[st] * k);
          const prob = luck_odds(H.DAMP_CHILL[st] * k, -1, p.luck);
          const roll = rr.random();
          G.people.log_roll(sim, p, "damp_chill", prob, roll);
          if (roll < prob) {
            p.health = Math.max(0.0, p.health + H.CHILL.health);
            p.adjust("fun", H.CHILL.fun);
            _remember(sim, [p], `${p.name} catches a chill in the damp house.`); // routine: no News
          }
        }
      }
      if (roll_emergency) {
        let p0 = (H.TIERS[home.tier].emergency_p ?? 0.0) + (H.EMERGENCY_STAGE_P[st] ?? 0.0);
        if (winter) p0 *= H.WINTER_EMERGENCY;
        let luck = 0.0;
        for (const p of payers) luck += p.luck;
        const prob = luck_odds(p0, -1, luck / payers.length);
        const roll = rr.random();
        G.people.log_roll(sim, payers[0], "home_emergency", prob, roll);
        if (roll < prob) {
          const kinds = ["leak", "electrics", "boiler"].concat(winter ? ["boiler", "boiler"] : [],
            (sim.weather || "clear") === "rain" ? ["roof"] : []);
          const kind = rr.pick(kinds);
          home.emergency = { kind, since: now };
          _remember(sim, mem, H.EMERGENCY_NEWS[kind].replace("{home}", home.name)); // routine: no News
        }
      }
    }
  }

  function richest(people) {
    let best = null;
    for (const p of people) {
      if (best === null || p.money + p.savings > best.money + best.savings) best = p;
    }
    return best;
  }

  // Three Sundays in the red: the cheapest vacant rental cheaper than today's that fits at 3 a bedroom, else
  // everyone leaves town.
  function fall_behind(sim, hh) {
    const folk = _folk(sim);
    const mem = members(folk, hh);
    const home = sim.homes.get(hh.home_id);
    const now_cost = home.owner !== hh.id ? housing().weekly_cost(sim, hh) : Infinity;
    let best = null;
    for (const h of vacancies(sim)) {
      if (h.listing !== "for_rent" || h.owner !== "landlord") continue;
      if (FORCED_PER_BEDROOM * h.bedrooms < mem.length || h.rent >= now_cost) continue;
      if (best === null || _lt([h.rent, h.id], [best.rent, best.id])) best = h;
    }
    if (best !== null) {
      folk_move(sim, hh, best.id, "rent");
      _refresh(sim, mem); // commutes from the new home
      hh.arrears = 0;
      hh.last_funds = null;
      return;
    }
    const ids = mem.map(p => p.id);
    const names = mem.map(p => p.name).join(", ");
    for (const p of mem) release(sim, p, true);
    _left_event(sim, hh, ids, `${names} can no longer pay for ${home.name} and leave town.`);
  }

  // After a death: children left in a household with no adult go to a relative's household in town (an adult
  // family tie, in id order), else they leave town to family elsewhere (`left_town`, one event).
  function orphans(sim, hh) {
    const folk = _folk(sim);
    if (hh === null || hh === undefined || hh.gone) return;
    const mem = members(folk, hh);
    if (!mem.length || mem.some(p => p.age >= ADULT_AGE)) return;
    let host = null;
    for (const p of mem) {
      for (const oid of [...p.relationships.keys()].sort()) {
        const q = folk.person(oid);
        if (!_here(q) || q.age < ADULT_AGE || q.household_id === hh.id) continue;
        const r = p.relationships.get(oid);
        if (r.kind === "family") {
          host = q;
          break;
        }
      }
      if (host !== null) break;
    }
    if (host !== null) {
      const dst = folk.household(host.household_id);
      _move_people(folk, mem, dst);
      _refresh(sim, mem);
      _remember(sim, mem, `Moved in with ${host.name}.`);
      return;
    }
    const ids = mem.map(p => p.id);
    const names = mem.length <= 2 ? mem.map(p => p.name).join(" and ") : mem.map(p => p.name).join(", ");
    for (const p of mem) release(sim, p, true);
    _left_event(sim, hh, ids, `${names} go to live with family out of town.`);
  }

  // --- birthdays ---

  // After life's birthday (p.age already the new age): school at 5 (the nearest region school with seats),
  // Riverton High at 11 when it has seats, school ends at 18 (job null: career's hiring applies).
  function on_birthday(sim, p) {
    const FG = G.folk_gen;
    const student = p.job !== null && p.job.title === "student";
    if (p.age === SCHOOL_AGE && p.job === null) {
      const school = nearest_school(sim, p);
      if (school !== null) p.job = FG.student_job(p.age, school);
    } else if (p.age === TEEN_AGE && student) {
      const high = FG.HIGH_SCHOOL;
      const mb = sim.town.millbrook_ids || new Set();
      if (p.job.place_id !== high && !mb.has(p.job.place_id) && sim.town.places.has(high) && _seats(sim, high) > 0) {
        p.job = FG.student_job(p.age, high);
      } else {
        p.job = FG.student_job(p.age, p.job.place_id);
      }
    } else if (student && p.age < ADULT_AGE) {
      p.job = FG.student_job(p.age, p.job.place_id); // school hours by age
    } else if (p.age >= ADULT_AGE && student) {
      p.job = null;
      p.commute = null;
    }
  }

  function _seats(sim, pid) {
    let cap = sim.town.places.get(pid).capacity || G.folk_gen.SCHOOL_SEATS;
    for (const a of sim.agents.values()) {
      if (a.alive && a.job !== null && a.job.title === "student" && a.job.place_id === pid) cap -= 1;
    }
    for (const q of _folk(sim).people) {
      if (_here(q) && q.job !== null && q.job.title === "student" && q.job.place_id === pid) cap -= 1;
    }
    return cap;
  }

  // The nearest region school with seats from p's home, on foot (Millbrook's school only for the 40 at the start).
  function nearest_school(sim, p) {
    const folk = _folk(sim);
    const hh = folk.household(p.household_id);
    const home = sim.homes.get(hh.home_id).place;
    const net = G.roads.net(sim.town);
    const mb = sim.town.millbrook_ids || new Set();
    let best = null;
    for (const [pid, pl] of sim.town.places) {
      if (pl.kind !== "school" || mb.has(pid) || _seats(sim, pid) <= 0) continue;
      const key = [net.minutes(home, pid, "walk"), pid];
      if (best === null || _lt(key, best)) best = key;
    }
    return best !== null ? best[1] : null;
  }

  // --- households: join, split, leave ---

  // p's under-18s in hh: family ties 16+ years younger, or every under-18 when p is the last adult.
  function _kids_of(folk, hh, p) {
    const mem = members(folk, hh);
    const left = mem.filter(q => q.age >= ADULT_AGE && q !== p);
    const out = [];
    for (const q of mem) {
      if (q === p || q.age >= ADULT_AGE) continue;
      const r = p.relationships.get(q.id);
      const kind = r !== undefined ? r.kind : null;
      if (!left.length || (kind === "family" && p.age - q.age >= PARENT_GAP)) out.push(q);
    }
    return out;
  }

  // Move people into household dst, emptying (and vacating) the households they leave. A home the movers owned
  // and left empty is sold: the richest adult mover from it (else the richest mover) gets the sale proceeds.
  function _move_people(folk, people, dst) {
    const left = [];
    const movers = new Map();
    for (const p of people) {
      const src = folk.household(p.household_id) ?? null;
      if (src === dst) continue;
      if (src !== null) {
        const k = src.member_ids.indexOf(p.id);
        if (k >= 0) src.member_ids.splice(k, 1);
        if (!left.includes(src)) {
          left.push(src);
          movers.set(src.id, []);
        }
        movers.get(src.id).push(p);
      }
      p.household_id = dst.id;
      p.hh = dst.j;
      dst.member_ids.push(p.id);
    }
    const sim = left.length ? _sim_of(folk) : null;
    for (const src of left) {
      if (members(folk, src).length) continue;
      const home = sim.homes.get(src.home_id);
      if (home !== undefined && home.household === src.id && home.owner === src.id) {
        const from = movers.get(src.id);
        const grown = from.filter(q => q.age >= ADULT_AGE);
        const payer = richest(grown.length ? grown : from);
        if (payer !== null) payer.money = r2(payer.money + housing().sale_proceeds(sim, home.id));
      }
      on_household_empty(folk, src);
    }
    _touch(folk);
  }

  // p and p's under-18s join host's household; a home left empty is vacated.
  function join(sim, p, host) {
    const folk = _folk(sim);
    const src = folk.household(p.household_id) ?? null;
    const dst = folk.household(host.household_id) ?? null;
    if (dst === null || src === dst) return;
    const movers = [p].concat(src !== null ? _kids_of(folk, src, p) : []);
    _move_people(folk, movers, dst);
    _refresh(sim, movers);
  }

  // p (and p's under-18s when nobody else would look after them) leaves the household: the cheapest affordable
  // vacant rental, else a parent's household, else town. True while p stays in town.
  function split(sim, p) {
    const folk = _folk(sim);
    const src = folk.household(p.household_id) ?? null;
    if (src === null || !_here(p)) return false;
    let kids = _kids_of(folk, src, p);
    const others = adults(folk, src).filter(q => q !== p);
    if (others.length) kids = []; // the children stay with the other adult
    if (members(folk, src).length === 1 + kids.length) return true; // nobody to split from
    const home = cheapest_rental(sim, p, 1 + kids.length);
    if (home !== null) {
      new_household(folk, [p.id].concat(kids.map(q => q.id)), home.id, "rent");
      return true;
    }
    let parent = null;
    for (const oid of [...p.relationships.keys()].sort()) {
      const q = folk.person(oid);
      if (!_here(q) || q.household_id === p.household_id) continue;
      const r = p.relationships.get(oid);
      if (r.kind === "family" && q.age - p.age >= PARENT_GAP) {
        parent = q;
        break;
      }
    }
    if (parent !== null) {
      join(sim, p, parent);
      return true;
    }
    const ids = [p.id].concat(kids.map(q => q.id));
    for (const q of [p].concat(kids)) release(sim, q, true);
    _left_event(sim, src, ids, `${p.name} leaves town.`);
    return false;
  }

  // The cheapest vacant region rental that fits `people` at 2 a bedroom and p can afford: rent at most 45% of
  // weekly income, or 12 weeks of rent in hand.
  function cheapest_rental(sim, p, people) {
    const income = weekly_income(p);
    const have = p.money + p.savings;
    let best = null;
    for (const h of vacancies(sim)) {
      if (h.listing !== "for_rent" || h.owner !== "landlord" || 2 * h.bedrooms < people) continue;
      if (h.rent > RENT_SHARE * income && have < RENT_WEEKS * h.rent) continue;
      if (best === null || _lt([h.rent, h.id], [best.rent, best.id])) best = h;
    }
    return best;
  }

  // p leaves town: gone, job slot freed, off the wheel and occupancy (folk.kill), an emptied home vacated, and a
  // `left_town` event (importance 1) unless `quiet`.
  function release(sim, p, quiet = false) {
    if (p.gone || !p.alive) return;
    const folk = _folk(sim);
    p.gone = true;
    const job = p.job;
    const slot = job !== null && job.slot !== undefined && job.slot !== null ? job.slot : -1;
    if (job !== null && job.hourly_wage > 0 && slot >= 0) {
      const b = G.folk_gen.board(sim);
      if (slot < b.holder.length && b.holder[slot] === p.id) b.free(slot);
    }
    const kill = _folk_fn("kill");
    if (kill !== null && folk.wheel !== undefined) kill(sim, p, "left_town"); // folk.js's Folk (not GenFolk)
    p.trip = null;
    p.inside = null;
    p.activity = "away";
    p.state = "idle";
    const hh = folk.household(p.household_id) ?? null;
    if (hh !== null && !members(folk, hh).length) on_household_empty(folk, hh);
    _touch(folk);
    if (!quiet) _left_event(sim, hh, [p.id], `${p.name} leaves town.`);
  }

  function _left_event(sim, hh, ids, text) {
    const place = hh !== null && sim.homes.has(hh.home_id) ? sim.homes.get(hh.home_id).place : null;
    sim.event(text, null, null, { tag: "left_town", agents: ids, place });
  }

  function _folk_fn(name) {
    const f = G.folk;
    return f !== undefined && typeof f[name] === "function" ? f[name] : null;
  }

  // A new home or household: folk.on_job_change refreshes each one's commute.
  function _refresh(sim, people) {
    const fn = _folk_fn("on_job_change");
    if (fn === null || _folk(sim).wheel === undefined) return;
    for (const p of people) fn(sim, p);
  }

  function _touch(folk) {
    if (folk.v !== undefined) folk.v += 1;
  }

  // --- homes ---

  // Vacant, listed region homes in town order.
  function vacancies(sim) {
    const v2 = _v2_ids();
    const out = [];
    for (const h of sim.homes.values()) {
      if (!v2.has(h.id) && h.household === null && h.listing !== null) out.push(h);
    }
    return out;
  }

  let _V2 = null; // v2's 37 home ids: a constant of housing.HOME_SPECS
  function _v2_ids() {
    if (_V2 === null) _V2 = new Set(housing().HOME_SPECS.map(spec => spec[0]));
    return _V2;
  }

  // Move `member_ids` (ids or people, the first the head) out of their households into vacant `home_id` (null:
  // the cheapest fitting rental) as a new household; `how` "rent" or "buy". null when no home is free.
  function new_household(folk, member_ids, home_id, how) {
    const sim = _sim_of(folk);
    const people = [];
    for (const m of member_ids) {
      const p = typeof m === "string" ? folk.person(m) : m;
      if (p !== null && p !== undefined) people.push(p);
    }
    if (!people.length) return null;
    if (home_id === null || home_id === undefined) {
      const h = cheapest_rental(sim, people[0], people.length);
      if (h === null) return null;
      home_id = h.id;
      how = "rent";
    }
    const home = sim.homes.get(home_id);
    if (home === undefined || home.household !== null) return null;
    const j = folk.households.length;
    const hh = new G.folk_model.FolkHousehold(G.folk_model.household_id(j), "", 0.0, j);
    hh.kind = "split";
    hh.u = 0.5;
    folk.households.push(hh);
    _move_people(folk, people, hh);
    folk_move(sim, hh, home_id, how);
    _refresh(sim, people);
    return hh;
  }

  // Nobody left in town: the household is gone and its home vacated.
  function on_household_empty(folk, hh) {
    if (hh.gone) return;
    hh.gone = true;
    folk_vacate(_sim_of(folk), hh);
  }

  function _history(rows, row) {
    rows.push(row);
    if (rows.length > 20) rows.splice(0, rows.length - 20);
  }

  // hh moves into vacant `home_id` (renting at its listed rent, or buying at its value), leaving its old home.
  function folk_move(sim, hh, home_id, how) {
    const H = housing();
    const folk = _folk(sim);
    const home = sim.homes.get(home_id);
    const now = sim.clock.tick, stamp = sim.clock.stamp();
    if (hh.home_id && sim.homes.has(hh.home_id)) _leave_home(sim, hh, true);
    hh.home_id = home_id;
    home.household = hh.id;
    home.listing = null;
    if (how === "buy") {
      const price = H.value(sim, home_id);
      const payer = richest(adults(folk, hh));
      if (payer !== null) _pay(payer, price);
      home.owner = hh.id;
      hh.weekly_rent = 0.0;
    } else {
      hh.weekly_rent = home.rent;
    }
    hh.moved_tick = now;
    hh.hardship_rent = null;
    _history(home.history, { tick: now, time: stamp, event: "moved_in", household: hh.id, price: null });
    _history(hh.history, { tick: now, time: stamp, event: "moved_in", home: home.id, name: home.name, price: null });
    _list(sim);
    _touch(folk);
  }

  // hh's home is left empty (an owner's goes on the market).
  function folk_vacate(sim, hh) {
    _leave_home(sim, hh, false);
    _list(sim);
    _touch(_folk(sim));
  }

  function _leave_home(sim, hh, sell) {
    const home = sim.homes.get(hh.home_id);
    if (home === undefined || home.household !== hh.id) return;
    const now = sim.clock.tick, stamp = sim.clock.stamp();
    if (home.owner === hh.id) {
      if (sell) {
        const payer = richest(adults(_folk(sim), hh));
        if (payer !== null) payer.money = r2(payer.money + housing().sale_proceeds(sim, home.id));
      }
      home.owner = "market";
    }
    home.household = null;
    home.pending_emergency = null;
    home.emergency = null;
    _history(home.history, { tick: now, time: stamp, event: "left", household: hh.id, price: null });
    _history(hh.history, { tick: now, time: stamp, event: "left", home: home.id, name: home.name, price: null });
  }

  function _list(sim) {
    const fn = housing().list_vacancies;
    if (typeof fn === "function") fn(sim);
  }

  G.folk_life = {
    BILLS_PER_ADULT, CAR_BILL, PENSION, PENSION_AGE, SAVE_BASE, SAVE_THRIFT, ARREARS_MOVE, FORCED_PER_BEDROOM,
    FIX_FACTOR, RENT_SHARE, RENT_WEEKS, SCHOOL_AGE, TEEN_AGE, ADULT_AGE, PARENT_GAP, _cents, members, adults, funds,
    weekly_income, pay_shift, pensions, weekly, nightly, richest, fall_behind, on_birthday, nearest_school, join, split,
    cheapest_rental, release, vacancies, new_household, on_household_empty, folk_move, folk_vacate, orphans,
  };
})(globalThis.GameOfAILife || (globalThis.GameOfAILife = {}));

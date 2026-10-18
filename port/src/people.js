// Port of gameofailife/people.py: the one person contract (life.md 3.2, PLAN 2.2) for the named and the townsfolk.
(function (G) {
  "use strict";

  // A townsperson's id: "f" followed by digits. Named ids hold no digits.
  const is_folk_id = x => typeof x === "string" && x.length > 1 && x[0] === "f" && /^[0-9]+$/.test(x.slice(1));

  // The index in Folk.people of a townsperson's id ("f17" -> 17).
  const folk_index = pid => parseInt(pid.slice(1), 10);

  // sim.folk while there are no townsfolk (folk 0): every method of PLAN 2.3 as a no-op.
  class NoFolk {
    constructor() {
      this.n = 0;
      this.isolated = false;
      this.v = 0;
      this.luck_log = [];
    }

    person(pid) { return null; }
    get(pid) { return null; }
    living() { return []; }
    present(place_id) { return []; }
    crowd(sim) { return []; }
    occ() { return []; }
    riders(tick) { return {}; }
    commute_minutes(p, place_id) { return null; }
    tick(sim) {}
    nightly(sim) {}
    pensions(sim) {}
    weekly(sim) {}
    stats_json(sim) { return null; }
    city_parts(sim) { return {}; }
    sample_hour(sim) {}
    roster_rows(sim) { return []; }
    page_json(sim, fid) { return null; }
    set_luck(fid, luck) { return false; }
    worth(sim, p) { return 0; }
    household(hid) { return null; }
    new_household(member_ids, home_id, how) { return null; }
    on_household_empty(hh) {}
  }

  // sim.folk: a NoFolk for n 0, else the townsfolk (G.folk.Folk, read at call time).
  function make_folk(sim, n, isolated = false) {
    if (!n) return new NoFolk();
    return new G.folk.Folk(sim, n, isolated);
  }

  G.people = { is_folk_id, folk_index, NoFolk, make_folk };
})(globalThis.GameOfAILife || (globalThis.GameOfAILife = {}));

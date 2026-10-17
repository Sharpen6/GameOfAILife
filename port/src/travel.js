// Port of gameofailife/travel.py: getting around: travel times, the usual way to work and what it costs a week,
// and the nearest open place.
//
// Walking and running read the town's O(1) walk fields (`sim.town.walk_minutes(xy, place_id)`). Cars and taxis
// follow the roads (`sim.town.drive_length`, memoized on the shared map) and lose about a minute at each
// junction's lights; an ambulance doesn't wait. A bus trip is the walk to the stop, the wait, the ride and the
// walk from the stop (`transit.best_trip`), and falls back to walking when the bus doesn't save
// transit.MIN_SAVING minutes. `Simulation` has delegating methods of the same names.
(function (G) {
  "use strict";
  const { getd, cmp, PyError } = G.py;

  const SPEEDS = { walk: 1, run: 2, car: 4, taxi: 4, ambulance: 4, bus: 1 }; // tiles a minute
  // "bus" is the rider's own walking legs; the bus itself moves at transit.SPEED.
  const TAXI_FARE = 12; // flat fare door to door
  const TRIP_COST = { walk: 0, car: 2, bus: 2 * G.transit.BUS_FARE }; // a workday's commute, there and back, by usual mode
  const UNREACHABLE = 65535; // what the walk fields give for a tile that cannot reach the place
  const ROAD_MODES = ["car", "taxi", "ambulance"]; // they follow the roads
  const LIGHT_WAIT = 1; // minutes a car or taxi loses at each junction on its way (about 0.75 on average, rounded up)
  const BUS_MIN_WALK = 25; // the bus is someone's usual way to work only when the walk is longer than this

  // The bus trip the character would make to a place leaving now: [minutes door to door, line, board stop,
  // alight stop], or null when they are inside it or no bus saves transit.MIN_SAVING minutes over walking.
  // With `worst`, the slowest departure minute's trip instead (see transit.best_trip).
  function bus_trip(sim, agent, place_id, worst = false) {
    if (agent.inside === place_id) return null;
    return G.transit.best_trip(sim.town, [agent.x, agent.y], place_id, sim.clock.tick, worst);
  }

  // Minutes from where the character is to a place by `mode`: 0 when already inside.
  //
  // walk and run: ceil(walk / speed). car and taxi: ceil(road tiles / 4) plus LIGHT_WAIT at each junction on
  // the drive path; ambulance: the same without the lights. bus: the trip leaving now (`bus_trip`), or with
  // `worst` the slowest departure minute's trip, and walking when no bus saves transit.MIN_SAVING minutes.
  // Any other mode walks. UNREACHABLE when the place cannot be reached on foot.
  function travel_minutes(sim, agent, place_id, mode, worst = false) {
    if (agent.inside === place_id) return 0;
    const at = [agent.x, agent.y];
    const walk = sim.town.walk_minutes(at, place_id);
    if (walk >= UNREACHABLE) return UNREACHABLE;
    if (ROAD_MODES.includes(mode)) {
      const [tiles, junctions] = sim.town.drive_length(at, place_id);
      if (tiles >= UNREACHABLE) return UNREACHABLE;
      return Math.ceil(tiles / SPEEDS[mode]) + (mode !== "ambulance" ? junctions * LIGHT_WAIT : 0);
    }
    if (mode === "bus") {
      const trip = bus_trip(sim, agent, place_id, worst);
      return trip ? trip[0] : walk;
    }
    return Math.ceil(walk / getd(SPEEDS, mode, 1));
  }

  // How the character usually gets to work: "car" | "bus" | "walk".
  //
  // The car if they own one. Otherwise the bus when the walk from home to the job (or school) is longer than
  // BUS_MIN_WALK minutes and, whenever they leave, a bus saves transit.MIN_SAVING minutes or more (the
  // worst-case trip from home is at most walk - MIN_SAVING). Otherwise walking. It depends only on where they
  // live (`sim.home_of`, a place id) and work, not on where they are now.
  function usual_mode(sim, agent) {
    if (agent.owns_car) return "car";
    const job = agent.job;
    if (!job) return "walk";
    const home = sim.town.places.get(sim.home_of(agent)).entry;
    const walk = sim.town.walk_minutes(home, job.place_id);
    if (BUS_MIN_WALK < walk && walk < UNREACHABLE && G.transit.best_trip(sim.town, home, job.place_id, 0, true)) {
      return "bus";
    }
    return "walk";
  }

  // Minutes from here to the job (or school) by the usual mode, counting the worst bus wait; null without one.
  //
  // A bus commuter's minutes are the worst-case trip from here (walking, when no bus saves time from here), so
  // setting off that long before the shift is always in time whatever the timetable.
  function commute_minutes(sim, agent) {
    if (!agent.job) return null;
    return travel_minutes(sim, agent, agent.job.place_id, usual_mode(sim, agent), true);
  }

  // What a week of commuting costs: one TRIP_COST of the usual mode for each workday.
  //
  // 0 without a paid job (school is free); the bus is free under 18 and from 65.
  function weekly_commute_cost(sim, agent) {
    const job = agent.job;
    if (!job || job.hourly_wage <= 0) return 0;
    const mode = usual_mode(sim, agent);
    if (mode === "bus" && !G.transit.fare(agent.age)) return 0;
    return job.workdays.length * getd(TRIP_COST, mode, 0);
  }

  // Where a walk starts: [tile, the id of the place it starts inside, or null].
  //
  // `where` is a Place or a place id (its entry tile, inside that place), a character (their tile, inside
  // `inside`) or an [x, y] tile (inside nothing). A Place is told from a character by its `entry`: its own
  // x and y are the building's corner, usually a tile nobody can walk from.
  function _spot(sim, where) {
    if (typeof where === "string") where = sim.town.places.get(where);
    if (Array.isArray(where) && where.length === 2) return [[where[0], where[1]], null];
    if (where && where.entry !== undefined) return [[where.entry[0], where.entry[1]], where.id];
    if (where && where.x !== undefined && where.y !== undefined) return [[where.x, where.y], where.inside ?? null];
    throw new PyError("TypeError", `cannot walk from ${where}: give a character, a Place, a place id or an (x, y) tile`);
  }

  // Minutes on foot from a `_spot` to a place: 0 when the spot is inside that place.
  function _walk(sim, spot, place) {
    const [tile, inside] = spot;
    if (inside === place.id) return 0;
    return sim.town.walk_minutes(tile, place.id);
  }

  // The best place of one of `kinds` for the character to go to now, or null when none will do.
  //
  // A place qualifies when it is open by the time the character walks in from where they are and still
  // open `stay` minutes later (the review fix's `_open_on_arrival`). The best one has the lowest
  // walk(origin, place) + walk(meet, place), ties by id. `origin` defaults to the character; `origin` and
  // `meet` may each be a character (another Agent), a Place, a place id or an [x, y] tile.
  function nearest(sim, agent, kinds, origin = null, meet = null, stay = 0) {
    if (typeof kinds === "string") kinds = [kinds];
    const here = _spot(sim, agent);
    const start = origin === null ? null : _spot(sim, origin);
    const end = meet === null ? null : _spot(sim, meet);
    let best = null, best_key = null;
    for (const place of sim.town.places.values()) {
      if (!kinds.includes(place.kind)) continue;
      const walk = _walk(sim, here, place);
      if (walk >= UNREACHABLE) continue;
      const arrive = sim.clock.hour + walk / 60;
      if (!(place.is_open(arrive) && place.is_open(arrive + stay / 60))) continue;
      let score = start === null ? walk : _walk(sim, start, place);
      if (end !== null) score += _walk(sim, end, place);
      if (score >= UNREACHABLE) continue;
      const k = [score, place.id];
      if (best_key === null || cmp(k, best_key) < 0) {
        best = place;
        best_key = k;
      }
    }
    return best;
  }

  G.travel = {
    SPEEDS, TAXI_FARE, TRIP_COST, UNREACHABLE, ROAD_MODES, LIGHT_WAIT, BUS_MIN_WALK, bus_trip, travel_minutes,
    usual_mode, commute_minutes, weekly_commute_cost, _spot, _walk, nearest,
  };
})(globalThis.GameOfAILife || (globalThis.GameOfAILife = {}));

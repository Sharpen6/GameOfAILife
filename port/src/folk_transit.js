// Port of gameofailife/folk_transit.py: how townsfolk get about (folk.md 5 Trips, PLAN 2.3), on foot, by car or by
// train, planned whole at departure.
//
// This module is folk's only reader of `G.roads` and `G.rail`. A trip is a list of legs [kind, t0, t1, data] in
// absolute ticks: WALK and DRIVE legs carry a roads Route, WAIT the station's place id, RIDE the train id. Nothing
// here draws dice; routes are built with keep=false, so they live only on active trips.
(function (G) {
  "use strict";

  const WALK = 0, DRIVE = 1, WAIT = 2, RIDE = 3; // leg kinds, as folk_model's and rail's
  const WALK_MAX = 12; // minutes: always walk a trip this short
  const TRAIN_WALK = 20; // the train is considered only when the walk is longer than this ...
  const TRAIN_SAVES = 5; // ... and it must save at least this many minutes on it
  const PARK_RIDE_SLACK = 8; // a car owner rides when the train is within this many minutes of driving
  const REACH = { walk: 45, car: 45, train: 60 }; // the longest commute by each mode (commute_minutes; null beyond)

  const net = town => G.roads.roadnet(town);

  // Door-to-door road minutes between two places (0 for the same place).
  function minutes(town, a, b, mode = "walk") {
    if (a === b) return 0;
    return net(town).minutes(a, b, mode === "car" || mode === "ambulance" ? "car" : "walk");
  }

  // One WALK or DRIVE leg from a to b leaving at t0.
  function road_leg(town, kind, a, b, t0) {
    const route = net(town).route(a, b, kind === WALK ? "walk" : "car", false);
    return [kind, t0, t0 + Math.max(1, route.minutes), route];
  }

  // rail.trip_via_roads, or null while the rail planner is not there (or no line serves the pair).
  function train_trip(town, a, b, tick, car) {
    const plan = G.rail && G.rail.trip_via_roads;
    if (!plan) return null;
    return plan(town, net(town), a, b, tick, car);
  }

  // A TrainTrip's legs as absolute ticks (the planner gives them from the departure tick).
  function _legs_of(trip, tick) {
    let legs = Array.from(trip.legs);
    if (legs.length && legs[0][1] < tick) legs = legs.map(([k, t0, t1, d]) => [k, tick + t0, tick + t1, d]);
    return legs;
  }

  // [mode, legs] for a trip from a to b leaving at tick: "walk", "car", "train" or "ambulance".
  function choose(town, a, b, tick, car, prefer = null) {
    if (a === b) return ["walk", []];
    if (prefer === "ambulance") return ["ambulance", [road_leg(town, DRIVE, a, b, tick)]];
    if (prefer === "car" && car) return ["car", [road_leg(town, DRIVE, a, b, tick)]];
    if (prefer === "train") {
      const trip = train_trip(town, a, b, tick, car);
      if (trip !== null) return ["train", _legs_of(trip, tick)];
    }
    if (prefer === "walk") return ["walk", [road_leg(town, WALK, a, b, tick)]];
    const walk = minutes(town, a, b, "walk");
    if (walk <= WALK_MAX) return ["walk", [road_leg(town, WALK, a, b, tick)]];
    const drive = car ? minutes(town, a, b, "car") : null;
    if (walk > TRAIN_WALK) {
      const trip = train_trip(town, a, b, tick, car);
      if (trip !== null && trip.minutes + TRAIN_SAVES <= walk && (
        drive === null || trip.minutes <= drive + PARK_RIDE_SLACK)) {
        return ["train", _legs_of(trip, tick)];
      }
    }
    if (drive !== null && drive < walk) return ["car", [road_leg(town, DRIVE, a, b, tick)]];
    return ["walk", [road_leg(town, WALK, a, b, tick)]];
  }

  // [minutes, mode] of the best allowed commute from a to b, the worst train wait counted; null out of reach.
  function best_minutes(town, a, b, car) {
    if (a === b) return [0, "walk"];
    let best = null;
    const walk = minutes(town, a, b, "walk");
    if (walk <= REACH.walk) best = [walk, "walk"];
    if (car) {
      const drive = minutes(town, a, b, "car");
      if (drive <= REACH.car && (best === null || drive < best[0])) best = [drive, "car"];
    }
    const worst = G.rail && G.rail.worst_minutes;
    if (worst && walk > TRAIN_WALK) {
      const m = worst(town, net(town), a, b, car);
      if (m !== null && m !== undefined && m <= REACH.train && (best === null || m + TRAIN_SAVES <= best[0])) {
        best = [m, "train"];
      }
    }
    return best;
  }

  const end_of = (legs, tick) => (legs.length ? legs[legs.length - 1][2] : tick);

  // The leg under way at `now` (the last one once it is over), or null for no legs.
  function leg_at(legs, now) {
    if (!legs.length) return null;
    for (const leg of legs) if (now < leg[2]) return leg;
    return legs[legs.length - 1];
  }

  function boardings(legs) {
    let n = 0;
    for (const leg of legs) if (leg[0] === RIDE) n += 1;
    return n;
  }

  const fare = age => G.rail.fare(age);

  function station_xy(town, station_id) {
    const p = town.places.get(station_id);
    return [p.entry[0], p.entry[1]];
  }

  function train_xy(town, train_id, tick) {
    const xy = G.rail.train_xy(town, train_id, tick);
    return [xy[0], xy[1]];
  }

  G.folk_transit = {
    WALK, DRIVE, WAIT, RIDE, WALK_MAX, TRAIN_WALK, TRAIN_SAVES, PARK_RIDE_SLACK, REACH, net, minutes, road_leg,
    train_trip, _legs_of, choose, best_minutes, end_of, leg_at, boardings, fare, station_xy, train_xy,
  };
})(globalThis.GameOfAILife || (globalThis.GameOfAILife = {}));

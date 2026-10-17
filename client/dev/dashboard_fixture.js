// Dev fixture for the God-view dashboard: a fake server behind client/dev/dashboard.html.
//
// It speaks the v2 protocol of PLAN.md section 3 for the 80 x 50 town with 60 people and 37 homes:
// - a God welcome: town (3.2), state with lots and homes (3.3), history (80), news (120, importance >= 1),
//   headlines (20, importance 2), llm_log (80 model/timeout summaries), host, and stats with full=true (3.8);
// - state frames when a tick ran or something happened, with events (3.7) and decided-fork summaries (3.6,
//   upserted by id: outcomes and late answers come again); lots/homes only when changed and every 40th frame;
// - a stats push 3 real seconds after the last one (when a tick ran) and 0.5 s after a major event, never
//   while paused; pushes carry only the hourly samples recorded since the previous push;
// - replies to get_stats, get_decisions, get_home, get_agent, set_luck, set_profile, set_speed, pause,
//   resume, with req_id echoed and the error replies of 3.9.
// Every event with an agent lists that agent first in agents (3.7).
// None of it is a real simulation: people wander between places on a script, and events and forks come
// from small templates. Like the server, it never sends hidden information (odds, rolls, scores, outcome
// tables, valence, pending emergencies).
//
// window.DASH_FIXTURE = {
//   town,                                    // the town_json() of 3.2
//   createHost({browser, slow, fresh, seed, speed, frameMs}) -> host
//   createStubView(canvas, opts) -> a plain-canvas stand-in for the CityView facade (3.12) that records calls;
//                                   its input copies P4's camera: a finger hovers only by a 500 ms long-press,
//                                   and arrows/WASD reaching window are logged as "pan" calls
// }
// host.send(msg) answers asynchronously, like a socket; host.onmessage = msg => ... gets every reply and push
// (a JSON copy); host.start() / host.stop() run the frame loop; host.demote() pushes a "demoted".
// Options: browser = the browser port's welcome (host.kind "browser", nobody controlled, llm_log empty);
// slow = the AI player times out on about 40% of asks; fresh = Day 1 Mon 06:00 with no news or samples yet.
"use strict";
(function () {
  const TOWN = {
    "w": 80, "h": 50,
    "tiles": [
      "...#T..T.T......#...T........#............#...T........#..T.....TT..#...T..TT..T",
      "...#.....T....T.#..T...T.....#............#........T.T.#............#T..TTT.....",
      "T..#.T..T.T.....#............#..T...T.....#........T...#............#.....T.T...",
      "################################################################################",
      "...#............#PPPPPPPTPPPP#............#............#...e.....e..#T...T...T..",
      "...#............#PPTPTPPPPPPP#............#............#.BBDB..BBDB.#....T.TT...",
      "...#............#PPPPPPTPPPTP#............#............#.BBBB..BBBB.#T.T........",
      "TT.#.....T......#PTPTPPTPPPPP#............#............#.BBBB..BBBB.#T.T.TT.....",
      "...#T...........#PPPTPPPPPPPP#............#............#............#T....TT...T",
      "...#............#TPPPTPPPPPPP#.BBBBB.BBBBB#.BBBBB.BBBBB#............#...TT.....T",
      ".T.#............#PPPTPPPPPPPP#.BBBBB.BBBBB#.BBBBB.BBBBB#.BBBBB.BBBBB#...T......T",
      ".T.#............#PPPPPPPPPPPP#.BBBBB.BBBBB#.BBBBB.BBBBB#.BBBBB.BBBBB#.T...T.....",
      "...#....T.......#PPPPTPPPPPPP#.BBDBB.BBDBB#.BBDBB.BBDBB#.BBDBB.BBDBB#T....T.....",
      "T..#...T........#TPPPPePPPPPP#...e.....e..#...e.....e..#...e.....e..#.T....T.T..",
      "################################################################################",
      "...#..e...e...e.#...e........#.....e......#............#............#..T...T.T..",
      "...#.BDB.BDB.BDB#.BBDB.......#..BBBDBB....#............#.......PPPPP#TTTT...T.T.",
      ".T.#.BBB.BBB.BBB#.BBBB.......#..BBBBBB....#.BBBBBBBBBB.#.......PTTPP#.T..T.TT.T.",
      "T..#.BBB.BBB.BBB#............#..BBBBBB....#.BBBBBBBBBB.#.......PPPPP#T..T.......",
      "...#............#.BBBBBBBBBB.#..BBBBBB....#.BBBBBBBBBB.#.......PPPPT#.T....T....",
      "...#............#.BBBBBBBBBB.#.BBBBBBBB...#.BBBBBBBBBB.#.......PPPTP#...T.T...TT",
      "...#.BBB.BBB.BBB#.BBBBBBBBBDe#.BBBBBBBB...#.BBBBBBBBBB.#.BBBBB.PPTPP#T..........",
      "T..#.BBB.BBB.BBB#.BBBBBBBBBB.#.BBBBBBBB...#.BBBBBBBBBB.#.BBBBB.PPPPP#T...T.T.T.T",
      "T..#.BDB.BDB.BDB#.BBBBBBBBBB.#.BBBBDBBB...#.BBBBBDBBBB.#.BBDBB.PPPPP#...T..T..TT",
      "T..#..e...e...e.#............#.....e......#......e.....#...e.....e..#.TT..T...T.",
      "################################################################################",
      "...#..e...e...e.#..e...e...e.#...e........#...e.....e..#............#...........",
      "T..#.BDB.BDB.BDB#.BDB.BDB.BDB#.BBDB.......#.BBDBB.PPPPP#............#...........",
      "...#.BBB.BBB.BBB#.BBB.BBB.BBB#.BBBB.......#.BBBBB.PPPPP#.BBBBBBBBBB.#...........",
      "...#.BBB.BBB.BBB#.BBB.BBB.BBB#.BBBB.......#.BBBBB.PPPPP#.BBBBBBBBBB.#...........",
      "...#............#............#............#.BBBBB.TPPPP#.BBBBBBBBBB.#...........",
      "...#............#.BBBBB......#.BBBBBBBBB..#.......PTPPP#.BBBBBBBBBB.#...........",
      "...#.BBB.BBB.BBB#.BBBBB.BBBB.#.BBBBBBBBB..#.......PPPTP#.BBBBBBBBBB.#...........",
      "T..#.BBB.BBB.BBB#.BBBBB.BBBB.#.BBBBBBBBB..#.......PPTPP#.BBBBBBBBBB.#...........",
      "...#.BDB.BDB.BDB#.BBDBB.BBDB.#.BBBBDBBBB..#.......PPPPT#.BBBBBDBBBB.#...........",
      "T..#..e...e...e.#...e.....e..#.....e......#.......PPPPP#......e.....#...........",
      "################################################################################",
      "...#............#PPPPPPePPPPP#PPPPPPPPPPPP#..T.........#............#...........",
      "T.T#...TT..T....#PPPPTPPPPPPP#PPPPPPTPPPPP#............#............#....T....T.",
      "...#......T.....#TPPTTPPPPPPP#TPPPPPPPPPPT#............#............#...........",
      "...#............#PTPPPPPPTPTP#PPPPPPPPPPPP#............#............#........T..",
      "...#....T.T..T..#PPPTPPPPPTPT#PPTTPPTPPPPP#.....T......#............#T..........",
      "...#.....T......#PPPPPPPPPPPP#PPPPTPTPTPPT#......T....T#............#.T........T",
      ".TT#.......T.T..#TPPTPPPPPPPP#PPPPPPPPPPTT#...........T#............#.....T.....",
      "..T#.......T...T#PPTPPPPPPPPP#PPPPPPPPPPPP#........T...#............#...T..T....",
      "................................................................................",
      "~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~",
      "~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~",
      "~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~",
      "~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~"
    ],
    "places": [
      {"id": "cityhall", "name": "City Hall", "kind": "townhall", "x": 32, "y": 16, "w": 6, "h": 4, "entry": [35, 15], "face": "n", "hours": [8, 17], "district": "downtown", "style": "city_hall", "floors": 3, "tier": null, "units": 0},
      {"id": "office", "name": "Brightline Tech", "kind": "office", "x": 31, "y": 20, "w": 8, "h": 4, "entry": [35, 24], "face": "s", "hours": [7, 20], "district": "downtown", "style": "tower", "floors": 8, "tier": null, "units": 0},
      {"id": "hospital", "name": "City Hospital", "kind": "hospital", "x": 44, "y": 17, "w": 10, "h": 7, "entry": [49, 24], "face": "s", "hours": null, "district": "downtown", "style": "hospital", "floors": 4, "tier": null, "units": 0},
      {"id": "cafe", "name": "Corner Cafe", "kind": "cafe", "x": 31, "y": 27, "w": 4, "h": 3, "entry": [33, 26], "face": "n", "hours": [6, 23], "district": "downtown", "style": "cafe", "floors": 2, "tier": null, "units": 0},
      {"id": "arcade", "name": "Grand Arcade", "kind": "shop", "x": 31, "y": 31, "w": 9, "h": 4, "entry": [35, 35], "face": "s", "hours": [9, 21], "district": "downtown", "style": "arcade", "floors": 3, "tier": null, "units": 0},
      {"id": "bank", "name": "Millbrook Savings Bank", "kind": "bank", "x": 44, "y": 27, "w": 5, "h": 4, "entry": [46, 26], "face": "n", "hours": [9, 17], "district": "downtown", "style": "bank", "floors": 4, "tier": null, "units": 0},
      {"id": "school", "name": "Millbrook School", "kind": "school", "x": 18, "y": 19, "w": 10, "h": 5, "entry": [28, 21], "face": "e", "hours": [7, 17], "district": "maple_grove", "style": "school", "floors": 2, "tier": null, "units": 0},
      {"id": "diner", "name": "Oak Street Diner", "kind": "cafe", "x": 18, "y": 16, "w": 4, "h": 2, "entry": [20, 15], "face": "n", "hours": [6, 22], "district": "maple_grove", "style": "diner", "floors": 1, "tier": null, "units": 0},
      {"id": "market", "name": "Fresh Market", "kind": "market", "x": 18, "y": 31, "w": 5, "h": 4, "entry": [20, 35], "face": "s", "hours": [7, 21], "district": "maple_grove", "style": "market", "floors": 1, "tier": null, "units": 0},
      {"id": "bakery", "name": "Maple Bakery", "kind": "cafe", "x": 24, "y": 32, "w": 4, "h": 3, "entry": [26, 35], "face": "s", "hours": [6, 18], "district": "maple_grove", "style": "bakery", "floors": 1, "tier": null, "units": 0},
      {"id": "grocer", "name": "Eastgate Grocer", "kind": "market", "x": 57, "y": 5, "w": 4, "h": 3, "entry": [59, 4], "face": "n", "hours": [7, 22], "district": "eastgate", "style": "corner_shop", "floors": 1, "tier": null, "units": 0},
      {"id": "noodles", "name": "Noodle Bar", "kind": "cafe", "x": 63, "y": 5, "w": 4, "h": 3, "entry": [65, 4], "face": "n", "hours": [11, 24], "district": "eastgate", "style": "noodle_bar", "floors": 2, "tier": null, "units": 0},
      {"id": "works", "name": "Millbrook Works", "kind": "works", "x": 57, "y": 28, "w": 10, "h": 7, "entry": [62, 35], "face": "s", "hours": [6, 22], "district": "the_works", "style": "factory", "floors": 2, "tier": null, "units": 0},
      {"id": "park", "name": "Riverside Park", "kind": "park", "x": 17, "y": 37, "w": 25, "h": 8, "entry": [23, 37], "face": null, "hours": null, "district": "riverside", "style": "park", "floors": 0, "tier": null, "units": 0},
      {"id": "maple_park", "name": "Maple Park", "kind": "park", "x": 17, "y": 4, "w": 12, "h": 10, "entry": [22, 13], "face": null, "hours": null, "district": "maple_grove", "style": "park", "floors": 0, "tier": null, "units": 0},
      {"id": "square", "name": "Fountain Square", "kind": "park", "x": 50, "y": 27, "w": 5, "h": 9, "entry": [52, 26], "face": null, "hours": null, "district": "downtown", "style": "park", "floors": 0, "tier": null, "units": 0},
      {"id": "green", "name": "Eastgate Green", "kind": "park", "x": 63, "y": 16, "w": 5, "h": 8, "entry": [65, 24], "face": null, "hours": null, "district": "eastgate", "style": "park", "floors": 0, "tier": null, "units": 0},
      {"id": "birch_court", "name": "Birch Court", "kind": "home", "x": 57, "y": 10, "w": 5, "h": 3, "entry": [59, 13], "face": "s", "hours": null, "district": "eastgate", "style": "apartments", "floors": 3, "tier": "flat", "units": 6},
      {"id": "cedar_court", "name": "Cedar Court", "kind": "home", "x": 63, "y": 10, "w": 5, "h": 3, "entry": [65, 13], "face": "s", "hours": null, "district": "eastgate", "style": "apartments", "floors": 3, "tier": "flat", "units": 6},
      {"id": "elm_court", "name": "Elm Court", "kind": "home", "x": 57, "y": 21, "w": 5, "h": 3, "entry": [59, 24], "face": "s", "hours": null, "district": "eastgate", "style": "apartments", "floors": 3, "tier": "flat", "units": 6},
      {"id": "park_13", "name": "13 Park Avenue", "kind": "home", "x": 5, "y": 16, "w": 3, "h": 3, "entry": [6, 15], "face": "n", "hours": null, "district": "maple_grove", "style": "house", "floors": 1, "tier": "house", "units": 1},
      {"id": "park_21", "name": "21 Park Avenue", "kind": "home", "x": 9, "y": 16, "w": 3, "h": 3, "entry": [10, 15], "face": "n", "hours": null, "district": "maple_grove", "style": "house", "floors": 1, "tier": "house", "units": 1},
      {"id": "park_29", "name": "29 Park Avenue", "kind": "home", "x": 13, "y": 16, "w": 3, "h": 3, "entry": [14, 15], "face": "n", "hours": null, "district": "maple_grove", "style": "house", "floors": 1, "tier": "house", "units": 1},
      {"id": "main_12", "name": "12 Main Street", "kind": "home", "x": 5, "y": 21, "w": 3, "h": 3, "entry": [6, 24], "face": "s", "hours": null, "district": "maple_grove", "style": "house", "floors": 1, "tier": "house", "units": 1},
      {"id": "main_20", "name": "20 Main Street", "kind": "home", "x": 9, "y": 21, "w": 3, "h": 3, "entry": [10, 24], "face": "s", "hours": null, "district": "maple_grove", "style": "house", "floors": 1, "tier": "house", "units": 1},
      {"id": "main_28", "name": "28 Main Street", "kind": "home", "x": 13, "y": 21, "w": 3, "h": 3, "entry": [14, 24], "face": "s", "hours": null, "district": "maple_grove", "style": "house", "floors": 1, "tier": "house", "units": 1},
      {"id": "main_13", "name": "13 Main Street", "kind": "home", "x": 5, "y": 27, "w": 3, "h": 3, "entry": [6, 26], "face": "n", "hours": null, "district": "maple_grove", "style": "house", "floors": 1, "tier": "house", "units": 1},
      {"id": "main_21", "name": "21 Main Street", "kind": "home", "x": 9, "y": 27, "w": 3, "h": 3, "entry": [10, 26], "face": "n", "hours": null, "district": "maple_grove", "style": "house", "floors": 1, "tier": "house", "units": 1},
      {"id": "main_29", "name": "29 Main Street", "kind": "home", "x": 13, "y": 27, "w": 3, "h": 3, "entry": [14, 26], "face": "n", "hours": null, "district": "maple_grove", "style": "house", "floors": 1, "tier": "house", "units": 1},
      {"id": "river_12", "name": "12 River Road", "kind": "home", "x": 5, "y": 32, "w": 3, "h": 3, "entry": [6, 35], "face": "s", "hours": null, "district": "maple_grove", "style": "house", "floors": 1, "tier": "house", "units": 1},
      {"id": "river_20", "name": "20 River Road", "kind": "home", "x": 9, "y": 32, "w": 3, "h": 3, "entry": [10, 35], "face": "s", "hours": null, "district": "maple_grove", "style": "house", "floors": 1, "tier": "house", "units": 1},
      {"id": "river_28", "name": "28 River Road", "kind": "home", "x": 13, "y": 32, "w": 3, "h": 3, "entry": [14, 35], "face": "s", "hours": null, "district": "maple_grove", "style": "house", "floors": 1, "tier": "house", "units": 1},
      {"id": "main_39", "name": "39 Main Street", "kind": "home", "x": 18, "y": 27, "w": 3, "h": 3, "entry": [19, 26], "face": "n", "hours": null, "district": "maple_grove", "style": "house", "floors": 1, "tier": "house", "units": 1},
      {"id": "main_47", "name": "47 Main Street", "kind": "home", "x": 22, "y": 27, "w": 3, "h": 3, "entry": [23, 26], "face": "n", "hours": null, "district": "maple_grove", "style": "house", "floors": 1, "tier": "house", "units": 1},
      {"id": "main_55", "name": "55 Main Street", "kind": "home", "x": 26, "y": 27, "w": 3, "h": 3, "entry": [27, 26], "face": "n", "hours": null, "district": "maple_grove", "style": "house", "floors": 1, "tier": "house", "units": 1},
      {"id": "park_66", "name": "66 Park Avenue", "kind": "home", "x": 31, "y": 9, "w": 5, "h": 4, "entry": [33, 13], "face": "s", "hours": null, "district": "hilltop", "style": "big_house", "floors": 2, "tier": "big_house", "units": 1},
      {"id": "park_78", "name": "78 Park Avenue", "kind": "home", "x": 37, "y": 9, "w": 5, "h": 4, "entry": [39, 13], "face": "s", "hours": null, "district": "hilltop", "style": "big_house", "floors": 2, "tier": "big_house", "units": 1},
      {"id": "park_92", "name": "92 Park Avenue", "kind": "home", "x": 44, "y": 9, "w": 5, "h": 4, "entry": [46, 13], "face": "s", "hours": null, "district": "hilltop", "style": "big_house", "floors": 2, "tier": "big_house", "units": 1},
      {"id": "park_104", "name": "104 Park Avenue", "kind": "home", "x": 50, "y": 9, "w": 5, "h": 4, "entry": [52, 13], "face": "s", "hours": null, "district": "hilltop", "style": "big_house", "floors": 2, "tier": "big_house", "units": 1}
    ],
    "homes": [
      {"id": "birch_court_1a", "place": "birch_court", "unit": "1A", "name": "Birch Court, flat 1A", "tier": "flat", "bedrooms": 1, "base_value": 7200, "rent": 180},
      {"id": "birch_court_1b", "place": "birch_court", "unit": "1B", "name": "Birch Court, flat 1B", "tier": "flat", "bedrooms": 2, "base_value": 8800, "rent": 220},
      {"id": "birch_court_2a", "place": "birch_court", "unit": "2A", "name": "Birch Court, flat 2A", "tier": "flat", "bedrooms": 1, "base_value": 7200, "rent": 180},
      {"id": "birch_court_2b", "place": "birch_court", "unit": "2B", "name": "Birch Court, flat 2B", "tier": "flat", "bedrooms": 2, "base_value": 8800, "rent": 220},
      {"id": "birch_court_3a", "place": "birch_court", "unit": "3A", "name": "Birch Court, flat 3A", "tier": "flat", "bedrooms": 2, "base_value": 8800, "rent": 220},
      {"id": "birch_court_3b", "place": "birch_court", "unit": "3B", "name": "Birch Court, flat 3B", "tier": "flat", "bedrooms": 3, "base_value": 10400, "rent": 260},
      {"id": "cedar_court_1a", "place": "cedar_court", "unit": "1A", "name": "Cedar Court, flat 1A", "tier": "flat", "bedrooms": 1, "base_value": 7200, "rent": 180},
      {"id": "cedar_court_1b", "place": "cedar_court", "unit": "1B", "name": "Cedar Court, flat 1B", "tier": "flat", "bedrooms": 2, "base_value": 8800, "rent": 220},
      {"id": "cedar_court_2a", "place": "cedar_court", "unit": "2A", "name": "Cedar Court, flat 2A", "tier": "flat", "bedrooms": 1, "base_value": 7200, "rent": 180},
      {"id": "cedar_court_2b", "place": "cedar_court", "unit": "2B", "name": "Cedar Court, flat 2B", "tier": "flat", "bedrooms": 2, "base_value": 8800, "rent": 220},
      {"id": "cedar_court_3a", "place": "cedar_court", "unit": "3A", "name": "Cedar Court, flat 3A", "tier": "flat", "bedrooms": 2, "base_value": 8800, "rent": 220},
      {"id": "cedar_court_3b", "place": "cedar_court", "unit": "3B", "name": "Cedar Court, flat 3B", "tier": "flat", "bedrooms": 3, "base_value": 10400, "rent": 260},
      {"id": "elm_court_1a", "place": "elm_court", "unit": "1A", "name": "Elm Court, flat 1A", "tier": "flat", "bedrooms": 1, "base_value": 7200, "rent": 180},
      {"id": "elm_court_1b", "place": "elm_court", "unit": "1B", "name": "Elm Court, flat 1B", "tier": "flat", "bedrooms": 2, "base_value": 8800, "rent": 220},
      {"id": "elm_court_2a", "place": "elm_court", "unit": "2A", "name": "Elm Court, flat 2A", "tier": "flat", "bedrooms": 1, "base_value": 7200, "rent": 180},
      {"id": "elm_court_2b", "place": "elm_court", "unit": "2B", "name": "Elm Court, flat 2B", "tier": "flat", "bedrooms": 2, "base_value": 8800, "rent": 220},
      {"id": "elm_court_3a", "place": "elm_court", "unit": "3A", "name": "Elm Court, flat 3A", "tier": "flat", "bedrooms": 2, "base_value": 8800, "rent": 220},
      {"id": "elm_court_3b", "place": "elm_court", "unit": "3B", "name": "Elm Court, flat 3B", "tier": "flat", "bedrooms": 3, "base_value": 10400, "rent": 260},
      {"id": "park_13", "place": "park_13", "unit": null, "name": "13 Park Avenue", "tier": "house", "bedrooms": 4, "base_value": 19600, "rent": 0},
      {"id": "park_21", "place": "park_21", "unit": null, "name": "21 Park Avenue", "tier": "house", "bedrooms": 3, "base_value": 19200, "rent": 0},
      {"id": "park_29", "place": "park_29", "unit": null, "name": "29 Park Avenue", "tier": "house", "bedrooms": 3, "base_value": 16000, "rent": 400},
      {"id": "main_12", "place": "main_12", "unit": null, "name": "12 Main Street", "tier": "house", "bedrooms": 2, "base_value": 13600, "rent": 0},
      {"id": "main_20", "place": "main_20", "unit": null, "name": "20 Main Street", "tier": "house", "bedrooms": 3, "base_value": 16800, "rent": 420},
      {"id": "main_28", "place": "main_28", "unit": null, "name": "28 Main Street", "tier": "house", "bedrooms": 3, "base_value": 15200, "rent": 0},
      {"id": "main_13", "place": "main_13", "unit": null, "name": "13 Main Street", "tier": "house", "bedrooms": 4, "base_value": 20800, "rent": 520},
      {"id": "main_21", "place": "main_21", "unit": null, "name": "21 Main Street", "tier": "house", "bedrooms": 3, "base_value": 16400, "rent": 410},
      {"id": "main_29", "place": "main_29", "unit": null, "name": "29 Main Street", "tier": "house", "bedrooms": 3, "base_value": 16800, "rent": 0},
      {"id": "river_12", "place": "river_12", "unit": null, "name": "12 River Road", "tier": "house", "bedrooms": 2, "base_value": 13200, "rent": 0},
      {"id": "river_20", "place": "river_20", "unit": null, "name": "20 River Road", "tier": "house", "bedrooms": 3, "base_value": 15600, "rent": 390},
      {"id": "river_28", "place": "river_28", "unit": null, "name": "28 River Road", "tier": "house", "bedrooms": 3, "base_value": 18400, "rent": 0},
      {"id": "main_39", "place": "main_39", "unit": null, "name": "39 Main Street", "tier": "house", "bedrooms": 2, "base_value": 13200, "rent": 330},
      {"id": "main_47", "place": "main_47", "unit": null, "name": "47 Main Street", "tier": "house", "bedrooms": 3, "base_value": 16000, "rent": 400},
      {"id": "main_55", "place": "main_55", "unit": null, "name": "55 Main Street", "tier": "house", "bedrooms": 4, "base_value": 20000, "rent": 0},
      {"id": "park_66", "place": "park_66", "unit": null, "name": "66 Park Avenue", "tier": "big_house", "bedrooms": 5, "base_value": 46000, "rent": 0},
      {"id": "park_78", "place": "park_78", "unit": null, "name": "78 Park Avenue", "tier": "big_house", "bedrooms": 5, "base_value": 36000, "rent": 0},
      {"id": "park_92", "place": "park_92", "unit": null, "name": "92 Park Avenue", "tier": "big_house", "bedrooms": 5, "base_value": 44000, "rent": 0},
      {"id": "park_104", "place": "park_104", "unit": null, "name": "104 Park Avenue", "tier": "big_house", "bedrooms": 5, "base_value": 40000, "rent": 0}
    ],
    "districts": [
      {"id": "maple_grove", "name": "Maple Grove", "about": "ordinary houses, the school, Fresh Market", "rects": [[4, 4, 12, 10], [17, 4, 12, 10], [4, 15, 12, 10], [17, 15, 12, 10], [4, 26, 12, 10], [17, 26, 12, 10]]},
      {"id": "hilltop", "name": "Hilltop", "about": "big houses with gardens", "rects": [[30, 4, 12, 10], [43, 4, 12, 10]]},
      {"id": "downtown", "name": "Downtown", "about": "offices, hospital, shops, City Hall", "rects": [[30, 15, 12, 10], [43, 15, 12, 10], [30, 26, 12, 10], [43, 26, 12, 10]]},
      {"id": "eastgate", "name": "Eastgate", "about": "cheap flats, corner shops", "rects": [[56, 4, 12, 10], [56, 15, 12, 10]]},
      {"id": "the_works", "name": "The Works", "about": "the factory by the river", "rects": [[56, 26, 12, 10], [69, 26, 11, 10], [56, 37, 12, 9], [69, 37, 11, 9]]},
      {"id": "riverside", "name": "Riverside", "about": "the park along the river", "rects": [[4, 37, 12, 9], [17, 37, 12, 9], [30, 37, 12, 9], [43, 37, 12, 9]]},
      {"id": "east_woods", "name": "East Woods", "about": "woodland at the edge of town", "rects": [[69, 4, 11, 10], [69, 15, 11, 10]]}
    ],
    "streets": [
      {"name": "Willow Lane", "axis": "col", "at": 3},
      {"name": "Oak Street", "axis": "col", "at": 16},
      {"name": "Market Street", "axis": "col", "at": 29},
      {"name": "Bank Street", "axis": "col", "at": 42},
      {"name": "Elm Road", "axis": "col", "at": 55},
      {"name": "Mill Road", "axis": "col", "at": 68},
      {"name": "North Road", "axis": "row", "at": 3},
      {"name": "Park Avenue", "axis": "row", "at": 14},
      {"name": "Main Street", "axis": "row", "at": 25},
      {"name": "River Road", "axis": "row", "at": 36}
    ],
    "stops": [
      {"id": "maple_west", "name": "Maple Grove West", "x": 10, "y": 25, "lines": ["1", "2"]},
      {"id": "school", "name": "Millbrook School", "x": 28, "y": 25, "lines": ["1", "2"]},
      {"id": "downtown_west", "name": "Brightline Tech", "x": 36, "y": 25, "lines": ["1", "2"]},
      {"id": "downtown_east", "name": "City Hospital", "x": 48, "y": 25, "lines": ["1", "2"]},
      {"id": "eastgate_south", "name": "Elm Court", "x": 60, "y": 25, "lines": ["1", "2"]},
      {"id": "eastgate_north", "name": "Birch Court", "x": 60, "y": 14, "lines": ["1", "2"]},
      {"id": "hilltop_east", "name": "Hilltop", "x": 49, "y": 14, "lines": ["1", "2"]},
      {"id": "city_hall", "name": "City Hall", "x": 36, "y": 14, "lines": ["1", "2"]},
      {"id": "school_north", "name": "Millbrook School North", "x": 28, "y": 14, "lines": ["1", "2"]},
      {"id": "maple_park", "name": "Maple Park", "x": 21, "y": 14, "lines": ["1", "2"]},
      {"id": "maple_north", "name": "Maple Grove North", "x": 10, "y": 14, "lines": ["1", "2"]}
    ],
    "housing": {"tiers": {"flat": {"label": "flat", "rank": 1}, "house": {"label": "house", "rank": 2}, "big_house": {"label": "big house", "rank": 3}}, "stages": [{"name": "kept", "min": 80}, {"name": "worn", "min": 60}, {"name": "shabby", "min": 40}, {"name": "neglected", "min": 20}, {"name": "derelict", "min": 0}], "landlord": "Millbrook Homes"},
    "road_rows": [3, 14, 25, 36], "road_cols": [3, 16, 29, 42, 55, 68], "road_col_end": 44,
    "junctions": [[3, 3], [16, 3], [29, 3], [42, 3], [55, 3], [68, 3], [3, 14], [16, 14], [29, 14], [42, 14], [55, 14], [68, 14], [3, 25], [16, 25], [29, 25], [42, 25], [55, 25], [68, 25], [3, 36], [16, 36], [29, 36], [42, 36], [55, 36], [68, 36]],
    "timetable": {"bus": {"lines": [{"id": "1", "name": "No. 1 (clockwise: Main Street east, Park Avenue west)", "corners": [[3, 25], [68, 25], [68, 14], [3, 14]], "stops": ["maple_west", "school", "downtown_west", "downtown_east", "eastgate_south", "eastgate_north", "hilltop_east", "city_hall", "school_north", "maple_park", "maple_north"], "lap_minutes": 52, "buses": 4, "every_minutes": 13, "speed": 4, "dwell": 1, "fare": 2}, {"id": "2", "name": "No. 2 (anticlockwise: Park Avenue east, Main Street west)", "corners": [[3, 25], [3, 14], [68, 14], [68, 25]], "stops": ["maple_north", "maple_park", "school_north", "city_hall", "hilltop_east", "eastgate_north", "eastgate_south", "downtown_east", "downtown_west", "school", "maple_west"], "lap_minutes": 52, "buses": 4, "every_minutes": 13, "speed": 4, "dwell": 1, "fare": 2}]}, "flights": ["08:00 Riverton to Lakeside", "14:00 Riverton to Lakeside", "20:00 Riverton to Lakeside"]}
  };

  const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const TICKS_PER_REAL_SECOND = 1440 / 600;
  const CONTROLLER = "claude";
  const MODEL = "claude-haiku-5-5";
  const TRAITS = ["thrift", "family", "social", "diligence", "health", "adventure"];
  const NEEDS = ["hunger", "energy", "social", "fun"];
  const STAGE_NAMES = ["kept", "worn", "shabby", "neglected", "derelict"];
  const TIER_LABEL = { flat: "flat", house: "house", big_house: "big house" };
  const LANDLORD = "Millbrook Homes";

  // tag: [kind, importance], the rows of PLAN 3.7 this fixture emits
  const TAGS = {
    death: ["death", 2], hospital: ["health", 2], discharged: ["health", 1], injury: ["outcome", 1],
    big_money: ["outcome", 2], money_swing: ["outcome", 1], outcome: ["outcome", 0], goal_reached: ["goal", 2],
    saving: ["money", 0], bills_paid: ["money", 0], pension: ["money", 0], in_the_red: ["money", 1],
    in_the_red_again: ["money", 2], hardship: ["money", 1], help_given: ["money", 2], car_sold: ["money", 1],
    stuff_sold: ["money", 1], richest: ["money", 2], first_meet: ["social", 1], new_friend: ["social", 2],
    falling_out: ["social", 2], invite: ["social", 0], invite_accepted: ["social", 1], invite_declined: ["social", 0],
    meetup: ["social", 0], family_dinner: ["social", 1], errand: ["social", 0], call: ["social", 0],
    text: ["message", 0], weather: ["weather", 0], closed: ["life", 0], home_bought: ["home", 2],
    home_rented: ["home", 2], evicted: ["home", 2], forced_sale: ["home", 2], nowhere_to_go: ["home", 2],
    home_listed: ["home", 2], neglect: ["home", 2], falling_apart: ["home", 2], shabby: ["home", 1],
    restored: ["home", 1], too_late: ["home", 1], emergency: ["home", 1], emergency_settled: ["home", 0],
    repaint: ["home", 0], damp_chill: ["health", 1], controller_joined: ["controller", 1],
    controller_left: ["controller", 1],
  };

  // Households in creation order: id, home id at the start, name. The first 8 are the named families.
  const HOUSEHOLDS = [
    ["cohen", "main_20", "The Cohens"], ["levi", "main_28", "The Levis"], ["bendavid", "birch_court_2b", "Ari Ben-David"],
    ["mizrahi", "main_13", "The Mizrahis"], ["peretz", "cedar_court_1b", "The Peretzes"],
    ["friedman", "park_78", "The Friedmans"], ["katz", "park_21", "The Katzes"], ["haddad", "main_21", "The Haddads"],
    ["sasson", "birch_court_1a", "Tamar Sasson"], ["shapiro", "birch_court_1b", "The Shapiros"],
    ["avraham", "birch_court_2a", "The Avrahams"], ["tal", "birch_court_3a", "Lea Tal"],
    ["amar", "birch_court_3b", "Merav Amar"], ["mansour", "cedar_court_1a", "The Mansours"],
    ["rosen", "cedar_court_2a", "The Rosens"], ["weiss", "cedar_court_2b", "The Weisses"],
    ["klein", "cedar_court_3a", "Noga Klein"], ["carmel", "elm_court_1b", "Ronen Carmel"],
    ["barak", "elm_court_2a", "Efrat Barak"], ["gold", "elm_court_3b", "The Golds"], ["ezra", "park_13", "The Ezras"],
    ["navon", "park_29", "The Navons"], ["segal", "main_12", "The Segals"], ["elbaz", "main_29", "The Elbazes"],
    ["nassar", "river_20", "The Nassars"], ["golan", "main_47", "The Golans"], ["halabi", "park_92", "The Halabis"],
  ];
  const OWNED_AT_START = ["park_13", "park_21", "main_12", "main_28", "main_29", "park_78", "park_92"];
  const FOR_RENT = ["cedar_court_3b", "elm_court_1a", "elm_court_2b", "elm_court_3a", "main_39"];
  const FOR_SALE = ["river_12", "river_28", "main_55", "park_66", "park_104"];
  // Lot conditions on Day 13: all five stages are on the map (22 lots: 9 kept, 9 worn, 2 shabby, 1 neglected,
  // 1 derelict).
  const CONDITION = {
    birch_court: 84, cedar_court: 71, elm_court: 62, park_13: 80, park_21: 88, park_29: 82, main_12: 36,
    main_20: 79, main_28: 63, main_13: 84, main_21: 78, main_29: 73, river_12: 55, river_20: 80, river_28: 18,
    main_39: 84, main_47: 76, main_55: 67, park_66: 91, park_78: 41, park_92: 88, park_104: 69,
  };

  // id, name, age, household, job title, job place, hourly wage, [start, end], workdays (0 = Mon), car,
  // cash, savings, savings goal [name, target, saved]
  const CAST = [
    ["dana", "Dana Cohen", 38, "cohen", "software engineer", "office", 55, [9, 17], "01234", true, 1240, 14600],
    ["yossi", "Yossi Cohen", 40, "cohen", "nurse", "hospital", 38, [7, 15], "01236", false, 610, 5000],
    ["noa", "Noa Cohen", 10, "cohen", "student", "school", 0, [8, 14], "01234", false, 20, 0],
    ["miriam", "Miriam Levi", 67, "levi", null, null, 0, null, "", false, 1500, 2000],
    ["tom", "Tom Levi", 29, "levi", "barista", "cafe", 18, [7, 14], "12345", false, 250, 0, ["a guitar", 450, 120]],
    ["ari", "Ari Ben-David", 24, "bendavid", "junior developer", "office", 32, [10, 18], "01234", false, 412, 2500,
      ["a new phone", 300, 180]],
    ["avi", "Avi Mizrahi", 45, "mizrahi", "teacher", "school", 30, [8, 15], "01234", true, 700, 2500],
    ["rina", "Rina Mizrahi", 43, "mizrahi", "doctor", "hospital", 70, [8, 16], "01234", false, 1100, 19000],
    ["lior", "Lior Mizrahi", 16, "mizrahi", "student", "school", 0, [8, 15], "01234", false, 60, 0, ["a bike", 200, 45]],
    ["maya", "Maya Mizrahi", 8, "mizrahi", "student", "school", 0, [8, 13], "01234", false, 10, 0],
    ["eli", "Eli Peretz", 33, "peretz", "cashier", "grocer", 17, [8, 16], "01245", false, -192, 0,
      ["a weekend trip", 600, 0]],
    ["shira", "Shira Peretz", 31, "peretz", "nurse", "hospital", 38, [14, 22], "01234", false, -84, 0],
    ["ruth", "Ruth Friedman", 72, "friedman", null, null, 0, null, "", false, 2200, 4000],
    ["david", "David Friedman", 74, "friedman", null, null, 0, null, "", true, 1800, 2000],
    ["omer", "Omer Katz", 36, "katz", "product manager", "office", 60, [9, 18], "01234", true, 1300, 5000],
    ["gal", "Gal Katz", 35, "katz", "graphic designer", "office", 40, [10, 16], "01234", false, 800, 1500,
      ["a drawing tablet", 350, 200]],
    ["yael", "Yael Katz", 6, "katz", "student", "school", 0, [8, 13], "01234", false, 5, 0],
    ["nadia", "Nadia Haddad", 41, "haddad", "store manager", "market", 28, [7, 15], "012345", false, 950, 3000],
    ["sami", "Sami Haddad", 44, "haddad", "chef", "cafe", 24, [11, 20], "02345", false, 400, 500],
    ["leila", "Leila Haddad", 12, "haddad", "student", "school", 0, [8, 14], "01234", false, 25, 0],
    ["tamar", "Tamar Sasson", 74, "sasson", null, null, 0, null, "", false, 1800, 3200],
    ["sivan", "Sivan Shapiro", 48, "shapiro", "hospital cleaner", "hospital", 16, [6, 14], "01234", false, 180, 300],
    ["omar", "Omar Shapiro", 48, "shapiro", "warehouse worker", "works", 21, [6, 14], "01234", false, 240, 150],
    ["rotem", "Rotem Avraham", 45, "avraham", "park keeper", "green", 19, [7, 15], "01234", false, 220, 400],
    ["boaz", "Boaz Avraham", 5, "avraham", "student", "school", 0, [8, 13], "01234", false, 12, 0],
    ["lea", "Lea Tal", 25, "tal", "waiter", "noodles", 16, [16, 23], "12345", false, 160, 120],
    ["merav", "Merav Amar", 41, "amar", "cook", "noodles", 22, [15, 23], "12345", true, 640, 1800],
    ["ido", "Ido Mansour", 41, "mansour", "packer", "works", 18, [8, 16], "01234", false, 210, 500],
    ["avigail", "Avigail Mansour", 37, "mansour", "counter assistant", "bakery", 16, [7, 14], "34560", false, 150, 300],
    ["guy", "Guy Rosen", 50, "rosen", "cashier", "grocer", 16, [14, 22], "01234", false, 120, 200],
    ["mor", "Mor Rosen", 46, "rosen", "shopkeeper", "grocer", 24, [7, 15], "012345", false, 520, 1100],
    ["yoav", "Yoav Rosen", 12, "rosen", "student", "school", 0, [8, 14], "01234", false, 15, 0],
    ["hila", "Hila Weiss", 41, "weiss", "nurse", "hospital", 38, [7, 15], "01234", false, 700, 2600],
    ["noam", "Noam Weiss", 10, "weiss", "student", "school", 0, [8, 14], "01234", false, 18, 0],
    ["noga", "Noga Klein", 28, "klein", "warehouse worker", "works", 21, [14, 22], "01234", false, 260, 90],
    ["ronen", "Ronen Carmel", 49, "carmel", "shop assistant", "arcade", 17, [9, 17], "01234", false, 300, 640],
    ["efrat", "Efrat Barak", 25, "barak", "data analyst", "office", 42, [9, 17], "01234", false, 980, 3400,
      ["a holiday", 800, 310]],
    ["sara", "Sara Gold", 43, "gold", "receptionist", "office", 20, [8, 16], "01234", false, 190, 250],
    ["eitan", "Eitan Gold", 46, "gold", "barista", "cafe", 18, [14, 22], "23456", false, 140, 80],
    ["itai", "Itai Gold", 15, "gold", "student", "school", 0, [8, 15], "01234", false, 30, 0],
    ["galit", "Galit Ezra", 50, "ezra", "teacher", "school", 30, [8, 15], "01234", false, 900, 3100],
    ["roee", "Roee Ezra", 51, "ezra", "teacher", "school", 30, [8, 15], "01234", true, 720, 2400],
    ["rami", "Rami Ezra", 11, "ezra", "student", "school", 0, [8, 14], "01234", false, 20, 0],
    ["amir", "Amir Navon", 33, "navon", "clerk", "cityhall", 26, [8, 16], "01234", true, 560, 1500,
      ["driving lessons", 600, 240]],
    ["michal", "Michal Navon", 31, "navon", "cashier", "market", 17, [13, 21], "12345", true, 230, 420],
    ["rana", "Rana Navon", 9, "navon", "student", "school", 0, [8, 13], "01234", false, 8, 0],
    ["asaf", "Asaf Segal", 80, "segal", null, null, 0, null, "", true, 2100, 4200],
    ["dalia", "Dalia Segal", 82, "segal", null, null, 0, null, "", false, 1400, 3800],
    ["uri", "Uri Elbaz", 24, "elbaz", "baker", "bakery", 22, [6, 14], "012345", true, 480, 900],
    ["inbal", "Inbal Elbaz", 27, "elbaz", "bank teller", "bank", 24, [9, 17], "01234", true, 610, 1300],
    ["yarden", "Yarden Nassar", 30, "nassar", "paramedic", "hospital", 30, [10, 18], "56012", true, 690, 2100],
    ["elad", "Elad Nassar", 7, "nassar", "student", "school", 0, [8, 13], "01234", false, 14, 0],
    ["ben", "Ben Nassar", 6, "nassar", "student", "school", 0, [8, 13], "01234", false, 9, 0],
    ["tomer", "Tomer Golan", 29, "golan", "shop assistant", "arcade", 17, [13, 21], "23456", false, 140, 60],
    ["hana", "Hana Golan", 27, "golan", "foreman", "works", 32, [7, 15], "01234", false, 820, 1900,
      ["a sofa", 400, 150]],
    ["ziv", "Ziv Golan", 71, "golan", null, null, 0, null, "", true, 1300, 2400],
    ["yasmin", "Yasmin Halabi", 31, "halabi", "branch manager", "bank", 55, [9, 17], "01234", true, 3200, 12500],
    ["nir", "Nir Halabi", 30, "halabi", "surgeon", "hospital", 85, [8, 16], "0123", true, 3800, 19000],
    ["keren", "Keren Halabi", 6, "halabi", "student", "school", 0, [8, 13], "01234", false, 30, 0],
    ["amira", "Amira Halabi", 10, "halabi", "student", "school", 0, [8, 14], "01234", false, 22, 0],
  ];
  const FRIENDS = [["tom", "ari", 55], ["dana", "ari", 30], ["yossi", "miriam", 40], ["rina", "shira", 50],
    ["gal", "dana", 45], ["omer", "avi", 35], ["noa", "leila", 60], ["maya", "yael", 50], ["lior", "tom", 25],
    ["ruth", "miriam", 65], ["sami", "eli", 40], ["nadia", "rina", 30], ["lea", "efrat", 48], ["hila", "yossi", 44],
    ["nir", "rina", 38], ["tamar", "dalia", 52], ["tomer", "noga", 41], ["inbal", "yasmin", 36]];
  const LUCK = { dana: 62, eli: 35, ruth: 70, tom: 58, nir: 40 };   // God has touched five people so far

  const LEISURE = ["cafe", "maple_park", "park", "square", "green", "arcade", "diner", "bakery", "noodles", "market"];
  const ACTIVITY_AT = { cafe: "coffee", diner: "eat_out", bakery: "coffee", noodles: "eat_out", park: "walk",
    maple_park: "walk", square: "hang_out", green: "walk", arcade: "shopping", market: "groceries",
    grocer: "groceries", hospital: "hospital", school: "school" };

  function rng(seed) {   // mulberry32, as in gameofailife/rng.py
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const round = x => Math.floor(x + 0.5);
  const r1 = x => Math.floor(x * 10 + 0.5) / 10;
  const r2 = x => Math.floor(x * 100 + 0.5) / 100;
  const round50 = x => Math.floor(x / 50 + 0.5) * 50;
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const money = n => (n < 0 ? "−$" : "$") + Math.abs(round(n)).toLocaleString("en-US");
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  function stamp(tick) {
    const day = Math.floor(tick / 1440), m = tick % 1440;
    return `Day ${day + 1} ${DAY_NAMES[day % 7]} ${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  }
  const stageOf = c => (c >= 80 ? 0 : c >= 60 ? 1 : c >= 40 ? 2 : c >= 20 ? 3 : 4);
  const median = xs => {
    if (!xs.length) return 0;
    const s = xs.slice().sort((a, b) => a - b), n = s.length;
    return n % 2 ? s[(n - 1) >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2;
  };
  const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  function gini(xs) {
    const s = xs.map(x => Math.max(0, x)).sort((a, b) => a - b), n = s.length, total = s.reduce((a, b) => a + b, 0);
    if (!n || !total) return 0;
    let acc = 0;
    s.forEach((x, i) => { acc += (i + 1) * x; });
    return Math.floor((2 * acc / (n * total) - (n + 1) / n) * 100 + 0.5) / 100;
  }

  const placeById = {};
  for (const p of TOWN.places) placeById[p.id] = p;
  const homeSpec = {};
  for (const h of TOWN.homes) homeSpec[h.id] = h;
  const districtName = {};
  for (const d of TOWN.districts) districtName[d.id] = d.name;
  const ROWS = TOWN.road_rows, COLS = TOWN.road_cols;

  // --- paths on the road grid (good enough for a stand-in map) -------------------------------------------

  function isRoad(x, y) { return TOWN.tiles[y] && TOWN.tiles[y][x] === "#"; }
  function roadNext(xy) {
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) if (isRoad(xy[0] + dx, xy[1] + dy)) return [xy[0] + dx, xy[1] + dy];
    return xy;
  }
  const nearestOf = (list, v) => list.reduce((b, c) => (Math.abs(c - v) < Math.abs(b - v) ? c : b), list[0]);
  function roadPath(from, to) {
    const a = roadNext(from), b = roadNext(to), pts = [from, a];
    let cur = a;
    if (!ROWS.includes(cur[1])) { cur = [cur[0], nearestOf(ROWS, cur[1])]; pts.push(cur); }
    const endRow = ROWS.includes(b[1]) ? b : [b[0], nearestOf(ROWS, b[1])];
    if (cur[1] !== endRow[1]) {
      const c = COLS.reduce((best, k) => (Math.abs(cur[0] - k) + Math.abs(endRow[0] - k) <
        Math.abs(cur[0] - best) + Math.abs(endRow[0] - best) ? k : best), COLS[0]);
      pts.push([c, cur[1]], [c, endRow[1]]);
    }
    pts.push(endRow, b, to);
    const out = [];
    let [x, y] = pts[0];
    for (const [tx, ty] of pts.slice(1)) {
      while (x !== tx || y !== ty) {
        if (x !== tx) x += Math.sign(tx - x); else y += Math.sign(ty - y);
        out.push([x, y]);
      }
    }
    return out;
  }
  const BUS_LOOP = (() => {
    const c = TOWN.timetable.bus.lines[0].corners, out = [];
    for (let i = 0; i < c.length; i++) {
      let [x, y] = c[i];
      const [tx, ty] = c[(i + 1) % c.length];
      while (x !== tx || y !== ty) { out.push([x, y]); if (x !== tx) x += Math.sign(tx - x); else y += Math.sign(ty - y); }
    }
    return out;
  })();

  // --- fork templates (questions, 4 options, reasons, what can come of them) -----------------------------

  const FORK = {
    work: {
      q: (a, w) => `It's ${w.hm} and work starts at ${a.job.hours[0]}:00 at ${placeById[a.job.place].name}. How do you go?`,
      o: a => [a.car ? "Drive to work" : "Take the No. 1 bus", "Walk to work", "Grab a coffee at Corner Cafe first",
        "Call in sick and stay home"],
      r: ["I'm running late and it's raining.", "A walk clears my head before a long shift.",
        "I need the coffee more than the extra ten minutes.", "Honestly I'm wiped out today."],
      h: [["Minor fender bender (−$150)"], ["Arrives right on time"], ["Bumps into an old friend"], []],
    },
    hunger: {
      q: () => "You're getting hungry. What do you do?",
      o: () => ["Cook something at home", "Eat at Oak Street Diner ($14)", "Grab noodles at Noodle Bar ($11)",
        "Skip it for now"],
      r: ["There's still food in the fridge.", "I deserve a proper meal tonight.", "Quick and cheap, perfect.",
        "I'll eat later, I'm in the middle of something."],
      h: [["A really good dinner"], [], ["Gets food poisoning"], []],
    },
    sleep: {
      q: (a, w) => `It's ${w.hm} and you're tired. What now?`,
      o: () => ["Go to bed", "Watch one more episode", "Read for a while", "Stay up late gaming"],
      r: ["Early start tomorrow.", "Just one more, it's a cliffhanger.", "Reading always helps me drift off.",
        "It's the weekend, why not."],
      h: [["Sleeps deeply"], ["Oversleeps"], [], []],
    },
    payday: {
      q: () => "Payday: your wages came in. What do you do with some of it?",
      o: () => ["Put $200 into savings", "Buy something nice at Grand Arcade ($60)", "Treat the family to dinner ($80)",
        "Leave it in the account"],
      r: ["Every bit towards the goal counts.", "I've earned a treat this week.", "It's been a hard week for all of us.",
        "Better to keep a cushion."],
      h: [[], ["Finds a bargain"], ["A lovely evening together"], []],
    },
    groceries: {
      q: () => "The fridge is nearly empty (2 meals left). What do you do?",
      o: () => ["Shop at Fresh Market ($35)", "Shop at Eastgate Grocer ($38)", "Ask someone at home to pick some up",
        "Order a takeaway tonight ($25)"],
      r: ["Fresh Market is on the way.", "Eastgate Grocer is right next door.", "They're passing the shop anyway.",
        "Too tired to shop tonight."],
      h: [[], [], ["They forget the milk"], []],
    },
    lonely: {
      q: () => "You feel lonely. What do you do?",
      o: (a, w) => [`Call ${w.friend}`, `Invite ${w.friend} to Corner Cafe`, "Go for a walk in Maple Park", "Text a friend"],
      r: ["I haven't heard their voice in ages.", "A coffee together would be nice.", "Some fresh air will help.",
        "A quick message is enough for now."],
      h: [["A long, warm chat"], ["They say yes"], ["Meets someone new"], []],
    },
    free_time: {
      q: () => "You have a free evening. What do you do?",
      o: () => ["See a film at Grand Arcade ($15)", "Walk in Riverside Park", "Stay in and relax", "Visit Fountain Square"],
      r: ["There's a new film out.", "The river is lovely at this hour.", "I just want a quiet night.",
        "There's music at the square tonight."],
      h: [["Loves the film"], ["Sees a heron"], [], ["Makes a breakthrough (+$50)"]],
    },
    invite: {
      q: (a, w) => `${w.friend} invites you to Corner Cafe at 18:00. Do you go?`,
      o: () => ["Accept", "Decline politely", "Suggest another day", "Ignore it"],
      r: ["I'd love to see them.", "Not tonight, I'm exhausted.", "This week is packed.", "I'm not in the mood."],
      h: [["A great evening"], [], [], []],
    },
    upkeep: {
      q: (a, w) => `${w.homeName} is looking worn. What do you do?`,
      o: () => ["Hire builders ($380)", "Do it yourself this weekend ($50)", "Tidy up a bit ($10)", "Leave it for now"],
      r: ["Better to fix it properly now.", "I can handle a paintbrush.", "A tidy-up will do for now.",
        "Money is too tight this month."],
      h: [["The house looks better"], ["Slips off the ladder"], [], []],
    },
    house_hunt: {
      q: () => "28 River Road is for sale at $14,550 (house, derelict). The household has about $21,500. What do you do?",
      o: () => ["Buy 28 River Road (house, derelict) for $14,550", "Rent 39 Main Street (house) at $330/week",
        "Keep looking", "Stay where you are"],
      r: ["We can fix it up and stop paying rent.", "A smaller rent would help.", "Nothing feels right yet.",
        "The kids are settled here."],
      h: [[], [], [], []],
      major: true,
    },
    housing_trouble: {
      q: () => "The household is $640 in the red after the week's bills. What do you do?",
      o: () => ["Rent Elm Court, flat 1A at $180/week", "Ask Rina Mizrahi for help", "Cut back on everything",
        "Hope next week is better"],
      r: ["A cheaper flat would get us back on our feet.", "Rina said to ask if we ever needed anything.",
        "We can live on less for a while.", "Payday is coming."],
      h: [[], ["Rina says yes"], [], []],
      major: true,
    },
  };

  // --- the world -------------------------------------------------------------------------------------

  function buildWorld(opt) {
    const R = rng(opt.seed || 7);
    const ri = (lo, hi) => lo + Math.floor(R() * (hi - lo + 1));
    const pick = xs => xs[Math.floor(R() * xs.length)];
    const W = { R, ri, pick, tick: opt.fresh ? 360 : 12 * 1440 + 16 * 60, seq: 0, forkSeq: 1200, events: [],
      frameForks: [], agents: [], byId: {}, hh: {}, homes: {}, lots: {}, deaths: [], llmRing: [], weather: "clear",
      counters: null, samples: [], newSamples: [], later: [], frames: 0, browser: !!opt.browser, slow: !!opt.slow };
    W.counters = opt.fresh || opt.browser ? freshCounters() : startCounters(opt.slow);

    for (const [id, home, name] of HOUSEHOLDS) W.hh[id] = { id, home, name, members: [], history: [] };
    for (const h of TOWN.homes) {
      W.homes[h.id] = { id: h.id, owner: "landlord", hh: null, listing: null, emergency: null, history: [] };
    }
    for (const p of TOWN.places) if (p.kind === "home") {
      W.lots[p.id] = { condition: opt.fresh ? CONDITION[p.id] + 6 : CONDITION[p.id], works: false, moving: false };
    }
    for (const id of FOR_RENT) W.homes[id].listing = "for_rent";
    for (const id of FOR_SALE) Object.assign(W.homes[id], { owner: "market", listing: "for_sale" });
    for (const hh of Object.values(W.hh)) {
      const home = W.homes[hh.home];
      home.hh = hh.id;
      if (OWNED_AT_START.includes(hh.home)) home.owner = hh.id;
      const how = home.owner === hh.id ? "bought" : "rented";
      hh.history.push({ time: "Day 1 Mon 06:00", event: how, home: hh.home, name: homeSpec[hh.home].name,
        price: how === "bought" ? valueOf(W, hh.home) : homeSpec[hh.home].rent });
      home.history.push({ tick: 360, time: "Day 1 Mon 06:00", event: how, household: hh.id,
        price: how === "bought" ? valueOf(W, hh.home) : homeSpec[hh.home].rent });
    }
    const controlled = new Set();
    if (!opt.browser) {
      for (const row of CAST) if (row[2] >= 16 && controlled.size < 40) controlled.add(row[0]);
    }
    for (const row of CAST) {
      const [id, name, age, hh, title, place, wage, hours, days, car, cash, savings, goal] = row;
      const traits = {};
      for (const t of TRAITS) traits[t] = Math.floor((0.2 + 0.6 * R()) * 100 + 0.5) / 100;
      const needs = {};
      for (const n of NEEDS) needs[n] = 45 + R() * 45;
      const a = {
        id, name, first: name.split(" ")[0], age, hh, car,
        job: title ? { title, place, hourly_wage: wage, hours, workdays: days.split("").map(Number) } : null,
        cash, savings, goal: goal ? { name: goal[0], target: goal[1], saved: goal[2] } : null,
        luck: LUCK[id] || 50, health: 70 + R() * 28, needs, reputation: ri(40, 75),
        controller: controlled.has(id) ? CONTROLLER : null, alive: true, state: "busy", activity: "relax_home",
        inside: null, x: 0, y: 0, vehicle: "walk", plan: null, nextAt: 0, decide: null, traits,
        prompt: "", edited: false, learned: 0, rel: {}, memory: [], forks: [], llmForks: [], worthRing: [],
      };
      a.prompt = describe(a);
      W.agents.push(a);
      W.byId[id] = a;
      W.hh[hh].members.push(id);
    }
    for (const hh of Object.values(W.hh)) {
      for (const m of hh.members) for (const o of hh.members) if (m !== o) {
        const both = W.byId[m].age >= 18 && W.byId[o].age >= 18 && Math.abs(W.byId[m].age - W.byId[o].age) <= 10;
        W.byId[m].rel[o] = { kind: both ? "partner" : "family", affinity: 75, trust: 70 };
      }
    }
    for (const [a, b, aff] of FRIENDS) {
      W.byId[a].rel[b] = { kind: "friend", affinity: aff, trust: 55 };
      W.byId[b].rel[a] = { kind: "friend", affinity: aff, trust: 55 };
    }
    const byJob = {};
    for (const a of W.agents) if (a.job && a.job.hourly_wage > 0) (byJob[a.job.place] = byJob[a.job.place] || []).push(a.id);
    for (const ids of Object.values(byJob)) for (const x of ids) for (const y of ids) {
      if (x !== y && !W.byId[x].rel[y]) W.byId[x].rel[y] = { kind: "coworker", affinity: ri(15, 35), trust: 40 };
    }
    if (!opt.fresh) {
      // David Friedman died in his sleep on Day 12.
      const david = W.byId.david;
      david.alive = false;
      david.state = "dead";
      david.activity = "dead";
      Object.assign(david, { x: 39, y: 13, inside: null });
      W.deaths.push({ id: "david", name: david.name, age: 74, time: "Day 12 Fri 00:00",
        how: "passed away peacefully in their sleep" });
      W.lots.main_28.condition = 63;
    }
    // Where everyone is at the start.
    const wd = Math.floor(W.tick / 1440) % 7, hour = (W.tick % 1440) / 60;
    for (const a of W.agents) {
      if (!a.alive) continue;
      let at = homePlace(W, a);
      if (onShift(a, wd, hour)) at = a.job.place;
      else if (!opt.fresh && R() < 0.45) at = pick(LEISURE);
      enter(W, a, at);
      a.nextAt = W.tick + ri(5, 160);
    }
    // Worth 24 game hours ago, and the hourly ring in between.
    for (const a of W.agents) {
      const now = worthParts(W, a).worth;
      const span = a.age < 18 ? ri(0, 12) : a.job ? ri(-140, 520) : ri(-90, 40);
      for (let i = 0; i < 25; i++) a.worthRing.push(round(now - span + span * i / 24 + (i && i < 24 ? ri(-30, 30) : 0)));
    }
    if (!opt.fresh) backfill(W, opt);
    return W;
  }

  function freshCounters() {
    const z = () => ({ asked: 0, in_time: 0, timeouts: 0, late: 0, withdrawn: 0, against_habit: 0, seconds: 0 });
    return { today: z(), total: z(), habit_today: 0, default_today: 0 };
  }
  function startCounters(slow) {
    const c = freshCounters();
    Object.assign(c.today, slow ? { asked: 58, in_time: 33, timeouts: 25, late: 6, against_habit: 9, seconds: 33 * 3.7 }
      : { asked: 96, in_time: 83, timeouts: 13, late: 4, against_habit: 22, seconds: 83 * 2.4 });
    Object.assign(c.total, slow ? { asked: 1210, in_time: 760, timeouts: 446, late: 120, withdrawn: 4, against_habit: 190, seconds: 760 * 3.6 }
      : { asked: 1530, in_time: 1300, timeouts: 228, late: 70, withdrawn: 2, against_habit: 402, seconds: 1300 * 2.6 });
    c.habit_today = 41;
    c.default_today = 12;
    return c;
  }

  function describe(a) {
    const t = a.traits, bits = [];
    if (t.thrift > 0.6) bits.push("is careful with money"); else if (t.thrift < 0.35) bits.push("is happy to spend");
    if (t.family > 0.6) bits.push("puts family first");
    if (t.social > 0.6) bits.push("loves company"); else if (t.social < 0.35) bits.push("likes quiet evenings");
    if (t.diligence > 0.6) bits.push("rarely misses work");
    if (t.adventure > 0.6) bits.push("is up for anything new");
    if (!bits.length) bits.push("is steady and easy-going");
    const last = bits.pop();
    return `${a.first} ${bits.length ? `${bits.join(", ")} and ${last}` : last}.`;
  }

  function onShift(a, weekday, hour) {
    return !!(a.job && a.job.workdays.includes(weekday) && a.job.hours[0] <= hour && hour < a.job.hours[1]);
  }
  function homePlace(W, a) { return homeSpec[W.hh[a.hh].home].place; }
  function enter(W, a, placeId) {
    const p = placeById[placeId];
    a.inside = placeId;
    [a.x, a.y] = p.entry;
    a.plan = null;
    a.vehicle = "walk";
    a.state = "busy";
    a.activity = placeId === homePlace(W, a) ? ((W.tick % 1440) / 60 >= 22 || (W.tick % 1440) / 60 < 6.5 ? "sleep" : "relax_home")
      : a.job && placeId === a.job.place ? (a.job.hourly_wage ? "work" : "school") : (ACTIVITY_AT[placeId] || "hang_out");
  }
  function valueOf(W, homeId) {
    const spec = homeSpec[homeId], lot = W.lots[spec.place];
    return round50(spec.base_value * (0.7 + 0.003 * lot.condition));
  }
  function livingAdults(W, hhId) { return W.hh[hhId].members.map(id => W.byId[id]).filter(a => a.alive && a.age >= 18); }
  function worthParts(W, a) {
    const hh = W.hh[a.hh], home = W.homes[hh.home];
    const savings = a.savings + (a.goal ? a.goal.saved : 0);
    let equity = 0;
    if (home.owner === hh.id && a.age >= 18 && a.alive) equity = valueOf(W, hh.home) / Math.max(1, livingAdults(W, hh.id).length);
    return { cash: a.cash, savings, home: equity, worth: a.cash + savings + equity };
  }
  function funds(W, hhId) { return livingAdults(W, hhId).reduce((s, a) => s + a.cash + a.savings, 0); }
  function tenure(W, hhId) { return W.homes[W.hh[hhId].home].owner === hhId ? "owned" : "rented"; }
  function weeklyCost(W, hhId) {
    const homeId = W.hh[hhId].home, spec = homeSpec[homeId];
    return tenure(W, hhId) === "owned" ? round(spec.base_value * 0.005) : spec.rent;
  }
  function residents(W, homeId) {
    const hh = W.homes[homeId].hh;
    return hh ? W.hh[hh].members.map(id => W.byId[id]).filter(a => a.alive) : [];
  }

  // --- events ----------------------------------------------------------------------------------------

  function makeEvent(W, tag, text, agentId, extra) {
    const [kind, imp] = TAGS[tag];
    const e = Object.assign({ importance: imp, agents: agentId ? [agentId] : [], place: undefined }, extra || {});
    const a = agentId ? W.byId[agentId] : null;
    if (e.place === undefined) e.place = a ? (a.inside || (a.plan ? a.plan.dest : null)) : null;
    // PLAN 3.7: when agent is set, agents[0] == agent (the rest keep their order)
    const agents = agentId ? [agentId, ...(e.agents || []).filter(id => id !== agentId)] : (e.agents || []);
    const out = {
      seq: ++W.seq, tick: e.tick !== undefined ? e.tick : W.tick, time: stamp(e.tick !== undefined ? e.tick : W.tick),
      kind, tag, importance: e.importance, major: e.importance === 2, text, agent: agentId || null,
      agents, place: e.place || null, at: a && !e.noAt ? [a.x, a.y] : null,
    };
    if (a && !e.forget) a.memory.push(`${out.time}: ${text}`);
    return out;
  }
  function emit(W, tag, text, agentId, extra) {
    const e = makeEvent(W, tag, text, agentId, extra);
    W.events.push(e);
    return e;
  }
  const living = W => W.agents.filter(a => a.alive);
  const pairOf = (W, filter) => {
    const ps = living(W).filter(filter || (() => true));
    const a = W.pick(ps);
    let b = W.pick(ps);
    while (b === a) b = W.pick(ps);
    return [a, b];
  };

  const NOTABLE = [
    W => { const [a, b] = pairOf(W, x => x.age >= 16);
      return emit(W, "first_meet", `${a.name} meets ${b.name} for the first time.`, a.id, { agents: [a.id, b.id] }); },
    W => { const [a, b] = pairOf(W);
      return emit(W, "invite_accepted", `${b.name} accepts ${a.first}'s invite.`, b.id, { agents: [b.id, a.id] }); },
    W => { const a = W.pick(living(W).filter(x => x.age >= 25 && W.hh[x.hh].members.length > 1));
      return emit(W, "family_dinner", `${a.name} takes the family out to dinner.`, a.id,
        { agents: [a.id, ...W.hh[a.hh].members.filter(id => id !== a.id && W.byId[id].alive)] }); },
    W => { const a = W.pick(living(W).filter(x => x.age >= 18)), up = W.R() < 0.5, amt = up ? 50 : 40;
      a.cash += up ? amt : -amt;
      return emit(W, "money_swing", `${a.first}: ${up ? "Makes a breakthrough at work (+$50)" : "Gets a parking ticket (−$40)"}.`, a.id); },
    W => { const a = W.pick(living(W)); a.health = Math.max(30, a.health - 10);
      return emit(W, "injury", `${a.name}: Gets food poisoning.`, a.id); },
  ];
  const ROUTINE = [
    W => { const [a, b] = pairOf(W); return emit(W, "invite", `${a.name} invites ${b.name} to Corner Cafe.`, a.id, { agents: [a.id, b.id] }); },
    W => { const [a, b] = pairOf(W); return emit(W, "call", `${a.name} calls ${b.name}.`, a.id, { agents: [a.id, b.id] }); },
    W => { const [a, b] = pairOf(W, x => x.age >= 12);
      const lines = ["Coffee later?", "Running late, sorry!", "Did you see the sunset?", "Dinner at ours on Friday?"];
      return emit(W, "text", `${a.name} texts ${b.name}: “${W.pick(lines)}”`, a.id, { agents: [a.id, b.id] }); },
    W => { const a = W.pick(living(W));
      const lines = ["Sleeps deeply", "Enjoys the coffee", "Has a good laugh", "Finds a quiet bench", "Reads the paper"];
      return emit(W, "outcome", `${a.first}: ${W.pick(lines)}.`, a.id); },
    W => { const [a, b] = pairOf(W); return emit(W, "invite_declined", `${b.name} declines ${a.first}'s invite.`, b.id, { agents: [b.id, a.id] }); },
    W => { const a = W.pick(living(W).filter(x => x.age >= 18));
      return emit(W, "errand", `${a.name} heads to Fresh Market for the family.`, a.id); },
  ];

  // The live script: the majors (and a few housing notables) in order, then random majors forever.
  function script(W) {
    const at = (tag, text, id, extra) => emit(W, tag, text, id, extra);
    return [
      [12, () => { const d = W.byId.dana, l = W.byId.lea;
        d.rel.lea = { kind: "friend", affinity: 41, trust: 50 }; l.rel.dana = { kind: "friend", affinity: 41, trust: 50 };
        return at("new_friend", "Dana Cohen and Lea Tal have become friends.", "dana", { agents: ["dana", "lea"], place: "cafe" }); }],
      [40, () => { W.homes.main_28.emergency = { kind: "leak", since: stamp(W.tick) };
        return at("emergency", "A pipe bursts in the kitchen at 28 Main Street.", "miriam", { agents: ["miriam", "tom"], place: "main_28" }); }],
      [70, () => buyRiver28(W)],
      [110, () => { W.lots.main_28.condition = 59;
        return at("shabby", "28 Main Street is looking shabby.", null, { place: "main_28", agents: ["miriam", "tom"] }); }],
      [140, () => { const a = W.byId.asaf; travel(W, a, "hospital", "ambulance");
        return at("hospital", "Asaf Segal feels very unwell and an ambulance takes him to City Hospital.", "asaf"); }],
      [190, () => { W.lots.park_78.condition = 39;
        return at("neglect", "78 Park Avenue is falling into neglect.", null, { place: "park_78", agents: ["ruth"] }); }],
      [240, () => { const a = W.byId.omer; a.cash -= 150;
        return at("big_money", "Omer Katz: Minor fender bender (−$150).", "omer"); }],
      [300, () => { W.homes.main_28.emergency = null;
        return at("emergency_settled", "The leak at 28 Main Street is finally fixed.", "miriam", { place: "main_28" }); }],
      [320, () => killAsaf(W)],
      [380, () => { const a = W.byId.ari; a.goal = null; a.savings = Math.max(0, a.savings - 120);
        return at("goal_reached", "Ari Ben-David finally buys a new phone with their savings!", "ari"); }],
      [440, () => { W.byId.tom.rel.ari.affinity = -2; W.byId.ari.rel.tom.affinity = -2;
        return at("falling_out", "Tom Levi and Ari Ben-David have fallen out.", "tom", { agents: ["tom", "ari"] }); }],
      [500, () => rentMain39(W)],
      [560, () => { const y = W.byId.yossi, m = W.byId.miriam; y.savings -= 1400; m.cash += 1400;
        return at("help_given", "Yossi Cohen gives Miriam Levi $1,400 to help with the bills.", "yossi", { agents: ["yossi", "miriam"] }); }],
    ];
  }
  function randomMajor(W) {
    const r = W.R();
    if (r < 0.45) {
      const [a, b] = pairOf(W, x => x.age >= 16);
      return emit(W, "new_friend", `${a.name} and ${b.name} have become friends.`, a.id, { agents: [a.id, b.id] });
    }
    if (r < 0.8) {
      const a = W.pick(living(W).filter(x => x.age >= 18)), win = W.R() < 0.4;
      a.cash += win ? 200 : -150;
      return emit(W, "big_money", win ? `${a.name}: Wins the pub quiz jackpot (+$200).` : `${a.name}: The car needs new brakes (−$150).`, a.id);
    }
    const [a, b] = pairOf(W, x => x.age >= 16);
    return emit(W, "falling_out", `${a.name} and ${b.name} have fallen out.`, a.id, { agents: [a.id, b.id] });
  }
  function buyRiver28(W) {
    const price = valueOf(W, "river_28"), cohen = W.hh.cohen;
    // pay_household: in proportion to max(0, money + savings), savings first
    const adults = livingAdults(W, "cohen"), pot = adults.reduce((s, a) => s + Math.max(0, a.cash + a.savings), 0);
    for (const a of adults) {
      let share = (price + 150) * Math.max(0, a.cash + a.savings) / pot;
      const fromSavings = Math.min(a.savings, share);
      a.savings -= fromSavings; share -= fromSavings; a.cash -= share;
    }
    Object.assign(W.homes.main_20, { hh: null, owner: "landlord", listing: "for_rent" });
    Object.assign(W.homes.river_28, { hh: "cohen", owner: "cohen", listing: null });
    W.lots.river_28.moving = true;
    W.later.push([W.tick + 120, () => { W.lots.river_28.moving = false; W.lots.river_28.works = true; }]);
    W.later.push([W.tick + 400, () => { W.lots.river_28.works = false; W.lots.river_28.condition = 74; }]);
    cohen.home = "river_28";
    const time = stamp(W.tick);
    cohen.history.push({ time, event: "left", home: "main_20", name: "20 Main Street", price: 0 });
    cohen.history.push({ time, event: "bought", home: "river_28", name: "28 River Road", price });
    W.homes.main_20.history.push({ tick: W.tick, time, event: "left", household: "cohen", price: 0 });
    W.homes.river_28.history.push({ tick: W.tick, time, event: "bought", household: "cohen", price });
    for (const id of cohen.members) { const a = W.byId[id]; if (a.alive && !a.decide) travel(W, a, "river_28"); }
    return emit(W, "home_bought", `The Cohens buy 28 River Road (house, Maple Grove) for ${money(price)}.`, "dana",
      { agents: cohen.members.slice(), place: "river_28" });
  }
  function rentMain39(W) {
    const barak = W.hh.barak, time = stamp(W.tick);
    Object.assign(W.homes.elm_court_2a, { hh: null, listing: "for_rent" });
    Object.assign(W.homes.main_39, { hh: "barak", listing: null });
    barak.home = "main_39";
    W.lots.main_39.moving = true;
    W.later.push([W.tick + 120, () => { W.lots.main_39.moving = false; }]);
    barak.history.push({ time, event: "left", home: "elm_court_2a", name: "Elm Court, flat 2A", price: 0 });
    barak.history.push({ time, event: "rented", home: "main_39", name: "39 Main Street", price: 330 });
    W.homes.main_39.history.push({ tick: W.tick, time, event: "rented", household: "barak", price: 330 });
    W.homes.elm_court_2a.history.push({ tick: W.tick, time, event: "left", household: "barak", price: 0 });
    if (!W.byId.efrat.decide) travel(W, W.byId.efrat, "main_39");
    return emit(W, "home_rented", "Efrat Barak moves into 39 Main Street (house) at $330/week.", "efrat", { place: "main_39" });
  }
  function killAsaf(W) {
    const a = W.byId.asaf;
    const place = a.inside || (a.plan && a.plan.dest) || "hospital";
    a.alive = false; a.state = "dead"; a.activity = "dead"; a.plan = null; a.decide = null;
    if (place) [a.x, a.y] = placeById[place].entry;
    a.inside = null;
    W.deaths.unshift({ id: "asaf", name: a.name, age: a.age, time: stamp(W.tick), how: "died in City Hospital" });
    return emit(W, "death", "Asaf Segal died in City Hospital, aged 80.", "asaf", { place, agents: ["asaf", "dalia"] });
  }

  // --- the welcome's backlog: events, decided forks and 7 days of hourly samples -------------------------

  function backfill(W, opt) {
    const now = W.tick, ri = W.ri, pick = W.pick;
    const list = [];
    const add = (tick, tag, text, agent, extra) => list.push([tick, tag, text, agent, extra || {}]);
    const MAJORS = [
      [1 * 1440 + 8 * 60 + 2, "controller_joined", `${CONTROLLER} (${MODEL}) now plays 40 characters.`, null,
        { agents: W.agents.filter(a => a.controller).map(a => a.id), importance: 1, forget: true }],
      [2 * 1440 + 19 * 60 + 10, "new_friend", "Tom Levi and Ari Ben-David have become friends.", "tom", { agents: ["tom", "ari"], place: "cafe" }],
      [3 * 1440 + 0 * 60, "richest", "Nir Halabi is now the richest person in Millbrook ($41,950), ahead of Yasmin Halabi.", "nir", { forget: true, place: null }],
      [3 * 1440 + 13 * 60 + 40, "big_money", "Dana Cohen: Minor fender bender (−$150).", "dana", { place: null }],
      [4 * 1440 + 10 * 60 + 5, "home_rented", "Merav Amar moves into Birch Court, flat 3B at $260/week.", "merav", { place: "birch_court" }],
      [5 * 1440 + 0 * 60, "neglect", "12 Main Street is falling into neglect.", null, { place: "main_12", agents: ["asaf", "dalia"] }],
      [5 * 1440 + 17 * 60 + 25, "new_friend", "Rina Mizrahi and Shira Peretz have become friends.", "rina", { agents: ["rina", "shira"], place: "hospital" }],
      [6 * 1440 + 23 * 60, "in_the_red", "The Peretzes are $370 in the red after the week's bills.", "eli", { agents: ["eli", "shira"], place: "cedar_court", importance: 1 }],
      [7 * 1440 + 15 * 60 + 30, "goal_reached", "Lior Mizrahi finally buys a bike with their savings!", "lior", { place: "arcade" }],
      [8 * 1440 + 11 * 60 + 15, "big_money", "Nadia Haddad: A customer leaves a huge tip (+$150).", "nadia", { place: "market" }],
      [8 * 1440 + 20 * 60 + 40, "falling_out", "Sami Haddad and Eli Peretz have fallen out.", "sami", { agents: ["sami", "eli"], place: "cafe" }],
      [9 * 1440 + 0 * 60, "falling_apart", "28 River Road is close to falling apart.", null, { place: "river_28" }],
      [9 * 1440 + 14 * 60 + 20, "help_given", "Rina Mizrahi gives Shira Peretz $500 to help with the bills.", "rina", { agents: ["rina", "shira"], place: "cedar_court" }],
      [10 * 1440 + 9 * 60, "home_listed", "104 Park Avenue goes back on the market.", null, { place: "park_104" }],
      [10 * 1440 + 18 * 60 + 45, "new_friend", "Gal Katz and Efrat Barak have become friends.", "gal", { agents: ["gal", "efrat"], place: "office" }],
      [11 * 1440 + 7 * 60 + 30, "hospital", "David Friedman feels very unwell and goes to City Hospital.", "david", { place: "hospital" }],
      [11 * 1440 + 15 * 60, "discharged", "David Friedman leaves City Hospital feeling better (paid $50).", "david", { place: "hospital" }],
      [11 * 1440 + 0, "shabby", "78 Park Avenue is looking shabby.", null, { place: "park_78", agents: ["ruth", "david"] }],
      [11 * 1440 + 21 * 60, "big_money", "Yasmin Halabi: A bonus at the bank (+$400).", "yasmin", { place: "bank" }],
      [11 * 1440 + 23 * 60 + 59, "death", "David Friedman passed away peacefully in their sleep, aged 74.", "david", { place: "park_78", agents: ["david", "ruth"] }],
      [12 * 1440 + 9 * 60 + 10, "new_friend", "Hila Weiss and Yossi Cohen have become friends.", "hila", { agents: ["hila", "yossi"], place: "hospital" }],
      [12 * 1440 + 11 * 60 + 40, "big_money", "Ronen Carmel: The fridge breaks down (−$180).", "ronen", { place: "elm_court" }],
      [12 * 1440 + 13 * 60 + 5, "new_friend", "Noga Klein and Tomer Golan have become friends.", "noga", { agents: ["noga", "tomer"], place: "works" }],
      [12 * 1440 + 14 * 60 + 50, "big_money", "Uri Elbaz: Sells his old bike (+$150).", "uri", { place: "main_29" }],
    ];
    for (const m of MAJORS) add(...m);
    // Notables over the last five days, about 25 a day.
    for (let t = now - 5 * 1440; t < now; t += ri(30, 80)) {
      const k = W.R();
      const [a, b] = pairOf(W, x => x.age >= 12 && x.id !== "david");
      if (k < 0.4) add(t, "first_meet", `${a.name} meets ${b.name} for the first time.`, a.id, { agents: [a.id, b.id], place: pick(LEISURE) });
      else if (k < 0.62) add(t, "invite_accepted", `${b.name} accepts ${a.first}'s invite.`, b.id, { agents: [b.id, a.id], place: "cafe" });
      else if (k < 0.78) add(t, "family_dinner", `${a.name} takes the family out to dinner.`, a.id, { place: pick(["diner", "noodles", "cafe"]) });
      else if (k < 0.92) add(t, "money_swing", `${a.first}: ${W.R() < 0.5 ? "Makes a breakthrough at work (+$50)" : "Gets a parking ticket (−$40)"}.`, a.id, { place: a.job ? a.job.place : null });
      else add(t, "injury", `${a.name}: Twists an ankle on the stairs.`, a.id, { place: homePlace(W, a) });
    }
    // Routine events over the last six hours.
    for (let t = now - 360; t < now; t += ri(2, 7)) {
      const [a, b] = pairOf(W, x => x.id !== "david");
      const k = W.R();
      if (k < 0.5) add(t, "outcome", `${a.first}: ${pick(["Sleeps deeply", "Enjoys the coffee", "Has a good laugh", "Reads the paper"])}.`, a.id, { place: pick(LEISURE) });
      else if (k < 0.75) add(t, "call", `${a.name} calls ${b.name}.`, a.id, { agents: [a.id, b.id], place: homePlace(W, a) });
      else add(t, "text", `${a.name} texts ${b.name}: “${pick(["Coffee later?", "Running late, sorry!", "See you at the park?"])}”`, a.id, { agents: [a.id, b.id], place: null });
    }
    list.sort((x, y) => x[0] - y[0]);
    const all = [];
    for (const [tick, tag, text, agent, extra] of list) {
      W.seq += ri(1, 4);   // routine events that have rolled out of the rings
      const a = agent ? W.byId[agent] : null;
      if (a) [a.x, a.y] = extra.place ? placeById[extra.place].entry : [a.x, a.y];
      all.push(makeEvent(W, tag, text, agent, Object.assign({ tick, noAt: !a }, extra)));
    }
    W.history = all.slice(-80);
    W.news = all.filter(e => e.importance >= 1).slice(-120);
    W.headlines = all.filter(e => e.importance === 2).slice(-20);
    for (const a of W.agents) if (a.alive && a.inside) [a.x, a.y] = placeById[a.inside].entry;

    // Decided forks of the last ten hours: the llm_log (model and timeout) and every person's last 10.
    const forks = [];
    for (let t = now - 600; t < now; t += ri(1, 4)) {
      const a = pick(living(W));
      forks.push(makeFork(W, a, t, a.controller && W.R() < 0.85 ? (W.R() < (W.slow ? 0.4 : 0.13) ? "timeout" : "model")
        : (W.R() < 0.4 ? "habit" : "default"), true));
    }
    for (const f of forks) record(W, f);
    W.llmBacklog = W.llmRing.slice(-80);

    // Seven days of hourly samples, ending with this hour.
    const cur = sampleNow(W, 0, 0);
    for (let i = 167; i >= 0; i--) {
      const tick = now - i * 60, hour = (tick % 1440) / 60, day = Math.floor(tick / 1440), f = i / 167;
      const wave = Math.sin((hour - 9) / 24 * 2 * Math.PI);
      const work = (day % 7) < 5 && hour >= 8 && hour < 17 ? 0.85 : hour >= 7 && hour < 20 ? 0.35 : 0.05;
      const asked = hour >= 7 && hour < 23 ? ri(6, 14) : ri(0, 3);
      W.samples.push({
        tick, day, pop: tick < 11 * 1440 + 23 * 60 + 59 ? 60 : cur.pop,
        mood: clamp(round(cur.mood - 4 * f + 3 * wave + (W.R() - 0.5) * 3), 0, 100),
        health: clamp(round(cur.health + 2 * f + (W.R() - 0.5) * 2), 0, 100),
        wealth: round(cur.wealth * (1 - 0.07 * f) + (W.R() - 0.5) * 1500 - ((day % 7) === 6 && hour === 23 ? 9000 : 0)),
        median: round(cur.median * (1 - 0.05 * f)), top10: clamp(round(cur.top10 + (W.R() - 0.5) * 2), 0, 100),
        in_debt: i > 100 ? 1 : cur.in_debt, working: round(38 * work), owned: cur.owned,
        shabby_plus: i > 60 ? cur.shabby_plus - 1 : cur.shabby_plus, asked, in_time: asked - (W.R() < 0.3 ? 1 : 0),
      });
    }
    W.samples[W.samples.length - 1] = Object.assign(cur, { tick: now, day: Math.floor(now / 1440) });
  }

  // --- decided forks ---------------------------------------------------------------------------------

  function kindsFor(W, a) {
    const ks = ["hunger", "sleep", "lonely", "free_time", "invite"];
    if (a.age >= 18) ks.push("groceries");
    if (a.job && a.job.hourly_wage) ks.push("work", "work", "payday");
    const hh = W.hh[a.hh];
    if (a.age >= 18 && tenure(W, a.hh) === "owned") ks.push("upkeep");
    if (a.hh === "cohen" && hh.home === "main_20") ks.push("house_hunt");
    if (a.hh === "peretz" && a.age >= 18) ks.push("housing_trouble");
    return ks;
  }
  function makeFork(W, a, tick, decidedBy, settled) {
    const kind = W.pick(kindsFor(W, a)), T = FORK[kind];
    const friends = Object.entries(a.rel).filter(([, r]) => r.kind === "friend").map(([id]) => W.byId[id].name);
    const m = tick % 1440;
    const ctx = { hm: `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`,
      friend: friends.length ? W.pick(friends) : "an old friend", homeName: homeSpec[W.hh[a.hh].home].name };
    const options = T.o(a, ctx);
    const profile = W.ri(0, 3) === 0 ? W.ri(0, 3) : 0;
    let choice = profile;
    if (decidedBy === "model" && W.R() < 0.27) choice = (profile + W.ri(1, 3)) % 4;
    const asked = decidedBy === "model" || decidedBy === "timeout";
    const f = {
      id: `f${++W.forkSeq}`, agent: a.id, kind, tick, time: stamp(tick), question: T.q(a, ctx), options, choice,
      decided_by: decidedBy, reason: decidedBy === "model" ? T.r[choice] : "", happened: [], major: !!T.major,
      controller: asked ? (a.controller || CONTROLLER) : null, model: asked ? MODEL : null,
      answer_seconds: decidedBy === "model" ? r1(0.8 + W.R() * (W.slow ? 4.1 : 3.4)) : null, late: null,
      profile_choice: profile, place: a.inside || (a.plan ? a.plan.dest : null),
    };
    if (decidedBy === "timeout" && W.R() < 0.35) {
      const c = (profile + 1) % 4;
      f.late = { choice: c, reason: T.r[c], seconds: r1(5.4 + W.R() * 4.4) };
    }
    if (settled && W.R() < 0.6) f.happened = T.h[f.choice].slice();
    return f;
  }
  function record(W, f) {
    const a = W.byId[f.agent];
    a.forks.push(f);
    if (a.forks.length > 10) a.forks.shift();
    if (f.decided_by === "model" || f.decided_by === "timeout") {
      a.llmForks.push(f);
      if (a.llmForks.length > 30) a.llmForks.shift();
      W.llmRing.push(f);
      if (W.llmRing.length > 500) W.llmRing.shift();
    }
  }
  function count(W, name, seconds) {
    for (const c of [W.counters.today, W.counters.total]) {
      c[name] += 1;
      if (seconds != null) c.seconds += seconds;
    }
  }

  // --- serializers -----------------------------------------------------------------------------------

  function lotsJson(W) {
    const out = {};
    for (const [id, l] of Object.entries(W.lots)) {
      out[id] = { condition: round(l.condition), stage: stageOf(l.condition), works: l.works, moving: l.moving };
    }
    return out;
  }
  function homesJson(W) {
    const out = {};
    for (const h of TOWN.homes) {
      const s = W.homes[h.id];
      out[h.id] = { hh: s.hh, owner: s.owner, listing: s.listing,
        price: s.listing === "for_sale" ? valueOf(W, h.id) : s.listing === "for_rent" ? h.rent : null,
        value: valueOf(W, h.id), emergency: s.emergency ? s.emergency.kind : null };
    }
    return out;
  }
  function busesJson(W) {
    const out = [];
    for (const line of ["1", "2"]) for (let k = 0; k < 4; k++) {
      const n = BUS_LOOP.length, pos = Math.floor(((W.tick + k * 13) % 52) / 52 * n);
      const i = line === "1" ? pos : (n - pos) % n, nxt = line === "1" ? (i + 1) % n : (i - 1 + n) % n;
      const [x, y] = BUS_LOOP[i], [nx, ny] = BUS_LOOP[nxt];
      const stop = TOWN.stops.find(s => s.x === x && s.y === y);
      out.push({ id: `${line}${"abcd"[k]}`, line, x, y, dir: nx > x ? "e" : nx < x ? "w" : ny > y ? "s" : "n",
        at_stop: stop ? stop.id : null, riders: (k * 7 + W.tick) % 5 });
    }
    return out;
  }
  function stateJson(W, withHousing) {
    const m = W.tick % 1440, day = Math.floor(W.tick / 1440);
    const flight = [8, 14, 20].find(h => m >= h * 60 && m < h * 60 + 30);
    const s = {
      tick: W.tick, time: stamp(W.tick), minute: m, day, season: ["spring", "summer", "autumn", "winter"][Math.floor(day / 90) % 4],
      weather: W.weather, lights: W.tick % 4 < 2 ? { ns: "green", ew: "red" } : { ns: "red", ew: "green" },
      plane: flight !== undefined ? { progress: r2((m - flight * 60) / 30), from: "Riverton", to: "Lakeside" } : null,
      buses: busesJson(W),
      agents: W.agents.map(a => ({
        id: a.id, name: a.name, x: a.x, y: a.y, inside: a.inside, state: a.state, activity: a.activity,
        vehicle: a.vehicle, mood: round(mean(NEEDS.map(n => a.needs[n]))), luck: round(a.luck),
        controller: a.controller, alive: a.alive, age: a.age, home: W.hh[a.hh].home, car: a.car, riding: null,
      })),
    };
    if (withHousing) { s.lots = lotsJson(W); s.homes = homesJson(W); }
    return s;
  }
  function sampleNow(W, asked, inTime) {
    const st = statsCity(W);
    return { tick: W.tick, day: Math.floor(W.tick / 1440), pop: st.population, mood: st.mood, health: st.health,
      wealth: st.wealth.total, median: st.wealth.median, top10: st.wealth.top10_share, in_debt: st.wealth.in_debt,
      working: living(W).filter(a => a.activity === "work").length, owned: st.homes.owned,
      shabby_plus: st.homes.lots_by_stage.slice(2).reduce((x, y) => x + y, 0), asked, in_time: inTime };
  }
  function statsCity(W) {
    const alive = living(W), adults = alive.filter(a => a.age >= 18);
    const worth = a => worthParts(W, a);
    const adultWorth = adults.map(a => worth(a).worth);
    const sortedDesc = adultWorth.slice().sort((x, y) => y - x), k = Math.ceil(adults.length / 10);
    const pos = xs => xs.reduce((s, x) => s + Math.max(0, x), 0);
    const byStage = [0, 0, 0, 0, 0];
    let neglectedLivedIn = 0;
    for (const [place, lot] of Object.entries(W.lots)) {
      const st = stageOf(lot.condition);
      byStage[st] += 1;
      if (st >= 3 && TOWN.homes.some(h => h.place === place && W.homes[h.id].hh)) neglectedLivedIn += 1;
    }
    const hs = Object.values(W.homes);
    return {
      population: alive.length, start_population: 60, deaths: W.agents.length - alive.length, births: 0,
      adults: adults.length, children: alive.length - adults.length,
      working: alive.filter(a => a.job && a.job.hourly_wage > 0).length,
      students: alive.filter(a => a.job && !a.job.hourly_wage).length,
      retired: alive.filter(a => !a.job && a.age >= 65).length,
      out_of_work: alive.filter(a => !a.job && a.age >= 18 && a.age < 65).length,
      mood: round(mean(alive.map(a => mean(NEEDS.map(n => a.needs[n]))))), health: round(mean(alive.map(a => a.health))),
      needs: Object.fromEntries(NEEDS.map(n => [n, round(mean(alive.map(a => a.needs[n])))])),
      wealth: { total: round(alive.reduce((s, a) => s + worth(a).worth, 0)), median: round(median(adultWorth)),
        top10_share: pos(adultWorth) ? round(100 * pos(sortedDesc.slice(0, k)) / pos(adultWorth)) : 0,
        gini: gini(adultWorth), in_debt: adults.filter(a => a.cash + a.savings < 0).length },
      homes: { total: hs.length, owned: hs.filter(h => h.hh && h.owner === h.hh).length,
        rented: hs.filter(h => h.hh && h.owner !== h.hh).length, for_sale: hs.filter(h => h.listing === "for_sale").length,
        for_rent: hs.filter(h => h.listing === "for_rent").length, lots_by_stage: byStage, neglected_lived_in: neglectedLivedIn },
      luck: { touched: alive.filter(a => a.luck !== 50).length, raised: alive.filter(a => a.luck > 50).length,
        lowered: alive.filter(a => a.luck < 50).length, mean: round(mean(alive.map(a => a.luck))) },
      recent_deaths: W.deaths.slice(0, 5),
    };
  }
  function counterJson(c) {
    return { asked: c.asked, in_time: c.in_time, timeouts: c.timeouts, late: c.late, withdrawn: c.withdrawn,
      against_habit: c.against_habit, avg_seconds: c.in_time ? r1(c.seconds / c.in_time) : null };
  }
  function statsJson(W, full) {
    const alive = living(W);
    const playing = alive.filter(a => a.controller);
    const people = alive.map(a => {
      const p = worthParts(W, a);
      return { id: a.id, household: a.hh, worth: round(p.worth), worth_24h: a.worthRing[0], cash: round(p.cash),
        savings: round(p.savings), home_equity: round(p.home), job: a.job ? a.job.title : null, health: round(a.health) };
    }).sort((x, y) => y.worth - x.worth || cmp(x.id, y.id));
    const districts = [];
    for (const d of TOWN.districts) {
      const homes = TOWN.homes.filter(h => placeById[h.place].district === d.id);
      if (!homes.length) continue;
      const res = alive.filter(a => placeById[homePlace(W, a)].district === d.id);
      const lots = Object.entries(W.lots).filter(([p]) => placeById[p].district === d.id);
      districts.push({ id: d.id, name: d.name, people: res.length,
        mood: round(mean(res.map(a => mean(NEEDS.map(n => a.needs[n]))))),
        median_worth: round(median(res.filter(a => a.age >= 18).map(a => worthParts(W, a).worth))),
        homes: homes.length, vacant: homes.filter(h => !W.homes[h.id].hh).length,
        shabby_plus: lots.filter(([, l]) => stageOf(l.condition) >= 2).length });
    }
    const households = [];
    for (const [id] of HOUSEHOLDS) {
      const hh = W.hh[id], members = hh.members.filter(m => W.byId[m].alive);
      if (!members.length) continue;
      const spec = homeSpec[hh.home];
      households.push({ id, name: hh.name, members, home: hh.home, home_name: spec.name, place: spec.place,
        tier_label: TIER_LABEL[spec.tier], tenure: tenure(W, id), weekly_cost: weeklyCost(W, id) });
    }
    const samples = full ? W.samples.slice(-168) : W.newSamples.splice(0);
    if (full) W.newSamples.length = 0;
    return {
      type: "stats", full: !!full, tick: W.tick, time: stamp(W.tick), day: Math.floor(W.tick / 1440),
      city: statsCity(W),
      llm: {
        controllers: playing.length ? [{ name: CONTROLLER, model: MODEL, characters: playing.length }] : [],
        playing: playing.length, thinking: alive.filter(a => a.state === "deciding" && a.controller).length,
        today: counterJson(W.counters.today), total: counterJson(W.counters.total),
        habit_today: W.counters.habit_today, default_today: W.counters.default_today,
      },
      districts, households, people, samples,
    };
  }
  function emergencyJson(e) {
    if (!e) return null;
    const text = { leak: "A pipe has burst in the kitchen.", boiler: "The boiler has broken down.",
      roof: "The roof is leaking.", electrics: "The electrics keep tripping." }[e.kind];
    return { kind: e.kind, text, since: e.since };
  }
  function homePage(W, homeId) {
    const spec = homeSpec[homeId];
    if (!spec) return null;
    const s = W.homes[homeId], lot = W.lots[spec.place], c = round(lot.condition);
    return Object.assign({}, spec, {
      district: placeById[spec.place].district, hh: s.hh, household_name: s.hh ? W.hh[s.hh].name : null,
      owner: s.owner, listing: s.listing,
      price: s.listing === "for_sale" ? valueOf(W, homeId) : s.listing === "for_rent" ? spec.rent : null,
      value: valueOf(W, homeId), emergency: emergencyJson(s.emergency), condition: c, stage: stageOf(c),
      stage_name: STAGE_NAMES[stageOf(c)], residents: residents(W, homeId).map(a => a.name), history: s.history.slice(-20),
    });
  }
  function agentPage(W, a) {
    const hh = W.hh[a.hh], spec = homeSpec[hh.home], lot = W.lots[spec.place], c = round(lot.condition);
    const parts = worthParts(W, a), own = tenure(W, a.hh) === "owned";
    const home = {
      id: spec.id, place: spec.place, name: spec.name, tier: spec.tier, tier_label: TIER_LABEL[spec.tier],
      district: placeById[spec.place].district, bedrooms: spec.bedrooms, tenure: own ? "owned" : "rented",
      landlord: own ? null : LANDLORD, weekly_rent: own ? 0 : spec.rent, property_tax: own ? round(spec.base_value * 0.005) : 0,
      weekly_cost: weeklyCost(W, a.hh), value: valueOf(W, spec.id), condition: c, stage: stageOf(c),
      stage_name: STAGE_NAMES[stageOf(c)], comfort: [1.05, 1.0, 0.92, 0.8, 0.65][stageOf(c)],
      moved_in: hh.history.length > 1 ? hh.history[hh.history.length - 1].time : null,
      emergency: emergencyJson(W.homes[spec.id].emergency),
    };
    const rels = Object.entries(a.rel).sort((x, y) => y[1].affinity - x[1].affinity || cmp(x[0], y[0]));
    return {
      id: a.id, name: a.name, age: a.age, alive: a.alive, state: a.state, activity: a.activity,
      place: a.inside || (a.plan ? a.plan.dest : null), inside: a.inside, luck: r1(a.luck), money: r2(a.cash),
      health: r1(a.health), mood: round(mean(NEEDS.map(n => a.needs[n]))), reputation: a.reputation,
      needs: Object.fromEntries(NEEDS.map(n => [n, r1(a.needs[n])])), job: a.job, controller: a.controller,
      profile: { prompt: a.prompt, traits: a.traits, edited: a.edited, learned: a.learned },
      possessions: { home, car: a.car, phone: { condition: a.goal && a.goal.name.includes("phone") ? "cracked" : "fine" },
        money: r2(a.cash), savings: r2(a.savings), household_funds: round(funds(W, a.hh)),
        savings_goal: a.goal, groceries_at_home: 3 + (a.id.length % 6) },
      relationships: Object.fromEntries(rels.map(([id, r]) => [id, { kind: r.kind, affinity: round(r.affinity),
        trust: r.trust, name: W.byId[id].name }])),
      memory: a.memory.slice(-15), inbox: [], forks: a.forks.slice(-10),
      household: hh.members.map(id => W.byId[id].name),
      savings: round(a.savings), household_funds: round(funds(W, a.hh)), net_worth: round(parts.worth),
      worth_parts: { cash: round(parts.cash), savings: round(parts.savings), home: round(parts.home) },
      home_history: hh.history.slice(-20),
    };
  }

  // --- the host --------------------------------------------------------------------------------------

  function createHost(options) {
    const opt = Object.assign({ browser: false, slow: false, fresh: false, seed: 7, speed: 1, frameMs: 50 }, options || {});
    const W = buildWorld(opt);
    const host = { onmessage: null, speed: opt.speed, world: W, sent: [] };
    const plan = opt.fresh ? [] : script(W);
    const t0 = W.tick;
    let pending = 0, timer = 0, lastStats = 0, ticksSinceStats = 0, majorPending = false, lastLots = "", lastHomes = "";
    let nextRandomMajor = t0 + 640;

    const out = msg => {
      const copy = JSON.parse(JSON.stringify(msg));
      host.sent.push(copy.type);
      if (host.sent.length > 50) host.sent.shift();
      if (host.onmessage) host.onmessage(copy);
    };
    const reply = (msg, r) => { if (msg && "req_id" in msg) r.req_id = msg.req_id; out(r); };

    function welcome(msg) {
      const st = stateJson(W, true);
      lastLots = JSON.stringify(st.lots);
      lastHomes = JSON.stringify(st.homes);
      W.newSamples.length = 0;
      lastStats = performance.now();
      ticksSinceStats = 0;
      reply(msg, {
        type: "welcome", role: "god", town: TOWN, state: st, speed: host.speed,
        history: W.history || [], news: W.news || [], headlines: W.headlines || [],
        llm_log: opt.browser ? [] : (W.llmBacklog || []), host: opt.browser ? { kind: "browser", controllers: false }
          : { kind: "server", controllers: true }, stats: statsJson(W, true),
      });
    }
    function decisions(msg) {
      const id = msg.agent_id == null ? null : String(msg.agent_id);
      if (id !== null && !W.byId[id]) return { type: "error", error: "unknown character" };
      const limit = clamp(Number.isInteger(msg.limit) ? msg.limit : 30, 1, 100);
      let ring = opt.browser ? [] : (id ? W.byId[id].llmForks : W.llmRing).slice().reverse();
      if (msg.before != null) {
        const i = ring.findIndex(f => f.id === msg.before);
        ring = i >= 0 ? ring.slice(i + 1) : [];
      }
      return { type: "decisions", agent_id: id, forks: ring.slice(0, limit), more: ring.length > limit };
    }
    function handle(msg) {
      const t = msg && msg.type;
      if (t === "hello") return welcome(msg);
      if (t === "get_stats") return reply(msg, statsJson(W, true));
      if (t === "get_decisions") return reply(msg, decisions(msg));
      if (t === "get_home") {
        const page = homePage(W, String(msg.home_id));
        return reply(msg, page ? { type: "home", home: page } : { type: "error", error: "unknown home" });
      }
      if (t === "get_agent") {
        const a = W.byId[String(msg.agent_id)];
        return reply(msg, a ? { type: "agent", agent: agentPage(W, a) } : { type: "error", error: "unknown character" });
      }
      if (t === "set_luck") {
        const a = W.byId[String(msg.agent_id)];
        if (typeof msg.luck !== "number" || !isFinite(msg.luck)) return reply(msg, { type: "error", error: "bad message: luck must be a number" });
        const ok = !!(a && a.alive);
        if (ok) a.luck = clamp(msg.luck, 0, 100);
        return reply(msg, { type: "luck_set", ok, agent_id: msg.agent_id, luck: ok ? a.luck : null });
      }
      if (t === "set_profile") {
        const a = W.byId[String(msg.agent_id)];
        if (!a) return reply(msg, { type: "error", error: "unknown character" });
        if (typeof msg.prompt === "string") { a.prompt = msg.prompt.slice(0, 600); a.edited = true; }
        for (const [k, v] of Object.entries(msg.traits || {})) if (TRAITS.includes(k)) a.traits[k] = clamp(Number(v), 0, 1);
        return reply(msg, { type: "agent", agent: agentPage(W, a) });
      }
      if (t === "set_speed") {
        host.speed = [0, 1, 2, 4, 8, 16].includes(msg.speed) ? msg.speed : 1;
        return reply(msg, { type: "speed", speed: host.speed });
      }
      if (t === "pause") { host.speed = 0; return reply(msg, { type: "speed", speed: 0 }); }
      if (t === "resume") { host.speed = host.speed || 1; return reply(msg, { type: "speed", speed: host.speed }); }
      return reply(msg, { type: "error", error: `unknown message type '${t}'` });
    }
    host.send = msg => { setTimeout(() => handle(JSON.parse(JSON.stringify(msg))), 4); };
    host.demote = () => out({ type: "demoted", reason: "another God view took over" });

    function travel_(a, dest, vehicle) { travel(W, a, dest, vehicle); }
    function chooseDest(a) {
      const wd = Math.floor(W.tick / 1440) % 7, hour = (W.tick % 1440) / 60, home = homePlace(W, a);
      if (hour >= 22.5 || hour < 6.5) return home;
      if (onShift(a, wd, hour)) return a.job.place;
      if (a.inside !== home && W.R() < 0.45) return home;
      return W.pick(LEISURE);
    }
    function tickOnce() {
      W.tick += 1;
      ticksSinceStats += 1;
      const now = performance.now();
      for (const a of W.agents) {
        if (!a.alive) continue;
        for (const n of NEEDS) a.needs[n] = clamp(a.needs[n] + (W.R() - 0.52) * 0.8, 5, 100);
        if (a.activity === "work" && a.job) a.cash += a.job.hourly_wage / 60;
        if (a.decide) continue;
        if (a.plan) {
          const step = { walk: 1, run: 2, car: 4, taxi: 4, ambulance: 4, bus: 1 }[a.vehicle] || 1;
          for (let s = 0; s < step && a.plan.i < a.plan.path.length; s++) [a.x, a.y] = a.plan.path[a.plan.i++];
          if (a.plan.i >= a.plan.path.length) {
            const dest = a.plan.dest;
            enter(W, a, dest);
            if (dest === "hospital" && a.id === "asaf") a.activity = "hospital";
            a.nextAt = W.tick + W.ri(40, 200);
          }
        } else if (W.tick >= a.nextAt && a.id !== "asaf") {
          const dest = chooseDest(a);
          if (dest !== a.inside) travel_(a, dest); else a.nextAt = W.tick + W.ri(30, 120);
        }
      }
      // forks
      if (W.R() < 0.22) {
        const a = W.pick(living(W).filter(x => !x.decide));
        if (a) {
          if (a.controller && W.R() < 0.85) {
            const timeout = W.R() < (W.slow ? 0.4 : 0.13);
            const fork = makeFork(W, a, W.tick, timeout ? "timeout" : "model", false);
            a.decide = { fork, until: now + (timeout ? 5000 : fork.answer_seconds * 1000), prev: a.state };
            a.state = "deciding";
            count(W, "asked");
          } else {
            const f = makeFork(W, a, W.tick, W.R() < 0.4 ? "habit" : "default", false);
            W.counters[f.decided_by === "habit" ? "habit_today" : "default_today"] += 1;
            settle(f);
          }
        }
      }
      // events
      while (plan.length && W.tick - t0 >= plan[0][0]) plan.shift()[1]();
      if (!opt.fresh && W.tick >= nextRandomMajor && !plan.length) { randomMajor(W); nextRandomMajor = W.tick + W.ri(60, 110); }
      if (W.R() < 0.07) W.pick(NOTABLE)(W);
      if (W.R() < 0.5) W.pick(ROUTINE)(W);
      if (W.R() < 0.004) {
        W.weather = W.weather === "rain" ? "clear" : "rain";
        emit(W, "weather", W.weather === "rain" ? "It starts to rain." : "The rain stops.", null);
      }
      for (let i = W.later.length - 1; i >= 0; i--) if (W.later[i][0] <= W.tick) W.later.splice(i, 1)[0][1]();
      if (W.tick % 1440 === 0) {   // midnight: the day's counters start again
        Object.assign(W.counters.today, freshCounters().today);
        W.counters.habit_today = W.counters.default_today = 0;
      }
      if (W.tick % 60 === 0) {     // hourly sample, and everyone's worth ring
        let asked = 0, inTime = 0;
        for (const f of W.llmRing) if (f.tick > W.tick - 60) { asked += 1; if (f.decided_by === "model") inTime += 1; }
        const s = sampleNow(W, asked, inTime);
        W.samples.push(s);
        if (W.samples.length > 168) W.samples.shift();
        W.newSamples.push(s);
        for (const a of W.agents) { a.worthRing.push(round(worthParts(W, a).worth)); if (a.worthRing.length > 25) a.worthRing.shift(); }
      }
    }
    function settle(f) {
      record(W, f);
      W.frameForks.push(f);
      const T = FORK[f.kind];
      if (W.R() < 0.6) {
        W.later.push([W.tick + W.ri(15, 60), () => {
          f.happened = T.h[f.choice].slice();
          if (f.happened.length) W.frameForks.push(f);
        }]);
      }
    }
    function resolveDecisions(now) {
      for (const a of W.agents) {
        const d = a.decide;
        if (!d || now < d.until) continue;
        a.decide = null;
        a.state = a.plan ? "moving" : "busy";
        const f = d.fork;
        f.tick = W.tick;
        f.time = stamp(W.tick);
        if (f.decided_by === "model") {
          count(W, "in_time", f.answer_seconds);
          if (f.choice !== f.profile_choice) count(W, "against_habit");
        } else {
          count(W, "timeouts");
          if (f.late) {
            const late = f.late;
            f.late = null;
            W.later.push([W.tick + 2, () => { f.late = late; count(W, "late"); W.frameForks.push(f); }]);
          }
        }
        settle(f);
      }
    }
    function frame() {
      const now = performance.now();
      pending += opt.frameMs / 1000 * TICKS_PER_REAL_SECOND * host.speed;
      let stepped = false;
      while (pending >= 1) { pending -= 1; tickOnce(); stepped = true; }
      resolveDecisions(now);
      const events = W.events.splice(0), forks = [];
      for (const f of W.frameForks.splice(0)) { const i = forks.findIndex(x => x.id === f.id); if (i >= 0) forks[i] = f; else forks.push(f); }
      if (events.some(e => e.importance === 2)) majorPending = true;
      if (stepped || events.length || forks.length) {
        W.frames += 1;
        const st = stateJson(W, true), lots = JSON.stringify(st.lots), homes = JSON.stringify(st.homes);
        const every40 = W.frames % 40 === 0;
        if (!(every40 || lots !== lastLots)) delete st.lots;
        if (!(every40 || homes !== lastHomes)) delete st.homes;
        if (st.lots) lastLots = lots;
        if (st.homes) lastHomes = homes;
        out({ type: "state", speed: host.speed, state: st, events, forks });
      }
      if (ticksSinceStats > 0 && (now - lastStats >= 3000 || (majorPending && now - lastStats >= 500))) {
        lastStats = now;
        ticksSinceStats = 0;
        majorPending = false;
        out(statsJson(W, false));
      }
    }
    host.start = () => { if (!timer) timer = setInterval(frame, opt.frameMs); };
    host.stop = () => { clearInterval(timer); timer = 0; };
    return host;
  }

  function travel(W, a, dest, vehicle) {
    const from = a.inside ? placeById[a.inside].entry : [a.x, a.y];
    const path = roadPath(from, placeById[dest].entry);
    a.plan = { dest, path, i: 0 };
    a.inside = null;
    a.vehicle = vehicle || (a.car && path.length > 14 ? "car" : "walk");
    a.state = "moving";
    a.activity = dest === homePlace(W, a) ? "go_home" : ACTIVITY_AT[dest] || (a.job && dest === a.job.place ? "work" : "go_out");
  }

  // --- a stand-in for the CityView facade (PLAN 3.12) ------------------------------------------------
  // A plain top-down canvas: tiles, buildings coloured by kind (homes by stage), overlay tints, highlights,
  // pings, people and buses. It records every facade call in view.calls, so the smoke test can check them.

  function createStubView(canvas, opts) {
    const o = opts || {};
    const g = canvas.getContext("2d");
    const v = { calls: [], town: null, state: null, lots: {}, homes: {}, selected: null, overlay: null, colors: {},
      hl: null, pings: [], inset: { top: 0, right: 0, bottom: 0 }, focusAt: null, running: false, stub: true };
    const log = (name, args) => { v.calls.push([name, args]); if (v.calls.length > 400) v.calls.shift(); };
    let geo = { s: 8, ox: 0, oy: 0 }, raf = 0;
    const KIND = { home: "#c9b48f", office: "#7d93bd", bank: "#a78bd0", townhall: "#d6c58a", school: "#d9a25a",
      hospital: "#e8e8ef", market: "#73b48f", shop: "#c58fb7", cafe: "#b78a6a", works: "#8f8f86", park: "#4f8d45" };
    const STAGE = ["#efe2c4", "#d8c9a6", "#b9a37a", "#8d7a5c", "#5d4f40"];
    function layout() {
      const r = canvas.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
      if (!v.town) return;
      const top = v.inset.top || 0, bottom = v.inset.bottom || 0, right = v.inset.right || 0;
      const aw = r.width - right - 24, ah = r.height - top - bottom - 24;
      const s = Math.max(2, Math.min(aw / v.town.w, ah / v.town.h));
      geo = { s, ox: (aw - s * v.town.w) / 2 + 12, oy: top + 12 + (ah - s * v.town.h) / 2, dpr };
    }
    function tileAt(cssX, cssY) { return [(cssX - geo.ox) / geo.s, (cssY - geo.oy) / geo.s]; }
    function hitAt(cssX, cssY) {
      if (!v.town || !v.state) return null;
      const [tx, ty] = tileAt(cssX, cssY);
      let best = null, bd = 0.9;
      for (const a of v.state.agents) {
        if (!a.alive || a.inside) continue;
        const d = Math.hypot(a.x + 0.5 - tx, a.y + 0.5 - ty);
        if (d < bd) { best = a; bd = d; }
      }
      if (best) return { kind: "agent", id: best.id };
      for (const b of v.state.buses || []) if (Math.abs(b.x + 0.5 - tx) < 0.8 && Math.abs(b.y + 0.5 - ty) < 0.8) return { kind: "bus", id: b.id };
      for (const p of v.town.places) if (tx >= p.x && tx < p.x + p.w && ty >= p.y && ty < p.y + p.h) return { kind: "place", id: p.id };
      for (const s of v.town.stops || []) if (Math.floor(tx) === s.x && Math.floor(ty) === s.y) return { kind: "stop", id: s.id };
      if (tx < 0 || ty < 0 || tx >= v.town.w || ty >= v.town.h) return null;
      return { kind: "tile", x: Math.floor(tx), y: Math.floor(ty) };
    }
    v.hitAt = hitAt;            // dev only (the smoke test looks for a spot with a tooltip); not part of the facade
    const evPos = ev => { const r = canvas.getBoundingClientRect(); return { cssX: ev.clientX - r.left, cssY: ev.clientY - r.top, touch: ev.pointerType === "touch" }; };
    // Input as P4's camera does it: a mouse hovers; a finger hovers only by a 500 ms long-press (which then
    // is not a tap); arrows and WASD on window pan (logged as "pan") unless focus is in an input, select or
    // textarea.
    let press = null;
    canvas.addEventListener("pointerdown", ev => {
      if (ev.pointerType !== "touch") return;
      const e = evPos(ev);
      clearTimeout(press && press.timer);
      press = { x: e.cssX, y: e.cssY, long: false };
      press.timer = setTimeout(() => { press.long = true; if (o.onHover) o.onHover(hitAt(press.x, press.y), { cssX: press.x, cssY: press.y, touch: true }); }, 500);
    });
    canvas.addEventListener("pointermove", ev => {
      const e = evPos(ev);
      if (ev.pointerType === "touch") {
        if (press && Math.hypot(e.cssX - press.x, e.cssY - press.y) > 6) clearTimeout(press.timer);
        return;
      }
      if (o.onHover) o.onHover(hitAt(e.cssX, e.cssY), e);
    });
    canvas.addEventListener("pointerup", ev => { if (ev.pointerType === "touch" && press) clearTimeout(press.timer); });
    canvas.addEventListener("pointercancel", () => { if (press) clearTimeout(press.timer); press = null; });
    canvas.addEventListener("pointerleave", ev => { if (ev.pointerType !== "touch" && o.onHover) o.onHover(null, null); });
    canvas.addEventListener("contextmenu", ev => ev.preventDefault());
    canvas.addEventListener("click", ev => {
      if (press && press.long) { press = null; return; }   // the long-press showed a tooltip
      press = null;
      const e = evPos(ev);
      if (o.onPick) o.onPick(hitAt(e.cssX, e.cssY), e);
    });
    const typing = () => { const a = document.activeElement; return !!a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable); };
    window.addEventListener("keydown", ev => {
      if (typing() || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      const k = ev.key.toLowerCase();
      if (["arrowleft", "arrowright", "arrowup", "arrowdown", "w", "a", "s", "d"].includes(k)) { log("pan", [k]); ev.preventDefault(); }
      else if (k === "escape" && v.selected) { v.selected = null; if (o.onSelect) o.onSelect(null); }
    });
    function resolve(target) {
      if (!target || !v.town) return null;
      if (target.tile) return target.tile;
      if (target.agent) { const a = v.state && v.state.agents.find(x => x.id === target.agent); return a ? [a.x, a.y] : null; }
      let id = target.place;
      if (id) {
        let p = v.town.places.find(x => x.id === id);
        if (!p) { const h = (v.town.homes || []).find(x => x.id === id); p = h && v.town.places.find(x => x.id === h.place); }
        return p ? [p.x + p.w / 2 - 0.5, p.y + p.h / 2 - 0.5] : null;
      }
      if (target.district) {
        const d = (v.town.districts || []).find(x => x.id === target.district);
        const r = d && d.rects[0];
        return r ? [r[0] + r[2] / 2, r[1] + r[3] / 2] : null;
      }
      return null;
    }
    const PING = { death: "#ef6b6b", money: "#f6c445", home: "#6fcf7c", social: "#f08ab4", health: "#6cb6ff", other: "#e9edf3" };
    function draw(now) {
      raf = v.running ? requestAnimationFrame(draw) : 0;
      if (!v.town) return;
      const { s, ox, oy, dpr } = geo;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const r = canvas.getBoundingClientRect();
      g.fillStyle = "#1d2330";
      g.fillRect(0, 0, r.width, r.height);
      const T = v.town;
      for (let y = 0; y < T.h; y++) for (let x = 0; x < T.w; x++) {
        const c = T.tiles[y][x];
        g.fillStyle = c === "#" ? "#5d6470" : c === "~" ? "#3a6ea5" : c === "P" ? "#5a9a4c" : c === "T" ? "#3f7a3a" : "#6aa84f";
        g.fillRect(ox + x * s, oy + y * s, s + 0.5, s + 0.5);
      }
      for (const p of T.places) {
        if (p.kind === "park") continue;
        const lot = v.lots[p.id];
        const stage = lot ? (lot.stage != null ? lot.stage : lot.condition >= 80 ? 0 : lot.condition >= 60 ? 1 : lot.condition >= 40 ? 2 : lot.condition >= 20 ? 3 : 4) : 0;
        g.fillStyle = p.kind === "home" ? STAGE[stage] : KIND[p.kind] || "#999";
        g.fillRect(ox + p.x * s, oy + p.y * s, p.w * s, p.h * s);
        g.strokeStyle = "rgba(0,0,0,.35)";
        g.lineWidth = 1;
        g.strokeRect(ox + p.x * s + 0.5, oy + p.y * s + 0.5, p.w * s - 1, p.h * s - 1);
      }
      if (v.overlay) {
        g.globalAlpha = 0.72;
        for (const [id, color] of Object.entries(v.colors)) {
          const p = T.places.find(x => x.id === id);
          if (!p) continue;
          g.fillStyle = color;
          const apron = p.units > 1 ? 1 : 0.3;
          g.fillRect(ox + (p.x - apron) * s, oy + (p.y - apron) * s, (p.w + 2 * apron) * s, (p.h + 2 * apron) * s);
        }
        g.globalAlpha = 1;
      }
      if (v.hl) {
        g.strokeStyle = "#f6c445";
        g.lineWidth = 2;
        for (const id of v.hl.places || []) {
          const p = T.places.find(x => x.id === id);
          if (p) g.strokeRect(ox + p.x * s - 2, oy + p.y * s - 2, p.w * s + 4, p.h * s + 4);
        }
      }
      if (v.state) {
        for (const b of v.state.buses || []) {
          g.fillStyle = "#f2c94c";
          g.fillRect(ox + b.x * s - s * 0.2, oy + b.y * s + s * 0.15, s * 1.4, s * 0.7);
        }
        for (const a of v.state.agents) {
          if (!a.alive || a.inside) continue;
          const hl = v.hl && (v.hl.agents || []).includes(a.id);
          g.beginPath();
          g.arc(ox + (a.x + 0.5) * s, oy + (a.y + 0.5) * s, Math.max(2, s * (hl ? 0.55 : 0.36)), 0, Math.PI * 2);
          g.fillStyle = shirtOf(a.id);
          g.fill();
          g.lineWidth = hl ? 2 : 1;
          g.strokeStyle = hl ? "#f6c445" : "rgba(0,0,0,.6)";
          g.stroke();
        }
        if (v.selected) {
          const a = v.state.agents.find(x => x.id === v.selected);
          if (a) {
            const p = a.inside ? T.places.find(x => x.id === a.inside) : null;
            const [cx, cy] = p ? [p.x + p.w / 2, p.y + p.h / 2] : [a.x + 0.5, a.y + 0.5];
            g.beginPath();
            g.arc(ox + cx * s, oy + cy * s, s * 1.3, 0, Math.PI * 2);
            g.strokeStyle = "#ffffff";
            g.lineWidth = 2;
            g.stroke();
          }
        }
      }
      for (let i = v.pings.length - 1; i >= 0; i--) {
        const pg = v.pings[i], t = (now - pg.t0) / 1600;
        if (t > 1) { v.pings.splice(i, 1); continue; }
        const xy = resolve(pg.target);
        if (!xy) continue;
        g.beginPath();
        g.arc(ox + (xy[0] + 0.5) * s, oy + (xy[1] + 0.5) * s, s * (1 + t * 5), 0, Math.PI * 2);
        g.strokeStyle = PING[pg.topic] || PING.other;
        g.globalAlpha = 1 - t;
        g.lineWidth = 3;
        g.stroke();
        g.globalAlpha = 1;
      }
      if (v.focusAt && now - v.focusAt.t0 < 900) {
        const [x, y] = v.focusAt.xy;
        g.strokeStyle = "rgba(255,255,255,.8)";
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(ox + (x + 0.5) * s - 14, oy + (y + 0.5) * s); g.lineTo(ox + (x + 0.5) * s + 14, oy + (y + 0.5) * s);
        g.moveTo(ox + (x + 0.5) * s, oy + (y + 0.5) * s - 14); g.lineTo(ox + (x + 0.5) * s, oy + (y + 0.5) * s + 14);
        g.stroke();
      }
    }
    function shirtOf(id) {
      if (window.CityView && window.CityView.shirt) return window.CityView.shirt(id);
      let h = 2166136261;
      for (const c of id) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
      return `hsl(${(h >>> 0) % 360} 65% 55%)`;
    }
    if (window.ResizeObserver) new ResizeObserver(layout).observe(canvas);
    Object.assign(v, {
      setTown(town) { log("setTown", []); v.town = town; layout(); },
      setState(state) {
        v.state = state;
        if (state.lots) v.lots = state.lots;
        if (state.homes) v.homes = state.homes;
      },
      select(id, sopts) { log("select", [id, sopts]); v.selected = id; },
      focus(target, fopts) { log("focus", [target, fopts]); const xy = resolve(target); if (xy) v.focusAt = { xy, t0: performance.now() }; },
      highlight(sel) { log("highlight", [sel]); v.hl = sel; },
      setOverlay(name, colors) { log("setOverlay", [name, colors]); v.overlay = name; v.colors = name ? colors || {} : {}; },
      ping(target, topic) { log("ping", [target, topic]); v.pings.push({ target, topic, t0: performance.now() }); },
      setInset(inset) { log("setInset", [inset]); v.inset = Object.assign({ top: 0, right: 0, bottom: 0 }, inset); layout(); },
      setMode(m) { log("setMode", [m]); },
      camera() { return { x: 0, y: 0, zoom: 1, follow: v.selected, projection: "flat" }; },
      start() { if (!v.running) { v.running = true; raf = requestAnimationFrame(draw); } },
      stop() { v.running = false; cancelAnimationFrame(raf); },
    });
    return v;
  }

  window.DASH_FIXTURE = { town: TOWN, createHost, createStubView };
})();

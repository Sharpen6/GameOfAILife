# HANDOFF R1b: the 60 in the region

Branch `v3-r1b`. Tag produced: `v3-region-homes`. Tags merged: `v3-skel-tags`, `v3-skel-people`,
`v3-skel-folkmodel`, `v3-skel-region` (fa53ec8; `port/src/engine.json` kept at this branch's list, which has every
present `.js` file), `v3-skel-hooks`.

## What works (Python and JS, lockstep)
- `travel.py` / `travel.js`: `MAX_OUTING_MINUTES = 40`, Rule R in `nearest(..., max_minutes=None)`, and
  `named_may_visit(sim, agent, place_id, max_minutes=None)`. The millbrook world behaves as v2.
- `housing.py` / `housing.js` region hunks (PLAN 2.17). Every hunk is fenced with `# --- region ---` /
  `# --- end region ---` (`//` in JS); a line diff against `v3-skel-hooks` shows no changed line outside a fence.
  - `build_homes` adds `town.home_specs` after the 37: empty, unlisted, owned by the landlord (a let home) or the
    market. `build_lots` reads `town.lot_conditions`.
  - `list_vacancies(sim) -> int` lists every empty region home and unlists the occupied ones. It lists 575 on a
    fresh region sim.
  - `nightly`, `tick`, `_decay` and `_stage_news` skip townsfolk households or handle them quietly: no `sim.rng`
    draw and no news, and the repaint event fires only for cast households. `nightly` groups homes by lot in one
    pass (612 homes).
  - One `_person` / `_household` helper looks up the cast first, then `sim.person` / `sim.household_by_id`. It is
    used by `adults`, `residents`, `_members`, `living`, `household_name`, `household_summary` and `home_page`;
    `home_page` lists townsfolk residents.
  - `commute()` gives a townsperson the weekly cost of the mode in `p.commute`, per workday: car is
    `travel.TRIP_COST["car"]`, train is `2 x rail.fare(age)`, walk is 0. It makes no travel call.
  - `weekly_income` counts night shifts. `afford_score` reads `people.household` / `people.traits`.
  - The cast is offered only the 37: `vacancies` (and so `hunt_candidates`, `downsize_candidates`,
    `cheapest_rental` and forced moves), `house_drought` and `market_json`.
  - `housing_forks` needed no change.
- New names, the same in Python and JS:
  - `housing.V2_HOME_IDS`, `is_v2_home`, `cast_homes`, `list_vacancies`
  - `travel.MAX_OUTING_MINUTES`, `nearest(max_minutes=)`, `named_may_visit`
- Helpers that take a `FolkHousehold`: fits, is_upgrade, weekly_outgo, affordable, reno_cost, value,
  sale_proceeds, weekly_cost, fix_emergency, _change_condition, commute, living, weekly_income, bills,
  housing_cost, net_cost, funds, tenure, crowded, comfort, adults, residents, _members, household_name,
  household_summary, home_page, afford_score.
- `list_vacancies` rules:
  - An empty home owned by the landlord becomes `for_rent`, with `home.rent` set to `region.rent_at` of its
    `home_specs` row. The rent is always worked out from the base rent, never from the last listing.
  - Any other empty home becomes owner `"market"`, `for_sale`.
  - An occupied home is unlisted.
  - The 37 are left alone.
- `housing.vacancies()` is now the cast's market, the 37 only. Townsfolk should use `folk_life.vacancies`.
- `tests/test_region_named.py` covers:
  - the identity test
  - Rule R
  - `list_vacancies` 575
  - nightly/tick draw `sim.rng` as millbrook does
  - a scripted FolkHousehold (carless train commuter, car commuter, child) through every helper, with
    `commute()` equal to the hand cost
  - the cast market and `house_drought`
  - `NodeParityTest`
  - the 60-day soak (GOAL_SLOW; it also checks named commute <= 60 min and tick <= 50 ms)
- `port/tools/parity_travel.cjs`: Node equals Python on 200 nearest queries, 60 `named_may_visit` calls, the
  region listings, `market_json`, the folk household helpers and 4 nights of region lot wear.

## Stubbed or cut
- Not built, by PLAN 1 / 2.9: pruned `nearest`, the `warm_next` fill, the 45-minute commute filter and region
  house-hunting labels.
- `housing.on_death` is L2's, and R1b does not touch it.

## Numbers (process_time; load L in brackets)
- Identity, `Simulation(s, world="region")` against `Simulation(s)`, comparing events, forks and hourly positions.
  Seeds 1-2 x 7 d, after the `v3-skel-region` merge:
  - seed 1: 1235 events, 2901 forks, identical; region tick max 6.4 ms, mean 0.34 ms (7.5)
  - seed 2: 1134 events, 2770 forks, identical; region tick max 8.2 ms, mean 0.35 ms (8.2)
- GOAL_SLOW seeds 1-5 x 14 d (before that merge): identical. Tick max 11.8 / 8.9 / 9.8 / 8.9 / 12.8 ms, mean
  0.34-0.36 ms (11.8-12.2).
- 60-day soak, seed 1:
  - 12 cast moves, all within the 37
  - longest named commute 40 min
  - tick max 6.3 ms (8.0)
- Node parity: Node equals Python on 200 nearest queries. 162 found a place, and 44 reached region places from
  outside Millbrook.
- Scratch merge, made with no refs, of the R1b head with v3-f2a, v3-f1, v3-l2, v3-l1 and v3-f3:
  - `Simulation(1, world="region", folk=1000)` ran 7 days in 13.3 s CPU with no exception
  - 424 region homes occupied, 151 listed
  - the cast stayed in the 37, and no named character left Millbrook

## Edits needed in files R1b does not own
- `sim.py`: none needed.
- Optional (F3): `sim.nearest` (py and js) does not forward `travel.nearest`'s `max_minutes`.
- F3: `stats.py`'s `_homes_at`, `_homes_block` and `_districts` iterate every `sim.homes` row. In the region world
  `city.homes` and the districts therefore count 612 homes. Use `housing.cast_homes(sim)` if they should stay the 37.
- `tests.test_people` fails 3 tests on the `v3-skel-hooks` tag itself, exported with `git archive` and run alone:
  `test_night_shift`, `test_folk_only_news_is_capped` and `test_no_life_no_prompt`. R1b does not cause these
  failures; they are L1's tests against the hooks or L2's `life.init`.
- Fork ids come from `forks._ids`, one counter shared by every Simulation, so the identity trace renumbers them per
  run.
- `tests/fixtures/city_seed1.json` is unchanged, and test_port's fixture test passes.

## Tests the integrator runs
- `python3 -m unittest tests.test_region_named` (default suite; identity seeds 1-2 x 7 d, about 15 s CPU)
- `GOAL_SLOW=1 SOAK_SEEDS=1,2,3 SOAK_DAYS=7 python3 -m unittest tests.test_region_named.IdentityTest`
- `GOAL_SLOW=1 SOAK_SEEDS=1 SOAK_DAYS=60 python3 -m unittest tests.test_region_named.CastMarketSoak` (about 35 s)
- The soak also reads `SOAK_DAYS`, so run it separately from the 7-day identity run.
- Also run `tests.test_housing`, `tests.test_travel`, `tests.test_paths`, `tests.test_port` and the full suite.

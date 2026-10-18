# HANDOFF F3: event tags, the hooks skeleton, folk protocol, server, stats, page.js

Branch `v3-f3`. Tags produced: `v3-skel-tags` (the 21 event tags), `v3-skel-hooks` (every hook line). Merged tag
heads at this HEAD: v3-skel-people, v3-skel-life, v3-skel-rail, v3-skel-region, v3-skel-folkmodel and
v3-folk-gen (547e5c1), v3-region-homes (1a156ec), v3-folk-live (0443bd3), v3-rail-js. `port/src/engine.json`
kept at PLAN 4's full list on every merge (the folk files and `sim.js` last). The integrator deletes this file.

## Done
- `v3-skel-tags`: the 21 event tags in chronicle.py and chronicle.js, and test_seams PLAN_TAGS.
- `v3-skel-hooks`: every hook row of life.md 7 and PLAN 2.1-2.4 in sim.py and sim.js, line for line (the list
  below).
- Hooks outside sim:
  - forks.py/js: Fork.about; the agents-only relationship pickers (_best_friend, _playmate, _closest_family);
    the invite and work fork guards; BUILDERS += people.pending_fork, resolved by module name.
  - stats.py/js: city.life; births and deaths from life.counts; stats.folk; stats.region; folk.sample_hour; and
    `folk_parts` (below), folded into city and districts.
- server.py and host.js: welcome occ; get_folk `{type: folk, req_id, v, rows}`; the folk.md 9 loop fix
  (frame_span, at most 4 frames of catch-up, the on-time tick sequence unchanged); occ in every 40th frame once
  it is 10 ticks old; region lots and homes compared every 20th frame and sent on change or every 200th;
  merge_state keeps occ; check_listen runs before the Simulation is built.
- `__main__.py` takes `--world` (default region) and `--folk` (default 1000). page.js takes `?world=`
  (region|millbrook) and `?folk=`, and falls back to Millbrook with a notice when the region cannot start.
- v2 key-set migrations I own: test_foundation, test_client_view (conditional, see INTEGRATOR 1), test_dashboard
  CITY_KEYS, test_port DiceSim dice_seed, test_integration GOAL_SKIP_DEVFIXTURE skip plus get_folk and a folk
  get_agent in record_session, the full_app_smoke spawn line.
- Tests:
  - `tests/test_hooks.py`: 14 tests, every hook counted.
  - `tests/test_folk_protocol.py`: 23 tests. The crowd invariant on every frame; the Py/JS recursive key sets
    at folk 0 and 1000; folk get_agent and set_luck; get_folk; richest and stats.people named-only; folk-only
    News <= 60 a day; welcome 431 KB <= 550 KB and town 277 KB <= 320 KB; the 60 stay in Millbrook over 3 days;
    the frame loop in Python and JS; TestFolkCityStats (city needs against the population mean, God's luck on
    townsfolk, wealth median and gini over every adult, non-zero district medians, retired and out of work,
    the same numbers in JS).
  - `tests/test_folk_isolation.py`: isolated townsfolk change nothing for the named's events, forks, hourly
    positions or luck over 3 days.
  - `tests/perf_folk.py` (run under flock /tmp/v3-slow.lock); numbers at the end.
- `client/dev/fixture_folk.js`, 448 KB: a region welcome at Day 1 Mon 08:00 plus 3 frames. Its generator is
  `python3 -m tests.test_folk_protocol --write-fixture`; TestFolkFixture checks its shape.
- `docs/protocol.md`: the PLAN 2.13 section headings, every field the hooks emit, the `### get_folk` section, and
  the Townsfolk section (the frame invariant, cadences, what city and districts count, the folk page, F1's
  paragraph). R1a's Region map text from HANDOFF-R1a.md is pasted in verbatim, as R1a asked.

## Fixed after the verifier (this last round)
`stats.city` with townsfolk showed every need at 3-4, never moved luck when God changed a townsperson, and gave
folk-only districts a median worth of $0 (F2a's `Folk.city_parts` sends no needs, luck or worths).
`stats.folk_parts(sim)` (Python and JS) now builds the townsfolk's part in one helper used by `stats_json` and
`CityStats.sample`: `canon_parts(Folk.city_parts)` plus `needs_sum` (projected to now without settling anyone),
`luck` {touched, raised, lowered, sum}, `adult_worths` city-wide and per district, `worth_sum` (the wealth
total), `in_debt`, `retired` and `out_of_work`, over `sim.folk.living()`; a key city_parts already sends is
kept as sent. `_add_parts` recomputes needs and luck only when those parts are present. The hourly sample calls
`folk.sample_hour` first and reads each worth from its ring, and skips the needs, luck and district worths it
does not keep, so the step p99 stays under 8 ms.

## Not done
- Nothing was cut: the three cut-first items (region housing_maps cadence, Node 1-day timing,
  fixture_folk.js) are done.
- `sim.housing_version` is not built (PLAN 2.11 says not built). F2a's handoff asks for it; test_view_contract
  keeps its skip.
- README.md and the regenerated client/dev/fixture_town.js are the integrator's (INTEGRATOR below).
- Seen, not mine: at the same seed, region folk 1000, after 270 steps, Python and JS differ by 2 in the hourly
  sample's `wealth` and by 1 in one district's `mood`. Both diffs were already there before this round's stats
  change. The district mood comes from F2a's `city_parts` mood sums. TestFolkCityStats compares only the fields
  this round added.

## HOOK LIST (callee per hook)
- `sim.__init__` calls, in order: region.build_region(seed) (lazy import, region world only), life.pre_init,
  people.make_folk(sim, folk, folk_isolated), life.init, social.init. ACTIVITIES gains life.ACTIVITIES_EXTRA.
- step() order:
  1. _new_day: life.legacy_ageing, then housing.nightly, then folk.nightly.
  2. Sunday 23:00: housing.weekly_charges, then folk.weekly.
  3. Friday 09:00: _pay_pensions, then folk.pensions.
  4. housing.tick, then life.tick.
  5. The agents loop, then folk.tick, then social.tick.
- event(): its first line is people.news_gate.
- _next: life.toddle (age < FORK_AGE) and life.hospitalise(sim, a, 1, "very unwell").
- _decay: life.max_health. _begin_activity: the ward lasts until life.ward_until. _end_activity work:
  career.on_shift_end.
- _die: people.person, then life.on_death.
- _apply_outcome: people.apply_effect. _apply_extra: people.person and people.apply_extra.
- invite(): social.invite_folk. send_message(): social.message_folk.
- set_luck and luck_of: folk.set_luck. _log_roll: people.log_roll.
- agent_json: folk.page_json for folk ids; people.rel_row and life.page for the named.
- fork_message: life.fork_you. timetable: rail.timetable_json. trains(): rail.train_rows(town, tick,
  folk.riders(tick)).
- state_json: folk.crowd, social.talks_json, life.ill, life.stage.
- stats: life.stats_block, folk.stats_json, folk.city_parts (through stats.folk_parts and stats.canon_parts,
  which maps F2a's employed, pupils, mood, health and money onto PART_COUNTS and the sums), folk.region_parts,
  folk.sample_hour, folk.living, folk.worth, folk.home_place, folk.rings.

## Failures traced to other packages' files
- L1, tests/test_people.py: three tests assume agent.life is None before the hooks: test_night_shift line 89,
  test_no_life_no_prompt, and NewsGateTest line 106.
  - L1's branch already drops the line-89 assert.
  - For test_no_life_no_prompt, set dana.life = None first.
- L1/L2, people.news_gate: it counts sim.life.today["folk_news"], and the life stub never rolls today over.
  Unless L2's LifeCity resets today at each day change, folk-only News stops for good after the first 60. That
  is why NewsGateTest line 106 fails.
- L1 or the integrator, tests/test_foundation.py ForkShapeTest and tests/test_travel.py RunningCityTest: these
  fail only with v3-l1 merged.
  - The builder people.pending_fork yields L1's prompt kinds (crush, asked_out) rather than "pending".
  - crush is major although it is not in housing_forks.MAJOR_KINDS.
  - The named migration needed: kind in people.PROMPTS for that builder, and major per L1's rule.
- On a scratch HEAD+v3-l1+v3-l2 tree (built with merge-tree and archive, no refs), these also fail:
  test_review_world QuietOptionsHaveOutcomes; test_travel's 60-agent count (a birth makes 61);
  test_folk_days.SettleTest (needs differ by 10). These belong to L1, L2 and F2a.
- R1b, tests/test_region_named IdentityTest: passes alone (tick max 8.6 ms) but can fail in the full suite with
  one 160 ms tick against its 50 ms process_time cap. Cause: generation-2 GC passes of 60-130 ms once earlier
  modules (test_folk_days, test_folk_gen) have grown the heap to about 200k objects. Suggested fix: gc.collect()
  and gc.freeze() before the timed loop, or time with gc disabled. My folk tests release their fixtures in
  tearDownClass.

## INTEGRATOR
1. Regenerate the dev fixture with `python3 -m tests.test_integration --write-fixture`. Then remove the
   `if '"folk_n":' in fixture_town.js` conditional in tests/test_client_view.py (after STATE_KEYS and
   AGENT_KEYS) and keep the extra keys unconditionally.
2. README: the defaults are now `--world region` and `--folk 1000`; `--world millbrook` (or `--folk 0`) is v2's
   town.
3. Commands:
   - `nice -n 10 python3 -W ignore -m unittest tests.test_hooks tests.test_folk_protocol tests.test_folk_isolation`
   - `nice -n 10 flock /tmp/v3-slow.lock python3 -W ignore -m tests.perf_folk` (add --quick for a 20 s server
     run)
   - `python3 port/build.py && flock /tmp/v3-browser.lock node port/tools/page_check.cjs`
   - Regenerate the folk fixture with `python3 -m tests.test_folk_protocol --write-fixture`.
4. On every merge, keep `port/src/engine.json`'s engine list complete: ... "money.js", "cast.js",
   "folk_model.js", "folk_names.js", "folk_gen.js", "folk_transit.js", "folk_life.js", "folk.js", "sim.js".
   Earlier tag heads carry shorter lists.

## API NOTES
- The JS constructor is `new Simulation(seed, now, luck_log_path, dice, {world, folk, folk_isolated})`.
- server.frame_span and host.frame_span both return FRAME_SECONDS exactly for an on-time pass.
- The page sets GameOfAILifePage to {seed, dice, world, folk}.
- `stats.folk_parts(sim, hourly=False)` / `folk_parts(sim, hourly)`: None/null without townsfolk.
- Named test migrations in my commits: test_foundation PLAN_BUILDERS gains "pending"; test_port STATS_SCHEMA
  city gains "life"; test_dashboard CITY_KEYS gains "life".

## Perf (tests/perf_folk.py, region seed 1)
Full run under flock /tmp/v3-slow.lock at this HEAD's code, after this round's stats fix: OK.
- Engine, one game day, best of 3 process_time runs (load 3.1): folk 0 mean 0.31 ms, p99 1.33 ms; folk 1000
  mean 0.59 ms, p99 5.98 ms (gate 8 ms), max 27.3 ms, 1.91x the mean (gate 5x).
- Server, speed 16, folk 1000, God view, 120 s (load 2.5): 1.70 ms CPU a tick (gate 20 ms) over 4,610 ticks,
  38.4 ticks/s, 2,354 frames, welcome 431 KB.
- Node, one game day (load 2.4): 0.74 s wall (build 0.33 s).
- One quick engine run (best of 1) without the ring reuse and the lean hourly sample gave p99 9.74 ms. That is
  why `folk_parts(sim, hourly=True)` exists.

## Checks at this HEAD
- `tests.test_hooks tests.test_dashboard tests.test_folk_protocol tests.test_folk_isolation tests.test_port
  tests.test_seams`: 162 tests OK (3 skipped).
- `page_check.cjs` (region, 1000 folk): ok, 0 errors.
- Full suite: 929 tests, 5 failures, all listed above. One is test_integration DevFixture: fixture_town.js is
  the integrator's, see INTEGRATOR 1, or set GOAL_SKIP_DEVFIXTURE=1. Three are L1's test_people tests. One is
  R1b's IdentityTest GC tick (128 ms); it passes when run alone (15 s).

# HANDOFF-L2: life course, career and money

Branch `v3-l2`, worktree `.claude/worktrees/v3-l2`. Tag produced: `v3-skel-life` (94c7b38). Tags merged:
`v3-skel-tags`, `v3-skel-folkmodel`, `v3-skel-people`, `v3-skel-region`, `v3-region-frozen`, `v3-region-homes`
(f6edd0d), `v3-skel-hooks` (9f3360a), `v3-folk-gen` (7786667), `v3-folk-live` (72a8e57). The newer heads of
`v3-folk-gen` (547e5c1) and `v3-folk-live` (bb030fc), which moved at about 05:00, are **not merged**: every number
below was measured before them. Their `Folk.new_household` now takes both call forms, so housing's folk dispatch
(`sim.folk.new_household(ids, home_id, how)`) stays valid; re-run the soak after merging them.

Full suite (`GOAL_SKIP_DEVFIXTURE=1 python3 -m unittest discover -s tests`, 05:03): 944 tests, 19 skipped, 4
failures, none in L2's files: `test_people` x3 (edit 2) and `test_travel` 61 != 60 (edit 4).

## What works (Python and JS, lockstep)

Must-ship core, all in:
1. Illness: acute conditions by season and age (cold, flu, stomach bug, back pain, fracture), heart attack and stroke,
   chronic conditions by age, the doctor ($40, 30% shorter), contagion at home, the hospital ward ($60 a day, an
   hourly `_ward_care` for the named), discharge, `max_health`.
2. Mortality from `life_tables` (DEATH_YEAR x PACE / 360 x MULT_UNTREATED x MULT_TREATED, x3 under health 40, x10
   for a heart condition in the ward); `on_death` frees the job slot, widows, grieves, closes loans and agenda rows.
3. Birthdays on each person's own day (`legacy_ageing` is empty); a named child's school at 5 and `came_of_age` at
   18; folk birthdays go to `folk.on_birthday` then `folk.on_job_change`.
4. Births: conception, 90-day pregnancy, 08:00 birth; folk through `folk.add_baby`; named babies as Agents (id = first
   name, else first_surname); Shira Peretz's baby on day 4 on every seed; under-5s `toddle` in 2-hour spells.
5. `money.weekly`: benefit, lifestyle (rises .25, falls .06), wealth spend, belt-tightening halves it, one bad and
   one good luck-shifted shock, chronic costs ($15 a treated condition), children's costs paid by the richest adult,
   0.4% interest on debt, savings cover a negative purse.
6. The one JobBoard: layoffs (slots reopen 7-30 days later), hiring for both tiers (named best paid, folk nearest by
   `sim.folk.commute_minutes`, the 1.25x pay cap), the $200 x 13-week benefit.

Then, in the brief's order, all in: standing in `on_shift_end` (pupils keep v2's +0.5); reviews, raises and warnings
(fired under 20 with 2 warnings); the network (+.02, takes the friend's workplace slot) and standing terms of hiring;
chronic costs; promotions ("senior ", "head ", x1.2); job offers (10-25% more, settled by `people.settle_choice`
for both tiers); retirement (at each review from 65: .4, .6, 1.0); coworkers on hiring (up to 4 at 15-25); the soak
(`tests/test_life_soak.py`); the paired luck run (`tests/test_luck_paired.py`).

## Stubbed or cut

- Named `laid_off` and `retire` forks (life.md 5.9 `career_forks`): not built; both are settled at once.
- Moving out at 20+, college at 18 and the nursery at 3 (life.md 5.6): not built.
- Folk doctor visits make no trip; `you.life.children` counts, it does not list.

## Numbers (measured with the load)

Load average 8-9 throughout (other packages' runs); CPU seconds are `process_time`.

- **First week** (`tests/test_early_days_life.py`, seeds 1-3): Shira Peretz's baby on day 4 on every seed (61 agents),
  illness in the week, Ari Ben-David's bill on day 2, nobody starving among the named.
- **30 days, seed 1, region with 1,000 townsfolk (1,062 people)**, 39 s CPU: median adult worth 1.093x start, 37.5%
  of adults poorer, 7.0% in debt, Gini 0.53, ill now 6.8%, standing median 54.5; busiest News day 27, mean 15.9.
- **Soak, 180 days, region, seeds 1-3** (about 210-225 s CPU each): births 3, 7, 10 (20, so 12.8 per 1,000 a year);
  life's deaths 7, 7, 7 (21, 13.5 per 1,000 a year) plus **100, 104 and 107 townsfolk starved** (folk.py, edit 1
  below); ill now 3.2%, 4.6%, 4.4%; raises in 498 of 1,032, 509 of 1,074, 481 of 1,065 reviews (0.47); 2, 1, 2
  warnings, 0 fired; laid off 22, 20, 14; median adult worth 1.739x, 1.718x, 1.660x start; poorer 28.6%, 28.0%,
  27.9%; in debt 8.4%, 7.4%, 8.3%; Gini 0.50, 0.49, 0.51; busiest News day 37, 34, 38 with the starvation deaths
  (36, 33, 35 without them); mean 16.0, 17.3, 16.4; workers' standing median about 60.
- **Luck 0 for everyone, seed 1, 180 days**: 1 fired and 30 laid off of 596 workers (5.2%); raises in 95 of 1,017
  reviews; ill now 7.5%; 34.5% poorer, 12% in debt.
- **Soak verdict**: births, deaths, ill now, luck-0 job losses, raises per review, poorer, in debt and Gini are in
  bounds. The median worth bound (1.7x) fails on seeds 1 and 2 by 1-2%: the 100+ townsfolk who starve are mostly
  pensioners whose worth was falling, so the survivors-only median probably rises without them (not proven); re-run
  once F2a's fix lands before changing money's rates. **The News bound (<= 30 a day) fails** on every seed, 33-36
  even without the starvation deaths (mean 16-17 a day): not yet diagnosed. `people.news_gate` caps townsfolk-only
  News at 60 a day (L1), so life alone cannot hold a 30 a day peak; the peak days' tags need looking at, then
  either a lower folk cap (L1) or quieter life events (L2).
- **Standing** (`test_career.StandingSoak`, Millbrook, luck 50, 120 days): median 48.6, 0 of 38 workers below 20.
- **Paired luck run** (`tests/test_luck_paired.py`, 120 days): seed 1 median +$818, mean +$1,186, 36 of 45 better
  off; seed 2 +$1,056, +$1,101, 40 of 45; seed 3 +$1,087, +$1,126, 41 of 45 (life.md 5.10's v3 design: +$1,283,
  +$1,036, +$1,034).
- **Housing economy** (`SOAK_DAYS=120`, seeds 1-3, life on): max arrears 3, 3, 3; lowest Monday funds -$457, -$320,
  -$998; moves 18, 18, 16; purchases 5, 3, 4. **Floors changed**: `FUNDS_FLOOR` -$2,500 to -$1,250 (-$998 x 1.25:
  life's shocks and debt interest do make Mondays redder than v2's 120 days, but v2's -$2,500 was the 360-day gate
  without life, so the measured value with the margin is tighter); `max_arrears < 4` kept as `ARREARS_LIMIT` (3 x
  1.25 = 3.75). At 360 days the integrator may need to re-measure.
- **Lockstep**: `parity_life.cjs` 8 days of the 60 with life on, Python = Node (`GOAL_SLOW=1 tests.test_life.
  LifeLockstep`, OK); a Python-vs-Node twin of reviews, promotions, retirement and offers (`test_career`).
- **R1b identity** (`tests/test_region_named.py`, GOAL_SLOW): OK, 16 tests, region tick max 12.4 ms, mean 0.35 ms.

Migrated tests (named, with why): `test_foundation` (no `old_age` roll in the day order: life rolls in each
person's slot minute); `test_review_decisions.TestOldAgeOdds` (the old-age roll is life's mortality: odds = DEATH_YEAR
x PACE / 360 via `life._health`); `test_housing_economy` (the two money floors, above).

## Edits needed in files L2 does not own

1. **F2a, `gameofailife/folk.py` and `port/src/folk.js`: retired and jobless townsfolk starve.** `Folk.options`
   offers "Buy groceries" only `after_work`, and "Stay home" on a `day_off` is `dinner_home` only with groceries > 0,
   so a household with no worker never restocks: after breakfast an elder living alone goes hungry until bed every
   day and starves from about day 20. Region, seed 1, 28 days: 7 of 8 deaths are `starved`, all aged 69-83, all in
   households at 0 groceries; with `money.weekly` turned off the same 7 starve (life's money is not the cause).
   Suggested: add "Buy groceries" to `day_off` when groceries < 4 (+1, as `after_work` has it). Until then the
   soak counts `folk.counters["starved"]` apart from life's deaths.
2. **L1, `tests/test_people.py`** (3 failures with life on): `test_night_shift` asserts `dana.life is None`;
   `test_no_life_no_prompt` expects no prompt from a lifeless agent; `test_folk_only_news_is_capped` jumps
   `sim.clock.tick += 1440` without a step, but with life on the counter is `sim.life.today`, which `life.tick`
   rotates at 00:00. Set `self.sim.agents["dana"].life = None` in the first two, and add `sim.life.today.clear()`
   after the day jump in the third (or step to 00:00).
3. **F3/D, `gameofailife/forks.py` `work_fork`**: it skips only `life.in_hospital(agent)`; make it
   `if not life.can_work(sim, agent): return None` so an illness with `off_work` keeps a named character home, as it
   does for townsfolk.
4. **D or the integrator, `tests/test_travel.py:190`**: `assertEqual(len(run.sim.agents), 60)` fails from day 4,
   when Shira Peretz's baby is born; use `assertGreaterEqual(..., 60)` or count the cast.
5. **Integrator**: regenerate `client/dev/fixture_town.js` and `tests/fixtures/city_seed1.json` (`stats.city.life`,
   the `life` page block, `ill`/`stage` in the state, 61 agents from day 4).
6. **V1b**: a named baby joins `state.agents` mid-run (id = first name, else `first_surname`); the client must accept
   a new agent id after the welcome.
7. **`tests/test_port.py` `LockstepRun.test_eight_days_of_friendships_and_rifts`** (GOAL_SLOW): with life on, dice 2
   gave no `falling_out` in 8 days when last measured (Python and JS agree; only the count assertion fails). Its
   owner should pick a dice seed with a rift, or lengthen the run.

## Tests the integrator must run

- `python3 -m unittest tests.test_life tests.test_career tests.test_money tests.test_early_days_life`
- `GOAL_SLOW=1 python3 -m unittest tests.test_life.LifeLockstep` (the 8-day Node lockstep of the 60, life on)
- `GOAL_SLOW=1 SOAK_DAYS=120 python3 -m unittest tests.test_housing_economy` (floors re-measured, below)
- `GOAL_SLOW=1 python3 -m unittest tests.test_life_soak tests.test_luck_paired tests.test_career.StandingSoak`
  (SOAK_DAYS and SOAK_SEEDS shorten them)
- `GOAL_SLOW=1 python3 -m unittest tests.test_region_named` (R1b's identity test, life on)

# HANDOFF F1: townsfolk population and folk money core

Branch `v3-f1`. Tags: `v3-skel-folkmodel` (folk_model), `v3-folk-gen` (generation, folk money, its JS twin).
Merged: v3-skel-tags, v3-skel-people, v3-skel-life, v3-skel-region (latest fa53ec8), v3-region-homes (latest
f6edd0d), v3-rail-trips, v3-rail-js, v3-skel-hooks. The integrator deletes this file. Full suite on this HEAD
(`GOAL_SKIP_DEVFIXTURE=1`): 877 tests, 10 skipped, 3 failures, all in `tests.test_people` and already failing on
`v3-skel-hooks` alone (item 4 below).

## Done
- `folk_model.py/.js`: Person (life.md 3.2 protocol, `__slots__`, lazy needs), FolkHousehold, Trip, namespaces
  101-106, leg kinds, crowd modes.
- `folk_names.py/.js`: 150 + 150 first names, 200 surnames, none shared with the cast's first names.
- `folk_gen.py/.js`: `populate`, `newcomer`, `baby_name`, `generate`, `dump`, `python3 -m gameofailife.folk_gen
  --dump 1`; jobs from every `town.job_slots` row onto `career.board(sim)` (`p.job.slot`), ties only via
  `people.set_rel`; isolated mode; `housing.list_vacancies` after populating. Node generation parity exact.
- `folk_life.py/.js`: `pay_shift`, `pensions`, `weekly` (books to the cent, v2 arrears rule, saving, emergency
  fix), `nightly` (folk homes' damp, chills, emergencies on `(NS_FOLK_HOME, home_id, day)`), `on_birthday`, `join`,
  `split`, `release`, `new_household`, `on_household_empty`, `vacancies`, `folk_move`, `folk_vacate`.
- Tests: `tests.test_folk_gen` (20) and `tests.test_folk_money` (9, including a three-week Python/Node rehearsal
  of folk_life compared person by person).

## Cut (in the brief's order)
The folk market (crowded upgrades, buying, renovation), newcomers (`folk_gen.newcomer` exists in both languages
but nothing calls it), the 07:00 digest. Folk-home damp/emergencies and the Node parity of folk_life are in.

## Generation numbers (SimStub, `populate` process_time, load average in brackets)
| seed | households | 0-17 / 18-64 / 65+ | workers employed | train / walk / car | median commute | teen riders | Millbrook rows | vacant homes | cpu |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 424 | 234 / 610 / 156 | 558 / 558 | 107 / 194 / 257 | 22 | 11 | 142 / 142 | 151 / 575 | 0.34 s (9.8) |
| 2 | 422 | 230 / 619 / 151 | 577 / 577 | 113 / 189 / 275 | 20 | 12 | 142 / 142 | 153 / 575 | 0.29 s (10.0) |
| 3 | 421 | 235 / 620 / 145 | 571 / 571 | 110 / 177 / 284 | 22 | 6 | 142 / 142 | 154 / 575 | 0.31 s (10.0) |

Train commuters are inside the 86-116 model on every seed. Teen riders are low (6-12): most of Riverton High's
pupils live within the 25-minute walk or are driven; the train is taken only at <= 45 min and when it saves 5 on
the walk. Node generation 0.46-0.61 s cpu (report only).

Integrated (scratch tree = this HEAD + `v3-folk-live`'s folk.py and folk_transit.py, `Simulation(world="region",
folk=1000)`): weekday train boardings 296 / 329 / 308 on seeds 1-3 (target >= 250). Seed 1 over 14 days: no
exceptions, folk worth 3.81M -> 4.29M with Sunday drops of about 220k; 90 of 424 households end poorer, 9 in the
red and in arrears; about 1.1 s cpu a game day (load 4-6).

## region.md 7 rules in
All five: door-to-door worst-case commute (`rail.worst_minutes` + `region.car_extra`); car shares flat .2, house
.55, big house .9, x.6 within 15 walk-minutes of a station; reservation wage 15 + 25 x skill on region rows only
(Millbrook's 142 rows take any seeker who walks <= 25 or drives <= 30); park-and-ride (`rail.worst_minutes(...,
car=True)`, <= 12 min to the station); teens to Riverton High by train when it is <= 45 min and saves 5.

## Changes needed elsewhere
1. **housing.py:1518 / housing.js:1477 (L2's "life: households" hunk):** `sim.folk.new_household(sim, members,
   home_id, how)` passes four arguments, but F2a's `Folk.new_household(self, member_ids, home_id, how)` takes
   three, so a TypeError is raised the first time a townsperson splits through `housing.new_household`. The fix:
   `sim.folk.new_household([m.id for m in members], home_id, how)` (JS: `members.map(m => m.id)`).
   `folk_life.new_household` takes ids or people.
2. **R1a, region.json:** the "green" gardener row has count 1, so the named park keeper can have only one folk
   coworker on an overlapping shift. `test_folk_gen` asks for min(2, the overlapping slots there). Count 2 meets the
   brief's ">= 2 folk coworkers".
3. **F2a, folk.js:** call `G.folk_life.pay_shift` at shift end and delegate `nightly`, `pensions`, `weekly`,
   `new_household`, `on_household_empty`, `join`, `split`, `release` and `on_birthday` the way folk.py does.
   `folk_life` calls `folk.kill` and `folk.on_job_change` only when `sim.folk` has `wheel` (Folk, not GenFolk).
4. **Pre-existing failures, not F1's:** `tests.test_people` fails 3 tests (test_night_shift,
   test_folk_only_news_is_capped, test_no_life_no_prompt) on the `v3-skel-hooks` tag alone, because the hooks
   make `Simulation` run `life.init`. L1/F3 should pick them up.

No housing helper rejected a `FolkHousehold`: `weekly_cost`, `weekly_outgo`, `list_vacancies`, `value`,
`sale_proceeds`, `fix_emergency`, `stage_of`, `condition_of` and `_change_condition` all work on it.
`fix_emergency(sim, hh, payer)` gets the folk payer as agent, so the news stays folk-only.

## Folk section for F3's protocol
> **Townsfolk.** In the region world, 1,000 townsfolk (`--folk N`; 0 in millbrook) live in about 420 households
> in the region's homes. Ids: `f<i>` for a townsperson (i is their index, newborns continue it) and `fh<j>` for a
> household; a region home's `household` is an `fh` id and its `owner` is `"landlord"`, `"market"` or the
> household's id. Each townsperson has a unique name across all 1,060, `age`, `sex` (`"f"`/`"m"`), six traits
> (thrift, family, social, diligence, health, adventure, 0-1), v2's needs, `health`, `money` and `savings` (dollars,
> two decimals), `owns_car`, a `job` (title, place, hourly wage, start and end hour, workdays; pupils are
> `"student"` at a school with wage 0) and a `commute` `[place_id, minutes, "walk" | "car" | "train"]`. Folk money:
> take-home pay at the end of each shift, the $400 pension on Friday 09:00 to 65+ without a paid job, and on Sunday
> 23:00 rent or property tax split by the adults plus $80 bills per adult and $40 per car, then saving. Three
> Sundays in the red move a household to a cheaper rental or out of town (`left_town`, its `agents` the folk ids).
> Folk homes have their own damp, chills and emergencies (`damp_chill`, `emergency`, `emergency_settled` naming
> folk only). With `folk_isolated`, no townsperson has a tie to the 60, a job at Millbrook's places or a seat at
> Millbrook's school.

## Tests to run
`nice -n 10 python3 -W ignore -m unittest tests.test_folk_gen tests.test_folk_money` (about 6 s; both Node
checks run when `node` is present). Regenerate `tests/fixtures/folk_seed1.json` with `python3 -m
gameofailife.folk_gen --dump 1 tests/fixtures/folk_seed1.json` only if region.json or the cast changes (after a
change to region.json's rows, re-check the Millbrook-row and coworker numbers).

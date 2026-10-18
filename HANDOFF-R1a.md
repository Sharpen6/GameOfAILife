# HANDOFF R1a: region data

Branch `v3-r1a`. Tags: `v3-skel-region` and `v3-region-frozen` (same sha, the freeze commit). Merged: `v3-skel-tags`,
`v3-skel-rail` (engine.json resolved to PLAN 4's order).

## What works
- `gameofailife/data/region.json` (version 2, 212,099 B, sha1 3db25cc3): the prototype file plus one additive key,
  `districts[].parking_minutes` (downtown_riverton 10, midtown 8, else 0). Ids and counts are the prototype's:
  **no id changed after the freeze.**
- `gameofailife/regiongen.py` (`python3 -m gameofailife.regiongen --check | --write | --stats`): gen.py as a module.
  Its output minus the additive keys is the hour-0 file byte for byte (`HOUR0_SHA1` 29a45ed5). `--check` 40-47 ms CPU.
- `gameofailife/region.py` / `port/src/region.js`: everything in the R1a brief's contract. `build_region(seed)`
  about 12 ms CPU after load (Node about 110 ms wall incl. JIT, Chromium 47 ms). `map_json()` 172,648 B
  (`json.dumps` default separators) with keys `w h tiles places districts streets junctions world millbrook rail
  highways interchanges decor`. `districts` is Millbrook's 7 then the region's 10.
- `town.py` / `town.js`: `Place.capacity` (only in `to_json` when > 0) and the TownMap region defaults.
  `lot_conditions` defaults to a read-only empty mapping (`MappingProxyType({})` / a frozen `{}`).
- `port/build.py` inlines REGION_DATA as a plain `<script>` before the port scripts (page 1.15 MB);
  `port/tools/engine.cjs` `load()` sets it from the data file. `page_check.cjs` on `port/dist`: ok, 0 errors.
- `tests/test_regiongen.py` (25 tests, about 5 s) and `tests/fixtures/region_seed1.json`;
  `port/tools/parity_region.cjs` (Node parity of map_json, priced homes, job slots, lots, rent_at, car_extra,
  district_at, walk/street codes, seeds 1-2).

## Numbers (seed 1)
575 homes (flat 388, house 165, big_house 22; let 501, owned 71, for_sale 3: 572 start-occupied); 334 region places
(home 177, shop 58, cafe 43, office 14, station 9, works 9, park 6, school 5, market 4, townhall 4, venue 3, bank 1,
hospital 1); slots 1,241 region + 142 Millbrook; 1,020 school seats; 105 cafes/shops/markets; 1,019 buildings
(Millbrook's 35 + the region's 328 non-park places + 656 decor), 30 of 10+ floors; 284 junctions; within 15 road-walk
minutes of a station 136 homes and 308 slots (RoadNet).

## Notes for consumers
- JS: `millbrook_ids` is a `Set`, `lot_conditions` a plain object, rows are arrays (`home_specs`, `job_slots`).
- `rent_at(town, home, condition)` takes a housing `Home` or a home_specs row; `car_extra` is 0 in millbrook.
- `warm()` builds only Millbrook's 39 places' walk + road fields and the bus stops' walk fields; `warm_next()` is
  False (PLAN 1).
- north_park's rect (95, 26, 12, 10) also holds Northgate station and the R tracks; its own tiles are the P/T ones.
- `district_at(x, y)` gives a region place's own `district` on its footprint and entry tile, then Millbrook's v2
  blocks inside its 80 x 50, then the region rects. It differs from the rects only at quayside_station (district
  quayside, inside downtown_riverton's rect), so district_at, car_extra and the price table agree on every place.

## For the integrator
- `python3 -m gameofailife.regiongen --check` (exit 1 when stale), `python3 -m unittest tests.test_regiongen`.
- Regenerate `tests/fixtures/region_seed1.json` only after a deliberate additive change:
  `python3 tests/test_regiongen.py --write-fixture`.

### `docs/protocol.md`, section `## Region map` (paste under F3's heading)

```markdown
## Region map

In region world (`--world region`, the default of the server, `__main__` and the port page) the God welcome's
`town` is the 256 x 192 region with Millbrook in its north-west corner. It keeps every key of [Town](#town) except
`road_rows`, `road_cols` and `road_col_end`, which only the millbrook world sends; `w`, `h` are 256, 192. It adds:

| Field | Meaning |
|-------|---------|
| `world` | `"region"`; the millbrook world (v2's 80 x 50 map) sends `"millbrook"` and none of the keys below. |
| `millbrook` | `[0, 0, 80, 50]`: Millbrook's own 80 x 50 as `[x, y, w, h]`. Tiles at x < 69, y < 50 are exactly the millbrook world's for the same seed. |
| `rail` | `{"lines": [...]}`, the railway, see below. `timetable.train` and `state.trains` are in [Trains](#trains). |
| `highways` | `[{"name", "line", "width"}]`: `line` is the corner tiles `[[x, y], ...]` of the road and `width` its width in tiles (Route 9 along y 155, Route 9 North along x 231). Cars only. |
| `interchanges` | `[[x, y], ...]`: where streets join a highway. |
| `decor` | `[[x, y, w, h, style, floors, variant], ...]`: 656 buildings with no part in the simulation, standing on `B` tiles; `style` is a renderer model as for places, `variant` 0-7. |

More tile codes: `b` road bridge and `x` level crossing (streets, walkable), `F` farmland (walkable), `=` railway,
`r` rail bridge and `S` platform (not walkable), `H` highway and `h` highway bridge (cars only).

`districts` lists Millbrook's 7, then the region's 10: `northgate`, `the_heights`, `north_woods`, `quayside`,
`downtown_riverton`, `midtown`, `ironworks`, `willow_hills`, `southfield`, `greenacre`. A region district also has
`parking_minutes`, the minutes a driver spends parking there (10 Downtown, 8 Midtown, else 0). `junctions` are the
street tiles with three or more street neighbours.

Every place except a home has `capacity`, how many people fit inside at once (no place has it in the millbrook
world). Region places add the kinds `station` and `venue`; a restaurant is kind `cafe` with style `restaurant`.
Region ids are never integer-like and never one of Millbrook's.

A line in `rail.lines`: `{"id", "name", "cars", "tracks", "track_tiles", "stations", "trains", "every", "speed",
"dwell", "layover", "capacity", "fare"}`.

| Field | Meaning |
|-------|---------|
| `id`, `name` | `"R"`, the Riverton Line (6 stations), or `"S"`, the Southfield Line (4). |
| `tracks` | `{"out": [[x, y], ...], "in": [...]}`: each track's corner tiles, buffer to buffer. A train's `i` indexes its track's tiles walked from the first corner. |
| `track_tiles` | `{"out": n, "in": n}`: the tiles on each track. |
| `stations` | In line order, `{"id", "name", "i", "platforms", "exits"}`: `id` is the station's place id; `i` is `{"out": k, "in": k}`, the track index where a train's head stops; `platforms` the platform rects `[x, y, w, h]` beside the out and the in track; `exits` the street tiles where riders come and go, a minute from the trains. |
| `trains` | The line's train ids: `R1` to `R6`, `S1` to `S4`. |
| `every` | Minutes between trains each way. |
| `speed` | Tiles a minute. |
| `dwell`, `layover` | Minutes at a stop and at the end of the line. |
| `cars` | Cars a train draws, at `i-1` to `i-3`. |
| `capacity` | Riders a train holds (reported, not enforced). |
| `fare` | Dollars a ride for ages 18-64 (others ride free); the change at Central is free. |
```

### README map paragraph

**The region.** Millbrook is now the leafy north-west corner of a 256 x 192 region, 3.2 x 3.8 times larger: Northgate,
The Heights and North Woods across the river; Riverton Downtown's 8-30-floor offices round Central Station, Midtown's
towers and the Ironworks' factories; Quayside, Willow Hills and Southfield's homes, schools, stadium and mall; Route
9's highways and Greenacre's farms. 334 new places (328 buildings and 6 parks: 575 homes, 1,241 job slots, 9 stations
on two railway lines) and 656 decor buildings; with Millbrook's 35 the map has 1,019 buildings, 30 of them 10 floors
or more. Millbrook's own tiles (x < 69, y < 50) are
exactly v2's. The map is `gameofailife/data/region.json`, written at dev time by `python3 -m gameofailife.regiongen
--write` (`--check` says whether it is stale); `gameofailife/region.py` and `port/src/region.js` load it, apply the
district price table and lay Millbrook over its corner. `--world millbrook` keeps the v2 map.

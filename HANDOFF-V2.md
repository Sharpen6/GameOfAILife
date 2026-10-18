# HANDOFF V2: view art

Branch `v3-v2`. Tag produced: `v3-art-api` (re-tagged on the fix commit). Merged: `v3-skel-view`, `v3-skel-region`.
Files touched: owned files only (`client/view/art.js`, `buildings.js`, `actors.js`, `towers.js`, `rail_art.js`,
`client/dev/specimens.html`, `tests/browser/art_specimens.cjs`, this file).

## What works
- **spriteBox API (view.md 4.5).** `CV.spriteBox(p, look, proj?)` is pure; `art.spriteBox(p, look)` is bound to its
  art; `art.building` takes its bounds from it. Also `CV.heightOf`, `CV.paletteOf`, `CV.variantOf`, `CV.sidOf`,
  `CV.canonPlace`, `CV.signTextOf`, `CV.lookSig`, `CV.spriteKey` (style|w|h|floors|face|variant-or-id|lookSig|season|
  signText), `CV.SHOP_SIGNS` / `CV.FOOD_SIGNS`, `CV.hasStyle`. With a variant, sid = style#variant replaces p.id in
  every hash; Millbrook places (inside [0,0,80,50]) keep variant null and their id.
- **Shift-invariance by construction.** `art.building` draws a keyed place as its canonical copy (`CV.canonPlace`)
  and moves the canvas, windows, lights, porch, neon, smoke and beacon by whole pixels; spriteBox moves the
  canonical box the same way. Checked in iso rotations 0-3 and flat.
- **Sprite boxes.** Keyed (region) places get a box round the body plus 0.3 tiles; gable and hip roofs rise to topZ
  only along the ridge; stations rise to topZ only over the clock turret and keep 0.1 tiles off the drawn front;
  8 px under the front edge. **Millbrook's places keep v2's lot boxes exactly**: all 1050 Millbrook sprites
  (35 places x iso 0-3 and flat x 2 seasons x 3 stages) equal ead5b0b's canvas rect, pixels and window quads, so
  scaled blits at any zoom are v2's.
- **Region styles**, all drawn with no fallback boxes: house, shop and restaurant (awning and sign by variant),
  row_houses, big_house, warehouse, apartments and residential_tower (brick), tower (glass; above 15 floors setbacks
  at 60% and 85%, a crown plant room, a mast and a beacon; 15 floors or fewer a plain roof with AC units), hotel,
  station, library, police, fire_station, cinema, mall, clubhouse, stadium (floodlights), factory (sign by variant,
  'MILLBROOK WORKS' kept for Millbrook).
- **Ground tiles:** `art.rail`, `railBridge`, `crossing`, `platform`, `highway`, `highwayBridge`, `roadBridge`,
  `farm` (6 crops x 2 axes, colours by season); `art.road(..., marks)` adds edge lines on region streets (v2's
  zebras kept); `CV.groundKey(R, x, y, season) -> [drawer, ...args]` for every region.md 3.1 code with an
  `R.groundOverride` hook; `CV.groundTileOf(art, key)`; `CV.tileVariant`.
- **Movers:** `art.trainCar(color, dir e/s/w/n or 0-3, kind head|car|tail, open)`: oriented **112x92** sprite,
  anchor (56, 58), pantograph on the head, red lamps on the tail. `art.car` kinds van and truck (also **112x92**,
  anchor (56, 58)); car, taxi, ambulance stay v2's 112x84. `art.folkSheet(v, child)`: 24 sheets x adult/child,
  band 'o' (old) when v%7===6; `CV.folkShirt(v)`. `art.person`: v2 pixels unchanged. No mover touches its canvas edge
  in iso 0-3 or flat (tested).
- **Night glow keyed by spriteKey:** `art.glow(b, share?) -> {c, wx, wy} | null`, cached by b.key + share; lit windows
  hashed from the sid so every copy shares one glow; Millbrook's glow equals v2's scene glowOf pixel for pixel
  (tested). Brick blocks and the hotel push one glow quad per painted window.
- **Faster fills, pixel-identical:** poly merges equal neighbouring columns into one fillRect; the roof-hole test
  skips settled pixels and rejects by squared radius before atan2; keyed places sample roof holes every 0.5 px
  (Millbrook keeps v2's 0.35).
- `client/dev/specimens.html`: every style, the tile codes, train cars, folk sheets and vehicles; season, stage,
  view and Night controls; `window.SpecSheet = {draw, sample, STYLES, TILE_DEMO}`.

## Tests to run
- `node tests/browser/art_specimens.cjs` (232 checks, about 2-3 min): no console errors; every keyed sprite > 30%
  opaque (Millbrook's v2 sprites are report-only: v2 lot boxes by contract); spriteBox equals the canvas; nothing
  clipped; heightOf within 4 px of the roof; glow quads inside the sprite; shift-invariance, glow sharing and v2
  glow equality; spriteKey equal iff its 9 parts are; every tile code tw x (th+24) in iso and flat; R.code agrees
  with R.tiles; movers draw and fit their canvas; timing. Samples: one place per distinct (style, w, h, floors) of
  the region (73) plus all of Millbrook's. Writes `$ART_SHOTS/art_specimens.png` (default: the system temp dir).
- Timing (PLAN 6 + view.md 8): report-only at L > 8, else p95 <= 6 and max <= 10 ms times max(1, L/4); the timing
  pass runs up to 3 times while the gate fails and each sprite keeps its fastest draw.
- `node tests/browser/view_smoke.cjs` (295 passed) and `python3 -m unittest tests.test_client_view` (unchanged, pass).

## Timings (ms per sprite: draw plus raster, iso, 5 stages x 4 seasons, 2160 sprites)
- Final run at L = 4.43 (limit factor 1.11: p95 <= 6.6, max <= 11.1): single passes p95 9.1 / 8.0 / 7.0, max
  58.4 / 45.3 / 32.8; fastest of 3 passes **p95 5.6, max 10.6: pass**.
- At L = 2.88: fastest of 2 passes p95 5.9, max 8.4 (pass). At L = 2.00: fastest of 2 p95 5.9, max 9.3.
- The margin is thin: a single pass alone does not meet the gate (p95 6.4-9.1, GC and scheduling spikes up to 58 ms).
  Real cost stays highest for Millbrook's frozen v2 apartments (median about 6 ms), hospital and school.

## Sprite count and MP (whole region; no default camera on this branch)
- Region places plus decor: 984 sprites (328 non-park places + 656 decor; Millbrook's 35 v2 places on top).
- Stage 0, summer: 235 distinct sprite keys. Iso: 25.7 MP for the distinct keys (59.4 MP if every copy were drawn
  separately); drawing all 235 took 697 ms at L about 8.4. Flat: 20.8 MP distinct (51.7 MP unshared); 240 ms.
- The specimen sheet: 4.16 MP. Folk sheets: 0.37 MP (48 sheets).

## What V1a must call differently (scene.js and friends are V1a's)
1. Building sprite cache: key it on `CV.spriteKey(p, look, season)`, not `${p.id}|lookSig|season`. Draw once per key
   with `art.building(CV.canonPlace(p), look, season)`; place each copy at `CV.spriteBox(p, look, proj).ox/oy`
   (the canonical box moved by toWorld(p.x,p.y) - toWorld(0,0)); move windows, lights, porch, neon, smoke and
   beacon by the same (dx, dy). `art.building(p)` still works directly and returns the moved copy. Do not overwrite
   `b.key`: art.building sets `b.key` (the spriteKey) and `b.sid`; scene.js line 279 overwrites b.key, which only
   stops glow sharing.
2. Night: replace scene.js `glowOf(rec, share)` with `art.glow(b, share)` -> `{c, wx, wy}` or null, cached per key
   and share; draw it with the additive blit. For Millbrook it is pixel-identical to v2's glowOf.
3. Beacons: `b.beacon` is the beacon point (region towers above 15 floors only, and v2's tower). Blink it at 1 Hz;
   scene.js currently uses a 700 ms timer.
4. Region sprite boxes hug the body, not the lot; Millbrook's are v2's lot boxes. Anything that assumed canvas == lot
   must use spriteBox. heightOf and labelZ are unchanged.
5. Ground: choose tile art only via `CV.groundKey(R, x, y, season)` and `CV.groundTileOf(art, key)`. R may supply
   tiles (rows), charAt, or code plus CODE; the optional `R.groundOverride(x, y, season)` returns a key for Millbrook
   lots and lawns. Tile variants match scene.js: hash(x*7919 + y*104729 + 13) % 8.
6. Unknown styles draw through drawHall, so CV.boxBuilding is not needed at near; `CV.hasStyle(style)` exists.
7. scene isHouseLike treats row_houses and residential_tower as house-like (lawns); V1a may drop residential_tower.
8. Train cars and goods vehicles are now 112x92 (anchor unchanged); trains.js already reads sp.ax, sp.ay and the
   image size, so nothing else changes.

## Open items
- Timing passes only as the fastest of up to 3 passes, with little margin (above). If the integrator's gate run is
  at low load and still fails, the measured numbers are here to decide on.
- Beacon blink at 1 Hz is scene.js's (V1a); art only provides b.beacon.
- Sprite count and MP at V1a's default view were not measured (no region camera on this branch).
- Nothing from the cut-first list was cut.

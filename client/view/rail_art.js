// CityView rail art (v3): the ground tiles of a region (rail with ballast and sleepers, rail bridges, level
// crossings, platforms, highways, highway and road bridges, farmland) and the train cars. Tiles are tw x (th + 24)
// like art.js's and are chosen only by CV.groundKey; cars are 1 tile long and drawn through the projection.
// Classic script; installs its drawers on the art object built by art.js.
"use strict";
(function () {
  const CV = window.CityView = window.CityView || {};
  const { shade, mix, rng } = CV.color;
  const poly = CV.poly;

  CV._artParts.push(function (art) {
    const { groundTile, P, faceFn, quad, boxAt, proj } = art;
    const D = art.diamond, T = art.T, speckle = art.speckle, FACES = proj.faces;
    const SEASON = CV.SEASON;
    // A rect in tile-local axes: a runs along the track (x when alongX), b across it.
    const band = (alongX, a0, a1, b0, b1) => alongX ? D(a0, b0, a1, b1) : D(b0, a0, b1, a1);
    // The half-segments of a track tile from its mask (1 N, 2 E, 4 S, 8 W): [alongX, a0, a1]; a dead end runs
    // through, and a tile with no neighbour lies along x.
    function segs(mask) {
      const out = [];
      if (mask & 1) out.push([false, 0, 0.5]);
      if (mask & 4) out.push([false, 0.5, 1]);
      if (mask & 8) out.push([true, 0, 0.5]);
      if (mask & 2) out.push([true, 0.5, 1]);
      if (!out.length) return [[true, 0, 1]];
      if (out.length === 1) out[0] = [out[0][0], 0, 1];
      return out;
    }
    const axisOf = mask => (mask & 10) === 10 ? true : (mask & 5) === 5 ? false : (mask & 10) ? true : !(mask & 5);

    // Ballast, sleepers every 0.2 tiles (about 8 px along the track at zoom 1) and two rails.
    function track(g, mask, snow, deck) {
      const S = segs(mask);
      const ballast = snow ? "#d6dadc" : deck ? "#4a4e56" : "#8a8378", bal2 = snow ? "#eef2f2" : deck ? "#5a5f68" : "#a0988a";
      const sleeper = snow ? "#8a7a68" : "#5a4632", rail = "#6c7078", top = snow ? "#f4f6f8" : "#c8ccd2";
      for (const [ax, a0, a1] of S) poly(g, band(ax, a0, a1, 0.2, 0.8), ballast);
      if (!deck) speckle(g, mask * 7 + 3, [bal2, shade(ballast, 0.82)], 18, 0.22, 0.78);
      for (const [ax, a0, a1] of S) for (let k = 0; k < 5; k++) {
        const a = (k + 0.5) / 5 - 0.035;
        if (a + 0.07 <= a0 - 1e-6 || a >= a1 + 1e-6) continue;
        poly(g, band(ax, Math.max(a0, a), Math.min(a1, a + 0.07), 0.27, 0.73), sleeper);
      }
      for (const [ax, a0, a1] of S) for (const b of [0.355, 0.615]) {
        poly(g, band(ax, a0, a1, b, b + 0.03), rail);
        poly(g, band(ax, a0, a1, b, b + 0.012), top);
      }
    }
    art.rail = (mask, season, v) => groundTile(`rl:${mask}:${season}:${v}`, g => {
      g.drawImage(art.grass(season, v), 0, 0);
      track(g, mask, SEASON[season].snow, false);
    });
    // A steel deck over the water: girders along both edges with a lattice, the track on top, its shadow below.
    art.railBridge = (mask, season, v) => groundTile(`rb:${mask}:${season}:${v}`, g => {
      g.drawImage(art.water(0, v), 0, 0);
      const ax = axisOf(mask), snow = SEASON[season].snow;
      poly(g, band(ax, 0, 1, 0.86, 1), "rgba(10,30,60,0.35)");
      poly(g, band(ax, 0, 1, 0.1, 0.9), snow ? "#c8ccd0" : "#3e424a");
      track(g, ax ? 10 : 5, snow, true);
      for (const b of [0.1, 0.84]) {
        poly(g, band(ax, 0, 1, b, b + 0.06), "#7a8088");
        for (let k = 0; k < 4; k++) poly(g, band(ax, k / 4 + 0.02, k / 4 + 0.06, b, b + 0.06), "#a8aeb6");
      }
    });
    // A street over the tracks: the road, rubber panels across it and the rails set in, stop lines either side.
    art.crossing = (roadMask, railMask, season, v) => groundTile(`xc:${roadMask}:${railMask}:${season}:${v}`, g => {
      const snow = SEASON[season].snow;
      const ra = (railMask & 10) ? true : (railMask & 5) ? false : !((roadMask & 10) && !(roadMask & 5));
      // the road runs across the rails: give it the road mask without its rail sides
      g.drawImage(art.road(roadMask & (ra ? 5 : 10), 0, season, v, 1), 0, 0);
      poly(g, band(ra, 0, 1, 0.3, 0.7), snow ? "#c4c8cc" : "#6c6f76");
      for (let k = 0; k < 5; k++) poly(g, band(ra, k / 5 + 0.09, k / 5 + 0.11, 0.3, 0.7), shade(snow ? "#c4c8cc" : "#6c6f76", 0.86));
      for (const b of [0.355, 0.615]) { poly(g, band(ra, 0, 1, b, b + 0.03), "#5a5e66"); poly(g, band(ra, 0, 1, b, b + 0.012), "#d4d8de"); }
      for (const b of [0.2, 0.77]) poly(g, band(ra, 0.2, 0.8, b, b + 0.03), "#f2f2ee");
    });
    // Concrete slabs with a white coping and a yellow line along every side that meets the rails.
    art.platform = (railMask, season, v) => groundTile(`pf:${railMask}:${season}:${v}`, g => {
      const snow = SEASON[season].snow, base = snow ? "#e6eaec" : "#cbc6b9", joint = shade(base, 0.86);
      poly(g, D(0, 0, 1, 1), base);
      for (let i = 1; i < 4; i++) { poly(g, D(i / 4, 0, i / 4 + 0.015, 1), joint); poly(g, D(0, i / 4, 1, i / 4 + 0.015), joint); }
      speckle(g, v * 5 + 2, [shade(base, 0.92), shade(base, 1.04)], 10);
      const edge = (side, f) => side === 1 ? f(0, 0, 1) : side === 4 ? f(0, 1, -1) : side === 8 ? f(1, 0, 1) : f(1, 1, -1);
      for (const side of [1, 2, 4, 8]) {
        if (!(railMask & side)) continue;
        edge(side, (alongX, at, dir) => {
          const ax = side === 1 || side === 4, b0 = at === 0 ? 0 : 1 - 0.08, b1 = b0 + 0.08;
          poly(g, band(ax, 0, 1, b0, b1), "#f2efe6");
          const y0 = at === 0 ? 0.11 : 1 - 0.15;
          poly(g, band(ax, 0, 1, y0, y0 + 0.04), snow ? "#f2d24a" : "#e9c83a");
        });
      }
    });
    // Highway: dark asphalt, a dashed lane line, a white edge line and gravel shoulder on the outer side, a yellow
    // line and a concrete barrier on the side that meets the other carriageway.
    function highwayDeck(g, mask, season, v, bridge) {
      const snow = SEASON[season].snow, asphalt = snow ? "#5e6168" : "#45484f";
      const ax = axisOf(mask);
      poly(g, D(0, 0, 1, 1), asphalt);
      speckle(g, v * 11 + 3, [shade(asphalt, 1.14), shade(asphalt, 0.88)], 22);
      // sides across the carriageway: low (b = 0: N or W) and high (b = 1: S or E)
      const lowSide = ax ? 1 : 8, highSide = ax ? 4 : 2;
      for (const [side, at] of [[lowSide, 0], [highSide, 1]]) {
        const s0 = at === 0 ? 0 : 0.93, s1 = s0 + 0.07;
        if (mask & side) { // the median: barrier and a yellow line
          poly(g, band(ax, 0, 1, at === 0 ? 0 : 0.96, at === 0 ? 0.04 : 1), "#c8c6be");
          poly(g, band(ax, 0, 1, at === 0 ? 0.07 : 0.91, at === 0 ? 0.09 : 0.93), "#e2c23a");
        } else if (bridge) { // a parapet
          poly(g, band(ax, 0, 1, s0, s1), "#d4d0c6"); poly(g, band(ax, 0, 1, at === 0 ? s1 - 0.015 : s0, at === 0 ? s1 : s0 + 0.015), "#9a968c");
          poly(g, band(ax, 0, 1, at === 0 ? 0.1 : 0.88, at === 0 ? 0.12 : 0.9), "#f0f0ea");
        } else { // shoulder and edge line
          poly(g, band(ax, 0, 1, s0, s1), snow ? "#d8dcdc" : "#8a877e");
          poly(g, band(ax, 0, 1, at === 0 ? 0.1 : 0.88, at === 0 ? 0.12 : 0.9), "#f0f0ea");
        }
      }
      for (const a of [0.06, 0.56]) poly(g, band(ax, a, a + 0.2, 0.49, 0.515), "#f0f0ea"); // lane dashes
      if (bridge) poly(g, band(ax, 0.48, 0.5, 0, 1), shade(asphalt, 0.75)); // expansion joint
      if (snow) speckle(g, v * 3 + 7, ["#f4f6f8", "#dfe3e6"], 10);
    }
    art.highway = (mask, streetMask, season, v) => groundTile(`hw:${mask}:${streetMask | 0}:${season}:${v}`, g => highwayDeck(g, mask, season, v, false));
    art.highwayBridge = (mask, season, v) => groundTile(`hb:${mask}:${season}:${v}`, g => highwayDeck(g, mask, season, v, true));
    // A street bridge: the road with its pavements, and a stone parapet with posts along each open side.
    art.roadBridge = (mask, season, v) => groundTile(`bb:${mask}:${season}:${v}`, g => {
      g.drawImage(art.road(mask, 0, season, v, 1), 0, 0);
      const k = 0.06, st = "#d8d2c4", dk = "#8a857a";
      if (!(mask & 1)) { poly(g, D(0, 0, 1, k), st); poly(g, D(0, k - 0.015, 1, k), dk); }
      if (!(mask & 4)) { poly(g, D(0, 1 - k, 1, 1), st); poly(g, D(0, 1 - k, 1, 1 - k + 0.015), dk); }
      if (!(mask & 8)) { poly(g, D(0, 0, k, 1), st); poly(g, D(k - 0.015, 0, k, 1), dk); }
      if (!(mask & 2)) { poly(g, D(1 - k, 0, 1, 1), st); poly(g, D(1 - k, 0, 1 - k + 0.015, 1), dk); }
      for (let i = 0; i < 4; i++) { // posts along the parapets
        const a = i / 4 + 0.1;
        if (!(mask & 1)) poly(g, D(a, 0, a + 0.05, k), "#f2ede2");
        if (!(mask & 4)) poly(g, D(a, 1 - k, a + 0.05, 1), "#f2ede2");
        if (!(mask & 8)) poly(g, D(0, a, k, a + 0.05), "#f2ede2");
        if (!(mask & 2)) poly(g, D(1 - k, a, 1, a + 0.05), "#f2ede2");
      }
    });
    // Farmland: rows of one crop (v >> 1) running along x or y (v & 1), by season.
    const CROP = [ // [summer row, summer gap, autumn row, autumn gap]
      ["#d8b850", "#c49e3e", "#c8b070", "#a88a50"], // wheat
      ["#4f8a32", "#3a6a26", "#b8a050", "#8a6a3c"], // maize
      ["#5a9a3a", "#7a5838", "#7a5838", "#6a4a2e"], // potatoes
      ["#e8d040", "#8aa83a", "#9a8a4a", "#7a6a3e"], // rapeseed
      ["#8ab04a", "#76a03e", "#c8b460", "#b09a50"], // hay
      ["#6a9a3a", "#8a6a44", "#8a6a44", "#7a5a3a"], // vegetables
    ];
    art.farm = (season, v) => groundTile(`fm:${season}:${v}`, g => {
      const crop = CROP[(v >> 1) % CROP.length], ax = !(v & 1), S = SEASON[season];
      let row, gap;
      if (S.snow) { row = "#eef2f2"; gap = "#c8ccc8"; }
      else if (season === "spring") { row = "#6aa84a"; gap = "#8a6a44"; }
      else if (season === "autumn") { row = crop[2]; gap = crop[3]; }
      else { row = crop[0]; gap = crop[1]; }
      poly(g, D(0, 0, 1, 1), gap);
      for (let k = 0; k < 5; k++) poly(g, band(ax, 0, 1, k / 5 + 0.04, k / 5 + (season === "spring" ? 0.08 : 0.14)), row);
      const R = rng(v * 13 + season.length);
      speckle(g, v * 7 + 1, [shade(row, 1.12), shade(gap, 0.86)], 14);
      if (season === "autumn" && R() < 0.5) speckle(g, v + 3, ["#e8d090", "#f2e0a8"], 10); // straw
    });

    // --- train cars --------------------------------------------------------------------------------------
    // One car, 1 tile long, around tile-local (0.5, 0.5). dir: "e" "s" "w" "n" or 0-3 (heading +x, +y, -x, -y);
    // kind: head (windscreen, headlights, a pantograph on the roof), car, or tail (red lamps); open: doors open.
    const DIRS = { e: 0, s: 1, w: 2, n: 3 };
    art.trainCar = function (color, dir, kind, open) {
      const d = typeof dir === "string" ? (DIRS[dir] == null ? 0 : DIRS[dir]) : ((dir | 0) % 4 + 4) % 4;
      kind = kind === "head" || kind === "tail" ? kind : "car";
      const col = color || "#d23a3a";
      return art.oriented(`tc:${col}:${d}:${kind}:${open ? 1 : 0}`, 112, 92, 56, 58, g => { // 92 high: the flat view's shadow
        const ax = d % 2 === 0, L = 0.96, Wd = 0.4, hl = (ax ? L : Wd) / 2, hw = (ax ? Wd : L) / 2;
        const x0 = 0.5 - hl, y0 = 0.5 - hw, x1 = 0.5 + hl, y1 = 0.5 + hw;
        poly(g, [P(x0 + 0.04, y0 + 0.06), P(x1 + 0.08, y0 + 0.06), P(x1 + 0.08, y1 + 0.08), P(x0 + 0.04, y1 + 0.08)], "rgba(0,0,0,.3)");
        const body = "#dfe3e8";
        boxAt(g, x0, y0, x1, y1, 3, 24, body, "#a8aeb6");
        const frontFace = ["e", "s", "w", "n"][d], rearFace = ["w", "n", "e", "s"][d];
        for (const f of FACES) {
          const F = faceFn(f, x0, y0, x1, y1), lit = f === FACES[0], k = lit ? 1 : 0.82;
          poly(g, quad(F, 0, F.len, 3, 6), shade("#3a3e46", k)); // bogie skirt
          poly(g, quad(F, 0, F.len, 8, 10), shade(col, k)); // the line's stripe
          if (F.len > 0.6) { // a long side: windows and two doors
            for (let u = 0.06; u < F.len - 0.1; u += 0.16) poly(g, quad(F, u, u + 0.11, 13, 20), lit ? "#3a5a7a" : "#2e4a66");
            poly(g, quad(F, 0.06, F.len - 0.06, 18, 20), lit ? "#9cc8ea" : "#7aa6cc");
            for (const uc of [F.len * 0.27, F.len * 0.73]) {
              poly(g, quad(F, uc - 0.07, uc + 0.07, 6, 21), open ? "#16181c" : shade("#b8bec6", k));
              if (!open) poly(g, quad(F, uc - 0.005, uc + 0.005, 6, 21), shade("#7a8088", k));
            }
          } else if (f === frontFace && kind === "head") { // the cab: windscreen and headlights
            poly(g, quad(F, 0.04, F.len - 0.04, 13, 21), "#24303c");
            poly(g, quad(F, 0.06, F.len - 0.06, 18, 21), "#6a8aa8");
            poly(g, quad(F, 0.05, 0.11, 7, 9), "#fff6c8"); poly(g, quad(F, F.len - 0.11, F.len - 0.05, 7, 9), "#fff6c8");
          } else if (f === rearFace && kind === "tail") {
            poly(g, quad(F, 0.06, F.len - 0.06, 14, 20), "#3a4a5a");
            poly(g, quad(F, 0.05, 0.1, 7, 9), "#e0322a"); poly(g, quad(F, F.len - 0.1, F.len - 0.05, 7, 9), "#e0322a");
          } else { // a gangway end
            poly(g, quad(F, F.len * 0.3, F.len * 0.7, 6, 21), shade("#4a4e56", k));
          }
        }
        if (kind === "head") { // the pantograph: a folded diamond on two insulators
          const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
          for (const t of [-0.12, 0.12]) { const q = P(cx + (ax ? t : 0), cy + (ax ? 0 : t), 24); g.fillStyle = "#3a3e46"; g.fillRect(Math.round(q[0]), Math.round(q[1]) - 2, 2, 2); }
          const a = P(cx - (ax ? 0.14 : 0), cy - (ax ? 0 : 0.14), 26), b = P(cx + (ax ? 0.14 : 0), cy + (ax ? 0 : 0.14), 26), c = P(cx, cy, 34);
          g.fillStyle = "#2a2e36";
          const line = (p, q) => { const n = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]))); for (let i = 0; i <= n; i++) g.fillRect(Math.round(p[0] + (q[0] - p[0]) * i / n), Math.round(p[1] + (q[1] - p[1]) * i / n), 1, 1); };
          line(a, c); line(b, c);
          const e = P(cx - (ax ? 0 : 0.16), cy - (ax ? 0.16 : 0), 34), f2 = P(cx + (ax ? 0 : 0.16), cy + (ax ? 0.16 : 0), 34);
          line(e, f2);
        }
      });
    };
  });
})();

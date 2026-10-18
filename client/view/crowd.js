// CityView crowd: the townsfolk outdoors (state.crowd = [i, x, y, k, ...], sorted by i; k = mode | child << 3;
// modes 0 walk, 1 run, 2 car, 3 bike, 4 taxi, 5 ambulance, 6 waiting, 7 other outdoors; view.md 3.5, 4.2).
// CV.makeCrowd(scene, M) registers a mover source with scene.addMovers and keeps typed arrays of length
// folk_n: prev and cur (the move's two ends, tiles), axis (which leg of the L goes first), kind, seen.
// Positions ease from where each person was shown to the new tile along an L, over M.tickMs (the measured
// tick interval, kept by movers.js), and targets change only when st.tick does; a newcomer appears in place,
// a leaver fades over 300 ms. Walkers keep to a kerb (side and place along it by hash2(i, 7)), vehicles to
// their lane; standing people sharing a tile stand in a ring. Near: sprites (folk sheets, cars; cap 800, the
// rest as marks) merged by depth with everything upright; mid: 2 x 3 px walkers and 4 x 3 px vehicles;
// far: 1 px dots (vehicles 2 px). pick(wx, wy, r) -> {kind: "agent", id: "f417", folk: true}.
// Classic script on window.CityView; no random numbers (view.md 7).
"use strict";
(function () {
  const CV = window.CityView = window.CityView || {};
  const CAR_COLORS = ["#c0392b", "#2c6fbb", "#e4e4e0", "#2a2a30", "#3f8f4a", "#8a4fa0", "#d9822b", "#7a8a9a", "#6a1f2a", "#2fa3b5"];
  // 24 shirt colours, one per folk sheet (marks and dots use the sheet's colour)
  const SHEET_COLORS = ["#d8513f", "#3f7fd8", "#e2b23a", "#4fa860", "#9a5cc4", "#e07a3a", "#3fb3b0", "#c44a7a", "#7a8f3f", "#5a6ad0",
    "#d0d0c8", "#8a5a3a", "#e05a5a", "#5ab0e0", "#b0c040", "#606878", "#f09ab0", "#40806a", "#c08040", "#7050a0", "#a0b8d0", "#d07070", "#50a0a0", "#e0c080"];
  const KERB = 0.38, LANE = 0.17, RING = 0.26, SNAP = 12, FADE = 300, CAP = 800;
  const VEH = [0, 0, 1, 0, 1, 1, 0, 0]; // modes 2 car, 4 taxi, 5 ambulance drive
  const VKIND = ["", "", "car", "", "taxi", "ambulance", "", ""];
  // A hash of two ints: CV.hash2 (region.js) when it is there, else the same kind of mix here.
  const mix = (a, b) => {
    let h = Math.imul((a | 0) ^ 0x27d4eb2f, 0x165667b1) ^ Math.imul((b | 0) + 0x3c6ef372, 0x9e3779b1);
    h ^= h >>> 15; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
    return h >>> 0;
  };
  const hash2 = (a, b) => (typeof CV.hash2 === "function" ? CV.hash2(a, b) >>> 0 : mix(a, b));
  CV.CAR_COLORS = CV.CAR_COLORS || CAR_COLORS;
  CV.folkColor = i => SHEET_COLORS[hash2(i, 5) % 24];

  CV.makeCrowd = function (scene, M) {
    const R = CV.regionOf(scene);
    let n = 0, prev, cur, axis, kind, seen, face, o0, o1, fadeAt, lastTick = null, t0 = 0, dur = 417, list = [];
    let drawn = 0, inView = 0, sprites = 0, version = 0;
    const out = { prev: null, cur: null, axis: null, kind: null, seen: null };
    function alloc(N) {
      n = N;
      prev = new Float32Array(2 * N); cur = new Float32Array(2 * N); axis = new Uint8Array(N); kind = new Uint8Array(N);
      seen = new Uint8Array(N); face = new Int8Array(N); o0 = new Float32Array(2 * N); o1 = new Float32Array(2 * N); fadeAt = new Float64Array(N);
      for (let i = 0; i < N; i++) face[i] = hash2(i, 9) % 4;
      Object.assign(out, { prev, cur, axis, kind, seen });
      list = [];
    }
    alloc(0);
    // the street a walker keeps to the kerb of: 1 along x, 2 along y, 3 a junction, 0 none
    function pavement(x, y) {
      if (!R.isStreet(x, y)) return 0;
      const ew = R.isStreet(x - 1, y) || R.isStreet(x + 1, y), ns = R.isStreet(x, y - 1) || R.isStreet(x, y + 1);
      return ew && ns ? 3 : ns ? 2 : 1;
    }
    // the in-tile offset of person i at tile (x, y) heading d (0 e, 1 s, 2 w, 3 n)
    function offset(i, x, y, d, m, dst, at) {
      if (VEH[m]) { const o = [[0, LANE], [-LANE, 0], [0, -LANE], [LANE, 0]][d] || [0, 0]; dst[at] = o[0]; dst[at + 1] = o[1]; return; }
      const h = hash2(i, 7), side = h & 1 ? 1 : -1, al = (((h >>> 1) % 17) - 8) * 0.045, pv = pavement(x, y);
      if (pv === 1) { dst[at] = al; dst[at + 1] = side * KERB; }
      else if (pv === 2) { dst[at] = side * KERB; dst[at + 1] = al; }
      else if (pv === 3) { dst[at] = (h & 2 ? 1 : -1) * KERB; dst[at + 1] = side * KERB; }
      else { dst[at] = (((h >>> 6) % 9) - 4) * 0.05; dst[at + 1] = (((h >>> 11) % 9) - 4) * 0.05; }
    }
    // Is every inner tile of the L from (x0, y0) to (x1, y1) one this mover may use?
    function lClear(x0, y0, x1, y1, xFirst, ok) {
      const sx = Math.sign(x1 - x0), sy = Math.sign(y1 - y0);
      let x = x0, y = y0;
      for (const ax of xFirst ? "xy" : "yx") {
        if (ax === "x") { while (x !== x1) { x += sx; if ((x !== x1 || y !== y1) && !ok(x, y)) return false; } }
        else { while (y !== y1) { y += sy; if ((x !== x1 || y !== y1) && !ok(x, y)) return false; } }
      }
      return true;
    }
    const share = now => Math.min(1, Math.max(0, (now - t0) / dur));
    // where person i is shown at share u of the move (tile units, the tile's corner at 0): [x, y, sx, sy]
    const P = new Float64Array(4);
    function at(i, u) {
      const px = prev[2 * i], py = prev[2 * i + 1], cx = cur[2 * i], cy = cur[2 * i + 1];
      const dx = cx - px, dy = cy - py, ax = Math.abs(dx), ay = Math.abs(dy), tot = ax + ay;
      if (tot < 1e-6 || u >= 1) { P[0] = cx; P[1] = cy; P[2] = 0; P[3] = 0; return P; }
      const s = u * tot;
      if (axis[i] === 0) {
        if (s <= ax) { P[0] = px + Math.sign(dx) * s; P[1] = py; P[2] = Math.sign(dx); P[3] = 0; }
        else { P[0] = cx; P[1] = py + Math.sign(dy) * (s - ax); P[2] = 0; P[3] = Math.sign(dy); }
      } else {
        if (s <= ay) { P[0] = px; P[1] = py + Math.sign(dy) * s; P[2] = 0; P[3] = Math.sign(dy); }
        else { P[0] = px + Math.sign(dx) * (s - ay); P[1] = cy; P[2] = Math.sign(dx); P[3] = 0; }
      }
      return P;
    }
    const dirOf = (sx, sy) => sx > 0 ? 0 : sy > 0 ? 1 : sx < 0 ? 2 : sy < 0 ? 3 : -1;

    // A state frame: on a new tick every person's move starts from where they are shown now.
    function setState(st, now) {
      const c = st && st.crowd;
      if (!Array.isArray(c)) return;
      const N = Math.max(st.folk_n | 0, c.length ? c[c.length - 4] + 1 : 0);
      if (N > n) {
        const old = { n, prev, cur, axis, kind, seen, face, o0, o1, fadeAt };
        alloc(N);
        prev.set(old.prev); cur.set(old.cur); axis.set(old.axis); kind.set(old.kind); seen.set(old.seen); face.set(old.face); o0.set(old.o0); o1.set(old.o1); fadeAt.set(old.fadeAt);
      }
      const fresh = lastTick === null || st.tick !== lastTick;
      if (!fresh) return;
      const u = lastTick === null ? 1 : share(now);
      lastTick = st.tick;
      dur = Math.max(30, (M && M.tickMs) || 417);
      // shown positions now (with their offsets) become the start of the next move
      for (const i of list) if (seen[i] === 1) {
        const p = at(i, u);
        const ox = o0[2 * i] + (o1[2 * i] - o0[2 * i]) * u, oy = o0[2 * i + 1] + (o1[2 * i + 1] - o0[2 * i + 1]) * u;
        prev[2 * i] = p[0]; prev[2 * i + 1] = p[1]; o0[2 * i] = ox; o0[2 * i + 1] = oy;
        seen[i] = 3; // not yet in this frame
      }
      t0 = now;
      const next = [];
      for (let k = 0; k + 3 < c.length; k += 4) {
        const i = c[k], x = c[k + 1], y = c[k + 2], kk = c[k + 3] & 15, m = kk & 7;
        if (i < 0 || i >= n) continue;
        next.push(i);
        if (seen[i] !== 3) { // a newcomer (or one coming back as it faded): appears in place
          prev[2 * i] = x; prev[2 * i + 1] = y; cur[2 * i] = x; cur[2 * i + 1] = y; kind[i] = kk; seen[i] = 1;
          offset(i, x, y, face[i], m, o0, 2 * i); o1[2 * i] = o0[2 * i]; o1[2 * i + 1] = o0[2 * i + 1];
          continue;
        }
        seen[i] = 1;
        const vehNow = VEH[m], vehWas = VEH[kind[i] & 7];
        kind[i] = kk;
        let px = prev[2 * i], py = prev[2 * i + 1];
        const dx = x - px, dy = y - py;
        if (Math.abs(dx) + Math.abs(dy) > SNAP || vehNow !== vehWas) { // a jump (or into or out of a car): no glide
          prev[2 * i] = px = x; prev[2 * i + 1] = py = y;
          offset(i, x, y, face[i], m, o0, 2 * i);
        }
        cur[2 * i] = x; cur[2 * i + 1] = y;
        const rx = Math.round(px), ry = Math.round(py);
        if (rx !== x && ry !== y) {
          const ok = vehNow ? R.isRoadLike : R.isWalk;
          const xs = lClear(rx, ry, x, y, true, ok), ys = lClear(rx, ry, x, y, false, ok);
          if (xs !== ys) axis[i] = xs ? 0 : 1; // else the axis travelled last goes first (cars turn at corners)
        } else if (rx !== x) axis[i] = 0;
        else if (ry !== y) axis[i] = 1;
        // the heading of the last leg, for the lane or kerb at the end of the move (standing: as before)
        const lx = x - rx, ly = y - ry, lastY = axis[i] === 0 ? ly !== 0 : lx === 0;
        const d = lastY ? dirOf(0, Math.sign(ly)) : dirOf(Math.sign(lx), 0);
        if (d >= 0) face[i] = d;
        offset(i, x, y, face[i], m, o1, 2 * i);
      }
      // leavers fade where they were shown (over FADE ms, across ticks)
      for (const i of list) {
        if (seen[i] === 3) { seen[i] = 2; fadeAt[i] = now; cur[2 * i] = prev[2 * i]; cur[2 * i + 1] = prev[2 * i + 1]; o1[2 * i] = o0[2 * i]; o1[2 * i + 1] = o0[2 * i + 1]; next.push(i); }
        else if (seen[i] === 2 && now - fadeAt[i] < FADE) next.push(i);
      }
      next.sort((a, b) => a - b);
      list = [];
      for (let k = 0; k < next.length; k++) if (k === 0 || next[k] !== next[k - 1]) list.push(next[k]);
      // standing people sharing a tile stand in a ring
      const stand = new Map();
      for (const i of list) {
        if (seen[i] !== 1 || VEH[kind[i] & 7] || prev[2 * i] !== cur[2 * i] || prev[2 * i + 1] !== cur[2 * i + 1]) continue;
        const key = cur[2 * i + 1] * 65536 + cur[2 * i];
        if (!stand.has(key)) stand.set(key, []);
        stand.get(key).push(i);
      }
      for (const ids of stand.values()) if (ids.length >= 2) ids.forEach((i, k) => {
        const an = 2 * Math.PI * k / ids.length + (hash2(ids[0], 13) % 628) / 100;
        o1[2 * i] = Math.cos(an) * RING; o1[2 * i + 1] = Math.sin(an) * RING;
      });
      version++;
    }

    // Per frame: shown positions (tile units, centre of the tile at +0.5) of everyone in the list.
    let frameAt = -1, fx = new Float32Array(0), fy = new Float32Array(0), fs = new Int8Array(0), fa = new Float32Array(0);
    function positions(now) {
      if (frameAt === now && fx.length >= list.length) return;
      frameAt = now;
      if (fx.length < list.length) { const L = list.length + 64; fx = new Float32Array(L); fy = new Float32Array(L); fs = new Int8Array(L); fa = new Float32Array(L); }
      const u = share(now);
      for (let j = 0; j < list.length; j++) {
        const i = list[j], p = at(i, u);
        fx[j] = p[0] + 0.5 + o0[2 * i] + (o1[2 * i] - o0[2 * i]) * u;
        fy[j] = p[1] + 0.5 + o0[2 * i + 1] + (o1[2 * i + 1] - o0[2 * i + 1]) * u;
        const d = dirOf(p[2], p[3]);
        if (d >= 0 && u < 1) face[i] = d;
        fs[j] = d >= 0 && u < 1 ? 1 : 0;
        fa[j] = seen[i] === 2 ? Math.max(0, 1 - (now - fadeAt[i]) / FADE) : 1;
      }
    }
    const viewNow = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
    const sheetOf = (art, i) => {
      const v = hash2(i, 5) % 24, ch = (kind[i] >> 3) & 1;
      if (typeof art.folkSheet === "function") return art.folkSheet(v, !!ch);
      return art.person({ id: "folk" + v, age: ch ? 9 : 34 });
    };
    // world px box test against the view, with a margin
    function visible(v, wx, wy, m) { return wx >= v.x0 - m && wx <= v.x1 + m && wy >= v.y0 - m && wy <= v.y1 + m; }

    const K = {
      out, M,
      setState(st, now) { setState(st, now == null ? viewNow() : now); },
      n: () => n,
      count: () => { let c = 0; for (const i of list) if (seen[i] === 1) c++; return c; },
      // the shown tile position of person i now ([x, y], tile units), or null when not outdoors
      pos(i, now) {
        i = typeof i === "string" ? +i.slice(1) : i;
        if (!(i >= 0 && i < n) || seen[i] !== 1) return null;
        positions(now == null ? viewNow() : now);
        const j = bs(i);
        return j < 0 ? null : [fx[j], fy[j]];
      },
      has: id => { const i = typeof id === "string" ? +id.slice(1) : id; return i >= 0 && i < n && seen[i] === 1; },
      kindOf: i => kind[i],
      stats: () => ({ crowd: K.count(), crowdDrawn: drawn, crowdInView: inView, crowdSprites: sprites }),
      version: () => version,
      items(v, outItems) {
        const now = viewNow();
        positions(now);
        drawn = 0; inView = 0; sprites = 0;
        if (v.lod && v.lod !== "near") return;
        const proj = scene.proj, art = scene.art;
        const cand = [];
        for (let j = 0; j < list.length; j++) {
          const w = proj.toWorld(fx[j], fy[j]);
          if (!visible(v, w[0], w[1], 40)) continue;
          cand.push(j);
        }
        // more than the cap: the ones nearest the middle of the view get sprites, the rest marks
        let spr = cand;
        if (cand.length > CAP) {
          const mx = (v.x0 + v.x1) / 2, my = (v.y0 + v.y1) / 2;
          const d2 = j => { const w = proj.toWorld(fx[j], fy[j]); return (w[0] - mx) ** 2 + (w[1] - my) ** 2; };
          spr = cand.slice().sort((a, b) => d2(a) - d2(b)).slice(0, CAP);
        }
        const asSprite = new Set(spr);
        const marked = new Set();
        if (typeof scene.selected === "string" && /^f\d+$/.test(scene.selected)) marked.add(+scene.selected.slice(1));
        for (const id of (scene.highlight && scene.highlight.agents) || []) if (typeof id === "string" && /^f\d+$/.test(id)) marked.add(+id.slice(1));
        for (const j of cand) {
          const i = list[j], m = kind[i] & 7, w = proj.toWorld(fx[j], fy[j]), alpha = fa[j];
          const depth = proj.depth(fx[j], fy[j]) + (VEH[m] ? 0.02 : 0.01);
          if (w[0] >= v.x0 && w[0] <= v.x1 && w[1] >= v.y0 && w[1] <= v.y1 && seen[i] === 1) inView++;
          drawn++;
          if (!asSprite.has(j)) { // a mark among the sprites
            const col = VEH[m] ? CAR_COLORS[hash2(i, 3) % 10] : SHEET_COLORS[hash2(i, 5) % 24];
            outItems.push({ depth, wx: w[0] - 2, wy: w[1] - 3, wx1: w[0] + 2, wy1: w[1], draw(g, S2, ox, oy) {
              g.globalAlpha = alpha; g.fillStyle = col; g.fillRect(Math.round(w[0] * S2 + ox) - 1, Math.round(w[1] * S2 + oy) - 3, VEH[m] ? 4 : 2, 3); g.globalAlpha = 1;
            } });
            continue;
          }
          sprites++;
          if (marked.has(i)) { // the selected or highlighted person: a ring at their feet, under them
            const wx = w[0], wy = w[1];
            outItems.push({ depth: depth - 0.001, wx: wx - 14, wy: wy - 8, wx1: wx + 14, wy1: wy + 8, draw(g, S2, ox, oy) {
              g.save(); g.strokeStyle = "#ffe27a"; g.lineWidth = Math.max(1.5, 2 * S2); g.beginPath();
              g.ellipse(wx * S2 + ox, wy * S2 + oy, 12 * S2, 6 * S2, 0, 0, 2 * Math.PI); g.stroke(); g.restore();
            } });
          }
          if (VEH[m]) {
            const sp = art.car(CAR_COLORS[hash2(i, 3) % 10], VKIND[m], face[i] & 3);
            const wx = Math.round(w[0]) - sp.ax, wy = Math.round(w[1]) - sp.ay, img = sp.c;
            outItems.push({ depth, wx, wy, wx1: wx + img.width, wy1: wy + img.height, folk: i, draw(g, S2, ox, oy) {
              const dx0 = Math.round(wx * S2 + ox), dy0 = Math.round(wy * S2 + oy), dx1 = Math.round((wx + img.width) * S2 + ox), dy1 = Math.round((wy + img.height) * S2 + oy);
              if (alpha < 1) g.globalAlpha = alpha;
              if (dx1 > dx0 && dy1 > dy0) g.drawImage(img, 0, 0, img.width, img.height, dx0, dy0, dx1 - dx0, dy1 - dy0);
              g.globalAlpha = 1;
            } });
          } else {
            const sh = sheetOf(art, i), img = sh.c;
            const moving = fs[j] === 1, run = m === 1 || m === 3;
            const fr = moving ? Math.floor(now / (run ? 85 : 150) + (hash2(i, 9) % 4)) % 4 : 0;
            const row = proj.facing([1, 0, -1, 0][face[i] & 3], [0, 1, 0, -1][face[i] & 3]);
            const sx = fr * 16, sy = (row >= 0 ? row : 0) * 30, wx = Math.round(w[0]) - 8, wy = Math.round(w[1]) - 28;
            outItems.push({ depth, wx, wy, wx1: wx + 16, wy1: wy + 30, folk: i, draw(g, S2, ox, oy) {
              const dx0 = Math.round(wx * S2 + ox), dy0 = Math.round(wy * S2 + oy), dx1 = Math.round((wx + 16) * S2 + ox), dy1 = Math.round((wy + 30) * S2 + oy);
              if (alpha < 1) g.globalAlpha = alpha;
              if (dx1 > dx0 && dy1 > dy0) g.drawImage(img, sx, sy, 16, 30, dx0, dy0, dx1 - dx0, dy1 - dy0);
              g.globalAlpha = 1;
            } });
          }
        }
      },
      // mid: 2 x 3 px walkers and 4 x 3 px vehicles; far: 1 px dots (vehicles 2 px). Device px.
      marks(g, v, lod) {
        const now = viewNow();
        positions(now);
        drawn = 0; inView = 0; sprites = 0;
        if (lod !== "mid" && lod !== "far") return;
        const proj = scene.proj, S = v.S, k = Math.max(1, Math.round(scene.dpr || 1));
        for (let j = 0; j < list.length; j++) {
          const i = list[j], m = kind[i] & 7, w = proj.toWorld(fx[j], fy[j]);
          if (!visible(v, w[0], w[1], 4)) continue;
          if (seen[i] === 1 && w[0] >= v.x0 && w[0] <= v.x1 && w[1] >= v.y0 && w[1] <= v.y1) inView++;
          drawn++;
          const dx = Math.round(w[0] * S + v.ox), dy = Math.round(w[1] * S + v.oy), veh = VEH[m];
          g.globalAlpha = fa[j];
          g.fillStyle = veh ? CAR_COLORS[hash2(i, 3) % 10] : SHEET_COLORS[hash2(i, 5) % 24];
          if (lod === "mid") g.fillRect(dx - (veh ? 2 : 1) * k, dy - 3 * k, (veh ? 4 : 2) * k, 3 * k);
          else g.fillRect(dx, dy, (veh ? 2 : 1) * k, (veh ? 2 : 1) * k);
        }
        g.globalAlpha = 1;
      },
      // the person nearest (wx, wy) within r world px of their sprite (near) or dot
      pick(wx, wy, r) {
        if (!list.length) return null;
        positions(viewNow());
        const proj = scene.proj, zoom = (scene.cam && scene.cam.zoom) || 1;
        const lod = typeof scene.lod === "function" ? scene.lod() : scene.lod, near = lod ? lod === "near" : zoom >= 0.5;
        if (!near) r = Math.max(r, 10 / zoom); // a dot or a mark: within 10 CSS px
        let best = -1, bd = Infinity;
        for (let j = 0; j < list.length; j++) {
          const i = list[j];
          if (seen[i] !== 1) continue;
          const w = proj.toWorld(fx[j], fy[j]), veh = VEH[kind[i] & 7];
          // the sprite's box: a person stands 30 px tall over the foot point, a car is about 50 x 30
          const x0 = w[0] - (veh ? 26 : 6), x1 = w[0] + (veh ? 26 : 6), y0 = w[1] - (near ? (veh ? 24 : 27) : 6), y1 = w[1] + (veh ? 10 : 2);
          if (wx < x0 - r || wx > x1 + r || wy < y0 - r || wy > y1 + r) continue;
          const cy = near ? w[1] - (veh ? 8 : 13) : w[1], d = (wx - w[0]) ** 2 + (wy - cy) ** 2;
          if (d < bd) { bd = d; best = j; }
        }
        if (best < 0) return null;
        const i = list[best], hit = { kind: "agent", id: "f" + i, folk: true };
        Object.defineProperty(hit, "depth", { value: proj.depth(fx[best], fy[best]) + (VEH[kind[i] & 7] ? 0.02 : 0.01), enumerable: false });
        return hit;
      },
    };
    // binary search of person i in the (sorted) list
    function bs(i) { let lo = 0, hi = list.length - 1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (list[mid] === i) return mid; if (list[mid] < i) lo = mid + 1; else hi = mid - 1; } return -1; }
    if (typeof scene.addMovers === "function") K.remove = scene.addMovers(K);
    return K;
  };
})();

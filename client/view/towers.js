// CityView towers (v3): the tall styles drawn cheaply. Each visible wall is painted flat in (u, z), one texture
// pixel per world pixel along the wall, with fillRect windows, then mapped onto its face with one affine
// drawImage (iso south transform(1, 0.5, 0, 1, ...), iso east transform(1, -0.5, 0, 1, ...), flat transform(1, 0, 0,
// zk, ...)). Region office towers (with setbacks at 60% and 85% above 15 floors, a crown and a beacon), residential
// towers (brick, balconies, a name board), the hotel and the region's blocks of flats. Millbrook's own tower and
// flats keep v2's drawers in buildings.js. Classic script; registers drawers in art.styleDrawers.
"use strict";
(function () {
  const CV = window.CityView = window.CityView || {};
  const { shade, mix, rng } = CV.color;
  const poly = CV.poly;

  CV._artParts.push(function (art) {
    const { P, faceFn, quad, top, boxAt, proj } = art;
    const FACES = proj.faces, LIT = FACES[0], zk = proj.zk || 1;
    const B = art._bld;
    if (!B) return;
    const tex = (w, h) => { const c = CV.canvas(w, h); return { c, q: c.getContext("2d") }; };
    // Paint face F of a box from z0 up to z1 flat, then map it on. paint(q, W, Ht, toY, toX) draws in texture px:
    // x along the wall (left to right on screen), y down from z1; toY(z) and toX(u) convert from world z and u tiles.
    function faceTex(g, F, z0, z1, paint) {
      const a = F.at(0, z1), b = F.at(F.len, z1);
      const W = Math.max(1, Math.round(Math.abs(b[0] - a[0]))), Ht = Math.max(1, Math.ceil(z1 - z0));
      const t = tex(W, Ht);
      paint(t.q, W, Ht, z => z1 - z, u => u / F.len * W);
      g.save();
      g.imageSmoothingEnabled = false;
      g.transform((b[0] - a[0]) / W, (b[1] - a[1]) / W, 0, zk, Math.round(a[0]), Math.round(a[1]));
      g.drawImage(t.c, 0, 0);
      g.restore();
    }
    // world px per u along a face (iso 32, flat 48 for a south face), to size glow quads like the painted windows
    const ppu = F => Math.abs(F.at(F.len, 0)[0] - F.at(0, 0)[0]) / F.len || 32;
    const glowBays = (ctx, F, z0, z1, n) => { for (let i = 0; i < n; i++) ctx.windows.push(quad(F, (i + 0.15) * F.len / n, (i + 0.85) * F.len / n, z0, z1)); };

    // --- office tower ------------------------------------------------------------------------------------------
    const GLASS = [["#46597a", "#8ac0e6", "#b6dcf4", "#3a4c62"], ["#3a5a5a", "#7ec8c0", "#b0e4dc", "#2e4a4a"], ["#5a4e6a", "#a8a8d8", "#d0d0f0", "#463c56"],
      ["#2e3a4a", "#6a90b8", "#9cc0e0", "#24303e"], ["#6a6458", "#c8c0a8", "#e8e0c8", "#544e44"], ["#3e4e66", "#90b0d0", "#c0d8ec", "#303e52"],
      ["#4a5a4a", "#98c0a0", "#c8e4cc", "#3a483a"], ["#5a6a80", "#a0c4e0", "#d0e4f4", "#4a586a"]];
    function towerSegment(ctx, x0, y0, x1, y1, zA, zB, fh, pal, lobby) {
      const g = ctx.g;
      for (const f of FACES) {
        const F = faceFn(f, x0, y0, x1, y1), lit = f === LIT;
        const [spand, glass, hi, mull] = lit ? pal : pal.map(c => shade(c, 0.78));
        faceTex(g, F, zA, zB, (q, W, Ht, toY) => {
          q.fillStyle = spand; q.fillRect(0, 0, W, Ht);
          for (let z = zA; z + fh <= zB + 0.5; z += fh) {
            const lob = lobby && z === zA, ya = Math.round(toY(z + fh - 1)), yb = Math.round(toY(z + (lob ? 2 : 5)));
            q.fillStyle = lob ? shade(glass, 0.7) : glass; q.fillRect(3, ya, W - 6, yb - ya);
            if (!lob) { q.fillStyle = hi; q.fillRect(3, ya, W - 6, 2); }
            q.fillStyle = mull; for (let x = 3; x < W - 3; x += 8) q.fillRect(x, ya, 1, yb - ya);
          }
          const R = rng(ctx.h0 + f.charCodeAt(0) + zA); // reflections sweeping across the glass
          q.fillStyle = lit ? "rgba(255,255,255,0.13)" : "rgba(255,255,255,0.07)";
          for (let k = 0; k < 2; k++) { const x = Math.floor(R() * W * 0.7); for (let y = 0; y < Ht; y += 2) q.fillRect(x + Math.floor(y / 3), y, 6 + k * 4, 2); }
          q.fillStyle = lit ? "#c9d1dc" : "#9aa4b2"; q.fillRect(0, 0, 3, Ht); q.fillRect(W - 3, 0, 3, Ht); q.fillRect(0, 0, W, 2);
        });
        const n = Math.max(1, Math.round(F.len * 2));
        for (let z = zA + (lobby ? fh : 0); z + fh <= zB + 0.5; z += fh * 2) glowBays(ctx, F, z + 5, z + fh - 1, n);
        if (lobby && f === ctx.p.face) {
          const uc = B.entryU(ctx, F);
          B.door(ctx, F, uc, 0.5, 15, { color: "#2a3a4c", frame: "#c9d1dc", glazed: true });
          const r = F.rect(uc - 0.5, uc + 0.5, 0, 0.35);
          boxAt(g, r[0], r[1], r[2], r[3], 16, 19, "#c9d1dc");
        }
      }
      // the roof deck of the segment with a light coping
      poly(g, top(x0, y0, x1, y1, zB), shade(pal[0], 1.25));
      poly(g, top(x0 + 0.08, y0 + 0.08, x1 - 0.08, y1 - 0.08, zB), "#5a6070");
    }
    art.styleDrawers.tower = function (ctx) {
      const { x0, y0, x1, y1, H } = ctx, fh = ctx.st.floorPx, floors = ctx.floors, g = ctx.g;
      const pal = GLASS[(ctx.variant == null ? ctx.h0 : ctx.variant) % GLASS.length];
      const fz = fl => fl * fh;
      let segs = [[0, floors, 0]];
      if (floors > 15) { const f1 = Math.round(floors * 0.6), f2 = Math.round(floors * 0.85); segs = [[0, f1, 0], [f1, f2, 0.4], [f2, floors, 0.8]]; }
      const w = x1 - x0, h = y1 - y0;
      segs.forEach(([fa, fb, inset], k) => {
        const i = Math.min(inset, w / 2 - 0.6, h / 2 - 0.6);
        towerSegment(ctx, x0 + i, y0 + i, x1 - i, y1 - i, fz(fa), k === segs.length - 1 ? H : fz(fb), fh, pal, k === 0);
      });
      const last = segs[segs.length - 1][2], i = Math.min(last, w / 2 - 0.6, h / 2 - 0.6);
      const cx0 = x0 + i + 0.5, cy0 = y0 + i + 0.5, cx1 = x1 - i - 0.5, cy1 = y1 - i - 0.5;
      // crown: a plant room with louvres, then the mast and its beacon
      boxAt(g, cx0, cy0, cx1, cy1, H, H + 12, shade(pal[0], 1.1), shade(pal[0], 0.9));
      for (const f of FACES) { const F = faceFn(f, cx0, cy0, cx1, cy1); for (let u = 0.1; u < F.len - 0.1; u += 0.2) poly(g, quad(F, u, u + 0.1, H + 3, H + 9), f === LIT ? shade(pal[0], 0.8) : shade(pal[0], 0.65)); }
      if (floors > 15) poly(g, top(cx0 - 0.1, cy0 - 0.1, cx1 + 0.1, cy1 + 0.1, H + 12), "#c9d1dc");
      const m = P((cx0 + cx1) / 2, (cy0 + cy1) / 2, H + 12);
      g.fillStyle = "#c9d1dc"; g.fillRect(Math.round(m[0]), Math.round(m[1]) - 30, 2, 30);
      g.fillStyle = "#e23b3b"; g.fillRect(Math.round(m[0]), Math.round(m[1]) - 32, 2, 2);
      ctx.beacon = [m[0] + 1, m[1] - 31];
    };

    // --- brick blocks: residential towers and the region's flats ------------------------------------------------
    // Brick with mortar courses, framed windows in pairs, balconies on the door side, a lit stairwell, a name board
    // above the canopy, and a flat roof with a lift house and a water tank.
    function brickBlock(ctx, opts) {
      const g = ctx.g, { x0, y0, x1, y1, H, stage } = ctx, fh = ctx.st.floorPx, floors = ctx.floors;
      const R = rng(ctx.h0 + 3);
      for (const f of FACES) {
        const F = faceFn(f, x0, y0, x1, y1), lit = f === LIT, isDoor = f === ctx.p.face, wall = lit ? ctx.wall : shade(ctx.wall, 0.8);
        const n = Math.max(2, Math.round(F.len * 1.6));
        faceTex(g, F, 0, ctx.Hw, (q, W, Ht, toY, toX) => {
          q.fillStyle = wall; q.fillRect(0, 0, W, Ht);
          q.fillStyle = shade(wall, 0.9); for (let y = 2; y < Ht; y += 3) q.fillRect(0, y, W, 1);
          q.fillStyle = shade(wall, 1.06); for (let k = 0; k < W * Ht / 60; k++) q.fillRect(Math.floor(R() * W), 3 * Math.floor(R() * Ht / 3), 3, 2);
          q.fillStyle = lit ? "#cfc8bb" : "#a8a296";
          for (let fl = 1; fl < floors; fl++) q.fillRect(0, Math.round(toY(fl * fh + 2)), W, 2); // floor bands
          q.fillRect(0, 0, W, Math.round(toY(H)) + 1);
          q.fillStyle = "#7a7468"; q.fillRect(0, Math.round(toY(4)), W, Ht - Math.round(toY(4)));
          if (stage >= 2) { q.fillStyle = "rgba(22,18,16,0.3)"; for (let k = 0; k < 4 + stage * 2; k++) q.fillRect(Math.floor(R() * W), 0, 2, Math.floor(R() * Ht * 0.6)); }
          const glass = lit ? "#8cbfe4" : "#6b9cc6", frame = lit ? "#e8e2d6" : "#c0bab0";
          for (let fl = 0; fl < floors; fl++) for (let i = 0; i < n; i++) {
            const xc = Math.round(toX((i + 0.5) * F.len / n));
            if (isDoor && fl === 0 && Math.abs(xc - W / 2) < 18) continue;
            const ya = Math.round(toY(fl * fh + fh - 3)), yb = Math.round(toY(fl * fh + 6));
            q.fillStyle = frame; q.fillRect(xc - 5, ya - 1, 11, yb - ya + 2);
            q.fillStyle = (fl * 7 + i * 3 + ctx.h0) % 11 === 0 ? (lit ? "#3a5068" : "#30445a") : glass; q.fillRect(xc - 4, ya, 9, yb - ya);
            q.fillStyle = mix(glass, "#ffffff", 0.35); q.fillRect(xc - 4, ya, 9, 2);
            q.fillStyle = frame; q.fillRect(xc, ya, 1, yb - ya);
            if (isDoor && opts.balconies && fl >= 1 && i % 2 === 0) { // a balcony slab and its rail
              q.fillStyle = "#bdb6a8"; q.fillRect(xc - 8, yb + 1, 17, 2);
              q.fillStyle = "#3e4450"; q.fillRect(xc - 8, yb - 4, 17, 1); for (let x = xc - 8; x <= xc + 8; x += 3) q.fillRect(x, yb - 4, 1, 5);
            }
          }
        });
        { // one glow quad a painted window
          const k = ppu(F), half = 4.5 / k;
          for (let fl = 0; fl < floors; fl++) for (let i = 0; i < n; i++) {
            const u = (i + 0.5) * F.len / n;
            if (isDoor && fl === 0 && Math.abs(u - F.len / 2) * k < 18) continue;
            ctx.windows.push(quad(F, u - half, u + half, fl * fh + 6, fl * fh + fh - 3));
          }
        }
        if (isDoor) {
          const mid = F.len / 2;
          B.door(ctx, F, mid, 0.34, 19, { color: "#3a4a5a", frame: "#cfc8bb", glazed: true, step: true, boarded: stage >= 3 });
          const r = F.rect(mid - 0.3, mid + 0.3, 0, 0.28);
          boxAt(g, r[0], r[1], r[2], r[3], 21, 23, stage >= 2 ? "#4e525c" : "#5a6070");
          if (ctx.signText) B.wallSign(ctx, F, ctx.signText, mid, opts.signZ || 33, stage >= 3 ? "#c8bc98" : "#f6e7b8", "#2a2f3a", 2);
          ctx.porch = F.out(mid, 20, 0.2);
        }
      }
      B.flatRoof(ctx, ctx.roofC);
      const Hd = ctx.H;
      boxAt(g, x1 - 1.3, y0 + 0.4, x1 - 0.6, y0 + 1.1, Hd, Hd + 12, "#a8a090");
      const tx = x0 + 0.5, ty = y0 + 0.45;
      boxAt(g, tx, ty, tx + 0.46, ty + 0.46, Hd + 8, Hd + 22, "#8a6440", "#6a4a30");
      for (const [dx, dy] of [[0, 0.42], [0.42, 0.42]]) boxAt(g, tx + dx, ty + dy, tx + dx + 0.04, ty + dy + 0.04, Hd, Hd + 8, "#4a3a2a");
      B.acUnit(ctx, x1 - 0.6, y1 - 0.65, Hd);
    }
    art.styleDrawers.residential_tower = ctx => brickBlock(ctx, { balconies: true, signZ: 33 });
    art.styleDrawers.apartments = ctx => brickBlock(ctx, { balconies: true, signZ: 33 });

    // --- the hotel: a cream slab with banded windows, a canopy, the HOTEL board on the roof edge ------------------
    art.styleDrawers.hotel = function (ctx) {
      const g = ctx.g, { x0, y0, x1, y1, H } = ctx, fh = ctx.st.floorPx, floors = ctx.floors;
      for (const f of FACES) {
        const F = faceFn(f, x0, y0, x1, y1), lit = f === LIT, wall = lit ? ctx.wall : shade(ctx.wall, 0.8);
        const n = Math.max(2, Math.round(F.len * 2));
        faceTex(g, F, 0, ctx.Hw, (q, W, Ht, toY, toX) => {
          q.fillStyle = wall; q.fillRect(0, 0, W, Ht);
          q.fillStyle = shade(wall, 0.86); q.fillRect(0, Math.round(toY(fh)), W, Ht - Math.round(toY(fh)));
          for (let fl = 1; fl < floors; fl++) {
            const ya = Math.round(toY(fl * fh + fh - 4)), yb = Math.round(toY(fl * fh + 5));
            for (let i = 0; i < n; i++) { const xc = Math.round(toX((i + 0.5) * F.len / n)); q.fillStyle = lit ? "#5d8fc0" : "#4a78a6"; q.fillRect(xc - 5, ya, 10, yb - ya); q.fillStyle = (i + fl) % 4 ? "#e8c38a" : "#d8d0c0"; q.fillRect(xc - 5, ya, 3, yb - ya); }
          }
          q.fillStyle = shade(wall, 1.1); q.fillRect(0, 0, W, 3); q.fillRect(0, 0, 3, Ht); q.fillRect(W - 3, 0, 3, Ht);
        });
        { const k = ppu(F), half = 5 / k; for (let fl = 1; fl < floors; fl++) for (let i = 0; i < n; i++) { const u = (i + 0.5) * F.len / n; ctx.windows.push(quad(F, u - half, u + half, fl * fh + 5, fl * fh + fh - 4)); } }
        if (f === ctx.p.face) {
          const uc = B.entryU(ctx, F);
          B.door(ctx, F, uc, 0.5, 16, { color: "#2a3a4c", frame: "#c9a14a", glazed: true });
          const r = F.rect(uc - 0.8, uc + 0.8, 0, 0.6);
          boxAt(g, r[0], r[1], r[2], r[3], 18, 21, "#5a1a2a", "#7a2a3a");
          B.wallSign(ctx, F, ctx.st.sign, F.len / 2, H - 10, "#ffe8a8", ctx.st.signBg, 2, { border: "#c9a14a" });
        }
      }
      B.flatRoof(ctx, ctx.roofC);
      boxAt(g, x0 + 1, y0 + 1, x1 - 1, y1 - 1.5, ctx.H, ctx.H + 10, "#a8a090");
      B.acUnit(ctx, x1 - 0.8, y1 - 0.8, ctx.H);
    };
  });
})();

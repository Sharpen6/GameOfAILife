// CityView buildings: one cached sprite per place, drawn through the projection with two shaded wall
// faces, windows, doors, roofs and roof extras, shop awnings and wall signs, and for homes the tier look
// (flat block, painted house, big house with hedge and pool) and the five neglect stages (paint, windows,
// roof, chimney, grime, vines, graffiti). Window quads are kept for the night glow. Classic script.
"use strict";
(function () {
  const CV = window.CityView = window.CityView || {};
  const { shade, mix, hash, rng } = CV.color;
  const poly = CV.poly;

  const HOUSE_PAINT = ["#f2dfbd", "#cfe0ea", "#efcab2", "#d6e6c6", "#f3e6a8", "#ecd0dc", "#e4ddcf", "#c3d7ec", "#f4d39c", "#cfe4d8"];
  const HOUSE_ROOF = ["#b5533c", "#7a4a3a", "#56627a", "#8a5a2c", "#4f6b4a", "#a8463a", "#6a5a72"];
  const SHUTTER = ["#3f6b4a", "#34588a", "#7a3a32", "#3e4248", "#5f8796"];
  const DOOR = ["#a83a32", "#2f5a8a", "#3f6b4a", "#6b4226", "#2a2d34", "#c08a2a"];
  const VILLA_PAINT = ["#f7f0e3", "#efe5d6", "#f3dcc4", "#e2eaee", "#f0ead0"];
  const VILLA_ROOF = ["#a9573a", "#4e5a6a", "#8c4a32", "#5a6a5a"];
  const CURTAIN = ["#d65a5a", "#e8c34a", "#6aa0d8", "#f2f2f2", "#8ac46a", "#c47ad8"];
  // Neglect: how far paint and roof fade toward grey, and how much darker, per stage 0..4.
  const FADE = [0, 0.2, 0.45, 0.62, 0.8], DIM = [1, 0.96, 0.88, 0.8, 0.7];
  const GREY = "#9a968c";

  const STYLE = {
    house: { floorPx: 26, roof: "gable", roofPx: 30 },
    big_house: { floorPx: 24, roof: "hip", roofPx: 30 },
    apartments: { floorPx: 22, roof: "flat", wall: ["#a8573f", "#9a6347", "#b06a4a"], roofC: "#6d6f78" },
    tower: { floorPx: 20, roof: "flat", wall: "#46597a", roofC: "#4a5466" },
    hospital: { floorPx: 22, roof: "flat", wall: "#eef1f5", roofC: "#a9b0bd" },
    school: { floorPx: 26, roof: "hip", roofPx: 20, wall: "#b8643e", roofC: "#56607a" },
    city_hall: { floorPx: 24, roof: "flat", wall: "#e8e1cf", roofC: "#8d8f99" },
    bank: { floorPx: 22, roof: "flat", wall: "#ddd6c4", roofC: "#7d808a" },
    cafe: { floorPx: 24, roof: "flat", wall: "#f3e3d4", roofC: "#8a6a9a", awning: ["#8a4fa0", "#f6eef8"], sign: "CAFE", signBg: "#4a2058" },
    diner: { floorPx: 26, roof: "flat", wall: "#dfe6ea", roofC: "#c23b3b", awning: ["#c23b3b", "#ffffff"], sign: "DINER", signBg: "#1e2230" },
    market: { floorPx: 30, roof: "flat", wall: "#eaf0e2", roofC: "#6a8a72", awning: ["#2f8c5a", "#ffffff"], sign: "MARKET", signBg: "#1f6a42" },
    bakery: { floorPx: 26, roof: "gable", roofPx: 22, wall: "#f2dcae", roofC: "#8a5a2c", awning: ["#d18f2f", "#fff4dd"], sign: "BAKERY", signBg: "#6a3a14" },
    corner_shop: { floorPx: 26, roof: "flat", wall: "#c98a5a", roofC: "#6d6f78", awning: ["#2f7fb8", "#ffffff"], sign: "GROCER", signBg: "#163e66" },
    noodle_bar: { floorPx: 24, roof: "flat", wall: "#ecdcbc", roofC: "#7a2e2e", awning: ["#c0392b", "#f1c40f"], sign: "NOODLES", signBg: "#7a1414" },
    arcade: { floorPx: 24, roof: "glass", wall: "#ddcfb2", roofC: "#8d8f99", sign: "ARCADE", signBg: "#24304a" },
    factory: { floorPx: 30, roof: "saw", wall: "#98a2a8", roofC: "#7a8086" },
  };
  CV.STYLE = STYLE;
  CV.FLOORS = { house: 1, big_house: 2, apartments: 3, tower: 4, hospital: 3, school: 2, city_hall: 3, bank: 3, cafe: 2,
    diner: 1, market: 1, bakery: 1, corner_shop: 1, noodle_bar: 2, arcade: 2, factory: 2, park: 0 };

  // House bodies stand inside their footprint with a garden ring around them; other buildings keep a
  // thin paved apron.
  CV.inset = p => p.kind === "park" ? 0 : p.style === "house" ? 0.35 : p.style === "big_house" ? 0.32 : p.style === "apartments" ? 0.12 : 0.1;
  // The walled body of a place, plus the big house's pool strip and the factory's silo yard.
  CV.bodyOf = function (p) {
    const n = CV.inset(p);
    const b = { x0: p.x + n, y0: p.y + n, x1: p.x + p.w - n, y1: p.y + p.h - n, pool: null, silos: null };
    if (p.style === "big_house" && p.w >= 4) {
      if (p.face === "e") { b.pool = [b.x0 + 0.05, b.y0 + 0.2, b.x0 + 0.95, b.y0 + Math.min(2, b.y1 - b.y0 - 0.3)]; b.x0 += 1.15; }
      else { b.pool = [b.x1 - 0.95, b.y0 + 0.25, b.x1 - 0.05, b.y0 + Math.min(2.1, b.y1 - b.y0 - 0.3)]; b.x1 -= 1.15; }
    }
    if (p.style === "factory" && p.w >= 8) { b.silos = [b.x1 - 1.7, b.y0 + 0.3, b.x1 - 0.1, b.y1 - 0.3]; b.x1 -= 2.0; }
    return b;
  };

  CV._artParts.push(function (art) {
    const { P, faceFn, quad, top, boxAt, proj } = art;
    const FACES = proj.faces, LIT = FACES[0];
    const zk = proj.zk || 1;

    // --- windows, doors, signs, awnings ---------------------------------------------------------------
    // One window: frame, glass with a sky reflection, optional curtain, shutters, flower box, mullions,
    // and the neglect states (dirty, cracked, boarded). Lit-able glass goes into ctx.windows.
    function win(ctx, F, u0, u1, z0, z1, o) {
      const g = ctx.g, litFace = F.face === LIT;
      o = o || {};
      const fw = o.fw == null ? 0.025 : o.fw;
      if (o.shutters && !o.boarded && o.state < 4) {
        const sc = o.shutters, sw = Math.min(0.08, (u1 - u0) * 0.32);
        const drop = o.state === 3 ? 3 : 0;
        const ghost = q2 => poly(g, q2, mix(o.wallCol || "#ffffff", "#ffffff", litFace ? 0.4 : 0.2)); // unfaded paint where a shutter hung
        if (o.noShutter === "l") ghost(quad(F, u0 - fw - sw, u0 - fw, z0, z1));
        else {
          poly(g, quad(F, u0 - fw - sw, u0 - fw, z0, z1), litFace ? sc : shade(sc, 0.8));
          poly(g, quad(F, u0 - fw - sw, u0 - fw - sw + 0.012, z0, z1), shade(sc, 0.7));
        }
        if (o.noShutter === "r") ghost(quad(F, u1 + fw, u1 + fw + sw, z0, z1));
        else if (!(o.state === 3 && o.idx % 2)) poly(g, [F.at(u1 + fw, z0 - drop), F.at(u1 + fw + sw, z0 - drop), F.at(u1 + fw + sw, z1 - drop), F.at(u1 + fw, z1)], litFace ? sc : shade(sc, 0.8));
      }
      if (o.frame) poly(g, quad(F, u0 - fw, u1 + fw, z0 - 1, z1 + 1), litFace ? o.frame : shade(o.frame, 0.85));
      const q = quad(F, u0, u1, z0, z1);
      if (o.boarded) {
        poly(g, q, "#8a6a42");
        for (let z = z0 + 2; z < z1; z += 3) poly(g, quad(F, u0, u1, z, z + 1), "#5e4428");
        poly(g, [F.at(u0, z0 + 1), F.at(u0 + 0.04, z0), F.at(u1, z1 - 1), F.at(u1 - 0.04, z1)], "#a07a4a");
        return;
      }
      let glass;
      if (o.vacant) glass = litFace ? "#2a3644" : "#222c38";
      else if (o.dark) glass = litFace ? "#3a5068" : "#30445a";
      else glass = litFace ? "#8cbfe4" : "#6b9cc6";
      if (!o.vacant && o.state >= 1) glass = mix(glass, "#7a7a6a", [0, 0.12, 0.3, 0.45, 0.55][o.state] + (o.dirty ? 0.25 : 0));
      poly(g, q, glass);
      if (!o.vacant) poly(g, quad(F, u0, u1, z1 - Math.max(2, Math.round((z1 - z0) * 0.22)), z1), mix(glass, "#ffffff", 0.35));
      if (o.curtain && !o.vacant && o.state <= 2) {
        const cw = (u1 - u0) * 0.3;
        poly(g, quad(F, u0, u0 + cw, z0, z1 - 1), litFace ? o.curtain : shade(o.curtain, 0.8));
        if (o.both) poly(g, quad(F, u1 - cw, u1, z0, z1 - 1), litFace ? o.curtain : shade(o.curtain, 0.8));
      }
      if (o.mullion) {
        const mc = o.frame || "#ffffff";
        const um = (u0 + u1) / 2;
        poly(g, quad(F, um - 0.01, um + 0.01, z0, z1), litFace ? mc : shade(mc, 0.85));
        if (z1 - z0 > 8) poly(g, quad(F, u0, u1, (z0 + z1) / 2 - 0.5, (z0 + z1) / 2 + 0.5), litFace ? mc : shade(mc, 0.85));
      }
      if (!o.vacant && (o.state || 0) <= 1 && litFace) poly(g, quad(F, u1 - 0.07, u1 - 0.045, z1 - 6, z1 - 2), "#ffffff");
      if (o.cracked) { const um = u0 + (u1 - u0) * 0.4; poly(g, [F.at(um, z1), F.at(um + 0.02, z1), F.at(um + 0.06, (z0 + z1) / 2), F.at(um + 0.04, (z0 + z1) / 2)], "#f0f0f0"); poly(g, [F.at(um + 0.04, (z0 + z1) / 2), F.at(um + 0.06, (z0 + z1) / 2), F.at(um + 0.01, z0), F.at(um - 0.01, z0)], "#e0e0e0"); }
      if (o.sill) poly(g, quad(F, u0 - fw - 0.01, u1 + fw + 0.01, z0 - 2, z0 - 1), litFace ? o.sill : shade(o.sill, 0.85));
      if (o.box && o.state === 0) {
        poly(g, quad(F, u0, u1, z0 - 4, z0 - 1), litFace ? "#8a5a32" : "#6e4826");
        const R = rng(o.idx * 7 + 3);
        for (let i = 0; i < 4; i++) { const p = F.at(u0 + (u1 - u0) * (0.1 + R() * 0.8), z0 - 2); g.fillStyle = ["#f05a7a", "#f6e05a", "#ffffff", "#e8603c"][(i + o.idx) % 4]; g.fillRect(Math.round(p[0]), Math.round(p[1]) - 2, 1, 1); g.fillStyle = "#3f8f3a"; g.fillRect(Math.round(p[0]) + 1, Math.round(p[1]) - 1, 1, 1); }
      }
      if (o.glow !== false && !o.vacant) ctx.windows.push(q);
    }
    function door(ctx, F, uc, w, h, o) {
      const g = ctx.g, litFace = F.face === LIT, k = litFace ? 1 : 0.82;
      o = o || {};
      const u0 = uc - w / 2, u1 = uc + w / 2;
      if (o.frame) poly(g, quad(F, u0 - 0.03, u1 + 0.03, 0, h + 2), shade(o.frame, k));
      poly(g, quad(F, u0, u1, 0, h), shade(o.color || "#6b4226", k));
      if (o.glazed) {
        poly(g, quad(F, u0 + 0.025, u1 - 0.025, 2, h - 2), shade("#7fb0d8", k));
        poly(g, quad(F, uc - 0.012, uc + 0.012, 0, h), shade(o.color || "#3a4a5a", k));
        poly(g, quad(F, u0 + 0.025, u1 - 0.025, h - 5, h - 2), shade("#b8dcf2", k));
        ctx.windows.push(quad(F, u0 + 0.025, u1 - 0.025, 2, h - 2));
      } else {
        poly(g, quad(F, u0 + 0.03, u1 - 0.03, h - 6, h - 3), shade(mix(o.color || "#6b4226", "#000000", 0.25), k));
        poly(g, quad(F, u1 - 0.06, u1 - 0.045, h * 0.45, h * 0.45 + 2), "#e3b54a");
      }
      if (o.boarded) { poly(g, quad(F, u0 - 0.03, u1 + 0.03, 5, 8), "#a8743a"); poly(g, quad(F, u0 - 0.03, u1 + 0.03, h - 8, h - 5), "#a8743a"); poly(g, [F.at(u0, 2), F.at(u0 + 0.05, 2), F.at(u1, h - 2), F.at(u1 - 0.05, h - 2)], "#b8844a"); }
      if (o.step) { const r = F.rect(u0 - 0.06, u1 + 0.06, 0, 0.1); boxAt(g, r[0], r[1], r[2], r[3], 0, 2, "#c8c2b4"); }
    }
    // Pixel-font sign sheared onto a wall, centred on (uc, z).
    function wallSign(ctx, F, text, uc, z, fg, bg, scale) {
      const s = scale || 1;
      const tw = CV.textWidth(text) * s, w = tw + 6 * s, h = 9 * s;
      const c = CV.canvas(w, h), sg = c.getContext("2d");
      if (bg) { sg.fillStyle = shade(bg, 0.7); sg.fillRect(0, 0, w, h); sg.fillStyle = bg; sg.fillRect(1, 1, w - 2, h - 2); }
      CV.pixelText(sg, text, 3 * s, 2 * s, fg, s);
      const a = F.at(uc, z), b = F.at(uc + 1, z);
      const slope = Math.abs(b[0] - a[0]) < 1e-6 ? 0 : (b[1] - a[1]) / (b[0] - a[0]);
      const g = ctx.g;
      g.save(); g.imageSmoothingEnabled = false;
      g.transform(1, slope, 0, 1, Math.round(a[0]), Math.round(a[1]));
      g.drawImage(c, Math.round(-w / 2), Math.round(-h / 2));
      g.restore();
      return { w, h };
    }
    // Striped canopy sloping out from the wall over [u0, u1] at height z.
    function awning(ctx, F, u0, u1, z, cols, depth, drop) {
      const g = ctx.g, litFace = F.face === LIT, k = litFace ? 1 : 0.84;
      depth = depth || 0.22; drop = drop || 7;
      poly(g, quad(F, u0, u1, z - drop - 5, z - drop), "rgba(0,0,0,0.16)");
      const n = Math.max(2, Math.round((u1 - u0) / 0.12));
      for (let i = 0; i < n; i++) {
        const a = u0 + (u1 - u0) * i / n, b = u0 + (u1 - u0) * (i + 1) / n;
        poly(g, [F.at(a, z), F.at(b, z), F.out(b, z - drop, depth), F.out(a, z - drop, depth)], shade(cols[i % 2], k));
        poly(g, [F.out(a, z - drop, depth), F.out(b, z - drop, depth), F.out(b, z - drop - 3, depth), F.out(a, z - drop - 3, depth)], shade(cols[i % 2], k * 0.86));
      }
      poly(g, [F.at(u0, z), F.at(u1, z), F.at(u1, z + 1), F.at(u0, z + 1)], shade(cols[0], 0.6));
    }
    // Flat pilaster on a wall.
    function pilaster(ctx, F, u, w, z0, z1, col) {
      const litFace = F.face === LIT;
      poly(ctx.g, quad(F, u, u + w, z0, z1), litFace ? col : shade(col, 0.82));
      poly(ctx.g, quad(F, u + w - 0.015, u + w, z0, z1), shade(col, litFace ? 0.82 : 0.68));
    }
    // A free-standing column in front of a wall (porticos).
    function column(ctx, F, u, d, z0, z1, col) {
      const r = F.rect(u - 0.045, u + 0.045, d - 0.09, d);
      boxAt(ctx.g, r[0], r[1], r[2], r[3], z0, z1, col);
    }
    // Grime streaks, peeling paint, vines and a graffiti tag on a home's wall, by stage.
    // phase "under" (rain streaks, peeling paint) goes on the bare wall before windows and doors; phase
    // "over" (vines, graffiti) goes on top of them.
    function grime(ctx, F, H, stage, seed, col, phase) {
      const g = ctx.g;
      const R = rng(seed);
      if (phase !== "over") for (let i = 0; i < stage * 3; i++) {
        const u = 0.08 + R() * (F.len - 0.16), z1 = H - 2 - R() * 6;
        poly(g, quad(F, u, u + 0.025, z1 - 6 - R() * 10, z1), shade(col, 0.8));
      }
      if (stage >= 2 && phase !== "over") for (let i = 0; i < stage * 2 + (F.face === LIT ? 2 : 0); i++) { // peeling paint
        const u = 0.08 + R() * (F.len - 0.35), z = 3 + R() * (H - 10), w = 0.12 + R() * 0.14, h = 3 + R() * 3;
        poly(g, quad(F, u, u + w, z, z + h), mix(col, "#ffffff", F.face === LIT ? 0.6 : 0.35));
        poly(g, quad(F, u, u + w, z - 1, z), shade(col, 0.7));
        poly(g, quad(F, u + w, u + w + 0.02, z - 1, z + h), shade(col, 0.82));
      }
      if (phase === "under") return;
      const R2 = rng(seed + 991);
      if (stage >= 3) for (const u0 of [0, F.len - 0.16]) for (let i = 0; i < (stage === 4 ? 16 : 8); i++) {
        const u = u0 + R2() * 0.16, z = R2() * H * (stage === 4 ? 0.95 : 0.6);
        poly(g, quad(F, u, u + 0.035, z, z + 3), ["#3e6e2a", "#2f5a22", "#56802e", "#6a9a3a"][i % 4]);
      }
      if (stage === 4 && F.face === LIT) {
        const u = F.len * 0.25 + R2() * F.len * 0.25;
        poly(g, quad(F, u, u + 0.38, 4, 7), "#d63ad0"); poly(g, quad(F, u + 0.06, u + 0.26, 7, 10), "#3ad6d0");
        poly(g, quad(F, u + 0.3, u + 0.34, 3, 11), "#f2e23a");
      }
    }

    // --- roofs -------------------------------------------------------------------------------------------
    // Pitched roof (gable or hip) over the body. Faces turned away first, then gable walls, then the
    // slopes facing the camera; shingle rows, ridge cap, neglect (missing shingles, holes, gutter).
    function pitched(ctx, kind, R, opts) {
      opts = opts || {};
      const g = ctx.g, { x0, y0, x1, y1 } = ctx;
      const H = ctx.Hw, o = opts.o == null ? 0.13 : opts.o;
      const snow = CV.SEASON[ctx.season] && CV.SEASON[ctx.season].snow;
      const roofC = ctx.roofC;
      const lit = snow ? "#f4f8fa" : roofC, dark = snow ? "#d2dce2" : shade(roofC, 0.76), back = snow ? "#c4ced6" : shade(roofC, 0.58);
      const alongX = opts.alongX != null ? opts.alongX : (x1 - x0) >= (y1 - y0);
      const ym = (y0 + y1) / 2, xm = (x0 + x1) / 2;
      const r = kind === "hip" ? Math.min(x1 - x0, y1 - y0) / 2 : 0;
      const faces = [];
      const F = (pts, n, gable) => faces.push({ pts, n, gable });
      if (alongX) {
        F([[x0 - o, y1 + o, H], [x1 + o, y1 + o, H], [x1 + o - r, ym, H + R], [x0 - o + r, ym, H + R]], "s");
        F([[x0 - o, y0 - o, H], [x1 + o, y0 - o, H], [x1 + o - r, ym, H + R], [x0 - o + r, ym, H + R]], "n");
        if (r) { F([[x1 + o, y0 - o, H], [x1 + o, y1 + o, H], [x1 + o - r, ym, H + R]], "e"); F([[x0 - o, y0 - o, H], [x0 - o, y1 + o, H], [x0 - o + r, ym, H + R]], "w"); }
        else { F([[x1, y0, H], [x1, y1, H], [x1, ym, H + R]], "e", true); F([[x0, y0, H], [x0, y1, H], [x0, ym, H + R]], "w", true); }
      } else {
        F([[x1 + o, y0 - o, H], [x1 + o, y1 + o, H], [xm, y1 + o - r, H + R], [xm, y0 - o + r, H + R]], "e");
        F([[x0 - o, y0 - o, H], [x0 - o, y1 + o, H], [xm, y1 + o - r, H + R], [xm, y0 - o + r, H + R]], "w");
        if (r) { F([[x0 - o, y1 + o, H], [x1 + o, y1 + o, H], [xm, y1 + o - r, H + R]], "s"); F([[x0 - o, y0 - o, H], [x1 + o, y0 - o, H], [xm, y0 - o + r, H + R]], "n"); }
        else { F([[x0, y1, H], [x1, y1, H], [xm, y1, H + R]], "s", true); F([[x0, y0, H], [x1, y0, H], [xm, y0, H + R]], "n", true); }
      }
      const facing = f => FACES.includes(f.n);
      // far gable walls, then far slopes, then near gable walls, then near slopes
      const rank = f => (facing(f) ? 2 : 0) + (f.gable ? 0 : 1);
      faces.sort((a, b) => rank(a) - rank(b));
      const wallLit = ctx.wall, wallDark = shade(ctx.wall, 0.8);
      for (const f of faces) {
        const front = f.n === LIT;
        const col = f.gable ? (front ? wallLit : wallDark) : !facing(f) ? back : front ? lit : dark;
        poly(g, f.pts.map(q => P(q[0], q[1], q[2])), col);
        if (f.gable && facing(f)) { // attic vent on the gable wall
          const c = f.pts[2], a = f.pts[0], b = f.pts[1];
          const cx = (a[0] + b[0] + c[0]) / 3, cy = (a[1] + b[1] + c[1]) / 3, cz = H + R * 0.32;
          const along = f.n === "e" || f.n === "w";
          const p0 = along ? [cx, cy - 0.12] : [cx - 0.12, cy], p1 = along ? [cx, cy + 0.12] : [cx + 0.12, cy];
          poly(g, [P(p0[0], p0[1], cz - 4), P(p1[0], p1[1], cz - 4), P(p1[0], p1[1], cz + 4), P(p0[0], p0[1], cz + 4)], ctx.stage >= 3 ? "#2a2420" : shade(ctx.trim, front ? 1 : 0.82));
          poly(g, [P(p0[0], p0[1], cz - 3), P(p1[0], p1[1], cz - 3), P(p1[0], p1[1], cz + 3), P(p0[0], p0[1], cz + 3)], "#3a4250");
        }
        if (!f.gable && facing(f) && !snow) shingles(ctx, f, R, front ? lit : dark);
        if (!f.gable && facing(f) && snow && ctx.isHome && ctx.stage >= 2) snowSlide(ctx, f, front ? roofC : shade(roofC, 0.76));
      }
      // ridge cap
      if (alongX) poly(g, [P(x0 - o + r, ym - 0.03, H + R + 1), P(x1 + o - r, ym - 0.03, H + R + 1), P(x1 + o - r, ym + 0.03, H + R - 1), P(x0 - o + r, ym + 0.03, H + R - 1)], snow ? "#ffffff" : shade(lit, 0.82));
      else poly(g, [P(xm - 0.03, y0 - o + r, H + R + 1), P(xm - 0.03, y1 + o - r, H + R + 1), P(xm + 0.03, y1 + o - r, H + R - 1), P(xm + 0.03, y0 - o + r, H + R - 1)], snow ? "#ffffff" : shade(dark, 0.82));
      // eave line (fascia) under each slope facing the camera
      for (const f of faces) {
        if (f.gable || !facing(f)) continue;
        const a = f.pts[0], b = f.pts[1];
        poly(g, [P(a[0], a[1], H), P(b[0], b[1], H), P(b[0], b[1], H - 2), P(a[0], a[1], H - 2)], shade(ctx.trim || "#ffffff", f.n === LIT ? 0.95 : 0.8));
      }
      // neglect on the main slope facing the camera (the lit one if it is a slope, else the other)
      const main = faces.find(f => !f.gable && f.n === LIT) || faces.find(f => !f.gable && facing(f) && f.pts.length === 4);
      if (ctx.isHome && ctx.stage >= 2 && main) roofDamage(ctx, main, R, main.n === LIT ? roofC : shade(roofC, 0.76), snow);
      return { alongX, ym, xm, r, o, H, R };
    }
    // A point on a roof slope: s runs along the eave (0..1), t up to the ridge (0..1); dz lifts it in px.
    function slopeAt(f, s0, t, dz) {
      const [a, b] = f.pts, c = f.pts[2], d = f.pts[3] || f.pts[2];
      const ex = a[0] + (b[0] - a[0]) * s0, ey = a[1] + (b[1] - a[1]) * s0, ez = a[2] + (b[2] - a[2]) * s0;
      const rx = d[0] + (c[0] - d[0]) * s0, ry = d[1] + (c[1] - d[1]) * s0, rz = d[2] + (c[2] - d[2]) * s0;
      return P(ex + (rx - ex) * t, ey + (ry - ey) * t, ez + (rz - ez) * t + (dz || 0));
    }
    const slopeLen = f => Math.hypot(f.pts[1][0] - f.pts[0][0], f.pts[1][1] - f.pts[0][1]);
    // Rows of shingles on a slope (and staggered joints).
    function shingles(ctx, f, R, col) {
      const g = ctx.g;
      const rows = Math.max(4, Math.round(R / 5));
      const line = shade(col, 0.86), hi = shade(col, 1.07);
      const len = slopeLen(f), ds = 0.02 / Math.max(0.2, len), step = 0.24 / Math.max(0.2, len);
      if (ctx.isHome && ctx.stage >= 1) { // sun-bleached, weathered courses
        const Rw = rng(ctx.h0 + f.n.charCodeAt(0) * 5);
        const pick = new Set([1 + Math.floor(Rw() * (rows - 2)), 1 + Math.floor(Rw() * (rows - 2)), ctx.stage >= 2 ? Math.floor(Rw() * rows) : -1]);
        for (const k of pick) if (k >= 0) poly(g, [slopeAt(f, 0, k / rows), slopeAt(f, 1, k / rows), slopeAt(f, 1, (k + 1) / rows), slopeAt(f, 0, (k + 1) / rows)], mix(col, "#e6dccb", 0.3));
      }
      for (let k = 1; k < rows; k++) {
        const t = k / rows, tp = (k - 1) / rows;
        poly(g, [slopeAt(f, 0, t), slopeAt(f, 1, t), slopeAt(f, 1, t, 1.1), slopeAt(f, 0, t, 1.1)], line);
        if (f.pts.length !== 4) continue;
        const off = (k % 2) * step / 2;
        for (let s0 = step / 4 + off; s0 < 1 - step / 4; s0 += step) poly(g, [slopeAt(f, s0, t, 1), slopeAt(f, s0 + ds, t, 1), slopeAt(f, s0 + ds, tp, 1), slopeAt(f, s0, tp, 1)], hi);
      }
    }
    // Missing shingles from stage 2, dark holes from stage 3, big holes and a hanging gutter at 4.
    function roofDamage(ctx, f, R, lit, snow) {
      const g = ctx.g, stage = ctx.stage;
      const Rn = rng(ctx.h0 + 17);
      const len = Math.max(0.5, slopeLen(f));
      const on = (s0, t, w, d) => [slopeAt(f, s0, t), slopeAt(f, s0 + w, t), slopeAt(f, s0 + w, t + d), slopeAt(f, s0, t + d)];
      const n = stage === 2 ? 5 : stage === 3 ? 7 : 10;
      for (let i = 0; i < n; i++) {
        const t = 0.12 + Rn() * 0.62, s0 = 0.06 + Rn() * 0.8;
        const hole = stage >= 3 && i % 3 === 0, big = stage === 4 && i % 3 === 0;
        const w = (big ? 0.5 : hole ? 0.3 : 0.27) / len, d = big ? 0.2 : hole ? 0.13 : 0.17;
        if (!hole && !big) { // shingles gone: dark felt with a pale batten showing
          if (snow) continue;
          poly(g, on(s0, t, w, d), "#3e322a");
          poly(g, on(s0, t + d * 0.45, w, d * 0.16), "#b08a5a");
          poly(g, on(s0, t + d - 0.02, w, 0.02), shade(lit, 1.12));
          continue;
        }
        poly(g, on(s0, t, w, d), "#231d1a");
        poly(g, on(s0 + w * 0.45, t, w * 0.1, d), "#5a4030");
        if (snow) poly(g, on(s0, t + d, w, 0.03), "#ffffff");
      }
      if (stage >= 3) { // hanging gutter
        const a = 0.05, b = Math.min(0.45, 1.0 / len);
        poly(g, [slopeAt(f, a, 0, -1), slopeAt(f, b, 0, -1), slopeAt(f, b, 0, -2), slopeAt(f, a, 0, -2)], "#5a5048");
        poly(g, [slopeAt(f, b, 0, -1), slopeAt(f, b + 0.08, 0, -9), slopeAt(f, b + 0.09, 0, -8), slopeAt(f, b + 0.01, 0, 0)], "#5a5048");
      }
    }
    // Snow on a neglected roof: it slides off in bare patches that grow with the stage (the roof colour shows
    // with a course line or two); at stage 4 the cover is thin and patchy.
    function snowSlide(ctx, f, bare) {
      const g = ctx.g, stage = ctx.stage, Rn = rng(ctx.h0 + f.n.charCodeAt(0) * 13);
      const len = Math.max(0.5, slopeLen(f));
      const on = (s0, t, w, d) => [slopeAt(f, s0, t), slopeAt(f, s0 + w, t), slopeAt(f, s0 + w, t + d), slopeAt(f, s0, t + d)];
      if (stage >= 4) {
        poly(g, f.pts.map(q => P(q[0], q[1], q[2])), bare);
        for (let k = 1; k < 6; k++) poly(g, [slopeAt(f, 0, k / 6), slopeAt(f, 1, k / 6), slopeAt(f, 1, k / 6, 1), slopeAt(f, 0, k / 6, 1)], shade(bare, 0.86));
        for (let i = 0; i < 8; i++) { const s0 = Rn() * 0.8, t = Rn() * 0.8; poly(g, on(s0, t, (0.2 + Rn() * 0.3) / len, 0.08 + Rn() * 0.12), i % 3 ? "#e8eef2" : "#ccd6dc"); }
        return;
      }
      const n = stage === 2 ? 3 : 5;
      for (let i = 0; i < n; i++) {
        const s0 = 0.04 + Rn() * 0.7, t = 0.05 + Rn() * 0.55;
        const w = (0.3 + Rn() * (stage === 3 ? 0.5 : 0.25)) / len, d = 0.16 + Rn() * (stage === 3 ? 0.22 : 0.1);
        poly(g, on(s0, t, w, d), bare);
        poly(g, on(s0, t + d * 0.5, w, 0.025), shade(bare, 0.82));
        poly(g, on(s0, t + d, w, 0.03), "#ffffff"); // the snow's broken edge
      }
    }
    // Flat roof with a parapet: the deck, the inner faces of the far parapets, then the coping.
    function flatRoof(ctx, deck, opts) {
      opts = opts || {};
      const g = ctx.g, { x0, y0, x1, y1 } = ctx;
      const H = ctx.H, Hw = ctx.Hw, i = opts.i || 0.08;
      const snow = CV.SEASON[ctx.season] && CV.SEASON[ctx.season].snow;
      const deckC = snow ? "#eef3f6" : deck;
      poly(g, top(x0 + i, y0 + i, x1 - i, y1 - i, H), deckC);
      if (!snow) { // membrane seams and gravel
        const Rr = rng(ctx.h0 + 5);
        for (let k = 1; k < (x1 - x0) / 0.7; k++) { const x = x0 + i + k * 0.7; if (x < x1 - i) poly(g, [P(x, y0 + i, H), P(x + 0.02, y0 + i, H), P(x + 0.02, y1 - i, H), P(x, y1 - i, H)], shade(deckC, 0.92)); }
        for (let k = 0; k < (x1 - x0) * (y1 - y0) * 3; k++) { const p = P(x0 + i + Rr() * (x1 - x0 - 2 * i), y0 + i + Rr() * (y1 - y0 - 2 * i), H); g.fillStyle = Rr() < 0.5 ? shade(deckC, 0.88) : shade(deckC, 1.08); g.fillRect(Math.round(p[0]), Math.round(p[1]), 1, 1); }
      }
      const inner = shade(ctx.wall, 0.7);
      const far = { n: [[x0 + i, y0 + i], [x1 - i, y0 + i]], w: [[x0 + i, y1 - i], [x0 + i, y0 + i]], s: [[x1 - i, y1 - i], [x0 + i, y1 - i]], e: [[x1 - i, y0 + i], [x1 - i, y1 - i]] };
      for (const f of ["n", "e", "s", "w"]) {
        if (FACES.includes(f)) continue; // a near parapet's inner face looks away from the camera
        const [a, b] = far[f];
        poly(g, [P(a[0], a[1], H), P(b[0], b[1], H), P(b[0], b[1], Hw), P(a[0], a[1], Hw)], inner);
      }
      const cope = snow ? "#ffffff" : opts.cope || shade(ctx.wall, 1.12);
      poly(g, top(x0, y0, x1, y0 + i, Hw), cope); poly(g, top(x0, y0, x0 + i, y1, Hw), cope);
      poly(g, top(x0, y1 - i, x1, y1, Hw), cope); poly(g, top(x1 - i, y0, x1, y1, Hw), cope);
    }
    // Rooftop air-conditioning box with a fan grille.
    function acUnit(ctx, x, y, z) {
      boxAt(ctx.g, x, y, x + 0.32, y + 0.24, z, z + 7, "#b9bec6");
      const p = P(x + 0.16, y + 0.12, z + 7);
      ctx.g.fillStyle = "#6a7078"; ctx.g.fillRect(Math.round(p[0]) - 3, Math.round(p[1]) - 1, 6, 2);
    }
    function chimney(ctx, x, y, z0, z1, col) {
      const g = ctx.g, broken = ctx.isHome && ctx.stage >= 4;
      boxAt(g, x, y, x + 0.26, y + 0.26, z0, broken ? z1 - 5 : z1, col);
      if (!broken) { boxAt(g, x - 0.03, y - 0.03, x + 0.29, y + 0.29, z1, z1 + 2, shade(col, 0.8)); const p = P(x + 0.13, y + 0.13, z1 + 2); g.fillStyle = "#1e1a18"; g.fillRect(Math.round(p[0]) - 2, Math.round(p[1]) - 1, 4, 2); }
      else { const p = P(x + 0.2, y + 0.05, z1 - 5); g.fillStyle = shade(col, 0.6); g.fillRect(Math.round(p[0]), Math.round(p[1]) - 2, 3, 2); }
    }

    // --- per-style facades ------------------------------------------------------------------------------
    const windowState = (ctx, i, face, n) => {
      const st = ctx.isHome ? ctx.stage : 0, s = hash(ctx.p.id + ":" + face + ":" + i);
      return {
        state: st,
        boarded: ctx.isHome && (st === 4 ? s % 4 !== 3 : st === 3 && s % 5 === 0),
        cracked: ctx.isHome && st >= 3 && (s >>> 4) % 3 === 1,
        dirty: ctx.isHome && st === 2 && i === (ctx.h0 + face.charCodeAt(0)) % Math.max(1, n),
      };
    };
    // A dirty band under the eave where the gutter overflows, with drips down the wall (from stage 1).
    function gutterStreak(ctx, F, H, col) {
      const g = ctx.g, R = rng(ctx.h0 + F.face.charCodeAt(0) * 3), st = ctx.stage;
      poly(g, quad(F, 0, F.len, H - 8, H - 4), shade(col, 0.76));
      // the overflowing corner: a broad stain that tapers down the wall
      const u0 = R() < 0.5 ? 0.1 : F.len - 0.22, L = 12 + st * 4;
      poly(g, quad(F, u0, u0 + 0.12, H - 8 - L * 0.45, H - 8), shade(col, 0.7));
      poly(g, quad(F, u0 + 0.02, u0 + 0.09, H - 8 - L * 0.8, H - 8 - L * 0.45), shade(col, 0.74));
      poly(g, quad(F, u0 + 0.04, u0 + 0.06, H - 8 - L, H - 8 - L * 0.8), shade(col, 0.8));
      for (let i = 0; i < 3 + st * 2; i++) {
        const u = 0.05 + R() * (F.len - 0.1), l = 4 + R() * (6 + st * 3);
        poly(g, quad(F, u, u + 0.035, H - 8 - l, H - 8), shade(col, 0.74));
      }
    }

    function drawHouse(ctx) {
      const g = ctx.g, { x0, y0, x1, y1, stage, H } = ctx;
      for (const f of FACES) {
        const F = faceFn(f, x0, y0, x1, y1), col = f === LIT ? ctx.wall : shade(ctx.wall, 0.8);
        poly(g, quad(F, 0, F.len, 0, ctx.Hw), col);
        for (let z = 3; z < H - 2; z += 3) poly(g, quad(F, 0, F.len, z, z + 1), shade(col, 0.93)); // siding
        poly(g, quad(F, 0, F.len, 0, 3), shade(col, 0.66));
        poly(g, quad(F, 0, 0.05, 0, H), f === LIT ? ctx.trim : shade(ctx.trim, 0.82));
        poly(g, quad(F, F.len - 0.05, F.len, 0, H), f === LIT ? ctx.trim : shade(ctx.trim, 0.82));
        if (stage >= 1) { grime(ctx, F, H, stage, ctx.h0 + f.charCodeAt(0), col, "under"); gutterStreak(ctx, F, H, col); }
        const isDoor = f === ctx.p.face;
        const us = isDoor ? [F.len * 0.2, F.len * 0.8] : [F.len * 0.27, F.len * 0.73];
        us.forEach((uc, i) => {
          const ws = windowState(ctx, i, f, us.length);
          const lost = stage >= 1 && stage <= 2 && f === LIT && i === 1 ? "r" : stage === 2 && f !== LIT && i === 0 ? "l" : null;
          win(ctx, F, uc - 0.14, uc + 0.14, 8, 19, Object.assign(ws, { frame: ctx.trim, curtain: CURTAIN[(ctx.h0 + i) % CURTAIN.length], both: true, shutters: SHUTTER[(ctx.h0 >>> 5) % SHUTTER.length], box: f === LIT, idx: i, sill: ctx.trim, mullion: true, noShutter: lost, wallCol: col }));
        });
        if (isDoor) {
          const uc = F.len / 2;
          door(ctx, F, uc, 0.22, 18, { color: stage >= 3 ? "#6a5238" : DOOR[(ctx.h0 >>> 3) % DOOR.length], frame: ctx.trim, boarded: stage >= 4, step: true });
          // little porch roof over the door, and the porch light
          poly(g, [F.at(uc - 0.2, 22), F.at(uc + 0.2, 22), F.out(uc + 0.2, 19, 0.16), F.out(uc - 0.2, 19, 0.16)], shade(ctx.roofC, f === LIT ? 1 : 0.8));
          poly(g, [F.out(uc - 0.2, 19, 0.16), F.out(uc + 0.2, 19, 0.16), F.out(uc + 0.2, 18, 0.16), F.out(uc - 0.2, 18, 0.16)], shade(ctx.trim, 0.85));
          const lp = F.at(uc + 0.2, 14);
          g.fillStyle = "#2a2a2a"; g.fillRect(Math.round(lp[0]), Math.round(lp[1]) - 1, 2, 3);
          g.fillStyle = stage >= 3 ? "#555" : "#fff1b8"; g.fillRect(Math.round(lp[0]), Math.round(lp[1]), 2, 1);
          if (stage < 3) ctx.porch = F.at(uc + 0.2, 14);
        }
        if (stage >= 3) grime(ctx, F, H, stage, ctx.h0 + f.charCodeAt(0), col, "over");
        poly(g, quad(F, 0, F.len, H - 3, H), "rgba(0,0,0,0.18)"); // eave shadow
      }
      const roof = pitched(ctx, "gable", ctx.st.roofPx);
      const cx = roof.alongX ? x1 - 0.7 : (x0 + x1) / 2 - 0.4, cy = roof.alongX ? (y0 + y1) / 2 - 0.42 : y0 + 0.5;
      chimney(ctx, cx, cy, ctx.Hw + 8, ctx.Hw + ctx.st.roofPx + 6, stage >= 3 ? "#7a6a5a" : "#9a4a38");
    }

    function drawBigHouse(ctx) {
      const g = ctx.g, { x0, y0, x1, y1, stage, H } = ctx;
      const fh = ctx.st.floorPx;
      for (const f of FACES) {
        const F = faceFn(f, x0, y0, x1, y1), col = f === LIT ? ctx.wall : shade(ctx.wall, 0.8);
        poly(g, quad(F, 0, F.len, 0, ctx.Hw), col);
        poly(g, quad(F, 0, F.len, 0, 4), shade(col, 0.7));
        poly(g, quad(F, 0, F.len, fh + 1, fh + 3), shade(col, 1.06)); // string course
        poly(g, quad(F, 0, F.len, fh + 3, fh + 4), shade(col, 0.88));
        poly(g, quad(F, 0, 0.07, 0, H), shade(col, 1.06)); poly(g, quad(F, F.len - 0.07, F.len, 0, H), shade(col, 0.92)); // quoins
        if (stage >= 1) { grime(ctx, F, H, stage, ctx.h0 + f.charCodeAt(0), col, "under"); gutterStreak(ctx, F, H, col); }
        const isDoor = f === ctx.p.face;
        const doorU = isDoor ? Math.min(F.len - 0.4, Math.max(0.4, entryU(ctx, F))) : -9;
        const garageU = isDoor ? (doorU > F.len / 2 ? 0.75 : F.len - 0.75) : -9;
        const n = Math.max(2, Math.round(F.len * 1.15));
        for (let fl = 0; fl < 2; fl++) for (let i = 0; i < n; i++) {
          const uc = (i + 0.5) * F.len / n;
          if (fl === 0 && (Math.abs(uc - doorU) < 0.38 || Math.abs(uc - garageU) < 0.6)) continue;
          const ws = windowState(ctx, i + fl * n, f, n * 2);
          win(ctx, F, uc - 0.13, uc + 0.13, fl * fh + 7, fl * fh + 20, Object.assign(ws, { frame: "#ffffff", curtain: CURTAIN[(ctx.h0 + i + fl) % CURTAIN.length], mullion: true, sill: "#f2f2f2", idx: i + fl * n }));
          if (stage <= 2) poly(g, quad(F, uc - 0.16, uc + 0.16, fl * fh + 21, fl * fh + 23), f === LIT ? "#ffffff" : "#d8d8d8"); // lintel
        }
        if (isDoor) {
          door(ctx, F, doorU, 0.26, 19, { color: stage >= 3 ? "#5a4a38" : "#4a2a1a", frame: "#ffffff", boarded: stage >= 4, step: true });
          // garage door with panels
          const gu0 = garageU - 0.42, gu1 = garageU + 0.42;
          poly(g, quad(F, gu0 - 0.03, gu1 + 0.03, 0, 19), "#ffffff");
          poly(g, quad(F, gu0, gu1, 0, 17), stage >= 3 ? "#8a8478" : "#d9d4c8");
          for (let z = 3; z < 17; z += 4) poly(g, quad(F, gu0, gu1, z, z + 1), stage >= 3 ? "#6a665e" : "#b4afa2");
          if (stage >= 4) poly(g, [F.at(gu0, 4), F.at(gu0 + 0.1, 4), F.at(gu1, 15), F.at(gu1 - 0.1, 15)], "#5a4a3a");
          // portico: two columns and a little pediment
          const colC = stage >= 3 ? "#cfc8b8" : "#ffffff";
          column(ctx, F, doorU - 0.24, 0.3, 0, fh + 2, colC);
          column(ctx, F, doorU + 0.24, 0.3, 0, fh + 2, colC);
          const r = F.rect(doorU - 0.32, doorU + 0.32, 0, 0.32);
          boxAt(g, r[0], r[1], r[2], r[3], fh + 2, fh + 5, colC);
          poly(g, [F.out(doorU - 0.32, fh + 5, 0.32), F.out(doorU + 0.32, fh + 5, 0.32), F.out(doorU, fh + 13, 0.32)], f === LIT ? colC : shade(colC, 0.85));
          poly(g, [F.out(doorU - 0.2, fh + 6, 0.32), F.out(doorU + 0.2, fh + 6, 0.32), F.out(doorU, fh + 11, 0.32)], f === LIT ? shade(ctx.roofC, 1.1) : shade(ctx.roofC, 0.9));
          if (stage < 3) ctx.porch = F.out(doorU, fh, 0.2);
        }
        if (stage >= 3) grime(ctx, F, H, stage, ctx.h0 + f.charCodeAt(0), col, "over");
        poly(g, quad(F, 0, F.len, H - 3, H), "rgba(0,0,0,0.16)");
      }
      const roof = pitched(ctx, "hip", ctx.st.roofPx, { alongX: true });
      // dormers on the slope facing the camera
      if (roof.alongX && FACES.includes("s")) {
        const ym = roof.ym, o = roof.o, R = ctx.st.roofPx, Hh = ctx.Hw;
        const D = y1 + o - ym;
        const zAt = y => Hh + R * (y1 + o - y) / D;
        const span = x1 - x0 - 2 * roof.r;
        const xs = span > 1.2 ? [x0 + roof.r + span * 0.25, x0 + roof.r + span * 0.75] : [(x0 + x1) / 2];
        for (const xc of xs) {
          const yf = y1 + o - D * 0.32, yb = yf - 0.36, w = 0.2;
          const zf = zAt(yf), zt = zf + 11;
          poly(g, [P(xc - w, yf, zf), P(xc + w, yf, zf), P(xc + w, yf, zt), P(xc - w, yf, zt)], ctx.wall);
          poly(g, [P(xc + w, yf, zf), P(xc + w, yb, zAt(yb)), P(xc + w, yb, zt), P(xc + w, yf, zt)], shade(ctx.wall, 0.8));
          const Fd = faceFn("s", xc - w, yb, xc + w, yf);
          const ws = windowState(ctx, 9, "s", 1);
          win(ctx, Fd, 0.09, 0.31, zf + 2, zt - 2, Object.assign(ws, { frame: "#ffffff", idx: 3, curtain: CURTAIN[ctx.h0 % 6] }));
          poly(g, [P(xc - w - 0.05, yf + 0.04, zt), P(xc + w + 0.05, yf + 0.04, zt), P(xc + w + 0.05, yb, zt + 8), P(xc - w - 0.05, yb, zt + 8)], ctx.roofC);
          poly(g, [P(xc + w + 0.05, yf + 0.04, zt), P(xc + w + 0.05, yb, zt + 8), P(xc + w + 0.05, yb, zt)], shade(ctx.roofC, 0.7));
        }
      }
      chimney(ctx, x0 + 0.45, (y0 + y1) / 2 - 0.3, ctx.Hw + 12, ctx.Hw + ctx.st.roofPx + 8, stage >= 3 ? "#8a7a6a" : "#b8a48a");
    }
    // Door position along a face: the entry tile's centre.
    function entryU(ctx, F) {
      const [ex, ey] = ctx.p.entry || [0, 0];
      if (F.face === "s") return ex + 0.5 - ctx.x0;
      if (F.face === "n") return ctx.x1 - (ex + 0.5);
      if (F.face === "e") return ctx.y1 - (ey + 0.5);
      return ey + 0.5 - ctx.y0;
    }

    function drawApartments(ctx) {
      const g = ctx.g, { x0, y0, x1, y1, stage, H } = ctx;
      const fh = ctx.st.floorPx, floors = ctx.floors;
      const units = (ctx.look.units || []);
      const unitOf = (fl, side) => units[fl * 2 + side] || null;
      for (const f of FACES) {
        const F = faceFn(f, x0, y0, x1, y1), col = f === LIT ? ctx.wall : shade(ctx.wall, 0.8);
        poly(g, quad(F, 0, F.len, 0, ctx.Hw), col);
        const R = rng(ctx.h0 + f.charCodeAt(0));
        for (let z = 2; z < H; z += 3) poly(g, quad(F, 0, F.len, z, z + 1), shade(col, 0.88)); // mortar courses
        for (let k = 0; k < F.len * 40; k++) { const u = R() * F.len, z = 3 * Math.floor(R() * (H / 3)) + 0; poly(g, quad(F, u, u + 0.06, z, z + 2), shade(col, R() < 0.5 ? 0.92 : 1.06)); }
        poly(g, quad(F, 0, F.len, 0, 4), "#7a7468");
        for (let fl = 1; fl < floors; fl++) poly(g, quad(F, 0, F.len, fl * fh, fl * fh + 2), f === LIT ? "#cfc8bb" : "#a8a296"); // floor bands
        poly(g, quad(F, 0, F.len, H, ctx.Hw), f === LIT ? "#cfc8bb" : "#a8a296");
        if (stage >= 1) grime(ctx, F, H, Math.min(stage, 3), ctx.h0 + f.charCodeAt(0), col, "under");
        if (stage >= 3) { // soot and rain streaks running down from the parapet
          const Rs = rng(ctx.h0 + f.charCodeAt(0) * 7);
          for (let i = 0; i < (stage >= 4 ? 12 : 5); i++) {
            const u = 0.05 + Rs() * (F.len - 0.12), w = 0.04 + Rs() * 0.05, l = 8 + Rs() * (stage >= 4 ? H * 0.75 : 16);
            poly(g, quad(F, u, u + w, H - l, H), "rgba(22,18,16,0.42)");
            poly(g, quad(F, u + w * 0.3, u + w * 0.7, H - l - 5, H - l), "rgba(22,18,16,0.28)");
          }
        }
        const isDoor = f === ctx.p.face;
        const mid = F.len / 2;
        const per = f === "s" || f === "n" ? 2 : 2;
        for (let fl = 0; fl < floors; fl++) {
          const slots = [];
          if (isDoor) { for (let k = 0; k < per; k++) { slots.push([F.len * (0.1 + k * 0.17), 0]); slots.push([F.len * (0.9 - k * 0.17), 1]); } }
          else { slots.push([F.len * 0.22, f === "e" ? 1 : 0]); slots.push([F.len * 0.5, f === "e" ? 1 : 0]); slots.push([F.len * 0.78, f === "e" ? 1 : 0]); }
          slots.forEach(([uc, side], i) => {
            const u = unitOf(fl, side);
            const vacant = u ? u.vacant : false;
            const ws = windowState(ctx, i + fl * 5, f, 6);
            const z0 = fl * fh + 7, z1 = z0 + 11;
            poly(g, quad(F, uc - 0.17, uc + 0.17, z1 + 1, z1 + 3), f === LIT ? "#cfc8bb" : "#a8a296"); // lintel
            win(ctx, F, uc - 0.14, uc + 0.14, z0, z1, Object.assign(ws, { frame: "#e8e2d6", vacant, curtain: CURTAIN[(hash(ctx.p.id + fl + side)) % CURTAIN.length], sill: "#cfc8bb", mullion: true, idx: i + fl * 5 }));
            if (isDoor && fl >= 1 && i % 2 === 0) { // balcony under the outer window pair
              const r = F.rect(uc - 0.24, uc + 0.24, 0, 0.2);
              const hb = hash(ctx.p.id + ":bal:" + fl + ":" + i);
              boxAt(g, r[0], r[1], r[2], r[3], fl * fh + 2, fl * fh + 4, stage >= 4 ? "#a8a090" : "#bdb6a8");
              const rail = stage >= 3 ? "#5a4a3a" : "#3e4450";
              const gone = stage >= 4 && hb % 3 === 0; // rail torn off
              const sag = stage >= 4 && !gone ? 3 : 0;
              if (!gone) {
                poly(g, [F.out(uc - 0.24, fl * fh + 10, 0.2), F.out(uc, fl * fh + 10 - sag, 0.2), F.out(uc, fl * fh + 11 - sag, 0.2), F.out(uc - 0.24, fl * fh + 11, 0.2)], rail);
                poly(g, [F.out(uc, fl * fh + 10 - sag, 0.2), F.out(uc + 0.24, fl * fh + 10, 0.2), F.out(uc + 0.24, fl * fh + 11, 0.2), F.out(uc, fl * fh + 11 - sag, 0.2)], rail);
                for (let k = 0; k <= 6; k++) {
                  if (stage >= 4 && (hb >>> k) % 3 === 0) continue; // broken balusters
                  const p = F.out(uc - 0.24 + k * 0.08, fl * fh + 4, 0.2); g.fillStyle = rail; g.fillRect(Math.round(p[0]), Math.round(p[1]) - 6 + (k > 1 && k < 5 ? Math.min(sag, 2) : 0), 1, 6 - (k > 1 && k < 5 ? Math.min(sag, 2) : 0));
                }
              } else { const p = F.out(uc + 0.2, fl * fh + 4, 0.2); g.fillStyle = rail; g.fillRect(Math.round(p[0]), Math.round(p[1]) - 6, 1, 6); }
              if (u && !u.vacant && stage <= 3 && hb % 2 === 0) { // a potted plant, dead by stage 3
                const p = F.out(uc + 0.14, fl * fh + 4, 0.1), dead = stage >= 3;
                g.fillStyle = "#8a4a2a"; g.fillRect(Math.round(p[0]) - 1, Math.round(p[1]) - 3, 3, 3);
                if (dead) { g.fillStyle = "#7a6638"; g.fillRect(Math.round(p[0]) - 2, Math.round(p[1]) - 5, 1, 2); g.fillRect(Math.round(p[0]), Math.round(p[1]) - 6, 1, 3); g.fillRect(Math.round(p[0]) + 2, Math.round(p[1]) - 5, 1, 2); g.fillStyle = "#9a8448"; g.fillRect(Math.round(p[0]) - 1, Math.round(p[1]) - 4, 1, 1); }
                else { g.fillStyle = "#3f9a3a"; g.fillRect(Math.round(p[0]) - 2, Math.round(p[1]) - 7, 5, 4); g.fillStyle = "#5fba4a"; g.fillRect(Math.round(p[0]) - 1, Math.round(p[1]) - 7, 2, 2); }
              }
              if (u && u.vacant) { const p = F.out(uc - 0.05, fl * fh + 11, 0.2); g.fillStyle = "#f2a12c"; g.fillRect(Math.round(p[0]) - 4, Math.round(p[1]) - 1, 9, 5); CV.pixelText(g, "LET", Math.round(p[0]) - 3, Math.round(p[1]), "#1e1e1e"); }
            }
          });
          if (isDoor && fl >= 1) { // stairwell window
            win(ctx, F, mid - 0.07, mid + 0.07, fl * fh + 3, fl * fh + 14, { frame: "#e8e2d6", state: ctx.stage, dark: true, glow: true });
          }
        }
        if (isDoor) {
          door(ctx, F, mid, 0.34, 19, { color: "#3a4a5a", frame: "#cfc8bb", glazed: true, step: true, boarded: stage >= 4 });
          const r = F.rect(mid - 0.3, mid + 0.3, 0, 0.28);
          boxAt(g, r[0], r[1], r[2], r[3], 21, 23, "#5a6070");
          const name = String(ctx.p.name || "").split(" ")[0].toUpperCase();
          if (name) wallSign(ctx, F, name, mid, 27, "#f6e7b8", "#2a2f3a");
          ctx.porch = F.out(mid, 20, 0.2);
        }
        if (stage >= 3) grime(ctx, F, H, stage, ctx.h0 + f.charCodeAt(0), col, "over");
      }
      flatRoof(ctx, ctx.roofC);
      // water tank on legs, AC boxes, stair housing, antenna
      const Hd = ctx.H;
      const tx = x0 + 0.5, ty = y0 + 0.45;
      // the timber water tank; on a derelict block a leg has given way and it leans
      const lean = stage >= 4 ? -16 : 0, dz = (x, y) => lean * (x - tx) + lean * 0.4 * (y - ty);
      const Q = (x, y, z) => P(x, y, z + dz(x, y));
      for (const [dx, dy] of [[0, 0], [0.42, 0], [0, 0.42], [0.42, 0.42]]) { const top = Math.max(1, 8 + dz(tx + dx, ty + dy)); boxAt(g, tx + dx, ty + dy, tx + dx + 0.04, ty + dy + 0.04, Hd, Hd + top, "#4a3a2a"); }
      const a0 = tx - 0.02, b0 = ty - 0.02, a1 = tx + 0.48, b1 = ty + 0.48;
      const sides = { s: [[a0, b1], [a1, b1]], e: [[a1, b1], [a1, b0]], n: [[a1, b0], [a0, b0]], w: [[a0, b0], [a0, b1]] };
      for (const f of FACES) {
        const [[p0x, p0y], [p1x, p1y]] = sides[f], col = f === LIT ? "#8a6440" : shade("#8a6440", 0.8);
        poly(g, [Q(p0x, p0y, Hd + 8), Q(p1x, p1y, Hd + 8), Q(p1x, p1y, Hd + 22), Q(p0x, p0y, Hd + 22)], col);
        for (let z = Hd + 11; z < Hd + 22; z += 4) poly(g, [Q(p0x, p0y, z), Q(p1x, p1y, z), Q(p1x, p1y, z + 1), Q(p0x, p0y, z + 1)], f === LIT ? "#5a4028" : "#4a3420");
      }
      poly(g, [Q(tx - 0.04, ty - 0.04, Hd + 22), Q(tx + 0.5, ty - 0.04, Hd + 22), Q(tx + 0.5, ty + 0.5, Hd + 22), Q(tx + 0.23, ty + 0.23, Hd + 30), Q(tx - 0.04, ty + 0.5, Hd + 22)], "#6a4a30");
      poly(g, [Q(tx - 0.04, ty + 0.5, Hd + 22), Q(tx + 0.5, ty + 0.5, Hd + 22), Q(tx + 0.23, ty + 0.23, Hd + 30)], "#7a5838");
      if (stage >= 4) { const p = Q(tx + 0.5, ty + 0.3, Hd + 9); g.fillStyle = "#2a3a4a"; g.fillRect(Math.round(p[0]), Math.round(p[1]), 1, 5); } // a dribble from a split stave
      boxAt(g, x1 - 1.4, y0 + 0.4, x1 - 0.7, y0 + 1.1, Hd, Hd + 12, "#a8a090");
      const Fs = faceFn(LIT, x1 - 1.4, y0 + 0.4, x1 - 0.7, y0 + 1.1);
      poly(g, quad(Fs, 0.25, 0.45, Hd, Hd + 9), "#5a5048");
      acUnit(ctx, x1 - 0.6, y1 - 0.65, Hd); acUnit(ctx, x0 + 1.3, y1 - 0.6, Hd);
      const ap = P(x0 + 1.8, y0 + 0.5, Hd);
      g.fillStyle = "#3a3e48"; g.fillRect(Math.round(ap[0]), Math.round(ap[1]) - 18, 1, 18); g.fillRect(Math.round(ap[0]) - 4, Math.round(ap[1]) - 14, 9, 1); g.fillRect(Math.round(ap[0]) - 3, Math.round(ap[1]) - 10, 7, 1);
    }

    function drawTower(ctx) {
      const g = ctx.g, { x0, y0, x1, y1, H } = ctx;
      const fh = ctx.st.floorPx, floors = ctx.floors;
      for (const f of FACES) {
        const F = faceFn(f, x0, y0, x1, y1), litF = f === LIT;
        const spandrel = litF ? "#3e5068" : "#2f3e54", glass = litF ? "#8ac0e6" : "#5f92c2", glassHi = litF ? "#b6dcf4" : "#80aed6";
        poly(g, quad(F, 0, F.len, 0, ctx.Hw), spandrel);
        // lobby
        poly(g, quad(F, 0.08, F.len - 0.08, 0, fh - 2), litF ? "#2a3a4c" : "#223042");
        for (let u = 0.08; u < F.len - 0.1; u += 0.5) poly(g, quad(F, u + 0.04, u + 0.46, 2, fh - 4), litF ? "#6ea4cc" : "#4e80aa");
        for (let fl = 1; fl < floors; fl++) {
          const z0 = fl * fh + 5, z1 = fl * fh + fh - 1;
          const q = quad(F, 0.08, F.len - 0.08, z0, z1);
          poly(g, q, glass);
          poly(g, quad(F, 0.08, F.len - 0.08, z1 - 3, z1), glassHi);
          for (let u = 0.08; u < F.len - 0.05; u += 0.25) { const qq = quad(F, u + 0.02, u + 0.23, z0, z1 - 1); ctx.windows.push(qq); }
          for (let u = 0.08; u <= F.len - 0.06; u += 0.25) poly(g, quad(F, u, u + 0.02, z0, z1), litF ? "#3a4c62" : "#2a3a50");
        }
        // reflections sweeping across the glass
        const R = rng(ctx.h0 + f.charCodeAt(0));
        for (let k = 0; k < 3; k++) {
          const u = 0.3 + R() * (F.len - 1.2), w = 0.25 + R() * 0.35, za = fh + 4, zb = H - 4;
          poly(g, [F.at(u, za), F.at(u + w, za), F.at(u + w + 0.9, zb), F.at(u + 0.9, zb)], litF ? "rgba(255,255,255,0.13)" : "rgba(255,255,255,0.07)");
        }
        poly(g, quad(F, 0, 0.08, 0, H), litF ? "#c9d1dc" : "#9aa4b2"); poly(g, quad(F, F.len - 0.08, F.len, 0, H), litF ? "#c9d1dc" : "#9aa4b2");
        poly(g, quad(F, 0, F.len, H - 2, ctx.Hw), litF ? "#c9d1dc" : "#9aa4b2");
        if (f === ctx.p.face) {
          const uc = entryU(ctx, F);
          door(ctx, F, uc, 0.5, 15, { color: "#2a3a4c", frame: "#c9d1dc", glazed: true });
          const r = F.rect(uc - 0.5, uc + 0.5, 0, 0.35);
          boxAt(g, r[0], r[1], r[2], r[3], 16, 19, "#c9d1dc");
        }
      }
      flatRoof(ctx, "#5a6070", { cope: "#d8dee6" });
      const Hd = ctx.H;
      // crown: a set-back plant room with the company sign, and an antenna mast
      const cx0 = x0 + 0.7, cy0 = y0 + 0.6, cx1 = x1 - 0.7, cy1 = y1 - 0.6;
      boxAt(g, cx0, cy0, cx1, cy1, Hd, Hd + 14, "#5a6a80", "#4a5466");
      const Fc = faceFn(LIT, cx0, cy0, cx1, cy1);
      for (let u = 0.1; u < Fc.len; u += 0.2) poly(g, quad(Fc, u, u + 0.1, Hd + 3, Hd + 11), "#4a5a70");
      if (/brightline/i.test(ctx.p.name || "")) wallSign(ctx, Fc, "BRIGHTLINE", Fc.len / 2, Hd + 7, "#bfe6ff", "#1e2a3c");
      const m = P((x0 + x1) / 2 + 0.6, (y0 + y1) / 2, Hd + 14);
      g.fillStyle = "#c9d1dc"; g.fillRect(Math.round(m[0]), Math.round(m[1]) - 30, 2, 30);
      g.fillStyle = "#e23b3b"; g.fillRect(Math.round(m[0]), Math.round(m[1]) - 32, 2, 2);
      ctx.beacon = [m[0] + 1, m[1] - 31];
    }

    function drawHospital(ctx) {
      const g = ctx.g, { x0, y0, x1, y1, H } = ctx;
      const fh = ctx.st.floorPx, floors = ctx.floors;
      for (const f of FACES) {
        const F = faceFn(f, x0, y0, x1, y1), litF = f === LIT, col = litF ? ctx.wall : shade(ctx.wall, 0.82);
        poly(g, quad(F, 0, F.len, 0, ctx.Hw), col);
        poly(g, quad(F, 0, F.len, 0, 4), shade(col, 0.75));
        for (let fl = 0; fl < floors; fl++) {
          const z0 = fl * fh + 7, z1 = z0 + 9;
          poly(g, quad(F, 0.12, F.len - 0.12, z0 - 1, z1 + 1), litF ? "#9aa6b6" : "#7a8698");
          poly(g, quad(F, 0.12, F.len - 0.12, z0, z1), litF ? "#5d8fc0" : "#4a78a6");
          poly(g, quad(F, 0.12, F.len - 0.12, z1 - 2, z1), litF ? "#9cc8ea" : "#7aa6cc");
          for (let u = 0.12; u < F.len - 0.15; u += 0.4) { poly(g, quad(F, u, u + 0.03, z0, z1), col); ctx.windows.push(quad(F, u + 0.03, Math.min(F.len - 0.12, u + 0.4), z0, z1)); }
        }
        poly(g, quad(F, 0, 0.1, 0, H), shade(col, 0.92)); poly(g, quad(F, F.len - 0.1, F.len, 0, H), shade(col, 0.92));
        if (litF) { // big red cross
          const u = 0.55, z = H - 22;
          poly(g, quad(F, u - 0.06, u + 0.5, z - 2, z + 18), "#ffffff");
          poly(g, quad(F, u, u + 0.44, z + 5, z + 11), "#e23b3b"); poly(g, quad(F, u + 0.16, u + 0.28, z, z + 16), "#e23b3b");
        }
        if (f === ctx.p.face) {
          const uc = entryU(ctx, F);
          door(ctx, F, uc, 0.6, 16, { color: "#2a3a4c", frame: "#c9d1dc", glazed: true });
          const r = F.rect(uc - 0.7, uc + 0.7, 0, 0.45);
          boxAt(g, r[0], r[1], r[2], r[3], 18, 21, "#e23b3b", "#c83030");
          column(ctx, F, uc - 0.6, 0.45, 0, 18, "#d8dee6"); column(ctx, F, uc + 0.6, 0.45, 0, 18, "#d8dee6");
          wallSign(ctx, F, "HOSPITAL", uc, 27, "#ffffff", "#c83030");
        }
      }
      flatRoof(ctx, ctx.roofC, { cope: "#ffffff" });
      const Hd = ctx.H, cx = (x0 + x1) / 2 + 0.6, cy = (y0 + y1) / 2;
      poly(g, top(cx - 1.1, cy - 1.1, cx + 1.1, cy + 1.1, Hd + 1), "#4a6a5a");
      poly(g, top(cx - 0.95, cy - 0.95, cx + 0.95, cy + 0.95, Hd + 1), "#5a8a6a");
      poly(g, top(cx - 0.45, cy - 0.1, cx + 0.45, cy + 0.1, Hd + 1), "#ffffff");
      poly(g, top(cx - 0.45, cy - 0.55, cx - 0.27, cy + 0.55, Hd + 1), "#ffffff");
      poly(g, top(cx + 0.27, cy - 0.55, cx + 0.45, cy + 0.55, Hd + 1), "#ffffff");
      acUnit(ctx, x0 + 0.6, y0 + 0.5, Hd); acUnit(ctx, x0 + 1.1, y0 + 0.5, Hd); acUnit(ctx, x0 + 0.6, y1 - 0.8, Hd);
      boxAt(g, x0 + 1.6, y0 + 0.4, x0 + 2.6, y0 + 1.2, Hd, Hd + 10, "#c8ccd4");
    }

    function drawSchool(ctx) {
      const g = ctx.g, { x0, y0, x1, y1, H } = ctx;
      const fh = ctx.st.floorPx;
      for (const f of FACES) {
        const F = faceFn(f, x0, y0, x1, y1), litF = f === LIT, col = litF ? ctx.wall : shade(ctx.wall, 0.8);
        poly(g, quad(F, 0, F.len, 0, ctx.Hw), col);
        for (let z = 2; z < H; z += 3) poly(g, quad(F, 0, F.len, z, z + 1), shade(col, 0.88));
        poly(g, quad(F, 0, F.len, 0, 5), litF ? "#9a8a7a" : "#7a6c60");
        poly(g, quad(F, 0, F.len, fh, fh + 2), litF ? "#e8e0d0" : "#bdb5a6");
        poly(g, quad(F, 0, F.len, H - 3, H), litF ? "#e8e0d0" : "#bdb5a6");
        const isDoor = f === ctx.p.face, doorU = isDoor ? entryU(ctx, F) : -9;
        const n = Math.max(2, Math.round(F.len * 1.7));
        for (let fl = 0; fl < 2; fl++) for (let i = 0; i < n; i++) {
          const uc = (i + 0.5) * F.len / n;
          if (fl === 0 && Math.abs(uc - doorU) < 0.5) continue;
          win(ctx, F, uc - 0.17, uc + 0.17, fl * fh + 7, fl * fh + 21, { frame: "#f2ede2", mullion: true, sill: "#e8e0d0", state: 0, idx: i });
        }
        if (isDoor) {
          door(ctx, F, doorU, 0.42, 19, { color: "#2f5a8a", frame: "#f2ede2", glazed: true, step: true });
          const r = F.rect(doorU - 0.45, doorU + 0.45, 0, 0.35);
          boxAt(g, r[0], r[1], r[2], r[3], 21, 24, "#e8e0d0");
          wallSign(ctx, F, "SCHOOL", doorU, fh + 13, "#ffffff", "#2f5a8a");
          // clock on the gable of the entrance bay
          const c = F.at(doorU, H + 8);
          CV.ellipse(g, c[0], c[1], 6, 6, "#e8e0d0"); CV.ellipse(g, c[0], c[1], 5, 5, "#ffffff");
          g.fillStyle = "#222"; g.fillRect(Math.round(c[0]), Math.round(c[1]) - 4, 1, 4); g.fillRect(Math.round(c[0]), Math.round(c[1]), 3, 1);
        }
      }
      const roof = pitched(ctx, "hip", ctx.st.roofPx);
      if (roof) { // a little bell turret on the ridge
        const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, zt = ctx.Hw + ctx.st.roofPx;
        boxAt(g, cx - 0.2, cy - 0.2, cx + 0.2, cy + 0.2, zt - 4, zt + 10, "#f2ede2");
        poly(g, [P(cx - 0.25, cy - 0.25, zt + 10), P(cx + 0.25, cy - 0.25, zt + 10), P(cx + 0.25, cy + 0.25, zt + 10), P(cx, cy, zt + 20), P(cx - 0.25, cy + 0.25, zt + 10)], shade(ctx.roofC, 0.85));
        poly(g, [P(cx - 0.25, cy + 0.25, zt + 10), P(cx + 0.25, cy + 0.25, zt + 10), P(cx, cy, zt + 20)], ctx.roofC);
      }
    }

    function drawCivic(ctx) { // city hall and bank: stone, pilasters or columns, cornice
      const g = ctx.g, { x0, y0, x1, y1, H } = ctx;
      const fh = ctx.st.floorPx, floors = ctx.floors, bank = ctx.p.style === "bank";
      for (const f of FACES) {
        const F = faceFn(f, x0, y0, x1, y1), litF = f === LIT, col = litF ? ctx.wall : shade(ctx.wall, 0.82);
        poly(g, quad(F, 0, F.len, 0, ctx.Hw), col);
        poly(g, quad(F, 0, F.len, 0, fh), shade(col, 0.92)); // rusticated base
        for (let z = 4; z < fh; z += 5) poly(g, quad(F, 0, F.len, z, z + 1), shade(col, 0.8));
        poly(g, quad(F, 0, F.len, fh, fh + 2), shade(col, 1.08));
        const n = Math.max(2, Math.round(F.len * 1.4));
        for (let fl = 0; fl < floors; fl++) for (let i = 0; i < n; i++) {
          const uc = (i + 0.5) * F.len / n;
          if (fl === 0 && f === ctx.p.face && Math.abs(uc - entryU(ctx, F)) < 0.4) continue;
          win(ctx, F, uc - 0.12, uc + 0.12, fl * fh + 5, fl * fh + fh - 4, { frame: shade(ctx.wall, 1.1), mullion: true, sill: shade(ctx.wall, 1.1), state: 0, idx: i });
          poly(g, [F.at(uc - 0.16, fl * fh + fh - 3), F.at(uc + 0.16, fl * fh + fh - 3), F.at(uc, fl * fh + fh)], litF ? shade(ctx.wall, 1.12) : shade(ctx.wall, 0.95)); // pediment cap
        }
        if (litF) { // columns across the lower floors
          const top2 = Math.min(floors, 2) * fh;
          const cols = Math.max(4, Math.round(F.len * 1.2));
          poly(g, quad(F, 0.15, F.len - 0.15, 0, top2 + 6), shade(col, 0.72));
          for (let i = 0; i <= cols; i++) { const u = 0.2 + (F.len - 0.4) * i / cols; column(ctx, F, u, 0.22, 3, top2, "#f6f2e6"); }
          const r = F.rect(0.1, F.len - 0.1, 0, 0.26);
          boxAt(g, r[0], r[1], r[2], r[3], 0, 3, "#d8d2c2");
          boxAt(g, r[0], r[1], r[2], r[3], top2, top2 + 6, "#f0ead8");
          wallSign(ctx, { face: F.face, at: (u, z) => F.out(u, z, 0.26) }, bank ? "SAVINGS BANK" : "CITY HALL", F.len / 2, top2 + 3, "#3a3020", null);
        }
        poly(g, quad(F, 0, F.len, H - 2, ctx.Hw), shade(col, 1.12)); // cornice
        if (f === ctx.p.face && !litF) door(ctx, F, entryU(ctx, F), 0.3, 20, { color: "#4a3420", frame: shade(ctx.wall, 1.1) });
      }
      flatRoof(ctx, ctx.roofC, { cope: shade(ctx.wall, 1.15) });
      const Hd = ctx.H;
      if (!bank) { // clock tower with a copper dome
        const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, w = 0.55;
        boxAt(g, cx - w, cy - w, cx + w, cy + w, Hd, Hd + 32, ctx.wall);
        for (const f of FACES) {
          const F = faceFn(f, cx - w, cy - w, cx + w, cy + w);
          const c = F.at(F.len / 2, Hd + 21);
          CV.ellipse(g, c[0], c[1], 6, 6, f === LIT ? "#3a3020" : "#2a2418"); CV.ellipse(g, c[0], c[1], 5, 5, f === LIT ? "#ffffff" : "#d8d8d8");
          g.fillStyle = "#222"; g.fillRect(Math.round(c[0]), Math.round(c[1]) - 4, 1, 4); g.fillRect(Math.round(c[0]) - 3, Math.round(c[1]), 3, 1);
          poly(g, quad(F, 0.1, F.len - 0.1, Hd + 6, Hd + 13), f === LIT ? "#3a4250" : "#2a3240");
        }
        boxAt(g, cx - w - 0.06, cy - w - 0.06, cx + w + 0.06, cy + w + 0.06, Hd + 32, Hd + 35, shade(ctx.wall, 1.1));
        const d = P(cx, cy, Hd + 35);
        const dome = CV.shadedBlobs(30, 18, [[15, 17, 15, 16]], ["#2a5a4a", "#3a7a62", "#4f9a7a", "#6abaa0", "#9adac0"], 3, { noise: 0.05 });
        g.drawImage(dome, Math.round(d[0]) - 15, Math.round(d[1]) - 17);
        g.fillStyle = "#c9a14a"; g.fillRect(Math.round(d[0]), Math.round(d[1]) - 28, 1, 12);
        g.fillStyle = "#3a6ad6"; g.fillRect(Math.round(d[0]) + 1, Math.round(d[1]) - 28, 7, 4); g.fillStyle = "#ffffff"; g.fillRect(Math.round(d[0]) + 1, Math.round(d[1]) - 27, 7, 1);
      } else {
        acUnit(ctx, x0 + 0.5, y0 + 0.5, Hd); acUnit(ctx, x1 - 0.9, y0 + 0.6, Hd);
      }
    }

    function drawShop(ctx) { // cafe, diner, market, bakery, grocer, noodle bar, arcade
      const g = ctx.g, { x0, y0, x1, y1, H, st } = ctx;
      const fh = st.floorPx, floors = ctx.floors;
      const s = ctx.p.style;
      // the awning goes on the door face, or on the lit face when the door faces away
      const front = FACES.includes(ctx.p.face) ? ctx.p.face : LIT;
      for (const f of FACES) {
        const F = faceFn(f, x0, y0, x1, y1), litF = f === LIT, col = litF ? ctx.wall : shade(ctx.wall, 0.8);
        poly(g, quad(F, 0, F.len, 0, ctx.Hw), col);
        if (s === "corner_shop" || s === "bakery") for (let z = 2; z < H; z += 3) poly(g, quad(F, 0, F.len, z, z + 1), shade(col, 0.88));
        if (s === "diner") { poly(g, quad(F, 0, F.len, 4, 6), litF ? "#c23b3b" : "#9a2e2e"); poly(g, quad(F, 0, F.len, H - 6, H - 4), litF ? "#c23b3b" : "#9a2e2e"); poly(g, quad(F, 0, F.len, H - 3, H - 2), "#ffffff"); }
        if (s === "arcade") { for (let z = 4; z < fh; z += 5) poly(g, quad(F, 0, F.len, z, z + 1), shade(col, 0.86)); }
        poly(g, quad(F, 0, F.len, 0, 3), shade(col, 0.66));
        const isFront = f === front;
        // ground floor: big shop windows on the front, smaller windows elsewhere
        if (isFront) {
          const du = FACES.includes(ctx.p.face) ? entryU(ctx, F) : F.len / 2;
          const panes = Math.max(2, Math.round(F.len * 1.3));
          for (let i = 0; i < panes; i++) {
            const a = 0.1 + (F.len - 0.2) * i / panes, b = 0.1 + (F.len - 0.2) * (i + 1) / panes - 0.06;
            if (Math.abs((a + b) / 2 - du) < 0.3) continue;
            win(ctx, F, a, b, 4, fh - 9, { frame: s === "diner" ? "#d8dee6" : "#3a3a3a", state: 0, idx: i });
            if (s === "bakery" || s === "market" || s === "corner_shop") { const p = F.at((a + b) / 2, 6); g.fillStyle = ["#d8a050", "#e8c060", "#c07030"][i % 3]; g.fillRect(Math.round(p[0]) - 3, Math.round(p[1]) - 2, 6, 2); }
          }
          door(ctx, F, du, 0.26, fh - 9, { color: "#3a4a5a", frame: "#3a3a3a", glazed: true });
          if (st.awning) awning(ctx, F, 0.05, F.len - 0.05, fh - 4, st.awning, 0.26, 8);
          if (st.lanterns) for (let u = 0.25; u < F.len - 0.1; u += 0.45) { const p = F.out(u, fh - 13, 0.24); CV.ellipse(g, p[0], p[1], 3, 3, "#d8281e"); g.fillStyle = "#f6d24a"; g.fillRect(Math.round(p[0]) - 1, Math.round(p[1]) - 1, 2, 1); ctx.lights.push([p[0], p[1], "#ff6a3a"]); }
        } else {
          const n = Math.max(1, Math.round(F.len * 1.1));
          for (let i = 0; i < n; i++) { const uc = (i + 0.5) * F.len / n; win(ctx, F, uc - 0.13, uc + 0.13, 7, Math.min(fh - 6, 18), { frame: "#f2ede2", state: 0, idx: i, mullion: true }); }
        }
        for (let fl = 1; fl < floors; fl++) {
          const n = Math.max(2, Math.round(F.len * 1.2));
          for (let i = 0; i < n; i++) {
            const uc = (i + 0.5) * F.len / n;
            win(ctx, F, uc - 0.13, uc + 0.13, fl * fh + 6, fl * fh + fh - 5, { frame: "#f2ede2", state: 0, idx: i, mullion: true, sill: "#f2ede2", box: s !== "arcade" && litF, curtain: s === "arcade" ? null : CURTAIN[(i + fl) % 6] });
            if (s === "arcade") poly(g, [F.at(uc - 0.13, fl * fh + fh - 5), F.at(uc + 0.13, fl * fh + fh - 5), F.at(uc, fl * fh + fh - 1)], litF ? shade(ctx.wall, 1.1) : shade(ctx.wall, 0.9));
          }
          poly(g, quad(F, 0, F.len, fl * fh, fl * fh + 1), shade(col, 0.85));
        }
        if (s === "arcade" && isFront) { // colourful shop awnings along the arcade front
          const cols = [["#c0392b", "#ffffff"], ["#2f7fb8", "#ffffff"], ["#2f8c5a", "#ffffff"], ["#d18f2f", "#fff4dd"]];
          const n = Math.max(3, Math.round(F.len / 1.6));
          for (let i = 0; i < n; i++) { const a = 0.1 + (F.len - 0.2) * i / n, b = a + (F.len - 0.2) / n - 0.08; awning(ctx, F, a, b, fh - 4, cols[i % 4], 0.22, 6); }
        }
        if (st.sign && f === LIT) {
          const zS = floors > 1 ? fh + 1 : Math.min(ctx.Hw - 6, fh - 1);
          const big = s === "market" || s === "arcade" ? 2 : 1;
          if (floors > 1 || s === "market") wallSign(ctx, F, st.sign, F.len / 2, floors > 1 ? fh + 6 : H - 4, s === "diner" ? "#ff6a6a" : "#ffffff", st.signBg, big);
          else wallSign(ctx, F, st.sign, F.len / 2, zS + 2, "#ffffff", st.signBg, 1);
        }
        poly(g, quad(F, 0, F.len, H - 2, ctx.Hw), shade(col, 1.1));
      }
      if (st.roof === "gable") pitched(ctx, "gable", st.roofPx);
      else {
        flatRoof(ctx, ctx.roofC, { cope: shade(ctx.wall, 1.12) });
        const Hd = ctx.H;
        if (st.roof === "glass") { // barrel skylight down the middle
          const xa = x0 + 0.6, xb = x1 - 0.6, ya = y0 + 0.9, yb = y1 - 0.9, ymid = (ya + yb) / 2;
          poly(g, [P(xa, ya, Hd + 2), P(xb, ya, Hd + 2), P(xb, ymid, Hd + 9), P(xa, ymid, Hd + 9)], "#7aa8c8");
          poly(g, [P(xa, ymid, Hd + 9), P(xb, ymid, Hd + 9), P(xb, yb, Hd + 2), P(xa, yb, Hd + 2)], "#b8dcf2");
          for (let x = xa + 0.35; x < xb; x += 0.35) poly(g, [P(x, ymid, Hd + 9), P(x + 0.03, ymid, Hd + 9), P(x + 0.03, yb, Hd + 2), P(x, yb, Hd + 2)], "#ffffff");
          poly(g, [P(xb, ya, Hd + 2), P(xb, yb, Hd + 2), P(xb, ymid, Hd + 9)], "#5a8aaa");
        } else if (s === "diner") { // rooftop neon sign on posts
          const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
          const Fn = faceFn(LIT, cx - 0.9, cy, cx + 0.9, cy + 0.05);
          for (const u of [0.3, 1.5]) { const p = Fn.at(u, Hd); g.fillStyle = "#3a3a3a"; g.fillRect(Math.round(p[0]), Math.round(p[1]) - 8, 1, 8); }
          const sz = wallSign(ctx, Fn, "DINER", 0.9, Hd + 13, "#ff6a8a", "#1e2230", 2);
          const c = Fn.at(0.9, Hd + 13);
          ctx.neon = [c[0] - sz.w / 2, c[1] - sz.h / 2 - 2, sz.w, sz.h + 6];
        } else { acUnit(ctx, x0 + 0.4, y0 + 0.4, Hd); if (x1 - x0 > 3.5) acUnit(ctx, x1 - 0.8, y0 + 0.5, Hd); }
      }
    }

    function drawFactory(ctx) {
      const g = ctx.g, { x0, y0, x1, y1, H } = ctx;
      const fh = ctx.st.floorPx;
      for (const f of FACES) {
        const F = faceFn(f, x0, y0, x1, y1), litF = f === LIT, col = litF ? ctx.wall : shade(ctx.wall, 0.8);
        poly(g, quad(F, 0, F.len, 0, ctx.Hw), col);
        for (let u = 0.03; u < F.len; u += 0.07) poly(g, quad(F, u, u + 0.025, 5, H), shade(col, 0.88)); // corrugation
        poly(g, quad(F, 0, F.len, 0, 5), litF ? "#7a7c80" : "#626468");
        poly(g, quad(F, 0.1, F.len - 0.1, H - 16, H - 7), litF ? "#3a5a7a" : "#2e4a66");
        for (let u = 0.1; u < F.len - 0.15; u += 0.35) { poly(g, quad(F, u, u + 0.025, H - 16, H - 7), col); ctx.windows.push(quad(F, u + 0.025, Math.min(F.len - 0.1, u + 0.35), H - 16, H - 7)); }
        poly(g, quad(F, 0.1, F.len - 0.1, H - 9, H - 7), litF ? "#9cc8ea" : "#7aa6cc");
        if (f === ctx.p.face || (litF && !FACES.includes(ctx.p.face))) {
          const n = Math.max(2, Math.floor(F.len / 2.2));
          for (let i = 0; i < n; i++) { // roller doors
            const uc = (i + 0.5) * F.len / n;
            poly(g, quad(F, uc - 0.42, uc + 0.42, 0, 26), "#e0b830");
            poly(g, quad(F, uc - 0.38, uc + 0.38, 0, 24), litF ? "#8a8e94" : "#6e7278");
            for (let z = 3; z < 24; z += 3) poly(g, quad(F, uc - 0.38, uc + 0.38, z, z + 1), litF ? "#6e7278" : "#585c62");
          }
          wallSign(ctx, F, "MILLBROOK WORKS", F.len / 2, fh + 8, "#ffffff", "#2a3a4a");
        }
        poly(g, quad(F, 0, F.len, H - 2, ctx.Hw), shade(col, 1.1));
      }
      // saw-tooth roof: shallow slopes with glazed faces turned to the camera
      const Hd = ctx.Hw;
      const n = Math.max(2, Math.floor((y1 - y0) / 1.1));
      const d = (y1 - y0) / n;
      for (let k = 0; k < n; k++) {
        const ya = y0 + k * d, yb = ya + d;
        poly(g, [P(x0, ya, Hd), P(x1, ya, Hd), P(x1, yb, Hd + 14), P(x0, yb, Hd + 14)], shade(ctx.roofC, 1.05));
        for (let x = x0 + 0.25; x < x1; x += 0.5) poly(g, [P(x, ya, Hd), P(x + 0.02, ya, Hd), P(x + 0.02, yb, Hd + 14), P(x, yb, Hd + 14)], shade(ctx.roofC, 0.92));
        poly(g, [P(x0, yb, Hd), P(x1, yb, Hd), P(x1, yb, Hd + 14), P(x0, yb, Hd + 14)], "#5a7a96");
        poly(g, [P(x0, yb, Hd + 10), P(x1, yb, Hd + 10), P(x1, yb, Hd + 14), P(x0, yb, Hd + 14)], "#8ab4d6");
        poly(g, [P(x1, ya, Hd), P(x1, yb, Hd + 14), P(x1, yb, Hd)], shade(ctx.wall, 0.75));
      }
      // smokestack with red and white bands
      const sx = x0 + 0.5, sy = y0 + 0.4;
      boxAt(g, sx, sy, sx + 0.45, sy + 0.45, Hd, Hd + 84, "#a8463a");
      for (let z = Hd + 14; z < Hd + 84; z += 18) boxAt(g, sx, sy, sx + 0.45, sy + 0.45, z, z + 7, "#ece6dc");
      boxAt(g, sx - 0.04, sy - 0.04, sx + 0.49, sy + 0.49, Hd + 84, Hd + 87, "#3a3a3a");
      ctx.smoke = P(sx + 0.22, sy + 0.22, Hd + 88);
      // silos in the yard
      const sl = ctx.body.silos;
      if (sl) for (const t of [0.28, 0.72]) {
        const cx = (sl[0] + sl[2]) / 2, cy = sl[1] + (sl[3] - sl[1]) * t;
        const b = P(cx, cy, 0), rx = 15, hh = 70;
        for (let x = -rx; x < rx; x++) {
          const k = x / rx, v = 0.62 - k * 0.38 - Math.abs(k) ** 6 * 0.3;
          const c = mix("#5e666e", "#e2e6ea", Math.max(0, Math.min(1, v)));
          const ey = Math.round(Math.sqrt(1 - k * k) * rx * 0.5);
          g.fillStyle = c; g.fillRect(Math.round(b[0]) + x, Math.round(b[1]) - hh - 0, 1, hh + ey);
          g.fillStyle = shade(c, 0.85); for (let z = 12; z < hh; z += 14) g.fillRect(Math.round(b[0]) + x, Math.round(b[1]) - z + ey, 1, 1);
        }
        CV.ellipse(g, b[0], b[1] - hh, rx, rx / 2, "#c8ccd2");
        CV.ellipse(g, b[0] - 1, b[1] - hh - 3, rx - 4, rx / 2 - 2, "#dfe3e8");
        g.fillStyle = "#9aa0a6"; g.fillRect(Math.round(b[0]) - 1, Math.round(b[1]) - hh - 10, 3, 6);
      }
    }

    // Scaffolding over the visible walls while works are on.
    function scaffold(ctx) {
      const g = ctx.g, { x0, y0, x1, y1 } = ctx, H = ctx.Hw;
      for (const f of FACES) {
        const F = faceFn(f, x0 - 0.18, y0 - 0.18, x1 + 0.18, y1 + 0.18);
        for (let u = 0; u <= F.len + 0.01; u += 0.5) poly(g, quad(F, u, u + 0.03, 0, H + 8), "#8a6a3a");
        for (let z = 8; z < H + 8; z += 10) { poly(g, quad(F, 0, F.len, z, z + 2), "#c8a060"); poly(g, quad(F, 0, F.len, z + 2, z + 3), "#8a6a3a"); }
        for (let u = 0; u < F.len - 0.4; u += 1) poly(g, [F.at(u, 0), F.at(u + 0.03, 0), F.at(u + 0.53, H), F.at(u + 0.5, H)], "rgba(138,106,58,0.8)");
      }
    }

    // --- the building sprite ---------------------------------------------------------------------------
    // look: { stage 0..4, units: [{unit, vacant, listing}], works, ... } (homes only).
    art.building = function (p, look, season) {
      look = look || {};
      const st = STYLE[p.style] || STYLE.house;
      const isHome = p.kind === "home";
      const stage = isHome ? Math.max(0, Math.min(4, look.stage | 0)) : 0;
      const h0 = hash(p.id);
      const floors = Math.max(1, p.floors || CV.FLOORS[p.style] || 1);
      const flatTop = st.roof === "flat" || st.roof === "glass" || st.roof === "saw";
      const H = floors * st.floorPx + (p.style === "house" ? 0 : 4);
      const Hw = H + (flatTop ? 4 : 0);
      const body = CV.bodyOf(p);
      let wall = st.wall ? (Array.isArray(st.wall) ? st.wall[h0 % st.wall.length] : st.wall) : p.style === "big_house" ? VILLA_PAINT[h0 % VILLA_PAINT.length] : HOUSE_PAINT[h0 % HOUSE_PAINT.length];
      let roofC = st.roofC || (p.style === "big_house" ? VILLA_ROOF[(h0 >>> 4) % VILLA_ROOF.length] : HOUSE_ROOF[(h0 >>> 4) % HOUSE_ROOF.length]);
      let trim = isHome ? ["#ffffff", "#f6efe0", "#ffffff", "#efe9dc"][(h0 >>> 8) % 4] : "#ffffff";
      if (isHome) {
        wall = shade(mix(wall, GREY, FADE[stage]), DIM[stage]);
        roofC = shade(mix(roofC, "#77736a", FADE[stage] * 0.7), DIM[stage]);
        trim = shade(mix(trim, "#a8a090", FADE[stage]), DIM[stage]);
      }
      const extra = (st.roofPx || 0) + (p.style === "factory" ? 96 : p.style === "city_hall" ? 70 : p.style === "tower" ? 50 : p.style === "apartments" ? 34 : p.style === "school" ? 26 : p.style === "diner" ? 30 : 16);
      const topZ = Hw + extra;
      const fx0 = p.x - 0.25, fy0 = p.y - 0.25, fx1 = p.x + p.w + 0.25, fy1 = p.y + p.h + 0.25;
      const pts = [];
      for (const [a, b] of [[fx0, fy0], [fx1, fy0], [fx1, fy1], [fx0, fy1]]) { pts.push(P(a, b, 0)); pts.push(P(a, b, topZ)); }
      const bx0 = Math.min(...pts.map(q => q[0])) - 6, bx1 = Math.max(...pts.map(q => q[0])) + 6;
      const by0 = Math.min(...pts.map(q => q[1])) - 6, by1 = Math.max(...pts.map(q => q[1])) + 4;
      const S = art.sprite(bx0, by0, bx1, by1);
      const ctx = { g: S.g, p, st, look, stage, isHome, h0, floors, H, Hw, wall, roofC, trim, season, body,
        x0: body.x0, y0: body.y0, x1: body.x1, y1: body.y1, windows: [], lights: [], porch: null, neon: null, smoke: null, beacon: null };
      switch (p.style) {
        case "house": drawHouse(ctx); break;
        case "big_house": drawBigHouse(ctx); break;
        case "apartments": drawApartments(ctx); break;
        case "tower": drawTower(ctx); break;
        case "hospital": drawHospital(ctx); break;
        case "school": drawSchool(ctx); break;
        case "city_hall": case "bank": drawCivic(ctx); break;
        case "factory": drawFactory(ctx); break;
        default: drawShop(ctx);
      }
      // the front corner catches the light
      if (proj.kind === "iso") {
        const cs = [[body.x0, body.y0], [body.x1, body.y0], [body.x1, body.y1], [body.x0, body.y1]];
        const [cx, cy] = cs.reduce((m, c) => proj.depth(c[0], c[1]) > proj.depth(m[0], m[1]) ? c : m);
        const top = st.roof === "gable" || st.roof === "hip" ? H - 4 : Hw;
        const c0 = P(cx, cy, 0), c1 = P(cx, cy, top);
        S.g.fillStyle = "rgba(255,255,255,0.22)"; S.g.fillRect(Math.round(c0[0]) - 1, Math.round(c1[1]), 1, Math.round(c0[1] - c1[1]));
      }
      if (look.works) scaffold(ctx);
      const roofTop = Hw + (st.roofPx || 0);
      const litShare = isHome ? 70 : p.style === "tower" ? 45 : 60;
      return { c: S.c, ox: S.ox, oy: S.oy, windows: ctx.windows, lights: ctx.lights, height: roofTop, id: p.id, litShare,
        porch: ctx.porch, neon: ctx.neon, smoke: ctx.smoke, beacon: ctx.beacon, labelZ: roofTop + (p.style === "city_hall" ? 50 : p.style === "factory" ? 20 : 10) };
    };

    // Pool in a big house's garden (drawn into the ground). Clear blue when kept, green then empty; in
    // winter pale ice, and the derelict one an empty basin with dirty snow in the bottom.
    art.pool = function (g, rect, stage, ox, oy, season) {
      const [a, b, c, d] = rect;
      const snow = CV.SEASON[season] && CV.SEASON[season].snow;
      const T = (x, y, z) => { const q = P(x, y, z); return [q[0] - ox, q[1] - oy]; };
      const quadT = (x0, y0, x1, y1, z) => [T(x0, y0, z), T(x1, y0, z), T(x1, y1, z), T(x0, y1, z)];
      poly(g, quadT(a - 0.08, b - 0.08, c + 0.08, d + 0.08, 0), snow ? "#eef3f2" : stage >= 3 ? "#bdb6a6" : "#e8e2d4");
      const Rr = rng(stage * 31 + 7);
      if (snow) {
        poly(g, quadT(a, b, c, d, 0), stage === 4 ? "#8a8478" : "#9ab4c4");
        if (stage === 4) { // empty basin: dirty snow drifted into the deep end, leaves and a crack
          poly(g, quadT(a + 0.06, b + 0.06, c, d, 0), "#a49c8c");
          poly(g, quadT(a + 0.06, b + (d - b) * 0.45, c, d, 0), "#cfd2cc");
          for (let i = 0; i < 8; i++) { const q = T(a + 0.1 + Rr() * (c - a - 0.2), b + 0.1 + Rr() * (d - b - 0.2), 0); g.fillStyle = ["#7a6a4a", "#9a9488", "#6a5a3a"][i % 3]; g.fillRect(Math.round(q[0]), Math.round(q[1]), 2, 1); }
        } else {
          poly(g, quadT(a + 0.06, b + 0.06, c, d, 0), stage === 3 ? "#c8d4cc" : "#dfeaf0");
          for (let i = 0; i < 4; i++) { const q = T(a + 0.1 + Rr() * (c - a - 0.2), b + 0.1 + Rr() * (d - b - 0.2), 0); g.fillStyle = "#ffffff"; g.fillRect(Math.round(q[0]), Math.round(q[1]), 4, 1); }
          if (stage === 3) for (let i = 0; i < 6; i++) { const q = T(a + 0.1 + Rr() * (c - a - 0.2), b + 0.1 + Rr() * (d - b - 0.2), 0); g.fillStyle = "#8a6a2a"; g.fillRect(Math.round(q[0]), Math.round(q[1]), 2, 1); }
        }
      } else {
        const water = ["#4fb4e8", "#4aaee0", "#5aa89a", "#4a8a52", "#8a8270"][stage];
        poly(g, quadT(a, b, c, d, 0), stage === 4 ? "#a49c8c" : "#2f7aa0");
        poly(g, quadT(a + 0.06, b + 0.06, c, d, 0), water);
        if (stage <= 1) for (let i = 0; i < 5; i++) { const q = T(a + 0.1 + Rr() * (c - a - 0.2), b + 0.1 + Rr() * (d - b - 0.2), 0); g.fillStyle = "#bfe8ff"; g.fillRect(Math.round(q[0]), Math.round(q[1]), 3, 1); }
        if (stage === 3) for (let i = 0; i < 9; i++) { const q = T(a + 0.1 + Rr() * (c - a - 0.2), b + 0.1 + Rr() * (d - b - 0.2), 0); g.fillStyle = ["#8a6a2a", "#a8843a", "#3a5a22"][i % 3]; g.fillRect(Math.round(q[0]), Math.round(q[1]), 2, 1); }
      }
      if (stage === 4) { const q = T(a + 0.2, b + 0.3, 0); g.fillStyle = "#5a5246"; g.fillRect(Math.round(q[0]), Math.round(q[1]), 10, 1); g.fillRect(Math.round(q[0]) + 9, Math.round(q[1]) + 1, 6, 1); g.fillRect(Math.round(q[0]) + 14, Math.round(q[1]) + 2, 5, 1); }
      // ladder
      const l = T(c - 0.12, b + 0.2, 0); g.fillStyle = "#d8dde2"; g.fillRect(Math.round(l[0]), Math.round(l[1]) - 4, 1, 5); g.fillRect(Math.round(l[0]) + 3, Math.round(l[1]) - 3, 1, 5);
    };
  });
})();

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
    hospital: { boxMargin: 9, floorPx: 22, roof: "flat", wall: "#eef1f5", roofC: "#a9b0bd" },
    school: { floorPx: 26, roof: "hip", roofPx: 20, wall: "#b8643e", roofC: "#56607a" },
    city_hall: { boxMargin: 9, floorPx: 24, roof: "flat", wall: "#e8e1cf", roofC: "#8d8f99" },
    bank: { boxMargin: 9, floorPx: 22, roof: "flat", wall: "#ddd6c4", roofC: "#7d808a" },
    // fascia: a band above the awning that carries the shop's name board (px)
    cafe: { floorPx: 24, roof: "flat", wall: "#f3e3d4", roofC: "#8a6a9a", awning: ["#8a4fa0", "#f6eef8"], sign: "CAFE", signBg: "#4a2058", fascia: 22 },
    diner: { floorPx: 26, roof: "flat", wall: "#dfe6ea", roofC: "#c23b3b", awning: ["#c23b3b", "#ffffff"], signBg: "#1e2230" },
    market: { floorPx: 26, roof: "flat", wall: "#eaf0e2", roofC: "#6a8a72", awning: ["#2f8c5a", "#ffffff"], sign: "MARKET", signBg: "#1a4a30", fascia: 22 },
    bakery: { floorPx: 24, roof: "gable", roofPx: 22, wall: "#f2dcae", roofC: "#8a5a2c", awning: ["#d18f2f", "#fff4dd"], sign: "BAKERY", signBg: "#5a2e10", fascia: 22 },
    corner_shop: { floorPx: 24, roof: "flat", wall: "#c98a5a", roofC: "#6d6f78", awning: ["#2f7fb8", "#ffffff"], sign: "GROCER", signBg: "#14304e", fascia: 22 },
    noodle_bar: { floorPx: 24, roof: "flat", wall: "#ecdcbc", roofC: "#7a2e2e", awning: ["#c0392b", "#f1c40f"], sign: "NOODLES", signBg: "#5a1010", fascia: 22 },
    arcade: { floorPx: 24, roof: "glass", wall: "#ddcfb2", roofC: "#8d8f99", sign: "ARCADE", signBg: "#24304a", fascia: 22 },
    factory: { boxMargin: 9, floorPx: 30, roof: "saw", wall: "#98a2a8", roofC: "#7a8086" },
    // v3 (view.md 3.8): the region's styles. extra: headroom above the roof top in px; awnings and signBgs go by variant.
    shop: { floorPx: 24, roof: "flat", wall: ["#efe2cc", "#dccbb0", "#c98a5a", "#e6e0d2", "#bccad4", "#d4ae94", "#e8e4d6", "#c8b89c"], roofC: "#6d6f78", fascia: 22,
      awnings: [["#2f7fb8", "#ffffff"], ["#c0392b", "#ffffff"], ["#2f8c5a", "#ffffff"], ["#d18f2f", "#fff4dd"], ["#8a4fa0", "#f6eef8"], ["#e2603a", "#fff0e0"], ["#3a5a8a", "#e8eef8"], ["#4a4a52", "#f2f2f2"]],
      signBgs: ["#14304e", "#5a1010", "#1a4a30", "#5a2e10", "#4a2058", "#6a2a10", "#1e2a4a", "#2a2a30"] },
    restaurant: { floorPx: 24, roof: "flat", wall: ["#ecdcbc", "#f3e3d4", "#e0c8a8", "#d8e0e4", "#f0d8c8", "#e8e0c8", "#d4b898", "#e4d4c4"], roofC: "#7a2e2e", fascia: 22,
      awnings: [["#c0392b", "#f1c40f"], ["#2a2a30", "#e8e8e8"], ["#8a3a1a", "#f6e0c0"], ["#2f8c5a", "#f6d24a"], ["#d18f2f", "#5a1a10"], ["#3a2a5a", "#e8dcf0"], ["#c23b3b", "#ffffff"], ["#7a2e2e", "#f1c40f"]],
      signBgs: ["#5a1010", "#1e1e24", "#4a2410", "#1a4a30", "#5a2e10", "#2a1a40", "#1e2230", "#3a1010"] },
    row_houses: { floorPx: 24, roof: "gable", roofPx: 24, extra: 16 },
    warehouse: { floorPx: 30, roof: "gable", roofPx: 14, wall: ["#a8b0b4", "#b8a890", "#8e9aa4", "#c0b8a8", "#9aa898"], roofC: "#7a8086", extra: 6 },
    station: { floorPx: 30, roof: "flat", wall: "#d8cdb8", roofC: "#5a6470", sign: "STATION", signBg: "#1e3a6a", extra: 30, crown: 0.35, sideMargin: 0.1 },
    residential_tower: { floorPx: 20, roof: "flat", wall: ["#a8573f", "#9a6347", "#b06a4a", "#8a5a48", "#c08868", "#b8a088"], roofC: "#6d6f78", extra: 30 },
    hotel: { floorPx: 20, roof: "flat", wall: "#e8dcc4", roofC: "#7d808a", sign: "HOTEL", signBg: "#5a1a2a", extra: 36 },
    library: { floorPx: 24, roof: "flat", wall: "#d8cdb4", roofC: "#7d808a", sign: "LIBRARY" },
    police: { floorPx: 24, roof: "flat", wall: "#c8ccd2", roofC: "#5a6070", sign: "POLICE", signBg: "#1e3a7a", extra: 20 },
    fire_station: { floorPx: 26, roof: "flat", wall: "#b0503a", roofC: "#5a5a60", sign: "FIRE STATION", signBg: "#8a1a14", extra: 44 },
    cinema: { floorPx: 26, roof: "flat", wall: "#4a4058", roofC: "#4a4a54", sign: "CINEMA", signBg: "#c8283a", extra: 24 },
    mall: { floorPx: 26, roof: "flat", wall: "#dcd6ca", roofC: "#8d8f99", sign: "MALL", signBg: "#2a5a8a", extra: 16 },
    clubhouse: { floorPx: 22, roof: "gable", roofPx: 22, wall: "#efe6d2", roofC: "#4f6b4a", sign: "CLUBHOUSE", signBg: "#2a4a2a", extra: 16 },
    stadium: { floorPx: 16, roof: "open", wall: "#c8c4bc", roofC: "#8a8a92", extra: 52 },
  };
  CV.STYLE = STYLE;
  CV.FLOORS = { house: 1, big_house: 2, apartments: 3, tower: 4, hospital: 3, school: 2, city_hall: 3, bank: 3, cafe: 2,
    diner: 1, market: 1, bakery: 1, corner_shop: 1, noodle_bar: 2, arcade: 2, factory: 2, park: 0,
    shop: 2, restaurant: 2, row_houses: 2, warehouse: 1, station: 1, residential_tower: 12, hotel: 12, library: 2,
    police: 2, fire_station: 2, cinema: 2, mall: 2, clubhouse: 1, stadium: 3 };
  CV.hasStyle = style => Object.prototype.hasOwnProperty.call(STYLE, style);

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

  // --- the v3 sprite API (view.md 4.5) ----------------------------------------------------------------
  // A place with a variant shares its sprite with every place of the same key: it is drawn once at the canonical
  // origin with id = sid = style + "#" + variant, and sid replaces p.id in every hash. Millbrook's places keep
  // variant null, their id in the key and in-place drawing, so v2's pixels do not change for them.
  const MILLBROOK = [0, 0, 80, 50];
  CV.MILLBROOK = MILLBROOK;
  CV.variantOf = function (p) {
    if (p.variant != null) return (p.variant | 0) % 8;
    const id = String(p.id == null ? "" : p.id), pre = p.style + "#";
    if (id.startsWith(pre) && /^\d+$/.test(id.slice(pre.length))) return (+id.slice(pre.length)) % 8; // a canonical copy
    if (p.x + p.w <= MILLBROOK[2] && p.y + p.h <= MILLBROOK[3] && p.x >= MILLBROOK[0] && p.y >= MILLBROOK[1]) return null;
    return hash(id) % 8;
  };
  CV.sidOf = p => { const v = CV.variantOf(p); return v == null ? String(p.id) : p.style + "#" + v; };
  // The canonical copy of a keyed place (x = y = 0, entry relative, id = sid); a Millbrook place is its own.
  CV.canonPlace = function (p) {
    const v = CV.variantOf(p);
    if (v == null) return p;
    return Object.assign({}, p, { id: p.style + "#" + v, variant: v, x: 0, y: 0, entry: p.entry ? [p.entry[0] - p.x, p.entry[1] - p.y] : null });
  };
  // Shop and restaurant fascia boards, by variant.
  CV.SHOP_SIGNS = ["BOOKS", "SHOES", "PHARMACY", "HARDWARE", "FLOWERS", "TOYS", "BIKES", "RECORDS"];
  CV.FOOD_SIGNS = ["PIZZA", "SUSHI", "GRILL", "TACOS", "CURRY", "BISTRO", "BURGERS", "NOODLES"];
  CV.signTextOf = function (p) {
    const s = p.style;
    if (s === "apartments" || s === "residential_tower") return String(p.name || "").split(" ")[0].toUpperCase();
    if (s === "tower") return /brightline/i.test(p.name || "") ? "BRIGHTLINE" : "";
    if (s === "shop" || s === "restaurant") { const v = CV.variantOf(p); return (s === "shop" ? CV.SHOP_SIGNS : CV.FOOD_SIGNS)[(v == null ? hash(String(p.id)) : v) % 8]; }
    return "";
  };
  const lookSig = look => look ? [look.stage | 0, look.works ? 1 : 0, (look.units || []).map(u => (u.vacant ? "v" : "o") + (u.listing ? "l" : "")).join("")].join(":") : "-";
  CV.lookSig = lookSig;
  // style|w|h|floors|face|variant|lookSig|season|signText; a Millbrook place puts its id in the variant slot.
  CV.spriteKey = function (p, look, season) {
    const v = CV.variantOf(p);
    return [p.style, p.w, p.h, p.floors == null ? "" : p.floors, p.face == null ? "" : p.face, v == null ? String(p.id) : v, lookSig(look), season || "", CV.signTextOf(p)].join("|");
  };
  // Heights in world px (z): wall top, parapet, the sprite's headroom, the roof top and the label point.
  const V2_EXTRA = s => s === "factory" ? 96 : s === "city_hall" ? 70 : s === "tower" ? 62 : s === "apartments" ? 34 : s === "school" ? 26 : s === "diner" ? 30 : 16;
  function heights(p) {
    const st = STYLE[p.style] || STYLE.house;
    const floors = Math.max(1, p.floors || CV.FLOORS[p.style] || 1);
    const flatTop = st.roof === "flat" || st.roof === "glass" || st.roof === "saw";
    const H = floors * st.floorPx + (p.style === "house" ? 0 : 4) + (st.fascia || 0);
    const Hw = H + (flatTop ? 4 : 0);
    const extra = (st.roofPx || 0) + (typeof st.extra === "function" ? st.extra(floors) : st.extra != null ? st.extra : V2_EXTRA(p.style));
    const height = Hw + (st.roofPx || 0);
    const labelZ = height + (st.labelDz != null ? st.labelDz : p.style === "city_hall" ? 50 : p.style === "factory" ? 20 : 10);
    return { st, floors, flatTop, H, Hw, topZ: Hw + extra, height, labelZ };
  }
  CV._heights = heights;
  // The sprite's canvas rect in world px for a place drawn in place, through one projection.
  // A place with a variant (anything outside Millbrook) gets a box round its body rather than its lot: the
  // body plus BODY_MARGIN tiles (awnings, porches, eaves) and the roof, so the sprite is mostly opaque.
  // Millbrook's places (no variant) keep v2's lot box exactly.
  const BODY_MARGIN = 0.3;
  function boxOf(proj, p) {
    if (CV.variantOf(p) != null && !(p.x === 0 && p.y === 0 && String(p.id).indexOf("#") > 0)) {
      // the canonical copy's box, moved by whole pixels (as art.building moves its sprite)
      const b = boxOf(proj, CV.canonPlace(p)), o = proj.toWorld(p.x, p.y), z = proj.toWorld(0, 0);
      b.ox += o[0] - z[0]; b.oy += o[1] - z[1];
      return b;
    }
    const hh = heights(p);
    let fx0 = p.x - 0.25, fy0 = p.y - 0.25, fx1 = p.x + p.w + 0.25, fy1 = p.y + p.h + 0.25;
    const keyed = CV.variantOf(p) != null; // Millbrook (no variant) keeps v2's lot box, so its scaled blits stay v2's
    if (keyed) {
      const bd = CV.bodyOf(p), m = hh.st.boxMargin != null ? hh.st.boxMargin : BODY_MARGIN;
      // st.sideMargin: the margin on the sides that are not the front (the station's canopy is on its front only;
      // a front the projection does not show moves to its lit face, as drawStation does)
      const fs = proj.faces || [], front = fs.includes(p.face) || !fs.length ? p.face : fs[0];
      const ms = f => hh.st.sideMargin != null && front !== f ? hh.st.sideMargin : m;
      fx0 = Math.max(fx0, bd.x0 - ms("w")); fy0 = Math.max(fy0, bd.y0 - ms("n")); fx1 = Math.min(fx1, bd.x1 + ms("e")); fy1 = Math.min(fy1, bd.y1 + ms("s"));
    }
    let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
    const add = (a, b, z) => { const q = proj.toWorld(a, b, z); if (q[0] < bx0) bx0 = q[0]; if (q[0] > bx1) bx1 = q[0]; if (q[1] < by0) by0 = q[1]; if (q[1] > by1) by1 = q[1]; };
    // a pitched roof of a keyed place rises only along its ridge: the corners need the eaves, the mid-lines the top
    const ridge = keyed && (hh.st.roof === "gable" || hh.st.roof === "hip");
    // a keyed style with a crown (the station's clock turret) rises to topZ only over the crown, half-size st.crown tiles
    const crown = keyed && !ridge && hh.st.crown ? hh.st.crown : 0;
    for (const [a, b] of [[fx0, fy0], [fx1, fy0], [fx1, fy1], [fx0, fy1]]) { add(a, b, 0); add(a, b, ridge || crown ? hh.Hw + 10 : hh.topZ); }
    if (ridge) { const cx = (fx0 + fx1) / 2, cy = (fy0 + fy1) / 2; for (const [a, b] of [[fx0, cy], [fx1, cy], [cx, fy0], [cx, fy1]]) add(a, b, hh.topZ); }
    if (crown) { const bd = CV.bodyOf(p), cx = (bd.x0 + bd.x1) / 2, cy = (bd.y0 + bd.y1) / 2; for (const [a, b] of [[cx - crown, cy - crown], [cx + crown, cy - crown], [cx + crown, cy + crown], [cx - crown, cy + crown]]) add(a, b, hh.topZ); }
    bx0 -= 6; bx1 += 6; by0 -= 6; by1 += keyed ? 8 : 4; // keyed: room for steps and canopy posts in front (flat)
    const ox = Math.floor(bx0), oy = Math.floor(by0);
    return { ox, oy, w: Math.max(1, Math.ceil(Math.ceil(bx1) - ox)), h: Math.max(1, Math.ceil(Math.ceil(by1) - oy)), height: hh.height, labelZ: hh.labelZ };
  }
  CV._boxOf = boxOf;
  let lastProj = null;
  // Pure geometry; art.building takes its bounds from it. proj: the projection (default: the last art's, else iso).
  CV.spriteBox = (p, look, proj) => boxOf(proj || lastProj || (lastProj = CV.makeProj("iso", 256, 192, 0)), p);
  CV.heightOf = p => heights(p).height;
  const ROOF_KIND = { gable: "gable", hip: "hip", flat: "flat", glass: "flat", saw: "saw" };
  CV.paletteOf = function (p) {
    const st = STYLE[p.style] || STYLE.house, h0 = hash(CV.sidOf(p)), isHome = p.kind === "home";
    const wall = st.wall ? (Array.isArray(st.wall) ? st.wall[h0 % st.wall.length] : st.wall) : p.style === "big_house" ? VILLA_PAINT[h0 % VILLA_PAINT.length] : HOUSE_PAINT[h0 % HOUSE_PAINT.length];
    const roof = st.roofC || (p.style === "big_house" ? VILLA_ROOF[(h0 >>> 4) % VILLA_ROOF.length] : HOUSE_ROOF[(h0 >>> 4) % HOUSE_ROOF.length]);
    const trim = isHome ? ["#ffffff", "#f6efe0", "#ffffff", "#efe9dc"][(h0 >>> 8) % 4] : "#ffffff";
    return { wall, roof, roof_kind: STYLE[p.style] ? ROOF_KIND[st.roof] || "flat" : "gable", glass: st.glass || "#8cbfe4", trim };
  };

  CV._artParts.push(function (art) {
    const { P, faceFn, quad, top, boxAt, proj } = art;
    const FACES = proj.faces, LIT = FACES[0];
    const zk = proj.zk || 1;
    lastProj = proj;
    art.spriteBox = (p, look) => boxOf(proj, p);

    // --- windows, doors, signs, awnings ---------------------------------------------------------------
    // One window: frame, glass with a sky reflection, optional curtain, shutters, flower box, mullions,
    // and the neglect states (dirty, cracked, boarded). Lit-able glass goes into ctx.windows.
    function win(ctx, F, u0, u1, z0, z1, o) {
      const g = ctx.g, litFace = F.face === LIT;
      o = o || {};
      const fw = o.fw == null ? 0.025 : o.fw;
      const sw0 = o.shutters ? Math.min(0.08, (u1 - u0) * 0.32) : 0;
      if (ctx.spans) ctx.spans.push([u0 - fw - sw0 - 0.01, u1 + fw + sw0 + 0.01, z0 - 6, z1 + 2]);
      if (o.shutters && !o.boarded && o.state < 4) {
        const sc = o.shutters, sw = sw0;
        const drop = o.state === 3 ? 3 : 0;
        const ghost = q2 => poly(g, q2, mix(o.wallCol || "#ffffff", "#ffffff", litFace ? 0.4 : 0.2)); // unfaded paint where a shutter hung
        const scol = litFace ? sc : shade(sc, 0.8);
        // a shutter hanging from its top hinge only: the free edge swings out and drops, unfaded paint behind
        const hang = (ua, ub, dir) => {
          ghost(quad(F, ua, ub, z0, z1));
          const hu = dir > 0 ? ua : ub, fu = dir > 0 ? ub : ua, k = z1 - z0;
          poly(g, [F.at(hu, z1), F.at(fu + dir * 0.03, z1 - 3), F.at(fu + dir * 0.07, z0 - 4), F.at(hu + dir * 0.04, z0 - 1)], scol);
          poly(g, [F.at(hu, z1), F.at(hu + dir * 0.012, z1), F.at(hu + dir * 0.052, z0 - 1), F.at(hu + dir * 0.04, z0 - 1)], shade(sc, 0.62));
          if (k > 6) poly(g, quad(F, Math.min(hu, hu + dir * 0.03), Math.max(hu, hu + dir * 0.03), z1 - 2, z1), "#2a2420"); // the one hinge left
        };
        if (o.noShutter === "l") ghost(quad(F, u0 - fw - sw, u0 - fw, z0, z1));
        else if (o.hang === "l") hang(u0 - fw - sw, u0 - fw, -1);
        else {
          poly(g, quad(F, u0 - fw - sw, u0 - fw, z0, z1), scol);
          poly(g, quad(F, u0 - fw - sw, u0 - fw - sw + 0.012, z0, z1), shade(sc, 0.7));
        }
        if (o.noShutter === "r") ghost(quad(F, u1 + fw, u1 + fw + sw, z0, z1));
        else if (o.hang === "r") hang(u1 + fw, u1 + fw + sw, 1);
        else if (!(o.state === 3 && o.idx % 2)) poly(g, [F.at(u1 + fw, z0 - drop), F.at(u1 + fw + sw, z0 - drop), F.at(u1 + fw + sw, z1 - drop), F.at(u1 + fw, z1)], scol);
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
      if (ctx.spans) ctx.spans.push([u0 - 0.04, u1 + 0.04, 0, h + 3, "door"]);
      if (o.frame) poly(g, quad(F, u0 - 0.03, u1 + 0.03, 0, h + 2), shade(o.frame, k));
      poly(g, quad(F, u0, u1, 0, h), shade(o.color || "#6b4226", k));
      if (o.glazed) {
        poly(g, quad(F, u0 + 0.025, u1 - 0.025, 2, h - 2), shade("#7fb0d8", k));
        poly(g, quad(F, uc - 0.012, uc + 0.012, 0, h), shade(o.color || "#3a4a5a", k));
        poly(g, quad(F, u0 + 0.025, u1 - 0.025, h - 5, h - 2), shade("#b8dcf2", k));
        if (!o.boarded) ctx.windows.push(quad(F, u0 + 0.025, u1 - 0.025, 2, h - 2));
      } else {
        poly(g, quad(F, u0 + 0.03, u1 - 0.03, h - 6, h - 3), shade(mix(o.color || "#6b4226", "#000000", 0.25), k));
        poly(g, quad(F, u1 - 0.06, u1 - 0.045, h * 0.45, h * 0.45 + 2), "#e3b54a");
      }
      if (o.boarded) { poly(g, quad(F, u0 - 0.03, u1 + 0.03, 5, 8), "#a8743a"); poly(g, quad(F, u0 - 0.03, u1 + 0.03, h - 8, h - 5), "#a8743a"); poly(g, [F.at(u0, 2), F.at(u0 + 0.05, 2), F.at(u1, h - 2), F.at(u1 - 0.05, h - 2)], "#b8844a"); }
      if (o.step) { const r = F.rect(u0 - 0.06, u1 + 0.06, 0, 0.1); boxAt(g, r[0], r[1], r[2], r[3], 0, 2, "#c8c2b4"); }
    }
    // Pixel-font sign on a wall, centred on (uc, z). The board follows the wall as a clean 2:1 pixel
    // staircase; each glyph stands upright and drops as a whole to the board line under it, so no stroke
    // is ever split (a sheared bitmap tears letters apart: "EBECH" for BEECH). o.border: the 1-px frame.
    function wallSign(ctx, F, text, uc, z, fg, bg, scale, o) {
      o = o || {};
      const s = scale || 1, g = ctx.g;
      const tw = CV.textWidth(text) * s, w = tw + 6 * s, h = 9 * s;
      const a = F.at(uc, z), b = F.at(uc + 1, z);
      const slope = Math.abs(b[0] - a[0]) < 1e-6 ? 0 : (b[1] - a[1]) / (b[0] - a[0]);
      const cx = Math.round(a[0]), cy = a[1], x0 = cx - Math.round(w / 2);
      const yAt = x => cy + (x - cx) * slope;
      const band = (xa, xb, t, bt) => [[xa, yAt(xa) + t], [xb, yAt(xb) + t], [xb, yAt(xb) + bt], [xa, yAt(xa) + bt]];
      if (bg) {
        poly(g, band(x0 - 1, x0 + w + 1, -h / 2 - 1, h / 2 + 1), o.border || shade(bg, 0.6));
        poly(g, band(x0, x0 + w, -h / 2, h / 2), bg);
        if (o.shine) poly(g, band(x0, x0 + w, -h / 2, -h / 2 + 1), shade(bg, 1.25));
      }
      let gx = x0 + 3 * s;
      for (const ch of String(text).toUpperCase()) {
        const gw = CV.textWidth(ch) * s;
        if (ch !== " ") CV.pixelText(g, ch, gx, Math.round(yAt(gx + gw / 2) - h / 2) + 2 * s, fg, s);
        gx += gw + s;
      }
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
    }
    // Dirt splashed up the foot of a wall: a band about 3 px tall with a ragged top (from stage 1), the
    // first neglect cue that does not depend on the paint colour.
    function baseGrime(ctx, F, col, zb, stage) {
      const g = ctx.g, R = rng(ctx.h0 + F.face.charCodeAt(0) * 11 + 7);
      const c = mix(col, "#4a3c2a", 0.28 + 0.07 * stage), c2 = mix(col, "#4a3c2a", 0.16 + 0.05 * stage);
      const step = 0.06;
      for (let u = 0; u < F.len - 1e-6; u += step) {
        const top = zb + 2 + Math.floor(R() * 2) + (stage >= 3 ? 1 : 0), u1 = Math.min(F.len, u + step);
        poly(g, quad(F, u, u1, zb, top), c);
        if (R() < 0.45) poly(g, quad(F, u, u1, top, top + 1 + Math.floor(R() * 2)), c2); // splashes
      }
    }
    // Water stains under the gutter or coping of a flat-roofed block: dark drips from the top (from stage 1).
    function copingStains(ctx, F, H, col, stage) {
      const g = ctx.g, R = rng(ctx.h0 + F.face.charCodeAt(0) * 17 + 3);
      poly(g, quad(F, 0, F.len, H - 3, H), shade(col, 0.82));
      const n = Math.round(F.len * (1.6 + stage * 0.8));
      for (let i = 0; i < n; i++) {
        const u = 0.05 + R() * (F.len - 0.12), w = 0.04 + R() * 0.06, l = 5 + R() * (6 + stage * 4);
        poly(g, quad(F, u, u + w, H - 3 - l, H - 3), shade(col, 0.74));
        poly(g, quad(F, u + w * 0.35, u + w * 0.65, H - 6 - l, H - 3 - l), shade(col, 0.8));
      }
    }
    // A spray-paint tag: two or three irregular strokes, 1-2 px wide, in one bright colour with a dark
    // outline, about 0.3 tiles wide at height zc, on a free stretch of wall at least 0.15 tiles from a door.
    // Returns false when this face has no room (the caller then tries the next face).
    function tag(ctx, F, zc, seed) {
      const g = ctx.g, R = rng(seed), wdt = 0.36, hz = 5;
      const spans = ctx.spans || [];
      const free = u => u > 0.08 && u + wdt < F.len - 0.08 && !spans.some(s => {
        const m = s[4] === "door" ? 0.15 : 0.05;
        return u < s[1] + m && u + wdt > s[0] - m && zc - hz * 1.5 - 1 < s[3] && zc + hz + 1 > s[2];
      });
      const ok = [];
      for (let u = 0.08; u + wdt < F.len - 0.08; u += 0.02) if (free(u)) ok.push(u);
      if (!ok.length) return false;
      const u0 = ok[Math.floor(R() * ok.length)];
      const col = ["#ff3ad0", "#3af06a", "#3ad8ff", "#ffde2a", "#ff7a2a"][seed % 5];
      // two letter-ish strokes and, sometimes, an underline swoosh, each jittered a little
      const strokes = [
        [[0.02, 0.7], [0.12, -0.9], [0.24, -0.4], [0.14, 0.2], [0.34, 0.85]],
        [[0.5, 0.85], [0.56, -0.9], [0.8, -0.55], [0.86, 0.15], [0.6, 0.45], [0.98, 0.9]],
        [[0.0, 1.45], [0.45, 1.2], [1.0, 1.4]],
      ].slice(0, (seed >> 3) % 2 ? 3 : 2).map(st => st.map(([a, b]) => [a + (R() - 0.5) * 0.06, b + (R() - 0.5) * 0.25]));
      const pts = new Map();
      for (const st of strokes) for (let k = 0; k + 1 < st.length; k++) {
        const p = F.at(u0 + st[k][0] * wdt, zc - st[k][1] * hz), q = F.at(u0 + st[k + 1][0] * wdt, zc - st[k + 1][1] * hz);
        const n = Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) * 2) + 1;
        for (let i = 0; i <= n; i++) { const x = Math.round(p[0] + (q[0] - p[0]) * i / n), y = Math.round(p[1] + (q[1] - p[1]) * i / n); pts.set(y * 8192 + x, [x, y]); }
      }
      g.fillStyle = "#1c1620"; // a 1-px dark outline round the paint (a plus shape, so strokes keep their gaps)
      for (const [x, y] of pts.values()) { g.fillRect(x - 1, y, 3, 1); g.fillRect(x, y - 1, 1, 3); }
      g.fillStyle = col;
      for (const [x, y] of pts.values()) g.fillRect(x, y, 1, 1);
      return true;
    }

    // --- roofs -------------------------------------------------------------------------------------------
    // Pitched roof (gable or hip) over the body. Faces turned away first, then gable walls, then the
    // slopes facing the camera; shingle rows, ridge cap, neglect (odd shingles, felt patches, holes, a
    // sagging ridge, a loose gutter, icicles in winter). Top-down: every slope faces up, so both slopes of a
    // ridge show (lit and 0.8) with their shingles and damage.
    function pitched(ctx, kind, R, opts) {
      opts = opts || {};
      const g = ctx.g, { x0, y0, x1, y1 } = ctx;
      const H = ctx.Hw, o = opts.o == null ? 0.13 : opts.o;
      const snow = CV.SEASON[ctx.season] && CV.SEASON[ctx.season].snow;
      const roofC = ctx.roofC, flat = proj.kind === "flat";
      const lit = snow ? "#f4f8fa" : roofC, dark = snow ? "#d2dce2" : shade(roofC, flat ? 0.8 : 0.76), back = snow ? "#c4ced6" : shade(roofC, 0.58);
      const alongX = opts.alongX != null ? opts.alongX : (x1 - x0) >= (y1 - y0);
      const ym = (y0 + y1) / 2, xm = (x0 + x1) / 2;
      const r = kind === "hip" ? Math.min(x1 - x0, y1 - y0) / 2 : 0;
      const sag = ctx.isHome && ctx.stage >= 4 ? 3 : 0; // a derelict roof's ridge dips at mid-span
      const faces = [];
      const F = (pts, n, gable, mid) => faces.push({ pts, n, gable, mid });
      if (alongX) {
        const mid = [xm, ym, H + R - sag];
        F([[x0 - o, y1 + o, H], [x1 + o, y1 + o, H], [x1 + o - r, ym, H + R], [x0 - o + r, ym, H + R]], "s", false, mid);
        F([[x0 - o, y0 - o, H], [x1 + o, y0 - o, H], [x1 + o - r, ym, H + R], [x0 - o + r, ym, H + R]], "n", false, mid);
        if (r) { F([[x1 + o, y0 - o, H], [x1 + o, y1 + o, H], [x1 + o - r, ym, H + R]], "e"); F([[x0 - o, y0 - o, H], [x0 - o, y1 + o, H], [x0 - o + r, ym, H + R]], "w"); }
        else { F([[x1, y0, H], [x1, y1, H], [x1, ym, H + R]], "e", true); F([[x0, y0, H], [x0, y1, H], [x0, ym, H + R]], "w", true); }
      } else {
        const mid = [xm, ym, H + R - sag];
        F([[x1 + o, y0 - o, H], [x1 + o, y1 + o, H], [xm, y1 + o - r, H + R], [xm, y0 - o + r, H + R]], "e", false, mid);
        F([[x0 - o, y0 - o, H], [x0 - o, y1 + o, H], [xm, y1 + o - r, H + R], [xm, y0 - o + r, H + R]], "w", false, mid);
        if (r) { F([[x0 - o, y1 + o, H], [x1 + o, y1 + o, H], [xm, y1 + o - r, H + R]], "s"); F([[x0 - o, y0 - o, H], [x1 + o, y0 - o, H], [xm, y0 - o + r, H + R]], "n"); }
        else { F([[x0, y1, H], [x1, y1, H], [xm, y1, H + R]], "s", true); F([[x0, y0, H], [x1, y0, H], [xm, y0, H + R]], "n", true); }
      }
      // from above (top-down) every slope shows; of the gable walls only the south one has any area
      const facing = f => flat ? (!f.gable || f.n === "s") : FACES.includes(f.n);
      const isFront = f => flat ? (f.n === "s" || f.n === "w") : f.n === LIT;
      // far gable walls, then far slopes, then near gable walls, then near slopes
      const rank = f => (facing(f) ? 2 : 0) + (f.gable ? 0 : 1);
      faces.sort((a, b) => rank(a) - rank(b));
      const wallLit = ctx.wall, wallDark = shade(ctx.wall, 0.8);
      const outline = f => {
        const pts = f.pts.map(q => P(q[0], q[1], q[2]));
        if (sag && f.mid && f.pts.length === 4) pts.splice(3, 0, P(f.mid[0], f.mid[1], f.mid[2]));
        return pts;
      };
      for (const f of faces) {
        const front = isFront(f);
        const col = f.gable ? (front ? wallLit : wallDark) : !facing(f) ? back : front ? lit : dark;
        poly(g, outline(f), col);
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
      // ridge cap (in two lengths when the ridge sags)
      const cap = (a, b, c) => { // a, b: ridge ends; c: colour
        const seg = (p, q) => alongX
          ? poly(g, [P(p[0], p[1] - 0.03, p[2] + 1), P(q[0], q[1] - 0.03, q[2] + 1), P(q[0], q[1] + 0.03, q[2] - 1), P(p[0], p[1] + 0.03, p[2] - 1)], c)
          : poly(g, [P(p[0] - 0.03, p[1], p[2] + 1), P(q[0] - 0.03, q[1], q[2] + 1), P(q[0] + 0.03, q[1], q[2] - 1), P(p[0] + 0.03, p[1], p[2] - 1)], c);
        if (sag) { const m = [xm, ym, H + R - sag]; seg(a, m); seg(m, b); } else seg(a, b);
      };
      if (alongX) cap([x0 - o + r, ym, H + R], [x1 + o - r, ym, H + R], snow ? "#ffffff" : shade(lit, 0.82));
      else cap([xm, y0 - o + r, H + R], [xm, y1 + o - r, H + R], snow ? "#ffffff" : shade(dark, 0.82));
      // eave line (fascia) under each slope facing the camera
      for (const f of faces) {
        if (f.gable || !facing(f) || (flat && f.n !== "s")) continue;
        const a = f.pts[0], b = f.pts[1];
        poly(g, [P(a[0], a[1], H), P(b[0], b[1], H), P(b[0], b[1], H - 2), P(a[0], a[1], H - 2)], shade(ctx.trim || "#ffffff", isFront(f) ? 0.95 : 0.8));
      }
      // neglect on the main slope facing the camera (the lit one if it is a slope, else the other); seen from
      // above, on both slopes of the ridge
      const slopes = faces.filter(f => !f.gable && facing(f) && f.pts.length === 4);
      const main = faces.find(f => !f.gable && isFront(f) && facing(f)) || slopes[0];
      if (ctx.isHome && ctx.stage >= 2) {
        for (const f of flat ? slopes : main ? [main] : []) roofDamage(ctx, f, R, isFront(f) ? roofC : shade(roofC, 0.76), snow, f === main ? 0 : 7);
      }
      if (snow && ctx.isHome && ctx.stage >= 2) for (const f of slopes) if (!flat || f.n === "s") icicles(ctx, f);
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
    // Rows of shingles on a slope (and staggered joints). From stage 1, sun-bleached courses and three or
    // four odd shingles: faded, or patched in a different colour.
    function shingles(ctx, f, R, col) {
      const g = ctx.g;
      const rows = Math.max(4, Math.round(R / 5));
      const line = shade(col, 0.86), hi = shade(col, 1.07);
      const len = slopeLen(f), ds = 0.02 / Math.max(0.2, len), step = 0.24 / Math.max(0.2, len);
      if (ctx.isHome && ctx.stage >= 1) { // sun-bleached, weathered courses
        const Rw = rng(ctx.h0 + f.n.charCodeAt(0) * 5);
        const pick = new Set([1 + Math.floor(Rw() * (rows - 2)), ctx.stage >= 2 ? 1 + Math.floor(Rw() * (rows - 2)) : -1, ctx.stage >= 2 ? Math.floor(Rw() * rows) : -1]);
        for (const k of pick) if (k >= 0) poly(g, [slopeAt(f, 0, k / rows), slopeAt(f, 1, k / rows), slopeAt(f, 1, (k + 1) / rows), slopeAt(f, 0, (k + 1) / rows)], mix(col, "#e6dccb", 0.3));
      }
      for (let k = 1; k < rows; k++) {
        const t = k / rows, tp = (k - 1) / rows;
        poly(g, [slopeAt(f, 0, t), slopeAt(f, 1, t), slopeAt(f, 1, t, 1.1), slopeAt(f, 0, t, 1.1)], line);
        if (f.pts.length !== 4) continue;
        const off = (k % 2) * step / 2;
        for (let s0 = step / 4 + off; s0 < 1 - step / 4; s0 += step) poly(g, [slopeAt(f, s0, t, 1), slopeAt(f, s0 + ds, t, 1), slopeAt(f, s0 + ds, tp, 1), slopeAt(f, s0, tp, 1)], hi);
      }
      if (ctx.isHome && ctx.stage >= 1 && f.pts.length === 4) { // odd shingles: one per pick, between two joints
        const Rm = rng(ctx.h0 * 3 + f.n.charCodeAt(0));
        const odd = [mix(col, "#e8dcc0", 0.5), mix(col, "#56606e", 0.55), mix(col, "#b8643a", 0.45), mix(col, "#2e2a26", 0.45)];
        const n = 3 + (ctx.h0 & 1);
        for (let i = 0; i < n; i++) {
          const k = 1 + Math.floor(Rm() * (rows - 1)), t = k / rows, tp = (k - 1) / rows;
          const off = (k % 2) * step / 2, j = Math.floor(Rm() * Math.max(1, Math.floor((1 - step) / step)));
          const sa = step / 4 + off + j * step + ds, sb = Math.min(0.99, sa + step - ds);
          if (sb <= sa) continue;
          poly(g, [slopeAt(f, sa, tp, 1.1), slopeAt(f, sb, tp, 1.1), slopeAt(f, sb, t), slopeAt(f, sa, t)], odd[(i + ctx.h0) % odd.length]);
        }
      }
    }
    // Damage on a roof slope by stage. Missing shingles bare the tar paper (lighter felt patches with nail
    // rows, not dark vents); from stage 3 there are ragged holes: an irregular blob over about two shingle
    // courses, off the shingle grid, with a pale broken rim, the dark loft inside and 1-px rafters across it.
    // Under snow the holes and bare patches are dark gaps in the white. From stage 3 the gutter hangs loose.
    function roofDamage(ctx, f, R, lit, snow, seed) {
      const g = ctx.g, stage = ctx.stage;
      const Rn = rng(ctx.h0 + 17 + (seed || 0));
      const len = Math.max(0.5, slopeLen(f));
      const rows = Math.max(4, Math.round(R / 5));
      const on = (s0, t, w, d) => [slopeAt(f, s0, t), slopeAt(f, s0 + w, t), slopeAt(f, s0 + w, t + d), slopeAt(f, s0, t + d)];
      const felt = snow ? "#3a3430" : mix(lit, "#7a6a58", 0.6);
      const nMiss = stage === 2 ? 5 : 4;
      for (let i = 0; i < nMiss; i++) {
        const k = 1 + Math.floor(Rn() * (rows - 2)), t = k / rows, d = 1 / rows;
        const s0 = 0.05 + Rn() * 0.8, w = (0.16 + Rn() * 0.18) / len;
        poly(g, on(s0, t, w, d), felt);
        poly(g, on(s0, t + d * 0.78, w, d * 0.22), shade(felt, 0.8)); // the course above throws a thin shadow
        if (snow) { poly(g, on(s0, t + d, w, 0.03), "#ffffff"); continue; }
        for (let s = s0 + 0.05 / len; s < s0 + w - 0.03 / len; s += 0.1 / len) { const p = slopeAt(f, s, t + d * 0.4); g.fillStyle = shade(felt, 0.84); g.fillRect(Math.round(p[0]), Math.round(p[1]), 1, 1); }
      }
      if (stage >= 3) {
        const A = slopeAt(f, 0, 0.5), B = slopeAt(f, 1, 0.5), eavePx = Math.max(1, Math.hypot(B[0] - A[0], B[1] - A[1]));
        const C = slopeAt(f, 0.5, 0), D = slopeAt(f, 0.5, 1), upPx = Math.max(1, Math.hypot(D[0] - C[0], D[1] - C[1]));
        const holes = stage === 3 ? 2 : 3 + (ctx.h0 & 1);
        const rim = snow ? "#ffffff" : mix(lit, "#e8cfa0", 0.55), lip = snow ? "#c9d6de" : shade(lit, 0.62);
        const hole = new Map(); // pixel -> 1 loft, 2 rafter
        const placed = [];
        for (let i = 0; i < holes; i++) {
          let sc = 0, tc = 0;
          for (let tries = 0; tries < 12; tries++) { // spread the holes out
            sc = 0.14 + Rn() * 0.72; tc = 0.25 + Rn() * 0.45;
            if (placed.every(([a, b]) => Math.abs(a - sc) * len > 0.75 || Math.abs(b - tc) > 0.4)) break;
          }
          placed.push([sc, tc]);
          // on a hip slope the course shortens towards the ridge: size the hole by the length where it sits
          const rl = f.pts.length === 4 ? Math.hypot(f.pts[2][0] - f.pts[3][0], f.pts[2][1] - f.pts[3][1]) : 0;
          const ln = Math.max(0.5, len * (1 - tc) + rl * tc);
          const Al = slopeAt(f, 0, tc), Bl = slopeAt(f, 1, tc), rowPx = Math.max(1, Math.hypot(Bl[0] - Al[0], Bl[1] - Al[1]));
          // two or three overlapping lumps, each a five-cornered shape at uneven radii, so the outline is
          // ragged and lopsided rather than an oval
          const lumps = 2 + (stage === 4 ? 1 : 0) + (Rn() < 0.5 ? 1 : 0), L = [];
          const big = stage === 4 ? 1.25 : 1;
          for (let j = 0; j < lumps; j++) {
            const K = 5, cr = Array.from({ length: K }, () => 0.45 + Rn() * 0.8), rot = Rn() * 6.28;
            L.push({ ds: (Rn() - 0.5) * 0.3 * big / ln, dt: (Rn() - 0.5) * 0.8 / rows, ra: (0.09 + Rn() * 0.08) * big / ln, rb: (0.32 + Rn() * 0.3) * big / rows, cr, rot, K,
              lo2: (Math.min(...cr) * (1 - 1e-9)) ** 2, hi2: (Math.max(...cr) * (1 + 1e-9)) ** 2 });
          }
          const inside = (s, t) => L.some(l => {
            const a = (s - sc - l.ds) / l.ra, b = (t - tc - l.dt) / l.rb, r2 = a * a + b * b;
            if (r2 >= l.hi2) return false; // outside every radius of this lump (Math.hypot is slow)
            if (r2 < l.lo2) return true;
            const th = Math.atan2(b, a) + l.rot;
            const q = ((th / 6.2832) % 1 + 1) % 1 * l.K, k0 = Math.floor(q), fr = q - k0;
            return Math.hypot(a, b) < l.cr[k0 % l.K] * (1 - fr) + l.cr[(k0 + 1) % l.K] * fr;
          });
          // v2 sampled every 0.35 px; a keyed (region) place samples every 0.5 px, still at least once a pixel
          const step = ctx.variant == null ? 0.35 : 0.5;
          const dS = step / Math.min(eavePx, rowPx), dT = step / upPx, sR = 0.3 * big / ln, tR = 1.8 * big / rows;
          for (let s = sc - sR; s <= sc + sR; s += dS) for (let t = tc - tR; t <= tc + tR; t += dT) {
            if (s < 0.03 || s > 0.97 || t < 0.06 || t > 0.94) continue;
            const p = slopeAt(f, s, t), key = Math.round(p[1] - 0.5) * 8192 + Math.round(p[0] - 0.5);
            const along = s * ln, raf = !snow && Math.abs(along / 0.36 - Math.round(along / 0.36)) * 0.36 * rowPx / ln < 0.5;
            const was = hole.get(key);
            if (was === 2 || (was === 1 && !raf)) continue; // nothing to change here, whatever inside() says
            if (!inside(s, t)) continue;
            hole.set(key, raf ? 2 : 1);
          }
        }
        // 1-2 px notches: bite a few edge pixels away and chip a few more out of the shingles around
        const has = (x, y) => hole.has(y * 8192 + x);
        for (const key of [...hole.keys()]) {
          const x = key % 8192, y = Math.floor(key / 8192);
          const edge = !has(x - 1, y) || !has(x + 1, y) || !has(x, y - 1) || !has(x, y + 1);
          if (!edge) continue;
          const r = Rn();
          if (r < 0.12) hole.delete(key);
          else if (r < 0.24) hole.set((y + (Rn() < 0.5 ? -1 : 1)) * 8192 + x + (Rn() < 0.5 ? -1 : 1), 1);
        }
        const brk = Array.from({ length: 16 }, () => Rn() < 0.4);
        for (const [key, v] of hole) {
          const x = key % 8192, y = Math.floor(key / 8192);
          const top = !has(x, y - 1), top2 = top || !has(x, y - 2), bot = !has(x, y + 1);
          g.fillStyle = v === 2 ? (top2 ? "#4a3826" : "#7a5e40") : top2 ? "#0e0a08" : bot ? "#2e241c" : "#1a1411";
          g.fillRect(x, y, 1, 1);
          if (top && !brk[(x >> 1) & 15]) { g.fillStyle = rim; g.fillRect(x, y - 1, 1, 1); } // the cut deck edge, lit, broken
          if (bot && (x & 3)) { g.fillStyle = lip; g.fillRect(x, y + 1, 1, 1); } // the torn shingle edge below
        }
        // a loose gutter swinging down from one end
        const a = 0.05, b = Math.min(0.45, 1.0 / len);
        poly(g, [slopeAt(f, a, 0, -1), slopeAt(f, b, 0, -1), slopeAt(f, b, 0, -2), slopeAt(f, a, 0, -2)], "#5a5048");
        poly(g, [slopeAt(f, b, 0, -1), slopeAt(f, b + 0.08, 0, -9), slopeAt(f, b + 0.09, 0, -8), slopeAt(f, b + 0.01, 0, 0)], "#5a5048");
      }
    }
    // Winter on a neglected roof (stage 2+): the gutter sags along the eave and icicles hang from it.
    function icicles(ctx, f) {
      const g = ctx.g, R = rng(ctx.h0 + f.n.charCodeAt(0) * 29), sagPx = ctx.stage >= 3 ? 4 : 3;
      const A = slopeAt(f, 0, 0), B = slopeAt(f, 1, 0), px = Math.max(1, Math.hypot(B[0] - A[0], B[1] - A[1]));
      const drop = s => -2 - sagPx * Math.sin(Math.PI * Math.min(1, s * 1.15)); // the sag is worst a little past mid-span
      const cols = new Map();
      for (let s = 0; s <= 1; s += 0.4 / px) { // the gutter, 2 px deep, pixel by pixel so it never breaks up
        const p = slopeAt(f, s, 0, drop(s)), x = Math.round(p[0]), y = Math.round(p[1]);
        if (!cols.has(x)) cols.set(x, y);
      }
      for (const [x, y] of cols) { g.fillStyle = "#4e463e"; g.fillRect(x, y, 1, 2); g.fillStyle = "#8a8078"; g.fillRect(x, y, 1, 1); }
      const k = 6 + ctx.stage * 3, xs = [...cols.keys()];
      for (let i = 0; i < k; i++) {
        const x = xs[Math.floor((0.03 + R() * 0.94) * xs.length)], y = cols.get(x) + 2, l = 3 + Math.floor(R() * (3 + ctx.stage * 1.5));
        g.fillStyle = "#5e7484"; g.fillRect(x + 2, y, 1, Math.max(1, l - 2)); // its shadow on the wall
        g.fillStyle = "#f4fbff"; g.fillRect(x, y, 1, l);
        g.fillStyle = "#9cc4e0"; g.fillRect(x + 1, y, 1, Math.max(1, l - 2));
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
    // A home at stage 3 or 4 always has a boarded window on a wall facing the camera, the other one from its
    // door's where it can (PLAN decision 83): with the boarded door it reads even when the door faces away.
    const cueFace = ctx => FACES.find(f => f !== ctx.p.face) || FACES[0];
    const windowState = (ctx, i, face, n) => {
      const st = ctx.isHome ? ctx.stage : 0, s = hash(ctx.sid + ":" + face + ":" + i);
      return {
        state: st,
        boarded: ctx.isHome && ((st === 4 ? s % 4 !== 3 : st === 3 && s % 5 === 0) || (st >= 3 && i === 0 && face === cueFace(ctx))),
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
      let tagged = false;
      for (const f of FACES) {
        const F = faceFn(f, x0, y0, x1, y1), col = f === LIT ? ctx.wall : shade(ctx.wall, 0.8);
        ctx.spans = [];
        poly(g, quad(F, 0, F.len, 0, ctx.Hw), col);
        for (let z = 3; z < H - 2; z += 3) poly(g, quad(F, 0, F.len, z, z + 1), shade(col, 0.93)); // siding
        poly(g, quad(F, 0, F.len, 0, 3), shade(col, 0.66));
        poly(g, quad(F, 0, 0.05, 0, H), f === LIT ? ctx.trim : shade(ctx.trim, 0.82));
        poly(g, quad(F, F.len - 0.05, F.len, 0, H), f === LIT ? ctx.trim : shade(ctx.trim, 0.82));
        if (stage >= 1) { grime(ctx, F, H, stage, ctx.h0 + f.charCodeAt(0), col, "under"); gutterStreak(ctx, F, H, col); baseGrime(ctx, F, col, 3, stage); }
        const isDoor = f === ctx.p.face;
        const us = isDoor ? [F.len * 0.2, F.len * 0.8] : [F.len * 0.27, F.len * 0.73];
        us.forEach((uc, i) => {
          const ws = windowState(ctx, i, f, us.length);
          // worn: one shutter hangs from a single hinge; shabby: that one is gone and another hangs
          const lost = stage === 2 && f === LIT && i === 1 ? "r" : null;
          const hang = stage === 1 && f === LIT && i === 1 ? "r" : stage === 2 && f !== LIT && i === 0 ? "l" : null;
          win(ctx, F, uc - 0.14, uc + 0.14, 8, 19, Object.assign(ws, { frame: ctx.trim, curtain: CURTAIN[(ctx.h0 + i) % CURTAIN.length], both: true, shutters: SHUTTER[(ctx.h0 >>> 5) % SHUTTER.length], box: f === LIT, idx: i, sill: ctx.trim, mullion: true, noShutter: lost, hang, wallCol: col }));
        });
        for (let fl = 1; fl < ctx.floors; fl++) [F.len * 0.27, F.len * 0.73].forEach((uc, i) => { // upper floors (the region's two-floor houses)
          const ws = windowState(ctx, i + 2 * fl, f, 2 * ctx.floors);
          win(ctx, F, uc - 0.13, uc + 0.13, fl * ctx.st.floorPx + 7, fl * ctx.st.floorPx + 18, Object.assign(ws, { frame: ctx.trim, curtain: CURTAIN[(ctx.h0 + i + fl) % CURTAIN.length], mullion: true, sill: ctx.trim, idx: i + 2 * fl }));
        });
        if (isDoor) {
          const uc = F.len / 2;
          door(ctx, F, uc, 0.22, 18, { color: stage >= 3 ? "#6a5238" : DOOR[(ctx.h0 >>> 3) % DOOR.length], frame: ctx.trim, boarded: stage >= 3, step: true });
          // little porch roof over the door, and the porch light
          poly(g, [F.at(uc - 0.2, 22), F.at(uc + 0.2, 22), F.out(uc + 0.2, 19, 0.16), F.out(uc - 0.2, 19, 0.16)], shade(ctx.roofC, f === LIT ? 1 : 0.8));
          poly(g, [F.out(uc - 0.2, 19, 0.16), F.out(uc + 0.2, 19, 0.16), F.out(uc + 0.2, 18, 0.16), F.out(uc - 0.2, 18, 0.16)], shade(ctx.trim, 0.85));
          const lp = F.at(uc + 0.2, 14);
          g.fillStyle = "#2a2a2a"; g.fillRect(Math.round(lp[0]), Math.round(lp[1]) - 1, 2, 3);
          g.fillStyle = stage >= 3 ? "#555" : "#fff1b8"; g.fillRect(Math.round(lp[0]), Math.round(lp[1]), 2, 1);
          if (stage < 3) ctx.porch = F.at(uc + 0.2, 14);
        }
        if (stage >= 3) grime(ctx, F, H, stage, ctx.h0 + f.charCodeAt(0), col, "over");
        if (stage >= 4 && !tagged) tagged = tag(ctx, F, Math.round(H * 0.5), ctx.h0 >>> 2);
        poly(g, quad(F, 0, F.len, H - 3, H), "rgba(0,0,0,0.18)"); // eave shadow
      }
      ctx.spans = null;
      const roof = pitched(ctx, "gable", ctx.st.roofPx);
      const cx = roof.alongX ? x1 - 0.7 : (x0 + x1) / 2 - 0.4, cy = roof.alongX ? (y0 + y1) / 2 - 0.42 : y0 + 0.5;
      chimney(ctx, cx, cy, ctx.Hw + 8, ctx.Hw + ctx.st.roofPx + 6, stage >= 3 ? "#7a6a5a" : "#9a4a38");
    }

    function drawBigHouse(ctx) {
      const g = ctx.g, { x0, y0, x1, y1, stage, H } = ctx;
      const fh = ctx.st.floorPx;
      let tagged = false;
      for (const f of FACES) {
        const F = faceFn(f, x0, y0, x1, y1), col = f === LIT ? ctx.wall : shade(ctx.wall, 0.8);
        ctx.spans = [];
        poly(g, quad(F, 0, F.len, 0, ctx.Hw), col);
        poly(g, quad(F, 0, F.len, 0, 4), shade(col, 0.7));
        poly(g, quad(F, 0, F.len, fh + 1, fh + 3), shade(col, 1.06)); // string course
        poly(g, quad(F, 0, F.len, fh + 3, fh + 4), shade(col, 0.88));
        poly(g, quad(F, 0, 0.07, 0, H), shade(col, 1.06)); poly(g, quad(F, F.len - 0.07, F.len, 0, H), shade(col, 0.92)); // quoins
        if (stage >= 1) { grime(ctx, F, H, stage, ctx.h0 + f.charCodeAt(0), col, "under"); gutterStreak(ctx, F, H, col); baseGrime(ctx, F, col, 4, stage); }
        const isDoor = f === ctx.p.face;
        const doorU = isDoor ? Math.min(F.len - 0.4, Math.max(0.4, entryU(ctx, F))) : -9;
        const garageU = isDoor ? (doorU > F.len / 2 ? 0.75 : F.len - 0.75) : -9;
        if (isDoor) { ctx.spans.push([doorU - 0.36, doorU + 0.36, 0, fh + 14, "door"]); ctx.spans.push([garageU - 0.46, garageU + 0.46, 0, 20]); }
        const n = Math.max(2, Math.round(F.len * 1.15));
        for (let fl = 0; fl < 2; fl++) for (let i = 0; i < n; i++) {
          const uc = (i + 0.5) * F.len / n;
          if (fl === 0 && (Math.abs(uc - doorU) < 0.38 || Math.abs(uc - garageU) < 0.6)) continue;
          const ws = windowState(ctx, i + fl * n, f, n * 2);
          win(ctx, F, uc - 0.13, uc + 0.13, fl * fh + 7, fl * fh + 20, Object.assign(ws, { frame: "#ffffff", curtain: CURTAIN[(ctx.h0 + i + fl) % CURTAIN.length], mullion: true, sill: "#f2f2f2", idx: i + fl * n }));
          if (stage <= 2) poly(g, quad(F, uc - 0.16, uc + 0.16, fl * fh + 21, fl * fh + 23), f === LIT ? "#ffffff" : "#d8d8d8"); // lintel
        }
        if (isDoor) {
          door(ctx, F, doorU, 0.26, 19, { color: stage >= 3 ? "#5a4a38" : "#4a2a1a", frame: "#ffffff", boarded: stage >= 3, step: true });
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
        if (stage >= 4 && !tagged) tagged = tag(ctx, F, Math.round(H * 0.45), ctx.h0 >>> 2);
        poly(g, quad(F, 0, F.len, H - 3, H), "rgba(0,0,0,0.16)");
      }
      ctx.spans = null;
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
      const name = String(ctx.p.name || "").split(" ")[0].toUpperCase();
      let tagged = false;
      for (const f of FACES) {
        const F = faceFn(f, x0, y0, x1, y1), col = f === LIT ? ctx.wall : shade(ctx.wall, 0.8);
        ctx.spans = [];
        poly(g, quad(F, 0, F.len, 0, ctx.Hw), col);
        const R = rng(ctx.h0 + f.charCodeAt(0));
        for (let z = 2; z < H; z += 3) poly(g, quad(F, 0, F.len, z, z + 1), shade(col, 0.88)); // mortar courses
        for (let k = 0; k < F.len * 40; k++) { const u = R() * F.len, z = 3 * Math.floor(R() * (H / 3)) + 0; poly(g, quad(F, u, u + 0.06, z, z + 2), shade(col, R() < 0.5 ? 0.92 : 1.06)); }
        poly(g, quad(F, 0, F.len, 0, 4), "#7a7468");
        for (let fl = 1; fl < floors; fl++) poly(g, quad(F, 0, F.len, fl * fh, fl * fh + 2), f === LIT ? "#cfc8bb" : "#a8a296"); // floor bands
        poly(g, quad(F, 0, F.len, H, ctx.Hw), f === LIT ? "#cfc8bb" : "#a8a296");
        if (stage >= 1) {
          grime(ctx, F, H, Math.min(stage, 3), ctx.h0 + f.charCodeAt(0), col, "under");
          copingStains(ctx, F, H, col, stage); // water running off the coping
          baseGrime(ctx, F, col, 4, stage);
        }
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
        const per = 2;
        for (let fl = 0; fl < floors; fl++) {
          const slots = [];
          if (isDoor) { for (let k = 0; k < per; k++) { slots.push([F.len * (0.1 + k * 0.17), 0]); slots.push([F.len * (0.9 - k * 0.17), 1]); } }
          else { slots.push([F.len * 0.22, f === "e" ? 1 : 0]); slots.push([F.len * 0.5, f === "e" ? 1 : 0]); slots.push([F.len * 0.78, f === "e" ? 1 : 0]); }
          const crackAt = stage === 2 ? (ctx.h0 + fl * 3 + f.charCodeAt(0)) % slots.length : -1; // shabby: one cracked pane per floor
          slots.forEach(([uc, side], i) => {
            const u = unitOf(fl, side);
            const vacant = u ? u.vacant : false;
            const ws = windowState(ctx, i + fl * 5, f, 6);
            if (i === crackAt && !ws.boarded) ws.cracked = true;
            const z0 = fl * fh + 7, z1 = z0 + 11;
            poly(g, quad(F, uc - 0.17, uc + 0.17, z1 + 1, z1 + 3), f === LIT ? "#cfc8bb" : "#a8a296"); // lintel
            win(ctx, F, uc - 0.14, uc + 0.14, z0, z1, Object.assign(ws, { frame: "#e8e2d6", vacant, curtain: CURTAIN[(hash(ctx.sid + fl + side)) % CURTAIN.length], sill: "#cfc8bb", mullion: true, idx: i + fl * 5,
              box: stage === 0 && f === LIT && !vacant && (i + fl) % 2 === 0 })); // kept: window boxes in flower
            if (isDoor && fl >= 1 && i % 2 === 0) { // balcony under the outer window pair
              const r = F.rect(uc - 0.24, uc + 0.24, 0, 0.2);
              const hb = hash(ctx.sid + ":bal:" + fl + ":" + i);
              if (stage >= 1) { // rust bleeding from the rail fixings down the wall
                for (const [ru, k] of [[uc - 0.21, 0], [uc + 0.17, 1], [uc - 0.02, 2]]) {
                  if (k === 2 && stage < 2) continue;
                  const l = 7 + ((hb >>> (k * 3)) % 5) + stage * 2;
                  poly(g, quad(F, ru, ru + 0.03, fl * fh + 1 - l, fl * fh + 2), "rgba(150,74,26,0.85)");
                  poly(g, quad(F, ru + 0.012, ru + 0.03, fl * fh - l - 2, fl * fh + 2 - l), "rgba(150,74,26,0.55)");
                }
              }
              boxAt(g, r[0], r[1], r[2], r[3], fl * fh + 2, fl * fh + 4, stage >= 4 ? "#a8a090" : "#bdb6a8");
              if (stage >= 1) { const p = F.out(uc - 0.2, fl * fh + 2, 0.2); g.fillStyle = "#8a4a1e"; g.fillRect(Math.round(p[0]), Math.round(p[1]), 1, 2 + stage); }
              const rail = stage >= 3 ? "#5a4a3a" : stage >= 1 ? "#4a4440" : "#3e4450";
              const gone = stage >= 4 && hb % 3 === 0; // rail torn off
              const sag = stage >= 4 && !gone ? 3 : 0;
              if (!gone) {
                poly(g, [F.out(uc - 0.24, fl * fh + 10, 0.2), F.out(uc, fl * fh + 10 - sag, 0.2), F.out(uc, fl * fh + 11 - sag, 0.2), F.out(uc - 0.24, fl * fh + 11, 0.2)], rail);
                poly(g, [F.out(uc, fl * fh + 10 - sag, 0.2), F.out(uc + 0.24, fl * fh + 10, 0.2), F.out(uc + 0.24, fl * fh + 11, 0.2), F.out(uc, fl * fh + 11 - sag, 0.2)], rail);
                for (let k = 0; k <= 6; k++) {
                  if (stage >= 4 && (hb >>> k) % 3 === 0) continue; // broken balusters
                  const p = F.out(uc - 0.24 + k * 0.08, fl * fh + 4, 0.2); g.fillStyle = rail; g.fillRect(Math.round(p[0]), Math.round(p[1]) - 6 + (k > 1 && k < 5 ? Math.min(sag, 2) : 0), 1, 6 - (k > 1 && k < 5 ? Math.min(sag, 2) : 0));
                }
                if (stage >= 1) for (const k of [1, 5]) { const p = F.out(uc - 0.24 + k * 0.08, fl * fh + 4, 0.2); g.fillStyle = "#a8562a"; g.fillRect(Math.round(p[0]), Math.round(p[1]) - 3, 1, 2); } // rust on the rail
              } else { const p = F.out(uc + 0.2, fl * fh + 4, 0.2); g.fillStyle = rail; g.fillRect(Math.round(p[0]), Math.round(p[1]) - 6, 1, 6); }
              if (u && !u.vacant && stage <= 3 && hb % 2 === 0) { // a potted plant: from worn, some are dead; from shabby, all
                const p = F.out(uc + 0.14, fl * fh + 4, 0.1), dead = stage >= 2 || (stage === 1 && (hb >>> 3) % 3 !== 0);
                g.fillStyle = "#8a4a2a"; g.fillRect(Math.round(p[0]) - 1, Math.round(p[1]) - 3, 3, 3);
                if (dead) { g.fillStyle = "#7a6638"; g.fillRect(Math.round(p[0]) - 2, Math.round(p[1]) - 5, 1, 2); g.fillRect(Math.round(p[0]), Math.round(p[1]) - 6, 1, 3); g.fillRect(Math.round(p[0]) + 2, Math.round(p[1]) - 5, 1, 2); g.fillStyle = "#9a8448"; g.fillRect(Math.round(p[0]) - 1, Math.round(p[1]) - 4, 1, 1); }
                else { g.fillStyle = "#3f9a3a"; g.fillRect(Math.round(p[0]) - 2, Math.round(p[1]) - 7, 5, 4); g.fillStyle = "#5fba4a"; g.fillRect(Math.round(p[0]) - 1, Math.round(p[1]) - 7, 2, 2); if (stage === 0) { g.fillStyle = "#f05a7a"; g.fillRect(Math.round(p[0]) + 1, Math.round(p[1]) - 6, 1, 1); } }
              }
              if (u && u.vacant) { // a TO LET card tied to the rail
                const p = F.out(uc - 0.05, fl * fh + 11, 0.2), tw = CV.textWidth("LET"), x = Math.round(p[0]) - Math.ceil(tw / 2) - 1, y = Math.round(p[1]) - 2;
                g.fillStyle = "#9a5a10"; g.fillRect(x - 1, y - 1, tw + 4, 9);
                g.fillStyle = "#f2a12c"; g.fillRect(x, y, tw + 2, 7);
                CV.pixelText(g, "LET", x + 1, y + 1, "#1e1e1e");
              }
            }
          });
          if (isDoor && fl >= 1 && !(fl === 1 && name)) { // stairwell window (the name board covers the first one)
            win(ctx, F, mid - 0.07, mid + 0.07, fl * fh + 3, fl * fh + 14, { frame: "#e8e2d6", state: ctx.stage, dark: true, glow: true });
          }
        }
        if (isDoor) {
          door(ctx, F, mid, 0.34, 19, { color: "#3a4a5a", frame: "#cfc8bb", glazed: true, step: true, boarded: stage >= 3 });
          const r = F.rect(mid - 0.3, mid + 0.3, 0, 0.28);
          boxAt(g, r[0], r[1], r[2], r[3], 21, 23, stage >= 2 ? "#4e525c" : "#5a6070");
          if (name) wallSign(ctx, F, name, mid, 33, stage >= 3 ? "#c8bc98" : "#f6e7b8", "#2a2f3a", 2);
          ctx.spans.push([mid - 0.85, mid + 0.85, 21, 44]);
          ctx.spans.push([mid - 0.58, mid + 0.58, 0, 24, "door"]); // the canopy stands out from the wall
          ctx.porch = F.out(mid, 20, 0.2);
        }
        if (stage >= 3) grime(ctx, F, H, stage, ctx.h0 + f.charCodeAt(0), col, "over");
        if (stage >= 2 && !tagged) tagged = tag(ctx, F, Math.round(fh * 0.5), ctx.h0 >>> 2); // ground-floor tag from shabby
      }
      ctx.spans = null;
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
      const named = /brightline/i.test(ctx.p.name || ""), ch = named ? 22 : 14;
      boxAt(g, cx0, cy0, cx1, cy1, Hd, Hd + ch, "#5a6a80", "#4a5466");
      for (const f of FACES) { // louvres on the plant room (the company's board covers the lit side)
        const Fc = faceFn(f, cx0, cy0, cx1, cy1);
        if (named && f === LIT) continue;
        for (let u = 0.1; u < Fc.len - 0.1; u += 0.2) poly(g, quad(Fc, u, u + 0.1, Hd + 3, Hd + ch - 3), f === LIT ? "#4a5a70" : "#3e4c60");
      }
      if (named) { const Fc = faceFn(LIT, cx0, cy0, cx1, cy1); wallSign(ctx, Fc, "BRIGHTLINE", Fc.len / 2, Hd + 11, "#bfe6ff", "#1e2a3c", 2, { border: "#7aa8d0" }); }
      const m = P((x0 + x1) / 2 + 0.6, (y0 + y1) / 2, Hd + ch);
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

    function drawCivic(ctx) { // city hall and bank: stone, a columned portico, cornice
      const g = ctx.g, { x0, y0, x1, y1, H } = ctx;
      const fh = ctx.st.floorPx, floors = ctx.floors, bank = ctx.p.style === "bank";
      const top2 = Math.min(floors, 2) * fh, ent = 15; // portico height; entablature depth (px)
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
          if (litF && fl * fh + 5 < top2 + ent + 2) continue; // behind the portico and its entablature
          win(ctx, F, uc - 0.12, uc + 0.12, fl * fh + 5, fl * fh + fh - 4, { frame: shade(ctx.wall, 1.1), mullion: true, sill: shade(ctx.wall, 1.1), state: 0, idx: i });
          poly(g, [F.at(uc - 0.16, fl * fh + fh - 3), F.at(uc + 0.16, fl * fh + fh - 3), F.at(uc, fl * fh + fh)], litF ? shade(ctx.wall, 1.12) : shade(ctx.wall, 0.95)); // pediment cap
        }
        if (litF) { // a columned portico across the lower floors: a deep shaded recess with tall arched
          // windows in the bays and a tall glazed door in the middle one, on a two-step plinth
          const cols = Math.max(4, Math.round(F.len * 1.2));
          const cu = i => 0.2 + (F.len - 0.4) * i / cols;
          const recess = shade(ctx.wall, 0.5), stone = shade(ctx.wall, 1.08);
          poly(g, quad(F, 0.12, F.len - 0.12, 0, top2 + 2), recess);
          poly(g, quad(F, 0.12, F.len - 0.12, top2 - 3, top2 + 2), shade(ctx.wall, 0.4)); // shadow under the entablature
          const midBay = Math.floor((cols - 1) / 2);
          for (let b = 0; b < cols; b++) {
            const a0 = cu(b) + 0.07, a1 = cu(b + 1) - 0.07, am = (a0 + a1) / 2, bw = (a1 - a0) / 2;
            if (a1 - a0 < 0.12) continue;
            if (b === midBay) { // tall glazed double door with a fanlight
              const dz = top2 - 21, w = Math.min(bw, 0.2);
              poly(g, quad(F, am - w - 0.03, am + w + 0.03, 4, dz + 9), stone);
              poly(g, quad(F, am - w, am + w, 4, dz), "#2c3a48");
              poly(g, quad(F, am - w + 0.03, am - 0.015, 6, dz - 2), "#7fb0d8"); poly(g, quad(F, am + 0.015, am + w - 0.03, 6, dz - 2), "#7fb0d8");
              poly(g, quad(F, am - w + 0.03, am - 0.015, dz - 6, dz - 2), "#b8dcf2"); poly(g, quad(F, am + 0.015, am + w - 0.03, dz - 6, dz - 2), "#b8dcf2");
              ctx.windows.push(quad(F, am - w + 0.03, am + w - 0.03, 6, dz - 2));
              for (const [hw, z0] of [[w, dz + 1], [w * 0.75, dz + 4], [w * 0.4, dz + 6]]) poly(g, quad(F, am - hw, am + hw, z0, z0 + 3), "#8cbfe4"); // fanlight
              poly(g, quad(F, am - 0.01, am + 0.01, dz + 1, dz + 8), stone);
              continue;
            }
            // tall arched window: stone surround, glass, a transom and a centre mullion, a stepped arch
            const z0 = 9, z1 = top2 - 19, w = Math.min(bw, 0.15);
            poly(g, quad(F, am - w - 0.03, am + w + 0.03, z0 - 2, z1 + 1), stone);
            for (const [hw, za] of [[w + 0.03, z1 + 1], [w * 0.75 + 0.03, z1 + 4], [w * 0.4 + 0.03, z1 + 6]]) poly(g, quad(F, am - hw, am + hw, za, za + 3), stone);
            poly(g, quad(F, am - w, am + w, z0, z1), "#5d8fc0");
            for (const [hw, za] of [[w, z1], [w * 0.75, z1 + 3], [w * 0.4, z1 + 5]]) poly(g, quad(F, am - hw, am + hw, za, za + 3), "#8cbfe4");
            poly(g, quad(F, am - w, am + w, z1 - 4, z1), "#a8d4f0");
            poly(g, quad(F, am - 0.01, am + 0.01, z0, z1 + 5), stone);
            poly(g, quad(F, am - w, am + w, z0 + Math.round((z1 - z0) * 0.62), z0 + Math.round((z1 - z0) * 0.62) + 1), stone);
            ctx.windows.push(quad(F, am - w, am + w, z0, z1));
          }
          // plinth: two steps across the full width, then the columns standing on the upper one
          let r = F.rect(0.04, F.len - 0.04, 0, 0.44); boxAt(g, r[0], r[1], r[2], r[3], 0, 2, "#c8c2b2");
          r = F.rect(0.08, F.len - 0.08, 0, 0.32); boxAt(g, r[0], r[1], r[2], r[3], 2, 4, "#d8d2c2");
          for (let i = 0; i <= cols; i++) column(ctx, F, cu(i), 0.22, 4, top2, "#f6f2e6");
          r = F.rect(0.1, F.len - 0.1, 0, 0.26);
          boxAt(g, r[0], r[1], r[2], r[3], top2, top2 + ent, "#f0ead8");
          const Fo = { face: F.face, at: (u, z) => F.out(u, z, 0.26) };
          poly(g, quad(Fo, 0.1, F.len - 0.1, top2 + 1, top2 + 2), "#d8d0bc");
          wallSign(ctx, Fo, bank ? "SAVINGS BANK" : ctx.p.style === "library" ? "PUBLIC LIBRARY" : "CITY HALL", F.len / 2, top2 + Math.round(ent / 2) + 1, "#3a3020", null, 2);
          // a pediment over the middle of the facade
          let zw = Infinity;
          for (let fl = 0; fl < floors; fl++) if (fl * fh + 5 >= top2 + ent + 2) { zw = fl * fh + 5; break; }
          const pz = top2 + ent, ph = Math.min(14, H - 3 - pz, zw - 3 - pz);
          if (ph >= 6) {
            poly(g, [F.at(F.len * 0.22, pz), F.at(F.len * 0.78, pz), F.at(F.len * 0.5, pz + ph)], stone);
            poly(g, [F.at(F.len * 0.28, pz + 1), F.at(F.len * 0.72, pz + 1), F.at(F.len * 0.5, pz + ph - 3)], shade(ctx.wall, 0.86));
          }
        }
        poly(g, quad(F, 0, F.len, H - 2, ctx.Hw), shade(col, 1.12)); // cornice
        if (f === ctx.p.face && !litF) door(ctx, F, entryU(ctx, F), 0.3, 20, { color: "#4a3420", frame: shade(ctx.wall, 1.1) });
      }
      flatRoof(ctx, ctx.roofC, { cope: shade(ctx.wall, 1.15) });
      const Hd = ctx.H;
      if (!bank && ctx.p.style !== "library") { // clock tower with a copper dome
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
      // ground floor, then (shops with a name board) a fascia band, then the upper floors
      const gf = fh + (st.fascia || 0), flZ = fl => fl === 0 ? 0 : gf + (fl - 1) * fh;
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
        const top = st.fascia ? fh - 7 : fh - 9; // shop window and door head
        if (isFront) {
          const du = FACES.includes(ctx.p.face) ? entryU(ctx, F) : F.len / 2;
          const panes = Math.max(2, Math.round(F.len * 1.3));
          for (let i = 0; i < panes; i++) {
            const a = 0.1 + (F.len - 0.2) * i / panes, b = 0.1 + (F.len - 0.2) * (i + 1) / panes - 0.06;
            if (Math.abs((a + b) / 2 - du) < 0.3) continue;
            win(ctx, F, a, b, 4, top, { frame: s === "diner" ? "#d8dee6" : "#3a3a3a", state: 0, idx: i });
            if (s === "bakery" || s === "market" || s === "corner_shop") { const p = F.at((a + b) / 2, 6); g.fillStyle = ["#d8a050", "#e8c060", "#c07030"][i % 3]; g.fillRect(Math.round(p[0]) - 3, Math.round(p[1]) - 2, 6, 2); }
          }
          door(ctx, F, du, 0.26, top, { color: "#3a4a5a", frame: "#3a3a3a", glazed: true });
          const awn = st.awnings ? st.awnings[(ctx.variant == null ? ctx.h0 : ctx.variant) % st.awnings.length] : st.awning;
          if (awn) awning(ctx, F, 0.05, F.len - 0.05, fh - 3, awn, 0.26, 7);
          if (st.lanterns) for (let u = 0.25; u < F.len - 0.1; u += 0.45) { const p = F.out(u, fh - 13, 0.24); CV.ellipse(g, p[0], p[1], 3, 3, "#d8281e"); g.fillStyle = "#f6d24a"; g.fillRect(Math.round(p[0]) - 1, Math.round(p[1]) - 1, 2, 1); ctx.lights.push([p[0], p[1], "#ff6a3a"]); }
        } else {
          const n = Math.max(1, Math.round(F.len * 1.1));
          for (let i = 0; i < n; i++) { const uc = (i + 0.5) * F.len / n; win(ctx, F, uc - 0.13, uc + 0.13, 7, Math.min(fh - 6, 18), { frame: "#f2ede2", state: 0, idx: i, mullion: true }); }
        }
        if (st.fascia) { // the fascia band: a moulding under it and a cornice line over it
          poly(g, quad(F, 0, F.len, fh - 2, fh), shade(col, 0.8));
          poly(g, quad(F, 0, F.len, gf - 2, gf), shade(col, 1.08));
        }
        for (let fl = 1; fl < floors; fl++) {
          const n = Math.max(2, Math.round(F.len * 1.2)), zf = flZ(fl);
          for (let i = 0; i < n; i++) {
            const uc = (i + 0.5) * F.len / n;
            win(ctx, F, uc - 0.13, uc + 0.13, zf + 6, zf + fh - 5, { frame: "#f2ede2", state: 0, idx: i, mullion: true, sill: "#f2ede2", box: s !== "arcade" && litF, curtain: s === "arcade" ? null : CURTAIN[(i + fl) % 6] });
            if (s === "arcade") poly(g, [F.at(uc - 0.13, zf + fh - 5), F.at(uc + 0.13, zf + fh - 5), F.at(uc, zf + fh - 1)], litF ? shade(ctx.wall, 1.1) : shade(ctx.wall, 0.9));
          }
          if (fl > 1 || !st.fascia) poly(g, quad(F, 0, F.len, zf, zf + 1), shade(col, 0.85));
        }
        if (s === "arcade" && isFront) { // colourful shop awnings along the arcade front
          const cols = [["#c0392b", "#ffffff"], ["#2f7fb8", "#ffffff"], ["#2f8c5a", "#ffffff"], ["#d18f2f", "#fff4dd"]];
          const n = Math.max(3, Math.round(F.len / 1.6));
          for (let i = 0; i < n; i++) { const a = 0.1 + (F.len - 0.2) * i / n, b = a + (F.len - 0.2) / n - 0.08; awning(ctx, F, a, b, fh - 3, cols[i % 4], 0.22, 6); }
        }
        // the name board sits on the fascia, clear of the awning: a dark board, cream letters, a light frame
        const signTxt = st.sign || (st.awnings ? ctx.signText : null), signBg = st.signBgs ? st.signBgs[(ctx.variant == null ? ctx.h0 : ctx.variant) % st.signBgs.length] : st.signBg;
        if (signTxt && st.fascia && isFront) wallSign(ctx, F, signTxt, F.len / 2, fh + 10, "#fff4dc", signBg, CV.textWidth(signTxt) * 2 + 12 > F.len * 30 ? 1 : 2, { border: mix(signBg, "#ffffff", 0.55), shine: true });
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
          wallSign(ctx, F, ctx.variant == null ? "MILLBROOK WORKS" : ["IRONWORKS", "FOUNDRY", "STEEL MILL", "MACHINE WORKS", "BREWERY", "PRINT WORKS", "TEXTILES", "BOILER WORKS"][ctx.variant], F.len / 2, fh + 8, "#ffffff", "#2a3a4a", 2, { border: "#c8d2dc" });
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
      for (const f of FACES) { // painted bands: flat on the two faces the camera sees, no tops of their own
        const F = faceFn(f, sx, sy, sx + 0.45, sy + 0.45);
        for (let z = Hd + 14; z < Hd + 84; z += 18) poly(g, quad(F, 0, F.len, z, z + 7), f === LIT ? "#ece6dc" : shade("#ece6dc", 0.8));
        poly(g, quad(F, 0, F.len, Hd + 78, Hd + 84), f === LIT ? "#8a3a30" : shade("#8a3a30", 0.8)); // soot at the top
      }
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

    // --- v3 styles (view.md 3.8) ---------------------------------------------------------------------------
    // Row houses: a terrace of two-floor units in alternating paint, one door each on the street side, a long
    // gable roof with a chimney on every other party wall.
    function drawRowHouses(ctx) {
      const g = ctx.g, { x0, y0, x1, y1, stage, H } = ctx, fh = ctx.st.floorPx;
      const alongX = (x1 - x0) >= (y1 - y0), long = alongX ? x1 - x0 : y1 - y0, n = Math.max(2, Math.round(long / 1.7));
      const brick = (ctx.variant || 0) % 3 === 2;
      const base2 = brick ? "#b06a4a" : HOUSE_PAINT[(ctx.h0 >>> 3) % HOUSE_PAINT.length];
      const alt = shade(mix(base2, GREY, FADE[stage]), DIM[stage]), first = brick ? shade(mix("#a8573f", GREY, FADE[stage]), DIM[stage]) : ctx.wall;
      for (const f of FACES) {
        const F = faceFn(f, x0, y0, x1, y1), litF = f === LIT, isLong = (f === "s" || f === "n") === alongX;
        const k = litF ? 1 : 0.8, isDoor = f === ctx.p.face || (isLong && !FACES.includes(ctx.p.face) && litF);
        ctx.spans = [];
        const units = isLong ? n : 1, uw = F.len / units;
        for (let i = 0; i < units; i++) {
          const paint = isLong ? (i % 2 ? alt : first) : first, col = shade(paint, k);
          poly(g, quad(F, i * uw, (i + 1) * uw, 0, ctx.Hw), col);
          if (brick) for (let z = 3; z < H; z += 3) poly(g, quad(F, i * uw, (i + 1) * uw, z, z + 1), shade(col, 0.9));
          poly(g, quad(F, i * uw, (i + 1) * uw, 0, 3), shade(col, 0.66));
          if (isLong && i) poly(g, quad(F, i * uw - 0.015, i * uw + 0.015, 0, H), shade(col, 0.7)); // party wall
          if (stage >= 1) grime(ctx, { face: F.face, len: uw, at: (u, z) => F.at(i * uw + u, z), out: (u, z, d) => F.out(i * uw + u, z, d), rect: F.rect }, H, stage, ctx.h0 + i * 7 + f.charCodeAt(0), col, "under");
          for (let fl = 0; fl < ctx.floors; fl++) {
            const us = isDoor && fl === 0 ? [i * uw + uw * 0.7] : [i * uw + uw * 0.3, i * uw + uw * 0.7];
            us.forEach((uc, j) => {
              const ws = windowState(ctx, i * 6 + fl * 2 + j, f, units * 6);
              win(ctx, F, uc - 0.12, uc + 0.12, fl * fh + 7, fl * fh + 18, Object.assign(ws, { frame: ctx.trim, curtain: CURTAIN[(ctx.h0 + i + j + fl) % CURTAIN.length], mullion: true, sill: ctx.trim, idx: i * 6 + fl * 2 + j }));
            });
          }
          if (isDoor) {
            const uc = i * uw + uw * 0.28;
            door(ctx, F, uc, 0.2, 17, { color: stage >= 3 ? "#6a5238" : DOOR[(ctx.h0 + i) % DOOR.length], frame: ctx.trim, boarded: stage >= 3, step: true });
            poly(g, [F.at(uc - 0.16, 21), F.at(uc + 0.16, 21), F.out(uc + 0.16, 18, 0.12), F.out(uc - 0.16, 18, 0.12)], shade(ctx.roofC, k));
            if (stage < 3 && i === 0) ctx.porch = F.at(uc + 0.16, 13);
          }
        }
        if (stage >= 3) grime(ctx, F, H, stage, ctx.h0 + f.charCodeAt(0), shade(first, k), "over");
        poly(g, quad(F, 0, F.len, H - 3, H), "rgba(0,0,0,0.18)");
      }
      ctx.spans = null;
      const roof = pitched(ctx, "gable", ctx.st.roofPx, { alongX });
      const step = long / n;
      for (let i = 2; i < n; i += 2) {
        const t = (alongX ? x0 : y0) + i * step - 0.13;
        if (alongX) chimney(ctx, t, roof.ym - 0.13, ctx.Hw + 10, ctx.Hw + ctx.st.roofPx + 6, brick ? "#7a4a38" : "#9a4a38");
        else chimney(ctx, roof.xm - 0.13, t, ctx.Hw + 10, ctx.Hw + ctx.st.roofPx + 6, brick ? "#7a4a38" : "#9a4a38");
      }
    }

    // Warehouse: corrugated walls, roller doors with yellow frames, a strip of high windows, a low pitched roof.
    function drawWarehouse(ctx) {
      const g = ctx.g, { x0, y0, x1, y1, H } = ctx;
      for (const f of FACES) {
        const F = faceFn(f, x0, y0, x1, y1), litF = f === LIT, col = litF ? ctx.wall : shade(ctx.wall, 0.8);
        poly(g, quad(F, 0, F.len, 0, ctx.Hw), col);
        for (let u = 0.04; u < F.len; u += 0.1) poly(g, quad(F, u, u + 0.03, 4, H), shade(col, 0.88));
        poly(g, quad(F, 0, F.len, 0, 4), litF ? "#7a7c80" : "#626468");
        poly(g, quad(F, 0.1, F.len - 0.1, H - 9, H - 5), litF ? "#3a5a7a" : "#2e4a66");
        for (let u = 0.1; u < F.len - 0.4; u += 0.5) ctx.windows.push(quad(F, u + 0.04, u + 0.4, H - 9, H - 5));
        if (f === ctx.p.face || (litF && !FACES.includes(ctx.p.face))) {
          const n = Math.max(1, Math.floor(F.len / 1.5));
          for (let i = 0; i < n; i++) {
            const uc = (i + 0.5) * F.len / n;
            poly(g, quad(F, uc - 0.36, uc + 0.36, 0, 22), "#e0b830");
            poly(g, quad(F, uc - 0.32, uc + 0.32, 0, 20), litF ? "#8a8e94" : "#6e7278");
            for (let z = 3; z < 20; z += 3) poly(g, quad(F, uc - 0.32, uc + 0.32, z, z + 1), litF ? "#6e7278" : "#585c62");
          }
          door(ctx, F, Math.min(F.len - 0.2, (n - 0.5) * F.len / n + 0.55), 0.16, 16, { color: "#3a4a5a", frame: "#2a2a2a" });
        }
        poly(g, quad(F, 0, F.len, H - 2, ctx.Hw), shade(col, 1.1));
      }
      pitched(ctx, "gable", ctx.st.roofPx, { o: 0.06 });
    }

    // Station: a stone hall with tall windows, a canopy and the STATION board over the entrance, a clock turret.
    function drawStation(ctx) {
      const g = ctx.g, { x0, y0, x1, y1, H, st } = ctx;
      const front = FACES.includes(ctx.p.face) ? ctx.p.face : LIT;
      for (const f of FACES) {
        const F = faceFn(f, x0, y0, x1, y1), litF = f === LIT, col = litF ? ctx.wall : shade(ctx.wall, 0.82);
        poly(g, quad(F, 0, F.len, 0, ctx.Hw), col);
        poly(g, quad(F, 0, F.len, 0, 5), shade(col, 0.72));
        poly(g, quad(F, 0, F.len, H - 4, H), shade(col, 1.1));
        const n = Math.max(1, Math.round(F.len * 1.4)), du = f === front ? (f === ctx.p.face ? entryU(ctx, F) : F.len / 2) : -9;
        for (let i = 0; i < n; i++) {
          const uc = (i + 0.5) * F.len / n;
          if (Math.abs(uc - du) < 0.4) continue;
          win(ctx, F, uc - 0.13, uc + 0.13, 7, H - 9, { frame: "#f2ede2", mullion: true, state: 0, idx: i });
          poly(g, [F.at(uc - 0.13, H - 9), F.at(uc + 0.13, H - 9), F.at(uc, H - 5)], litF ? "#8cbfe4" : "#6b9cc6");
        }
        if (f === front) {
          door(ctx, F, du, 0.4, 20, { color: "#2a3a4c", frame: "#f2ede2", glazed: true });
          const a = Math.max(0.05, du - 1.2), b = Math.min(F.len - 0.05, du + 1.2), r = F.rect(a, b, 0, 0.28); // the canopy stays inside the sprite box's 0.3-tile margin
          boxAt(g, r[0], r[1], r[2], r[3], 22, 25, "#3a4a5a", "#56667a");
          for (const u of [a + 0.08, b - 0.12]) { const c = F.rect(u, u + 0.04, 0.22, 0.26); boxAt(g, c[0], c[1], c[2], c[3], 0, 22, "#3a4a5a"); }
          wallSign(ctx, F, st.sign, du, H - 2, "#ffffff", st.signBg, 1, { border: "#8ab0d8" });
        }
      }
      flatRoof(ctx, ctx.roofC, { cope: shade(ctx.wall, 1.12) });
      const cx = (x0 + x1) / 2 - 0.25, cy = (y0 + y1) / 2 - 0.25, Hd = ctx.Hw;
      boxAt(g, cx, cy, cx + 0.5, cy + 0.5, Hd, Hd + 16, ctx.wall);
      for (const f of FACES) { const F = faceFn(f, cx, cy, cx + 0.5, cy + 0.5), c = F.at(F.len / 2, Hd + 10); CV.ellipse(g, c[0], c[1], 3, 3, "#ffffff"); g.fillStyle = "#222"; g.fillRect(Math.round(c[0]), Math.round(c[1]) - 2, 1, 2); }
      poly(g, [P(cx - 0.05, cy - 0.05, Hd + 16), P(cx + 0.55, cy - 0.05, Hd + 16), P(cx + 0.55, cy + 0.55, Hd + 16), P(cx + 0.25, cy + 0.25, Hd + 26), P(cx - 0.05, cy + 0.55, Hd + 16)], "#3a6a5a");
      poly(g, [P(cx - 0.05, cy + 0.55, Hd + 16), P(cx + 0.55, cy + 0.55, Hd + 16), P(cx + 0.25, cy + 0.25, Hd + 26)], "#4f8a72");
    }

    // A civic hall (police, fire station, cinema, mall, clubhouse and any unknown style): walls, rows of
    // windows, an entrance and a name board, with each style's own features.
    function drawHall(ctx) {
      const g = ctx.g, { x0, y0, x1, y1, H, st } = ctx, s = ctx.p.style;
      const fh = st.floorPx, floors = ctx.floors;
      const front = FACES.includes(ctx.p.face) ? ctx.p.face : LIT;
      for (const f of FACES) {
        const F = faceFn(f, x0, y0, x1, y1), litF = f === LIT, col = litF ? ctx.wall : shade(ctx.wall, 0.8), isFront = f === front;
        poly(g, quad(F, 0, F.len, 0, ctx.Hw), col);
        if (s === "fire_station") for (let z = 2; z < H; z += 3) poly(g, quad(F, 0, F.len, z, z + 1), shade(col, 0.88));
        if (s === "clubhouse") for (let z = 3; z < H; z += 3) poly(g, quad(F, 0, F.len, z, z + 1), shade(col, 0.92));
        poly(g, quad(F, 0, F.len, 0, 4), shade(col, 0.68));
        const du = isFront ? (f === ctx.p.face ? Math.max(0.4, Math.min(F.len - 0.4, entryU(ctx, F))) : F.len / 2) : -9;
        const n = Math.max(1, Math.round(F.len * (s === "mall" || s === "cinema" ? 0.6 : 1.2)));
        for (let fl = 0; fl < floors; fl++) {
          if (fl > 0) poly(g, quad(F, 0, F.len, fl * fh, fl * fh + 2), shade(col, 0.85));
          if (s === "cinema" && fl > 0) continue; // a blank auditorium wall
          for (let i = 0; i < n; i++) {
            const uc = (i + 0.5) * F.len / n;
            if (fl === 0 && isFront && (Math.abs(uc - du) < (s === "mall" ? 1.1 : 0.45) || s === "fire_station")) continue;
            const w = s === "mall" ? 0.5 : 0.13;
            win(ctx, F, uc - w, uc + w, fl * fh + 7, fl * fh + fh - 6, { frame: s === "clubhouse" ? "#ffffff" : "#e8e4dc", mullion: true, state: 0, idx: i + fl * n });
          }
        }
        if (isFront) {
          if (s === "fire_station") { // the engine bays
            const bays = Math.max(2, Math.floor(F.len / 1.6));
            for (let i = 0; i < bays; i++) {
              const uc = (i + 0.5) * F.len / bays;
              poly(g, quad(F, uc - 0.36, uc + 0.36, 0, 24), "#f2ede2");
              poly(g, quad(F, uc - 0.32, uc + 0.32, 0, 22), litF ? "#c8281e" : "#a8201a");
              for (let k = 0; k < 3; k++) poly(g, quad(F, uc - 0.28 + k * 0.2, uc - 0.12 + k * 0.2, 12, 19), "#8cbfe4");
            }
          } else if (s === "mall") { // a glass entrance hall
            poly(g, quad(F, du - 1, du + 1, 0, fh + 4), "#3a4a5a");
            for (let u = du - 0.95; u < du + 0.95; u += 0.2) poly(g, quad(F, u, u + 0.17, 2, fh + 2), litF ? "#8cbfe4" : "#6b9cc6");
            ctx.windows.push(quad(F, du - 0.95, du + 0.95, 2, fh + 2));
          } else door(ctx, F, du, s === "cinema" ? 0.6 : 0.3, 19, { color: "#2a3a4c", frame: "#e8e4dc", glazed: true, step: true });
          if (s === "cinema") { // the marquee with its bulbs
            const r = F.rect(du - 1.0, du + 1.0, 0, 0.4);
            boxAt(g, r[0], r[1], r[2], r[3], 21, 31, "#f2e6c8", "#d8c8a0");
            const Fo = { face: F.face, at: (u, z) => F.out(u, z, 0.4) };
            wallSign(ctx, Fo, st.sign, du, 26, "#c8283a", null, 1);
            for (let u = du - 0.95; u < du + 0.95; u += 0.12) { const p = F.out(u, 31, 0.4); g.fillStyle = "#ffe48a"; g.fillRect(Math.round(p[0]), Math.round(p[1]) - 1, 1, 1); ctx.lights.push([p[0], p[1], "#ffd86a"]); }
            wallSign(ctx, F, st.sign, du, H - 12, "#ffffff", st.signBg, 2, { border: "#ffd86a" });
          } else if (s === "clubhouse") {
            const r = F.rect(0.1, F.len - 0.1, 0, 0.4);
            boxAt(g, r[0], r[1], r[2], r[3], 18, 20, "#8a6a44");
            for (let u = 0.15; u < F.len - 0.1; u += 0.6) { const c = F.rect(u, u + 0.05, 0.34, 0.39); boxAt(g, c[0], c[1], c[2], c[3], 0, 18, "#f2ede2"); }
            wallSign(ctx, F, st.sign, F.len / 2, H - 4, "#ffffff", st.signBg, 1);
          } else wallSign(ctx, F, st.sign || "", du, Math.min(H - 8, fh + 10), "#ffffff", st.signBg || "#2a3a4a", F.len > 3 ? 2 : 1, { border: "#c8d2dc" });
          if (s === "police") for (const u of [du - 0.3, du + 0.3]) { const p = F.out(u, 22, 0.06); g.fillStyle = "#2a4aa8"; g.fillRect(Math.round(p[0]) - 1, Math.round(p[1]) - 3, 3, 3); ctx.lights.push([p[0], p[1] - 2, "#5a8aff"]); }
        }
        poly(g, quad(F, 0, F.len, H - 2, ctx.Hw), shade(col, 1.1));
      }
      if (st.roof === "gable") { pitched(ctx, "gable", st.roofPx); return; }
      flatRoof(ctx, ctx.roofC, { cope: shade(ctx.wall, 1.12) });
      const Hd = ctx.H;
      if (s === "fire_station") { // the hose tower
        const tx = x0 + 0.15, ty = y0 + 0.15;
        boxAt(g, tx, ty, tx + 0.7, ty + 0.7, Hd, Hd + 36, ctx.wall);
        const F = faceFn(LIT, tx, ty, tx + 0.7, ty + 0.7);
        for (let z = Hd + 6; z < Hd + 32; z += 9) poly(g, quad(F, 0.25, 0.45, z, z + 5), "#3a4a5a");
        boxAt(g, tx - 0.04, ty - 0.04, tx + 0.74, ty + 0.74, Hd + 36, Hd + 39, shade(ctx.wall, 0.7));
      } else if (s === "mall") {
        for (let x = x0 + 1; x < x1 - 1.4; x += 2.2) poly(g, top(x, y0 + 1, x + 1.2, y1 - 1, Hd + 1), "#9cc8ea");
        acUnit(ctx, x1 - 1.2, y0 + 0.5, Hd); acUnit(ctx, x0 + 0.5, y1 - 1, Hd);
      } else { acUnit(ctx, x0 + 0.4, y0 + 0.4, Hd); if (x1 - x0 > 3) acUnit(ctx, x1 - 0.9, y0 + 0.5, Hd); }
    }

    // Stadium: an arcaded concrete ring, tiers of seats stepping down to the pitch, a floodlight at each corner.
    function drawStadium(ctx) {
      const g = ctx.g, { x0, y0, x1, y1, H } = ctx;
      for (const f of FACES) {
        const F = faceFn(f, x0, y0, x1, y1), litF = f === LIT, col = litF ? ctx.wall : shade(ctx.wall, 0.8);
        poly(g, quad(F, 0, F.len, 0, H), col);
        for (let u = 0.2; u < F.len - 0.3; u += 0.5) { poly(g, quad(F, u, u + 0.3, 0, 14), shade(col, 0.55)); const q = quad(F, u, u + 0.3, 20, H - 6); poly(g, q, shade(col, 0.72)); ctx.windows.push(q); }
        poly(g, quad(F, 0, F.len, H - 3, H), shade(col, 1.12));
      }
      const tiers = 4, d = Math.min(x1 - x0, y1 - y0) * 0.09;
      for (let k = 0; k < tiers; k++) {
        const a = k * d, z = H - k * 7;
        poly(g, top(x0 + a, y0 + a, x1 - a, y1 - a, z), k % 2 ? "#5a6a8a" : "#8a3a3a");
        poly(g, top(x0 + a + d * 0.5, y0 + a + d * 0.5, x1 - a - d * 0.5, y1 - a - d * 0.5, z), k % 2 ? "#6a7a9a" : "#a84a4a");
      }
      const a = tiers * d, zp = H - tiers * 7, snow = CV.SEASON[ctx.season] && CV.SEASON[ctx.season].snow;
      poly(g, top(x0 + a, y0 + a, x1 - a, y1 - a, zp), snow ? "#e8eeec" : "#4f9a3a");
      const px0 = x0 + a + 0.3, py0 = y0 + a + 0.3, px1 = x1 - a - 0.3, py1 = y1 - a - 0.3, line = snow ? "#c8d0d0" : "#e8f2e0";
      for (const [p0, q0, p1, q1] of [[px0, py0, px1, py0 + 0.04], [px0, py1 - 0.04, px1, py1], [px0, py0, px0 + 0.04, py1], [px1 - 0.04, py0, px1, py1], [(px0 + px1) / 2 - 0.02, py0, (px0 + px1) / 2 + 0.02, py1]]) poly(g, top(p0, q0, p1, q1, zp), line);
      for (const [cx, cy] of [[x0 + 0.2, y0 + 0.2], [x1 - 0.3, y0 + 0.2], [x0 + 0.2, y1 - 0.3], [x1 - 0.3, y1 - 0.3]]) {
        boxAt(g, cx, cy, cx + 0.1, cy + 0.1, H, H + 40, "#8a8e96");
        const p = P(cx + 0.05, cy + 0.05, H + 44);
        g.fillStyle = "#3a3e46"; g.fillRect(Math.round(p[0]) - 6, Math.round(p[1]) - 2, 12, 6);
        g.fillStyle = "#fff6c8"; g.fillRect(Math.round(p[0]) - 5, Math.round(p[1]) - 1, 10, 3);
        ctx.lights.push([p[0], p[1], "#fff6c8"]);
      }
    }
    art._bld = { win, door, wallSign, awning, flatRoof, pitched, chimney, acUnit, entryU, grime, baseGrime, copingStains, windowState };
    art.styleDrawers = art.styleDrawers || {};

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
    // A place with a variant is drawn as its canonical copy (CV.canonPlace: id style#variant at 0,0) and moved
    // into place by whole pixels, so every copy of a sprite key is the same pixels wherever it stands.
    // Millbrook's places (no variant) draw in place, as v2 did.
    art.building = function (p, look, season) {
      if (CV.variantOf(p) == null || (p.x === 0 && p.y === 0 && String(p.id).indexOf("#") > 0)) return drawBuilding(p, look, season);
      const b = drawBuilding(CV.canonPlace(p), look, season);
      const o = proj.toWorld(p.x, p.y), z = proj.toWorld(0, 0), dx = o[0] - z[0], dy = o[1] - z[1];
      const mv = q => q && [q[0] + dx, q[1] + dy].concat(q.slice(2));
      b.ox += dx; b.oy += dy; b.id = p.id;
      b.windows = b.windows.map(quad => quad.map(mv));
      b.lights = b.lights.map(mv);
      b.porch = mv(b.porch); b.neon = mv(b.neon); b.smoke = mv(b.smoke); b.beacon = mv(b.beacon);
      return b;
    };
    function drawBuilding(p, look, season) {
      look = look || {};
      const st = STYLE[p.style] || STYLE.house;
      const isHome = p.kind === "home";
      const stage = isHome ? Math.max(0, Math.min(4, look.stage | 0)) : 0;
      const variant = CV.variantOf(p), sid = variant == null ? String(p.id) : p.style + "#" + variant;
      const h0 = hash(sid);
      const { floors, H, Hw } = heights(p);
      const body = CV.bodyOf(p);
      let wall = st.wall ? (Array.isArray(st.wall) ? st.wall[h0 % st.wall.length] : st.wall) : p.style === "big_house" ? VILLA_PAINT[h0 % VILLA_PAINT.length] : HOUSE_PAINT[h0 % HOUSE_PAINT.length];
      let roofC = st.roofC || (p.style === "big_house" ? VILLA_ROOF[(h0 >>> 4) % VILLA_ROOF.length] : HOUSE_ROOF[(h0 >>> 4) % HOUSE_ROOF.length]);
      let trim = isHome ? ["#ffffff", "#f6efe0", "#ffffff", "#efe9dc"][(h0 >>> 8) % 4] : "#ffffff";
      if (isHome) {
        wall = shade(mix(wall, GREY, FADE[stage]), DIM[stage]);
        roofC = shade(mix(roofC, "#77736a", FADE[stage] * 0.7), DIM[stage]);
        trim = shade(mix(trim, "#a8a090", FADE[stage]), DIM[stage]);
      }
      const box = boxOf(proj, p);
      const S = art.sprite(box.ox, box.oy, box.ox + box.w, box.oy + box.h);
      const ctx = { g: S.g, p, st, look, stage, isHome, h0, sid, variant, signText: CV.signTextOf(p), floors, H, Hw, wall, roofC, trim, season, body,
        x0: body.x0, y0: body.y0, x1: body.x1, y1: body.y1, windows: [], lights: [], porch: null, neon: null, smoke: null, beacon: null };
      switch (p.style) {
        case "house": drawHouse(ctx); break;
        case "big_house": drawBigHouse(ctx); break;
        case "apartments": if (variant != null && art.styleDrawers.apartments) art.styleDrawers.apartments(ctx); else drawApartments(ctx); break;
        case "tower": if (variant != null && art.styleDrawers.tower) art.styleDrawers.tower(ctx); else drawTower(ctx); break;
        case "row_houses": drawRowHouses(ctx); break;
        case "warehouse": drawWarehouse(ctx); break;
        case "station": drawStation(ctx); break;
        case "library": drawCivic(ctx); break;
        case "stadium": drawStadium(ctx); break;
        case "police": case "fire_station": case "cinema": case "mall": case "clubhouse": drawHall(ctx); break;
        case "residential_tower": case "hotel": if (art.styleDrawers[p.style]) art.styleDrawers[p.style](ctx); else drawHall(ctx); break;
        case "hospital": drawHospital(ctx); break;
        case "school": drawSchool(ctx); break;
        case "city_hall": case "bank": drawCivic(ctx); break;
        case "factory": drawFactory(ctx); break;
        default: if (CV.hasStyle(p.style)) drawShop(ctx); else drawHall(ctx);
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
      const litShare = isHome ? 70 : p.style === "tower" ? 45 : 60;
      return { c: S.c, ox: S.ox, oy: S.oy, windows: ctx.windows, lights: ctx.lights, height: box.height, id: p.id, litShare,
        porch: ctx.porch, neon: ctx.neon, smoke: ctx.smoke, beacon: ctx.beacon, labelZ: box.labelZ, key: CV.spriteKey(p, look, season), sid };
    }

    // Night glow: a sprite's lit windows as a small canvas of their own, shared by every copy of a sprite key
    // (and of a share). Which windows light is hashed from the sid ("style#variant"), so all copies agree; a
    // Millbrook place hashes its id, which gives v2's glow pixel for pixel. Returns { c, wx, wy } (world px of
    // the canvas's top-left) or null when no window is lit. share: percent of windows lit (default litShare).
    const glowCache = new Map();
    art.glow = function (b, share) {
      const pct = share == null ? b.litShare : share;
      const ck = (b.key || "id:" + b.id + "@" + b.ox + "," + b.oy) + "|" + pct;
      let gl = glowCache.get(ck);
      if (gl === undefined) {
        const seed = b.sid || b.id, win = b.windows.filter((q, k) => hash(seed + ":" + k) % 100 < pct);
        gl = null;
        if (win.length) {
          // a keyed sprite's windows relative to its canvas (the same for every copy); Millbrook's in world px, as v2
          const bx = String(seed).indexOf("#") > 0 ? b.ox : 0, by = bx ? b.oy : 0;
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
          const loc = bx ? win.map(q => q.map(([x, y]) => [x - bx, y - by])) : win;
          for (const q of loc) for (const [x, y] of q) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
          x0 = Math.floor(x0); y0 = Math.floor(y0);
          const c = CV.canvas(x1 - x0 + 2, y1 - y0 + 2), q = c.getContext("2d");
          q.translate(-x0, -y0);
          for (const w of loc) CV.poly(q, w, "#e8a440");
          q.fillStyle = "#ffd890";
          for (const w of loc) { const cx = (w[0][0] + w[2][0]) / 2, cy = (w[0][1] + w[2][1]) / 2; q.fillRect(Math.round(cx) - 1, Math.round(cy) - 1, 2, 2); }
          gl = { c, dx: x0 + bx - b.ox, dy: y0 + by - b.oy };
        }
        if (glowCache.size >= 4096) glowCache.clear();
        glowCache.set(ck, gl);
      }
      return gl && { c: gl.c, wx: b.ox + gl.dx, wy: b.oy + gl.dy };
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

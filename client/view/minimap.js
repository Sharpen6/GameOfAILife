// CityView minimap: the whole city at a small scale (a diamond in iso), 240 x 120 CSS px (168 x 84 on phones and
// short screens, where it starts collapsed and collapses again when the view shrinks into that size, unless the
// user opened it there). The base is one ImageData by kind, sampled per pixel through the projection (every
// tile code of the region, buildings by place kind, district borders), built once per projection, season and
// size (debug().minimapMs). Over it, redrawn at 5 Hz: the named characters (2 px), the townsfolk (1 px), the
// trains (3 px, line colour), buses, and the camera's view box. Hover names the district under the pointer,
// click or drag recentres the camera, double-click flies there at zoom 0.5. The "Homes" overlay colours every
// home by neglect stage (kept green to derelict red) in the dashboard's Condition colours, so the minimap, the
// map overlay and its legend agree; in a small town it is on by itself while the camera is zoomed out to 0.5 or
// less, where the stages are too small to read on the map.
// Classic script on window.CityView.
"use strict";
(function () {
  const CV = window.CityView = window.CityView || {};
  const KIND_COL = { home: "#c98a5a", office: "#7f9fc6", townhall: "#d8cfb8", hospital: "#eef0f2", school: "#c0644a", market: "#e0a040",
    cafe: "#d07aa0", shop: "#b88ad8", bank: "#c8c0a8", works: "#8a8478" };
  const STYLE_COL = { apartments: "#b07a62", big_house: "#e0c49a" };
  const OTHER_COL = "#55585e"; // buildings other than homes under the Homes overlay, darker than worn grey
  const USE_COL = { 1: "#7fc65a", 2: "#8a7a44", 3: "#6a6e76", 4: "#8f8c84" };
  // region tile codes (region.md 3.1) beyond the town's: bridges, crossings, farmland, rail, platforms, highways
  const CODE_COL = { "#": "#5d6068", x: "#5d6068", b: "#7a7068", e: "#b8b0a0", "~": "#3a78b8", B: "#a08870", D: "#a08870",
    F: "#b9ae6a", "=": "#7a6550", r: "#7a6550", S: "#a8a49a", H: "#44474f", h: "#44474f" };
  KIND_COL.station = "#9aa4b0"; KIND_COL.venue = "#c87a5a";
  const BIG = 20000;                 // tiles: a region, where Homes is never on by itself
  const W_DESK = 240, W_SMALL = 168;

  CV.makeMinimap = function (host, scene, cam, opt) {
    opt = opt || {};
    const { mix } = CV.color;
    const box = document.createElement("div");
    box.className = "cv-minimap";
    const head = document.createElement("button");
    head.type = "button"; head.className = "cv-minimap-toggle"; head.title = "Show or hide the minimap"; head.setAttribute("aria-label", "Toggle minimap");
    head.textContent = "Map";
    const c = document.createElement("canvas");
    c.className = "cv-minimap-canvas";
    const legend = document.createElement("div");
    legend.className = "cv-minimap-legend";
    legend.setAttribute("aria-label", "Homes by condition, kept to derelict");
    const lab = t => { const s = document.createElement("span"); s.className = "cv-minimap-legend-label"; s.textContent = t; return s; };
    legend.appendChild(lab("kept"));
    const swatches = CV.stageColors().map(col => { const s = document.createElement("span"); s.className = "cv-minimap-swatch"; s.style.background = col; legend.appendChild(s); return s; });
    legend.appendChild(lab("derelict"));
    box.appendChild(c); box.appendChild(legend); box.appendChild(head);
    host.appendChild(box);

    const isSmall = () => { const w = host.clientWidth || window.innerWidth, h = host.clientHeight || window.innerHeight; return w < 640 || h < 500; };
    let small = isSmall(), MW = small ? W_SMALL : W_DESK;
    let base = null, baseKey = "", s = 1, last = 0;
    let open = opt.open != null ? !!opt.open : !small;
    let userOpenedSmall = small && opt.open === true, autoClosed = false;
    let homes = opt.homes === true || opt.homes === false ? opt.homes : null; // null: automatic
    const homesOn = () => homes != null ? homes : scene.town.w * scene.town.h <= BIG && cam.zoom <= 0.5 + 1e-6;
    const setOpen = (v, byUser) => {
      open = !!v;
      if (byUser) { autoClosed = false; userOpenedSmall = small && open; }
      box.classList.toggle("cv-collapsed", !open);
      if (opt.onToggle) opt.onToggle(open);
    };
    setOpen(open);
    head.addEventListener("click", () => setOpen(!open, true));

    // The host changed size: pick the minimap size and collapse it when the view became narrow or short.
    function resize() {
      const sm = isSmall();
      if (sm === small) return false;
      small = sm; MW = small ? W_SMALL : W_DESK; base = null;
      if (small && open && !userOpenedSmall) { autoClosed = true; setOpen(false); }
      else if (!small && !open && autoClosed) { autoClosed = false; setOpen(true); }
      if (!small) userOpenedSmall = false;
      return true;
    }

    // Per tile: the packed colour and the district index (-1 none); per pixel of the base: the tile under it.
    let tileDist = null, buildMs = 0;
    const rgbCache = new Map();
    const rgbOf = hex => { let v = rgbCache.get(hex); if (v == null) { const c3 = CV.color.hexRgb(hex); v = (c3[0] << 16) | (c3[1] << 8) | c3[2]; rgbCache.set(hex, v); } return v; };
    function buildBase(showHomes) {
      const t0 = performance.now();
      const proj = scene.proj, B = scene.bounds(), t = scene.town, TW = t.w, TH = t.h;
      s = MW / (B.x1 - B.x0);
      const w = MW, h = Math.round((B.y1 - B.y0) * s);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const PW = Math.round(w * dpr), PH = Math.round(h * dpr);
      c.width = PW; c.height = PH;
      c.style.width = w + "px"; c.style.height = h + "px";
      base = CV.canvas(PW, PH);
      const g = base.getContext("2d");
      const S = CV.SEASON[scene.season] || CV.SEASON.summer;
      const col = Object.assign({}, CODE_COL, { ".": S.grass, P: S.park, T: S.leaf[1] });
      const looks = scene.looks || {}, stages = CV.stageColors();
      swatches.forEach((e, k) => { e.style.background = stages[k]; }); // the dashboard may have come after the view
      const stageCol = p => stages[Math.max(0, Math.min(4, ((looks[p.id] || {}).stage) | 0))];
      const N = TW * TH, placeAt = new Int16Array(N).fill(-1), tc = new Int32Array(N), byId = new Map(t.places.map(p => [p.id, p]));
      tileDist = new Int16Array(N).fill(-1);
      t.places.forEach((p, k) => {
        for (let y = Math.max(0, p.y); y < Math.min(TH, p.y + p.h); y++) for (let x = Math.max(0, p.x); x < Math.min(TW, p.x + p.w); x++) placeAt[y * TW + x] = k;
      });
      (t.districts || []).forEach((d, k) => {
        for (const r of d.rects || []) {
          for (let y = Math.max(0, r[1]); y < Math.min(TH, r[1] + r[3]); y++) for (let x = Math.max(0, r[0]); x < Math.min(TW, r[0] + r[2]); x++) tileDist[y * TW + x] = k;
        }
      });
      for (let y = 0; y < TH; y++) {
        const row = t.tiles[y];
        for (let x = 0; x < TW; x++) {
          const ch = row[x], j = y * TW + x;
          let f = col[ch] || S.grass;
          const u = scene.useAt ? scene.useAt(x, y) : 0;
          if (USE_COL[u] && ch !== "T") f = USE_COL[u];
          if (ch === "B" || ch === "D") {
            const p = placeAt[j] >= 0 ? t.places[placeAt[j]] : null;
            if (p) f = showHomes ? (p.kind === "home" ? stageCol(p) : OTHER_COL) : STYLE_COL[p.style] || KIND_COL[p.kind] || f;
          } else if (showHomes && scene.lotAt) {
            const lot = scene.lotAt(x, y), lp = lot && byId.get(lot);
            if (lp) f = mix(stageCol(lp), S.grass, 0.45);
          }
          tc[j] = rgbOf(f);
        }
      }
      const img = g.createImageData(PW, PH), data = img.data, k = s * dpr;
      const tileOf = new Int32Array(PW * PH);
      for (let py = 0; py < PH; py++) {
        const wy = B.y0 + (py + 0.5) / k;
        for (let px = 0; px < PW; px++) {
          const q = proj.toTile(B.x0 + (px + 0.5) / k, wy), x = Math.floor(q[0]), y = Math.floor(q[1]), o = py * PW + px;
          if (x < 0 || y < 0 || x >= TW || y >= TH) { tileOf[o] = -1; continue; }
          const j = y * TW + x, v = tc[j];
          tileOf[o] = j;
          data[4 * o] = v >> 16; data[4 * o + 1] = (v >> 8) & 255; data[4 * o + 2] = v & 255; data[4 * o + 3] = 255;
        }
      }
      // district borders: a pixel whose right or lower neighbour lies in another district
      if ((t.districts || []).length > 1) {
        for (let py = 0; py < PH - 1; py++) {
          for (let px = 0; px < PW - 1; px++) {
            const o = py * PW + px, j = tileOf[o];
            if (j < 0) continue;
            const d = tileDist[j], jr = tileOf[o + 1], jd = tileOf[o + PW];
            if ((jr >= 0 && tileDist[jr] !== d) || (jd >= 0 && tileDist[jd] !== d)) {
              data[4 * o] = (data[4 * o] * 0.4 + 255 * 0.6) | 0; data[4 * o + 1] = (data[4 * o + 1] * 0.4 + 240 * 0.6) | 0; data[4 * o + 2] = (data[4 * o + 2] * 0.4 + 200 * 0.6) | 0;
            }
          }
        }
      }
      g.putImageData(img, 0, 0);
      buildMs = performance.now() - t0;
    }
    // The district under a point of the minimap (CSS px), or null.
    function districtAt(mx, my) {
      if (!tileDist) return null;
      const t = scene.town, [wx, wy] = fromMini(mx, my), q = scene.proj.toTile(wx, wy), x = Math.floor(q[0]), y = Math.floor(q[1]);
      if (x < 0 || y < 0 || x >= t.w || y >= t.h) return null;
      const k = tileDist[y * t.w + x];
      return k >= 0 ? t.districts[k] : null;
    }
    function toMini(wx, wy) { const B = scene.bounds(); return [(wx - B.x0) * s, (wy - B.y0) * s]; }
    function fromMini(mx, my) { const B = scene.bounds(); return [mx / s + B.x0, my / s + B.y0]; }

    let looksSeen = null;
    function draw(now, force) {
      const showHomes = homesOn();
      box.classList.toggle("cv-homes", showHomes);
      if (!open) return;
      if (!force && now - last < 200) return;
      last = now;
      if (scene.looksVersion !== looksSeen) { looksSeen = scene.looksVersion; if (showHomes) base = null; }
      const key = [scene.proj.kind, scene.proj.rot, scene.season, showHomes ? 1 : 0, MW].join(":");
      if (!base || key !== baseKey) { buildBase(showHomes); baseKey = key; }
      const g = c.getContext("2d"), dpr = c.width / MW;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, c.width, c.height);
      g.drawImage(base, 0, 0);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const proj = scene.proj;
      if (scene.crowd && scene.crowd.each) {         // townsfolk, 1 px
        g.fillStyle = showHomes ? "rgba(120,220,255,0.75)" : "rgba(255,238,205,0.8)";
        scene.crowd.each((x, y) => { const w = proj.toWorld(x, y), p = toMini(w[0], w[1]); g.fillRect(Math.floor(p[0]), Math.floor(p[1]), 1, 1); }, now);
      }
      for (const m of scene.movers) {                // named characters 2 px, buses
        if (m.kind === "parked") continue;
        const [x, y] = toMini(m.cx != null ? m.cx : m.wx + m.sw / 2, m.cy != null ? m.cy : m.wy + m.sh);
        g.fillStyle = m.kind === "bus" ? "#ffcf3a" : m.kind === "car" ? "#ffffff" : m.id === scene.selected ? "#ffe27a" : showHomes ? "#3ad0ff" : "#ff6a5a";
        const d = m.kind === "bus" ? 3 : m.id === scene.selected ? 3 : 2;
        g.fillRect(Math.round(x - d / 2), Math.round(y - d / 2), d, d);
      }
      if (scene.trains && scene.trains.rows) {       // trains, 3 px in the line's colour
        const LC = CV.LINE_COLORS || {};
        for (const r of scene.trains.rows()) {
          const cs = scene.trains.carsOf(r.id, now);
          if (!cs || !cs.length) continue;
          const w = proj.toWorld(cs[0].x, cs[0].y), p = toMini(w[0], w[1]);
          g.fillStyle = "#101014"; g.fillRect(Math.round(p[0] - 2), Math.round(p[1] - 2), 4, 4);
          g.fillStyle = LC[String(r.line || r.id || "")[0]] || "#e0e0e0"; g.fillRect(Math.round(p[0] - 1.5), Math.round(p[1] - 1.5), 3, 3);
        }
      }
      const v = scene.view();
      const [x0, y0] = toMini(v.x0, v.y0), [x1, y1] = toMini(v.x1, v.y1);
      const W = c.width / dpr, H = c.height / dpr;
      const a0 = Math.max(0.5, Math.round(x0) + 0.5), b0 = Math.max(0.5, Math.round(y0) + 0.5);
      const a1 = Math.min(W - 0.5, Math.round(x1) - 0.5), b1 = Math.min(H - 0.5, Math.round(y1) - 0.5);
      g.strokeStyle = "rgba(255,255,255,0.95)"; g.lineWidth = 1.2;
      if (a1 > a0 && b1 > b0) g.strokeRect(a0, b0, Math.max(2, a1 - a0), Math.max(2, b1 - b0));
    }
    let dragging = false;
    const go = ev => {
      const r = c.getBoundingClientRect();
      const [wx, wy] = fromMini(ev.clientX - r.left, ev.clientY - r.top);
      if (cam.follow && opt.onFollowCancel) opt.onFollowCancel();
      cam.follow = null; cam.centerOn(wx, wy);
      draw(performance.now(), true);
    };
    c.addEventListener("pointerdown", ev => { dragging = true; try { c.setPointerCapture(ev.pointerId); } catch (e) { /* optional */ } go(ev); ev.preventDefault(); });
    c.addEventListener("pointermove", ev => {
      if (dragging) { go(ev); return; }
      const r = c.getBoundingClientRect(), d = districtAt(ev.clientX - r.left, ev.clientY - r.top);
      const name = d ? d.name : "";
      if (c.title !== name) c.title = name;
    });
    c.addEventListener("dblclick", ev => {
      const r = c.getBoundingClientRect();
      const [wx, wy] = fromMini(ev.clientX - r.left, ev.clientY - r.top);
      cam.follow = null;
      if (cam.flyTo) cam.flyTo(wx, wy, 0.5, 600); else cam.centerOn(wx, wy);
      ev.preventDefault();
    });
    c.addEventListener("pointerup", () => { dragging = false; });
    c.addEventListener("pointercancel", () => { dragging = false; });
    return {
      el: box, draw, resize, rebuild: () => { base = null; },
      districtAt, toMini, canvas: c,
      stats: () => ({ buildMs, w: MW, h: c.height / Math.max(1, c.width / MW) }),
      isOpen: () => open, setOpen: v => setOpen(v, true),
      homesOn, homesPref: () => homes,
      setHomes(v) { homes = v === true || v === false ? v : null; base = null; draw(performance.now(), true); },
      setScene(sc, cm) { scene = sc; cam = cm; base = null; },
      destroy() { box.remove(); },
    };
  };
})();

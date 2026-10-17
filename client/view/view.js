// CityView facade: CityView.create(canvas, hooks) wires the scene, movers, camera and minimap to a canvas,
// owns the animation loop and the backing-store size, adds the .cv-* controls next to the canvas, and
// exposes the methods game.js and the dashboard call (PLAN 3.12):
//   setTown(town)                      welcome.town; older towns (40 x 25) are normalized
//   setState(state, speed)             every frame; the last lots and homes are kept when a frame omits them
//   select(id | null, {follow})        never calls onSelect
//   focus(target, {inset, zoom})       target {agent} | {place} | {tile: [x, y]} | {district}; animated
//   highlight({agents, places} | null) outline glow, and x-ray through whatever covers the first of them
//   setOverlay(name | null, colors)    "wealth" | "mood" | "condition"; {placeId: cssColor}, drawn every frame
//   ping(target, topic)                rings on the map (and an arrow at the edge when off screen)
//   setInset({top, right, bottom})     CSS px of page UI over the canvas
//   setMode({projection})              "iso" | "flat", kept in localStorage["goal.view"]
//   camera(), start(), stop()
// A place in focus, ping, highlight or an overlay may also be a home id (resolved through town.homes). The
// view pings only when told to, and it never sends messages. Classic script on window.CityView.
"use strict";
(function () {
  const CV = window.CityView = window.CityView || {};
  const PREFS = "goal.view";
  const PING_COL = { death: "#e0402c", money: "#f6c445", home: "#4ab0f0", social: "#c86cf0", health: "#3ec46a", other: "#ffffff" };
  const loadPrefs = () => { try { return JSON.parse(localStorage.getItem(PREFS) || "null") || {}; } catch (e) { return {}; } };
  const savePrefs = p => { try { localStorage.setItem(PREFS, JSON.stringify(p)); } catch (e) { /* storage is optional */ } };
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  CV.create = function (canvas, hooks, opt) {
    hooks = hooks || {}; opt = opt || {};
    const host = canvas.parentElement || document.body;
    try { if (getComputedStyle(host).position === "static") host.classList.add("cv-host"); } catch (e) { /* not in the DOM yet */ }
    canvas.classList.add("cv-canvas");
    const prefs = Object.assign({ projection: "iso" }, opt.persist === false ? {} : loadPrefs());
    prefs.rot = 0; // rotation is a tested parameter of the projection with no UI in v1: never restored
    let scene = null, movers = null, cam = null, mini = null, town = null;
    let running = false, raf = 0, lastT = 0, lastCamSent = 0, camDirty = true, lastSave = 0;
    let selected = null, pendingState = null, pendingSpeed = 1, inset = { top: 0, right: 0, bottom: 0 };
    let lastClick = null, highlightRaw = null, overlayRaw = null, gaps = [], dprCap = 2, slowChecked = 0;
    let camLate = false, saveLate = false; // a camera report or a save held back by its rate limit, sent later
    const dynamic = opt.dynamicResolution !== false;

    // --- the .cv-* controls -----------------------------------------------------------------------------
    const ctl = el("div", "cv-ctl");
    const bIn = el("button", "cv-btn", "+"), bOut = el("button", "cv-btn", "−"), bFit = el("button", "cv-btn", "⤢"), bView = el("button", "cv-btn cv-btn-view", "View");
    ctl.setAttribute("role", "group"); ctl.setAttribute("aria-label", "Map controls");
    bIn.title = "Zoom in (+)"; bOut.title = "Zoom out (−)"; bFit.title = "Fit the city (0)"; bView.title = "View options";
    for (const b of [bIn, bOut, bFit, bView]) { b.type = "button"; ctl.appendChild(b); }
    bIn.setAttribute("aria-label", "Zoom in"); bOut.setAttribute("aria-label", "Zoom out"); bFit.setAttribute("aria-label", "Whole city");
    bView.setAttribute("aria-haspopup", "true");
    const menu = el("div", "cv-menu");
    const mIso = el("button", "cv-menu-item", "Isometric"), mFlat = el("button", "cv-menu-item", "Top-down"), mMini = el("button", "cv-menu-item", "Minimap");
    const mHomes = el("button", "cv-menu-item", "Homes");
    mHomes.title = "Colour the homes on the minimap by condition (on by itself when zoomed out)";
    for (const b of [mIso, mFlat, mMini, mHomes]) { b.type = "button"; menu.appendChild(b); }
    ctl.appendChild(menu);
    const chip = el("div", "cv-follow");
    const chipName = el("button", "cv-follow-name"), chipX = el("button", "cv-follow-x", "✕");
    chipName.type = chipX.type = "button"; chipX.title = "Stop following"; chipX.setAttribute("aria-label", "Stop following");
    chip.appendChild(chipName); chip.appendChild(chipX);
    host.appendChild(ctl); host.appendChild(chip);
    bIn.addEventListener("click", () => cam && cam.zoomIn());
    bOut.addEventListener("click", () => cam && cam.zoomOut());
    bFit.addEventListener("click", () => cam && cam.fit());
    bView.addEventListener("click", ev => { ev.stopPropagation(); menu.classList.toggle("cv-open"); syncMenu(); });
    document.addEventListener("click", ev => { if (!ctl.contains(ev.target)) menu.classList.remove("cv-open"); });
    mIso.addEventListener("click", () => { view.setMode({ projection: "iso" }); menu.classList.remove("cv-open"); });
    mFlat.addEventListener("click", () => { view.setMode({ projection: "flat" }); menu.classList.remove("cv-open"); });
    mMini.addEventListener("click", () => { if (mini) mini.setOpen(!mini.isOpen()); syncMenu(); refreshReserved(); });
    mHomes.addEventListener("click", () => {
      if (!mini) return;
      mini.setHomes(!mini.homesOn());
      if (mini.homesOn() && !mini.isOpen()) mini.setOpen(true);
      prefs.homes = mini.homesPref(); syncMenu(); persist(true); refreshReserved();
    });
    chipX.addEventListener("click", () => { if (cam) cam.follow = null; syncChip(); emitCamera(true); });
    chipName.addEventListener("click", () => { if (cam && selected) cam.follow = selected; syncChip(); emitCamera(true); });
    function syncMenu() {
      const proj = scene ? scene.proj.kind : prefs.projection;
      mIso.classList.toggle("cv-on", proj === "iso"); mFlat.classList.toggle("cv-on", proj === "flat");
      mMini.classList.toggle("cv-on", !!(mini && mini.isOpen()));
      mHomes.disabled = !mini; mHomes.classList.toggle("cv-on", !!(mini && mini.homesOn()));
    }
    function nameOf(id) { const a = movers && movers.agent(id); return a ? (a.name || id) : id; }
    function syncChip() {
      const on = !!(cam && selected);
      if (chip.classList.contains("cv-show") !== on) reservedAt = 0;
      chip.classList.toggle("cv-show", on);
      if (!on) return;
      const first = String(nameOf(selected)).split(" ")[0];
      chip.classList.toggle("cv-paused", !cam.follow);
      chipName.textContent = cam.follow ? `Following ${first}` : `Follow ${first}`;
      chipX.style.display = cam.follow ? "" : "none";
      placeChip();
    }
    // The zoom stack top-right under the page's top inset, the minimap bottom-right, the follow chip
    // bottom-centre of the free area (PLAN decision 31), lifted over the minimap when the two would meet.
    function placeControls() {
      ctl.style.top = (inset.top + 10) + "px"; ctl.style.right = (inset.right + 10) + "px";
      if (mini) { mini.el.style.right = (inset.right + 10) + "px"; mini.el.style.bottom = (inset.bottom + 10) + "px"; }
      placeChip();
    }
    function placeChip() {
      const w = canvas.clientWidth || host.clientWidth || 800, cx = (w - inset.right) / 2;
      chip.style.left = Math.round(cx) + "px";
      let bottom = inset.bottom + 10;
      if (mini && chip.classList.contains("cv-show")) {
        const half = (chip.offsetWidth || 160) / 2, mw = mini.el.offsetWidth, mh = mini.el.offsetHeight;
        if (mw && cx + half + 8 > w - inset.right - 10 - mw) bottom += mh + 8;
      }
      chip.style.bottom = bottom + "px";
    }
    // The screen rects (CSS px, canvas-relative) the map's labels keep clear of: the view's own controls
    // and any page element marked data-cv-avoid (or matching opt.avoid). Refreshed a few times a second.
    let reservedAt = 0;
    function refreshReserved() {
      reservedAt = performance.now();
      if (!scene) return;
      const cr = canvas.getBoundingClientRect(), rects = [];
      const add = e => {
        if (!e || !e.isConnected) return;
        const r = e.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return;
        rects.push([r.left - cr.left, r.top - cr.top, r.right - cr.left, r.bottom - cr.top]);
      };
      for (const b of ctl.children) add(b);
      if (chip.classList.contains("cv-show")) add(chip);
      if (mini) add(mini.el);
      try { for (const e of document.querySelectorAll(opt.avoid || "[data-cv-avoid]")) add(e); } catch (e) { /* a bad selector */ }
      scene.reserved = rects;
    }

    // --- backing store --------------------------------------------------------------------------------
    // Ground chunks are capped by area: 12 MP, or 6 MP on touch screens narrower than 900 CSS px.
    const chunkBudget = () => {
      let coarse = false;
      try { coarse = window.matchMedia("(pointer: coarse)").matches; } catch (e) { /* no media queries */ }
      return coarse && (canvas.clientWidth || host.clientWidth || 800) < 900 ? 6e6 : 12e6;
    };
    function resize() {
      const w = canvas.clientWidth || host.clientWidth || 800, h = canvas.clientHeight || host.clientHeight || 600;
      const dpr = Math.min(dprCap, window.devicePixelRatio || 1);
      const bw = Math.max(1, Math.round(w * dpr)), bh = Math.max(1, Math.round(h * dpr));
      if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
      if (scene) { scene.dpr = bw / w; scene.chunkBudget = chunkBudget(); }
      camDirty = true;
    }
    let ro = null;
    const onResize = () => {
      resize();
      if (mini && mini.resize()) { mini.draw(performance.now(), true); syncMenu(); }
      if (cam) cam.clamp();
      placeControls();
      refreshReserved();
      if (!running && scene) frame(performance.now());
    };
    if (window.ResizeObserver) { ro = new ResizeObserver(onResize); ro.observe(canvas); }
    else window.addEventListener("resize", onResize);
    resize();

    // --- town, scene and camera --------------------------------------------------------------------------
    // A place id, or a home id resolved through town.homes (a flat's id gives its block).
    function resolvePlace(id) {
      if (!scene || id == null) return null;
      if (scene.placeById.has(id)) return town.places[scene.placeById.get(id)];
      const h = (town.homes || []).find(x => x.id === id);
      return h && scene.placeById.has(h.place) ? town.places[scene.placeById.get(h.place)] : null;
    }
    const placeIdOf = id => { const p = resolvePlace(id); return p ? p.id : null; };
    // World px of a focus target, the default zoom for it, and the ground tile a ping marks.
    function targetOf(t) {
      if (!scene || !t) return null;
      const proj = scene.proj;
      if (t.agent != null) {
        const r = movers.byId(t.agent);
        if (r && r.foot) {
          const p = r.place && !r.item ? resolvePlace(r.place) : null; // inside: the building's ground centre
          return { w: r.foot, zoom: 2, tile: p ? [p.x + p.w / 2, p.y + p.h / 2] : proj.toTile(r.foot[0], r.foot[1]) };
        }
        const a = movers.agent(t.agent);
        if (a) { const p = proj.toWorld(a.x + 0.5, a.y + 0.5); return { w: p, zoom: 2, tile: [a.x + 0.5, a.y + 0.5] }; }
        return null;
      }
      if (t.place != null) {
        const p = resolvePlace(t.place);
        if (!p) return null;
        const rec = scene.buildingOf(p.id);
        const w = rec ? rec.center : proj.toWorld(p.x + p.w / 2, p.y + p.h / 2);
        return { w, zoom: p.kind === "park" ? 1 : 1.5, tile: [p.x + p.w / 2, p.y + p.h / 2] };
      }
      if (t.tile) { const [x, y] = t.tile; return { w: proj.toWorld(x + 0.5, y + 0.5), zoom: 2, tile: [x + 0.5, y + 0.5] }; }
      if (t.district != null) {
        const d = (town.districts || []).find(q => q.id === t.district);
        if (!d || !d.rects || !d.rects.length) return null;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const r of d.rects) { x0 = Math.min(x0, r[0]); y0 = Math.min(y0, r[1]); x1 = Math.max(x1, r[0] + r[2]); y1 = Math.max(y1, r[1] + r[3]); }
        return { w: proj.toWorld((x0 + x1) / 2, (y0 + y1) / 2), zoom: 1, tile: [(x0 + x1) / 2, (y0 + y1) / 2] };
      }
      return null;
    }
    function followPos() {
      if (!cam || !cam.follow) return null;
      const r = movers.byId(cam.follow);
      return r && r.foot ? r.foot : null;
    }
    function emitCamera(force) {
      if (!hooks.onCamera) return;
      const now = performance.now();
      if (!force && now - lastCamSent < 100) { camLate = true; return; }
      camLate = false; lastCamSent = now;
      hooks.onCamera(view.camera());
    }
    // localStorage["goal.view"]: {projection, zoom, x, y, minimap, homes}, a per-viewer convenience only.
    function persist(force) {
      if (opt.persist === false) return;
      if (!scene) { savePrefs(Object.assign(loadPrefs(), { projection: prefs.projection })); return; }
      const now = performance.now();
      if (!force && now - lastSave < 600) { saveLate = true; return; }
      saveLate = false; lastSave = now;
      const t = scene.proj.toTile(cam.x, cam.y);
      savePrefs({ projection: scene.proj.kind, zoom: cam.zoom, x: +t[0].toFixed(2), y: +t[1].toFixed(2), minimap: mini ? mini.isOpen() : undefined, homes: mini ? mini.homesPref() : undefined });
    }
    // Picking (PLAN decision 80): the first upright candidate is the frontmost thing drawn under the point;
    // with none, the ground answers (a stop, a park or a home's lot, else the tile).
    const groundHit = gr => gr.find(h => h.kind === "stop") || gr.find(h => h.kind === "place") || gr.find(h => h.kind === "tile") || null;
    const sameHit = (a, b) => !!a && !!b && a.kind === b.kind && a.id === b.id;
    function onClick(x, y, touch) {
      if (!scene) return;
      for (const a of scene.pingArrows || []) if (x >= a.x0 - 4 && x <= a.x1 + 4 && y >= a.y0 - 4 && y <= a.y1 + 4) { view.focus(a.target); return; }
      const { upright, ground } = scene.pickAll(x, y, touch);
      let hit = null;
      const now = performance.now();
      if (upright.length) {
        // a second click on the same spot within 1.5 s takes the next candidate under it (stacked people)
        let idx = 0;
        if (lastClick && Math.hypot(x - lastClick.x, y - lastClick.y) <= 6 && now - lastClick.t < 1500 && upright.length > 1) {
          const k = upright.findIndex(h => sameHit(h, lastClick.hit));
          idx = k >= 0 ? (k + 1) % upright.length : 0;
        }
        hit = upright[idx];
        lastClick = { x, y, t: now, hit };
      } else {
        hit = groundHit(ground);
        lastClick = null;
      }
      if (hooks.onPick) hooks.onPick(hit, { cssX: x, cssY: y, touch: !!touch });
    }
    // Mouse hover, or a touch long-press (ev.touch true), which plays the hover's part on phones.
    function onHover(x, y, touch) {
      if (!scene) return;
      const { upright, ground } = scene.pickAll(x, y, touch);
      const hit = upright[0] || groundHit(ground);
      scene.hover = hit && hit.kind === "agent" ? hit.id : null;
      const tile = !touch && !upright.length ? ground.find(h => h.kind === "tile") : null;
      scene.hoverTile = tile ? [tile.x, tile.y] : null;
      if (hooks.onHover) hooks.onHover(hit, { cssX: x, cssY: y, touch: !!touch });
    }
    // Highlights and overlays may name home ids; the scene draws by place id.
    function applyHighlight() {
      if (!scene) return;
      const h = highlightRaw;
      scene.highlight = h ? { agents: (h.agents || []).slice(), places: [...new Set((h.places || []).map(placeIdOf).filter(Boolean))] } : null;
    }
    function applyOverlay() {
      if (!scene) return;
      const o = overlayRaw;
      if (!o) { scene.overlay = null; return; }
      const colors = {};
      for (const [id, c] of Object.entries(o.colors || {})) {
        const pid = scene.placeById.has(id) ? id : placeIdOf(id);
        if (pid && c && (colors[pid] == null || pid === id)) colors[pid] = c;
      }
      scene.overlay = { name: o.name, colors };
    }

    function build(t) {
      if (cam) cam.destroy();
      if (mini) mini.destroy();
      town = CV.normalizeTown(t);
      scene = CV.makeScene(canvas, town, { projection: prefs.projection === "flat" ? "flat" : "iso", rot: prefs.rot | 0 });
      scene.dpr = canvas.width / (canvas.clientWidth || canvas.width);
      scene.chunkBudget = chunkBudget();
      scene.inset = inset;
      if (opt.eager) scene.prewarm();
      if (opt.quality) scene.quality = opt.quality;
      movers = CV.makeMovers(scene);
      cam = CV.makeCamera(canvas, scene, {
        click: onClick,
        hover: (x, y) => onHover(x, y, false),
        longPress: (x, y) => onHover(x, y, true),
        leave: () => { scene.hover = null; scene.hoverTile = null; if (hooks.onHover) hooks.onHover(null, null); },
        followKey: () => { if (!selected) return; cam.follow = cam.follow ? null : selected; syncChip(); emitCamera(true); },
        followChange: () => { syncChip(); },
        // Esc: close the View menu, and deselect, telling the page (the one time the view changes the selection)
        escape: () => { menu.classList.remove("cv-open"); if (selected == null) return; view.select(null); if (hooks.onSelect) hooks.onSelect(null); },
        change: () => { camDirty = true; },
      });
      mini = opt.minimap === false ? null : CV.makeMinimap(host, scene, cam, { open: prefs.minimap, homes: prefs.homes, onToggle: () => { syncMenu(); persist(true); refreshReserved(); }, onFollowCancel: syncChip });
      placeControls();
      // initial view: the stored camera, else Downtown's centre (the map centre for older towns)
      const fit = cam.fitZoom();
      if (prefs.zoom && prefs.x != null && opt.persist !== false) {
        [cam.x, cam.y] = scene.proj.toWorld(prefs.x, prefs.y);
        cam.zoom = Math.max(Math.min(0.25, fit), Math.min(3, prefs.zoom));
      } else {
        const d = targetOf({ district: "downtown" });
        const c = d ? d.w : scene.proj.toWorld(town.w / 2, town.h / 2);
        [cam.x, cam.y] = c;
        const narrow = (canvas.clientWidth || host.clientWidth || 800) < 600;
        cam.zoom = opt.zoom || (fit > 1 ? Math.min(2, fit) : narrow ? 0.5 : 1);
      }
      if (selected) cam.follow = null;
      cam.clamp();
      syncMenu(); syncChip(); refreshReserved();
      if (pendingState) { const s = pendingState; pendingState = null; view.setState(s, pendingSpeed); }
      applyHighlight(); applyOverlay();
    }

    // --- the loop -------------------------------------------------------------------------------------
    function frame(now) {
      if (!scene) return;
      const dt = lastT ? Math.min(0.1, (now - lastT) / 1000) : 0;
      if (lastT && dynamic) adapt(now - lastT, now);
      lastT = now;
      movers.update(now);
      cam.update(dt, followPos());
      if (!cam.follow && chip.classList.contains("cv-show") && !chip.classList.contains("cv-paused")) syncChip();
      scene.selected = selected;
      if (now - reservedAt > 250) refreshReserved();
      scene.draw(now);
      if (mini) mini.draw(now);
      if (camDirty) { camDirty = false; emitCamera(false); persist(false); }
      else { if (camLate) emitCamera(false); if (saveLate) persist(false); } // the last move is never dropped
    }
    // Dynamic resolution: when frames are slow for 2 s, step the backing store down, then quality.
    function adapt(gap, now) {
      if (document.hidden) return;
      gaps.push(gap);
      if (now - slowChecked < 2000) return;
      slowChecked = now;
      const sorted = gaps.slice().sort((a, b) => a - b), med = sorted[sorted.length >> 1] || 0;
      gaps = [];
      if (med <= 24) return;
      const dpr = window.devicePixelRatio || 1;
      if (Math.min(dprCap, dpr) > 1.5) { dprCap = 1.5; resize(); }
      else if (Math.min(dprCap, dpr) > 1) { dprCap = 1; resize(); }
      else if (scene.quality !== "low") scene.quality = "low";
    }
    function loop(now) { if (!running) return; frame(now); raf = requestAnimationFrame(loop); }

    // --- the facade -----------------------------------------------------------------------------------
    const view = {
      setTown(t) { build(t); if (!running) frame(performance.now()); },
      setState(st, speed) {
        if (!st) return;
        if (!scene) { pendingState = st; pendingSpeed = speed; return; }
        scene.state = st;
        if (st.minute != null) scene.minute = st.minute;
        if (st.season) scene.setSeason(st.season);
        scene.weather = st.weather || "clear";
        if (st.lights) scene.setLights(st.lights);
        const changed = movers.setState(st, speed, performance.now());
        if (changed && mini) mini.rebuild();
        if (selected && !movers.agent(selected)) { /* the selected agent left the state; keep the id */ }
      },
      select(id, o) {
        selected = id == null ? null : id;
        if (scene) scene.selected = selected;
        if (cam) cam.follow = selected && (!o || o.follow !== false) ? selected : null;
        syncChip(); emitCamera(true);
      },
      focus(target, o) {
        o = o || {};
        const t = targetOf(target);
        if (!t || !cam) return false;
        const z = o.zoom || Math.max(cam.zoom, t.zoom);
        let [wx, wy] = t.w;
        if (o.inset) {
          const a = o.inset, b = inset;
          wx += ((a.right || 0) - (b.right || 0)) / 2 / z;
          wy -= (((a.top || 0) - (b.top || 0)) - ((a.bottom || 0) - (b.bottom || 0))) / 2 / z;
        }
        if (target.agent == null && cam.follow) { cam.follow = null; syncChip(); }
        cam.flyTo(wx, wy, z, o.ms || 600);
        return true;
      },
      highlight(h) { highlightRaw = h && ((h.agents && h.agents.length) || (h.places && h.places.length)) ? h : null; applyHighlight(); },
      setOverlay(name, colors) { overlayRaw = name ? { name, colors: Object.assign({}, colors || {}) } : null; applyOverlay(); },
      ping(target, topic) {
        const t = targetOf(target);
        if (!t || !scene) return false;
        scene.pings.push({ x: t.tile[0], y: t.tile[1], color: PING_COL[topic] || PING_COL.other, topic: PING_COL[topic] ? topic : "other",
          t0: performance.now(), target: Object.assign({}, target) });
        if (scene.pings.length > 40) scene.pings.splice(0, scene.pings.length - 40);
        return true;
      },
      setInset(i) {
        inset = { top: (i && i.top) || 0, right: (i && i.right) || 0, bottom: (i && i.bottom) || 0 };
        if (scene) scene.inset = inset;
        placeControls(); refreshReserved(); camDirty = true;
        if (cam) cam.clamp();
      },
      setMode(m) {
        const kind = m && m.projection === "flat" ? "flat" : "iso";
        prefs.projection = kind;
        if (m && m.rot != null) prefs.rot = ((m.rot | 0) % 4 + 4) % 4;
        if (!scene) { syncMenu(); persist(true); return; }
        const rot = kind === "iso" ? prefs.rot | 0 : 0;
        if (scene.proj.kind === kind && scene.proj.rot === rot) { syncMenu(); return; }
        const t = scene.proj.toTile(cam.x, cam.y);
        scene.setProjection(kind, rot);
        [cam.x, cam.y] = scene.proj.toWorld(t[0], t[1]);
        if (mini) mini.rebuild();
        syncMenu(); persist(true); emitCamera(true); camDirty = true;
        if (!running) frame(performance.now());
      },
      camera() {
        if (!cam) return { x: 0, y: 0, zoom: 1, follow: null, projection: prefs.projection };
        const t = scene.proj.toTile(cam.x, cam.y);
        return { x: t[0], y: t[1], zoom: cam.zoom, follow: cam.follow || null, projection: scene.proj.kind, rot: scene.proj.rot };
      },
      start() { if (running) return; running = true; lastT = 0; raf = requestAnimationFrame(loop); },
      stop() { running = false; cancelAnimationFrame(raf); },
      // extras for the dev page and tests
      pick(x, y, touch) { if (!scene) return null; const { upright, ground } = scene.pickAll(x, y, touch); return upright[0] || groundHit(ground); },
      pickAll(x, y, touch) { if (!scene) return []; const { upright, ground } = scene.pickAll(x, y, touch); return upright.concat(ground); },
      selected() { return selected; },
      settle() { if (movers) { movers.settle(); movers.update(performance.now()); } },
      // CSS px (canvas-relative) of a target: a person's sprite middle, a place's label point, a tile's centre
      screenOf(t) {
        if (!scene || !t) return null;
        if (t.agent != null) {
          const r = movers.byId(t.agent);
          if (r && r.item) { const it = r.item, h = it.hit || [0, 0, it.sw, it.sh]; return scene.worldToCss(it.wx + (h[0] + h[2]) / 2, it.wy + (h[1] + h[3]) / 2); }
          return r && r.foot ? scene.worldToCss(r.foot[0], r.foot[1]) : null;
        }
        if (t.place != null) { const p = resolvePlace(t.place), rec = p && scene.buildingOf(p.id); if (rec) return scene.worldToCss(rec.center[0], rec.center[1]); }
        const g = targetOf(t);
        if (!g) return null;
        const w = scene.proj.toWorld(g.tile[0], g.tile[1]);
        return scene.worldToCss(w[0], w[1]);
      },
      click(x, y, touch) { onClick(x, y, touch); },
      frame(now) { frame(now == null ? performance.now() : now); return scene ? scene.stats.draw : 0; },
      scene() { return scene; },
      cam() { return cam; },
      setCamera(c) {
        if (!cam) return;
        if (c.zoom) cam.zoom = c.zoom;
        if (c.x != null && c.y != null) [cam.x, cam.y] = scene.proj.toWorld(c.x, c.y);
        if (c.fit) cam.fit(true);
        cam.clamp();
        camDirty = true;
      },
      worldOfTile(x, y, z) { return scene ? scene.proj.toWorld(x, y, z) : null; },
      cssOfTile(x, y, z) { if (!scene) return null; const w = scene.proj.toWorld(x, y, z); return scene.worldToCss(w[0], w[1]); },
      destroy() { view.stop(); if (ro) ro.disconnect(); if (cam) cam.destroy(); if (mini) mini.destroy(); ctl.remove(); chip.remove(); },
    };
    return view;
  };
})();

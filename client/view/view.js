// CityView facade: CityView.create(canvas, hooks) wires the scene, movers, camera and minimap to a canvas,
// owns the animation loop and the backing-store size, adds the .cv-* controls next to the canvas, and
// exposes the methods game.js and the dashboard call (PLAN 3.12). It never sends messages.
// Classic script on window.CityView.
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
    const prefs = Object.assign({ projection: "iso", rot: 0 }, opt.persist === false ? {} : loadPrefs());
    let scene = null, movers = null, cam = null, mini = null, town = null;
    let running = false, raf = 0, lastT = 0, lastCamSent = 0, camDirty = true, lastSave = 0;
    let selected = null, pendingState = null, pendingSpeed = 1, inset = { top: 0, right: 0, bottom: 0 };
    let lastClick = null, highlightV = null, overlayV = null, gaps = [], dprCap = 2, slowChecked = 0;
    const dynamic = opt.dynamicResolution !== false;

    // --- the .cv-* controls -----------------------------------------------------------------------------
    const ctl = el("div", "cv-ctl");
    const bIn = el("button", "cv-btn", "+"), bOut = el("button", "cv-btn", "−"), bFit = el("button", "cv-btn", "⤢"), bView = el("button", "cv-btn cv-btn-view", "View");
    bIn.title = "Zoom in (+)"; bOut.title = "Zoom out (−)"; bFit.title = "Fit the city (0)"; bView.title = "View options";
    for (const b of [bIn, bOut, bFit, bView]) { b.type = "button"; ctl.appendChild(b); }
    const menu = el("div", "cv-menu");
    const mIso = el("button", "cv-menu-item", "Isometric"), mFlat = el("button", "cv-menu-item", "Top-down"), mRot = el("button", "cv-menu-item", "Rotate ↻"), mMini = el("button", "cv-menu-item", "Minimap");
    const mHomes = el("button", "cv-menu-item", "Homes");
    mHomes.title = "Colour the homes on the minimap by condition (on by itself when zoomed out)";
    for (const b of [mIso, mFlat, mRot, mMini, mHomes]) { b.type = "button"; menu.appendChild(b); }
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
    mRot.addEventListener("click", () => rotate(1));
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
      mRot.disabled = proj !== "iso"; mMini.classList.toggle("cv-on", !!(mini && mini.isOpen()));
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
    }
    function placeControls() {
      ctl.style.top = (inset.top + 10) + "px"; ctl.style.right = (inset.right + 10) + "px";
      chip.style.top = (inset.top + 10) + "px";
      if (mini) { mini.el.style.right = (inset.right + 10) + "px"; mini.el.style.bottom = (inset.bottom + 10) + "px"; }
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
    function resize() {
      const w = canvas.clientWidth || host.clientWidth || 800, h = canvas.clientHeight || host.clientHeight || 600;
      const dpr = Math.min(dprCap, window.devicePixelRatio || 1);
      const bw = Math.max(1, Math.round(w * dpr)), bh = Math.max(1, Math.round(h * dpr));
      if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
      if (scene) scene.dpr = bw / w;
      camDirty = true;
    }
    let ro = null;
    const onResize = () => {
      resize();
      if (mini && mini.resize()) { mini.draw(performance.now(), true); syncMenu(); }
      if (cam) cam.clamp();
      refreshReserved();
      if (!running && scene) frame(performance.now());
    };
    if (window.ResizeObserver) { ro = new ResizeObserver(onResize); ro.observe(canvas); }
    else window.addEventListener("resize", onResize);
    resize();

    // --- town, scene and camera --------------------------------------------------------------------------
    function resolvePlace(id) {
      if (!scene || id == null) return null;
      if (scene.placeById.has(id)) return town.places[scene.placeById.get(id)];
      const h = (town.homes || []).find(x => x.id === id);
      return h && scene.placeById.has(h.place) ? town.places[scene.placeById.get(h.place)] : null;
    }
    // World px of a focus target, and the default zoom for it.
    function targetOf(t) {
      if (!scene || !t) return null;
      const proj = scene.proj;
      if (t.agent != null) {
        const r = movers.byId(t.agent);
        if (r && r.foot) return { w: r.foot, zoom: 2, tile: proj.toTile(r.foot[0], r.foot[1]) };
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
      if (!force && now - lastCamSent < 100) return;
      lastCamSent = now;
      hooks.onCamera(view.camera());
    }
    function persist(force) {
      if (opt.persist === false || !scene) return;
      const now = performance.now();
      if (!force && now - lastSave < 600) return;
      lastSave = now;
      const t = scene.proj.toTile(cam.x, cam.y);
      savePrefs({ projection: scene.proj.kind, rot: scene.proj.rot, zoom: cam.zoom, x: +t[0].toFixed(2), y: +t[1].toFixed(2), minimap: mini ? mini.isOpen() : undefined, homes: mini ? mini.homesPref() : undefined });
    }
    function rotate(dir) {
      if (!scene || scene.proj.kind !== "iso") return;
      const t = scene.proj.toTile(cam.x, cam.y);
      scene.setProjection("iso", (scene.proj.rot + dir + 4) % 4);
      prefs.rot = scene.proj.rot;
      [cam.x, cam.y] = scene.proj.toWorld(t[0], t[1]);
      if (mini) mini.rebuild();
      camDirty = true; persist(true); emitCamera(true);
    }
    function pickCandidates(x, y, touch) {
      const all = scene.pickAll(x, y, touch);
      const upright = all.filter(h => h.kind === "agent" || h.kind === "bus" || (h.kind === "place" && scene.buildingOf(h.id)));
      return { all, upright };
    }
    function onClick(x, y, touch) {
      if (!scene) return;
      const { all, upright } = pickCandidates(x, y, touch);
      let hit = null;
      const now = performance.now();
      if (upright.length) {
        let idx = 0;
        if (lastClick && Math.hypot(x - lastClick.x, y - lastClick.y) <= 6 && now - lastClick.t < 1500 && upright.length > 1) idx = (lastClick.idx + 1) % upright.length;
        hit = upright[idx];
        lastClick = { x, y, t: now, idx };
      } else {
        hit = all.find(h => h.kind === "stop") || all.find(h => h.kind === "place") || all.find(h => h.kind === "tile") || null;
        lastClick = null;
      }
      if (hooks.onPick) hooks.onPick(hit, { cssX: x, cssY: y, touch: !!touch });
    }
    function onHover(x, y, touch) {
      if (!scene) return;
      const { all, upright } = pickCandidates(x, y, touch);
      const hit = upright[0] || all.find(h => h.kind === "stop") || all.find(h => h.kind === "place") || all.find(h => h.kind === "tile") || null;
      scene.hover = hit && (hit.kind === "agent") ? hit.id : null;
      if (hooks.onHover) hooks.onHover(hit, { cssX: x, cssY: y, touch: !!touch });
    }

    function build(t) {
      if (cam) cam.destroy();
      if (mini) mini.destroy();
      town = CV.normalizeTown(t);
      scene = CV.makeScene(canvas, town, { projection: prefs.projection === "flat" ? "flat" : "iso", rot: prefs.rot | 0 });
      scene.dpr = canvas.width / (canvas.clientWidth || canvas.width);
      scene.inset = inset;
      if (opt.eager) scene.prewarm();
      if (opt.quality) scene.quality = opt.quality;
      movers = CV.makeMovers(scene);
      cam = CV.makeCamera(canvas, scene, {
        click: onClick,
        hover: (x, y) => onHover(x, y, false),
        longPress: (x, y) => onHover(x, y, true),
        leave: () => { scene.hover = null; if (hooks.onHover) hooks.onHover(null, null); },
        followKey: () => { if (!selected) return; cam.follow = cam.follow ? null : selected; syncChip(); emitCamera(true); },
        followChange: () => { syncChip(); },
        escape: () => { if (selected == null) return; view.select(null); if (hooks.onSelect) hooks.onSelect(null); },
        rotate,
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
      if (highlightV) scene.highlight = highlightV;
      if (overlayV) scene.overlay = overlayV;
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
      highlight(h) { highlightV = h || null; if (scene) scene.highlight = highlightV; },
      setOverlay(name, colors) { overlayV = name ? { name, colors: colors || null } : null; if (scene) scene.overlay = overlayV; },
      ping(target, topic) {
        const t = targetOf(target);
        if (!t || !scene) return false;
        scene.pings.push({ x: t.tile[0], y: t.tile[1], color: PING_COL[topic] || PING_COL.other, t0: performance.now() });
        return true;
      },
      setInset(i) {
        inset = { top: (i && i.top) || 0, right: (i && i.right) || 0, bottom: (i && i.bottom) || 0 };
        if (scene) scene.inset = inset;
        placeControls(); camDirty = true;
      },
      setMode(m) {
        const kind = m && m.projection === "flat" ? "flat" : "iso";
        prefs.projection = kind;
        if (m && m.rot != null) prefs.rot = ((m.rot | 0) % 4 + 4) % 4;
        if (!scene) { syncMenu(); return; }
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
      pick(x, y, touch) { if (!scene) return null; const { all, upright } = pickCandidates(x, y, touch); return upright[0] || all.find(h => h.kind !== "tile") || all[0] || null; },
      pickAll(x, y, touch) { return scene ? scene.pickAll(x, y, touch) : []; },
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

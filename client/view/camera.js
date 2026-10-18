// CityView camera and input: drag and touch pan with a fling, wheel, pinch, double-click, button and key
// zoom about a point, snapping to the crisp zoom steps, bounds in tile space, follow, animated fly-to and
// fit. The camera centre (cam.x, cam.y) is in world px; zoom 1 shows world px 1:1 in CSS px.
// Classic script on window.CityView.
"use strict";
(function () {
  const CV = window.CityView = window.CityView || {};
  // view.md 3.7: 1/16 to 3. Older (small) towns keep v2's steps from 1/4, so they work unchanged.
  const ALL_STEPS = [0.0625, 0.125, 0.25, 0.5, 1, 1.5, 2, 3];
  CV.ZOOM_STEPS = ALL_STEPS;
  // The region's default view (Millbrook and Riverton Central) and Millbrook's (the M key), in tiles.
  CV.DEFAULT_VIEW = { zoom: 0.25, x: 85, y: 48 };
  CV.MILLBROOK_VIEW = { zoom: 0.5, x: 40, y: 25 };
  const ease = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

  CV.makeCamera = function (cv, scene, hooks) {
    hooks = hooks || {};
    const cam = scene.cam;
    const big = !!scene.big, STEPS = big ? ALL_STEPS : ALL_STEPS.filter(s => s >= 0.25), EDGE = big ? 2 : 0;
    cam.steps = STEPS;
    cam.follow = null; cam.vx = 0; cam.vy = 0;
    const keys = new Set(), ptrs = new Map();
    const ac = new AbortController(), on = (el, type, fn, o) => el.addEventListener(type, fn, Object.assign({ signal: ac.signal }, o || {}));
    let drag = null, pinch = null, snapTimer = 0, zoomAnim = null, fly = null, press = null;
    const css = ev => { const r = cv.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; };
    const size = () => { const r = cv.getBoundingClientRect(); return [r.width || cv.width / scene.dpr, r.height || cv.height / scene.dpr]; };
    const changed = () => { if (hooks.change) hooks.change(); };

    // Bounds: when the whole city fits on screen the camera stays on its centre (nothing to pan to);
    // closer in, the centre stays over the map, inside [0, w] x [0, h] tiles.
    function clamp() {
      const p = scene.proj;
      if (cam.zoom <= cam.fitZoom() * 1.0001) {
        const B = scene.bounds(), cx = (B.x0 + B.x1) / 2, cy = (B.y0 + B.y1) / 2;
        if (cam.x !== cx || cam.y !== cy) { cam.x = cx; cam.y = cy; cam.vx = cam.vy = 0; }
        return;
      }
      const [tx, ty] = p.toTile(cam.x, cam.y);
      const cx = Math.max(-EDGE, Math.min(p.w + EDGE, tx)), cy = Math.max(-EDGE, Math.min(p.h + EDGE, ty));
      if (cx !== tx || cy !== ty) { [cam.x, cam.y] = p.toWorld(cx, cy); cam.vx = cam.vy = 0; }
    }
    cam.clamp = clamp;
    // The zoom at which the whole city fits in the area the UI leaves free.
    cam.fitZoom = function () {
      const B = scene.bounds(), [w, h] = size(), ins = scene.inset;
      const aw = Math.max(80, w - (ins.right || 0)), ah = Math.max(80, h - (ins.top || 0) - (ins.bottom || 0));
      return Math.min(aw / (B.x1 - B.x0), ah / (B.y1 - B.y0)) * 0.97;
    };
    const minZoom = () => Math.min(STEPS[0], cam.fitZoom());
    const maxZoom = () => STEPS[STEPS.length - 1];
    function zoomAt(x, y, z) {
      z = Math.max(minZoom(), Math.min(maxZoom(), z));
      const [wx, wy] = scene.cssToWorld(x, y);
      cam.zoom = z;
      const [wx2, wy2] = scene.cssToWorld(x, y);
      cam.x += wx - wx2; cam.y += wy - wy2;
      clamp(); changed();
    }
    const nearestStep = z => STEPS.reduce((b, s) => Math.abs(Math.log(s / z)) < Math.abs(Math.log(b / z)) ? s : b, STEPS[0]);
    // After a wheel or pinch gesture, ease to the nearest step so the pixel art stays crisp.
    function snapSoon(x, y) {
      clearTimeout(snapTimer);
      snapTimer = setTimeout(() => {
        const fit = cam.fitZoom();
        let z = nearestStep(cam.zoom);
        if (cam.zoom < STEPS[0] && fit < STEPS[0]) z = Math.abs(Math.log(fit / cam.zoom)) < Math.abs(Math.log(STEPS[0] / cam.zoom)) ? fit : STEPS[0];
        animateZoom(x, y, Math.max(minZoom(), z));
      }, 180);
    }
    function animateZoom(x, y, z) { if (Math.abs(z - cam.zoom) > 1e-4) zoomAnim = { x, y, from: cam.zoom, to: z, t: 0 }; }
    function step(dir, x, y) {
      const [w, h] = size(), ins = scene.inset;
      if (x == null) { x = (w - (ins.right || 0)) / 2; y = ((ins.top || 0) + h - (ins.bottom || 0)) / 2; }
      const cur = zoomAnim ? zoomAnim.to : cam.zoom;
      let next;
      if (dir > 0) next = STEPS.find(s => s > cur * 1.01) || maxZoom();
      else next = [...STEPS].reverse().find(s => s < cur * 0.99) || minZoom();
      if (dir < 0 && next < minZoom()) next = minZoom();
      animateZoom(x, y, next);
    }
    const cancelFollow = () => { if (cam.follow) { cam.follow = null; if (hooks.followChange) hooks.followChange(null); } };

    on(cv, "pointerdown", ev => {
      if (ev.button > 0) return;
      try { cv.setPointerCapture(ev.pointerId); } catch (e) { /* capture is optional */ }
      const [x, y] = css(ev);
      ptrs.set(ev.pointerId, { x, y, x0: x, y0: y, t0: performance.now() });
      fly = null;
      if (ptrs.size === 1) {
        drag = { x, y, moved: 0, vx: 0, vy: 0, t: performance.now() }; cam.vx = cam.vy = 0;
        if (ev.pointerType === "touch") { clearTimeout(press); press = setTimeout(() => { if (drag && drag.moved <= 6 && hooks.longPress) { hooks.longPress(x, y); drag.long = true; } }, 500); }
      }
      if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, z: cam.zoom, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }; drag = null; clearTimeout(press);
      }
    });
    on(cv, "pointermove", ev => {
      const [x, y] = css(ev);
      const p = ptrs.get(ev.pointerId);
      if (!p) { if (hooks.hover && ev.pointerType !== "touch") hooks.hover(x, y); return; }
      p.x = x; p.y = y;
      if (pinch && ptrs.size === 2) {
        const [a, b] = [...ptrs.values()];
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        cam.x -= (mx - pinch.mx) / cam.zoom; cam.y -= (my - pinch.my) / cam.zoom; pinch.mx = mx; pinch.my = my;
        zoomAt(mx, my, pinch.z * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d);
        cancelFollow();
        return;
      }
      if (drag) {
        const dx = x - drag.x, dy = y - drag.y, now = performance.now(), dt = Math.max(1, now - drag.t);
        drag.moved += Math.abs(dx) + Math.abs(dy);
        if (drag.moved > 6) {
          clearTimeout(press);
          cam.x -= dx / cam.zoom; cam.y -= dy / cam.zoom; cancelFollow(); clamp(); changed();
          drag.vx = -dx / cam.zoom / dt * 1000; drag.vy = -dy / cam.zoom / dt * 1000;
          cv.classList.add("cv-grabbing");
        }
        drag.x = x; drag.y = y; drag.t = now;
      }
    });
    const up = ev => {
      const [x, y] = css(ev);
      const p = ptrs.get(ev.pointerId);
      ptrs.delete(ev.pointerId);
      clearTimeout(press);
      cv.classList.remove("cv-grabbing");
      if (pinch) { if (ptrs.size < 2) { snapSoon(x, y); pinch = null; } return; }
      if (drag && p && ev.type === "pointerup") {
        if (drag.long) { /* the long press showed a tooltip */ }
        else if (drag.moved <= 6 && performance.now() - p.t0 < 600) { if (hooks.click) hooks.click(x, y, ev.pointerType === "touch"); }
        else if (performance.now() - drag.t < 80) { cam.vx = drag.vx; cam.vy = drag.vy; } // fling
      }
      drag = null;
    };
    on(cv, "pointerup", up);
    on(cv, "pointercancel", up);
    on(cv, "pointerleave", ev => { if (ev.pointerType !== "touch" && hooks.leave) hooks.leave(); });
    on(cv, "wheel", ev => {
      ev.preventDefault();
      const [x, y] = css(ev);
      zoomAnim = null; fly = null;
      zoomAt(x, y, cam.zoom * Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0015)));
      snapSoon(x, y);
    }, { passive: false });
    on(cv, "dblclick", ev => { const [x, y] = css(ev); step(1, x, y); });
    const typing = () => { const a = document.activeElement; return a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable); };
    // The view's keys (PLAN 3.12): arrows and WASD pan, + / - / 0 zoom and fit, F follows, Esc deselects.
    // Rotation has no key in v1. Keys typed into a field, or already handled by the page, are left alone.
    const onKey = ev => {
      if (ev.defaultPrevented || typing() || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      const k = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key.toLowerCase();
      if (["arrowleft", "arrowright", "arrowup", "arrowdown", "w", "a", "s", "d"].includes(k)) { keys.add(k); keys.shift = ev.shiftKey; cancelFollow(); fly = null; ev.preventDefault(); }
      else if (k === "+" || k === "=") { step(1); ev.preventDefault(); }
      else if (k === "-" || k === "_") { step(-1); ev.preventDefault(); }
      else if (k === "0") { cam.fit(); ev.preventDefault(); }
      else if (k === "m" && big) { cam.millbrook(); ev.preventDefault(); }
      else if (k === "f") { if (hooks.followKey) hooks.followKey(); }
      else if (k === "escape") { if (hooks.escape) hooks.escape(); }
    };
    const offKey = ev => { keys.delete(ev.key.length === 1 ? ev.key.toLowerCase() : ev.key.toLowerCase()); keys.shift = ev.shiftKey; };
    const blur = () => keys.clear();
    on(window, "keydown", onKey);
    on(window, "keyup", offKey);
    on(window, "blur", blur);

    cam.zoomIn = () => step(1); cam.zoomOut = () => step(-1);
    cam.zoomTo = (z, animate) => { const [w, h] = size(); if (animate) animateZoom(w / 2, h / 2, z); else { cam.zoom = Math.max(minZoom(), Math.min(maxZoom(), z)); clamp(); changed(); } };
    cam.fit = function (instant) {
      const B = scene.bounds();
      cancelFollow();
      const z = cam.fitZoom();
      if (instant) { cam.x = (B.x0 + B.x1) / 2; cam.y = (B.y0 + B.y1) / 2; cam.zoom = Math.max(0.05, z); zoomAnim = null; fly = null; changed(); return; }
      cam.flyTo((B.x0 + B.x1) / 2, (B.y0 + B.y1) / 2, z, 450);
    };
    cam.centerOn = (wx, wy) => { cam.x = wx; cam.y = wy; clamp(); changed(); };
    // The region's default view (view.md 3.7), null for older towns; home() jumps there.
    cam.defaultView = () => big ? Object.assign({}, CV.DEFAULT_VIEW) : null;
    cam.home = () => { const d = cam.defaultView(); if (!d) return false; [cam.x, cam.y] = scene.proj.toWorld(d.x, d.y); cam.zoom = Math.max(minZoom(), d.zoom); fly = null; zoomAnim = null; clamp(); changed(); return true; };
    cam.millbrook = () => { const m = CV.MILLBROOK_VIEW, [x, y] = scene.proj.toWorld(m.x, m.y); cancelFollow(); cam.flyTo(x, y, m.zoom); };
    cam.minZoom = minZoom;
    // Ease the centre and zoom over ms with cubic in-out; zoom out a step mid-flight on long trips.
    cam.flyTo = function (wx, wy, zoom, ms) {
      zoom = Math.max(minZoom(), Math.min(maxZoom(), zoom || cam.zoom));
      const [w, h] = size();
      const screens = Math.hypot((wx - cam.x) * cam.zoom, (wy - cam.y) * cam.zoom) / Math.max(w, h);
      let dip = screens > 2 ? Math.log(2) : 0;
      if (big && screens > 3) { // a long fly is a 900 ms arc: out and back in, never below the minimum zoom
        ms = 900;
        dip = Math.min(Math.log(screens / 1.5), Math.max(0, (Math.log(cam.zoom) + Math.log(zoom)) / 2 - Math.log(minZoom())));
      }
      fly = { x0: cam.x, y0: cam.y, z0: cam.zoom, x1: wx, y1: wy, z1: zoom, t: 0, ms: ms || 600, dip };
      zoomAnim = null; cam.vx = cam.vy = 0;
    };
    // The projection changed: f maps an old world point to the new world. The centre and a flight's start and end
    // move with it, so a flight under way still lands on its target.
    cam.remap = function (f) {
      [cam.x, cam.y] = f(cam.x, cam.y);
      if (fly) { [fly.x0, fly.y0] = f(fly.x0, fly.y0); [fly.x1, fly.y1] = f(fly.x1, fly.y1); }
    };
    cam.busy = () => !!(fly || zoomAnim || drag || pinch || cam.vx || cam.vy || keys.size);
    cam.update = function (dt, followPos) {
      let kx = 0, ky = 0;
      if (keys.has("arrowleft") || keys.has("a")) kx -= 1;
      if (keys.has("arrowright") || keys.has("d")) kx += 1;
      if (keys.has("arrowup") || keys.has("w")) ky -= 1;
      if (keys.has("arrowdown") || keys.has("s")) ky += 1;
      if (kx || ky) { const sp = (keys.shift ? 1400 : 700) / cam.zoom * dt; cam.x += kx * sp; cam.y += ky * sp; clamp(); changed(); }
      if (!drag && (cam.vx || cam.vy)) {
        cam.x += cam.vx * dt; cam.y += cam.vy * dt; const f = Math.exp(-dt * 5); cam.vx *= f; cam.vy *= f;
        if (Math.hypot(cam.vx, cam.vy) * cam.zoom < 8) cam.vx = cam.vy = 0;
        clamp(); changed();
      }
      if (fly) {
        fly.t = Math.min(1, fly.t + dt * 1000 / fly.ms);
        const e = ease(fly.t);
        cam.x = fly.x0 + (fly.x1 - fly.x0) * e; cam.y = fly.y0 + (fly.y1 - fly.y0) * e;
        cam.zoom = Math.exp(Math.log(fly.z0) + (Math.log(fly.z1) - Math.log(fly.z0)) * e - fly.dip * Math.sin(Math.PI * fly.t));
        changed();
        if (fly.t >= 1) { cam.zoom = fly.z1; fly = null; clamp(); }
      }
      if (zoomAnim) {
        zoomAnim.t = Math.min(1, zoomAnim.t + dt / 0.14);
        const e = 1 - Math.pow(1 - zoomAnim.t, 3);
        zoomAt(zoomAnim.x, zoomAnim.y, zoomAnim.from * Math.pow(zoomAnim.to / zoomAnim.from, e));
        if (zoomAnim.t >= 1) zoomAnim = null;
      }
      if (cam.follow && followPos && !drag && !fly) {
        const k = 1 - Math.exp(-dt * 6);
        cam.x += (followPos[0] - cam.x) * k; cam.y += (followPos[1] - cam.y) * k; clamp(); changed();
      }
    };
    cam.destroy = () => { ac.abort(); clearTimeout(snapTimer); clearTimeout(press); };
    return cam;
  };
})();

// CityView LOD chunks and the build budget (view.md 3.2). CV.makeChunks(scene, painter) keeps baked 512-device-px
// chunks per layer (g ground, u uprights, c combined far, l night lights, o overlays) and level, LRU by area
// (24 MP, 10 on phones), with resumable bakes: a bake is a list of steps run until 6 ms have gone, then it yields
// and resumes next frame; a chunk shows only when complete, and a stale one draws until its replacement is.
// CV.makeBudget() is the 8 ms a frame of builds: at least one build runs every frame, so nothing starves.
// Classic script on window.CityView; no random numbers.
"use strict";
(function () {
  const CV = window.CityView = window.CityView || {};
  const CH = 512;          // chunk side in device px
  const YIELD_MS = 6;      // a bake yields after this much work
  CV.LOD_LEVELS = { near: [1, 0.5, 0.25], far: [0.125, 0.0625] };

  // The frame's build budget: begin() each frame; may() says whether another build may start (always the first);
  // run(fn) times it. unlimited (the first frame after setTown) builds everything the view needs.
  CV.makeBudget = function (ms) {
    const B = { MS: ms || 8, spent: 0, builds: 0, unlimited: false, sprites: 0 };
    B.begin = unlimited => { B.spent = 0; B.builds = 0; B.sprites = 0; B.unlimited = !!unlimited; };
    B.may = () => B.unlimited || B.builds === 0 || B.spent < B.MS;
    B.run = fn => { const a = performance.now(); const r = fn(); B.spent += performance.now() - a; B.builds++; return r; };
    B.left = () => B.unlimited ? 1e9 : B.MS - B.spent;
    return B;
  };

  // painter.job(layer, level, wx0, wy0, span) -> {c, steps: [fn(), ...]}: the canvas to bake into and its steps.
  // painter.origin() -> {x0, y0}: the world point of chunk (0, 0)'s corner at every level.
  CV.makeChunks = function (scene, painter) {
    const map = new Map();
    const C = { CH, cap: 24e6, frame: 0, built: 0, mp: 0, pending: 0 };
    const keyOf = (layer, level, cx, cy) => layer + level + ":" + cx + "," + cy;
    C.span = level => CH / level;
    C.range = (level, v) => {
      const o = painter.origin(), span = CH / level;
      return [Math.floor((v.x0 - o.x0) / span), Math.floor((v.y0 - o.y0) / span), Math.floor((v.x1 - o.x0) / span), Math.floor((v.y1 - o.y0) / span)];
    };
    C.begin = () => { C.frame++; C.pending = 0; };
    function entry(layer, level, cx, cy) {
      const k = keyOf(layer, level, cx, cy);
      let e = map.get(k);
      if (!e) {
        const o = painter.origin(), span = CH / level;
        e = { k, layer, level, cx, cy, wx0: o.x0 + cx * span, wy0: o.y0 + cy * span, span, c: null, job: null, stale: false, used: C.frame, tag: null };
        map.set(k, e);
      }
      e.used = C.frame;
      return e;
    }
    // Run a chunk's bake for up to YIELD_MS (one build of the budget). True when the chunk is complete.
    function work(e, budget) {
      if (!e.job) e.job = Object.assign({ i: 0 }, painter.job(e.layer, e.level, e.wx0, e.wy0, e.span, e));
      const J = e.job, t0 = performance.now(), lim = budget && budget.unlimited ? 1e9 : Math.max(1, Math.min(YIELD_MS, budget.left()));
      // each step's draws are rasterised before the clock is read (a one-pixel read), so the yield is honest
      const flush = CV.flushCanvas || (() => {});
      budget.run(() => { while (J.i < J.steps.length) { J.steps[J.i++](); flush(J.c); if (performance.now() - t0 >= lim) break; } });
      if (J.i < J.steps.length) return false;
      if (e.c) C.mp -= e.c.width * e.c.height;
      e.c = J.c; e.job = null; e.stale = !!J.dirty; e.tag = J.tag != null ? J.tag : null; C.built++;
      C.mp += e.c.width * e.c.height;
      evict();
      return true;
    }
    function evict(cap) {
      cap = cap == null ? C.cap : cap;
      if (C.mp <= cap) return;
      const old = [...map.values()].filter(e => e.c && e.used < C.frame).sort((a, b) => a.used - b.used);
      for (const e of old) { if (C.mp <= cap) break; C.mp -= e.c.width * e.c.height; map.delete(e.k); }
    }
    // Drop chunks not drawn this frame (oldest first) until the cache is at most cap px (the near view's share).
    C.trim = cap => evict(Math.max(0, cap));
    // The chunk to draw at (layer, level, cx, cy): its own canvas if complete (stale or not), else the bake runs
    // when the budget allows (missing chunks first); returns the entry (e.c may still be null).
    C.want = function (layer, level, cx, cy, budget) {
      const e = entry(layer, level, cx, cy);
      if (!e.c && budget.may()) work(e, budget);
      if (!e.c || e.stale) C.pending++;
      return e;
    };
    // After the visible pass: stale visible chunks, within what is left of the budget.
    C.refresh = function (budget) {
      for (const e of map.values()) {
        if (e.used !== C.frame || !e.stale || !e.c) continue;
        if (!budget.may() || budget.left() <= 0) break;
        work(e, budget);
      }
    };
    // Idle prefetch (view.md 3.2): bake one missing chunk of (layer, level) over the world rect r = {x0, y0, x1,
    // y1}, when the budget has room left this frame. True when it baked (or worked on) one; stale ones wait.
    C.prefetch = function (layer, level, r, budget) {
      if (budget.left() < 3) return false;
      const [cx0, cy0, cx1, cy1] = C.range(level, r);
      for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
        const e = map.get(keyOf(layer, level, cx, cy));
        if (e && e.c) continue; // (a stale one re-bakes when it is next drawn)
        work(entry(layer, level, cx, cy), budget);
        return true;
      }
      return false;
    };
    // Draw a chunk into g at view v (S, ox, oy); a missing one falls back to any cached level of the layer.
    C.draw = function (g, e, v) {
      const dx0 = Math.round(e.wx0 * v.S + v.ox), dy0 = Math.round(e.wy0 * v.S + v.oy);
      const dx1 = Math.round((e.wx0 + e.span) * v.S + v.ox), dy1 = Math.round((e.wy0 + e.span) * v.S + v.oy);
      if (e.c) { g.drawImage(e.c, 0, 0, e.c.width, e.c.height, dx0, dy0, dx1 - dx0, dy1 - dy0); return true; }
      const o = painter.origin();
      // coarser levels first (one draw), then finer ones (up to four)
      for (const l2 of [0.0625, 0.125, 0.25, 0.5, 1].filter(l => l < e.level).reverse().concat([0.0625, 0.125, 0.25, 0.5, 1].filter(l => l > e.level))) {
        const sp2 = CH / l2;
        // the other level's chunks under this one's rect (one when coarser, several when finer)
        const ax0 = Math.floor((e.wx0 - o.x0) / sp2), ay0 = Math.floor((e.wy0 - o.y0) / sp2);
        const ax1 = Math.floor((e.wx0 + e.span - 1e-6 - o.x0) / sp2), ay1 = Math.floor((e.wy0 + e.span - 1e-6 - o.y0) / sp2);
        if ((ax1 - ax0 + 1) * (ay1 - ay0 + 1) > 4) continue; // (sixteen scaled 512 px draws cost a frame in software)
        let any = false;
        for (let cy = ay0; cy <= ay1; cy++) for (let cx = ax0; cx <= ax1; cx++) {
          const f = map.get(keyOf(e.layer, l2, cx, cy));
          if (!f || !f.c) continue;
          // the overlap of the two rects, in world px
          const x0 = Math.max(e.wx0, f.wx0), y0 = Math.max(e.wy0, f.wy0), x1 = Math.min(e.wx0 + e.span, f.wx0 + f.span), y1 = Math.min(e.wy0 + e.span, f.wy0 + f.span);
          if (x1 <= x0 || y1 <= y0) continue;
          const k = f.c.width / f.span;
          const sx = (x0 - f.wx0) * k, sy = (y0 - f.wy0) * k, sw = (x1 - x0) * k, sh = (y1 - y0) * k;
          const qx0 = Math.round(x0 * v.S + v.ox), qy0 = Math.round(y0 * v.S + v.oy), qx1 = Math.round(x1 * v.S + v.ox), qy1 = Math.round(y1 * v.S + v.oy);
          if (sw >= 1 && sh >= 1 && qx1 > qx0 && qy1 > qy0) g.drawImage(f.c, sx, sy, sw, sh, qx0, qy0, qx1 - qx0, qy1 - qy0);
          f.used = C.frame; any = true;
        }
        if (any) return true;
      }
      return false;
    };
    // Invalidation (view.md 3.2): a world rect marks every chunk it touches stale, on all layers and levels.
    C.invalidate = function (wx0, wy0, wx1, wy1, layers) {
      for (const e of map.values()) {
        if (layers && !layers.includes(e.layer)) continue;
        // (a bake under way finishes and shows, marked stale, rather than starting over at every change)
        if (e.wx0 < wx1 && e.wx0 + e.span > wx0 && e.wy0 < wy1 && e.wy0 + e.span > wy0) { e.stale = true; if (e.job) e.job.dirty = true; }
      }
    };
    C.staleAll = layers => { for (const e of map.values()) if (!layers || layers.includes(e.layer)) { e.stale = true; if (e.job) e.job.dirty = true; } };
    C.clear = layers => { for (const [k, e] of map) if (!layers || layers.includes(e.layer)) { if (e.c) C.mp -= e.c.width * e.c.height; map.delete(k); } };
    C.entries = () => [...map.values()];
    C.size = () => { let n = 0; for (const e of map.values()) if (e.c) n++; return n; };
    return C;
  };
})();

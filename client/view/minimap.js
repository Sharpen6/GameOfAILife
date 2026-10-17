// CityView minimap: the whole city drawn once through the projection at a small scale (a diamond in iso),
// with dots for people and buses and the camera's view box redrawn at 5 Hz. Click or drag to centre the
// camera there. Collapsible; starts collapsed on narrow screens. Classic script on window.CityView.
"use strict";
(function () {
  const CV = window.CityView = window.CityView || {};
  const KIND_COL = { home: "#c98a5a", office: "#7f9fc6", townhall: "#d8cfb8", hospital: "#eef0f2", school: "#c0644a", market: "#e0a040",
    cafe: "#d07aa0", shop: "#b88ad8", bank: "#c8c0a8", works: "#8a8478" };
  const STYLE_COL = { apartments: "#b07a62", big_house: "#e0c49a" };

  CV.makeMinimap = function (host, scene, cam, opt) {
    opt = opt || {};
    const box = document.createElement("div");
    box.className = "cv-minimap";
    const head = document.createElement("button");
    head.type = "button"; head.className = "cv-minimap-toggle"; head.title = "Show or hide the minimap"; head.setAttribute("aria-label", "Toggle minimap");
    head.textContent = "Map";
    const c = document.createElement("canvas");
    c.className = "cv-minimap-canvas";
    box.appendChild(c); box.appendChild(head);
    host.appendChild(box);
    const MW = 200;
    let base = null, baseKey = "", s = 1, last = 0, open = opt.open != null ? opt.open : (host.clientWidth || window.innerWidth) >= 640;
    const setOpen = v => { open = v; box.classList.toggle("cv-collapsed", !open); if (opt.onToggle) opt.onToggle(open); };
    setOpen(open);
    head.addEventListener("click", () => setOpen(!open));

    function buildBase() {
      const proj = scene.proj, B = scene.bounds(), t = scene.town;
      s = MW / (B.x1 - B.x0);
      const w = MW, h = Math.ceil((B.y1 - B.y0) * s);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
      c.style.width = w + "px"; c.style.height = h + "px";
      base = CV.canvas(c.width, c.height);
      const g = base.getContext("2d");
      const k = s * dpr;
      g.setTransform(k, 0, 0, k, -B.x0 * k, -B.y0 * k);
      const S = CV.SEASON[scene.season] || CV.SEASON.summer;
      const col = { ".": S.grass, "#": "#5d6068", P: S.park, T: S.leaf[1], e: "#b8b0a0", "~": "#3a78b8", B: "#a08870", D: "#a08870" };
      const pidx = new Map();
      t.places.forEach(p => { for (let y = p.y; y < p.y + p.h; y++) for (let x = p.x; x < p.x + p.w; x++) pidx.set(y * t.w + x, p); });
      for (let y = 0; y < t.h; y++) for (let x = 0; x < t.w; x++) {
        const ch = t.tiles[y][x];
        let f = col[ch] || S.grass;
        if (ch === "B" || ch === "D") { const p = pidx.get(y * t.w + x); if (p) f = STYLE_COL[p.style] || KIND_COL[p.kind] || f; }
        g.fillStyle = f;
        const a = proj.toWorld(x, y), b = proj.toWorld(x + 1, y), cc = proj.toWorld(x + 1, y + 1), d = proj.toWorld(x, y + 1);
        g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.lineTo(cc[0], cc[1]); g.lineTo(d[0], d[1]); g.closePath(); g.fill();
        // a hairline seam keeps the tiles from leaving gaps when scaled
        g.strokeStyle = f; g.lineWidth = 1 / k; g.stroke();
      }
    }
    function toMini(wx, wy) { const B = scene.bounds(); return [(wx - B.x0) * s, (wy - B.y0) * s]; }
    function fromMini(mx, my) { const B = scene.bounds(); return [mx / s + B.x0, my / s + B.y0]; }

    function draw(now, force) {
      if (!open) return;
      if (!force && now - last < 200) return;
      last = now;
      const key = scene.proj.kind + scene.proj.rot + scene.season;
      if (!base || key !== baseKey) { buildBase(); baseKey = key; }
      const g = c.getContext("2d"), dpr = c.width / MW;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, c.width, c.height);
      g.drawImage(base, 0, 0);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      for (const m of scene.movers) {
        if (m.kind === "parked") continue;
        const [x, y] = toMini(m.cx != null ? m.cx : m.wx + m.sw / 2, m.cy != null ? m.cy : m.wy + m.sh);
        g.fillStyle = m.kind === "bus" ? "#ffcf3a" : m.kind === "car" ? "#ffffff" : m.id === scene.selected ? "#ffe27a" : "#ff6a5a";
        const r = m.kind === "bus" ? 2 : m.id === scene.selected ? 2.5 : 1.2;
        g.fillRect(Math.round(x - r), Math.round(y - r), Math.ceil(r * 2), Math.ceil(r * 2));
      }
      const v = scene.view();
      const [x0, y0] = toMini(v.x0, v.y0), [x1, y1] = toMini(v.x1, v.y1);
      g.strokeStyle = "rgba(255,255,255,0.95)"; g.lineWidth = 1.2;
      g.strokeRect(Math.round(x0) + 0.5, Math.round(y0) + 0.5, Math.max(2, Math.round(x1 - x0)), Math.max(2, Math.round(y1 - y0)));
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
    c.addEventListener("pointermove", ev => { if (dragging) go(ev); });
    c.addEventListener("pointerup", () => { dragging = false; });
    c.addEventListener("pointercancel", () => { dragging = false; });
    return {
      el: box, draw, rebuild: () => { base = null; },
      isOpen: () => open, setOpen,
      setScene(sc, cm) { scene = sc; cam = cm; base = null; },
      destroy() { box.remove(); },
    };
  };
})();

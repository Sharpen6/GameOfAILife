// CityView social pings (view.md 3.6): marks over people and buildings from the frames' social events (which
// carry place and agents) and from state.talks rows ([place_index | -1, a_id, b_id, tone, tick], PLAN 2.10,
// de-duplicated on a, b and tick). An indoor talk or an event at a place draws over the building's label
// point; an outdoor one between the two people (folk from the crowd, named from the movers), else at the
// event's tile.
//   talk, flirt                     a bubble in both people's shirt colours, 3 s (flirt: pink rim)
//   new_friend, partner, engaged    a heart, 3 s
//   falling_out, breakup, rival, row  a jagged red bubble, 3 s
//   wedding                         rings and confetti, 10 s
//   party, birth                    a warm glow and confetti, 10 s; a stork flies over a birth
// A talk row's tone picks its mark: -1 jagged, 0 a bubble, 1 a bubble with a warm rim. At most 20 on screen,
// at near and mid only (none at far), newest first, one per place (or per pair outdoors). Named characters use
// their v2 shirt colour, folk their sheet's. CV.makePings(scene, M, crowd) -> P; the facade feeds P.events and
// P.talks and calls P.draw(g, now) after the scene, on top of everything. Classic script; no random numbers.
"use strict";
(function () {
  const CV = window.CityView = window.CityView || {};
  const KIND = { talk: "bubble", flirt: "bubble", new_friend: "heart", partner: "heart", engaged: "heart",
    falling_out: "jagged", breakup: "jagged", rival: "jagged", row: "jagged", wedding: "rings", party: "glow", birth: "glow" };
  const LIFE = { bubble: 3000, heart: 3000, jagged: 3000, rings: 10000, glow: 10000 };
  const MAX = 20;
  CV.PING_KIND = KIND;

  CV.makePings = function (scene, M, crowd) {
    let list = [], seq = 0, drawn = 0, shown = [];
    const seenEv = new Set(), seenTalk = new Set();
    const town = scene.town;
    const homePlace = new Map((town.homes || []).map(h => [h.id, h.place]));
    const placeIdOf = id => id == null ? null : scene.placeById.has(id) ? id : homePlace.get(id) || null;
    const isFolk = id => typeof id === "string" && /^f\d+$/.test(id);
    const colorOf = id => {
      if (isFolk(id) && typeof CV.folkColor === "function") return CV.folkColor(+id.slice(1));
      return typeof CV.shirtHex === "function" ? CV.shirtHex(String(id)) : "#e8e8e8";
    };
    const nowMs = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
    const lodNow = () => {
      const l = typeof scene.lod === "function" ? scene.lod() : scene.lod;
      if (l) return l;
      const z = (scene.cam && scene.cam.zoom) || 1;
      return z >= 0.5 ? "near" : z >= 0.18 ? "mid" : "far";
    };
    function add(p) {
      p.n = ++seq;
      list.push(p);
      if (list.length > 200) list.splice(0, list.length - 200);
    }
    // where a ping is drawn now (world px), or null
    const labelCache = new Map();
    let labelProj = null;
    function placePoint(pid) {
      if (labelProj !== scene.proj) { labelCache.clear(); labelProj = scene.proj; }
      if (labelCache.has(pid)) return labelCache.get(pid);
      const i = scene.placeById.get(pid), p = i != null ? town.places[i] : null;
      let w = null;
      if (p) {
        const rec = p.kind !== "park" && scene.buildingOf ? scene.buildingOf(pid) : null;
        if (rec && (rec.label || rec.center)) { const q = rec.label || rec.center; w = [q[0], q[1] - 10]; }
        else w = scene.proj.toWorld(p.x + p.w / 2, p.y + p.h / 2, 26);
      }
      labelCache.set(pid, w);
      return w;
    }
    function personPoint(id, now) {
      if (isFolk(id) && crowd) { const t = crowd.pos(+id.slice(1), now); return t ? scene.proj.toWorld(t[0], t[1], 34) : null; }
      const r = scene.moverById ? scene.moverById(id) : null;
      if (r && r.foot && !r.place) return [r.foot[0], r.foot[1] - 34];
      return null;
    }
    function pointOf(p, now) {
      if (p.place) return placePoint(p.place);
      const a = p.a != null ? personPoint(p.a, now) : null, b = p.b != null ? personPoint(p.b, now) : null;
      if (a && b) return [(a[0] + b[0]) / 2, Math.min(a[1], b[1]) - 4];
      if (a || b) return a || b;
      if (p.at) return scene.proj.toWorld(p.at[0] + 0.5, p.at[1] + 0.5, 30);
      return null;
    }
    const P = {
      // frame events: those with a tag of the table above
      events(evs, now) {
        now = now == null ? nowMs() : now;
        for (const e of evs || []) {
          if (!e || !KIND[e.tag]) continue;
          if (e.seq != null) { if (seenEv.has(e.seq)) continue; seenEv.add(e.seq); if (seenEv.size > 2000) seenEv.delete(seenEv.values().next().value); }
          const ag = e.agents && e.agents.length ? e.agents : e.agent != null ? [e.agent] : [];
          const kind = KIND[e.tag];
          add({ kind, tag: e.tag, rim: e.tag === "flirt" ? "#ff7ab8" : null, place: placeIdOf(e.place), a: ag[0], b: ag[1], at: e.at || null, t0: now, life: LIFE[kind] });
        }
      },
      // state.talks rows, each once (a, b and the start tick). The rows come named first, newest first
      // (PLAN 2.10), so they are added last to first: row 0 is added last and wins its place in visible().
      talks(rows, now) {
        now = now == null ? nowMs() : now;
        const rs = Array.isArray(rows) ? rows : [];
        for (let j = rs.length - 1; j >= 0; j--) {
          const r = rs[j];
          if (!Array.isArray(r) || r.length < 4) continue;
          const [pi, a, b, tone, tick] = r, key = a + "|" + b + "|" + (tick != null ? tick : "");
          if (seenTalk.has(key)) continue;
          seenTalk.add(key);
          if (seenTalk.size > 4000) seenTalk.delete(seenTalk.values().next().value);
          const p = pi >= 0 && town.places[pi] ? town.places[pi].id : null;
          const kind = tone < 0 ? "jagged" : "bubble";
          add({ kind, tag: "talk", rim: tone > 0 ? "#ffc84a" : null, place: p, a, b, at: null, t0: now, life: LIFE[kind] });
        }
      },
      // the pings to draw now: alive, on screen, newest first, one per place (or pair), at most 20
      visible(now) {
        now = now == null ? nowMs() : now;
        list = list.filter(p => now - p.t0 < p.life);
        if (lodNow() === "far") return [];
        const v = scene.view(), keys = new Set(), out = [];
        for (let k = list.length - 1; k >= 0 && out.length < MAX; k--) {
          const p = list[k], key = p.place || (p.a + "|" + p.b);
          if (keys.has(key)) continue;
          const w = pointOf(p, now);
          if (!w || w[0] < v.x0 || w[0] > v.x1 || w[1] < v.y0 || w[1] > v.y1) continue;
          keys.add(key);
          out.push({ p, w });
        }
        return out;
      },
      draw(g, now) {
        now = now == null ? nowMs() : now;
        shown = P.visible(now);
        drawn = shown.length;
        if (!drawn) return 0;
        const v = scene.view(), k = scene.dpr || 1, mid = lodNow() === "mid";
        g.save();
        g.setTransform(1, 0, 0, 1, 0, 0);
        for (let n = shown.length - 1; n >= 0; n--) { // oldest first, so the newest is on top
          const { p, w } = shown[n], age = now - p.t0;
          const pop = Math.min(1, 0.6 + age / 375), fade = Math.min(1, (p.life - age) / 400);
          const s = k * pop * (mid ? 0.8 : 1);
          const x = Math.round(w[0] * v.S + v.ox), y = Math.round(w[1] * v.S + v.oy - Math.min(6, age / 120) * k);
          g.globalAlpha = Math.max(0, fade);
          if (p.kind === "bubble") bubble(g, x, y, s, colorOf(p.a), colorOf(p.b), p.rim);
          else if (p.kind === "heart") heart(g, x, y, s, "#ff4f7a");
          else if (p.kind === "jagged") jagged(g, x, y, s);
          else if (p.kind === "rings") { rings(g, x, y, s); if (!mid) confetti(g, x, y, s, age, p.n); }
          else {
            glow(g, x, y, s, age);
            if (!mid) confetti(g, x, y, s, age, p.n);
            if (p.tag === "birth") stork(g, x, y, s, age);
          }
        }
        g.restore();
        return drawn;
      },
      stats: () => ({ pings: drawn }),
      shown: () => shown.map(q => ({ kind: q.p.kind, tag: q.p.tag, place: q.p.place, a: q.p.a, b: q.p.b })),
      clear() { list = []; },
    };
    // --- the marks, in device px around (x, y): the bottom tip of the mark --------------------------------
    function roundRect(g, x, y, w, h, r) {
      g.beginPath(); g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r); g.lineTo(x + w, y + h - r);
      g.quadraticCurveTo(x + w, y + h, x + w - r, y + h); g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r); g.lineTo(x, y + r);
      g.quadraticCurveTo(x, y, x + r, y); g.closePath();
    }
    function bubble(g, x, y, s, ca, cb, rim) {
      const w = 18 * s, h = 12 * s, x0 = x - w / 2, y0 = y - h - 4 * s;
      g.fillStyle = "rgba(0,0,0,.35)"; roundRect(g, x0 + s, y0 + s, w, h, 4 * s); g.fill();
      g.save(); roundRect(g, x0, y0, w, h, 4 * s); g.clip();
      g.fillStyle = ca; g.fillRect(x0, y0, w / 2, h); g.fillStyle = cb; g.fillRect(x0 + w / 2, y0, w / 2 + 1, h);
      g.restore();
      g.beginPath(); g.moveTo(x - 2 * s, y0 + h); g.lineTo(x, y); g.lineTo(x + 3 * s, y0 + h); g.closePath(); g.fillStyle = cb; g.fill();
      g.lineWidth = Math.max(1, (rim ? 1.6 : 1) * s); g.strokeStyle = rim || "rgba(20,20,28,.9)"; roundRect(g, x0, y0, w, h, 4 * s); g.stroke();
      g.fillStyle = "#ffffff";
      for (let d = -1; d <= 1; d++) g.fillRect(Math.round(x + d * 4 * s - s), Math.round(y0 + h / 2 - s), Math.max(1, Math.round(2 * s)), Math.max(1, Math.round(2 * s)));
    }
    function heart(g, x, y, s, col) {
      const r = 4.2 * s, cy = y - 10 * s;
      g.beginPath(); g.moveTo(x, y - 2 * s);
      g.bezierCurveTo(x - 9 * s, cy, x - 7 * s, cy - 2 * r, x, cy - r * 0.6);
      g.bezierCurveTo(x + 7 * s, cy - 2 * r, x + 9 * s, cy, x, y - 2 * s); g.closePath();
      g.fillStyle = col; g.fill(); g.lineWidth = Math.max(1, s); g.strokeStyle = "rgba(60,0,20,.9)"; g.stroke();
      g.fillStyle = "rgba(255,255,255,.7)"; g.fillRect(Math.round(x - 4 * s), Math.round(cy - 3 * s), Math.max(1, Math.round(2 * s)), Math.max(1, Math.round(2 * s)));
    }
    function jagged(g, x, y, s) {
      const cx = x, cy = y - 11 * s, n = 10;
      g.beginPath();
      for (let i = 0; i <= 2 * n; i++) { const an = Math.PI * i / n, r = (i % 2 ? 6 : 10) * s; const px = cx + Math.cos(an) * r * 1.2, py = cy + Math.sin(an) * r * 0.8; if (i) g.lineTo(px, py); else g.moveTo(px, py); }
      g.closePath(); g.fillStyle = "#e03a2e"; g.fill(); g.lineWidth = Math.max(1, s); g.strokeStyle = "#3a0a08"; g.stroke();
      g.fillStyle = "#fff"; g.fillRect(Math.round(cx - s), Math.round(cy - 4 * s), Math.max(1, Math.round(2 * s)), Math.round(5 * s)); g.fillRect(Math.round(cx - s), Math.round(cy + 2 * s), Math.max(1, Math.round(2 * s)), Math.max(1, Math.round(2 * s)));
    }
    function rings(g, x, y, s) {
      g.lineWidth = Math.max(1.5, 2.2 * s); g.strokeStyle = "#f5c842";
      for (const d of [-4, 4]) { g.beginPath(); g.arc(x + d * s, y - 10 * s, 6 * s, 0, 2 * Math.PI); g.stroke(); }
      g.fillStyle = "#bfe8ff"; g.fillRect(Math.round(x + 2 * s), Math.round(y - 19 * s), Math.max(1, Math.round(3 * s)), Math.max(1, Math.round(3 * s)));
    }
    function glow(g, x, y, s, age) {
      const r = (16 + 3 * Math.sin(age / 300)) * s, gr = g.createRadialGradient(x, y - 8 * s, 0, x, y - 8 * s, r);
      gr.addColorStop(0, "rgba(255,214,120,.85)"); gr.addColorStop(1, "rgba(255,160,60,0)");
      g.fillStyle = gr; g.beginPath(); g.arc(x, y - 8 * s, r, 0, 2 * Math.PI); g.fill();
    }
    // confetti: 18 bits thrown up from the mark and falling, each its own colour, spin and drift (hashed from
    // the ping's number, so no two parties look alike and nothing is random)
    const CONF = ["#ff5a6e", "#ffd23f", "#4fc3f7", "#7ed957", "#c084fc", "#ff9f43"];
    function confetti(g, x, y, s, age, n) {
      const T = age / 1000, cycle = 2.6;
      for (let i = 0; i < 18; i++) {
        const h = Math.imul((n + 1) * 2654435761 ^ (i + 1) * 40503, 2246822519) >>> 0;
        const t0 = ((h & 255) / 255) * cycle, tt = ((T + t0) % cycle) / cycle;     // each bit loops on its own phase
        const vx = (((h >>> 8) & 255) / 255 - 0.5) * 34, up = 22 + ((h >>> 16) & 15);
        const px = x + vx * tt * s, py = y - 12 * s - (up * tt - 30 * tt * tt) * s;
        const an = T * (2 + (h >>> 20 & 7)) + i;
        g.save(); g.translate(px, py); g.rotate(an);
        g.fillStyle = CONF[(h >>> 24) % CONF.length];
        g.globalAlpha *= Math.max(0, 1 - tt * 0.9);
        g.fillRect(-1.5 * s, -0.8 * s, 3 * s, 1.6 * s);
        g.restore();
      }
    }
    // a stork crossing over the mark with a bundle, once over the 10 s
    function stork(g, x, y, s, age) {
      const f = Math.min(1, age / 6000), bx = x + (f - 0.5) * 140 * s, by = y - 46 * s - Math.sin(f * Math.PI) * 10 * s;
      const flap = Math.sin(age / 140) * 5 * s;
      g.save();
      g.globalAlpha *= f < 1 ? 1 : 0;
      g.strokeStyle = "#f4f4f0"; g.lineWidth = Math.max(1.5, 2.2 * s); g.lineCap = "round";
      g.beginPath(); g.moveTo(bx - 9 * s, by - flap); g.lineTo(bx, by); g.lineTo(bx + 9 * s, by - flap); g.stroke();     // wings
      g.fillStyle = "#f4f4f0"; g.beginPath(); g.ellipse(bx, by + 1 * s, 5 * s, 2.4 * s, 0, 0, 2 * Math.PI); g.fill();   // body
      g.strokeStyle = "#ff8c2a"; g.lineWidth = Math.max(1, 1.2 * s);
      g.beginPath(); g.moveTo(bx + 5 * s, by); g.lineTo(bx + 10 * s, by + 1.5 * s); g.stroke();                       // beak
      g.strokeStyle = "rgba(240,240,236,.9)"; g.beginPath(); g.moveTo(bx + 1 * s, by + 3 * s); g.lineTo(bx + 1 * s, by + 7 * s); g.stroke();
      g.fillStyle = "#bfe0ff"; g.beginPath(); g.arc(bx + 1 * s, by + 9 * s, 2.6 * s, 0, 2 * Math.PI); g.fill();      // the bundle
      g.restore();
    }
    return P;
  };
})();

// CityView actors: people as small outlined pixel sprites (one sheet per agent: 4 facings x 4 walk
// frames, shirt in the roster colour), and vehicles drawn through the projection (cars, taxi, ambulance,
// buses with riders in the windows, the moving van) plus the plane and the night headlight cones.
// Classic script; installs its drawers on the art object built by art.js.
"use strict";
(function () {
  const CV = window.CityView = window.CityView || {};
  const { shade, mix, hash, hexRgb } = CV.color;
  const poly = CV.poly;
  const SKIN = ["#f1c6a0", "#e2ad84", "#c68c5e", "#8d5a3a", "#f6d6ba"];
  const PANTS = ["#2e3a59", "#3a3a40", "#5a4a3a", "#2a4a3a", "#4a4a6a", "#6a5a48"];
  const SHOES = ["#222222", "#4a2e1a", "#e8e8e8"];
  CV.SHEET = { cw: 16, ch: 30, ax: 8, ay: 28 };

  // Draw a dark 1-px outline around every opaque pixel of a canvas, so sprites read on grass and road.
  function outline(c, color) {
    const g = c.getContext("2d"), w = c.width, h = c.height;
    const img = g.getImageData(0, 0, w, h), d = img.data;
    const solid = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) solid[i] = d[i * 4 + 3] >= 200 ? 1 : 0;
    const [r, gg, b] = hexRgb(color);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (solid[i]) continue;
      const near = (x > 0 && solid[i - 1]) || (x < w - 1 && solid[i + 1]) || (y > 0 && solid[i - w]) || (y < h - 1 && solid[i + w]);
      if (!near) continue;
      const o = i * 4;
      d[o] = r; d[o + 1] = gg; d[o + 2] = b; d[o + 3] = 220;
    }
    g.putImageData(img, 0, 0);
  }

  CV._artParts.push(function (art) {
    const { P, item, oriented, boxAt, faceFn, quad, proj } = art;
    const FACES = proj.faces;

    // --- people ---------------------------------------------------------------------------------------
    // Sheet 64 x 120: rows are facings (0 front-right, 1 front-left, 2 back-right, 3 back-left), columns
    // are walk frames; each cell is 16 x 30 with the feet at (8, 28).
    art.person = function (a) {
      const band = a.age != null && a.age < 13 ? "c" : a.age >= 65 ? "o" : "a";
      return item(`pp:${a.id}:${band}`, 64, 120, 8, 28, (g, c) => paintSheet(g, c, band, {
        skin: SKIN[hash(a.id + "s") % SKIN.length], hair: band === "o" ? "#d4d4d4" : CV.hair(a.id),
        shirt: CV.shirtHex(a.id), pants: PANTS[hash(a.id + "p") % PANTS.length], shoes: SHOES[hash(a.id + "f") % 3],
        long: hash(a.id + "l") % 3 === 0 }));
    };
    // Townsfolk share 24 sheets (v = 0..23) in the same 64 x 120 layout, with a child size of each: 0.18 MP for
    // the 24 adults. The shirt colour of sheet v is CV.folkShirt(v) (pings and picks use it).
    const FOLK_HUES = [8, 28, 48, 90, 140, 170, 195, 215, 235, 260, 290, 330];
    CV.folkShirt = v => CV.color.hslHex(FOLK_HUES[(v | 0) % 12], (v | 0) % 24 < 12 ? 62 : 45, (v | 0) % 24 < 12 ? 52 : 40);
    art.folkSheet = function (v, child) {
      v = ((v | 0) % 24 + 24) % 24;
      const band = child ? "c" : v % 7 === 6 ? "o" : "a";
      return item(`fs:${v}:${band}`, 64, 120, 8, 28, (g, c) => paintSheet(g, c, band, {
        skin: SKIN[(v * 3 + 1) % SKIN.length], hair: band === "o" ? "#d4d4d4" : ["#3b2416", "#6b4423", "#1d1d1d", "#c9a14a", "#8a3b1c", "#b8b8b8"][(v * 5 + 2) % 6],
        shirt: CV.folkShirt(v), pants: PANTS[(v * 7 + 3) % PANTS.length], shoes: SHOES[v % 3], long: v % 3 === 1 }));
    };
    function paintSheet(g, c, band, pal) {
        const { skin, hair, shirt, pants, shoes, long } = pal;
        const child = band === "c", old = band === "o";
        for (let dir = 0; dir < 4; dir++) for (let fr = 0; fr < 4; fr++) {
          const cx = fr * 16, cy = dir * 30, flip = dir === 1 || dir === 3, back = dir >= 2;
          const R = (x, y, w, h, col) => { g.fillStyle = col; g.fillRect(flip ? cx + 16 - x - w : cx + x, cy + y, w, h); };
          const stride = fr === 1 ? 1 : fr === 3 ? -1 : 0;
          const lift = fr === 0 || fr === 2 ? 0 : 0;
          const H = child ? 18 : 24;
          const topY = 28 - H - lift;
          const legH = child ? 5 : 7, legY = 28 - legH;
          // legs and shoes
          if (stride === 0) { R(5, legY, 2, legH - 1, pants); R(9, legY, 2, legH - 1, pants); R(5, 27, 2, 1, shoes); R(9, 27, 2, 1, shoes); }
          else {
            const f = stride > 0 ? 4 : 10, b = stride > 0 ? 10 : 4;
            R(f, legY, 2, legH - 1, pants); R(b, legY, 2, legH - 2, shade(pants, 0.8));
            R(f - (stride > 0 ? 1 : -1), 27, 2, 1, shoes); R(b, 26, 2, 1, shoes);
          }
          // torso with shading
          const bodyTop = topY + (child ? 7 : 9), bodyH = legY - bodyTop + 1;
          R(4, bodyTop, 8, bodyH, shirt);
          R(4, bodyTop, 8, 1, shade(shirt, 1.18));
          R(10, bodyTop + 1, 2, bodyH - 1, shade(shirt, 0.8));
          if (!child) R(4, legY - 1, 8, 1, shade(pants, 0.7)); // belt
          // arms swing against the legs
          const sw = stride;
          R(3, bodyTop + 1 + Math.max(0, sw), 1, bodyH - 2, shade(shirt, 0.92));
          R(12, bodyTop + 1 + Math.max(0, -sw), 1, bodyH - 2, shade(shirt, 0.72));
          R(3, bodyTop + bodyH - 1 + Math.max(0, sw), 1, 1, skin); R(12, bodyTop + bodyH - 1 + Math.max(0, -sw), 1, 1, skin);
          // head
          const hx = old && !back ? 6 : 5, hy = topY + 1;
          const hh = child ? 6 : 7;
          R(hx, hy, 6, hh, skin);
          R(hx + 4, hy + 1, 2, hh - 1, shade(skin, 0.86));
          R(7, hy + hh, 2, 1, shade(skin, 0.85)); // neck
          R(hx - 1, hy - 1, 8, 2, hair);
          if (back) { R(hx - 1, hy, 8, hh - 1 + (long ? 2 : 0), hair); R(hx, hy + 1, 6, 1, shade(hair, 1.2)); }
          else {
            R(hx - 1, hy + 1, 1, long ? 6 : 3, hair); R(hx + 6, hy + 1, 1, long ? 6 : 2, hair);
            R(hx, hy + 1, 6, 1, hair);
            R(hx + 2, hy + 3, 1, 1, "#1e1e24"); R(hx + 4, hy + 3, 1, 1, "#1e1e24");
            R(hx + 3, hy + 5, 2, 1, shade(skin, 0.75));
            if (old) R(hx + 1, hy + 3, 5, 1, "rgba(70,70,80,.55)");
          }
          if (old && fr === 0) R(13, bodyTop + 3, 1, 28 - bodyTop - 3, "#6a4a2a"); // walking stick
        }
        outline(c, "#14161c");
        for (let dir = 0; dir < 4; dir++) for (let fr = 0; fr < 4; fr++) { // ground shadow under the outline
          g.globalCompositeOperation = "destination-over";
          CV.ellipse(g, fr * 16 + 8, dir * 30 + 28, 5, 1, "rgba(0,0,0,0.28)");
          g.globalCompositeOperation = "source-over";
        }
    }

    // --- vehicles -----------------------------------------------------------------------------------------
    // Drawn through the projection around tile-local (0.5, 0.5). d: 0 heading +x, 1 +y, 2 -x, 3 -y.
    // h: canvas height (v2's 84; long vehicles take 92 so the flat view's shadow fits below the anchor)
    function vehicle(key, d, L, Wd, draw, h) {
      return oriented(key, 112, h || 84, 56, 58, g => {
        const ax = d % 2 === 0, hl = (ax ? L : Wd) / 2, hw = (ax ? Wd : L) / 2;
        draw(g, 0.5 - hl, 0.5 - hw, 0.5 + hl, 0.5 + hw, ax);
      });
    }
    // Front and rear lights on the end faces that the camera can see.
    function lights(g, x0, y0, x1, y1, d, z0, z1, headCol) {
      const frontFace = ["e", "s", "w", "n"][d], rearFace = ["w", "n", "e", "s"][d];
      for (const f of FACES) {
        const F = faceFn(f, x0, y0, x1, y1);
        if (f === frontFace) { poly(g, quad(F, 0.02, 0.07, z0, z1), headCol || "#fff6c8"); poly(g, quad(F, F.len - 0.07, F.len - 0.02, z0, z1), headCol || "#fff6c8"); }
        if (f === rearFace) { poly(g, quad(F, 0.02, 0.06, z0, z1), "#e0322a"); poly(g, quad(F, F.len - 0.06, F.len - 0.02, z0, z1), "#e0322a"); }
      }
    }
    function wheels(g, x0, y0, x1, y1) {
      for (const f of FACES) {
        const F = faceFn(f, x0, y0, x1, y1);
        if (F.len < 0.4) continue;
        poly(g, quad(F, 0.07, 0.19, 0, 4), "#16161a"); poly(g, quad(F, F.len - 0.19, F.len - 0.07, 0, 4), "#16161a");
        poly(g, quad(F, 0.11, 0.15, 1, 3), "#8a8e96"); poly(g, quad(F, F.len - 0.15, F.len - 0.11, 1, 3), "#8a8e96");
      }
    }
    art.car = function (color, kind, d) {
      if (kind === "van" || kind === "truck") return goods(color, kind, d);
      const body = kind === "taxi" ? "#f2c40c" : kind === "ambulance" ? "#f4f4f4" : color;
      const L = kind === "ambulance" ? 0.74 : 0.62, Wd = kind === "ambulance" ? 0.36 : 0.32;
      return vehicle(`car:${body}:${kind}:${d}`, d, L, Wd, (g, x0, y0, x1, y1, ax) => {
        poly(g, [P(x0 + 0.03, y0 + 0.07), P(x1 + 0.09, y0 + 0.07), P(x1 + 0.09, y1 + 0.09), P(x0 + 0.03, y1 + 0.09)], "rgba(0,0,0,.3)");
        wheels(g, x0, y0, x1, y1);
        if (kind === "ambulance") {
          boxAt(g, x0, y0, x1, y1, 2, 18, body, "#ffffff");
          for (const f of FACES) { const F = faceFn(f, x0, y0, x1, y1); poly(g, quad(F, 0, F.len, 8, 11), "#e23b3b"); }
          const front = d < 2 ? 1 : -1;
          const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
          const wx = ax ? cx + front * (x1 - x0) * 0.32 : cx, wy = ax ? cy : cy + front * (y1 - y0) * 0.32;
          boxAt(g, wx - 0.06, wy - 0.06, wx + 0.06, wy + 0.06, 18, 21, "#3a8ae0");
          lights(g, x0, y0, x1, y1, d, 5, 7);
          return;
        }
        boxAt(g, x0, y0, x1, y1, 2, 8, body, shade(body, 1.1));
        // cabin set back from the front
        const f = d < 2 ? 1 : -1, s = 0.1, b = 0.17;
        let cx0 = x0, cx1 = x1, cy0 = y0, cy1 = y1;
        if (ax) { cx0 = f > 0 ? x0 + b : x0 + s; cx1 = f > 0 ? x1 - s : x1 - b; cy0 = y0 + 0.03; cy1 = y1 - 0.03; }
        else { cy0 = f > 0 ? y0 + b : y0 + s; cy1 = f > 0 ? y1 - s : y1 - b; cx0 = x0 + 0.03; cx1 = x1 - 0.03; }
        for (const fc of FACES) {
          const F = faceFn(fc, cx0, cy0, cx1, cy1);
          poly(g, quad(F, 0, F.len, 8, 14), fc === FACES[0] ? "#9fcdeb" : "#7aaed4");
          poly(g, quad(F, 0, F.len, 8, 9), shade(body, 0.85));
          if (F.len > 0.3) poly(g, quad(F, F.len / 2 - 0.015, F.len / 2 + 0.015, 9, 14), shade(body, 0.85));
        }
        art.P && poly(g, [P(cx0, cy0, 14), P(cx1, cy0, 14), P(cx1, cy1, 14), P(cx0, cy1, 14)], shade(body, 1.05));
        if (kind === "taxi") { const mx = (cx0 + cx1) / 2, my = (cy0 + cy1) / 2; boxAt(g, mx - 0.06, my - 0.05, mx + 0.06, my + 0.05, 14, 17, "#222222", "#f2c40c"); }
        lights(g, x0, y0, x1, y1, d, 4, 6);
      });
    };
    art.bus = function (line, d, open, riders) {
      const col = line === "2" ? "#1fa2a0" : "#f29a05";
      const n = Math.max(0, Math.min(6, riders | 0));
      return vehicle(`bus:${line}:${d}:${open ? 1 : 0}:${n}`, d, 1.45, 0.42, (g, x0, y0, x1, y1) => {
        poly(g, [P(x0 + 0.05, y0 + 0.08), P(x1 + 0.1, y0 + 0.08), P(x1 + 0.1, y1 + 0.1), P(x0 + 0.05, y1 + 0.1)], "rgba(0,0,0,.3)");
        wheels(g, x0, y0, x1, y1);
        boxAt(g, x0, y0, x1, y1, 2, 25, col, "#f2f2f2");
        let seat = 0;
        for (const fc of FACES) {
          const F = faceFn(fc, x0, y0, x1, y1), long = F.len > 1, lit = fc === FACES[0];
          poly(g, quad(F, 0, F.len, 2, 6), shade(col, lit ? 0.7 : 0.58));
          poly(g, quad(F, 0, F.len, 22, 25), "#f2f2f2");
          if (long) {
            for (let u = 0.08; u < F.len - 0.16; u += 0.22) {
              poly(g, quad(F, u, u + 0.17, 12, 21), lit ? "#3a5a7a" : "#2e4a66");
              poly(g, quad(F, u, u + 0.17, 19, 21), lit ? "#9cc8ea" : "#7aa6cc");
              if (seat < n) { // a rider's head and shoulders in the window
                const p = F.at(u + 0.085, 12);
                g.fillStyle = "#1e2430"; g.fillRect(Math.round(p[0]) - 2, Math.round(p[1]) - 5, 5, 5);
                g.fillStyle = "#e2ad84"; g.fillRect(Math.round(p[0]) - 1, Math.round(p[1]) - 8, 3, 3);
                seat++;
              }
            }
            if (open) poly(g, quad(F, F.len * 0.42, F.len * 0.52, 3, 21), "#1a1a1e");
            else poly(g, quad(F, F.len * 0.42, F.len * 0.52, 3, 21), lit ? "#2e4a66" : "#243a52");
          } else {
            poly(g, quad(F, 0.04, F.len - 0.04, 11, 21), lit ? "#9cc8ea" : "#7aa6cc");
            poly(g, quad(F, 0.04, F.len - 0.04, 19, 21), "#d8ecf8");
          }
        }
        lights(g, x0, y0, x1, y1, d, 4, 7);
        const c = P((x0 + x1) / 2, (y0 + y1) / 2, 25);
        g.fillStyle = col; g.fillRect(Math.round(c[0]) - 4, Math.round(c[1]) - 4, 9, 8);
        CV.pixelText(g, line, Math.round(c[0]) - 1, Math.round(c[1]) - 2, "#ffffff");
      });
    };
    // Delivery van (a short high box, cab in the body colour) and box truck (a longer, taller box behind a cab).
    function goods(color, kind, d) {
      const truck = kind === "truck", L = truck ? 1.0 : 0.72, Wd = truck ? 0.4 : 0.34;
      return vehicle(`car:${color}:${kind}:${d}`, d, L, Wd, (g, x0, y0, x1, y1, ax) => {
        poly(g, [P(x0 + 0.04, y0 + 0.07), P(x1 + 0.1, y0 + 0.07), P(x1 + 0.1, y1 + 0.09), P(x0 + 0.04, y1 + 0.09)], "rgba(0,0,0,.3)");
        wheels(g, x0, y0, x1, y1);
        const f = d < 2 ? 1 : -1, cab = truck ? 0.28 : 0.2;
        let bx0 = x0, bx1 = x1, by0 = y0, by1 = y1, kx0 = x0, kx1 = x1, ky0 = y0, ky1 = y1;
        if (ax) { if (f > 0) { bx1 = x1 - cab; kx0 = x1 - cab; } else { bx0 = x0 + cab; kx1 = x0 + cab; } }
        else { if (f > 0) { by1 = y1 - cab; ky0 = y1 - cab; } else { by0 = y0 + cab; ky1 = y0 + cab; } }
        const cabC = truck ? shade(color, 0.9) : color;
        boxAt(g, kx0, ky0, kx1, ky1, 2, truck ? 16 : 13, cabC, shade(cabC, 1.1));
        for (const fc of FACES) { const F = faceFn(fc, kx0, ky0, kx1, ky1); poly(g, quad(F, 0.03, F.len - 0.03, truck ? 10 : 8, truck ? 15 : 12), "#9fcdeb"); }
        const boxC = truck ? "#eceae4" : color;
        boxAt(g, bx0, by0, bx1, by1, 3, truck ? 27 : 17, boxC, shade(boxC, 1.08));
        for (const fc of FACES) {
          const F = faceFn(fc, bx0, by0, bx1, by1);
          if (F.len > 0.4) poly(g, quad(F, 0.04, F.len - 0.04, truck ? 12 : 9, truck ? 16 : 11), truck ? color : shade(color, 0.8));
        }
        lights(g, x0, y0, x1, y1, d, 4, 6);
      }, 92);
    }
    art.van = function (d) {
      return vehicle(`van:${d}`, d, 0.9, 0.38, (g, x0, y0, x1, y1, ax) => {
        poly(g, [P(x0 + 0.04, y0 + 0.07), P(x1 + 0.1, y0 + 0.07), P(x1 + 0.1, y1 + 0.09), P(x0 + 0.04, y1 + 0.09)], "rgba(0,0,0,.3)");
        wheels(g, x0, y0, x1, y1);
        const f = d < 2 ? 1 : -1, cab = 0.26;
        let bx0 = x0, bx1 = x1, by0 = y0, by1 = y1, kx0 = x0, kx1 = x1, ky0 = y0, ky1 = y1;
        if (ax) { if (f > 0) { bx1 = x1 - cab; kx0 = x1 - cab; } else { bx0 = x0 + cab; kx1 = x0 + cab; } }
        else { if (f > 0) { by1 = y1 - cab; ky0 = y1 - cab; } else { by0 = y0 + cab; ky1 = y0 + cab; } }
        boxAt(g, kx0, ky0, kx1, ky1, 2, 14, "#2f6aa8");
        for (const fc of FACES) { const F = faceFn(fc, kx0, ky0, kx1, ky1); poly(g, quad(F, 0.03, F.len - 0.03, 8, 13), "#9fcdeb"); }
        boxAt(g, bx0, by0, bx1, by1, 3, 23, "#f2f2ee", "#ffffff");
        for (const fc of FACES) {
          const F = faceFn(fc, bx0, by0, bx1, by1);
          if (F.len > 0.5) { poly(g, quad(F, 0.05, F.len - 0.05, 9, 15), "#2f6aa8"); }
        }
        lights(g, x0, y0, x1, y1, d, 4, 6);
      });
    };

    // Night: a soft cone of light ahead of a vehicle (screen-space sprite per facing).
    art.headlights = d => item(`hl:${d}`, 120, 80, 60, 40, g => {
      const c = P(0.5, 0.5), dir = [[1, 0], [0, 1], [-1, 0], [0, -1]][d];
      const a = P(0.5 + dir[0] * 0.3, 0.5 + dir[1] * 0.3), b = P(0.5 + dir[0] * 1.4, 0.5 + dir[1] * 1.4);
      const ox = 60 - c[0], oy = 40 - c[1];
      const gr = g.createLinearGradient(a[0] + ox, a[1] + oy, b[0] + ox, b[1] + oy);
      gr.addColorStop(0, "rgba(255,236,170,0.55)"); gr.addColorStop(1, "rgba(255,236,170,0)");
      g.fillStyle = gr;
      const side = [-dir[1], dir[0]];
      const p1 = P(0.5 + dir[0] * 0.3 + side[0] * 0.1, 0.5 + dir[1] * 0.3 + side[1] * 0.1), p2 = P(0.5 + dir[0] * 0.3 - side[0] * 0.1, 0.5 + dir[1] * 0.3 - side[1] * 0.1);
      const p3 = P(0.5 + dir[0] * 1.4 - side[0] * 0.45, 0.5 + dir[1] * 1.4 - side[1] * 0.45), p4 = P(0.5 + dir[0] * 1.4 + side[0] * 0.45, 0.5 + dir[1] * 1.4 + side[1] * 0.45);
      g.beginPath(); g.moveTo(p1[0] + ox, p1[1] + oy); g.lineTo(p2[0] + ox, p2[1] + oy); g.lineTo(p3[0] + ox, p3[1] + oy); g.lineTo(p4[0] + ox, p4[1] + oy); g.closePath(); g.fill();
    });

    // The plane: a small airliner seen from above-left, outlined dark so it reads as a craft overhead even
    // over a pale roof, and its shadow far below.
    art.plane = () => item("plane", 64, 40, 32, 20, (g, c) => {
      const W = "#f4f6fa", D = "#c8ced8";
      g.fillStyle = D; g.fillRect(14, 19, 36, 5);
      g.fillStyle = W; g.fillRect(12, 17, 38, 5); g.fillRect(48, 18, 4, 3);
      g.fillStyle = "#4b6ea8"; g.fillRect(14, 19, 34, 1);
      for (let x = 18; x < 46; x += 3) { g.fillStyle = "#3a5a7a"; g.fillRect(x, 18, 1, 1); }
      g.fillStyle = D; g.fillRect(26, 22, 12, 3); g.fillRect(24, 25, 8, 3); g.fillRect(22, 28, 6, 2);
      g.fillStyle = W; g.fillRect(28, 10, 10, 8); g.fillRect(30, 7, 6, 3);
      g.fillStyle = W; g.fillRect(10, 12, 5, 6); g.fillStyle = "#4b6ea8"; g.fillRect(10, 12, 3, 5);
      g.fillStyle = D; g.fillRect(9, 20, 8, 2);
      outline(c, "#2a3140");
    });
    art.planeShadow = () => item("planeS", 64, 24, 32, 12, g => {
      g.fillStyle = "rgba(0,0,0,0.28)";
      g.fillRect(12, 10, 38, 4); g.fillRect(26, 4, 10, 16); g.fillRect(10, 8, 6, 8);
    });
  });
})();

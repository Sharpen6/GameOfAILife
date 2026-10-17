// CityView projection: the only code that knows how map tiles become screen pixels.
// Tile space: x points east, y points south, z is height in world px. World px are screen px at zoom 1.
// makeIso is SimCity-2000-style 2:1 isometric (64 x 32 px per tile, rotatable in 90-degree steps);
// makeFlat is a top-down 3/4 view with 48 px square tiles. Both expose the same small interface, so
// every other file draws through it and works in either mode. Classic script on window.CityView.
"use strict";
(function () {
  const CV = window.CityView = window.CityView || {};

  // Isometric 2:1 diamonds. rot 0 looks from the south-east: the south wall is the lit left face and
  // the east wall the shaded right face.
  CV.makeIso = function (w, h, rot) {
    rot = ((rot || 0) % 4 + 4) % 4;
    const HW = 32, HH = 16;
    const R = [
      (x, y) => [x, y],
      (x, y) => [h - y, x],
      (x, y) => [w - x, h - y],
      (x, y) => [y, w - x],
    ][rot];
    const RI = [
      (a, b) => [a, b],
      (a, b) => [b, h - a],
      (a, b) => [w - a, h - b],
      (a, b) => [w - b, a],
    ][rot];
    const rw = rot % 2 ? h : w, rh = rot % 2 ? w : h;
    const FACES = [["s", "e"], ["e", "n"], ["n", "w"], ["w", "s"]][rot];
    return {
      kind: "iso", rot, w, h, tw: 64, th: 32, hw: HW, hh: HH, zk: 1,
      faces: FACES,
      toWorld(x, y, z) { const r = R(x, y); return [(r[0] - r[1]) * HW, (r[0] + r[1]) * HH - (z || 0)]; },
      toTile(wx, wy) { const a = wx / HW, b = wy / HH; return RI((a + b) / 2, (b - a) / 2); },
      // Painter key of a ground point: larger is nearer the camera.
      depth(x, y) { const r = R(x, y); return r[0] + r[1]; },
      bounds() { return { x0: -rh * HW, y0: 0, x1: rw * HW, y1: (rw + rh) * HH }; },
      // Footprint of a tile rectangle in rotated space: [a0, b0, a1, b1].
      rect(x0, y0, x1, y1) {
        const p = R(x0, y0), q = R(x1, y1);
        return [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[0], q[0]), Math.max(p[1], q[1])];
      },
      // Painter slices of a footprint: one per 32-px screen column, keyed by the depth of the footprint
      // tile nearest the camera in that column, so a single sort is right for movers beside long walls.
      slices(x0, y0, x1, y1) {
        const [a0, b0, a1, b1] = this.rect(x0, y0, x1, y1);
        const out = [];
        for (let c = a0 - b1; c < a1 - b0; c++) {
          let best = -1e9;
          for (const d of [c, c + 1]) {
            const tb = Math.min(b1 - 1, a1 - 1 - d), ta = tb + d;
            if (ta >= a0 && ta < a1 && tb >= b0 && tb < b1) best = Math.max(best, ta + tb + 1);
          }
          if (best > -1e9) out.push({ wx0: c * HW, wx1: (c + 1) * HW, depth: best });
        }
        return out;
      },
      // Person-sheet row for a step in tile space: 0 front-right, 1 front-left, 2 back-right, 3 back-left.
      facing(dx, dy) {
        if (!dx && !dy) return -1;
        const o = R(0, 0), r = R(dx, dy), a = r[0] - o[0], b = r[1] - o[1];
        if (Math.abs(a) >= Math.abs(b)) return a > 0 ? 0 : 3;
        return b > 0 ? 1 : 2;
      },
    };
  };

  // Top-down 3/4 view with big square tiles. Walls are seen from the south only and heights are squashed
  // so tall buildings do not hide whole blocks.
  CV.makeFlat = function (w, h) {
    const T = 48, ZK = 0.55;
    return {
      kind: "flat", rot: 0, w, h, tw: T, th: T, hw: T / 2, hh: T / 2, zk: ZK,
      faces: ["s"],
      toWorld(x, y, z) { return [x * T, y * T - (z || 0) * ZK]; },
      toTile(wx, wy) { return [wx / T, wy / T]; },
      depth(x, y) { return y + x * 1e-4; },
      bounds() { return { x0: 0, y0: 0, x1: w * T, y1: h * T }; },
      rect(x0, y0, x1, y1) { return [x0, y0, x1, y1]; },
      slices(x0, y0, x1, y1) { return [{ wx0: x0 * T, wx1: x1 * T, depth: y1 }]; },
      facing(dx, dy) {
        if (!dx && !dy) return -1;
        if (Math.abs(dy) >= Math.abs(dx)) return dy > 0 ? 0 : 2;
        return dx > 0 ? 0 : 1;
      },
    };
  };

  CV.makeProj = (kind, w, h, rot) => kind === "flat" ? CV.makeFlat(w, h) : CV.makeIso(w, h, rot || 0);
})();

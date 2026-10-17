// Port of gameofailife/rng.py: portable seeded dice (mulberry32), bit-identical to the Python Rng.
//
// The map's trees and the generated cast are drawn from this generator, so both ports build the identical
// city (pinned by tests/fixtures/city_seed1.json). Seeds are taken modulo 2**32, as Python's `seed & 0xFFFFFFFF`.
// Parity: the first three draws of Rng(7920) are 0.166736019310, 0.824670854257 and 0.208481384674.
(function (G) {
  "use strict";

  // Round half up to 2 decimals: floor(x * 100 + 0.5) / 100 (never Python's banker's round).
  const r2 = x => Math.floor(x * 100 + 0.5) / 100;

  // mulberry32. `int(lo, hi)` is inclusive; `shuffle` is Fisher-Yates from the end.
  class Rng {
    constructor(seed) { this.state = Number(seed) >>> 0; }

    next_u32() {
      this.state = (this.state + 0x6D2B79F5) >>> 0;
      let t = this.state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return (t ^ (t >>> 14)) >>> 0;
    }

    // A float in [0, 1): next_u32 / 2**32.
    random() { return this.next_u32() / 4294967296; }

    // An integer from lo to hi, both included.
    int(lo, hi) { return lo + Math.floor(this.random() * (hi - lo + 1)); }

    uniform(lo, hi) { return lo + (hi - lo) * this.random(); }

    pick(seq) { return seq[Math.floor(this.random() * seq.length)]; }

    // In place: for i from n-1 down to 1, swap item i with item floor(random() * (i + 1)).
    shuffle(seq) {
      for (let i = seq.length - 1; i > 0; i--) {
        const j = Math.floor(this.random() * (i + 1));
        [seq[i], seq[j]] = [seq[j], seq[i]];
      }
    }
  }
  Rng.r2 = r2;

  // (seed * k + c) & 0xFFFFFFFF for any integer seed, as Python computes it with big integers.
  const mix = (seed, k, c) => (Math.imul(Number(seed) >>> 0, k) + c) >>> 0;

  G.rng = { Rng, r2, mix };
})(globalThis.GameOfAILife || (globalThis.GameOfAILife = {}));

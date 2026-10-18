// Port of gameofailife/dice.py: keyed dice (life.md 4.1), a fresh mulberry32 stream for (seed, namespace, ids...).
// Parity vector: key(1, 3, "dana", 12) == 4148098172, roll(1, 3, "dana", 12) == 0.595681251725,
// roll(1, 1, "cafe", 1445) == 0.132828066358, roll(7, 2, "ari", "tom") == 0.755763392197.
(function (G) {
  "use strict";
  const { Rng } = G.rng;

  const LUCK_STRENGTH = 0.6;
  const NS = ["TALK", "CHEM", "DAY_HEALTH", "DAY_CAREER", "DAY_ROMANCE", "WEEK_MONEY", "SHIFT", "ASK", "BIRTH",
    "NAME", "SETTLE", "COUPLE", "STORY", "HIRE", "FOLK_ANSWER", "LEND", "ORIENT", "INCIDENT"]; // 1..18, append only

  const SID = new Map();

  // Ints as themselves; ASCII strings by FNV-1a 32, cached.
  function sid(x) {
    if (typeof x === "number") return x >>> 0;
    let h = SID.get(x);
    if (h === undefined) {
      h = 0x811C9DC5;
      for (let i = 0; i < x.length; i++) h = Math.imul(h ^ x.charCodeAt(i), 0x01000193) >>> 0;
      SID.set(x, h);
    }
    return h;
  }

  // The murmur3 finalizer.
  function _fmix(h) {
    h ^= h >>> 16;
    h = Math.imul(h, 0x85EBCA6B) >>> 0;
    h ^= h >>> 13;
    h = Math.imul(h, 0xC2B2AE35) >>> 0;
    return (h ^ (h >>> 16)) >>> 0;
  }

  function key(seed, ...parts) {
    let h = Math.imul(Number(seed) >>> 0, 0x9E3779B1) >>> 0;
    for (const p of parts) h = _fmix(Math.imul(h ^ sid(p), 0x01000193) >>> 0);
    return h;
  }

  const stream = (seed, ...parts) => new Rng(key(seed, ...parts));
  const roll = (seed, ...parts) => stream(seed, ...parts).random();

  // Luck's push on an outcome's odds: == forks.luck_odds when k == 1.
  const odds = (p, valence, luck, k = 1.0) =>
    Math.max(0.0, Math.min(1.0, p * (1 + LUCK_STRENGTH * k * (luck - 50) / 50 * valence)));

  const dice = { LUCK_STRENGTH, sid, _fmix, key, stream, roll, odds };
  NS.forEach((name, i) => { dice[name] = i + 1; });
  G.dice = dice;
})(globalThis.GameOfAILife || (globalThis.GameOfAILife = {}));

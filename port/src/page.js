// The built page's boot: one city in this page, with LocalHost standing in for the server.
//
// ?seed=N picks the city (default 1, canonical Millbrook); ?dice=N fixes the outcome dice, which are fresh on
// every load otherwise; ?speed=N starts at that speed (0, 1, 2, 4, 8 or 16). The live city stays inside this
// closure: the page sees only what the host sends the God view, as it would from the real server.
(function (global) {
  "use strict";
  const G = global.GameOfAILife;

  function param(name) {
    try {
      const v = new URLSearchParams(global.location.search).get(name);
      if (v !== null && /^\d{1,9}$/.test(v)) return Number(v);
    } catch (_) { /* no query string here */ }
    return null;
  }

  function freshDice() {
    try {
      return global.crypto.getRandomValues(new Uint32Array(1))[0];
    } catch (_) {
      return Math.floor(Math.random() * 4294967296);
    }
  }

  function fail(err) {
    try {
      const clock = global.document && global.document.getElementById("clock");
      if (clock) clock.textContent = "The city could not start in this page. Try reloading.";
    } catch (_) { /* no page here */ }
    throw err;
  }

  let host;
  const seed = param("seed") ?? 1;
  const dice = param("dice") ?? freshDice();
  const speed = param("speed");
  try {
    const sim = new G.sim.Simulation(seed, null, null, dice);
    host = new G.host.LocalHost(sim, G.host.SPEEDS.includes(speed) ? speed : 1);
    global.WebSocket = host.socket();
    host.start();
  } catch (err) {
    fail(err);
  }
  global.GameOfAILifePage = { seed, dice };
})(typeof window !== "undefined" ? window : globalThis);

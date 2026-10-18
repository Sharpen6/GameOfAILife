// The built page's boot: one city in this page, with LocalHost standing in for the server.
//
// ?seed=N picks the city (default 1, canonical Millbrook); ?dice=N fixes the outcome dice, which are fresh on
// every load otherwise; ?speed=N starts at that speed (0, 1, 2, 4, 8 or 16); ?world=region|millbrook picks the
// region around Millbrook (the default) or the town alone; ?folk=N sets how many townsfolk live in the region
// (default 1000; none in millbrook). If the region cannot start, the page falls back to Millbrook alone and says
// so. The live city stays inside this closure: the page sees only what the host sends the God view, as it would
// from the real server.
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

  // A string param that is one of `allowed`, else null.
  function choice(name, allowed) {
    try {
      const v = new URLSearchParams(global.location.search).get(name);
      if (v !== null && allowed.includes(v)) return v;
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

  function notice(text) {
    try {
      const doc = global.document;
      if (!doc || !doc.body) return;
      const note = doc.createElement("div");
      note.id = "world-notice";
      note.setAttribute("role", "status");
      note.textContent = text;
      note.style.cssText = "position:fixed;left:50%;top:8px;transform:translateX(-50%);z-index:50;padding:4px 10px;"
        + "border-radius:4px;background:#333;color:#fff;font:13px sans-serif;max-width:calc(100% - 32px)";
      doc.body.appendChild(note);
      setTimeout(() => note.remove(), 10000);
    } catch (_) { /* no page here */ }
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
  let world = choice("world", ["region", "millbrook"]) ?? "region";
  let folk = world === "region" ? (param("folk") ?? 1000) : 0;
  if (folk && !(G.folk && G.folk.Folk)) folk = 0; // the townsfolk's port is not in this build yet
  try {
    let sim;
    try {
      sim = new G.sim.Simulation(seed, null, null, dice, { world, folk });
    } catch (err) {
      if (world === "millbrook") throw err;
      console.error("GameOfAILife: the region could not start", err);
      world = "millbrook";
      folk = 0;
      sim = new G.sim.Simulation(seed, null, null, dice, { world, folk });
      const say = () => notice("The region could not start; showing Millbrook");
      if (global.document && global.document.readyState === "loading") {
        global.document.addEventListener("DOMContentLoaded", say);
      } else {
        say();
      }
    }
    host = new G.host.LocalHost(sim, G.host.SPEEDS.includes(speed) ? speed : 1);
    global.WebSocket = host.socket();
    host.start();
  } catch (err) {
    fail(err);
  }
  global.GameOfAILifePage = { seed, dice, world, folk };
})(typeof window !== "undefined" ? window : globalThis);

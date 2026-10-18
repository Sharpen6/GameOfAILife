// GameOfAILife God view: the socket, the header and the CityView lifecycle (PLAN 3.12).
//
// The city is drawn by the view (view/*.js, window.CityView) and everything around it (the panel, HUD, toasts,
// ticker, tooltip, map colours, keys 1-4, \ and /) is the dashboard's (dashboard.js, window.Dash). This script
// connects as God, routes every message to them, keeps the header (clock, weather, speed) and, when another
// window takes over God, keeps this one watching with God's controls locked.
"use strict";
(function () {
  const canvas = document.getElementById("map");
  const header = {
    clock: document.getElementById("clock"),
    weather: document.getElementById("weather"),
    speed: document.getElementById("speed"),
    role: document.getElementById("role"),
  };
  const RETRY_MS = 1500;
  const WATCHING = "Watching only: God moved to another window. Reload to be God here.";

  let ws = null;
  let view = null;
  let state = null; // the last frame's state, for the header
  let speed = 1;
  let role = "god";
  let lost = false; // the socket closed: say so once, not on every retry

  // --- the view and the dashboard -------------------------------------------------------------------------

  function makeView() {
    const CV = window.CityView;
    if (!CV || typeof CV.create !== "function") return null;
    try {
      return CV.create(canvas, {
        onPick: (hit, ev) => Dash.pick(hit, ev),
        onHover: (hit, ev) => Dash.hover(hit, ev),
        onSelect: id => Dash.viewSelected(id),
        onCamera: () => {},
      });
    } catch (err) {
      console.warn("CityView.create failed:", err);
      return null;
    }
  }

  view = makeView();
  Dash.init(view, { send, characterPage: "character.html" });
  if (!view) Dash.notice("The city map could not start in this browser; the dashboard still works.");

  // --- the header ---------------------------------------------------------------------------------------

  function renderHeader() {
    if (state) {
      header.clock.textContent = state.time;
      const season = state.season || "";
      const sky = state.weather === "rain" ? (season === "winter" ? "❄ Snow" : "🌧 Rain") : "☀ Clear";
      const plane = state.plane ? ` · ✈ ${state.plane.from} to ${state.plane.to}` : "";
      header.weather.textContent = `${season.charAt(0).toUpperCase() + season.slice(1)} · ${sky}${plane}`;
    }
    for (const b of header.speed.querySelectorAll("button")) {
      b.classList.toggle("on", Number(b.dataset.speed) === speed);
      b.setAttribute("aria-pressed", Number(b.dataset.speed) === speed ? "true" : "false");
    }
  }

  // A view that lost God keeps watching, with God's controls locked (Dash locks luck and play style).
  function setRole(next) {
    role = next;
    const watching = role !== "god";
    document.body.classList.toggle("watching", watching);
    header.role.textContent = watching ? WATCHING : "You are God of this city";
    for (const b of header.speed.querySelectorAll("button")) b.disabled = watching;
  }

  header.speed.addEventListener("click", ev => {
    const b = ev.target.closest("button");
    if (b && !b.disabled) send({ type: "set_speed", speed: Number(b.dataset.speed) });
  });

  // --- messages -----------------------------------------------------------------------------------------

  function onMessage(msg) {
    switch (msg.type) {
      case "welcome":
        // Also after a reconnect: the town, the lists and the feeds start again, as on a fresh page.
        state = msg.state;
        speed = msg.speed != null ? msg.speed : 1;
        if (view) {
          view.setTown(msg.town);
          view.setState(msg.state, speed);
        }
        Dash.welcome(msg);
        setRole(msg.role === "god" ? "god" : "observer");
        renderHeader();
        if (view) view.start();
        break;
      case "state":
        state = msg.state;
        speed = msg.speed;
        if (view) view.setState(msg.state, msg.speed);
        if (view && view.events) view.events(msg.events || []); // V1b: a frame's events become pings
        Dash.frame(msg);
        renderHeader();
        break;
      case "stats":
        Dash.stats(msg);
        break;
      case "speed":
        speed = msg.speed;
        renderHeader();
        break;
      case "demoted":
        Dash.reply(msg);
        setRole("observer");
        break;
      default:
        Dash.reply(msg); // agent, home, decisions, luck_set and error (as a "Not done: ..." card)
    }
  }

  // --- the socket ---------------------------------------------------------------------------------------

  function send(msg) {
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }

  function connect() {
    ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    ws.onopen = () => {
      if (lost) Dash.notice("Back in touch with the city.", "info");
      lost = false;
      send({ type: "hello", role: "god" });
    };
    ws.onmessage = ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (err) { return; }
      if (msg && typeof msg === "object") onMessage(msg);
    };
    ws.onclose = () => {
      header.clock.textContent = "Disconnected, retrying…";
      if (!lost && state) Dash.notice("Lost touch with the city; trying again.", "info");
      lost = true;
      setTimeout(connect, RETRY_MS);
    };
  }

  connect();
})();

#!/usr/bin/env node
// Full-app smoke test: the real server, the real God view and a fake controller, end to end.
//
//   node tests/browser/full_app_smoke.cjs
//   FULL_SHOTS=docs/screenshots node tests/browser/full_app_smoke.cjs     (also refreshes the README screenshots)
//
// For each size, desktop 1440 x 900 and phone 390 x 844 (touch), it starts the real server on a free port
// (python3 -m gameofailife --seed 1 --port 0 --speed 4) and a fake controller: a small WebSocket client in this
// file that says hello with a model name, claims every character and answers each fork it is sent within a
// second, with a reason. One fork it answers late, 6.5 s after it came, so the profile default plays at 5 s and
// the answer only teaches the profile (the ack says so). It takes the best home on offer in every house hunt, so
// the first evening's house hunting (Day 1 from 18:00) always ends in moves, the major events the News toast check
// waits for. Then it opens client/index.html and plays God:
//   - the welcome reaches the view and the dashboard, the scripts load in the PLAN 3.12 order, the map is drawn
//   - the 16x button reaches the server, and the HUD's AI chip counts the characters the controller plays
//   - a person is selected from the People ranking (the view selects them too), and their Owns block opens the
//     home card (get_home)
//   - a click (a tap on the phone) on an empty house on the map opens its home card
//   - the map colours switch through Wealth, Mood, Condition and None, and each one changes the map
//   - the View menu switches the map to top-down and back; a switch while the camera flies to a place still
//     lands on that place
//   - the LLM log fills with the controller's answers, with its name, model and reasons, and shows the late
//     answer on the timed-out decision
//   - a major event of the running city pops a News toast inside the window: a card with its headline that is on
//     screen (on a phone too, where a burst adds an "N more major events" card under the first headline), and
//     the headline is in the News tab
//   - no console errors and no horizontal scroll, checked along the way and at the end
// The Claude controller (examples/claude_controller.py) is not needed.
//
// Playwright is looked for as a local module, then in the global node_modules. Without it, without a browser it
// can launch, or on a Node older than 22 (no WebSocket client for the fake controller), the test prints SKIP and
// exits 0. FULL_SHOTS=<folder> saves city-iso.png, people.png, home-card.png, city-flat.png, llm-log.png and
// news.png (desktop) and phone.png (DPR 2), each once the map has finished drawing.
"use strict";

const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..", "..");
const SHOTS = process.env.FULL_SHOTS ? path.resolve(process.cwd(), process.env.FULL_SHOTS) : "";
const SIZES = [["desktop", { width: 1440, height: 900 }, false], ["phone", { width: 390, height: 844 }, true]];
const SCRIPTS = ["proj", "art", "buildings", "towers", "rail_art", "actors", "region", "lod", "lowart", "scene", "movers",
  "crowd", "trains", "pings", "camera", "minimap", "view"].map(n => `view/${n}.js`).concat(["dashboard.js", "game.js"]);
const CONTROLLER = "smoke-bot", MODEL = "fake-model-1";
const LATE_MS = 6500; // the late answer: after the 5 s window, inside the 10 s one
const MAJOR_WAIT_MS = 150000; // at 16x a game day is 37.5 s, and the seed-1 city has a few major events a day

function findPlaywright() {
  const tries = ["playwright"];
  try {
    const root = execSync("npm root -g", { stdio: ["ignore", "pipe", "ignore"], timeout: 15000 }).toString().trim();
    if (root) tries.push(path.join(root, "playwright"));
  } catch (e) { /* no npm */ }
  tries.push("/opt/node22/lib/node_modules/playwright", "/usr/lib/node_modules/playwright", "/usr/local/lib/node_modules/playwright");
  for (const t of tries) {
    try { return require(t); } catch (e) { /* next */ }
  }
  return null;
}

let failures = 0, passes = 0;
function check(ok, what, detail) {
  if (ok) { passes += 1; return true; }
  failures += 1;
  console.log(`  FAIL ${what}${detail !== undefined ? `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  return false;
}

async function waitFor(page, fn, arg, ms, what) {
  try {
    await page.waitForFunction(fn, arg, { timeout: ms, polling: 100 });
    return true;
  } catch (e) {
    return check(false, what, "timed out");
  }
}

async function until(cond, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return cond();
}

// --- the real server ---------------------------------------------------------------------------------------

function startServer() {
  const args = ["-u", "-m", "gameofailife", "--seed", "1", "--host", "127.0.0.1", "--port", "0", "--speed", "4"];
  const proc = spawn(process.env.PYTHON || "python3", args, { cwd: REPO, stdio: ["ignore", "pipe", "inherit"] });
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => { proc.kill(); reject(new Error("the server did not start in 30 s")); }, 30000);
    proc.on("exit", code => { clearTimeout(timer); reject(new Error(`the server exited (${code})`)); });
    proc.stdout.on("data", d => {
      out += d;
      const m = out.match(/Open http:\/\/[^:\s]+:(\d+) /);
      if (m) { clearTimeout(timer); proc.removeAllListeners("exit"); resolve({ proc, port: Number(m[1]) }); }
    });
  });
}

// --- the fake controller -----------------------------------------------------------------------------------

// A small deterministic generator, so a run makes the same choices in the same order.
function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Plays every character. Each fork gets an answer 150-850 ms after it arrives, except one: the first fork that
// arrives 2 s or more after the welcome (and is not a move) gets its answer LATE_MS after it arrived. Choices are
// mostly the first, usual option; a house hunt always takes its first option, the best home on offer (bought or
// rented), so a household that is asked always moves and the city has a major event on its first evening.
function startController(port) {
  const rand = prng(7);
  const c = { welcome: null, forks: 0, answered: 0, acks: [], late: null, lateAck: null, errors: [], closed: false, ws: null };
  return new Promise((resolve, reject) => {
    if (typeof WebSocket !== "function") { reject(new Error("this Node has no WebSocket client (Node 22 or newer)")); return; }
    const ws = c.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    let at = 0, rid = 0;
    const timer = setTimeout(() => reject(new Error("the controller got no welcome in 10 s")), 10000);
    ws.onopen = () => ws.send(JSON.stringify({ type: "hello", role: "controller", name: CONTROLLER, model: MODEL, characters: "all" }));
    ws.onclose = () => { c.closed = true; };
    ws.onerror = e => c.errors.push(String(e && e.message || "socket error"));
    ws.onmessage = ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { c.errors.push(`not JSON: ${String(ev.data).slice(0, 80)}`); return; }
      if (msg.type === "welcome") { c.welcome = msg; at = Date.now(); clearTimeout(timer); resolve(c); return; }
      if (msg.type === "ack") {
        c.acks.push(msg);
        if (c.late && msg.fork_id === c.late.fork_id) c.lateAck = msg;
        return;
      }
      if (msg.type === "error") { c.errors.push(msg.error); return; }
      if (msg.type !== "fork") return; // texts and invite answers: nothing to do
      c.forks += 1;
      const r = rand(), pick = r < 0.55 ? 0 : r < 0.75 ? 1 : r < 0.9 ? 2 : 3; // mostly the first, usual option
      const choice = msg.kind === "house_hunt" ? 0 : pick;
      const late = !c.late && Date.now() - at >= 2000 && !["house_hunt", "housing_trouble"].includes(msg.kind);
      const delay = late ? LATE_MS : 150 + Math.floor(rand() * 700);
      if (late) c.late = { fork_id: msg.fork_id, agent: msg.agent_id, kind: msg.kind, choice, got: Date.now(), sent: 0 };
      const label = String((msg.options[choice] || {}).label || "this");
      const name = String(msg.you && msg.you.name || "Me").split(" ")[0];
      const reason = late ? "Sorry, I took too long over this one." : `${label}: it suits ${name} today.`;
      setTimeout(() => {
        if (ws.readyState !== 1) return;
        if (late) c.late.sent = Date.now();
        rid += 1;
        ws.send(JSON.stringify({ type: "choose", fork_id: msg.fork_id, choice, reason: reason.slice(0, 200), req_id: `smoke:${rid}` }));
        c.answered += 1;
      }, delay);
    };
  });
}

// --- the page ----------------------------------------------------------------------------------------------

// Runs before any page script: keeps the CityView instance game.js makes (window.__view, used only to find where
// a house is on screen), the last state.homes and state.agents the page was sent (window.__net), and every major
// toast that appears, with whether it sat inside the window (window.__toasts).
//
// Major cards and the coalesced "N more major events" card are read from the mutation records, so a card that
// came and went within one task is recorded too, as not shown: a page that added a headline card and folded it
// into the coalesced card at once would show the player no headline, and the toast check counts only cards that
// were on screen. `shown` says whether the card was still on the page when the observer ran; `inside` is
// measured only then; `head` is the card's headline.
function instrument() {
  const CV = window.CityView = window.CityView || {};
  let create = null;
  Object.defineProperty(CV, "create", {
    configurable: true, enumerable: true,
    get() { return create && function () { const v = create.apply(this, arguments); window.__view = v; return v; }; },
    set(fn) { create = fn; },
  });
  const net = window.__net = { homes: {}, agents: [], frames: 0, welcomes: 0, lateForks: [], majors: [] };
  const Native = window.WebSocket;
  const Wrapped = function (url, protocols) {
    const s = protocols === undefined ? new Native(url) : new Native(url, protocols);
    s.addEventListener("message", ev => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type !== "welcome" && m.type !== "state") return;
      if (m.type === "welcome") net.welcomes += 1;
      if (m.state.homes) net.homes = m.state.homes;
      net.agents = m.state.agents;
      net.frames += 1;
      for (const f of m.forks || []) if (f.late) net.lateForks.push(f);
      for (const e of m.events || []) if (e.importance >= 2 && m.type === "state") net.majors.push(`${e.time} ${e.text}`);
    });
    return s;
  };
  Wrapped.prototype = Native.prototype;
  for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) Wrapped[k] = Native[k];
  window.WebSocket = Wrapped;
  window.__toasts = [];
  document.addEventListener("DOMContentLoaded", () => {
    const box = document.getElementById("toasts");
    if (!box) return;
    new MutationObserver(records => {
      for (const rec of records) {
        for (const t of rec.addedNodes) {
          if (t.nodeType !== 1 || t.__seen || !t.matches(".dash-toast.major, .dash-toast.more")) continue;
          t.__seen = true;
          const shown = t.isConnected, r = shown ? t.getBoundingClientRect() : null;
          const head = t.querySelector(".dash-ttext");
          window.__toasts.push({ kind: t.classList.contains("more") ? "more" : "major", head: head ? head.textContent.trim() : "",
            text: t.textContent.trim().slice(0, 160), shown,
            inside: shown ? r.width > 0 && r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight + 1 : null });
        }
      }
    }).observe(box, { childList: true, subtree: true });
  });
}

async function noSideScroll(page, what) {
  const wide = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, view: innerWidth }));
  check(wide.doc <= wide.view && wide.body <= wide.view, `${what}: no horizontal scroll`, wide);
}

// Waits until the map has finished drawing: the view builds its cached ground a couple of chunks a frame after a
// switch of projection or a big zoom, so a frame taken too soon has bare background where ground should be.
// Finished is no new chunk built in three reads 250 ms apart; false when that has not happened in 8 s.
async function settled(page) {
  const built = () => page.evaluate(() => { const s = window.__view && window.__view.scene(); return s ? s.stats.built : -1; });
  let last = await built(), same = 0;
  for (const end = Date.now() + 8000; same < 3 && Date.now() < end;) {
    await page.waitForTimeout(250);
    const n = await built();
    same = n === last ? same + 1 : 0;
    last = n;
  }
  return same >= 3;
}

// Saves a screenshot when FULL_SHOTS is set, once the map has finished drawing; `settle` false takes it at once,
// for a picture of something that may not wait (a toast), on a map the caller already let settle.
async function shot(page, name, settle = true) {
  if (!SHOTS) return;
  if (settle) await settled(page);
  fs.mkdirSync(SHOTS, { recursive: true });
  const file = path.join(SHOTS, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`  saved ${path.relative(process.cwd(), file)}`);
}

// A cheap fingerprint of the map: 48 x 32 sampled pixels of the canvas.
const canvasPrint = page => page.evaluate(() => {
  const c = document.getElementById("map"), d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data, out = [];
  for (let j = 1; j <= 32; j++) {
    for (let i = 1; i <= 48; i++) {
      const k = 4 * (Math.floor(c.height * j / 33) * c.width + Math.floor(c.width * i / 49));
      out.push(d[k] + d[k + 1] * 256 + d[k + 2] * 65536);
    }
  }
  return out;
});
// The same, steadied: each sample is the value two of three reads 150 ms apart agree on (-1 when none do), so
// rain streaks and other passing pixels mostly drop out of the comparison.
async function steadyPrint(page) {
  const r = [];
  for (let k = 0; k < 3; k++) { if (k) await page.waitForTimeout(150); r.push(await canvasPrint(page)); }
  return r[0].map((v, i) => v === r[1][i] || v === r[2][i] ? v : r[1][i] === r[2][i] ? r[1][i] : -1);
}
const changed = (a, b) => a.reduce((n, v, i) => n + (v !== b[i] && v !== -1 && b[i] !== -1 ? 1 : 0), 0);

// Flies the camera to a house and clicks (taps) the canvas where the view draws it. Returns the point, or an
// object with `miss` when no point of the building could be hit (a person or a taller building in front of it).
async function clickPlace(page, placeId, touch) {
  await page.evaluate(id => window.__view.focus({ place: id }, { inset: Dash.inspect().inset, zoom: 2 }), placeId);
  await page.waitForTimeout(900);
  const spot = await page.evaluate(id => {
    const v = window.__view, c = document.getElementById("map").getBoundingClientRect(), ins = Dash.inspect().inset;
    const mid = v.screenOf({ place: id });
    if (!mid) return { miss: "no screen position" };
    for (const [dx, dy] of [[0, 0], [0, 8], [-10, 4], [10, 4], [0, -10], [-16, 10], [16, 10], [0, 18], [-24, 0], [24, 0]]) {
      const x = mid[0] + dx, y = mid[1] + dy;
      if (x < 4 || y < (ins.top || 0) + 4 || x > c.width - (ins.right || 0) - 4 || y > c.height - (ins.bottom || 0) - 4) continue;
      const hit = v.pick(x, y, false);
      if (hit && hit.kind === "place" && hit.id === id) return { x: c.left + x, y: c.top + y };
    }
    return { miss: { mid, inset: ins } };
  }, placeId);
  if (spot.miss) return spot;
  if (touch) await page.touchscreen.tap(spot.x, spot.y); else await page.mouse.click(spot.x, spot.y);
  return spot;
}

// Clicks the map-colour switch for one overlay ("" is None): the one over the map, or on a phone (where it is
// not over the map) the one in the City tab's Map colours section.
async function pickOverlay(page, key) {
  const over = page.locator(`#overlay-chips [data-overlay="${key}"]`);
  if (await over.count() && await over.first().isVisible()) { await over.first().click(); return; }
  await page.evaluate(() => Dash.openTab("city", { section: "map" }));
  const inPanel = page.locator(`#panel [data-sec="map"] [data-overlay="${key}"]`).first();
  await inPanel.scrollIntoViewIfNeeded();
  await inPanel.click();
}

async function run(browser, name, size, touch) {
  console.log(`${name} ${size.width}x${size.height}`);
  const server = await startServer();
  const base = `http://127.0.0.1:${server.port}`;
  let ctl = null, ctx = null;
  try {
    ctl = await startController(server.port);
    check(ctl.welcome.characters.length === 60 && ctl.welcome.answer_seconds === 5, "the controller claims all 60 characters",
      { claimed: ctl.welcome.characters.length, answer_seconds: ctl.welcome.answer_seconds });

    ctx = await browser.newContext({ viewport: size, deviceScaleFactor: touch && SHOTS ? 2 : 1, hasTouch: touch, isMobile: touch });
    await ctx.addInitScript(instrument);
    const page = await ctx.newPage();
    const errors = [];
    page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    page.on("pageerror", e => errors.push(String(e && e.message || e)));
    await page.goto(`${base}/`);

    // The welcome reached the view and the dashboard.
    await waitFor(page, () => window.Dash && Dash.inspect() && Dash.inspect().role === "god" && Dash.inspect().host.kind === "server"
      && /^Day /.test(document.getElementById("clock").textContent) && window.__view, null, 20000, "the welcome");
    const order = await page.evaluate(() => [...document.scripts].map(s => s.getAttribute("src")));
    check(JSON.stringify(order) === JSON.stringify(SCRIPTS), "the PLAN 3.12 script order", order);
    await page.waitForTimeout(600);
    const drawn = await page.evaluate(() => {
      const c = document.getElementById("map"), w = document.getElementById("world").getBoundingClientRect(), r = c.getBoundingClientRect();
      const g = c.getContext("2d"), seen = new Set();
      for (let i = 1; i < 10; i++) for (let j = 1; j < 10; j++) { const d = g.getImageData(Math.floor(c.width * i / 10), Math.floor(c.height * j / 10), 1, 1).data; seen.add(`${d[0]},${d[1]},${d[2]}`); }
      return { ok: c.width > 0 && seen.size > 3 && Math.abs(r.width - w.width) < 2 && Math.abs(r.height - w.height) < 2 && r.height > 100, colours: seen.size };
    });
    check(drawn.ok, "the map is drawn and fills #world", drawn);
    await noSideScroll(page, "after loading");

    // God speeds the city up, and the HUD counts the controller's characters.
    await page.click('#speed button[data-speed="16"]');
    await waitFor(page, () => document.querySelector('#speed button[data-speed="16"]').classList.contains("on"), null, 3000, "speed 16x");
    // The chip shows a thinking count only while someone thinks: "AI: 60 playing, 2 thinking", on a phone "AI 60 2".
    // The check reads the text the wait matched, so a fork closing between two reads cannot fail it.
    const chipRe = touch ? /^AI (\d+) [1-9]\d*$/ : /^AI: (\d+) playing, [1-9]\d* thinking$/;
    const ai = await page.waitForFunction(re => {
      const b = document.querySelector('#hud [data-k="ai"]'), t = b ? b.innerText.trim().replace(/\s+/g, " ") : "";
      return new RegExp(re).test(t) ? t : false;
    }, chipRe.source, { timeout: 10000 }).then(h => h.jsonValue()).catch(() => null);
    check(!!ai && chipRe.exec(ai)[1] === "60", "the AI chip counts the controller's characters", ai || "timed out");
    await page.waitForTimeout(1500);
    const cam0 = await page.evaluate(() => window.__view.camera());
    if (!touch) await shot(page, "city-iso");

    // Select a person from the People ranking: the dashboard and the view agree, and the Owns block opens the
    // home card.
    await page.evaluate(() => Dash.openTab("people"));
    await waitFor(page, () => document.querySelectorAll(".dash-rank > li").length >= 30, null, 8000, "the ranking rows");
    if (!touch) await shot(page, "people");
    const first = await page.evaluate(() => document.querySelector(".dash-rank > li").dataset.key);
    await page.click(".dash-rank > li");
    await waitFor(page, () => document.querySelector('.dash-rank [data-act="open"]'), null, 3000, "the expanded ranking row");
    await page.click('.dash-rank [data-act="open"]');
    await waitFor(page, id => Dash.selected() === id && window.__view.selected() === id, first, 3000, "selecting a person (dashboard and view)");
    await waitFor(page, () => /Owns/.test(document.getElementById("panel").textContent) && document.querySelector('#panel .dash-ownhome [data-act="home"]'),
      null, 6000, "the person's Owns block with its Home card button");
    const own = await page.evaluate(() => document.querySelector('#panel .dash-ownhome [data-act="home"]').dataset.home);
    await page.click('#panel .dash-ownhome [data-act="home"]');
    await waitFor(page, id => Dash.inspect().card === id && /Residents/.test(document.getElementById("panel").textContent), own, 5000,
      "the home card from the Owns block");
    const card = await page.evaluate(() => {
      const p = document.querySelector("#panel .dash-card:not([hidden])"), h = p && p.querySelector("h2");
      return { title: h && h.textContent.trim(), residents: p ? [...p.querySelectorAll(".dash-pchip")].map(b => b.textContent.trim()) : [] };
    });
    const name1 = await page.evaluate(id => (window.__net.agents.find(a => a.id === id) || {}).name, first);
    check(!!card.title && card.residents.includes(name1), "the home card names the home and the person among its residents", { card, name1 });
    await page.click('#panel .dash-card:not([hidden]) [data-act="map"]');
    await page.waitForTimeout(900);
    if (!touch) await shot(page, "home-card");
    await noSideScroll(page, "the home card");
    await page.evaluate(() => Dash.selectAgent(null));

    // A click (a tap on the phone) on an empty house on the map opens its home card.
    const vacant = await page.evaluate(() => {
      const net = window.__net, town = window.__view.scene().town, place = new Map(town.places.map(p => [p.id, p]));
      const busy = new Set(net.agents.filter(a => a.alive && a.inside).map(a => a.inside));
      return town.homes.filter(h => place.get(h.place).units === 1 && net.homes[h.id] && net.homes[h.id].hh === null && !busy.has(h.place))
        .map(h => ({ id: h.id, name: h.name }));
    });
    check(vacant.length > 0, "the city has an empty house to click", vacant);
    let opened = null;
    const misses = [];
    for (const h of vacant) {
      const spot = await clickPlace(page, h.id, touch);
      if (spot.miss) { misses.push([h.id, spot.miss]); continue; }
      try {
        await page.waitForFunction(id => Dash.inspect().card === id && /Nobody lives here|For sale|To let/.test(document.getElementById("panel").textContent), h.id, { timeout: 4000 });
        opened = h;
        break;
      } catch (e) { misses.push([h.id, "no card"]); }
    }
    check(!!opened, "a click on an empty house on the map opens its home card", misses);
    if (opened) {
      const title = await page.evaluate(() => (document.querySelector("#panel .dash-card:not([hidden]) h2") || {}).textContent || "");
      check(title.includes(opened.name), "the card is that house's", { title, want: opened.name });
    }
    await noSideScroll(page, "the map's home card");

    // The map colours: each one changes the map (measured on Maple Grove's houses while the city is paused,
    // against a repeat of None).
    await page.click('#speed button[data-speed="0"]');
    await page.evaluate(() => window.__view.focus({ place: "main_28" }, { inset: Dash.inspect().inset, zoom: 1 }));
    await page.waitForTimeout(1200);
    await pickOverlay(page, "");
    await page.waitForTimeout(300);
    const none1 = await steadyPrint(page);
    const none2 = await steadyPrint(page);
    const noise = changed(none1, none2);
    for (const key of ["wealth", "mood", "condition"]) {
      await pickOverlay(page, key);
      await waitFor(page, k => Dash.inspect().overlay === k, key, 2000, `the ${key} overlay`);
      await page.waitForTimeout(300);
      const n = changed(none1, await steadyPrint(page));
      check(n > 2 * noise + 12, `the ${key} overlay colours the map`, { changed: n, noise });
      console.log(`  ${name}: the ${key} overlay changes ${n} of ${none1.length} samples (noise ${noise})`);
    }
    await pickOverlay(page, "");
    await waitFor(page, () => Dash.inspect().overlay === null, null, 2000, "back to no overlay");
    await page.click('#speed button[data-speed="16"]');

    // The View menu: top-down and back. A switch while the camera flies to a place still lands on the place.
    await page.evaluate(() => { Dash.openTab("city"); window.__view.focus({ place: "cityhall" }, { inset: Dash.inspect().inset, zoom: 1.5 }); });
    await page.click(".cv-btn-view");
    await page.click('.cv-menu-item:text-is("Top-down")');
    await waitFor(page, () => window.__view.camera().projection === "flat", null, 2000, "the top-down view");
    await page.waitForTimeout(1200);
    const landed = await page.evaluate(() => {
      const c = window.__view.camera(), p = window.__view.scene().town.places.find(q => q.id === "cityhall");
      return { cam: [c.x, c.y], place: [p.x + p.w / 2, p.y + p.h / 2] };
    });
    check(Math.hypot(landed.cam[0] - landed.place[0], landed.cam[1] - landed.place[1]) < 4,
      "a switch to top-down during a camera flight still lands on its target", landed);
    await page.click('.cv-ctl [aria-label="Whole city"]');
    await page.waitForTimeout(900);
    if (!touch) await shot(page, "city-flat");
    await page.click(".cv-btn-view");
    await page.click('.cv-menu-item:text-is("Isometric")');
    await waitFor(page, () => window.__view.camera().projection === "iso", null, 2000, "back to the isometric view");
    check(await settled(page), "the isometric map finishes drawing after the switch back");

    // The LLM log: the controller's answers, then its late answer on a timed-out decision.
    await page.evaluate(() => Dash.openTab("llm"));
    await waitFor(page, () => document.querySelectorAll(".dash-llmlist > li.by-model").length >= 5, null, 15000, "the LLM log rows");
    const log = await page.evaluate(() => {
      const box = document.querySelector("#panel .dash-llmlist"), strip = document.querySelector("#panel .dash-aistrip");
      return { rows: box.children.length, text: box.textContent, strip: strip ? strip.textContent : "" };
    });
    check(/it suits \w+ today/.test(log.text), "the LLM log shows the controller's reasons", log.text.slice(0, 200));
    check(log.strip.includes(CONTROLLER) && log.strip.includes(MODEL), "the counter strip names the controller and its model", log.strip.slice(0, 200));
    if (!touch) await shot(page, "llm-log");
    check(await until(() => ctl.lateAck, LATE_MS + 8000), "the late answer got an ack", ctl.late);
    if (ctl.lateAck) {
      const waited = (ctl.late.sent - ctl.late.got) / 1000;
      check(ctl.lateAck.accepted === true && ctl.lateAck.applied === false && /too late to act on/.test(ctl.lateAck.note || ""),
        "the late answer only teaches the profile", ctl.lateAck);
      check(waited > 5 && waited < 10, "the late answer went between 5 and 10 s after the fork", waited);
    }
    if (ctl.late) {
      await page.evaluate(id => {
        const box = document.getElementById("panel");
        const t = box.querySelector('[data-f="timeouts"]');
        if (!t.checked) t.click();
        const sel = box.querySelector(".dash-llm-agent");
        sel.value = id;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      }, ctl.late.agent);
      await waitFor(page, id => { const li = document.querySelector(`#panel .dash-llmlist > li[data-key="${id}"]`); return li && li.querySelector(".dash-tag.late"); },
        ctl.late.fork_id, 8000, "the late answer's row in the LLM log");
      const row = await page.evaluate(id => {
        const li = document.querySelector(`#panel .dash-llmlist > li[data-key="${id}"]`);
        return li ? { cls: li.className, text: li.textContent.replace(/\s+/g, " ").trim() } : null;
      }, ctl.late.fork_id);
      check(row && /by-timeout/.test(row.cls) && /No answer in 5 s/.test(row.text) && new RegExp(`${CONTROLLER} answered after \\d+(\\.\\d)? s`).test(row.text)
        && /saved to the profile/.test(row.text), "the late row: the profile played, then the controller answered late", row);
      const frames = await page.evaluate(id => window.__net.lateForks.filter(f => f.id === id).map(f => f.late), ctl.late.fork_id);
      check(frames.length > 0 && frames[0].choice === ctl.late.choice && frames[0].seconds > 5 && frames[0].seconds < 10,
        "a state frame carried the fork again with its late answer", frames);
      await page.evaluate(() => {
        const box = document.getElementById("panel"), sel = box.querySelector(".dash-llm-agent");
        sel.value = "";
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        box.querySelector('[data-f="timeouts"]').click();
      });
    }
    await noSideScroll(page, "the LLM log");

    // A major event of the running city: a News toast inside the window, and the same headline in News.
    await page.evaluate(c => { window.__view.setCamera({ x: c.x, y: c.y, zoom: c.zoom }); Dash.openTab("city"); }, cam0);
    if (touch) await page.evaluate(() => { const t = document.querySelector('#panel .dash-tab[data-tab="city"]'); if (t) t.click(); });
    await settled(page); // so the phone's picture of the toast can be taken the moment it is up
    const headline = () => window.__toasts.some(t => t.kind === "major" && t.shown);
    const toasted = await page.waitForFunction(headline, null, { timeout: MAJOR_WAIT_MS, polling: 100 }).then(() => true, () => false);
    if (touch && toasted && SHOTS) {
      // the picture is taken while a headline card is up: this one, or the next when it has gone
      await page.waitForFunction(() => document.querySelector("#toasts .dash-toast.major"), null, { timeout: MAJOR_WAIT_MS, polling: 100 }).catch(() => {});
      await page.waitForTimeout(300); // after the card's 0.2 s fade-in
      await shot(page, "phone", false);
    }
    const seen = await page.evaluate(() => ({ majors: window.__net.majors.slice(0, 5), count: window.__net.majors.length,
      welcomes: window.__net.welcomes, toasts: Dash.inspect().toasts, time: document.getElementById("clock").textContent }));
    check(toasted, "a major event pops a News toast with its headline on screen", seen);
    const toasts = await page.evaluate(() => window.__toasts.slice());
    const unseen = toasts.filter(t => t.kind === "major" && !t.shown);
    check(!unseen.length, "no headline card is taken off the page as soon as it is added", toasts);
    if (toasted) {
      check(toasts.filter(t => t.shown).every(t => t.inside), "the toasts sit inside the window", toasts);
      await page.evaluate(() => Dash.openTab("news"));
      const head = toasts.find(t => t.kind === "major" && t.shown).head.slice(0, 40);
      await waitFor(page, h => !!h && document.getElementById("panel").textContent.includes(h), head, 3000, "the toast's headline in the News tab");
      await page.waitForTimeout(1200);
      if (!touch) await shot(page, "news");
    }

    await noSideScroll(page, "at the end");
    check(!errors.length, "no console errors", errors.slice(0, 5));
    check(!ctl.closed && !ctl.errors.length, "the controller stayed connected with no errors", { closed: ctl.closed, errors: ctl.errors.slice(0, 5) });
    const applied = ctl.acks.filter(a => a.accepted && a.applied).length;
    check(applied >= 5, "the controller's in-time answers were played", { forks: ctl.forks, answered: ctl.answered, applied });
    const cards = k => toasts.filter(t => t.kind === k).length;
    console.log(`  ${ctl.forks} forks asked, ${applied} answers played in time, ${cards("major")} major toasts, ${cards("more")} coalesced`);
    console.log(`  the first major events: ${seen.count ? seen.majors.slice(0, 3).join(" | ") : "none"} (the clock when the check ended: ${seen.time}; welcomes: ${seen.welcomes})`);
  } finally {
    if (ctx) await ctx.close();
    if (ctl && ctl.ws) { try { ctl.ws.close(); } catch (e) { /* closing anyway */ } }
    server.proc.kill();
  }
}

(async () => {
  if (typeof WebSocket !== "function") { console.log("SKIP: this Node has no WebSocket client (Node 22 or newer)"); process.exit(0); }
  const pw = findPlaywright();
  if (!pw || !pw.chromium) { console.log("SKIP: Playwright is not installed"); process.exit(0); }
  let browser;
  try { browser = await pw.chromium.launch(); } catch (e) {
    console.log(`SKIP: Chromium did not launch (${String(e && e.message || e).split("\n")[0]})`);
    process.exit(0);
  }
  try {
    for (const [name, size, touch] of SIZES) await run(browser, name, size, touch);
  } catch (e) {
    check(false, "the run", String(e && e.stack || e));
  } finally {
    await browser.close();
  }
  console.log(`${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();

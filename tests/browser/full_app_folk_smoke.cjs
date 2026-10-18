#!/usr/bin/env node
// Full-app folk smoke test: the real server and the real God view, with townsfolk injected into what the page is
// sent, so the dashboard and the view meet folk ids ("f0".."f999") the way they will in a 1,060-person city.
//
//   node tests/browser/full_app_folk_smoke.cjs
//
// It starts the real server (python3 -m gameofailife --seed 1 --port 0 --speed 4; with --world millbrook --folk 0
// when the server has those options) and opens client/index.html as God, desktop 1440 x 900 and phone 390 x 844
// (touch). An init script wraps the page's WebSocket: every welcome and state frame the page receives is
// rewritten before game.js sees it, so the page gets
//   - state.folk_n 1000 and state.crowd rows for 240 townsfolk standing on road tiles of the town (view data:
//     docs/protocol.md "View data"),
//   - state.talks rows: an indoor folk talk at the cafe and an outdoor one between two folk on a road,
//   - and, from the test, events (seq 10,000,000 and up) that name folk in `agent` and `agents`: a routine talk,
//     a notable new friendship, a folk-only major (a wedding of two townsfolk) and a major that names one of the
//     main characters and a townsperson.
// Every message the page sends is recorded too. It checks:
//   - the view draws the crowd (debug().crowd) and shows talk pings (debug().pings) without errors
//   - News lists the folk events (Everything shows the routine talk), with no person chip for a folk id
//   - the folk-only major raises no toast; the major that names a main character does, on screen
//   - clicking the folk major's News row (Show on map) opens no person page and sends no get_agent for a folk id
//   - a click (a tap on the phone) on a townsperson on the map opens nothing, hovering one says "A townsperson"
//   - no console errors along the way and at the end
// full_app_smoke.cjs (the unchanged 60-character town) is the other half of the full-app check.
//
// Playwright is looked for as a local module, then in the global node_modules. Without it or a browser it can
// launch, the test prints SKIP and exits 0.
"use strict";

const { spawn, execSync, execFileSync } = require("child_process");
const path = require("path");

const REPO = path.resolve(__dirname, "..", "..");
const SIZES = [["desktop", { width: 1440, height: 900 }, false], ["phone", { width: 390, height: 844 }, true]];
const FOLK_SEQ = 10000000;

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

// --- the real server ---------------------------------------------------------------------------------------

function serverArgs() {
  const args = ["-u", "-m", "gameofailife", "--seed", "1", "--host", "127.0.0.1", "--port", "0", "--speed", "4"];
  let help = "";
  try {
    help = execFileSync(process.env.PYTHON || "python3", ["-m", "gameofailife", "--help"], { cwd: REPO, timeout: 30000 }).toString();
  } catch (e) { /* no help: the plain town */ }
  if (/--world\b/.test(help)) args.push("--world", "millbrook");
  if (/--folk\b/.test(help)) args.push("--folk", "0");
  return args;
}

function startServer(args) {
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

// --- the page ----------------------------------------------------------------------------------------------

// Runs before any page script. Keeps the CityView instance (window.__view) and wraps WebSocket: the page's
// onmessage handler (game.js sets ws.onmessage) is handed each welcome and state frame with the folk added,
// and every message the page sends is kept in window.__sent. window.__folkEvents is a queue the test fills; the
// next state frame carries those events. window.__toasts records each major toast as full_app_smoke does.
function instrument(FOLK_SEQ) {
  const CV = window.CityView = window.CityView || {};
  let create = null;
  Object.defineProperty(CV, "create", {
    configurable: true, enumerable: true,
    get() { return create && function () { const v = create.apply(this, arguments); window.__view = v; return v; }; },
    set(fn) { create = fn; },
  });
  const net = window.__net = { frames: 0, town: null, roads: [], cafe: -1, injected: 0, lastTick: 0, main: null };
  window.__sent = [];
  window.__folkEvents = [];
  const N = 240;
  function roadsOf(town) {
    const out = [];
    (town.tiles || []).forEach((row, y) => { for (let x = 0; x < row.length; x++) if (row[x] === "#") out.push([x, y]); });
    return out;
  }
  function folkify(m) {
    if (m.type !== "welcome" && m.type !== "state") return m;
    if (m.type === "welcome" && m.town) {
      net.town = m.town;
      net.roads = roadsOf(m.town);
      net.cafe = (m.town.places || []).findIndex(p => p.kind === "cafe");
    }
    const st = m.state;
    if (!st || !net.roads.length) return m;
    net.frames += 1;
    net.lastTick = st.tick;
    if (!net.main) { const a = (st.agents || []).find(x => x.alive && x.name); if (a) net.main = { id: a.id, name: a.name }; }
    st.folk_n = 1000;
    const crowd = [];
    for (let i = 0; i < N; i++) {
      const t = net.roads[(i * 37 + 11) % net.roads.length];
      crowd.push(i, t[0], t[1], i % 9 === 4 ? 6 : 0);  // walking (standing on one tile) or waiting
    }
    st.crowd = crowd;
    st.talks = [[net.cafe, "f12", "f13", 0, st.tick], [-1, "f20", "f21", 1, st.tick]];
    if (m.type === "state" && window.__folkEvents.length) {
      const evs = window.__folkEvents.splice(0);
      for (const e of evs) { e.tick = st.tick; e.time = e.time || (m.events && m.events[0] && m.events[0].time) || st.time || ""; }
      m.events = (m.events || []).concat(evs);
      net.injected += evs.length;
    }
    return m;
  }
  const Native = window.WebSocket;
  const Wrapped = function (url, protocols) {
    const s = protocols === undefined ? new Native(url) : new Native(url, protocols);
    const send = s.send.bind(s);
    s.send = d => { window.__sent.push(String(d)); return send(d); };
    let handler = null;
    Object.defineProperty(s, "onmessage", {
      configurable: true,
      get() { return handler; },
      set(fn) { handler = fn; },
    });
    s.addEventListener("message", ev => {
      if (!handler) return;
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { handler.call(s, ev); return; }
      const data = JSON.stringify(folkify(m));
      handler.call(s, new MessageEvent("message", { data, origin: ev.origin }));
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
            text: t.textContent.trim().slice(0, 200), shown,
            inside: shown ? r.width > 0 && r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight + 1 : null });
        }
      }
    }).observe(box, { childList: true, subtree: true });
  });
}

// The folk events the test injects, by name. `named` is a main character's id and name, for the one major that
// should still toast.
function folkEvents(placeOf, named) {
  return {
    talk: { seq: FOLK_SEQ + 1, kind: "social", tag: "talk", importance: 0, major: false,
      text: "Two townspeople, Lev and Ruth, talk over coffee.", agent: "f12", agents: ["f12", "f13"], place: placeOf("cafe") },
    friend: { seq: FOLK_SEQ + 2, kind: "social", tag: "new_friend", importance: 1, major: false,
      text: "Townspeople Noa and Gil become friends.", agents: ["f40", "f41"], place: placeOf("park") },
    rift: { seq: FOLK_SEQ + 3, kind: "social", tag: "falling_out", importance: 1, major: false,
      text: "A townsperson, Omri, falls out with a neighbour.", agent: "f88" },
    wedding: { seq: FOLK_SEQ + 4, kind: "social", tag: "wedding", importance: 2, major: true,
      text: "Townsfolk wedding: Noa and Gil marry in the park.", agents: ["f40", "f41"], place: placeOf("park") },
    mixed: { seq: FOLK_SEQ + 5, kind: "social", tag: "partner", importance: 2, major: true,
      text: `${named.name} and Mira, a townsperson, become partners.`, agents: [named.id, "f77"], place: placeOf("cafe") },
  };
}

const sentGetAgent = page => page.evaluate(() => window.__sent.map(d => { try { return JSON.parse(d); } catch (e) { return {}; } })
  .filter(m => m.type === "get_agent").map(m => m.agent_id));

// Finds a townsperson on screen that view.pick returns, inside the map's free area; null when none can be hit.
const folkSpot = page => page.evaluate(() => {
  const v = window.__view, c = document.getElementById("map").getBoundingClientRect(), ins = Dash.inspect().inset;
  const x0 = (ins.left || 0) + 8, y0 = (ins.top || 0) + 8, x1 = c.width - (ins.right || 0) - 8, y1 = c.height - (ins.bottom || 0) - 8;
  for (let i = 0; i < 240; i++) {
    const p = v.screenOf({ agent: `f${i}` });
    if (!p || p[0] < x0 || p[0] > x1 || p[1] < y0 || p[1] > y1) continue;
    for (const [dx, dy] of [[0, -8], [0, -4], [0, -12], [0, 0]]) {
      const hit = v.pick(p[0] + dx, p[1] + dy, false);
      if (hit && hit.kind === "agent" && /^f\d+$/.test(String(hit.id))) return { x: c.left + p[0] + dx, y: c.top + p[1] + dy, id: hit.id, folk: !!hit.folk };
    }
  }
  return null;
});

async function run(browser, name, size, touch, args) {
  console.log(`${name} ${size.width}x${size.height}`);
  const server = await startServer(args);
  const base = `http://127.0.0.1:${server.port}`;
  let ctx = null;
  try {
    ctx = await browser.newContext({ viewport: size, hasTouch: touch, isMobile: touch });
    await ctx.addInitScript(instrument, FOLK_SEQ);
    const page = await ctx.newPage();
    const errors = [];
    page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    page.on("pageerror", e => errors.push(String(e && e.message || e)));
    await page.goto(`${base}/`);

    await waitFor(page, () => window.Dash && Dash.inspect() && Dash.inspect().role === "god" && window.__view
      && window.__net.frames >= 3, null, 20000, "the welcome and a few folk frames");
    check(errors.length === 0, "no console errors with folk in the frames", errors.slice(0, 5));

    // The view draws the crowd and the talk pings.
    await page.waitForTimeout(800);
    const dbg = await page.evaluate(() => window.__view.debug());
    check(dbg.crowd === 240, "the view holds the 240 injected townsfolk", { crowd: dbg.crowd, drawn: dbg.crowdDrawn });
    check(dbg.crowdDrawn > 0, "townsfolk are drawn in the view", dbg.crowdDrawn);
    await waitFor(page, () => window.__view.debug().pings >= 1, null, 4000, "the folk talk rows show as pings");

    // Inject the folk events and wait for them to reach the dashboard.
    const info = await page.evaluate(() => {
      const t = window.__net.town, st = Dash.inspect();
      const placeIds = {};
      for (const p of t.places) if (!placeIds[p.kind]) placeIds[p.kind] = p.id;
      return { placeIds, events: st.events };
    });
    // A main character: the first one alive in the frames.
    const mainChar = await page.evaluate(() => window.__net.main);
    check(!!mainChar, "the frames name a main character", mainChar);
    const mainName = mainChar ? mainChar.name : "Tom Levi";
    const E = folkEvents(k => info.placeIds[k] || null, { id: mainChar ? mainChar.id : "tom", name: mainName });
    await page.evaluate(evs => { window.__folkEvents.push(...evs); }, [E.talk, E.friend, E.rift, E.wedding]);
    await waitFor(page, n => Dash.inspect().events >= n, info.events + 4, 8000, "the folk events reach the dashboard");
    await page.waitForTimeout(1200);

    // News lists them; Everything shows the routine talk; no person chip for a folk id.
    await page.evaluate(() => Dash.openTab("news"));
    await page.waitForTimeout(300);
    const news = await page.evaluate(seq => {
      const box = document.getElementById("panel") || document.body;
      const text = box.textContent;
      const row = n => !!box.querySelector(`.dash-stream [data-seq="${n}"]`);
      const head = !!box.querySelector(`.dash-heads [data-seq="${seq + 4}"]`);
      const folkChips = [...box.querySelectorAll("[data-person]")].map(b => b.dataset.person).filter(id => /^f\d+$/.test(id));
      return { friend: row(seq + 2), rift: row(seq + 3), wedding: row(seq + 4), head, folkChips,
        weddingText: text.includes("Townsfolk wedding: Noa and Gil marry in the park.") };
    }, FOLK_SEQ);
    check(news.friend && news.rift && news.wedding, "News lists the folk events", news);
    check(news.head && news.weddingText, "the folk-only major is a News headline", news);
    check(news.folkChips.length === 0, "no person chip for a folk id", news.folkChips);
    await page.evaluate(() => { const b = document.querySelector('#panel [data-level="all"]') || document.querySelector('[data-level="all"]'); if (b) b.click(); });
    await page.waitForTimeout(300);
    const talkRow = await page.evaluate(seq => !!document.querySelector(`.dash-stream [data-seq="${seq + 1}"]`), FOLK_SEQ);
    check(talkRow, "News > Everything lists the routine folk talk");

    // The folk-only major raised no toast.
    const toasts1 = await page.evaluate(() => window.__toasts.slice());
    check(!toasts1.some(t => /Townsfolk wedding/.test(t.text)), "the folk-only major raises no toast", toasts1.map(t => t.text));

    // A major naming a main character and a townsperson does toast.
    await page.evaluate(e => { window.__folkEvents.push(e); }, E.mixed);
    const toasted = await waitFor(page, txt => window.__toasts.some(t => t.shown && t.text.includes(txt)) ||
      window.__toasts.some(t => t.kind === "more" && t.shown), E.mixed.text.slice(0, 40), 8000, "the major naming a main character toasts");
    if (toasted) {
      const t = await page.evaluate(txt => window.__toasts.find(x => x.text.includes(txt)) || window.__toasts.find(x => x.kind === "more"), E.mixed.text.slice(0, 40));
      check(t && t.inside, "its toast is inside the window", t);
    }

    // Clicking the folk major's row (and its Show on map) opens no person page and asks for no folk agent.
    await page.evaluate(() => Dash.openTab("news"));
    const before = await page.evaluate(() => Dash.inspect());
    await page.evaluate(seq => {
      const row = document.querySelector(`.dash-stream [data-seq="${seq + 4}"]`);
      if (row) row.click();
      const pin = document.querySelector(`.dash-heads .dash-link[data-seq="${seq + 4}"]`);
      if (pin) pin.click();
      const rift = document.querySelector(`.dash-stream [data-seq="${seq + 3}"]`);
      if (rift) rift.click();
    }, FOLK_SEQ);
    await page.waitForTimeout(1200);
    const after = await page.evaluate(() => Dash.inspect());
    const asked1 = await sentGetAgent(page);
    check(after.selected == null && after.tab === before.tab, "clicking folk News rows opens no person page",
      { before: [before.tab, before.selected], after: [after.tab, after.selected] });
    check(!asked1.some(id => /^f\d+$/.test(String(id))), "no get_agent is sent for a folk id (News)", asked1);
    check(errors.length === 0, "no console errors after the folk News clicks", errors.slice(0, 5));

    // A click (tap) on a townsperson on the map opens nothing; hovering one says "A townsperson".
    await page.evaluate(() => Dash.openTab("city"));
    await page.waitForTimeout(400);
    const spot = await folkSpot(page);
    if (check(!!spot, "a townsperson can be picked on the map", spot)) {
      check(spot.folk === true, "the view's pick marks it folk", spot);
      const tab0 = (await page.evaluate(() => Dash.inspect())).tab;
      if (touch) await page.touchscreen.tap(spot.x, spot.y); else await page.mouse.click(spot.x, spot.y);
      await page.waitForTimeout(900);
      const st = await page.evaluate(() => Dash.inspect());
      const asked2 = await sentGetAgent(page);
      check(st.selected == null && st.tab === tab0, "a click on a townsperson opens no person page", { tab0, tab: st.tab, selected: st.selected });
      check(!asked2.some(id => /^f\d+$/.test(String(id))), "no get_agent is sent for a folk id (map)", asked2);
      const tip = await page.evaluate(id => Dash.tooltipText({ kind: "agent", id, folk: true }), spot.id);
      check(tip === "A townsperson", "the folk tooltip text", tip);
      if (!touch) {
        await page.mouse.move(spot.x + 1, spot.y);
        await page.mouse.move(spot.x, spot.y);
        await page.waitForTimeout(300);
        const shown = await page.evaluate(() => { const t = document.getElementById("tooltip"); return t ? { hidden: t.hidden, text: t.textContent } : null; });
        check(shown && !shown.hidden && shown.text === "A townsperson", "hovering a townsperson shows \"A townsperson\"", shown);
      }
    }

    // Highlight and select calls with folk ids from the dashboard side do not break the view.
    await page.evaluate(() => { window.__view.highlight({ agents: ["f40", "f41"], places: [] }); window.__view.select("f12"); window.__view.select(null); });
    await page.waitForTimeout(500);
    check(errors.length === 0, "no console errors at the end", errors.slice(0, 5));
    const net = await page.evaluate(() => ({ frames: window.__net.frames, injected: window.__net.injected }));
    console.log(`  ${net.frames} frames, ${net.injected} folk events injected`);
  } finally {
    if (ctx) await ctx.close().catch(() => {});
    server.proc.kill();
  }
}

async function main() {
  const pw = findPlaywright();
  if (!pw) { console.log("SKIP: Playwright is not installed"); return; }
  let browser;
  try { browser = await pw.chromium.launch(); } catch (e) { console.log(`SKIP: no browser to launch (${String(e.message).split("\n")[0]})`); return; }
  const args = serverArgs();
  console.log(`server: python3 ${args.slice(1).join(" ")}`);
  try {
    for (const [name, size, touch] of SIZES) {
      if (process.env.ONLY && process.env.ONLY !== name) continue;
      await run(browser, name, size, touch, args);
    }
  } finally {
    await browser.close();
  }
  console.log(`${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });

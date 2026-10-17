#!/usr/bin/env node
// Headless smoke test for the real God view: client/index.html (game.js on CityView and the dashboard) against
// the real server, which this test starts on 127.0.0.1 with a fresh city at 4x.
//
//   node tests/browser/god_view_smoke.cjs
//
// At a desktop size (1440 x 900) and a phone size (390 x 844, touch) it checks: the page loads the view and the
// dashboard with no console errors, the map is drawn, nothing scrolls sideways, the AI chip says nobody plays (the
// phone too), a person can be selected from the People ranking (the detail opens with the Owns block and a
// character page link) and Esc on the map clears the selection (onSelect), the speed buttons reach the server, and
// a major event makes a News toast. The test asks the server for a major event (a line on its stdin) once the
// page's toasts are cleared, so the toast waits neither on luck nor on how fast the steps before it ran: a timer
// firing every 2 s filled the phone's one toast slot early and then counted later events on the "more" card.
// A run rewrites the welcome to the browser port's (host.kind "browser", no LLM log) on its way to the page:
// the LLM log shows its empty state and no character page link is rendered.
// A last run has two controllers play the city (a "play" line on the server's stdin starts them in its process):
// smoke-bot claims everyone, declares a model and answers four forks in five after a second (the fifth times
// out), and idle-bot claims nobody. At both sizes the AI chip reads "AI: 60 playing" ("AI 60" on a phone) and
// shows a thinking count only while it is above 0, each controller's line counts its own characters thinking
// (idle-bot never thinks), and a person's "LLM decisions (n)" is the server's count, the stats people row's llm.
//
// Playwright is looked for as a local module, then in the global node_modules. Without it, or without a
// browser it can launch, the test prints SKIP and exits 0. Set GOD_SHOTS=<folder> to also save screenshots.
"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..", "..");
const SHOTS = process.env.GOD_SHOTS || "";
const SIZES = [["desktop", { width: 1440, height: 900 }, false], ["phone", { width: 390, height: 844 }, true]];

// The server, which makes a major event for each "major" line on its stdin and starts two controllers on a "play"
// line. Prints its port.
const SERVER = `
import asyncio, json, sys
sys.path.insert(0, sys.argv[1])
from gameofailife import ws
from gameofailife.server import GameServer
from gameofailife.sim import Simulation

async def bot(port, name, characters, model):
    # Answers four forks in five after a second; the fifth times out. A bot that claims nobody gets no forks.
    sock = await ws.connect(f"ws://127.0.0.1:{port}/ws")
    hello = {"type": "hello", "role": "controller", "name": name, "characters": characters}
    if model:
        hello["model"] = model
    await sock.send(json.dumps(hello))

    async def answer(fork_id):
        await asyncio.sleep(1)
        try:
            await sock.send(json.dumps({"type": "choose", "fork_id": fork_id, "choice": 0, "reason": "smoke"}))
        except ws.ConnectionClosed:
            pass

    n = 0
    tasks = set()
    while True:
        try:
            msg = json.loads(await sock.recv())
        except ws.ConnectionClosed:
            return
        if msg.get("type") == "fork":
            n += 1
            if n % 5:
                t = asyncio.create_task(answer(msg["fork_id"]))
                tasks.add(t)
                t.add_done_callback(tasks.discard)

async def main():
    sim = Simulation(seed=1)
    server = GameServer(sim, speed=4)
    port = await server.start("127.0.0.1", 0)
    print(port, flush=True)
    loop = asyncio.get_running_loop()
    n = 0
    bots = []
    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:
            return
        if line.strip() == "major":
            people = sim.living()
            a = people[n % len(people)]
            n += 1
            sim.event(f"{a.name} won the Millbrook raffle.", a, tag="big_money")
        elif line.strip() == "play" and not bots:
            bots = [asyncio.create_task(bot(port, "smoke-bot", "all", "smoke-model")),
                    asyncio.create_task(bot(port, "idle-bot", [], None))]

asyncio.run(main())
`;

function findPlaywright() {
  const tries = ["playwright"];
  try {
    const root = require("child_process").execSync("npm root -g", { stdio: ["ignore", "pipe", "ignore"], timeout: 15000 })
      .toString().trim();
    if (root) tries.push(path.join(root, "playwright"));
  } catch (e) { /* no npm */ }
  tries.push("/opt/node22/lib/node_modules/playwright", "/usr/lib/node_modules/playwright", "/usr/local/lib/node_modules/playwright");
  for (const t of tries) {
    try { return require(t); } catch (e) { /* next */ }
  }
  return null;
}

function startServer() {
  const proc = spawn(process.env.PYTHON || "python3", ["-c", SERVER, REPO], { stdio: ["pipe", "pipe", "inherit"] });
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => { proc.kill(); reject(new Error("the server did not start in 30 s")); }, 30000);
    proc.on("exit", code => { clearTimeout(timer); reject(new Error(`the server exited (${code})`)); });
    proc.stdout.on("data", d => {
      out += d;
      const m = out.match(/^(\d+)\n/);
      if (m) { clearTimeout(timer); proc.removeAllListeners("exit"); resolve({ proc, port: Number(m[1]) }); }
    });
  });
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
    await page.waitForFunction(fn, arg, { timeout: ms });
    return true;
  } catch (e) {
    return check(false, what, "timed out");
  }
}

async function run(browser, base, server, name, size, touch) {
  console.log(`${name} ${size.width}x${size.height}`);
  const page = await browser.newPage({ viewport: size, deviceScaleFactor: 1, hasTouch: touch, isMobile: touch });
  const errors = [];
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", e => errors.push(String(e && e.message || e)));
  await page.goto(`${base}/`);

  // The welcome reached the view and the dashboard.
  await waitFor(page, () => window.Dash && Dash.inspect() && Dash.inspect().role === "god" && Dash.inspect().host.kind === "server"
    && /^Day /.test(document.getElementById("clock").textContent), null, 15000, "the welcome");
  check(await page.evaluate(() => !!(window.CityView && typeof CityView.create === "function")), "the view's scripts loaded");
  const order = await page.evaluate(() => [...document.scripts].map(s => s.getAttribute("src")));
  check(JSON.stringify(order) === JSON.stringify(["view/proj.js", "view/art.js", "view/buildings.js", "view/actors.js",
    "view/scene.js", "view/movers.js", "view/camera.js", "view/minimap.js", "view/view.js", "dashboard.js", "game.js"]),
  "the PLAN 3.12 script order", order);
  check(await page.evaluate(() => !document.getElementById("toast")), "the old #toast is gone");
  await page.waitForTimeout(800);

  // The map is drawn: the canvas fills #world and is not one flat colour.
  const drawn = await page.evaluate(() => {
    const c = document.getElementById("map"), w = document.getElementById("world").getBoundingClientRect();
    const r = c.getBoundingClientRect();
    if (!c.width || !c.height) return { ok: false, why: "no backing store" };
    const g = c.getContext("2d"), seen = new Set();
    for (let i = 1; i < 10; i++) {
      for (let j = 1; j < 10; j++) {
        const d = g.getImageData(Math.floor(c.width * i / 10), Math.floor(c.height * j / 10), 1, 1).data;
        seen.add(`${d[0]},${d[1]},${d[2]}`);
      }
    }
    return { ok: seen.size > 3 && Math.abs(r.width - w.width) < 2 && Math.abs(r.height - w.height) < 2 && r.height > 100,
      colours: seen.size, canvas: [r.width, r.height], world: [w.width, w.height] };
  });
  check(drawn.ok, "the map is drawn and fills #world", drawn);

  // Nothing scrolls sideways.
  const wide = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, body: document.body.scrollWidth,
    view: window.innerWidth }));
  check(wide.doc <= wide.view && wide.body <= wide.view, "no horizontal scroll", wide);

  // Nobody plays this city: the AI chip says so as shown (innerText skips what the phone layout hides).
  const ai = await page.evaluate(() => { const b = document.querySelector('#hud [data-k="ai"]'); return b && b.innerText.trim(); });
  check(/^AI: nobody\b/.test(ai || "") && (touch || /nobody playing/.test(ai)), "the AI chip says nobody is playing", ai);

  // Select a person from the People ranking: the detail opens, with the Owns block and a character page link.
  await page.evaluate(() => Dash.openTab("people"));
  await waitFor(page, () => document.querySelector(".dash-rank > li"), null, 5000, "the ranking rows");
  const first = await page.evaluate(() => document.querySelector(".dash-rank > li").dataset.key);
  await page.click(".dash-rank > li");
  await waitFor(page, () => document.querySelector('.dash-rank [data-act="open"]'), null, 3000, "the expanded row");
  await page.click('.dash-rank [data-act="open"]');
  await waitFor(page, id => Dash.selected() === id, first, 3000, "selecting a person");
  await waitFor(page, () => /Owns/.test(document.getElementById("panel").textContent), null, 5000, "the person's Owns block");
  const href = await page.evaluate(id => [Dash.characterHref(id), !!document.querySelector(`#panel a[href*="character.html"]`)], first);
  check(href[0] === `character.html?id=${encodeURIComponent(first)}` && href[1], "a character page link", href);

  // Esc on the map clears the selection (the view's onSelect(null), like Back).
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press("Escape");
  await waitFor(page, () => Dash.selected() === null, null, 3000, "Esc clears the selection");

  // The speed buttons reach the server, and the header follows.
  await page.click('#speed button[data-speed="8"]');
  await waitFor(page, () => document.querySelector('#speed button[data-speed="8"]').classList.contains("on"), null, 3000, "speed 8x");
  await page.click('#speed button[data-speed="4"]');
  await waitFor(page, () => document.querySelector('#speed button[data-speed="4"]').classList.contains("on"), null, 3000, "speed 4x");

  // A major event makes a News toast in #toasts, inside the window. Toasts already up are dismissed first (the
  // phone has one slot), and the event is asked for again if another major event took the slot meanwhile.
  const raffleToast = () => [...document.querySelectorAll("#toasts .dash-toast.major")].some(t => /raffle/.test(t.textContent));
  let toasted = false;
  for (let attempt = 0; attempt < 3 && !toasted; attempt++) {
    await page.evaluate(() => { for (const x of document.querySelectorAll("#toasts .dash-tx")) x.click(); });
    await waitFor(page, () => !document.querySelector("#toasts .dash-toast"), null, 3000, "the toasts are dismissed");
    server.proc.stdin.write("major\n");
    try { await page.waitForFunction(raffleToast, null, { timeout: 8000 }); toasted = true; } catch (e) { /* again */ }
  }
  check(toasted, "a News toast");
  const toast = await page.evaluate(() => {
    const t = [...document.querySelectorAll("#toasts .dash-toast.major")].find(x => /raffle/.test(x.textContent));
    if (!t) return null;
    const r = t.getBoundingClientRect();
    return { text: t.textContent.trim().slice(0, 80), inside: r.left >= 0 && r.right <= window.innerWidth + 1 && r.top >= 0 && r.bottom <= window.innerHeight + 1 };
  });
  check(toast && /raffle/.test(toast.text) && toast.inside, "the toast shows the headline in the window", toast);

  const wide2 = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, view: window.innerWidth }));
  check(wide2.doc <= wide2.view, "still no horizontal scroll", wide2);
  if (SHOTS) {
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, `god-${name}.png`) });
  }
  check(!errors.length, "no console errors", errors);
  await page.close();
}

// The browser port's welcome (dashboard.md 9.6) over the real server's socket.
async function runBrowserHost(browser, base) {
  console.log("browser host 1440x900");
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", e => errors.push(String(e && e.message || e)));
  if (typeof page.routeWebSocket !== "function") { console.log("  (skipped: this Playwright cannot route WebSockets)"); await page.close(); return; }
  await page.routeWebSocket(/\/ws$/, socket => {
    const server = socket.connectToServer();
    server.onMessage(text => {
      const msg = JSON.parse(text);
      if (msg.type === "welcome") Object.assign(msg, { host: { kind: "browser", controllers: false }, llm_log: [] });
      socket.send(JSON.stringify(msg));
    });
  });
  await page.goto(`${base}/`);
  await waitFor(page, () => window.Dash && Dash.inspect() && Dash.inspect().host.kind === "browser", null, 15000, "the browser welcome");
  await page.evaluate(() => Dash.openTab("llm"));
  await waitFor(page, () => /This browser version/.test(document.getElementById("panel").textContent), null, 3000,
    "the LLM log's browser empty state");
  await page.evaluate(() => Dash.openTab("people"));
  await waitFor(page, () => document.querySelector(".dash-rank > li"), null, 5000, "the ranking rows");
  const first = await page.evaluate(() => document.querySelector(".dash-rank > li").dataset.key);
  await page.evaluate(id => Dash.selectAgent(id), first);
  await waitFor(page, () => /Owns/.test(document.getElementById("panel").textContent), null, 5000, "the person's Owns block");
  const links = await page.evaluate(id => [Dash.characterHref(id), document.querySelectorAll('a[href*="character.html"]').length], first);
  check(links[0] === null && links[1] === 0, "no character page links for the browser host", links);
  check(!errors.length, "no console errors", errors);
  await page.close();
}

// The city played by smoke-bot (everyone, model "smoke-model") and idle-bot (nobody). The page's stats pushes are
// kept in window.__stats as they arrive, so a check can compare what is shown with what the server sent.
async function runPlayed(browser, base, name, size, touch) {
  console.log(`played ${name} ${size.width}x${size.height}`);
  const page = await browser.newPage({ viewport: size, deviceScaleFactor: 1, hasTouch: touch, isMobile: touch });
  const errors = [];
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", e => errors.push(String(e && e.message || e)));
  await page.addInitScript(() => {
    const Base = window.WebSocket;
    window.WebSocket = class extends Base {
      constructor(...args) {
        super(...args);
        this.addEventListener("message", e => {
          try {
            const m = JSON.parse(e.data);
            if (m.type === "stats") window.__stats = m;
            else if (m.type === "welcome" && m.stats) window.__stats = m.stats;
          } catch (x) { /* not ours */ }
        });
      }
    };
  });
  await page.goto(`${base}/`);
  await waitFor(page, () => window.Dash && Dash.inspect() && Dash.inspect().role === "god" && window.__stats
    && window.__stats.llm.controllers.length === 2, null, 15000, "the welcome with both controllers");
  const chipText = () => { const b = document.querySelector('#hud [data-k="ai"]'); return b ? b.innerText.trim() : ""; };
  await waitFor(page, touch => (touch ? /^AI \d+/ : /^AI: \d+ playing/).test(
    (document.querySelector('#hud [data-k="ai"]') || {}).innerText || ""), touch, 10000, "the AI chip counts the players");

  // Sample the chip and the controllers' lines for a few seconds while forks open and close.
  await page.evaluate(() => Dash.openTab("city"));
  const samples = [];
  for (let i = 0; i < 24; i++) {
    samples.push(await page.evaluate(get => {
      const chip = (document.querySelector('#hud [data-k="ai"]') || {}).innerText || "";
      const lines = {};
      for (const d of document.querySelectorAll(".dash-ctl")) lines[d.dataset.controller] = d.textContent.trim();
      const playing = window.__stats.llm.controllers.reduce((n, c) => n + c.characters, 0);
      return { chip: chip.trim(), lines, playing };
    }, null));
    await page.waitForTimeout(250);
  }
  const want = touch ? /^AI (\d+)(?: (\d+))?$/ : /^AI: (\d+) playing(?:, (\d+) thinking)?$/;
  const bad = samples.filter(s => {
    const m = want.exec(s.chip);
    return !m || Number(m[1]) !== s.playing || m[2] === "0";
  });
  check(!bad.length, `the ${touch ? "phone" : "desktop"} AI chip reads ${touch ? "AI 60" : "AI: 60 playing"} and never 0 thinking`,
    bad.slice(0, 3));
  check(samples.some(s => s.playing >= 50), "smoke-bot plays the city", samples[0] && samples[0].playing);
  check(samples.some(s => want.exec(s.chip) && want.exec(s.chip)[2]), "the chip shows a thinking count while forks are open",
    samples.map(s => s.chip).slice(0, 6));
  const own = samples.filter(s => {
    const m = want.exec(s.chip), n = m && m[2] ? Number(m[2]) : 0;
    const smoke = s.lines["smoke-bot"] || "", idle = s.lines["idle-bot"];
    const t = /· (\d+) thinking now$/.exec(smoke);
    return idle === undefined || /thinking/.test(idle) || (t ? Number(t[1]) : 0) !== n;
  });
  check(!own.length, "each controller line counts its own thinking (idle-bot never)", own.slice(0, 3));

  // "LLM decisions (n)" on the ranking row of the person with the most decisions is the server's llm.
  await page.waitForTimeout(touch ? 500 : 2500);
  await page.evaluate(() => Dash.openTab("people"));
  await waitFor(page, () => document.querySelector(".dash-rank > li"), null, 5000, "the ranking rows");
  const who = await page.evaluate(() => {
    const top = window.__stats.people.slice().sort((a, b) => b.llm - a.llm)[0];
    return top && { id: top.id, llm: top.llm };
  });
  if (check(who && who.llm > 0, "the server counts LLM decisions", who)) {
    await page.evaluate(id => {
      const li = document.querySelector(`#dash-people .dash-rank > li[data-key="${id}"]`);
      if (li) li.scrollIntoView({ block: "center" });
    }, who.id);
    await page.click(`#dash-people .dash-rank > li[data-key="${who.id}"] .dash-nm`);
    const ok = await page.waitForFunction(id => {
      const b = document.querySelector(`#dash-people .dash-rank > li[data-key="${id}"] [data-act="llm"]`);
      const row = window.__stats.people.find(p => p.id === id);
      const m = b && /\((\d+)\)/.exec(b.textContent);
      return m && row && Number(m[1]) === row.llm ? [Number(m[1]), row.llm] : false;
    }, who.id, { timeout: 5000 }).then(h => h.jsonValue()).catch(() => null);
    const seen = await page.evaluate(id => {
      const b = document.querySelector(`#dash-people .dash-rank > li[data-key="${id}"] [data-act="llm"]`);
      return [b && b.textContent, (window.__stats.people.find(p => p.id === id) || {}).llm];
    }, who.id);
    check(!!ok, "the ranking row's LLM decisions (n) is the server's count", ok || seen);
  }
  const wide = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, view: window.innerWidth }));
  check(wide.doc <= wide.view, "no horizontal scroll", wide);
  if (SHOTS) {
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, `god-played-${name}.png`) });
  }
  check(!errors.length, "no console errors", errors);
  await page.close();
}

(async () => {
  const pw = findPlaywright();
  if (!pw || !pw.chromium) { console.log("SKIP: Playwright is not installed"); process.exit(0); }
  let browser;
  try { browser = await pw.chromium.launch(); } catch (e) {
    console.log(`SKIP: Chromium did not launch (${String(e && e.message || e).split("\n")[0]})`);
    process.exit(0);
  }
  let server;
  try {
    server = await startServer();
    const base = `http://127.0.0.1:${server.port}`;
    for (const [name, size, touch] of SIZES) await run(browser, base, server, name, size, touch);
    await runBrowserHost(browser, base);
    server.proc.stdin.write("play\n");
    for (const [name, size, touch] of SIZES) await runPlayed(browser, base, name, size, touch);
  } catch (e) {
    check(false, "the run", String(e && e.stack || e));
  } finally {
    await browser.close();
    if (server) server.proc.kill();
  }
  console.log(`${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();

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
// a major event makes a News toast. The server is told to make a major event every 2 s while a God view is
// connected, so the toast does not wait on luck.
// A last run rewrites the welcome to the browser port's (host.kind "browser", no LLM log) on its way to the page:
// the LLM log shows its empty state and no character page link is rendered.
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

// The server, with a major event every 2 s while a God view is connected. Prints its port.
const SERVER = `
import asyncio, sys
sys.path.insert(0, sys.argv[1])
from gameofailife.server import GameServer
from gameofailife.sim import Simulation

async def main():
    sim = Simulation(seed=1)
    server = GameServer(sim, speed=4)
    print(await server.start("127.0.0.1", 0), flush=True)
    n = 0
    while True:
        await asyncio.sleep(2.0)
        if server.god:
            people = sim.living()
            a = people[n % len(people)]
            n += 1
            sim.event(f"{a.name} won the Millbrook raffle.", a, tag="big_money")

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
  const proc = spawn(process.env.PYTHON || "python3", ["-c", SERVER, REPO], { stdio: ["ignore", "pipe", "inherit"] });
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

async function run(browser, base, name, size, touch) {
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

  // A major event makes a News toast in #toasts, inside the window.
  await waitFor(page, () => Dash.inspect().toasts.includes("major") && document.querySelector("#toasts .dash-toast.major"),
    null, 8000, "a News toast");
  const toast = await page.evaluate(() => {
    const t = document.querySelector("#toasts .dash-toast.major");
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
    for (const [name, size, touch] of SIZES) await run(browser, base, name, size, touch);
    await runBrowserHost(browser, base);
  } catch (e) {
    check(false, "the run", String(e && e.stack || e));
  } finally {
    await browser.close();
    if (server) server.proc.kill();
  }
  console.log(`${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();

#!/usr/bin/env node
// Headless smoke test for the dashboard (client/dashboard.js) on its dev page (client/dev/dashboard.html),
// which runs the dashboard against a fake host and a stub map (client/dev/dashboard_fixture.js).
//
//   node tests/browser/dashboard_smoke.cjs
//
// It serves client/ on 127.0.0.1, opens the page in headless Chromium at a desktop and a phone size and checks:
// no console errors, no sideways scroll, the HUD, the tabs and their keys, picking and selecting a person,
// a major event making a toast and a map ping, the map colours, the home card for a house and for a block of
// flats, LLM decisions being asked for, the slow-AI chip, the browser build (no character pages, no LLM log)
// and the phone bottom sheet with the inset it gives the map.
//
// Playwright is looked for as a local module, then in the global node_modules. Without it, or without a
// browser it can launch, the test prints SKIP and exits 0. Set DASH_SHOTS=<folder> to also save screenshots.
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const CLIENT = path.resolve(__dirname, "..", "..", "client");
const SHOTS = process.env.DASH_SHOTS || "";

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

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml" };

function serve() {
  const server = http.createServer((req, res) => {
    let rel;
    try { rel = decodeURIComponent(new URL(req.url, "http://localhost").pathname); } catch (e) { rel = "/"; }
    const file = path.join(CLIENT, path.normalize(rel).replace(/^[/\\]+/, ""));
    if (!file.startsWith(CLIENT)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end("not found"); return; }
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
      res.end(data);
    });
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server)));
}

let failures = 0, passes = 0;
function check(ok, what, detail) {
  if (ok) { passes += 1; return true; }
  failures += 1;
  console.log(`  FAIL ${what}${detail !== undefined ? `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  return false;
}

async function openPage(browser, base, query, size) {
  const page = await browser.newPage({ viewport: size, deviceScaleFactor: 1 });
  const errors = [];
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", e => errors.push(String(e && e.message || e)));
  await page.goto(`${base}/dev/dashboard.html${query}`);
  await page.waitForFunction(() => window.Dash && Dash.inspect() && Dash.inspect().events > 0 && Dash.inspect().samples > 0,
    null, { timeout: 15000 });
  await page.waitForTimeout(300);
  return { page, errors };
}

async function noSidewaysScroll(page, what) {
  const w = await page.evaluate(() => [document.documentElement.scrollWidth, document.body.scrollWidth, window.innerWidth]);
  check(w[0] <= w[2] && w[1] <= w[2], `${what}: no sideways scroll`, w);
}

async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

const calls = (page, name) => page.evaluate(n => devView.calls.filter(c => c[0] === n).map(c => c[1]), name);
const inspect = page => page.evaluate(() => Dash.inspect());

async function desktop(browser, base) {
  console.log("desktop 1440x900");
  const { page, errors } = await openPage(browser, base, "?speed=2", { width: 1440, height: 900 });
  const info = await inspect(page);
  check(info.mode === "desktop" && info.tab === "city", "starts on the City tab in desktop mode", info);
  check(info.forks > 0, "the LLM backlog from welcome is stored", info.forks);
  check(await page.locator("#hud .dash-chip").count() >= 5, "the HUD has its chips");
  for (const t of ["city", "news", "llm", "people"]) check(await page.locator(`#dash-tab-${t}`).count() === 1, `tab #dash-tab-${t} exists`);
  check(await page.locator("#overlay-chips [data-overlay]").count() === 4, "the map colour switch has four choices");
  check(await page.locator("#ticker").innerText() !== "", "the ticker shows the latest notable event");
  await noSidewaysScroll(page, "desktop");
  await shot(page, "desktop-city");

  // Keys: 2 opens News, \ folds the panel to a rail and back, 4 opens People.
  await page.keyboard.press("2");
  check((await inspect(page)).tab === "news", "key 2 opens News");
  check(await page.locator("#dash-news .dash-stream li").count() > 5, "the news stream has rows");
  await page.keyboard.press("\\");
  check((await inspect(page)).collapsed === true, "key \\ folds the panel");
  await page.waitForTimeout(250);
  await page.keyboard.press("\\");
  check((await inspect(page)).collapsed === false, "key \\ unfolds the panel");
  await page.keyboard.press("4");
  check((await inspect(page)).tab === "people", "key 4 opens People");
  check(await page.locator("#dash-people .dash-rank > li").count() > 10, "the ranking lists the adults");

  // Picking a person on the map selects them, opens their detail and tells the view.
  const id = await page.evaluate(() => devHost.world.agents.find(a => a.alive && a.age >= 18).id);
  await page.evaluate(i => Dash.pick({ kind: "agent", id: i }, { cssX: 10, cssY: 10, touch: false }), id);
  await page.waitForFunction(() => { const h = document.querySelector("#dash-people .dash-detail:not([hidden]) h2"); return h && h.textContent.length > 2; },
    null, { timeout: 5000 }).catch(() => {});
  check((await inspect(page)).selected === id, "a picked person becomes the selection");
  const name = await page.evaluate(i => devHost.world.byId[i].name, id);
  const h2 = await page.locator("#dash-people .dash-detail h2").first().innerText().catch(() => "");
  check(h2.includes(name), "the person's detail opens", h2);
  check((await calls(page, "select")).some(a => a[0] === id), "view.select was called with the person");
  check((await page.evaluate(i => Dash.characterHref(i), id) || "").includes("character.html?id="), "characterHref gives a character page");
  check(await page.locator('#dash-people a[href*="character.html"]').count() >= 1, "the detail links the full character page");
  await shot(page, "desktop-person");

  // A major event: a toast in #toasts and a ping on the map.
  await page.waitForFunction(() => document.querySelector("#toasts .dash-toast.major"), null, { timeout: 15000 }).catch(() => {});
  check(await page.locator("#toasts .dash-toast.major").count() >= 1, "a major event shows a toast");
  check((await calls(page, "ping")).length >= 1, "a major event pings the map");
  check((await inspect(page)).inset.top > 40, "the map inset clears the HUD and toasts", (await inspect(page)).inset);

  // Map colours: the switch sends a colour per place to view.setOverlay.
  await page.click('#overlay-chips [data-overlay="wealth"]');
  const ov = (await calls(page, "setOverlay")).pop() || [];
  const colours = ov[1] || {};
  check(ov[0] === "wealth" && Object.keys(colours).length >= 5, "Wealth colours the map", [ov[0], Object.keys(colours).length]);
  check(Object.values(colours).every(c => /^(#[0-9a-f]{6}|rgb)/i.test(c)), "overlay colours are CSS colours");
  check(await page.locator("#overlay-chips .dash-legend, #overlay-chips .dash-ramp").count() >= 1, "the overlay shows its legend");
  await page.click('#overlay-chips [data-overlay="condition"]');
  const cond = (await calls(page, "setOverlay")).pop() || [];
  check(cond[0] === "condition" && Object.keys(cond[1] || {}).length >= 10, "Condition colours the lots", Object.keys(cond[1] || {}).length);
  await page.click('#overlay-chips [data-overlay=""]');
  const none = (await calls(page, "setOverlay")).pop() || [];
  check(none[0] === null, "None clears the overlay", none[0]);

  // The home card: a house picked twice, then a block of flats and one of its flats.
  await page.evaluate(() => { Dash.pick({ kind: "place", id: "park_66" }, {}); Dash.pick({ kind: "place", id: "park_66" }, {}); });
  await page.waitForFunction(() => { const c = document.querySelector("#dash-people .dash-card:not([hidden]) h2"); return c && /Park/.test(c.textContent); },
    null, { timeout: 5000 }).catch(() => {});
  check((await inspect(page)).card === "park_66", "a second tap on a house opens its home card", (await inspect(page)).card);
  check(await page.evaluate(() => devHost.sent.includes("home")), "the home card asked get_home");
  await page.evaluate(() => Dash.openHome("birch_court"));
  await page.waitForTimeout(200);
  check(await page.locator("#dash-people .dash-card .dash-unit").count() === 6, "the block card lists six flats");
  await shot(page, "desktop-block");
  await page.locator("#dash-people .dash-card .dash-unit").first().click();
  await page.waitForFunction(() => { const c = Dash.inspect().card; return c && c !== "birch_court"; }, null, { timeout: 5000 }).catch(() => {});
  const flat = (await inspect(page)).card;
  check(flat && flat !== "birch_court", "a flat opens its own card", flat);
  check(await page.locator("#dash-people .dash-card .dash-back").count() === 1, "the flat's card has a way back");

  // LLM log: choosing a character asks for their decisions.
  await page.keyboard.press("3");
  check((await inspect(page)).tab === "llm", "key 3 opens the LLM log");
  check(await page.locator("#dash-llm .dash-llmlist li").count() >= 5, "the LLM log lists decisions");
  await page.selectOption("#dash-llm .dash-llm-agent", id);
  await page.waitForFunction(() => devHost.sent.includes("decisions"), null, { timeout: 5000 }).catch(() => {});
  check(await page.evaluate(() => devHost.sent.includes("decisions")), "choosing a character asks get_decisions");

  // A refused request becomes a card in #toasts.
  await page.click("details.dev summary");
  await page.click("#dev-error");
  await page.waitForFunction(() => document.querySelector("#toasts .dash-toast.error"), null, { timeout: 5000 }).catch(() => {});
  check(await page.locator("#toasts .dash-toast.error").count() === 1, "an error reply shows an error card");
  await page.click("details.dev summary");

  await noSidewaysScroll(page, "desktop after use");
  check(errors.length === 0, "desktop: no console errors", errors);
  await page.close();
}

async function slowAi(browser, base) {
  console.log("desktop ?slow");
  const { page, errors } = await openPage(browser, base, "?slow", { width: 1280, height: 800 });
  check(await page.locator('#hud .dash-chip[data-k="ai"].amber').count() === 1, "slow AI turns the AI chip amber");
  check(/slow/i.test(await page.locator('#hud .dash-chip[data-k="ai"]').innerText()), "the AI chip says slow");
  await shot(page, "slow");
  check(errors.length === 0, "?slow: no console errors", errors);
  await page.close();
}

async function browserBuild(browser, base) {
  console.log("desktop ?browser");
  const { page, errors } = await openPage(browser, base, "?browser", { width: 1280, height: 800 });
  const info = await inspect(page);
  check(info.host.kind === "browser", "the host is the browser build", info.host);
  check(/AI off/.test(await page.locator('#hud .dash-chip[data-k="ai"]').innerText()), "the AI chip says AI off");
  const id = await page.evaluate(() => devHost.world.agents.find(a => a.alive && a.age >= 18).id);
  await page.evaluate(i => Dash.selectAgent(i, { focus: true }), id);
  await page.waitForTimeout(400);
  check(await page.evaluate(i => Dash.characterHref(i), id) === null, "characterHref is null in the browser build");
  check(await page.locator('a[href*="character.html"]').count() === 0, "no links to character pages");
  await page.keyboard.press("3");
  await page.waitForTimeout(200);
  check(await page.locator("#dash-llm .dash-llm-empty:not([hidden])").count() === 1, "the LLM log shows its empty state");
  check(/no AI players/.test(await page.locator("#dash-llm .dash-llm-empty").innerText()), "the empty state explains why");
  await shot(page, "browser");
  check(errors.length === 0, "?browser: no console errors", errors);
  await page.close();
}

async function phone(browser, base) {
  console.log("phone 390x844");
  const { page, errors } = await openPage(browser, base, "?speed=2", { width: 390, height: 844 });
  let info = await inspect(page);
  check(info.mode === "sheet" && info.phone === true && info.sheet === "peek", "a phone starts with the sheet at peek", info);
  await noSidewaysScroll(page, "phone peek");
  await shot(page, "phone-peek");

  await page.click("#dash-tab-people");
  await page.waitForTimeout(450);
  info = await inspect(page);
  check(info.tab === "people" && info.sheet === "half", "a tab tap raises the sheet to half", [info.tab, info.sheet]);
  const insets = await calls(page, "setInset");
  const last = insets.length ? insets[insets.length - 1][0] : {};
  check(last && last.bottom > 200, "the map inset clears the half sheet", last);
  check(await page.locator("#dash-people .dash-rank > li").count() > 10, "the ranking shows in the sheet");
  await noSidewaysScroll(page, "phone half");
  await shot(page, "phone-half");

  await page.focus("#panel .dash-grip");
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(450);
  check((await inspect(page)).sheet === "full", "the grip raises the sheet to full");
  await page.evaluate(() => Dash.openHome("birch_court"));
  await page.waitForTimeout(250);
  check(await page.locator("#dash-people .dash-card .dash-unit").count() === 6, "the block card works on a phone");
  await noSidewaysScroll(page, "phone full");
  await shot(page, "phone-full");

  await page.focus("#panel .dash-grip");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(450);
  check((await inspect(page)).sheet === "peek", "the grip lowers the sheet to peek");
  check(await page.locator("#hud .dash-chip:visible").count() === 4, "the phone HUD shows four chips");
  check(errors.length === 0, "phone: no console errors", errors);
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
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await desktop(browser, base);
    await slowAi(browser, base);
    await browserBuild(browser, base);
    await phone(browser, base);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL the run stopped: ${e && e.stack || e}`);
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();

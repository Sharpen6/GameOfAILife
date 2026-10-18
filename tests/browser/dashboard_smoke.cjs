#!/usr/bin/env node
// Headless smoke test for the dashboard (client/dashboard.js) on its dev page (client/dev/dashboard.html),
// which runs the dashboard against a fake host and a stub map (client/dev/dashboard_fixture.js).
//
//   node tests/browser/dashboard_smoke.cjs
//
// It serves client/ on 127.0.0.1, opens the page in headless Chromium at a desktop and a phone size and checks:
// no console errors, no sideways scroll, the HUD, the tabs and their keys, picking and selecting a person,
// a major event making a toast and a map ping, the map colours, the home card for a house and for a block of
// flats (and, in a re-sent welcome, region blocks of 10 and 24 flats: every flat listed, top floor first), LLM
// decisions being asked for, the slow-AI chip, the browser build (no character pages, no LLM log) and the phone
// bottom sheet with the inset it gives the map. The "rules" run and the end of the phone run
// check that arrows used by the tab bar or the sheet grip never pan the map, the debt stub on a positive net
// worth, that a burst of majors is always shown or counted (and error cards push none out), the phone mood
// arrow, the long-press tooltip on touch, and the fixture's agents[0] == agent. Both the rules run and the phone
// run check the People ranking in its Adults, Everyone and Households segments: richest to poorest, ranks 1..n,
// a net worth below zero written with a minus and ranked last, each row's 24 h change, one row per household.
// The last runs check the main-screen review's fixes: the LLM log's "Load older" (also with hundreds of forks
// arriving after the welcome, past what the server's ring keeps behind it), day separators, kept fetched forks and
// the server's LLM decisions count, the Full page hand-off, the per-controller thinking counts, the 100% clamp,
// one 24 h mood change, folded first meetings, the phone AI chip, and "Show on map" from a full phone sheet (the
// view gets the half sheet's inset before the focus; with the real map, ?view=real, the place lands where it does
// from a half sheet).
//
// Playwright is looked for as a local module, then in the global node_modules. Without it, or without a
// browser it can launch, the test prints SKIP and exits 0. Set DASH_SHOTS=<folder> to also save screenshots,
// and DASH_VERBOSE=1 to print the toasts each burst leaves.
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

async function openPage(browser, base, query, size, touch) {
  const page = await browser.newPage({ viewport: size, deviceScaleFactor: 1, hasTouch: !!touch });
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

// Stops the fake host's clock (no frames, no stats pushes, no random majors) and clears the toasts.
async function pause(page) {
  await page.evaluate(() => devHost.send({ type: "set_speed", speed: 0 }));
  await page.waitForTimeout(150);
  await page.evaluate(() => { for (const b of document.querySelectorAll("#toasts .dash-tx")) b.click(); });
}

// Five major events in one frame, after the toasts were cleared: every one is either on its own card or
// counted by the "N more major events" card, within the slot limit (3 on desktop, 1 on a phone).
async function majorBurst(page, what, slots) {
  const res = await page.evaluate(() => {
    const st = devHost.world && Dash.inspect() ? window.__lastState : null;
    const events = [1, 2, 3, 4, 5].map(i => ({ seq: 900000 + i, tick: st.tick, time: st.time, kind: "home", tag: "home_bought",
      importance: 2, major: true, text: `Major number ${i}`, agent: null, agents: [], place: null, at: null }));
    Dash.frame({ type: "state", speed: 0, state: st, events, forks: [] });
    const cards = Array.from(document.querySelectorAll("#toasts .dash-toast"));
    const more = cards.find(c => c.classList.contains("more"));
    return { kinds: cards.map(c => c.className.replace("dash-toast ", "")), texts: cards.map(c => c.innerText.split("\n")[0]),
      majors: cards.filter(c => c.classList.contains("major") && /Major number/.test(c.innerText)).length,
      more: more ? Number((/(\d+) more major/.exec(more.innerText) || [])[1]) : 0 };
  });
  if (process.env.DASH_VERBOSE) console.log(`  ${what} burst: ${JSON.stringify(res.texts)}`);
  check(res.majors + res.more === 5, `${what}: five majors in a burst are shown or counted`, res);
  check(res.kinds.length <= slots, `${what}: at most ${slots} toast${slots === 1 ? "" : "s"} for majors`, res.kinds);
  check(res.more > 0, `${what}: the burst coalesces into one "N more" card`, res.texts);
  await shot(page, `${what}-burst`);
  await page.evaluate(() => Dash.notice("Not done: a test notice"));
  const after = await page.evaluate(() => Array.from(document.querySelectorAll("#toasts .dash-toast")).map(c => c.className.replace("dash-toast ", "")));
  check(after.includes("more") && after.includes("error"), `${what}: an error card does not push out the "more" card`, after);
  check(after.filter(k => k === "more" || k === "major").length === res.kinds.length, `${what}: an error card pushes out no major`, [res.kinds, after]);
}

// The People tab ranks richest to poorest (dashboard.md 6, P3 acceptance). Needs the host paused, nothing
// selected and window.__lastState / __lastStats captured. It pushes a copy of the last stats with one adult
// deep in debt (a net worth written with U+2212) and one big 24 h gain, then for Adults, Everyone and
// Households reads every row: net worths never increase and match the stats, ranks run 1..n, every row shows
// its 24 h change (worth - worth_24h, summed for a household), and Households has one row per household.
const MONEY = /^([−-]?)\$([\d,]+)$/;
const CHANGE = /^(?:([▲▼]) \$([\d,]+)|±\$0)$/;
const parseMoney = s => { const m = MONEY.exec((s || "").trim()); return m ? (m[1] ? -1 : 1) * Number(m[2].replace(/,/g, "")) : NaN; };
const parseChange = s => { const m = CHANGE.exec((s || "").trim()); return !m ? NaN : m[1] ? (m[1] === "▼" ? -1 : 1) * Number(m[2].replace(/,/g, "")) : 0; };

async function rankingSegments(page, what) {
  const ref = await page.evaluate(() => {
    const st = JSON.parse(JSON.stringify(window.__lastStats));
    const age = {};
    for (const a of window.__lastState.agents) age[a.id] = a.age;
    const adults = st.people.filter(p => age[p.id] >= 18);
    const poor = adults[Math.floor(adults.length / 2)], gainer = adults[1];
    poor.cash = -4200; poor.savings = 0; poor.home_equity = 0; poor.worth = -4200; poor.worth_24h = -3900;
    gainer.worth_24h = gainer.worth - 1500;
    Dash.stats(st);
    return { people: st.people.map(p => ({ id: p.id, household: p.household, worth: p.worth, worth_24h: p.worth_24h, age: age[p.id] })),
      households: st.households.map(h => h.id), poor: poor.id };
  });
  await page.waitForTimeout(250);
  check(await page.locator('#dash-people .dash-rankhead [data-sorthead="worth"].on').count() === 1, `${what}: the ranking sorts by net worth`);
  const expect = {
    adults: ref.people.filter(p => p.age == null || p.age >= 18).map(p => ({ key: p.id, worth: p.worth, chg: p.worth - p.worth_24h })),
    everyone: ref.people.map(p => ({ key: p.id, worth: p.worth, chg: p.worth - p.worth_24h })),
    households: ref.households.map(id => {
      const ms = ref.people.filter(p => p.household === id);
      return { key: `hh:${id}`, worth: ms.reduce((s, p) => s + p.worth, 0), chg: ms.reduce((s, p) => s + p.worth - p.worth_24h, 0) };
    }),
  };
  for (const seg of ["adults", "everyone", "households"]) {
    await page.click(`#dash-people [data-seg="${seg}"]`);
    await page.waitForTimeout(120);
    const got = await page.evaluate(() => ({
      on: Array.from(document.querySelectorAll('#dash-people [data-seg][aria-checked="true"]')).map(b => b.dataset.seg),
      rows: Array.from(document.querySelectorAll("#dash-people .dash-rank > li")).map(li => {
        const t = sel => { const e = li.querySelector(`.dash-rrow > ${sel}`); return e ? e.textContent : null; };
        return { key: li.dataset.key, rk: t(".dash-rk"), worth: t(".dash-worth"), chg: t(".dash-chg") };
      }),
    }));
    const rows = got.rows, want = expect[seg].slice().sort((x, y) => y.worth - x.worth);
    const worths = rows.map(r => parseMoney(r.worth)), chgs = rows.map(r => parseChange(r.chg));
    check(got.on.length === 1 && got.on[0] === seg, `${what} ${seg}: the segment is checked`, got.on);
    check(rows.length === want.length && rows.length > 0, `${what} ${seg}: one row each`, [rows.length, want.length]);
    check(worths.every(Number.isFinite), `${what} ${seg}: every row shows a net worth`, rows.filter((r, i) => !Number.isFinite(worths[i])));
    const up = worths.findIndex((w, i) => i > 0 && w > worths[i - 1]);
    check(up < 0, `${what} ${seg}: net worth never increases down the list`, up < 0 ? "" : rows.slice(up - 1, up + 1));
    check(JSON.stringify(worths) === JSON.stringify(want.map(w => Math.round(w.worth))), `${what} ${seg}: the worths are the stats' worths, richest first`,
      [worths.slice(0, 5), want.slice(0, 5).map(w => w.worth)]);
    check(rows.every((r, i) => r.rk !== null && r.rk.trim() === String(i + 1)), `${what} ${seg}: ranks run 1..n`, rows.map(r => r.rk).join(","));
    check(chgs.every(Number.isFinite), `${what} ${seg}: every row shows its 24 h change`, rows.filter((r, i) => !Number.isFinite(chgs[i])));
    const byKey = new Map(expect[seg].map(w => [w.key, w]));
    const wrong = rows.filter((r, i) => !byKey.has(r.key) || chgs[i] !== Math.round(byKey.get(r.key).chg));
    check(wrong.length === 0, `${what} ${seg}: each 24 h change is worth - worth_24h`, wrong.slice(0, 3));
    if (seg !== "households") {
      const last = rows.findIndex(r => r.key === ref.poor);
      check(last >= 0 && /^−\$4,200$/.test(rows[last].worth.trim()) && rows.slice(last + 1).every(r => parseMoney(r.worth) <= -4200),
        `${what} ${seg}: a negative net worth shows a minus and ranks below every positive one`, last >= 0 ? rows[last] : ref.poor);
    }
    if (seg === "households") check(rows.length === ref.households.length, `${what}: Households has one row per household in stats`, [rows.length, ref.households.length]);
  }
  await page.click('#dash-people [data-seg="adults"]');
}

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

// The fixes after the first review: arrow keys stay with the tab bar, debt shows on a positive net worth,
// toast bursts are counted, and the fixture's events keep agents[0] == agent.
async function rules(browser, base) {
  console.log("desktop rules 1440x900");
  const { page, errors } = await openPage(browser, base, "?speed=4", { width: 1440, height: 900 });
  await page.evaluate(() => {
    const on = devHost.onmessage;
    devHost.onmessage = m => { if (m.type === "state") window.__lastState = m.state; if (m.type === "stats") window.__lastStats = m; on(m); };
  });
  await page.waitForFunction(() => window.__lastState && window.__lastStats, null, { timeout: 10000 });
  await pause(page);

  // PLAN 3.12: the view owns the arrows; an arrow used by the tab bar must not also reach it.
  const pans = async () => (await calls(page, "pan")).length;
  await page.click("#dash-tab-city");
  await page.focus("#dash-tab-city");
  let before = await pans();
  await page.keyboard.press("ArrowRight");
  check((await inspect(page)).tab === "news", "ArrowRight on a focused tab moves to the next tab");
  await page.keyboard.press("ArrowLeft");
  check((await inspect(page)).tab === "city", "ArrowLeft moves back");
  check(await pans() === before, "arrows used by the tab bar do not pan the map", [before, await pans()]);
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  before = await pans();
  await page.keyboard.press("ArrowRight");
  check(await pans() === before + 1 && (await inspect(page)).tab === "city", "an arrow outside the panel still pans the map");

  // Debt: a house-rich, cash-poor person (cash + savings < 0, net worth > 0) gets the red stub and "debt".
  const who = await page.evaluate(() => {
    const st = JSON.parse(JSON.stringify(window.__lastStats));
    const p = st.people.find(x => x.home_equity > 2000 && devHost.world.byId[x.id].age >= 18);
    p.cash = -900; p.savings = 0; p.worth = p.cash + p.savings + p.home_equity;
    Dash.stats(st);
    return p.id;
  });
  await page.keyboard.press("4");
  await page.waitForTimeout(300);
  const row = await page.evaluate(id => {
    const li = document.querySelector(`#dash-people .dash-rank > li[data-key="${id}"]`);
    return li ? { indebt: !!li.querySelector(".dash-bar.indebt .dash-debtstub"), text: li.innerText,
      fill: !!li.querySelector(".dash-bar.indebt .dash-barfill i.h") } : null;
  }, who);
  check(row && row.indebt && /debt/.test(row.text), "a positive net worth with negative cash shows the debt stub and word", row);
  check(row && row.fill, "the home part still shows next to the debt stub", row);
  await shot(page, "desktop-debt");
  await rankingSegments(page, "desktop");

  await majorBurst(page, "desktop", 3 + 2);

  // In the region world the HUD's market chip, the Homes KPI and the homes facts row count every home in the
  // region (stats.region.homes), as the stage bar and the market list do, not the cast's 37 (stats.city.homes).
  await page.keyboard.press("1");
  const homes = await page.evaluate(() => {
    const st = JSON.parse(JSON.stringify(window.__lastStats));
    st.region = Object.assign({}, st.region || {}, { homes: { total: 612, owned: 70, rented: 381, for_sale: 16, for_rent: 145,
      lots_by_stage: [68, 95, 35, 1, 0], neglected_lived_in: 1 } });
    Dash.stats(st);
    const out = { hud: document.querySelector('#hud [data-k="homes"]').innerText.replace(/\s+/g, " "),
      tile: [...document.querySelectorAll("#dash-city .dash-kpi")].map(k => k.innerText.replace(/\s+/g, " ")).find(t => /^homes /i.test(t)),
      facts: (document.querySelector("#dash-city .dash-facts") || {}).innerText };
    Dash.stats(Object.assign({}, window.__lastStats, { full: true }));
    out.after = document.querySelector('#hud [data-k="homes"]').innerText.replace(/\s+/g, " ");
    out.city = `${window.__lastStats.city.homes.for_sale} for sale · ${window.__lastStats.city.homes.for_rent} to let`;
    return out;
  });
  check(homes.hud === "16 for sale · 145 to let", "region: the HUD's market chip counts the region's homes", homes);
  check(/70 owned/.test(homes.tile || "") && /16 for sale · 145 to let · 1 neglected/.test(homes.tile || ""),
    "region: the Homes KPI counts the region's homes", homes);
  check(/70\s*owned/.test(homes.facts || "") && /381\s*rented/.test(homes.facts || "") && /145\s*to let/.test(homes.facts || ""),
    "region: the homes facts row counts the region's homes", homes);
  check(homes.after === homes.city, "Millbrook: the market chip counts city.homes", homes);

  // The fixture follows PLAN 3.7: agents[0] == agent whenever agent is set (welcome backlogs and frames).
  const bad = await page.evaluate(() => new Promise(resolve => {
    const h = DASH_FIXTURE.createHost({ seed: 11, speed: 16, frameMs: 20 }), seen = [];
    h.onmessage = m => {
      if (m.type === "welcome") { seen.push(...m.history, ...m.news, ...m.headlines); h.start(); }
      if (m.type === "state") seen.push(...(m.events || []));
    };
    h.send({ type: "hello", role: "god" });
    setTimeout(() => {
      h.stop();
      const wrong = seen.filter(e => e.agent && (!e.agents || e.agents[0] !== e.agent)).map(e => e.tag);
      resolve({ n: seen.length, wrong });
    }, 2500);
  }));
  check(bad.n > 200 && bad.wrong.length === 0, "fixture events keep agents[0] == agent", bad);

  check(errors.length === 0, "rules: no console errors", errors);
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

// Region blocks of flats have 8 to 24 flats on up to 12 floors: a re-sent welcome with a 10-flat and a 24-flat
// block in the town (units 1A..5B and 1A..12B), whose cards must list every flat, top floor first, say how many
// flats share the condition, and scroll the tall one. A flat in a Millbrook block counts its block's 6 flats.
async function tallBlocks(browser, base) {
  console.log("desktop tall blocks");
  const { page, errors } = await openPage(browser, base, "", { width: 1280, height: 800 });
  await pause(page);
  const ok = await page.evaluate(() => new Promise(resolve => {
    const orig = devHost.onmessage;
    devHost.onmessage = m => {
      if (m.type !== "welcome") { orig(m); return; }
      devHost.onmessage = orig;
      const blocks = [["linden_tower", "Linden Tower", 5], ["oak_heights", "Oak Heights", 12]];
      for (const [id, name, floors] of blocks) {
        m.town.places.push({ id, name, kind: "home", x: 60 + floors, y: 30, w: 4, h: 3, entry: [61 + floors, 33], face: "s",
          hours: null, district: "eastgate", style: "apartments", floors, tier: "flat", units: floors * 2 });
        for (let f = 1; f <= floors; f++) {
          for (const side of ["A", "B"]) {
            m.town.homes.push({ id: `${id}_${f}${side.toLowerCase()}`, place: id, unit: `${f}${side}`, name: `${name}, flat ${f}${side}`,
              tier: "flat", bedrooms: side === "A" ? 1 : 2, base_value: 7200, rent: 180 });
          }
        }
      }
      Dash.welcome(m);
      resolve(true);
    };
    devHost.send({ type: "hello", role: "god" });
    setTimeout(() => resolve(false), 3000);
  }));
  check(ok, "the fake host re-sent the welcome");
  for (const [id, floors] of [["linden_tower", 5], ["oak_heights", 12]]) {
    await page.evaluate(i => Dash.openHome(i), id);
    await page.waitForTimeout(200);
    const got = await page.evaluate(() => {
      const card = document.querySelector("#dash-people .dash-card");
      const grid = card && card.querySelector(".dash-units");
      return { units: [...card.querySelectorAll(".dash-unit b")].map(b => b.textContent),
        note: (card.querySelector(".dash-legend-note") || {}).textContent || "",
        overflow: grid ? getComputedStyle(grid).overflowY : null, scrolls: grid ? grid.scrollHeight > grid.clientHeight + 1 : false };
    });
    const want = [];
    for (let f = floors; f >= 1; f--) want.push(`${f}A`, `${f}B`);
    check(JSON.stringify(got.units) === JSON.stringify(want), `the ${floors * 2}-flat block card lists every flat, top floor first`, got.units);
    check(got.note.includes(`all ${floors * 2} flats`), `the ${floors * 2}-flat block card counts its flats`, got.note);
    if (floors > 6) check(got.overflow === "auto" && got.scrolls, "the 24-flat block's grid scrolls", got);
  }
  await shot(page, "tall-block");
  await page.evaluate(() => Dash.openHome("birch_court_1a"));
  await page.waitForFunction(() => document.querySelector('#dash-people .dash-card [data-act="block"]'), null, { timeout: 5000 }).catch(() => {});
  const btn = await page.evaluate(() => { const b = document.querySelector('#dash-people .dash-card [data-act="block"]'); return b ? b.textContent : null; });
  check(btn === "All 6 flats", "a flat's card counts its block's flats", btn);
  check(errors.length === 0, "tall blocks: no console errors", errors);
  await page.close();
}

async function phone(browser, base) {
  console.log("phone 390x844");
  const { page, errors } = await openPage(browser, base, "?speed=2", { width: 390, height: 844 }, true);
  await page.evaluate(() => {
    const on = devHost.onmessage;
    devHost.onmessage = m => { if (m.type === "state") window.__lastState = m.state; if (m.type === "stats") window.__lastStats = m; on(m); };
  });
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
  await page.waitForFunction(() => window.__lastState && window.__lastStats, null, { timeout: 10000 });
  await pause(page);
  await rankingSegments(page, "phone");
  await page.evaluate(() => devHost.send({ type: "set_speed", speed: 2 }));
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

  // dashboard.md 8.2: the phone mood chip keeps its arrow (only the number is dropped).
  const mood = await page.evaluate(() => {
    const c = document.querySelector('#hud [data-k="mood"]'), m = c && c.querySelector(".dash-md");
    const d = /(up|down) (\d+)/.exec(c ? c.title : "");
    return { text: c ? c.innerText : "", arrow: m ? m.innerText.trim() : null, delta: d ? Number(d[2]) : null };
  });
  check(mood.delta === 0 || /^[▲▼]$/.test(mood.arrow || ""), "the phone mood chip shows its arrow", mood);
  check(!/\d\s*[▲▼]\d/.test(mood.text), "the phone mood chip drops the delta number", mood);

  // The sheet grip's arrows resize the sheet and do not pan the map.
  const pans = async () => (await calls(page, "pan")).length;
  let before = await pans();
  await page.focus("#panel .dash-grip");
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(300);
  check((await inspect(page)).sheet === "half" && await pans() === before, "the grip's ArrowUp does not pan the map",
    [(await inspect(page)).sheet, before, await pans()]);
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(300);
  await page.evaluate(() => document.activeElement && document.activeElement.blur());

  // A touch long-press shows the tooltip (renderer.md 10); the next tap hides it, and so does a timeout.
  await pause(page);
  const tip = () => page.evaluate(() => { const t = document.getElementById("tooltip"); return { shown: !t.hidden, text: t.textContent }; });
  await page.evaluate(() => Dash.hover({ kind: "place", id: "main_20" }, { cssX: 120, cssY: 300, touch: true }));
  let t = await tip();
  check(t.shown && /Main Street/.test(t.text), "a long-press hover shows the tooltip on a phone", t);
  await page.evaluate(() => Dash.pick(null, { cssX: 10, cssY: 10, touch: true }));
  check(!(await tip()).shown, "the next tap hides the long-press tooltip");
  // The stub map turns a real 600 ms touch hold into onHover(hit, {touch: true}), as P4's camera does.
  const spot = await page.evaluate(() => {
    const r = document.getElementById("map").getBoundingClientRect();
    for (let y = r.top + 120; y < r.bottom - 120; y += 6) for (let x = r.left + 8; x < r.right - 8; x += 6) {
      const e = document.elementFromPoint(x, y);
      if (e && e.id === "map" && Dash.tooltipText(devView.hitAt ? devView.hitAt(x - r.left, y - r.top) : null)) return [x, y];
    }
    return null;
  });
  if (spot) {
    const cdp = await page.context().newCDPSession(page);
    const point = [{ x: spot[0], y: spot[1], id: 1 }];
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point });
    await page.waitForTimeout(650);
    t = await tip();
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    check(t.shown && t.text.length > 3, "a real touch hold on the map shows the tooltip", t);
    await page.waitForTimeout(150);
    check((await tip()).shown, "lifting the finger after a hold keeps the tooltip");
    await page.waitForTimeout(4200);
    check(!(await tip()).shown, "the long-press tooltip hides itself after a few seconds");
  } else check(false, "found a spot on the stub map with a tooltip");

  await majorBurst(page, "phone", 1 + 1);
  check(errors.length === 0, "phone: no console errors", errors);
  await page.close();
}

// Captures every state frame and stats push in window.__lastState / __lastStats, waits for one of each, then
// stops the host's frame loop (a paused host still sends the decisions it was waiting on); requests are still
// answered.
async function capturePaused(page) {
  await page.evaluate(() => {
    const on = devHost.onmessage;
    devHost.onmessage = m => { if (m.type === "state") window.__lastState = m.state; if (m.type === "stats") window.__lastStats = m; on(m); };
  });
  await page.waitForFunction(() => window.__lastState && window.__lastStats, null, { timeout: 10000 });
  await pause(page);
  await page.evaluate(() => devHost.stop());
}

// A click that, when its target is missing, fails the check instead of stopping the run.
async function tryClick(page, sel, what) {
  try { await page.click(sel, { timeout: 4000 }); return true; } catch (e) { return check(false, `${what}: found ${sel}`); }
}

// A copy of the last state frame with n of the playing characters thinking (and nobody else), pushed to Dash,
// then the last stats again (which redraws the HUD at once). Returns how many characters are played.
const setThinking = (page, n, nobody) => page.evaluate(([n, nobody]) => {
  const st = JSON.parse(JSON.stringify(window.__lastState));
  let k = 0, playing = 0;
  for (const a of st.agents) {
    if (nobody) a.controller = null;
    if (a.state === "deciding") a.state = "busy";
    if (a.alive && a.controller) { playing += 1; if (k < n) { a.state = "deciding"; k += 1; } }
  }
  Dash.frame({ type: "state", speed: 0, state: st, events: [], forks: [] });
  Dash.stats(window.__lastStats);
  return playing;
}, [n, !!nobody]);

// The main-screen review's fixes (F1-F10, the phone AI chip) at a desktop size, on a city with 90 game hours of
// decisions behind it (?backlog=90): the city's ring of 500 and most characters' rings of 30 are full.
async function screenFixes(browser, base) {
  console.log("desktop main-screen fixes 1440x900 ?backlog=90");
  const { page, errors } = await openPage(browser, base, "?backlog=90&speed=4", { width: 1440, height: 900 });
  await capturePaused(page);

  // F1: "Load older" keeps showing older pages past the first 150 rows, down to the oldest in the server's ring.
  await page.keyboard.press("3");
  await page.waitForTimeout(350);
  const forkRows = () => page.locator("#dash-llm .dash-llmlist li.dash-fork").count();
  const counts = [await forkRows()];
  for (let i = 0; i < 30; i++) {
    if (!(await page.locator("#dash-llm .dash-older").isVisible())) break;
    await page.evaluate(() => { const b = document.getElementById("dash-llm"); b.scrollTop = b.scrollHeight; });
    await page.click("#dash-llm .dash-older");
    await page.waitForFunction(() => { const b = document.querySelector("#dash-llm .dash-older"); return b.hidden || !b.disabled; },
      null, { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(60);
    counts.push(await forkRows());
  }
  const ring = await page.evaluate(() => { const r = devHost.world.llmRing.filter(f => f.decided_by === "model"); return { n: r.length, oldest: r[0].id }; });
  const oldestShown = await page.evaluate(() => { const li = [...document.querySelectorAll("#dash-llm .dash-llmlist li.dash-fork")].pop(); return li && li.dataset.key; });
  check(counts[counts.length - 1] > 150 && counts[counts.length - 1] === ring.n, "F1: Load older pages past 150 rows to every decision in the server's ring",
    { counts, ring: ring.n });
  check(oldestShown === ring.oldest, "F1: the oldest row shown is the ring's oldest", [oldestShown, ring.oldest]);
  check(await page.locator("#dash-llm .dash-older").isHidden(), "F1: Load older goes once the server has no more");

  // F8: day separators, and a row's time names its day when it is not today.
  const days = await page.evaluate(() => {
    const W = devHost.world, today = Math.floor(W.tick / 1440), tick = {};
    for (const f of W.llmRing) tick[f.id] = f.tick;
    const seps = [...document.querySelectorAll("#dash-llm .dash-llmlist li.dash-llmday")].map(li => li.innerText.trim());
    const bad = [];
    let other = 0;
    for (const li of document.querySelectorAll("#dash-llm .dash-llmlist li.dash-fork")) {
      const t = li.querySelector(".dash-ftime").innerText.trim(), d = Math.floor(tick[li.dataset.key] / 1440);
      const ok = d === today ? /^\d\d:\d\d( ·|$)/.test(t) : /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d\d:\d\d( ·|$)/.test(t);
      if (d !== today) other += 1;
      if (!ok && bad.length < 3) bad.push([li.dataset.key, d, today, t]);
    }
    const order = [...document.querySelectorAll("#dash-llm .dash-llmlist > li")].map(li => li.classList.contains("dash-llmday") ? "sep" : "row");
    return { seps, bad, other, firstIsSep: order[0] === "sep" };
  });
  check(days.seps.length >= 2 && /^Today · Day \d+/.test(days.seps[0]) && /^Yesterday · Day \d+/.test(days.seps[1]) && days.firstIsSep,
    "F8: the LLM log has a separator for each day", days.seps);
  check(days.other > 0 && days.bad.length === 0, "F8: rows from another day show its weekday", days);

  // F1: a filter change starts the list at 150 rows again.
  await page.selectOption("#dash-llm .dash-llm-kind", "work");
  await page.selectOption("#dash-llm .dash-llm-kind", "");
  await page.waitForTimeout(100);
  check(await forkRows() === 150, "F1: a filter change shows 150 rows again", await forkRows());

  // F2: forks fetched for a character are never dropped, however many forks the frames bring after them.
  const who = await page.evaluate(() => {
    const a = devHost.world.agents.find(x => x.alive && x.controller && x.age >= 18 && x.llmForks.length === 30
      && x.llmForks.filter(f => f.decided_by === "model").length >= 20);
    return a ? { id: a.id, model: a.llmForks.filter(f => f.decided_by === "model").map(f => f.id) } : null;
  });
  if (!check(!!who, "F2: a character with a full ring of 30")) { await page.close(); return; }
  await page.evaluate(() => { const b = document.getElementById("dash-llm"); b.scrollTop = 0; });
  await page.selectOption("#dash-llm .dash-llm-agent", who.id);
  await page.waitForFunction(() => { const b = document.querySelector("#dash-llm .dash-older"); return b.hidden || !b.disabled; },
    null, { timeout: 5000 }).catch(() => {});
  await page.evaluate(id => {
    const W = devHost.world, st = window.__lastState, other = W.agents.find(x => x.alive && x.controller && x.id !== id);
    const tpl = W.llmRing[W.llmRing.length - 1], forks = [];
    for (let i = 0; i < 2400; i++) {
      const model = i % 2 === 0;
      forks.push(Object.assign({}, tpl, { id: `f${9000000 + i}`, agent: other.id, tick: st.tick, happened: [], late: null,
        decided_by: model ? "model" : "habit", controller: model ? tpl.controller : null, model: model ? tpl.model : null }));
    }
    Dash.frame({ type: "state", speed: 0, state: st, events: [], forks });
  }, who.id);
  await page.waitForTimeout(450);
  const kept = await page.evaluate(ids => ids.filter(id => document.querySelector(`#dash-llm .dash-llmlist li[data-key="${id}"]`)).length, who.model);
  check(kept === who.model.length, "F2: a character's fetched decisions survive 2,400 newer forks", [kept, who.model.length]);
  const held = (await inspect(page)).forks;
  check(held <= 1000 + 1000 + 600, "F2: the fork store stays bounded", held);

  // F2: "LLM decisions (n)" is the server's count (the people row's llm), not what the page holds.
  await page.evaluate(id => {
    const st = JSON.parse(JSON.stringify(window.__lastStats));
    st.people.find(p => p.id === id).llm = 77;
    window.__lastStats = st;
    Dash.stats(st);
  }, who.id);
  await page.keyboard.press("4");
  await page.waitForTimeout(250);
  await tryClick(page, `#dash-people .dash-rank > li[data-key="${who.id}"] .dash-nm`, "F2");
  await page.waitForTimeout(150);
  const rankBtn = await page.locator(`#dash-people .dash-rank > li[data-key="${who.id}"] [data-act="llm"]`).innerText().catch(() => "");
  check(/\(77\)/.test(rankBtn), "F2: the ranking row's LLM decisions count comes from the server", rankBtn);

  // F10: every Full page link leaves the character page the note that skips its takeover question.
  await page.evaluate(() => {
    window.__notes = [];
    document.addEventListener("click", e => {
      const a = e.target.closest && e.target.closest('a[href*="character.html"]');
      if (!a) return;
      window.__notes.push(sessionStorage.getItem("goal.character.from-city"));
      sessionStorage.removeItem("goal.character.from-city");
      e.preventDefault();
    });
  });
  await tryClick(page, `#dash-people .dash-rank > li[data-key="${who.id}"] a[href*="character.html"]`, "F10");
  await page.keyboard.press("3");
  await page.selectOption("#dash-llm .dash-llm-agent", "");
  await page.waitForTimeout(150);
  await tryClick(page, "#dash-llm .dash-llmlist li.dash-fork .dash-fhead", "F10");
  await page.waitForTimeout(100);
  await tryClick(page, "#dash-llm .dash-llmlist li.dash-fork.open a[href*='character.html']", "F10");
  await page.evaluate(id => Dash.selectAgent(id), who.id);
  await page.waitForFunction(() => document.querySelector("#dash-people .dash-detail:not([hidden]) a[href*='character.html']"), null, { timeout: 5000 }).catch(() => {});
  const detailBtn = await page.locator('#dash-people .dash-detail [data-act="llm"]').innerText().catch(() => "");
  check(/\(77\)/.test(detailBtn), "F2: the person's LLM decisions count comes from the server", detailBtn);
  await tryClick(page, "#dash-people .dash-detail a[href*='character.html']", "F10");
  const notes = await page.evaluate(() => window.__notes);
  check(notes.length === 3 && notes.every(n => n && Number(n) > 0), "F10: the ranking, LLM row and person links all hand God over", notes);
  await page.evaluate(() => Dash.selectAgent(null));

  // F7: each controller's line counts its own characters thinking; F6: answered in time never shows above 100%.
  await setThinking(page, 3);
  await page.evaluate(() => {
    const st = JSON.parse(JSON.stringify(window.__lastStats));
    st.llm.controllers.push({ name: "second-bot", model: "m2", characters: 0 });
    Object.assign(st.llm.today, { asked: 2, in_time: 3, timeouts: 3, late: 3, withdrawn: 0, against_habit: 0, avg_seconds: 2.1 });
    Dash.stats(st);
  });
  await page.keyboard.press("1");
  await page.waitForTimeout(150);
  const strip = await page.evaluate(() => {
    const lines = [...document.querySelectorAll("#dash-city .dash-ai > div")].map(d => d.innerText.trim());
    const kpi = [...document.querySelectorAll("#dash-city .dash-kpi")].map(k => k.innerText.replace(/\s+/g, " ")).find(t => /^ai /i.test(t));
    return { lines, kpi, hud: document.querySelector('#hud [data-k="ai"]').innerText.trim() };
  });
  const line = name => strip.lines.find(l => l.startsWith(name)) || "";
  check(/· 3 thinking now$/.test(line("claude")) && !/thinking/.test(line("second-bot")), "F7: each controller line counts its own thinking", strip.lines);
  check(/in time 3 \(100%\)/.test(strip.lines.join(" ")) && /100% answered in time today/.test(strip.kpi || ""), "F6: answered in time is held at 100%", strip);
  check(/^AI: \d+ playing, 3 thinking$/.test(strip.hud), "the desktop AI chip says how many play and think", strip.hud);
  await setThinking(page, 0);
  const calm = await page.evaluate(() => document.querySelector('#hud [data-k="ai"]').innerText.trim());
  check(/^AI: \d+ playing$/.test(calm), "the desktop AI chip drops the thinking count at 0", calm);

  // F9: the HUD, the Mood tile and the mood trend give one change against 24 h ago, from the live mood.
  const f9 = await page.evaluate(() => {
    const st = JSON.parse(JSON.stringify(window.__lastStats));
    const last = Math.floor(st.tick / 60) * 60;
    st.tick = last + 30;
    st.full = true;
    st.samples = [];
    for (let i = 47; i >= 0; i--) st.samples.push(Object.assign({}, window.__lastStats.samples[0] || {}, { tick: last - i * 60, day: Math.floor((last - i * 60) / 1440),
      mood: 55, wealth: st.city.wealth.total, pop: st.city.population }));
    st.samples[st.samples.length - 1 - 24].mood = 50;   // the newest sample at least 24 h before the push
    st.samples[st.samples.length - 1].mood = 60;        // the last hourly sample
    st.city.mood = 63;                                   // now
    Dash.stats(st);
    const hud = document.querySelector('#hud [data-k="mood"]').title;
    const tile = [...document.querySelectorAll("#dash-city .dash-kpi")].map(k => k.innerText.replace(/\s+/g, " ")).find(t => /^mood /i.test(t));
    const spark = document.querySelector('#dash-city .dash-spark[data-spark="mood"]');
    return { hud, tile, head: spark && spark.querySelector(".dash-spark-head b").innerText,
      chg: spark && spark.querySelector(".dash-spark-axis").innerText.replace(/\s+/g, " ") };
  });
  check(/up 13 in 24 h/.test(f9.hud) && /▲13 in 24 h/.test(f9.tile || "") && /▲ 13 in 24 h/.test(f9.chg || "") && f9.head === "63",
    "F9: HUD, Mood tile and trend line agree on the change in 24 h", f9);
  await page.evaluate(() => Dash.stats(Object.assign({}, window.__lastStats, { full: true })));

  // F5: first meetings fold into their day's digest line; search or a person chip shows them again.
  await page.keyboard.press("2");
  await page.waitForTimeout(350);
  const news = () => page.evaluate(() => ({
    met: [...document.querySelectorAll("#dash-news .dash-stream li.dash-ev")].filter(li => /for the first time/.test(li.innerText)).length,
    digest: [...document.querySelectorAll("#dash-news .dash-stream li.dash-day")].map(li => li.innerText).filter(t => /\d+ first meetings?/.test(t)).length,
  }));
  const folded = await news();
  check(folded.met === 0 && folded.digest > 0, "F5: first meetings are folded into the day's digest", folded);
  await page.fill("#dash-news .dash-search", "first time");
  await page.waitForTimeout(150);
  const found = await news();
  check(found.met > 0, "F5: searching shows the first meetings again", found);
  await page.fill("#dash-news .dash-search", "");

  check(errors.length === 0, "main-screen fixes: no console errors", errors);
  await shot(page, "fixes-desktop");
  await page.close();
}

// F1 on a page that stays open: `live` LLM forks reach the page after its welcome (?backlog=90: the city's ring of
// 500 is full) before "Load older" is first clicked. With 300 the welcome's oldest fork is still in the server's
// ring, 120 older behind it; with 450 it has left the ring, so the server has nothing older than what the page
// holds. Either way the clicks reach every decision the page or the ring has, and the button goes only then.
async function liveOlder(browser, base, live) {
  console.log(`desktop Load older after ${live} live forks 1440x900 ?backlog=90`);
  const { page, errors } = await openPage(browser, base, "?backlog=90&speed=4", { width: 1440, height: 900 });
  await capturePaused(page);
  const want = await page.evaluate(n => {
    // Forks the city decides after the welcome: the fake host's rings take them as the server's would, and the
    // page gets them in frames of 30. One in five timed out (the default filter hides those).
    const W = devHost.world, st = window.__lastState, tpl = W.llmRing[W.llmRing.length - 1];
    const played = W.agents.filter(a => a.alive && a.controller);
    const forks = [];
    for (let i = 0; i < n; i++) {
      const a = played[i % played.length], timeout = i % 5 === 4;
      const f = Object.assign({}, tpl, { id: `f${++W.forkSeq}`, agent: a.id, tick: st.tick, happened: [], late: null,
        decided_by: timeout ? "timeout" : "model", answer_seconds: timeout ? null : 2.5, reason: timeout ? "" : tpl.reason || "live" });
      a.llmForks.push(f);
      if (a.llmForks.length > 30) a.llmForks.shift();
      W.llmRing.push(f);
      if (W.llmRing.length > 500) W.llmRing.shift();
      forks.push(f);
    }
    for (let i = 0; i < forks.length; i += 30) Dash.frame({ type: "state", speed: 0, state: st, events: [], forks: forks.slice(i, i + 30) });
    // Every model decision the page holds (the welcome's 80 and these) or the ring still has, newest first.
    const seen = new Map();
    for (const f of [].concat(W.llmBacklog, W.llmRing)) if (f.decided_by === "model") seen.set(f.id, f);
    const all = [...seen.values()].sort((x, y) => (y.tick - x.tick) || (Number(y.id.slice(1)) - Number(x.id.slice(1))));
    return { n: all.length, oldest: all[all.length - 1].id, inRing: W.llmRing.some(f => f.id === W.llmBacklog[0].id) };
  }, live);
  await page.keyboard.press("3");
  await page.waitForTimeout(350);
  const forkRows = () => page.locator("#dash-llm .dash-llmlist li.dash-fork").count();
  const counts = [await forkRows()];
  for (let i = 0; i < 40; i++) {
    if (!(await page.locator("#dash-llm .dash-older").isVisible())) break;
    await page.evaluate(() => { const b = document.getElementById("dash-llm"); b.scrollTop = b.scrollHeight; });
    await page.click("#dash-llm .dash-older");
    await page.waitForFunction(() => { const b = document.querySelector("#dash-llm .dash-older"); return b.hidden || !b.disabled; },
      null, { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(60);
    counts.push(await forkRows());
  }
  const oldestShown = await page.evaluate(() => { const li = [...document.querySelectorAll("#dash-llm .dash-llmlist li.dash-fork")].pop(); return li && li.dataset.key; });
  check(want.inRing === (live + 80 <= 500), `F1 (${live} live): the welcome's oldest fork is ${live + 80 <= 500 ? "still" : "no longer"} in the server's ring`, want);
  check(counts[1] > counts[0] && counts[counts.length - 1] === want.n,
    `F1 (${live} live): Load older shows every decision the page and the server's ring hold`, { counts, want: want.n });
  check(oldestShown === want.oldest, `F1 (${live} live): the oldest row shown is the oldest decision there is`, [oldestShown, want.oldest]);
  check(await page.locator("#dash-llm .dash-older").isHidden(), `F1 (${live} live): Load older goes once nothing older is left`);
  check(errors.length === 0, `F1 (${live} live): no console errors`, errors);
  await page.close();
}

// The phone: the AI chip says how many play, and every "Show on map" from a full sheet drops it to half (F3).
async function phoneFixes(browser, base) {
  console.log("phone main-screen fixes 390x844");
  const { page, errors } = await openPage(browser, base, "?speed=4", { width: 390, height: 844 }, true);
  await capturePaused(page);

  const chip = () => page.evaluate(() => document.querySelector('#hud [data-k="ai"]').innerText.trim().replace(/\s+/g, " "));
  let playing = await setThinking(page, 0);
  let text = await chip();
  check(playing > 0 && text === `AI ${playing}`, "the phone AI chip reads AI and the number playing", [text, playing]);
  await setThinking(page, 3);
  text = await chip();
  check(text === `AI ${playing} 3`, "the phone AI chip adds the thinking count while anyone thinks", text);
  await setThinking(page, 0, true);
  text = await chip();
  check(text === "AI: nobody", "the phone AI chip says nobody when nobody plays", text);
  await setThinking(page, 0);

  // F3: a full sheet drops to half on "Show on map", and the focus uses the half sheet's inset.
  const toFull = async () => {
    for (let i = 0; i < 3 && (await inspect(page)).sheet !== "full"; i++) {
      await page.focus("#panel .dash-grip");
      await page.keyboard.press("ArrowUp");
      await page.waitForTimeout(350);
    }
  };
  async function showFromFull(what, act) {
    await toFull();
    const before = (await calls(page, "focus")).length;
    await act();
    await page.waitForTimeout(500);
    const info = await inspect(page);
    const fs = await calls(page, "focus");
    const inset = fs.length ? (fs[fs.length - 1][1] || {}).inset : null;
    check(fs.length > before && info.sheet === "half", `F3: ${what} from a full sheet drops it to half`, [info.sheet, fs.length - before]);
    check(!!inset && inset.bottom < 600 && Math.abs(inset.bottom - info.inset.bottom) <= 3,
      `F3: ${what} focuses with the half sheet's inset`, [inset, info.inset]);
    // The view centres its camera within its own inset: when the focus goes out, that inset is already the half
    // sheet's (a focus against the full sheet's would land the target lower by half the difference).
    const order = await page.evaluate(() => {
      const c = devView.calls;
      let i = c.length - 1;
      while (i >= 0 && c[i][0] !== "focus") i--;
      let j = i - 1;
      while (j >= 0 && c[j][0] !== "setInset") j--;
      return { focus: i >= 0 ? (c[i][1][1] || {}).inset : null, viewInset: j >= 0 ? c[j][1][0] : null };
    });
    check(!!order.focus && !!order.viewInset && order.viewInset.bottom === order.focus.bottom,
      `F3: ${what} gives the view the half sheet's inset before the focus`, order);
  }
  await page.click("#dash-tab-news");
  await page.waitForTimeout(350);
  await showFromFull("a headline's Show on map", () => page.click("#dash-news .dash-heads .dash-link"));
  await showFromFull("a news row", () => page.click("#dash-news .dash-stream li.dash-ev .dash-evtext"));
  await page.click("#dash-tab-llm");
  await page.waitForTimeout(350);
  await toFull();
  await page.click("#dash-llm .dash-llmlist li.dash-fork .dash-fhead");
  await showFromFull("an LLM row's Show on map", () => page.click('#dash-llm .dash-llmlist li.dash-fork.open [data-act="map"]'));
  await page.click("#dash-tab-people");
  await page.waitForTimeout(350);
  await toFull();
  await page.click("#dash-people .dash-rank > li .dash-nm");
  await showFromFull("a ranking row's Show on map", () => page.click('#dash-people .dash-rank > li.open [data-act="map"]'));
  const id = await page.evaluate(() => devHost.world.agents.find(a => a.alive && a.age >= 18).id);
  await page.evaluate(i => Dash.selectAgent(i), id);
  await page.waitForFunction(() => document.querySelector('#dash-people .dash-detail:not([hidden]) [data-act="map"]'), null, { timeout: 5000 }).catch(() => {});
  await showFromFull("the person's Show on map", () => page.click('#dash-people .dash-detail [data-act="map"]'));
  await page.evaluate(() => Dash.openHome("park_66"));
  await page.waitForFunction(() => document.querySelector('#dash-people .dash-card:not([hidden]) [data-act="map"]'), null, { timeout: 5000 }).catch(() => {});
  await showFromFull("the home card's Show on map", () => page.click('#dash-people .dash-card [data-act="map"]'));
  await shot(page, "fixes-phone");
  check(errors.length === 0, "phone main-screen fixes: no console errors", errors);
  await page.close();
}

// F3 with the real map (?view=real): "Show on map" on an LLM row with a place (the camera follows nobody) puts the
// place at the same spot on the screen, in the map above the sheet, whether the sheet was full or half.
async function phoneRealMap(browser, base) {
  console.log("phone Show on map with the real view 390x844 ?view=real");
  const { page, errors } = await openPage(browser, base, "?view=real&speed=4", { width: 390, height: 844 }, true);
  if (!(await page.evaluate(() => !!(window.devView && !devView.stub && devView.screenOf)))) {
    check(false, "F3: the real view loaded on the dev page");
    await page.close();
    return;
  }
  await capturePaused(page);
  await page.click("#dash-tab-llm");
  await page.waitForTimeout(350);
  const key = await page.evaluate(() => {
    const li = [...document.querySelectorAll("#dash-llm .dash-llmlist li.dash-fork")].find(l => {
      const f = devHost.world.llmRing.find(x => x.id === l.dataset.key);
      return f && f.place;
    });
    return li ? li.dataset.key : null;
  });
  if (!check(!!key, "F3: an LLM row with a place")) { await page.close(); return; }
  const place = await page.evaluate(k => devHost.world.llmRing.find(x => x.id === k).place, key);
  const sheetTo = async want => {
    for (let i = 0; i < 5 && (await inspect(page)).sheet !== want; i++) {
      await page.focus("#panel .dash-grip");
      await page.keyboard.press((await inspect(page)).sheet === "full" ? "ArrowDown" : "ArrowUp");
      await page.waitForTimeout(350);
    }
    return (await inspect(page)).sheet === want;
  };
  const seen = {};
  for (const start of ["half", "full"]) {
    check(await sheetTo(start), `F3: the sheet goes to ${start}`);
    // Move the camera away first, so each tap makes the same flight.
    await page.evaluate(() => devView.focus({ tile: [2, 2] }, { ms: 1 }));
    await page.waitForTimeout(150);
    await page.evaluate(() => { document.getElementById("dash-llm").scrollTop = 0; });
    const row = page.locator(`#dash-llm li.dash-fork[data-key="${key}"]`);
    if (!(await row.evaluate(l => l.classList.contains("open")))) { await row.locator(".dash-fhead").click(); await page.waitForTimeout(200); }
    await row.locator('[data-act="map"]').click();
    await page.waitForTimeout(1500);
    seen[start] = await page.evaluate(p => {
      const s = devView.screenOf({ place: p }), i = Dash.inspect();
      return { sheet: i.sheet, inset: i.inset, at: s ? s.map(Math.round) : null, h: document.getElementById("world").getBoundingClientRect().height };
    }, place);
    await shot(page, `f3-real-from-${start}`);
  }
  const h = seen.half, f = seen.full;
  check(f.sheet === "half" && !!h.at && !!f.at, "F3: from a full sheet the tap ends with a half sheet", seen);
  if (h.at && f.at) {
    check(Math.abs(h.at[1] - f.at[1]) <= 4 && Math.abs(h.at[0] - f.at[0]) <= 4,
      "F3: the place lands where it does from a half sheet", seen);
    check(f.at[1] >= f.inset.top && f.at[1] <= f.h - f.inset.bottom, "F3: the place is in the map above the sheet", seen);
  }
  check(errors.length === 0, "F3 real map: no console errors", errors);
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
    await rules(browser, base);
    await slowAi(browser, base);
    await browserBuild(browser, base);
    await tallBlocks(browser, base);
    await phone(browser, base);
    await screenFixes(browser, base);
    for (const live of [300, 450]) await liveOlder(browser, base, live);
    await phoneFixes(browser, base);
    await phoneRealMap(browser, base);
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

#!/usr/bin/env node
// Headless check of the built page (port/dist/millbrook.html by default):
//
//   node port/tools/page_check.cjs [PAGE]
//
// Opens the page from file:// in Chromium, waits for the city to run, opens a person (through Dash when the
// client has the dashboard, else from the classic roster), and checks: no console errors or page errors, no
// request leaves the page, the clock moves, the person's panel shows, no a[href*="character.html"] exists, the
// page did not fall back to Millbrook (it reports the world and townsfolk it runs: `world`, `folk`), and a region
// opens on its default view (view.md 3.7: CityView.DEFAULT_VIEW, within one tile; `camera`).
// Prints one JSON line. Without Playwright or a browser it can launch it prints {"skip": why} and exits 0.
"use strict";

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

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

function done(result, code) {
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exit(code);
}

async function main() {
  const page_file = path.resolve(process.argv[2] || path.join(__dirname, "..", "dist", "millbrook.html"));
  if (!fs.existsSync(page_file)) done({ ok: false, error: `no page at ${page_file}: run python3 port/build.py` }, 1);
  const pw = findPlaywright();
  if (!pw) done({ skip: "Playwright is not installed" }, 0);
  let browser;
  try {
    browser = await pw.chromium.launch({ headless: true });
  } catch (err) {
    done({ skip: `Chromium did not start: ${String(err.message || err).split("\n")[0]}` }, 0);
  }
  const errors = [], external = [];
  const result = { ok: false, errors, external };
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.addInitScript(() => { // keep the CityView instance game.js makes (window.__view)
      const CV = window.CityView = window.CityView || {};
      let create = null;
      Object.defineProperty(CV, "create", {
        configurable: true, enumerable: true,
        get() { return create && function () { const v = create.apply(this, arguments); window.__view = v; return v; }; },
        set(fn) { create = fn; },
      });
    });
    page.on("console", msg => { if (msg.type() === "error") errors.push(`console: ${msg.text()}`); });
    page.on("pageerror", err => errors.push(`page: ${err.message}`));
    page.on("request", req => { if (!/^(file|data|blob|about):/.test(req.url())) external.push(req.url()); });
    await page.goto(pathToFileURL(page_file).href + "?seed=1&dice=7&speed=16");
    await page.waitForFunction(() => /Day \d+/.test((document.getElementById("clock") || {}).textContent || ""),
      null, { timeout: 20000 });
    result.clock_start = await page.textContent("#clock");
    // the world the page runs (page.js: region with 1,000 townsfolk unless ?world= says otherwise) and whether it had
    // to fall back to Millbrook (the notice page.js shows when the region cannot start)
    Object.assign(result, await page.evaluate(() => {
      const p = window.GameOfAILifePage || {};
      return { world: p.world, folk: p.folk, fallback: !!document.getElementById("world-notice") };
    }));
    // The camera the page opens on: a region's default view (no stored camera in a fresh browser)
    result.camera = await page.evaluate(() => {
      const v = window.__view, d = window.CityView && window.CityView.DEFAULT_VIEW;
      if (!v || !d) return null;
      const c = v.camera();
      return { x: Math.round(c.x * 10) / 10, y: Math.round(c.y * 10) / 10, zoom: c.zoom, want: d,
        ok: Math.abs(c.x - d.x) <= 1 && Math.abs(c.y - d.y) <= 1 && Math.abs(c.zoom - d.zoom) < 1e-6 };
    });
    // The dashboard client is the one whose game.js started Dash (Dash.inspect() is null until Dash.init).
    const dash = await page.evaluate(() => (window.Dash && typeof Dash.inspect === "function" ? Dash.inspect() : null));
    result.client = dash ? "dashboard" : "classic";
    if (dash) result.host = dash.host;
    if (result.client === "dashboard") {
      await page.evaluate(() => { if (Dash.openTab) Dash.openTab("people"); Dash.selectAgent("dana"); });
      await page.waitForFunction(() => Dash.selected() === "dana", null, { timeout: 10000 });
    } else {
      await page.waitForSelector('#roster li[data-id="dana"]', { timeout: 10000 });
      await page.click('#roster li[data-id="dana"]');
    }
    await page.waitForFunction(() => {
      const box = document.getElementById("detail") || document.getElementById("panel") || document.body;
      return /Dana Cohen/.test(box.textContent || "");
    }, null, { timeout: 10000 });
    await page.waitForTimeout(2500); // a few refreshes of the open panel, at 16x
    result.person = "dana";
    result.clock_end = await page.textContent("#clock");
    result.character_links = await page.evaluate(() => document.querySelectorAll('a[href*="character.html"]').length);
    result.ok = !errors.length && !external.length && result.character_links === 0 && result.clock_end !== result.clock_start
      && (!dash || result.host.kind === "browser") && !result.fallback
      && (result.world !== "region" || (!!result.camera && result.camera.ok));
  } catch (err) {
    result.error = String(err.message || err).split("\n")[0];
  } finally {
    await browser.close();
  }
  done(result, result.ok ? 0 : 1);
}

main();

// GameOfAILife God view: the dashboard around the map. City, News, LLM log and People tabs, the HUD,
// toasts, the ticker, map colours, the home card and the phone bottom sheet (dashboard.md 3-9, PLAN 3.6-3.13).
//
// A classic script with no dependencies; it defines only window.Dash. game.js keeps the socket, the header
// and the CityView lifecycle (create, setTown, setState, start). Dash fills #panel, #hud, #overlay-chips,
// #toasts, #ticker and #tooltip, and calls only view.select, focus, highlight, setOverlay, ping and setInset,
// each only when the view has it.
//
// API
//   Dash.init(view, opts)            view: the CityView instance, or null (then nothing moves on the map)
//     opts.send(msg)                 required: send one message to the host (the socket or the port's LocalHost)
//     opts.onSelectAgent(id|null)    optional: Dash changed the selected person (the view is already told)
//     opts.panel, opts.world         optional: the elements (default #panel and #world)
//     opts.characterPage             optional: the character page URL (default "character.html")
//     opts.keys                      optional: false leaves keys 1-4, \ and / to the page
//   Dash.welcome(msg)                the God welcome (3.9): role, town, state, history, news, headlines,
//                                    llm_log, host, stats
//   Dash.frame(msg)                  every {type: "state", speed, state, events, forks}: majors ping the map
//                                    and toast
//   Dash.stats(msg)                  a stats push or the get_stats reply (3.8)
//   Dash.reply(msg) -> bool          agent, home, decisions, luck_set, error, demoted: true when Dash used it
//                                    (game.js may still read speed and demoted for its header)
//   Dash.message(msg) -> bool        any message: routes welcome, state, stats and the replies above
//   Dash.pick(hit, ev)               CityView onPick: a person; a bus's first rider; a home card for an empty
//                                    home or a second tap on one; otherwise a place's first occupant
//   Dash.hover(hit, ev)              CityView onHover: renders #tooltip (addresses and families on hover only);
//                                    ev.touch means a long-press: shown above the finger until the next tap or 4 s
//   Dash.viewSelected(id|null)       CityView onSelect (Esc in the view): like the Back button
//   Dash.selectAgent(id|null, {focus, follow})   open a person in the People tab; null closes them
//   Dash.selected() -> id|null
//   Dash.openTab(name, {section})    "city" | "news" | "llm" | "people"
//   Dash.openHome(id)                the home card: a home id, or a block's place id (lists its 6 flats)
//   Dash.setOverlay(name|null)       "wealth" | "mood" | "condition"
//   Dash.characterHref(id)           "character.html?id=..."; null when welcome.host.kind == "browser"
//   Dash.notice(text, kind)          a card in #toasts: "error" (default) or "info"
//   Dash.setRole(role)               "god", or anything else for a watcher (luck and play style locked)
//   Dash.layout()                    re-measure and send view.setInset (Dash also does it on resize)
//   Dash.inspect()                   a small summary of the dashboard's state, for tests
//   Dash.TOPIC_OF_TAG, Dash.RAMPS, Dash.fmt {money, compact, stamp}
//
// Requests Dash sends carry req_id "dash:<n>": get_agent (every 800 ms while a person is open), get_home,
// get_decisions, set_luck and set_profile. Errors become "Not done: ..." cards in #toasts.
"use strict";
(function () {
  // --- constants ---------------------------------------------------------------------------------------

  const TABS = ["city", "news", "llm", "people"];
  const TAB_NAME = { city: "City", news: "News", llm: "LLM log", people: "People" };
  const NEED_COLOR = { hunger: "#f0a04b", energy: "#6cb6ff", social: "#f08ab4", fun: "#6fcf7c" };
  // dashboard.md 8.4: validated categorical dark slots 1-3 on the panel surface #262e3d
  const SEG = { cash: "#3987e5", savings: "#d95926", home: "#199e70" };
  const DEBT = "#d03b3b";
  const STAGE_COLOR = ["#0ca30c", "#9aa5b8", "#fab219", "#ec835a", "#d03b3b"];
  const STAGE_NAME = ["kept", "worn", "shabby", "neglected", "derelict"];
  const WEALTH_RAMP = ["#184f95", "#1c5cab", "#256abf", "#2a78d6", "#3987e5", "#5598e7", "#6da7ec", "#86b6ef"];
  const MOOD_STOPS = ["#e66767", "#383835", "#3987e5"];
  const RAMPS = Object.freeze({ wealth: WEALTH_RAMP, mood: MOOD_STOPS, condition: STAGE_COLOR, stages: STAGE_NAME,
    segments: SEG, debt: DEBT });
  // PLAN 3.7: Homes = kind home; Money = money, goal and the money tags; People = social, message;
  // Health = health, death, injury; AI = controller. A tag wins over its kind.
  const TOPIC_OF_TAG = Object.freeze({ home: "homes", money: "money", goal: "money", big_money: "money",
    money_swing: "money", social: "people", message: "people", health: "health", death: "health", injury: "health",
    controller: "ai" });
  const TOPICS = [["homes", "Homes"], ["money", "Money"], ["people", "People"], ["health", "Health"], ["ai", "AI"]];
  const PING_OF_TOPIC = { homes: "home", money: "money", people: "social", health: "health" };
  const LEVELS = [["major", "Major"], ["notable", "Notable"], ["all", "Everything"]];
  const SEGS = [["adults", "Adults"], ["everyone", "Everyone"], ["households", "Households"]];
  const SORTS = [["worth", "Net worth"], ["change", "24 h change"], ["mood", "Mood"], ["health", "Health"],
    ["luck", "Luck"], ["age", "Age"]];
  const OVERLAYS = [["", "None"], ["wealth", "Wealth"], ["mood", "Mood"], ["condition", "Condition"]];
  const FORK_KINDS = [["work", "work"], ["sleep", "sleep"], ["hunger", "hunger"], ["payday", "payday"],
    ["groceries", "groceries"], ["lonely", "lonely"], ["free_time", "free time"], ["invite", "invite"],
    ["house_hunt", "house hunt"], ["upkeep", "upkeep"], ["repair", "repair"], ["housing_trouble", "housing trouble"]];
  const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const TIER_LABEL = { flat: "flat", house: "house", big_house: "big house" };
  // forks: habit and profile decisions kept; llm: controller decisions (model, timeout) kept. Forks a
  // get_decisions reply brought are never dropped (dashboard.md 6.3: a character's history stays complete).
  const KEEP = { notable: 600, routine: 300, forks: 1000, llm: 1000, samples: 168 };
  const SHOW = { news: 200, llm: 150, older: 100, headlines: 5 };
  const TOAST_MS = 8000, NOTICE_MS = 6000, TICKER_DIM_MS = 20000, POLL_MS = 800, TIP_TOUCH_MS = 4000;
  const MINUS = "−";

  const ICON = {
    city: '<path d="M2 14V7.5l4-2V14M6 14V3l5 2v9M11 14V8.5l3 1V14M1 14h14"/>',
    news: '<path d="M2.5 3.5h9v9a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1zM11.5 6.5h2v6a1 1 0 0 1-2 0M4.5 6h5M4.5 8.5h5M4.5 11h3"/>',
    ai: '<path d="M5 5h6v6H5zM6.8 2.5V5M9.2 2.5V5M6.8 11v2.5M9.2 11v2.5M2.5 6.8H5M2.5 9.2H5M11 6.8h2.5M11 9.2h2.5"/>',
    people: '<circle cx="6" cy="5.5" r="2.2"/><path d="M2 13.5c0-2.6 1.8-4.2 4-4.2s4 1.6 4 4.2"/><circle cx="11.6" cy="6.3" r="1.7"/><path d="M10.9 9.4c1.9.1 3.1 1.5 3.1 4.1"/>',
    homes: '<path d="M2.5 8 8 3l5.5 5M4 7v6.5h8V7"/>',
    money: '<circle cx="8" cy="8" r="5.5"/><path d="M9.8 6C9.4 5.4 8.8 5.1 8 5.1c-1 0-1.8.6-1.8 1.4 0 .9.8 1.2 1.8 1.5 1 .3 1.9.6 1.9 1.6 0 .8-.9 1.4-1.9 1.4-.9 0-1.6-.3-2-.9M8 3.9v1.2M8 10.9v1.2"/>',
    health: '<path d="M8 13.4S2.5 10.2 2.5 6.3A2.8 2.8 0 0 1 8 5a2.8 2.8 0 0 1 5.5 1.3c0 3.9-5.5 7.1-5.5 7.1z"/>',
    death: '<path d="M8 2.5v11M5 5.5h6"/>',
    star: '<path d="m8 2.2 1.7 3.7 4 .5-3 2.8.8 4L8 11.2l-3.5 2 .8-4-3-2.8 4-.5z"/>',
    close: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>',
    own: '<path class="f" d="M2 8.2 8 3l6 5.2-.9 1-.6-.5v5.3H3.5V8.7l-.6.5z"/>',
    rent: '<path d="M2.5 8 8 3l5.5 5M4 7v6.5h8V7"/>',
    flat: '<path d="M3.5 14V2.5h9V14M2 14h12M6 5h1M9 5h1M6 7.8h1M9 7.8h1M7 14v-3h2v3"/>',
    alert: '<path d="M8 2.5 14 13H2zM8 6.5v3M8 11.3v.2"/>',
    pin: '<path d="M8 14s4.5-4.1 4.5-7.4a4.5 4.5 0 0 0-9 0C3.5 9.9 8 14 8 14z"/><circle cx="8" cy="6.5" r="1.5"/>',
  };
  const icon = (name, cls) => `<svg class="dash-i${cls ? " " + cls : ""}" viewBox="0 0 16 16" aria-hidden="true">${ICON[name] || ICON.star}</svg>`;

  // --- small helpers -----------------------------------------------------------------------------------

  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pretty = s => String(s || "").replace(/_/g, " ");
  const round = x => Math.floor(x + 0.5);
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const mean = xs => { const v = xs.filter(x => typeof x === "number" && isFinite(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const first = name => String(name || "").split(" ")[0];
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + "s"}`;
  const pad2 = n => String(n).padStart(2, "0");
  function hash(s) {
    let h = 2166136261;
    for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    return h >>> 0;
  }
  function shirt(id) {
    const CV = window.CityView;
    return CV && typeof CV.shirt === "function" ? CV.shirt(id) : `hsl(${hash(id) % 360} 65% 55%)`;
  }
  function money(n) {
    if (n == null || !isFinite(n)) return "–";
    const r = round(n);
    return (r < 0 ? MINUS + "$" : "$") + Math.abs(r).toLocaleString("en-US");
  }
  function compact(n) {
    if (n == null || !isFinite(n)) return "–";
    const a = Math.abs(n), s = n < 0 ? MINUS + "$" : "$";
    if (a >= 999500) return s + (a / 1e6).toFixed(a >= 9.95e6 ? 0 : 1).replace(/\.0$/, "") + "M";
    if (a >= 9999.5) return s + round(a / 1000) + "k";
    if (a >= 999.5) return s + (a / 1000).toFixed(1).replace(/\.0$/, "") + "k";
    return s + round(a);
  }
  function deltaMoney(n, fmt) {
    const r = round(n), f = fmt || money;
    return r > 0 ? `▲ ${f(r)}` : r < 0 ? `▼ ${f(-r)}` : "±$0";
  }
  const deltaNum = n => (n > 0 ? `▲${n}` : n < 0 ? `▼${-n}` : "±0");
  const dirClass = n => (n > 0 ? "up" : n < 0 ? "down" : "flat");
  function stamp(tick) {
    const day = Math.floor(tick / 1440), m = ((tick % 1440) + 1440) % 1440;
    return `Day ${day + 1} ${DAY_NAMES[((day % 7) + 7) % 7]} ${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
  }
  const hm = tick => { const m = ((tick % 1440) + 1440) % 1440; return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`; };
  const dayLabel = day => `Day ${day + 1} ${DAY_NAMES[((day % 7) + 7) % 7]}`;
  const stageFromCondition = c => (c >= 80 ? 0 : c >= 60 ? 1 : c >= 40 ? 2 : c >= 20 ? 3 : 4);
  const stageOf = lot => (lot ? (lot.stage != null ? lot.stage : stageFromCondition(lot.condition)) : 0);
  const topicOf = e => TOPIC_OF_TAG[e.tag] || TOPIC_OF_TAG[e.kind] || null;
  const iconOf = e => (e.kind === "death" || e.tag === "death" ? "death" : topicOf(e) || "star");
  const pingTopic = e => (e.kind === "death" || e.tag === "death" ? "death" : PING_OF_TOPIC[topicOf(e)] || "other");
  const isSlow = T => !!(T && T.asked >= 20 && T.timeouts > 0.3 * T.asked);
  // A percentage of today's asks, never above 100: a late answer to a fork asked before midnight still lands in
  // the new day's counters.
  const pctOf = (n, d) => (d ? Math.min(100, round(100 * (n || 0) / d)) : null);
  const isLlmFork = f => f.decided_by === "model" || f.decided_by === "timeout";
  const idNum = id => { const m = /(\d+)\s*$/.exec(String(id)); return m ? Number(m[1]) : 0; };
  const forkOrder = (a, b) => (b.tick - a.tick) || (idNum(b.id) - idNum(a.id)) || cmp(String(b.id), String(a.id));
  function hexMix(a, b, t) {
    const p = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
    const x = p(a), y = p(b);
    return "#" + x.map((v, i) => pad2(round(v + (y[i] - v) * t).toString(16))).join("");
  }
  const wealthColor = v => WEALTH_RAMP[clamp(Math.floor(v * WEALTH_RAMP.length), 0, WEALTH_RAMP.length - 1)];
  const moodColor = v => (v <= 0.5 ? hexMix(MOOD_STOPS[0], MOOD_STOPS[1], clamp(v / 0.5, 0, 1))
    : hexMix(MOOD_STOPS[1], MOOD_STOPS[2], clamp((v - 0.5) / 0.5, 0, 1)));
  const storage = {
    get(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
  };
  const reducedMotion = () => !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  // Keyed list sync: reuses each item's element, re-renders it only when its signature changed and moves
  // it into place, so hover, expansion and scroll survive a refresh.
  function syncList(box, items, key, sig, html, cls) {
    const old = new Map();
    for (const el of Array.from(box.children)) old.set(el.dataset.key, el);
    let prev = null;
    for (const it of items) {
      const k = key(it), s = sig(it);
      let el = old.get(k);
      if (el) old.delete(k);
      else { el = document.createElement("li"); el.dataset.key = k; }
      if (el.dataset.sig !== s) { el.dataset.sig = s; el.className = cls(it); el.innerHTML = html(it); }
      const want = prev ? prev.nextSibling : box.firstChild;
      if (want !== el) box.insertBefore(el, want);
      prev = el;
    }
    for (const el of old.values()) el.remove();
  }
  function setHtml(el, html) {
    if (el && el.dashHtml !== html) { el.innerHTML = html; el.dashHtml = html; return true; }
    return false;
  }

  // --- state -------------------------------------------------------------------------------------------

  let S = null;   // everything the dashboard knows; Dash.init builds it

  function freshStores() {
    return {
      town: null, placeById: {}, homeById: {}, unitsOf: {}, districtName: {}, stopById: {},
      state: null, lots: {}, homes: {}, lotsJson: "", homesJson: "", agentById: {}, playing: 0, thinking: 0,
      // hudThink: the thinking counts the HUD chip last drew; the controllers' lines draw the same ones
      thinkingBy: {}, hudThink: { n: 0, by: {} }, stats: null, samples: [], peopleById: {}, hhById: {}, hhWorth: {}, topHousehold: 0,
      ev: new Map(), notable: [], routine: [], maxSeq: 0, seenSeq: 0, unread: 0,
      // forkPinned: ids a get_decisions reply brought (never dropped); forkCount: the others kept, by KEEP slot;
      // forkCursor: per filter ("" for everyone), the oldest fork of the unbroken run the page holds (the welcome's
      // llm_log, then each older page), where "Load older" asks the server to go on from
      forks: new Map(), forkList: [], forkMore: {}, forkPinned: new Set(), forkCount: { forks: 0, llm: 0 }, forkCursor: {},
    };
  }

  function el(sel, root) { return (root || document).querySelector(sel); }
  function ensure(world, id) {
    let e = document.getElementById(id);
    if (!e && world) { e = document.createElement("div"); e.id = id; world.appendChild(e); }
    return e;
  }

  function init(view, opts) {
    const o = opts || {};
    if (typeof o.send !== "function") throw new Error("Dash.init needs opts.send");
    if (S) teardown();
    const world = o.world || document.getElementById("world");
    const panel = o.panel || document.getElementById("panel");
    S = Object.assign(freshStores(), {
      view: view || null, send: o.send, onSelectAgent: typeof o.onSelectAgent === "function" ? o.onSelectAgent : null,
      characterPage: o.characterPage || "character.html", world, panel,
      hud: ensure(world, "hud"), chips: ensure(world, "overlay-chips"), toastBox: ensure(world, "toasts"),
      ticker: ensure(world, "ticker"), tooltip: ensure(world, "tooltip"),
      role: "god", host: { kind: "server", controllers: true }, speed: 1,
      tab: "city", collapsed: storage.get("goal.dash.collapsed") === "1", sheet: "peek", mode: "desktop", phone: false,
      news: { level: "notable", topic: null, person: null, q: "" },
      // The list's window: the newest `shown` decisions, and always down to `floor` (the oldest fork an older page
      // brought). held and end: how many decisions match the filters and how many the last render showed.
      llm: { agent: "", kind: "", against: false, timeouts: false, all: false, expanded: new Set(), topId: null,
        pending: 0, loading: false, shown: SHOW.llm, floor: null, held: 0, end: 0 },
      ppl: { seg: "adults", sort: "worth", q: "", expanded: null, press: false },
      selected: null, detail: null, detailKey: "", editingProfile: null, card: null, cardAsk: 0,
      overlay: null, overlayKey: "", inset: { top: 0, right: 0, bottom: 0 }, layoutQueued: false,
      toasts: [], majorTimes: [], coalesced: null, tickerEvent: null, tickerAt: 0,
      dirty: { hud: true, city: true, news: true, llm: true, people: true },
      at: { hud: 0, city: 0, news: 0, llm: 0, people: 0, ask: 0, mood: 0 },
      req: 0, pending: new Map(), lastPick: null, hlTimer: 0, tipTimer: 0, tipTouch: false, sparks: {}, timers: [], listeners: [],
    });
    if (S.toastBox) { S.toastBox.setAttribute("aria-live", "polite"); S.toastBox.setAttribute("role", "status"); }
    if (S.tooltip) S.tooltip.hidden = true;
    buildPanel();
    buildHud();
    if (o.keys !== false) listen(document, "keydown", onKey);
    listen(window, "resize", () => { updateMode(); layoutSoon(); });
    for (const t of ["pointerup", "pointercancel"]) listen(window, t, () => {
      if (S.ppl.press) { S.ppl.press = false; S.dirty.people = true; }
    }, true);
    if (window.ResizeObserver) {
      S.ro = new ResizeObserver(() => layoutSoon());
      for (const e of [S.world, S.hud, S.chips, S.toastBox, S.panel]) if (e) S.ro.observe(e);
    }
    updateMode();
    S.timers.push(setInterval(pulse, 200));
    renderAll();
    return Dash;
  }
  // Listeners on elements that outlive one init (the page's #hud, #toasts and so on) are removed by teardown.
  function listen(target, type, fn, opt) {
    target.addEventListener(type, fn, opt);
    S.listeners.push([target, type, fn, opt]);
  }
  function teardown() {
    for (const t of S.timers) clearInterval(t);
    clearTimeout(S.tipTimer);
    clearTimeout(S.hlTimer);
    for (const [target, type, fn, opt] of S.listeners) target.removeEventListener(type, fn, opt);
    if (S.ro) S.ro.disconnect();
    S = null;
  }

  function callView(name, ...args) {
    const v = S && S.view;
    if (!v || typeof v[name] !== "function") return undefined;
    try { return v[name](...args); } catch (e) { console.warn(`view.${name} failed`, e); return undefined; }
  }
  function request(msg, ctx) {
    const id = `dash:${++S.req}`;
    S.pending.set(id, ctx || { what: msg.type });
    if (S.pending.size > 200) S.pending.delete(S.pending.keys().next().value);
    try { S.send(Object.assign({}, msg, { req_id: id })); } catch (e) { console.warn("send failed", e); }
    return id;
  }

  // --- the panel ---------------------------------------------------------------------------------------

  function buildPanel() {
    const P = S.panel;
    if (!P) return;
    P.classList.add("dash");
    P.setAttribute("aria-label", "City dashboard");
    P.innerHTML = `
      <button class="dash-grip" type="button" aria-label="Resize the panel"><span></span></button>
      <div class="dash-sheet-ticker"></div>
      <div class="dash-tabs" role="tablist" aria-label="Dashboard">
        ${TABS.map((t, i) => `<button class="dash-tab" type="button" role="tab" id="dash-tab-${t}" data-tab="${t}"
          aria-controls="dash-${t}" aria-selected="false" title="${TAB_NAME[t]} (${i + 1})">${icon(t === "llm" ? "ai" : t)}<span
          class="dash-tab-name">${TAB_NAME[t]}</span>${t === "news" ? '<span class="dash-badge" hidden></span>' : ""}${t === "llm"
          ? '<span class="dash-dot" hidden title="Someone is thinking"></span>' : ""}</button>`).join("")}
        <button class="dash-collapse" type="button" aria-label="Hide the panel" title="Hide the panel (\\)">»</button>
      </div>
      <div class="dash-bodies">
        ${TABS.map(t => `<section class="dash-body" id="dash-${t}" role="tabpanel" aria-labelledby="dash-tab-${t}" tabindex="-1" hidden></section>`).join("")}
      </div>`;
    S.tabBtn = {};
    S.bodies = {};
    for (const t of TABS) { S.tabBtn[t] = el(`#dash-tab-${t}`, P); S.bodies[t] = el(`#dash-${t}`, P); }
    S.sheetTicker = el(".dash-sheet-ticker", P);
    el(".dash-tabs", P).addEventListener("click", ev => {
      if (ev.target.closest(".dash-collapse")) return togglePanel();
      const b = ev.target.closest(".dash-tab");
      if (!b) return;
      const t = b.dataset.tab;
      if (S.mode === "sheet") {
        if (S.sheet === "peek") { openTab(t); return; }
        if (t === S.tab) { setSheet("peek"); return; }
      }
      openTab(t);
    });
    el(".dash-tabs", P).addEventListener("keydown", ev => {   // arrow keys move between tabs
      if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight" && ev.key !== "ArrowUp" && ev.key !== "ArrowDown") return;
      if (!ev.target.closest(".dash-tab")) return;
      const i = TABS.indexOf(S.tab), d = ev.key === "ArrowLeft" || ev.key === "ArrowUp" ? -1 : 1;
      const t = TABS[(i + d + TABS.length) % TABS.length];
      openTab(t);
      S.tabBtn[t].focus();
      ev.preventDefault();
      ev.stopPropagation();   // PLAN 3.12: the view owns arrows; this one was used here, so it must not pan the map
    });
    S.sheetTicker.addEventListener("click", () => { if (S.tickerEvent) focusEvent(S.tickerEvent); });
    listen(P, "transitionend", ev => { if (ev.target === P) layoutSoon(); });
    // Every "Full page" link (the person, a ranking row, an LLM row): a plain click opens the character page in
    // this tab, and this view lets go of God as it unloads, so leave that page a one-shot note to skip its takeover
    // question. A new tab (a modified or middle click) gets no note and asks first.
    listen(P, "click", ev => {
      if (!ev.target.closest || !ev.target.closest("a.dash-fullpage")) return;
      if (S.role === "god" && ev.button === 0 && !(ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey)) {
        try { sessionStorage.setItem("goal.character.from-city", String(Date.now())); } catch (e) { /* private mode */ }
      }
    });
    buildGrip(el(".dash-grip", P));
    buildCity();
    buildNews();
    buildLlm();
    buildPeople();
    setCollapsed(S.collapsed, true);
    showTab();
  }

  // The desktop rail and the phone sheet's peek both hide the tab bodies; a hidden tab costs nothing.
  const railed = () => S.collapsed && S.mode !== "sheet";
  function tabVisible(t) {
    return !!S && S.tab === t && !railed() && !(S.mode === "sheet" && S.sheet === "peek");
  }
  function showTab() {
    for (const t of TABS) {
      const on = t === S.tab;
      S.tabBtn[t].setAttribute("aria-selected", String(on));
      S.tabBtn[t].tabIndex = on ? 0 : -1;
      S.bodies[t].hidden = !on;
    }
  }
  function openTab(name, opts) {
    const o = opts || {};
    if (!S || !TABS.includes(name)) return;
    S.tab = name;
    if (railed()) setCollapsed(false);
    if (S.mode === "sheet" && S.sheet === "peek") setSheet("half");
    showTab();
    if (name === "news") markNewsRead();
    S.dirty[name] = true;
    renderTab(name);
    if (o.section) {
      const sec = el(`[data-sec="${o.section}"]`, S.bodies[name]);
      if (sec) sec.scrollIntoView({ block: "start", behavior: reducedMotion() ? "auto" : "smooth" });
    }
    layoutSoon();
  }
  function setCollapsed(c, quiet) {
    S.collapsed = !!c;
    if (!S.panel) return;
    S.panel.classList.toggle("collapsed", S.collapsed && S.mode !== "sheet");
    const b = el(".dash-collapse", S.panel);
    if (b) {
      b.textContent = S.collapsed ? "«" : "»";
      b.setAttribute("aria-label", S.collapsed ? "Show the panel" : "Hide the panel");
      b.title = `${S.collapsed ? "Show" : "Hide"} the panel (\\)`;
    }
    if (!quiet) { storage.set("goal.dash.collapsed", S.collapsed ? "1" : "0"); renderTab(S.tab); }
    layoutSoon();
  }
  function togglePanel() {
    if (S.mode === "sheet") setSheet(S.sheet === "peek" ? "half" : "peek");
    else setCollapsed(!S.collapsed);
  }
  function setSheet(h) {
    S.sheet = h;
    if (!S.panel) return;
    S.panel.dataset.sheet = h;
    S.panel.style.height = "";
    if (h !== "peek") renderTab(S.tab);
    layoutSoon();
    setTimeout(layoutSoon, 260);
  }
  function sheetHeights() {
    const vh = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
    return { peek: 92, half: round(vh * (S.phone ? 0.55 : 0.45)), full: round(vh - 64) };
  }
  // The one way the dashboard moves the camera (dashboard.md 8.2: the target lands in the visible part of the
  // map). The view centres its camera in the part of the map its inset leaves free, so the focus goes out with the
  // inset the view already has. A full phone sheet leaves no map to see: a "Show on map" (show: true) drops it to
  // half and gives the view the half sheet's inset first, without waiting for layout() to measure the sheet once
  // it has moved (a focus against the full sheet's inset would land the target that much lower, behind the sheet).
  function focusMap(target, opts) {
    if (!S || !target) return;
    if (S.mode === "sheet" && S.sheet === "full" && opts && opts.show) {
      setSheet("half");
      const vh = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
      const wr = S.world ? S.world.getBoundingClientRect() : { bottom: vh };
      const bottom = Math.max(0, round(wr.bottom - (vh - sheetHeights().half)));
      if (bottom !== S.inset.bottom) {
        S.inset = Object.assign({}, S.inset, { bottom });
        callView("setInset", S.inset);
      }
    }
    callView("focus", target, { inset: S.inset });
  }
  function buildGrip(grip) {
    grip.addEventListener("pointerdown", ev => {
      if (S.mode !== "sheet") return;
      const startY = ev.clientY, startH = S.panel.getBoundingClientRect().height, H = sheetHeights();
      let moved = false;
      try { grip.setPointerCapture(ev.pointerId); } catch (e) { /* old browsers */ }
      const move = e => {
        const dy = startY - e.clientY;
        if (Math.abs(dy) > 4) moved = true;
        if (!moved) return;
        S.panel.classList.add("dragging");
        S.panel.style.height = `${clamp(startH + dy, H.peek, H.full)}px`;
      };
      const up = e => {
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", up);
        grip.removeEventListener("pointercancel", up);
        S.panel.classList.remove("dragging");
        if (!moved) { setSheet(S.sheet === "peek" ? "half" : S.sheet === "half" ? "full" : "peek"); return; }
        const h = clamp(startH + startY - e.clientY, H.peek, H.full);
        const best = ["peek", "half", "full"].reduce((b, k) => (Math.abs(H[k] - h) < Math.abs(H[b] - h) ? k : b), "peek");
        setSheet(best);
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", up);
      grip.addEventListener("pointercancel", up);
      ev.preventDefault();
    });
    grip.addEventListener("click", ev => {
      // Enter or Space on the focused grip (a pointer tap is handled on pointerup above).
      if (ev.detail === 0 && S.mode === "sheet") setSheet(S.sheet === "peek" ? "half" : S.sheet === "half" ? "full" : "peek");
    });
    grip.addEventListener("keydown", ev => {
      if (ev.key !== "ArrowUp" && ev.key !== "ArrowDown") return;
      if (S.mode !== "sheet") return;
      if (ev.key === "ArrowUp") setSheet(S.sheet === "peek" ? "half" : "full");
      else setSheet(S.sheet === "full" ? "half" : "peek");
      ev.preventDefault();
      ev.stopPropagation();   // the arrow resized the sheet; the view must not also pan the map
    });
  }
  function updateMode() {
    if (!S) return;
    const mq = q => !!(window.matchMedia && window.matchMedia(q).matches);
    const mode = mq("(max-width: 900px)") ? "sheet" : "desktop", phone = mq("(max-width: 520px)");
    const changed = mode !== S.mode || phone !== S.phone;
    S.mode = mode;
    S.phone = phone;
    if (S.panel) {
      S.panel.classList.toggle("sheet", mode === "sheet");
      S.panel.classList.toggle("phone", phone);
      S.panel.dataset.sheet = S.sheet;
      if (mode !== "sheet") S.panel.style.height = "";
    }
    setCollapsed(S.collapsed, true);
    if (changed) {
      trimToasts();
      S.dirty.city = S.dirty.people = S.dirty.hud = true;
      renderTab(S.tab);
      renderHud();
    }
    layoutSoon();
  }

  // The view keeps its own controls and focus targets clear of the dashboard's: top is the lowest edge of
  // the HUD, the map colours and the toasts; bottom is how far the phone sheet covers the map.
  function layoutSoon() {
    if (!S || S.layoutQueued) return;
    S.layoutQueued = true;
    requestAnimationFrame(layout);
  }
  function layout() {
    if (!S) return;
    S.layoutQueued = false;
    if (!S.world) return;
    const wr = S.world.getBoundingClientRect();
    if (S.toastBox && S.hud) {
      // Toasts sit under the HUD, and under the map colours too when the two would overlap.
      const hr = S.hud.getBoundingClientRect();
      let below = hr.height > 0 ? hr.bottom - wr.top + 8 : 8;
      const tw = S.toastBox.getBoundingClientRect().width, tl = wr.left + (wr.width - tw) / 2;
      const cr = S.chips && S.chips.children.length ? S.chips.getBoundingClientRect() : null;
      if (cr && cr.height > 0 && cr.left < tl + tw && cr.right > tl) below = Math.max(below, cr.bottom - wr.top + 8);
      S.toastBox.style.top = `${round(below)}px`;
    }
    let top = 0;
    for (const e of [S.hud, S.chips, S.toastBox]) {
      if (!e || e.hidden || !e.children.length) continue;
      const r = e.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) top = Math.max(top, r.bottom - wr.top);
    }
    top = top > 0 ? round(top + 8) : 0;
    let bottom = 0;
    if (S.mode === "sheet" && S.panel) bottom = Math.max(0, round(wr.bottom - S.panel.getBoundingClientRect().top));
    const inset = { top, right: 0, bottom };
    if (inset.top !== S.inset.top || inset.bottom !== S.inset.bottom || inset.right !== S.inset.right) {
      S.inset = inset;
      callView("setInset", inset);
    }
  }

  function onKey(ev) {
    if (!S || ev.defaultPrevented || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const t = ev.target, tag = t && t.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || (t && t.isContentEditable)) return;
    if (ev.key >= "1" && ev.key <= "4") { openTab(TABS[Number(ev.key) - 1]); ev.preventDefault(); }
    else if (ev.key === "\\") { togglePanel(); ev.preventDefault(); }
    else if (ev.key === "/") {
      const box = S.bodies[S.tab === "city" ? "people" : S.tab];
      if (S.tab === "city") openTab("people");
      const f = S.tab === "llm" ? el(".dash-llm-agent", box) : el(".dash-search", box);
      if (f) { if (S.tab === "people" && (S.selected || S.card)) { S.card = null; back(); } f.focus(); ev.preventDefault(); }
    }
  }

  // --- HUD, ticker, toasts -----------------------------------------------------------------------------

  function buildHud() {
    if (S.hud) {
      S.hud.classList.add("dash-hud");
      S.hud.setAttribute("aria-label", "City at a glance");
      listen(S.hud, "click", ev => {
        const b = ev.target.closest("[data-k]");
        if (!b) return;
        const go = { people: ["people"], mood: ["city", "needs"], wealth: ["people"], homes: ["city", "homes"],
          neglect: ["city", "homes"], ai: ["llm"] }[b.dataset.k];
        if (b.dataset.k === "neglect") setOverlay("condition");
        if (go) openTab(go[0], { section: go[1] });
      });
    }
    if (S.chips) {
      S.chips.classList.add("dash-chips-map");
      listen(S.chips, "click", onOverlayClick);
    }
    if (S.toastBox) {
      listen(S.toastBox, "click", ev => {
        const card = ev.target.closest(".dash-toast");
        if (!card) return;
        const t = S.toasts.find(x => x.el === card);
        if (!t) return;
        const act = ev.target.closest("[data-act]");
        if (act && act.dataset.act === "show" && t.event) focusEvent(t.event);
        if (act && act.dataset.act === "news") openTab("news");
        if (act || ev.target.closest(".dash-tx")) removeToast(t);
      });
      listen(S.toastBox, "mouseover", ev => { const t = toastOf(ev.target); if (t) t.hold = true; });
      listen(S.toastBox, "mouseout", ev => {
        const t = toastOf(ev.target);
        if (t && !t.el.contains(ev.relatedTarget)) { t.hold = false; t.until = Math.max(t.until, Date.now() + 3000); }
      });
    }
    if (S.ticker) {
      S.ticker.classList.add("dash-ticker");
      listen(S.ticker, "click", () => { if (S.tickerEvent) focusEvent(S.tickerEvent); });
    }
  }
  const toastOf = target => { const c = target && target.closest && target.closest(".dash-toast"); return c ? S.toasts.find(x => x.el === c) : null; };

  function renderHud() {
    if (!S || !S.hud) return;
    S.dirty.hud = false;
    S.at.hud = performance.now();
    const st = S.stats, c = st && st.city;
    if (!S.state) { setHtml(S.hud, ""); return; }
    const alive = S.state.agents.filter(a => a.alive).length;
    const chips = [];
    chips.push(["people", `<b>${alive}</b> people`, "Population: open People"]);
    if (c) {
      const d = moodDelta();
      // dashboard.md 8.2: the phone chip keeps the arrow ("Mood 64▲") and drops only the number
      const arrow = d > 0 ? "▲" : d < 0 ? "▼" : "", num = d === 0 ? "±0" : String(Math.abs(d));
      chips.push(["mood", `Mood <b>${c.mood}</b>${d != null ? `<span class="dash-md ${dirClass(d)}">${arrow}<span class="dash-long">${num}</span></span>` : ""}`,
        d != null ? `Mood ${c.mood}, ${d >= 0 ? "up" : "down"} ${Math.abs(d)} in 24 h` : `Mood ${c.mood}`]);
      chips.push(["wealth", `<b>${compact(c.wealth.total)}</b>`, `Total wealth ${money(c.wealth.total)}: open the ranking`]);
      if (c.homes) {
        chips.push(["homes", `${c.homes.for_sale} for sale · ${c.homes.for_rent} to let`, "Homes on the market"]);
        const ng = (c.homes.lots_by_stage[3] || 0) + (c.homes.lots_by_stage[4] || 0);
        chips.push(["neglect", `<span class="${ng ? "warn" : ""}">${ng} neglected</span>`, "Buildings at stage neglected or derelict: show condition on the map"]);
      }
    }
    S.hudThink = { n: S.thinking, by: S.thinkingBy };
    chips.push(aiChip());
    const html = chips.map(([k, h, title, cls]) =>
      `<button type="button" class="dash-chip${cls ? " " + cls : ""}" data-k="${k}" title="${esc(title)}">${h}</button>`).join("");
    if (setHtml(S.hud, html)) layoutSoon();
    // The controllers' lines count thinking from the same frame as the chip, so they are redrawn with it (the
    // rest of the City tab waits for the stats push).
    if (tabVisible("city")) renderCityAi();
    if (tabVisible("llm") && S.llmList && S.host.kind !== "browser") setHtml(el(".dash-aistrip", S.bodies.llm), aiStripHtml());
  }
  function aiChip() {
    if (S.host.kind === "browser") return ["ai", "AI off", "The browser version has no AI players", "muted"];
    const L = S.stats && S.stats.llm, T = L && L.today;
    if (isSlow(T)) {
      const pct = pctOf(T.timeouts, T.asked);
      return ["ai", `AI <b>slow</b><span class="dash-long">: ${pct}% timed out today</span>`, `slow: ${pct}% timed out today (${T.timeouts} of ${T.asked} asks)`, "amber"];
    }
    if (!S.playing) return ["ai", "AI: nobody<span class=\"dash-long\"> playing</span>", "No AI model is playing anyone", "muted"];
    // Desktop "AI: 60 playing, 3 thinking"; a phone "AI 60" and a pulsing dot with the count while anyone thinks.
    const n = S.hudThink.n;
    const think = n ? `<span class="dash-long">, <b>${n}</b> thinking</span><span class="dash-short"> <i class="dash-thinkdot"></i>${n}</span>` : "";
    return ["ai", `AI<span class="dash-long">:</span> <b>${S.playing}</b><span class="dash-long"> playing</span>${think}`,
      `${S.playing} characters played by an AI model${n ? `, ${n} thinking now` : ""}`];
  }
  // A city number now against 24 game hours ago: the stats push's own value minus the newest hourly sample at
  // least 24 h older than that push. The HUD, the Mood tile and the trend lines all use it, so they agree.
  const LIVE = { mood: c => c.mood, wealth: c => c.wealth.total, pop: c => c.population };
  function liveValue(field) {
    const c = S.stats && S.stats.city;
    return c && LIVE[field] ? LIVE[field](c) : null;
  }
  function vs24h(field) {
    const now = liveValue(field), ss = S.samples;
    if (now == null || !ss.length) return null;
    const want = S.stats.tick - 1440;
    for (let i = ss.length - 1; i >= 0; i--) if (ss[i].tick <= want) return now - ss[i][field];
    return null;
  }
  const moodDelta = () => vs24h("mood");

  function setTicker(e, live) {
    S.tickerEvent = e;
    S.tickerAt = live ? Date.now() : 0;
    renderTicker();
  }
  function renderTicker() {
    const e = S.tickerEvent;
    const html = e ? `<button type="button" class="dash-tick${S.tickerAt ? "" : " dim"} t-${topicOf(e) || "other"}${e.importance >= 2 ? " major" : ""}"
      title="Show on the map"><span class="dash-tdot"></span><span class="dash-ttime">${hm(e.tick)}</span><span class="dash-ttext">${esc(e.text)}</span></button>` : "";
    if (S.ticker) setHtml(S.ticker, html);
    if (S.sheetTicker) setHtml(S.sheetTicker, html);
  }

  // Toasts (dashboard.md 5.4): up to 3 major cards on desktop and 1 on a phone, and below them the one
  // coalesced "N more major events" card for the rest: the first majors of a burst keep their own cards and
  // only the ones after them are counted, so a phone still shows a burst's headline. A major card pushed out
  // early (the window became a phone) is never lost: it joins the coalesced count, so the count is always the
  // burst's majors not on screen. Error and info notices have their own slots (2, or 1 on a phone) and never
  // push out a major or the coalesced card.
  const majorKind = t => t.kind === "major" || t.kind === "more";
  function addToast(t) {
    if (!S.toastBox) return t;
    const card = document.createElement("div");
    card.className = `dash-toast ${t.kind}`;
    card.innerHTML = t.html;
    t.el = card;
    t.until = Date.now() + (majorKind(t) ? TOAST_MS : NOTICE_MS);
    S.toasts.push(t);
    S.toastBox.appendChild(card);
    trimToasts();
    layoutSoon();
    return t;
  }
  function removeToast(t) {
    const i = S.toasts.indexOf(t);
    if (i >= 0) S.toasts.splice(i, 1);
    if (t.el) t.el.remove();
    if (t === S.coalesced) S.coalesced = null;
    layoutSoon();
  }
  function moreToast() {
    if (S.coalesced && S.toasts.includes(S.coalesced)) return S.coalesced;
    const c = { kind: "more", count: 0, html: "" };
    S.coalesced = c;          // set first: adding it trims, and the trim renders the count on it
    addToast(c);
    return c;
  }
  function renderMore(c) {
    if (!c || !c.el) return;
    c.el.innerHTML = `<span class="dash-ticon">${icon("star")}</span><div class="dash-tbody"><div class="dash-ttext">${plural(c.count, "more major event")}</div></div>
        <button type="button" class="dash-tbtn" data-act="news">Open News</button><button type="button" class="dash-tx" aria-label="Dismiss">${icon("close")}</button>`;
  }
  function trimToasts() {
    if (!S) return;
    const maxMajor = S.phone ? 1 : 3, maxNotice = S.phone ? 1 : 2;
    for (let guard = 0; guard < 50; guard++) {
      const majors = S.toasts.filter(t => t.kind === "major"); // the coalesced card has a slot of its own
      if (majors.length <= maxMajor) break;
      removeToast(majors.find(t => !t.hold) || majors[0]);    // the oldest goes first
      moreToast().count += 1;
    }
    for (let guard = 0; guard < 50; guard++) {
      const notes = S.toasts.filter(t => !majorKind(t));
      if (notes.length <= maxNotice) break;
      removeToast(notes[0]);
    }
    if (S.coalesced) renderMore(S.coalesced);
  }
  function majorToast(e) {
    const now = Date.now();
    S.majorTimes = S.majorTimes.filter(t => now - t < 10000);
    S.majorTimes.push(now);
    const shown = S.toasts.filter(t => t.kind === "major").length;
    const more = S.coalesced && S.toasts.includes(S.coalesced);
    // More than 3 within 10 s, a full set of slots, or a "more" card already up: one card counts the rest.
    if (S.majorTimes.length > 3 || more || shown >= (S.phone ? 1 : 3)) {
      const c = moreToast();
      c.count += 1;
      c.until = now + TOAST_MS;
      trimToasts();
      return;
    }
    const names = (e.agents || []).slice(0, 3).map(id => S.agentById[id]).filter(Boolean).map(a => esc(first(a.name)));
    addToast({ kind: "major", event: e, html: `<span class="dash-ticon t-${topicOf(e) || "other"}">${icon(iconOf(e))}</span>
      <div class="dash-tbody"><div class="dash-ttext">${esc(e.text)}</div><div class="dash-tmeta">${hm(e.tick)}${names.length ? " · " + names.join(", ") : ""}</div></div>
      <button type="button" class="dash-tbtn" data-act="show">Show</button>
      <button type="button" class="dash-tx" aria-label="Dismiss">${icon("close")}</button>` });
  }
  function notice(text, kind) {
    if (!S) return;
    const k = kind === "info" ? "info" : "error";
    addToast({ kind: k, html: `<span class="dash-ticon">${icon(k === "error" ? "alert" : "star")}</span>
      <div class="dash-tbody"><div class="dash-ttext">${esc(text)}</div></div>
      <button type="button" class="dash-tx" aria-label="Dismiss">${icon("close")}</button>` });
  }

  // --- stores ------------------------------------------------------------------------------------------

  function setTown(town) {
    S.town = town || { places: [], homes: [], districts: [] };
    S.placeById = {};
    S.homeById = {};
    S.unitsOf = {};
    S.districtName = {};
    S.stopById = {};
    for (const p of S.town.places || []) S.placeById[p.id] = p;
    for (const h of S.town.homes || []) { S.homeById[h.id] = h; (S.unitsOf[h.place] = S.unitsOf[h.place] || []).push(h); }
    for (const d of S.town.districts || []) S.districtName[d.id] = d.name;
    for (const s of S.town.stops || []) S.stopById[s.id] = s;
  }
  function takeState(st) {
    if (!st) return;
    S.state = st;
    if (st.lots) {
      const j = JSON.stringify(st.lots);
      if (j !== S.lotsJson) { S.lotsJson = j; S.lots = st.lots; S.lotsChanged = true; }
    }
    if (st.homes) {
      const j = JSON.stringify(st.homes);
      if (j !== S.homesJson) { S.homesJson = j; S.homes = st.homes; S.homesChanged = true; }
    }
    S.agentById = {};
    let playing = 0, thinking = 0;
    const by = {};   // controller name -> its characters thinking now
    for (const a of st.agents || []) {
      S.agentById[a.id] = a;
      if (a.alive && a.controller) {
        playing += 1;
        if (a.state === "deciding") { thinking += 1; by[a.controller] = (by[a.controller] || 0) + 1; }
      }
    }
    S.playing = playing;
    S.thinking = thinking;
    S.thinkingBy = by;
    if (S.tabBtn) {
      const dot = el(".dash-dot", S.tabBtn.llm);
      if (dot) dot.hidden = thinking === 0;
    }
  }
  function storeEvent(e) {
    if (!e || typeof e.seq !== "number") return false;
    if (S.ev.has(e.seq)) return false;
    S.ev.set(e.seq, e);
    const list = e.importance >= 1 ? S.notable : S.routine;
    if (!list.length || list[list.length - 1].seq < e.seq) list.push(e);
    else {
      let i = list.length;
      while (i > 0 && list[i - 1].seq > e.seq) i--;
      list.splice(i, 0, e);
    }
    const cap = e.importance >= 1 ? KEEP.notable : KEEP.routine;
    while (list.length > cap) S.ev.delete(list.shift().seq);
    if (e.seq > S.maxSeq) S.maxSeq = e.seq;
    return true;
  }
  // Upserts a decided fork by id, newest first. pin: it came in a get_decisions reply, so it is never dropped
  // (and stays pinned when a frame sends it again). The others are dropped oldest first, each kind against its own
  // KEEP slot, so a busy city's habit and profile decisions never push out what a controller decided.
  const forkSlot = f => (isLlmFork(f) ? "llm" : "forks");
  function storeFork(f, pin) {
    if (!f || f.id == null) return false;
    const old = S.forks.get(f.id);
    if (old && !S.forkPinned.has(f.id)) S.forkCount[forkSlot(old)] -= 1;
    if (pin) S.forkPinned.add(f.id);
    if (!S.forkPinned.has(f.id)) S.forkCount[forkSlot(f)] += 1;
    S.forks.set(f.id, f);
    const L = S.forkList;
    if (old) { const i = L.indexOf(old); if (i >= 0) { L[i] = f; return true; } }
    if (!L.length || forkOrder(f, L[0]) <= 0) L.unshift(f);
    else {
      let i = 1;
      while (i < L.length && forkOrder(L[i], f) <= 0) i++;
      L.splice(i, 0, f);
    }
    const C = S.forkCount;
    for (let i = L.length - 1; i >= 0 && (C.forks > KEEP.forks || C.llm > KEEP.llm); i--) {
      const x = L[i], slot = forkSlot(x);
      if (S.forkPinned.has(x.id) || C[slot] <= KEEP[slot]) continue;
      L.splice(i, 1);
      S.forks.delete(x.id);
      C[slot] -= 1;
    }
    return true;
  }
  function takeSamples(samples, full) {
    if (full) S.samples = [];
    const byTick = new Map(S.samples.map(s => [s.tick, s]));
    for (const s of samples || []) byTick.set(s.tick, s);
    S.samples = Array.from(byTick.values()).sort((a, b) => a.tick - b.tick).slice(-KEEP.samples);
  }
  function takeStats(msg) {
    S.stats = msg;
    takeSamples(msg.samples, !!msg.full);
    S.peopleById = {};
    for (const p of msg.people || []) S.peopleById[p.id] = p;
    S.hhById = {};
    S.hhWorth = {};
    for (const h of msg.households || []) S.hhById[h.id] = h;
    for (const p of msg.people || []) if (p.household) S.hhWorth[p.household] = (S.hhWorth[p.household] || 0) + p.worth;
    S.topHousehold = Object.values(S.hhWorth).reduce((m, v) => Math.max(m, v), 0);
    S.dirty.city = S.dirty.people = S.dirty.hud = S.dirty.news = S.dirty.llm = true;
    S.at.city = S.at.people = 0;
    if (S.overlay === "wealth") applyOverlay();
  }

  // --- messages ----------------------------------------------------------------------------------------

  function welcome(msg) {
    if (!S || !msg) return;
    Object.assign(S, freshStores());
    S.role = msg.role || "god";
    S.host = msg.host || { kind: "server", controllers: true };
    S.speed = msg.speed != null ? msg.speed : 1;
    setTown(msg.town);
    takeState(msg.state);
    for (const e of [].concat(msg.history || [], msg.news || [], msg.headlines || [])) storeEvent(e);
    S.seenSeq = S.maxSeq;
    S.unread = 0;
    if (S.notable.length) setTicker(S.notable[S.notable.length - 1], false);
    for (const f of msg.llm_log || []) storeFork(f);
    if (msg.llm_log && msg.llm_log.length) S.forkCursor[""] = msg.llm_log[0].id;   // oldest first
    resetLlmWindow();
    if (msg.stats) takeStats(msg.stats);
    // A reconnect starts the lists again from the welcome, as a fresh page would.
    for (const box of [S.rankList, S.stream, S.llmList]) if (box) box.innerHTML = "";
    S.panel && S.panel.classList.toggle("dash-browser", S.host.kind === "browser");
    if (S.selected && !S.agentById[S.selected]) back();
    else if (S.selected) { S.detailKey = ""; askAgent(); }
    if (S.card) openHome(S.card.id, { keepStack: true });
    setRole(S.role);
    fillAgentSelect();
    S.overlayKey = "";
    applyOverlay();
    renderAll();
  }
  function frame(msg) {
    if (!S || !S.town || !msg) return;
    if (msg.speed != null) S.speed = msg.speed;
    takeState(msg.state);
    let notable = 0, newEvents = 0;
    for (const e of msg.events || []) {
      if (!storeEvent(e)) continue;
      newEvents += 1;
      if (e.importance >= 1) { notable += 1; setTicker(e, true); }
      if (e.importance >= 2) {
        const target = eventTarget(e);
        if (target) callView("ping", target, pingTopic(e));
        majorToast(e);
      }
    }
    if (notable) {
      if (tabVisible("news")) markNewsRead();
      else { S.unread += notable; renderBadge(); }
    }
    if (newEvents) S.dirty.news = true;
    for (const f of msg.forks || []) if (storeFork(f)) S.dirty.llm = true;
    S.dirty.hud = true;
    if (S.ppl.sort === "mood" || S.ppl.sort === "luck") S.dirty.people = true;
    if (S.lotsChanged || S.homesChanged) {
      if (S.overlay === "condition" || S.overlay === "wealth") applyOverlay();
      S.dirty.city = true;
      if (S.card) S.card.stale = true;
      S.lotsChanged = S.homesChanged = false;
    }
    if (S.selected && S.agentById[S.selected] && !S.agentById[S.selected].alive && S.detail && S.detail.alive) S.at.ask = 0;
  }
  function stats(msg) {
    if (!S || !msg) return;
    takeStats(msg);
    renderHud();
    if (tabVisible("city")) renderCity();
    if (tabVisible("people") && !S.selected && !S.card) renderPeople();
  }
  function reply(msg) {
    if (!S || !msg) return false;
    const ctx = msg.req_id != null ? S.pending.get(msg.req_id) : null;
    if (ctx) S.pending.delete(msg.req_id);
    switch (msg.type) {
      case "agent": {
        const a = msg.agent;
        if (!a) return false;
        if (a.id === S.selected) {
          const first = !S.detail;
          S.detail = a;
          if (tabVisible("people") && !S.card) renderPeople();
          if (first) S.dirty.people = true;
        }
        return true;
      }
      case "home": {
        const h = msg.home;
        if (h && S.card && !S.card.block && S.card.id === h.id) {
          S.card.page = h;
          S.card.error = null;
          S.card.stale = false;
          if (tabVisible("people")) renderPeople();
        }
        return true;
      }
      case "decisions": {
        const forks = msg.forks || [], key = msg.agent_id || "";
        for (const f of forks) storeFork(f, true);
        if (forks.length) S.forkCursor[key] = forks[forks.length - 1].id;   // newest first
        // An older page shows at once: the window reaches down to its oldest fork, however many rows the page
        // held above it (live forks keep arriving while the list is open).
        if (ctx && ctx.older && forks.length && (ctx.agent || "") === S.llm.agent) S.llm.floor = forks[forks.length - 1].id;
        S.forkMore[key] = !!msg.more;
        S.llm.loading = false;
        S.dirty.llm = true;
        if (tabVisible("llm")) renderLlm();
        return true;
      }
      case "stats": stats(msg); return true;
      case "luck_set": {
        if (msg.ok === false) {
          const a = S.agentById[msg.agent_id];
          notice(`Not done: luck can't change for ${a ? a.name : "that character"}${a && !a.alive ? " (died)" : ""}.`);
        } else if (S.detail && S.detail.id === msg.agent_id && typeof msg.luck === "number") {
          S.detail.luck = msg.luck;
          if (tabVisible("people")) renderPeople();
        }
        return true;
      }
      case "error": {
        const text = String(msg.error || "something went wrong");
        if (ctx && ctx.what === "home" && S.card && S.card.id === ctx.id) { S.card.error = text; renderPeople(); }
        if (ctx && ctx.what === "decisions") { S.llm.loading = false; S.dirty.llm = true; }
        if (ctx && ctx.what === "agent" && ctx.id === S.selected) {
          if (S.lastAgentError === S.selected) return true;   // the 800 ms poll would repeat it
          S.lastAgentError = S.selected;
        }
        notice(`Not done: ${text}`);
        return true;
      }
      case "demoted":
        setRole("observer");
        notice("Watching only: God moved to another window. Reload to be God here.", "info");
        return true;
      default:
        return false;
    }
  }
  function message(msg) {
    if (!S || !msg) return false;
    if (msg.type === "welcome") { welcome(msg); return true; }
    if (msg.type === "state") { frame(msg); return true; }
    if (msg.type === "stats") { stats(msg); return true; }
    return reply(msg);
  }
  function setRole(role) {
    if (!S) return;
    S.role = role || "god";
    const watching = S.role !== "god";
    if (S.panel) S.panel.classList.toggle("dash-watching", watching);
    S.detailKey = "";
    if (S.detail && tabVisible("people")) renderPeople();
  }

  // --- selection, picking, hover -----------------------------------------------------------------------

  function selectAgent(id, opts) {
    if (!S) return;
    const o = opts || {};
    if (id == null) { back(o); return; }
    if (id !== S.selected) { S.editingProfile = null; S.detail = null; S.detailKey = ""; S.lastAgentError = null; }
    const changed = id !== S.selected;
    S.selected = id;
    S.card = null;
    if (!o.fromView) callView("select", id, { follow: !!o.follow });
    if (o.focus) focusMap({ agent: id });
    openTab("people");
    askAgent();
    renderPeople();
    if (changed && S.onSelectAgent) S.onSelectAgent(id);
  }
  function back(opts) {
    if (!S) return;
    const o = opts || {};
    const had = S.selected;
    S.selected = null;
    S.detail = null;
    S.detailKey = "";
    S.editingProfile = null;
    if (had && !o.fromView) callView("select", null);
    if (S.peopleBox) renderPeople();
    if (had && S.onSelectAgent) S.onSelectAgent(null);
  }
  function viewSelected(id) {
    if (!S) return;
    if (id == null) { if (S.selected) back({ fromView: true }); return; }
    selectAgent(id, { fromView: true });
  }
  function askAgent() {
    if (!S || !S.selected) return;
    S.at.ask = performance.now();
    request({ type: "get_agent", agent_id: S.selected }, { what: "agent", id: S.selected });
  }
  function homeOfPlace(placeId) {
    const units = S.unitsOf[placeId];
    return units && units.length === 1 ? units[0].id : placeId;
  }
  function pick(hit, ev) {
    if (S && (S.tipTouch || (ev && ev.touch))) hideTip();
    if (!S || !S.state || !hit) return;
    if (hit.kind === "agent") { selectAgent(hit.id, { from: "map" }); return; }
    if (hit.kind === "bus") {
      const r = S.state.agents.find(a => a.alive && a.riding === hit.id);
      if (r) selectAgent(r.id, { from: "map" });
      return;
    }
    if (hit.kind !== "place") return;
    const p = S.placeById[hit.id];
    if (!p) return;
    const inside = S.state.agents.filter(a => a.alive && a.inside === p.id);
    const now = Date.now();
    const again = !!(S.lastPick && S.lastPick.id === p.id && now - S.lastPick.at < 8000);
    S.lastPick = { id: p.id, at: now };
    if (p.kind === "home") {
      if (again || !inside.length) { openHome(p.units > 1 ? p.id : homeOfPlace(p.id), { from: "map" }); return; }
      selectAgent(inside[0].id, { from: "map" });
      return;
    }
    if (inside.length) selectAgent(inside[0].id, { from: "map" });
  }
  // A mouse hover shows the tooltip until the pointer leaves. On touch the view sends onHover(hit, {touch: true})
  // only for a 500 ms long-press (renderer.md 10): the tooltip then sits above the finger until the next tap,
  // the next hover or TIP_TOUCH_MS.
  function hideTip() {
    if (!S) return;
    clearTimeout(S.tipTimer);
    S.tipTouch = false;
    if (S.tooltip) S.tooltip.hidden = true;
  }
  function hover(hit, ev) {
    if (!S || !S.tooltip) return;
    const touch = !!(ev && ev.touch), text = hit ? tooltipText(hit) : "";
    const tip = S.tooltip;
    clearTimeout(S.tipTimer);
    S.tipTouch = false;
    if (!text) { tip.hidden = true; return; }
    tip.textContent = text;
    tip.hidden = false;
    if (touch) { S.tipTouch = true; S.tipTimer = setTimeout(hideTip, TIP_TOUCH_MS); }
    if (!ev || !S.world) return;
    const canvas = S.world.querySelector("canvas");
    const wr = S.world.getBoundingClientRect(), cr = canvas ? canvas.getBoundingClientRect() : wr;
    const ox = cr.left - wr.left, oy = cr.top - wr.top, w = tip.offsetWidth, h = tip.offsetHeight;
    let x, y;
    if (touch) {                 // above the finger, which would hide it, and inside the map
      x = clamp(ox + ev.cssX - w / 2, 4, Math.max(4, wr.width - w - 4));
      y = oy + ev.cssY - h - 28;
      if (y < 4) y = Math.min(oy + ev.cssY + 28, Math.max(4, wr.height - h - 4));
    } else {
      x = ox + ev.cssX + 14;
      y = oy + ev.cssY + 16;
      if (x + w > wr.width - 4) x = Math.max(4, ox + ev.cssX - w - 10);
      if (y + h > wr.height - 4) y = Math.max(4, oy + ev.cssY - h - 10);
    }
    tip.style.left = `${round(x)}px`;
    tip.style.top = `${round(y)}px`;
  }
  function tooltipText(hit) {
    if (!S || !S.state || !hit) return "";
    if (hit.kind === "agent") {
      const a = S.agentById[hit.id];
      if (!a) return "";
      if (!a.alive) return `${a.name} · died`;
      return `${a.name}, ${a.age} · ${a.state === "deciding" ? "deciding…" : pretty(a.activity)}${a.riding ? " · on the bus" : ""}`;
    }
    if (hit.kind === "bus") {
      const b = (S.state.buses || []).find(x => x.id === hit.id);
      if (!b) return "";
      const stop = b.at_stop && S.stopById[b.at_stop];
      return `Bus No. ${b.line} · ${plural(b.riders || 0, "rider")}${stop ? " · at " + stop.name : ""}`;
    }
    if (hit.kind === "stop") {
      const s = S.stopById[hit.id];
      return s ? `${s.name} stop · lines ${(s.lines || []).join(", ")}` : "";
    }
    if (hit.kind !== "place") return "";
    const p = S.placeById[hit.id];
    if (!p) return "";
    const inside = S.state.agents.filter(a => a.alive && a.inside === p.id).map(a => first(a.name));
    const who = inside.length ? ` · ${inside.slice(0, 5).join(", ")}${inside.length > 5 ? ` +${inside.length - 5}` : ""}` : "";
    if (p.kind === "home") {
      const lot = S.lots[p.id], stage = lot ? ` · ${STAGE_NAME[stageOf(lot)]} ${round(lot.condition)}` : "";
      const units = S.unitsOf[p.id] || [];
      if (p.units > 1) {
        const lived = units.filter(h => S.homes[h.id] && S.homes[h.id].hh).length;
        return `${p.name} · ${lived} of ${units.length} flats lived in${stage}${who}`;
      }
      const h = units[0];
      return `${p.name}${h ? " · " + homeLine(h.id) : ""}${stage}${who}`;
    }
    const hours = p.hours ? `${p.hours[0]}:00–${p.hours[1]}:00` : "always open";
    return `${p.name} (${hours})${who}`;
  }
  function hhName(id) {
    const h = S.hhById[id];
    return h ? h.name : id ? pretty(id).replace(/^\w/, c => c.toUpperCase()) : "";
  }
  function homeLine(homeId) {
    const st = S.homes[homeId] || {};
    if (st.hh) return `${hhName(st.hh)} (${st.owner === st.hh ? "own" : "rent"})`;
    if (st.listing === "for_sale") return `for sale ${money(st.price)}`;
    if (st.listing === "for_rent") return `to let ${money(st.price)}/week`;
    return "empty";
  }
  const placeName = id => (S.placeById[id] ? S.placeById[id].name : S.homeById[id] ? S.homeById[id].name : pretty(id));
  const districtName = id => S.districtName[id] || pretty(id);
  const tierLabel = t => (S.town && S.town.housing && S.town.housing.tiers && S.town.housing.tiers[t] ? S.town.housing.tiers[t].label : TIER_LABEL[t] || pretty(t));
  const landlordName = () => (S.town && S.town.housing && S.town.housing.landlord) || "the landlord";
  function characterHref(id) {
    if (!S || S.host.kind === "browser" || id == null) return null;
    return `${S.characterPage}?id=${encodeURIComponent(id)}`;
  }

  function eventTarget(e) {
    if (e.place) return { place: e.place };
    if (e.at) return { tile: e.at };
    if (e.agent) return { agent: e.agent };
    return null;
  }
  function focusEvent(e) {
    const t = eventTarget(e);
    if (t) focusMap(t, { show: true });
    highlightFor(e.agents || (e.agent ? [e.agent] : []), e.place ? [e.place] : [], 4000);
  }
  function highlightFor(agents, places, ms) {
    clearTimeout(S.hlTimer);
    callView("highlight", agents.length || places.length ? { agents, places } : null);
    if (ms) S.hlTimer = setTimeout(() => callView("highlight", null), ms);
  }
  function homePlaceOf(agentId) {
    const a = S.agentById[agentId], h = a && S.homeById[a.home];
    return h ? h.place : null;
  }

  // --- map colours -------------------------------------------------------------------------------------

  function overlayColors(name) {
    const out = {};
    if (!name || !S.town) return out;
    if (name === "condition") {
      for (const [place, lot] of Object.entries(S.lots)) out[place] = STAGE_COLOR[stageOf(lot)];
      return out;
    }
    const vals = {};
    if (name === "wealth") {
      const top = S.topHousehold;
      for (const h of S.town.homes || []) {
        const st = S.homes[h.id];
        if (!st || !st.hh || S.hhWorth[st.hh] == null) continue;
        (vals[h.place] = vals[h.place] || []).push(top > 0 ? clamp(S.hhWorth[st.hh] / top, 0, 1) : 0);
      }
    } else if (name === "mood" && S.state) {
      const moods = {};
      for (const a of S.state.agents) if (a.alive && a.home) (moods[a.home] = moods[a.home] || []).push(a.mood);
      for (const h of S.town.homes || []) if (moods[h.id]) (vals[h.place] = vals[h.place] || []).push(mean(moods[h.id]) / 100);
    }
    const color = name === "wealth" ? wealthColor : moodColor;
    for (const [place, vs] of Object.entries(vals)) out[place] = color(mean(vs));   // a block: the mean of its lived-in flats
    return out;
  }
  function applyOverlay() {
    if (!S) return;
    const colors = overlayColors(S.overlay);
    const key = `${S.overlay}|${JSON.stringify(colors)}`;
    if (key !== S.overlayKey) {
      S.overlayKey = key;
      callView("setOverlay", S.overlay, S.overlay ? colors : {});
    }
    renderOverlayChips();
    if (S.citySec && S.citySec.map) setHtml(S.citySec.map, mapSectionHtml());
  }
  function setOverlay(name) {
    if (!S) return;
    S.overlay = name || null;
    S.overlayKey = "";
    S.at.mood = performance.now();
    applyOverlay();
  }
  function onOverlayClick(ev) {
    const b = ev.target.closest("[data-overlay]");
    if (b) setOverlay(b.dataset.overlay || null);
  }
  function overlaySwitchHtml() {
    return `<div class="dash-ovl" role="radiogroup" aria-label="Map colours"><span class="dash-ovl-label">Map</span>${OVERLAYS.map(([k, l]) =>
      `<button type="button" role="radio" aria-checked="${(S.overlay || "") === k}" data-overlay="${k}">${l}</button>`).join("")}</div>`;
  }
  function legendHtml(name) {
    if (name === "wealth") {
      return `<div class="dash-ramp">${WEALTH_RAMP.map(c => `<i style="background:${c}"></i>`).join("")}</div>
        <div class="dash-ramp-labels"><span>poorer</span><span>richest household ${compact(S.topHousehold)}</span></div>
        <div class="dash-legend-note">Household net worth. Empty homes stay plain; a block shows its lived-in flats.</div>`;
    }
    if (name === "mood") {
      return `<div class="dash-ramp grad" style="background:linear-gradient(90deg,${MOOD_STOPS.join(",")})"></div>
        <div class="dash-ramp-labels"><span>0 unhappy</span><span>50</span><span>100 happy</span></div>
        <div class="dash-legend-note">The mean mood of the people who live there.</div>`;
    }
    if (name === "condition") {
      const counts = [0, 0, 0, 0, 0];
      for (const lot of Object.values(S.lots)) counts[stageOf(lot)] += 1;
      return `<div class="dash-swatches">${STAGE_NAME.map((n, i) => `<span><i style="background:${STAGE_COLOR[i]}"></i>${n} ${counts[i]}</span>`).join("")}</div>
        <div class="dash-legend-note">Each residential building, blocks included.</div>`;
    }
    return "";
  }
  function renderOverlayChips() {
    if (!S.chips) return;
    const html = `${overlaySwitchHtml()}${S.overlay ? `<div class="dash-ovl-legend">${legendHtml(S.overlay)}</div>` : ""}`;
    if (setHtml(S.chips, html)) layoutSoon();
  }

  // --- rendering, scheduling ---------------------------------------------------------------------------

  function renderAll() {
    if (!S) return;
    renderHud();
    renderTicker();
    renderBadge();
    renderOverlayChips();
    for (const t of TABS) S.dirty[t] = true;
    renderTab(S.tab);
    layoutSoon();
  }
  function renderTab(t) {
    if (!S || !tabVisible(t)) return;
    if (t === "city") renderCity();
    else if (t === "news") renderNews();
    else if (t === "llm") renderLlm();
    else renderPeople();
  }
  function pulse() {
    if (!S || !S.town) return;
    const now = performance.now(), wall = Date.now();
    if (S.dirty.hud && now - S.at.hud >= 1000) renderHud();
    const t = S.tab;
    if (tabVisible(t)) {
      if (t === "city" && S.dirty.city && now - S.at.city >= 1000) renderCity();
      else if (t === "news" && S.dirty.news && now - S.at.news >= 300) renderNews();
      else if (t === "llm" && S.dirty.llm && now - S.at.llm >= 300) renderLlm();
      else if (t === "people" && !S.selected && !S.card && S.dirty.people && now - S.at.people >= 1000) renderPeople();
    }
    if (S.selected && tabVisible("people") && !S.card && now - S.at.ask >= POLL_MS && document.visibilityState !== "hidden") askAgent();
    if (S.card && S.card.stale && !S.card.block && tabVisible("people") && now - S.cardAsk >= 1500) {
      S.cardAsk = now;
      S.card.stale = false;
      request({ type: "get_home", home_id: S.card.id }, { what: "home", id: S.card.id });
    } else if (S.card && S.card.stale && S.card.block && tabVisible("people")) { S.card.stale = false; renderPeople(); }
    if (S.overlay === "mood" && now - S.at.mood >= 2000) { S.at.mood = now; applyOverlay(); }
    for (const x of S.toasts.slice()) if (!x.hold && wall > x.until) removeToast(x);
    if (S.tickerAt && wall - S.tickerAt > TICKER_DIM_MS) { S.tickerAt = 0; renderTicker(); }
  }
  function renderBadge() {
    if (!S.tabBtn) return;
    const b = el(".dash-badge", S.tabBtn.news);
    if (!b) return;
    b.hidden = !S.unread;
    b.textContent = S.unread > 9 ? "9+" : String(S.unread);
    S.tabBtn.news.setAttribute("aria-label", S.unread ? `News, ${S.unread > 9 ? "more than 9" : S.unread} unread` : "News");
  }
  function markNewsRead() {
    S.seenSeq = S.maxSeq;
    S.unread = 0;
    renderBadge();
  }

  // --- City tab ----------------------------------------------------------------------------------------

  const CITY_SECTIONS = ["overview", "needs", "wealth", "homes", "districts", "ai", "trends", "map"];
  function buildCity() {
    const box = S.bodies.city;
    S.citySec = {};
    for (const sec of CITY_SECTIONS) {
      const d = document.createElement("div");
      d.className = `dash-sec dash-sec-${sec}`;
      d.dataset.sec = sec;
      box.appendChild(d);
      S.citySec[sec] = d;
    }
    box.addEventListener("click", ev => {
      const t = ev.target;
      const ov = t.closest("[data-overlay]");
      if (ov) { setOverlay(ov.dataset.overlay || null); return; }
      const go = t.closest("[data-go]");
      if (go) { const [tab, sec] = go.dataset.go.split(":"); openTab(tab, { section: sec }); return; }
      const who = t.closest("[data-agent]");
      if (who) { selectAgent(who.dataset.agent, { focus: true, follow: true }); return; }
      const home = t.closest("[data-home]");
      if (home) { openHome(home.dataset.home, { focus: true }); return; }
      const dist = t.closest("[data-district]");
      if (dist) { focusMap({ district: dist.dataset.district }, { show: true }); return; }
    });
    box.addEventListener("mouseover", ev => {
      const h = ev.target.closest("[data-home]");
      if (h) { const spec = S.homeById[h.dataset.home]; highlightFor([], [spec ? spec.place : h.dataset.home]); }
    });
    box.addEventListener("mouseout", ev => {
      const h = ev.target.closest("[data-home]");
      if (h && !h.contains(ev.relatedTarget)) highlightFor([], []);
    });
    box.addEventListener("pointermove", ev => sparkHover(ev));
    box.addEventListener("pointerleave", () => sparkHover(null));
  }
  function renderCity() {
    if (!S.citySec) return;
    S.dirty.city = false;
    S.at.city = performance.now();
    const st = S.stats;
    if (!st || !S.state) {
      setHtml(S.citySec.overview, '<div class="dash-empty">Waiting for the city…</div>');
      return;
    }
    setHtml(S.citySec.overview, overviewHtml());
    setHtml(S.citySec.needs, needsHtml());
    setHtml(S.citySec.wealth, wealthHtml());
    setHtml(S.citySec.homes, homesHtml());
    setHtml(S.citySec.districts, districtsHtml());
    renderCityAi();
    setHtml(S.citySec.trends, trendsHtml());
    setHtml(S.citySec.map, mapSectionHtml());
  }
  function kpi(label, num, sub, go, cls) {
    return `<button type="button" class="dash-kpi${cls ? " " + cls : ""}" data-go="${go}"><span class="dash-kpi-label">${label}</span>
      <span class="dash-kpi-num">${num}</span><span class="dash-kpi-sub">${sub}</span></button>`;
  }
  function overviewHtml() {
    const c = S.stats.city, L = S.stats.llm;
    const d = moodDelta();
    const tiles = [];
    const born = c.births ? ` · ${c.births} born` : "";
    tiles.push(kpi("Population", c.population, `${c.deaths ? plural(c.deaths, "death") : "no deaths"}${born} · health ${c.health}`, "people"));
    tiles.push(kpi("Mood", c.mood, d != null ? `<span class="${dirClass(d)}">${deltaNum(d)}</span> in 24 h` : "the mean of everyone's needs", "city:needs"));
    tiles.push(kpi("Wealth", compact(c.wealth.total), `top 10% hold ${c.wealth.top10_share}%`, "people"));
    if (c.homes) {
      const ng = (c.homes.lots_by_stage[3] || 0) + (c.homes.lots_by_stage[4] || 0);
      tiles.push(kpi("Homes", `${c.homes.owned}<small>owned</small>`, `${c.homes.for_sale} for sale · ${c.homes.for_rent} to let · ${ng} neglected`, "city:homes"));
    } else tiles.push(kpi("Homes", "–", "no housing data yet", "city:homes"));
    tiles.push(kpi("Jobs", `${c.working}<small>working</small>`, `${c.students} at school · ${c.retired} retired · ${c.out_of_work} out of work`, "people"));
    if (S.host.kind === "browser") tiles.push(kpi("AI", "Off", "habit and profiles only", "llm", "muted"));
    else {
      const T = L && L.today;
      const pctIn = T ? pctOf(T.in_time, T.asked) : null;
      const slow = isSlow(T);
      tiles.push(kpi("AI", `${L ? L.playing : 0}<small>playing</small>`, slow ? `slow: ${pctOf(T.timeouts, T.asked)}% timed out today`
        : pctIn != null ? `${pctIn}% answered in time today` : "nothing asked yet today", "llm", slow ? "amber" : ""));
    }
    return `<div class="dash-kpis">${tiles.join("")}</div>`;
  }
  function needsHtml() {
    const n = S.stats.city.needs || {};
    return `<h3>Needs</h3><div class="dash-needs">${Object.keys(NEED_COLOR).map(k => `
      <div class="dash-need"><span>${k}</span><span class="dash-track"><span class="dash-fill" style="width:${clamp(n[k] || 0, 0, 100)}%;background:${NEED_COLOR[k]}"></span></span><b>${n[k] ?? "–"}</b></div>`).join("")}</div>`;
  }
  function wealthHtml() {
    const w = S.stats.city.wealth;
    const top = (S.stats.people || []).filter(p => { const a = S.agentById[p.id]; return !a || a.age >= 18; }).slice(0, 5);
    const max = Math.max(1, top.length ? top[0].worth : 1);
    const rows = top.map((p, i) => {
      const a = S.agentById[p.id] || { name: p.id };
      return `<li><button type="button" data-agent="${esc(p.id)}"><span class="dash-rk m${i + 1}">${i + 1}</span><span class="dash-sw" style="background:${shirt(p.id)}"></span>
        <span class="dash-nm">${esc(a.name)}</span>${barHtml({ cash: p.cash, savings: p.savings, homeEq: p.home_equity, worth: p.worth }, max)}<span class="dash-worth">${money(p.worth)}</span></button></li>`;
    }).join("");
    return `<h3>Wealth</h3>
      <div class="dash-facts"><span>Median <b>${money(w.median)}</b></span><span><b>${w.in_debt}</b> in debt</span><span>Top 10% hold <b>${w.top10_share}%</b></span><span>Gini <b>${Number(w.gini).toFixed(2)}</b></span></div>
      ${segLegend()}
      <ol class="dash-top5">${rows}</ol>
      <button type="button" class="dash-btn" data-go="people">The full ranking</button>`;
  }
  function segLegend() {
    return `<div class="dash-seglegend" aria-label="Bar colours"><span><i class="c"></i>cash</span><span><i class="s"></i>savings</span><span><i class="h"></i>home</span><span><i class="d"></i>debt</span></div>`;
  }
  function stageChip(stage, condition) {
    return `<span class="dash-stage s${stage}"><i></i>${STAGE_NAME[stage] || "?"}${condition != null ? ` ${round(condition)}` : ""}</span>`;
  }
  function homesHtml() {
    const h = S.stats.city.homes;
    if (!h) return "<h3>Homes</h3><div class=\"dash-empty\">No housing data yet.</div>";
    const lots = Object.entries(S.lots);
    const counts = [0, 0, 0, 0, 0];
    for (const [, lot] of lots) counts[stageOf(lot)] += 1;
    const total = counts.reduce((a, b) => a + b, 0) || 1;
    const bar = `<div class="dash-stagebar" role="img" aria-label="${STAGE_NAME.map((n, i) => `${counts[i]} ${n}`).join(", ")}">${counts.map((n, i) =>
      n ? `<i style="flex-grow:${n};background:${STAGE_COLOR[i]}" title="${n} ${STAGE_NAME[i]}"></i>` : "").join("")}</div>
      <div class="dash-swatches">${STAGE_NAME.map((n, i) => `<span><i style="background:${STAGE_COLOR[i]}"></i>${n} <b>${counts[i]}</b></span>`).join("")}</div>`;
    // Needs attention: live emergencies, then buildings at shabby or worse, worst first.
    const attn = [];
    for (const spec of S.town.homes || []) {
      const st = S.homes[spec.id];
      if (st && st.emergency) attn.push({ key: spec.id, home: spec.id, order: -1, html: `${icon("alert", "warn")}<b>${esc(spec.name)}</b><span class="dash-muted">${esc(pretty(st.emergency))} · ${esc(st.hh ? hhName(st.hh) : "empty")}</span>` });
    }
    for (const [place, lot] of lots) {
      const s = stageOf(lot);
      if (s < 2) continue;
      const p = S.placeById[place], units = S.unitsOf[place] || [];
      const lived = units.filter(u => S.homes[u.id] && S.homes[u.id].hh);
      const who = p && p.units > 1 ? `${lived.length} of ${units.length} flats lived in` : lived.length ? hhName(S.homes[lived[0].id].hh) : units[0] ? homeLine(units[0].id) : "";
      attn.push({ key: place, home: p && p.units > 1 ? place : homeOfPlace(place), order: 10 - s + lot.condition / 1000,
        html: `${stageChip(s, lot.condition)}<b>${esc(p ? p.name : place)}</b><span class="dash-muted">${esc(who)}${lot.works ? " · builders in" : ""}${lot.moving ? " · moving" : ""}</span>` });
    }
    attn.sort((a, b) => a.order - b.order);
    const market = [];
    for (const spec of S.town.homes || []) {
      const st = S.homes[spec.id];
      if (!st || !st.listing) continue;
      market.push({ spec, st });
    }
    market.sort((a, b) => cmp(a.st.listing, b.st.listing) || a.st.price - b.st.price);
    return `<h3>Homes</h3>
      <div class="dash-facts"><span><b>${h.owned}</b> owned</span><span><b>${h.rented}</b> rented</span><span><b>${h.for_sale}</b> for sale</span><span><b>${h.for_rent}</b> to let</span>${h.neglected_lived_in ? `<span class="warn"><b>${h.neglected_lived_in}</b> neglected and lived in</span>` : ""}</div>
      <div class="dash-subhead">${plural(total, "residential building")}</div>${bar}
      ${attn.length ? `<div class="dash-subhead">Needs attention</div><ul class="dash-homelist">${attn.map(x => `<li><button type="button" data-home="${esc(x.home)}">${x.html}</button></li>`).join("")}</ul>` : ""}
      ${market.length ? `<div class="dash-subhead">On the market</div><ul class="dash-homelist">${market.map(({ spec, st }) => `<li><button type="button" data-home="${esc(spec.id)}">
        <span class="dash-mk ${st.listing}">${st.listing === "for_sale" ? "sale" : "to let"}</span><b>${esc(spec.name)}</b><span class="dash-muted">${esc(tierLabel(spec.tier))} · ${spec.bedrooms} bed</span>
        <span class="dash-price">${st.listing === "for_sale" ? money(st.price) : `${money(st.price)}/wk`}</span></button></li>`).join("")}</ul>` : ""}
      <button type="button" class="dash-btn" data-overlay="condition">Show condition on the map</button>`;
  }
  function districtsHtml() {
    const ds = S.stats.districts || [];
    if (!ds.length) return "";
    if (S.phone) {
      return `<h3>Neighbourhoods</h3><ul class="dash-dlist">${ds.map(d => `<li><button type="button" data-district="${esc(d.id)}"><b>${esc(d.name)}</b>
        <span class="dash-muted">${plural(d.people, "person", "people")} · mood ${d.mood} · median ${compact(d.median_worth)} · ${d.vacant} free · ${d.shabby_plus} shabby+</span></button></li>`).join("")}</ul>`;
    }
    return `<h3>Neighbourhoods</h3><table class="dash-table"><thead><tr><th>District</th><th>People</th><th>Mood</th><th>Median worth</th><th>Free homes</th><th>Shabby+</th></tr></thead>
      <tbody>${ds.map(d => `<tr data-district="${esc(d.id)}" tabindex="0"><td>${esc(d.name)}</td><td>${d.people}</td><td>${d.mood}</td><td>${money(d.median_worth)}</td><td>${d.vacant} of ${d.homes}</td><td>${d.shabby_plus}</td></tr>`).join("")}</tbody></table>`;
  }
  // The City tab's AI players section: the heading and the button stay put while the lines are redrawn.
  function renderCityAi() {
    const sec = S.citySec && S.citySec.ai;
    if (!sec || !S.stats || !S.state) return;
    if (!el(".dash-ai-lines", sec)) {
      setHtml(sec, '<h3>AI players</h3><div class="dash-ai-lines"></div><button type="button" class="dash-btn" data-go="llm">Open the LLM log</button>');
    }
    setHtml(el(".dash-ai-lines", sec), aiStripHtml());
  }
  function aiStripHtml() {
    if (S.host.kind === "browser") return '<div class="dash-ai"><div class="dash-muted">This browser version has no AI players: everyone decides by habit and profile.</div></div>';
    const L = S.stats && S.stats.llm;
    if (!L) return "";
    const T = L.today || {};
    // Each controller's line counts its own characters thinking now (from the frame the HUD chip drew), not the city's.
    const who = (L.controllers || []).length
      ? L.controllers.map(c => { const n = S.hudThink.by[c.name] || 0; return `<div class="dash-ctl" data-controller="${esc(c.name)}"><b>${esc(c.name)}</b> · ${c.model ? esc(c.model) : "no model declared"} · plays ${c.characters}${n ? ` · <b>${n}</b> thinking now` : ""}</div>`; }).join("")
      : '<div class="dash-muted">No AI model is playing anyone right now.</div>';
    const pct = T.asked ? ` (${pctOf(T.in_time, T.asked)}%)` : "";
    const slow = isSlow(T) ? `<div class="dash-slow">${icon("alert")}slow: ${pctOf(T.timeouts, T.asked)}% timed out today</div>` : "";
    return `<div class="dash-ai${isSlow(T) ? " amber" : ""}">${who}${slow}
      <div class="dash-ai-today">Today: asked ${T.asked || 0} · in time ${T.in_time || 0}${pct} · timed out ${T.timeouts || 0} · answered late ${T.late || 0} · against habit ${T.against_habit || 0}${T.avg_seconds != null ? ` · avg ${T.avg_seconds} s` : ""}</div>
      <div class="dash-muted">Nobody asked today: ${L.habit_today || 0} by habit, ${L.default_today || 0} by profile defaults.</div></div>`;
  }
  function trendsHtml() {
    const ss = S.samples;
    if (ss.length < 2) return '<h3>Last 7 days</h3><div class="dash-empty">Collecting: the city records one sample an hour.</div>';
    return `<h3>Last 7 days</h3><div class="dash-sparks">
      ${sparkHtml("mood", "Mood", ss, "mood", v => String(v))}
      ${sparkHtml("wealth", "Wealth", ss, "wealth", compact)}
      ${sparkHtml("pop", "Population", ss, "pop", v => String(v))}</div>`;
  }
  function sparkHtml(key, label, ss, field, fmt) {
    const vals = ss.map(s => s[field]), n = vals.length;
    const lo = Math.min(...vals), hi = Math.max(...vals), iLo = vals.indexOf(lo), iHi = vals.indexOf(hi);
    const pad = hi === lo ? Math.max(1, Math.abs(hi) * 0.05) : (hi - lo) * 0.15, y0 = lo - pad, y1 = hi + pad;
    const W = 300, H = 56, X = i => (n > 1 ? i / (n - 1) : 0) * W, Y = v => H - ((v - y0) / (y1 - y0)) * H;
    const d = vals.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).join("");
    S.sparks[key] = { ticks: ss.map(s => s.tick), vals, y0, y1, fmt, label };
    const pt = (i, v, cls) => `<i class="dash-spark-pt ${cls}" style="left:${(X(i) / W * 100).toFixed(2)}%;top:${(Y(v) / H * 100).toFixed(2)}%"></i>`;
    // The head and the 24 h change are the live numbers (vs24h), as on the HUD; the line is the hourly samples.
    const live = liveValue(field), now = live != null ? live : vals[n - 1], dd = vs24h(field);
    const change = dd == null ? "" : dd !== 0 ? `${dd > 0 ? "▲" : "▼"} ${fmt(Math.abs(dd))} in 24 h` : "same as 24 h ago";
    return `<div class="dash-spark" data-spark="${key}">
      <div class="dash-spark-head"><span class="dash-spark-label">${label}</span><b>${fmt(now)}</b>
        <span class="dash-spark-read">high ${fmt(hi)} · low ${fmt(lo)}</span></div>
      <div class="dash-spark-plot" data-spark="${key}">
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><path d="${d}" vector-effect="non-scaling-stroke"/></svg>
        ${pt(iHi, hi, "hi")}${pt(iLo, lo, "lo")}<i class="dash-spark-x" hidden></i><i class="dash-spark-dot" hidden></i>
      </div>
      <div class="dash-spark-axis"><span>${dayLabel(Math.floor(ss[0].tick / 1440))}</span><span class="dash-spark-chg">${change}</span><span>now</span></div>
    </div>`;
  }
  function sparkHover(ev) {
    const plots = S.bodies.city.querySelectorAll(".dash-spark-plot");
    const plot = ev && ev.target.closest && ev.target.closest(".dash-spark-plot");
    for (const p of plots) {
      if (p === plot) continue;
      const x = el(".dash-spark-x", p), dot = el(".dash-spark-dot", p);
      if (x && !x.hidden) {
        x.hidden = true; dot.hidden = true;
        const D = S.sparks[p.dataset.spark], read = el(".dash-spark-read", p.parentElement);
        if (D && read) read.textContent = `high ${D.fmt(Math.max(...D.vals))} · low ${D.fmt(Math.min(...D.vals))}`;
      }
    }
    if (!plot) return;
    const D = S.sparks[plot.dataset.spark];
    if (!D) return;
    const r = plot.getBoundingClientRect(), n = D.vals.length;
    const i = clamp(round((ev.clientX - r.left) / r.width * (n - 1)), 0, n - 1);
    const fx = n > 1 ? i / (n - 1) : 0, fy = 1 - (D.vals[i] - D.y0) / (D.y1 - D.y0);
    const x = el(".dash-spark-x", plot), dot = el(".dash-spark-dot", plot);
    x.hidden = false; dot.hidden = false;
    x.style.left = `${(fx * 100).toFixed(2)}%`;
    dot.style.left = `${(fx * 100).toFixed(2)}%`;
    dot.style.top = `${(fy * 100).toFixed(2)}%`;
    const read = el(".dash-spark-read", plot.parentElement);
    if (read) read.textContent = `${stamp(D.ticks[i])} · ${D.fmt(D.vals[i])}`;
  }
  function mapSectionHtml() {
    return `<h3>Map colours</h3>${overlaySwitchHtml()}${S.overlay ? `<div class="dash-ovl-legend">${legendHtml(S.overlay)}</div>`
      : '<div class="dash-legend-note">Colour the homes by household wealth, by the mood of the people living there, or by the condition of the building.</div>'}`;
  }

  // --- News tab ----------------------------------------------------------------------------------------

  function buildNews() {
    const box = S.bodies.news;
    box.innerHTML = `
      <div class="dash-sec" data-sec="headlines"><h3>Headlines</h3><div class="dash-heads"></div></div>
      <div class="dash-sec" data-sec="stream">
        <div class="dash-newsbar">
          <div class="dash-seg" role="radiogroup" aria-label="How much">${LEVELS.map(([k, l]) => `<button type="button" role="radio" data-level="${k}">${l}</button>`).join("")}</div>
          <div class="dash-topics" role="group" aria-label="Topics">${TOPICS.map(([k, l]) => `<button type="button" class="dash-chipbtn t-${k}" data-topic="${k}" aria-pressed="false">${icon(k)}${l}</button>`).join("")}</div>
          <div class="dash-newsfind"><input type="search" class="dash-search" placeholder="Search the news" aria-label="Search the news"><button type="button" class="dash-person-chip" hidden></button></div>
        </div>
        <ol class="dash-stream" aria-label="News"></ol>
        <div class="dash-empty" hidden></div>
      </div>`;
    S.heads = el(".dash-heads", box);
    S.stream = el(".dash-stream", box);
    S.streamEmpty = el('[data-sec="stream"] .dash-empty', box);
    el(".dash-search", box).addEventListener("input", ev => { S.news.q = ev.target.value; S.dirty.news = true; renderNews(); });
    box.addEventListener("click", ev => {
      const t = ev.target;
      const lv = t.closest("[data-level]");
      if (lv) { S.news.level = lv.dataset.level; renderNews(); return; }
      const tp = t.closest("[data-topic]");
      if (tp) { S.news.topic = S.news.topic === tp.dataset.topic ? null : tp.dataset.topic; renderNews(); return; }
      if (t.closest(".dash-person-chip")) { S.news.person = null; renderNews(); return; }
      const who = t.closest("[data-person]");
      if (who) { S.news.person = who.dataset.person; renderNews(); return; }
      const ev2 = t.closest("[data-seq]");
      if (ev2) { const e = S.ev.get(Number(ev2.dataset.seq)); if (e) focusEvent(e); }
    });
    box.addEventListener("mouseover", ev => {
      const row = ev.target.closest("[data-seq]");
      if (!row || row === S.newsHover) return;
      S.newsHover = row;
      const e = S.ev.get(Number(row.dataset.seq));
      if (e) highlightFor(e.agents || [], e.place ? [e.place] : []);
    });
    box.addEventListener("mouseout", ev => {
      const row = ev.target.closest("[data-seq]");
      if (row && !row.contains(ev.relatedTarget)) { S.newsHover = null; highlightFor([], []); }
    });
  }
  function newsMatch(e, f, q) {
    if (f.level === "major" && e.importance < 2) return false;
    if (f.level === "notable" && e.importance < 1) return false;
    if (f.topic && topicOf(e) !== f.topic) return false;
    if (f.person && !(e.agent === f.person || (e.agents || []).includes(f.person))) return false;
    if (q && !String(e.text).toLowerCase().includes(q)) return false;
    return true;
  }
  function newestFirst(level) {   // notable (and routine for Everything) merged by seq, newest first
    const A = S.notable, B = level === "all" ? S.routine : [];
    let i = A.length - 1, j = B.length - 1;
    return {
      next() {
        if (i < 0 && j < 0) return null;
        if (j < 0 || (i >= 0 && A[i].seq > B[j].seq)) return A[i--];
        return B[j--];
      },
    };
  }
  function digest(day, majors) {
    const ss = S.samples;
    let last = null, prev = null;
    for (let k = ss.length - 1; k >= 0; k--) {
      const d = Math.floor(ss[k].tick / 1440);
      if (!last && d === day) last = ss[k];
      else if (d < day) { prev = ss[k]; break; }
    }
    const bits = [dayLabel(day), plural(majors[day] || 0, "major")];
    if (last) {
      const md = prev ? last.mood - prev.mood : null;
      bits.push(`mood ${last.mood}${md != null ? ` (${deltaNum(md)})` : ""}`);
      const wd = prev && prev.wealth ? round(100 * (last.wealth - prev.wealth) / Math.abs(prev.wealth)) : null;
      bits.push(`wealth ${compact(last.wealth)}${wd != null ? ` (${deltaNum(wd)}%)` : ""}`);
    }
    return bits.join(" · ");
  }
  function personChips(e) {
    const ids = (e.agents || []).slice(0, 4);
    return ids.map(id => { const a = S.agentById[id]; return a ? `<button type="button" class="dash-pchip" data-person="${esc(id)}"><i style="background:${shirt(id)}"></i>${esc(first(a.name))}</button>` : ""; }).join("");
  }
  function renderNews() {
    if (!S.stream) return;
    S.dirty.news = false;
    S.at.news = performance.now();
    const f = S.news, q = f.q.trim().toLowerCase();
    // controls
    for (const b of S.bodies.news.querySelectorAll("[data-level]")) b.setAttribute("aria-checked", String(b.dataset.level === f.level));
    for (const b of S.bodies.news.querySelectorAll("[data-topic]")) b.setAttribute("aria-pressed", String(b.dataset.topic === f.topic));
    const chip = el(".dash-person-chip", S.bodies.news);
    const pa = f.person && S.agentById[f.person];
    chip.hidden = !f.person;
    if (f.person) chip.innerHTML = `Events about ${esc(pa ? first(pa.name) : f.person)} <span aria-hidden="true">×</span>`;
    // headlines: the 5 newest majors
    const heads = [];
    for (let i = S.notable.length - 1; i >= 0 && heads.length < SHOW.headlines; i--) if (S.notable[i].importance >= 2) heads.push(S.notable[i]);
    setHtml(S.heads, heads.length ? heads.map(e => `<article class="dash-head t-${topicOf(e) || "other"}" data-seq="${e.seq}">
        <span class="dash-hicon">${icon(iconOf(e))}</span>
        <div class="dash-hbody"><div class="dash-htext">${esc(e.text)}</div>
          <div class="dash-hmeta">${esc(e.time)} · ${ago(e.tick)}</div>
          <div class="dash-hpeople">${personChips(e)}<button type="button" class="dash-link" data-seq="${e.seq}">${icon("pin")}Show on map</button></div></div>
      </article>`).join("")
      : '<div class="dash-empty">No major events yet. Deaths, moves, new friendships and big money show up here.</div>');
    // stream, grouped by day. First meetings (about half of all notable news) are folded into their day's
    // digest line ("6 first meetings") unless God is looking for someone or something with the person chip or
    // the search box.
    const majors = {};
    for (const e of S.notable) if (e.importance >= 2) { const d = Math.floor(e.tick / 1440); majors[d] = (majors[d] || 0) + 1; }
    const fold = !f.person && !q;
    const it = newestFirst(f.level), items = [];
    let head = null, n = 0;
    for (let e = it.next(); e && n < SHOW.news; e = it.next()) {
      if (!newsMatch(e, f, q)) continue;
      const d = Math.floor(e.tick / 1440);
      if (!head || head.day !== d) { head = { day: d, met: 0 }; items.push(head); }
      if (fold && e.tag === "first_meet") { head.met += 1; continue; }
      items.push({ e });
      n += 1;
    }
    for (const x of items) if (!x.e) x.text = digest(x.day, majors) + (x.met ? ` · ${plural(x.met, "first meeting")}` : "");
    syncList(S.stream, items,
      x => (x.e ? `e${x.e.seq}` : `d${x.day}`),
      x => (x.e ? `${x.e.seq}|${x.e.importance}` : x.text),
      x => (x.e ? `<span class="dash-evtime">${hm(x.e.tick)}</span><span class="dash-evicon">${icon(iconOf(x.e))}</span><span class="dash-evtext">${esc(x.e.text)}${x.e.importance >= 2 ? `<span class="dash-evpeople">${personChips(x.e)}</span>` : ""}</span>`
        : `<span>${esc(x.text)}</span>`),
      x => (x.e ? `dash-ev imp${x.e.importance} t-${topicOf(x.e) || "other"}` : "dash-day"));
    for (const li of S.stream.children) if (li.classList.contains("dash-ev") && !li.dataset.seq) li.dataset.seq = li.dataset.key.slice(1);
    S.streamEmpty.hidden = items.length > 0;
    if (!items.length) S.streamEmpty.textContent = S.ev.size ? "Nothing matches these filters." : "Nothing has happened yet.";
  }
  function ago(tick) {
    if (!S.state) return "";
    const mins = S.state.tick - tick;
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins} min ago`;
    const h = Math.floor(mins / 60);
    return h < 48 ? `${h} h ago` : `${Math.floor(h / 24)} days ago`;
  }

  // --- LLM log tab -------------------------------------------------------------------------------------

  function buildLlm() {
    const box = S.bodies.llm;
    box.innerHTML = `
      <div class="dash-sec" data-sec="counters"><div class="dash-aistrip"></div></div>
      <div class="dash-llmbar">
        <select class="dash-llm-agent" aria-label="Character"><option value="">Everyone</option></select>
        <select class="dash-llm-kind" aria-label="Decision kind"><option value="">Every kind</option>${FORK_KINDS.map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select>
        <label class="dash-check"><input type="checkbox" data-f="against"> Against habit only</label>
      </div>
      <div class="dash-llmbar">
        <label class="dash-check"><input type="checkbox" data-f="timeouts"> Include timeouts</label>
        <label class="dash-check"><input type="checkbox" data-f="all"> Show habit and profile decisions</label>
      </div>
      <button type="button" class="dash-pill" hidden></button>
      <ol class="dash-llmlist" aria-label="Decisions"></ol>
      <div class="dash-empty dash-llm-empty" hidden></div>
      <button type="button" class="dash-btn dash-older">Load older</button>`;
    S.llmList = el(".dash-llmlist", box);
    S.llmEmpty = el(".dash-llm-empty", box);
    S.llmPill = el(".dash-pill", box);
    S.llmOlder = el(".dash-older", box);
    el(".dash-llm-agent", box).addEventListener("change", ev => setLlmAgent(ev.target.value));
    el(".dash-llm-kind", box).addEventListener("change", ev => { S.llm.kind = ev.target.value; resetLlmWindow(); renderLlm(); });
    for (const c of box.querySelectorAll("[data-f]")) c.addEventListener("change", () => { S.llm[c.dataset.f] = c.checked; resetLlmWindow(); renderLlm(); });
    S.llmPill.addEventListener("click", () => { box.scrollTop = 0; S.llm.topId = null; resetLlmWindow(); renderLlm(); });
    S.llmOlder.addEventListener("click", () => {
      // Older rows the page already holds come first; the server is asked only once the list shows them all.
      const F = S.llm;
      if (F.held > F.end) { F.shown = F.end + SHOW.older; renderLlm(); return; }
      // The next page starts where the unbroken run this filter holds ends (the welcome's llm_log, then each older
      // page), else at the oldest decision held for it. When that fork has left the server's ring, so has every
      // older one: the reply is empty with more false.
      const mine = S.forkList.filter(f => isLlmFork(f) && (!F.agent || f.agent === F.agent));
      const cur = S.forkCursor[F.agent];
      const oldest = cur && S.forks.has(cur) ? cur : mine.length ? mine[mine.length - 1].id : cur || null;
      const msg = { type: "get_decisions", limit: 30 };
      if (F.agent) msg.agent_id = F.agent;
      if (oldest) msg.before = oldest;
      S.llm.loading = true;
      request(msg, { what: "decisions", agent: F.agent, older: true });
      renderLlm();
    });
    box.addEventListener("scroll", () => { if (box.scrollTop <= 60 && S.llm.pending) renderLlm(); }, { passive: true });
    box.addEventListener("click", ev => {
      const t = ev.target;
      if (t.closest(".dash-showall")) { S.llm.all = true; el('[data-f="all"]', box).checked = true; renderLlm(); return; }
      const act = t.closest("[data-act]");
      const row = t.closest("li[data-key]");
      const f = row && S.forks.get(row.dataset.key);
      if (act && f) {
        if (act.dataset.act === "map") {
          const target = f.place ? { place: f.place } : { agent: f.agent };
          focusMap(target, { show: true });
          highlightFor([f.agent], f.place ? [f.place] : [], 4000);
        } else if (act.dataset.act === "open") selectAgent(f.agent, { follow: true, focus: true });
        return;
      }
      if (t.closest("a")) return;
      if (f) {
        if (S.llm.expanded.has(f.id)) S.llm.expanded.delete(f.id); else S.llm.expanded.add(f.id);
        renderLlm();
      }
    });
    box.addEventListener("mouseover", ev => {
      const row = ev.target.closest("li[data-key]");
      if (!row || row === S.llmHover) return;
      S.llmHover = row;
      const f = S.forks.get(row.dataset.key);
      if (f) highlightFor([f.agent], f.place ? [f.place] : []);
    });
    box.addEventListener("mouseout", ev => {
      const row = ev.target.closest("li[data-key]");
      if (row && !row.contains(ev.relatedTarget)) { S.llmHover = null; highlightFor([], []); }
    });
  }
  function fillAgentSelect() {
    const sel = S.bodies && el(".dash-llm-agent", S.bodies.llm);
    if (!sel || !S.state) return;
    const opts = S.state.agents.slice().sort((a, b) => cmp(a.name, b.name)).map(a =>
      `<option value="${esc(a.id)}">${esc(a.name)}${a.controller ? ` · ${esc(a.controller)}` : ""}${a.alive ? "" : " · died"}</option>`);
    sel.innerHTML = `<option value="">Everyone</option>${opts.join("")}`;
    sel.value = S.llm.agent;
  }
  function setLlmAgent(id) {
    S.llm.agent = id || "";
    const sel = el(".dash-llm-agent", S.bodies.llm);
    if (sel && sel.value !== S.llm.agent) sel.value = S.llm.agent;
    S.llm.topId = null;
    resetLlmWindow();
    if (S.llm.agent) {
      S.llm.loading = true;
      request({ type: "get_decisions", agent_id: S.llm.agent, limit: 30 }, { what: "decisions", agent: S.llm.agent });
    }
    renderLlm();
  }
  // A new filter (or the welcome, or "back to top") starts the list at its newest SHOW.llm rows again.
  function resetLlmWindow() {
    S.llm.shown = SHOW.llm;
    S.llm.floor = null;
  }
  function openLlmFor(id) {
    openTab("llm");
    setLlmAgent(id);
  }
  function llmMatch(f, F) {
    const by = f.decided_by;
    if (!F.all) {
      if (by === "timeout") { if (!F.timeouts) return false; }
      else if (by !== "model") return false;
    }
    if (F.agent && f.agent !== F.agent) return false;
    if (F.kind && f.kind !== F.kind) return false;
    if (F.against && !(by === "model" && f.profile_choice != null && f.choice !== f.profile_choice)) return false;
    return true;
  }
  // "LLM decisions (n)": the server's count (the stats people row's `llm`, every one since the city began), else
  // what this page holds (a person who died has no row).
  function llmCount(id) {
    const p = S.peopleById[id];
    if (p && typeof p.llm === "number") return p.llm;
    return S.forkList.reduce((n, f) => n + (f.agent === id && isLlmFork(f) ? 1 : 0), 0);
  }
  const dayOf = tick => Math.floor(tick / 1440);
  const todayNum = () => (S.state ? dayOf(S.state.tick) : null);
  // A row's time: "15:00" today, "Fri 15:00" on another day (the list's day separators say which).
  function forkTime(f) {
    const d = dayOf(f.tick), today = todayNum();
    return today == null || d === today ? hm(f.tick) : `${DAY_NAMES[((d % 7) + 7) % 7]} ${hm(f.tick)}`;
  }
  function llmDayLabel(d) {
    const today = todayNum();
    return d === today ? `Today · ${dayLabel(d)}` : d === today - 1 ? `Yesterday · ${dayLabel(d)}` : dayLabel(d);
  }
  function forkHtml(f, full) {
    const a = S.agentById[f.agent] || { name: f.agent };
    const by = f.decided_by, opt = i => esc((f.options || [])[i] ?? "?");
    const against = by === "model" && f.profile_choice != null && f.choice !== f.profile_choice;
    const tags = [];
    if (against) tags.push('<span class="dash-tag against">against habit</span>');
    if (f.major) tags.push('<span class="dash-tag major">major</span>');
    if (by !== "model") tags.push(`<span class="dash-tag ${by}">${by === "default" ? "profile" : esc(by)}</span>`);
    if (f.late) tags.push('<span class="dash-tag late">answered late</span>');
    const when = by === "model" && f.answer_seconds != null ? `${f.answer_seconds} s` : by === "timeout" ? "no answer" : "";
    let line2;
    if (by === "timeout") {
      line2 = `<div class="dash-fline muted">No answer in 5 s: the profile played ${opt(f.choice)}</div>`;
      if (f.late) line2 += `<div class="dash-fline">${esc(f.controller || "The controller")} answered after ${f.late.seconds} s: ${opt(f.late.choice)}${f.late.reason ? `, <q>${esc(f.late.reason)}</q>` : ""} (saved to the profile)</div>`;
    } else {
      line2 = `<div class="dash-fline">▶ ${opt(f.choice)}${by === "model" && f.reason ? ` <q>${esc(f.reason)}</q>` : ""}</div>`;
    }
    let more = "";
    if (full) {
      const opts = (f.options || []).map((o, i) => `<li class="${i === f.choice ? "chosen" : ""}">${i === f.choice ? "▶ " : ""}${esc(o)}${against && i === f.profile_choice ? ' <span class="dash-muted">(profile would)</span>' : ""}</li>`).join("");
      const href = characterHref(f.agent);
      more = `<div class="dash-fmore"><div class="dash-fq">${esc(f.question)}</div><ol class="dash-opts">${opts}</ol>
        ${against ? `<div class="dash-muted">Profile would: ${opt(f.profile_choice)}</div>` : ""}
        <div class="dash-muted">${f.controller ? `Asked ${esc(f.controller)} · ${f.model ? esc(f.model) : "no model declared"}` : by === "habit" ? "Decided by habit: nobody was asked" : "Decided by the profile's defaults: nobody was asked"}${f.place ? ` · at ${esc(placeName(f.place))}` : ""} · ${esc(f.time)}</div>
        ${f.happened && f.happened.length ? `<div class="dash-then">Then: ${esc(f.happened.join("; "))}</div>` : ""}
        <div class="dash-acts"><button type="button" class="dash-btn" data-act="map">Show on map</button><button type="button" class="dash-btn" data-act="open">Open ${esc(first(a.name))}</button>${href ? `<a class="dash-btn dash-fullpage" href="${esc(href)}">Full page</a>` : ""}</div></div>`;
    }
    return `<div class="dash-fhead"><span class="dash-sw" style="background:${shirt(f.agent)}"></span><b class="dash-fname">${esc(a.name)}</b>
      <span class="dash-kind">${esc(pretty(f.kind))}</span>${tags.join("")}<span class="dash-ftime">${forkTime(f)}${when ? ` · ${when}` : ""}</span></div>${line2}${more}`;
  }
  function llmEmptyText() {
    const F = S.llm, L = S.stats && S.stats.llm;
    const showAll = '<button type="button" class="dash-btn dash-showall">Show habit and profile decisions</button>';
    if (F.agent) {
      const a = S.agentById[F.agent], nm = a ? first(a.name) : F.agent;
      if (F.all || F.kind || F.against) return `<p>No decisions for ${esc(nm)} match these filters.</p>`;
      if (S.llm.loading) return `<p>Asking the city for ${esc(nm)}'s decisions…</p>`;
      if (a && a.controller) return `<p>No LLM decisions for ${esc(nm)} yet. ${esc(nm)} is played by ${esc(a.controller)}; their forks so far were obvious habits.</p>`;
      return `<p>No LLM decisions for ${esc(nm)} yet. ${esc(nm)} runs on profile defaults.</p>${F.all ? "" : showAll}`;
    }
    if (F.all) return "<p>No decisions yet.</p>";
    if (S.host.kind === "browser") {
      return `<p>This browser version of Millbrook has no AI players. Every character decides by habit and by their profile, so there are no LLM decisions to show.</p>
        <p class="dash-muted">To watch Claude play, run the city on your computer with the Python server and examples/claude_controller.py (it uses your own API key).</p>${showAll}`;
    }
    const ctrls = (L && L.controllers) || [];
    const ever = L && L.total && L.total.asked > 0;
    if (!ctrls.length && !ever) {
      return `<p>No AI model is playing anyone yet. Every decision so far was made by habit or by profile defaults.</p>
        <p class="dash-muted">Start one with <code>python3 examples/claude_controller.py --characters all</code> (needs ANTHROPIC_API_KEY).</p>${showAll}`;
    }
    if (F.kind || F.against) return "<p>Nothing matches these filters.</p>";
    if (ctrls.length) return `<p>${ctrls.map(c => `${esc(c.name)} (${c.model ? esc(c.model) : "no model declared"}) plays ${plural(c.characters, "character")}`).join("; ")}. Its first answers will appear here.</p>`;
    return "<p>No LLM decisions in view.</p>";
  }
  function renderLlm() {
    if (!S.llmList) return;
    S.dirty.llm = false;
    S.at.llm = performance.now();
    const box = S.bodies.llm, F = S.llm, browser = S.host.kind === "browser";
    // The browser build has no AI players: no counters, and no timeout or against-habit filters to offer.
    el('[data-sec="counters"]', box).hidden = browser;
    for (const k of ["against", "timeouts"]) el(`[data-f="${k}"]`, box).closest("label").hidden = browser;
    if (!browser) setHtml(el(".dash-aistrip", box), aiStripHtml());
    const sel = el(".dash-llm-agent", box);
    if (sel && sel.options.length <= 1 && S.state) fillAgentSelect();
    let items = S.forkList.filter(f => llmMatch(f, F));
    const away = box.scrollTop > 60;
    if (away && F.topId) {
      const i = items.findIndex(f => f.id === F.topId);
      if (i > 0) { F.pending = i; items = items.slice(i); } else F.pending = 0;
    } else { F.pending = 0; F.topId = items.length ? items[0].id : null; }
    let end = F.shown;
    const floor = F.floor && S.forks.get(F.floor);
    if (floor) {
      let n = 0;
      while (n < items.length && forkOrder(items[n], floor) <= 0) n++;
      end = Math.max(end, n);
    }
    F.held = items.length;
    items = items.slice(0, end);
    F.end = items.length;
    // Day separators, newest day first, as in the News stream.
    const rows = [], today = todayNum();
    let day = null;
    for (const f of items) {
      const d = dayOf(f.tick);
      if (d !== day) { day = d; rows.push({ sep: d, text: llmDayLabel(d) }); }
      rows.push(f);
    }
    syncList(S.llmList, rows, x => (x.sep != null ? `day:${x.sep}` : x.id),
      x => (x.sep != null ? x.text : `${x.id}|${x.choice}|${(x.happened || []).length}|${x.late ? 1 : 0}|${F.expanded.has(x.id) ? 1 : 0}|${S.host.kind}|${dayOf(x.tick) === today ? "" : today}`),
      x => (x.sep != null ? `<span>${esc(x.text)}</span>` : forkHtml(x, F.expanded.has(x.id))),
      x => (x.sep != null ? "dash-llmday" : `dash-fork by-${x.decided_by}${F.expanded.has(x.id) ? " open" : ""}`));
    S.llmPill.hidden = !F.pending;
    if (F.pending) S.llmPill.textContent = `${F.pending} new · back to top`;
    S.llmEmpty.hidden = items.length > 0;
    if (!items.length) S.llmEmpty.innerHTML = llmEmptyText();
    // "Load older" stays while the page holds more than it shows, or the server may have more.
    const more = S.forkMore[F.agent || ""];
    S.llmOlder.hidden = browser || (more === false && F.held <= F.end) || (!items.length && !F.agent);
    S.llmOlder.disabled = F.loading;
    S.llmOlder.textContent = F.loading ? "Loading…" : "Load older";
  }

  // --- People tab: ranking, person, home card ----------------------------------------------------------

  function buildPeople() {
    const box = S.bodies.people;
    box.innerHTML = `
      <div class="dash-rankview">
        <div class="dash-controls">
          <input type="search" class="dash-search" placeholder="Search people" aria-label="Search people">
          <div class="dash-seg" role="radiogroup" aria-label="Who">${SEGS.map(([k, l]) => `<button type="button" role="radio" data-seg="${k}">${l}</button>`).join("")}</div>
          <label class="dash-sort"><span class="dash-sr">Sort by</span><select aria-label="Sort by">${SORTS.map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select></label>
        </div>
        <div class="dash-sec" data-sec="ranking"><h3 class="dash-rank-title">Richest to poorest</h3>${segLegend()}</div>
        <div class="dash-rankhead" aria-hidden="true"><span>#</span><span></span><span>Name</span><button type="button" data-sorthead="worth">Net worth</button><button type="button" data-sorthead="change">24 h</button></div>
        <ol class="dash-rank" aria-label="Richest to poorest"></ol>
        <div class="dash-empty dash-rank-empty" hidden></div>
        <div class="dash-rankfoot"></div>
        <div class="dash-memoriam"></div>
      </div>
      <div class="dash-detail" hidden></div>
      <div class="dash-card" hidden></div>`;
    S.peopleBox = box;
    S.rankView = el(".dash-rankview", box);
    S.rankList = el(".dash-rank", box);
    S.detailBox = el(".dash-detail", box);
    S.cardBox = el(".dash-card", box);
    el(".dash-search", S.rankView).addEventListener("input", ev => { S.ppl.q = ev.target.value; renderRanking(true); });
    el(".dash-sort select", S.rankView).addEventListener("change", ev => { S.ppl.sort = ev.target.value; renderRanking(true); });
    S.rankView.addEventListener("click", ev => {
      const t = ev.target;
      const sg = t.closest("[data-seg]");
      if (sg) { S.ppl.seg = sg.dataset.seg; S.ppl.expanded = null; renderRanking(true); return; }
      const sh = t.closest("[data-sorthead]");
      if (sh) { S.ppl.sort = sh.dataset.sorthead; renderRanking(true); return; }
      const act = t.closest("[data-act]");
      if (act) { rankAction(act); return; }
      if (t.closest("a")) return;
      const li = t.closest(".dash-rank > li");
      if (li) {
        S.ppl.expanded = S.ppl.expanded === li.dataset.key ? null : li.dataset.key;
        renderRanking(true);
      }
    });
    S.rankList.addEventListener("dblclick", ev => {
      const li = ev.target.closest(".dash-rank > li");
      if (li && !li.dataset.key.startsWith("hh:")) selectAgent(li.dataset.key, { focus: true });
    });
    S.rankList.addEventListener("pointerdown", () => { S.ppl.press = true; });
    S.rankList.addEventListener("mouseover", ev => {
      const li = ev.target.closest(".dash-rank > li");
      if (!li || li === S.rankHover) return;
      S.rankHover = li;
      const k = li.dataset.key;
      if (k.startsWith("hh:")) {
        const h = S.hhById[k.slice(3)];
        highlightFor(h ? h.members : [], h && S.homeById[h.home] ? [S.homeById[h.home].place] : []);
      } else highlightFor([k], [homePlaceOf(k)].filter(Boolean));
    });
    S.rankList.addEventListener("mouseleave", () => { S.rankHover = null; highlightFor([], []); });
    S.detailBox.addEventListener("click", ev => {
      const t = ev.target;
      if (t.closest(".dash-back")) { back(); return; }
      const act = t.closest("[data-act]");
      if (!act) return;
      const id = S.selected;
      if (act.dataset.act === "map") { callView("select", id, { follow: true }); focusMap({ agent: id }, { show: true }); }
      else if (act.dataset.act === "llm") openLlmFor(id);
      else if (act.dataset.act === "news") { S.news.person = id; openTab("news"); }
      else if (act.dataset.act === "home") openHome(act.dataset.home, { fromDetail: true });
      else if (act.dataset.act === "person") selectAgent(act.dataset.id, { follow: true });
    });
    S.cardBox.addEventListener("click", ev => {
      const t = ev.target;
      if (t.closest(".dash-back")) { closeCard(); return; }
      const unit = t.closest("[data-unit]");
      if (unit) { openHome(unit.dataset.unit, { fromCard: true }); return; }
      const who = t.closest("[data-person]");
      if (who) { const a = S.state && S.state.agents.find(x => x.name === who.dataset.person); if (a) selectAgent(a.id, { follow: true, focus: true }); return; }
      const act = t.closest("[data-act]");
      if (act && act.dataset.act === "map" && S.card) {
        const spec = S.homeById[S.card.id];
        const place = S.card.block ? S.card.id : spec ? spec.place : S.card.id;
        focusMap({ place }, { show: true });
        highlightFor([], [place], 4000);
      }
      if (act && act.dataset.act === "block" && S.card) { const spec = S.homeById[S.card.id]; if (spec) openHome(spec.place, { fromCard: true }); }
    });
  }
  function rankAction(act) {
    const id = act.dataset.id;
    if (act.dataset.act === "open") selectAgent(id, { follow: false });
    else if (act.dataset.act === "map") { callView("select", id, { follow: true }); focusMap({ agent: id }, { show: true }); highlightFor([id], [], 3000); }
    else if (act.dataset.act === "llm") openLlmFor(id);
    else if (act.dataset.act === "home") openHome(act.dataset.home);
  }
  function renderPeople() {
    if (!S.peopleBox) return;
    const mode = S.card ? "card" : S.selected ? "detail" : "rank";
    S.rankView.hidden = mode !== "rank";
    S.detailBox.hidden = mode !== "detail";
    S.cardBox.hidden = mode !== "card";
    if (mode === "rank") renderRanking();
    else if (mode === "detail") renderDetail(S.detailBox);
    else renderCard(S.cardBox);
  }

  function personRows() {
    const st = S.stats;
    if (!st) return [];
    const model = {};
    for (const c of (st.llm && st.llm.controllers) || []) model[c.name] = c.model;
    return (st.people || []).map(p => {
      const a = S.agentById[p.id] || {};
      return { key: p.id, id: p.id, kind: "person", name: a.name || p.id, age: a.age, hh: p.household, home: a.home,
        worth: p.worth, worth24: p.worth_24h, cash: p.cash, savings: p.savings, homeEq: p.home_equity, job: p.job,
        health: p.health, mood: a.mood, luck: a.luck, controller: a.controller, model: a.controller ? model[a.controller] : null };
    });
  }
  function householdRows(people) {
    const by = {};
    for (const p of people) (by[p.hh] = by[p.hh] || []).push(p);
    return (S.stats.households || []).map(h => {
      const ms = by[h.id] || [];
      const sum = k => ms.reduce((s, m) => s + (m[k] || 0), 0);
      return { key: `hh:${h.id}`, id: h.id, kind: "household", name: h.name, members: ms, row: h, home: h.home,
        worth: sum("worth"), worth24: sum("worth24"), cash: sum("cash"), savings: sum("savings"), homeEq: sum("homeEq"),
        mood: mean(ms.map(m => m.mood)), health: mean(ms.map(m => m.health)), luck: mean(ms.map(m => m.luck)),
        age: mean(ms.map(m => m.age)) };
    }).filter(r => r.members.length);
  }
  function rankedRows() {
    const F = S.ppl;
    let rows = personRows();
    if (F.seg === "households") rows = householdRows(rows);
    else if (F.seg === "adults") rows = rows.filter(r => r.age == null || r.age >= 18);
    rows.slice().sort((x, y) => y.worth - x.worth || cmp(x.id, y.id)).forEach((r, i) => { r.rank = i + 1; });
    rows.slice().sort((x, y) => y.worth24 - x.worth24 || cmp(x.id, y.id)).forEach((r, i) => { r.rank24 = i + 1; });
    S.rankTop = rows.reduce((m, r) => Math.max(m, r.worth), 0);
    const val = r => (F.sort === "worth" ? r.worth : F.sort === "change" ? r.worth - r.worth24 : r[F.sort] == null ? -Infinity : r[F.sort]);
    rows.sort((x, y) => (val(y) - val(x)) || (x.rank - y.rank));
    const q = F.q.trim().toLowerCase();
    if (q) rows = rows.filter(r => r.name.toLowerCase().includes(q) || (r.members || []).some(m => m.name.toLowerCase().includes(q)));
    return rows;
  }
  function partsText(p) {
    return `Cash ${money(p.cash)} · Savings ${money(p.savings)} · Home ${money(p.homeEq)}`;
  }
  // In debt means what stats.in_debt counts (dashboard.md 4): cash + savings below zero. The row then gets the
  // red stub and the word "debt" (never colour alone), after the positive parts when the home still makes
  // the net worth positive (house-rich, cash-poor), or alone when the net worth is negative too.
  const inDebt = p => (p.cash || 0) + (p.savings || 0) < 0;
  function barHtml(p, top) {
    const title = esc(partsText(p)), debt = inDebt(p) || p.worth < 0;
    const tag = '<i class="dash-debtstub"></i><em>debt</em>';
    if (p.worth <= 0 && debt) return `<span class="dash-bar debt" title="${title}"><span class="dash-barfill"><i class="d"></i></span><em>debt</em></span>`;
    const parts = [["c", p.cash], ["s", p.savings], ["h", p.homeEq]].filter(x => x[1] > 0);
    const w = top > 0 ? clamp(p.worth / top * 100, 0, 100) : 0;
    return `<span class="dash-bar${debt ? " indebt" : ""}" title="${title}"><span class="dash-barfill" style="width:${w.toFixed(1)}%">${parts.map(([k, v]) =>
      `<i class="${k}" style="flex-grow:${round(v)}"></i>`).join("")}</span>${debt ? tag : ""}</span>`;
  }
  function tenureOf(r) {
    if (r.kind === "household") {
      const spec = S.homeById[r.home];
      return { flat: spec && spec.tier === "flat", owned: r.row.tenure === "owned", spec };
    }
    const spec = S.homeById[r.home], st = S.homes[r.home];
    return { flat: spec && spec.tier === "flat", owned: !!(st && st.owner && st.owner === r.hh), spec };
  }
  function tenureIcon(r) {
    const t = tenureOf(r);
    if (!t.spec) return '<span class="dash-ten"></span>';
    const what = t.flat ? "a flat" : `a ${tierLabel(t.spec.tier)}`;
    const title = `${t.owned ? "Owns" : "Rents"} ${what}`;
    return `<span class="dash-ten${t.owned ? " own" : ""}" title="${title}" aria-label="${title}">${icon(t.flat ? "flat" : t.owned ? "own" : "rent")}</span>`;
  }
  function rankRowHtml(r) {
    const chg = r.worth - r.worth24, mv = r.rank24 - r.rank, open = S.ppl.expanded === r.key;
    const sub = r.kind === "person" ? (r.age != null ? String(r.age) : "") : r.members.map(m => esc(first(m.name))).join(", ");
    const sw = r.kind === "person" ? shirt(r.id) : shirt(r.members[0].id);
    return `<div class="dash-rrow">
        <span class="dash-rk${r.rank <= 3 ? " m" + r.rank : ""}">${r.rank}</span>
        <span class="dash-mv ${dirClass(mv)}" title="${mv ? `${Math.abs(mv)} place${Math.abs(mv) === 1 ? "" : "s"} ${mv > 0 ? "up" : "down"} since 24 h ago` : "same place as 24 h ago"}">${mv > 0 ? "▲" + mv : mv < 0 ? "▼" + -mv : ""}</span>
        <span class="dash-sw" style="background:${sw}"></span>
        <span class="dash-nm"${r.kind === "person" && r.job ? ` title="${esc(r.name)}, ${esc(r.job)}"` : ""}><b>${esc(r.name)}</b> <span class="dash-muted">${sub}</span></span>
        ${tenureIcon(r)}
        <span class="dash-worth">${money(r.worth)}</span>
        <span class="dash-chg ${dirClass(round(chg))}">${deltaMoney(chg)}</span>
        ${barHtml(r, S.rankTop)}
      </div>${open ? rankMoreHtml(r) : ""}`;
  }
  function rankMoreHtml(r) {
    const parts = `<div class="dash-parts"><span><i class="c"></i>Cash <b>${money(r.cash)}</b></span><span><i class="s"></i>Savings <b>${money(r.savings)}</b></span><span><i class="h"></i>Home <b>${money(r.homeEq)}</b></span></div>`;
    const t = tenureOf(r), hh = S.hhById[r.kind === "household" ? r.id : r.hh];
    const homeLineHtml = t.spec ? `${esc(t.spec.name)} <span class="dash-muted">(${esc(tierLabel(t.spec.tier))}, ${t.owned ? "owns" : "rents"}${hh && hh.weekly_cost != null ? `, ${money(hh.weekly_cost)}/week` : ""})</span>` : "";
    if (r.kind === "household") {
      return `<div class="dash-more">${parts}<div class="dash-kv">${homeLineHtml}</div>
        <ul class="dash-members">${r.members.map(m => `<li><button type="button" data-act="open" data-id="${esc(m.id)}"><span class="dash-sw" style="background:${shirt(m.id)}"></span>${esc(m.name)} <span class="dash-muted">${m.age ?? ""}</span><span class="dash-worth">${money(m.worth)}</span></button></li>`).join("")}</ul>
        ${t.spec ? `<div class="dash-acts"><button type="button" class="dash-btn" data-act="home" data-home="${esc(t.spec.id)}">Home card</button></div>` : ""}</div>`;
    }
    const href = characterHref(r.id), n = llmCount(r.id);
    const played = r.controller ? `played by ${esc(r.controller)} (${r.model ? esc(r.model) : "no model declared"})` : "profile defaults";
    return `<div class="dash-more">${parts}
      <div class="dash-kv">${r.job ? esc(r.job) : r.age != null && r.age >= 65 ? "retired" : "no job"}${homeLineHtml ? ` · ${homeLineHtml}` : ""}</div>
      <div class="dash-kv">Mood <b>${r.mood ?? "–"}</b> · Health <b>${r.health ?? "–"}</b> · Luck <b>${r.luck ?? "–"}</b> · ${played}</div>
      <div class="dash-acts"><button type="button" class="dash-btn" data-act="open" data-id="${esc(r.id)}">Open</button>
        <button type="button" class="dash-btn" data-act="map" data-id="${esc(r.id)}">Show on map</button>
        <button type="button" class="dash-btn" data-act="llm" data-id="${esc(r.id)}">LLM decisions (${n})</button>
        ${href ? `<a class="dash-btn dash-fullpage" href="${esc(href)}">Full page</a>` : ""}</div></div>`;
  }
  function renderRanking(force) {
    if (!S.rankList) return;
    if (S.ppl.press && !force) { S.dirty.people = true; return; }   // replacing rows under the pointer loses the click
    S.dirty.people = false;
    S.at.people = performance.now();
    const F = S.ppl;
    for (const b of S.rankView.querySelectorAll("[data-seg]")) b.setAttribute("aria-checked", String(b.dataset.seg === F.seg));
    for (const b of S.rankView.querySelectorAll("[data-sorthead]")) b.classList.toggle("on", b.dataset.sorthead === F.sort);
    const sel = el(".dash-sort select", S.rankView);
    if (sel.value !== F.sort) sel.value = F.sort;
    const search = el(".dash-search", S.rankView);
    const nAlive = S.state ? S.state.agents.filter(a => a.alive).length : 0;
    search.placeholder = F.seg === "households" ? "Search households" : `Search ${nAlive} people`;
    el(".dash-rank-title", S.rankView).textContent = F.seg === "households" ? "Households, richest to poorest" : F.seg === "adults" ? "Adults, richest to poorest" : "Everyone, richest to poorest";
    if (!S.stats) { S.rankList.innerHTML = ""; return; }
    const rows = rankedRows();
    const animate = tabVisible("people") && !reducedMotion() && S.rankList.children.length > 0;
    let before = null;
    if (animate) {
      before = new Map();
      for (const li of S.rankList.children) before.set(li.dataset.key, li.getBoundingClientRect().top);
    }
    syncList(S.rankList, rows, r => r.key,
      r => [r.rank, r.rank24, r.worth, r.worth24, r.cash, r.savings, r.homeEq, r.name, r.age, r.job, S.rankTop,
        S.ppl.expanded === r.key ? `${r.mood}|${r.health}|${r.luck}|${r.controller}|${llmCount(r.id)}|${S.host.kind}` : "",
        tenureOf(r).owned, S.selected === r.id].join("|"),
      rankRowHtml,
      r => `dash-rrowli${S.ppl.expanded === r.key ? " open" : ""}${S.selected === r.id ? " sel" : ""}`);
    if (before) flip(S.rankList, before);
    const empty = el(".dash-rank-empty", S.rankView);
    empty.hidden = rows.length > 0;
    if (!rows.length) empty.textContent = F.q ? `Nobody matches “${F.q}”.` : "Nobody yet.";
    const w = S.stats.city.wealth;
    setHtml(el(".dash-rankfoot", S.rankView), `Median <b>${money(w.median)}</b> · <b>${w.in_debt}</b> in debt · top 10% hold <b>${w.top10_share}%</b>`);
    const deaths = S.stats.city.recent_deaths || [];
    setHtml(el(".dash-memoriam", S.rankView), deaths.length ? `<h3>In memoriam</h3><ul>${deaths.map(d =>
      `<li>${esc(d.name)}, ${d.age} · ${esc(String(d.time || "").split(" ").slice(0, 2).join(" "))} · ${esc(d.how || "")}</li>`).join("")}</ul>` : "");
  }
  function flip(box, before) {
    const moved = [];
    for (const li of box.children) {
      const old = before.get(li.dataset.key);
      if (old == null) continue;
      const dy = old - li.getBoundingClientRect().top;
      if (Math.abs(dy) < 1) continue;
      li.style.transition = "none";
      li.style.transform = `translateY(${round(dy)}px)`;
      moved.push(li);
    }
    if (!moved.length) return;
    void box.offsetHeight;
    for (const li of moved) { li.style.transition = "transform 200ms ease"; li.style.transform = ""; }
  }

  // The open person: everything but the live numbers is rebuilt only when it changed, so scrolling, a
  // half-dragged slider and an unsaved play style are never clobbered by the 800 ms refresh.
  function detailKey(a) {
    const p = Object.assign({}, a.possessions || {});
    delete p.money; delete p.savings; delete p.household_funds;
    return JSON.stringify([a.id, a.alive, a.controller, a.job, a.profile, p, a.relationships, a.memory,
      (a.forks || []).map(f => [f.id, f.choice, f.happened, f.late ? 1 : 0]), a.home_history, a.household,
      S.role, S.host.kind, llmCount(a.id), todayNum()]);
  }
  function renderDetail(box) {
    const a = S.detail;
    if (!a) {
      const row = S.agentById[S.selected];
      box.dataset.agent = "";
      S.detailKey = "";
      box.innerHTML = `<button type="button" class="dash-back">← Everyone</button><h2><span class="dash-sw" style="background:${shirt(S.selected)}"></span>${esc(row ? row.name : S.selected)}</h2><div class="dash-muted">Loading…</div>`;
      return;
    }
    const active = document.activeElement;
    const key = detailKey(a);
    const same = key === S.detailKey && el(".dash-live", box);
    const mine = box.dataset.agent === a.id;
    const editing = box.contains(active) && (active.tagName === "TEXTAREA" || active.type === "range");
    if (same || (mine && (editing || S.editingProfile === a.id))) {
      const live = el(".dash-live", box);
      if (live) setHtml(live, liveHtml(a));
      const luck = el(".dash-luck-range", box);
      if (luck && active !== luck) { luck.value = a.luck; el(".dash-luckv", box).textContent = round(a.luck); }
      return;
    }
    S.detailKey = key;
    box.dataset.agent = a.id;
    const watching = S.role !== "god";
    const href = characterHref(a.id), n = llmCount(a.id);
    const traits = Object.entries((a.profile && a.profile.traits) || {}).map(([k, v]) => `
      <label for="dash-t-${k}">${k}</label><input id="dash-t-${k}" data-trait="${k}" type="range" min="0" max="1" step="0.05" value="${v}"${watching ? " disabled" : ""}><span>${Number(v).toFixed(2)}</span>`).join("");
    const forks = (a.forks || []).slice().reverse().map(f => `<li class="dash-fork by-${f.decided_by}">${forkHtml(f, false)}</li>`).join("") || '<li class="dash-muted">No decisions yet.</li>';
    const rels = Object.entries(a.relationships || {}).slice(0, 8).map(([id, r]) =>
      `<li><button type="button" data-act="person" data-id="${esc(id)}"><span class="dash-sw" style="background:${shirt(id)}"></span>${esc(r.name || id)} <span class="dash-muted">${esc(r.kind)} · ${r.affinity > 0 ? "+" : ""}${r.affinity}</span></button></li>`).join("");
    const hist = (a.home_history || []).slice().reverse().map(h => `<li><span class="dash-muted">${esc(h.time)}</span> ${esc(h.event)} ${esc(h.name || placeName(h.home))}${h.price ? ` · ${money(h.price)}${h.event === "rented" ? "/week" : ""}` : ""}</li>`).join("");
    const job = a.job ? esc(a.job.title) : a.age >= 65 ? "retired" : "no job";
    const played = a.controller ? `played by ${esc(a.controller)}` : "running on profile defaults";
    box.innerHTML = `
      <button type="button" class="dash-back">← Everyone</button>
      <h2><span class="dash-sw" style="background:${shirt(a.id)}"></span>${esc(a.name)}</h2>
      <div class="dash-muted">${a.age} · ${job} · ${played}</div>
      <div class="dash-acts">
        <button type="button" class="dash-btn" data-act="map">Show on map</button>
        <button type="button" class="dash-btn" data-act="llm">LLM decisions (${n})</button>
        <button type="button" class="dash-btn" data-act="news">Events about ${esc(first(a.name))}</button>
        ${href ? `<a class="dash-btn dash-fullpage" href="${esc(href)}">Full character page</a>` : ""}
      </div>
      <div class="dash-live">${liveHtml(a)}</div>
      <div class="dash-luck">
        <div class="dash-luckrow"><span>Cursed</span><b>Luck <span class="dash-luckv">${round(a.luck)}</span></b><span>Blessed</span></div>
        <input class="dash-luck-range" type="range" min="0" max="100" step="1" value="${a.luck}" aria-label="Luck"${watching || !a.alive ? " disabled" : ""}>
        <div class="dash-muted">Your only power. ${esc(first(a.name))} will never know. Luck tilts the hidden odds of every outcome.</div>
        ${watching ? '<div class="dash-watchnote">Watching only: God moved to another window, so luck is locked here.</div>' : ""}
      </div>
      <h3>Owns</h3>${ownsHtml(a)}
      <h3>Play style</h3>
      <textarea class="dash-prompt" aria-label="Play-style prompt"${watching ? " disabled" : ""}>${esc(a.profile ? a.profile.prompt : "")}</textarea>
      <div class="dash-traits">${traits}</div>
      <button type="button" class="dash-btn dash-saveprof"${watching ? " disabled" : ""}>Save play style</button>
      <span class="dash-muted">${a.profile && a.profile.edited ? "Written by you" : "Learns from choices"}</span>
      <h3>Recent decisions</h3><ol class="dash-forklist">${forks}</ol>
      <h3>People</h3><ul class="dash-list dash-rels">${rels || '<li class="dash-muted">Nobody yet.</li>'}</ul>
      ${hist ? `<h3>Home history</h3><ul class="dash-list">${hist}</ul>` : ""}
      <h3>Memory</h3><ul class="dash-list">${(a.memory || []).slice().reverse().map(m => `<li>${esc(m)}</li>`).join("") || '<li class="dash-muted">Nothing yet.</li>'}</ul>`;
    const luck = el(".dash-luck-range", box);
    luck.oninput = () => { el(".dash-luckv", box).textContent = luck.value; };
    let dragged = false;   // after a drag, let go of focus so the panel keeps refreshing; arrow keys keep it
    luck.onpointerdown = () => { dragged = true; };
    luck.onkeydown = () => { dragged = false; };
    luck.onchange = () => {
      request({ type: "set_luck", agent_id: a.id, luck: Number(luck.value) }, { what: "luck", id: a.id });
      if (dragged) luck.blur();
    };
    for (const r of box.querySelectorAll("[data-trait]")) {
      r.oninput = () => { S.editingProfile = a.id; r.dataset.moved = "1"; r.nextElementSibling.textContent = Number(r.value).toFixed(2); };
    }
    el(".dash-prompt", box).oninput = () => { S.editingProfile = a.id; };
    el(".dash-saveprof", box).onclick = () => {
      // Only the sliders God moved, so the others keep what the profile has learned since.
      const out = {};
      for (const r of box.querySelectorAll("[data-trait][data-moved]")) out[r.dataset.trait] = Number(r.value);
      const prompt = el(".dash-prompt", box).value;
      request({ type: "set_profile", agent_id: a.id, traits: out, prompt: prompt !== (a.profile && a.profile.prompt) ? prompt : null }, { what: "profile", id: a.id });
      S.editingProfile = null;
      S.detailKey = "";
    };
  }
  function liveHtml(a) {
    const wp = a.worth_parts || { cash: a.money, savings: a.savings || 0, home: 0 };
    const nw = a.net_worth != null ? a.net_worth : (wp.cash || 0) + (wp.savings || 0) + (wp.home || 0);
    const savings = a.savings != null ? a.savings : (a.possessions && a.possessions.savings);
    const funds = a.household_funds != null ? a.household_funds : (a.possessions && a.possessions.household_funds);
    const bars = Object.entries(a.needs || {}).map(([k, v]) => `
      <div class="dash-need"><span>${k}</span><span class="dash-track"><span class="dash-fill" style="width:${clamp(v, 0, 100)}%;background:${NEED_COLOR[k] || "#9aa5b8"}"></span></span><b>${round(v)}</b></div>`).join("");
    const place = a.place ? ` at ${esc(placeName(a.place))}` : "";
    return `
      <p class="dash-now">${a.alive ? `Now: <b>${esc(pretty(a.activity))}</b>${place}${a.state === "deciding" ? ' <span class="dash-tag model">deciding…</span>' : ""}` : "<b>Died</b>"}</p>
      <div class="dash-money">
        <div><span>Cash</span><b class="${a.money < 0 ? "neg" : ""}">${money(a.money)}</b></div>
        <div><span>Savings</span><b>${money(savings)}</b></div>
        <div><span>Household money</span><b class="${funds < 0 ? "neg" : ""}">${money(funds)}</b></div>
        <div><span>Net worth</span><b class="${nw < 0 ? "neg" : ""}">${money(nw)}</b></div>
      </div>
      ${barHtml({ cash: wp.cash, savings: wp.savings, homeEq: wp.home, worth: nw }, Math.max(nw, 1))}
      <div class="dash-parts small"><span><i class="c"></i>cash ${money(wp.cash)}</span><span><i class="s"></i>savings ${money(wp.savings)}</span><span><i class="h"></i>home ${money(wp.home)}</span></div>
      <div class="dash-stats"><span>Health <b>${round(a.health)}</b></span><span>Mood <b>${a.mood}</b></span><span>Reputation <b>${a.reputation}</b></span><span>Luck <b>${round(a.luck)}</b></span></div>
      ${bars}`;
  }
  function emergencyHtml(e) {
    if (!e) return "";
    const kind = typeof e === "string" ? e : e.kind;
    return `<div class="dash-emerg">${icon("alert")}<div><b>${esc(pretty(kind).replace(/^\w/, c => c.toUpperCase()))}</b>${e.text ? ` ${esc(e.text)}` : ""}${e.since ? `<div class="dash-muted">since ${esc(e.since)}</div>` : ""}</div></div>`;
  }
  function ownsHtml(a) {
    const p = a.possessions || {}, h = p.home;
    let home = "";
    if (h) {
      const owned = h.tenure === "owned";
      const cost = owned ? `${money(h.weekly_cost)}/week${h.property_tax ? " property tax" : ""}` : `${money(h.weekly_cost != null ? h.weekly_cost : h.weekly_rent)}/week rent`;
      home = `<div class="dash-ownhome">
        <div class="dash-ownhead">${icon(h.tier === "flat" ? "flat" : owned ? "own" : "rent")}<b>${esc(h.name)}</b>${h.stage != null ? stageChip(h.stage, h.condition) : ""}</div>
        <div class="dash-muted">${esc(h.tier_label || tierLabel(h.tier))} · ${esc(districtName(h.district))}${h.bedrooms ? ` · ${plural(h.bedrooms, "bedroom")}` : ""} · ${owned ? "owned" : `rented from ${esc(h.landlord || landlordName())}`}</div>
        <dl class="dash-kv2"><dt>Weekly cost</dt><dd>${cost}</dd><dt>Value</dt><dd>${money(h.value)}</dd>${h.stage_name ? `<dt>Condition</dt><dd>${esc(h.stage_name)}, ${round(h.condition)} of 100</dd>` : ""}${h.moved_in ? `<dt>Moved in</dt><dd>${esc(h.moved_in)}</dd>` : ""}</dl>
        ${h.emergency ? emergencyHtml(h.emergency) : ""}
        <button type="button" class="dash-btn" data-act="home" data-home="${esc(h.id)}">Home card</button>
      </div>`;
    }
    const goal = p.savings_goal;
    return `${home}<ul class="dash-list">
      <li>${p.car ? "A car" : "No car"}</li>
      ${p.phone ? `<li>Phone <span class="dash-muted">${esc(p.phone.condition)}</span></li>` : ""}
      ${p.groceries_at_home != null ? `<li>${plural(p.groceries_at_home, "meal")} in the fridge</li>` : ""}
      ${goal ? `<li>Saving for ${esc(goal.name)} <span class="dash-muted">${money(goal.saved)} of ${money(goal.target)}</span></li>` : ""}
    </ul>`;
  }

  // The home card (decision 76): a house or a flat comes from get_home; a block lists its 6 flats.
  function openHome(id, opts) {
    if (!S || !S.town) return;
    const o = opts || {};
    const p = S.placeById[id];
    const block = !!(p && p.kind === "home" && p.units > 1);
    if (!block && !S.homeById[id]) { notice("Not done: unknown home"); return; }
    let stack = [];
    if (o.keepStack && S.card) stack = S.card.stack;
    else if (o.fromCard && S.card) stack = S.card.stack.concat([S.card.id]);
    S.card = { id, block, page: null, error: null, stale: false, stack, from: o.fromDetail ? "detail" : S.card ? S.card.from : null };
    if (!block) { S.cardAsk = performance.now(); request({ type: "get_home", home_id: id }, { what: "home", id }); }
    const place = block ? id : S.homeById[id].place;
    if (o.focus) focusMap({ place });
    highlightFor([], [place], 4000);
    openTab("people");
    renderPeople();
    if (S.cardBox && !S.cardBox.hidden) S.bodies.people.scrollTop = 0;
  }
  function closeCard() {
    if (!S.card) return;
    const stack = S.card.stack.slice();
    if (stack.length) {
      const prev = stack.pop();
      openHome(prev, {});
      if (S.card) S.card.stack = stack;
      return;
    }
    S.card = null;
    renderPeople();
  }
  function renderCard(box) {
    const c = S.card;
    const backTo = c.stack.length ? "← Back" : S.selected ? `← ${esc(first((S.agentById[S.selected] || {}).name || "Back"))}` : "← Everyone";
    if (c.block) { setHtml(box, blockCardHtml(c.id, backTo)); return; }
    const spec = S.homeById[c.id];
    if (c.error) { setHtml(box, `<button type="button" class="dash-back">${backTo}</button><h2>${esc(spec.name)}</h2><div class="dash-empty">Not done: ${esc(c.error)}</div>`); return; }
    const h = c.page;
    if (!h) { setHtml(box, `<button type="button" class="dash-back">${backTo}</button><h2>${esc(spec.name)}</h2><div class="dash-muted">Loading…</div>`); return; }
    setHtml(box, homeCardHtml(h, backTo));
  }
  function ownerLine(h) {
    const hh = h.hh ? (h.household_name || hhName(h.hh)) : null;
    if (h.owner === h.hh && hh) return `Owned by <b>${esc(hh)}</b>, who live here`;
    if (hh) return `Rented from <b>${esc(h.owner === "landlord" ? landlordName() : h.owner === "market" ? "the market" : hhName(h.owner))}</b> by <b>${esc(hh)}</b>`;
    if (h.listing === "for_sale") return `<span class="dash-mk for_sale">sale</span> For sale at <b>${money(h.price)}</b>`;
    if (h.listing === "for_rent") return `<span class="dash-mk for_rent">to let</span> To let at <b>${money(h.price)}/week</b> from ${esc(landlordName())}`;
    return h.owner === "landlord" ? `Empty · owned by ${esc(landlordName())}` : "Empty";
  }
  function homeCardHtml(h, backTo) {
    const hhRow = h.hh ? S.hhById[h.hh] : null;
    const weekly = hhRow && hhRow.weekly_cost != null ? `${money(hhRow.weekly_cost)}/week${hhRow.tenure === "owned" ? " (property tax)" : " rent"}`
      : h.listing === "for_rent" || (h.owner === "landlord" && h.rent) ? `${money(h.rent)}/week rent` : null;
    const lot = S.lots[h.place];
    const hist = (h.history || []).slice().reverse().map(x => `<li><span class="dash-muted">${esc(x.time)}</span> ${esc(x.event)}${x.household ? ` · ${esc(hhName(x.household))}` : ""}${x.price ? ` · ${money(x.price)}${x.event === "rented" ? "/week" : ""}` : ""}</li>`).join("");
    const residents = (h.residents || []).map(n => `<button type="button" class="dash-pchip" data-person="${esc(n)}">${esc(n)}</button>`).join("");
    const isFlat = !!h.unit;
    return `<button type="button" class="dash-back">${backTo}</button>
      <h2>${icon(isFlat ? "flat" : h.hh && h.owner === h.hh ? "own" : "rent")}${esc(h.name)}</h2>
      <div class="dash-muted">${esc(tierLabel(h.tier))} · ${plural(h.bedrooms, "bedroom")} · ${esc(districtName(h.district))}</div>
      <p class="dash-owner">${ownerLine(h)}</p>
      <div class="dash-cond">${stageChip(h.stage, h.condition)}<span class="dash-track"><span class="dash-fill" style="width:${clamp(h.condition, 0, 100)}%;background:${STAGE_COLOR[h.stage]}"></span></span>
        ${lot && lot.works ? '<span class="dash-tag">builders in</span>' : ""}${lot && lot.moving ? '<span class="dash-tag">moving</span>' : ""}</div>
      <dl class="dash-kv2"><dt>Value</dt><dd>${money(h.value)}</dd><dt>Condition</dt><dd>${esc(h.stage_name || STAGE_NAME[h.stage])}, ${round(h.condition)} of 100${isFlat ? " (the whole block)" : ""}</dd>
        ${weekly ? `<dt>Weekly cost</dt><dd>${weekly}</dd>` : ""}${h.listing === "for_sale" ? `<dt>Asking price</dt><dd>${money(h.price)}</dd>` : ""}</dl>
      ${h.emergency ? emergencyHtml(h.emergency) : ""}
      <h3>Residents</h3>${residents ? `<div class="dash-chiprow">${residents}</div>` : '<div class="dash-muted">Nobody lives here.</div>'}
      <div class="dash-acts"><button type="button" class="dash-btn" data-act="map">Show on map</button>${isFlat ? `<button type="button" class="dash-btn" data-act="block">All 6 flats</button>` : ""}</div>
      ${hist ? `<h3>History</h3><ul class="dash-list">${hist}</ul>` : ""}`;
  }
  function blockCardHtml(placeId, backTo) {
    const p = S.placeById[placeId], lot = S.lots[placeId], units = S.unitsOf[placeId] || [];
    const stage = stageOf(lot);
    const lived = units.filter(u => S.homes[u.id] && S.homes[u.id].hh).length;
    const byUnit = {};
    for (const u of units) byUnit[u.unit] = u;
    const floors = [];
    for (let f = 3; f >= 1; f--) floors.push(["A", "B"].map(side => byUnit[`${f}${side}`]).filter(Boolean));
    const unitHtml = u => {
      const st = S.homes[u.id] || {};
      const who = st.hh ? esc(hhName(st.hh)) : st.listing === "for_rent" ? `<span class="dash-mk for_rent">to let</span> ${money(st.price)}/wk` : "empty";
      return `<button type="button" class="dash-unit${st.hh ? " lived" : ""}" data-unit="${esc(u.id)}"><b>${esc(u.unit)}</b><span class="dash-muted">${plural(u.bedrooms, "bed")}</span><span class="dash-unit-who">${who}</span>${st.emergency ? `<span class="dash-unit-alert" title="${esc(pretty(st.emergency))}">${icon("alert")}</span>` : ""}</button>`;
    };
    return `<button type="button" class="dash-back">${backTo}</button>
      <h2>${icon("flat")}${esc(p ? p.name : placeId)}</h2>
      <div class="dash-muted">${units.length} flats · ${esc(districtName(p && p.district))} · ${esc(landlordName())} · ${lived} lived in</div>
      <div class="dash-cond">${lot ? stageChip(stage, lot.condition) : ""}<span class="dash-track"><span class="dash-fill" style="width:${lot ? clamp(lot.condition, 0, 100) : 0}%;background:${STAGE_COLOR[stage]}"></span></span>
        ${lot && lot.works ? '<span class="dash-tag">builders in</span>' : ""}${lot && lot.moving ? '<span class="dash-tag">moving</span>' : ""}</div>
      <div class="dash-legend-note">The building's condition is shared by all six flats. Top floor first.</div>
      <div class="dash-units">${floors.map(row => `<div class="dash-floor">${row.map(unitHtml).join("")}</div>`).join("")}</div>
      <div class="dash-acts"><button type="button" class="dash-btn" data-act="map">Show on map</button></div>`;
  }

  // --- the public object -------------------------------------------------------------------------------

  const Dash = {
    init,
    welcome,
    frame,
    stats,
    reply,
    message,
    pick,
    hover,
    tooltipText: hit => (S ? tooltipText(hit) : ""),
    viewSelected,
    selectAgent,
    selected: () => (S ? S.selected : null),
    openTab,
    openHome: (id, opts) => openHome(id, Object.assign({ focus: true }, opts || {})),
    setOverlay,
    characterHref,
    notice,
    setRole,
    layout: () => { if (S) { updateMode(); layout(); } },
    inspect: () => (S ? {
      tab: S.tab, selected: S.selected, card: S.card ? S.card.id : null, overlay: S.overlay, mode: S.mode, phone: S.phone,
      sheet: S.sheet, collapsed: S.collapsed, unread: S.unread, events: S.ev.size, forks: S.forks.size,
      samples: S.samples.length, inset: Object.assign({}, S.inset), toasts: S.toasts.map(t => t.kind), role: S.role,
      host: Object.assign({}, S.host),
    } : null),
    TOPIC_OF_TAG,
    RAMPS,
    fmt: { money, compact, stamp },
  };
  window.Dash = Dash;
})();

// GameOfAILife character page: who a character is, their home, and their editable play-style profile.
//
// This is a standalone page (character.html?id=<agent id>) with its own WebSocket. Reading a
// character (get_agent) and saving a profile (set_profile) are God messages, and the server keeps
// one God per city, so the page asks before it says hello as God: doing so moves any other God
// tab to watching. If another tab takes God back, this page notices ("demoted") and stops saving.
"use strict";

const TRAITS = {
  // [what 1.0 means, what 0.0 means], matching Profile.describe on the server.
  thrift: ["careful with money", "spends freely"],
  family: ["puts family first", "values independence"],
  social: ["loves company", "enjoys time alone"],
  diligence: ["never late for work", "takes work lightly"],
  health: ["looks after their health", "ignores their health"],
  adventure: ["tries new things", "sticks to routine"],
};
const STAGES = ["kept", "worn", "shabby", "neglected", "derelict"];
const STAGE_COLORS = ["#6fcf7c", "#b8d46a", "#f6c445", "#ef9b4b", "#ef6b6b"]; // kept .. derelict
const HISTORY_WORDS = { bought: "Bought", rented: "Moved into", sold: "Sold", left: "Left", evicted: "Evicted from",
                        forced_sale: "Forced to sell" };
const CONSENT_KEY = "goal.character.god-ok";
const FROM_CITY_KEY = "goal.character.from-city"; // left by a plain click on the city view's link
const REFRESH_MS = 2000;

const $ = id => document.getElementById(id);
let ws = null;
let role = null;         // "god" | "observer" | null
let agents = [];         // roster from state frames
let current = null;      // last agent payload from the server
let selectedId = null;
let dirty = false;       // the player has unsaved edits in the form
let formPrompt = "";     // the prompt text the form was last filled with
const touched = new Set(); // traits the player moved since the form was filled
let reqSeq = 0;
let pendingSave = null;  // req_id of the save we are waiting on
let lastAsk = 0;
let released = false;
let districtNames = {};  // district id -> name, from welcome.town.districts

// --- helpers ------------------------------------------------------------------

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function pretty(s) { return String(s || "").replace(/_/g, " "); }
function title(s) { return pretty(s).replace(/\b\w/g, c => c.toUpperCase()); }
function cap(s) { s = String(s || ""); return s.charAt(0).toUpperCase() + s.slice(1); }
function dollars(n) { return `$${Math.round(Number(n) || 0).toLocaleString("en-US")}`; }
function districtName(id) { return districtNames[id] || title(id); }
function dayOf(stamp) { return String(stamp || "").split(" ").slice(0, 2).join(" "); } // "Day 12 Fri 18:20" -> "Day 12"
function hash(s) {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}
function shirt(id) { return `hsl(${hash(id) % 360} 65% 55%)`; }
function hair(id) { return ["#3b2416", "#6b4423", "#1d1d1d", "#c9a14a", "#8a3b1c", "#b8b8b8"][hash(id + "h") % 6]; }
function storage(fn) { try { return fn(window.sessionStorage); } catch { return null; } }

function lean(trait, v) {
  const [hi, lo] = TRAITS[trait];
  if (v >= 0.8) return `strongly ${hi}`;
  if (v >= 0.6) return hi;
  if (v > 0.4) return "in between";
  if (v > 0.2) return lo;
  return `strongly ${lo}`;
}

function send(msg) {
  if (!ws || ws.readyState !== 1) return null;
  msg.req_id = `c${++reqSeq}`;
  ws.send(JSON.stringify(msg));
  return msg.req_id;
}

function banner(html, kind = "") {
  const b = $("banner");
  if (!html) { b.hidden = true; return; }
  b.className = `banner ${kind}`;
  b.innerHTML = html;
  b.hidden = false;
  const again = b.querySelector("[data-action=retake]");
  if (again) again.onclick = () => { released = false; connect(); };
}

// --- connection -----------------------------------------------------------------

function connect() {
  if (ws) { ws.onclose = null; ws.close(); }
  $("role").textContent = "Connecting…";
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.onopen = () => ws.send(JSON.stringify({ type: "hello", role: "god" }));
  ws.onmessage = ev => onMessage(JSON.parse(ev.data));
  ws.onclose = () => {
    role = null;
    updateRole();
    if (released) return;
    $("role").textContent = "Disconnected, retrying…";
    setTimeout(() => { if (!released) connect(); }, 1500);
  };
}

function onMessage(msg) {
  if (msg.type === "welcome") {
    role = "god";
    updateRole();
    $("gate").hidden = true;
    $("page").hidden = false;
    banner("This page is God of the city now. Other God tabs are only watching until you give God back and reload them.", "info");
    for (const d of (msg.town && msg.town.districts) || []) districtNames[d.id] = d.name;
    setClock(msg.state);
    roster(msg.state.agents);
    ask();
  } else if (msg.type === "state") {
    setClock(msg.state);
    roster(msg.state.agents);
    if (performance.now() - lastAsk > REFRESH_MS) ask();
  } else if (msg.type === "agent") {
    const saved = pendingSave && msg.req_id === pendingSave;
    if (msg.agent.id !== selectedId) return;
    if (saved) { pendingSave = null; dirty = false; }
    current = msg.agent;
    render(saved ? "all" : dirty ? "keep-form" : "live");
    if (saved) {
      status(`Saved. ${current.name} will play this way from now on${current.profile.edited ? ", using your words" : ""}.`, "ok");
      for (const el of document.querySelectorAll(".trait.changed")) el.classList.remove("changed");
    }
  } else if (msg.type === "demoted") {
    role = "observer";
    updateRole();
    banner('Another tab took over God, so this page is only watching and cannot save. <button class="btn" data-action="retake">Take God back</button>');
  } else if (msg.type === "error") {
    if (pendingSave && msg.req_id === pendingSave) { pendingSave = null; status(`Not saved: ${msg.error}`, "err"); }
  }
}

function setClock(s) { $("clock").textContent = `${s.time} · ${s.season}`; }

function updateRole() {
  const label = role === "god" ? "God (this tab)" : role === "observer" ? "Watching" : released ? "Not God" : "Not connected";
  $("role").textContent = label;
  $("save").disabled = role !== "god";
}

function ask() {
  if (!selectedId) return;
  lastAsk = performance.now();
  send({ type: "get_agent", agent_id: selectedId });
}

// --- roster and selection ---------------------------------------------------------

function roster(list) {
  const changed = list.length !== agents.length || list.some((a, i) => !agents[i] || agents[i].id !== a.id || agents[i].alive !== a.alive);
  agents = list;
  if (!selectedId || !agents.some(a => a.id === selectedId)) {
    const want = new URLSearchParams(location.search).get("id");
    selectedId = (agents.find(a => a.id === want) || agents[0] || {}).id || null;
    if (want && selectedId !== want) status(`No character called “${want}”; showing ${agents[0]?.name}.`, "err");
    syncUrl();
  }
  if (!changed && $("who").options.length === agents.length) return;
  const sel = $("who");
  sel.innerHTML = agents.map(a => `<option value="${esc(a.id)}">${esc(a.name)}${a.alive ? "" : " (died)"} · ${a.age}</option>`).join("");
  sel.value = selectedId;
  sel.disabled = false;
}

function choose(id) {
  if (id === selectedId) return;
  if (dirty && !confirm("You have unsaved play-style edits. Leave them?")) { $("who").value = selectedId; return; }
  selectedId = id; current = null; dirty = false; pendingSave = null;
  status("");
  syncUrl();
  ask();
}

function syncUrl() {
  if (!selectedId) return;
  const url = new URL(location.href);
  url.searchParams.set("id", selectedId);
  history.replaceState(null, "", url);
}

// --- rendering ---------------------------------------------------------------------

function render(mode) {
  const a = current;
  if (!a) return;
  document.title = `${a.name} · GameOfAILife`;
  drawFace(a);
  $("name").textContent = a.name + (a.alive ? "" : " (died)");
  const job = a.job ? `${a.job.title}` : a.age < 18 ? "at school" : "retired";
  $("subtitle").textContent = `${a.age} years old · ${job}`;

  const hours = a.job ? `${a.job.hours[0]}:00–${a.job.hours[1]}:00${a.job.hourly_wage ? `, $${a.job.hourly_wage}/h` : ""}` : "";
  const goal = a.possessions.savings_goal;
  $("facts").innerHTML = [
    ["Job", a.job ? `${esc(a.job.title)} <span class="small">${esc(hours)}</span>` : esc(job)],
    ["Home", homeLine(a.possessions.home)],
    ["Now", a.alive ? `${esc(pretty(a.activity))}` : "—"],
    ["Money", `$${Number(a.money).toFixed(0)}${a.savings != null ? ` <span class="small">+ ${dollars(a.savings)} saved</span>` : ""}`],
    ["Health · mood", `${Math.round(a.health)} · ${a.mood}`],
    ["Luck", `${Math.round(a.luck)}`],
    ["Played by", a.controller ? esc(a.controller) : '<span class="small">their profile (no controller)</span>'],
    ...(goal ? [["Saving for", `${esc(goal.name)} <span class="small">$${goal.saved} of $${goal.target}</span>`]] : []),
  ].map(([k, v]) => `<span class="k">${k}</span><span>${v}</span>`).join("");

  $("household").innerHTML = (a.household || []).map(n =>
    `<li>${esc(n)}${n === a.name ? ' <span class="small">(this character)</span>' : ""}</li>`).join("") || '<li class="small">Lives alone.</li>';

  const rels = Object.entries(a.relationships || {});
  $("rels").innerHTML = rels.map(([, r]) => {
    const pct = (r.affinity + 100) / 2;
    const col = r.affinity >= 0 ? "var(--good)" : "var(--bad)";
    return `<li><span class="grow">${esc(r.name)} <span class="tag">${esc(r.kind)}</span></span>
      <span class="meter" title="affinity ${r.affinity}"><span style="width:${pct}%;background:${col}"></span></span>
      <span class="small">${r.affinity > 0 ? "+" : ""}${r.affinity}</span></li>`;
  }).join("") || '<li class="small">Nobody yet.</li>';

  renderHome(a);

  if (mode !== "keep-form") renderForm(a, mode === "live");
  $("promptnote").textContent = a.profile.edited
    ? "Written by you. The sliders still learn from choices, but these words stay until you change them."
    : "Written from the sliders. It rewrites itself as the character's choices teach the profile, until you edit it.";

  const learned = (a.profile.learned || []).slice().reverse();
  $("learned").innerHTML = learned.map(l => `<li>${esc(l)}</li>`).join("") ||
    '<li class="small">Nothing yet. Lessons appear when a controller (a person or an AI) answers one of this character\'s decisions.</li>';

  const forks = (a.forks || []).slice().reverse();
  $("forks").innerHTML = forks.map(f => {
    // The same badge classes as the city view, with friendlier words.
    const label = { default: "profile", timeout: "timed out", model: "controller" }[f.decided_by] || f.decided_by;
    const by = `<span class="tag ${esc(f.decided_by)}">${esc(label)}</span>`;
    const major = f.major ? ' <span class="tag major" title="A big decision: habit settles it only when the choice is very clear">major</span>' : "";
    const pick = Number.isInteger(f.profile_choice) ? f.profile_choice : null;
    // Only a controller's answer can differ from the profile: a profile play (habit, default or timeout) is the
    // profile's own pick, with the Director's noise, even when that isn't the noiseless top score.
    const asked = f.decided_by === "model";
    const opts = (f.options || []).map((o, i) => {
      const mark = asked && i === pick && i !== f.choice ? ' <span class="small" title="What the play-style profile would have picked">(profile)</span>' : "";
      return `<li class="${i === f.choice ? "chosen" : ""}">${i === f.choice ? "▶ " : ""}${esc(o)}${mark}</li>`;
    }).join("");
    const happened = Array.isArray(f.happened) ? f.happened.join(" · ") : f.happened;
    return `<li><span class="time">${esc(f.time)} ${by}${major}</span><span class="q">${esc(f.question)}</span>
      <ul class="opts">${opts}</ul>${forkMeta(f, pick)}${f.reason ? `<span class="small">${esc(f.reason)}</span>` : ""}
      ${happened ? `<div class="small">${esc(happened)}</div>` : ""}</li>`;
  }).join("") || '<li class="small">No decisions yet.</li>';
}

// Who was asked, how fast they answered, a late answer, and whether the profile agreed (section 3.6).
function forkMeta(f, pick) {
  const bits = [];
  if (f.controller) {
    bits.push(`asked ${esc(f.controller)}${f.model ? ` <span class="tag">${esc(f.model)}</span>` : ""}`);
  }
  if (f.decided_by === "model" && f.answer_seconds != null) bits.push(`answered in ${Number(f.answer_seconds).toFixed(1)} s`);
  if (f.late && Number.isInteger(f.late.choice)) {
    const opt = (f.options || [])[f.late.choice];
    bits.push(`answered late${f.late.seconds != null ? ` (${Number(f.late.seconds).toFixed(1)} s)` : ""}: “${esc(opt)}”, saved to the profile`);
  }
  if (pick != null && f.decided_by === "model") {
    bits.push(pick === f.choice ? "the profile agreed" : "the profile would have picked another option");
  }
  return bits.length ? `<div class="small meta">${bits.join(" · ")}</div>` : "";
}

// --- the home --------------------------------------------------------------------

// The facts line: "28 Main Street · owned" or "Birch Court, flat 2B · rented, $220/week".
function homeLine(h) {
  if (!h) return "—";
  const rented = h.tenure !== "owned";
  const cost = rented ? `rented, $${h.weekly_cost ?? h.weekly_rent}/week` : "owned";
  return `${esc(h.name)} <span class="small">${esc(cost)}</span>`;
}

function renderHome(a) {
  const h = a.possessions && a.possessions.home;
  if (!h) { $("home").innerHTML = '<span class="small">No home.</span>'; $("homehist").innerHTML = ""; return; }
  const history = a.home_history || [];
  const rows = [];
  const beds = h.bedrooms ? `, ${h.bedrooms} bedroom${h.bedrooms === 1 ? "" : "s"}` : "";
  const where = h.district ? ` in ${esc(districtName(h.district))}` : "";
  rows.push(`<div class="hname">${esc(h.name)}</div>
    <div class="small">${h.tier_label ? `a ${esc(h.tier_label)}${where}${beds}` : ""}</div>`);
  const facts = [];
  if (h.tenure === "owned") {
    const bought = history.slice().reverse().find(r => r.event === "bought" && r.home === h.id);
    const how = bought ? ` <span class="small">(bought ${esc(dayOf(bought.time))} for ${dollars(bought.price)})</span>` : "";
    facts.push(["Tenure", `Owned, worth about ${dollars(h.value)}${how}`]);
  } else {
    const rate = h.weekly_cost != null && h.weekly_cost < h.weekly_rent
      ? ` <span class="small">(hardship rate $${h.weekly_cost} instead of $${h.weekly_rent})</span>` : "";
    facts.push(["Tenure", `Rented from ${esc(h.landlord || "the landlord")}, $${h.weekly_rent}/week${rate}`]);
    if (h.value != null) facts.push(["Value", `${dollars(h.value)} <span class="small">on the market</span>`]);
  }
  if (h.condition != null) {
    const st = Number.isInteger(h.stage) ? h.stage : Math.max(0, STAGES.length - 1 - Math.floor(h.condition / 20));
    const bar = STAGES.map((_, i) => `<span style="background:${i <= STAGES.length - 1 - st ? STAGE_COLORS[st] : "#151a24"}"></span>`).join("");
    facts.push(["Condition", `${esc(cap(h.stage_name || STAGES[st]))}, ${Math.round(h.condition)}/100
      <span class="stagebar" title="${esc(h.stage_name || STAGES[st])}">${bar}</span>`]);
  }
  if (h.comfort != null) {
    const pct = Math.round((h.comfort - 1) * 100);
    facts.push(["Comfort", pct ? `Home comfort ${pct > 0 ? "+" : "−"}${Math.abs(pct)}%` : "Home comfort as usual"]);
  }
  if (h.weekly_cost != null) {
    const what = h.tenure === "owned" ? (h.property_tax && !h.weekly_cost ? "property tax deferred" : "property tax") : "rent";
    facts.push(["Weekly cost", `$${h.weekly_cost} <span class="small">(${what})</span>`]);
  }
  if (h.moved_in) facts.push(["Moved in", esc(h.moved_in)]);
  if (a.household_funds != null) {
    facts.push(["Household money", `${dollars(a.household_funds)} <span class="small">(savings and cash of the adults)</span>`]);
  }
  if (a.net_worth != null) {
    const p = a.worth_parts || {};
    facts.push(["Net worth", `${dollars(a.net_worth)} <span class="small">cash ${dollars(p.cash)}, savings ${dollars(p.savings)}, home ${dollars(p.home)}</span>`]);
  }
  rows.push(`<div class="facts">${facts.map(([k, v]) => `<span class="k">${k}</span><span>${v}</span>`).join("")}</div>`);
  if (h.emergency) {
    rows.push(`<div class="emergency" role="status">${esc(h.emergency.text || "Something has broken.")}
      <span class="small">since ${esc(h.emergency.since)}</span></div>`);
  }
  $("home").innerHTML = rows.join("");
  $("homehist").innerHTML = history.slice().reverse().map(r =>
    `<li><span class="time">${esc(r.time)}</span> ${esc(HISTORY_WORDS[r.event] || cap(pretty(r.event)))} ${esc(r.name || r.home)}${
      r.price ? ` <span class="small">${r.event === "rented" ? `$${r.price}/week` : dollars(r.price)}</span>` : ""}</li>`).join("")
    || '<li class="small">Has lived here since the start.</li>';
}

// The sliders are built once and then updated in place: replacing them on every refresh would cancel
// a drag in progress and drop keyboard focus. A live refresh also leaves the focused field alone.
function renderForm(a, live) {
  const skip = live ? document.activeElement : null;
  if (skip !== $("prompt")) { $("prompt").value = a.profile.prompt; formPrompt = a.profile.prompt; }
  touched.clear();
  if (!$("traits").children.length) {
    $("traits").innerHTML = Object.keys(TRAITS).map(t => {
      const [hi, lo] = TRAITS[t];
      return `<div class="trait" data-wrap="${t}">
        <div class="top"><span class="tname">${t}</span><span class="now" data-now="${t}"></span></div>
        <input type="range" min="0" max="1" step="0.01" data-trait="${t}" aria-label="${t}: 0 ${lo}, 1 ${hi}">
        <div class="ends"><span>◀ ${lo}</span><span>${hi} ▶</span></div>
      </div>`;
    }).join("");
    for (const r of document.querySelectorAll("[data-trait]")) {
      r.oninput = () => {
        const t = r.dataset.trait, v = Number(r.value);
        touched.add(t);
        document.querySelector(`[data-now=${t}]`).textContent = `${lean(t, v)} · ${v.toFixed(2)}`;
        document.querySelector(`[data-wrap=${t}]`).classList.toggle("changed", Math.abs(v - (current.profile.traits[t] ?? 0.5)) > 0.001);
        edited();
      };
    }
  }
  for (const r of document.querySelectorAll("[data-trait]")) {
    const t = r.dataset.trait, v = a.profile.traits[t] ?? 0.5;
    document.querySelector(`[data-wrap=${t}]`).classList.remove("changed");
    if (r === skip) continue;
    r.value = v;
    document.querySelector(`[data-now=${t}]`).textContent = `${lean(t, v)} · ${v.toFixed(2)}`;
  }
}

function edited() { dirty = true; status("Unsaved changes."); }

function status(text, kind = "") {
  const s = $("savestatus");
  s.textContent = text;
  s.className = `small ${kind}`;
}

function drawFace(a) {
  const c = $("face").getContext("2d");
  c.clearRect(0, 0, 16, 16);
  const child = a.age < 13, top = child ? 4 : 1;
  c.fillStyle = "rgba(0,0,0,.25)"; c.fillRect(4, 14, 8, 2);
  c.fillStyle = "#2e3a59"; c.fillRect(5, top + 10, 2, child ? 2 : 3); c.fillRect(9, top + 10, 2, child ? 2 : 3);
  c.fillStyle = shirt(a.id); c.fillRect(4, top + 5, 8, 6);
  c.fillStyle = "#f1c6a0"; c.fillRect(5, top, 6, 5);
  c.fillStyle = a.age >= 65 ? "#d0d0d0" : hair(a.id); c.fillRect(4, top - 1, 8, 2);
  c.fillStyle = "#222"; c.fillRect(6, top + 2, 1, 1); c.fillRect(9, top + 2, 1, 1);
  if (!a.alive) { c.fillStyle = "rgba(20,20,30,.55)"; c.fillRect(0, 0, 16, 16); }
}

// --- saving ------------------------------------------------------------------------

function save() {
  if (!current) return;
  if (role !== "god") { status("Not saved: this page is only watching. Take God back first.", "err"); return; }
  const traits = {};
  for (const r of document.querySelectorAll("[data-trait]")) if (touched.has(r.dataset.trait)) traits[r.dataset.trait] = Number(r.value);
  const text = $("prompt").value.trim();
  if (!text && current.profile.prompt) { status("The prompt can't be empty; write something or press Undo edits.", "err"); return; }
  // Send only what the player changed since the form was filled, so an untouched prompt keeps
  // learning and untouched sliders keep what the profile learned meanwhile.
  const prompt = text !== formPrompt.trim() ? text : null;
  pendingSave = send({ type: "set_profile", agent_id: current.id, prompt, traits });
  status(pendingSave ? "Saving…" : "Not saved: not connected.", pendingSave ? "" : "err");
}

// --- wiring --------------------------------------------------------------------------

$("who").onchange = e => choose(e.target.value);
$("prompt").oninput = edited;
$("save").onclick = save;
$("revert").onclick = () => { dirty = false; status("Edits thrown away."); render("all"); };
$("release").onclick = () => {
  released = true;
  if (ws) ws.close();
  $("save").disabled = true;
  banner('God is free. Reload the city tab to be God there again. <button class="btn" data-action="retake">Take God here again</button>', "info");
};
$("takeover").onclick = () => {
  if ($("remember").checked) storage(s => s.setItem(CONSENT_KEY, "1"));
  $("gate").hidden = true;
  connect();
};
window.addEventListener("beforeunload", e => { if (dirty) { e.preventDefault(); e.returnValue = ""; } });

// A plain click on the city view's link opens this page in that same tab, which lets go of God as it
// unloads, so there is nothing to ask. The click leaves a one-shot note; a new tab, a reload or a
// bookmark finds none and asks first.
const note = storage(s => { const t = s.getItem(FROM_CITY_KEY); s.removeItem(FROM_CITY_KEY); return t; });
const fromCity = note !== null && Date.now() - Number(note) < 10000;
if (fromCity || storage(s => s.getItem(CONSENT_KEY)) === "1") connect();
else { $("gate").hidden = false; $("role").textContent = "Not God yet"; }

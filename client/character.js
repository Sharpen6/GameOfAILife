// GameOfAILife character page: who a character is, and their editable play-style profile.
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
const CONSENT_KEY = "goal.character.god-ok";
const REFRESH_MS = 2000;

const $ = id => document.getElementById(id);
let ws = null;
let role = null;         // "god" | "observer" | null
let agents = [];         // roster from state frames
let current = null;      // last agent payload from the server
let selectedId = null;
let dirty = false;       // the player has unsaved edits in the form
let reqSeq = 0;
let pendingSave = null;  // req_id of the save we are waiting on
let lastAsk = 0;
let released = false;

// --- helpers ------------------------------------------------------------------

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function pretty(s) { return String(s || "").replace(/_/g, " "); }
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
    roster(msg.state.agents);
    ask();
  } else if (msg.type === "state") {
    $("clock").textContent = `${msg.state.time} · ${msg.state.season}`;
    roster(msg.state.agents);
    if (performance.now() - lastAsk > REFRESH_MS) ask();
  } else if (msg.type === "agent") {
    const saved = pendingSave && msg.req_id === pendingSave;
    if (msg.agent.id !== selectedId) return;
    if (saved) { pendingSave = null; dirty = false; }
    current = msg.agent;
    render(saved ? "all" : dirty ? "keep-form" : "all");
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
    ["Home", `${esc(a.possessions.home.name)} <span class="small">rented, $${a.possessions.home.weekly_rent}/week</span>`],
    ["Now", a.alive ? `${esc(pretty(a.activity))}` : "—"],
    ["Money", `$${Number(a.money).toFixed(0)}`],
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

  if (mode !== "keep-form") renderForm(a);
  $("promptnote").textContent = a.profile.edited
    ? "Written by you. The sliders still learn from choices, but these words stay until you change them."
    : "Written from the sliders. It rewrites itself as the character's choices teach the profile, until you edit it.";

  const learned = (a.profile.learned || []).slice().reverse();
  $("learned").innerHTML = learned.map(l => `<li>${esc(l)}</li>`).join("") ||
    '<li class="small">Nothing yet. Lessons appear when a controller (a person or an AI) answers one of this character\'s decisions.</li>';

  const forks = (a.forks || []).slice().reverse();
  $("forks").innerHTML = forks.map(f => {
    const by = f.decided_by === "default" ? '<span class="tag habit">profile</span>'
      : f.decided_by === "timeout" ? '<span class="tag timeout">timed out</span>'
      : `<span class="tag model">${f.decided_by === "model" ? "controller" : esc(f.decided_by)}</span>`;
    const opts = (f.options || []).map((o, i) => `<li class="${i === f.choice ? "chosen" : ""}">${i === f.choice ? "▶ " : ""}${esc(o)}</li>`).join("");
    return `<li><span class="time">${esc(f.time)} ${by}</span><span class="q">${esc(f.question)}</span>
      <ul class="opts">${opts}</ul>${f.reason ? `<span class="small">${esc(f.reason)}</span>` : ""}
      ${f.happened ? `<div class="small">${esc(f.happened)}</div>` : ""}</li>`;
  }).join("") || '<li class="small">No decisions yet.</li>';
}

function renderForm(a) {
  $("prompt").value = a.profile.prompt;
  $("traits").innerHTML = Object.keys(TRAITS).map(t => {
    const v = a.profile.traits[t] ?? 0.5;
    const [hi, lo] = TRAITS[t];
    return `<div class="trait" data-wrap="${t}">
      <div class="top"><span class="tname">${t}</span><span class="now" data-now="${t}">${lean(t, v)} · ${v.toFixed(2)}</span></div>
      <input type="range" min="0" max="1" step="0.01" value="${v}" data-trait="${t}" aria-label="${t}: 0 ${lo}, 1 ${hi}">
      <div class="ends"><span>◀ ${lo}</span><span>${hi} ▶</span></div>
    </div>`;
  }).join("");
  for (const r of document.querySelectorAll("[data-trait]")) {
    r.oninput = () => {
      const t = r.dataset.trait, v = Number(r.value);
      document.querySelector(`[data-now=${t}]`).textContent = `${lean(t, v)} · ${v.toFixed(2)}`;
      document.querySelector(`[data-wrap=${t}]`).classList.toggle("changed", Math.abs(v - (current.profile.traits[t] ?? 0.5)) > 0.001);
      edited();
    };
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
  for (const r of document.querySelectorAll("[data-trait]")) traits[r.dataset.trait] = Number(r.value);
  const text = $("prompt").value.trim();
  if (!text && current.profile.prompt) { status("The prompt can't be empty; write something or press Undo edits.", "err"); return; }
  // Send the prompt only when the player changed it, so an untouched prompt keeps learning.
  const prompt = text !== current.profile.prompt.trim() ? text : null;
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

// Coming from the city view in this same tab, that view has already let go of God.
const fromCity = new URLSearchParams(location.search).get("from") === "city";
if (fromCity || storage(s => s.getItem(CONSENT_KEY)) === "1") connect();
else { $("gate").hidden = false; $("role").textContent = "Not God yet"; }

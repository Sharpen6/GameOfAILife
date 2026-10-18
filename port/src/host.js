// LocalHost: the browser port's stand-in for gameofailife/server.py, running the city in the page.
//
// It speaks the God side of the protocol exactly as GameServer does (docs/protocol.md, PLAN 3.2-3.9): the same
// `welcome` (with `host: {kind: "browser", controllers: false}` and the full `stats`), a `state` frame every
// flush, `stats` pushes on the PLAN 3.8 cadence, and the replies to set_luck, set_speed, pause, resume,
// get_agent, get_home, set_profile, get_stats, get_folk and get_decisions. Nothing plays a character from outside the
// page, so a controller's hello is refused and every fork is decided by habit or the profile's default.
//
// The client talks to it through `LocalHost.socket()`, a WebSocket look-alike: page.js installs it as
// window.WebSocket before game.js loads. Methods are in GameServer's order so a server.py diff maps here.
(function (G) {
  "use strict";
  const { hasOwn, getd, pyFloat, pyInt, pyStr, pyRepr, pyJsonLoads, PyError } = G.py;

  const FRAME_SECONDS = 0.05;
  const SPEEDS = [0, 1, 2, 4, 8, 16];
  const GOD_ONLY = new Set(["set_luck", "set_speed", "pause", "resume", "set_profile"]);
  const HOUSING_EVERY = 40; // frames carry `lots` and `homes` when they change, and in every 40th frame anyway
  const REGION_HOUSING_CHECK = 20; // the region's `lots` and `homes` are compared every 20th frame ...
  const REGION_HOUSING_EVERY = 200; // ... and sent anyway every 200th (PLAN 2.11)
  const OCC_EVERY = 40; // a frame carries `occ` at most every 40th frame ...
  const OCC_TICKS = 10; // ... once the last one sent is 10 ticks old (PLAN 2.11)
  const CATCH_UP_FRAMES = 4; // a late loop pass runs at most this many frames' worth of ticks (folk.md 9)
  const WELCOME_HISTORY = 80, WELCOME_NEWS = 120, WELCOME_HEADLINES = 20, WELCOME_LLM_LOG = 80;
  const STATS_SECONDS = 3.0; // a stats push this often while the city runs ...
  const STATS_MAJOR_SECONDS = 0.5; // ... and this soon after the last one when a major event happened
  const HOST = { kind: "browser", controllers: false };
  // The exceptions GameServer answers with "bad message: ..." (Python's ValueError, TypeError, KeyError,
  // AttributeError and OverflowError; a JS TypeError is Python's TypeError or AttributeError).
  const CAUGHT = new Set(["ValueError", "TypeError", "KeyError", "AttributeError", "OverflowError"]);

  const defaultNow = () => (globalThis.performance ? globalThis.performance.now() / 1000 : Date.now() / 1000);

  // The real seconds a loop pass turns into ticks: the time since the last pass, exactly FRAME_SECONDS when it was
  // on time (to the float, so an on-time loop runs v2's tick sequence), at most CATCH_UP_FRAMES frames.
  function frame_span(elapsed) {
    if (Math.abs(elapsed - FRAME_SECONDS) < 1e-9) return FRAME_SECONDS;
    return Math.max(0.0, Math.min(elapsed, CATCH_UP_FRAMES * FRAME_SECONDS));
  }

  // Python's msg[key]: a KeyError when it is missing.
  function item(msg, key) {
    if (!hasOwn(msg, key)) throw new PyError("KeyError", pyRepr(key));
    return msg[key];
  }

  // str(exc) of a caught exception: a KeyError shows the key's repr, as Python prints it.
  const errorText = err => String(err && err.message !== undefined ? err.message : err);

  class LocalHost {
    constructor(sim, speed = 1, now = defaultNow) {
      this.sim = sim;
      this.speed = speed;
      sim.speed = speed; // fork messages carry minutes_per_second (protocol, Fork)
      this.now = now;
      this.god = null;
      this.observers = new Set();
      this.sessions = new Map(); // client socket -> {role}
      this._timer = null;
      this._pending_ticks = 0.0;
      this._frames = 0; // state frames encoded so far
      this._occ_tick = null; // the tick of the last `occ` a frame carried
      this._last = null; // when the last loop pass ran (this.now() seconds)
      this._housing_sent = {}; // the encoded `lots` and `homes` the views last got
      this._stats_at = this.now(); // when the last stats push went out
      this._stats_stepped = false; // a tick ran since then
      this._stats_major = false; // an importance-2 event was drained since then
    }

    // --- lifecycle ------------------------------------------------------------

    start() {
      this.sim.town.warm(); // every place's walk field, before the first tick needs one
      if (this._timer === null) this._timer = setTimeout(() => this._run(), FRAME_SECONDS * 1000);
    }

    stop() {
      if (this._timer !== null) clearTimeout(this._timer);
      this._timer = null;
      for (const ws of Array.from(this.sessions.keys())) ws._serverClose();
    }

    _run() {
      try {
        this.frame();
      } catch (err) {
        console.error("GameOfAILife: the simulation hit an error", err);
      } finally {
        // folk.md 9: sleep what is left of this frame after the pass's work.
        const wait = Math.max(0, FRAME_SECONDS - (this.now() - this._last));
        if (this._timer !== null) this._timer = setTimeout(() => this._run(), wait * 1000);
      }
    }

    // One pass of GameServer._run's loop: the ticks the real time since the last pass is worth (frame_span; one
    // frame for the first pass), then a flush.
    frame() {
      const now = this.now();
      const span = this._last === null ? FRAME_SECONDS : frame_span(now - this._last);
      this._last = now;
      this._pending_ticks += span * G.clock.TICKS_PER_REAL_SECOND * this.speed;
      let stepped = false;
      while (this._pending_ticks >= 1) {
        this._pending_ticks -= 1;
        this.sim.step();
        stepped = true;
      }
      if (!stepped) this.sim._check_timeouts(); // answers can time out while paused, too
      this._flush(stepped);
    }

    _flush(stepped) {
      const [events, forks] = this.sim.drain(); // the outbox has no controllers to go to
      const viewers = [this.god, ...this.observers].filter(Boolean);
      this._stats_stepped = this._stats_stepped || stepped;
      this._stats_major = this._stats_major || events.some(ev => ev.importance >= 2);
      if (viewers.length && (stepped || events.length || forks.length)) {
        const state = this.sim.state_json(false);
        Object.assign(state, this._housing_changes());
        this._add_occ(state);
        const frame = JSON.stringify({ type: "state", speed: this.speed, state, events, forks });
        for (const ws of viewers) this._push(ws, frame);
      }
      this._push_stats(viewers);
    }

    // The stats cadence (PLAN 3.8): a push when STATS_SECONDS have passed since the last one and a tick ran, or
    // STATS_MAJOR_SECONDS when a major event happened; nothing while paused and quiet. Encoded once for all
    // viewers.
    _push_stats(viewers) {
      const since = this.now() - this._stats_at;
      if (!((this._stats_stepped && since >= STATS_SECONDS) || (this._stats_major && since >= STATS_MAJOR_SECONDS))) return;
      this._stats_at += since;
      this._stats_stepped = this._stats_major = false;
      if (!viewers.length) {
        this.sim.stats.take_new_samples(); // nobody to carry them to: a new view's welcome has them all
        return;
      }
      const push = JSON.stringify(this.sim.stats_json(false));
      for (const ws of viewers) this._push(ws, push);
    }

    // The frame's `lots` and `homes`: each one when its encoded JSON differs from what was last sent, and both in
    // every HOUSING_EVERY-th frame. In the region they are compared only every REGION_HOUSING_CHECK-th frame and
    // sent anyway every REGION_HOUSING_EVERY-th (PLAN 2.11). Views keep the last copy they got.
    _housing_changes() {
      this._frames += 1;
      let every;
      if (this.sim.world === "region") {
        if (this._frames % REGION_HOUSING_CHECK) return {};
        every = this._frames % REGION_HOUSING_EVERY === 0;
      } else {
        every = this._frames % HOUSING_EVERY === 0;
      }
      const out = {};
      for (const [key, value] of Object.entries(this.sim.housing_maps())) {
        const text = JSON.stringify(value);
        if (every || this._housing_sent[key] !== text) {
          this._housing_sent[key] = text;
          out[key] = value;
        }
      }
      return out;
    }

    // `occ` in every OCC_EVERY-th frame once the last one sent is OCC_TICKS old (the welcome always has it).
    _add_occ(state) {
      const tick = this.sim.clock.tick;
      if (this._frames % OCC_EVERY === 0 && (this._occ_tick === null || tick - this._occ_tick >= OCC_TICKS)) {
        state.occ = this.sim.folk.occ();
        this._occ_tick = tick;
      }
    }

    // A new God view's (or watcher's) start: the town once, the full state, and the recent past.
    _welcome_god() {
      const sim = this.sim;
      const state = sim.state_json(true);
      state.occ = sim.folk.occ(); // who is in each place, folk and named (PLAN 2.11; frames send it now and then)
      return { type: "welcome", role: "god", town: sim.town_json(), state,
        history: sim.history.slice(-WELCOME_HISTORY), news: sim.news.slice(-WELCOME_NEWS),
        headlines: sim.headlines.slice(-WELCOME_HEADLINES), llm_log: sim.llm_log.slice(-WELCOME_LLM_LOG),
        host: Object.assign({}, HOST), stats: sim.stats_json(true), speed: this.speed };
    }

    // --- sessions (the in-page sockets) -------------------------------------------

    // Send the direct reply to msg, with its req_id if it had one.
    _reply(ws, msg, reply) {
      if (msg && hasOwn(msg, "req_id")) reply.req_id = msg.req_id;
      ws._deliver(JSON.stringify(reply));
    }

    // A push the client did not ask for. GameServer queues it in the client's Outbox, where a state frame or stats
    // push merges into the one of its kind still waiting (PLAN 3.14). Here it goes straight to the in-page socket,
    // which hands it to the client on the next task: no backlog builds up, so nothing is merged or dropped.
    _push(ws, text) { ws._deliver(text); }

    connect(ws) { this.sessions.set(ws, { role: null }); }

    receive(ws, text) {
      const session = this.sessions.get(ws);
      if (!session) return;
      let msg;
      try {
        msg = pyJsonLoads(text); // json.loads: bare NaN and Infinity read as Python reads them
      } catch (_) {
        this._reply(ws, null, { type: "error", error: "messages must be JSON" });
        return;
      }
      if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
        this._reply(ws, null, { type: "error", error: "messages must be JSON objects" });
        return;
      }
      if (session.role === null) {
        if (getd(msg, "type", null) !== "hello") {
          this._reply(ws, msg, { type: "error", error: "say hello first" });
          return;
        }
        session.role = this._hello(ws, msg);
        return;
      }
      const watching = ws !== this.god;
      let reply;
      try {
        if (watching && typeof msg.type === "string" && GOD_ONLY.has(msg.type)) {
          reply = { type: "error", error: "only God can do that; this view is watching" };
        } else {
          reply = this._god(msg);
        }
      } catch (err) {
        if (!(CAUGHT.has(err && err.name) || err instanceof TypeError)) console.error("GameOfAILife:", err);
        reply = { type: "error", error: `bad message: ${errorText(err)}` };
      }
      if (reply) this._reply(ws, msg, reply);
    }

    disconnect(ws) {
      if (!this.sessions.has(ws)) return;
      this.sessions.delete(ws);
      if (ws === this.god) this.god = null;
      this.observers.delete(ws);
    }

    _hello(ws, msg) {
      const role = getd(msg, "role", null);
      if (role === "god") {
        // One God per city: the newest God view takes over and the old one keeps watching.
        if (this.god) {
          this.observers.add(this.god);
          this._push(this.god, JSON.stringify({ type: "demoted", reason: "another God view took over" }));
        }
        this.god = ws;
        this._reply(ws, msg, this._welcome_god());
        return "god";
      }
      if (role === "controller") {
        this._reply(ws, msg, { type: "error", error: "this city runs in the browser: controllers cannot join" });
      } else {
        this._reply(ws, msg, { type: "error", error: "role must be god or controller" });
      }
      ws._serverClose();
      return null;
    }

    _god(msg) {
      const t = getd(msg, "type", null);
      const sim = this.sim;
      if (t === "set_luck") {
        const luck = getd(msg, "luck", 50);
        if (typeof luck !== "number" || !Number.isFinite(luck)) throw new PyError("TypeError", "luck must be a number");
        const ok = sim.set_luck(pyStr(getd(msg, "agent_id", null)), pyFloat(luck));
        return { type: "luck_set", ok, agent_id: getd(msg, "agent_id", null),
          luck: ok ? sim.luck_of(pyStr(item(msg, "agent_id"))) : null };
      }
      if (t === "set_speed") {
        const speed = pyInt(getd(msg, "speed", 1));
        this.speed = SPEEDS.includes(speed) ? speed : 1;
        sim.speed = this.speed;
        return { type: "speed", speed: this.speed };
      }
      if (t === "pause") {
        this.speed = 0;
        sim.speed = 0; // paused: fork messages carry no minutes_per_second
        return { type: "speed", speed: 0 };
      }
      if (t === "resume") {
        this.speed = this.speed || 1;
        sim.speed = this.speed;
        return { type: "speed", speed: this.speed };
      }
      if (t === "get_agent") {
        const data = sim.agent_json(pyStr(getd(msg, "agent_id", null)));
        return data ? { type: "agent", agent: data } : { type: "error", error: "unknown character" };
      }
      if (t === "get_home") {
        const home = sim.home_page(pyStr(getd(msg, "home_id", null)));
        return home ? { type: "home", home } : { type: "error", error: "unknown home" };
      }
      if (t === "get_stats") return sim.stats_json(true);
      if (t === "get_folk") return { type: "folk", v: sim.folk.v, rows: sim.folk.roster_rows(sim) };
      if (t === "get_decisions") {
        const page = sim.decisions(getd(msg, "agent_id", null), getd(msg, "before", null), getd(msg, "limit", null));
        return page !== null ? page : { type: "error", error: "unknown character" };
      }
      if (t === "set_profile") {
        const ok = sim.set_profile(pyStr(getd(msg, "agent_id", null)), getd(msg, "prompt", null), getd(msg, "traits", null));
        return ok ? { type: "agent", agent: sim.agent_json(item(msg, "agent_id")) } : { type: "error", error: "unknown character" };
      }
      return { type: "error", error: `unknown message type ${pyRepr(t)}` };
    }

    // A WebSocket class whose connections reach this host. One FIFO queue per direction, like a real socket: a
    // message never overtakes an earlier one.
    socket() {
      const host = this;
      const CLOSE = {}; // in the delivery queue: the host closes the connection here

      function textOf(data) {
        if (typeof data === "string") return data;
        try {
          if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
          if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
        } catch (_) { /* fall through */ }
        return String(data);
      }

      class FakeWebSocket {
        constructor(url, protocols) {
          this.url = String(url);
          this.protocol = "";
          this.extensions = "";
          this.binaryType = "blob";
          this.bufferedAmount = 0;
          this.readyState = FakeWebSocket.CONNECTING;
          this.onopen = null;
          this.onmessage = null;
          this.onclose = null;
          this.onerror = null;
          this._listeners = {};
          this._rx = [];
          this._tx = [];
          setTimeout(() => {
            if (this.readyState !== FakeWebSocket.CONNECTING) return;
            this.readyState = FakeWebSocket.OPEN;
            host.connect(this);
            this._fire("open", { type: "open", target: this });
          }, 0);
        }

        send(data) {
          if (this.readyState === FakeWebSocket.CONNECTING) {
            throw new DOMException("Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.", "InvalidStateError");
          }
          if (this.readyState !== FakeWebSocket.OPEN) return;
          this._tx.push(textOf(data));
          if (this._tx.length === 1) setTimeout(() => this._drainTx(), 0);
        }

        _drainTx() {
          const batch = this._tx;
          this._tx = [];
          for (const text of batch) {
            if (this.readyState !== FakeWebSocket.OPEN) return;
            try {
              host.receive(this, text);
            } catch (err) {
              console.error("GameOfAILife:", err);
            }
          }
        }

        close(code = 1000, reason = "") {
          if (this.readyState >= FakeWebSocket.CLOSING) return;
          this.readyState = FakeWebSocket.CLOSING;
          setTimeout(() => this._closed(code, reason), 0);
        }

        addEventListener(type, fn) { (this._listeners[type] || (this._listeners[type] = [])).push(fn); }

        removeEventListener(type, fn) {
          const list = this._listeners[type];
          if (list) this._listeners[type] = list.filter(f => f !== fn);
        }

        // From the host: one message, delivered asynchronously and in order.
        _deliver(text) {
          if (this.readyState !== FakeWebSocket.OPEN) return;
          this._rx.push(text);
          if (this._rx.length === 1) setTimeout(() => this._drainRx(), 0);
        }

        _drainRx() {
          const batch = this._rx;
          this._rx = [];
          for (const text of batch) {
            if (this.readyState !== FakeWebSocket.OPEN) return;
            if (text === CLOSE) {
              this._closed(1000, "");
              return;
            }
            this._fire("message", { type: "message", data: text, target: this });
          }
        }

        // The host ends the connection after anything already sent has arrived.
        _serverClose() {
          if (this.readyState >= FakeWebSocket.CLOSING) return;
          this._deliver(CLOSE);
        }

        _closed(code, reason) {
          if (this.readyState === FakeWebSocket.CLOSED) return;
          this.readyState = FakeWebSocket.CLOSED;
          host.disconnect(this);
          this._fire("close", { type: "close", code, reason, wasClean: true, target: this });
        }

        _fire(type, ev) {
          const handlers = [];
          if (typeof this["on" + type] === "function") handlers.push(this["on" + type]);
          for (const fn of this._listeners[type] || []) handlers.push(fn);
          for (const fn of handlers) {
            try {
              fn.call(this, ev);
            } catch (err) {
              if (typeof globalThis.reportError === "function") globalThis.reportError(err);
              else console.error(err);
            }
          }
        }
      }
      FakeWebSocket.CONNECTING = 0;
      FakeWebSocket.OPEN = 1;
      FakeWebSocket.CLOSING = 2;
      FakeWebSocket.CLOSED = 3;
      for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) FakeWebSocket.prototype[k] = FakeWebSocket[k];
      return FakeWebSocket;
    }
  }

  G.host = {
    FRAME_SECONDS, SPEEDS, GOD_ONLY, HOUSING_EVERY, WELCOME_HISTORY, WELCOME_NEWS, WELCOME_HEADLINES,
    WELCOME_LLM_LOG, STATS_SECONDS, STATS_MAJOR_SECONDS, HOST, LocalHost, REGION_HOUSING_CHECK,
    REGION_HOUSING_EVERY, OCC_EVERY, OCC_TICKS, CATCH_UP_FRAMES, frame_span,
  };
})(globalThis.GameOfAILife || (globalThis.GameOfAILife = {}));

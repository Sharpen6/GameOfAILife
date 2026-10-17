// Python semantics the browser port needs, so every engine file reads like its Python twin.
//
// The port is one classic script per Python module (port/src/engine.json has the load order). Each file adds
// its exports to the one namespace globalThis.GameOfAILife (G below) and reaches the other modules through it
// at call time, as the Python modules import each other. Nothing here holds simulation state.
(function (G) {
  "use strict";

  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const getd = (o, k, d) => (o !== null && o !== undefined && hasOwn(o, k) ? o[k] : d); // dict.get(k, d)

  // Python's % takes the sign of the divisor.
  function pyMod(a, b) {
    const r = a % b;
    return r !== 0 && (r < 0) !== (b < 0) ? r + b : r;
  }
  // a // b
  const floorDiv = (a, b) => Math.floor(a / b);

  // sum() of numbers: CPython 3.12+ adds floats with Neumaier compensated summation.
  function sum(values) {
    let f = 0, c = 0;
    for (const x of values) {
      const t = f + x;
      if (Math.abs(f) >= Math.abs(x)) c += (f - t) + x;
      else c += (x - t) + f;
      f = t;
    }
    if (c && Number.isFinite(c)) f += c;
    return f;
  }

  // round(x) and round(x, n): round half to even on the exact binary value, like CPython.
  function pyRound(x, n) {
    if (!Number.isFinite(x)) return x;
    if (!n) {
      const f = Math.floor(x), d = x - f;
      if (d > 0.5) return f + 1;
      if (d < 0.5) return f;
      return pyMod(f, 2) === 0 ? f : f + 1;
    }
    const ax = Math.abs(x);
    if (ax >= 1e15) return x;
    const scaled = ax * Math.pow(10, n);
    let r;
    if (scaled < 1e9 && Math.abs(scaled - Math.floor(scaled) - 0.5) > 1e-6) {
      r = Number(ax.toFixed(n)); // not near a tie: toFixed rounds the exact value correctly
    } else {
      const exact = ax.toFixed(100); // the exact decimal expansion of the double
      const dot = exact.indexOf(".");
      const kept = exact.slice(0, dot + 1 + n);
      if (/^50*$/.test(exact.slice(dot + 1 + n)) && Number(kept[kept.length - 1]) % 2 === 0) r = Number(kept);
      else r = Number(ax.toFixed(n));
    }
    return x < 0 || Object.is(x, -0) ? -r : r;
  }

  // f"{x:.nf}"
  function fmt(x, n = 0) {
    const neg = x < 0 || Object.is(x, -0);
    return (neg ? "-" : "") + pyRound(Math.abs(x), n).toFixed(n);
  }
  // The thousands separators of f"{x:,}" on the digits of a formatted number.
  function group(s) {
    const neg = s[0] === "-";
    const body = neg ? s.slice(1) : s;
    const dot = body.indexOf(".");
    const whole = dot < 0 ? body : body.slice(0, dot), rest = dot < 0 ? "" : body.slice(dot);
    return (neg ? "-" : "") + whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + rest;
  }
  const commas = x => group(String(x)); // f"{n:,}" for an integer
  const fmtc = (x, n = 0) => group(fmt(x, n)); // f"{x:,.nf}"
  const pad2 = n => String(n).padStart(2, "0"); // f"{n:02d}"

  const firstName = name => String(name).trim().split(/\s+/)[0]; // name.split()[0]
  const lastName = name => { const p = String(name).trim().split(/\s+/); return p[p.length - 1]; }; // name.split()[-1]
  const capitalize = s => (s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s); // str.capitalize()
  const title = s => s.replace(/[A-Za-z]+/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase()); // str.title()
  function cut(s, n) { // s[:n] by code point
    const cps = Array.from(s);
    return cps.length > n ? cps.slice(0, n).join("") : s;
  }
  function keepLast(arr, n) { // del arr[:-n]
    if (arr.length > n) arr.splice(0, arr.length - n);
  }
  // s.strip(): Python's str.isspace() set, which is not JS trim()'s (\x1c-\x1f and \x85 in, ﻿ out).
  const PY_WS = "[\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
  const PY_STRIP = new RegExp("^" + PY_WS + "+|" + PY_WS + "+$", "g");
  const pyStrip = s => s.replace(PY_STRIP, "");

  // --- comparisons: tuples, sorted(), min() and max() with a key -------------------------------------

  // Python's comparison of two tuples (arrays) of numbers, strings and booleans: element by element, strings by
  // code unit; a shorter tuple that is a prefix comes first.
  function cmp(a, b) {
    if (Array.isArray(a)) {
      const n = Math.min(a.length, b.length);
      for (let i = 0; i < n; i++) {
        const c = cmp(a[i], b[i]);
        if (c) return c;
      }
      return a.length - b.length;
    }
    if (a === b) return 0;
    if (a === null || a === undefined) return -1;
    if (b === null || b === undefined) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  // sorted(items, key=key, reverse=reverse): stable; reverse keeps equal items in their order, as Python does.
  function sortedBy(items, key = x => x, reverse = false) {
    const keyed = Array.from(items, (x, i) => [key(x), i, x]);
    keyed.sort((p, q) => (reverse ? cmp(q[0], p[0]) : cmp(p[0], q[0])) || p[1] - q[1]);
    return keyed.map(p => p[2]);
  }
  // min(items, key=key): the first of the smallest; max(items, key=key): the first of the largest.
  function minBy(items, key = x => x) {
    let best, bestKey, first = true;
    for (const x of items) {
      const k = key(x);
      if (first || cmp(k, bestKey) < 0) { best = x; bestKey = k; first = false; }
    }
    if (first) throw new PyError("ValueError", "min() arg is an empty sequence");
    return best;
  }
  function maxBy(items, key = x => x) {
    let best, bestKey, first = true;
    for (const x of items) {
      const k = key(x);
      if (first || cmp(k, bestKey) > 0) { best = x; bestKey = k; first = false; }
    }
    if (first) throw new PyError("ValueError", "max() arg is an empty sequence");
    return best;
  }
  // list.index(max(list)): the first index of the largest number.
  function argmax(xs) {
    let best = 0;
    for (let i = 1; i < xs.length; i++) if (xs[i] > xs[best]) best = i;
    return best;
  }
  const count = (items, pred) => { let n = 0; for (const x of items) if (pred(x)) n++; return n; };

  // --- errors, conversions and repr, for the host's message checks -------------------------------------

  class PyError extends Error {
    constructor(kind, message) { super(message); this.name = kind; this.pyType = kind; }
  }
  function pyTypeName(v) {
    if (v === null || v === undefined) return "NoneType";
    if (typeof v === "boolean") return "bool";
    if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
    if (typeof v === "string") return "str";
    if (Array.isArray(v)) return "list";
    return "dict";
  }
  function pyRepr(v) {
    if (v === null || v === undefined) return "None";
    if (v === true) return "True";
    if (v === false) return "False";
    if (typeof v === "string") {
      const q = v.includes("'") && !v.includes('"') ? '"' : "'";
      return q + v.replace(/\\/g, "\\\\").replace(new RegExp(q, "g"), "\\" + q).replace(/\n/g, "\\n") + q;
    }
    if (typeof v === "number") {
      if (Number.isNaN(v)) return "nan";
      if (!Number.isFinite(v)) return v < 0 ? "-inf" : "inf";
      return String(v);
    }
    if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
    return "{" + Object.entries(v).map(([k, x]) => pyRepr(k) + ": " + pyRepr(x)).join(", ") + "}";
  }
  const pyStr = v => (typeof v === "string" ? v : pyRepr(v)); // str(v)
  function pyTruthy(v) {
    if (v === null || v === undefined) return false;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "object") return Object.keys(v).length > 0;
    return Boolean(v);
  }
  function pyFloat(v) { // float(v)
    if (typeof v === "number") return v;
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "string") {
      const s = pyStrip(v).replace(/(\d)_(?=\d)/g, "$1");
      if (/^[+-]?((\d+\.?\d*|\.\d+)(e[+-]?\d+)?)$/i.test(s)) return Number(s);
      if (/^[+-]?(inf|infinity)$/i.test(s)) return s[0] === "-" ? -Infinity : Infinity;
      if (/^[+-]?nan$/i.test(s)) return NaN;
      throw new PyError("ValueError", `could not convert string to float: ${pyRepr(v)}`);
    }
    throw new PyError("TypeError", `float() argument must be a string or a real number, not '${pyTypeName(v)}'`);
  }
  function pyInt(v) { // int(v)
    if (typeof v === "number") {
      if (Number.isNaN(v)) throw new PyError("ValueError", "cannot convert float NaN to integer");
      if (!Number.isFinite(v)) throw new PyError("OverflowError", "cannot convert float infinity to integer");
      return Math.trunc(v);
    }
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "string") {
      const s = pyStrip(v);
      if (/^[+-]?\d+(_\d+)*$/.test(s)) return parseInt(s.replace(/_/g, ""), 10);
      throw new PyError("ValueError", `invalid literal for int() with base 10: ${pyRepr(v)}`);
    }
    throw new PyError("TypeError", `int() argument must be a string, a bytes-like object or a real number, not '${pyTypeName(v)}'`);
  }

  // max(lo, min(hi, x)) as Python reads it: a comparison with NaN is false, so min(hi, nan) keeps hi where
  // Math.min would give NaN.
  function pyClamp(x, lo, hi) {
    const m = x < hi ? x : hi;
    return m > lo ? m : lo;
  }

  // json.loads(text): JSON as Python's json module reads it, which also takes the bare NaN, Infinity and
  // -Infinity that JSON.parse refuses. Throws a SyntaxError (a RangeError when nested too deep) on anything else.
  const JSON_CONSTANTS = [["null", null], ["true", true], ["false", false], ["NaN", NaN], ["Infinity", Infinity],
    ["-Infinity", -Infinity]];
  const JSON_STRING = /"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
  const JSON_NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][-+]?\d+)?/y;
  function pyJsonLoads(text) {
    try {
      return JSON.parse(text);
    } catch (err) {
      if (typeof text !== "string" || !/NaN|Infinity/.test(text)) throw err;
    }
    let i = 0;
    const fail = () => { throw new SyntaxError(`not JSON at position ${i}`); };
    const space = () => { while (i < text.length && " \t\n\r".includes(text[i])) i++; };
    const take = re => {
      re.lastIndex = i;
      const m = re.exec(text);
      if (m) i = re.lastIndex;
      return m ? m[0] : null;
    };
    const expect = c => {
      space();
      if (text[i] !== c) fail();
      i++;
    };
    function items(close, each) {
      i++;
      space();
      if (text[i] === close) { i++; return; }
      for (;;) {
        each();
        space();
        if (text[i] !== ",") break;
        i++;
      }
      expect(close);
    }
    function value() {
      space();
      if (text[i] === "{") {
        const obj = {};
        items("}", () => {
          space();
          const key = take(JSON_STRING);
          if (key === null) fail();
          expect(":");
          // defineProperty, as JSON.parse does: a "__proto__" key is a plain key, and the last one wins.
          Object.defineProperty(obj, JSON.parse(key), { value: value(), writable: true, enumerable: true, configurable: true });
        });
        return obj;
      }
      if (text[i] === "[") {
        const arr = [];
        items("]", () => arr.push(value()));
        return arr;
      }
      const s = take(JSON_STRING);
      if (s !== null) return JSON.parse(s);
      const n = take(JSON_NUMBER);
      if (n !== null) return Number(n);
      for (const [word, v] of JSON_CONSTANTS) {
        if (text.startsWith(word, i)) {
          i += word.length;
          return v;
        }
      }
      return fail();
    }
    const out = value();
    space();
    if (i < text.length) fail();
    return out;
  }

  // Python's ("rel", id) effect key: the string "rel:<id>" in this port.
  const relKey = id => `rel:${id}`;
  const REL = "rel:";

  G.py = {
    hasOwn, getd, pyMod, floorDiv, sum, pyRound, fmt, fmtc, commas, pad2, firstName, lastName, capitalize, title,
    cut, keepLast, pyStrip, cmp, sortedBy, minBy, maxBy, argmax, count, PyError, pyTypeName, pyRepr, pyStr,
    pyTruthy, pyFloat, pyInt, pyClamp, pyJsonLoads, relKey, REL,
  };
})(globalThis.GameOfAILife || (globalThis.GameOfAILife = {}));

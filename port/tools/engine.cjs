// Load the browser engine (and LocalHost) into node, in port/src/engine.json order, as the built page does.
//
//   const G = require("./engine.cjs").load();   // globalThis.GameOfAILife: G.sim.Simulation, G.host.LocalHost, ...
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = path.join(__dirname, "..", "src");

function load() {
  if (globalThis.GameOfAILife && globalThis.GameOfAILife.sim) return globalThis.GameOfAILife;
  (globalThis.GameOfAILife || (globalThis.GameOfAILife = {})).REGION_DATA = JSON.parse(fs.readFileSync(path.join(SRC, "..", "..", "gameofailife", "data", "region.json"), "utf8")); // region.md 9
  const spec = JSON.parse(fs.readFileSync(path.join(SRC, "engine.json"), "utf8"));
  for (const name of [...spec.engine, ...spec.host]) {
    const file = path.join(SRC, name);
    vm.runInThisContext(fs.readFileSync(file, "utf8"), { filename: file });
  }
  return globalThis.GameOfAILife;
}

module.exports = { load, SRC };

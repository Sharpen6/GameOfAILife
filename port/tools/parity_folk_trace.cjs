// Townsfolk parity trace (F2a): runs the region with 1000 townsfolk in port/src (folk.js and friends) and in
// gameofailife (folk.py), and compares one trace line by line.
//
//   node port/tools/parity_folk_trace.cjs SEED DAYS           both sides; exit 1 at the first differing line
//   node port/tools/parity_folk_trace.cjs SEED DAYS --js      print the JS trace only
//   node port/tools/parity_folk_trace.cjs SEED DAYS --py      print the Python trace only
//
// The named sim rolls the same dice in both (the Python side swaps random.Random for the JS port's SimDice at the
// first weather roll, as tests/test_port.py's DiceSim does), so named characters, and what they do with townsfolk
// (talks, contagion at work, invites), stay in lockstep too; the weather is also pinned to one rule (folk read it for
// rained_out). Trace lines (integers and strings only, every field compared):
//   H <tick> crowd=<n> cs=<crowd checksum> occ=<folk per place> named=<occ(), named added> boardings=<today>
//     steps=<folk steps> money=<everyone's cents> luck=<luck log rows>   every hour
//   B <tick> <i> <activity> <place> <stay end>        every stay begun (Folk._begin)
//   T <tick> <i> <dest> <mode> <arrival tick>         every trip set off (Folk._go)
//   C <tick> <i> <kind> <option|option|...> <pick> <by>   every 50th choice
"use strict";
const { spawnSync } = require("child_process");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const M = 1000000007;
const N_FOLK = 1000;

function checksum(arr) {
  let s = 0;
  for (const v of arr) s = (s * 131 + (v % M + M)) % M;
  return s;
}

// Everyone's cash in whole cents, summed (fares, pay, outcomes): a check on money without printing floats.
function money(f) {
  let s = 0;
  for (const p of f.people) s += Math.floor(p.money * 100);
  return s;
}

// The trace's own weather, the same in both twins (rain at some of the 06:00 and 14:00 rolls).
const traceWeather = tick => ((Math.floor(tick / 60) * 7) % 5 < 2 ? "rain" : "clear");

function jsTrace(seed, days) {
  const G = require("./engine.cjs").load();
  const lines = [];
  const Folk = G.folk.Folk.prototype;
  const begin = Folk._begin, go = Folk._go, choose = Folk.choose;
  Folk._begin = function (p, now, activity, minutes) {
    begin.call(this, p, now, activity, minutes);
    const st = this.stay.get(p.i);
    lines.push(`B ${now} ${p.i} ${p.activity} ${this.where.get(p.i) ?? "-"} ${st ? st[1] : "-"}`);
  };
  Folk._go = function (sim, p, now, dest, then, until = null, stay = 30, prefer = null) {
    go.call(this, sim, p, now, dest, then, until, stay, prefer);
    if (p.trip !== null && p.trip !== undefined) {
      const legs = p.trip.legs;
      lines.push(`T ${now} ${p.i} ${p.trip.dest} ${p.trip.mode} ${legs.length ? legs[legs.length - 1][2] : now}`);
    }
  };
  Folk.choose = function (sim, p, now, kind) {
    choose.call(this, sim, p, now, kind);
    if (this.counters.choices % 50 === 0) {
      const c = p.choices[p.choices.length - 1];
      lines.push(`C ${now} ${p.i} ${kind} ${c.options.join("|")} ${c.choice} ${c.by}`);
    }
  };
  const Sim = G.sim.Simulation.prototype, roll = Sim._roll_weather;
  Sim._roll_weather = function () { // the named sim's rng drifts between the twins, so pin the weather folk read
    roll.call(this);
    this.weather = traceWeather(this.clock.tick);
  };
  const sim = new G.sim.Simulation(seed, null, null, null, { world: "region", folk: N_FOLK });
  const f = sim.folk;
  const end = sim.clock.tick + days * 1440;
  while (sim.clock.tick < end) {
    sim.step();
    const t = sim.clock.tick;
    if (t % 60 === 0) {
      const crowd = f.crowd(sim);
      lines.push(`H ${t} crowd=${crowd.length / 4} cs=${checksum(crowd)} occ=${checksum(f.count)} named=${checksum(f.occ())} ` +
        `boardings=${f.today.boardings} steps=${f.counters.steps} money=${money(f)} luck=${f.luck_log.length}`);
    }
  }
  Object.assign(Folk, { _begin: begin, _go: go, choose });
  Sim._roll_weather = roll;
  return lines;
}

const PY = String.raw`
import math, sys
sys.path.insert(0, ".")
from gameofailife import folk
from gameofailife.sim import Simulation
M = 1000000007
def checksum(arr):
    s = 0
    for v in arr:
        s = (s * 131 + (v % M + M)) % M
    return s
seed, days, n = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3])
out = []
F = folk.Folk
begin, go, choose = F._begin, F._go, F.choose
def _begin(self, p, now, activity, minutes):
    begin(self, p, now, activity, minutes)
    st = self.stay.get(p.i)
    out.append("B %d %d %s %s %s" % (now, p.i, p.activity, self.where.get(p.i) or "-", st[1] if st else "-"))
def _go(self, sim, p, now, dest, then, until=None, stay=30, prefer=None):
    go(self, sim, p, now, dest, then, until=until, stay=stay, prefer=prefer)
    if p.trip is not None:
        legs = p.trip.legs
        out.append("T %d %d %s %s %d" % (now, p.i, p.trip.dest, p.trip.mode, legs[-1][2] if legs else now))
def _choose(self, sim, p, now, kind):
    choose(self, sim, p, now, kind)
    if self.counters["choices"] % 50 == 0:
        c = p.choices[-1]
        out.append("C %d %d %s %s %d %s" % (now, p.i, kind, "|".join(c["options"]), c["choice"], c["by"]))
F._begin, F._go, F.choose = _begin, _go, _choose
from gameofailife.rng import Rng
class MulberryDice:  # port/src/sim.js's SimDice (tests/test_port.py's MulberryDice): the named sim's dice in both
    def __init__(self, seed):
        self.r = Rng((seed * 0x2545F491 + 0x6A09E667) & 0xFFFFFFFF)
    def random(self):
        return self.r.random()
    def uniform(self, a, b):
        return a + (b - a) * self.r.random()
    def randrange(self, a, b):
        return a + int(self.r.random() * (b - a))
    def choice(self, seq):
        return seq[int(self.r.random() * len(seq))]
roll = Simulation._roll_weather
def _roll(self):
    if not isinstance(self.rng, MulberryDice):
        self.rng = MulberryDice(self.dice_seed)  # from the first weather roll on, as test_port's DiceSim
    roll(self)
    self.weather = "rain" if ((self.clock.tick // 60) * 7) % 5 < 2 else "clear"
Simulation._roll_weather = _roll
sim = Simulation(seed=seed, world="region", folk=n)
f = sim.folk
end = sim.clock.tick + days * 1440
while sim.clock.tick < end:
    sim.step()
    t = sim.clock.tick
    if t % 60 == 0:
        crowd = f.crowd(sim)
        out.append("H %d crowd=%d cs=%d occ=%d named=%d boardings=%d steps=%d money=%d luck=%d" % (
            t, len(crowd) // 4, checksum(crowd), checksum(f.count), checksum(f.occ()), f.today["boardings"],
            f.counters["steps"], sum(math.floor(p.money * 100) for p in f.people), len(f.luck_log)))
sys.stdout.write("\n".join(out) + "\n")
`;

function pyTrace(seed, days) {
  const r = spawnSync("python3", ["-W", "ignore", "-c", PY, String(seed), String(days), String(N_FOLK)],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.status !== 0) {
    process.stderr.write(r.stderr || "python failed\n");
    process.exit(2);
  }
  return r.stdout.replace(/\n$/, "").split("\n");
}

function main() {
  const [seedArg, daysArg, only] = process.argv.slice(2);
  const seed = Number(seedArg || 1), days = Number(daysArg || 1);
  if (only === "--js") return void process.stdout.write(jsTrace(seed, days).join("\n") + "\n");
  if (only === "--py") return void process.stdout.write(pyTrace(seed, days).join("\n") + "\n");
  const py = pyTrace(seed, days);
  const js = jsTrace(seed, days);
  const kinds = {};
  for (const l of py) kinds[l[0]] = (kinds[l[0]] || 0) + 1;
  const n = Math.max(py.length, js.length);
  for (let k = 0; k < n; k++) {
    if (py[k] !== js[k]) {
      console.log(`seed ${seed} days ${days}: differ at line ${k + 1} of ${py.length} (py) / ${js.length} (js)`);
      for (let j = Math.max(0, k - 3); j < k; j++) console.log(`  same ${py[j]}`);
      console.log(`  py   ${py[k]}`);
      console.log(`  js   ${js[k]}`);
      process.exit(1);
    }
  }
  console.log(`seed ${seed} days ${days}: ${py.length} lines equal (${JSON.stringify(kinds)}); last ${py[py.length - 1]}`);
}

main();

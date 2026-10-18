"""perf_folk: what 1,000 townsfolk cost (folk.md 15, PLAN 6). Prints the load L with every number.

    nice -n 10 flock /tmp/v3-slow.lock python3 -m tests.perf_folk [--quick] [--skip-server] [--skip-node]

Gates (CPU, unscaled; the exit status is 1 when one fails):
- engine: the region at seed 1 for one game day, best of 3 `process_time` runs, with 1,000 townsfolk against none:
  step p99 <= 8 ms and mean step <= 5x the mean with no townsfolk;
- server: `python3 -m gameofailife --speed 16` (region, 1,000 townsfolk: the defaults) with a God view connected,
  for 2 minutes (`--quick`: 20 s): the server process's CPU per served tick, frame encoding included, <= 20 ms.
  Ticks per second are reported, not gated (speed 16 asks for 38.4).
Report-only: Node's game day (wall clock; gated <= 6 s x max(1, L / 4) only when L <= 8 and the JS townsfolk exist).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from gameofailife import ws  # noqa: E402
from gameofailife.clock import MINUTES_PER_DAY  # noqa: E402
from gameofailife.sim import Simulation  # noqa: E402

FOLK = 1000
STEP_P99_MS = 8.0
MEAN_RATIO = 5.0
SERVER_MS_PER_TICK = 20.0
NODE_DAY_SECONDS = 6.0


def load() -> float:
    return os.getloadavg()[0]


def engine_day(folk: int) -> dict:
    """One game day of the seed-1 region: each step's process_time, in ms."""
    sim = Simulation(1, world="region", folk=folk)
    sim.town.warm()
    steps = []
    for _ in range(MINUTES_PER_DAY):
        t = time.process_time()
        sim.step()
        steps.append((time.process_time() - t) * 1000)
    steps.sort()
    return {"mean": sum(steps) / len(steps), "p99": steps[int(len(steps) * 0.99)], "max": steps[-1],
            "total_s": sum(steps) / 1000}


def best_of(folk: int, runs: int) -> dict:
    return min((engine_day(folk) for _ in range(runs)), key=lambda r: r["mean"])


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def cpu_seconds(pid: int) -> float:
    """utime + stime of a process (Linux /proc), in seconds."""
    fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
    return (int(fields[11]) + int(fields[12])) / os.sysconf("SC_CLK_TCK")


async def watch(port: int, seconds: float, pid: int) -> dict:
    sock = await ws.connect(f"ws://127.0.0.1:{port}/ws")
    await sock.send(json.dumps({"type": "hello", "role": "god", "req_id": 1}))
    welcome = json.loads(await sock.recv())
    assert welcome["type"] == "welcome", welcome.get("type")
    first = None
    frames = 0
    while True:
        msg = json.loads(await sock.recv())
        if msg["type"] != "state":
            continue
        frames += 1
        tick = msg["state"]["tick"]
        if first is None:
            first = (tick, cpu_seconds(pid), time.monotonic())
            continue
        if time.monotonic() - first[2] >= seconds:
            cpu, wall = cpu_seconds(pid) - first[1], time.monotonic() - first[2]
            await sock.close()
            ticks = tick - first[0]
            return {"ticks": ticks, "cpu_s": cpu, "wall_s": wall, "frames": frames,
                    "ms_per_tick": cpu / max(1, ticks) * 1000, "ticks_per_s": ticks / wall,
                    "welcome_kb": len(json.dumps(welcome)) / 1024}


def server_run(seconds: float) -> dict:
    port = free_port()
    proc = subprocess.Popen([sys.executable, "-m", "gameofailife", "--port", str(port), "--speed", "16"], cwd=ROOT,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                            env={**os.environ, "PYTHONUNBUFFERED": "1"})
    try:
        deadline = time.monotonic() + 180
        line = ""
        while "is running" not in line:
            line = proc.stdout.readline()
            if not line and proc.poll() is not None:
                raise RuntimeError(f"the server exited: {proc.stderr.read()[-2000:]}")
            if time.monotonic() > deadline:
                raise RuntimeError("the server did not start in 180 s")
        return asyncio.run(watch(port, seconds, proc.pid))
    finally:
        proc.terminate()
        try:
            proc.wait(10)
        except subprocess.TimeoutExpired:
            proc.kill()


NODE_DAY = r"""
const G = require(process.argv[1] + "/port/tools/engine.cjs").load();
const has = !!(G.folk && G.folk.Folk);
const folk = has ? Number(process.argv[2]) : 0;
const t0 = Date.now();
const sim = new G.sim.Simulation(1, null, null, 1, { world: "region", folk });
const built = Date.now();
for (let i = 0; i < G.clock.MINUTES_PER_DAY; i++) sim.step();
process.stdout.write(JSON.stringify({ folk, has, build_s: (built - t0) / 1000, day_s: (Date.now() - built) / 1000 }));
"""


def node_day() -> dict | None:
    node = shutil.which("node")
    if not node:
        return None
    run = subprocess.run([node, "-e", NODE_DAY, str(ROOT), str(FOLK)], capture_output=True, text=True, timeout=600)
    if run.returncode:
        return {"error": run.stderr[-500:]}
    return json.loads(run.stdout)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--quick", action="store_true", help="1 engine run each and a 20 s server run")
    ap.add_argument("--skip-server", action="store_true")
    ap.add_argument("--skip-node", action="store_true")
    args = ap.parse_args(argv)
    failed = []
    runs = 1 if args.quick else 3

    base = best_of(0, runs)
    folk = best_of(FOLK, runs)
    ratio = folk["mean"] / base["mean"]
    print(f"engine, region seed 1, 1 day, best of {runs} (L {load():.2f}):")
    print(f"  folk 0:    mean {base['mean']:.2f} ms  p99 {base['p99']:.2f} ms  max {base['max']:.1f} ms  "
          f"day {base['total_s']:.2f} s")
    print(f"  folk {FOLK}: mean {folk['mean']:.2f} ms  p99 {folk['p99']:.2f} ms  max {folk['max']:.1f} ms  "
          f"day {folk['total_s']:.2f} s  ({ratio:.2f}x the mean)")
    if folk["p99"] > STEP_P99_MS:
        failed.append(f"step p99 {folk['p99']:.2f} ms > {STEP_P99_MS} ms")
    if ratio > MEAN_RATIO:
        failed.append(f"mean step {ratio:.2f}x > {MEAN_RATIO}x")

    if not args.skip_server:
        seconds = 20 if args.quick else 120
        got = server_run(seconds)
        print(f"server, speed 16, region, folk {FOLK}, God view, {got['wall_s']:.0f} s (L {load():.2f}): "
              f"{got['ms_per_tick']:.2f} ms CPU a tick over {got['ticks']} ticks, {got['ticks_per_s']:.1f} ticks/s "
              f"(38.4 asked), {got['frames']} frames, welcome {got['welcome_kb']:.0f} KB")
        if got["ms_per_tick"] > SERVER_MS_PER_TICK:
            failed.append(f"server {got['ms_per_tick']:.2f} ms a tick > {SERVER_MS_PER_TICK} ms")

    if not args.skip_node:
        got = node_day()
        L = load()
        if got is None:
            print("node: not installed")
        elif "error" in got:
            print(f"node: failed: {got['error']}")
            failed.append("node run failed")
        else:
            limit = NODE_DAY_SECONDS * max(1.0, L / 4)
            gated = got["has"] and L <= 8
            print(f"node, region seed 1, folk {got['folk']}, 1 day (L {L:.2f}): {got['day_s']:.2f} s wall "
                  f"(build {got['build_s']:.2f} s); limit {limit:.1f} s, "
                  + ("gated" if gated else "report-only" + ("" if got["has"] else ": no JS townsfolk in this build")))
            if gated and got["day_s"] > limit:
                failed.append(f"node day {got['day_s']:.2f} s > {limit:.1f} s")

    print("FAILED: " + "; ".join(failed) if failed else "OK")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Write client/dev/region_data.js: window.REGION, the region's welcome.town map (region.md 8) for the dev pages.

    python3 client/dev/make_region_data.py           # rewrite the file
    python3 client/dev/make_region_data.py --check   # exit 1 when the file is not what it would write

The data is gameofailife.region.build_region(1).map_json() as it is (w, h, tiles, places, districts, streets,
junctions, world, millbrook, rail, highways, interchanges, decor); the dev page adds the empty homes, housing,
stops and timetable a welcome would carry. Re-run whenever the region (R1a) changes. Python 3 stdlib only.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(HERE, "region_data.js")
HEADER = ("// Region dev data (V1a): window.REGION, the region's welcome.town map (region.md 8), written by\n"
          "// client/dev/make_region_data.py from gameofailife.region.build_region(1).map_json(). Do not edit by hand.\n")


def render(seed: int = 1) -> str:
    sys.path.insert(0, ROOT)
    from gameofailife import region  # noqa: E402  (the repo's package, not an installed one)
    data = region.build_region(seed).map_json()
    return HEADER + "window.REGION = " + json.dumps(data, separators=(",", ":")) + ";\n"


def main(argv):
    text = render()
    if "--check" in argv:
        try:
            with open(OUT, encoding="utf-8") as f:
                same = f.read() == text
        except OSError:
            same = False
        print("region_data.js is " + ("current" if same else "stale: run client/dev/make_region_data.py"))
        return 0 if same else 1
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(text)
    print("wrote %s (%.1f KB)" % (os.path.relpath(OUT, ROOT), len(text) / 1024))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

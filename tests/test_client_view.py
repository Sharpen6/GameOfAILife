"""Static checks for the isometric city view (client/view) and its dev page (client/dev).

The view is a set of classic browser scripts that share one global, window.CityView. These tests keep
it that way: every file is present, nothing uses ES module syntax, nothing reaches for the network or
for image files (or data:image URIs), view.css styles only .cv-* classes, the page's ticker is marked for
the view's labels to avoid, the view's stage palette is the dashboard's, the dev fixture has the PLAN 3.2
and 3.3 shapes and the spots the browser smoke test is about, the timetable still has the bus meetings it
draws, and (when Node is installed) every script parses and the scripts define only CityView.
With Node and Playwright installed and GOAL_SLOW=1, tests/browser/view_smoke.cjs runs the view in headless
Chromium (about 2 minutes).
"""

import json
import os
import pathlib
import re
import shutil
import subprocess
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
VIEW = ROOT / "client" / "view"
DEV = ROOT / "client" / "dev"

VIEW_SCRIPTS = ["proj.js", "art.js", "buildings.js", "towers.js", "rail_art.js", "actors.js", "region.js", "lod.js",
                "lowart.js", "scene.js", "movers.js", "crowd.js", "trains.js", "pings.js", "camera.js", "minimap.js",
                "view.js"]  # view.md 3.1 without the deferred dash_* files (PLAN 3, v3-skel-view)
DEV_SCRIPTS = ["fixture_town.js", "fake_state.js"]
FACADE = ["create", "setTown", "setState", "select", "focus", "highlight", "setOverlay", "ping",
          "setInset", "camera", "setMode", "start", "stop"]
SMOKE = ROOT / "tests" / "browser" / "view_smoke.cjs"

# PLAN 3.2 (town_json) and 3.3 (state_json) key sets
TOWN_KEYS = {"w", "h", "tiles", "places", "homes", "housing", "districts", "streets", "road_rows", "road_cols",
             "road_col_end", "junctions", "stops", "timetable"}
PLACE_KEYS = {"id", "name", "kind", "x", "y", "w", "h", "entry", "face", "hours", "district", "style", "floors",
              "tier", "units"}
HOME_KEYS = {"id", "place", "unit", "name", "tier", "bedrooms", "base_value", "rent"}
# v3 (PLAN 2.10) adds trains, crowd, folk_n, talks and thinking to the state and ill, stage to agent rows, in both worlds.
STATE_KEYS = {"tick", "time", "minute", "day", "season", "weather", "lights", "plane", "buses", "lots", "homes",
              "agents", "trains", "crowd", "folk_n", "talks", "thinking"}
AGENT_KEYS = {"id", "name", "x", "y", "inside", "state", "activity", "vehicle", "mood", "luck", "controller",
              "alive", "age", "home", "car", "riding", "ill", "stage"}
BUS_KEYS = {"id", "line", "x", "y", "dir", "at_stop", "riders"}
LOT_KEYS = {"condition", "stage", "works", "moving"}
HOME_ROW_KEYS = {"hh", "owner", "listing", "price", "value", "emergency"}


def scripts():
    return [VIEW / n for n in VIEW_SCRIPTS] + [DEV / n for n in DEV_SCRIPTS]


class ClientViewFiles(unittest.TestCase):
    def test_files_exist(self):
        for path in scripts() + [VIEW / "view.css", DEV / "view.html"]:
            self.assertTrue(path.is_file(), f"missing {path.relative_to(ROOT)}")

    def test_classic_scripts_only(self):
        module = re.compile(r"^\s*(import\s.+\sfrom\s|import\s*['\"]|export\s)", re.M)
        for path in scripts():
            self.assertIsNone(module.search(path.read_text()), f"{path.name} uses ES module syntax")

    def test_view_scripts_define_only_city_view(self):
        assign = re.compile(r"window\.([A-Za-z_$][\w$]*)\s*=(?!=)")
        for path in (VIEW / n for n in VIEW_SCRIPTS):
            names = set(assign.findall(path.read_text()))
            self.assertLessEqual(names, {"CityView"}, f"{path.name} sets window.{names - {'CityView'}}")

    def test_no_network_or_image_files(self):
        url = re.compile(r"https?://")
        image = re.compile(r"[\w/.-]+\.(png|jpe?g|gif|webp|svg)\b", re.I)
        for path in scripts() + [VIEW / "view.css", DEV / "view.html"]:
            text = path.read_text()
            self.assertIsNone(url.search(text), f"{path.name} references an external URL")
            self.assertIsNone(image.search(text), f"{path.name} references an image file")
            self.assertNotIn("data:image", text, f"{path.name} embeds a data:image URI")

    def test_view_css_styles_only_cv_classes(self):
        text = re.sub(r"/\*.*?\*/", "", (VIEW / "view.css").read_text(), flags=re.S)
        stack, selectors = [], []
        for m in re.finditer(r"([^{}]*)([{}])", text):
            prelude, brace = m.group(1).strip(), m.group(2)
            if brace == "}":
                self.assertTrue(stack, "view.css has an unbalanced }")
                stack.pop()
                continue
            if prelude.startswith("@"):
                self.assertRegex(prelude, r"^@media\b", f"view.css: unexpected at-rule {prelude!r}")
                stack.append("at")
            else:
                self.assertNotIn("rule", stack, f"view.css: nested rule {prelude!r}")
                stack.append("rule")
                selectors += [sel.strip() for sel in prelude.split(",")]
        self.assertFalse(stack, "view.css has an unclosed {")
        self.assertTrue(selectors)
        for sel in selectors:
            self.assertRegex(sel, r"^\.cv-[\w-]", f"view.css: {sel!r} does not start with a .cv-* class")
            self.assertNotIn("#", sel, f"view.css: {sel!r} styles an id")
            for cls in re.findall(r"\.([\w-]+)", sel):
                self.assertTrue(cls.startswith("cv-"), f"view.css: {sel!r} uses the class .{cls}")

    def test_facade_methods_present(self):
        text = (VIEW / "view.js").read_text()
        for name in FACADE:
            self.assertRegex(text, rf"\b{name}\b", f"view.js has no {name}")

    def test_ticker_is_kept_clear_of_labels(self):
        # name plates and badges keep off every element marked data-cv-avoid (review ART-4)
        html = (ROOT / "client" / "index.html").read_text()
        tag = re.search(r"<div\s+id=\"ticker\"[^>]*>", html)
        self.assertIsNotNone(tag, "client/index.html has no #ticker")
        self.assertRegex(tag.group(0), r"\sdata-cv-avoid\b", "the ticker is not marked data-cv-avoid")

    def test_stage_palette_is_the_dashboards(self):
        # one Condition palette for the map overlay, the minimap and the dashboard's legends (review H6)
        palette = re.compile(r"const STAGE_COLOR = (\[[^\]]*\])")
        dash = palette.search((ROOT / "client" / "dashboard.js").read_text())
        own = re.search(r"CV\.STAGE_COLORS = (\[[^\]]*\])", (VIEW / "art.js").read_text())
        self.assertIsNotNone(dash, "dashboard.js has no STAGE_COLOR")
        self.assertIsNotNone(own, "art.js has no CV.STAGE_COLORS")
        self.assertEqual(json.loads(own.group(1)), json.loads(dash.group(1)))
        for name in VIEW_SCRIPTS:
            if name != "art.js":
                self.assertNotRegex((VIEW / name).read_text(), r"STAGE_COLS?\s*=", f"{name} keeps a stage palette of its own")

    def test_dev_page_loads_every_script(self):
        html = (DEV / "view.html").read_text()
        for name in VIEW_SCRIPTS:
            self.assertIn(f"../view/{name}", html)
        for name in DEV_SCRIPTS:
            self.assertIn(name, html)
        self.assertIn("../view/view.css", html)

    @unittest.skipUnless(shutil.which("node"), "node is not installed")
    def test_scripts_parse(self):
        for path in scripts():
            run = subprocess.run(["node", "--check", str(path)], capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, f"{path.name}: {run.stderr}")

    @unittest.skipUnless(shutil.which("node"), "node is not installed")
    def test_scripts_add_only_city_view_when_run(self):
        # the nine scripts run in order in a bare context whose window is the global object
        code = ("const vm = require('vm'), fs = require('fs'); const ctx = { console }; ctx.window = ctx;"
                "vm.createContext(ctx); const before = new Set(Object.getOwnPropertyNames(ctx));"
                "for (const f of process.argv.slice(1)) vm.runInContext(fs.readFileSync(f, 'utf8'), ctx, { filename: f });"
                "const cv = ctx.CityView || {};"
                "console.log(JSON.stringify({ added: Object.getOwnPropertyNames(ctx).filter(k => !before.has(k)),"
                " create: typeof cv.create, shirt: typeof cv.shirt, hair: typeof cv.hair }));")
        run = subprocess.run(["node", "-e", code] + [str(VIEW / n) for n in VIEW_SCRIPTS],
                             capture_output=True, text=True, timeout=60)
        self.assertEqual(run.returncode, 0, run.stderr)
        out = json.loads(run.stdout)
        self.assertEqual(out["added"], ["CityView"])
        self.assertEqual((out["create"], out["shirt"], out["hair"]), ("function", "function", "function"))


class ClientViewFixture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        text = (DEV / "fixture_town.js").read_text()
        m = re.search(r"^window\.CITY_FIXTURE = (.*?);?\s*\Z", text, re.M | re.S)
        assert m, "fixture_town.js does not set window.CITY_FIXTURE"
        cls.fixture = json.loads(m.group(1))
        cls.town, cls.state = cls.fixture["town"], cls.fixture["state"]

    def test_town_has_the_town_json_shape(self):
        town = self.town
        self.assertEqual(set(town), TOWN_KEYS)
        self.assertEqual(len(town["tiles"]), town["h"])
        self.assertTrue(all(len(row) == town["w"] for row in town["tiles"]))
        self.assertTrue(set("".join(town["tiles"])) <= set(".#BDPTe~"))
        for place in town["places"]:
            self.assertEqual(set(place), PLACE_KEYS, place["id"])
        for home in town["homes"]:
            self.assertEqual(set(home), HOME_KEYS, home["id"])
        self.assertEqual(set(town["housing"]), {"tiers", "stages", "landlord"})
        self.assertEqual([s["name"] for s in town["housing"]["stages"]], ["kept", "worn", "shabby", "neglected", "derelict"])
        for district in town["districts"]:
            self.assertEqual(set(district), {"id", "name", "about", "rects"})
        for stop in town["stops"]:
            self.assertEqual(set(stop), {"id", "name", "x", "y", "lines"})
        self.assertEqual(set(town["timetable"]), {"bus", "flights"})

    def test_homes_and_places_agree(self):
        places = {p["id"]: p for p in self.town["places"]}
        for home in self.town["homes"]:
            self.assertEqual(places[home["place"]]["kind"], "home", home["id"])
        for place in places.values():
            units = [h for h in self.town["homes"] if h["place"] == place["id"]]
            self.assertEqual(len(units), place["units"], place["id"])

    def test_state_has_the_state_json_shape(self):
        state = self.state
        self.assertEqual(set(state), STATE_KEYS)
        self.assertTrue(state["agents"])
        for agent in state["agents"]:
            self.assertEqual(set(agent), AGENT_KEYS, agent["id"])
        for bus in state["buses"]:
            self.assertEqual(set(bus), BUS_KEYS, bus["id"])
        homes = {p["id"] for p in self.town["places"] if p["kind"] == "home"}
        self.assertEqual(set(state["lots"]), homes)
        for row in state["lots"].values():
            self.assertEqual(set(row), LOT_KEYS)
        self.assertEqual(set(state["homes"]), {h["id"] for h in self.town["homes"]})
        for row in state["homes"].values():
            self.assertEqual(set(row), HOME_ROW_KEYS)
        known = {h["id"] for h in self.town["homes"]} | {p["id"] for p in self.town["places"]}
        for agent in state["agents"]:
            self.assertIn(agent["home"], known, agent["id"])
            self.assertTrue(agent["inside"] is None or agent["inside"] in known, agent["id"])


class ClientViewBusScenes(unittest.TestCase):
    # view_smoke.cjs's buses run draws the real timetable (transit.bus_rows) for ticks 360-400 and 0-2; these
    # are the meetings it is about (review ART-3), so a timetable change that drops them shows here.
    def setUp(self):
        from gameofailife import transit
        self.rows = lambda t: {b["id"]: b for b in transit.bus_rows(t)}

    def test_line_1_and_2_turn_across_each_other_at_willow_and_main(self):
        # 06:04: 1a heading south and 2a heading west both reach (3, 25); 06:05: 1a goes east, 2a north
        before, at, after = self.rows(363), self.rows(364), self.rows(365)
        self.assertEqual((before["1a"]["dir"], before["2a"]["dir"]), ("s", "w"))
        self.assertEqual(((at["1a"]["x"], at["1a"]["y"]), (at["2a"]["x"], at["2a"]["y"])), ((3, 25), (3, 25)))
        self.assertEqual((at["1a"]["dir"], at["2a"]["dir"]), ("e", "n"))
        self.assertGreater(after["1a"]["x"], 3)
        self.assertLess(after["2a"]["y"], 25)

    def test_two_buses_share_a_tile_at_tick_0(self):
        # the first frame of the fresh view in the smoke test
        at = self.rows(0)
        self.assertEqual(sorted(b for b in at if (at[b]["x"], at[b]["y"]) == (3, 25)), ["1a", "2a"])


class ClientViewFixtureScenes(unittest.TestCase):
    # view_smoke.cjs's stages and movers runs are about these spots of the seed-1 fixture (review H5 and ART-5),
    # so a fixture change that moves them shows here.
    @classmethod
    def setUpClass(cls):
        ClientViewFixture.setUpClass.__func__(cls)

    def test_bus_shelters_stand_before_66_and_92_park_avenue(self):
        # the City Hall and Hilltop stops stand on the road row just south of each house's south-east lot tile,
        # the camera-nearest one, so a board there would be behind the shelter
        stops = {s["id"]: (s["x"], s["y"]) for s in self.town["stops"]}
        places = {p["id"]: p for p in self.town["places"]}
        for home, stop in (("park_66", "city_hall"), ("park_92", "hilltop_east")):
            p, (sx, sy) = places[home], stops[stop]
            self.assertEqual(p["face"], "s")
            self.assertIn(sy, self.town["road_rows"])
            self.assertEqual((sx, sy - 1), (p["x"] + p["w"], p["y"] + p["h"]), (home, stop))
            self.assertEqual(self.town["tiles"][sy - 1][sx], ".")

    def test_three_walkers_from_three_homes_on_one_kerb(self):
        # ari, lea and efrat live in three homes and, by the view's hash (game.js's FNV-1a), keep to the same kerb
        def fnv(s):
            h = 2166136261
            for c in s:
                h = ((h ^ ord(c)) * 16777619) & 0xFFFFFFFF
            return h
        agents = {a["id"]: a for a in self.state["agents"]}
        homes = [agents[i]["home"] for i in ("ari", "lea", "efrat")]
        self.assertEqual(len(set(homes)), 3, homes)
        self.assertEqual(len({fnv(i) % 2 for i in ("ari", "lea", "efrat")}), 1)


class ClientViewBrowser(unittest.TestCase):
    @unittest.skipUnless(os.environ.get("GOAL_SLOW") == "1", "the browser run of the city view (about 2 minutes) runs with GOAL_SLOW=1")
    @unittest.skipUnless(shutil.which("node"), "node is not installed")
    def test_view_smoke(self):
        # tests/browser/view_smoke.cjs prints SKIP and exits 0 without Playwright or a browser to launch
        try:
            run = subprocess.run(["node", str(SMOKE)], capture_output=True, text=True, timeout=600, cwd=str(ROOT))
        except subprocess.TimeoutExpired:
            self.fail("view_smoke.cjs did not finish in 10 minutes")
        if run.returncode == 0 and run.stdout.startswith("SKIP"):
            self.skipTest(run.stdout.strip())
        self.assertEqual(run.returncode, 0, (run.stdout + run.stderr)[-4000:])
        self.assertRegex(run.stdout, r"\d+ passed, 0 failed")


if __name__ == "__main__":
    unittest.main()

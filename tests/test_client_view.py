"""Static checks for the isometric city view (client/view) and its dev page (client/dev).

The view is a set of classic browser scripts that share one global, window.CityView. These tests keep
it that way: every file is present, nothing uses ES module syntax, nothing reaches for the network or
for image files, and (when Node is installed) every script parses.
"""

import pathlib
import re
import shutil
import subprocess
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
VIEW = ROOT / "client" / "view"
DEV = ROOT / "client" / "dev"

VIEW_SCRIPTS = ["proj.js", "art.js", "buildings.js", "actors.js", "scene.js", "movers.js",
                "camera.js", "minimap.js", "view.js"]
DEV_SCRIPTS = ["fixture_town.js", "fake_state.js"]
FACADE = ["create", "setTown", "setState", "select", "focus", "highlight", "setOverlay", "ping",
          "setInset", "camera", "setMode", "start", "stop"]


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

    def test_facade_methods_present(self):
        text = (VIEW / "view.js").read_text()
        for name in FACADE:
            self.assertRegex(text, rf"\b{name}\b", f"view.js has no {name}")

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


if __name__ == "__main__":
    unittest.main()

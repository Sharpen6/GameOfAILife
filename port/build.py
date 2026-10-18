"""Build the browser port: one self-contained page that runs the whole city with no server.

    python3 port/build.py            # -> port/dist/millbrook.html

The page is client/index.html with every stylesheet (`<link rel="stylesheet" href>`) and script (`<script src>`)
it lists inlined in place, in its own order, read from index.html at build time. Before the first of its scripts
come the port's: guard.js (no real WebSocket can open), the engine and LocalHost (port/src/engine.json) and
page.js, which starts the city and installs the in-page host as `WebSocket`, so game.js talks to it unchanged.

The result loads nothing: the build fails if any http:// or https:// URL is left in it. Links to the separate
character page (`href="character.html...`) cannot work without a server, so any left in the page or its scripts
become `hidden data-page="character.html...` (the dashboard already gives no such link in browser mode).

Python 3 standard library only.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

PORT = Path(__file__).resolve().parent
ROOT = PORT.parent
SRC = PORT / "src"
REGION = ROOT / "gameofailife" / "data" / "region.json"  # inlined as GameOfAILife.REGION_DATA (region.md 9)
INDEX = ROOT / "client" / "index.html"
OUT = PORT / "dist" / "millbrook.html"

URL = re.compile(r"https?://", re.IGNORECASE)
CHARACTER_LINK = 'href="character.html'
CHARACTER_HIDDEN = 'hidden data-page="character.html'


class BuildError(Exception):
    pass


class _Assets(HTMLParser):
    """The stylesheet links and external scripts of a page, in document order, with where each tag starts and
    ends in the text: [kind ("style" | "script"), url, start, end]."""

    def __init__(self, text: str):
        super().__init__(convert_charrefs=True)
        self.text = text
        self._lines = [0]
        for line in text.splitlines(keepends=True):
            self._lines.append(self._lines[-1] + len(line))
        self.assets: list[list] = []
        self._script: list | None = None  # [src, start] of the <script src> being read
        self.feed(text)
        self.close()

    def _at(self) -> int:
        line, col = self.getpos()
        return self._lines[line - 1] + col

    def handle_starttag(self, tag: str, attrs: list) -> None:
        a = {k.lower(): (v or "") for k, v in attrs}
        start = self._at()
        end = start + len(self.get_starttag_text())
        if tag == "link" and "stylesheet" in a.get("rel", "").lower().split() and a.get("href"):
            self.assets.append(["style", a["href"], start, end])
        elif tag == "script" and a.get("src"):
            self._script = [a["src"], start]

    def handle_startendtag(self, tag: str, attrs: list) -> None:
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag: str) -> None:
        if tag == "script" and self._script:
            src, start = self._script
            self._script = None
            end = self.text.index(">", self._at()) + 1
            self.assets.append(["script", src, start, end])


def assets(index_text: str) -> list[tuple[str, str]]:
    """The (kind, url) of every stylesheet and external script index.html lists, in its order."""
    return [(kind, url) for kind, url, _, _ in _Assets(index_text).assets]


def _read_local(client_dir: Path, url: str) -> str:
    if URL.match(url) or url.startswith("//") or ":" in url.split("/")[0]:
        raise BuildError(f"index.html loads {url!r} from elsewhere; the page must be self-contained")
    path = (client_dir / url.split("?")[0].split("#")[0]).resolve()
    if client_dir.resolve() not in path.parents or not path.is_file():
        raise BuildError(f"index.html lists {url!r}, which is not a file in {client_dir}")
    return path.read_text(encoding="utf-8")


def _script(text: str, name: str) -> str:
    # Inside <script>, only "</script" can end the element early; "<\/script" means the same to JavaScript.
    if "<!--" in text:
        raise BuildError(f"{name} contains '<!--', which changes how a browser reads an inline script")
    return f'<script data-src="{name}">\n' + re.sub(r"</(script)", r"<\\/\1", text, flags=re.IGNORECASE) + "\n</script>"


def _style(text: str, name: str) -> str:
    return f'<style data-href="{name}">\n' + re.sub(r"</(style)", r"<\\/\1", text, flags=re.IGNORECASE) + "\n</style>"


def region_data_script(path: Path = REGION) -> str:
    """The region data as a plain inline script (no data-src: it is data, not one of the page's sources), run
    before the port's scripts so region.js finds `GameOfAILife.REGION_DATA`."""
    data = json.dumps(json.loads(path.read_text(encoding="utf-8")), separators=(",", ":"), ensure_ascii=False)
    if "<!--" in data or "</" in data:
        raise BuildError(f"{path} contains '<!--' or '</', which would change how a browser reads an inline script")
    return ("<script>\n(globalThis.GameOfAILife || (globalThis.GameOfAILife = {})).REGION_DATA = " + data
            + ";\n</script>")


def port_scripts() -> list[str]:
    """The port's own scripts, in load order: guard.js, the engine, LocalHost and page.js."""
    spec = json.loads((SRC / "engine.json").read_text(encoding="utf-8"))
    return spec["guard"] + spec["engine"] + spec["host"] + spec["page"]


def build(index: Path = INDEX, out: Path = OUT, client_dir: Path | None = None) -> dict:
    """Write the page; returns what went into it: {"out", "bytes", "styles", "scripts", "port", "hidden_links"}.

    `client_dir` is where index.html's relative URLs point (default: index.html's folder).
    """
    index = Path(index)
    client_dir = Path(client_dir) if client_dir else index.parent
    text = index.read_text(encoding="utf-8")
    found = _Assets(text).assets
    if not any(kind == "script" for kind, *_ in found):
        raise BuildError(f"{index} lists no <script src>: there is no client to inline")
    port = "\n".join([region_data_script()] + [_script((SRC / name).read_text(encoding="utf-8"), f"port/{name}")
                                                for name in port_scripts()])
    first_script = min(start for kind, _, start, _ in found if kind == "script")
    pieces, at = [], 0
    for kind, url, start, end in sorted(found, key=lambda t: t[2]):
        pieces.append(text[at:start])
        body = _read_local(client_dir, url)
        if start == first_script:
            pieces.append(port + "\n")
        pieces.append(_script(body, url) if kind == "script" else _style(body, url))
        at = end
    pieces.append(text[at:])
    page = "".join(pieces)
    hidden = page.count(CHARACTER_LINK)
    page = page.replace(CHARACTER_LINK, CHARACTER_HIDDEN)
    left = sorted({page[m.start():m.end() + 40].split()[0] for m in URL.finditer(page)})
    if left:
        raise BuildError("the page would load from elsewhere: " + ", ".join(left))
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(page, encoding="utf-8")
    return {"out": str(out), "bytes": len(page.encode("utf-8")),
            "styles": [url for kind, url, _, _ in found if kind == "style"],
            "scripts": [url for kind, url, _, _ in found if kind == "script"],
            "port": port_scripts(), "hidden_links": hidden}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python3 port/build.py", description=__doc__.split("\n\n")[0])
    ap.add_argument("--index", type=Path, default=INDEX, help="the page to build from (default client/index.html)")
    ap.add_argument("--client", type=Path, default=None, help="where its URLs point (default: its folder)")
    ap.add_argument("--out", type=Path, default=OUT, help="the page to write (default port/dist/millbrook.html)")
    args = ap.parse_args(argv)
    try:
        got = build(args.index, args.out, args.client)
    except (BuildError, OSError) as exc:
        print(f"build failed: {exc}", file=sys.stderr)
        return 1
    print(f"wrote {got['out']} ({got['bytes']:,} bytes)")
    print(f"  stylesheets: {', '.join(got['styles']) or 'none'}")
    print(f"  scripts:     {', '.join(got['scripts'])}")
    print(f"  port:        {', '.join(got['port'])}")
    if got["hidden_links"]:
        print(f"  hid {got['hidden_links']} character.html link(s): the page has no server for them")
    return 0


if __name__ == "__main__":
    sys.exit(main())

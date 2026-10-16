#!/usr/bin/env python3
"""Bundelt de webapp tot één HTML-bestand en maakt er een header voor de ESP32 van.

    python3 tools/build_web.py

Schrijft:
    app/dist/                              de online app (index.html, manifest, service worker, pictogrammen)
    firmware/trekker_gps/web_app.h         gecomprimeerde app in het geheugen van de ESP32
"""
import gzip
import hashlib
import pathlib
import shutil

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "app" / "src"
ORDER = ["brand.js", "nmea.js", "geo.js", "isoxml.js", "zip.js", "store.js", "sync.js", "box.js", "demo.js", "app.js"]


def main() -> None:
    template = (ROOT / "app" / "index.html").read_text(encoding="utf-8")
    scripts = []
    for name in ORDER:
        code = (SRC / name).read_text(encoding="utf-8")
        if "</script" in code.lower():
            raise SystemExit(f"{name} bevat '</script', dat breekt de HTML")
        scripts.append(f"<script>\n{code}</script>")
    if "<!-- SCRIPTS -->" not in template:
        raise SystemExit("app/index.html mist <!-- SCRIPTS -->")
    html = template.replace("<!-- SCRIPTS -->", "\n".join(scripts))

    dist_dir = ROOT / "app" / "dist"
    dist_dir.mkdir(parents=True, exist_ok=True)
    (dist_dir / "index.html").write_text(html, encoding="utf-8")
    version = hashlib.sha256(html.encode("utf-8")).hexdigest()[:12]
    for f in (ROOT / "app" / "static").iterdir():
        if f.name == "sw.js":
            (dist_dir / f.name).write_text(f.read_text(encoding="utf-8").replace("__VERSION__", version), encoding="utf-8")
        else:
            shutil.copyfile(f, dist_dir / f.name)

    data = gzip.compress(html.encode("utf-8"), compresslevel=9, mtime=0)
    data = bytes(data[:9]) + b"\xff" + bytes(data[10:])  # OS-byte vast, zelfde uitkomst op elke computer
    rows = []
    for i in range(0, len(data), 20):
        rows.append("  " + ", ".join(f"0x{b:02x}" for b in data[i:i + 20]) + ",")
    header = (
        "// Automatisch gemaakt door tools/build_web.py. Niet met de hand aanpassen.\n"
        "#pragma once\n#include <Arduino.h>\n\n"
        f"static const size_t WEB_APP_GZ_LEN = {len(data)};\n"
        "static const uint8_t WEB_APP_GZ[] PROGMEM = {\n" + "\n".join(rows) + "\n};\n"
    )
    (ROOT / "firmware" / "trekker_gps" / "web_app.h").write_text(header, encoding="utf-8")
    print(f"app/dist/index.html: {len(html)} bytes, gzip voor ESP32: {len(data)} bytes")


if __name__ == "__main__":
    main()

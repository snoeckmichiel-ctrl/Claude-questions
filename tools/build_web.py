#!/usr/bin/env python3
"""Bundelt de webapp tot één HTML-bestand en maakt er een header voor de ESP32 van.

    python3 tools/build_web.py

Schrijft:
    app/dist/index.html                    om lokaal of via USB te gebruiken
    firmware/trekker_gps/web_app.h         gecomprimeerde app in het geheugen van de ESP32
"""
import gzip
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "app" / "src"
ORDER = ["brand.js", "nmea.js", "geo.js", "isoxml.js", "zip.js", "demo.js", "app.js"]


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

    dist = ROOT / "app" / "dist" / "index.html"
    dist.parent.mkdir(parents=True, exist_ok=True)
    dist.write_text(html, encoding="utf-8")

    data = gzip.compress(html.encode("utf-8"), compresslevel=9, mtime=0)
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

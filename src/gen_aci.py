#!/usr/bin/env python3
"""Generate the AutoCAD ACI (Color Index) -> RGB table used by the viewer.

Data source: ezdxf colors.py, AutoCAD 2020 palettes.
  - DXF_DEFAULT_COLORS            -> model space (dark background)
  - DXF_DEFAULT_PAPERSPACE_COLORS -> paper space (white background)
For 10..249 both palettes should be identical; the few entries where the
model-space table deviates from both the paper-space table and the closed-form
hue formula are upstream typos and are corrected here.
"""
import re
import os

HERE = os.path.dirname(os.path.abspath(__file__))


def grab(source_text, name):
    m = re.search(name + r"\s*=\s*\[(.*?)\n\]", source_text, re.S)
    if not m:
        raise RuntimeError("table not found: " + name)
    return [int(v, 16) for v in re.findall(r"0x([0-9A-Fa-f]{6})", m.group(1))]


def rgb(v):
    return ((v >> 16) & 255, (v >> 8) & 255, v & 255)


def dist(a, b):
    return sum(abs(x - y) for x, y in zip(rgb(a), rgb(b)))


def hue_rgb(h):
    h = h % 360.0
    s = h / 60.0
    i = int(s)
    f = s - i
    return [(1, f, 0), (1 - f, 1, 0), (0, 1, f),
            (0, 1 - f, f), (f, 0, 1), (1, 0, 1 - f)][i % 6]


def formula(index):
    n = index - 10
    family, variant = divmod(n, 10)
    light = [255, 165, 127, 76, 38][variant // 2]
    tint = variant % 2
    c = [int(light * v + 0.5) for v in hue_rgb(family * 15.0)]
    if tint:
        m = max(c)
        c = [int((v + m) / 2.0 + 0.5) for v in c]
    return (c[0] << 16) | (c[1] << 8) | c[2]


def main():
    with open(os.path.join(HERE, "colors.py"), "r", encoding="utf-8") as f:
        text = f.read()
    model = grab(text, "DXF_DEFAULT_COLORS")
    paper = grab(text, "DXF_DEFAULT_PAPERSPACE_COLORS")
    assert len(model) == 256 and len(paper) == 256, "unexpected table length"

    result = list(model)
    fixed = []
    for i in range(10, 250):
        f = formula(i)
        dm, dp = dist(model[i], f), dist(paper[i], f)
        if model[i] != paper[i] and dp < dm:
            result[i] = paper[i]
            fixed.append((i, model[i], paper[i]))
        else:
            result[i] = model[i]
    result[7] = 0xFFFFFF  # runtime flips index 7 for light backgrounds
    print("official table: 256 entries; corrected typos:", len(fixed))
    for i, a, b in fixed:
        print("  ACI %3d #%06X -> #%06X" % (i, a, b))

    lines = [
        "// AutoCAD Color Index (ACI) 1..255 -> 0xRRGGBB. Index 0 is unused.",
        "// AutoCAD 2020 palette (ezdxf colors.py), verified against the",
        "// 24-hue x 5-brightness x 2-tint closed form; typos corrected.",
        "// ACI 7 (white/black) is inverted at runtime on light backgrounds.",
        "var ACI_RGB = [",
    ]
    for i in range(0, 256, 8):
        lines.append("  " + ", ".join("0x%06X" % v for v in result[i:i + 8]) + ",")
    lines.append("];")
    with open(os.path.join(HERE, "aci.js"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print("wrote aci.js")


if __name__ == "__main__":
    main()

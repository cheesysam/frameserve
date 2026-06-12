#!/usr/bin/env python3
"""Generate test images for Frameserve — pure stdlib, no dependencies.

Creates a handful of labelled, colour-coded PNGs spread across several
subfolders so you can exercise the slideshow, the favourites list, and the
"favour a different folder" setting. Run: python3 gen_test_images.py
"""
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(__file__), "photos")
W, H = 1280, 800

# 5x7 bitmap font, just enough glyphs for the folder labels + digits.
FONT = {
    "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
    "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
    "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
    "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
    "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
    "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
    "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
    "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
    "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
    "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
    " ": ["00000"] * 7,
    "A": ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
    "B": ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
    "C": ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
    "E": ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
    "F": ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
    "H": ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
    "I": ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
    "L": ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
    "M": ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
    "N": ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
    "O": ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
    "R": ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
    "T": ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
    "U": ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
    "Y": ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
}

# folder -> (background RGB, list of labels)
FOLDERS = {
    "beach":     ((28, 107, 160),  ["BEACH 1", "BEACH 2", "BEACH 3"]),
    "mountains": ((70, 95, 70),    ["MOUNTAIN 1", "MOUNTAIN 2", "MOUNTAIN 3"]),
    "city":      ((90, 70, 110),   ["CITY 1", "CITY 2", "CITY 3"]),
    "family":    ((150, 90, 60),   ["FAMILY 1", "FAMILY 2"]),
}


def make_canvas(bg):
    # Row-major RGB, plus a subtle vertical gradient so images aren't flat.
    rows = []
    for y in range(H):
        f = y / H
        r = int(bg[0] * (0.7 + 0.3 * f))
        g = int(bg[1] * (0.7 + 0.3 * f))
        b = int(bg[2] * (0.7 + 0.3 * f))
        rows.append([(r, g, b)] * W)
    return rows


def draw_text(canvas, text, cx, cy, scale, color=(255, 255, 255)):
    gw, gh, gap = 5, 7, 1
    total_w = len(text) * (gw + gap) * scale
    x0 = cx - total_w // 2
    y0 = cy - (gh * scale) // 2
    for gi, ch in enumerate(text):
        glyph = FONT.get(ch, FONT[" "])
        gx = x0 + gi * (gw + gap) * scale
        for ry, row in enumerate(glyph):
            for rx, bit in enumerate(row):
                if bit != "1":
                    continue
                for sy in range(scale):
                    for sx in range(scale):
                        px = gx + rx * scale + sx
                        py = y0 + ry * scale + sy
                        if 0 <= px < W and 0 <= py < H:
                            canvas[py][px] = color


def write_png(path, canvas):
    raw = bytearray()
    for row in canvas:
        raw.append(0)  # filter type 0 (none)
        for (r, g, b) in row:
            raw += bytes((r, g, b))

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        c += struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        return c

    ihdr = struct.pack(">IIBBBBB", W, H, 8, 2, 0, 0, 0)  # 8-bit RGB
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", ihdr))
        f.write(chunk(b"IDAT", zlib.compress(bytes(raw), 6)))
        f.write(chunk(b"IEND", b""))


def main():
    count = 0
    for folder, (bg, labels) in FOLDERS.items():
        d = os.path.join(OUT, folder)
        os.makedirs(d, exist_ok=True)
        for label in labels:
            canvas = make_canvas(bg)
            draw_text(canvas, folder.upper(), W // 2, H // 2 - 90, 8)
            draw_text(canvas, label.split()[-1], W // 2, H // 2 + 60, 22)
            fname = label.lower().replace(" ", "_") + ".png"
            write_png(os.path.join(d, fname), canvas)
            count += 1
    print(f"Wrote {count} test images under {OUT}/")


if __name__ == "__main__":
    main()

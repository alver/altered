#!/usr/bin/env python3
"""extract_markers.py — pull the punch-board chips (Expedition markers, First
Player, Anchored, Asleep) out of the official Print&Play PunchBoard PDF and write
them to assets/markers/ as circular transparent PNGs.

Page 0 holds, per faction, a Hero-row and Companion-row Expedition marker (cols
Axiom, Bravos, Lyra | Yzmir, Muna, Ordis), plus the status chips and the big
blue First Player swirl. We render the sheet at 300 dpi, find the round tokens by
connected components, and mask each to a circle.

Requires:  pip install pymupdf numpy scipy pillow
Run from webgame/:  python3 tools/extract_markers.py
"""
import os
import fitz
import numpy as np
from scipy import ndimage
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PDF = os.path.normpath(os.path.join(
    ROOT, '..', '2024_Altered_TCG_Accessories',
    '2024_Altered_TCG_PunchBoard_PRINT_PLAY_A4.pdf'))
OUT = os.path.join(ROOT, 'assets', 'markers')
FACS = ['AX', 'BR', 'LY', 'YZ', 'MU', 'OR']     # left group then right group


def main():
    os.makedirs(OUT, exist_ok=True)
    page = fitz.open(PDF)[0]
    pix = page.get_pixmap(dpi=300)
    arr = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width, pix.n)[:, :, :3]
    ink = ndimage.binary_closing(arr.mean(2) < 244, iterations=3)
    lbl, n = ndimage.label(ink)
    comps = []
    for i in range(1, n + 1):
        ys, xs = np.where(lbl == i)
        comps.append((ys.min(), xs.min(), ys.max(), xs.max(), xs.max() - xs.min(), ys.max() - ys.min()))

    def save(t, path, sz=200):
        y0, x0, y1, x1 = t[:4]
        crop = arr[y0:y1, x0:x1].copy()
        h, w = crop.shape[:2]
        yy, xx = np.ogrid[:h, :w]
        r = min(h, w) / 2 - 2
        mask = ((yy - h / 2) ** 2 + (xx - w / 2) ** 2) <= r * r
        im = Image.fromarray(np.dstack([crop, (mask * 255).astype(np.uint8)]), 'RGBA')
        im.thumbnail((sz, sz))
        im.save(path)

    # Expedition markers: the two bottom rows (y centre > 1300), ~236 px.
    exp = [t for t in comps if (t[0] + t[2]) / 2 > 1300 and 200 < t[4] < 270 and 200 < t[5] < 270]
    exp.sort(key=lambda t: (0 if (t[0] + t[2]) / 2 < 1500 else 1, (t[1] + t[3]) / 2))
    for k, t in enumerate(exp[:12]):
        save(t, os.path.join(OUT, f"exp_{FACS[k % 6]}_{['hero', 'comp'][k // 6]}.png"))

    # First Player swirl: the big (~400 px) round token.
    swirl = sorted([t for t in comps if 360 < t[4] < 520 and 360 < t[5] < 520],
                   key=lambda t: t[4] * t[5], reverse=True)
    if swirl:
        save(swirl[0], os.path.join(OUT, 'first_player.png'))

    def near(xc, yc, tol=70):
        for t in comps:
            if abs((t[1] + t[3]) / 2 - xc) < tol and abs((t[0] + t[2]) / 2 - yc) < tol:
                return t
        return None
    if near(726, 717):
        save(near(726, 717), os.path.join(OUT, 'anchored.png'), 120)   # green anchor
    if near(726, 949):
        save(near(726, 949), os.path.join(OUT, 'asleep.png'), 120)     # purple moon
    print('Wrote Expedition / First Player / status markers to', OUT)


if __name__ == '__main__':
    main()

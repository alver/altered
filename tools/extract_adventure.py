#!/usr/bin/env python3
"""extract_adventure.py — pull the real Adventure cards (Hero region, three
Tumults, Companion region) out of the official Print&Play accessories PDF and
write them to assets/adventure/ for the game's Tumult track.

Page 1 of the PDF is a 2x4 card sheet:
    row 1: Hero, Tumult 1, Tumult 2, Tumult 3
    row 2: Companion, "Phases of the Day", "Icons"

We render high-res page crops (so the vector frames + terrain icons are kept,
unlike the raw embedded rasters), then rotate the Tumults to landscape (they sit
horizontally on the playmat, each spanning two track positions).

Requires PyMuPDF:  pip install pymupdf
Then (from webgame/):  python3 tools/extract_adventure.py
Card images are downscaled afterwards with `sips` in the shell; see CLAUDE.md.
"""
import os
import fitz   # PyMuPDF

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PDF = os.path.normpath(os.path.join(
    ROOT, '..', '2024_Altered_TCG_Accessories',
    '2024_Altered_TCG_Adventures_Help_Cards_PRINT_PLAY_A4.pdf'))
OUT = os.path.join(ROOT, 'assets', 'adventure')

# Card rectangles on page 0 (points), from page.get_image_rects().
CARDS = {
    'hero':      fitz.Rect(63.8, 48.2, 242.3, 297.9),
    'tumult1':   fitz.Rect(242.3, 48.2, 420.8, 297.9),
    'tumult2':   fitz.Rect(420.9, 48.2, 599.4, 297.9),
    'tumult3':   fitz.Rect(599.5, 48.2, 778.0, 297.9),
    'companion': fitz.Rect(63.8, 297.6, 242.3, 547.4),
}


def main():
    os.makedirs(OUT, exist_ok=True)
    page = fitz.open(PDF)[0]
    for name, r in CARDS.items():
        rr = r + (1.5, 1.5, -1.5, -1.5)            # tiny inset (cards touch)
        page.get_pixmap(clip=rr, dpi=300).save(os.path.join(OUT, name + '.png'))
        print('wrote', name + '.png')
    print('Now rotate the tumults to landscape and downscale, e.g.:')
    print('  for n in 1 2 3; do sips --rotate 90 tumult$n.png --out tumult${n}_wide.png; done')
    print('  sips -Z 560 hero.png companion.png tumult*_wide.png')


if __name__ == '__main__':
    main()

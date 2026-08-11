#!/usr/bin/env python3
"""Build the metrics-only caret strut font.

The outline row (`.notes-node-title-field`) is 16px/25px. A line's caret height
comes from the line's *content box*, which is `ascent + descent` of the line's
strut font -- the first font in the stack. Real text fonts leave half-leading
(3px top and bottom here), and WebKit hands the second line of a wrapped row a
taller caret than the first. This font carries no outlines at all: one empty
`space` glyph, `ascent + descent = 156.25%` of the em, so at 16px the content
box is exactly 25px, half-leading is 0, and every line's caret is 25px tall.
Text itself is still drawn by the next font in the stack (Inter/system).

Metrics are tuned so the baseline does not move: measured in the running app,
the text font sits at ascent 15.5px / descent 3.5px with 3px half-leading, so
the strut ascent is 15.5 + 3 = 18.5px (1.15625em) and the descent is the
remaining 6.5px (0.40625em). unitsPerEm is 1024 rather than 1000 so both --
and the measured 4.1875px space advance -- land on whole units.

Usage (fonttools is a build-time tool, deliberately not a project dependency):

    python3 -m venv /tmp/fontenv
    /tmp/fontenv/bin/pip install fonttools brotli   # brotli is needed for woff2
    /tmp/fontenv/bin/python scripts/buildCaretStrutFont.py

Output: apps/desktop/src/assets/yonalist-caret-strut.woff2 (byte-identical on
re-run -- the head timestamps are pinned).
"""

from pathlib import Path

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

UNITS_PER_EM = 1024
ASCENT = 1184  # 1.15625em -> 18.5px at 16px
DESCENT = 416  # 0.40625em -> 6.5px at 16px; ASCENT + DESCENT = 1.5625em = 25px
SPACE_ADVANCE = 268  # 0.26171875em -> 4.1875px at 16px, the measured space width

BUILD_TIMESTAMP = 3869337600  # 2026-08-12 in the font epoch (1904-01-01)

FS_SELECTION_REGULAR = 1 << 6
FS_SELECTION_USE_TYPO_METRICS = 1 << 7

OUTPUT = (
    Path(__file__).resolve().parent.parent
    / "apps/desktop/src/assets/yonalist-caret-strut.woff2"
)


def build() -> None:
    fb = FontBuilder(unitsPerEm=UNITS_PER_EM, isTTF=True)
    fb.setupGlyphOrder([".notdef", "space"])
    fb.setupCharacterMap({0x20: "space"})

    # `space` is empty -- it only carries an advance. `.notdef` gets a real box:
    # a woff2 whose glyf table is entirely empty is rejected by the browser font
    # sanitizer ("Invalid font data"), and .notdef is never rendered anyway
    # because nothing but U+0020 maps into this font.
    notdef = TTGlyphPen(None)
    notdef.moveTo((0, 0))
    notdef.lineTo((0, ASCENT))
    notdef.lineTo((SPACE_ADVANCE, ASCENT))
    notdef.lineTo((SPACE_ADVANCE, 0))
    notdef.closePath()
    fb.setupGlyf({".notdef": notdef.glyph(), "space": TTGlyphPen(None).glyph()})
    fb.setupHorizontalMetrics(
        {".notdef": (SPACE_ADVANCE, 0), "space": (SPACE_ADVANCE, 0)}
    )
    fb.setupHorizontalHeader(ascent=ASCENT, descent=-DESCENT, lineGap=0)
    fb.setupNameTable(
        {
            "familyName": "Yonalist Caret Strut",
            "styleName": "Regular",
            "uniqueFontIdentifier": "Yonalist Caret Strut Regular",
            "fullName": "Yonalist Caret Strut Regular",
            "psName": "YonalistCaretStrut-Regular",
            "version": "Version 1.000",
        }
    )
    fb.setupOS2(
        version=4,  # USE_TYPO_METRICS (fsSelection bit 7) needs OS/2 v4 or later
        sTypoAscender=ASCENT,
        sTypoDescender=-DESCENT,
        sTypoLineGap=0,
        usWinAscent=ASCENT,
        usWinDescent=DESCENT,
        fsSelection=FS_SELECTION_REGULAR | FS_SELECTION_USE_TYPO_METRICS,
        achVendID="YONA",
    )
    fb.setupPost()

    head = fb.font["head"]
    head.created = head.modified = BUILD_TIMESTAMP  # pinned: a rebuild is byte-identical

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    fb.font.flavor = "woff2"
    fb.save(OUTPUT)
    print(f"wrote {OUTPUT} ({OUTPUT.stat().st_size} bytes)")


if __name__ == "__main__":
    build()

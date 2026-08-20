# Bundled Font Sources

## Nanum Gothic, for PDF export

Retrieved from the authoritative Google Fonts repository on 2026-07-10.

| Source | Exact upstream URL | Size (bytes) | SHA-256 |
| --- | --- | ---: | --- |
| Nanum Gothic Regular font | https://raw.githubusercontent.com/google/fonts/main/ofl/nanumgothic/NanumGothic-Regular.ttf | 2,054,744 | `76f45ef4a6bcff344c837c95a7dcc26e017e38b5846d5ae0cdcb5b86be2e2d31` |
| SIL Open Font License | https://raw.githubusercontent.com/google/fonts/main/ofl/nanumgothic/OFL.txt | 4,534 | `eeacf16032901d0ed0456876ec77b8f0fda6b3fecec7d972f8543eb602e6c30f` |
| Google Fonts metadata | https://raw.githubusercontent.com/google/fonts/main/ofl/nanumgothic/METADATA.pb | 1,195 | `3f58e10d125ed43d363f1730b14a29a740f61c39dfa8dc1cb7be532b0072b2e2` |

Nanum Gothic is licensed under the SIL Open Font License, Version 1.1. The
complete upstream license is tracked alongside the font as
`NanumGothic-OFL.txt`.

`NanumGothic-Regular.ttf` and `NanumGothic-OFL.txt` are byte-for-byte copies
of the upstream files. The font has not been subset, converted, renamed
internally, or otherwise modified. `METADATA.pb` is documented here for
provenance and is not bundled.

## Excalifont, for the handwriting text setting

Retrieved from the Excalidraw repository on 2026-08-20. Every file is a
byte-for-byte copy of
`https://raw.githubusercontent.com/excalidraw/excalidraw/master/packages/excalidraw/fonts/Excalifont/<upstream name>`,
renamed from its content hash to the unicode range it covers and stored under
`apps/desktop/src/assets/excalifont/`. Nothing else was subset, converted or
renamed internally -- the name table still reads `Excalifont`.

| Bundled name | Upstream name | Size (bytes) | SHA-256 |
| --- | --- | ---: | --- |
| excalifont-latin.woff2 | Excalifont-Regular-a88b72a24fb54c9f94e3b5fdaa7481c9.woff2 | 24,956 | `e4423b318e11432aff2e6e865e300b7ca270f92321a3f56632268fede01c1b48` |
| excalifont-latin-ext.woff2 | Excalifont-Regular-be310b9bcd4f1a43f571c46df7809174.woff2 | 12,220 | `4fb8ad69be9aeac5664d99e5aa3a68a27ea40c98943b80387f7cd55c034fcc93` |
| excalifont-cyrillic.woff2 | Excalifont-Regular-b9dcf9d2e50a1eaf42fc664b50a3fd0d.woff2 | 13,296 | `b424d16da4398be3e9852857a54ff70e043c8e2ec5c4444dbf7f88d7469b9859` |
| excalifont-cyrillic-ext.woff2 | Excalifont-Regular-349fac6ca4700ffec595a7150a0d1e1d.woff2 | 2,656 | `a0637cff365c7344d2f7a15905a1f74dceaf56b5ac2ff913d150358bed6921f0` |
| excalifont-greek.woff2 | Excalifont-Regular-41b173a47b57366892116a575a43e2b6.woff2 | 8,712 | `c96649a5f96e2faa9143ee94e5b590b5afb08092f8d67c67f09cef332d66e4a7` |
| excalifont-marks.woff2 | Excalifont-Regular-3f2c5db56cc93c5a6873b1361d730c16.woff2 | 2,104 | `18ea9be1dd6b5a67b057f44eba8e34cb290f88308c272bcf35c79c1a220d0d7b` |
| excalifont-combining.woff2 | Excalifont-Regular-623ccf21b21ef6b3a0d87738f77eb071.woff2 | 824 | `b004007be100261e58188cf8a0f7e850e997702f35d57110915995cd880e49f1` |

Excalifont is licensed under the SIL Open Font License, Version 1.1. The
subsets carry the copyright in their own name table but not the license text,
so it ships beside them as `Excalifont-OFL.txt`.

## Xiaolai SC, for Hangul in the handwriting text setting

Retrieved from the Excalidraw repository on 2026-08-21. Excalifont has no
Hangul glyphs, so Excalidraw loads a second hand-drawn face for CJK, and that
face -- Xiaolai SC, derived from SetoFont -- is what draws Korean on
excalidraw.com.

Excalidraw splits Xiaolai into 209 woff2 subsets. The 52 whose declared
unicode-range reaches Hangul are bundled under
`apps/desktop/src/assets/xiaolai/` as byte-for-byte copies of
`https://raw.githubusercontent.com/excalidraw/excalidraw/master/packages/excalidraw/fonts/Xiaolai/<name>`,
under their upstream names, together with the ranges Excalidraw declares for
them in `packages/excalidraw/fonts/Xiaolai/index.ts`. Between them they reach
11,171 of the 11,172 modern Hangul syllables. The remaining 157 subsets carry
Chinese and Japanese this setting never asks for and are not bundled.

| Item | Value |
| --- | --- |
| Bundled subsets | 52 files, 3,202,004 bytes, listed with their SHA-256 in `apps/desktop/src/assets/xiaolai/SHA256SUMS` |
| License | https://raw.githubusercontent.com/lxgw/kose-font/master/OFL.txt, 4,432 bytes, `0df7e09be4c2c850a48bd8beb9cd64b343aad49cd5d3f6cfb2ad2e3d28a56ca4` |

Xiaolai SC is licensed under the SIL Open Font License, Version 1.1,
copyright 2020-2024 LXGW and 2014 Nozomi Seto. The subsets carry no license
text of their own, so it ships beside them as `Xiaolai-OFL.txt`.

## Nanum Pen Script, the second hand the outline can be written in

Retrieved from Google Fonts on 2026-08-21. Xiaolai's Hangul comes down from a
Japanese face, so the handwriting setting also offers a Korean hand, and that
one writes the whole outline: picking it puts Nanum Pen Script ahead of
Excalifont, so its Latin runs too.

Google Fonts serves the family as 93 woff2 chunks, all of them bundled under
`apps/desktop/src/assets/nanum-pen/` and renamed only from the served hash to
the chunk index each already carries, except the Latin chunk, which is named
for what it covers. The chunks and their unicode ranges come from
`https://fonts.googleapis.com/css2?family=Nanum+Pen+Script&display=swap`, read
with a browser user agent, and each file is a byte-for-byte copy of the
`https://fonts.gstatic.com/s/nanumpenscript/v25/...` URL that stylesheet names.

| Item | Value |
| --- | --- |
| Bundled chunks | 93 files, 1,311,112 bytes, listed with their SHA-256 in `apps/desktop/src/assets/nanum-pen/SHA256SUMS` |
| License | https://raw.githubusercontent.com/google/fonts/main/ofl/nanumpenscript/OFL.txt, 4,534 bytes, `eeacf16032901d0ed0456876ec77b8f0fda6b3fecec7d972f8543eb602e6c30f` |

Nanum Pen Script is licensed under the SIL Open Font License, Version 1.1,
copyright 2010 NHN Corporation, designed by Sandoll Communications. That
license reserves the Nanum names, which is why the bundled files are Google's
own builds rather than a conversion of our own, and it ships beside them as
`NanumPenScript-OFL.txt`. Its text matches `NanumGothic-OFL.txt` except for two
trailing spaces this repository's copy of that file has lost; the recorded
hash there is the upstream one, not the file's current hash.

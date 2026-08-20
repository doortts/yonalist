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

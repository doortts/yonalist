# Notes Unicode 17 Runtime Parity Design

**Status:** Approved for implementation

## Goal

Make Notes text classification deterministic across the Rust backend, Node
tests, and the macOS Tauri WebView while preserving the existing Unicode 17
tag contract.

## Current Failure

The Rust tokenizer uses `unicode-properties` data for Unicode 17, but the
frontend classifies letters, numbers, and marks with JavaScript Unicode
property escapes. Those escapes use the Unicode database embedded in the host
JavaScript engine. Current Node and macOS WebKit builds therefore reject newer
Unicode 17 characters such as U+A7CE and U+1ACF even though the shared fixture
and Rust tokenizer accept them.

The same host-dependent classification appears in both tag tokenization and
date-word boundary detection, so correcting only the failing tag fixture would
leave a sibling inconsistency in Notes date parsing.

## Selected Approach

Pin the frontend's required Unicode 17 general-category data at build time.

- Add `@unicode/unicode-17.0.0` as a development dependency.
- Import only its precompiled `Letter`, `Number`, and `Mark` regular
  expressions through one Notes Unicode-category helper.
- Replace the host `\p{L}`, `\p{N}`, and `\p{M}` checks in `noteTokens.ts` and
  `noteDates.ts` with that helper.
- Keep whitespace handling unchanged because it is outside the shared
  tokenizer parity failure and is not version-sensitive in the same way.

Vite will bundle the imported regular expressions into the application, so
classification at runtime does not depend on the WebView's Unicode version.
The package remains a development dependency because it supplies build input,
not a separately loaded application runtime.

## Helper Contract

The shared helper exposes only the predicates Notes needs:

- `isUnicodeLetterOrNumber(character)`
- `isUnicodeMark(character)`
- `isUnicodeWordCharacter(character)`, including underscore

Each predicate accepts one Unicode scalar string and returns a boolean. It does
not normalize or case-fold text; the existing tag identity code retains that
responsibility.

## Testing

Use the existing failing shared tokenizer fixture as the primary RED test.
Add focused coverage that proves:

1. U+A7CE is accepted as a Unicode 17 letter at tag start;
2. U+1ACF is accepted as a Unicode 17 combining mark after a tag-start
   character;
3. those same categories prevent a natural-language date match from starting
   inside a Unicode word; and
4. punctuation and emoji remain outside the word categories.

Then run the shared frontend fixture, focused Notes date tests, the matching
Rust shared-fixture test, the full frontend suite, lint, production build, and
`git diff --check`.

## Rejected Alternatives

### Patch only Unicode 17 additions

A small exception range would fix current Node and WebKit, but would still rely
on the host engine for older assigned characters and could regress on another
supported macOS version.

### Downgrade the shared contract to Unicode 16

This would make the current frontend test pass only by removing intended
Unicode 17 behavior already implemented by the backend.

### Upgrade only the Node test runtime

A newer Node version could hide the failing fixture while the shipped macOS
WebView continued to tokenize the same note differently.

## Out of Scope

- Changing tag normalization or case-folding behavior.
- Replacing general frontend text segmentation outside Notes tags and dates.
- Changing the Rust tokenizer or shared fixture schema.
- The separate multi-selection drop-preview fix, which resumes after this
  parity bug is corrected.

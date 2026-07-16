# Theme-aware Notes editor alignment

## Problem

`NoteTextField` overlays tokenized presentation text on a native textarea and
switches between them when editing starts. Notes CSS currently applies fixed
vertical translations to the textarea. Soft Paper changes the application font
to Avenir Next, whose native textarea metrics do not match those fixed offsets,
so a row title moves upward when it receives the caret.

## Design

Keep Soft Paper's Avenir Next typography and the existing presentation/textarea
editing model. Replace the two fixed translations with theme-owned CSS custom
properties:

- a general Notes textarea editing offset;
- a Notes row-title editing offset.

The root theme contract keeps the current offsets for themes using the shared
font stack. Soft Paper keeps the general textarea offset at `-1px` and overrides
only the row-title offset to `0px` for Avenir Next. The two values differ because
the page title uses the general field geometry while outline rows use the
row-title override. Notes CSS consumes only the custom properties, so
typography-specific calibration lives beside the theme typography instead of
inside the editor layout.

## Regression protection

Update the existing Notes CSS contract test so it verifies that editor alignment
uses the theme variables rather than fixed pixel values. Add a theme contract
assertion requiring every named theme that declares its own `font-family` to
also declare both Notes editing offsets. This cannot visually calibrate a new
font, but it prevents a new font theme from silently inheriting offsets selected
for another font stack.

## Scope and verification

No React behavior, persistence, selection logic, or typography changes are in
scope. Run the focused Notes workspace test first, followed by the complete
frontend test suite, lint, and production build. Confirm the Soft Paper title
does not shift when entering and leaving edit mode.

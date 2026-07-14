# Notes Editor Alignment and Page-Title Navigation Design

**Status:** Approved for written review

## Goal

Keep every Notes text field visually stationary when it switches between its
resting and editing presentations, and let the zoomed page title participate in
the same arrow-key focus navigation as ordinary outline rows.

## Verified Root Causes

### Editing text moves down

`NoteTextField` renders two presentations in the same box:

- a token-aware `NoteTokenText` span while the field is resting;
- a native `textarea` while the field is being edited.

Both presentations share the same font size and line height, but WebKit paints
the native textarea's text baseline about one CSS pixel lower than the span's
baseline. Focusing or hovering into a field changes which presentation is
visible, so only that line appears to move down. Screen-coordinate comparison
in the running desktop app confirmed an approximately one-CSS-pixel shift.

### The zoomed page title cannot move to another row

`NotesPageHeader` already delegates key interpretation to `resolveOutlineKey`.
For ArrowDown on the zoom root, that resolver correctly returns a `focus`
action targeting the first visible child. The page-header handler accepts
several resolver actions but omits `focus`, so it silently discards the valid
navigation result. Ordinary outline rows already handle the same action.

## Behavior

### Consistent editing alignment

All textareas owned by `NoteTextField` receive the same one-pixel upward visual
correction. This includes the page title, page note, row title, and row note.
The resting and editing text baselines therefore remain aligned as selection,
focus, and pointer state change.

Use a visual transform on the native textarea instead of changing its padding,
height, or line height. A transform does not participate in layout, so existing
auto-grow measurement, wrapping, hit area, and surrounding row geometry remain
unchanged.

### Page-title arrow navigation

The zoomed page title accepts the resolver's existing `focus` action. Before
moving focus, it saves any pending page-title draft through the existing Notes
action path. It then focuses the resolver-provided node rather than calculating
a destination locally.

This gives the page title the same navigation semantics as the outline:

- ArrowDown moves from the zoomed page title to its first visible child.
- ArrowRight at a caret boundary follows the resolver's existing next-row rule.
- ArrowUp and ArrowLeft remain no-ops when the resolver finds no visible target.
- Existing completion, duplication, deletion, and note-focus shortcuts keep
  their current behavior.

## Implementation

Add a narrowly scoped CSS rule for the direct textarea child of
`.notes-text-field`:

```css
.notes-text-field > textarea {
  transform: translateY(-1px);
}
```

Keep the correction at the shared `NoteTextField` boundary so individual title
and note variants cannot drift apart.

In `NotesPageHeader`, include `focus` among the accepted outline-key results.
Handle it like `OutlineNodeRow`: flush the current title draft, preserve the
existing blur-suppression behavior, and call `actions.focusNode` with the
resolved node ID. Do not add a second traversal algorithm.

## Event Flow

1. Pointer or keyboard focus activates a Notes field.
2. `NoteTextField` swaps visibility from the token span to the textarea.
3. The shared visual correction keeps the textarea glyphs on the resting
   span's baseline without changing layout measurements.
4. When ArrowDown or a supported boundary-navigation key is pressed in the
   zoomed page title, `resolveOutlineKey` returns a destination.
5. `NotesPageHeader` saves pending text and delegates focus to that destination.

## Testing

Add regression coverage before implementation:

- A Notes style-contract test requires the shared textarea baseline correction
  at the `.notes-text-field` boundary.
- A Notes workspace interaction test zooms into a page, presses ArrowDown in
  the page title, and verifies focus moves to the first visible child.
- The interaction test verifies a changed title draft is saved before focus
  moves.

After the focused tests pass, run the complete frontend test set, lint, and the
production build. In the running desktop app, compare resting and editing
states for the page title, page note, row title, and row note, and verify
ArrowDown from the zoomed page title focuses its first child without visible
text movement.

## Risks and Mitigations

- **Platform-specific font rasterization:** Scope the correction to Notes'
  native editing surfaces and manually verify the target WebKit desktop app.
- **Auto-grow or wrapping regression:** Use a transform rather than box-model
  changes and retain the existing textarea measurement logic.
- **Draft loss during navigation:** Reuse the current page-title save path
  before calling `focusNode`, and cover the ordering with an interaction test.
- **Keyboard behavior divergence:** Continue using `resolveOutlineKey` as the
  sole source of navigation decisions.

## Out of Scope

- Replacing the token-overlay editing architecture.
- Redesigning Notes typography, row spacing, or selection behavior.
- Changing structural shortcuts such as indent, outdent, or row creation.
- Changing menu-trigger visibility or hover ownership.

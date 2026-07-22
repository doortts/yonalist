# Notes Slash Today and Spellcheck Design

## Goal

Provide a Codex-style slash command menu in Notes bullet titles and prevent
macOS spellcheck and autocorrection UI from appearing while editing Notes.

## User Contract

### Slash command menu

- Typing `/` at UTF-16 offset zero in an editable, text-based bullet title
  opens a command menu anchored to that title field.
- The same behavior is available in the zoomed page title for a text bullet.
- Supporting-note fields and image-atom titles do not open the slash menu.
- The first release contains one command:
  - Label: `Today`
  - Description: `Insert today's date`
  - Result: replace the slash query with the local date in `YYYY-MM-DD` format.
- Typing after `/` filters commands by a case-insensitive prefix, so `/tod`
  keeps `Today` visible and an unmatched query hides the menu.
- The command range begins at offset zero and ends at the collapsed caret.
  Existing text after the caret is preserved.
- Arrow Up and Arrow Down move the active option, Enter executes it, Escape
  closes the menu, and pointer selection executes it.
- The menu closes on blur, IME composition, an invalid query, or when the
  controlled value no longer matches the active query.
- Command insertion travels through the existing controlled `onChange` draft
  path. It does not write directly to SQLite and remains part of normal Notes
  save and Undo history behavior.

### Spellcheck and autocorrection

- All `NoteTextField` textareas set `spellCheck={false}`, `autoCorrect="off"`,
  and `autoCapitalize="off"`.
- The image-atom `contentEditable` host applies the same attributes.
- This change is limited to Notes. GitHub comments and other application text
  inputs keep their current platform behavior.

## Architecture

### Pure command model

`notesSlashCommands.ts` owns the command registry, query recognition, and the
pure replacement result. It reuses `formatLocalDateIso` for local dates. The
model has no React or persistence dependency.

### Menu view

`NotesSlashCommandMenu.tsx` renders a portalled listbox near the active
textarea. It follows existing Notes menu tokens for border, surface, shadow,
highlight, and compact typography. Placement is fixed, viewport-clamped, and
recomputed on resize and scroll.

### Input integration

`NoteTextField` owns transient menu state because both outline rows and zoomed
page titles already share it. A new opt-in `slashCommands` prop ensures only
title fields enable the menu. Selecting a command uses the established native
textarea setter plus bubbling `input` event, then restores focus and the caret
after the inserted date.

`OutlineNodeRow` and `NotesPageHeader` opt their text title fields into slash
commands. Their note fields remain unchanged.

## Accessibility

- The menu uses `role="listbox"`; commands use `role="option"`.
- The active option is exposed through `aria-activedescendant` on the title
  textarea while the menu is open.
- The menu has an accessible label, and the selected option is announced.
- Pointer down on a command preserves textarea focus until commit.

## Error and Edge Handling

- The menu never opens for read-only or disabled fields.
- IME composition cannot open or execute a command.
- Modifier Enter and unrelated shortcuts continue through existing handlers.
- An unavailable or invalid `today` value leaves slash commands disabled.
- The last known valid query is never committed after the caret or value moves.

## Verification

- Pure tests cover query recognition, filtering, date replacement, suffix
  preservation, and invalid ranges.
- `NoteTextField` tests cover menu opening, keyboard and pointer execution,
  dismissal, controlled input dispatch, caret restoration, and opt-in scope.
- Workspace tests prove both an outline row and zoomed page title persist the
  inserted date through the existing draft path.
- DOM tests prove spellcheck and autocorrection attributes on textareas and
  image-atom contenteditable hosts.
- A freshly reloaded Tauri app verifies the menu appearance, keyboard flow,
  date insertion, and absence of the macOS correction popup.

## Non-goals

- Additional slash commands
- User-defined commands
- A general plugin command framework
- Slash commands inside supporting notes or image-atom text
- Changes to date picker formats or Notes persistence schema

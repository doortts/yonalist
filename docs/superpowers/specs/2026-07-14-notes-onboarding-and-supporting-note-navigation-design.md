# Notes onboarding and supporting-note navigation design

**Date:** 2026-07-14  
**Status:** Approved

## Goal

Make the Notes workspace useful on first open, remove raw `[object Object]` error output, and make supporting-note editing easy to leave without a mouse.

The first-use guidance must be ordinary Notes data. A user can keep, edit, move, or delete it, and deleting it must not cause it to reappear.

## Scope

This change includes:

- one-time creation of an editable onboarding note in a genuinely empty Notes database;
- normalization of structured Notes initialization failures before they reach the UI;
- one-row supporting-note inputs that continue to grow with their content;
- keyboard exits from supporting-note inputs with `Escape`, boundary `ArrowUp`, and boundary `ArrowDown`;
- automated coverage for the persistence, error, and keyboard behavior.

It does not add a modal tour, a permanent empty-state card, new shortcut commands, or a way to restore the onboarding note independently of resetting the Notes database.

## Architecture

### One-time onboarding seed

The Rust Notes repository owns onboarding creation because it already owns database initialization and can make the decision atomically for every window and vault.

Initialization uses the existing `notes_preferences` table with the key `notes.onboarding.v1` as a durable completion marker. After the schema and compatibility helpers have run, and within the same initialization transaction, the repository applies these rules:

1. If the marker exists, do nothing.
2. If the marker is absent, count every row in `notes_nodes`, including archived, completed, and deleted rows.
3. If the count is zero, insert the onboarding root and its child nodes as ordinary Notes nodes.
4. If the count is nonzero, do not inject onboarding content into the existing workspace.
5. In either marker-absent case, write the completion marker before committing the transaction.

The node inserts and marker write succeed or fail together. Counting deleted rows prevents a user who previously removed all visible notes from being mistaken for a first-time user after an upgrade. Deleting the onboarding note later leaves the marker intact, so the note does not return. Removing the entire Notes database removes both content and marker, intentionally restoring first-use behavior.

The initial insert is bootstrap data rather than a user command, so it does not create an undo-history entry. Once created, the note participates in normal editing, movement, completion, archive, trash, restore, and export behavior.

### Onboarding content

Create one root note:

- Title: `Yonalist Notes 시작하기`
- Supporting note: `이 노트는 자유롭게 수정하거나 삭제할 수 있어요.`

Create these child notes in order:

1. `Enter — 새 항목 만들기`
2. `Tab / Shift+Tab — 들여쓰기 / 내어쓰기`
3. `Shift+Enter — 설명 입력하기`
4. `⌘/Ctrl+Enter — 완료 표시`
5. `↑/↓ — 항목 사이 이동`
6. `불릿을 드래그해 순서와 계층 바꾸기`

These lines describe shortcuts already supported by the outliner; this feature does not change those commands.

## Supporting-note keyboard behavior

Both the page-level supporting note and supporting notes on outline rows use the same resolution rules. The decision logic lives in a small pure helper so boundary and selection behavior can be tested without rendering the full workspace.

All supporting-note textareas start with `rows=1`. The existing auto-grow behavior remains responsible for increasing and reducing their rendered height as content changes.

For unmodified keys:

- `Escape` commits the current DOM value and focuses the title of the current note.
- `ArrowUp` focuses the current note title when the selection starts at offset `0`.
- `ArrowDown` focuses the next visible note title when the selection ends at the current value length.
- If no next visible note exists, boundary `ArrowDown` focuses the current note title so the user can still leave the field.
- Arrow keys away from those boundaries retain native textarea navigation.
- `ArrowLeft`, `ArrowRight`, and `Enter` retain native textarea editing behavior.

The boundary checks deliberately work when text is selected:

- a selection touching the start boundary qualifies for `ArrowUp`;
- a selection touching the end boundary qualifies for `ArrowDown`.

They also work during Korean IME composition. The navigation path commits the textarea's current DOM value before transferring focus so composed or selected text is not discarded. `Shift`, `Alt`, `Control`, or `Meta` arrow chords remain native and are not treated as exit commands.

For the page-level supporting note, the next visible target is the first visible outline row; if there is none, the page title is used. For an outline row, it is the following row in current visible outline order. Collapsed and filtered-out descendants are not navigation targets.

## Initialization error handling

`notes_initialize` can reject with a structured Tauri error object. The service boundary must handle initialization like the other Notes store calls: catch the rejection, parse its typed error code and message, and throw a normal `Error` carrying a human-readable message.

Malformed or unrecognized rejection values use the existing stable load-error fallback. UI coordination must never derive user-facing text by applying `String(...)` to an arbitrary object. Successful initialization clears the error state as usual; failed initialization may still be shown, but never as `[object Object]`.

## Data flow

1. Opening Notes invokes database initialization.
2. The repository ensures the schema, evaluates the onboarding marker and full node count, optionally inserts the help tree, writes the marker, and commits.
3. The workspace load that follows receives the onboarding nodes through the ordinary Notes load path.
4. The library and outline render the help note exactly like user-created content.
5. Supporting-note keydown events are resolved into either native editing or an explicit focus target.
6. Explicit exits commit the live textarea value, then move focus through the existing title-focus path.
7. Initialization failures are normalized at the service boundary before the coordinator stores a display message.

## Failure behavior

- A failed seed transaction leaves neither partial help nodes nor a completion marker; the next successful initialization may retry.
- A database containing any historical node is treated as existing user data and is never modified by onboarding seeding.
- A missing next focus target falls back to the current title rather than trapping focus in the supporting note.
- A malformed initialization rejection produces a stable load failure message rather than raw object coercion.

## Testing

### Rust repository tests

- A new empty database gets exactly one onboarding root with the six ordered children and the completion marker.
- Reinitializing the same database does not duplicate onboarding data.
- A marker-less database that already contains a node receives only the marker, not onboarding content.
- Trashing or deleting the onboarding tree and reinitializing does not recreate it.
- A seed failure rolls back nodes and marker together where the repository test harness can induce the failure.

### TypeScript service tests

- A structured `notes_initialize` rejection becomes a normal Notes load error with its message preserved.
- Unknown rejection shapes use the stable fallback and never contain `[object Object]`.

### Keyboard unit and component tests

- `rows=1` is used for both supporting-note entry points while auto-grow remains active.
- `Escape` commits and focuses the current title.
- Boundary `ArrowUp` focuses the current title.
- Boundary `ArrowDown` focuses the next visible title, with current-title fallback at the end.
- Mid-text arrows retain native behavior.
- Start- and end-touching selections activate boundary navigation.
- Korean composition does not disable boundary navigation, and the live value is preserved.
- Modifier-arrow chords retain native behavior.
- Page-level and outline-row supporting notes share the behavior.

### Manual verification

Run the Notes-focused frontend and Rust tests, then open a fresh Notes database in the desktop app. Confirm the help tree appears once, can be edited and deleted, does not return after restart, and all supporting-note exit keys move focus without losing text. Also force or mock an initialization error and confirm no pane displays `[object Object]`.

## Acceptance criteria

- A genuinely new Notes database opens with the editable Korean help note.
- Existing or previously used databases do not receive unsolicited help content.
- Deleting the help note is permanent for that database.
- No Notes initialization failure renders `[object Object]`.
- Supporting-note fields begin at one line and auto-grow.
- `Escape` and boundary vertical arrows leave supporting notes according to the approved rules, including during Korean composition and when a selection touches a boundary.

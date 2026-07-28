# Notes Workflowy-Style Bullet Performance Design

## Status

Approved in conversation on 2026-07-28. This design replaces the existing
bullet-title performance paths on a new branch based on the freshly fetched
`gi/main` commit `502af65cacb699ca5a48d2cbfdcf7b4caad3fdf0`.

## Contract

| Field | Decision |
| --- | --- |
| Goal | Make ordinary bullet editing stay responsive while Enter, Backspace, or an arrow key is held, using the rendering and input techniques verified in Workflowy's live page and bundle. |
| Acceptance | On the 5,001-node benchmark Vault, every native repeat is handled in order; held Enter, Backspace, and arrow runs have no frame over 34 ms and frame p95 at or below 28 ms; the rendered ordinary-row count is bounded by the prefix rule; no focus loss, scroll reversal, text loss, duplicate row, or missing Undo step occurs. |
| Preserved behavior | Korean IME, UTF-16 selections, markdown source/rendered presentation, tags, dates, slash commands, paste, multi-selection, split panes, drag and drop, attachments, one-step held-Backspace Undo, retry, authority recovery, and strict drain before close or Vault switch. |
| Non-goals | A new editor dependency, React Compiler, a two-sided variable-height virtualizer, a floating pane-wide title editor, SQLite/schema/IPC changes, or conversion of page titles, supporting notes, image atoms, plugin rows, archive rows, trash rows, or read-only rows. |
| Boundaries | Ordinary text-bullet title DOM, local presentation state, outline row rendering, keyboard focus, scroll ownership, existing draft/history/coordinator APIs, and frontend benchmark instrumentation. |
| Manual proof | A fresh Tauri process on the 5,001-node benchmark Vault, both split panes, real held keys near the lower viewport edge, Korean IME, rapid scrolling, Undo/Redo, drag, failure recovery, Vault switch, and normal close. |

The clean starting baseline is 186 passing test files and 4,289 passing tests
with 27 skipped tests.

## Evidence

The live Workflowy page and public bundle showed:

- an 801-bullet page initially mounted 29 task rows rather than the whole
  document;
- the rendered set was a leading prefix plus one estimated-height tail
  spacer, with no top spacer;
- each mounted title used one row-local `contenteditable`, not a presentation
  layer plus a hidden textarea;
- native Enter repeats were not rejected;
- ordinary typing stayed in the DOM and a trailing 500 ms timer read and
  diffed the editor;
- keyboard structural edits did not run FLIP motion or per-row geometry
  observers.

At the same scale, the Yonalist baseline mounted all 800 rows, about 17,046
DOM elements, and 21 elements per row. The current ordinary row mounts its
sortable runtime, rich presentation, hidden textarea, auto-grow observer, and
focus machinery even while resting. Existing optimizations reduce some React
work but do not bound DOM or layout cost.

Workflowy's bundle uses this prefix shape:

```ts
roundedScroll = 48 * Math.ceil(scrollTop / 48)
limit =
  viewportRows +
  24 * Math.ceil(roundedScroll / (minimumRowHeight * 24))
tailHeight = (totalRows - limit) * minimumRowHeight
```

Yonalist uses a 28 px minimum ordinary-row height. Its viewport term is rounded
up so the first screen cannot expose an empty strip.

## Approaches

### 1. Prefix rendering only

Keep the textarea and current optimistic/focus systems, but mount only the
leading row prefix. This is the smallest change and would reduce initial DOM.
It leaves the duplicated title DOM, per-key React draft publication, custom
Backspace repeat loop, and current Enter settlement machinery in place. It
does not satisfy the request to replace the existing performance techniques.

### 2. Row-local single-surface editor plus prefix rendering

Replace each rendered ordinary title with one row-local DOM root that switches
between rich resting presentation and `contenteditable="plaintext-only"`
editing. Keep live typing in the DOM, publish it on a trailing timer, apply
keyboard structure locally before persistence, and bound mounted rows with
the Workflowy prefix rule. This is the accepted approach.

### 3. Pane-wide editor or two-sided virtualization

A floating pane-wide editor needs geometry overlays and editing-lease
transfers. A previous local experiment using that shape showed intermittent
text loss during focus transfer. Two-sided virtualization additionally needs
top-spacer anchoring, off-screen drag geometry, and variable-height indexing.
Both add risk without evidence that the accepted approach is insufficient.

## Accepted Architecture

### 1. Remove the old hot-path performance systems

The new path removes these ordinary-bullet mechanisms and their
implementation-detail tests:

- `flushSync` keyboard insertion preparation;
- pane/layout/drag signature checks used only to settle provisional Enter
  rows;
- the custom 400/50 ms held-Backspace repeat timer;
- the hidden per-row title textarea and its auto-grow observation;
- the list observer that observes every rendered child;
- keyboard insertion/removal FLIP capture and idle-baseline scheduling;
- frame-delayed direct-caret reconciliation;
- inactive-pane deferred presentation;
- full-list row identity retention and memo bridges that become unnecessary
  once the mounted prefix is small.

Files or symbols that become unused are deleted rather than left behind.
Specialized editors keep their existing `NoteTextField` or contenteditable
paths.

The following are data-safety contracts, not rendering optimizations, and
remain:

- write serialization and per-node revision checks;
- structural ordering against the exact source title;
- history reservation and one-gesture Undo;
- failed-write retry and unknown-outcome recovery;
- strict draft/write drain before close or Vault switch;
- cross-pane serialization for one Vault.

### 2. Use one row-local title surface

Each mounted ordinary text row owns one stable title root. It has two modes:

1. **Resting:** `contentEditable=false`; the existing `NoteTokenText`
   presentation supplies markdown, tag, date, and link behavior.
2. **Editing:** the same root becomes
   `contenteditable="plaintext-only"` and contains raw source text. React does
   not own or reconcile the root's children while it is editing.

Pointer activation reuses the existing rendered-to-source caret mapping.
Keyboard activation places the caret at the requested UTF-16 offset. On blur,
the editor reads normalized text before it changes back to resting mode.

The editing root exposes `role="textbox"`, `aria-multiline="false"`, the
existing accessible name, readonly/disabled state, spellcheck settings, and
current selection semantics. Resting token controls retain their current
keyboard and accessible behavior.

DOM extraction normalizes NBSP and Unicode line separators without changing
UTF-16 length, treats an internal `<br>` as one newline, and drops WebKit's
empty trailing `<br>`. Paste inserts plain source text. IME composition owns
the DOM until `compositionend`; timers and structural commands do not read or
replace composing children.

### 3. Keep ordinary typing out of React's key path

An ordinary `input` event only marks the editor dirty and restarts one trailing
500 ms timer. It does not call `setState`, publish a draft slice, resize a
textarea, or reconcile outline rows.

The timer reads the current DOM source and passes it to the existing draft
engine. The current write queue may persist it later; the UI never waits for
that work.

These boundaries flush the live editor immediately:

- Enter, structural Backspace, Tab, keyboard move, and Undo/Redo;
- Arrow focus transfer to another row;
- blur, pane transfer, zoom, page navigation, and editor unmount;
- retry/drain, normal close, and Vault switch.

Each pane exposes its live-title flush through the existing pane registry.
`flushAllDrafts()` calls pane flushers before draining the draft engine and
write queue. A focus transfer flushes the source pane before the editing lease
moves, so a later pane cannot reject the source write.

Slash, date, and inline-format commands may update React because they are
explicit commands rather than the ordinary typing path.

### 4. Apply keyboard structure locally, then persist

Plain Enter reads the live source and selection, resolves the existing split
semantics, and applies the existing pure workspace mutation to the in-memory
workspace immediately. The next row is therefore available in the same
discrete React update without `flushSync`.

The queued repository mutation keeps the same command ID and reserved history
entry. The history entry is also the rollback source; there is no second
optimistic checkpoint, visible-row JSON signature, or layout-generation
registry.

On success:

- an equivalent authoritative delta only marks the command settled;
- a normalized or otherwise different delta is applied normally.

On failure:

- if no later edit depends on the command, replay its inverse history entry
  and restore the exact source selection;
- if later edits depend on it or the outcome is unknown, enter the existing
  authority-recovery path instead of silently discarding later input.

Eligible empty-row Backspace uses the same local-first rule. The existing
Backspace gesture/history transaction stays open from the first keydown until
keyup, blur, hidden state, or drain. Native keydown events, not a local timer,
drive every deletion.

### 5. Let native key repeat drive the editor

Plain Enter, eligible Backspace, and unmodified arrow keys do not reject
`event.repeat`.

- Enter commits one local split per delivered keydown and focuses the inserted
  row after the bounded React commit.
- Backspace focuses the next logical owner before removing the empty row, so
  later native repeats target the connected editor.
- Arrow keys use the full logical row order. If the target is not mounted,
  the prefix grows to include it before focus is applied.

One-shot shortcuts such as Undo, completion, duplicate, explicit move,
delete-with-confirmation, and Tab repeat retain their current guards.

The Workflowy macOS rule that suppresses one Enter shortly after a delayed
`insertText` event is not added speculatively. Add it only if the same IME
fault is reproduced in WKWebView.

### 6. Render a leading prefix and one tail spacer

The complete flattened order remains the source for navigation, selection,
history, drag projection, filters, and persistence. Only ordinary DOM rows
are sliced.

For each pane:

```ts
const minimumRowHeight = 28;
const chunkSize = 24;
const roundedScroll = 48 * Math.ceil(scrollTop / 48);
const requestedLimit =
  Math.ceil(viewportHeight / minimumRowHeight) +
  chunkSize *
    Math.ceil(roundedScroll / (minimumRowHeight * chunkSize));
const limit = Math.min(
  totalRows,
  Math.max(requestedLimit, targetExpandedLimit),
);
```

`targetExpandedLimit` is `0` when no target is pending. Otherwise it is one
past the pending focus or drag target, so it never caps the scroll-derived
limit.

The outline renders `rows.slice(0, limit)` followed by one inert tail spacer:

```ts
tailHeight = (totalRows - limit) * minimumRowHeight;
```

There is no top spacer and no row is removed above the viewport. Actual
heights of mounted wrapped titles, notes, progress, and attachments remain in
normal document flow. Replacing a 28 px tail estimate with actual content
only changes space below the current anchor. No height tree or per-row
measurement cache is introduced unless device evidence shows an anchor jump
that this shape cannot fix.

The limit may shrink when the user scrolls back up, pruning only rows below
the current viewport. It resets on page, zoom, or Vault change.

Each split pane owns its scroll measurement and prefix state. If the current
layout shares a vertical scroll host, the implementation gives each outline
pane its own host before applying the formula.

### 7. Keep interaction logic complete while DOM stays bounded

- Selection membership uses the full logical order; mounted rows render the
  correct selected state.
- `SortableContext` contains mounted IDs only. Pointer drag can target mounted
  rows, and downward autoscroll grows the prefix before collision detection.
- The drag source and current target force the prefix to remain large enough
  for the gesture. No synthetic off-screen rectangles are added.
- Quick jump and zoom keep their current logical behavior. A target row grows
  the prefix before focus; navigation to another page resets it.
- The GitHub Notifications projection remains one composite block. Its
  internal renderer is not rewritten by this work.
- Keyboard structural edits have no layout motion. Pointer drag, explicit
  move commands, and Undo/Redo may retain their existing visible motion.

## Data Flow

### Ordinary typing

```text
native input
  -> DOM remains authoritative for the focused title
  -> restart the 500 ms timer
  -> timer/blur/drain reads normalized source
  -> existing draft engine
  -> existing serialized write queue
  -> repository
```

### Enter

```text
native keydown
  -> read DOM source and UTF-16 selection
  -> resolve split
  -> close the source text burst
  -> reserve structural history
  -> apply local workspace mutation
  -> bounded prefix React commit
  -> focus the inserted row with preventScroll
  -> enqueue the existing repository command
  -> absorb an equivalent result or reconcile a differing result
```

### Backspace

```text
first native keydown
  -> begin one Backspace history gesture
each native repeat
  -> edit DOM text or remove one eligible empty row locally
  -> move focus to the next logical editor
keyup/blur/hidden/drain
  -> close and persist one gesture batch
```

## Error Handling

- A draft timer failure stays dirty and uses the existing write-error banner
  and retry path.
- A definite structural failure rolls back only when that rollback cannot
  erase later edits.
- An unknown or interleaved result uses authority recovery.
- A failed drain keeps the window open or keeps the current Vault active.
- A missing pending focus target increases the prefix once and retries after
  commit; it never spins or falls back to focusing an unrelated row.
- Invalid or unsupported DOM selection falls back to the end of the current
  source, matching the existing textarea behavior.

## Verification

### Focused checks

1. Prefix calculation and spacer height at top, middle, bottom, scroll-up, and
   forced-target expansion.
2. One title root across rest/edit transitions; no textarea for an ordinary
   title; exact UTF-16 caret mapping; normalized paste and DOM extraction.
3. Korean composition does not publish, split, or normalize mid-composition.
4. Ordinary input causes no outline render before the trailing timer.
5. Held Enter handles every native repeat and preserves source/suffix order.
6. Held Backspace crosses text and empty rows, stops on keyup, and restores
   the exact fixture with one Undo.
7. Held arrows cross a prefix boundary with no missed focus or scroll reversal.
8. Split-pane focus transfer flushes the source before moving the editing
   lease.
9. Drag autoscroll grows the prefix and preserves the current drop result.
10. Matching persistence settlement adds no pane render; mismatches and
    failures reconcile safely.
11. Drain flushes a live dirty contenteditable before close or Vault switch.
12. Resting markdown, tag, date, slash, readonly, attachment, and
    accessibility behavior remains intact.

### Device gate

Run the existing fresh Tauri benchmark on the isolated 5,001-node Vault with
real key events:

| Gate | Required result |
| --- | --- |
| Initial mounted ordinary rows | Determined by viewport formula, independent of document size |
| Held Enter | Every event represented once; no duplicate or missing row |
| Held Backspace | Every eligible repeat represented once; stops at keyup |
| Held arrows | Every repeat represented once; final focus ID exact |
| Frame p95 | At most 28 ms for each held workload |
| Frames over 34 ms | Zero |
| Scroll | No reversal, blank strip, or visible anchor jump |
| Text/IME | No lost, duplicated, or half-composed text |
| Undo | Exact fixture restoration |
| Drain | No pending live DOM title or queued write after success |

The 100/300/800 parity harness remains a comparison instrument, not an
absolute cross-browser gate. Workflowy runs in Chrome while Yonalist ships in
WKWebView.

### Final gates

The production boundary is frontend-only:

```bash
npm test
npm run test:architecture
npm run lint
npm run build
git diff --check
```

Rust, IPC, schemas, persistence payloads, and native configuration are not
changed, so Cargo tests, Rust formatting, and Clippy are skipped.

## Delivery Order

1. Freeze the benchmark and add the missing scroll-anchor assertion.
2. Add the pure prefix calculation and tail spacer.
3. Replace the ordinary title's dual DOM with the row-local single surface.
4. Move ordinary typing to DOM-first trailing publication and wire drain.
5. Replace specialized optimistic Enter and custom Backspace repeat with
   local-first mutations driven by native key events.
6. Delete the superseded observers, motion scheduling, focus reconciliation,
   inactive-pane deferral, memo bridges, and dead tests.
7. Run focused checks after each slice, then one final gate and fresh desktop
   benchmark after the diff is frozen.

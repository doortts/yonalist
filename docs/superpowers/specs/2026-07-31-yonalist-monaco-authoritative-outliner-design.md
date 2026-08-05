# Yonalist Monaco-Authoritative Outliner Design

**Date:** 2026-07-31

**Status:** Approved design; implementation plan pending

## Summary

The experimental Monaco outline will become a genuine Monaco-authoritative
editing surface instead of a projection over `NotesStore`.

One Monaco text model represents the editable text of an active outline page.
The model owns typing, Korean IME composition, Enter, Backspace, cursor
movement, selection, and text Undo/Redo. Yonalist adds only the tree semantics
that Monaco does not know: stable node identity, depth, parent relationships,
zoom, persistence, and bullet interactions.

The implementation will be an internal Yonalist Monaco contribution. It will
use Monaco's existing editor model, edit stack, cursor machinery, viewport,
selection, find, clipboard, and rendering path as far as possible. Monaco
internal APIs needed for injected-text cursor affinity, injected-text mouse
targets, hidden ranges, and resource Undo elements will be isolated in one
version-pinned adapter.

This design supersedes the edit-authority and Undo decisions in
`2026-07-30-yonalist-v2-monaco-outline-spike-design.md`. The existing React
outline remains the default control surface while the new architecture is
implemented behind `?outline=monaco`.

## Why the Spike Must Change

The current experiment is visually one Monaco editor per pane, but Monaco is
not the editing authority:

1. Monaco emits or receives an editing intent.
2. the adapter mutates `NotesStore`;
3. the complete visible outline is projected back into Monaco;
4. the adapter manually restores the caret.

That loop separates text, cursor, structure, and Undo into different
authorities. Middle-of-text Enter demonstrates the failure: the store split is
correct, but the recreated projection and a generic `cursorRight` correction
can move the caret into the suffix. Repeated Enter, Backspace, and vertical
movement amplify the same race.

Basic Monaco does not exhibit this class of problem because the model edit,
cursor transform, composition state, and undo element are committed as one
editor operation. The new design preserves that ownership rather than
reimplementing it around Monaco.

## Goals

- Make one Monaco `ITextModel` the authoritative in-memory editing buffer for
  the active page.
- Preserve Monaco-native typing, IME, Enter, Backspace, cursor movement,
  selection, clipboard, find, viewport rendering, and text Undo/Redo.
- Keep node identity and tree metadata synchronized with model lines without
  rebuilding the model after every edit.
- Share one canonical model between primary and secondary pane editor views.
- Support normal bullet click to zoom in the same pane and Shift+click to open
  that bullet in the secondary pane.
- Persist edits asynchronously to SQLite without putting IPC latency on the
  input path.
- Keep the current Yonalist visual design and the non-Monaco React outline
  unchanged during the experiment.
- Establish a narrow internal plugin boundary that can survive a deliberate
  Monaco upgrade.

## First Delivery Scope

The first production-shaped vertical slice includes:

- a Monaco-authoritative text model;
- native typing and Korean IME;
- native Enter, Backspace, arrow keys, Home, End, Page Up, and Page Down;
- Monaco-owned Undo/Redo;
- asynchronous SQLite persistence;
- shared-model split view;
- bullet click zoom and Shift+click split navigation;
- Tab indent and Shift+Tab outdent;
- repeated Enter and Backspace behavior;
- deterministic save, retry, conflict, and close-flush behavior;
- a 5,000-node performance fixture and comparison against the React v2 core.

The first slice does not include image editing, image resizing, Yonalist
multi-bullet selection actions, drag and drop, or cross-pane drag and drop.
The metadata and contribution boundaries must allow those features to be
added later without replacing the model authority again.

Native Monaco multi-cursor text edits are supported by interpreting all model
content changes in a batch. Product-level multi-bullet selection and its tree
commands remain a later feature.

## Non-goals

- Do not fork all of Monaco in the first implementation.
- Do not edit files under `node_modules`.
- Do not represent bullets or indentation as user-editable prefix characters.
- Do not keep `NotesStore` as a second editable text authority.
- Do not maintain duplicate Monaco and Rust Undo histories for the same edit.
- Do not add a new design, theme, layout, or typography.
- Do not remove the existing React outline before feature and performance
  acceptance.
- Do not add image nodes, attachment compatibility, Vault sync, or GitHub
  notifications as part of this slice.

## Core Invariants

1. The Monaco model contains only user text and newline separators.
2. One current model line maps to exactly one outline node.
3. A line's node ID is independent of its current line number.
4. Bullets and depth indentation are rendered, not stored as model text.
5. Native text edits are never reverted merely to wait for persistence.
6. A store or SQLite acknowledgement never echoes an entire model replacement
   back into the active editor.
7. Both panes showing a page share the same model and metadata session.
8. Selection, scroll, focus, zoom, and hidden ranges remain pane-local.
9. Monaco is the session Undo/Redo authority for both text and structural
   operations represented in the editor session.
10. Session history is cleared at restart; Rust does not create a duplicate
    history entry for Monaco-owned edits.
11. Every internal Monaco dependency is contained by the internal adapter and
    protected by characterization tests.

## Architecture

### Module layout

The new frontend boundary is:

```text
apps/desktop/src/monaco-outline/
├── plugin.ts
├── internalAdapter.ts
├── sessionRegistry.ts
├── session.ts
├── metadata.ts
├── decorations.ts
├── structuralChanges.ts
├── persistenceQueue.ts
├── paneAdapter.ts
└── tests/
```

`MonacoOutlineSurface.tsx` becomes a thin React host. It mounts an editor,
acquires a page session, creates a pane adapter, and releases both on unmount.
It does not project every `NoteView` into a new model value and does not own
structural keyboard behavior.

### `plugin.ts`

The plugin registers the Yonalist Monaco contribution once per application
runtime. It owns:

- contribution attachment and disposal;
- Yonalist context keys;
- Tab and Shift+Tab tree commands;
- bullet mouse interaction;
- the minimal command interception needed for injected-text cursor affinity;
- delegation to the session and pane adapter.

The plugin must not duplicate Monaco's ordinary typing, Enter, Backspace,
arrow, selection, clipboard, find, or composition implementations.

### `internalAdapter.ts`

This is the only module allowed to import Monaco internal ESM modules. It
provides a small typed facade for:

- editor command registration and command priority;
- `MoveOperations` and cursor state affinity;
- `PositionAffinity.LeftOfInjectedText` and
  `PositionAffinity.RightOfInjectedText`;
- injected-text mouse target details;
- editor-specific hidden areas;
- resource Undo/Redo elements for metadata-only commands;
- feature probes used by startup characterization.

The dependency is pinned to Monaco 0.53.x initially. A Monaco upgrade is a
deliberate task: update the pin, compile the adapter, run its characterization
suite, then run editor behavior and performance tests.

Public Monaco APIs remain preferred. If an essential behavior cannot be
expressed through the internal adapter, the fallback order is:

1. add a narrowly scoped internal contribution hook;
2. maintain a small documented vendor patch applied during installation;
3. fork Monaco only if the patch cannot be kept isolated or tested.

### `sessionRegistry.ts`

The registry owns page-scoped `MonacoOutlineSession` instances and reference
counts. Both panes acquire the same session when they display the same active
page. A session is disposed only after its final pane is released and its
persistence queue has reached a terminal close state.

The registry prevents duplicate models for one page and prevents an editor
unmount from discarding another pane's active session.

### `session.ts`

The session owns:

- the canonical `ITextModel`;
- current line-to-node metadata;
- metadata snapshots associated with Monaco model versions;
- editor attachment bookkeeping;
- the persistence queue;
- Unsaved, Saving, Conflict, Read-only, and Closed states;
- initial hydration and final flush;
- reconciliation of accepted external changes that do not originate from the
  active session.

Initial hydration is the only normal whole-model set. After hydration, local
edits are incremental Monaco model operations and metadata transitions.

The session does not synchronously publish every keystroke back into a React
store. React may subscribe to coarse session status and navigation state,
while the editor paints directly from the Monaco model.

### `metadata.ts`

Metadata maps each current line to:

```ts
interface OutlineLineMetadata {
  readonly nodeId: string;
  readonly parentId: string;
  readonly depth: number;
  readonly kind: "text";
  readonly collapsed: boolean;
}
```

The implementation maintains:

- ordered current-line metadata;
- node ID lookup;
- parent/depth validation;
- snapshots keyed by Monaco alternative version identity;
- metadata diffs used by persistence;
- stable IDs allocated synchronously for inserted lines.

The snapshot associated with a Monaco alternative version restores the same
node IDs during Undo/Redo. A redo does not allocate replacement IDs.

### `decorations.ts`

Bullets, indentation, collapsed state, and later non-text node affordances are
rendered through injected text and decorations. They are not part of the text
model and therefore do not pollute:

- clipboard contents;
- Find results;
- selections;
- IME ranges;
- persisted titles;
- Monaco word and cursor logic.

Decoration calculation is incremental for affected lines. It must not replace
decorations for an unchanged 5,000-line page after each keystroke.

### `structuralChanges.ts`

This module interprets Monaco-native model changes as outline structure:

- inserting a newline splits a line and allocates a node ID for each inserted
  outline line;
- deleting a newline merges adjacent lines and removes the merged-away node
  from current metadata;
- replacing a multi-line selection removes, retains, or allocates identities
  deterministically;
- batched multi-cursor changes are normalized in descending source-range order
  and committed as one metadata transition;
- Tab and Shift+Tab validate and update depth/parent metadata;
- later line moves can be represented as native model edits plus an associated
  metadata transition.

Enter and Backspace are not cancelled and replayed as store commands. Monaco
performs its native model operation first. The synchronous model-change
listener applies the matching metadata transition in the same event cycle,
before persistence or React rendering.

When an invalid tree operation is requested, the structural contribution
rejects only that tree command. It does not roll back unrelated text input.

### `persistenceQueue.ts`

The queue converts model and metadata transitions into ordered application
commands. It provides:

- 300 ms coalescing for repeated title-only edits;
- immediate enqueue for structural edits, blur, navigation, and close;
- monotonically ordered request IDs and base revisions;
- idempotent retries;
- acknowledgement tracking without model echo;
- Undo/Redo persistence as forward or inverse domain changes;
- a bounded status stream for the UI;
- an explicit close flush outcome.

The SQLite application layer receives Monaco-session mutations with server-side
history recording disabled. Rust remains responsible for transaction
atomicity, validation, revisions, and durable storage, but not for duplicating
the Monaco session edit stack.

### `paneAdapter.ts`

Each mounted editor gets its own pane adapter. It owns:

- local selection and focus;
- scroll position;
- zoom root;
- hidden ranges for nodes outside that pane's zoomed subtree;
- bullet hit-testing;
- normal-click same-pane zoom;
- Shift+click opening or replacing the secondary pane.

Two pane adapters may point at one session model. A model edit is immediately
visible in both without a store round trip. Hidden ranges are editor-specific,
so one pane can be zoomed while the other displays a wider context.

If a zoom target's descendants are not in the current bounded session, the
session loads and inserts the missing range before the pane activates its new
hidden ranges. The pane never switches to an independently editable duplicate
of the same page.

## Monaco Contribution Strategy

### Pure-text model and injected bullets

The model's first content column remains column 1. The visible bullet and
indentation occupy injected rendering space before that content. Cursor state
must use Monaco's injected-text affinity so an empty line caret renders beside
the bullet rather than before it.

The contribution adapts only the boundary cases where Monaco 0.53's default
vertical move chooses the wrong side of injected text. It delegates movement
calculation to Monaco `MoveOperations`, then selects the correct affinity. It
does not issue visible corrective `cursorRight` commands after a move or Enter.

### Bullet mouse target

Monaco's runtime mouse target exposes injected-text detail. The contribution
uses that detail to distinguish:

- clicking the bullet: zoom or split navigation;
- clicking title text: ordinary caret placement and selection;
- clicking whitespace: Monaco's normal editor behavior.

The hit target logic is characterized against the pinned Monaco version
because the detail is not part of the public TypeScript declaration.

### Hidden ranges

Zoom uses editor-specific hidden areas over the shared model. The session's
line metadata determines the contiguous visible subtree. The adapter updates
hidden ranges without editing model text or replacing the model.

### Undo integration

Text edits, line splits, line merges, and line moves use Monaco model edit
elements. Metadata snapshots are recorded for the corresponding alternative
version IDs. During native Undo/Redo, the session restores the matching
metadata snapshot before emitting persistence deltas.

Indent/outdent can change metadata without changing text. Those operations use
a resource Undo element pushed through the internal Undo/Redo service for the
same model URI. Its `undo` and `redo` callbacks apply inverse/forward metadata
transitions and enqueue the matching persistence operation. This keeps
metadata-only commands correctly ordered among native text edits.

## Edit and Persistence Flow

### Typing

```text
keydown / IME
  → Monaco native edit
  → model paints
  → affected line metadata remains stable
  → title delta enters coalescing queue
  → SQLite transaction
  → revision acknowledgement updates queue state only
```

There is no whole-page React projection between keydown and paint.

### Enter

```text
Monaco native newline edit
  → native caret transform
  → model-change batch identifies split lines
  → stable new node IDs allocated synchronously
  → metadata snapshot associated with model version
  → structural persistence command enqueued
```

At a middle split, the caret remains at column 1 before the first character of
the suffix. On an empty inserted line it renders immediately beside the
injected bullet.

### Backspace at line start

```text
Monaco native newline deletion
  → native caret lands at previous line end
  → metadata merges the two line identities deterministically
  → removed identity recorded in the transition
  → structural persistence command enqueued
```

Holding Backspace repeatedly follows Monaco's native repeat stream; it is not
serialized behind SQLite acknowledgements.

### Undo/Redo

```text
native Monaco Undo/Redo
  → model alternative version changes
  → matching metadata snapshot restored
  → diff from last desired durable state calculated
  → inverse/forward persistence command enqueued
  → panes repaint the shared model immediately
```

## Error and Recovery Semantics

### Retryable save failure

- Keep the model and metadata unchanged.
- Show Unsaved status.
- Retry with the same idempotent request identity and ordering.
- Continue accepting local edits while the bounded queue has capacity.

### Revision conflict

- Stop sending later queued commands.
- Keep the user's current model content and allow copy.
- Enter Conflict state with retry/reload actions.
- Do not replace the model with the server snapshot automatically.
- A later conflict-resolution feature may produce an explicit merge, but silent
  last-writer replacement is prohibited.

### Fatal persistence failure

- Preserve readable and selectable editor content.
- Block new structural edits that could make recovery ambiguous.
- Permit copying and export of the current text buffer.
- Surface the failure instead of reverting to an older store projection.

### Close flush failure

- Flush title and structural changes before closing the session.
- If flush fails, report failure and keep the app window open.
- Never report a successful close while pending edits remain unacknowledged.

### Plugin compatibility failure

At startup, the internal adapter probes required Monaco capabilities. If a
probe fails:

- disable the Monaco experiment for that runtime;
- retain the React outline control surface;
- log the exact missing capability;
- do not continue with partially working cursor or Undo behavior.

## React and Store Boundary

React owns the application shell, pane layout, navigation controls, and coarse
session status. It does not own per-keystroke title state for the active Monaco
session.

`NotesStore` may retain durable query snapshots used outside the active editor,
but it is updated from acknowledged session patches and cannot re-project an
older title over the model. The active session exposes read-only selectors
where surrounding UI needs current titles.

Leaving a page requires its queue to flush or to surface a recoverable failure.
Opening another page acquires the corresponding registry session.

## Visual Contract

The current Yonalist design remains the reference:

- same shell and pane layout;
- same content width;
- same font, size, weight, line height, and colors;
- same bullet geometry and depth spacing;
- same empty-line behavior with no placeholder text;
- no Monaco line numbers, minimap, overview ruler, code folding gutter,
  suggestions, bracket features, or code-oriented current-line chrome.

Only implementation ownership changes. No visual redesign is included.

## Performance Contract

Measure the React v2 core and Monaco experiment on the same build, fixture,
machine, and browser runtime.

For a 5,000-node page:

- input-to-paint p95 is at most 20 ms;
- repeated Enter and Backspace do not wait for SQLite acknowledgements;
- no whole-model `setValue` or whole-workspace reload occurs after local edits;
- unchanged-line metadata and decorations are not recomputed globally;
- no long task over 50 ms occurs in the sampled core interaction loop;
- secondary-pane reflection happens through the shared model in the same
  renderer turn;
- memory, load time, input latency, scroll frame rate, and lazy Monaco bundle
  cost are reported beside the React v2 sample.

The large Monaco lazy chunk remains an explicit product trade-off rather than
being hidden in the shell bundle.

## Testing

### Pure session and metadata tests

- hydrate a model and stable line metadata;
- split at start, middle, and end;
- merge at line start;
- replace multi-line selections;
- batch multi-cursor content changes;
- preserve IDs through Undo/Redo;
- validate indent/outdent parent and depth;
- generate minimal persistence deltas;
- handle retry, conflict, fatal failure, and close flush.

These tests use a real Monaco text model, not a hand-written string mock.

### Internal adapter characterization

- required internal imports resolve for pinned Monaco 0.53;
- injected-text left/right affinity maps to the expected view position;
- vertical movement on empty and non-empty lines stays beside the bullet;
- injected-text mouse targets expose the bullet detail;
- hidden areas remain editor-local with a shared model;
- metadata-only Undo elements interleave with model Undo elements.

### Browser behavior tests

- middle Enter leaves the caret before the first suffix character;
- a new empty line shows the caret beside its bullet before typing;
- holding Enter creates contiguous lines and keeps the caret on the latest line;
- holding Backspace merges lines in order without orphan empty rows;
- arrows, Home, End, Page Up, and Page Down behave like Monaco text editing;
- Korean IME composition has no projection reapply or duplicated text;
- native Undo/Redo restores text, caret, tree metadata, and node IDs;
- edits in one split pane appear immediately in the other;
- normal bullet click zooms the same pane;
- Shift+bullet click opens the secondary pane;
- the two panes retain independent selection, scroll, focus, and zoom;
- Find and clipboard contain title text without injected bullets.

### Runtime and persistence tests

- repeated input during delayed SQLite acknowledgement;
- idempotent retry after a transient failure;
- stale revision conflict without model overwrite;
- close flush success and failure;
- session reference counting across pane mount/unmount;
- reload restores the last acknowledged SQLite state and starts with empty
  session history.

### Visual regression

Compare loaded, empty-line, split, zoomed, focused, selection, Unsaved, and
error states against the current Yonalist reference. The experiment may not
introduce design changes to compensate for editor behavior.

## Acceptance Criteria

The first slice is accepted only when all of the following are true:

- The visible page is one Monaco editing model per active page, shared by panes.
- Monaco, not `NotesStore`, is the active text authority.
- Enter in the middle of text leaves the caret at the suffix start without a
  visible jump.
- Empty-line vertical movement never places the caret before the bullet.
- Held Enter and Backspace remain contiguous, responsive, and crash-free.
- Korean IME has no model replacement during composition.
- Undo/Redo restores text, node identity, depth, and caret consistently.
- Bullet click and Shift+click provide same-pane zoom and secondary-pane
  navigation.
- Save failures never silently replace current editor content.
- The 5,000-node input-to-paint sample satisfies p95 at most 20 ms.
- The adapter characterization suite detects incompatible Monaco internals.
- The React outline remains available as the control path.
- Existing design and layout remain visually unchanged.

## Delivery Sequence

The implementation plan will use one end-to-end vertical slice before broad
feature work:

1. establish the internal adapter and capability probes;
2. create one shared page session with a pure-text Monaco model;
3. implement middle Enter as a native model split with stable metadata;
4. persist the split to SQLite asynchronously;
5. restore the same text and node IDs through Undo/Redo;
6. attach a secondary pane to the same model;
7. implement bullet click zoom and Shift+click split navigation;
8. expand coverage to Backspace, repeat keys, IME, indent/outdent, failures,
   performance, and visual regression.

The previous store-authoritative Monaco caret fixes remain untouched until this
slice passes its tests. They may then be removed as obsolete code in a separate,
reviewable cleanup step.

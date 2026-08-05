# Yonalist v2 Performance Foundation Design

**Date:** 2026-07-29

**Status:** Approved

## Goal

Prepare the v2 Notes frontend for image nodes without changing the current
design. Reduce oversized coordinator files, prevent ordinary title and note
drafts from invalidating the complete app and outline, remove the instructional
preview bullet, and verify the existing split-pane and multi-selection
behaviors in a fresh runtime.

## Observable Contract

- Typing a title or supporting note updates the focused row immediately.
- An ordinary draft change does not publish a new shell or structural-outline
  snapshot and does not notify unrelated row subscribers.
- Debounced persistence, Korean IME, repeated Enter, repeated Backspace, and
  session Undo/Redo retain their current behavior.
- The preview never inserts a bullet whose text is
  `Press Enter to add another thought.`.
- An empty bullet renders as an empty editor with a caret and no instructional
  text.
- The current visual layout, CSS tokens, spacing, typography, colors, window
  chrome, and control placement do not change.
- Split opening, closing, resizing, independent focus, multi-bullet
  indent/outdent, multi-bullet reorder, and pointer drag into the other split
  pane remain available.
- Each accepted multi-node structural action reaches SQLite as one command and
  creates one session-history entry.

## Non-goals

- Image persistence, image import, asset storage, image rendering, and the
  image-atom editor belong to subsequent delivery slices.
- The slice does not add Vault synchronization, GitHub Notifications, v1 data
  compatibility, schema migration, or a new visual design.
- The slice does not replace textarea editing with `contenteditable`.
- The slice does not add list virtualization without measurement showing that
  the bounded viewport and row isolation are insufficient.
- Function and variable name abbreviation is not codebase dieting.

## Baseline Evidence

The active v2 frontend subscribes `App` to the complete `NotesState`.
`NotesState` contains the ordered nodes and both draft maps, so every
keystroke currently publishes a new top-level snapshot. `App` then recreates
the visible outline elements even when only one row's draft changed.

The initial architecture budget currently warns about:

- `apps/desktop/src/notesStore.ts` exceeding 500 lines;
- `apps/desktop/src/App.test.tsx` exceeding 800 lines; and
- `crates/notes-core/tests/tree_commands.rs` exceeding 800 lines.

The test-file warnings do not affect runtime performance, but the files will be
split by public behavior when their owning production boundary changes.

The signed-in Workflowy performance page was observed with 761 `.project`
elements, 763 editable elements, and approximately 9,600 DOM elements while
only 44 rows intersected the viewport. Workflowy therefore does not provide
evidence that an 800-row DOM must be virtualized. Its relevant transferable
choices are narrower update ownership, native browser key repetition, and
separate search and tag workers. Yonalist already keeps SQLite, FTS, and
viewport queries off the renderer's input path through its database worker.

## Architecture

### Subscription boundaries

`NotesStore` remains the public frontend façade. Its React-facing subscription
surface is divided into three stable projections:

```ts
interface NotesStoreSubscriptions {
  subscribeShell(listener: () => void): () => void;
  getShellSnapshot(): NotesShellSnapshot;

  subscribeOutline(listener: () => void): () => void;
  getOutlineSnapshot(): NotesOutlineSnapshot;

  subscribeNode(nodeId: string, listener: () => void): () => void;
  getNodeSnapshot(nodeId: string): NotesNodeSnapshot | null;
}
```

`NotesShellSnapshot` owns app status, pages, active page, history availability,
cursors, errors, and pending-write state. It contains no draft maps.

`NotesOutlineSnapshot` owns the confirmed ordered node references and revision
needed to derive hierarchy. Its identity remains stable for draft-only edits.
Text or note confirmation updates the affected node projection without
rebuilding the structural node order. Structural receipts publish a new
outline snapshot.

`NotesNodeSnapshot` owns one confirmed node plus its current title and note
draft. Draft edits publish only that node ID. Snapshot objects are cached and
retain identity until that node's observable fields change.

### React ownership

`App` subscribes only to the shell projection. A focused workspace component
subscribes to the outline projection. `OutlineRow` subscribes to its own node
projection instead of receiving draft maps from `App` or `NotesOutline`.

Navigation callbacks and split-pane location remain pane-owned. The refactor
does not introduce a global React context or move transient caret, selection,
drag, or IME state into SQLite.

### Store decomposition

`notesStore.ts` becomes a façade that composes focused collaborators:

- `storeSubscriptions.ts` caches projections and publishes shell, outline, and
  node invalidations;
- `storeDrafts.ts` owns title/note timers, history groups, flush barriers, and
  close draining;
- `storeCommands.ts` owns request IDs, revision-checked command serialization,
  optimistic receipt application, and error mapping;
- `storeViewport.ts` continues to own bootstrap, page opening, and bounded
  pagination;
- `storeHistory.ts` continues to publish session-history events.

The public `NotesStore` methods used by rows and app navigation remain stable
unless a smaller typed interface can replace a concrete-class dependency
without duplicating adapters.

`App.tsx` delegates pane-location capture and restoration to
`appNavigation.ts` and delegates the Notes detail layout to a focused
component. Splitting follows responsibility; it does not create one-file
wrappers or rename symbols merely to reduce line counts.

## Update Rules

Draft and receipt paths publish the smallest valid invalidation:

| Change | Shell | Outline | Node |
|---|---:|---:|---:|
| Title/note keystroke | no | no | affected ID |
| Draft timer starts or clears | no | no | affected ID |
| Pending-write/history/error change | yes | no | affected ID when applicable |
| Confirmed text/note receipt | yes | no | changed IDs |
| Create/delete/move/indent/restore | yes | yes | changed/deleted IDs |
| Page open or viewport replacement | yes | yes | old and new visible IDs |

Listeners are notified after the authoritative in-memory state has been
updated. A subscriber reading during notification therefore sees one coherent
revision. The existing command queue remains the mutation ordering authority;
subscription channels do not create a second optimistic state machine.

## Workflowy-derived Performance Decisions

The implementation adopts only measured, architecture-compatible ideas:

- Keep native key-repeat events flowing directly to the focused editor.
- Preserve pane-local Enter and Backspace gesture ownership.
- Avoid parent-level draft subscriptions and full-outline reconciliation on
  each keystroke.
- Reuse one `OutlineIndex` per stable structural node array.
- Keep search and derived indexing outside the interactive renderer path.
- Lazy-load image UI in the later media slice so the text editor's initial
  graph remains unchanged.

The implementation explicitly does not copy Workflowy's full rendered
800-row DOM. Yonalist retains the current bounded SQLite viewport and measures
before introducing row virtualization, because virtualization would complicate
native selection, drag projection, cross-pane drops, and caret restoration.

## Existing Interaction Verification

The existing automated contracts are treated as characterization tests:

- `apps/desktop/src/navigationHistoryIntegration.test.tsx` owns split
  navigation and restoration.
- `apps/desktop/src/selectionMoves.test.ts` owns multi-node move planning.
- `apps/desktop/src/outlineClipboardIntegration.test.tsx` owns multi-selection,
  keyboard Tab, pointer dragging, and destination split projection.
- `crates/notes-sqlite/tests/vertical_slice.rs` owns atomic multi-node
  persistence and Undo/Redo.

After the refactor, a fresh local preview exercises:

1. open and resize a secondary pane;
2. select contiguous bullets with pointer and keyboard gestures;
3. indent and outdent the selection;
4. reorder the selection;
5. drag the selected forest into the other pane;
6. Undo and Redo each accepted structural gesture; and
7. repeat Enter and Backspace while commits are pending.

If a runtime behavior fails, its smallest owning test must fail for the same
reason before production code is changed.

## Placeholder Removal

The preview bootstrap seed removes only the instructional bullet
`Press Enter to add another thought.`. Empty rows remain real persisted or
optimistic nodes with an empty value. CSS pseudo-elements and textarea
placeholders must not recreate instructional text inside an empty bullet.

## Performance Gates

- A store test with at least 800 nodes proves that changing one draft preserves
  the shell and outline snapshot identities, notifies the changed node once,
  and does not notify adjacent nodes.
- The existing 200-event input guard remains below 20ms p95 with no task above
  50ms.
- The initial editable JavaScript remains at or below 300KB raw and 90KB gzip.
- The 5,000-node bounded bootstrap p95 and 50,000-node append/bootstrap
  fixtures do not regress beyond their existing thresholds.
- Architecture checks continue to fail on reverse imports and cycles. Runtime
  production files over 500 lines remain advisory during the split and must
  end below the warning limit unless a documented cohesion reason remains.

## Test Strategy

The slice follows strict red-green-refactor cycles:

1. Add failing projection/subscription tests that name the full-rerender break.
2. Add a failing preview test for the instructional seed.
3. Implement the smallest subscription hub and route one title draft through
   it.
4. Move note drafts and confirmed non-structural receipts to the same boundary.
5. Split store and app responsibilities while the owning tests remain green.
6. Run the focused split, selection, drag, keyboard-repeat, and preview tests.
7. Verify the fresh browser path.
8. Freeze the diff, then run the complete v2 frontend, Rust workspace,
   contract, architecture, bundle, formatting, and diff gates once.

## Delivery Boundary

This slice is complete only when row-isolated drafts, the removed
instructional seed, code decomposition, automated interaction contracts, and
fresh browser evidence all pass together. Image schema or media code must not
be added to this slice. Its next consumer is the image-node vertical-slice
design, which can rely on stable node-level subscriptions and lazy row
components without enlarging the text input path.

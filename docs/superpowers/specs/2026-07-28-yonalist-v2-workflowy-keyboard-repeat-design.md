# Yonalist v2 Workflowy Keyboard Repeat Design

## Contract

| Field | Decision |
| --- | --- |
| Goal | Plain Enter, Backspace, and cursor keys behave like the observed Workflowy web editor, including held-key repeat, without changing Yonalist's current visual design. |
| Acceptance | Plain Enter repeats through newly created bullets; native Backspace deletes characters and crosses eligible bullet boundaries; empty bullets show only a caret; Up/Down stay native inside wrapped text and cross rows at visual boundaries; Left/Right cross rows at title boundaries and continue on repeat. |
| Non-goals | Vault synchronization, GitHub Notifications, attachments, export, themes, visual redesign, persistent crash recovery for optimistic input, or copying Workflowy's private implementation. |
| Boundaries | React textarea editing, pane-local focus/repeat coordination, generated IPC contracts, Rust session history, notes-core tree invariants, SQLite mutation patches, and the preview adapter. |
| Manual proof | In a fresh v2 desktop/browser preview, hold Enter across five insertions, hold Backspace across text and empty bullets, traverse wrapped and single-line bullets with all arrow keys, verify one-step Backspace Undo, and confirm no placeholder text appears in an empty bullet. |

## Observed Workflowy behavior

The authenticated Chrome test page was exercised with temporary bullets and
restored afterward.

- An empty title is a completely empty `contenteditable`; it has no visible
  placeholder and no synthetic `<br>`.
- Plain Enter accepts native repeat. Five consecutive events create five empty
  bullets and leave focus on the final bullet.
- Left at title offset zero focuses the previous visible title at its end.
  Right at title end focuses the next visible title at offset zero.
- Up/Down remain native while a wrapped title has another visual line. Crossing
  the first or last visual line focuses the previous or next title at offset
  zero.
- Backspace at offset zero merges only when the immediately preceding visible
  item is the previous sibling title:
  - both nodes have the same parent;
  - the previous sibling has no children;
  - the previous sibling has no supporting note.
- The current node survives a merge. The previous text is prepended to the
  current text, the current node moves into the previous sibling's position,
  and the caret is placed at the join offset.
- The current node's supporting note and children survive because its identity
  survives. A previous sibling with a note or children blocks the merge.
- Backspace at the start of a first child does not merge it into its parent.
- An empty eligible bullet is removed and focus moves to the preceding visible
  title. Repeated Backspace can continue from that title.

## Root cause in v2

- `resolveOutlineKey` consumes repeated cross-row Left/Right events.
- Up/Down always leave the textarea, even when the caret has another wrapped
  visual line.
- Focus transitions wait for draft persistence and a later animation frame,
  so native repeat can target stale row state.
- Split and empty removal publish structural state only after IPC settlement.
  Multiple repeat events can therefore enqueue operations against the same
  source row.
- No domain command represents Workflowy's backward sibling merge.
- `OutlineRow` passes `placeholder="Type something"` for an empty title.
- Repeated depth and sibling scans allocate maps and filter the same bounded
  query model per row.

## Accepted architecture

### 1. Keep native keys native whenever possible

Plain character insertion/deletion and Arrow keys inside a textarea remain
browser-native. The app intercepts only a proven cross-row or structural
boundary.

`measureTextareaCaretLines(textarea)` uses one reusable off-screen mirror with
the textarea's computed wrapping styles. Up crosses rows only from the first
visual line; Down crosses rows only from the last visual line. Left/Right use
the existing UTF-16 start/end boundary.

Cross-row focus is synchronous and does not wait for `flushDraft`. Draft
persistence remains serialized in the store and is flushed by blur/close.

### 2. Publish structural input optimistically

`NotesStore` exposes begin-style methods for plain Enter, empty removal, and
backward merge. Each method:

1. allocates or resolves the final node identity;
2. publishes a provisional query-model patch synchronously;
3. returns the focus target immediately;
4. serializes the authoritative command through the existing command queue;
5. replaces the provisional state with the mutation receipt;
6. restores the captured state and focus contract if the command fails.

A source-node in-flight set prevents duplicate structural commands before
React transfers focus. Native repeat resumes from the newly focused textarea.
No custom `setInterval` competes with the operating system's repeat cadence.

### 3. Add one atomic backward-merge command

The generated IPC contract adds:

```rust
MergeNodeBackward {
    id: NodeId,
    previous_id: NodeId,
    previous_text: String,
    current_text: String,
}
```

`notes-core` validates that both nodes are active bullets, share a parent, are
adjacent siblings, and that the previous sibling has neither children nor a
supporting note. It then:

- sets the current text to `previous_text + current_text`;
- assigns the previous sibling's sort position to the current node;
- deletes the previous sibling;
- leaves all current-node fields and descendants unchanged.

The normal forward/inverse patch planner makes the command reversible. SQLite
persists the changed current node and deleted previous node in one transaction.

### 4. Treat held Backspace as one interaction group

The first plain Backspace starts a pane-owned gesture. Native title changes,
eligible empty removals, and backward merges use one generated history group
until keyup, blur, visibility loss, pane disposal, or close. Keyup prevents any
new optimistic deletion but does not cancel already admitted persistence.

One Undo restores the confirmed text and structure at the start of the held
gesture. One-shot commands such as Tab, Shift+Enter, completion, duplicate,
move, delete, zoom, Undo, and Redo continue to consume repeat.

### 5. Keep the large-outline hot path bounded

- Preserve the 80-node SQLite viewport-first query contract.
- Build one `OutlineIndex` per stable node array with `byId`, `depthById`,
  `visibleIndexById`, `childrenByParent`, and sibling relations.
- Reuse the index for visibility filtering, row depth, keyboard navigation,
  selection, and merge eligibility instead of rebuilding maps per row.
- Give off-screen resting rows CSS layout containment/content visibility while
  forcing focused, selected, drag, and menu-open rows visible.
- Never reload the full page after a mutation; receipts remain patch-only.

This adopts the measured useful properties of Workflowy's native input and
incremental rendering while retaining v2's smaller bounded query model.

## Failure and safety rules

- IME composition and `Process` events never become structural commands.
- A failed optimistic operation restores the captured nodes/drafts and exposes
  the existing retryable error.
- A previous sibling with children or a supporting note blocks merge.
- A first sibling, page title, noncollapsed selection, or stale/missing node
  blocks merge.
- An empty title with a supporting note is not removed.
- Repeated one-shot shortcuts remain one-shot.
- No visual class, spacing, color, typography, or layout token changes.

## Verification

- Pure resolver tests cover every repeat policy and visual-line boundary.
- React integration tests cover provisional Enter chaining, Backspace merge,
  empty removal, focus offsets, IME, and placeholder absence.
- notes-core property/unit tests cover merge invariants and inverse patches.
- application/SQLite tests cover one-transaction receipts, history grouping,
  Undo/Redo, restart persistence, and rejection rollback.
- Preview tests implement the same IPC command semantics.
- A fresh browser/Tauri smoke uses five Enter repeats and a Backspace hold over
  text plus at least three empty bullets.

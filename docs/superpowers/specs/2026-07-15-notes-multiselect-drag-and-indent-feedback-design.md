# Notes Multi-Select Drag and Indent Feedback Design

**Status:** Approved for implementation

## Goal

Make two existing multi-select interactions explicit and reliable:

1. When a selected range begins with a sibling that cannot itself be indented,
   explain why that first item stayed in place after the remaining items were
   indented.
2. Dragging the bullet of any selected row moves the normalized selected forest
   as one ordered, hierarchy-preserving block.

The change must retain the existing one-transaction, one-history-entry mutation
contract and must not introduce a second move implementation.

## Current Architecture and Gap

The selection snapshot already distinguishes every explicitly selected visible
row from its normalized structural roots. The indent eligibility calculation can
therefore submit only the trailing roots when the first selected sibling has no
preceding sibling. The backend treats the retained first root as the preceding
unsubmitted sibling and reparents the submitted roots beneath it atomically.

The shared selection command router currently reports every successful indent as
`Indented selection.`, even when it applied only to the eligible subset. The
selection action bar already has one neutral, polite, atomic live region for
status text, so no new toast or notice component is needed.

Multi-root drag projection, frozen selection authority, atomic batch move, and
backend hierarchy preservation also already exist. Pure tests cover multi-root
projection, and integration tests cover selected single-row drag and invalid
multi-row drops. The missing product-level guarantee is a valid rendered
multi-row drag from the selected range to an external destination.

## Chosen Approach

Reuse the current selection drag session and shared semantic command router.
First reproduce the reported valid multi-row drag at the rendered workspace
boundary. Trace any failure through drag activation, frozen authority,
projection, router execution, and the single batch payload, then make the
smallest correction at the failing boundary.

Do not add a parallel group-drag implementation. Do not repeat single-node move
commands for each selected item: that would permit partial failure and create
multiple Undo entries.

## Indent Feedback Contract

When the exact leading-retained-root shape is committed:

- the frozen structural roots are `[first, ...trailing]`;
- the eligible indent targets are exactly `trailing`;
- `first` remains in place because it has no preceding sibling;
- the trailing roots become children of `first` in one batch.

After authoritative settlement, the router publishes this neutral status:

```text
First item stayed: no preceding sibling.
```

The message appears in the right-side status region of the sticky selection
action bar, between the overflow actions and Delete. It uses the existing
`role="status"`, `aria-live="polite"`, and `aria-atomic="true"` behavior. It is
not styled as an error because the requested eligible mutation succeeded.

The special message is used only when the eligible IDs equal the structural
roots with exactly the first root removed. A fully eligible indent retains
`Indented selection.` Other partial-selection shapes retain their existing
generic status unless a separately approved message is added later.

An execution failure, stale authority, or projection failure continues to use
the existing error path. When both a committed status and a projection error
exist, the error remains visually dominant.

## Selected Bullet Drag Contract

### Activation

- The draggable affordance remains the row bullet.
- If the dragged bullet belongs to the materialized selection, the drag is a
  selected drag, regardless of whether that row is the range anchor, head, or a
  middle row.
- The ellipsis menu and row body do not become additional drag handles.
- Dragging a row outside the selection retains the existing ordinary single-row
  behavior.

### Source Normalization

At drag start, freeze the current selection revision, authoritative workspace,
and normalized structural roots. If a selected parent and its descendants are
both visible in the range, only the parent is a move root; its whole subtree
travels with it. Independent selected roots remain in authoritative outline
order.

The selected drag must never fall back to an ordinary single-row drag after
activation. If authority preparation fails or the selection changes, the result
is a selected no-op.

### Projection and Drop

The existing outline projection calculates the destination parent and sibling
anchor after removing the entire selected forest from drag geometry. A valid
drop sends exactly one semantic `reorder` intent containing the frozen
structural roots and one move target.

The repository receives one batch move:

```text
{ op: "move", nodeIds: structuralRootIds, parentId, afterId, beforeId }
```

It places the roots as one contiguous block, preserves their source order, and
leaves every moved subtree's internal hierarchy unchanged. A collapsed valid
destination is locally expanded through the existing expansion option so the
moved selection remains visible.

### Invalid and Stale Drops

Dropping on any selected root or selected descendant is an invalid no-op. A
missing destination, stale selection revision, stale workspace authority,
invalid geometry, or a superseded pending drag also performs no mutation. These
paths keep the selection and use the existing accessible drag announcement.

After a successful drop, the original stable anchor/head selection remains
active while both endpoints are visible. If the current projection cannot
materialize an endpoint, the established selection lifecycle closes the range
instead of guessing a partial selection.

## Data Flow

```text
selected bullet drag
  -> frozen selection drag session
  -> normalized structural roots
  -> outline drop projection
  -> shared selection router (`reorder`)
  -> one prepared batch move
  -> one SQLite transaction / one history entry
  -> authoritative projection and retained selection
```

The indent feedback follows the existing shorter path:

```text
Tab
  -> indent eligibility subset
  -> shared selection router
  -> one prepared batch indent
  -> authoritative settlement
  -> neutral action-bar status
```

## Testing

Use strict RED/GREEN cycles.

1. Extend the router test for partial indent to assert that a leading retained
   root produces `First item stayed: no preceding sibling.` with no error. Add a
   full-eligibility assertion so `Indented selection.` cannot regress.
2. Extend the rendered workspace Tab scenario to assert the same text in the
   selection action bar's polite status region after the single batch settles.
3. Add a rendered workspace pointer-drag regression matching the screenshot:
   five sibling children are selected, the bullet of a selected row is dragged
   to an external destination, and one `applyBatch` call contains all five
   normalized roots in outline order.
4. Settle the mocked authoritative workspace and assert that selection,
   relative root order, and subtree hierarchy remain intact at the destination.
5. Retain the existing invalid-inside-selection, stale authority, reverse range,
   ancestor normalization, filtered hidden-order, and collapsed-destination
   coverage.
6. Run the complete frontend suite, Rust suite, lint, production build, and
   whitespace validation. No new Rust production code is expected, but the
   existing backend batch-move and batch-indent contracts remain part of the
   regression gate.

## Alternatives Rejected

### New Group-Drag System

A separate overlay and move session could make the group more visually
prominent, but it would duplicate projection, authority, and mutation logic.
The current architecture already has the required boundaries, so this adds risk
without enabling new behavior.

### Repeated Single-Node Moves

Moving each selected root one at a time is simpler locally but violates atomic
failure and single-Undo guarantees. It can also disturb order while later roots
are still being moved.

## Non-Goals

- Arbitrary non-contiguous selection beyond the current anchor/head range.
- A new global toast or notification system.
- New drag handles on the row body or ellipsis menu.
- A multi-item drag avatar or count badge.
- Changes to Move To, one-step keyboard reorder, or ordinary single-row drag.
- New Tauri commands, database schema, or repository mutation types.

# Notes Split View Interaction Performance Design

## Contract

| Field | Decision |
| --- | --- |
| Goal | With split view open, Enter and ordinary caret navigation remain as responsive as the existing single-pane path. |
| Acceptance | The correct pane-owned Enter publication reaches both pane render paths; Enter causes zero outline FLIP rectangle reads and zero animations; a caret-only move does not commit the unchanged sibling pane; the representative desktop benchmark records before/after p50 and p95 and keeps `p95(focus - IPC end) <= 16 ms`. |
| Non-goals | New Enter semantics, optimistic rows, a new animation system, a general external store, more than two panes, Rust/IPC/SQLite/filesystem changes, or persistence/history changes. |
| Boundaries | React state identity, pane contexts, keyboard-insertion publication selection, and existing development-only latency instrumentation. |
| Manual proof | A freshly built and restarted Tauri app using an isolated 5,000-node Vault, 50 visible rows, split view open, and both primary- and secondary-pane interaction runs. |

## Root cause

The slowdown has two independent causes.

First, `notesWorkspaceCoordinator` computes one projection publication per
pane but stores it in a map keyed only by session. The later pane overwrites the
earlier pane. Only the Enter origin pane carries
`keyboardInsertionDisposition`, so a primary-pane Enter loses the disposition
when the secondary pane is registered later. Both panes then miss the existing
zero-motion path and fall through to ordinary FLIP measurement and animation.

Second, `useNotesWorkspacePaneRegistry` derives secondary state by spreading
the complete primary workspace state and depends on the complete primary state
object. A primary-only caret move therefore recreates the secondary state,
state slice, and registry value. `NotesPaneScope` subscribes to that aggregate
registry, so the unchanged pane renders again. Editing-lease value changes also
recreate callbacks and both action slices even though the lease operations
themselves are stable.

## Accepted design

### Preserve the pane-owned Enter publication

Keep the current session-level publication contract. While reducing pane
publications into that map, prefer the publication containing
`keyboardInsertionDisposition`. A later generic pane publication must not
overwrite it; outside keyboard insertion, the existing last-pane behavior
remains unchanged.

The runtime continues to publish one session result to both pane scopes. The
existing `NotesOutlinePane` visible-signature check converts a signature
difference to the safe mixed disposition, so both panes take the existing
zero-motion path without a new motion type or second registry.

This selection must work for either origin direction:

- primary Enter followed by secondary projection;
- secondary Enter following primary projection.

### Keep unchanged pane slices referentially stable

Build the secondary normalized workspace from shared structural fields and
secondary navigation fields instead of depending on the complete primary state
object. Build its state and drafts slices from their individual shared fields
plus pane-local expansion, focus, and selection fields. A primary-only
navigation or selection update must therefore preserve the secondary slice
identity; the inverse already follows from the primary slice ownership and
must remain true.

Resolve each `NotesPaneRuntimeSlice` in `NotesDetailSplitHost` and pass it to a
memoized pane boundary. `NotesPaneScope` provides the supplied slice through
the existing narrow state, drafts, and actions contexts instead of subscribing
to the aggregate registry itself. The host may render for split controls, but
an unchanged pane subtree must bail out at this boundary.

Make `canEdit` and `structuralCommandsAllowed` stable callbacks in
`useNotesEditingLease`. Registry callbacks depend on the stable lease methods
rather than the controller object containing changing lease state. No lease
rule or ownership behavior changes.

## Data flow

For Enter:

1. The origin pane dispatches the existing keyboard insertion intent.
2. The coordinator projects every registered pane.
3. The session result retains the candidate carrying the origin disposition.
4. Both pane scopes receive that publication.
5. The origin uses its exact/mixed disposition; a pane with a different visible
   signature uses the existing mixed fallback.
6. Both skip synchronous FLIP capture and animation, then follow the existing
   rebaseline policy.

For caret movement:

1. The active pane updates its pane-owned navigation and editing lease.
2. Shared structural data keeps the same references.
3. The inactive pane's state, drafts, and actions slices keep the same
   references.
4. The memoized pane boundary prevents the inactive outline subtree from
   committing.

## Error and compatibility behavior

No persistence, history, synchronization, or focus eligibility rule changes.
A missing or mismatched keyboard insertion disposition retains the existing
ordinary motion decision. If both pane candidates are generic publications,
the reducer preserves the existing last-candidate result. Split close/open,
drag-and-drop, collapse/expand, selection, IME composition, read-only guards,
and command serialization keep their current behavior.

## Verification

### Deterministic regression and benchmark checks

Add the smallest owning tests that fail on the committed baseline and pass
after the fix:

- one coordinator test with a single session and two registered panes proves
  the origin disposition survives in both origin directions;
- one split-context render test proves 50 caret moves commit the active pane
  but zero times in the unchanged sibling pane, in both directions;
- existing motion tests prove the retained publication produces zero
  application-owned rectangle reads and zero animations;
- existing row memo assertions continue to prove unchanged heavy editors do
  not commit.

The benchmark reports raw counts rather than adding timing thresholds to jsdom.

### Fresh Tauri before/after benchmark

Use a fresh build and process for each side of the comparison and the same
isolated Vault:

- 5,000 total text nodes;
- 50 visible outline rows;
- split view open;
- primary and secondary pane measured separately;
- 10 warm-ups followed by 50 measured interactions per scenario.

Scenarios:

1. clean split Enter;
2. dirty split Enter;
3. dirty first-child Enter;
4. ArrowUp/ArrowDown caret movement.

For Enter, reuse the existing split latency phases and record keydown, draft
barrier, IPC end, settlement, and caret. For caret movement, install a
temporary capture-phase benchmark listener in both baseline and fixed builds,
record keydown-to-focus with the renderer clock, and remove it before the final
diff. Report p50 and p95 for keydown-to-focus and, for Enter,
IPC-end-to-focus.

The acceptance gates are:

- `p95(focus - IPC end) <= 16 ms` for Enter;
- zero Enter-owned FLIP rectangle reads and animations;
- zero inactive-pane commits during caret-only movement;
- no command, focus, animation, or rebaseline backlog after the final run.

The before/after table records all observed values even when the baseline fails
these gates. Wall-clock values are representative desktop measurements, not CI
assertions.

## Delivery

Use test-driven development in an isolated worktree. Run focused tests during
the edit loop. After the diff is frozen, run the frontend gates once:
`npm test`, `npm run lint`, `npm run build`, and `git diff --check`. Rust,
Cargo formatting, and Clippy are explicitly out of scope because no native,
IPC, persistence, or native configuration boundary changes.

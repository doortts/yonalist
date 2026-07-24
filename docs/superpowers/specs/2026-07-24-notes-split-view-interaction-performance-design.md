# Notes Split View Interaction Performance Design

## Contract

| Field | Decision |
| --- | --- |
| Goal | With split view open, Enter and ordinary caret navigation remain as responsive as the existing single-pane path. |
| Acceptance | The correct pane-owned Enter publication reaches both pane render paths; Enter causes zero outline FLIP rectangle reads and zero animations; a caret-only move does not commit the unchanged sibling pane; the representative desktop benchmark records before/after p50 and p95 and keeps split `p95(focus - IPC end) <= 16 ms`. |
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

## Benchmark-driven remediation

The first fixed desktop run proved that the accepted design removed the
publication overwrite and caret-only sibling churn, but it did not yet satisfy
the full desktop contract.

For a primary clean split, publication receipt and the first owning-pane render
arrived within 14 ms of command settlement. Both panes then synchronously
reconciled the structural workspace before layout effects became available,
adding about 61 ms. The passive focus effect and `focus()` itself added only
about 5 ms and 1 ms respectively. The remaining primary delay is therefore the
shared urgent render of both structurally changed panes, not IPC, animation, or
DOM focus.

For a secondary clean split, the coordinator produced an exact,
focus-eligible disposition owned by `secondary`, but the result navigation
patch still entered the primary workspace reducer. The primary pane received
the expected `pendingFocusId` and correctly rejected the secondary interaction
epoch; the secondary pane received no focus request. The first divergent
boundary is pane-local settlement routing.

### Considered approaches

1. **Recommended: owner-routed settlement plus React deferred inactive
   rendering.** Route a keyboard insertion's navigation patch by
   `ownerPaneId`, retaining the current primary path and applying a
   secondary-owned patch only to the secondary pane session. Give the active
   pane its current runtime slice and the inactive pane a React-deferred slice,
   so the focus target commits before the non-owner projection catches up.
2. **Custom frame scheduler.** Buffer non-owner pane snapshots and publish them
   with `requestAnimationFrame`. This is more deterministic but adds cache,
   cancellation, unmount, and Vault-replacement state that React already owns.
3. **Synchronous whole-outline optimization.** Profile and refactor both
   outlines until their combined structural render fits one frame. No single
   deeper component was identified as the dominant hotspot, so this would be a
   larger speculative rewrite.

Use approach 1. It reuses the existing pane session boundary and React's native
deferred rendering without adding a store or scheduler. The inactive pane may
show the previous structural projection for one render while it is not the
interaction owner; it must converge automatically to the same final workspace.

### Remediation data flow

For a settled keyboard insertion:

1. Read the already-validated disposition and its `ownerPaneId`.
2. For a primary owner, keep the current workspace reducer navigation path.
3. For a secondary owner, apply `selectedId`, `editingNoteId`,
   `pendingFocusId`, and `pendingFocusField` to the secondary pane session and
   omit that navigation patch from the primary reducer.
4. Render the active owner pane from its current slice.
5. Render the inactive pane from a React-deferred slice; once the urgent owner
   commit and focus complete, React reconciles the final inactive projection.

The interaction-epoch guard remains unchanged. It continues to reject stale or
foreign focus requests rather than compensating for incorrect routing.

### Remediation verification

Before production edits, add two failing regressions:

- a different-projection secondary insertion routes the pending focus only to
  the secondary pane and leaves primary navigation unchanged;
- when both structural pane slices change, the active pane commits its focus
  target without synchronously reconciling the inactive outline, which later
  converges to the new projection.

After focused and full frontend gates pass, rebuild the exact isolated desktop
app and repeat all eight 10-warm-up/50-measured scenarios. Every applicable
count must be 50 and every split `p95(focus - IPC end)` must be at most 16 ms.
If deferring the inactive pane does not move the owning layout commit inside
that threshold, stop and profile the active outline before considering the
larger synchronous optimization.

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
3. clean first-child Enter;
4. ArrowUp/ArrowDown caret movement.

For split Enter, reuse the existing split latency phases and record keydown,
draft barrier, IPC end, settlement, and caret. First-child Enter records
keydown-to-focus because the split phase probe does not own that command. For
caret movement, install a
temporary capture-phase benchmark listener in both baseline and fixed builds,
record keydown-to-focus with the renderer clock, and remove it before the final
diff. Report p50 and p95 for keydown-to-focus and, for split Enter,
IPC-end-to-focus.

The acceptance gates are:

- `p95(focus - IPC end) <= 16 ms` for split Enter;
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

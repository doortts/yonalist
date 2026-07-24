# Notes History Session Auto-Recovery Design

Date: 2026-07-25

## Contract

| Field | Decision |
| --- | --- |
| Goal | When the backend reports that a Notes history entry is missing or belongs to another session, reset only the session Undo/Redo history, preserve Notes content and local drafts, resume editing automatically, and tell the user what happened. |
| Acceptance | A typed history-session mismatch never appears as a raw backend message; recovery runs once per Vault; successful recovery preserves the current presentation and drafts, clears stale history, resumes queued saves and later commands, and shows a non-blocking explanation; only a failed reset enters a write-blocked state with explicit recovery actions. |
| Non-goals | Reconstructing lost Undo/Redo entries, replaying an Undo/Redo target that can no longer be proven, ignoring arbitrary database/I/O errors, changing persisted Notes data, or adding persistent cross-launch history. |
| Boundaries | Rust history validation and IPC error taxonomy; TypeScript Notes error taxonomy and store adapter; the per-Vault workspace coordinator; history and optimistic-insertion controllers; Notes feedback UI. |
| Manual proof | In a fresh Tauri app using an isolated test Vault, force the backend TEMP history to rotate while the frontend has pending cleanup, then issue another edit. Verify automatic recovery, preserved content/draft/caret, fresh Undo history, continued editing, and the expected status message. Force `clearHistory` to fail and verify the actionable hard-recovery banner. |

## Problem

`validate_owned_entry_ids` rejects an entry ID when the backend TEMP history
does not contain it or when another frontend session owns it. This validation
is correct: pruning or replaying an unowned entry would make Undo/Redo unsafe.

The frontend already has a single-flight `recoverHistoryMismatch` path for
history-state mismatches found while accepting mutations, navigation, Undo, or
Redo. However, a mismatch thrown by `pruneHistoryEntries` while
`drainHistoryCleanup` runs is handled as a generic command failure. The raw
message reaches the bottom bar, the stale cleanup IDs remain pending, and the
same cleanup can prevent later commands from running.

The missing behavior is therefore not permission to ignore the error. It is a
typed bridge from backend ownership validation to the existing history-reset
recovery mechanism.

## Options Considered

### 1. Typed, history-only automatic recovery — selected

Classify the ownership failure as `historySessionMismatch`. At the coordinator
boundary, reset backend and frontend session history in one single-flight,
preserve the authoritative presentation and local drafts, then continue work
that is still safe.

This keeps the smallest unsafe scope—the lost Undo/Redo lineage—out of service
without turning the whole editor into a stopped state.

### 2. Ignore stale cleanup failures

Dropping the stale IDs and continuing would be fast, but the frontend timeline
could still point at entries that the backend cannot prove. A later Undo,
Redo, or redo-truncation request could target the wrong history state. This
option is rejected.

### 3. Reopen the entire Vault automatically

Closing and reopening the Vault produces a fresh backend connection and empty
TEMP history, but it also rebuilds the whole presentation and can disrupt
selection, focus, local drafts, and optimistic edits. It remains a hard
recovery action, not the default response.

## Error Contract

Add `HistorySessionMismatch` to the Rust `NotesErrorCode` enum and serialize it
as `historySessionMismatch`. The stable ownership-validation message is
classified to this code at the Rust command boundary.

Mirror the code in the TypeScript `NotesErrorCode` union. It is non-retryable
for an identical request: resending the same stale entry IDs cannot succeed.
The frontend must branch on the code, never on the English display message.

The code is intentionally narrow. Disk failures, lock contention, malformed
responses, and arbitrary `internal` errors must not be promoted to a history
reset. Those failures retain their existing handling.

## Recovery State Machine

The coordinator owns recovery because it already serializes every mutation,
history command, draft save, and presentation settlement for a Vault.

```text
ready
  └─ historySessionMismatch
       └─ recoveringHistory
            ├─ clear/reset succeeds ──> ready + recovered notice
            └─ clear/reset fails ─────> recoveryBlocked

recoveryBlocked
  ├─ user retry succeeds ─────────────> ready + recovered notice
  └─ user reopens Notes ──────────────> fresh coordinator generation
```

### Entering recovery

On the first typed mismatch:

1. Mark that Vault as `recoveringHistory` before starting recovery I/O.
2. Share one recovery promise with every concurrent caller.
3. Do not dispatch another history-aware backend mutation until recovery
   settles.
4. Keep the current visible workspace, selection, focus, expansion state, and
   local draft ledger.
5. Read current backend history status.
6. Call `clearHistory` with the current session ID and backend epoch.
7. Require an acknowledged reset with a new epoch.
8. Reset the frontend mixed timeline, pending cleanup IDs, open text burst,
   navigation leases, and stale reserved history contexts.
9. Rebind the preserved canonical presentation to the new epoch.
10. Resume commands whose intent is still valid.

The ownership failure happens before the rejected prune or navigation
transaction mutates Notes rows. The coordinator's confirmed workspace
therefore remains authoritative for this lightweight recovery. A full
workspace reload is unnecessary and would risk replacing local presentation
state. Existing mismatch paths that have uncertain content authority continue
to use their current authoritative reload.

### Work admitted during recovery

Recovery pauses backend dispatch, not the user's whole editing surface.

- Text input continues to update the local draft ledger. Its save waits for
  the new epoch and then creates a fresh history context.
- Ordinary structural commands that have not allocated a history context run
  after recovery and allocate against the new epoch.
- A pending autosave that was never dispatched is rearmed once. A dispatched
  save with an unknown outcome follows the separate write-authority recovery
  contract and is never replayed by this feature.
- Copy, selection, scrolling, and other read-only interactions remain
  available.

### Preallocated optimistic Enter

Optimistic Enter allocates a history context before its queue item runs. After
a reset, that context is stale.

Renew it with the same expected node ID only when all existing intent guards
still match: owner session, pane, interaction epoch, insertion token, source
postcondition, and projection/layout generation. The backend mutation has not
run, so a guard-valid renewal is a continuation of the same user action, not a
mutation replay.

If any guard is stale, cancel and roll back the optimistic insertion using the
existing checkpoint. Preserve its recovery text and tell the user that the
last bullet was not applied and should be tried again. Do not block later
editing.

### Undo, Redo, and navigation

An Undo or Redo target from the old epoch cannot be reconstructed safely.
Consume that single action without replay, reset history, and leave Notes
content and the current location unchanged.

A navigation command may continue only when its destination intent is still
current and it can allocate a fresh navigation history entry after recovery.
Otherwise consume the navigation attempt without moving the presentation.

## User Feedback

Do not show the backend ownership message to the user.

### Automatic recovery in progress

Use a polite, non-error status. It must not cover the editor or claim that
editing is paused:

> Restoring Undo history… You can keep typing.

This state may be too brief to render. It must not flash for a recovery that
settles in the same presentation frame.

### Automatic recovery completed

Show a non-blocking status in the existing Notes feedback area:

> Undo history was reset after the Notes session changed. Your notes and drafts are safe. You can keep editing.

The message may dismiss automatically after the normal status lifetime. Undo
and Redo are disabled until a new history entry is committed.

When an old Undo/Redo action was consumed, append:

> The requested Undo/Redo was not applied.

When an optimistic Enter could not be renewed, show the existing recoverable
insertion banner:

> Undo history was reset. The last new bullet was not applied; try it again.

Keep the existing `Copy text` action when recovery text is available.

### Hard recovery failure

Only failure to inspect history, clear it, acknowledge the reset, or install
the preserved presentation enters `recoveryBlocked`.

Use a persistent `role="alert"` banner:

> Notes could not finish recovery. Your current notes and drafts remain on screen, but saving is paused. Try recovery again. If it still fails, reopen Notes.

Actions:

1. `Try recovery` — rerun the single-flight reset without replaying a user
   mutation.
2. `Reopen Notes` — close and reopen the current Vault inside the app, creating
   a fresh coordinator and backend history session.
3. `Copy unsaved text` — shown only when the draft or optimistic-insertion
   ledger contains text that is not confirmed in the database.

While blocked, preserve drafts and permit selection/copy. Do not accept new
database mutations. Reopening Notes is the final fallback, not the first
instruction.

## Component Changes

### Rust history and error boundary

- Give the ownership mismatch a shared stable constant.
- Add `HistorySessionMismatch` to `NotesErrorCode`.
- Classify only that constant to the new code.
- Preserve the current transaction ordering so validation still happens
  before pruning or replay-related changes.

### TypeScript domain and Notes store

- Mirror `historySessionMismatch`.
- Mark it non-retryable for a bare identical request.
- Preserve it through `notesStoreError`.
- Add a dedicated type guard for coordinator recovery decisions if that keeps
  branching local and readable.

### Workspace coordinator

- Make cleanup draining return a typed outcome rather than leaking a raw
  exception.
- Route `historySessionMismatch` into one per-Vault recovery flight.
- Factor the existing reset mechanism so it can either reload authority or
  preserve the confirmed presentation when the backend proves no content
  mutation occurred.
- Keep queued work ordered across the reset.
- Expose `recovering`, `recovered`, and `blocked` recovery events without
  overloading ordinary mutation failure.
- Keep arbitrary cleanup errors pending and outside this automatic reset path.

### History and optimistic-insertion controllers

- Discard every old-epoch entry owner when reset is accepted.
- Rearm undispatched draft saves with a fresh context.
- Renew a preallocated optimistic Enter only under the full existing intent
  guard; otherwise use the current rollback/recovery-text path.
- Consume an old-epoch Undo/Redo attempt without replay.

### Notes feedback UI

- Render recovery progress as `role="status"`/polite live feedback.
- Render successful reset as a dismissible status.
- Render only hard recovery failure as `role="alert"` and expose the three
  actions described above.
- Keep editor geometry stable while any banner appears.

## Safety Invariants

1. No stale history entry ID is retried after a session mismatch.
2. No user mutation is replayed merely because history recovery ran.
3. A backend reset acknowledgement is required before the new epoch is
   installed.
4. Notes rows and attachment metadata are not changed by history-only
   recovery.
5. Local drafts are never cleared by history-only recovery.
6. Only guard-current, never-dispatched optimistic work may be renewed.
7. Undo/Redo from the old epoch is never guessed or reconstructed.
8. A failed recovery blocks writes but keeps read/copy access and recovery
   text.
9. Recovery and all queued work remain scoped to the Vault and coordinator
   generation that detected the error.

## Verification

### Rust

- The exact ownership mismatch serializes as
  `historySessionMismatch`.
- Unrelated history, SQLite, validation, and I/O failures remain `internal` or
  retain their existing code.
- A rejected prune/navigation validation leaves Notes rows, attachment
  metadata, TEMP history rows, and epoch unchanged.

### Frontend domain and store

- The new code parses and survives the store adapter.
- It is not retryable as an identical request.
- Malformed and unknown codes still fall back to `internal`.

### Coordinator

- A cleanup ownership mismatch starts one reset, clears pending cleanup, binds
  the returned epoch, preserves canonical presentation, and admits the next
  safe command.
- Two simultaneous mismatch observations share one reset.
- A normal queued mutation allocates a fresh history context after reset.
- Local drafts remain present and an undispatched save is rearmed once.
- An old Undo/Redo action is not replayed; the next new edit succeeds.
- A guard-current optimistic Enter renews its context and settles once.
- A stale optimistic Enter rolls back with recovery text and does not block a
  later edit.
- Generic cleanup errors do not trigger destructive history reset.
- A reset failure preserves drafts, blocks backend writes, and exposes retry.
- A successful retry leaves the blocked state without replaying skipped
  mutations.
- In-app reopen creates one fresh generation and does not let the old recovery
  apply afterward.

### UI

- Automatic recovery never renders the raw backend message or “editing is
  paused.”
- Success explains that Undo history was reset and Notes/drafts were
  preserved.
- Hard failure shows `Try recovery`, `Reopen Notes`, and conditionally
  `Copy unsaved text`.
- Copy and selection remain available in the hard state.
- Feedback does not move the outline's resting/focused text geometry.

### Desktop proof

1. Start a fresh Tauri process against an isolated Vault.
2. Create enough history to enqueue cleanup.
3. Rotate the backend history session before the next cleanup request.
4. Type and create a bullet while recovery runs.
5. Confirm the raw error never appears, the draft/content/caret remain, the
   valid pending action settles once, and later Undo starts from the new
   history generation.
6. Repeat with an Undo attempt and confirm the old Undo is consumed without
   changing content.
7. Force reset failure and verify the hard banner, copy path, retry, and
   in-app reopen fallback.

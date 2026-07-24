# Notes Optimistic Enter Persistence Design

## Contract

| Field | Decision |
| --- | --- |
| Goal | Show the new bullet and caret immediately on Enter while persisting keyboard insertions in the existing serial structural queue. |
| Scope | Clean/dirty split and first-child Enter in primary and secondary panes. |
| Success | The owning pane displays and focuses one provisional row before IPC completes; queued persistence preserves command order; success adopts the authoritative row without a focus reset; failure restores the pre-command checkpoint and explains the cause. |
| Performance | On the isolated 5,000-node/50-visible-row fixture, `p95(keydown → provisional caret) <= 16 ms` for both panes and all Enter insertion kinds. Persistence latency is reported separately. |
| Safety | Failed or unknown structural writes do not enter Undo history, later dependent commands do not escape the failed queue suffix, and text typed before failure remains recoverable during the running app and graceful close flow. |
| Non-goals | Optimistic UI for non-Enter commands, a general external store, a persistent offline outbox, a second write queue, or native schema/IPC changes. |

## Current boundary

The workspace coordinator already serializes structural writes. `splitNode`
uses `runStructuralCommand`, and dirty split packages the draft update and split
inside `runCompoundQueueWork`. The repository executes the split itself in one
SQLite transaction, so a definite split error rolls back both the prefix
update performed by that split and the new-node insert. A dirty draft flushed
as the preceding compound step may already be committed; that successful text
entry represents the exact pre-Enter editor value and remains authoritative
when the structural split fails.

The remaining delay is not a missing persistence queue. The UI waits for the
authoritative mutation result before the new row exists. Once that result
arrives, the active outline still needs 33–86 ms at p95 to reconcile and focus
the row. Moving the same whole-workspace render before IPC would remove the
storage wait but would not meet the one-frame caret target.

The design therefore makes only keyboard insertion optimistic and renders its
provisional row at the existing pane boundary. It does not optimistically
replace the shared authoritative workspace.

## Considered approaches

### 1. Recommended: pane-local provisional insertion

Extend the existing prepared keyboard-insertion record with the minimum data
needed to display one provisional source/new-row pair in its owner pane. The
owner pane overlays that pair on its current visible rows and focuses it
immediately. The existing structural queue persists the command and later
replaces the provisional row with the authoritative row using the same node
ID.

This avoids both IPC latency and whole-outline structural reconciliation on the
focus-critical commit. It reuses the existing pending-insertion registry,
owner-pane routing, interaction epoch, history reservation, and serial queue.

### 2. Optimistic shared workspace

Apply the split to a frontend workspace copy immediately, then replace it with
the authoritative workspace. This is simpler conceptually, but it sends the
same structural update through the active outline that currently costs up to
45 ms in the representative profile. It improves total latency but does not
address the measured one-frame requirement.

### 3. Persistent outbox or event-sourced workspace

Persist every UI command to a separate durable log and reconcile it with the
Notes database. This can support offline editing, but it duplicates the
existing structural queue and history authority. It is unnecessary for a
local Enter responsiveness fix.

Use approach 1.

## Optimistic insertion record

Reuse `PendingKeyboardInsertion` and its existing preparation lifecycle. Add a
single keyboard-insertion-only optimistic payload containing:

- operation and expected node IDs already reserved by the preparation;
- owner session and `ownerPaneId`;
- insertion kind: split or first-child;
- source row ID and placement data from the prepared visible snapshot;
- source title before Enter, split prefix, and initial inserted title;
- the source selection/caret needed to restore the pre-Enter editor;
- the existing history context and interaction epoch;
- current provisional inserted text;
- status: `prepared`, `queued`, `running`, `checking`, or `settled`;
- whether an optimistic Undo was requested.

This is not a second general journal. The existing entry-level keyboard
insertion registry remains the authority for pending IDs, and the existing
queue item remains the authority for execution order.

## Data flow

### Keydown and immediate presentation

1. The row applies the existing Enter eligibility rules and prepares the
   keyboard insertion.
2. The preparation captures the pre-Enter editor checkpoint and derives the
   provisional placement from the owner pane's published visible snapshot.
3. The owner pane publishes the provisional insertion locally:
   - split shows the prefix in the source row and inserts the suffix row after
     it;
   - first-child inserts an empty child immediately below the source.
4. Only the affected source editor and provisional editor render. The
   provisional editor uses the reserved final node ID and receives focus in
   the same urgent commit.
5. The unchanged structural command is appended to the existing queue.

The provisional row is visible only in the owner pane. Other panes retain their
last authoritative projection until the write settles, after which the
existing deferred inactive-pane path converges them.

### Typing while persistence is pending

Typing in the provisional editor updates the optimistic payload. It does not
send an update for a node that the database has not created yet.

After the insertion commits, any text newer than the initial inserted title is
flushed as the next ordinary update in the same queue. This preserves:

- split before edit;
- the same node ID;
- serial database order;
- one structural history entry followed by the normal text-entry history
  behavior.

Rapid Enter on a provisional row may prepare another optimistic insertion. It
is appended to the same queue and records its dependency on the preceding
expected node ID. At execution time, every command revalidates against the
latest confirmed workspace.

### Successful settlement

1. The repository returns the authoritative mutation.
2. The existing coordinator accepts the history result and publishes the
   authoritative workspace.
3. The owner pane removes the provisional flag while retaining the same row
   key and editor identity.
4. Focus is not requested a second time when the same interaction epoch and
   node already own the caret.
5. The inactive pane receives the authoritative row through its existing
   deferred slice.

Only a successfully accepted structural insertion becomes its structural
Undo/Redo entry. A preceding dirty-draft flush that committed successfully
keeps its existing text-entry history behavior even if the later split fails.

## Failure model

### Definite failure

Definite failures include:

- the source was removed, archived, replaced, or no longer matches the queued
  command;
- the new node ID already exists;
- an unsupported source such as an image node reaches split validation;
- the session, pane ownership, Vault generation, or history epoch becomes
  stale before execution;
- SQLite rejects the transaction because of storage, permission, lock,
  corruption, validation, or other I/O errors.

The SQLite split is atomic, so a returned split-transaction error means neither
the split prefix nor the new row committed. A separately confirmed dirty-draft
flush is retained as described above.

On definite failure:

1. cancel the failed command and its dependent optimistic queue suffix;
2. restore the presentation checkpoint immediately before the failed command;
3. do not add or undo a structural history entry for the failed write; retain
   any preceding text entry that was already confirmed;
4. preserve provisional text in the failed command's recovery payload;
5. show a persistent message naming the cause and stating that the last action
   was reverted;
6. offer `Retry`, which creates a new preparation after revalidating the
   current authoritative workspace.

An example message is:

> 저장 공간이 부족해 새 블릿을 저장하지 못했습니다. 마지막 작업을
> 되돌렸습니다.

### Unknown outcome

A transport close, native-process interruption, or lost response may occur
after SQLite committed. Blind rollback is unsafe because it can make the UI
disagree with the database or undo the previous unrelated history entry.

On an unknown outcome:

1. mark the insertion `checking`;
2. keep the provisional presentation and its text;
3. block later structural writes for the Vault while allowing text capture in
   the recovery payload;
4. show `저장 여부를 확인하고 있습니다.`;
5. use the existing authority recovery to reload the workspace and inspect the
   structural postcondition and history identity.

Recovery results:

- committed: adopt the authoritative workspace and settle the provisional row;
- not committed: perform the definite-failure rollback;
- reload failed or still ambiguous: retain the recovery payload, keep
  structural writes blocked, and show the existing manual recovery guidance.

## Optimistic Undo

Undo while an optimistic insertion is pending is immediate in the owner pane
but does not fabricate a history entry.

- If its queue item has not started, remove that item, discard the reserved
  history entry, restore the checkpoint, and remove the optimistic record.
- If its queue item is running, restore the presentation checkpoint and mark
  `optimisticUndoRequested`.
- If the running write is proven not committed, finish without backend Undo.
- If it committed, enqueue one exact backend Undo after that write and accept
  its authoritative result.
- If the write outcome is unknown, use authority recovery before deciding
  whether backend Undo is required.

If an earlier optimistic command fails or is undone, every later command that
depends on its provisional node is canceled and rolled back to the same queue
checkpoint. Independent already-confirmed work remains.

## User feedback

Reuse the existing persistent Notes error/status surface and live region. Do
not add a separate notification framework.

Messages distinguish:

- saving is being checked;
- the write was confirmed and retained;
- the write failed and the action was reverted;
- recovery could not determine authority and editing is blocked.

Known native error codes such as Vault busy or unsupported schema use their
specific explanation. Unclassified SQLite and I/O failures preserve the
backend message. User-facing text must state both the cause and what happened
to the optimistic action.

`Retry` is shown only when authority is known and the failed intent can be
revalidated. It never replays a stale closure blindly.

The recovery payload remains available until Retry succeeds or the user
dismisses it. If current authority no longer permits Retry, the same surface
offers `Copy text` so provisional typing is still recoverable.

## Lifecycle behavior

A graceful window close or Vault switch uses the existing close/flush boundary
and waits for optimistic keyboard insertions to settle. If authority is still
unknown, the close or switch is canceled and the persistent recovery message
remains visible. A session unmount must not orphan its queue item or recovery
payload while another session for the same Vault remains active.

A renderer crash, process kill, power loss, or operating-system forced
termination can still lose an in-memory provisional payload. Guaranteeing
recovery across those events requires a persistent outbox, which is explicitly
outside this design. The UI must not claim that a provisional row is saved
before authoritative settlement.

## Rendering boundary

The optimistic render must not publish a replacement shared workspace. The
owner `NotesOutlinePane` receives one descriptor per pending keyboard
insertion and splices only the affected optimistic suffix into its
already-computed visible rows. A single Enter adds one source/new-row pair;
rapid dependent Enters append their small ordered descriptors without
reprojecting the shared workspace.

Existing rows retain their keys and memoized editor props. The provisional row
uses the final expected node ID from its first render. Authoritative settlement
therefore changes its status/data source rather than unmounting and remounting
the focused editor.

If a provisional placement cannot be derived from the current owner snapshot,
the command falls back to the existing authoritative path. Correctness wins
over optimism.

## Verification

### Deterministic tests

Add failing tests before production changes for:

- clean split and first-child mount and focus before the repository promise
  resolves, in both panes;
- dirty split shows prefix/suffix immediately and serializes draft then split;
- 50 unchanged visible editors do not commit during provisional insertion;
- success adopts the same row/editor identity without a second focus request;
- rapid dependent Enters preserve UI and repository order;
- typing into a provisional row is flushed only after its create/split commits;
- definite failure restores the exact pre-command source, selection, focus,
  visible order, and history state;
- failure after provisional typing preserves the recovery payload and exposes
  the cause plus `Retry`;
- a failed dependency cancels and rolls back its optimistic suffix;
- unknown outcome never rolls back before authority recovery;
- authority recovery distinguishes committed from not committed;
- optimistic Undo before start, during execution, after commit, and during
  unknown outcome follows the defined branches;
- graceful pane/window close, Vault switch, unmount, read-only mode, IME
  composition, and interaction-epoch invalidation leave no orphan provisional
  row or silently discarded recovery payload.

### Desktop benchmark

Use the preserved isolated fixture:

- 5,000 total text nodes;
- 50 visible rows;
- primary and secondary panes;
- clean split, dirty split, and clean first-child;
- 10 warm-ups and 50 measured physical interactions per scenario.

Record separately:

- keydown to provisional caret;
- keydown to authoritative settlement;
- provisional duration;
- failure/rollback and unknown-recovery duration.

Acceptance requires:

- every applicable sample count is 50;
- `p95(keydown → provisional caret) <= 16 ms`;
- the source/new-row presentation is correct before IPC completion;
- success produces no focus reset or row remount;
- exact physical Undo restores the fixture;
- no late focus, queue, recovery, or presentation work appears after 650 ms.

Wall-clock thresholds remain desktop acceptance evidence rather than jsdom
assertions.

## Delivery boundary

Implement only after a separate implementation plan is approved. Use TDD and
retain the current isolated benchmark artifacts until the optimistic path
passes the full desktop contract. Do not add a general store, custom frame
scheduler, persistent outbox, or native schema change.

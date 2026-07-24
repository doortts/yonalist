# Notes Split View Queued Input Performance Design

## Contract

| Field | Decision |
| --- | --- |
| Goal | With split view open, caret navigation, Enter, and held Backspace respond immediately while every user-initiated Notes write is serialized through a per-Vault asynchronous coordinator. |
| Acceptance | Arrow navigation, Enter, ordinary character deletion, and eligible empty-bullet removal keep up with keyboard repeat in either pane; releasing Backspace stops visible deletion immediately; one held Backspace gesture is one Undo unit; the inactive pane does not block the active pane; normal window close and Vault switch wait for all admitted Notes writes to finish. |
| Non-goals | Persistent outbox recovery after a crash, forced termination or power loss; a single FIFO shared by unrelated Vaults or unrelated subsystems; outline virtualization; new delete semantics for protected, read-only, note-bearing, or attachment-bearing rows; a promise that physical persistence completes within tens of milliseconds. |
| Boundaries | React/textarea input, pane-local navigation state, optimistic outline projection, Notes operation coordination, Tauri IPC mutation receipts, Rust history transactions, SQLite writes, normal window close, and Vault switching. |
| Manual proof | A freshly built and restarted Tauri app with an isolated 5,000-node Vault, 50 visible rows, split view open, and the same interaction runs in both primary and secondary panes. |

## Evidence and root cause

The current `main` does not contain performance merge `923b4454` (`Merge
branch 'perf/notes-outliner-latency'`). Later work retained or rebuilt some
parts, including pane-owned optimistic Enter and keyboard-insertion settlement,
but four measured optimizations from that merge are absent or incomplete:

1. **T1, direct DOM caret movement, is absent.** Ordinary cross-row navigation
   dispatches `focusNode`, renders pane state, then focuses from an effect.
   Keyboard repeat can enqueue more navigation before that round trip settles.
2. **T2, compact mutation receipts, is absent.** Rust mutation results still
   serialize a full workspace even when an incremental delta carries the same
   authoritative change. A 5,000-node Vault therefore pays avoidable
   serialization, transfer, decode, and reconciliation work after writes.
3. **T3, batched derived outline work, is absent.** To-do progress is scanned
   per rendered row instead of being built once per workspace reference.
   Development-only row-render and caret-phase counters used to prove the
   improvement are also missing.
4. **T4, inactive-pane deferral, is absent.** Both pane scopes receive current
   structural slices at urgent priority, so an active-pane structural change
   synchronously reconciles the inactive outline before the active interaction
   can settle.

Backspace repeat has an additional functional block. The keyboard resolver
explicitly consumes or rejects structural Backspace when `KeyboardEvent.repeat`
is true, and the row-level in-flight structural-command guard drops subsequent
structural events. Ordinary character deletion remains browser-native, but the
transition from an empty title to removing the empty bullet cannot repeat.

The existing draft queue is asynchronous, but its default debounce is 300 ms
and its maximum continuous deferral is 2 seconds. Queue admission and an
optimistic screen update can fit within tens of milliseconds; physical
persistence currently takes hundreds of milliseconds in representative runs.
Submitting one persistence command for every repeated Backspace would create a
backlog, so repeated structural deletion must be grouped before persistence.

## Accepted architecture

### 1. Restore the missing performance behavior against current `main`

Port the behavior of T1 through T4 instead of merging the old branch wholesale.
The old branch predates optimistic Enter, data repair, and later Notes
authority work, so its files are references rather than merge targets.

- Restore pane-scoped direct DOM focus for ordinary cross-row caret moves.
  After focus succeeds, reconcile selected/editing state without scheduling a
  second focus request. Retain the reducer focus path as a fallback when the
  target editor is not mounted or the browser refuses focus.
- Restore compact mutation receipts. When a complete incremental delta is
  present, keep the authoritative full workspace inside Rust but omit it from
  the IPC wire. Commands whose frontend contract genuinely reads the full
  workspace must opt in explicitly. Serialization tests must cover both shapes.
- Build To-do progress once per stable node/child reference and use map lookups
  while rendering rows. Restore development-only render and caret-phase probes
  needed by the benchmark; they remain no-ops outside development builds.
- Give the active pane current state and draft slices. Give the inactive split
  pane deferred structural slices so React may coalesce a burst after the
  active pane has committed. Actions are never deferred, and activating a pane
  promotes it before its command runs.

Current pane-owned optimistic Enter and settlement routing remain authoritative.
The restored paths must compose with them rather than reintroducing the earlier
authoritative-result-before-caret behavior.

### 2. Use one per-Vault admission point, not one universal FIFO

Every Notes write is admitted to the existing per-Vault coordination boundary.
This is a single logical entry point built by extending the current workspace
coordinator and draft queue, not a third queue layered over both.

The coordinator classifies operations by semantics:

- **Draft text and marker changes:** coalesce by node and revision so only the
  newest unsaved value is persisted.
- **Structural and history-bearing changes:** preserve user order. Related
  changes from one gesture may be submitted as one atomic batch and one history
  entry.
- **Attachment ingestion and sync prerequisites:** retain their specialized
  workers and ordering constraints, but register their pending promises with
  the same per-Vault drain barrier. Large attachment work must not block an
  unrelated title draft from being admitted.

React callers receive an admission result immediately and do not await SQLite
before updating the screen. The coordinator publishes authoritative settlement
or failure later. A queue item may depend on earlier optimistic node IDs, as
optimistic Enter already does.

### 3. Treat one physical Backspace press as one edit gesture

The first non-repeat Backspace begins a gesture. Repeated Backspace keydowns
belong to that gesture until Backspace keyup. Losing input ownership, window
blur, document hiding, normal close, or Vault switch also closes the gesture so
a missed keyup cannot leave it open.

Within the gesture:

1. Browser-native Backspace deletes title text normally.
2. Draft changes update the optimistic pane immediately and coalesce by node.
   While the gesture is open, its drafts are held by the gesture instead of
   entering the ordinary 300 ms draft-save path. This keeps the eventual text
   changes and row removals in one atomic history entry even when the key is
   held longer than the draft debounce.
3. Once the current row has an empty title and supporting note, no attachments,
   and no protection or read-only constraint, repeated Backspace may apply the
   existing structural removal semantics optimistically.
4. The active pane removes the row immediately, resolves the existing
   deterministic focus fallback, and places the caret at the end of the
   previous surviving title when one exists.
5. Repeating continues from that title. It may delete its text and then remove
   that row when it becomes eligible.
6. The inactive pane receives the same final projection at deferred priority.

The gesture records the starting text, removed rows, structural context, and
final focus. When the gesture closes, the coordinator submits one ordered batch
containing the text changes and eligible row removals. Rust commits the batch
in one transaction and creates one history entry. One Undo therefore restores
all text and bullets removed by that held Backspace and restores the
pre-gesture selection.

No queued task may cause further visible deletion after keyup. Persistence
continues in the background, but all visible optimistic changes have already
been applied before the gesture closes.

### 4. Keep one-shot shortcuts one-shot

Keyboard repeat is enabled only where repetition has a natural continuous
meaning:

- ordinary character insertion and deletion;
- ArrowUp, ArrowDown, and valid cross-bullet ArrowLeft/ArrowRight navigation;
- plain Enter where repeated insertion is already valid;
- eligible empty-bullet Backspace removal.

Commands that should create exactly one structural decision per physical press
continue to suppress repeat: Shift+Enter, Command/Ctrl+Enter, indentation,
move/duplicate/toggle shortcuts, zoom shortcuts, and F6 focus cycling. The
implementation audit must report the final list and call out any intentional
exception.

## Settlement, failure, and Undo

A successful batch replaces the optimistic gesture with the authoritative
delta without remounting the focused editor. A failed batch rolls back the
whole gesture, restores its text, rows, and selection, and shows a retryable
error. It must never leave only part of a held deletion committed.

An ambiguous persistence result enters the existing authority-recovery path.
Further writes pause until the app proves whether the batch committed. Recovery
uses the gesture token/history entry ID so retrying cannot apply the batch
twice.

Undo is serialized behind earlier admitted writes for the same Vault. If the
held-Backspace batch has not settled yet, Undo first closes the gesture and
orders its reversal after the batch; the UI may present the reversal
optimistically, but persistence order remains batch then Undo.

Protected, plugin-owned, read-only, note-bearing, and attachment-bearing rows
retain their existing guards or confirmation behavior. Holding Backspace must
not bypass them.

## Drain behavior

Normal window close and Vault switch use a strict drain barrier:

1. enter a draining state that blocks new user commands for the departing
   Vault;
2. close any active keyboard gesture;
3. flush all debounced drafts immediately;
4. wait for structural batches, drafts, attachment prerequisites, and required
   sync export work;
5. close the window or activate the next Vault only after success.

The current fixed three-second best-effort close is not sufficient for this
path. On drain failure, the app remains open or stays on the current Vault,
shows the error, and offers retry. Forced process termination, a renderer
crash, and power loss remain outside the contract and may lose memory-only
queued work.

## Verification

### Focused regressions

Add failing tests before production changes for:

- direct DOM caret focus followed by state reconciliation without a second
  focus request, including reducer fallback;
- active-pane urgent rendering and inactive-pane deferred convergence;
- one To-do progress build per stable workspace reference;
- delta-complete mutation receipts omitting the full workspace and explicit
  full-workspace exceptions retaining it;
- repeated Backspace crossing text, one empty bullet, and several empty
  bullets;
- immediate stop on keyup with no post-keyup visible deletion;
- protection of note-bearing, attachment-bearing, read-only, and plugin-owned
  rows;
- one held gesture producing one history entry and one Undo restoring every
  deleted row, text value, and the starting selection;
- rollback of the entire gesture on failure and idempotent recovery after an
  ambiguous result;
- draft coalescing, ordered structural batches, and drain barriers;
- normal close and Vault switch waiting for success and remaining in place on
  failure.

### Fresh desktop benchmark

Use an isolated Vault with 5,000 total nodes and 50 visible rows. For each pane,
run 10 warm-ups followed by 50 measured interactions:

1. ArrowUp/ArrowDown navigation;
2. clean and dirty split Enter;
3. held Backspace deleting text and crossing at least five eligible empty
   bullets;
4. keyup immediately after a structural deletion;
5. Undo of the held-Backspace gesture.

Record p50 and p95 separately for visible response and authoritative
settlement. The UI gates are:

- Arrow navigation `keydown -> DOM focus` p95 at or below 32 ms in both panes;
- Enter `keydown -> provisional caret` p95 at or below 35 ms in both panes;
- each repeated Backspace visible transition p95 at or below 35 ms;
- zero visible deletions after keyup;
- zero inactive-pane commits for caret-only movement;
- inactive structural projection converges after the owner-pane commit;
- all 50 interactions and Undo operations settle with no command, focus,
  history, or rendering backlog.

These are UI-response targets, not persistence-duration promises. Record
physical settlement times without failing merely because they exceed tens of
milliseconds.

### Final gates

Because compact receipts and atomic Backspace history cross the native
persistence boundary, run the frontend gates plus Rust tests and formatting
after the diff is frozen:

- `npm test`
- `npm run lint`
- `npm run build`
- `cargo test --manifest-path src-tauri/Cargo.toml`
- Rust formatting check
- `git diff --check`

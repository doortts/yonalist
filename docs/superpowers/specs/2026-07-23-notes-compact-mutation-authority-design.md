# Notes Compact Mutation Authority Design

## Status and relationship

This document fixes the approved second phase of Notes Enter latency work. It
follows `2026-07-23-notes-enter-critical-path-design.md`, which removes
frontend layout and rerender amplification after an authoritative result.

The two designs have separate acceptance evidence and can be reverted
independently. This design does not weaken the no-optimism rule established by
the frontend design.

## Goal

Stop routine active-outline text mutations from serializing, transferring,
normalizing, and rerendering the entire Notes workspace.

The coordinator remains the sole owner of confirmed Notes authority. A compact
mutation may patch that authority only when an opaque backend token proves that
the delta starts from the coordinator's exact confirmed version. Every
ambiguous result converges through one authoritative reload and is never
automatically replayed.

## Evidence and root cause

Current mutation transactions reload and return the whole workspace. In an
in-memory Rust debug benchmark using seven-sample medians:

| Text nodes | Serialized workspace | Full load | Serialize | Text update | Child create | Split |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 50 | 20,367 B | 0.267 ms | 0.655 ms | 0.683 ms | 0.767 ms | 1.205 ms |
| 500 | 204,320 B | 2.244 ms | 6.588 ms | 2.819 ms | 3.142 ms | 3.948 ms |
| 5,000 | 2,052,844 B | 21.933 ms | 66.850 ms | 24.802 ms | 28.157 ms | 31.794 ms |

A dirty Enter at 5,000 nodes currently sends approximately 4.1 MB of workspace
JSON across two calls. Native mutation plus serialization alone measured about
190 ms for dirty split and 187 ms for dirty first-child before IPC and frontend
work.

These figures are diagnostic rather than production service-level targets.
They show that the mutation result scales with total Vault size even when one
or a few nodes changed. A render cache cannot remove this backend full load,
serialization, IPC payload, or repeated frontend normalization.

## Scope

The initial compact path is deliberately narrow:

| Eligible compact operation | Eligible view/data |
| --- | --- |
| Text-node split | Active or All; text-only source and result |
| First-child text creation | Active or All; attachment-free insertion |
| Text-node update | Active or All; attachment-free text update |

Tags, Recent, Archive, Trash, attachment mutation, attachment-bearing
operations, Undo, and Redo continue to use the existing full-result commands
until separate parity evidence exists.

The old full API remains available. Compact commands and the versioned load are
additive, so unsupported callers and disabled compact operations keep their
current behavior.

## Authority model

```ts
interface NotesActiveAuthority {
  workspaceToken: string | null;
  normalizedActiveStore: NotesAuthorityStore;
}

interface NotesAuthorityStore {
  nodesById: ReadonlyMap<NoteId, NoteNode>;
  rootIds: readonly NoteId[];
  childIdsByParent: ReadonlyMap<NoteId, readonly NoteId[]>;
  attachmentsByNodeId: ReadonlyMap<NoteId, readonly NoteAttachment[]>;
}

interface NotesSessionProjection {
  scope: NotesWorkspaceScope;
  normalizedStore: NotesAuthorityStore;
}

interface NotesAuthorityOrderSplice {
  parentId: NoteId | null;
  index: number;
  deleteCount: number;
  expectedRemovedIds: NoteId[];
  insertedIds: NoteId[];
  beforeId: NoteId | null;
  afterId: NoteId | null;
}

interface NotesAuthorityDelta {
  upsertedNodes: NoteNode[];
  removedNodeIds: NoteId[];
  orderSplices: NotesAuthorityOrderSplice[];
}

type NotesMutationHistoryReceipt =
  | { kind: "none" }
  | { kind: "recorded"; entryId: string }
  | { kind: "coalescedAway"; requestedEntryId: string };

type NotesAuthoritativeResult =
  | {
      kind: "full";
      workspace: NotesWorkspace;
      workspaceToken: string;
      history: NotesHistoryState;
      historyReceipt: NotesMutationHistoryReceipt;
    }
  | {
      kind: "delta";
      baseToken: string;
      workspaceToken: string;
      delta: NotesAuthorityDelta;
      history: NotesHistoryState;
      historyReceipt: NotesMutationHistoryReceipt;
    };

type NotesCompactCommandResult =
  | NotesAuthoritativeResult
  | {
      kind: "rejected";
      commitDisposition: "notCommitted";
      reason:
        | "precommit"
        | "staleHistoryEpoch"
        | "authorityRefreshRequired";
      error: NotesStructuredError;
    };

interface NotesVersionedLoadRequest {
  sessionId: string;
}

interface NotesRecoveryEvidenceRequest {
  sessionId: string;
  expectedHistoryEpoch: string;
  expectedEntryId: string;
  entryWasAlreadyAppliedAtDispatch: boolean;
}

type NotesHistoryReceipt =
  | { status: "applied" }
  | { status: "undone" }
  | { status: "missing" }
  | { status: "epochMismatch"; currentEpoch: string };
```

The coordinator keeps one `NotesActiveAuthority` for compact mutation and
separate `NotesSessionProjection` values for open scopes. `NotesAuthorityStore`
contains normalized nodes, parent/child order, root order, and attachment
indexes. A versioned Active load builds it once. A valid compact result patches
only the affected records and order lists while preserving unchanged
identities for frontend memoization.

Archive, Trash, Tags, and Recent full results replace only their matching
session projection; they are never installed as the Active compact authority.
An unversioned full mutation result invalidates the Active token by setting it
to `null`. A later compact command always reloads the versioned Active
authority first.

A phase-one `NotesAuthorityDelta` contains:

- every inserted or updated text node;
- every removed node ID, even though the initial three commands normally
  remove none;
- validated `orderSplices` for changed membership/order, using
  `parentId: null` for root order;
- every additional node/order change caused by sort-key rebalance.

An order splice sends only inserted/removed IDs plus its exact-base index and
neighbor anchors. The coordinator applies it only after token equality and
validates index, removed IDs, and before/after anchors against the normalized
base. A compact result never sends every child ID merely because one child was
inserted. Sort-key-only rebalance changes travel in `upsertedNodes`; if a
transaction cannot express its order change as validated splices, it returns
the same-call full result.

Attachment additions/removals are not valid in a phase-one compact delta. The
current history delta does not describe removed attachment IDs completely, so
attachment compactness cannot be inferred safely.

The top-level `history` and `historyReceipt` fields in
`NotesAuthoritativeResult` are the sole history source and operation receipt
for both full and delta results. `NotesAuthorityDelta` does not contain a
second history copy.

- A load that performs no mutation returns `{ kind: "none" }`.
- Split and child creation return `{ kind: "recorded", entryId }` with the
  exact caller-provided entry ID.
- A text update normally returns `recorded`, but may return
  `{ kind: "coalescedAway", requestedEntryId }` when coalescing cancels its net
  history delta. In that case the current history state must return to the
  cancelled entry's recorded predecessor rather than naming the cancelled
  entry.

This preserves the existing `X → Y → X` coalescing behavior.

## Workspace token contract

`workspaceToken` is an opaque equality token, not a gapless commit number, a
clock, or compare-and-swap authorization.

- The frontend may compare tokens only for exact equality.
- A successful commit that changes `main.notes_nodes` or
  `main.notes_attachments` publishes exactly one new token, regardless of how
  many rows a rebalance or sync merge touches.
- The same commit tracker covers ordinary mutations, synchronization, Undo,
  Redo, and implicit transactions made through the managed connection.
- A rollback publishes no new authority token. An abandoned transaction-local
  candidate may make the internal sequence skip a value, which is harmless
  because clients never interpret token order.
- Opening or replacing a database connection changes the connection
  incarnation, so a token from the old connection cannot equal one from the
  new connection.
- The frontend never parses, increments, orders, or manufactures a token.

A versioned full load requires `NotesVersionedLoadRequest.sessionId` and reads
the Active workspace, token, and that session's current history state from one
connection-owned lock/snapshot. It must not pair a workspace from one moment
with a token or history state from another session or moment.

A compact mutation acquires the same connection authority and:

1. records `baseToken` immediately before its mutation;
2. applies and commits the existing transaction/history operation;
3. records the new `workspaceToken`; and
4. returns only the complete changed set plus the top-level exact history entry
   receipt and current history state.

The connection lock remains held until the committed delta, token, and history
result have been frozen for the response. Another writer may not interleave
between commit and changed-row capture. Existing database identity detection
invalidates the connection incarnation if the database is externally
replaced.

The backend does not reject a stale caller token and the request does not use a
token as CAS. If another session changed the Vault first, the mutation may
still succeed. The returned `baseToken` tells the coordinator whether it can
apply the delta to its exact local base.

A legacy or unversioned full result sets the coordinator token to `null`.
Before another compact command can run, the coordinator must obtain a
versioned full load. It must never attach the previous token to a newly
received unversioned workspace.

## Backend compact path

An eligible compact command preserves the existing command validation,
transaction, history, synchronization, and sort-key semantics. Its success
path does not call the full workspace loader.

Compact eligibility is checked from authoritative data after acquiring the
connection lock and before mutation. If the operation is no longer eligible,
the same IPC call executes the existing full-result mutation exactly once and
returns a versioned `kind: "full"` result. The client never responds to
ineligibility by resending the mutation through a legacy command.

Only a backend path that has verified rollback/no commit may return
`{ kind: "rejected", commitDisposition: "notCommitted" }`. A Tauri invoke
rejection, a decode failure, an error string, or any failure raised after the
commit boundary is not evidence of rollback and is treated as
`outcomeUnknown`.

Instead, the repository transaction records all touched IDs and parent order
domains, queries the committed forms needed for those records, and returns a
complete delta. A sort-key rebalance expands the delta to every row whose key
or position changed. Payload size therefore scales with changed rows, not with
all rows in the Vault.

Full-result commands retain the current full loader. This creates a safe
fallback and allows compact support to be introduced one command at a time.

## Coordinator data flow

The Notes workspace coordinator is the only component allowed to compare
tokens, apply compact deltas, replace confirmed authority, or start recovery.
Hooks and rows submit commands and consume projections; they do not merge
authoritative data independently.

```text
eligible command
  └── compact backend mutation
        ├── records backend base token
        ├── commits existing transaction/history
        └── returns base token + new token + complete delta
                    ↓
coordinator compares current confirmed token
  ├── exact match → validate and atomically patch normalized authority
  └── mismatch    → discard delta and single-flight versioned reload
                    ↓
accepted projection
  └── existing Enter intent settles and focuses expected node
```

Applying a valid delta and its history state is one coordinator transition.
Validation has two ordered gates:

1. the operation-identity gate requires either a `recorded` receipt with the
   expected entry ID and `nextUndoEntryId`, or a valid `coalescedAway` receipt
   with the expected requested ID and that cancelled entry's recorded
   predecessor as `nextUndoEntryId`; it also requires the expected history
   epoch. Failure means the success envelope cannot be trusted and becomes
   `outcomeUnknown`;
2. only after identity is proven does the workspace gate validate IDs, parent
   relationships, order splices, command scope, token fields, and delta
   semantics.

A partially valid delta is never partially applied. On normal acceptance, the
coordinator uses only the compact envelope's workspace delta and history.

On base mismatch, semantic validation failure, or `outcomeUnknown`, the entire
compact envelope—including its history—is discarded. The reload's workspace,
token, receipt, and history are then accepted together; fields from the compact
response and reload are never mixed.

Only a `committedAndCurrent` structural settlement with
`uiIntentStillCurrent` publishes a focus-eligible
`KeyboardInsertionSettlement` token defined by the frontend critical-path
design. The recovery record retains pane, session, intent token, and
interaction epoch until atomic settlement/cancellation. If the database result
is current but later user interaction made the UI intent stale, the coordinator
accepts authority and publishes only the zero-motion command identity with
`focusEligible: false`. A committed-but-superseded or failed recovery cancels
the UI intent.

Queue settlement represents `full | delta` directly. Commands and history
refer to the coordinator's normalized authority rather than rebuilding a
complete workspace array. On compact success there are zero `Object.values`
full-store reconstructions and zero calls to full-workspace normalization.
Text updates schedule the same tag-summary invalidation/refresh as the existing
full-result path.

## Recovery and failure semantics

Transport and result-decoding failures after dispatch have
`outcomeUnknown` status. The coordinator cannot know whether the database
committed, so it must not retry the mutation.

A typed `kind: "rejected"` result with
`commitDisposition: "notCommitted"` is the only backend failure that proves no
commit. Existing promise rejection categories or error messages are never
promoted to that status by the frontend.

`reason: "precommit"` ends the command without recovery.
`staleHistoryEpoch` and `authorityRefreshRequired` also prove no commit, but
they start a versioned Active reload so the coordinator installs the new token,
history epoch, and authority before accepting later commands. The rejected
command and its UI intent end without automatic replay.

Recovery distinguishes two causes:

- `knownCommittedMismatch`: a syntactically valid success result proves that
  the mutation committed by passing the operation-identity gate, but its
  `baseToken` differs from local authority or its workspace delta fails
  semantic validation;
- `outcomeUnknown`: transport or decoding failed before a trustworthy success
  result was accepted, or the operation-identity/history gate failed.

Both start a generation-scoped, single-flight versioned Active reload for that
Vault. Concurrent callers share that reload. Session/Vault generation guards
prevent its result from being applied to a newly selected Vault or view.

The coordinator queue permits at most one dispatched-but-unsettled mutation per
Vault. Later mutations remain undispatched behind it, so a recovery flight has
exactly one `NotesRecoveryEvidenceRequest`; other waiting readers may share the
same authority reload but require no separate mutation receipt. This invariant
prevents a single-entry receipt request from being used to reconcile multiple
operations.

A recovery load accepts `NotesRecoveryEvidenceRequest` and returns the
workspace, token, current history state, and `NotesHistoryReceipt` from the
same connection lock. `applied` means the expected entry is in the applied
history lineage; `undone` means it committed and was subsequently undone;
`missing` means the same history epoch has no such entry; and `epochMismatch`
means reconnect/reset removed the ability to prove the old entry from history.

For structural Enter recovery, the reload checks:

- whether the preallocated expected ID exists;
- its required parent and order;
- the source prefix/suffix for a split;
- the expected empty first-child content for child creation; and
- the corresponding history entry/state.

For a text update, it checks the expected persisted text and history state.
Because coalesced text bursts may reuse an entry ID that was already applied
before this dispatch, `entryWasAlreadyAppliedAtDispatch: true` prevents that
older receipt from proving the current attempt.

For `knownCommittedMismatch`, the coordinator always adopts the reloaded
authority and classifies the original command as:

- `committedAndCurrent` when the known commit and target postconditions still
  match; or
- `committedButSuperseded` when commit is known but a later move, archive,
  deletion, edit, or Undo changed the target.

Only `committedAndCurrent && uiIntentStillCurrent` may publish a
focus-eligible settlement. A stale interaction epoch accepts the database
state and keeps the Enter zero-motion marker, but cancels pending focus.
`committedButSuperseded` ends the insertion intent without focus and must not
be mistaken for failure of the original commit.

For `outcomeUnknown`, the receipt and postconditions classify the outcome:

- a matching structural expected ID plus an `applied` receipt is
  `committedAndCurrent`;
- matching text plus an `applied` receipt is `committedAndCurrent` only when
  its entry was not already applied at dispatch;
- an outcome-unknown text attempt that reused an already-applied entry is
  always `indeterminate`, even when the text and receipt currently match;
- an `applied` receipt with changed postconditions or an `undone` receipt is
  `committedButSuperseded`;
- `missing` in the unchanged expected epoch together with absent
  postconditions is `notProvenCommitted`; and
- conflicting evidence or `epochMismatch` is `indeterminate`.

`notProvenCommitted` is a failed command, not proof that a commit never
occurred; only the typed precommit result carries `notCommitted`. Both
`notProvenCommitted` and `indeterminate` adopt the reloaded authority, never
replay the mutation, clear the insertion intent, and report the failure.
`indeterminate` additionally tells the user that the final database state was
restored but the original command outcome could not be proven. On
`epochMismatch`, the coordinator installs the backend's reset history state and
tells the user that the previous Undo chain is unavailable.

If a dirty Enter draft save enters recovery, its structural command remains
behind the barrier. It may continue only after the draft update is
`committedAndCurrent`. Typed `notCommitted`,
`committedButSuperseded`, `notProvenCommitted`, `indeterminate`, or hard
recovery ends that Enter sequence without issuing the structural mutation.

If reload itself fails:

- retain the last confirmed values and all local drafts;
- suspend new saves, structural commands, Undo, and Redo for that Vault;
- finish the current command as `recoveryBlocked` so row busy state clears;
- settle every queued-but-undispatched mutation—including structural commands,
  autosave, and history replay—as unexecuted `skipped/retryable`;
- pause, but do not discard, pending draft timers;
- cancel all motion/focus intents while retaining a separate operation recovery
  record;
- expose a visible recovery state and retry action;
- mark the affected Notes region `aria-busy`; and
- announce a hard recovery failure with `role="alert"`.

No draft is silently deleted or rolled back. Recovery may continue for the old
Vault after navigation, but its intent is cleared and its state cannot be
applied to the new view. A successful user-initiated recovery retry rearms one
deduplicated draft timer only for drafts whose saves were queued but never
dispatched and settled `skipped/retryable`. A draft from a dispatched ambiguous
save remains `manualRetryRequired` until a new user edit or explicit save retry;
it is never timer-replayed. Newly submitted commands are then permitted.
Skipped structural/history commands are not replayed, recovery/read operations
are the only queue work allowed while locked, and recovered operations never
auto-focus.

| Condition | Database interpretation | Required client result |
| --- | --- | --- |
| UUID/local preflight failure | No mutation dispatched | Cancel intent; preserve original caret. |
| Draft save typed `notCommitted/precommit` | Structural command not attempted | Keep draft retryable. |
| Typed backend `notCommitted/precommit` | No committed change | Cancel intent; retain source focus only if interaction epoch is current. |
| Typed `notCommitted/staleHistoryEpoch` or `authorityRefreshRequired` | No committed change; local authority is stale | End intent; versioned reload; never replay the rejected command. |
| Identity-proven success with token mismatch or invalid workspace delta | Mutation committed; local base/result cannot be patched | Discard delta; reload; adopt authority; focus only if exact target postconditions remain. |
| IPC or undecodable result | Outcome unknown | Reload with history receipt; never replay. |
| Recovery returns `committedAndCurrent` | Mutation committed and target current | Settle exact intent; focus target. |
| Recovery returns `committedButSuperseded` | Mutation committed, later state won | Adopt authority; cancel intent; no focus or replay. |
| Recovery returns `notProvenCommitted` | Commit cannot be proven | Fail without retry; do not claim rollback. |
| Unknown-outcome evidence conflicts or epoch changed | Outcome indeterminate | Adopt authority, reset history when required, clear intent, notify; never replay. |
| Reload fails | Authority cannot be refreshed | End current/queued commands, preserve state/drafts, and lock Vault writes pending retry. |
| Vault/session switches | Old recovery is generation-scoped | Do not apply old state or focus to new view. |

## Undo and history contract

This phase preserves current Undo granularity:

- clean Enter creates one structural history entry;
- dirty Enter normally creates one text-update entry, then one structural
  entry;
- if its draft flush validly returns `coalescedAway`, the cancelled text entry
  leaves no retained Undo step and only the structural entry remains;
- the first Undo after dirty Enter removes the inserted row;
- the second Undo restores the prior text only when a text entry remains; and
- Redo preserves the corresponding order.

For `coalescedAway`, “prior next-Undo entry” means the predecessor of the
cancelled coalesced entry, not that cancelled entry itself.

Compact mutation results expose the current history state but do not introduce
a new history operation. A recovery full load reads workspace, token, and
history receipt/state in the same coordinator queue and creates no history
entry. Reconnect may legitimately produce `epochMismatch`; in that case the
reloaded database remains authoritative but the lost connection-local Undo
lineage is reset and disclosed rather than reconstructed speculatively.

Undo and Redo themselves remain full-result commands in this phase. They still
change the workspace token, which forces later compact commands to start from
the new confirmed version.

## Validation

### Backend and coordinator tests

Prove that:

- a versioned load returns workspace, token, and history from the same locked
  point;
- each successful dirty commit changes the token exactly once for nodes,
  attachments, synchronization, Undo, and Redo;
- rollback publishes no token, abandoned candidates may leave harmless gaps,
  and reconnect changes the incarnation;
- a `kind: "delta"` JSON result contains no full `workspace`;
- applying `full(base) + delta` exactly equals a fresh full reload, including
  anchored order-splice validation and sort-key rebalance;
- the same local mutation in 1,000-node and 10,000-node fixtures differs in
  payload size by no more than 10 percent when the touched rows are identical;
- insertion among 10,000 root siblings with an available sort-key gap sends one
  anchored order splice rather than 10,001 root IDs;
- a shared-session token mismatch produces exactly one versioned reload;
- a known-committed mismatch adopts the reload even if a later operation
  removed the expected row;
- typed `notCommitted` is accepted only from the explicit rollback-proven
  result, while invoke rejection/decoding failure becomes `outcomeUnknown`;
- typed stale-epoch/refresh-required rejection performs one versioned reload
  and zero retries before later commands can proceed;
- history entry/epoch/coherence failure becomes `outcomeUnknown`, whereas
  token/delta failure after that identity gate is `knownCommittedMismatch`;
- IPC/rejection/invalid-result recovery invokes the mutation zero additional
  times and discards all compact-result history before accepting reload
  history;
- `applied`, `undone`, `missing`, and `epochMismatch` receipts produce the
  specified current, superseded, not-proven, or indeterminate outcomes;
- an outcome-unknown text save that reused an already-applied coalesced entry
  remains indeterminate and never releases a dirty Enter structural barrier;
- reload failure clears busy state, settles every queued mutation as
  skipped/retryable, pauses draft timers, preserves confirmed state/drafts,
  allows only recovery/read work, and locks writes/history;
- recovery success rearms only never-dispatched drafts; a dispatched ambiguous
  draft remains manual-retry-required until new input or explicit retry;
- the per-Vault queue has one dispatched unsettled mutation, and all other
  callers share authority recovery without requiring another receipt;
- a later interaction epoch accepts committed authority and suppresses Enter
  motion without moving focus;
- filtered views and attachment-bearing operations use the full path;
- an under-lock compact eligibility change executes one full mutation in the
  same call with no client resend;
- compact success performs zero full-store reconstruction/normalization calls
  and schedules tag-summary refresh; and
- a legacy full result clears the token and requires a versioned reload before
  compact mutation.

### History tests

Prove one structural history entry for clean Enter, two distinct entries for
ordinary dirty Enter, the two-step Undo semantics, Redo equivalence, no
recovery-created history entry, exact recorded receipt/`nextUndoEntryId`
validation, `coalescedAway` `X → Y → X` restoration to the cancelled entry's
predecessor with one structural Undo step, same-session versioned loads,
reused-entry outcome uncertainty, reconnect `epochMismatch`
reset/disclosure, and correct behavior when two sessions share one Vault.

### Desktop measurement

Use the same isolated 5,000-total-node, 50-visible-row Vault and freshly rebuilt
and restarted Tauri application defined by the frontend critical-path design.
For clean split, dirty split, and dirty first-child:

- run 10 warm-ups and 50 measured runs;
- record p50/p95 for keydown, draft barrier, IPC, coordinator acceptance, DOM
  commit, focus, and next paint;
- verify compact payload size and full-fallback count; and
- reuse the frontend design's 20 non-repeat keydown/keyup protocol and verify
  no command, focus, animation, or baseline backlog after the final deadline.

After this phase, each scenario must satisfy
`p95(focusMark - keydownMark) <= 50 ms` using the same renderer clock. This is
a measured decision gate on the representative desktop fixture, not an
absolute timing assertion in CI.

Manual proof covers contextual child, leaf sibling, middle-title split, dirty
Enter, rapid Enter, Undo/Redo, two windows sharing one Vault, sync races,
injected IPC/recovery failures, and VoiceOver announcement/focus order.

## Rollout and rollback

Deliver the compact path in independently provable stages:

1. add connection-incarnated tokens and versioned full load;
2. make the coordinator own normalized full/delta authority and recovery;
3. enable compact text split;
4. prove full/delta and history parity;
5. enable compact first-child creation;
6. enable compact attachment-free text update; and
7. rerun the representative desktop measurements.

Every compact command requires parity, history equivalence, changed-row-scaled
payload, no automatic retry, and a working full fallback before enablement.

A well-formed `baseToken` mismatch is expected shared-session concurrency: the
coordinator reloads and may resume compact operation from the new confirmed
token. A malformed token, invalid delta, or full/delta parity mismatch disables
that compact command for the current application session, performs the single
authoritative reload, and routes subsequent operations through the existing
full-result command. Other compact commands remain enabled only if their own
evidence is intact.

Phase B delivery runs focused and owning frontend tests, the frontend test,
lint, build, architecture and diff checks, the full Rust test suite, Rust
formatting checks, and the fresh desktop proof. Existing user-owned worktree
edits must be preserved.

## Conditional Phase C

Only if any of the three representative Enter scenarios remains above 50 ms
p95 after Phase B may a later design combine dirty draft save and structural
Enter into one IPC request.

That future request must still execute two backend transactions with distinct
text and structural history identities. It normally retains two entries, while
preserving the existing `coalescedAway` exception that may leave only the
structural entry. If text commits and structure fails, it must return a typed
partial result. All existing draft, IME, image-atom, and command-order barriers
remain. Phase C requires a separate approved specification and plan; it is not
part of this implementation.

## Non-goals

- Optimistic rows or speculative authoritative state.
- Treating the token as CAS, a timestamp, or a gapless revision.
- Automatic mutation retry after an ambiguous outcome.
- Compact attachments, filtered views, Archive, Trash, Undo, or Redo.
- A general query/render cache.
- Combining dirty Enter into one IPC call before the measured Phase C gate.
- Changing sync, persistence, or history semantics.

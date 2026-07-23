# Notes Enter Critical Path Design

## Status and relationship

This document fixes the approved frontend contract for making outline `Enter`
feel immediate without creating optimistic rows.

It is the first of two related designs:

1. this design removes avoidable layout work, animation, and unrelated editor
   rerenders after persistence returns;
2. `2026-07-23-notes-compact-mutation-authority-design.md` reduces the
   persistence and IPC cost that occurs before this design's render path.

The second design is not required to implement or verify this frontend phase.

## Goal

Make clean split, dirty split, and dirty first-child `Enter` respond like a
direct keyboard action:

- keep the existing authoritative persistence and history semantics;
- render and focus only after the authoritative command result is accepted;
- perform no Enter-owned FLIP measurement or animation;
- prevent unchanged heavy editors from rerendering; and
- leave drag, collapse, expand, and other intentional motion eligible outside
  the explicitly defined overlap window.

## Confirmed behavior

This performance work does not change the contextual Enter rules:

| Input | Structural result |
| --- | --- |
| A text row has children and the collapsed caret is at the title end | Create and focus a new empty first child. |
| A text row has no children and the collapsed caret is at the title end | Split to the next sibling using the current split semantics. |
| The caret is in the middle of a text title or the title has a selection | Preserve current prefix/suffix split semantics. |
| Image row, modified Enter, IME composition, read-only state, repeat, or an in-flight structural command | Preserve the current guards and behavior. |

The new row and all rows displaced by Enter appear in their final positions
without a transition. Other commands retain their current motion policy when
they do not overlap an Enter settlement or its missing-baseline safety window.

## Evidence and root cause

The measured frontend path currently multiplies one logical insertion into
work for nearly every visible row.

For 50 visible rows becoming 51, three independent development/jsdom runs
using a deterministic 30 ms delay per repository call produced these medians:

| Scenario | Repository calls | Row commits | Rectangle reads | Animations | Focus reached | Longest motion tail |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Clean split | 1 | 156 | 103 | 47 | 203.53 ms | 380 ms |
| Dirty split | 2 | 206 | 103 | 47 | 292.97 ms | 380 ms |
| Dirty first child | 2 | 206 | 103 | 49 | 287.90 ms | 380 ms |
| Dirty split, reduced motion | 2 | 206 | 103 | 0 | 292.62 ms | 0 ms |
| Dirty first child, reduced motion | 2 | 206 | 103 | 0 | 289.75 ms | 0 ms |

These absolute times are comparison data, not production service-level
targets. They show three independent causes:

1. `useOutlineLayoutMotion` captures layout even when the eventual transition
   should be skipped. `outlineLayoutMotion` reads the root, row, and main
   rectangles and can keep shifted rows moving after the inserted row appears.
2. `OutlineNodeRow` consumes broad workspace state, while the visible
   projection is derived from the whole state. One authoritative result
   therefore causes every visible row to participate in multiple commits.
3. focus is correctly delayed until authoritative state contains the target,
   but unrelated rerenders and layout work extend the interval between that
   state transition and DOM focus.

The reduced-motion runs remove the visible tail but not the 103 synchronous
rectangle reads or the broad rerender cost. Animation is therefore a
significant symptom, but it is not the only cause.

## Accepted approach

### 1. Identify an authoritative Enter insertion

Both split and first-child commands preallocate the expected node ID before
dispatch. The child action accepts an optional `newNodeId`, matching the
existing split capability.

```ts
interface KeyboardInsertionIntent {
  token: number;
  ownerSessionGeneration: number;
  sourceId: NoteId;
  expectedNodeId: NoteId;
  kind: "split" | "first-child";
}

interface PendingKeyboardInsertion {
  intent: KeyboardInsertionIntent;
  ownerSessionId: string;
  ownerPaneId: string;
  interactionEpochAtDispatch: number;
  expectedStructuralHistoryEpoch: string;
  expectedStructuralHistoryEntryId: string;
  projectionGenerationAtDispatch: number;
  layoutGenerationAtDispatch: number;
}

interface KeyboardInsertionSettlement {
  intentToken: number;
  expectedNodeId: NoteId;
  ownerSessionId: string;
  ownerPaneId: string;
  ownerSessionGeneration: number;
  interactionEpochAtDispatch: number;
  baseProjectionGeneration: number;
  acceptedProjectionGeneration: number;
  baseLayoutGeneration: number;
  acceptedLayoutGeneration: number;
  focusEligible: boolean;
}
```

Pending insertions live in a registry keyed by `expectedNodeId`; they are not a
single mutable ref. Each entry is additionally scoped by origin pane, session
identity and generation, and unique intent token. The existing per-row
in-flight and key-repeat guards remain the first line of duplicate-command
protection; active drag is part of settlement/layout-generation eligibility.

The command promise resolving successfully does not remove the entry. The
coordinator first accepts the mutation and its history settlement, then
publishes a `KeyboardInsertionSettlement` alongside the resulting projection.
The motion owner consumes the entry only when all of these are true:

- the projection contains `expectedNodeId`;
- it places that node in the relationship required by `kind`;
- the settlement's intent token, pane/session identity, generation, and
  expected ID exactly match the registry entry; and
- no unrelated layout generation or active drag was interleaved.

The coordinator owns both generation counters:

- `projectionGeneration` increments for every accepted projection publication,
  including a dirty-draft settlement and the structural result;
- `layoutGeneration` increments only when visible membership, order, parent,
  depth, collapse state, or measured row geometry changes; and
- every publication is tagged with the command/intent token that caused it.

An exact Enter settlement has the pending entry's base generations, the current
accepted generations, and only same-intent draft/structural publications
between them. The draft publication may advance projection generation but not
layout generation when the editor DOM already represents the same text. Any
layout event not owned by the intent, including a remote projection or active
drag, makes the settlement mixed. These owner tags, rather than arithmetic such
as `accepted === base + 1`, define the exact/mixed predicate.

The hook also compares the visible transition with the permitted Enter diff:
split may change the source text, insert the expected node, and shift order
within its touched parent; first-child may insert the expected node and shift
that parent's order. Any additional visible membership, parent, collapse,
depth, order, or geometry change makes the settlement mixed even when a broad
full result lacks a separate remote owner tag.

Ownership/history proof has priority over current relationship shape. If it
proves that the expected ID was created but a concurrent change moved or
superseded it, use mixed zero-motion and no focus. A bare wrong ID or
relationship without the exact settlement/history proof is an ordinary
mismatch: cancel the intent and retain the normal motion decision.

`interactionEpoch` is pane-local and increments on any later keydown,
`beforeinput`/`input`/`compositionstart`, pointerdown,
selection/focus command, pane switch, or unmount. A matching structural result
is still suppressed from motion when that epoch is stale, but `focusEligible`
is true only when the pane's current epoch equals
`interactionEpochAtDispatch`. The target focus effect repeats this epoch check
immediately before `focus()` and again before acknowledgement rather than
trusting a previously computed boolean. Persistence is accepted without
stealing focus from a newer user action.

An unrelated projection leaves the intent pending. The command's terminal
settlement always ends its ownership: an exact match is consumed, while a
wrong ID/relationship, a committed-but-superseded target, typed failure, hard
recovery, pane unmount, or session/Vault replacement cancels it. Outcome
uncertainty transfers ownership to the recovery record rather than leaving an
unowned registry entry.

An ID belonging to another session or a row-shaped projection without the
exact settlement token never suppresses motion.

This is identification, not optimism. No provisional row or provisional focus
target is inserted into React state. The existing end-of-line
`optimisticSplitInsert`/rollback branch and its now-unused action, reducer, and
type surface are removed before this intent path is enabled.

### 2. Give matching Enter commits a zero-motion path

When the authoritative projection and settlement match a pending keyboard
insertion, the layout-motion owner:

1. cancels active outline layout animations;
2. consumes the matching intent exactly once;
3. performs zero synchronous rectangle capture for that commit;
4. starts zero Web Animations for the inserted or shifted rows; and
5. invalidates the old FLIP baseline.

The zero-read rule includes root, row, and main-content rectangles. It applies
equally when the operating system has reduced motion enabled.

For dirty Enter, the authoritative draft-save settlement that precedes the
structural result is not a layout-motion command when visible structure is
unchanged. It performs no Enter-owned layout capture and does not consume the
pending insertion intent. This keeps the complete keydown-to-focus path at
zero application-owned Enter FLIP reads across both repository calls.

If an unrelated motion-producing command arrives before a new baseline exists,
that one transition is not animated. The hook establishes the latest committed
layout as the next baseline instead of animating from stale coordinates.

If another session changes visible layout or a drag starts between Enter
dispatch and settlement, the transition is mixed rather than an exact Enter
match. The whole mixed settlement uses the same safe zero-motion,
no-stale-baseline path, consumes the motion portion of the original intent, and
rebaselines. Authoritative target focus still proceeds when
`focusEligible: true`; a stale interaction epoch cancels only focus and never
re-enables Enter animation. This preserves the stronger guarantee that
Enter-displaced rows never animate; the overlapping unrelated transition is
the documented exception to retained motion.

The idle maintenance task is not armed at keydown or while IPC is pending. A
matching or mixed settlement first invalidates the baseline; only after its
settled projection's first paint does the policy begin:

1. after input stops, arm one 150 ms quiet timer;
2. at quiet expiry, prefer `requestIdleCallback` with a 500 ms timeout;
3. if the idle API is unavailable, collect the baseline at quiet expiry;
4. new input cancels and rearms the single task for the latest generation; and
5. once input remains quiet, establish exactly one latest-generation baseline
   no later than 650 ms after the later of the newest settled-projection first
   paint or the most recent input that caused a rearm.

The zero-read measurement window is keydown through target focus and its first
paint. A later idle baseline read is maintenance, not an Enter critical-path
read, and there may never be one pending task per prior key.

This trades an active overlapping animation and at most the first unrelated
transition before rebaseline for correct geometry and continuous keyboard
responsiveness.

### 3. Separate the sortable shell from the heavy editor

Each visible row is split at the render boundary:

```text
OutlineSortableShell
├── useSortable
├── transform and root ref
├── small drag handle
└── MemoizedOutlineNodeEditor
```

`OutlineSortableShell` owns DnD registration and the unstable attributes,
listeners, transforms, and refs returned by `useSortable`. None of those
objects is passed to `MemoizedOutlineNodeEditor`.

The heavy editor receives stable primitives for the represented node and a
stable snapshot getter for event-time reads. A changed node, a changed
selection state for that node, or a target-specific focus request may update
it. A sibling's insertion, DnD bookkeeping object identity, or a broad
workspace object replacement may not.

This is the only cache-like optimization in this phase: stable normalized
inputs plus React memoization. A second global cache, query cache, or rendered
DOM cache would add invalidation paths without removing the current broad
subscription and layout reads.

For one structural settlement:

- the DnD shell for a visible row may reconcile at most once; and
- each of the 49 unchanged heavy editors in the 50-row fixture commits zero
  times.

The render-count window starts when the coordinator publishes the accepted
structural projection and ends after the target focus acknowledgement and next
paint. React Profiler commits are the unit: each existing shell may commit at
most once, the new shell/editor mounts once, and unchanged heavy editors commit
zero times. The stable snapshot getter must return the latest coordinator
authority even when that editor did not rerender.

### 4. Keep focus authoritative and target-specific

The current authoritative `pendingFocus` and history behavior remain intact.
Only the intended row receives a focus-request prop. Other rows do not
rerender merely because a global pending-focus object changed.

The target row preserves this order:

1. observe the accepted authoritative node;
2. place DOM focus and the exact caret/selection;
3. acknowledge the exact `requestId` once.

Acknowledgement never precedes successful DOM focus. There is no imperative
optimistic focus channel. On a typed command failure, the insertion intent is
cancelled and the source editor keeps or regains its original caret only when
the interaction epoch is still current; a later user action is never
overridden.

For dirty Enter, the existing draft barrier remains: save the draft first,
then issue the structural command. This phase intentionally retains two
repository calls and normally two history entries. Existing text-history
coalescing may cancel a net-zero draft entry, leaving only the structural Undo
step.

Phase A remains independently safe without compact tokens. After an IPC invoke
has started, a promise rejection or undecodable result is
`outcomeUnknown`—never a typed precommit failure inferred from an error string.
The frontend does not replay it. It performs one generation-scoped,
single-flight full authoritative reload and origin-session `historyStatus`
read inside one coordinator recovery barrier using the existing APIs:

- if the structural expected ID/relationship are current and history epoch,
  expected entry ID, and next-Undo identity all agree, settle the command from
  that authority;
- if workspace state is current but history cannot prove the expected entry,
  adopt the workspace without focus and enter the existing history
  recovery/reset path; never claim that ordinary Undo semantics were restored;
- otherwise adopt the reload, cancel focus/motion intent, and report failure
  without replay;
- if a dirty draft save is uncertain, do not issue the structural command
  after recovery; reconcile its separate text-history context, preserve any
  still-local draft for an explicit later action;
  and
- if reload fails, cancel the UI intent, clear row busy state, retain the
  draft, and enter Vault-wide `authorityUnknown` recovery instead of stealing
  focus later.

While `authorityUnknown`, the Vault blocks saves, structural commands,
Undo/Redo, and draft timers but continues retaining local drafts. Only a
successful authoritative reload/history recovery or Vault replacement releases
that write lock.

The compact authority phase adds tokens and history receipts to distinguish
known-committed, superseded, and indeterminate outcomes more precisely.

## Data flow

```text
keydown
  ├── preserve IME/repeat/read-only/in-flight guards
  ├── preallocate expected node ID
  ├── register session-scoped insertion intent
  ├── flush dirty draft when required
  └── dispatch existing authoritative structural command
          ↓
coordinator accepts mutation/history and tags projection with intent token
  ├── consume matching intent
  ├── cancel animation and skip all Enter FLIP reads
  ├── render target editor; unchanged heavy editors remain memoized
  ├── focus exact target/caret
  └── acknowledge exact focus request
          ↓
cancelable idle/quiet task establishes a fresh motion baseline
```

## Failure and race handling

| Condition | Required result |
| --- | --- |
| UUID allocation or local preflight fails | Do not dispatch; cancel the intent; preserve the original caret. |
| Draft save fails | Do not attempt the structural command; keep the draft retryable. |
| Structural command returns a typed precommit failure | Cancel the intent; restore/retain source focus only if interaction epoch is current. |
| Invoke rejects or result is undecodable after dispatch | Treat as outcome unknown; never replay; single-flight full reload. |
| Command is skipped by an existing guard | Cancel the intent and do not alter motion state. |
| Vault or owning session changes | Clear stale intents; never apply their focus or motion decision to the new view. |
| Terminal settlement has the wrong ID, relationship, or intent token | Cancel the intent; do not mistake row shape for command ownership. |
| Command committed but target was superseded | Adopt current authority; cancel focus/motion intent; never replay. |
| Hard recovery | Cancel focus/motion intent, retain only the operation recovery record, and lock Vault writes/history until recovery. |
| Pane unmount | Cancel focus/motion intent; a later recovery may not auto-focus that pane. |
| Another key/pointer/structural input arrives during idle rebaseline | Cancel and rearm one latest-generation task after quiet; a stale task may not write a baseline. |

The compact authority design strengthens transport recovery but does not change
these terminal intent rules.

## Verification

### Deterministic frontend tests

For clean split, dirty split, and dirty first-child Enter:

- application-owned Enter FLIP rectangle reads: `0`;
- Enter-started animations: `0`;
- unchanged heavy editor commits: `0` for all 49 unchanged rows;
- each DnD shell commits no more than once per structural settlement;
- focus and caret land on the exact expected node;
- the exact focus `requestId` is acknowledged once and only after DOM focus.

Additional tests prove:

- the next Enter cancels a pending idle baseline task;
- stale generation, other-session, wrong-ID, and wrong-relationship intents do
  not suppress motion;
- failure, skipped commands, hard recovery, unmount, terminal mismatch, and
  Vault replacement clear their intents;
- a shared-Vault two-window interleave and an active drag cannot falsely
  consume an Enter intent;
- an ownership-proven moved target uses mixed zero-motion/no-focus, while an
  unproven wrong relationship retains normal motion;
- an untagged additional visible diff in a broad full result is detected as
  mixed;
- a later key, text input, composition, pointer, or focus interaction accepts
  the database result without stealing focus while still suppressing Enter
  motion, including the final pre-focus epoch recheck;
- drag, collapse, expand, and unrelated eligible layout changes retain motion
  outside the documented overlap window;
- an overlapping/mixed settlement and an unrelated command before rebaseline
  safely skip motion and establish only the latest baseline;
- after repeated cancellation, quiet time establishes exactly one
  latest-generation baseline within 650 ms of the later latest-settlement
  paint or last rearming input;
- an IPC delayed beyond 150 ms performs no baseline read before settlement
  first paint, then completes one rebaseline within 650 ms;
- a snapshot getter observes sibling/shared-session authority updates without
  forcing an unchanged editor commit;
- an after-dispatch rejection performs one full reload and zero mutation
  re-invocations;
- recovered Enter verifies the origin history epoch/entry before focus and
  preserves the specified next Undo, otherwise resets/discloses history;
- failed authority recovery blocks save, structure, Undo/Redo, and draft timers
  until a successful recovery or Vault replacement; and
- reduced motion also performs zero Enter rectangle reads.

CI asserts deterministic counts and state transitions. It instruments
application-owned FLIP reads separately from any internal browser or DnD
measurement and does not enforce absolute jsdom timing.

### Desktop measurement

Use an isolated test Vault containing 5,000 total text nodes with 50 visible
rows. Test a freshly rebuilt and restarted Tauri application, use 10 warm-up
runs, then collect 50 measured runs for each scenario.

Record p50 and p95 phase marks for:

- keydown;
- draft barrier start/end when applicable;
- IPC start/end;
- coordinator acceptance;
- target DOM commit;
- focus;
- next paint.

Phase A's acceptance calculation is
`p95(focusMark - ipcEndMark) <= 16 ms`, using marks from the same renderer
clock. It includes coordinator acceptance, React render/commit, and DOM focus;
it is not measured from DOM commit. The overall Enter p95 is recorded as the
baseline for the compact authority phase; its 50 ms gate is not an isolated
Phase A requirement.

Issue 20 discrete non-repeat keydown/keyup pairs, sending each next pair as soon
as authoritative focus reaches the preceding target. After the twentieth
focus, pending insertion/focus/animation counts are zero and at most one
cancelable baseline task exists. With no further input, that task establishes
one current baseline and the total pending-task count reaches zero within
650 ms.

### Manual proof

Verify contextual first-child, leaf sibling, middle-title split, dirty Enter,
rapid Enter, exact caret placement, Undo/Redo, and retained drag/collapse/expand
motion. Repeat with reduced motion and VoiceOver to confirm that visual order,
focus order, and announcements agree.

## Delivery order and gates

1. Remove the end-of-line optimistic split/rollback path and its unused
   action/reducer/type surface.
2. Add the insertion-intent registry, settlement token, and expected-ID child
   creation.
3. Add no-replay full-reload recovery for Phase A outcome uncertainty.
4. Add the matching Enter zero-motion path.
5. Add cancelable idle/quiet baseline rebuilding.
6. Split the sortable shell from the memoized editor.
7. Narrow focus props to the target editor.
8. Run desktop measurements and record the Phase A result.

Before this phase is complete:

- run focused tests, then the owning Notes frontend suites;
- run a fresh desktop smoke test in an isolated Vault;
- run the repository's frontend test, lint, build, architecture, and diff
  checks; and
- avoid Rust gates because this phase changes no Rust code.

Existing user-owned worktree edits must be preserved and reviewed rather than
overwritten.

## Non-goals

- Optimistic or provisional rows.
- Combining dirty draft save and insertion into one IPC call.
- Changing Undo granularity or persistence semantics.
- Compact mutation results or workspace tokens.
- Virtualizing the outline.
- Adding a general-purpose client cache.
- Removing motion from non-overlapping drag, collapse, expand, or other
  non-Enter commands.

# Notes In-Memory Session History and Navigation Design

**Date:** 2026-07-18

**Status:** Approved by the user

## Goal

Make every user-initiated Notes page change participate in the same chronological
Undo/Redo sequence as content edits, while keeping all Undo/Redo state in memory
for the lifetime of the active Vault session.

The final ordering must be observable as one timeline. Given:

```text
edit A -> navigate to B -> edit C
```

Undo performs:

```text
undo edit C -> return from B -> undo edit A
```

Redo performs the exact inverse. Closing the Vault connection or quitting the
app intentionally discards the complete timeline.

## Current State

Notes currently has two coordinated history stores:

1. Persistent `notes_history_entries` and `notes_history_changes` tables in
   `<vault>/.yonalist/notes.sqlite` contain before/after row JSON for content
   mutations.
2. `NotesHistorySession` keeps before/after UI snapshots in a JavaScript `Map`,
   keyed by the backend history entry ID. Those snapshots restore scope, zoom,
   selection, expansion, and focus after a content replay.

The backend history is already session-scoped. A new runtime creates a new
session ID, and today's `notes_initialize` clears old history before exposing
Notes. Persisting history rows therefore adds disk writes without providing an
app-restart Undo feature. The pre-release current schema now omits those rows,
and every fresh TEMP history starts empty; runtime startup no longer relies on
clearing main-schema history.

Page changes currently bypass both stores. `zoomTo`, breadcrumb navigation,
library scope changes, and quick navigation update the reducer or load another
scope directly, so they do not occupy a position between mutations.

## Selected Architecture

Use SQLite as the transactional replay engine but store its history tables in
connection-local memory. Keep the unified ordering and UI locations in the
frontend session.

```text
frontend session memory
  unified ordered entries + cursor
    - mutation: backend entry ID + existing UI snapshots
    - navigation: compact before/after location

SQLite connection TEMP memory
  mutation entry metadata
  changed notes_nodes / notes_attachments before/after JSON

Vault disk
  authoritative live Notes rows
  authoritative attachment files
```

This keeps the existing trigger, transaction, replay, and attachment-lifetime
logic. It does not introduce a second custom Rust history engine or store whole
workspaces in JavaScript.

## Backend Memory History

### TEMP storage

Every writable Notes connection configures:

```sql
PRAGMA temp_store = MEMORY;
```

It then creates connection-local TEMP forms of:

- `notes_history_epoch`, containing one random history-generation UUID seeded
  per connection and rotated by an explicit reset;
- `notes_history_entries`;
- `notes_history_changes`; and
- the existing audit, mutation-result, and pruned-attachment helper tables.

The companion image-atom design also installs its compact operation-receipt
table in TEMP storage. It follows the same epoch, reset, and connection
lifetime; it never enters the persistent main schema.

The TEMP entry/change schemas retain the existing columns, foreign key,
sequence index, and cascading deletion behavior. Existing unqualified history
queries resolve to the TEMP tables. Main-schema Notes rows remain persistent.

The current trigger audit remains transaction-local. A main-schema Notes
mutation and its TEMP history changes commit or roll back together on the same
connection. A failed history write therefore still prevents an untracked Notes
mutation.

Every initialization, history status, mutation, prune, Undo, and Redo result
returns the current `historyEpoch`. The Vault-shared frontend timeline binds to
that value. A poisoned, evicted, replaced, or explicitly reinitialized SQLite
connection creates a different epoch, allowing the frontend to discard stale
entry IDs before attempting another replay.

`NotesHistoryContext` gains the expected `historyEpoch`. Every content mutation,
cleanup, replay, and destructive reset validates it before changing persistent
rows; a mismatch returns the current epoch and performs no mutation. This closes
the same stale-generation hole for autosaved text and structural edits that the
navigation preflight closes for page moves.

### Pre-release current-schema policy

The product is not released, so this feature does not introduce a schema
version, upgrade path, or compatibility migration. The authoritative current
schema directly omits `notes_history_entries`, `notes_history_changes`, and
their sequence index. Existing development databases may be deleted once
before running the new build.

The existing schema-version guard remains untouched infrastructure, but this
work neither increments it nor dispatches a migration. A fresh current database
creates only persistent application tables. TEMP history is installed after a
writable connection finishes main-schema initialization. Read-only export
connections do not install history storage. The app does not automatically
delete database files at runtime.

### Limits and lifetime

The backend retains the existing safeguards:

- at most 100 mutation entries;
- at most 50 MiB of before/after JSON across those entries; and
- no single entry larger than 50 MiB.

The limits do not include image bytes. Images stay in the Vault's owned asset
storage and are referenced by attachment metadata.

TEMP history disappears when the cached Vault connection closes. When the final
frontend coordinator session closes normally, a dedicated serialized
`closeHistorySession` backend operation:

1. validates the history epoch and session ID;
2. collects attachment paths referenced only by TEMP history;
3. clears the TEMP entries;
4. reconciles those paths while holding the attachment-storage lease; and
5. evicts the cached connection after releasing its database guard.

After a crash or poisoned-connection eviction, the existing next-startup
reconciliation removes unreferenced owned files that were retained only for the
lost history.

Final close is a registry state transition, not an uncoordinated unmount
callback. Under the Vault-coordinator registry lock, the last release marks the
entry `closing` but keeps it registered. It drains the entry's structural queue,
runs `closeHistorySession`, evicts the connection, and only then removes the
registry entry. An immediate reopen that finds `closing` awaits that promise and
then creates a fresh coordinator/connection generation; it cannot attach to the
old entry or be cleared by the old close. Cleanup failure still completes the
transition after best-effort eviction, and the next generation relies on epoch
reset plus startup attachment reconciliation.

## Unified Frontend Timeline

### Entry types

The existing Vault-level `CoordinatorEntry.history` becomes the sole
chronological index. It owns an ordered array and a cursor separating applied
entries from redo entries. It is shared by every short-lived React coordinator
session for that Vault, matching the backend's existing shared history session
ID and serialized mutation queue; it is not duplicated per component or
window.

```ts
type NotesSessionHistoryEntry =
  | {
      kind: "mutation";
      entryId: string;
      before: NotesHistorySnapshot;
      after: NotesHistorySnapshot;
    }
  | {
      kind: "navigation";
      before: NotesNavigationSnapshot;
      after: NotesNavigationSnapshot;
    };
```

Mutation snapshots retain the existing full UI restoration contract, including
local expansion IDs. Navigation snapshots contain:

- active workspace scope;
- library view and tag filters, including tag-filter origin when applicable;
- zoom root ID;
- selected node ID;
- focused node and field; and
- the scope-valid local expansion state.

Navigation does not clone node content, attachments, or the workspace.
Expansion arrays are interned by a Vault-coordinator-owned monotonically
increasing revision. A semantic set change creates one sorted immutable array
and increments the revision; setting the same IDs is a no-op. Repeated
navigation while expansion is unchanged shares that array instead of cloning it
for every entry, and mutation snapshots use the same pool. The current
controller state, retained snapshots, and tag-filter origins hold explicit
references. Clearing an origin, trimming/truncating an entry, or closing the
Vault releases its reference; a revision with no references is removed from the
pool.

The companion image-atom editor extends a focus snapshot with an optional
`{ anchorUtf16, focusUtf16 }` primary selection. Image-node values use logical
offsets with one unit for the atom; text-node values use raw title offsets when
a structural image conversion captures the textarea range. The mixed timeline
stores that small selection value with the same before/after snapshot; it never
stores editor DOM.

The product has one active Notes presentation controller per Vault. Attaching a
visible writable Notes view acquires a monotonically increasing owner token;
the most recently attached visible view becomes owner, and older overlapping
React sessions become read-only observers. Detaching the owner transfers
ownership to the most recently attached surviving view with a new token.
Workspace updates still broadcast to observers, but only the current token may
enqueue navigation, mutation, or history commands.

Controller acquisition/transfer is serialized with structural work. Pending
navigation and IME intents carry the token and are dropped if ownership changes
before queue admission. Once navigation, mutation, or history replay is
admitted, the Vault coordinator—not the React component—owns it through
settlement before a transfer can complete. A controller transfer therefore
cannot discard a committed result: the shared timeline is updated and the next
owner receives the authoritative workspace/location. Navigation revalidates its
token immediately before its backend commit guard and is cancelled without
changing location/history if stale. A non-owner history shortcut is rejected
without moving the cursor. Closing one React session does not clear history;
closing the final Vault session follows the draining close transition above.

### Capacity

The frontend exposes only the most recent 100 combined mutation and navigation
actions. Appending entry 101 removes the oldest accessible entry. When trimming
or truncating the timeline makes backend mutation entries unreachable, the
serialized coordinator asks the backend to discard those TEMP entries and
reconcile any newly unreferenced attachments.

The backend includes `prunedEntryIds` with every result that can enforce its
independent 100-mutation/50-MiB cap. If backend eviction removes a mutation still
present in the mixed timeline, the coordinator finds the newest such index `p`,
establishes a chronological floor by deleting entries `0..=p`, and sets
`cursor = max(0, oldCursor - (p + 1))`. Applied entries after the floor stay
applied; redo entries after it stay redo. It never leaves an older navigation
entry reachable across a missing content mutation.

Every epoch-bearing history response also returns `nextUndoEntryId` and
`nextRedoEntryId`. After a floor change, the coordinator compares them with the
nearest mutation before and after the adjusted mixed cursor. A mismatch resets
the mixed timeline instead of guessing at backend `is_undone` state.

Frontend cleanup discards only entries explicitly removed from the retained
timeline window by capacity/floor trimming or redo truncation; every retained
entry remains reachable from either the applied prefix or redo suffix. A failed
cleanup call cannot make a removed UI entry visible again. Its IDs enter a
bounded pending-cleanup set retried on the next serialized history operation
and final session close. Backend memory remains protected by its own hard
limits meanwhile.

The coordinator drains that pending set before any later navigation preflight,
mutation, or replay. If retry still fails, the requested action does not start
and the current cursor remains usable; this prevents a hidden backend entry
below the frontend floor from being mistaken for the next visible mutation.

An in-flight command is not counted or evicted. It becomes a timeline entry
only after its authoritative operation succeeds. Failed and cancelled commands
discard their provisional context.

### Mutation insertion and text coalescing

A completed structural mutation appends one mutation entry using the exact
`historyEntryId` and `historyEpoch` returned by the backend.

The existing text-burst rule remains: consecutive edits to the same node and
field reuse the latest backend entry ID and update that entry's `after`
snapshot. A navigation request enters the coordinator's `enqueueStructural`
barrier, which flushes drafts across active sessions and closes the text burst
before any location capture or reducer dispatch. The committed mutation
therefore occupies the position immediately before navigation; a late autosave
cannot coalesce across it.

If a mutation returns no history entry because it made no data change, it does
not enter the timeline.

### Explicit history reset

Permanent operations that cannot safely be undone declare that they reset the
whole session history. `emptyTrash` and the explicit clear-history/data-reset
path clear all TEMP entries and operation receipts and rotate `historyEpoch`
inside the same backend transaction as the destructive mutation. Their result
sets `historyReset: true` and returns the new epoch.

Only after that result succeeds does the frontend clear the complete mixed
timeline, cursor, expansion-snapshot references, and pending cleanup IDs. The
destructive command itself is not appended as an Undo entry. A failed command
leaves both data and history unchanged. Any future permanent Notes command must
choose either a normal replayable entry or this explicit reset contract; it may
not silently delete backend history.

### Redo invalidation

Any successful user action after Undo truncates the frontend redo suffix.

- A content mutation continues to invalidate backend redo inside its existing
  history transaction.
- A navigation action asks the backend to discard unreachable undone mutation
  entries before it commits the new navigation entry.

If backend invalidation fails or reports a different epoch, the navigation
state is not committed and the timeline remains unchanged. This prevents a
frontend-only branch from disagreeing with attachment retention in the backend.

## Navigation Entry Contract

All user-initiated page changes route through one history-aware navigation
boundary rather than adding entry creation to individual buttons.

Included actions are:

- clicking a bullet to zoom into its subpage;
- breadcrumb and parent-page navigation;
- Home/root navigation;
- library All, Starred, Recent, Archive, and Trash pages;
- tag and multi-tag scopes;
- search-result and quick-jump page navigation; and
- any later user command that changes Notes scope or zoom root.

The boundary performs:

1. if an editor is composing, retain one latest navigation intent and defer it
   until `compositionend` rather than attempting to force IME completion;
2. enter the coordinator structural barrier and flush all active drafts;
3. validate the owner token and call epoch-bearing `notes_history_status`; on an
   epoch/next-entry mismatch, reset and reload instead of recording navigation;
4. capture the current location only after that preflight succeeds;
5. resolve or load the requested destination without publishing it;
6. return immediately when the normalized destination is unchanged;
7. revalidate the owner token, then call `notes_prepare_navigation` with the
   expected epoch and unreachable redo mutation IDs; this command always
   revalidates the epoch and atomically invalidates that branch when present;
8. apply the normalized destination under the admitted coordinator turn; and
9. append the navigation entry.

`notes_prepare_navigation` is required even when no redo suffix exists. Its
result carries the epoch, next Undo/Redo IDs, and pruned IDs, so a connection
replacement during destination loading cannot attach a new navigation entry to
a stale cursor. Neither workspace loading nor a frontend-only zoom is treated
as an implicit history-generation check.

A failed draft flush, load, authority check, or redo invalidation leaves the
current page and timeline unchanged and reports through the Notes bottom bar.

The following do not create navigation entries:

- initial app or Vault activation;
- navigation performed while replaying Undo/Redo;
- an automatic safe fallback after the current node is deleted or becomes
  unavailable;
- stale-request and error recovery; and
- a request whose normalized destination equals the current location.

## Undo and Redo Data Flow

The Notes history keyboard shortcuts read the frontend cursor, not the
backend's independent `canUndo`/`canRedo` booleans.

Before inspecting whether the next mixed entry is navigation or mutation, every
Undo/Redo request drains pending cleanup, validates the owner token, and performs
the epoch/next-entry status preflight. Thus even a frontend-only navigation
replay cannot run across a replaced connection or an externally reset backend
history.

### Navigation entry

- Undo restores `before` without calling SQLite replay.
- Redo restores `after` without calling SQLite replay.
- Restoration loads a different scope before committing its UI location.
- Restoration bypasses navigation recording to avoid recursive entries.
- Expanded IDs are filtered to nodes present in the restored scope.
- A missing selected/focused node is cleared. A missing zoom root becomes
  `zoomRootId = null`, restoring the scope overview rather than choosing an
  arbitrary first root; dependent selection/focus is cleared.
- A syntactically valid tag scope remains restorable even when it is now empty.
- If normalization needs a safe fallback, replay still advances the cursor and
  reports that the original page is no longer available. A failed scope load
  does not advance the cursor.
- When the restored scope is empty, focus moves to its outline/library container
  (or heading), never to a fabricated row.

### Mutation entry

- The frontend calls backend Undo or Redo with the session ID, history epoch,
  and exact expected entry ID.
- The backend verifies that the expected ID is the next replayable entry before
  changing any row.
- Replay restores Notes rows and attachments transactionally.
- The frontend then restores the matching before/after UI snapshot.

Backend replay returns a discriminated result: `applied`, `epochMismatch`,
`entryMissing`, or `entryNotNext`, together with the resulting epoch and next
Undo/Redo entry IDs. Every non-applied result is decided before row replay.
`epochMismatch` and `entryMissing` clear the mixed timeline, reload the
authoritative current scope, and explicitly report that the session's Undo
history was reset. `entryNotNext` is treated as a synchronization defect and
uses the same safe reset rather than replaying a different mutation.

For an ordinary validation or transaction failure, neither the backend state
nor the frontend cursor advances and the bottom bar reports the failure.

## Attachment Deletion and Replacement

Deleted or replaced image metadata participates in TEMP mutation history. The
owned image file is retained while any reachable Undo or Redo entry references
it.

- Undo restores the original attachment metadata and reuses the retained file.
- Redo removes the live attachment again.
- Redo invalidation, capacity eviction, explicit history reset, and clean
  session close reconcile files that no remaining live row or history entry
  references.
- Startup reconciliation handles files left by abnormal termination.

Image bytes are never copied into the frontend timeline or TEMP JSON payload.

## Multiple Sessions and Lifecycle

The existing coordinator continues to serialize commands per Vault. Every
history-aware operation validates both the active presentation controller and
the backend history epoch, so a stale React session cannot append or consume an
entry.

Closing or replacing one React controller transfers ownership without clearing
the Vault-level timeline. Closing the final Vault coordinator session first
drains admitted work, then runs the registered `closing` transition and clears
history. Reinitializing the writable Vault connection creates empty TEMP
history and a new history epoch; the next required preflight/result makes the
coordinator clear any surviving frontend cursor and reload authoritative data.
The app therefore always starts with `canUndo = false` and `canRedo = false`.

## Accessibility and Feedback

No new Undo controls are introduced. Existing `Cmd/Ctrl+Z`,
`Cmd/Ctrl+Shift+Z`, and `Ctrl+Y` routing covers both entry kinds through the
same Notes actions. After a navigation replay, focus is restored only when its
node and field still exist; otherwise focus moves to the restored page's safe
container without fabricating a new entry.

All navigation and history messages use the existing Notes bottom-bar feedback
surface. History errors must not appear in the old upper-right transient
message location.

## Testing

Follow strict RED/GREEN development.

### Backend

1. Assert writable connection setup reports `temp_store = MEMORY` and creates
   TEMP, not main-schema, history tables.
2. Verify a main Notes mutation and its TEMP audit/history rows roll back
   together on failure.
3. Verify history disappears after closing and reopening the connection while
   live Notes data remains.
4. Verify a fresh current database contains every live-data table but no
   persistent history table or history index.
5. Preserve 100-entry, 50-MiB, coalescing, redo invalidation, and attachment
   reconciliation tests against TEMP storage.
6. Reject an Undo/Redo whose expected entry ID is not next without changing
   Notes data.
7. Return a different history epoch after every connection replacement and
   distinguish epoch mismatch, missing entry, and wrong-next-entry outcomes.
8. Return every entry ID pruned by backend count/byte enforcement together with
   exact next Undo/Redo IDs.
9. Verify pruning unreachable entries and clean session close release only
   genuinely unreferenced attachment files.
10. Rotate the epoch and clear all TEMP history atomically with successful
    empty-trash/explicit reset, while a failed destructive transaction preserves
    both.
11. Reject stale-epoch text and structural mutation contexts before touching
    persistent rows.

### Frontend history model

1. Interleave mutation and navigation entries and assert exact Undo/Redo order.
2. Verify a text burst occupies one position and closes before navigation.
3. Truncate redo after both a new mutation and a new navigation.
4. Retain only the latest 100 combined entries and request backend pruning for
   inaccessible mutation IDs.
5. Establish a chronological floor through the newest backend-pruned mutation
   and assert cursor clamping plus next-entry agreement for pruned applied and
   redo entries.
6. Do not append failed, cancelled, stale, same-destination, automatic, or
   replay-driven navigation.
7. Preserve one Vault-shared timeline across React controller transfer, reject
   stale owner tokens, settle admitted work in the new owner, and clear only
   after the final Vault session closes.
8. Clear and reload on history-epoch mismatch.
9. Deduplicate expansion arrays by semantic revision and release references
   held by trimmed entries and cleared tag-filter origins.
10. Clear the complete mixed timeline exactly when a successful backend result
    declares `historyReset`.

### Workspace integration

1. Cover bullet zoom, breadcrumbs, Home, every library scope, tags, search, and
   quick jump through the shared navigation boundary.
2. Verify edit A -> navigation B requires one Undo for B and a second for A;
   Redo reverses the sequence.
3. Flush a pending title/note draft before page movement and preserve ordering.
4. Defer one latest navigation intent during IME composition, then serialize it
   after `compositionend`.
5. Keep the current page when draft flush, destination load, or backend redo
   invalidation fails.
6. Preflight and commit-guard every navigation even without redo, and reset on
   a connection replacement during destination loading.
7. Normalize missing zoom to the scope overview, normalize selection/focus/tag/
   expansion IDs, and focus the safe container for an empty scope.
8. Route every existing keyboard history shortcut through the same cursor.
9. Preflight even a navigation-only Undo/Redo before moving the mixed cursor.
10. Race final session close with immediate reopen and prove the old close cannot
   clear the new session's TEMP history.
11. Verify all feedback is rendered in the Notes bottom bar.

### Full verification

- focused frontend and Rust history tests;
- complete frontend and Rust suites;
- lint, formatting, production build, and `git diff --check`;
- a running Tauri development app check covering chronological mixed history,
  Vault restart, and attachment delete/restore.

## Rejected Alternatives

### Keep persistent history rows

The product intentionally exposes history only for the current runtime session.
Persistent rows add WAL/database writes and retain old session payload without
providing restart Undo.

### Store whole workspaces in JavaScript

Whole-workspace before/after copies grow with the Vault, duplicate authoritative
data, and make large structural operations expensive. The existing row-level
audit is smaller and more reliable.

### Build a new Rust VecDeque replay engine

This would reimplement ordering, row coalescing, transactions, redo
invalidation, size accounting, and attachment pruning. SQLite TEMP tables
provide the required in-memory lifetime while preserving the proven SQL replay
path.

### Maintain a separate navigation stack

A navigation-only stack cannot represent the required chronological ordering
between edits and page changes. The frontend must own one mixed timeline.

### Give every React session an independent mutation timeline

All coordinator sessions for one Vault mutate the same SQLite rows. Independent
session cursors could replay an older edit across a newer edit from another
session. One Vault-shared coordinator timeline and one active presentation
controller preserve the existing serialized authority boundary.

## Out of Scope

- Persisting Undo/Redo across app restart.
- Synchronizing history between devices or collaborators.
- Raising the 100-entry or 50-MiB limits.
- Recording non-user initialization, recovery, or fallback navigation.
- Moving live Notes rows or image files out of persistent Vault storage.

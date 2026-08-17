# A draft on a row another device deleted still sends its write

## Why this exists

`absorbVaultChange` (`apps/desktop/src/notesStore.ts:181`) is three lines and
two paths:

```ts
async absorbVaultChange(change?: VaultChange): Promise<void> {
  if (change && await this.patchFromVault(change)) return;
  await Promise.all([this.viewport.reload(), this.refreshPages()]);
}
```

The named path (`patchFromVault` → `applyReceipt`, `notesStore.ts:187` and
`:578`) reconciles drafts, because `receiptState` does it for every receipt:
`removedDraftIds` (`storeState.ts:114`) collects `receipt.deletedIds` plus any
changed node arriving with `deleted = true`, `applyReceipt` hands those to
`this.drafts.cancel(...)`, and the same ids are omitted from the patch's
`drafts`/`noteDrafts` (`storeState.ts:134`).

The re-read path does `Promise.all([viewport.reload(), refreshPages()])` and
never mentions drafts. Four conditions send a change down it: `named === 0`,
`named > VIEWPORT_LIMIT` (80), a forest answer with `complete: false`, and
`queryForest` throwing (`notesStore.ts:189`, `:198`, `:214`).

So when another device deletes the row the caret sits in, as part of a change
wide enough to take the re-read, the draft survives with its debounce timer
armed. `reload` replaces `state.nodes` with the fresh window, which no longer
holds the row. `StoreDrafts.flushTitle` (`storeDrafts.ts:77`) then reads
`state.drafts[id]`, finds `confirmedText(state, id)` is `undefined`, concludes
the draft differs from what is committed, and sends `updateText` for a node
that no longer exists.

Reporter's diagnostic, taken as given:

```
NAMED PATH commands:  []
RELOAD PATH nodes:    [ 'two' ]
RELOAD PATH commands: [{"kind":"updateText","id":"one","text":""}]
```

Severity as the reporter measured it: for an empty bullet the late write is
harmless — Rust accepts it, `deleted` stays 1, the node is not revived. It
becomes real when the draft carries text, because a write lands on a row
another device deleted and any resulting stamp is one this device did not earn.

### Confirmed while reading

- **`drafts.cancel` does not touch state.** `StoreDrafts.cancel`
  (`storeDrafts.ts:173`) clears the two timer maps, `titleHistoryGroups`, and
  the typing runs. Nothing in it writes `state.drafts` — every caller pairs it
  with its own state write, which is why `applyReceipt` calls it *and* applies
  a patch with the keys omitted.
- **A leftover entry has a second trigger.** `flushPending`
  (`storeDrafts.ts:139`) iterates `Object.keys(state.drafts)` and
  `Object.keys(state.noteDrafts)`. It is the command choke point:
  `StoreCommands.execute` calls it for every command not in
  `TEXT_OWNING_COMMANDS` (`storeCommands.ts:78`), synchronously, *before*
  queueing the outer command — so the late `updateText` takes the earlier queue
  slot. `flushAll` (`storeDrafts.ts:147`) routes `undo`, `redo`, and `close`
  through the same iteration. A dead timer stops the debounce and nothing else.
- **`flushTitle` returns early on a missing entry.** `storeDrafts.ts:81`:
  `if (submittedText === undefined) return;`. Removing the key is therefore
  sufficient to silence both triggers; cancelling the timer alone is not.
- **`state.drafts` has no single owner today.** `receiptState`
  (`storeState.ts:134`), `optimisticOutline` (`:133`, `:160`, `:188`),
  `storeSlash` (`:57`), and `StoreOutlineMutations` (`:101`, `:152`) all write
  it. `omitKeys` (`storeState.ts:8`) is the shared idiom for dropping keys and
  is already imported in four places.
- **`invalidationForPatch` already handles a drafts-only patch.**
  `storeSubscriptions.ts:82-89` derives the changed node ids from
  `changedRecordKeys` on `drafts`/`noteDrafts`, so the fix needs no explicit
  invalidation argument and gets a more precise one than it would hand-write.
- **`pageNode` carries drafts.** The active page's own node is deliberately
  kept out of `state.nodes` (`notesState.ts:11`, `storeState.ts:105`), and
  `OutlineHeader.tsx:306` calls `store.setDraft(target.id, …)` on the page
  title. Every keystroke of a page rename is a draft whose id is absent from
  `state.nodes`.
- **`state.nodes` is a window, not the truth.** `VIEWPORT_LIMIT` is 80 and
  `loadMore` (`storeViewport.ts:74`) appends; `openPage` (`:21`) replaces
  `nodes` wholesale while leaving `drafts` alone. A draft on a row of the page
  you just navigated away from is live typing whose id is not in `state.nodes`.
- **Production always names the deleted ids.** `announce`
  (`apps/desktop/src-tauri/src/lib.rs:883`) builds `SyncChanged` with
  `deleted_node_ids` from `MergeOutcome.deleted_ids`, and `merger.rs:398`
  inserts every trashed entry there (as well as into `changed_ids`, which
  `listenForVaultChanges` then removes from its `changed` set,
  `syncChanged.ts:83`).
- **`absorbVaultChange()` with no argument has exactly one caller: the test at
  `notesStore.test.ts:1399`.** The app wiring (`App.tsx:140`) always passes the
  collected `VaultChange`. Repo-wide grep for `absorbVaultChange` returns only
  `App.tsx:140`, the definition, and five test call sites.
- **The re-read path never advances `state.revision`.** `viewportState`
  (`storeState.ts:169`) returns no `revision`, and `refreshPages` patches only
  `pages`. Observed, not touched — see Non-goals.
- **Baseline.** `npm run test --prefix apps/desktop -- src/notesStore.test.ts`
  → 45 passed. `node scripts/checkV2Architecture.mjs` already warns that
  `notesStore.ts` has 601 lines (advisory budget 500) and
  `notesStore.test.ts` has 1498 (advisory 800). Both warnings pre-date this
  change.

## Contract

| Field | Content |
| --- | --- |
| Goal | A draft on a row another device deleted never turns into an `updateText`/`updateNote` for that row, on the re-read path as well as the named path — not when the debounce fires, and not at the next command's flush. |
| Acceptance | A1, A2 below. |
| Non-goals | See below. |
| Boundaries | React store only: `apps/desktop/src/notesStore.ts` (`absorbVaultChange`). No IPC payload contract change — the change removes commands, it does not alter any command's shape. No Rust, no SQLite, no filesystem, no macOS, no schema or file-format version. |
| Manual proof | N/A. Nothing here is a UI or runtime boundary: no rendered surface changes, and the row the draft sat on already disappears from the view on the re-read today. The only observable is an IPC command that stops being sent, which the item's test observes directly at the `api.execute` seam. (Reproducing it by hand needs two devices on one vault: type into a row on A, delete that row on B, watch A's IPC log for `updateText` on the dead id. Offered as optional, not required.) |

### Acceptance rows

| # | Observable pass/fail | Item |
| --- | --- | --- |
| A1 | A vault change wide enough to take the re-read path, naming as deleted the row a title draft and a note draft sit on, leaves nothing armed: after `DRAFT_DEBOUNCE_MS` elapses, `api.execute` has recorded no command at all. | 1 |
| A2 | After that same change, an unrelated command — which flushes pending drafts at the choke point — records only itself. The draft entry is gone from `state.drafts`/`state.noteDrafts`, not merely un-timed. | 1 |

A1 fails against today's code. A2 fails against today's code *and* against a
fix that only cancels timers, which is why it is a separate row rather than a
second assertion inside A1 — see ruling 1.

The named path's own deletion handling is already locked by
`"삭제된 줄은 사라지고 나머지는 그대로다"` (`notesStore.test.ts:1436`) and needs no
new row.

### Non-goals

- **`absorbVaultChange()` called with no `change` at all.** It names no
  deleted ids, so nothing can be dropped by name. Not in scope, and not
  reachable: the only caller that does this is the test at
  `notesStore.test.ts:1399`. See ruling 2.
- **An absence guard in `flushTitle`/`flushNote`.** Ruled out with reasons in
  ruling 3.
- **Dropping drafts the change did not name as deleted.** The re-read is a
  page re-read; every other draft on the page is live typing. `receiptState`'s
  `staleDraft` logic (`storeState.ts:118-127`) is deliberately careful here and
  this change does not loosen it.
- **`state.revision` staying behind after a re-read.** Real (see "Confirmed
  while reading") and untouched. It is a different defect with a different
  blast radius — `baseRevision` on every subsequent command — and folding it
  in would make one commit answer two questions.
- **Splitting `notesStore.ts` / `notesStore.test.ts` under their advisory line
  budgets.** Both were already over before this change; the budgets are
  warnings.

## The four rulings the task asked for

**1. Timer cancel alone is insufficient — confirmed, and the state keys must
go.** `drafts.cancel` writes no state (`storeDrafts.ts:173`), and
`flushPending` re-reads `Object.keys(state.drafts)` at the command choke point
(`storeCommands.ts:78`), so a leftover entry sends the same late `updateText`
on the next `setStarred`, `setCompleted`, `undo`, or window close even with the
timer dead. Removing the key is in fact the *load-bearing* half: `flushTitle`
returns at `submittedText === undefined` (`storeDrafts.ts:81`), so a dropped
key silences the debounce too. The cancel stays anyway, as the housekeeping it
already is elsewhere — it clears `titleHistoryGroups` and `typingRuns`, two
Maps keyed by node id that nothing else prunes, and leaving entries there for
ids that no longer exist grows them for the life of the session.

Note drafts are in scope. `flushNote` has the identical shape, `flushPending`
iterates `noteDrafts` in the same call, and `omitKeys` on the second record is
one more line. Excluding them would be a smaller diff that leaves half the bug.

Ownership: the removal belongs to **`absorbVaultChange` in `notesStore.ts`**,
which is exactly how `applyReceipt` next door already does it (`cancel(ids)`
plus an `update` whose patch omits the same ids). It does *not* belong inside
`StoreDrafts.cancel`. That widening would reach into state its three existing
callers already own, and one of them breaks:
`StoreOutlineMutations.beginRemoveEmptyNode` calls `cancelDrafts([id])`
(`storeOutlineMutations.ts:175`) and `commitRemoveEmptyNode` then reads
`state.drafts[id]` as `previousDraft` (`:199`) to restore the user's typing if
the command fails. Draining state inside `cancel` would silently empty that
restore. It does not belong in `storeState.ts` either: `receiptState` is the
receipt reducer, and the re-read path has no receipt.

**2. Root cause vs. named-path-only patch — the root cause is the path
asymmetry, and it is fixed at the one place both paths pass through.** The
defect is not "the re-read forgot deleted ids"; it is that
`absorbVaultChange`'s two paths do not own the same responsibilities, and only
one of them reconciles drafts. The fix goes at the top of
`absorbVaultChange`, ahead of the branch, so both paths get it from one
statement. That also closes a narrower window the named path has today: it
awaits a real `queryForest` IPC round trip, and a debounce armed 290 ms ago
fires during it.

The `change === undefined` case is an accepted non-goal. A call that names
nothing cannot be answered by name, and it is unreachable from the app —
`App.tsx:140` always passes the collected `VaultChange`, and repo-wide grep
finds no other production caller. Covering it would mean either dropping every
draft on the page (rejected below — it throws away live typing) or asking the
backend which ids are dead, which is a query this path exists specifically to
avoid.

**3. No absence guard in `flushTitle`/`flushNote`. Non-goal, and it would be a
regression, not a defence.** "Absent from `state.nodes`" is a normal state for
a row that is very much alive, in two ways this codebase relies on:

- The active page's own node is *deliberately* excluded from `state.nodes`
  (`notesState.ts:11`), and it carries a draft on every keystroke of a page
  rename (`OutlineHeader.tsx:306`). A blanket `state.nodes` guard would break
  page renaming outright.
- `state.nodes` is a viewport window (`VIEWPORT_LIMIT` 80), and `openPage`
  replaces it wholesale without touching `drafts`. Type into a row on page A,
  click page B: the debounce fires against a `nodes` array that no longer holds
  the row, and the commit is exactly right. A guard would silently swallow it.

A guard on `confirmedText(state, id) !== undefined` — which also consults
`pages` and `pageNode` — survives the first case but not the second. Neither
version can tell "deleted elsewhere" from "not in this window", because
`state.nodes` does not carry that fact. The thing that does carry it is the
change that just arrived, which is where the fix goes. And there is no
data-loss argument to buy the trade with: the reporter measured the late write
as harmless at the Rust boundary, so the guard would risk a real class of user
typing to prevent a bounded, already-tolerated write.

**4. The fallback learns the deleted ids from `change`, which is already in
scope.** `absorbVaultChange(change?)` holds the whole `VaultChange`; doing the
drop before the branch needs no plumbing at all. `patchFromVault` keeps its
`Promise<boolean>` return — widening it to hand back deleted ids would be
strictly more code to reach a value the caller already has.

## The decision

### Rejected: cancel in the fallback arm only

```ts
if (change && await this.patchFromVault(change)) return;
if (change) this.drafts.cancel(change.deletedNodeIds);   // + state removal
await Promise.all([this.viewport.reload(), this.refreshPages()]);
```

Same line count as doing it before the branch, but it needs a second `if
(change)` and it leaves the named path's `queryForest` await window open. Two
guards where one does, for less coverage.

### Rejected: reuse `applyReceipt` with a synthetic receipt

```ts
this.applyReceipt({
  revision: change.revision, changedNodes: [],
  deletedIds: [...change.deletedNodeIds], history: { …this.state }
});
```

Pure reuse and roughly one line, so it is the tempting rung. It loses because
it does far more than the job: it rewrites `nodes`, `pages`, `pageNode`, and
`revision` moments before the re-read replaces them anyway, publishes a full
shell + outline invalidation, and — the disqualifier — sets `state.revision`
from a change this path has just decided it cannot describe. `patchFromVault`
refuses to do exactly that when `complete: false`. Reuse that smuggles in a
second, unasked change is not laziness.

### Rejected: drop drafts inside `viewport.reload()`

`reload` owns the viewport and has no access to the change. Handing it the
deleted ids widens its signature for one of its callers — it has exactly one
today — and puts draft reconciliation inside the thing that reads pages.
Wrong owner.

### Rejected: drop every draft on the re-read path

Would need no ids at all, and is smaller. It also throws away typing on rows
that are perfectly alive, which is the one thing `receiptState`'s `staleDraft`
logic (`storeState.ts:118-127`) is written to avoid. The change names its
deletions; use the names.

### Chosen: drop the named deletions' drafts once, at the top of `absorbVaultChange`

```ts
async absorbVaultChange(change?: VaultChange): Promise<void> {
  // A row another device deleted takes the draft sitting on it, whichever
  // path below answers. The receipt path drops it on its own; the re-read
  // never looks at drafts, so an armed debounce commits an `updateText` for
  // a row that is gone -- and the entry left behind sends it again at the
  // next command's flush even with the timer dead. Before the branch because
  // the receipt path's own round trip is long enough for that timer to fire.
  if (change && change.deletedNodeIds.length > 0) {
    this.drafts.cancel(change.deletedNodeIds);
    this.update({
      drafts: omitKeys(this.state.drafts, change.deletedNodeIds),
      noteDrafts: omitKeys(this.state.noteDrafts, change.deletedNodeIds)
    });
  }
  if (change && await this.patchFromVault(change)) return;
  await Promise.all([this.viewport.reload(), this.refreshPages()]);
}
```

Plus `omitKeys` added to the existing `./store/storeState` import
(`notesStore.ts:16`). That is the whole production diff: no new method, no new
name, no signature change, no new file.

Why it is shaped this way, point by point:

- **`length > 0` guard.** Most arriving changes name no deletions. Without the
  guard every one of them calls `this.update`, which publishes and `emit()`s
  unconditionally (`notesStore.ts:588-595`) and so re-runs every
  `useSyncExternalStore` listener for nothing.
- **No explicit invalidation argument.** `invalidationForPatch` already derives
  the node ids from a `drafts`/`noteDrafts` patch via `changedRecordKeys`
  (`storeSubscriptions.ts:82-89`), and derives a tighter set than a hand-written
  `{ nodeIds: change.deletedNodeIds }` would: only ids that actually held a
  draft. Shell and outline stay untouched, which is right — a dropped draft
  changes one row's rendering, exactly as `StoreDrafts`' own writes do
  (`{ nodeIds: [id] }`, `storeDrafts.ts:68`).
- **Dropping by id, not by "is it a `nodes` row".** The same statement covers
  the page-title draft on `pageNode`, which no `nodes`-based check would reach.
- **No change to the named path's outcome.** `receiptState` already omits
  `receipt.deletedIds` from `drafts` unconditionally (`storeState.ts:114`,
  `:134`); `omitKeys` on an already-absent key is a no-op. Only the timing
  moves.

## Item

One item. It is one statement in one function, and the two acceptance rows are
two triggers of the same leftover state, not two changes.

### Item 1 — a deleted row's draft is dropped on the re-read path too (A1, A2)

Touches:

- `apps/desktop/src/notesStore.ts` — `absorbVaultChange` gains the block above;
  `omitKeys` joins the `storeState` import.
- `apps/desktop/src/notesStore.test.ts` — two tests, both new, placed
  immediately after `"한 화면보다 넓게 바뀌면 페이지를 다시 읽는다"`
  (`notesStore.test.ts:1455-1471`) inside
  `describe("다른 기기의 변경 흡수 — 이름이 온 경우")`.

Both tests share the harness already at the top of the file: `boot`
(`:27`), `bullet(id, sortKey)` (`:11`), `api(queryViewport)` (`:42`), `page`
(`:1495`), and `DRAFT_DEBOUNCE_MS`, which is already imported at `:8`.

Both drive the re-read path the way the neighbouring test does — 200 changed
ids plus one deleted id makes `named = 201 > VIEWPORT_LIMIT`, so
`patchFromVault` returns `false` at `notesStore.ts:189` without ever calling
`queryForest`:

```ts
await store.absorbVaultChange({
  revision: 9,
  changedNodeIds: Array.from({ length: 200 }, (_, index) => `node-${index}`),
  deletedNodeIds: ["one"]
});
```

Both need `api()`'s bare `execute: vi.fn()` replaced, because it resolves
`undefined` and `receiptState` would throw on it:

```ts
notes.execute = vi.fn(async () => ({
  revision: 10, changedNodes: [], deletedIds: [],
  history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
}));
```

And both need `queryViewport` to answer without the deleted row, since that
absence is what makes `flushTitle` decide the draft differs — branching on
`request.pageId` exactly like the test at `:1379` does, so `refreshPages`'
`root` query cannot accidentally put `"one"` into `state.pages` (where
`confirmedText` would find it):

```ts
// The generic argument is not optional under `"strict": true` -- a bare
// `vi.fn(async (request) => …)` leaves `request` implicitly `any`, and the
// pattern is already in the suite (`outlineClipboardActions.test.ts:60`).
const queryViewport = vi.fn<NotesApi["queryViewport"]>(async (request) =>
  request.pageId === "root"
    ? { pageId: "root", anchorId: null, beforeCursor: null,
        afterCursor: null, nodes: [page("page-1", "Today")] }
    : { pageId: "page-1", anchorId: null, beforeCursor: null,
        afterCursor: null, nodes: [bullet("two", 2048)] }
);
```

**Test A1 — `"페이지를 다시 읽을 때도 지워진 줄에 치던 글은 보내지 않는다"`**

Drives the debounce, not an explicit flush, because the debounce is the
reported trigger. The file already uses fake timers this way at `:142-150`
(`vi.useFakeTimers()` → `await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS)`
→ `vi.useRealTimers()`), and vitest's fake clock does not fake promise
microtasks, so `await store.absorbVaultChange(...)` still resolves inside it.

```ts
await store.bootstrap();
queryViewport.mockClear();
vi.useFakeTimers();
store.setDraft("one", "여기까지 치고 있었다");
store.setNoteDraft("one", "메모도 치고 있었다");
await store.absorbVaultChange({ /* the wide change above */ });
await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS);
vi.useRealTimers();
```

The assertion, spelled in the local idiom (`sent()` at `:1278` lives in another
`describe`, so read the mock directly):

```ts
expect(vi.mocked(notes.execute).mock.calls.map(
  ([envelope]) => envelope.command
)).toEqual([]);
```

Plus two guards that keep the test honest about *which* path it exercised — if
a future change routed this payload down the named path instead, the assertion
above would pass for the wrong reason:

```ts
expect(notes.queryForest).not.toHaveBeenCalled();
expect(queryViewport).toHaveBeenCalled();
```

Red evidence to expect against today's code: two recorded commands rather than
none —
`[{ kind: "updateText", id: "one", text: "여기까지 치고 있었다" }, { kind: "updateNote", id: "one", note: "메모도 치고 있었다" }]`.

**Test A2 — `"다시 읽은 다음 다른 명령이 와도 지워진 줄에 치던 글은 나가지 않는다"`**

Same fixture and same wide change, no fake timers. After absorbing, issue one
unrelated command on the row that survived:

```ts
store.setDraft("one", "여기까지 치고 있었다");
await store.absorbVaultChange({ /* the wide change above */ });
await store.setStarred("two", true);

expect(vi.mocked(notes.execute).mock.calls.map(
  ([envelope]) => envelope.command.kind
)).toEqual(["setStarred"]);
```

`setStarred` is not in `TEXT_OWNING_COMMANDS`, so `StoreCommands.execute`
calls `flushDrafts()` synchronously before queueing it (`storeCommands.ts:78`)
— the flush's commands therefore take the earlier queue slots, and the order in
the assertion is the order the queue ran.

Red evidence to expect against today's code: `["updateText", "setStarred"]`.
This is also the row that goes red against a timer-only fix: `drafts.cancel`
kills the debounce but leaves `state.drafts["one"]`, and `flushPending`
iterates the keys.

Green for both: the drop happens before either path runs, so `state.drafts`
and `state.noteDrafts` no longer hold `"one"` and `flushTitle`/`flushNote`
return at their `undefined` check.

## Gates (once, after the diff freezes)

Frontend-only, so the gate table's frontend row applies — but **not** with the
root scripts named in the request. Root `npm test` is `vitest run` against the
root config, which explicitly excludes `apps/**` (`vite.config.ts:43-55`), root
`npm run lint` is `eslint src`, and root `npm run build` builds v1. The
equivalents that actually cover `apps/desktop/src` are the `v2` scripts:

```
npm run test --prefix apps/desktop -- src/notesStore.test.ts   # focused, in the loop
npm run test:v2:frontend
npm run lint:v2
npm run v2:build
git diff --check
```

Cargo tests, Rust formatting, and Clippy are explicitly skipped: no Rust, no
IPC payload contract, no persistence, and no native configuration changes.

Known baseline to carry into the report: 45 passing tests in
`notesStore.test.ts` before the change, and two pre-existing advisory line
budget warnings from `scripts/checkV2Architecture.mjs` (`notesStore.ts` 601 vs
500, `notesStore.test.ts` 1498 vs 800). Both warnings get slightly worse and
neither is a gate.

## Risks

1. **The user's typing on that row is discarded.** By design, and it is the
   call `receiptState` already makes for every named deletion in a receipt
   (`storeState.ts:114`, `:134` — a deleted node's draft goes regardless of
   whether it looks stale). The row itself vanishes on the re-read, so the
   draft has no surface left; the alternative is writing to a row another
   device deleted. Nothing already committed is lost — the trash keeps the
   pre-edit text.
2. **Both paths failing leaves a dropped draft on a row still on screen.** If
   `queryForest` throws *and* `viewport.reload()` then fails, `reload`'s catch
   sets only `error` (`storeViewport.ts:68`), so `state.nodes` keeps the row
   while its draft is already gone — the row snaps back to its committed text.
   Bounded to one failed pair of round trips, and the next successful read
   removes the row. Still strictly better than sending the write.
3. **A deletion the change fails to name is not covered.** The fix works by
   name. `merger.rs:398` names every trashed entry today and `announce`
   forwards them, but any future path that removes a row without naming it
   leaves the draft live and invisible, and the next command's flush sends its
   `updateText`. Ruling 3 explains why the store cannot detect that case on its
   own; the reporter's measured harmlessness bounds it.

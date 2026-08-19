# A dangling draft debounce must not decide the exit code

## Goal

`npx vitest run --config vite.config.ts src/notesStore.test.ts` exits 0 every
run: no debounced draft flush can escape as an unhandled rejection after its
test ends.

## Background

`StoreDrafts.setTitle`/`setNote` arm a 300ms real timer whose callback is
fire-and-forget (`() => void this.flushTitle(id)`,
`apps/desktop/src/store/storeDrafts.ts:71-74` and `:109-112`). A test that
leaves a draft unflushed leaves that timer live; when it fires during a later
test (or teardown), a failing flush rejects with no handler and vitest turns
it into a non-zero exit even though every test passed (~1 in 3 runs).

Two independent defects stack:

1. **Store**: the timer callback `void`s the flush promise. The failure is
   already surfaced — `StoreCommands.enqueue` writes `state.error`
   (`storeCommands.ts:203-210`) — so the rethrow has no possible consumer:
   nobody awaits a debounce. The rejection can only reach `window`.
2. **Fixtures**: six test fixtures spread the contract-honest `appApi()`
   (`apps/desktop/src/test/appApiFixture.ts:84`) and then clobber it with a
   bare `execute: vi.fn()`, which resolves `undefined` where `NotesApi`
   promises a `MutationReceipt`. A late flush against that stub reaches
   `applyReceipt(undefined)` → `receiptState` reads `receipt.changedNodes` →
   the reported TypeError. Sites: `src/notesStore.test.ts:53`,
   `src/test/notesStoreFixture.ts:46`,
   `src/outline/outlineMarkerStyles.test.tsx:68`,
   `src/store/storeImages.test.ts:65`,
   `src/outline/outlinePresentationIntegration.test.tsx:44`,
   `src/outline/outlineAutoLoadIntegration.test.tsx:56` — the last two are the
   same landmine found while enumerating, included because the fix is the same
   one-line deletion.

Real danglers today (armed real timer at test end whose flush can reject):

- `src/notesStore.test.ts:73` — draft never flushed, flush hits the bare stub
  → the reported TypeError. The proven trigger.
- `src/notesStore.test.ts:975` — `setDraft("one", "newer")` after the split
  receipt; the test's own `execute` mock throws `"expected splitNode"` on any
  `updateText`, so the late flush rejects. **Fixture honesty cannot fix this
  one** — the throwing mock is the test's own, and correct for what it pins.
- `src/useNotesNode.test.tsx:21` — dangler via `readyRealStore()`'s bare
  stub, same TypeError shape.

Every other `setDraft`/`setNoteDraft` site was checked: it is flushed or
cancelled in-test (flush cancels the timer first, `storeDrafts.ts:78`), its
draft is cleared by the receipt so the late flush early-returns and resolves,
or it runs under fake timers that `vi.useRealTimers()` discards
(`notesStore.test.ts:143-151, 1718-1723, 1737-1741`).

## Decision: both fixes, because each covers what the other cannot

- **A (store)** is the root cause of exit-code instability: with the timer
  callback catching, *no* dangling flush — present or future, including the
  `:975` throwing-mock dangler — can escape. It matches production semantics:
  the error banner (`state.error`) is the only surface a debounced flush ever
  had. A alone, however, would silently swallow the `applyReceipt(undefined)`
  TypeError into a dead store's error field, leaving the fixture lie in place.
- **B (fixtures)** removes the contract violation so `applyReceipt` can never
  see `undefined` — a real receipt-shape bug would again fail loudly in any
  awaited test. B alone does not fix the exit code: `:975` still leaks.
- **No per-test await/cancel hygiene and no global `afterEach`**: once A
  lands, a dangling timer is harmless by construction (late flush either
  early-returns or its failure is contained), so test-side timer discipline
  would be scaffolding.

No test in the six files issues a command against the bare stub *inside* a
test (verified per file — every command-issuing test overrides `execute` with
its own honest mock). Making the default honest therefore changes only the
after-test danglers: they resolve with `appApiFixture.receipt(...)` applied to
a store nothing observes, instead of TypeError-ing.

## Acceptance

| # | Observable pass/fail | Item |
| --- | --- | --- |
| 1 | New `storeDrafts.test.ts` test: with `execute` rejecting, arming and firing the debounce inside the test produces zero `unhandledRejection` events | 1 |
| 2 | New `notesStore.test.ts` test: `await store.flushDraft(...)` against the fixture's default `execute` resolves; `state.error` stays null; the `updateText` envelope reached `execute`; the draft is cleared | 2 |
| 3 | `grep -rn "execute: vi.fn(),\?$" apps/desktop/src` finds no site that clobbers a spread `appApi()` | 2 |
| 4 | 10 consecutive runs of `src/notesStore.test.ts` (plus `src/useNotesNode.test.tsx`) exit 0, and one full `npm test` exits 0 | 1 |

## Non-goals

- No change to awaited flush paths: `flushDraft`, `flushPending`, and the
  command choke point still propagate rejections to their callers.
- No change to `enqueue`'s error-banner semantics.
- No global `afterEach`/teardown hook, no draft-timer hygiene edits in
  individual tests, no new fixture abstraction.
- No edits to the honest per-test `execute` mocks (including the
  `"expected splitNode"` guard at `notesStore.test.ts:939`).

## Boundaries

Frontend-only: TypeScript store (`storeDrafts.ts`) plus test fixtures/tests.
Final gates: `npm test`, `npm run lint`, `npm run build`, `git diff --check`
(repo root). Cargo tests, formatting, and Clippy explicitly skipped — no
Rust, IPC payload, persistence, or native configuration change.

## Item list

### Item 1 — the debounce timer contains its own failure

Failing test (write first): `src/store/storeDrafts.test.ts`, new test
"keeps a failing debounced flush out of unhandledRejection", using the file's
existing host-stub pattern:

1. Register a test-local `process.on("unhandledRejection", listener)` pushing
   reasons into `seen` (removed in `finally`).
2. `vi.useFakeTimers()`; build `StoreDrafts` whose host `execute` is
   `vi.fn().mockRejectedValue(new Error("boom"))`; `drafts.setTitle("one",
   "typed")`; `await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS)`.
3. `vi.useRealTimers()`; `await new Promise((r) => setTimeout(r, 0))` — one
   real macrotask lets Node emit the pending `unhandledRejection`.
4. `expect(seen).toEqual([])`.

**Why red is deterministic**: the race is gone — fake timers fire the debounce
inside the test, and the single real-timer turn deterministically delivers the
`unhandledRejection` event to the listener before the assertion. Verified on
this baseline: red every run with

```
AssertionError: expected [ Error: boom ] to deeply equal []
```

Fix (two lines, `storeDrafts.ts:71-74` and `:109-112`):

```ts
() => void this.flushTitle(id).catch(() => undefined),
() => void this.flushNote(id).catch(() => undefined),
```

with a one-sentence comment at the first site: nobody awaits a debounce and
the command choke point already put the failure in `state.error`, so the
rethrow could only reach `window`. Green verified on this baseline with
exactly that change. Then run the whole `storeDrafts.test.ts` and
`notesStore.test.ts` green.

### Item 2 — fixture `execute` keeps `appApi()`'s honest contract

Failing test (write first): `src/notesStore.test.ts`, new test
"flushes an awaited draft cleanly against the fixture's default execute",
using the file's local `api(vi.fn())` helper unmodified:

1. `store.setDraft("one", "typed")`; `await store.flushDraft("one")`.
2. `expect(store.getSnapshot().error).toBeNull()`;
   `expect(notesApi.execute).toHaveBeenCalledWith(expect.objectContaining({
   command: { kind: "updateText", id: "one", text: "typed" } }))`;
   `expect(store.getSnapshot().drafts.one).toBeUndefined()`.

**Why red is deterministic**: it does not wait for the race — it *awaits* the
same flush the dangling timer would fire, against the same bare stub, so the
test itself rejects with the exact field failure. Verified on this baseline:

```
TypeError: Cannot read properties of undefined (reading 'changedNodes')
 ❯ receiptState src/store/storeState.ts:61:39
 ❯ NotesStore.applyReceipt src/notesStore.ts:718:20
 ❯ Object.applyReceipt src/notesStore.ts:66:39
 ❯ src/store/storeCommands.ts:122:17
 ❯ src/store/storeCommands.ts:202:16
```

Fix: delete the `execute: vi.fn(),` clobber line at all six sites listed in
Background, so each fixture inherits `appApi()`'s honest `execute`. Then run
the six affected files' suites green:
`src/notesStore.test.ts`, `src/useNotesNode.test.tsx`,
`src/outline/outlineMarkerStyles.test.tsx`, `src/store/storeImages.test.ts`,
`src/outline/outlinePresentationIntegration.test.tsx`,
`src/outline/outlineAutoLoadIntegration.test.tsx`.

## Exit-code stability demonstration

After both items land (the deterministic tests are the proof; this is the
field-shaped confirmation — at the observed ~1/3 repro, 10 clean runs bound a
surviving race below 2%):

```sh
cd apps/desktop && for i in $(seq 1 10); do
  npx vitest run --config vite.config.ts \
    src/notesStore.test.ts src/useNotesNode.test.tsx || exit 1
done && echo STABLE
```

then the final gates once, from the repo root:

```sh
npm test && npm run lint && npm run build && git diff --check
```

## Manual proof

N/A — the defect is a test-runner exit code plus a window-level unhandled
rejection; the only user-visible surface (the error banner fed by
`state.error`) is unchanged on every path.

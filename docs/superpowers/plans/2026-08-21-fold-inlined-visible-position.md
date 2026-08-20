# Fold the five remaining inlined `visiblePositionOf` copies (2026-08-21)

`outlineKeyboard.ts` defines `visiblePositionOf` at line 207 — `input.visibleIndex?.positionOf(id) ?? input.visibleNodes.findIndex(...)` behind a `!id` guard — and then hand-inlines that same expression five more times instead of calling it (435, 632, 653, 679, 739). A sixth copy, inside `handleImageNodeKeyDown`, was already folded in `3920b648` (`revert(scripts): the budget stays where it was; the helper was already here`); that commit is the precedent for both the fold shape and the fixture-quality question this doc answers.

This is a duplication cleanup, not a behavior change. The only thing that makes it worth a design pass rather than a one-line search-and-replace is: (a) one of the five sites resolves a different id than the other four, so scope has to be argued explicitly rather than assumed, and (b) a pure fold is behavior-preserving, so "tests stayed green" proves nothing about whether the fold is safe — the real content of this doc is what evidence *does* prove it.

## Contract

| Field | Content |
| --- | --- |
| Goal | Every inlined copy of `input.visibleIndex?.positionOf(id) ?? input.visibleNodes.findIndex(...)` in `outlineKeyboard.ts` calls the existing `visiblePositionOf` helper instead of repeating it, with zero change to any resolver's returned intent. |
| Acceptance | Rows A1–A5 below. |
| Non-goals | Listed below. |
| Boundaries | Frontend-only: `apps/desktop/src/outline/outlineKeyboard.ts` (fold) and `apps/desktop/src/outline/outlineKeyboard.test.ts` (fixture additions only, no assertion values change). No Rust, no IPC, no SQLite, no persisted format. |
| Manual proof | N/A. `resolveOutlineKey` and `handleImageNodeKeyDown` are pure functions of their `OutlineKeyInput`; every caller (`outlineSupport.ts`) is untouched, and the fold cannot change what a mounted app does that the unit suite can't already see. No runtime or DOM boundary is crossed. |

### Acceptance rows

| # | Observable pass/fail |
| --- | --- |
| A1 | `git grep -n 'visibleIndex?.positionOf' apps/desktop/src/outline/outlineKeyboard.ts` returns exactly one line — the helper's own body (line ~212) — after all five sites are folded. |
| A2 | `npm test` passes; every existing `toEqual`/`toBeNull` expected value in `outlineKeyboard.test.ts` is unchanged (only fixture *inputs* — `visibleIndex` overrides — are added, never touched an assertion's expected output). |
| A3 | For each of the four sites that currently have no lookup-path coverage (632, 653, 679, 739), the one assertion chosen per site actually exercises `OutlineIndex.positionOf`, demonstrated by a temporary, reverted index-sabotage that turns it red before the fold and confirmed green after. |
| A4 | For site 435, the pre-existing lookup-path coverage (`bandInput`-based tests, already carrying `visibleIndex`) still passes unchanged post-fold. |
| A5 | `npm run lint`, `npm run test:bundle`, `git diff --check` all pass; the entry bundle's raw/gzip after folding is at or below the pre-fold measured baseline (355,270 raw / 107,575 gzip against 348KiB/106KiB), so no budget raise is needed. |

### Non-goals

- Touching `nodeById`'s `structureIndex` read (used alongside site 679, and inside the Todo-marker check near line 726) — a separate lookup this fold does not target. No `structureIndex` fixture is added anywhere in this work.
- Adding `visibleIndex` to the shared `input()` helper (test line 55). That would silently reroute dozens of unrelated assertions from the fallback scan onto the lookup path — an unreviewed, unrequested scope change the task explicitly warned against.
- Deleting or weakening the fallback-scan (`findIndex`) branch, or removing any existing fallback-only assertion. The type still allows `visibleIndex` to be absent; that branch's own justification is out of scope here (see Decision 2 below).
- The already-folded sixth site inside `handleImageNodeKeyDown` (3920b648) — untouched.
- Any bundle-budget raise. If post-fold measurement unexpectedly exceeds the current limit, stop and re-open this contract rather than raising it to get the gate through.

## Baseline (verified against this worktree)

- `visiblePositionOf` (`outlineKeyboard.ts:207-214`):
  ```ts
  function visiblePositionOf(
    input: OutlineKeyInput,
    id: string | null | undefined
  ): number {
    if (!id) return -1;
    return input.visibleIndex?.positionOf(id) ??
      input.visibleNodes.findIndex((candidate) => candidate.id === id);
  }
  ```
  Signature is generic over an id, not fixed to `input.nodeId` — it is already called with `input.selectionAnchorId` from `bandHeadStep` (line 229: `visiblePositionOf(input, input.selectionAnchorId)`). That existing call is the precedent for including site 435, which resolves a *different* id than the other four (see Decision 1).
- `OutlineIndex.positionOf` (`outlineIndex.ts:33`) is `this.positions.get(id) ?? -1` — never `undefined`. So `input.visibleIndex?.positionOf(id) ?? scan` only ever falls through to the scan when `input.visibleIndex` itself is absent, never because an id was missing from a present index. Identical in the helper and in every inlined copy — the fold is behavior-preserving on this axis by construction.
- Production never omits the index. `OutlineRowKeyContext.visibleIndex` (`outlineSupport.ts:68`) is typed **non-optional**, and `handleOutlineKeyDown` (`outlineSupport.ts:127,153`) always forwards it, built from the same `nodes` the caller already has. `OutlineKeyInput.visibleIndex?` (`outlineKeyboard.ts:29`) is optional purely so unit tests may omit it — the scan branch is dead code in the shipped app. This is the load-bearing fact behind the test-quality decision below.
- `input.nodeId: string` (non-optional, `outlineKeyboard.ts:13`) is always `node.id` or `pageId` at the one production call site (`outlineSupport.ts:142`) — a real id, never `""`.
- `input.selectionHeadId?: string | null` (`outlineKeyboard.ts:31`) is always `band.headId`, itself `useState<string | null>(null)` (`useOutlineSelection.ts:32`) set only to `null` or a real node id (`setHeadId(id)` / `setHeadId(ids.at(-1) ?? null)`) — never `""`.
- Measured baseline, this worktree, HEAD: `npm run test:bundle` passes; entry pair 355,270 raw / 107,575 gzip against `rawLimit = 348 * 1024` / `gzipLimit = 106 * 1024` — 1,082 raw / 969 gzip headroom. (The 37-byte/346KiB figure floated earlier is stale; the page-zoom raise to 348KiB landed after 3920b648.) Per 3920b648, one fold measured 55 raw bytes; this fold is not sized here — record the actual after-numbers when the diff is frozen, per the task's instruction to measure, not assert.

## Per-site table

| Line | Id passed | Guard | `!id` observable there? | Owning test(s) |
| --- | --- | --- | --- | --- |
| 435 | `currentId = input.selectionHeadId ?? input.nodeId` | `index >= 0 ? ... : undefined` (line 439) | No — `nodeId` is always a real id; `selectionHeadId` is always a real id or `null`, and `null`/`undefined` are exactly what `??` collapses onto `nodeId` before the guard would ever see them. An empty string cannot reach either side. | `outlineKeyboard.test.ts:664` "extends a keyboard range from its live head and clears it with Escape" (plain `input()`, no `visibleIndex` — fallback scan). `:705` "steps the growing head past the rows the band already holds", `:753` "gives back only the rows a shrinking band really holds", `:802` "steps one row when the band has no anchor to measure against" — all via `bandInput()` (line 87), which sets `visibleIndex: new OutlineIndex(bandNodes)` by default and two assertions inside `:705` swap in their own diverging `deep`/`collapsed` node sets with matching indexes. **Lookup path already covered.** |
| 632 | `input.nodeId` | `if (index < 0) return null;` (line 634) | No — same as above, `nodeId` is never falsy at any production or test call. | `:622` "moves Up and Down through visible rows and the page-title boundary" — plain `input()`, **no `visibleIndex` anywhere in this test**. Fallback scan only. |
| 653 | `input.nodeId` | `if (index < 0) return null;` (line 655) | No | `:1215` "crosses rows with Left and Right only at a collapsed caret boundary" — plain `input()`, **fallback scan only**. |
| 679 | `input.nodeId` | **No `< 0` guard** — `previous = index > 0 ? input.visibleNodes[index - 1] : undefined` (line 686) | No | `:1357` "merges a title backward only into an eligible previous sibling leaf", `:1406` "merges a first child into the parent row above it" — both plain `input()`, **fallback scan only**. |
| 739 | `input.nodeId` | `if (index < 0) return null;` (line 741) | No | `:1247` "removes only a whitespace-empty row at a plain start caret", `:1274` "drops an empty Todo's box before it removes the row", `:1306` "sends the emptied row's caret past rows that cannot hold one", `:1324` "looks below the emptied row when nothing above can hold the caret", `:1341` "falls back to the page title when no row can hold the caret" — all plain `input()`, **fallback scan only**. |

Net: of five sites, only 435 already has non-vacuous lookup-path coverage. The other four have never once exercised `OutlineIndex.positionOf` in this file's own test suite — exactly the gap 3920b648 closed for the sixth (already-folded) site, where an argument mix-up (visible vs. structure index) had been sitting untested behind a fallback-only assertion.

## Decision 1 — Is line 435 in scope?

**In scope.** Same defect class (the same three-line pattern, same `??`/guard shape), and the biggest single byte-count among the five since it also carries the `currentId` resolution line. The reason this isn't scope creep: `visiblePositionOf`'s signature was never nodeId-specific — `bandHeadStep` (line 229) already calls it with `input.selectionAnchorId`, a different id entirely. Folding line 435 to `visiblePositionOf(input, currentId)` is not widening what the helper does; it is using the helper's existing, already-exercised contract (arbitrary id in, position out) for a fifth caller. Declining to fold it would mean leaving one inlined copy standing next to a helper already proven generic enough to take it — the inconsistent outcome, not the fold, would need justifying.

## Decision 2 — Test-quality: which fixtures get a `visibleIndex`, and which don't

The real question, and the reason a green run alone doesn't prove the fold safe: **production always supplies `visibleIndex`, built from the exact same node array as `visibleNodes`, at the one call site that matters (`outlineSupport.ts:127-154`)**. That means the lookup and the scan are mathematically guaranteed to agree in production — there is no reachable production state where they diverge, unlike the sixth (already-folded) site, which compared two genuinely different arrays (visible vs. structure) and could legitimately disagree on a collapsed row. For these five sites, a single array feeds a single index; nothing in prod can make `positionOf` and `findIndex` return different numbers for the same id.

That rules out reusing 3920b648's `collapsed`-fixture technique here — there is no real divergent scenario to construct for a single-array lookup. What the fold's own risk actually is: a future edit to `visiblePositionOf` (or to one of these call sites) that only misbehaves when `visibleIndex` is *present* — e.g., swapping in the wrong id, or (once folded) accidentally passing `structureIndex` where `visibleIndex` belongs — would sail through every test that never supplies an index, because they only ever touch the scan branch. That is precisely the class of regression 3920b648 fixed at the sixth site. Four of these five sites currently have zero defense against it.

**Decision: add one local `visibleIndex` override to one existing assertion per under-covered site (632, 653, 679, 739), as a per-test override — never to the shared `input()` helper.** Concretely:

| Site | Test | Assertion to change | Change |
| --- | --- | --- | --- |
| 632 | `:622` | First (`:623-627`, `nodeId: "child"`, `ArrowUp` → focus `"parent"`) | Add `visibleIndex: new OutlineIndex(visibleNodes)` to the override object. `visibleNodes` is already the module-level array this call defaults to (line 49) — no new fixture needed. |
| 653 | `:1215` | First (`:1216-1222`, `nodeId: "child"`, `ArrowLeft` → focus `"parent"`, end) | Same: `visibleIndex: new OutlineIndex(visibleNodes)`. |
| 679 | `:1406` | First (`:1407-1413`, `nodeId: "child"`, plain Backspace → `mergeIntoParent`) | Same: `visibleIndex: new OutlineIndex(visibleNodes)`. `:1357` (the `mergeBackward` test) is left fallback-only — one lookup-path proof per fold site is enough; both tests share the same `index` computation at the top of the block, so one already answers "is the lookup consulted." |
| 739 | `:1247` | First (`:1248-1254`, `nodeId: "parent"`, whitespace value → `removeEmpty` focusId `"child"`) | Same: `visibleIndex: new OutlineIndex(visibleNodes)`. |
| 435 | — | none | Already covered by `bandInput` (see per-site table); no change. |

Every added fixture reuses the array the test already has in scope — no new node lists, no `structureIndex` (out of scope per the Non-goals). All remaining assertions in each test — including the entirety of `:1357`, `:1274`, `:1306`, `:1324`, `:1341` — are left exercising the fallback scan exactly as before. That's a deliberate, not an accidental, choice: the type still permits an absent `visibleIndex`, so the scan branch is still reachable code (by type, if not by any live caller today), and this task's job is to fold duplicated lookup logic, not to retire the fallback branch or decide its fate.

Why not go further and add the index everywhere, or drop the fallback-only assertions instead? Both are bigger, unrequested calls: the first inflates every one of ~15 assertions across four tests for a fold that touches one line each; the second deletes coverage for a code path the type system still allows and no one has asked to remove. One falsifiable assertion per site is the smallest change that answers "does the fold's lookup branch actually run," which is the only open question a pure refactor leaves.

## TDD ordering — what stands in for red/green here

A pure fold has no natural failing test: the fold and the fallback compute the same number for the same input, by the guarantee above. The evidence that substitutes for red/green, per site, in order:

1. **Before touching `outlineKeyboard.ts`**, add the one `visibleIndex` override from the table above to its test. Run the single owning test — it stays green (a correct index agrees with the scan; this alone proves nothing about which branch ran).
2. **Temporarily sabotage the index**, in that same test only: build the added `OutlineIndex` over a shuffled or truncated copy of the same node array (e.g. `new OutlineIndex([...visibleNodes].reverse())`) so `positionOf` returns a wrong-but-defined number. Re-run the owning test. It must now fail — proving the assertion is actually reading `OutlineIndex.positionOf`'s answer, not silently falling through to the scan (which would still give the right answer and mask the sabotage). If it stays green, the fixture change didn't do what it was meant to; fix the fixture before proceeding.
3. **Revert the sabotage** back to the correct `new OutlineIndex(visibleNodes)`. Confirm green again. Do not commit the sabotaged version — it models no reachable state (production keeps `visibleIndex` and `visibleNodes` in lockstep) and would just be confusing ceremony in the permanent suite. The sabotage is proof-of-work performed and reported during implementation, not a shipped test.
4. **Now fold the call site** (632/653/679/739 in turn) to call `visiblePositionOf(input, input.nodeId)`. Run the full file's test suite (`npm test` scoped to this file, or the whole suite — cheap enough not to matter). Green is now meaningful: it was red under a wrong index a moment ago, and the fold is what makes that same wrong-index scenario decidable at all going forward.
5. **Site 435** has no fixture step (already covered) — its red evidence is a re-confirmation: run the same sabotage-then-revert cycle against `bandInput`'s existing `visibleIndex` on `:705`/`:753`/`:802` to confirm they still catch a wrong index today, then fold, then confirm the same sabotage still turns them red post-fold (guards against the fold accidentally routing through the wrong argument).

Report the sabotage-and-revert output verbatim per item (the failing assertion text with the corrupted index, then the passing run after reverting) as the red-evidence log the review phase asks for.

## Items (one commit per item, in file order)

Each item touches one call site plus (where applicable) one test fixture line; items are disjoint by line range and safe to run sequentially in one agent.

### Item 1 — Fold line 435 (band head step)
- Code: replace `const index = input.visibleIndex?.positionOf(currentId) ?? input.visibleNodes.findIndex((candidate) => candidate.id === currentId);` with `const index = visiblePositionOf(input, currentId);`.
- Test: no fixture change. Red evidence: sabotage-then-revert against `bandInput`'s existing index in `:705`/`:753`/`:802` (step 5 above), confirmed both pre- and post-fold.
- Test naming this item: `outlineKeyboard.test.ts:705` "steps the growing head past the rows the band already holds" (primary), plus `:664`, `:753`, `:802` as regression.

### Item 2 — Fold line 632 (ArrowUp/ArrowDown row focus)
- Test first: add `visibleIndex: new OutlineIndex(visibleNodes)` to the override at `outlineKeyboard.test.ts:623-627`. Sabotage-then-revert per the TDD steps above.
- Code: replace the inlined `index` computation at lines 632-633 with `const index = visiblePositionOf(input, input.nodeId);`.
- Test naming this item: `outlineKeyboard.test.ts:622` "moves Up and Down through visible rows and the page-title boundary".

### Item 3 — Fold line 653 (ArrowLeft/ArrowRight row focus)
- Test first: add `visibleIndex: new OutlineIndex(visibleNodes)` to the override at `outlineKeyboard.test.ts:1216-1222`. Sabotage-then-revert.
- Code: replace the inlined `index` computation at lines 653-654 with `const index = visiblePositionOf(input, input.nodeId);`.
- Test naming this item: `outlineKeyboard.test.ts:1215` "crosses rows with Left and Right only at a collapsed caret boundary".

### Item 4 — Fold line 679 (Backspace merge ladder)
- Test first: add `visibleIndex: new OutlineIndex(visibleNodes)` to the override at `outlineKeyboard.test.ts:1407-1413`. Sabotage-then-revert.
- Code: replace the inlined `index` computation at lines 679-680 with `const index = visiblePositionOf(input, input.nodeId);` (the adjacent `current = nodeById(structureNodes, input.nodeId, input.structureIndex)` line is untouched — out of scope).
- Test naming this item: `outlineKeyboard.test.ts:1406` "merges a first child into the parent row above it" (primary), `:1357` as regression (fallback path, unchanged).

### Item 5 — Fold line 739 (Backspace removeEmpty)
- Test first: add `visibleIndex: new OutlineIndex(visibleNodes)` to the override at `outlineKeyboard.test.ts:1248-1254`. Sabotage-then-revert.
- Code: replace the inlined `index` computation at lines 739-740 with `const index = visiblePositionOf(input, input.nodeId);`.
- Test naming this item: `outlineKeyboard.test.ts:1247` "removes only a whitespace-empty row at a plain start caret" (primary), `:1274`/`:1306`/`:1324`/`:1341` as regression (fallback path, unchanged).

## Gates (run once, after the diff is frozen)

Frontend-only change, per `delivering-yonalist-changes` §5:

- `npm test`
- `npm run lint`
- `npm run test:bundle` — record the actual post-fold raw/gzip pair against the measured 355,270/107,575 baseline; expect a small decrease (duplication removed), not an increase. No budget-limit edit is anticipated; if one is somehow needed, stop and revisit this contract rather than raising it inline.
- `git diff --check`

Cargo tests, Rust formatting, and Clippy are explicitly skipped — no Rust, IPC payload, persistence, or native configuration is touched.

## Report format expected from implementation

Per item: the sabotage-then-revert red evidence (verbatim), the fold diff, the green run, and the commit hash. At the end: final gate outputs (including the measured bundle pair), and confirmation that A1–A5 all hold.

# The fire-and-forget rejection class gets a boundary, not a sweep

Closes the two residuals the PASS review recorded on
`2026-08-20-flaky-draft-flush-rejection.md` (shipped as `9f539d3a`,
`80f32387`, `9dad0c07`).

## Goal

The debounce swallow's justification claims only what is true, and the
fire-and-forget rejection class has a recorded, defensible boundary — with
zero behavior change.

## Residual A — the comment overclaims

`storeDrafts.ts:71-73` says the choke point "has already put the failure in
`state.error`". Two shapes reach the `.catch(() => undefined)` with no
banner, both verified on this baseline:

1. A synchronous throw from `capturePaneSnapshot` (`storeCommands.ts:101`)
   happens before `enqueue`, so its try/catch never sees it; inside the async
   `flushTitle` it becomes a rejection of the flush promise.
2. A throwing subscriber on the post-flush draft-clear write
   (`storeDrafts.ts:100`, `:133`) — listeners are notified synchronously
   (`storeSubscriptions.ts:213-222`), so the throw propagates out of
   `host.write` after the enqueue already settled. In the no-command path
   (draft equals confirmed text) that write is the only notification.

**Decision: honest comment wording.** The comment is load-bearing — it is
the text a future reader consults to decide whether the swallow is safe, and
a false universal invites copying the pattern to sites where it does not
hold. A narrowed catch is rejected: distinguishing the two shapes would only
matter if the no-banner case had somewhere to go, and it has no consumer —
writing `state.error` from the drafts layer would give the banner a second
owner, and `console.error` is a reporting channel nothing reads. The
load-bearing half of the claim ("nobody awaits a debounce") is true and
stays.

Replacement at `storeDrafts.ts:71-73` (the `:113` site stays uncommented, as
shipped):

```ts
// Nobody awaits a debounce, so a rethrow here could only reach the window
// as an unhandled rejection. When the command itself fails, the choke
// point has already put it in `state.error`; a failure outside the choke
// point (a throw before the enqueue, a subscriber throwing on the
// draft-clear write) has no banner and no other consumer either.
```

## Residual B — the class is ~87 sites, and the boundary is zero

The review named four `void` sites (`OutlineRow.tsx:496`,
`OutlineHeader.tsx:321`, `App.tsx:271`, `SupportingNoteField.tsx:102`).
They are a sample, not the class. The sweep
(`grep -rnoE 'void [a-zA-Z_$][a-zA-Z0-9_$]*[.(]'` over non-test
`apps/desktop/src`) finds **102 expression-position `void` sites across 27
files**; 15 already carry `.catch(() => undefined)`, leaving ~87
uncontained. Essentially every UI-initiated store command is one —
`outlineSupport.ts` alone has 17 — because `StoreCommands.enqueue` writes
`state.error` and then rethrows, for every command alike. The draft-flush
subset (the same class the shipped change fixed the timer half of) is 9
sites: `App.tsx:271`, `SupportingNoteField.tsx:81/102/111`,
`OutlineHeader.tsx:321`, `outlineSupport.ts:365/498/587`,
`OutlineRow.tsx:496`.

**Decision: no code. The defensible boundary is the one already shipped —
the debounce timer — and nothing else in the class earns containment.**

1. **No production defect.** The app registers no `unhandledrejection` or
   window error listener (verified by grep). `enqueue` writes the banner
   before rethrowing, so the user-visible surface is complete at the choke
   point; the escaping rejection lands in the WebView console and nowhere
   else. That is the deliberate idiom, now stated honestly by the Item 1
   comment.
2. **The class cannot reproduce the flake.** The flaky exit code required a
   wall-clock deferral between a test body and the rejection:
   `DRAFT_DEBOUNCE_MS` armed by mere typing, firing ~300ms later into
   another test's window. Every uncontained `void` site rejects on the
   microtask cascade of the event that drove it — no `setTimeout` sits on
   any of those paths (the debounce was the only timer in the class), and
   all test doubles settle in microtasks. A rejection through a `void` site
   therefore surfaces while the driving test is still the active test, and
   vitest fails that run deterministically and names it. Gates are green
   today, so no current test trips one. Reproducing the flake through this
   class would take a test double that defers its rejection on a real timer
   plus a fire-and-forget drive — a construction no test has.
3. **No test would add signal.** The vitest exit code is already the
   detector for the whole class — the exact signal the shipped fix restored
   trust in. A test asserting "site X carries `.catch`" pins implementation,
   not contract; a global "no unhandled rejections" test IS `npm test`.
4. **Every code candidate loses to that.** Fixing the review's 4 is a
   sample chosen by where its eye landed. Fixing the flush subset of 9 is a
   statable sentence ("a rejecting draft flush never reaches `window`") but
   not a causal boundary: a `flushDraft` rejection and a `store.indent`
   rejection escape by the identical mechanism, so the grouping is
   cosmetic — and at the three `.then(...)`-chaining sites the catch must
   sit after the `then`, which makes even the mechanical version
   placement-sensitive for zero observable gain. Fixing all ~87 is a large
   zero-behavior diff guarding an unenforced convention that regresses on
   the next new site. Enforcing it instead
   (`@typescript-eslint/no-floating-promises` with `ignoreVoid: false`)
   would churn all ~87 sites at once and tax every future handler to defend
   against a defect that has never been observed.
5. **No shared containment point exists.** The pinned constraints close it:
   `enqueue` must keep rethrowing (awaited callers at
   `notesStore.test.ts:832` and `:1310`), and `flushDraft` must keep
   rejecting (`applyTextEdits` awaits it at `notesStore.ts:537-540`; the
   third shipped commit pins that an awaited `flushTitle` still rejects).
   The promise a voiding caller discards and the promise an awaiting caller
   consumes are the same object, so the store cannot contain one without
   silencing the other. A blanket
   `window.addEventListener("unhandledrejection")` swallow is considered
   and rejected explicitly: it would blind the console and the vitest exit
   code — the two signals that caught the original bug — globally, to save
   nothing the banner does not already cover.
6. **The existing `.catch` idiom is not a half-migration to complete.** Of
   the 15 contained sites, most sit on `pending.committed` — a promise
   deliberately exposed for the callers that await it, whose default
   consumer is fire-and-forget (`outlineSupport.ts:31` et al.) — or on
   non-command paths (`syncChanged.ts`, clipboard writes). The
   inconsistency with the ~87 bare sites is real and harmless; unifying
   either direction is churn.

**Upgrade trigger (recorded, not scaffolded):** when a future test needs to
drive a UI gesture against a rejecting backend to pin banner behavior
through the DOM path, that one site gets its `.catch(() => undefined)` in
the same change, with the test as the red evidence — the same rule that
produced the debounce fix. Contain at the site a test proves, never
speculatively.

## Acceptance

| # | Observable pass/fail | Item |
| --- | --- | --- |
| 1 | The comment at `storeDrafts.ts:71-73` no longer claims the banner is written for every failure reaching the catch; it scopes the banner claim to command failures and names the no-banner shapes. The diff touches comment lines only. | 1 |
| 2 | This document records the residual-B decision: the ~87-site class named with its sweep command, the four rejected code candidates each with its reason (including the explicit `unhandledrejection`-listener rejection), the flake-reproduction analysis, and the upgrade trigger. | 2 |

## Non-goals

- No `.catch` added at any of the ~87 uncontained `void` sites — not the
  review's 4, not the flush subset of 9, not the class.
- No shared containment point, no `window` listener, no lint-rule change
  (`no-floating-promises` stays as configured).
- No change to `enqueue`'s rethrow, `flushDraft`/`flushPending` rejection,
  or the banner's single ownership.
- No edits to the 15 existing `.catch(() => undefined)` sites.
- No new test: nothing observable changes, and the class's detector is the
  suite exit code itself.

## Boundaries

Frontend-only, and within that comment-only: `storeDrafts.ts` comment lines
plus this document. Final gates: `npm test`, `npm run lint`, `npm run
build`, `git diff --check` (repo root). Cargo tests, formatting, and Clippy
explicitly skipped — no Rust, IPC payload, persistence, or native
configuration change.

## Item list

### Item 1 — the swallow's justification claims only what is true

Comment-only edit at `storeDrafts.ts:71-73`, replacement text above. **No
failing test exists or is manufactured**: the change has no observable
behavior, and a test that greps a comment is not a test. What closes it
instead: the diff shows only comment lines changed at that one site, and the
owning suite stays green —

```sh
cd apps/desktop && npx vitest run --config vite.config.ts src/store/storeDrafts.test.ts
```

### Item 2 — the residual-B decision is recorded

No code. This document is the deliverable; the evidence that closes it is
in the Residual B section: the sweep command and counts (102 sites, 15
contained, ~87 bare), the no-listener grep, the pinned-constraint citations
(`notesStore.test.ts:832`/`:1310`, `notesStore.ts:537-540`), and the
determinism argument for why the class cannot produce the flake the shipped
change fixed.

## Final gates

Once, from the repo root, after the comment edit:

```sh
npm test && npm run lint && npm run build && git diff --check
```

## Manual proof

N/A — the diff is comment lines and this document; no user-visible or
runtime-boundary behavior changes.

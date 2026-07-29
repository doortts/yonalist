# Task 6 report: delete superseded outline tuning

## Status

Complete. The old motion, frame-caret, row-retention, inactive-pane deferral,
prepared-insertion classifier, and held-Backspace timer systems are removed.
The bounded-prefix, DOM-owned title, local-structure, draft, settlement,
history, recovery, and dnd-kit paths remain active.

## Implementation

- Removed FLIP/layout motion, idle-baseline, interaction-epoch, per-child
  observation, frame caret reconciliation, direct-claim caret tokens, and
  motion CSS/data attributes.
- Removed inactive-pane `useDeferredValue` plumbing. Both split panes now
  receive current state and draft slices synchronously.
- Removed full-list row retention and its implementation-detail memo tests.
  The outline is flattened directly and only recomputed when structural
  references, zoom, or local expansion inputs change.
- Removed the legacy keyboard-insertion registry/classifier and moved the
  remaining authority-recovery postcondition and optimistic projection types
  to `notesLocalStructure.ts`.
- Removed the held-Backspace timer/controller/hook. Native delivered key events
  continue through the coordinator's existing gesture transaction.
- Kept direct DOM focus and exact UTF-16 range restoration, editing leases,
  pending focus acknowledgement, one memoized row wrapper, dnd-kit transforms,
  the single scroll-host/container measurement, image-width observation, and
  draft/history/recovery semantics.
- A first-child optimistic insertion now locally expands a collapsed source
  parent, so its existing authoritative children remain visible alongside the
  provisional child.
- Removed the ordinary `textarea.notes-node-title` compatibility selector.
  Ordinary titles now resolve only through `[data-notes-bullet-title]`; retained
  specialized page/note editors keep their dedicated selectors.
- `openExistingDate` now accepts an explicit source. Page and row image editors
  pass their current draft title instead of treating their composite DOM
  (overlays, controls, and raw regions) as plain title text.
- Removed stale architecture-budget entries for every deleted file.

## Deleted systems

- `notesHeldBackspaceRepeat.ts` and its test
- `useNotesHeldBackspaceRepeat.ts`
- `notesKeyboardInsertion.ts` and its test
- `outlineIdleBaseline.ts` and its test
- `outlineInteractionEpoch.ts` and its test
- `outlineLayoutMotion.ts` and its test
- `useOutlineLayoutMotion.ts` and its test
- `outlineRowProjection.ts` and its test
- `outlineRowMemo.test.tsx`
- `useNotesFrameReconciler.ts`
- `useNotesDirectCaretReconciliation.ts`
- `useNotesClaimBoundCaretReconciliation.ts`

## Replacement behavior coverage

- Pointer drag, keyboard drag, cross-pane drag, and selected-forest drag keep
  their exact drop outcomes.
- Reduced-motion Enter performs no structural animation.
- Exact row focus and UTF-16 range restoration remain synchronous.
- Inactive split panes receive current workspace and draft publication.
- Mounted prefix rows expose current selection membership.
- Matching settlement does not publish an intermediate pane projection.
- Fifty repeated ArrowDown moves remain exact in each split pane, including
  prefix expansion.
- Repeated Enter and Backspace retain provisional-title, draft lease, recovery,
  and Undo behavior.

## Debugging note

Deleting row retention exposed an infinite render in direct pane fixtures.
The optional `optimisticKeyboardInsertions` prop defaulted to a fresh `[]` on
every render, which rebuilt expansion and row projections indefinitely. A
module-stable frozen empty array restored referential stability.

The two-pane test that performs and checks 100 DOM focus/range transitions
normally completes just under Vitest's default five-second timeout and became
slow under full-suite parallel load. Its assertions remain unchanged; only that
stress test has an explicit thirty-second harness timeout. The split-close
focus test likewise waits for focus and UTF-16 selection restoration together,
so it does not sample the asynchronous handoff between those two steps.

## Final verification

```sh
npm test -- src/features/notes/NotesPaneScope.test.tsx src/features/notes/notesWorkspaceContextSplit.test.tsx src/features/notes/outlineDomFocus.test.ts
```

- 3 files, 26 tests passed.

```sh
npm test -- src/features/notes/NotesWorkspace.test.tsx src/features/notes/outlineDrag.test.ts src/features/notes/notesCrossPaneDrag.test.ts src/features/notes/outlineSelectionDragSession.test.ts
```

- 4 files, 351 tests passed in 40.27 seconds.

```sh
npm test -- src/features/notes/notesDraftEngine.test.ts
npm test -- src/features/notes/notesSplitLatencyProbe.test.ts
npm test -- src/features/notes/notesWorkspaceCoordinator.test.ts
```

- Draft engine: 72 tests passed.
- Split latency probe: 39 tests passed.
- Coordinator: 86 tests passed.

```sh
npm test
```

- 182 files passed, 1 file skipped.
- 4,178 tests passed, 27 tests skipped.

```sh
npx tsc --noEmit
npm run build
npm run lint
npm run test:architecture
git diff --check
```

- TypeScript, production build, ESLint, architecture budgets, and whitespace
  checks passed.
- The build retains only the pre-existing warning for a minified chunk larger
  than 500 kB.

The deleted-path/ordinary-title search is empty. The broad `flushSync` search
finds only the unrelated window-close export API name and React's
`NotesDatePicker.test.tsx` unmount/test helpers.

## Self-review

- The coordinator still forwards a provisional title into the active or queued
  Backspace draft lease.
- A denied editing claim restores the previous connected DOM editor and active
  pane.
- Settlement still hands the active title to the target pane and routes
  secondary panes through `targetPaneId`.
- Prepared draft revisions still survive post-gesture edits and resave after
  settlement.
- No new dependency, hook layer, observer loop, frame bridge, or motion system
  was introduced.

## Fix round: scoped insertion settlement and focus ownership

### Root causes and fixes

- Keyboard insertion settlement treated a Starred/Tags projection as
  authoritative structure. Filtered settlements now load Active solely for
  structural verification, retain exact history checks, and publish the
  original projection. If authority recovery is required, keyboard insertion
  results are loaded again in the command's captured source scope instead of
  being marked scope-agnostic.
- A pane-local navigation version could not observe interaction in the other
  pane or non-navigation UI activity. The split host now advances one shared
  synchronous interaction revision for click, pointer, key, input, and
  composition events. Enter captures that revision, and settlement checks it
  before routing focus, before DOM focus, and before focus acknowledgement.
  Programmatic focus does not advance the revision.
- Removing a failed optimistic insertion queued its provisional title for a
  later automatic flush. Failed insertion removals now retain recovery text but
  are excluded from pending title flushes.
- The secondary split mock now returns an atomic mutation response with the
  received history context. The split-close focus test now uses `userEvent` for
  real button focus/blur and the default test timeouts.
- Keyboard insertion routing moved into the existing settlement runtime.
  `notesWorkspaceRuntime.ts` is now 1,499 lines; the 1,500-line budget was not
  changed.

### Red-green evidence

```sh
npm test -- src/features/notes/notesWorkspaceSettlementRuntime.test.ts src/features/notes/notesWorkspaceCoordinator.test.ts
```

- Before the fixes: 3 failures. Starred and Tags published the recovered Active
  workspace, and failed insertion text overwrote a later valid title.
- After the fixes: 2 files, 92 tests passed.

```sh
npm test -- src/features/notes/NotesWorkspace.test.tsx -t "cross-pane interaction|toolbar interaction"
```

- Before the fixes: 2 failures; late settlement restored the inserted editor.
- After the fixes: 2 tests passed.

### Final verification

```sh
npm test -- src/features/notes/NotesPaneScope.test.tsx src/features/notes/notesWorkspaceContextSplit.test.tsx src/features/notes/outlineDomFocus.test.ts src/features/notes/NotesWorkspace.test.tsx src/features/notes/outlineDrag.test.ts src/features/notes/notesCrossPaneDrag.test.ts src/features/notes/outlineSelectionDragSession.test.ts src/features/notes/notesWorkspaceSettlementRuntime.test.ts src/features/notes/notesWorkspaceCoordinator.test.ts src/features/notes/NotesFeature.test.tsx
```

- 10 files, 482 tests passed.

```sh
npm test
```

- 183 files passed, 1 file skipped.
- 4,189 tests passed, 27 tests skipped.
- The run retained only the test environment's existing localStorage and jsdom
  navigation warnings.

```sh
npx tsc --noEmit
npm run lint
npm run test:architecture
git diff --check
```

- TypeScript, ESLint, architecture budgets, and whitespace checks passed.
- `notesWorkspaceRuntime.ts`: 1,499/1,500 lines.

### Fix-round self-review

- Active authority is used only to verify the frozen structural postcondition;
  the source projection remains the owner-visible settlement.
- Exact session, history epoch, next Undo entry, committed entry, and recovery
  checks remain intact.
- A user interaction in either pane invalidates only settlement-owned focus;
  it does not cancel persistence or optimistic structure reconciliation.
- Failed insertion text remains available in recovery UI and cannot become
  automatic flush work.
- No architecture budget, dependency, timer, observer, or new runtime layer was
  added.

## Fix round 4: insertion ownership, deferred claims, and exact split-close selection

### Root causes and fixes

- The split host counted the provisional insertion editor's own input and key
  events as competing user interaction. Provisional titles now carry one DOM
  marker, and the shared capture handler ignores only events originating
  inside that editor. Typing can therefore continue through settlement without
  retiring the insertion-owned focus or editing lease.
- A focus acknowledgement could wait for the previous editing lease to flush
  and then claim the inserted node after the originating interaction revision
  was stale. Editing-lease claims now accept a currentness predicate and check
  it both before work and immediately before committing the lease. Primary and
  secondary insertion acknowledgements capture the pending selection's
  expected interaction revision before awaiting the claim.
- Split close restored the primary bullet element but allowed the retained
  synthetic Enter activation to replace its saved UTF-16 range with the default
  end caret. The host now snapshots the active primary bullet selection on the
  toolbar pointer transition and passes it synchronously through the existing
  title-selection marker while retaining the synthetic Enter path.

### Red-green evidence

```sh
npm test -- src/features/notes/NotesWorkspace.test.tsx src/features/notes/notesWorkspaceContextSplit.test.tsx src/features/notes/NotesFeature.test.tsx -t "keeps editing ownership when typing continues after the provisional sibling settles|keeps the previous .* editing lease when interaction invalidates a deferred insertion focus claim|returns focus to the last primary editor after closing from secondary"
```

- Before the fixes: the post-settlement title produced no persistence write,
  both deferred primary/secondary claims displaced the previous lease, and
  split close restored `{4,4}` instead of `{2,2}`.
- After the fixes: 3 files, 4 tests passed.

### Final verification

```sh
npm test -- src/features/notes/NotesWorkspace.test.tsx src/features/notes/notesWorkspaceContextSplit.test.tsx src/features/notes/NotesFeature.test.tsx src/features/notes/useNotesEditingLease.test.tsx
```

- 4 files, 330 tests passed in 40.41 seconds.

```sh
npm run test:architecture
npx tsc --noEmit
npm run lint
git diff --check
```

- Architecture budgets, TypeScript, ESLint, and whitespace checks passed.
- `notesWorkspaceRuntime.ts` remains 1,499/1,500 lines; no budget changed.

### Fix-round self-review

- Persistence settlement, exact history epoch/entry checks, authority recovery,
  and Undo/Redo ownership were not changed.
- Competing interaction elsewhere in either pane still invalidates
  settlement-owned focus; only the provisional editor's own events are scoped
  out.
- A stale deferred focus claim cannot commit its lease or apply pane focus
  state after the previous draft flush completes.
- Selection restoration remains in the existing synchronous focus activation;
  no frame reconciler, timer, observer, dependency, or new runtime layer was
  added.

## Fix round 5: request-owned insertion focus and activation-neutral selection

### Root causes and fixes

- The provisional insertion marker ended with optimistic settlement even when
  focus acknowledgement was still waiting for the previous editor's dirty
  draft to flush. Insertion focus ownership now remains marked through the
  settlement-created focus request and ends only when that exact request
  finishes its editing-lease claim.
- The split interaction guard treated every event inside the marked editor as
  insertion-owned. Plain Enter and Tab now advance the shared interaction
  revision during capture, while a handled boundary Arrow advances it after
  the editor resolves navigation. Text input, composition, pointer activity,
  native caret Arrows, and slash-menu navigation remain insertion-owned.
- Deferred registry claims checked only the interaction revision and restored a
  captured active pane on failure. Primary and secondary acknowledgements now
  capture the exact node/request identity, validate it before and after the
  prior lease flush, leave a newer active-pane choice untouched, and retire
  only the failed request that is still current. Same-revision replacements
  retain their pending selection and focus.
- Split close captured the primary title range only during a pointer
  transition. The existing pane focus tracker now captures the exact UTF-16
  range on primary title focus and blur, so pointer and keyboard toolbar
  activation restore the same selection.

### Red-green evidence

```sh
npm test -- src/features/notes/NotesWorkspace.test.tsx src/features/notes/notesWorkspaceContextSplit.test.tsx src/features/notes/NotesFeature.test.tsx -t "keeps insertion ownership|newest provisional row|provisional row after Tab|same-revision|previous .* editing lease|focus and selection"
```

- Before the fixes: 8 tests failed and the existing pointer selection case
  passed. Failures covered the expired marker and dropped inserted draft, stale
  B refocus after B-to-C Enter, Tab refocus, primary/secondary stale claims,
  same-revision request replacement, active-pane restoration, and keyboard
  selection restoration.
- After the fixes: 3 files, 9 tests passed.

### Final verification

```sh
npm test -- src/features/notes/NotesWorkspace.test.tsx src/features/notes/notesWorkspaceContextSplit.test.tsx src/features/notes/NotesFeature.test.tsx src/features/notes/useNotesEditingLease.test.tsx
```

- 4 files, 334 tests passed in 38.73 seconds.

```sh
npm run test:architecture
npx tsc --noEmit
npm run lint
git diff --check
```

- Architecture budgets, TypeScript, ESLint, and whitespace checks passed.
- `notesWorkspaceRuntime.ts`: 1,500/1,500 lines.
- All-test order observations: 283/283. No budget changed.

### Fix-round self-review

- Persistence settlement, authority recovery, history epoch/entry validation,
  and Undo/Redo ownership were not changed.
- The insertion marker spans only optimistic insertion and its
  settlement-created focus request; ordinary focus requests do not gain this
  event exemption.
- A stale claim cannot overwrite the active pane, editing lease, pending
  primary selection, or pending focus. Failure cleanup is guarded by the exact
  captured node/request pair.
- Split-close restoration stays synchronous and uses the existing title
  selection marker. No timer, frame reconciler, observer, dependency, public
  action, or new runtime layer was added.

## User-authorized post-breaker data-loss fix

The user explicitly authorized one additional fix after the five-round breaker.

### Root cause and fix

- The DOM-owned title editor marked B's latest source as published when its
  500 ms timer fired, but the pane registry discarded that publication while
  A still owned the editing lease. The later successful focus claim could not
  ask the now-clean editor to publish again.
- The existing pane registry now retains only the latest rejected patch for an
  insertion-owned focus request. It keys the patch by pane and the exact
  request object, merges optional marker/image fields with later title text,
  forwards the result once after that request acquires the lease, and discards
  it when the claim fails or the request is replaced.
- No debounce, lease rule, public API, dependency, or general-purpose queue was
  added.

### Red-green evidence

```sh
npm test -- src/features/notes/NotesWorkspace.test.tsx -t "publishes the latest insertion once after its prior editor flush exceeds 500 ms"
```

- RED at `e6b30355`: 1 test failed because the inserted node had one expected
  persistence call missing after A's delayed save resolved.
- GREEN after the fix: 1 test passed. Two B publications made while A's save
  remained unresolved collapsed to the latest patch, which was delivered once
  after the claim.
- Review then exposed a second RED case in the same path: selecting `/todo`
  before more title input lost `markerKind` when the latest patch replaced the
  buffered patch. The test failed with `markerKind: "bullet"`; merging the
  same request's patches made it pass with `markerKind: "todo"`.

```sh
npm test -- src/features/notes/NotesWorkspace.test.tsx src/features/notes/notesWorkspaceContextSplit.test.tsx -t "publishes the latest insertion once|editing lease when interaction invalidates|same-revision .* focus replacement"
```

- 2 files, 5 tests passed. Primary and secondary stale/failed claims discard
  their buffered patch, and same-revision replacements cannot publish the old
  request.

### Verification

```sh
npm test -- src/features/notes/NotesWorkspace.test.tsx src/features/notes/notesWorkspaceContextSplit.test.tsx src/features/notes/NotesFeature.test.tsx src/features/notes/useNotesEditingLease.test.tsx
```

- 4 files, 334 tests passed.

```sh
npm run test:architecture
npm run lint
npx tsc --noEmit
git diff --check
```

- Architecture budgets, ESLint, TypeScript, and whitespace checks passed.
- `notesWorkspaceRuntime.ts` remains 1,500/1,500 lines and all-test-order
  observations remain 283/283.

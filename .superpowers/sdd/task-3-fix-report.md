# Phase A Task 3 review-fix report

Base reviewed commit: `586cf6d`
Comparison baseline used for the two owning-suite regressions: `c69d7cb`

## Review findings closed

1. **Dispatch-epoch focus authority**
   - The coordinator now publishes the insertion's
     `interactionEpochAtDispatch` to the exact target.
   - `OutlineNodeRow` compares that dispatch epoch immediately before focus,
     after focus, and before acknowledgement.
   - A later interaction between publication and the target effect prevents
     both focus and acknowledgement.

2. **Pane-exact accepted projection**
   - Accepted publications reconstruct each Pane from its own scope, zoom,
     show-completed setting, stored collapse state, and local expansion state.
   - Owner navigation and structural commands carry scope and same-turn local
     expansion inputs into the atomic coordinator publication.
   - Active and tag-scoped shared sessions are projected before any settlement
     notification; scope-load failure settles as a command failure instead of
     stranding the queue.

3. **Pane unregister**
   - Pane cleanup unregisters the session-bound Pane, removes its cached
     descriptor, cancels every preparation owned by that Pane, and discards
     the reserved structural history owner.
   - The Strict Mode microtask guard remains, and old vault/repository cleanup
     cannot unregister a replacement session.

4. **Geometry and drag interleaves**
   - Preparations retain the dispatch-time Pane snapshot and drag generation.
   - Classification compares accepted geometry to that immutable baseline and
     detects drag start/end even when `activeDrag` is false again at settlement.

5. **History proof**
   - Atomic receipts require matching history epoch and exact next-Undo entry.
   - `committedHistoryEntryIds` is no longer an insertion-acceptance fallback.
   - Raw-workspace test doubles have a separate, explicitly non-atomic proof;
     the compound helper never emits it for an atomic production receipt.

6. **Explicit draft ownership**
   - The Enter structural barrier assigns its insertion token to captured
     drafts and the draft engine forwards that owner with the silent write.
   - Unrelated silent writes remain `other`; the coordinator no longer infers
     ownership from a sole pending insertion.

7. **Previously unresolved owning-suite failures**
   - `appends a filtered selected drag after hidden children from frozen Active order`
     passed at `c69d7cb`, failed on the review implementation at
     `NotesWorkspace.test.tsx:7422` because the moved selected row disappeared,
     and passes after carrying the command-owned local expansion into the Pane
     publication.
   - `opens a search result in active context without persisting expansion`
     passed at `c69d7cb`, failed on the review implementation because `Target`
     was not rendered, and passes after carrying the destination scope and
     ancestor expansions into the navigation publication.
   - `supports complete keyboard navigation and selection in search results`
     also passed in isolated baseline and current runs.

## Verification

- Task 3 owning suite:
  `notesWorkspaceCoordinator.test.ts`,
  `useNotesWorkspace.operations.test.tsx`,
  `useNotesWorkspace.sharedSession.test.tsx`, and
  `NotesWorkspace.test.tsx` — **429/429 passed**.
- Task 1/2 owning suites combined:
  `notesWorkspaceReducer.test.ts`, `NotesWorkspace.test.tsx`,
  `useNotesWorkspace.operations.test.tsx`,
  `notesKeyboardInsertion.test.ts`, and
  `outlineInteractionEpoch.test.ts` — **413/413 passed**.
- Draft-engine and command-support suites — **34/34 passed**.
- `npx tsc --noEmit` — passed.
- `npm run test:architecture` — passed; both capped runtime files are
  **1500/1500**.
- `npm run lint` — passed.
- `git diff --check` — passed.

The full repository test suite, frontend production build, and desktop smoke
were not part of this focused review-fix run.

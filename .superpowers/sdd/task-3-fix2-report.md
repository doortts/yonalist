# Phase A Task 3 second review-fix report

Base commit: `2a71f83`

## Status

The two Important re-review findings are fixed without changing Task 1/2
behavior or redesigning the Phase A plan.

## Review findings closed

1. **Pane-unmount terminal cancellation**
   - Pane unregister now invalidates matching queued or running command items
     in addition to canceling the registry preparation and history reservation.
   - A prepared insertion is revalidated after all structural barriers,
     immediately before command enqueue, and again immediately before accepted
     publication.
   - A committed result is still adopted after an unmount, but insertion focus
     and disposition remain canceled even if the same Pane ID remounts before
     settlement.

2. **Atomic multi-Pane scoped projection**
   - All distinct Pane scopes are loaded before any projection generation,
     publication-owner ledger, Pane snapshot/layout generation, or insertion
     consumption is mutated.
   - Projected rows, signatures, local expansion, generations, publication
     owners, and insertion disposition are staged in temporary state, then
     committed synchronously only after every scope load and projection
     succeeds.
   - A later tag-scope load rejection therefore cannot retain an origin-Pane
     projection, generation advance, or insertion consumption. The command
     follows the existing failure/recovery settlement path.

## Standards cleanup

- `notesWorkspaceSettlementRuntime.ts` is now included in the Notes workspace
  production-file budget inventory.
- The accidentally removed navigation-ownership, replay-ownership, and
  resolver-lease boundary explanations were restored in compact form.
- The capped runtime files remain within budget:
  `notesWorkspaceRuntime.ts` is 1499/1500 and
  `useNotesHistoryController.ts` is 1500/1500.

## TDD evidence

The two focused regressions first failed for the intended reasons:

- Pane remount received stale `pendingFocusId: "split"` instead of `null`.
- A later tag-scope load rejection advanced the projection generation from
  `0` to `1`.

After the production fix, the same focused selector passes **2/2**.

## Verification

- Focused coordinator regressions — **2/2 passed**.
- `npx tsc --noEmit` — passed.
- `npm run test:architecture` — passed, including the settlement runtime
  inventory.
- `npm run lint` — passed.
- `git diff --check` — passed before adding this report and is rerun before
  commit.

The full frontend `npm test`, production build, and fresh desktop smoke were
not run in this focused second fix wave. They remain required at the Phase A
completion gate; this report does not claim them.

## Remaining concerns

No new Task 3 concern was found in the changed coordinator boundary. The full
frontend and desktop evidence remains deferred only to the explicitly planned
Phase A gate.

# Task 4 — uncertain mutation recovery report

## Status

Implemented and ready to commit.

Once a mutation IPC has been dispatched, a transport rejection or undecodable
response is now treated as outcome uncertainty. The frontend never replays that
mutation. It performs one Vault-shared active-workspace reload, classifies the
observed workspace and origin-session history, and either adopts the result or
hard-locks writes until an explicit recovery reload succeeds.

## Contract delivered

- Local validation, unavailable-desktop, dynamic-import, and synchronous invoke
  failures remain preflight failures. Promise rejection and response decoding
  after invoke are branded `outcomeUnknown` without changing the underlying
  structured error or issuing another mutation IPC.
- The pure recovery classifier proves structural relationships or exact draft
  text independently from the origin history epoch, entry ID, and next-Undo
  proof. It distinguishes current commit, commit without history proof,
  unproven commit, and unavailable authority.
- The coordinator owns a single-flight recovery generation and one write
  authority per repository/Vault entry. Recovery is shared by sibling frontend
  sessions, reloads only the active workspace, never replays the mutation, and
  invalidates insertion focus unless both postcondition and history proof are
  current.
- A committed workspace without history proof is accepted without insertion
  focus and runs the existing shared history reset path. Recovery failure keeps
  save, structure, Undo, and Redo locked.
- Draft timers pause while authority is recovering. An uncertain dispatched
  draft is retained as failed/manual-only, does not resume automatically, and
  can be sent only by the existing explicit retry action.
- The workspace state exposes authority and explicit recovery. The outline
  reports recovery through `aria-busy`, shows a `role="alert"` banner on the
  hard lock, and keeps mutation controls disabled until authority is known.

## TDD evidence

Focused tests were observed RED before their corresponding production slices:

1. The transport-boundary tests first failed because no dispatch classifier or
   outcome brand existed; all three preflight/rejection/decode cases then
   passed with exactly zero or one invoke as appropriate.
2. The pure classifier initially failed to resolve; its five decision-table
   cases passed after implementation.
3. Coordinator tests first lacked recovery APIs, then proved single-flight
   reload, zero mutation replay, exact structural focus, focus-free history
   reset, hard-lock failure, and concurrent manual retry.
4. Draft tests first lacked pause/resume/manual-retry controls, then proved
   retained dirty state, stopped timers, no automatic resend, and explicit
   retry.
5. Workspace integration first exposed swallowed uncertainty, then proved a
   dirty draft aborts its later split and that a failed recovery locks the
   Vault until a reload-only manual retry adopts the authoritative workspace.
6. The shared-session regression proves both live sessions observe one
   Vault-wide lock and the non-origin session can perform the shared manual
   recovery.

The first complete focused run exposed one real compatibility defect: branding
an already structured decode error rebuilt it and changed `retryable: false` to
`true`. The brand now preserves the original `NotesStoreError`; the owning
adapter suite passes all 163 cases.

## Verification

- Baseline owning suites before edits: **388/388 passed**.
- Task 4 focused matrix:
  `npm test -- --run src/services/notesStore.tauri.test.ts src/features/notes/notesAuthorityRecovery.test.ts src/features/notes/notesWorkspaceCoordinator.test.ts src/features/notes/notesDraftEngine.test.ts src/features/notes/useNotesWorkspace.operations.test.tsx src/features/notes/useNotesWorkspace.sharedSession.test.tsx`
  — **404/404 passed**.
- `npx tsc --noEmit` — pass.
- `npm run test:architecture` — pass. The new recovery module is inventoried;
  `notesWorkspaceRuntime.ts` is **1499/1500** lines.
- `npm run lint` — pass.
- `git diff --check` — pass.

## Scope and remaining proof

This Task 4 slice changes the TypeScript Tauri adapter boundary but does not
change IPC payloads, Rust, persistence, native configuration, or motion files.
Per the Phase A plan, no Cargo gates were run. A desktop smoke/measurement was
not run in this isolated implementation task; the plan reserves clean-HEAD
desktop evidence for the later Phase A measurement task.

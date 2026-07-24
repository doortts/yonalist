# Notes History Session Auto-Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover a stale Notes history session automatically, preserve Notes content and local drafts, resume safe work, and reserve write blocking for reset failure.

**Architecture:** Add one typed backend error, route it through the existing per-Vault coordinator recovery flight, and reuse the current Notes feedback and draft-pause mechanisms. Ponytail scope deliberately cancels a preallocated optimistic Enter after a reset instead of adding context-renewal machinery; the user gets the existing rollback text and can press Enter again.

**Tech Stack:** Rust, Tauri IPC, React 19, TypeScript, Vitest, Testing Library, SQLite TEMP history

## Global Constraints

- Do not add a dependency, database schema, persisted format, migration, or new backend command.
- Never retry a stale history entry ID or replay an old Undo/Redo target.
- Preserve Notes rows, attachment metadata, local drafts, selection, focus, and the current presentation.
- A successful backend `clearHistory` acknowledgement is required before installing a new epoch.
- Only `historySessionMismatch` starts this recovery; unrelated `internal`, SQLite, I/O, and transport failures keep their existing behavior.
- Automatic recovery uses the existing status feedback region. Only failed recovery renders a persistent alert and blocks writes.
- Preallocated optimistic Enter is rolled back after reset; do not implement history-context renewal.
- Use a fresh Tauri process and an isolated test Vault for desktop proof.

---

## File Map

- `src-tauri/src/notes/history.rs` — owns the stable history ownership error message.
- `src-tauri/src/notes/error.rs` — maps that message to the IPC error code.
- `src/domain/notes.ts` — mirrors and parses the code in TypeScript.
- `src/domain/notes.test.ts` — proves parsing and retryability.
- `src/features/notes/notesWorkspaceCoordinator.ts` — detects the typed cleanup failure, runs one reset, orders queued work, and exposes recovery/retry events.
- `src/features/notes/notesWorkspaceCoordinator.test.ts` — proves successful, concurrent, blocked, retry, and unrelated-error behavior.
- `src/features/notes/notesDraftEngine.ts` — discards old-epoch draft contexts and schedules fresh undispatched attempts.
- `src/features/notes/notesDraftEngine.test.ts` — proves draft text survives and receives a fresh history entry.
- `src/features/notes/notesWorkspaceTypes.ts` — carries the small recovery state and actions to panes.
- `src/features/notes/notesWorkspaceRuntime.ts` — adopts coordinator recovery events, publishes status, pauses/resumes drafts, and safely reloads the webview for the final fallback.
- `src/features/notes/useNotesWorkspacePaneRegistry.ts` — forwards recovery state/actions to the secondary pane.
- `src/features/notes/NotesOutlinePane.tsx` — renders the hard-failure actions and keeps read/copy access.
- `src/features/notes/NotesPageHeader.test.tsx` — proves the hard-failure banner and buttons without adding a new test harness.
- `src/features/notes/useNotesWorkspace.sharedSession.test.tsx` — proves runtime feedback and draft preservation across coordinator recovery.

---

### Task 1: Typed history-session mismatch

**Files:**
- Modify: `src-tauri/src/notes/history.rs:950-975`
- Modify: `src-tauri/src/notes/error.rs:19-95`
- Modify: `src/domain/notes.ts:319-390`
- Test: `src-tauri/src/notes/error.rs`
- Test: `src/domain/notes.test.ts:1190-1260`

**Interfaces:**
- Produces Rust `NotesErrorCode::HistorySessionMismatch`.
- Produces TypeScript `NotesErrorCode` member `"historySessionMismatch"`.
- Existing `notesStoreError` preserves the code without changes.

- [ ] **Step 1: Add failing Rust and TypeScript taxonomy tests**

In `src-tauri/src/notes/error.rs`, add:

```rust
#[test]
fn classifies_history_session_mismatch() {
    let error = NotesError::from(
        crate::notes::history::HISTORY_SESSION_MISMATCH_MESSAGE.to_string(),
    );
    assert_eq!(error.code, NotesErrorCode::HistorySessionMismatch);
    assert_eq!(serialized_code(&error), "historySessionMismatch");
}
```

In `src/domain/notes.test.ts`, extend the recognized-code test and the
retryability table:

```ts
expect(
  parseNotesError({
    code: "historySessionMismatch",
    message: "A Notes history entry is missing or belongs to another session."
  })
).toEqual({
  code: "historySessionMismatch",
  message: "A Notes history entry is missing or belongs to another session."
});

expect(isRetryableNotesErrorCode("historySessionMismatch")).toBe(false);
```

- [ ] **Step 2: Run the focused tests and confirm RED**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml notes::error::tests::classifies_history_session_mismatch
npm test -- src/domain/notes.test.ts
```

Expected: Rust fails because the constant/variant does not exist; TypeScript
fails because the code is not recognized.

- [ ] **Step 3: Add the minimum production taxonomy**

In `src-tauri/src/notes/history.rs`, replace the inline string with:

```rust
pub(crate) const HISTORY_SESSION_MISMATCH_MESSAGE: &str =
    "A Notes history entry is missing or belongs to another session.";
```

and:

```rust
return Err(HISTORY_SESSION_MISMATCH_MESSAGE.to_string());
```

In `src-tauri/src/notes/error.rs`, add the variant:

```rust
HistorySessionMismatch,
```

and classify only the stable constant:

```rust
} else if message == crate::notes::history::HISTORY_SESSION_MISMATCH_MESSAGE {
    NotesErrorCode::HistorySessionMismatch
```

In `src/domain/notes.ts`, add `"historySessionMismatch"` to
`NotesErrorCode`, `NOTES_ERROR_CODES`, and
`NON_RETRYABLE_NOTES_ERROR_CODES`.

- [ ] **Step 4: Run focused GREEN**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml notes::error::tests
npm test -- src/domain/notes.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the taxonomy slice**

```bash
git add src-tauri/src/notes/history.rs src-tauri/src/notes/error.rs src/domain/notes.ts src/domain/notes.test.ts
git commit -m "fix(notes): classify stale history sessions"
```

---

### Task 2: Recover once at the coordinator boundary

**Files:**
- Modify: `src/features/notes/notesWorkspaceCoordinator.ts:149-310`
- Modify: `src/features/notes/notesWorkspaceCoordinator.ts:969-1255`
- Modify: `src/features/notes/notesWorkspaceCoordinator.ts:1840-1970`
- Test: `src/features/notes/notesWorkspaceCoordinator.test.ts:2840-3520`

**Interfaces:**
- Consumes `notesErrorHasCode(cause, "historySessionMismatch")`.
- Produces:

```ts
export type NotesHistoryRecoveryEvent =
  | { readonly kind: "recovering" }
  | { readonly kind: "recovered"; readonly skippedOptimisticEnter: boolean }
  | { readonly kind: "blocked"; readonly error: string };
```

- Adds coordinator event:

```ts
| { type: "historyRecovery"; recovery: NotesHistoryRecoveryEvent }
```

- Adds session method:

```ts
retryHistoryRecovery(): Promise<boolean>;
```

- [ ] **Step 1: Write coordinator RED tests**

Add focused tests that construct a typed store error with:

```ts
const historyMismatch = Object.assign(
  new Error("A Notes history entry is missing or belongs to another session."),
  {
    operation: "write" as const,
    code: "historySessionMismatch" as const,
    retryable: false
  }
);
```

Prove these cases:

```ts
it("resets a stale cleanup session once and runs a safe queued command", async () => {
  // pruneHistoryEntries rejects with historyMismatch.
  // historyStatus returns epoch-b and clearHistory acknowledges epoch-c.
  // The queued work runs once after reset.
  // The timeline and pending cleanup IDs use epoch-c.
  // Events contain recovering then recovered, never the raw backend message.
});

it("shares one cleanup recovery across concurrent observations", async () => {
  // Two callers wait on one historyStatus/clearHistory flight.
});

it("queues work submitted during the active recovery flight", async () => {
  // Hold clearHistory pending, enqueue another ordinary command, then resolve.
  // The command reaches its work only after the new epoch is installed.
});

it("skips a preallocated optimistic Enter after recovery", async () => {
  // Pass keyboardInsertion on the queued item.
  // Its work never reaches the repository.
  // Existing rollback notification fires.
  // recovered.skippedOptimisticEnter is true.
});

it("keeps reset failure blocked and retries only the reset", async () => {
  // First clearHistory rejects; later work never runs.
  // Event is blocked.
  // retryHistoryRecovery succeeds with a second clearHistory result.
  // No skipped user mutation is replayed.
});

it("does not reset history for an unrelated cleanup error", async () => {
  // prune rejects with code internal.
  // Preserve the existing failed outcome and pending cleanup.
  // historyStatus/clearHistory are not called.
});
```

- [ ] **Step 2: Run the coordinator tests and confirm RED**

Run:

```bash
npm test -- src/features/notes/notesWorkspaceCoordinator.test.ts
```

Expected: the new recovery event/method and typed cleanup branch do not exist.

- [ ] **Step 3: Add the narrow recovery branch**

Import the existing code guard:

```ts
import {
  notesErrorHasCode,
  parseNotesError,
  type NotesStore
} from "../../domain/notes";
```

Extend `CoordinatorEntry` with only the retry closure needed by the hard
state:

```ts
historyRecoveryRetry: (() => Promise<boolean>) | null;
```

Notify active writable sessions with one helper:

```ts
const notifyHistoryRecovery = (
  entry: CoordinatorEntry,
  recovery: NotesHistoryRecoveryEvent
): void => {
  for (const session of entry.sessions) {
    if (session.active && session.presentation === "writable") {
      notify(session, { type: "historyRecovery", recovery });
    }
  }
};
```

Keep the existing `recoverHistoryMismatchForEntry` single-flight. Add a retry
closure before starting and clear it only after success. The initial cleanup
caller announces success after its queue item settles; a user-triggered retry
announces success from the retry closure because it has no queue item:

```ts
const runRetry = async (): Promise<boolean> => {
  const recovered = await recoverHistoryMismatchForEntry(
    entry,
    preferredSession,
    reload
  );
  if (recovered) {
    entry.historyRecoveryRetry = null;
    notifyHistoryRecovery(entry, {
      kind: "recovered",
      skippedOptimisticEnter: false
    });
  }
  return recovered !== null;
};
entry.historyRecoveryRetry = runRetry;
notifyHistoryRecovery(entry, { kind: "recovering" });
```

The initial cleanup caller records the successful outcome without publishing
it immediately:

```ts
entry.historyRecoveryRetry = null;
const recoveredEvent: NotesHistoryRecoveryEvent = {
  kind: "recovered",
  skippedOptimisticEnter
};
```

On failure, keep `historyBlocked = true` and notify:

```ts
notifyHistoryRecovery(entry, {
  kind: "blocked",
  error:
    "Notes could not finish recovery. Your current notes and drafts remain on screen, but saving is paused."
});
```

Treat a reset as failed when `resetEntryHistory` cannot apply the preserved
presentation and leaves `entry.presentationBlocked === true`.

Change the internal cleanup drain to return:

```ts
type HistoryCleanupOutcome = "ready" | "recovered" | "blocked";
```

Catch only the typed mismatch. Retain the existing canonical snapshot before
passing it back through `resetEntryHistory`:

```ts
if (!notesErrorHasCode(cause, "historySessionMismatch")) throw cause;
const presentation = entry.authoritativePresentation;
if (!presentation) return "blocked";
retainHistorySnapshot(presentation.snapshot);
const recovered = await recoverHistoryMismatchForEntry(
  entry,
  preferredSession,
  async () => ({
    workspace: presentation.workspace,
    snapshot: presentation.snapshot
  })
);
return recovered ? "recovered" : "blocked";
```

In `executeItem`:

```ts
const cleanup = await drainHistoryCleanup(item.entry, item.owner);
if (cleanup === "blocked") {
  result = { kind: "skipped" };
} else if (cleanup === "recovered" && item.keyboardInsertion) {
  cancelKeyboardInsertion(item.entry, item.keyboardInsertion);
  item.keyboardInsertion = null;
  result = { kind: "skipped" };
} else if (
  cleanup === "recovered" &&
  item.unknownOutcomeExpectation?.kind === "draft"
) {
  result = { kind: "skipped" };
} else {
  result = await work(/* existing context */);
}
```

After settlement, publish the recovered event in a microtask so a skipped
draft attempt clears its in-flight marker before the runtime rearms it:

```ts
queueMicrotask(() => notifyHistoryRecovery(entry, recoveredEvent));
```

Implement:

```ts
retryHistoryRecovery(): Promise<boolean> {
  return entry.historyRecoveryRetry?.() ?? Promise.resolve(false);
}
```

Do not change generic cleanup error behavior.

Allow commands to join the queue while the single recovery flight is active;
keep rejecting them after recovery has failed:

```ts
if (
  entry.historyBlocked &&
  entry.historyRecovery === null
) {
  return Promise.resolve("failed");
}
```

- [ ] **Step 4: Run focused GREEN**

Run:

```bash
npm test -- src/features/notes/notesWorkspaceCoordinator.test.ts
```

Expected: PASS, including the existing cleanup retry, close/reopen, and
mismatch-recovery tests.

- [ ] **Step 5: Commit the coordinator slice**

```bash
git add src/features/notes/notesWorkspaceCoordinator.ts src/features/notes/notesWorkspaceCoordinator.test.ts
git commit -m "fix(notes): recover stale history cleanup"
```

---

### Task 3: Preserve and rearm local drafts

**Files:**
- Modify: `src/features/notes/notesDraftEngine.ts:95-120`
- Modify: `src/features/notes/notesDraftEngine.ts:600-675`
- Test: `src/features/notes/notesDraftEngine.test.ts:560-625`

**Interfaces:**
- Produces:

```ts
resetHistoryContextsAfterSessionChange(): void;
```

- Reuses `pauseForAuthorityRecovery`, `resumeAfterAuthorityRecovery`,
  `beginTextEntry`, `discardHistoryEntry`, `newDraftWriteAttempt`, and
  `scheduleDeferredDrafts`.

- [ ] **Step 1: Write the failing draft-engine test**

Add:

```ts
it("keeps a skipped draft and rearms it with a fresh history entry after a session reset", async () => {
  const { engine, host, store } = createHarness();
  engine.updateNodeDraft("root", {
    title: "still here",
    note: "",
    imageOffsetUtf16: 0
  });

  engine.pauseForAuthorityRecovery();
  engine.resetHistoryContextsAfterSessionChange();
  engine.resumeAfterAuthorityRecovery();
  await vi.runAllTimersAsync();

  expect(engine.getDraftsSnapshot().root?.title).toBe("still here");
  expect(host.discardHistoryEntry).toHaveBeenCalled();
  expect(host.beginTextEntry).toHaveBeenCalledTimes(2);
  expect(store.updateNode).toHaveBeenCalledTimes(1);
  expect(vi.mocked(store.updateNode).mock.calls[0]?.[2].entryId).toBe(
    vi.mocked(host.beginTextEntry).mock.results[1]?.value.entryId
  );
});
```

Adjust the harness result sequence so the old queued attempt resolves
`"skipped"` and only the fresh attempt writes.

- [ ] **Step 2: Run the draft-engine test and confirm RED**

Run:

```bash
npm test -- src/features/notes/notesDraftEngine.test.ts
```

Expected: method missing or the stale attempt remains the only attempt.

- [ ] **Step 3: Implement the small rearm method**

Add a public method that:

1. Discards every value in `draftHistoryContextByNodeId`.
2. Clears `draftHistoryContextByNodeId`.
3. Rebuilds `retryWriteByNodeId` only for current drafts, using their existing
   `draftHistoryFocusByNodeId` focus and `host.beginTextEntry`.
4. Clears failed/manual-retry state only for an attempt that was skipped
   before backend dispatch.
5. Leaves draft values and revision numbers unchanged.
6. Calls `scheduleDeferredDrafts`; the caller controls pause/resume ordering.

The core loop is:

```ts
for (const [nodeId, draft] of record.drafts) {
  const focus = record.draftHistoryFocusByNodeId.get(nodeId);
  if (!focus) continue;
  const historyContext = this.host.beginTextEntry(record, nodeId, focus);
  record.draftHistoryContextByNodeId.set(nodeId, historyContext);
  record.retryWriteByNodeId.set(
    nodeId,
    newDraftWriteAttempt(record, nodeId, draft, focus, historyContext)
  );
}
```

Do not add a second recovery ledger or timer.

- [ ] **Step 4: Run focused GREEN**

Run:

```bash
npm test -- src/features/notes/notesDraftEngine.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the draft slice**

```bash
git add src/features/notes/notesDraftEngine.ts src/features/notes/notesDraftEngine.test.ts
git commit -m "fix(notes): rearm drafts after history reset"
```

---

### Task 4: Show recovery status and hard actions

**Files:**
- Modify: `src/features/notes/notesWorkspaceTypes.ts:180-215`
- Modify: `src/features/notes/notesWorkspaceRuntime.ts:150-225`
- Modify: `src/features/notes/notesWorkspaceRuntime.ts:450-585`
- Modify: `src/features/notes/notesWorkspaceRuntime.ts:630-835`
- Modify: `src/features/notes/useNotesWorkspacePaneRegistry.ts:490-545`
- Modify: `src/features/notes/NotesOutlinePane.tsx:780-975`
- Modify: `src/features/notes/NotesOutlinePane.tsx:4740-4845`
- Test: `src/features/notes/NotesPageHeader.test.tsx:3160-3210`
- Test: `src/features/notes/useNotesWorkspace.sharedSession.test.tsx:1100-1225`

**Interfaces:**
- Consumes `NotesHistoryRecoveryEvent`.
- Produces:

```ts
export type NotesHistoryRecoveryState =
  | { readonly kind: "ready" }
  | { readonly kind: "recovering" }
  | { readonly kind: "blocked"; readonly error: string };
```

- Adds to `NotesStateSlice`:

```ts
historyRecovery?: NotesHistoryRecoveryState;
retryHistoryRecovery?(): Promise<void>;
reopenNotes?(): Promise<void>;
```

- [ ] **Step 1: Write failing runtime and UI tests**

In `useNotesWorkspace.sharedSession.test.tsx`, prove:

```ts
it("reports automatic history recovery and rearms drafts without a write error", async () => {
  // Trigger the typed prune mismatch.
  // Expect status feedback:
  // "Undo history was reset after the Notes session changed. Your notes and drafts are safe. You can keep editing."
  // Expect writeError to remain null and the draft to persist with a fresh context.
});
```

In `NotesPageHeader.test.tsx`, render a blocked state and assert:

```ts
expect(screen.getByRole("alert")).toHaveTextContent(
  "Notes could not finish recovery"
);
expect(screen.getByRole("button", { name: "Try recovery" })).toBeEnabled();
expect(screen.getByRole("button", { name: "Reopen Notes" })).toBeEnabled();
expect(screen.getByRole("button", { name: "Copy unsaved text" })).toBeEnabled();
```

Also assert that a `recovering` state does not render an alert or the phrase
“editing is paused.”

- [ ] **Step 2: Run the focused tests and confirm RED**

Run:

```bash
npm test -- src/features/notes/useNotesWorkspace.sharedSession.test.tsx src/features/notes/NotesPageHeader.test.tsx
```

Expected: recovery state/actions do not exist.

- [ ] **Step 3: Adopt coordinator events in the runtime**

Add one local state:

```ts
const [historyRecovery, setHistoryRecovery] =
  useState<NotesHistoryRecoveryState>({ kind: "ready" });
```

Handle the event before ordinary settlement:

```ts
if (event.type === "historyRecovery") {
  if (event.recovery.kind === "recovering") {
    setHistoryRecovery({ kind: "recovering" });
    engine.pauseForAuthorityRecovery();
    publishFeedback?.({
      kind: "status",
      message: "Restoring Undo history… You can keep typing."
    });
  } else if (event.recovery.kind === "recovered") {
    engine.resetHistoryContextsAfterSessionChange();
    engine.resumeAfterAuthorityRecovery();
    setHistoryRecovery({ kind: "ready" });
    publishFeedback?.({
      kind: "status",
      message: event.recovery.skippedOptimisticEnter
        ? "Undo history was reset. The last new bullet was not applied; try it again."
        : "Undo history was reset after the Notes session changed. Your notes and drafts are safe. You can keep editing."
    });
  } else {
    setHistoryRecovery(event.recovery);
    engine.pauseForAuthorityRecovery();
  }
  return;
}
```

Add actions:

```ts
const retryHistoryRecovery = useCallback(async (): Promise<void> => {
  await sessionRef.current?.retryHistoryRecovery();
}, []);

const reopenNotes = useCallback(async (): Promise<void> => {
  await draftEngineRef.current?.beginShutdown();
  globalThis.location.reload();
}, []);
```

Reset local recovery state to `{ kind: "ready" }` when `vaultRoot` changes.
Expose the state/actions through `NotesStateSlice` and forward them unchanged
for the secondary pane.

- [ ] **Step 4: Render only the hard failure as an alert**

In `NotesOutlinePane.tsx`, include blocked history recovery in the existing
write-lock decision:

```ts
const historyRecoveryBlocked = historyRecovery?.kind === "blocked";
```

Pass `lifecycleReadOnly || writeAuthorityLocked || historyRecoveryBlocked` to
the existing mutation-availability calculation and disabled props. Do not
redeclare the `lifecycleReadOnly` prop.

Build copy text without a new helper module:

```ts
const unsavedText = Object.values(draftsByNodeId)
  .flatMap((draft) => [draft.title, draft.note])
  .filter((value) => value.trim().length > 0)
  .join("\n\n");
```

Render:

```tsx
{historyRecovery?.kind === "blocked" && (
  <div className="notes-inline-error notes-write-error-banner" role="alert">
    <span>
      Notes could not finish recovery. Your current notes and drafts remain on
      screen, but saving is paused. Try recovery again. If it still fails,
      reopen Notes.
    </span>
    <button type="button" onClick={() => void retryHistoryRecovery?.()}>
      Try recovery
    </button>
    <button type="button" onClick={() => void reopenNotes?.()}>
      Reopen Notes
    </button>
    {unsavedText && (
      <button
        type="button"
        onClick={() => void writeSelectionClipboard(unsavedText)}
      >
        Copy unsaved text
      </button>
    )}
  </div>
)}
```

Reuse the existing button class. Do not add CSS unless the focused rendering
test proves the existing styles are insufficient.

- [ ] **Step 5: Run focused GREEN**

Run:

```bash
npm test -- src/features/notes/useNotesWorkspace.sharedSession.test.tsx src/features/notes/NotesPageHeader.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit the user-visible slice**

```bash
git add src/features/notes/notesWorkspaceTypes.ts src/features/notes/notesWorkspaceRuntime.ts src/features/notes/useNotesWorkspacePaneRegistry.ts src/features/notes/NotesOutlinePane.tsx src/features/notes/NotesPageHeader.test.tsx src/features/notes/useNotesWorkspace.sharedSession.test.tsx
git commit -m "feat(notes): explain history recovery"
```

---

### Task 5: Verify the complete recovery path

**Files:**
- No planned file changes. If a gate fails, return to the owning task, add a
  focused failing test there, and correct only that task's listed files.

**Interfaces:**
- Consumes the completed typed-error, coordinator, draft, and UI slices.
- Produces final automated and desktop evidence.

- [ ] **Step 1: Run the owning frontend tests**

Run:

```bash
npm test -- src/domain/notes.test.ts src/features/notes/notesDraftEngine.test.ts src/features/notes/notesWorkspaceCoordinator.test.ts src/features/notes/useNotesWorkspace.sharedSession.test.tsx src/features/notes/NotesPageHeader.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run the owning Rust tests**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml notes::error::tests
cargo test --manifest-path src-tauri/Cargo.toml notes::history::tests
```

Expected: PASS.

- [ ] **Step 3: Start a fresh desktop process with an isolated Vault**

Run the established Tauri development command:

```bash
npm run tauri:dev
```

Use a disposable Vault, create history, force the TEMP history generation to
change, and then type and press Enter.

Expected:

- The raw ownership error never appears.
- Text remains visible and saves with a fresh history entry.
- A preallocated Enter is either completed before reset or rolled back with
  “try it again”; it is never duplicated.
- The success status says Notes/drafts are preserved.
- New edits and new Undo work after recovery.

- [ ] **Step 4: Prove the hard fallback**

Force `clearHistory` to fail in the isolated development run.

Expected:

- Only then does saving become paused.
- The alert explains what remains on screen.
- `Try recovery` succeeds after the injected failure is removed.
- `Copy unsaved text` copies the local draft.
- `Reopen Notes` performs shutdown before reload.

- [ ] **Step 5: Run final gates once**

Run:

```bash
npm test
npm run lint
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
git diff --check
```

Expected: all commands PASS. Record pre-existing warnings separately; do not
rerun a flaky test merely to obtain a pass.

- [ ] **Step 6: Review the final diff and commit only if verification changed files**

```bash
git status --short
git diff --check
```

If Task 5 required a correction:

```bash
git add src-tauri/src/notes/history.rs src-tauri/src/notes/error.rs src/domain/notes.ts src/domain/notes.test.ts src/features/notes/notesWorkspaceCoordinator.ts src/features/notes/notesWorkspaceCoordinator.test.ts src/features/notes/notesDraftEngine.ts src/features/notes/notesDraftEngine.test.ts src/features/notes/notesWorkspaceTypes.ts src/features/notes/notesWorkspaceRuntime.ts src/features/notes/useNotesWorkspacePaneRegistry.ts src/features/notes/NotesOutlinePane.tsx src/features/notes/NotesPageHeader.test.tsx src/features/notes/useNotesWorkspace.sharedSession.test.tsx
git commit -m "fix(notes): finish history recovery"
```

# Notes Batch Indent Selection Preservation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the exact multi-row selection active while a successful `Tab` or `Shift+Tab` batch moves that block, without changing selection-clearing behavior for complete, delete, move, or other structural commands.

**Architecture:** Carry an optional `preserveSelection` policy with the structural queue's `pending` event. The workspace hook will still enter loading state for every structural command, but it will skip the selection clear only for a command that explicitly carries that policy. `applyBatchCommand` will opt in only for `indent` and `outdent`, allowing the existing anchor/head IDs to re-materialize naturally against the settled visible row order.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, existing Notes workspace coordinator and selection reducer.

## Global Constraints

- Preserve selection only for batch `indent` and `outdent`; all existing destructive and navigation invalidation rules remain unchanged.
- Do not change the Rust backend, storage schema, batch payload, history grouping, focus behavior, or row ordering rules.
- Do not restore selection after settlement; it must remain live throughout the pending period so there is no visual flicker or stale async restoration.
- Do not commit unless the user explicitly requests a commit.

---

### Task 1: Command-specific selection retention

**Files:**
- Modify: `src/features/notes/NotesWorkspace.test.tsx:2488-2590`
- Modify: `src/features/notes/notesWorkspaceCoordinator.ts:89-125, 635-710`
- Modify: `src/features/notes/useNotesWorkspace.ts:684-689, 1237-1251, 1458-1470, 1889-1975`
- Modify: `src/features/notes/notesCommands.ts:539-590`

**Interfaces:**
- Consumes: `NotesSelection { anchorId, headId }`, `StructuralCommandOptions`, and `NotesWorkspaceCoordinatorSession.enqueueStructural`.
- Produces: `enqueueStructural(work, { preserveSelection?: boolean })` and a matching optional flag on the coordinator `pending` event; no public store or backend API change.

- [x] **Step 1: Write the failing rendered regression test**

Add parameterized `Tab` and `Shift+Tab` cases to the existing `multi-node batch operations` suite. Each case must select two rows with `Shift+ArrowDown`, execute the shortcut, wait for the expected `applyBatch` payload, and assert that both stable node IDs still have `data-range-selected="true"` after the authoritative workspace settles.

```ts
const selectedOutlineIds = () =>
  Array.from(
    document.querySelectorAll(
      '[data-outline-id][data-range-selected="true"]'
    )
  ).map((row) => row.getAttribute("data-outline-id"));

await waitFor(() => expect(selectedOutlineIds()).toEqual(["a", "b"]));
```

Use a non-selected preceding sibling for the `Tab` case and a shared parent for the `Shift+Tab` case so both commands are eligible. The test-specific `applyBatch` mock must return the corresponding moved hierarchy, proving the range survives re-materialization rather than only the initial pending event.

- [x] **Step 2: Run the regression test and verify RED**

Run:

```bash
npm test -- src/features/notes/NotesWorkspace.test.tsx -t "keeps the selected rows selected after batch"
```

Expected: both cases fail because the selected ID list becomes `[]` when `pending` triggers `setLoading`.

- [x] **Step 3: Relay the structural selection policy through the coordinator**

Extend only the structural enqueue path:

```ts
export type NotesWorkspaceCoordinatorEvent =
  | { type: "pending"; preserveSelection?: boolean }
  | {
      type: "synchronized";
      result: NotesWorkspaceQueueSettlement;
      hasPendingWork: boolean;
      sourceScope: NotesWorkspaceScope | null;
    }
  | {
      type: "settled";
      result: NotesWorkspaceQueueSettlement;
      hasPendingWork: boolean;
    };

enqueueStructural(
  work: NotesWorkspaceQueueWork,
  options?: { preserveSelection?: boolean }
): Promise<NotesWorkspaceCommandOutcome>;
```

When `enqueueStructural` creates its non-silent queue item, include `preserveSelection: true` on the emitted `pending` event only when requested. Keep default event behavior unchanged for every existing caller.

- [x] **Step 4: Make selection invalidation policy-aware in the workspace hook**

Add `preserveSelection?: boolean` to `StructuralCommandOptions` and buffered structural command metadata. Pass it into `session.enqueueStructural` for both live and buffered commands.

Move the `setLoading` selection clear out of the generic `applyAction` invalidation condition and into the `pending` event branch:

```ts
if (event.type === "pending") {
  applyAction({ type: "setLoading" });
  if (!event.preserveSelection && selectionRef.current !== null) {
    selectionRef.current = null;
    dispatchSelection({ type: "clearSelection" });
  }
  return;
}
```

Keep `focusNode`, `setZoomRoot`, and `startWorkspaceLoad` in `applyAction`'s existing selection invalidation condition.

- [x] **Step 5: Opt in only batch indent and outdent**

Pass the structural option from `applyBatchCommand`:

```ts
const preserveSelection = op.type === "indent" || op.type === "outdent";
return ctx.runStructuralCommand(
  "batch",
  async (context, historyContext) => {
    const before = confirmedState(context);
    const ids = nodeIds.filter((id) => Boolean(before.nodesById[id]));
    if (ids.length === 0) {
      return { kind: "skipped" };
    }
    const mutation = unwrapNotesMutation(
      await context.repository.applyBatch(
        context.vaultRoot,
        buildApplyBatchInput(ids, op),
        ...historyArguments(historyContext)
      )
    );
    const projection = await projectNotesMutation(
      context,
      mutation,
      ctx.activeScopeRef.current
    );
    ctx.rememberHistoryAfter(
      appliedHistoryContext(historyContext, mutation),
      projection.workspace,
      uiUpdate
    );
    return directMutationResult(mutation, projection, uiUpdate);
  },
  { preserveSelection }
);
```

Update the nearby command comments to state that identity-preserving indent/outdent keep the live range, while all other batch operations retain the default clearing policy.

- [x] **Step 6: Run focused GREEN and selection-policy regressions**

Run:

```bash
npm test -- src/features/notes/NotesWorkspace.test.tsx -t "keeps the selected rows selected after batch"
npm test -- src/features/notes/useNotesWorkspace.test.tsx -t "selection|batch"
npm test -- src/features/notes/notesWorkspaceCoordinator.test.ts src/features/notes/outlineKeyboard.test.ts
```

Expected: the new `Tab` and `Shift+Tab` cases pass; completion and ordinary structural mutation tests still assert `selection === null`; coordinator and resolver suites pass.

- [x] **Step 7: Run complete verification and review the final diff**

Run:

```bash
npm test
npm run lint
npm run build
git diff --check
git status --short
```

Expected: all commands exit successfully; only the plan, focused TypeScript implementation, and regression tests are modified. Leave the changes uncommitted.

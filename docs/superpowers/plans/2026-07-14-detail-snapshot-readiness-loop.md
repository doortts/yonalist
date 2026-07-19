<!-- reconciliation: auditedHead=ec8a9ff3d016449255992adf70e128ea5e222e9a status=complete -->
> **증거 대조 상태 (2026-07-19): 완료.** commit·artifact 근거는 [감사 ledger](../reports/2026-07-19-historical-plan-ledger.json)에 기록했다.

# Detail Snapshot Readiness Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the detail pane from alternating between cached and live renders while preserving snapshot loading and incremental long-thread rendering.

**Architecture:** Readiness remains owned by `useDetailContentPaintReady`, but only live Markdown contributes to its count. `CommentThread` derives the first visible batch directly from current props so late-arriving ordinary threads do not depend on a transition; only later batches use scheduled transitions.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, Vite, Tauri 2.

## Global Constraints

- Preserve the render snapshot performance optimization.
- Exclude snapshot-overlay descendants from live readiness calculation.
- Render up to `COMMENT_MOUNT_BATCH` comments synchronously when comments arrive after an initially empty render.
- Do not redesign detail caching, Markdown rendering, comment pagination, styling, or animation.
- Add regression coverage for both the readiness and late-comment conditions.

---

### Task 0: Restore App test cache isolation

**Files:**
- Modify: `src/App.test.tsx`

**Interfaces:**
- Consumes: `clearDetailRenderSnapshots(): void` from `src/services/detailRenderCache.ts`.
- Produces: an App-test `beforeEach` that starts without snapshots captured by earlier tests.

- [x] **Step 1: Confirm the baseline failure pattern**

Run the full suite and the failing test in isolation. The full suite must show duplicate `Write a comment` inputs while the isolated test passes, demonstrating leaked timing-sensitive module cache rather than a deterministic component duplicate.

- [x] **Step 2: Clear detail snapshots in App test setup**

Import `clearDetailRenderSnapshots` and call it with the other cache resets:

```ts
import { clearDetailRenderSnapshots } from "./services/detailRenderCache";

beforeEach(() => {
  // existing setup
  clearDetailRenderSnapshots();
});
```

- [x] **Step 3: Run the full suite**

Run: `npm test`

Expected: the previously failing online-return test and the complete suite PASS.

- [x] **Step 4: Commit the isolation fix**

```bash
git add src/App.test.tsx docs/superpowers/plans/2026-07-14-detail-snapshot-readiness-loop.md
git commit -m "test(app): isolate detail render snapshots"
```

### Task 1: Isolate live Markdown readiness

**Files:**
- Modify: `src/hooks/useDetailContentPaintReady.test.tsx`
- Modify: `src/hooks/useDetailContentPaintReady.ts`

**Interfaces:**
- Consumes: `useDetailContentPaintReady(ref, activeDetailKey, detailReady, expectedMarkdownBodies): boolean`
- Produces: the same public hook signature with snapshot-overlay descendants excluded from its internal count.

- [x] **Step 1: Write the failing overlay-isolation test**

Extend the existing test harness with an optional snapshot body list and add this test:

```tsx
function Harness({
  activeDetailKey = "item:1",
  detailReady = true,
  expectedMarkdownBodies,
  rendered,
  snapshotRendered = []
}: {
  activeDetailKey?: string | null;
  detailReady?: boolean;
  expectedMarkdownBodies: number;
  rendered: boolean[];
  snapshotRendered?: boolean[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const ready = useDetailContentPaintReady(
    ref,
    activeDetailKey,
    detailReady,
    expectedMarkdownBodies
  );
  return (
    <>
      <div ref={ref}>
        {snapshotRendered.length > 0 && (
          <div data-detail-render-snapshot-overlay="true">
            {snapshotRendered.map((isRendered, index) => (
              <div
                data-markdown-body="true"
                data-markdown-rendered={isRendered ? "true" : "false"}
                key={index}
              />
            ))}
          </div>
        )}
        {rendered.map((isRendered, index) => (
          <div
            data-markdown-body="true"
            data-markdown-rendered={isRendered ? "true" : "false"}
            key={index}
          />
        ))}
      </div>
      <output aria-label="content-ready">{ready ? "ready" : "waiting"}</output>
    </>
  );
}

it("ignores rendered Markdown inside the snapshot overlay", () => {
  render(
    <Harness
      expectedMarkdownBodies={2}
      rendered={[true]}
      snapshotRendered={[true, true]}
    />
  );

  expect(screen.getByLabelText("content-ready")).toHaveTextContent("waiting");
});
```

- [x] **Step 2: Run the focused test and verify RED**

Run: `npm test -- --run src/hooks/useDetailContentPaintReady.test.tsx`

Expected: FAIL because the hook returns `ready` after counting the two snapshot Markdown bodies.

- [x] **Step 3: Exclude snapshot descendants from the count**

Replace the raw `NodeList.length` check with:

```ts
const renderedBodies = Array.from(
  root.querySelectorAll(
    '[data-markdown-body="true"][data-markdown-rendered="true"]'
  )
).filter(
  (body) =>
    !body.closest('[data-detail-render-snapshot-overlay="true"]')
);
return renderedBodies.length >= expectedMarkdownBodies;
```

- [x] **Step 4: Run the focused test and verify GREEN**

Run: `npm test -- --run src/hooks/useDetailContentPaintReady.test.tsx`

Expected: all tests in the file PASS.

- [x] **Step 5: Commit the readiness fix**

```bash
git add src/hooks/useDetailContentPaintReady.ts src/hooks/useDetailContentPaintReady.test.tsx
git commit -m "fix(inbox): isolate live detail readiness"
```

### Task 2: Render late-arriving first comments synchronously

**Files:**
- Modify: `src/components/CommentThread.test.tsx`
- Modify: `src/components/CommentThread.tsx`

**Interfaces:**
- Consumes: `CommentThreadProps.comments: ConversationComment[]` and `COMMENT_MOUNT_BATCH`.
- Produces: unchanged `CommentThread` props and DOM structure; only the first-batch scheduling behavior changes.

- [x] **Step 1: Write the failing late-comment test**

Add this test to `CommentThread.test.tsx`:

```tsx
it("renders the first batch immediately when comments arrive after mount", () => {
  const { container, rerender } = render(<CommentThread comments={[]} />);

  rerender(<CommentThread comments={[comments[0]]} />);

  expect(container.querySelectorAll(".comment-item")).toHaveLength(1);
});
```

- [x] **Step 2: Run the focused test and verify RED**

Run: `npm test -- --run src/components/CommentThread.test.tsx`

Expected: FAIL with zero `.comment-item` elements because `mountedCount` initialized to zero.

- [x] **Step 3: Derive and schedule from the current visible count**

Use the current comment length to expose the first batch immediately:

```tsx
const firstBatchCount = Math.min(COMMENT_MOUNT_BATCH, comments.length);
const visibleCount = Math.max(mountedCount, firstBatchCount);

useEffect(() => {
  if (visibleCount >= comments.length) {
    return;
  }
  return requestMountFrame(() => {
    startMountTransition(() => {
      setMountedCount(
        Math.min(visibleCount + COMMENT_MOUNT_BATCH, comments.length)
      );
    });
  });
}, [visibleCount, comments.length, startMountTransition]);

const visibleComments =
  visibleCount >= comments.length
    ? comments
    : comments.slice(0, visibleCount);
```

- [x] **Step 4: Run the focused test and verify GREEN**

Run: `npm test -- --run src/components/CommentThread.test.tsx`

Expected: all tests in the file PASS.

- [x] **Step 5: Commit the first-batch fix**

```bash
git add src/components/CommentThread.tsx src/components/CommentThread.test.tsx
git commit -m "fix(inbox): render late first comment batch"
```

### Task 3: Verify the complete fix

**Files:**
- Verify only: all files modified in Tasks 1 and 2.

**Interfaces:**
- Consumes: the two fixes and the existing project scripts.
- Produces: verification evidence; no new production API.

- [x] **Step 1: Run focused regression tests together**

Run:

```bash
npm test -- --run \
  src/hooks/useDetailContentPaintReady.test.tsx \
  src/components/CommentThread.test.tsx \
  src/hooks/useDetailRenderSnapshotCapture.test.tsx \
  src/components/DetailRenderSnapshotOverlay.test.tsx
```

Expected: all focused tests PASS.

- [x] **Step 2: Run the full test suite**

Run: `npm test`

Expected: zero failed test files and zero failed tests.

- [x] **Step 3: Run lint and production build**

Run: `npm run lint && npm run build`

Expected: both commands exit zero without new warnings.

- [x] **Step 4: Verify the running Tauri window**

Allow Vite HMR to apply the source changes, then sample the current Yonalist window repeatedly. Confirm that the selected `arc-agent` discussion `#79` no longer alternates between two full-pane render states and that its comment card appears in the live pane.

- [x] **Step 5: Inspect the final diff and repository state**

Run: `git status --short && git log -3 --oneline`

Expected: the worktree is clean and the plan plus both implementation tasks are present in the recent commit history.

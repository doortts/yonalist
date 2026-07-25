# Notes Next-Frame Enter Plan Adversarial Review

## Review target

- Plan: `docs/superpowers/plans/2026-07-26-notes-next-frame-enter-and-outline-windowing.md`
- Design: `docs/superpowers/specs/2026-07-26-notes-next-frame-enter-and-outline-windowing-design.md`
- Production baseline: `c3b18a8`, whose executable source matches `65a3edb`
- Review mode: assume each ambiguous instruction is implemented in the
  easiest locally plausible way, then look for lost data, blocked key repeat,
  invalid measurement, DOM/list breakage, windowing regressions, and hidden
  full-list work.

No production code was changed or benchmarked during this review.

## Verdict

**Approve the revised plan for task-by-task execution.**

The first draft had six blocking and seven high-risk gaps. They were
corrected in the plan and, where they changed an architectural invariant, in
the design document. No known blocker remains on paper. The implementation
must still stop at the desktop checkpoints because WebKit scheduling,
`@dnd-kit` behavior, variable-height correction, and external projection
layout cannot be proven from unit tests alone.

## Findings and corrections

| ID | Severity | Adversarial failure | Correction applied |
| --- | --- | --- | --- |
| A1 | Blocker | The draft gave each controller a “pane scroll host” without noticing that both Notes panes currently sit inside the same outer `.detail-scroll`. An implementer could make both controllers write the same `scrollTop`, preserving the pulling and coupling the panes. | Task 5 now creates independent primary/secondary vertical scroll hosts, prevents the outer detail scroller from competing, persists each logical anchor/offset, restores responsive behavior, and tests that one pane cannot move the other. |
| A2 | Blocker | The view store carried the inserted row but no source-title override. A mid-title split could show the old source text until the full projection committed. The normal optimistic projection could then contain the inserted ID while the local overlay inserted it again. | The store now carries token-keyed source-prefix and inserted-suffix overrides, deduplicates a provisional ID already present in the base, rebases unrelated publications by ID, and clears only on exact-token settlement or rollback. |
| A3 | Blocker | Moving the row-local `structuralCommandInFlightRef` into one pane controller as a Boolean would block every held-Enter repeat until the first command settled. | Task 1 specifies `inFlightBySourceId: Map<NoteId, number>`. It rejects duplicate work from one source while allowing the newly projected row to issue the dependent repeat. A four-repeat unresolved-first-command test is required. |
| A4 | Blocker | The benchmark draft mapped an Enter operation to its split ID after applying the editor session. The `editor-session` mark could arrive before the collector knew which physical keydown owned it. Its singular active-operation field also made overlapping held repeats either invalid or wrongly attributed. | Task 0 now groups related records by physical gesture and repeat index, keeps operation-scoped pre-paint commit accounting, counts post-paint work once per gesture, and treats only unrelated overlap as invalid. Task 3 binds `keydown` to the new ID before preparation/session marks. |
| A5 | Blocker | A single `useSyncExternalStore` snapshot would make both the pane and editor subscribe to every value change. Normal typing could re-render `NotesOutlinePane` and the whole window, recreating the performance problem in another store. | The store now has cached editor and structure snapshots with separate subscriptions. Normal typing notifies only the editor; order, provisional, hydration, and reconciliation changes notify the pane structure. |
| A16 | Blocker | The fast Enter task needed the inserted row's logical top before the original sequence introduced the window model. An implementer would either read layout after keydown or place the persistent editor from stale geometry, violating the first-frame contract. | Task 2 now installs the basic offset/splice index with the persistent editor and stores top, total-row height, and title height in the session. Task 3 splices and reads that index without a layout read; Task 4 extends the same model with complete variable-height windowing. |
| A6 | High | The persistent textarea is outside the row map. Existing code often resolves the active row with `closest("[data-outline-id]")`; keyboard, copy/cut/paste, selection, attachment targeting, focus recovery, and probes could return no node. Giving the overlay `data-outline-id` would instead create a duplicate logical row in DOM queries. | Task 2 adds `outlineNodeIdFromEventTarget`, using `data-editor-node-id` for the pane editor and row ancestry for row-local fields. It replaces every affected ownership lookup and explicitly forbids a duplicate `data-outline-id`. |
| A7 | High | Putting a textarea directly under `<ol>` or positioning it relative to `.notes-outline-content` would either create invalid list markup or require a page-header offset read on the critical path. It would also detach the textbox from the active row's accessible structure. | The editor lives in one persistent, absolutely positioned `<li role="presentation">` under the list. Its top is list-relative, and the active logical row associates it with `aria-owns`. |
| A8 | High | The draft used one height cache for both editor title height and total row height. Measuring a title could overwrite space occupied by a supporting note or attachment and collapse the row. | Task 5 separates title and total-row caches. An editor change applies a known title delta to the total and lets the row observer confirm it. |
| A9 | High | “Pin selected rows” could be interpreted as mounting thousands of selected IDs, defeating windowing. Row-local note/menu/date state could also vanish when another reason released a shared pin. | Only selection anchor/head are pinned; selection membership remains logical. A reason-counted pin registry keeps a row until all active interactions release it and resets on Vault replacement. |
| A10 | High | Current pointer collision code obtains all candidate rectangles from mounted dnd-kit droppables. Windowing removes off-screen rectangles, and `verticalListSortingStrategy` cannot safely transform a list full of missing DOM. The draft also omitted keyboard drag. | Task 7 synthesizes logical rectangles from the height model, lets mounted rectangles override them, supplies only mounted/pinned IDs to `SortableContext`, returns a custom collision for off-screen targets, and adds a window-aware keyboard coordinate resolver. |
| A11 | High | Flat `logicalIndex + 1` and total row count are incorrect `aria-posinset`/`aria-setsize` values for nested siblings. | Task 4 derives positions among rows with the same parent; Task 6 applies those values only to mounted list items. |
| A12 | High | Treating GitHub Notifications like an ordinary row could unmount its expanded external children independently, corrupt block height, or hand a plugin row to the ordinary editor. | Task 6 treats the root and external children as one measured composite block and keeps the zoomed external page specialized. Plugin/read-only/external rows never claim the ordinary pane editor. |
| A13 | Medium | Off-screen rows start without measured heights. Assuming 28 px for notes and images can make offset lookup jump badly on first fast scroll, especially after pane width changes. | Task 4 adds deterministic content/aspect-ratio estimates, width-bucketed observed heights, Vault reset, and anchor-preserving remeasurement. |
| A14 | Medium | “Publish the inactive pane after paint” lacked an owner and operation identity. Five held repeats could release stale inactive revisions out of order, or pane activation could run before promotion. | Task 8 adds an operation-scoped `NotesPanePresentationGate`, held-gesture coalescing, guarded paint release, and `promoteNow()` before the activating command. |
| A15 | Medium | The position-swap diagnostic named a data attribute but did not define how it changed physical columns without persisting user layout or changing text direction. | Task 0 now uses a benchmark-only collector shortcut that applies and later removes inline grid columns while preserving pane identity, layout state, and direction. |

## Attempts to break the revised sequence

### Held Enter with unresolved persistence

The revised order allocates and binds the logical operation, prepares the
existing coordinator command, applies the local source/inserted title
overrides, moves the same editor, and then admits the queued command. The
source-keyed in-flight map permits the next provisional source to repeat while
rejecting a duplicate from the old source. Exact-token reconciliation prevents
an older settlement from clearing a newer editor session.

Result: covered by Tasks 1 and 3; no remaining design contradiction found.

### Dirty edit followed by pointer, Arrow, F6, note focus, Vault switch, or close

Because the textarea persists, these paths cannot depend on native blur.
`releaseTitleSession(reason)` captures value and selection before ownership
changes. Plain Enter remains a separate atomic path that sends the current
draft with the insertion. Split close and Vault/normal close continue to wait
on the existing drain after the session is released.

Result: covered by Task 1 controller tests and Task 9 desktop drain proof.

### Large multi-selection and windowed drag

Only anchor/head and live drag targets are pinned. The selection forest stays
in model state. Pointer and keyboard target lookup use complete logical rows
and model-derived rectangles, not a hidden full-list DOM.

Result: covered by Tasks 6 and 7. Desktop testing remains mandatory because
dnd-kit sensor and announcement behavior is runtime-bound.

### Wrapped titles, notes, attachments, and pane-width changes

Title height does not replace total row height. Initial estimates use known
content and image aspect ratio; observations are width-bucketed. Corrections
above the viewport update the logical anchor through one explicit scroll
write.

Result: unit-testable arithmetic is covered by Tasks 4 and 5. Visual stability
still requires the two desktop checkpoints.

### Inactive secondary pane during held Enter

Editor/structure updates are active-pane local. The presentation gate keeps
actions and authority live but coalesces inactive presentation until a guarded
active paint opportunity. Activating the secondary pane promotes the latest
revision before its command.

Result: covered by Task 8 and the frozen pre-paint commit counter.

## Verification of the plan document

- Spec coverage was remapped after the corrections; every accepted
  architecture section has an implementation task and a runtime checkpoint.
- Placeholder scan found no `TBD`, `TODO`, “implement later,” undefined
  “similar to,” or generic error-handling step.
- Shared type names were checked across tasks. Editor/structure snapshots,
  exact optimistic tokens, content-coordinate row rectangles, pane-local
  scroll ownership, interaction pins, and the presentation gate have one
  declared meaning.
- Benchmark language consistently distinguishes a first animation-frame paint
  opportunity from actual pixel presentation.
- The temporary benchmark config is generated outside tracked native
  configuration, so the production change remains frontend-only.
- The plan contains 10 tasks and 101 tracked steps. Its 142 fenced-code markers
  are balanced, and the executable portion contains zero placeholder patterns.
- `git diff --check` and no-index whitespace checks passed for the modified
  design and both new documents.
- `npm run test:plans` did not reach the new plan. The repository-wide checker
  stopped on the pre-existing historical reference
  `901ebc1d2763b297a9c371757a9bedf18a3a1627` in
  `2026-07-10-notes-discovery-and-resilience.md`, reporting that the commit is
  unreachable. This review did not rewrite unrelated historical evidence.

## Residual risks and stop conditions

1. WebKit may still miss the 16 ms p95 despite the architectural cut. If Task
   3 does not materially improve the frozen desktop result, stop before adding
   windowing and profile the editor/store commit.
2. Model-derived dnd-kit targets may differ from sensor behavior during rapid
   autoscroll. Any pointer or keyboard destination mismatch stops Task 7.
3. Height estimates cannot be exact before measurement. Any blank flash,
   reversed anchor correction, or first-line jump stops Tasks 5-6.
4. The external notifications composite block has specialized focus and
   projection behavior. Any editor loss or incorrect block height stops Task
   6.
5. Automated ARIA assertions do not replace a VoiceOver smoke test for the
   persistent `aria-owns` relationship.
6. No benchmark result should be reported until the Task 0 harness reproduces
   the current slowdown with the new paint-opportunity clock.

With these stop conditions, the revised plan is detailed enough to execute
without making a storage, history, or native-boundary decision during
implementation.

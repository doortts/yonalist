# Backspace at an image's before-station takes the image sibling above (2026-08-21)

User request (verbatim, with a screenshot of two image rows stacked directly
on top of each other): "만약 스샷처럼 현재 이미지 블릿 앞 블릿도 이미지 블릿인
경우에는 이미지 블릿의 시작지점에 커서가 있을때 backspace 를 누르면 윗 형제
블릿의 이미지를 삭제하도록 동작해줘. 실제 커서 동작의 일관성있게 말야"

This narrowly overrules Decision 1 of `2026-08-20-image-backspace-delete.md`:
the before-station stays inert in general, but when the row standing directly
behind the caret is itself an image sibling, Backspace takes it — the same act
the after-station already performs, one row boundary back, the boundary a text
caret crosses without ceremony. The direction is the user's, reaffirmed after
seeing the shipped behavior; only the boundaries are argued here.

## Goal

Plain Backspace at an image's before-station, when the previous visible row is
an image with the same parent, moves that upper image (subtree included) to
Trash and leaves the caret exactly where it stood.

## Contract

| Field | Content |
| --- | --- |
| Goal | See above — one observable outcome: Backspace before an image takes the image sibling standing behind the caret, caret unmoved. |
| Acceptance | Rows A1–A5 below. |
| Non-goals | Listed below. |
| Boundaries | React only: `outlineKeyboard.ts` (resolver + intent type), `outlineSupport.ts` (dispatch). The existing `{ kind: "deleteSubtree", id }` command carries the delete — no IPC, Rust, SQLite, schema, or file-format change. |
| Manual proof | Below. |

### Acceptance rows

| # | Observable pass/fail |
| --- | --- |
| A1 | Resolver: plain Backspace, no band, `imageEdge: "before"`, previous visible row an image with the same parent → `{ kind: "trash", nodeId: <upper image id> }`. |
| A2 | Resolver: same position, `repeat: true` → `{ kind: "consume" }` — one picture per press. |
| A3 | Resolver refusals hold: bullet directly above → `null`; image directly above at another depth → `null`; image above that is the caret's own parent → `null`; image sibling above but with a visible child row between → `null`; first visible row → `null`. |
| A4 | Mounted: Backspace at the lower image's before-station issues `{ kind: "deleteSubtree", id: <upper> }`; one ⌘Z brings the upper image back (manual). |
| A5 | Mounted: after the command resolves, the same before-station element still has focus — the caret has not moved, and focus is not on `document.body` or any other row. |

### Non-goals

- The after-station and the focused picture: unchanged (A1/A2 of the shipped
  design keep their tests and their behavior, caret handoff included).
- The band path: unchanged. The new arm sits inside the shipped
  `!input.hasSelection` guard, so a banded image keeps falling through to the
  one band rule.
- The refusal locks from d5be9200: Delete, ⇧⌫, ⌘⌫, ⌥⌫, ⌃⌫ keep resolving
  `null` on every image surface; ⌘⇧⌫ keeps resolving bare `trash` through
  `resolveOutlineKey`. The modifier guard sits outside the before arm, so a
  widening that reached the before-station would trip the existing after-edge
  locks first.
- The zoomed-image page header: `handleImagePageKeyDown` resolves with
  `target: "page"` and never calls `handleImageNodeKeyDown`; a zoom-root image
  is also never in `visibleNodes`, so it can never be anyone's "previous
  visible row". Inert without a code change.
- Held Backspace eating several images per hold: rejected (Decision 4).
- A text row's own head-of-line Backspace reaching an image above it: that is
  `resolveOutlineKey`'s territory and a different surface. A pre-existing
  defect there (mergeBackward can name an image sibling and weld its filename
  onto the text) is flagged as its own task, not folded in here.
- No new dependency, abstraction, schema, or migration work.

### Manual proof (desktop app)

1. In a note, make a text row, then paste two screenshots one after another
   (two stacked image rows), then a text row below.
2. Caret in the text row above; ArrowDown lands on the upper image's
   before-station, ArrowDown again on the lower image's before-station.
3. Backspace → the **upper** image goes to Trash; the caret is still standing
   before the remaining image (no visible focus move).
4. ⌘Z → the upper image returns.
5. Hold Backspace at the lower before-station → exactly one image goes.
6. Regression sweep: Backspace at the lower image's **after**-station still
   deletes the lower image itself (caret lands on the upper image's
   after-station — see baseline); Delete/⇧⌫/⌘⌫ at the before-station still do
   nothing; select an image (⇧→) and confirm Backspace still trashes through
   the band.

## Baseline (verified against this worktree)

- `outlineKeyboard.ts:791-801` — the shipped plain-Backspace arm: band
  excluded (`!input.hasSelection`), `imageEdge === "before"` returns `null`,
  otherwise `repeat ? consume : trash`. The `null` is the single line this
  design replaces with a lookup.
- `resolveOutlineKey`'s own head-of-line Backspace (`:677-711`) reads
  `previous = visibleNodes[index - 1]` and acts only when that row is a
  same-parent sibling (mergeBackward) or the parent itself (mergeIntoParent).
  The app's existing text-caret model is therefore visible-adjacency AND
  siblinghood, not pure visual adjacency — the new rule mirrors it.
- `executeRowIntent case "trash"` (`outlineSupport.ts:561-574`) — deletes
  `node.id` and hands the caret via `caretHandoff` (shipped in 25ca9042).
  The band arm (`:256`) intercepts `trash` before this switch, but only under
  `band.hasSelection`, which the new resolver arm excludes.
- `caretHandoff` (`outlineCaretHandoff.ts`) does **not** consult `holdsCaret`:
  it targets `visibleNodes[first - 1]` whatever its kind, and
  `focusAfterCommit` → `editorById` (`outlineFocus.ts:83-85`) resolves an
  image target with edge `"end"` to its after-station
  (`data-image-edge="after"`, a real focusable stop). So the shipped
  self-delete is **correct when the row above is an image**: the caret lands
  on the upper image's after-station — end of the previous line — where the
  next Backspace takes that image through the shipped after-station rule.
  Checked deliberately; no finding, no change. The stations carry
  `data-node-id` + `data-outline-field="image"` (`ImageNodeContent.tsx:229-237,
  431-439`), which is what `editorById` filters on.
- Rows are keyed by node id (`NotesOutline.tsx:587`, `key={node.id}`; the
  windowed gap items carry their own keys). Deleting the row above unmounts
  only that row's `<li>`; the lower image's station element is never detached,
  so focus survives the re-render in the real DOM and in jsdom alike.
- Resolver test fixture: `picture()` helper exists at
  `outlineKeyboard.test.ts:33` and is already used by the removeEmpty ladder
  tests. Mounted fixture: `imageCaretStation.test.tsx` boots exactly one image
  (`imageBoot()`); a dozen assertions key off its station count and neighbours,
  so that boot must not grow.

## Decisions

**1. How wide is "the row above": the previous visible row, when it is an
image with the same parent.** Both conditions, mirroring the shape the
head-of-line merge already has (`previous = visibleNodes[index-1]`, then a
parent comparison). 윗 형제 gives siblinghood; caret consistency gives visible
adjacency — Backspace takes what stands *directly* behind the caret, which is
the previous visible row, not a row hidden or displaced by depth. The cases
that separate the candidate rules:

- Image child of a collapsed row above: the previous visible row is the
  collapsed bullet, not its hidden image → `null`. Nothing visible stands
  behind the caret that this key may take.
- Image one level out (last visible descendant of the previous sibling, or an
  aunt): visibly adjacent but not a sibling → `null` — the same cross-parent
  reach the head-of-line merge refuses, so the two backward acts read as one
  caret model.
- Image row above that is the caret's own parent: parent ids differ → `null`
  by the same check, and rightly twice over — trashing the parent takes the
  caret's own row down with it, a self-annihilating Backspace nobody asked for.
- First visible row: no previous → `null`.
- Collapsed image sibling above: it *is* the previous visible row → eligible;
  its hidden subtree goes with it — the same subtree contract the shipped A1
  already established for every image trash, one ⌘Z away.
- Expanded image sibling with a visible child row between: the previous
  visible row is that child → `null`; the thing behind the caret is the child,
  and the child is a bullet, not this rule's to touch.

**2. The row above is not an image: `null` stays.** A text row behind a caret
already has a Backspace meaning at this boundary — merge — and an image
station has no text to merge into it. Deleting a whole text row from a
neighbour's station is no caret convention at all: text Backspace eats one
character or joins two lines, it never swallows the line above. Empty bullets
and to-dos are the same refusal. The `null` also keeps its shipped second job:
without it the before-station falls through to the hardwired `value: ""` call,
whose empty-row ladder resolves a command written for blank bullets.

**3. Intent shape: `{ kind: "trash", nodeId?: string }`, dispatch
`intent.nodeId ?? node.id`.** Weighed against a separate intent kind: a new
kind duplicates the delete arm and forces every switch over intents to learn a
second name for the same act; the optional field keeps one owner for "a row
goes to Trash". Every existing producer is untouched and keeps its meaning:

- ⌘⇧⌫ chord (`resolveOutlineKey:350`) and the band rule (`:526`) emit bare
  `trash` → `nodeId` absent → `node.id`, shipped handoff intact.
- The band dispatch arm (`selectionActions.delete()`) runs only under
  `band.hasSelection`, which the new resolver arm excludes — a `trash` naming
  a sibling can never be swallowed by the band path.
- The shipped after-station/picture arm emits bare `trash` → unchanged.

**4. Where the caret goes: nowhere.** For a self-delete the shipped handoff
stands. For a sibling delete the caret's own station survives the command, so
the dispatch does nothing at all with focus — the caret stays where it stood,
exactly as it does after eating a character. The dispatch tells the cases
apart by the target: `targetId !== node.id` → delete and return, no handoff
built. Focus survival is real, not hoped for: rows are keyed by node id
(`NotesOutline.tsx:587`), so React removes only the trashed row's element and
the focused station is never detached. The mounted test holds the element
reference across the delete and asserts it still has focus — that assertion is
the tripwire if keying or windowing ever changes to remount. No defensive
re-focus: a re-focus call would mask exactly that regression and is dead code
until it happens.

**5. Held Backspace: `repeat → consume`, one picture per press.** Same shape
as the shipped A6 and the band rule — the before-station is the same key one
boundary over, and the two arms share a branch. The text analogy breaks
precisely at undo: held text Backspace coalesces into one undo group through
the backspace gesture, but each image trash is its own undo step, so a stuck
key would cost one ⌘Z per lost picture. Press-by-press already serves the
caret argument: after each press the caret still stands before the surviving
stack, so N deliberate presses eat N pictures. (After a *self*-delete the
shipped handoff parks the caret on the upper image's after-station, where the
after-station rule continues the same press-by-press descent — the two rules
compose without either knowing about the other.)

**6. Everything else stays inert** — enumerated under Non-goals; none of it
needs a code change, and the existing locks (d5be9200's modifier/Delete loop,
the band tests, the layer-guard test) must all pass unchanged.

## Items (implementation order)

Every acceptance row maps to exactly one item; every item has one failing
test. Item 1 carries the dispatch's target line as well as the resolver,
because splitting them would leave a commit where the resolver names the upper
picture and the shipped dispatch deletes the lower one — a destructive-wrong
intermediate. What item 1 defers to item 2 is only caret placement, the same
benign gap the shipped pair 77ef1a5d → 25ca9042 left between its own items.

### Item 1 — Resolver names the picture behind the before-station (A1, A2, A3)

- Code, `apps/desktop/src/outline/outlineKeyboard.ts`:
  - The `trash` intent gains the field:
    `{ readonly kind: "trash"; readonly nodeId?: string }`. Comment to earn
    (~2 lines, why-prose): the row to take when it is not the caret's own —
    the before-station naming the picture behind it; absent, the caret's row
    goes.
  - The shipped `if (input.imageEdge === "before") return null;` becomes:

    ~~~
    imageEdge === "before":
      at       = visibleIndex.positionOf(nodeId) ?? findIndex
      previous = at > 0 ? visibleNodes[at - 1] : undefined
      current  = nodeById(structureNodes, nodeId, structureIndex)
      previous?.kind === "image" && current &&
        previous.parentId === current.parentId
        → repeat ? { kind: "consume" } : { kind: "trash", nodeId: previous.id }
      otherwise → null
    ~~~

  - Comment to earn (~6 lines, replacing the shipped comment at `:785-790`,
    why-prose, neighbour density): Backspace takes whatever stands behind the
    caret — from the station past the picture and from the picture itself,
    that is the picture; from the station before it, it is the previous
    visible row, and when that row is a picture of the same parent the key
    takes it the way the other station does, one row boundary back. Anything
    else behind the caret stays: a text row merges on its own surface and
    never dies to a neighbour's key, a picture at another depth is the reach
    the head-of-line merge also refuses, and the caret's own parent would take
    the caret's row down with it. The refusal still keeps the station out of
    the fall-through below, whose empty value would reach a command written
    for blank bullets; a band still falls through to the one rule that owns
    both delete keys.
- Code, `apps/desktop/src/outline/outlineSupport.ts` (`case "trash"`): insert
  `const targetId = intent.nodeId ?? node.id;` and point both the handoff
  (`caretHandoff(...)([targetId])`) and the command
  (`store.deleteSubtree(targetId)`) at it. No branch yet — caret placement is
  item 2's, and the mis-aimed handoff this leaves for one commit moves a caret
  without losing data.
- Test: `apps/desktop/src/outline/outlineKeyboard.test.ts`, new
  `it("takes the image sibling standing behind the before station")` beside
  the shipped Backspace test, with local fixtures built from the existing
  `node()`/`picture()` helpers:
  - stacked: `[node("first","page","First",1_024), picture("upper","page",2_048), picture("lower","page",3_072)]`
    → `input({ nodeId: "lower", key: "Backspace", imageEdge: "before", visibleNodes: stacked, structureNodes: stacked })`
    → `{ kind: "trash", nodeId: "upper" }` (A1);
  - same with `repeat: true` → `{ kind: "consume" }` (A2);
  - aunt: `[node("parent","page","Parent",1_024), picture("aunt","parent"), picture("lower","page",2_048)]`
    → `null` (A3);
  - parent: `[picture("upper","page"), picture("lower","upper")]` → `null` (A3);
  - visible child between: `[picture("upper","page"), node("cap","upper","Cap"), picture("lower","page",2_048)]`
    → `null` (A3);
  - first visible row: `[picture("solo","page")]`, `nodeId: "solo"` → `null` (A3);
  - bullet directly above: already pinned by the shipped test's
    `imageEdge: "before"` → `null` assertion (its previous visible row is a
    bullet) — that assertion is not repeated, it is re-read (see test-change
    list).
  - Comment to earn (~4 lines): from the before-station the row behind the
    caret is the previous visible row; a picture of the same parent is taken
    the way the after-station takes its own — the same act one boundary back.
    A picture at another depth, the caret's own parent, and a bullet all stay:
    the head-of-line merge draws the same lines, so the two backward keys read
    as one caret.
- Red today: the eligible and repeat assertions fail against the shipped
  blanket `null`.

### Item 2 — The caret stands still on a sibling delete (A4, A5)

- Code: `apps/desktop/src/outline/outlineSupport.ts`, `case "trash"` gains the
  early branch before the handoff is built:

  ~~~
  if (targetId !== node.id) {
    void store.deleteSubtree(targetId);
    return;
  }
  ~~~

  Comment to earn (~3 lines, why-prose): a trash aimed past the caret's own
  row leaves the key's surface standing, so there is nothing to hand on — the
  caret stays where it stood, the way it stands after eating a character.
  Building the handoff anyway would yank it to the trashed row's neighbour.
- Test: `apps/desktop/src/image/imageCaretStation.test.tsx`. The existing
  `imageBoot()` must not grow — a dozen assertions key off its single image's
  station indices — so the file gains a second boot in the same idiom:
  `stackedBoot()` = `[bullet-1 ("First thought"), imageNode (id "image",
  cat.png, sortKey 2_048), { ...imageNode, id: "lower", sortKey: 2_560,
  text: "dog.png", image: { ...imageNode.image, originalName: "dog.png" } },
  bullet-2 ("Second thought", sortKey 3_072)]` — the distinct name keeps the
  `findByRole("group", { name })` waits unambiguous. A small
  `stationsOf(view, "lower")` lookup (`.notes-image-caret-stop[data-node-id="lower"]`)
  reads the lower pair. New
  `it("takes the image above from the before station and stands its ground")`:
  focus the lower before-station, `fireEvent.keyDown(before, { key: "Backspace" })`,
  then
  `await waitFor(() => expect(notesApi.execute).toHaveBeenCalledWith(expect.objectContaining({ command: expect.objectContaining({ kind: "deleteSubtree", id: "image" }) })))`
  (A4) and `expect(before).toHaveFocus()` on the held element reference (A5 —
  also the keyed-row tripwire from Decision 4).
  - Comment to earn (~2 lines): the row this key deletes is not the row it
    stands on, so nothing unmounts under the caret and nothing may move it.
- Red after item 1, deterministically: the command already names `"image"`
  (green half), but item 1's handoff — aimed at the trashed row — lands the
  caret at the end of "First thought", so the focus assertion fails.

## Existing tests that must change

- `outlineKeyboard.test.ts:289-293` — the shipped test's leading comment
  ("the row behind that caret is not this key's to reach for") and the title's
  "never from ahead" now deny the new rule. Item 1 rewords both to scope the
  refusal to what it still refuses (a bullet behind the caret); **no assertion
  changes** — the `imageEdge: "before"` → `null` case keeps passing because
  its fixture's previous visible row is a bullet at another depth, and it now
  reads as the not-an-image refusal.
- Nothing else. Verified: d5be9200's modifier/Delete loop tests the after
  edge and the modifier guard is outside the new arm; the band assertions
  (`hasSelection` at the before-station → bare `trash`) still fall through
  untouched; `imageCaretStation.test.tsx` has no before-station Backspace;
  `outlineSupport.test.tsx`, `outlineShiftSelect.test.tsx`,
  `ImageNodeContent.test.tsx`, and `outlineCaretHandoff.test.ts` never see the
  new field — old producers emit `trash` without `nodeId`, so every `toEqual`
  pin holds.

## Gates

Frontend-only: `npm test`, `npm run lint`, `npm run test:bundle`,
`git diff --check`. Cargo/Clippy explicitly skipped — no Rust, IPC, or
persistence change.

## Risks / reviewer notes

- The same-parent check makes the rule narrower than a purely visual caret.
  Deliberate: the app's own head-of-line Backspace draws the same line, and
  윗 형제 is the literal ask. Widening later is one dropped condition, if ever
  asked.
- A collapsed image sibling takes its hidden subtree along — the shipped
  subtree contract, one ⌘Z back; called out in Decision 1 so the reviewer
  weighs it deliberately.
- Item 1's intermediate commit mis-places the caret (handoff aimed at the
  trashed sibling's neighbour) but deletes the right row; accepted as the same
  benign gap the shipped pair left, and it is what makes item 2's red
  deterministic.
- Separate pre-existing finding, not this change's: `resolveOutlineKey`'s
  mergeBackward branch (`outlineKeyboard.ts:697-710`) lacks the
  `previous.kind === "bullet"` guard its mergeIntoParent sibling has, so a
  text row's head-Backspace below a bare image sibling resolves a merge that
  removes the image and welds its filename onto the text
  (`projectMergeNodeBackward`, `optimisticOutline.ts:179`). Flagged as its own
  task; this design neither depends on nor fixes it.
- Checked and clean: the shipped self-delete caret is already right when the
  row above is an image (`caretHandoff` → `editorById` picks the upper image's
  after-station), so no change and no separate finding there.

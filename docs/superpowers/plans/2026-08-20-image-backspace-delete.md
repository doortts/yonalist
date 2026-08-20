# Backspace deletes an image node (2026-08-20)

User request (verbatim): "이미지를 선택하거나 이미지 뒤에 커서가 있을때 backspace 로
해당 첨부 이미지를 삭제하는 기능을 추가해줘" — plain Backspace deletes the
attached image node when the image is selected, or when the caret sits after
the image.

## Goal

Plain Backspace, pressed from the image's after-station, from the focused
picture itself, or with the image held in a row band, moves the image node
(subtree included) to Trash and leaves the caret somewhere it can type.

## Contract

| Field | Content |
| --- | --- |
| Goal | See above — one observable outcome: Backspace on/behind an image trashes it and re-seats the caret. |
| Acceptance | Rows A1–A7 below. |
| Non-goals | Listed below. |
| Boundaries | React only: `outlineKeyboard.ts` (pure resolver), `outlineSupport.ts` (dispatch), `ImageNodeContent.tsx` (key-surface guard). No IPC contract change — the existing `{ kind: "deleteSubtree", id }` command carries the delete. No Rust, SQLite, schema, or file-format change. |
| Manual proof | Below. |

### Acceptance rows

| # | Observable pass/fail |
| --- | --- |
| A1 | Caret at the after-station (`data-image-edge="after"`), plain Backspace: the app issues `{ kind: "deleteSubtree", id: <image> }`; the image row and its children leave the outline; one ⌘Z brings the row back with its caption. |
| A2 | The picture itself focused (accent ring), plain Backspace: same delete resolves (`trash` intent). |
| A3 | The image held in a band (solo-image selection or wider), plain Backspace from any image surface: the band's own delete runs (`deleteSubtrees`), band cleared — the same thing plain Delete already does with a band up. |
| A4 | Caret at the before-station, plain Backspace with no band: nothing — no command, no focus move. |
| A5 | After A1/A2, the caret sits at the end of the row above the image (start of the row below when there is none; the page heading as last resort) — not on `document.body`. |
| A6 | Held Backspace on an image surface deletes exactly one image; the repeats are consumed. |
| A7 | Backspace pressed while the image's row menu or the lightbox is open deletes nothing. |

### Non-goals

- Forward Delete on a bare station or the picture stays inert. (With a band
  up, Delete already trashes via the band rule at `outlineKeyboard.ts:519` —
  untouched.)
- The zoomed-image page header station (`handleImagePageKeyDown`,
  `target: "page"`): Backspace stays inert there. Deleting the page you are
  standing in strands the zoom root and needs its own contract.
- Lightbox keys beyond the A7 suspension — no "Backspace deletes from the
  lightbox".
- Focus behavior of the mouse delete paths (row menu Delete in
  `outlineMenuCommands.ts:242`, image menu "Move to Trash" in
  `ImageNodeContent.tsx:416`) — they keep their current focus behavior.
- The pre-existing inner-widget key leak while NO layer is open. Verified:
  `handleImagePrimaryKeyDown` reads every key that bubbles out of the image
  row's innards, so e.g. plain Enter on the focused menu-trigger button
  resolves `createSibling` and its `preventDefault` suppresses the button's
  own activation — the menu likely cannot be opened by Enter today. Same
  class: Cmd+X from an inner widget cuts the node. Pre-existing, one fix for
  the whole class belongs in its own change; this design only refuses to add
  Backspace to that leak where a layer is open (A7).
- No schema/format/migration work; no new dependency; no new abstraction.

### Manual proof (desktop app)

1. In a note with a text row above and below, attach an image (paste or drag).
2. Click the margin to the right of the image (caret parks at the
   after-station). Press Backspace → the image goes; the caret sits at the
   end of the row above; ⌘Z brings it back, caption included.
3. Arrow onto the picture (ring visible). Backspace → gone again. ⌘Z.
4. From the before-station (left of the picture) press Backspace → nothing.
5. Shift+→ from the before-station (solo-image band), Backspace → gone; ⌘Z.
6. Open the image's ⋮ menu, press Backspace → nothing deleted. Same with the
   lightbox open (double-click the picture).

## Baseline (verified against this worktree)

- `outlineKeyboard.ts:785-793` — `handleImageNodeKeyDown` blanket-returns
  `null` for plain Backspace. Added in 3d531729; it exists to keep Backspace
  out of the fall-through call to `resolveOutlineKey` (`:850`, hardwired
  `value: ""`), whose empty-row ladder would otherwise resolve `clearMarker`
  / `removeEmpty` — `beginRemoveEmptyNode` is a command built for blank
  bullets, and an image node carries its filename as text and possibly a
  caption subtree. The early return is also what blocks the band rule at
  `:518-527` (`hasSelection && Backspace|Delete → repeat ? consume : trash`),
  so even a banded image ignores Backspace today, while plain **Delete**
  with a band already falls through and trashes. All confirmed.
- `outlineSupport.ts:212` `handleImagePrimaryKeyDown` builds
  `imageEdge: imageEdgeOf(event.target)` — `"before"`/`"after"` from a
  station, `undefined` for the picture root *and for any inner widget*
  (menu trigger, menu items, resize handle, lightbox — React portals
  propagate events through the React tree). With `band.hasSelection`, a
  `trash` intent routes to `selectionActions.delete()` (`:255`); bare rows
  fall to `executeRowIntent`, whose `case "trash"` (`:560-562`) is
  `void store.deleteSubtree(node.id)` with **no caret handoff** — the focused
  station unmounts and focus drops to `document.body`. Confirmed; the same
  hole exists for the bullet trash chord (⌘⇧⌫), which shares that case.
- `outlineCaretHandoff.ts` `caretHandoff({nodes, visibleNodes,
  outlineRootId, scopeRef})` — build before the command, take after. The
  pane's `deleteSelection` (`NotesOutline.tsx:325`) and
  `cutRow`/`cutImageNode` (`outlineClipboardActions.ts:151/:208`) are the
  precedents. `pageId` in the image key options equals the pane's
  `outlineRootId` (`OutlineRow.tsx:377` passes `zoomRoot?.id ?? page.id`,
  same expression as `NotesOutline.tsx:107`).
- `notes.css:3311-3328` — the focused picture and the range-selected image
  draw the **same** accent ring on the frame. Visually a user cannot tell
  "focused" from "selected".
- `holdsCaret` (`outlineModel.ts:78`) already keeps post-mutation carets off
  picture rows; `caretHandoff` targets whatever visible row survives, and
  `focusAfterCommit`'s `editorById` picks a station side by edge when the
  survivor is itself an image.

## Decisions

**1. Which surfaces answer plain Backspace.**
The after-station and the focused picture answer; the before-station does
not; a banded image answers through the band.

- After-station: the request's literal case — Backspace takes what stands
  behind the caret, and behind that caret is the image.
- Focused picture: the ring the focused picture draws is pixel-identical to
  the selected-image ring (`notes.css:3311-3328`), so "이미지를 선택하거나"
  must cover it — the user has no way to distinguish the two states. It is
  also the Finder/Photos convention: Backspace deletes the focused item.
- Banded image: already the band's key by contract (`outlineKeyboard.ts`
  band rule, which plain Delete reaches today); Backspace merely stops being
  blocked. The band case is deliberately NOT re-resolved in the image
  branch — it falls through to the one band rule in `resolveOutlineKey`, so
  band semantics keep a single owner and Backspace/Delete cannot drift apart.
- Before-station: stays `null`. Backspace deletes backward; from the before
  station the image stands *ahead* of the caret and the row above stands
  behind it. Deleting the image would invert the direction every text field
  teaches, and reaching backward into the row above from an image's station
  is nobody's ask. The `null` also preserves the early return's original
  job: without it the hardwired `value: ""` fall-through resolves
  `removeEmpty`, the wrong command for a node with text and children.

**2. The command.**
`store.deleteSubtree(node.id)` — i.e. the existing `trash` intent and the
existing `executeRowIntent` case; no new intent kind, no new command. It is
what the image row menu's "Move to Trash" (`ImageNodeContent.tsx:416`) and
the bullet trash chord already run: a soft delete into Trash, restorable,
one undoable step. Children/caption go with the image and come back with one
⌘Z. The band path keeps its own `deleteSubtrees` via
`selectionActions.delete()`. `removeEmpty` is rejected outright: it blanks
drafts and runs a command whose contract is an empty bullet.

**3. Where the caret lands, and who owns the handoff.**
`executeRowIntent`'s `case "trash"` gains the handoff, built from
`caretHandoff` with what the context already holds
(`nodes`, `visibleNodes`, `outlineRootId: pageId`,
`scopeRef: { current: scope }`), taken on command resolution
(`void store.deleteSubtree(node.id).then(takeCaret)` — the same
`.then`-on-success idiom `indent`/`outdent` use two cases up).

Weighed against threading an `onDeleteImage` callback through
`OutlineRow.tsx` → `NotesOutline.tsx`:

- Responsibility: `executeRowIntent` already owns post-command caret
  placement for every other structural intent — `split`, `createSibling`,
  `indent`, `outdent`, `removeEmpty`, both merges, `duplicate`, `move` all
  call `focusAfterCommit`. `trash` was the one structural mutation in the
  switch with no caret story; that is an omission, not a boundary. The pane
  rightly owns handoffs where *selection state* must also be cleared
  (`deleteSelection`, `cutImageNode`) — no selection is involved on the bare
  path, so nothing pulls this up a layer.
- Root cause: the same fix repairs the bullet trash chord (⌘⇧⌫) and the
  chord fired from an image station, which lose focus to `document.body`
  today through the identical line. A callback routed only for images would
  leave both siblings broken.
- Cost: the callback route adds a field to `ImageRowKeyOptions`, a field to
  the row runtime, and a near-duplicate of `cutImageNode` minus the
  clipboard, across three files — for data `outlineSupport` already receives
  every keydown.
- The one-shot `{ current: scope }` ref is equivalent to the pane's live
  ref: the section element is stable, and if the pane unmounts before
  `takeCaret`, `focusWhenReady` finds no editor and no registered pane and
  returns harmlessly.

**4. Held Backspace.**
First press resolves `trash`; `repeat` resolves `consume` — the same shape
as the band rule and every command binding in this resolver. Repeats that
arrive after focus lands in the row above do native text deletion there,
exactly as they do after a held band-trash today; not new behavior, not
consumed here.

**5. Explicit scope edges.**
- Forward Delete from the before-station: non-goal (see Non-goals). The
  resolver never mentions Delete; bare Delete keeps falling through to
  nothing, band Delete keeps working.
- Zoomed-image header (`handleImagePageKeyDown`): non-goal. Its
  `resolveOutlineKey` call uses `target: "page"`, which the Backspace
  branches already exclude — no code change needed to keep it inert.
- Lightbox: in scope only as the A7 guard (below); its own keys are its own.
- New in-scope row forced by this feature: A7. `handleImagePrimaryKeyDown`
  hears every key bubbling out of the row's innards, including the portal'd
  lightbox (React portals bubble through the React tree). Today plain
  Backspace resolved `null` everywhere, so the leak was harmless for this
  key; giving it a destructive meaning without a guard would let Backspace
  in the lightbox delete the image being viewed, and Backspace in the open
  menu likewise. The guard is one expression in the component that owns both
  layer states: `onKeyDown={menuOpen || lightboxOpen ? undefined : onKeyDown}`
  on the root div of `ImageNodeContent`. While a layer is up, the row's key
  surface is suspended; stations cannot hold focus then anyway. (Side
  effect, accepted: plain Enter from an open menu/lightbox stops resolving
  `createSibling` — strictly a bug fix.)

## Items (implementation order)

Every acceptance row maps to exactly one item; every item has one failing
test.

### Item 1 — Suspend the row key surface while a layer is open (A7)

- Code: `apps/desktop/src/image/ImageNodeContent.tsx` — root div gets
  `onKeyDown={menuOpen || lightboxOpen ? undefined : onKeyDown}`. Comment to
  earn (~2 lines, why-prose): keys from the menu and the portal'd lightbox
  bubble through the React tree into the row's handler, and a row key
  answered while a layer is up acts on a row the user is not looking at.
- Test: `apps/desktop/src/image/ImageNodeContent.test.tsx`, new
  `it("suspends the row's key surface while the menu or lightbox is open")`.
  Render with `store` stub + `onKeyDown` spy (harness at `:143` already
  passes the prop). Open the menu via
  `fireEvent.click(screen.getByRole("button", { name: "Image actions for cat.png" }))`,
  `fireEvent.keyDown(screen.getByRole("menu"), { key: "Backspace" })`, assert
  `expect(onKeyDown).not.toHaveBeenCalled()`. Close with Escape, fire
  Backspace on a caret stop, assert the spy fires once (surface listens
  again). Open the lightbox (double-click the loaded frame, per the idiom at
  `:311`), fire Backspace on `screen.getByRole("dialog")`, assert the spy
  count is unchanged.
- Red today: the spy IS called from the open menu (handler runs, resolves
  `null`), so the not-called assertion fails before the guard exists.
- Ordered first so no intermediate commit ships lightbox-Backspace deleting.

### Item 2 — Resolver: plain Backspace on the image's surfaces (A2, A3, A4, A6)

- Code: `apps/desktop/src/outline/outlineKeyboard.ts` — replace the blanket
  early return (`:785-793`) with, in the same position (band case excluded
  so it falls through to the one band rule):

  ~~~
  plain Backspace && !hasSelection:
    imageEdge === "before"  → null
    repeat                  → { kind: "consume" }
    otherwise               → { kind: "trash" }
  ~~~

  Comment to earn (~4 lines, why-prose, matching neighbour density):
  Backspace takes what stands behind the caret — from the after station and
  from atop the picture that is the image; from the before station the image
  stands ahead, and the row above is not this key's to reach for. The `null`
  also keeps the before station out of the `value: ""` fall-through, whose
  empty-row ladder resolves a command built for blank bullets. A band falls
  through on purpose: the band rule below owns both delete keys.
- Test: `apps/desktop/src/outline/outlineKeyboard.test.ts`, new
  `it("deletes the image on Backspace from behind it, never from ahead")`
  in the image section (near `:136-288`), asserting via
  `handleImageNodeKeyDown`:
  - `input({ key: "Backspace", nodeId: "next", imageEdge: "after" })` →
    `{ kind: "trash" }` (A1 intent / A2 shape);
  - `input({ key: "Backspace", nodeId: "next" })` (picture, edge undefined)
    → `{ kind: "trash" }` (A2);
  - `input({ key: "Backspace", nodeId: "next", imageEdge: "after", repeat: true })`
    → `{ kind: "consume" }` (A6);
  - `input({ key: "Backspace", nodeId: "next", imageEdge: "before" })` →
    `null` (A4);
  - `input({ key: "Backspace", nodeId: "next", imageEdge: "before", hasSelection: true })`
    → `{ kind: "trash" }`, and with `repeat: true` → `{ kind: "consume" }`
    (A3 — proves the fall-through reaches the band rule);
  - `input({ key: "Backspace", nodeId: "next", imageEdge: "after", altKey: true })`
    → `null`, same for bare `ctrlKey` (modifiers belong to other bindings;
    the ⌘⇧⌫ chord keeps resolving `trash` through `resolveOutlineKey` as it
    already does).
- Red today: every non-null expectation fails against the early return.
- A3's dispatch line (`intent.kind === "trash" → selectionActions.delete()`,
  `outlineSupport.ts:255`) is existing code, and the image band block's
  dispatch is already mounted-proven by
  `outlineSupport.test.tsx:300` ("hands a band key to the selection
  command") and `outlineShiftSelect.test.tsx:509` ("trashes the band on
  Backspace/Delete" for bullets). The intent is what was missing; it is
  locked here.

### Item 3 — Caret handoff on the bare trash path (A1, A5)

- Code: `apps/desktop/src/outline/outlineSupport.ts` — `executeRowIntent`
  `case "trash"` becomes: build
  `caretHandoff({ nodes, visibleNodes: context.visibleNodes, outlineRootId: context.pageId, scopeRef: { current: scope } })([node.id])`
  before the command, then
  `void store.deleteSubtree(node.id).then(takeCaret);`. Import
  `caretHandoff` (no cycle: it depends on `outlineFocus` + `storeState`
  only). Comment to earn (~3 lines, why-prose): the key's own surface
  unmounts with the row it deletes, so without a handoff focus falls to the
  document body; the neighbour is read off the rows as they still stand and
  taken once the command lands — the same shape `cutRow` and the band's
  delete already use. This also covers the bullet ⌘⇧⌫ chord, which shared
  the focus drop.
- Test: `apps/desktop/src/image/imageCaretStation.test.tsx`, new
  `it("deletes the image on Backspace at its after station and hands the caret up")`:
  `renderImageOutline()`, focus `stations(view)[1]` (the after station),
  `fireEvent.keyDown(after, { key: "Backspace" })`, then
  `await waitFor(() => expect(notesApi.execute).toHaveBeenCalledWith(expect.objectContaining({ command: { kind: "deleteSubtree", id: "image" } })))`
  (A1) and
  `await waitFor(() => expect(screen.getByDisplayValue("First thought")).toHaveFocus())`
  (A5 — jsdom drops focus to body without the handoff, so this assertion is
  the red).
- Red after item 2: the command fires but the focus assertion fails.

## Existing tests that must change

None. Verified:

- No test asserts Backspace is inert on an image surface
  (`outlineKeyboard.test.ts` never feeds Backspace to
  `handleImageNodeKeyDown`; `imageCaretStation.test.tsx` has no Backspace).
- No mounted test exercises the ⌘⇧⌫ chord end-to-end, so the item-3 focus
  change breaks nothing existing.
- `outlineShiftSelect.test.tsx:509` (band Backspace on bullets) asserts the
  command only and routes through the pane's `deleteSelection`, untouched.
- `ImageNodeContent.test.tsx:326` (menu keyboard navigation) passes no
  `onKeyDown` prop, so item 1's guard cannot affect it.

## Gates

Frontend-only: `npm test`, `npm run lint`, `npm run test:bundle`,
`git diff --check`. Cargo/Clippy explicitly skipped — no Rust, IPC, or
persistence change.

## Risks / reviewer notes

- The `imageEdge === undefined → trash` case means Backspace from an inner
  widget while NO layer is open (e.g. the tabbable resize handle) also
  trashes. Accepted deliberately: it is the exact contract every existing
  binding on this handler has (Enter, ⌘X), the guard item covers the two
  layers where the hazard is real, and the whole inner-widget leak class is
  a pre-existing defect to fix once, separately (see Non-goals; evidence:
  Enter on the menu trigger).
- `caretHandoff` reads the visible list captured at keydown; that is the
  same freshness the pane's own `handOffCaret` has. Between-render staleness
  loses at worst the caret target, never data.
- Undo focus is history's concern (`historyFocusIntegration`), not this
  change's.

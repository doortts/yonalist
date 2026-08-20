# Head-of-line Backspace refuses an image previous sibling

Pre-existing defect. Not caused by `2026-08-20-image-backspace-delete.md` or
`2026-08-21-image-backspace-previous-sibling.md`; found while shipping them.

Design authored by Opus 5 xHigh, not Fable 5: Fable 5 hit its usage limit
during the design phase ("You've reached your Fable 5 limit"), so the
`fable-opus-loop` model split could not run. The adversarial review still ran,
on a separate agent that did not write the code, and returned `REWORK`. This
doc is the corrected version; the section "What the first pass got wrong"
records what changed and why.

## Contract

| Field | Content |
| --- | --- |
| Goal | Head-of-line Backspace on a text row never sends a merge command naming a row that is not a bullet, on any backend. |
| Acceptance | 1. A text row whose previous visible sibling is an image row — same parent, no caption note, no children — resolves to `null`: no `mergeBackward`, no delete, nothing. 2. The same keystroke with a *bullet* previous sibling still resolves to `mergeBackward` exactly as before. 3. The preview backend refuses `mergeNodeBackward` naming a non-bullet, the way notes-core does. 4. notes-core's own refusal is locked by a test. |
| Non-goals | Making that keystroke reach the image at all (see the decision below). Touching the `trash` intent shape or `outlineSupport.ts`. Any change to the image row's own caret-station keys, the note field, or the page title. Any change to `projectMergeNodeBackward` or to `previewApi`'s merge execution. |
| Boundaries | React/TypeScript resolver, the preview backend's validator, and one notes-core test. No IPC payload change, no schema change, no filesystem, no macOS. |
| Manual proof | Browser preview (`npm run dev`, preview seed has an image row): text row directly under an image row at the same depth, caret at offset 0, plain Backspace. Image stays, text unchanged, caret stays at offset 0. |

## The defect

`resolveOutlineKey` in `apps/desktop/src/outline/outlineKeyboard.ts` has two
backward branches for head-of-line Backspace on a row with text:

- `mergeIntoParent`
  ([outlineKeyboard.ts:688](../../../apps/desktop/src/outline/outlineKeyboard.ts))
  guards `previous.kind === "bullet"` — "an image row can never take the text".
- `mergeBackward`
  ([outlineKeyboard.ts:703](../../../apps/desktop/src/outline/outlineKeyboard.ts))
  guards same parent, empty previous note, previous has no children. No kind
  guard.

So a text row under a caption-less image row at the same depth returned
`{ kind: "mergeBackward", previousId: <image id>, joinOffset: <filename length> }`.

The two branches run in opposite directions, which is what the first pass of
this doc got wrong. `mergeIntoParent` folds the caret's row *into* the row
above. `mergeBackward` does the reverse: `projectMergeNodeBackward`
([optimisticOutline.ts:179](../../../apps/desktop/src/optimisticOutline.ts))
keeps the **current** node, sets its text to `previousText + currentText`, and
drops the **previous** node. The image row is the donor that dies, not a
destination. An image node's `text` is its filename, so the caret's line gains
`sample.png` at its head while the picture's row goes.

### What actually happened in the shipping app

notes-core refuses the command:

```rust
// crates/notes-core/src/tree/command_execution.rs:352
if current.kind() != NoteNodeKind::Bullet || previous.kind() != NoteNodeKind::Bullet {
    return Err(DomainError::Invariant("only bullet titles can be merged".into()));
}
```

So the persisted attachment was never lost and never bypassed Trash. The real
pre-fix symptom was an optimistic drop, an IPC rejection, and a rollback at
[storeOutlineMutations.ts:343](../../../apps/desktop/src/store/storeOutlineMutations.ts) —
with the error swallowed by `.catch(() => undefined)` at
[outlineSupport.ts:537](../../../apps/desktop/src/outline/outlineSupport.ts):
a visible flash of `sample.pngbeta`, the caret displaced, and no message.

### Where the loss was real

The preview backend has no such refusal.
[previewValidation.ts:131](../../../apps/desktop/src/preview/previewValidation.ts)'s
`mergeNodeBackward` case carried no kind check, while `mergeNodeIntoParent`
directly below it checks both rows — the identical omission the resolver had,
in the file whose whole job is mirroring notes-core's refusals (it carries
`// notes-core answers DomainError::NodeNotEmpty here` elsewhere). And
[previewApi.ts:281](../../../apps/desktop/src/preview/previewApi.ts) executes
the merge with `nodes.filter(...)` plus `deletedIds` — a hard removal, no soft
delete, no Trash. That is where the demonstrated destruction lived, and it is
where the browser proof for this change was taken.

## Decision: inertness, not a trash reach

Candidate A was the one-condition refusal mirroring the sibling branch.
Candidate B was returning a trash intent naming the image, the way the image
row's own before-station reaches the picture above it on the unmerged branch
`claude/image-delete-backspace-270041` (`1f248ba0`).

A wins, on three counts.

**The two surfaces are different keys wearing one name.** An image row has no
text, so Backspace there can only mean "take a row" — trash is its only
sensible act. Head-of-line Backspace on a *text* row is a merge key. `1f248ba0`
argues the mirror rule itself: it refuses a bullet above the station because
"a text row merges on its own surface and never dies to a neighbour's key."

**B would make one keystroke disagree with itself.** The branch immediately
above already answers "image above" with a refusal, and does not fall back to
trashing the image parent. Under B, an image above at parent depth would do
nothing while an image above at sibling depth trashed an attachment.

**B collides with live parallel work for no gain.** It would widen the `trash`
intent to carry a `nodeId` and rewrite `outlineSupport.ts`'s `trash` case — the
exact lines `1f248ba0` and `98482f3d` ("a trash aimed past the caret leaves the
caret alone") already rewrote on a branch that has diverged from this base and
is checked out in another live worktree.

**Open for whoever merges that branch.** Once it lands, "Backspace on an image
station trashes the picture above" is established behavior, and a text row one
depth over staying silent is an asymmetry worth re-litigating — as is the fact
that a user holding Backspace up a column now stalls at a picture with no
feedback at all. This doc does not pre-close that; it decides only that a
*merge* must not be the thing that reaches an attachment.

## Predicate: `=== "bullet"`, not `!== "image"`

The positive form is here because it mirrors the domain: notes-core's own guard
is `previous.kind() != NoteNodeKind::Bullet`
([command_execution.rs:352](../../../crates/notes-core/src/tree/command_execution.rs)),
and the `mergeIntoParent` branch above already reads the same way. The third
kind never reaches this position — `IpcNodeKind` is `"page" | "bullet" |
"image"`, and notes-core admits `Page` only with `parent_id == None`
([tree.rs:490](../../../crates/notes-core/src/tree.rs)), so the page kind
belongs to Home alone and is nobody's sibling. Page *documents* are bullets:
`is_page_row` reads page-ness off the parent's kind
([repository.rs:262](../../../crates/notes-sqlite/src/repository.rs)), the same
reading the preview seed encodes
([previewOutline.ts:7](../../../apps/desktop/src/preview/previewOutline.ts)),
and Home itself is held in `pageNode` rather than `nodes`
([notesStore.ts:154](../../../apps/desktop/src/notesStore.ts)). So Home's rows
are bullets and Home's behavior is unchanged by this diff. Enumerating the two
non-bullet kinds would be the weaker guard anyway; mirroring the domain's own
predicate is the reason to prefer this one.

## Other backward surfaces: no hole

**Note field — clean.**
[SupportingNoteField.tsx:61](../../../apps/desktop/src/SupportingNoteField.tsx)
routes keys through `resolveSupportingNoteKey`
([outlineKeyboard.ts:874](../../../apps/desktop/src/outline/outlineKeyboard.ts)),
whose only Backspace resolution is `removeEmptyNote`, and only when
`input.value.length === 0`
([outlineKeyboard.ts:895](../../../apps/desktop/src/outline/outlineKeyboard.ts)).
[SupportingNoteField.tsx:88](../../../apps/desktop/src/SupportingNoteField.tsx)
answers it by hiding the field and flushing the erase of *its own* note, then
handing the caret back to *its own* title. No neighbour is named, no node is
dropped, and `resolveOutlineKey` is never reached.

**Page title — clean.** `handlePageKeyDown`
([outlineSupport.ts:280](../../../apps/desktop/src/outline/outlineSupport.ts))
and `handleImagePageKeyDown`
([outlineSupport.ts:320](../../../apps/desktop/src/outline/outlineSupport.ts))
do call `resolveOutlineKey`, but with `target: "page"`, and every Backspace
branch in the resolver sits behind `input.target === "row"`. The page title has
no backward merge to hole.

**Image surface fall-through — clean.** `handleImageNodeKeyDown` falls through
to `resolveOutlineKey` with `value: ""`
([outlineKeyboard.ts:855](../../../apps/desktop/src/outline/outlineKeyboard.ts)),
and both merge branches require `input.value.trim().length > 0`, so an image
row can never merge anything into itself. Backspace cannot reach the
fall-through at all: the `after` and on-image stations return `trash` first, and
the `before` station returns `null` first.

**Single producer, confirmed.** `projectMergeNodeBackward` has one caller
([storeOutlineMutations.ts:330](../../../apps/desktop/src/store/storeOutlineMutations.ts)),
reached only through `notesStore.ts` → `outlineSupport.ts`'s `mergeBackward`
case, whose only producer is this resolver branch. The guard sits at the sole
producer; no per-caller patching is needed.

## Items

| Item | Acceptance rows | Test |
| --- | --- | --- |
| 1 | 1, 2 | `apps/desktop/src/outline/outlineKeyboard.test.ts`, one case inside the existing `it("merges a title backward only into an eligible previous sibling leaf")` block. The picture pair hangs under a bullet holder, because notes-core forbids an image directly below the root. Row 2 is the block's existing opening assertion. |
| 2 | 3 | `apps/desktop/src/preview/previewValidation.test.ts`, `it("refuses a backward merge onto a picture the way notes-core does")` — the refusal plus a bullet case proving the merge this backend still performs. |
| 3 | 4 | `crates/notes-core/tests/tree_commands.rs`, one assertion appended to `merge_backward_rejects_nonadjacent_or_structurally_occupied_predecessors`. |

Red evidence for item 1, from
`npx vitest run --config vite.config.ts src/outline/outlineKeyboard.test.ts -t "merges a title backward"`:

```
AssertionError: expected { kind: 'mergeBackward', …(2) } to be null
+ Received: { "joinOffset": 8, "kind": "mergeBackward", "previousId": "shot" }
```

Fix: add `previous.kind === "bullet"` to the `mergeBackward` guard, the same
predicate `mergeIntoParent` already carries, and `current.kind`/`previous.kind`
to the preview validator's `mergeNodeBackward` case, the same pair
`mergeNodeIntoParent` already carries.

## What the first pass got wrong

The review caught three substantive errors, all now fixed:

1. The code and test comments described `mergeIntoParent`'s direction ("no text
   to fold into") for a branch that runs the other way. The image row is the
   donor, not the destination.
2. The doc and commit message asserted real, persisted attachment loss outside
   Trash. notes-core refuses the command; the shipping symptom was a flash and
   a silent rollback. The loss was real only in the preview backend.
3. The four-surface hole audit missed `previewValidation.ts`, the one place the
   same omission actually destroyed a picture — and the place the manual proof
   was taken.

Plus two smaller ones: the test fixture hung an image directly below the root,
a state notes-core forbids; and several file:line citations were off or named a
function (`handlePageTitleKeyDown`) that does not exist.

The second review round then retracted its own fourth finding, and the retraction
was right: `kind: "page"` does *not* reach the previous-sibling position, so the
acceptance row and assertion the first rework added for it pinned an impossible
state with a domain-illegal fixture, and the claim that Home's behavior changed
was false in both directions. Both are gone; the "Predicate" section above now
gives the real reason for the positive form.

## Gates

Rust changed (a test only, no source), so: `npm test`, `npm run lint`,
`npm run test:bundle`, `git diff --check`, plus
`cargo test --manifest-path crates/notes-core/Cargo.toml` and `cargo fmt --check`.
Clippy compared against baseline only if the touched boundary warrants it — a
test-only Rust change does not.

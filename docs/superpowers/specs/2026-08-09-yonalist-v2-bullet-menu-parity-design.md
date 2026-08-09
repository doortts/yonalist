# Yonalist v2 Bullet Menu Parity Design

**Date:** 2026-08-09
**Status:** Pending written-spec review
**Baseline:** `main@576f1b3e`

## Contract

| Field | Decision |
| --- | --- |
| Goal | Bring the legacy bullet menu's eleven selection commands to the v2 outline: Complete, Move To…, Move up, Move down, Indent, Outdent, Duplicate, Tags, Copy, Cut, Delete — using Workflowy's own labels and shortcut hints wherever Workflowy has a name for the command. |
| Acceptance | With a multi-row selection live, the row `⋯` menu lists all eleven with Workflowy-matched labels, Workflowy shortcut hints, and the existing disabled reasons; each executes on the whole selection as one undo entry; Move To… and Tags open their choosers; Copy/Cut round-trip through the existing paste parser; the single-row menu gains the same commands scoped to one subtree. |
| Non-goals | Right-click menus, Sort, Expand/Collapse all, Export subtree, Add date, Archive/Unarchive, plugin ownership, read-only vaults, permanent delete, a tag entity in the schema, and any database migration. |
| Boundaries | `apps/desktop/src` only. No `crates/` changes, no new `IpcNotesCommand` variant, no schema change. |
| Manual proof | Select three sibling bullets with children, open `⋯`, run each of the eleven in turn, and confirm after each: the tree matches the legacy result, one `⌘Z` reverts it, focus lands where the spec says, and the menu closes on outside click and `Escape`. |

## Key finding: this is the selection menu, not the row menu

The screenshot is the legacy `NotesBulletMenu` **selection variant**. It renders only when
a range selection is live and the clicked row sits inside it
(`src/features/notes/NotesOutlinePane.tsx:4651`, `NotesBulletMenu.tsx:656`). Every item acts on
the whole selection, never on the clicked row. Without a selection the same `⋯` button shows a
different, longer single-node menu.

v2 already has this capability, but on a different surface: the floating `SelectionActionBar`
carries indent, outdent, move up/down, duplicate, complete, copy, cut, and delete. What v2
lacks is the *menu* presentation of those commands, plus Move To and Tags on any surface.

This design therefore delivers two menu modes, matching legacy:

- **Selection mode** — the eleven commands, shown when a selection is live.
- **Single-row mode** — today's seven items plus the eight commands that are missing from it,
  each scoped to one subtree.

## Current state

Verified against `main@576f1b3e`.

| Command | v2 today | Gap |
| --- | --- | --- |
| Complete | menu + `⌘/Ctrl+Enter` + `setCompletedMany` | none |
| Move up / down | key + selection bar + `planSelectionReorder` | menu item only |
| Indent / Outdent | key + selection bar + `planSelectionIndent`/`Outdent` | menu item only |
| Duplicate | menu + `⌘⇧D` + `duplicateNodes` | none |
| Delete | menu ("Move to Trash") + `⌘⇧⌫` + `deleteSubtrees` | menu label, selection mode |
| Copy | `outlineClipboard.ts` serializer + native `onCopy` | multi-select only; no single row, no menu item |
| Cut | same + `canCutSelectedOutline` guard | same, plus the image-node hole below |
| Move To | `moveNode`/`moveNodes` with cycle guard at `crates/notes-core/src/tree.rs:80` | **entire UI** |
| Tags | read path complete: tokenizer, click-to-filter, `tag:`/`is:tagged`, `notes_tags` table | **entire write UI** |

Two facts make this much smaller than it looks.

**Tags need no schema work.** In both codebases a tag is not an entity — it is an inline
`#tag` / `@person` token inside the node's title and note text, re-derived on every write
(v2: `crates/notes-sqlite/src/mutations.rs:241-326`). Legacy's tag chooser adds a tag by
appending `" #tag"` to the title and removes it by stripping the token plus one adjacent space
from title and note. v2 can do exactly that through the existing `updateText` / `updateNote`
commands. **No migration, no new command, no `tags` field on `NoteView`.**

**The clipboard format already matches.** v2's `serializeSelectedOutline`
(`apps/desktop/src/outlineClipboard.ts:28`) emits the same shape as legacy's
`notesClipboardOutline.ts`: two spaces per depth, `- title` per line, bare `-` for an empty
title, newlines in titles flattened to spaces, written to both `text/plain` and `text/markdown`,
title-only so internal data cannot leak. Same limits (2 000 nodes, depth 64, 100 000 UTF-8
bytes per title). It already round-trips with `parsePastedOutline`. Copy and Cut need reach,
not a format.

## Labels and shortcuts: Workflowy as the source of truth

Labels come from Workflowy, verified against the live app menu and the official hotkey page
(`https://workflowy.com/help/hotkeys/`) on 2026-08-09, not from legacy Yonalist.

Workflowy has a menu entry for only four of the eleven commands. Its bullet menu carries
`Complete`, `Move To...`, `Duplicate`, and `Delete`; indent, outdent, and reordering are
keyboard-only, and Workflowy has no Copy, Cut, or Tags command anywhere. For the seven with no
menu precedent, the labels below use Workflowy's own command names from its hotkey table
(`Indent`, `Outdent`, `Move up`, `Move down`) or, where Workflowy has no name at all
(Copy, Cut, Tags), the platform-conventional one.

| Command | Label | macOS hint | Windows/Linux hint | Source |
| --- | --- | --- | --- | --- |
| Complete | `Complete` / `Uncomplete` | `⌘↩` | `Ctrl+Enter` | Workflowy menu |
| Move To… | `Move To...` | `⌃⌘M` | `Ctrl+Alt+M` | Workflowy menu |
| Move up | `Move up` | `⌃⇧↑` | `Alt+Shift+↑` | Workflowy hotkeys |
| Move down | `Move down` | `⌃⇧↓` | `Alt+Shift+↓` | Workflowy hotkeys |
| Indent | `Indent` | `Tab` | `Tab` | Workflowy hotkeys |
| Outdent | `Outdent` | `⇧Tab` | `Shift+Tab` | Workflowy hotkeys |
| Duplicate | `Duplicate` | `⌘⇧D` | `Alt+Shift+D` | Workflowy menu |
| Tags | `Tags` | — | — | no precedent |
| Copy | `Copy` | `⌘C` | `Ctrl+C` | no precedent |
| Cut | `Cut` | `⌘X` | `Ctrl+X` | no precedent |
| Delete | `Delete` | `⌘⇧⌫` | `Ctrl+Shift+Backspace` | Workflowy menu |

`Move To...` keeps Workflowy's three-dot spelling, which signals that it opens a chooser
rather than acting immediately. Workflowy uses a literal `...`, not `…`.

Every one of v2's existing bindings already matches this table — complete, duplicate, delete,
indent, outdent, and the move pair were verified against the hotkey page and agree, including
v2 accepting either `⌃` or `⌘` with Shift+Arrow on macOS, which is a superset of Workflowy's
`⌃`. Only `Move To...` adds a new binding.

### Renames this forces on the existing v2 menu

| v2 today | Becomes | Why |
| --- | --- | --- |
| `Move to Trash` | `Delete` | Workflowy's label. Still a soft delete; Trash and restore are unchanged. |
| `Add note` / `Edit note` | `Add note` | Workflowy uses one label in both states. |

The existing flat `To-do` / `Change to bullet` toggle stays. Workflowy nests node-kind changes
under a `Turn into...` submenu, but that shape earns its keep only once there are more kinds
than v2 has (headings, code block, quote, number). Decided 2026-08-09: no submenu.

`Upload image` stays as-is. Workflowy says `Upload file`, but v2 accepts only PNG, JPEG, GIF,
and WebP, so Workflowy's label would promise something the app cannot do.

Not adopted from Workflowy: `Mirror`, `Mirror To...`, `Share`, `Make template`,
`Copy internal link`, `Add comment`, `Add date`, `Move to Today/Tomorrow/Next Week`,
`Expand all`, `Collapse all`, `Sort A-Z`, `Sort Z-A`, `Export`, and the `Changed:` / `Created:`
timestamp footer. All are out of scope here; the timestamp footer is worth noting because
`notes.css` already ships `.notes-bullet-menu-timestamps` for it.

## User-visible behavior

### Selection mode

The eleven items appear in the legacy order with no separators, each row rendered as
`icon | label | shortcut`. A disabled item stays visible, dimmed, and carries its reason as an
accessible description — the reason strings are the ones already produced by
`selectionMoves.ts` plan objects (`{available: false, reason}`), which are written as
user-facing text today and are reused verbatim.

Shortcut hints come from the table above and are resolved per platform. `Tags` shows no hint.
Each item also sets `aria-keyshortcuts`. The stylesheet already carries
`.notes-bullet-menu-shortcut` and `.notes-bullet-menu-separator` (`notes.css:2266-2390`) with no
current TypeScript reference; this design is what consumes them.

**Complete** toggles the whole selection. Direction is recomputed at execution time: if any
selected node is incomplete, complete all; otherwise uncomplete all. Label reads `Uncomplete`
when every selected node is already complete. Targets every selected row and its visible
descendants, which is what `setCompletedMany(selectedIds, …)` already does.

**Move up / Move down** reorder the selected roots one step among their siblings. Requires all
roots to share one parent and be contiguous. Disabled reasons come from
`planSelectionReorder`.

**Indent / Outdent** move the selected roots one level, children riding along. Indent requires
each root to have a preceding sibling outside the selection. Outdent may target a *subset* —
roots already at the zoom root are skipped rather than blocking the whole command. Both
preserve the selection across the command.

**Duplicate** deep-copies the selected roots with their descendants, inserts the copies as
siblings immediately after the last selected root, and then **re-selects the copies**. Requires
one shared parent.

**Move To** opens a modal chooser (below). **Tags** opens a modal chooser (below).

**Copy** serializes the selection to the clipboard. It is the only command that stays enabled
while the workspace is busy or while viewing Trash.

**Cut** copies, then soft-deletes the same roots — Trash, not a hard delete. It is refused
whenever the round trip would lose data: any node in the selected subtrees with a non-empty
note, a title containing a newline, **or an image node**. The image case is a gap in today's
`canCutSelectedOutline`, which checks only titles and notes; an image node's title is its
filename, so cutting one today silently discards the image. This design closes that hole.
Refusal text names Move To as the lossless alternative.

**Delete** soft-deletes the selected roots and their subtrees into Trash. No confirmation
dialog. One `⌘Z` restores. Focus moves to the first surviving visible row after the last
selected node, else the first surviving row before the first, else the page.

### Single-row mode

Today's seven items keep their place and labels. The eight commands absent from the single-row
menu are appended in the legacy selection order, scoped to the clicked node's subtree:
Move To, Move up, Move down, Indent, Outdent, Tags, Copy, Cut. Complete, Duplicate, and Delete
already exist there; Delete's label stays `Move to Trash`, which is more accurate than legacy's
`Delete` for a soft delete.

Eligibility is the single-node degenerate case of the selection rules, so the same reason
strings apply.

### Move To chooser

A modal dialog titled `Move selection` (single-row: `Move item`), with the description
`Choose a new parent for the selected outline.`

It lists every non-deleted node in the workspace as an indented flat list, prefixed by a
synthetic `Top level` entry that moves the subtree to the root. Excluded: the moving roots and
their entire subtrees (this is the cycle guard made visible — the backend refuses these anyway
at `crates/notes-core/src/tree.rs:80`), and deleted nodes.

Filtering is a client-side case-insensitive substring match on the label. `↑`/`↓` wrap through
the filtered list using `aria-activedescendant`, `Enter` commits the active option, pointer
move sets the active index, and composition events are ignored so IME input does not commit
early.

Committing moves the roots to the **bottom** of the destination's children, preserving their
relative order, through the existing `moveNodes`. The chooser cannot create a new page.
Afterwards, focus returns to the selection head and the selection survives.

The full node list requires the complete forest, which `useOutlineSelection` already loads and
gates on (`forestComplete`). The chooser reuses that gate rather than adding a second loader.

### Tags chooser

A modal dialog titled `Edit tags`, description
`Add or remove one exact tag from the selected rows.`, with an Add / Remove tab pair and a
combobox.

**Add** suggests tags drawn from the workspace, filtered by substring over `prefix + tag`.
Free text is accepted only if it tokenizes to exactly one complete tag, using the tokenizer
that already exists at `apps/desktop/src/outlinePresentation.ts:170-199` — the same rules the
renderer and the SQLite derivation use, so a tag typed here is guaranteed to be one the search
index will find. Otherwise: `Enter exactly one tag beginning with # or @.`

**Remove** offers the union of tags present on the selected rows, computed at open time by
tokenizing each node's title and note. Free text cannot be committed in Remove mode.

Committing rewrites text, not metadata:

- Add appends `" #tag"` to the title, or the bare token when the title is empty, skipping nodes
  that already carry the tag. Image nodes are skipped entirely — their title is an immutable
  filename (`crates/notes-core` rejects the write), so a tag cannot be attached to one.
- Remove strips matching tokens plus one adjacent space from **both** title and note.

Every affected node's edit shares one history group, so the whole tag operation is one `⌘Z`.
This is the first use of a history group outside the backspace gestures; the mechanism already
exists (`storeOutlineMutations.ts:250-269`) and the Rust side coalesces same-group entries
(`crates/notes-application/src/service.rs` `record_history`).

Because tags are derived from text, a tag added here appears in the sidebar Tags view and in
`tag:` search without any further work.

### Menu shell

Three defects in today's menu must be fixed before eleven items land in it, since each one
scales with item count:

1. **No dismissal.** The menu closes only by running an item — no outside click, no `Escape`,
   no focus restore to the trigger.
2. **No keyboard navigation.** No arrow roving, no `Home`/`End`, no autofocus.
3. **No positioning logic.** A hardcoded `insetBlockStart: 28` with no flip or viewport clamp;
   an eleven-item menu on a row near the bottom of the viewport will overflow.

All three are already solved in `SelectionActionBar.tsx:92-108,246-269` (pointerdown-capture
dismissal, `Escape`, arrow/Home/End roving, `aria-haspopup`/`aria-expanded`). The fix is to lift
that behavior into a shared hook and use it from both, not to write it twice.

The menu stays a lazy chunk. Eleven items with shortcut strings and two choosers must not enter
the entry bundle; the choosers get their own lazy chunks, loaded on first open.

## Architecture

No new IPC command and no Rust change. Every command maps onto primitives that already exist:

| Command | Existing primitive |
| --- | --- |
| Complete | `setCompletedMany` |
| Move up/down, Indent, Outdent, Move To | `moveNodes` |
| Duplicate | `duplicateNodes` |
| Delete, Cut | `deleteSubtrees` |
| Copy, Cut | `serializeSelectedOutline` + `writeOutlineClipboard` |
| Tags | `updateText` / `updateNote` under one history group |

New frontend modules:

- `outlineMenuCommands.ts` — one command table shared by the menu, the selection bar, and the
  keyboard layer: id, label, icon, shortcut per platform, eligibility from the existing plan
  objects, and the execute thunk. This is the piece that prevents a fourth divergent copy of
  the same eleven actions.
- `useMenuDismiss.ts` — the dismissal and roving behavior lifted from `SelectionActionBar`.
- `OutlineMoveChooser.tsx` + `outlineMoveTargets.ts` — the destination list builder and dialog.
- `OutlineTagChooser.tsx` + `outlineTagEdits.ts` — the tokenizer-backed add/remove text rewriter.

`OutlineRowMenu.tsx` becomes a renderer over the command table with a `mode: "row" | "selection"`
switch. It is at 89 lines today; the table keeps it from growing past the 500-line advisory.

## Phases

Each phase is independently shippable and ends green on all gates.

1. **Menu shell** — dismissal, roving, positioning, `aria-haspopup`/`aria-expanded`, shared hook.
   No new items. This is a bug fix that stands on its own.
2. **Command table + existing commands into the menu** — Move up, Move down, Indent, Outdent in
   both modes; shortcut hints; disabled reasons; selection mode switch.
3. **Copy / Cut reach** — single-row paths, menu items, and the image-node cut guard.
4. **Move To** — targets builder, chooser, both modes.
5. **Tags** — tokenizer-backed chooser, grouped-history text rewrite, both modes.

Phases 1–3 touch no new concepts. Phases 4 and 5 each add one dialog and are the only phases
that can slip without blocking the rest.

## Test design

TDD, tests written before implementation, in the repo's existing style.

**`outlineMenuCommands.test.ts`** — the eligibility matrix, which is where the real logic
lives and where a UI test would be the wrong tool:

- Reorder: non-contiguous roots, roots under two parents, already-first, already-last.
- Indent: first root has no preceding sibling; preceding sibling is itself selected.
- Outdent: root at zoom root is skipped, not blocking; all roots at zoom root disables.
- Duplicate: roots under two parents.
- Cut: non-empty note anywhere in a selected subtree; newline in a title; an image node
  anywhere in a selected subtree — each refuses with its own reason.
- Copy: stays enabled when every mutating command is disabled.
- Shortcut strings resolve per platform for all eleven.

**`OutlineRowMenu.test.tsx`** — selection mode renders eleven items in order; row mode renders
the single-node set; a disabled item renders dimmed with its reason as an accessible
description and does not fire on click; `Escape` closes and restores focus to the trigger; an
outside pointerdown closes; arrow keys rove and wrap.

**`outlineMoveTargets.test.ts`** — the moving roots and their descendants are absent from the
list; `Top level` is first; deleted nodes are absent; filtering is case-insensitive; the
computed insertion point is the last child of the destination that is not itself moving.

**`outlineTagEdits.test.ts`** — add appends with one space; add to an empty title writes the
bare token; add skips a node that already has the tag; add skips image nodes; remove strips
from title and from note; remove takes one adjacent space and no more; a tag differing only by
case or Unicode normalization is treated as the same tag; free text that tokenizes to two tags
is rejected.

**`notesStore.test.ts`** — the tag rewrite across three nodes commits under one history group
and one `undo()` restores all three titles.

**Integration** — a selection of three siblings with children survives each of the eleven with
the tree shape the spec names, and each is undone by one `⌘Z`.

Gates unchanged: `tsc`, `eslint --max-warnings 0`, `vitest --maxWorkers=2`, `cargo test`,
`test:v2:contracts`, `test:v2:architecture`, `test:v2:bundle`.

## Risks

**Bundle budget.** Measured on `main@576f1b3e`: 306,147 raw / 93,109 gzip against ceilings of
307,200 and 93,184 — **75 bytes of gzip headroom and 1,053 of raw**. Nothing new fits in the
entry chunk, and raw is nearly as tight as gzip.

What the checker measures decides the strategy. `scripts/checkV2BundleBudget.mjs` takes the
entry chunk and walks `chunk.imports` — **static** imports — transitively, gzipping each file
separately and summing. It never follows `chunk.dynamicImports`, and it counts neither CSS nor
`index.html`. So a `lazy()` boundary genuinely removes bytes from the measured set rather than
shuffling them, and anything moved into an inline `<script>` is free.

Consequences for this design:

- Every module added here — the command table, both choosers, the shortcut strings — must sit
  behind a `lazy()` boundary. `OutlineRowMenu` already is; the choosers get their own chunks
  loaded on first open.
- Phase 1 must confirm the split holds before phase 2 adds items. A command table statically
  imported by the keyboard layer would pull the whole thing into the entry chunk and blow the
  budget on its own.
- **Decided 2026-08-09: no reclaims, and the ceiling is not a hard constraint.** Two reclaims
  were measured — theme application moved to an inline script (526 gzip) and `dropConsole`
  (128 gzip) — and judged too small to be worth the churn. The ceiling is raised when a
  feature needs the room, as `74c2ef25` already did. Lazy boundaries here are therefore the
  right default because the modules genuinely are not needed at first paint, not because the
  budget forces them.

  Two notes for whoever revisits this. The theme reclaim also fixes a real flash of default
  theme on cold start (`data-theme` is applied in a `useEffect` after mount today), so it is
  worth doing on its own merits even at 526 bytes. And the one large lever —
  `lazy()` on `NotesDetailPanes`, measured at 18,596 gzip — is a relocation, not a deletion:
  the chunk still loads before any note renders, so bytes-to-notes is unchanged.

The entry chunk is 62 % `react-dom` + `scheduler` by gzip and the hygiene is already clean
(`@base-ui/react` costs zero in the measured set, `lucide-react` tree-shakes to the 18 icons in
use, one production React copy). There is no easy fat left to trim; the only large lever is
moving the outline stack itself behind a boundary, which is a separate decision from this
feature.

**Undo granularity for Tags.** Editing N rows means N `updateText` commands. The Rust
coalescer caps a group at `MAX_HISTORY_MUTATIONS_PER_ENTRY`; a tag applied to a very large
selection will split into more than one undo entry. The cap should be measured in phase 5 and
the selection size bounded with a stated limit rather than silently splitting.

**Selection completeness.** Every mutating selection command already refuses to run until the
full forest has loaded. Move To needs the same forest for its destination list. Reusing the
existing gate is correct; adding a second, differently-timed loader would produce a chooser
that lists a subset of the tree.

## Open decisions

1. **Right-click.** Neither Workflowy nor legacy has an `onContextMenu` handler — all three
   apps open the menu only from the `⋯` affordance. Listed as a non-goal above; worth adding
   later since the menu shell from phase 1 would make it a small change.
2. **`Move To...` for a single row.** Legacy's single-node menu uses an inline sub-view rather
   than the modal. Recommend one modal for both modes; two presentations of one picker is the
   kind of divergence the command table exists to prevent.
3. ~~**`Turn into...` submenu.**~~ Resolved 2026-08-09: no submenu, the flat toggle stays.

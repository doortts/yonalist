# Workflowy Outline UI Parity Design

**Status:** Approved from the user-provided signed-in Workflowy screenshot on
2026-07-10.

**Scope:** Yonalist Notes detail surface only. Existing Inbox, Notifications,
Settings, authentication, caches, and storage behavior remain unchanged.

## Goal

Make Notes feel like the supplied Workflowy outline when writing: a quiet dark
canvas made of arrows, circular bullets, editable text, inline supporting notes,
indentation guides, and nested rows. Preserve Yonalist's host shell and local
SQLite ownership while matching Workflowy's page and bullet interaction model.

## Visual Authority

The user-provided screenshot is the primary visual reference. Current official
Workflowy public pages and help documentation are secondary references for
interaction details.

The target traits are:

- No card, boxed input, or full-row toolbar around ordinary content.
- A small triangle appears to the left of bullets that have children.
- A circular bullet is the stable node anchor.
- Collapsed or emphasized bullets may show a larger low-contrast halo.
- Child branches use a consistent indent and a subtle vertical guide.
- Supporting notes appear below the owning title in smaller muted text.
- Empty nodes remain visible as editable bullets.
- Secondary commands are hidden in a compact bullet menu.
- The dark canvas, text contrast, and density remain close to the screenshot.

## Host Boundary

The Yonalist left navigation and Notes library pane stay Yonalist-native. Only
the Notes detail pane adopts the Workflowy outline grammar.

The feature remains isolated through the existing feature registry and Notes
provider. No shared Inbox reducers, network clients, auth state, notification
selection, or Markdown-vault code may import Notes outline components.

## Page Model

### Root view

The unzoomed Notes view displays root pages as ordinary bullet rows. Their
children can be expanded in place. Selecting a page from the Notes library
zooms to that page.

### Zoomed view

When zoomed to a node:

- The zoom root is not rendered as an ordinary bullet row.
- Its title becomes the page title.
- Its supporting note appears below the page title.
- Its children become the first outline rows.
- Breadcrumbs expose each ancestor and the Home/root action.
- The title and note remain editable through the serialized Notes store.

### Navigation roles

- Arrow click toggles children in place.
- Bullet click zooms to the node.
- Bullet drag moves the node and descendants.
- Bullet menu opens node commands.
- These actions must not trigger one another accidentally.

## Row Geometry

Use stable dimensions so hover and editing do not shift text:

| Property | Target |
| --- | --- |
| Minimum row height | 28px |
| Body text | 16px / 24px |
| Supporting note | 14px / 20px |
| Arrow slot | 20px wide, 28px high |
| Bullet target | 18px wide, 28px high |
| Visible bullet dot | about 7px |
| Desktop indent step | 36px |
| Mobile indent step | 28px |
| Main content width | 700px preferred, responsive |
| Zoomed title | 27px / 34px, bold |

The text column starts at the same x position for leaf and parent rows. A
missing arrow keeps its slot, so expansion state never moves text.

## Hierarchy Guides

Expanded branches render a low-contrast one-pixel vertical line aligned with
the owning bullet. The line begins below the parent row and ends at the final
visible descendant. Guides are decorative and ignored by assistive technology.

Guide geometry derives from the same indent token as drag projection. CSS and
drag calculations must not define separate indentation constants.

## Editing

Ordinary titles edit inline without a visible input border or filled field.
Focus is indicated by the caret and a restrained focus-visible treatment, not a
rounded row background.

Existing behaviors remain:

- Enter splits the title and creates the next node.
- Tab and Shift+Tab indent and outdent.
- Arrow keys navigate visible rows at boundaries.
- Empty Backspace removes only a safe empty node.
- IME composition never triggers structural commands.
- Drafts remain debounced and serialized through the existing coordinator.

Add the basic Workflowy shortcuts:

- Shift+Enter opens or focuses the supporting note.
- Ctrl/Cmd+Enter toggles completion.
- Alt/Cmd+Shift+D duplicates the node.
- Ctrl/Cmd+Shift+Backspace deletes the node.

## Supporting Notes

Supporting notes are part of the owning node, not a child row.

- A non-empty note is shown by default.
- An empty note appears when created through the menu or Shift+Enter.
- The editor has no box in its resting state.
- It grows with content and remains aligned to the title text.
- Blur and structural commands flush through the existing draft pipeline.

## Bullet Menu

Replace the current reserved drag, checkbox, star, note, duplicate, and delete
chrome with one compact context menu. The menu contains:

- Complete or uncomplete
- Star or unstar
- Add, edit, or remove supporting note
- Duplicate
- Export subtree
- Delete
- Retry save when a draft failed

The menu is available by pointer, keyboard, and touch. Hover may reveal a small
ellipsis to the left of the arrow, but revealing it must not change row width.

## Completion

Standard nodes continue to use circular bullets. Completion is a node state,
not an always-visible checkbox on every row.

- Completed titles use muted text and line-through.
- Ctrl/Cmd+Enter and the bullet menu toggle the state.
- A top-level show/hide completed control is allowed in Notes chrome.
- Existing SQLite fields and repository commands remain authoritative.

Dedicated Workflowy to-do node types are outside this visual-parity slice and
require a separate schema and product decision.

## Tags And Dates

The screenshot includes underlined tags and date pills. Storage remains plain
text. The first visual-parity release preserves exact text editing and may add
non-destructive display decoration only when it does not compromise caret,
selection, IME, or split behavior.

Token decoration must never rewrite stored text. If robust inline decoration
cannot be delivered without destabilizing editing, it is deferred as a
separate reviewed task rather than approximated with a misleading overlay.

## Drag And Drop

The circular bullet becomes the pointer drag activator. A movement threshold
distinguishes click-to-zoom from drag-to-move.

Dragging must:

- Move the entire subtree.
- Support above, below, indent, and outdent projections.
- Show a precise insertion line and proposed depth.
- Keep keyboard drag announcements and controls.
- Reject moves outside the current zoom boundary.

## Responsive Behavior

Desktop keeps a centered, readable content column inside the detail pane.
Narrow screens use the full available width with smaller horizontal padding.

- Breadcrumbs truncate or horizontally scroll without covering content.
- Indentation decreases to 28px but stays consistent.
- Bullet and arrow touch targets become at least 28px high.
- The bullet menu remains reachable without showing all actions permanently.
- Text never overlaps arrows, bullets, guides, or menus.

## Accessibility

- The outline remains an ordered semantic list with list items and aria-level.
- Arrow, bullet, and menu are separate named controls.
- Bullet accessible names describe zoom, not collapse or drag.
- Drag instructions and announcements remain available.
- Menus follow standard keyboard focus and Escape behavior.
- Focus-visible states meet contrast requirements.
- Reduced-motion preferences disable non-essential transitions.

## Verification Gates

Each implementation stage must pass:

1. Focused component and helper tests.
2. Full frontend regression tests and production build.
3. Independent behavior review.
4. Independent UI and accessibility review.
5. Desktop and narrow screenshot comparison against the approved reference.
6. Correction and re-review for every Critical or Important finding.

Final visual evidence must include:

- Expanded three-level branch with guide lines.
- Collapsed parent with halo and hidden descendants.
- Zoomed page title with breadcrumb.
- Inline supporting note.
- Empty bullet editing.
- Drag target preview.
- Completed node.
- Desktop and mobile-width layouts.

## Deferred Advanced Parity

Boards, tables, mirrors, backlinks, rich text formatting, file attachments,
sharing, collaboration, Workflowy AI, calendar sync, and native swipe gestures
are not part of this visual-parity implementation.

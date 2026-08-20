# Pages list follows the zoom into a page

Request (verbatim): "좌측 Pages 목록이 제목에 해당하는 서브 블릿 페이지로 들어가면
좌측 Pages 해당 목록에 focus 가 되도록 변경해줘"

## Baseline

On Home the primary pane renders the root outline, where every page is a
top-level bullet whose text is that page's title (`storeState.ts:87` — "A page
is nothing but a live child of the root"). Zooming into one of those bullets
runs `updatePrimaryZoom` (`App.tsx:565`), which sets `primaryZoomRootId` and
nothing else: `state.activePageId` stays `ROOT_ID`. The sidebar marks its rows
from `activePageId` alone (`App.tsx:800`), and the All row from
`atHome && libraryView === "all"`, so after the zoom the sidebar still lights
All and never the page the reader is now inside.

On a page other than Home the row for the open page already stays lit through a
zoom, because `activePageId` is that page.

## Contract

| Field | Content |
| --- | --- |
| Goal | While the primary pane is zoomed inside a page, that page's Pages row is the active row. |
| Acceptance | A1 Home → zoom a page bullet ⇒ that page's row is the only `data-active` row, All is not. A2 Home → zoom a bullet nested inside a page ⇒ the owning page's row is the active one. A3 zoom out to Home ⇒ All is the only active row again. A4 a page opened from the sidebar, then zoomed into a sub-bullet, keeps its own row active (unchanged). A5 a search or filter that hides the page rows leaves the mark on All, zoom or no zoom. A6 the All row and ⌘0 come out of a zoom on home, which is what a row that stopped being active now offers. |
| Non-goals | DOM focus for the sidebar button; scrolling the sidebar list to the row; the secondary (split) pane driving the sidebar; a Pages row for a nested bullet. |
| Boundaries | React only. No IPC, Rust, SQLite, persistence or native change. |
| Manual proof | Fresh app: All → zoom a page's bullet → its sidebar row is highlighted; zoom one level deeper → the same row stays highlighted; ⌘F and a query → the mark goes back to All; clear the query, then click the sidebar All row → out of the zoom, All highlighted; breadcrumb house from a zoom → All highlighted. |

Decisions:

1. "focus" is the list's active/current highlight (`data-active` +
   `aria-current="page"`), not DOM focus. Zoom entry places the caret in the
   outline (`zoomEntryFocus`); moving focus to the sidebar would take the caret
   away from the row the reader just entered.
2. No more than one row is active, and the zoom never costs the list a mark it
   would have had. The All row stops being active whenever a page row takes
   over; a zoom whose owning page has no row on screen -- deleted under the
   zoom, or filtered and searched out of the list -- leaves All active rather
   than lighting nothing. Three states carry no mark at all and this change
   does not touch any of them: a filtered library view, a page nobody has
   written in yet, and a page open behind a search.
3. Depth: the owning page is resolved by walking parents up to the child of
   `ROOT_ID`, not by matching the zoom root against `pages`. Matching alone
   would light the row on the way in and drop it again one zoom deeper, which
   reads as a bug. The walk is a pure helper over the outline nodes; on a page
   other than Home the page's own node is deliberately absent from `nodes`, so
   the walk returns null there and `activePageId` answers as it does today.
4. The sidebar follows the primary pane only. The split pane is a side view
   opened out of the primary one, and two panes cannot both name the row.

## Items

| # | Item | Acceptance | Failing test |
| --- | --- | --- | --- |
| 1 | `owningPageId(nodeId, nodes)` in `appNavigation.ts`; App subscribes to the outline snapshot, derives the zoomed page and feeds both the All row and `LibraryPageRow`. | A1, A2, A3 | `App.test.tsx` — "keeps the zoomed page's sidebar row active at any depth": after zooming the Backlog bullet from Home, the only `.notes-library-page-row[data-active='true']` has text "Backlog" (red today: it is All). |
| 2 | The highlight only moves to a row the list is showing: a filter or a search keeps it on All. | A5 | `App.test.tsx` — "leaves the mark on All while a search hides the page rows" (red: no active row at all). |
| 3 | `openAllPages` clears the primary zoom when home is already the open page. | A6 | `App.test.tsx` — "comes out of a zoom through the All row, which is what it offers" (red: the pane stays zoomed). |

Items 2 and 3 came out of the review. Item 3 widens the contract: the dead All
row predates this change, and moving the mark off it is what makes it the way
back that it now looks like.

A4 is locked by "keeps the open page's row active through a zoom inside it" and
the `owningPageId` unit cases in `appNavigation.test.ts`. It is a regression
lock on behaviour that is already right, so it never went red.

The helper without the wiring proves nothing user-visible, and the wiring
without the helper cannot be written, so item 1 lands as one change.

Cost of the new outline subscription: one more render of this window per
structural edit (an optimistic move publishes rows before its receipt publishes
anything else), none per keystroke, since a draft publishes to its own row
alone.

Existing tests that must keep passing: "opens All as the root outline" (asserts
one active row, All, with no zoom on) and "zooms a home row and comes back
through the breadcrumb house".

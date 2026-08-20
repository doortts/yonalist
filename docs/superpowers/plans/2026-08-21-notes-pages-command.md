# The page list gets a query of its own

Pays off both ceilings recorded in
`2026-08-21-refresh-pages-root-children-only.md`. Design phase ran on Opus:
the Fable 5 agent stopped again on `You've reached your Fable 5 limit`.

## Contract

| Field | Content |
| --- | --- |
| Goal | `refreshPages` reads the page list from a query that answers exactly "the root's live children", never from the root's viewport window. |
| Acceptance | (1) More pages than `VIEWPORT_LIMIT` allows still all arrive, however many descendants the earlier pages hold. (2) A row nested under a page never arrives. (3) A deleted page never arrives. (4) Absorbing a vault change no longer sends a viewport request for the root, so it cannot move the stored `active_page_id`. |
| Non-goals | The narrow patch path (`applyReceipt` keeps its own rule); `queries::viewport`'s `active_page_id` write itself, which stays correct for real page opens; the `pages` ordering, already verified in the previous item's doc. |
| Boundaries | SQLite query, storage worker, Tauri command, IPC surface, React store. No schema change, no persisted-format change. |
| Manual proof | N/A for the truncation itself — 80+ rows under Home is not a state to hand-build. The `active_page_id` half is covered by the store test asserting no root viewport request. |

## Item 1 — `pages` becomes a query the storage layer offers

`queries::bootstrap` already runs the right SELECT inline
(crates/notes-sqlite/src/queries.rs:56-74). Lift it to
`pub(crate) fn pages(connection) -> Result<Vec<PageSummary>, StorageError>` and
call it from `bootstrap`. Carry it out through the worker the way every other
read travels: a `Request::Pages { reply }` arm beside `Request::Viewport`
(worker.rs:164-167), its dispatch arm beside worker.rs:955-957, and
`pub fn pages(&self) -> Result<Vec<PageSummary>, StorageError>` beside
`query_viewport` (worker.rs:558).

Test: `crates/notes-sqlite/tests/viewport_queries.rs`, reusing its
`create_page`/`execute` helpers. Build more root children than the 80-row
window carries, give the first page enough descendants to fill that window
alone, then assert `storage.pages()` returns every page and no descendant.
Cover the deleted page in the same test — one page removed, absent from the
answer.

## Item 2 — the store asks for pages instead of a root viewport

`notes_pages` command in apps/desktop/src-tauri/src/lib.rs, shaped like
`notes_query_forest` (lib.rs:98-113) minus the request argument, registered in
the `generate_handler!` list (lib.rs:961-964). `pages(): Promise<PageSummary[]>`
on `NotesApi` and `pages: () => invoke("notes_pages")` on `tauriNotesApi`
(api.ts:30-66), plus the fixture at apps/desktop/src/test/appApiFixture.ts.
`refreshPages` then calls `this.api.pages()` and stores the answer as it comes —
`PageSummary` is already the state's own page shape (notesState.ts:2-8), so the
mapping in notesStore.ts:293-300 goes away with the filter and the
`ponytail:` marker.

Test: `apps/desktop/src/notesStore.test.ts`, in
`describe("다른 기기의 변경 흡수")`. The grandchild test from the previous item
becomes a `pages()` answer, and the wide change must leave `queryViewport`
called for the open page only, never for `"root"`.

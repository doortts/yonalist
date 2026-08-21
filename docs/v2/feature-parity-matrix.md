# Yonalist v2 Feature Parity Matrix

Baseline: `main@502af65`.

Status meanings:

- `complete`: the observable contract is implemented and tested in v2.
- `partial`: a visible subset exists but at least one baseline behavior is
  missing.
- `missing`: no equivalent v2 production path exists.
- `excluded`: explicitly outside the approved v2 parity scope.

This matrix is an implementation gate, not a claim that every legacy internal
helper must be ported.

| Area | Observable contract | Primary oracle | v2 status |
|---|---|---|---|
| Shell | Current layout, window chrome, sidebar resize/collapse, detail maximize | `src/App.test.tsx`, `src/styles.test.ts` | partial |
| Appearance | System/light/dark theme settings without layout changes | `src/components/SettingsPage.test.tsx` | missing |
| Pages | Create, open, edit page title, restart restore | `src/features/notes/NotesWorkspace.test.tsx` | complete |
| Page actions | Rename, duplicate, star, archive, trash, restore, read-only | `src/features/notes/NotesLibraryPageRow.test.tsx` | partial |
| Library views | All, Starred, Recent, Tags, Archive, Trash | `src/features/notes/NotesNavigationContent.test.tsx` | partial |
| Search | Title/note/attachment/date search, keyboard result navigation, open match | `src/features/notes/noteSearchQuery.test.ts` | partial |
| Tags | Unicode tag parsing, counts, multi-filter navigation | `src/features/notes/noteTagIdentity.test.ts` | partial |
| Dates | Date parsing, picker, `/today`, indexed queries | `src/features/notes/noteDates.test.ts` | partial |
| Basic drafts | Immediate overlay, 300ms/blur/close flush, IME safety | `apps/yonalist/src/App.test.tsx` | complete |
| Enter | Caret split, selected-range split, contextual child, repeated Enter, focus | `src/features/notes/outlineKeyboard.test.ts` | complete |
| Indentation | Tab/Shift+Tab, visible predecessor, zoom boundary, focus preservation | `src/features/notes/outlineKeyboard.test.ts` | complete |
| Arrow navigation | Up/Down rows, boundary Left/Right, page-header boundary | `src/features/notes/outlineKeyboard.test.ts` | complete |
| Empty Backspace | Start-caret guard, child lifting, focus order, single Undo | `src/features/notes/outlineKeyboard.test.ts` | complete |
| Collapse | Collapse/expand, hidden subtree navigation, collapsed-halo behavior | `src/features/notes/NotesWorkspace.test.tsx` | complete |
| Zoom | Bullet zoom, breadcrumb back, Workflowy shortcuts | `apps/yonalist/src/splitPaneIntegration.test.tsx`, `apps/yonalist/src/navigationHistoryIntegration.test.tsx` | complete |
| Split panes | Open/close/resize, independent scroll/focus, cross-pane consistency | `apps/yonalist/src/splitPaneIntegration.test.tsx`, `apps/yonalist/src/navigationHistoryIntegration.test.tsx`, `apps/yonalist/src/outlineClipboardIntegration.test.tsx` | complete |
| Supporting notes | Edit, auto-collapse, Shift+Enter and arrow navigation | `src/features/notes/NoteTextField.test.tsx` | complete |
| Completion | Single-row complete/incomplete and hidden completed subtrees | `src/features/notes/NotesWorkspace.test.tsx` | complete |
| Todo | Marker conversion, checkbox, direct-child progress | `src/features/notes/notesTodoProgress.test.ts` | complete |
| Markdown presentation | Inline Markdown, links, remote image width contract | `src/features/notes/noteMarkdown.test.ts` | partial |
| Slash commands | Menu ownership, `/today`, keyboard accept/cancel | `src/features/notes/notesSlashCommands.test.ts` | complete |
| Single-row shortcuts | Complete, duplicate, trash, structural move | `src/features/notes/outlineKeyboard.test.ts` | complete |
| Pointer selection | Shift range, primary toggle, text-drag promotion | `apps/yonalist/src/outlineClipboardIntegration.test.tsx` | complete |
| Keyboard selection | Shift+arrows, Escape, selection focus ownership | `src/features/notes/outlineKeyboard.test.ts` | complete |
| Batch actions | Complete, delete, indent, outdent, duplicate, reorder, single-step history | `apps/yonalist/src/outlineClipboardIntegration.test.tsx`, `crates/notes-sqlite/tests/vertical_slice.rs` | complete |
| Clipboard | Revision-checked complete-forest copy/cut and indented multiline paste | `apps/yonalist/src/outlineClipboard.test.ts`, `apps/yonalist/src/outlineClipboardIntegration.test.tsx`, `crates/notes-sqlite/tests/viewport_queries.rs` | complete |
| Drag/drop | Single/multi/keyboard/cross-pane move and exact drop preview | `apps/yonalist/src/outlineDragPlan.test.ts`, `apps/yonalist/src/outlineClipboardIntegration.test.tsx` | complete |
| Undo/Redo | Text/structure/session history and restart reset | `apps/yonalist/src/notesInteractionHistory.test.ts`, `apps/yonalist/src/outlineClipboardIntegration.test.tsx`, `crates/notes-application/tests/session_service.rs` | complete |
| Navigation history | Zoom, pane, selection and focus undo/redo restoration | `apps/yonalist/src/navigationHistoryIntegration.test.tsx` | complete |
| Attachments | Picker, clipboard, filesystem drop, list actions and limits | `src/features/notes/NotesAttachmentIngest.test.tsx`, `apps/yonalist/src/imageIngest.test.ts` | partial |
| Image nodes | Atomic multi-import, independent image rows, restart restore | `apps/yonalist/src/imageNodeIntegration.test.tsx`, `crates/notes-sqlite/tests/image_persistence.rs` | complete |
| Image atom editor | Caret, edit, copy/cut/paste, IME, keyboard navigation | `src/features/notes/ImageAtomEditor.test.tsx`, independent v2 image-node contract | partial |
| Image display | Resize, lightbox, remote Markdown image, progress/recovery | `apps/yonalist/src/ImageNodeContent.test.tsx`, `apps/yonalist/src/imagePerformance.test.tsx` | partial |
| Export | Shared snapshot, frontmatter Markdown, Korean PDF, atomic overwrite | `src/features/notes/NotesExportMenu.test.tsx` | missing |
| Data controls | Explicit Notes deletion, confirmation, local repair feedback | `src/features/notes/NotesDataSettingsDialog.test.tsx` | missing |
| Failure recovery | Stale revisions/cursors, dropped commands, retryable feedback | `src/features/notes/notesAuthorityRecovery.test.ts` | partial |
| Close lifecycle | Draft drain, close flush, destroy retry | `apps/yonalist/src/closeSession.test.ts` | complete |
| Startup/bundle | Viewport-first bootstrap and editable bundle budget | `docs/v2/performance.md` | complete |
| Vault synchronization | Markdown SSOT, reconciliation, sync retry/outbox | approved exclusion | excluded |
| GitHub Notifications | External read-only tree, viewed state, plugin settings | approved exclusion | excluded |
| v1 data compatibility | Migrations, legacy repair/readers | original v2 exclusion | excluded |

## Planned slices

| Slice | Rows closed |
|---|---|
| Text keyboard and tree gestures | Enter, indentation, arrows, Backspace, shortcuts |
| Node/editor parity | collapse, supporting notes, Todo, Markdown, slash/date |
| Library/discovery/settings | shell settings, page actions, views, search, tags, data controls |
| Selection/clipboard/drag | pointer/keyboard selection, batch actions, structural clipboard, drag |
| Media | attachments, image nodes, image atom editor, image display |
| Export | Markdown and PDF export |
| Final hardening | history/navigation, recovery, visual, platform, performance |

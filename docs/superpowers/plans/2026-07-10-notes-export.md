# Notes Markdown and PDF Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export a selected Notes subtree or current zoomed page as deterministic frontmatter Markdown or Korean-capable PDF without changing Notes source data.

**Architecture:** Rust loads one immutable export snapshot from `notes.sqlite`, then feeds Markdown and PDF renderers. The renderer requests an explicit destination through Tauri's native save dialog and invokes typed export commands; native file I/O writes to a sibling temporary file and atomically renames it only after successful rendering.

**Tech Stack:** Tauri 2 Dialog plugin, Rust printpdf 0.9.1, bundled Noto Sans KR under OFL, rusqlite, React 18, TypeScript, Vitest, Rust tests.

## Global Constraints

- Notes data remains authoritative in SQLite; export files never update or replace database rows.
- Both formats use the same `load_export_snapshot` repository helper.
- Markdown begins with YAML frontmatter containing kind, format version, source, root node ID, and exported UTC timestamp.
- Markdown preserves stable node IDs only in HTML comments.
- PDF does not rasterize the app UI or use a user-controlled print dialog.
- PDF embeds and subsets the bundled Noto Sans KR font; Korean fixture content must render without error.
- Save cancellation creates no destination file and performs no database mutation.
- Existing file paths require a visible overwrite confirmation; native write refuses overwrite unless `overwrite` is true.
- Do not add import, backup, remote publishing, or cloud storage in this phase.

---

## Target File Structure

| File | Responsibility |
| --- | --- |
| `src-tauri/Cargo.toml` | Dialog and PDF dependencies; Rust version floor |
| `package.json` | `@tauri-apps/plugin-dialog` dependency |
| `package-lock.json` | Locked frontend dependency graph |
| `src-tauri/src/file_io.rs` | Reusable atomic output helper extracted from vault writes |
| `src-tauri/src/notes/export.rs` | Export snapshot, Markdown renderer, PDF renderer, native writes |
| `src-tauri/src/notes/types.rs` | Export scope and result DTOs |
| `src-tauri/src/notes/commands.rs` | Explicit Markdown/PDF export commands |
| `src-tauri/src/notes/mod.rs` | Export module re-export |
| `src-tauri/src/lib.rs` | Dialog plugin initialization and command registration |
| `src-tauri/resources/NotoSansKR-Regular.ttf` | OFL-licensed embedded Korean font |
| `src-tauri/resources/NotoSansKR-OFL.txt` | Font license text shipped with source |
| `src/domain/notesExport.ts` | Renderer-side export types and filename helpers |
| `src/services/notesExport.ts` | Native save dialog and typed export invocation |
| `src/features/notes/NotesExportMenu.tsx` | Export menu and overwrite confirmation UI |
| `src/features/notes/NotesExportMenu.test.tsx` | Save/cancel/overwrite interaction tests |

## Stable Interfaces

```ts
export type NotesExportFormat = "markdown" | "pdf";

export interface NotesExportRequest {
  vaultPath: string;
  rootNodeId: NoteId;
  destination: string;
  overwrite: boolean;
}

export interface NotesExportResult {
  destination: string;
  format: NotesExportFormat;
}

export class NotesExportConflictError extends Error {
  constructor(public readonly destination: string) {
    super("Destination already exists.");
  }
}

export interface NotesExportScope {
  rootNodeId: NoteId;
}
```

```rust
pub struct NotesExportSnapshot {
    pub root_node_id: String,
    pub title: String,
    pub exported_at: String,
    pub root: ExportNode,
}

pub struct ExportNode {
    pub id: String,
    pub title: String,
    pub note: String,
    pub completed: bool,
    pub children: Vec<ExportNode>,
}
```

### Task 1: Extract Atomic File Output and Build Export Snapshots

**Files:**
- Create: `src-tauri/src/file_io.rs`
- Modify: `src-tauri/src/lib.rs`
- Create: `src-tauri/src/notes/export.rs`
- Modify: `src-tauri/src/notes/mod.rs`
- Modify: `src-tauri/src/notes/types.rs`
- Modify: `src-tauri/src/notes/repository.rs`

**Interfaces:**
- Consumes: existing `write_text_file_inner` behavior and the active Notes tree repository.
- Produces: `write_atomic_file`, `load_export_snapshot`, `render_markdown`, and `render_pdf`.

- [ ] **Step 1: Write failing native snapshot and atomic-write tests**

```rust
#[test]
fn export_snapshot_keeps_visible_child_order_and_completion_state() {
    let connection = seeded_export_connection();
    let snapshot = load_export_snapshot(&connection, "root").expect("snapshot");
    assert_eq!(snapshot.root.children[0].title, "First task");
    assert!(snapshot.root.children[0].completed);
}

#[test]
fn write_atomic_file_replaces_the_destination_only_after_a_complete_write() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let destination = temp_dir.path().join("export.md");
    write_atomic_file(&destination, b"new", false).expect("write");
    assert_eq!(fs::read(&destination).expect("read"), b"new");
    assert!(fs::read_dir(temp_dir.path()).expect("dir").all(|entry| !entry.expect("entry").file_name().to_string_lossy().contains(".tmp")));
}
```

- [ ] **Step 2: Run native tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml notes::export::tests`

Expected: FAIL because the export module and atomic helper do not exist.

- [ ] **Step 3: Extract the generic output helper and snapshot builder**

```rust
pub(crate) fn write_atomic_file(path: &Path, bytes: &[u8], overwrite: bool) -> Result<(), String> {
    ensure_parent(path)?;
    if path.exists() && !overwrite {
        return Err("Destination already exists.".to_string());
    }
    let file_name = path.file_name().and_then(OsStr::to_str)
        .ok_or_else(|| "File path must name a file.".to_string())?;
    let temporary = path.with_file_name(format!("{file_name}.tmp"));
    let mut file = fs::File::create(&temporary).map_err(|error| error.to_string())?;
    file.write_all(bytes).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    fs::rename(&temporary, path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        error.to_string()
    })
}
```

Move the existing vault-write implementation to `file_io.rs` without changing
its public behavior or existing tests. `load_export_snapshot` starts at the
requested active node, loads only active descendants sorted by `sort_key`, and
returns a pure recursive `ExportNode`; soft-deleted nodes never appear.

- [ ] **Step 4: Run snapshot and existing vault-write tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml notes::export::tests write_text_file`

Expected: PASS.

- [ ] **Step 5: Commit the export foundation**

```bash
git add src-tauri/src/file_io.rs src-tauri/src/lib.rs src-tauri/src/notes
git commit -m "refactor: share atomic output for notes exports"
```

### Task 2: Render and Save Frontmatter Markdown

**Files:**
- Modify: `src-tauri/src/notes/export.rs`
- Modify: `src-tauri/src/notes/commands.rs`
- Modify: `src-tauri/src/notes/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Create: `src/domain/notesExport.ts`
- Create: `src/domain/notesExport.test.ts`
- Create: `src/services/notesExport.ts`
- Create: `src/services/notesExport.test.ts`

**Interfaces:**
- Consumes: `NotesExportSnapshot` and `write_atomic_file` from Task 1.
- Produces: `notes_export_markdown`, `renderMarkdownExport`, and `saveNotesExport` for Markdown format.

- [ ] **Step 1: Write failing Markdown fixture and service tests**

```rust
#[test]
fn markdown_export_has_frontmatter_tasks_notes_and_stable_node_comments() {
    let output = render_markdown(&sample_snapshot());
    assert!(output.starts_with("---\nkind: yonalist-notes-export\nformat_version: 1\n"));
    assert!(output.contains("- [x] First task <!-- yonalist-node-id: task-1 -->"));
    assert!(output.contains("  > Supporting note"));
}
```

```ts
const invokeMock = vi.hoisted(() => vi.fn());
const saveMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: saveMock }));

beforeEach(() => {
  invokeMock.mockReset();
  saveMock.mockReset();
});

it("does not invoke a native export when the save dialog is canceled", async () => {
  saveMock.mockResolvedValue(null);
  await saveNotesExport({ vaultPath: "/vault", rootNodeId: "page", format: "markdown" });
  expect(invokeMock).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run Markdown tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml notes::export::tests::markdown_export && npm test -- src/domain/notesExport.test.ts src/services/notesExport.test.ts`

Expected: FAIL because no Markdown renderer or save service exists.

- [ ] **Step 3: Implement deterministic Markdown export**

```rust
fn render_markdown(snapshot: &NotesExportSnapshot) -> String {
    let mut output = format!(
        "---\nkind: yonalist-notes-export\nformat_version: 1\nsource: notes.sqlite\nroot_node_id: \"{}\"\nexported_at: \"{}\"\n---\n\n# {}\n\n",
        snapshot.root_node_id, snapshot.exported_at, escape_markdown_heading(&snapshot.title)
    );
    render_markdown_node(&snapshot.root, 0, &mut output);
    output
}
```

Use `- [x]` or `- [ ]`, two spaces per depth, `> ` blocks for supporting
notes, escaped Markdown title content, and `<!-- yonalist-node-id: ... -->`
after each bullet. Define `escape_markdown_heading` and
`render_markdown_node` in this module; the renderer passes their output through
`write_atomic_file`.

In `notesExport.ts`, call Tauri Dialog `save` with a `.md` default filename;
if it returns a path, call `notes_export_markdown` with `overwrite: false`.
Map `Destination already exists.` to a typed `NotesExportConflictError` so the
component can ask for confirmation instead of losing the first export request.

- [ ] **Step 4: Run Markdown renderer and service tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml notes::export::tests::markdown_export && npm test -- src/domain/notesExport.test.ts src/services/notesExport.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit Markdown export**

```bash
git add src-tauri/src/notes src/domain/notesExport.ts src/domain/notesExport.test.ts src/services/notesExport.ts src/services/notesExport.test.ts
git commit -m "feat(notes): export frontmatter markdown"
```

### Task 3: Render and Save Korean-Capable PDF

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src-tauri/src/notes/export.rs`
- Modify: `src-tauri/src/notes/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Create: `src-tauri/resources/NotoSansKR-Regular.ttf`
- Create: `src-tauri/resources/NotoSansKR-OFL.txt`
- Modify: `src/services/notesExport.ts`
- Modify: `src/services/notesExport.test.ts`

**Interfaces:**
- Consumes: the snapshot and semantic outline traversal from Tasks 1 and 2.
- Produces: `notes_export_pdf` and `saveNotesExport({ format: "pdf" })`.

- [ ] **Step 1: Write failing PDF and dialog-plugin tests**

```rust
#[test]
fn pdf_export_writes_a_valid_nonempty_document_for_korean_content() {
    let bytes = render_pdf(&korean_snapshot()).expect("pdf");
    assert!(bytes.starts_with(b"%PDF-"));
    assert!(bytes.len() > 1_024);
}
```

```ts
it("uses a PDF save filter and invokes the PDF command", async () => {
  saveMock.mockResolvedValue("/exports/project.pdf");
  invokeMock.mockResolvedValue({ destination: "/exports/project.pdf", format: "pdf" });
  await saveNotesExport({ vaultPath: "/vault", rootNodeId: "page", format: "pdf" });
  expect(saveMock).toHaveBeenCalledWith(expect.objectContaining({ filters: [{ name: "PDF", extensions: ["pdf"] }] }));
  expect(invokeMock).toHaveBeenCalledWith("notes_export_pdf", expect.objectContaining({ overwrite: false }));
});
```

- [ ] **Step 2: Run PDF tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml notes::export::tests::pdf_export && npm test -- src/services/notesExport.test.ts`

Expected: FAIL because PDF dependencies and renderer are absent.

- [ ] **Step 3: Add native dependencies and a semantic PDF renderer**

```toml
# src-tauri/Cargo.toml
rust-version = "1.77.2"

[dependencies]
printpdf = "0.9.1"
tauri-plugin-dialog = "2"
```

```ts
// package.json dependency addition
"@tauri-apps/plugin-dialog": "^2.3.3"
```

```rust
let font_bytes = include_bytes!("../../resources/NotoSansKR-Regular.ttf");
let font = ParsedFont::from_bytes(font_bytes, 0).map_err(|error| error.to_string())?;
```

Register `.plugin(tauri_plugin_dialog::init())` in the Tauri builder. Use
printpdf's explicit text shaping/layout APIs, not its experimental HTML path.
Render title, breadcrumb, bullet indent, completion marker, supporting note,
and page number from the snapshot. When a page has insufficient vertical room,
start a new page before writing the next whole bullet row.

- [ ] **Step 4: Run PDF and full native tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml notes::export::tests && npm test -- src/services/notesExport.test.ts && npm run build`

Expected: PASS.

- [ ] **Step 5: Commit PDF export support**

```bash
git add src-tauri/Cargo.toml package.json package-lock.json src-tauri/src/notes src-tauri/src/lib.rs src-tauri/resources src/services/notesExport.ts src/services/notesExport.test.ts
git commit -m "feat(notes): export korean capable pdf"
```

### Task 4: Add Export UI, Overwrite Confirmation, and End-to-End Fixtures

**Files:**
- Create: `src/features/notes/NotesExportMenu.tsx`
- Create: `src/features/notes/NotesExportMenu.test.tsx`
- Modify: `src/features/notes/NotesOutlinePane.tsx`
- Modify: `src/features/notes/notes.css`
- Modify: `README.md`

**Interfaces:**
- Consumes: `saveNotesExport`, `NotesExportConflictError`, current `zoomRootId`, selected node ID, and existing `ConfirmDialog`.
- Produces: node-subtree and current-page export commands for Markdown and PDF.

- [ ] **Step 1: Write failing export-menu tests**

```tsx
it("exports the selected node subtree as Markdown", async () => {
  render(<NotesExportMenu selectedNodeId="task" zoomRootId="page" />);
  await userEvent.setup().click(screen.getByRole("button", { name: "Export" }));
  await userEvent.setup().click(screen.getByRole("menuitem", { name: "Selected node as Markdown" }));
  expect(saveNotesExport).toHaveBeenCalledWith(expect.objectContaining({ rootNodeId: "task", format: "markdown" }));
});

it("asks before replacing an existing export", async () => {
  saveNotesExport.mockRejectedValueOnce(new NotesExportConflictError("/exports/page.md"));
  render(<NotesExportMenu selectedNodeId="page" zoomRootId="page" />);
  await exportCurrentPageMarkdown();
  expect(screen.getByRole("dialog", { name: "Replace existing export?" })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run export-menu tests to verify they fail**

Run: `npm test -- src/features/notes/NotesExportMenu.test.tsx`

Expected: FAIL because no export menu exists.

- [ ] **Step 3: Implement the compact export menu**

Use an icon button with tooltip label `Export`. Its menu offers exactly four
items: Selected node as Markdown, Selected node as PDF, Current page as
Markdown, and Current page as PDF. Disable selected-node items when no node is
selected. On conflict, open `ConfirmDialog` titled `Replace existing export?`;
confirm repeats the original request with `overwrite: true`, cancel preserves
the tree and leaves the destination unchanged.

- [ ] **Step 4: Run export-menu, renderer, and complete test suites**

Run: `npm test -- src/features/notes/NotesExportMenu.test.tsx src/features/notes/NotesWorkspace.test.tsx && npm run build && cargo test --manifest-path src-tauri/Cargo.toml`

Expected: all commands exit with status 0.

- [ ] **Step 5: Commit and document export behavior**

```bash
git add src/features/notes/NotesExportMenu.tsx src/features/notes/NotesExportMenu.test.tsx src/features/notes/NotesOutlinePane.tsx src/features/notes/notes.css README.md
git commit -m "feat(notes): add export menu and overwrite guard"
```

# Task 5 Backend And Pure Query Report

## Status

DONE_WITH_CONCURRENT_BUILD_BLOCKER

Implementation commit:
`9dd286a5ef6919a0b6d4814ff384a65c993c088a`

Starting commit:
`857ad71c2328dcfb8d98430a6fe10222e838a237`

## API Decisions

- Kept legacy `notes_search(vaultPath, query: string)` and
  `notesSearch(vaultPath, query: string)` unchanged.
- Added `notes_search_structured` and `notesSearchStructured` with the typed wire
  model `{ text, requiredTags, excludedTags, orGroups }`.
- Added `NotesStore.searchStructured?` as an optional interface method so existing
  custom stores and test doubles remain source compatible. The concrete
  `notesStore` always implements it.
- Reused the existing `"#" | "@"` prefix wire contract. Rust keeps the semantic
  `Hash | Mention` enum internally. Query tags carry `normalizedTag` and
  `displayTag`; SQL uses only the normalized value and prefix.
- Added `parseNoteSearchQuery`, `canonicalizeNoteSearchQuery`, and
  `canonicalNoteSearchQueryKey`. The stable key omits display casing while filters,
  alternatives, and groups are normalized, deduplicated, and sorted.
- Did not bump the Notes schema. Version 3 already owns the required prefixed
  `notes_tags` table and indexes.

## Implementation

- Pure parsing supports whitespace-AND text, required tags, leading-minus excluded
  tags, and uppercase `OR` chains of positive tags. Invalid markers and URL/path
  fragments remain plain text.
- A shared JSON fixture corpus is consumed by TypeScript and Rust. It covers Korean,
  ASCII, astral letters, combining marks, `_`/`-`, punctuation, URL evidence,
  root paths, invalid boundaries, and UTF-16 offsets.
- Rust tag extraction now ports the approved tokenizer and uses Unicode general
  categories for all mark classes. A byte-safe URL probe prevents UTF-8 boundary
  slicing while UTF-16 offsets remain available on extracted tokens.
- Structured SQL keeps FTS `MATCH` and `bm25` ranking for text. Every required and
  excluded tag is a parameterized `EXISTS` or `NOT EXISTS`; each OR group is one
  parameterized `EXISTS` with alternatives.
- Tag-only and exclusion-only searches drive from live, unarchived `notes_nodes`,
  order by `updated_at DESC, id`, and limit to 100. Exclusion-only results use
  `title`; tag-only results use `title` when any positive query tag occurs there,
  otherwise `note`.
- Archive and Trash retain tag rows, Empty Trash cascades them, and restore now
  rebuilds exact derived tags for the restored live subtree. Split, duplicate, and
  history replay are covered by exact-tag tests.

## TDD Evidence

### Pure Parser RED

```bash
npm test -- src/features/notes/noteSearchQuery.test.ts
```

Exit 1: Vite could not resolve the absent `./noteSearchQuery` module.

### Domain And Store RED

```bash
npm test -- src/domain/notes.test.ts src/services/notesStore.tauri.test.ts
```

Exit 1: 2 expected failures, `isNoteStructuredSearchQuery` and
`notesSearchStructured` were absent; 23 existing tests passed.

### Tokenizer Parity RED

```bash
cargo test --manifest-path src-tauri/Cargo.toml \
  notes_tag_tokenizer_matches_shared_typescript_fixtures
```

Exit 101: unresolved `tokenize_note_text` import.

### Structured Repository And Wire RED

```bash
cargo test --manifest-path src-tauri/Cargo.toml notes_tag
```

Exit 101: seven missing-symbol errors for the new query types, repository function,
and command.

### Restore Rebuild RED

```bash
cargo test --manifest-path src-tauri/Cargo.toml \
  notes_tag_lifecycle_rebuilds_exact_tags_and_cascades_empty_trash
```

Exit 101: stale retained tags survived restore, leaving 1 match instead of 2.

### UTF-8 Boundary RED

```bash
npm test -- src/features/notes/noteSearchQuery.test.ts && \
cargo test --manifest-path src-tauri/Cargo.toml \
  notes_tag_tokenizer_matches_shared_typescript_fixtures
```

TypeScript passed 14 tests; Rust failed on the same `abc𐐷#tag` fixture with a
non-character-boundary panic. The byte-slice scheme probe fixed the root cause.

## Final Verification

```bash
npm test -- src/features/notes/noteTokens.test.ts \
  src/features/notes/noteSearchQuery.test.ts src/domain/notes.test.ts \
  src/services/notesStore.test.ts src/services/notesStore.tauri.test.ts
```

Exit 0: 5 files and 74 tests passed.

```bash
cargo test --manifest-path src-tauri/Cargo.toml notes_tag
cargo test --manifest-path src-tauri/Cargo.toml notes_history
```

Exit 0: 6 tag tests and 17 history tests passed.

```bash
cargo test --manifest-path src-tauri/Cargo.toml 'notes::'
```

Exit 0: all 138 Notes Rust tests passed.

```bash
npx tsc --noEmit --target ES2022 --module ESNext \
  --moduleResolution Bundler --lib DOM,DOM.Iterable,ES2022 --skipLibCheck \
  --strict --resolveJsonModule --esModuleInterop src/domain/notes.ts \
  src/features/notes/noteSearchQuery.ts src/services/notesStore.ts
npx vite build
```

Exit 0: owned TypeScript source typechecked and the production bundle built 2,286
modules.

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets
```

Exit 0. Clippy reports five pre-existing warnings: `ptr_arg` in the existing
repository helper, two existing `lib.rs` warnings, `flat_map_identity` in export,
and `bool_assert_comparison` in an existing history test. Strict `-D warnings`
therefore exits 101 on those same five baseline warnings; it reports no Task 5
warning.

## Concurrent Blocker

`npm run build` exits 2 only on concurrent, out-of-scope history work:

- `src/features/notes/useNotesWorkspace.test.tsx:690` and `:1039`: calls currently
  pass two arguments to a one-argument function.
- `src/features/notes/useNotesWorkspace.ts:1286`: the `skipped` union member has no
  `committedHistoryEntryIds` field.
- `src/features/notes/useNotesWorkspace.ts:2498`: a possibly undefined workspace is
  passed where `NotesWorkspace` is required.

Those files, the coordinator files, and `.superpowers/sdd/task-2b-report.md` were
not staged or committed by this task.

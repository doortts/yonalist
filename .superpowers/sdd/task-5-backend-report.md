# Task 5 Backend And Pure Query Report

## Status

DONE

Implementation commit:
`9dd286a5ef6919a0b6d4814ff384a65c993c088a`

Quality remediation commit:
`761ade937064d003492b3b21e696f36b041f9b7a`

Canonical tag validation commit:
`3899f9bd5d6f12d32652f4c14405401eaf2f6f02`

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
- Defined typed `NoteTagFilter.normalizedTag` and `NoteSearchTag.normalizedTag` as
  canonical body-only values: nonempty, lowercase, marker-free, and accepted by
  the shared tag-body grammar. Only the string query parser consumes its one
  syntactic `#` or `@` marker; public typed payloads never repair input.
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

## Quality Remediation

### Tokenizer-Versioned Derived Index

- Added durable `notes_preferences` key `derived.tagTokenizerVersion`, with current
  JSON integer value `1`.
- Initialization reads the marker inside the existing immediate migration
  transaction. Missing, malformed, or older values rebuild `notes_tags` once from
  every stored node, including Archive and Trash, before recording the marker.
- Current or newer markers return without any tag writes. Queries continue to
  exclude archived and trashed nodes even though their rebuilt tag rows remain.

RED command:

```bash
cargo test --manifest-path src-tauri/Cargo.toml \
  version_three_initialization_rebuilds_old_tag_tokens_once_for_every_node
```

Exit 101: old schema-v3 rows still contained URL-fragment `#fragment` and truncated
combining tag `#cafe`. GREEN: 1/1 passed; audit triggers proved the second initialize
performed no tag writes, and a downgraded marker caused exactly one new rebuild.

### Bounded Structured Queries

- Text is limited to 4,096 UTF-8 bytes.
- Total unique normalized prefix/tag pairs are limited to 64 across required,
  excluded, and OR alternatives.
- Raw typed payloads are limited to 16 OR groups and 16 alternatives per group,
  before canonicalization can deduplicate them.
- Backend validation runs before FTS expression or dynamic predicate construction
  and returns stable errors. No query is silently truncated.
- TypeScript exports `NOTE_SEARCH_QUERY_LIMITS`,
  `validateAndCanonicalizeNoteSearchQuery`, and
  `parseAndValidateNoteSearchQuery`. The compatibility parser still returns the
  canonical query directly.

RED commands:

```bash
npm test -- src/features/notes/noteSearchQuery.test.ts
cargo test --manifest-path src-tauri/Cargo.toml \
  notes_tag_structured_search_enforces
```

The TypeScript RED had 5 expected missing-policy failures. The Rust RED had 4
expected limit failures; the 65-tag test reached a deliberately removed
`notes_tags` table, proving validation was not yet pre-SQL. A later parser RED
proved duplicate raw OR groups were being deduplicated before validation; raw
parsing now validates first.

### Remediation Verification

```bash
npm test -- src/features/notes/noteTokens.test.ts \
  src/features/notes/noteSearchQuery.test.ts src/domain/notes.test.ts \
  src/services/notesStore.test.ts src/services/notesStore.tauri.test.ts
cargo test --manifest-path src-tauri/Cargo.toml 'notes::'
```

Exit 0: 5 TypeScript files and 80 tests passed; all 143 Notes Rust tests passed.
Focused Rust evidence was 10 tag tests, 3 initialization tests, 6 migration tests,
and 17 history tests, all passing.

The isolated strict TypeScript source check, Vite production bundle of 2,286
modules, Rust format check, and standard all-target clippy also passed. Clippy
retains the same five pre-existing warnings documented above.

## Final Canonical Tag Validation

- Added shared TypeScript/Rust canonical-body fixtures covering Korean, ASCII,
  astral letters, combining marks, `_`/`-`, empty input, case drift, whitespace,
  punctuation, and all leading-marker combinations.
- TypeScript validates every typed tag before canonicalization and unique-count
  enforcement. `notesSearchStructured` and typed tag workspace scopes reject
  invalid payloads before invoking Tauri, while valid payloads retain their wire
  shape.
- Rust commands validate structured search and tag scopes before opening Notes
  storage. Repository validation uses the same exact body values for
  canonicalization, deduplication, limit counting, and SQL parameters.
- The boundary tests prove 63 ordinary tags plus canonical `x` is exactly 64;
  adding malformed `##x` returns the stable canonical-body error before counting,
  while adding a 65th canonical value returns the stable 64-tag limit error.

Canonical validation RED evidence:

```bash
npm test -- src/features/notes/noteSearchQuery.test.ts \
  src/services/notesStore.tauri.test.ts
cargo test --manifest-path src-tauri/Cargo.toml \
  notes_tag_filter_body_matches_shared_typescript_fixtures
cargo test --manifest-path src-tauri/Cargo.toml \
  notes_tag_command_validates_canonical_bodies_and_exact_limits_before_storage
```

The TypeScript RED produced 21 expected failures: the body predicate was absent,
the malformed 65th value was accepted, and the store forwarded invalid input.
The Rust fixture RED failed to compile because the body predicate was absent; the
command RED reached vault-path validation instead of rejecting the malformed tag.
Separate store and repository scope RED tests proved typed tag scopes still
silently repaired markers.

Final verification:

```bash
npm test -- src/features/notes/noteTokens.test.ts \
  src/features/notes/noteSearchQuery.test.ts src/domain/notes.test.ts \
  src/services/notesStore.test.ts src/services/notesStore.tauri.test.ts
cargo test --manifest-path src-tauri/Cargo.toml notes_tag
cargo test --manifest-path src-tauri/Cargo.toml 'notes::'
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets
```

Exit 0: 102/102 focused TypeScript tests, 14/14 focused Rust tag tests, and
147/147 Notes Rust tests passed. TypeScript typechecking and the Vite production
build completed with 2,288 modules. Rust formatting passed. Clippy completed with
the same five pre-existing warnings (`ptr_arg`, `flat_map_identity`,
`bool_assert_comparison`, `too_many_arguments`, and `manual_split_once`) and no
new Task 5 warning.

The concurrent history work was available for the final build. No coordinator,
hook, component, CSS, or shared UI test file was changed or committed here.

# Task 6 Backend Date Index/Search/Export Foundation Report

## Status

Implemented the Task 6 backend foundation with shared TypeScript/Rust fixtures,
transactional date indexing, lifecycle-scoped date search, history replay,
an injectable local-today boundary, and indexed canonical date display in PDF
exports.

The concurrently owned Notes workspace/header/library/outline/token/CSS files were
not edited or staged by this backend work.

## Delivered Surface

### Shared deterministic grammar

- Added `src/features/notes/noteDateFixtures.json`, consumed by both Vitest and
  Rust tests.
- Covers all six numeric forms, `YY -> 2000..2099`, all twelve official natural
  phrases, Monday and Sunday week starts, inclusive ranges, December-to-January
  inference, malformed/reversed range rejection without partial matches, tag
  exclusion, leap days, case-preserving raw text, and emoji UTF-16 offsets.
- Added `src-tauri/src/notes/date_index.rs`, a clock-free O(n) scanner with pure
  proleptic-Gregorian arithmetic for years 1 through 9999.
- The scanner performs fixed-size candidate checks over forward scalar/tag-span
  passes; it does not use regex backtracking or free-form NLP.

### Derived index and mutation transactions

- `replace_derived_content` replaces tags and dates in the same SQLite content
  transaction.
- Stored rows retain field, half-open UTF-16 offsets, normalized inclusive start
  and end ISO dates, and the exact raw token.
- Create, update, split, duplicate, and restore use one injected `today` for the
  whole command.
- Restore and Undo/Redo rebuild exact derived rows from restored node content.
- Archive and Trash retain derived rows; empty Trash removes them through the
  existing foreign-key cascade.
- A versioned `derived.dateParserVersion` backfills every existing live,
  archived, and trashed node once when opening a version-three database.

### Date search

- Added the wire-safe `NoteSearchScope` values `active`, `archive`, and `trash`.
- Existing `notesSearch(vaultPath, query)` remains source-compatible and defaults
  to active; callers may pass the additive third scope argument.
- Complete exact, range, or natural date expressions use a parameterized indexed
  inclusive interval-overlap query:
  `stored_start <= query_end AND stored_end >= query_start`.
- Non-date queries retain FTS behavior, including title/note match attribution.
- Date results return `matchedField: "date"`.
- Results use deterministic `updated_at DESC, id` ordering and a hard limit of
  100. Tests verify the first exact 100 IDs and `EXPLAIN QUERY PLAN` use of
  `notes_dates_range`.

### Local day semantics

- `SystemLocalTodayProvider` is isolated in `date_index.rs` and resolves SQLite
  `date('now', 'localtime')`.
- Command helpers accept a `LocalTodayProvider`; command tests inject a fixed
  date. Search, content indexing, restore, Undo, and Redo pass one resolved value
  through the operation.
- Picker commits normally persist canonical numeric text, so those dates are
  stable. Manually retained natural text is intentionally derived: it resolves
  against the command's local `today` whenever that content is indexed or
  rebuilt, including restore and history replay. Week start is parser-injected;
  backend storage/search currently uses the parser's deterministic Monday
  default until a persisted user preference is introduced.

### Export behavior

- Markdown rendering remains unchanged and preserves readable source date text
  under the existing Markdown escaping contract.
- Immutable export snapshot nodes now carry canonical indexed date spans for
  title and note fields. Snapshot loading does not reparse source text.
- PDF rendering transforms those validated spans from end to start so earlier
  UTF-16 offsets remain stable; Markdown continues to render raw source text.
- Relative text therefore keeps the canonical date captured when it was last
  indexed, even if PDF export occurs under a different system-local day.
- The transformation remains attachment-independent and runs only over title
  and note fields already owned by the text export path.

## Review Remediation

### Atomic malformed ranges

- Expanded the shared JSON fixture matrix with malformed spaced ranges whose
  right endpoint is short, incomplete, invalid, missing, alphabetic, or has an
  invalid trailing boundary.
- Both scanners now consume the malformed right-hand token as one rejected span
  instead of preserving the valid left endpoint as a standalone date.
- A malformed range does not hide a later independent date phrase, preserving
  the parser's forward O(n) scan.

### Lifecycle text search

- Added a versioned derived `notes_search_lifecycle` FTS index containing active,
  archived, and trashed nodes. It is transactionally rebuilt once for existing
  version-three databases and maintained by insert, content-update, and delete
  triggers.
- Active search remains on the original active-only `notes_search` table and
  retains its existing parameterized FTS expression and `bm25` ranking.
- Archive and Trash use the all-state index plus parameterized lifecycle joins,
  with the same deterministic rank/update/id ordering and 100-result limit.
- Tests cover title/note `matchedField`, active-state isolation, exact limiting,
  and deterministic ordering.

### Lifecycle parent trails

- Search ancestor maps are now built only from the selected lifecycle scope.
  Missing out-of-scope parents terminate the trail, matching workspace
  re-rooting rather than exposing a live ancestor.
- Mixed-parent tests cover an independently trashed child under a live parent, a
  trashed subtree under a live parent, and an archived root/child context.

## Strict TDD Evidence

### Shared fixture RED/GREEN

The Rust fixture test was added before the parser implementation:

```text
cargo test --manifest-path src-tauri/Cargo.toml \
  notes_date_parser_matches_shared_typescript_fixtures
```

RED: compile failed because `find_note_date_matches`, `LocalDate`,
`NoteDateMatch`, and `WeekStartsOn` did not exist.

The first behavior run then failed on a trailing natural phrase, exposing an
incorrect early return. After the control-flow fix, the same test passed.

The TypeScript fixture parity test initially failed on two hand-counted offsets;
the fixture values were corrected against the approved parser before Rust
implementation continued.

### Domain/store RED/GREEN

```text
npm test -- src/domain/notes.test.ts src/services/notesStore.tauri.test.ts
```

RED: `matchedField: "date"` was rejected and scoped `notes_search` payloads were
not sent. GREEN: 2 files, 32 tests passed.

### Repository/history/export RED/GREEN

Repository tests were added against missing injected mutation/search APIs and
failed to compile. After implementation, focused tests verify:

- exact title/note rows through create/update/split/duplicate/restore;
- tags, dates, and content rollback together on a projection failure;
- active/archive/trash interval overlap, natural queries, FTS fallback, indexed
  query strategy, deterministic 100-result cap;
- one-time version-three backfill;
- exact Undo/Redo date rows;
- unchanged Markdown source and end-to-start PDF display transformation.

## Verification

Baseline before edits:

```text
npm test -- src/features/notes/noteDates.test.ts
```

Result: 69/69 passed.

```text
cargo test --manifest-path src-tauri/Cargo.toml notes::
```

Result: 148/148 passed.

Final focused TypeScript:

```text
npm test -- src/features/notes/noteDates.test.ts \
  src/domain/notes.test.ts src/services/notesStore.tauri.test.ts
```

Result: 3/3 files and 120/120 tests passed.

Review-remediation fixture/domain rerun:

```text
npm test -- src/features/notes/noteDates.test.ts src/domain/notes.test.ts
```

Result: 2/2 files and 107/107 tests passed, including all 96 shared date
fixture/parser tests.

Final focused and complete Rust:

```text
cargo test --manifest-path src-tauri/Cargo.toml notes_date
```

Result: 6/6 passed.

```text
cargo test --manifest-path src-tauri/Cargo.toml notes::
```

Result after review remediation: 159/159 passed.

The focused repository, history, and export suites passed 68/68, 17/17, and
17/17 respectively. The immutable relative-date PDF export test and shared Rust
fixture parity test also passed independently.

Build and formatting:

```text
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
git diff --check
```

All exited 0. TypeScript compilation and Vite production build completed with
2,290 modules transformed.

The full Vitest run completed 1,836/1,837 tests. Its one failure reproduces in
isolation in the pre-existing `App.test.tsx` case `continues to edit Notes while
offline and unsigned in`, which cannot find the UI-owned `Edit node title`
textbox. No app-shell, workspace hook, Outline, Header, Library, CSS, or
NoteToken file is part of this backend change.

Clippy:

```text
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

The unfiltered command remains blocked by five pre-existing unrelated lints:
`ptr_arg` in the old `sqlite_companion_path`, `too_many_arguments` and
`manual_split_once` in existing `lib.rs`, `flat_map_identity` in an existing
export test, and `bool_assert_comparison` in an existing history test. The two
new MSRV findings in `date_index.rs` were fixed.

Allowing only those five known baseline lints, all targets pass with
`-D warnings` and exit 0.

## Scope Notes

- No schema version bump was required because `notes_dates` and its range index
  already exist in version three. A derived parser-version preference handles
  data backfill independently of structural migration.
- No dependency was added; system-local date resolution uses SQLite.
- PDF title/note display now uses immutable canonical indexed dates; Markdown
  and the attachment pipeline remain unchanged.
- Concurrent frontend integration changes landed separately and remain outside
  this backend commit.

# Task 1 Report — Phase 1 Topic File Renderer and Parser

## Status

DONE. Phase 1 is implemented on `codex/notes-file-ssot-sync` with pure format
types, deterministic topic/trash rendering, a tolerant whole-file parser, a
committed golden fixture, and no database, runtime, watcher, exporter, command,
event, frontend, or attachment-ingest changes.

## Contract delivered

- Added `notes::sync` module wiring and shared typed format values for:
  - topic documents and root metadata;
  - virtual `trash.md` documents plus repeated purge tombstones;
  - ordered nodes, optional external-editor IDs, HLC, starred/completed state,
    trash restore origin, sibling ordinal/sort key, notes, and image atoms.
- Renderers use fixed frontmatter ordering, LF endings, explicit vector order,
  deterministic purge sorting, canonical UUID/HLC/hash output, two-space
  indentation, `[x]` completion markers, and the existing inline/note escaping
  helpers from `export.rs`.
- Image atoms emit and parse only
  `.yonalist/notes-assets/<64 lowercase sha256>.<safe extension>` links with
  canonical percent-encoded original names and deterministic integer-or-`-`
  display widths. Absolute, traversal, and noncanonical paths quarantine the
  complete file.
- The hand-rolled parser normalizes CRLF, defaults absent optional frontmatter,
  accepts manually added bullets without `yid`, treats malformed HLC as empty,
  ignores unknown forward-compatible keys/tokens, normalizes odd-space/tab
  indentation, reconstructs `SORT_KEY_STEP` sibling positions, and preserves
  valid incoming IDs/HLC strings.
- `TopicParseOutcome` is either a complete `TopicFile` or a typed
  `TopicQuarantine`; it exposes no partial document. The byte, depth, and node
  caps are checked before a result can escape.

## Files

- `src-tauri/src/notes/sync/topic_file.rs`
- `src-tauri/src/notes/sync/topic_parser.rs`
- `src-tauri/src/notes/sync/mod.rs`
- `src-tauri/src/notes/sync/fixtures/topic_golden.md`
- `src-tauri/src/notes/mod.rs`
- `src-tauri/src/notes/export.rs` (visibility-only reuse of existing escaping)

## TDD evidence

### RED

1. `notes::sync::topic_file::tests::renders_the_committed_topic_fixture_exactly`
   first failed to compile because `render_topic_doc` and the shared topic
   types did not exist.
2. `notes::sync::topic_parser::tests::parses_and_renders_topic_golden_byte_identically`
   first failed to compile because `parse_topic_file`, `TopicParseOutcome`, and
   `TopicParseError` did not exist.
3. The parser tolerance/quarantine suite was written before parser production
   code and initially failed for that missing API. It covers every row in the
   required tolerance table plus canonical asset rejection and all file caps.
4. `preserves_a_note_that_begins_with_a_blank_blockquote_line` first failed by
   dropping the leading blank note line. The parser now records note-line count
   separately from note text and the focused test passes.

### Focused GREEN

```text
cargo test --manifest-path src-tauri/Cargo.toml notes::sync -- --nocapture
```

Passed: 19 sync tests. Coverage includes deterministic repeated renders, the
committed topic golden fixture, byte-identical topic/trash parse-render cycles,
image before/after text and notes, every parser-tolerance rule, malformed and
missing metadata, asset quarantine, and exact cap boundaries.

## Final verification (frozen diff)

- `npm run lint` — pass.
- `npx tsc --noEmit` — pass.
- `npm test` — pass.
- `npm run test:architecture` — pass. Existing workspace counters remained
  within their configured budgets (`useNotesHistoryController.ts` exactly
  1500/1500; no Phase 1 frontend surface changed).
- `cargo test --manifest-path src-tauri/Cargo.toml` — pass: 766 tests run;
  existing intentionally ignored performance/large-allocation tests unchanged.
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` — pass.
- `git diff --check` — pass.

## Self-review and scope

- Serialization never iterates a `HashMap`; children retain vector/file order
  and purge tombstones have an explicit stable sort.
- The parser contains no `unwrap`/`expect` paths over file data and all fallible
  parsing is converted to a typed whole-file quarantine.
- The 16 MiB byte check occurs before UTF-8/newline allocation. Node and depth
  limits return before tree construction, so no partial `TopicFile` is returned.
- No absence/deletion interpretation, merge, SQLite application, file I/O,
  watcher, runtime, command, event, frontend, notify dependency, or asset
  ingest/GC behavior was added.
- The module is deliberately marked `#[allow(dead_code)]` while later sync
  phases wire these pure Phase 1 APIs into runtime code; this keeps the current
  common gate warning-free without changing behavior.

## Independent-review remediation

The Phase 1 diff was reopened after an independent spec-axis review. The
follow-up wave closed every requested format-boundary issue without adding
Phase 2 merge behavior or runtime/file-I/O wiring.

### Corrections and clarified scope

- `export.rs` has visibility-only changes so the topic renderer can reuse the
  existing escaping functions. There is no exporter behavior change.
- The pure `derive_topic_filename` helper now implements §4.2, including NFC,
  control removal, reserved/whitespace-run replacement, edge trimming,
  UTF-8-safe 40-character truncation, `untitled`, case preservation, and the
  canonical topic UUID suffix. Persisting the generated name once remains a
  later database/runtime phase.
- Manual UI proof is not applicable: this wave changes only pure Rust format
  parsing/rendering helpers and tests, with no frontend or runtime surface.

### Review RED and GREEN evidence

The review tests were added before each behavior fix. Representative RED
failures included:

- `quarantines_duplicate_recognized_frontmatter_fields`;
- `quarantines_present_invalid_missing_or_duplicate_identity_tokens`;
- `quarantines_unconsumed_body_lines` and
  `quarantines_every_noncanonical_image_like_body_atom`;
- `parses_image_only_bullet_without_node_metadata`;
- `enforces_the_shared_field_cap_for_root_and_text_titles`;
- `accepts_forward_compatible_reordered_image_metadata_tokens`;
- `derives_a_stable_sanitized_topic_filename`;
- `canonicalizes_purge_tuples_before_sorting_them`.

The final focused command on the completed review diff was:

```text
cargo test --manifest-path src-tauri/Cargo.toml notes::sync -- --nocapture
```

Result: **55 passed, 0 failed**.

### Hardened contract

- Every recognized scalar frontmatter key is single-valued; repeated `purged`
  remains valid. Invalid known sort/boolean/timestamp values, invalid topic
  UUIDs, malformed purge structure, and hidden future versions quarantine the
  whole file. Missing optional keys and malformed HLCs retain their specified
  defaults.
- Node identity metadata distinguishes absence from invalid presence, rejects
  duplicate known tokens and duplicate UUID identities, preserves missing
  `yid` as `None`, and keeps malformed or missing `t` as an empty HLC.
- Every nonblank body line must be consumed in a valid position. Leading,
  trailing, unplaced, post-note, orphan, noncanonical, absolute, and traversal
  image-like input quarantines rather than producing a partial document.
- Canonical original-name decoding is shared with `markdown_import`; exact
  percent re-encoding, UTF-8, nonblank, 1,024-byte, and shared field limits are
  enforced. Image `ya` tokens may be reordered and extended, while duplicate,
  missing, or malformed known tokens quarantine. Owned storage extensions are
  exactly `png`, `jpg`, `webp`, and `gif`.
- The shared 16 MiB limit and existing depth, node, and field limits have exact
  accepted-boundary and plus-one quarantine coverage. Field accumulation is
  checked before growth for titles, image before/after text, and notes.
- Purge tuples are canonicalized before sorting, and round-trip tests cover
  escape-sensitive content, empty-before primary images, after text, notes,
  children, trash images, sibling ordinal resets, equal purge entries, invalid
  UTF-8, and individually missing optional fields.

### Remaining phase boundaries

- Assigning UUID/HLC values to accepted external bullets remains Phase 2.
- Recording quarantine state, choosing a filename only once, and performing
  atomic file writes remain later database/runtime phases.
- The frozen-diff common gate is intentionally run after this appendix is
  written; its exact results are supplied in the commit handoff so the verified
  source diff is not changed afterward.

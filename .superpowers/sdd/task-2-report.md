# Task 2 Report — Phase 2 HLC LWW Merger

## Status

DONE. Phase 2 implements the transactional topic/trash merger on top of the
Phase 0 HLC/schema foundation and Phase 1 parsed documents. It adds no watcher,
exporter, runtime, command, event, filesystem-write, manual Markdown
import/export, or frontend behavior.

## Contract delivered

- `merge_topic_doc` and `merge_trash_doc` each apply one parsed document in one
  `IMMEDIATE` transaction, observe every accepted max/root/node/purge HLC before
  issuing any fresh HLC, persist the local clock, and return a `MergeReport`.
- Whole-node LWW preserves incoming HLC strings exactly, treats equal HLC as a
  no-op, logs each losing remote state once, preserves device-local collapse
  state, creates no history context, and rebuilds derived tag/date indexes only
  for applied content.
- Topic roots and descendants are processed in file order. Missing file nodes
  are never deleted; older local-only active members request write-back, while
  trash residents do not count as absent topic members.
- External bullets without `yid` receive a fresh UUIDv4 and local HLC and mark
  write-back dirty. A stamped canonical document is idempotent when reapplied.
- Image metadata is synchronized as a deterministic UUIDv4-shaped attachment
  placeholder without requiring local asset bytes. Node/attachment namespace,
  owner collision, per-vault capacity, and transaction rollback are enforced.
- Trash merge preserves restore parent/sort metadata, creates a minimum-HLC
  placeholder when the topic arrives later, applies soft-delete metadata, and
  accepts purge tombstones only when their HLC is nonempty.
- Purge applies only when `node.hlc < purged_hlc`. Newer survivors are detached
  from purged parent/archive-root foreign keys, fresh-restamped, marked dirty,
  and recovered without flattening unaffected descendant structure.
- Cycle recovery detects all members of each observed cycle and parks the
  globally lowest `(hlc, id)` edge under the deterministic UUIDv5 recovery
  topic. Recovery sibling sort keys derive from node UUIDs, so independent
  recovery order is stable. Hidden, renamed, or tombstone-losing recovery roots
  are normalized/reactivated above the incoming evidence before reuse.
- `sync_topics.file_name` is assigned once and never follows later title
  changes. When no Phase 3 source/initial-title seed exists, the merger uses the
  order-independent `untitled.{topic_id[..8]}.md` fallback; `applied_max_hlc`
  advances monotonically.

## SSOT clarification

The immutable parser output and fixed Phase 0 schema contain no durable
identity for a bullet whose `yid` is absent. A byte-identical pre-write-back
delivery is therefore observationally indistinguishable from a distinct new
external bullet in the same structural slot.

The approved fixed-schema contract chooses the literal §8 `uuid_v4()` rule:
every delivery without `yid` is a new external input and receives a new
UUIDv4/HLC. Idempotence begins once those values are written back and the
stamped canonical document is reapplied. Later watcher coalescing and echo
suppression reduce operational duplicate delivery; no heuristic identity
inference or provenance schema was added in Phase 2.

The SSOT implementation plan now states this exception in §1, §7.3, §8, the
Phase 2 matrix, and the Task 2 acceptance criteria.

## Files

- `src-tauri/src/notes/sync/merger.rs`
- `src-tauri/src/notes/sync/mod.rs`
- `src-tauri/src/notes/hlc.rs`
- `docs/superpowers/plans/2026-07-21-notes-file-ssot-sync-implementation.md`
- `.superpowers/sdd/task-2-report.md`

## TDD evidence

### Initial and expansion RED → GREEN

1. The first two merger tests failed against the stub, then passed after the
   minimal transaction/LWW implementation: **0/2 → 2/2**.
2. The first behavior expansion exposed five expected failures, then passed all
   topic/trash, conflict, external-ID, absence, and attachment cases: **3/8 →
   8/8**.
3. Cycle/convergence and duplicate-identity tests exposed two expected failures,
   then passed: **10/12 → 12/12**. Edge expansion subsequently reached **18/18**.
4. The filename immutability regression first observed the stored filename
   changing from `Topic…` to `Renamed…`; the one focused test then passed after
   making `sync_topics.file_name` insert-only.
5. Attachment namespace/cap regressions first failed **2/4**, then the expanded
   focused suite passed **18/18** with transactional rollback.

### Independent-review RED → GREEN

The first independent review reported Critical/Important/Minor **3/5/3**. An
11-test remediation wave was captured at **19 passed / 11 failed**, then passed
**30/30** after fixing global-lowest cycle selection, purged-root no-op handling,
purge-orphan foreign keys, trash-before-topic ordering, deterministic recovery
sorts, collapse preservation, malformed HLC precedence, stable filenames, and
trash-aware absence detection.

Further focused RED cases reproduced and fixed:

- prior parent purge followed by a newer trash descendant (parent FK rollback);
- remote node ID colliding with the attachment UUID namespace;
- archived purge survivors retaining `archive_root_id` (archive FK rollback);
- soft-deleted/archived, renamed, or tombstone-losing recovery roots;
- newer descendants below skipped tombstoned or empty-HLC topic parents;
- nested descendants retaining stale archived ancestry;
- equal-HLC nodes being accidentally parked despite the required no-op;
- canonical stamped replay versus explicitly distinct immutable unstamped
  delivery.

Final focused results:

- merger tests: **41 passed, 0 failed**;
- complete `notes::sync` tests: **100 passed, 0 failed**;
- HLC tests: **8 passed, 0 failed**.

## Independent review

- Initial review: Critical/Important/Minor **3/5/3**.
- Final implementation rereview before SSOT clarification and delivery evidence:
  **0/1/1**. The Important was only the now-approved/documented unstamped-input
  contract ambiguity; the Minor was the then-missing report/commit/full gate.
- Post-clarification delivery rereview: Critical/Important/Minor **0/0/1**.
  Implementation, clarified SSOT, report, and verification evidence were
  approved; the sole Minor was the intentionally not-yet-created delivery
  commit. The resulting SHA is reported in the parent handoff because a
  single commit cannot include its own SHA without a later amend/commit.

## Initial delivery verification (`a841efa` frozen diff)

- `npm run lint` — pass.
- `npx tsc --noEmit` — pass.
- `npm test` — pass: **3,851 passed, 27 skipped** across 183 test files
  (182 passed, 1 skipped).
- `npm run test:architecture` — pass; all Notes workspace budgets remain within
  their configured limits.
- `cargo test --manifest-path src-tauri/Cargo.toml` — pass: **845 passed,
  3 intentionally ignored, 0 failed**.
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` — pass.
- `git diff --check` — pass.

An exploratory repository-wide `cargo clippy --all-targets -- -D warnings`
encountered the current baseline of 93 diagnostics outside the Phase 2 files
under the installed Rust/Clippy version. Filtering that same strict run to the
changed Rust files produced no diagnostics. Clippy is not part of the Task 2
common gate above.

## Scope and remaining phase boundaries

- Manual UI verification is not applicable: this phase exposes no runtime,
  command, event, or frontend surface.
- Asset bytes may legitimately remain absent behind synchronized attachment
  placeholders; later watcher/asset phases deliver and announce the bytes.
- Export/write-back, watcher coalescing/echo suppression, bootstrap, runtime
  events, quarantine status, and UI reload remain later phases.
- Pre-write-back replay of immutable unstamped input intentionally creates a new
  external node as documented in the clarified SSOT contract.

## Sol xHigh final-review fix wave

The post-delivery Sol review reopened Phase 2 for three correctness findings and
one codebase-aware ordering audit. The implementation now:

- accepts a topic parent only when its lifecycle is live for the current active
  or archived ancestry; a newer active descendant below a soft-deleted or
  archived losing parent is recovered, while trash continues to preserve
  physical deleted-parent ancestry;
- propagates loss of archive context to nested descendants, so an already
  recovered active parent remains viable for its active children;
- uses the topic-ID-only filename fallback only when inserting a missing
  `sync_topics` row, making `A→B` and `B→A` title arrival converge without
  renaming an existing row; and
- pre-scans max, root, every nested node, and every purge tombstone HLC before
  any UUID assignment, orphan repair, cycle park, or recovery-topic
  creation/reactivation.

### Sort-key review pushback

`notes_nodes.sort_key` is intentionally non-unique. The production workspace,
archive, trash, starred, recent, tag, export-snapshot, and sibling-order reads
already break collisions with `id` (`ORDER BY … sort_key, id` or the equivalent
Rust tuple comparison). Therefore the merger does not renumber an absent node
or issue a replacement HLC merely to manufacture sort-key uniqueness. A new
regression proves an exact collision is read in deterministic ID order, requests
write-back for the older absent sibling, stays unchanged on repeated delivery,
and converges across document order. No production ordering query required a
change.

### Fix-wave RED → GREEN evidence

- soft-deleted/archived parent viability: **0/2 → 2/2**; the trash-parent
  characterization remained **1/1**;
- title-order filename convergence: **0/1 → 1/1**, with the prior insert-once
  filename regression also green;
- root, nested-node, and purge HLC pre-scan: **0/3 → 3/3**. Before the fix, fresh
  UUID/repair HLCs lost to accepted evidence and recovery reactivation ended in
  a foreign-key failure;
- sort-key collision characterization: **1/1**, confirming the existing
  production tie-break contract without a production mutation; and
- merger focused suite: an intermediate archive-context propagation
  regression was **48/49**, then the corrected context-aware traversal reached
  **49/49**.

### Independent fix-wave rereview follow-up

The first fix-wave rereview reported Critical/Important/Minor **0/1/1**. The
Minor was the intentionally pending full-gate/report refresh. The Important
reproduced only for archived cycles: the selected edge became active under the
recovery topic while live descendants retained archive lifecycle. A dedicated
RED then passed after fresh-restamping, dirtying, and reindexing only the live
archived parked subtree. A second RED fixed the related trash boundary by
keeping the parked node and its deleted descendants in trash instead of
restoring them. Deleted descendants below an active parent remain the normal
storage representation that the trash workspace reroots.

- archived cycle lifecycle: **0/1 → 1/1**;
- trash cycle lifecycle: **0/1 → 1/1**;
- all cycle-focused repository/merger tests: **15/15**;
- frozen merger focused suite after the follow-up: **51/51**.

## Fix-wave final rereview and verification

The read-only follow-up rereview confirmed the cycle Important was resolved and
reported Critical/Important/Minor **0/0/1**. The sole Minor was this then-pending
verification-evidence refresh; implementation was approved, deleted-child trash
rerooting matched the production workspace query, and no Phase 3 leakage was
found.

The final common gate was rerun from the frozen fix-wave diff:

- `npm run lint` — pass.
- `npx tsc --noEmit` — pass.
- `npm test` — pass: **3,851 passed, 27 skipped** across 183 test files
  (182 passed, 1 skipped).
- `npm run test:architecture` — pass; all Notes workspace budgets remain within
  their configured limits.
- `cargo test --manifest-path src-tauri/Cargo.toml` — pass: **855 passed,
  3 intentionally ignored, 0 failed**.
- `cargo test --manifest-path src-tauri/Cargo.toml notes::sync::` — pass:
  **111 passed, 0 failed**.
- merger focused suite — pass: **51 passed, 0 failed**.
- `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check` — pass.
- `git diff --check` — pass.

This refresh resolves the rereview's sole Minor evidence item.

The final evidence-only closeout reported Critical/Important/Minor **0/0/0**
and **Ready: Yes**.

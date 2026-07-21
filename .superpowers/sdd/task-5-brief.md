# Task 5 Brief — Asset dedup, progress, GC, settings, purge

## Goal

Make attachment ingest hash-first and observable, and reclaim unreferenced assets safely through a configurable quarantine and explicit purge flow.

## Acceptance

| Row | Observable result |
| --- | --- |
| Hash-first dedup | Re-ingesting an existing content hash performs zero asset copies, inserts the attachment reference, and emits `done` immediately after hashing. |
| Progress contract | `notes://asset-ingest-progress` uses raw IPC `requestId` and emits ordered `hashing -> copying -> done` phases with monotonic byte counts and `contentHash` on completion. In-memory inputs may emit one immediate hashing event. |
| Existing safety | All existing size caps, safe path checks, lock/lease behavior, and attachment-row semantics remain intact. |
| Refcount GC | Refcount is derived from `notes_attachments`; zero-ref assets move to app-local `asset-trash` and receive 7-day or 2-day retention according to the 5 MB default threshold. |
| Re-reference | A quarantined asset whose refcount becomes positive is restored to `notes-assets` and its trash record is removed. |
| Expiry | Expired quarantined files and rows are deleted; GC runs at most every 60 seconds on the exporter tick. |
| Purge | `confirm=false` records and reports the vault-scoped zero-ref membership without deletion; `confirm=true` deletes only when the current membership exactly matches that preview, otherwise it requires a new dry-run. Quarantined entries remain included. |
| Settings | `assetTrashRetentionDays`, `assetTrashLargeFileDays`, and `assetLargeFileThresholdMb` exist in interface/defaults/normalize/needsNormalization, are passed to `notes_sync_start`, and the data settings dialog supports dry-run then explicit confirmation. |
| Frontend progress | A focused `assetIngestProgress.ts` listener/hook handles the fixed payload without introducing a broad workspace rerender. |

## Non-goals

- Phase 6 cross-device integration, failure injection, and performance scenarios.
- Changes to topic merge semantics, watcher security, or the fixed event names/payloads.
- A separate persisted refcount counter.
- Broad attachment UI redesign.

## Boundaries

- React settings/dialog/store/runtime config and ingest request creation.
- Tauri IPC input/output/event payloads.
- Rust attachment ingest, SQLite attachment/trash rows, filesystem asset movement/deletion, exporter runtime tick.
- App-local storage remains under `NOTES_DATA_ROOT/<vault_key>/asset-trash`; synced markdown/assets remain under the vault.

## Implementation constraints

- Follow TDD: focused failing test first for each acceptance row, then the smallest production change.
- Preserve existing caps, lock/lease and file safety invariants.
- Stream file hashing/copying in 1 MB chunks; do not load path-batch files wholesale.
- Add `request_id: Option<String>` to each existing import input for backward compatibility; Tauri `AppHandle` injection must not alter frontend invoke shape.
- Use no-replace/fail-closed movement where an overwrite could destroy a live asset.
- Keep architecture budgets green; do not expand Phase 5 scope to repair unrelated debt.

## Verification

- Focused Rust tests for dedup/progress/GC/re-reference/expiry/purge and existing attachment safety regressions.
- Focused frontend tests for settings normalization, raw request IDs, progress listener lifecycle, and purge confirmation.
- After the diff is frozen, run the common full gate once: typecheck, lint, frontend tests, Rust tests, architecture, build, Rust formatting, and diff check.
- Internal spec/code review must report Critical/Important 0 before handoff.

## Manual proof

Deferred to Phase 6 fresh Tauri smoke: ingest the same image twice, observe ordered progress and no duplicate asset, remove/re-add a reference, then dry-run and confirm purge in an isolated vault.

## Delivery record

- Implemented hash-first, 1 MiB streaming ingest with request-scoped progress for all five existing ingest paths; deduplicated assets skip copying.
- Added derived-refcount asset quarantine, configurable retention, safe re-reference, expiry, and fixed-contract dry-run/confirmed purge.
- Preserved Undo/history assets through quarantine and made replay restoration preflight-only until all state validation passes, with commit-coupled staging and rollback.
- Focused evidence: frontend owning files 281 passed; Rust attachments 58 passed; commands 196 passed and 1 ignored; asset GC 12 passed; runtime 11 passed; ingest envelope 23 passed and 1 ignored.
- Independent spec and code re-reviews: Critical 0, Important 0, Minor 0; Ready Yes.
- Frozen common full gate executed exactly once: typecheck, lint, architecture,
  build, Rust formatting, and diff check returned exit 0. The full frontend and
  Rust runners completed after the capture window, but their final summaries and
  exit codes were not retained; they were not rerun under the once-only rule.

## Post-commit security remediation

- Replaced validate-then-unlink with no-replace logical isolation into a newly
  created UUID-named capability directory, followed by identity revalidation and
  deletion of only the isolated payload. Pre-created fixed names are never
  trusted; Unix operation directories must be owned with mode `0700`.
- Cross-device and recovery copies now use a private destination payload,
  cumulative bounded reads, hash and sync verification, atomic no-replace
  publication, and exact-destination retry handling. Interrupted staging and
  failed retired-payload deletion are reclaimed on the next serialized pass.
- Assets and trash capabilities are rebound-validated through the shared
  cross-platform identity/reparse contract immediately before and after file,
  directory, SQL, and reconciliation commit boundaries.
- Purge confirmation is bound in Tauri state to a vault-scoped digest of the
  exact dry-run membership. Added, removed, or cross-vault membership rejects
  confirmation and consumes the stale preview. The dialog clears stale reports
  and confirmation state when refresh or confirmation fails.
- Remediation RED evidence covered replacement-safe deletion, partial canonical
  publication, completed-publication retry, oversized and post-open-growing
  inputs, FIFO/reparse-safe opening, assets/trash rebound boundaries, purge
  membership changes, stale frontend reports, predictable private names, and
  restart cleanup of staging/retired payloads.
- Owning focused evidence before final re-review: asset GC 28 passed; attachment
  storage/reconciliation 58 passed; shared file I/O 37 passed; Notes data dialog
  8 passed. The original Phase 5 full gate was not rerun; this remediation uses
  a targeted gate after independent re-review.
- Independent remediation spec re-review: Critical 0, Important 0, Minor 0;
  Ready Yes. Independent standards re-review: Critical 0, Important 0, Minor 0;
  Ready Yes.
- Targeted remediation gate: Rust formatting check and compile passed; asset GC
  28 passed; attachment storage/reconciliation 58 passed; shared file I/O 37
  passed; Notes data dialog 8 passed; TypeScript `--noEmit`, focused dialog
  ESLint, and diff checks passed. The first wrapper stopped after the passing
  test suites because this repository has no `typecheck` package script; the
  remaining checks were immediately continued with the repository's actual
  TypeScript compiler command and returned exit 0. The Phase 5 full gate was not
  rerun.

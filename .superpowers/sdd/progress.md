# Notes File SSOT Sync Progress

- Plan: `docs/superpowers/plans/2026-07-21-notes-file-ssot-sync-implementation.md`
- Base: `2cd9809`
- Plan import: `d1a4d3d`
- Baseline frontend: 182 files passed, 1 skipped; 3,851 tests passed, 27 skipped.
- Baseline Rust: 723 passed, 3 ignored.
- Contract note: HLC `9-2-4` encoding is 17 characters including separators; the plan typo was corrected.
- Task 0: complete (`d1a4d3d..299fc12`); independent review PASS / APPROVED,
  Critical 0, Important 0. Rust 744 passed, 3 ignored. Known Minor: legacy-v1
  preflight snapshots use proportional temporary disk and fail closed.
- Pre-Phase-1 gate debt: complete (`88908cd`). Controller 1500/1500 and test-order
  observations 282/283; budgets unchanged. Full common gate green.
- Task 1: complete (`82359ef..bea078e`); independent review PASS / APPROVED,
  Critical 0, Important 0, Minor 0. Focused sync tests 60 passed; Rust 804 passed,
  3 ignored; Vitest 3,851 passed, 27 skipped; lint, typecheck, architecture,
  formatting, and diff checks green.
- Task 2: complete (`a841efa..619963b`); independent review PASS / APPROVED,
  Critical 0, Important 0, Minor 0. Merger tests 58 passed; focused sync tests
  118 passed; Rust 862 passed, 3 ignored; Vitest 3,851 passed, 27 skipped;
  lint, typecheck, architecture, formatting, and diff checks green.
- Task 3: complete (`f2412e9..2b98aa1`); independent review PASS / APPROVED,
  Critical 0, Important 0, Minor 0. Focused sync tests 161 passed; Rust 910
  passed, 3 ignored; Vitest 3,851 passed, 27 skipped; lint, typecheck,
  architecture, formatting, and diff checks green.
- Task 4: complete (`774c2e7..03d5371`); independent security/spec reviews
  PASS / APPROVED, Critical 0, Important 0, Minor 0. Frontend tests 3,860
  passed, 27 skipped; Rust 952 passed, 3 ignored; build, lint, typecheck,
  architecture (runtime 1489/1500), formatting, and diff checks green.
- Task 5: implementation frozen; independent spec/code reviews PASS / APPROVED,
  Critical 0, Important 0, Minor 0. Focused frontend 281 passed; Rust attachment
  58 passed, command 196 passed (1 ignored), asset GC 12 passed, runtime 11
  passed, and ingest envelope 23 passed (1 ignored). The common full gate ran
  exactly once: typecheck, lint, architecture, build, Rust formatting, and diff
  check returned exit 0. Full frontend/Rust runners completed after the capture
  window, but their final summaries and exit codes were not retained and were
  not rerun under the once-only rule.
- Task 5 post-commit security remediation: replacement-safe private isolation,
  staged atomic copy/recovery, cumulative 20 MiB read enforcement,
  transition-adjacent assets/trash rebinding checks, vault-scoped exact purge
  previews, and stale-dialog invalidation implemented with focused RED/GREEN
  coverage. Owning suites before final re-review: asset GC 28 passed, attachments 58
  passed, shared file I/O 37 passed, and Notes data dialog 8 passed. Independent
  spec and standards re-reviews both report Critical 0, Important 0, Minor 0,
  Ready Yes. Targeted remediation gate green: Rust format/check; asset GC 28,
  attachments 58, file I/O 37, dialog 8; TypeScript `--noEmit`; focused ESLint;
  diff check. The wrapper's nonexistent `typecheck` script was corrected to the
  actual compiler command for the remaining checks. The Phase 5 full gate was
  not rerun.
- Task 5 remediation review reopened after `3a5af85`: independent Sol reviews
  found unresolved held-identity retirement, purge preview identity/content,
  retirement recovery-state, reconciliation unlink, ingest publication/open,
  and vault-switch UI blockers. Prior remediation review/gate evidence is
  superseded for handoff; new focused evidence and 0/0/0 reviews are pending.
- Task 5 first reopened-remediation candidate: exact-held retirement, kind-bound
  positive recovery attestations, identity/content-bound purge confirmation,
  private attachment publication, shared bounded no-follow opens, exact
  reconciliation retirement, and vault-switch invalidation were submitted with
  pre-review focused suites of asset GC 33, attachments 61, file I/O 37, and
  Notes data dialog 9. A subsequent Sol review reopened seven blockers covering
  retirement evidence lifetime, published-copy revalidation, exact rollback and
  cleanup attestation, restore binding, Windows handle ownership, atomic
  operation attestation publication, and bounded purge evidence.
- Task 5 second reopened-remediation candidate was reviewed with Critical 3,
  Important 5, Minor 2, Ready No. Its pre-review owning suites were asset GC 40/40,
  attachment storage/reconciliation 63/63, shared file I/O 37/37, history 53/53,
  and Notes data dialog 9/9; Rust test compilation/check also passed. That
  evidence is superseded; current remediation review, the targeted final gate,
  and the commit remain pending.
- Task 5 third reopened-remediation candidate: transition-adjacent hash then
  pathname binding, last-copy destination evidence, identity-coupled private
  cleanup, explicit Windows handle closure, owned-file link-count checks,
  failed-attestation cleanup, malformed-attestation isolation, and exact
  rollback revalidation are implemented. The final rollback-rebind regression
  was observed RED before the additional rollback hardening and GREEN after it.
  Pre-review owning suites are asset GC 55/55, attachments 68/68, shared file
  I/O 37/37, history 53/53, and Notes data dialog 9/9; Rust test compilation/check
  passed. The following Sol review reported Critical 3, Important 6, Ready No;
  this evidence is superseded.
- Task 5 current reopened-remediation candidate: survivor and rollback evidence
  lifetime, private cleanup handle ownership, reconciliation rollback
  retention, transition-adjacent path/link rebinding, same-filesystem recovery,
  replacement-safe exact rollback, and atomic intent/completion are hardened.
  Direct recovery regressions are 10/10. Current owning suites are asset GC
  61/61, attachments 69/69, shared file I/O 37/37, history 53/53, and Notes data
  dialog 9/9; Rust test compilation/check passed. Independent Sol review, the
  targeted final gate, the fresh isolated-vault Tauri proof, and the commit
  remain pending.
- The preceding cleanup candidate is superseded. The active Task 5 candidate
  uses one logical-retirement authority: durable Intent, exact no-replace
  isolation, internally owned survivor validation, durable Complete, and exact
  held-handle truncate/sync. Runtime code performs no operation-entry or
  operation-directory pathname unlink; startup under the attachment lease uses
  consuming whole-directory removal only for positively attested completed
  app-local operations. Intent-only, malformed, and vault-adjacent tombstones
  are preserved under the documented cooperative-writer threat boundary.
  Direct logical-retirement/startup tests are 4/4; owning suites are asset GC
  71/71, attachments 70/70, shared file I/O 37/37, history 53/53, and Notes data
  dialog 9/9. The refreshed targeted gate passed Rust test compilation,
  TypeScript, focused ESLint, architecture, build, formatting, the task-local
  handoff-document guard, and diff checks. A separately attempted historical
  plan audit is not usable in this checkout because its frozen audited-head Git
  object `ec8a9ff3...` is absent locally and from the GitHub remote; its guard
  was not weakened. Fresh isolated `.app` proof passed: two UI imports produced
  two image nodes but one canonical asset; empty-trash released both references;
  purge dry-run and confirmation both reported one file / 2,181 bytes; and
  restart reclaimed the two completed app-local operation directories while
  preserving the two expected vault-adjacent zero-byte tombstones. Manual event
  ordering was not captured, while the focused regressions cover both first and
  duplicate ingest sequences. A subsequent frozen Sol review reported Critical
  3, Important 5, Minor 1, Ready No: post-hash in-place mutation and recovery
  content binding, stale cross-vault destructive confirmations, Windows exact
  cleanup/metadata/ownership, commit-bound canonical evidence, and retained
  private payloads required further work.
- Task 5 active final-review remediation: exact held-content verification now
  reaches publication, recovery, retirement, and SQLite commit boundaries;
  cross-platform link metadata is fallible; Windows fails closed where private
  ownership or exact capability deletion cannot be proved and retains only
  reclaimed zero-byte tombstones; attested staging/retirement payloads are
  zeroed through held handles on restart and Delete-all; rollback keeps recovery
  evidence across database replacement; and Vault changes invalidate every
  destructive confirmation. Focused GREEN evidence is asset GC 76/76,
  attachments 72/72, file I/O 38/38, commands 197 passed with 1 ignored, and
  Notes data dialog 11/11; TypeScript, focused ESLint, Rust formatting, and diff
  checks passed. The earlier isolated runtime flow remains useful pre-remediation
  evidence but must be refreshed for the current candidate. Independent
  re-review, targeted gate, final desktop proof, and commit remain pending.
- Task 5 first frozen re-review remained Ready No with Critical 2, Important 4,
  Minor 1: final post-move/rollback same-inode writes, recovery digest lifetime,
  interrupted `complete.tmp`, app-local trash in Delete-all, purge/delete async
  Vault binding, and Windows private ownership were still open. The active
  second remediation now revalidates after final binding, carries recovery
  digests through restore/retire, reclaims attested interrupted staging,
  includes app-local trash/private payloads in truthful Delete-all cleanup,
  binds purge and delete async state to the source Vault, and establishes an
  exact protected current-user Windows ACL/owner through held handles. Current
  focused evidence is asset GC 79/79, attachments 76/76, file I/O 38/38,
  commands 197 passed with 1 ignored, and dialog 16/16; frontend lint/typecheck,
  Rust formatting, and diff checks passed. A full Rust library run passed 1,057
  tests with two timing failures that both passed immediately in isolation.
  Native Windows target proof is deferred to Windows CI because this Mac lacks
  target libraries and cargo-xwin. Independent re-review, targeted gate, final
  desktop proof, and commit remain pending.
- Task 5 second frozen re-review reported Critical 2, Important 0, Minor 0,
  Ready No: a pre-snapshot quarantine fallback could promote raced replacement
  bytes, and exact rollback omitted its final post-hook rehash. The active final
  candidate captures the digest before movement, binds restoration to the held
  original, preserves exact bytes in private recovery without promoting a raced
  path, and uses the shared post-hook content/link/path verifier for rollback.
  Both regressions were RED then GREEN. Focused evidence is attachments 77/77,
  asset GC 80/80, file I/O 38/38, and commands 197 passed with 1 ignored;
  formatting and diff checks pass. A parallel FIFO timeout passed exactly and
  in the complete serial attachment suite. Final re-review, targeted gate,
  desktop proof, and commit remain pending.
- Task 5 final frozen Sol re-review: Critical 0, Important 0, Minor 0, Ready Yes.
  The held-original quarantine recovery, final rollback verifier, recovery
  digest lifetime, interrupted staging reclamation, app-local Delete-all,
  Vault-bound UI state, Windows handle ACL contract, and commit-bound canonical
  evidence were all reconfirmed. The refreshed targeted gate passed: file I/O
  38/38, asset GC 80/80, attachments 77/77, commands 197 with 1 ignored, dialog
  16/16, Rust check/format, TypeScript, focused ESLint, architecture, production
  build, and diff checks. The exact final candidate was then built and launched
  under bundle ID `com.doortts.yonalist.phase5final1784653133` with a unique
  WebKit profile, app-data root, Cargo target, and isolated Vault. It created and
  reopened the onboarding note only in that Vault; the unrelated development
  process remained alive and untouched. The earlier full isolated
  duplicate-import/purge/restart flow plus the refreshed focused suites cover
  the changed filesystem paths. Phase 5 is ready to commit; native Windows
  compile/runtime remains CI-owned.
- Task 6: in progress. At the user's request, the performance contract was
  recalibrated for a personal laptop: the blocking gate is 10k-node bootstrap
  under 15 seconds and 1k-node single-topic merge under 1 second. The original
  20k bootstrap and 100 ms merge targets remain non-blocking diagnostic
  measurements. The ten functional integration/failure scenarios remain
  unchanged.
- Task 6 functional RED/GREEN: added an isolated two-Vault integration module.
  The 90-day purge-evidence test was observed RED at the missing pruning API,
  then GREEN after deterministic HLC-derived pruning was added at startup and
  to the 60-second runtime maintenance tick. The strict-prefix truncation test
  was observed RED after a tail-truncated image atom remained quarantined, then
  GREEN after canonical bytes are reconstructed and atomically restored only
  when their hash exactly matches `exported_hash`; unrelated malformed bytes
  remain quarantined and untouched. The focused functional module is 11/11
  green and
  covers §12 rows 1–7 and 9; `successful_bounced_copy_merge_removes_only_the_copy`
  and `concurrent_two_device_cycle_parks_the_same_global_lowest_hlc_edge`
  remain the row 8 and 10 owners. Performance
  measurement is intentionally deferred to the separate Phase 6 benchmark.
- Task 6 performance gate: an ignored release-only end-to-end test now warms
  each path once, syncs fixture files before timing, and measures disk read,
  parse, SQLite application, and resulting export work. On this laptop, 10k
  bootstrap was 2.257s (15s gate PASS) and 1k single-topic merge was 518.865ms
  (1s gate PASS). Non-blocking diagnostics were 4.608s for 20k bootstrap and a
  miss for the original 100ms merge target. The first release compilation took
  2m18s and is excluded from those timings; the measured test body took 9.05s.
- Root review added a stale-read regression: if the sync pathname changes after
  startup captures truncated bytes, recovery leaves the newer bytes untouched
  and keeps quarantine active. The test was RED before a final bounded nofollow
  re-read and GREEN afterward.
- Root review also reproduced expired evidence being pruned at startup and then
  immediately re-imported from the already captured `trash.md`. External trash
  reconciliation now filters HLC-expired evidence at the same 90-day boundary,
  leaves its source hash unsynchronized, and schedules a canonical rewrite.
  The RED/GREEN startup regression also proves the delayed older trash node is
  allowed to revive.
- Task 6 final-review hardening: strict-prefix detection now runs before parsing,
  including a syntactically valid root-only truncation. Recovery holds and
  revalidates the exact file, moves it no-replace to a hidden non-Markdown
  preservation name, and publishes canonical bytes only to a vacant source
  path. A last-moment same-inode cloud write remains at the source and is never
  overwritten. The preservation file remains intentionally retained because a
  cooperative cloud writer may still hold its inode. Before isolation, the
  topic quarantine is durably cleared and a dirty recovery marker is committed;
  on success quarantine is re-established for one observable status edge and
  the watcher retry clears it. A process-stop injection after isolation proves
  restart recovery even when another healthy topic keeps the normal startup
  merge branch active. A runtime test proves the UI receives quarantine then
  recovery status. A competing pathname published after isolation is also
  preserved and re-quarantined. The refreshed sync owner gate is 296 passed,
  1 ignored;
  Rust check, formatting, and diff checks are green.
- Task 6 refreshed performance gate after final hardening: 10k bootstrap
  **2.268s** (<15s PASS), 1k single-topic merge **538.913ms** (<1s PASS).
  Non-blocking diagnostics were 20k bootstrap **4.672s** and a miss for the
  original 100ms merge target. Warmups were 503.645ms and 540.481ms; the
  measured release test body took 9.15s.
- Task 6 integration review strengthened rows 1, 5, and 6 from prepared-file
  transport into real local mutation paths: repository edit/delete/restore/
  empty-trash, dirty tracking, `flush_pending`, Markdown transfer, and remote
  merge are now exercised end to end. All three focused scenarios are GREEN.
  Row 3 additionally proves both conflict logs stay empty, and row 8 now checks
  the bounced-copy title in durable SQLite state after the copy is retired.
- Accepted residual recovery edge: if a cooperative cloud provider keeps the
  displaced inode open and writes after the final validation, those later bytes
  remain losslessly preserved in the hidden recovery file but are not
  automatically re-imported into the UI. This is outside the common temp+rename
  writer path; retaining the inode-backed file is the deliberate no-data-loss
  boundary for Phase 6.
- Task 6 isolated desktop proof: the exact production candidate launched as
  `Yonalist Phase6 Final` under the unique bundle ID
  `com.doortts.yonalist.phase6final1784656718`, with an isolated WebKit profile,
  Cargo target, and temporary Vault. It created the onboarding Markdown file,
  then a direct external title edit to that file was observed by the watcher and
  appeared as `Phase6 외부 동기화 확인` in both the note list and editor. The
  unrelated development app process remained alive and untouched.
- Task 6 frozen full gate: frontend lint and TypeScript passed; Vitest passed
  3,876 tests across 184 files with 27 tests intentionally skipped; the Notes
  architecture budget and production build passed. The serial Rust gate passed
  1,077 tests with zero failures and four intentionally ignored release/large
  allocation tests. Rust formatting and diff checks also passed.

# Task 4 Report — Phase 4 Watcher, Events, and Frontend Reload

## Status

COMPLETE after remediation of the security findings that reopened the first
Phase 4 commit. Focused and frozen full verification are green, and both final
independent reviews are Ready. Phase 4
turns external Markdown changes into reconciled SQLite state and tells the open
Notes workspace to reload through its existing coordinator. It does not add
Phase 5 asset ingest/GC, progress UI, or settings.

## Contract delivered

- A joined native watcher owns non-recursive `notify` subscriptions for direct
  vault-root Markdown files and the existing `.yonalist/notes-assets` directory.
  Relevant paths use a trailing 500 ms coalescer; a 60-second safety scan
  compares modification time and SHA-256 so missed or same-mtime changes recover.
- Every watcher batch reuses the cached Notes connection, isolates failures per
  target, retains unreadable/dataless paths for retry, skips exporter echoes by
  the recorded hash, and parses/merges changed Markdown through the canonical
  Phase 1/2/3 path. Event decisions use the exact bytes reconciled into SQLite.
- Successful bounced-copy reconciliation removes only the copy and only after
  the canonical assigned file has been established. Malformed copies remain for
  recovery, are quarantined, and cannot starve a healthy file in the same batch.
- `notes://sync-changed` emits the exact vault and sorted affected topic IDs only
  when SQLite state was applied; direct owned-asset arrival requests a reload
  without pretending Markdown was merged. `notes://sync-status` wraps current
  running, quarantine, last-export, and dirty-target state with its exact vault,
  including quarantine recovery and exporter-status transitions.
- The sync runtime owns exporter and watcher workers together. Start is
  same-vault idempotent, vault switching joins the old workers, stop joins the
  watcher before the final exporter flush, and no worker survives repeated
  start/stop cycles.
- The frontend listener filters events by active vault, performs one trailing
  500 ms reload, contains listener/reload rejection, and forwards status. Its
  asynchronous setup is cancellation-safe under React StrictMode and cleanup is
  idempotent. Reloads reuse the Notes workspace's synchronized coordinator path
  and current active scope rather than creating a competing load path.

## Files

- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`
- `src-tauri/src/file_io.rs`
- `src-tauri/src/notes/sync/bootstrap.rs`
- `src-tauri/src/notes/sync/merger.rs`
- `src-tauri/src/notes/sync/mod.rs`
- `src-tauri/src/notes/sync/runtime.rs`
- `src-tauri/src/notes/sync/watcher.rs`
- `docs/superpowers/plans/2026-07-21-notes-file-ssot-sync-implementation.md`
- `src/services/notesStore.ts`
- `src/services/notesStore.tauri.test.ts`
- `src/services/notesSyncContract.ts`
- `src/services/notesSyncListener.ts`
- `src/services/notesSyncListener.test.ts`
- `src/features/notes/notesWorkspaceRuntime.ts`
- `src/features/notes/useNotesWorkspace.test.tsx`
- `.superpowers/sdd/task-4-report.md`

## TDD evidence

The initial focused tests were observed RED against missing APIs or behavior,
then GREEN after the smallest corresponding implementation:

1. Direct topic changes initially lacked `process_watch_paths`; the callback now
   merges and reports the exact topic ID.
2. Topic/trash exporter bytes initially re-entered the merger; stored SHA-256
   hashes now suppress both echo forms.
3. Successful bounced copies initially remained, while failure handling was not
   isolated; success now removes only the copy and malformed copies remain
   quarantined while healthy siblings proceed.
4. Unreadable paths initially aborted a batch/scan; they now remain scheduled
   for retry without starving readable changes.
5. Quarantine recovery initially failed to emit the recovered status; exact
   before/after snapshots are now emitted.
6. Missing coalescer and scan types drove the exact 500 ms trailing and 60-second
   mtime-plus-hash tests, including a same-mtime content change.
7. Asset arrival initially had no reload signal; owned asset creation now emits
   a vault-scoped reload request without a Markdown topic ID.
8. Runtime event and lifecycle tests initially lacked a watcher/event adapter;
   they now prove exact changed/status payloads and joined exporter/watcher
   cleanup across start, stop, and vault switches.
9. A different byte representation with no applied semantic state initially
   emitted a false change; the signal now follows the merge report.
10. Frontend tests first failed on a missing listener, missing IPC helpers, and
    zero runtime listener registrations. They now prove exact commands, vault
    filtering, 500 ms coalescing, rejection containment, coordinator reload, and
    once-only early/final StrictMode cleanup.
11. Review-driven regressions were also observed RED before remediation for
    startup events, retry acknowledgement, durable bounced-copy cleanup,
    canonical-before-bounce ordering, vanished targets, cleanup transaction
    rollback, symlink/swap resistance, and active-vault status delivery.

## Focused verification

- `cargo test notes::sync --lib` — pass: **199 passed, 0 failed**.
- `cargo test file_io::tests --lib` — pass: **37 passed, 0 failed**.
- Focused frontend owning tests — pass: **234 passed, 0 failed** across
  `notesSyncListener.test.ts`, `notesStore.tauri.test.ts`, and
  `useNotesWorkspace.test.tsx`.
- `npm run lint` — pass.
- `npx tsc --noEmit` — pass.
- Architecture gate — pass; `notesWorkspaceRuntime.ts` is **1489/1500** lines.
- `cargo fmt --all` and `git diff --check` — pass.

## Independent review

The first frozen review reported standards Critical/Important/Minor **1/2/1**
and spec Critical/Important/Minor **0/4/0**, with four unique correctness gaps.
All were reopened with focused regressions:

- Startup reconciliation now records applied topic IDs and emits the exact
  changed payload. The frontend registers both listeners before entering a
  serialized native-start queue; generation guards suppress late old-vault
  listener/start resolution, while bootstrap reload remains event-driven.
- A persistent watcher processor separates the committed merge result from
  post-commit bounced-copy cleanup. It emits the applied topic, retains the
  consumed hash, quarantines/reports the cleanup error, and retries unlink only
  while bytes still match, preventing replay during the running session.
- Watcher startup creates and validates real `.yonalist` and `notes-assets`
  directories before non-recursive registration. An actual `notify` regression
  proves an asset written after absent-at-start setup reaches the handler.
- The 60-second scanner no longer advances a changed stamp before processing.
  Handler outcomes acknowledge successes; read, parse, database, and cleanup
  failures stay in the persistent retry set for the next scan.

The first refreshed review confirmed those four gaps closed, then found startup
and restart completeness issues. The second remediation wave now:

- persists consumed bounced-copy hashes as transient SQLite cleanup intents,
  seeds them into watcher startup, bypasses re-merge after restart, treats an
  already-absent copy as successful cleanup, and removes the intent only after
  safe unlink or confirmed absence;
- routes closed-app bounced copies through that cleanup path and rejects a
  bounced document before merge if its source filename belongs to another topic;
- emits the post-start status snapshot when bootstrap creates or clears
  quarantine state;
- rejects symlink/non-regular paths and enforces the canonical vault/asset
  parent before any parse or asset notification; and
- replaces the single global frontend generation with an active-connection
  registry, keeping concurrent same-vault sessions live while serializing
  old-vault/current-vault native starts and restoring the prior active vault.

The second refreshed review confirmed that wave closed, then exposed five final
edge cases. The third remediation wave now:

- reconciles canonical assigned filenames before lexical bounced copies on a
  fresh database, so a copy cannot claim the durable source identity;
- treats a watcher target that vanished before processing as a benign,
  acknowledged event and clears stale virtual quarantine instead of scheduling
  a permanent retry;
- inserts the consumed-hash cleanup intent inside the same SQLite transaction as
  the bounced-copy merge, with fault injection proving both state and marker
  roll back together;
- opens watched files relative to a verified parent descriptor with no-follow
  semantics, verifies parent/file identity and regular-file type, and rejects a
  symlink replacement made after earlier validation; and
- gates native status events on the active native vault while broadcasting the
  awaited start result to same-vault connections, preventing an old queued vault
  from delivering status into the newly active workspace.

The third refreshed review confirmed those fixes but exposed four deeper handoff
and durability races. The fourth remediation wave now:

- defers a bounced source from claiming ownership while a matching canonical
  filename candidate is unreadable or virtually quarantined; failed startup
  sources seed watcher retry, and a Unix permission-denial recovery regression
  proves the canonical file survives while only the bounce is retired;
- moves a cleanup target without replacement into deterministic private staging
  before verification, keeps the durable marker until completion, discovers a
  crash-left stage during startup, deletes only an expected staged hash, and
  restores changed bytes for normal merge (or retains them if the source path is
  occupied). If an expected stage and a newer source replacement coexist after
  a crash, startup consumes the stage first and then merges the replacement in
  the same retry;
- refreshes status after native activation and uses a raw-event sequence guard,
  so a transition that occurs between the backend start snapshot and promise
  resolution is neither dropped nor overwritten by an older returned snapshot;
  and
- commits topic quarantine/hash metadata, trash hash metadata, and bounced-copy
  intent in their corresponding merge transactions. Fault injection now proves
  a synchronized-hash failure rolls back the SQLite content change and cannot
  lose the only frontend invalidation.

The fourth standards rereview verified those fixes, then identified two final
ambiguities. The fifth remediation wave now:

- handles a crash-left marker for consumed A when staging contains valid B and
  the original path contains valid C: B is securely merged first while its
  marker hash is atomically replaced, its stage is retired, and C is then
  processed independently. A SQLite trigger audit proves the updates occur
  exactly once in `[B, C]` order with neither source overwritten; and
- retains the command response shape `SyncStatus` while changing only the event
  payload to exact `{ vaultPath, status }`. Rust emits the explicit wrapper and
  the frontend validates both wrapper and nested status shapes before filtering,
  so a delayed old-runtime callback cannot be attributed to the active vault.
  The Phase 4 contract table and acceptance text record this disambiguation.

The fifth standards rereview verified the main fixes, then exposed two
overlapping-listener/failure variants. The sixth remediation wave now:

- tracks status-event sequences per vault, so a still-live old-vault listener
  cannot suppress the active vault's authoritative refresh; the shared
  `SyncStatus` type and exact validator live in one contract module used by both
  command and event paths; and
- moves an unreconcilable staged B without replacement to a unique root-level
  recovery Markdown identity, records its quarantine/retry independently,
  clears the obsolete A cleanup marker, and continues with healthy occupied C.
  The regression proves C merges, B bytes remain intact and visible for retry,
  and neither the original path nor private stage is left blocked.

The sixth standards rereview verified those failure variants, then found one
allocator edge case and one contract-inventory omission. The seventh
remediation wave now:

- treats an occupied unreadable or non-regular recovery candidate as a name
  collision and continues through deterministic numeric suffixes without
  overwriting it. The regression preserves that candidate, writes staged B to
  `-1.md`, and still merges healthy original C; and
- lists the shared `notesSyncContract.ts` module in the SSOT TypeScript
  inventory so implementation and contract agree.

The final refreshed standards reviewer reported Critical/Important/Minor
**0/0/0**, Ready **Yes**. The final refreshed spec reviewer independently
reported Critical/Important/Minor **0/0/0**, no spec/scope findings, no scope
creep, and Ready **Yes**. Both verified the recovery-candidate suffix behavior,
shared status contract, per-vault sequencing, and SSOT inventory on the final
reviewed implementation.

A subsequent root security review reopened Task 4 with Critical/Important/Minor
**0/1/0**: startup enumerated a pathname and reopened it independently for
parseability, canonical ranking, and reconcile, while the watcher retained an
unsafe non-Unix `lstat` then `File::open` fallback. The held-file remediation:

- adds one shared bounded reader that opens a basename through a held parent
  capability, refuses final-component links, Windows reparse points, and
  non-regular targets, and verifies held/path identity before and after reading
  exactly once from the held handle;
- makes startup enumeration own each successful byte snapshot or isolated read
  error, then reuses those exact bytes for parseability, canonical/bounce rank,
  parse, merge, and hash without a pathname data reopen;
- routes watcher callbacks, safety scans, cleanup staging, and recovery
  deduplication through the same cross-platform reader while preserving Unix
  no-follow/nonblocking behavior; and
- keeps retry identity anchored to the held vault parent plus basename instead
  of canonicalizing a swapped link to its outside target.

RED regressions prove an enumeration-time regular-to-external-symlink swap and
a canonical/bounce pre-rank swap previously consumed outside bytes. They now
preserve the outside files, merge no outside node/hash, keep healthy siblings
progressing, and retain the existing watcher swap rejection. A static contract
also rules out the non-Unix fallback and verifies the Windows reparse predicate
is part of the shared reader.

The first post-security standards/spec rereview did not accept the diff; its
findings drove the next remediation wave below.

The first post-security rereview found Critical/Important/Minor **0/2/0** in
the shared parent acquisition and destructive staged cleanup, while the spec
review independently found **0/1/1** and the missing `file_io.rs` inventories.
The second security remediation wave now:

- inspects the requested parent itself without following its final component,
  rejects Windows reparse parents, requires the subsequently opened capability
  to have that exact identity, and compares held and current parent identities
  before and after the basename read. This permits stable OS path aliases such
  as macOS `/var` while a deterministic final-parent swap that previously
  returned outside bytes is rejected and both inside/outside files survive;
- carries the held file handle, parent, basename, identity, and exact bytes into
  cleanup instead of reducing the proof to `Vec<u8>`;
- atomically moves expected or duplicate stages without replacement into the
  held app-private `sync-cleanup/consumed` directory, verifies the moved entry
  against the held identity, and logically retires it without any subsequent
  pathname unlink. A mismatch is restored or preserved and remains retryable;
  and
- uses the same held no-replace move for source-to-stage, changed-stage restore,
  and stage-to-recovery publication, eliminating the non-Unix check-then-rename
  fallback as well as both stale-snapshot deletion sites.

Two cleanup regressions were observed RED: replacing an expected stage after
its snapshot was deleted and reported consumed, and replacing a duplicate stage
after equal-candidate comparison was deleted before success. Both now retain
the expected and replacement bytes and return retry rather than clearing the
durable marker. Logical retirement owns only entries moved from the deterministic
cleanup stage by a matching held identity; the private consumed namespace is
excluded from root watcher/startup enumeration. Physical reclamation of these
retired safety copies is intentionally outside Phase 4.

The second post-security spec rereview reported Critical/Important/Minor
**0/0/0**, Ready **Yes**. The standards/security rereview reported **0/2/0**,
Ready **No**: the held `consumed` directory was not tied back to its current
basename after opening, and Windows fallback metadata without volume/file-index
fields could panic during identity extraction. The third security remediation:

- reopens `consumed` without following it and compares its identity under the
  held cleanup parent immediately before and after the logical move. A
  deterministic rename-and-replacement injection was observed RED when the old
  code returned a false consumed path; it now restores the moved stage with a
  no-replace move and keeps cleanup retryable; and
- routes every ambient and capability metadata identity through a fallible
  extractor. Windows reads optional volume-serial/file-index fields and returns
  a retryable error when either is unavailable instead of calling the panicking
  `dev`/`ino` compatibility methods. The missing-field regression was observed
  RED before the helper existed and now covers all incomplete field shapes.

The directory rename/replacement injection is Unix-only because Windows held
directory handles deny delete/rename sharing. A platform-scoping contract was
observed RED before the Unix gate; it now also requires a Windows-only runtime
assertion that rename is denied while `consumed` is held and succeeds after the
handle closes.

The final refreshed standards/security reviewer reported
Critical/Important/Minor **0/0/0**, Ready **Yes**. The final refreshed spec
reviewer independently reported **0/0/0**, Ready **Yes**, confirmed the SSOT
and modified-file inventories, and found no Phase 5 scope. Neither reviewer
edited the diff or ran the frozen full common gate.

## Final verification (frozen diff)

- `npm test` — pass: **183 test files passed, 1 skipped; 3860 tests passed,
  27 skipped**.
- `npm run lint` — pass.
- `npx tsc --noEmit` — pass.
- `npm run build` — pass.
- `npm run test:architecture` — pass;
  `notesWorkspaceRuntime.ts` is **1489/1500** lines.
- `cargo test --manifest-path src-tauri/Cargo.toml` — pass: **952 passed,
  0 failed, 3 ignored**.
- `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check` — pass.
- `git diff --check` — pass.

## Phase boundaries and residual risk

- Phase 4 observes asset-byte arrival only. Content-addressed asset ingest,
  deduplication, reference-aware GC, progress reporting, and settings remain
  Phase 5.
- The frontend does not start a speculative extra reload when native sync starts;
  external-change events are the reload trigger, preventing queue races and
  duplicate initial loads.
- The safety scan is the recovery path for platform watcher loss or dataless
  delivery. Per-target quarantine and retry preserve unrelated progress.

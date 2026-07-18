# Standalone Sync Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the standalone Git-backed synchronization core so accepted state is causally authorized, atomically installed, resource-bounded, revocation-minimal, and exposed only through the intended `Replica` and `PeerEndpoint` boundaries.

**Architecture:** Keep the existing bare SHA-256 Git repository and immutable atom model, but put every Git subprocess behind one bounded, version-probed executor and every repository mutation behind one writer lock. Validate incoming history in quarantine against exact project, ref-owner, frontier, and policy snapshots; install an accepted-only pack; and deliver a removed client one signed notice outside the Git history protocol. Preserve the synchronous transport abstraction and deterministic test lab while narrowing production exports.

**Tech Stack:** Rust 1.97.0, Git 2.49 or newer, bare SHA-256 Git plumbing, canonical CBOR, Ed25519, `fs4` advisory file locking, `tempfile`, Vitest/npm repository commands, GitHub Actions.

## Global Constraints

- Revocation is cooperative application security, not DRM: an already-authorized or modified client may retain previously copied bytes.
- The Yonalist app is the only supported writer. Production code never executes a shell, never reads user/system Git configuration, never executes hooks, and never reads or invokes remotes; all Git operations use fixed argv plumbing commands and an explicit bare repository.
- The authoritative sync state remains file-backed bare SHA-256 Git plus a private local lock record; SQLite is not introduced.
- There is no membership epoch or project-key rotation.
- This plan does not implement real sockets, peer discovery, UI, issue projection, attachment transfer, read-only web, or source-code synchronization.
- Every task is TDD: observe a focused RED, add the smallest complete implementation, run focused and full regressions, then commit.
- Use `apply_patch` for all source and documentation edits. Formatting commands may make mechanical formatting changes only.
- Preserve the dirty Notes files in the main worktree. Work only in `/Users/cpm4/repos/yonalist/.worktrees/standalone-sync-core` on `codex/standalone-sync-core`.
- Do not stage or edit `src/features/notes/notesHistory.test.ts`, `src/features/notes/notesHistory.ts`, `src/features/notes/notesWorkspaceCoordinator.test.ts`, `src/features/notes/notesWorkspaceCoordinator.ts`, `src/features/notes/useNotesWorkspace.test.tsx`, or `src/features/notes/useNotesWorkspace.ts`.
- Use a fresh `gpt-5.6-sol` implementer for each task and a different fresh `gpt-5.6-sol` reviewer after its commit. A reviewer must check the whole task-base-to-HEAD diff; Critical and Important findings return to a fresh Sol fixer and then a fresh re-review.
- Do not run the 100-peer/500-event scenario during Tasks 1–4 or Task 5 implementation. Run it once at the final verification gate after all focused and ordinary suites pass.
- Git pack input is capped before execution. `index-pack` runs only inside a disposable quarantine repository; its stdout, stderr, wall time, object metadata, object count, and expanded bytes are capped. Accepted objects reach the trusted object database only through a revalidated accepted-only pack artifact copied from quarantine.
- The crate-level containment above is sufficient for this cooperative peer model and for preventing rejected state from becoming trusted. It is not a hard hostile-code sandbox: strict CPU and RSS enforcement for Git remains a packaging/runtime responsibility using an OS job object, sandbox profile, cgroup, or equivalent around the shipped app process.

---

## File Structure and Final Ownership

| File | Responsibility after this plan |
| --- | --- |
| `src-tauri/crates/yonalist-sync/Cargo.toml` | Independent dependencies, Rust floor, test-support feature, and binary declarations. |
| `src-tauri/crates/yonalist-sync/src/git_command.rs` | Git 2.49 runtime probe; sanitized argv-only process execution; typed exit results; bounded concurrent stdin/stdout/stderr; timeout termination. |
| `src-tauri/crates/yonalist-sync/src/git_store.rs` | Repository open/create, writer-lock transaction, deterministic local commits, trusted ref snapshots, exact frontier helpers, and private test-only reads. |
| `src-tauri/crates/yonalist-sync/src/pack.rs` | Missing-object pack creation, quarantine import, resource accounting, causal validation, accepted-only pack construction, and atomic ref promotion under the writer lock. |
| `src-tauri/crates/yonalist-sync/src/access_lock.rs` | Canonical, atomically replaced, non-shareable local revocation record outside Git refs and objects. |
| `src-tauri/crates/yonalist-sync/src/policy.rs` | Payload-policy contract and allowed/removal-only/denied decisions. |
| `src-tauri/crates/yonalist-sync/src/protocol.rs` | Stable public immutable files, refs, local commit result, sync report support, and opaque session token. |
| `src-tauri/crates/yonalist-sync/src/transport.rs` | Session-bound `PeerEndpoint`; `HelloAck` carries either an allowed session or one exact signed removal atom. |
| `src-tauri/crates/yonalist-sync/src/replica.rs` | Final production facade: create/open, append, control-first pull, stored atom reads, trusted refs, and access state. |
| `src-tauri/crates/yonalist-sync/src/lib.rs` | Narrow production exports and feature-gated raw test support only. |
| `src-tauri/crates/yonalist-sync/src/test_support/peer.rs` | Fixture signer/event cursor wrapper, session-aware in-process endpoint, call counters, and faults. |
| `src-tauri/crates/yonalist-sync/src/test_support/policy.rs` | Signed fixture grant/revoke policy and exact removal notice selection. |
| `src-tauri/crates/yonalist-sync/src/test_support/scenario.rs` | Deterministic mesh, corrupt-pack, and strengthened revocation oracles. |
| `src-tauri/crates/yonalist-sync/tests/git_runtime.rs` | Version probe, deterministic commit, exit-status, and bounded-process integration regressions. |
| `src-tauri/crates/yonalist-sync/tests/git_store.rs` | Local commit, writer serialization, and deterministic repository behavior. |
| `src-tauri/crates/yonalist-sync/tests/pack_quarantine.rs` | Project/ref/frontier/policy validation, atomic race, rejected suffix, and resource-budget regressions. |
| `src-tauri/crates/yonalist-sync/tests/revocation.rs` | Exact removal notice, zero history serving, durable lock, and session invalidation. |
| `src-tauri/crates/yonalist-sync/tests/two_peer_sync.rs` | Public `Replica` convergence and same-device recovery behavior. |
| `src-tauri/crates/yonalist-sync/tests/public_contract.rs` | Compile-visible production surface and behavior contract. |
| `src-tauri/crates/yonalist-sync/tests/repository_contract.rs` | README, npm, CI, Rust, Git, and final slow-gate contract. |
| `src-tauri/crates/yonalist-sync/tests/mesh_convergence.rs` | Ordinary deterministic mesh tests and the single ignored scale gate. |
| `README.md` | Exact Rust/Git requirements, cooperative boundary, commands, and stable lab output. |
| `.github/workflows/ci.yml` | Rust 1.97.0, Git >=2.49 probe, ordinary core tests, and explicit scale job. |
| `package.json` | Stable ordinary, lab, and explicit scale commands. |

## Final Interfaces and Invariants

The final production facade is:

```rust
pub struct Replica<P: ProjectPolicy>;

impl<P: ProjectPolicy> Replica<P> {
    pub fn create(config: ReplicaConfig, policy: P) -> Result<Self, SyncError>;
    pub fn open(config: ReplicaConfig, policy: P) -> Result<Self, SyncError>;
    pub fn append_local(&mut self, batch: LocalBatch) -> Result<LocalCommit, SyncError>;
    pub fn pull_from<E: PeerEndpoint>(&mut self, peer: &mut E) -> Result<SyncReport, SyncError>;
    pub fn trusted_refs(&self, plane: Plane) -> Result<RefAdvertisement, SyncError>;
    pub fn stored_atoms(&self, plane: Plane) -> Result<Vec<StoredAtom>, SyncError>;
    pub fn access_state(&self) -> &AccessState;
}
```

The final transport boundary is:

```rust
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionToken([u8; 32]);

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HelloAck {
    Allowed { session: SessionToken },
    RemovalOnly { notice: SignedAtom },
    Denied,
}

pub trait PeerEndpoint {
    fn hello(&mut self, hello: &Hello) -> Result<HelloAck, SyncError>;
    fn advertise(
        &mut self,
        session: &SessionToken,
        project: ProjectId,
        plane: Plane,
    ) -> Result<RefAdvertisement, SyncError>;
    fn create_pack(
        &mut self,
        session: &SessionToken,
        project: ProjectId,
        request: &PackRequest,
        limits: &PackLimits,
    ) -> Result<PackBytes, SyncError>;
}
```

`RemovalOnly` is terminal for that pull. The receiver verifies and persists the exact signed atom, then returns without calling `advertise` or `create_pack`. `Allowed` operations carry the issued token, and the serving adapter revalidates the token's exact project/member/device/grant binding and current membership before every response.

The final default pack budget is deliberately large enough for the scale fixture while remaining finite:

```rust
impl Default for PackLimits {
    fn default() -> Self {
        Self {
            max_pack_bytes: 16 * 1024 * 1024,
            max_advertised_refs: 128,
            max_commits: 1024,
            max_objects: 8192,
            max_tree_entries_per_commit: 1024,
            max_atoms_per_head: 1024,
            max_single_blob_bytes: 4 * 1024 * 1024,
            max_expanded_bytes: 64 * 1024 * 1024,
            max_metadata_bytes: 4 * 1024 * 1024,
        }
    }
}
```

All arithmetic uses `checked_add`; overflow is `SyncErrorCode::LimitExceeded`. The 16 MiB compressed and 64 MiB expanded caps are non-negotiable defaults. Callers may lower limits. Raising them is an explicit deployment decision and must not bypass executor output/time caps.

---

### Task 1: Harden the Git execution substrate and align runtime requirements

**Files:**
- Modify: `src-tauri/crates/yonalist-sync/src/git_command.rs`
- Modify: `src-tauri/crates/yonalist-sync/src/git_store.rs`
- Modify: `src-tauri/crates/yonalist-sync/src/error.rs`
- Modify: `src-tauri/crates/yonalist-sync/Cargo.toml`
- Create: `src-tauri/crates/yonalist-sync/tests/git_runtime.rs`
- Modify: `src-tauri/crates/yonalist-sync/tests/git_store.rs`
- Modify: `src-tauri/crates/yonalist-sync/tests/repository_contract.rs`
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`

**Interfaces:**
- Consumes: existing `GitStore::{init,open,append_local,is_ancestor}`, `SyncError`, and injected `git_executable: PathBuf`.
- Produces: `GitRuntime::probe(&Path) -> Result<GitRuntime, SyncError>`, `GitVersion { major: u32, minor: u32, patch: u32 }`, `GitExecLimits`, `GitExit`, status-aware `GitCommand::run_status`, checked `GitCommand::run`, multi-environment `GitCommand::run_with_envs`, and deterministic protocol commits.

The exact executor signatures are:

```rust
impl GitVersion {
    pub(crate) const fn new(major: u32, minor: u32, patch: u32) -> Self;
}

impl GitRuntime {
    pub(crate) fn probe(executable: &Path) -> Result<Self, SyncError>;
}

impl GitCommand {
    pub(crate) fn run_status(
        &self,
        args: &[OsString],
        stdin: Option<&[u8]>,
        limits: &GitExecLimits,
    ) -> Result<GitExit, SyncError>;
    pub(crate) fn run(&self, args: &[OsString], stdin: Option<&[u8]>) -> Result<Vec<u8>, SyncError>;
    pub(crate) fn run_with_envs(
        &self,
        args: &[OsString],
        stdin: Option<&[u8]>,
        envs: &[(&OsStr, &OsStr)],
    ) -> Result<Vec<u8>, SyncError>;
}
```

- [ ] **Step 1: Add RED tests for version parsing, injected probing, and exit semantics**

Add unit tests in `git_command.rs` for these exact cases:

```rust
assert_eq!(parse_git_version(b"git version 2.49.0\n").unwrap(), GitVersion::new(2, 49, 0));
assert_eq!(parse_git_version(b"git version 2.49.0.windows.1\n").unwrap(), GitVersion::new(2, 49, 0));
assert_eq!(parse_git_version(b"git version 2.48.9\n").unwrap_err().code, SyncErrorCode::GitUnavailable);
assert_eq!(parse_git_version(b"not git\n").unwrap_err().code, SyncErrorCode::GitUnavailable);
```

In `tests/git_runtime.rs`, create a disposable executable on Unix that prints `git version 2.48.9`, pass that exact path to `GitRuntime::probe`, and assert `GitUnavailable`. Add a real-repository test where `merge-base --is-ancestor` exit 1 returns `Ok(false)` but a missing object exit 128 returns `GitCommandFailed`, not `Ok(false)`.

- [ ] **Step 2: Run the runtime tests and capture RED**

Run:

```bash
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --test git_runtime -- --nocapture
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml git_command::tests -- --nocapture
```

Expected: compilation fails because `GitRuntime`, `GitVersion`, and status-aware results do not exist; after only test scaffolding compiles, the ancestry test fails because all nonzero Git exits are collapsed into `GitCommandFailed`.

- [ ] **Step 3: Implement a typed runtime probe and exact exit handling**

Add these internal types:

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub(crate) struct GitVersion { major: u32, minor: u32, patch: u32 }

pub(crate) struct GitRuntime { executable: PathBuf, version: GitVersion }

pub(crate) enum GitExit {
    Success(Vec<u8>),
    Code { code: i32, stdout: Vec<u8>, stderr: Vec<u8> },
}

pub(crate) struct GitExecLimits {
    pub max_stdout_bytes: usize,
    pub max_stderr_bytes: usize,
    pub timeout: Duration,
}
```

`GitRuntime::probe` executes only `<injected-path> --version`, parses the first three numeric components, and rejects anything below 2.49.0. `GitStore::init` and `GitStore::open` probe before any repository command and keep the probed executable. `run_status` returns exit 0 or an exact numeric nonzero status. `run` converts every nonzero status to `GitCommandFailed`. `is_ancestor` alone interprets exit 1 as false and propagates every other status.

- [ ] **Step 4: Add RED tests for concurrent bounded pipes and termination**

In the Unix section of `tests/git_runtime.rs`, create one executable fixture that writes 256 KiB to stdout and 256 KiB to stderr before reading 256 KiB of stdin; assert the command completes without deadlock with 512 KiB caps. Create a second fixture that writes forever; configure 32 KiB stdout/stderr and a 250 ms timeout; assert `LimitExceeded` or `GitCommandFailed`, elapsed time below 3 seconds, and no live child remains. Test stderr truncation by asserting the error message is at most the configured stderr cap plus the fixed context prefix.

- [ ] **Step 5: Run bounded-process tests and capture RED**

Run:

```bash
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --test git_runtime bounded -- --nocapture --test-threads=1
```

Expected: the old write-stdin-then-wait implementation deadlocks or exceeds the test timeout, and it has no output-limit error path.

- [ ] **Step 6: Implement concurrent drain, cap signaling, and child termination**

Spawn three scoped workers: one writes and closes stdin, one drains stdout, and one drains stderr. Each drain retains at most its configured byte cap, continues draining until the coordinator kills the child, and signals overflow through a channel. The coordinator polls `try_wait` at 10 ms intervals, calls `kill` and `wait` on timeout or overflow, joins all workers, and returns a bounded error. Never hold one pipe unread while writing another. Keep these fixed defaults for non-pack commands: 8 MiB stdout, 256 KiB stderr, 30 seconds. Pack code in Task 3 supplies stricter command-specific caps.

The sanitized base command must continue to remove every inherited `GIT_*` variable, set `GIT_CONFIG_NOSYSTEM=1`, point `GIT_CONFIG_GLOBAL` to the null device, disable prompts and optional locks, force `LC_ALL=C`, and use argv without a shell. Pass repository paths through `OsString`; do not stringify them.

- [ ] **Step 7: Add RED deterministic-commit and documentation contract tests**

In `tests/git_store.rs`, initialize two repositories, append byte-identical `StoreBatch` values with the same parents, and assert equal commit OIDs. In `repository_contract.rs`, assert `rust-toolchain.toml`, both Cargo manifests, CI, and README all state 1.97/1.97.0 consistently; assert README says Git 2.49 or newer; assert CI runs `git version` and the standalone runtime probe before tests.

- [ ] **Step 8: Make protocol commit metadata deterministic and align CI/docs**

Change the environment API to accept `&[(&OsStr, &OsStr)]`. Every `commit-tree` call sets both `GIT_AUTHOR_DATE` and `GIT_COMMITTER_DATE` to the fixed Git internal date `0 +0000`; author/committer names and emails remain fixed. Commit content, tree, ordered reduced parents, and message are therefore the only OID inputs.

Keep `rust-toolchain.toml`, `src-tauri/Cargo.toml`, the standalone manifest, and CI at Rust 1.97.0. Change README's stale 1.88 claim to 1.97. In CI, install a Git >=2.49 source (the `git-core/ppa` package on Ubuntu), print `git --version`, and run the runtime-focused test before the ordinary core suite.

- [ ] **Step 9: Run focused and full GREEN verification**

Run:

```bash
cargo fmt --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml -- --check
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --test git_runtime -- --nocapture --test-threads=1
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --test git_store
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --test repository_contract
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --all-features
git diff --check
```

Expected: every command exits 0; the ordinary suite still leaves the scale test ignored.

- [ ] **Step 10: Commit and pass the fresh reviewer gate**

```bash
git add README.md .github/workflows/ci.yml src-tauri/crates/yonalist-sync/Cargo.toml src-tauri/crates/yonalist-sync/src/error.rs src-tauri/crates/yonalist-sync/src/git_command.rs src-tauri/crates/yonalist-sync/src/git_store.rs src-tauri/crates/yonalist-sync/tests/git_runtime.rs src-tauri/crates/yonalist-sync/tests/git_store.rs src-tauri/crates/yonalist-sync/tests/repository_contract.rs
git commit -m "fix(sync): harden Git process execution"
```

Reviewer checkpoint: verify exit 1 is special only for ancestry; every pipe is drained concurrently and bounded; child termination is awaited; the injected path is the path probed and later executed; deterministic dates cover every protocol `commit-tree`; no shell/config/hook/remote escape was added; Rust and Git claims agree.

---

### Task 2: Make causal validation authoritative and repository writes atomic

**Files:**
- Modify: `src-tauri/crates/yonalist-sync/Cargo.toml`
- Modify: `src-tauri/crates/yonalist-sync/src/git_store.rs`
- Modify: `src-tauri/crates/yonalist-sync/src/pack.rs`
- Modify: `src-tauri/crates/yonalist-sync/src/replica.rs`
- Modify: `src-tauri/crates/yonalist-sync/src/policy.rs`
- Modify: `src-tauri/crates/yonalist-sync/tests/git_store.rs`
- Modify: `src-tauri/crates/yonalist-sync/tests/pack_quarantine.rs`
- Modify: `src-tauri/crates/yonalist-sync/tests/two_peer_sync.rs`
- Modify: `src-tauri/crates/yonalist-sync/tests/revocation.rs`

**Interfaces:**
- Consumes: Task 1's bounded `GitCommand`, `ReplicaConfig.project_id`, `ProjectPolicy`, `StoredAtom`, signed atom frontiers, and plane/device refs.
- Produces: `GitStore::with_writer`, `RepositoryWriter`, `TrustedSnapshot`, exact `stored_atoms_at_heads`, `reduced_frontier`, and one lock-held `import_pack` operation. The caller no longer supplies a freely cloned current control state to pack validation.

- [ ] **Step 1: Add RED validation-authority regressions**

In `pack_quarantine.rs`, add five named tests:

1. `foreign_project_atom_never_advances_a_ref` signs a structurally valid atom for project `[99; 16]`, imports it into a `[1; 16]` replica, expects `InvalidAtom`, and compares both trusted ref maps before/after.
2. Replace `existing_object_under_another_device_ref_still_promotes_alias_once` with `advertised_device_must_own_first_parent_commits`; advertise Alice's head under device `[77; 16]`, expect rejection for that candidate, and assert no alias ref exists.
3. `control_atom_frontier_must_equal_reduced_commit_parents` creates a control commit whose atom omits one concurrent parent and expects rejection.
4. `forged_frontier_is_rejected_without_ref_movement` and `data_atom_frontiers_must_be_reachable_and_reduced` try a random control OID, an ancestor-plus-descendant control set, and a data frontier different from the reduced Git parents; each candidate is rejected without ref movement.
5. `data_policy_uses_the_declared_control_frontier` creates data authorized at an older active control cut, later imports a revoke, then imports the causally older data. Assert policy validation receives the older cut's state, while data declaring the revoked cut is rejected.

The raw commit helper must make parent lists and atom frontiers explicit; it must not repair the candidate under test.

- [ ] **Step 2: Run authority tests and capture RED**

Run:

```bash
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --all-features --test pack_quarantine foreign_project_atom_never_advances_a_ref -- --nocapture
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --all-features --test pack_quarantine advertised_device_must_own_first_parent_commits -- --nocapture
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --all-features --test pack_quarantine frontier -- --nocapture
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --all-features --test pack_quarantine data_policy_uses_the_declared_control_frontier -- --nocapture
```

Expected: at least the foreign-project and alias tests wrongly advance refs; frontier tests fail because validation checks format/length but not exact causal cuts; policy observes the caller's latest cloned state.

- [ ] **Step 3: Add the repository writer transaction**

Add `fs4 = "1.1.0"`. Store the lock at `<bare-repo>/yonalist-private/writer.lock`; create the private directory during repository creation/open. Use one exclusive advisory lock for the complete mutation and release it through RAII.

```rust
pub(crate) struct RepositoryWriter<'a> { store: &'a GitStore, lock_file: File }

impl GitStore {
    pub(crate) fn with_writer<T>(
        &self,
        operation: impl FnOnce(&RepositoryWriter<'_>) -> Result<T, SyncError>,
    ) -> Result<T, SyncError>;
}

pub(crate) struct TrustedSnapshot {
    pub control: RefAdvertisement,
    pub data: RefAdvertisement,
}
```

`Replica::append_local` acquires the writer before rebuilding policy, checking access/frontiers, writing objects, and compare-and-swapping the local ref. Pack import acquires the same writer before its first trusted-state read and holds it through validation, object installation, and the ref transaction. No nested lock acquisition is allowed; `RepositoryWriter` calls private `append_locked` and `import_locked` methods.

- [ ] **Step 4: Implement exact causal helpers**

Add these internal operations, all scoped to the snapshot or quarantine repository passed to them:

```rust
fn stored_atoms_at_heads(
    &self,
    plane: Plane,
    heads: &[GitOid],
    limits: &AtomLimits,
) -> Result<Vec<StoredAtom>, SyncError>;

fn reduced_frontier(
    git: &GitCommand,
    repo: &Path,
    heads: impl IntoIterator<Item = GitOid>,
) -> Result<Vec<GitOid>, SyncError>;
```

For a control commit, every atom's `control_frontier` must exactly equal the sorted reduced set of that commit's parents and `data_frontier` must be empty. For a data commit, every atom's `data_frontier` must exactly equal the sorted reduced set of its parents. Every declared control OID must exist and be reachable from a trusted control snapshot head; the declared set must already be reduced. Rebuild policy from `stored_atoms_at_heads(Control, declared_control_frontier)` and validate that data atom against that exact state.

For each candidate device ref, walk the new first-parent segment from its previous accepted head. Every commit authored on that segment may introduce atoms only when `atom.actor_device_id == candidate.device_id`. Merge parents may contribute already-existing atoms from other devices; those are not newly authored by the candidate. A head aliased under another device therefore fails even when its objects already exist locally.

Every decoded atom in either plane must have `atom.unsigned.project_id == expected_project_id`. Add `expected_project_id: ProjectId` to the internal import request; source it only from `ReplicaConfig.project_id`.

- [ ] **Step 5: Replace validation-token promotion with one combined operation**

Use this internal boundary:

```rust
pub(crate) struct ImportOutcome {
    pub accepted: usize,
    pub rejected: Vec<(DeviceId, SyncErrorCode)>,
    pub pack_bytes: usize,
}

impl RepositoryWriter<'_> {
    pub(crate) fn import_pack<P: ProjectPolicy>(
        &self,
        expected_project_id: ProjectId,
        plane: Plane,
        advertised: &RefAdvertisement,
        pack: PackBytes,
        atom_limits: &AtomLimits,
        pack_limits: &PackLimits,
        policy: &P,
    ) -> Result<ImportOutcome, SyncError>;
}
```

At operation start, read both control and data ref maps into `TrustedSnapshot`. All ancestry boundaries, declared control states, previous candidate heads, and update-ref expected values come from that snapshot. Immediately before promotion, compare the current full control and data ref maps with the snapshot; a mismatch is `RefRewind` and installs no ref. The final `update-ref --stdin` transaction includes `verify` lines for every unchanged snapshot ref and compare-and-swap `update` lines for accepted refs. Under the app-only writer lock, this full comparison plus the ref transaction protects unrelated refs as well as candidate refs and makes the linearization point explicit.

- [ ] **Step 6: Add RED serialization and race regressions**

In `git_store.rs` unit tests, hold `with_writer` in thread A with a barrier, start append through a separately opened `GitStore` in thread B, and assert B cannot reach its mutation callback until A releases. In `pack_quarantine.rs`, add `revocation_race_serializes_validation_and_append`: use a blocking `ProjectPolicy` to pause a data import after snapshot construction, start a revocation append through a second `Replica`, release validation, and assert the two operations serialize: either data linearizes before revocation or the changed full snapshot rejects it; no stale-state promotion occurs. Add `unrelated_ref_change_aborts_full_snapshot_promotion` and assert all candidate refs remain unchanged.

- [ ] **Step 7: Run race tests and capture RED, then GREEN**

Run before implementation completion and observe a failing assertion or wrong ref movement, then rerun after the lock/snapshot code:

```bash
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --all-features writer_lock -- --nocapture --test-threads=1
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --all-features --test pack_quarantine revocation_race_serializes_validation_and_append -- --nocapture --test-threads=1
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --all-features --test pack_quarantine unrelated_ref_change_aborts_full_snapshot_promotion -- --nocapture --test-threads=1
```

Expected GREEN: no test hangs; mutations have one observable order; rejected imports leave both ref maps byte-for-byte unchanged.

- [ ] **Step 8: Run focused and full GREEN verification**

```bash
cargo fmt --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml -- --check
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --all-features --test pack_quarantine
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --all-features --test git_store
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --all-features --test two_peer_sync
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --all-features --test revocation
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --all-features
git diff --check
```

Expected: all pass; the scale test remains ignored.

- [ ] **Step 9: Commit and pass the fresh reviewer gate**

```bash
git add src-tauri/crates/yonalist-sync/Cargo.toml src-tauri/crates/yonalist-sync/src/git_store.rs src-tauri/crates/yonalist-sync/src/pack.rs src-tauri/crates/yonalist-sync/src/policy.rs src-tauri/crates/yonalist-sync/src/replica.rs src-tauri/crates/yonalist-sync/tests/git_store.rs src-tauri/crates/yonalist-sync/tests/pack_quarantine.rs src-tauri/crates/yonalist-sync/tests/revocation.rs src-tauri/crates/yonalist-sync/tests/two_peer_sync.rs
git commit -m "fix(sync): validate and install repository state atomically"
```

Reviewer checkpoint: trace one incoming control atom and one incoming data atom from advertised device to ref update; confirm exact project/ref owner/frontiers/policy cut; confirm a single writer lock covers trusted reads through ref update for append and import; confirm the snapshot includes unrelated control and data refs; confirm no caller-forgeable validation token remains.

---

### Task 3: Promote only sanitized accepted objects and enforce full resource budgets

**Files:**
- Modify: `src-tauri/crates/yonalist-sync/src/git_command.rs`
- Modify: `src-tauri/crates/yonalist-sync/src/git_store.rs`
- Modify: `src-tauri/crates/yonalist-sync/src/pack.rs`
- Modify: `src-tauri/crates/yonalist-sync/src/replica.rs`
- Modify: `src-tauri/crates/yonalist-sync/src/test_support/peer.rs`
- Modify: `src-tauri/crates/yonalist-sync/src/test_support/scenario.rs`
- Modify: `src-tauri/crates/yonalist-sync/tests/pack_quarantine.rs`
- Modify: `src-tauri/crates/yonalist-sync/tests/two_peer_sync.rs`
- Modify: `src-tauri/crates/yonalist-sync/tests/mesh_convergence.rs`
- Modify: `src-tauri/crates/yonalist-sync/tests/repository_contract.rs`
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 2's lock-held `RepositoryWriter::import_pack`, trusted snapshot, quarantine validation, and Task 1 executor limits.
- Produces: expanded `PackLimits`, `PackBudget`, `QuarantineSession`, `SanitizedPack`, accepted-only object installation, bounded `index-pack` metadata, and a zero-trusted-write path for zero accepted candidates.

The pack pipeline remains internal and uses these signatures:

```rust
struct ImportRequest<'a, P: ProjectPolicy> {
    expected_project_id: ProjectId,
    plane: Plane,
    advertised: &'a RefAdvertisement,
    pack: PackBytes,
    atom_limits: &'a AtomLimits,
    pack_limits: &'a PackLimits,
    policy: &'a P,
}

struct AcceptedRef {
    device_id: DeviceId,
    previous: Option<GitOid>,
    accepted_head: GitOid,
    advertised_head: GitOid,
}

struct ValidationResult {
    accepted: Vec<AcceptedRef>,
    rejected: Vec<(DeviceId, SyncErrorCode)>,
    budget: PackBudget,
}

fn audit_pack<P: ProjectPolicy>(
    session: &QuarantineSession,
    request: &ImportRequest<'_, P>,
    snapshot: &TrustedSnapshot,
) -> Result<ValidationResult, SyncError>;

fn build_sanitized_pack(
    session: &QuarantineSession,
    accepted: &[AcceptedRef],
    snapshot: &TrustedSnapshot,
    limits: &PackLimits,
) -> Result<SanitizedPack, SyncError>;

fn install_sanitized_pack_and_refs(
    writer: &RepositoryWriter<'_>,
    sanitized: SanitizedPack,
    accepted: &[AcceptedRef],
    snapshot: &TrustedSnapshot,
) -> Result<(), SyncError>;
```

- [ ] **Step 1: Add RED tests proving rejected bytes currently enter trusted objects**

In `pack_quarantine.rs`, add `rejected_suffix_objects_never_enter_trusted_odb`. Its source history has a valid first commit with payload `accepted`, followed by a policy-rejected commit with payload `rejected-unique`; record both commit OIDs and the rejected blob OID. Add `zero_accepted_candidates_write_no_trusted_objects`, whose advertised first commit has a foreign project ID so no candidate prefix can be accepted.

For both tests, record the sorted output of `count-objects -v` and the sorted filenames under `objects/pack`; verify `cat-file -e <oid>^{commit}` or `cat-file -e <oid>^{blob}` fails before import. After import, assert the accepted prefix is readable, the bad suffix and its unique blob are not readable, and a zero-accepted import leaves trusted object counts and pack directory entries identical. Assert quarantine session directories are removed after success and failure.

- [ ] **Step 2: Run sanitized-promotion tests and capture RED**

```bash
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --all-features --test pack_quarantine rejected_suffix_objects_never_enter_trusted_odb -- --nocapture
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --all-features --test pack_quarantine zero_accepted_candidates_write_no_trusted_objects -- --nocapture
```

Expected: both fail because the original full pack is replayed through `index-pack` into the trusted object database even when no ref accepts its suffix.

- [ ] **Step 3: Expand limits and add RED budget matrices**

Replace the three-field `PackLimits` with the exact default shown in “Final Interfaces and Invariants.” Add table-driven tests that independently exceed: commits, total objects, entries in one commit tree, atoms reachable from one head, one blob's uncompressed bytes, total expanded bytes, and metadata bytes. Add exact-boundary cases that pass. Use small test limits so fixtures remain fast. Every exceeded budget returns `LimitExceeded`, moves no ref, copies no object pack to trusted storage, and cleans quarantine.

Add one ordinary test using `PackLimits::default()` with 100 advertised device IDs and 500 small atoms distributed across commits; it checks construction/validation limits only and does not run the 100-repository mesh.

Run the budget matrix before implementation:

```bash
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --all-features --test pack_quarantine resource_budget -- --nocapture
```

Expected RED: new `PackLimits` fields do not compile; after the fields alone are added, over-commit, over-object, over-tree, over-blob, over-expanded-byte, and over-metadata fixtures are accepted or fail only after unbounded Git output.

- [ ] **Step 4: Implement quarantine import and bounded metadata accounting**

Introduce:

```rust
struct PackBudget {
    commits: usize,
    objects: usize,
    expanded_bytes: u64,
    metadata_bytes: usize,
}

struct QuarantineSession { root: PathBuf, incoming: PathBuf, sanitized: PathBuf }
struct SanitizedPack { pack_path: PathBuf, idx_path: PathBuf, pack_hash: String }
```

Write the received bytes to a capped file inside `incoming.git`; invoke `index-pack --stdin --fix-thin --fsck-objects --max-input-size=<max_pack_bytes>` only with `--git-dir=<incoming.git>`. Cap stdout at 4 KiB, stderr at 256 KiB, and time at 60 seconds. Use bounded `verify-pack -v`, `rev-list --objects`, `cat-file --batch-check`, `ls-tree`, and `cat-file blob` calls to count unique objects and uncompressed sizes with checked arithmetic. Stop as soon as any limit is exceeded. `max_metadata_bytes` caps retained and parsed metadata across these commands, not only one output.

Count each unique reachable commit once, each unique object once, every file entry in each validated commit tree toward `max_tree_entries_per_commit`, each atom path toward `max_atoms_per_head`, every blob's uncompressed size toward `max_single_blob_bytes`, and every unique object's uncompressed size toward `max_expanded_bytes`.

- [ ] **Step 5: Build and revalidate an accepted-only pack**

If `accepted` is empty, return the rejection report immediately without writing the trusted object directory. Otherwise, in `incoming.git`, run bounded `pack-objects --stdout --revs` with only accepted heads as positive tips and every trusted snapshot head as a negative tip. Cap the resulting sanitized pack at 16 MiB.

Import that pack with `index-pack` into a second `sanitized.git` quarantine whose only alternate is the trusted object directory. Re-run Git integrity, object budgets, atom validation, exact frontiers, device ownership, project identity, and policy validation against exactly the accepted candidate refs. This second pass must produce the same accepted heads and no rejected candidate; any difference rejects the whole operation.

Keep both quarantine repositories alive through promotion. Copy the sanitized `.pack` and `.idx` files to unique temporary names under trusted `objects/pack`, `fsync` each, atomically rename to `pack-<hash>.pack` and `pack-<hash>.idx`, then run the full snapshot comparison and `update-ref --stdin` transaction. An update-ref race may leave an unreachable accepted-only pack, which is safe and later maintenance may collect. Never invoke `index-pack` with the trusted repository as its object destination.

- [ ] **Step 6: Add executor-location and cleanup assertions**

Instrument test support with a command audit sink enabled only under `test-support`. Assert every `index-pack` Git directory is under `<repo>/incoming/<session>/`, never the trusted repo; assert received and sanitized pack byte counts stay under `max_pack_bytes`; assert all session directories disappear after success, corrupt input, budget rejection, second-pass mismatch, and update-ref race.

- [ ] **Step 7: Update all fixture limits to concrete defaults**

Use `PackLimits::default()` in `FixturePair` and mesh configuration. Tests that need smaller bounds clone and override explicit fields. The defaults must remain: 16 MiB compressed, 128 refs, 1024 commits, 8192 objects, 1024 entries per commit, 1024 atoms per head, 4 MiB per blob, 64 MiB expanded, 4 MiB metadata. Align `ScenarioConfig` with the promised scale by accepting `1..=100` peers and `0..=500` events; change the invalid-boundary regression to reject 501 events, and add a one-peer 500-event fast boundary test. Do not increase limits only to make a failing fixture pass; reduce fixture batch shape if it violates the stated product scale.

- [ ] **Step 8: Run focused and ordinary GREEN verification**

```bash
cargo fmt --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml -- --check
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --all-features --test pack_quarantine -- --nocapture
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --all-features --test two_peer_sync
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --all-features --test mesh_convergence -- --skip one_hundred_partitioned_peers_eventually_converge
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --all-features
git diff --check
```

Expected: all ordinary tests pass; the scale test is still ignored and has not been explicitly run.

- [ ] **Step 9: Document and test the containment boundary**

Add crate-level comments beside `QuarantineSession` and README text stating: input/output/metadata/time are bounded in the crate, trusted objects are accepted-only, and hard Git CPU/RSS isolation is supplied by the packaged app's OS sandbox. `repository_contract.rs` must assert these statements and the 16 MiB/64 MiB defaults. Do not claim that byte/time limits alone defeat every decompression or algorithmic denial of service.

- [ ] **Step 10: Commit and pass the fresh reviewer gate**

```bash
git add README.md src-tauri/crates/yonalist-sync/src/git_command.rs src-tauri/crates/yonalist-sync/src/git_store.rs src-tauri/crates/yonalist-sync/src/pack.rs src-tauri/crates/yonalist-sync/src/replica.rs src-tauri/crates/yonalist-sync/src/test_support/peer.rs src-tauri/crates/yonalist-sync/src/test_support/scenario.rs src-tauri/crates/yonalist-sync/tests/mesh_convergence.rs src-tauri/crates/yonalist-sync/tests/pack_quarantine.rs src-tauri/crates/yonalist-sync/tests/repository_contract.rs src-tauri/crates/yonalist-sync/tests/two_peer_sync.rs
git commit -m "fix(sync): promote accepted packs under resource budgets"
```

Reviewer checkpoint: prove with object IDs that rejected and zero-accepted objects never reach trusted storage; find every `index-pack` call and confirm quarantine-only Git directories; verify second-pass equivalence; verify every budget and checked sum; confirm quarantine lifetime reaches ref promotion; confirm CPU/RSS claims are honest and deferred to packaging rather than silently asserted.

---

### Task 4: Replace control-history sharing with one durable removal notice

**Files:**
- Create: `src-tauri/crates/yonalist-sync/src/access_lock.rs`
- Modify: `src-tauri/crates/yonalist-sync/src/lib.rs`
- Modify: `src-tauri/crates/yonalist-sync/src/policy.rs`
- Modify: `src-tauri/crates/yonalist-sync/src/protocol.rs`
- Modify: `src-tauri/crates/yonalist-sync/src/transport.rs`
- Modify: `src-tauri/crates/yonalist-sync/src/replica.rs`
- Modify: `src-tauri/crates/yonalist-sync/src/test_support/peer.rs`
- Modify: `src-tauri/crates/yonalist-sync/src/test_support/policy.rs`
- Modify: `src-tauri/crates/yonalist-sync/src/test_support/scenario.rs`
- Modify: `src-tauri/crates/yonalist-sync/tests/revocation.rs`
- Modify: `src-tauri/crates/yonalist-sync/tests/lab_scenarios.rs`
- Modify: `src-tauri/crates/yonalist-sync/tests/sync_lab_cli.rs`

**Interfaces:**
- Consumes: Task 2's writer lock and exact control frontier/state helpers, Task 3's ordinary allowed pack flow, existing fixture revoke atom, and local identity tuple.
- Produces: final `SessionToken`, final `HelloAck`, session-bearing `PeerEndpoint`, `AccessLockStore`, `AccessLockRecord`, exact-notice validation/persistence, and a revocation scenario whose success requires zero Git history service.

The private lock API is:

```rust
pub(crate) struct AccessLockStore { path: PathBuf }

impl AccessLockStore {
    pub(crate) fn for_repository(repository: &Path) -> Self;
    pub(crate) fn load(
        &self,
        expected: &Hello,
        limits: &AtomLimits,
    ) -> Result<Option<SignedAtom>, SyncError>;
    pub(crate) fn persist(
        &self,
        expected: &Hello,
        notice: &SignedAtom,
        limits: &AtomLimits,
    ) -> Result<(), SyncError>;
}
```

- [ ] **Step 1: Add RED tests for a true removal-only handshake**

Rewrite the control-only tests in `revocation.rs` around the final interface. After Bob is revoked, call `bob.pull_from(alice_endpoint)` and assert:

```rust
assert_eq!(endpoint.control_advertise_calls, 0);
assert_eq!(endpoint.data_advertise_calls, 0);
assert_eq!(endpoint.control_pack_calls, 0);
assert_eq!(endpoint.data_pack_calls, 0);
assert_eq!(report.control_refs_advanced, 0);
assert_eq!(report.data_refs_advanced, 0);
assert_eq!(bob.trusted_refs(Plane::Control).unwrap(), before_control);
assert_eq!(bob.trusted_refs(Plane::Data).unwrap(), before_data);
assert!(matches!(bob.access_state(), AccessState::Revoked { grant_id } if *grant_id == bob_grant));
```

Also assert `hello` returns exactly `HelloAck::RemovalOnly { notice }`, the notice is the original signed revoke atom byte-for-byte, and invoking `advertise`/`create_pack` without an allowed session returns `AccessRevoked`.

- [ ] **Step 2: Run removal tests and capture RED**

```bash
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --all-features --test revocation removed_client_receives_exact_notice_without_history -- --nocapture
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --all-features --test revocation removal_only_never_advertises_or_packs -- --nocapture
```

Expected: old code advertises a control ref and creates a control pack, advances Bob's control ref, and has no exact-notice handshake variant.

- [ ] **Step 3: Implement the final session/removal transport types**

Change policy and transport to the final types declared earlier:

```rust
pub enum AccessDecision {
    Allowed,
    RemovalOnly { notice: SignedAtom },
    Denied,
}

pub enum HelloAck {
    Allowed { session: SessionToken },
    RemovalOnly { notice: SignedAtom },
    Denied,
}
```

`FixturePolicy::peer_access` selects exactly one canonical revoke atom for the requested grant: the causally valid notice with the lowest event ID if duplicate valid notices exist. `InProcessPeer::hello` creates a fresh 32-byte token from a test-only deterministic counter/hash for an allowed tuple and retains the exact tuple/token. For removal-only or denied decisions it retains no serving session. `advertise` and `create_pack` require the token and re-evaluate current membership for the retained tuple before every call; a changed project, token, tuple, grant state, or policy-rebuild failure clears the session and returns `AccessRevoked`.

- [ ] **Step 4: Add RED notice-authenticity and causal-state tests**

Add tests for: wrong project; wrong target grant; wrong signer; data-plane atom; noncanonical bytes; notice whose control frontier is random, redundant, stale, or ahead of the receiver; notice valid against the receiver's exact prior reduced control frontier; repeated delivery of the same notice. Every invalid case leaves refs, private lock path, and in-memory access unchanged. The valid case locks exactly once; identical replay is idempotent.

Run:

```bash
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --all-features --test revocation notice_ -- --nocapture
```

Expected RED: the old handshake has no standalone notice-validation path or private record, and malformed/causally invalid notices cannot be distinguished from filtered control-pack behavior.

- [ ] **Step 5: Implement canonical private access-lock persistence**

Create `<bare-repo>/yonalist-private/access-lock.cbor`, never under `objects` or `refs`. Use a canonical record:

```rust
struct AccessLockRecord {
    schema: u16,
    project_id: ProjectId,
    member_id: MemberId,
    device_id: DeviceId,
    grant_id: GrantId,
    notice: Vec<u8>,
}
```

`notice` is `SignedAtom::encode(atom_limits)` without transformation. Write to a newly created sibling temporary file, `sync_all` the file, atomically rename over the record, then `sync_all` the private directory where supported. On Unix create the file with mode `0o600`. Serialize persistence with Task 2's repository writer lock. On open, decode canonically, require exact project/member/device/grant, decode the signed atom, and force `AccessState::Revoked` before exposing the replica. A malformed or mismatched existing lock makes `Replica::open` fail closed with `InvalidAtom`; it is never ignored.

- [ ] **Step 6: Verify a notice against prior local causal state before persistence**

On `HelloAck::RemovalOnly`, do not call either history method. Under the writer lock:

1. read the exact local reduced control frontier and require it equals `notice.unsigned.control_frontier`;
2. require expected project, control plane, empty data frontier, and expected target grant in the decoded revoke payload through the injected policy;
3. rebuild the prior policy state only from that frontier;
4. run `validate_control` and `advance_control` with the notice;
5. require `local_access` on the advanced state is `Revoked { local_grant_id }`;
6. persist the exact notice record atomically;
7. update memory state and return a zero-byte, zero-ref `SyncReport`.

The Git refs and objects remain untouched. If the receiver lacks the exact prior frontier, fail without importing intervening history; the UI integration can direct the user to an administrator in a later plan.

- [ ] **Step 7: Add crash/reopen and non-sharing RED/GREEN tests**

After valid notice receipt, reopen the same repository through `Replica::open`, assert revoked access and local append rejection, and assert pre-revocation files remain on disk. Verify the private record path is absent from `for-each-ref`, every advertised tree, every created pack, and the source's object listing. Inject a failure before rename and assert the prior valid record remains intact; inject a failure after rename and assert reopen remains revoked.

- [ ] **Step 8: Strengthen the revocation lab oracle**

`run_revocation` sets `converged` only when all of these are true: exact notice accepted, receiver reopened revoked, source and receiver control/data refs unchanged during the removal pull, all four advertise/pack counters are zero, post-revocation source payload absent on receiver, and receiver append rejected. Keep the stable JSON fields unchanged. Update `lab_scenarios.rs` and `sync_lab_cli.rs` to assert this stronger success meaning.

- [ ] **Step 9: Run focused and full GREEN verification**

```bash
cargo fmt --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml -- --check
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --all-features --test revocation -- --nocapture
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --all-features --test lab_scenarios
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --all-features --test sync_lab_cli
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --all-features --test two_peer_sync
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --all-features
npm run sync:lab -- revocation --seed 42
git diff --check
```

Expected: all commands exit 0; the final JSON line has `"converged":true` and `"revoked_peers":1`; no control or data pack is served to the removed client.

- [ ] **Step 10: Commit and pass the fresh reviewer gate**

```bash
git add src-tauri/crates/yonalist-sync/src/access_lock.rs src-tauri/crates/yonalist-sync/src/lib.rs src-tauri/crates/yonalist-sync/src/policy.rs src-tauri/crates/yonalist-sync/src/protocol.rs src-tauri/crates/yonalist-sync/src/replica.rs src-tauri/crates/yonalist-sync/src/test_support/peer.rs src-tauri/crates/yonalist-sync/src/test_support/policy.rs src-tauri/crates/yonalist-sync/src/test_support/scenario.rs src-tauri/crates/yonalist-sync/src/transport.rs src-tauri/crates/yonalist-sync/tests/lab_scenarios.rs src-tauri/crates/yonalist-sync/tests/revocation.rs src-tauri/crates/yonalist-sync/tests/sync_lab_cli.rs
git commit -m "fix(sync): deliver revocation as a signed removal notice"
```

Reviewer checkpoint: place breakpoints/counters at both history-serving trait methods and prove removal never reaches them; compare notice bytes with the source atom; trace prior-frontier policy validation; inspect atomic file replacement and fail-closed reopen; verify the lock is outside shareable Git state; verify allowed sessions are tuple/token-bound and reauthorized per operation.

---

### Task 5: Enforce the public boundary, optimize fixture recovery, and publish the final contract

**Files:**
- Modify: `src-tauri/crates/yonalist-sync/src/lib.rs`
- Modify: `src-tauri/crates/yonalist-sync/src/git_store.rs`
- Modify: `src-tauri/crates/yonalist-sync/src/pack.rs`
- Modify: `src-tauri/crates/yonalist-sync/src/replica.rs`
- Modify: `src-tauri/crates/yonalist-sync/src/test_support/mod.rs`
- Modify: `src-tauri/crates/yonalist-sync/src/test_support/peer.rs`
- Modify: `src-tauri/crates/yonalist-sync/src/test_support/scenario.rs`
- Modify: `src-tauri/crates/yonalist-sync/tests/public_contract.rs`
- Modify: `src-tauri/crates/yonalist-sync/tests/git_store.rs`
- Modify: `src-tauri/crates/yonalist-sync/tests/pack_quarantine.rs`
- Modify: `src-tauri/crates/yonalist-sync/tests/two_peer_sync.rs`
- Modify: `src-tauri/crates/yonalist-sync/tests/revocation.rs`
- Modify: `src-tauri/crates/yonalist-sync/tests/mesh_convergence.rs`
- Modify: `src-tauri/crates/yonalist-sync/tests/repository_contract.rs`
- Modify: `src-tauri/crates/yonalist-sync/Cargo.toml`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`

**Interfaces:**
- Consumes: Tasks 1–4 hardened internals and final session transport.
- Produces: the final `Replica` surface exactly as declared, feature-gated `raw_test_support`, `FixtureReplica` owning its signer/cursor, local first-parent fixture recovery, and exact ordinary/scale CI and documentation commands.

- [ ] **Step 1: Add RED production-surface tests**

Update `public_contract.rs` to construct a replica with:

```rust
let mut replica = Replica::create(config, policy)?;
let reopened = Replica::open(config, policy)?;
let _ = reopened.trusted_refs(Plane::Control)?;
let _ = reopened.stored_atoms(Plane::Data)?;
let _: &AccessState = reopened.access_state();
```

No signer argument is permitted. Add rustdoc `compile_fail` examples on the crate root showing that default-feature consumers cannot import `GitStore`, `StoreBatch`, `CandidateRef`, or `ValidatedPack`. Add a positive example importing `Replica`, `ReplicaConfig`, `ProjectPolicy`, `StoredAtom`, `PeerEndpoint`, `PackRequest`, `PackBytes`, `PackLimits`, `RefAdvertisement`, `SessionToken`, `Hello`, and `HelloAck`.

- [ ] **Step 2: Run public-contract tests and capture RED**

```bash
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --test public_contract -- --nocapture
cargo test --doc --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --no-default-features
```

Expected: `Replica::create`, `stored_atoms`, and `access_state` are missing; init/open still require `DeviceSigner`; raw storage and promotion types remain root exports.

- [ ] **Step 3: Implement the exact production facade**

Rename `Replica::init` to `Replica::create`; remove `DeviceSigner` from `Replica` fields and from create/open signatures. The production caller continues to supply already-signed `SignedAtom` values in `LocalBatch`. Add direct read-only methods:

```rust
pub fn trusted_refs(&self, plane: Plane) -> Result<RefAdvertisement, SyncError> {
    self.store.advertise(plane)
}

pub fn stored_atoms(&self, plane: Plane) -> Result<Vec<StoredAtom>, SyncError> {
    self.store.stored_atoms(plane, &self.config.atom_limits)
}

pub fn access_state(&self) -> &AccessState { &self.access_state }
```

Do not expose a mutable store handle or a way to install a caller-constructed validated value.

- [ ] **Step 4: Hide raw storage and promotion types**

Remove root production re-exports for `GitStore`, `StoreBatch`, `CandidateRef`, and `ValidatedPack`. Make validation/promotion structs private to `pack.rs`. Under `#[cfg(feature = "test-support")]`, expose only the minimum low-level fixture adapter in `test_support::raw_test_support`; update quarantine/store integration tests to import through that explicit namespace and gate them with `#![cfg(feature = "test-support")]`. Keep `PeerEndpoint` protocol types public: `Hello`, `HelloAck`, `SessionToken`, `RefAdvertisement`, `PackRequest`, `PackBytes`, and `PackLimits`. Keep `StoredAtom` public because `ProjectPolicy` method signatures require it.

- [ ] **Step 5: Move fixture signing and counters out of `Replica`**

Add:

```rust
pub struct FixtureReplica {
    replica: Replica<FixturePolicy>,
    signer: DeviceSigner,
    next_event: u128,
    local_control_head: Option<GitOid>,
    local_data_head: Option<GitOid>,
    event_refreshes: usize,
}
```

Implement `Deref<Target = Replica<FixturePolicy>>` only for read methods; fixture append methods remain on `FixtureReplica` so signing cannot leak back into production `Replica`. `FixturePair::{alice,bob}` become `FixtureReplica`. Update scenario and endpoint call sites without restoring production raw access.

- [ ] **Step 6: Add RED first-parent recovery telemetry tests**

Extend the existing same-device tests to create a repository with many remote-device branches and 200 remote events, then import one same-device event. Assert recovery inspects only the changed local device's first-parent segment and decodes exactly one new atom. On reopen, assert it walks only the two local device refs, not global stored atoms. Keep the distinct-device, idempotent, corrupt-pack, removal-only, and rejected-import assertions at zero recovery scans.

Expose test-only counters `local_commits_walked` and `local_atoms_decoded`; do not time the test.

Run before implementing the segment reader:

```bash
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --all-features --test two_peer_sync same_device -- --nocapture
```

Expected RED: the production `Replica` still owns fixture counters/signer and recovery calls global `stored_atoms` over both planes, so the exact local-segment telemetry assertions cannot pass.

- [ ] **Step 7: Implement local first-parent fixture recovery**

Add an internal read helper available only to test support:

```rust
fn local_first_parent_atoms(
    &self,
    plane: Plane,
    device: DeviceId,
    after: Option<&GitOid>,
    head: &GitOid,
    limits: &AtomLimits,
) -> Result<Vec<StoredAtom>, SyncError>;
```

Run `rev-list --first-parent --reverse <after>..<head>` (or the full local first-parent chain on open), inspect only atoms newly introduced by each commit relative to its first parent, and require their `actor_device_id` equals the requested device. `FixtureReplica` caches both local plane heads. After an advancing pull, it queries only those two heads; it scans the segment only when a cached local head changed. Set `next_event` to one greater than the maximum local event ID found. This optimization is fixture-only and does not alter production validation.

- [ ] **Step 8: Make session-bound serving part of the public contract**

Add tests that an allowed token cannot be reused after a second hello, with a different endpoint, project, device/grant tuple, or after revocation. Assert `advertise` and `create_pack` both reauthorize. Ensure README says `PeerEndpoint` is a synchronous adapter boundary and real authenticated/encrypted transport is still outside scope; a token is an in-session capability, not transport authentication by itself.

Run before completing the serving changes:

```bash
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --all-features --test revocation session_ -- --nocapture
```

Expected RED: any method that lacks the issued token parameter compiles against the old stateful endpoint and allows at least one cross-session reuse assertion to fail.

- [ ] **Step 9: Publish exact commands and CI gates**

Keep:

```json
"test:sync": "cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --all-features",
"sync:lab": "cargo run --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --features test-support --bin sync-lab --"
```

Add:

```json
"test:sync:scale": "cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --features test-support --test mesh_convergence one_hundred_partitioned_peers_eventually_converge -- --ignored --exact --nocapture"
```

CI's ordinary standalone job runs `npm run test:sync`. A separate `sync-scale` job, after Git >=2.49 and Rust 1.97.0 setup, runs only `npm run test:sync:scale` with a 30-minute job timeout. README distinguishes ordinary tests from the explicit slow gate and states the concrete pack defaults, removal-only behavior, accepted-only quarantine promotion, cooperative security, and OS CPU/RSS containment responsibility.

- [ ] **Step 10: Run Task 5 focused and ordinary GREEN verification**

Do not run the scale command in this step.

```bash
cargo fmt --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml -- --check
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --test public_contract
cargo test --doc --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --no-default-features
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --all-features --test two_peer_sync
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --all-features --test revocation
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --all-features --test repository_contract
npm run test:sync
npm run sync:lab -- mesh --peers 20 --events 200 --seed 42
npm run sync:lab -- revocation --seed 42
npm run sync:lab -- corrupt-pack --seed 42
git diff --check
```

Expected: every command exits 0; ordinary tests report the scale test ignored; each lab command's final stdout line parses as JSON with `"converged":true`.

- [ ] **Step 11: Commit and pass the fresh reviewer gate**

```bash
git add README.md package.json .github/workflows/ci.yml src-tauri/crates/yonalist-sync/Cargo.toml src-tauri/crates/yonalist-sync/src/git_store.rs src-tauri/crates/yonalist-sync/src/lib.rs src-tauri/crates/yonalist-sync/src/pack.rs src-tauri/crates/yonalist-sync/src/replica.rs src-tauri/crates/yonalist-sync/src/test_support/mod.rs src-tauri/crates/yonalist-sync/src/test_support/peer.rs src-tauri/crates/yonalist-sync/src/test_support/scenario.rs src-tauri/crates/yonalist-sync/tests/git_store.rs src-tauri/crates/yonalist-sync/tests/mesh_convergence.rs src-tauri/crates/yonalist-sync/tests/pack_quarantine.rs src-tauri/crates/yonalist-sync/tests/public_contract.rs src-tauri/crates/yonalist-sync/tests/repository_contract.rs src-tauri/crates/yonalist-sync/tests/revocation.rs src-tauri/crates/yonalist-sync/tests/two_peer_sync.rs
git commit -m "refactor(sync): enforce the standalone public boundary"
```

Reviewer checkpoint: compile the crate with default features and enumerate root exports; ensure production `Replica` stores no signer; ensure test raw access is feature-gated; verify every serving call requires and revalidates a session; confirm recovery scans only local first-parent segments; confirm ordinary CI never accidentally runs the slow test and the explicit scale job runs exactly it.

---

## Plan Amendment: Broad Review Findings A–J

This document amends and hardens `docs/superpowers/plans/2026-07-18-standalone-distributed-sync-core.md`. Where the two plans conflict, this plan governs the hardening implementation.

| Finding | Correction | Task |
| --- | --- | --- |
| A | Preserve exact Git exit status so ancestry exit 1 is false while fatal exits propagate. | 1 |
| B | Concurrently drain bounded pipes, terminate timed-out/overflowing Git, probe the injected Git >=2.49 binary, make commit dates deterministic, and align Rust/Git docs and CI. | 1 |
| C | Validate expected project ID, device-ref ownership, exact reduced reachable frontiers, and policy state rebuilt at each declared control cut. | 2 |
| D | Serialize append and import with one repository writer lock and one full control/data snapshot through atomic ref movement. | 2 |
| E | Never replay an original rejected pack into trusted storage; build, second-pass validate, and install an accepted-only pack. | 3 |
| F | Bound compressed bytes, commits, objects, tree entries, atoms, individual blobs, total expansion, metadata, process output, and time; leave hard CPU/RSS enforcement to the packaged runtime. | 3 |
| G | Replace control-history access for removed members with one exact signed removal atom and zero advertise/pack calls. | 4 |
| H | Verify the removal atom against the prior local causal state and atomically persist a private, non-shareable, fail-closed access lock outside Git refs. | 4 |
| I | Match the approved `Replica` API, remove the unused production signer, hide raw store/promotion types, bind serving to sessions, and make fixture recovery local-first-parent only. | 5 |
| J | Publish exact commands, concrete scale-safe defaults, honest security limits, and a dedicated final 100/500 CI gate. | 5 |

The old plan's lines 662–665 are explicitly superseded: promotion must not replay the already-validated original pack through `index-pack` in the trusted repository. Task 3 instead creates an accepted-only pack, runs `index-pack` only in quarantine, revalidates that exact pack, and copies only its verified pack/index artifacts before the ref transaction.

The old plan's lines 919–920 are explicitly superseded: a removed requester does not receive filtered control refs or any control pack. Task 4 sends one exact `SignedAtom` revocation notice in `HelloAck::RemovalOnly`, then closes serving capability; both `advertise` and `create_pack` remain unavailable.

---

## Final Verification Gate

Run from `/Users/cpm4/repos/yonalist/.worktrees/standalone-sync-core` after all five task reviewers report no Critical or Important findings. This is the first and only execution of the 100-peer/500-event test during the hardening plan.

```bash
git status --short
git diff --check 345ea62..HEAD
git --version
rustc --version
cargo fmt --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --all-features --all-targets -- -D warnings
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --no-default-features
npm run test:sync
npm run sync:lab -- mesh --peers 20 --events 200 --seed 42
npm run sync:lab -- revocation --seed 42
npm run sync:lab -- corrupt-pack --seed 42
npm run test:sync:scale
cargo test --manifest-path src-tauri/Cargo.toml
npm test
npm run build
git status --short
```

Expected evidence:

- Git prints 2.49.0 or newer and Rust prints 1.97.0.
- Formatting, Clippy with warnings denied, default-feature tests, all-feature ordinary tests, Tauri Rust tests, frontend tests, and production build exit 0.
- The ordinary test run reports the 100/500 test ignored; `npm run test:sync:scale` runs exactly `one_hundred_partitioned_peers_eventually_converge` once and passes within the 30-minute CI budget.
- Mesh, revocation, and corruption commands end with stable JSON whose `converged` field is true.
- Revocation evidence includes one exact signed notice, a durable revoked reopen, zero control/data advertise calls, zero control/data pack calls, and no post-revocation ref or payload acquisition.
- Rejected suffix and zero-accepted tests prove their unique object IDs are absent from trusted storage.
- `git diff --check` prints nothing.
- Both status checks show no hardening-plan leftovers; the main worktree's pre-existing Notes changes remain untouched.
- These results demonstrate the standalone file-backed sync core only. They do not demonstrate real networking, UI, issue projection, attachments, read-only web, epoch rotation, or hard OS-level CPU/RSS sandboxing.

## Plan Self-Review Record

- Spec coverage: all A–J broad-review findings, the approved cooperative revocation model, app-only writer rule, file-backed Git authority, control-first allowed sync, and explicit follow-up boundaries map to Tasks 1–5.
- Placeholder scan: every implementation action has an exact file, interface, test, command, expected RED/GREEN result, commit, and reviewer checkpoint; no deferred implementation markers remain.
- Type consistency: Tasks 4 and 5 use the same final `SessionToken`, `HelloAck`, and `PeerEndpoint`; Task 2's combined `RepositoryWriter::import_pack` is the operation Task 3 sanitizes; Task 5's public `Replica` delegates only to those hardened internals.
- Resource consistency: tests and docs use the same 16 MiB compressed, 64 MiB expanded, 1024-commit, 8192-object, 1024-tree-entry, 1024-atom, 4 MiB blob, 4 MiB metadata, and 128-ref defaults.
- Security claim consistency: `index-pack` is quarantine-only and bounded; accepted-only promotion prevents rejected-object trust; strict Git CPU/RSS containment is explicitly left to the packaged OS runtime.

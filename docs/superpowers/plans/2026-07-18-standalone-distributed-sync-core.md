# Standalone Distributed Sync Core Implementation Plan

**Date:** 2026-07-18

**Status:** Ready for execution

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone Rust synchronization component and deterministic lab that can create file-backed replicas, exchange control and data Git refs through an in-process peer transport, quarantine and validate packs, enforce cooperative membership revocation, and prove convergence without starting Tauri or the Yonalist UI.

**Architecture:** A new `yonalist-sync` crate owns a bare SHA-256 Git repository, signed opaque atom envelopes, separate control/data refs, a policy interface, and a pull-based sync state machine. The component does not understand issues or comments; a fixture policy supplies membership semantics in tests. Real networking, issue projection, conflict UI, attachments, and relay/web services consume this crate in later implementation plans.

**Tech Stack:** Rust 1.97, a pinned/injected Git 2.49+ executable, serde/CBOR, Ed25519 signatures, SHA-256, UUIDv7, tempfile, and Rust integration/property-style tests without Tauri, React, SQLite, or async runtime dependencies.

## Global Constraints

- The standalone command is `cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml` and must not compile or launch Tauri.
- The application is the only supported writer. The crate never runs user hooks, reads user remotes, invokes a shell, or accepts arbitrary Git arguments.
- Project repositories are bare SHA-256 repositories with `refs/yonalist/control/<device-id>` and `refs/yonalist/data/<device-id>`.
- A local ref compare-and-swap is the write commit point. Projection, UI, and network acknowledgements are outside that commit point.
- Control refs are fetched, validated, and applied before any data ref is requested.
- Incoming packs stay in peer-specific quarantine until Git integrity, append-only refs, atom limits, signatures, and the injected policy pass.
- A peer that knows the requester is revoked may send revocation control data but no ordinary data pack.
- The first slice uses no project epoch, no end-to-end project encryption, no SQLite, no attachment bytes, and no source-code repository integration.
- Atom payloads are opaque bytes to this crate. Issue/comment/state interpretation belongs to a later domain crate.
- Direct internet sockets, mDNS, WebSocket relay, bundle import/export, attachment sidecars, read-only web, and Tauri commands are separate follow-up plans.
- Tests must use deterministic keys, IDs, clocks, and seeded fault scenarios. Production randomness is injected by callers.
- Every task follows TDD: add a focused failing test, run it to observe RED, add the smallest implementation, run focused and crate regressions, then commit only that task.
- Preserve all pre-existing working-tree changes outside `src-tauri/crates/yonalist-sync`, `package.json`, `.github/workflows/ci.yml`, `.gitignore`, and the README section named by this plan.

---

## Scope Boundary and Follow-Up Plans

This plan proves the synchronization engine in isolation. It deliberately stops
at an opaque, validated set of atoms and trusted refs. The approved design must
be completed by later plans for:

1. issue/comment/state/reference projection and three-way merge;
2. attachment sidecar replication;
3. real peer discovery and encrypted network transports;
4. Tauri command/UI integration and the conflict resolver; and
5. relay persistence, read-only web projection, offline lease, and backup
   bundles.

The standalone core is a prerequisite for those plans, not a throwaway spike.

## Public Component Boundary

The crate exposes one production surface:

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

The caller injects:

- the absolute project repository path;
- the pinned Git executable path;
- local project/member/device/grant IDs;
- a `ProjectPolicy` that validates atom payloads and determines access; and
- atom bytes already signed by the domain layer or fixture policy.

The core exposes `test-support` only for deterministic scenario construction.

## File Structure

| File | Responsibility |
| --- | --- |
| `src-tauri/crates/yonalist-sync/Cargo.toml` | Independent crate, binary target, dependency and feature boundary. |
| `src-tauri/crates/yonalist-sync/src/lib.rs` | Public exports only. |
| `src-tauri/crates/yonalist-sync/src/error.rs` | Stable `SyncErrorCode` and contextual `SyncError`. |
| `src-tauri/crates/yonalist-sync/src/ids.rs` | Strong project/member/device/grant/event IDs and SHA-256 Git OIDs. |
| `src-tauri/crates/yonalist-sync/src/atom.rs` | Versioned fixed-layout CBOR envelope, signature bytes, limits, and paths. |
| `src-tauri/crates/yonalist-sync/src/identity.rs` | Ed25519 signing/verification helpers with injected secret bytes. |
| `src-tauri/crates/yonalist-sync/src/policy.rs` | `ProjectPolicy`, `AccessDecision`, and `AccessState`. |
| `src-tauri/crates/yonalist-sync/src/git_command.rs` | Sanitized no-shell Git process execution. |
| `src-tauri/crates/yonalist-sync/src/git_store.rs` | Bare repo creation/open, immutable file commits, refs, tree reads, and ancestry. |
| `src-tauri/crates/yonalist-sync/src/pack.rs` | Pack creation, quarantine import, validation input, promotion, and cleanup. |
| `src-tauri/crates/yonalist-sync/src/protocol.rs` | Serializable hello, ref advertisement, pack request, and sync report types. |
| `src-tauri/crates/yonalist-sync/src/transport.rs` | Synchronous `PeerEndpoint` request/response boundary. |
| `src-tauri/crates/yonalist-sync/src/replica.rs` | Local append and control-first pull orchestration. |
| `src-tauri/crates/yonalist-sync/src/test_support/mod.rs` | Feature-gated deterministic fixture exports. |
| `src-tauri/crates/yonalist-sync/src/test_support/policy.rs` | Signed grant/revoke fixture policy. |
| `src-tauri/crates/yonalist-sync/src/test_support/peer.rs` | In-process endpoint, counters, and pack fault injection. |
| `src-tauri/crates/yonalist-sync/src/test_support/scenario.rs` | Seeded mesh, partition, revocation, and corruption scenarios. |
| `src-tauri/crates/yonalist-sync/src/bin/sync-lab.rs` | Standalone JSON-reporting scenario CLI. |
| `src-tauri/crates/yonalist-sync/tests/atom_codec.rs` | Deterministic encoding, signing, tamper, and limit tests. |
| `src-tauri/crates/yonalist-sync/tests/git_store.rs` | Local commit point, refs, restart, and CAS tests. |
| `src-tauri/crates/yonalist-sync/tests/pack_quarantine.rs` | Missing-object pack, corruption, prefix acceptance, and rewind tests. |
| `src-tauri/crates/yonalist-sync/tests/two_peer_sync.rs` | Allowed control/data convergence and idempotency. |
| `src-tauri/crates/yonalist-sync/tests/revocation.rs` | Control-only denial and client lock behavior. |
| `src-tauri/crates/yonalist-sync/tests/mesh_convergence.rs` | Partition, reconnect, duplication, and 100-peer deterministic convergence. |
| `src-tauri/crates/yonalist-sync/tests/lab_scenarios.rs` | Stable scenario summaries used by the CLI. |

---

### Task 1: Create the independent crate and stable primitive types

**Files:**
- Create: `src-tauri/crates/yonalist-sync/Cargo.toml`
- Create: `src-tauri/crates/yonalist-sync/src/lib.rs`
- Create: `src-tauri/crates/yonalist-sync/src/error.rs`
- Create: `src-tauri/crates/yonalist-sync/src/ids.rs`
- Create: `src-tauri/crates/yonalist-sync/tests/public_contract.rs`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: Rust 1.97 from `rust-toolchain.toml`.
- Produces:

```rust
pub enum Plane { Control, Data }
pub struct ProjectId(Uuid);
pub struct MemberId(Uuid);
pub struct DeviceId(Uuid);
pub struct GrantId(Uuid);
pub struct EventId(Uuid);
pub struct GitOid(String);
pub enum SyncErrorCode {
    GitUnavailable,
    GitCommandFailed,
    InvalidId,
    InvalidAtom,
    InvalidSignature,
    UnsupportedSchema,
    RefRewind,
    PackRejected,
    PolicyRejected,
    AccessRevoked,
    LimitExceeded,
    Io,
}
pub struct SyncError { pub code: SyncErrorCode, pub message: String }
```

- [ ] **Step 1: Write the failing public-contract test**

```rust
use yonalist_sync::{DeviceId, GitOid, Plane, ProjectId, SyncErrorCode};

#[test]
fn primitive_types_are_stable_and_strongly_typed() {
    let project = ProjectId::from_bytes([1; 16]);
    let device = DeviceId::from_bytes([2; 16]);
    assert_eq!(project.to_string(), "01040g2081040g2081040g2081");
    assert_eq!(device.to_string(), "02081040g2081040g2081040g2");
    assert_eq!(Plane::Control.ref_prefix(), "refs/yonalist/control/");
    assert_eq!(Plane::Data.ref_prefix(), "refs/yonalist/data/");
    assert_eq!(GitOid::parse(&"a".repeat(64)).unwrap().as_str(), "a".repeat(64));
    assert_eq!(GitOid::parse("abc").unwrap_err().code, SyncErrorCode::InvalidId);
}
```

The Base32 expected values are protocol fixtures. If the chosen Crockford
encoder produces different text, update the implementation rather than the
fixtures.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --test public_contract
```

Expected: FAIL because the crate and exported types do not exist.

- [ ] **Step 3: Add the crate manifest and primitive implementations**

Create this manifest:

```toml
[package]
name = "yonalist-sync"
version = "0.1.0"
edition = "2021"
rust-version = "1.97"

[features]
default = []
test-support = ["dep:tempfile"]

[dependencies]
ciborium = "0.2"
data-encoding = "2"
ed25519-dalek = "2"
serde = { version = "1", features = ["derive"] }
serde_bytes = "0.11"
serde_json = "1"
sha2 = "0.11"
thiserror = "2"
tempfile = { version = "3", optional = true }
uuid = { version = "1", features = ["serde", "v7"] }

[dev-dependencies]
tempfile = "3"
```

In `ids.rs`, use one private macro to generate the five UUID-backed ID types.
Each type must expose `from_bytes`, `from_uuid`, `as_uuid`, `Display`, and
`FromStr`. Display is lowercase Crockford Base32 over the raw 16 bytes without
padding. `GitOid::parse` accepts exactly 64 lowercase hexadecimal characters.
In `error.rs`, derive `thiserror::Error`; its display is the message while the
stable code remains inspectable. `lib.rs` re-exports only the listed public
types and declares future modules privately until their task exports them.

Append this one ignore rule:

```gitignore
src-tauri/crates/*/target/
```

- [ ] **Step 4: Run the focused test and crate check**

Run:

```bash
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --test public_contract
cargo check --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --all-features
```

Expected: both commands exit 0; one public-contract test passes and the crate
does not compile `tauri` or `rusqlite`.

- [ ] **Step 5: Commit the primitive boundary**

```bash
git add .gitignore src-tauri/crates/yonalist-sync
git commit -m "feat(sync): add standalone core crate"
```

### Task 2: Add deterministic signed atom envelopes and policy contracts

**Files:**
- Create: `src-tauri/crates/yonalist-sync/src/atom.rs`
- Create: `src-tauri/crates/yonalist-sync/src/identity.rs`
- Create: `src-tauri/crates/yonalist-sync/src/policy.rs`
- Create: `src-tauri/crates/yonalist-sync/tests/atom_codec.rs`
- Modify: `src-tauri/crates/yonalist-sync/src/lib.rs`

**Interfaces:**
- Consumes: Task 1 IDs, `Plane`, and errors.
- Produces:

```rust
pub const ATOM_SCHEMA_V1: u16 = 1;

pub struct AtomLimits {
    pub max_payload_bytes: usize,
    pub max_frontier_heads: usize,
}

pub struct UnsignedAtom {
    pub schema: u16,
    pub project_id: ProjectId,
    pub event_id: EventId,
    pub plane: Plane,
    pub actor_member_id: MemberId,
    pub actor_device_id: DeviceId,
    pub membership_grant_id: GrantId,
    pub control_frontier: Vec<GitOid>,
    pub data_frontier: Vec<GitOid>,
    pub display_time_ms: i64,
    pub payload: Vec<u8>,
}

pub struct SignedAtom { pub unsigned: UnsignedAtom, pub signature: Vec<u8> }
pub struct StoredAtom { pub path: String, pub containing_commit: GitOid, pub atom: SignedAtom }

pub struct DeviceSigner;
impl DeviceSigner {
    pub fn from_secret_bytes(secret: [u8; 32]) -> Self;
    pub fn public_key(&self) -> [u8; 32];
    pub fn sign(&self, atom: UnsignedAtom) -> Result<SignedAtom, SyncError>;
}

impl SignedAtom {
    pub fn encode(&self, limits: &AtomLimits) -> Result<Vec<u8>, SyncError>;
    pub fn decode(bytes: &[u8], limits: &AtomLimits) -> Result<Self, SyncError>;
    pub fn verify(&self, public_key: &[u8; 32]) -> Result<(), SyncError>;
    pub fn repo_path(&self) -> String;
}

pub enum AccessDecision { Allowed, ControlOnly { notice_event_ids: Vec<EventId> }, Denied }
pub enum AccessState { Active, Revoked { grant_id: GrantId } }

pub trait ProjectPolicy: Send + Sync {
    type State: Clone + Send + Sync;
    fn rebuild_control(&self, atoms: &[StoredAtom]) -> Result<Self::State, SyncError>;
    fn validate_control(&self, state: &Self::State, atom: &StoredAtom) -> Result<(), SyncError>;
    fn validate_data(&self, state: &Self::State, atom: &StoredAtom) -> Result<(), SyncError>;
    fn peer_access(&self, state: &Self::State, member: MemberId, grant: GrantId) -> AccessDecision;
    fn local_access(&self, state: &Self::State, member: MemberId, grant: GrantId) -> AccessState;
}
```

- [ ] **Step 1: Write failing codec, tamper, schema, and limit tests**

```rust
#[test]
fn signed_atom_has_stable_bytes_and_rejects_tampering() {
    let signer = DeviceSigner::from_secret_bytes([7; 32]);
    let signed = signer.sign(fixture_unsigned_atom(Plane::Data, b"issue.created")).unwrap();
    let limits = AtomLimits { max_payload_bytes: 1024, max_frontier_heads: 8 };
    let encoded = signed.encode(&limits).unwrap();
    let decoded = SignedAtom::decode(&encoded, &limits).unwrap();
    decoded.verify(&signer.public_key()).unwrap();
    assert_eq!(decoded.encode(&limits).unwrap(), encoded);
    assert_eq!(
        signer.sign(fixture_unsigned_atom(Plane::Data, b"issue.created")).unwrap().encode(&limits).unwrap(),
        encoded,
    );

    let mut tampered = encoded;
    let last = tampered.len() - 1;
    tampered[last] ^= 0x01;
    let decoded = SignedAtom::decode(&tampered, &limits).unwrap();
    assert_eq!(decoded.verify(&signer.public_key()).unwrap_err().code, SyncErrorCode::InvalidSignature);
}

#[test]
fn atom_rejects_wrong_plane_frontier_and_limits() {
    let signer = DeviceSigner::from_secret_bytes([9; 32]);
    let mut atom = fixture_unsigned_atom(Plane::Control, b"member.granted");
    atom.data_frontier.push(GitOid::parse(&"a".repeat(64)).unwrap());
    let signed = signer.sign(atom).unwrap();
    let generous = AtomLimits { max_payload_bytes: 1024, max_frontier_heads: 4 };
    assert_eq!(signed.encode(&generous).unwrap_err().code, SyncErrorCode::InvalidAtom);

    let signed = signer.sign(fixture_unsigned_atom(Plane::Data, &[1; 17])).unwrap();
    let limits = AtomLimits { max_payload_bytes: 16, max_frontier_heads: 4 };
    assert_eq!(signed.encode(&limits).unwrap_err().code, SyncErrorCode::LimitExceeded);
}
```

Define `fixture_unsigned_atom` in this test file with fixed `[1; 16]` through
`[5; 16]` IDs, empty frontiers, `display_time_ms = 1234`, and the supplied
payload. The repeat-sign assertion freezes determinism without inventing a
digest before the wire encoder exists; changing the fixed tuple still requires
a deliberate schema change and review.

- [ ] **Step 2: Run the atom tests and verify RED**

Run:

```bash
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --test atom_codec -- --nocapture
```

Expected: FAIL because atom encoding, signing, and policy contracts do not exist.

- [ ] **Step 3: Implement fixed-layout CBOR and Ed25519 verification**

Serialize the unsigned signing bytes as one CBOR tuple in this exact order:

```rust
type UnsignedWireV1 = (
    u16,
    [u8; 16],
    [u8; 16],
    u8,
    [u8; 16],
    [u8; 16],
    [u8; 16],
    Vec<String>,
    Vec<String>,
    i64,
    serde_bytes::ByteBuf,
);
```

Encode the complete signed form as `(UnsignedWireV1, ByteBuf)`. Sort and
deduplicate both frontiers before signing. Reject a control atom with a nonempty
data frontier, any signature length other than 64, payload/frontier overflow,
schema other than 1, or a decoded atom whose re-encoding differs from the input.
Use `ed25519_dalek::SigningKey` and `VerifyingKey`; verification failure maps to
`InvalidSignature` without exposing key material. Atom paths are exactly:

```rust
match atom.unsigned.plane {
    Plane::Control => format!("control-atoms/{}/{}.cbor", &id[..2], id),
    Plane::Data => format!("data-atoms/{}/{}.cbor", &id[..2], id),
}
```

Export the contracts through `lib.rs`. Do not put membership semantics in
`atom.rs`; `ProjectPolicy` is the only semantic boundary.

- [ ] **Step 4: Run focused and crate tests**

Run:

```bash
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --test atom_codec
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml
```

Expected: PASS; tampered signatures, wrong schema, wrong plane frontier, and
oversized payloads are rejected by stable error codes.

- [ ] **Step 5: Commit the atom protocol**

```bash
git add src-tauri/crates/yonalist-sync/src src-tauri/crates/yonalist-sync/tests/atom_codec.rs
git commit -m "feat(sync): add signed atom protocol"
```

### Task 3: Implement the bare Git store and local commit point

**Files:**
- Create: `src-tauri/crates/yonalist-sync/src/git_command.rs`
- Create: `src-tauri/crates/yonalist-sync/src/git_store.rs`
- Create: `src-tauri/crates/yonalist-sync/src/protocol.rs`
- Create: `src-tauri/crates/yonalist-sync/tests/git_store.rs`
- Modify: `src-tauri/crates/yonalist-sync/src/lib.rs`

**Interfaces:**
- Consumes: Task 2 encoded atoms and paths.
- Produces:

```rust
pub struct GitStore;
pub struct ImmutableFile { pub path: String, pub bytes: Vec<u8> }
pub struct StoreBatch {
    pub plane: Plane,
    pub device_id: DeviceId,
    pub expected_head: Option<GitOid>,
    pub atoms: Vec<SignedAtom>,
    pub auxiliary_files: Vec<ImmutableFile>,
    pub observed_heads: Vec<GitOid>,
}
pub struct LocalCommit { pub ref_name: String, pub previous: Option<GitOid>, pub head: GitOid }
pub struct RefAdvertisement { pub plane: Plane, pub refs: BTreeMap<DeviceId, GitOid> }

impl GitStore {
    pub fn init(repo: &Path, git_executable: &Path) -> Result<Self, SyncError>;
    pub fn open(repo: &Path, git_executable: &Path) -> Result<Self, SyncError>;
    pub fn append_local(&self, batch: StoreBatch) -> Result<LocalCommit, SyncError>;
    pub fn head(&self, plane: Plane, device: DeviceId) -> Result<Option<GitOid>, SyncError>;
    pub fn advertise(&self, plane: Plane) -> Result<RefAdvertisement, SyncError>;
    pub fn stored_atoms(&self, plane: Plane, limits: &AtomLimits) -> Result<Vec<StoredAtom>, SyncError>;
    pub fn is_ancestor(&self, older: &GitOid, newer: &GitOid) -> Result<bool, SyncError>;
}
```

- [ ] **Step 1: Write failing durability, restart, and CAS tests**

```rust
#[test]
fn local_append_is_durable_at_the_device_ref() {
    let temp = tempfile::tempdir().unwrap();
    let git = test_git_executable();
    let store = GitStore::init(temp.path(), &git).unwrap();
    let fixture = signed_fixture(Plane::Data, EventId::from_bytes([3; 16]));
    let commit = store.append_local(batch_for(fixture.clone())).unwrap();
    assert_eq!(store.head(Plane::Data, fixture.unsigned.actor_device_id).unwrap(), Some(commit.head.clone()));
    drop(store);

    let reopened = GitStore::open(temp.path(), &git).unwrap();
    let atoms = reopened.stored_atoms(Plane::Data, &test_limits()).unwrap();
    assert_eq!(atoms.len(), 1);
    assert_eq!(atoms[0].atom.unsigned.event_id, fixture.unsigned.event_id);
}

#[test]
fn stale_compare_and_swap_does_not_move_the_ref() {
    let (store, device, first) = store_with_one_data_commit();
    let second = store.append_local(batch_with_expected(device, Some(first.head.clone()), EventId::from_bytes([4; 16]))).unwrap();
    let error = store.append_local(batch_with_expected(device, Some(first.head), EventId::from_bytes([5; 16]))).unwrap_err();
    assert_eq!(error.code, SyncErrorCode::RefRewind);
    assert_eq!(store.head(Plane::Data, device).unwrap(), Some(second.head));
}
```

Define `test_git_executable` as `YONALIST_TEST_GIT` when set and `git` otherwise.
The other helpers create deterministic signed atoms using Task 2 and set
`expected_head` explicitly; no helper mutates refs outside `GitStore`.

- [ ] **Step 2: Run Git-store tests and verify RED**

Run:

```bash
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --test git_store -- --nocapture
```

Expected: FAIL because `GitStore` and local append do not exist.

- [ ] **Step 3: Implement sanitized Git plumbing and atomic refs**

`git_command.rs` must use `std::process::Command` directly, set
`GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL` to the null device,
`GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, `LC_ALL=C`, and pass
`--git-dir=<absolute repo>`. It accepts structured `OsString` arguments and
optional stdin bytes; no API accepts a command string.

Initialization runs:

```text
git init --bare --object-format=sha256 <absolute-repo>
git --git-dir=<repo> config core.hooksPath <repo>/disabled-hooks
git --git-dir=<repo> config gc.auto 0
```

`append_local` performs these exact logical steps:

1. compare the current local ref head to `batch.expected_head` and return
   `RefRewind` before writing when they differ;
2. validate every atom plane and every auxiliary path (`texts/<2>/<64>.md`
   only), rejecting duplicate paths with different bytes;
3. write blobs with `git hash-object -w --stdin`;
4. create a temporary index file, load each observed head tree plus the prior
   local tree into a `BTreeMap<path, oid>`, and reject any path mapped to two
   different OIDs;
5. feed the sorted union to `git update-index --index-info` using the temporary
   index and run `git write-tree`;
6. run `git commit-tree <tree> -p <prior> -p <reduced-observed-head>`, with
   duplicate and ancestor-redundant parents removed;
7. run `git update-ref <device-ref> <new> <expected-old>`; and
8. return success only after `update-ref` exits 0.

Commit identity is fixed internal metadata (`Yonalist Sync`,
`sync@yonalist.invalid`) and atom signatures remain the authorship authority.
`stored_atoms` unions paths from every advertised head, rejects mismatched
control/data prefixes, decodes each atom, and reports the commit that first
introduced that path. Reopening probes `rev-parse --show-object-format` and
rejects anything other than `sha256`.

- [ ] **Step 4: Run focused tests and inspect the real repository**

Run:

```bash
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --test git_store
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml
```

Expected: PASS; restart preserves the atom, a stale CAS leaves the old ref
unchanged, ref names use the selected plane, and the test repository reports
`sha256` object format.

- [ ] **Step 5: Commit the local Git store**

```bash
git add src-tauri/crates/yonalist-sync/src src-tauri/crates/yonalist-sync/tests/git_store.rs
git commit -m "feat(sync): add file-backed Git store"
```

### Task 4: Add missing-object packs, quarantine, prefix validation, and promotion

**Files:**
- Create: `src-tauri/crates/yonalist-sync/src/pack.rs`
- Create: `src-tauri/crates/yonalist-sync/tests/pack_quarantine.rs`
- Modify: `src-tauri/crates/yonalist-sync/src/git_store.rs`
- Modify: `src-tauri/crates/yonalist-sync/src/lib.rs`

**Interfaces:**
- Consumes: Task 3 refs, ancestry, Git command runner, and atom decoding.
- Produces:

```rust
pub struct PackLimits {
    pub max_pack_bytes: usize,
    pub max_advertised_refs: usize,
    pub max_atoms_per_head: usize,
}
pub struct PackRequest { pub plane: Plane, pub wants: Vec<GitOid>, pub haves: Vec<GitOid> }
pub struct PackBytes(pub Vec<u8>);
pub struct CandidateRef {
    pub device_id: DeviceId,
    pub previous: Option<GitOid>,
    pub accepted_head: GitOid,
    pub source_advertised_head: GitOid,
}
pub struct ValidatedPack { pub pack: PackBytes, pub accepted: Vec<CandidateRef>, pub rejected: Vec<(DeviceId, SyncErrorCode)> }

impl GitStore {
    pub fn create_pack(&self, request: &PackRequest, limits: &PackLimits) -> Result<PackBytes, SyncError>;
    pub fn validate_pack<P: ProjectPolicy>(&self, plane: Plane, advertised: &RefAdvertisement, pack: PackBytes, atom_limits: &AtomLimits, pack_limits: &PackLimits, policy: &P, control: &P::State) -> Result<ValidatedPack, SyncError>;
    pub fn promote_pack(&self, validated: ValidatedPack) -> Result<Vec<CandidateRef>, SyncError>;
}
```

- [ ] **Step 1: Write failing pack, corruption, rewind, and valid-prefix tests**

```rust
#[test]
fn corrupt_pack_never_moves_a_trusted_ref() {
    let (source, receiver, device, source_head) = stores_for_pack_test();
    let before = receiver.head(Plane::Data, device).unwrap();
    let mut pack = source.create_pack(&request_for(source_head), &pack_limits()).unwrap();
    pack.0[pack.0.len() / 2] ^= 0x80;
    let error = receiver.validate_pack(Plane::Data, &source.advertise(Plane::Data).unwrap(), pack, &atom_limits(), &pack_limits(), &allow_all_policy(), &allow_all_state()).unwrap_err();
    assert_eq!(error.code, SyncErrorCode::PackRejected);
    assert_eq!(receiver.head(Plane::Data, device).unwrap(), before);
}

#[test]
fn validator_accepts_the_largest_valid_ancestor_only() {
    let (source, receiver, device, first_valid, second_invalid) = source_with_valid_then_invalid_atom();
    let validated = pull_and_validate(&source, &receiver, Plane::Data, rejecting_policy()).unwrap();
    assert_eq!(validated.accepted[0].accepted_head, first_valid);
    assert_eq!(validated.accepted[0].source_advertised_head, second_invalid);
    assert_eq!(validated.rejected, vec![(device, SyncErrorCode::PolicyRejected)]);
    receiver.promote_pack(validated).unwrap();
    assert_eq!(receiver.head(Plane::Data, device).unwrap(), Some(first_valid));
    assert!(!receiver.is_ancestor(&first_valid, &second_invalid).unwrap_or(false));
}
```

The helpers create one source/receiver pair with a shared initial control state.
`request_for` advertises the source head as the only want and every receiver
head as a have. `allow_all_policy` verifies the fixture signature and accepts
all payloads. `rejecting_policy` rejects only the exact payload
`b"policy.reject"`; `source_with_valid_then_invalid_atom` commits a normal atom
followed by that payload on the same device ref. `pull_and_validate` calls only
the public `advertise`, `create_pack`, and `validate_pack` methods.

- [ ] **Step 2: Run quarantine tests and verify RED**

Run:

```bash
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --test pack_quarantine -- --nocapture
```

Expected: FAIL because pack creation, quarantine, and promotion do not exist.

- [ ] **Step 3: Implement pack creation and two-pass quarantine promotion**

`create_pack` runs `git pack-objects --stdout --revs --thin`, writing every want
OID followed by every `^have` OID to stdin. It rejects empty wants, duplicate
refs beyond the configured limit, or output beyond `max_pack_bytes`.

`validate_pack` creates `<repo>/incoming/<random-session>/quarantine.git` as a
bare SHA-256 repo. Its `objects/info/alternates` contains the canonical absolute
path to the trusted repo's object directory. Import with:

```text
git --git-dir=<quarantine> index-pack --stdin --fix-thin
```

For each advertised device ref, require the new head to descend from the prior
trusted head. Walk commits oldest-first using `rev-list --reverse
<old>..<advertised>`. At each commit, load the complete tree through the
quarantine alternate, enforce the plane-specific atom prefix and atom count,
decode atoms, reject mutable path reuse, and call the matching policy validator.
Stop at the first invalid commit and retain the previous valid commit as the
accepted prefix. A first invalid commit accepts no update for that device.

`promote_pack` replays the already-validated pack into the trusted object
directory with `index-pack --stdin --fix-thin`, then uses one `git update-ref
--stdin` transaction containing `verify` and `update` lines for every accepted
ref. If any verify fails, no ref moves. Remove quarantine on every outcome.

- [ ] **Step 4: Run quarantine and crate regressions**

Run:

```bash
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --test pack_quarantine
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml
```

Expected: PASS; corruption, ref rewind, schema mismatch, and policy rejection do
not advance a trusted ref, while a valid prefix advances atomically.

- [ ] **Step 5: Commit quarantine support**

```bash
git add src-tauri/crates/yonalist-sync/src src-tauri/crates/yonalist-sync/tests/pack_quarantine.rs
git commit -m "feat(sync): quarantine incoming Git packs"
```

### Task 5: Implement the control-first peer protocol and two-peer convergence

**Files:**
- Modify: `src-tauri/crates/yonalist-sync/src/protocol.rs`
- Create: `src-tauri/crates/yonalist-sync/src/transport.rs`
- Create: `src-tauri/crates/yonalist-sync/src/replica.rs`
- Create: `src-tauri/crates/yonalist-sync/src/test_support/mod.rs`
- Create: `src-tauri/crates/yonalist-sync/src/test_support/policy.rs`
- Create: `src-tauri/crates/yonalist-sync/src/test_support/peer.rs`
- Create: `src-tauri/crates/yonalist-sync/tests/two_peer_sync.rs`
- Modify: `src-tauri/crates/yonalist-sync/src/lib.rs`

**Interfaces:**
- Consumes: Tasks 2-4 atom, policy, store, and pack APIs.
- Produces:

```rust
pub struct ReplicaConfig {
    pub repository: PathBuf,
    pub git_executable: PathBuf,
    pub project_id: ProjectId,
    pub local_member_id: MemberId,
    pub local_device_id: DeviceId,
    pub local_grant_id: GrantId,
    pub atom_limits: AtomLimits,
    pub pack_limits: PackLimits,
}
pub struct LocalBatch {
    pub plane: Plane,
    pub atoms: Vec<SignedAtom>,
    pub auxiliary_files: Vec<ImmutableFile>,
}
pub struct Hello { pub project_id: ProjectId, pub member_id: MemberId, pub device_id: DeviceId, pub grant_id: GrantId }
pub struct HelloAck { pub decision: AccessDecision }
pub struct SyncReport {
    pub control_refs_advanced: usize,
    pub data_refs_advanced: usize,
    pub control_pack_bytes: usize,
    pub data_pack_bytes: usize,
    pub access_state: AccessState,
}

pub trait PeerEndpoint {
    fn hello(&mut self, hello: &Hello) -> Result<HelloAck, SyncError>;
    fn advertise(&mut self, project: ProjectId, plane: Plane) -> Result<RefAdvertisement, SyncError>;
    fn create_pack(&mut self, project: ProjectId, request: &PackRequest, limits: &PackLimits) -> Result<PackBytes, SyncError>;
}

pub struct FixtureIdentity { pub member_id: MemberId, pub device_id: DeviceId, pub grant_id: GrantId }
pub struct FixturePair {
    pub alice: Replica<FixturePolicy>,
    pub bob: Replica<FixturePolicy>,
    pub alice_identity: FixtureIdentity,
    pub bob_identity: FixtureIdentity,
}
```

- [ ] **Step 1: Write the failing allowed-sync and idempotency test**

```rust
#[test]
fn two_allowed_peers_converge_and_second_pull_is_empty() {
    let mut pair = FixturePair::new();
    pair.alice.append_fixture_data(b"alice-offline-1").unwrap();
    pair.alice.append_fixture_data(b"alice-offline-2").unwrap();

    let mut endpoint = InProcessPeer::new(&pair.alice);
    let first = pair.bob.pull_from(&mut endpoint).unwrap();
    assert_eq!(first.control_refs_advanced, 1);
    assert_eq!(first.data_refs_advanced, 1);
    assert!(first.data_pack_bytes > 0);
    assert_eq!(pair.alice.event_ids(Plane::Data), pair.bob.event_ids(Plane::Data));

    let second = pair.bob.pull_from(&mut endpoint).unwrap();
    assert_eq!(second.control_refs_advanced, 0);
    assert_eq!(second.data_refs_advanced, 0);
    assert_eq!(second.control_pack_bytes, 0);
    assert_eq!(second.data_pack_bytes, 0);
}
```

- [ ] **Step 2: Run two-peer tests and verify RED**

Run:

```bash
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --features test-support --test two_peer_sync -- --nocapture
```

Expected: FAIL because `Replica`, protocol messages, endpoint, and fixture policy
do not exist.

- [ ] **Step 3: Implement pull orchestration and deterministic fixture policy**

`Replica::pull_from` performs this sequence without skipping a phase:

```rust
let hello = self.local_hello();
let ack = peer.hello(&hello)?;
let control = self.pull_plane(peer, Plane::Control)?;
self.rebuild_policy_state()?;
self.access_state = self.policy.local_access(
    &self.policy_state,
    self.config.local_member_id,
    self.config.local_grant_id,
);
if !matches!(self.access_state, AccessState::Active) {
    return Ok(self.report(control, PlanePull::empty(), self.access_state.clone()));
}
if !matches!(ack.decision, AccessDecision::Allowed) {
    return Ok(self.report(control, PlanePull::empty(), self.access_state.clone()));
}
let data = self.pull_plane(peer, Plane::Data)?;
Ok(self.report(control, data, self.access_state.clone()))
```

`Replica::append_local` first rebuilds current control state, requires
`AccessState::Active`, requires every atom actor/project/grant/plane to match the
local configuration and batch, and invokes `validate_control` or
`validate_data`. It also requires the atom frontiers to equal the reduced
trusted control/data heads and creates a `StoreBatch` with `expected_head` set
from the current local ref before calling `GitStore`. A caller cannot use
`Replica` to append a stale-frontier or foreign-device atom.

`pull_plane` advertises local haves and remote wants, skips pack creation when
every wanted head is already local, validates/promotes the pack, then returns
exact advanced-ref and byte counts.

The feature-gated fixture policy uses signed CBOR payloads:

```rust
pub enum FixtureControl {
    Grant { member_id: MemberId, grant_id: GrantId, role: FixtureRole, device_key: [u8; 32] },
    Revoke { grant_id: GrantId },
}
pub enum FixtureRole { Owner, Admin, Member }
pub struct FixtureState { pub grants: BTreeMap<GrantId, FixtureGrant> }
```

It verifies every atom signature against the active grant's device key. Only an
owner/admin control atom may grant or revoke. Data requires an active grant.
`InProcessPeer` calls the source replica's advertise/create-pack APIs and counts
phase calls; it serializes the same request/response structs a real transport
will use.

`FixturePolicy` receives Alice's owner public key as an out-of-band project trust
anchor. `FixturePair::new` creates Alice's owner genesis and Bob grant in
Alice's control ref, configures Bob with that grant and trust anchor but an empty
repository, and uses fixed keys and IDs. Test-support methods are
`append_fixture_data`, `event_ids`, `payloads`, `revoke`,
`sync_both_directions`, `local_hello`, and `endpoint`; each is a thin call
through the production `Replica` or policy API rather than a direct ref
mutation.

- [ ] **Step 4: Run two-peer and full tests**

Run:

```bash
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --features test-support --test two_peer_sync
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --all-features
```

Expected: PASS; the first pull converges both data sets and the second pull
requests no pack bytes.

- [ ] **Step 5: Commit the peer protocol**

```bash
git add src-tauri/crates/yonalist-sync/src src-tauri/crates/yonalist-sync/tests/two_peer_sync.rs
git commit -m "feat(sync): add control-first peer pulls"
```

### Task 6: Enforce revocation as control-only sharing and local lock

**Files:**
- Create: `src-tauri/crates/yonalist-sync/tests/revocation.rs`
- Modify: `src-tauri/crates/yonalist-sync/src/replica.rs`
- Modify: `src-tauri/crates/yonalist-sync/src/test_support/policy.rs`
- Modify: `src-tauri/crates/yonalist-sync/src/test_support/peer.rs`

**Interfaces:**
- Consumes: Task 5 `AccessDecision`, `AccessState`, and phase counters.
- Produces no new public type. It fixes the handshake contract:
  - `Allowed`: control then data may be shared;
  - `ControlOnly`: advertise and pack only control refs containing the notice;
  - `Denied`: share neither plane.

- [ ] **Step 1: Write failing revocation propagation tests**

```rust
#[test]
fn removed_client_receives_control_notice_but_no_data() {
    let mut pair = FixturePair::new();
    pair.sync_both_directions().unwrap();
    pair.alice.revoke(pair.bob_identity.grant_id).unwrap();
    pair.alice.append_fixture_data(b"secret-after-revocation").unwrap();

    let mut endpoint = InProcessPeer::new(&pair.alice);
    let report = pair.bob.pull_from(&mut endpoint).unwrap();
    assert!(matches!(report.access_state, AccessState::Revoked { grant_id } if grant_id == pair.bob_identity.grant_id));
    assert_eq!(report.control_refs_advanced, 1);
    assert_eq!(report.data_refs_advanced, 0);
    assert_eq!(endpoint.data_pack_requests(), 0);
    assert!(!pair.bob.payloads(Plane::Data).contains(&b"secret-after-revocation".to_vec()));
}

#[test]
fn peer_that_knows_revocation_refuses_removed_requester_data() {
    let mut pair = FixturePair::new();
    pair.alice.revoke(pair.bob_identity.grant_id).unwrap();
    let mut endpoint = pair.alice.endpoint();
    let ack = endpoint.hello(&pair.bob.local_hello()).unwrap();
    assert!(matches!(ack.decision, AccessDecision::ControlOnly { .. }));
}
```

- [ ] **Step 2: Run revocation tests and verify RED**

Run:

```bash
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --features test-support --test revocation -- --nocapture
```

Expected: FAIL because the endpoint currently allows data after revocation or
the local replica does not transition to `AccessState::Revoked`.

- [ ] **Step 3: Implement control-only denial without epoch rotation**

`InProcessPeer::hello` rebuilds the source control state and returns its policy
decision for the requester. `advertise(Data)` and `create_pack(Data)` return an
`AccessRevoked` error unless the last hello decision was `Allowed` for the same
project/member/device/grant tuple. Control access under `ControlOnly` is limited
to refs whose trees contain the policy-provided notice event IDs.

After the local control promotion, `Replica::pull_from` always recomputes local
access before attempting data. A revoked result remains sticky until a later
control sync produces a new active grant ID configured by the caller. The core
does not delete repository files or rotate keys.

- [ ] **Step 4: Run revocation, two-peer, and crate tests**

Run:

```bash
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --features test-support --test revocation
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --features test-support --test two_peer_sync
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --all-features
```

Expected: PASS; revocation control advances, post-revocation data does not
arrive, and allowed peers retain normal idempotent sync.

- [ ] **Step 5: Commit membership gating**

```bash
git add src-tauri/crates/yonalist-sync/src src-tauri/crates/yonalist-sync/tests/revocation.rs
git commit -m "feat(sync): stop data sharing after revocation"
```

### Task 7: Add deterministic fault injection, mesh convergence, and the sync lab

**Files:**
- Create: `src-tauri/crates/yonalist-sync/src/test_support/scenario.rs`
- Create: `src-tauri/crates/yonalist-sync/src/bin/sync-lab.rs`
- Create: `src-tauri/crates/yonalist-sync/tests/mesh_convergence.rs`
- Create: `src-tauri/crates/yonalist-sync/tests/lab_scenarios.rs`
- Modify: `src-tauri/crates/yonalist-sync/src/test_support/peer.rs`
- Modify: `src-tauri/crates/yonalist-sync/Cargo.toml`

**Interfaces:**
- Consumes: Tasks 5-6 replica and in-process endpoint.
- Produces:

```rust
pub enum PackFault { None, DropAfter(usize), FlipByte(usize) }
pub struct ScenarioConfig { pub peers: usize, pub events: usize, pub seed: u64 }
pub struct ScenarioSummary {
    pub scenario: String,
    pub peers: usize,
    pub events: usize,
    pub rounds: usize,
    pub converged: bool,
    pub rejected_packs: usize,
    pub revoked_peers: usize,
    pub final_event_digest: String,
}
pub fn run_mesh(config: ScenarioConfig) -> Result<ScenarioSummary, SyncError>;
pub fn run_revocation(seed: u64) -> Result<ScenarioSummary, SyncError>;
pub fn run_corrupt_pack(seed: u64) -> Result<ScenarioSummary, SyncError>;
```

- [ ] **Step 1: Write failing partition, corruption-retry, and scenario tests**

```rust
#[test]
fn one_hundred_partitioned_peers_eventually_converge() {
    let summary = run_mesh(ScenarioConfig { peers: 100, events: 500, seed: 42 }).unwrap();
    assert!(summary.converged);
    assert_eq!(summary.peers, 100);
    assert_eq!(summary.events, 500);
    assert!(summary.rounds > 1);
    assert_eq!(summary.rejected_packs, 0);
}

#[test]
fn corrupted_pack_is_rejected_and_clean_retry_converges() {
    let summary = run_corrupt_pack(77).unwrap();
    assert!(summary.converged);
    assert_eq!(summary.rejected_packs, 1);
    assert_ne!(summary.final_event_digest, "");
}
```

- [ ] **Step 2: Run scenario tests and verify RED**

Run:

```bash
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --features test-support --test mesh_convergence -- --nocapture
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --features test-support --test lab_scenarios -- --nocapture
```

Expected: FAIL because fault plans, seeded scenarios, and the CLI do not exist.

- [ ] **Step 3: Implement seeded schedules and a JSON-only CLI**

Avoid a random-number dependency by using this fixed scheduler:

```rust
fn next_u64(state: &mut u64) -> u64 {
    *state ^= *state << 13;
    *state ^= *state >> 7;
    *state ^= *state << 17;
    *state
}
```

`run_mesh` creates isolated temporary repositories, grants every peer, partitions
them into deterministic groups, appends exactly `events` opaque data atoms, and
then gives each peer two seeded pull partners per round until a full round
advances zero refs. It fails after 200 rounds. Convergence means every active
replica has the same sorted event IDs and SHA-256 digest.

`PackFault::DropAfter` truncates one response and returns a transport I/O error;
`FlipByte` mutates one response and exercises quarantine. The next call has
`PackFault::None` and must converge without manual cleanup.

`sync-lab` accepts only these forms and exits 2 for any other input:

```text
sync-lab mesh --peers <1..100> --events <0..10000> --seed <u64>
sync-lab revocation --seed <u64>
sync-lab corrupt-pack --seed <u64>
```

Add the binary target in `Cargo.toml` in this task:

```toml
[[bin]]
name = "sync-lab"
path = "src/bin/sync-lab.rs"
required-features = ["test-support"]
```

It prints exactly one `serde_json` line containing `ScenarioSummary`; progress
goes to stderr. The binary calls the three library scenario functions and has no
Tauri or network dependency.

- [ ] **Step 4: Run tests and exercise the standalone lab**

Run:

```bash
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --all-features
cargo run --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --features test-support --bin sync-lab -- mesh --peers 20 --events 200 --seed 42
cargo run --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --features test-support --bin sync-lab -- revocation --seed 42
cargo run --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --features test-support --bin sync-lab -- corrupt-pack --seed 42
```

Expected: all tests pass; each CLI command emits one JSON object with
`"converged":true`; revocation reports one revoked peer and corruption reports
one rejected pack.

- [ ] **Step 5: Commit the lab and convergence suite**

```bash
git add src-tauri/crates/yonalist-sync/src src-tauri/crates/yonalist-sync/tests
git commit -m "test(sync): add deterministic standalone lab"
```

### Task 8: Expose the independent test commands in npm, CI, and README

**Files:**
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`
- Test: `src-tauri/crates/yonalist-sync/Cargo.toml`

**Interfaces:**
- Consumes: Task 7 test and lab commands.
- Produces two user-facing commands:

```text
npm run test:sync
npm run sync:lab -- mesh --peers 20 --events 200 --seed 42
```

- [ ] **Step 1: Add a failing script-contract test**

Create `src-tauri/crates/yonalist-sync/tests/repository_contract.rs` with:

```rust
#[test]
fn repository_exposes_standalone_sync_commands() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let package: serde_json::Value = serde_json::from_slice(&std::fs::read(root.join("package.json")).unwrap()).unwrap();
    assert_eq!(package["scripts"]["test:sync"], "cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --all-features");
    assert_eq!(package["scripts"]["sync:lab"], "cargo run --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --features test-support --bin sync-lab --");
    let readme = std::fs::read_to_string(root.join("README.md")).unwrap();
    assert!(readme.contains("## Standalone distributed sync lab"));
}
```

- [ ] **Step 2: Run the repository-contract test and verify RED**

Run:

```bash
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --test repository_contract
```

Expected: FAIL because the npm scripts and README section do not exist.

- [ ] **Step 3: Add scripts, CI, and concise operator documentation**

Add these scripts to `package.json`:

```json
"test:sync": "cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --all-features",
"sync:lab": "cargo run --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --features test-support --bin sync-lab --"
```

In the existing Rust CI job, add before the Tauri Rust tests:

```yaml
      - name: Standalone sync core tests
        run: cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --all-features
```

Add a README section named `Standalone distributed sync lab` that documents the
two npm commands, the three scenarios, the JSON success fields, Git 2.49+ as the
development prerequisite, and this explicit boundary: the lab proves opaque
atom/ref convergence and revocation gating, not issue projection, real network
connectivity, attachment replication, or UI behavior.

- [ ] **Step 4: Run independent and repository regressions**

Run:

```bash
npm run test:sync
npm run sync:lab -- mesh --peers 20 --events 200 --seed 42
cargo test --manifest-path src-tauri/Cargo.toml
npm test
npm run build
```

Expected: all five commands exit 0. The lab emits one JSON result with
`"converged":true`. Existing Tauri Rust, frontend unit tests, and production
build remain green.

- [ ] **Step 5: Commit the independently testable surface**

```bash
git add package.json .github/workflows/ci.yml README.md src-tauri/crates/yonalist-sync/tests/repository_contract.rs
git commit -m "docs(sync): expose standalone test lab"
```

## Final Verification Gate

After Task 8, run the complete evidence set from a clean process:

```bash
git status --short
git diff --check HEAD~8..HEAD
npm run test:sync
npm run sync:lab -- mesh --peers 100 --events 500 --seed 42
npm run sync:lab -- revocation --seed 42
npm run sync:lab -- corrupt-pack --seed 42
cargo test --manifest-path src-tauri/Cargo.toml
npm test
npm run build
```

Expected:

- `git diff --check` reports no whitespace errors;
- standalone sync tests have zero failures;
- all three lab scenarios report `"converged":true`;
- revocation reports one revoked peer and no post-revocation data transfer;
- corrupt-pack reports one rejection and successful clean retry;
- existing Rust and frontend tests have zero failures;
- the production build exits 0; and
- `git status --short` shows only pre-existing user changes, if any, and no
  uncommitted files from this plan.

Do not claim issue-level conflict merge, attachment replication, real network
operation, or web availability from this verification. Those capabilities are
outside this plan's executable scope.

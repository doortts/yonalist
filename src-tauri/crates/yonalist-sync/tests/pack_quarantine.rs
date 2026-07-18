#![cfg(feature = "test-support")]

use std::{
    collections::BTreeMap,
    env,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{mpsc, Arc, Condvar, Mutex},
    thread,
    time::Duration,
};

use yonalist_sync::{
    AccessDecision, AccessState, AtomLimits, CandidateRef, DeviceId, DeviceSigner, EventId, GitOid,
    GitStore, GrantId, ImportOutcome, MemberId, PackLimits, PackRequest, Plane, ProjectId,
    ProjectPolicy, RefAdvertisement, Replica, ReplicaConfig, SignedAtom, StoreBatch, StoredAtom,
    UnsignedAtom, ATOM_SCHEMA_V1,
};

fn git() -> PathBuf {
    env::var_os("YONALIST_TEST_GIT")
        .map(PathBuf::from)
        .unwrap_or_else(|| "git".into())
}

fn atom(payload: &[u8], event: u8) -> SignedAtom {
    atom_for(payload, event, 3, Plane::Data)
}

fn atom_for(payload: &[u8], event: u8, device: u8, plane: Plane) -> SignedAtom {
    atom_with_frontiers(
        payload,
        event,
        device,
        plane,
        ProjectId::from_bytes([1; 16]),
        vec![],
        vec![],
    )
}

fn atom_with_frontiers(
    payload: &[u8],
    event: u8,
    device: u8,
    plane: Plane,
    project_id: ProjectId,
    control_frontier: Vec<GitOid>,
    data_frontier: Vec<GitOid>,
) -> SignedAtom {
    DeviceSigner::from_secret_bytes([9; 32])
        .sign(UnsignedAtom {
            schema: ATOM_SCHEMA_V1,
            project_id,
            event_id: EventId::from_bytes([event; 16]),
            plane,
            actor_member_id: yonalist_sync::MemberId::from_bytes([2; 16]),
            actor_device_id: DeviceId::from_bytes([device; 16]),
            membership_grant_id: yonalist_sync::GrantId::from_bytes([4; 16]),
            control_frontier,
            data_frontier,
            display_time_ms: 0,
            payload: payload.to_vec(),
        })
        .unwrap()
}

fn run_git(repo: &Path, args: &[&str], input: Option<&[u8]>) -> Vec<u8> {
    let mut command = Command::new(git());
    command
        .arg(format!("--git-dir={}", repo.display()))
        .args(args)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().unwrap();
    if let Some(input) = input {
        child.stdin.as_mut().unwrap().write_all(input).unwrap();
    }
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "git failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    output.stdout
}

fn oid(bytes: Vec<u8>) -> GitOid {
    GitOid::parse(String::from_utf8(bytes).unwrap().trim()).unwrap()
}

fn raw_commit(
    repo: &Path,
    parent: Option<&GitOid>,
    extra_parents: &[GitOid],
    files: &BTreeMap<String, Vec<u8>>,
) -> GitOid {
    let mut tree_input = Vec::new();
    for (path, bytes) in files {
        let blob = oid(run_git(
            repo,
            &["hash-object", "-w", "--stdin"],
            Some(bytes),
        ));
        tree_input.extend_from_slice(format!("100644 {}\t{}\0", blob.as_str(), path).as_bytes());
    }
    let index_dir = tempfile::tempdir().unwrap();
    let index = index_dir.path().join("index");
    let mut update = Command::new(git());
    update
        .arg(format!("--git-dir={}", repo.display()))
        .args(["update-index", "-z", "--index-info"])
        .env("GIT_INDEX_FILE", &index)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = update.spawn().unwrap();
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(&tree_input)
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "git failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let output = Command::new(git())
        .arg(format!("--git-dir={}", repo.display()))
        .args(["write-tree"])
        .env("GIT_INDEX_FILE", &index)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let tree = oid(output.stdout);
    let mut owned = vec!["commit-tree".to_string(), tree.as_str().to_string()];
    for p in parent.into_iter().chain(extra_parents) {
        owned.push("-p".into());
        owned.push(p.as_str().into());
    }
    let refs = owned.iter().map(String::as_str).collect::<Vec<_>>();
    oid(run_git(repo, &refs, Some(b"test\n")))
}

fn raw_commit_with_parents(
    repo: &Path,
    parents: &[GitOid],
    files: &BTreeMap<String, Vec<u8>>,
) -> GitOid {
    let (first, rest) = parents
        .split_first()
        .map_or((None, &[][..]), |(first, rest)| (Some(first), rest));
    raw_commit(repo, first, rest, files)
}

fn raw_empty_atom_subtree_commit(repo: &Path, device: DeviceId) -> GitOid {
    let empty = oid(run_git(repo, &["mktree", "-z"], Some(b"")));
    let shard = oid(run_git(
        repo,
        &["mktree", "-z"],
        Some(format!("040000 tree {}\t01\0", empty.as_str()).as_bytes()),
    ));
    let root = oid(run_git(
        repo,
        &["mktree", "-z"],
        Some(format!("040000 tree {}\tdata-atoms\0", shard.as_str()).as_bytes()),
    ));
    let commit = oid(run_git(
        repo,
        &["commit-tree", root.as_str()],
        Some(b"empty subtree\n"),
    ));
    set_ref(repo, Plane::Data, device, &commit);
    commit
}

fn set_ref(repo: &Path, plane: Plane, device: DeviceId, head: &GitOid) {
    run_git(
        repo,
        &[
            "update-ref",
            &format!("{}{}", plane.ref_prefix(), device),
            head.as_str(),
        ],
        None,
    );
}

fn pull(
    source: &GitStore,
    receiver: &GitStore,
    plane: Plane,
    atom_limits: &AtomLimits,
    pack_limits: &PackLimits,
    policy: &impl ProjectPolicy<State = ()>,
) -> ImportOutcome {
    let advertised = source.advertise(plane).unwrap();
    let pack = source
        .create_pack(
            &PackRequest {
                plane,
                wants: advertised.refs.values().cloned().collect(),
                haves: vec![],
            },
            pack_limits,
        )
        .unwrap();
    receiver
        .import_pack(
            ProjectId::from_bytes([1; 16]),
            plane,
            &advertised,
            pack,
            atom_limits,
            pack_limits,
            policy,
        )
        .unwrap()
}

fn limits() -> (AtomLimits, PackLimits) {
    (
        AtomLimits {
            max_payload_bytes: 1024,
            max_frontier_heads: 8,
        },
        PackLimits {
            max_pack_bytes: 1 << 20,
            max_advertised_refs: 8,
            max_atoms_per_head: 8,
        },
    )
}

struct Allow;
fn verify_fixture(atom: &StoredAtom) -> Result<(), yonalist_sync::SyncError> {
    atom.atom
        .verify(&DeviceSigner::from_secret_bytes([9; 32]).public_key())
}
impl ProjectPolicy for Allow {
    type State = ();
    fn rebuild_control(&self, _: &[StoredAtom]) -> Result<(), yonalist_sync::SyncError> {
        Ok(())
    }
    fn advance_control(
        &self,
        _: &(),
        atoms: &[StoredAtom],
    ) -> Result<(), yonalist_sync::SyncError> {
        for atom in atoms {
            self.validate_control(&(), atom)?;
        }
        Ok(())
    }
    fn validate_control(&self, _: &(), atom: &StoredAtom) -> Result<(), yonalist_sync::SyncError> {
        verify_fixture(atom)
    }
    fn validate_data(&self, _: &(), atom: &StoredAtom) -> Result<(), yonalist_sync::SyncError> {
        verify_fixture(atom)
    }
    fn peer_access(
        &self,
        _: &(),
        _: yonalist_sync::MemberId,
        _: yonalist_sync::DeviceId,
        _: yonalist_sync::GrantId,
    ) -> AccessDecision {
        AccessDecision::Allowed
    }
    fn local_access(
        &self,
        _: &(),
        _: yonalist_sync::MemberId,
        _: yonalist_sync::DeviceId,
        _: yonalist_sync::GrantId,
    ) -> AccessState {
        AccessState::Active
    }
}

struct RejectPayload;
impl ProjectPolicy for RejectPayload {
    type State = ();
    fn rebuild_control(&self, _: &[StoredAtom]) -> Result<(), yonalist_sync::SyncError> {
        Ok(())
    }
    fn advance_control(
        &self,
        _: &(),
        atoms: &[StoredAtom],
    ) -> Result<(), yonalist_sync::SyncError> {
        for atom in atoms {
            self.validate_control(&(), atom)?;
        }
        Ok(())
    }
    fn validate_control(&self, _: &(), atom: &StoredAtom) -> Result<(), yonalist_sync::SyncError> {
        verify_fixture(atom)
    }
    fn validate_data(&self, _: &(), atom: &StoredAtom) -> Result<(), yonalist_sync::SyncError> {
        verify_fixture(atom)?;
        if atom.atom.unsigned.payload == b"policy.reject" {
            Err(yonalist_sync::SyncError {
                code: yonalist_sync::SyncErrorCode::PolicyRejected,
                message: "rejected fixture".into(),
            })
        } else {
            Ok(())
        }
    }
    fn peer_access(
        &self,
        _: &(),
        _: yonalist_sync::MemberId,
        _: yonalist_sync::DeviceId,
        _: yonalist_sync::GrantId,
    ) -> AccessDecision {
        AccessDecision::Allowed
    }
    fn local_access(
        &self,
        _: &(),
        _: yonalist_sync::MemberId,
        _: yonalist_sync::DeviceId,
        _: yonalist_sync::GrantId,
    ) -> AccessState {
        AccessState::Active
    }
}

struct CutPolicy;
impl ProjectPolicy for CutPolicy {
    type State = bool;

    fn rebuild_control(&self, atoms: &[StoredAtom]) -> Result<bool, yonalist_sync::SyncError> {
        let mut state = false;
        for commit in atoms.chunk_by(|a, b| a.containing_commit == b.containing_commit) {
            state = self.advance_control(&state, commit)?;
        }
        Ok(state)
    }

    fn advance_control(
        &self,
        state: &bool,
        atoms: &[StoredAtom],
    ) -> Result<bool, yonalist_sync::SyncError> {
        for atom in atoms {
            self.validate_control(state, atom)?;
        }
        Ok(atoms.iter().fold(*state, |current, atom| {
            match atom.atom.unsigned.payload.as_slice() {
                b"grant" => true,
                b"revoke" => false,
                _ => current,
            }
        }))
    }

    fn validate_control(
        &self,
        _: &bool,
        atom: &StoredAtom,
    ) -> Result<(), yonalist_sync::SyncError> {
        verify_fixture(atom)
    }

    fn validate_data(
        &self,
        active: &bool,
        atom: &StoredAtom,
    ) -> Result<(), yonalist_sync::SyncError> {
        verify_fixture(atom)?;
        if *active {
            Ok(())
        } else {
            Err(yonalist_sync::SyncError {
                code: yonalist_sync::SyncErrorCode::PolicyRejected,
                message: "data cut is revoked".into(),
            })
        }
    }

    fn peer_access(&self, _: &bool, _: MemberId, _: DeviceId, _: GrantId) -> AccessDecision {
        AccessDecision::Allowed
    }

    fn local_access(&self, _: &bool, _: MemberId, _: DeviceId, _: GrantId) -> AccessState {
        AccessState::Active
    }
}

#[derive(Clone)]
struct ValidationGate(Arc<(Mutex<GateState>, Condvar)>);

#[derive(Default)]
struct GateState {
    entered: bool,
    released: bool,
}

impl ValidationGate {
    fn new() -> Self {
        Self(Arc::new((Mutex::new(GateState::default()), Condvar::new())))
    }

    fn block_once(&self) {
        let (lock, wake) = &*self.0;
        let mut state = lock.lock().unwrap();
        if state.entered {
            return;
        }
        state.entered = true;
        wake.notify_all();
        let (state, timeout) = wake
            .wait_timeout_while(state, Duration::from_secs(3), |state| !state.released)
            .unwrap();
        assert!(
            state.released,
            "validation gate watchdog expired: {timeout:?}"
        );
    }

    fn wait_until_entered(&self) {
        let (lock, wake) = &*self.0;
        let state = lock.lock().unwrap();
        let (state, timeout) = wake
            .wait_timeout_while(state, Duration::from_secs(3), |state| !state.entered)
            .unwrap();
        assert!(state.entered, "validation did not reach gate: {timeout:?}");
    }

    fn release(&self) {
        let (lock, wake) = &*self.0;
        lock.lock().unwrap().released = true;
        wake.notify_all();
    }
}

#[derive(Clone)]
struct BlockingAllow(ValidationGate);

impl ProjectPolicy for BlockingAllow {
    type State = ();

    fn rebuild_control(&self, _: &[StoredAtom]) -> Result<(), yonalist_sync::SyncError> {
        Ok(())
    }

    fn advance_control(
        &self,
        _: &(),
        atoms: &[StoredAtom],
    ) -> Result<(), yonalist_sync::SyncError> {
        for atom in atoms {
            self.validate_control(&(), atom)?;
        }
        Ok(())
    }

    fn validate_control(&self, _: &(), atom: &StoredAtom) -> Result<(), yonalist_sync::SyncError> {
        verify_fixture(atom)
    }

    fn validate_data(&self, _: &(), atom: &StoredAtom) -> Result<(), yonalist_sync::SyncError> {
        self.0.block_once();
        verify_fixture(atom)
    }

    fn peer_access(&self, _: &(), _: MemberId, _: DeviceId, _: GrantId) -> AccessDecision {
        AccessDecision::Allowed
    }

    fn local_access(&self, _: &(), _: MemberId, _: DeviceId, _: GrantId) -> AccessState {
        AccessState::Active
    }
}

#[derive(Clone)]
struct BlockingCutPolicy(ValidationGate);

impl ProjectPolicy for BlockingCutPolicy {
    type State = bool;

    fn rebuild_control(&self, atoms: &[StoredAtom]) -> Result<bool, yonalist_sync::SyncError> {
        CutPolicy.rebuild_control(atoms)
    }

    fn advance_control(
        &self,
        state: &bool,
        atoms: &[StoredAtom],
    ) -> Result<bool, yonalist_sync::SyncError> {
        CutPolicy.advance_control(state, atoms)
    }

    fn validate_control(
        &self,
        state: &bool,
        atom: &StoredAtom,
    ) -> Result<(), yonalist_sync::SyncError> {
        CutPolicy.validate_control(state, atom)
    }

    fn validate_data(
        &self,
        active: &bool,
        atom: &StoredAtom,
    ) -> Result<(), yonalist_sync::SyncError> {
        self.0.block_once();
        CutPolicy.validate_data(active, atom)
    }

    fn peer_access(&self, state: &bool, m: MemberId, d: DeviceId, g: GrantId) -> AccessDecision {
        CutPolicy.peer_access(state, m, d, g)
    }

    fn local_access(&self, state: &bool, m: MemberId, d: DeviceId, g: GrantId) -> AccessState {
        CutPolicy.local_access(state, m, d, g)
    }
}

#[derive(Clone)]
struct SignalingCutPolicy(mpsc::Sender<()>);

impl ProjectPolicy for SignalingCutPolicy {
    type State = bool;

    fn rebuild_control(&self, atoms: &[StoredAtom]) -> Result<bool, yonalist_sync::SyncError> {
        let mut state = false;
        for commit in atoms.chunk_by(|a, b| a.containing_commit == b.containing_commit) {
            state = self.advance_control(&state, commit)?;
        }
        Ok(state)
    }

    fn advance_control(
        &self,
        state: &bool,
        atoms: &[StoredAtom],
    ) -> Result<bool, yonalist_sync::SyncError> {
        for atom in atoms {
            self.validate_control(state, atom)?;
        }
        CutPolicy.advance_control(state, atoms)
    }

    fn validate_control(
        &self,
        state: &bool,
        atom: &StoredAtom,
    ) -> Result<(), yonalist_sync::SyncError> {
        if atom.atom.unsigned.payload == b"revoke" {
            self.0.send(()).unwrap();
        }
        CutPolicy.validate_control(state, atom)
    }

    fn validate_data(
        &self,
        state: &bool,
        atom: &StoredAtom,
    ) -> Result<(), yonalist_sync::SyncError> {
        CutPolicy.validate_data(state, atom)
    }

    fn peer_access(&self, state: &bool, m: MemberId, d: DeviceId, g: GrantId) -> AccessDecision {
        CutPolicy.peer_access(state, m, d, g)
    }

    fn local_access(&self, state: &bool, m: MemberId, d: DeviceId, g: GrantId) -> AccessState {
        CutPolicy.local_access(state, m, d, g)
    }
}

struct EnableBeforeDependent;
impl ProjectPolicy for EnableBeforeDependent {
    type State = bool;
    fn rebuild_control(&self, atoms: &[StoredAtom]) -> Result<bool, yonalist_sync::SyncError> {
        let mut state = false;
        for commit in atoms.chunk_by(|a, b| a.containing_commit == b.containing_commit) {
            state = self.advance_control(&state, commit)?;
        }
        Ok(state)
    }
    fn advance_control(
        &self,
        state: &bool,
        atoms: &[StoredAtom],
    ) -> Result<bool, yonalist_sync::SyncError> {
        for atom in atoms {
            self.validate_control(state, atom)?;
        }
        Ok(*state
            || atoms
                .iter()
                .any(|atom| atom.atom.unsigned.payload == b"enable"))
    }
    fn validate_control(
        &self,
        state: &bool,
        atom: &StoredAtom,
    ) -> Result<(), yonalist_sync::SyncError> {
        verify_fixture(atom)?;
        if atom.atom.unsigned.payload == b"dependent" && !state {
            Err(yonalist_sync::SyncError {
                code: yonalist_sync::SyncErrorCode::PolicyRejected,
                message: "dependent transition requires enable".into(),
            })
        } else {
            Ok(())
        }
    }
    fn validate_data(&self, _: &bool, atom: &StoredAtom) -> Result<(), yonalist_sync::SyncError> {
        verify_fixture(atom)
    }
    fn peer_access(&self, _: &bool, _: MemberId, _: DeviceId, _: GrantId) -> AccessDecision {
        AccessDecision::Allowed
    }
    fn local_access(&self, _: &bool, _: MemberId, _: DeviceId, _: GrantId) -> AccessState {
        AccessState::Active
    }
}

#[derive(Clone)]
struct RecordIncomingBeforeTrusted(Arc<Mutex<Vec<(String, GitOid, Vec<u8>)>>>);
impl ProjectPolicy for RecordIncomingBeforeTrusted {
    type State = u8;
    fn rebuild_control(&self, atoms: &[StoredAtom]) -> Result<u8, yonalist_sync::SyncError> {
        let mut state = 0;
        for commit in atoms.chunk_by(|a, b| a.containing_commit == b.containing_commit) {
            state = self.advance_control(&state, commit)?;
        }
        Ok(state)
    }
    fn advance_control(
        &self,
        state: &u8,
        atoms: &[StoredAtom],
    ) -> Result<u8, yonalist_sync::SyncError> {
        for atom in atoms {
            self.validate_control(state, atom)?;
        }
        self.0.lock().unwrap().extend(atoms.iter().map(|atom| {
            (
                atom.path.clone(),
                atom.containing_commit.clone(),
                atom.atom.unsigned.payload.clone(),
            )
        }));
        Ok(
            if atoms
                .iter()
                .any(|atom| atom.atom.unsigned.payload == b"enable")
            {
                2
            } else if *state == 0
                && atoms
                    .iter()
                    .any(|atom| atom.atom.unsigned.payload == b"dependent")
            {
                1
            } else {
                *state
            },
        )
    }
    fn validate_control(
        &self,
        state: &u8,
        atom: &StoredAtom,
    ) -> Result<(), yonalist_sync::SyncError> {
        verify_fixture(atom)?;
        if atom.atom.unsigned.payload == b"enable" && *state == 1 {
            Err(yonalist_sync::SyncError {
                code: yonalist_sync::SyncErrorCode::PolicyRejected,
                message: "trusted enable cannot follow an unmet dependency".into(),
            })
        } else {
            Ok(())
        }
    }
    fn validate_data(&self, _: &u8, atom: &StoredAtom) -> Result<(), yonalist_sync::SyncError> {
        verify_fixture(atom)
    }
    fn peer_access(&self, _: &u8, _: MemberId, _: DeviceId, _: GrantId) -> AccessDecision {
        AccessDecision::Allowed
    }
    fn local_access(&self, _: &u8, _: MemberId, _: DeviceId, _: GrantId) -> AccessState {
        AccessState::Active
    }
}

#[derive(Clone)]
struct RecordControlBoundaries(Arc<Mutex<Vec<Vec<GitOid>>>>);
impl ProjectPolicy for RecordControlBoundaries {
    type State = ();
    fn rebuild_control(&self, _: &[StoredAtom]) -> Result<(), yonalist_sync::SyncError> {
        Ok(())
    }
    fn advance_control(
        &self,
        _: &(),
        atoms: &[StoredAtom],
    ) -> Result<(), yonalist_sync::SyncError> {
        self.0.lock().unwrap().push(
            atoms
                .iter()
                .map(|atom| atom.containing_commit.clone())
                .collect(),
        );
        Ok(())
    }
    fn validate_control(&self, _: &(), atom: &StoredAtom) -> Result<(), yonalist_sync::SyncError> {
        verify_fixture(atom)
    }
    fn validate_data(&self, _: &(), atom: &StoredAtom) -> Result<(), yonalist_sync::SyncError> {
        verify_fixture(atom)
    }
    fn peer_access(
        &self,
        _: &(),
        _: yonalist_sync::MemberId,
        _: yonalist_sync::DeviceId,
        _: yonalist_sync::GrantId,
    ) -> AccessDecision {
        AccessDecision::Allowed
    }
    fn local_access(
        &self,
        _: &(),
        _: yonalist_sync::MemberId,
        _: yonalist_sync::DeviceId,
        _: yonalist_sync::GrantId,
    ) -> AccessState {
        AccessState::Active
    }
}

type ReplayBatch = Vec<(String, GitOid, Vec<u8>)>;

#[derive(Clone)]
struct RecordReplayAttempts(Arc<Mutex<Vec<Vec<ReplayBatch>>>>);

impl ProjectPolicy for RecordReplayAttempts {
    type State = usize;

    fn rebuild_control(&self, _: &[StoredAtom]) -> Result<usize, yonalist_sync::SyncError> {
        Ok(0)
    }

    fn advance_control(
        &self,
        state: &usize,
        atoms: &[StoredAtom],
    ) -> Result<usize, yonalist_sync::SyncError> {
        let mut attempts = self.0.lock().unwrap();
        if *state == 0 {
            attempts.push(vec![]);
        }
        attempts.last_mut().unwrap().push(
            atoms
                .iter()
                .map(|atom| {
                    (
                        atom.path.clone(),
                        atom.containing_commit.clone(),
                        atom.atom.unsigned.payload.clone(),
                    )
                })
                .collect(),
        );
        Ok(*state + 1)
    }

    fn validate_control(
        &self,
        _: &usize,
        atom: &StoredAtom,
    ) -> Result<(), yonalist_sync::SyncError> {
        verify_fixture(atom)?;
        if atom.atom.unsigned.payload == b"reject" {
            Err(yonalist_sync::SyncError {
                code: yonalist_sync::SyncErrorCode::PolicyRejected,
                message: "rejected fixture".into(),
            })
        } else {
            Ok(())
        }
    }

    fn validate_data(&self, _: &usize, atom: &StoredAtom) -> Result<(), yonalist_sync::SyncError> {
        verify_fixture(atom)
    }

    fn peer_access(&self, _: &usize, _: MemberId, _: DeviceId, _: GrantId) -> AccessDecision {
        AccessDecision::Allowed
    }

    fn local_access(&self, _: &usize, _: MemberId, _: DeviceId, _: GrantId) -> AccessState {
        AccessState::Active
    }
}

#[test]
fn foreign_project_atom_never_advances_a_ref() {
    let source_dir = tempfile::tempdir().unwrap();
    let receiver_dir = tempfile::tempdir().unwrap();
    let source = GitStore::init(source_dir.path(), &git()).unwrap();
    let receiver = GitStore::init(receiver_dir.path(), &git()).unwrap();
    let foreign = atom_with_frontiers(
        b"foreign",
        6,
        3,
        Plane::Data,
        ProjectId::from_bytes([99; 16]),
        vec![],
        vec![],
    );
    let device = foreign.unsigned.actor_device_id;
    source
        .append_local(StoreBatch {
            plane: Plane::Data,
            device_id: device,
            expected_head: None,
            atoms: vec![foreign],
            auxiliary_files: vec![],
            observed_heads: vec![],
        })
        .unwrap();
    let before_control = receiver.advertise(Plane::Control).unwrap();
    let before_data = receiver.advertise(Plane::Data).unwrap();
    let (atom_limits, pack_limits) = limits();
    let _outcome = pull(
        &source,
        &receiver,
        Plane::Data,
        &atom_limits,
        &pack_limits,
        &Allow,
    );
    assert_eq!(
        receiver.advertise(Plane::Control).unwrap().refs,
        before_control.refs
    );
    assert_eq!(
        receiver.advertise(Plane::Data).unwrap().refs,
        before_data.refs
    );
}

#[test]
fn control_atom_frontier_must_equal_reduced_commit_parents() {
    let source_dir = tempfile::tempdir().unwrap();
    let receiver_dir = tempfile::tempdir().unwrap();
    let source = GitStore::init(source_dir.path(), &git()).unwrap();
    let receiver = GitStore::init(receiver_dir.path(), &git()).unwrap();
    let left_atom = atom_for(b"left", 10, 1, Plane::Control);
    let right_atom = atom_for(b"right", 11, 2, Plane::Control);
    let left = raw_commit_with_parents(
        source_dir.path(),
        &[],
        &BTreeMap::from([(
            left_atom.repo_path(),
            left_atom.encode(&limits().0).unwrap(),
        )]),
    );
    let right = raw_commit_with_parents(
        source_dir.path(),
        &[],
        &BTreeMap::from([(
            right_atom.repo_path(),
            right_atom.encode(&limits().0).unwrap(),
        )]),
    );
    let merge_atom = atom_with_frontiers(
        b"merge",
        12,
        3,
        Plane::Control,
        ProjectId::from_bytes([1; 16]),
        vec![left.clone()],
        vec![],
    );
    let files = [left_atom, right_atom, merge_atom]
        .into_iter()
        .map(|atom| (atom.repo_path(), atom.encode(&limits().0).unwrap()))
        .collect();
    let merge = raw_commit_with_parents(source_dir.path(), &[left, right], &files);
    let device = DeviceId::from_bytes([3; 16]);
    set_ref(source_dir.path(), Plane::Control, device, &merge);
    let (atom_limits, pack_limits) = limits();
    let _outcome = pull(
        &source,
        &receiver,
        Plane::Control,
        &atom_limits,
        &pack_limits,
        &Allow,
    );
    assert_eq!(receiver.head(Plane::Control, device).unwrap(), None);
}

#[test]
fn forged_frontier_is_rejected_without_ref_movement() {
    let source_dir = tempfile::tempdir().unwrap();
    let receiver_dir = tempfile::tempdir().unwrap();
    let source = GitStore::init(source_dir.path(), &git()).unwrap();
    let receiver = GitStore::init(receiver_dir.path(), &git()).unwrap();
    let forged = GitOid::parse(&"f".repeat(64)).unwrap();
    let signed = atom_with_frontiers(
        b"forged",
        13,
        3,
        Plane::Data,
        ProjectId::from_bytes([1; 16]),
        vec![forged],
        vec![],
    );
    let device = signed.unsigned.actor_device_id;
    source
        .append_local(StoreBatch {
            plane: Plane::Data,
            device_id: device,
            expected_head: None,
            atoms: vec![signed],
            auxiliary_files: vec![],
            observed_heads: vec![],
        })
        .unwrap();
    let (atom_limits, pack_limits) = limits();
    let _outcome = pull(
        &source,
        &receiver,
        Plane::Data,
        &atom_limits,
        &pack_limits,
        &Allow,
    );
    assert_eq!(receiver.head(Plane::Data, device).unwrap(), None);
}

#[test]
fn data_atom_frontiers_must_be_reachable_and_reduced() {
    let source_dir = tempfile::tempdir().unwrap();
    let receiver_dir = tempfile::tempdir().unwrap();
    let source = GitStore::init(source_dir.path(), &git()).unwrap();
    let receiver = GitStore::init(receiver_dir.path(), &git()).unwrap();
    let control_device = DeviceId::from_bytes([1; 16]);
    let first_control_atom = atom_for(b"grant", 14, 1, Plane::Control);
    let first_control = source
        .append_local(StoreBatch {
            plane: Plane::Control,
            device_id: control_device,
            expected_head: None,
            atoms: vec![first_control_atom],
            auxiliary_files: vec![],
            observed_heads: vec![],
        })
        .unwrap();
    let second_control_atom = atom_with_frontiers(
        b"control-2",
        15,
        1,
        Plane::Control,
        ProjectId::from_bytes([1; 16]),
        vec![first_control.head.clone()],
        vec![],
    );
    let second_control = source
        .append_local(StoreBatch {
            plane: Plane::Control,
            device_id: control_device,
            expected_head: Some(first_control.head.clone()),
            atoms: vec![second_control_atom],
            auxiliary_files: vec![],
            observed_heads: vec![],
        })
        .unwrap();
    let (atom_limits, pack_limits) = limits();
    let _controls = pull(
        &source,
        &receiver,
        Plane::Control,
        &atom_limits,
        &pack_limits,
        &Allow,
    );

    let data_device = DeviceId::from_bytes([3; 16]);
    let redundant_cut = atom_with_frontiers(
        b"redundant-control-cut",
        16,
        3,
        Plane::Data,
        ProjectId::from_bytes([1; 16]),
        vec![first_control.head.clone(), second_control.head.clone()],
        vec![],
    );
    source
        .append_local(StoreBatch {
            plane: Plane::Data,
            device_id: data_device,
            expected_head: None,
            atoms: vec![redundant_cut],
            auxiliary_files: vec![],
            observed_heads: vec![],
        })
        .unwrap();
    let valid_device = DeviceId::from_bytes([5; 16]);
    let valid_data = atom_with_frontiers(
        b"valid-data-parent",
        17,
        5,
        Plane::Data,
        ProjectId::from_bytes([1; 16]),
        vec![second_control.head.clone()],
        vec![],
    );
    let valid_parent = source
        .append_local(StoreBatch {
            plane: Plane::Data,
            device_id: valid_device,
            expected_head: None,
            atoms: vec![valid_data],
            auxiliary_files: vec![],
            observed_heads: vec![],
        })
        .unwrap();
    let wrong_device = DeviceId::from_bytes([4; 16]);
    let wrong_data_cut = atom_with_frontiers(
        b"wrong-data-cut",
        22,
        4,
        Plane::Data,
        ProjectId::from_bytes([1; 16]),
        vec![second_control.head],
        vec![valid_parent.head.clone()],
    );
    let wrong_head = raw_commit_with_parents(
        source_dir.path(),
        &[],
        &BTreeMap::from([(
            wrong_data_cut.repo_path(),
            wrong_data_cut.encode(&atom_limits).unwrap(),
        )]),
    );
    set_ref(source_dir.path(), Plane::Data, wrong_device, &wrong_head);
    let outcome = pull(
        &source,
        &receiver,
        Plane::Data,
        &atom_limits,
        &pack_limits,
        &Allow,
    );
    assert_eq!(receiver.head(Plane::Data, data_device).unwrap(), None);
    assert_eq!(receiver.head(Plane::Data, wrong_device).unwrap(), None);
    assert_eq!(
        receiver.head(Plane::Data, valid_device).unwrap(),
        Some(valid_parent.head)
    );
    assert!(outcome
        .rejected()
        .contains(&(data_device, yonalist_sync::SyncErrorCode::InvalidAtom)));
    assert!(outcome
        .rejected()
        .contains(&(wrong_device, yonalist_sync::SyncErrorCode::InvalidAtom)));
}

#[test]
fn data_policy_uses_the_declared_control_frontier() {
    let source_dir = tempfile::tempdir().unwrap();
    let receiver_dir = tempfile::tempdir().unwrap();
    let source = GitStore::init(source_dir.path(), &git()).unwrap();
    let receiver = GitStore::init(receiver_dir.path(), &git()).unwrap();
    let control_device = DeviceId::from_bytes([1; 16]);
    let grant = source
        .append_local(StoreBatch {
            plane: Plane::Control,
            device_id: control_device,
            expected_head: None,
            atoms: vec![atom_for(b"grant", 18, 1, Plane::Control)],
            auxiliary_files: vec![],
            observed_heads: vec![],
        })
        .unwrap();
    let revoke_atom = atom_with_frontiers(
        b"revoke",
        19,
        1,
        Plane::Control,
        ProjectId::from_bytes([1; 16]),
        vec![grant.head.clone()],
        vec![],
    );
    let revoke = source
        .append_local(StoreBatch {
            plane: Plane::Control,
            device_id: control_device,
            expected_head: Some(grant.head.clone()),
            atoms: vec![revoke_atom],
            auxiliary_files: vec![],
            observed_heads: vec![],
        })
        .unwrap();
    let (atom_limits, pack_limits) = limits();
    let control_advertised = source.advertise(Plane::Control).unwrap();
    let control_bytes = source
        .create_pack(
            &PackRequest {
                plane: Plane::Control,
                wants: control_advertised.refs.values().cloned().collect(),
                haves: vec![],
            },
            &pack_limits,
        )
        .unwrap();
    let _control_outcome = receiver
        .import_pack(
            ProjectId::from_bytes([1; 16]),
            Plane::Control,
            &control_advertised,
            control_bytes,
            &atom_limits,
            &pack_limits,
            &CutPolicy,
        )
        .unwrap();
    assert!(!CutPolicy
        .rebuild_control(&receiver.stored_atoms(Plane::Control, &atom_limits).unwrap())
        .unwrap());

    let older_device = DeviceId::from_bytes([3; 16]);
    let older_data = atom_with_frontiers(
        b"older-active-cut",
        20,
        3,
        Plane::Data,
        ProjectId::from_bytes([1; 16]),
        vec![grant.head],
        vec![],
    );
    source
        .append_local(StoreBatch {
            plane: Plane::Data,
            device_id: older_device,
            expected_head: None,
            atoms: vec![older_data],
            auxiliary_files: vec![],
            observed_heads: vec![],
        })
        .unwrap();
    let advertised = source.advertise(Plane::Data).unwrap();
    let pack = source
        .create_pack(
            &PackRequest {
                plane: Plane::Data,
                wants: advertised.refs.values().cloned().collect(),
                haves: vec![],
            },
            &pack_limits,
        )
        .unwrap();
    let _outcome = receiver
        .import_pack(
            ProjectId::from_bytes([1; 16]),
            Plane::Data,
            &advertised,
            pack,
            &atom_limits,
            &pack_limits,
            &CutPolicy,
        )
        .unwrap();
    assert!(receiver.head(Plane::Data, older_device).unwrap().is_some());

    let revoked_device = DeviceId::from_bytes([4; 16]);
    let revoked_data = atom_with_frontiers(
        b"revoked-cut",
        21,
        4,
        Plane::Data,
        ProjectId::from_bytes([1; 16]),
        vec![revoke.head],
        vec![],
    );
    source
        .append_local(StoreBatch {
            plane: Plane::Data,
            device_id: revoked_device,
            expected_head: None,
            atoms: vec![revoked_data],
            auxiliary_files: vec![],
            observed_heads: vec![],
        })
        .unwrap();
    let advertised = source.advertise(Plane::Data).unwrap();
    let pack = source
        .create_pack(
            &PackRequest {
                plane: Plane::Data,
                wants: advertised.refs.values().cloned().collect(),
                haves: vec![],
            },
            &pack_limits,
        )
        .unwrap();
    let _outcome = receiver
        .import_pack(
            ProjectId::from_bytes([1; 16]),
            Plane::Data,
            &advertised,
            pack,
            &atom_limits,
            &pack_limits,
            &CutPolicy,
        )
        .unwrap();
    assert_eq!(receiver.head(Plane::Data, revoked_device).unwrap(), None);
}

#[test]
fn control_policy_uses_the_commit_parent_cut() {
    let source_dir = tempfile::tempdir().unwrap();
    let receiver_dir = tempfile::tempdir().unwrap();
    let source = GitStore::init(source_dir.path(), &git()).unwrap();
    let receiver = GitStore::init(receiver_dir.path(), &git()).unwrap();
    let dependent_atom = atom_for(b"dependent", 222, 2, Plane::Control);
    let dependent = raw_commit_with_parents(
        source_dir.path(),
        &[],
        &BTreeMap::from([(
            dependent_atom.repo_path(),
            dependent_atom.encode(&limits().0).unwrap(),
        )]),
    );
    let enable = (0..=u8::MAX)
        .find_map(|event| {
            let enable_atom = atom_for(b"enable", event, 1, Plane::Control);
            let head = raw_commit_with_parents(
                source_dir.path(),
                &[],
                &BTreeMap::from([(
                    enable_atom.repo_path(),
                    enable_atom.encode(&limits().0).unwrap(),
                )]),
            );
            (head < dependent).then_some(head)
        })
        .expect("fixture can order the concurrent enable first");
    let enable_device = DeviceId::from_bytes([1; 16]);
    let dependent_device = DeviceId::from_bytes([2; 16]);
    set_ref(source_dir.path(), Plane::Control, enable_device, &enable);
    set_ref(
        source_dir.path(),
        Plane::Control,
        dependent_device,
        &dependent,
    );
    let (atom_limits, pack_limits) = limits();
    let advertised = source.advertise(Plane::Control).unwrap();
    let pack = source
        .create_pack(
            &PackRequest {
                plane: Plane::Control,
                wants: advertised.refs.values().cloned().collect(),
                haves: vec![],
            },
            &pack_limits,
        )
        .unwrap();
    let _outcome = receiver
        .import_pack(
            ProjectId::from_bytes([1; 16]),
            Plane::Control,
            &advertised,
            pack,
            &atom_limits,
            &pack_limits,
            &EnableBeforeDependent,
        )
        .unwrap();
    assert_eq!(
        receiver.head(Plane::Control, enable_device).unwrap(),
        Some(enable)
    );
    assert_eq!(
        receiver.head(Plane::Control, dependent_device).unwrap(),
        None
    );
}

#[test]
fn corrupt_pack_never_moves_a_trusted_ref() {
    let source_dir = tempfile::tempdir().unwrap();
    let receiver_dir = tempfile::tempdir().unwrap();
    let source = GitStore::init(source_dir.path(), &git()).unwrap();
    let receiver = GitStore::init(receiver_dir.path(), &git()).unwrap();
    let signed = atom(b"ok", 7);
    let device = signed.unsigned.actor_device_id;
    let head = source
        .append_local(StoreBatch {
            plane: Plane::Data,
            device_id: device,
            expected_head: None,
            atoms: vec![signed],
            auxiliary_files: vec![],
            observed_heads: vec![],
        })
        .unwrap()
        .head;
    let (_, pack_limits) = limits();
    let mut pack = source
        .create_pack(
            &PackRequest {
                plane: Plane::Data,
                wants: vec![head],
                haves: vec![],
            },
            &pack_limits,
        )
        .unwrap();
    let middle = pack.0.len() / 2;
    pack.0[middle] ^= 0x80;
    let (atom_limits, pack_limits) = limits();
    let error = receiver
        .import_pack(
            ProjectId::from_bytes([1; 16]),
            Plane::Data,
            &source.advertise(Plane::Data).unwrap(),
            pack,
            &atom_limits,
            &pack_limits,
            &Allow,
        )
        .unwrap_err();
    assert_eq!(error.code, yonalist_sync::SyncErrorCode::PackRejected);
    assert_eq!(receiver.head(Plane::Data, device).unwrap(), None);
    assert!(std::fs::read_dir(receiver_dir.path().join("incoming"))
        .unwrap()
        .next()
        .is_none());
}

#[test]
fn valid_pack_promotes_the_advertised_ref() {
    let source_dir = tempfile::tempdir().unwrap();
    let receiver_dir = tempfile::tempdir().unwrap();
    let source = GitStore::init(source_dir.path(), &git()).unwrap();
    let receiver = GitStore::init(receiver_dir.path(), &git()).unwrap();
    let signed = atom(b"ok", 8);
    let device = signed.unsigned.actor_device_id;
    let head = source
        .append_local(StoreBatch {
            plane: Plane::Data,
            device_id: device,
            expected_head: None,
            atoms: vec![signed],
            auxiliary_files: vec![],
            observed_heads: vec![],
        })
        .unwrap()
        .head;
    let (atom_limits, pack_limits) = limits();
    let pack = source
        .create_pack(
            &PackRequest {
                plane: Plane::Data,
                wants: vec![head.clone()],
                haves: vec![],
            },
            &pack_limits,
        )
        .unwrap();
    let validated = receiver
        .import_pack(
            ProjectId::from_bytes([1; 16]),
            Plane::Data,
            &source.advertise(Plane::Data).unwrap(),
            pack,
            &atom_limits,
            &pack_limits,
            &Allow,
        )
        .unwrap();
    assert_eq!(
        validated.accepted(),
        vec![CandidateRef {
            device_id: device,
            previous: None,
            accepted_head: head.clone(),
            source_advertised_head: head.clone()
        }]
    );
    assert_eq!(receiver.head(Plane::Data, device).unwrap(), Some(head));
}

#[test]
fn validator_promotes_largest_valid_policy_prefix() {
    let source_dir = tempfile::tempdir().unwrap();
    let receiver_dir = tempfile::tempdir().unwrap();
    let source = GitStore::init(source_dir.path(), &git()).unwrap();
    let receiver = GitStore::init(receiver_dir.path(), &git()).unwrap();
    let first_atom = atom(b"ok", 20);
    let device = first_atom.unsigned.actor_device_id;
    let first = source
        .append_local(StoreBatch {
            plane: Plane::Data,
            device_id: device,
            expected_head: None,
            atoms: vec![first_atom],
            auxiliary_files: vec![],
            observed_heads: vec![],
        })
        .unwrap();
    let second = source
        .append_local(StoreBatch {
            plane: Plane::Data,
            device_id: device,
            expected_head: Some(first.head.clone()),
            atoms: vec![atom_with_frontiers(
                b"policy.reject",
                21,
                3,
                Plane::Data,
                ProjectId::from_bytes([1; 16]),
                vec![],
                vec![first.head.clone()],
            )],
            auxiliary_files: vec![],
            observed_heads: vec![],
        })
        .unwrap();
    let (atom_limits, pack_limits) = limits();
    let pack = source
        .create_pack(
            &PackRequest {
                plane: Plane::Data,
                wants: vec![second.head.clone()],
                haves: vec![],
            },
            &pack_limits,
        )
        .unwrap();
    let validated = receiver
        .import_pack(
            ProjectId::from_bytes([1; 16]),
            Plane::Data,
            &source.advertise(Plane::Data).unwrap(),
            pack,
            &atom_limits,
            &pack_limits,
            &RejectPayload,
        )
        .unwrap();
    assert_eq!(validated.accepted()[0].accepted_head, first.head);
    assert_eq!(
        validated.rejected(),
        vec![(device, yonalist_sync::SyncErrorCode::PolicyRejected)]
    );
    assert_eq!(
        receiver.head(Plane::Data, device).unwrap(),
        Some(first.head)
    );
}

#[test]
fn first_invalid_commit_has_no_candidate() {
    let source_dir = tempfile::tempdir().unwrap();
    let receiver_dir = tempfile::tempdir().unwrap();
    let source = GitStore::init(source_dir.path(), &git()).unwrap();
    let receiver = GitStore::init(receiver_dir.path(), &git()).unwrap();
    let signed = atom(b"policy.reject", 30);
    let device = signed.unsigned.actor_device_id;
    source
        .append_local(StoreBatch {
            plane: Plane::Data,
            device_id: device,
            expected_head: None,
            atoms: vec![signed],
            auxiliary_files: vec![],
            observed_heads: vec![],
        })
        .unwrap();
    let (a, p) = limits();
    let validated = pull(&source, &receiver, Plane::Data, &a, &p, &RejectPayload);
    assert!(validated.accepted().is_empty());
    assert_eq!(
        validated.rejected(),
        &[(device, yonalist_sync::SyncErrorCode::PolicyRejected)]
    );
}

#[test]
fn first_invalid_commit_after_trusted_head_has_no_noop_candidate() {
    let source_dir = tempfile::tempdir().unwrap();
    let receiver_dir = tempfile::tempdir().unwrap();
    let source = GitStore::init(source_dir.path(), &git()).unwrap();
    let receiver = GitStore::init(receiver_dir.path(), &git()).unwrap();
    let device = DeviceId::from_bytes([3; 16]);
    let first = source
        .append_local(StoreBatch {
            plane: Plane::Data,
            device_id: device,
            expected_head: None,
            atoms: vec![atom(b"ok", 29)],
            auxiliary_files: vec![],
            observed_heads: vec![],
        })
        .unwrap();
    let (a, p) = limits();
    pull(&source, &receiver, Plane::Data, &a, &p, &Allow);
    source
        .append_local(StoreBatch {
            plane: Plane::Data,
            device_id: device,
            expected_head: Some(first.head.clone()),
            atoms: vec![atom_with_frontiers(
                b"policy.reject",
                30,
                3,
                Plane::Data,
                ProjectId::from_bytes([1; 16]),
                vec![],
                vec![first.head],
            )],
            auxiliary_files: vec![],
            observed_heads: vec![],
        })
        .unwrap();
    let validated = pull(&source, &receiver, Plane::Data, &a, &p, &RejectPayload);
    assert!(!validated.accepted().iter().any(|c| c.device_id == device));
    assert_eq!(
        validated.rejected(),
        &[(device, yonalist_sync::SyncErrorCode::PolicyRejected)]
    );
}

#[test]
fn combined_import_installs_only_the_target_store() {
    let source_dir = tempfile::tempdir().unwrap();
    let receiver_a_dir = tempfile::tempdir().unwrap();
    let receiver_b_dir = tempfile::tempdir().unwrap();
    let source = GitStore::init(source_dir.path(), &git()).unwrap();
    let receiver_a = GitStore::init(receiver_a_dir.path(), &git()).unwrap();
    let receiver_b = GitStore::init(receiver_b_dir.path(), &git()).unwrap();
    let signed = atom(b"bound", 28);
    let device = signed.unsigned.actor_device_id;
    source
        .append_local(StoreBatch {
            plane: Plane::Data,
            device_id: device,
            expected_head: None,
            atoms: vec![signed],
            auxiliary_files: vec![],
            observed_heads: vec![],
        })
        .unwrap();
    let (a, p) = limits();
    let outcome = pull(&source, &receiver_a, Plane::Data, &a, &p, &Allow);
    assert_eq!(outcome.accepted, 1);
    assert!(receiver_a.head(Plane::Data, device).unwrap().is_some());
    assert_eq!(receiver_b.head(Plane::Data, device).unwrap(), None);
}

#[test]
fn empty_tree_nodes_are_not_hidden_from_validation() {
    let source_dir = tempfile::tempdir().unwrap();
    let receiver_dir = tempfile::tempdir().unwrap();
    let source = GitStore::init(source_dir.path(), &git()).unwrap();
    let receiver = GitStore::init(receiver_dir.path(), &git()).unwrap();
    let device = DeviceId::from_bytes([27; 16]);
    raw_empty_atom_subtree_commit(source_dir.path(), device);
    let (a, p) = limits();
    let validated = pull(&source, &receiver, Plane::Data, &a, &p, &Allow);
    assert!(validated.accepted().is_empty());
    assert_eq!(
        validated.rejected(),
        &[(device, yonalist_sync::SyncErrorCode::InvalidAtom)]
    );
}

#[test]
fn first_parent_prefix_does_not_accept_a_side_parent() {
    let source_dir = tempfile::tempdir().unwrap();
    let receiver_dir = tempfile::tempdir().unwrap();
    let source = GitStore::init(source_dir.path(), &git()).unwrap();
    let receiver = GitStore::init(receiver_dir.path(), &git()).unwrap();
    let device = DeviceId::from_bytes([7; 16]);
    let first = source
        .append_local(StoreBatch {
            plane: Plane::Data,
            device_id: device,
            expected_head: None,
            atoms: vec![atom_for(b"ok", 31, 7, Plane::Data)],
            auxiliary_files: vec![],
            observed_heads: vec![],
        })
        .unwrap();
    let side_device = DeviceId::from_bytes([8; 16]);
    let side = source
        .append_local(StoreBatch {
            plane: Plane::Data,
            device_id: side_device,
            expected_head: None,
            atoms: vec![atom_for(b"ok", 32, 8, Plane::Data)],
            auxiliary_files: vec![],
            observed_heads: vec![],
        })
        .unwrap();
    source
        .append_local(StoreBatch {
            plane: Plane::Data,
            device_id: device,
            expected_head: Some(first.head.clone()),
            atoms: vec![atom_for(b"policy.reject", 33, 7, Plane::Data)],
            auxiliary_files: vec![],
            observed_heads: vec![side.head],
        })
        .unwrap();
    let (a, p) = limits();
    let validated = pull(&source, &receiver, Plane::Data, &a, &p, &RejectPayload);
    let candidate = validated
        .accepted()
        .iter()
        .find(|c| c.device_id == device)
        .unwrap();
    assert_eq!(candidate.accepted_head, first.head);
}

#[test]
fn invalid_atom_hidden_in_omitted_secondary_parent_rejects_merge() {
    let source_dir = tempfile::tempdir().unwrap();
    let receiver_dir = tempfile::tempdir().unwrap();
    let source = GitStore::init(source_dir.path(), &git()).unwrap();
    let receiver = GitStore::init(receiver_dir.path(), &git()).unwrap();
    let device = DeviceId::from_bytes([7; 16]);
    let main_atom = atom_for(b"main", 100, 7, Plane::Data);
    let main = source
        .append_local(StoreBatch {
            plane: Plane::Data,
            device_id: device,
            expected_head: None,
            atoms: vec![main_atom.clone()],
            auxiliary_files: vec![],
            observed_heads: vec![],
        })
        .unwrap();
    let (atom_limits, pack_limits) = limits();
    pull(
        &source,
        &receiver,
        Plane::Data,
        &atom_limits,
        &pack_limits,
        &RejectPayload,
    );
    let bad = atom_for(b"policy.reject", 101, 8, Plane::Data);
    let side = raw_commit(
        source_dir.path(),
        None,
        &[],
        &BTreeMap::from([(bad.repo_path(), bad.encode(&limits().0).unwrap())]),
    );
    let merge = raw_commit(
        source_dir.path(),
        Some(&main.head),
        &[side],
        &BTreeMap::from([(
            main_atom.repo_path(),
            main_atom.encode(&limits().0).unwrap(),
        )]),
    );
    set_ref(source_dir.path(), Plane::Data, device, &merge);
    let advertised = RefAdvertisement {
        plane: Plane::Data,
        refs: BTreeMap::from([(device, merge.clone())]),
    };
    let pack = source
        .create_pack(
            &PackRequest {
                plane: Plane::Data,
                wants: vec![merge],
                haves: vec![],
            },
            &pack_limits,
        )
        .unwrap();
    let validated = receiver
        .import_pack(
            ProjectId::from_bytes([1; 16]),
            Plane::Data,
            &advertised,
            pack,
            &atom_limits,
            &pack_limits,
            &RejectPayload,
        )
        .unwrap();
    assert!(validated.accepted().is_empty());
    assert_eq!(
        validated.rejected(),
        &[(device, yonalist_sync::SyncErrorCode::InvalidAtom)]
    );
    assert_eq!(receiver.head(Plane::Data, device).unwrap(), Some(main.head));
}

#[test]
fn advertised_side_parent_control_commits_keep_causal_boundaries() {
    let source_dir = tempfile::tempdir().unwrap();
    let receiver_dir = tempfile::tempdir().unwrap();
    let source = GitStore::init(source_dir.path(), &git()).unwrap();
    let receiver = GitStore::init(receiver_dir.path(), &git()).unwrap();
    let device = DeviceId::from_bytes([7; 16]);
    let side_device = DeviceId::from_bytes([8; 16]);
    let main = source
        .append_local(StoreBatch {
            plane: Plane::Control,
            device_id: device,
            expected_head: None,
            atoms: vec![atom_for(b"main", 102, 7, Plane::Control)],
            auxiliary_files: vec![],
            observed_heads: vec![],
        })
        .unwrap();
    let side = source
        .append_local(StoreBatch {
            plane: Plane::Control,
            device_id: side_device,
            expected_head: None,
            atoms: vec![atom_for(b"side", 103, 8, Plane::Control)],
            auxiliary_files: vec![],
            observed_heads: vec![],
        })
        .unwrap();
    let mut merge_frontier = vec![main.head.clone(), side.head.clone()];
    merge_frontier.sort();
    let merge = source
        .append_local(StoreBatch {
            plane: Plane::Control,
            device_id: device,
            expected_head: Some(main.head),
            atoms: vec![atom_with_frontiers(
                b"merge",
                104,
                7,
                Plane::Control,
                ProjectId::from_bytes([1; 16]),
                merge_frontier,
                vec![],
            )],
            auxiliary_files: vec![],
            observed_heads: vec![side.head.clone()],
        })
        .unwrap();
    let advertised = RefAdvertisement {
        plane: Plane::Control,
        refs: BTreeMap::from([
            (device, merge.head.clone()),
            (side_device, side.head.clone()),
        ]),
    };
    let (atom_limits, pack_limits) = limits();
    let pack = source
        .create_pack(
            &PackRequest {
                plane: Plane::Control,
                wants: vec![merge.head.clone(), side.head.clone()],
                haves: vec![],
            },
            &pack_limits,
        )
        .unwrap();
    let calls = Arc::new(Mutex::new(Vec::new()));
    let validated = receiver
        .import_pack(
            ProjectId::from_bytes([1; 16]),
            Plane::Control,
            &advertised,
            pack,
            &atom_limits,
            &pack_limits,
            &RecordControlBoundaries(calls.clone()),
        )
        .unwrap();
    assert_eq!(validated.accepted().len(), 2);
    assert!(validated
        .accepted()
        .iter()
        .any(|candidate| candidate.device_id == device && candidate.accepted_head == merge.head));
    assert!(validated.accepted().iter().any(|candidate| {
        candidate.device_id == side_device && candidate.accepted_head == side.head
    }));
    let calls = calls.lock().unwrap();
    assert_eq!(calls.len(), 6);
    assert!(calls.iter().all(|commit| commit.len() == 1));
    let actual = calls.iter().flatten().cloned().collect::<Vec<_>>();
    let expected = source
        .stored_atoms(Plane::Control, &atom_limits)
        .unwrap()
        .into_iter()
        .map(|atom| atom.containing_commit)
        .collect::<Vec<_>>();
    for commit in expected {
        assert_eq!(actual.iter().filter(|actual| *actual == &commit).count(), 2);
    }
}

#[test]
fn partial_control_prefixes_replay_as_a_canonical_union() {
    let source_dir = tempfile::tempdir().unwrap();
    let receiver_dir = tempfile::tempdir().unwrap();
    let source = GitStore::init(source_dir.path(), &git()).unwrap();
    let receiver = GitStore::init(receiver_dir.path(), &git()).unwrap();
    let enable_device = DeviceId::from_bytes([1; 16]);
    let merge_devices = [DeviceId::from_bytes([2; 16]), DeviceId::from_bytes([3; 16])];
    let dependent_device = DeviceId::from_bytes([9; 16]);
    let dependent_atom = atom_for(b"dependent", 242, 9, Plane::Control);
    let dependent = raw_commit(
        source_dir.path(),
        None,
        &[],
        &BTreeMap::from([(
            dependent_atom.repo_path(),
            dependent_atom.encode(&limits().0).unwrap(),
        )]),
    );
    let enable = (0..=200)
        .find_map(|event| {
            let atom = atom_for(b"enable", event, 1, Plane::Control);
            let head = raw_commit(
                source_dir.path(),
                None,
                &[],
                &BTreeMap::from([(atom.repo_path(), atom.encode(&limits().0).unwrap())]),
            );
            (dependent < head).then_some(head)
        })
        .expect("fixture can place dependent before enable in canonical OID order");
    let mut expected = BTreeMap::from([(enable_device, enable.clone())]);
    set_ref(source_dir.path(), Plane::Control, enable_device, &enable);
    set_ref(
        source_dir.path(),
        Plane::Control,
        dependent_device,
        &dependent,
    );
    for (index, device) in merge_devices.into_iter().enumerate() {
        let safe_atom = atom_for(b"safe", 240 + index as u8, 2 + index as u8, Plane::Control);
        let safe = raw_commit(
            source_dir.path(),
            None,
            &[],
            &BTreeMap::from([(
                safe_atom.repo_path(),
                safe_atom.encode(&limits().0).unwrap(),
            )]),
        );
        let merge = raw_commit(
            source_dir.path(),
            Some(&safe),
            std::slice::from_ref(&dependent),
            &BTreeMap::from([
                (
                    safe_atom.repo_path(),
                    safe_atom.encode(&limits().0).unwrap(),
                ),
                (
                    dependent_atom.repo_path(),
                    dependent_atom.encode(&limits().0).unwrap(),
                ),
            ]),
        );
        set_ref(source_dir.path(), Plane::Control, device, &merge);
        expected.insert(device, safe);
    }
    let advertised = source.advertise(Plane::Control).unwrap();
    let (atom_limits, pack_limits) = limits();
    let pack = source
        .create_pack(
            &PackRequest {
                plane: Plane::Control,
                wants: advertised.refs.values().cloned().collect(),
                haves: vec![],
            },
            &pack_limits,
        )
        .unwrap();
    let validated = receiver
        .import_pack(
            ProjectId::from_bytes([1; 16]),
            Plane::Control,
            &advertised,
            pack,
            &atom_limits,
            &pack_limits,
            &EnableBeforeDependent,
        )
        .unwrap();
    assert_eq!(
        validated
            .accepted()
            .iter()
            .map(|candidate| (candidate.device_id, candidate.accepted_head.clone()))
            .collect::<BTreeMap<_, _>>(),
        expected
    );
    assert_eq!(
        validated.rejected(),
        &[
            (
                merge_devices[0],
                yonalist_sync::SyncErrorCode::PolicyRejected
            ),
            (
                merge_devices[1],
                yonalist_sync::SyncErrorCode::PolicyRejected
            ),
            (
                dependent_device,
                yonalist_sync::SyncErrorCode::PolicyRejected
            ),
        ]
    );
    let stored = receiver.stored_atoms(Plane::Control, &atom_limits).unwrap();
    assert!(stored
        .iter()
        .all(|atom| atom.atom.unsigned.payload != b"dependent"));
    assert!(EnableBeforeDependent.rebuild_control(&stored).unwrap());
    drop(receiver);
    Replica::open(
        ReplicaConfig {
            repository: receiver_dir.path().into(),
            git_executable: git(),
            project_id: ProjectId::from_bytes([1; 16]),
            local_member_id: MemberId::from_bytes([2; 16]),
            local_device_id: enable_device,
            local_grant_id: GrantId::from_bytes([4; 16]),
            atom_limits,
            pack_limits,
        },
        EnableBeforeDependent,
        DeviceSigner::from_secret_bytes([9; 32]),
    )
    .unwrap();
}

#[test]
fn trusted_control_boundary_is_replayed_in_global_canonical_order() {
    let source_dir = tempfile::tempdir().unwrap();
    let receiver_dir = tempfile::tempdir().unwrap();
    let source = GitStore::init(source_dir.path(), &git()).unwrap();
    let receiver = GitStore::init(receiver_dir.path(), &git()).unwrap();
    let trusted_device = DeviceId::from_bytes([1; 16]);
    let dependent_device = DeviceId::from_bytes([2; 16]);
    let safe_device = DeviceId::from_bytes([3; 16]);
    let commit_for = |payload: &[u8], event, device| {
        let atom = atom_for(payload, event, device, Plane::Control);
        raw_commit(
            source_dir.path(),
            None,
            &[],
            &BTreeMap::from([(atom.repo_path(), atom.encode(&limits().0).unwrap())]),
        )
    };
    let dependent = (0..=u8::MAX)
        .map(|event| commit_for(b"dependent", event, 2))
        .min()
        .unwrap();
    let safe = (0..=u8::MAX)
        .map(|event| commit_for(b"safe", event, 3))
        .max()
        .unwrap();
    let enable = (0..=u8::MAX)
        .map(|event| commit_for(b"enable", event, 1))
        .find(|head| dependent < *head && *head < safe)
        .expect("fixture candidate pools span dependent < enable < safe");
    set_ref(source_dir.path(), Plane::Control, trusted_device, &enable);
    set_ref(
        source_dir.path(),
        Plane::Control,
        dependent_device,
        &dependent,
    );
    set_ref(source_dir.path(), Plane::Control, safe_device, &safe);
    let trusted_pack = source
        .create_pack(
            &PackRequest {
                plane: Plane::Control,
                wants: vec![enable.clone()],
                haves: vec![],
            },
            &limits().1,
        )
        .unwrap();
    run_git(
        receiver_dir.path(),
        &["index-pack", "--stdin"],
        Some(&trusted_pack.0),
    );
    set_ref(receiver_dir.path(), Plane::Control, trusted_device, &enable);

    let advertised = source.advertise(Plane::Control).unwrap();
    let (atom_limits, pack_limits) = limits();
    let pack = source
        .create_pack(
            &PackRequest {
                plane: Plane::Control,
                wants: vec![dependent.clone(), safe.clone()],
                haves: vec![enable.clone()],
            },
            &pack_limits,
        )
        .unwrap();
    let calls = Arc::new(Mutex::new(Vec::new()));
    let policy = RecordIncomingBeforeTrusted(calls.clone());
    let validated = receiver
        .import_pack(
            ProjectId::from_bytes([1; 16]),
            Plane::Control,
            &advertised,
            pack,
            &atom_limits,
            &pack_limits,
            &policy,
        )
        .unwrap();
    assert_eq!(
        validated
            .accepted()
            .iter()
            .map(|candidate| (candidate.device_id, candidate.accepted_head.clone()))
            .collect::<BTreeMap<_, _>>(),
        BTreeMap::from([(safe_device, safe.clone())])
    );
    assert_eq!(
        validated.rejected(),
        &[(
            dependent_device,
            yonalist_sync::SyncErrorCode::PolicyRejected
        )]
    );
    assert_eq!(
        receiver.head(Plane::Control, trusted_device).unwrap(),
        Some(enable)
    );
    assert_eq!(
        receiver.head(Plane::Control, dependent_device).unwrap(),
        None
    );
    assert_eq!(
        receiver.head(Plane::Control, safe_device).unwrap(),
        Some(safe)
    );

    let stored = receiver.stored_atoms(Plane::Control, &atom_limits).unwrap();
    let stored_order = stored
        .iter()
        .map(|atom| {
            (
                atom.path.clone(),
                atom.containing_commit.clone(),
                atom.atom.unsigned.payload.clone(),
            )
        })
        .collect::<Vec<_>>();
    assert!(calls.lock().unwrap().ends_with(&stored_order));
    assert_eq!(policy.rebuild_control(&stored).unwrap(), 2);
    drop(receiver);
    Replica::open(
        ReplicaConfig {
            repository: receiver_dir.path().into(),
            git_executable: git(),
            project_id: ProjectId::from_bytes([1; 16]),
            local_member_id: MemberId::from_bytes([2; 16]),
            local_device_id: trusted_device,
            local_grant_id: GrantId::from_bytes([4; 16]),
            atom_limits,
            pack_limits,
        },
        policy,
        DeviceSigner::from_secret_bytes([9; 32]),
    )
    .unwrap();
}

#[test]
fn duplicate_atom_alias_is_rejected_while_atomless_commit_is_accepted() {
    let source_dir = tempfile::tempdir().unwrap();
    let receiver_dir = tempfile::tempdir().unwrap();
    let source = GitStore::init(source_dir.path(), &git()).unwrap();
    let receiver = GitStore::init(receiver_dir.path(), &git()).unwrap();
    let shared_atom = atom_for(b"shared", 250, 1, Plane::Control);
    let shared_file = (
        shared_atom.repo_path(),
        shared_atom.encode(&limits().0).unwrap(),
    );
    let first = raw_commit(
        source_dir.path(),
        None,
        &[],
        &BTreeMap::from([shared_file.clone()]),
    );
    let duplicate = raw_commit(
        source_dir.path(),
        None,
        &[],
        &BTreeMap::from([
            shared_file,
            (
                format!("texts/aa/{}.md", "a".repeat(64)),
                b"auxiliary".to_vec(),
            ),
        ]),
    );
    let atomless = raw_commit(
        source_dir.path(),
        None,
        &[],
        &BTreeMap::from([(
            format!("texts/bb/{}.md", "b".repeat(64)),
            b"tree-only".to_vec(),
        )]),
    );
    let last_good = [&first, &duplicate, &atomless].into_iter().max().unwrap();
    let rejected = (0..=u8::MAX)
        .map(|event| {
            let atom = atom_for(b"reject", event, 4, Plane::Control);
            raw_commit(
                source_dir.path(),
                None,
                &[],
                &BTreeMap::from([(atom.repo_path(), atom.encode(&limits().0).unwrap())]),
            )
        })
        .find(|commit| commit > last_good)
        .expect("fixture can place the rejected commit after all valid commits");
    let devices = [
        DeviceId::from_bytes([1; 16]),
        DeviceId::from_bytes([2; 16]),
        DeviceId::from_bytes([3; 16]),
        DeviceId::from_bytes([4; 16]),
    ];
    for (device, head) in devices
        .into_iter()
        .zip([&first, &duplicate, &atomless, &rejected])
    {
        set_ref(source_dir.path(), Plane::Control, device, head);
    }

    let (atom_limits, pack_limits) = limits();
    let trusted_pack = source
        .create_pack(
            &PackRequest {
                plane: Plane::Control,
                wants: vec![first.clone()],
                haves: vec![],
            },
            &pack_limits,
        )
        .unwrap();
    run_git(
        receiver_dir.path(),
        &["index-pack", "--stdin"],
        Some(&trusted_pack.0),
    );
    set_ref(receiver_dir.path(), Plane::Control, devices[0], &first);

    let advertised = source.advertise(Plane::Control).unwrap();
    let pack = source
        .create_pack(
            &PackRequest {
                plane: Plane::Control,
                wants: vec![duplicate.clone(), atomless.clone(), rejected.clone()],
                haves: vec![first.clone()],
            },
            &pack_limits,
        )
        .unwrap();
    let attempts = Arc::new(Mutex::new(Vec::new()));
    let validated = receiver
        .import_pack(
            ProjectId::from_bytes([1; 16]),
            Plane::Control,
            &advertised,
            pack,
            &atom_limits,
            &pack_limits,
            &RecordReplayAttempts(attempts.clone()),
        )
        .unwrap();
    assert_eq!(validated.accepted().len(), 1);
    assert_eq!(validated.accepted()[0].device_id, devices[2]);
    assert_eq!(
        validated.rejected(),
        &[
            (devices[1], yonalist_sync::SyncErrorCode::InvalidAtom),
            (devices[3], yonalist_sync::SyncErrorCode::PolicyRejected),
        ]
    );

    let stored = receiver.stored_atoms(Plane::Control, &atom_limits).unwrap();
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0].atom.unsigned.payload, b"shared");
    let attempts = attempts.lock().unwrap();
    assert!(!attempts.is_empty());
}

#[test]
fn shared_unadvertised_base_must_be_owned_by_an_advertised_device() {
    let source_dir = tempfile::tempdir().unwrap();
    let receiver_dir = tempfile::tempdir().unwrap();
    let source = GitStore::init(source_dir.path(), &git()).unwrap();
    let receiver = GitStore::init(receiver_dir.path(), &git()).unwrap();
    let (atom_limits, pack_limits) = limits();

    let malicious = atom_for(b"unowned", 200, 99, Plane::Data);
    let base_files = BTreeMap::from([(
        malicious.repo_path(),
        malicious.encode(&atom_limits).unwrap(),
    )]);
    let base = raw_commit_with_parents(source_dir.path(), &[], &base_files);

    for (device_byte, event) in [(1, 201), (2, 202)] {
        let device = DeviceId::from_bytes([device_byte; 16]);
        let owned = atom_with_frontiers(
            b"owned",
            event,
            device_byte,
            Plane::Data,
            ProjectId::from_bytes([1; 16]),
            vec![],
            vec![base.clone()],
        );
        let mut files = base_files.clone();
        files.insert(owned.repo_path(), owned.encode(&atom_limits).unwrap());
        let head = raw_commit_with_parents(source_dir.path(), std::slice::from_ref(&base), &files);
        set_ref(source_dir.path(), Plane::Data, device, &head);
    }

    let outcome = pull(
        &source,
        &receiver,
        Plane::Data,
        &atom_limits,
        &pack_limits,
        &Allow,
    );
    assert!(outcome.accepted().is_empty());
    assert_eq!(outcome.rejected().len(), 2);
    assert!(outcome
        .rejected()
        .iter()
        .all(|(_, code)| *code == yonalist_sync::SyncErrorCode::InvalidAtom));
    assert!(receiver.advertise(Plane::Data).unwrap().refs.is_empty());
}

#[test]
fn ancestry_redundant_trusted_head_remains_an_exact_ownership_boundary() {
    let source_dir = tempfile::tempdir().unwrap();
    let receiver_dir = tempfile::tempdir().unwrap();
    let source = GitStore::init(source_dir.path(), &git()).unwrap();
    let receiver = GitStore::init(receiver_dir.path(), &git()).unwrap();
    let (atom_limits, pack_limits) = limits();
    let trusted_device = DeviceId::from_bytes([211; 16]);
    let trusted = source
        .append_local(StoreBatch {
            plane: Plane::Data,
            device_id: trusted_device,
            expected_head: None,
            atoms: vec![atom_for(b"trusted", 211, 211, Plane::Data)],
            auxiliary_files: vec![],
            observed_heads: vec![],
        })
        .unwrap();
    let descendant_device = DeviceId::from_bytes([212; 16]);
    source
        .append_local(StoreBatch {
            plane: Plane::Data,
            device_id: descendant_device,
            expected_head: None,
            atoms: vec![atom_with_frontiers(
                b"descendant",
                212,
                212,
                Plane::Data,
                ProjectId::from_bytes([1; 16]),
                vec![],
                vec![trusted.head.clone()],
            )],
            auxiliary_files: vec![],
            observed_heads: vec![trusted.head.clone()],
        })
        .unwrap();
    let initial = pull(
        &source,
        &receiver,
        Plane::Data,
        &atom_limits,
        &pack_limits,
        &Allow,
    );
    assert_eq!(initial.accepted, 2);

    let candidate_device = DeviceId::from_bytes([213; 16]);
    set_ref(
        source_dir.path(),
        Plane::Data,
        candidate_device,
        &trusted.head,
    );

    let advertised = source.advertise(Plane::Data).unwrap();
    let wants = advertised
        .refs
        .values()
        .cloned()
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    let pack = source
        .create_pack(
            &PackRequest {
                plane: Plane::Data,
                wants,
                haves: vec![],
            },
            &pack_limits,
        )
        .unwrap();
    let outcome = receiver
        .import_pack(
            ProjectId::from_bytes([1; 16]),
            Plane::Data,
            &advertised,
            pack,
            &atom_limits,
            &pack_limits,
            &Allow,
        )
        .unwrap();
    assert!(!outcome
        .accepted()
        .iter()
        .any(|accepted| accepted.device_id == candidate_device));
    assert_eq!(
        outcome.rejected(),
        &[(candidate_device, yonalist_sync::SyncErrorCode::InvalidAtom)]
    );
}

#[test]
fn unadvertised_side_parent_atom_has_no_ref_owner() {
    let source_dir = tempfile::tempdir().unwrap();
    let receiver_dir = tempfile::tempdir().unwrap();
    let source = GitStore::init(source_dir.path(), &git()).unwrap();
    let receiver = GitStore::init(receiver_dir.path(), &git()).unwrap();
    let (atom_limits, pack_limits) = limits();
    let device = DeviceId::from_bytes([41; 16]);
    let main_atom = atom_for(b"main", 206, 41, Plane::Data);
    let main = source
        .append_local(StoreBatch {
            plane: Plane::Data,
            device_id: device,
            expected_head: None,
            atoms: vec![main_atom.clone()],
            auxiliary_files: vec![],
            observed_heads: vec![],
        })
        .unwrap();
    let side_atom = atom_for(b"unadvertised-side", 207, 42, Plane::Data);
    let side = raw_commit_with_parents(
        source_dir.path(),
        &[],
        &BTreeMap::from([(
            side_atom.repo_path(),
            side_atom.encode(&atom_limits).unwrap(),
        )]),
    );
    let merge = raw_commit_with_parents(
        source_dir.path(),
        &[main.head.clone(), side],
        &BTreeMap::from([
            (
                main_atom.repo_path(),
                main_atom.encode(&atom_limits).unwrap(),
            ),
            (
                side_atom.repo_path(),
                side_atom.encode(&atom_limits).unwrap(),
            ),
        ]),
    );
    set_ref(source_dir.path(), Plane::Data, device, &merge);
    let advertised = RefAdvertisement {
        plane: Plane::Data,
        refs: BTreeMap::from([(device, merge.clone())]),
    };
    let pack = source
        .create_pack(
            &PackRequest {
                plane: Plane::Data,
                wants: vec![merge],
                haves: vec![],
            },
            &pack_limits,
        )
        .unwrap();

    let outcome = receiver
        .import_pack(
            ProjectId::from_bytes([1; 16]),
            Plane::Data,
            &advertised,
            pack,
            &atom_limits,
            &pack_limits,
            &Allow,
        )
        .unwrap();
    assert_eq!(outcome.accepted()[0].accepted_head, main.head);
    assert_eq!(
        outcome.rejected(),
        &[(device, yonalist_sync::SyncErrorCode::InvalidAtom)]
    );
}

#[test]
fn complete_trees_allow_atoms_from_other_devices() {
    let source_dir = tempfile::tempdir().unwrap();
    let receiver_dir = tempfile::tempdir().unwrap();
    let source = GitStore::init(source_dir.path(), &git()).unwrap();
    let receiver = GitStore::init(receiver_dir.path(), &git()).unwrap();
    let other = source
        .append_local(StoreBatch {
            plane: Plane::Data,
            device_id: DeviceId::from_bytes([8; 16]),
            expected_head: None,
            atoms: vec![atom_for(b"other", 34, 8, Plane::Data)],
            auxiliary_files: vec![],
            observed_heads: vec![],
        })
        .unwrap();
    let mine = source
        .append_local(StoreBatch {
            plane: Plane::Data,
            device_id: DeviceId::from_bytes([7; 16]),
            expected_head: None,
            atoms: vec![atom_with_frontiers(
                b"mine",
                35,
                7,
                Plane::Data,
                ProjectId::from_bytes([1; 16]),
                vec![],
                vec![other.head.clone()],
            )],
            auxiliary_files: vec![],
            observed_heads: vec![other.head],
        })
        .unwrap();
    let (a, p) = limits();
    let validated = pull(&source, &receiver, Plane::Data, &a, &p, &Allow);
    assert!(validated
        .accepted()
        .iter()
        .any(|c| c.accepted_head == mine.head));
}

#[test]
fn immutable_path_removal_and_replacement_are_rejected() {
    for replace in [false, true] {
        let source_dir = tempfile::tempdir().unwrap();
        let receiver_dir = tempfile::tempdir().unwrap();
        let source = GitStore::init(source_dir.path(), &git()).unwrap();
        let receiver = GitStore::init(receiver_dir.path(), &git()).unwrap();
        let signed = atom(b"first", 40);
        let device = signed.unsigned.actor_device_id;
        let path = signed.repo_path();
        let first = source
            .append_local(StoreBatch {
                plane: Plane::Data,
                device_id: device,
                expected_head: None,
                atoms: vec![signed],
                auxiliary_files: vec![],
                observed_heads: vec![],
            })
            .unwrap();
        let mut files = BTreeMap::new();
        if replace {
            files.insert(path, b"replacement".to_vec());
        }
        let bad = raw_commit(source_dir.path(), Some(&first.head), &[], &files);
        set_ref(source_dir.path(), Plane::Data, device, &bad);
        let (a, p) = limits();
        let validated = pull(&source, &receiver, Plane::Data, &a, &p, &Allow);
        assert_eq!(validated.accepted()[0].accepted_head, first.head);
        assert_eq!(
            validated.rejected(),
            &[(device, yonalist_sync::SyncErrorCode::InvalidAtom)]
        );
    }
}

#[test]
fn wrong_plane_and_malformed_text_paths_are_rejected() {
    let control = atom_for(b"x", 50, 3, Plane::Control);
    let data = atom_for(b"x", 51, 3, Plane::Data);
    for (path, bytes) in [
        (control.repo_path(), control.encode(&limits().0).unwrap()),
        (
            "texts/AA/not-a-hash.md".to_owned(),
            data.encode(&limits().0).unwrap(),
        ),
    ] {
        let source_dir = tempfile::tempdir().unwrap();
        let receiver_dir = tempfile::tempdir().unwrap();
        let source = GitStore::init(source_dir.path(), &git()).unwrap();
        let receiver = GitStore::init(receiver_dir.path(), &git()).unwrap();
        let device = DeviceId::from_bytes([3; 16]);
        let head = raw_commit(
            source_dir.path(),
            None,
            &[],
            &BTreeMap::from([(path, bytes)]),
        );
        set_ref(source_dir.path(), Plane::Data, device, &head);
        let (a, p) = limits();
        let validated = pull(&source, &receiver, Plane::Data, &a, &p, &Allow);
        assert!(validated.accepted().is_empty());
        assert_eq!(
            validated.rejected()[0].1,
            yonalist_sync::SyncErrorCode::InvalidAtom
        );
    }
}

#[test]
fn unsupported_atom_schema_is_rejected() {
    let source_dir = tempfile::tempdir().unwrap();
    let receiver_dir = tempfile::tempdir().unwrap();
    let source = GitStore::init(source_dir.path(), &git()).unwrap();
    let receiver = GitStore::init(receiver_dir.path(), &git()).unwrap();
    let signed = atom(b"x", 52);
    let device = signed.unsigned.actor_device_id;
    let path = signed.repo_path();
    let mut bytes = signed.encode(&limits().0).unwrap();
    let schema = bytes
        .windows(2)
        .position(|w| w == [0x8b, 0x01])
        .expect("wire tuple and schema");
    bytes[schema + 1] = 2;
    let head = raw_commit(
        source_dir.path(),
        None,
        &[],
        &BTreeMap::from([(path, bytes)]),
    );
    set_ref(source_dir.path(), Plane::Data, device, &head);
    let (a, p) = limits();
    let validated = pull(&source, &receiver, Plane::Data, &a, &p, &Allow);
    assert!(validated.accepted().is_empty());
    assert_eq!(
        validated.rejected(),
        &[(device, yonalist_sync::SyncErrorCode::UnsupportedSchema)]
    );
}

#[test]
fn invalid_atom_signature_is_rejected_by_validation_policy() {
    let source_dir = tempfile::tempdir().unwrap();
    let receiver_dir = tempfile::tempdir().unwrap();
    let source = GitStore::init(source_dir.path(), &git()).unwrap();
    let receiver = GitStore::init(receiver_dir.path(), &git()).unwrap();
    let signed = atom(b"x", 55);
    let device = signed.unsigned.actor_device_id;
    let path = signed.repo_path();
    let mut bytes = signed.encode(&limits().0).unwrap();
    *bytes.last_mut().unwrap() ^= 1;
    let head = raw_commit(
        source_dir.path(),
        None,
        &[],
        &BTreeMap::from([(path, bytes)]),
    );
    set_ref(source_dir.path(), Plane::Data, device, &head);
    let (a, p) = limits();
    let validated = pull(&source, &receiver, Plane::Data, &a, &p, &Allow);
    assert!(validated.accepted().is_empty());
    assert_eq!(
        validated.rejected(),
        &[(device, yonalist_sync::SyncErrorCode::InvalidSignature)]
    );
}

#[test]
fn trusted_head_must_be_on_advertised_first_parent_chain() {
    let source_dir = tempfile::tempdir().unwrap();
    let receiver_dir = tempfile::tempdir().unwrap();
    let source = GitStore::init(source_dir.path(), &git()).unwrap();
    let receiver = GitStore::init(receiver_dir.path(), &git()).unwrap();
    let d = DeviceId::from_bytes([53; 16]);
    let trusted = source
        .append_local(StoreBatch {
            plane: Plane::Data,
            device_id: d,
            expected_head: None,
            atoms: vec![atom_for(b"trusted", 53, 53, Plane::Data)],
            auxiliary_files: vec![],
            observed_heads: vec![],
        })
        .unwrap();
    let (a, p) = limits();
    pull(&source, &receiver, Plane::Data, &a, &p, &Allow);
    let main_device = DeviceId::from_bytes([54; 16]);
    let main = source
        .append_local(StoreBatch {
            plane: Plane::Data,
            device_id: main_device,
            expected_head: None,
            atoms: vec![atom_for(b"main", 54, 54, Plane::Data)],
            auxiliary_files: vec![],
            observed_heads: vec![],
        })
        .unwrap();
    let mut files = BTreeMap::new();
    for atom in [
        atom_for(b"trusted", 53, 53, Plane::Data),
        atom_for(b"main", 54, 54, Plane::Data),
    ] {
        files.insert(atom.repo_path(), atom.encode(&a).unwrap());
    }
    let merge = raw_commit(
        source_dir.path(),
        Some(&main.head),
        &[trusted.head.clone()],
        &files,
    );
    set_ref(source_dir.path(), Plane::Data, d, &merge);
    let validated = pull(&source, &receiver, Plane::Data, &a, &p, &Allow);
    assert!(!validated.accepted().iter().any(|c| c.device_id == d));
    assert!(validated
        .rejected()
        .contains(&(d, yonalist_sync::SyncErrorCode::RefRewind)));
}

#[test]
fn atom_ref_and_pack_limits_are_enforced() {
    let source_dir = tempfile::tempdir().unwrap();
    let receiver_dir = tempfile::tempdir().unwrap();
    let source = GitStore::init(source_dir.path(), &git()).unwrap();
    let receiver = GitStore::init(receiver_dir.path(), &git()).unwrap();
    for n in 0..2 {
        let d = DeviceId::from_bytes([60 + n; 16]);
        source
            .append_local(StoreBatch {
                plane: Plane::Data,
                device_id: d,
                expected_head: None,
                atoms: vec![atom_for(b"x", 60 + n, 60 + n, Plane::Data)],
                auxiliary_files: vec![],
                observed_heads: vec![],
            })
            .unwrap();
    }
    let (a, mut p) = limits();
    p.max_advertised_refs = 1;
    let adv = source.advertise(Plane::Data).unwrap();
    let pack = source
        .create_pack(
            &PackRequest {
                plane: Plane::Data,
                wants: vec![adv.refs.values().next().unwrap().clone()],
                haves: vec![],
            },
            &limits().1,
        )
        .unwrap();
    assert_eq!(
        receiver
            .import_pack(
                ProjectId::from_bytes([1; 16]),
                Plane::Data,
                &adv,
                pack,
                &a,
                &p,
                &Allow,
            )
            .unwrap_err()
            .code,
        yonalist_sync::SyncErrorCode::PackRejected
    );
    let (_, mut tiny) = limits();
    tiny.max_pack_bytes = 1;
    let head = adv.refs.values().next().unwrap().clone();
    assert_eq!(
        source
            .create_pack(
                &PackRequest {
                    plane: Plane::Data,
                    wants: vec![head],
                    haves: vec![]
                },
                &tiny
            )
            .unwrap_err()
            .code,
        yonalist_sync::SyncErrorCode::LimitExceeded
    );
    let source2_dir = tempfile::tempdir().unwrap();
    let source2 = GitStore::init(source2_dir.path(), &git()).unwrap();
    let d = DeviceId::from_bytes([70; 16]);
    source2
        .append_local(StoreBatch {
            plane: Plane::Data,
            device_id: d,
            expected_head: None,
            atoms: vec![
                atom_for(b"a", 70, 70, Plane::Data),
                atom_for(b"b", 71, 70, Plane::Data),
            ],
            auxiliary_files: vec![],
            observed_heads: vec![],
        })
        .unwrap();
    let mut one = limits().1;
    one.max_atoms_per_head = 1;
    let validated = pull(&source2, &receiver, Plane::Data, &a, &one, &Allow);
    assert!(validated.accepted().is_empty());
    assert_eq!(
        validated.rejected()[0].1,
        yonalist_sync::SyncErrorCode::LimitExceeded
    );
}

#[test]
fn rewind_is_rejected_and_cleanup_removes_sessions() {
    let source_dir = tempfile::tempdir().unwrap();
    let receiver_dir = tempfile::tempdir().unwrap();
    let source = GitStore::init(source_dir.path(), &git()).unwrap();
    let receiver = GitStore::init(receiver_dir.path(), &git()).unwrap();
    let d = DeviceId::from_bytes([80; 16]);
    let first = source
        .append_local(StoreBatch {
            plane: Plane::Data,
            device_id: d,
            expected_head: None,
            atoms: vec![atom_for(b"a", 80, 80, Plane::Data)],
            auxiliary_files: vec![],
            observed_heads: vec![],
        })
        .unwrap();
    let second = source
        .append_local(StoreBatch {
            plane: Plane::Data,
            device_id: d,
            expected_head: Some(first.head.clone()),
            atoms: vec![atom_with_frontiers(
                b"b",
                81,
                80,
                Plane::Data,
                ProjectId::from_bytes([1; 16]),
                vec![],
                vec![first.head.clone()],
            )],
            auxiliary_files: vec![],
            observed_heads: vec![],
        })
        .unwrap();
    let (a, p) = limits();
    pull(&source, &receiver, Plane::Data, &a, &p, &Allow);
    set_ref(source_dir.path(), Plane::Data, d, &first.head);
    let validated = pull(&source, &receiver, Plane::Data, &a, &p, &Allow);
    assert!(validated.accepted().is_empty());
    assert_eq!(
        validated.rejected(),
        &[(d, yonalist_sync::SyncErrorCode::RefRewind)]
    );
    assert_eq!(receiver.head(Plane::Data, d).unwrap(), Some(second.head));
    assert!(std::fs::read_dir(receiver_dir.path().join("incoming"))
        .unwrap()
        .next()
        .is_none());
}

#[test]
fn multi_ref_combined_import_is_all_or_nothing() {
    let source_dir = tempfile::tempdir().unwrap();
    let receiver_dir = tempfile::tempdir().unwrap();
    let source = GitStore::init(source_dir.path(), &git()).unwrap();
    let receiver = GitStore::init(receiver_dir.path(), &git()).unwrap();
    for n in [90, 91] {
        source
            .append_local(StoreBatch {
                plane: Plane::Data,
                device_id: DeviceId::from_bytes([n; 16]),
                expected_head: None,
                atoms: vec![atom_for(b"x", n, n, Plane::Data)],
                auxiliary_files: vec![],
                observed_heads: vec![],
            })
            .unwrap();
    }
    let (a, p) = limits();
    let outcome = pull(&source, &receiver, Plane::Data, &a, &p, &Allow);
    assert_eq!(outcome.accepted, 2);
    for device in [90, 91].map(|byte| DeviceId::from_bytes([byte; 16])) {
        assert!(receiver.head(Plane::Data, device).unwrap().is_some());
    }
}

#[test]
fn unrelated_ref_change_aborts_full_snapshot_promotion() {
    let source_dir = tempfile::tempdir().unwrap();
    let receiver_dir = tempfile::tempdir().unwrap();
    let source = GitStore::init(source_dir.path(), &git()).unwrap();
    let receiver = GitStore::init(receiver_dir.path(), &git()).unwrap();
    let signed = atom(b"candidate", 93);
    let candidate_device = signed.unsigned.actor_device_id;
    source
        .append_local(StoreBatch {
            plane: Plane::Data,
            device_id: candidate_device,
            expected_head: None,
            atoms: vec![signed],
            auxiliary_files: vec![],
            observed_heads: vec![],
        })
        .unwrap();
    let advertised = source.advertise(Plane::Data).unwrap();
    let (atom_limits, pack_limits) = limits();
    let pack = source
        .create_pack(
            &PackRequest {
                plane: Plane::Data,
                wants: advertised.refs.values().cloned().collect(),
                haves: vec![],
            },
            &pack_limits,
        )
        .unwrap();
    let gate = ValidationGate::new();
    let worker_gate = gate.clone();
    let receiver_path = receiver_dir.path().to_path_buf();
    let worker = thread::spawn(move || {
        let store = GitStore::open(&receiver_path, &git()).unwrap();
        store.import_pack(
            ProjectId::from_bytes([1; 16]),
            Plane::Data,
            &advertised,
            pack,
            &atom_limits,
            &pack_limits,
            &BlockingAllow(worker_gate),
        )
    });
    gate.wait_until_entered();

    let unrelated_device = DeviceId::from_bytes([94; 16]);
    let unrelated_atom = atom_for(b"unrelated", 94, 94, Plane::Control);
    let unrelated = raw_commit_with_parents(
        receiver_dir.path(),
        &[],
        &BTreeMap::from([(
            unrelated_atom.repo_path(),
            unrelated_atom.encode(&limits().0).unwrap(),
        )]),
    );
    set_ref(
        receiver_dir.path(),
        Plane::Control,
        unrelated_device,
        &unrelated,
    );
    gate.release();

    let error = worker.join().unwrap().unwrap_err();
    assert_eq!(error.code, yonalist_sync::SyncErrorCode::RefRewind);
    assert_eq!(receiver.head(Plane::Data, candidate_device).unwrap(), None);
    assert_eq!(
        receiver.head(Plane::Control, unrelated_device).unwrap(),
        Some(unrelated)
    );
}

#[test]
fn revocation_race_serializes_validation_and_append() {
    let source_dir = tempfile::tempdir().unwrap();
    let receiver_dir = tempfile::tempdir().unwrap();
    let source = GitStore::init(source_dir.path(), &git()).unwrap();
    let receiver = GitStore::init(receiver_dir.path(), &git()).unwrap();
    let control_device = DeviceId::from_bytes([1; 16]);
    let grant = source
        .append_local(StoreBatch {
            plane: Plane::Control,
            device_id: control_device,
            expected_head: None,
            atoms: vec![atom_for(b"grant", 95, 1, Plane::Control)],
            auxiliary_files: vec![],
            observed_heads: vec![],
        })
        .unwrap();
    let (atom_limits, pack_limits) = limits();
    let control_advertised = source.advertise(Plane::Control).unwrap();
    let control_pack = source
        .create_pack(
            &PackRequest {
                plane: Plane::Control,
                wants: control_advertised.refs.values().cloned().collect(),
                haves: vec![],
            },
            &pack_limits,
        )
        .unwrap();
    let _outcome = receiver
        .import_pack(
            ProjectId::from_bytes([1; 16]),
            Plane::Control,
            &control_advertised,
            control_pack,
            &atom_limits,
            &pack_limits,
            &CutPolicy,
        )
        .unwrap();

    let data = atom_with_frontiers(
        b"before-revoke",
        96,
        3,
        Plane::Data,
        ProjectId::from_bytes([1; 16]),
        vec![grant.head.clone()],
        vec![],
    );
    let data_device = data.unsigned.actor_device_id;
    source
        .append_local(StoreBatch {
            plane: Plane::Data,
            device_id: data_device,
            expected_head: None,
            atoms: vec![data],
            auxiliary_files: vec![],
            observed_heads: vec![],
        })
        .unwrap();
    let data_advertised = source.advertise(Plane::Data).unwrap();
    let data_pack = source
        .create_pack(
            &PackRequest {
                plane: Plane::Data,
                wants: data_advertised.refs.values().cloned().collect(),
                haves: vec![],
            },
            &pack_limits,
        )
        .unwrap();

    let gate = ValidationGate::new();
    let import_gate = gate.clone();
    let import_path = receiver_dir.path().to_path_buf();
    let import_limits = atom_limits.clone();
    let import_pack_limits = pack_limits.clone();
    let (imported_tx, imported_rx) = mpsc::channel();
    let import_thread = thread::spawn(move || {
        let store = GitStore::open(&import_path, &git()).unwrap();
        let result = store.import_pack(
            ProjectId::from_bytes([1; 16]),
            Plane::Data,
            &data_advertised,
            data_pack,
            &import_limits,
            &import_pack_limits,
            &BlockingCutPolicy(import_gate),
        );
        imported_tx.send(result).unwrap();
    });
    gate.wait_until_entered();
    let import_lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(receiver_dir.path().join("yonalist-private/writer.lock"))
        .unwrap();
    assert!(matches!(
        fs4::FileExt::try_lock(&import_lock),
        Err(fs4::TryLockError::WouldBlock)
    ));

    let (mutation_tx, mutation_rx) = mpsc::channel();
    let mut revoker = Replica::open(
        ReplicaConfig {
            repository: receiver_dir.path().into(),
            git_executable: git(),
            project_id: ProjectId::from_bytes([1; 16]),
            local_member_id: MemberId::from_bytes([2; 16]),
            local_device_id: control_device,
            local_grant_id: GrantId::from_bytes([4; 16]),
            atom_limits,
            pack_limits,
        },
        SignalingCutPolicy(mutation_tx),
        DeviceSigner::from_secret_bytes([9; 32]),
    )
    .unwrap();
    let revoke = atom_with_frontiers(
        b"revoke",
        97,
        1,
        Plane::Control,
        ProjectId::from_bytes([1; 16]),
        vec![grant.head],
        vec![],
    );
    let (ready_tx, ready_rx) = mpsc::channel();
    let (revoked_tx, revoked_rx) = mpsc::channel();
    let revoke_thread = thread::spawn(move || {
        ready_tx.send(()).unwrap();
        let result = revoker.append_local(yonalist_sync::LocalBatch {
            plane: Plane::Control,
            atoms: vec![revoke],
            auxiliary_files: vec![],
        });
        revoked_tx.send(result).unwrap();
    });
    ready_rx.recv_timeout(Duration::from_secs(3)).unwrap();
    gate.release();
    assert_eq!(
        imported_rx
            .recv_timeout(Duration::from_secs(3))
            .unwrap()
            .unwrap()
            .accepted,
        1
    );
    mutation_rx.recv_timeout(Duration::from_secs(3)).unwrap();
    revoked_rx
        .recv_timeout(Duration::from_secs(3))
        .unwrap()
        .unwrap();
    import_thread.join().unwrap();
    revoke_thread.join().unwrap();
    assert!(receiver.head(Plane::Data, data_device).unwrap().is_some());
}

use std::{
    collections::BTreeMap,
    env,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
};

use yonalist_sync::{
    AccessDecision, AccessState, AtomLimits, CandidateRef, DeviceId, DeviceSigner, EventId, GitOid,
    GitStore, PackLimits, PackRequest, Plane, ProjectPolicy, RefAdvertisement, SignedAtom,
    StoreBatch, StoredAtom, UnsignedAtom, ATOM_SCHEMA_V1,
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
    DeviceSigner::from_secret_bytes([9; 32])
        .sign(UnsignedAtom {
            schema: ATOM_SCHEMA_V1,
            project_id: yonalist_sync::ProjectId::from_bytes([1; 16]),
            event_id: EventId::from_bytes([event; 16]),
            plane,
            actor_member_id: yonalist_sync::MemberId::from_bytes([2; 16]),
            actor_device_id: DeviceId::from_bytes([device; 16]),
            membership_grant_id: yonalist_sync::GrantId::from_bytes([4; 16]),
            control_frontier: vec![],
            data_frontier: vec![],
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
) -> yonalist_sync::ValidatedPack {
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
        .validate_pack(
            plane,
            &advertised,
            pack,
            atom_limits,
            pack_limits,
            policy,
            &(),
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
        .validate_pack(
            Plane::Data,
            &source.advertise(Plane::Data).unwrap(),
            pack,
            &atom_limits,
            &pack_limits,
            &Allow,
            &(),
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
        .validate_pack(
            Plane::Data,
            &source.advertise(Plane::Data).unwrap(),
            pack,
            &atom_limits,
            &pack_limits,
            &Allow,
            &(),
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
    receiver.promote_pack(validated).unwrap();
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
            atoms: vec![atom(b"policy.reject", 21)],
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
        .validate_pack(
            Plane::Data,
            &source.advertise(Plane::Data).unwrap(),
            pack,
            &atom_limits,
            &pack_limits,
            &RejectPayload,
            &(),
        )
        .unwrap();
    assert_eq!(validated.accepted()[0].accepted_head, first.head);
    assert_eq!(
        validated.rejected(),
        vec![(device, yonalist_sync::SyncErrorCode::PolicyRejected)]
    );
    receiver.promote_pack(validated).unwrap();
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
    receiver
        .promote_pack(pull(&source, &receiver, Plane::Data, &a, &p, &Allow))
        .unwrap();
    source
        .append_local(StoreBatch {
            plane: Plane::Data,
            device_id: device,
            expected_head: Some(first.head),
            atoms: vec![atom(b"policy.reject", 30)],
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
fn validated_pack_cannot_be_promoted_by_a_different_store() {
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
    let validated = pull(&source, &receiver_a, Plane::Data, &a, &p, &Allow);
    assert_eq!(
        receiver_b.promote_pack(validated).unwrap_err().code,
        yonalist_sync::SyncErrorCode::PackRejected
    );
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
    receiver
        .promote_pack(pull(
            &source,
            &receiver,
            Plane::Data,
            &atom_limits,
            &pack_limits,
            &RejectPayload,
        ))
        .unwrap();
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
        .validate_pack(
            Plane::Data,
            &advertised,
            pack,
            &atom_limits,
            &pack_limits,
            &RejectPayload,
            &(),
        )
        .unwrap();
    assert!(validated.accepted().is_empty());
    assert_eq!(
        validated.rejected(),
        &[(device, yonalist_sync::SyncErrorCode::PolicyRejected)]
    );
    receiver.promote_pack(validated).unwrap();
    assert_eq!(receiver.head(Plane::Data, device).unwrap(), Some(main.head));
}

#[test]
fn side_parent_control_commits_keep_causal_boundaries_without_becoming_candidates() {
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
    let merge = source
        .append_local(StoreBatch {
            plane: Plane::Control,
            device_id: device,
            expected_head: Some(main.head),
            atoms: vec![atom_for(b"merge", 104, 7, Plane::Control)],
            auxiliary_files: vec![],
            observed_heads: vec![side.head],
        })
        .unwrap();
    let advertised = RefAdvertisement {
        plane: Plane::Control,
        refs: BTreeMap::from([(device, merge.head.clone())]),
    };
    let (atom_limits, pack_limits) = limits();
    let pack = source
        .create_pack(
            &PackRequest {
                plane: Plane::Control,
                wants: vec![merge.head.clone()],
                haves: vec![],
            },
            &pack_limits,
        )
        .unwrap();
    let calls = Arc::new(Mutex::new(Vec::new()));
    let validated = receiver
        .validate_pack(
            Plane::Control,
            &advertised,
            pack,
            &atom_limits,
            &pack_limits,
            &RecordControlBoundaries(calls.clone()),
            &(),
        )
        .unwrap();
    assert_eq!(validated.accepted().len(), 1);
    assert_eq!(validated.accepted()[0].device_id, device);
    assert_eq!(validated.accepted()[0].accepted_head, merge.head);
    let calls = calls.lock().unwrap();
    assert_eq!(calls.len(), 3);
    assert!(calls.iter().all(|commit| commit.len() == 1));
    let actual = calls.iter().flatten().cloned().collect::<Vec<_>>();
    let expected = source
        .stored_atoms(Plane::Control, &atom_limits)
        .unwrap()
        .into_iter()
        .map(|atom| atom.containing_commit)
        .collect::<Vec<_>>();
    assert_eq!(actual, expected);
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
            atoms: vec![atom_for(b"mine", 35, 7, Plane::Data)],
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
    receiver
        .promote_pack(pull(&source, &receiver, Plane::Data, &a, &p, &Allow))
        .unwrap();
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
            .validate_pack(Plane::Data, &adv, pack, &a, &p, &Allow, &())
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
            atoms: vec![atom_for(b"b", 81, 80, Plane::Data)],
            auxiliary_files: vec![],
            observed_heads: vec![],
        })
        .unwrap();
    let (a, p) = limits();
    receiver
        .promote_pack(pull(&source, &receiver, Plane::Data, &a, &p, &Allow))
        .unwrap();
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
fn multi_ref_compare_and_swap_is_all_or_nothing() {
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
    let validated = pull(&source, &receiver, Plane::Data, &a, &p, &Allow);
    let conflict = atom_for(b"local", 92, 90, Plane::Data);
    let intervening = receiver
        .append_local(StoreBatch {
            plane: Plane::Data,
            device_id: DeviceId::from_bytes([90; 16]),
            expected_head: None,
            atoms: vec![conflict],
            auxiliary_files: vec![],
            observed_heads: vec![],
        })
        .unwrap();
    assert_eq!(
        receiver.promote_pack(validated).unwrap_err().code,
        yonalist_sync::SyncErrorCode::RefRewind
    );
    assert_eq!(
        receiver
            .head(Plane::Data, DeviceId::from_bytes([91; 16]))
            .unwrap(),
        None
    );
    assert_eq!(
        receiver
            .head(Plane::Data, DeviceId::from_bytes([90; 16]))
            .unwrap(),
        Some(intervening.head)
    );
}

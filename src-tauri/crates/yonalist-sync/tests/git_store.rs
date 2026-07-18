use std::{env, path::PathBuf};

use yonalist_sync::{
    AtomLimits, DeviceId, DeviceSigner, EventId, GitStore, MemberId, Plane, ProjectId, StoreBatch,
    SyncErrorCode, UnsignedAtom, ATOM_SCHEMA_V1,
};

fn test_git_executable() -> PathBuf {
    env::var_os("YONALIST_TEST_GIT")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("git"))
}

fn test_limits() -> AtomLimits {
    AtomLimits {
        max_payload_bytes: 1024,
        max_frontier_heads: 8,
    }
}

fn signed_fixture(plane: Plane, event_id: EventId) -> yonalist_sync::SignedAtom {
    DeviceSigner::from_secret_bytes([9; 32])
        .sign(UnsignedAtom {
            schema: ATOM_SCHEMA_V1,
            project_id: ProjectId::from_bytes([1; 16]),
            event_id,
            plane,
            actor_member_id: MemberId::from_bytes([2; 16]),
            actor_device_id: DeviceId::from_bytes([3; 16]),
            membership_grant_id: yonalist_sync::GrantId::from_bytes([4; 16]),
            control_frontier: vec![],
            data_frontier: vec![],
            display_time_ms: 0,
            payload: b"issue.created".to_vec(),
        })
        .unwrap()
}

fn batch_for(atom: yonalist_sync::SignedAtom) -> StoreBatch {
    StoreBatch {
        plane: atom.unsigned.plane,
        device_id: atom.unsigned.actor_device_id,
        expected_head: None,
        atoms: vec![atom],
        auxiliary_files: vec![],
        observed_heads: vec![],
    }
}

fn batch_with_expected(
    device: DeviceId,
    expected_head: Option<yonalist_sync::GitOid>,
    event: EventId,
) -> StoreBatch {
    let atom = signed_fixture(Plane::Data, event);
    StoreBatch {
        device_id: device,
        expected_head,
        ..batch_for(atom)
    }
}

fn store_with_one_data_commit() -> (GitStore, DeviceId, yonalist_sync::LocalCommit) {
    let repo = tempfile::tempdir().unwrap().keep();
    let store = GitStore::init(&repo, &test_git_executable()).unwrap();
    let fixture = signed_fixture(Plane::Data, EventId::from_bytes([3; 16]));
    let device = fixture.unsigned.actor_device_id;
    let first = store.append_local(batch_for(fixture)).unwrap();
    (store, device, first)
}

#[test]
fn local_append_is_durable_at_the_device_ref() {
    let temp = tempfile::tempdir().unwrap();
    let git = test_git_executable();
    let store = GitStore::init(temp.path(), &git).unwrap();
    let fixture = signed_fixture(Plane::Data, EventId::from_bytes([3; 16]));
    let commit = store.append_local(batch_for(fixture.clone())).unwrap();
    assert_eq!(
        store
            .head(Plane::Data, fixture.unsigned.actor_device_id)
            .unwrap(),
        Some(commit.head.clone())
    );
    drop(store);

    let reopened = GitStore::open(temp.path(), &git).unwrap();
    let atoms = reopened.stored_atoms(Plane::Data, &test_limits()).unwrap();
    assert_eq!(atoms.len(), 1);
    assert_eq!(atoms[0].atom.unsigned.event_id, fixture.unsigned.event_id);
}

#[test]
fn stale_compare_and_swap_does_not_move_the_ref() {
    let (store, device, first) = store_with_one_data_commit();
    let second = store
        .append_local(batch_with_expected(
            device,
            Some(first.head.clone()),
            EventId::from_bytes([4; 16]),
        ))
        .unwrap();
    let error = store
        .append_local(batch_with_expected(
            device,
            Some(first.head),
            EventId::from_bytes([5; 16]),
        ))
        .unwrap_err();
    assert_eq!(error.code, SyncErrorCode::RefRewind);
    assert_eq!(store.head(Plane::Data, device).unwrap(), Some(second.head));
}

#[test]
fn initialized_store_is_bare_sha256_and_advertises_the_plane_ref() {
    let temp = tempfile::tempdir().unwrap();
    let git = test_git_executable();
    let store = GitStore::init(temp.path(), &git).unwrap();
    let atom = signed_fixture(Plane::Data, EventId::from_bytes([6; 16]));
    let device = atom.unsigned.actor_device_id;
    store.append_local(batch_for(atom)).unwrap();
    assert_eq!(store.advertise(Plane::Data).unwrap().refs.len(), 1);
    assert!(std::fs::read_to_string(temp.path().join("config"))
        .unwrap()
        .contains("objectformat = sha256"));
    assert_eq!(
        store.advertise(Plane::Data).unwrap().refs.get(&device),
        store.head(Plane::Data, device).unwrap().as_ref()
    );
}

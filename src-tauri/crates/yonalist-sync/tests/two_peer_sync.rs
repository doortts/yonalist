#![cfg(feature = "test-support")]

use yonalist_sync::test_support::raw_test_support::GitStore;
use yonalist_sync::{
    AccessDecision, AtomLimits, DeviceId, DeviceSigner, EventId, FixtureControl, FixturePair,
    FixturePolicy, FixtureReplica, GitOid, GrantId, Hello, HelloAck, InProcessPeer, LocalBatch,
    MemberId, PackBytes, PackFault, PackLimits, PackRequest, PeerEndpoint, Plane, ProjectId,
    RefAdvertisement, ReplicaConfig, SessionToken, SyncError, SyncErrorCode, UnsignedAtom,
    ATOM_SCHEMA_V1,
};

fn same_identity_alice(repository: &std::path::Path) -> FixtureReplica {
    let signer = DeviceSigner::from_secret_bytes([8; 32]);
    FixtureReplica::open(
        ReplicaConfig {
            repository: repository.into(),
            git_executable: test_git(),
            project_id: ProjectId::from_bytes([1; 16]),
            local_member_id: MemberId::from_bytes([2; 16]),
            local_device_id: DeviceId::from_bytes([3; 16]),
            local_grant_id: GrantId::from_bytes([4; 16]),
            atom_limits: AtomLimits {
                max_payload_bytes: 1 << 20,
                max_frontier_heads: 32,
            },
            pack_limits: PackLimits::default(),
        },
        FixturePolicy::new(
            MemberId::from_bytes([2; 16]),
            DeviceId::from_bytes([3; 16]),
            GrantId::from_bytes([4; 16]),
            signer.public_key(),
        ),
        signer,
    )
    .unwrap()
}

fn test_git() -> std::path::PathBuf {
    std::env::var_os("YONALIST_TEST_GIT")
        .map(Into::into)
        .unwrap_or_else(|| "git".into())
}

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
    assert_eq!(
        pair.alice.event_ids(Plane::Data),
        pair.bob.event_ids(Plane::Data)
    );

    let second = pair.bob.pull_from(&mut endpoint).unwrap();
    assert_eq!(second.control_refs_advanced, 0);
    assert_eq!(second.data_refs_advanced, 0);
    assert_eq!(second.control_pack_bytes, 0);
    assert_eq!(second.data_pack_bytes, 0);
}

#[test]
fn same_device_pull_advances_fixture_event_before_local_append() {
    let mut pair = FixturePair::new();
    let replica_b_dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(replica_b_dir.path()).unwrap();
    GitStore::init(replica_b_dir.path(), &test_git()).unwrap();
    let mut replica_b = same_identity_alice(replica_b_dir.path());

    replica_b
        .pull_from(&mut InProcessPeer::new(&pair.alice))
        .unwrap();
    replica_b = same_identity_alice(replica_b_dir.path());
    pair.alice.append_fixture_data(b"authored-on-a").unwrap();

    let error = replica_b
        .pull_from(&mut InProcessPeer::with_fault(
            &pair.alice,
            PackFault::FlipByte(0),
        ))
        .unwrap_err();
    assert_eq!(error.code, SyncErrorCode::PackRejected);
    assert_eq!(replica_b.fixture_event_refresh_count(), 0);

    let report = replica_b
        .pull_from(&mut InProcessPeer::new(&pair.alice))
        .unwrap();
    assert_eq!(report.data_refs_advanced, 1);
    assert_eq!(replica_b.fixture_event_refresh_count(), 1);
    replica_b.append_fixture_data(b"authored-on-b").unwrap();
    replica_b = same_identity_alice(replica_b_dir.path());

    assert_eq!(replica_b.event_ids(Plane::Data).len(), 2);
    assert_eq!(replica_b.event_paths(Plane::Data).len(), 2);
    assert_eq!(replica_b.payloads().len(), 2);
}

#[test]
fn same_device_recovery_decodes_only_its_new_first_parent_atom() {
    let mut pair = FixturePair::new();
    pair.bob
        .pull_from(&mut InProcessPeer::new(&pair.alice))
        .unwrap();
    pair.bob
        .append_fixture_data_batch(
            (0..200)
                .map(|event| format!("remote-{event}").into_bytes())
                .collect(),
        )
        .unwrap();
    pair.alice
        .append_fixture_data(b"initial-local-event")
        .unwrap();
    pair.alice
        .pull_from(&mut InProcessPeer::new(&pair.bob))
        .unwrap();

    let replica_b_dir = tempfile::tempdir().unwrap();
    GitStore::init(replica_b_dir.path(), &test_git()).unwrap();
    let mut same_device = same_identity_alice(replica_b_dir.path());
    same_device
        .pull_from(&mut InProcessPeer::new(&pair.alice))
        .unwrap();
    let walked_before = same_device.local_commits_walked();
    let decoded_before = same_device.local_atoms_decoded();

    pair.alice.append_fixture_data(b"one-local-event").unwrap();
    same_device
        .pull_from(&mut InProcessPeer::new(&pair.alice))
        .unwrap();

    assert_eq!(same_device.local_commits_walked() - walked_before, 1);
    assert_eq!(same_device.local_atoms_decoded() - decoded_before, 1);
    same_device
        .append_fixture_data(b"cursor-remains-local")
        .unwrap();
}

#[test]
fn different_device_data_import_does_not_scan_fixture_events() {
    let mut pair = FixturePair::new();
    pair.alice.append_fixture_data(b"alice").unwrap();

    let first = pair
        .bob
        .pull_from(&mut InProcessPeer::new(&pair.alice))
        .unwrap();
    assert_eq!(first.data_refs_advanced, 1);
    assert_eq!(pair.bob.fixture_event_refresh_count(), 0);

    let second = pair
        .bob
        .pull_from(&mut InProcessPeer::new(&pair.alice))
        .unwrap();
    assert_eq!(second.data_refs_advanced, 0);
    assert_eq!(pair.bob.fixture_event_refresh_count(), 0);
}

struct DenyingPeer<'a>(InProcessPeer<'a>);
impl PeerEndpoint for DenyingPeer<'_> {
    fn hello(&mut self, hello: &Hello) -> Result<HelloAck, SyncError> {
        self.0.hello(hello)?;
        Ok(HelloAck::Denied)
    }
    fn advertise(
        &mut self,
        session: &SessionToken,
        project: ProjectId,
        plane: Plane,
    ) -> Result<RefAdvertisement, SyncError> {
        self.0.advertise(session, project, plane)
    }
    fn create_pack(
        &mut self,
        session: &SessionToken,
        project: ProjectId,
        request: &PackRequest,
        limits: &PackLimits,
    ) -> Result<PackBytes, SyncError> {
        self.0.create_pack(session, project, request, limits)
    }
}

#[test]
fn denied_ack_never_starts_history_service() {
    let mut pair = FixturePair::new();
    let mut peer = DenyingPeer(InProcessPeer::new(&pair.alice));
    assert_eq!(
        pair.bob.pull_from(&mut peer).unwrap_err().code,
        SyncErrorCode::AccessRevoked
    );
    assert_eq!(peer.0.hello_calls, 1);
    assert_eq!(peer.0.control_advertise_calls, 0);
    assert_eq!(peer.0.control_pack_calls, 0);
    assert_eq!(peer.0.data_advertise_calls, 0);
    assert_eq!(peer.0.data_pack_calls, 0);
    assert_eq!(pair.bob.fixture_event_refresh_count(), 0);
}

#[test]
fn offline_writes_converge_in_both_directions() {
    let mut pair = FixturePair::new();
    pair.alice.append_fixture_data(b"alice").unwrap();
    pair.bob
        .pull_from(&mut InProcessPeer::new(&pair.alice))
        .unwrap();
    pair.bob.append_fixture_data(b"bob").unwrap();
    pair.alice.append_fixture_data(b"alice-2").unwrap();
    pair.sync_both_directions().unwrap();
    assert_eq!(pair.alice.payloads(), pair.bob.payloads());
    assert_eq!(pair.alice.payloads().len(), 3);
    pair.alice
        .append_fixture_data(b"multi-head-frontier")
        .unwrap();
}

#[test]
fn local_first_parent_survives_an_observed_descendant_merge() {
    let mut pair = FixturePair::new();
    pair.bob
        .pull_from(&mut InProcessPeer::new(&pair.alice))
        .unwrap();

    pair.alice.append_fixture_data(b"a1").unwrap();
    pair.bob.append_fixture_data(b"b1").unwrap();
    pair.bob
        .pull_from(&mut InProcessPeer::new(&pair.alice))
        .unwrap();
    pair.bob.append_fixture_data(b"b2-observes-a1").unwrap();

    pair.alice
        .pull_from(&mut InProcessPeer::new(&pair.bob))
        .unwrap();
    pair.alice.append_fixture_data(b"a2-after-b2").unwrap();

    let report = pair
        .bob
        .pull_from(&mut InProcessPeer::new(&pair.alice))
        .unwrap();
    assert_eq!(report.data_refs_advanced, 1);
    assert_eq!(pair.alice.payloads(), pair.bob.payloads());
}

#[test]
fn hello_requires_exact_project_member_device_and_grant() {
    let pair = FixturePair::new();
    let valid = pair.bob.local_hello();
    assert_eq!(
        pair.alice.peer_access(&valid).unwrap(),
        AccessDecision::Allowed
    );
    for hello in [
        Hello {
            project_id: ProjectId::from_bytes([99; 16]),
            ..valid.clone()
        },
        Hello {
            member_id: pair.alice_identity.member_id,
            ..valid.clone()
        },
        Hello {
            device_id: pair.alice_identity.device_id,
            ..valid.clone()
        },
        Hello {
            grant_id: pair.alice_identity.grant_id,
            ..valid.clone()
        },
    ] {
        assert_eq!(
            pair.alice.peer_access(&hello).unwrap(),
            AccessDecision::Denied
        );
    }
    let mut endpoint = InProcessPeer::new(&pair.alice);
    let HelloAck::Allowed { session } = endpoint.hello(&valid).unwrap() else {
        panic!("valid hello must receive a session");
    };
    let error = endpoint
        .advertise(&session, ProjectId::from_bytes([99; 16]), Plane::Control)
        .unwrap_err();
    assert_eq!(error.code, SyncErrorCode::AccessRevoked);
}

#[test]
fn local_oversized_atom_is_rejected_before_store_append() {
    let mut pair = FixturePair::new();
    let error = pair
        .alice
        .append_fixture_data(&vec![0; (1 << 20) + 1])
        .unwrap_err();
    assert_eq!(error.code, SyncErrorCode::LimitExceeded);
}

fn signed_alice_data(
    project_id: ProjectId,
    control_frontier: Vec<GitOid>,
) -> yonalist_sync::SignedAtom {
    DeviceSigner::from_secret_bytes([8; 32])
        .sign(UnsignedAtom {
            schema: ATOM_SCHEMA_V1,
            project_id,
            event_id: EventId::from_bytes([90; 16]),
            plane: Plane::Data,
            actor_member_id: yonalist_sync::MemberId::from_bytes([2; 16]),
            actor_device_id: DeviceId::from_bytes([3; 16]),
            membership_grant_id: yonalist_sync::GrantId::from_bytes([4; 16]),
            control_frontier,
            data_frontier: vec![],
            display_time_ms: 0,
            payload: b"invalid-local".to_vec(),
        })
        .unwrap()
}

#[test]
fn local_append_rejects_foreign_stale_and_frontier_overflow_atoms() {
    let mut pair = FixturePair::new();
    for atom in [
        signed_alice_data(ProjectId::from_bytes([99; 16]), vec![]),
        signed_alice_data(ProjectId::from_bytes([1; 16]), vec![]),
    ] {
        assert_eq!(
            pair.alice
                .append_local(LocalBatch {
                    plane: Plane::Data,
                    atoms: vec![atom],
                    auxiliary_files: vec![]
                })
                .unwrap_err()
                .code,
            SyncErrorCode::InvalidAtom
        );
    }
    let heads = (0..33)
        .map(|n| GitOid::parse(&format!("{n:064x}")).unwrap())
        .collect();
    assert_eq!(
        pair.alice
            .append_local(LocalBatch {
                plane: Plane::Data,
                atoms: vec![signed_alice_data(ProjectId::from_bytes([1; 16]), heads)],
                auxiliary_files: vec![],
            })
            .unwrap_err()
            .code,
        SyncErrorCode::LimitExceeded
    );
}

struct AliasedRefPeer<'a> {
    inner: InProcessPeer<'a>,
    alias: DeviceId,
    requested_wants: usize,
}
impl PeerEndpoint for AliasedRefPeer<'_> {
    fn hello(&mut self, hello: &Hello) -> Result<HelloAck, SyncError> {
        self.inner.hello(hello)
    }
    fn advertise(
        &mut self,
        session: &SessionToken,
        project: ProjectId,
        plane: Plane,
    ) -> Result<RefAdvertisement, SyncError> {
        let mut advertised = self.inner.advertise(session, project, plane)?;
        if plane == Plane::Data {
            let head = advertised.refs.values().next().unwrap().clone();
            advertised.refs.insert(self.alias, head);
        }
        Ok(advertised)
    }
    fn create_pack(
        &mut self,
        session: &SessionToken,
        project: ProjectId,
        request: &PackRequest,
        limits: &PackLimits,
    ) -> Result<PackBytes, SyncError> {
        self.requested_wants = request.wants.len();
        self.inner.create_pack(session, project, request, limits)
    }
}

#[test]
fn advertised_device_must_own_first_parent_commits() {
    let mut pair = FixturePair::new();
    pair.alice.append_fixture_data(b"shared").unwrap();
    pair.bob
        .pull_from(&mut InProcessPeer::new(&pair.alice))
        .unwrap();
    let requested_wants = {
        let mut peer = AliasedRefPeer {
            inner: InProcessPeer::new(&pair.alice),
            alias: DeviceId::from_bytes([77; 16]),
            requested_wants: 0,
        };
        let report = pair.bob.pull_from(&mut peer).unwrap();
        assert_eq!(report.data_refs_advanced, 0);
        assert!(report.data_pack_bytes > 0);
        peer.requested_wants
    };
    assert_eq!(requested_wants, 1);
    assert!(!pair
        .bob
        .trusted_refs(Plane::Data)
        .unwrap()
        .refs
        .contains_key(&DeviceId::from_bytes([77; 16])));
    pair.bob
        .append_fixture_data(b"deduplicated-frontier")
        .unwrap();
}

#[test]
fn reopen_reconstructs_policy_and_fixture_event_sequence() {
    let mut pair = FixturePair::new();
    pair.alice.append_fixture_data(b"before-reopen").unwrap();
    pair.reopen_alice().unwrap();
    pair.alice.append_fixture_data(b"after-reopen").unwrap();
    let ids = pair.alice.event_ids(Plane::Data);
    assert_eq!(ids.len(), 2);
    assert_ne!(ids[0], ids[1]);
}

#[test]
fn empty_replica_imports_owner_grant_then_admin_revoke_in_causal_order() {
    let mut source = FixturePair::new();
    source
        .bob
        .pull_from(&mut InProcessPeer::new(&source.alice))
        .unwrap();
    source.bob.revoke(source.alice_identity.grant_id).unwrap();

    let mut receiver = FixturePair::new();
    let report = receiver
        .bob
        .pull_from(&mut InProcessPeer::new(&source.bob))
        .unwrap();
    assert_eq!(report.control_refs_advanced, 2);
    assert_eq!(
        source.bob.event_ids(Plane::Control),
        receiver.bob.event_ids(Plane::Control)
    );
}

#[test]
fn duplicate_local_control_transition_writes_no_objects_or_ref() {
    let mut pair = FixturePair::new();
    let before_refs = pair.alice.advertise(Plane::Control).unwrap().refs;
    let before_objects = pair.alice.loose_object_count();
    let revoke = FixtureControl::Revoke {
        grant_id: pair.bob_identity.grant_id,
    };
    let error = pair
        .alice
        .append_fixture_controls(vec![revoke.clone(), revoke])
        .unwrap_err();
    assert_eq!(error.code, SyncErrorCode::PolicyRejected);
    assert_eq!(
        pair.alice.advertise(Plane::Control).unwrap().refs,
        before_refs
    );
    assert_eq!(pair.alice.loose_object_count(), before_objects);
    pair.reopen_alice().unwrap();
    assert_eq!(
        pair.alice.advertise(Plane::Control).unwrap().refs,
        before_refs
    );
}

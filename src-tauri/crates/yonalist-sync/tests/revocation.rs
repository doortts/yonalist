#![cfg(feature = "test-support")]

use yonalist_sync::{
    AccessDecision, AccessState, AtomLimits, DeviceId, DeviceSigner, FixturePair, FixturePolicy,
    FixtureReplica, GitOid, GrantId, Hello, HelloAck, InProcessPeer, MemberId, PackBytes,
    PackLimits, PackRequest, PeerEndpoint, Plane, ProjectId, RefAdvertisement, Replica,
    ReplicaConfig, SessionToken, SignedAtom, SyncError, SyncErrorCode,
};

struct RemovalPeer {
    notice: SignedAtom,
    advertise_calls: usize,
    pack_calls: usize,
}

impl PeerEndpoint for RemovalPeer {
    fn hello(&mut self, _: &Hello) -> Result<HelloAck, SyncError> {
        Ok(HelloAck::RemovalOnly {
            notice: self.notice.clone(),
        })
    }

    fn advertise(
        &mut self,
        _: &SessionToken,
        _: ProjectId,
        _: Plane,
    ) -> Result<RefAdvertisement, SyncError> {
        self.advertise_calls += 1;
        panic!("a removal-only pull must not advertise history")
    }

    fn create_pack(
        &mut self,
        _: &SessionToken,
        _: ProjectId,
        _: &PackRequest,
        _: &PackLimits,
    ) -> Result<PackBytes, SyncError> {
        self.pack_calls += 1;
        panic!("a removal-only pull must not create a pack")
    }
}

fn revoke_notice(pair: &FixturePair) -> SignedAtom {
    match pair.alice.peer_access(&pair.bob.local_hello()).unwrap() {
        AccessDecision::RemovalOnly { notice } => notice,
        other => panic!("expected a removal notice, got {other:?}"),
    }
}

fn signed_like(
    notice: &SignedAtom,
    alter: impl FnOnce(&mut yonalist_sync::UnsignedAtom),
) -> SignedAtom {
    let mut unsigned = notice.unsigned.clone();
    alter(&mut unsigned);
    DeviceSigner::from_secret_bytes([8; 32])
        .sign(unsigned)
        .unwrap()
}

fn object_inventory(repository: &std::path::Path) -> Vec<String> {
    let output = std::process::Command::new(
        std::env::var_os("YONALIST_TEST_GIT").unwrap_or_else(|| "git".into()),
    )
    .arg(format!("--git-dir={}", repository.display()))
    .args([
        "cat-file",
        "--batch-all-objects",
        "--batch-check=%(objectname)",
    ])
    .output()
    .unwrap();
    assert!(output.status.success());
    let mut objects = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    objects.sort();
    objects
}

fn assert_rejected_without_history(label: &str, pair: &mut FixturePair, notice: SignedAtom) {
    let before_control = pair.bob.trusted_refs(Plane::Control).unwrap();
    let before_data = pair.bob.trusted_refs(Plane::Data).unwrap();
    let source_before_control = pair.alice.trusted_refs(Plane::Control).unwrap();
    let source_before_data = pair.alice.trusted_refs(Plane::Data).unwrap();
    let before_objects = object_inventory(pair.bob_repository());
    let lock = pair.bob.access_lock_path_for_test().to_path_buf();
    let mut peer = RemovalPeer {
        notice,
        advertise_calls: 0,
        pack_calls: 0,
    };
    assert!(
        pair.bob.pull_from(&mut peer).is_err(),
        "{label} was accepted"
    );
    assert_eq!(peer.advertise_calls, 0);
    assert_eq!(peer.pack_calls, 0);
    assert!(matches!(pair.bob.access_state(), AccessState::Active));
    assert_eq!(
        pair.bob.trusted_refs(Plane::Control).unwrap().refs,
        before_control.refs
    );
    assert_eq!(
        pair.bob.trusted_refs(Plane::Data).unwrap().refs,
        before_data.refs
    );
    assert_eq!(
        pair.alice.trusted_refs(Plane::Control).unwrap().refs,
        source_before_control.refs
    );
    assert_eq!(
        pair.alice.trusted_refs(Plane::Data).unwrap().refs,
        source_before_data.refs
    );
    assert_eq!(object_inventory(pair.bob_repository()), before_objects);
    assert!(!lock.exists());
}

#[test]
fn removed_client_receives_exact_notice_without_history() {
    let mut pair = FixturePair::new();
    pair.sync_both_directions().unwrap();
    let before_control = pair.bob.trusted_refs(Plane::Control).unwrap();
    let before_data = pair.bob.trusted_refs(Plane::Data).unwrap();
    pair.alice.revoke(pair.bob_identity.grant_id).unwrap();
    pair.alice
        .append_fixture_data(b"secret-after-revocation")
        .unwrap();
    let expected = revoke_notice(&pair);
    let source_control = pair.alice.trusted_refs(Plane::Control).unwrap();
    let source_data = pair.alice.trusted_refs(Plane::Data).unwrap();

    let mut endpoint = InProcessPeer::new(&pair.alice);
    assert_eq!(
        endpoint.hello(&pair.bob.local_hello()).unwrap(),
        HelloAck::RemovalOnly {
            notice: expected.clone()
        }
    );
    let report = pair.bob.pull_from(&mut endpoint).unwrap();

    assert_eq!(report.control_refs_advanced, 0);
    assert_eq!(report.data_refs_advanced, 0);
    assert_eq!(report.control_pack_bytes, 0);
    assert_eq!(report.data_pack_bytes, 0);
    assert_eq!(endpoint.control_advertise_calls, 0);
    assert_eq!(endpoint.data_advertise_calls, 0);
    assert_eq!(endpoint.control_pack_calls, 0);
    assert_eq!(endpoint.data_pack_calls, 0);
    assert_eq!(
        pair.bob.trusted_refs(Plane::Control).unwrap().refs,
        before_control.refs
    );
    assert_eq!(
        pair.bob.trusted_refs(Plane::Data).unwrap().refs,
        before_data.refs
    );
    assert_eq!(
        pair.alice.trusted_refs(Plane::Control).unwrap().refs,
        source_control.refs
    );
    assert_eq!(
        pair.alice.trusted_refs(Plane::Data).unwrap().refs,
        source_data.refs
    );
    assert!(matches!(
        pair.bob.access_state(),
        AccessState::Revoked { grant_id } if *grant_id == pair.bob_identity.grant_id
    ));
    assert!(!pair
        .bob
        .payloads()
        .contains(&b"secret-after-revocation".to_vec()));
}

#[test]
fn removal_only_never_advertises_or_packs_and_replay_is_idempotent() {
    let mut pair = FixturePair::new();
    pair.sync_both_directions().unwrap();
    let mut writer = pair.open_alice_copy().unwrap();
    writer.revoke(pair.bob_identity.grant_id).unwrap();
    let notice = revoke_notice(&pair);

    let mut peer = RemovalPeer {
        notice: notice.clone(),
        advertise_calls: 0,
        pack_calls: 0,
    };
    let first = pair.bob.pull_from(&mut peer).unwrap();
    let second = pair.bob.pull_from(&mut peer).unwrap();
    assert_eq!(first.control_refs_advanced + first.data_refs_advanced, 0);
    assert_eq!(second.control_refs_advanced + second.data_refs_advanced, 0);
    assert_eq!(peer.advertise_calls, 0);
    assert_eq!(peer.pack_calls, 0);
}

#[test]
fn allowed_token_is_bound_to_endpoint_and_current_membership() {
    let pair = FixturePair::new();
    let mut first_endpoint = InProcessPeer::new(&pair.alice);
    let mut second_endpoint = InProcessPeer::new(&pair.alice);
    let HelloAck::Allowed { session: first } =
        first_endpoint.hello(&pair.bob.local_hello()).unwrap()
    else {
        panic!("bob should initially be allowed");
    };
    let HelloAck::Allowed { session: second } =
        second_endpoint.hello(&pair.bob.local_hello()).unwrap()
    else {
        panic!("bob should initially be allowed");
    };
    assert_ne!(first, second);
    first_endpoint
        .advertise(&first, ProjectId::from_bytes([1; 16]), Plane::Control)
        .unwrap();
    second_endpoint
        .advertise(&second, ProjectId::from_bytes([1; 16]), Plane::Control)
        .unwrap();
    assert_eq!(
        first_endpoint
            .advertise(&second, ProjectId::from_bytes([1; 16]), Plane::Control)
            .unwrap_err()
            .code,
        SyncErrorCode::AccessRevoked
    );
    assert_eq!(
        second_endpoint
            .create_pack(
                &first,
                ProjectId::from_bytes([1; 16]),
                &PackRequest {
                    plane: Plane::Control,
                    wants: vec![],
                    haves: vec![],
                },
                &PackLimits::default(),
            )
            .unwrap_err()
            .code,
        SyncErrorCode::AccessRevoked
    );

    let HelloAck::Allowed { session: second } =
        first_endpoint.hello(&pair.bob.local_hello()).unwrap()
    else {
        panic!("bob should initially be allowed");
    };
    assert_ne!(first, second);
    assert_eq!(
        first_endpoint
            .advertise(&first, ProjectId::from_bytes([1; 16]), Plane::Control)
            .unwrap_err()
            .code,
        SyncErrorCode::AccessRevoked
    );

    let mut wrong_tuple = pair.bob.local_hello();
    wrong_tuple.device_id = pair.alice_identity.device_id;
    assert!(matches!(
        first_endpoint.hello(&wrong_tuple).unwrap(),
        HelloAck::Denied
    ));
    assert_eq!(
        first_endpoint
            .advertise(&second, ProjectId::from_bytes([1; 16]), Plane::Control)
            .unwrap_err()
            .code,
        SyncErrorCode::AccessRevoked
    );

    let HelloAck::Allowed { session } = first_endpoint.hello(&pair.bob.local_hello()).unwrap()
    else {
        panic!("bob should initially be allowed");
    };
    let mut writer = pair.open_alice_copy().unwrap();
    writer.revoke(pair.bob_identity.grant_id).unwrap();
    assert_eq!(
        first_endpoint
            .advertise(&session, ProjectId::from_bytes([1; 16]), Plane::Data)
            .unwrap_err()
            .code,
        SyncErrorCode::AccessRevoked
    );
    assert_eq!(
        first_endpoint
            .create_pack(
                &session,
                ProjectId::from_bytes([1; 16]),
                &PackRequest {
                    plane: Plane::Data,
                    wants: vec![],
                    haves: vec![]
                },
                &PackLimits::default(),
            )
            .unwrap_err()
            .code,
        SyncErrorCode::AccessRevoked
    );
}

#[test]
fn production_transport_can_supply_an_opaque_random_session_capability() {
    let token = SessionToken::from_bytes([42; 32]);
    assert_eq!(format!("{token:?}"), "SessionToken([redacted])");
}

#[test]
fn valid_notice_survives_reopen_and_rejects_local_append() {
    let mut pair = FixturePair::new();
    pair.sync_both_directions().unwrap();
    pair.bob.append_fixture_data(b"before-lock").unwrap();
    let before = pair.bob.payloads();
    pair.alice.revoke(pair.bob_identity.grant_id).unwrap();
    pair.bob
        .pull_from(&mut InProcessPeer::new(&pair.alice))
        .unwrap();
    pair.reopen_bob().unwrap();

    assert!(matches!(
        pair.bob.access_state(),
        AccessState::Revoked { .. }
    ));
    assert_eq!(pair.bob.payloads(), before);
    assert_eq!(
        pair.bob
            .append_fixture_data(b"after-lock")
            .unwrap_err()
            .code,
        SyncErrorCode::AccessRevoked
    );
}

#[test]
fn invalid_notice_leaves_access_and_refs_unchanged() {
    let mut pair = FixturePair::new();
    pair.sync_both_directions().unwrap();
    pair.alice.revoke(pair.bob_identity.grant_id).unwrap();
    let valid = revoke_notice(&pair);
    let before_control = pair.bob.trusted_refs(Plane::Control).unwrap();
    let before_data = pair.bob.trusted_refs(Plane::Data).unwrap();

    let mut altered = valid.unsigned.clone();
    altered.project_id = ProjectId::from_bytes([99; 16]);
    let wrong_project = DeviceSigner::from_secret_bytes([8; 32])
        .sign(altered)
        .unwrap();
    let mut peer = RemovalPeer {
        notice: wrong_project,
        advertise_calls: 0,
        pack_calls: 0,
    };
    assert_eq!(
        pair.bob.pull_from(&mut peer).unwrap_err().code,
        SyncErrorCode::InvalidAtom
    );
    assert_eq!(peer.advertise_calls, 0);
    assert_eq!(peer.pack_calls, 0);
    assert!(matches!(pair.bob.access_state(), AccessState::Active));
    assert_eq!(
        pair.bob.trusted_refs(Plane::Control).unwrap().refs,
        before_control.refs
    );
    assert_eq!(
        pair.bob.trusted_refs(Plane::Data).unwrap().refs,
        before_data.refs
    );
}

#[test]
fn notice_with_wrong_target_grant_is_rejected_by_policy() {
    let mut pair = FixturePair::new();
    pair.sync_both_directions().unwrap();
    // The owner-revoke has the same prior frontier as Bob, but its payload
    // targets Alice's grant.  The actor grant remains Alice's owner grant.
    pair.alice.revoke(pair.alice_identity.grant_id).unwrap();
    let wrong_target = match pair.alice.peer_access(&pair.alice.local_hello()).unwrap() {
        AccessDecision::RemovalOnly { notice } => notice,
        other => panic!("expected owner removal notice, got {other:?}"),
    };
    assert_ne!(
        wrong_target.unsigned.membership_grant_id,
        pair.bob_identity.grant_id
    );
    assert_rejected_without_history("wrong target", &mut pair, wrong_target);
}

#[test]
fn notice_with_wrong_signer_or_data_plane_is_rejected() {
    let mut pair = FixturePair::new();
    pair.sync_both_directions().unwrap();
    pair.alice.revoke(pair.bob_identity.grant_id).unwrap();
    let notice = revoke_notice(&pair);
    let wrong_signer = DeviceSigner::from_secret_bytes([9; 32])
        .sign(notice.unsigned.clone())
        .unwrap();
    assert_rejected_without_history("wrong signer", &mut pair, wrong_signer);

    let mut fresh = FixturePair::new();
    fresh.sync_both_directions().unwrap();
    fresh.alice.revoke(fresh.bob_identity.grant_id).unwrap();
    let data_plane = signed_like(&revoke_notice(&fresh), |unsigned| {
        unsigned.plane = Plane::Data
    });
    assert_rejected_without_history("data plane", &mut fresh, data_plane);
}

#[test]
fn notice_with_random_stale_ahead_or_redundant_frontier_is_rejected() {
    let make_pair = || {
        let mut pair = FixturePair::new();
        pair.sync_both_directions().unwrap();
        pair.alice.revoke(pair.bob_identity.grant_id).unwrap();
        pair
    };

    let mut random = make_pair();
    let random_notice = signed_like(&revoke_notice(&random), |unsigned| {
        unsigned.control_frontier = vec![GitOid::parse(&"9".repeat(64)).unwrap()];
    });
    assert_rejected_without_history("random", &mut random, random_notice);

    let mut stale = make_pair();
    let stale_notice = signed_like(&revoke_notice(&stale), |unsigned| {
        unsigned.control_frontier.clear()
    });
    assert_rejected_without_history("stale", &mut stale, stale_notice);

    let mut ahead = make_pair();
    let ahead_head = ahead
        .alice
        .trusted_refs(Plane::Control)
        .unwrap()
        .refs
        .into_values()
        .next()
        .unwrap();
    let ahead_notice = signed_like(&revoke_notice(&ahead), |unsigned| {
        unsigned.control_frontier = vec![ahead_head];
    });
    assert_rejected_without_history("ahead", &mut ahead, ahead_notice);

    let mut redundant = make_pair();
    // DeviceSigner deliberately normalizes signed frontiers, so construct the
    // malformed received representation directly.  `SignedAtom::encode` must
    // reject it before any policy or Git operation.
    let mut redundant_notice = revoke_notice(&redundant);
    redundant_notice
        .unsigned
        .control_frontier
        .push(redundant_notice.unsigned.control_frontier[0].clone());
    assert_rejected_without_history("noncanonical redundant", &mut redundant, redundant_notice);
}

#[test]
fn lock_failure_before_replace_preserves_prior_state_and_after_replace_recovers_revoked() {
    let mut before = FixturePair::new();
    before.sync_both_directions().unwrap();
    before.alice.revoke(before.bob_identity.grant_id).unwrap();
    let notice = revoke_notice(&before);
    let lock = before.bob.access_lock_path_for_test().to_path_buf();
    before.bob.fail_access_lock_before_replace_once_for_test();
    let mut peer = RemovalPeer {
        notice,
        advertise_calls: 0,
        pack_calls: 0,
    };
    assert_eq!(
        before.bob.pull_from(&mut peer).unwrap_err().code,
        SyncErrorCode::Io
    );
    assert!(!lock.exists());
    assert!(matches!(before.bob.access_state(), AccessState::Active));

    let mut after = FixturePair::new();
    after.sync_both_directions().unwrap();
    after.alice.revoke(after.bob_identity.grant_id).unwrap();
    let notice = revoke_notice(&after);
    after.bob.fail_access_lock_after_replace_once_for_test();
    let mut peer = RemovalPeer {
        notice,
        advertise_calls: 0,
        pack_calls: 0,
    };
    assert_eq!(
        after.bob.pull_from(&mut peer).unwrap_err().code,
        SyncErrorCode::Io
    );
    assert!(after.bob.access_lock_path_for_test().exists());
    assert!(matches!(
        after.bob.access_state(),
        AccessState::Revoked { .. }
    ));
    assert_eq!(
        after
            .bob
            .append_fixture_data(b"after-published-lock-error")
            .unwrap_err()
            .code,
        SyncErrorCode::AccessRevoked
    );
}

#[test]
fn identical_existing_lock_retries_the_directory_durability_barrier() {
    let mut pair = FixturePair::new();
    pair.sync_both_directions().unwrap();
    pair.alice.revoke(pair.bob_identity.grant_id).unwrap();
    let notice = revoke_notice(&pair);
    let before_control = pair.bob.trusted_refs(Plane::Control).unwrap();
    let before_data = pair.bob.trusted_refs(Plane::Data).unwrap();
    let before_objects = object_inventory(pair.bob_repository());
    let mut peer = RemovalPeer {
        notice,
        advertise_calls: 0,
        pack_calls: 0,
    };

    pair.bob.fail_access_lock_after_replace_once_for_test();
    assert_eq!(
        pair.bob.pull_from(&mut peer).unwrap_err().code,
        SyncErrorCode::Io
    );
    assert!(pair.bob.access_lock_path_for_test().exists());
    assert!(matches!(
        pair.bob.access_state(),
        AccessState::Revoked { .. }
    ));

    pair.bob.fail_access_lock_directory_barrier_once_for_test();
    assert_eq!(
        pair.bob.pull_from(&mut peer).unwrap_err().code,
        SyncErrorCode::Io
    );
    assert!(matches!(
        pair.bob.access_state(),
        AccessState::Revoked { .. }
    ));
    assert_eq!(
        pair.bob.trusted_refs(Plane::Control).unwrap().refs,
        before_control.refs
    );
    assert_eq!(
        pair.bob.trusted_refs(Plane::Data).unwrap().refs,
        before_data.refs
    );
    assert_eq!(object_inventory(pair.bob_repository()), before_objects);
    assert_eq!(peer.advertise_calls, 0);
    assert_eq!(peer.pack_calls, 0);

    let report = pair.bob.pull_from(&mut peer).unwrap();
    assert_eq!(report.control_refs_advanced + report.data_refs_advanced, 0);
    assert!(matches!(
        pair.bob.access_state(),
        AccessState::Revoked { .. }
    ));
}

#[test]
fn a_lock_persisted_by_one_live_handle_blocks_stale_append_and_pull() {
    let mut pair = FixturePair::new();
    pair.sync_both_directions().unwrap();
    let mut stale = pair.open_bob_copy().unwrap();
    pair.alice.revoke(pair.bob_identity.grant_id).unwrap();
    pair.bob
        .pull_from(&mut InProcessPeer::new(&pair.alice))
        .unwrap();
    assert!(matches!(
        stale.peer_access(&pair.alice.local_hello()).unwrap(),
        AccessDecision::Denied
    ));

    let mut allowed_source = FixturePair::new();
    allowed_source.sync_both_directions().unwrap();
    allowed_source
        .alice
        .append_fixture_data(b"must-not-import")
        .unwrap();
    let before_control = stale.trusted_refs(Plane::Control).unwrap();
    let before_data = stale.trusted_refs(Plane::Data).unwrap();
    let before_objects = object_inventory(pair.bob_repository());
    let mut endpoint = InProcessPeer::new(&allowed_source.alice);
    assert_eq!(
        stale.pull_from(&mut endpoint).unwrap_err().code,
        SyncErrorCode::AccessRevoked
    );
    assert_eq!(endpoint.hello_calls, 0);
    assert_eq!(
        stale.trusted_refs(Plane::Control).unwrap().refs,
        before_control.refs
    );
    assert_eq!(
        stale.trusted_refs(Plane::Data).unwrap().refs,
        before_data.refs
    );
    assert_eq!(object_inventory(pair.bob_repository()), before_objects);
    assert_eq!(
        stale.append_fixture_data(b"stale-append").unwrap_err().code,
        SyncErrorCode::AccessRevoked
    );
    assert!(matches!(stale.access_state(), AccessState::Revoked { .. }));
}

struct LockDuringPack<'source, 'locker> {
    delegate: InProcessPeer<'source>,
    locker: &'locker mut FixtureReplica,
    notice: Option<SignedAtom>,
}

impl PeerEndpoint for LockDuringPack<'_, '_> {
    fn hello(&mut self, hello: &Hello) -> Result<HelloAck, SyncError> {
        self.delegate.hello(hello)
    }

    fn advertise(
        &mut self,
        session: &SessionToken,
        project: ProjectId,
        plane: Plane,
    ) -> Result<RefAdvertisement, SyncError> {
        self.delegate.advertise(session, project, plane)
    }

    fn create_pack(
        &mut self,
        session: &SessionToken,
        project: ProjectId,
        request: &PackRequest,
        limits: &PackLimits,
    ) -> Result<PackBytes, SyncError> {
        let pack = self
            .delegate
            .create_pack(session, project, request, limits)?;
        if let Some(notice) = self.notice.take() {
            self.locker.pull_from(&mut RemovalPeer {
                notice,
                advertise_calls: 0,
                pack_calls: 0,
            })?;
        }
        Ok(pack)
    }
}

#[test]
fn pull_rechecks_a_concurrently_published_lock_before_import() {
    let mut local = FixturePair::new();
    local.sync_both_directions().unwrap();
    let mut stale = local.open_bob_copy().unwrap();
    local.alice.revoke(local.bob_identity.grant_id).unwrap();
    let notice = revoke_notice(&local);

    let mut allowed_source = FixturePair::new();
    allowed_source.sync_both_directions().unwrap();
    allowed_source
        .alice
        .append_fixture_data(b"racing-pack")
        .unwrap();
    let before = stale.trusted_refs(Plane::Data).unwrap();
    let before_objects = object_inventory(local.bob_repository());
    let mut endpoint = LockDuringPack {
        delegate: InProcessPeer::new(&allowed_source.alice),
        locker: &mut local.bob,
        notice: Some(notice),
    };

    assert_eq!(
        stale.pull_from(&mut endpoint).unwrap_err().code,
        SyncErrorCode::AccessRevoked
    );
    assert_eq!(stale.trusted_refs(Plane::Data).unwrap().refs, before.refs);
    assert_eq!(object_inventory(local.bob_repository()), before_objects);
    assert!(matches!(stale.access_state(), AccessState::Revoked { .. }));
}

#[cfg(unix)]
#[test]
fn access_lock_is_private_on_unix() {
    use std::os::unix::fs::PermissionsExt;

    let mut pair = FixturePair::new();
    pair.sync_both_directions().unwrap();
    pair.alice.revoke(pair.bob_identity.grant_id).unwrap();
    pair.bob
        .pull_from(&mut InProcessPeer::new(&pair.alice))
        .unwrap();
    let mode = std::fs::metadata(pair.bob.access_lock_path_for_test())
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o600);
}

#[test]
fn malformed_or_mismatched_private_lock_fails_closed() {
    let mut pair = FixturePair::new();
    pair.sync_both_directions().unwrap();
    let stale = pair.open_bob_copy().unwrap();
    pair.alice.revoke(pair.bob_identity.grant_id).unwrap();
    pair.bob
        .pull_from(&mut InProcessPeer::new(&pair.alice))
        .unwrap();
    let lock = pair.bob.access_lock_path_for_test().to_path_buf();
    std::fs::write(&lock, [0x80]).unwrap();
    assert_eq!(
        stale
            .peer_access(&pair.alice.local_hello())
            .unwrap_err()
            .code,
        SyncErrorCode::InvalidAtom
    );
    assert_eq!(
        pair.reopen_bob().unwrap_err().code,
        SyncErrorCode::InvalidAtom
    );

    // Restore a valid record in a fresh repository, then open it with another
    // local member binding.  The private record is never transferable.
    let mut mismatch = FixturePair::new();
    mismatch.sync_both_directions().unwrap();
    mismatch
        .alice
        .revoke(mismatch.bob_identity.grant_id)
        .unwrap();
    mismatch
        .bob
        .pull_from(&mut InProcessPeer::new(&mismatch.alice))
        .unwrap();
    let config = ReplicaConfig {
        repository: mismatch.bob_repository().into(),
        git_executable: std::env::var_os("YONALIST_TEST_GIT")
            .map(Into::into)
            .unwrap_or_else(|| "git".into()),
        project_id: ProjectId::from_bytes([1; 16]),
        local_member_id: MemberId::from_bytes([42; 16]),
        local_device_id: DeviceId::from_bytes([43; 16]),
        local_grant_id: GrantId::from_bytes([44; 16]),
        atom_limits: AtomLimits {
            max_payload_bytes: 1 << 20,
            max_frontier_heads: 32,
        },
        pack_limits: PackLimits::default(),
    };
    let policy = FixturePolicy::new(
        mismatch.alice_identity.member_id,
        mismatch.alice_identity.device_id,
        mismatch.alice_identity.grant_id,
        DeviceSigner::from_secret_bytes([8; 32]).public_key(),
    );
    let error = match Replica::open(config, policy) {
        Ok(_) => panic!("mismatched access lock must fail closed"),
        Err(error) => error,
    };
    assert_eq!(error.code, SyncErrorCode::InvalidAtom);
}

#[test]
fn private_lock_never_enters_git_refs_trees_or_objects() {
    let mut pair = FixturePair::new();
    pair.sync_both_directions().unwrap();
    pair.alice.revoke(pair.bob_identity.grant_id).unwrap();
    pair.bob
        .pull_from(&mut InProcessPeer::new(&pair.alice))
        .unwrap();
    let run_git = |repo: &std::path::Path, args: &[&str]| {
        std::process::Command::new(
            std::env::var_os("YONALIST_TEST_GIT").unwrap_or_else(|| "git".into()),
        )
        .arg(format!("--git-dir={}", repo.display()))
        .args(args)
        .output()
        .unwrap()
    };
    for repo in [pair.alice_repository(), pair.bob_repository()] {
        let refs = run_git(repo, &["for-each-ref"]);
        let objects = run_git(repo, &["rev-list", "--objects", "--all"]);
        assert!(refs.status.success());
        assert!(objects.status.success());
        assert!(!String::from_utf8_lossy(&refs.stdout).contains("yonalist-private"));
        assert!(!String::from_utf8_lossy(&objects.stdout).contains("yonalist-private"));
    }
}

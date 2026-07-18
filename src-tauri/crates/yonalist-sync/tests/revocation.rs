#![cfg(feature = "test-support")]

use yonalist_sync::{
    AccessDecision, AccessState, FixtureControl, Hello, InProcessPeer, PackLimits, PackRequest,
    PeerEndpoint, Plane, ProjectId, SyncErrorCode,
};

#[test]
fn removed_client_receives_control_notice_but_no_data() {
    let mut pair = yonalist_sync::FixturePair::new();
    pair.sync_both_directions().unwrap();
    pair.alice.revoke(pair.bob_identity.grant_id).unwrap();
    pair.alice
        .append_fixture_data(b"secret-after-revocation")
        .unwrap();

    let mut endpoint = InProcessPeer::new(&pair.alice);
    let report = pair.bob.pull_from(&mut endpoint).unwrap();

    assert!(
        matches!(report.access_state, AccessState::Revoked { grant_id } if grant_id == pair.bob_identity.grant_id)
    );
    assert_eq!(report.control_refs_advanced, 1);
    assert_eq!(report.data_refs_advanced, 0);
    assert_eq!(report.data_pack_bytes, 0);
    assert_eq!(endpoint.data_advertise_calls, 0);
    assert_eq!(endpoint.data_pack_calls, 0);
    assert!(!pair
        .bob
        .payloads()
        .contains(&b"secret-after-revocation".to_vec()));
}

#[test]
fn revoked_requester_is_control_only_and_session_is_required() {
    let mut pair = yonalist_sync::FixturePair::new();
    pair.alice.revoke(pair.bob_identity.grant_id).unwrap();
    let mut endpoint = InProcessPeer::new(&pair.alice);

    assert_eq!(
        endpoint
            .advertise(ProjectId::from_bytes([1; 16]), Plane::Control)
            .unwrap_err()
            .code,
        SyncErrorCode::AccessRevoked
    );
    let pre_hello_head = pair
        .alice
        .advertise(Plane::Control)
        .unwrap()
        .refs
        .values()
        .next()
        .unwrap()
        .clone();
    assert_eq!(
        endpoint
            .create_pack(
                ProjectId::from_bytes([1; 16]),
                &PackRequest {
                    plane: Plane::Control,
                    wants: vec![pre_hello_head],
                    haves: vec![]
                },
                &PackLimits {
                    max_pack_bytes: 1 << 24,
                    max_advertised_refs: 32,
                    max_atoms_per_head: 256,
                    ..PackLimits::default()
                },
            )
            .unwrap_err()
            .code,
        SyncErrorCode::AccessRevoked
    );
    let ack = endpoint.hello(&pair.bob.local_hello()).unwrap();
    assert!(matches!(ack.decision, AccessDecision::ControlOnly { .. }));
    assert_eq!(
        endpoint
            .advertise(ProjectId::from_bytes([1; 16]), Plane::Data)
            .unwrap_err()
            .code,
        SyncErrorCode::AccessRevoked
    );
    assert_eq!(
        endpoint
            .create_pack(
                ProjectId::from_bytes([1; 16]),
                &PackRequest {
                    plane: Plane::Data,
                    wants: vec![],
                    haves: vec![]
                },
                &PackLimits {
                    max_pack_bytes: 1 << 24,
                    max_advertised_refs: 32,
                    max_atoms_per_head: 256,
                    ..PackLimits::default()
                },
            )
            .unwrap_err()
            .code,
        SyncErrorCode::AccessRevoked
    );
}

#[test]
fn hello_authorization_cannot_be_reused_for_another_project_or_tuple() {
    let pair = yonalist_sync::FixturePair::new();
    let mut endpoint = InProcessPeer::new(&pair.alice);
    endpoint.hello(&pair.bob.local_hello()).unwrap();

    assert_eq!(
        endpoint
            .advertise(ProjectId::from_bytes([9; 16]), Plane::Control)
            .unwrap_err()
            .code,
        SyncErrorCode::AccessRevoked
    );
    let mut changed = pair.bob.local_hello();
    changed.device_id = pair.alice_identity.device_id;
    endpoint.hello(&changed).unwrap();
    assert_eq!(
        endpoint
            .advertise(ProjectId::from_bytes([1; 16]), Plane::Data)
            .unwrap_err()
            .code,
        SyncErrorCode::AccessRevoked
    );
}

#[test]
fn control_only_cannot_request_hidden_control_ancestor() {
    let mut pair = yonalist_sync::FixturePair::new();
    let hidden = pair
        .alice
        .advertise(Plane::Control)
        .unwrap()
        .refs
        .values()
        .next()
        .unwrap()
        .clone();
    pair.alice.revoke(pair.bob_identity.grant_id).unwrap();
    let mut endpoint = InProcessPeer::new(&pair.alice);
    endpoint.hello(&pair.bob.local_hello()).unwrap();
    let advertised = endpoint
        .advertise(ProjectId::from_bytes([1; 16]), Plane::Control)
        .unwrap();
    assert!(!advertised.refs.values().any(|head| head == &hidden));

    let error = endpoint
        .create_pack(
            ProjectId::from_bytes([1; 16]),
            &PackRequest {
                plane: Plane::Control,
                wants: vec![hidden],
                haves: vec![],
            },
            &PackLimits {
                max_pack_bytes: 1 << 24,
                max_advertised_refs: 32,
                max_atoms_per_head: 256,
                ..PackLimits::default()
            },
        )
        .unwrap_err();
    assert_eq!(error.code, SyncErrorCode::AccessRevoked);
}

#[test]
fn denied_requester_shares_neither_plane() {
    let pair = yonalist_sync::FixturePair::new();
    let mut endpoint = InProcessPeer::new(&pair.alice);
    let mut denied: Hello = pair.bob.local_hello();
    denied.member_id = pair.alice_identity.member_id;
    assert!(matches!(
        endpoint.hello(&denied).unwrap().decision,
        AccessDecision::Denied
    ));
    for plane in [Plane::Control, Plane::Data] {
        assert_eq!(
            endpoint
                .advertise(ProjectId::from_bytes([1; 16]), plane)
                .unwrap_err()
                .code,
            SyncErrorCode::AccessRevoked
        );
    }
}

#[test]
fn allowed_session_still_shares_control_and_data() {
    let mut pair = yonalist_sync::FixturePair::new();
    pair.alice.append_fixture_data(b"allowed-data").unwrap();
    let mut endpoint = InProcessPeer::new(&pair.alice);

    let report = pair.bob.pull_from(&mut endpoint).unwrap();

    assert!(matches!(report.access_state, AccessState::Active));
    assert_eq!(report.data_refs_advanced, 1);
    assert_eq!(endpoint.data_advertise_calls, 1);
    assert_eq!(endpoint.data_pack_calls, 1);
    assert!(pair.bob.payloads().contains(&b"allowed-data".to_vec()));
}

#[test]
fn local_revocation_is_sticky_and_rejects_append_without_deleting_data() {
    let mut pair = yonalist_sync::FixturePair::new();
    pair.sync_both_directions().unwrap();
    pair.bob.append_fixture_data(b"before-lock").unwrap();
    let before = pair.bob.payloads();
    pair.alice.revoke(pair.bob_identity.grant_id).unwrap();
    pair.bob
        .pull_from(&mut InProcessPeer::new(&pair.alice))
        .unwrap();

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
fn authorization_is_refreshed_after_shared_repository_revocation() {
    let mut pair = yonalist_sync::FixturePair::new();
    pair.alice
        .append_fixture_data(b"before-revocation")
        .unwrap();
    let data_head = pair
        .alice
        .advertise(Plane::Data)
        .unwrap()
        .refs
        .into_values()
        .next()
        .unwrap();
    let mut writer = pair.open_alice_copy().unwrap();
    let mut endpoint = InProcessPeer::new(&pair.alice);
    assert!(matches!(
        endpoint.hello(&pair.bob.local_hello()).unwrap().decision,
        AccessDecision::Allowed
    ));

    writer.revoke(pair.bob_identity.grant_id).unwrap();

    assert_eq!(
        endpoint
            .advertise(ProjectId::from_bytes([1; 16]), Plane::Data)
            .unwrap_err()
            .code,
        SyncErrorCode::AccessRevoked
    );
    assert_eq!(
        endpoint
            .create_pack(
                ProjectId::from_bytes([1; 16]),
                &PackRequest {
                    plane: Plane::Data,
                    wants: vec![data_head],
                    haves: vec![],
                },
                &PackLimits {
                    max_pack_bytes: 1 << 24,
                    max_advertised_refs: 32,
                    max_atoms_per_head: 256,
                    ..PackLimits::default()
                },
            )
            .unwrap_err()
            .code,
        SyncErrorCode::AccessRevoked
    );

    let control = endpoint
        .advertise(ProjectId::from_bytes([1; 16]), Plane::Control)
        .unwrap();
    let notice_head = control.refs.into_values().next().unwrap();
    endpoint
        .create_pack(
            ProjectId::from_bytes([1; 16]),
            &PackRequest {
                plane: Plane::Control,
                wants: vec![notice_head],
                haves: vec![],
            },
            &PackLimits {
                max_pack_bytes: 1 << 24,
                max_advertised_refs: 32,
                max_atoms_per_head: 256,
                ..PackLimits::default()
            },
        )
        .unwrap();
}

#[test]
fn control_only_rejects_unrelated_have_but_accepts_notice_ancestor() {
    let mut pair = yonalist_sync::FixturePair::new();
    pair.alice.append_fixture_data(b"hidden-data").unwrap();
    let unrelated = pair
        .alice
        .advertise(Plane::Data)
        .unwrap()
        .refs
        .into_values()
        .next()
        .unwrap();
    let ancestor = pair
        .alice
        .advertise(Plane::Control)
        .unwrap()
        .refs
        .into_values()
        .next()
        .unwrap();
    pair.alice.revoke(pair.bob_identity.grant_id).unwrap();
    let mut endpoint = InProcessPeer::new(&pair.alice);
    endpoint.hello(&pair.bob.local_hello()).unwrap();
    let notice_head = endpoint
        .advertise(ProjectId::from_bytes([1; 16]), Plane::Control)
        .unwrap()
        .refs
        .into_values()
        .next()
        .unwrap();
    let limits = PackLimits {
        max_pack_bytes: 1 << 24,
        max_advertised_refs: 32,
        max_atoms_per_head: 256,
        ..PackLimits::default()
    };

    assert_eq!(
        endpoint
            .create_pack(
                ProjectId::from_bytes([1; 16]),
                &PackRequest {
                    plane: Plane::Control,
                    wants: vec![notice_head.clone()],
                    haves: vec![unrelated],
                },
                &limits,
            )
            .unwrap_err()
            .code,
        SyncErrorCode::AccessRevoked
    );
    endpoint
        .create_pack(
            ProjectId::from_bytes([1; 16]),
            &PackRequest {
                plane: Plane::Control,
                wants: vec![notice_head],
                haves: vec![ancestor],
            },
            &limits,
        )
        .unwrap();
}

#[test]
fn failed_second_hello_clears_prior_allowed_capability() {
    let pair = yonalist_sync::FixturePair::new();
    let mut writer = pair.open_alice_copy().unwrap();
    let mut endpoint = InProcessPeer::new(&pair.alice);
    let hello = pair.bob.local_hello();
    assert!(matches!(
        endpoint.hello(&hello).unwrap().decision,
        AccessDecision::Allowed
    ));
    writer
        .append_unchecked_fixture_control(FixtureControl::Revoke {
            grant_id: yonalist_sync::GrantId::from_bytes([99; 16]),
        })
        .unwrap();

    assert_eq!(
        endpoint.hello(&hello).unwrap_err().code,
        SyncErrorCode::PolicyRejected
    );
    assert_eq!(
        endpoint
            .advertise(ProjectId::from_bytes([1; 16]), Plane::Data)
            .unwrap_err()
            .code,
        SyncErrorCode::AccessRevoked
    );
}

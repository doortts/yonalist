use std::{env, path::PathBuf};

use yonalist_sync::{
    AccessDecision, AccessState, AtomLimits, CandidateRef, DeviceId, DeviceSigner, EventId,
    GitStore, PackLimits, PackRequest, Plane, ProjectPolicy, SignedAtom, StoreBatch, StoredAtom,
    UnsignedAtom, ATOM_SCHEMA_V1,
};

fn git() -> PathBuf {
    env::var_os("YONALIST_TEST_GIT")
        .map(PathBuf::from)
        .unwrap_or_else(|| "git".into())
}

fn atom(payload: &[u8], event: u8) -> SignedAtom {
    DeviceSigner::from_secret_bytes([9; 32])
        .sign(UnsignedAtom {
            schema: ATOM_SCHEMA_V1,
            project_id: yonalist_sync::ProjectId::from_bytes([1; 16]),
            event_id: EventId::from_bytes([event; 16]),
            plane: Plane::Data,
            actor_member_id: yonalist_sync::MemberId::from_bytes([2; 16]),
            actor_device_id: DeviceId::from_bytes([3; 16]),
            membership_grant_id: yonalist_sync::GrantId::from_bytes([4; 16]),
            control_frontier: vec![],
            data_frontier: vec![],
            display_time_ms: 0,
            payload: payload.to_vec(),
        })
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
impl ProjectPolicy for Allow {
    type State = ();
    fn rebuild_control(&self, _: &[StoredAtom]) -> Result<(), yonalist_sync::SyncError> {
        Ok(())
    }
    fn validate_control(&self, _: &(), _: &StoredAtom) -> Result<(), yonalist_sync::SyncError> {
        Ok(())
    }
    fn validate_data(&self, _: &(), _: &StoredAtom) -> Result<(), yonalist_sync::SyncError> {
        Ok(())
    }
    fn peer_access(
        &self,
        _: &(),
        _: yonalist_sync::MemberId,
        _: yonalist_sync::GrantId,
    ) -> AccessDecision {
        AccessDecision::Allowed
    }
    fn local_access(
        &self,
        _: &(),
        _: yonalist_sync::MemberId,
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
    fn validate_control(&self, _: &(), _: &StoredAtom) -> Result<(), yonalist_sync::SyncError> {
        Ok(())
    }
    fn validate_data(&self, _: &(), atom: &StoredAtom) -> Result<(), yonalist_sync::SyncError> {
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
        _: yonalist_sync::GrantId,
    ) -> AccessDecision {
        AccessDecision::Allowed
    }
    fn local_access(
        &self,
        _: &(),
        _: yonalist_sync::MemberId,
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
        validated.accepted,
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
    assert_eq!(validated.accepted[0].accepted_head, first.head);
    assert_eq!(
        validated.rejected,
        vec![(device, yonalist_sync::SyncErrorCode::PolicyRejected)]
    );
    receiver.promote_pack(validated).unwrap();
    assert_eq!(
        receiver.head(Plane::Data, device).unwrap(),
        Some(first.head)
    );
}

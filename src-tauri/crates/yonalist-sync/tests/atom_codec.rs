use yonalist_sync::{
    AtomLimits, DeviceId, DeviceSigner, EventId, GitOid, GrantId, MemberId, Plane, ProjectId,
    SignedAtom, SyncErrorCode, UnsignedAtom,
};

fn fixture_unsigned_atom(plane: Plane, payload: &[u8]) -> UnsignedAtom {
    UnsignedAtom {
        schema: 1,
        project_id: ProjectId::from_bytes([1; 16]),
        event_id: EventId::from_bytes([2; 16]),
        plane,
        actor_member_id: MemberId::from_bytes([3; 16]),
        actor_device_id: DeviceId::from_bytes([4; 16]),
        membership_grant_id: GrantId::from_bytes([5; 16]),
        control_frontier: Vec::new(),
        data_frontier: Vec::new(),
        display_time_ms: 1234,
        payload: payload.to_vec(),
    }
}

#[test]
fn signed_atom_has_stable_bytes_and_rejects_tampering() {
    let signer = DeviceSigner::from_secret_bytes([7; 32]);
    let signed = signer
        .sign(fixture_unsigned_atom(Plane::Data, b"issue.created"))
        .unwrap();
    let limits = AtomLimits {
        max_payload_bytes: 1024,
        max_frontier_heads: 8,
    };
    let encoded = signed.encode(&limits).unwrap();
    let decoded = SignedAtom::decode(&encoded, &limits).unwrap();
    decoded.verify(&signer.public_key()).unwrap();
    assert_eq!(decoded.encode(&limits).unwrap(), encoded);
    assert_eq!(
        signer
            .sign(fixture_unsigned_atom(Plane::Data, b"issue.created"))
            .unwrap()
            .encode(&limits)
            .unwrap(),
        encoded,
    );

    let mut tampered = encoded;
    let last = tampered.len() - 1;
    tampered[last] ^= 0x01;
    let decoded = SignedAtom::decode(&tampered, &limits).unwrap();
    assert_eq!(
        decoded.verify(&signer.public_key()).unwrap_err().code,
        SyncErrorCode::InvalidSignature
    );
}

#[test]
fn atom_rejects_wrong_plane_frontier_and_limits() {
    let signer = DeviceSigner::from_secret_bytes([9; 32]);
    let mut atom = fixture_unsigned_atom(Plane::Control, b"member.granted");
    atom.data_frontier
        .push(GitOid::parse(&"a".repeat(64)).unwrap());
    let signed = signer.sign(atom).unwrap();
    let generous = AtomLimits {
        max_payload_bytes: 1024,
        max_frontier_heads: 4,
    };
    assert_eq!(
        signed.encode(&generous).unwrap_err().code,
        SyncErrorCode::InvalidAtom
    );

    let signed = signer
        .sign(fixture_unsigned_atom(Plane::Data, &[1; 17]))
        .unwrap();
    let limits = AtomLimits {
        max_payload_bytes: 16,
        max_frontier_heads: 4,
    };
    assert_eq!(
        signed.encode(&limits).unwrap_err().code,
        SyncErrorCode::LimitExceeded
    );
}

#[test]
fn atom_rejects_unsupported_schema_and_noncanonical_trailing_bytes() {
    let signer = DeviceSigner::from_secret_bytes([11; 32]);
    let limits = AtomLimits {
        max_payload_bytes: 1024,
        max_frontier_heads: 8,
    };

    let mut unsupported = fixture_unsigned_atom(Plane::Data, b"issue.created");
    unsupported.schema = 2;
    assert_eq!(
        signer
            .sign(unsupported)
            .unwrap()
            .encode(&limits)
            .unwrap_err()
            .code,
        SyncErrorCode::UnsupportedSchema
    );

    let signed = signer
        .sign(fixture_unsigned_atom(Plane::Data, b"issue.created"))
        .unwrap();
    let mut encoded = signed.encode(&limits).unwrap();
    encoded.push(0xf6);
    assert_eq!(
        SignedAtom::decode(&encoded, &limits).unwrap_err().code,
        SyncErrorCode::InvalidAtom
    );
}

#[test]
fn signing_normalizes_frontiers_and_assigns_plane_path() {
    let signer = DeviceSigner::from_secret_bytes([13; 32]);
    let mut atom = fixture_unsigned_atom(Plane::Data, b"issue.created");
    let a = GitOid::parse(&"a".repeat(64)).unwrap();
    let b = GitOid::parse(&"b".repeat(64)).unwrap();
    atom.control_frontier = vec![b.clone(), a.clone(), b];
    atom.data_frontier = vec![a.clone(), a];

    let signed = signer.sign(atom).unwrap();
    assert_eq!(signed.unsigned.control_frontier.len(), 2);
    assert_eq!(signed.unsigned.control_frontier[0].as_str(), "a".repeat(64));
    assert_eq!(signed.unsigned.data_frontier.len(), 1);
    assert_eq!(
        signed.repo_path(),
        "data-atoms/02/02081040g2081040g2081040g2.cbor"
    );
}

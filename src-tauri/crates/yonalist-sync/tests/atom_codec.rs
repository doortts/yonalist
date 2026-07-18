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

#[test]
fn decode_rejects_clearly_oversized_input_before_structural_decoding() {
    let limits = AtomLimits {
        max_payload_bytes: 0,
        max_frontier_heads: 0,
    };

    assert_eq!(
        SignedAtom::decode(&vec![0; 1024], &limits)
            .unwrap_err()
            .code,
        SyncErrorCode::LimitExceeded
    );
}

#[test]
fn decode_rejects_frontier_count_overflow() {
    let signer = DeviceSigner::from_secret_bytes([15; 32]);
    let mut atom = fixture_unsigned_atom(Plane::Data, b"issue.created");
    atom.control_frontier = vec![
        GitOid::parse(&"a".repeat(64)).unwrap(),
        GitOid::parse(&"b".repeat(64)).unwrap(),
    ];
    let signed = signer.sign(atom).unwrap();
    let encoded = signed
        .encode(&AtomLimits {
            max_payload_bytes: 1024,
            max_frontier_heads: 2,
        })
        .unwrap();

    assert_eq!(
        SignedAtom::decode(
            &encoded,
            &AtomLimits {
                max_payload_bytes: 1024,
                max_frontier_heads: 1,
            },
        )
        .unwrap_err()
        .code,
        SyncErrorCode::LimitExceeded
    );
}

#[test]
fn decode_rejects_non_64_byte_signature() {
    let signer = DeviceSigner::from_secret_bytes([17; 32]);
    let limits = AtomLimits {
        max_payload_bytes: 1024,
        max_frontier_heads: 8,
    };
    let signed = signer
        .sign(fixture_unsigned_atom(Plane::Data, b"issue.created"))
        .unwrap();
    let encoded = signed.encode(&limits).unwrap();
    let mut wire: ciborium::Value = ciborium::de::from_reader(encoded.as_slice()).unwrap();
    let ciborium::Value::Array(fields) = &mut wire else {
        panic!("signed atom must be a tuple");
    };
    fields[1] = ciborium::Value::Bytes(vec![0; 63]);
    let mut invalid = Vec::new();
    ciborium::ser::into_writer(&wire, &mut invalid).unwrap();

    assert_eq!(
        SignedAtom::decode(&invalid, &limits).unwrap_err().code,
        SyncErrorCode::InvalidSignature
    );
}

#[test]
fn decode_rejects_noncanonical_integer_encoding() {
    let signer = DeviceSigner::from_secret_bytes([19; 32]);
    let limits = AtomLimits {
        max_payload_bytes: 1024,
        max_frontier_heads: 8,
    };
    let signed = signer
        .sign(fixture_unsigned_atom(Plane::Data, b"issue.created"))
        .unwrap();
    let mut encoded = signed.encode(&limits).unwrap();
    assert_eq!(&encoded[..3], &[0x82, 0x8b, 0x01]);
    encoded.splice(2..3, [0x18, 0x01]);

    let error = SignedAtom::decode(&encoded, &limits).unwrap_err();
    assert_eq!(error.code, SyncErrorCode::InvalidAtom);
    assert_eq!(error.message, "atom bytes are not canonical");
}

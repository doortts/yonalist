use std::io::Cursor;

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde_bytes::ByteBuf;

use crate::{
    DeviceId, EventId, GitOid, GrantId, MemberId, Plane, ProjectId, SyncError, SyncErrorCode,
};

pub const ATOM_SCHEMA_V1: u16 = 1;

#[derive(Clone, Debug)]
pub struct AtomLimits {
    pub max_payload_bytes: usize,
    pub max_frontier_heads: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
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

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignedAtom {
    pub unsigned: UnsignedAtom,
    pub signature: Vec<u8>,
}

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
    ByteBuf,
);

type SignedWireV1 = (UnsignedWireV1, ByteBuf);

fn error(code: SyncErrorCode, message: impl Into<String>) -> SyncError {
    SyncError {
        code,
        message: message.into(),
    }
}

pub(crate) fn encode<T: serde::Serialize>(value: &T) -> Result<Vec<u8>, SyncError> {
    let mut bytes = Vec::new();
    ciborium::ser::into_writer(value, &mut bytes)
        .map_err(|_| error(SyncErrorCode::InvalidAtom, "could not encode atom"))?;
    Ok(bytes)
}

fn normalized_frontier(frontier: &[GitOid]) -> Vec<String> {
    let mut frontier: Vec<_> = frontier.iter().map(|oid| oid.as_str().to_owned()).collect();
    frontier.sort();
    frontier.dedup();
    frontier
}

fn validate_unsigned(atom: &UnsignedAtom, limits: Option<&AtomLimits>) -> Result<(), SyncError> {
    if atom.schema != ATOM_SCHEMA_V1 {
        return Err(error(
            SyncErrorCode::UnsupportedSchema,
            "unsupported atom schema",
        ));
    }
    if matches!(atom.plane, Plane::Control) && !atom.data_frontier.is_empty() {
        return Err(error(
            SyncErrorCode::InvalidAtom,
            "control atoms cannot contain a data frontier",
        ));
    }
    if atom
        .control_frontier
        .iter()
        .any(|oid| oid.as_str().is_empty())
        || atom.data_frontier.iter().any(|oid| oid.as_str().is_empty())
    {
        return Err(error(SyncErrorCode::InvalidAtom, "invalid atom frontier"));
    }
    if normalized_frontier(&atom.control_frontier)
        != atom
            .control_frontier
            .iter()
            .map(|oid| oid.as_str())
            .collect::<Vec<_>>()
        || normalized_frontier(&atom.data_frontier)
            != atom
                .data_frontier
                .iter()
                .map(|oid| oid.as_str())
                .collect::<Vec<_>>()
    {
        return Err(error(
            SyncErrorCode::InvalidAtom,
            "atom frontiers must be sorted and deduplicated",
        ));
    }
    if let Some(limits) = limits {
        if atom.payload.len() > limits.max_payload_bytes
            || atom.control_frontier.len() > limits.max_frontier_heads
            || atom.data_frontier.len() > limits.max_frontier_heads
        {
            return Err(error(
                SyncErrorCode::LimitExceeded,
                "atom exceeds configured limits",
            ));
        }
    }
    Ok(())
}

fn maximum_encoded_len(limits: &AtomLimits) -> usize {
    // A CBOR length or integer header is at most nine bytes. UUIDs serialize as
    // 16-element u8 arrays, OIDs are exactly 64-byte strings, and a valid atom
    // has two independently limited frontier arrays plus a 64-byte signature.
    const MAX_HEADER_BYTES: usize = 9;
    const MAX_U8_BYTES: usize = 2;
    const UUID_COUNT: usize = 5;
    const UUID_BYTES: usize = 16;
    const FRONTIER_COUNT: usize = 2;
    const OID_BYTES: usize = 64;
    const SIGNATURE_BYTES: usize = 64;

    let checked = || -> Option<usize> {
        let uuid_bytes = MAX_HEADER_BYTES.checked_add(UUID_BYTES.checked_mul(MAX_U8_BYTES)?)?;
        let oid_bytes = MAX_HEADER_BYTES.checked_add(OID_BYTES)?;
        let fixed_bytes = MAX_HEADER_BYTES // signed tuple
            .checked_add(MAX_HEADER_BYTES)? // unsigned tuple
            .checked_add(MAX_HEADER_BYTES)? // schema
            .checked_add(MAX_HEADER_BYTES)? // plane
            .checked_add(MAX_HEADER_BYTES)? // display time
            .checked_add(UUID_COUNT.checked_mul(uuid_bytes)?)?
            .checked_add(FRONTIER_COUNT.checked_mul(MAX_HEADER_BYTES)?)?
            .checked_add(MAX_HEADER_BYTES)? // payload byte-string header
            .checked_add(MAX_HEADER_BYTES.checked_add(SIGNATURE_BYTES)?)?;
        fixed_bytes
            .checked_add(limits.max_payload_bytes)?
            .checked_add(
                FRONTIER_COUNT.checked_mul(limits.max_frontier_heads.checked_mul(oid_bytes)?)?,
            )
    };

    checked().unwrap_or(usize::MAX)
}

pub(crate) fn wire_from_unsigned(atom: &UnsignedAtom) -> UnsignedWireV1 {
    (
        atom.schema,
        *atom.project_id.as_uuid().as_bytes(),
        *atom.event_id.as_uuid().as_bytes(),
        match atom.plane {
            Plane::Control => 0,
            Plane::Data => 1,
        },
        *atom.actor_member_id.as_uuid().as_bytes(),
        *atom.actor_device_id.as_uuid().as_bytes(),
        *atom.membership_grant_id.as_uuid().as_bytes(),
        atom.control_frontier
            .iter()
            .map(|oid| oid.as_str().to_owned())
            .collect(),
        atom.data_frontier
            .iter()
            .map(|oid| oid.as_str().to_owned())
            .collect(),
        atom.display_time_ms,
        ByteBuf::from(atom.payload.clone()),
    )
}

fn unsigned_from_wire(wire: UnsignedWireV1) -> Result<UnsignedAtom, SyncError> {
    let (
        schema,
        project_id,
        event_id,
        plane,
        actor_member_id,
        actor_device_id,
        membership_grant_id,
        control_frontier,
        data_frontier,
        display_time_ms,
        payload,
    ) = wire;
    let plane = match plane {
        0 => Plane::Control,
        1 => Plane::Data,
        _ => return Err(error(SyncErrorCode::InvalidAtom, "invalid atom plane")),
    };
    let parse_frontier = |frontier: Vec<String>| -> Result<Vec<GitOid>, SyncError> {
        frontier
            .into_iter()
            .map(|oid| {
                GitOid::parse(&oid)
                    .map_err(|_| error(SyncErrorCode::InvalidAtom, "invalid atom frontier"))
            })
            .collect()
    };
    Ok(UnsignedAtom {
        schema,
        project_id: ProjectId::from_bytes(project_id),
        event_id: EventId::from_bytes(event_id),
        plane,
        actor_member_id: MemberId::from_bytes(actor_member_id),
        actor_device_id: DeviceId::from_bytes(actor_device_id),
        membership_grant_id: GrantId::from_bytes(membership_grant_id),
        control_frontier: parse_frontier(control_frontier)?,
        data_frontier: parse_frontier(data_frontier)?,
        display_time_ms,
        payload: payload.into_vec(),
    })
}

impl SignedAtom {
    pub fn encode(&self, limits: &AtomLimits) -> Result<Vec<u8>, SyncError> {
        validate_unsigned(&self.unsigned, Some(limits))?;
        if self.signature.len() != 64 {
            return Err(error(
                SyncErrorCode::InvalidSignature,
                "invalid atom signature",
            ));
        }
        encode(&(
            wire_from_unsigned(&self.unsigned),
            ByteBuf::from(self.signature.clone()),
        ))
    }

    pub fn decode(bytes: &[u8], limits: &AtomLimits) -> Result<Self, SyncError> {
        if bytes.len() > maximum_encoded_len(limits) {
            return Err(error(
                SyncErrorCode::LimitExceeded,
                "atom exceeds configured limits",
            ));
        }
        let mut reader = Cursor::new(bytes);
        let (wire, signature): SignedWireV1 = ciborium::de::from_reader(&mut reader)
            .map_err(|_| error(SyncErrorCode::InvalidAtom, "could not decode atom"))?;
        if reader.position() != bytes.len() as u64 {
            return Err(error(SyncErrorCode::InvalidAtom, "atom has trailing bytes"));
        }
        let atom = Self {
            unsigned: unsigned_from_wire(wire)?,
            signature: signature.into_vec(),
        };
        validate_unsigned(&atom.unsigned, Some(limits))?;
        if atom.signature.len() != 64 {
            return Err(error(
                SyncErrorCode::InvalidSignature,
                "invalid atom signature",
            ));
        }
        if atom.encode(limits)? != bytes {
            return Err(error(
                SyncErrorCode::InvalidAtom,
                "atom bytes are not canonical",
            ));
        }
        Ok(atom)
    }

    pub fn verify(&self, public_key: &[u8; 32]) -> Result<(), SyncError> {
        let public_key = VerifyingKey::from_bytes(public_key)
            .map_err(|_| error(SyncErrorCode::InvalidSignature, "invalid atom signature"))?;
        let signature = Signature::from_slice(&self.signature)
            .map_err(|_| error(SyncErrorCode::InvalidSignature, "invalid atom signature"))?;
        let bytes = encode(&wire_from_unsigned(&self.unsigned))?;
        public_key
            .verify(&bytes, &signature)
            .map_err(|_| error(SyncErrorCode::InvalidSignature, "invalid atom signature"))
    }

    pub fn repo_path(&self) -> String {
        let id = self.unsigned.event_id.to_string();
        match self.unsigned.plane {
            Plane::Control => format!("control-atoms/{}/{}.cbor", &id[..2], id),
            Plane::Data => format!("data-atoms/{}/{}.cbor", &id[..2], id),
        }
    }
}

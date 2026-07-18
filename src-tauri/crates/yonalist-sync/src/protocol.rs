use std::collections::BTreeMap;

use crate::{DeviceId, GitOid, Plane, SignedAtom};

/// Opaque, per-endpoint serving capability.  It is deliberately not
/// serializable: a real transport binds it to its authenticated connection.
#[derive(Clone, Eq, PartialEq)]
pub struct SessionToken(pub(crate) [u8; 32]);

impl std::fmt::Debug for SessionToken {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("SessionToken([redacted])")
    }
}

impl SessionToken {
    #[cfg(feature = "test-support")]
    pub(crate) fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }
}

#[derive(Clone, Debug)]
pub struct ImmutableFile {
    pub path: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug)]
pub struct StoreBatch {
    pub plane: Plane,
    pub device_id: DeviceId,
    pub expected_head: Option<GitOid>,
    pub atoms: Vec<SignedAtom>,
    pub auxiliary_files: Vec<ImmutableFile>,
    pub observed_heads: Vec<GitOid>,
}

#[derive(Debug)]
pub struct LocalCommit {
    pub ref_name: String,
    pub previous: Option<GitOid>,
    pub head: GitOid,
}

#[derive(Debug)]
pub struct RefAdvertisement {
    pub plane: Plane,
    pub refs: BTreeMap<DeviceId, GitOid>,
}

use std::collections::BTreeMap;

use crate::{DeviceId, GitOid, Plane, SignedAtom};

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

use crate::{EventId, GitOid, GrantId, MemberId, SignedAtom, SyncError};

pub enum AccessDecision {
    Allowed,
    ControlOnly { notice_event_ids: Vec<EventId> },
    Denied,
}

pub enum AccessState {
    Active,
    Revoked { grant_id: GrantId },
}

pub struct StoredAtom {
    pub path: String,
    pub containing_commit: GitOid,
    pub atom: SignedAtom,
}

pub trait ProjectPolicy: Send + Sync {
    type State: Clone + Send + Sync;

    fn rebuild_control(&self, atoms: &[StoredAtom]) -> Result<Self::State, SyncError>;
    fn validate_control(&self, state: &Self::State, atom: &StoredAtom) -> Result<(), SyncError>;
    fn validate_data(&self, state: &Self::State, atom: &StoredAtom) -> Result<(), SyncError>;
    fn peer_access(&self, state: &Self::State, member: MemberId, grant: GrantId) -> AccessDecision;
    fn local_access(&self, state: &Self::State, member: MemberId, grant: GrantId) -> AccessState;
}

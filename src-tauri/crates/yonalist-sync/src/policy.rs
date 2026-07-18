use crate::{DeviceId, GitOid, GrantId, MemberId, SignedAtom, SyncError};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AccessDecision {
    Allowed,
    /// The peer is no longer a member.  This is intentionally the only
    /// protocol material a removed peer can receive; it is not a filtered
    /// control-history capability.
    RemovalOnly {
        notice: SignedAtom,
    },
    Denied,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AccessState {
    Active,
    Revoked { grant_id: GrantId },
}

pub struct StoredAtom {
    pub path: String,
    pub containing_commit: GitOid,
    pub atom: SignedAtom,
}

/// Application policy for signed project atoms.
///
/// Imported control transitions are authorized against the exact state at
/// their signed commit-parent cut and the resulting trusted union is also
/// replayed in canonical causal/OID order. Implementations must therefore keep
/// `rebuild_control` and repeated `advance_control` deterministic and
/// equivalent: a concurrent atom cannot borrow authority from global replay
/// order, and an accepted union must remain rebuildable after reopening.
pub trait ProjectPolicy: Send + Sync {
    type State: Clone + Send + Sync;

    fn rebuild_control(&self, atoms: &[StoredAtom]) -> Result<Self::State, SyncError>;
    fn advance_control(
        &self,
        state: &Self::State,
        atoms: &[StoredAtom],
    ) -> Result<Self::State, SyncError>;
    fn preflight_control(
        &self,
        state: &Self::State,
        atoms: &[SignedAtom],
    ) -> Result<Self::State, SyncError> {
        let containing_commit = GitOid::parse(&"0".repeat(64)).expect("valid placeholder OID");
        let stored = atoms
            .iter()
            .cloned()
            .map(|atom| StoredAtom {
                path: atom.repo_path(),
                containing_commit: containing_commit.clone(),
                atom,
            })
            .collect::<Vec<_>>();
        self.advance_control(state, &stored)
    }
    fn validate_control(&self, state: &Self::State, atom: &StoredAtom) -> Result<(), SyncError>;
    /// Confirms that a standalone removal notice revokes exactly `local_grant`.
    /// The atom's membership grant names its *actor*, so consumers must not
    /// infer the removed grant from that field.
    fn validate_removal_notice(
        &self,
        _state: &Self::State,
        _atom: &StoredAtom,
        _local_grant: GrantId,
    ) -> Result<(), SyncError> {
        Err(SyncError {
            code: crate::SyncErrorCode::PolicyRejected,
            message: "policy does not support standalone removal notices".into(),
        })
    }
    fn validate_data(&self, state: &Self::State, atom: &StoredAtom) -> Result<(), SyncError>;
    fn peer_access(
        &self,
        state: &Self::State,
        member: MemberId,
        device: DeviceId,
        grant: GrantId,
    ) -> AccessDecision;
    fn local_access(
        &self,
        state: &Self::State,
        member: MemberId,
        device: DeviceId,
        grant: GrantId,
    ) -> AccessState;
}

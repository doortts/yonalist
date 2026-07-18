use crate::{
    AccessDecision, AccessState, GrantId, MemberId, ProjectPolicy, StoredAtom, SyncError,
    SyncErrorCode,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum FixtureRole {
    Owner,
    Admin,
    Member,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum FixtureControl {
    Grant {
        member_id: MemberId,
        grant_id: GrantId,
        role: FixtureRole,
        device_key: [u8; 32],
    },
    Revoke {
        grant_id: GrantId,
    },
}
#[derive(Clone, Debug)]
pub struct FixtureGrant {
    pub member_id: MemberId,
    pub role: FixtureRole,
    pub device_key: [u8; 32],
    pub revoked: bool,
}
#[derive(Clone, Debug, Default)]
pub struct FixtureState {
    pub grants: BTreeMap<GrantId, FixtureGrant>,
}
pub struct FixturePolicy {
    owner_member: MemberId,
    owner_grant: GrantId,
    owner_key: [u8; 32],
}
impl FixturePolicy {
    pub fn new(owner_member: MemberId, owner_grant: GrantId, owner_key: [u8; 32]) -> Self {
        Self {
            owner_member,
            owner_grant,
            owner_key,
        }
    }
}
impl ProjectPolicy for FixturePolicy {
    type State = FixtureState;
    fn rebuild_control(&self, atoms: &[StoredAtom]) -> Result<FixtureState, SyncError> {
        let mut state = FixtureState::default();
        let mut ordered = atoms.iter().collect::<Vec<_>>();
        ordered.sort_by(|a, b| a.path.cmp(&b.path));
        for atom in ordered {
            self.validate_control(&state, atom)?;
            let control = decode(&atom.atom.unsigned.payload)?;
            match control {
                FixtureControl::Grant {
                    member_id,
                    grant_id,
                    role,
                    device_key,
                } => {
                    state.grants.insert(
                        grant_id,
                        FixtureGrant {
                            member_id,
                            role,
                            device_key,
                            revoked: false,
                        },
                    );
                }
                FixtureControl::Revoke { grant_id } => {
                    if let Some(grant) = state.grants.get_mut(&grant_id) {
                        grant.revoked = true;
                    }
                }
            }
        }
        Ok(state)
    }
    fn validate_control(&self, state: &FixtureState, atom: &StoredAtom) -> Result<(), SyncError> {
        let grant = self.authorize(state, atom)?;
        match decode(&atom.atom.unsigned.payload)? {
            FixtureControl::Grant { .. } | FixtureControl::Revoke { .. }
                if grant == Some(FixtureRole::Owner) || grant == Some(FixtureRole::Admin) =>
            {
                Ok(())
            }
            _ => Err(reject("only owner or admin may change grants")),
        }
    }
    fn validate_data(&self, state: &FixtureState, atom: &StoredAtom) -> Result<(), SyncError> {
        self.authorize(state, atom)?
            .ok_or_else(|| reject("data requires active grant"))?;
        Ok(())
    }
    fn peer_access(
        &self,
        state: &FixtureState,
        member: MemberId,
        grant: GrantId,
    ) -> AccessDecision {
        if state
            .grants
            .get(&grant)
            .is_some_and(|g| !g.revoked && g.member_id == member)
        {
            AccessDecision::Allowed
        } else {
            AccessDecision::Denied
        }
    }
    fn local_access(&self, state: &FixtureState, member: MemberId, grant: GrantId) -> AccessState {
        if (state.grants.is_empty() && member == self.owner_member && grant == self.owner_grant)
            || matches!(
                self.peer_access(state, member, grant),
                AccessDecision::Allowed
            )
        {
            AccessState::Active
        } else {
            AccessState::Revoked { grant_id: grant }
        }
    }
}
impl FixturePolicy {
    fn authorize(
        &self,
        state: &FixtureState,
        atom: &StoredAtom,
    ) -> Result<Option<FixtureRole>, SyncError> {
        let u = &atom.atom.unsigned;
        if u.actor_member_id == self.owner_member
            && u.membership_grant_id == self.owner_grant
            && !state.grants.contains_key(&self.owner_grant)
        {
            atom.atom.verify(&self.owner_key)?;
            return Ok(Some(FixtureRole::Owner));
        }
        let grant = state
            .grants
            .get(&u.membership_grant_id)
            .filter(|g| !g.revoked && g.member_id == u.actor_member_id)
            .ok_or_else(|| reject("inactive grant"))?;
        atom.atom.verify(&grant.device_key)?;
        Ok(Some(grant.role))
    }
}
pub(crate) fn encode(control: &FixtureControl) -> Result<Vec<u8>, SyncError> {
    let mut bytes = Vec::new();
    ciborium::ser::into_writer(control, &mut bytes)
        .map_err(|_| reject("cannot encode fixture control"))?;
    Ok(bytes)
}
fn decode(bytes: &[u8]) -> Result<FixtureControl, SyncError> {
    let mut reader = std::io::Cursor::new(bytes);
    let value: FixtureControl =
        ciborium::de::from_reader(&mut reader).map_err(|_| reject("invalid fixture control"))?;
    if reader.position() != bytes.len() as u64 {
        return Err(reject("fixture control has trailing bytes"));
    }
    let canonical = encode(&value)?;
    if canonical != bytes {
        return Err(reject("fixture control is not canonical"));
    }
    Ok(value)
}
fn reject(message: impl Into<String>) -> SyncError {
    SyncError {
        code: SyncErrorCode::PolicyRejected,
        message: message.into(),
    }
}

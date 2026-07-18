use crate::{
    AccessDecision, AccessState, DeviceId, GrantId, MemberId, ProjectPolicy, StoredAtom, SyncError,
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
        device_id: DeviceId,
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
    pub device_id: DeviceId,
    pub role: FixtureRole,
    pub device_key: [u8; 32],
    pub revoked: bool,
}
#[derive(Clone, Debug, Default)]
pub struct FixtureState {
    pub grants: BTreeMap<GrantId, FixtureGrant>,
    revocation_notices: BTreeMap<GrantId, Vec<FixtureNotice>>,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct FixtureNotice {
    pub(crate) atom: crate::SignedAtom,
}
pub struct FixturePolicy {
    owner_member: MemberId,
    owner_device: DeviceId,
    owner_grant: GrantId,
    owner_key: [u8; 32],
}
impl FixturePolicy {
    pub fn new(
        owner_member: MemberId,
        owner_device: DeviceId,
        owner_grant: GrantId,
        owner_key: [u8; 32],
    ) -> Self {
        Self {
            owner_member,
            owner_device,
            owner_grant,
            owner_key,
        }
    }
}
impl FixtureState {
    #[cfg(test)]
    pub(crate) fn matches_revocation_notice(&self, grant: GrantId, candidate: &StoredAtom) -> bool {
        self.revocation_notices
            .get(&grant)
            .is_some_and(|notices| notices.iter().any(|notice| notice.atom == candidate.atom))
    }
}

#[cfg(test)]
#[allow(
    clippy::items_after_test_module,
    reason = "fixture policy examples stay beside their fixture constructors"
)]
mod fixture_policy_tests {
    use super::*;
    use crate::{DeviceSigner, EventId, GitOid, Plane, UnsignedAtom, ATOM_SCHEMA_V1};

    fn id(n: u8) -> ([u8; 16], MemberId, DeviceId, GrantId) {
        (
            [n; 16],
            MemberId::from_bytes([n; 16]),
            DeviceId::from_bytes([n.wrapping_add(1); 16]),
            GrantId::from_bytes([n.wrapping_add(2); 16]),
        )
    }

    fn stored(
        signer: &DeviceSigner,
        actor: (MemberId, DeviceId, GrantId),
        event: u8,
        value: FixtureControl,
    ) -> StoredAtom {
        let atom = signer
            .sign(UnsignedAtom {
                schema: ATOM_SCHEMA_V1,
                project_id: crate::ProjectId::from_bytes([1; 16]),
                event_id: EventId::from_bytes([event; 16]),
                plane: Plane::Control,
                actor_member_id: actor.0,
                actor_device_id: actor.1,
                membership_grant_id: actor.2,
                control_frontier: vec![],
                data_frontier: vec![],
                display_time_ms: 0,
                payload: encode(&value).unwrap(),
            })
            .unwrap();
        StoredAtom {
            path: atom.repo_path(),
            containing_commit: GitOid::parse(&format!("{event:02x}{}", "0".repeat(62))).unwrap(),
            atom,
        }
    }

    #[test]
    fn trust_anchor_only_authorizes_exact_owner_genesis() {
        let (_, owner_member, owner_device, owner_grant) = id(10);
        let (_, attacker_member, attacker_device, attacker_grant) = id(20);
        let signer = DeviceSigner::from_secret_bytes([7; 32]);
        let policy =
            FixturePolicy::new(owner_member, owner_device, owner_grant, signer.public_key());
        let escalation = stored(
            &signer,
            (owner_member, owner_device, owner_grant),
            1,
            FixtureControl::Grant {
                member_id: attacker_member,
                device_id: attacker_device,
                grant_id: attacker_grant,
                role: FixtureRole::Owner,
                device_key: signer.public_key(),
            },
        );
        assert_eq!(
            policy.rebuild_control(&[escalation]).unwrap_err().code,
            SyncErrorCode::PolicyRejected
        );
        let revoke = stored(
            &signer,
            (owner_member, owner_device, owner_grant),
            2,
            FixtureControl::Revoke {
                grant_id: owner_grant,
            },
        );
        assert_eq!(
            policy.rebuild_control(&[revoke]).unwrap_err().code,
            SyncErrorCode::PolicyRejected
        );
        let genesis = stored(
            &signer,
            (owner_member, owner_device, owner_grant),
            3,
            FixtureControl::Grant {
                member_id: owner_member,
                device_id: owner_device,
                grant_id: owner_grant,
                role: FixtureRole::Owner,
                device_key: signer.public_key(),
            },
        );
        let revoke_owner = stored(
            &signer,
            (owner_member, owner_device, owner_grant),
            4,
            FixtureControl::Revoke {
                grant_id: owner_grant,
            },
        );
        let later_escalation = stored(
            &signer,
            (owner_member, owner_device, owner_grant),
            5,
            FixtureControl::Grant {
                member_id: attacker_member,
                device_id: attacker_device,
                grant_id: attacker_grant,
                role: FixtureRole::Owner,
                device_key: signer.public_key(),
            },
        );
        assert_eq!(
            policy
                .rebuild_control(&[genesis, revoke_owner, later_escalation])
                .unwrap_err()
                .code,
            SyncErrorCode::PolicyRejected
        );
    }

    #[test]
    fn grants_bind_device_and_reject_duplicate_unknown_or_reactivation() {
        let (_, owner_member, owner_device, owner_grant) = id(10);
        let (_, member, device, grant) = id(20);
        let signer = DeviceSigner::from_secret_bytes([7; 32]);
        let policy =
            FixturePolicy::new(owner_member, owner_device, owner_grant, signer.public_key());
        let genesis = || {
            stored(
                &signer,
                (owner_member, owner_device, owner_grant),
                1,
                FixtureControl::Grant {
                    member_id: owner_member,
                    device_id: owner_device,
                    grant_id: owner_grant,
                    role: FixtureRole::Owner,
                    device_key: signer.public_key(),
                },
            )
        };
        let grant_atom = || {
            stored(
                &signer,
                (owner_member, owner_device, owner_grant),
                2,
                FixtureControl::Grant {
                    member_id: member,
                    device_id: device,
                    grant_id: grant,
                    role: FixtureRole::Member,
                    device_key: [9; 32],
                },
            )
        };
        assert!(policy.rebuild_control(&[genesis(), grant_atom()]).is_ok());
        assert_eq!(
            policy
                .rebuild_control(&[genesis(), grant_atom(), grant_atom()])
                .unwrap_err()
                .code,
            SyncErrorCode::PolicyRejected
        );
        let unknown_revoke = stored(
            &signer,
            (owner_member, owner_device, owner_grant),
            3,
            FixtureControl::Revoke {
                grant_id: GrantId::from_bytes([99; 16]),
            },
        );
        assert_eq!(
            policy
                .rebuild_control(&[genesis(), unknown_revoke])
                .unwrap_err()
                .code,
            SyncErrorCode::PolicyRejected
        );
        let revoke = stored(
            &signer,
            (owner_member, owner_device, owner_grant),
            4,
            FixtureControl::Revoke { grant_id: grant },
        );
        assert_eq!(
            policy
                .rebuild_control(&[genesis(), grant_atom(), revoke, grant_atom()])
                .unwrap_err()
                .code,
            SyncErrorCode::PolicyRejected
        );
        let revoke_again = || {
            stored(
                &signer,
                (owner_member, owner_device, owner_grant),
                5,
                FixtureControl::Revoke { grant_id: grant },
            )
        };
        assert_eq!(
            policy
                .rebuild_control(&[genesis(), grant_atom(), revoke_again(), revoke_again(),])
                .unwrap_err()
                .code,
            SyncErrorCode::PolicyRejected
        );
        let state = policy.rebuild_control(&[genesis(), grant_atom()]).unwrap();
        assert_eq!(
            policy.peer_access(&state, member, DeviceId::from_bytes([88; 16]), grant),
            AccessDecision::Denied
        );
        assert_eq!(
            policy.peer_access(&state, member, device, grant),
            AccessDecision::Allowed
        );
    }

    #[test]
    fn revocation_notice_binding_rejects_same_event_with_different_signed_atom() {
        let (_, owner_member, owner_device, owner_grant) = id(10);
        let (_, member, device, grant) = id(20);
        let signer = DeviceSigner::from_secret_bytes([7; 32]);
        let policy =
            FixturePolicy::new(owner_member, owner_device, owner_grant, signer.public_key());
        let genesis = stored(
            &signer,
            (owner_member, owner_device, owner_grant),
            1,
            FixtureControl::Grant {
                member_id: owner_member,
                device_id: owner_device,
                grant_id: owner_grant,
                role: FixtureRole::Owner,
                device_key: signer.public_key(),
            },
        );
        let grant_atom = stored(
            &signer,
            (owner_member, owner_device, owner_grant),
            2,
            FixtureControl::Grant {
                member_id: member,
                device_id: device,
                grant_id: grant,
                role: FixtureRole::Member,
                device_key: [9; 32],
            },
        );
        let revoke = stored(
            &signer,
            (owner_member, owner_device, owner_grant),
            3,
            FixtureControl::Revoke { grant_id: grant },
        );
        let state = policy
            .rebuild_control(&[genesis, grant_atom, revoke])
            .unwrap();
        let same_event_different_atom = stored(
            &signer,
            (owner_member, owner_device, owner_grant),
            3,
            FixtureControl::Grant {
                member_id: MemberId::from_bytes([99; 16]),
                device_id: DeviceId::from_bytes([98; 16]),
                grant_id: GrantId::from_bytes([97; 16]),
                role: FixtureRole::Member,
                device_key: [96; 32],
            },
        );

        assert!(!state.matches_revocation_notice(grant, &same_event_different_atom));
    }
}
impl ProjectPolicy for FixturePolicy {
    type State = FixtureState;
    fn rebuild_control(&self, atoms: &[StoredAtom]) -> Result<FixtureState, SyncError> {
        let mut state = FixtureState::default();
        for commit_atoms in atoms.chunk_by(|a, b| a.containing_commit == b.containing_commit) {
            state = self.advance_control(&state, commit_atoms)?;
        }
        Ok(state)
    }
    fn advance_control(
        &self,
        state: &FixtureState,
        atoms: &[StoredAtom],
    ) -> Result<FixtureState, SyncError> {
        for atom in atoms {
            self.validate_control(state, atom)?;
        }
        let mut next = state.clone();
        for atom in atoms {
            let control = decode(&atom.atom.unsigned.payload)?;
            match control {
                FixtureControl::Grant {
                    member_id,
                    device_id,
                    grant_id,
                    role,
                    device_key,
                } => {
                    if next.grants.contains_key(&grant_id) {
                        return Err(reject("grant identifier cannot be reused"));
                    }
                    next.grants.insert(
                        grant_id,
                        FixtureGrant {
                            member_id,
                            device_id,
                            role,
                            device_key,
                            revoked: false,
                        },
                    );
                }
                FixtureControl::Revoke { grant_id } => {
                    let grant = next
                        .grants
                        .get_mut(&grant_id)
                        .ok_or_else(|| reject("cannot revoke an unknown grant"))?;
                    if grant.revoked {
                        return Err(reject("grant is already revoked"));
                    }
                    grant.revoked = true;
                    next.revocation_notices
                        .entry(grant_id)
                        .or_default()
                        .push(FixtureNotice {
                            atom: atom.atom.clone(),
                        });
                }
            }
        }
        Ok(next)
    }
    fn validate_control(&self, state: &FixtureState, atom: &StoredAtom) -> Result<(), SyncError> {
        let grant = self.authorize(state, atom)?;
        let control = decode(&atom.atom.unsigned.payload)?;
        if state.grants.is_empty() {
            return match control {
                FixtureControl::Grant {
                    member_id,
                    device_id,
                    grant_id,
                    role: FixtureRole::Owner,
                    device_key,
                } if member_id == self.owner_member
                    && device_id == self.owner_device
                    && grant_id == self.owner_grant
                    && device_key == self.owner_key =>
                {
                    Ok(())
                }
                _ => Err(reject(
                    "first control transition must be exact owner genesis",
                )),
            };
        }
        match control {
            FixtureControl::Grant { .. } | FixtureControl::Revoke { .. }
                if grant == Some(FixtureRole::Owner) || grant == Some(FixtureRole::Admin) =>
            {
                Ok(())
            }
            _ => Err(reject("only owner or admin may change grants")),
        }
    }
    fn validate_removal_notice(
        &self,
        state: &FixtureState,
        atom: &StoredAtom,
        local_grant: GrantId,
    ) -> Result<(), SyncError> {
        match decode(&atom.atom.unsigned.payload)? {
            FixtureControl::Revoke { grant_id } if grant_id == local_grant => {
                // Keep the actor authorization separate from the payload
                // target. `validate_control` above has already verified the
                // former (normally the owner's grant).
                if state.grants.contains_key(&local_grant) {
                    Ok(())
                } else {
                    Err(reject("removal notice targets an unknown grant"))
                }
            }
            FixtureControl::Revoke { .. } => Err(reject("removal notice targets another grant")),
            FixtureControl::Grant { .. } => Err(reject("removal notice is not a revoke")),
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
        device: DeviceId,
        grant: GrantId,
    ) -> AccessDecision {
        match state.grants.get(&grant) {
            Some(g) if g.member_id == member && g.device_id == device && !g.revoked => {
                AccessDecision::Allowed
            }
            Some(g) if g.member_id == member && g.device_id == device => {
                // The policy only retains notices that were accepted during a
                // causal replay.  Concurrent duplicate notices are still
                // resolved deterministically so every endpoint emits exactly
                // the same signed atom.
                let notice = state
                    .revocation_notices
                    .get(&grant)
                    .and_then(|notices| {
                        notices
                            .iter()
                            .min_by_key(|notice| notice.atom.unsigned.event_id)
                    })
                    .expect("revoked fixture grant records its revoke notice")
                    .atom
                    .clone();
                AccessDecision::RemovalOnly { notice }
            }
            _ => AccessDecision::Denied,
        }
    }
    fn local_access(
        &self,
        state: &FixtureState,
        member: MemberId,
        device: DeviceId,
        grant: GrantId,
    ) -> AccessState {
        if (state.grants.is_empty()
            && member == self.owner_member
            && device == self.owner_device
            && grant == self.owner_grant)
            || matches!(
                self.peer_access(state, member, device, grant),
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
            && u.actor_device_id == self.owner_device
            && u.membership_grant_id == self.owner_grant
            && !state.grants.contains_key(&self.owner_grant)
        {
            atom.atom.verify(&self.owner_key)?;
            return Ok(Some(FixtureRole::Owner));
        }
        let grant = state
            .grants
            .get(&u.membership_grant_id)
            .filter(|g| {
                !g.revoked && g.member_id == u.actor_member_id && g.device_id == u.actor_device_id
            })
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

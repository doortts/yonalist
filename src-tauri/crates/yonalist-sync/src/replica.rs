use crate::transport::{Hello, PeerEndpoint};
use crate::{
    AccessDecision, AccessState, AtomLimits, DeviceId, DeviceSigner, GitOid, GitStore, GrantId,
    ImmutableFile, LocalCommit, MemberId, PackBytes, PackLimits, PackRequest, Plane, ProjectId,
    ProjectPolicy, RefAdvertisement, SignedAtom, StoreBatch, StoredAtom, SyncError, SyncErrorCode,
};
use std::{collections::BTreeSet, path::PathBuf};

pub struct ReplicaConfig {
    pub repository: PathBuf,
    pub git_executable: PathBuf,
    pub project_id: ProjectId,
    pub local_member_id: MemberId,
    pub local_device_id: DeviceId,
    pub local_grant_id: GrantId,
    pub atom_limits: AtomLimits,
    pub pack_limits: PackLimits,
}
pub struct LocalBatch {
    pub plane: Plane,
    pub atoms: Vec<SignedAtom>,
    pub auxiliary_files: Vec<ImmutableFile>,
}
#[derive(Debug)]
pub struct SyncReport {
    pub control_refs_advanced: usize,
    pub data_refs_advanced: usize,
    pub control_pack_bytes: usize,
    pub data_pack_bytes: usize,
    pub access_state: AccessState,
}
struct PlanePull {
    advanced: usize,
    bytes: usize,
}
impl PlanePull {
    fn empty() -> Self {
        Self {
            advanced: 0,
            bytes: 0,
        }
    }
}

pub struct Replica<P: ProjectPolicy> {
    pub(crate) config: ReplicaConfig,
    pub(crate) store: GitStore,
    pub(crate) policy: P,
    #[allow(dead_code)]
    pub(crate) signer: DeviceSigner,
    pub(crate) policy_state: P::State,
    pub(crate) access_state: AccessState,
    #[cfg(feature = "test-support")]
    pub(crate) fixture_event: u128,
}
impl<P: ProjectPolicy> Replica<P> {
    pub fn init(config: ReplicaConfig, policy: P, signer: DeviceSigner) -> Result<Self, SyncError> {
        let store = GitStore::init(&config.repository, &config.git_executable)?;
        Self::from_store(config, policy, signer, store)
    }
    pub fn open(config: ReplicaConfig, policy: P, signer: DeviceSigner) -> Result<Self, SyncError> {
        let store = GitStore::open(&config.repository, &config.git_executable)?;
        Self::from_store(config, policy, signer, store)
    }
    fn from_store(
        config: ReplicaConfig,
        policy: P,
        signer: DeviceSigner,
        store: GitStore,
    ) -> Result<Self, SyncError> {
        let state =
            policy.rebuild_control(&store.stored_atoms(Plane::Control, &config.atom_limits)?)?;
        let access = policy.local_access(&state, config.local_member_id, config.local_grant_id);
        Ok(Self {
            config,
            store,
            policy,
            signer,
            policy_state: state,
            access_state: access,
            #[cfg(feature = "test-support")]
            fixture_event: 1,
        })
    }
    pub fn local_hello(&self) -> Hello {
        Hello {
            project_id: self.config.project_id,
            member_id: self.config.local_member_id,
            device_id: self.config.local_device_id,
            grant_id: self.config.local_grant_id,
        }
    }
    pub fn advertise(&self, plane: Plane) -> Result<RefAdvertisement, SyncError> {
        self.store.advertise(plane)
    }
    pub fn create_pack(
        &self,
        request: &PackRequest,
        limits: &PackLimits,
    ) -> Result<PackBytes, SyncError> {
        self.store.create_pack(request, limits)
    }
    pub fn pull_from(&mut self, peer: &mut impl PeerEndpoint) -> Result<SyncReport, SyncError> {
        let ack = peer.hello(&self.local_hello())?;
        let control = self.pull_plane(peer, Plane::Control)?;
        self.rebuild_policy_state()?;
        if !matches!(self.access_state, AccessState::Active)
            || !matches!(ack.decision, AccessDecision::Allowed)
        {
            return Ok(self.report(control, PlanePull::empty()));
        }
        let data = self.pull_plane(peer, Plane::Data)?;
        Ok(self.report(control, data))
    }
    pub fn append_local(&mut self, batch: LocalBatch) -> Result<LocalCommit, SyncError> {
        self.rebuild_policy_state()?;
        if !matches!(self.access_state, AccessState::Active) {
            return Err(access());
        }
        let control = self.reduced_heads(Plane::Control)?;
        let data = self.reduced_heads(Plane::Data)?;
        for atom in &batch.atoms {
            let u = &atom.unsigned;
            if u.project_id != self.config.project_id
                || u.actor_member_id != self.config.local_member_id
                || u.actor_device_id != self.config.local_device_id
                || u.membership_grant_id != self.config.local_grant_id
                || u.plane != batch.plane
                || u.control_frontier != control
                || u.data_frontier
                    != if batch.plane == Plane::Data {
                        data.clone()
                    } else {
                        vec![]
                    }
            {
                return Err(invalid("local atom does not match replica state"));
            }
            let stored = StoredAtom {
                path: atom.repo_path(),
                containing_commit: zero_oid(),
                atom: atom.clone(),
            };
            match batch.plane {
                Plane::Control => self.policy.validate_control(&self.policy_state, &stored)?,
                Plane::Data => self.policy.validate_data(&self.policy_state, &stored)?,
            }
        }
        let expected = self.store.head(batch.plane, self.config.local_device_id)?;
        let observed = self
            .reduced_heads(batch.plane)?
            .into_iter()
            .filter(|h| Some(h) != expected.as_ref())
            .collect();
        self.store.append_local(StoreBatch {
            plane: batch.plane,
            device_id: self.config.local_device_id,
            expected_head: expected,
            atoms: batch.atoms,
            auxiliary_files: batch.auxiliary_files,
            observed_heads: observed,
        })
    }
    pub fn peer_access(&self, hello: &Hello) -> Result<AccessDecision, SyncError> {
        if hello.project_id != self.config.project_id {
            return Ok(AccessDecision::Denied);
        }
        let state = self.policy.rebuild_control(
            &self
                .store
                .stored_atoms(Plane::Control, &self.config.atom_limits)?,
        )?;
        Ok(self
            .policy
            .peer_access(&state, hello.member_id, hello.grant_id))
    }
    fn pull_plane(
        &mut self,
        peer: &mut impl PeerEndpoint,
        plane: Plane,
    ) -> Result<PlanePull, SyncError> {
        let remote = peer.advertise(self.config.project_id, plane)?;
        if remote.plane != plane {
            return Err(invalid("peer advertised wrong plane"));
        }
        if remote.refs.len() > self.config.pack_limits.max_advertised_refs {
            return Err(SyncError {
                code: SyncErrorCode::LimitExceeded,
                message: "peer advertised too many refs".into(),
            });
        }
        let local = self.store.advertise(plane)?;
        let haves: Vec<_> = local
            .refs
            .values()
            .cloned()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        let mut wants = Vec::new();
        for head in remote.refs.values() {
            let known = haves.iter().try_fold(false, |known, have| {
                if known || head == have {
                    Ok(true)
                } else {
                    self.store.is_ancestor(head, have)
                }
            })?;
            if !known {
                wants.push(head.clone());
            }
        }
        if wants.is_empty() {
            return Ok(PlanePull::empty());
        }
        let pack = peer.create_pack(
            self.config.project_id,
            &PackRequest {
                plane,
                wants,
                haves,
            },
            &self.config.pack_limits,
        )?;
        let bytes = pack.0.len();
        let validated = self.store.validate_pack(
            plane,
            &remote,
            pack,
            &self.config.atom_limits,
            &self.config.pack_limits,
            &self.policy,
            &self.policy_state,
        )?;
        let advanced = self.store.promote_pack(validated)?.len();
        Ok(PlanePull { advanced, bytes })
    }
    fn rebuild_policy_state(&mut self) -> Result<(), SyncError> {
        self.policy_state = self.policy.rebuild_control(
            &self
                .store
                .stored_atoms(Plane::Control, &self.config.atom_limits)?,
        )?;
        self.access_state = self.policy.local_access(
            &self.policy_state,
            self.config.local_member_id,
            self.config.local_grant_id,
        );
        Ok(())
    }
    pub(crate) fn reduced_heads(&self, plane: Plane) -> Result<Vec<GitOid>, SyncError> {
        let heads: Vec<_> = self.store.advertise(plane)?.refs.into_values().collect();
        let mut out = Vec::new();
        for head in &heads {
            let mut redundant = false;
            for other in &heads {
                if head != other && self.store.is_ancestor(head, other)? {
                    redundant = true;
                    break;
                }
            }
            if !redundant {
                out.push(head.clone());
            }
        }
        Ok(out)
    }
    fn report(&self, control: PlanePull, data: PlanePull) -> SyncReport {
        SyncReport {
            control_refs_advanced: control.advanced,
            data_refs_advanced: data.advanced,
            control_pack_bytes: control.bytes,
            data_pack_bytes: data.bytes,
            access_state: self.access_state.clone(),
        }
    }
}
fn zero_oid() -> GitOid {
    GitOid::parse(&"0".repeat(64)).expect("valid OID")
}
fn invalid(message: impl Into<String>) -> SyncError {
    SyncError {
        code: SyncErrorCode::InvalidAtom,
        message: message.into(),
    }
}
fn access() -> SyncError {
    SyncError {
        code: SyncErrorCode::AccessRevoked,
        message: "local grant is not active".into(),
    }
}

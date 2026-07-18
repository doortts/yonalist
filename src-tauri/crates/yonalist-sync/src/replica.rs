use crate::transport::{Hello, PeerEndpoint};
use crate::{
    access_lock::AccessLockStore, git_store::GitStore, protocol::StoreBatch, AccessDecision,
    AccessState, AtomLimits, DeviceId, DeviceSigner, GitOid, GrantId, HelloAck, ImmutableFile,
    LocalCommit, MemberId, PackBytes, PackLimits, PackRequest, Plane, ProjectId, ProjectPolicy,
    RefAdvertisement, SignedAtom, StoredAtom, SyncError, SyncErrorCode,
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

struct ValidatedAccessLock<S> {
    notice: SignedAtom,
    state: S,
    access: AccessState,
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
    access_lock: AccessLockStore,
    lock_notice: Option<SignedAtom>,
    #[cfg(feature = "test-support")]
    pub(crate) fixture_event: u128,
    #[cfg(feature = "test-support")]
    pub(crate) fixture_data_head: Option<GitOid>,
    #[cfg(feature = "test-support")]
    pub(crate) fixture_event_refreshes: usize,
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
        let local_hello = Hello {
            project_id: config.project_id,
            member_id: config.local_member_id,
            device_id: config.local_device_id,
            grant_id: config.local_grant_id,
        };
        let access_lock = AccessLockStore::for_repository(&store.repo);
        // Read the private record and the matching Git cut while holding the
        // repository writer lock.  A malformed, foreign, or merely
        // canonical-but-wrong removal atom therefore fails closed before this
        // replica can expose an access decision.
        let (lock_notice, state) = store.with_writer(|_| {
            let lock_notice = access_lock.load(&local_hello, &config.atom_limits)?;
            let state = policy
                .rebuild_control(&store.stored_atoms(Plane::Control, &config.atom_limits)?)?;
            let state = match lock_notice.as_ref() {
                Some(notice) => validate_removal_notice(&store, &policy, &config, &state, notice)?,
                None => state,
            };
            Ok((lock_notice, state))
        })?;
        let access = policy.local_access(
            &state,
            config.local_member_id,
            config.local_device_id,
            config.local_grant_id,
        );
        #[cfg(feature = "test-support")]
        let fixture_event =
            next_fixture_event(&store, &config.atom_limits, config.local_device_id)?;
        #[cfg(feature = "test-support")]
        let fixture_data_head = store.head(Plane::Data, config.local_device_id)?;
        Ok(Self {
            config,
            store,
            policy,
            signer,
            policy_state: state,
            access_state: access,
            access_lock,
            lock_notice,
            #[cfg(feature = "test-support")]
            fixture_event,
            #[cfg(feature = "test-support")]
            fixture_data_head,
            #[cfg(feature = "test-support")]
            fixture_event_refreshes: 0,
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
        if self.has_valid_access_lock_on_disk()? {
            return Err(access());
        }
        self.store.advertise(plane)
    }
    pub fn trusted_refs(&self, plane: Plane) -> Result<RefAdvertisement, SyncError> {
        self.store.advertise(plane)
    }
    pub fn access_state(&self) -> &AccessState {
        &self.access_state
    }
    #[cfg(feature = "test-support")]
    #[doc(hidden)]
    pub fn access_lock_path_for_test(&self) -> &std::path::Path {
        self.access_lock.path()
    }
    #[cfg(feature = "test-support")]
    #[doc(hidden)]
    pub fn fail_access_lock_before_replace_once_for_test(&self) {
        self.access_lock
            .fail_once(crate::access_lock::AccessLockFailure::BeforeReplace);
    }
    #[cfg(feature = "test-support")]
    #[doc(hidden)]
    pub fn fail_access_lock_after_replace_once_for_test(&self) {
        self.access_lock
            .fail_once(crate::access_lock::AccessLockFailure::AfterReplace);
    }
    #[cfg(feature = "test-support")]
    #[doc(hidden)]
    pub fn fail_access_lock_directory_barrier_once_for_test(&self) {
        self.access_lock
            .fail_once(crate::access_lock::AccessLockFailure::DirectoryBarrier);
    }
    pub fn create_pack(
        &self,
        request: &PackRequest,
        limits: &PackLimits,
    ) -> Result<PackBytes, SyncError> {
        if self.has_valid_access_lock_on_disk()? {
            return Err(access());
        }
        self.store.create_pack(request, limits)
    }
    pub fn pull_from(&mut self, peer: &mut impl PeerEndpoint) -> Result<SyncReport, SyncError> {
        let already_locked = self.lock_notice.is_some();
        if self.refresh_access_lock_from_disk()? && !already_locked {
            return Err(access());
        }
        let ack = peer.hello(&self.local_hello())?;
        let session = match ack {
            HelloAck::Allowed { session } => {
                if self.lock_notice.is_some() {
                    return Err(access());
                }
                session
            }
            HelloAck::RemovalOnly { notice } => return self.accept_removal_notice(notice),
            HelloAck::Denied => return Err(access()),
        };
        let control = self.pull_plane(peer, &session, Plane::Control)?;
        self.rebuild_policy_state()?;
        if !matches!(self.access_state, AccessState::Active) {
            return Err(access());
        }
        let data = self.pull_plane(peer, &session, Plane::Data)?;
        #[cfg(feature = "test-support")]
        self.refresh_fixture_event_after_data_pull(&data)?;
        Ok(self.report(control, data))
    }
    pub fn append_local(&mut self, batch: LocalBatch) -> Result<LocalCommit, SyncError> {
        if self.lock_notice.is_some() {
            return Err(access());
        }
        let store = &self.store;
        let policy = &self.policy;
        let config = &self.config;
        let lock = &self.access_lock;
        let mut refreshed = None;
        let mut refreshed_lock = None;
        let result = store.with_writer(|writer| {
            let state = policy
                .rebuild_control(&store.stored_atoms(Plane::Control, &config.atom_limits)?)?;
            if let Some(notice) = lock.load(&local_hello(config), &config.atom_limits)? {
                let advanced = validate_removal_notice(store, policy, config, &state, &notice)?;
                let current_access = local_access(policy, config, &advanced);
                refreshed_lock = Some(ValidatedAccessLock {
                    notice,
                    state: advanced,
                    access: current_access,
                });
                return Err(access());
            }
            let current_access = policy.local_access(
                &state,
                config.local_member_id,
                config.local_device_id,
                config.local_grant_id,
            );
            refreshed = Some((state.clone(), current_access.clone()));
            if !matches!(current_access, AccessState::Active) {
                return Err(access());
            }
            let control = reduced_store_heads(store, Plane::Control)?;
            let data = reduced_store_heads(store, Plane::Data)?;
            for atom in &batch.atoms {
                atom.encode(&config.atom_limits)?;
                let u = &atom.unsigned;
                if u.project_id != config.project_id
                    || u.actor_member_id != config.local_member_id
                    || u.actor_device_id != config.local_device_id
                    || u.membership_grant_id != config.local_grant_id
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
                    Plane::Control => policy.validate_control(&state, &stored)?,
                    Plane::Data => policy.validate_data(&state, &stored)?,
                }
            }
            if batch.plane == Plane::Control {
                policy.preflight_control(&state, &batch.atoms)?;
            }
            let expected = store.head(batch.plane, config.local_device_id)?;
            let observed = reduced_store_heads(store, batch.plane)?
                .into_iter()
                .filter(|head| Some(head) != expected.as_ref())
                .collect();
            writer.append_local(StoreBatch {
                plane: batch.plane,
                device_id: config.local_device_id,
                expected_head: expected,
                atoms: batch.atoms,
                auxiliary_files: batch.auxiliary_files,
                observed_heads: observed,
            })
        });
        if let Some((state, access)) = refreshed {
            self.policy_state = state;
            self.access_state = access;
        }
        if let Some(lock) = refreshed_lock {
            self.apply_access_lock(lock);
        }
        result
    }
    pub fn peer_access(&self, hello: &Hello) -> Result<AccessDecision, SyncError> {
        if self.lock_notice.is_some() || self.has_valid_access_lock_on_disk()? {
            return Ok(AccessDecision::Denied);
        }
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
            .peer_access(&state, hello.member_id, hello.device_id, hello.grant_id))
    }
    fn pull_plane(
        &mut self,
        peer: &mut impl PeerEndpoint,
        session: &crate::SessionToken,
        plane: Plane,
    ) -> Result<PlanePull, SyncError> {
        let remote = peer.advertise(session, self.config.project_id, plane)?;
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
        let mut wants = BTreeSet::new();
        for (device, head) in &remote.refs {
            if local.refs.get(device) != Some(head) {
                wants.insert(head.clone());
            }
        }
        if wants.is_empty() {
            return Ok(PlanePull::empty());
        }
        let haves: Vec<_> = local
            .refs
            .values()
            .cloned()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .filter(|head| remote.refs.values().any(|remote_head| remote_head == head))
            .filter(|head| !wants.contains(head))
            .collect();
        if wants.len() + haves.len() > self.config.pack_limits.max_advertised_refs {
            return Err(SyncError {
                code: SyncErrorCode::LimitExceeded,
                message: "combined pack request exceeds ref limit".into(),
            });
        }
        let pack = peer.create_pack(
            session,
            self.config.project_id,
            &PackRequest {
                plane,
                wants: wants.into_iter().collect(),
                haves,
            },
            &self.config.pack_limits,
        )?;
        let bytes = pack.0.len();
        let store = &self.store;
        let policy = &self.policy;
        let config = &self.config;
        let lock = &self.access_lock;
        let mut refreshed_lock = None;
        let outcome = store.with_writer(|writer| {
            let prior = policy
                .rebuild_control(&store.stored_atoms(Plane::Control, &config.atom_limits)?)?;
            if let Some(notice) = lock.load(&local_hello(config), &config.atom_limits)? {
                let advanced = validate_removal_notice(store, policy, config, &prior, &notice)?;
                let current_access = local_access(policy, config, &advanced);
                refreshed_lock = Some(ValidatedAccessLock {
                    notice,
                    state: advanced,
                    access: current_access,
                });
                return Err(access());
            }
            writer.import_pack(
                config.project_id,
                plane,
                &remote,
                pack,
                &config.atom_limits,
                &config.pack_limits,
                policy,
            )
        });
        if let Some(lock) = refreshed_lock {
            self.apply_access_lock(lock);
        }
        let outcome = outcome?;
        let advanced = outcome.accepted;
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
            self.config.local_device_id,
            self.config.local_grant_id,
        );
        if self.lock_notice.is_some() {
            self.access_state = AccessState::Revoked {
                grant_id: self.config.local_grant_id,
            };
        }
        Ok(())
    }

    /// Accept the only post-removal protocol message.  This does not ask the
    /// endpoint for a ref or a pack: the notice must apply exactly to the
    /// receiver's already trusted control cut.
    fn accept_removal_notice(&mut self, notice: SignedAtom) -> Result<SyncReport, SyncError> {
        let hello = self.local_hello();
        let store = &self.store;
        let policy = &self.policy;
        let config = &self.config;
        let lock = &self.access_lock;
        let mut recovered_lock = None;
        let accepted = store.with_writer(|writer| {
            let prior = policy.rebuild_control(
                &store.stored_atoms(Plane::Control, &config.atom_limits)?,
            )?;
            let advanced = validate_removal_notice(store, policy, config, &prior, &notice)?;
            let next_access = policy.local_access(
                &advanced,
                config.local_member_id,
                config.local_device_id,
                config.local_grant_id,
            );
            if !matches!(next_access, AccessState::Revoked { grant_id } if grant_id == config.local_grant_id) {
                return Err(invalid("removal notice does not revoke the local grant"));
            }
            // This is inside the same repository writer transaction as the
            // frontier snapshot. Failures before publication leave access
            // active; failures after publication are reconciled below before
            // the original I/O error escapes.
            if let Err(original) =
                lock.persist_locked(writer, &hello, &notice, &config.atom_limits)
            {
                // Replacement and directory publication are separate fallible
                // steps. If the exact valid record is already visible, this
                // live handle must become revoked before the original I/O
                // error escapes.
                if let Ok(Some(installed)) = lock.load(&hello, &config.atom_limits) {
                    if installed == notice {
                        let installed_state =
                            validate_removal_notice(store, policy, config, &prior, &installed)?;
                        let installed_access = local_access(policy, config, &installed_state);
                        recovered_lock = Some(ValidatedAccessLock {
                            notice: installed,
                            state: installed_state,
                            access: installed_access,
                        });
                    }
                }
                return Err(original);
            }
            Ok((advanced, next_access))
        });
        if let Some(lock) = recovered_lock {
            self.apply_access_lock(lock);
        }
        let (state, access) = accepted?;
        self.apply_access_lock(ValidatedAccessLock {
            notice,
            state,
            access,
        });
        Ok(self.report(PlanePull::empty(), PlanePull::empty()))
    }

    fn has_valid_access_lock_on_disk(&self) -> Result<bool, SyncError> {
        Ok(
            load_validated_access_lock(&self.store, &self.policy, &self.config, &self.access_lock)?
                .is_some(),
        )
    }

    fn refresh_access_lock_from_disk(&mut self) -> Result<bool, SyncError> {
        if self.lock_notice.is_some() {
            return Ok(true);
        }
        let Some(lock) =
            load_validated_access_lock(&self.store, &self.policy, &self.config, &self.access_lock)?
        else {
            return Ok(false);
        };
        self.apply_access_lock(lock);
        Ok(true)
    }

    fn apply_access_lock(&mut self, lock: ValidatedAccessLock<P::State>) {
        self.policy_state = lock.state;
        self.access_state = lock.access;
        self.lock_notice = Some(lock.notice);
    }
    #[cfg(feature = "test-support")]
    pub(crate) fn reduced_heads(&self, plane: Plane) -> Result<Vec<GitOid>, SyncError> {
        reduced_store_heads(&self.store, plane)
    }
}

fn local_hello(config: &ReplicaConfig) -> Hello {
    Hello {
        project_id: config.project_id,
        member_id: config.local_member_id,
        device_id: config.local_device_id,
        grant_id: config.local_grant_id,
    }
}

fn local_access<P: ProjectPolicy>(
    policy: &P,
    config: &ReplicaConfig,
    state: &P::State,
) -> AccessState {
    policy.local_access(
        state,
        config.local_member_id,
        config.local_device_id,
        config.local_grant_id,
    )
}

fn load_validated_access_lock<P: ProjectPolicy>(
    store: &GitStore,
    policy: &P,
    config: &ReplicaConfig,
    lock: &AccessLockStore,
) -> Result<Option<ValidatedAccessLock<P::State>>, SyncError> {
    let Some(notice) = lock.load(&local_hello(config), &config.atom_limits)? else {
        return Ok(None);
    };
    let prior =
        policy.rebuild_control(&store.stored_atoms(Plane::Control, &config.atom_limits)?)?;
    let state = validate_removal_notice(store, policy, config, &prior, &notice)?;
    let access = local_access(policy, config, &state);
    Ok(Some(ValidatedAccessLock {
        notice,
        state,
        access,
    }))
}

fn reduced_store_heads(store: &GitStore, plane: Plane) -> Result<Vec<GitOid>, SyncError> {
    let heads = store
        .advertise(plane)?
        .refs
        .into_values()
        .collect::<BTreeSet<_>>();
    let mut out = Vec::new();
    for head in &heads {
        let mut redundant = false;
        for other in &heads {
            if head != other && store.is_ancestor(head, other)? {
                redundant = true;
                break;
            }
        }
        if !redundant {
            out.push(head.clone());
        }
    }
    out.sort();
    Ok(out)
}

fn validate_removal_notice<P: ProjectPolicy>(
    store: &GitStore,
    policy: &P,
    config: &ReplicaConfig,
    prior: &P::State,
    notice: &SignedAtom,
) -> Result<P::State, SyncError> {
    let encoded = notice.encode(&config.atom_limits)?;
    if SignedAtom::decode(&encoded, &config.atom_limits)? != *notice {
        return Err(invalid("removal notice is not canonically encoded"));
    }
    let unsigned = &notice.unsigned;
    if unsigned.project_id != config.project_id
        || unsigned.plane != Plane::Control
        || !unsigned.data_frontier.is_empty()
    {
        return Err(invalid("removal notice does not target this replica"));
    }
    if unsigned.control_frontier != reduced_store_heads(store, Plane::Control)? {
        return Err(invalid(
            "removal notice does not match local control frontier",
        ));
    }
    let stored = StoredAtom {
        path: notice.repo_path(),
        containing_commit: zero_oid(),
        atom: notice.clone(),
    };
    policy.validate_control(prior, &stored)?;
    policy.validate_removal_notice(prior, &stored, config.local_grant_id)?;
    let advanced = policy.advance_control(prior, &[stored])?;
    if !matches!(
        policy.local_access(
            &advanced,
            config.local_member_id,
            config.local_device_id,
            config.local_grant_id,
        ),
        AccessState::Revoked { grant_id } if grant_id == config.local_grant_id
    ) {
        return Err(invalid("removal notice does not revoke the local grant"));
    }
    Ok(advanced)
}

impl<P: ProjectPolicy> Replica<P> {
    fn report(&self, control: PlanePull, data: PlanePull) -> SyncReport {
        SyncReport {
            control_refs_advanced: control.advanced,
            data_refs_advanced: data.advanced,
            control_pack_bytes: control.bytes,
            data_pack_bytes: data.bytes,
            access_state: self.access_state.clone(),
        }
    }
    #[cfg(feature = "test-support")]
    fn refresh_fixture_event_after_data_pull(&mut self, data: &PlanePull) -> Result<(), SyncError> {
        if data.advanced == 0 {
            return Ok(());
        }
        let head = self.store.head(Plane::Data, self.config.local_device_id)?;
        if head != self.fixture_data_head {
            self.fixture_event = self.fixture_event.max(next_fixture_event(
                &self.store,
                &self.config.atom_limits,
                self.config.local_device_id,
            )?);
            self.fixture_data_head = head;
            self.fixture_event_refreshes += 1;
        }
        Ok(())
    }
}
#[cfg(feature = "test-support")]
fn next_fixture_event(
    store: &GitStore,
    limits: &AtomLimits,
    local_device: DeviceId,
) -> Result<u128, SyncError> {
    [Plane::Control, Plane::Data]
        .into_iter()
        .map(|plane| store.stored_atoms(plane, limits))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .flatten()
        .filter(|atom| atom.atom.unsigned.actor_device_id == local_device)
        .map(|atom| u128::from_be_bytes(*atom.atom.unsigned.event_id.as_uuid().as_bytes()))
        .max()
        .unwrap_or_else(|| u128::from_be_bytes(*local_device.as_uuid().as_bytes()))
        .checked_add(1)
        .ok_or_else(|| invalid("fixture event identifiers exhausted"))
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

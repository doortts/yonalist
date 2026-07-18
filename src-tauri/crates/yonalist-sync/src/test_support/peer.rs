use super::policy::{encode, FixtureControl, FixtureNotice, FixturePolicy, FixtureRole};
use crate::transport::{Hello, HelloAck, PeerEndpoint};
use crate::{
    AtomLimits, DeviceId, DeviceSigner, EventId, GrantId, LocalBatch, MemberId, PackBytes,
    PackLimits, PackRequest, Plane, ProjectId, ProjectPolicy, RefAdvertisement, Replica,
    ReplicaConfig, StoreBatch, SyncError, UnsignedAtom, ATOM_SCHEMA_V1,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    env,
    path::PathBuf,
};
use tempfile::TempDir;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PackFault {
    None,
    DropAfter(usize),
    FlipByte(usize),
}

#[derive(Clone, Copy)]
pub struct FixtureIdentity {
    pub member_id: MemberId,
    pub device_id: DeviceId,
    pub grant_id: GrantId,
}
pub struct FixturePair {
    pub alice: Replica<FixturePolicy>,
    pub bob: Replica<FixturePolicy>,
    pub alice_identity: FixtureIdentity,
    pub bob_identity: FixtureIdentity,
    _alice: TempDir,
    _bob: TempDir,
}
pub struct InProcessPeer<'a> {
    source: &'a Replica<FixturePolicy>,
    pub hello_calls: usize,
    pub control_advertise_calls: usize,
    pub data_advertise_calls: usize,
    pub control_pack_calls: usize,
    pub data_pack_calls: usize,
    session: Option<(Hello, crate::AccessDecision, Vec<FixtureNotice>)>,
    control_advertisement: Option<RefAdvertisement>,
    fault: PackFault,
    partial_response_count: usize,
    last_partial_response_len: Option<usize>,
}
impl<'a> InProcessPeer<'a> {
    pub fn new(source: &'a Replica<FixturePolicy>) -> Self {
        Self {
            source,
            hello_calls: 0,
            control_advertise_calls: 0,
            data_advertise_calls: 0,
            control_pack_calls: 0,
            data_pack_calls: 0,
            session: None,
            control_advertisement: None,
            fault: PackFault::None,
            partial_response_count: 0,
            last_partial_response_len: None,
        }
    }

    pub fn with_fault(source: &'a Replica<FixturePolicy>, fault: PackFault) -> Self {
        let mut peer = Self::new(source);
        peer.fault = fault;
        peer
    }

    pub fn partial_response_count(&self) -> usize {
        self.partial_response_count
    }

    pub fn last_partial_response_len(&self) -> Option<usize> {
        self.last_partial_response_len
    }
}
impl PeerEndpoint for InProcessPeer<'_> {
    fn hello(&mut self, hello: &Hello) -> Result<HelloAck, SyncError> {
        self.hello_calls += 1;
        self.session = None;
        self.control_advertisement = None;
        let (decision, notices) = self.current_authorization(hello)?;
        self.session = Some((hello.clone(), decision.clone(), notices));
        Ok(HelloAck { decision })
    }
    fn advertise(
        &mut self,
        project: ProjectId,
        plane: Plane,
    ) -> Result<RefAdvertisement, SyncError> {
        let decision = self.authorize(project, plane)?;
        match plane {
            Plane::Control => self.control_advertise_calls += 1,
            Plane::Data => self.data_advertise_calls += 1,
        };
        if matches!(decision, crate::AccessDecision::ControlOnly { .. }) {
            let advertised = self.control_only_advertisement(&decision)?;
            self.control_advertisement = Some(RefAdvertisement {
                plane: Plane::Control,
                refs: advertised.refs.clone(),
            });
            Ok(advertised)
        } else {
            self.source.advertise(plane)
        }
    }
    fn create_pack(
        &mut self,
        project: ProjectId,
        request: &PackRequest,
        limits: &PackLimits,
    ) -> Result<PackBytes, SyncError> {
        let decision = self.authorize(project, request.plane)?;
        if matches!(decision, crate::AccessDecision::ControlOnly { .. }) {
            let current = self.control_only_advertisement(&decision)?;
            let Some(advertised) = self.control_advertisement.as_ref() else {
                return Err(access());
            };
            if advertised.refs != current.refs
                || request.plane != Plane::Control
                || !request
                    .wants
                    .iter()
                    .all(|want| current.refs.values().any(|head| head == want))
                || !request
                    .haves
                    .iter()
                    .map(|have| {
                        current
                            .refs
                            .values()
                            .map(|head| self.source.store.is_ancestor(have, head))
                            .collect::<Result<Vec<_>, _>>()
                            .map(|results| results.into_iter().any(|authorized| authorized))
                    })
                    .collect::<Result<Vec<_>, _>>()?
                    .into_iter()
                    .all(|authorized| authorized)
            {
                return Err(access());
            }
        }
        match request.plane {
            Plane::Control => self.control_pack_calls += 1,
            Plane::Data => self.data_pack_calls += 1,
        };
        let mut pack = self.source.create_pack(request, limits)?;
        match std::mem::replace(&mut self.fault, PackFault::None) {
            PackFault::None => Ok(pack),
            PackFault::DropAfter(byte) => {
                pack.0.truncate(byte.min(pack.0.len()));
                self.partial_response_count += 1;
                self.last_partial_response_len = Some(pack.0.len());
                Err(SyncError {
                    code: crate::SyncErrorCode::Io,
                    message: "in-process pack transport dropped".into(),
                })
            }
            PackFault::FlipByte(byte) => {
                let length = pack.0.len();
                if let Some(value) = pack.0.get_mut(byte % length.max(1)) {
                    *value ^= 1;
                }
                Ok(pack)
            }
        }
    }
}
impl InProcessPeer<'_> {
    fn authorize(
        &mut self,
        project: ProjectId,
        plane: Plane,
    ) -> Result<crate::AccessDecision, SyncError> {
        let Some((hello, previous, previous_notices)) = self.session.clone() else {
            return Err(access());
        };
        if project != self.source.config.project_id || hello.project_id != project {
            return Err(access());
        }
        let (decision, notices) = match self.current_authorization(&hello) {
            Ok(authorization) => authorization,
            Err(error) => {
                self.session = None;
                self.control_advertisement = None;
                return Err(error);
            }
        };
        if decision != previous || notices != previous_notices {
            self.control_advertisement = None;
            self.session = Some((hello, decision.clone(), notices));
        }
        match (&decision, plane) {
            (crate::AccessDecision::Allowed, _)
            | (crate::AccessDecision::ControlOnly { .. }, Plane::Control) => Ok(decision),
            _ => Err(access()),
        }
    }

    fn control_only_advertisement(
        &self,
        decision: &crate::AccessDecision,
    ) -> Result<RefAdvertisement, SyncError> {
        let crate::AccessDecision::ControlOnly { .. } = decision else {
            unreachable!("control-only advertisement requires control-only decision");
        };
        let hello = &self.session.as_ref().ok_or_else(access)?.0;
        let stored = self
            .source
            .store
            .stored_atoms(Plane::Control, &self.source.config.atom_limits)?;
        let state = self.source.policy.rebuild_control(&stored)?;
        let notice_commits = stored
            .into_iter()
            .filter(|atom| state.matches_revocation_notice(hello.grant_id, atom))
            .map(|atom| atom.containing_commit)
            .collect::<BTreeSet<_>>();
        let mut refs = BTreeMap::new();
        for (device, head) in self.source.advertise(Plane::Control)?.refs {
            if notice_commits
                .iter()
                .map(|notice| self.source.store.is_ancestor(notice, &head))
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .any(|contains_notice| contains_notice)
            {
                refs.insert(device, head);
            }
        }
        Ok(RefAdvertisement {
            plane: Plane::Control,
            refs,
        })
    }

    fn current_authorization(
        &self,
        hello: &Hello,
    ) -> Result<(crate::AccessDecision, Vec<FixtureNotice>), SyncError> {
        if hello.project_id != self.source.config.project_id {
            return Ok((crate::AccessDecision::Denied, vec![]));
        }
        let stored = self
            .source
            .store
            .stored_atoms(Plane::Control, &self.source.config.atom_limits)?;
        let state = self.source.policy.rebuild_control(&stored)?;
        let decision = self.source.policy.peer_access(
            &state,
            hello.member_id,
            hello.device_id,
            hello.grant_id,
        );
        let notices = matches!(decision, crate::AccessDecision::ControlOnly { .. })
            .then(|| state.revocation_notices(hello.grant_id))
            .unwrap_or_default();
        Ok((decision, notices))
    }
}
impl FixturePair {
    pub fn new() -> Self {
        let project = ProjectId::from_bytes([1; 16]);
        let alice = FixtureIdentity {
            member_id: MemberId::from_bytes([2; 16]),
            device_id: DeviceId::from_bytes([3; 16]),
            grant_id: GrantId::from_bytes([4; 16]),
        };
        let bob = FixtureIdentity {
            member_id: MemberId::from_bytes([5; 16]),
            device_id: DeviceId::from_bytes([6; 16]),
            grant_id: GrantId::from_bytes([7; 16]),
        };
        let alice_signer = DeviceSigner::from_secret_bytes([8; 32]);
        let bob_signer = DeviceSigner::from_secret_bytes([9; 32]);
        let owner_key = alice_signer.public_key();
        let alice_dir = tempfile::tempdir().unwrap();
        let bob_dir = tempfile::tempdir().unwrap();
        let config = |path: PathBuf, id: FixtureIdentity| ReplicaConfig {
            repository: path,
            git_executable: git(),
            project_id: project,
            local_member_id: id.member_id,
            local_device_id: id.device_id,
            local_grant_id: id.grant_id,
            atom_limits: limits().0,
            pack_limits: limits().1,
        };
        let policy =
            || FixturePolicy::new(alice.member_id, alice.device_id, alice.grant_id, owner_key);
        let mut alice_replica = Replica::init(
            config(alice_dir.path().into(), alice),
            policy(),
            alice_signer,
        )
        .unwrap();
        alice_replica
            .append_fixture_control(FixtureControl::Grant {
                member_id: alice.member_id,
                device_id: alice.device_id,
                grant_id: alice.grant_id,
                role: FixtureRole::Owner,
                device_key: owner_key,
            })
            .unwrap();
        alice_replica
            .append_fixture_control(FixtureControl::Grant {
                member_id: bob.member_id,
                device_id: bob.device_id,
                grant_id: bob.grant_id,
                role: FixtureRole::Admin,
                device_key: bob_signer.public_key(),
            })
            .unwrap();
        let bob_replica =
            Replica::init(config(bob_dir.path().into(), bob), policy(), bob_signer).unwrap();
        Self {
            alice: alice_replica,
            bob: bob_replica,
            alice_identity: alice,
            bob_identity: bob,
            _alice: alice_dir,
            _bob: bob_dir,
        }
    }
    pub fn endpoint(&self) -> InProcessPeer<'_> {
        InProcessPeer::new(&self.alice)
    }
    pub fn sync_both_directions(&mut self) -> Result<(), SyncError> {
        {
            let mut p = InProcessPeer::new(&self.alice);
            self.bob.pull_from(&mut p)?;
        }
        {
            let mut p = InProcessPeer::new(&self.bob);
            self.alice.pull_from(&mut p)?;
        }
        Ok(())
    }
    pub fn reopen_alice(&mut self) -> Result<(), SyncError> {
        let signer = DeviceSigner::from_secret_bytes([8; 32]);
        let config = ReplicaConfig {
            repository: self._alice.path().into(),
            git_executable: git(),
            project_id: ProjectId::from_bytes([1; 16]),
            local_member_id: self.alice_identity.member_id,
            local_device_id: self.alice_identity.device_id,
            local_grant_id: self.alice_identity.grant_id,
            atom_limits: limits().0,
            pack_limits: limits().1,
        };
        self.alice = Replica::open(
            config,
            FixturePolicy::new(
                self.alice_identity.member_id,
                self.alice_identity.device_id,
                self.alice_identity.grant_id,
                signer.public_key(),
            ),
            signer,
        )?;
        Ok(())
    }
    pub fn open_alice_copy(&self) -> Result<Replica<FixturePolicy>, SyncError> {
        let signer = DeviceSigner::from_secret_bytes([8; 32]);
        Replica::open(
            ReplicaConfig {
                repository: self._alice.path().into(),
                git_executable: git(),
                project_id: ProjectId::from_bytes([1; 16]),
                local_member_id: self.alice_identity.member_id,
                local_device_id: self.alice_identity.device_id,
                local_grant_id: self.alice_identity.grant_id,
                atom_limits: limits().0,
                pack_limits: limits().1,
            },
            FixturePolicy::new(
                self.alice_identity.member_id,
                self.alice_identity.device_id,
                self.alice_identity.grant_id,
                signer.public_key(),
            ),
            signer,
        )
    }
}
impl Replica<FixturePolicy> {
    pub fn append_fixture_data(&mut self, payload: &[u8]) -> Result<(), SyncError> {
        self.append_fixture(Plane::Data, payload.to_vec())
    }
    pub fn append_fixture_data_batch(&mut self, payloads: Vec<Vec<u8>>) -> Result<(), SyncError> {
        let controls = self.reduced_heads(Plane::Control)?;
        let data = self.reduced_heads(Plane::Data)?;
        let mut atoms = Vec::with_capacity(payloads.len());
        for payload in payloads {
            let event = EventId::from_bytes(self.fixture_event.to_be_bytes());
            self.fixture_event += 1;
            atoms.push(self.signer.sign(UnsignedAtom {
                schema: ATOM_SCHEMA_V1,
                project_id: self.config.project_id,
                event_id: event,
                plane: Plane::Data,
                actor_member_id: self.config.local_member_id,
                actor_device_id: self.config.local_device_id,
                membership_grant_id: self.config.local_grant_id,
                control_frontier: controls.clone(),
                data_frontier: data.clone(),
                display_time_ms: self.fixture_event as i64,
                payload,
            })?);
        }
        let commit = self.append_local(LocalBatch {
            plane: Plane::Data,
            atoms,
            auxiliary_files: vec![],
        })?;
        self.fixture_data_head = Some(commit.head);
        Ok(())
    }
    pub fn revoke(&mut self, grant_id: GrantId) -> Result<(), SyncError> {
        self.append_fixture_control(FixtureControl::Revoke { grant_id })
    }
    pub fn append_unchecked_fixture_control(
        &mut self,
        value: FixtureControl,
    ) -> Result<(), SyncError> {
        let event = EventId::from_bytes(self.fixture_event.to_be_bytes());
        self.fixture_event += 1;
        let atom = self.signer.sign(UnsignedAtom {
            schema: ATOM_SCHEMA_V1,
            project_id: self.config.project_id,
            event_id: event,
            plane: Plane::Control,
            actor_member_id: self.config.local_member_id,
            actor_device_id: self.config.local_device_id,
            membership_grant_id: self.config.local_grant_id,
            control_frontier: self.reduced_heads(Plane::Control)?,
            data_frontier: vec![],
            display_time_ms: self.fixture_event as i64,
            payload: encode(&value)?,
        })?;
        let expected = self
            .store
            .head(Plane::Control, self.config.local_device_id)?;
        self.store
            .append_local(StoreBatch {
                plane: Plane::Control,
                device_id: self.config.local_device_id,
                expected_head: expected,
                atoms: vec![atom],
                auxiliary_files: vec![],
                observed_heads: vec![],
            })
            .map(|_| ())
    }
    pub fn append_fixture_controls(
        &mut self,
        values: Vec<FixtureControl>,
    ) -> Result<(), SyncError> {
        let controls = self.reduced_heads(Plane::Control)?;
        let mut atoms = Vec::with_capacity(values.len());
        for value in values {
            let event = EventId::from_bytes(self.fixture_event.to_be_bytes());
            self.fixture_event += 1;
            atoms.push(self.signer.sign(UnsignedAtom {
                schema: ATOM_SCHEMA_V1,
                project_id: self.config.project_id,
                event_id: event,
                plane: Plane::Control,
                actor_member_id: self.config.local_member_id,
                actor_device_id: self.config.local_device_id,
                membership_grant_id: self.config.local_grant_id,
                control_frontier: controls.clone(),
                data_frontier: vec![],
                display_time_ms: self.fixture_event as i64,
                payload: encode(&value)?,
            })?);
        }
        self.append_local(LocalBatch {
            plane: Plane::Control,
            atoms,
            auxiliary_files: vec![],
        })
        .map(|_| ())
    }
    pub fn loose_object_count(&self) -> usize {
        let output = self
            .store
            .git
            .run(&["count-objects".into(), "-v".into()], None)
            .unwrap();
        String::from_utf8(output)
            .unwrap()
            .lines()
            .find_map(|line| line.strip_prefix("count: "))
            .unwrap()
            .parse()
            .unwrap()
    }
    pub fn event_ids(&self, plane: Plane) -> Vec<EventId> {
        self.store
            .stored_atoms(plane, &self.config.atom_limits)
            .unwrap()
            .into_iter()
            .map(|a| a.atom.unsigned.event_id)
            .collect()
    }
    pub fn event_paths(&self, plane: Plane) -> Vec<String> {
        self.store
            .stored_atoms(plane, &self.config.atom_limits)
            .unwrap()
            .into_iter()
            .map(|atom| atom.path)
            .collect()
    }
    pub fn fixture_event_refresh_count(&self) -> usize {
        self.fixture_event_refreshes
    }
    pub fn payloads(&self) -> Vec<Vec<u8>> {
        self.store
            .stored_atoms(Plane::Data, &self.config.atom_limits)
            .unwrap()
            .into_iter()
            .map(|a| a.atom.unsigned.payload)
            .collect()
    }
    fn append_fixture_control(&mut self, value: FixtureControl) -> Result<(), SyncError> {
        self.append_fixture(Plane::Control, encode(&value)?)
    }
    fn append_fixture(&mut self, plane: Plane, payload: Vec<u8>) -> Result<(), SyncError> {
        let event = EventId::from_bytes(self.fixture_event.to_be_bytes());
        self.fixture_event += 1;
        let controls = self.reduced_heads(Plane::Control)?;
        let data = if plane == Plane::Data {
            self.reduced_heads(Plane::Data)?
        } else {
            vec![]
        };
        let atom = self.signer.sign(UnsignedAtom {
            schema: ATOM_SCHEMA_V1,
            project_id: self.config.project_id,
            event_id: event,
            plane,
            actor_member_id: self.config.local_member_id,
            actor_device_id: self.config.local_device_id,
            membership_grant_id: self.config.local_grant_id,
            control_frontier: controls,
            data_frontier: data,
            display_time_ms: self.fixture_event as i64,
            payload,
        })?;
        let commit = self.append_local(LocalBatch {
            plane,
            atoms: vec![atom],
            auxiliary_files: vec![],
        })?;
        if plane == Plane::Data {
            self.fixture_data_head = Some(commit.head);
        }
        Ok(())
    }
}
fn limits() -> (AtomLimits, PackLimits) {
    (
        AtomLimits {
            max_payload_bytes: 1 << 20,
            max_frontier_heads: 32,
        },
        PackLimits {
            max_pack_bytes: 1 << 24,
            max_advertised_refs: 32,
            max_atoms_per_head: 256,
        },
    )
}
fn git() -> PathBuf {
    env::var_os("YONALIST_TEST_GIT")
        .map(PathBuf::from)
        .unwrap_or_else(|| "git".into())
}
fn access() -> SyncError {
    SyncError {
        code: crate::SyncErrorCode::AccessRevoked,
        message: "peer session is not authorized".into(),
    }
}

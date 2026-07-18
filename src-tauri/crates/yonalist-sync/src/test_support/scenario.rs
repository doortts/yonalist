use super::{
    FixtureControl, FixtureIdentity, FixturePair, FixturePolicy, FixtureRole, InProcessPeer,
    PackFault,
};
use crate::{
    AtomLimits, DeviceId, DeviceSigner, EventId, GitOid, GrantId, MemberId, PackLimits, Plane,
    ProjectId, Replica, ReplicaConfig, SyncError, SyncErrorCode, SyncReport,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, env, path::PathBuf, thread};
use tempfile::TempDir;

#[derive(Clone, Debug)]
pub struct ScenarioConfig {
    pub peers: usize,
    pub events: usize,
    pub seed: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ScenarioSummary {
    pub scenario: String,
    pub peers: usize,
    pub events: usize,
    pub rounds: usize,
    pub converged: bool,
    pub rejected_packs: usize,
    pub revoked_peers: usize,
    pub final_event_digest: String,
}

struct LabReplica {
    replica: Replica<FixturePolicy>,
    _dir: TempDir,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct RefCache {
    control: BTreeMap<DeviceId, GitOid>,
    data: BTreeMap<DeviceId, GitOid>,
}

impl RefCache {
    fn read(replica: &Replica<FixturePolicy>) -> Result<Self, SyncError> {
        Ok(Self {
            control: replica.trusted_refs(Plane::Control)?.refs,
            data: replica.trusted_refs(Plane::Data)?.refs,
        })
    }

    fn refresh(&mut self, replica: &Replica<FixturePolicy>) -> Result<(), SyncError> {
        *self = Self::read(replica)?;
        Ok(())
    }

    fn update_after_pull(
        &mut self,
        replica: &Replica<FixturePolicy>,
        report: &SyncReport,
    ) -> Result<(), SyncError> {
        if report.control_refs_advanced + report.data_refs_advanced > 0 {
            self.refresh(replica)?;
        }
        Ok(())
    }

    fn assert_current(&self, replica: &Replica<FixturePolicy>) -> Result<(), SyncError> {
        if self != &Self::read(replica)? {
            return Err(limit("scenario ref cache is stale"));
        }
        Ok(())
    }
}

pub fn run_mesh(config: ScenarioConfig) -> Result<ScenarioSummary, SyncError> {
    if !(1..=100).contains(&config.peers) || config.events > 10_000 {
        return Err(limit("scenario config is outside supported bounds"));
    }
    let mut state = config.seed;
    let project = ProjectId::from_bytes(bytes(&mut state));
    let identities = (0..config.peers)
        .map(|_| identity(&mut state))
        .collect::<Vec<_>>();
    let secrets = (0..config.peers)
        .map(|_| bytes32(&mut state))
        .collect::<Vec<_>>();
    let owner_key = DeviceSigner::from_secret_bytes(secrets[0]).public_key();
    let mut peers = identities
        .iter()
        .zip(&secrets)
        .map(|(identity, secret)| {
            let dir = tempfile::tempdir().map_err(io)?;
            let replica = Replica::init(
                config_for(dir.path().into(), project, *identity),
                FixturePolicy::new(
                    identities[0].member_id,
                    identities[0].device_id,
                    identities[0].grant_id,
                    owner_key,
                ),
                DeviceSigner::from_secret_bytes(*secret),
            )?;
            Ok(LabReplica { replica, _dir: dir })
        })
        .collect::<Result<Vec<_>, SyncError>>()?;
    let mut grants = identities
        .iter()
        .zip(&secrets)
        .enumerate()
        .map(|(index, (identity, secret))| FixtureControl::Grant {
            member_id: identity.member_id,
            device_id: identity.device_id,
            grant_id: identity.grant_id,
            role: if index == 0 {
                FixtureRole::Owner
            } else {
                FixtureRole::Member
            },
            device_key: DeviceSigner::from_secret_bytes(*secret).public_key(),
        })
        .collect::<Vec<_>>();
    peers[0]
        .replica
        .append_fixture_controls(vec![grants.remove(0)])?;
    peers[0].replica.append_fixture_controls(grants)?;
    let mut refs = peers
        .iter()
        .map(|peer| RefCache::read(&peer.replica))
        .collect::<Result<Vec<_>, _>>()?;
    // The shuffled hub is a deterministic initial partition boundary: only it
    // starts with data, while the seeded hub edge guarantees every component is
    // connected before a zero-advance round can terminate the run.
    let mut order = permutation(config.peers, &mut state);
    let selected_hub = order[0];
    peers.swap(0, selected_hub);
    refs.swap(0, selected_hub);
    for value in &mut order {
        if *value == 0 {
            *value = selected_hub;
        } else if *value == selected_hub {
            *value = 0;
        }
    }
    pull(&mut peers, &mut refs, 0, selected_hub)?;
    peers[0].replica.append_fixture_data_batch(
        (0..config.events)
            .map(|event| format!("{:#016x}:{event}", config.seed).into_bytes())
            .collect(),
    )?;
    refs[0].refresh(&peers[0].replica)?;
    let mut rounds = 0;
    loop {
        rounds += 1;
        let mut advanced = 0;
        advanced += pull_hub_parallel(&mut peers, &mut refs)?;
        for &destination in &order {
            let random_source = order[(next_u64(&mut state) as usize) % config.peers];
            advanced += pull(&mut peers, &mut refs, destination, random_source)?;
        }
        if advanced == 0 {
            break;
        }
        if rounds == 2 {
            return Err(limit(
                "seeded hub schedule did not converge within two rounds",
            ));
        }
    }
    for (peer, cache) in peers.iter().zip(&refs) {
        cache.assert_current(&peer.replica)?;
    }
    let (converged, final_digest) = summarize_events(&peers, config.events, |peer| {
        peer.replica.event_ids(Plane::Data)
    });
    Ok(ScenarioSummary {
        scenario: "mesh".into(),
        peers: config.peers,
        events: config.events,
        rounds,
        converged,
        rejected_packs: 0,
        revoked_peers: 0,
        final_event_digest: final_digest,
    })
}

pub fn run_corrupt_pack(seed: u64) -> Result<ScenarioSummary, SyncError> {
    let mut pair = FixturePair::new();
    pair.alice
        .append_fixture_data(format!("corrupt:{seed}").as_bytes())?;
    let mut endpoint = InProcessPeer::with_fault(&pair.alice, PackFault::FlipByte(0));
    let error = pair.bob.pull_from(&mut endpoint).unwrap_err();
    if error.code != SyncErrorCode::PackRejected {
        return Err(error);
    }
    pair.bob.pull_from(&mut endpoint)?;
    let digest = digest(&pair.bob.event_ids(Plane::Data));
    Ok(ScenarioSummary {
        scenario: "corrupt-pack".into(),
        peers: 2,
        events: 1,
        rounds: 2,
        converged: pair.alice.event_ids(Plane::Data) == pair.bob.event_ids(Plane::Data),
        rejected_packs: 1,
        revoked_peers: 0,
        final_event_digest: digest,
    })
}

pub fn run_revocation(seed: u64) -> Result<ScenarioSummary, SyncError> {
    let mut pair = FixturePair::new();
    pair.sync_both_directions()?;
    pair.alice.revoke(pair.bob_identity.grant_id)?;
    pair.alice
        .append_fixture_data(format!("revoked:{seed}").as_bytes())?;
    let report = pair.bob.pull_from(&mut InProcessPeer::new(&pair.alice))?;
    let revoked = usize::from(matches!(
        report.access_state,
        crate::AccessState::Revoked { .. }
    ));
    let digest = digest(&pair.alice.event_ids(Plane::Data));
    Ok(ScenarioSummary {
        scenario: "revocation".into(),
        peers: 2,
        events: 1,
        rounds: 1,
        converged: revoked == 1,
        rejected_packs: 0,
        revoked_peers: revoked,
        final_event_digest: digest,
    })
}

fn pull(
    peers: &mut [LabReplica],
    refs: &mut [RefCache],
    destination: usize,
    source: usize,
) -> Result<usize, SyncError> {
    if destination == source || refs[destination] == refs[source] {
        return Ok(0);
    }
    let report = if destination < source {
        let (left, right) = peers.split_at_mut(source);
        left[destination]
            .replica
            .pull_from(&mut InProcessPeer::new(&right[0].replica))?
    } else {
        let (left, right) = peers.split_at_mut(destination);
        right[0]
            .replica
            .pull_from(&mut InProcessPeer::new(&left[source].replica))?
    };
    refs[destination].update_after_pull(&peers[destination].replica, &report)?;
    Ok(report.control_refs_advanced + report.data_refs_advanced)
}

fn pull_hub_parallel(
    peers: &mut Vec<LabReplica>,
    refs: &mut Vec<RefCache>,
) -> Result<usize, SyncError> {
    let hub = peers.remove(0);
    let hub_refs = refs.remove(0);
    let receivers = peers.drain(..).zip(refs.drain(..)).enumerate();
    let worker_count = thread::available_parallelism()
        .map_or(1, usize::from)
        .min(8)
        .min(receivers.len().max(1));
    let mut jobs = (0..worker_count).map(|_| Vec::new()).collect::<Vec<_>>();
    for (offset, (receiver, cache)) in receivers {
        jobs[offset % worker_count].push((offset + 1, receiver, cache));
    }
    let mut outcomes = thread::scope(|scope| {
        jobs.into_iter()
            .map(|job| {
                scope.spawn(|| {
                    job.into_iter()
                        .map(|(index, mut receiver, mut cache)| {
                            let result = if cache == hub_refs {
                                Ok(0)
                            } else {
                                receiver
                                    .replica
                                    .pull_from(&mut InProcessPeer::new(&hub.replica))
                                    .and_then(|report| {
                                        let advanced = report.control_refs_advanced
                                            + report.data_refs_advanced;
                                        cache.update_after_pull(&receiver.replica, &report)?;
                                        Ok(advanced)
                                    })
                            };
                            (index, receiver, cache, result)
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect::<Vec<_>>()
            .into_iter()
            .flat_map(|worker| worker.join().expect("scenario worker panicked"))
            .collect::<Vec<_>>()
    });
    outcomes.sort_by_key(|(index, _, _, _)| *index);
    peers.push(hub);
    refs.push(hub_refs);
    let mut advanced = 0;
    let mut first_error = None;
    for (_, receiver, cache, result) in outcomes {
        peers.push(receiver);
        refs.push(cache);
        match result {
            Ok(count) => advanced += count,
            Err(error) if first_error.is_none() => first_error = Some(error),
            Err(_) => {}
        }
    }
    match first_error {
        Some(error) => Err(error),
        None => Ok(advanced),
    }
}

fn identity(state: &mut u64) -> FixtureIdentity {
    FixtureIdentity {
        member_id: MemberId::from_bytes(bytes(state)),
        device_id: DeviceId::from_bytes(bytes(state)),
        grant_id: GrantId::from_bytes(bytes(state)),
    }
}
fn bytes(state: &mut u64) -> [u8; 16] {
    let mut out = [0; 16];
    out[..8].copy_from_slice(&next_u64(state).to_be_bytes());
    out[8..].copy_from_slice(&next_u64(state).to_be_bytes());
    out
}
fn bytes32(state: &mut u64) -> [u8; 32] {
    let mut out = [0; 32];
    for chunk in out.chunks_exact_mut(8) {
        chunk.copy_from_slice(&next_u64(state).to_be_bytes());
    }
    out
}
fn next_u64(state: &mut u64) -> u64 {
    *state ^= *state << 13;
    *state ^= *state >> 7;
    *state ^= *state << 17;
    *state
}
fn permutation(count: usize, state: &mut u64) -> Vec<usize> {
    let mut values = (0..count).collect::<Vec<_>>();
    for index in (1..count).rev() {
        values.swap(index, (next_u64(state) as usize) % (index + 1));
    }
    values
}
fn digest(ids: &[EventId]) -> String {
    let mut sorted = ids.to_vec();
    sorted.sort();
    digest_sorted(&sorted)
}
fn digest_sorted(ids: &[EventId]) -> String {
    let mut hash = Sha256::new();
    for id in ids {
        hash.update(id.as_uuid().as_bytes());
    }
    hash.finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
fn summarize_events<T>(
    peers: &[T],
    expected_events: usize,
    mut snapshot: impl FnMut(&T) -> Vec<EventId>,
) -> (bool, String) {
    let mut snapshots = peers.iter().map(&mut snapshot).collect::<Vec<_>>();
    for ids in &mut snapshots {
        ids.sort();
    }
    let first = &snapshots[0];
    let converged = snapshots
        .iter()
        .all(|ids| ids.len() == expected_events && ids == first);
    (converged, digest_sorted(first))
}
fn config_for(
    repository: PathBuf,
    project_id: ProjectId,
    identity: FixtureIdentity,
) -> ReplicaConfig {
    ReplicaConfig {
        repository,
        git_executable: env::var_os("YONALIST_TEST_GIT")
            .map(PathBuf::from)
            .unwrap_or_else(|| "git".into()),
        project_id,
        local_member_id: identity.member_id,
        local_device_id: identity.device_id,
        local_grant_id: identity.grant_id,
        atom_limits: AtomLimits {
            max_payload_bytes: 1 << 20,
            max_frontier_heads: 32,
        },
        pack_limits: PackLimits {
            max_pack_bytes: 1 << 24,
            max_advertised_refs: 32,
            max_atoms_per_head: 10_010,
        },
    }
}
fn io(error: std::io::Error) -> SyncError {
    SyncError {
        code: SyncErrorCode::Io,
        message: error.to_string(),
    }
}
fn limit(message: impl Into<String>) -> SyncError {
    SyncError {
        code: SyncErrorCode::LimitExceeded,
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn ref_cache_updates_only_after_an_advancing_pull() {
        let mut pair = FixturePair::new();
        let mut cache = RefCache::read(&pair.bob).unwrap();
        pair.alice.append_fixture_data(b"cached").unwrap();

        let before = cache.clone();
        let mut faulty = InProcessPeer::with_fault(&pair.alice, PackFault::FlipByte(0));
        assert!(pair.bob.pull_from(&mut faulty).is_err());
        assert_eq!(cache, before);

        let report = pair.bob.pull_from(&mut faulty).unwrap();
        cache.update_after_pull(&pair.bob, &report).unwrap();
        cache.assert_current(&pair.bob).unwrap();

        let before_noop = cache.clone();
        let report = pair
            .bob
            .pull_from(&mut InProcessPeer::new(&pair.alice))
            .unwrap();
        cache.update_after_pull(&pair.bob, &report).unwrap();
        assert_eq!(cache, before_noop);
    }

    #[test]
    fn convergence_snapshots_each_peer_once_and_checks_the_event_count() {
        let calls = Cell::new(0);
        let event = EventId::from_bytes([7; 16]);
        let (converged, _) = summarize_events(&[vec![event], vec![event]], 1, |ids| {
            calls.set(calls.get() + 1);
            ids.clone()
        });
        assert!(converged);
        assert_eq!(calls.get(), 2);

        let (converged, _) = summarize_events(&[vec![event], vec![event]], 2, Clone::clone);
        assert!(!converged);
    }
}

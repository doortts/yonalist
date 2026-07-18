use super::{
    FixtureControl, FixtureIdentity, FixturePair, FixturePolicy, FixtureRole, InProcessPeer,
    PackFault,
};
use crate::{
    AtomLimits, DeviceId, DeviceSigner, EventId, GitOid, GrantId, MemberId, PackLimits,
    PeerEndpoint, Plane, ProjectId, Replica, ReplicaConfig, SyncError, SyncErrorCode, SyncReport,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    env,
    path::PathBuf,
    thread,
};
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
    if !(1..=100).contains(&config.peers) || config.events > 500 {
        return Err(limit("scenario config is outside supported bounds"));
    }
    let mut partition = build_partition(config.clone())?;
    let rounds =
        reconnect_until_quiet(|round| reconnect_round(&mut partition, config.seed, round))?;
    for (peer, cache) in partition.peers.iter().zip(&partition.refs) {
        cache.assert_current(&peer.replica)?;
    }
    let (converged, final_digest) = summarize_events(&partition.peers, config.events, |peer| {
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

#[cfg_attr(not(test), allow(dead_code))]
struct Partition {
    peers: Vec<LabReplica>,
    refs: Vec<RefCache>,
    leaders: Vec<usize>,
    group_count: usize,
    data_ref_owners: BTreeSet<DeviceId>,
    no_cross_group_data_refs: bool,
    event_count: usize,
}

fn build_partition(config: ScenarioConfig) -> Result<Partition, SyncError> {
    if !(1..=100).contains(&config.peers) || config.events > 500 {
        return Err(limit("scenario config is outside supported bounds"));
    }
    let project = ProjectId::from_bytes(derived::<16>(config.seed, 0, b"project"));
    let identities = (0..config.peers)
        .map(|index| identity(config.seed, index))
        .collect::<Vec<_>>();
    let secrets = (0..config.peers)
        .map(|index| derived::<32>(config.seed, index, b"signing-key"))
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

    // Establish the common authorization baseline before isolating data traffic.
    for destination in 1..config.peers {
        pull(&mut peers, &mut refs, destination, 0)?;
    }

    let group_count = usize::from(config.peers > 1) + 1;
    let mut order = permutation(config.peers, schedule_state(config.seed, 0, 0, b"groups"));
    let mut groups = vec![Vec::new(); group_count];
    for (position, peer) in order.drain(..).enumerate() {
        groups[position % group_count].push(peer);
    }
    let leaders = groups.iter().map(|group| group[0]).collect::<Vec<_>>();
    let mut payloads = vec![Vec::new(); group_count];
    for event in 0..config.events {
        payloads[event % group_count].push(format!("{:#016x}:{event}", config.seed).into_bytes());
    }
    for (group, &leader) in leaders.iter().enumerate() {
        if payloads[group].is_empty() {
            continue;
        }
        let event_domain = u64::from_be_bytes(derived::<8>(config.seed, leader, b"event-domain"));
        peers[leader].replica.fixture_event =
            ((leader as u128 + 1) << 96) | (u128::from(event_domain) << 32);
        peers[leader]
            .replica
            .append_fixture_data_batch(std::mem::take(&mut payloads[group]))?;
        refs[leader].refresh(&peers[leader].replica)?;
    }

    // One explicit isolated round: every selected edge stays within its group.
    for (group_index, group) in groups.iter().enumerate() {
        for (destination_position, &destination) in group.iter().enumerate() {
            for source_position in
                local_partner_positions(config.seed, group_index, destination_position, group.len())
            {
                pull(&mut peers, &mut refs, destination, group[source_position])?;
            }
        }
    }
    let mut data_ref_owners = BTreeSet::new();
    let mut no_cross_group_data_refs = true;
    for group in &groups {
        let allowed = group
            .iter()
            .map(|&peer| identities[peer].device_id)
            .collect::<BTreeSet<_>>();
        for &peer in group {
            data_ref_owners.extend(refs[peer].data.keys().copied());
            no_cross_group_data_refs &= refs[peer]
                .data
                .keys()
                .all(|device| allowed.contains(device));
        }
    }
    let event_count = leaders
        .iter()
        .flat_map(|&leader| peers[leader].replica.event_ids(Plane::Data))
        .collect::<BTreeSet<_>>()
        .len();
    Ok(Partition {
        peers,
        refs,
        leaders,
        group_count,
        data_ref_owners,
        no_cross_group_data_refs,
        event_count,
    })
}

fn reconnect_round(partition: &mut Partition, seed: u64, round: usize) -> Result<usize, SyncError> {
    let mut advanced = 0;
    let canonical = partition.leaders[0];
    let other_leaders = partition.leaders[1..].to_vec();
    for &leader in &other_leaders {
        advanced += pull(&mut partition.peers, &mut partition.refs, canonical, leader)?;
    }
    for &leader in &other_leaders {
        advanced += pull(&mut partition.peers, &mut partition.refs, leader, canonical)?;
    }
    if canonical != 0 {
        partition.peers.swap(0, canonical);
        partition.refs.swap(0, canonical);
        advanced += pull_hub_parallel(&mut partition.peers, &mut partition.refs)?;
        partition.peers.swap(0, canonical);
        partition.refs.swap(0, canonical);
    } else {
        advanced += pull_hub_parallel(&mut partition.peers, &mut partition.refs)?;
    }
    for destination in 0..partition.peers.len() {
        for source in scheduled_partners(round, seed, destination, partition.peers.len()) {
            advanced += pull(
                &mut partition.peers,
                &mut partition.refs,
                destination,
                source,
            )?;
        }
    }
    Ok(advanced)
}

fn reconnect_until_quiet(
    mut round: impl FnMut(usize) -> Result<usize, SyncError>,
) -> Result<usize, SyncError> {
    for number in 1..=200 {
        if round(number - 1)? == 0 {
            return Ok(number);
        }
    }
    Err(limit("mesh did not converge within 200 reconnect rounds"))
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
    let source_before = RefCache::read(&pair.alice)?;
    let receiver_before = RefCache::read(&pair.bob)?;
    let expected_notice = match pair.alice.peer_access(&pair.bob.local_hello())? {
        crate::AccessDecision::RemovalOnly { notice } => notice,
        _ => {
            return Err(limit(
                "revoked fixture peer did not receive a removal notice",
            ))
        }
    };
    let mut endpoint = InProcessPeer::new(&pair.alice);
    let exact_notice = matches!(
        endpoint.hello(&pair.bob.local_hello())?,
        crate::HelloAck::RemovalOnly { notice } if notice == expected_notice
    );
    let report = pair.bob.pull_from(&mut endpoint)?;
    let source_unchanged = source_before == RefCache::read(&pair.alice)?;
    let receiver_unchanged = receiver_before == RefCache::read(&pair.bob)?;
    let no_history_served = endpoint.control_advertise_calls == 0
        && endpoint.data_advertise_calls == 0
        && endpoint.control_pack_calls == 0
        && endpoint.data_pack_calls == 0;
    let no_payload = !pair
        .bob
        .payloads()
        .contains(&format!("revoked:{seed}").into_bytes());
    pair.reopen_bob()?;
    let append_rejected = matches!(
        pair.bob.append_fixture_data(b"post-revocation"),
        Err(SyncError {
            code: SyncErrorCode::AccessRevoked,
            ..
        })
    );
    let revoked = usize::from(matches!(
        pair.bob.access_state(),
        crate::AccessState::Revoked { .. }
    ));
    let digest = digest(&pair.alice.event_ids(Plane::Data));
    Ok(ScenarioSummary {
        scenario: "revocation".into(),
        peers: 2,
        events: 1,
        rounds: 1,
        converged: revoked == 1
            && exact_notice
            && source_unchanged
            && receiver_unchanged
            && no_history_served
            && no_payload
            && append_rejected
            && report.control_refs_advanced == 0
            && report.data_refs_advanced == 0
            && report.control_pack_bytes == 0
            && report.data_pack_bytes == 0,
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

fn identity(seed: u64, index: usize) -> FixtureIdentity {
    FixtureIdentity {
        member_id: MemberId::from_bytes(derived::<16>(seed, index, b"member")),
        device_id: DeviceId::from_bytes(derived::<16>(seed, index, b"device")),
        grant_id: GrantId::from_bytes(derived::<16>(seed, index, b"grant")),
    }
}
fn derived<const N: usize>(seed: u64, index: usize, domain: &[u8]) -> [u8; N] {
    let mut hash = Sha256::new();
    hash.update(b"yonalist-sync-lab/v1");
    hash.update(domain);
    hash.update(seed.to_be_bytes());
    hash.update((index as u64).to_be_bytes());
    let digest = hash.finalize();
    let mut out = [0; N];
    out.copy_from_slice(&digest[..N]);
    out
}
fn next_u64(state: &mut u64) -> u64 {
    *state ^= *state << 13;
    *state ^= *state >> 7;
    *state ^= *state << 17;
    *state
}
fn schedule_state(seed: u64, round: usize, peer: usize, domain: &[u8]) -> u64 {
    let bytes = derived::<16>(seed, round ^ peer.rotate_left(13), domain);
    let mut state = u64::from_be_bytes(bytes[..8].try_into().unwrap());
    if state == 0 {
        state = 0x9e37_79b9_7f4a_7c15;
    }
    state
}
fn permutation(count: usize, mut state: u64) -> Vec<usize> {
    let mut values = (0..count).collect::<Vec<_>>();
    for index in (1..count).rev() {
        values.swap(index, (next_u64(&mut state) as usize) % (index + 1));
    }
    values
}
fn scheduled_partners(round: usize, seed: u64, peer: usize, peers: usize) -> Vec<usize> {
    if peers <= 1 {
        return Vec::new();
    }
    let mut candidates = (0..peers)
        .filter(|candidate| *candidate != peer)
        .collect::<Vec<_>>();
    let mut state = schedule_state(seed, round, peer, b"reconnect-partners");
    for index in (1..candidates.len()).rev() {
        candidates.swap(index, (next_u64(&mut state) as usize) % (index + 1));
    }
    candidates.truncate(2);
    candidates
}
fn local_partner_positions(
    seed: u64,
    group: usize,
    peer_position: usize,
    peers: usize,
) -> Vec<usize> {
    scheduled_partners(group, seed, peer_position, peers)
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
        pack_limits: PackLimits::default(),
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

    #[test]
    fn seeded_partners_are_distinct_deterministic_and_never_self() {
        for peers in 3..10 {
            for peer in 0..peers {
                let first = scheduled_partners(0, 7, peer, peers);
                assert_eq!(first, scheduled_partners(0, 7, peer, peers));
                assert_eq!(first.len(), 2);
                assert_ne!(first[0], first[1]);
                assert!(!first.contains(&peer));
            }
        }
        let first_round = (0..6)
            .map(|peer| scheduled_partners(0, 7, peer, 6))
            .collect::<Vec<_>>();
        let second_round = (0..6)
            .map(|peer| scheduled_partners(1, 7, peer, 6))
            .collect::<Vec<_>>();
        assert_ne!(first_round, second_round);
        assert!(scheduled_partners(0, 1, 0, 1).is_empty());
        assert_eq!(scheduled_partners(0, 1, 0, 2), vec![1]);
    }

    #[test]
    fn partition_has_multiple_groups_and_no_cross_group_data_refs() {
        let trace = build_partition(ScenarioConfig {
            peers: 6,
            events: 17,
            seed: 0,
        })
        .unwrap();
        assert!(trace.group_count >= 2);
        assert!(trace.data_ref_owners.len() >= 2);
        assert!(trace.no_cross_group_data_refs);
        assert_eq!(trace.event_count, 17);
    }

    #[test]
    fn reconnect_loop_stops_at_exactly_two_hundred_rounds() {
        let mut calls = 0;
        let error = reconnect_until_quiet(|_| {
            calls += 1;
            Ok(1)
        })
        .unwrap_err();
        assert_eq!(calls, 200);
        assert_eq!(error.code, SyncErrorCode::LimitExceeded);
    }
}

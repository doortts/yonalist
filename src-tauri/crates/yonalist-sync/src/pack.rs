use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use crate::{
    git_store::{GitStore, RepositoryWriter, TrustedSnapshot},
    AtomLimits, DeviceId, GitOid, Plane, ProjectId, ProjectPolicy, RefAdvertisement, StoredAtom,
    SyncError, SyncErrorCode,
};

static QUARANTINE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PackLimits {
    pub max_pack_bytes: usize,
    pub max_advertised_refs: usize,
    pub max_atoms_per_head: usize,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PackRequest {
    pub plane: Plane,
    pub wants: Vec<GitOid>,
    pub haves: Vec<GitOid>,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PackBytes(pub Vec<u8>);
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CandidateRef {
    pub device_id: DeviceId,
    pub previous: Option<GitOid>,
    pub accepted_head: GitOid,
    pub source_advertised_head: GitOid,
}
#[derive(Debug)]
pub struct ImportOutcome {
    pub accepted: usize,
    pub rejected: Vec<(DeviceId, SyncErrorCode)>,
    pub pack_bytes: usize,
    accepted_refs: Vec<CandidateRef>,
}

impl ImportOutcome {
    pub fn accepted_refs(&self) -> &[CandidateRef] {
        &self.accepted_refs
    }

    pub fn accepted(&self) -> &[CandidateRef] {
        self.accepted_refs()
    }

    pub fn rejected(&self) -> &[(DeviceId, SyncErrorCode)] {
        &self.rejected
    }
}

impl GitStore {
    pub fn create_pack(
        &self,
        request: &PackRequest,
        limits: &PackLimits,
    ) -> Result<PackBytes, SyncError> {
        if request.wants.is_empty()
            || request.wants.len() + request.haves.len() > limits.max_advertised_refs
        {
            return Err(limit("invalid pack request"));
        }
        let mut seen = std::collections::BTreeSet::new();
        if !request
            .wants
            .iter()
            .chain(&request.haves)
            .all(|oid| seen.insert(oid))
        {
            return Err(limit("duplicate pack ref"));
        }
        let mut input = Vec::new();
        for want in &request.wants {
            input.extend_from_slice(want.as_str().as_bytes());
            input.push(b'\n');
        }
        for have in &request.haves {
            input.extend_from_slice(format!("^{}\n", have.as_str()).as_bytes());
        }
        let bytes = self.git.run(
            &[
                "pack-objects".into(),
                "--stdout".into(),
                "--revs".into(),
                "--thin".into(),
            ],
            Some(&input),
        )?;
        if bytes.is_empty() {
            return Err(pack("empty pack"));
        }
        if bytes.len() > limits.max_pack_bytes {
            return Err(limit("pack exceeds byte limit"));
        }
        Ok(PackBytes(bytes))
    }

    /// Low-level combined import retained for standalone component tests.
    /// Application writes use `Replica`, which supplies its configured project.
    #[doc(hidden)]
    pub fn import_pack<P: ProjectPolicy>(
        &self,
        expected_project_id: ProjectId,
        plane: Plane,
        advertised: &RefAdvertisement,
        pack_bytes: PackBytes,
        atom_limits: &AtomLimits,
        pack_limits: &PackLimits,
        policy: &P,
    ) -> Result<ImportOutcome, SyncError> {
        self.with_writer(|writer| {
            writer.import_pack(
                expected_project_id,
                plane,
                advertised,
                pack_bytes,
                atom_limits,
                pack_limits,
                policy,
            )
        })
    }

    fn import_locked<P: ProjectPolicy>(
        &self,
        expected_project_id: ProjectId,
        plane: Plane,
        advertised: &RefAdvertisement,
        pack_bytes: PackBytes,
        atom_limits: &AtomLimits,
        pack_limits: &PackLimits,
        policy: &P,
    ) -> Result<ImportOutcome, SyncError> {
        if advertised.plane != plane
            || advertised.refs.len() > pack_limits.max_advertised_refs
            || pack_bytes.0.is_empty()
        {
            return Err(pack("invalid advertised pack"));
        }
        if pack_bytes.0.len() > pack_limits.max_pack_bytes {
            return Err(limit("pack exceeds byte limit"));
        }
        let snapshot = self.trusted_snapshot()?;
        let pack_bytes_len = pack_bytes.0.len();
        let quarantine = self.quarantine()?;
        let result = (|| {
            self.git
                .run_at(
                    &quarantine,
                    &["index-pack".into(), "--stdin".into(), "--fix-thin".into()],
                    Some(&pack_bytes.0),
                )
                .map_err(|_| pack("pack import failed"))?;
            let mut accepted = Vec::new();
            let mut rejected = Vec::new();
            // Every currently advertised local head is a trusted DAG boundary.
            let exact_trusted_heads = snapshot_for_plane(&snapshot, plane)
                .refs
                .values()
                .cloned()
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect::<Vec<_>>();
            let trusted_heads =
                reduced_frontier(&self.git, &quarantine, exact_trusted_heads.iter().cloned())?;
            let mut memo = ImportMemo::new();
            let validation = ValidationContext::new(
                &self.git,
                &quarantine,
                plane,
                trusted_heads.clone(),
                exact_trusted_heads,
                &mut memo,
            )?;
            let mut eligible = Vec::new();
            for (device, head) in &advertised.refs {
                let previous = snapshot_for_plane(&snapshot, plane)
                    .refs
                    .get(device)
                    .cloned();
                if previous.as_ref() == Some(head) {
                    continue;
                }
                if let Some(old) = &previous {
                    if !first_parent_ancestor(&self.git, &quarantine, old, head)? {
                        rejected.push((*device, SyncErrorCode::RefRewind));
                        continue;
                    }
                }
                eligible.push((*device, head.clone(), previous));
            }
            let mut candidates = eligible
                .into_iter()
                .map(|(device, head, previous)| Candidate {
                    device,
                    current: Some(head.clone()),
                    advertised: head,
                    previous,
                })
                .collect::<Vec<_>>();
            // Replay each revised union transactionally. Control starts at genesis;
            // data keeps the already-current trusted control state.
            loop {
                let mut union = validation.clone();
                // A trusted object is not automatically trusted under another
                // device ref. Re-validate any changed candidate whose head is
                // already a boundary object so its authored atom ownership is
                // still checked for the newly advertised device.
                let changed_exact_heads = candidates
                    .iter()
                    .filter(|candidate| candidate.current.as_ref() != candidate.previous.as_ref())
                    .filter_map(|candidate| candidate.current.as_ref())
                    .filter(|head| union.ownership_boundary.contains(head))
                    .cloned()
                    .collect::<Vec<_>>();
                let mut retained_boundary = Vec::new();
                for trusted in &union.boundary {
                    let mut hides_changed_exact_head = false;
                    for changed in &changed_exact_heads {
                        if is_ancestor_at(&self.git, &quarantine, changed, trusted)? {
                            hides_changed_exact_head = true;
                            break;
                        }
                    }
                    if !hides_changed_exact_head {
                        retained_boundary.push(trusted.clone());
                    }
                }
                union.boundary = retained_boundary;
                let union_heads = candidates
                    .iter()
                    .filter_map(|candidate| candidate.current.clone())
                    .collect::<BTreeSet<_>>()
                    .into_iter()
                    .collect::<Vec<_>>();
                let failure = match validate_reachable_heads(
                    &self.git,
                    &quarantine,
                    plane,
                    &union_heads,
                    atom_limits,
                    pack_limits,
                    policy,
                    &mut union,
                    expected_project_id,
                    &snapshot.control,
                    &candidates,
                    &mut memo,
                ) {
                    Ok(()) => break,
                    Err(failure) => failure,
                };
                let Some(failing_commit) = failure.commit else {
                    return Err(failure.error);
                };
                let rollback_commits = if failure.rollback_commits.is_empty() {
                    vec![failing_commit]
                } else {
                    failure.rollback_commits
                };
                let mut rolled_back = false;
                for candidate in &mut candidates {
                    let Some(current) = candidate.current.as_ref() else {
                        continue;
                    };
                    let mut rollback_commit = None;
                    for commit in &rollback_commits {
                        if newly_reaches(&self.git, &quarantine, current, commit, &trusted_heads)? {
                            rollback_commit = Some(commit);
                            break;
                        }
                    }
                    if let Some(rollback_commit) = rollback_commit {
                        candidate.current = rollback_prefix(
                            &self.git,
                            &quarantine,
                            candidate.previous.as_ref(),
                            current,
                            rollback_commit,
                            &trusted_heads,
                        )?;
                        if !rejected
                            .iter()
                            .any(|(device, _)| device == &candidate.device)
                        {
                            rejected.push((candidate.device, failure.error.code));
                        }
                        rolled_back = true;
                    }
                }
                if !rolled_back {
                    return Err(failure.error);
                }
            }
            for candidate in candidates {
                if candidate.current.as_ref() != candidate.previous.as_ref() {
                    accepted.push(CandidateRef {
                        device_id: candidate.device,
                        previous: candidate.previous,
                        accepted_head: candidate
                            .current
                            .expect("a changed accepted prefix has a head"),
                        source_advertised_head: candidate.advertised,
                    });
                }
            }
            rejected.sort_by_key(|(device, _)| *device);
            ensure_snapshot(self, &snapshot)?;
            self.git
                .run(
                    &["index-pack".into(), "--stdin".into(), "--fix-thin".into()],
                    Some(&pack_bytes.0),
                )
                .map_err(|_| pack("pack promotion failed"))?;
            ensure_snapshot(self, &snapshot)?;
            promote_refs(self, &snapshot, plane, &accepted)?;
            Ok(ImportOutcome {
                accepted: accepted.len(),
                rejected,
                pack_bytes: pack_bytes_len,
                accepted_refs: accepted,
            })
        })();
        let session = quarantine
            .parent()
            .expect("quarantine has a session parent");
        finish_cleanup(result, fs::remove_dir_all(session))
    }

    fn quarantine(&self) -> Result<PathBuf, SyncError> {
        let incoming = self.repo.join("incoming");
        fs::create_dir_all(&incoming).map_err(io)?;
        let root = allocate_session(&incoming, || {
            format!(
                "{}-{}",
                std::process::id(),
                QUARANTINE_COUNTER.fetch_add(1, Ordering::Relaxed)
            )
        })?;
        let repo = root.join("quarantine.git");
        let result = (|| {
            crate::git_command::GitCommand::init(&self.git_executable(), &repo)?;
            let objects = fs::canonicalize(self.repo.join("objects")).map_err(io)?;
            fs::write(
                repo.join("objects/info/alternates"),
                alternates_line(&objects)?,
            )
            .map_err(io)?;
            Ok(repo)
        })();
        if result.is_ok() {
            result
        } else {
            finish_cleanup(result, fs::remove_dir_all(&root))
        }
    }
    fn git_executable(&self) -> PathBuf {
        self.git.executable()
    }
}

impl RepositoryWriter<'_> {
    pub(crate) fn import_pack<P: ProjectPolicy>(
        &self,
        expected_project_id: ProjectId,
        plane: Plane,
        advertised: &RefAdvertisement,
        pack: PackBytes,
        atom_limits: &AtomLimits,
        pack_limits: &PackLimits,
        policy: &P,
    ) -> Result<ImportOutcome, SyncError> {
        self.store.import_locked(
            expected_project_id,
            plane,
            advertised,
            pack,
            atom_limits,
            pack_limits,
            policy,
        )
    }
}

fn snapshot_for_plane(snapshot: &TrustedSnapshot, plane: Plane) -> &RefAdvertisement {
    match plane {
        Plane::Control => &snapshot.control,
        Plane::Data => &snapshot.data,
    }
}

fn ensure_snapshot(store: &GitStore, expected: &TrustedSnapshot) -> Result<(), SyncError> {
    let current = store.trusted_snapshot()?;
    if current.control.refs != expected.control.refs || current.data.refs != expected.data.refs {
        return Err(ref_rewind("trusted refs changed during pack import"));
    }
    Ok(())
}

fn promote_refs(
    store: &GitStore,
    snapshot: &TrustedSnapshot,
    plane: Plane,
    accepted: &[CandidateRef],
) -> Result<(), SyncError> {
    if accepted.is_empty() {
        return Ok(());
    }
    let changed = accepted
        .iter()
        .map(|candidate| candidate.device_id)
        .collect::<BTreeSet<_>>();
    let mut input = String::from("start\n");
    for advertisement in [&snapshot.control, &snapshot.data] {
        for (device, head) in &advertisement.refs {
            if advertisement.plane == plane && changed.contains(device) {
                continue;
            }
            input.push_str(&format!(
                "verify {}{} {}\n",
                advertisement.plane.ref_prefix(),
                device,
                head.as_str()
            ));
        }
    }
    for candidate in accepted {
        let expected = candidate
            .previous
            .as_ref()
            .map_or_else(|| "0".repeat(64), |oid| oid.as_str().to_owned());
        input.push_str(&format!(
            "update {}{} {} {}\n",
            plane.ref_prefix(),
            candidate.device_id,
            candidate.accepted_head.as_str(),
            expected
        ));
    }
    input.push_str("prepare\ncommit\n");
    store
        .git
        .run(
            &["update-ref".into(), "--stdin".into()],
            Some(input.as_bytes()),
        )
        .map_err(|error| {
            ref_rewind(format!(
                "ref promotion transaction failed: {}",
                error.message
            ))
        })?;
    Ok(())
}

#[derive(Clone)]
struct ValidationContext {
    boundary: Vec<GitOid>,
    ownership_boundary: Vec<GitOid>,
    immutable: BTreeMap<String, GitOid>,
}

struct Candidate {
    device: DeviceId,
    previous: Option<GitOid>,
    current: Option<GitOid>,
    advertised: GitOid,
}

struct ValidationFailure {
    commit: Option<GitOid>,
    rollback_commits: Vec<GitOid>,
    error: SyncError,
}

struct ImportMemo<S> {
    control_states: BTreeMap<Vec<GitOid>, S>,
    traversals: BTreeMap<(Vec<GitOid>, Vec<GitOid>), Vec<(GitOid, Vec<GitOid>)>>,
    trees: BTreeMap<(u8, GitOid), Vec<(String, GitOid)>>,
}

impl<S> ImportMemo<S> {
    fn new() -> Self {
        Self {
            control_states: BTreeMap::new(),
            traversals: BTreeMap::new(),
            trees: BTreeMap::new(),
        }
    }

    fn reachable(
        &mut self,
        git: &crate::git_command::GitCommand,
        repo: &PathBuf,
        candidates: &[GitOid],
        boundary: &[GitOid],
    ) -> Result<Vec<(GitOid, Vec<GitOid>)>, SyncError> {
        let key = (sorted_oids(candidates), sorted_oids(boundary));
        if !self.traversals.contains_key(&key) {
            self.traversals
                .insert(key.clone(), reachable_commits(git, repo, &key.0, &key.1)?);
        }
        Ok(self
            .traversals
            .get(&key)
            .expect("exact traversal key was cached")
            .clone())
    }

    fn tree(
        &mut self,
        git: &crate::git_command::GitCommand,
        repo: &PathBuf,
        head: &GitOid,
        plane: Plane,
    ) -> Result<Vec<(String, GitOid)>, SyncError> {
        let plane_key = match plane {
            Plane::Control => 0,
            Plane::Data => 1,
        };
        let key = (plane_key, head.clone());
        if !self.trees.contains_key(&key) {
            self.trees
                .insert(key.clone(), tree(git, repo, head, plane)?);
        }
        Ok(self
            .trees
            .get(&key)
            .expect("exact tree key was cached")
            .clone())
    }
}

fn sorted_oids(oids: &[GitOid]) -> Vec<GitOid> {
    oids.iter()
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

impl ValidationContext {
    fn new<S>(
        git: &crate::git_command::GitCommand,
        repo: &PathBuf,
        plane: Plane,
        boundary: Vec<GitOid>,
        ownership_boundary: Vec<GitOid>,
        memo: &mut ImportMemo<S>,
    ) -> Result<Self, SyncError> {
        let mut immutable = BTreeMap::new();
        for head in &boundary {
            for (path, blob) in memo.tree(git, repo, head, plane)? {
                crate::git_store::validate_tree_path(&path, plane)?;
                merge_immutable(&mut immutable, path, blob)?;
            }
        }
        Ok(Self {
            boundary,
            ownership_boundary,
            immutable,
        })
    }
}

fn rollback_prefix(
    git: &crate::git_command::GitCommand,
    repo: &PathBuf,
    old: Option<&GitOid>,
    head: &GitOid,
    failing: &GitOid,
    boundary: &[GitOid],
) -> Result<Option<GitOid>, SyncError> {
    let mut args = vec![
        OsString::from("rev-list"),
        OsString::from("--reverse"),
        OsString::from("--first-parent"),
    ];
    args.push(old.map_or_else(
        || head.as_str().into(),
        |old| format!("{}..{}", old.as_str(), head.as_str()).into(),
    ));
    let commits = text(git.run_at(repo, &args, None)?)
        .lines()
        .map(GitOid::parse)
        .collect::<Result<Vec<_>, _>>()?;
    for commit in commits.into_iter().rev().skip(1) {
        if !newly_reaches(git, repo, &commit, failing, boundary)? {
            return Ok(Some(commit));
        }
    }
    Ok(old.cloned())
}

fn newly_reaches(
    git: &crate::git_command::GitCommand,
    repo: &PathBuf,
    candidate: &GitOid,
    commit: &GitOid,
    boundary: &[GitOid],
) -> Result<bool, SyncError> {
    if candidate == commit {
        return Ok(true);
    }
    Ok(
        reachable_commits(git, repo, std::slice::from_ref(candidate), boundary)?
            .iter()
            .any(|(reachable, _)| reachable == commit),
    )
}

fn validate_reachable_heads<P: ProjectPolicy>(
    git: &crate::git_command::GitCommand,
    repo: &PathBuf,
    plane: Plane,
    candidates: &[GitOid],
    atom_limits: &AtomLimits,
    limits: &PackLimits,
    policy: &P,
    validation: &mut ValidationContext,
    expected_project_id: ProjectId,
    trusted_control: &RefAdvertisement,
    candidate_refs: &[Candidate],
    memo: &mut ImportMemo<P::State>,
) -> Result<(), ValidationFailure> {
    if candidates.is_empty() {
        return Ok(());
    }
    let commits = memo
        .reachable(git, repo, candidates, &validation.boundary)
        .map_err(|error| ValidationFailure {
            commit: None,
            rollback_commits: vec![],
            error,
        })?;
    let owners = candidate_commit_owners(git, repo, candidate_refs, &validation.ownership_boundary)
        .map_err(|error| ValidationFailure {
            commit: None,
            rollback_commits: vec![],
            error,
        })?;
    for (commit, parents) in commits {
        let result = (|| {
            let entries = memo.tree(git, repo, &commit, plane)?;
            let current = entries.iter().cloned().collect::<BTreeMap<_, _>>();
            let parent_trees = parents
                .iter()
                .map(|parent| {
                    memo.tree(git, repo, parent, plane)
                        .map(|entries| entries.into_iter().collect())
                })
                .collect::<Result<Vec<BTreeMap<String, GitOid>>, SyncError>>()?;
            for parent in &parent_trees {
                for (path, blob) in parent {
                    if current.get(path) != Some(blob) {
                        return Err(invalid("immutable path was removed or replaced"));
                    }
                }
            }
            let expected_parents = reduced_frontier(git, repo, parents.iter().cloned())?;
            let mut atom_count = 0;
            let mut introduced_entries = Vec::new();
            for (path, blob) in &entries {
                crate::git_store::validate_tree_path(path, plane)?;
                match validation.immutable.get(path) {
                    Some(existing) if existing != blob => {
                        return Err(invalid("immutable path has conflicting bytes"));
                    }
                    _ => {}
                }
                if !path.starts_with(crate::git_store::atom_prefix(plane)) {
                    continue;
                }
                atom_count += 1;
                if atom_count > limits.max_atoms_per_head {
                    return Err(limit("commit tree exceeds atom limit"));
                }
                // Authorship is relative to the union of every commit parent.
                // A merge parent can carry another device's atom without making
                // the merge author responsible for introducing it.
                if parent_trees
                    .iter()
                    .any(|parent| parent.get(path) == Some(blob))
                {
                    continue;
                }
                introduced_entries.push((path.clone(), blob.clone()));
            }
            let introduced_blobs =
                read_blobs(git, repo, introduced_entries.iter().map(|(_, blob)| blob))?;
            let mut introduced = Vec::new();
            for (path, blob) in introduced_entries {
                let bytes = introduced_blobs
                    .get(&blob)
                    .expect("requested introduced blob was returned");
                let atom = crate::SignedAtom::decode(bytes, atom_limits)?;
                if atom.unsigned.plane != plane || atom.repo_path() != path {
                    return Err(invalid("atom path does not match atom"));
                }
                if atom.unsigned.project_id != expected_project_id {
                    return Err(invalid("atom belongs to a different project"));
                }
                if !owners.get(&commit).is_some_and(|devices| {
                    devices
                        .iter()
                        .all(|device| device == &atom.unsigned.actor_device_id)
                }) {
                    return Err(invalid("candidate device does not own authored atom"));
                }
                match plane {
                    Plane::Control
                        if atom.unsigned.control_frontier != expected_parents
                            || !atom.unsigned.data_frontier.is_empty() =>
                    {
                        return Err(invalid(
                            "control frontier does not match reduced commit parents",
                        ));
                    }
                    Plane::Data if atom.unsigned.data_frontier != expected_parents => {
                        return Err(invalid(
                            "data frontier does not match reduced commit parents",
                        ));
                    }
                    _ => {}
                }
                let stored = StoredAtom {
                    path,
                    containing_commit: commit.clone(),
                    atom,
                };
                introduced.push(stored);
            }
            if !introduced.is_empty() {
                match plane {
                    Plane::Control => {
                        let causal_atoms = stored_atoms_at_heads(
                            git,
                            repo,
                            Plane::Control,
                            &expected_parents,
                            atom_limits,
                            memo,
                        )?;
                        ensure_project(&causal_atoms, expected_project_id)?;
                        if !memo.control_states.contains_key(&expected_parents) {
                            memo.control_states.insert(
                                expected_parents.clone(),
                                policy.rebuild_control(&causal_atoms)?,
                            );
                        }
                        let causal_state = memo
                            .control_states
                            .get(&expected_parents)
                            .expect("causal control state was cached");
                        for atom in &introduced {
                            policy.validate_control(causal_state, atom)?;
                        }
                        // Control authorization is evaluated at the commit's
                        // declared parent cut, never at a global replay state.
                        policy.advance_control(causal_state, &introduced)?;
                    }
                    Plane::Data => {
                        for atom in &introduced {
                            let frontier = &atom.atom.unsigned.control_frontier;
                            if !memo.control_states.contains_key(frontier) {
                                validate_control_cut(git, repo, frontier, trusted_control)?;
                                let causal_atoms = stored_atoms_at_heads(
                                    git,
                                    repo,
                                    Plane::Control,
                                    frontier,
                                    atom_limits,
                                    memo,
                                )?;
                                ensure_project(&causal_atoms, expected_project_id)?;
                                memo.control_states.insert(
                                    frontier.clone(),
                                    policy.rebuild_control(&causal_atoms)?,
                                );
                            }
                            policy.validate_data(
                                memo.control_states
                                    .get(frontier)
                                    .expect("control state was cached"),
                                atom,
                            )?;
                        }
                    }
                }
            }
            for (path, blob) in entries {
                merge_immutable(&mut validation.immutable, path, blob)?;
            }
            Ok(())
        })();
        result.map_err(|error| ValidationFailure {
            commit: Some(commit.clone()),
            rollback_commits: vec![commit.clone()],
            error,
        })?;
    }
    if plane == Plane::Control {
        validate_global_control_replay(
            git,
            repo,
            candidates,
            &validation.boundary,
            atom_limits,
            expected_project_id,
            policy,
            memo,
        )?;
    }
    Ok(())
}

fn candidate_commit_owners(
    git: &crate::git_command::GitCommand,
    repo: &PathBuf,
    candidates: &[Candidate],
    trusted_boundary: &[GitOid],
) -> Result<BTreeMap<GitOid, BTreeSet<DeviceId>>, SyncError> {
    let mut owners: BTreeMap<GitOid, BTreeSet<DeviceId>> = BTreeMap::new();
    for candidate in candidates {
        let Some(head) = candidate.current.as_ref() else {
            continue;
        };
        let exact_boundaries = trusted_boundary
            .iter()
            .cloned()
            .chain(
                candidates
                    .iter()
                    .filter(|other| other.device != candidate.device)
                    .map(|other| other.advertised.clone()),
            )
            .collect::<BTreeSet<_>>();
        for (index, commit) in first_parent_segment(git, repo, candidate.previous.as_ref(), head)?
            .into_iter()
            .enumerate()
        {
            // The advertised head is always the candidate's own assertion. For
            // older first-parent history, stop once another trusted/advertised
            // device head already provides the authorship boundary.
            if index > 0 && exact_boundaries.contains(&commit) {
                break;
            }
            owners.entry(commit).or_default().insert(candidate.device);
        }
    }
    Ok(owners)
}

fn validate_global_control_replay<P: ProjectPolicy>(
    git: &crate::git_command::GitCommand,
    repo: &PathBuf,
    candidate_heads: &[GitOid],
    trusted_heads: &[GitOid],
    limits: &AtomLimits,
    expected_project_id: ProjectId,
    policy: &P,
    memo: &mut ImportMemo<P::State>,
) -> Result<(), ValidationFailure> {
    let heads = trusted_heads
        .iter()
        .chain(candidate_heads)
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let atoms = stored_atoms_at_heads(git, repo, Plane::Control, &heads, limits, memo).map_err(
        |error| ValidationFailure {
            commit: None,
            rollback_commits: vec![],
            error,
        },
    )?;
    ensure_project(&atoms, expected_project_id).map_err(|error| ValidationFailure {
        commit: None,
        rollback_commits: vec![],
        error,
    })?;
    let trusted_commits = memo
        .reachable(git, repo, trusted_heads, &[])
        .map_err(|error| ValidationFailure {
            commit: None,
            rollback_commits: vec![],
            error,
        })?
        .into_iter()
        .map(|(commit, _)| commit)
        .collect::<BTreeSet<_>>();
    let mut state = policy
        .rebuild_control(&[])
        .map_err(|error| ValidationFailure {
            commit: None,
            rollback_commits: vec![],
            error,
        })?;
    let mut replayed_incoming = Vec::new();
    for batch in atoms.chunk_by(|left, right| left.containing_commit == right.containing_commit) {
        let commit = batch[0].containing_commit.clone();
        let incoming = !trusted_commits.contains(&commit);
        match policy.advance_control(&state, batch) {
            Ok(next) => {
                state = next;
                if incoming {
                    replayed_incoming.push(commit);
                }
            }
            Err(error) => {
                let rollback_commits = if incoming {
                    vec![commit.clone()]
                } else {
                    replayed_incoming
                };
                return Err(ValidationFailure {
                    commit: Some(commit),
                    rollback_commits,
                    error,
                });
            }
        }
    }
    Ok(())
}

fn first_parent_segment(
    git: &crate::git_command::GitCommand,
    repo: &PathBuf,
    previous: Option<&GitOid>,
    head: &GitOid,
) -> Result<Vec<GitOid>, SyncError> {
    let range = previous.map_or_else(
        || head.as_str().to_owned(),
        |previous| format!("{}..{}", previous.as_str(), head.as_str()),
    );
    text(git.run_at(
        repo,
        &["rev-list".into(), "--first-parent".into(), range.into()],
        None,
    )?)
    .lines()
    .map(GitOid::parse)
    .collect()
}

fn reduced_frontier(
    git: &crate::git_command::GitCommand,
    repo: &PathBuf,
    heads: impl IntoIterator<Item = GitOid>,
) -> Result<Vec<GitOid>, SyncError> {
    let heads = heads.into_iter().collect::<BTreeSet<_>>();
    if heads.is_empty() {
        return Ok(Vec::new());
    }
    let mut args = vec!["merge-base".into(), "--independent".into()];
    args.extend(heads.into_iter().map(|head| head.as_str().into()));
    let mut reduced = text(git.run_at(repo, &args, None)?)
        .lines()
        .map(GitOid::parse)
        .collect::<Result<Vec<_>, _>>()?;
    reduced.sort();
    Ok(reduced)
}

fn is_ancestor_at(
    git: &crate::git_command::GitCommand,
    repo: &PathBuf,
    older: &GitOid,
    newer: &GitOid,
) -> Result<bool, SyncError> {
    if older == newer {
        return Ok(true);
    }
    let range = format!("{}..{}", older.as_str(), newer.as_str());
    Ok(!text(git.run_at(
        repo,
        &[
            "rev-list".into(),
            "--ancestry-path".into(),
            "--max-count=1".into(),
            range.into(),
        ],
        None,
    )?)
    .is_empty())
}

fn validate_control_cut(
    git: &crate::git_command::GitCommand,
    repo: &PathBuf,
    frontier: &[GitOid],
    trusted: &RefAdvertisement,
) -> Result<(), SyncError> {
    let reduced = reduced_frontier(git, repo, frontier.iter().cloned())
        .map_err(|_| invalid("declared control frontier is not a commit cut"))?;
    if reduced != frontier {
        return Err(invalid("declared control frontier is not reduced"));
    }
    for head in frontier {
        let reachable = trusted
            .refs
            .values()
            .map(|trusted_head| is_ancestor_at(git, repo, head, trusted_head))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| invalid("declared control frontier is not trusted"))?
            .into_iter()
            .any(|reachable| reachable);
        if !reachable {
            return Err(invalid("declared control frontier is not trusted"));
        }
    }
    Ok(())
}

fn ensure_project(atoms: &[StoredAtom], expected: ProjectId) -> Result<(), SyncError> {
    if atoms
        .iter()
        .any(|atom| atom.atom.unsigned.project_id != expected)
    {
        return Err(invalid("control cut contains a foreign-project atom"));
    }
    Ok(())
}

fn stored_atoms_at_heads<S>(
    git: &crate::git_command::GitCommand,
    repo: &PathBuf,
    plane: Plane,
    heads: &[GitOid],
    limits: &AtomLimits,
    memo: &mut ImportMemo<S>,
) -> Result<Vec<StoredAtom>, SyncError> {
    if heads.is_empty() {
        return Ok(vec![]);
    }
    let commits = memo.reachable(git, repo, heads, &[])?;
    let trees = commits
        .iter()
        .map(|(commit, _)| {
            Ok((
                commit.clone(),
                memo.tree(git, repo, commit, plane)?
                    .into_iter()
                    .collect::<BTreeMap<_, _>>(),
            ))
        })
        .collect::<Result<BTreeMap<_, _>, SyncError>>()?;
    let mut immutable = BTreeMap::new();
    for entries in trees.values() {
        for (path, blob) in entries {
            crate::git_store::validate_tree_path(path, plane)?;
            merge_immutable(&mut immutable, path.clone(), blob.clone())?;
        }
    }
    let mut introduced_paths: BTreeMap<String, (GitOid, GitOid)> = BTreeMap::new();
    let mut order = Vec::new();
    for (commit, parents) in commits {
        for (path, blob) in &trees[&commit] {
            if !path.starts_with(crate::git_store::atom_prefix(plane)) {
                continue;
            }
            let introduced = !parents.iter().any(|parent| {
                trees.get(parent).and_then(|entries| entries.get(path)) == Some(blob)
            });
            match introduced_paths.get(path) {
                Some((existing, _)) if existing != blob => {
                    return Err(invalid("immutable path has conflicting bytes"));
                }
                None if introduced => {
                    introduced_paths.insert(path.clone(), (blob.clone(), commit.clone()));
                    order.push(path.clone());
                }
                _ => {}
            }
        }
    }
    let blobs = read_blobs(git, repo, introduced_paths.values().map(|(blob, _)| blob))?;
    order
        .into_iter()
        .map(|path| {
            let (blob, containing_commit) = introduced_paths
                .remove(&path)
                .expect("introduced atom path was recorded");
            let bytes = blobs
                .get(&blob)
                .expect("requested stored atom blob was returned");
            let atom = crate::SignedAtom::decode(bytes, limits)?;
            if atom.unsigned.plane != plane || atom.repo_path() != path {
                return Err(invalid("atom path does not match atom"));
            }
            Ok(StoredAtom {
                path,
                containing_commit,
                atom,
            })
        })
        .collect()
}

fn read_blobs<'a>(
    git: &crate::git_command::GitCommand,
    repo: &PathBuf,
    oids: impl IntoIterator<Item = &'a GitOid>,
) -> Result<BTreeMap<GitOid, Vec<u8>>, SyncError> {
    let requested = oids.into_iter().cloned().collect::<BTreeSet<_>>();
    if requested.is_empty() {
        return Ok(BTreeMap::new());
    }
    let mut input = Vec::new();
    for oid in &requested {
        input.extend_from_slice(oid.as_str().as_bytes());
        input.push(b'\n');
    }
    let output = git.run_at(repo, &["cat-file".into(), "--batch".into()], Some(&input))?;
    let mut cursor = 0;
    let mut blobs = BTreeMap::new();
    for expected in requested {
        let header_end = output[cursor..]
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|offset| cursor + offset)
            .ok_or_else(|| invalid("truncated cat-file batch header"))?;
        let header = std::str::from_utf8(&output[cursor..header_end])
            .map_err(|_| invalid("non-UTF-8 cat-file batch header"))?;
        let mut fields = header.split_whitespace();
        let returned = GitOid::parse(
            fields
                .next()
                .ok_or_else(|| invalid("missing cat-file batch OID"))?,
        )?;
        if returned != expected || fields.next() != Some("blob") {
            return Err(invalid("cat-file batch returned an unexpected object"));
        }
        let size = fields
            .next()
            .ok_or_else(|| invalid("missing cat-file batch size"))?
            .parse::<usize>()
            .map_err(|_| invalid("invalid cat-file batch size"))?;
        if fields.next().is_some() {
            return Err(invalid("invalid cat-file batch header"));
        }
        let blob_start = header_end + 1;
        let blob_end = blob_start
            .checked_add(size)
            .filter(|end| *end < output.len())
            .ok_or_else(|| invalid("truncated cat-file batch blob"))?;
        if output[blob_end] != b'\n' {
            return Err(invalid("invalid cat-file batch delimiter"));
        }
        blobs.insert(returned, output[blob_start..blob_end].to_vec());
        cursor = blob_end + 1;
    }
    if cursor != output.len() {
        return Err(invalid("cat-file batch returned trailing bytes"));
    }
    Ok(blobs)
}

fn reachable_commits(
    git: &crate::git_command::GitCommand,
    repo: &PathBuf,
    candidates: &[GitOid],
    boundary: &[GitOid],
) -> Result<Vec<(GitOid, Vec<GitOid>)>, SyncError> {
    if candidates.is_empty() {
        return Ok(vec![]);
    }
    let mut args = vec![OsString::from("rev-list"), OsString::from("--parents")];
    args.extend(candidates.iter().map(|candidate| candidate.as_str().into()));
    if !boundary.is_empty() {
        args.push("--not".into());
        args.extend(boundary.iter().map(|head| head.as_str().into()));
    }
    let mut graph = BTreeMap::new();
    for line in text(git.run_at(repo, &args, None)?).lines() {
        let mut fields = line.split_whitespace();
        let commit = GitOid::parse(fields.next().ok_or_else(|| invalid("missing commit OID"))?)?;
        let parents = fields.map(GitOid::parse).collect::<Result<Vec<_>, _>>()?;
        graph.insert(commit, parents);
    }
    let mut remaining = BTreeMap::new();
    let mut children: BTreeMap<GitOid, Vec<GitOid>> = BTreeMap::new();
    for (commit, parents) in &graph {
        let in_graph = parents
            .iter()
            .filter(|parent| graph.contains_key(*parent))
            .cloned()
            .collect::<Vec<_>>();
        remaining.insert(commit.clone(), in_graph.len());
        for parent in in_graph {
            children.entry(parent).or_default().push(commit.clone());
        }
    }
    let mut ready = remaining
        .iter()
        .filter_map(|(commit, count)| (*count == 0).then_some(commit.clone()))
        .collect::<BTreeSet<_>>();
    let mut ordered = Vec::with_capacity(graph.len());
    while let Some(commit) = ready.pop_first() {
        ordered.push((commit.clone(), graph[&commit].clone()));
        for child in children.get(&commit).into_iter().flatten() {
            let count = remaining.get_mut(child).expect("known child");
            *count -= 1;
            if *count == 0 {
                ready.insert(child.clone());
            }
        }
    }
    if ordered.len() != graph.len() {
        return Err(invalid("commit graph is not acyclic"));
    }
    Ok(ordered)
}

fn merge_immutable(
    paths: &mut BTreeMap<String, GitOid>,
    path: String,
    blob: GitOid,
) -> Result<(), SyncError> {
    if paths.get(&path).is_some_and(|existing| existing != &blob) {
        return Err(invalid("immutable path has conflicting bytes"));
    }
    paths.insert(path, blob);
    Ok(())
}

fn first_parent_ancestor(
    git: &crate::git_command::GitCommand,
    repo: &PathBuf,
    old: &GitOid,
    new: &GitOid,
) -> Result<bool, SyncError> {
    let commits = text(git.run_at(
        repo,
        &[
            "rev-list".into(),
            "--first-parent".into(),
            new.as_str().into(),
        ],
        None,
    )?);
    Ok(commits.lines().any(|commit| commit == old.as_str()))
}
fn tree(
    git: &crate::git_command::GitCommand,
    repo: &PathBuf,
    head: &GitOid,
    plane: Plane,
) -> Result<Vec<(String, GitOid)>, SyncError> {
    let output = git.run_at(
        repo,
        &[
            "ls-tree".into(),
            "-r".into(),
            "-t".into(),
            "-z".into(),
            head.as_str().into(),
        ],
        None,
    )?;
    let mut files: Vec<(String, GitOid)> = Vec::new();
    let mut directories = Vec::new();
    for entry in output.split(|b| *b == 0).filter(|e| !e.is_empty()) {
        let entry = std::str::from_utf8(entry).map_err(|_| invalid("non-UTF-8 Git path"))?;
        let (left, path) = entry
            .split_once('\t')
            .ok_or_else(|| invalid("invalid tree entry"))?;
        let mut f = left.split_whitespace();
        match (f.next(), f.next()) {
            (Some("100644"), Some("blob")) => files.push((
                path.into(),
                GitOid::parse(f.next().ok_or_else(|| invalid("missing tree OID"))?)?,
            )),
            (Some("040000"), Some("tree")) => {
                crate::git_store::validate_tree_directory(path, plane)?;
                directories.push(path.to_owned());
            }
            _ => return Err(invalid("tree has unsupported entry")),
        }
    }
    if directories.iter().any(|directory| {
        let prefix = format!("{directory}/");
        !files.iter().any(|(path, _)| path.starts_with(&prefix))
    }) {
        return Err(invalid("tree contains an empty directory"));
    }
    Ok(files)
}
#[cfg(unix)]
fn alternates_line(path: &Path) -> Result<Vec<u8>, SyncError> {
    use std::os::unix::ffi::OsStrExt;
    let bytes = path.as_os_str().as_bytes();
    if bytes.contains(&b'\n') || bytes.contains(&0) {
        return Err(io_message(
            "object path is incompatible with Git alternates",
        ));
    }
    let mut line = bytes.to_vec();
    line.push(b'\n');
    Ok(line)
}

#[cfg(not(unix))]
fn alternates_line(path: &Path) -> Result<Vec<u8>, SyncError> {
    let text = path
        .to_str()
        .ok_or_else(|| io_message("object path cannot be encoded for Git alternates"))?;
    if text.as_bytes().contains(&b'\n') || text.as_bytes().contains(&0) {
        return Err(io_message(
            "object path is incompatible with Git alternates",
        ));
    }
    Ok(format!("{text}\n").into_bytes())
}

fn finish_cleanup<T>(
    result: Result<T, SyncError>,
    cleanup: std::io::Result<()>,
) -> Result<T, SyncError> {
    match cleanup {
        Ok(()) => result,
        Err(error) => Err(io_message(format!("quarantine cleanup failed: {error}"))),
    }
}

fn allocate_session(
    incoming: &Path,
    mut next_name: impl FnMut() -> String,
) -> Result<PathBuf, SyncError> {
    loop {
        let candidate = incoming.join(next_name());
        match fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(io(error)),
        }
    }
}
fn text(bytes: Vec<u8>) -> String {
    String::from_utf8_lossy(&bytes).trim().into()
}
fn invalid(message: impl Into<String>) -> SyncError {
    SyncError {
        code: SyncErrorCode::InvalidAtom,
        message: message.into(),
    }
}
fn pack(message: impl Into<String>) -> SyncError {
    SyncError {
        code: SyncErrorCode::PackRejected,
        message: message.into(),
    }
}
fn ref_rewind(message: impl Into<String>) -> SyncError {
    SyncError {
        code: SyncErrorCode::RefRewind,
        message: message.into(),
    }
}
fn limit(message: impl Into<String>) -> SyncError {
    SyncError {
        code: SyncErrorCode::LimitExceeded,
        message: message.into(),
    }
}
fn io(error: std::io::Error) -> SyncError {
    SyncError {
        code: SyncErrorCode::Io,
        message: error.to_string(),
    }
}
fn io_message(message: impl Into<String>) -> SyncError {
    SyncError {
        code: SyncErrorCode::Io,
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_commit(git: &crate::git_command::GitCommand, parent: Option<&GitOid>) -> GitOid {
        let tree = text(git.run(&["mktree".into()], Some(b"")).unwrap());
        let mut args = vec!["commit-tree".into(), tree.into()];
        if let Some(parent) = parent {
            args.extend(["-p".into(), parent.as_str().into()]);
        }
        GitOid::parse(&text(git.run(&args, Some(b"test\n")).unwrap())).unwrap()
    }

    #[test]
    fn rolled_back_candidate_keeps_its_advertised_head_as_an_ownership_boundary() {
        let repo = tempfile::tempdir().unwrap();
        let executable = std::env::var_os("YONALIST_TEST_GIT")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("git"));
        crate::git_command::GitCommand::init(&executable, repo.path()).unwrap();
        let git = crate::git_command::GitCommand::new(&executable, repo.path());
        let prefix = empty_commit(&git, None);
        let advertised = empty_commit(&git, Some(&prefix));
        let first_head = empty_commit(&git, Some(&advertised));
        let first_device = DeviceId::from_bytes([1; 16]);
        let rolled_back_device = DeviceId::from_bytes([2; 16]);
        let candidates = vec![
            Candidate {
                device: first_device,
                previous: None,
                current: Some(first_head.clone()),
                advertised: first_head.clone(),
            },
            Candidate {
                device: rolled_back_device,
                previous: None,
                current: Some(prefix.clone()),
                advertised: advertised.clone(),
            },
        ];

        let owners =
            candidate_commit_owners(&git, &repo.path().to_path_buf(), &candidates, &[]).unwrap();

        assert_eq!(
            owners.get(&first_head),
            Some(&BTreeSet::from([first_device]))
        );
        assert!(
            !owners
                .get(&advertised)
                .is_some_and(|devices| devices.contains(&first_device)),
            "the first candidate crossed the other candidate's immutable advertised boundary"
        );
    }

    #[test]
    fn cleanup_failure_is_not_silently_ignored() {
        let error =
            finish_cleanup::<()>(Ok(()), Err(std::io::Error::other("injected"))).unwrap_err();
        assert_eq!(error.code, SyncErrorCode::Io);
        assert!(error
            .message
            .contains("quarantine cleanup failed: injected"));
    }

    #[test]
    fn session_allocation_retries_stale_name_collisions() {
        let incoming = tempfile::tempdir().unwrap();
        fs::create_dir(incoming.path().join("stale")).unwrap();
        let mut names = ["stale".to_owned(), "fresh".to_owned()].into_iter();
        let session = allocate_session(incoming.path(), || names.next().unwrap()).unwrap();
        assert_eq!(session.file_name().unwrap(), "fresh");
    }

    #[cfg(unix)]
    #[test]
    fn alternates_preserve_non_utf8_bytes_and_reject_newlines() {
        use std::ffi::OsString;
        use std::os::unix::ffi::OsStringExt;
        assert_eq!(
            alternates_line(Path::new(&OsString::from_vec(b"/tmp/o-\xff".to_vec()))).unwrap(),
            b"/tmp/o-\xff\n"
        );
        assert_eq!(
            alternates_line(Path::new(&OsString::from_vec(b"/tmp/o\nops".to_vec())))
                .unwrap_err()
                .code,
            SyncErrorCode::Io
        );
    }
}

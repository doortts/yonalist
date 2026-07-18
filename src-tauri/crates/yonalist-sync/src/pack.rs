use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use crate::{
    AtomLimits, DeviceId, GitOid, GitStore, Plane, ProjectPolicy, RefAdvertisement, StoredAtom,
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
/// A sealed authorization to promote exactly the pack and candidates accepted
/// by [`GitStore::validate_pack`]. Callers can inspect outcomes but cannot forge,
/// clone, or mutate this value.
///
/// ```compile_fail
/// use yonalist_sync::ValidatedPack;
/// fn forge() -> ValidatedPack { ValidatedPack {} }
/// ```
///
/// ```compile_fail
/// use yonalist_sync::ValidatedPack;
/// fn duplicate(value: ValidatedPack) -> ValidatedPack { value.clone() }
/// ```
#[derive(Debug)]
pub struct ValidatedPack {
    pack: PackBytes,
    accepted: Vec<CandidateRef>,
    rejected: Vec<(DeviceId, SyncErrorCode)>,
    plane: Plane,
    validation_id: u64,
}

impl ValidatedPack {
    pub fn accepted(&self) -> &[CandidateRef] {
        &self.accepted
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

    pub fn validate_pack<P: ProjectPolicy>(
        &self,
        plane: Plane,
        advertised: &RefAdvertisement,
        pack_bytes: PackBytes,
        atom_limits: &AtomLimits,
        pack_limits: &PackLimits,
        policy: &P,
        control: &P::State,
    ) -> Result<ValidatedPack, SyncError> {
        if advertised.plane != plane
            || advertised.refs.len() > pack_limits.max_advertised_refs
            || pack_bytes.0.is_empty()
        {
            return Err(pack("invalid advertised pack"));
        }
        if pack_bytes.0.len() > pack_limits.max_pack_bytes {
            return Err(limit("pack exceeds byte limit"));
        }
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
            // Control replay still includes that complete trusted closure so its
            // result matches the post-promotion rebuild's global canonical order.
            let trusted_heads = self
                .advertise(plane)?
                .refs
                .into_values()
                .collect::<Vec<_>>();
            let (validation, trusted_commits) = if plane == Plane::Control {
                (
                    ValidationContext::new(
                        &self.git,
                        &quarantine,
                        plane,
                        vec![],
                        policy.rebuild_control(&[])?,
                    )?,
                    reachable_commits(&self.git, &quarantine, &trusted_heads, &[])?
                        .into_iter()
                        .map(|(commit, _)| commit)
                        .collect::<BTreeSet<_>>(),
                )
            } else {
                (
                    ValidationContext::new(
                        &self.git,
                        &quarantine,
                        plane,
                        trusted_heads.clone(),
                        control.clone(),
                    )?,
                    BTreeSet::new(),
                )
            };
            let mut eligible = Vec::new();
            for (device, head) in &advertised.refs {
                let previous = self.head(plane, *device)?;
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
                let union_heads = trusted_heads
                    .iter()
                    .filter(|_| plane == Plane::Control)
                    .cloned()
                    .chain(
                        candidates
                            .iter()
                            .filter_map(|candidate| candidate.current.clone()),
                    )
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
                ) {
                    Ok(()) => break,
                    Err(failure) => failure,
                };
                let Some(failing_commit) = failure.commit else {
                    return Err(failure.error);
                };
                let rollback_commits = if trusted_commits.contains(&failing_commit) {
                    failure
                        .replayed
                        .iter()
                        .filter(|commit| !trusted_commits.contains(*commit))
                        .cloned()
                        .collect::<Vec<_>>()
                } else {
                    vec![failing_commit]
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
            Ok(ValidatedPack {
                pack: pack_bytes,
                accepted,
                rejected,
                plane,
                validation_id: self.validation_id,
            })
        })();
        let session = quarantine
            .parent()
            .expect("quarantine has a session parent");
        finish_cleanup(result, fs::remove_dir_all(session))
    }

    pub fn promote_pack(&self, validated: ValidatedPack) -> Result<Vec<CandidateRef>, SyncError> {
        if validated.validation_id != self.validation_id {
            return Err(pack("validated pack belongs to a different store"));
        }
        if validated.pack.0.is_empty() {
            return Err(pack("empty validated pack"));
        }
        self.git
            .run(
                &["index-pack".into(), "--stdin".into(), "--fix-thin".into()],
                Some(&validated.pack.0),
            )
            .map_err(|_| pack("pack promotion failed"))?;
        if validated.accepted.is_empty() {
            return Ok(vec![]);
        }
        let mut input = String::new();
        for candidate in &validated.accepted {
            let name = format!("{}{}", validated.plane.ref_prefix(), candidate.device_id);
            let expected = candidate
                .previous
                .as_ref()
                .map_or_else(|| "0".repeat(64), |oid| oid.as_str().to_owned());
            input.push_str(&format!(
                "update {} {} {}\n",
                name,
                candidate.accepted_head.as_str(),
                expected
            ));
        }
        self.git
            .run(
                &["update-ref".into(), "--stdin".into()],
                Some(input.as_bytes()),
            )
            .map_err(|error| SyncError {
                code: SyncErrorCode::RefRewind,
                message: format!("ref promotion compare-and-swap failed: {}", error.message),
            })?;
        Ok(validated.accepted)
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

#[derive(Clone)]
struct ValidationContext<S: Clone> {
    control: S,
    boundary: Vec<GitOid>,
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
    replayed: Vec<GitOid>,
    error: SyncError,
}

impl<S: Clone> ValidationContext<S> {
    fn new(
        git: &crate::git_command::GitCommand,
        repo: &PathBuf,
        plane: Plane,
        boundary: Vec<GitOid>,
        control: S,
    ) -> Result<Self, SyncError> {
        let mut immutable = BTreeMap::new();
        for head in &boundary {
            for (path, blob) in tree(git, repo, head, plane)? {
                crate::git_store::validate_tree_path(&path, plane)?;
                merge_immutable(&mut immutable, path, blob)?;
            }
        }
        Ok(Self {
            control,
            boundary,
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
    validation: &mut ValidationContext<P::State>,
) -> Result<(), ValidationFailure> {
    if candidates.is_empty() {
        return Ok(());
    }
    let commits =
        reachable_commits(git, repo, candidates, &validation.boundary).map_err(|error| {
            ValidationFailure {
                commit: None,
                replayed: vec![],
                error,
            }
        })?;
    let mut replayed = Vec::new();
    for (commit, parents) in commits {
        let result = (|| {
            let entries = tree(git, repo, &commit, plane)?;
            let current = entries.iter().cloned().collect::<BTreeMap<_, _>>();
            let parent_trees = parents
                .iter()
                .map(|parent| {
                    tree(git, repo, parent, plane).map(|entries| entries.into_iter().collect())
                })
                .collect::<Result<Vec<BTreeMap<String, GitOid>>, SyncError>>()?;
            for parent in &parent_trees {
                for (path, blob) in parent {
                    if current.get(path) != Some(blob) {
                        return Err(invalid("immutable path was removed or replaced"));
                    }
                }
            }
            let mut atom_count = 0;
            let mut introduced = Vec::new();
            for (path, blob) in &entries {
                crate::git_store::validate_tree_path(path, plane)?;
                if let Some(existing) = validation.immutable.get(path) {
                    if existing != blob {
                        return Err(invalid("immutable path has conflicting bytes"));
                    }
                }
                if !path.starts_with(crate::git_store::atom_prefix(plane)) {
                    continue;
                }
                atom_count += 1;
                if atom_count > limits.max_atoms_per_head {
                    return Err(limit("commit tree exceeds atom limit"));
                }
                if parent_trees
                    .iter()
                    .any(|parent| parent.get(path) == Some(blob))
                {
                    continue;
                }
                let bytes = git.run_at(
                    repo,
                    &["cat-file".into(), "blob".into(), blob.as_str().into()],
                    None,
                )?;
                let atom = crate::SignedAtom::decode(&bytes, atom_limits)?;
                if atom.unsigned.plane != plane || atom.repo_path() != *path {
                    return Err(invalid("atom path does not match atom"));
                }
                let stored = StoredAtom {
                    path: path.clone(),
                    containing_commit: commit.clone(),
                    atom,
                };
                match plane {
                    Plane::Control => policy.validate_control(&validation.control, &stored)?,
                    Plane::Data => policy.validate_data(&validation.control, &stored)?,
                }
                introduced.push(stored);
            }
            if plane == Plane::Control {
                validation.control = policy.advance_control(&validation.control, &introduced)?;
            }
            for (path, blob) in entries {
                merge_immutable(&mut validation.immutable, path, blob)?;
            }
            Ok(())
        })();
        result.map_err(|error| ValidationFailure {
            commit: Some(commit.clone()),
            replayed: replayed.clone(),
            error,
        })?;
        replayed.push(commit);
    }
    Ok(())
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

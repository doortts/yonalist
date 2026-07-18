use std::{
    collections::BTreeMap,
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
            for (device, head) in &advertised.refs {
                let previous = self.head(plane, *device)?;
                if let Some(old) = &previous {
                    if !first_parent_ancestor(&self.git, &quarantine, old, head)? {
                        rejected.push((*device, SyncErrorCode::RefRewind));
                        continue;
                    }
                }
                match validate_head(
                    &self.git,
                    &quarantine,
                    plane,
                    previous.as_ref(),
                    head,
                    atom_limits,
                    pack_limits,
                    policy,
                    control,
                ) {
                    Ok((valid, rejection)) => {
                        if valid.as_ref() != previous.as_ref() {
                            let valid = valid.expect("a changed accepted prefix has a head");
                            accepted.push(CandidateRef {
                                device_id: *device,
                                previous,
                                accepted_head: valid,
                                source_advertised_head: head.clone(),
                            });
                        }
                        if let Some(code) = rejection {
                            rejected.push((*device, code));
                        }
                    }
                    Err(error) => rejected.push((*device, error.code)),
                }
            }
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

fn validate_head<P: ProjectPolicy>(
    git: &crate::git_command::GitCommand,
    repo: &PathBuf,
    plane: Plane,
    old: Option<&GitOid>,
    head: &GitOid,
    atom_limits: &AtomLimits,
    limits: &PackLimits,
    policy: &P,
    control: &P::State,
) -> Result<(Option<GitOid>, Option<SyncErrorCode>), SyncError> {
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
    let mut previous_tree = BTreeMap::new();
    if let Some(old) = old {
        for (path, blob) in tree(git, repo, old, plane)? {
            crate::git_store::validate_tree_path(&path, plane)?;
            previous_tree.insert(path, blob);
        }
    }
    let mut valid = old.cloned();
    for commit in commits {
        let entries = tree(git, repo, &commit, plane)?;
        let current_tree = entries.iter().cloned().collect::<BTreeMap<_, _>>();
        if previous_tree
            .iter()
            .any(|(path, blob)| current_tree.get(path) != Some(blob))
        {
            return Ok((valid, Some(SyncErrorCode::InvalidAtom)));
        }
        let mut atoms = 0;
        for (path, blob) in &entries {
            if let Err(error) = crate::git_store::validate_tree_path(path, plane) {
                return Ok((valid, Some(error.code)));
            }
            if path.starts_with(crate::git_store::atom_prefix(plane)) {
                atoms += 1;
                if atoms > limits.max_atoms_per_head {
                    return Ok((valid, Some(SyncErrorCode::LimitExceeded)));
                }
                let bytes = git.run_at(
                    repo,
                    &["cat-file".into(), "blob".into(), blob.as_str().into()],
                    None,
                )?;
                let atom = match crate::SignedAtom::decode(&bytes, atom_limits) {
                    Ok(atom) => atom,
                    Err(error) => return Ok((valid, Some(error.code))),
                };
                if atom.unsigned.plane != plane || atom.repo_path() != *path {
                    return Ok((valid, Some(SyncErrorCode::InvalidAtom)));
                }
                let stored = StoredAtom {
                    path: path.clone(),
                    containing_commit: commit.clone(),
                    atom,
                };
                let policy_result = match plane {
                    Plane::Control => policy.validate_control(control, &stored),
                    Plane::Data => policy.validate_data(control, &stored),
                };
                if let Err(error) = policy_result {
                    return Ok((valid, Some(error.code)));
                }
            }
        }
        previous_tree = current_tree;
        valid = Some(commit);
    }
    Ok((valid, None))
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

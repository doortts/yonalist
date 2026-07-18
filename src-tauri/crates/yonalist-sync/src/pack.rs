use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs,
    path::PathBuf,
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
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ValidatedPack {
    pub pack: PackBytes,
    pub accepted: Vec<CandidateRef>,
    pub rejected: Vec<(DeviceId, SyncErrorCode)>,
    plane: Plane,
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
                    if !ancestor(&self.git, &quarantine, old, head)? {
                        rejected.push((*device, SyncErrorCode::RefRewind));
                        continue;
                    }
                }
                match validate_head(
                    &self.git,
                    &quarantine,
                    plane,
                    *device,
                    previous.as_ref(),
                    head,
                    atom_limits,
                    pack_limits,
                    policy,
                    control,
                ) {
                    Ok((valid, rejection)) => {
                        if let Some(valid) = valid {
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
            })
        })();
        let _ = fs::remove_dir_all(
            quarantine
                .parent()
                .expect("quarantine has a session parent"),
        );
        result
    }

    pub fn promote_pack(&self, validated: ValidatedPack) -> Result<Vec<CandidateRef>, SyncError> {
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
        let session = format!(
            "{}-{}",
            std::process::id(),
            QUARANTINE_COUNTER.fetch_add(1, Ordering::Relaxed)
        );
        let root = self.repo.join("incoming").join(session);
        let repo = root.join("quarantine.git");
        fs::create_dir_all(&root).map_err(io)?;
        let result = (|| {
            crate::git_command::GitCommand::init(&self.git_executable(), &repo)?;
            let objects = fs::canonicalize(self.repo.join("objects")).map_err(io)?;
            fs::write(
                repo.join("objects/info/alternates"),
                format!("{}\n", objects.display()),
            )
            .map_err(io)?;
            Ok(repo)
        })();
        if result.is_err() {
            let _ = fs::remove_dir_all(&root);
        }
        result
    }
    fn git_executable(&self) -> PathBuf {
        self.git.executable()
    }
}

fn validate_head<P: ProjectPolicy>(
    git: &crate::git_command::GitCommand,
    repo: &PathBuf,
    plane: Plane,
    device: DeviceId,
    old: Option<&GitOid>,
    head: &GitOid,
    atom_limits: &AtomLimits,
    limits: &PackLimits,
    policy: &P,
    control: &P::State,
) -> Result<(Option<GitOid>, Option<SyncErrorCode>), SyncError> {
    let mut args = vec![OsString::from("rev-list"), OsString::from("--reverse")];
    args.push(old.map_or_else(
        || head.as_str().into(),
        |old| format!("{}..{}", old.as_str(), head.as_str()).into(),
    ));
    let commits = text(git.run_at(repo, &args, None)?)
        .lines()
        .map(GitOid::parse)
        .collect::<Result<Vec<_>, _>>()?;
    let mut immutable = BTreeMap::new();
    if let Some(old) = old {
        for (path, blob) in tree(git, repo, old)? {
            immutable.insert(path, blob);
        }
    }
    let mut valid = old.cloned();
    for commit in commits {
        let entries = tree(git, repo, &commit)?;
        let mut atoms = 0;
        for (path, blob) in &entries {
            if let Err(error) = validate_path(path, plane) {
                return Ok((valid, Some(error.code)));
            }
            if let Some(existing) = immutable.insert(path.clone(), blob.clone()) {
                if existing != *blob {
                    return Ok((valid, Some(SyncErrorCode::InvalidAtom)));
                }
            }
            if path.starts_with(prefix(plane)) {
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
                if atom.unsigned.plane != plane
                    || atom.repo_path() != *path
                    || atom.unsigned.actor_device_id != device
                {
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
        valid = Some(commit);
    }
    Ok((valid, None))
}

fn ancestor(
    git: &crate::git_command::GitCommand,
    repo: &PathBuf,
    old: &GitOid,
    new: &GitOid,
) -> Result<bool, SyncError> {
    Ok(git
        .run_at(
            repo,
            &[
                "merge-base".into(),
                "--is-ancestor".into(),
                old.as_str().into(),
                new.as_str().into(),
            ],
            None,
        )
        .is_ok())
}
fn tree(
    git: &crate::git_command::GitCommand,
    repo: &PathBuf,
    head: &GitOid,
) -> Result<Vec<(String, GitOid)>, SyncError> {
    git.run_at(
        repo,
        &[
            "ls-tree".into(),
            "-r".into(),
            "-z".into(),
            head.as_str().into(),
        ],
        None,
    )?
    .split(|b| *b == 0)
    .filter(|e| !e.is_empty())
    .map(|entry| {
        let entry = std::str::from_utf8(entry).map_err(|_| invalid("non-UTF-8 Git path"))?;
        let (left, path) = entry
            .split_once('\t')
            .ok_or_else(|| invalid("invalid tree entry"))?;
        let mut f = left.split_whitespace();
        if f.next() != Some("100644") || f.next() != Some("blob") {
            return Err(invalid("tree has non-file entry"));
        }
        Ok((
            path.into(),
            GitOid::parse(f.next().ok_or_else(|| invalid("missing tree OID"))?)?,
        ))
    })
    .collect()
}
fn prefix(plane: Plane) -> &'static str {
    match plane {
        Plane::Control => "control-atoms/",
        Plane::Data => "data-atoms/",
    }
}
fn validate_path(path: &str, plane: Plane) -> Result<(), SyncError> {
    let parts: Vec<_> = path.split('/').collect();
    if path.starts_with("control-atoms/") || path.starts_with("data-atoms/") {
        let target = if path.starts_with("control-atoms/") {
            Plane::Control
        } else {
            Plane::Data
        };
        let id = parts.get(2).and_then(|name| name.strip_suffix(".cbor"));
        if target != plane
            || parts.len() != 3
            || !id.is_some_and(|id| {
                id.len() >= 2
                    && parts[1] == &id[..2]
                    && id
                        .parse::<crate::EventId>()
                        .is_ok_and(|event| event.to_string() == id)
            })
        {
            return Err(invalid("invalid atom path"));
        }
        Ok(())
    } else if parts.len() == 3 && parts[0] == "texts" {
        Ok(())
    } else {
        Err(invalid("invalid tree path"))
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

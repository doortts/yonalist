use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use crate::{
    git_command::GitCommand, AtomLimits, DeviceId, EventId, GitOid, LocalCommit, Plane,
    RefAdvertisement, SignedAtom, StoreBatch, StoredAtom, SyncError, SyncErrorCode,
};

pub struct GitStore {
    repo: PathBuf,
    git: GitCommand,
}

impl GitStore {
    pub fn init(repo: &Path, git_executable: &Path) -> Result<Self, SyncError> {
        let repo = absolute(repo)?;
        GitCommand::init(git_executable, &repo)?;
        let git = GitCommand::new(git_executable, &repo);
        git.run(
            &[
                "config".into(),
                "core.hooksPath".into(),
                repo.join("disabled-hooks").into_os_string(),
            ],
            None,
        )?;
        git.run(&["config".into(), "gc.auto".into(), "0".into()], None)?;
        Self::open(&repo, git_executable)
    }

    pub fn open(repo: &Path, git_executable: &Path) -> Result<Self, SyncError> {
        let repo = absolute(repo)?;
        let git = GitCommand::new(git_executable, &repo);
        let format = text(git.run(&["rev-parse".into(), "--show-object-format".into()], None)?);
        if format != "sha256" {
            return Err(invalid("repository must use SHA-256 objects"));
        }
        Ok(Self { repo, git })
    }

    pub fn append_local(&self, batch: StoreBatch) -> Result<LocalCommit, SyncError> {
        let ref_name = device_ref(batch.plane, batch.device_id);
        let previous = self.ref_oid(&ref_name)?;
        if previous != batch.expected_head {
            return Err(SyncError {
                code: SyncErrorCode::RefRewind,
                message: "local ref no longer matches expected head".into(),
            });
        }
        let files = self.batch_files(&batch)?;
        let mut trees = BTreeMap::new();
        for head in batch.observed_heads.iter().chain(previous.iter()) {
            self.merge_tree(&mut trees, head, batch.plane)?;
        }
        for (path, bytes) in files {
            let oid = self.write_blob(&bytes)?;
            merge(&mut trees, path, oid)?;
        }
        let tree = self.write_tree(&trees)?;
        let parents = self.reduced_parents(previous.as_ref(), &batch.observed_heads)?;
        let mut args = vec![OsString::from("commit-tree"), OsString::from(tree.as_str())];
        for parent in &parents {
            args.push("-p".into());
            args.push(parent.as_str().into());
        }
        let commit = oid(self.git.run(&args, Some(b"Yonalist sync\n"))?)?;
        let expected = previous
            .as_ref()
            .map_or("0".repeat(64), |value| value.as_str().to_owned());
        let update = self.git.run(
            &[
                "update-ref".into(),
                ref_name.clone().into(),
                commit.as_str().into(),
                expected.into(),
            ],
            None,
        );
        if update.is_err() {
            return Err(SyncError {
                code: SyncErrorCode::RefRewind,
                message: "local ref compare-and-swap failed".into(),
            });
        }
        Ok(LocalCommit {
            ref_name,
            previous,
            head: commit,
        })
    }

    pub fn head(&self, plane: Plane, device: DeviceId) -> Result<Option<GitOid>, SyncError> {
        self.ref_oid(&device_ref(plane, device))
    }

    pub fn advertise(&self, plane: Plane) -> Result<RefAdvertisement, SyncError> {
        let output = self.git.run(
            &[
                "for-each-ref".into(),
                "--format=%(refname) %(objectname)".into(),
                plane.ref_prefix().into(),
            ],
            None,
        )?;
        let mut refs = BTreeMap::new();
        for line in text(output).lines() {
            let (name, value) = line
                .split_once(' ')
                .ok_or_else(|| invalid("invalid Git ref listing"))?;
            let device = name
                .strip_prefix(plane.ref_prefix())
                .ok_or_else(|| invalid("invalid Git ref"))?
                .parse()
                .map_err(|_| invalid("invalid device ref"))?;
            refs.insert(device, GitOid::parse(value)?);
        }
        Ok(RefAdvertisement { plane, refs })
    }

    pub fn stored_atoms(
        &self,
        plane: Plane,
        limits: &AtomLimits,
    ) -> Result<Vec<StoredAtom>, SyncError> {
        let heads = self
            .advertise(plane)?
            .refs
            .into_values()
            .collect::<Vec<_>>();
        let mut args = vec![OsString::from("rev-list"), OsString::from("--parents")];
        args.extend(heads.iter().map(|head| head.as_str().into()));
        let mut commits = BTreeMap::new();
        if !heads.is_empty() {
            for line in text(self.git.run(&args, None)?).lines() {
                let mut fields = line.split_whitespace();
                let commit =
                    GitOid::parse(fields.next().ok_or_else(|| invalid("missing commit OID"))?)?;
                let parents = fields.map(GitOid::parse).collect::<Result<Vec<_>, _>>()?;
                commits.insert(commit, parents);
            }
        }
        let trees = commits
            .keys()
            .map(|commit| {
                Ok((
                    commit.clone(),
                    self.tree(commit)?.into_iter().collect::<BTreeMap<_, _>>(),
                ))
            })
            .collect::<Result<BTreeMap<_, _>, SyncError>>()?;
        let mut immutable_union = BTreeMap::new();
        for tree in trees.values() {
            for (path, blob) in tree {
                validate_tree_path(path, plane)?;
                merge(&mut immutable_union, path.clone(), blob.clone())?;
            }
        }
        let mut paths: BTreeMap<String, (GitOid, GitOid)> = BTreeMap::new();
        for (commit, parents) in &commits {
            for (path, blob) in &trees[commit] {
                if path.starts_with(atom_prefix(plane)) {
                    let introduced = !parents.iter().any(|parent| {
                        trees.get(parent).and_then(|tree| tree.get(path)) == Some(blob)
                    });
                    match paths.get_mut(path) {
                        Some((existing, _)) if existing != blob => {
                            return Err(invalid("immutable path has conflicting bytes"));
                        }
                        Some((_, introducing)) if introduced && commit < introducing => {
                            *introducing = commit.clone();
                        }
                        None if introduced => {
                            paths.insert(path.clone(), (blob.clone(), commit.clone()));
                        }
                        _ => {}
                    }
                }
            }
        }
        paths
            .into_iter()
            .map(|(path, (blob, containing_commit))| {
                let bytes = self.git.run(
                    &["cat-file".into(), "blob".into(), blob.as_str().into()],
                    None,
                )?;
                let atom = SignedAtom::decode(&bytes, limits)?;
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

    pub fn is_ancestor(&self, older: &GitOid, newer: &GitOid) -> Result<bool, SyncError> {
        match self.git.run(
            &[
                "merge-base".into(),
                "--is-ancestor".into(),
                older.as_str().into(),
                newer.as_str().into(),
            ],
            None,
        ) {
            Ok(_) => Ok(true),
            Err(error) if error.code == SyncErrorCode::GitCommandFailed => Ok(false),
            Err(error) => Err(error),
        }
    }

    fn batch_files(&self, batch: &StoreBatch) -> Result<BTreeMap<String, Vec<u8>>, SyncError> {
        let mut files = BTreeMap::new();
        for atom in &batch.atoms {
            if atom.unsigned.plane != batch.plane
                || atom.unsigned.actor_device_id != batch.device_id
            {
                return Err(invalid("atom does not match batch plane or device"));
            }
            let path = atom.repo_path();
            validate_atom_path(&path, batch.plane)?;
            merge(
                &mut files,
                path,
                atom.encode(&AtomLimits {
                    max_payload_bytes: usize::MAX,
                    max_frontier_heads: usize::MAX,
                })?,
            )?;
        }
        for file in &batch.auxiliary_files {
            validate_auxiliary_path(&file.path)?;
            merge(&mut files, file.path.clone(), file.bytes.clone())?;
        }
        Ok(files)
    }

    fn write_blob(&self, bytes: &[u8]) -> Result<GitOid, SyncError> {
        oid(self.git.run(
            &["hash-object".into(), "-w".into(), "--stdin".into()],
            Some(bytes),
        )?)
    }
    fn write_tree(&self, files: &BTreeMap<String, GitOid>) -> Result<GitOid, SyncError> {
        let index = self.repo.join(format!(
            "yonalist-index-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| invalid("clock before Unix epoch"))?
                .as_nanos()
        ));
        let mut input = Vec::new();
        for (path, blob) in files {
            input.extend_from_slice(format!("100644 {}\t{}\0", blob.as_str(), path).as_bytes());
        }
        let result = (|| {
            self.git.run_with_env(
                &["update-index".into(), "-z".into(), "--index-info".into()],
                Some(&input),
                ("GIT_INDEX_FILE".as_ref(), index.as_os_str()),
            )?;
            oid(self.git.run_with_env(
                &["write-tree".into()],
                None,
                ("GIT_INDEX_FILE".as_ref(), index.as_os_str()),
            )?)
        })();
        let _ = fs::remove_file(&index);
        result
    }
    fn merge_tree(
        &self,
        target: &mut BTreeMap<String, GitOid>,
        head: &GitOid,
        plane: Plane,
    ) -> Result<(), SyncError> {
        for (path, blob) in self.tree(head)? {
            validate_tree_path(&path, plane)?;
            merge(target, path, blob)?;
        }
        Ok(())
    }
    fn tree(&self, head: &GitOid) -> Result<Vec<(String, GitOid)>, SyncError> {
        let output = self.git.run(
            &[
                "ls-tree".into(),
                "-r".into(),
                "-z".into(),
                head.as_str().into(),
            ],
            None,
        )?;
        output
            .split(|byte| *byte == 0)
            .filter(|entry| !entry.is_empty())
            .map(|entry| {
                let entry =
                    std::str::from_utf8(entry).map_err(|_| invalid("non-UTF-8 Git path"))?;
                let (left, path) = entry
                    .split_once('\t')
                    .ok_or_else(|| invalid("invalid tree entry"))?;
                let mut fields = left.split_whitespace();
                if fields.next() != Some("100644") || fields.next() != Some("blob") {
                    return Err(invalid("tree has non-file entry"));
                }
                Ok((
                    path.to_owned(),
                    GitOid::parse(fields.next().ok_or_else(|| invalid("missing tree OID"))?)?,
                ))
            })
            .collect()
    }
    fn reduced_parents(
        &self,
        previous: Option<&GitOid>,
        observed: &[GitOid],
    ) -> Result<Vec<GitOid>, SyncError> {
        let candidates = previous
            .into_iter()
            .chain(observed)
            .cloned()
            .collect::<BTreeSet<_>>();
        let mut retained = BTreeSet::new();
        for parent in &candidates {
            let mut redundant = false;
            for other in &candidates {
                if parent != other && self.is_ancestor(parent, other)? {
                    redundant = true;
                    break;
                }
            }
            if !redundant {
                retained.insert(parent.clone());
            }
        }
        let mut parents = Vec::new();
        if let Some(previous) = previous {
            if retained.remove(previous) {
                parents.push(previous.clone());
            }
        }
        parents.extend(retained);
        Ok(parents)
    }
    fn ref_oid(&self, name: &str) -> Result<Option<GitOid>, SyncError> {
        match self.git.run(
            &[
                "rev-parse".into(),
                "--verify".into(),
                "--quiet".into(),
                name.into(),
            ],
            None,
        ) {
            Ok(value) => Ok(Some(oid(value)?)),
            Err(error) if error.code == SyncErrorCode::GitCommandFailed => Ok(None),
            Err(error) => Err(error),
        }
    }
}

fn absolute(path: &Path) -> Result<PathBuf, SyncError> {
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        std::env::current_dir()
            .map_err(io)
            .map(|cwd| cwd.join(path))
    }
}
fn text(bytes: Vec<u8>) -> String {
    String::from_utf8_lossy(&bytes).trim().to_owned()
}
fn oid(bytes: Vec<u8>) -> Result<GitOid, SyncError> {
    GitOid::parse(&text(bytes))
}
fn io(error: std::io::Error) -> SyncError {
    SyncError {
        code: SyncErrorCode::Io,
        message: error.to_string(),
    }
}
fn invalid(message: impl Into<String>) -> SyncError {
    SyncError {
        code: SyncErrorCode::InvalidAtom,
        message: message.into(),
    }
}
fn device_ref(plane: Plane, device: DeviceId) -> String {
    format!("{}{}", plane.ref_prefix(), device)
}
fn atom_prefix(plane: Plane) -> &'static str {
    match plane {
        Plane::Control => "control-atoms/",
        Plane::Data => "data-atoms/",
    }
}
fn merge<T: Eq>(map: &mut BTreeMap<String, T>, path: String, value: T) -> Result<(), SyncError> {
    if let Some(existing) = map.get(&path) {
        if existing != &value {
            return Err(invalid("immutable path has conflicting bytes"));
        }
    } else {
        map.insert(path, value);
    }
    Ok(())
}
fn validate_atom_path(path: &str, plane: Plane) -> Result<(), SyncError> {
    let parts = path.split('/').collect::<Vec<_>>();
    let id = parts.get(2).and_then(|name| name.strip_suffix(".cbor"));
    if parts.len() == 3
        && parts[0] == atom_prefix(plane).trim_end_matches('/')
        && id.is_some_and(|id| {
            id.parse::<EventId>()
                .is_ok_and(|event_id| event_id.to_string() == id && parts[1] == &id[..2])
        })
    {
        Ok(())
    } else {
        Err(invalid("invalid atom path"))
    }
}
fn validate_auxiliary_path(path: &str) -> Result<(), SyncError> {
    let parts = path.split('/').collect::<Vec<_>>();
    let valid_hex = |part: &str| {
        !part.is_empty()
            && part
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    };
    let hash = parts.get(2).and_then(|name| name.strip_suffix(".md"));
    if parts.len() == 3
        && parts[0] == "texts"
        && parts[1].len() == 2
        && valid_hex(parts[1])
        && hash.is_some_and(|hash| hash.len() == 64 && valid_hex(hash) && parts[1] == &hash[..2])
    {
        Ok(())
    } else {
        Err(invalid("invalid auxiliary path"))
    }
}

fn validate_tree_path(path: &str, plane: Plane) -> Result<(), SyncError> {
    if path.starts_with("control-atoms/") {
        validate_atom_path(path, Plane::Control)?;
        if plane != Plane::Control {
            return Err(invalid("atom path belongs to the wrong plane"));
        }
        Ok(())
    } else if path.starts_with("data-atoms/") {
        validate_atom_path(path, Plane::Data)?;
        if plane != Plane::Data {
            return Err(invalid("atom path belongs to the wrong plane"));
        }
        Ok(())
    } else {
        validate_auxiliary_path(path)
    }
}

use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::{OsStr, OsString},
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use crate::{
    git_command::{bounded_message, GitCommand, GitExecLimits, GitExit, GitRuntime},
    protocol::StoreBatch,
    AtomLimits, DeviceId, EventId, GitOid, LocalCommit, Plane, RefAdvertisement, SignedAtom,
    StoredAtom, SyncError, SyncErrorCode,
};

pub struct GitStore {
    pub(crate) repo: PathBuf,
    pub(crate) git: GitCommand,
}

pub(crate) struct RepositoryWriter<'a> {
    pub(crate) store: &'a GitStore,
    _lock_file: File,
}

pub(crate) struct TrustedSnapshot {
    pub control: RefAdvertisement,
    pub data: RefAdvertisement,
}

impl GitStore {
    pub fn init(repo: &Path, git_executable: &Path) -> Result<Self, SyncError> {
        let repo = absolute(repo)?;
        let runtime = GitRuntime::probe(git_executable)?;
        GitCommand::init(runtime.executable(), &repo)?;
        let git = GitCommand::new(runtime.executable(), &repo);
        git.run(
            &[
                "config".into(),
                "core.hooksPath".into(),
                repo.join("disabled-hooks").into_os_string(),
            ],
            None,
        )?;
        git.run(&["config".into(), "gc.auto".into(), "0".into()], None)?;
        fs::create_dir_all(repo.join("yonalist-private")).map_err(io)?;
        Self::open(&repo, git_executable)
    }

    pub fn open(repo: &Path, git_executable: &Path) -> Result<Self, SyncError> {
        let repo = absolute(repo)?;
        let runtime = GitRuntime::probe(git_executable)?;
        let git = GitCommand::new(runtime.executable(), &repo);
        let format = text(git.run(&["rev-parse".into(), "--show-object-format".into()], None)?);
        if format != "sha256" {
            return Err(invalid("repository must use SHA-256 objects"));
        }
        fs::create_dir_all(repo.join("yonalist-private")).map_err(io)?;
        Ok(Self { repo, git })
    }

    #[cfg(feature = "test-support")]
    pub fn append_local(&self, batch: StoreBatch) -> Result<LocalCommit, SyncError> {
        self.with_writer(|writer| writer.append_local(batch))
    }

    pub(crate) fn with_writer<T>(
        &self,
        operation: impl FnOnce(&RepositoryWriter<'_>) -> Result<T, SyncError>,
    ) -> Result<T, SyncError> {
        let lock_file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(self.repo.join("yonalist-private/writer.lock"))
            .map_err(io)?;
        fs4::FileExt::lock(&lock_file).map_err(io)?;
        operation(&RepositoryWriter {
            store: self,
            _lock_file: lock_file,
        })
    }

    pub(crate) fn trusted_snapshot(&self) -> Result<TrustedSnapshot, SyncError> {
        Ok(TrustedSnapshot {
            control: self.advertise(Plane::Control)?,
            data: self.advertise(Plane::Data)?,
        })
    }

    fn append_locked(&self, batch: StoreBatch) -> Result<LocalCommit, SyncError> {
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
        // `commit-tree` can copy the repository-local i18n.commitEncoding into
        // the commit object. Pin it command-locally so two replicas with the
        // same protocol inputs cannot produce different bytes. The remaining
        // commit bytes are already fixed here: tree/parents/message, identities
        // from `base_command`, and dates below. Signing requires an explicit
        // `commit-tree -S`, which this protocol never supplies.
        let mut args = vec![
            OsString::from("-c"),
            OsString::from("i18n.commitEncoding=UTF-8"),
            OsString::from("commit-tree"),
            OsString::from(tree.as_str()),
        ];
        for parent in &parents {
            args.push("-p".into());
            args.push(parent.as_str().into());
        }
        // Git's environment date parser requires the `@` Unix-time marker.
        let protocol_date = OsStr::new("@0 +0000");
        let commit = oid(self.git.run_with_envs(
            &args,
            Some(b"Yonalist sync\n"),
            &[
                (OsStr::new("GIT_AUTHOR_DATE"), protocol_date),
                (OsStr::new("GIT_COMMITTER_DATE"), protocol_date),
            ],
        )?)?;
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
        let mut remaining_parents = BTreeMap::new();
        let mut children: BTreeMap<GitOid, Vec<GitOid>> = BTreeMap::new();
        for (commit, parents) in &commits {
            let parents = parents
                .iter()
                .filter(|parent| commits.contains_key(*parent))
                .cloned()
                .collect::<Vec<_>>();
            remaining_parents.insert(commit.clone(), parents.len());
            for parent in parents {
                children.entry(parent).or_default().push(commit.clone());
            }
        }
        // OID order is the deterministic tie-break for causally concurrent commits.
        let mut ready = remaining_parents
            .iter()
            .filter_map(|(commit, count)| (*count == 0).then_some(commit.clone()))
            .collect::<BTreeSet<_>>();
        let mut ordered_commits = Vec::with_capacity(commits.len());
        while let Some(commit) = ready.pop_first() {
            ordered_commits.push(commit.clone());
            for child in children.get(&commit).into_iter().flatten() {
                let count = remaining_parents
                    .get_mut(child)
                    .expect("child commit was collected");
                *count -= 1;
                if *count == 0 {
                    ready.insert(child.clone());
                }
            }
        }
        if ordered_commits.len() != commits.len() {
            return Err(invalid("commit graph is not acyclic"));
        }
        let mut paths: BTreeMap<String, (GitOid, GitOid)> = BTreeMap::new();
        let mut introduction_order = Vec::new();
        for commit in ordered_commits {
            let parents = &commits[&commit];
            for (path, blob) in &trees[&commit] {
                if path.starts_with(atom_prefix(plane)) {
                    let introduced = !parents.iter().any(|parent| {
                        trees.get(parent).and_then(|tree| tree.get(path)) == Some(blob)
                    });
                    match paths.get_mut(path) {
                        Some((existing, _)) if existing != blob => {
                            return Err(invalid("immutable path has conflicting bytes"));
                        }
                        None if introduced => {
                            paths.insert(path.clone(), (blob.clone(), commit.clone()));
                            introduction_order.push(path.clone());
                        }
                        _ => {}
                    }
                }
            }
        }
        let blobs = read_blobs(&self.git, paths.values().map(|(blob, _)| blob))?;
        introduction_order
            .into_iter()
            .map(|path| {
                let (blob, containing_commit) = paths
                    .remove(&path)
                    .expect("introduced atom path was recorded");
                let bytes = blobs
                    .get(&blob)
                    .expect("requested stored atom blob was returned");
                let atom = SignedAtom::decode(bytes, limits)?;
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
        match self.git.run_status(
            &[
                "merge-base".into(),
                "--is-ancestor".into(),
                older.as_str().into(),
                newer.as_str().into(),
            ],
            None,
            &GitExecLimits::default(),
        ) {
            Ok(GitExit::Success(_)) => Ok(true),
            Ok(GitExit::Code { code: 1, .. }) => Ok(false),
            Ok(GitExit::Code { stderr, .. }) => Err(SyncError {
                code: SyncErrorCode::GitCommandFailed,
                message: bounded_message(&stderr, GitExecLimits::default().max_stderr_bytes),
            }),
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
            self.git.run_with_envs(
                &["update-index".into(), "-z".into(), "--index-info".into()],
                Some(&input),
                &[("GIT_INDEX_FILE".as_ref(), index.as_os_str())],
            )?;
            oid(self.git.run_with_envs(
                &["write-tree".into()],
                None,
                &[("GIT_INDEX_FILE".as_ref(), index.as_os_str())],
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
            parents.push(previous.clone());
            retained.remove(previous);
        }
        parents.extend(retained);
        Ok(parents)
    }
    fn ref_oid(&self, name: &str) -> Result<Option<GitOid>, SyncError> {
        let output = self.git.run(
            &[
                "for-each-ref".into(),
                "--format=%(refname)%00%(objectname)".into(),
                name.into(),
            ],
            None,
        )?;
        parse_exact_ref_oid(&output, name)
    }
}

fn read_blobs<'a>(
    git: &GitCommand,
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
    let output = git.run(&["cat-file".into(), "--batch".into()], Some(&input))?;
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

impl RepositoryWriter<'_> {
    pub(crate) fn append_local(&self, batch: StoreBatch) -> Result<LocalCommit, SyncError> {
        self.store.append_locked(batch)
    }
}

fn parse_exact_ref_oid(output: &[u8], expected_name: &str) -> Result<Option<GitOid>, SyncError> {
    let output = output.strip_suffix(b"\n").unwrap_or(output);
    if output.is_empty() {
        return Ok(None);
    }
    let mut exact = None;
    for line in output.split(|byte| *byte == b'\n') {
        let separator = line
            .iter()
            .position(|byte| *byte == 0)
            .ok_or_else(|| invalid("invalid Git ref listing"))?;
        let (name, oid_with_separator) = line.split_at(separator);
        let name = std::str::from_utf8(name).map_err(|_| invalid("invalid Git ref name"))?;
        let value = std::str::from_utf8(&oid_with_separator[1..])
            .map_err(|_| invalid("invalid Git ref object"))?;
        let value = GitOid::parse(value).map_err(|_| invalid("invalid Git ref object"))?;
        if name == expected_name {
            if exact.replace(value).is_some() {
                return Err(invalid("Git returned multiple objects for one exact ref"));
            }
        }
    }
    Ok(exact)
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
pub(crate) fn atom_prefix(plane: Plane) -> &'static str {
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

pub(crate) fn validate_tree_path(path: &str, plane: Plane) -> Result<(), SyncError> {
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

pub(crate) fn validate_tree_directory(path: &str, plane: Plane) -> Result<(), SyncError> {
    let parts = path.split('/').collect::<Vec<_>>();
    let atom_root = atom_prefix(plane).trim_end_matches('/');
    let valid_text_shard = |part: &str| {
        part.len() == 2
            && part
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    };
    let valid_atom_shard = |part: &str| {
        const CROCKFORD: &[u8] = b"0123456789abcdefghjkmnpqrstvwxyz";
        let bytes = part.as_bytes();
        bytes.len() == 2
            && matches!(bytes[0], b'0'..=b'7')
            && bytes.iter().all(|byte| CROCKFORD.contains(byte))
    };
    let valid_root = |root: &str| root == "texts" || root == atom_root;
    if (parts.len() == 1 && valid_root(parts[0]))
        || (parts.len() == 2
            && ((parts[0] == "texts" && valid_text_shard(parts[1]))
                || (parts[0] == atom_root && valid_atom_shard(parts[1]))))
    {
        Ok(())
    } else {
        Err(invalid("invalid tree directory"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::mpsc, thread, time::Duration};

    const OID: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const NAME: &str = "refs/yonalist/data/00000000000000000000000000";

    #[test]
    fn exact_ref_parser_rejects_ambiguous_and_malformed_results() {
        let child = format!("{NAME}/extra\0{OID}\n");
        assert_eq!(parse_exact_ref_oid(child.as_bytes(), NAME).unwrap(), None);

        let duplicate = format!("{NAME}\0{OID}\n{NAME}\0{OID}\n");
        assert_eq!(
            parse_exact_ref_oid(duplicate.as_bytes(), NAME)
                .unwrap_err()
                .code,
            SyncErrorCode::InvalidAtom
        );

        for malformed in [
            format!("{NAME} {OID}\n"),
            format!("{NAME}\0not-an-oid\n"),
            format!("{NAME}\0{OID}\0extra\n"),
        ] {
            assert_eq!(
                parse_exact_ref_oid(malformed.as_bytes(), NAME)
                    .unwrap_err()
                    .code,
                SyncErrorCode::InvalidAtom
            );
        }
    }

    #[test]
    fn writer_lock_serializes_separately_opened_stores() {
        let directory = tempfile::tempdir().unwrap();
        let git = Path::new("git");
        let first = GitStore::init(directory.path(), git).unwrap();
        let second = GitStore::open(directory.path(), git).unwrap();
        let (held_tx, held_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::channel();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();

        let holder = thread::spawn(move || {
            first
                .with_writer(|_| {
                    held_tx.send(()).unwrap();
                    release_rx.recv_timeout(Duration::from_secs(3)).unwrap();
                    Ok(())
                })
                .unwrap();
            done_tx.send(()).unwrap();
        });
        held_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        let contender = OpenOptions::new()
            .read(true)
            .write(true)
            .open(directory.path().join("yonalist-private/writer.lock"))
            .unwrap();
        assert!(matches!(
            fs4::FileExt::try_lock(&contender),
            Err(fs4::TryLockError::WouldBlock)
        ));
        let waiter = thread::spawn(move || {
            ready_tx.send(()).unwrap();
            second
                .with_writer(|_| {
                    entered_tx.send(()).unwrap();
                    Ok(())
                })
                .unwrap();
        });

        ready_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        release_tx.send(()).unwrap();
        entered_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        done_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        holder.join().unwrap();
        waiter.join().unwrap();
    }
}

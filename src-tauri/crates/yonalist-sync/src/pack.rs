use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsString,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

use crate::{
    git_command::{GitCommand, GitExecLimits},
    git_store::{read_blobs_at, GitStore, RepositoryWriter, TrustedSnapshot},
    AtomLimits, DeviceId, GitOid, Plane, ProjectId, ProjectPolicy, RefAdvertisement, StoredAtom,
    SyncError, SyncErrorCode,
};

static QUARANTINE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PackLimits {
    pub max_pack_bytes: usize,
    pub max_advertised_refs: usize,
    pub max_commits: usize,
    pub max_objects: usize,
    pub max_tree_entries_per_commit: usize,
    pub max_atoms_per_head: usize,
    pub max_single_blob_bytes: usize,
    pub max_expanded_bytes: u64,
    pub max_metadata_bytes: usize,
}

impl Default for PackLimits {
    fn default() -> Self {
        Self {
            max_pack_bytes: 16 * 1024 * 1024,
            max_advertised_refs: 128,
            max_commits: 1024,
            max_objects: 8192,
            max_tree_entries_per_commit: 1024,
            max_atoms_per_head: 1024,
            max_single_blob_bytes: 4 * 1024 * 1024,
            max_expanded_bytes: 64 * 1024 * 1024,
            max_metadata_bytes: 4 * 1024 * 1024,
        }
    }
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
    #[cfg(feature = "test-support")]
    pub rejected: Vec<(DeviceId, SyncErrorCode)>,
    #[cfg(feature = "test-support")]
    pub pack_bytes: usize,
    #[cfg(feature = "test-support")]
    accepted_refs: Vec<CandidateRef>,
}

pub(crate) struct ImportRequest<'a, P: ProjectPolicy> {
    pub(crate) expected_project_id: ProjectId,
    pub(crate) plane: Plane,
    pub(crate) advertised: &'a RefAdvertisement,
    pub(crate) pack: PackBytes,
    pub(crate) atom_limits: &'a AtomLimits,
    pub(crate) pack_limits: &'a PackLimits,
    pub(crate) policy: &'a P,
}

type AcceptedRef = CandidateRef;
type CommitParents = (GitOid, Vec<GitOid>);
type TraversalKey = (Vec<GitOid>, Vec<GitOid>);
type DeviceWalk = (DeviceId, Vec<CommitParents>);

#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct PackBudget {
    commits: usize,
    objects: usize,
    expanded_bytes: u64,
    metadata_bytes: usize,
}

struct ValidationResult {
    accepted: Vec<AcceptedRef>,
    #[cfg(feature = "test-support")]
    rejected: Vec<(DeviceId, SyncErrorCode)>,
    budget: PackBudget,
}

struct SanitizedPack {
    pack_path: PathBuf,
    idx_path: PathBuf,
    pack_hash: String,
}

/// Disposable repositories bound every Git input/output, parsed metadata, and
/// wall time before accepted-only objects can reach trusted storage. This is
/// cooperative application containment; hard Git CPU/RSS isolation remains a
/// responsibility of the packaged app's OS sandbox.
struct QuarantineSession {
    root: PathBuf,
    incoming: PathBuf,
    sanitized: PathBuf,
    git: GitCommand,
    cleaned: bool,
    #[cfg(feature = "test-support")]
    audit_path: PathBuf,
}

impl QuarantineSession {
    fn new(store: &GitStore, limits: &PackLimits) -> Result<Self, SyncError> {
        let sessions = store.repo.join("incoming");
        fs::create_dir_all(&sessions).map_err(io)?;
        let root = allocate_session(&sessions, || {
            format!(
                "{}-{}",
                std::process::id(),
                QUARANTINE_COUNTER.fetch_add(1, Ordering::Relaxed)
            )
        })?;
        let incoming = root.join("incoming.git");
        let sanitized = root.join("sanitized.git");
        let result = (|| {
            GitCommand::init(&store.git_executable(), &incoming)?;
            GitCommand::init(&store.git_executable(), &sanitized)?;
            let objects = fs::canonicalize(store.repo.join("objects")).map_err(io)?;
            let alternate = alternates_line(&objects)?;
            for repository in [&incoming, &sanitized] {
                fs::write(repository.join("objects/info/alternates"), &alternate).map_err(io)?;
            }
            Ok(Self {
                root: root.clone(),
                incoming: incoming.clone(),
                sanitized,
                git: GitCommand::for_pack_session_with_timeout(
                    &store.git_executable(),
                    &incoming,
                    limits.max_metadata_bytes,
                    store
                        .pack_command_timeout_for_test()
                        .unwrap_or(Duration::from_secs(60)),
                ),
                cleaned: false,
                #[cfg(feature = "test-support")]
                audit_path: store
                    .repo
                    .join("yonalist-private/pack-audits")
                    .join(format!(
                        "{}.log",
                        root.file_name()
                            .and_then(|name| name.to_str())
                            .unwrap_or("session")
                    )),
            })
        })();
        if result.is_ok() {
            result
        } else {
            finish_cleanup(result, fs::remove_dir_all(root))
        }
    }

    fn finish<T>(&mut self, result: Result<T, SyncError>) -> Result<T, SyncError> {
        #[cfg(feature = "test-support")]
        let result = match self.write_test_audit() {
            Ok(()) => result,
            Err(error) => Err(error),
        };
        let cleanup = fs::remove_dir_all(&self.root);
        if cleanup.is_ok() {
            self.cleaned = true;
        }
        finish_cleanup(result, cleanup)
    }

    #[cfg(feature = "test-support")]
    fn write_test_audit(&self) -> Result<(), SyncError> {
        let parent = self
            .audit_path
            .parent()
            .expect("pack audit has a parent directory");
        fs::create_dir_all(parent).map_err(io)?;
        let received = fs::metadata(self.incoming.join("received.pack"))
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        let sanitized = fs::metadata(self.root.join("sanitized.pack"))
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        let mut output = format!("received_bytes={received}\nsanitized_bytes={sanitized}\n");
        for (repository, command) in self.git.pack_command_audit()? {
            output.push_str(&format!(
                "command={}\trepository={}\n",
                command.to_string_lossy(),
                repository.to_string_lossy()
            ));
        }
        fs::write(&self.audit_path, output).map_err(io)
    }
}

impl Drop for QuarantineSession {
    fn drop(&mut self) {
        if !self.cleaned {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
}

impl ImportOutcome {
    #[cfg(feature = "test-support")]
    pub fn accepted_refs(&self) -> &[CandidateRef] {
        &self.accepted_refs
    }

    #[cfg(feature = "test-support")]
    pub fn accepted(&self) -> &[CandidateRef] {
        self.accepted_refs()
    }

    #[cfg(feature = "test-support")]
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
        let advertised = request
            .wants
            .len()
            .checked_add(request.haves.len())
            .ok_or_else(|| limit("pack ref count overflow"))?;
        if request.wants.is_empty() || advertised > limits.max_advertised_refs {
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
        let bytes = self.git.run_at_with_limits(
            &self.repo,
            &[
                "pack-objects".into(),
                "--stdout".into(),
                "--revs".into(),
                "--thin".into(),
            ],
            Some(&input),
            &GitExecLimits {
                max_stdout_bytes: limits.max_pack_bytes,
                max_stderr_bytes: 256 * 1024,
                timeout: Duration::from_secs(60),
            },
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
    #[cfg(feature = "test-support")]
    #[doc(hidden)]
    #[expect(
        clippy::too_many_arguments,
        reason = "feature-gated raw fixture compatibility adapter; production writes pass ImportRequest"
    )]
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
        let request = ImportRequest {
            expected_project_id,
            plane,
            advertised,
            pack: pack_bytes,
            atom_limits,
            pack_limits,
            policy,
        };
        self.with_writer(|writer| writer.import_pack(request))
    }

    fn import_locked<P: ProjectPolicy>(
        &self,
        request: ImportRequest<'_, P>,
    ) -> Result<ImportOutcome, SyncError> {
        if request.advertised.plane != request.plane
            || request.advertised.refs.len() > request.pack_limits.max_advertised_refs
            || request.pack.0.is_empty()
        {
            return Err(pack("invalid advertised pack"));
        }
        if request.pack.0.len() > request.pack_limits.max_pack_bytes {
            return Err(limit("pack exceeds byte limit"));
        }
        let snapshot = self.trusted_snapshot()?;
        #[cfg(feature = "test-support")]
        let pack_bytes_len = request.pack.0.len();
        let mut session = QuarantineSession::new(self, request.pack_limits)?;
        let result = (|| {
            let validation = audit_pack(&session, &request, &snapshot)?;
            debug_assert!(validation.budget.commits <= request.pack_limits.max_commits);
            debug_assert!(validation.budget.objects <= request.pack_limits.max_objects);
            debug_assert!(
                validation.budget.expanded_bytes <= request.pack_limits.max_expanded_bytes
            );
            debug_assert!(
                validation.budget.metadata_bytes <= request.pack_limits.max_metadata_bytes
            );
            if validation.accepted.is_empty() {
                return Ok(ImportOutcome {
                    accepted: 0,
                    #[cfg(feature = "test-support")]
                    rejected: validation.rejected,
                    #[cfg(feature = "test-support")]
                    pack_bytes: pack_bytes_len,
                    #[cfg(feature = "test-support")]
                    accepted_refs: vec![],
                });
            }
            let sanitized = build_sanitized_pack(
                &session,
                &validation.accepted,
                &snapshot,
                request.pack_limits,
            )?;
            revalidate_sanitized(
                &session,
                &request,
                &snapshot,
                &validation.accepted,
                sanitized.as_ref(),
            )?;
            install_sanitized_pack_and_refs(
                self,
                sanitized,
                &validation.accepted,
                &snapshot,
                request.plane,
            )?;
            Ok(ImportOutcome {
                accepted: validation.accepted.len(),
                #[cfg(feature = "test-support")]
                rejected: validation.rejected,
                #[cfg(feature = "test-support")]
                pack_bytes: pack_bytes_len,
                #[cfg(feature = "test-support")]
                accepted_refs: validation.accepted,
            })
        })();
        session.finish(result)
    }
    fn git_executable(&self) -> PathBuf {
        self.git.executable()
    }
}

impl RepositoryWriter<'_> {
    pub(crate) fn import_pack<P: ProjectPolicy>(
        &self,
        request: ImportRequest<'_, P>,
    ) -> Result<ImportOutcome, SyncError> {
        self.store.import_locked(request)
    }
}

fn audit_pack<P: ProjectPolicy>(
    session: &QuarantineSession,
    request: &ImportRequest<'_, P>,
    snapshot: &TrustedSnapshot,
) -> Result<ValidationResult, SyncError> {
    let received_path = session.incoming.join("received.pack");
    write_capped_file(
        &received_path,
        &request.pack.0,
        request.pack_limits.max_pack_bytes,
    )?;
    let pack_hash = index_pack(
        session,
        &session.incoming,
        &request.pack.0,
        request.pack_limits,
    )?;
    let idx_path = pack_artifact(&session.incoming, &pack_hash, "idx")?;
    let mut budget = audit_object_budget(session, &idx_path, request.pack_limits)?;
    audit_structural_budget(session, request, snapshot, &mut budget)?;
    let (accepted, rejected) = validate_candidates(CandidateValidationRequest {
        git: &session.git,
        repository: &session.incoming,
        expected_project_id: request.expected_project_id,
        plane: request.plane,
        advertised: request.advertised,
        atom_limits: request.atom_limits,
        pack_limits: request.pack_limits,
        policy: request.policy,
        snapshot,
    })?;
    #[cfg(not(feature = "test-support"))]
    let _ = rejected;
    budget.metadata_bytes = session.git.pack_metadata_bytes()?;
    Ok(ValidationResult {
        accepted,
        #[cfg(feature = "test-support")]
        rejected,
        budget,
    })
}

fn index_pack(
    session: &QuarantineSession,
    repository: &Path,
    bytes: &[u8],
    limits: &PackLimits,
) -> Result<String, SyncError> {
    if bytes.is_empty() || bytes.len() > limits.max_pack_bytes {
        return Err(limit("pack exceeds byte limit"));
    }
    let exec_limits = GitExecLimits {
        max_stdout_bytes: 4 * 1024,
        max_stderr_bytes: 256 * 1024,
        timeout: Duration::from_secs(60),
    };
    let output = session
        .git
        .run_at_with_limits(
            repository,
            &[
                "index-pack".into(),
                "--stdin".into(),
                "--fix-thin".into(),
                "--fsck-objects".into(),
                format!("--max-input-size={}", limits.max_pack_bytes).into(),
            ],
            Some(bytes),
            &exec_limits,
        )
        .map_err(|error| {
            if error.code == SyncErrorCode::LimitExceeded {
                error
            } else {
                pack(format!("pack import failed: {}", error.message))
            }
        })?;
    parse_pack_hash(&output)
}

fn parse_pack_hash(output: &[u8]) -> Result<String, SyncError> {
    let text = std::str::from_utf8(output).map_err(|_| pack("invalid index-pack output"))?;
    let hash = text
        .trim()
        .strip_prefix("pack\t")
        .unwrap_or_else(|| text.trim());
    let oid = GitOid::parse(hash).map_err(|_| pack("invalid SHA-256 pack hash"))?;
    if oid.as_str() != hash
        || !hash
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(pack("invalid SHA-256 pack hash"));
    }
    Ok(hash.to_owned())
}

fn pack_artifact(repository: &Path, hash: &str, extension: &str) -> Result<PathBuf, SyncError> {
    let path = repository
        .join("objects/pack")
        .join(format!("pack-{hash}.{extension}"));
    if !path.is_file() {
        return Err(pack(format!(
            "index-pack did not create {extension} artifact"
        )));
    }
    Ok(path)
}

fn audit_object_budget(
    session: &QuarantineSession,
    idx_path: &Path,
    limits: &PackLimits,
) -> Result<PackBudget, SyncError> {
    let output = session.git.run_at(
        &session.incoming,
        &[
            "verify-pack".into(),
            "-v".into(),
            idx_path.as_os_str().into(),
        ],
        None,
    )?;
    let mut seen = BTreeSet::new();
    let mut budget = PackBudget::default();
    for line in std::str::from_utf8(&output)
        .map_err(|_| pack("verify-pack returned non-UTF-8 metadata"))?
        .lines()
    {
        let mut fields = line.split_whitespace();
        let Some(candidate) = fields.next() else {
            continue;
        };
        if candidate.len() != 64 || !candidate.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            continue;
        }
        let object = GitOid::parse(candidate)?;
        let kind = fields
            .next()
            .ok_or_else(|| pack("verify-pack omitted object type"))?;
        if !matches!(kind, "commit" | "tree" | "blob" | "tag") {
            return Err(pack("verify-pack returned unsupported object type"));
        }
        let size = fields
            .next()
            .ok_or_else(|| pack("verify-pack omitted object size"))?
            .parse::<u64>()
            .map_err(|_| pack("verify-pack returned invalid object size"))?;
        if !seen.insert(object) {
            return Err(pack("verify-pack returned a duplicate object"));
        }
        budget.objects = checked_usize_add(budget.objects, 1, "object count overflow")?;
        if budget.objects > limits.max_objects {
            return Err(limit("pack exceeds object limit"));
        }
        budget.expanded_bytes = budget
            .expanded_bytes
            .checked_add(size)
            .ok_or_else(|| limit("expanded byte count overflow"))?;
        if budget.expanded_bytes > limits.max_expanded_bytes {
            return Err(limit("pack exceeds expanded byte limit"));
        }
        if kind == "commit" {
            budget.commits = checked_usize_add(budget.commits, 1, "commit count overflow")?;
            if budget.commits > limits.max_commits {
                return Err(limit("pack exceeds commit limit"));
            }
        }
        if kind == "blob" && size > u64::try_from(limits.max_single_blob_bytes).unwrap_or(u64::MAX)
        {
            return Err(limit("pack contains an oversized blob"));
        }
    }
    Ok(budget)
}

fn audit_structural_budget<P: ProjectPolicy>(
    session: &QuarantineSession,
    request: &ImportRequest<'_, P>,
    snapshot: &TrustedSnapshot,
    _budget: &mut PackBudget,
) -> Result<(), SyncError> {
    let boundaries = snapshot_for_plane(snapshot, request.plane)
        .refs
        .values()
        .cloned()
        .collect::<Vec<_>>();
    let heads = request
        .advertised
        .refs
        .values()
        .cloned()
        .collect::<Vec<_>>();
    let commits = reachable_commits(&session.git, &session.incoming, &heads, &boundaries)?;
    if commits.len() > request.pack_limits.max_commits {
        return Err(limit("pack exceeds reachable commit limit"));
    }
    for (commit, _) in &commits {
        let (entries, _) =
            tree_budget_counts(&session.git, &session.incoming, commit, request.plane)?;
        if entries > request.pack_limits.max_tree_entries_per_commit {
            return Err(limit("commit tree exceeds entry limit"));
        }
    }
    for head in &heads {
        let (_, atoms) = tree_budget_counts(&session.git, &session.incoming, head, request.plane)?;
        if atoms > request.pack_limits.max_atoms_per_head {
            return Err(limit("head exceeds atom limit"));
        }
    }
    Ok(())
}

type CandidateRejections = Vec<(DeviceId, SyncErrorCode)>;
type CandidateValidationResult = Result<(Vec<AcceptedRef>, CandidateRejections), SyncError>;

struct CandidateValidationRequest<'a, P: ProjectPolicy> {
    git: &'a GitCommand,
    repository: &'a PathBuf,
    expected_project_id: ProjectId,
    plane: Plane,
    advertised: &'a RefAdvertisement,
    atom_limits: &'a AtomLimits,
    pack_limits: &'a PackLimits,
    policy: &'a P,
    snapshot: &'a TrustedSnapshot,
}

fn validate_candidates<P: ProjectPolicy>(
    request: CandidateValidationRequest<'_, P>,
) -> CandidateValidationResult {
    let CandidateValidationRequest {
        git,
        repository,
        expected_project_id,
        plane,
        advertised,
        atom_limits,
        pack_limits,
        policy,
        snapshot,
    } = request;
    let mut accepted = Vec::new();
    let mut rejected = Vec::new();
    let exact_trusted_heads = snapshot_for_plane(snapshot, plane)
        .refs
        .values()
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let trusted_heads = reduced_frontier(git, repository, exact_trusted_heads.iter().cloned())?;
    let mut memo = ImportMemo::new();
    let validation = ValidationContext::new(
        git,
        repository,
        plane,
        trusted_heads.clone(),
        exact_trusted_heads,
        &mut memo,
    )?;
    let mut eligible = Vec::new();
    for (device, head) in &advertised.refs {
        let previous = snapshot_for_plane(snapshot, plane)
            .refs
            .get(device)
            .cloned();
        if previous.as_ref() == Some(head) {
            continue;
        }
        if let Some(old) = &previous {
            if !first_parent_ancestor(git, repository, old, head)? {
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
    loop {
        let mut union = validation.clone();
        let union_heads = candidates
            .iter()
            .filter_map(|candidate| candidate.current.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        let failure = match validate_reachable_heads(ReachableHeadsValidation {
            git,
            repo: repository,
            plane,
            candidates: &union_heads,
            atom_limits,
            limits: pack_limits,
            policy,
            validation: &mut union,
            expected_project_id,
            trusted_control: &snapshot.control,
            candidate_refs: &candidates,
            memo: &mut memo,
        }) {
            Ok(()) => break,
            Err(failure) => failure,
        };
        if !is_candidate_semantic_error(failure.error.code) {
            return Err(failure.error);
        }
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
                if newly_reaches(git, repository, current, commit, &trusted_heads)? {
                    rollback_commit = Some(commit);
                    break;
                }
            }
            if let Some(rollback_commit) = rollback_commit {
                candidate.current = rollback_prefix(
                    git,
                    repository,
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
            accepted.push(AcceptedRef {
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
    Ok((accepted, rejected))
}

fn is_candidate_semantic_error(code: SyncErrorCode) -> bool {
    matches!(
        code,
        SyncErrorCode::InvalidId
            | SyncErrorCode::InvalidAtom
            | SyncErrorCode::InvalidSignature
            | SyncErrorCode::UnsupportedSchema
            | SyncErrorCode::PolicyRejected
            | SyncErrorCode::AccessRevoked
    )
}

fn build_sanitized_pack(
    session: &QuarantineSession,
    accepted: &[AcceptedRef],
    snapshot: &TrustedSnapshot,
    limits: &PackLimits,
) -> Result<Option<SanitizedPack>, SyncError> {
    let trusted_heads = snapshot
        .control
        .refs
        .values()
        .chain(snapshot.data.refs.values())
        .cloned()
        .collect::<BTreeSet<_>>();
    let mut rev_input = Vec::new();
    for head in accepted
        .iter()
        .map(|candidate| &candidate.accepted_head)
        .collect::<BTreeSet<_>>()
    {
        rev_input.extend_from_slice(head.as_str().as_bytes());
        rev_input.push(b'\n');
    }
    for head in &trusted_heads {
        rev_input.extend_from_slice(format!("^{}\n", head.as_str()).as_bytes());
    }

    let mut list_args = vec!["rev-list".into(), "--objects".into()];
    list_args.extend(
        accepted
            .iter()
            .map(|candidate| candidate.accepted_head.as_str().into()),
    );
    if !trusted_heads.is_empty() {
        list_args.push("--not".into());
        list_args.extend(trusted_heads.iter().map(|head| head.as_str().into()));
    }
    if session
        .git
        .run_at(&session.incoming, &list_args, None)?
        .is_empty()
    {
        return Ok(None);
    }

    let output_limits = GitExecLimits {
        max_stdout_bytes: limits.max_pack_bytes,
        max_stderr_bytes: 256 * 1024,
        timeout: Duration::from_secs(60),
    };
    let bytes = session.git.run_at_with_limits(
        &session.incoming,
        &["pack-objects".into(), "--stdout".into(), "--revs".into()],
        Some(&rev_input),
        &output_limits,
    )?;
    if bytes.is_empty() || bytes.len() > limits.max_pack_bytes {
        return Err(limit("sanitized pack exceeds byte limit"));
    }
    let sanitized_path = session.root.join("sanitized.pack");
    write_capped_file(&sanitized_path, &bytes, limits.max_pack_bytes)?;
    let pack_hash = index_pack(session, &session.sanitized, &bytes, limits)?;
    let pack_path = pack_artifact(&session.sanitized, &pack_hash, "pack")?;
    let idx_path = pack_artifact(&session.sanitized, &pack_hash, "idx")?;
    Ok(Some(SanitizedPack {
        pack_path,
        idx_path,
        pack_hash,
    }))
}

fn revalidate_sanitized<P: ProjectPolicy>(
    session: &QuarantineSession,
    request: &ImportRequest<'_, P>,
    snapshot: &TrustedSnapshot,
    accepted: &[AcceptedRef],
    sanitized: Option<&SanitizedPack>,
) -> Result<(), SyncError> {
    if let Some(sanitized) = sanitized {
        let _ = audit_object_budget(session, &sanitized.idx_path, request.pack_limits)?;
    }
    let advertised = RefAdvertisement {
        plane: request.plane,
        refs: accepted
            .iter()
            .map(|candidate| (candidate.device_id, candidate.accepted_head.clone()))
            .collect(),
    };
    let repository = if sanitized.is_some() {
        &session.sanitized
    } else {
        &session.incoming
    };
    let (second_accepted, second_rejected) = validate_candidates(CandidateValidationRequest {
        git: &session.git,
        repository,
        expected_project_id: request.expected_project_id,
        plane: request.plane,
        advertised: &advertised,
        atom_limits: request.atom_limits,
        pack_limits: request.pack_limits,
        policy: request.policy,
        snapshot,
    })?;
    let expected = accepted
        .iter()
        .map(|candidate| {
            (
                candidate.device_id,
                candidate.previous.clone(),
                candidate.accepted_head.clone(),
            )
        })
        .collect::<Vec<_>>();
    let actual = second_accepted
        .iter()
        .map(|candidate| {
            (
                candidate.device_id,
                candidate.previous.clone(),
                candidate.accepted_head.clone(),
            )
        })
        .collect::<Vec<_>>();
    if !second_rejected.is_empty() || actual != expected {
        return Err(pack("sanitized pack validation changed accepted refs"));
    }
    if session.git.pack_metadata_bytes()? > request.pack_limits.max_metadata_bytes {
        return Err(limit("pack exceeds metadata limit"));
    }
    Ok(())
}

fn install_sanitized_pack_and_refs(
    store: &GitStore,
    sanitized: Option<SanitizedPack>,
    accepted: &[AcceptedRef],
    snapshot: &TrustedSnapshot,
    plane: Plane,
) -> Result<(), SyncError> {
    if let Some(sanitized) = sanitized {
        let pack_dir = store.repo.join("objects/pack");
        fs::create_dir_all(&pack_dir).map_err(io)?;
        install_sanitized_artifacts(store, &sanitized, &pack_dir)?;
    }
    ensure_snapshot(store, snapshot)?;
    promote_refs(store, snapshot, plane, accepted)
}

fn write_capped_file(path: &Path, bytes: &[u8], maximum: usize) -> Result<(), SyncError> {
    if bytes.len() > maximum {
        return Err(limit("pack exceeds byte limit"));
    }
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(io)?;
    file.write_all(bytes).map_err(io)?;
    file.sync_all().map_err(io)
}

fn install_sanitized_artifacts(
    store: &GitStore,
    sanitized: &SanitizedPack,
    pack_dir: &Path,
) -> Result<(), SyncError> {
    #[cfg(not(any(unix, windows)))]
    return Err(io_message(
        "durable pack publication is unsupported on this platform",
    ));

    #[cfg(any(unix, windows))]
    {
        let destination_idx = pack_dir.join(format!("pack-{}.idx", sanitized.pack_hash));
        let destination_pack = pack_dir.join(format!("pack-{}.pack", sanitized.pack_hash));
        let staged_idx = stage_artifact(&sanitized.idx_path, &destination_idx)?;
        let staged_pack = match stage_artifact(&sanitized.pack_path, &destination_pack) {
            Ok(path) => path,
            Err(error) => {
                return finish_staged_artifact_cleanup(
                    Err(error),
                    [&staged_idx],
                    remove_temporary_if_present,
                );
            }
        };
        let result = publish_staged_pair_with_ops(
            &staged_idx,
            &destination_idx,
            &staged_pack,
            &destination_pack,
            publish_staged_no_replace,
            |directory| {
                store.check_pack_publication_barrier_for_test()?;
                publication_barrier(directory)
            },
            |path| {
                store.check_pack_artifact_removal_for_test(path)?;
                remove_published_artifact(path)
            },
        );
        finish_staged_artifact_cleanup(result, [&staged_idx, &staged_pack], |path| {
            remove_temporary_if_present(path)
        })
    }
}

fn finish_staged_artifact_cleanup<const N: usize>(
    result: Result<(), SyncError>,
    staged: [&Path; N],
    mut cleanup: impl FnMut(&Path) -> Result<(), SyncError>,
) -> Result<(), SyncError> {
    let cleanup_failures = staged
        .into_iter()
        .filter_map(|path| {
            cleanup(path)
                .err()
                .map(|error| format!("{}: {}", path.display(), error.message))
        })
        .collect::<Vec<_>>();
    match (result, cleanup_failures.is_empty()) {
        (Ok(()), _) => {
            // Staged names are not Git pack artifacts. Once the durable pair
            // is published, an orphan `.tmp` is safe to retry or reap later
            // and must not turn a successful publication into a false error.
            Ok(())
        }
        (Err(error), true) => Err(error),
        (Err(error), false) => Err(SyncError {
            code: SyncErrorCode::Io,
            message: format!(
                "{}; staging cleanup failed: {}",
                error.message,
                cleanup_failures.join("; ")
            ),
        }),
    }
}

fn stage_artifact(source: &Path, destination: &Path) -> Result<PathBuf, SyncError> {
    let temporary = destination.with_extension(format!(
        "{}.{}.tmp",
        destination
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("artifact"),
        QUARANTINE_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| -> Result<(), SyncError> {
        let mut input = File::open(source).map_err(io)?;
        let mut output = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(io)?;
        std::io::copy(&mut input, &mut output).map_err(io)?;
        output.sync_all().map_err(io)?;
        Ok(())
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    Ok(temporary)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Publication {
    Created,
    Existing,
}

#[cfg(test)]
fn publish_staged_pair_with(
    staged_idx: &Path,
    destination_idx: &Path,
    staged_pack: &Path,
    destination_pack: &Path,
    mut publish: impl FnMut(&Path, &Path) -> Result<Publication, SyncError>,
) -> Result<(), SyncError> {
    publish_staged_pair_with_ops(
        staged_idx,
        destination_idx,
        staged_pack,
        destination_pack,
        &mut publish,
        publication_barrier,
        remove_published_artifact,
    )
}

fn publish_staged_pair_with_ops(
    staged_idx: &Path,
    destination_idx: &Path,
    staged_pack: &Path,
    destination_pack: &Path,
    mut publish: impl FnMut(&Path, &Path) -> Result<Publication, SyncError>,
    mut barrier: impl FnMut(&Path) -> Result<(), SyncError>,
    mut remove: impl FnMut(&Path) -> Result<(), SyncError>,
) -> Result<(), SyncError> {
    let directory = destination_idx
        .parent()
        .ok_or_else(|| io_message("pack index destination has no parent directory"))?;
    if destination_pack.parent() != Some(directory) {
        return Err(io_message("pack artifacts must share one directory"));
    }
    let index_publication = publish(staged_idx, destination_idx)?;
    if let Err(error) = barrier(directory) {
        return Err(rollback_publications(
            error,
            &[(destination_idx, index_publication)],
            directory,
            &mut remove,
            &mut barrier,
        ));
    }
    let pack_publication = match publish(staged_pack, destination_pack) {
        Ok(publication) => publication,
        Err(error) => {
            return Err(rollback_publications(
                error,
                &[(destination_idx, index_publication)],
                directory,
                &mut remove,
                &mut barrier,
            ));
        }
    };
    if let Err(error) = barrier(directory) {
        return Err(rollback_publications(
            error,
            &[
                (destination_idx, index_publication),
                (destination_pack, pack_publication),
            ],
            directory,
            &mut remove,
            &mut barrier,
        ));
    }
    Ok(())
}

fn rollback_publications(
    cause: SyncError,
    publications: &[(&Path, Publication)],
    directory: &Path,
    remove: &mut impl FnMut(&Path) -> Result<(), SyncError>,
    barrier: &mut impl FnMut(&Path) -> Result<(), SyncError>,
) -> SyncError {
    let mut cleanup_failures = Vec::new();
    for (path, publication) in publications.iter().rev() {
        if *publication == Publication::Existing {
            // Publications are ordered index then pack. If the later artifact
            // is preexisting, it cannot be removed by this operation, so its
            // index must remain alongside it.
            break;
        }
        if let Err(error) = remove(path) {
            cleanup_failures.push(format!("remove {}: {}", path.display(), error.message));
            // Never continue from a failed pack removal to index removal: a
            // retained pair is safe, while a pack without its index is not.
            break;
        }
    }
    if let Err(error) = barrier(directory) {
        cleanup_failures.push(format!("publication cleanup barrier: {}", error.message));
    }
    if cleanup_failures.is_empty() {
        cause
    } else {
        SyncError {
            code: SyncErrorCode::Io,
            message: format!(
                "{}; publication rollback failed: {}",
                cause.message,
                cleanup_failures.join("; ")
            ),
        }
    }
}

#[cfg(not(windows))]
fn remove_published_artifact(path: &Path) -> Result<(), SyncError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(io(error)),
    }
}

#[cfg(windows)]
fn remove_published_artifact(path: &Path) -> Result<(), SyncError> {
    let rollback = path.with_extension(format!(
        "{}.{}.rollback.tmp",
        path.extension()
            .and_then(|value| value.to_str())
            .unwrap_or("artifact"),
        QUARANTINE_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    match rename_no_replace(path, &rollback) {
        Ok(()) => remove_temporary_if_present(&rollback),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(io(error)),
    }
}

fn publish_staged_no_replace(staged: &Path, destination: &Path) -> Result<Publication, SyncError> {
    #[cfg(windows)]
    return publish_staged_no_replace_with(staged, destination, |_, _| {
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "Windows publication requires write-through rename",
        ))
    });

    #[cfg(not(windows))]
    publish_staged_no_replace_with(staged, destination, |source, target| {
        fs::hard_link(source, target)
    })
}

fn publish_staged_no_replace_with(
    staged: &Path,
    destination: &Path,
    hard_link: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
) -> Result<Publication, SyncError> {
    publish_staged_no_replace_with_cleanup(staged, destination, hard_link, |path| {
        fs::remove_file(path)
    })
}

fn publish_staged_no_replace_with_cleanup(
    staged: &Path,
    destination: &Path,
    hard_link: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
    cleanup_staged: impl FnOnce(&Path) -> std::io::Result<()>,
) -> Result<Publication, SyncError> {
    if destination.exists() {
        return finish_existing_publication_with_cleanup(staged, destination, cleanup_staged);
    }
    match hard_link(staged, destination) {
        Ok(()) => {
            // The destination is already published. A failure to remove the
            // untrusted `.tmp` name must not erase that state transition and
            // cause callers to misclassify the destination as absent.
            let _ = cleanup_staged(staged);
            Ok(Publication::Created)
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            finish_existing_publication_with_cleanup(staged, destination, cleanup_staged)
        }
        Err(_) => match rename_no_replace(staged, destination) {
            Ok(()) => Ok(Publication::Created),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                finish_existing_publication(staged, destination)
            }
            Err(error) => Err(io(error)),
        },
    }
}

fn finish_existing_publication(
    staged: &Path,
    destination: &Path,
) -> Result<Publication, SyncError> {
    finish_existing_publication_with_cleanup(staged, destination, |path| fs::remove_file(path))
}

fn finish_existing_publication_with_cleanup(
    staged: &Path,
    destination: &Path,
    cleanup_staged: impl FnOnce(&Path) -> std::io::Result<()>,
) -> Result<Publication, SyncError> {
    if !files_equal(staged, destination)? {
        return Err(pack("content-addressed pack collision"));
    }
    let _ = cleanup_staged(staged);
    Ok(Publication::Existing)
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn rename_no_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::unix::ffi::OsStrExt;

    let source = std::ffi::CString::new(source.as_os_str().as_bytes()).map_err(|_| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "source path contains NUL")
    })?;
    let destination = std::ffi::CString::new(destination.as_os_str().as_bytes()).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "destination path contains NUL",
        )
    })?;
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            destination.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(target_vendor = "apple")]
fn rename_no_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::unix::ffi::OsStrExt;

    let source = std::ffi::CString::new(source.as_os_str().as_bytes()).map_err(|_| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "source path contains NUL")
    })?;
    let destination = std::ffi::CString::new(destination.as_os_str().as_bytes()).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "destination path contains NUL",
        )
    })?;
    let result =
        unsafe { libc::renamex_np(source.as_ptr(), destination.as_ptr(), libc::RENAME_EXCL) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(windows)]
fn rename_no_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_WRITE_THROUGH,
        )
    };
    if result != 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(all(
    unix,
    not(any(target_os = "linux", target_os = "android", target_vendor = "apple"))
))]
fn rename_no_replace(_: &Path, _: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "atomic no-replace rename is unsupported on this Unix platform",
    ))
}

#[cfg(not(any(unix, windows)))]
fn rename_no_replace(_: &Path, _: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "durable pack publication is unsupported on this platform",
    ))
}

#[cfg(unix)]
fn publication_barrier(path: &Path) -> Result<(), SyncError> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(io)
}

#[cfg(windows)]
fn publication_barrier(path: &Path) -> Result<(), SyncError> {
    // `rename_no_replace` uses `MoveFileExW(MOVEFILE_WRITE_THROUGH)` for each
    // publication; checking the directory here keeps ordering/error handling
    // symmetric without pretending that Rust can fsync a Windows directory.
    fs::metadata(path).map_err(io).map(|_| ())
}

#[cfg(not(any(unix, windows)))]
fn publication_barrier(_: &Path) -> Result<(), SyncError> {
    Err(io_message(
        "durable pack publication is unsupported on this platform",
    ))
}

fn remove_temporary_if_present(path: &Path) -> Result<(), SyncError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(io(error)),
    }
}

fn files_equal(left: &Path, right: &Path) -> Result<bool, SyncError> {
    if fs::metadata(left).map_err(io)?.len() != fs::metadata(right).map_err(io)?.len() {
        return Ok(false);
    }
    let mut left = File::open(left).map_err(io)?;
    let mut right = File::open(right).map_err(io)?;
    let mut left_buffer = [0_u8; 8192];
    let mut right_buffer = [0_u8; 8192];
    loop {
        let left_read = left.read(&mut left_buffer).map_err(io)?;
        let right_read = right.read(&mut right_buffer).map_err(io)?;
        if left_read != right_read || left_buffer[..left_read] != right_buffer[..right_read] {
            return Ok(false);
        }
        if left_read == 0 {
            return Ok(true);
        }
    }
}

fn checked_usize_add(value: usize, increment: usize, message: &str) -> Result<usize, SyncError> {
    value.checked_add(increment).ok_or_else(|| limit(message))
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

struct ReachableHeadsValidation<'a, P: ProjectPolicy> {
    git: &'a crate::git_command::GitCommand,
    repo: &'a Path,
    plane: Plane,
    candidates: &'a [GitOid],
    atom_limits: &'a AtomLimits,
    limits: &'a PackLimits,
    policy: &'a P,
    validation: &'a mut ValidationContext,
    expected_project_id: ProjectId,
    trusted_control: &'a RefAdvertisement,
    candidate_refs: &'a [Candidate],
    memo: &'a mut ImportMemo<P::State>,
}

struct CandidateOwnershipValidation<'a, S> {
    git: &'a crate::git_command::GitCommand,
    repo: &'a Path,
    plane: Plane,
    atom_limits: &'a AtomLimits,
    expected_project_id: ProjectId,
    trusted_immutable: &'a BTreeMap<String, GitOid>,
    walks: &'a [DeviceWalk],
    memo: &'a mut ImportMemo<S>,
}

struct ControlReplayValidation<'a, P: ProjectPolicy> {
    git: &'a crate::git_command::GitCommand,
    repo: &'a Path,
    candidate_heads: &'a [GitOid],
    trusted_heads: &'a [GitOid],
    limits: &'a AtomLimits,
    expected_project_id: ProjectId,
    policy: &'a P,
    memo: &'a mut ImportMemo<P::State>,
}

struct ImportMemo<S> {
    control_states: BTreeMap<Vec<GitOid>, S>,
    traversals: BTreeMap<TraversalKey, Vec<CommitParents>>,
    trees: BTreeMap<(u8, GitOid), Vec<(String, GitOid)>>,
    blobs: BTreeMap<GitOid, Vec<u8>>,
}

impl<S> ImportMemo<S> {
    fn new() -> Self {
        Self {
            control_states: BTreeMap::new(),
            traversals: BTreeMap::new(),
            trees: BTreeMap::new(),
            blobs: BTreeMap::new(),
        }
    }

    fn reachable(
        &mut self,
        git: &crate::git_command::GitCommand,
        repo: &Path,
        candidates: &[GitOid],
        boundary: &[GitOid],
    ) -> Result<Vec<CommitParents>, SyncError> {
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
        repo: &Path,
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

    fn blobs<'a>(
        &mut self,
        git: &crate::git_command::GitCommand,
        repo: &Path,
        oids: impl IntoIterator<Item = &'a GitOid>,
        limits: &AtomLimits,
    ) -> Result<&BTreeMap<GitOid, Vec<u8>>, SyncError> {
        let missing = oids
            .into_iter()
            .filter(|oid| !self.blobs.contains_key(*oid))
            .cloned()
            .collect::<BTreeSet<_>>();
        if !missing.is_empty() {
            self.blobs
                .extend(read_blobs_at(git, repo, missing.iter(), limits)?);
        }
        Ok(&self.blobs)
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
        repo: &Path,
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
    repo: &Path,
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
    repo: &Path,
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
    request: ReachableHeadsValidation<'_, P>,
) -> Result<(), ValidationFailure> {
    let ReachableHeadsValidation {
        git,
        repo,
        plane,
        candidates,
        atom_limits,
        limits,
        policy,
        validation,
        expected_project_id,
        trusted_control,
        candidate_refs,
        memo,
    } = request;
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
    let ownership =
        candidate_commit_owners(git, repo, candidate_refs, &validation.ownership_boundary)
            .map_err(|error| ValidationFailure {
                commit: None,
                rollback_commits: vec![],
                error,
            })?;
    validate_candidate_ownership(CandidateOwnershipValidation {
        git,
        repo,
        plane,
        atom_limits,
        expected_project_id,
        trusted_immutable: &validation.immutable,
        walks: &ownership.walks,
        memo,
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
            let introduced_blobs = memo.blobs(
                git,
                repo,
                introduced_entries.iter().map(|(_, blob)| blob),
                atom_limits,
            )?;
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
                if !ownership.owners.get(&commit).is_some_and(|devices| {
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
        validate_global_control_replay(ControlReplayValidation {
            git,
            repo,
            candidate_heads: candidates,
            trusted_heads: &validation.boundary,
            limits: atom_limits,
            expected_project_id,
            policy,
            memo,
        })?;
    }
    Ok(())
}

struct CandidateOwnership {
    owners: BTreeMap<GitOid, BTreeSet<DeviceId>>,
    walks: Vec<DeviceWalk>,
}

fn candidate_commit_owners(
    git: &crate::git_command::GitCommand,
    repo: &Path,
    candidates: &[Candidate],
    trusted_boundary: &[GitOid],
) -> Result<CandidateOwnership, SyncError> {
    let mut owners: BTreeMap<GitOid, BTreeSet<DeviceId>> = BTreeMap::new();
    let mut walks = Vec::new();
    for candidate in candidates {
        let Some(head) = candidate.current.as_ref() else {
            continue;
        };
        if candidate.current.as_ref() == candidate.previous.as_ref() {
            continue;
        }
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
        let mut walk = Vec::new();
        for (index, (commit, parents)) in
            first_parent_segment(git, repo, candidate.previous.as_ref(), head)?
                .into_iter()
                .enumerate()
        {
            // The advertised head is always the candidate's own assertion. For
            // older first-parent history, stop once another trusted/advertised
            // device head already provides the authorship boundary.
            if index > 0 && exact_boundaries.contains(&commit) {
                break;
            }
            owners
                .entry(commit.clone())
                .or_default()
                .insert(candidate.device);
            walk.push((commit, parents));
        }
        walks.push((candidate.device, walk));
    }
    Ok(CandidateOwnership { owners, walks })
}

fn validate_candidate_ownership<S>(
    request: CandidateOwnershipValidation<'_, S>,
) -> Result<(), ValidationFailure> {
    let CandidateOwnershipValidation {
        git,
        repo,
        plane,
        atom_limits,
        expected_project_id,
        trusted_immutable,
        walks,
        memo,
    } = request;
    for (device, commits) in walks {
        for (index, (commit, parents)) in commits.iter().enumerate() {
            let result = (|| {
                let entries = memo.tree(git, repo, commit, plane)?;
                let parent_trees = parents
                    .iter()
                    .map(|parent| {
                        memo.tree(git, repo, parent, plane)
                            .map(|entries| entries.into_iter().collect::<BTreeMap<_, _>>())
                    })
                    .collect::<Result<Vec<_>, SyncError>>()?;
                let introduced = entries
                    .into_iter()
                    .filter(|(path, blob)| {
                        path.starts_with(crate::git_store::atom_prefix(plane))
                            && !parent_trees
                                .iter()
                                .any(|parent| parent.get(path) == Some(blob))
                            && (index == 0 || trusted_immutable.get(path) != Some(blob))
                    })
                    .collect::<Vec<_>>();
                let blobs = memo.blobs(
                    git,
                    repo,
                    introduced.iter().map(|(_, blob)| blob),
                    atom_limits,
                )?;
                for (path, blob) in introduced {
                    let atom = crate::SignedAtom::decode(
                        blobs
                            .get(&blob)
                            .expect("requested ownership blob was returned"),
                        atom_limits,
                    )?;
                    if atom.unsigned.plane != plane || atom.repo_path() != path {
                        return Err(invalid("atom path does not match atom"));
                    }
                    if atom.unsigned.project_id != expected_project_id {
                        return Err(invalid("atom belongs to a different project"));
                    }
                    if atom.unsigned.actor_device_id != *device {
                        return Err(invalid("candidate device does not own authored atom"));
                    }
                }
                Ok(())
            })();
            result.map_err(|error| ValidationFailure {
                commit: Some(commit.clone()),
                rollback_commits: vec![commit.clone()],
                error,
            })?;
        }
    }
    Ok(())
}

fn validate_global_control_replay<P: ProjectPolicy>(
    request: ControlReplayValidation<'_, P>,
) -> Result<(), ValidationFailure> {
    let ControlReplayValidation {
        git,
        repo,
        candidate_heads,
        trusted_heads,
        limits,
        expected_project_id,
        policy,
        memo,
    } = request;
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
    repo: &Path,
    previous: Option<&GitOid>,
    head: &GitOid,
) -> Result<Vec<CommitParents>, SyncError> {
    let range = previous.map_or_else(
        || head.as_str().to_owned(),
        |previous| format!("{}..{}", previous.as_str(), head.as_str()),
    );
    text(git.run_at(
        repo,
        &[
            "rev-list".into(),
            "--parents".into(),
            "--first-parent".into(),
            range.into(),
        ],
        None,
    )?)
    .lines()
    .map(|line| {
        let mut fields = line.split_whitespace();
        let commit = GitOid::parse(fields.next().ok_or_else(|| invalid("missing commit OID"))?)?;
        let parents = fields.map(GitOid::parse).collect::<Result<Vec<_>, _>>()?;
        Ok((commit, parents))
    })
    .collect()
}

fn reduced_frontier(
    git: &crate::git_command::GitCommand,
    repo: &Path,
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
    repo: &Path,
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
    repo: &Path,
    frontier: &[GitOid],
    trusted: &RefAdvertisement,
) -> Result<(), SyncError> {
    for head in frontier {
        if !object_is_commit(git, repo, head)? {
            return Err(invalid("declared control frontier is not a commit cut"));
        }
    }
    let reduced = reduced_frontier(git, repo, frontier.iter().cloned())?;
    if reduced != frontier {
        return Err(invalid("declared control frontier is not reduced"));
    }
    for head in frontier {
        let reachable = trusted
            .refs
            .values()
            .map(|trusted_head| is_ancestor_at(git, repo, head, trusted_head))
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .any(|reachable| reachable);
        if !reachable {
            return Err(invalid("declared control frontier is not trusted"));
        }
    }
    Ok(())
}

fn object_is_commit(git: &GitCommand, repo: &Path, object: &GitOid) -> Result<bool, SyncError> {
    let expression = format!("{}^{{commit}}", object.as_str());
    let mut input = expression.as_bytes().to_vec();
    input.push(b'\n');
    let output = git.run_at(
        repo,
        &["cat-file".into(), "--batch-check".into()],
        Some(&input),
    )?;
    let line = std::str::from_utf8(output.strip_suffix(b"\n").unwrap_or(&output))
        .map_err(|_| pack("cat-file returned non-UTF-8 object metadata"))?;
    if line == format!("{expression} missing") {
        return Ok(false);
    }
    let mut fields = line.split_whitespace();
    let returned = fields
        .next()
        .ok_or_else(|| pack("cat-file omitted commit object"))?;
    let kind = fields
        .next()
        .ok_or_else(|| pack("cat-file omitted commit type"))?;
    let _size = fields
        .next()
        .ok_or_else(|| pack("cat-file omitted commit size"))?
        .parse::<usize>()
        .map_err(|_| pack("cat-file returned invalid commit size"))?;
    if fields.next().is_some()
        || GitOid::parse(returned).is_err()
        || kind != "commit"
        || returned != object.as_str()
    {
        return Err(pack("cat-file returned invalid commit metadata"));
    }
    Ok(true)
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
    repo: &Path,
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
    let blobs = memo.blobs(
        git,
        repo,
        introduced_paths.values().map(|(blob, _)| blob),
        limits,
    )?;
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

fn reachable_commits(
    git: &crate::git_command::GitCommand,
    repo: &Path,
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
    repo: &Path,
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
    repo: &Path,
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

fn tree_budget_counts(
    git: &GitCommand,
    repo: &Path,
    head: &GitOid,
    plane: Plane,
) -> Result<(usize, usize), SyncError> {
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
    let atom_prefix = crate::git_store::atom_prefix(plane);
    let atom_prefix = atom_prefix.as_bytes();
    let mut files = 0_usize;
    let mut atoms = 0_usize;
    for entry in output
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty())
    {
        let separator = entry
            .iter()
            .position(|byte| *byte == b'\t')
            .ok_or_else(|| invalid("invalid tree entry"))?;
        let metadata = std::str::from_utf8(&entry[..separator])
            .map_err(|_| invalid("invalid tree metadata"))?;
        let mut fields = metadata.split_whitespace();
        let _mode = fields.next().ok_or_else(|| invalid("missing tree mode"))?;
        let kind = fields.next().ok_or_else(|| invalid("missing tree type"))?;
        if kind != "blob" {
            continue;
        }
        files = checked_usize_add(files, 1, "tree entry count overflow")?;
        let path = &entry[separator + 1..];
        if path.starts_with(atom_prefix) {
            atoms = checked_usize_add(atoms, 1, "atom count overflow")?;
        }
    }
    Ok((files, atoms))
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

        let ownership = candidate_commit_owners(&git, repo.path(), &candidates, &[]).unwrap();

        assert_eq!(
            ownership.owners.get(&first_head),
            Some(&BTreeSet::from([first_device]))
        );
        assert!(
            !ownership
                .owners
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
    fn only_candidate_semantic_failures_are_prefix_rollback_eligible() {
        for code in [
            SyncErrorCode::InvalidId,
            SyncErrorCode::InvalidAtom,
            SyncErrorCode::InvalidSignature,
            SyncErrorCode::UnsupportedSchema,
            SyncErrorCode::PolicyRejected,
            SyncErrorCode::AccessRevoked,
        ] {
            assert!(is_candidate_semantic_error(code), "{code:?}");
        }
        for code in [
            SyncErrorCode::GitUnavailable,
            SyncErrorCode::GitCommandFailed,
            SyncErrorCode::RefRewind,
            SyncErrorCode::PackRejected,
            SyncErrorCode::LimitExceeded,
            SyncErrorCode::Io,
        ] {
            assert!(!is_candidate_semantic_error(code), "{code:?}");
        }
    }

    #[test]
    fn hard_link_unavailable_falls_back_to_no_replace_rename() {
        let directory = tempfile::tempdir().unwrap();
        let staged = directory.path().join("pack.tmp");
        let destination = directory.path().join("pack-final.pack");
        fs::write(&staged, b"accepted-pack").unwrap();

        let publication = publish_staged_no_replace_with(&staged, &destination, |_, _| {
            Err(std::io::Error::new(
                std::io::ErrorKind::Unsupported,
                "injected hard-link refusal",
            ))
        })
        .unwrap();

        assert_eq!(publication, Publication::Created);
        assert_eq!(fs::read(&destination).unwrap(), b"accepted-pack");
        assert!(!staged.exists());
    }

    #[test]
    fn hard_link_success_survives_pack_staging_cleanup_failure() {
        let directory = tempfile::tempdir().unwrap();
        let staged_idx = directory.path().join("idx.tmp");
        let staged_pack = directory.path().join("pack.tmp");
        let destination_idx = directory.path().join("pack-final.idx");
        let destination_pack = directory.path().join("pack-final.pack");
        fs::write(&staged_idx, b"index").unwrap();
        fs::write(&staged_pack, b"pack").unwrap();
        fs::write(&destination_idx, b"index").unwrap();

        publish_staged_pair_with_ops(
            &staged_idx,
            &destination_idx,
            &staged_pack,
            &destination_pack,
            |staged, destination| {
                if destination == destination_pack {
                    publish_staged_no_replace_with_cleanup(
                        staged,
                        destination,
                        |source, target| fs::hard_link(source, target),
                        |_| Err(std::io::Error::other("injected staged pack unlink failure")),
                    )
                } else {
                    publish_staged_no_replace(staged, destination)
                }
            },
            |_| Ok(()),
            |path| fs::remove_file(path).map_err(io),
        )
        .unwrap();

        assert_eq!(fs::read(&destination_idx).unwrap(), b"index");
        assert_eq!(fs::read(&destination_pack).unwrap(), b"pack");
        assert!(staged_pack.exists(), "failed cleanup remains retryable");
    }

    #[test]
    fn second_artifact_publish_failure_removes_only_the_new_index() {
        let directory = tempfile::tempdir().unwrap();
        let staged_idx = directory.path().join("idx.tmp");
        let staged_pack = directory.path().join("pack.tmp");
        let destination_idx = directory.path().join("pack-final.idx");
        let destination_pack = directory.path().join("pack-final.pack");
        fs::write(&staged_idx, b"index").unwrap();
        fs::write(&staged_pack, b"pack").unwrap();
        let mut calls = 0;

        let error = publish_staged_pair_with(
            &staged_idx,
            &destination_idx,
            &staged_pack,
            &destination_pack,
            |staged, destination| {
                calls += 1;
                if calls == 2 {
                    Err(io_message("injected pack publication failure"))
                } else {
                    publish_staged_no_replace(staged, destination)
                }
            },
        )
        .unwrap_err();

        assert_eq!(error.code, SyncErrorCode::Io);
        assert!(!destination_idx.exists());
        assert!(!destination_pack.exists());
    }

    #[test]
    fn second_artifact_failure_never_removes_a_preexisting_identical_index() {
        let directory = tempfile::tempdir().unwrap();
        let staged_idx = directory.path().join("idx.tmp");
        let staged_pack = directory.path().join("pack.tmp");
        let destination_idx = directory.path().join("pack-final.idx");
        let destination_pack = directory.path().join("pack-final.pack");
        fs::write(&staged_idx, b"index").unwrap();
        fs::write(&staged_pack, b"pack").unwrap();
        fs::write(&destination_idx, b"index").unwrap();
        let mut calls = 0;

        publish_staged_pair_with(
            &staged_idx,
            &destination_idx,
            &staged_pack,
            &destination_pack,
            |staged, destination| {
                calls += 1;
                if calls == 2 {
                    Err(io_message("injected pack publication failure"))
                } else {
                    publish_staged_no_replace(staged, destination)
                }
            },
        )
        .unwrap_err();

        assert_eq!(fs::read(&destination_idx).unwrap(), b"index");
        assert!(!destination_pack.exists());
    }

    #[test]
    fn final_barrier_failure_rolls_back_only_new_artifacts() {
        let directory = tempfile::tempdir().unwrap();
        let staged_idx = directory.path().join("idx.tmp");
        let staged_pack = directory.path().join("pack.tmp");
        let destination_idx = directory.path().join("pack-final.idx");
        let destination_pack = directory.path().join("pack-final.pack");
        fs::write(&staged_idx, b"index").unwrap();
        fs::write(&staged_pack, b"pack").unwrap();
        fs::write(&destination_idx, b"index").unwrap();
        let mut barrier_calls = 0;

        let error = publish_staged_pair_with_ops(
            &staged_idx,
            &destination_idx,
            &staged_pack,
            &destination_pack,
            publish_staged_no_replace,
            |_| {
                barrier_calls += 1;
                if barrier_calls == 2 {
                    Err(io_message("injected final publication barrier failure"))
                } else {
                    Ok(())
                }
            },
            |path| fs::remove_file(path).map_err(io),
        )
        .unwrap_err();

        assert_eq!(error.code, SyncErrorCode::Io);
        assert_eq!(fs::read(&destination_idx).unwrap(), b"index");
        assert!(!destination_pack.exists());
        let mut entries = fs::read_dir(directory.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>();
        entries.sort();
        assert_eq!(
            entries,
            vec![destination_idx.file_name().unwrap().to_owned()]
        );
    }

    #[test]
    fn final_barrier_and_pack_removal_failure_never_leave_pack_only() {
        let directory = tempfile::tempdir().unwrap();
        let staged_idx = directory.path().join("idx.tmp");
        let staged_pack = directory.path().join("pack.tmp");
        let destination_idx = directory.path().join("pack-final.idx");
        let destination_pack = directory.path().join("pack-final.pack");
        fs::write(&staged_idx, b"index").unwrap();
        fs::write(&staged_pack, b"pack").unwrap();
        let mut barrier_calls = 0;

        let error = publish_staged_pair_with_ops(
            &staged_idx,
            &destination_idx,
            &staged_pack,
            &destination_pack,
            publish_staged_no_replace,
            |_| {
                barrier_calls += 1;
                match barrier_calls {
                    2 => Err(io_message("injected final publication barrier failure")),
                    3 => Err(io_message("injected cleanup barrier failure")),
                    _ => Ok(()),
                }
            },
            |path| {
                if path == destination_pack {
                    Err(io_message("injected pack removal failure"))
                } else {
                    fs::remove_file(path).map_err(io)
                }
            },
        )
        .unwrap_err();

        assert_eq!(error.code, SyncErrorCode::Io);
        assert!(error
            .message
            .contains("injected final publication barrier failure"));
        assert!(error.message.contains("injected pack removal failure"));
        assert!(error.message.contains("injected cleanup barrier failure"));
        assert_eq!(
            barrier_calls, 3,
            "rollback must attempt its durability barrier"
        );
        assert!(
            destination_idx.exists(),
            "the index must remain if the pack could not be removed"
        );
        assert!(destination_pack.exists());
    }

    #[test]
    fn final_barrier_and_pack_removal_failure_preserve_preexisting_index() {
        let directory = tempfile::tempdir().unwrap();
        let staged_idx = directory.path().join("idx.tmp");
        let staged_pack = directory.path().join("pack.tmp");
        let destination_idx = directory.path().join("pack-final.idx");
        let destination_pack = directory.path().join("pack-final.pack");
        fs::write(&staged_idx, b"index").unwrap();
        fs::write(&staged_pack, b"pack").unwrap();
        fs::write(&destination_idx, b"index").unwrap();
        let mut barrier_calls = 0;

        let error = publish_staged_pair_with_ops(
            &staged_idx,
            &destination_idx,
            &staged_pack,
            &destination_pack,
            publish_staged_no_replace,
            |_| {
                barrier_calls += 1;
                if barrier_calls == 2 {
                    Err(io_message("injected final publication barrier failure"))
                } else {
                    Ok(())
                }
            },
            |path| {
                if path == destination_pack {
                    Err(io_message("injected pack removal failure"))
                } else {
                    fs::remove_file(path).map_err(io)
                }
            },
        )
        .unwrap_err();

        assert!(error.message.contains("injected pack removal failure"));
        assert_eq!(fs::read(&destination_idx).unwrap(), b"index");
        assert_eq!(fs::read(&destination_pack).unwrap(), b"pack");
    }

    #[test]
    fn successful_publication_is_not_reclassified_by_staging_cleanup_failure() {
        let directory = tempfile::tempdir().unwrap();
        let staged_idx = directory.path().join("idx.tmp");
        let staged_pack = directory.path().join("pack.tmp");
        fs::write(&staged_idx, b"index").unwrap();
        fs::write(&staged_pack, b"pack").unwrap();

        finish_staged_artifact_cleanup(Ok(()), [&staged_idx, &staged_pack], |path| {
            if path == staged_pack {
                Err(io_message("injected persistent staging cleanup failure"))
            } else {
                remove_temporary_if_present(path)
            }
        })
        .unwrap();

        assert!(!staged_idx.exists());
        assert!(staged_pack.exists());
    }

    #[test]
    fn failed_publication_reports_staging_cleanup_failure() {
        let directory = tempfile::tempdir().unwrap();
        let staged_idx = directory.path().join("idx.tmp");
        let staged_pack = directory.path().join("pack.tmp");
        fs::write(&staged_idx, b"index").unwrap();
        fs::write(&staged_pack, b"pack").unwrap();

        let error = finish_staged_artifact_cleanup(
            Err(io_message("injected publication failure")),
            [&staged_idx, &staged_pack],
            |path| {
                if path == staged_pack {
                    Err(io_message("injected persistent staging cleanup failure"))
                } else {
                    remove_temporary_if_present(path)
                }
            },
        )
        .unwrap_err();

        assert_eq!(error.code, SyncErrorCode::Io);
        assert!(error.message.contains("injected publication failure"));
        assert!(error
            .message
            .contains("injected persistent staging cleanup failure"));
    }

    #[test]
    fn failed_second_staging_reports_first_staging_cleanup_failure() {
        let directory = tempfile::tempdir().unwrap();
        let staged_idx = directory.path().join("idx.tmp");
        fs::write(&staged_idx, b"index").unwrap();

        let error = finish_staged_artifact_cleanup(
            Err(io_message("injected pack staging failure")),
            [&staged_idx],
            |_| Err(io_message("injected index staging cleanup failure")),
        )
        .unwrap_err();

        assert_eq!(error.code, SyncErrorCode::Io);
        assert!(error.message.contains("injected pack staging failure"));
        assert!(error
            .message
            .contains("injected index staging cleanup failure"));
    }

    #[test]
    fn final_barrier_failure_preserves_preexisting_pack_and_keeps_its_new_index() {
        let directory = tempfile::tempdir().unwrap();
        let staged_idx = directory.path().join("idx.tmp");
        let staged_pack = directory.path().join("pack.tmp");
        let destination_idx = directory.path().join("pack-final.idx");
        let destination_pack = directory.path().join("pack-final.pack");
        fs::write(&staged_idx, b"index").unwrap();
        fs::write(&staged_pack, b"pack").unwrap();
        fs::write(&destination_pack, b"pack").unwrap();
        let mut barrier_calls = 0;

        publish_staged_pair_with_ops(
            &staged_idx,
            &destination_idx,
            &staged_pack,
            &destination_pack,
            publish_staged_no_replace,
            |_| {
                barrier_calls += 1;
                if barrier_calls == 2 {
                    Err(io_message("injected final publication barrier failure"))
                } else {
                    Ok(())
                }
            },
            |path| fs::remove_file(path).map_err(io),
        )
        .unwrap_err();

        assert_eq!(fs::read(&destination_idx).unwrap(), b"index");
        assert_eq!(fs::read(&destination_pack).unwrap(), b"pack");
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

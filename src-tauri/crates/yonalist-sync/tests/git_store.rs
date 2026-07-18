use std::{env, ffi::OsStr, path::PathBuf, process::Command};

use yonalist_sync::{
    AtomLimits, DeviceId, DeviceSigner, EventId, GitOid, GitStore, ImmutableFile, MemberId, Plane,
    ProjectId, StoreBatch, SyncErrorCode, UnsignedAtom, ATOM_SCHEMA_V1,
};

fn test_git_executable() -> PathBuf {
    env::var_os("YONALIST_TEST_GIT")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("git"))
}

fn test_limits() -> AtomLimits {
    AtomLimits {
        max_payload_bytes: 1024,
        max_frontier_heads: 8,
    }
}

fn signed_fixture(plane: Plane, event_id: EventId) -> yonalist_sync::SignedAtom {
    signed_fixture_for(plane, event_id, DeviceId::from_bytes([3; 16]), 9)
}

fn signed_fixture_for(
    plane: Plane,
    event_id: EventId,
    device_id: DeviceId,
    secret: u8,
) -> yonalist_sync::SignedAtom {
    DeviceSigner::from_secret_bytes([secret; 32])
        .sign(UnsignedAtom {
            schema: ATOM_SCHEMA_V1,
            project_id: ProjectId::from_bytes([1; 16]),
            event_id,
            plane,
            actor_member_id: MemberId::from_bytes([2; 16]),
            actor_device_id: device_id,
            membership_grant_id: yonalist_sync::GrantId::from_bytes([4; 16]),
            control_frontier: vec![],
            data_frontier: vec![],
            display_time_ms: 0,
            payload: b"issue.created".to_vec(),
        })
        .unwrap()
}

fn git(repo: &OsStr, args: &[&str], stdin: Option<&[u8]>) -> Vec<u8> {
    use std::io::Write;

    let mut command = Command::new(test_git_executable());
    command.arg(format!("--git-dir={}", PathBuf::from(repo).display()));
    command.env("GIT_AUTHOR_NAME", "Test");
    command.env("GIT_AUTHOR_EMAIL", "test@example.invalid");
    command.env("GIT_COMMITTER_NAME", "Test");
    command.env("GIT_COMMITTER_EMAIL", "test@example.invalid");
    command.args(args);
    if stdin.is_some() {
        command.stdin(std::process::Stdio::piped());
    }
    let mut child = command
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    if let Some(bytes) = stdin {
        child.stdin.as_mut().unwrap().write_all(bytes).unwrap();
    }
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success(), "git {:?} failed", args);
    output.stdout
}

fn raw_root_commit(repo: &OsStr, path: &str, bytes: &[u8]) -> GitOid {
    let blob = String::from_utf8(git(repo, &["hash-object", "-w", "--stdin"], Some(bytes)))
        .unwrap()
        .trim()
        .to_owned();
    let input = format!("100644 {blob}\t{path}\n");
    let index = PathBuf::from(repo).join(format!("test-index-{}", std::process::id()));
    let output = Command::new(test_git_executable())
        .arg(format!("--git-dir={}", PathBuf::from(repo).display()))
        .env("GIT_INDEX_FILE", &index)
        .args(["update-index", "--index-info"])
        .stdin(std::process::Stdio::piped())
        .spawn()
        .and_then(|mut child| {
            use std::io::Write;
            child.stdin.as_mut().unwrap().write_all(input.as_bytes())?;
            child.wait()
        })
        .unwrap();
    assert!(output.success());
    let tree = String::from_utf8(
        Command::new(test_git_executable())
            .arg(format!("--git-dir={}", PathBuf::from(repo).display()))
            .env("GIT_INDEX_FILE", &index)
            .arg("write-tree")
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap();
    let _ = std::fs::remove_file(index);
    let commit = git(repo, &["commit-tree", tree.trim()], Some(b"test\n"));
    GitOid::parse(String::from_utf8(commit).unwrap().trim()).unwrap()
}

fn batch_for(atom: yonalist_sync::SignedAtom) -> StoreBatch {
    StoreBatch {
        plane: atom.unsigned.plane,
        device_id: atom.unsigned.actor_device_id,
        expected_head: None,
        atoms: vec![atom],
        auxiliary_files: vec![],
        observed_heads: vec![],
    }
}

fn batch_with_expected(
    device: DeviceId,
    expected_head: Option<yonalist_sync::GitOid>,
    event: EventId,
) -> StoreBatch {
    let atom = signed_fixture(Plane::Data, event);
    StoreBatch {
        device_id: device,
        expected_head,
        ..batch_for(atom)
    }
}

fn store_with_one_data_commit() -> (GitStore, DeviceId, yonalist_sync::LocalCommit) {
    let repo = tempfile::tempdir().unwrap().keep();
    let store = GitStore::init(&repo, &test_git_executable()).unwrap();
    let fixture = signed_fixture(Plane::Data, EventId::from_bytes([3; 16]));
    let device = fixture.unsigned.actor_device_id;
    let first = store.append_local(batch_for(fixture)).unwrap();
    (store, device, first)
}

#[test]
fn local_append_is_durable_at_the_device_ref() {
    let temp = tempfile::tempdir().unwrap();
    let git = test_git_executable();
    let store = GitStore::init(temp.path(), &git).unwrap();
    let fixture = signed_fixture(Plane::Data, EventId::from_bytes([3; 16]));
    let commit = store.append_local(batch_for(fixture.clone())).unwrap();
    assert_eq!(
        store
            .head(Plane::Data, fixture.unsigned.actor_device_id)
            .unwrap(),
        Some(commit.head.clone())
    );
    drop(store);

    let reopened = GitStore::open(temp.path(), &git).unwrap();
    let atoms = reopened.stored_atoms(Plane::Data, &test_limits()).unwrap();
    assert_eq!(atoms.len(), 1);
    assert_eq!(atoms[0].atom.unsigned.event_id, fixture.unsigned.event_id);
}

#[test]
fn stale_compare_and_swap_does_not_move_the_ref() {
    let (store, device, first) = store_with_one_data_commit();
    let second = store
        .append_local(batch_with_expected(
            device,
            Some(first.head.clone()),
            EventId::from_bytes([4; 16]),
        ))
        .unwrap();
    let error = store
        .append_local(batch_with_expected(
            device,
            Some(first.head),
            EventId::from_bytes([5; 16]),
        ))
        .unwrap_err();
    assert_eq!(error.code, SyncErrorCode::RefRewind);
    assert_eq!(store.head(Plane::Data, device).unwrap(), Some(second.head));
}

#[test]
fn initialized_store_is_bare_sha256_and_advertises_the_plane_ref() {
    let temp = tempfile::tempdir().unwrap();
    let git = test_git_executable();
    let store = GitStore::init(temp.path(), &git).unwrap();
    let atom = signed_fixture(Plane::Data, EventId::from_bytes([6; 16]));
    let device = atom.unsigned.actor_device_id;
    store.append_local(batch_for(atom)).unwrap();
    assert_eq!(store.advertise(Plane::Data).unwrap().refs.len(), 1);
    assert!(std::fs::read_to_string(temp.path().join("config"))
        .unwrap()
        .contains("objectformat = sha256"));
    assert_eq!(
        store.advertise(Plane::Data).unwrap().refs.get(&device),
        store.head(Plane::Data, device).unwrap().as_ref()
    );
}

#[test]
fn stored_atoms_unions_all_advertised_heads_and_attributes_first_introduction() {
    let temp = tempfile::tempdir().unwrap();
    let store = GitStore::init(temp.path(), &test_git_executable()).unwrap();
    let device_a = DeviceId::from_bytes([3; 16]);
    let device_b = DeviceId::from_bytes([7; 16]);
    let atom_a = signed_fixture_for(Plane::Data, EventId::from_bytes([10; 16]), device_a, 9);
    let atom_b = signed_fixture_for(Plane::Data, EventId::from_bytes([11; 16]), device_a, 9);
    let atom_c = signed_fixture_for(Plane::Data, EventId::from_bytes([22; 16]), device_b, 8);
    let first = store.append_local(batch_for(atom_a.clone())).unwrap();
    let mut second_batch = batch_for(atom_b.clone());
    second_batch.expected_head = Some(first.head.clone());
    let second = store.append_local(second_batch).unwrap();
    let third = store.append_local(batch_for(atom_c.clone())).unwrap();

    let atoms = store.stored_atoms(Plane::Data, &test_limits()).unwrap();
    assert_eq!(atoms.len(), 3);
    let by_event = atoms
        .into_iter()
        .map(|stored| (stored.atom.unsigned.event_id, stored.containing_commit))
        .collect::<std::collections::BTreeMap<_, _>>();
    assert_eq!(by_event.get(&atom_a.unsigned.event_id), Some(&first.head));
    assert_eq!(by_event.get(&atom_b.unsigned.event_id), Some(&second.head));
    assert_eq!(by_event.get(&atom_c.unsigned.event_id), Some(&third.head));
}

#[test]
fn stored_atoms_rejects_conflicting_immutable_paths_across_heads() {
    let temp = tempfile::tempdir().unwrap();
    let store = GitStore::init(temp.path(), &test_git_executable()).unwrap();
    let atom = signed_fixture(Plane::Data, EventId::from_bytes([12; 16]));
    let first = store.append_local(batch_for(atom.clone())).unwrap();
    let conflicting = raw_root_commit(temp.path().as_os_str(), &atom.repo_path(), b"different");
    let other = DeviceId::from_bytes([8; 16]);
    git(
        temp.path().as_os_str(),
        &[
            "update-ref",
            &format!("refs/yonalist/data/{other}"),
            conflicting.as_str(),
        ],
        None,
    );

    let error = match store.stored_atoms(Plane::Data, &test_limits()) {
        Ok(_) => panic!("conflicting immutable path was accepted"),
        Err(error) => error,
    };
    assert_eq!(error.code, SyncErrorCode::InvalidAtom);
    assert!(error.message.contains("conflicting"));
    assert_eq!(
        store
            .head(Plane::Data, atom.unsigned.actor_device_id)
            .unwrap(),
        Some(first.head)
    );
}

#[test]
fn stale_preflight_writes_no_objects() {
    let temp = tempfile::tempdir().unwrap();
    let store = GitStore::init(temp.path(), &test_git_executable()).unwrap();
    let atom = signed_fixture(Plane::Data, EventId::from_bytes([3; 16]));
    let device = atom.unsigned.actor_device_id;
    let first = store.append_local(batch_for(atom)).unwrap();
    let second = store
        .append_local(batch_with_expected(
            device,
            Some(first.head.clone()),
            EventId::from_bytes([13; 16]),
        ))
        .unwrap();
    let before = git(temp.path().as_os_str(), &["count-objects", "-v"], None);
    let error = store
        .append_local(batch_with_expected(
            device,
            Some(first.head),
            EventId::from_bytes([14; 16]),
        ))
        .unwrap_err();
    let after = git(temp.path().as_os_str(), &["count-objects", "-v"], None);
    assert_eq!(error.code, SyncErrorCode::RefRewind);
    assert_eq!(before, after);
    assert_eq!(store.head(Plane::Data, device).unwrap(), Some(second.head));
}

#[test]
fn open_rejects_sha1_repository() {
    let temp = tempfile::tempdir().unwrap();
    assert!(Command::new(test_git_executable())
        .args(["init", "--bare"])
        .arg(temp.path())
        .output()
        .unwrap()
        .status
        .success());
    let error = match GitStore::open(temp.path(), &test_git_executable()) {
        Ok(_) => panic!("SHA-1 repository was accepted"),
        Err(error) => error,
    };
    assert_eq!(error.code, SyncErrorCode::InvalidAtom);
    assert!(error.message.contains("SHA-256"));
}

#[test]
fn append_rejects_invalid_auxiliary_plane_and_duplicate_immutable_files() {
    let temp = tempfile::tempdir().unwrap();
    let store = GitStore::init(temp.path(), &test_git_executable()).unwrap();
    let atom = signed_fixture(Plane::Data, EventId::from_bytes([15; 16]));
    let mut wrong_plane = batch_for(atom.clone());
    wrong_plane.plane = Plane::Control;
    assert_eq!(
        store.append_local(wrong_plane).unwrap_err().code,
        SyncErrorCode::InvalidAtom
    );

    let mut invalid_aux = batch_for(atom.clone());
    invalid_aux.auxiliary_files.push(ImmutableFile {
        path: "texts/nope.md".into(),
        bytes: vec![],
    });
    assert_eq!(
        store.append_local(invalid_aux).unwrap_err().code,
        SyncErrorCode::InvalidAtom
    );

    let mut duplicate = batch_for(atom.clone());
    duplicate.atoms.push(signed_fixture_for(
        Plane::Data,
        atom.unsigned.event_id,
        atom.unsigned.actor_device_id,
        8,
    ));
    let error = store.append_local(duplicate).unwrap_err();
    assert_eq!(error.code, SyncErrorCode::InvalidAtom);
    assert!(error.message.contains("conflicting"));
    assert_eq!(
        store
            .head(Plane::Data, atom.unsigned.actor_device_id)
            .unwrap(),
        None
    );
}

#[test]
fn ancestry_redundant_observed_parent_is_removed() {
    let temp = tempfile::tempdir().unwrap();
    let store = GitStore::init(temp.path(), &test_git_executable()).unwrap();
    let device_a = DeviceId::from_bytes([3; 16]);
    let first = store
        .append_local(batch_for(signed_fixture_for(
            Plane::Data,
            EventId::from_bytes([16; 16]),
            device_a,
            9,
        )))
        .unwrap();
    let mut next = batch_for(signed_fixture_for(
        Plane::Data,
        EventId::from_bytes([17; 16]),
        device_a,
        9,
    ));
    next.expected_head = Some(first.head.clone());
    let second = store.append_local(next).unwrap();
    let device_b = DeviceId::from_bytes([7; 16]);
    let mut merge_batch = batch_for(signed_fixture_for(
        Plane::Data,
        EventId::from_bytes([18; 16]),
        device_b,
        8,
    ));
    merge_batch.observed_heads = vec![first.head, second.head.clone()];
    let merged = store.append_local(merge_batch).unwrap();
    let parents = String::from_utf8(git(
        temp.path().as_os_str(),
        &["show", "-s", "--format=%P", merged.head.as_str()],
        None,
    ))
    .unwrap();
    assert_eq!(
        parents.split_whitespace().collect::<Vec<_>>(),
        vec![second.head.as_str()]
    );
}

#[cfg(unix)]
#[test]
fn inherited_git_config_cannot_enable_reference_transaction_hook() {
    use std::os::unix::fs::PermissionsExt;

    if env::var_os("YONALIST_GIT_ENV_CHILD").is_some() {
        let repo = PathBuf::from(env::var_os("YONALIST_GIT_ENV_REPO").unwrap());
        let marker = PathBuf::from(env::var_os("YONALIST_GIT_ENV_MARKER").unwrap());
        let store = GitStore::init(&repo, &test_git_executable()).unwrap();
        store
            .append_local(batch_for(signed_fixture(
                Plane::Data,
                EventId::from_bytes([19; 16]),
            )))
            .unwrap();
        assert!(!marker.exists(), "inherited Git config executed a hook");
        assert_eq!(
            std::fs::read_to_string(repo.join("config"))
                .unwrap()
                .matches("hooksPath")
                .count(),
            1
        );
        return;
    }

    let temp = tempfile::tempdir().unwrap();
    let hook_dir = temp.path().join("attacker-hooks");
    std::fs::create_dir(&hook_dir).unwrap();
    let marker = temp.path().join("hook-ran");
    let hook = hook_dir.join("reference-transaction");
    std::fs::write(&hook, format!("#!/bin/sh\ntouch '{}'\n", marker.display())).unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    let repo = temp.path().join("repo");
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "inherited_git_config_cannot_enable_reference_transaction_hook",
            "--exact",
        ])
        .env("YONALIST_GIT_ENV_CHILD", "1")
        .env("YONALIST_GIT_ENV_REPO", &repo)
        .env("YONALIST_GIT_ENV_MARKER", &marker)
        .env("GIT_CONFIG_COUNT", "1")
        .env("GIT_CONFIG_KEY_0", "core.hooksPath")
        .env("GIT_CONFIG_VALUE_0", &hook_dir)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "child test failed: {}",
        String::from_utf8_lossy(&output.stdout)
    );
}

#[cfg(unix)]
#[test]
fn concurrent_compare_and_swap_loss_does_not_report_success() {
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    let initial = GitStore::init(&repo, &test_git_executable()).unwrap();
    let atom = signed_fixture(Plane::Data, EventId::from_bytes([20; 16]));
    let device = atom.unsigned.actor_device_id;
    let first = initial.append_local(batch_for(atom)).unwrap();
    let rival = raw_root_commit(
        repo.as_os_str(),
        "texts/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.md",
        b"rival",
    );
    let trigger = temp.path().join("trigger");
    let wrapper = temp.path().join("git-wrapper");
    std::fs::write(
        &wrapper,
        format!(
            "#!/bin/sh\nif [ \"$2\" = update-ref ] && [ -f '{}' ]; then\n  rm '{}'\n  git \"$1\" update-ref \"$3\" '{}' \"$5\" || exit $?\nfi\nexec git \"$@\"\n",
            trigger.display(),
            trigger.display(),
            rival.as_str()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();
    let racing = GitStore::open(&repo, &wrapper).unwrap();
    std::fs::write(&trigger, b"go").unwrap();
    let mut batch = batch_for(signed_fixture(Plane::Data, EventId::from_bytes([21; 16])));
    batch.expected_head = Some(first.head);
    let error = racing.append_local(batch).unwrap_err();
    assert_eq!(error.code, SyncErrorCode::RefRewind);
    assert_eq!(racing.head(Plane::Data, device).unwrap(), Some(rival));
}

#![cfg(feature = "test-support")]

use std::{env, path::PathBuf};

#[cfg(unix)]
use std::process::Command;

use yonalist_sync::test_support::raw_test_support::{GitStore, StoreBatch};
use yonalist_sync::{
    DeviceId, DeviceSigner, EventId, GitOid, MemberId, Plane, ProjectId, SyncErrorCode,
    UnsignedAtom, ATOM_SCHEMA_V1,
};

fn test_git_executable() -> PathBuf {
    env::var_os("YONALIST_TEST_GIT")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("git"))
}

fn batch(event: u8, expected_head: Option<GitOid>) -> StoreBatch {
    let device_id = DeviceId::from_bytes([3; 16]);
    let atom = DeviceSigner::from_secret_bytes([9; 32])
        .sign(UnsignedAtom {
            schema: ATOM_SCHEMA_V1,
            project_id: ProjectId::from_bytes([1; 16]),
            event_id: EventId::from_bytes([event; 16]),
            plane: Plane::Data,
            actor_member_id: MemberId::from_bytes([2; 16]),
            actor_device_id: device_id,
            membership_grant_id: yonalist_sync::GrantId::from_bytes([4; 16]),
            control_frontier: vec![],
            data_frontier: vec![],
            display_time_ms: 0,
            payload: b"issue.created".to_vec(),
        })
        .unwrap();
    StoreBatch {
        plane: Plane::Data,
        device_id,
        expected_head,
        atoms: vec![atom],
        auxiliary_files: vec![],
        observed_heads: vec![],
    }
}

#[test]
fn ancestry_distinguishes_not_ancestor_from_git_failure() {
    let temp = tempfile::tempdir().unwrap();
    let store = GitStore::init(temp.path(), &test_git_executable()).unwrap();
    let first = store.append_local(batch(1, None)).unwrap();
    let second = store
        .append_local(batch(2, Some(first.head.clone())))
        .unwrap();

    assert!(!store.is_ancestor(&second.head, &first.head).unwrap());

    let missing =
        GitOid::parse("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").unwrap();
    let error = store.is_ancestor(&missing, &second.head).unwrap_err();
    assert_eq!(error.code, SyncErrorCode::GitCommandFailed);
}

#[cfg(unix)]
#[test]
fn init_and_open_probe_the_exact_injected_git_executable() {
    use std::os::unix::fs::PermissionsExt;

    let temp = tempfile::tempdir().unwrap();
    let executable = temp.path().join("old-git");
    std::fs::write(&executable, "#!/bin/sh\nprintf 'git version 2.48.9\\n'\n").unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();

    let init_repo = temp.path().join("init-repo");
    let init_error = match GitStore::init(&init_repo, &executable) {
        Ok(_) => panic!("old injected Git was accepted for init"),
        Err(error) => error,
    };
    assert_eq!(init_error.code, SyncErrorCode::GitUnavailable);

    let open_repo = temp.path().join("open-repo");
    GitStore::init(&open_repo, &test_git_executable()).unwrap();
    let open_error = match GitStore::open(&open_repo, &executable) {
        Ok(_) => panic!("old injected Git was accepted for open"),
        Err(error) => error,
    };
    assert_eq!(open_error.code, SyncErrorCode::GitUnavailable);
}

#[cfg(unix)]
#[test]
fn ref_lookup_does_not_collapse_git_exit_128_into_an_absent_ref() {
    use std::os::unix::fs::PermissionsExt;

    let resolved_git = Command::new("sh")
        .args(["-c", "command -v git"])
        .output()
        .unwrap();
    assert!(resolved_git.status.success());
    let resolved_git = String::from_utf8(resolved_git.stdout).unwrap();
    let temp = tempfile::tempdir().unwrap();
    let executable = temp.path().join("failing-ref-git");
    std::fs::write(
        &executable,
        format!(
            "#!/bin/sh\n\
             if [ \"$2\" = rev-parse ] && [ \"$3\" = --verify ]; then exit 128; fi\n\
             if [ \"$2\" = for-each-ref ]; then exit 128; fi\n\
             exec '{}' \"$@\"\n",
            resolved_git.trim()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
    let store = GitStore::init(&temp.path().join("repo"), &executable).unwrap();

    let error = store
        .head(Plane::Data, DeviceId::from_bytes([3; 16]))
        .unwrap_err();
    assert_eq!(error.code, SyncErrorCode::GitCommandFailed);
}

#[cfg(unix)]
#[test]
fn invalid_utf8_ancestry_stderr_is_message_bounded() {
    use std::os::unix::fs::PermissionsExt;

    let resolved_git = Command::new("sh")
        .args(["-c", "command -v git"])
        .output()
        .unwrap();
    assert!(resolved_git.status.success());
    let resolved_git = String::from_utf8(resolved_git.stdout).unwrap();
    let temp = tempfile::tempdir().unwrap();
    let executable = temp.path().join("invalid-stderr-git");
    std::fs::write(
        &executable,
        format!(
            "#!/bin/sh\n\
             if [ \"$2\" = merge-base ]; then\n\
               dd if=/dev/zero bs=1024 count=100 2>/dev/null | tr '\\000' '\\377' >&2\n\
               exit 128\n\
             fi\n\
             exec '{}' \"$@\"\n",
            resolved_git.trim()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
    let repo = temp.path().join("repo");
    let store = GitStore::init(&repo, &executable).unwrap();
    let first = store.append_local(batch(1, None)).unwrap();

    let error = store.is_ancestor(&first.head, &first.head).unwrap_err();
    assert_eq!(error.code, SyncErrorCode::GitCommandFailed);
    assert!(
        error.message.len() <= 256 * 1024,
        "invalid UTF-8 expanded to {} bytes",
        error.message.len()
    );
}

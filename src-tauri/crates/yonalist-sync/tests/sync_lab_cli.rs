#![cfg(feature = "test-support")]

use std::process::Command;

#[test]
fn mesh_prints_one_json_line() {
    let output = Command::new(env!("CARGO_BIN_EXE_sync-lab"))
        .args(["mesh", "--peers", "2", "--events", "0", "--seed", "1"])
        .output()
        .unwrap();
    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert_eq!(stdout.lines().count(), 1);
    assert!(stdout.contains("\"converged\":true"));
}

#[test]
fn mesh_accepts_seed_zero() {
    let output = Command::new(env!("CARGO_BIN_EXE_sync-lab"))
        .args(["mesh", "--peers", "3", "--events", "4", "--seed", "0"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8(output.stdout)
        .unwrap()
        .contains("\"converged\":true"));
}

#[test]
fn invalid_forms_exit_two() {
    let output = Command::new(env!("CARGO_BIN_EXE_sync-lab"))
        .args([
            "mesh", "--peers", "2", "--peers", "3", "--events", "0", "--seed", "1",
        ])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8(output.stdout).unwrap().is_empty());
}

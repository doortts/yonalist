use yonalist_sync::{DeviceId, GitOid, Plane, ProjectId, SyncErrorCode};

#[test]
fn primitive_types_are_stable_and_strongly_typed() {
    let project = ProjectId::from_bytes([1; 16]);
    let device = DeviceId::from_bytes([2; 16]);

    assert_eq!(project.to_string(), "01040g2081040g2081040g2081");
    assert_eq!(device.to_string(), "02081040g2081040g2081040g2");
    assert_eq!(Plane::Control.ref_prefix(), "refs/yonalist/control/");
    assert_eq!(Plane::Data.ref_prefix(), "refs/yonalist/data/");
    assert_eq!(
        GitOid::parse(&"a".repeat(64)).unwrap().as_str(),
        "a".repeat(64)
    );
    assert_eq!(
        GitOid::parse("abc").unwrap_err().code,
        SyncErrorCode::InvalidId
    );
}

#[test]
fn primitive_ids_reject_values_larger_than_u128() {
    for value in ["80000000000000000000000000", "zzzzzzzzzzzzzzzzzzzzzzzzzz"] {
        assert_eq!(
            value.parse::<ProjectId>().unwrap_err().code,
            SyncErrorCode::InvalidId
        );
    }

    let largest = "7zzzzzzzzzzzzzzzzzzzzzzzzz";
    assert_eq!(largest.parse::<ProjectId>().unwrap().to_string(), largest);
}

fn assert_default_features_hide(symbol: &str) {
    let consumer = tempfile::tempdir().unwrap();
    std::fs::create_dir(consumer.path().join("src")).unwrap();
    let dependency = serde_json::to_string(env!("CARGO_MANIFEST_DIR")).unwrap();
    std::fs::write(
        consumer.path().join("Cargo.toml"),
        format!(
            "[package]\nname = \"public-contract-probe\"\nversion = \"0.0.0\"\nedition = \"2021\"\n\n[dependencies]\nyonalist-sync = {{ path = {dependency}, default-features = false }}\n"
        ),
    )
    .unwrap();
    std::fs::write(
        consumer.path().join("src/main.rs"),
        format!("use yonalist_sync::{symbol};\nfn main() {{}}\n"),
    )
    .unwrap();
    let output = std::process::Command::new(env!("CARGO"))
        .args(["check", "--quiet", "--offline"])
        .current_dir(consumer.path())
        .env("CARGO_TARGET_DIR", consumer.path().join("target"))
        .output()
        .unwrap();
    assert!(
        !output.status.success(),
        "default-feature consumer imported {symbol}"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    let diagnostic = format!("error[E0432]: unresolved import `yonalist_sync::{symbol}`");
    assert!(
        stderr.lines().any(|line| line.trim() == diagnostic),
        "missing unresolved-import diagnostic for {symbol}:\n{stderr}"
    );
}

#[test]
fn default_features_hide_git_store() {
    assert_default_features_hide("GitStore");
}

#[test]
fn default_features_hide_store_batch() {
    assert_default_features_hide("StoreBatch");
}

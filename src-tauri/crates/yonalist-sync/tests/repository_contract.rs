#[test]
fn repository_exposes_standalone_sync_commands() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let package: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root.join("package.json")).unwrap()).unwrap();

    assert_eq!(
        package["scripts"]["test:sync"],
        "cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --all-features"
    );
    assert_eq!(
        package["scripts"]["sync:lab"],
        "cargo run --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --features test-support --bin sync-lab --"
    );

    let readme = std::fs::read_to_string(root.join("README.md")).unwrap();
    assert!(readme.contains("## Standalone distributed sync lab"));
    assert!(readme.contains("The last stdout line is one stable JSON object."));
}

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

#[test]
fn repository_documents_and_probes_the_pinned_runtime_versions() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let toolchain = std::fs::read_to_string(root.join("rust-toolchain.toml")).unwrap();
    let app_manifest = std::fs::read_to_string(root.join("src-tauri/Cargo.toml")).unwrap();
    let sync_manifest =
        std::fs::read_to_string(root.join("src-tauri/crates/yonalist-sync/Cargo.toml")).unwrap();
    let readme = std::fs::read_to_string(root.join("README.md")).unwrap();
    let ci = std::fs::read_to_string(root.join(".github/workflows/ci.yml")).unwrap();

    assert!(toolchain.contains("channel = \"1.97.0\""));
    assert!(app_manifest.contains("rust-version = \"1.97\""));
    assert!(sync_manifest.contains("rust-version = \"1.97\""));
    assert!(readme.contains("Rust 1.97 or later"));
    assert!(readme.contains("Git 2.49 or later"));
    assert!(ci.contains("dtolnay/rust-toolchain@1.97.0"));
    assert!(ci.contains("ppa:git-core/ppa"));
    assert!(ci.contains("git --version"));

    let runtime_probe = ci
        .find("--test git_runtime")
        .expect("CI must run the standalone Git runtime probe");
    let ordinary_suite = ci
        .find("--all-features")
        .expect("CI must run the ordinary standalone suite");
    assert!(runtime_probe < ordinary_suite);
}

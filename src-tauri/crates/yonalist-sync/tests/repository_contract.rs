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
    assert!(sync_manifest.contains("Win32_System_JobObjects"));

    let windows_job = ci
        .find("sync-windows:")
        .expect("CI must compile the Windows Job Object process-tree path");
    let windows_ci = &ci[windows_job..];
    assert!(windows_ci.contains("runs-on: windows-latest"));
    assert!(windows_ci.contains(
        "cargo check --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --all-targets --all-features"
    ));

    let runtime_probe = ci
        .find("--test git_runtime")
        .expect("CI must run the standalone Git runtime probe");
    let ordinary_suite = ci
        .find("--all-features")
        .expect("CI must run the ordinary standalone suite");
    assert!(runtime_probe < ordinary_suite);
}

#[test]
fn repository_documents_the_pack_containment_boundary_and_exact_defaults() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let readme = std::fs::read_to_string(root.join("README.md")).unwrap();

    for statement in [
        "16 MiB compressed pack input",
        "128 advertised refs",
        "1,024 commits",
        "8,192 objects",
        "1,024 file entries per commit",
        "1,024 atoms per head",
        "4 MiB per blob",
        "64 MiB expanded objects",
        "4 MiB parsed metadata",
        "accepted-only pack",
        "Git subprocess wall time",
        "OS sandbox",
        "CPU and RSS",
    ] {
        assert!(readme.contains(statement), "README omitted: {statement}");
    }
    assert!(readme.contains(
        "do not by themselves defeat every decompression or\nalgorithmic denial of service"
    ));
}

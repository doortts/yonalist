use yonalist_sync::{
    AccessDecision, AccessState, AtomLimits, DeviceId, GitOid, GrantId, MemberId, PackLimits,
    Plane, ProjectId, ProjectPolicy, Replica, ReplicaConfig, StoredAtom, SyncError, SyncErrorCode,
};

#[derive(Clone)]
struct PublicPolicy;

impl ProjectPolicy for PublicPolicy {
    type State = ();

    fn rebuild_control(&self, _: &[StoredAtom]) -> Result<Self::State, SyncError> {
        Ok(())
    }
    fn advance_control(&self, _: &Self::State, _: &[StoredAtom]) -> Result<Self::State, SyncError> {
        Ok(())
    }
    fn validate_control(&self, _: &Self::State, _: &StoredAtom) -> Result<(), SyncError> {
        Ok(())
    }
    fn validate_data(&self, _: &Self::State, _: &StoredAtom) -> Result<(), SyncError> {
        Ok(())
    }
    fn peer_access(&self, _: &Self::State, _: MemberId, _: DeviceId, _: GrantId) -> AccessDecision {
        AccessDecision::Allowed
    }
    fn local_access(&self, _: &Self::State, _: MemberId, _: DeviceId, _: GrantId) -> AccessState {
        AccessState::Active
    }
}

fn public_config(repository: &std::path::Path) -> ReplicaConfig {
    ReplicaConfig {
        repository: repository.into(),
        git_executable: std::env::var_os("YONALIST_TEST_GIT")
            .map(Into::into)
            .unwrap_or_else(|| "git".into()),
        project_id: ProjectId::from_bytes([1; 16]),
        local_member_id: MemberId::from_bytes([2; 16]),
        local_device_id: DeviceId::from_bytes([3; 16]),
        local_grant_id: GrantId::from_bytes([4; 16]),
        atom_limits: AtomLimits {
            max_payload_bytes: 1 << 20,
            max_frontier_heads: 32,
        },
        pack_limits: PackLimits::default(),
    }
}

#[test]
fn production_facade_has_no_signer_argument_and_exposes_only_read_methods() {
    let directory = tempfile::tempdir().unwrap();
    let replica = Replica::create(public_config(directory.path()), PublicPolicy).unwrap();
    assert!(replica
        .trusted_refs(Plane::Control)
        .unwrap()
        .refs
        .is_empty());
    assert!(replica.stored_atoms(Plane::Data).unwrap().is_empty());
    assert_eq!(replica.access_state(), &AccessState::Active);

    let reopened = Replica::open(public_config(directory.path()), PublicPolicy).unwrap();
    assert_eq!(reopened.access_state(), &AccessState::Active);
}

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

fn assert_default_features_expose_production_contract() {
    let consumer = tempfile::tempdir().unwrap();
    std::fs::create_dir(consumer.path().join("src")).unwrap();
    let dependency = serde_json::to_string(env!("CARGO_MANIFEST_DIR")).unwrap();
    std::fs::write(
        consumer.path().join("Cargo.toml"),
        format!(
            "[package]\nname = \"public-contract-positive-probe\"\nversion = \"0.0.0\"\nedition = \"2021\"\n\n[dependencies]\nyonalist-sync = {{ path = {dependency}, default-features = false }}\n"
        ),
    )
    .unwrap();
    std::fs::write(
        consumer.path().join("src/main.rs"),
        "use yonalist_sync::{Hello, HelloAck, PackBytes, PackLimits, PackRequest, PeerEndpoint, ProjectPolicy, RefAdvertisement, Replica, ReplicaConfig, SessionToken, StoredAtom};\nfn main() {}\n",
    )
    .unwrap();
    let output = std::process::Command::new(env!("CARGO"))
        .args(["check", "--quiet", "--offline"])
        .current_dir(consumer.path())
        .env("CARGO_TARGET_DIR", consumer.path().join("target"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "default-feature consumer could not import the production contract:\n{}",
        String::from_utf8_lossy(&output.stderr)
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

#[test]
fn default_features_hide_raw_promotion_types() {
    assert_default_features_hide("CandidateRef");
    assert_default_features_hide("ValidatedPack");
}

#[test]
fn default_features_expose_only_the_production_contract() {
    assert_default_features_expose_production_contract();
}

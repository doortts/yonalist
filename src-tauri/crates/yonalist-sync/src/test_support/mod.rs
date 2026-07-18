mod peer;
mod policy;
mod scenario;

/// Explicit opt-in fixture adapter for low-level repository and quarantine
/// tests. Production consumers cannot reach these types because this module is
/// compiled only with the `test-support` feature.
#[doc(hidden)]
pub mod raw_test_support {
    pub use crate::git_store::GitStore;
    pub use crate::pack::{CandidateRef, ImportOutcome};
    pub use crate::protocol::StoreBatch;
}

pub use peer::{FixtureIdentity, FixturePair, FixtureReplica, InProcessPeer, PackFault};
#[allow(unused_imports)]
pub use policy::{FixtureControl, FixtureGrant, FixturePolicy, FixtureRole, FixtureState};
pub use scenario::{run_corrupt_pack, run_mesh, run_revocation, ScenarioConfig, ScenarioSummary};

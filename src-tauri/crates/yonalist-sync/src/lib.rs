mod atom;
mod error;
mod git_command;
mod git_store;
mod identity;
mod ids;
mod pack;
mod policy;
mod protocol;
mod replica;
#[cfg(feature = "test-support")]
mod test_support;
mod transport;

pub use atom::{AtomLimits, SignedAtom, UnsignedAtom, ATOM_SCHEMA_V1};
pub use error::{SyncError, SyncErrorCode};
#[cfg(feature = "test-support")]
pub use git_store::GitStore;
pub use identity::DeviceSigner;
pub use ids::{DeviceId, EventId, GitOid, GrantId, MemberId, Plane, ProjectId};
pub use pack::{CandidateRef, ImportOutcome, PackBytes, PackLimits, PackRequest};
pub use policy::{AccessDecision, AccessState, ProjectPolicy, StoredAtom};
#[cfg(feature = "test-support")]
pub use protocol::StoreBatch;
pub use protocol::{ImmutableFile, LocalCommit, RefAdvertisement};
pub use replica::{LocalBatch, Replica, ReplicaConfig, SyncReport};
#[cfg(feature = "test-support")]
pub use test_support::{
    run_corrupt_pack, run_mesh, run_revocation, FixtureControl, FixtureGrant, FixtureIdentity,
    FixturePair, FixturePolicy, FixtureRole, FixtureState, InProcessPeer, PackFault,
    ScenarioConfig, ScenarioSummary,
};
pub use transport::{Hello, HelloAck, PeerEndpoint};

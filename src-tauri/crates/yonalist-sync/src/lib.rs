//! The default crate surface is the application-facing synchronization API.
//! Raw Git storage and pack-promotion internals are deliberately absent.
//!
//! ```compile_fail
//! use yonalist_sync::{CandidateRef, GitStore, StoreBatch, ValidatedPack};
//! ```
//!
//! The stable production protocol surface remains available without optional
//! fixture support:
//!
//! ```
//! use yonalist_sync::{
//!     Hello, HelloAck, PackBytes, PackLimits, PackRequest, PeerEndpoint,
//!     ProjectPolicy, RefAdvertisement, Replica, ReplicaConfig, SessionToken,
//!     StoredAtom,
//! };
//! ```

mod access_lock;
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
pub mod test_support;
mod transport;

pub use atom::{AtomLimits, SignedAtom, UnsignedAtom, ATOM_SCHEMA_V1};
pub use error::{SyncError, SyncErrorCode};
pub use identity::DeviceSigner;
pub use ids::{DeviceId, EventId, GitOid, GrantId, MemberId, Plane, ProjectId};
pub use pack::{PackBytes, PackLimits, PackRequest};
pub use policy::{AccessDecision, AccessState, ProjectPolicy, StoredAtom};
pub use protocol::{ImmutableFile, LocalCommit, RefAdvertisement, SessionToken};
pub use replica::{LocalBatch, Replica, ReplicaConfig, SyncReport};
#[cfg(feature = "test-support")]
pub use test_support::{
    run_corrupt_pack, run_mesh, run_revocation, FixtureControl, FixtureGrant, FixtureIdentity,
    FixturePair, FixturePolicy, FixtureReplica, FixtureRole, FixtureState, InProcessPeer,
    PackFault, ScenarioConfig, ScenarioSummary,
};
pub use transport::{Hello, HelloAck, PeerEndpoint};

#![cfg(feature = "test-support")]

use yonalist_sync::{
    run_corrupt_pack, run_revocation, FixturePair, InProcessPeer, PackFault, Plane, SyncErrorCode,
};

#[test]
fn corrupted_pack_is_rejected_and_clean_retry_converges() {
    let summary = run_corrupt_pack(77).unwrap();
    assert!(summary.converged);
    assert_eq!(summary.rejected_packs, 1);
    assert_ne!(summary.final_event_digest, "");
}

#[test]
fn revocation_reports_one_revoked_peer() {
    let summary = run_revocation(9).unwrap();
    assert!(summary.converged);
    assert_eq!(summary.revoked_peers, 1);
}

#[test]
fn dropped_pack_is_one_shot_and_clean_retry_converges() {
    let mut pair = FixturePair::new();
    pair.alice.append_fixture_data(b"retry").unwrap();
    let mut endpoint = InProcessPeer::with_fault(&pair.alice, PackFault::DropAfter(8));
    let error = pair.bob.pull_from(&mut endpoint).unwrap_err();
    assert_eq!(error.code, SyncErrorCode::Io);
    pair.bob.pull_from(&mut endpoint).unwrap();
    assert_eq!(
        pair.alice.event_ids(Plane::Data),
        pair.bob.event_ids(Plane::Data)
    );
}

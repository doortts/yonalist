#![cfg(feature = "test-support")]

use yonalist_sync::{
    AccessDecision, FixturePair, Hello, HelloAck, InProcessPeer, PackBytes, PackLimits,
    PackRequest, PeerEndpoint, Plane, ProjectId, RefAdvertisement, SyncError,
};

#[test]
fn two_allowed_peers_converge_and_second_pull_is_empty() {
    let mut pair = FixturePair::new();
    pair.alice.append_fixture_data(b"alice-offline-1").unwrap();
    pair.alice.append_fixture_data(b"alice-offline-2").unwrap();

    let mut endpoint = InProcessPeer::new(&pair.alice);
    let first = pair.bob.pull_from(&mut endpoint).unwrap();
    assert_eq!(first.control_refs_advanced, 1);
    assert_eq!(first.data_refs_advanced, 1);
    assert!(first.data_pack_bytes > 0);
    assert_eq!(
        pair.alice.event_ids(Plane::Data),
        pair.bob.event_ids(Plane::Data)
    );

    let second = pair.bob.pull_from(&mut endpoint).unwrap();
    assert_eq!(second.control_refs_advanced, 0);
    assert_eq!(second.data_refs_advanced, 0);
    assert_eq!(second.control_pack_bytes, 0);
    assert_eq!(second.data_pack_bytes, 0);
}

struct DenyingPeer<'a>(InProcessPeer<'a>);
impl PeerEndpoint for DenyingPeer<'_> {
    fn hello(&mut self, _: &Hello) -> Result<HelloAck, SyncError> {
        self.0.hello_calls += 1;
        Ok(HelloAck {
            decision: AccessDecision::Denied,
        })
    }
    fn advertise(
        &mut self,
        project: ProjectId,
        plane: Plane,
    ) -> Result<RefAdvertisement, SyncError> {
        self.0.advertise(project, plane)
    }
    fn create_pack(
        &mut self,
        project: ProjectId,
        request: &PackRequest,
        limits: &PackLimits,
    ) -> Result<PackBytes, SyncError> {
        self.0.create_pack(project, request, limits)
    }
}

#[test]
fn denied_ack_still_pulls_control_but_never_starts_data() {
    let mut pair = FixturePair::new();
    let mut peer = DenyingPeer(InProcessPeer::new(&pair.alice));
    let report = pair.bob.pull_from(&mut peer).unwrap();
    assert_eq!(report.control_refs_advanced, 1);
    assert_eq!(report.data_refs_advanced, 0);
    assert_eq!(peer.0.hello_calls, 1);
    assert_eq!(peer.0.control_advertise_calls, 1);
    assert_eq!(peer.0.control_pack_calls, 1);
    assert_eq!(peer.0.data_advertise_calls, 0);
    assert_eq!(peer.0.data_pack_calls, 0);
}

#[test]
fn offline_writes_converge_in_both_directions() {
    let mut pair = FixturePair::new();
    pair.alice.append_fixture_data(b"alice").unwrap();
    {
        let mut peer = InProcessPeer::new(&pair.alice);
        pair.bob.pull_from(&mut peer).unwrap();
    }
    pair.bob.append_fixture_data(b"bob").unwrap();
    pair.sync_both_directions().unwrap();
    assert_eq!(pair.alice.payloads(), pair.bob.payloads());
    assert_eq!(pair.alice.payloads().len(), 2);
}

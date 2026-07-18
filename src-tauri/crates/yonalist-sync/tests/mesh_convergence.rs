#![cfg(feature = "test-support")]

use yonalist_sync::{run_mesh, ScenarioConfig, SyncErrorCode};

#[test]
#[ignore = "slow: 100 isolated Git repositories and 500 production-pack events; run explicitly for Task 8 CI"]
fn one_hundred_partitioned_peers_eventually_converge() {
    let summary = run_mesh(ScenarioConfig {
        peers: 100,
        events: 500,
        seed: 42,
    })
    .unwrap();
    assert!(summary.converged);
    assert_eq!(summary.peers, 100);
    assert_eq!(summary.events, 500);
    assert!(summary.rounds > 1);
    assert_eq!(summary.rejected_packs, 0);
}

#[test]
fn same_seed_has_the_same_summary() {
    let config = ScenarioConfig {
        peers: 5,
        events: 12,
        seed: 7,
    };
    assert_eq!(run_mesh(config.clone()).unwrap(), run_mesh(config).unwrap());
}

#[test]
fn different_seeds_change_the_event_digest() {
    let first = run_mesh(ScenarioConfig {
        peers: 4,
        events: 3,
        seed: 7,
    })
    .unwrap();
    let second = run_mesh(ScenarioConfig {
        peers: 4,
        events: 3,
        seed: 8,
    })
    .unwrap();
    assert_ne!(first.final_event_digest, second.final_event_digest);
}

#[test]
fn partitioned_mesh_needs_reconnect_then_a_quiet_round() {
    let summary = run_mesh(ScenarioConfig {
        peers: 10,
        events: 50,
        seed: 42,
    })
    .unwrap();
    assert!(summary.rounds > 1);
}

#[test]
fn seed_zero_is_a_valid_deterministic_mesh_seed() {
    let config = ScenarioConfig {
        peers: 4,
        events: 9,
        seed: 0,
    };
    let first = run_mesh(config.clone()).unwrap();
    let second = run_mesh(config).unwrap();
    assert!(first.converged);
    assert_eq!(first, second);
}

#[test]
fn zero_events_converges() {
    let summary = run_mesh(ScenarioConfig {
        peers: 3,
        events: 0,
        seed: 2,
    })
    .unwrap();
    assert!(summary.converged);
    assert_eq!(summary.events, 0);
}

#[test]
fn one_peer_accepts_the_five_hundred_event_boundary_without_mesh_sync() {
    let summary = run_mesh(ScenarioConfig {
        peers: 1,
        events: 500,
        seed: 42,
    })
    .unwrap();
    assert!(summary.converged);
    assert_eq!(summary.peers, 1);
    assert_eq!(summary.events, 500);
}

#[test]
fn invalid_mesh_bounds_are_rejected() {
    for config in [
        ScenarioConfig {
            peers: 0,
            events: 0,
            seed: 0,
        },
        ScenarioConfig {
            peers: 101,
            events: 0,
            seed: 0,
        },
        ScenarioConfig {
            peers: 1,
            events: 501,
            seed: 0,
        },
    ] {
        assert_eq!(
            run_mesh(config).unwrap_err().code,
            SyncErrorCode::LimitExceeded
        );
    }
}

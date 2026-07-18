#![cfg(feature = "test-support")]

use yonalist_sync::{run_mesh, ScenarioConfig, SyncErrorCode};

#[test]
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
fn seeded_hub_schedule_converges_in_two_rounds() {
    let summary = run_mesh(ScenarioConfig {
        peers: 10,
        events: 50,
        seed: 42,
    })
    .unwrap();
    assert_eq!(summary.rounds, 2);
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
            events: 10_001,
            seed: 0,
        },
    ] {
        assert_eq!(
            run_mesh(config).unwrap_err().code,
            SyncErrorCode::LimitExceeded
        );
    }
}

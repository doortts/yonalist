#![cfg(feature = "bench-fixtures")]

use std::time::{Duration, Instant};

use notes_application::{CommandEnvelope, IpcNotesCommand, NotesService};
use notes_sqlite::SqliteStorage;

fn measure_bounded_bootstrap(node_count: usize) -> Duration {
    let storage = SqliteStorage::open_in_memory().expect("open fixture database");
    storage
        .load_performance_fixture(node_count)
        .expect("load fixture");
    let started = Instant::now();
    let boot = storage
        .bootstrap("performance-session", 80)
        .expect("bootstrap");
    let elapsed = started.elapsed();
    assert_eq!(
        boot.viewport.expect("viewport").nodes.len(),
        node_count.min(80)
    );
    elapsed
}

#[test]
fn bootstrap_fixture_covers_the_single_node_case() {
    assert!(measure_bounded_bootstrap(1) < Duration::from_millis(100));
}

#[test]
fn bootstrap_is_bounded_at_five_thousand_nodes() {
    let elapsed = measure_bounded_bootstrap(5_000);
    eprintln!("5,000-node bounded bootstrap: {elapsed:?}");
    assert!(elapsed < Duration::from_secs(1));
}

#[test]
fn bootstrap_is_bounded_at_fifty_thousand_nodes() {
    let elapsed = measure_bounded_bootstrap(50_000);
    eprintln!("50,000-node bounded bootstrap: {elapsed:?}");
    assert!(elapsed < Duration::from_secs(2));
}

#[test]
fn five_thousand_node_bootstrap_reports_fifty_sample_percentiles() {
    let storage = SqliteStorage::open_in_memory().expect("open fixture database");
    storage
        .load_performance_fixture(5_000)
        .expect("load fixture");
    let mut samples = (0..50)
        .map(|index| {
            let started = Instant::now();
            storage
                .bootstrap(format!("sample-{index}"), 80)
                .expect("bootstrap");
            started.elapsed()
        })
        .collect::<Vec<_>>();
    samples.sort_unstable();
    let p50 = samples[24];
    let p95 = samples[47];
    eprintln!("5,000-node bootstrap (50 samples): p50={p50:?}, p95={p95:?}");
    assert!(p95 < Duration::from_millis(100));
}

#[test]
fn fifty_thousand_sibling_append_returns_a_compact_patch() {
    let storage = SqliteStorage::open_in_memory().expect("open fixture database");
    storage
        .load_performance_fixture(50_000)
        .expect("load fixture");
    let service = NotesService::new(&storage, "performance-session", 1);
    let started = Instant::now();
    let receipt = service
        .execute(CommandEnvelope {
            session_id: "performance-session".into(),
            request_id: "append".into(),
            base_revision: 1,
            history_group: None,
            command: IpcNotesCommand::CreateNode {
                id: "fixture-appended".into(),
                parent_id: "fixture-page".into(),
                before_id: None,
                text: "Appended".into(),
            },
        })
        .expect("append one root bullet");
    let elapsed = started.elapsed();

    eprintln!("50,000-sibling append: {elapsed:?}");
    assert_eq!(receipt.changed_nodes.len(), 1);
    assert!(elapsed < Duration::from_millis(200));
}

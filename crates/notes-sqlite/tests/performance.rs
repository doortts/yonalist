#![cfg(feature = "bench-fixtures")]

use std::time::{Duration, Instant};

use notes_application::{CommandEnvelope, IpcNotesCommand, NotesService, ViewportRequest};
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

fn window(after_cursor: Option<String>, limit: u32) -> ViewportRequest {
    ViewportRequest {
        page_id: "fixture-page".into(),
        anchor_id: None,
        before_cursor: None,
        after_cursor,
        limit,
    }
}

/// Every window's own cost, from the top of the page to its last row.
fn scroll_to_the_end(node_count: usize, limit: u32) -> Vec<Duration> {
    let storage = SqliteStorage::open_in_memory().expect("open fixture database");
    storage
        .load_performance_fixture(node_count)
        .expect("load fixture");
    // The first read of a page also stores it as the active one; priming that
    // write out keeps every measured window a pure read.
    storage.query_viewport(window(None, limit)).expect("prime");
    let mut samples = Vec::new();
    let mut cursor = None;
    loop {
        let started = Instant::now();
        let page = storage
            .query_viewport(window(cursor, limit))
            .expect("window");
        samples.push(started.elapsed());
        match page.after_cursor {
            Some(next) => cursor = Some(next),
            None => return samples,
        }
    }
}

#[test]
fn scrolling_five_thousand_nodes_to_the_end_stays_bounded() {
    let windows = scroll_to_the_end(5_000, 80);
    let first = windows[0];
    let middle = windows[windows.len() / 2];
    let last = windows[windows.len() - 1];
    eprintln!(
        "5,000-node scroll to the end ({} windows): first={first:?}, middle={middle:?}, last={last:?}",
        windows.len()
    );
    assert_eq!(windows.len(), 63);
    assert!(last < Duration::from_millis(100));
}

#[test]
fn the_deepest_fifty_thousand_node_window_is_bounded() {
    let storage = SqliteStorage::open_in_memory().expect("open fixture database");
    storage
        .load_performance_fixture(50_000)
        .expect("load fixture");
    storage.query_viewport(window(None, 80)).expect("prime");
    let started = Instant::now();
    // The fixture is revision 1, and 50,000 rows 80 at a time put the last
    // window at offset 49,920.
    let page = storage
        .query_viewport(window(Some("r:1:o:49920".into()), 80))
        .expect("deepest window");
    let elapsed = started.elapsed();
    eprintln!("50,000-node deepest window: {elapsed:?}");
    assert_eq!(page.nodes.len(), 80);
    assert!(page.after_cursor.is_none());
    // ponytail: every window re-walks the whole subtree, so a window's cost is
    // the page's size rather than the scroll depth -- ~25ms at 5,000 nodes but
    // ~270ms here, already past the 100ms scroll budget. This bound only holds
    // the measured cliff in place; materializing the sort-key path makes a
    // window a range scan and ends the re-walk.
    assert!(elapsed < Duration::from_secs(1));
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

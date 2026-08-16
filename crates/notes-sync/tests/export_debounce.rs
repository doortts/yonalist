//! When a change actually becomes a file.
//!
//! Writing on every keystroke would fill the sync folder with versions nobody
//! asked for and hand every other device a stream of edits. Waiting forever
//! would mean a note the user typed is not in their vault when they close the
//! laptop. The rule is: quiet for a moment, or long enough since the first
//! change — whichever comes first.
//!
//! The decision is a pure function so it can be tested with a clock that does
//! not tick, rather than with a test that sleeps.

use notes_sync::debounce::{Debounce, Decision};

const IDLE: u64 = 3_000;
const CEILING: u64 = 30_000;

fn debounce() -> Debounce {
    Debounce::new(IDLE, CEILING)
}

#[test]
fn a_document_exports_after_three_seconds_of_quiet() {
    let mut window = debounce();
    window.touched(1_000);

    assert_eq!(window.decide(2_000), Decision::Wait { until: 4_000 });
    assert_eq!(window.decide(4_000), Decision::Export);
}

/// Someone typing steadily would otherwise never see their notes reach the
/// vault, because every keystroke would push the quiet moment further away.
#[test]
fn a_document_exports_after_thirty_seconds_however_busy_it_is() {
    let mut window = debounce();
    window.touched(1_000);
    for at in (2_000..31_000).step_by(1_000) {
        window.touched(at);
        assert_eq!(
            window.decide(at),
            Decision::Wait {
                until: (at + IDLE).min(1_000 + CEILING)
            },
            "at {at}"
        );
    }

    assert_eq!(window.decide(31_000), Decision::Export);
}

#[test]
fn nothing_to_write_means_nothing_to_wait_for() {
    let mut window = debounce();

    assert_eq!(window.decide(1_000), Decision::Idle);

    window.touched(1_000);
    window.exported();
    assert_eq!(window.decide(9_999), Decision::Idle);
}

/// Closing the app, or asking for it directly, does not wait out a window.
#[test]
fn flush_ignores_the_debounce() {
    let mut window = debounce();
    window.touched(1_000);
    window.flush_requested();

    assert_eq!(window.decide(1_001), Decision::Export);
}

#[test]
fn a_flush_with_nothing_pending_still_has_nothing_to_do() {
    let mut window = debounce();
    window.flush_requested();

    assert_eq!(window.decide(1_000), Decision::Idle);
}

//! What the watcher holds between an event and a merge.
//!
//! A sync folder does not deliver one file at a time: a folder arriving from
//! another device lands as hundreds of events at once, and an editor saving a
//! file often produces several for the same path. So events for one path
//! collapse into one, and only one merge is ever in flight — a user typing must
//! not wait behind a hundred of them.

use notes_sync::watch_queue::WatchQueue;

const WINDOW: u64 = 500;

#[test]
fn events_for_one_path_coalesce_within_the_window() {
    let mut queue = WatchQueue::new(WINDOW);
    queue.saw("Projects/README.md", 1_000);
    queue.saw("Projects/README.md", 1_100);
    queue.saw("Projects/README.md", 1_400);

    // Still being written: the window runs from the *last* event, not the
    // first, or a file an editor is halfway through saving gets read.
    assert_eq!(queue.next_in_flight(1_400), None);
    assert_eq!(queue.next_in_flight(1_600), None);
    assert_eq!(
        queue.next_in_flight(1_900),
        Some("Projects/README.md".to_owned()),
        "an editor saving a file three times is one thing to read"
    );
}

#[test]
fn separate_paths_are_separate_work() {
    let mut queue = WatchQueue::new(WINDOW);
    queue.saw("a/README.md", 1_000);
    queue.saw("b/README.md", 1_000);

    let first = queue.next_in_flight(1_500).expect("something to do");
    queue.finished(&first);
    let second = queue.next_in_flight(1_500).expect("the other one");

    assert_eq!(
        vec![first, second],
        vec!["a/README.md".to_owned(), "b/README.md".to_owned()]
    );
}

/// A folder arriving from another device lands as hundreds of events. Handing
/// all of them to the worker at once would put a user's keystroke behind every
/// one, so the queue lets exactly one through and waits for it to come back.
#[test]
fn a_user_command_waits_behind_at_most_one_merge() {
    let mut queue = WatchQueue::new(WINDOW);
    for index in 0..100 {
        queue.saw(&format!("page-{index}/README.md"), 1_000);
    }

    let first = queue.next_in_flight(1_500).expect("something to do");
    assert_eq!(
        queue.next_in_flight(1_500),
        None,
        "the second one waits until the first comes back"
    );

    queue.finished(&first);
    assert!(queue.next_in_flight(1_500).is_some());
}

#[test]
fn nothing_seen_means_nothing_to_do() {
    let mut queue = WatchQueue::new(WINDOW);

    assert_eq!(queue.next_in_flight(9_999), None);
}

/// A path touched again while its merge is running is read again afterwards —
/// the bytes may well have changed since the read.
#[test]
fn a_path_touched_again_while_in_flight_is_read_again() {
    let mut queue = WatchQueue::new(WINDOW);
    queue.saw("Projects/README.md", 1_000);
    let path = queue.next_in_flight(1_500).expect("something to do");

    queue.saw("Projects/README.md", 1_600);
    queue.finished(&path);

    assert_eq!(
        queue.next_in_flight(2_200),
        Some("Projects/README.md".to_owned())
    );
}

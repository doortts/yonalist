//! What the watcher holds between an event and a merge.
//!
//! A sync folder does not deliver one file at a time. A folder arriving from
//! another device lands as hundreds of events at once, and an editor saving one
//! file often produces several for the same path. Two rules follow.
//!
//! Events for one path collapse into one piece of work, once the path has been
//! quiet for a moment — reading a file an editor is still writing gets a
//! half-written file.
//!
//! And exactly one merge is in flight at a time. The worker's queue is FIFO and
//! shared with everything the user does, so handing it a hundred merges would
//! put the next keystroke behind all of them. One at a time means the longest
//! anything waits is a single merge.

use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug)]
pub struct WatchQueue {
    quiet: u64,
    /// Path to the reading of the last event seen for it.
    pending: BTreeMap<String, u64>,
    /// Files nobody reported, which the verification pass wants read anyway.
    /// They wait behind everything in `pending`: what the user just typed is
    /// worth more than a check on a file nobody has touched, and the pass
    /// names every file in the folder.
    verifying: BTreeSet<String>,
    in_flight: Option<String>,
}

impl WatchQueue {
    pub fn new(quiet_millis: u64) -> Self {
        Self {
            quiet: quiet_millis,
            pending: BTreeMap::new(),
            verifying: BTreeSet::new(),
            in_flight: None,
        }
    }

    /// The watcher saw something happen to this path.
    pub fn saw(&mut self, path: &str, at: u64) {
        // An event says everything a check would have said and more, so the
        // check has nothing left to do.
        self.verifying.remove(path);
        self.pending.insert(path.to_owned(), at);
    }

    /// The verification pass wants this file read, whatever its stat says.
    /// No quiet window: nobody is writing these — that is the whole reason
    /// the pass exists — so there is no half-saved file to wait out.
    pub fn verify(&mut self, path: &str) {
        if !self.pending.contains_key(path) {
            self.verifying.insert(path.to_owned());
        }
    }

    /// The next path to merge, if nothing is already being merged and that path
    /// has been quiet long enough. Answering `None` while one is in flight is
    /// the back pressure: it is what keeps a user's command from queuing behind
    /// a folder's worth of them. It is also the only way work leaves this
    /// queue — a second way out would be a second way past that rule.
    pub fn next_in_flight(&mut self, now: u64) -> Option<String> {
        if self.in_flight.is_some() {
            return None;
        }
        // One path, not the whole ready set: draining them here would take work
        // off the queue that nothing is going to do yet.
        let reported = self
            .pending
            .iter()
            .find(|(_, seen)| now.saturating_sub(**seen) >= self.quiet)
            .map(|(path, _)| path.clone());
        let path = match reported {
            Some(path) => {
                self.pending.remove(&path);
                path
            }
            // Only once nothing reported is waiting.
            None => {
                let path = self.verifying.iter().next().cloned()?;
                self.verifying.remove(&path);
                path
            }
        };
        self.in_flight = Some(path.clone());
        Some(path)
    }

    /// That merge came back. A path touched while it was running is still
    /// waiting, because its bytes may have changed since they were read.
    pub fn finished(&mut self, path: &str) {
        if self.in_flight.as_deref() == Some(path) {
            self.in_flight = None;
        }
    }
}

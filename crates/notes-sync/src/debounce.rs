//! When a change becomes a file.
//!
//! Writing on every keystroke would fill the sync folder with versions nobody
//! asked for and hand every other device a stream of edits to merge. Waiting
//! for quiet alone would mean someone typing steadily never sees their notes
//! reach the vault at all. So: a moment of quiet, or long enough since the
//! first change — whichever comes first.
//!
//! This is a plain calculation over milliseconds handed in from outside, so the
//! runtime can be tested with a clock that does not tick rather than with a
//! test that sleeps.

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Decision {
    /// Nothing is waiting to go out.
    Idle,
    /// Something is, but not yet — sleep until this reading and ask again.
    Wait {
        until: u64,
    },
    Export,
}

#[derive(Clone, Debug)]
pub struct Debounce {
    idle: u64,
    ceiling: u64,
    first_change: Option<u64>,
    last_change: u64,
    flush: bool,
}

impl Debounce {
    pub fn new(idle_millis: u64, ceiling_millis: u64) -> Self {
        Self {
            idle: idle_millis,
            ceiling: ceiling_millis,
            first_change: None,
            last_change: 0,
            flush: false,
        }
    }

    /// Something changed, at this reading.
    pub fn touched(&mut self, at: u64) {
        if self.first_change.is_none() {
            // A flush asked for while nothing was waiting is spent: it cannot
            // sit there and skip the window for whatever is typed next.
            self.flush = false;
        }
        self.first_change.get_or_insert(at);
        self.last_change = at;
    }

    /// Asked for directly, or by the app closing. A flush does not wait out a
    /// window — but it has nothing to do if nothing changed.
    pub fn flush_requested(&mut self) {
        self.flush = true;
    }

    /// Everything pending has gone out.
    pub fn exported(&mut self) {
        self.first_change = None;
        self.flush = false;
    }

    pub fn decide(&self, now: u64) -> Decision {
        let Some(first) = self.first_change else {
            return Decision::Idle;
        };
        if self.flush {
            return Decision::Export;
        }
        let quiet_at = self.last_change.saturating_add(self.idle);
        let latest = first.saturating_add(self.ceiling);
        let due = quiet_at.min(latest);
        if now >= due {
            Decision::Export
        } else {
            Decision::Wait { until: due }
        }
    }
}

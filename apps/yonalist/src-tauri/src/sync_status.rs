//! What sync cannot do right now.
//!
//! Two slots, kept apart on purpose: a successful export saying nothing about
//! the watch would be a lie about the one that failed. They live in memory
//! rather than the database because they are about this run of the app — a
//! folder that could not be watched at 9am is not news at noon if it is being
//! watched now.
//!
//! Setting one answers whether anything actually changed. A failing export
//! runs every thirty seconds; pinging the window each time would have it ask
//! the same question over and over for an answer it already has.

use std::sync::Mutex;

#[derive(Debug, Default)]
pub(crate) struct SyncErrors {
    write: Mutex<Option<String>>,
    watch: Mutex<Option<String>>,
}

impl SyncErrors {
    /// Answers whether this is news.
    pub(crate) fn set_write(&self, error: Option<String>) -> bool {
        Self::replace(&self.write, error)
    }

    pub(crate) fn set_watch(&self, error: Option<String>) -> bool {
        Self::replace(&self.watch, error)
    }

    pub(crate) fn write_error(&self) -> Option<String> {
        self.write.lock().ok().and_then(|held| held.clone())
    }

    pub(crate) fn watch_error(&self) -> Option<String> {
        self.watch.lock().ok().and_then(|held| held.clone())
    }

    fn replace(slot: &Mutex<Option<String>>, error: Option<String>) -> bool {
        let Ok(mut held) = slot.lock() else {
            // A poisoned lock is a thread that panicked while holding it. The
            // window learning nothing is better than this one panicking too.
            return false;
        };
        if *held == error {
            return false;
        }
        *held = error;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::SyncErrors;

    #[test]
    fn the_same_failure_twice_is_news_once() {
        let errors = SyncErrors::default();

        assert!(errors.set_write(Some("the disk is full".to_owned())));
        assert!(!errors.set_write(Some("the disk is full".to_owned())));
        assert_eq!(errors.write_error().as_deref(), Some("the disk is full"));
    }

    #[test]
    fn recovering_is_news_too() {
        let errors = SyncErrors::default();
        errors.set_write(Some("the disk is full".to_owned()));

        assert!(errors.set_write(None));
        assert_eq!(errors.write_error(), None);
    }

    /// A write that works again says nothing about a folder nobody is
    /// watching.
    #[test]
    fn the_two_failures_do_not_clear_each_other() {
        let errors = SyncErrors::default();
        errors.set_watch(Some("the folder is not there".to_owned()));

        errors.set_write(None);

        assert_eq!(
            errors.watch_error().as_deref(),
            Some("the folder is not there")
        );
    }
}

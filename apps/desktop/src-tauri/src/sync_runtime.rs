//! The thread that turns edits into files.
//!
//! Every command that changes something pokes this thread. It does not export
//! on the poke: it waits for the typing to stop, or for long enough since the
//! first change, whichever comes first — `Debounce` holds that rule and this
//! module only obeys it. Sleeping until the reading the rule names, rather than
//! polling, is why an idle app costs nothing.
//!
//! Exports run here and nowhere else, so two of them can never overlap and the
//! caller of a command never waits for a file to be written. A flush is the one
//! exception the user can feel: closing the app asks for one and waits, because
//! quitting with edits still only in the database is how notes go missing.

use notes_sync::debounce::{Debounce, Decision};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, SyncSender, channel, sync_channel};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// Long enough that a pause in typing is a real pause.
const IDLE_MILLIS: u64 = 3_000;
/// And short enough that someone typing steadily still sees their notes reach
/// the vault.
const CEILING_MILLIS: u64 = 30_000;

enum Signal {
    /// Something changed.
    Touched,
    /// Write what is waiting, now. The sender is told when it is done — that is
    /// the whole point of asking.
    Flush(SyncSender<()>),
}

pub(crate) struct SyncRuntime {
    signals: Sender<Signal>,
    thread: Option<JoinHandle<()>>,
}

impl SyncRuntime {
    /// `export` is everything this thread knows how to do. It is handed in so
    /// the schedule can be tested without a vault, and so this module owns no
    /// part of what an export actually means.
    pub(crate) fn start(export: impl FnMut() + Send + 'static) -> Self {
        Self::with_windows(IDLE_MILLIS, CEILING_MILLIS, export)
    }

    fn with_windows(idle: u64, ceiling: u64, mut export: impl FnMut() + Send + 'static) -> Self {
        let (signals, inbox) = channel();
        let thread = std::thread::Builder::new()
            .name("yonalist-sync-export".to_owned())
            .spawn(move || run(&inbox, Debounce::new(idle, ceiling), &mut export))
            .expect("the export thread could not be started");
        Self {
            signals,
            thread: Some(thread),
        }
    }

    /// Something changed. Cheap enough to call from every command, because all
    /// it does is wake a sleeping thread.
    pub(crate) fn poke(&self) {
        let _ = self.signals.send(Signal::Touched);
    }

    /// Write what is waiting and wait for it. A dead thread answers
    /// immediately: refusing to return would hang the app on quit, and there is
    /// nothing left that could do the writing anyway.
    pub(crate) fn flush(&self) {
        let (done, wait) = sync_channel(0);
        if self.signals.send(Signal::Flush(done)).is_ok() {
            let _ = wait.recv();
        }
    }
}

impl Drop for SyncRuntime {
    /// Closing the app is a flush. Dropping the sender is what ends the loop,
    /// and the loop writes whatever is still waiting before it returns — so
    /// quitting mid-sentence still puts that sentence in the vault.
    fn drop(&mut self) {
        drop(std::mem::replace(&mut self.signals, channel().0));
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn run(inbox: &Receiver<Signal>, mut debounce: Debounce, export: &mut impl FnMut()) {
    let started = Instant::now();
    let now = || started.elapsed().as_millis() as u64;
    loop {
        let waiting_for = match debounce.decide(now()) {
            Decision::Export => {
                export();
                debounce.exported();
                continue;
            }
            // Nothing pending: sleep until something arrives, however long that
            // takes. There is no work a timeout could find.
            Decision::Idle => None,
            Decision::Wait { until } => Some(Duration::from_millis(until.saturating_sub(now()))),
        };
        let signal = match waiting_for {
            Some(timeout) => match inbox.recv_timeout(timeout) {
                Ok(signal) => signal,
                // The window closed. Round again, where `decide` says export.
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => break,
            },
            None => match inbox.recv() {
                Ok(signal) => signal,
                Err(_) => break,
            },
        };
        match signal {
            Signal::Touched => debounce.touched(now()),
            Signal::Flush(done) => {
                debounce.flush_requested();
                if matches!(debounce.decide(now()), Decision::Export) {
                    export();
                    debounce.exported();
                }
                // After the writing, so that whoever asked knows the files are
                // there when they hear back.
                let _ = done.send(());
            }
        }
    }
    // The app is closing. Whatever the window was still holding goes out now.
    debounce.flush_requested();
    if matches!(debounce.decide(now()), Decision::Export) {
        export();
    }
}

#[cfg(test)]
mod tests {
    use super::SyncRuntime;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    fn counter() -> (Arc<AtomicUsize>, impl FnMut() + Send + 'static) {
        let count = Arc::new(AtomicUsize::new(0));
        let writer = Arc::clone(&count);
        (count, move || {
            writer.fetch_add(1, Ordering::SeqCst);
        })
    }

    fn eventually(count: &AtomicUsize, at_least: usize) -> bool {
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if count.load(Ordering::SeqCst) >= at_least {
                return true;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        false
    }

    #[test]
    fn a_poke_reaches_the_vault_once_the_typing_stops() {
        let (count, export) = counter();
        let runtime = SyncRuntime::with_windows(20, 200, export);

        runtime.poke();

        assert!(
            eventually(&count, 1),
            "an edit nobody follows up on still has to be written"
        );
    }

    #[test]
    fn steady_typing_still_reaches_the_vault_at_the_ceiling() {
        let (count, export) = counter();
        // Never quiet for the idle window: only the ceiling can fire.
        let runtime = SyncRuntime::with_windows(10_000, 60, export);

        let until = Instant::now() + Duration::from_millis(300);
        while Instant::now() < until {
            runtime.poke();
            std::thread::sleep(Duration::from_millis(5));
        }

        assert!(
            count.load(Ordering::SeqCst) >= 1,
            "someone typing without pause would otherwise never see their notes leave this device"
        );
    }

    #[test]
    fn nothing_is_written_while_nothing_has_changed() {
        let (count, export) = counter();
        let _runtime = SyncRuntime::with_windows(5, 10, export);

        std::thread::sleep(Duration::from_millis(60));

        assert_eq!(
            count.load(Ordering::SeqCst),
            0,
            "an idle app rewriting the vault would hand every other device edits nobody made"
        );
    }

    #[test]
    fn a_flush_does_not_wait_out_the_window() {
        let (count, export) = counter();
        let runtime = SyncRuntime::with_windows(60_000, 60_000, export);

        runtime.poke();
        runtime.flush();

        assert_eq!(
            count.load(Ordering::SeqCst),
            1,
            "a flush that returns before the writing tells the caller a lie"
        );
    }

    #[test]
    fn closing_the_app_writes_what_is_still_waiting() {
        let (count, export) = counter();
        let runtime = SyncRuntime::with_windows(60_000, 60_000, export);
        runtime.poke();

        drop(runtime);

        assert_eq!(
            count.load(Ordering::SeqCst),
            1,
            "quitting mid-sentence is how that sentence goes missing"
        );
    }

    #[test]
    fn exports_never_overlap() {
        let overlapping = Arc::new(Mutex::new(false));
        let inside = Arc::new(AtomicUsize::new(0));
        let done = Arc::new(AtomicUsize::new(0));
        let (seen, counting, finished) = (
            Arc::clone(&overlapping),
            Arc::clone(&inside),
            Arc::clone(&done),
        );
        let runtime = SyncRuntime::with_windows(5, 20, move || {
            if counting.fetch_add(1, Ordering::SeqCst) > 0 {
                *seen.lock().expect("overlap flag") = true;
            }
            std::thread::sleep(Duration::from_millis(15));
            counting.fetch_sub(1, Ordering::SeqCst);
            finished.fetch_add(1, Ordering::SeqCst);
        });

        for _ in 0..20 {
            runtime.poke();
            std::thread::sleep(Duration::from_millis(3));
        }
        assert!(eventually(&done, 1));

        assert!(
            !*overlapping.lock().expect("overlap flag"),
            "two exports at once would have them fighting over the same files"
        );
    }
}

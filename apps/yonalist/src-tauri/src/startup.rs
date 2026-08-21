use std::sync::{Arc, Condvar, Mutex};

enum StartupStatus<T, E> {
    Pending,
    Ready(Arc<T>),
    Failed(E),
}

pub(crate) struct StartupGate<T, E> {
    status: Mutex<StartupStatus<T, E>>,
    ready: Condvar,
}

impl<T, E: Clone> StartupGate<T, E> {
    pub(crate) fn pending() -> Self {
        Self {
            status: Mutex::new(StartupStatus::Pending),
            ready: Condvar::new(),
        }
    }

    pub(crate) fn complete(&self, result: Result<T, E>) {
        let mut status = self.status.lock().expect("startup gate lock poisoned");
        *status = match result {
            Ok(value) => StartupStatus::Ready(Arc::new(value)),
            Err(error) => StartupStatus::Failed(error),
        };
        self.ready.notify_all();
    }

    pub(crate) fn wait(&self) -> Result<Arc<T>, E> {
        let mut status = self.status.lock().expect("startup gate lock poisoned");
        loop {
            match &*status {
                StartupStatus::Pending => {
                    status = self.ready.wait(status).expect("startup gate lock poisoned");
                }
                StartupStatus::Ready(value) => return Ok(Arc::clone(value)),
                StartupStatus::Failed(error) => return Err(error.clone()),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::thread;
    use std::time::Duration;

    use super::StartupGate;

    #[test]
    fn waiters_receive_the_background_startup_result() {
        let gate = Arc::new(StartupGate::<u64, String>::pending());
        let producer = Arc::clone(&gate);
        let worker = thread::spawn(move || {
            thread::sleep(Duration::from_millis(5));
            producer.complete(Ok(42));
        });

        assert_eq!(*gate.wait().expect("startup result"), 42);
        assert_eq!(*gate.wait().expect("cached startup result"), 42);
        worker.join().expect("worker");
    }
}

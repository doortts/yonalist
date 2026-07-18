use std::{
    ffi::{OsStr, OsString},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

use crate::{SyncError, SyncErrorCode};

const MINIMUM_GIT_VERSION: GitVersion = GitVersion::new(2, 49, 0);

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub(crate) struct GitVersion {
    major: u32,
    minor: u32,
    patch: u32,
}

impl GitVersion {
    pub(crate) const fn new(major: u32, minor: u32, patch: u32) -> Self {
        Self {
            major,
            minor,
            patch,
        }
    }
}

pub(crate) struct GitRuntime {
    executable: PathBuf,
    #[allow(dead_code)]
    version: GitVersion,
}

impl GitRuntime {
    pub(crate) fn probe(executable: &Path) -> Result<Self, SyncError> {
        let exit = execute(
            executable,
            None,
            &[OsString::from("--version")],
            None,
            &[],
            &GitExecLimits::default(),
        )
        .map_err(|error| git_unavailable(error.message))?;
        let stdout = match exit {
            GitExit::Success(stdout) => stdout,
            GitExit::Code { stderr, .. } => {
                let message = bounded_message(&stderr, GitExecLimits::default().max_stderr_bytes);
                return Err(git_unavailable(if message.is_empty() {
                    "Git --version failed".into()
                } else {
                    message
                }));
            }
        };
        let version = parse_git_version(&stdout)?;
        Ok(Self {
            executable: executable.to_path_buf(),
            version,
        })
    }

    pub(crate) fn executable(&self) -> &Path {
        &self.executable
    }
}

#[derive(Debug)]
pub(crate) enum GitExit {
    Success(Vec<u8>),
    Code {
        code: i32,
        stdout: Vec<u8>,
        stderr: Vec<u8>,
    },
}

pub(crate) struct GitExecLimits {
    pub max_stdout_bytes: usize,
    pub max_stderr_bytes: usize,
    pub timeout: Duration,
}

impl Default for GitExecLimits {
    fn default() -> Self {
        Self {
            max_stdout_bytes: 8 * 1024 * 1024,
            max_stderr_bytes: 256 * 1024,
            timeout: Duration::from_secs(30),
        }
    }
}

pub(crate) struct GitCommand {
    executable: PathBuf,
    repo: PathBuf,
}

impl GitCommand {
    pub(crate) fn executable(&self) -> PathBuf {
        self.executable.clone()
    }
    pub(crate) fn new(executable: &Path, repo: &Path) -> Self {
        Self {
            executable: executable.to_path_buf(),
            repo: repo.to_path_buf(),
        }
    }

    pub(crate) fn init(executable: &Path, repo: &Path) -> Result<(), SyncError> {
        let args = [
            OsString::from("init"),
            OsString::from("--bare"),
            OsString::from("--object-format=sha256"),
            repo.as_os_str().to_owned(),
        ];
        checked(execute(
            executable,
            None,
            &args,
            None,
            &[],
            &GitExecLimits::default(),
        )?)?;
        Ok(())
    }

    pub(crate) fn run(
        &self,
        args: &[OsString],
        stdin: Option<&[u8]>,
    ) -> Result<Vec<u8>, SyncError> {
        checked(self.run_status(args, stdin, &GitExecLimits::default())?)
    }

    pub(crate) fn run_status(
        &self,
        args: &[OsString],
        stdin: Option<&[u8]>,
        limits: &GitExecLimits,
    ) -> Result<GitExit, SyncError> {
        execute(&self.executable, Some(&self.repo), args, stdin, &[], limits)
    }

    pub(crate) fn run_at(
        &self,
        repo: &Path,
        args: &[OsString],
        stdin: Option<&[u8]>,
    ) -> Result<Vec<u8>, SyncError> {
        checked(execute(
            &self.executable,
            Some(repo),
            args,
            stdin,
            &[],
            &GitExecLimits::default(),
        )?)
    }

    pub(crate) fn run_with_envs(
        &self,
        args: &[OsString],
        stdin: Option<&[u8]>,
        envs: &[(&OsStr, &OsStr)],
    ) -> Result<Vec<u8>, SyncError> {
        checked(execute(
            &self.executable,
            Some(&self.repo),
            args,
            stdin,
            envs,
            &GitExecLimits::default(),
        )?)
    }
}

fn execute(
    executable: &Path,
    repo: Option<&Path>,
    args: &[OsString],
    stdin: Option<&[u8]>,
    envs: &[(&OsStr, &OsStr)],
    limits: &GitExecLimits,
) -> Result<GitExit, SyncError> {
    let mut command = base_command(executable);
    if let Some(repo) = repo {
        command.arg(git_dir_arg(repo));
    }
    command.args(args).envs(envs.iter().copied());
    command.stdin(if stdin.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    });
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut process = ProcessTreeChild::spawn(&mut command).map_err(unavailable)?;
    let child_stdin = process.child.stdin.take();
    let child_stdout = process.child.stdout.take().expect("stdout is piped");
    let child_stderr = process.child.stderr.take().expect("stderr is piped");
    let began = Instant::now();
    let (overflow_tx, overflow_rx) = mpsc::channel();

    let (outcome, stdin_result, stdout_result, stderr_result) = thread::scope(|scope| {
        let stdin_worker = scope.spawn(move || write_input(child_stdin, stdin));
        let stdout_tx = overflow_tx.clone();
        let stdout_worker =
            scope.spawn(move || drain_bounded(child_stdout, limits.max_stdout_bytes, stdout_tx));
        let stderr_worker =
            scope.spawn(move || drain_bounded(child_stderr, limits.max_stderr_bytes, overflow_tx));

        let outcome = loop {
            if overflow_rx.try_recv().is_ok() {
                terminate_and_reap(&mut process)?;
                break ProcessOutcome::OutputLimit;
            }
            match process.exit_observed_without_reaping() {
                Ok(true) => break ProcessOutcome::Exited(terminate_and_reap(&mut process)?),
                Ok(false) => {}
                Err(error) => return Err(error),
            }
            if began.elapsed() >= limits.timeout {
                terminate_and_reap(&mut process)?;
                break ProcessOutcome::Timeout;
            }
            thread::sleep(Duration::from_millis(10));
        };

        Ok::<_, SyncError>((
            outcome,
            join_worker(stdin_worker)?,
            join_worker(stdout_worker)?,
            join_worker(stderr_worker)?,
        ))
    })?;

    let stdout = stdout_result.map_err(io)?;
    let stderr = stderr_result.map_err(io)?;
    if stdout.overflowed || stderr.overflowed || matches!(outcome, ProcessOutcome::OutputLimit) {
        return Err(output_limit(&stderr.bytes, limits.max_stderr_bytes));
    }
    if matches!(outcome, ProcessOutcome::Timeout) {
        return Err(SyncError {
            code: SyncErrorCode::GitCommandFailed,
            message: format!(
                "Git command timed out after {} ms",
                limits.timeout.as_millis()
            ),
        });
    }

    let status = match outcome {
        ProcessOutcome::Exited(status) => status,
        ProcessOutcome::OutputLimit | ProcessOutcome::Timeout => unreachable!(),
    };
    if status.success() {
        stdin_result.map_err(io)?;
        Ok(GitExit::Success(stdout.bytes))
    } else {
        Ok(GitExit::Code {
            code: status.code().unwrap_or(-1),
            stdout: stdout.bytes,
            stderr: stderr.bytes,
        })
    }
}

enum ProcessOutcome {
    Exited(ExitStatus),
    OutputLimit,
    Timeout,
}

struct BoundedOutput {
    bytes: Vec<u8>,
    overflowed: bool,
}

fn write_input(
    stdin: Option<std::process::ChildStdin>,
    bytes: Option<&[u8]>,
) -> std::io::Result<()> {
    if let (Some(mut stdin), Some(bytes)) = (stdin, bytes) {
        stdin.write_all(bytes)?;
    }
    Ok(())
}

fn drain_bounded(
    mut stream: impl Read,
    limit: usize,
    overflow: mpsc::Sender<()>,
) -> std::io::Result<BoundedOutput> {
    let mut bytes = Vec::with_capacity(limit.min(8 * 1024));
    let mut buffer = [0_u8; 8 * 1024];
    let mut overflowed = false;
    loop {
        let read = stream.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        let retained_end = checked_retained_end(bytes.len(), read, limit)?;
        let retained = retained_end.checked_sub(bytes.len()).ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Git retained-output accounting underflowed",
            )
        })?;
        bytes.extend_from_slice(&buffer[..retained]);
        if retained < read && !overflowed {
            overflowed = true;
            let _ = overflow.send(());
        }
    }
    Ok(BoundedOutput { bytes, overflowed })
}

fn checked_retained_end(retained: usize, read: usize, limit: usize) -> std::io::Result<usize> {
    let remaining = limit.checked_sub(retained).ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Git retained output exceeded its configured limit",
        )
    })?;
    retained.checked_add(read.min(remaining)).ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Git retained-output accounting overflowed",
        )
    })
}

struct ProcessTreeChild {
    child: Child,
    #[cfg(unix)]
    process_group: libc::pid_t,
    #[cfg(windows)]
    job: windows_process_tree::Job,
}

impl ProcessTreeChild {
    #[cfg(unix)]
    fn spawn(command: &mut Command) -> std::io::Result<Self> {
        use std::os::unix::process::CommandExt;

        command.process_group(0);
        let child = command.spawn()?;
        let process_group = libc::pid_t::try_from(child.id()).map_err(|_| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Git child PID does not fit a Unix process-group ID",
            )
        })?;
        #[cfg(test)]
        let mut child = child;
        #[cfg(test)]
        if let Some(path) = std::env::var_os("YONALIST_TEST_EXECUTOR_PGID_FILE") {
            if let Err(error) = std::fs::write(path, process_group.to_string()) {
                // A test watchdog must never lose the exact group it owns. If
                // the handoff file cannot be written, contain the just-spawned
                // fixture before returning the setup error.
                let _ = unsafe { libc::killpg(process_group, libc::SIGKILL) };
                let _ = child.wait();
                return Err(error);
            }
        }
        Ok(Self {
            child,
            process_group,
        })
    }

    #[cfg(windows)]
    fn spawn(command: &mut Command) -> std::io::Result<Self> {
        let (child, job) = windows_process_tree::spawn_suspended_in_job(command)?;
        Ok(Self { child, job })
    }

    #[cfg(unix)]
    fn exit_observed_without_reaping(&mut self) -> Result<bool, SyncError> {
        let child_id = libc::id_t::try_from(self.process_group).map_err(|_| {
            io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Git child PID does not fit a Unix wait ID",
            ))
        })?;
        loop {
            let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
            let result = unsafe {
                libc::waitid(
                    libc::P_PID,
                    child_id,
                    info.as_mut_ptr(),
                    libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                )
            };
            if result == 0 {
                let info = unsafe { info.assume_init() };
                return Ok(unsafe { info.si_pid() } != 0);
            }
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::EINTR) {
                return Err(io(error));
            }
        }
    }

    #[cfg(windows)]
    fn exit_observed_without_reaping(&mut self) -> Result<bool, SyncError> {
        self.child
            .try_wait()
            .map(|status| status.is_some())
            .map_err(io)
    }

    #[cfg(unix)]
    fn terminate_tree(&mut self, leader_exited: bool) -> Result<(), SyncError> {
        // Every Git command leads its own process group, so descendants holding
        // inherited pipe handles are killed before any wait or worker join.
        loop {
            let result = unsafe { libc::killpg(self.process_group, libc::SIGKILL) };
            if result == 0 {
                return Ok(());
            }
            let error = std::io::Error::last_os_error();
            match error.raw_os_error() {
                Some(libc::EINTR) => continue,
                Some(libc::ESRCH) => return Ok(()),
                // macOS reports EPERM for a group containing only its zombie
                // leader. The WNOWAIT observation keeps that PGID reserved.
                Some(libc::EPERM) if leader_exited || self.exit_observed_without_reaping()? => {
                    return Ok(())
                }
                _ => return Err(io(error)),
            }
        }
    }

    #[cfg(windows)]
    fn terminate_tree(&mut self, _leader_exited: bool) -> Result<(), SyncError> {
        self.job.terminate().map_err(io)
    }
}

fn terminate_and_reap(process: &mut ProcessTreeChild) -> Result<ExitStatus, SyncError> {
    // A successful non-reaping probe proves that the child still reserves this
    // PID/PGID. On ECHILD or any other probe failure, never signal the group.
    let leader_exited = process.exit_observed_without_reaping()?;
    let termination = process.terminate_tree(leader_exited);
    let status = process.child.wait().map_err(io)?;
    termination?;
    Ok(status)
}

#[cfg(windows)]
mod windows_process_tree {
    use std::{
        mem::size_of,
        os::windows::{
            io::{AsRawHandle, FromRawHandle, OwnedHandle},
            process::CommandExt,
        },
        process::{Child, Command},
        ptr::null,
    };

    use windows_sys::Win32::{
        Foundation::{HANDLE, INVALID_HANDLE_VALUE},
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD,
                THREADENTRY32,
            },
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
            Threading::{OpenThread, ResumeThread, CREATE_SUSPENDED, THREAD_SUSPEND_RESUME},
        },
    };

    pub(super) struct Job(OwnedHandle);

    impl Job {
        fn new() -> std::io::Result<Self> {
            // The Windows API returns an owned job handle on success.
            let raw = unsafe { CreateJobObjectW(null(), null()) };
            let handle = owned_handle(raw)?;
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            // The input points to a fully initialized value for the duration of the call.
            let configured = unsafe {
                SetInformationJobObject(
                    handle.as_raw_handle() as HANDLE,
                    JobObjectExtendedLimitInformation,
                    (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    u32::try_from(size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>())
                        .expect("Windows job limits fit u32"),
                )
            };
            if configured == 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(Self(handle))
        }

        fn assign(&self, child: &Child) -> std::io::Result<()> {
            // Child owns this valid process handle until it is dropped.
            let assigned = unsafe {
                AssignProcessToJobObject(
                    self.0.as_raw_handle() as HANDLE,
                    child.as_raw_handle() as HANDLE,
                )
            };
            if assigned == 0 {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(())
            }
        }

        pub(super) fn terminate(&self) -> std::io::Result<()> {
            // TerminateJobObject atomically terminates every current job member.
            let terminated = unsafe { TerminateJobObject(self.0.as_raw_handle() as HANDLE, 1) };
            if terminated == 0 {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(())
            }
        }
    }

    pub(super) fn spawn_suspended_in_job(command: &mut Command) -> std::io::Result<(Child, Job)> {
        let job = Job::new()?;
        // Suspension closes the spawn-to-assignment race: Git cannot create a
        // descendant before it belongs to the kill-on-close job.
        command.creation_flags(CREATE_SUSPENDED);
        let mut child = command.spawn()?;
        let setup = job
            .assign(&child)
            .and_then(|()| resume_only_thread(child.id()));
        if let Err(error) = setup {
            let _ = job.terminate();
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        Ok((child, job))
    }

    fn resume_only_thread(process_id: u32) -> std::io::Result<()> {
        // CREATE_SUSPENDED guarantees the new process still has only its
        // initial thread while this snapshot is inspected.
        let snapshot_raw = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
        if snapshot_raw == INVALID_HANDLE_VALUE {
            return Err(std::io::Error::last_os_error());
        }
        let snapshot = owned_handle(snapshot_raw)?;
        let mut entry = THREADENTRY32 {
            dwSize: u32::try_from(size_of::<THREADENTRY32>()).expect("THREADENTRY32 fits u32"),
            ..THREADENTRY32::default()
        };
        // Snapshot and entry are valid and remain alive for the enumeration.
        if unsafe { Thread32First(snapshot.as_raw_handle() as HANDLE, &mut entry) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        let thread_id = loop {
            if entry.th32OwnerProcessID == process_id {
                break entry.th32ThreadID;
            }
            if unsafe { Thread32Next(snapshot.as_raw_handle() as HANDLE, &mut entry) } == 0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "suspended Git primary thread was not found",
                ));
            }
        };
        // The returned thread handle is owned and requests only resume access.
        let thread = owned_handle(unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, thread_id) })?;
        // ResumeThread is called once for the one CREATE_SUSPENDED count.
        if unsafe { ResumeThread(thread.as_raw_handle() as HANDLE) } == u32::MAX {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }

    fn owned_handle(raw: HANDLE) -> std::io::Result<OwnedHandle> {
        if raw.is_null() || raw == INVALID_HANDLE_VALUE {
            return Err(std::io::Error::last_os_error());
        }
        // Each successful Win32 call above transfers exactly one owned handle.
        Ok(unsafe { OwnedHandle::from_raw_handle(raw.cast()) })
    }
}

fn join_worker<T>(worker: thread::ScopedJoinHandle<'_, T>) -> Result<T, SyncError> {
    worker.join().map_err(|_| SyncError {
        code: SyncErrorCode::Io,
        message: "Git pipe worker panicked".into(),
    })
}

fn parse_git_version(stdout: &[u8]) -> Result<GitVersion, SyncError> {
    let text = std::str::from_utf8(stdout).map_err(|_| git_unavailable("invalid Git version"))?;
    let version_text = text
        .trim()
        .strip_prefix("git version ")
        .ok_or_else(|| git_unavailable("invalid Git version"))?;
    let (major, remainder) = version_text
        .split_once('.')
        .ok_or_else(|| git_unavailable("invalid Git version"))?;
    let (minor, patch_and_suffix) = remainder
        .split_once('.')
        .ok_or_else(|| git_unavailable("invalid Git version"))?;
    let patch_end = patch_and_suffix
        .find(|character: char| !character.is_ascii_digit())
        .unwrap_or(patch_and_suffix.len());
    let (patch, suffix) = patch_and_suffix.split_at(patch_end);
    if patch.is_empty() || !valid_git_version_suffix(suffix) {
        return Err(git_unavailable("invalid Git version"));
    }
    let parse = |component: &str| {
        component
            .parse::<u32>()
            .map_err(|_| git_unavailable("invalid Git version"))
    };
    let version = GitVersion::new(parse(major)?, parse(minor)?, parse(patch)?);
    if version < MINIMUM_GIT_VERSION {
        return Err(git_unavailable("Git 2.49 or newer is required"));
    }
    Ok(version)
}

fn valid_git_version_suffix(suffix: &str) -> bool {
    if suffix.is_empty() {
        return true;
    }
    if let Some(build) = suffix.strip_prefix(".windows.") {
        return valid_numeric_build(build);
    }
    suffix
        .strip_prefix(" (Apple Git-")
        .and_then(|build| build.strip_suffix(')'))
        .is_some_and(valid_numeric_build)
}

fn valid_numeric_build(build: &str) -> bool {
    !build.is_empty()
        && build.split('.').all(|component| {
            !component.is_empty() && component.bytes().all(|byte| byte.is_ascii_digit())
        })
}

fn checked(exit: GitExit) -> Result<Vec<u8>, SyncError> {
    match exit {
        GitExit::Success(stdout) => Ok(stdout),
        GitExit::Code { stdout, stderr, .. } => {
            drop(stdout);
            Err(failed(&stderr))
        }
    }
}

fn base_command(executable: &Path) -> Command {
    let mut command = Command::new(executable);
    for (key, _) in std::env::vars_os() {
        if is_inherited_git_key(&key, cfg!(windows)) {
            command.env_remove(key);
        }
    }
    command.env("GIT_CONFIG_NOSYSTEM", "1");
    command.env(
        "GIT_CONFIG_GLOBAL",
        if cfg!(windows) { "NUL" } else { "/dev/null" },
    );
    command.env("GIT_TERMINAL_PROMPT", "0");
    command.env("GIT_OPTIONAL_LOCKS", "0");
    command.env("LC_ALL", "C");
    command.env("GIT_AUTHOR_NAME", "Yonalist Sync");
    command.env("GIT_AUTHOR_EMAIL", "sync@yonalist.invalid");
    command.env("GIT_COMMITTER_NAME", "Yonalist Sync");
    command.env("GIT_COMMITTER_EMAIL", "sync@yonalist.invalid");
    command
}

fn is_inherited_git_key(key: &OsStr, windows: bool) -> bool {
    let Some(prefix) = key.as_encoded_bytes().get(..4) else {
        return false;
    };
    if windows {
        prefix.eq_ignore_ascii_case(b"GIT_")
    } else {
        prefix == b"GIT_"
    }
}

fn git_dir_arg(repo: &Path) -> OsString {
    let mut arg = OsString::from("--git-dir=");
    arg.push(repo.as_os_str());
    arg
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use std::{
        os::unix::{
            ffi::{OsStrExt, OsStringExt},
            fs::PermissionsExt,
        },
        process::Command,
        thread,
        time::{Duration, Instant},
    };

    use super::*;

    #[cfg(unix)]
    #[test]
    fn git_dir_argument_preserves_non_utf8_path_bytes() {
        let path = PathBuf::from(OsString::from_vec(b"/tmp/repo-\xff".to_vec()));
        assert_eq!(git_dir_arg(&path).as_bytes(), b"--git-dir=/tmp/repo-\xff");
    }

    #[test]
    fn parses_and_enforces_the_minimum_git_version() {
        assert_eq!(
            parse_git_version(b"git version 2.49.0\n").unwrap(),
            GitVersion::new(2, 49, 0)
        );
        assert_eq!(
            parse_git_version(b"git version 2.49.0.windows.1\n").unwrap(),
            GitVersion::new(2, 49, 0)
        );
        assert_eq!(
            parse_git_version(b"git version 2.50.1 (Apple Git-155)\n").unwrap(),
            GitVersion::new(2, 50, 1)
        );
        assert_eq!(
            parse_git_version(b"git version 2.50.1.windows.1\n").unwrap(),
            GitVersion::new(2, 50, 1)
        );
        assert_eq!(
            parse_git_version(b"git version 2.48.9\n").unwrap_err().code,
            SyncErrorCode::GitUnavailable
        );
        assert_eq!(
            parse_git_version(b"not git\n").unwrap_err().code,
            SyncErrorCode::GitUnavailable
        );
        for malformed in [
            &b"git version 2.50.1 vendor\n"[..],
            &b"git version 2.50.1.windows\n"[..],
            &b"git version 2.50.1.windows.one\n"[..],
            &b"git version 2.50.1 (Apple Git-)\n"[..],
            &b"git version 2.50.1 (Apple Git-155) trailing\n"[..],
            &b"git version 2.50\n"[..],
        ] {
            assert_eq!(
                parse_git_version(malformed).unwrap_err().code,
                SyncErrorCode::GitUnavailable,
                "accepted malformed version: {:?}",
                String::from_utf8_lossy(malformed)
            );
        }
    }

    #[test]
    fn inherited_git_environment_key_matching_is_platform_exact() {
        assert!(is_inherited_git_key(OsStr::new("GIT_CONFIG_COUNT"), false));
        assert!(!is_inherited_git_key(OsStr::new("Git_Config_Count"), false));
        assert!(!is_inherited_git_key(
            OsStr::new("GITX_CONFIG_COUNT"),
            false
        ));

        assert!(is_inherited_git_key(OsStr::new("GIT_CONFIG_COUNT"), true));
        assert!(is_inherited_git_key(OsStr::new("Git_Config_Count"), true));
        assert!(is_inherited_git_key(OsStr::new("git_config_count"), true));
        assert!(!is_inherited_git_key(OsStr::new("GITX_CONFIG_COUNT"), true));
    }

    #[test]
    fn retained_output_accounting_is_checked() {
        assert_eq!(checked_retained_end(7, 8, 10).unwrap(), 10);
        assert_eq!(checked_retained_end(10, usize::MAX, 10).unwrap(), 10);
        assert!(checked_retained_end(11, 1, 10).is_err());
    }

    #[test]
    fn bounded_message_caps_invalid_utf8_expansion() {
        let message = bounded_message(&vec![0xff; 100], 64);
        assert!(message.len() <= 64, "expanded to {} bytes", message.len());
        assert!(message.chars().all(|character| character == '\u{fffd}'));

        assert_eq!(bounded_message(b"  valid text  ", 64), "valid text");
        assert_eq!(bounded_message(b"abcdef", 4), "abcd");
    }

    #[cfg(unix)]
    #[test]
    fn runtime_probe_rejects_the_exact_injected_old_executable() {
        let temp = tempfile::tempdir().unwrap();
        let executable = write_executable(
            temp.path(),
            "old-git",
            "if [ \"$#\" -ne 1 ] || [ \"$1\" != --version ]; then exit 88; fi\n\
             printf 'git version 2.48.9\\n'\n",
        );
        let error = match GitRuntime::probe(&executable) {
            Ok(_) => panic!("old injected Git was accepted"),
            Err(error) => error,
        };
        assert_eq!(error.code, SyncErrorCode::GitUnavailable);

        let broken = write_executable(temp.path(), "broken-git", "exit 7\n");
        let error = match GitRuntime::probe(&broken) {
            Ok(_) => panic!("failing injected Git was accepted"),
            Err(error) => error,
        };
        assert_eq!(error.code, SyncErrorCode::GitUnavailable);
    }

    #[cfg(unix)]
    #[test]
    fn bounded_concurrent_pipes_do_not_deadlock() {
        if let Some(script) = std::env::var_os("YONALIST_BOUNDED_PIPE_SCRIPT") {
            let repo = PathBuf::from(std::env::var_os("YONALIST_BOUNDED_PIPE_REPO").unwrap());
            let git = GitCommand::new(Path::new(&script), &repo);
            let input = vec![b'i'; 256 * 1024];
            let exit = git
                .run_status(
                    &[],
                    Some(&input),
                    &GitExecLimits {
                        max_stdout_bytes: 512 * 1024,
                        max_stderr_bytes: 512 * 1024,
                        timeout: Duration::from_secs(2),
                    },
                )
                .unwrap();
            match exit {
                GitExit::Success(stdout) => assert_eq!(stdout.len(), 256 * 1024),
                GitExit::Code { code, stderr, .. } => {
                    panic!(
                        "pipe fixture exited {code}: {}",
                        String::from_utf8_lossy(&stderr)
                    )
                }
            }
            return;
        }

        let temp = tempfile::tempdir().unwrap();
        let script = write_executable(
            temp.path(),
            "pipe-git",
            "dd if=/dev/zero bs=1024 count=256 2>/dev/null\n\
             dd if=/dev/zero bs=1024 count=256 1>&2 2>/dev/null\n\
             dd of=/dev/null bs=1024 count=256 2>/dev/null\n",
        );
        run_helper(
            "git_command::tests::bounded_concurrent_pipes_do_not_deadlock",
            &[
                ("YONALIST_BOUNDED_PIPE_SCRIPT", script.as_os_str()),
                ("YONALIST_BOUNDED_PIPE_REPO", temp.path().as_os_str()),
            ],
        );
    }

    #[cfg(unix)]
    #[test]
    fn bounded_output_kills_and_reaps_the_child() {
        if let Some(repo) = std::env::var_os("YONALIST_BOUNDED_OUTPUT_REPO") {
            let git = GitCommand::new(Path::new("/usr/bin/yes"), Path::new(&repo));
            let began = Instant::now();
            let error = git
                .run_status(
                    &[],
                    None,
                    &GitExecLimits {
                        max_stdout_bytes: 32 * 1024,
                        max_stderr_bytes: 32 * 1024,
                        timeout: Duration::from_millis(250),
                    },
                )
                .unwrap_err();
            assert!(matches!(
                error.code,
                SyncErrorCode::LimitExceeded | SyncErrorCode::GitCommandFailed
            ));
            assert!(began.elapsed() < Duration::from_secs(3));
            assert!(error.message.len() <= 32 * 1024 + 128);
            return;
        }

        let temp = tempfile::tempdir().unwrap();
        assert!(Path::new("/usr/bin/yes").is_file());
        run_helper(
            "git_command::tests::bounded_output_kills_and_reaps_the_child",
            &[("YONALIST_BOUNDED_OUTPUT_REPO", temp.path().as_os_str())],
        );
    }

    #[cfg(unix)]
    #[test]
    fn bounded_timeout_kills_and_reaps_the_child() {
        if let Some(script) = std::env::var_os("YONALIST_TIMEOUT_SCRIPT") {
            let repo = PathBuf::from(std::env::var_os("YONALIST_TIMEOUT_REPO").unwrap());
            let completed = PathBuf::from(std::env::var_os("YONALIST_COMPLETED_MARKER").unwrap());
            let git = GitCommand::new(Path::new(&script), &repo);
            let began = Instant::now();
            let error = git
                .run_status(
                    &[],
                    None,
                    &GitExecLimits {
                        max_stdout_bytes: 32 * 1024,
                        max_stderr_bytes: 32 * 1024,
                        timeout: Duration::from_millis(250),
                    },
                )
                .unwrap_err();
            assert_eq!(error.code, SyncErrorCode::GitCommandFailed);
            assert!(began.elapsed() < Duration::from_secs(3));
            assert!(
                !completed.exists(),
                "fixture exited naturally instead of being killed"
            );
            return;
        }

        let temp = tempfile::tempdir().unwrap();
        let script = write_executable(
            temp.path(),
            "timeout-git",
            "while :; do :; done\n\
             printf completed > \"$YONALIST_COMPLETED_MARKER\"\n",
        );
        let completed = temp.path().join("completed");
        run_helper(
            "git_command::tests::bounded_timeout_kills_and_reaps_the_child",
            &[
                ("YONALIST_TIMEOUT_SCRIPT", script.as_os_str()),
                ("YONALIST_TIMEOUT_REPO", temp.path().as_os_str()),
                ("YONALIST_COMPLETED_MARKER", completed.as_os_str()),
            ],
        );
    }

    #[cfg(unix)]
    #[test]
    fn exit_probe_keeps_the_process_group_leader_waitable() {
        let temp = tempfile::tempdir().unwrap();
        let script = write_executable(temp.path(), "exited-git", "exit 23\n");
        let mut command = base_command(&script);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut process = ProcessTreeChild::spawn(&mut command).unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while !process.exit_observed_without_reaping().unwrap() {
            assert!(
                Instant::now() < deadline,
                "direct child did not become waitable"
            );
            thread::sleep(Duration::from_millis(10));
        }

        let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
        let observed = unsafe {
            libc::waitid(
                libc::P_PID,
                libc::id_t::try_from(process.process_group).unwrap(),
                info.as_mut_ptr(),
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        assert_eq!(observed, 0, "exit probe reaped the process-group leader");
        let info = unsafe { info.assume_init() };
        assert_eq!(unsafe { info.si_pid() }, process.process_group);

        let status = terminate_and_reap(&mut process).unwrap();
        assert_eq!(status.code(), Some(23));
    }

    #[cfg(unix)]
    #[test]
    fn stale_running_observation_handles_an_exit_before_killpg() {
        let temp = tempfile::tempdir().unwrap();
        let script = write_executable(temp.path(), "racing-git", "exit 29\n");
        let mut command = base_command(&script);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut process = ProcessTreeChild::spawn(&mut command).unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while !process.exit_observed_without_reaping().unwrap() {
            assert!(Instant::now() < deadline, "direct child did not exit");
            thread::sleep(Duration::from_millis(10));
        }

        process.terminate_tree(false).unwrap();
        assert_eq!(process.child.wait().unwrap().code(), Some(29));
    }

    #[cfg(unix)]
    #[test]
    fn direct_child_normal_exit_kills_its_live_descendant() {
        if let Some(script) = std::env::var_os("YONALIST_EXITED_LEADER_ROOT") {
            let repo = PathBuf::from(std::env::var_os("YONALIST_TREE_REPO").unwrap());
            let marker = PathBuf::from(std::env::var_os("YONALIST_TREE_MARKER").unwrap());
            let pid_file = PathBuf::from(std::env::var_os("YONALIST_TREE_PID").unwrap());
            let git = GitCommand::new(Path::new(&script), &repo);
            let began = Instant::now();
            let exit = git
                .run_status(
                    &[],
                    None,
                    &GitExecLimits {
                        max_stdout_bytes: 8 * 1024,
                        max_stderr_bytes: 8 * 1024,
                        timeout: Duration::from_secs(2),
                    },
                )
                .unwrap();
            match exit {
                GitExit::Code { code, .. } => assert_eq!(code, 23),
                GitExit::Success(_) => panic!("direct child's normal failure status was lost"),
            }
            let descendant_pid = std::fs::read_to_string(&pid_file)
                .unwrap()
                .parse::<u32>()
                .unwrap();
            wait_until_process_is_not_live(descendant_pid, began + Duration::from_secs(3));
            assert!(!marker.exists(), "surviving descendant wrote its marker");
            return;
        }

        let temp = tempfile::tempdir().unwrap();
        let descendant = write_executable(
            temp.path(),
            "exited-leader-descendant",
            "printf '%s' \"$$\" > \"$YONALIST_TREE_PID\"\n\
             sleep 3\n\
             printf survived > \"$YONALIST_TREE_MARKER\"\n",
        );
        let root_body = format!(
            "'{}' &\nwhile [ ! -s \"$YONALIST_TREE_PID\" ]; do :; done\nexit 23\n",
            descendant.display()
        );
        let root = write_executable(temp.path(), "exited-leader-root", &root_body);
        let marker = temp.path().join("exited-leader-survived");
        let pid_file = temp.path().join("exited-leader-pid");
        run_helper(
            "git_command::tests::direct_child_normal_exit_kills_its_live_descendant",
            &[
                ("YONALIST_EXITED_LEADER_ROOT", root.as_os_str()),
                ("YONALIST_TREE_REPO", temp.path().as_os_str()),
                ("YONALIST_TREE_MARKER", marker.as_os_str()),
                ("YONALIST_TREE_PID", pid_file.as_os_str()),
            ],
        );
    }

    #[cfg(unix)]
    #[test]
    fn output_overflow_kills_the_entire_descendant_tree() {
        output_overflow_descendant_tree_case();
    }

    #[cfg(unix)]
    #[test]
    fn helper_watchdog_kills_and_reaps_the_recorded_executor_group() {
        if let Some(script) = std::env::var_os("YONALIST_WATCHDOG_SCRIPT") {
            let repo = PathBuf::from(std::env::var_os("YONALIST_WATCHDOG_REPO").unwrap());
            let git = GitCommand::new(Path::new(&script), &repo);
            let _ = git.run_status(
                &[],
                None,
                &GitExecLimits {
                    max_stdout_bytes: 8 * 1024,
                    max_stderr_bytes: 8 * 1024,
                    timeout: Duration::from_secs(30),
                },
            );
            thread::sleep(Duration::from_secs(30));
            return;
        }

        let temp = tempfile::tempdir().unwrap();
        let script = write_executable(temp.path(), "watchdog-git", "while :; do :; done\n");
        let process_group_file = temp.path().join("executor-pgid");
        let mut helper = spawn_helper(
            "git_command::tests::helper_watchdog_kills_and_reaps_the_recorded_executor_group",
            &[
                ("YONALIST_WATCHDOG_SCRIPT", script.as_os_str()),
                ("YONALIST_WATCHDOG_REPO", temp.path().as_os_str()),
            ],
            &process_group_file,
        );

        let ready_deadline = Instant::now() + Duration::from_secs(6);
        while std::fs::read_to_string(&process_group_file)
            .map(|record| record.trim().is_empty())
            .unwrap_or(true)
        {
            assert!(
                helper.try_wait().unwrap().is_none(),
                "watchdog fixture helper exited before recording its executor group"
            );
            assert!(
                Instant::now() < ready_deadline,
                "watchdog fixture did not record its executor group"
            );
            thread::sleep(Duration::from_millis(10));
        }

        let process_group = cleanup_timed_out_helper(&mut helper, &process_group_file).unwrap();
        assert!(
            helper.try_wait().unwrap().is_some(),
            "helper was not reaped"
        );
        wait_until_process_is_not_live(
            u32::try_from(process_group).unwrap(),
            Instant::now() + Duration::from_secs(3),
        );
    }

    #[cfg(unix)]
    #[test]
    fn bounded_stderr_is_truncated_in_failure_messages() {
        let temp = tempfile::tempdir().unwrap();
        let script = write_executable(
            temp.path(),
            "stderr-git",
            "dd if=/dev/zero bs=1024 count=64 1>&2 2>/dev/null\nexit 7\n",
        );
        let git = GitCommand::new(&script, temp.path());
        let error = git
            .run_status(
                &[],
                None,
                &GitExecLimits {
                    max_stdout_bytes: 32 * 1024,
                    max_stderr_bytes: 32 * 1024,
                    timeout: Duration::from_secs(2),
                },
            )
            .unwrap_err();
        assert_eq!(
            error.code,
            SyncErrorCode::LimitExceeded,
            "unexpected executor error: {}",
            error.message
        );
        assert!(error.message.len() <= 32 * 1024 + 128);
    }

    #[cfg(unix)]
    fn write_executable(directory: &Path, name: &str, body: &str) -> PathBuf {
        let path = directory.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[cfg(unix)]
    fn output_overflow_descendant_tree_case() {
        if let Some(script) = std::env::var_os("YONALIST_TREE_ROOT") {
            let repo = PathBuf::from(std::env::var_os("YONALIST_TREE_REPO").unwrap());
            let marker = PathBuf::from(std::env::var_os("YONALIST_TREE_MARKER").unwrap());
            let pid_file = PathBuf::from(std::env::var_os("YONALIST_TREE_PID").unwrap());
            let ready = PathBuf::from(std::env::var_os("YONALIST_TREE_READY").unwrap());
            let git = GitCommand::new(Path::new(&script), &repo);
            let began = Instant::now();
            let error = git
                .run_status(
                    &[],
                    None,
                    &GitExecLimits {
                        max_stdout_bytes: 8 * 1024,
                        max_stderr_bytes: 8 * 1024,
                        timeout: Duration::from_secs(2),
                    },
                )
                .unwrap_err();
            assert!(matches!(
                error.code,
                SyncErrorCode::GitCommandFailed | SyncErrorCode::LimitExceeded
            ));
            let grandchild_pid = std::fs::read_to_string(&pid_file)
                .unwrap_or_else(|error| {
                    panic!(
                        "grandchild PID missing ({error}); readiness was {:?}",
                        std::fs::read_to_string(&ready)
                    )
                })
                .parse::<u32>()
                .unwrap();
            wait_until_process_is_not_live(grandchild_pid, began + Duration::from_secs(3));
            thread::sleep(Duration::from_millis(100));
            assert!(!marker.exists(), "surviving grandchild wrote its marker");
            return;
        }

        let temp = tempfile::tempdir().unwrap();
        let grandchild = write_executable(
            temp.path(),
            "tree-grandchild",
            "printf G >> \"$YONALIST_TREE_READY\"\n\
             printf '%s' \"$$\" > \"$YONALIST_TREE_PID\"\n\
             dd if=/dev/zero bs=1024 count=64 2>/dev/null\n\
             sleep 3\n\
             printf survived > \"$YONALIST_TREE_MARKER\"\n",
        );
        let child_body = format!(
            "printf C >> \"$YONALIST_TREE_READY\"\n'{}' &\nwait\n",
            grandchild.display()
        );
        let child = write_executable(temp.path(), "tree-child", &child_body);
        let root_body = format!(
            "printf R >> \"$YONALIST_TREE_READY\"\n'{}' &\nwait\n",
            child.display()
        );
        let root = write_executable(temp.path(), "tree-root", &root_body);
        let marker = temp.path().join("output-survived");
        let pid_file = temp.path().join("output-pid");
        let ready = temp.path().join("output-ready");
        run_helper(
            "git_command::tests::output_overflow_kills_the_entire_descendant_tree",
            &[
                ("YONALIST_TREE_ROOT", root.as_os_str()),
                ("YONALIST_TREE_CHILD", child.as_os_str()),
                ("YONALIST_TREE_GRANDCHILD", grandchild.as_os_str()),
                ("YONALIST_TREE_REPO", temp.path().as_os_str()),
                ("YONALIST_TREE_MARKER", marker.as_os_str()),
                ("YONALIST_TREE_PID", pid_file.as_os_str()),
                ("YONALIST_TREE_READY", ready.as_os_str()),
            ],
        );
    }

    #[cfg(unix)]
    fn run_helper(test_name: &str, envs: &[(&str, &OsStr)]) {
        let watchdog = tempfile::tempdir().unwrap();
        let process_group_file = watchdog.path().join("executor-pgid");
        let mut child = spawn_helper(test_name, envs, &process_group_file);
        let deadline = Instant::now() + Duration::from_secs(6);
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                assert!(status.success(), "bounded-process helper failed: {status}");
                return;
            }
            if Instant::now() >= deadline {
                cleanup_timed_out_helper(&mut child, &process_group_file)
                    .expect("bounded-process watchdog failed to clean its executor group");
                panic!("bounded-process helper deadlocked or ignored its timeout");
            }
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[cfg(unix)]
    fn spawn_helper(test_name: &str, envs: &[(&str, &OsStr)], process_group_file: &Path) -> Child {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command.args([test_name, "--exact", "--nocapture"]);
        command.envs(envs.iter().copied());
        command.env("YONALIST_TEST_EXECUTOR_PGID_FILE", process_group_file);
        command.spawn().unwrap()
    }

    #[cfg(unix)]
    fn cleanup_timed_out_helper(
        helper: &mut Child,
        process_group_file: &Path,
    ) -> std::io::Result<libc::pid_t> {
        let group_cleanup = (|| {
            let recorded = std::fs::read_to_string(process_group_file)?;
            let parsed = recorded.trim().parse::<i64>().map_err(|_| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "executor process-group record is not a decimal integer",
                )
            })?;
            let process_group = libc::pid_t::try_from(parsed).map_err(|_| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "executor process-group record does not fit pid_t",
                )
            })?;
            if process_group <= 1 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "executor process-group record is not a signalable group",
                ));
            }

            let own_group = unsafe { libc::getpgrp() };
            let helper_pid = libc::pid_t::try_from(helper.id()).map_err(|_| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "helper PID does not fit pid_t",
                )
            })?;
            let helper_group = unsafe { libc::getpgid(helper_pid) };
            if helper_group == -1 {
                return Err(std::io::Error::last_os_error());
            }
            if process_group == own_group || process_group == helper_group {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "executor process group aliases the watchdog or helper group",
                ));
            }

            loop {
                if unsafe { libc::killpg(process_group, libc::SIGKILL) } == 0 {
                    return Ok(process_group);
                }
                let error = std::io::Error::last_os_error();
                match error.raw_os_error() {
                    Some(libc::EINTR) => continue,
                    Some(libc::ESRCH) => return Ok(process_group),
                    _ => return Err(error),
                }
            }
        })();

        // Even corrupt or missing handoff data must not leave the helper
        // process itself behind. The executor group is always handled first
        // when its exact recorded identity validates.
        let helper_kill = helper.kill();
        let helper_wait = helper.wait();
        let process_group = group_cleanup?;
        if let Err(error) = helper_kill {
            if error.kind() != std::io::ErrorKind::InvalidInput {
                return Err(error);
            }
        }
        helper_wait?;
        Ok(process_group)
    }

    #[cfg(unix)]
    fn wait_until_process_is_not_live(pid: u32, deadline: Instant) {
        loop {
            let output = Command::new("/bin/ps")
                .args(["-o", "stat=", "-p", &pid.to_string()])
                .output()
                .unwrap();
            let state = String::from_utf8_lossy(&output.stdout);
            if !output.status.success()
                || state.trim().is_empty()
                || state.trim_start().starts_with('Z')
            {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "process {pid} survived as {state:?}"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }
}

fn unavailable(error: std::io::Error) -> SyncError {
    SyncError {
        code: SyncErrorCode::GitUnavailable,
        message: error.to_string(),
    }
}
fn git_unavailable(message: impl Into<String>) -> SyncError {
    SyncError {
        code: SyncErrorCode::GitUnavailable,
        message: message.into(),
    }
}
fn io(error: std::io::Error) -> SyncError {
    SyncError {
        code: SyncErrorCode::Io,
        message: error.to_string(),
    }
}
fn failed(stderr: &[u8]) -> SyncError {
    SyncError {
        code: SyncErrorCode::GitCommandFailed,
        message: bounded_message(stderr, GitExecLimits::default().max_stderr_bytes),
    }
}
fn output_limit(stderr: &[u8], stderr_limit: usize) -> SyncError {
    let context = "Git command output exceeded its configured limit";
    let stderr = bounded_message(stderr, stderr_limit);
    SyncError {
        code: SyncErrorCode::LimitExceeded,
        message: if stderr.is_empty() {
            context.into()
        } else {
            format!("{context}: {stderr}")
        },
    }
}

pub(crate) fn bounded_message(bytes: &[u8], limit: usize) -> String {
    let input = &bytes[..bytes.len().min(limit)];
    let worst_case_utf8 = input.len().checked_mul(3).unwrap_or(limit).min(limit);
    let mut message = String::with_capacity(worst_case_utf8);
    let mut remaining = input;
    while !remaining.is_empty() && message.len() < limit {
        match std::str::from_utf8(remaining) {
            Ok(valid) => {
                push_valid_within(&mut message, valid, limit);
                break;
            }
            Err(error) => {
                let valid_len = error.valid_up_to();
                let valid = std::str::from_utf8(&remaining[..valid_len])
                    .expect("UTF-8 error prefix is valid");
                if !push_valid_within(&mut message, valid, limit) {
                    break;
                }
                let invalid_len = error.error_len().unwrap_or(remaining.len() - valid_len);
                if limit - message.len() < '\u{fffd}'.len_utf8() {
                    break;
                }
                message.push('\u{fffd}');
                remaining = &remaining[valid_len + invalid_len..];
            }
        }
    }
    let trimmed_end = message.trim_end().len();
    message.truncate(trimmed_end);
    let trimmed_start = message.len() - message.trim_start().len();
    message.drain(..trimmed_start);
    message
}

fn push_valid_within(message: &mut String, valid: &str, limit: usize) -> bool {
    let available = limit - message.len();
    if valid.len() <= available {
        message.push_str(valid);
        return true;
    }
    let mut boundary = available;
    while boundary > 0 && !valid.is_char_boundary(boundary) {
        boundary -= 1;
    }
    message.push_str(&valid[..boundary]);
    false
}

use std::{
    ffi::{OsStr, OsString},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, ExitStatus, Stdio},
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
                let message = bounded_text(&stderr, GitExecLimits::default().max_stderr_bytes);
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
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(unavailable)?;
    let child_stdin = child.stdin.take();
    let child_stdout = child.stdout.take().expect("stdout is piped");
    let child_stderr = child.stderr.take().expect("stderr is piped");
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
                terminate_and_reap(&mut child)?;
                break ProcessOutcome::OutputLimit;
            }
            match child.try_wait() {
                Ok(Some(status)) => break ProcessOutcome::Exited(status),
                Ok(None) => {}
                Err(error) => {
                    terminate_and_reap(&mut child)?;
                    return Err(io(error));
                }
            }
            if began.elapsed() >= limits.timeout {
                terminate_and_reap(&mut child)?;
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
        let retained = read.min(limit.saturating_sub(bytes.len()));
        bytes.extend_from_slice(&buffer[..retained]);
        if retained < read && !overflowed {
            overflowed = true;
            let _ = overflow.send(());
        }
    }
    Ok(BoundedOutput { bytes, overflowed })
}

fn terminate_and_reap(child: &mut std::process::Child) -> Result<(), SyncError> {
    match child.kill() {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::InvalidInput => {}
        Err(error) => {
            let _ = child.wait();
            return Err(io(error));
        }
    }
    child.wait().map_err(io)?;
    Ok(())
}

fn join_worker<T>(worker: thread::ScopedJoinHandle<'_, T>) -> Result<T, SyncError> {
    worker.join().map_err(|_| SyncError {
        code: SyncErrorCode::Io,
        message: "Git pipe worker panicked".into(),
    })
}

fn parse_git_version(stdout: &[u8]) -> Result<GitVersion, SyncError> {
    let text = std::str::from_utf8(stdout).map_err(|_| git_unavailable("invalid Git version"))?;
    let version = text
        .trim()
        .strip_prefix("git version ")
        .ok_or_else(|| git_unavailable("invalid Git version"))?;
    let mut components = version.split('.');
    let parse = |component: Option<&str>| {
        component
            .ok_or_else(|| git_unavailable("invalid Git version"))?
            .parse::<u32>()
            .map_err(|_| git_unavailable("invalid Git version"))
    };
    let version = GitVersion::new(
        parse(components.next())?,
        parse(components.next())?,
        parse(components.next())?,
    );
    if version < MINIMUM_GIT_VERSION {
        return Err(git_unavailable("Git 2.49 or newer is required"));
    }
    Ok(version)
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
        if key.to_string_lossy().starts_with("GIT_") {
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
            parse_git_version(b"git version 2.48.9\n").unwrap_err().code,
            SyncErrorCode::GitUnavailable
        );
        assert_eq!(
            parse_git_version(b"not git\n").unwrap_err().code,
            SyncErrorCode::GitUnavailable
        );
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
        assert_eq!(error.code, SyncErrorCode::LimitExceeded);
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
    fn run_helper(test_name: &str, envs: &[(&str, &OsStr)]) {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command.args([test_name, "--exact", "--nocapture"]);
        command.envs(envs.iter().copied());
        let mut child = command.spawn().unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                assert!(status.success(), "bounded-process helper failed: {status}");
                return;
            }
            if Instant::now() >= deadline {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("bounded-process helper deadlocked or ignored its timeout");
            }
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
        message: bounded_text(stderr, GitExecLimits::default().max_stderr_bytes),
    }
}
fn output_limit(stderr: &[u8], stderr_limit: usize) -> SyncError {
    let context = "Git command output exceeded its configured limit";
    let stderr = bounded_text(stderr, stderr_limit);
    SyncError {
        code: SyncErrorCode::LimitExceeded,
        message: if stderr.is_empty() {
            context.into()
        } else {
            format!("{context}: {stderr}")
        },
    }
}
fn bounded_text(bytes: &[u8], limit: usize) -> String {
    let mut text = String::from_utf8_lossy(bytes).into_owned();
    if text.len() > limit {
        let mut boundary = limit;
        while boundary > 0 && !text.is_char_boundary(boundary) {
            boundary -= 1;
        }
        text.truncate(boundary);
    }
    text.trim().to_owned()
}

use std::{
    ffi::{OsStr, OsString},
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use crate::{SyncError, SyncErrorCode};

pub(crate) struct GitCommand {
    executable: PathBuf,
    repo: PathBuf,
}

impl GitCommand {
    pub(crate) fn new(executable: &Path, repo: &Path) -> Self {
        Self {
            executable: executable.to_path_buf(),
            repo: repo.to_path_buf(),
        }
    }

    pub(crate) fn init(executable: &Path, repo: &Path) -> Result<(), SyncError> {
        let output = base_command(executable)
            .arg("init")
            .arg("--bare")
            .arg("--object-format=sha256")
            .arg(repo)
            .output()
            .map_err(unavailable)?;
        if output.status.success() {
            Ok(())
        } else {
            Err(failed(&output.stderr))
        }
    }

    pub(crate) fn run(
        &self,
        args: &[OsString],
        stdin: Option<&[u8]>,
    ) -> Result<Vec<u8>, SyncError> {
        let mut command = base_command(&self.executable);
        command.arg(OsString::from(format!("--git-dir={}", self.repo.display())));
        command.args(args);
        if stdin.is_some() {
            command.stdin(Stdio::piped());
        }
        let mut child = command
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(unavailable)?;
        if let Some(bytes) = stdin {
            child
                .stdin
                .as_mut()
                .expect("stdin is piped")
                .write_all(bytes)
                .map_err(io)?;
        }
        let output = child.wait_with_output().map_err(io)?;
        if output.status.success() {
            Ok(output.stdout)
        } else {
            Err(failed(&output.stderr))
        }
    }

    pub(crate) fn run_with_env(
        &self,
        args: &[OsString],
        stdin: Option<&[u8]>,
        env: (&OsStr, &OsStr),
    ) -> Result<Vec<u8>, SyncError> {
        let mut command = base_command(&self.executable);
        command
            .arg(OsString::from(format!("--git-dir={}", self.repo.display())))
            .args(args)
            .env(env.0, env.1);
        if stdin.is_some() {
            command.stdin(Stdio::piped());
        }
        let mut child = command
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(unavailable)?;
        if let Some(bytes) = stdin {
            child
                .stdin
                .as_mut()
                .expect("stdin is piped")
                .write_all(bytes)
                .map_err(io)?;
        }
        let output = child.wait_with_output().map_err(io)?;
        if output.status.success() {
            Ok(output.stdout)
        } else {
            Err(failed(&output.stderr))
        }
    }
}

fn base_command(executable: &Path) -> Command {
    let mut command = Command::new(executable);
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

fn unavailable(error: std::io::Error) -> SyncError {
    SyncError {
        code: SyncErrorCode::GitUnavailable,
        message: error.to_string(),
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
        message: String::from_utf8_lossy(stderr).trim().to_owned(),
    }
}

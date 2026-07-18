use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(feature = "test-support")]
use std::sync::Mutex;

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

use serde_bytes::ByteBuf;

use crate::{
    git_store::RepositoryWriter, AtomLimits, DeviceId, GrantId, Hello, MemberId, ProjectId,
    SignedAtom, SyncError, SyncErrorCode,
};

const ACCESS_LOCK_SCHEMA: u16 = 1;

/// A local, non-shareable acknowledgement that this exact installation has
/// accepted a signed removal notice.  The tuple layout is intentional: CBOR
/// maps leave key ordering to serializers, whereas this fixed tuple has one
/// canonical representation we can round-trip check.
type AccessLockWire = (u16, [u8; 16], [u8; 16], [u8; 16], [u8; 16], ByteBuf);

#[derive(Clone, Debug)]
struct AccessLockRecord {
    schema: u16,
    project_id: ProjectId,
    member_id: MemberId,
    device_id: DeviceId,
    grant_id: GrantId,
    notice: Vec<u8>,
}

impl AccessLockRecord {
    fn expected(
        hello: &Hello,
        notice: &SignedAtom,
        limits: &AtomLimits,
    ) -> Result<Self, SyncError> {
        Ok(Self {
            schema: ACCESS_LOCK_SCHEMA,
            project_id: hello.project_id,
            member_id: hello.member_id,
            device_id: hello.device_id,
            grant_id: hello.grant_id,
            notice: notice.encode(limits)?,
        })
    }

    fn encode(&self) -> Result<Vec<u8>, SyncError> {
        let wire: AccessLockWire = (
            self.schema,
            *self.project_id.as_uuid().as_bytes(),
            *self.member_id.as_uuid().as_bytes(),
            *self.device_id.as_uuid().as_bytes(),
            *self.grant_id.as_uuid().as_bytes(),
            ByteBuf::from(self.notice.clone()),
        );
        let mut bytes = Vec::new();
        ciborium::ser::into_writer(&wire, &mut bytes)
            .map_err(|_| invalid("could not encode access lock"))?;
        Ok(bytes)
    }

    fn decode(bytes: &[u8], limits: &AtomLimits) -> Result<Self, SyncError> {
        let mut reader = std::io::Cursor::new(bytes);
        let (schema, project_id, member_id, device_id, grant_id, notice): AccessLockWire =
            ciborium::de::from_reader(&mut reader)
                .map_err(|_| invalid("could not decode access lock"))?;
        if reader.position() != bytes.len() as u64 {
            return Err(invalid("access lock has trailing bytes"));
        }
        let record = Self {
            schema,
            project_id: ProjectId::from_bytes(project_id),
            member_id: MemberId::from_bytes(member_id),
            device_id: DeviceId::from_bytes(device_id),
            grant_id: GrantId::from_bytes(grant_id),
            notice: notice.into_vec(),
        };
        if record.schema != ACCESS_LOCK_SCHEMA {
            return Err(invalid("unsupported access lock schema"));
        }
        // This validates the embedded signature *encoding* and makes the
        // record fail closed if a noncanonical atom or a transformed notice is
        // ever written to disk.
        let notice = SignedAtom::decode(&record.notice, limits)?;
        if notice.encode(limits)? != record.notice || record.encode()? != bytes {
            return Err(invalid("access lock bytes are not canonical"));
        }
        Ok(record)
    }

    fn matches(&self, expected: &Hello) -> bool {
        self.project_id == expected.project_id
            && self.member_id == expected.member_id
            && self.device_id == expected.device_id
            && self.grant_id == expected.grant_id
    }
}

pub(crate) struct AccessLockStore {
    path: PathBuf,
    #[cfg(feature = "test-support")]
    failure: Mutex<Option<AccessLockFailure>>,
}

#[cfg(feature = "test-support")]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AccessLockFailure {
    BeforeReplace,
    AfterReplace,
}

impl AccessLockStore {
    pub(crate) fn for_repository(repository: &Path) -> Self {
        Self {
            path: repository.join("yonalist-private/access-lock.cbor"),
            #[cfg(feature = "test-support")]
            failure: Mutex::new(None),
        }
    }

    #[cfg(feature = "test-support")]
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    #[cfg(feature = "test-support")]
    pub(crate) fn fail_once(&self, failure: AccessLockFailure) {
        *self
            .failure
            .lock()
            .expect("access-lock failure mutex poisoned") = Some(failure);
    }

    pub(crate) fn load(
        &self,
        expected: &Hello,
        limits: &AtomLimits,
    ) -> Result<Option<SignedAtom>, SyncError> {
        let bytes = match fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(io(error)),
        };
        let record = AccessLockRecord::decode(&bytes, limits)?;
        if !record.matches(expected) {
            return Err(invalid("access lock belongs to a different local identity"));
        }
        let notice = SignedAtom::decode(&record.notice, limits)?;
        if notice.unsigned.project_id != expected.project_id
            || notice.unsigned.plane != crate::Plane::Control
            || !notice.unsigned.data_frontier.is_empty()
        {
            return Err(invalid("access lock embeds an invalid removal notice"));
        }
        Ok(Some(notice))
    }

    /// The caller must already hold `GitStore`'s repository writer lock.  This
    /// makes the exact frontier check and private acknowledgement indivisible
    /// relative to all app append/import operations.
    pub(crate) fn persist_locked(
        &self,
        _writer: &RepositoryWriter<'_>,
        expected: &Hello,
        notice: &SignedAtom,
        limits: &AtomLimits,
    ) -> Result<(), SyncError> {
        self.persist_unlocked(expected, notice, limits)
    }

    fn persist_unlocked(
        &self,
        expected: &Hello,
        notice: &SignedAtom,
        limits: &AtomLimits,
    ) -> Result<(), SyncError> {
        let wanted = AccessLockRecord::expected(expected, notice, limits)?;
        if let Some(existing) = self.load(expected, limits)? {
            if existing.encode(limits)? == wanted.notice {
                return Ok(());
            }
            return Err(invalid(
                "access lock cannot be replaced by a different notice",
            ));
        }

        let bytes = wanted.encode()?;
        let directory = self
            .path
            .parent()
            .ok_or_else(|| invalid("access lock has no parent directory"))?;
        fs::create_dir_all(directory).map_err(io)?;
        let temporary = temporary_path(directory)?;
        let write_result = write_private_file(&temporary, &bytes);
        if let Err(error) = write_result {
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
        if let Err(error) = self.inject_failure(AccessLockFailurePoint::BeforeReplace) {
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
        let replace_result = replace_atomically(&temporary, &self.path);
        if let Err(error) = replace_result {
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
        self.inject_failure(AccessLockFailurePoint::AfterReplace)?;
        sync_directory(directory)?;
        Ok(())
    }

    fn inject_failure(&self, _point: AccessLockFailurePoint) -> Result<(), SyncError> {
        #[cfg(feature = "test-support")]
        {
            let mut failure = self
                .failure
                .lock()
                .expect("access-lock failure mutex poisoned");
            let expected = match _point {
                AccessLockFailurePoint::BeforeReplace => AccessLockFailure::BeforeReplace,
                AccessLockFailurePoint::AfterReplace => AccessLockFailure::AfterReplace,
            };
            if *failure == Some(expected) {
                *failure = None;
                return Err(SyncError {
                    code: SyncErrorCode::Io,
                    message: "injected access-lock persistence failure".into(),
                });
            }
        }
        Ok(())
    }
}

#[derive(Clone, Copy)]
enum AccessLockFailurePoint {
    BeforeReplace,
    AfterReplace,
}

fn temporary_path(directory: &Path) -> Result<PathBuf, SyncError> {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| invalid("clock before Unix epoch"))?
        .as_nanos();
    Ok(directory.join(format!(".access-lock-{}-{nonce}.tmp", std::process::id())))
}

fn write_private_file(path: &Path, bytes: &[u8]) -> Result<(), SyncError> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(path).map_err(io)?;
    file.write_all(bytes).map_err(io)?;
    file.sync_all().map_err(io)
}

#[cfg(unix)]
fn replace_atomically(source: &Path, destination: &Path) -> Result<(), SyncError> {
    fs::rename(source, destination).map_err(io)
}

#[cfg(windows)]
fn replace_atomically(source: &Path, destination: &Path) -> Result<(), SyncError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    // WRITE_THROUGH makes the namespace replacement durable rather than
    // pretending a directory fsync exists on Windows.
    if unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(io(std::io::Error::last_os_error()));
    }
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn replace_atomically(_source: &Path, _destination: &Path) -> Result<(), SyncError> {
    Err(SyncError {
        code: SyncErrorCode::Io,
        message: "durable access-lock replacement is unsupported on this platform".into(),
    })
}

#[cfg(unix)]
fn sync_directory(directory: &Path) -> Result<(), SyncError> {
    File::open(directory)
        .and_then(|file| file.sync_all())
        .map_err(io)
}

#[cfg(windows)]
fn sync_directory(_directory: &Path) -> Result<(), SyncError> {
    // `replace_atomically` uses MOVEFILE_WRITE_THROUGH.  There is no no-op
    // directory-sync success path on Windows.
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn sync_directory(_directory: &Path) -> Result<(), SyncError> {
    Err(SyncError {
        code: SyncErrorCode::Io,
        message: "durable access-lock publication is unsupported on this platform".into(),
    })
}

fn invalid(message: impl Into<String>) -> SyncError {
    SyncError {
        code: SyncErrorCode::InvalidAtom,
        message: message.into(),
    }
}

fn io(error: std::io::Error) -> SyncError {
    SyncError {
        code: SyncErrorCode::Io,
        message: error.to_string(),
    }
}

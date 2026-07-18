use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(unix)]
use std::fs::File;

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
    DirectoryBarrier,
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
        let directory = self
            .path
            .parent()
            .ok_or_else(|| invalid("access lock has no parent directory"))?;
        if let Some(existing) = self.load(expected, limits)? {
            if existing.encode(limits)? == wanted.notice {
                let bytes = wanted.encode()?;
                self.inject_failure(AccessLockFailurePoint::DirectoryBarrier)?;
                return durabilize_existing(&self.path, directory, &bytes);
            }
            return Err(invalid(
                "access lock cannot be replaced by a different notice",
            ));
        }

        let bytes = wanted.encode()?;
        fs::create_dir_all(directory).map_err(io)?;
        let temporary = temporary_path(directory)?;
        write_private_temporary(&temporary, &bytes)?;
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
        self.inject_failure(AccessLockFailurePoint::DirectoryBarrier)?;
        finish_new_publication(directory)
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
                AccessLockFailurePoint::DirectoryBarrier => AccessLockFailure::DirectoryBarrier,
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
    DirectoryBarrier,
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
    let result = file
        .write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(io);
    drop(file);
    if result.is_err() {
        // `create_new` succeeded, so this call owns the temporary pathname.
        let _ = fs::remove_file(path);
    }
    result
}

fn write_private_temporary(path: &Path, bytes: &[u8]) -> Result<(), SyncError> {
    // In particular, do not unlink on `AlreadyExists`: the colliding pathname
    // belongs to somebody else because `create_new` did not create it.
    write_private_file(path, bytes)
}

#[cfg(any(windows, test))]
fn replace_existing_from_private_stage(
    destination: &Path,
    directory: &Path,
    bytes: &[u8],
    replace: impl FnOnce(&Path, &Path) -> Result<(), SyncError>,
) -> Result<(), SyncError> {
    let temporary = temporary_path(directory)?;
    write_private_temporary(&temporary, bytes)?;
    if let Err(error) = replace(&temporary, destination) {
        // `write_private_temporary` succeeded, so this call owns the pathname.
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    Ok(())
}

#[cfg(unix)]
fn durabilize_existing(_path: &Path, directory: &Path, _bytes: &[u8]) -> Result<(), SyncError> {
    sync_directory(directory)
}

#[cfg(windows)]
fn durabilize_existing(path: &Path, directory: &Path, bytes: &[u8]) -> Result<(), SyncError> {
    replace_existing_from_private_stage(path, directory, bytes, replace_atomically)
}

#[cfg(not(any(unix, windows)))]
fn durabilize_existing(_path: &Path, _directory: &Path, _bytes: &[u8]) -> Result<(), SyncError> {
    unsupported_durability()
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
fn finish_new_publication(directory: &Path) -> Result<(), SyncError> {
    sync_directory(directory)
}

#[cfg(windows)]
fn finish_new_publication(_directory: &Path) -> Result<(), SyncError> {
    // The preceding `replace_atomically` already used WRITE_THROUGH.  Rewriting
    // a newly published record here would add no durability and widen failure
    // handling, so only identical-record retries stage and replace again.
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn finish_new_publication(_directory: &Path) -> Result<(), SyncError> {
    unsupported_durability()
}

#[cfg(unix)]
fn sync_directory(directory: &Path) -> Result<(), SyncError> {
    File::open(directory)
        .and_then(|file| file.sync_all())
        .map_err(io)
}

#[cfg(not(any(unix, windows)))]
fn unsupported_durability() -> Result<(), SyncError> {
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

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::{replace_existing_from_private_stage, write_private_temporary};

    #[test]
    fn colliding_temporary_path_is_never_removed() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("collision.tmp");
        std::fs::write(&path, b"somebody else's bytes").unwrap();

        assert!(write_private_temporary(&path, b"replacement").is_err());
        assert_eq!(
            std::fs::read(&path).unwrap(),
            b"somebody else's bytes".to_vec()
        );
    }

    #[test]
    fn existing_record_replacement_stages_exact_bytes_before_one_replace() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("access-lock.cbor");
        std::fs::write(&destination, b"prior bytes").unwrap();
        let calls = Cell::new(0);

        replace_existing_from_private_stage(
            &destination,
            directory.path(),
            b"canonical bytes",
            |source, destination| {
                calls.set(calls.get() + 1);
                assert_eq!(std::fs::read(source).unwrap(), b"canonical bytes");
                std::fs::rename(source, destination).map_err(super::io)
            },
        )
        .unwrap();

        assert_eq!(calls.get(), 1);
        assert_eq!(std::fs::read(&destination).unwrap(), b"canonical bytes");
        assert_eq!(
            std::fs::read_dir(directory.path()).unwrap().count(),
            1,
            "the owned temporary must be consumed"
        );
    }

    #[test]
    fn failed_existing_record_replacement_cleans_only_its_owned_stage() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("access-lock.cbor");
        std::fs::write(&destination, b"canonical bytes").unwrap();

        assert!(replace_existing_from_private_stage(
            &destination,
            directory.path(),
            b"canonical bytes",
            |source, _destination| {
                assert_eq!(std::fs::read(source).unwrap(), b"canonical bytes");
                Err(super::invalid("injected replacement failure"))
            },
        )
        .is_err());

        assert_eq!(std::fs::read(&destination).unwrap(), b"canonical bytes");
        assert_eq!(
            std::fs::read_dir(directory.path()).unwrap().count(),
            1,
            "the failed replacement must clean its owned temporary"
        );
    }
}

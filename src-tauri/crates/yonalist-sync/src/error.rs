use thiserror::Error;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SyncErrorCode {
    GitUnavailable,
    GitCommandFailed,
    InvalidId,
    InvalidAtom,
    InvalidSignature,
    UnsupportedSchema,
    RefRewind,
    PackRejected,
    PolicyRejected,
    AccessRevoked,
    LimitExceeded,
    Io,
}

#[derive(Debug, Error)]
#[error("{message}")]
pub struct SyncError {
    pub code: SyncErrorCode,
    pub message: String,
}

impl SyncError {
    pub(crate) fn invalid_id(message: impl Into<String>) -> Self {
        Self {
            code: SyncErrorCode::InvalidId,
            message: message.into(),
        }
    }
}

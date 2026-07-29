use notes_core::DomainError;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{ExportError, StorageError};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum NotesErrorCode {
    InvalidCommand,
    NotFound,
    RevisionConflict,
    DuplicateRequest,
    StorageUnavailable,
    SessionMismatch,
    HistoryEmpty,
    DestinationExists,
    InvalidDestination,
    ExportTooLarge,
    ExportFailed,
    Internal,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct NotesError {
    pub code: NotesErrorCode,
    pub message: String,
    pub retryable: bool,
}

impl NotesError {
    pub(crate) fn session_mismatch() -> Self {
        Self {
            code: NotesErrorCode::SessionMismatch,
            message: "The Notes session does not match the active session.".into(),
            retryable: false,
        }
    }

    pub(crate) fn history_empty() -> Self {
        Self {
            code: NotesErrorCode::HistoryEmpty,
            message: "There is no Notes history entry in that direction.".into(),
            retryable: false,
        }
    }
}

impl From<DomainError> for NotesError {
    fn from(error: DomainError) -> Self {
        let code = match error {
            DomainError::NodeNotFound(_)
            | DomainError::ParentNotFound(_)
            | DomainError::SiblingNotFound(_) => NotesErrorCode::NotFound,
            _ => NotesErrorCode::InvalidCommand,
        };
        Self {
            code,
            message: error.to_string(),
            retryable: false,
        }
    }
}

impl From<StorageError> for NotesError {
    fn from(error: StorageError) -> Self {
        match error {
            StorageError::RevisionConflict { .. } => Self {
                code: NotesErrorCode::RevisionConflict,
                message: error.to_string(),
                retryable: true,
            },
            StorageError::Domain(error) => error.into(),
            StorageError::Unavailable(message) => Self {
                code: NotesErrorCode::StorageUnavailable,
                message,
                retryable: true,
            },
            StorageError::Internal(message) => Self {
                code: NotesErrorCode::Internal,
                message,
                retryable: false,
            },
        }
    }
}

impl From<ExportError> for NotesError {
    fn from(error: ExportError) -> Self {
        match error {
            ExportError::Storage(error) => error.into(),
            ExportError::DestinationExists => Self {
                code: NotesErrorCode::DestinationExists,
                message: error.to_string(),
                retryable: false,
            },
            ExportError::InvalidDestination(message) => Self {
                code: NotesErrorCode::InvalidDestination,
                message,
                retryable: false,
            },
            ExportError::TooLarge(message) => Self {
                code: NotesErrorCode::ExportTooLarge,
                message,
                retryable: false,
            },
            ExportError::Failed(message) => Self {
                code: NotesErrorCode::ExportFailed,
                message,
                retryable: false,
            },
        }
    }
}

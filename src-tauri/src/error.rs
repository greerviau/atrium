use serde::Serialize;

/// The single error type returned by every `#[tauri::command]` handler.
///
/// Serializes to the frontend as `{ "code": string, "message": string }` so
/// `lib/ipc/commands.ts` can match on `code` without parsing free-form text.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    AlreadyExists(String),
    #[error("{0}")]
    InvalidPath(String),
    #[error("file is not valid UTF-8: {0}")]
    NotUtf8(String),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("unknown workspace: {0}")]
    UnknownWorkspace(String),
    #[error("invalid regex: {0}")]
    InvalidRegex(String),
    #[error("{0}")]
    Other(String),
}

impl AppError {
    fn code(&self) -> &'static str {
        match self {
            AppError::NotFound(_) => "NOT_FOUND",
            AppError::AlreadyExists(_) => "ALREADY_EXISTS",
            AppError::InvalidPath(_) => "INVALID_PATH",
            AppError::NotUtf8(_) => "NOT_UTF8",
            AppError::Io(_) => "IO_ERROR",
            AppError::UnknownWorkspace(_) => "UNKNOWN_WORKSPACE",
            AppError::InvalidRegex(_) => "INVALID_REGEX",
            AppError::Other(_) => "OTHER",
        }
    }
}

#[derive(Serialize)]
struct SerializedError {
    code: String,
    message: String,
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        SerializedError {
            code: self.code().to_string(),
            message: self.to_string(),
        }
        .serialize(serializer)
    }
}

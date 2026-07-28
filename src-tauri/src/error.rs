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
    #[error(
        "'{path}' is {}, which exceeds the {} open limit",
        format_bytes(*size),
        format_bytes(*limit)
    )]
    FileTooLarge { path: String, size: u64, limit: u64 },
}

/// Formats a byte count as human-readable mebibytes (e.g. `12.3 MiB`) for
/// use in user-facing error messages, where a raw byte count would be
/// unreadable.
fn format_bytes(bytes: u64) -> String {
    format!("{:.1} MiB", bytes as f64 / (1024.0 * 1024.0))
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
            AppError::FileTooLarge { .. } => "FILE_TOO_LARGE",
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_too_large_message_reports_size_and_limit_in_mib_with_no_duplicated_unit() {
        let err = AppError::FileTooLarge {
            path: "notes.md".to_string(),
            size: 12_897_484, // 12.3 MiB
            limit: 10 * 1024 * 1024,
        };
        assert_eq!(
            err.to_string(),
            "'notes.md' is 12.3 MiB, which exceeds the 10.0 MiB open limit"
        );
    }
}

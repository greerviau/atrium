pub mod local;

use crate::error::AppError;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc::UnboundedSender;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FsChangeKind {
    Create,
    Modify,
    Remove,
    Rename,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsChangeEvent {
    pub workspace_id: String,
    pub path: String,
    pub kind: FsChangeKind,
}

/// Everything a pane needs from "a place files live," independent of whether
/// that place is `LocalWorkspace` (the only implementation in the MVP) or a
/// future `RemoteWorkspace` (phase 3). Every `fs_*` command in `commands/fs.rs`
/// is written against this trait, not against `std::fs` directly, so adding a
/// remote implementation later only grows this module — it never touches
/// `commands/fs.rs` or the frontend.
#[async_trait]
pub trait Workspace: Send + Sync {
    async fn list_dir(&self, path: &str) -> Result<Vec<DirEntry>, AppError>;
    async fn read_file(&self, path: &str) -> Result<String, AppError>;
    async fn write_file(&self, path: &str, contents: &str) -> Result<(), AppError>;
    async fn create_file(&self, path: &str) -> Result<(), AppError>;
    async fn create_dir(&self, path: &str) -> Result<(), AppError>;
    async fn rename(&self, from: &str, to: &str) -> Result<(), AppError>;
    async fn delete(&self, path: &str, recursive: bool) -> Result<(), AppError>;
    /// The workspace root, used by `fs_resolve_candidates`'s third resolution
    /// step (relative to the workspace root).
    fn root(&self) -> &str;
    /// Starts (or is a no-op if already started) a recursive filesystem
    /// watcher rooted at this workspace, forwarding debounced events to `tx`.
    fn watch(&self, tx: UnboundedSender<FsChangeEvent>);
}

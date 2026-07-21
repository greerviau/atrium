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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptions {
    pub case_sensitive: bool,
    pub regex: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub path: String,
    /// 1-indexed, matches `PendingSelection.line` in `tabs.ts`.
    pub line: u32,
    /// 1-indexed UTF-16 code-unit offset, matches `PendingSelection.col` in
    /// `tabs.ts` (and thus how CodeMirror positions its cursor).
    pub column: u32,
    /// The full line, trailing newline stripped, for rendering.
    pub line_text: String,
    /// UTF-16 code-unit offset into `line_text` where the match starts, for
    /// highlighting — matches how `lineText.slice()` (JS strings) and
    /// CodeMirror both index text, not `line_text`'s UTF-8 byte layout.
    pub match_start: u32,
    /// UTF-16 code-unit offset into `line_text` where the match ends, for
    /// highlighting — see `match_start`.
    pub match_end: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    pub matches: Vec<SearchMatch>,
    /// True if the total- or per-file-match cap was hit.
    pub truncated: bool,
}

/// OS/VCS bookkeeping entries hidden from every `Workspace::list_dir`
/// listing by default, matching VS Code's own default `files.exclude`.
/// Deliberately narrow: build-artifact directories like `node_modules` or
/// `target` are left out, since hiding those needs a configurable exclude
/// setting or `.gitignore` parsing, not a fixed list.
const DEFAULT_IGNORED_NAMES: &[&str] = &[
    ".DS_Store",
    ".git",
    ".svn",
    ".hg",
    "CVS",
    "Thumbs.db",
    ".Spotlight-V100",
    ".Trashes",
];

/// Whether a directory entry's bare name should be hidden from every
/// `Workspace::list_dir` listing by default. Exact-name match only, so a
/// real file like `.gitignore` or `.env` is never caught by this.
pub fn is_default_ignored(name: &str) -> bool {
    DEFAULT_IGNORED_NAMES.contains(&name)
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
    /// Searches every text file under the workspace root for `query`,
    /// gitignore-aware and binary-safe, honoring `options`. Capped at 500
    /// total matches and 50 per file (see `LocalWorkspace::search`'s doc
    /// comment); `SearchResults.truncated` reports whether either cap was
    /// hit.
    async fn search(&self, query: &str, options: SearchOptions) -> Result<SearchResults, AppError>;
    /// The workspace root, used by `fs_resolve_candidates`'s third resolution
    /// step (relative to the workspace root).
    fn root(&self) -> &str;
    /// Starts (or is a no-op if already started) a recursive filesystem
    /// watcher rooted at this workspace, forwarding debounced events to `tx`.
    fn watch(&self, tx: UnboundedSender<FsChangeEvent>);
}

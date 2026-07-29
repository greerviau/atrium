//! `StandaloneWorkspace`: the root-less `Workspace` a file opened directly
//! from the OS (or the frontend's own "open standalone" path) is authorized
//! and watched through when no project workspace is open (issue #325).
//!
//! Registered once, at startup (`main.rs`'s `.setup()`), under
//! `STANDALONE_WORKSPACE_ID`, and **never torn down, replaced, or
//! reconstructed** by any project open/close/switch — this is the
//! authorization-lifetime precondition the whole feature depends on. Today,
//! `workspace_set_root` builds a brand-new `LocalWorkspace` (fresh, empty
//! `ExternalGrants`, fresh watcher) and drops the previous instance under
//! the same key on every call; a standalone tab routed through that same
//! `"local"` key would silently lose its authorization and its live-change
//! watch at the exact moment a project switch needs them least — a
//! surviving dirty standalone tab would become unsaveable.
//!
//! Every directory-shaped operation here is a hard rejection: there is no
//! root, so there is nothing to list/create/rename/delete/search within.
//! `read_file`/`write_file` go only through the shared `ExternalGrants`
//! allowlist — a *narrower* surface than `LocalWorkspace`'s own
//! external-file handling, never a wider one. A root-less workspace
//! implemented as `LocalWorkspace` with root `/` or `""` would make
//! `normalized.starts_with(&normalized_root)` true for every absolute path
//! on the machine — the literal shape of "absence of a root becomes absence
//! of a boundary." This type has no containment check of that shape at all.
//!
//! Grants on this workspace are session-lifetime, not per-project, by direct
//! consequence of never being torn down — accepted deliberately (see the
//! plan this implements), not a gap: an attacker who can induce a grant
//! once (`commands/fs.rs`'s `recently_opened_externally`) can re-induce it
//! at will, so persistence buys nothing they lacked.

use super::external_grants::ExternalGrants;
use super::{
    DirEntry, FileSearchResults, FsChangeEvent, FsChangeKind, SearchOptions, SearchResults,
    Workspace,
};
use crate::error::AppError;
use crate::workspace::local::{atomic_write, map_io_err, MAX_READABLE_FILE_SIZE_BYTES};
use async_trait::async_trait;
use notify::event::{ModifyKind, RenameMode};
use notify::{EventKind, RecursiveMode, Watcher};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, FileIdMap};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc::UnboundedSender;

/// The fixed id `StandaloneWorkspace` is registered under — see
/// `workspace::mod::register_startup_workspaces` and
/// `commands::workspace::is_reserved_workspace_id`, which refuses to ever
/// let `workspace_set_root` be called with this id.
pub const STANDALONE_WORKSPACE_ID: &str = "standalone";

/// A root-less `Workspace`: no directory listing, no containment boundary,
/// nothing but the explicit per-file `ExternalGrants` allowlist every
/// external-file mechanism in this app is built on. See the module doc
/// comment for why this must never be modeled as a `LocalWorkspace` with a
/// degenerate root instead.
pub struct StandaloneWorkspace {
    workspace_id: String,
    external_grants: Arc<ExternalGrants>,
    /// A clone of the sender `watch()` was last called with — see
    /// `LocalWorkspace`'s identically-named field (MF5a) for why this is
    /// retained separately from `external_watcher` itself: a grant created
    /// after `watch()` already ran still needs something to emit through.
    event_tx: Mutex<Option<UnboundedSender<FsChangeEvent>>>,
    /// The non-recursive watcher covering just the parent directories of
    /// currently-granted files — identical in shape to `LocalWorkspace`'s
    /// own `external_watcher`; there is no workspace-level recursive
    /// watcher here at all, since there is no root to recurse under.
    external_watcher: Mutex<Option<Debouncer<notify::RecommendedWatcher, FileIdMap>>>,
    /// Parent directories already registered with `external_watcher`, so a
    /// parent shared by two granted files is only watched once.
    watched_parents: Mutex<HashSet<PathBuf>>,
}

impl StandaloneWorkspace {
    pub fn new() -> Self {
        Self {
            workspace_id: STANDALONE_WORKSPACE_ID.to_string(),
            external_grants: Arc::new(ExternalGrants::new()),
            event_tx: Mutex::new(None),
            external_watcher: Mutex::new(None),
            watched_parents: Mutex::new(HashSet::new()),
        }
    }

    fn no_root_error(operation: impl std::fmt::Display) -> AppError {
        AppError::NoWorkspaceRoot(operation.to_string())
    }

    /// Identical in shape to `LocalWorkspace::watch_external_parent` —
    /// duplicated rather than shared so this can be diffed directly against
    /// that proven original, per the plan's own stated preference for this
    /// pass. Lazily starts (or reuses) the non-recursive external watcher
    /// and adds `parent` to its watch set if it isn't already watched.
    /// Best-effort: if `watch()` was never called (no `event_tx` to forward
    /// through yet), or the watch registration itself fails, the grant that
    /// triggered this still succeeds — it only means this one external file
    /// won't receive live change notifications.
    fn watch_external_parent(&self, parent: PathBuf) {
        if self.watched_parents.lock().unwrap().contains(&parent) {
            return;
        }
        let Some(tx) = self.event_tx.lock().unwrap().clone() else {
            return;
        };

        let mut guard = self.external_watcher.lock().unwrap();
        if guard.is_none() {
            let grants = Arc::clone(&self.external_grants);
            let workspace_id = self.workspace_id.clone();
            let send = move |path: &str, kind: FsChangeKind| {
                let _ = tx.send(FsChangeEvent {
                    workspace_id: workspace_id.clone(),
                    path: path.to_string(),
                    kind,
                    from_path: None,
                });
            };
            match new_debouncer(
                Duration::from_millis(150),
                None,
                move |result: DebounceEventResult| {
                    let Ok(events) = result else { return };
                    for event in events {
                        if event.event.kind == EventKind::Modify(ModifyKind::Name(RenameMode::Both))
                        {
                            if let [from, to] = event.event.paths.as_slice() {
                                if let Some(key) = grants.key_for_canonical_path(to) {
                                    send(&key, FsChangeKind::Modify);
                                }
                                if let Some(key) = grants.key_for_canonical_path(from) {
                                    send(&key, FsChangeKind::Remove);
                                }
                            }
                            continue;
                        }
                        let kind = match event.event.kind {
                            EventKind::Remove(_)
                            | EventKind::Modify(ModifyKind::Name(RenameMode::From)) => {
                                FsChangeKind::Remove
                            }
                            _ => FsChangeKind::Modify,
                        };
                        for path in &event.event.paths {
                            if let Some(key) = grants.key_for_canonical_path(path) {
                                send(&key, kind.clone());
                            }
                        }
                    }
                },
            ) {
                Ok(debouncer) => *guard = Some(debouncer),
                Err(err) => {
                    eprintln!("atrium: failed to start standalone external file watcher: {err}");
                    return;
                }
            }
        }

        if let Some(debouncer) = guard.as_mut() {
            if debouncer
                .watcher()
                .watch(&parent, RecursiveMode::NonRecursive)
                .is_ok()
            {
                self.watched_parents.lock().unwrap().insert(parent);
            }
        }
    }
}

impl Default for StandaloneWorkspace {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Workspace for StandaloneWorkspace {
    async fn list_dir(&self, path: &str) -> Result<Vec<DirEntry>, AppError> {
        Err(Self::no_root_error(format!(
            "cannot list directory '{path}'"
        )))
    }

    /// Reads `path`'s entire contents as UTF-8, authorized only via an
    /// explicit `ExternalGrants` entry — there is no root to fall back to.
    /// Applies the same `MAX_READABLE_FILE_SIZE_BYTES` guard `LocalWorkspace`
    /// does, for the identical reason (bounding the IPC payload and the cost
    /// of seeding a CodeMirror document from it).
    async fn read_file(&self, path: &str) -> Result<String, AppError> {
        let Some(target) = self.external_grants.resolve_granted(path).await? else {
            return Err(Self::no_root_error(format!(
                "'{path}' is not a granted external file"
            )));
        };
        let metadata = tokio::fs::metadata(&target)
            .await
            .map_err(|e| map_io_err(e, path))?;
        if metadata.len() > MAX_READABLE_FILE_SIZE_BYTES {
            return Err(AppError::FileTooLarge {
                path: path.to_string(),
                size: metadata.len(),
                limit: MAX_READABLE_FILE_SIZE_BYTES,
            });
        }
        let bytes = tokio::fs::read(&target)
            .await
            .map_err(|e| map_io_err(e, path))?;
        String::from_utf8(bytes).map_err(|_| AppError::NotUtf8(path.to_string()))
    }

    /// Writes `contents` atomically and durably via the same
    /// temp-file-write-fsync-rename sequence `LocalWorkspace::write_file`
    /// uses, authorized only via an explicit `ExternalGrants` entry (which
    /// also covers recreating a genuinely-deleted granted file). Refreshes
    /// the grant's recorded identity afterward (MF1) — without this, the
    /// identity recorded at grant time goes stale after the first save and
    /// every later read/write of the same tab is wrongly rejected.
    async fn write_file(&self, path: &str, contents: &str) -> Result<(), AppError> {
        let Some(target) = self.external_grants.resolve_granted_for_write(path).await? else {
            return Err(Self::no_root_error(format!(
                "'{path}' is not a granted external file"
            )));
        };
        let contents = contents.as_bytes().to_vec();
        tokio::task::spawn_blocking(move || atomic_write(&target, &contents))
            .await
            .map_err(|err| AppError::Other(format!("save task panicked: {err}")))?
            .map_err(|e| map_io_err(e, path))?;
        self.external_grants.refresh_if_granted(path).await;
        Ok(())
    }

    async fn create_file(&self, path: &str) -> Result<(), AppError> {
        Err(Self::no_root_error(format!("cannot create file '{path}'")))
    }

    async fn create_dir(&self, path: &str) -> Result<(), AppError> {
        Err(Self::no_root_error(format!(
            "cannot create directory '{path}'"
        )))
    }

    async fn rename(&self, from: &str, to: &str) -> Result<(), AppError> {
        Err(Self::no_root_error(format!(
            "cannot rename '{from}' to '{to}'"
        )))
    }

    async fn delete(&self, path: &str, _recursive: bool) -> Result<(), AppError> {
        Err(Self::no_root_error(format!("cannot delete '{path}'")))
    }

    async fn import_external(
        &self,
        dest_dir: &str,
        _source_paths: &[String],
    ) -> Result<(), AppError> {
        Err(Self::no_root_error(format!(
            "cannot import into '{dest_dir}'"
        )))
    }

    async fn search(
        &self,
        _query: &str,
        _options: SearchOptions,
    ) -> Result<SearchResults, AppError> {
        Err(Self::no_root_error("cannot search"))
    }

    async fn find_files(&self, _query: &str) -> Result<FileSearchResults, AppError> {
        Err(Self::no_root_error("cannot find files"))
    }

    fn root(&self) -> &str {
        ""
    }

    fn resolve_within_root(&self, path: &str) -> Result<PathBuf, AppError> {
        Err(Self::no_root_error(format!(
            "'{path}' does not resolve within any root"
        )))
    }

    /// Stores `tx` so `watch_external_parent` (triggered by a later
    /// `grant_external_file`) has something to forward events through —
    /// there is no recursive tree to watch, so unlike `LocalWorkspace::watch`
    /// this never starts a `fs_watch::watch` debouncer of its own. Called
    /// once at registration time in `main.rs`'s `.setup()`, alongside the
    /// `mpsc` channel whose receiver is pumped into `app_handle.emit`.
    fn watch(&self, tx: UnboundedSender<FsChangeEvent>) {
        *self.event_tx.lock().unwrap() = Some(tx);
    }

    /// Delegates directly to the shared `ExternalGrants` — since
    /// `resolve_within_root` always fails, every granted path takes the
    /// "genuinely external" branch, exactly the same code shape
    /// `LocalWorkspace::grant_external_file` already uses.
    async fn grant_external_file(&self, path: &str) -> Result<(), AppError> {
        if self.resolve_within_root(path).is_ok() {
            return Ok(());
        }
        self.external_grants.grant(path).await?;
        if let Ok(canonical) = tokio::fs::canonicalize(path).await {
            if let Some(parent) = canonical.parent() {
                self.watch_external_parent(parent.to_path_buf());
            }
        }
        Ok(())
    }

    async fn resolve_external_asset(&self, candidate: &str) -> Option<PathBuf> {
        self.external_grants.resolve_asset(candidate).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc::unbounded_channel;

    #[tokio::test]
    async fn every_directory_shaped_operation_is_a_hard_rejection() {
        let ws = StandaloneWorkspace::new();
        assert!(ws.list_dir("/anything").await.is_err());
        assert!(ws.create_file("/anything").await.is_err());
        assert!(ws.create_dir("/anything").await.is_err());
        assert!(ws.rename("/a", "/b").await.is_err());
        assert!(ws.delete("/anything", false).await.is_err());
        assert!(ws.import_external("/dest", &[]).await.is_err());
        assert!(ws
            .search(
                "q",
                SearchOptions {
                    case_sensitive: false,
                    regex: false
                }
            )
            .await
            .is_err());
        assert!(ws.find_files("q").await.is_err());
        assert!(ws.resolve_within_root("/anything").is_err());
        assert_eq!(ws.root(), "");
    }

    #[tokio::test]
    async fn read_file_rejects_a_path_that_was_never_granted() {
        let ws = StandaloneWorkspace::new();
        let err = ws.read_file("/never/granted.txt").await.unwrap_err();
        assert!(matches!(err, AppError::NoWorkspaceRoot(_)));
    }

    #[tokio::test]
    async fn a_granted_file_can_be_read_and_written() {
        let outside = tempfile::tempdir().unwrap();
        let file = outside.path().join("notes.txt");
        std::fs::write(&file, "original").unwrap();

        let ws = StandaloneWorkspace::new();
        let key = file.to_str().unwrap().to_string();
        ws.grant_external_file(&key).await.unwrap();

        assert_eq!(ws.read_file(&key).await.unwrap(), "original");
        ws.write_file(&key, "updated").await.unwrap();
        assert_eq!(ws.read_file(&key).await.unwrap(), "updated");
    }

    // Test 2(b) — a real watcher test against `StandaloneWorkspace` directly:
    // grant a file, mutate it on disk, assert an `fs:changed` event arrives.
    // Mirrors `workspace/local.rs`'s
    // `external_watcher_reports_modify_after_a_rename_onto_target_and_remove_after_deletion`,
    // which already proves this exact shape is writable with a temp dir and
    // no `AppHandle`.
    #[tokio::test]
    async fn standalone_external_watcher_reports_modify_after_a_rename_onto_target_and_remove_after_deletion(
    ) {
        let outside = tempfile::tempdir().unwrap();
        let file = outside.path().join("notes.txt");
        std::fs::write(&file, "original").unwrap();

        let ws = StandaloneWorkspace::new();
        let (tx, mut rx) = unbounded_channel();
        ws.watch(tx);

        let key = file.to_str().unwrap().to_string();
        ws.grant_external_file(&key).await.unwrap();

        // Let the watcher startup settle (mirrors fs_watch.rs's own tests'
        // STARTUP_SETTLE_MS convention).
        tokio::time::sleep(Duration::from_millis(500)).await;
        while tokio::time::timeout(Duration::from_millis(10), rx.recv())
            .await
            .is_ok()
        {}

        // Mirror atomic_write's own mechanism: write a temp file in the same
        // directory, then rename it onto the target.
        let tmp = outside.path().join(".tmp-save");
        std::fs::write(&tmp, "updated").unwrap();
        std::fs::rename(&tmp, &file).unwrap();

        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        let mut saw_modify = false;
        while tokio::time::Instant::now() < deadline {
            if let Ok(Some(event)) =
                tokio::time::timeout(Duration::from_millis(100), rx.recv()).await
            {
                if event.path == key && matches!(event.kind, FsChangeKind::Modify) {
                    saw_modify = true;
                    break;
                }
            }
        }
        assert!(
            saw_modify,
            "expected a Modify event for the granted key after a rename-onto-target save"
        );

        std::fs::remove_file(&file).unwrap();

        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        let mut saw_remove = false;
        while tokio::time::Instant::now() < deadline {
            if let Ok(Some(event)) =
                tokio::time::timeout(Duration::from_millis(100), rx.recv()).await
            {
                if event.path == key && matches!(event.kind, FsChangeKind::Remove) {
                    saw_remove = true;
                    break;
                }
            }
        }
        assert!(
            saw_remove,
            "expected a Remove event for the granted key after deletion"
        );
    }
}

use super::{DirEntry, FsChangeEvent, Workspace};
use crate::error::AppError;
use crate::fs_watch;
use async_trait::async_trait;
use notify_debouncer_full::{Debouncer, FileIdMap};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tokio::sync::mpsc::UnboundedSender;

/// The only `Workspace` implementation in the MVP: a directory on the local
/// filesystem. Every method resolves its `path` argument against `root` and
/// rejects any path that would escape it (`..` components) — this is the
/// access-control boundary referenced in the IPC contract's capabilities
/// note (plan section 5): the capability file grants our own commands
/// unconditionally, and it is `LocalWorkspace::resolve_within_root` alone
/// that decides whether a given path is actually reachable.
pub struct LocalWorkspace {
    root: PathBuf,
    workspace_id: String,
    watcher: Mutex<Option<Debouncer<notify::RecommendedWatcher, FileIdMap>>>,
}

impl LocalWorkspace {
    pub fn new(workspace_id: String, root: PathBuf) -> Self {
        Self {
            root,
            workspace_id,
            watcher: Mutex::new(None),
        }
    }

    /// Resolves `path` (absolute, or relative to `root`) against `root`,
    /// rejecting anything that would escape it.
    fn resolve_within_root(&self, path: &str) -> Result<PathBuf, AppError> {
        let candidate = Path::new(path);
        let joined = if candidate.is_absolute() {
            candidate.to_path_buf()
        } else {
            self.root.join(candidate)
        };

        let normalized = normalize(&joined);
        let normalized_root = normalize(&self.root);

        if !normalized.starts_with(&normalized_root) {
            return Err(AppError::InvalidPath(format!(
                "path '{path}' escapes the workspace root"
            )));
        }
        Ok(normalized)
    }
}

/// Lexically normalizes a path (resolves `.`/`..` components without
/// touching the filesystem, so it also works for paths that don't exist
/// yet, e.g. `fs_create_file`).
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

#[async_trait]
impl Workspace for LocalWorkspace {
    async fn list_dir(&self, path: &str) -> Result<Vec<DirEntry>, AppError> {
        let dir = self.resolve_within_root(path)?;
        let mut entries = Vec::new();
        let mut read_dir = tokio::fs::read_dir(&dir).await?;
        while let Some(entry) = read_dir.next_entry().await? {
            let metadata = entry.metadata().await?;
            let file_type = entry.file_type().await?;
            entries.push(DirEntry {
                name: entry.file_name().to_string_lossy().to_string(),
                path: entry.path().to_string_lossy().to_string(),
                is_dir: metadata.is_dir(),
                is_symlink: file_type.is_symlink(),
            });
        }
        entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        });
        Ok(entries)
    }

    async fn read_file(&self, path: &str) -> Result<String, AppError> {
        let file = self.resolve_within_root(path)?;
        let bytes = tokio::fs::read(&file).await?;
        String::from_utf8(bytes).map_err(|_| AppError::NotUtf8(path.to_string()))
    }

    async fn write_file(&self, path: &str, contents: &str) -> Result<(), AppError> {
        let file = self.resolve_within_root(path)?;
        tokio::fs::write(&file, contents).await?;
        Ok(())
    }

    async fn create_file(&self, path: &str) -> Result<(), AppError> {
        let file = self.resolve_within_root(path)?;
        if file.exists() {
            return Err(AppError::AlreadyExists(path.to_string()));
        }
        tokio::fs::File::create_new(&file).await?;
        Ok(())
    }

    async fn create_dir(&self, path: &str) -> Result<(), AppError> {
        let dir = self.resolve_within_root(path)?;
        if dir.exists() {
            return Err(AppError::AlreadyExists(path.to_string()));
        }
        tokio::fs::create_dir_all(&dir).await?;
        Ok(())
    }

    async fn rename(&self, from: &str, to: &str) -> Result<(), AppError> {
        let from_path = self.resolve_within_root(from)?;
        let to_path = self.resolve_within_root(to)?;
        tokio::fs::rename(&from_path, &to_path).await?;
        Ok(())
    }

    async fn delete(&self, path: &str, recursive: bool) -> Result<(), AppError> {
        let target = self.resolve_within_root(path)?;
        let metadata = tokio::fs::metadata(&target).await?;
        if metadata.is_dir() {
            if recursive {
                tokio::fs::remove_dir_all(&target).await?;
            } else {
                tokio::fs::remove_dir(&target).await?;
            }
        } else {
            tokio::fs::remove_file(&target).await?;
        }
        Ok(())
    }

    fn root(&self) -> &str {
        self.root.to_str().unwrap_or("")
    }

    fn watch(&self, tx: UnboundedSender<FsChangeEvent>) {
        let mut guard = self.watcher.lock().unwrap();
        if guard.is_some() {
            return;
        }
        let debouncer = fs_watch::watch(self.root().to_string(), self.workspace_id.clone(), tx);
        *guard = Some(debouncer);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace(root: &Path) -> LocalWorkspace {
        LocalWorkspace::new("local".to_string(), root.to_path_buf())
    }

    #[tokio::test]
    async fn rejects_parent_dir_escape() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        let err = ws.read_file("../outside.txt").await.unwrap_err();
        assert!(matches!(err, AppError::InvalidPath(_)));
    }

    #[tokio::test]
    async fn round_trips_file_contents() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        ws.create_file("note.md").await.unwrap();
        ws.write_file("note.md", "hello").await.unwrap();
        let contents = ws.read_file("note.md").await.unwrap();
        assert_eq!(contents, "hello");
    }

    #[tokio::test]
    async fn create_file_errors_if_exists() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        ws.create_file("note.md").await.unwrap();
        let err = ws.create_file("note.md").await.unwrap_err();
        assert!(matches!(err, AppError::AlreadyExists(_)));
    }

    #[tokio::test]
    async fn delete_requires_recursive_for_nonempty_dir() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        ws.create_dir("sub").await.unwrap();
        ws.create_file("sub/note.md").await.unwrap();
        assert!(ws.delete("sub", false).await.is_err());
        ws.delete("sub", true).await.unwrap();
        assert!(!dir.path().join("sub").exists());
    }

    #[tokio::test]
    async fn list_dir_sorts_dirs_first_then_alphabetical() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        ws.create_file("b.txt").await.unwrap();
        ws.create_file("a.txt").await.unwrap();
        ws.create_dir("z_dir").await.unwrap();
        let entries = ws.list_dir(".").await.unwrap();
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["z_dir", "a.txt", "b.txt"]);
    }
}

use crate::error::AppError;
use crate::link_resolve::{self, PathCandidate};
use crate::state::AppState;
use crate::workspace::{DirEntry, Workspace};
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::State;

/// How long a real, backend-observed drop's path set stays valid for
/// `fs_grant_external_file` to authorize a grant against (§4.9 of the
/// drag-a-file-into-the-editor plan) — generous enough for the sequential
/// per-file grant loop the frontend's drop handler runs (§6.2) to complete,
/// tightened from an initial, far more permissive window specifically to
/// shrink the exposure window described in `require_recent_drop`'s own doc
/// comment.
const RECENT_DROP_WINDOW: Duration = Duration::from_secs(10);

/// Gates `fs_grant_external_file` on a real, backend-observed OS drop having
/// just happened for this exact `path` — the fix for a gap where an earlier
/// draft of this design let any renderer-side caller (a compromised
/// dependency, an XSS) invoke the grant command directly with an arbitrary
/// path, with nothing enforcing that a human actually dragged that file in.
/// `AppState.recent_drop` is written only by `main.rs`'s own
/// `WindowEvent::DragDrop` handler, on the Rust side, which no renderer-side
/// bug alone can fabricate.
///
/// Deliberately not single-use/consumed-on-check: the most recent real
/// drop's path set stays valid for the whole window, and re-checking the
/// same already-legitimately-dropped path more than once is harmless — the
/// human did drop that exact file. Stated plainly because it's a real,
/// load-bearing scoping gap rather than an implementation detail:
/// `WindowEvent::DragDrop` fires for *any* drop landing anywhere on the
/// window, not just the editor panel — the backend has no way to hit-test
/// the DOM the way the frontend's own drop-target resolvers do. So this
/// enforces "a file was recently dropped onto this window," not "onto the
/// editor panel specifically"; the 10-second window is the concrete
/// mitigation available for that gap without hit-testing the DOM from Rust.
fn require_recent_drop(state: &AppState, path: &str) -> Result<(), AppError> {
    if recently_dropped(&state.recent_drop, path) {
        Ok(())
    } else {
        Err(AppError::InvalidPath(format!(
            "'{path}' was not part of a recent drop onto this window"
        )))
    }
}

/// The pure check behind `require_recent_drop`, split out so it's testable
/// without constructing a full `AppState` (which needs a real
/// `tauri::AppHandle` — see `commands::shell`'s `is_pr_url`/`is_web_url` for
/// the same "extract the pure logic, test that" convention this codebase
/// already uses for command-layer code that would otherwise need a live app
/// to test).
fn recently_dropped(recent_drop: &Mutex<Option<(HashSet<String>, Instant)>>, path: &str) -> bool {
    let guard = recent_drop.lock().unwrap();
    matches!(
        &*guard,
        Some((paths, at)) if paths.contains(path) && at.elapsed() < RECENT_DROP_WINDOW
    )
}

/// Clones the `Arc<dyn Workspace>` for `workspace_id` out of the state and
/// drops the lock before returning, so callers can `.await` on the workspace
/// without holding a `MutexGuard` across the await point (see the note on
/// `AppState::workspaces`).
fn workspace(
    state: &State<'_, AppState>,
    workspace_id: &str,
) -> Result<Arc<dyn Workspace>, AppError> {
    state
        .workspaces
        .lock()
        .unwrap()
        .get(workspace_id)
        .cloned()
        .ok_or_else(|| AppError::UnknownWorkspace(workspace_id.to_string()))
}

#[tauri::command]
pub async fn fs_list_dir(
    state: State<'_, AppState>,
    workspace_id: String,
    path: String,
) -> Result<Vec<DirEntry>, AppError> {
    workspace(&state, &workspace_id)?.list_dir(&path).await
}

#[tauri::command]
pub async fn fs_read_file(
    state: State<'_, AppState>,
    workspace_id: String,
    path: String,
) -> Result<String, AppError> {
    workspace(&state, &workspace_id)?.read_file(&path).await
}

#[tauri::command]
pub async fn fs_write_file(
    state: State<'_, AppState>,
    workspace_id: String,
    path: String,
    contents: String,
) -> Result<(), AppError> {
    workspace(&state, &workspace_id)?
        .write_file(&path, &contents)
        .await
}

#[tauri::command]
pub async fn fs_create_file(
    state: State<'_, AppState>,
    workspace_id: String,
    path: String,
) -> Result<(), AppError> {
    workspace(&state, &workspace_id)?.create_file(&path).await
}

#[tauri::command]
pub async fn fs_create_dir(
    state: State<'_, AppState>,
    workspace_id: String,
    path: String,
) -> Result<(), AppError> {
    workspace(&state, &workspace_id)?.create_dir(&path).await
}

#[tauri::command]
pub async fn fs_rename(
    state: State<'_, AppState>,
    workspace_id: String,
    from: String,
    to: String,
) -> Result<(), AppError> {
    workspace(&state, &workspace_id)?.rename(&from, &to).await
}

#[tauri::command]
pub async fn fs_delete(
    state: State<'_, AppState>,
    workspace_id: String,
    path: String,
    recursive: bool,
) -> Result<(), AppError> {
    workspace(&state, &workspace_id)?
        .delete(&path, recursive)
        .await
}

#[tauri::command]
pub async fn fs_import_external_paths(
    state: State<'_, AppState>,
    workspace_id: String,
    dest_dir: String,
    source_paths: Vec<String>,
) -> Result<(), AppError> {
    workspace(&state, &workspace_id)?
        .import_external(&dest_dir, &source_paths)
        .await
}

#[tauri::command]
pub async fn fs_resolve_candidates(
    state: State<'_, AppState>,
    workspace_id: String,
    candidates: Vec<PathCandidate>,
) -> Result<Vec<Option<String>>, AppError> {
    let root = workspace(&state, &workspace_id)?.root().to_string();
    Ok(candidates
        .iter()
        .map(|c| link_resolve::resolve_candidate(c, &root))
        .collect())
}

/// Classifies each of `paths` as a directory (`true`) or not (`false`),
/// following symlinks — used by the editor-panel drop handler (§7.3 of the
/// drag-a-file-into-the-editor plan) to route a dropped directory into the
/// existing import-into-workspace flow and a dropped file into the new
/// open/grant flow. Batched rather than one call per path, and no
/// `Result`/`AppError`: a `stat` failure (permission denied, a race where the
/// path vanished between drop and this call) degrades to `false` — treated
/// as "not a directory," so it falls through to the existing file-open path,
/// which has its own well-tested error handling for a missing/unreadable
/// file — rather than failing the whole batch over one bad path.
///
/// Deliberately unscoped to any workspace: this only ever echoes back a
/// boolean about a path the caller already possesses, not a meaningful
/// widening of what a compromised renderer could already do —
/// `workspace_set_root` already accepts an arbitrary path with zero
/// validation, and `import_external` already applies containment only to
/// its destination, never its sources, both pre-existing on `origin/main`
/// and out of scope for this plan.
#[tauri::command]
pub async fn fs_external_paths_are_dirs(paths: Vec<String>) -> Vec<bool> {
    let mut result = Vec::with_capacity(paths.len());
    for path in &paths {
        let is_dir = tokio::fs::metadata(path)
            .await
            .map(|m| m.is_dir())
            .unwrap_or(false);
        result.push(is_dir);
    }
    result
}

/// The only command that ever creates an external-file grant (§4.3) — gated
/// on `require_recent_drop` so a compromised renderer calling this directly
/// with an arbitrary path, with no real drop having happened, is refused
/// before it ever reaches `grant_external_file`.
#[tauri::command]
pub async fn fs_grant_external_file(
    state: State<'_, AppState>,
    workspace_id: String,
    path: String,
) -> Result<(), AppError> {
    require_recent_drop(&state, &path)?;
    workspace(&state, &workspace_id)?
        .grant_external_file(&path)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn fs_external_paths_are_dirs_classifies_each_kind() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("file.txt");
        std::fs::write(&file, "hi").unwrap();
        let subdir = dir.path().join("subdir");
        std::fs::create_dir(&subdir).unwrap();
        let dir_link = dir.path().join("dir_link");
        std::os::unix::fs::symlink(&subdir, &dir_link).unwrap();
        let file_link = dir.path().join("file_link");
        std::os::unix::fs::symlink(&file, &file_link).unwrap();
        let broken_link = dir.path().join("broken_link");
        std::os::unix::fs::symlink(dir.path().join("nowhere"), &broken_link).unwrap();
        let missing = dir.path().join("missing");

        let result = fs_external_paths_are_dirs(vec![
            file.to_str().unwrap().to_string(),
            subdir.to_str().unwrap().to_string(),
            dir_link.to_str().unwrap().to_string(),
            file_link.to_str().unwrap().to_string(),
            missing.to_str().unwrap().to_string(),
            broken_link.to_str().unwrap().to_string(),
        ])
        .await;

        assert_eq!(result, vec![false, true, true, false, false, false]);
    }

    // MF4 — require_recent_drop's pure core, `recently_dropped`.
    #[test]
    fn recently_dropped_is_false_when_nothing_was_ever_dropped() {
        let recent_drop: Mutex<Option<(HashSet<String>, Instant)>> = Mutex::new(None);
        assert!(!recently_dropped(&recent_drop, "/a/b.txt"));
    }

    #[test]
    fn recently_dropped_is_false_for_a_path_that_was_not_part_of_the_drop() {
        let recent_drop = Mutex::new(Some((
            HashSet::from(["/a/b.txt".to_string()]),
            Instant::now(),
        )));
        assert!(!recently_dropped(&recent_drop, "/a/other.txt"));
    }

    #[test]
    fn recently_dropped_is_false_once_the_window_has_elapsed() {
        let stale_at = Instant::now() - (RECENT_DROP_WINDOW + Duration::from_secs(1));
        let recent_drop = Mutex::new(Some((HashSet::from(["/a/b.txt".to_string()]), stale_at)));
        assert!(!recently_dropped(&recent_drop, "/a/b.txt"));
    }

    #[test]
    fn recently_dropped_is_true_for_the_right_path_within_the_window() {
        let recent_drop = Mutex::new(Some((
            HashSet::from(["/a/b.txt".to_string()]),
            Instant::now(),
        )));
        assert!(recently_dropped(&recent_drop, "/a/b.txt"));
    }
}

use crate::error::AppError;
use crate::link_resolve::{self, PathCandidate};
use crate::state::AppState;
use crate::workspace::{DirEntry, Workspace};
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::State;

/// How long a real, backend-observed drop's (or OS-open's) path set stays
/// valid for `fs_grant_external_file` to authorize a grant against (§4.9 of
/// the drag-a-file-into-the-editor plan) — generous enough for the
/// sequential per-file grant loop the frontend's drop handler runs (§6.2) to
/// complete, tightened from an initial, far more permissive window
/// specifically to shrink the exposure window described in
/// `recently_opened_externally`'s own doc comment.
const RECENT_DROP_WINDOW: Duration = Duration::from_secs(10);

/// Gates `fs_grant_external_file` on a real, backend-observed drop or
/// OS-open request having just happened for this exact `path` — the fix for
/// a gap where an earlier draft of this design let any renderer-side caller
/// (a compromised dependency, an XSS) invoke the grant command directly with
/// an arbitrary path, with nothing enforcing that a human actually dragged
/// that file in or the OS was actually asked to open it. `AppState.recent_drop`
/// is written only by `main.rs`'s own `WindowEvent::DragDrop` handler, and
/// the OS-open provenance record only by `macos_dock::open_paths` via
/// `launch_open::record_os_open`, both on the Rust side, which no
/// renderer-side bug alone can fabricate.
///
/// Deliberately not single-use/consumed-on-check: the most recent real
/// event's path set stays valid for the whole window, and re-checking the
/// same already-legitimately-authorized path more than once is harmless —
/// the human did drop, or the OS was genuinely asked to open, that exact
/// file. Stated plainly because it's a real, load-bearing scoping gap rather
/// than an implementation detail: `WindowEvent::DragDrop` fires for *any*
/// drop landing anywhere on the window, not just the editor panel — the
/// backend has no way to hit-test the DOM the way the frontend's own
/// drop-target resolvers do. So this enforces "a file was recently dropped
/// onto this window," not "onto the editor panel specifically"; the
/// 10-second window is the concrete mitigation available for that gap
/// without hit-testing the DOM from Rust.
///
/// `path` is authorized if it was part of a recent, backend-observed event
/// from EITHER trusted origin. The two origins are NOT equally strong —
/// `recent_drop` requires a physical drag gesture on this window; the
/// OS-open origin (`launch_open::recently_os_opened`) requires only that
/// some local process ask the OS to open `path` with Atrium (no human
/// gesture at all), and this app's own PTY commands already let a
/// compromised renderer induce that state directly. Accepted: a compromised
/// renderer already has arbitrary local execution via the PTY, so nothing
/// new becomes reachable. If the PTY commands are ever scoped down, the
/// OS-open origin becomes the weakest remaining link in this gate — revisit
/// then.
fn recently_opened_externally(
    recent_drop: &Mutex<Option<(HashSet<String>, Instant)>>,
    path: &str,
) -> bool {
    recently_dropped(recent_drop, path) || crate::launch_open::recently_os_opened(path)
}

fn require_recent_external_open(state: &AppState, path: &str) -> Result<(), AppError> {
    if recently_opened_externally(&state.recent_drop, path) {
        Ok(())
    } else {
        Err(AppError::InvalidPath(format!(
            "'{path}' was not part of a recent drop or OS open request onto this window"
        )))
    }
}

/// The pure check behind `require_recent_external_open`, split out so it's testable
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
    tokio::task::spawn_blocking(move || link_resolve::resolve_candidates(&candidates, &root))
        .await
        .map_err(|err| AppError::Other(format!("file-path resolution task failed: {err}")))
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
/// on `require_recent_external_open` so a compromised renderer calling this
/// directly with an arbitrary path, with no real drop or OS-open request
/// having happened, is refused before it ever reaches `grant_external_file`.
#[tauri::command]
pub async fn fs_grant_external_file(
    state: State<'_, AppState>,
    workspace_id: String,
    path: String,
) -> Result<(), AppError> {
    require_recent_external_open(&state, &path)?;
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

    // MF4 — recently_opened_externally's shared pure core, `recently_dropped`.
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

    // `recently_opened_externally` — accepted from the `recent_drop` origin
    // alone, rejected once it's expired. The OS-open origin now lives behind
    // `launch_open`'s own process-global statics rather than a `Mutex` this
    // test module can construct locally; see
    // `recently_opened_externally_routes_the_os_open_origin_through_launch_open`
    // below for that half, and `launch_open`'s own test module (§9.2 test 6)
    // for the OS-open origin's expiry behavior specifically.
    #[test]
    fn recently_opened_externally_accepts_a_path_from_recent_drop_alone() {
        let recent_drop = Mutex::new(Some((
            HashSet::from(["/a/b.txt".to_string()]),
            Instant::now(),
        )));
        assert!(recently_opened_externally(&recent_drop, "/a/b.txt"));
    }

    #[test]
    fn recently_opened_externally_rejects_a_path_once_recent_drop_has_expired() {
        let stale_at = Instant::now() - (RECENT_DROP_WINDOW + Duration::from_secs(1));
        let recent_drop = Mutex::new(Some((HashSet::from(["/a/b.txt".to_string()]), stale_at)));
        assert!(!recently_opened_externally(&recent_drop, "/a/b.txt"));
    }

    // Test 8 (§9.2) — `recently_opened_externally` also authorizes via the
    // OS-open origin, routed through `launch_open::recently_os_opened`
    // (the real, process-global instance — this is the one test in the
    // crate that touches it, deliberately: `launch_open`'s own tests all
    // construct a local `LaunchOpenState` instead precisely so they can run
    // concurrently with everything else under `cargo test` without racing
    // this shared static). Both assertions run in one test, sequentially on
    // one thread, so there's no risk of another test's `record_os_open`
    // call landing between them.
    #[test]
    fn recently_opened_externally_routes_the_os_open_origin_through_launch_open() {
        let recent_drop: Mutex<Option<(HashSet<String>, Instant)>> = Mutex::new(None);
        let never_recorded = "/tmp/atrium-test-recently-opened-externally-neither.md";
        assert!(!recently_opened_externally(&recent_drop, never_recorded));

        let os_opened = "/tmp/atrium-test-recently-opened-externally-os-open.md";
        crate::launch_open::record_os_open(&[os_opened.to_string()]);
        assert!(recently_opened_externally(&recent_drop, os_opened));
        assert!(!recently_opened_externally(&recent_drop, never_recorded));
    }
}

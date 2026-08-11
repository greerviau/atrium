use crate::error::AppError;
use crate::recents::{self, RecentProject};
use crate::state::AppState;
use crate::workspace::local::LocalWorkspace;
use crate::workspace::standalone::STANDALONE_WORKSPACE_ID;
use crate::workspace::Workspace;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::mpsc;

#[tauri::command]
pub async fn workspace_open_folder_dialog(
    app: tauri::AppHandle,
) -> Result<Option<String>, AppError> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |folder| {
        let _ = tx.send(folder);
    });
    let folder = rx
        .await
        .map_err(|e| AppError::Other(format!("folder dialog closed unexpectedly: {e}")))?;
    Ok(folder.map(|f| f.to_string()))
}

/// Whether `id` is a reserved workspace id that `workspace_set_root` must
/// never be allowed to overwrite — today, only `StandaloneWorkspace`'s own
/// id. Split out as a pure predicate (no `AppState`/`AppHandle` involved) so
/// it's directly testable, the same convention `recently_dropped` and
/// `launch_open`'s own pure `record`/`take` already establish in this
/// codebase.
fn is_reserved_workspace_id(id: &str) -> bool {
    id == STANDALONE_WORKSPACE_ID
}

/// Inserts `workspace` under `workspace_id`, leaving every other entry —
/// in particular a separately-keyed `"standalone"` entry — untouched. Pure
/// over the bare registry (no `AppState`/`AppHandle`) so a test can pre-seed
/// a fake `"standalone"` entry and assert it survives a `"local"` insert by
/// identity (`Arc::ptr_eq`), without constructing a full `AppState`.
fn register_workspace(
    workspaces: &Mutex<HashMap<String, Arc<dyn Workspace>>>,
    workspace_id: String,
    workspace: Arc<dyn Workspace>,
) {
    workspaces.lock().unwrap().insert(workspace_id, workspace);
}

#[tauri::command]
pub async fn workspace_set_root(
    state: State<'_, AppState>,
    workspace_id: String,
    path: String,
) -> Result<(), AppError> {
    if is_reserved_workspace_id(&workspace_id) {
        return Err(AppError::InvalidPath(format!(
            "'{workspace_id}' is a reserved workspace id and cannot be reassigned"
        )));
    }

    let workspace = LocalWorkspace::new(workspace_id.clone(), PathBuf::from(&path));

    let (tx, mut rx) = mpsc::unbounded_channel();
    workspace.watch(tx);

    let app_handle = state.app_handle.clone();
    tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            let _ = app_handle.emit("fs:changed", event);
        }
    });

    register_workspace(&state.workspaces, workspace_id, Arc::new(workspace));

    // Every "open a folder" action (in-app button, `File` menu, Dock menu)
    // funnels through this command, so recording the recent-project entry
    // here — rather than in each caller — guarantees the list can never
    // miss an entry or drift from what's actually open. This is ancillary
    // to the core "open a folder" action above, so a failure here (e.g. a
    // full disk) is logged and swallowed rather than aborting the command
    // and leaving the frontend's workspace store un-updated.
    if let Err(err) = recents::record(&state.app_handle, &path) {
        eprintln!("atrium: failed to record recent project: {err}");
    }

    // `note_recent_document` calls into AppKit, which requires the main
    // thread; async command bodies run on Tauri's async runtime pool, not
    // necessarily the main thread, so dispatch explicitly rather than
    // calling it inline (where `MainThreadMarker::new()` would silently
    // return `None` and no-op).
    #[cfg(target_os = "macos")]
    {
        let path_for_main_thread = path.clone();
        let _ = state.app_handle.run_on_main_thread(move || {
            crate::macos_dock::note_recent_document(&path_for_main_thread)
        });
    }

    Ok(())
}

#[tauri::command]
pub fn workspace_get_recents(app: AppHandle) -> Result<Vec<RecentProject>, AppError> {
    recents::get_recents(&app)
}

#[tauri::command]
pub fn workspace_remove_recent(app: AppHandle, path: String) -> Result<(), AppError> {
    recents::remove_recent(&app, &path)
}

/// Drains every path from a Dock-menu pick (or OS "Open With Atrium")
/// received before the frontend declared itself ready (the cold-launch case,
/// issue #325's cold-launch plan). Called once by the frontend on startup,
/// after registering its live listener; returns an empty `Vec` on every
/// other platform and on every subsequent call. Delegates to `launch_open`
/// rather than `AppState`, since the whole point of that queue is to hold
/// data that can arrive before `AppState` does.
#[tauri::command]
pub fn workspace_take_pending_open() -> Vec<String> {
    crate::launch_open::take_pending_open()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::standalone::StandaloneWorkspace;

    // Test 11 — `is_reserved_workspace_id` rejects "standalone" and accepts
    // every other id, including "local".
    #[test]
    fn is_reserved_workspace_id_rejects_only_the_standalone_id() {
        assert!(is_reserved_workspace_id("standalone"));
        assert!(!is_reserved_workspace_id("local"));
        assert!(!is_reserved_workspace_id(""));
        assert!(!is_reserved_workspace_id("Standalone"));
        assert!(!is_reserved_workspace_id("standalone2"));
    }

    // Test 1 (Rust half) / test 2(a) — `register_workspace`, called for
    // "local", does not disturb a separately-keyed "standalone" entry:
    // asserted by identity (`Arc::ptr_eq`), not just presence, so a bug that
    // replaced the standalone `Arc` with an equivalent-looking new instance
    // (silently dropping its watcher/grants) would still fail this.
    #[test]
    fn register_workspace_for_local_does_not_disturb_a_separately_keyed_standalone_entry() {
        let workspaces: Mutex<HashMap<String, Arc<dyn Workspace>>> = Mutex::new(HashMap::new());
        let standalone: Arc<dyn Workspace> = Arc::new(StandaloneWorkspace::new());
        register_workspace(
            &workspaces,
            STANDALONE_WORKSPACE_ID.to_string(),
            Arc::clone(&standalone),
        );

        let dir = tempfile::tempdir().unwrap();
        let local: Arc<dyn Workspace> = Arc::new(LocalWorkspace::new(
            "local".to_string(),
            dir.path().to_path_buf(),
        ));
        register_workspace(&workspaces, "local".to_string(), local);

        let guard = workspaces.lock().unwrap();
        let still_standalone = guard.get(STANDALONE_WORKSPACE_ID).unwrap();
        assert!(Arc::ptr_eq(still_standalone, &standalone));
        assert!(guard.contains_key("local"));
    }

    // Pins §3.2's first cause of issue #406: `"local"` is registered only by
    // `workspace_set_root`, so a fresh registry (no project ever opened) has
    // no entry for it at all -- `fs_resolve_candidates`/
    // `fs_authorize_terminal_link` must tolerate this rather than erroring.
    #[test]
    fn local_is_absent_from_a_fresh_registry_until_workspace_set_root_runs() {
        let workspaces: Mutex<HashMap<String, Arc<dyn Workspace>>> = Mutex::new(HashMap::new());
        assert!(!workspaces.lock().unwrap().contains_key("local"));
    }
}

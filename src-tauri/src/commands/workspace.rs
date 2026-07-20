use crate::error::AppError;
use crate::recents::{self, RecentProject};
use crate::state::AppState;
use crate::workspace::local::LocalWorkspace;
use crate::workspace::Workspace;
use std::path::PathBuf;
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

#[tauri::command]
pub async fn workspace_set_root(
    state: State<'_, AppState>,
    workspace_id: String,
    path: String,
) -> Result<(), AppError> {
    let workspace = LocalWorkspace::new(workspace_id.clone(), PathBuf::from(&path));

    let (tx, mut rx) = mpsc::unbounded_channel();
    workspace.watch(tx);

    let app_handle = state.app_handle.clone();
    tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            let _ = app_handle.emit("fs:changed", event);
        }
    });

    state
        .workspaces
        .lock()
        .unwrap()
        .insert(workspace_id, std::sync::Arc::new(workspace));

    // Every "open a folder" action (in-app button, `File` menu, Dock menu)
    // funnels through this command, so recording the recent-project entry
    // here — rather than in each caller — guarantees the list can never
    // miss an entry or drift from what's actually open.
    recents::record(&state.app_handle, &path)?;
    #[cfg(target_os = "macos")]
    crate::macos_dock::note_recent_document(&path);

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

/// Consumes the path from a Dock-menu pick received before the frontend had
/// mounted its event listeners (the cold-launch case in plan section 4.3).
/// Called once by the frontend on startup; returns `None` on every other
/// platform and on every subsequent call.
#[tauri::command]
pub fn workspace_take_pending_open(state: State<'_, AppState>) -> Option<String> {
    state.pending_open.lock().unwrap().take()
}

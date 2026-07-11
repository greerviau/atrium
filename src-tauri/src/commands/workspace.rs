use crate::error::AppError;
use crate::state::AppState;
use crate::workspace::local::LocalWorkspace;
use crate::workspace::Workspace;
use std::path::PathBuf;
use tauri::{Emitter, State};
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
    Ok(())
}

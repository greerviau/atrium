use crate::error::AppError;
use crate::link_resolve::{self, PathCandidate};
use crate::state::AppState;
use crate::workspace::{DirEntry, Workspace};
use std::sync::Arc;
use tauri::State;

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

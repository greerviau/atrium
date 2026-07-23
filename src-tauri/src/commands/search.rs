use crate::error::AppError;
use crate::state::AppState;
use crate::workspace::{FileSearchResults, SearchOptions, SearchResults, Workspace};
use std::sync::Arc;
use tauri::State;

/// Clones the `Arc<dyn Workspace>` for `workspace_id` out of the state and
/// drops the lock before returning, so callers can `.await` on the workspace
/// without holding a `MutexGuard` across the await point (mirrors the same
/// helper in `commands/fs.rs`).
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
pub async fn search_workspace(
    state: State<'_, AppState>,
    workspace_id: String,
    query: String,
    options: SearchOptions,
) -> Result<SearchResults, AppError> {
    workspace(&state, &workspace_id)?
        .search(&query, options)
        .await
}

#[tauri::command]
pub async fn find_files(
    state: State<'_, AppState>,
    workspace_id: String,
    query: String,
) -> Result<FileSearchResults, AppError> {
    workspace(&state, &workspace_id)?.find_files(&query).await
}

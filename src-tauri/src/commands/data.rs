use crate::data::DataQueryResult;
use crate::error::AppError;
use crate::state::AppState;
use tauri::State;

/// Executes a read-only query against a CSV, TSV, or Parquet file through the
/// workspace that already authorizes the open tab.
#[tauri::command]
pub async fn data_query(
    state: State<'_, AppState>,
    workspace_id: String,
    path: String,
    query: String,
) -> Result<DataQueryResult, AppError> {
    let workspace = state
        .workspaces
        .lock()
        .unwrap()
        .get(&workspace_id)
        .cloned()
        .ok_or_else(|| AppError::UnknownWorkspace(workspace_id.clone()))?;
    workspace.query_data(&path, &query).await
}

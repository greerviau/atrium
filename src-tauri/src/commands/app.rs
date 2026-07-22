use crate::error::AppError;
use crate::state::AppState;

/// Called once the frontend has resolved the unsaved-changes prompt (or
/// found nothing dirty) for a window-close or app-quit request: kills any
/// running PTY sessions and exits the process.
#[tauri::command]
pub fn app_confirm_close(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> Result<(), AppError> {
    state.pty.kill_all();
    app.exit(0);
    Ok(())
}

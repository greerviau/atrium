use crate::error::AppError;
use crate::pty_manager::PtyEvent;
use crate::state::AppState;
use tauri::ipc::Channel;
use tauri::State;

#[tauri::command]
pub fn pty_spawn(
    state: State<'_, AppState>,
    cwd: String,
    cols: u16,
    rows: u16,
) -> Result<String, AppError> {
    state.pty.spawn(cwd, cols, rows)
}

#[tauri::command]
pub fn pty_subscribe(
    state: State<'_, AppState>,
    terminal_id: String,
    channel: Channel<PtyEvent>,
) -> Result<(), AppError> {
    state.pty.subscribe(&terminal_id, channel)
}

#[tauri::command]
pub fn pty_write(
    state: State<'_, AppState>,
    terminal_id: String,
    data: String,
) -> Result<(), AppError> {
    state.pty.write(&terminal_id, &data)
}

#[tauri::command]
pub fn pty_resize(
    state: State<'_, AppState>,
    terminal_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), AppError> {
    state.pty.resize(&terminal_id, cols, rows)
}

#[tauri::command]
pub fn pty_kill(state: State<'_, AppState>, terminal_id: String) -> Result<(), AppError> {
    state.pty.kill(&terminal_id)
}

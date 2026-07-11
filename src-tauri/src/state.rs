use crate::pty_manager::PtyManager;
use crate::workspace::Workspace;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::AppHandle;

/// The app's single piece of shared mutable state: which workspaces are
/// registered (MVP ever populates exactly one, `"local"`) and all live PTY
/// sessions. Rust owns "what's on disk" and "what's running"; the frontend's
/// Svelte stores own "what's open in the UI" and are never synced back here.
///
/// Workspaces are stored behind `Arc`, not `Box`, so a command handler can
/// clone the trait object out and drop the `Mutex` guard before `.await`ing
/// on it — holding a `MutexGuard` across an await point would make the
/// command's future non-`Send`, which `tauri::generate_handler!` rejects.
pub struct AppState {
    pub workspaces: Mutex<HashMap<String, Arc<dyn Workspace>>>,
    pub pty: PtyManager,
    pub app_handle: AppHandle,
}

impl AppState {
    pub fn new(app_handle: AppHandle) -> Self {
        Self {
            workspaces: Mutex::new(HashMap::new()),
            pty: PtyManager::default(),
            app_handle,
        }
    }
}

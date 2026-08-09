use crate::pty_manager::PtyManager;
use crate::workspace::Workspace;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::AppHandle;

/// The app's single piece of shared mutable state: which workspaces are
/// registered (a project's `"local"` workspace, replaced on every switch,
/// alongside the never-torn-down `"standalone"` workspace — see
/// `workspace::standalone` — registered once at startup), all live PTY
/// sessions, and the most recent real, native OS drag-drop event. Rust owns
/// "what's on disk" and "what's running"; the frontend's Svelte stores own
/// "what's open in the UI" and are never synced back here.
///
/// Dock-menu picks, `RunEvent::Opened` paths, and launch arguments awaiting
/// pickup by the frontend live in `launch_open`, not here; that queue exists
/// specifically to hold data that can arrive before this struct does (issue
/// #325's cold-launch plan, §6.1), which managed state can't do.
///
/// Workspaces are stored behind `Arc`, not `Box`, so a command handler can
/// clone the trait object out and drop the `Mutex` guard before `.await`ing
/// on it — holding a `MutexGuard` across an await point would make the
/// command's future non-`Send`, which `tauri::generate_handler!` rejects.
pub struct AppState {
    pub workspaces: Mutex<HashMap<String, Arc<dyn Workspace>>>,
    pub pty: PtyManager,
    pub app_handle: AppHandle,
    /// The path set and timestamp of the most recent real, native OS
    /// drag-drop `Drop` event observed on the main window, written only by
    /// `main.rs`'s `WindowEvent::DragDrop` handler. `fs_grant_external_file`
    /// (`commands/fs.rs`) checks this before ever authorizing a grant — see
    /// the drag-a-file-into-the-editor plan's §4.9 for why a grant must be
    /// gated on a real, backend-observed drop rather than trusting the
    /// frontend's own event alone.
    pub recent_drop: Mutex<Option<(HashSet<String>, Instant)>>,
}

impl AppState {
    pub fn new(app_handle: AppHandle) -> Self {
        Self {
            workspaces: Mutex::new(HashMap::new()),
            pty: PtyManager::new(),
            app_handle,
            recent_drop: Mutex::new(None),
        }
    }
}

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
/// sessions, and Dock-menu picks still awaiting pickup by the frontend.
/// Rust owns "what's on disk" and "what's running"; the frontend's Svelte
/// stores own "what's open in the UI" and are never synced back here.
///
/// Workspaces are stored behind `Arc`, not `Box`, so a command handler can
/// clone the trait object out and drop the `Mutex` guard before `.await`ing
/// on it — holding a `MutexGuard` across an await point would make the
/// command's future non-`Send`, which `tauri::generate_handler!` rejects.
pub struct AppState {
    pub workspaces: Mutex<HashMap<String, Arc<dyn Workspace>>>,
    pub pty: PtyManager,
    pub app_handle: AppHandle,
    /// Paths from macOS Dock-menu picks (or `RunEvent::Opened`) received
    /// before the frontend had mounted its event listeners. Drained once via
    /// `workspace_take_pending_open`; see `macos_dock.rs`. A `Vec`, not a
    /// single slot, so a multi-file "Open With Atrium" doesn't silently lose
    /// every path but the last (Finding 3).
    pub pending_open: Mutex<Vec<String>>,
    /// The path set and timestamp of the most recent real, native OS
    /// drag-drop `Drop` event observed on the main window, written only by
    /// `main.rs`'s `WindowEvent::DragDrop` handler. `fs_grant_external_file`
    /// (`commands/fs.rs`) checks this before ever authorizing a grant — see
    /// the drag-a-file-into-the-editor plan's §4.9 for why a grant must be
    /// gated on a real, backend-observed drop rather than trusting the
    /// frontend's own event alone.
    pub recent_drop: Mutex<Option<(HashSet<String>, Instant)>>,
    /// Mirrors `recent_drop`, but for a path some local process asked the OS
    /// to open with Atrium (`RunEvent::Opened`, written only by
    /// `macos_dock::open_paths`) rather than a physical drag gesture. A
    /// second, structurally-parallel — but not equally strong — trust origin
    /// for `fs_grant_external_file`; see `commands/fs.rs`'s
    /// `recently_opened_externally` doc comment for why the two are not
    /// equal in strength and why that's accepted anyway.
    pub recent_os_open: Mutex<Option<(HashSet<String>, Instant)>>,
}

impl AppState {
    pub fn new(app_handle: AppHandle) -> Self {
        Self {
            workspaces: Mutex::new(HashMap::new()),
            pty: PtyManager::new(),
            app_handle,
            pending_open: Mutex::new(Vec::new()),
            recent_drop: Mutex::new(None),
            recent_os_open: Mutex::new(None),
        }
    }
}

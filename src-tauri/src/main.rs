// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod error;
mod fs_watch;
mod link_resolve;
#[cfg(target_os = "macos")]
mod macos_dock;
mod pty_manager;
mod recents;
mod state;
mod workspace;

use state::AppState;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager};

/// Builds the native menu bar: `Atrium` (About, Settings…, Quit), `File`
/// (Open Folder, Save, Close Tab, New Terminal Tab), `Edit` (standard
/// Undo/Redo/Cut/Copy/Paste/Select All, plus Find in Files), `View` (Toggle
/// File Explorer, Toggle Terminal, Split Terminal, Split Up/Down/Left/Right,
/// Zoom In, Zoom Out, Reset Zoom), `Window` (Minimize, Close Window), and
/// `Help` (Keyboard Shortcuts…, Atrium on GitHub, Report an Issue…). Menu
/// items that need frontend behavior (Settings, Open Folder, Save, Close
/// Tab, New Terminal Tab, Find in Files, both View toggles, Split Terminal,
/// the four Split direction items, all three zoom items, every Help item)
/// emit a `menu:*` event; `App.svelte` / `MenuBar.ts` listen for these and
/// dispatch to the active pane, the search overlay, the settings dialog, the
/// panel-visibility store, the zoom store, the keyboard shortcuts panel, or
/// the external-link opener, since the menu itself has no notion of "the
/// active editor," "is the panel shown," or "the current zoom level." The
/// four Split direction items are new accelerators (⌥⌘↑/↓/←/→) routed by
/// `App.svelte`'s `splitFocusedSurface` to whichever of the terminal dock or
/// the editor's split panes last had focus; `Split Terminal` (⌘\) is left as
/// a pre-existing, terminal-only alias for split-right specifically, kept
/// only so that binding's own muscle memory keeps working. `Close Tab`
/// (⌘W) is routed the same way, via `App.svelte`'s `closeFocusedTab`, to
/// close the active tab on whichever surface last had focus. `Close Window`
/// is a plain `MenuItem` with no accelerator (Cmd+W is claimed by `Close
/// Tab` above): `muda`'s `PredefinedMenuItem::close_window` hardcodes
/// Cmd+W and has no way to override it, so it can't be used here; the
/// `on_menu_event` handler below special-cases `menu:close-window` to keep
/// routing a mouse click on it through the existing whole-app close
/// confirmation. The five file-explorer shortcuts (New File/Folder, Rename,
/// Delete, Reveal in Finder) are deliberately absent from this menu: unlike
/// every accelerator here, which fires regardless of what has focus, those
/// five must act only on the file tree's own DOM-focused row, so they're
/// implemented as plain JS `keydown` handlers in
/// `FileTreeNode.svelte`/`FileTree.svelte` instead.
///
/// The `Help` submenu's title is the literal string `"Help"`: on macOS,
/// AppKit recognizes that exact title and automatically adds a menu-search
/// field at its top, letting a user fuzzy-search every command across the
/// whole menu bar. `Keyboard Shortcuts…`'s accelerator list is manually
/// mirrored in `src/lib/shell/KeyboardShortcutsDialog.svelte`'s static data
/// (the frontend has no access to these Rust strings) — keep both in sync
/// when an accelerator here changes.
fn build_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let settings = MenuItem::with_id(app, "menu:settings", "Settings…", true, Some("CmdOrCtrl+,"))?;
    let app_menu = Submenu::with_items(
        app,
        "Atrium",
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &PredefinedMenuItem::separator(app)?,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    let open_folder = MenuItem::with_id(
        app,
        "menu:open-folder",
        "Open Folder…",
        true,
        Some("CmdOrCtrl+O"),
    )?;
    let save = MenuItem::with_id(app, "menu:save", "Save", true, Some("CmdOrCtrl+S"))?;
    let close_tab = MenuItem::with_id(
        app,
        "menu:close-tab",
        "Close Tab",
        true,
        Some("CmdOrCtrl+W"),
    )?;
    let new_terminal_tab = MenuItem::with_id(
        app,
        "menu:new-terminal-tab",
        "New Terminal Tab",
        true,
        Some("CmdOrCtrl+T"),
    )?;
    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &open_folder,
            &save,
            &PredefinedMenuItem::separator(app)?,
            &close_tab,
            &PredefinedMenuItem::separator(app)?,
            &new_terminal_tab,
        ],
    )?;

    let find_in_files = MenuItem::with_id(
        app,
        "menu:find-in-files",
        "Find in Files…",
        true,
        Some("CmdOrCtrl+Shift+F"),
    )?;
    let go_to_file = MenuItem::with_id(
        app,
        "menu:go-to-file",
        "Go to File…",
        true,
        Some("CmdOrCtrl+P"),
    )?;
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &find_in_files,
            &go_to_file,
        ],
    )?;

    let toggle_explorer = MenuItem::with_id(
        app,
        "menu:toggle-explorer",
        "Toggle File Explorer",
        true,
        Some("CmdOrCtrl+B"),
    )?;
    let toggle_terminal = MenuItem::with_id(
        app,
        "menu:toggle-terminal",
        "Toggle Terminal",
        true,
        Some("CmdOrCtrl+R"),
    )?;
    let split_terminal = MenuItem::with_id(
        app,
        "menu:split-terminal",
        "Split Terminal",
        true,
        Some("CmdOrCtrl+\\"),
    )?;
    let split_up = MenuItem::with_id(
        app,
        "menu:split-up",
        "Split Up",
        true,
        Some("CmdOrCtrl+Alt+Up"),
    )?;
    let split_down = MenuItem::with_id(
        app,
        "menu:split-down",
        "Split Down",
        true,
        Some("CmdOrCtrl+Alt+Down"),
    )?;
    let split_left = MenuItem::with_id(
        app,
        "menu:split-left",
        "Split Left",
        true,
        Some("CmdOrCtrl+Alt+Left"),
    )?;
    let split_right = MenuItem::with_id(
        app,
        "menu:split-right",
        "Split Right",
        true,
        Some("CmdOrCtrl+Alt+Right"),
    )?;
    let zoom_in = MenuItem::with_id(app, "menu:zoom-in", "Zoom In", true, Some("CmdOrCtrl+="))?;
    let zoom_out = MenuItem::with_id(app, "menu:zoom-out", "Zoom Out", true, Some("CmdOrCtrl+-"))?;
    let zoom_reset = MenuItem::with_id(
        app,
        "menu:zoom-reset",
        "Reset Zoom",
        true,
        Some("CmdOrCtrl+0"),
    )?;
    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &toggle_explorer,
            &toggle_terminal,
            &split_terminal,
            &split_up,
            &split_down,
            &split_left,
            &split_right,
            &PredefinedMenuItem::separator(app)?,
            &zoom_in,
            &zoom_out,
            &zoom_reset,
        ],
    )?;

    let close_window =
        MenuItem::with_id(app, "menu:close-window", "Close Window", true, None::<&str>)?;
    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[&PredefinedMenuItem::minimize(app, None)?, &close_window],
    )?;

    let shortcuts = MenuItem::with_id(
        app,
        "menu:help:shortcuts",
        "Keyboard Shortcuts…",
        true,
        None::<&str>,
    )?;
    let github = MenuItem::with_id(
        app,
        "menu:help:github",
        "Atrium on GitHub",
        true,
        None::<&str>,
    )?;
    let report_issue = MenuItem::with_id(
        app,
        "menu:help:report-issue",
        "Report an Issue…",
        true,
        None::<&str>,
    )?;
    let help_menu = Submenu::with_items(
        app,
        "Help",
        true,
        &[
            &shortcuts,
            &PredefinedMenuItem::separator(app)?,
            &github,
            &report_issue,
        ],
    )?;

    Menu::with_items(
        app,
        &[
            &app_menu,
            &file_menu,
            &edit_menu,
            &view_menu,
            &window_menu,
            &help_menu,
        ],
    )
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(AppState::new(handle.clone()));

            let menu = build_menu(&handle)?;
            app.set_menu(menu)?;

            let menu_handle = handle.clone();
            app.on_menu_event(move |_app, event| {
                if event.id().as_ref() == "menu:close-window" {
                    let _ = menu_handle.emit("app:close-requested", ());
                } else {
                    let _ = menu_handle.emit(event.id().as_ref(), ());
                }
            });

            // Rust has no visibility into which tabs are dirty (that state
            // lives only in the frontend's Svelte store), so a close
            // request is always intercepted here and handed to the
            // frontend to decide; `app_confirm_close` (called once the
            // frontend has resolved any unsaved-changes prompt) is what
            // actually kills PTYs and exits.
            let close_handle = handle.clone();
            if let Some(window) = app.get_webview_window("main") {
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = close_handle.emit("app:close-requested", ());
                    }
                });
            }

            #[cfg(target_os = "macos")]
            macos_dock::install(&handle);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app::app_confirm_close,
            commands::workspace::workspace_open_folder_dialog,
            commands::workspace::workspace_set_root,
            commands::workspace::workspace_get_recents,
            commands::workspace::workspace_remove_recent,
            commands::workspace::workspace_take_pending_open,
            commands::fs::fs_list_dir,
            commands::fs::fs_read_file,
            commands::fs::fs_write_file,
            commands::fs::fs_create_file,
            commands::fs::fs_create_dir,
            commands::fs::fs_rename,
            commands::fs::fs_delete,
            commands::fs::fs_import_external_paths,
            commands::fs::fs_resolve_candidates,
            commands::search::search_workspace,
            commands::search::find_files,
            commands::pty::pty_spawn,
            commands::pty::pty_subscribe,
            commands::pty::pty_write,
            commands::pty::pty_resize,
            commands::pty::pty_kill,
            commands::shell::shell_open_external,
            commands::shell::open_external_link,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        // `RunEvent::Opened` fires both when a Dock-menu pick reaches an
        // already-running app and (per plan section 4.3) during a cold
        // launch, before the frontend's event listeners exist yet;
        // `macos_dock::open_path` handles both by stashing the path for
        // `workspace_take_pending_open` and emitting it live.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { ref urls } = event {
            for url in urls {
                if let Ok(path) = url.to_file_path() {
                    macos_dock::open_path(path.to_string_lossy().into_owned());
                }
            }
        }

        // Mirrors the window-event handler above for the Quit-menu/Cmd+Q
        // path, which bypasses `WindowEvent::CloseRequested` entirely. Only
        // a `None` code (a user/OS-initiated exit request) is intercepted;
        // `code` is `Some(_)` when `app_confirm_close`'s own `app.exit(0)`
        // triggers this same event after the frontend has already resolved
        // the unsaved-changes prompt, and that exit must be allowed through
        // rather than looped back into another confirmation.
        if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
            if code.is_none() {
                api.prevent_exit();
                let _ = app_handle.emit("app:close-requested", ());
            }
        }
    });
}

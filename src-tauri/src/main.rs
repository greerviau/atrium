// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod error;
mod fs_watch;
mod link_resolve;
mod pty_manager;
mod state;
mod workspace;

use state::AppState;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager};

/// Builds the native menu bar described in plan section 7: `App` (About,
/// Quit), `File` (Open Folder, Save, New Terminal Tab), `Edit` (standard
/// Undo/Redo/Cut/Copy/Paste/Find), `Window` (standard). Menu items that need
/// frontend behavior (Open Folder, Save, New Terminal Tab) emit a `menu:*`
/// event; `App.svelte` / `MenuBar.ts` listen for these and dispatch to the
/// active pane, since the menu itself has no notion of "the active editor".
fn build_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let app_menu = Submenu::with_items(
        app,
        "Atrium",
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    let open_folder = MenuItem::with_id(app, "menu:open-folder", "Open Folder…", true, Some("CmdOrCtrl+O"))?;
    let save = MenuItem::with_id(app, "menu:save", "Save", true, Some("CmdOrCtrl+S"))?;
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
        &[&open_folder, &save, &PredefinedMenuItem::separator(app)?, &new_terminal_tab],
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
        ],
    )?;

    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    Menu::with_items(app, &[&app_menu, &file_menu, &edit_menu, &window_menu])
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(AppState::new(handle.clone()));

            let menu = build_menu(&handle)?;
            app.set_menu(menu)?;

            let menu_handle = handle.clone();
            app.on_menu_event(move |_app, event| {
                let _ = menu_handle.emit(event.id().as_ref(), ());
            });

            let close_handle = handle.clone();
            if let Some(window) = app.get_webview_window("main") {
                window.on_window_event(move |event| {
                    if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                        if let Some(state) = close_handle.try_state::<AppState>() {
                            state.pty.kill_all();
                        }
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::workspace::workspace_open_folder_dialog,
            commands::workspace::workspace_set_root,
            commands::fs::fs_list_dir,
            commands::fs::fs_read_file,
            commands::fs::fs_write_file,
            commands::fs::fs_create_file,
            commands::fs::fs_create_dir,
            commands::fs::fs_rename,
            commands::fs::fs_delete,
            commands::fs::fs_resolve_candidates,
            commands::pty::pty_spawn,
            commands::pty::pty_subscribe,
            commands::pty::pty_write,
            commands::pty::pty_resize,
            commands::pty::pty_kill,
            commands::shell::shell_open_external,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

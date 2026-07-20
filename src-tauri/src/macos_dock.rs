//! macOS-only Dock icon integration (plan section 4.3): a right-click on
//! the Dock icon shows the same recent-projects list as the welcome screen,
//! and picking one opens it in the existing window.
//!
//! Tauri (via `tao`) already installs its own `NSApplicationDelegate` to
//! receive `application:openURLs:` (surfaced to Rust as `RunEvent::Opened`
//! in `main.rs`) and other lifecycle callbacks. Replacing that delegate
//! wholesale would break `RunEvent::Opened` and window-lifecycle handling,
//! so instead of installing a delegate of our own, this module reaches into
//! the *existing* delegate's Objective-C class at runtime and adds
//! `applicationDockMenu:` as a new method on it (the same
//! `class_addMethod` mechanism Objective-C categories use), leaving every
//! other method tao already installed untouched.

use crate::recents;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Sel};
use objc2::{define_class, msg_send, sel, DefinedClass, MainThreadOnly};
use objc2_app_kit::{NSApplication, NSDocumentController, NSMenu, NSMenuItem};
use objc2_foundation::{MainThreadMarker, NSString, NSURL};
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter, Manager, Wry};

/// Emitted on the webview whenever a Dock menu pick (or `RunEvent::Opened`)
/// resolves to a path the frontend should open; see `onDockOpenPath` in
/// `src/lib/ipc/events.ts`.
pub const OPEN_PATH_EVENT: &str = "dock:open-path";

static APP_HANDLE: OnceLock<AppHandle<Wry>> = OnceLock::new();

/// Installs the Dock menu override. Call once from `main.rs`'s `.setup()`,
/// after tao has created its delegate (i.e. after the `App` is built).
pub fn install(app: &AppHandle<Wry>) {
    let _ = APP_HANDLE.set(app.clone());

    let mtm = MainThreadMarker::new().expect("Dock menu setup must run on the main thread");
    let ns_app = NSApplication::sharedApplication(mtm);
    let Some(delegate) = ns_app.delegate() else {
        return;
    };

    // SAFETY: `class_addMethod` is safe to call on an already-registered
    // class; it is the runtime mechanism categories use to add a method
    // after the fact. The type encoding "@@:@" is the standard signature
    // for an Objective-C method returning an object and taking one object
    // argument (self, _cmd, and the `sender` parameter are the implicit
    // "@:@" trio; the leading "@" is the return type).
    unsafe {
        let class: &AnyClass = msg_send![&*delegate, class];
        let imp = std::mem::transmute::<
            unsafe extern "C-unwind" fn(&AnyObject, Sel, &NSApplication) -> *mut NSMenu,
            objc2::runtime::Imp,
        >(application_dock_menu);
        let added = objc2::ffi::class_addMethod(
            class as *const AnyClass as *mut AnyClass,
            sel!(applicationDockMenu:),
            imp,
            c"@@:@".as_ptr(),
        );
        if !added.as_bool() {
            eprintln!("atrium: failed to install applicationDockMenu: on the app delegate");
        }
    }
}

unsafe extern "C-unwind" fn application_dock_menu(
    _this: &AnyObject,
    _sel: Sel,
    _sender: &NSApplication,
) -> *mut NSMenu {
    let mtm = MainThreadMarker::new().expect("applicationDockMenu: is called on the main thread");
    let menu = NSMenu::new(mtm);
    menu.setAutoenablesItems(false);

    let recents = APP_HANDLE
        .get()
        .and_then(|app| recents::get_recents(app).ok())
        .unwrap_or_default();

    for project in recents {
        let title = NSString::from_str(&project.name);
        let item = DockMenuItem::new(mtm, project.path, &title);
        unsafe { item.setTarget(Some(&item)) };
        menu.addItem(&item);
    }

    Retained::autorelease_return(menu)
}

define_class!(
    #[unsafe(super(NSMenuItem))]
    #[name = "AtriumDockMenuItem"]
    #[thread_kind = MainThreadOnly]
    #[ivars = String]
    struct DockMenuItem;

    impl DockMenuItem {
        #[unsafe(method(openRecentProject:))]
        fn open_recent_project(&self, _sender: Option<&AnyObject>) {
            // Our own Dock menu is only ever shown for an already-running
            // app, so there is no cold-launch case to stash for here —
            // emit live, unlike `open_path` below.
            emit_open_path(self.ivars().clone());
        }
    }
);

impl DockMenuItem {
    fn new(mtm: MainThreadMarker, path: String, title: &NSString) -> Retained<Self> {
        let this = mtm.alloc::<Self>().set_ivars(path);
        let empty = NSString::new();
        unsafe {
            msg_send![
                super(this),
                initWithTitle: title,
                action: Some(sel!(openRecentProject:)),
                keyEquivalent: &*empty
            ]
        }
    }
}

/// Emits `OPEN_PATH_EVENT` for the frontend's live listener.
fn emit_open_path(path: String) {
    if let Some(app) = APP_HANDLE.get() {
        let _ = app.emit(OPEN_PATH_EVENT, path);
    }
}

/// Routes a path from `RunEvent::Opened` (`main.rs`) back to the frontend:
/// stashes it (for the cold-launch case, consumed via
/// `workspace_take_pending_open`) and emits it live (for the case where
/// that event reaches an already-running app, e.g. a pick from the
/// system-level "Open Recent" list rather than our own Dock menu).
pub fn open_path(path: String) {
    if let Some(app) = APP_HANDLE.get() {
        if let Some(state) = app.try_state::<crate::state::AppState>() {
            *state.pending_open.lock().unwrap() = Some(path.clone());
        }
    }
    emit_open_path(path);
}

/// Registers `path` with `NSDocumentController` so it shows up in the
/// system-level Apple-menu / Finder "Open Recent" — and, critically, so
/// macOS relaunches (or signals) the app when the same entry is picked from
/// the Dock menu while the app isn't running.
pub fn note_recent_document(path: &str) {
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let controller = NSDocumentController::sharedDocumentController(mtm);
    let url = NSURL::fileURLWithPath_isDirectory(&NSString::from_str(path), true);
    controller.noteNewRecentDocumentURL(&url);
}

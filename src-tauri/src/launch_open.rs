//! Process-lifetime storage and delivery for paths the OS asks Atrium to
//! open. macOS supplies paths through `RunEvent::Opened`; Linux and Windows
//! file associations supply them as launch arguments. Both origins converge
//! here before the frontend drains the queue.
//!
//! This is separate from `AppState` because a launch path can arrive before
//! Tauri runs `.setup()`. The statics exist from the first instruction of
//! `main`, so a path can be recorded at any point in the process's life.

use std::collections::HashSet;
use std::ffi::OsString;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow, Wry};

/// Emitted whenever an OS-open request arrives after the frontend has
/// drained the startup queue and installed its live listener.
pub const OPEN_PATH_EVENT: &str = "dock:open-path";

/// How long a recorded path stays authorized for `fs_grant_external_file`
/// (`commands/fs.rs`) — mirrors `RECENT_DROP_WINDOW` there for the drag-drop
/// origin; see that constant's doc comment for why 10 seconds, and §6.2 of
/// the issue #325 cold-launch plan for why this origin doesn't get a wider
/// window of its own.
const RECENT_OS_OPEN_WINDOW: Duration = Duration::from_secs(10);

struct LaunchOpenState {
    /// Paths observed before the frontend declared itself ready.
    pending: Vec<String>,
    /// Flipped `true`, permanently, by the frontend's one drain call
    /// (`take_pending_open`). Before the flip, `record` queues; after it,
    /// `record` reports "deliver live" instead — delivery is exactly-once
    /// with no gap, because the frontend only drains after its live
    /// listener is already registered (see `App.svelte`'s `onMount`).
    frontend_ready: bool,
    /// Provenance for `fs_grant_external_file` — same role the old
    /// `AppState.recent_os_open` played.
    recent: Option<(HashSet<String>, Instant)>,
}

impl LaunchOpenState {
    const fn new() -> Self {
        Self {
            pending: Vec::new(),
            frontend_ready: false,
            recent: None,
        }
    }
}

static STATE: Mutex<LaunchOpenState> = Mutex::new(LaunchOpenState::new());

/// Extracts existing file or directory paths from a process argument list.
/// The first argument is the executable. Relative paths are resolved against
/// the originating process's current directory, which the single-instance
/// plugin forwards alongside a second launch's arguments.
pub fn paths_from_args(args: impl IntoIterator<Item = OsString>, cwd: &Path) -> Vec<String> {
    args.into_iter()
        .skip(1)
        .filter_map(|arg| {
            let path = Path::new(&arg);
            let resolved = if path.is_absolute() {
                path.to_path_buf()
            } else {
                cwd.join(path)
            };
            resolved
                .exists()
                .then(|| resolved.to_string_lossy().into_owned())
        })
        .collect()
}

/// Routes paths received by an already-running instance into the same queue
/// and provenance record used during cold launch, then surfaces the window.
/// Once the frontend is ready, each path is emitted live.
///
/// Both platform entry points converge here: the
/// `tauri_plugin_single_instance` callback on Linux and Windows, and
/// `RunEvent::Opened` on macOS (both in `main.rs`). Surfacing the window is
/// unconditional and deliberately outside the emit branch — a second launch
/// carrying no paths at all still has to bring the running window forward,
/// and a path that arrives before the frontend is ready is queued rather
/// than emitted but still has to surface the window.
pub fn open_paths(app: &AppHandle<Wry>, paths: Vec<String>) {
    if !paths.is_empty() && record_os_open(&paths) {
        for path in paths {
            let _ = app.emit(OPEN_PATH_EVENT, path);
        }
    }

    surface_main_window(app);
}

/// Brings the existing main window to the user's attention after the OS hands
/// Atrium something to open — without this, a minimized Atrium opens the file
/// silently in the background and the user has no indication anything
/// happened (issue #461).
///
/// The `if let` is defensive, not a real branch: Tauri creates every
/// configured window before it runs the app's own `.setup()` closure, which
/// itself completes inside `build()` — so by the time any caller here can
/// run, `"main"` exists. It is not the cold-launch path; a cold launch
/// reaches this with a freshly created window and simply re-asserts a state
/// that already holds.
///
/// Deliberately `pub(crate)` and deliberately narrow: this is the OS-open
/// surfacing step, not a general-purpose "bring Atrium forward" utility.
pub(crate) fn surface_main_window(app: &AppHandle<Wry>) {
    if let Some(window) = app.get_webview_window("main") {
        surface(&window);
    }
}

/// The order here is load-bearing. `tao`'s `Window::set_focus` is guarded on
/// every platform — macOS checks `isMiniaturized`/`isVisible`, Windows checks
/// its `MINIMIZED`/`VISIBLE` flags, Linux checks its own `minimized` flag and
/// `get_visible()` — and does nothing at all, silently, when the window is
/// still minimized or not visible. `unminimize` clears the first condition and
/// `show` the second; reordering these, or dropping `unminimize` as apparently
/// redundant with `show`, turns `set_focus` back into a no-op. The test in
/// this module's `tests` asserts the order for that reason.
///
/// An app hidden with Cmd+H is *not* covered: hiding is application state
/// (`NSApplication.hide:`), so `makeKeyAndOrderFront:` cannot undo it and all
/// three calls no-op. Restoring from hidden needs `unhide:`, which this
/// deliberately does not do.
fn surface(window: &impl MainWindow) {
    window.unminimize();
    window.show();
    window.set_focus();
}

/// The three window operations `surface` drives, behind a trait purely so
/// that order can be asserted: a real `WebviewWindow` cannot be constructed
/// without a running Tauri app and a live event loop, so there is no way to
/// unit-test `surface` against the real type.
trait MainWindow {
    fn unminimize(&self);
    fn show(&self);
    fn set_focus(&self);
}

impl MainWindow for WebviewWindow<Wry> {
    // Fully qualified on purpose: these three trait methods share their names
    // with `WebviewWindow`'s own inherent methods. `self.unminimize()` here
    // would resolve to the inherent one (inherent methods win over trait
    // methods) and so would happen to work, but a reader cannot tell that
    // from the call site.
    fn unminimize(&self) {
        let _ = WebviewWindow::unminimize(self);
    }

    fn show(&self) {
        let _ = WebviewWindow::show(self);
    }

    fn set_focus(&self) {
        let _ = WebviewWindow::set_focus(self);
    }
}

/// The single writer of `state.recent` — both `record` and `take` route
/// through this, so the canonical-key fold can never be applied to one
/// writer and not the other. This is not ceremony: `record` is the *only*
/// writer on the warm path (single-instance handoff, macOS dock), where
/// `frontend_ready` is already `true` and `take` is never called at all —
/// see the Windows path-canonicalization plan's own account of shipping
/// this exact gap the first time (`take` alone was fixed, `record` was
/// not) for why this is a single private helper rather than two folds
/// written apart from each other. A test asserting `stamp_recent` is the
/// only assignment to `state.recent` is not expressible in Rust, so the
/// guard here is structural (a private field written by one private
/// helper) rather than asserted.
fn stamp_recent(state: &mut LaunchOpenState, paths: &[String]) {
    state.recent = Some((
        paths
            .iter()
            .map(|p| crate::path_key::canonical_key(p))
            .collect(),
        Instant::now(),
    ));
}

/// Always stamps `recent` fresh for `paths`. If the frontend is already
/// ready, returns `true` (the caller should emit each path live — it will
/// never be drained) and leaves `pending` untouched; otherwise queues
/// `paths` onto `pending` and returns `false`.
fn record(state: &mut LaunchOpenState, paths: &[String]) -> bool {
    stamp_recent(state, paths);
    if state.frontend_ready {
        true
    } else {
        state.pending.extend_from_slice(paths);
        false
    }
}

/// Marks the frontend ready (permanently, for the rest of the process) and
/// drains `pending`. Re-stamps `recent` for exactly the paths returned, with
/// a fresh `Instant` — closing the latent race where a cold launch's own
/// startup latency (webview creation, bundle load, Svelte mount) could
/// otherwise burn through most of `RECENT_OS_OPEN_WINDOW` before the
/// frontend ever gets to call `fs_grant_external_file` for a path Rust
/// observed very early in the process's life (issue #325 cold-launch plan
/// §5.4/§6.2 — the window now starts at drain time, not observation time).
fn take(state: &mut LaunchOpenState) -> Vec<String> {
    state.frontend_ready = true;
    let taken = std::mem::take(&mut state.pending);
    stamp_recent(state, &taken);
    taken
}

/// The pure check behind `recently_os_opened`, mirroring `commands/fs.rs`'s
/// own `recently_dropped` convention: `window` is threaded through so a test
/// can assert expiry without a real sleep, by constructing an already-stale
/// `recent` directly.
fn recently_opened(state: &LaunchOpenState, path: &str, window: Duration) -> bool {
    let key = crate::path_key::canonical_key(path);
    matches!(
        &state.recent,
        Some((paths, at)) if paths.contains(&key) && at.elapsed() < window
    )
}

/// Records `paths` as observed from the OS through `RunEvent::Opened` or a
/// launch argument. Returns `true` if the frontend has
/// already declared itself ready — the caller should emit each path live —
/// or `false` if they were queued for the frontend's own startup drain.
///
/// Called with no `AppHandle` and no managed `AppState` in existence at all
/// on a cold launch — the fix for issue #325, and exactly the precondition
/// its regression test (below) exercises.
pub fn record_os_open(paths: &[String]) -> bool {
    record(&mut STATE.lock().unwrap(), paths)
}

/// Drains every path queued before the frontend was ready, marking it ready
/// from this point on. See `take`'s doc comment for the re-stamp this does
/// along the way. Called once by the frontend on startup, after registering
/// its live listener; returns an empty `Vec` on every later call.
pub fn take_pending_open() -> Vec<String> {
    take(&mut STATE.lock().unwrap())
}

/// The OS-open half of `commands::fs::recently_opened_externally` — `true`
/// if `path` was part of the most recently recorded OS-open batch, within
/// `RECENT_OS_OPEN_WINDOW`.
pub fn recently_os_opened(path: &str) -> bool {
    recently_opened(&STATE.lock().unwrap(), path, RECENT_OS_OPEN_WINDOW)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct FakeWindow {
        calls: std::cell::RefCell<Vec<&'static str>>,
    }

    impl MainWindow for FakeWindow {
        fn unminimize(&self) {
            self.calls.borrow_mut().push("unminimize");
        }

        fn show(&self) {
            self.calls.borrow_mut().push("show");
        }

        fn set_focus(&self) {
            self.calls.borrow_mut().push("set_focus");
        }
    }

    // `tao`'s `Window::set_focus` is a silent no-op on every platform while
    // the window is still minimized or not visible (see `surface`), so the
    // window must be unminimized and shown *before* focus is taken. This
    // asserts that order, which is otherwise only a comment.
    #[test]
    fn surface_unminimizes_and_shows_before_taking_focus() {
        let window = FakeWindow::default();

        surface(&window);

        assert_eq!(
            window.calls.into_inner(),
            vec!["unminimize", "show", "set_focus"]
        );
    }

    #[test]
    fn launch_argument_is_resolved_and_queued_before_the_frontend_is_ready() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("launch.md");
        std::fs::write(&file, "# launched").unwrap();
        let args = ["atrium", "launch.md"].map(std::ffi::OsString::from);

        let paths = paths_from_args(args, dir.path());
        let mut state = LaunchOpenState::new();
        assert!(!record(&mut state, &paths));
        assert_eq!(take(&mut state), vec![file.to_string_lossy().into_owned()]);
    }

    #[test]
    fn launch_arguments_ignore_the_executable_and_non_paths() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("notes.md");
        std::fs::write(&file, "# notes").unwrap();
        let args = [
            std::ffi::OsString::from("/opt/Atrium/atrium"),
            std::ffi::OsString::from("--some-runtime-flag"),
            file.clone().into_os_string(),
        ];

        assert_eq!(
            paths_from_args(args, dir.path()),
            vec![file.to_string_lossy().into_owned()]
        );
    }

    // Test 1 (§9.2) — the regression test for issue #325 itself: a path
    // recorded with no `AppHandle`/`AppState` in existence at all (nothing
    // these functions ever touch) still comes back from the drain. Before
    // this fix, the equivalent Rust-side call (macOS's dock-open handler,
    // reaching into managed `AppState`) was a silent no-op in exactly this
    // situation.
    #[test]
    fn record_before_ready_stashes_and_take_returns_it() {
        let mut state = LaunchOpenState::new();
        let delivered_live = record(&mut state, &["/tmp/a.md".to_string()]);
        assert!(!delivered_live);
        assert_eq!(take(&mut state), vec!["/tmp/a.md".to_string()]);
    }

    // Test 2 — before the frontend is ready, record queues and reports "not
    // live"; once `take` has flipped ready, record reports "live" and
    // leaves `pending` untouched.
    #[test]
    fn record_reports_live_and_stops_queueing_once_ready() {
        let mut state = LaunchOpenState::new();
        assert!(!record(&mut state, &["/tmp/a.md".to_string()]));
        let _ = take(&mut state);

        let delivered_live = record(&mut state, &["/tmp/b.md".to_string()]);
        assert!(delivered_live);
        assert!(state.pending.is_empty());
    }

    // Test 3 — accumulate, not overwrite, across multiple pre-ready calls,
    // preserving arrival order (PR #361's `extend_pending` property, ported).
    #[test]
    fn record_accumulates_across_multiple_pre_ready_calls_in_arrival_order() {
        let mut state = LaunchOpenState::new();
        record(&mut state, &["/tmp/a.md".to_string()]);
        record(
            &mut state,
            &["/tmp/b.md".to_string(), "/tmp/c.md".to_string()],
        );
        assert_eq!(
            take(&mut state),
            vec![
                "/tmp/a.md".to_string(),
                "/tmp/b.md".to_string(),
                "/tmp/c.md".to_string(),
            ]
        );
    }

    // Test 4 — order preserved within a single multi-path batch, and an
    // empty slice is a no-op.
    #[test]
    fn record_preserves_order_within_a_single_batch() {
        let mut state = LaunchOpenState::new();
        record(
            &mut state,
            &["/tmp/x.md".to_string(), "/tmp/y.md".to_string()],
        );
        assert_eq!(
            take(&mut state),
            vec!["/tmp/x.md".to_string(), "/tmp/y.md".to_string()]
        );
    }

    #[test]
    fn record_with_an_empty_slice_leaves_pending_untouched() {
        let mut state = LaunchOpenState::new();
        record(&mut state, &["/tmp/already-there.md".to_string()]);
        record(&mut state, &[]);
        assert_eq!(state.pending, vec!["/tmp/already-there.md".to_string()]);
    }

    // Test 5 — `take` is idempotent: a second call returns empty and leaves
    // `frontend_ready` set.
    #[test]
    fn take_twice_returns_empty_the_second_time_and_stays_ready() {
        let mut state = LaunchOpenState::new();
        record(&mut state, &["/tmp/a.md".to_string()]);
        assert_eq!(take(&mut state), vec!["/tmp/a.md".to_string()]);
        assert_eq!(take(&mut state), Vec::<String>::new());
        assert!(state.frontend_ready);
    }

    // Test 6 — `recently_opened` is true for a just-recorded path, false for
    // an unrecorded one, and false once the window has elapsed (a directly
    // constructed stale `recent`, per this test's own doc comment in §9.2 —
    // no real sleep needed).
    #[test]
    fn recently_opened_is_true_for_a_just_recorded_path() {
        let mut state = LaunchOpenState::new();
        record(&mut state, &["/tmp/a.md".to_string()]);
        assert!(recently_opened(&state, "/tmp/a.md", RECENT_OS_OPEN_WINDOW));
    }

    #[test]
    fn recently_opened_is_false_for_an_unrecorded_path() {
        let mut state = LaunchOpenState::new();
        record(&mut state, &["/tmp/a.md".to_string()]);
        assert!(!recently_opened(
            &state,
            "/tmp/other.md",
            RECENT_OS_OPEN_WINDOW
        ));
    }

    #[test]
    fn recently_opened_is_false_once_the_window_has_elapsed() {
        let stale_at = Instant::now() - (RECENT_OS_OPEN_WINDOW + Duration::from_secs(1));
        let state = LaunchOpenState {
            pending: Vec::new(),
            frontend_ready: false,
            recent: Some((HashSet::from(["/tmp/a.md".to_string()]), stale_at)),
        };
        assert!(!recently_opened(&state, "/tmp/a.md", RECENT_OS_OPEN_WINDOW));
    }

    // Test 7 — `take` re-stamps the grant window to start at drain time, not
    // at the original OS-event time. Simulates a cold launch's own startup
    // latency by back-dating the record to the very edge of the window, then
    // sleeping past where the *original* stamp would have expired — the
    // assertion only passes because `take` reset the clock.
    #[test]
    fn take_re_stamps_so_the_grant_window_starts_at_drain_not_at_record() {
        let mut state = LaunchOpenState::new();
        record(&mut state, &["/tmp/a.md".to_string()]);
        state.recent = Some((
            HashSet::from(["/tmp/a.md".to_string()]),
            Instant::now() - (RECENT_OS_OPEN_WINDOW - Duration::from_millis(10)),
        ));
        assert!(recently_opened(&state, "/tmp/a.md", RECENT_OS_OPEN_WINDOW));

        std::thread::sleep(Duration::from_millis(20));
        // Past this point the *original* stamp (window - 10ms, then +20ms
        // sleep) has exceeded the window; only the re-stamp keeps this true.
        assert_eq!(take(&mut state), vec!["/tmp/a.md".to_string()]);
        assert!(recently_opened(&state, "/tmp/a.md", RECENT_OS_OPEN_WINDOW));
    }

    // R2 (Windows path-canonicalization plan) — the cold-launch path:
    // `record` queues (frontend not yet ready), `take` drains and re-stamps,
    // and a lookup under a *different* spelling of the same file — exactly
    // what the frontend sends once it canonicalizes at its own IPC boundary
    // — still matches.
    #[test]
    fn cold_path_recently_opened_matches_a_different_spelling_after_record_then_take() {
        let mut state = LaunchOpenState::new();
        let delivered_live = record(&mut state, &[r"C:\ws\a.txt".to_string()]);
        assert!(!delivered_live);
        assert_eq!(take(&mut state), vec![r"C:\ws\a.txt".to_string()]);
        assert!(recently_opened(
            &state,
            "C:/ws/a.txt",
            RECENT_OS_OPEN_WINDOW
        ));
        assert!(!recently_opened(
            &state,
            "C:/ws/other.txt",
            RECENT_OS_OPEN_WINDOW
        ));
    }

    // R2, warm path — the single-instance handoff and macOS Dock both call
    // `record` with `frontend_ready` already `true` and never call `take`
    // at all, so `record`'s own stamp is the *only* one that path ever
    // gets. This is the exact shape that stayed broken through the first
    // revision of the Windows path-canonicalization plan: a fix applied
    // only to `take` still passes every test that calls `take`, and this
    // one deliberately never does.
    #[test]
    fn warm_path_recently_opened_matches_a_different_spelling_after_record_alone_with_no_take() {
        let mut state = LaunchOpenState::new();
        // Flip ready the same way `take` would, without ever calling `take`
        // itself — mirroring the warm path's `frontend_ready == true`
        // precondition exactly.
        state.frontend_ready = true;

        let delivered_live = record(&mut state, &[r"C:\ws\a.txt".to_string()]);
        assert!(delivered_live);
        assert!(state.pending.is_empty());

        assert!(recently_opened(
            &state,
            "C:/ws/a.txt",
            RECENT_OS_OPEN_WINDOW
        ));
        assert!(!recently_opened(
            &state,
            "C:/ws/other.txt",
            RECENT_OS_OPEN_WINDOW
        ));
    }
}

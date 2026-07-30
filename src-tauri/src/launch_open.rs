//! Process-lifetime storage for paths the OS asks Atrium to open
//! (`RunEvent::Opened`, `main.rs`), split out of `AppState` because the
//! whole reason this queue exists is to hold data that can arrive before
//! `AppState` does. On macOS, Finder's launch open-document event reaches
//! the app's `run` callback *before* Tauri's `.setup()` closure has
//! executed — but the managed `AppState` and the `macos_dock::APP_HANDLE`
//! static are both created inside that same closure. A path recorded
//! against either of those is therefore silently discarded on a cold
//! launch, which is the whole bug (issue #325's cold-launch plan, §5). The
//! statics below exist from the first instruction of `main`, so a path can
//! be recorded at any point in the process's life regardless of when (or
//! whether) `.setup()` has run.
//!
//! Deliberately platform-neutral, not `cfg`-gated: only `macos_dock.rs`
//! (macOS-only) writes into this today, but the Linux/Windows argv-launch
//! gap (issue #362, out of scope for this change) would read paths on
//! every platform, and this is its obvious home if it's ever implemented.

use std::collections::HashSet;
use std::sync::Mutex;
use std::time::{Duration, Instant};

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

/// Always stamps `recent` fresh for `paths`. If the frontend is already
/// ready, returns `true` (the caller should emit each path live — it will
/// never be drained) and leaves `pending` untouched; otherwise queues
/// `paths` onto `pending` and returns `false`.
fn record(state: &mut LaunchOpenState, paths: &[String]) -> bool {
    state.recent = Some((paths.iter().cloned().collect(), Instant::now()));
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
    state.recent = Some((taken.iter().cloned().collect(), Instant::now()));
    taken
}

/// The pure check behind `recently_os_opened`, mirroring `commands/fs.rs`'s
/// own `recently_dropped` convention: `window` is threaded through so a test
/// can assert expiry without a real sleep, by constructing an already-stale
/// `recent` directly.
fn recently_opened(state: &LaunchOpenState, path: &str, window: Duration) -> bool {
    matches!(
        &state.recent,
        Some((paths, at)) if paths.contains(path) && at.elapsed() < window
    )
}

/// Records `paths` as observed from the OS (`RunEvent::Opened`, routed
/// through `macos_dock::open_paths`). Returns `true` if the frontend has
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

    // Test 1 (§9.2) — the regression test for issue #325 itself: a path
    // recorded with no `AppHandle`/`AppState` in existence at all (nothing
    // these functions ever touch) still comes back from the drain. Before
    // this fix, the equivalent Rust-side call (`macos_dock::open_paths`
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
}

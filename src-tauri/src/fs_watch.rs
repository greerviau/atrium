use crate::workspace::{FsChangeEvent, FsChangeKind};
use notify::event::{ModifyKind, RenameMode};
use notify::{EventKind, RecursiveMode, Watcher};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, FileIdMap};
use std::path::Path;
use std::time::Duration;
use tokio::sync::mpsc::UnboundedSender;

/// Starts a recursive `notify` watcher rooted at `root`, debounced 150ms
/// (coalescing bursts and duplicate paths within the window, handled by
/// `notify-debouncer-full`), forwarding each surviving change as an
/// `FsChangeEvent` on `tx`.
///
/// The debouncer and its underlying OS watcher are kept alive for the
/// lifetime of the returned guard; the caller (`LocalWorkspace`) holds this
/// for as long as the workspace itself is registered.
pub fn watch(
    root: String,
    workspace_id: String,
    tx: UnboundedSender<FsChangeEvent>,
) -> notify_debouncer_full::Debouncer<notify::RecommendedWatcher, FileIdMap> {
    let mut debouncer = new_debouncer(
        Duration::from_millis(150),
        None,
        move |result: DebounceEventResult| match result {
            Ok(events) => {
                for event in events {
                    // `notify-debouncer-full`'s own file-id/rename-cookie
                    // tracking already correlates a rename's `From`/`To`
                    // halves within the debounce window when it can,
                    // producing a single `Modify(Name(Both))` event with
                    // `paths: [from, to]`. That's the only case emitted as
                    // `Rename` with a `from_path` — an unpaired half (the
                    // move crossed outside the watched root, or the
                    // platform couldn't correlate it) is demoted instead of
                    // guessed: `From` to a plain `Remove`, `To`/`Any` to a
                    // plain `Create`.
                    if event.event.kind == EventKind::Modify(ModifyKind::Name(RenameMode::Both)) {
                        if let [from, to] = event.event.paths.as_slice() {
                            let _ = tx.send(FsChangeEvent {
                                workspace_id: workspace_id.clone(),
                                path: to.to_string_lossy().to_string(),
                                kind: FsChangeKind::Rename,
                                from_path: Some(from.to_string_lossy().to_string()),
                            });
                        } else {
                            // A `Both`-kind event should always carry exactly
                            // two paths; if it somehow doesn't, fall back the
                            // same way an unpaired rename half does — a plain
                            // `Remove` per path, never a guessed rename —
                            // rather than dropping the event on the floor.
                            for path in &event.event.paths {
                                let _ = tx.send(FsChangeEvent {
                                    workspace_id: workspace_id.clone(),
                                    path: path.to_string_lossy().to_string(),
                                    kind: FsChangeKind::Remove,
                                    from_path: None,
                                });
                            }
                        }
                        continue;
                    }

                    let kind = match event.event.kind {
                        EventKind::Create(_) => FsChangeKind::Create,
                        EventKind::Remove(_) => FsChangeKind::Remove,
                        EventKind::Modify(ModifyKind::Name(RenameMode::From)) => {
                            FsChangeKind::Remove
                        }
                        EventKind::Modify(ModifyKind::Name(RenameMode::To))
                        | EventKind::Modify(ModifyKind::Name(RenameMode::Any)) => {
                            FsChangeKind::Create
                        }
                        _ => FsChangeKind::Modify,
                    };
                    for path in &event.event.paths {
                        let _ = tx.send(FsChangeEvent {
                            workspace_id: workspace_id.clone(),
                            path: path.to_string_lossy().to_string(),
                            kind: kind.clone(),
                            from_path: None,
                        });
                    }
                }
            }
            Err(_) => {
                // A watch error (e.g. the root was removed) is not
                // actionable by the frontend in the MVP; the workspace
                // simply stops receiving live updates until re-opened.
            }
        },
    )
    .expect("failed to create fs watcher");

    debouncer
        .watcher()
        .watch(Path::new(&root), RecursiveMode::Recursive)
        .expect("failed to start fs watcher");

    debouncer
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc::unbounded_channel;
    use tokio::time::{sleep, timeout, Duration as TokioDuration, Instant as TokioInstant};

    /// Drains every event sent within `budget_ms` of this call, rather than
    /// waiting for exactly one: the debouncer can legitimately emit more than
    /// one wire event per filesystem operation (e.g. a `Create` alongside a
    /// later `Modify` for the same path), so tests assert on the relevant
    /// subset rather than on there being exactly one event overall.
    async fn drain_events(
        rx: &mut tokio::sync::mpsc::UnboundedReceiver<FsChangeEvent>,
        budget_ms: u64,
    ) -> Vec<FsChangeEvent> {
        let deadline = TokioInstant::now() + TokioDuration::from_millis(budget_ms);
        let mut events = Vec::new();
        loop {
            let remaining = deadline.saturating_duration_since(TokioInstant::now());
            if remaining.is_zero() {
                break;
            }
            match timeout(remaining, rx.recv()).await {
                Ok(Some(event)) => events.push(event),
                _ => break,
            }
        }
        events
    }

    // The debounce window is 150ms; every test waits well past that (plus
    // slack for the watcher to actually start up before the first mutation)
    // before asserting on what arrived.
    const SETTLE_MS: u64 = 1000;

    #[tokio::test]
    async fn a_same_directory_rename_arrives_as_one_paired_rename_event() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("old.txt");
        std::fs::write(&from, "hi").unwrap();

        let (tx, mut rx) = unbounded_channel();
        let _debouncer = watch(
            dir.path().to_string_lossy().to_string(),
            "ws".to_string(),
            tx,
        );
        sleep(Duration::from_millis(200)).await;

        let to = dir.path().join("new.txt");
        std::fs::rename(&from, &to).unwrap();

        let events = drain_events(&mut rx, SETTLE_MS).await;
        let renames: Vec<_> = events
            .iter()
            .filter(|e| matches!(e.kind, FsChangeKind::Rename))
            .collect();

        assert_eq!(
            renames.len(),
            1,
            "expected exactly one paired rename event, got {events:?}"
        );
        assert_eq!(renames[0].path, to.to_string_lossy().to_string());
        assert_eq!(
            renames[0].from_path.as_deref(),
            Some(from.to_string_lossy().to_string().as_str())
        );
    }

    #[tokio::test]
    async fn a_delete_still_emits_a_plain_remove_with_no_from_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("gone.txt");
        std::fs::write(&path, "bye").unwrap();

        let (tx, mut rx) = unbounded_channel();
        let _debouncer = watch(
            dir.path().to_string_lossy().to_string(),
            "ws".to_string(),
            tx,
        );
        sleep(Duration::from_millis(200)).await;

        std::fs::remove_file(&path).unwrap();

        let events = drain_events(&mut rx, SETTLE_MS).await;
        let removed = path.to_string_lossy().to_string();
        assert!(
            events.iter().any(|e| matches!(e.kind, FsChangeKind::Remove)
                && e.path == removed
                && e.from_path.is_none()),
            "expected a Remove event with no from_path for {removed}, got {events:?}"
        );
        assert!(!events
            .iter()
            .any(|e| matches!(e.kind, FsChangeKind::Rename)));
    }

    // Whether a move to a destination outside the watched root surfaces as
    // an unpaired `From` (demoted here to `Remove`) versus something else
    // notify can't correlate at all is platform- and filesystem-dependent,
    // so this is best-effort and excluded from the default run.
    #[tokio::test]
    #[ignore = "platform-dependent: relies on notify observing an out-of-root move as an unpaired rename half"]
    async fn a_rename_out_of_the_watched_root_surfaces_as_remove_for_the_source() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let from = dir.path().join("leaving.txt");
        std::fs::write(&from, "hi").unwrap();

        let (tx, mut rx) = unbounded_channel();
        let _debouncer = watch(
            dir.path().to_string_lossy().to_string(),
            "ws".to_string(),
            tx,
        );
        sleep(Duration::from_millis(200)).await;

        let to = outside.path().join("leaving.txt");
        std::fs::rename(&from, &to).unwrap();

        let events = drain_events(&mut rx, SETTLE_MS).await;
        let source = from.to_string_lossy().to_string();
        assert!(
            events.iter().any(|e| matches!(e.kind, FsChangeKind::Remove)
                && e.path == source
                && e.from_path.is_none()),
            "expected the out-of-root move's source to surface as a plain Remove, got {events:?}"
        );
        assert!(!events
            .iter()
            .any(|e| matches!(e.kind, FsChangeKind::Rename)));
    }
}

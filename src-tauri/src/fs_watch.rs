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
) -> notify::Result<notify_debouncer_full::Debouncer<notify::RecommendedWatcher, FileIdMap>> {
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
                        if matches!(kind, FsChangeKind::Create) {
                            reconcile_new_directory(path, &workspace_id, &tx);
                        }
                    }
                }
            }
            Err(_) => {
                // A watch error (e.g. the root was removed) is not
                // actionable by the frontend in the MVP; the workspace
                // simply stops receiving live updates until re-opened.
            }
        },
    )?;

    debouncer
        .watcher()
        .watch(Path::new(&root), RecursiveMode::Recursive)?;

    Ok(debouncer)
}

/// Closes the recursive-watch registration race: `notify`'s inotify backend
/// only registers a watch on a newly created subdirectory *after* draining
/// the batch of raw events that observed its `Create`, so any file written
/// into that subdirectory before the watch is registered produces no
/// inotify event at all (see issue #300). Rather than trying to close that
/// window, this walks the directory's actual contents once its own `Create`
/// event clears the debounce window (by which point the burst has settled)
/// and synthesizes a `Create` for everything found inside, at every depth.
/// Real events that did arrive through `notify` for the same paths become
/// harmless duplicates downstream.
///
/// `symlink_metadata` (not `metadata`) is used deliberately so a symlink is
/// treated as the single leaf entry it is, rather than being followed —
/// matching how the rest of the explorer treats symlinks, and avoiding any
/// risk of an infinite loop through a symlink cycle.
fn reconcile_new_directory(path: &Path, workspace_id: &str, tx: &UnboundedSender<FsChangeEvent>) {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return;
    };
    if !metadata.is_dir() {
        return;
    }

    let mut pending = vec![path.to_path_buf()];
    while let Some(dir) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let entry_path = entry.path();
            let _ = tx.send(FsChangeEvent {
                workspace_id: workspace_id.to_string(),
                path: entry_path.to_string_lossy().to_string(),
                kind: FsChangeKind::Create,
                from_path: None,
            });
            if entry.file_type().is_ok_and(|t| t.is_dir()) {
                pending.push(entry_path);
            }
        }
    }
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
        )
        .unwrap();
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
        )
        .unwrap();
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
        )
        .unwrap();
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

    #[tokio::test]
    async fn watch_returns_an_error_instead_of_panicking_when_the_root_does_not_exist() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("does-not-exist");
        let (tx, _rx) = unbounded_channel();
        let result = watch(missing.to_string_lossy().to_string(), "ws".to_string(), tx);
        assert!(result.is_err());
    }

    // REPRO for issue #300: simulates a `git pull` that introduces a brand
    // new subdirectory full of files in one shot, exactly as git's checkout
    // does (mkdir, then write every file into it back-to-back with no
    // delay). Recursive `notify` watching on Linux (inotify) has to observe
    // the mkdir's Create event and *then* register a fresh inotify watch on
    // that new subdirectory before it can observe anything created inside
    // it — if files land inside the new directory before that watch is
    // registered, their Create events are lost at the kernel level, no
    // matter how the debouncer or frontend behave afterward.
    #[tokio::test]
    async fn a_new_subdirectory_created_with_many_files_at_once_reports_every_file() {
        let dir = tempfile::tempdir().unwrap();
        let (tx, mut rx) = unbounded_channel();
        let _debouncer = watch(
            dir.path().to_string_lossy().to_string(),
            "ws".to_string(),
            tx,
        )
        .unwrap();
        sleep(Duration::from_millis(200)).await;

        let sub = dir.path().join("newdir");
        std::fs::create_dir(&sub).unwrap();
        const N: usize = 50;
        for i in 0..N {
            std::fs::write(sub.join(format!("file{i}.txt")), "x").unwrap();
        }

        let events = drain_events(&mut rx, SETTLE_MS).await;
        let expected: std::collections::HashSet<String> = (0..N)
            .map(|i| sub.join(format!("file{i}.txt")).to_string_lossy().to_string())
            .collect();
        let seen: std::collections::HashSet<String> = events
            .iter()
            .filter(|e| matches!(e.kind, FsChangeKind::Create) && expected.contains(&e.path))
            .map(|e| e.path.clone())
            .collect();

        assert_eq!(
            seen.len(),
            N,
            "expected Create events for all {N} files in the new subdirectory, only saw {}: {:?}",
            seen.len(),
            events
        );
    }

    // Control case: the same burst of file creations, but into a directory
    // that already existed (and was already watched) before the watcher
    // started, so there is no new-watch race to trigger. Distinguishes
    // "recursive watches on brand new subdirectories race" from "any large
    // simultaneous burst drops events regardless."
    #[tokio::test]
    async fn a_burst_of_files_in_an_already_watched_directory_reports_every_file() {
        let dir = tempfile::tempdir().unwrap();
        let (tx, mut rx) = unbounded_channel();
        let _debouncer = watch(
            dir.path().to_string_lossy().to_string(),
            "ws".to_string(),
            tx,
        )
        .unwrap();
        sleep(Duration::from_millis(200)).await;

        const N: usize = 50;
        for i in 0..N {
            std::fs::write(dir.path().join(format!("file{i}.txt")), "x").unwrap();
        }

        let events = drain_events(&mut rx, SETTLE_MS).await;
        let seen: std::collections::HashSet<String> = events
            .iter()
            .filter(|e| matches!(e.kind, FsChangeKind::Create))
            .map(|e| e.path.clone())
            .collect();

        assert_eq!(
            seen.len(),
            N,
            "expected Create events for all {N} files in the already-watched directory, only saw {}: {:?}",
            seen.len(),
            events
        );
    }
}

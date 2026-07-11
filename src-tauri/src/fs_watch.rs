use crate::workspace::{FsChangeEvent, FsChangeKind};
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
                    let kind = match event.event.kind {
                        EventKind::Create(_) => FsChangeKind::Create,
                        EventKind::Remove(_) => FsChangeKind::Remove,
                        EventKind::Modify(notify::event::ModifyKind::Name(_)) => {
                            FsChangeKind::Rename
                        }
                        _ => FsChangeKind::Modify,
                    };
                    for path in &event.event.paths {
                        let _ = tx.send(FsChangeEvent {
                            workspace_id: workspace_id.clone(),
                            path: path.to_string_lossy().to_string(),
                            kind: kind.clone(),
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

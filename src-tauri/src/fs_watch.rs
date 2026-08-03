use crate::workspace::{FsChangeEvent, FsChangeKind};
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use notify::event::{ModifyKind, RenameMode};
use notify::{EventKind, RecursiveMode, Watcher};
use notify_debouncer_full::file_id::{get_file_id, FileId};
use notify_debouncer_full::{new_debouncer_opt, DebounceEventResult, Debouncer, NoCache};
use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc::UnboundedSender;

/// Builds a gitignore matcher for `root`, picking up its `.gitignore`,
/// `.git/info/exclude`, and the user's global excludes file — the same
/// sources `ignore::WalkBuilder` discovers automatically for `local.rs`'s
/// `search_root`/`find_files_root`. None of these require an actual `.git`
/// directory to exist (mirroring those callers' `require_git(false)`
/// posture), so a plain, non-git workspace root still builds a valid, if
/// empty, matcher rather than erroring.
fn build_gitignore(root: &Path) -> Gitignore {
    let mut builder = GitignoreBuilder::new(root);
    builder.add(root.join(".gitignore"));
    builder.add(root.join(".git").join("info").join("exclude"));
    if let Some(global_excludes) = ignore::gitignore::gitconfig_excludes_path() {
        builder.add(global_excludes);
    }
    builder.build().unwrap_or_else(|_| Gitignore::empty())
}

/// Strips `path` down to a root-relative path, trying `canonical_root` first
/// and falling back to `raw_root`: an event path can show up in either form
/// depending on the platform (see `watch`'s doc comment), and whichever one
/// `path` was actually built from is the one whose prefix will match.
/// Returns `None` if `path` isn't under either — this is what keeps an
/// unexpected path from ever reaching `Gitignore::matched_path_or_any_parents`,
/// which panics on a path outside its root: a relative path derived from a
/// successful strip can never trip that assert, so the guard is structural
/// rather than a best-effort fallback.
fn relative_to_root<'a>(
    raw_root: &Path,
    canonical_root: &Path,
    path: &'a Path,
) -> Option<&'a Path> {
    path.strip_prefix(canonical_root)
        .ok()
        .or_else(|| path.strip_prefix(raw_root).ok())
}

/// Rewrites `path` into the form the frontend actually keys tabs and
/// explorer rows by: `raw_root` joined onto whatever root-relative path
/// `relative_to_root` computes, falling back to `path` unchanged if it
/// isn't under either root form. This is what closes the gap between the
/// path form `notify` happens to report — the raw registration path on
/// Linux and Windows, but always the canonicalized one on macOS's FSEvents
/// regardless of what was registered — and the raw form `LocalWorkspace`
/// records as the workspace root: every event ends up addressed the same
/// way, on every platform, whether or not the root sits behind a symlinked
/// ancestor. When `raw_root == canonical_root` (the overwhelmingly common
/// case), this reproduces `path` byte for byte.
fn reported_path(raw_root: &Path, canonical_root: &Path, path: &Path) -> String {
    match relative_to_root(raw_root, canonical_root, path) {
        Some(relative) => raw_root.join(relative).to_string_lossy().to_string(),
        None => path.to_string_lossy().to_string(),
    }
}

/// True if `path` should be excluded from the watcher's output entirely: a
/// component anywhere below the root that `workspace::is_default_ignored`
/// already hides from every explorer listing (`.git`, `.svn`, `.hg`, `CVS`,
/// `.DS_Store`, ...), or a `gitignore` match at the path or any of its
/// parents. This is deliberately narrower than "any dot-prefixed component":
/// a real, editable file like `.env` or `.gitignore` itself, or a directory
/// like `.github`, is never caught by `is_default_ignored` and must keep
/// producing live-update events the same way `list_dir` keeps showing it.
///
/// A path that isn't under either root form (see `relative_to_root`) is let
/// through rather than matched against — this function can't reason about
/// it safely, and letting it through is cheaper and safer than guessing.
fn is_ignored(
    raw_root: &Path,
    canonical_root: &Path,
    gitignore: &Gitignore,
    path: &Path,
    is_dir: Option<bool>,
) -> bool {
    let Some(relative) = relative_to_root(raw_root, canonical_root, path) else {
        return false;
    };
    let has_default_ignored_component = relative.components().any(|component| {
        matches!(
            component,
            Component::Normal(name) if crate::workspace::is_default_ignored(&name.to_string_lossy())
        )
    });
    if has_default_ignored_component {
        return true;
    }
    let is_dir = is_dir.unwrap_or_else(|| {
        std::fs::symlink_metadata(path)
            .map(|metadata| metadata.is_dir())
            .unwrap_or(false)
    });
    // `matched_path_or_any_parents` is given the already-stripped relative
    // path, not the original absolute one: this is what makes the "path
    // under the matcher root" assert structurally unreachable rather than
    // merely unlikely, regardless of which root form `path` was built from.
    gitignore
        .matched_path_or_any_parents(relative, is_dir)
        .is_ignore()
}

/// Tracks stable filesystem identities independently of backend event kinds.
/// This turns an existing destination plus one uniquely missing path with the
/// same identity into a rename even when FSEvents coalesces away the source
/// event, and lets an event for a known path that no longer exists become a
/// removal regardless of the backend's label.
#[derive(Default)]
struct FileIdentityIndex {
    by_path: HashMap<PathBuf, FileId>,
    by_id: HashMap<FileId, HashSet<PathBuf>>,
}

impl FileIdentityIndex {
    fn insert(&mut self, path: PathBuf, file_id: FileId) {
        let stale_aliases: Vec<_> = self
            .by_id
            .get(&file_id)
            .into_iter()
            .flatten()
            .filter(|candidate| candidate.as_path() != path && !candidate.exists())
            .cloned()
            .collect();
        for stale in stale_aliases {
            self.remove_tree(&stale);
        }
        if let Some(previous_id) = self.by_path.insert(path.clone(), file_id) {
            if previous_id != file_id {
                self.remove_reverse(&path, previous_id);
            }
        }
        self.by_id.entry(file_id).or_default().insert(path);
    }

    fn remove_reverse(&mut self, path: &Path, file_id: FileId) {
        if let Some(paths) = self.by_id.get_mut(&file_id) {
            paths.remove(path);
            if paths.is_empty() {
                self.by_id.remove(&file_id);
            }
        }
    }

    fn record_tree(&mut self, path: &Path) {
        let Ok(metadata) = std::fs::symlink_metadata(path) else {
            return;
        };
        if let Ok(file_id) = get_file_id(path) {
            self.insert(path.to_path_buf(), file_id);
        }
        if !metadata.is_dir() {
            return;
        }
        let Ok(entries) = std::fs::read_dir(path) else {
            return;
        };
        for entry in entries.flatten() {
            self.record_tree(&entry.path());
        }
    }

    fn remove_tree(&mut self, path: &Path) {
        let removed: Vec<_> = self
            .by_path
            .keys()
            .filter(|candidate| candidate.starts_with(path))
            .cloned()
            .collect();
        for removed_path in removed {
            if let Some(file_id) = self.by_path.remove(&removed_path) {
                self.remove_reverse(&removed_path, file_id);
            }
        }
    }

    fn move_tree(&mut self, from: &Path, to: &Path) {
        let moved: Vec<_> = self
            .by_path
            .iter()
            .filter_map(|(path, file_id)| {
                path.strip_prefix(from)
                    .ok()
                    .map(|suffix| (to.join(suffix), *file_id))
            })
            .collect();
        self.remove_tree(from);
        self.remove_tree(to);
        for (path, file_id) in moved {
            self.insert(path, file_id);
        }
        self.record_tree(to);
    }

    fn infer_rename_source(&self, destination: &Path) -> Option<PathBuf> {
        let destination_id = get_file_id(destination).ok()?;
        if self
            .by_path
            .get(destination)
            .is_some_and(|indexed_id| *indexed_id != destination_id)
        {
            return None;
        }
        let mut missing = self
            .by_id
            .get(&destination_id)?
            .iter()
            .filter(|source| source.as_path() != destination && !source.exists());
        let source = missing.next()?.clone();
        if missing.next().is_some() {
            return None;
        }
        Some(source)
    }

    fn contains(&self, path: &Path) -> bool {
        self.by_path.contains_key(path)
    }
}

fn send_paired_rename(
    from: &Path,
    to: &Path,
    workspace_id: &str,
    tx: &UnboundedSender<FsChangeEvent>,
    raw_root: &Path,
    canonical_root: &Path,
    gitignore: &Gitignore,
) {
    let to_ignored = is_ignored(raw_root, canonical_root, gitignore, to, None);
    let from_ignored = is_ignored(raw_root, canonical_root, gitignore, from, None);
    if to_ignored && from_ignored {
        return;
    }
    if to_ignored {
        let _ = tx.send(FsChangeEvent {
            workspace_id: workspace_id.to_string(),
            path: reported_path(raw_root, canonical_root, from),
            kind: FsChangeKind::Remove,
            from_path: None,
        });
        return;
    }
    if from_ignored {
        let _ = tx.send(FsChangeEvent {
            workspace_id: workspace_id.to_string(),
            path: reported_path(raw_root, canonical_root, to),
            kind: FsChangeKind::Create,
            from_path: None,
        });
        return;
    }
    let _ = tx.send(FsChangeEvent {
        workspace_id: workspace_id.to_string(),
        path: reported_path(raw_root, canonical_root, to),
        kind: FsChangeKind::Rename,
        from_path: Some(reported_path(raw_root, canonical_root, from)),
    });
}

/// Starts a recursive `notify` watcher rooted at `root`, debounced 150ms
/// (coalescing bursts and duplicate paths within the window, handled by
/// `notify-debouncer-full`), forwarding each surviving change as an
/// `FsChangeEvent` on `tx`.
///
/// A default-ignored path component (`.git`, `.svn`, ...) or a `gitignore`
/// match (via `is_ignored`) is dropped before it ever reaches `tx` —
/// `node_modules`, build output, and VCS bookkeeping never surface as
/// live-update noise. The gitignore matcher is built once per watch
/// registration, not per event.
///
/// The OS watcher stays registered on `root` exactly as given — the caller
/// (`LocalWorkspace::watch`) passes through whatever path the user picked,
/// unresolved, and `LocalWorkspace` itself keys every tab and explorer row
/// by that same unresolved form, matched by exact string equality on the
/// frontend. `notify` builds each event's path by joining onto whatever
/// path it was registered with, so registering on a canonicalized path
/// would change the form of every event the frontend receives and silently
/// break matching for a workspace opened through a symlinked ancestor.
///
/// The ignore matcher, its matching, and the path sent on `tx`, however, all
/// need a canonicalized root alongside the raw one: macOS's FSEvents backend
/// always reports canonicalized event paths regardless of what path was
/// registered, so an event path from `notify` can arrive in either form
/// depending on platform. `is_ignored` (via `relative_to_root`) strips
/// whichever form actually matches before doing any matching, which is also
/// what keeps `Gitignore::matched_path_or_any_parents` (which panics on a
/// path outside its root) from ever seeing a path it isn't prepared for.
/// `reported_path` does the same lookup and re-joins onto the raw root
/// before a path is ever put on `tx`, so every event the frontend receives
/// is addressed in the one form it actually keys tabs and explorer rows by,
/// regardless of which form `notify` happened to hand back. If
/// canonicalization fails (the root doesn't exist), the raw path stands in
/// for it, so the OS watcher registration below still produces the same
/// "root does not exist" error it always did.
///
/// A file-identity index is initialized alongside the OS watcher so both
/// preexisting files and fresh changes remain available for rename
/// correlation when a backend omits one rename half. The index root uses the
/// event-path form for each platform: canonical on macOS, where FSEvents
/// canonicalizes paths, and raw elsewhere.
///
/// The debouncer and its underlying OS watcher are kept alive for the
/// lifetime of the returned guard; the caller (`LocalWorkspace`) holds this
/// for as long as the workspace itself is registered.
pub(crate) type WorkspaceDebouncer = Debouncer<notify::RecommendedWatcher, NoCache>;

pub(crate) fn watch(
    root: String,
    workspace_id: String,
    tx: UnboundedSender<FsChangeEvent>,
) -> notify::Result<WorkspaceDebouncer> {
    let raw_root = PathBuf::from(&root);
    let canonical_root = std::fs::canonicalize(&root).unwrap_or_else(|_| raw_root.clone());
    let gitignore = build_gitignore(&canonical_root);
    #[cfg(target_os = "macos")]
    let file_id_root = canonical_root.clone();
    #[cfg(not(target_os = "macos"))]
    let file_id_root = raw_root.clone();

    let identities = Arc::new(Mutex::new(FileIdentityIndex::default()));
    let callback_identities = identities.clone();
    let mut debouncer = new_debouncer_opt::<_, notify::RecommendedWatcher, NoCache>(
        Duration::from_millis(150),
        None,
        move |result: DebounceEventResult| match result {
            Ok(events) => {
                let mut identities = callback_identities.lock().unwrap();
                let inferred_renames: HashMap<_, _> = events
                    .iter()
                    .filter(|event| {
                        matches!(
                            event.event.kind,
                            EventKind::Create(_)
                                | EventKind::Modify(ModifyKind::Name(
                                    RenameMode::To | RenameMode::Any
                                ))
                        )
                    })
                    .flat_map(|event| event.event.paths.iter())
                    .filter_map(|to| {
                        identities
                            .infer_rename_source(to)
                            .map(|from| (to.clone(), from))
                    })
                    .collect();
                let inferred_sources: HashSet<_> = inferred_renames.values().cloned().collect();
                let mut emitted_renames = HashSet::new();
                let mut emitted_removals = HashSet::new();

                for event in events {
                    // `notify-debouncer-full` correlates rename halves when
                    // the backend supplies enough information. The identity
                    // index above covers FSEvents' coalesced fresh-file case,
                    // where only a destination `Create` survives.
                    if event.event.kind == EventKind::Modify(ModifyKind::Name(RenameMode::Both)) {
                        if let [from, to] = event.event.paths.as_slice() {
                            send_paired_rename(
                                from,
                                to,
                                &workspace_id,
                                &tx,
                                &raw_root,
                                &canonical_root,
                                &gitignore,
                            );
                            identities.move_tree(from, to);
                        } else {
                            for path in &event.event.paths {
                                identities.remove_tree(path);
                                if is_ignored(&raw_root, &canonical_root, &gitignore, path, None) {
                                    continue;
                                }
                                let _ = tx.send(FsChangeEvent {
                                    workspace_id: workspace_id.clone(),
                                    path: reported_path(&raw_root, &canonical_root, path),
                                    kind: FsChangeKind::Remove,
                                    from_path: None,
                                });
                            }
                        }
                        continue;
                    }

                    for path in &event.event.paths {
                        if inferred_sources.contains(path) {
                            continue;
                        }
                        if let Some(from) = inferred_renames.get(path) {
                            if emitted_renames.insert(path.clone()) {
                                send_paired_rename(
                                    from,
                                    path,
                                    &workspace_id,
                                    &tx,
                                    &raw_root,
                                    &canonical_root,
                                    &gitignore,
                                );
                                identities.move_tree(from, path);
                            }
                            continue;
                        }
                        if emitted_removals.contains(path) {
                            continue;
                        }

                        let kind = match event.event.kind {
                            EventKind::Create(_) => FsChangeKind::Create,
                            EventKind::Remove(_)
                            | EventKind::Modify(ModifyKind::Name(RenameMode::From)) => {
                                FsChangeKind::Remove
                            }
                            EventKind::Modify(ModifyKind::Name(RenameMode::To)) => {
                                FsChangeKind::Create
                            }
                            EventKind::Modify(ModifyKind::Name(RenameMode::Any)) => {
                                if path.exists() {
                                    FsChangeKind::Create
                                } else {
                                    FsChangeKind::Remove
                                }
                            }
                            _ if !path.exists() && identities.contains(path) => {
                                FsChangeKind::Remove
                            }
                            _ => FsChangeKind::Modify,
                        };

                        match kind {
                            FsChangeKind::Create => identities.record_tree(path),
                            FsChangeKind::Remove => {
                                identities.remove_tree(path);
                                emitted_removals.insert(path.clone());
                            }
                            FsChangeKind::Modify => identities.record_tree(path),
                            FsChangeKind::Rename => unreachable!(),
                        }
                        if is_ignored(&raw_root, &canonical_root, &gitignore, path, None) {
                            continue;
                        }
                        let _ = tx.send(FsChangeEvent {
                            workspace_id: workspace_id.clone(),
                            path: reported_path(&raw_root, &canonical_root, path),
                            kind: kind.clone(),
                            from_path: None,
                        });
                        if matches!(kind, FsChangeKind::Create) {
                            reconcile_new_directory(
                                path,
                                &workspace_id,
                                &tx,
                                &raw_root,
                                &canonical_root,
                                &gitignore,
                            );
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
        NoCache,
        notify::Config::default(),
    )?;

    let mut identities_guard = identities.lock().unwrap();
    debouncer
        .watcher()
        .watch(Path::new(&root), RecursiveMode::Recursive)?;
    identities_guard.record_tree(&file_id_root);
    drop(identities_guard);

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
///
/// Each discovered entry is checked against `is_ignored` the same way the
/// event loop checks a raw `notify` event, and an ignored subdirectory is
/// never pushed onto `pending` — so walking into a freshly created
/// `node_modules` never happens in the first place, rather than happening
/// and being discarded file by file.
fn reconcile_new_directory(
    path: &Path,
    workspace_id: &str,
    tx: &UnboundedSender<FsChangeEvent>,
    raw_root: &Path,
    canonical_root: &Path,
    gitignore: &Gitignore,
) {
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
            let is_dir = entry.file_type().is_ok_and(|t| t.is_dir());
            if is_ignored(
                raw_root,
                canonical_root,
                gitignore,
                &entry_path,
                Some(is_dir),
            ) {
                continue;
            }
            let _ = tx.send(FsChangeEvent {
                workspace_id: workspace_id.to_string(),
                path: reported_path(raw_root, canonical_root, &entry_path),
                kind: FsChangeKind::Create,
                from_path: None,
            });
            if is_dir {
                pending.push(entry_path);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc::unbounded_channel;
    use tokio::time::{timeout, Duration as TokioDuration, Instant as TokioInstant};

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

    // The debounce window is 150ms; every test waits well past that before
    // asserting on what arrived. `STARTUP_SETTLE_MS` is slack right after
    // the watcher starts, drained (not just slept through) so any bleed
    // from the watched root's own creation is discarded from `rx` before
    // a test does anything else. GitHub Actions' macOS runners need
    // noticeably more of it than a local machine or Linux's inotify does.
    const STARTUP_SETTLE_MS: u64 = 500;
    const SETTLE_MS: u64 = 2000;

    /// Blocks until `rx` produces a `Create` event for exactly `path` (or
    /// panics on timeout). This separates setup from the mutation under test
    /// at the debouncer boundary while deliberately leaving macOS's longer
    /// FSEvents coalescing window active.
    async fn wait_until_seen(
        rx: &mut tokio::sync::mpsc::UnboundedReceiver<FsChangeEvent>,
        path: &Path,
    ) {
        let target = path.to_string_lossy().to_string();
        let deadline = TokioInstant::now() + TokioDuration::from_millis(SETTLE_MS);
        loop {
            let remaining = deadline.saturating_duration_since(TokioInstant::now());
            assert!(
                !remaining.is_zero(),
                "timed out waiting for a Create event for {target}"
            );
            match timeout(remaining, rx.recv()).await {
                Ok(Some(event))
                    if event.path == target && matches!(event.kind, FsChangeKind::Create) =>
                {
                    return
                }
                Ok(Some(_)) => continue,
                _ => panic!("timed out waiting for a Create event for {target}"),
            }
        }
    }

    /// `/var` on macOS is itself a symlink to `/private/var`; `tempfile`
    /// returns the unresolved `/var/...` form, but `notify`'s macOS backend
    /// reports the OS-canonicalized `/private/var/...` path. Every path a
    /// test builds to compare against a watch event goes through this so
    /// the comparison is exact on macOS (a no-op elsewhere, since there's
    /// no such symlink to resolve).
    fn canonical_root(dir: &tempfile::TempDir) -> std::path::PathBuf {
        dir.path().canonicalize().unwrap()
    }

    #[tokio::test]
    async fn a_same_directory_rename_arrives_as_one_paired_rename_event() {
        let dir = tempfile::tempdir().unwrap();
        let root = canonical_root(&dir);
        let from = root.join("old.txt");

        let (tx, mut rx) = unbounded_channel();
        let _debouncer = watch(root.to_string_lossy().to_string(), "ws".to_string(), tx).unwrap();
        let _ = drain_events(&mut rx, STARTUP_SETTLE_MS).await;

        std::fs::write(&from, "hi").unwrap();
        wait_until_seen(&mut rx, &from).await;

        let to = root.join("new.txt");
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
        let root = canonical_root(&dir);
        let path = root.join("gone.txt");

        let (tx, mut rx) = unbounded_channel();
        let _debouncer = watch(root.to_string_lossy().to_string(), "ws".to_string(), tx).unwrap();
        let _ = drain_events(&mut rx, STARTUP_SETTLE_MS).await;

        std::fs::write(&path, "bye").unwrap();
        wait_until_seen(&mut rx, &path).await;

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
        let root = canonical_root(&dir);
        let outside = tempfile::tempdir().unwrap();
        let from = root.join("leaving.txt");

        let (tx, mut rx) = unbounded_channel();
        let _debouncer = watch(root.to_string_lossy().to_string(), "ws".to_string(), tx).unwrap();
        let _ = drain_events(&mut rx, STARTUP_SETTLE_MS).await;

        std::fs::write(&from, "hi").unwrap();
        wait_until_seen(&mut rx, &from).await;

        let to = canonical_root(&outside).join("leaving.txt");
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
    async fn a_long_lived_preexisting_file_rename_is_correlated() {
        let dir = tempfile::tempdir().unwrap();
        let root = canonical_root(&dir);
        let from = root.join("existing.txt");
        let to = root.join("moved.txt");
        std::fs::write(&from, "existing").unwrap();
        // FSEvents may retain a file's flags for roughly 30 seconds. Keeping
        // this fixture outside that window proves the index is initialized
        // from the preexisting tree rather than from its Create event.
        #[cfg(target_os = "macos")]
        tokio::time::sleep(TokioDuration::from_secs(35)).await;
        let (tx, mut rx) = unbounded_channel();
        let _debouncer = watch(root.to_string_lossy().to_string(), "ws".to_string(), tx).unwrap();
        let _ = drain_events(&mut rx, STARTUP_SETTLE_MS).await;

        std::fs::rename(&from, &to).unwrap();

        let events = drain_events(&mut rx, SETTLE_MS).await;
        assert!(
            events.iter().any(|event| {
                matches!(event.kind, FsChangeKind::Rename)
                    && event.path == to.to_string_lossy()
                    && event.from_path.as_deref() == Some(from.to_string_lossy().as_ref())
            }),
            "expected a paired rename for a preexisting file, got {events:?}"
        );
    }

    #[test]
    fn an_atomic_replacement_is_not_misclassified_as_a_rename() {
        let dir = tempfile::tempdir().unwrap();
        let root = canonical_root(&dir);
        let target = root.join("target.txt");
        let temporary = root.join("temporary.txt");
        std::fs::write(&target, "old").unwrap();
        std::fs::write(&temporary, "new").unwrap();
        let mut identities = FileIdentityIndex::default();
        identities.record_tree(&root);

        std::fs::remove_file(&target).unwrap();
        std::fs::rename(&temporary, &target).unwrap();

        assert_eq!(identities.infer_rename_source(&target), None);
    }

    #[test]
    fn a_new_hard_link_is_not_misclassified_as_a_rename() {
        let dir = tempfile::tempdir().unwrap();
        let root = canonical_root(&dir);
        let source = root.join("source.txt");
        let link = root.join("link.txt");
        std::fs::write(&source, "shared").unwrap();
        let mut identities = FileIdentityIndex::default();
        identities.record_tree(&root);

        std::fs::hard_link(&source, &link).unwrap();

        assert_eq!(identities.infer_rename_source(&link), None);
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
        let root = canonical_root(&dir);
        let (tx, mut rx) = unbounded_channel();
        let _debouncer = watch(root.to_string_lossy().to_string(), "ws".to_string(), tx).unwrap();
        let _ = drain_events(&mut rx, STARTUP_SETTLE_MS).await;

        let sub = root.join("newdir");
        std::fs::create_dir(&sub).unwrap();
        const N: usize = 50;
        for i in 0..N {
            std::fs::write(sub.join(format!("file{i}.txt")), "x").unwrap();
        }

        let events = drain_events(&mut rx, SETTLE_MS).await;
        let expected: std::collections::HashSet<String> = (0..N)
            .map(|i| {
                sub.join(format!("file{i}.txt"))
                    .to_string_lossy()
                    .to_string()
            })
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
        let root = canonical_root(&dir);
        let (tx, mut rx) = unbounded_channel();
        let _debouncer = watch(root.to_string_lossy().to_string(), "ws".to_string(), tx).unwrap();
        let _ = drain_events(&mut rx, STARTUP_SETTLE_MS).await;

        const N: usize = 50;
        for i in 0..N {
            std::fs::write(root.join(format!("file{i}.txt")), "x").unwrap();
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

    // Positive case: a `.gitignore` entry for `node_modules` keeps every
    // path under it — including a subdirectory and file created inside it
    // in one burst — off the wire entirely, both the raw `notify` event and
    // anything `reconcile_new_directory` would otherwise have synthesized.
    // A sibling tracked file is created in the same burst and must still
    // arrive, so the test can't pass vacuously on a watcher that delivered
    // nothing at all.
    #[tokio::test]
    async fn a_gitignored_directory_produces_no_events_for_anything_created_inside_it() {
        let dir = tempfile::tempdir().unwrap();
        let root = canonical_root(&dir);
        std::fs::write(root.join(".gitignore"), "node_modules\n").unwrap();

        let (tx, mut rx) = unbounded_channel();
        let _debouncer = watch(root.to_string_lossy().to_string(), "ws".to_string(), tx).unwrap();
        let _ = drain_events(&mut rx, STARTUP_SETTLE_MS).await;

        let pkg_dir = root.join("node_modules").join("pkg");
        std::fs::create_dir_all(&pkg_dir).unwrap();
        std::fs::write(pkg_dir.join("index.js"), "module.exports = {};").unwrap();
        let tracked = root.join("main.rs");
        std::fs::write(&tracked, "fn main() {}").unwrap();

        let events = drain_events(&mut rx, SETTLE_MS).await;
        let ignored_root = root.join("node_modules").to_string_lossy().to_string();
        assert!(
            !events.iter().any(|e| e.path.starts_with(&ignored_root)),
            "expected no events for anything under node_modules, got {events:?}"
        );
        let tracked_path = tracked.to_string_lossy().to_string();
        assert!(
            events
                .iter()
                .any(|e| matches!(e.kind, FsChangeKind::Create) && e.path == tracked_path),
            "expected a Create event for the non-ignored sibling file, got {events:?}"
        );
    }

    // Negative case: a sibling, non-ignored file in the same root must still
    // arrive normally — guards against the matcher over-matching beyond
    // what the `.gitignore` actually lists.
    #[tokio::test]
    async fn a_non_ignored_sibling_file_still_reports_a_create_event() {
        let dir = tempfile::tempdir().unwrap();
        let root = canonical_root(&dir);
        std::fs::write(root.join(".gitignore"), "node_modules\n").unwrap();

        let (tx, mut rx) = unbounded_channel();
        let _debouncer = watch(root.to_string_lossy().to_string(), "ws".to_string(), tx).unwrap();
        let _ = drain_events(&mut rx, STARTUP_SETTLE_MS).await;

        let tracked = root.join("main.rs");
        std::fs::write(&tracked, "fn main() {}").unwrap();
        wait_until_seen(&mut rx, &tracked).await;
    }

    // Default-ignored-directory case: `.git` is excluded because it's on
    // `workspace::is_default_ignored`'s fixed list, with no `.gitignore`
    // entry needed — this is what keeps `.git` out of search/find-files
    // today, and the watcher applies the same list. A sibling tracked file
    // created in the same burst must still arrive, so the test can't pass
    // vacuously on a watcher that delivered nothing at all.
    #[tokio::test]
    async fn a_default_ignored_directory_produces_no_events_even_with_no_gitignore_entry() {
        let dir = tempfile::tempdir().unwrap();
        let root = canonical_root(&dir);

        let (tx, mut rx) = unbounded_channel();
        let _debouncer = watch(root.to_string_lossy().to_string(), "ws".to_string(), tx).unwrap();
        let _ = drain_events(&mut rx, STARTUP_SETTLE_MS).await;

        let git_dir = root.join(".git");
        std::fs::create_dir(&git_dir).unwrap();
        std::fs::write(git_dir.join("HEAD"), "ref: refs/heads/main").unwrap();
        let tracked = root.join("main.rs");
        std::fs::write(&tracked, "fn main() {}").unwrap();

        let events = drain_events(&mut rx, SETTLE_MS).await;
        let ignored_root = git_dir.to_string_lossy().to_string();
        assert!(
            !events.iter().any(|e| e.path.starts_with(&ignored_root)),
            "expected no events for anything under .git, got {events:?}"
        );
        let tracked_path = tracked.to_string_lossy().to_string();
        assert!(
            events
                .iter()
                .any(|e| matches!(e.kind, FsChangeKind::Create) && e.path == tracked_path),
            "expected a Create event for the non-ignored sibling file, got {events:?}"
        );
    }

    // Regression guard for the dot-prefix rule's scope: a real, editable
    // dotfile that `workspace::is_default_ignored` does NOT cover (`.env`)
    // and a dot-prefixed directory it does not cover (`.github`) must still
    // report events — the watcher must not go blind to anything
    // `Workspace::list_dir` still shows and the editor still opens.
    #[tokio::test]
    async fn a_dotfile_not_on_the_default_ignored_list_still_reports_a_create_event() {
        let dir = tempfile::tempdir().unwrap();
        let root = canonical_root(&dir);

        let (tx, mut rx) = unbounded_channel();
        let _debouncer = watch(root.to_string_lossy().to_string(), "ws".to_string(), tx).unwrap();
        let _ = drain_events(&mut rx, STARTUP_SETTLE_MS).await;

        let env_file = root.join(".env");
        std::fs::write(&env_file, "SECRET=1").unwrap();
        wait_until_seen(&mut rx, &env_file).await;

        let workflows_dir = root.join(".github").join("workflows");
        std::fs::create_dir_all(&workflows_dir).unwrap();
        let workflow_file = workflows_dir.join("ci.yml");
        std::fs::write(&workflow_file, "name: ci").unwrap();
        wait_until_seen(&mut rx, &workflow_file).await;
    }

    // No-gitignore case: a root with no `.gitignore` at all must still
    // watch normally — regression guard on `build_gitignore`'s empty-matcher
    // fallback (the `require_git(false)`-equivalent posture).
    #[tokio::test]
    async fn a_root_with_no_gitignore_still_watches_normally() {
        let dir = tempfile::tempdir().unwrap();
        let root = canonical_root(&dir);
        assert!(!root.join(".gitignore").exists());

        let (tx, mut rx) = unbounded_channel();
        let _debouncer = watch(root.to_string_lossy().to_string(), "ws".to_string(), tx).unwrap();
        let _ = drain_events(&mut rx, STARTUP_SETTLE_MS).await;

        let tracked = root.join("main.rs");
        std::fs::write(&tracked, "fn main() {}").unwrap();
        wait_until_seen(&mut rx, &tracked).await;
    }

    // Regression guard: the caller never canonicalizes the root it hands to
    // `watch` (`LocalWorkspace::watch` passes through whatever the user
    // picked, and keys every tab and explorer row by that same unresolved
    // form), so a root reached through a symlinked ancestor must still
    // watch normally, and every event must arrive addressed in that same
    // raw form regardless of platform. macOS's FSEvents backend always
    // reports the canonicalized path for a watched event, no matter what
    // was registered — `reported_path` (via `relative_to_root`) translates
    // it back to the raw-root form before the event ever reaches `tx`, so
    // this holds on macOS too, not just on the platforms where `notify`
    // happens to preserve the registered path form on its own.
    #[tokio::test]
    async fn watching_through_a_symlinked_root_still_reports_events() {
        let dir = tempfile::tempdir().unwrap();
        let base = canonical_root(&dir);
        let real_root = base.join("real");
        std::fs::create_dir(&real_root).unwrap();
        let link_root = base.join("link");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real_root, &link_root).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(&real_root, &link_root).unwrap();

        let (tx, mut rx) = unbounded_channel();
        let _debouncer = watch(
            link_root.to_string_lossy().to_string(),
            "ws".to_string(),
            tx,
        )
        .unwrap();
        let _ = drain_events(&mut rx, STARTUP_SETTLE_MS).await;

        std::fs::write(real_root.join("main.rs"), "fn main() {}").unwrap();
        // The frontend only ever holds the link-rooted form (it's what
        // `LocalWorkspace::root()` returns), so that's what a live-update
        // event must arrive as — not the real-path form the write used.
        wait_until_seen(&mut rx, &link_root.join("main.rs")).await;
    }

    // M3 regression: a rename whose destination lands in an ignored
    // directory must not drop the event outright — the source still needs
    // to be reported gone, or a tab/explorer row for it is stuck pointing
    // at a path that no longer exists.
    #[tokio::test]
    async fn a_rename_into_an_ignored_destination_reports_only_a_remove_for_the_source() {
        let dir = tempfile::tempdir().unwrap();
        let root = canonical_root(&dir);
        std::fs::write(root.join(".gitignore"), "dist\n").unwrap();
        std::fs::create_dir(root.join("dist")).unwrap();

        let (tx, mut rx) = unbounded_channel();
        let _debouncer = watch(root.to_string_lossy().to_string(), "ws".to_string(), tx).unwrap();
        let _ = drain_events(&mut rx, STARTUP_SETTLE_MS).await;

        let from = root.join("notes.md");
        std::fs::write(&from, "hi").unwrap();
        wait_until_seen(&mut rx, &from).await;

        let to = root.join("dist").join("notes.md");
        std::fs::rename(&from, &to).unwrap();

        let events = drain_events(&mut rx, SETTLE_MS).await;
        let source = from.to_string_lossy().to_string();
        let dest = to.to_string_lossy().to_string();
        assert!(
            events.iter().any(|e| matches!(e.kind, FsChangeKind::Remove)
                && e.path == source
                && e.from_path.is_none()),
            "expected a plain Remove event for the source, got {events:?}"
        );
        assert!(
            !events.iter().any(|e| e.path == dest),
            "expected no event referencing the ignored destination, got {events:?}"
        );
        assert!(!events
            .iter()
            .any(|e| matches!(e.kind, FsChangeKind::Rename)));
    }
}

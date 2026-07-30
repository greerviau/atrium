use crate::error::AppError;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Runtime};
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "recents.json";
const STORE_KEY: &str = "recents";
const MAX_RECENTS: usize = 10;

/// A project (or, for a standalone single-file open, a file — issue #325's
/// follow-on) the user has previously opened, shown in both the welcome
/// screen and the macOS Dock menu (`macos_dock.rs`) so the two never drift:
/// both read this same on-disk list.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    pub path: String,
    pub name: String,
    pub last_opened_at: u64,
    /// True for a single file opened with no project workspace (a
    /// `StandaloneWorkspace` tab) rather than a folder. `#[serde(default)]`
    /// so an entry persisted before this field existed (always a folder)
    /// deserializes as `false` rather than failing to load.
    #[serde(default)]
    pub is_file: bool,
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The last path component, used as the display name for either a folder or
/// a file entry.
fn display_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

/// Moves `path` to the front (inserting it if new), dedupes by path, and
/// caps the result at `MAX_RECENTS`. `is_file` is read from the filesystem
/// rather than threaded in as a parameter, so every caller — `record`'s two
/// call sites, present and future — gets a consistent, un-fakeable answer
/// from the one place that already does the same thing for `prune_missing`
/// below.
fn upsert(mut recents: Vec<RecentProject>, path: &str, opened_at: u64) -> Vec<RecentProject> {
    recents.retain(|r| r.path != path);
    recents.insert(
        0,
        RecentProject {
            path: path.to_string(),
            name: display_name(path),
            last_opened_at: opened_at,
            is_file: !Path::new(path).is_dir(),
        },
    );
    recents.truncate(MAX_RECENTS);
    recents
}

/// Drops entries whose path no longer exists on disk.
fn prune_missing(recents: Vec<RecentProject>) -> Vec<RecentProject> {
    recents
        .into_iter()
        .filter(|r| Path::new(&r.path).exists())
        .collect()
}

fn remove_path(recents: Vec<RecentProject>, path: &str) -> Vec<RecentProject> {
    recents.into_iter().filter(|r| r.path != path).collect()
}

fn read_store<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<RecentProject>, AppError> {
    let store = app
        .store(STORE_FILE)
        .map_err(|e| AppError::Other(e.to_string()))?;
    Ok(store
        .get(STORE_KEY)
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default())
}

fn write_store<R: Runtime>(app: &AppHandle<R>, recents: &[RecentProject]) -> Result<(), AppError> {
    let store = app
        .store(STORE_FILE)
        .map_err(|e| AppError::Other(e.to_string()))?;
    let value = serde_json::to_value(recents).map_err(|e| AppError::Other(e.to_string()))?;
    store.set(STORE_KEY, value);
    store.save().map_err(|e| AppError::Other(e.to_string()))?;
    Ok(())
}

/// Records `path` as the most recently opened project or file. Two call
/// sites: `workspace_set_root`, the choke point every "open a folder"
/// action (in-app button, `File` menu, Dock menu) already goes through
/// unconditionally, and `workspace_record_recent_file`
/// (`commands/workspace.rs`), which records a standalone single-file open
/// and — unlike the folder path — is gated on
/// `commands::fs::require_recent_external_open` before ever calling this,
/// so a file only ever lands here via the same real-OS-open provenance
/// `fs_grant_external_file` itself requires. See `is_recorded_file` for why
/// that gating matters beyond record-time.
pub fn record<R: Runtime>(app: &AppHandle<R>, path: &str) -> Result<(), AppError> {
    let recents = read_store(app)?;
    let recents = upsert(recents, path, now_millis());
    write_store(app, &recents)
}

/// The pure check behind `is_recorded_file`, split out so it's directly
/// testable without an `AppHandle` — the same convention `upsert`,
/// `prune_missing`, and `remove_path` above already establish for this
/// file's own `AppHandle`-taking wrappers.
fn recorded_as_file(recents: &[RecentProject], path: &str) -> bool {
    recents.iter().any(|r| r.is_file && r.path == path)
}

/// True if `path` is present in the persisted recents list as a *file*
/// entry — used by `commands::fs::require_recent_external_open` as a third,
/// unbounded-in-time authorization origin alongside a fresh real drop or
/// OS-open: it lets a standalone file the user has legitimately opened
/// before be reopened later (from the title-bar switcher or the welcome
/// screen's recents list) without a second live OS event. This grants a
/// compromised renderer no capability it didn't already have — the only way
/// a path ever lands here with `is_file: true` is by having *already*
/// passed that exact same gate once, at record time (see `record`'s doc
/// comment) — and removing an entry (`remove_recent`) revokes this standing
/// re-authorization along with the list entry itself.
pub fn is_recorded_file<R: Runtime>(app: &AppHandle<R>, path: &str) -> bool {
    recorded_as_file(&read_store(app).unwrap_or_default(), path)
}

/// Returns the recents list, pruning (and persisting the prune of) any
/// entry whose path no longer exists on disk.
pub fn get_recents<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<RecentProject>, AppError> {
    let recents = read_store(app)?;
    let pruned = prune_missing(recents.clone());
    if pruned.len() != recents.len() {
        write_store(app, &pruned)?;
    }
    Ok(pruned)
}

/// Explicitly removes `path` from the recents list.
pub fn remove_recent<R: Runtime>(app: &AppHandle<R>, path: &str) -> Result<(), AppError> {
    let recents = read_store(app)?;
    let recents = remove_path(recents, path);
    write_store(app, &recents)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upsert_adds_new_entry_to_front() {
        let recents = upsert(vec![], "/projects/a", 1);
        assert_eq!(recents.len(), 1);
        assert_eq!(recents[0].path, "/projects/a");
        assert_eq!(recents[0].name, "a");
        assert_eq!(recents[0].last_opened_at, 1);
    }

    #[test]
    fn upsert_dedupes_and_moves_existing_entry_to_front() {
        let recents = vec![
            RecentProject {
                path: "/a".into(),
                name: "a".into(),
                last_opened_at: 1,
                is_file: false,
            },
            RecentProject {
                path: "/b".into(),
                name: "b".into(),
                last_opened_at: 2,
                is_file: false,
            },
        ];
        let recents = upsert(recents, "/a", 3);
        assert_eq!(recents.len(), 2);
        assert_eq!(recents[0].path, "/a");
        assert_eq!(recents[0].last_opened_at, 3);
        assert_eq!(recents[1].path, "/b");
    }

    #[test]
    fn upsert_caps_at_max_recents() {
        let mut recents = Vec::new();
        for i in 0..MAX_RECENTS {
            recents = upsert(recents, &format!("/p{i}"), i as u64);
        }
        assert_eq!(recents.len(), MAX_RECENTS);

        recents = upsert(recents, "/new", MAX_RECENTS as u64);

        assert_eq!(recents.len(), MAX_RECENTS);
        assert_eq!(recents[0].path, "/new");
        assert!(!recents.iter().any(|r| r.path == "/p0"));
    }

    #[test]
    fn prune_missing_drops_paths_that_no_longer_exist_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let keep_path = dir.path().join("keep");
        std::fs::create_dir(&keep_path).unwrap();
        let gone_path = dir.path().join("gone");

        let recents = vec![
            RecentProject {
                path: keep_path.to_string_lossy().into_owned(),
                name: "keep".into(),
                last_opened_at: 1,
                is_file: false,
            },
            RecentProject {
                path: gone_path.to_string_lossy().into_owned(),
                name: "gone".into(),
                last_opened_at: 2,
                is_file: false,
            },
        ];

        let pruned = prune_missing(recents);

        assert_eq!(pruned.len(), 1);
        assert_eq!(pruned[0].name, "keep");
    }

    #[test]
    fn remove_path_drops_the_matching_entry_only() {
        let recents = vec![
            RecentProject {
                path: "/a".into(),
                name: "a".into(),
                last_opened_at: 1,
                is_file: false,
            },
            RecentProject {
                path: "/b".into(),
                name: "b".into(),
                last_opened_at: 2,
                is_file: false,
            },
        ];

        let recents = remove_path(recents, "/a");

        assert_eq!(recents.len(), 1);
        assert_eq!(recents[0].path, "/b");
    }

    // Regression coverage for issue #325's follow-on defects (§4 of the
    // human's report): a cold-launched single file was never recorded to
    // recents at all. `upsert` (and so `record`) must tell a file apart
    // from a folder so the frontend can route a click on either kind
    // correctly instead of always treating a recent entry as a folder.
    #[test]
    fn upsert_marks_a_real_file_path_as_is_file_true() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("notes.md");
        std::fs::write(&file, "hi").unwrap();

        let recents = upsert(vec![], file.to_str().unwrap(), 1);

        assert!(recents[0].is_file);
    }

    #[test]
    fn upsert_marks_a_real_directory_path_as_is_file_false() {
        let dir = tempfile::tempdir().unwrap();

        let recents = upsert(vec![], dir.path().to_str().unwrap(), 1);

        assert!(!recents[0].is_file);
    }

    #[test]
    fn recorded_as_file_is_true_only_for_a_matching_file_entry() {
        let recents = vec![
            RecentProject {
                path: "/a".into(),
                name: "a".into(),
                last_opened_at: 1,
                is_file: true,
            },
            RecentProject {
                path: "/b".into(),
                name: "b".into(),
                last_opened_at: 2,
                is_file: false,
            },
        ];
        assert!(recorded_as_file(&recents, "/a"));
        // A folder entry at a path never authorizes a file grant for it,
        // even though the path string matches — `is_file` on the entry
        // itself is what's checked, not mere presence in the list.
        assert!(!recorded_as_file(&recents, "/b"));
        assert!(!recorded_as_file(&recents, "/never-recorded"));
    }
}

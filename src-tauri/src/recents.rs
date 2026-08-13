use crate::error::AppError;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Runtime};
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "recents.json";
const STORE_KEY: &str = "recents";
const MAX_RECENTS: usize = 10;

/// A project the user has previously opened, shown in both the welcome
/// screen and the macOS Dock menu (`macos_dock.rs`) so the two never drift:
/// both read this same on-disk list.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    pub path: String,
    pub name: String,
    pub last_opened_at: u64,
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn folder_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

/// Moves `path` to the front (inserting it if new), dedupes by path — under
/// `canonical_key`, so a different spelling of an already-recorded project
/// is recognized as the same entry rather than added as a duplicate — and
/// caps the result at `MAX_RECENTS`. The stored `path` itself is also the
/// canonical key, not the raw input, so a later `remove_path` call (which
/// only ever receives what the frontend sends, already canonicalized at its
/// own IPC boundary) can find it.
fn upsert(mut recents: Vec<RecentProject>, path: &str, opened_at: u64) -> Vec<RecentProject> {
    let key = crate::path_key::canonical_key(path);
    recents.retain(|r| crate::path_key::canonical_key(&r.path) != key);
    recents.insert(
        0,
        RecentProject {
            path: key,
            name: folder_name(path),
            last_opened_at: opened_at,
        },
    );
    recents.truncate(MAX_RECENTS);
    recents
}

/// Drops entries whose path is no longer a directory on disk — this list is
/// project (folder) roots only, never individual files. Checking `is_dir`
/// rather than plain `exists` means a file-shaped entry, however it got
/// here, self-heals the next time this runs rather than lingering
/// indefinitely: `exists` alone would never drop it, since the file itself
/// is still there.
fn prune_missing(recents: Vec<RecentProject>) -> Vec<RecentProject> {
    recents
        .into_iter()
        .filter(|r| Path::new(&r.path).is_dir())
        .collect()
}

fn remove_path(recents: Vec<RecentProject>, path: &str) -> Vec<RecentProject> {
    let key = crate::path_key::canonical_key(path);
    recents
        .into_iter()
        .filter(|r| crate::path_key::canonical_key(&r.path) != key)
        .collect()
}

/// One-time on-disk migration for a list persisted before this fold
/// existed: folds every loaded entry's `path` through `canonical_key` and
/// dedupes by it, keeping the most recent `last_opened_at` of any
/// collision (the two spellings' surviving entries are otherwise
/// indistinguishable, so recency is the only meaningful tiebreak). Without
/// this, a Windows user's existing list would carry both an old,
/// pre-fix-spelling row and — the moment they next open that project — a
/// second row under the canonical spelling, since `upsert`'s own dedupe
/// only ever sees what's already in the in-memory list it's called with.
fn migrate_to_canonical_keys(recents: Vec<RecentProject>) -> Vec<RecentProject> {
    let mut by_key: std::collections::HashMap<String, RecentProject> =
        std::collections::HashMap::new();
    for mut entry in recents {
        let key = crate::path_key::canonical_key(&entry.path);
        entry.path = key.clone();
        match by_key.get(&key) {
            Some(existing) if existing.last_opened_at >= entry.last_opened_at => {}
            _ => {
                by_key.insert(key, entry);
            }
        }
    }
    let mut migrated: Vec<RecentProject> = by_key.into_values().collect();
    migrated.sort_by_key(|r| std::cmp::Reverse(r.last_opened_at));
    migrated
}

fn read_store<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<RecentProject>, AppError> {
    let store = app
        .store(STORE_FILE)
        .map_err(|e| AppError::Other(e.to_string()))?;
    let loaded: Vec<RecentProject> = store
        .get(STORE_KEY)
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default();
    Ok(migrate_to_canonical_keys(loaded))
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

/// Records `path` as the most recently opened project. Called from
/// `workspace_set_root`, the single choke point every "open a folder"
/// action (in-app button, `File` menu, Dock menu) already goes through, so
/// the list can never miss an entry or drift from what's actually open.
pub fn record<R: Runtime>(app: &AppHandle<R>, path: &str) -> Result<(), AppError> {
    let recents = read_store(app)?;
    let recents = upsert(recents, path, now_millis());
    write_store(app, &recents)
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
            },
            RecentProject {
                path: "/b".into(),
                name: "b".into(),
                last_opened_at: 2,
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
            },
            RecentProject {
                path: gone_path.to_string_lossy().into_owned(),
                name: "gone".into(),
                last_opened_at: 2,
            },
        ];

        let pruned = prune_missing(recents);

        assert_eq!(pruned.len(), 1);
        assert_eq!(pruned[0].name, "keep");
    }

    // An entry whose path exists on disk but is a *file*, not a directory,
    // must be pruned exactly like a genuinely-missing path — this list is
    // project roots only. A plain `.exists()` check would never drop it,
    // since the file itself is still there, and clicking it would try to
    // open it as a project folder and fail.
    #[test]
    fn prune_missing_drops_a_path_that_exists_but_is_a_file_not_a_directory() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("stale-standalone-entry.md");
        std::fs::write(&file_path, "hi").unwrap();

        let recents = vec![RecentProject {
            path: file_path.to_string_lossy().into_owned(),
            name: "stale-standalone-entry.md".into(),
            last_opened_at: 1,
        }];

        let pruned = prune_missing(recents);

        assert!(pruned.is_empty());
    }

    // R5 (Windows path-canonicalization plan) — opening a project already in
    // the list, but under a different textual spelling of the same real
    // path, must dedupe to one entry rather than adding a second row.
    #[test]
    fn upsert_dedupes_a_different_spelling_of_an_existing_windows_entry() {
        let recents = upsert(vec![], r"C:\ws\project", 1);
        assert_eq!(recents.len(), 1);

        let recents = upsert(recents, "C:/ws/project", 2);

        assert_eq!(recents.len(), 1);
        assert_eq!(recents[0].last_opened_at, 2);
    }

    // R5 — removing a project by a different spelling than the one it was
    // recorded under must still find and drop it; otherwise a Windows
    // user's stale-spelling row is permanently unremovable.
    #[test]
    fn remove_path_removes_a_different_spelling_of_the_recorded_path() {
        let recents = upsert(vec![], r"C:\ws\project", 1);

        let recents = remove_path(recents, "C:/ws/project");

        assert!(recents.is_empty());
    }

    // R5 — the on-disk migration `read_store` runs on every load: a store
    // seeded with both spellings of one project (the shape a Windows user's
    // pre-fix `recents.json` is actually in) collapses to one entry, keeping
    // whichever had the newer `last_opened_at` — the two survivors are
    // otherwise indistinguishable, so recency is the only meaningful
    // tiebreak.
    #[test]
    fn migrate_to_canonical_keys_dedupes_two_spellings_and_keeps_the_newer_one() {
        let seeded = vec![
            RecentProject {
                path: r"C:\ws\project".into(),
                name: "project".into(),
                last_opened_at: 1,
            },
            RecentProject {
                path: "C:/ws/project".into(),
                name: "project".into(),
                last_opened_at: 5,
            },
        ];

        let migrated = migrate_to_canonical_keys(seeded);

        assert_eq!(migrated.len(), 1);
        assert_eq!(migrated[0].path, "C:/ws/project");
        assert_eq!(migrated[0].last_opened_at, 5);
    }

    #[test]
    fn migrate_to_canonical_keys_leaves_distinct_projects_untouched() {
        let seeded = vec![
            RecentProject {
                path: "/a".into(),
                name: "a".into(),
                last_opened_at: 1,
            },
            RecentProject {
                path: "/b".into(),
                name: "b".into(),
                last_opened_at: 2,
            },
        ];

        let migrated = migrate_to_canonical_keys(seeded);

        assert_eq!(migrated.len(), 2);
    }

    #[test]
    fn remove_path_drops_the_matching_entry_only() {
        let recents = vec![
            RecentProject {
                path: "/a".into(),
                name: "a".into(),
                last_opened_at: 1,
            },
            RecentProject {
                path: "/b".into(),
                name: "b".into(),
                last_opened_at: 2,
            },
        ];

        let recents = remove_path(recents, "/a");

        assert_eq!(recents.len(), 1);
        assert_eq!(recents[0].path, "/b");
    }
}

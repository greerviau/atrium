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

/// Moves `path` to the front (inserting it if new), dedupes by path, and
/// caps the result at `MAX_RECENTS`.
fn upsert(mut recents: Vec<RecentProject>, path: &str, opened_at: u64) -> Vec<RecentProject> {
    recents.retain(|r| r.path != path);
    recents.insert(
        0,
        RecentProject {
            path: path.to_string(),
            name: folder_name(path),
            last_opened_at: opened_at,
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

/// Removes every entry from the recents list.
pub fn clear_recents<R: Runtime>(app: &AppHandle<R>) -> Result<(), AppError> {
    write_store(app, &clear(read_store(app)?))
}

/// Empties a recents list unconditionally.
fn clear(_recents: Vec<RecentProject>) -> Vec<RecentProject> {
    Vec::new()
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

    #[test]
    fn clear_empties_a_populated_list() {
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

        assert!(clear(recents).is_empty());
    }

    #[test]
    fn clear_is_a_no_op_on_an_already_empty_list() {
        assert!(clear(vec![]).is_empty());
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

use crate::error::AppError;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[cfg(unix)]
type StableFileIdentity = std::sync::Arc<same_file::Handle>;

#[cfg(windows)]
#[derive(Clone, PartialEq, Eq)]
struct StableFileIdentity {
    file_id: file_id::FileId,
    created: Option<std::time::SystemTime>,
}

#[cfg(unix)]
fn stable_file_identity(path: &Path) -> std::io::Result<StableFileIdentity> {
    same_file::Handle::from_path(path).map(std::sync::Arc::new)
}

#[cfg(windows)]
fn stable_file_identity(path: &Path) -> std::io::Result<StableFileIdentity> {
    let metadata = std::fs::metadata(path)?;
    Ok(StableFileIdentity {
        file_id: file_id::get_file_id(path)?,
        created: metadata.created().ok(),
    })
}

/// Identity captured at grant time and re-verified on every later access.
/// **The invariant this type exists to enforce: a granted key authorizes
/// exactly one filesystem identity at exactly one canonical path, and any
/// divergence in EITHER field revokes it.** Comparing only the platform file
/// ID (device/inode on Unix, volume/file ID on Windows) is not enough; a
/// directory-symlink swap combined with a hard link can hold that ID stable
/// while changing what the path resolves to (§4.4c); comparing
/// `canonical_path` too closes that. Unix identity handles remain open for
/// the grant's lifetime, preventing ID reuse. Windows combines its 128-bit
/// file ID with creation time without retaining a handle that would block an
/// atomic replacement.
#[derive(Clone)]
struct GrantedIdentity {
    canonical_path: PathBuf,
    file_identity: StableFileIdentity,
    /// The granted file's *parent directory's* own identity at the moment
    /// this was captured (grant time, or the most recent legitimate
    /// refresh). Exists solely so `resolve_granted_for_write`'s
    /// deleted-file recreation arm can confirm the parent it's about to
    /// recreate into is still the exact directory that was granted, not
    /// wherever a swapped symlink now resolves it to (MF-B, round 2).
    parent_identity: StableFileIdentity,
}

/// Per-workspace-instance allowlist of externally-opened files, created
/// only via `grant()` — reachable, in the whole app, only from
/// `LocalWorkspace::grant_external_file`, itself reachable only from the
/// `fs_grant_external_file` command, itself gated on a real, backend-
/// observed OS drop (§4.9). Keyed by the *exact* literal path string the
/// grant was created for — never a prefix, never a directory (§4.4).
/// Every other command (`create_file`, `create_dir`, `rename`, `delete`,
/// `list_dir`, `import_external`'s destination, `fs_resolve_candidates`)
/// never consults this and is completely unaffected by its existence
/// (§4.7).
pub struct ExternalGrants {
    grants: Mutex<HashMap<String, GrantedIdentity>>,
}

impl ExternalGrants {
    pub fn new() -> Self {
        Self {
            grants: Mutex::new(HashMap::new()),
        }
    }

    /// Authorizes `path` — already confirmed by the caller to resolve
    /// *outside* the workspace root — for direct read/write access at its
    /// real, current location. Rejects anything that isn't currently an
    /// existing regular file: no directories, no dangling symlinks, no
    /// devices/FIFOs/sockets.
    pub async fn grant(&self, path: &str) -> Result<(), AppError> {
        let identity = capture_identity(path).await?;
        self.grants
            .lock()
            .unwrap()
            .insert(path.to_string(), identity);
        Ok(())
    }

    /// Read authorization: `Ok(Some(realpath))` if `path` was granted and
    /// its current platform file ID and `canonical_path` both match what was
    /// recorded at grant time. `Ok(None)` if
    /// `path` was never granted at all (the fast, common path for every
    /// ordinary in-workspace read, which never touches the filesystem
    /// here). `Err(ExternalFileChanged)` otherwise, including if the file
    /// is now missing — a read has nothing to recover; recreation is a
    /// write-only concept (`resolve_granted_for_write`, MF2).
    pub async fn resolve_granted(&self, path: &str) -> Result<Option<PathBuf>, AppError> {
        let recorded = { self.grants.lock().unwrap().get(path).cloned() };
        let Some(recorded) = recorded else {
            return Ok(None);
        };
        match capture_identity(path).await {
            Ok(current) if identity_matches(&current, &recorded) => {
                Ok(Some(recorded.canonical_path))
            }
            _ => Err(AppError::ExternalFileChanged(path.to_string())),
        }
    }

    /// Write authorization: identical to `resolve_granted`, except a
    /// granted key whose file has since **genuinely disappeared**
    /// authorizes the write to its last recorded canonical location
    /// instead of failing — recreating it there, mirroring
    /// `resolve_within_root`'s own existing deleted-file-recovery behavior
    /// for an in-workspace save. Without this, a dirty external tab whose
    /// file was deleted underneath it becomes permanently unsavable, with
    /// no recovery (re-dragging can't help — there's no file left to drag).
    ///
    /// Two things this arm must get right after round 2's re-attack of
    /// round 1's own fix (MF-B), both present below: (1) it must trigger
    /// **only** on "genuinely not found," never on any other failure —
    /// `capture_identity` also fails when the path resolves to something
    /// that is no longer a regular file (a directory, a FIFO), and that is
    /// not "gone," it's "replaced by something this design must refuse to
    /// touch." (2) even a genuine not-found must not blindly hand
    /// `atomic_write` a frozen grant-time path string for it to re-resolve
    /// live — `atomic_write`'s own contract is that its target is already
    /// resolved past any symlink by the caller, and a frozen string is not
    /// that if the parent directory has since been swapped. `verify_parent`
    /// closes this by re-confirming the parent's own identity, live,
    /// before authorizing the recreate.
    pub async fn resolve_granted_for_write(&self, path: &str) -> Result<Option<PathBuf>, AppError> {
        let recorded = { self.grants.lock().unwrap().get(path).cloned() };
        let Some(recorded) = recorded else {
            return Ok(None);
        };
        match capture_identity(path).await {
            Ok(current) if identity_matches(&current, &recorded) => {
                Ok(Some(recorded.canonical_path))
            }
            Ok(_) => Err(AppError::ExternalFileChanged(path.to_string())), // exists, but is a different file now
            Err(AppError::NotFound(_)) if verify_parent(&recorded).await => {
                Ok(Some(recorded.canonical_path)) // genuinely gone, and its real parent is unmoved — recreate there
            }
            Err(_) => Err(AppError::ExternalFileChanged(path.to_string())), // not found but the parent moved too, or not a regular file — never a silent recreate
        }
    }

    /// Re-captures identity for `path` if (and only if) it is already
    /// granted — called after every successful write, granted or not (a
    /// no-op map-miss for an ordinary in-workspace write, so this is safe
    /// to call unconditionally). `atomic_write`'s rename(2)-based save
    /// always replaces the target's inode — this is not incidental, it's
    /// why `atomic_write` has to copy the old file's permissions onto the
    /// temp file before renaming. Without a refresh at all, the identity
    /// recorded at grant time goes stale after the very first save through
    /// a granted path, and every later read or write of that same tab is
    /// wrongly rejected — a file editable exactly once (MF1).
    ///
    /// **The refresh itself must not accept a moved canonical path** — this
    /// is round 2's finding (MF-A) against round 1's first version of this
    /// function, which re-canonicalized and inserted unconditionally: an
    /// attacker who swaps the file's parent for a symlink in the window
    /// between `atomic_write` returning and this function running would
    /// have had the grant **permanently** re-pointed at whatever the
    /// symlink resolves to, re-attempted on every single save (not a
    /// one-shot race — a race retried indefinitely until won). The guard
    /// below closes it: only the platform file ID may legitimately drift
    /// between one call and the next. That is why this function exists:
    /// a legitimate `atomic_write` save changes only the file identity, never the
    /// canonical path); a `canonical_path` mismatch means the location
    /// moved, and the old, still-correct identity is left in place so the
    /// very next access (via `resolve_granted`/`resolve_granted_for_write`)
    /// fails closed instead of silently succeeding against the new
    /// location. The compare (`grants.get(path)`, re-read fresh) and the
    /// insert are one critical section with no `.await` inside it — round 3
    /// re-attacked this specifically (racing the swap into the window
    /// between the read and the insert) and confirmed the lock genuinely
    /// closes it rather than merely narrowing it: nothing can observe or
    /// act on a stale `recorded` between the compare and the write, so
    /// `canonical_path` provably cannot change here, only the file ID can.
    ///
    /// (`canonical_path` immutability is an invariant of *this function*,
    /// not of the underlying map — `grant()` itself re-points a key
    /// unconditionally on every call, which is required, not a gap: it's
    /// what makes "re-drag the file to refresh an expired grant" work at
    /// all, §4.9, and `grant()` is only ever reachable through
    /// `require_recent_external_open`'s 10-second real-drop-or-OS-open gate, so re-granting is
    /// no easier for an attacker than the original grant was.)
    pub async fn refresh_if_granted(&self, path: &str) {
        // Cheap bail-out for the overwhelmingly common case (an ordinary
        // in-workspace write) BEFORE paying `capture_identity`'s
        // canonicalize + two `metadata` calls — this is a performance-only
        // addition; the actual security-relevant compare-and-insert below
        // is unchanged and must stay exactly as it is, in one lock scope,
        // or MF-A's fix regresses.
        if !self.grants.lock().unwrap().contains_key(path) {
            return;
        }
        let Ok(identity) = capture_identity(path).await else {
            return;
        };
        let mut grants = self.grants.lock().unwrap();
        if let Some(recorded) = grants.get(path) {
            if identity.canonical_path != recorded.canonical_path {
                return; // location moved since the write this call is refreshing after — fail closed, not re-point
            }
            grants.insert(path.to_string(), identity);
        }
    }

    /// The directories of every currently-granted file, for the read-only
    /// image-asset extension (§4.8, MF6) and for the change-detection
    /// watcher (§5.2, MF5) — both need "which directories currently matter"
    /// without either duplicating `ExternalGrants`' own bookkeeping.
    fn granted_directories(&self) -> Vec<PathBuf> {
        self.grants
            .lock()
            .unwrap()
            .values()
            .filter_map(|g| g.canonical_path.parent().map(Path::to_path_buf))
            .collect()
    }

    /// The original grant key (the literal path the frontend uses as this
    /// tab's identity) for a given *canonical* path, if any — the reverse
    /// of the forward map, used by the change-detection watcher (§5.2) to
    /// translate an observed real filesystem path back into the string
    /// `Tab.path` already uses, without which `reconcileExternalChange`'s
    /// exact `t.path === path` lookup would silently never match.
    pub fn key_for_canonical_path(&self, canonical: &Path) -> Option<String> {
        self.grants
            .lock()
            .unwrap()
            .iter()
            .find(|(_, identity)| identity.canonical_path == canonical)
            .map(|(key, _)| key.clone())
    }

    /// The read-only image-asset extension (§4.8, MF6): whether
    /// `candidate` (already resolved to an absolute path by the frontend,
    /// same as every other `atriumasset://` request) sits at or under the
    /// directory of some currently-granted file, AND has an image
    /// extension. Deliberately broader than the exact-key rule
    /// `resolve_granted`/`resolve_granted_for_write` enforce for
    /// `read_file`/`write_file` — see §4.8 for why that's a separate,
    /// narrower-*privilege* decision, not a weakening of this type's own
    /// per-path rule — but round 2 found the first version of this
    /// function (subtree containment alone, no type restriction, no
    /// minimum-depth floor) authorized far more than that privilege was
    /// meant to cover (MF-C): dragging in a markdown file that happens to
    /// sit directly in a shallow directory made everything below it —
    /// arbitrary file types, arbitrarily deep — resolvable through this
    /// protocol. The extension allowlist and the depth floor below both
    /// exist specifically to bound that back down to image files beneath a
    /// granted file's own directory, which is the only thing this mechanism
    /// serves to the renderer.
    pub async fn resolve_asset(&self, candidate: &str) -> Option<PathBuf> {
        // Canonicalize FIRST, then take the extension from the RESOLVED
        // path — never from `candidate` itself. Checking the raw string's
        // extension and then serving the canonicalized path are two
        // different paths whenever `candidate` is a symlink: a symlink
        // *named* `logo.png` pointing at `~/.ssh/id_rsa` would pass an
        // extension check run on the string `"logo.png"` and then serve
        // the key's actual bytes — the ordering below closes that (round 3
        // review's MF-C.1, demonstrated exactly this way against the
        // pre-fix version). `Path::extension()` correctly returns `None`
        // for extensionless/dotfile names like `id_rsa` or `.aws_credentials`
        // regardless of which path they're read from.
        let canonical_candidate = tokio::fs::canonicalize(candidate).await.ok()?;
        let extension = canonical_candidate
            .extension()?
            .to_str()?
            .to_ascii_lowercase();
        if !ASSET_EXTENSION_ALLOWLIST.contains(&extension.as_str()) {
            return None;
        }
        asset_root_permits(&canonical_candidate, &self.granted_directories())
            .then_some(canonical_candidate)
    }
}

/// Whether `candidate` sits at or under one of `granted_dirs`, subject to the
/// minimum-depth floor (`MIN_ASSET_ROOT_COMPONENTS`) that refuses a
/// degenerate root (e.g. a grant sitting directly at `/`). Factored out of
/// `resolve_asset` — its only caller — purely so the floor itself can be
/// exercised directly in a test: constructing a real grant at the actual
/// filesystem root requires privileges the test process doesn't have, so a
/// test going through `resolve_asset` end-to-end can never reach that
/// branch. This function is pure and filesystem-independent, so a test can
/// hand it a synthetic `PathBuf::from("/")` directly.
fn asset_root_permits(candidate: &Path, granted_dirs: &[PathBuf]) -> bool {
    granted_dirs
        .iter()
        .filter(|dir| dir.components().count() > MIN_ASSET_ROOT_COMPONENTS)
        .any(|dir| candidate.starts_with(dir))
}

/// Extensions the image pane and rendered Markdown can request through the
/// asset protocol. Deliberately narrow: `resolve_asset` permits only image
/// files below a granted file's directory, never general reads from that
/// subtree (MF-C).
const ASSET_EXTENSION_ALLOWLIST: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "ico",
];

/// A granted directory must have more path components than this to be used
/// as an asset-resolution root — refuses the degenerate case where a
/// granted file sits directly at a filesystem root (`/notes.md` →
/// `parent()` is `/`) and the "subtree" would otherwise be the entire
/// filesystem (MF-C, N3). `1` rejects exactly `/` (a single `RootDir`
/// component) while allowing any real subdirectory.
const MIN_ASSET_ROOT_COMPONENTS: usize = 1;

fn identity_matches(current: &GrantedIdentity, recorded: &GrantedIdentity) -> bool {
    current.file_identity == recorded.file_identity
        && current.canonical_path == recorded.canonical_path
}

/// Re-verifies, live, that a granted file's recorded parent directory is
/// still the exact same directory it was at grant/refresh time — required
/// before `resolve_granted_for_write` recreates a genuinely-deleted granted
/// file there (MF-B): a frozen `canonical_path` string alone is not enough,
/// since `atomic_write` re-resolves it against whatever the filesystem
/// looks like *now*, and a parent swapped for a symlink since the grant was
/// made would otherwise silently redirect the recreated file into it. Uses
/// `tokio::fs::metadata` (follows symlinks) on the parent's own path
/// string, so a symlink-swapped parent resolves to the *attacker's*
/// directory identity here, which will not match `recorded`'s.
///
/// **What this function does *not* cover, stated precisely so it's never
/// misattributed**: if the granted *file itself* (not its parent) is
/// replaced by a dangling symlink to some secret, the parent is genuinely
/// unchanged, so `verify_parent` correctly returns `true` and the recreate
/// is authorized — this function has nothing to say about that case. What
/// actually stops the write from landing on the secret is `atomic_write`'s
/// own `rename(2)`-based persist, which never follows the final path
/// component and so replaces the dangling symlink itself rather than
/// writing through it (round 3 re-attack, confirmed against `tempfile`
/// 3.27.0's `persist`). That protection is load-bearing for this specific
/// arm and lives entirely outside this function — worth remembering if
/// `atomic_write` is ever refactored to an `open`-then-write form instead
/// of a rename, since that would need to re-derive an equivalent guarantee.
async fn verify_parent(recorded: &GrantedIdentity) -> bool {
    let Some(parent) = recorded.canonical_path.parent() else {
        return false;
    };
    stable_file_identity(parent)
        .map(|current| current == recorded.parent_identity)
        .unwrap_or(false)
}

async fn capture_identity(path: &str) -> Result<GrantedIdentity, AppError> {
    let canonical_path = tokio::fs::canonicalize(path)
        .await
        .map_err(|e| crate::workspace::local::map_io_err(e, path))?;
    let metadata = tokio::fs::metadata(&canonical_path)
        .await
        .map_err(|e| crate::workspace::local::map_io_err(e, path))?;
    if !metadata.is_file() {
        return Err(AppError::InvalidPath(format!(
            "'{path}' is not a regular file"
        )));
    }
    let parent = canonical_path
        .parent()
        .ok_or_else(|| AppError::InvalidPath(format!("'{path}' has no parent directory")))?;
    let file_identity = stable_file_identity(&canonical_path)
        .map_err(|e| crate::workspace::local::map_io_err(e, path))?;
    let parent_identity =
        stable_file_identity(parent).map_err(|e| crate::workspace::local::map_io_err(e, path))?;
    Ok(GrantedIdentity {
        canonical_path,
        file_identity,
        parent_identity,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, contents: &str) {
        std::fs::write(path, contents).unwrap();
    }

    #[tokio::test]
    async fn grant_then_resolve_granted_on_the_same_path_succeeds() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("notes.txt");
        write(&file, "hello");
        let grants = ExternalGrants::new();

        grants.grant(file.to_str().unwrap()).await.unwrap();
        let resolved = grants
            .resolve_granted(file.to_str().unwrap())
            .await
            .unwrap();

        assert_eq!(resolved, Some(std::fs::canonicalize(&file).unwrap()));
    }

    #[tokio::test]
    async fn resolve_granted_on_a_never_granted_path_is_ok_none_even_if_nonexistent() {
        let grants = ExternalGrants::new();
        let resolved = grants
            .resolve_granted("/definitely/does/not/exist.txt")
            .await
            .unwrap();
        assert_eq!(resolved, None);
    }

    #[tokio::test]
    async fn granting_a_directory_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let grants = ExternalGrants::new();
        let err = grants
            .grant(dir.path().to_str().unwrap())
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::InvalidPath(_)));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn granting_a_dangling_symlink_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let link = dir.path().join("dangling");
        std::os::unix::fs::symlink(dir.path().join("nowhere"), &link).unwrap();
        let grants = ExternalGrants::new();
        let err = grants.grant(link.to_str().unwrap()).await.unwrap_err();
        assert!(!err.to_string().is_empty()); // NotFound or InvalidPath, either fails closed
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn grant_a_symlink_then_swap_its_target_file_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        let target_a = dir.path().join("a.txt");
        let target_b = dir.path().join("b.txt");
        write(&target_a, "a");
        write(&target_b, "b");
        let link = dir.path().join("link.txt");
        std::os::unix::fs::symlink(&target_a, &link).unwrap();

        let grants = ExternalGrants::new();
        grants.grant(link.to_str().unwrap()).await.unwrap();

        std::fs::remove_file(&link).unwrap();
        std::os::unix::fs::symlink(&target_b, &link).unwrap();

        let err = grants
            .resolve_granted(link.to_str().unwrap())
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::ExternalFileChanged(_)));
    }

    #[tokio::test]
    async fn grant_then_delete_and_recreate_a_plain_new_file_at_the_same_path_fails_closed_for_read(
    ) {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("notes.txt");
        write(&file, "original");
        let grants = ExternalGrants::new();
        grants.grant(file.to_str().unwrap()).await.unwrap();

        std::fs::remove_file(&file).unwrap();
        write(&file, "different inode, same name");

        let err = grants
            .resolve_granted(file.to_str().unwrap())
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::ExternalFileChanged(_)));
    }

    #[tokio::test]
    async fn springboard_to_a_sibling_path_is_not_authorized() {
        let dir = tempfile::tempdir().unwrap();
        let notes = dir.path().join("notes.txt");
        let other = dir.path().join("other.txt");
        write(&notes, "notes");
        write(&other, "other");
        let grants = ExternalGrants::new();
        grants.grant(notes.to_str().unwrap()).await.unwrap();

        let resolved = grants
            .resolve_granted(other.to_str().unwrap())
            .await
            .unwrap();
        assert_eq!(resolved, None);
    }

    #[tokio::test]
    async fn springboard_via_dot_dot_is_a_different_string_and_misses_the_map() {
        let dir = tempfile::tempdir().unwrap();
        let notes = dir.path().join("notes.txt");
        write(&notes, "notes");
        let grants = ExternalGrants::new();
        grants.grant(notes.to_str().unwrap()).await.unwrap();

        let traversal = format!("{}/../secret.txt", notes.to_str().unwrap());
        let resolved = grants.resolve_granted(&traversal).await.unwrap();
        assert_eq!(resolved, None);
    }

    // MF1 — write, then write again, then read.
    #[tokio::test]
    async fn refresh_if_granted_keeps_a_granted_path_valid_across_repeated_writes() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("notes.txt");
        write(&file, "A");
        let grants = ExternalGrants::new();
        let path = file.to_str().unwrap();
        grants.grant(path).await.unwrap();

        // Simulate atomic_write's rename-onto-target for the first save:
        // this changes the inode at the same canonical path.
        let tmp = dir.path().join(".tmp1");
        write(&tmp, "B");
        std::fs::rename(&tmp, &file).unwrap();
        grants.refresh_if_granted(path).await;
        assert!(grants.resolve_granted(path).await.unwrap().is_some());

        let tmp2 = dir.path().join(".tmp2");
        write(&tmp2, "C");
        std::fs::rename(&tmp2, &file).unwrap();
        grants.refresh_if_granted(path).await;
        assert!(grants.resolve_granted(path).await.unwrap().is_some());
    }

    // MF2 — write after the granted file is deleted out from under the tab.
    #[tokio::test]
    async fn resolve_granted_for_write_recreates_a_genuinely_deleted_granted_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("notes.txt");
        write(&file, "original");
        let grants = ExternalGrants::new();
        let path = file.to_str().unwrap();
        grants.grant(path).await.unwrap();

        std::fs::remove_file(&file).unwrap();

        let resolved = grants.resolve_granted_for_write(path).await.unwrap();
        assert_eq!(
            resolved,
            Some(std::fs::canonicalize(dir.path()).unwrap().join("notes.txt"))
        );
    }

    // MF3 — the parent-symlink + hard-link redirect.
    #[cfg(unix)]
    #[tokio::test]
    async fn parent_symlink_plus_hard_link_redirect_fails_closed_and_does_not_write() {
        let base = tempfile::tempdir().unwrap();
        let real_a = base.path().join("a");
        let real_evil = base.path().join("evil");
        std::fs::create_dir(&real_a).unwrap();
        std::fs::create_dir(&real_evil).unwrap();

        let dir_link = base.path().join("dir");
        std::os::unix::fs::symlink(&real_a, &dir_link).unwrap();

        let notes_via_link = dir_link.join("notes.txt");
        write(&notes_via_link, "original");

        let grants = ExternalGrants::new();
        let key = notes_via_link.to_str().unwrap().to_string();
        grants.grant(&key).await.unwrap();

        // Attacker: replace `dir` with a symlink into `evil`, and hard-link
        // the original inode at `evil/notes.txt`.
        std::fs::remove_file(&dir_link).unwrap();
        std::os::unix::fs::symlink(&real_evil, &dir_link).unwrap();
        std::fs::hard_link(real_a.join("notes.txt"), real_evil.join("notes.txt")).unwrap();

        let err = grants.resolve_granted(&key).await.unwrap_err();
        assert!(matches!(err, AppError::ExternalFileChanged(_)));

        let write_err = grants.resolve_granted_for_write(&key).await.unwrap_err();
        assert!(matches!(write_err, AppError::ExternalFileChanged(_)));

        // Nothing was written to /a/dir/notes.txt (now resolving into evil).
        assert_eq!(
            std::fs::read_to_string(real_evil.join("notes.txt")).unwrap(),
            "original"
        );
    }

    // MF-A (round 2) — winning the post-write refresh race must not re-point the grant.
    #[cfg(unix)]
    #[tokio::test]
    async fn refresh_if_granted_rejects_a_swapped_parent_and_leaves_the_old_identity_intact() {
        let base = tempfile::tempdir().unwrap();
        let real_dir = base.path().join("dir");
        std::fs::create_dir(&real_dir).unwrap();
        let file = real_dir.join("notes.txt");
        write(&file, "A");

        let grants = ExternalGrants::new();
        let key = file.to_str().unwrap().to_string();
        grants.grant(&key).await.unwrap();

        // Sanity check: a normal write-then-refresh works.
        let tmp = real_dir.join(".tmp");
        write(&tmp, "B");
        std::fs::rename(&tmp, &file).unwrap();
        grants.refresh_if_granted(&key).await;
        assert!(grants.resolve_granted(&key).await.unwrap().is_some());

        // Simulate the race: swap the parent directory for a symlink to a
        // different directory containing a same-named file, in the window
        // between atomic_write returning and refresh_if_granted running.
        // The original `dir` (and the real file inside it, at its current
        // inode) is preserved intact by renaming it aside rather than
        // deleting it, so it can be restored byte-for-byte, inode-for-inode,
        // afterward.
        let evil_dir = base.path().join("evil");
        std::fs::create_dir(&evil_dir).unwrap();
        write(&evil_dir.join("notes.txt"), "attacker content");

        let real_dir_backup = base.path().join("dir_backup");
        std::fs::rename(&real_dir, &real_dir_backup).unwrap();
        std::os::unix::fs::symlink(&evil_dir, &real_dir).unwrap();

        grants.refresh_if_granted(&key).await;

        // The grant's recorded canonical_path must be unchanged: a call
        // against the now-swapped location fails closed.
        let resolved_swapped = grants.resolve_granted(&key).await;
        assert!(matches!(
            resolved_swapped,
            Err(AppError::ExternalFileChanged(_))
        ));

        // Restore the exact original directory (same inode, same file) and
        // confirm the grant still resolves there.
        std::fs::remove_file(&real_dir).unwrap(); // unlink the symlink, not its target
        std::fs::rename(&real_dir_backup, &real_dir).unwrap();
        assert!(grants.resolve_granted(&key).await.unwrap().is_some());
    }

    // MF-B (round 2) — the deleted-file recreate arm must not follow a swapped parent.
    #[cfg(unix)]
    #[tokio::test]
    async fn resolve_granted_for_write_does_not_follow_a_swapped_parent_into_recreating_there() {
        let base = tempfile::tempdir().unwrap();
        let real_dir = base.path().join("dir");
        std::fs::create_dir(&real_dir).unwrap();
        let file = real_dir.join("notes.txt");
        write(&file, "original");

        let grants = ExternalGrants::new();
        let key = file.to_str().unwrap().to_string();
        grants.grant(&key).await.unwrap();

        // Replace `dir` with a symlink to an empty `evil` directory.
        std::fs::remove_file(&file).unwrap();
        std::fs::remove_dir(&real_dir).unwrap();
        let evil_dir = base.path().join("evil");
        std::fs::create_dir(&evil_dir).unwrap();
        std::os::unix::fs::symlink(&evil_dir, &real_dir).unwrap();

        let err = grants.resolve_granted_for_write(&key).await.unwrap_err();
        assert!(matches!(err, AppError::ExternalFileChanged(_)));
        assert!(!evil_dir.join("notes.txt").exists());
    }

    #[tokio::test]
    async fn resolve_granted_for_write_does_not_recreate_when_the_granted_file_became_a_directory()
    {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("notes.txt");
        write(&file, "original");
        let grants = ExternalGrants::new();
        let key = file.to_str().unwrap().to_string();
        grants.grant(&key).await.unwrap();

        std::fs::remove_file(&file).unwrap();
        std::fs::create_dir(&file).unwrap();

        let err = grants.resolve_granted_for_write(&key).await.unwrap_err();
        assert!(matches!(err, AppError::ExternalFileChanged(_)));
    }

    // MF6/MF-C — asset resolution.
    #[tokio::test]
    async fn resolve_asset_authorizes_a_real_image_under_a_granted_directory() {
        let dir = tempfile::tempdir().unwrap();
        let md = dir.path().join("README.md");
        write(&md, "# hi");
        let img = dir.path().join("logo.png");
        write(&img, "png bytes");
        let grants = ExternalGrants::new();
        grants.grant(md.to_str().unwrap()).await.unwrap();

        let resolved = grants.resolve_asset(img.to_str().unwrap()).await;
        assert_eq!(resolved, Some(std::fs::canonicalize(&img).unwrap()));
    }

    #[tokio::test]
    async fn resolve_asset_authorizes_a_granted_ico_file_itself() {
        let dir = tempfile::tempdir().unwrap();
        let icon = dir.path().join("favicon.ico");
        write(&icon, "ico bytes");
        let grants = ExternalGrants::new();
        grants.grant(icon.to_str().unwrap()).await.unwrap();

        let resolved = grants.resolve_asset(icon.to_str().unwrap()).await;
        assert_eq!(resolved, Some(std::fs::canonicalize(&icon).unwrap()));
    }

    #[tokio::test]
    async fn resolve_asset_rejects_a_non_image_file_under_the_granted_directory() {
        // Deliberately given a real (non-allowlisted) extension rather than
        // being fully extensionless: an extensionless path already gets
        // rejected earlier by `canonical_candidate.extension()?` alone, so
        // that alone wouldn't exercise the allowlist's own `contains` check
        // — deleting the allowlist check entirely would leave this case
        // untouched and the test would stay green. A `.pem` extension does
        // reach the allowlist check, so this goes red if that check is
        // removed.
        let dir = tempfile::tempdir().unwrap();
        let md = dir.path().join("README.md");
        write(&md, "# hi");
        let secret = dir.path().join("id_rsa.pem");
        write(&secret, "-----BEGIN PRIVATE KEY-----");
        let grants = ExternalGrants::new();
        grants.grant(md.to_str().unwrap()).await.unwrap();

        let resolved = grants.resolve_asset(secret.to_str().unwrap()).await;
        assert_eq!(resolved, None);
    }

    #[tokio::test]
    async fn resolve_asset_rejects_an_image_under_a_different_non_granted_directory() {
        let granted_dir = tempfile::tempdir().unwrap();
        let other_dir = tempfile::tempdir().unwrap();
        let md = granted_dir.path().join("README.md");
        write(&md, "# hi");
        let img = other_dir.path().join("logo.png");
        write(&img, "png bytes");
        let grants = ExternalGrants::new();
        grants.grant(md.to_str().unwrap()).await.unwrap();

        let resolved = grants.resolve_asset(img.to_str().unwrap()).await;
        assert_eq!(resolved, None);
    }

    #[tokio::test]
    async fn resolve_asset_rejects_escaping_upward_via_dot_dot() {
        let base = tempfile::tempdir().unwrap();
        let granted_dir = base.path().join("granted");
        std::fs::create_dir(&granted_dir).unwrap();
        let md = granted_dir.join("README.md");
        write(&md, "# hi");
        let secret = base.path().join("secret.png");
        write(&secret, "png bytes");
        let grants = ExternalGrants::new();
        grants.grant(md.to_str().unwrap()).await.unwrap();

        let traversal = granted_dir.join("..").join("secret.png");
        let resolved = grants.resolve_asset(traversal.to_str().unwrap()).await;
        assert_eq!(resolved, None);
    }

    #[test]
    fn depth_floor_rejects_a_grant_sitting_directly_at_a_degenerate_root() {
        // A grant whose canonical parent is exactly "/" (one RootDir
        // component) must never be usable as an asset-resolution root.
        // Constructing this for real requires a file at the actual
        // filesystem root, which the test process has no permission to
        // create — so this calls `asset_root_permits`, the exact function
        // `resolve_asset` delegates this decision to, directly with a
        // synthetic root path. This is genuinely mutation-sensitive:
        // deleting the floor's `.filter(...)` inside `asset_root_permits`
        // makes `/` match via `starts_with` like any other directory (every
        // absolute path starts with `/`), which flips the first assertion
        // below from pass to fail.
        let degenerate_root = [PathBuf::from("/")];
        let real_subdirectory = [PathBuf::from("/home/alice")];
        let candidate = PathBuf::from("/home/alice/logo.png");

        assert!(
            !asset_root_permits(&candidate, &degenerate_root),
            "a grant sitting directly at the filesystem root must not authorize anything"
        );
        // Proves the assertion above actually exercises the floor rather
        // than being vacuously false for every input: the identical
        // candidate against a real subdirectory grant does match.
        assert!(asset_root_permits(&candidate, &real_subdirectory));
    }

    // Round 3's ordering bug: symlink named with an allowlisted extension
    // whose target has a real, non-allowlisted extension (standing in for
    // ~/.ssh/id_rsa). The target deliberately has an extension of its own
    // (`.pem`, not extensionless) so this test also exercises the allowlist
    // `contains` check itself, not just the canonicalize-before-extension
    // ordering: if the ordering fix regressed (extension taken from the raw
    // `logo.png` name instead of the resolved path), this would see the
    // allowlisted "png" and wrongly resolve; if the allowlist check itself
    // were deleted, the resolved "pem" extension would sail through
    // unfiltered and this would also wrongly resolve. Either mutation turns
    // this red.
    #[cfg(unix)]
    #[tokio::test]
    async fn resolve_asset_rejects_a_symlink_named_with_an_image_extension_pointing_at_a_secret() {
        let dir = tempfile::tempdir().unwrap();
        let md = dir.path().join("README.md");
        write(&md, "# hi");
        let secret = dir.path().join("id_rsa.pem");
        write(&secret, "-----BEGIN PRIVATE KEY-----\nsuper secret\n");
        let disguised_link = dir.path().join("logo.png");
        std::os::unix::fs::symlink(&secret, &disguised_link).unwrap();

        let grants = ExternalGrants::new();
        grants.grant(md.to_str().unwrap()).await.unwrap();

        let resolved = grants.resolve_asset(disguised_link.to_str().unwrap()).await;
        assert_eq!(
            resolved, None,
            "a symlink named *.png pointing at a non-image secret must not resolve"
        );

        // Critical: the secret's contents were never read/returned via this path.
        if let Some(path) = resolved {
            let contents = tokio::fs::read(&path).await.unwrap();
            assert!(!String::from_utf8_lossy(&contents).contains("super secret"));
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn resolve_asset_still_serves_a_legitimately_symlinked_image() {
        let dir = tempfile::tempdir().unwrap();
        let md = dir.path().join("README.md");
        write(&md, "# hi");
        let real_images_dir = dir.path().join("images");
        std::fs::create_dir(&real_images_dir).unwrap();
        let real_image = real_images_dir.join("real.png");
        write(&real_image, "real png bytes");
        let link = dir.path().join("link.png");
        std::os::unix::fs::symlink(&real_image, &link).unwrap();

        let grants = ExternalGrants::new();
        grants.grant(md.to_str().unwrap()).await.unwrap();

        let resolved = grants.resolve_asset(link.to_str().unwrap()).await;
        assert_eq!(resolved, Some(std::fs::canonicalize(&real_image).unwrap()));
    }
}

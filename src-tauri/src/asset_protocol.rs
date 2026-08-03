//! Handler for the `atriumasset://` custom URI scheme, registered on the
//! builder in `main.rs`. Replaces the built-in `asset://` protocol (whose own
//! scope mechanism can only ever grow, never revoke — see the plan this
//! implements) with one that looks up every currently-registered workspace
//! (the project's `"local"` workspace, tried first, then the never-torn-down
//! `"standalone"` workspace) and resolves the requested path through two
//! boundaries tried in order within each: in-root containment
//! (`Workspace::resolve_within_root`) first, then the granted-asset subtree
//! (`Workspace::resolve_external_asset` — canonicalize, image-extension
//! allowlist, granted-directory containment; see `external_grants.rs`'s
//! `resolve_asset`). Fail-closed throughout. The two workspaces' grants are
//! *not* revoked symmetrically: `"local"`'s grants die with its
//! `LocalWorkspace` instance at the next `workspace_set_root` call, since
//! nothing here is cached, while `"standalone"`'s live for the entire app
//! session (issue #325) and are never revoked by a workspace change at all.

use crate::state::AppState;
use crate::workspace::standalone::STANDALONE_WORKSPACE_ID;
use crate::workspace::Workspace;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::Manager;

/// A project's own workspace is always registered under this fixed id — see
/// `commands::workspace::workspace_set_root` and `LOCAL_WORKSPACE_ID` in
/// `src/lib/ipc/commands.ts`.
const LOCAL_WORKSPACE_ID: &str = "local";

/// Resolves `requested` against each workspace in order, trying the
/// containment boundary first and the external-grant fallback second WITHIN
/// each workspace before moving to the next — an in-root path in an earlier
/// workspace is never shadowed by a later workspace's own grants. Pure over
/// its inputs (no `AppHandle`/`AppState`), so it's directly testable with
/// real tempdirs and no live app, mirroring this codebase's
/// `recently_dropped`/`launch_open`'s `record`/`is_reserved_workspace_id`
/// convention for command-layer logic that would otherwise need a live app
/// to test.
async fn resolve_from_workspaces(
    workspaces: &[Arc<dyn Workspace>],
    requested: &str,
) -> Option<PathBuf> {
    for workspace in workspaces {
        if let Ok(path) = workspace.resolve_within_root(requested) {
            return Some(path);
        }
        if let Some(path) = workspace.resolve_external_asset(requested).await {
            return Some(path);
        }
    }
    None
}

/// Decodes a percent-encoded path the same way Tauri's own built-in
/// `asset://` handler does (`tauri::protocol::asset`, via the
/// `percent-encoding` crate). Hand-rolled here instead of depending on that
/// crate directly: it's only reachable transitively through `tauri`/`url`
/// and isn't re-exported by either, so using it would mean a new Cargo.toml
/// dependency. The frontend's `convertFileSrc` calls percent-encode the path
/// via `encodeURIComponent`, so this must undo exactly that or any
/// workspace/file path containing a space or non-ASCII character would fail
/// to resolve.
fn percent_decode(encoded: &str) -> String {
    let bytes = encoded.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && bytes[i + 1].is_ascii_hexdigit()
            && bytes[i + 2].is_ascii_hexdigit()
        {
            if let Ok(byte) = u8::from_str_radix(
                std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or_default(),
                16,
            ) {
                decoded.push(byte);
                i += 3;
                continue;
            }
        }
        decoded.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

fn empty_response(status: u16) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .body(Vec::new())
        .unwrap()
}

/// Resolves one `atriumasset://` request: 403 if no workspace is open (or
/// the requested path escapes the open workspace's root, including through a
/// symlink — `resolve_within_root` carries that check), 404 if the resolved
/// path can't be read, otherwise the file's bytes with a sniffed
/// `Content-Type`.
///
/// Deliberately simplified relative to the built-in asset handler: no HTTP
/// byte-range support and no `Access-Control-Allow-Origin` header — nothing
/// in this app streams or scrubs media (every use is a single static image
/// load via `<img src>`, which needs neither).
pub async fn resolve_atriumasset_request(
    app_handle: &tauri::AppHandle,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let requested = percent_decode(request.uri().path().strip_prefix('/').unwrap_or(""));

    let Some(state) = app_handle.try_state::<AppState>() else {
        return empty_response(403);
    };
    let workspaces: Vec<Arc<dyn Workspace>> = {
        let guard = state.workspaces.lock().unwrap();
        [LOCAL_WORKSPACE_ID, STANDALONE_WORKSPACE_ID]
            .iter()
            .filter_map(|id| guard.get(*id).cloned())
            .collect()
    };
    let Some(resolved) = resolve_from_workspaces(&workspaces, &requested).await else {
        return empty_response(403);
    };

    match tokio::fs::read(&resolved).await {
        Ok(bytes) => {
            let mime = tauri::utils::mime_type::MimeType::parse(&bytes, &requested);
            tauri::http::Response::builder()
                .header(tauri::http::header::CONTENT_TYPE, mime)
                .body(bytes)
                .unwrap()
        }
        Err(_) => empty_response(404),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::local::LocalWorkspace;
    use crate::workspace::standalone::StandaloneWorkspace;

    #[test]
    fn decoded_percent_encoded_traversal_is_still_rejected_by_resolve_within_root() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = LocalWorkspace::new("local".to_string(), dir.path().to_path_buf());

        let traversal = percent_decode("%2e%2e%2f%2e%2e%2fetc%2fpasswd");
        assert_eq!(traversal, "../../etc/passwd");
        assert!(workspace.resolve_within_root(&traversal).is_err());
    }

    #[test]
    fn decoded_percent_encoded_in_workspace_path_still_resolves() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("My Notes")).unwrap();
        std::fs::write(dir.path().join("My Notes/img.png"), b"png bytes").unwrap();
        let workspace = LocalWorkspace::new("local".to_string(), dir.path().to_path_buf());

        let decoded = percent_decode("My%20Notes/img.png");
        assert_eq!(decoded, "My Notes/img.png");
        assert!(workspace.resolve_within_root(&decoded).is_ok());
    }

    #[test]
    fn percent_decode_leaves_plain_ascii_untouched() {
        assert_eq!(percent_decode("plain/path.png"), "plain/path.png");
    }

    #[test]
    fn percent_decode_decodes_a_space() {
        assert_eq!(percent_decode("My%20Notes/img.png"), "My Notes/img.png");
    }

    #[test]
    fn percent_decode_decodes_multibyte_utf8_sequences() {
        // "café" percent-encoded per `encodeURIComponent`: the "é" is UTF-8
        // encoded as two bytes (0xC3 0xA9) before percent-escaping.
        assert_eq!(percent_decode("caf%C3%A9.png"), "café.png");
    }

    #[test]
    fn percent_decode_tolerates_a_trailing_lone_percent() {
        assert_eq!(percent_decode("weird%"), "weird%");
    }

    #[test]
    fn percent_decode_tolerates_invalid_hex_digits() {
        assert_eq!(percent_decode("bad%zzpath"), "bad%zzpath");
    }

    #[test]
    fn percent_decode_rejects_a_non_hex_digit_sign_disguised_as_hex() {
        // `u8::from_str_radix` accepts a leading `+`/`-` sign, which would
        // otherwise let `%+5` decode to byte `0x05` — not a valid percent
        // escape by the URI spec. The `is_ascii_hexdigit` guard rejects this
        // before it ever reaches `from_str_radix`.
        assert_eq!(percent_decode("weird%+5path"), "weird%+5path");
    }

    // Test 10 — `resolve_from_workspaces`, directly, with no `AppHandle`.
    #[tokio::test]
    async fn resolve_from_workspaces_resolves_an_in_root_local_path_without_needing_the_standalone_workspace_at_all(
    ) {
        let project = tempfile::tempdir().unwrap();
        std::fs::write(project.path().join("doc.txt"), b"hello").unwrap();
        let local: Arc<dyn Workspace> = Arc::new(LocalWorkspace::new(
            "local".to_string(),
            project.path().to_path_buf(),
        ));
        let standalone: Arc<dyn Workspace> = Arc::new(StandaloneWorkspace::new());

        let requested = project.path().join("doc.txt").to_string_lossy().to_string();
        let resolved = resolve_from_workspaces(&[local, standalone], &requested)
            .await
            .expect("in-root local path should resolve");
        assert_eq!(
            resolved,
            std::fs::canonicalize(project.path())
                .unwrap()
                .join("doc.txt")
        );
    }

    #[tokio::test]
    async fn resolve_from_workspaces_falls_back_to_a_path_granted_only_on_the_standalone_workspace()
    {
        let project = tempfile::tempdir().unwrap();
        let local: Arc<dyn Workspace> = Arc::new(LocalWorkspace::new(
            "local".to_string(),
            project.path().to_path_buf(),
        ));

        let assets = tempfile::tempdir().unwrap();
        let granted_doc = assets.path().join("note.md");
        std::fs::write(&granted_doc, b"# notes").unwrap();
        let sibling_image = assets.path().join("img.png");
        std::fs::write(&sibling_image, b"png bytes").unwrap();

        let standalone = StandaloneWorkspace::new();
        standalone
            .grant_external_file(granted_doc.to_str().unwrap())
            .await
            .unwrap();
        let standalone: Arc<dyn Workspace> = Arc::new(standalone);

        let requested = sibling_image.to_string_lossy().to_string();
        let resolved = resolve_from_workspaces(&[local, standalone], &requested)
            .await
            .expect("asset under the standalone grant's directory should resolve via the fallback");
        assert_eq!(resolved, std::fs::canonicalize(&sibling_image).unwrap());
    }

    #[tokio::test]
    async fn resolve_from_workspaces_returns_none_for_a_path_granted_on_neither_workspace() {
        let project = tempfile::tempdir().unwrap();
        let local: Arc<dyn Workspace> = Arc::new(LocalWorkspace::new(
            "local".to_string(),
            project.path().to_path_buf(),
        ));
        let standalone: Arc<dyn Workspace> = Arc::new(StandaloneWorkspace::new());

        let outside = tempfile::tempdir().unwrap();
        let ungranted = outside.path().join("secret.png");
        std::fs::write(&ungranted, b"png bytes").unwrap();

        let requested = ungranted.to_string_lossy().to_string();
        assert!(resolve_from_workspaces(&[local, standalone], &requested)
            .await
            .is_none());
    }

    // N4 — an in-root local path is never shadowed by a later workspace's
    // own grants: without this case, a bug that checked every workspace's
    // granted-asset subtree before any workspace's own containment would
    // still pass the three cases above.
    #[tokio::test]
    async fn resolve_from_workspaces_prefers_local_containment_over_a_standalone_grant_covering_the_same_path(
    ) {
        let project = tempfile::tempdir().unwrap();
        let in_root_image = project.path().join("img.png");
        std::fs::write(&in_root_image, b"local png bytes").unwrap();
        let granted_doc = project.path().join("note.md");
        std::fs::write(&granted_doc, b"# notes").unwrap();

        let local: Arc<dyn Workspace> = Arc::new(LocalWorkspace::new(
            "local".to_string(),
            project.path().to_path_buf(),
        ));

        let standalone = StandaloneWorkspace::new();
        standalone
            .grant_external_file(granted_doc.to_str().unwrap())
            .await
            .unwrap();
        let standalone: Arc<dyn Workspace> = Arc::new(standalone);

        let requested = in_root_image.to_string_lossy().to_string();
        let resolved = resolve_from_workspaces(&[local, standalone], &requested)
            .await
            .expect("in-root path should still resolve");
        assert_eq!(resolved, std::fs::canonicalize(&in_root_image).unwrap());
    }
}

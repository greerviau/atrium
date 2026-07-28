//! Handler for the `atriumasset://` custom URI scheme, registered on the
//! builder in `main.rs`. Replaces the built-in `asset://` protocol (whose own
//! scope mechanism can only ever grow, never revoke — see the plan this
//! implements) with one that looks up whichever workspace is *currently*
//! open at request time and resolves the requested path through the exact
//! same `Workspace::resolve_within_root` boundary every other file operation
//! already goes through: fail-closed, and revoked the instant the open
//! workspace changes, since nothing here is cached.

use crate::state::AppState;
use tauri::Manager;

/// The MVP only ever registers one workspace, under this fixed id — see
/// `commands::workspace::workspace_set_root` and `LOCAL_WORKSPACE_ID` in
/// `src/lib/ipc/commands.ts`.
const LOCAL_WORKSPACE_ID: &str = "local";

/// Decodes a percent-encoded path the same way Tauri's own built-in
/// `asset://` handler does (`tauri::protocol::asset`, via the
/// `percent-encoding` crate). Hand-rolled here instead of depending on that
/// crate directly: it's only reachable transitively through `tauri`/`url`
/// and isn't re-exported by either, so using it would mean a new Cargo.toml
/// dependency. `convertFileSrc` (the frontend's only caller) percent-encodes
/// the path via `encodeURIComponent`, so this must undo exactly that or any
/// workspace/file path containing a space or non-ASCII character would fail
/// to resolve.
fn percent_decode(encoded: &str) -> String {
    let bytes = encoded.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
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
    let requested = percent_decode(&request.uri().path()[1..]);

    let Some(state) = app_handle.try_state::<AppState>() else {
        return empty_response(403);
    };
    let workspace = state
        .workspaces
        .lock()
        .unwrap()
        .get(LOCAL_WORKSPACE_ID)
        .cloned();
    let Some(workspace) = workspace else {
        return empty_response(403);
    };

    let resolved = match workspace.resolve_within_root(&requested) {
        Ok(path) => path,
        Err(_) => return empty_response(403),
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
}

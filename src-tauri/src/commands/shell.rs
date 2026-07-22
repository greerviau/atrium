use crate::error::AppError;
use tauri_plugin_opener::OpenerExt;

/// Mirrors `prLinkRegex.ts` on the frontend. Re-checked here so this command
/// can't be used to open arbitrary URLs even if a compromised or buggy
/// frontend path called it with something else — the capability file scopes
/// `opener:allow-open-url` to `https://github.com/*` already, but that scope
/// is a glob, not a full URL-shape check, so this is a second, precise gate.
fn is_pr_url(url: &str) -> bool {
    let Some(rest) = url
        .strip_prefix("https://github.com/")
        .or_else(|| url.strip_prefix("http://github.com/"))
    else {
        return false;
    };
    let parts: Vec<&str> = rest.split('/').collect();
    matches!(parts.as_slice(), [owner, repo, "pull", n]
        if !owner.is_empty() && !repo.is_empty() && !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
}

#[tauri::command]
pub fn shell_open_external(app: tauri::AppHandle, url: String) -> Result<(), AppError> {
    if !is_pr_url(&url) {
        return Err(AppError::InvalidPath(format!(
            "refusing to open non-PR URL: {url}"
        )));
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| AppError::Other(format!("failed to open URL: {e}")))
}

/// Any `http(s)://` URL — the shape a rendered markdown link's `href` is
/// already guaranteed to have by the time it reaches this command
/// (`handleLinkClick` in `widgets.ts` only calls `openExternalLink` when
/// `/^https?:\/\//` already matched), re-checked here as the same kind of
/// second, precise gate `is_pr_url` is for `shell_open_external` — so this
/// command can't be used to launch a non-web scheme even if a compromised
/// or buggy frontend path called it with something else.
fn is_web_url(url: &str) -> bool {
    url.starts_with("https://") || url.starts_with("http://")
}

#[tauri::command]
pub fn open_external_link(app: tauri::AppHandle, url: String) -> Result<(), AppError> {
    if !is_web_url(&url) {
        return Err(AppError::InvalidPath(format!(
            "refusing to open non-http(s) URL: {url}"
        )));
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| AppError::Other(format!("failed to open URL: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_valid_pr_urls() {
        assert!(is_pr_url("https://github.com/owner/repo/pull/123"));
    }

    #[test]
    fn rejects_non_pr_urls() {
        assert!(!is_pr_url("https://github.com/owner/repo"));
        assert!(!is_pr_url("https://evil.com/pull/1"));
        assert!(!is_pr_url("https://github.com/owner/repo/issues/1"));
        assert!(!is_pr_url("file:///etc/passwd"));
    }

    #[test]
    fn accepts_valid_web_urls() {
        assert!(is_web_url("https://example.com"));
        assert!(is_web_url("http://example.com"));
    }

    #[test]
    fn rejects_non_web_urls() {
        assert!(!is_web_url("file:///etc/passwd"));
        assert!(!is_web_url("javascript:alert(1)"));
        assert!(!is_web_url("not a url"));
    }
}

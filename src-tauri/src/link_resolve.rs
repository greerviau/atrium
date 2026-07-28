use serde::Deserialize;
use std::path::{Path, PathBuf};

/// One candidate substring the frontend's file-path link provider matched in
/// visible terminal output, plus the shell's cwd to resolve it against.
/// `cwd_hint` is kept live from the frontend, sourced from the backend's own
/// polled title events (`pty_manager.rs`'s `TITLE_POLL_INTERVAL`), so it can
/// lag the shell's actual cwd by up to one poll tick after a `cd`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathCandidate {
    pub raw: String,
    pub cwd_hint: String,
}

/// Resolves the user's home directory from `$HOME` (unix) or `%USERPROFILE%`
/// (Windows) for `~/`-expansion. A `dirs`/`home` crate would normally own
/// this, but pulling one in for a single env-var read isn't worth a new
/// dependency.
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// Joins `home` with the remainder of a `~/`-prefixed path. Kept separate
/// from `home_dir()` and pure (no env access) so it's unit-testable without
/// touching process-global environment state. Note that `~` here expands
/// against the *app process's* `HOME`, not the pty shell's — if a shell's own
/// rc reassigns `HOME`, a `~` it printed and the resolver's expansion of `~`
/// can diverge. Rare, and not worth engineering around.
fn expand_tilde(path_part: &str, home: &Path) -> Option<PathBuf> {
    path_part.strip_prefix("~/").map(|rest| home.join(rest))
}

/// Strips a trailing `:<line>` or `:<line>:<col>` suffix (as produced by the
/// terminal link regex) before checking the filesystem, since that suffix is
/// never part of the actual path.
fn strip_line_col(raw: &str) -> &str {
    let mut end = raw.len();
    let mut parts_stripped = 0;
    for _ in 0..2 {
        if let Some(colon) = raw[..end].rfind(':') {
            if raw[colon + 1..end].chars().all(|c| c.is_ascii_digit()) && colon + 1 < end {
                end = colon;
                parts_stripped += 1;
                continue;
            }
        }
        break;
    }
    if parts_stripped > 0 {
        &raw[..end]
    } else {
        raw
    }
}

/// Resolves one candidate to an absolute path, or `None` if it doesn't
/// resolve to a real file/directory under any of: (0) `~/`-expanded, (1)
/// absolute, (2) relative to the shell's cwd, (3) relative to the workspace
/// root.
pub fn resolve_candidate(candidate: &PathCandidate, workspace_root: &str) -> Option<String> {
    resolve_candidate_with_home(candidate, workspace_root, home_dir().as_deref())
}

fn resolve_candidate_with_home(
    candidate: &PathCandidate,
    workspace_root: &str,
    home: Option<&Path>,
) -> Option<String> {
    let path_part = strip_line_col(&candidate.raw);

    let attempts: Vec<PathBuf> =
        if let Some(expanded) = home.and_then(|home| expand_tilde(path_part, home)) {
            vec![expanded]
        } else {
            let candidate_path = Path::new(path_part);
            if candidate_path.is_absolute() {
                vec![candidate_path.to_path_buf()]
            } else {
                vec![
                    Path::new(&candidate.cwd_hint).join(candidate_path),
                    Path::new(workspace_root).join(candidate_path),
                ]
            }
        };

    let resolved = attempts.into_iter().find(|p| p.exists())?;

    // Canonicalizing is only a valid containment check because `resolved` is
    // confirmed to exist by the `.exists()` filter above: canonicalize
    // dereferences every symlink component (like `LocalWorkspace`'s own
    // containment walk in `resolve_within_root_impl`), but for a path with a
    // not-yet-existing component it would simply fail instead of resolving
    // the existing prefix. If `resolve_candidate` is ever changed to offer
    // candidates that might not exist, this check needs to change with it.
    let real_root = std::fs::canonicalize(workspace_root).ok()?;
    let real_resolved = std::fs::canonicalize(&resolved).ok()?;
    if !real_resolved.starts_with(&real_root) {
        return None;
    }

    Some(resolved.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_line_and_col_suffix() {
        assert_eq!(strip_line_col("src/main.rs:42:7"), "src/main.rs");
        assert_eq!(strip_line_col("src/main.rs:42"), "src/main.rs");
        assert_eq!(strip_line_col("src/main.rs"), "src/main.rs");
    }

    #[test]
    fn resolves_relative_to_cwd_hint() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("sub");
        std::fs::create_dir(&sub).unwrap();
        std::fs::write(sub.join("note.md"), "hi").unwrap();
        let candidate = PathCandidate {
            raw: "note.md".to_string(),
            cwd_hint: sub.to_string_lossy().to_string(),
        };
        let resolved = resolve_candidate(&candidate, dir.path().to_string_lossy().as_ref());
        assert!(resolved.is_some());
    }

    #[test]
    fn returns_none_for_nonexistent_path() {
        let candidate = PathCandidate {
            raw: "definitely/does/not/exist.rs".to_string(),
            cwd_hint: "/tmp".to_string(),
        };
        assert_eq!(resolve_candidate(&candidate, "/tmp"), None);
    }

    #[test]
    fn rejects_absolute_path_outside_workspace_root() {
        let workspace_root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let outside_file = outside.path().join("secret.txt");
        std::fs::write(&outside_file, "hi").unwrap();

        let candidate = PathCandidate {
            raw: outside_file.to_string_lossy().to_string(),
            cwd_hint: workspace_root.path().to_string_lossy().to_string(),
        };
        let resolved =
            resolve_candidate(&candidate, workspace_root.path().to_string_lossy().as_ref());
        assert_eq!(resolved, None);
    }

    #[test]
    fn accepts_absolute_path_inside_workspace_root() {
        let workspace_root = tempfile::tempdir().unwrap();
        let inside_file = workspace_root.path().join("inside.txt");
        std::fs::write(&inside_file, "hi").unwrap();

        let candidate = PathCandidate {
            raw: inside_file.to_string_lossy().to_string(),
            cwd_hint: workspace_root.path().to_string_lossy().to_string(),
        };
        let resolved =
            resolve_candidate(&candidate, workspace_root.path().to_string_lossy().as_ref());
        assert!(resolved.is_some());
    }

    #[test]
    fn rejects_relative_path_that_escapes_through_symlink() {
        let workspace_root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let outside_file = outside.path().join("secret.txt");
        std::fs::write(&outside_file, "hi").unwrap();

        let link_path = workspace_root.path().join("escape-link");
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path(), &link_path).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(outside.path(), &link_path).unwrap();

        let candidate = PathCandidate {
            raw: "escape-link/secret.txt".to_string(),
            cwd_hint: workspace_root.path().to_string_lossy().to_string(),
        };
        let resolved =
            resolve_candidate(&candidate, workspace_root.path().to_string_lossy().as_ref());
        assert_eq!(resolved, None);
    }

    #[test]
    fn accepts_relative_path_through_symlink_that_stays_inside_root() {
        let workspace_root = tempfile::tempdir().unwrap();
        let real_dir = workspace_root.path().join("real");
        std::fs::create_dir(&real_dir).unwrap();
        let real_file = real_dir.join("inside.txt");
        std::fs::write(&real_file, "hi").unwrap();

        let link_path = workspace_root.path().join("inside-link");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real_dir, &link_path).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(&real_dir, &link_path).unwrap();

        let candidate = PathCandidate {
            raw: "inside-link/inside.txt".to_string(),
            cwd_hint: workspace_root.path().to_string_lossy().to_string(),
        };
        let resolved =
            resolve_candidate(&candidate, workspace_root.path().to_string_lossy().as_ref());
        assert!(resolved.is_some());
    }

    #[test]
    fn expand_tilde_joins_home_with_remainder() {
        let home = Path::new("/home/alice");
        assert_eq!(
            expand_tilde("~/docs/plan.md", home),
            Some(home.join("docs/plan.md"))
        );
        assert_eq!(expand_tilde("docs/plan.md", home), None);
        assert_eq!(expand_tilde("~alice/docs/plan.md", home), None); // no slash right after `~`, unsupported form
    }

    #[test]
    fn resolves_tilde_path_inside_workspace_root() {
        // Uses resolve_candidate_with_home directly with an injected home,
        // rather than mutating $HOME/%USERPROFILE% -- deterministic regardless
        // of how cargo test interleaves this with the sibling test below, and
        // it can no longer read the wrong home directory on either side.
        let workspace_root = tempfile::tempdir().unwrap();
        std::fs::write(workspace_root.path().join("inside.txt"), "hi").unwrap();

        let candidate = PathCandidate {
            raw: "~/inside.txt".to_string(),
            cwd_hint: workspace_root.path().to_string_lossy().to_string(),
        };
        let resolved = resolve_candidate_with_home(
            &candidate,
            workspace_root.path().to_string_lossy().as_ref(),
            Some(workspace_root.path()),
        );

        assert!(resolved.is_some());
    }

    #[test]
    fn rejects_tilde_path_that_resolves_outside_workspace_root() {
        let workspace_root = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        std::fs::write(home.path().join("secret.txt"), "hi").unwrap();

        let candidate = PathCandidate {
            raw: "~/secret.txt".to_string(),
            cwd_hint: workspace_root.path().to_string_lossy().to_string(),
        };
        let resolved = resolve_candidate_with_home(
            &candidate,
            workspace_root.path().to_string_lossy().as_ref(),
            Some(home.path()),
        );

        assert_eq!(resolved, None);
    }

    #[test]
    fn rejects_tilde_path_that_escapes_through_dotdot() {
        // Path::join performs no normalization, so `~/../<sibling>/secret.txt`
        // produces a literal `..`-bearing PathBuf; this pins that the subsequent
        // canonicalize + starts_with check (the same mechanism that already
        // defeats symlink escape) collapses it and still rejects it.
        let workspace_root = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let sibling = tempfile::tempdir().unwrap();
        std::fs::write(sibling.path().join("secret.txt"), "hi").unwrap();
        let sibling_name = sibling
            .path()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string();

        let candidate = PathCandidate {
            raw: format!("~/../{sibling_name}/secret.txt"),
            cwd_hint: workspace_root.path().to_string_lossy().to_string(),
        };
        let resolved = resolve_candidate_with_home(
            &candidate,
            workspace_root.path().to_string_lossy().as_ref(),
            Some(home.path()),
        );

        assert_eq!(resolved, None);
    }

    #[test]
    fn prefers_cwd_hint_match_over_workspace_root_match_when_both_exist() {
        // Encodes issue #305's own "pick the closest match" example directly.
        let workspace_root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(workspace_root.path().join("docs")).unwrap();
        std::fs::write(workspace_root.path().join("docs/plan.md"), "root version").unwrap();

        let project_dir = workspace_root.path().join("project");
        std::fs::create_dir_all(project_dir.join("docs")).unwrap();
        std::fs::write(project_dir.join("docs/plan.md"), "project version").unwrap();

        let candidate = PathCandidate {
            raw: "docs/plan.md".to_string(),
            cwd_hint: project_dir.to_string_lossy().to_string(),
        };
        let resolved =
            resolve_candidate(&candidate, workspace_root.path().to_string_lossy().as_ref())
                .unwrap();

        assert_eq!(PathBuf::from(&resolved), project_dir.join("docs/plan.md"));
    }

    /// THE regression guard for this change: cwd_hint is now live and can point
    /// anywhere the shell has `cd`'d to, including outside the workspace. The
    /// #299 containment check must reject a match found that way exactly as it
    /// would an absolute path outside the root.
    #[test]
    fn rejects_relative_path_resolved_via_cwd_hint_outside_workspace_root() {
        let workspace_root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), "hi").unwrap();

        let candidate = PathCandidate {
            raw: "secret.txt".to_string(),
            cwd_hint: outside.path().to_string_lossy().to_string(),
        };
        let resolved =
            resolve_candidate(&candidate, workspace_root.path().to_string_lossy().as_ref());

        assert_eq!(resolved, None);
    }
}

use crate::workspace::is_default_ignored;
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};

/// One candidate substring the frontend's file-path link provider matched in
/// visible terminal output, plus the shell's cwd to resolve it against.
/// `cwd_hint` is kept live from the frontend, sourced from the backend's own
/// polled title events (`pty_manager.rs`'s `TITLE_POLL_INTERVAL`), so it can
/// lag the shell's actual cwd by up to one poll tick after a `cd`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathCandidate {
    pub raw: String,
    pub cwd_hint: String,
}

/// One resolved terminal file-path link candidate. Crosses the IPC boundary
/// to the frontend, which needs `external` to decide whether activating the
/// link must go through `fs_authorize_terminal_link` first (issue #406).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedPath {
    /// The path to open. Literal (as spelled by the caller's attempt) for an
    /// in-workspace result; canonical for an external one -- see §4.4 of the
    /// #406 plan for why the two differ.
    pub path: String,
    /// True when `path` lies outside the workspace root, or there is no root
    /// at all. Opening it requires an external-file grant.
    pub external: bool,
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

/// Resolves a batch of terminal path candidates. Exact `~/`-expanded,
/// absolute, shell-cwd-relative, and workspace-root-relative paths keep that
/// precedence and are reported inside or outside the workspace root, flagged
/// via `ResolvedPath::external` -- resolution is a pure existence question
/// and authorizes nothing (see `fs_authorize_terminal_link`, which is what
/// actually grants access to an external result). Any candidate still
/// unresolved by the exact tier is treated as a path-component suffix and
/// resolves only when exactly one file *inside the workspace* ends with that
/// suffix; the suffix tier never reports an external result. `workspace_root`
/// is `None` when there is genuinely no usable root (no project open, or a
/// root-less workspace by design) -- see §4.6 of the #406 plan. The workspace
/// is walked at most once for the whole batch.
pub fn resolve_candidates(
    candidates: &[PathCandidate],
    workspace_root: Option<&str>,
) -> Vec<Option<ResolvedPath>> {
    resolve_candidates_with_home(candidates, workspace_root, home_dir().as_deref())
}

/// Resolves a single candidate through the exact tier only, never falling
/// back to the workspace-wide partial-suffix walk. Used by
/// `fs_authorize_terminal_link` re-resolving at click time: a suffix-tier
/// fallback there could silently authorize a *different* in-workspace file
/// that happens to share a suffix with a candidate whose original external
/// target vanished between render and click (issue #406 round-2 review).
pub fn resolve_exact_candidate(
    candidate: &PathCandidate,
    workspace_root: Option<&str>,
) -> Option<ResolvedPath> {
    resolve_exact_candidate_with_home(candidate, workspace_root, home_dir().as_deref())
}

/// Single-candidate convenience used by focused resolver tests.
#[cfg(test)]
pub fn resolve_candidate(
    candidate: &PathCandidate,
    workspace_root: Option<&str>,
) -> Option<ResolvedPath> {
    resolve_candidates(std::slice::from_ref(candidate), workspace_root)
        .into_iter()
        .next()
        .flatten()
}

#[cfg(test)]
fn resolve_candidate_with_home(
    candidate: &PathCandidate,
    workspace_root: Option<&str>,
    home: Option<&Path>,
) -> Option<ResolvedPath> {
    resolve_candidates_with_home(std::slice::from_ref(candidate), workspace_root, home)
        .into_iter()
        .next()
        .flatten()
}

fn exact_attempts(
    candidate: &PathCandidate,
    workspace_root: Option<&str>,
    home: Option<&Path>,
) -> Vec<PathBuf> {
    let path_part = strip_line_col(&candidate.raw);
    if let Some(expanded) = home.and_then(|home| expand_tilde(path_part, home)) {
        return vec![expanded];
    }

    let candidate_path = Path::new(path_part);
    if candidate_path.is_absolute() {
        vec![candidate_path.to_path_buf()]
    } else {
        let mut attempts = vec![Path::new(&candidate.cwd_hint).join(candidate_path)];
        if let Some(root) = workspace_root {
            attempts.push(Path::new(root).join(candidate_path));
        }
        attempts
    }
}

/// Terminal links open files, never directories -- the partial-suffix tier
/// has always required this; the exact tier did not (issue #406, finding 6).
/// `is_file` follows symlinks, so a symlink to a regular file still counts.
fn is_openable_file(path: &Path) -> bool {
    path.is_file()
}

fn resolve_exact_candidate_with_home(
    candidate: &PathCandidate,
    workspace_root: Option<&str>,
    home: Option<&Path>,
) -> Option<ResolvedPath> {
    let resolved = exact_attempts(candidate, workspace_root, home)
        .into_iter()
        .find(|p| is_openable_file(p))?;

    // Canonicalizing is only a valid containment check because `resolved` is
    // confirmed to exist by the `is_openable_file` filter above: canonicalize
    // dereferences every symlink component (like `LocalWorkspace`'s own
    // containment walk in `resolve_within_root_impl`), but for a path with a
    // not-yet-existing component it would simply fail instead of resolving
    // the existing prefix.
    let real_resolved = std::fs::canonicalize(&resolved).ok()?;

    // A configured-but-unusable root must fail closed, exactly as it does
    // today -- NOT collapse into the rootless case. Folding the two together
    // would classify every file in an open project as external the moment
    // its root stops canonicalizing (an unmounted share, a rename under a
    // live session), silently granting and `⌁`-badging the user's own
    // project files. Only a genuinely absent root means "everything is
    // external"; see §4.6.
    let external = match workspace_root {
        Some(root) => {
            let real_root = std::fs::canonicalize(root).ok()?;
            !real_resolved.starts_with(&real_root)
        }
        None => true,
    };

    Some(ResolvedPath {
        path: if external {
            real_resolved.to_string_lossy().to_string()
        } else {
            resolved.to_string_lossy().to_string()
        },
        external,
    })
}

/// Normalizes a printed partial path into a relative component suffix.
/// Leading roots and `.` components carry no information for suffix matching;
/// `..` is rejected because it describes traversal, not a stable suffix.
fn partial_suffix(raw: &str) -> Option<PathBuf> {
    let mut suffix = PathBuf::new();
    for component in Path::new(strip_line_col(raw)).components() {
        match component {
            Component::Normal(part) => suffix.push(part),
            Component::RootDir | Component::CurDir | Component::Prefix(_) => {}
            Component::ParentDir => return None,
        }
    }
    (!suffix.as_os_str().is_empty()).then_some(suffix)
}

#[derive(Debug)]
struct UniqueMatch {
    canonical_path: PathBuf,
    reported_path: String,
}

fn resolve_candidates_with_home(
    candidates: &[PathCandidate],
    workspace_root: Option<&str>,
    home: Option<&Path>,
) -> Vec<Option<ResolvedPath>> {
    let mut resolved: Vec<Option<ResolvedPath>> = candidates
        .iter()
        .map(|candidate| resolve_exact_candidate_with_home(candidate, workspace_root, home))
        .collect();
    if resolved.iter().all(Option::is_some) {
        return resolved;
    }

    // The partial-suffix tier is workspace-only: it is a guess -- "the unique
    // file in this project whose path ends with this suffix" -- and without a
    // root there is no bounded search space for it to walk (§4.1 item 2/4).
    let Some(workspace_root) = workspace_root else {
        return resolved;
    };
    let real_root = match std::fs::canonicalize(workspace_root) {
        Ok(root) => root,
        Err(_) => return resolved,
    };
    let suffixes: Vec<Option<PathBuf>> = candidates
        .iter()
        .enumerate()
        .map(|(index, candidate)| {
            if resolved[index].is_none()
                && !exact_attempts(candidate, Some(workspace_root), home)
                    .iter()
                    .any(|path| is_openable_file(path))
            {
                partial_suffix(&candidate.raw)
            } else {
                None
            }
        })
        .collect();
    if suffixes.iter().all(Option::is_none) {
        return resolved;
    }

    let mut unique_matches: Vec<Option<UniqueMatch>> = std::iter::repeat_with(|| None)
        .take(candidates.len())
        .collect();
    let mut ambiguous = vec![false; candidates.len()];

    let traversal_root = real_root.clone();
    let mut builder = ignore::WalkBuilder::new(workspace_root);
    builder
        .hidden(false)
        .ignore(false)
        .git_ignore(false)
        .git_global(false)
        .git_exclude(false)
        .follow_links(true)
        .filter_entry(move |entry| {
            let visible = entry.depth() == 0
                || entry
                    .file_name()
                    .to_str()
                    .is_none_or(|name| !is_default_ignored(name));
            let contained_symlink = !entry.path_is_symlink()
                || std::fs::canonicalize(entry.path())
                    .is_ok_and(|target| target.starts_with(&traversal_root));
            visible && contained_symlink
        });

    for entry in builder.build().flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let relative = match path.strip_prefix(workspace_root) {
            Ok(relative) => relative,
            Err(_) => continue,
        };

        for (index, suffix) in suffixes.iter().enumerate() {
            let Some(suffix) = suffix else { continue };
            if ambiguous[index] || !relative.ends_with(suffix) {
                continue;
            }
            let Ok(canonical_path) = std::fs::canonicalize(path) else {
                continue;
            };
            if !canonical_path.starts_with(&real_root) {
                continue;
            }

            match &unique_matches[index] {
                None => {
                    unique_matches[index] = Some(UniqueMatch {
                        canonical_path,
                        reported_path: path.to_string_lossy().to_string(),
                    });
                }
                Some(found) if found.canonical_path == canonical_path => {}
                Some(_) => {
                    unique_matches[index] = None;
                    ambiguous[index] = true;
                }
            }
        }
    }

    for index in 0..resolved.len() {
        if resolved[index].is_none() && !ambiguous[index] {
            resolved[index] = unique_matches[index].take().map(|found| ResolvedPath {
                path: found.reported_path,
                external: false,
            });
        }
    }
    resolved
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
        let resolved = resolve_candidate(&candidate, Some(dir.path().to_string_lossy().as_ref()));
        assert!(resolved.is_some());
    }

    #[test]
    fn returns_none_for_nonexistent_path() {
        let candidate = PathCandidate {
            raw: "definitely/does/not/exist.rs".to_string(),
            cwd_hint: "/tmp".to_string(),
        };
        assert_eq!(resolve_candidate(&candidate, Some("/tmp")), None);
    }

    #[test]
    fn resolves_absolute_path_outside_workspace_root_as_external() {
        let workspace_root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let outside_file = outside.path().join("secret.txt");
        std::fs::write(&outside_file, "hi").unwrap();
        let outside_without_root: PathBuf = outside_file
            .components()
            .filter(|component| !matches!(component, Component::Prefix(_) | Component::RootDir))
            .collect();
        let colliding_suffix = workspace_root.path().join(outside_without_root);
        std::fs::create_dir_all(colliding_suffix.parent().unwrap()).unwrap();
        std::fs::write(colliding_suffix, "not the printed absolute path").unwrap();

        let candidate = PathCandidate {
            raw: outside_file.to_string_lossy().to_string(),
            cwd_hint: workspace_root.path().to_string_lossy().to_string(),
        };
        let resolved = resolve_candidate(
            &candidate,
            Some(workspace_root.path().to_string_lossy().as_ref()),
        );
        let expected = std::fs::canonicalize(&outside_file).unwrap();
        assert_eq!(
            resolved,
            Some(ResolvedPath {
                path: expected.to_string_lossy().to_string(),
                external: true,
            })
        );
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
        let resolved = resolve_candidate(
            &candidate,
            Some(workspace_root.path().to_string_lossy().as_ref()),
        )
        .unwrap();
        assert!(!resolved.external);
    }

    #[test]
    fn resolves_relative_path_that_escapes_through_symlink_as_external() {
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
        let resolved = resolve_candidate(
            &candidate,
            Some(workspace_root.path().to_string_lossy().as_ref()),
        );
        let expected = std::fs::canonicalize(&outside_file).unwrap();
        assert_eq!(
            resolved,
            Some(ResolvedPath {
                path: expected.to_string_lossy().to_string(),
                external: true,
            })
        );
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
        let resolved = resolve_candidate(
            &candidate,
            Some(workspace_root.path().to_string_lossy().as_ref()),
        )
        .unwrap();
        assert!(!resolved.external);
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
            Some(workspace_root.path().to_string_lossy().as_ref()),
            Some(workspace_root.path()),
        );

        assert!(resolved.is_some());
    }

    #[test]
    fn resolves_tilde_path_outside_workspace_root_as_external() {
        let workspace_root = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        std::fs::write(home.path().join("secret.txt"), "hi").unwrap();

        let candidate = PathCandidate {
            raw: "~/secret.txt".to_string(),
            cwd_hint: workspace_root.path().to_string_lossy().to_string(),
        };
        let resolved = resolve_candidate_with_home(
            &candidate,
            Some(workspace_root.path().to_string_lossy().as_ref()),
            Some(home.path()),
        );
        let expected = std::fs::canonicalize(home.path().join("secret.txt")).unwrap();
        assert_eq!(
            resolved,
            Some(ResolvedPath {
                path: expected.to_string_lossy().to_string(),
                external: true,
            })
        );
    }

    #[test]
    fn resolves_tilde_path_that_escapes_through_dotdot_as_external() {
        // Path::join performs no normalization, so `~/../<sibling>/secret.txt`
        // produces a literal `..`-bearing PathBuf; this pins that the subsequent
        // canonicalize collapses it into the escaped, out-of-root real path
        // (the same mechanism that already defeats symlink escape), which is
        // now reported as an external result rather than dropped.
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
            Some(workspace_root.path().to_string_lossy().as_ref()),
            Some(home.path()),
        );
        let expected = std::fs::canonicalize(sibling.path().join("secret.txt")).unwrap();
        assert_eq!(
            resolved,
            Some(ResolvedPath {
                path: expected.to_string_lossy().to_string(),
                external: true,
            })
        );
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
        let resolved = resolve_candidate(
            &candidate,
            Some(workspace_root.path().to_string_lossy().as_ref()),
        )
        .unwrap();

        assert_eq!(
            PathBuf::from(&resolved.path),
            project_dir.join("docs/plan.md")
        );
        assert!(!resolved.external);
    }

    /// Previously THE regression guard for #299/#305: cwd_hint is live and can
    /// point anywhere the shell has `cd`'d to, including outside the
    /// workspace. Containment no longer lives at resolution time -- a
    /// cwd-hint match outside the root now resolves as `external: true` and
    /// is granted (or refused) at the open step, via
    /// `fs_authorize_terminal_link`, rather than silently dropped here.
    #[test]
    fn resolves_relative_path_resolved_via_cwd_hint_outside_workspace_root_as_external() {
        let workspace_root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), "hi").unwrap();
        std::fs::create_dir_all(workspace_root.path().join("deep")).unwrap();
        std::fs::write(
            workspace_root.path().join("deep/secret.txt"),
            "not the cwd-relative path",
        )
        .unwrap();

        let candidate = PathCandidate {
            raw: "secret.txt".to_string(),
            cwd_hint: outside.path().to_string_lossy().to_string(),
        };
        let resolved = resolve_candidate(
            &candidate,
            Some(workspace_root.path().to_string_lossy().as_ref()),
        );

        let expected = std::fs::canonicalize(outside.path().join("secret.txt")).unwrap();
        assert_eq!(
            resolved,
            Some(ResolvedPath {
                path: expected.to_string_lossy().to_string(),
                external: true,
            })
        );
    }

    #[test]
    fn resolves_a_unique_workspace_file_from_a_partial_path_suffix() {
        let workspace_root = tempfile::tempdir().unwrap();
        let file = workspace_root.path().join("deep/nested/unique-code.py");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "print('resolved')").unwrap();

        let candidate = PathCandidate {
            raw: "nested/unique-code.py:10".to_string(),
            cwd_hint: workspace_root.path().to_string_lossy().to_string(),
        };
        let resolved = resolve_candidate(
            &candidate,
            Some(workspace_root.path().to_string_lossy().as_ref()),
        );

        assert_eq!(resolved.map(|r| PathBuf::from(r.path)), Some(file));
    }

    #[test]
    fn resolves_partial_suffixes_for_gitignored_and_hidden_workspace_files() {
        let workspace_root = tempfile::tempdir().unwrap();
        std::fs::write(workspace_root.path().join(".gitignore"), "generated/\n").unwrap();
        let gitignored = workspace_root.path().join("generated/deep/output.py");
        std::fs::create_dir_all(gitignored.parent().unwrap()).unwrap();
        std::fs::write(&gitignored, "generated").unwrap();
        let hidden = workspace_root.path().join(".cache/deep/hidden.py");
        std::fs::create_dir_all(hidden.parent().unwrap()).unwrap();
        std::fs::write(&hidden, "hidden").unwrap();
        let candidates = [
            PathCandidate {
                raw: "deep/output.py".to_string(),
                cwd_hint: workspace_root.path().to_string_lossy().to_string(),
            },
            PathCandidate {
                raw: "deep/hidden.py".to_string(),
                cwd_hint: workspace_root.path().to_string_lossy().to_string(),
            },
        ];

        let resolved = resolve_candidates(
            &candidates,
            Some(workspace_root.path().to_string_lossy().as_ref()),
        );

        assert_eq!(
            resolved[0].as_ref().map(|r| PathBuf::from(&r.path)),
            Some(gitignored)
        );
        assert_eq!(
            resolved[1].as_ref().map(|r| PathBuf::from(&r.path)),
            Some(hidden)
        );
    }

    #[test]
    fn resolves_a_partial_suffix_through_an_in_workspace_directory_symlink() {
        let workspace_root = tempfile::tempdir().unwrap();
        let real_dir = workspace_root.path().join("real");
        std::fs::create_dir(&real_dir).unwrap();
        let file = real_dir.join("inside.txt");
        std::fs::write(&file, "inside").unwrap();
        let link = workspace_root.path().join("deep/alias");
        std::fs::create_dir_all(link.parent().unwrap()).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real_dir, &link).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(&real_dir, &link).unwrap();
        let candidate = PathCandidate {
            raw: "alias/inside.txt".to_string(),
            cwd_hint: workspace_root.path().to_string_lossy().to_string(),
        };

        let resolved = resolve_candidate(
            &candidate,
            Some(workspace_root.path().to_string_lossy().as_ref()),
        );

        assert_eq!(
            resolved.map(|r| PathBuf::from(r.path)),
            Some(link.join("inside.txt"))
        );
    }

    #[test]
    fn partial_suffix_search_does_not_follow_a_directory_symlink_outside_the_workspace() {
        let workspace_root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), "outside").unwrap();
        let link = workspace_root.path().join("deep/escape");
        std::fs::create_dir_all(link.parent().unwrap()).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path(), &link).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(outside.path(), &link).unwrap();
        let candidate = PathCandidate {
            raw: "escape/secret.txt".to_string(),
            cwd_hint: workspace_root.path().to_string_lossy().to_string(),
        };

        let resolved = resolve_candidate(
            &candidate,
            Some(workspace_root.path().to_string_lossy().as_ref()),
        );

        assert_eq!(resolved, None);
    }

    #[test]
    fn resolves_a_unique_filename_without_any_parent_components() {
        let workspace_root = tempfile::tempdir().unwrap();
        let file = workspace_root.path().join("deep/unique-code.py");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "print('resolved')").unwrap();
        let candidate = PathCandidate {
            raw: "unique-code.py".to_string(),
            cwd_hint: workspace_root.path().to_string_lossy().to_string(),
        };

        let resolved = resolve_candidate(
            &candidate,
            Some(workspace_root.path().to_string_lossy().as_ref()),
        );

        assert_eq!(resolved.map(|r| PathBuf::from(r.path)), Some(file));
    }

    #[test]
    fn resolves_a_leading_slash_fragment_as_a_unique_suffix_after_exact_resolution_fails() {
        let workspace_root = tempfile::tempdir().unwrap();
        let file = workspace_root.path().join("deep/nested/unique-code.py");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "print('resolved')").unwrap();
        let candidate = PathCandidate {
            raw: "/nested/unique-code.py:10".to_string(),
            cwd_hint: workspace_root.path().to_string_lossy().to_string(),
        };

        let resolved = resolve_candidate(
            &candidate,
            Some(workspace_root.path().to_string_lossy().as_ref()),
        );

        assert_eq!(resolved.map(|r| PathBuf::from(r.path)), Some(file));
    }

    #[test]
    fn rejects_a_partial_suffix_that_matches_more_than_one_file() {
        let workspace_root = tempfile::tempdir().unwrap();
        for parent in ["first", "second"] {
            let file = workspace_root.path().join(parent).join("nested/shared.py");
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, "print('duplicate')").unwrap();
        }
        let candidate = PathCandidate {
            raw: "nested/shared.py:10".to_string(),
            cwd_hint: workspace_root.path().to_string_lossy().to_string(),
        };

        let resolved = resolve_candidate(
            &candidate,
            Some(workspace_root.path().to_string_lossy().as_ref()),
        );

        assert_eq!(resolved, None);
    }

    #[test]
    fn partial_suffixes_match_complete_path_components_not_substrings() {
        let workspace_root = tempfile::tempdir().unwrap();
        let file = workspace_root.path().join("deep/nested/unique-code.py");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, "print('not a component match')").unwrap();
        let candidate = PathCandidate {
            raw: "ested/unique-code.py".to_string(),
            cwd_hint: workspace_root.path().to_string_lossy().to_string(),
        };

        let resolved = resolve_candidate(
            &candidate,
            Some(workspace_root.path().to_string_lossy().as_ref()),
        );

        assert_eq!(resolved, None);
    }

    #[test]
    fn partial_suffixes_resolve_files_not_directories() {
        let workspace_root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(workspace_root.path().join("deep/nested/build.py")).unwrap();
        let candidate = PathCandidate {
            raw: "nested/build.py".to_string(),
            cwd_hint: workspace_root.path().to_string_lossy().to_string(),
        };

        let resolved = resolve_candidate(
            &candidate,
            Some(workspace_root.path().to_string_lossy().as_ref()),
        );

        assert_eq!(resolved, None);
    }

    #[test]
    fn resolves_multiple_partial_candidates_with_independent_uniqueness() {
        let workspace_root = tempfile::tempdir().unwrap();
        let unique = workspace_root.path().join("deep/unique.py");
        std::fs::create_dir_all(unique.parent().unwrap()).unwrap();
        std::fs::write(&unique, "unique").unwrap();
        for parent in ["first", "second"] {
            let duplicate = workspace_root.path().join(parent).join("duplicate.py");
            std::fs::create_dir_all(duplicate.parent().unwrap()).unwrap();
            std::fs::write(duplicate, "duplicate").unwrap();
        }
        let candidates = [
            PathCandidate {
                raw: "unique.py:3".to_string(),
                cwd_hint: workspace_root.path().to_string_lossy().to_string(),
            },
            PathCandidate {
                raw: "duplicate.py:7".to_string(),
                cwd_hint: workspace_root.path().to_string_lossy().to_string(),
            },
        ];

        let resolved = resolve_candidates(
            &candidates,
            Some(workspace_root.path().to_string_lossy().as_ref()),
        );

        assert_eq!(
            resolved[0].as_ref().map(|r| PathBuf::from(&r.path)),
            Some(unique)
        );
        assert_eq!(resolved[1], None);
    }

    // --- Issue #406 reproductions, promoted to permanent regression tests ---

    #[test]
    fn repro_406_absolute_path_outside_workspace_is_inert() {
        let workspace_root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let outside_file = outside.path().join("main.rs");
        std::fs::write(&outside_file, "fn main() {}").unwrap();

        let candidate = PathCandidate {
            raw: format!("{}:12:5", outside_file.to_string_lossy()),
            cwd_hint: workspace_root.path().to_string_lossy().to_string(),
        };
        let resolved = resolve_candidate(
            &candidate,
            Some(workspace_root.path().to_string_lossy().as_ref()),
        );

        assert!(
            resolved.is_some(),
            "#406: an existing absolute path outside the workspace root did not resolve"
        );
    }

    #[test]
    fn repro_406_tilde_path_outside_workspace_is_inert() {
        let workspace_root = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        std::fs::write(home.path().join("notes.md"), "hi").unwrap();

        let candidate = PathCandidate {
            raw: "~/notes.md".to_string(),
            cwd_hint: workspace_root.path().to_string_lossy().to_string(),
        };
        let resolved = resolve_candidate_with_home(
            &candidate,
            Some(workspace_root.path().to_string_lossy().as_ref()),
            Some(home.path()),
        );

        assert!(
            resolved.is_some(),
            "#406: an existing ~/-path outside the workspace root did not resolve"
        );
    }

    #[test]
    fn repro_406_cwd_relative_path_after_cd_outside_workspace_is_inert() {
        let workspace_root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(outside.path().join("src")).unwrap();
        std::fs::write(outside.path().join("src/lib.rs"), "// other repo").unwrap();

        let candidate = PathCandidate {
            raw: "src/lib.rs:3".to_string(),
            cwd_hint: outside.path().to_string_lossy().to_string(),
        };
        let resolved = resolve_candidate(
            &candidate,
            Some(workspace_root.path().to_string_lossy().as_ref()),
        );

        assert!(
            resolved.is_some(),
            "#406: a cwd-relative path under a cwd outside the workspace did not resolve"
        );
    }

    #[test]
    fn repro_406_dotdot_sibling_path_is_inert() {
        let parent = tempfile::tempdir().unwrap();
        let workspace_root = parent.path().join("project");
        std::fs::create_dir_all(&workspace_root).unwrap();
        let sibling = parent.path().join("sibling");
        std::fs::create_dir_all(&sibling).unwrap();
        std::fs::write(sibling.join("README.md"), "hi").unwrap();

        let candidate = PathCandidate {
            raw: "../sibling/README.md".to_string(),
            cwd_hint: workspace_root.to_string_lossy().to_string(),
        };
        let resolved =
            resolve_candidate(&candidate, Some(workspace_root.to_string_lossy().as_ref()));

        assert!(
            resolved.is_some(),
            "#406: a ../sibling path outside the workspace root did not resolve"
        );
    }

    #[test]
    fn repro_406_no_workspace_root_makes_every_candidate_inert() {
        let cwd = tempfile::tempdir().unwrap();
        std::fs::write(cwd.path().join("notes.md"), "hi").unwrap();
        let candidate = PathCandidate {
            raw: "notes.md".to_string(),
            cwd_hint: cwd.path().to_string_lossy().to_string(),
        };
        let resolved = resolve_candidate(&candidate, None);
        assert!(
            resolved.is_some(),
            "#406: nothing resolves at all when the workspace has no root"
        );
    }

    // --- New tests added by the #406 fix itself ---

    #[test]
    fn exact_tier_does_not_resolve_a_directory() {
        let workspace_root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(workspace_root.path().join("src/generated")).unwrap();
        let candidate = PathCandidate {
            raw: "src/generated".to_string(),
            cwd_hint: workspace_root.path().to_string_lossy().to_string(),
        };
        let resolved = resolve_candidate(
            &candidate,
            Some(workspace_root.path().to_string_lossy().as_ref()),
        );
        assert_eq!(resolved, None, "exact tier linkified a directory");
    }

    #[test]
    fn external_result_reports_the_canonical_path_not_a_dotdot_literal() {
        let parent = tempfile::tempdir().unwrap();
        let workspace_root = parent.path().join("project");
        std::fs::create_dir_all(&workspace_root).unwrap();
        let sibling = parent.path().join("sibling");
        std::fs::create_dir_all(&sibling).unwrap();
        std::fs::write(sibling.join("README.md"), "hi").unwrap();

        let candidate = PathCandidate {
            raw: "../sibling/README.md".to_string(),
            cwd_hint: workspace_root.to_string_lossy().to_string(),
        };
        let resolved =
            resolve_candidate(&candidate, Some(workspace_root.to_string_lossy().as_ref())).unwrap();

        assert!(resolved.external);
        assert!(
            !resolved.path.contains(".."),
            "reported path retained a `..` component: {}",
            resolved.path
        );
        assert_eq!(
            PathBuf::from(&resolved.path),
            std::fs::canonicalize(sibling.join("README.md")).unwrap()
        );
    }

    #[test]
    fn external_result_reports_the_canonical_path_for_an_escaping_symlink() {
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
        let resolved = resolve_candidate(
            &candidate,
            Some(workspace_root.path().to_string_lossy().as_ref()),
        )
        .unwrap();

        assert!(resolved.external);
        assert_eq!(
            PathBuf::from(&resolved.path),
            std::fs::canonicalize(&outside_file).unwrap()
        );
    }

    #[test]
    fn no_root_resolves_cwd_relative_and_absolute_paths_as_external() {
        let cwd = tempfile::tempdir().unwrap();
        std::fs::write(cwd.path().join("notes.md"), "hi").unwrap();
        let absolute = tempfile::tempdir().unwrap();
        let absolute_file = absolute.path().join("other.md");
        std::fs::write(&absolute_file, "hi").unwrap();

        let candidates = [
            PathCandidate {
                raw: "notes.md".to_string(),
                cwd_hint: cwd.path().to_string_lossy().to_string(),
            },
            PathCandidate {
                raw: absolute_file.to_string_lossy().to_string(),
                cwd_hint: cwd.path().to_string_lossy().to_string(),
            },
        ];

        let resolved = resolve_candidates(&candidates, None);

        assert!(resolved[0].as_ref().is_some_and(|r| r.external));
        assert!(resolved[1].as_ref().is_some_and(|r| r.external));
    }

    #[test]
    fn no_root_skips_the_partial_suffix_walk() {
        let workspace_root = tempfile::tempdir().unwrap();
        let file = workspace_root.path().join("deep/nested/unique-code.py");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "print('resolved')").unwrap();

        // Only matches by suffix against the (absent) root -- the cwd_hint
        // itself does not contain the file, so the exact tier cannot find it
        // either.
        let candidate = PathCandidate {
            raw: "nested/unique-code.py".to_string(),
            cwd_hint: workspace_root.path().to_string_lossy().to_string(),
        };
        let resolved = resolve_candidate(&candidate, None);

        assert_eq!(resolved, None);
    }

    #[test]
    fn a_directory_match_does_not_suppress_the_partial_suffix_fallback() {
        let workspace_root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(workspace_root.path().join("src/generated")).unwrap();
        let file = workspace_root.path().join("deep/src/generated");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "generated file").unwrap();

        let candidate = PathCandidate {
            raw: "src/generated".to_string(),
            cwd_hint: workspace_root.path().to_string_lossy().to_string(),
        };
        let resolved = resolve_candidate(
            &candidate,
            Some(workspace_root.path().to_string_lossy().as_ref()),
        );

        assert_eq!(resolved.map(|r| PathBuf::from(r.path)), Some(file));
    }

    /// The MF3 guard: an unusable (but configured) root must resolve nothing,
    /// never classify every candidate as external. Without this test the
    /// naive formulation compiles and passes everything else in the module,
    /// and only misbehaves once a root breaks at runtime (an unmounted
    /// share, a rename under a live session) -- see §4.6 of the #406 plan.
    #[test]
    fn an_uncanonicalizable_root_resolves_nothing_rather_than_everything_external() {
        let real_dir = tempfile::tempdir().unwrap();
        std::fs::write(real_dir.path().join("inside.txt"), "hi").unwrap();
        let broken_root = real_dir.path().join("this-path-does-not-exist");

        let candidate = PathCandidate {
            raw: "inside.txt".to_string(),
            cwd_hint: real_dir.path().to_string_lossy().to_string(),
        };
        let resolved = resolve_candidate(&candidate, Some(broken_root.to_string_lossy().as_ref()));

        assert_eq!(
            resolved, None,
            "an unusable root must fail closed, not classify the file as external"
        );
    }

    /// Round-2 review fix: `resolve_exact_candidate` must never fall back to
    /// the partial-suffix walk. `fs_authorize_terminal_link` relies on this to
    /// close a race where an external file vanishes between render and
    /// click -- a suffix-tier fallback there could silently authorize a
    /// different in-workspace file that happens to share the suffix.
    #[test]
    fn resolve_exact_candidate_does_not_fall_back_to_the_partial_suffix_walk() {
        let workspace_root = tempfile::tempdir().unwrap();
        let file = workspace_root.path().join("deep/nested/unique-code.py");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "print('resolved')").unwrap();

        // Only matches by suffix -- exact_attempts (cwd_hint- and
        // workspace-root-relative) never finds it, since it lives at a
        // deeper path than either attempt considers.
        let candidate = PathCandidate {
            raw: "nested/unique-code.py".to_string(),
            cwd_hint: workspace_root.path().to_string_lossy().to_string(),
        };

        // Sanity check: the full resolver (with the suffix tier) does find it.
        assert!(resolve_candidate(
            &candidate,
            Some(workspace_root.path().to_string_lossy().as_ref())
        )
        .is_some());

        // The exact-only resolver must not.
        let resolved = resolve_exact_candidate(
            &candidate,
            Some(workspace_root.path().to_string_lossy().as_ref()),
        );
        assert_eq!(resolved, None);
    }
}

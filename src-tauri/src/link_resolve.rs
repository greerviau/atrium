use crate::workspace::is_default_ignored;
use serde::Deserialize;
use std::path::{Component, Path, PathBuf};

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

/// Resolves a batch of terminal path candidates to absolute workspace paths.
/// Exact `~/`-expanded, absolute, shell-cwd-relative, and workspace-root-relative
/// paths keep that precedence. Any candidate still unresolved is treated as a
/// path-component suffix and resolves only when exactly one file in the
/// workspace ends with that suffix. The workspace is walked at most once for
/// the whole batch.
pub fn resolve_candidates(
    candidates: &[PathCandidate],
    workspace_root: &str,
) -> Vec<Option<String>> {
    resolve_candidates_with_home(candidates, workspace_root, home_dir().as_deref())
}

/// Single-candidate convenience used by focused resolver tests.
#[cfg(test)]
pub fn resolve_candidate(candidate: &PathCandidate, workspace_root: &str) -> Option<String> {
    resolve_candidates(std::slice::from_ref(candidate), workspace_root)
        .into_iter()
        .next()
        .flatten()
}

#[cfg(test)]
fn resolve_candidate_with_home(
    candidate: &PathCandidate,
    workspace_root: &str,
    home: Option<&Path>,
) -> Option<String> {
    resolve_candidates_with_home(std::slice::from_ref(candidate), workspace_root, home)
        .into_iter()
        .next()
        .flatten()
}

fn exact_attempts(
    candidate: &PathCandidate,
    workspace_root: &str,
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
        vec![
            Path::new(&candidate.cwd_hint).join(candidate_path),
            Path::new(workspace_root).join(candidate_path),
        ]
    }
}

fn resolve_exact_candidate_with_home(
    candidate: &PathCandidate,
    workspace_root: &str,
    home: Option<&Path>,
) -> Option<String> {
    let resolved = exact_attempts(candidate, workspace_root, home)
        .into_iter()
        .find(|p| p.exists())?;

    // Canonicalizing is only a valid containment check because `resolved` is
    // confirmed to exist by the `.exists()` filter above: canonicalize
    // dereferences every symlink component (like `LocalWorkspace`'s own
    // containment walk in `resolve_within_root_impl`), but for a path with a
    // not-yet-existing component it would simply fail instead of resolving
    // the existing prefix.
    let real_root = std::fs::canonicalize(workspace_root).ok()?;
    let real_resolved = std::fs::canonicalize(&resolved).ok()?;
    if !real_resolved.starts_with(&real_root) {
        return None;
    }

    Some(resolved.to_string_lossy().to_string())
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
    workspace_root: &str,
    home: Option<&Path>,
) -> Vec<Option<String>> {
    let mut resolved: Vec<Option<String>> = candidates
        .iter()
        .map(|candidate| resolve_exact_candidate_with_home(candidate, workspace_root, home))
        .collect();
    if resolved.iter().all(Option::is_some) {
        return resolved;
    }

    let real_root = match std::fs::canonicalize(workspace_root) {
        Ok(root) => root,
        Err(_) => return resolved,
    };
    let suffixes: Vec<Option<PathBuf>> = candidates
        .iter()
        .enumerate()
        .map(|(index, candidate)| {
            if resolved[index].is_none()
                && !exact_attempts(candidate, workspace_root, home)
                    .iter()
                    .any(|path| path.exists())
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
            resolved[index] = unique_matches[index]
                .take()
                .map(|found| found.reported_path);
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
        let colliding_suffix = workspace_root
            .path()
            .join(outside_file.strip_prefix("/").unwrap());
        std::fs::create_dir_all(colliding_suffix.parent().unwrap()).unwrap();
        std::fs::write(colliding_suffix, "not the printed absolute path").unwrap();

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
        let resolved =
            resolve_candidate(&candidate, workspace_root.path().to_string_lossy().as_ref());

        assert_eq!(resolved, None);
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
        let resolved =
            resolve_candidate(&candidate, workspace_root.path().to_string_lossy().as_ref());

        assert_eq!(resolved.map(PathBuf::from), Some(file));
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
            workspace_root.path().to_string_lossy().as_ref(),
        );

        assert_eq!(resolved[0].as_ref().map(PathBuf::from), Some(gitignored));
        assert_eq!(resolved[1].as_ref().map(PathBuf::from), Some(hidden));
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

        let resolved =
            resolve_candidate(&candidate, workspace_root.path().to_string_lossy().as_ref());

        assert_eq!(resolved.map(PathBuf::from), Some(link.join("inside.txt")));
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

        let resolved =
            resolve_candidate(&candidate, workspace_root.path().to_string_lossy().as_ref());

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

        let resolved =
            resolve_candidate(&candidate, workspace_root.path().to_string_lossy().as_ref());

        assert_eq!(resolved.map(PathBuf::from), Some(file));
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

        let resolved =
            resolve_candidate(&candidate, workspace_root.path().to_string_lossy().as_ref());

        assert_eq!(resolved.map(PathBuf::from), Some(file));
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

        let resolved =
            resolve_candidate(&candidate, workspace_root.path().to_string_lossy().as_ref());

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

        let resolved =
            resolve_candidate(&candidate, workspace_root.path().to_string_lossy().as_ref());

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

        let resolved =
            resolve_candidate(&candidate, workspace_root.path().to_string_lossy().as_ref());

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
            workspace_root.path().to_string_lossy().as_ref(),
        );

        assert_eq!(resolved[0].as_ref().map(PathBuf::from), Some(unique));
        assert_eq!(resolved[1], None);
    }
}

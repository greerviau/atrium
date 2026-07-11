use serde::Deserialize;
use std::path::{Path, PathBuf};

/// One candidate substring the frontend's file-path link provider matched in
/// visible terminal output, plus the terminal's spawn cwd to resolve it
/// against. `cwd_hint` is always the PTY's original spawn cwd, not any live
/// shell cwd (tracking `cd`s would need OSC7/prompt-integration parsing;
/// out of scope for the MVP, see plan section 6.4).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathCandidate {
    pub raw: String,
    pub cwd_hint: String,
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
/// resolve to a real file/directory under any of the three rules in plan
/// section 6.4: (1) absolute, (2) relative to the terminal's spawn cwd,
/// (3) relative to the workspace root.
pub fn resolve_candidate(candidate: &PathCandidate, workspace_root: &str) -> Option<String> {
    let path_part = strip_line_col(&candidate.raw);
    let candidate_path = Path::new(path_part);

    let attempts: Vec<PathBuf> = if candidate_path.is_absolute() {
        vec![candidate_path.to_path_buf()]
    } else {
        vec![
            Path::new(&candidate.cwd_hint).join(candidate_path),
            Path::new(workspace_root).join(candidate_path),
        ]
    };

    attempts
        .into_iter()
        .find(|p| p.exists())
        .map(|p| p.to_string_lossy().to_string())
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
        std::fs::write(dir.path().join("note.md"), "hi").unwrap();
        let candidate = PathCandidate {
            raw: "note.md".to_string(),
            cwd_hint: dir.path().to_string_lossy().to_string(),
        };
        let resolved = resolve_candidate(&candidate, "/nonexistent-workspace-root");
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
}

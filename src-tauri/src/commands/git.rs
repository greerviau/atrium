use crate::error::AppError;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktree {
    pub path: String,
    pub branch: Option<String>,
    pub head: String,
    pub is_current: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    pub name: String,
    pub worktree_path: Option<String>,
    pub is_current: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitContext {
    pub repository_root: String,
    pub worktree_path: String,
    pub branch: Option<String>,
    pub head: String,
    pub worktrees: Vec<GitWorktree>,
    pub branches: Vec<GitBranch>,
}

fn run_git(cwd: &Path, args: &[&str]) -> Result<Output, AppError> {
    Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|err| AppError::Other(format!("could not run git: {err}")))
}

fn git_failure(args: &[&str], output: &Output) -> AppError {
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let command = args.join(" ");
    AppError::Other(if detail.is_empty() {
        format!("git {command} failed")
    } else {
        format!("git {command} failed: {detail}")
    })
}

fn output_text(output: Output, args: &[&str]) -> Result<String, AppError> {
    if !output.status.success() {
        return Err(git_failure(args, &output));
    }
    String::from_utf8(output.stdout)
        .map(|text| text.trim().to_string())
        .map_err(|err| AppError::Other(format!("git {args:?} returned invalid UTF-8: {err}")))
}

fn same_path(left: &Path, right: &Path) -> bool {
    if left == right {
        return true;
    }
    match (left.canonicalize(), right.canonicalize()) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

fn parse_worktrees(text: &str, current_path: &Path) -> Vec<GitWorktree> {
    let mut worktrees = Vec::new();
    let mut path: Option<String> = None;
    let mut branch: Option<String> = None;
    let mut head: Option<String> = None;

    let finish = |worktrees: &mut Vec<GitWorktree>,
                  path: &mut Option<String>,
                  branch: &mut Option<String>,
                  head: &mut Option<String>| {
        let Some(worktree_path) = path.take() else {
            branch.take();
            head.take();
            return;
        };
        worktrees.push(GitWorktree {
            is_current: same_path(Path::new(&worktree_path), current_path),
            path: worktree_path,
            branch: branch.take(),
            head: head.take().unwrap_or_default(),
        });
    };

    for line in text.lines() {
        if let Some(value) = line.strip_prefix("worktree ") {
            finish(&mut worktrees, &mut path, &mut branch, &mut head);
            path = Some(value.to_string());
        } else if let Some(value) = line.strip_prefix("HEAD ") {
            head = Some(value.to_string());
        } else if let Some(value) = line.strip_prefix("branch refs/heads/") {
            branch = Some(value.to_string());
        } else if line == "detached" {
            branch = None;
        }
    }
    finish(&mut worktrees, &mut path, &mut branch, &mut head);
    worktrees
}

fn inspect(path: &Path) -> Result<Option<GitContext>, AppError> {
    let root_output = run_git(path, &["rev-parse", "--show-toplevel"])?;
    if !root_output.status.success() {
        let stderr = String::from_utf8_lossy(&root_output.stderr);
        if stderr.contains("not a git repository") {
            return Ok(None);
        }
        return Err(git_failure(&["rev-parse", "--show-toplevel"], &root_output));
    }
    let repository_root = String::from_utf8(root_output.stdout)
        .map_err(|err| AppError::Other(format!("git returned invalid UTF-8: {err}")))?
        .trim()
        .to_string();
    let worktree_path = repository_root.clone();
    let worktree_path_buf = PathBuf::from(&worktree_path);

    let branch_output = run_git(path, &["symbolic-ref", "--quiet", "--short", "HEAD"])?;
    let branch = if branch_output.status.success() {
        Some(
            String::from_utf8(branch_output.stdout)
                .map_err(|err| AppError::Other(format!("git returned invalid UTF-8: {err}")))?
                .trim()
                .to_string(),
        )
    } else {
        None
    };

    let head_output = run_git(path, &["rev-parse", "--short", "HEAD"])?;
    let head = if head_output.status.success() {
        output_text(head_output, &["rev-parse", "--short", "HEAD"])?
    } else if branch.is_some() {
        "unborn".to_string()
    } else {
        return Err(git_failure(&["rev-parse", "--short", "HEAD"], &head_output));
    };
    let worktrees_text = output_text(
        run_git(path, &["worktree", "list", "--porcelain"])?,
        &["worktree", "list", "--porcelain"],
    )?;
    let worktrees = parse_worktrees(&worktrees_text, &worktree_path_buf);

    let branches_text = output_text(
        run_git(
            path,
            &["for-each-ref", "--format=%(refname:short)", "refs/heads/"],
        )?,
        &["for-each-ref", "--format=%(refname:short)", "refs/heads/"],
    )?;
    let branches = branches_text
        .lines()
        .filter(|name| !name.is_empty())
        .map(|name| {
            let worktree_path = worktrees
                .iter()
                .find(|worktree| worktree.branch.as_deref() == Some(name))
                .map(|worktree| worktree.path.clone());
            GitBranch {
                name: name.to_string(),
                worktree_path,
                is_current: branch.as_deref() == Some(name),
            }
        })
        .collect();

    Ok(Some(GitContext {
        repository_root,
        worktree_path,
        branch,
        head,
        worktrees,
        branches,
    }))
}

#[tauri::command]
pub async fn git_get_context(path: String) -> Result<Option<GitContext>, AppError> {
    tokio::task::spawn_blocking(move || inspect(Path::new(&path)))
        .await
        .map_err(|err| AppError::Other(format!("git inspection task failed: {err}")))?
}

#[tauri::command]
pub async fn git_switch_branch(path: String, branch: String) -> Result<(), AppError> {
    tokio::task::spawn_blocking(move || {
        let cwd = Path::new(&path);
        let check = run_git(cwd, &["check-ref-format", "--branch", &branch])?;
        if !check.status.success() {
            return Err(AppError::InvalidPath(format!(
                "invalid git branch '{branch}'"
            )));
        }
        let output = run_git(cwd, &["switch", &branch])?;
        if output.status.success() {
            Ok(())
        } else {
            Err(git_failure(&["switch", &branch], &output))
        }
    })
    .await
    .map_err(|err| AppError::Other(format!("git switch task failed: {err}")))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn git(cwd: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn inspect_reports_the_current_branch_worktree_and_local_branches() {
        let repo = tempfile::tempdir().unwrap();
        git(repo.path(), &["init", "-q", "-b", "main"]);
        git(repo.path(), &["config", "user.name", "Atrium Tests"]);
        git(repo.path(), &["config", "user.email", "tests@example.com"]);
        fs::write(repo.path().join("README.md"), "content\n").unwrap();
        git(repo.path(), &["add", "README.md"]);
        git(repo.path(), &["commit", "-qm", "initial"]);
        git(repo.path(), &["branch", "feature"]);

        let context = inspect(repo.path()).unwrap().unwrap();

        assert_eq!(context.branch.as_deref(), Some("main"));
        assert_eq!(context.worktrees.len(), 1);
        assert_eq!(context.worktrees[0].branch.as_deref(), Some("main"));
        assert!(context.worktrees[0].is_current);
        assert_eq!(
            context
                .branches
                .iter()
                .map(|branch| branch.name.as_str())
                .collect::<Vec<_>>(),
            vec!["feature", "main"]
        );
        assert!(context
            .branches
            .iter()
            .find(|branch| branch.name == "feature")
            .unwrap()
            .worktree_path
            .is_none());
    }

    #[test]
    fn inspect_reports_an_unborn_branch_before_the_first_commit() {
        let repo = tempfile::tempdir().unwrap();
        git(repo.path(), &["init", "-q", "-b", "main"]);

        let context = inspect(repo.path()).unwrap().unwrap();

        assert_eq!(context.branch.as_deref(), Some("main"));
        assert_eq!(context.head, "unborn");
        assert_eq!(context.worktrees.len(), 1);
    }

    #[test]
    fn parse_worktrees_extracts_branches_and_detached_heads() {
        let worktrees = parse_worktrees(
            "worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\nworktree /repo-feature\nHEAD def456\ndetached\n",
            Path::new("/repo"),
        );

        assert_eq!(worktrees.len(), 2);
        assert_eq!(worktrees[0].branch.as_deref(), Some("main"));
        assert!(worktrees[0].is_current);
        assert_eq!(worktrees[1].branch, None);
        assert_eq!(worktrees[1].head, "def456");
        assert!(!worktrees[1].is_current);
    }
}

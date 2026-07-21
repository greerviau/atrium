use super::{DirEntry, FsChangeEvent, SearchMatch, SearchOptions, SearchResults, Workspace};
use crate::error::AppError;
use crate::fs_watch;
use async_trait::async_trait;
use grep_matcher::Matcher;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::sinks::UTF8;
use grep_searcher::{BinaryDetection, SearcherBuilder, SinkError};
use notify_debouncer_full::{Debouncer, FileIdMap};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc::UnboundedSender;

/// Caps on `LocalWorkspace::search`'s result set (section 4.2 of the search
/// spec): bounds the IPC payload and the results list to a usable size, the
/// same "existing-style magic number" role `recents.rs`'s cap of 10 plays
/// for its own list.
const SEARCH_TOTAL_MATCH_CAP: usize = 500;
const SEARCH_PER_FILE_MATCH_CAP: usize = 50;

/// Builds the `grep-regex` matcher for a query: a real regex when
/// `options.regex` is set, otherwise `fixed_strings` tells `grep-regex` to
/// match `query` as a literal string — every character, including regex
/// metacharacters, matched literally, rather than hand-escaping the query
/// ourselves. A regex compile failure (only reachable with `options.regex
/// == true`) surfaces as `AppError::InvalidRegex` so the frontend can show
/// it inline, distinct from an empty result list.
fn build_matcher(query: &str, options: &SearchOptions) -> Result<RegexMatcher, AppError> {
    let mut builder = RegexMatcherBuilder::new();
    builder
        .case_insensitive(!options.case_sensitive)
        .fixed_strings(!options.regex);
    builder.build(query).map_err(|err| {
        if options.regex {
            AppError::InvalidRegex(err.to_string())
        } else {
            AppError::Other(err.to_string())
        }
    })
}

/// Converts a UTF-8 byte offset into `line` (as returned by
/// `grep_matcher::Match::start`/`end`, which operate on the line's raw
/// bytes) into a UTF-16 code-unit offset — the unit `SearchOverlay.svelte`'s
/// `lineText.slice()` and `EditorPane.svelte`'s CodeMirror jump-to-selection
/// both index by, since that's how JS strings (and CodeMirror positions)
/// are indexed. `byte_offset` is always a valid UTF-8 char boundary here:
/// it comes from a match against `line`'s own bytes via the Unicode-mode
/// `regex` engine `grep-regex` builds on, which never splits a codepoint.
fn byte_offset_to_utf16(line: &str, byte_offset: usize) -> u32 {
    line[..byte_offset].encode_utf16().count() as u32
}

/// Walks `root` (gitignore-aware, hidden/VCS-dir-skipping, via
/// `ignore::WalkBuilder`'s ripgrep-equivalent defaults) and searches every
/// regular file's contents with `matcher`, stopping once either cap in
/// section 4.2 is hit. Runs synchronously; `LocalWorkspace::search` runs it
/// via `spawn_blocking` since directory walking and file I/O here are
/// blocking calls, not `tokio::fs`.
///
/// `current_generation` is checked once per directory entry against the
/// `generation` this call was started with: `LocalWorkspace::search` bumps
/// `current_generation` on every new call, so as soon as a newer search
/// supersedes this one, the walk stops immediately instead of running to
/// completion for a result nobody will use — the cooperative-cancellation
/// half of "a new keystroke cancels the previous in-flight search."
fn search_root(
    root: &Path,
    matcher: &RegexMatcher,
    current_generation: &AtomicU64,
    generation: u64,
) -> SearchResults {
    let mut searcher = SearcherBuilder::new()
        .binary_detection(BinaryDetection::quit(0))
        .line_number(true)
        .build();

    let mut matches = Vec::new();
    let mut truncated = false;

    // `require_git(false)`: `WalkBuilder`'s default only honors `.gitignore`
    // inside an actual git repository, but an Atrium workspace is just
    // "whatever folder the user opened," git repo or not — gitignore-aware
    // filtering (section 4.2) needs to work either way.
    for entry in ignore::WalkBuilder::new(root).require_git(false).build() {
        if current_generation.load(Ordering::SeqCst) != generation {
            break;
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(err) => {
                eprintln!("atrium: search walk error: {err}");
                continue;
            }
        };
        if !entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
            continue;
        }

        let path = entry.into_path();
        let path_str = path.to_string_lossy().to_string();
        let mut file_match_count = 0usize;

        let result = searcher.search_path(
            matcher,
            &path,
            UTF8(|line_number, line| {
                let line_text = line.trim_end_matches(['\n', '\r']);
                let mut cap_hit = false;
                matcher
                    .find_iter(line_text.as_bytes(), |m| {
                        let start = byte_offset_to_utf16(line_text, m.start());
                        let end = byte_offset_to_utf16(line_text, m.end());
                        matches.push(SearchMatch {
                            path: path_str.clone(),
                            line: line_number as u32,
                            column: start + 1,
                            line_text: line_text.to_string(),
                            match_start: start,
                            match_end: end,
                        });
                        file_match_count += 1;
                        if matches.len() >= SEARCH_TOTAL_MATCH_CAP
                            || file_match_count >= SEARCH_PER_FILE_MATCH_CAP
                        {
                            truncated = true;
                            cap_hit = true;
                            return false;
                        }
                        true
                    })
                    .map_err(io::Error::error_message)?;
                Ok(!cap_hit)
            }),
        );

        if let Err(err) = result {
            eprintln!("atrium: search error in {}: {err}", path.display());
        }

        if matches.len() >= SEARCH_TOTAL_MATCH_CAP {
            break;
        }
    }

    SearchResults { matches, truncated }
}

/// The only `Workspace` implementation in the MVP: a directory on the local
/// filesystem. Every method resolves its `path` argument against `root` and
/// rejects any path that would escape it (`..` components) — this is the
/// access-control boundary referenced in the IPC contract's capabilities
/// note (plan section 5): the capability file grants our own commands
/// unconditionally, and it is `LocalWorkspace::resolve_within_root` alone
/// that decides whether a given path is actually reachable.
pub struct LocalWorkspace {
    root: PathBuf,
    workspace_id: String,
    watcher: Mutex<Option<Debouncer<notify::RecommendedWatcher, FileIdMap>>>,
    /// Bumped on every `search()` call; lets `search_root` notice mid-walk
    /// that a newer search has superseded it (see `search_root`'s doc
    /// comment) and stop early instead of finishing a search whose result
    /// will only be thrown away.
    search_generation: Arc<AtomicU64>,
}

impl LocalWorkspace {
    pub fn new(workspace_id: String, root: PathBuf) -> Self {
        Self {
            root,
            workspace_id,
            watcher: Mutex::new(None),
            search_generation: Arc::new(AtomicU64::new(0)),
        }
    }

    /// Resolves `path` (absolute, or relative to `root`) against `root`,
    /// rejecting anything that would escape it.
    fn resolve_within_root(&self, path: &str) -> Result<PathBuf, AppError> {
        let candidate = Path::new(path);
        let joined = if candidate.is_absolute() {
            candidate.to_path_buf()
        } else {
            self.root.join(candidate)
        };

        let normalized = normalize(&joined);
        let normalized_root = normalize(&self.root);

        if !normalized.starts_with(&normalized_root) {
            return Err(AppError::InvalidPath(format!(
                "path '{path}' escapes the workspace root"
            )));
        }
        Ok(normalized)
    }
}

/// Lexically normalizes a path (resolves `.`/`..` components without
/// touching the filesystem, so it also works for paths that don't exist
/// yet, e.g. `fs_create_file`).
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

#[async_trait]
impl Workspace for LocalWorkspace {
    async fn list_dir(&self, path: &str) -> Result<Vec<DirEntry>, AppError> {
        let dir = self.resolve_within_root(path)?;
        let mut entries = Vec::new();
        let mut read_dir = tokio::fs::read_dir(&dir).await?;
        while let Some(entry) = read_dir.next_entry().await? {
            let metadata = entry.metadata().await?;
            let file_type = entry.file_type().await?;
            entries.push(DirEntry {
                name: entry.file_name().to_string_lossy().to_string(),
                path: entry.path().to_string_lossy().to_string(),
                is_dir: metadata.is_dir(),
                is_symlink: file_type.is_symlink(),
            });
        }
        entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        });
        Ok(entries)
    }

    async fn read_file(&self, path: &str) -> Result<String, AppError> {
        let file = self.resolve_within_root(path)?;
        let bytes = tokio::fs::read(&file).await?;
        String::from_utf8(bytes).map_err(|_| AppError::NotUtf8(path.to_string()))
    }

    async fn write_file(&self, path: &str, contents: &str) -> Result<(), AppError> {
        let file = self.resolve_within_root(path)?;
        tokio::fs::write(&file, contents).await?;
        Ok(())
    }

    async fn create_file(&self, path: &str) -> Result<(), AppError> {
        let file = self.resolve_within_root(path)?;
        if file.exists() {
            return Err(AppError::AlreadyExists(path.to_string()));
        }
        tokio::fs::File::create_new(&file).await?;
        Ok(())
    }

    async fn create_dir(&self, path: &str) -> Result<(), AppError> {
        let dir = self.resolve_within_root(path)?;
        if dir.exists() {
            return Err(AppError::AlreadyExists(path.to_string()));
        }
        tokio::fs::create_dir_all(&dir).await?;
        Ok(())
    }

    async fn rename(&self, from: &str, to: &str) -> Result<(), AppError> {
        let from_path = self.resolve_within_root(from)?;
        let to_path = self.resolve_within_root(to)?;
        tokio::fs::rename(&from_path, &to_path).await?;
        Ok(())
    }

    async fn delete(&self, path: &str, recursive: bool) -> Result<(), AppError> {
        let target = self.resolve_within_root(path)?;
        let metadata = tokio::fs::metadata(&target).await?;
        if metadata.is_dir() {
            if recursive {
                tokio::fs::remove_dir_all(&target).await?;
            } else {
                tokio::fs::remove_dir(&target).await?;
            }
        } else {
            tokio::fs::remove_file(&target).await?;
        }
        Ok(())
    }

    async fn search(&self, query: &str, options: SearchOptions) -> Result<SearchResults, AppError> {
        let matcher = build_matcher(query, &options)?;
        let root = self.root.clone();
        let generation = self.search_generation.fetch_add(1, Ordering::SeqCst) + 1;
        let current_generation = self.search_generation.clone();
        tokio::task::spawn_blocking(move || {
            search_root(&root, &matcher, &current_generation, generation)
        })
        .await
        .map_err(|err| AppError::Other(format!("search task panicked: {err}")))
    }

    fn root(&self) -> &str {
        self.root.to_str().unwrap_or("")
    }

    fn watch(&self, tx: UnboundedSender<FsChangeEvent>) {
        let mut guard = self.watcher.lock().unwrap();
        if guard.is_some() {
            return;
        }
        let debouncer = fs_watch::watch(self.root().to_string(), self.workspace_id.clone(), tx);
        *guard = Some(debouncer);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace(root: &Path) -> LocalWorkspace {
        LocalWorkspace::new("local".to_string(), root.to_path_buf())
    }

    #[tokio::test]
    async fn rejects_parent_dir_escape() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        let err = ws.read_file("../outside.txt").await.unwrap_err();
        assert!(matches!(err, AppError::InvalidPath(_)));
    }

    #[tokio::test]
    async fn round_trips_file_contents() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        ws.create_file("note.md").await.unwrap();
        ws.write_file("note.md", "hello").await.unwrap();
        let contents = ws.read_file("note.md").await.unwrap();
        assert_eq!(contents, "hello");
    }

    #[tokio::test]
    async fn create_file_errors_if_exists() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        ws.create_file("note.md").await.unwrap();
        let err = ws.create_file("note.md").await.unwrap_err();
        assert!(matches!(err, AppError::AlreadyExists(_)));
    }

    #[tokio::test]
    async fn delete_requires_recursive_for_nonempty_dir() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        ws.create_dir("sub").await.unwrap();
        ws.create_file("sub/note.md").await.unwrap();
        assert!(ws.delete("sub", false).await.is_err());
        ws.delete("sub", true).await.unwrap();
        assert!(!dir.path().join("sub").exists());
    }

    #[tokio::test]
    async fn list_dir_sorts_dirs_first_then_alphabetical() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        ws.create_file("b.txt").await.unwrap();
        ws.create_file("a.txt").await.unwrap();
        ws.create_dir("z_dir").await.unwrap();
        let entries = ws.list_dir(".").await.unwrap();
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["z_dir", "a.txt", "b.txt"]);
    }

    fn options(case_sensitive: bool, regex: bool) -> SearchOptions {
        SearchOptions {
            case_sensitive,
            regex,
        }
    }

    #[tokio::test]
    async fn search_finds_matches_across_multiple_files() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        ws.create_file("a.txt").await.unwrap();
        ws.write_file("a.txt", "hello world").await.unwrap();
        ws.create_file("b.txt").await.unwrap();
        ws.write_file("b.txt", "another hello there").await.unwrap();

        let results = ws.search("hello", options(false, false)).await.unwrap();

        assert_eq!(results.matches.len(), 2);
        assert!(!results.truncated);
        let paths: Vec<_> = results.matches.iter().map(|m| m.path.clone()).collect();
        assert!(paths.iter().any(|p| p.ends_with("a.txt")));
        assert!(paths.iter().any(|p| p.ends_with("b.txt")));
    }

    #[tokio::test]
    async fn search_default_is_case_insensitive_literal() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        ws.create_file("a.txt").await.unwrap();
        ws.write_file("a.txt", "Hello World").await.unwrap();

        let results = ws.search("hello", options(false, false)).await.unwrap();

        assert_eq!(results.matches.len(), 1);
        assert_eq!(results.matches[0].line, 1);
        assert_eq!(results.matches[0].line_text, "Hello World");
    }

    #[tokio::test]
    async fn search_case_sensitive_excludes_differently_cased_match() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        ws.create_file("a.txt").await.unwrap();
        ws.write_file("a.txt", "Hello World").await.unwrap();

        let results = ws.search("hello", options(true, false)).await.unwrap();

        assert_eq!(results.matches.len(), 0);
    }

    #[tokio::test]
    async fn search_regex_mode_matches_a_pattern() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        ws.create_file("a.txt").await.unwrap();
        ws.write_file("a.txt", "foo123bar\nfoo bar").await.unwrap();

        let results = ws.search(r"foo\d+bar", options(false, true)).await.unwrap();

        assert_eq!(results.matches.len(), 1);
        assert_eq!(results.matches[0].line, 1);
    }

    #[tokio::test]
    async fn search_literal_mode_treats_pattern_characters_literally() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        ws.create_file("a.txt").await.unwrap();
        ws.write_file("a.txt", "foo123bar\nfoo.bar").await.unwrap();

        let results = ws
            .search(r"foo\d+bar", options(false, false))
            .await
            .unwrap();

        // Treated as a literal string (containing a literal backslash-d),
        // so it matches neither line: this is what makes a plain search for
        // e.g. `a.b` not accidentally match `axb` via regex `.`.
        assert_eq!(results.matches.len(), 0);
    }

    #[tokio::test]
    async fn search_invalid_regex_returns_invalid_regex_error() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        ws.create_file("a.txt").await.unwrap();
        ws.write_file("a.txt", "hello").await.unwrap();

        let err = ws
            .search("(unterminated", options(false, true))
            .await
            .unwrap_err();

        assert!(matches!(err, AppError::InvalidRegex(_)));
    }

    #[tokio::test]
    async fn search_respects_gitignore() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        ws.create_file(".gitignore").await.unwrap();
        ws.write_file(".gitignore", "ignored.txt\n").await.unwrap();
        ws.create_file("ignored.txt").await.unwrap();
        ws.write_file("ignored.txt", "needle").await.unwrap();
        ws.create_file("kept.txt").await.unwrap();
        ws.write_file("kept.txt", "needle").await.unwrap();

        let results = ws.search("needle", options(false, false)).await.unwrap();

        assert_eq!(results.matches.len(), 1);
        assert!(results.matches[0].path.ends_with("kept.txt"));
    }

    #[tokio::test]
    async fn search_skips_binary_files() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        ws.create_file("binary.dat").await.unwrap();
        tokio::fs::write(dir.path().join("binary.dat"), b"needle\x00binary")
            .await
            .unwrap();
        ws.create_file("text.txt").await.unwrap();
        ws.write_file("text.txt", "needle").await.unwrap();

        let results = ws.search("needle", options(false, false)).await.unwrap();

        assert_eq!(results.matches.len(), 1);
        assert!(results.matches[0].path.ends_with("text.txt"));
    }

    #[tokio::test]
    async fn search_truncates_at_the_per_file_cap() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        ws.create_file("many.txt").await.unwrap();
        let contents = "needle\n".repeat(SEARCH_PER_FILE_MATCH_CAP + 10);
        ws.write_file("many.txt", &contents).await.unwrap();

        let results = ws.search("needle", options(false, false)).await.unwrap();

        assert_eq!(results.matches.len(), SEARCH_PER_FILE_MATCH_CAP);
        assert!(results.truncated);
    }

    #[tokio::test]
    async fn search_truncates_at_the_total_cap() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        // Spread matches across many files so the per-file cap isn't what
        // truncates the result set; the total cap should be.
        let files = (SEARCH_TOTAL_MATCH_CAP / 10) + 5;
        for i in 0..files {
            let name = format!("file{i}.txt");
            ws.create_file(&name).await.unwrap();
            ws.write_file(&name, &"needle\n".repeat(10)).await.unwrap();
        }

        let results = ws.search("needle", options(false, false)).await.unwrap();

        assert_eq!(results.matches.len(), SEARCH_TOTAL_MATCH_CAP);
        assert!(results.truncated);
    }

    #[tokio::test]
    async fn search_reports_each_match_on_a_line_with_multiple_matches() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        ws.create_file("a.txt").await.unwrap();
        ws.write_file("a.txt", "needle needle needle")
            .await
            .unwrap();

        let results = ws.search("needle", options(false, false)).await.unwrap();

        assert_eq!(results.matches.len(), 3);
        assert_eq!(results.matches[0].match_start, 0);
        assert_eq!(results.matches[1].match_start, 7);
        assert_eq!(results.matches[2].match_start, 14);
    }

    #[tokio::test]
    async fn search_offsets_are_utf16_code_units_not_utf8_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        ws.create_file("a.txt").await.unwrap();
        // "é" is 1 UTF-16 code unit but 2 UTF-8 bytes, so a byte offset and
        // a UTF-16 offset diverge for anything after it on the line. The
        // frontend (SearchOverlay.svelte's highlight slice, EditorPane's
        // jump-to-selection) indexes by UTF-16 code unit, matching
        // CodeMirror and JS string semantics, so that's what these fields
        // need to report.
        ws.write_file("a.txt", "héllo world").await.unwrap();

        let results = ws.search("world", options(false, false)).await.unwrap();

        assert_eq!(results.matches.len(), 1);
        assert_eq!(results.matches[0].match_start, 6);
        assert_eq!(results.matches[0].match_end, 11);
        assert_eq!(results.matches[0].column, 7);
    }

    #[tokio::test]
    async fn search_root_stops_early_once_superseded() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        ws.create_file("a.txt").await.unwrap();
        ws.write_file("a.txt", "needle").await.unwrap();
        let matcher = build_matcher("needle", &options(false, false)).unwrap();

        // Simulate a newer search having already started by the time this
        // (stale) generation gets to check: `current_generation` no longer
        // reads back the `generation` this call was given, so it should
        // bail out before matching anything in `a.txt`, the same way a
        // superseded `LocalWorkspace::search` call does mid-walk.
        let current_generation = AtomicU64::new(2);
        let results = search_root(dir.path(), &matcher, &current_generation, 1);

        assert!(results.matches.is_empty());
        assert!(!results.truncated);
    }

    #[tokio::test]
    async fn search_bumps_the_generation_on_every_call() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        ws.create_file("a.txt").await.unwrap();
        ws.write_file("a.txt", "needle").await.unwrap();

        ws.search("needle", options(false, false)).await.unwrap();
        let first = ws.search_generation.load(Ordering::SeqCst);
        ws.search("needle", options(false, false)).await.unwrap();
        let second = ws.search_generation.load(Ordering::SeqCst);

        assert!(second > first);
    }
}

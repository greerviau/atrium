use super::{
    is_default_ignored, DirEntry, FsChangeEvent, SearchMatch, SearchOptions, SearchResults,
    Workspace,
};
use crate::error::AppError;
use crate::fs_watch;
use async_trait::async_trait;
use grep_matcher::Matcher;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::sinks::UTF8;
use grep_searcher::{BinaryDetection, SearcherBuilder, SinkError};
use ignore::WalkState;
use notify_debouncer_full::{Debouncer, FileIdMap};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::mpsc::UnboundedSender;

/// Caps on `LocalWorkspace::search`'s result set (section 4.2 of the search
/// spec): bounds the IPC payload and the results list to a usable size, the
/// same "existing-style magic number" role `recents.rs`'s cap of 10 plays
/// for its own list.
const SEARCH_TOTAL_MATCH_CAP: usize = 500;
const SEARCH_PER_FILE_MATCH_CAP: usize = 50;

/// Wall-clock budget for a single `search_root` walk. Bounds worst-case
/// latency for a query that matches rarely or not at all (the case the
/// match caps above don't help with, since they only fire once enough
/// matches already exist) against a large, non-gitignored tree such as an
/// un-excluded `node_modules`.
const SEARCH_DEADLINE: Duration = Duration::from_secs(2);

/// Builds the `grep-regex` matcher for a query: a real regex when
/// `options.regex` is set, otherwise `fixed_strings` tells `grep-regex` to
/// match `query` as a literal string — every character, including regex
/// metacharacters, matched literally, rather than hand-escaping the query
/// ourselves. A regex compile failure (only reachable with `options.regex
/// == true`) surfaces as `AppError::InvalidRegex` so the frontend can show
/// it inline, distinct from an empty result list.
///
/// Only used for regex-mode searches and case-sensitive literal searches.
/// A case-insensitive literal search uses `AsciiCiLiteralMatcher` instead —
/// see its doc comment for why.
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

/// A `grep_matcher::Matcher` for a single case-insensitive literal pattern,
/// backed by a plain ASCII-lowercased `memchr::memmem` substring search
/// instead of `grep-regex`.
///
/// `grep-regex`'s `RegexMatcherBuilder` only takes its cheap
/// literal-alternation fast path when the search is case-*sensitive*
/// (`is_fixed_strings` in `grep-regex` bails to full regex AST-parsing and
/// Unicode-aware HIR translation the moment `case_insensitive` is set, with
/// no way around it through the public API). For Atrium that's the common
/// case — case-insensitive is the UI's default — and the cost isn't fixed:
/// it scales with query length badly enough to be perceptible per
/// keystroke (measured: ~15µs to build a 3-character case-sensitive
/// matcher vs. ~18ms for a 45-character case-insensitive one, over 1000x).
///
/// An `aho-corasick`-backed matcher was tried first, since it's the
/// dedicated crate for exactly this (and its own `ascii_case_insensitive`
/// mode fixed the construction cost). But its scanning showed an
/// unpredictable, query-content-dependent blowup on real (non-repeating)
/// text — confirmed reproducible and query-specific by interleaving a slow
/// and a fast same-length query back to back, ruling out measurement noise
/// — that neither `AhoCorasickKind::DFA` nor `ContiguousNFA` avoided, and
/// whose root cause wasn't pinned down. Given that risk, this uses
/// `memchr::memmem` (the Two-Way algorithm) instead: it has no automaton
/// construction step at all (so no construction-cost scaling problem to
/// begin with) and a proven linear worst case, at the cost of an explicit
/// ASCII-lowercase copy of each line before searching it.
struct AsciiCiLiteralMatcher {
    query_lower: Vec<u8>,
    // A search-box query is always single-line text, so it can never
    // contain `\n` — meaning `\n` can never be part of a match. Reporting
    // that via `non_matching_bytes` (below) is what lets `grep-searcher`
    // use its fast line-by-line scanner for this matcher; without it,
    // `Searcher::is_line_by_line_fast` falls back to a much slower general
    // strategy.
    non_matching: grep_matcher::ByteSet,
}

impl AsciiCiLiteralMatcher {
    fn new(query: &str) -> Result<AsciiCiLiteralMatcher, AppError> {
        let mut non_matching = grep_matcher::ByteSet::empty();
        non_matching.add(b'\n');
        Ok(AsciiCiLiteralMatcher {
            query_lower: query.as_bytes().to_ascii_lowercase(),
            non_matching,
        })
    }
}

impl Matcher for AsciiCiLiteralMatcher {
    type Captures = grep_matcher::NoCaptures;
    type Error = grep_matcher::NoError;

    fn find_at(
        &self,
        haystack: &[u8],
        at: usize,
    ) -> Result<Option<grep_matcher::Match>, grep_matcher::NoError> {
        // ASCII-lowercasing preserves byte length and position 1:1, so a
        // match found in the lowercased copy is at the same offset in the
        // original (non-ASCII bytes pass through unchanged and simply
        // won't case-fold, which is the documented ASCII-only tradeoff).
        let haystack_lower = haystack[at..].to_ascii_lowercase();
        Ok(memchr::memmem::find(&haystack_lower, &self.query_lower)
            .map(|pos| grep_matcher::Match::new(at + pos, at + pos + self.query_lower.len())))
    }

    fn new_captures(&self) -> Result<Self::Captures, Self::Error> {
        Ok(grep_matcher::NoCaptures::new())
    }

    fn non_matching_bytes(&self) -> Option<&grep_matcher::ByteSet> {
        Some(&self.non_matching)
    }
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

/// Flushes one worker thread's locally-accumulated matches into `shared`
/// when the thread's walk visitor is dropped (thread exit, whether by
/// running out of work or by `WalkState::Quit`). Buffering locally and
/// merging once per thread — rather than locking `shared` on every match —
/// avoids lock contention on the hot path, since matches are only appended
/// during the walk, never read.
struct ThreadLocalMatches<'a> {
    local: Vec<SearchMatch>,
    shared: &'a Mutex<Vec<SearchMatch>>,
}

impl Drop for ThreadLocalMatches<'_> {
    fn drop(&mut self) {
        if !self.local.is_empty() {
            self.shared.lock().unwrap().append(&mut self.local);
        }
    }
}

/// Walks `root` (gitignore-aware, hidden/VCS-dir-skipping, via
/// `ignore::WalkBuilder`'s ripgrep-equivalent defaults) in parallel —
/// `WalkParallel` defaults its worker count to `available_parallelism()`
/// (capped at 12) — and searches every regular file's contents with
/// `matcher`, stopping once the total match cap in section 4.2 is hit or
/// `deadline` elapses. Runs synchronously; `LocalWorkspace::search` runs it
/// via `spawn_blocking` since directory walking and file I/O here are
/// blocking calls, not `tokio::fs`.
///
/// `current_generation` is checked once per directory entry against the
/// `generation` this call was started with: `LocalWorkspace::search` bumps
/// `current_generation` on every new call, so as soon as a newer search
/// supersedes this one, the walk stops immediately instead of running to
/// completion for a result nobody will use — the cooperative-cancellation
/// half of "a new keystroke cancels the previous in-flight search."
///
/// Because files are searched concurrently across threads, matches no
/// longer arrive in a single walk order; all matches for a given file stay
/// contiguous and in line order (one file is always searched entirely by
/// one thread), but the result is sorted by path before returning so
/// cross-file order is deterministic for callers (and so `SearchOverlay`'s
/// per-file grouping, which merges adjacent same-path entries, never sees
/// the same path twice non-adjacently).
fn search_root<M: Matcher + Sync>(
    root: &Path,
    matcher: &M,
    current_generation: &AtomicU64,
    generation: u64,
    deadline: Duration,
) -> SearchResults {
    let deadline = Instant::now() + deadline;
    let total_match_count = AtomicUsize::new(0);
    let truncated = AtomicBool::new(false);
    let all_matches: Mutex<Vec<SearchMatch>> = Mutex::new(Vec::new());

    // `require_git(false)`: `WalkBuilder`'s default only honors `.gitignore`
    // inside an actual git repository, but an Atrium workspace is just
    // "whatever folder the user opened," git repo or not — gitignore-aware
    // filtering (section 4.2) needs to work either way.
    ignore::WalkBuilder::new(root)
        .require_git(false)
        .build_parallel()
        .run(|| {
            let mut searcher = SearcherBuilder::new()
                .binary_detection(BinaryDetection::quit(0))
                .line_number(true)
                .build();
            let mut buffer = ThreadLocalMatches {
                local: Vec::new(),
                shared: &all_matches,
            };
            // Rebind as local references so this outer `mkf` closure (which
            // `WalkParallel::run` calls once per worker thread, i.e. more
            // than once) copies a reference into each thread's `move`
            // visitor instead of moving the shared atomics themselves out
            // of its environment on the first call.
            let total_match_count = &total_match_count;
            let truncated = &truncated;

            Box::new(move |entry| {
                if current_generation.load(Ordering::SeqCst) != generation {
                    // A newer search superseded this one; its result is
                    // thrown away regardless, so there's nothing to mark
                    // truncated.
                    return WalkState::Quit;
                }
                if Instant::now() >= deadline {
                    truncated.store(true, Ordering::SeqCst);
                    return WalkState::Quit;
                }
                if total_match_count.load(Ordering::SeqCst) >= SEARCH_TOTAL_MATCH_CAP {
                    return WalkState::Quit;
                }

                let entry = match entry {
                    Ok(entry) => entry,
                    Err(err) => {
                        eprintln!("atrium: search walk error: {err}");
                        return WalkState::Continue;
                    }
                };
                if !entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
                    return WalkState::Continue;
                }

                let path = entry.into_path();
                let path_str = path.to_string_lossy().to_string();
                let mut file_match_count = 0usize;
                let mut total_cap_hit = false;
                let mut per_file_cap_hit = false;

                let result = searcher.search_path(
                    matcher,
                    &path,
                    UTF8(|line_number, line| {
                        let line_text = line.trim_end_matches(['\n', '\r']);
                        matcher
                            .find_iter(line_text.as_bytes(), |m| {
                                // `fetch_add` serializes every thread's
                                // matches into a single global ordering, so
                                // only the matches whose index lands below
                                // the cap are kept — this is what keeps the
                                // total cap exact under concurrency instead
                                // of letting a check-then-append race let
                                // multiple threads each squeeze one more
                                // match past it.
                                let global_index = total_match_count.fetch_add(1, Ordering::SeqCst);
                                if global_index >= SEARCH_TOTAL_MATCH_CAP {
                                    total_cap_hit = true;
                                    return false;
                                }
                                let start = byte_offset_to_utf16(line_text, m.start());
                                let end = byte_offset_to_utf16(line_text, m.end());
                                buffer.local.push(SearchMatch {
                                    path: path_str.clone(),
                                    line: line_number as u32,
                                    column: start + 1,
                                    line_text: line_text.to_string(),
                                    match_start: start,
                                    match_end: end,
                                });
                                file_match_count += 1;
                                if global_index + 1 >= SEARCH_TOTAL_MATCH_CAP {
                                    total_cap_hit = true;
                                    return false;
                                }
                                if file_match_count >= SEARCH_PER_FILE_MATCH_CAP {
                                    per_file_cap_hit = true;
                                    return false;
                                }
                                true
                            })
                            .map_err(io::Error::error_message)?;
                        Ok(!(total_cap_hit || per_file_cap_hit))
                    }),
                );

                if let Err(err) = result {
                    eprintln!("atrium: search error in {}: {err}", path.display());
                }

                if total_cap_hit || per_file_cap_hit {
                    truncated.store(true, Ordering::SeqCst);
                }
                if total_cap_hit {
                    // The per-file cap only stops scanning *this* file;
                    // only the total cap stops the whole walk, matching the
                    // pre-parallel behavior.
                    return WalkState::Quit;
                }
                WalkState::Continue
            })
        });

    let mut matches = all_matches.into_inner().unwrap();
    matches.sort_by(|a, b| a.path.cmp(&b.path));

    SearchResults {
        matches,
        truncated: truncated.load(Ordering::SeqCst),
    }
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
            let name = entry.file_name().to_string_lossy().to_string();
            if is_default_ignored(&name) {
                continue;
            }
            let metadata = entry.metadata().await?;
            let file_type = entry.file_type().await?;
            entries.push(DirEntry {
                name,
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
        // `tokio::fs::rename` (POSIX `rename(2)`) silently replaces an existing
        // destination, unlike `create_file`/`create_dir` above, so a rename onto an
        // existing name must be rejected the same way — except when the destination
        // is the very entry being renamed. A lexical `from_path != to_path` isn't
        // enough for that: on a case-insensitive volume (default APFS, NTFS),
        // renaming `Notes.md` to `notes.md` has `to_path.exists()` resolve to the
        // same on-disk file even though the two `PathBuf`s differ byte-wise, which
        // would misreport a case-only rename as a collision. Comparing canonicalized
        // paths instead decides "is the destination a different entry?" by identity,
        // which also covers the same-name no-op (an unchanged name resubmitted).
        //
        // `canonicalize` resolves symlinks, but `rename(2)` moves the link itself, so a
        // symlink whose target is the destination would otherwise compare equal to that
        // target and be let through to clobber it. Excluding a symlink source keeps
        // identity judged on the entry being renamed rather than what it points at; the
        // accepted trade-off is that a symlink can no longer be case-only-renamed on a
        // case-insensitive volume (rejecting that is recoverable, unlike the alternative).
        if to_path.exists() {
            let from_is_symlink = from_path
                .symlink_metadata()
                .is_ok_and(|m| m.file_type().is_symlink());
            let same_entry = !from_is_symlink
                && std::fs::canonicalize(&from_path)
                    .ok()
                    .zip(std::fs::canonicalize(&to_path).ok())
                    .is_some_and(|(a, b)| a == b);
            if !same_entry {
                return Err(AppError::AlreadyExists(to.to_string()));
            }
        }
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
        let root = self.root.clone();
        let generation = self.search_generation.fetch_add(1, Ordering::SeqCst) + 1;
        let current_generation = self.search_generation.clone();
        if !options.regex && !options.case_sensitive {
            let matcher = AsciiCiLiteralMatcher::new(query)?;
            tokio::task::spawn_blocking(move || {
                search_root(
                    &root,
                    &matcher,
                    &current_generation,
                    generation,
                    SEARCH_DEADLINE,
                )
            })
            .await
            .map_err(|err| AppError::Other(format!("search task panicked: {err}")))
        } else {
            let matcher = build_matcher(query, &options)?;
            tokio::task::spawn_blocking(move || {
                search_root(
                    &root,
                    &matcher,
                    &current_generation,
                    generation,
                    SEARCH_DEADLINE,
                )
            })
            .await
            .map_err(|err| AppError::Other(format!("search task panicked: {err}")))
        }
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
    async fn rename_errors_if_destination_exists_instead_of_overwriting_it() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        ws.create_file("notes.md").await.unwrap();
        ws.create_file("dup.md").await.unwrap();
        ws.write_file("dup.md", "keep me").await.unwrap();

        let err = ws.rename("notes.md", "dup.md").await.unwrap_err();
        assert!(matches!(err, AppError::AlreadyExists(_)));
        assert_eq!(ws.read_file("dup.md").await.unwrap(), "keep me");
        assert!(dir.path().join("notes.md").exists());
    }

    #[tokio::test]
    async fn rename_onto_the_same_path_is_a_no_op() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        ws.create_file("notes.md").await.unwrap();
        ws.write_file("notes.md", "hello").await.unwrap();

        ws.rename("notes.md", "notes.md").await.unwrap();
        assert_eq!(ws.read_file("notes.md").await.unwrap(), "hello");
    }

    #[tokio::test]
    async fn rename_rejects_a_symlink_onto_its_own_target() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        ws.create_file("notes.md").await.unwrap();
        ws.write_file("notes.md", "keep me").await.unwrap();
        std::os::unix::fs::symlink(dir.path().join("notes.md"), dir.path().join("link.md"))
            .unwrap();

        // `link.md` canonicalizes to the same real path as `notes.md`, but `rename(2)`
        // moves the link itself rather than its target, so this must still be rejected
        // as a collision rather than let through as an identity match.
        let err = ws.rename("link.md", "notes.md").await.unwrap_err();
        assert!(matches!(err, AppError::AlreadyExists(_)));
        assert_eq!(ws.read_file("notes.md").await.unwrap(), "keep me");
        assert!(dir.path().join("link.md").symlink_metadata().is_ok());
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

    #[tokio::test]
    async fn list_dir_filters_out_default_ignored_names() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        ws.create_file("note.md").await.unwrap();
        ws.create_file(".DS_Store").await.unwrap();
        ws.create_dir(".git").await.unwrap();
        ws.create_file("Thumbs.db").await.unwrap();

        let entries = ws.list_dir(".").await.unwrap();
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();

        assert_eq!(names, vec!["note.md"]);
    }

    #[tokio::test]
    async fn list_dir_does_not_filter_gitignore() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        ws.create_file(".gitignore").await.unwrap();

        let entries = ws.list_dir(".").await.unwrap();
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();

        assert_eq!(names, vec![".gitignore"]);
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
    async fn search_total_cap_is_exact_under_concurrent_matches() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        // Many single-match files, well past the cap and past the walk's
        // worker-thread count, so multiple threads are appending matches
        // near the cap boundary at the same time. The cap must land exactly
        // on `SEARCH_TOTAL_MATCH_CAP` regardless of which threads' matches
        // "win" the race to be counted — a plain check-then-append could
        // let several threads each slip one more match past the cap.
        let files = SEARCH_TOTAL_MATCH_CAP + 300;
        for i in 0..files {
            let name = format!("file{i}.txt");
            ws.create_file(&name).await.unwrap();
            ws.write_file(&name, "needle\n").await.unwrap();
        }

        let results = ws.search("needle", options(false, false)).await.unwrap();

        assert_eq!(results.matches.len(), SEARCH_TOTAL_MATCH_CAP);
        assert!(results.truncated);
    }

    #[tokio::test]
    async fn search_root_truncates_when_deadline_elapses() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        // Enough files that a full walk cannot finish inside the 1ms
        // deadline below, but few enough real matches (well under
        // `SEARCH_TOTAL_MATCH_CAP`) that the total-match cap can never be
        // what stops the walk — otherwise this test would still pass with
        // the deadline check deleted entirely, since the cap alone would
        // account for `truncated: true`.
        let files = 2000;
        let files_with_matches = 50;
        for i in 0..files {
            let name = format!("file{i}.txt");
            ws.create_file(&name).await.unwrap();
            let contents = if i < files_with_matches {
                "needle\n"
            } else {
                "no match here\n"
            };
            ws.write_file(&name, contents).await.unwrap();
        }
        let matcher = build_matcher("needle", &options(false, false)).unwrap();
        let current_generation = AtomicU64::new(1);

        let start = Instant::now();
        let results = search_root(
            dir.path(),
            &matcher,
            &current_generation,
            1,
            Duration::from_millis(1),
        );
        let elapsed = start.elapsed();

        // With at most `files_with_matches` (50) possible matches, nowhere
        // near `SEARCH_TOTAL_MATCH_CAP` (500), the cap can never fire here —
        // so this can only be `true` because the deadline check set it.
        assert!(results.truncated);
        // Bounded close to the injected deadline, not the time a full walk
        // of this many files would take.
        assert!(elapsed < Duration::from_secs(1), "elapsed: {elapsed:?}");
    }

    #[tokio::test]
    async fn search_results_are_sorted_by_path_across_files() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        // File names deliberately out of alphabetical creation order, so a
        // pass would only happen by sorting, not by walk order.
        ws.create_file("zeta.txt").await.unwrap();
        ws.write_file("zeta.txt", "needle").await.unwrap();
        ws.create_file("alpha.txt").await.unwrap();
        ws.write_file("alpha.txt", "needle").await.unwrap();
        ws.create_file("mid.txt").await.unwrap();
        ws.write_file("mid.txt", "needle\nneedle").await.unwrap();

        let results = ws.search("needle", options(false, false)).await.unwrap();

        let paths: Vec<_> = results.matches.iter().map(|m| m.path.clone()).collect();
        let mut sorted = paths.clone();
        sorted.sort();
        assert_eq!(paths, sorted);
        // Within a file, line order is still preserved by the sort (stable
        // sort keeps `mid.txt`'s two matches in original line order).
        let mid_lines: Vec<_> = results
            .matches
            .iter()
            .filter(|m| m.path.ends_with("mid.txt"))
            .map(|m| m.line)
            .collect();
        assert_eq!(mid_lines, vec![1, 2]);
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
        let results = search_root(
            dir.path(),
            &matcher,
            &current_generation,
            1,
            SEARCH_DEADLINE,
        );

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

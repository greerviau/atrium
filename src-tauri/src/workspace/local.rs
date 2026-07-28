use super::{
    is_default_ignored, DirEntry, FileMatch, FileSearchResults, FsChangeEvent, SearchMatch,
    SearchOptions, SearchResults, Workspace,
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
use nucleo_matcher::pattern::{AtomKind, CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher as FuzzyMatcher, Utf32Str};
use std::collections::VecDeque;
use std::ffi::OsString;
use std::future::Future;
use std::io;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Component, Path, PathBuf};
use std::pin::Pin;
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

/// Cap on `LocalWorkspace::find_files`'s result set: a file-picker
/// conventionally shows fewer, more immediately scannable rows than a
/// grep-results list, hence the shorter cap than `SEARCH_TOTAL_MATCH_CAP`.
const FIND_FILES_RESULT_CAP: usize = 200;

/// Cap on how many `" copy N"` suffixes `unique_destination` will probe
/// before giving up, so a pathological run of pre-existing collisions can't
/// loop forever.
const MAX_COLLISION_ATTEMPTS: usize = 999;

/// Cap on the file size `LocalWorkspace::read_file` will load into memory.
/// This bounds the IPC payload sent to the frontend and the cost of seeding
/// a CodeMirror document from it, not disk I/O cost — the editor's minimap
/// already found that even a ~1 MB file is expensive enough to need a
/// deferred render, so 10 MiB is a hard floor well below the freeze/OOM
/// range a multi-GB file would otherwise trigger.
const MAX_READABLE_FILE_SIZE_BYTES: u64 = 10 * 1024 * 1024;

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

/// Flushes one worker thread's locally-accumulated paths into `shared` when
/// the thread's walk visitor is dropped — the `find_files` counterpart of
/// `ThreadLocalMatches`, buffering per-thread for the same lock-contention
/// reason.
struct ThreadLocalPaths<'a> {
    local: Vec<String>,
    shared: &'a Mutex<Vec<String>>,
}

impl Drop for ThreadLocalPaths<'_> {
    fn drop(&mut self) {
        if !self.local.is_empty() {
            self.shared.lock().unwrap().append(&mut self.local);
        }
    }
}

/// Walks `root` with the identical gitignore-aware, parallel, generation-
/// cancelable traversal `search_root` uses, but only collects each plain
/// file's absolute path — it never opens a file, since a filename search
/// only ever needs the path string. Fuzzy scoring happens afterward, in
/// `LocalWorkspace::find_files`, not in this closure, since scoring is cheap
/// relative to directory traversal and keeps the walk closure simple.
///
/// Returns the collected paths plus whether the wall-clock `deadline` cut
/// the walk short before it finished (distinct from the walk being
/// superseded mid-flight by a newer call, which returns whatever partial set
/// was collected but is always discarded by the caller regardless).
fn find_files_root(
    root: &Path,
    current_generation: &AtomicU64,
    generation: u64,
    deadline: Duration,
) -> (Vec<String>, bool) {
    let deadline = Instant::now() + deadline;
    let truncated = AtomicBool::new(false);
    let all_paths: Mutex<Vec<String>> = Mutex::new(Vec::new());

    ignore::WalkBuilder::new(root)
        .require_git(false)
        .build_parallel()
        .run(|| {
            let mut buffer = ThreadLocalPaths {
                local: Vec::new(),
                shared: &all_paths,
            };
            let truncated = &truncated;

            Box::new(move |entry| {
                if current_generation.load(Ordering::SeqCst) != generation {
                    return WalkState::Quit;
                }
                if Instant::now() >= deadline {
                    truncated.store(true, Ordering::SeqCst);
                    return WalkState::Quit;
                }

                let entry = match entry {
                    Ok(entry) => entry,
                    Err(err) => {
                        eprintln!("atrium: find_files walk error: {err}");
                        return WalkState::Continue;
                    }
                };
                if !entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
                    return WalkState::Continue;
                }

                buffer
                    .local
                    .push(entry.into_path().to_string_lossy().to_string());
                WalkState::Continue
            })
        });

    (
        all_paths.into_inner().unwrap(),
        truncated.load(Ordering::SeqCst),
    )
}

/// Strips `root` off `path` to get the workspace-root-relative string that
/// `find_files` both fuzzy-matches against and reports as `display_path` —
/// done once here so a match's indices and the frontend's rendered string
/// are always computed against the identical characters.
fn display_path(root: &Path, path: &str) -> String {
    Path::new(path)
        .strip_prefix(root)
        .map(|relative| relative.to_string_lossy().to_string())
        .unwrap_or_else(|_| path.to_string())
}

/// The only `Workspace` implementation in the MVP: a directory on the local
/// filesystem. Every method resolves its `path` argument against `root` and
/// rejects any path that would escape it, whether the escape is spelled out
/// lexically (`..` components) or happens through a symlink (dangling or
/// not, at any path component) — this is the access-control boundary
/// referenced in the IPC contract's capabilities note (plan section 5): the
/// capability file grants our own commands unconditionally, and it is
/// `LocalWorkspace::resolve_within_root`/`resolve_entry_within_root` alone
/// that decide whether a given path is actually reachable.
pub struct LocalWorkspace {
    root: PathBuf,
    workspace_id: String,
    watcher: Mutex<Option<Debouncer<notify::RecommendedWatcher, FileIdMap>>>,
    /// Bumped on every `search()` call; lets `search_root` notice mid-walk
    /// that a newer search has superseded it (see `search_root`'s doc
    /// comment) and stop early instead of finishing a search whose result
    /// will only be thrown away.
    search_generation: Arc<AtomicU64>,
    /// The `find_files` counterpart of `search_generation`, bumped
    /// independently: mode-switching mid-query means a content search and a
    /// filename search can legitimately be in flight close together, and
    /// they must not cancel each other.
    find_files_generation: Arc<AtomicU64>,
}

impl LocalWorkspace {
    pub fn new(workspace_id: String, root: PathBuf) -> Self {
        Self {
            root,
            workspace_id,
            watcher: Mutex::new(None),
            search_generation: Arc::new(AtomicU64::new(0)),
            find_files_generation: Arc::new(AtomicU64::new(0)),
        }
    }

    /// Shared walk behind `resolve_within_root`/`resolve_entry_within_root`,
    /// differing only in whether the final path component gets dereferenced.
    ///
    /// Each component still to process is held in a queue alongside whether
    /// it's the caller's own original final component (see
    /// `resolve_entry_within_root`'s doc comment for why that one component
    /// alone can be exempt from dereferencing). When a component turns out
    /// to be a symlink, its target is *not* substituted as one opaque
    /// replacement path — that would only ever get the target's own last
    /// component checked against `root`, letting a target like
    /// `escaping_dir/secret.txt` (where `escaping_dir` is itself a symlink
    /// pointing outside `root`) slip through, since path resolution follows
    /// intermediate symlinks transparently at the OS level, so a later
    /// `lstat` on the substituted path would silently resolve straight
    /// through `escaping_dir` without ever reporting it as a symlink itself.
    /// Instead the target (always re-resolved as a fresh absolute path from
    /// the filesystem root, so a `..` or a further symlink inside it can't
    /// be used to sidestep this) has its own components spliced onto the
    /// front of the same queue, each one still exempt-ineligible (only the
    /// caller's true final component ever is), so every hop of the
    /// resulting chain is walked and re-checked for containment
    /// individually, one `lstat` at a time, exactly like every other
    /// component. A dangling target (or any other component that doesn't
    /// exist yet) is tolerated and accepted as a literal path segment,
    /// deferring to the real filesystem operation that follows to surface
    /// the appropriate error — needed for `create_file`'s never-existed leaf
    /// and `write_file`'s recreate-a-deleted-file path. Bounded at 40 total
    /// symlink hops across the whole walk (matching Linux's own `ELOOP`
    /// limit) against a cycle.
    fn resolve_within_root_impl(
        &self,
        path: &str,
        dereference_final: bool,
    ) -> Result<PathBuf, AppError> {
        let candidate = Path::new(path);
        let joined = if candidate.is_absolute() {
            candidate.to_path_buf()
        } else {
            self.root.join(candidate)
        };

        let normalized = normalize(&joined);
        let normalized_root = normalize(&self.root);

        if !normalized.starts_with(&normalized_root) {
            return Err(escapes_workspace_root(path));
        }

        // `self.root` always exists (it's an opened workspace), so
        // `canonicalize` — which resolves every ancestor component, unlike a
        // single-hop `lstat`+`readlink` — fully resolves it once up front:
        // on macOS, `/tmp` and `/var` are themselves symlinks (to
        // `/private/tmp`/`/private/var`), so a workspace opened under
        // either needs its root resolved the same way as every path checked
        // against it, or a legitimate in-workspace path would be spuriously
        // rejected as escaping a root that itself needed one more hop.
        let real_root = std::fs::canonicalize(&normalized_root).map_err(|e| map_io_err(e, path))?;
        let relative = normalized
            .strip_prefix(&normalized_root)
            .expect("normalized already checked to start with normalized_root above");

        let total = relative.components().count();
        let mut remaining: VecDeque<(OsString, bool)> = relative
            .components()
            .enumerate()
            .map(|(index, c)| (c.as_os_str().to_os_string(), index + 1 == total))
            .collect();

        let mut current = real_root.clone();
        let mut hops = 0u32;

        while let Some((component, is_original_final)) = remaining.pop_front() {
            // `delete`/`rename` act on the directory entry itself and must not
            // dereference their final component (matching `unlink(2)`/
            // `rename(2)`, which never follow the last path component either) —
            // see `resolve_entry_within_root`'s doc comment. Every other
            // component — including one spliced in from a symlink's own
            // target — is always dereferenced: an intermediate directory
            // symlink is exactly as capable of escaping `root` as a final one.
            if !is_original_final || dereference_final {
                let next = current.join(&component);
                match std::fs::symlink_metadata(&next) {
                    Ok(meta) if meta.file_type().is_symlink() => {
                        hops += 1;
                        if hops > 40 {
                            return Err(map_io_err(
                                io::Error::other("too many levels of symbolic links"),
                                path,
                            ));
                        }
                        let raw_target =
                            std::fs::read_link(&next).map_err(|e| map_io_err(e, path))?;
                        let target_joined = if raw_target.is_absolute() {
                            raw_target
                        } else {
                            current.join(&raw_target)
                        };
                        let normalized_target = normalize(&target_joined);
                        // A target is always re-resolved as a fresh absolute
                        // path from the filesystem root, one component at a
                        // time, rather than substituted whole — walking back
                        // down from `/` necessarily passes through `current`'s
                        // own ancestors before it can reach anywhere near
                        // `real_root` again, so containment can't be judged by
                        // strict prefix alone until the whole target is fully
                        // walked; `is_on_track_to_root` below tolerates that
                        // climb, and the check right after this loop is what
                        // actually enforces containment on the final result.
                        current = PathBuf::from("/");
                        let mut spliced: VecDeque<(OsString, bool)> = normalized_target
                            .components()
                            .filter(|c| !matches!(c, Component::RootDir))
                            .map(|c| (c.as_os_str().to_os_string(), false))
                            .collect();
                        spliced.append(&mut remaining);
                        remaining = spliced;
                    }
                    _ => {
                        current = next;
                        if !is_on_track_to_root(&current, &real_root) {
                            return Err(escapes_workspace_root(path));
                        }
                    }
                }
            } else {
                current.push(&component);
                if !is_on_track_to_root(&current, &real_root) {
                    return Err(escapes_workspace_root(path));
                }
            }
        }
        // The per-hop check above only rejects a path that has definitively
        // diverged from ever reaching `real_root`; while re-walking a target
        // down from `/`, `current` may still be a proper ancestor of
        // `real_root` (still "on track") right up until the last component is
        // consumed. This is the check that actually enforces containment on
        // the fully-resolved result.
        if !current.starts_with(&real_root) {
            return Err(escapes_workspace_root(path));
        }
        Ok(current)
    }

    /// Like `resolve_within_root` (the `Workspace` trait method, implemented
    /// below), but leaves the final path component un-dereferenced if it is
    /// itself a symlink — every ancestor is still
    /// resolved through its symlink chain and checked for containment, but the
    /// entry named by the final component is returned as-is. Matches
    /// `unlink(2)`/`rmdir(2)`/`rename(2)`'s own behavior of never following the
    /// last path component, and is what lets `delete`/`rename` keep acting on a
    /// symlink entry itself (removing or moving the link) rather than on
    /// whatever it points to, exactly as `LocalWorkspace::delete`'s recursive
    /// branch already documents for a symlinked directory.
    fn resolve_entry_within_root(&self, path: &str) -> Result<PathBuf, AppError> {
        self.resolve_within_root_impl(path, false)
    }
}

fn escapes_workspace_root(path: &str) -> AppError {
    AppError::InvalidPath(format!("path '{path}' escapes the workspace root"))
}

/// Whether `current` could still end up inside `real_root` once every
/// remaining path component is walked: either it's already there (or
/// beyond), or it's still a proper ancestor of `real_root` that further
/// components could yet descend into. Used mid-walk while re-resolving a
/// symlink target from the filesystem root, where `current` legitimately
/// passes through `real_root`'s own ancestors (e.g. `/tmp` on the way to
/// `/tmp/some-workspace`) before it can reach anywhere near it again — a
/// strict `starts_with` at every hop would reject that climb even for a
/// target that ultimately resolves inside `root`. Once a path fails both
/// directions it can never recover (no more `..` remain after
/// normalization), so this is safe to treat as a definitive escape.
fn is_on_track_to_root(current: &Path, real_root: &Path) -> bool {
    current.starts_with(real_root) || real_root.starts_with(current)
}

/// Maps a filesystem `io::Error` to `AppError::NotFound` when its kind is
/// `NotFound`, so a deleted-file read/write surfaces to the frontend as the
/// `NOT_FOUND` code it can act on (`markPathDeleted`), rather than the
/// generic `IO_ERROR` every other I/O failure (permissions, disk full)
/// serializes as.
fn map_io_err(err: io::Error, path: &str) -> AppError {
    if err.kind() == io::ErrorKind::NotFound {
        AppError::NotFound(path.to_string())
    } else {
        AppError::Io(err)
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

/// `fsync`s `file`, using macOS's `F_FULLFSYNC` when available for a true
/// flush-to-media guarantee (`fsync(2)` on macOS only flushes to the drive's
/// write cache, not the physical medium — the same gap SQLite works around
/// the same way). Falls back to a plain `fsync` if `F_FULLFSYNC` isn't
/// supported on the target filesystem (some network/removable volumes return
/// `ENOTSUP`) rather than failing the save over it.
fn fsync_full(file: &std::fs::File) -> io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::io::AsRawFd;
        let rc = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_FULLFSYNC) };
        if rc == 0 {
            return Ok(());
        }
    }
    file.sync_all()
}

/// Reports whether the current process can write to `path`, via `access(2)`
/// — the same check `open(2)` itself makes, and more faithful than
/// `Permissions::readonly()` (which only inspects the mode bits and ignores
/// the process's actual effective uid/gid).
fn is_writable(path: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(c_path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    unsafe { libc::access(c_path.as_ptr(), libc::W_OK) == 0 }
}

/// Writes `contents` to `target` atomically and durably: writes to a fresh
/// temp file in `target`'s directory, `fsync`s it, renames it onto `target`,
/// then `fsync`s the containing directory so the rename itself survives a
/// crash. `target` is expected to already be resolved past any symlink by
/// the caller (`resolve_within_root`) — if the original path a user saved
/// through was itself a symlink, the symlink is left untouched and its
/// target updated in place, since `target` here is already that real path,
/// never the link's own path. An existing target that isn't writable fails
/// with `PermissionDenied` up front, rather than being silently clobbered by
/// a `rename(2)` that only checks the containing directory's permissions,
/// not the file it's about to replace.
fn atomic_write(target: &Path, contents: &[u8]) -> io::Result<()> {
    let dir = target.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "target has no parent directory",
        )
    })?;

    let existing = std::fs::metadata(target).ok();
    if existing.is_some() && !is_writable(target) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "target is not writable",
        ));
    }
    let permissions = existing
        .map(|meta| meta.permissions())
        .unwrap_or_else(|| std::fs::Permissions::from_mode(0o644));

    let mut builder = tempfile::Builder::new();
    builder.prefix(".atrium-save-");

    let mut tmp = builder.tempfile_in(dir)?;
    // `Builder::permissions` would only feed the mode to `open(2)`, which the
    // process umask then masks — using `set_permissions` (`fchmod`) here
    // instead applies the mode directly, so the target's permissions (or the
    // `0o644` default for a new file) survive intact regardless of umask.
    tmp.as_file().set_permissions(permissions)?;
    tmp.write_all(contents)?;
    fsync_full(tmp.as_file())?;

    tmp.persist(target).map_err(|e| e.error)?;

    let dir_file = std::fs::File::open(dir)?;
    fsync_full(&dir_file)?;

    Ok(())
}

/// Picks a collision-free path for `name` inside `dest_dir`: `dest_dir/name`
/// itself if nothing is there yet, otherwise `"{stem} copy{.ext}"`, then
/// `"{stem} copy 2{.ext}"`, `"{stem} copy 3{.ext}"`, ... — mirroring macOS
/// Finder's own copy-into-same-directory naming convention. `symlink_metadata`
/// (not `exists`, which follows symlinks and would misreport a broken symlink
/// as "free") is what decides whether a candidate name is taken.
///
/// `is_dir` suppresses extension-splitting for a directory name (a
/// `.git`-style dotted directory shouldn't be treated as having an
/// "extension"); a file's stem/extension are split on its last `.`, except a
/// leading dot (a dotfile like `.gitignore`), which is treated as part of the
/// stem rather than an empty name with an extension.
fn unique_destination(dest_dir: &Path, name: &str, is_dir: bool) -> Result<PathBuf, AppError> {
    let candidate = dest_dir.join(name);
    if candidate.symlink_metadata().is_err() {
        return Ok(candidate);
    }

    let (stem, ext) = if is_dir {
        (name, "")
    } else {
        match name.rfind('.') {
            Some(idx) if idx > 0 => (&name[..idx], &name[idx..]),
            _ => (name, ""),
        }
    };

    for n in 1..=MAX_COLLISION_ATTEMPTS {
        let candidate_name = if n == 1 {
            format!("{stem} copy{ext}")
        } else {
            format!("{stem} copy {n}{ext}")
        };
        let candidate = dest_dir.join(&candidate_name);
        if candidate.symlink_metadata().is_err() {
            return Ok(candidate);
        }
    }

    Err(AppError::Other(format!(
        "could not find a free name for '{name}' in the destination directory"
    )))
}

/// Recursively copies `source` (anywhere on disk) to `dest` (inside a
/// workspace), preserving symlinks rather than following them: each entry is
/// inspected with `symlink_metadata` so a symlink is recreated as a symlink
/// pointing at the same target instead of being dereferenced. This also
/// keeps the walk from infinitely recursing through a self-referential
/// directory symlink, since a symlink is never treated as a directory to
/// descend into.
///
/// Boxed and manually recursive (async fns can't call themselves directly)
/// with an explicit `'a` lifetime tying the returned future to both borrowed
/// path arguments.
fn copy_recursive<'a>(
    source: &'a Path,
    dest: &'a Path,
) -> Pin<Box<dyn Future<Output = Result<(), AppError>> + Send + 'a>> {
    Box::pin(async move {
        let metadata = tokio::fs::symlink_metadata(source).await?;
        let file_type = metadata.file_type();
        if file_type.is_symlink() {
            let target = tokio::fs::read_link(source).await?;
            std::os::unix::fs::symlink(&target, dest)?;
        } else if file_type.is_dir() {
            tokio::fs::create_dir_all(dest).await?;
            let mut read_dir = tokio::fs::read_dir(source).await?;
            while let Some(entry) = read_dir.next_entry().await? {
                let child_dest = dest.join(entry.file_name());
                copy_recursive(&entry.path(), &child_dest).await?;
            }
        } else {
            tokio::fs::copy(source, dest).await?;
        }
        Ok(())
    })
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
            let entry_path = entry.path();
            // Non-following (equivalent to `lstat`, and free on most Unix
            // platforms since it's cached from the `readdir` stream): answers
            // "is this entry itself a symlink" without an extra syscall.
            let file_type = entry.file_type().await?;
            let is_symlink = file_type.is_symlink();
            // A symlink's own `is_dir` must reflect its *target*, not the link —
            // `entry.metadata()` (used here previously) does not traverse
            // symlinks on Unix and always reports `false` for one. Take a
            // following stat only in this case; a dangling or unreadable target
            // degrades to `is_dir: false` (rendered as a file, matching how an
            // unreadable/dangling symlink-to-file already behaves) rather than
            // failing the whole directory listing over one broken link.
            let is_dir = if is_symlink {
                tokio::fs::metadata(&entry_path)
                    .await
                    .map(|m| m.is_dir())
                    .unwrap_or(false)
            } else {
                file_type.is_dir()
            };
            entries.push(DirEntry {
                name,
                path: entry_path.to_string_lossy().to_string(),
                is_dir,
                is_symlink,
            });
        }
        entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        });
        Ok(entries)
    }

    /// Reads `path`'s entire contents as UTF-8. Rejects files over
    /// `MAX_READABLE_FILE_SIZE_BYTES` with `AppError::FileTooLarge`, checked
    /// via a cheap `stat` before the read rather than reading-then-discarding.
    async fn read_file(&self, path: &str) -> Result<String, AppError> {
        let file = self.resolve_within_root(path)?;
        let metadata = tokio::fs::metadata(&file)
            .await
            .map_err(|e| map_io_err(e, path))?;
        if metadata.len() > MAX_READABLE_FILE_SIZE_BYTES {
            return Err(AppError::FileTooLarge {
                path: path.to_string(),
                size: metadata.len(),
                limit: MAX_READABLE_FILE_SIZE_BYTES,
            });
        }
        let bytes = tokio::fs::read(&file)
            .await
            .map_err(|e| map_io_err(e, path))?;
        String::from_utf8(bytes).map_err(|_| AppError::NotUtf8(path.to_string()))
    }

    /// Writes `contents` atomically and durably: the new content lands via a
    /// temp-file-write-fsync-rename sequence (see `atomic_write`), so a crash
    /// or power loss mid-save never leaves the file truncated or partially
    /// written. If `path` is a symlink, the symlink itself is preserved and
    /// its target is updated in place, matching every other symlink-aware
    /// operation in this file. A missing path (with an existing parent
    /// directory) is created, matching the previous `tokio::fs::write`
    /// behavior — this is relied on by the externally-deleted-file recovery
    /// flow, where a dirty tab is kept open and a later save recreates the
    /// file.
    async fn write_file(&self, path: &str, contents: &str) -> Result<(), AppError> {
        let file = self.resolve_within_root(path)?;
        let contents = contents.as_bytes().to_vec();
        tokio::task::spawn_blocking(move || atomic_write(&file, &contents))
            .await
            .map_err(|err| AppError::Other(format!("save task panicked: {err}")))?
            .map_err(|e| map_io_err(e, path))?;
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
        let from_path = self.resolve_entry_within_root(from)?;
        let to_path = self.resolve_entry_within_root(to)?;
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
        // symlink whose target is the destination (or vice versa) would otherwise compare
        // equal to that target and be let through to clobber it. Excluding a symlink on
        // either side keeps identity judged on the entries being renamed rather than what
        // either one points at; the accepted trade-off is that a symlink can no longer be
        // case-only-renamed on a case-insensitive volume (rejecting that is recoverable,
        // unlike the alternative) — the only case where the destination is a symlink and
        // genuinely is the same entry as the source.
        if to_path.exists() {
            let from_is_symlink = from_path
                .symlink_metadata()
                .is_ok_and(|m| m.file_type().is_symlink());
            let to_is_symlink = to_path
                .symlink_metadata()
                .is_ok_and(|m| m.file_type().is_symlink());
            let same_entry = !from_is_symlink
                && !to_is_symlink
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
        let target = self.resolve_entry_within_root(path)?;
        let metadata = tokio::fs::metadata(&target).await?;
        if metadata.is_dir() {
            if recursive {
                // Safe against `target` itself being a symlink to a directory:
                // `remove_dir_all` does an `lstat` at the top of the path, and
                // if that's a symlink it unlinks the link and stops rather than
                // following it and recursing into the target's contents. Same
                // guarantee holds for a symlink encountered as a child while
                // recursing into a real directory — the recursion never escapes
                // through it.
                tokio::fs::remove_dir_all(&target).await?;
            } else {
                tokio::fs::remove_dir(&target).await?;
            }
        } else {
            tokio::fs::remove_file(&target).await?;
        }
        Ok(())
    }

    async fn import_external(
        &self,
        dest_dir: &str,
        source_paths: &[String],
    ) -> Result<(), AppError> {
        let dest = self.resolve_within_root(dest_dir)?;
        let dest_metadata = tokio::fs::metadata(&dest).await.map_err(|_| {
            AppError::InvalidPath(format!("destination '{dest_dir}' does not exist"))
        })?;
        if !dest_metadata.is_dir() {
            return Err(AppError::InvalidPath(format!(
                "destination '{dest_dir}' is not a directory"
            )));
        }

        for source in source_paths {
            let source_path = Path::new(source);
            let name = source_path
                .file_name()
                .ok_or_else(|| {
                    AppError::InvalidPath(format!("source path '{source}' has no file name"))
                })?
                .to_string_lossy()
                .to_string();
            let source_metadata = tokio::fs::symlink_metadata(source_path).await?;
            let target = unique_destination(&dest, &name, source_metadata.is_dir())?;
            copy_recursive(source_path, &target).await?;
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

    async fn find_files(&self, query: &str) -> Result<FileSearchResults, AppError> {
        let root = self.root.clone();
        let generation = self.find_files_generation.fetch_add(1, Ordering::SeqCst) + 1;
        let current_generation = self.find_files_generation.clone();
        let query = query.to_string();

        tokio::task::spawn_blocking(move || {
            let (paths, deadline_hit) =
                find_files_root(&root, &current_generation, generation, SEARCH_DEADLINE);

            if query.is_empty() {
                let mut entries: Vec<(String, String)> = paths
                    .into_iter()
                    .map(|path| {
                        let display = display_path(&root, &path);
                        (path, display)
                    })
                    .collect();
                entries.sort_by(|a, b| a.1.cmp(&b.1));
                let truncated = deadline_hit || entries.len() > FIND_FILES_RESULT_CAP;
                entries.truncate(FIND_FILES_RESULT_CAP);
                FileSearchResults {
                    matches: entries
                        .into_iter()
                        .map(|(path, display_path)| FileMatch {
                            path,
                            display_path,
                            score: 0,
                            match_indices: Vec::new(),
                        })
                        .collect(),
                    truncated,
                }
            } else {
                let mut matcher = FuzzyMatcher::new(Config::DEFAULT.match_paths());
                // `Pattern`, not a single `Matcher::fuzzy_indices` call:
                // splits the query on whitespace into independent atoms
                // (`Pattern::indices` requires every atom to match, summing
                // their scores) so a multi-word query like "readme devloop"
                // matches `dev-loop/README.md` by fuzzy-matching "readme"
                // and "devloop" separately against the full path, rather
                // than requiring the literal (space-containing) query to
                // appear as one ordered subsequence.
                let pattern = Pattern::new(
                    &query,
                    CaseMatching::Ignore,
                    Normalization::Smart,
                    AtomKind::Fuzzy,
                );

                let mut scored: Vec<FileMatch> = Vec::new();
                for path in paths {
                    let display = display_path(&root, &path);
                    let mut haystack_buf = Vec::new();
                    let haystack = Utf32Str::new(&display, &mut haystack_buf);
                    let mut match_indices = Vec::new();
                    if let Some(score) = pattern.indices(haystack, &mut matcher, &mut match_indices)
                    {
                        // Each atom's indices are appended independently and
                        // not deduplicated against each other (`Pattern::indices`'s
                        // own doc), so sorting/deduping here is what
                        // guarantees a strictly ascending, gap-free sequence
                        // overall — exactly what the frontend's
                        // `highlightSegments` coalescing walk assumes.
                        match_indices.sort_unstable();
                        match_indices.dedup();
                        scored.push(FileMatch {
                            path,
                            display_path: display,
                            score: score as i64,
                            match_indices,
                        });
                    }
                }

                // Score descending; ties broken by shorter path (the
                // standard fzf/telescope tie-break, favoring the more
                // specific/closer match), then alphabetically for a
                // deterministic order.
                scored.sort_by(|a, b| {
                    b.score
                        .cmp(&a.score)
                        .then_with(|| a.display_path.len().cmp(&b.display_path.len()))
                        .then_with(|| a.display_path.cmp(&b.display_path))
                });

                let truncated = deadline_hit || scored.len() > FIND_FILES_RESULT_CAP;
                scored.truncate(FIND_FILES_RESULT_CAP);

                FileSearchResults {
                    matches: scored,
                    truncated,
                }
            }
        })
        .await
        .map_err(|err| AppError::Other(format!("find_files task panicked: {err}")))
    }

    fn root(&self) -> &str {
        self.root.to_str().unwrap_or("")
    }

    fn resolve_within_root(&self, path: &str) -> Result<PathBuf, AppError> {
        self.resolve_within_root_impl(path, true)
    }

    fn watch(&self, tx: UnboundedSender<FsChangeEvent>) {
        let mut guard = self.watcher.lock().unwrap();
        if guard.is_some() {
            return;
        }
        match fs_watch::watch(self.root().to_string(), self.workspace_id.clone(), tx) {
            Ok(debouncer) => *guard = Some(debouncer),
            Err(err) => {
                // Setup failure (e.g. the inotify watch limit is exhausted, or
                // the root disappeared between selection and registration)
                // gets the same posture as a watcher that fails mid-session in
                // fs_watch::watch's own debounce callback: the workspace opens
                // and stays fully usable, it just does not receive live
                // external-change notifications until reopened.
                eprintln!(
                    "atrium: failed to start fs watcher for workspace {}: {err}",
                    self.workspace_id
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc::unbounded_channel;

    fn workspace(root: &Path) -> LocalWorkspace {
        LocalWorkspace::new("local".to_string(), root.to_path_buf())
    }

    #[tokio::test]
    async fn watch_does_not_panic_when_the_root_does_not_exist() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("gone");
        let ws = workspace(&missing);
        let (tx, _rx) = unbounded_channel();
        ws.watch(tx); // must not panic
        assert!(ws.watcher.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn rejects_parent_dir_escape() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        let err = ws.read_file("../outside.txt").await.unwrap_err();
        assert!(matches!(err, AppError::InvalidPath(_)));
    }

    #[tokio::test]
    async fn read_file_succeeds_through_a_canonically_spelled_symlink_when_the_root_sits_behind_a_symlinked_ancestor(
    ) {
        let base = tempfile::tempdir().unwrap();
        let real_dir = base.path().join("real");
        std::fs::create_dir_all(real_dir.join("ws")).unwrap();
        std::os::unix::fs::symlink(&real_dir, base.path().join("ancestor_link")).unwrap();

        // The workspace is opened through the symlinked ancestor (mirroring
        // macOS's `/tmp` -> `/private/tmp`), but the in-workspace symlink's
        // own target is spelled via the *canonical*, ancestor-symlink-free
        // path — exactly what a real editor or OS tool would produce.
        let workspace_root = base.path().join("ancestor_link").join("ws");
        let ws = workspace(&workspace_root);
        std::fs::write(real_dir.join("ws").join("note.txt"), "hello").unwrap();
        std::os::unix::fs::symlink(
            real_dir.join("ws").join("note.txt"),
            workspace_root.join("link.txt"),
        )
        .unwrap();

        assert_eq!(ws.read_file("link.txt").await.unwrap(), "hello");
    }

    #[tokio::test]
    async fn read_file_of_a_missing_path_maps_to_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        let err = ws.read_file("missing.md").await.unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }

    #[tokio::test]
    async fn read_file_rejects_a_symlink_escaping_the_workspace_root() {
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), "top secret").unwrap();

        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        std::os::unix::fs::symlink(
            outside.path().join("secret.txt"),
            dir.path().join("link.txt"),
        )
        .unwrap();

        let err = ws.read_file("link.txt").await.unwrap_err();
        assert!(matches!(err, AppError::InvalidPath(_)));
        assert_eq!(
            std::fs::read_to_string(outside.path().join("secret.txt")).unwrap(),
            "top secret"
        );
    }

    #[tokio::test]
    async fn read_file_rejects_an_escape_through_a_chain_of_two_symlinks() {
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), "top secret").unwrap();

        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        // `escaping_dir` is a symlink to a directory outside the workspace;
        // `innocent.txt`'s own target is a *relative* path spelled through
        // `escaping_dir`, which never itself appears in the user-supplied
        // path — only in another symlink's target. `escaping_dir`'s own
        // resolution must still be checked when `innocent.txt` is followed.
        std::os::unix::fs::symlink(outside.path(), dir.path().join("escaping_dir")).unwrap();
        std::os::unix::fs::symlink(
            Path::new("escaping_dir").join("secret.txt"),
            dir.path().join("innocent.txt"),
        )
        .unwrap();

        let err = ws.read_file("innocent.txt").await.unwrap_err();
        assert!(matches!(err, AppError::InvalidPath(_)));
    }

    #[tokio::test]
    async fn read_file_rejects_an_escape_through_an_absolute_symlink_target_naming_another_symlink()
    {
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), "top secret").unwrap();

        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        std::os::unix::fs::symlink(outside.path(), dir.path().join("escaping_dir")).unwrap();
        // Same chain as `read_file_rejects_an_escape_through_a_chain_of_two_symlinks`,
        // but `innocent.txt`'s own target is spelled as an *absolute* path
        // through `escaping_dir` rather than a relative one.
        std::os::unix::fs::symlink(
            dir.path().join("escaping_dir").join("secret.txt"),
            dir.path().join("innocent.txt"),
        )
        .unwrap();

        let err = ws.read_file("innocent.txt").await.unwrap_err();
        assert!(matches!(err, AppError::InvalidPath(_)));
    }

    #[tokio::test]
    async fn read_file_rejects_a_file_over_the_size_limit() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        let path = dir.path().join("huge.txt");
        // A sparse/truncated file keeps this test fast — the guard only
        // needs `metadata.len()` to report the size, not real file content.
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(MAX_READABLE_FILE_SIZE_BYTES + 1).unwrap();

        let err = ws.read_file("huge.txt").await.unwrap_err();
        match err {
            AppError::FileTooLarge { path, size, limit } => {
                assert_eq!(path, "huge.txt");
                assert_eq!(size, MAX_READABLE_FILE_SIZE_BYTES + 1);
                assert_eq!(limit, MAX_READABLE_FILE_SIZE_BYTES);
            }
            other => panic!("expected FileTooLarge, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn read_file_accepts_a_file_at_exactly_the_size_limit() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        let path = dir.path().join("exact.txt");
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(MAX_READABLE_FILE_SIZE_BYTES).unwrap();

        ws.read_file("exact.txt").await.unwrap();
    }

    #[tokio::test]
    async fn read_file_accepts_a_file_just_under_the_size_limit() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        let path = dir.path().join("under.txt");
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(MAX_READABLE_FILE_SIZE_BYTES - 1).unwrap();

        ws.read_file("under.txt").await.unwrap();
    }

    #[tokio::test]
    async fn write_file_into_a_deleted_directory_maps_to_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        tokio::fs::create_dir(dir.path().join("sub")).await.unwrap();
        tokio::fs::remove_dir(dir.path().join("sub")).await.unwrap();
        let err = ws.write_file("sub/note.md", "hello").await.unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
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
    async fn write_file_replaces_a_symlinks_target_and_preserves_the_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        ws.create_file("real.md").await.unwrap();
        ws.write_file("real.md", "original").await.unwrap();
        std::os::unix::fs::symlink(dir.path().join("real.md"), dir.path().join("link.md")).unwrap();

        ws.write_file("link.md", "updated").await.unwrap();

        let link_meta = dir.path().join("link.md").symlink_metadata().unwrap();
        assert!(link_meta.file_type().is_symlink());
        assert_eq!(
            std::fs::read_link(dir.path().join("link.md")).unwrap(),
            dir.path().join("real.md")
        );
        assert_eq!(ws.read_file("real.md").await.unwrap(), "updated");
    }

    #[tokio::test]
    async fn write_file_through_a_dangling_symlink_creates_its_target() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        std::os::unix::fs::symlink(dir.path().join("missing.md"), dir.path().join("link.md"))
            .unwrap();

        ws.write_file("link.md", "hello").await.unwrap();

        let link_meta = dir.path().join("link.md").symlink_metadata().unwrap();
        assert!(link_meta.file_type().is_symlink());
        assert_eq!(ws.read_file("missing.md").await.unwrap(), "hello");
    }

    #[tokio::test]
    async fn write_file_rejects_a_symlink_escaping_the_workspace_root() {
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), "original").unwrap();

        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        std::os::unix::fs::symlink(
            outside.path().join("secret.txt"),
            dir.path().join("link.txt"),
        )
        .unwrap();

        let err = ws.write_file("link.txt", "clobbered").await.unwrap_err();
        assert!(matches!(err, AppError::InvalidPath(_)));
        assert_eq!(
            std::fs::read_to_string(outside.path().join("secret.txt")).unwrap(),
            "original"
        );
    }

    #[tokio::test]
    async fn write_file_rejects_a_dangling_symlink_whose_target_escapes_the_workspace_root() {
        let outside = tempfile::tempdir().unwrap();

        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        std::os::unix::fs::symlink(
            outside.path().join("new_secret.txt"),
            dir.path().join("link.txt"),
        )
        .unwrap();

        let err = ws.write_file("link.txt", "hello").await.unwrap_err();
        assert!(matches!(err, AppError::InvalidPath(_)));
        assert!(!outside.path().join("new_secret.txt").exists());
    }

    #[tokio::test]
    async fn write_file_rejects_an_escape_through_a_chain_of_two_symlinks() {
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), "original").unwrap();

        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        std::os::unix::fs::symlink(outside.path(), dir.path().join("escaping_dir")).unwrap();
        std::os::unix::fs::symlink(
            Path::new("escaping_dir").join("secret.txt"),
            dir.path().join("innocent.txt"),
        )
        .unwrap();

        let err = ws
            .write_file("innocent.txt", "clobbered")
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::InvalidPath(_)));
        assert_eq!(
            std::fs::read_to_string(outside.path().join("secret.txt")).unwrap(),
            "original"
        );
    }

    #[tokio::test]
    async fn write_file_preserves_existing_file_permissions() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        ws.create_file("script.sh").await.unwrap();
        // 0o666 (rather than e.g. 0o755) deliberately includes bits a common
        // process umask (022 or 002) would mask off if the temp file's mode
        // were merely passed to `open(2)` instead of `fchmod`'d afterward —
        // 0o755 has no write-for-other/group bit to clear, so it can't catch
        // that class of bug.
        std::fs::set_permissions(
            dir.path().join("script.sh"),
            std::fs::Permissions::from_mode(0o666),
        )
        .unwrap();

        ws.write_file("script.sh", "#!/bin/sh\necho hi")
            .await
            .unwrap();

        let mode = std::fs::metadata(dir.path().join("script.sh"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o666);
    }

    #[tokio::test]
    async fn write_file_over_a_read_only_target_fails_and_leaves_it_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        ws.create_file("locked.md").await.unwrap();
        ws.write_file("locked.md", "original").await.unwrap();
        std::fs::set_permissions(
            dir.path().join("locked.md"),
            std::fs::Permissions::from_mode(0o444),
        )
        .unwrap();

        let err = ws.write_file("locked.md", "clobbered").await.unwrap_err();
        assert!(matches!(err, AppError::Io(_)));
        assert_eq!(ws.read_file("locked.md").await.unwrap(), "original");
        let mode = std::fs::metadata(dir.path().join("locked.md"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o444);

        // Restore write permission so the tempdir can clean itself up.
        std::fs::set_permissions(
            dir.path().join("locked.md"),
            std::fs::Permissions::from_mode(0o644),
        )
        .unwrap();
    }

    #[tokio::test]
    async fn write_file_leaves_no_temp_file_behind() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        ws.create_file("note.md").await.unwrap();

        ws.write_file("note.md", "hello").await.unwrap();

        let entries: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(entries, vec![std::ffi::OsString::from("note.md")]);
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
    async fn create_file_rejects_a_path_under_an_ancestor_symlink_that_escapes_the_workspace_root()
    {
        let outside = tempfile::tempdir().unwrap();

        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        std::os::unix::fs::symlink(outside.path(), dir.path().join("escaping_link")).unwrap();

        let err = ws.create_file("escaping_link/new.md").await.unwrap_err();
        assert!(matches!(err, AppError::InvalidPath(_)));
        assert!(!outside.path().join("new.md").exists());
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
    async fn rename_rejects_a_target_onto_its_own_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        ws.create_file("notes.md").await.unwrap();
        ws.write_file("notes.md", "keep me").await.unwrap();
        std::os::unix::fs::symlink(dir.path().join("notes.md"), dir.path().join("link.md"))
            .unwrap();

        // The inverse of `rename_rejects_a_symlink_onto_its_own_target`: `notes.md`
        // canonicalizes to the same real path as `link.md`, but renaming onto a symlink
        // destination must still be a collision, not a silent replacement of the link.
        let err = ws.rename("notes.md", "link.md").await.unwrap_err();
        assert!(matches!(err, AppError::AlreadyExists(_)));
        assert!(dir.path().join("notes.md").exists());
        assert!(dir.path().join("link.md").symlink_metadata().is_ok());
    }

    #[tokio::test]
    async fn rename_of_a_symlink_escaping_the_workspace_root_renames_the_link_entry() {
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), "hi").unwrap();

        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        std::os::unix::fs::symlink(
            outside.path().join("secret.txt"),
            dir.path().join("link.txt"),
        )
        .unwrap();

        ws.rename("link.txt", "renamed.txt").await.unwrap();

        assert!(dir.path().join("link.txt").symlink_metadata().is_err());
        let renamed_meta = dir.path().join("renamed.txt").symlink_metadata().unwrap();
        assert!(renamed_meta.file_type().is_symlink());
        assert_eq!(
            std::fs::read_link(dir.path().join("renamed.txt")).unwrap(),
            outside.path().join("secret.txt")
        );
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
    async fn delete_removes_a_symlinked_directory_without_touching_its_target() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        ws.create_dir("real_dir").await.unwrap();
        ws.create_file("real_dir/inside.md").await.unwrap();
        ws.write_file("real_dir/inside.md", "keep me")
            .await
            .unwrap();
        std::os::unix::fs::symlink(dir.path().join("real_dir"), dir.path().join("link_dir"))
            .unwrap();

        // `recursive: true` is what the frontend now sends for a symlinked
        // directory once `list_dir` reports its `is_dir` correctly.
        ws.delete("link_dir", true).await.unwrap();

        assert!(dir.path().join("link_dir").symlink_metadata().is_err());
        assert!(dir.path().join("real_dir").exists());
        assert_eq!(ws.read_file("real_dir/inside.md").await.unwrap(), "keep me");
    }

    #[tokio::test]
    async fn delete_of_a_symlink_escaping_the_workspace_root_only_unlinks_the_link() {
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), "keep me").unwrap();

        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        std::os::unix::fs::symlink(
            outside.path().join("secret.txt"),
            dir.path().join("link.txt"),
        )
        .unwrap();

        ws.delete("link.txt", false).await.unwrap();

        assert!(dir.path().join("link.txt").symlink_metadata().is_err());
        assert_eq!(
            std::fs::read_to_string(outside.path().join("secret.txt")).unwrap(),
            "keep me"
        );
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

    #[tokio::test]
    async fn list_dir_reports_a_symlinked_directory_as_a_directory() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        ws.create_dir("real_dir").await.unwrap();
        ws.create_file("real_dir/inside.md").await.unwrap();
        std::os::unix::fs::symlink(dir.path().join("real_dir"), dir.path().join("link_dir"))
            .unwrap();

        let entries = ws.list_dir(".").await.unwrap();
        let link = entries.iter().find(|e| e.name == "link_dir").unwrap();

        assert!(link.is_dir);
        assert!(link.is_symlink);
    }

    #[tokio::test]
    async fn list_dir_reports_a_symlinked_file_as_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        ws.create_file("real.md").await.unwrap();
        std::os::unix::fs::symlink(dir.path().join("real.md"), dir.path().join("link.md")).unwrap();

        let entries = ws.list_dir(".").await.unwrap();
        let link = entries.iter().find(|e| e.name == "link.md").unwrap();

        assert!(!link.is_dir);
        assert!(link.is_symlink);
    }

    #[tokio::test]
    async fn list_dir_reports_a_dangling_symlink_as_not_a_directory() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        std::os::unix::fs::symlink(dir.path().join("does_not_exist"), dir.path().join("broken"))
            .unwrap();

        let entries = ws.list_dir(".").await.unwrap();
        let link = entries.iter().find(|e| e.name == "broken").unwrap();

        assert!(!link.is_dir);
        assert!(link.is_symlink);
    }

    #[tokio::test]
    async fn list_dir_rejects_a_directory_symlink_escaping_the_workspace_root() {
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), "hi").unwrap();

        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        std::os::unix::fs::symlink(outside.path(), dir.path().join("link_dir")).unwrap();

        let err = ws.list_dir("link_dir").await.unwrap_err();
        assert!(matches!(err, AppError::InvalidPath(_)));
    }

    #[tokio::test]
    async fn list_dir_rejects_an_escape_through_a_chain_of_two_symlinks() {
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir(outside.path().join("subdir")).unwrap();
        std::fs::write(outside.path().join("subdir").join("secret.txt"), "hi").unwrap();

        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        std::os::unix::fs::symlink(outside.path(), dir.path().join("escaping_dir")).unwrap();
        std::os::unix::fs::symlink(
            Path::new("escaping_dir").join("subdir"),
            dir.path().join("chain_dir"),
        )
        .unwrap();

        let err = ws.list_dir("chain_dir").await.unwrap_err();
        assert!(matches!(err, AppError::InvalidPath(_)));
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
    async fn search_returns_exactly_the_total_cap_without_truncation() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        // One match per file, spread across exactly SEARCH_TOTAL_MATCH_CAP
        // files, so the per-file cap can't be what limits the count and the
        // result set lands exactly on the total cap with nothing dropped.
        for i in 0..SEARCH_TOTAL_MATCH_CAP {
            let name = format!("file{i}.txt");
            ws.create_file(&name).await.unwrap();
            ws.write_file(&name, "needle\n").await.unwrap();
        }

        let results = ws.search("needle", options(false, false)).await.unwrap();

        assert_eq!(results.matches.len(), SEARCH_TOTAL_MATCH_CAP);
        assert!(!results.truncated);
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
    async fn search_reports_truncated_for_a_lone_match_just_beyond_the_cap() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        // SEARCH_TOTAL_MATCH_CAP matching files plus exactly one more,
        // diluted among a large set of non-matching filler files. This is
        // the case an entry-level "count already at cap, quit" shortcut
        // gets wrong: once the count reaches the cap, every remaining
        // directory entry (including the one holding the last, over-the-cap
        // match) gets skipped without ever being opened, so
        // `total_cap_hit` never fires and `truncated` is never set —
        // silently under-reporting instead of flagging the drop.
        let matching_files = SEARCH_TOTAL_MATCH_CAP + 1;
        let filler_files = 2000;
        for i in 0..matching_files {
            let name = format!("match{i:04}.txt");
            ws.create_file(&name).await.unwrap();
            ws.write_file(&name, "needle\n").await.unwrap();
        }
        for i in 0..filler_files {
            let name = format!("filler{i:04}.txt");
            ws.create_file(&name).await.unwrap();
            ws.write_file(&name, "no match here\n").await.unwrap();
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

    #[tokio::test]
    async fn import_external_copies_a_single_file_into_an_empty_destination() {
        let source_dir = tempfile::tempdir().unwrap();
        std::fs::write(source_dir.path().join("photo.png"), b"pixels").unwrap();

        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        ws.create_dir("dest").await.unwrap();

        ws.import_external(
            "dest",
            &[source_dir
                .path()
                .join("photo.png")
                .to_string_lossy()
                .to_string()],
        )
        .await
        .unwrap();

        let copied = dir.path().join("dest").join("photo.png");
        assert_eq!(std::fs::read(copied).unwrap(), b"pixels");
    }

    #[tokio::test]
    async fn import_external_copies_a_directory_recursively() {
        let source_dir = tempfile::tempdir().unwrap();
        let project = source_dir.path().join("project");
        std::fs::create_dir_all(project.join("src")).unwrap();
        std::fs::write(project.join("README.md"), "hello").unwrap();
        std::fs::write(project.join("src/main.rs"), "fn main() {}").unwrap();

        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        ws.create_dir("dest").await.unwrap();

        ws.import_external("dest", &[project.to_string_lossy().to_string()])
            .await
            .unwrap();

        let copied = dir.path().join("dest").join("project");
        assert_eq!(
            std::fs::read_to_string(copied.join("README.md")).unwrap(),
            "hello"
        );
        assert_eq!(
            std::fs::read_to_string(copied.join("src/main.rs")).unwrap(),
            "fn main() {}"
        );
    }

    #[tokio::test]
    async fn import_external_dedupes_a_file_name_collision_preserving_the_extension() {
        let source_dir = tempfile::tempdir().unwrap();
        std::fs::write(source_dir.path().join("notes.txt"), "from finder").unwrap();

        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        ws.create_file("notes.txt").await.unwrap();
        ws.write_file("notes.txt", "already here").await.unwrap();

        let source = source_dir
            .path()
            .join("notes.txt")
            .to_string_lossy()
            .to_string();
        ws.import_external(".", std::slice::from_ref(&source))
            .await
            .unwrap();
        ws.import_external(".", &[source]).await.unwrap();

        assert_eq!(ws.read_file("notes.txt").await.unwrap(), "already here");
        assert_eq!(ws.read_file("notes copy.txt").await.unwrap(), "from finder");
        assert_eq!(
            ws.read_file("notes copy 2.txt").await.unwrap(),
            "from finder"
        );
    }

    #[tokio::test]
    async fn import_external_dedupes_a_directory_name_collision_without_extension_splitting() {
        let source_dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(source_dir.path().join("assets")).unwrap();
        std::fs::write(source_dir.path().join("assets/file.txt"), "one").unwrap();

        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        ws.create_dir("assets").await.unwrap();

        let source = source_dir
            .path()
            .join("assets")
            .to_string_lossy()
            .to_string();
        ws.import_external(".", &[source]).await.unwrap();

        // A directory name has no extension to preserve, so the collision
        // suffix goes straight on the end rather than splitting at a `.`
        // that might appear inside the name (e.g. a dotted directory name).
        let copied = dir.path().join("assets copy").join("file.txt");
        assert_eq!(std::fs::read_to_string(copied).unwrap(), "one");
    }

    #[tokio::test]
    async fn import_external_preserves_a_symlink_inside_a_copied_directory() {
        let source_dir = tempfile::tempdir().unwrap();
        let project = source_dir.path().join("project");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(source_dir.path().join("target.txt"), "real file").unwrap();
        std::os::unix::fs::symlink(
            source_dir.path().join("target.txt"),
            project.join("link.txt"),
        )
        .unwrap();

        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        ws.create_dir("dest").await.unwrap();

        ws.import_external("dest", &[project.to_string_lossy().to_string()])
            .await
            .unwrap();

        let copied_link = dir.path().join("dest").join("project").join("link.txt");
        let link_metadata = std::fs::symlink_metadata(&copied_link).unwrap();
        assert!(link_metadata.file_type().is_symlink());
        assert_eq!(
            std::fs::read_link(&copied_link).unwrap(),
            source_dir.path().join("target.txt")
        );
    }

    #[tokio::test]
    async fn import_external_rejects_a_dest_dir_that_escapes_the_workspace_root() {
        let source_dir = tempfile::tempdir().unwrap();
        std::fs::write(source_dir.path().join("a.txt"), "hi").unwrap();

        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());

        let err = ws
            .import_external(
                "../outside",
                &[source_dir
                    .path()
                    .join("a.txt")
                    .to_string_lossy()
                    .to_string()],
            )
            .await
            .unwrap_err();

        assert!(matches!(err, AppError::InvalidPath(_)));
    }

    #[tokio::test]
    async fn import_external_rejects_a_dest_dir_that_is_a_symlink_escaping_the_workspace_root() {
        let outside = tempfile::tempdir().unwrap();
        let source_dir = tempfile::tempdir().unwrap();
        std::fs::write(source_dir.path().join("a.txt"), "hi").unwrap();

        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        std::os::unix::fs::symlink(outside.path(), dir.path().join("escaping_dest")).unwrap();

        let err = ws
            .import_external(
                "escaping_dest",
                &[source_dir
                    .path()
                    .join("a.txt")
                    .to_string_lossy()
                    .to_string()],
            )
            .await
            .unwrap_err();

        assert!(matches!(err, AppError::InvalidPath(_)));
        assert!(!outside.path().join("a.txt").exists());
    }

    #[tokio::test]
    async fn find_files_ranks_a_contiguous_match_above_a_scattered_one() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        ws.create_file("readme.txt").await.unwrap();
        ws.create_file("resume.txt").await.unwrap();

        let results = ws.find_files("re").await.unwrap();

        let names: Vec<_> = results
            .matches
            .iter()
            .map(|m| m.display_path.as_str())
            .collect();
        // "re" is a contiguous prefix of both, but "resume.txt" is shorter,
        // so nucleo's prefix/contiguity bonus should still favor it over
        // "readme.txt" once other things are equal-ish; assert both are
        // found and ranked (score descending) rather than pin an exact
        // ordering the crate's own tuning could shift.
        assert_eq!(names.len(), 2);
        assert!(results.matches[0].score >= results.matches[1].score);
    }

    #[tokio::test]
    async fn find_files_empty_query_lists_all_files_sorted_unranked() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        ws.create_file("zeta.txt").await.unwrap();
        ws.create_file("alpha.txt").await.unwrap();
        ws.create_file("mid.txt").await.unwrap();

        let results = ws.find_files("").await.unwrap();

        let names: Vec<_> = results
            .matches
            .iter()
            .map(|m| m.display_path.as_str())
            .collect();
        assert_eq!(names, vec!["alpha.txt", "mid.txt", "zeta.txt"]);
        assert!(results.matches.iter().all(|m| m.score == 0));
        assert!(results.matches.iter().all(|m| m.match_indices.is_empty()));
        assert!(!results.truncated);
    }

    #[tokio::test]
    async fn find_files_respects_gitignore() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        ws.create_file(".gitignore").await.unwrap();
        ws.write_file(".gitignore", "ignored.txt\n").await.unwrap();
        ws.create_file("ignored.txt").await.unwrap();
        ws.create_file("kept.txt").await.unwrap();

        let results = ws.find_files("").await.unwrap();

        let names: Vec<_> = results
            .matches
            .iter()
            .map(|m| m.display_path.as_str())
            .collect();
        assert_eq!(names, vec!["kept.txt"]);
    }

    #[tokio::test]
    async fn find_files_excludes_default_ignored_names() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        ws.create_file("note.md").await.unwrap();
        ws.create_dir(".git").await.unwrap();
        ws.create_file(".git/HEAD").await.unwrap();
        ws.create_file(".DS_Store").await.unwrap();

        let results = ws.find_files("").await.unwrap();

        let names: Vec<_> = results
            .matches
            .iter()
            .map(|m| m.display_path.as_str())
            .collect();
        assert_eq!(names, vec!["note.md"]);
    }

    #[tokio::test]
    async fn find_files_result_cap_truncates_and_sets_truncated() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        let files = FIND_FILES_RESULT_CAP + 20;
        for i in 0..files {
            ws.create_file(&format!("file{i:04}.txt")).await.unwrap();
        }

        let results = ws.find_files("").await.unwrap();

        assert_eq!(results.matches.len(), FIND_FILES_RESULT_CAP);
        assert!(results.truncated);
    }

    #[tokio::test]
    async fn find_files_query_matching_nothing_returns_empty_non_truncated() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        ws.create_file("note.md").await.unwrap();

        let results = ws.find_files("zzzzznomatch").await.unwrap();

        assert!(results.matches.is_empty());
        assert!(!results.truncated);
    }

    #[tokio::test]
    async fn find_files_generation_cancels_a_superseded_walk() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        ws.create_file("note.md").await.unwrap();

        // Simulate a newer find_files call having already started by the
        // time this (stale) generation gets to check: `current_generation`
        // no longer reads back the `generation` this call was given, so it
        // should bail out before collecting anything.
        let current_generation = AtomicU64::new(2);
        let (paths, truncated) =
            find_files_root(dir.path(), &current_generation, 1, SEARCH_DEADLINE);

        assert!(paths.is_empty());
        assert!(!truncated);
    }

    #[tokio::test]
    async fn find_files_matches_against_the_full_relative_path_not_just_basename() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        ws.create_dir("src/lib/search").await.unwrap();
        ws.create_file("src/lib/search/SearchOverlay.svelte")
            .await
            .unwrap();
        ws.create_file("unrelated.txt").await.unwrap();

        let results = ws.find_files("libsearch").await.unwrap();

        let names: Vec<_> = results
            .matches
            .iter()
            .map(|m| m.display_path.as_str())
            .collect();
        assert_eq!(names, vec!["src/lib/search/SearchOverlay.svelte"]);
    }

    #[tokio::test]
    async fn find_files_multi_word_query_matches_each_word_independently() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        ws.create_dir("github/dev-loop").await.unwrap();
        ws.create_file("github/dev-loop/README.md").await.unwrap();
        ws.create_file("unrelated.md").await.unwrap();

        // Each space-separated word is fuzzy-matched independently against
        // the full path, so "readme" and "devloop" both have to be found as
        // (possibly gappy) subsequences somewhere in it — neither word
        // alone needs to be contiguous with the other, unlike the literal
        // (space-containing) string "readme devloop" which appears nowhere
        // in the path.
        let results = ws.find_files("readme devloop").await.unwrap();

        let names: Vec<_> = results
            .matches
            .iter()
            .map(|m| m.display_path.as_str())
            .collect();
        assert_eq!(names, vec!["github/dev-loop/README.md"]);
    }

    #[tokio::test]
    async fn find_files_multi_word_query_requires_every_word_to_match() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        ws.create_file("README.md").await.unwrap();

        // "readme" matches, but "zzznomatch" doesn't appear anywhere in the
        // path — a multi-word query is an AND across its words, so the file
        // must not be returned just because one word matched.
        let results = ws.find_files("readme zzznomatch").await.unwrap();

        assert!(results.matches.is_empty());
    }

    #[tokio::test]
    async fn import_external_rejects_a_dest_dir_that_is_not_a_directory() {
        let source_dir = tempfile::tempdir().unwrap();
        std::fs::write(source_dir.path().join("a.txt"), "hi").unwrap();

        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        ws.create_file("not_a_dir.txt").await.unwrap();

        let err = ws
            .import_external(
                "not_a_dir.txt",
                &[source_dir
                    .path()
                    .join("a.txt")
                    .to_string_lossy()
                    .to_string()],
            )
            .await
            .unwrap_err();

        assert!(matches!(err, AppError::InvalidPath(_)));
    }
}

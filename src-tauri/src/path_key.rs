//! The backend half of the frontend/backend canonical path contract (see
//! `src/lib/util/path.ts`'s module header for the full specification). This
//! module exists for exactly one reason: five `String`-keyed identity
//! structures scattered across this crate (`main.rs`'s `recent_drop`,
//! `launch_open::STATE.recent`, `external_grants.rs`'s `grants`,
//! `recents.rs`'s on-disk project list) use plain string equality for their
//! keys, and on Windows the frontend can hand the same real file to any of
//! them under more than one textual spelling — `Path`'s own `Eq`/`Hash`
//! would unify them, but a bare `String` key does not. Folding every key
//! through `canonical_key` before it is written or read closes that,
//! deliberately at the map boundary rather than inside each map's own
//! comparisons, so the fold can never be applied at one call site and
//! forgotten at another.

/// Folds `path` into the canonical form shared with the frontend, for use
/// as a key in a `String`-keyed identity structure. Mirrors
/// `src/lib/util/path.ts`'s `canonicalizePath` exactly, rule for rule; the
/// two are held in step by the shared vector fixture
/// (`tests/fixtures/canonical-path-vectors.json`), read by both test
/// suites.
///
/// Deliberately *not* a `Path` operation: these keys are compared as text,
/// against text the frontend supplies over IPC, so the fold has to be
/// defined over strings on both sides — a `PathBuf` key would already be
/// separator-safe on its own (see this module's own doc comment for why
/// only the `String`-keyed structures need this at all). Windows-shape
/// detection is structural (a drive letter or a UNC prefix), not
/// `cfg!(windows)`, so the Windows behavior is exercised by `cargo test` on
/// every platform in the CI matrix, not only a Windows runner.
pub fn canonical_key(path: &str) -> String {
    let stripped = strip_verbatim_prefix(path);
    let folded = fold_separators(&stripped);
    let collapsed = collapse_separators(&folded);
    strip_trailing_separator(&collapsed)
}

/// Whether `path` looks like a Windows path: a drive letter (`C:\` or
/// `C:/`) or a UNC prefix (`\\server` or `//server`). See
/// `canonical_key`'s own doc comment for why this is structural rather than
/// `cfg!(windows)`-gated.
fn is_windows_shaped(path: &str) -> bool {
    let bytes = path.as_bytes();
    let drive_letter = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/');
    let unc = bytes.len() >= 3
        && matches!(bytes[0], b'\\' | b'/')
        && matches!(bytes[1], b'\\' | b'/')
        && !matches!(bytes[2], b'\\' | b'/');
    drive_letter || unc
}

/// Folds `\` to `/`, but only when `path` is Windows-shaped — see
/// `is_windows_shaped`. Never applied unconditionally: a POSIX filename may
/// legally contain a literal backslash.
fn fold_separators(path: &str) -> String {
    if is_windows_shaped(path) {
        path.replace('\\', "/")
    } else {
        path.to_string()
    }
}

/// Strips a `\\?\` verbatim prefix: `\\?\UNC\server\share\…` becomes
/// `\\server\share\…`, and `\\?\C:\…` becomes `C:\…`. The `UNC` literal is
/// matched case-insensitively, mirroring the frontend's own rule.
fn strip_verbatim_prefix(path: &str) -> String {
    const VERBATIM_UNC: &str = r"\\?\UNC\";
    const VERBATIM_DISK: &str = r"\\?\";
    if path.len() >= VERBATIM_UNC.len()
        && path[..VERBATIM_UNC.len()].eq_ignore_ascii_case(VERBATIM_UNC)
    {
        format!(r"\\{}", &path[VERBATIM_UNC.len()..])
    } else if let Some(stripped) = path.strip_prefix(VERBATIM_DISK) {
        stripped.to_string()
    } else {
        path.to_string()
    }
}

/// Collapses runs of `/` into one, preserving exactly one leading `//` for
/// a UNC path.
fn collapse_separators(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("//") {
        let collapsed = collapse_runs(rest);
        format!("//{}", collapsed.trim_start_matches('/'))
    } else {
        collapse_runs(path)
    }
}

fn collapse_runs(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut last_was_slash = false;
    for c in s.chars() {
        if c == '/' {
            if !last_was_slash {
                result.push(c);
            }
            last_was_slash = true;
        } else {
            result.push(c);
            last_was_slash = false;
        }
    }
    result
}

/// Strips a trailing `/`, unless doing so would leave an empty string, a
/// bare `/`, or a bare drive root (`C:/`). A UNC share root
/// (`//server/share`) needs no special case: stripping its one possible
/// trailing separator already lands there.
fn strip_trailing_separator(path: &str) -> String {
    if path.len() <= 1 || !path.ends_with('/') {
        return path.to_string();
    }
    let bytes = path.as_bytes();
    let is_drive_root =
        bytes.len() == 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/';
    if is_drive_root {
        path.to_string()
    } else {
        path[..path.len() - 1].to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Vector {
        #[allow(dead_code)]
        description: String,
        input: String,
        expected: String,
    }

    /// Reads the same fixture `tests/frontend/path.test.ts` reads, so the
    /// two implementations of the canonical form can never be written to
    /// differ — drift becomes a build failure here rather than a
    /// Windows-only bug discovered later. `include_str!` embeds the file at
    /// compile time, so this test needs no filesystem access relative to a
    /// working directory that could vary between `cargo test` invocations.
    const FIXTURE: &str = include_str!("../../tests/fixtures/canonical-path-vectors.json");

    #[test]
    fn matches_every_shared_vector() {
        let vectors: Vec<Vector> =
            serde_json::from_str(FIXTURE).expect("canonical-path-vectors.json must parse");
        // A count floor so a truncated or empty fixture can't pass vacuously.
        assert!(
            vectors.len() >= 15,
            "expected at least 15 shared vectors, found {}",
            vectors.len()
        );
        for v in &vectors {
            assert_eq!(
                canonical_key(&v.input),
                v.expected,
                "canonical_key({:?}) mismatch — {}",
                v.input,
                v.description
            );
        }
    }

    #[test]
    fn is_idempotent_on_every_shared_vector() {
        let vectors: Vec<Vector> =
            serde_json::from_str(FIXTURE).expect("canonical-path-vectors.json must parse");
        for v in &vectors {
            let once = canonical_key(&v.expected);
            assert_eq!(once, v.expected, "not idempotent on {:?}", v.expected);
        }
    }

    // A `#[cfg(windows)]` unit test asserting that the platform's own path
    // parser treats a forward-slash UNC path the same as a backslash one —
    // settled in the plan's step 0. This is the one place a `cfg` gate is
    // correct: it asserts a property of the *platform's* path parser, not
    // of this module's own string fold, and the assertion is meaningless on
    // a non-Windows host (`Prefix::UNC` only exists in `std::path::Prefix`'s
    // Windows-only variants).
    #[cfg(windows)]
    #[test]
    fn windows_parses_a_forward_slash_unc_path_the_same_as_a_backslash_one() {
        use std::path::{Component, Path, Prefix};

        let backslash = Path::new(r"\\server\share\f.txt");
        let forward = Path::new("//server/share/f.txt");
        assert_eq!(backslash, forward);

        let prefix_of = |p: &Path| match p.components().next() {
            Some(Component::Prefix(prefix)) => prefix.kind(),
            _ => panic!("expected a Prefix component"),
        };
        assert!(matches!(prefix_of(backslash), Prefix::UNC(_, _)));
        assert!(matches!(prefix_of(forward), Prefix::UNC(_, _)));

        assert_eq!(
            canonical_key(r"\\server\share\f.txt"),
            canonical_key("//server/share/f.txt")
        );
    }

    #[test]
    fn preserves_a_literal_backslash_in_a_posix_filename() {
        assert_eq!(canonical_key("/home/me/we\\ird"), "/home/me/we\\ird");
    }

    #[test]
    fn folds_a_native_windows_path() {
        assert_eq!(canonical_key(r"C:\ws\src\a.ts"), "C:/ws/src/a.ts");
    }

    #[test]
    fn strips_verbatim_disk_prefix() {
        assert_eq!(canonical_key(r"\\?\C:\ws\a.ts"), "C:/ws/a.ts");
    }

    #[test]
    fn strips_verbatim_unc_prefix() {
        assert_eq!(canonical_key(r"\\?\UNC\srv\share\a.ts"), "//srv/share/a.ts");
    }

    #[test]
    fn different_spellings_of_the_same_file_produce_one_key() {
        let a = canonical_key(r"C:\ws\a.txt");
        let b = canonical_key("C:/ws/a.txt");
        let c = canonical_key(r"\\?\C:\ws\a.txt");
        assert_eq!(a, b);
        assert_eq!(b, c);
    }
}

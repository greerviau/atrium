/**
 * Conservative candidate regex for file-path-looking substrings in terminal
 * output: requires either a `/` or a recognized extension, with an optional
 * trailing `:<line>` or `:<line>:<col>`. Also matches a `~/`-prefixed path,
 * and a single- or double-quoted path (which may contain spaces) — each
 * quoted alternative is guarded by a `(?<!\w)`/`(?!\w)` word-boundary
 * lookaround around its quote characters so a prose apostrophe (as in
 * "pkg.json's" or "couldn't") can never be mistaken for a quote delimiter;
 * without the guard, a quoted alternative can start earlier in the line than
 * the unquoted match it competes with, silently swallowing the real,
 * unquoted path into a non-resolving span. This over-matches on purpose (see
 * plan section 6.4) — every candidate is verified against the filesystem
 * via `fs_resolve_candidates` before being linkified, so a false positive
 * here just means "not resolved," not "wrongly clickable."
 */
export const FILE_PATH_REGEX =
  /(?<!\w)'[^'\n]+\.\w+'(?!\w)(?::\d+(?::\d+)?)?|(?<!\w)"[^"\n]+\.\w+"(?!\w)(?::\d+(?::\d+)?)?|(?:~\/|\.{0,2}\/)?[\w.\-/]+\.\w+(?::\d+(?::\d+)?)?/g;

/**
 * Conservative candidate regex for file-path-looking substrings in terminal
 * output, with an optional trailing `:<line>` or `:<line>:<col>`. Unquoted
 * candidates need a `/`, a filename extension, or a `:line` suffix, while
 * quotes are enough evidence on their own; this includes extensionless paths
 * such as `scripts/build` and `Makefile:10` without turning every prose word
 * into a filesystem lookup.
 * Each quoted alternative is guarded by a `(?<!\w)`/`(?!\w)` word-boundary
 * lookaround around its quote characters so a prose apostrophe (as in
 * "pkg.json's" or "couldn't") can never be mistaken for a quote delimiter.
 * This over-matches on purpose: every candidate is verified against the
 * filesystem via `fs_resolve_candidates` before being linkified, so a false
 * positive here just means "not resolved," not "wrongly clickable."
 */
export const FILE_PATH_REGEX =
  /(?<!\w)'[^'\n]+'(?!\w)(?::\d+(?::\d+)?)?|(?<!\w)"[^"\n]+"(?!\w)(?::\d+(?::\d+)?)?|(?:~\/|\.{1,2}\/|\/|[\w.-]+\/)[\w.@+~\/-]*[\w.@+~-](?::\d+(?::\d+)?)?|[\w@+~-]+:\d+(?::\d+)?|[\w.-]+\.\w+(?::\d+(?::\d+)?)?/g;

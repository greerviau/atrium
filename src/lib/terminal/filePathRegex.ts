/**
 * Conservative candidate regex for file-path-looking substrings in terminal
 * output: requires either a `/` or a recognized extension, with an optional
 * trailing `:<line>` or `:<line>:<col>`. This over-matches on purpose (see
 * plan section 6.4) — every candidate is verified against the filesystem
 * via `fs_resolve_candidates` before being linkified, so a false positive
 * here just means "not resolved," not "wrongly clickable."
 */
export const FILE_PATH_REGEX = /(?:\.{0,2}\/)?[\w.\-/]+\.\w+(?::\d+(?::\d+)?)?/g;

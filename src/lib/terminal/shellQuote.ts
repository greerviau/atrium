/**
 * POSIX single-quotes a path only when it contains a character that would
 * otherwise break a shell command line, leaving a plain path untouched.
 *
 * Only safe for an absolute path: the allow-list has no leading-character
 * guard, so a relative path starting with `-` (read as an option) or, under
 * zsh, `=` (equals-expansion) would pass through unquoted. Every caller in
 * this codebase passes a `DirEntry.path`, which is always absolute.
 */
export function shellQuotePath(path: string): string {
  if (/^[A-Za-z0-9_/.,:@%+=-]+$/.test(path)) {
    return path;
  }
  return `'${path.replace(/'/g, "'\\''")}'`;
}

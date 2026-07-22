/** POSIX single-quotes a path only when it contains a character that would otherwise break a shell command line, leaving a plain path untouched. */
export function shellQuotePath(path: string): string {
  if (/^[A-Za-z0-9_/.,:@%+=-]+$/.test(path)) {
    return path;
  }
  return `'${path.replace(/'/g, "'\\''")}'`;
}

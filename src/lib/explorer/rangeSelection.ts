export function contiguousPathSelection(
  visiblePaths: string[],
  anchorPath: string | null,
  targetPath: string,
): Set<string> {
  const targetIndex = visiblePaths.indexOf(targetPath);
  const anchorIndex = anchorPath === null ? -1 : visiblePaths.indexOf(anchorPath);
  if (targetIndex === -1) return new Set();
  if (anchorIndex === -1) return new Set([targetPath]);

  const start = Math.min(anchorIndex, targetIndex);
  const end = Math.max(anchorIndex, targetIndex);
  return new Set(visiblePaths.slice(start, end + 1));
}

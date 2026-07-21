import { extensionOf } from "../util/path";

/**
 * Extension (no dot, lowercased) -> human-readable language label for the
 * status bar's language indicator. Mirrors the extension set
 * `codeExtensions.ts` already switches on, mapped to display names instead
 * of CodeMirror language extensions.
 */
const LABELS: Record<string, string> = {
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  ts: "TypeScript",
  tsx: "TypeScript",
  py: "Python",
  rs: "Rust",
  go: "Go",
  json: "JSON",
  yaml: "YAML",
  yml: "YAML",
  css: "CSS",
  html: "HTML",
  sh: "Shell Script",
  bash: "Shell Script",
  zsh: "Shell Script",
  md: "Markdown",
  markdown: "Markdown",
};

/** Human-readable language label for `path`'s extension, falling back to "Plain Text" for anything unrecognized. */
export function languageLabel(path: string): string {
  return LABELS[extensionOf(path)] ?? "Plain Text";
}

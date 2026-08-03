import { extensionOf } from "../util/path";
import { codeLanguageForPath } from "./codeLanguages";
import { isImagePath } from "./imageFormats";

/**
 * Extension (no dot, lowercased) -> human-readable language label for the
 * status bar's language indicator. These preserve Atrium's established names
 * when they differ from the corresponding CodeMirror language description.
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
  csv: "CSV",
  tsv: "TSV",
  parquet: "Parquet",
};

/** Human-readable file-type label for `path`, falling back to "Plain Text" for anything unrecognized. */
export function languageLabel(path: string): string {
  if (isImagePath(path)) return "Image";
  return LABELS[extensionOf(path)] ?? codeLanguageForPath(path)?.name ?? "Plain Text";
}

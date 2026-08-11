import type { Extension } from "@codemirror/state";
import { extensionOf } from "../util/path";
import { codeLanguageForPath } from "./codeLanguages";
import { isImagePath } from "./imageFormats";
import { documentWordCompletion } from "./wordCompletion";

export type PaneMode = "markdown" | "code" | "data" | "image";
export type TextPaneMode = Extract<PaneMode, "markdown" | "code">;

// Matches @codemirror/language-data's own Markdown LanguageDescription
// extensions list. "mkd" was previously missing here, which routed .mkd
// files to "code" mode instead of "markdown" — invisible before Fix C since
// lang-markdown's own source only completes HTML tags after '<', but the
// document-word fallback below would otherwise apply to .mkd prose too.
const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mkd"]);
const DATA_EXTENSIONS = new Set(["csv", "tsv", "parquet"]);

/** Extension (no dot, lowercased) -> mode. Markdown, tabular data, and images use dedicated panes. */
export function modeForPath(path: string): PaneMode {
  const extension = extensionOf(path);
  if (MARKDOWN_EXTENSIONS.has(extension)) return "markdown";
  if (DATA_EXTENSIONS.has(extension)) return "data";
  if (isImagePath(path)) return "image";
  return "code";
}

/** Whether a pane reads and edits its source as text. */
export function isTextPaneMode(mode: PaneMode): mode is TextPaneMode {
  return mode === "markdown" || mode === "code";
}

/** Whether `path` is backed by a queryable tabular data file. */
export function isDataPath(path: string): boolean {
  return DATA_EXTENSIONS.has(extensionOf(path));
}

/**
 * Loads the CodeMirror language matched by `path`, plus a document-word
 * completion fallback so a code pane is never completion-dead — including
 * when `path` matches no language at all, which otherwise leaves the pane in
 * plain-text mode with no completion source whatsoever.
 */
export async function loadCodeExtensions(path: string): Promise<Extension[]> {
  const language = codeLanguageForPath(path);
  return language ? [documentWordCompletion, await language.load()] : [documentWordCompletion];
}

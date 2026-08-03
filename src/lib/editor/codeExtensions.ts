import type { Extension } from "@codemirror/state";
import { extensionOf } from "../util/path";
import { codeLanguageForPath } from "./codeLanguages";
import { isImagePath } from "./imageFormats";

export type PaneMode = "markdown" | "code" | "data" | "image";
export type TextPaneMode = Extract<PaneMode, "markdown" | "code">;

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown"]);
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

/** Loads the CodeMirror language matched by `path`; unrecognized files remain plain text. */
export async function loadCodeExtensions(path: string): Promise<Extension[]> {
  const language = codeLanguageForPath(path);
  return language ? [await language.load()] : [];
}

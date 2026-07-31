import type { Extension } from "@codemirror/state";
import { StreamLanguage } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { go } from "@codemirror/lang-go";
import { json } from "@codemirror/lang-json";
import { yaml } from "@codemirror/lang-yaml";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { extensionOf } from "../util/path";

export type PaneMode = "markdown" | "code" | "data";

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown"]);
const DATA_EXTENSIONS = new Set(["csv", "tsv", "parquet"]);

/** Extension (no dot, lowercased) -> mode. Markdown and tabular data use dedicated panes. */
export function modeForPath(path: string): PaneMode {
  const extension = extensionOf(path);
  if (MARKDOWN_EXTENSIONS.has(extension)) return "markdown";
  if (DATA_EXTENSIONS.has(extension)) return "data";
  return "code";
}

/** Whether `path` is backed by a queryable tabular data file. */
export function isDataPath(path: string): boolean {
  return DATA_EXTENSIONS.has(extensionOf(path));
}

/**
 * Curated extension -> `@codemirror/lang-*` registry (plan section 6.2).
 * Unknown extensions get plain text (no language extension) rather than
 * erroring — the MVP does not try to bundle every possible language.
 */
export function codeExtensions(path: string): Extension[] {
  switch (extensionOf(path)) {
    case "js":
    case "jsx":
    case "mjs":
      return [javascript({ jsx: true })];
    case "ts":
      return [javascript({ typescript: true })];
    case "tsx":
      return [javascript({ typescript: true, jsx: true })];
    case "py":
      return [python()];
    case "rs":
      return [rust()];
    case "go":
      return [go()];
    case "json":
      return [json()];
    case "yaml":
    case "yml":
      return [yaml()];
    case "css":
      return [css()];
    case "html":
      return [html()];
    case "sh":
    case "bash":
    case "zsh":
      return [StreamLanguage.define(shell)];
    default:
      return [];
  }
}

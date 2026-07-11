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

export type PaneMode = "markdown" | "code";

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown"]);

/** Extension (no dot, lowercased) -> mode. `.md` routes to the markdown pane instead of the code pane. */
export function modeForPath(path: string): PaneMode {
  return MARKDOWN_EXTENSIONS.has(extensionOf(path)) ? "markdown" : "code";
}

export function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
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

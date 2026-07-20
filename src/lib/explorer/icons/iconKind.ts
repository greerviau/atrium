import { extensionOf } from "../../util/path";

export type IconKind =
  | "folder-closed"
  | "folder-open"
  | "markdown"
  | "javascript"
  | "typescript"
  | "python"
  | "rust"
  | "go"
  | "json"
  | "yaml"
  | "css"
  | "html"
  | "shell"
  | "toml"
  | "image"
  | "generic";

/** Icon kind for a tree entry, mirroring the extension groups in `codeExtensions()` plus `markdown`/`toml`/`image`. */
export function iconKindFor(entry: { isDir: boolean; name: string }, expanded: boolean): IconKind {
  if (entry.isDir) {
    return expanded ? "folder-open" : "folder-closed";
  }
  switch (extensionOf(entry.name)) {
    case "md":
    case "markdown":
      return "markdown";
    case "js":
    case "jsx":
    case "mjs":
      return "javascript";
    case "ts":
    case "tsx":
      return "typescript";
    case "py":
      return "python";
    case "rs":
      return "rust";
    case "go":
      return "go";
    case "json":
      return "json";
    case "yaml":
    case "yml":
      return "yaml";
    case "css":
    case "scss":
    case "less":
      return "css";
    case "html":
    case "htm":
      return "html";
    case "sh":
    case "bash":
    case "zsh":
      return "shell";
    case "toml":
      return "toml";
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "svg":
    case "webp":
    case "ico":
    case "bmp":
      return "image";
    default:
      return "generic";
  }
}

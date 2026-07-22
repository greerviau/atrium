import { EditorView, WidgetType } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";
import { openFile } from "../../stores/tabs";
import { openExternalLink } from "../../ipc/commands";
import { convertFileSrc } from "@tauri-apps/api/core";
import path from "../../util/path";
import { loadMermaid } from "./mermaid";
import { CLASS } from "./theme";

/**
 * Replaces a task list item's `[ ]`/`[x]` marker with a real checkbox.
 * `markerFrom`/`markerTo` bracket just the single status character inside
 * the brackets (e.g. the ` ` or `x` in `[ ]`/`[x]`), so toggling is a
 * single-character replace transaction. Checkboxes stay interactive even on
 * the active line, unlike other decorations (matching Obsidian).
 */
export class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly markerFrom: number,
    readonly markerTo: number,
  ) {
    super();
  }

  eq(other: CheckboxWidget): boolean {
    return (
      this.checked === other.checked &&
      this.markerFrom === other.markerFrom &&
      this.markerTo === other.markerTo
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = this.checked;
    input.className = "cm-task-checkbox";
    input.addEventListener("change", () => {
      view.dispatch({
        changes: {
          from: this.markerFrom,
          to: this.markerTo,
          insert: this.checked ? " " : "x",
        },
      });
    });
    return input;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/**
 * Replaces an `![alt](url)` image node with a rendered `<img>`. Local
 * relative URLs are resolved against the markdown file's own directory and
 * loaded through Tauri's `convertFileSrc` asset protocol; `http(s)://` URLs
 * load directly. Clicking places the cursor on that line (revealing the raw
 * syntax) instead of doing anything else, matching Obsidian.
 */
export class ImageWidget extends WidgetType {
  constructor(
    readonly url: string,
    readonly alt: string,
    readonly documentPath: string,
    readonly linePos: number,
  ) {
    super();
  }

  eq(other: ImageWidget): boolean {
    return (
      this.url === other.url &&
      this.alt === other.alt &&
      this.documentPath === other.documentPath &&
      this.linePos === other.linePos
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const img = document.createElement("img");
    img.className = "cm-markdown-image";
    img.alt = this.alt;
    img.src = resolveImageSrc(this.url, this.documentPath);
    img.addEventListener("mousedown", (event) => {
      event.preventDefault();
      view.dispatch({ selection: EditorSelection.cursor(this.linePos) });
      view.focus();
    });
    return img;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

let nextMermaidWidgetId = 0;

/**
 * Replaces a ` ```mermaid ` fenced block with a rendered diagram, mirroring
 * `ImageWidget`'s synchronous-`toDOM`-then-async-mutate pattern. `eq()` is
 * content-based (source text only) so CM6 reuses the same DOM node — and
 * Mermaid never re-renders — across any decoration recompute that doesn't
 * change this particular block's text. On invalid syntax, the container
 * shows a distinct error panel with Mermaid's own parser message instead.
 * Clicking the container (rendered diagram or error panel alike) drops the
 * cursor into the raw source, matching `ImageWidget`'s click-to-edit.
 */
export class MermaidWidget extends WidgetType {
  private destroyed = false;

  constructor(
    readonly source: string,
    readonly blockFrom: number,
  ) {
    super();
  }

  eq(other: MermaidWidget): boolean {
    return this.source === other.source;
  }

  toDOM(view: EditorView): HTMLElement {
    this.destroyed = false;
    const container = document.createElement("div");
    container.className = CLASS.mermaidDiagram;
    container.addEventListener("mousedown", (event) => {
      event.preventDefault();
      view.dispatch({ selection: EditorSelection.cursor(this.blockFrom) });
      view.focus();
    });

    const id = `cm-mermaid-${nextMermaidWidgetId++}`;
    loadMermaid()
      .then((mod) => mod.default.render(id, this.source))
      .then(({ svg }) => {
        if (this.destroyed) {
          return;
        }
        container.classList.remove(CLASS.mermaidError);
        container.innerHTML = svg;
      })
      .catch((error: unknown) => {
        if (this.destroyed) {
          return;
        }
        renderMermaidError(container, error);
      });

    return container;
  }

  destroy(): void {
    this.destroyed = true;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function renderMermaidError(container: HTMLElement, error: unknown): void {
  container.classList.add(CLASS.mermaidError);
  container.innerHTML = "";
  const label = document.createElement("div");
  label.className = "cm-mermaid-error-label";
  label.textContent = "Invalid Mermaid diagram";
  const message = document.createElement("pre");
  message.className = "cm-mermaid-error-message";
  message.textContent = error instanceof Error ? error.message : String(error);
  container.append(label, message);
}

function resolveImageSrc(url: string, documentPath: string): string {
  if (/^https?:\/\//.test(url)) {
    return url;
  }
  const absolute = path.resolveRelative(path.dirname(documentPath), url);
  return convertFileSrc(absolute);
}

/**
 * Click handler shared by rendered markdown links: external URLs open via
 * the validated `open_external_link` command, relative paths that look
 * like local files open in a new editor tab via the same `openFile()` used
 * by the file explorer and terminal link provider.
 */
export function handleLinkClick(url: string, documentPath: string): void {
  if (/^https?:\/\//i.test(url)) {
    void openExternalLink(url);
    return;
  }
  const target = path.resolveRelative(path.dirname(documentPath), url);
  void openFile(target);
}

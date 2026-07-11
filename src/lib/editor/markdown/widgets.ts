import { EditorView, WidgetType } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";
import { openFile } from "../../stores/tabs";
import { shellOpenExternal } from "../../ipc/commands";
import { convertFileSrc } from "@tauri-apps/api/core";
import path from "../../util/path";

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

function resolveImageSrc(url: string, documentPath: string): string {
  if (/^https?:\/\//.test(url)) {
    return url;
  }
  const absolute = path.resolveRelative(path.dirname(documentPath), url);
  return convertFileSrc(absolute);
}

/**
 * Click handler shared by rendered markdown links: external URLs open via
 * the validated `shell_open_external` command, relative paths that look
 * like local files open in a new editor tab via the same `openFile()` used
 * by the file explorer and terminal link provider.
 */
export function handleLinkClick(url: string, documentPath: string): void {
  if (/^https?:\/\//.test(url)) {
    void shellOpenExternal(url);
    return;
  }
  const target = path.resolveRelative(path.dirname(documentPath), url);
  void openFile(target);
}

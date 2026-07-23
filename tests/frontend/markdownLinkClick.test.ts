import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdownExtensions } from "../../src/lib/editor/markdown/livePreviewPlugin";
import { openExternalLink } from "../../src/lib/ipc/commands";
import { openFile } from "../../src/lib/stores/tabs";

vi.mock("../../src/lib/ipc/commands", () => ({
  openExternalLink: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../src/lib/stores/tabs", () => ({
  openFile: vi.fn(),
}));

let view: EditorView | undefined;
let container: HTMLElement | undefined;

// `Node.isConnected` only reflects attachment to `document` itself, not just
// to an in-memory parent — the container has to be appended to `document.body`
// for the isConnected assertions below (which check whether CodeMirror tore
// the original `.cm-link` element out of the live DOM) to mean anything.
function makeView(doc: string, documentPath = "sample.md"): EditorView {
  container = document.createElement("div");
  document.body.appendChild(container);
  return new EditorView({
    state: EditorState.create({ doc, extensions: markdownExtensions(documentPath) }),
    parent: container,
  });
}

function findLink(v: EditorView): HTMLElement {
  const link = v.dom.querySelector<HTMLElement>(".cm-link");
  if (!link) throw new Error("no .cm-link rendered");
  return link;
}

afterEach(() => {
  view?.destroy();
  view = undefined;
  container?.remove();
  container = undefined;
});

describe("modifier+click on a rendered markdown link", () => {
  beforeEach(() => {
    vi.mocked(openExternalLink).mockReset().mockReturnValue(Promise.resolve());
    vi.mocked(openFile).mockReset();
  });

  it("cmd-click (metaKey) navigates via openExternalLink and leaves selection/decoration untouched", () => {
    const doc = "See [my link](https://example.com) for more.\nOther line, cursor starts here.";
    view = makeView(doc);
    view.dispatch({ selection: EditorSelection.cursor(doc.length) });

    const link = findLink(view);
    link.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, metaKey: true }));

    expect(openExternalLink).toHaveBeenCalledWith("https://example.com");
    expect(openFile).not.toHaveBeenCalled();
    // Selection is untouched: the modifier-click never reached CodeMirror's
    // built-in cursor-placement handler, so it stays where it was set above.
    expect(view.state.selection.main.from).toBe(doc.length);
    expect(link.isConnected).toBe(true);
    expect(view.dom.querySelector(".cm-link")).toBe(link);
  });

  it("ctrl-click (ctrlKey) navigates via openExternalLink the same way", () => {
    const doc = "See [my link](https://example.com) for more.\nOther line, cursor starts here.";
    view = makeView(doc);
    view.dispatch({ selection: EditorSelection.cursor(doc.length) });

    const link = findLink(view);
    link.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, ctrlKey: true }));

    expect(openExternalLink).toHaveBeenCalledWith("https://example.com");
  });

  it("a plain click (no modifier) does not navigate and still falls through to cursor placement/raw-source reveal", () => {
    const doc = "See [my link](https://example.com) for more.\nOther line, cursor starts here.";
    view = makeView(doc);
    view.dispatch({ selection: EditorSelection.cursor(doc.length) });

    const link = findLink(view);
    const linkFrom = view.posAtDOM(link, 0);
    link.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));

    expect(openExternalLink).not.toHaveBeenCalled();
    expect(openFile).not.toHaveBeenCalled();

    // jsdom has no layout engine, so CodeMirror's own built-in mousedown
    // handler (which resolves click coordinates to a document position via
    // posAtCoords) is a no-op here; applying the selection change it would
    // perform in a real browser stands in for it (see
    // tests/e2e/README.md for the same layout/WebView gap documented for
    // this codebase).
    view.dispatch({ selection: EditorSelection.cursor(linkFrom) });

    expect(view.dom.querySelector(".cm-link")).toBeNull();
    expect(link.isConnected).toBe(false);
  });

  it("a relative-path link resolves through openFile() on modifier-click, not openExternalLink", () => {
    const doc = "See [my note](./notes/todo.md) for more.\nOther line, cursor starts here.";
    view = makeView(doc, "docs/index.md");
    view.dispatch({ selection: EditorSelection.cursor(doc.length) });

    const link = findLink(view);
    link.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, metaKey: true }));

    expect(openFile).toHaveBeenCalledWith("docs/notes/todo.md");
    expect(openExternalLink).not.toHaveBeenCalled();
  });
});

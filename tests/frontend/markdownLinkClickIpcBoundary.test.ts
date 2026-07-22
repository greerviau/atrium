import { describe, it, expect, afterEach, vi } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { markdownExtensions } from "../../src/lib/editor/markdown/livePreviewPlugin";

// Mocks the real IPC boundary (`invoke`) rather than `openExternalLink`
// itself, so this test exercises the actual call the frontend makes to the
// Rust backend. `markdownLinkClick.test.ts` mocks `openExternalLink`
// directly, which is the right level for asserting the frontend's own
// branching logic but can't catch a mismatch between what the frontend
// calls and what the backend command is actually named or expects — that
// exact gap (`shellOpenExternal` calling `shell_open_external`, whose
// `is_pr_url` gate silently rejected ordinary web links) is what let #99
// ship green while the reported bug remained reproducible.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
  convertFileSrc: (path: string) => path,
  Channel: class {},
}));

let view: EditorView | undefined;
let container: HTMLElement | undefined;

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
  vi.mocked(invoke).mockClear();
});

describe("cmd/ctrl-click on a rendered markdown link, at the real IPC boundary", () => {
  it("calls invoke(\"open_external_link\", { url }) for an ordinary web link", () => {
    const doc = "See [my link](https://example.com) for more.\nOther line, cursor starts here.";
    view = makeView(doc);
    view.dispatch({ selection: EditorSelection.cursor(doc.length) });

    const link = findLink(view);
    link.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, metaKey: true }));

    expect(invoke).toHaveBeenCalledWith("open_external_link", { url: "https://example.com" });
  });

  it("also routes a GitHub PR URL in markdown through open_external_link, not shell_open_external", () => {
    const doc =
      "See [my PR](https://github.com/greerviau/atrium/pull/99) for more.\nOther line, cursor starts here.";
    view = makeView(doc);
    view.dispatch({ selection: EditorSelection.cursor(doc.length) });

    const link = findLink(view);
    link.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, metaKey: true }));

    expect(invoke).toHaveBeenCalledWith("open_external_link", {
      url: "https://github.com/greerviau/atrium/pull/99",
    });
    expect(invoke).not.toHaveBeenCalledWith("shell_open_external", expect.anything());
  });

  it("never calls open_external_link for a relative-path link", () => {
    const doc = "See [my note](./notes/todo.md) for more.\nOther line, cursor starts here.";
    view = makeView(doc, "docs/index.md");
    view.dispatch({ selection: EditorSelection.cursor(doc.length) });

    const link = findLink(view);
    link.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, metaKey: true }));

    expect(invoke).not.toHaveBeenCalledWith("open_external_link", expect.anything());
  });
});

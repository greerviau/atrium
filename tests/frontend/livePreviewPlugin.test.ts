import { describe, it, expect, vi, afterEach } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { forceParsing } from "@codemirror/language";
import { markdownExtensions } from "../../src/lib/editor/markdown/livePreviewPlugin";
import { loadMermaid } from "../../src/lib/editor/markdown/mermaid";

vi.mock("../../src/lib/editor/markdown/mermaid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/editor/markdown/mermaid")>()),
  loadMermaid: vi.fn(),
}));

vi.mocked(loadMermaid).mockResolvedValue({
  default: { render: vi.fn().mockResolvedValue({ svg: "<svg>diagram</svg>" }), initialize: vi.fn() },
} as unknown as Awaited<ReturnType<typeof loadMermaid>>);

let view: EditorView | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  view?.destroy();
  view = undefined;
  container?.remove();
  container = undefined;
});

/**
 * Regression tests for issue #85: a live-preview decoration past the
 * initial synchronous parse window (CodeMirror's `LanguageState.init()`
 * bounds the very first parse to ~3000 characters / a short time budget)
 * must render as soon as the background `ParseWorker` finishes reaching it
 * — with no selection change or document edit required to "wake up" the
 * decoration layer. `forceParsing` drives the background parse to
 * completion and dispatches the same shape of transaction the real
 * `ParseWorker` dispatches on its own completion: no doc change, no
 * selection change, only a grown syntax tree.
 */
describe("live-preview decorations react to background parse completion (issue #85)", () => {
  const padding = "x".repeat(4000) + "\n\n";

  it("renders a Mermaid diagram past the initial parse window with no selection or doc change dispatched", () => {
    const doc = padding + "```mermaid\ngraph TD;\nA-->B;\n```\n";
    const container = document.createElement("div");
    view = new EditorView({
      state: EditorState.create({ doc, extensions: markdownExtensions("test.md") }),
      parent: container,
    });

    expect(container.querySelector(".cm-mermaid-diagram")).toBeNull();

    forceParsing(view, view.state.doc.length);

    expect(container.querySelector(".cm-mermaid-diagram")).not.toBeNull();
  });

  it("renders a non-mermaid decoration (a heading) past the initial parse window with no selection or doc change dispatched", () => {
    const doc = padding + "# Heading past the initial parse window\n";
    const container = document.createElement("div");
    view = new EditorView({
      state: EditorState.create({ doc, extensions: markdownExtensions("test.md") }),
      parent: container,
    });

    expect(container.querySelector(".cm-heading-1")).toBeNull();

    forceParsing(view, view.state.doc.length);

    expect(container.querySelector(".cm-heading-1")).not.toBeNull();
  });
});

/**
 * Regression tests for issue #108: clicking away from the editor entirely
 * (not just moving the cursor within it) must return the line that was
 * being edited to its fully rendered view. CodeMirror's selection is always
 * present and doesn't change on a DOM blur, so this only works if the
 * decoration layer also tracks `EditorView.hasFocus` independently of
 * `EditorState.selection` — driven here through real DOM `focus`/`blur`,
 * not synthetic state, on a real `EditorView` built from the app's own
 * `markdownExtensions()`.
 */
describe("live-preview decorations clear on blur, independent of selection (issue #108)", () => {
  it("re-hides a heading's raw marker once the editor loses focus, with the selection unchanged", () => {
    const doc = "# Hello world\nSecond line";
    container = document.createElement("div");
    document.body.appendChild(container);
    view = new EditorView({
      state: EditorState.create({ doc, extensions: markdownExtensions("test.md") }),
      parent: container,
    });

    view.focus();
    view.dispatch({ selection: EditorSelection.cursor(3) }); // cursor inside "Hello"
    expect(container.querySelector(".cm-heading-1")?.textContent).toBe("# Hello world");

    view.contentDOM.blur();
    expect(container.querySelector(".cm-heading-1")?.textContent).toBe("Hello world");
  });

  it("re-hides a table cell's raw source once the editor loses focus, with the selection unchanged", () => {
    const doc = "| Name | Role |\n| --- | --- |\n| Alice | Engineer |\n";
    container = document.createElement("div");
    document.body.appendChild(container);
    view = new EditorView({
      state: EditorState.create({ doc, extensions: markdownExtensions("test.md") }),
      parent: container,
    });

    view.focus();
    view.dispatch({ selection: EditorSelection.cursor(doc.indexOf("Engineer") + 1) });
    expect(container.querySelectorAll(".cm-table-cell")).toHaveLength(4); // every cell keeps its mark, including the focused one

    view.contentDOM.blur();
    expect(container.querySelectorAll(".cm-table-cell")).toHaveLength(4); // every cell decorated again
  });
});

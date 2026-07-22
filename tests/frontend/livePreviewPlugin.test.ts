import { describe, it, expect, vi, afterEach } from "vitest";
import { EditorState } from "@codemirror/state";
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

afterEach(() => {
  view?.destroy();
  view = undefined;
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

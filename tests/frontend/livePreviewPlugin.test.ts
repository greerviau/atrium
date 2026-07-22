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

/**
 * Regression test for issue #110: a table's inter-cell gap is never
 * cursor-revealed (see `decorateTableRow`'s docstring in `decorations.ts`),
 * which is what stops editing a cell from widening every row's shared
 * column grid. Instead `EditorView.atomicRanges` (registered alongside
 * `livePreviewPlugin`) makes the gap atomic for cursor motion: moving the
 * cursor towards it jumps straight over to the far side in one step rather
 * than landing inside it character by character.
 */
describe("a table's inter-cell gap is atomic for cursor motion, not cursor-revealed (issue #110)", () => {
  it("jumps the cursor over the whole gap in one step instead of revealing it", () => {
    const doc = "| Name | Role |\n| --- | --- |\n| Alice | Engineer |\n";
    container = document.createElement("div");
    document.body.appendChild(container);
    view = new EditorView({
      state: EditorState.create({ doc, extensions: markdownExtensions("test.md") }),
      parent: container,
    });
    view.focus();

    const aliceEnd = doc.indexOf("Alice") + "Alice".length;
    const engineerStart = doc.indexOf("Engineer");
    view.dispatch({ selection: EditorSelection.cursor(aliceEnd) });

    const moved = view.moveByChar(view.state.selection.main, true);
    expect(moved.head).toBe(engineerStart); // the whole " | " gap is skipped in one move, not character by character

    // The gap itself is still never given a cm-table-cell mark or shown as
    // raw pipe/space text — every cell on the row stays decorated.
    expect(container.querySelectorAll(".cm-table-cell")).toHaveLength(4);
  });
});

/**
 * Regression tests for the empty-cell corruption a first pass at issue #110
 * introduced: the markdown parser gives an empty table cell no `TableCell`
 * node, so a naive gap computed from one `TableCell` to the next would
 * swallow the empty cell's own slot into the surrounding, atomic
 * `tableGap` range — displacing any insertion made "inside" it (or aimed
 * at it via cursor motion) to the range's far end, in the next column.
 * `decorateTableRow` avoids this by synthesizing a real slot for an empty
 * cell (`collectCellSlots` in `decorations.ts`) instead of letting the gap
 * merge across it.
 */
describe("an empty table cell keeps its own slot, reachable and fillable (issue #110 must-fix)", () => {
  it("lands a retyped replacement in the cell that was cleared, not the next column", () => {
    const doc = "| Name  | Role     | Score | Notes |\n| ------ | -------- | ----- | ----- |\n| Alice  | Engineer | 92    | first |\n";
    container = document.createElement("div");
    document.body.appendChild(container);
    view = new EditorView({
      state: EditorState.create({ doc, extensions: markdownExtensions("test.md") }),
      parent: container,
    });
    view.focus();

    const engineerFrom = doc.indexOf("Engineer");
    const engineerTo = engineerFrom + "Engineer".length;
    view.dispatch({ selection: EditorSelection.range(engineerFrom, engineerTo) });
    view.dispatch(view.state.replaceSelection("")); // clear the cell
    view.dispatch(view.state.replaceSelection("Manager")); // retype it

    expect(view.state.doc.toString()).toBe(
      "| Name  | Role     | Score | Notes |\n| ------ | -------- | ----- | ----- |\n| Alice  | Manager | 92    | first |\n",
    );
  });

  it("reaches an empty cell by cursor motion and fills it, without disturbing the next column", () => {
    const doc = "| Name | Role | Score |\n| ---- | ---- | ----- |\n| Dan  |      | 55    |\n";
    container = document.createElement("div");
    document.body.appendChild(container);
    view = new EditorView({
      state: EditorState.create({ doc, extensions: markdownExtensions("test.md") }),
      parent: container,
    });
    view.focus();

    const danEnd = doc.indexOf("Dan") + "Dan".length;
    view.dispatch({ selection: EditorSelection.cursor(danEnd) });
    const moved = view.moveByChar(view.state.selection.main, true);
    view.dispatch({ changes: { from: moved.head, to: moved.head, insert: "X" } });

    expect(view.state.doc.toString()).toContain("55    |"); // Score's "55" is untouched
    expect(view.state.doc.toString()).not.toContain("X55");
    const danLine = view.state.doc.line(3);
    expect(view.state.doc.sliceString(danLine.from, danLine.to)).toContain("X");
  });
});

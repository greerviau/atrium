import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

interface InternalDocView {
  enforceCursorAssoc(): void;
  lineAt(pos: number, assoc: number): unknown;
}

let view: EditorView | undefined;
let container: HTMLDivElement | undefined;

function enableSelectionModify(): void {
  const selection = document.getSelection();
  if (selection) {
    Object.defineProperty(selection, "modify", { value: vi.fn(), configurable: true });
  }
}

function wrappedView(): { view: EditorView; docView: InternalDocView } {
  container = document.createElement("div");
  document.body.appendChild(container);
  view = new EditorView({
    state: EditorState.create({
      doc: "wrapped line",
      selection: EditorSelection.cursor(0),
      extensions: [EditorView.lineWrapping],
    }),
    parent: container,
  });
  return {
    view,
    docView: (view as unknown as { docView: InternalDocView }).docView,
  };
}

afterEach(() => {
  view?.destroy();
  view = undefined;
  container?.remove();
  container = undefined;
  const selection = document.getSelection();
  if (selection && Object.prototype.hasOwnProperty.call(selection, "modify")) {
    Reflect.deleteProperty(selection, "modify");
  }
});

/**
 * Atrium's `@codemirror/view` patch guards `DocView.enforceCursorAssoc()`
 * when the view is unfocused. WebKit focuses a contenteditable when the
 * unpatched method collapses the DOM selection at a visual wrap boundary,
 * which steals focus back from the terminal after an outside click.
 */
describe("@codemirror/view unfocused cursor-association patch (issue #359)", () => {
  it("does not inspect wrapped-line geometry for an unfocused editor", () => {
    const { view, docView } = wrappedView();
    const lineAt = vi.spyOn(docView, "lineAt").mockReturnValue(null);
    enableSelectionModify();
    view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(3, 1)]) });

    expect(view.hasFocus).toBe(false);
    expect(view.state.selection.main.assoc).toBe(1);
    docView.enforceCursorAssoc();

    expect(lineAt).not.toHaveBeenCalled();
  });

  it("preserves cursor-association enforcement while the editor is focused", () => {
    const { view, docView } = wrappedView();
    const lineAt = vi.spyOn(docView, "lineAt").mockReturnValue(null);
    enableSelectionModify();
    view.focus();
    view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(3, 1)]) });
    expect(view.hasFocus).toBe(true);
    expect(view.state.selection.main.assoc).toBe(1);
    expect(typeof document.getSelection()?.modify).toBe("function");

    docView.enforceCursorAssoc();

    expect(lineAt).toHaveBeenCalledWith(3, 1);
  });
});

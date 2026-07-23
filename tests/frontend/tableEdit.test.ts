import { describe, it, expect } from "vitest";
import { EditorState, EditorSelection, type TransactionSpec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { history, defaultKeymap, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  findTableContext,
  insertRow,
  deleteRow,
  moveRow,
  insertColumn,
  deleteColumn,
  moveColumn,
  tableNavigationKeymap,
  type TableEditContext,
} from "../../src/lib/editor/markdown/tableEdit";
import { markdownExtensions } from "../../src/lib/editor/markdown/livePreviewPlugin";

type Command = (state: EditorState, ctx: TableEditContext) => TransactionSpec | null;

function stateFor(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] });
}

function ctxAt(doc: string, pos: number): TableEditContext {
  const ctx = findTableContext(stateFor(doc), pos);
  if (!ctx) throw new Error(`expected a table context at position ${pos} in ${JSON.stringify(doc)}`);
  return ctx;
}

function specAt(doc: string, pos: number, fn: Command): TransactionSpec | null {
  const state = stateFor(doc);
  const ctx = findTableContext(state, pos);
  if (!ctx) throw new Error(`expected a table context at position ${pos} in ${JSON.stringify(doc)}`);
  return fn(state, ctx);
}

function apply(doc: string, pos: number, fn: Command): string {
  const state = stateFor(doc);
  const ctx = findTableContext(state, pos);
  if (!ctx) throw new Error(`expected a table context at position ${pos} in ${JSON.stringify(doc)}`);
  const spec = fn(state, ctx);
  if (!spec) throw new Error("expected a non-null TransactionSpec");
  return state.update(spec).state.doc.toString();
}

// header + 2 body rows, no alignment markers — the common case.
const BASIC = "| Name  | Role     |\n| ----- | -------- |\n| Alice | Engineer |\n| Bob   | Designer |\n";

describe("findTableContext", () => {
  it("returns null outside any table", () => {
    expect(findTableContext(stateFor("plain text\n"), 3)).toBeNull();
  });

  it("resolves the header row", () => {
    const ctx = ctxAt(BASIC, BASIC.indexOf("Name"));
    expect(ctx.rowKind).toBe("header");
    expect(ctx.rowIndex).toBe(0);
    expect(ctx.column).toBe(0);
    expect(ctx.columnCount).toBe(2);
    expect(ctx.rows.length).toBe(3);
  });

  it("resolves column index by which cell the position falls in", () => {
    expect(ctxAt(BASIC, BASIC.indexOf("Role")).column).toBe(1);
  });

  it("resolves body rows with the right rowIndex, rows[0] always the header", () => {
    expect(ctxAt(BASIC, BASIC.indexOf("Alice")).rowIndex).toBe(1);
    expect(ctxAt(BASIC, BASIC.indexOf("Bob")).rowIndex).toBe(2);
  });

  it("resolves the delimiter row with rowIndex -1 and a column via its own alignment segments", () => {
    const ctx = ctxAt(BASIC, BASIC.indexOf("-----"));
    expect(ctx.rowKind).toBe("delimiter");
    expect(ctx.rowIndex).toBe(-1);
    expect(ctx.column).toBe(0);
    const ctxSecondSegment = ctxAt(BASIC, BASIC.indexOf("--------"));
    expect(ctxSecondSegment.column).toBe(1);
  });
});

describe("insertRow", () => {
  it("is null above the header", () => {
    expect(specAt(BASIC, BASIC.indexOf("Name"), (s, c) => insertRow(s, c, "above"))).toBeNull();
  });

  it("is null above the delimiter", () => {
    expect(specAt(BASIC, BASIC.indexOf("-----"), (s, c) => insertRow(s, c, "above"))).toBeNull();
  });

  it("inserts the first body row below the header", () => {
    expect(apply(BASIC, BASIC.indexOf("Name"), (s, c) => insertRow(s, c, "below"))).toBe(
      "| Name  | Role     |\n| ----- | -------- |\n|  |  |\n| Alice | Engineer |\n| Bob   | Designer |\n",
    );
  });

  it("inserts the identical first body row when targeted from the delimiter", () => {
    expect(apply(BASIC, BASIC.indexOf("-----"), (s, c) => insertRow(s, c, "below"))).toBe(
      "| Name  | Role     |\n| ----- | -------- |\n|  |  |\n| Alice | Engineer |\n| Bob   | Designer |\n",
    );
  });

  it("inserts above a body row, becoming the new row at that position", () => {
    expect(apply(BASIC, BASIC.indexOf("Alice"), (s, c) => insertRow(s, c, "above"))).toBe(
      "| Name  | Role     |\n| ----- | -------- |\n|  |  |\n| Alice | Engineer |\n| Bob   | Designer |\n",
    );
  });

  it("inserts below a body row", () => {
    expect(apply(BASIC, BASIC.indexOf("Alice"), (s, c) => insertRow(s, c, "below"))).toBe(
      "| Name  | Role     |\n| ----- | -------- |\n| Alice | Engineer |\n|  |  |\n| Bob   | Designer |\n",
    );
  });

  it("inserts below the last row ahead of a trailing blank line", () => {
    expect(apply(BASIC, BASIC.indexOf("Bob"), (s, c) => insertRow(s, c, "below"))).toBe(
      "| Name  | Role     |\n| ----- | -------- |\n| Alice | Engineer |\n| Bob   | Designer |\n|  |  |\n",
    );
  });

  it("inserts below the last row when it's also the last line of the document", () => {
    const doc = "| Name  | Role     |\n| ----- | -------- |\n| Alice | Engineer |\n| Bob   | Designer |";
    expect(apply(doc, doc.indexOf("Bob"), (s, c) => insertRow(s, c, "below"))).toBe(
      "| Name  | Role     |\n| ----- | -------- |\n| Alice | Engineer |\n| Bob   | Designer |\n|  |  |",
    );
  });

  it("lands the cursor in the new row's first (empty) cell", () => {
    const state = stateFor(BASIC);
    const ctx = findTableContext(state, BASIC.indexOf("Name"))!;
    const spec = insertRow(state, ctx, "below")!;
    const next = state.update(spec).state;
    const newRowLine = next.doc.line(3);
    expect(next.doc.sliceString(newRowLine.from, newRowLine.to)).toBe("|  |  |");
    expect(next.selection.main.head).toBe(newRowLine.from + 2);
  });

  it("preserves a blockquote's leading marker on the inserted row", () => {
    const doc = "> | A | B |\n> | --- | --- |\n> | 1 | 2 |\n";
    expect(apply(doc, doc.indexOf("1"), (s, c) => insertRow(s, c, "above"))).toBe(
      "> | A | B |\n> | --- | --- |\n> |  |  |\n> | 1 | 2 |\n",
    );
  });

  it("preserves a list item's leading indentation on the inserted row", () => {
    const doc = "- item\n\n  | A | B |\n  | --- | --- |\n  | 1 | 2 |\n";
    expect(apply(doc, doc.indexOf("| 1") + 2, (s, c) => insertRow(s, c, "above"))).toBe(
      "- item\n\n  | A | B |\n  | --- | --- |\n  |  |  |\n  | 1 | 2 |\n",
    );
  });
});

describe("deleteRow", () => {
  it("is null on the header", () => {
    expect(specAt(BASIC, BASIC.indexOf("Name"), (s, c) => deleteRow(s, c))).toBeNull();
  });

  it("is null on the delimiter", () => {
    expect(specAt(BASIC, BASIC.indexOf("-----"), (s, c) => deleteRow(s, c))).toBeNull();
  });

  it("removes a body row entirely, including its own newline", () => {
    expect(apply(BASIC, BASIC.indexOf("Alice"), (s, c) => deleteRow(s, c))).toBe(
      "| Name  | Role     |\n| ----- | -------- |\n| Bob   | Designer |\n",
    );
  });

  it("removes the last body row when it's also the last line of the document", () => {
    const doc = "| Name  | Role     |\n| ----- | -------- |\n| Alice | Engineer |\n| Bob   | Designer |";
    expect(apply(doc, doc.indexOf("Bob"), (s, c) => deleteRow(s, c))).toBe(
      "| Name  | Role     |\n| ----- | -------- |\n| Alice | Engineer |\n",
    );
  });

  it("leaves a well-formed, empty table when deleting the only body row", () => {
    const doc = "| Name  |\n| ----- |\n| Alice |\n";
    expect(apply(doc, doc.indexOf("Alice"), (s, c) => deleteRow(s, c))).toBe("| Name  |\n| ----- |\n");
  });
});

describe("moveRow", () => {
  it("is null on the header, both directions", () => {
    expect(specAt(BASIC, BASIC.indexOf("Name"), (s, c) => moveRow(s, c, "up"))).toBeNull();
    expect(specAt(BASIC, BASIC.indexOf("Name"), (s, c) => moveRow(s, c, "down"))).toBeNull();
  });

  it("is null on the delimiter, both directions", () => {
    expect(specAt(BASIC, BASIC.indexOf("-----"), (s, c) => moveRow(s, c, "up"))).toBeNull();
    expect(specAt(BASIC, BASIC.indexOf("-----"), (s, c) => moveRow(s, c, "down"))).toBeNull();
  });

  it("is null moving the first body row up (its neighbor there is the header)", () => {
    expect(specAt(BASIC, BASIC.indexOf("Alice"), (s, c) => moveRow(s, c, "up"))).toBeNull();
  });

  it("is null moving the last body row down", () => {
    expect(specAt(BASIC, BASIC.indexOf("Bob"), (s, c) => moveRow(s, c, "down"))).toBeNull();
  });

  it("swaps two adjacent body rows, moving the first one down", () => {
    expect(apply(BASIC, BASIC.indexOf("Alice"), (s, c) => moveRow(s, c, "down"))).toBe(
      "| Name  | Role     |\n| ----- | -------- |\n| Bob   | Designer |\n| Alice | Engineer |\n",
    );
  });

  it("swaps two adjacent body rows, moving the second one up (same result)", () => {
    expect(apply(BASIC, BASIC.indexOf("Bob"), (s, c) => moveRow(s, c, "up"))).toBe(
      "| Name  | Role     |\n| ----- | -------- |\n| Bob   | Designer |\n| Alice | Engineer |\n",
    );
  });
});

describe("insertColumn", () => {
  it("inserts a left-aligned empty column at the leftmost edge, across every row and the delimiter", () => {
    expect(apply(BASIC, BASIC.indexOf("Name"), (s, c) => insertColumn(s, c, "left"))).toBe(
      "|  | Name  | Role     |\n| --- | ----- | -------- |\n|  | Alice | Engineer |\n|  | Bob   | Designer |\n",
    );
  });

  it("'right' at column c and 'left' at column c+1 insert at the identical boundary", () => {
    const right = apply(BASIC, BASIC.indexOf("Name"), (s, c) => insertColumn(s, c, "right"));
    const left = apply(BASIC, BASIC.indexOf("Role"), (s, c) => insertColumn(s, c, "left"));
    expect(right).toBe(left);
    expect(right).toBe(
      "| Name |   | Role     |\n| ----- | --- | -------- |\n| Alice |  | Engineer |\n| Bob |    | Designer |\n",
    );
  });

  it("appends a new column at the rightmost edge", () => {
    expect(apply(BASIC, BASIC.indexOf("Role"), (s, c) => insertColumn(s, c, "right"))).toBe(
      "| Name  | Role |      |\n| ----- | -------- | --- |\n| Alice | Engineer |  |\n| Bob   | Designer |  |\n",
    );
  });

  it("doesn't double-insert into an already-empty cell — it gets its own new neighbor", () => {
    const doc = "| A | B | C |\n| --- | --- | --- |\n| 1 |  | 3 |\n";
    const emptyColPos = doc.indexOf("| 1") + 6; // inside the already-empty middle cell
    expect(apply(doc, emptyColPos, (s, c) => insertColumn(s, c, "left"))).toBe(
      "| A |  | B | C |\n| --- | --- | --- | --- |\n| 1 |  |  | 3 |\n",
    );
  });

  it("gives identical results whether resolved from the delimiter row or the header", () => {
    const fromHeader = apply(BASIC, BASIC.indexOf("Role"), (s, c) => insertColumn(s, c, "left"));
    const fromDelimiter = apply(BASIC, BASIC.indexOf("--------"), (s, c) => insertColumn(s, c, "left"));
    expect(fromDelimiter).toBe(fromHeader);
  });

  it("preserves a row's own omitted outer pipes", () => {
    const doc = "A | B\n--- | ---\n1 | 2\n";
    expect(apply(doc, doc.lastIndexOf("1"), (s, c) => insertColumn(s, c, "left"))).toBe(" | A | B\n--- | --- | ---\n | 1 | 2\n");
    expect(apply(doc, doc.lastIndexOf("1"), (s, c) => insertColumn(s, c, "right"))).toBe("A |  | B\n--- | --- | ---\n1 |  | 2\n");
  });

  it("leaves a link cell adjacent to the inserted column untouched", () => {
    const doc = "| A | B |\n| --- | --- |\n| [text](url) | plain |\n";
    expect(apply(doc, doc.indexOf("[text]"), (s, c) => insertColumn(s, c, "right"))).toBe(
      "| A |  | B |\n| --- | --- | --- |\n| [text](url) |  | plain |\n",
    );
  });

  it("leaves an escaped pipe in an untouched cell round-tripping unchanged", () => {
    const doc = "| A | B |\n| --- | --- |\n| a\\|b | plain |\n";
    expect(apply(doc, doc.indexOf("plain"), (s, c) => insertColumn(s, c, "left"))).toBe(
      "| A |  | B |\n| --- | --- | --- |\n| a\\|b |  | plain |\n",
    );
  });
});

describe("deleteColumn", () => {
  it("is null with only one column", () => {
    const doc = "| Name  |\n| ----- |\n| Alice |\n";
    expect(specAt(doc, doc.indexOf("Alice"), (s, c) => deleteColumn(s, c))).toBeNull();
  });

  it("removes the leftmost column plus its trailing gap", () => {
    expect(apply(BASIC, BASIC.indexOf("Name"), (s, c) => deleteColumn(s, c))).toBe(
      "| Role     |\n| -------- |\n| Engineer |\n| Designer |\n",
    );
  });

  it("removes an interior/rightmost column plus its leading gap", () => {
    expect(apply(BASIC, BASIC.indexOf("Role"), (s, c) => deleteColumn(s, c))).toBe(
      "| Name     |\n| ----- |\n| Alice |\n| Bob |\n",
    );
  });

  it("preserves a row's own omitted outer pipes", () => {
    const doc = "A | B\n--- | ---\n1 | 2\n";
    expect(apply(doc, doc.lastIndexOf("1"), (s, c) => deleteColumn(s, c))).toBe("B\n---\n2\n");
  });

  it("leaves a bold cell adjacent to the deleted column untouched", () => {
    const doc = "| A | B | C |\n| --- | --- | --- |\n| **bold** | mid | end |\n";
    expect(apply(doc, doc.indexOf("mid"), (s, c) => deleteColumn(s, c))).toBe(
      "| A | C |\n| --- | --- |\n| **bold** | end |\n",
    );
  });
});

describe("moveColumn", () => {
  it("is null with only one column", () => {
    const doc = "| Name  |\n| ----- |\n| Alice |\n";
    expect(specAt(doc, doc.indexOf("Alice"), (s, c) => moveColumn(s, c, "left"))).toBeNull();
  });

  it("is null moving the leftmost column further left", () => {
    expect(specAt(BASIC, BASIC.indexOf("Name"), (s, c) => moveColumn(s, c, "left"))).toBeNull();
  });

  it("is null moving the rightmost column further right", () => {
    expect(specAt(BASIC, BASIC.indexOf("Role"), (s, c) => moveColumn(s, c, "right"))).toBeNull();
  });

  it("swaps two adjacent columns' content, per row", () => {
    const left = apply(BASIC, BASIC.indexOf("Role"), (s, c) => moveColumn(s, c, "left"));
    const right = apply(BASIC, BASIC.indexOf("Name"), (s, c) => moveColumn(s, c, "right"));
    expect(left).toBe(right);
    expect(left).toBe(
      "| Role  | Name     |\n| -------- | ----- |\n| Engineer | Alice |\n| Designer   | Bob |\n",
    );
  });

  it("moves a column's alignment along with it", () => {
    const doc = "| A | B | C |\n| --- | :---: | ---: |\n| 1 | 2 | 3 |\n";
    expect(apply(doc, doc.indexOf("B"), (s, c) => moveColumn(s, c, "left"))).toBe(
      "| B | A | C |\n| :---: | --- | ---: |\n| 2 | 1 | 3 |\n",
    );
  });

  it("gives identical results whether resolved from the delimiter row or the header", () => {
    const fromHeader = apply(BASIC, BASIC.indexOf("Role"), (s, c) => moveColumn(s, c, "left"));
    const fromDelimiter = apply(BASIC, BASIC.indexOf("--------"), (s, c) => moveColumn(s, c, "left"));
    expect(fromDelimiter).toBe(fromHeader);
  });

  it("leaves a bold cell's own content intact when it's the one being moved", () => {
    const doc = "| A | B |\n| --- | --- |\n| **bold** | plain |\n";
    expect(apply(doc, doc.indexOf("**bold**"), (s, c) => moveColumn(s, c, "right"))).toBe(
      "| B | A |\n| --- | --- |\n| plain | **bold** |\n",
    );
  });
});

// GFM lets a body row have fewer cells than the header — missing trailing
// cells are implicitly empty (a common shape: a row mid-typed, or pasted
// short). Every column command must handle a row this short reaching for a
// column it doesn't have, across every row in the table, not just the one
// the context was resolved from — a right-click landing on the fully-populated
// header of a table containing a short row further down still has to
// evaluate every command's availability (the context menu's own
// `disabled={...}` checks call these functions directly during render).
describe("ragged rows (a body row shorter than the header)", () => {
  const RAGGED = "| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 |\n";

  it("insertColumn at the leftmost edge still reaches every row, short ones included", () => {
    expect(apply(RAGGED, RAGGED.indexOf("A"), (s, c) => insertColumn(s, c, "left"))).toBe(
      "|  | A | B | C |\n| --- | --- | --- | --- |\n|  | 1 | 2 | 3 |\n|  | 4 |\n",
    );
  });

  it("insertColumn past a short row's own last cell leaves that row untouched", () => {
    expect(apply(RAGGED, RAGGED.indexOf("B"), (s, c) => insertColumn(s, c, "right"))).toBe(
      "| A | B |  | C |\n| --- | --- | --- | --- |\n| 1 | 2 |  | 3 |\n| 4 |\n",
    );
  });

  it("deleteColumn(0) on a row with only that one cell empties it in place rather than crashing", () => {
    expect(apply(RAGGED, RAGGED.indexOf("A"), (s, c) => deleteColumn(s, c))).toBe(
      "| B | C |\n| --- | --- |\n| 2 | 3 |\n|  |\n",
    );
  });

  it("deleteColumn past a short row's own last cell leaves that row untouched", () => {
    expect(apply(RAGGED, RAGGED.indexOf("C"), (s, c) => deleteColumn(s, c))).toBe(
      "| A | B |\n| --- | --- |\n| 1 | 2 |\n| 4 |\n",
    );
  });

  it("moveColumn relocates a short row's own last real cell instead of leaving it mislabeled", () => {
    // Swapping A/B: the short row's "4" belongs to column A. Left in place,
    // it would render under whatever now sits at index 0 (B) after the
    // swap — silently attributing it to the wrong column. It must move to
    // index 1 (where A now renders) instead.
    expect(apply(RAGGED, RAGGED.indexOf("A"), (s, c) => moveColumn(s, c, "right"))).toBe(
      "| B | A | C |\n| --- | --- | --- |\n| 2 | 1 | 3 |\n|  | 4 |\n",
    );
  });

  it("moveColumn between two columns a short row has neither of is a no-op for that row", () => {
    const fromB = apply(RAGGED, RAGGED.indexOf("B"), (s, c) => moveColumn(s, c, "right"));
    const fromC = apply(RAGGED, RAGGED.indexOf("C"), (s, c) => moveColumn(s, c, "left"));
    expect(fromB).toBe(fromC);
    expect(fromB).toBe("| A | C | B |\n| --- | --- | --- |\n| 1 | 3 | 2 |\n| 4 |\n");
  });

  it("none of the six commands throw when resolved from the header of a table containing a short row", () => {
    const ctx = ctxAt(RAGGED, RAGGED.indexOf("A"));
    const state = stateFor(RAGGED);
    expect(() => insertRow(state, ctx, "below")).not.toThrow();
    expect(() => deleteRow(state, ctx)).not.toThrow();
    expect(() => moveRow(state, ctx, "down")).not.toThrow();
    expect(() => insertColumn(state, ctx, "left")).not.toThrow();
    expect(() => insertColumn(state, ctx, "right")).not.toThrow();
    expect(() => deleteColumn(state, ctx)).not.toThrow();
    expect(() => moveColumn(state, ctx, "left")).not.toThrow();
    expect(() => moveColumn(state, ctx, "right")).not.toThrow();
  });
});

describe("tableNavigationKeymap", () => {
  // Mounted through the same extension order EditorPane.svelte uses
  // (a generic Tab/Enter-binding keymap before markdownExtensions), the same
  // technique this plan's own reproduction script used — testing
  // tableNavigationKeymap in isolation would pass even if livePreviewPlugin.ts
  // dropped its Prec.highest wrapper, since nothing else would be competing
  // for Tab/Enter in an isolated test.
  function makeView(doc: string, cursor: number): { view: EditorView; container: HTMLElement } {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: EditorSelection.cursor(cursor),
        extensions: [history(), keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]), markdownExtensions("test.md")],
      }),
      parent: container,
    });
    return { view, container };
  }

  function fireTab(view: EditorView, shift = false): void {
    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", shiftKey: shift, bubbles: true, cancelable: true }),
    );
  }

  function fireEnter(view: EditorView): void {
    view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  }

  it("exports three bindings: Tab, Shift-Tab, and Enter", () => {
    const keys = tableNavigationKeymap.map((binding) => binding.key);
    expect(keys).toEqual(["Tab", "Shift-Tab", "Enter"]);
  });

  it("Tab moves the cursor into the next cell", () => {
    const { view, container } = makeView(BASIC, BASIC.indexOf("Alice"));
    fireTab(view);
    expect(view.state.selection.main.head).toBe(BASIC.indexOf("Engineer"));
    view.destroy();
    container.remove();
  });

  it("Tab at the last cell of the last row inserts a new row and lands in it", () => {
    const doc = "| Name  | Role     |\n| ----- | -------- |\n| Alice | Engineer |\n";
    const { view, container } = makeView(doc, doc.indexOf("Engineer"));
    fireTab(view);
    expect(view.state.doc.toString()).toBe(
      "| Name  | Role     |\n| ----- | -------- |\n| Alice | Engineer |\n|  |  |\n",
    );
    const newRowLine = view.state.doc.line(4);
    expect(view.state.selection.main.head).toBe(newRowLine.from + 2);
    view.destroy();
    container.remove();
  });

  it("Shift-Tab moves the cursor to the previous cell, wrapping to the previous row's last cell", () => {
    const { view, container } = makeView(BASIC, BASIC.indexOf("Bob"));
    fireTab(view, true);
    expect(view.state.selection.main.head).toBe(BASIC.indexOf("Engineer"));
    view.destroy();
    container.remove();
  });

  it("Shift-Tab at the table's very first cell is a no-op", () => {
    const { view, container } = makeView(BASIC, BASIC.indexOf("Name"));
    const before = view.state.doc.toString();
    fireTab(view, true);
    expect(view.state.doc.toString()).toBe(before);
    expect(view.state.selection.main.head).toBe(BASIC.indexOf("Name"));
    view.destroy();
    container.remove();
  });

  it("Enter moves the cursor down to the same column in the next row", () => {
    const { view, container } = makeView(BASIC, BASIC.indexOf("Engineer"));
    fireEnter(view);
    expect(view.state.selection.main.head).toBe(BASIC.indexOf("Designer"));
    expect(view.state.doc.toString()).toBe(BASIC);
    view.destroy();
    container.remove();
  });

  it("Enter on the last row inserts a new row instead of splitting one", () => {
    const doc = "| Name  | Role     |\n| ----- | -------- |\n| Alice | Engineer |\n";
    const { view, container } = makeView(doc, doc.indexOf("Engineer"));
    fireEnter(view);
    expect(view.state.doc.toString()).toBe(
      "| Name  | Role     |\n| ----- | -------- |\n| Alice | Engineer |\n|  |  |\n",
    );
    view.destroy();
    container.remove();
  });

  it("Enter into a shorter next row clamps to that row's own last real cell instead of throwing", () => {
    const doc = "| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 |\n";
    const { view, container } = makeView(doc, doc.indexOf("2"));
    fireEnter(view);
    expect(view.state.doc.toString()).toBe(doc);
    expect(view.state.selection.main.head).toBe(doc.lastIndexOf("4"));
    view.destroy();
    container.remove();
  });

  it("falls through to indentWithTab/insertNewlineAndIndent outside a table", () => {
    const { view: tabView, container: tabContainer } = makeView("plain text here", 5);
    fireTab(tabView);
    expect(tabView.state.doc.toString()).toBe("  plain text here");
    tabView.destroy();
    tabContainer.remove();

    const { view: enterView, container: enterContainer } = makeView("plain text here", 5);
    fireEnter(enterView);
    expect(enterView.state.doc.toString()).not.toBe("plain text here");
    expect(enterView.state.doc.lines).toBe(2);
    enterView.destroy();
    enterContainer.remove();
  });
});

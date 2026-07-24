import { describe, it, expect, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  AddColumnBandWidget,
  AddRowBandWidget,
  NO_TABLE_HOVER,
  RowHandleWidget,
  TableColumnBarWidget,
  applyColumnBars,
  measureColumnBars,
  setTableHover,
  tableHoverField,
} from "../../src/lib/editor/markdown/tableHandles";
import { markdownExtensions } from "../../src/lib/editor/markdown/livePreviewPlugin";

function makeView(doc: string): EditorView {
  return new EditorView({
    state: EditorState.create({ doc, extensions: markdownExtensions("test.md") }),
    parent: document.createElement("div"),
  });
}

/**
 * Mirrors `EditorPaneSplit.test.ts`/`PaneSplit.test.ts`'s own
 * `pointerLikeEvent` helper: a plain bubbling `Event` with the right type
 * name is enough to exercise `addEventListener("pointerenter"/...)`
 * listeners under jsdom, without depending on jsdom's own (limited)
 * `PointerEvent` support.
 */
function pointerLikeEvent(type: string): Event {
  return new Event(type, { bubbles: true, cancelable: true });
}

describe("tableHoverField", () => {
  it("defaults to NO_TABLE_HOVER", () => {
    const state = EditorState.create({ extensions: [tableHoverField] });
    expect(state.field(tableHoverField)).toEqual(NO_TABLE_HOVER);
  });

  it("updates on setTableHover, and clears on any doc change that doesn't itself carry a new value", () => {
    let view = new EditorView({ state: EditorState.create({ doc: "hello", extensions: [tableHoverField] }) });
    view.dispatch({ effects: setTableHover.of({ table: 0, row: 1, col: null }) });
    expect(view.state.field(tableHoverField)).toEqual({ table: 0, row: 1, col: null });

    view.dispatch({ changes: { from: 0, insert: "x" } });
    expect(view.state.field(tableHoverField)).toEqual(NO_TABLE_HOVER);
    view.destroy();
  });

  it("keeps an effect's value even when the same transaction also changes the document", () => {
    const view = new EditorView({ state: EditorState.create({ doc: "hello", extensions: [tableHoverField] }) });
    view.dispatch({
      changes: { from: 0, insert: "x" },
      effects: setTableHover.of({ table: 1, row: null, col: 2 }),
    });
    expect(view.state.field(tableHoverField)).toEqual({ table: 1, row: null, col: 2 });
    view.destroy();
  });
});

describe("RowHandleWidget", () => {
  it("eq() compares table and row, not identity", () => {
    expect(new RowHandleWidget(0, 1).eq(new RowHandleWidget(0, 1))).toBe(true);
    expect(new RowHandleWidget(0, 1).eq(new RowHandleWidget(0, 2))).toBe(false);
    expect(new RowHandleWidget(0, 1).eq(new RowHandleWidget(5, 1))).toBe(false);
  });

  it("dispatches this row's {table, row} on pointerenter and on click, and clears it on pointerleave", () => {
    const view = makeView("| A | B |\n| --- | --- |\n| 1 | 2 |\n");
    const widget = new RowHandleWidget(0, 1);
    const dom = widget.toDOM(view);

    dom.dispatchEvent(pointerLikeEvent("pointerenter"));
    expect(view.state.field(tableHoverField)).toEqual({ table: 0, row: 1, col: null });

    dom.dispatchEvent(pointerLikeEvent("pointerleave"));
    expect(view.state.field(tableHoverField)).toEqual(NO_TABLE_HOVER);

    dom.dispatchEvent(pointerLikeEvent("click"));
    expect(view.state.field(tableHoverField)).toEqual({ table: 0, row: 1, col: null });

    view.destroy();
  });

  it("renders the six-dot handle glyph", () => {
    const view = makeView("| A |\n| --- |\n| 1 |\n");
    const dom = new RowHandleWidget(0, 0).toDOM(view);
    expect(dom.querySelectorAll(".cm-table-handle-dot")).toHaveLength(6);
    view.destroy();
  });
});

describe("TableColumnBarWidget", () => {
  it("eq() compares table and column, not identity", () => {
    expect(new TableColumnBarWidget(0, 1).eq(new TableColumnBarWidget(0, 1))).toBe(true);
    expect(new TableColumnBarWidget(0, 1).eq(new TableColumnBarWidget(0, 2))).toBe(false);
  });

  it("dispatches this column's {table, col} on pointerenter/click, and clears it on pointerleave", () => {
    const view = makeView("| A | B |\n| --- | --- |\n| 1 | 2 |\n");
    const widget = new TableColumnBarWidget(0, 1);
    const dom = widget.toDOM(view);

    dom.dispatchEvent(pointerLikeEvent("pointerenter"));
    expect(view.state.field(tableHoverField)).toEqual({ table: 0, row: null, col: 1 });

    dom.dispatchEvent(pointerLikeEvent("pointerleave"));
    expect(view.state.field(tableHoverField)).toEqual(NO_TABLE_HOVER);

    view.destroy();
  });
});

describe("measureColumnBars / applyColumnBars", () => {
  function mockOffset(el: HTMLElement, left: number, width: number): void {
    Object.defineProperty(el, "offsetLeft", { value: left, configurable: true });
    Object.defineProperty(el, "offsetWidth", { value: width, configurable: true });
  }

  // The whole point of DOM measurement (over the abandoned decoration-anchor
  // approach) is that it doesn't care what's inside a header cell — an
  // empty cell's placeholder and a single-character cell are both just
  // ordinary elements to measure. This exercises exactly that: one
  // zero-width (empty-cell placeholder) column and one narrow
  // (single-character) column, matched purely by DOM position.
  it("reads each header cell's real offsetLeft/offsetWidth and writes them onto the matching column bar, by position", () => {
    // Plain text, deliberately no real table — this test builds its own
    // mock .cm-table-box by hand, and a real table rendered by
    // markdownExtensions would add a second one, breaking the `toHaveLength(1)`
    // assertion below.
    const view = makeView("plain text, no table\n");
    const box = document.createElement("div");
    box.className = "cm-table-box";

    const emptyCell = document.createElement("span");
    emptyCell.className = "cm-table-header-cell";
    mockOffset(emptyCell, 0, 0);
    const narrowCell = document.createElement("span");
    narrowCell.className = "cm-table-header-cell";
    mockOffset(narrowCell, 0, 12);
    const wideCell = document.createElement("span");
    wideCell.className = "cm-table-header-cell";
    mockOffset(wideCell, 12, 80);
    box.append(emptyCell, narrowCell, wideCell);

    const barEmpty = document.createElement("span");
    barEmpty.className = "cm-table-col-bar";
    const barNarrow = document.createElement("span");
    barNarrow.className = "cm-table-col-bar";
    const barWide = document.createElement("span");
    barWide.className = "cm-table-col-bar";
    box.append(barEmpty, barNarrow, barWide);

    view.dom.appendChild(box);

    const measurements = measureColumnBars(view);
    expect(measurements).toHaveLength(1);
    expect(measurements[0].cellRects).toEqual([
      { left: 0, width: 0 },
      { left: 0, width: 12 },
      { left: 12, width: 80 },
    ]);

    applyColumnBars(measurements);
    expect(barEmpty.style.left).toBe("0px");
    expect(barEmpty.style.width).toBe("0px");
    expect(barNarrow.style.left).toBe("0px");
    expect(barNarrow.style.width).toBe("12px");
    expect(barWide.style.left).toBe("12px");
    expect(barWide.style.width).toBe("80px");

    view.destroy();
  });

  it("measures every .cm-table-box independently, when two are present", () => {
    const view = makeView("hello\n");
    const boxA = document.createElement("div");
    boxA.className = "cm-table-box";
    const cellA = document.createElement("span");
    cellA.className = "cm-table-header-cell";
    mockOffset(cellA, 5, 50);
    boxA.appendChild(cellA);

    const boxB = document.createElement("div");
    boxB.className = "cm-table-box";
    const cellB = document.createElement("span");
    cellB.className = "cm-table-header-cell";
    mockOffset(cellB, 9, 90);
    boxB.appendChild(cellB);

    view.dom.append(boxA, boxB);

    const measurements = measureColumnBars(view);
    expect(measurements).toHaveLength(2);
    expect(measurements[0].cellRects).toEqual([{ left: 5, width: 50 }]);
    expect(measurements[1].cellRects).toEqual([{ left: 9, width: 90 }]);

    view.destroy();
  });
});

describe("AddRowBandWidget / AddColumnBandWidget", () => {
  it("clicking the add-row band appends a new row after the table's current last row", () => {
    const doc = "| Name  | Role     |\n| ----- | -------- |\n| Alice | Engineer |\n| Bob   | Designer |\n";
    const view = makeView(doc);
    const dom = new AddRowBandWidget(0).toDOM(view);

    dom.dispatchEvent(pointerLikeEvent("click"));

    expect(view.state.doc.toString()).toBe(
      "| Name  | Role     |\n| ----- | -------- |\n| Alice | Engineer |\n| Bob   | Designer |\n|  |  |\n",
    );
    view.destroy();
  });

  it("clicking the add-column band appends a new column after the table's current last column", () => {
    const doc = "| Name  | Role     |\n| ----- | -------- |\n| Alice | Engineer |\n";
    const view = makeView(doc);
    const dom = new AddColumnBandWidget(0).toDOM(view);

    dom.dispatchEvent(pointerLikeEvent("click"));

    expect(view.state.doc.toString()).toBe(
      "| Name  | Role |      |\n| ----- | -------- | --- |\n| Alice | Engineer |  |\n",
    );
    view.destroy();
  });

  it("is a no-op (no crash, no dispatch) when the stored table position no longer resolves to a table", () => {
    const view = makeView("plain text, no table\n");
    const dom = new AddRowBandWidget(0).toDOM(view);
    expect(() => dom.dispatchEvent(pointerLikeEvent("click"))).not.toThrow();
    expect(view.state.doc.toString()).toBe("plain text, no table\n");
    view.destroy();
  });

  it("destroy() tears down the tooltip action, removing any currently-shown tooltip from the document", async () => {
    vi.useFakeTimers();
    try {
      const view = makeView("| A |\n| --- |\n| 1 |\n");
      const widget = new AddRowBandWidget(0);
      const dom = widget.toDOM(view);
      document.body.appendChild(dom);

      dom.dispatchEvent(new Event("mouseenter", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(500);
      expect(document.querySelector(".atrium-tooltip")).toBeTruthy();

      widget.destroy();
      expect(document.querySelector(".atrium-tooltip")).toBeNull();

      dom.remove();
      view.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("table geometry DOM survives an edit inside the same table (round 3 must-fix 1)", () => {
  it("keeps every row handle, column bar, and add-row/add-column band present after an in-table edit", () => {
    const view = makeView("| A | B |\n| --- | --- |\n| 1 | 2 |\n");

    expect(view.dom.querySelectorAll(".cm-table-row-handle")).toHaveLength(2);
    expect(view.dom.querySelectorAll(".cm-table-col-bar")).toHaveLength(2);
    expect(view.dom.querySelectorAll(".cm-table-add-row-band")).toHaveLength(1);
    expect(view.dom.querySelectorAll(".cm-table-add-col-band")).toHaveLength(1);

    const editPos = view.state.doc.toString().indexOf("1") + 1;
    view.dispatch({ changes: { from: editPos, insert: "0" } });

    expect(view.dom.querySelectorAll(".cm-table-row-handle")).toHaveLength(2);
    expect(view.dom.querySelectorAll(".cm-table-col-bar")).toHaveLength(2);
    expect(view.dom.querySelectorAll(".cm-table-add-row-band")).toHaveLength(1);
    expect(view.dom.querySelectorAll(".cm-table-add-col-band")).toHaveLength(1);

    view.destroy();
  });
});

describe("clicking a rendered handle highlights its row/column (full-pipeline)", () => {
  it("clicking a row handle applies cm-table-row-selected to that row's own cells only", () => {
    const view = makeView("| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n");
    const handles = view.dom.querySelectorAll<HTMLElement>(".cm-table-row-handle");
    expect(handles).toHaveLength(3); // header + 2 body rows

    handles[1].dispatchEvent(pointerLikeEvent("click"));

    const selected = view.dom.querySelectorAll(".cm-table-row-selected");
    expect(selected).toHaveLength(2); // "1" and "2"
    view.destroy();
  });

  it("a second table in the same document never lights up from the first table's row-handle click", () => {
    const doc = "| A | B |\n| --- | --- |\n| 1 | 2 |\n\nprose\n\n| C | D |\n| --- | --- |\n| 5 | 6 |\n";
    const view = makeView(doc);
    const handles = view.dom.querySelectorAll<HTMLElement>(".cm-table-row-handle");
    expect(handles).toHaveLength(4); // 2 rows/table x 2 tables

    // Click the first table's body-row handle (index 1: header, body).
    handles[1].dispatchEvent(pointerLikeEvent("click"));

    const selected = view.dom.querySelectorAll(".cm-table-row-selected");
    expect(selected).toHaveLength(2); // just "1" and "2" from the first table
    for (const cell of selected) {
      expect(["1", "2"]).toContain(cell.textContent);
    }
    view.destroy();
  });
});

import { describe, it, expect, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  AddColumnBandWidget,
  AddRowBandWidget,
  NO_TABLE_HOVER,
  RowHandleWidget,
  TableColumnBarWidget,
  applyTableGeometry,
  measureTableGeometry,
  setTableHover,
  setTableSelection,
  tableDragField,
  tableHoverField,
  tableSelectionField,
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

describe("tableSelectionField", () => {
  it("defaults to NO_TABLE_HOVER", () => {
    const state = EditorState.create({ extensions: [tableSelectionField] });
    expect(state.field(tableSelectionField)).toEqual(NO_TABLE_HOVER);
  });

  it("updates on setTableSelection, and clears on any doc change that doesn't itself carry a new value", () => {
    const view = new EditorView({ state: EditorState.create({ doc: "hello", extensions: [tableSelectionField] }) });
    view.dispatch({ effects: setTableSelection.of({ table: 0, row: 1, col: null }) });
    expect(view.state.field(tableSelectionField)).toEqual({ table: 0, row: 1, col: null });

    view.dispatch({ changes: { from: 0, insert: "x" } });
    expect(view.state.field(tableSelectionField)).toEqual(NO_TABLE_HOVER);
    view.destroy();
  });
});

describe("RowHandleWidget", () => {
  it("eq() compares table and row, not identity", () => {
    expect(new RowHandleWidget(0, 1).eq(new RowHandleWidget(0, 1))).toBe(true);
    expect(new RowHandleWidget(0, 1).eq(new RowHandleWidget(0, 2))).toBe(false);
    expect(new RowHandleWidget(0, 1).eq(new RowHandleWidget(5, 1))).toBe(false);
  });

  it("dispatches this row's {table, row} to tableHoverField on pointerenter, and clears it on pointerleave", () => {
    const view = makeView("| A | B |\n| --- | --- |\n| 1 | 2 |\n");
    const widget = new RowHandleWidget(0, 1);
    const dom = widget.toDOM(view);

    dom.dispatchEvent(pointerLikeEvent("pointerenter"));
    expect(view.state.field(tableHoverField)).toEqual({ table: 0, row: 1, col: null });

    dom.dispatchEvent(pointerLikeEvent("pointerleave"));
    expect(view.state.field(tableHoverField)).toEqual(NO_TABLE_HOVER);

    view.destroy();
  });

  // Regression coverage: the reviewer found click and hover indistinguishable
  // — click used to dispatch the same effect as hover, so a click-selected
  // row lost its highlight the instant the pointer left the handle. Clicking
  // now pins tableSelectionField instead, which pointerleave never touches.
  it("dispatches this row's {table, row} to tableSelectionField on click, and pointerleave does not clear it", () => {
    const view = makeView("| A | B |\n| --- | --- |\n| 1 | 2 |\n");
    const widget = new RowHandleWidget(0, 1);
    const dom = widget.toDOM(view);

    dom.dispatchEvent(pointerLikeEvent("click"));
    expect(view.state.field(tableSelectionField)).toEqual({ table: 0, row: 1, col: null });

    dom.dispatchEvent(pointerLikeEvent("pointerleave"));
    expect(view.state.field(tableSelectionField)).toEqual({ table: 0, row: 1, col: null });
    expect(view.state.field(tableHoverField)).toEqual(NO_TABLE_HOVER);

    view.destroy();
  });

  it("renders the six-dot handle glyph", () => {
    const view = makeView("| A |\n| --- |\n| 1 |\n");
    const dom = new RowHandleWidget(0, 0).toDOM(view);
    expect(dom.querySelectorAll(".cm-table-handle-dot")).toHaveLength(6);
    view.destroy();
  });

  // Must-fix regression: a right-click (opening the context menu) used to
  // only preventDefault() without pinning tableSelectionField at all, so an
  // earlier pin elsewhere in the table (or a different table) silently
  // survived — the menu would resolve to the right-clicked row while a
  // stale row stayed visually highlighted, and Delete Row (say) would then
  // act on the menu's row while the wrong one looked selected.
  it("pins this row into tableSelectionField on contextmenu, replacing an earlier pin elsewhere", () => {
    const view = makeView("| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n");
    view.dispatch({ effects: setTableSelection.of({ table: 0, row: 0, col: null }) });

    const dom = new RowHandleWidget(0, 2).toDOM(view);
    dom.dispatchEvent(pointerLikeEvent("contextmenu"));

    expect(view.state.field(tableSelectionField)).toEqual({ table: 0, row: 2, col: null });
    view.destroy();
  });
});

describe("TableColumnBarWidget", () => {
  it("eq() compares table and column, not identity", () => {
    expect(new TableColumnBarWidget(0, 1).eq(new TableColumnBarWidget(0, 1))).toBe(true);
    expect(new TableColumnBarWidget(0, 1).eq(new TableColumnBarWidget(0, 2))).toBe(false);
  });

  it("dispatches this column's {table, col} to tableHoverField on pointerenter, and clears it on pointerleave", () => {
    const view = makeView("| A | B |\n| --- | --- |\n| 1 | 2 |\n");
    const widget = new TableColumnBarWidget(0, 1);
    const dom = widget.toDOM(view);

    dom.dispatchEvent(pointerLikeEvent("pointerenter"));
    expect(view.state.field(tableHoverField)).toEqual({ table: 0, row: null, col: 1 });

    dom.dispatchEvent(pointerLikeEvent("pointerleave"));
    expect(view.state.field(tableHoverField)).toEqual(NO_TABLE_HOVER);

    view.destroy();
  });

  it("dispatches this column's {table, col} to tableSelectionField on click, and pointerleave does not clear it", () => {
    const view = makeView("| A | B |\n| --- | --- |\n| 1 | 2 |\n");
    const widget = new TableColumnBarWidget(0, 1);
    const dom = widget.toDOM(view);

    dom.dispatchEvent(pointerLikeEvent("click"));
    expect(view.state.field(tableSelectionField)).toEqual({ table: 0, row: null, col: 1 });

    dom.dispatchEvent(pointerLikeEvent("pointerleave"));
    expect(view.state.field(tableSelectionField)).toEqual({ table: 0, row: null, col: 1 });

    view.destroy();
  });

  // Must-fix regression: TableColumnBarWidget.toDOM previously never called
  // createHandleGlyph(), so the column bar rendered as an empty <span> with
  // no visible affordance at all.
  it("renders the six-dot handle glyph", () => {
    const view = makeView("| A |\n| --- |\n| 1 |\n");
    const dom = new TableColumnBarWidget(0, 0).toDOM(view);
    expect(dom.querySelectorAll(".cm-table-handle-dot")).toHaveLength(6);
    view.destroy();
  });
});

describe("clicking elsewhere / Escape clears a pinned selection", () => {
  it("a mousedown outside any handle clears tableSelectionField", () => {
    const view = makeView("| A | B |\n| --- | --- |\n| 1 | 2 |\n");
    view.dispatch({ effects: setTableSelection.of({ table: 0, row: 1, col: null }) });
    expect(view.state.field(tableSelectionField)).toEqual({ table: 0, row: 1, col: null });

    view.contentDOM.dispatchEvent(new Event("mousedown", { bubbles: true, cancelable: true }));
    expect(view.state.field(tableSelectionField)).toEqual(NO_TABLE_HOVER);

    view.destroy();
  });

  it("a mousedown on a handle itself does not clear the selection it's about to set", () => {
    const view = makeView("| A | B |\n| --- | --- |\n| 1 | 2 |\n");
    const handle = view.dom.querySelector<HTMLElement>(".cm-table-row-handle")!;
    handle.dispatchEvent(new Event("mousedown", { bubbles: true, cancelable: true }));
    // Clearing is skipped for a handle target; the handle's own click
    // listener (not exercised by mousedown alone here) is what actually sets
    // a fresh selection.
    expect(view.state.field(tableSelectionField)).toEqual(NO_TABLE_HOVER);
    view.destroy();
  });

  it("Escape clears a pinned selection", () => {
    const view = makeView("| A | B |\n| --- | --- |\n| 1 | 2 |\n");
    view.dispatch({ effects: setTableSelection.of({ table: 0, row: 1, col: null }) });
    expect(view.state.field(tableSelectionField)).toEqual({ table: 0, row: 1, col: null });

    view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(view.state.field(tableSelectionField)).toEqual(NO_TABLE_HOVER);

    view.destroy();
  });

  it("does nothing (no crash) when Escape is pressed with no pinned selection", () => {
    const view = makeView("| A | B |\n| --- | --- |\n| 1 | 2 |\n");
    expect(() =>
      view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })),
    ).not.toThrow();
    expect(view.state.field(tableSelectionField)).toEqual(NO_TABLE_HOVER);
    view.destroy();
  });
});

describe("measureTableGeometry / applyTableGeometry", () => {
  function mockRect(el: HTMLElement, props: { left?: number; width?: number; top?: number; height?: number }): void {
    for (const [key, value] of Object.entries(props)) {
      const offsetKey = `offset${key[0].toUpperCase()}${key.slice(1)}`;
      Object.defineProperty(el, offsetKey, { value, configurable: true });
    }
  }

  // The whole point of DOM measurement (over the abandoned decoration-anchor
  // approach) is that it doesn't care what's inside a header cell — an
  // empty cell's placeholder and a single-character cell are both just
  // ordinary elements to measure. This exercises exactly that: one
  // zero-width (empty-cell placeholder) column and one narrow
  // (single-character) column, matched purely by DOM position. Also covers
  // the row-handle geometry fix: each row line's own offsetTop/offsetHeight
  // is measured and written onto the matching row handle, rather than the
  // handle relying on a CSS `height: 100%` (which resolves against the
  // whole box, not the row).
  it("reads each header cell's/row's real geometry and writes it onto the matching column bar/row handle, by position", () => {
    // Plain text, deliberately no real table — this test builds its own
    // mock .cm-table-box by hand, and a real table rendered by
    // markdownExtensions would add a second one, breaking the `toHaveLength(1)`
    // assertion below.
    const view = makeView("plain text, no table\n");
    const box = document.createElement("div");
    box.className = "cm-table-box";

    const emptyCell = document.createElement("span");
    emptyCell.className = "cm-table-header-cell";
    mockRect(emptyCell, { left: 0, width: 0 });
    const narrowCell = document.createElement("span");
    narrowCell.className = "cm-table-header-cell";
    mockRect(narrowCell, { left: 0, width: 12 });
    const wideCell = document.createElement("span");
    wideCell.className = "cm-table-header-cell";
    mockRect(wideCell, { left: 12, width: 80 });
    box.append(emptyCell, narrowCell, wideCell);

    const barEmpty = document.createElement("span");
    barEmpty.className = "cm-table-col-bar";
    const barNarrow = document.createElement("span");
    barNarrow.className = "cm-table-col-bar";
    const barWide = document.createElement("span");
    barWide.className = "cm-table-col-bar";
    box.append(barEmpty, barNarrow, barWide);

    const headerRow = document.createElement("div");
    headerRow.className = "cm-table-row cm-table-header-row";
    mockRect(headerRow, { top: 0, height: 20 });
    const bodyRow = document.createElement("div");
    bodyRow.className = "cm-table-row";
    mockRect(bodyRow, { top: 20, height: 24 });
    box.append(headerRow, bodyRow);

    const headerHandle = document.createElement("span");
    headerHandle.className = "cm-table-row-handle";
    const bodyHandle = document.createElement("span");
    bodyHandle.className = "cm-table-row-handle";
    box.append(headerHandle, bodyHandle);

    view.dom.appendChild(box);

    const measurements = measureTableGeometry(view);
    expect(measurements).toHaveLength(1);
    expect(measurements[0].cellRects).toEqual([
      { left: 0, width: 0 },
      { left: 0, width: 12 },
      { left: 12, width: 80 },
    ]);
    expect(measurements[0].rowRects).toEqual([
      { top: 0, height: 20 },
      { top: 20, height: 24 },
    ]);

    applyTableGeometry(measurements);
    expect(barEmpty.style.left).toBe("0px");
    expect(barEmpty.style.width).toBe("0px");
    expect(barNarrow.style.left).toBe("0px");
    expect(barNarrow.style.width).toBe("12px");
    expect(barWide.style.left).toBe("12px");
    expect(barWide.style.width).toBe("80px");
    expect(headerHandle.style.top).toBe("0px");
    expect(headerHandle.style.height).toBe("20px");
    expect(bodyHandle.style.top).toBe("20px");
    expect(bodyHandle.style.height).toBe("24px");

    view.destroy();
  });

  it("measures every .cm-table-box independently, when two are present", () => {
    const view = makeView("hello\n");
    const boxA = document.createElement("div");
    boxA.className = "cm-table-box";
    const cellA = document.createElement("span");
    cellA.className = "cm-table-header-cell";
    mockRect(cellA, { left: 5, width: 50 });
    boxA.appendChild(cellA);

    const boxB = document.createElement("div");
    boxB.className = "cm-table-box";
    const cellB = document.createElement("span");
    cellB.className = "cm-table-header-cell";
    mockRect(cellB, { left: 9, width: 90 });
    boxB.appendChild(cellB);

    view.dom.append(boxA, boxB);

    const measurements = measureTableGeometry(view);
    expect(measurements).toHaveLength(2);
    expect(measurements[0].cellRects).toEqual([{ left: 5, width: 50 }]);
    expect(measurements[1].cellRects).toEqual([{ left: 9, width: 90 }]);

    view.destroy();
  });
});

// Regression coverage for round 1's must-fix 3: a selection-only transaction
// (e.g. the cursor moving into a header cell, revealing its raw markdown and
// changing its rendered width) must still trigger a re-measure, even though
// it trips none of docChanged/geometryChanged/viewportChanged.
describe("tableGeometryMeasurePlugin schedules a measure on selectionSet/focusChanged", () => {
  it("calls view.requestMeasure again on a selection-only dispatch", () => {
    const view = makeView("| A | B |\n| --- | --- |\n| **Name** | 2 |\n");
    const spy = vi.spyOn(view, "requestMeasure");
    spy.mockClear(); // drop the initial-mount call so only this dispatch's call counts

    view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf("Name") } });

    expect(spy).toHaveBeenCalled();
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

// Round 2 must-fix: buildTableWrapRanges anchored the wrapper at the Table
// node's own `from`, which lands mid-line (right after the "> "/list marker)
// for a nested table. A BlockWrapper only wraps a line that *starts* inside
// its range, so that mid-line `from` excluded the header row's entire
// physical line from the wrapper — not just the marker — leaving every
// phase-2 widget anchored there (row handle, column bars, add-bands)
// rendered outside .cm-table-box, where their negative left/top offsets
// resolve against the wrong ancestor and land off-screen.
describe("nested tables get their header cells and phase-2 widgets inside .cm-table-box", () => {
  it("a table nested inside a blockquote", () => {
    const view = makeView("> | A | B |\n> | --- | --- |\n> | 1 | 2 |\n");
    const box = view.dom.querySelector(".cm-table-box");
    expect(box).toBeTruthy();
    expect(box!.querySelectorAll(".cm-table-header-cell")).toHaveLength(2);
    expect(box!.querySelectorAll(".cm-table-col-bar")).toHaveLength(2);
    expect(box!.querySelectorAll(".cm-table-row-handle")).toHaveLength(2);
    expect(box!.querySelectorAll(".cm-table-add-row-band")).toHaveLength(1);
    expect(box!.querySelectorAll(".cm-table-add-col-band")).toHaveLength(1);
    view.destroy();
  });

  it("a table nested inside a list item", () => {
    const view = makeView("- item\n\n  | A | B |\n  | --- | --- |\n  | 1 | 2 |\n");
    const box = view.dom.querySelector(".cm-table-box");
    expect(box).toBeTruthy();
    expect(box!.querySelectorAll(".cm-table-header-cell")).toHaveLength(2);
    expect(box!.querySelectorAll(".cm-table-col-bar")).toHaveLength(2);
    expect(box!.querySelectorAll(".cm-table-row-handle")).toHaveLength(2);
    view.destroy();
  });
});

// Issue #295: `.cm-table-scroll` (rank 60) nests as the `.cm-table-box`
// (rank 50) wrapper's own outer ancestor now, carrying the `overflow-x:
// auto` a `display: table` box can't take itself, with padding matching
// each overlay widget's own outward offset so none of them gets clipped by
// the new scroll container's padding box. jsdom has no layout engine (see
// "drag-to-reposition" below), so this can only assert the DOM shape itself
// — that `.cm-table-box` really is `.cm-table-scroll`'s own direct child,
// and every overlay widget is still nested inside `.cm-table-box` the way
// `measureTableGeometry`'s `box.querySelectorAll(...)` calls (tableHandles.ts)
// depend on — not that the padding/offsets actually resolve to an unclipped
// pixel rect, which needs a real browser (see the plan's manual-verification
// steps).
describe("the .cm-table-scroll wrapper nests around .cm-table-box without excluding phase 2's overlay widgets (issue #295)", () => {
  it("wraps .cm-table-box as its own direct child, with every handle/bar/band still nested inside .cm-table-box", () => {
    const view = makeView("| A | B |\n| --- | --- |\n| 1 | 2 |\n");

    const scroll = view.dom.querySelector(".cm-table-scroll");
    expect(scroll).toBeTruthy();
    expect(scroll!.classList.contains("cm-table-scroll")).toBe(true);

    const box = scroll!.querySelector(":scope > .cm-table-box");
    expect(box).toBeTruthy();

    expect(box!.querySelectorAll(".cm-table-row-handle")).toHaveLength(2);
    expect(box!.querySelectorAll(".cm-table-col-bar")).toHaveLength(2);
    expect(box!.querySelectorAll(".cm-table-add-row-band")).toHaveLength(1);
    expect(box!.querySelectorAll(".cm-table-add-col-band")).toHaveLength(1);

    view.destroy();
  });
});

describe("drag-to-reposition (phase 4)", () => {
  // jsdom has no layout engine, so every element's getBoundingClientRect()
  // is zero by default; mocking it directly on the real handle elements is
  // this suite's version of the same technique EditorPaneTableContextMenu's
  // posAtCoords stub and EditorPaneSplit.test.ts's pointerLikeEvent already
  // use elsewhere in this codebase for the same jsdom gap. The mocked
  // elements are reused (not recreated) across a moveRow/moveColumn dispatch
  // — RowHandleWidget/TableColumnBarWidget's own eq() only compares
  // table+row/column *slot* identity, not content, so CodeMirror keeps the
  // same DOM node for "row 2" (say) even though the swap changes what
  // content now sits there — meaning the mocks set up before the drag stay
  // valid for its whole duration.
  function mockRect(el: Element, start: number, end: number): void {
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
      top: start,
      bottom: end,
      left: start,
      right: end,
      width: end - start,
      height: end - start,
      x: start,
      y: start,
      toJSON: () => ({}),
    } as DOMRect);
  }

  /** The table identity `attachHandleInteractions` stamps onto every handle's own `data-table-handle-table`. */
  function tableOf(handle: HTMLElement): number {
    return Number(handle.dataset.tableHandleTable);
  }

  function pointerCoordEvent(type: string, coord: "clientX" | "clientY", value: number): Event {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "button", { value: 0, configurable: true });
    Object.defineProperty(event, coord, { value, configurable: true });
    Object.defineProperty(event, coord === "clientY" ? "clientX" : "clientY", { value: 0, configurable: true });
    return event;
  }

  it("dragging a row handle down two positions composes two moveRow steps", () => {
    const doc =
      "| Name  | Role     |\n| ----- | -------- |\n| Alice | Engineer |\n| Bob   | Designer |\n| Carol | Manager  |\n";
    const view = makeView(doc);
    const handles = view.dom.querySelectorAll<HTMLElement>(".cm-table-row-handle");
    expect(handles).toHaveLength(4); // header, Alice, Bob, Carol
    mockRect(handles[0], 0, 20);
    mockRect(handles[1], 20, 40); // Alice
    mockRect(handles[2], 40, 60); // Bob
    mockRect(handles[3], 60, 80); // Carol

    handles[1].dispatchEvent(pointerCoordEvent("pointerdown", "clientY", 30));
    window.dispatchEvent(pointerCoordEvent("pointermove", "clientY", 75)); // past Bob's and Carol's own centers
    window.dispatchEvent(pointerCoordEvent("pointerup", "clientY", 75));

    expect(view.state.doc.toString()).toBe(
      "| Name  | Role     |\n| ----- | -------- |\n| Bob   | Designer |\n| Carol | Manager  |\n| Alice | Engineer |\n",
    );
    view.destroy();
  });

  it("dragging a row handle up one position composes one moveRow step", () => {
    const doc =
      "| Name  | Role     |\n| ----- | -------- |\n| Alice | Engineer |\n| Bob   | Designer |\n| Carol | Manager  |\n";
    const view = makeView(doc);
    const handles = view.dom.querySelectorAll<HTMLElement>(".cm-table-row-handle");
    mockRect(handles[0], 0, 20);
    mockRect(handles[1], 20, 40); // Alice
    mockRect(handles[2], 40, 60); // Bob
    mockRect(handles[3], 60, 80); // Carol

    handles[2].dispatchEvent(pointerCoordEvent("pointerdown", "clientY", 50)); // Bob
    window.dispatchEvent(pointerCoordEvent("pointermove", "clientY", 25)); // past Alice's own center
    window.dispatchEvent(pointerCoordEvent("pointerup", "clientY", 25));

    expect(view.state.doc.toString()).toBe(
      "| Name  | Role     |\n| ----- | -------- |\n| Bob   | Designer |\n| Alice | Engineer |\n| Carol | Manager  |\n",
    );
    view.destroy();
  });

  it("stops at the table's own top edge without throwing (never drags past the header)", () => {
    const doc = "| Name  | Role     |\n| ----- | -------- |\n| Alice | Engineer |\n| Bob   | Designer |\n";
    const view = makeView(doc);
    const handles = view.dom.querySelectorAll<HTMLElement>(".cm-table-row-handle");
    mockRect(handles[0], 0, 20); // header
    mockRect(handles[1], 20, 40); // Alice
    mockRect(handles[2], 40, 60); // Bob

    handles[1].dispatchEvent(pointerCoordEvent("pointerdown", "clientY", 30));
    expect(() => {
      window.dispatchEvent(pointerCoordEvent("pointermove", "clientY", -100)); // far past the header
    }).not.toThrow();
    window.dispatchEvent(pointerCoordEvent("pointerup", "clientY", -100));

    // Alice never moved above the header — moveRow(..., "up") returns null
    // once the only row left "above" is the header itself.
    expect(view.state.doc.toString()).toBe(doc);
    view.destroy();
  });

  it("dragging a column bar right one position composes one moveColumn step", () => {
    const doc = "| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n";
    const view = makeView(doc);
    const bars = view.dom.querySelectorAll<HTMLElement>(".cm-table-col-bar");
    expect(bars).toHaveLength(3);
    mockRect(bars[0], 0, 20); // A
    mockRect(bars[1], 20, 40); // B
    mockRect(bars[2], 40, 60); // C

    bars[0].dispatchEvent(pointerCoordEvent("pointerdown", "clientX", 10));
    window.dispatchEvent(pointerCoordEvent("pointermove", "clientX", 35)); // past B's own center
    window.dispatchEvent(pointerCoordEvent("pointerup", "clientX", 35));

    expect(view.state.doc.toString()).toBe("| B | A | C |\n| --- | --- | --- |\n| 2 | 1 | 3 |\n");
    view.destroy();
  });

  it("stops at the table's own right edge without throwing (never drags past the last column)", () => {
    const doc = "| A | B |\n| --- | --- |\n| 1 | 2 |\n";
    const view = makeView(doc);
    const bars = view.dom.querySelectorAll<HTMLElement>(".cm-table-col-bar");
    mockRect(bars[0], 0, 20);
    mockRect(bars[1], 20, 40);

    bars[1].dispatchEvent(pointerCoordEvent("pointerdown", "clientX", 30));
    expect(() => {
      window.dispatchEvent(pointerCoordEvent("pointermove", "clientX", 1000)); // far past the last column
    }).not.toThrow();
    window.dispatchEvent(pointerCoordEvent("pointerup", "clientX", 1000));

    expect(view.state.doc.toString()).toBe(doc);
    view.destroy();
  });

  it("removes its window listeners on pointerup (no further moves after the gesture ends)", () => {
    const doc =
      "| Name  | Role     |\n| ----- | -------- |\n| Alice | Engineer |\n| Bob   | Designer |\n| Carol | Manager  |\n";
    const view = makeView(doc);
    const handles = view.dom.querySelectorAll<HTMLElement>(".cm-table-row-handle");
    mockRect(handles[0], 0, 20);
    mockRect(handles[1], 20, 40);
    mockRect(handles[2], 40, 60);
    mockRect(handles[3], 60, 80);

    handles[1].dispatchEvent(pointerCoordEvent("pointerdown", "clientY", 30));
    window.dispatchEvent(pointerCoordEvent("pointermove", "clientY", 50));
    window.dispatchEvent(pointerCoordEvent("pointerup", "clientY", 50));
    const afterFirstDrag = view.state.doc.toString();

    // A pointermove after pointerup must be a no-op — the listeners were
    // removed, not just the drag "finished" logically.
    window.dispatchEvent(pointerCoordEvent("pointermove", "clientY", 75));
    expect(view.state.doc.toString()).toBe(afterFirstDrag);
    view.destroy();
  });

  // Must-fix regression: on a table taller than the rendered viewport,
  // CodeMirror only builds .cm-table-row-handle elements for rows in its
  // current viewport (confirmed here: after scrolling, the rendered set is
  // row 0 plus a contiguous run around row 165-166, not every row 0-400) —
  // so a neighbour must be looked up by its own stamped row index, never by
  // its position in that (non-contiguous, viewport-scoped) rendered list.
  // Indexing positionally there either finds nothing (a false no-op) or,
  // worse, resolves to whatever row happens to sit at that position in the
  // rendered array — silently swapping the wrong pair.
  it("drags the correct adjacent row even when only a scrolled-to subset of a large table is rendered", () => {
    let doc = "| Name | Role |\n| --- | --- |\n";
    for (let i = 0; i < 400; i++) {
      doc += `| Row${i} | Val${i} |\n`;
    }
    const view = makeView(doc);
    const targetLine = view.state.doc.line(202);
    view.dispatch({ effects: EditorView.scrollIntoView(targetLine.from, { y: "center" }) });

    const handlesByRow = new Map<number, HTMLElement>();
    for (const h of Array.from(view.dom.querySelectorAll<HTMLElement>(".cm-table-row-handle"))) {
      const idx = Number(h.dataset.tableHandleRow);
      if (Number.isFinite(idx)) {
        handlesByRow.set(idx, h);
      }
    }
    // Confirms the premise: a large, mostly-off-viewport gap exists between
    // the header (row 0) and the scrolled-to region, and rows 165/166 (the
    // pair this test drags) are both actually rendered.
    expect(handlesByRow.has(5)).toBe(false);
    expect(handlesByRow.has(165)).toBe(true);
    expect(handlesByRow.has(166)).toBe(true);

    let y = 0;
    for (const idx of [...handlesByRow.keys()].sort((a, b) => a - b)) {
      mockRect(handlesByRow.get(idx)!, y, y + 20);
      y += 20;
    }

    const handle165 = handlesByRow.get(165)!;
    const rect166 = handlesByRow.get(166)!.getBoundingClientRect();

    handle165.dispatchEvent(pointerCoordEvent("pointerdown", "clientY", 10));
    window.dispatchEvent(pointerCoordEvent("pointermove", "clientY", rect166.bottom - 1));
    window.dispatchEvent(pointerCoordEvent("pointerup", "clientY", rect166.bottom - 1));

    // Row index 165 is document line 167 ("Row164"); row index 166 is line
    // 168 ("Row165") — header (line 1) + delimiter (line 2) + rowIndex - 1.
    expect(view.state.doc.line(167).text).toBe("| Row165 | Val165 |");
    expect(view.state.doc.line(168).text).toBe("| Row164 | Val164 |");
    // Nothing outside the swapped pair moved.
    expect(view.state.doc.line(166).text).toBe("| Row163 | Val163 |");
    expect(view.state.doc.line(169).text).toBe("| Row166 | Val166 |");
    expect(view.state.doc.line(10).text).toBe("| Row7 | Val7 |");

    view.destroy();
  });

  it("sets tableDragField on pointerdown, updates it in the same step as each move, and clears it on pointerup", () => {
    const doc =
      "| Name  | Role     |\n| ----- | -------- |\n| Alice | Engineer |\n| Bob   | Designer |\n| Carol | Manager  |\n";
    const view = makeView(doc);
    const handles = view.dom.querySelectorAll<HTMLElement>(".cm-table-row-handle");
    const table = tableOf(handles[1]);
    mockRect(handles[0], 0, 20);
    mockRect(handles[1], 20, 40); // Alice
    mockRect(handles[2], 40, 60); // Bob
    mockRect(handles[3], 60, 80); // Carol

    handles[1].dispatchEvent(pointerCoordEvent("pointerdown", "clientY", 30));
    expect(view.state.field(tableDragField)).toEqual({ table, row: 1, col: null });
    expect(document.body.classList.contains("cm-table-dragging-active")).toBe(true);

    window.dispatchEvent(pointerCoordEvent("pointermove", "clientY", 55)); // past Bob's own center: one step
    // The field already reflects the row's new position — not a stale value
    // waiting on a follow-up dispatch, since the plan requires the move and
    // the drag-target update to land in the same transaction.
    expect(view.state.field(tableDragField)).toEqual({ table, row: 2, col: null });

    window.dispatchEvent(pointerCoordEvent("pointerup", "clientY", 55));
    expect(view.state.field(tableDragField)).toEqual(NO_TABLE_HOVER);
    expect(document.body.classList.contains("cm-table-dragging-active")).toBe(false);

    view.destroy();
  });

  it("sets tableDragField for a column drag, keyed on col with row null", () => {
    const doc = "| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n";
    const view = makeView(doc);
    const bars = view.dom.querySelectorAll<HTMLElement>(".cm-table-col-bar");
    const table = tableOf(bars[0]);
    mockRect(bars[0], 0, 20);
    mockRect(bars[1], 20, 40);
    mockRect(bars[2], 40, 60);

    bars[0].dispatchEvent(pointerCoordEvent("pointerdown", "clientX", 10));
    expect(view.state.field(tableDragField)).toEqual({ table, row: null, col: 0 });

    window.dispatchEvent(pointerCoordEvent("pointerup", "clientX", 10));
    expect(view.state.field(tableDragField)).toEqual(NO_TABLE_HOVER);

    view.destroy();
  });

  // A real browser event (an OS/browser-level gesture interruption, e.g. a
  // touch scroll taking over) — must clear the field and the body's
  // dragging cursor class exactly like a normal pointerup, since a stale
  // `cm-table-dragging-active` forces `cursor: grabbing` app-wide with
  // nothing left to clear it.
  it("clears tableDragField and the dragging-active body class on pointercancel", () => {
    const doc =
      "| Name  | Role     |\n| ----- | -------- |\n| Alice | Engineer |\n| Bob   | Designer |\n";
    const view = makeView(doc);
    const handles = view.dom.querySelectorAll<HTMLElement>(".cm-table-row-handle");
    const table = tableOf(handles[1]);
    mockRect(handles[0], 0, 20);
    mockRect(handles[1], 20, 40);
    mockRect(handles[2], 40, 60);

    handles[1].dispatchEvent(pointerCoordEvent("pointerdown", "clientY", 30));
    expect(view.state.field(tableDragField)).toEqual({ table, row: 1, col: null });
    expect(document.body.classList.contains("cm-table-dragging-active")).toBe(true);

    window.dispatchEvent(pointerLikeEvent("pointercancel"));
    expect(view.state.field(tableDragField)).toEqual(NO_TABLE_HOVER);
    expect(document.body.classList.contains("cm-table-dragging-active")).toBe(false);

    // A pointermove after the cancel must be a no-op — the listeners were
    // removed, not just the drag "finished" logically.
    window.dispatchEvent(pointerCoordEvent("pointermove", "clientY", 50));
    expect(view.state.doc.toString()).toBe(doc);

    view.destroy();
  });

  // A window blur mid-drag (switching apps/tabs) has no pointerup/pointercancel
  // of its own — without its own exit path, `cm-table-dragging-active`'s
  // app-wide `grabbing` cursor would stay stuck until some unrelated later
  // pointerup happened to fire.
  it("clears tableDragField and the dragging-active body class on a window blur mid-drag", () => {
    const doc = "| Name  | Role     |\n| ----- | -------- |\n| Alice | Engineer |\n";
    const view = makeView(doc);
    const handles = view.dom.querySelectorAll<HTMLElement>(".cm-table-row-handle");
    const table = tableOf(handles[1]);
    mockRect(handles[0], 0, 20);
    mockRect(handles[1], 20, 40);

    handles[1].dispatchEvent(pointerCoordEvent("pointerdown", "clientY", 30));
    expect(view.state.field(tableDragField)).toEqual({ table, row: 1, col: null });
    expect(document.body.classList.contains("cm-table-dragging-active")).toBe(true);

    window.dispatchEvent(pointerLikeEvent("blur"));
    expect(view.state.field(tableDragField)).toEqual(NO_TABLE_HOVER);
    expect(document.body.classList.contains("cm-table-dragging-active")).toBe(false);

    view.destroy();
  });
});

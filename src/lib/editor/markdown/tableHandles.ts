import { StateEffect, StateField } from "@codemirror/state";
import type { EditorState, Transaction } from "@codemirror/state";
import { EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import type { ViewUpdate } from "@codemirror/view";
import { findTableContext, insertColumn, insertRow } from "./tableEdit";
import type { TableEditContext } from "./tableEdit";
import { tooltip } from "../../ui/tooltip";

/**
 * Hover/click-selection state for a table's row/column handles. Keyed on
 * the enclosing `Table` syntax node's own `from` position, not just
 * `row`/`col` — those indices are only meaningful within one table, so a
 * document with two or more tables needs the `table` key to keep hovering
 * one table's row 1 from also lighting up every other table's row 1 (round
 * 3 must-fix 2).
 */
export interface TableHoverState {
  table: number | null;
  row: number | null;
  col: number | null;
}

export const NO_TABLE_HOVER: TableHoverState = { table: null, row: null, col: null };

export const setTableHover = StateEffect.define<TableHoverState>();

/**
 * A hover/selection highlight has no content worth preserving across a
 * document edit — unlike `mermaidWidgetField`'s `DecorationSet` (which maps
 * its ranges through `tr.changes` because a diagram's own identity should
 * survive an edit elsewhere), this field's `table` key is just a position
 * used to distinguish tables, with no independent meaning once the document
 * has changed. Clearing it on any `docChanged` (rather than remapping it
 * through `tr.changes.mapPos`) sidesteps having to reason about what a
 * mapped position means when the table itself was the thing edited or
 * deleted, and is what keeps a click-selected row's highlight from silently
 * surviving an edit above the table at the wrong position.
 */
export const tableHoverField = StateField.define<TableHoverState>({
  create: () => NO_TABLE_HOVER,
  update(value, tr: Transaction) {
    let next = value;
    let effectApplied = false;
    for (const effect of tr.effects) {
      if (effect.is(setTableHover)) {
        next = effect.value;
        effectApplied = true;
      }
    }
    if (tr.docChanged && !effectApplied) {
      return NO_TABLE_HOVER;
    }
    return next;
  },
});

/**
 * The six-dot (2x3) drag-handle glyph shared by row and column handles,
 * built from real elements (rather than a CSS `::before`/font glyph) so its
 * dot count/layout stays easy to read and adjust in `markdown.css`.
 */
function createHandleGlyph(): HTMLElement {
  const glyph = document.createElement("span");
  glyph.className = "cm-table-handle-dots";
  for (let i = 0; i < 6; i++) {
    const dot = document.createElement("span");
    dot.className = "cm-table-handle-dot";
    glyph.appendChild(dot);
  }
  return glyph;
}

/**
 * A widget at a table row's own physical-line-start position (the same
 * anchor `decorateTableRow`'s leading `tableGap` already uses, so a nested
 * table's blockquote/list-marker handling doesn't need a second special
 * case), styled `position: absolute; left: -Npx` with no explicit `top` so
 * CSS's static-position fallback places it at the row's own vertical band
 * for free. Hovering or clicking dispatches this row's `{table, row}` into
 * `tableHoverField`, which `decorateTableRow`/`decorateTable` read back to
 * apply the row-selected outline class to every cell in the row.
 */
export class RowHandleWidget extends WidgetType {
  constructor(
    readonly table: number,
    readonly row: number,
  ) {
    super();
  }

  eq(other: RowHandleWidget): boolean {
    return this.table === other.table && this.row === other.row;
  }

  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-table-row-handle";
    el.appendChild(createHandleGlyph());
    const hover = (): void => {
      view.dispatch({ effects: setTableHover.of({ table: this.table, row: this.row, col: null }) });
    };
    el.addEventListener("pointerenter", hover);
    el.addEventListener("click", (event) => {
      event.preventDefault();
      hover();
    });
    el.addEventListener("pointerleave", () => {
      view.dispatch({ effects: setTableHover.of(NO_TABLE_HOVER) });
    });
    return el;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/**
 * One per column, anchored at the header row's own line start alongside the
 * row handles — never positioned relative to a cell's own document range
 * (see the plan's "Phase 2" design for why an interior-text anchor can't
 * reliably target an empty or single-character header cell). Rendered with
 * no `left`/`width` of its own; `tableColumnBarMeasurePlugin` measures the
 * real, already-rendered header cells and writes those inline styles in a
 * DOM read/write pass, since CodeMirror only allows the DOM to be written to
 * (and never read for layout) inside `ViewPlugin.update()` itself.
 */
export class TableColumnBarWidget extends WidgetType {
  constructor(
    readonly table: number,
    readonly column: number,
  ) {
    super();
  }

  eq(other: TableColumnBarWidget): boolean {
    return this.table === other.table && this.column === other.column;
  }

  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-table-col-bar";
    const hover = (): void => {
      view.dispatch({ effects: setTableHover.of({ table: this.table, row: null, col: this.column }) });
    };
    el.addEventListener("pointerenter", hover);
    el.addEventListener("click", (event) => {
      event.preventDefault();
      hover();
    });
    el.addEventListener("pointerleave", () => {
      view.dispatch({ effects: setTableHover.of(NO_TABLE_HOVER) });
    });
    return el;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/**
 * Re-resolves the `TableEditContext` for a table's own *last* row, given
 * only the table's identity (`tableFrom`) — used by the add-row band, which
 * has no cell position of its own to resolve from. Always re-resolved
 * fresh against the current `state` (never cached) so a prior edit's line
 * shift can't leave it pointing at a stale row.
 */
function lastRowContext(state: EditorState, tableFrom: number): TableEditContext | null {
  const ctx = findTableContext(state, tableFrom);
  if (!ctx) {
    return null;
  }
  const lastRow = ctx.rows[ctx.rows.length - 1];
  return findTableContext(state, lastRow.from);
}

/**
 * Re-resolves the `TableEditContext` for a table's own *last* column, by
 * resolving from the very end of the header row — `findTableContext`'s
 * column resolution falls back to the last column for a position past every
 * cell's own range, which a header row's own end position always is.
 */
function rightmostColumnContext(state: EditorState, tableFrom: number): TableEditContext | null {
  const ctx = findTableContext(state, tableFrom);
  if (!ctx) {
    return null;
  }
  const headerRow = ctx.rows[0];
  return findTableContext(state, headerRow.to);
}

/**
 * The bottom-edge "+" band (screenshot 4): a full-width strip just outside
 * `.cm-table-box`'s own bottom border. Clicking always appends a new row
 * after the table's current last row, re-resolving that row fresh from
 * `view.state` at click time rather than trusting anything computed when
 * the widget was built.
 */
export class AddRowBandWidget extends WidgetType {
  private tooltipHandle: ReturnType<typeof tooltip> | undefined;

  constructor(readonly table: number) {
    super();
  }

  eq(other: AddRowBandWidget): boolean {
    return this.table === other.table;
  }

  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-table-add-row-band";
    this.tooltipHandle = tooltip(el, { label: "Add row below" });
    el.addEventListener("click", (event) => {
      event.preventDefault();
      const ctx = lastRowContext(view.state, this.table);
      if (!ctx) {
        return;
      }
      const spec = insertRow(view.state, ctx, "below");
      if (spec) {
        view.dispatch(spec);
      }
    });
    return el;
  }

  destroy(): void {
    this.tooltipHandle?.destroy?.();
    this.tooltipHandle = undefined;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/**
 * The right-edge "+" band (screenshot 5), mirroring `AddRowBandWidget` for
 * columns: always appends a new column after the table's current last
 * column, re-resolved fresh at click time.
 */
export class AddColumnBandWidget extends WidgetType {
  private tooltipHandle: ReturnType<typeof tooltip> | undefined;

  constructor(readonly table: number) {
    super();
  }

  eq(other: AddColumnBandWidget): boolean {
    return this.table === other.table;
  }

  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-table-add-col-band";
    this.tooltipHandle = tooltip(el, { label: "Add column to the right" });
    el.addEventListener("click", (event) => {
      event.preventDefault();
      const ctx = rightmostColumnContext(view.state, this.table);
      if (!ctx) {
        return;
      }
      const spec = insertColumn(view.state, ctx, "right");
      if (spec) {
        view.dispatch(spec);
      }
    });
    return el;
  }

  destroy(): void {
    this.tooltipHandle?.destroy?.();
    this.tooltipHandle = undefined;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

export interface ColumnBarMeasurement {
  box: HTMLElement;
  cellRects: { left: number; width: number }[];
}

const columnBarMeasureKey = Symbol("table-column-bar-measure");

/**
 * DOM *read* phase: for every rendered `.cm-table-box`, measures each of its
 * header cells' `offsetLeft`/`offsetWidth` relative to the box itself (the
 * positioned ancestor every table overlay anchors to). Ordinary,
 * well-specified DOM geometry — no CSS-table-internals ambiguity — which is
 * exactly why the column bar uses this instead of a decoration-position
 * anchor (see the plan's "Phase 2" design). Must not run inside
 * `ViewPlugin.update()` itself, which runs before the view writes its own
 * DOM — only `requestMeasure`'s own `read` callback is guaranteed to see a
 * freshly-painted layout.
 */
export function measureColumnBars(view: EditorView): ColumnBarMeasurement[] {
  const boxes = view.dom.querySelectorAll<HTMLElement>(".cm-table-box");
  const out: ColumnBarMeasurement[] = [];
  boxes.forEach((box) => {
    const cells = Array.from(box.querySelectorAll<HTMLElement>(".cm-table-header-cell"));
    out.push({ box, cellRects: cells.map((cell) => ({ left: cell.offsetLeft, width: cell.offsetWidth })) });
  });
  return out;
}

/**
 * DOM *write* phase: applies `measureColumnBars`' measurements to each
 * box's own `.cm-table-col-bar` widgets, matched by position — both lists
 * are built in the same left-to-right column order (the header cells by
 * document order, the bars by the ascending `side` `decorateTable` gives
 * them — see its own doc comment), so index `i` in one always corresponds
 * to column `i` in the other.
 */
export function applyColumnBars(measurements: ColumnBarMeasurement[]): void {
  for (const { box, cellRects } of measurements) {
    const bars = Array.from(box.querySelectorAll<HTMLElement>(".cm-table-col-bar"));
    const count = Math.min(bars.length, cellRects.length);
    for (let i = 0; i < count; i++) {
      bars[i].style.left = `${cellRects[i].left}px`;
      bars[i].style.width = `${cellRects[i].width}px`;
    }
  }
}

/**
 * Re-measures and repositions every table's column bar whenever the
 * document, viewport, or on-screen geometry changes (`update.geometryChanged`
 * covers a pane resize or font/layout shift that leaves the document and
 * viewport themselves unchanged). Scheduling through `view.requestMeasure`
 * — rather than reading `offsetLeft`/`offsetWidth` directly inside
 * `update()` — is required, not just tidy: `PluginValue.update()`'s own
 * type comment states it runs *before* the view updates its own DOM and
 * should not read DOM layout, exactly the read `measureColumnBars` needs to
 * do against the just-rendered header cells.
 */
export const tableColumnBarMeasurePlugin = ViewPlugin.fromClass(
  class {
    constructor(view: EditorView) {
      this.scheduleMeasure(view);
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.geometryChanged || update.viewportChanged) {
        this.scheduleMeasure(update.view);
      }
    }

    scheduleMeasure(view: EditorView): void {
      view.requestMeasure({
        key: columnBarMeasureKey,
        read: measureColumnBars,
        write: applyColumnBars,
      });
    }
  },
);

import { StateEffect, StateField } from "@codemirror/state";
import type { EditorState, StateEffectType, Transaction } from "@codemirror/state";
import { EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import type { KeyBinding, ViewUpdate } from "@codemirror/view";
import { findTableContext, insertColumn, insertRow } from "./tableEdit";
import type { TableEditContext } from "./tableEdit";
import { tooltip } from "../../ui/tooltip";

/**
 * A table row/column target: either a transient hover (`tableHoverField`) or
 * a pinned click-selection (`tableSelectionField`) — same shape, two
 * separate fields (see each field's own doc comment for why they're kept
 * distinct rather than merged into one). Keyed on the enclosing `Table`
 * syntax node's own `from` position, not just `row`/`col` — those indices
 * are only meaningful within one table, so a document with two or more
 * tables needs the `table` key to keep hovering/selecting one table's row 1
 * from also lighting up every other table's row 1 (round 3 must-fix 2).
 */
export interface TableHoverState {
  table: number | null;
  row: number | null;
  col: number | null;
}

export const NO_TABLE_HOVER: TableHoverState = { table: null, row: null, col: null };

/**
 * Builds one `{effect, field}` pair sharing the reducer both `tableHoverField`
 * and `tableSelectionField` need: apply the latest matching effect, or clear
 * to `NO_TABLE_HOVER` on any `docChanged` that didn't itself carry a fresh
 * value for this same field. Neither a hover nor a pinned selection has
 * content worth preserving across a document edit — unlike
 * `mermaidWidgetField`'s `DecorationSet` (which maps its ranges through
 * `tr.changes` because a diagram's own identity should survive an edit
 * elsewhere), the `table` key here is just a position used to distinguish
 * tables, with no independent meaning once the document has changed.
 * Clearing on `docChanged` (rather than remapping through `tr.changes.mapPos`)
 * sidesteps reasoning about what a mapped position means when the table
 * itself was the thing edited or deleted.
 */
function defineTableTargetField(): { effect: StateEffectType<TableHoverState>; field: StateField<TableHoverState> } {
  const effect = StateEffect.define<TableHoverState>();
  const field = StateField.define<TableHoverState>({
    create: () => NO_TABLE_HOVER,
    update(value, tr: Transaction) {
      let next = value;
      let effectApplied = false;
      for (const tre of tr.effects) {
        if (tre.is(effect)) {
          next = tre.value;
          effectApplied = true;
        }
      }
      if (tr.docChanged && !effectApplied) {
        return NO_TABLE_HOVER;
      }
      return next;
    },
  });
  return { effect, field };
}

/** Transient hover — set on `pointerenter`, cleared on `pointerleave`. Never touched by a click. */
const hoverTarget = defineTableTargetField();
export const setTableHover = hoverTarget.effect;
export const tableHoverField = hoverTarget.field;

/**
 * Pinned click-selection — set on a handle click, and kept lit regardless of
 * where the pointer travels afterward (unlike `tableHoverField`), since
 * phase 3's context menu needs the clicked row/column to stay highlighted
 * while the pointer moves to the menu. Cleared by `clearTableSelectionOnClickElsewhere`
 * (a click outside any handle) or `tableSelectionKeymap`'s `Escape` binding,
 * in addition to the shared on-edit clearing every target field gets.
 */
const selectionTarget = defineTableTargetField();
export const setTableSelection = selectionTarget.effect;
export const tableSelectionField = selectionTarget.field;

/**
 * A click landing anywhere in the editor that isn't a row/column handle
 * clears the pinned selection — the "click elsewhere deselects" half of
 * making selection sticky. `mousedown` (not `click`) matches this
 * codebase's other document-level click handling (`linkClickHandler`), and
 * returning `false` always lets the event continue normally (placing the
 * cursor, etc.) — this handler only ever dispatches a side-effect, never
 * consumes the event.
 */
export const clearTableSelectionOnClickElsewhere = EditorView.domEventHandlers({
  mousedown(event, view) {
    const target = event.target as HTMLElement | null;
    if (target?.closest(".cm-table-row-handle, .cm-table-col-bar")) {
      return false;
    }
    if (view.state.field(tableSelectionField) !== NO_TABLE_HOVER) {
      view.dispatch({ effects: setTableSelection.of(NO_TABLE_HOVER) });
    }
    return false;
  },
});

/** `Escape` clears a pinned selection, falling through (returning `false`) whenever there isn't one. */
export const tableSelectionKeymap: readonly KeyBinding[] = [
  {
    key: "Escape",
    run(view) {
      if (view.state.field(tableSelectionField) === NO_TABLE_HOVER) {
        return false;
      }
      view.dispatch({ effects: setTableSelection.of(NO_TABLE_HOVER) });
      return true;
    },
  },
];

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
 * Wires the pointerenter/pointerleave/click trio every handle shares:
 * hovering sets (and leaving clears) `tableHoverField`; clicking pins
 * `target` into `tableSelectionField` instead, so it stays highlighted
 * regardless of where the pointer travels afterward (see
 * `tableSelectionField`'s own doc comment for why selection is kept
 * separate from — not merged into — hover).
 */
function attachHandleInteractions(el: HTMLElement, view: EditorView, target: TableHoverState): void {
  el.addEventListener("pointerenter", () => {
    view.dispatch({ effects: setTableHover.of(target) });
  });
  el.addEventListener("pointerleave", () => {
    view.dispatch({ effects: setTableHover.of(NO_TABLE_HOVER) });
  });
  el.addEventListener("click", (event) => {
    event.preventDefault();
    view.dispatch({ effects: setTableSelection.of(target) });
  });
}

/**
 * A widget at a table row's own physical-line-start position (the same
 * anchor `decorateTableRow`'s leading `tableGap` already uses, so a nested
 * table's blockquote/list-marker handling doesn't need a second special
 * case). `tableGeometryMeasurePlugin` writes this row's own measured `top`/
 * `height` onto the element (see that plugin's own doc comment for why a
 * plain CSS `height: 100%` resolves against the wrong ancestor). Hovering
 * sets `tableHoverField`; clicking pins the row into `tableSelectionField`;
 * `decorateTableRow`/`decorateTable` read both back to apply the
 * row-selected outline class to every cell in the row.
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
    attachHandleInteractions(el, view, { table: this.table, row: this.row, col: null });
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
 * no `left`/`width` of its own; `tableGeometryMeasurePlugin` measures the
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
    el.appendChild(createHandleGlyph());
    attachHandleInteractions(el, view, { table: this.table, row: null, col: this.column });
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

export interface TableGeometryMeasurement {
  box: HTMLElement;
  cellRects: { left: number; width: number }[];
  rowRects: { top: number; height: number }[];
}

const tableGeometryMeasureKey = Symbol("table-geometry-measure");

/**
 * DOM *read* phase: for every rendered `.cm-table-box`, measures each of its
 * header cells' `offsetLeft`/`offsetWidth` (for the column bars) and each of
 * its row lines' `offsetTop`/`offsetHeight` (for the row handles), both
 * relative to the box itself (the positioned ancestor every table overlay
 * anchors to). Ordinary, well-specified DOM geometry — no
 * CSS-table-internals ambiguity — which is exactly why the column bar uses
 * this instead of a decoration-position anchor (see the plan's "Phase 2"
 * design), and why the row handle's own vertical band is measured the same
 * way rather than trusted to a `height: 100%` + static-position `top` CSS
 * trick: that trick's `100%` resolves against `.cm-table-box`'s *total*
 * height (the nearest positioned ancestor for a percentage height), not the
 * row's own height, so every handle past the first ends up both
 * oversized and mispositioned. Must not run inside `ViewPlugin.update()`
 * itself, which runs before the view writes its own DOM — only
 * `requestMeasure`'s own `read` callback is guaranteed to see a
 * freshly-painted layout.
 */
export function measureTableGeometry(view: EditorView): TableGeometryMeasurement[] {
  const boxes = view.dom.querySelectorAll<HTMLElement>(".cm-table-box");
  const out: TableGeometryMeasurement[] = [];
  boxes.forEach((box) => {
    const cells = Array.from(box.querySelectorAll<HTMLElement>(".cm-table-header-cell"));
    const rows = Array.from(box.querySelectorAll<HTMLElement>(".cm-table-row"));
    out.push({
      box,
      cellRects: cells.map((cell) => ({ left: cell.offsetLeft, width: cell.offsetWidth })),
      rowRects: rows.map((row) => ({ top: row.offsetTop, height: row.offsetHeight })),
    });
  });
  return out;
}

/**
 * DOM *write* phase: applies `measureTableGeometry`'s measurements to each
 * box's own `.cm-table-col-bar`/`.cm-table-row-handle` widgets, each matched
 * by position — the header cells and the column bars are both built in the
 * same left-to-right column order (the cells by document order, the bars by
 * the ascending `side` `decorateTable` gives them — see its own doc
 * comment), and the row lines and the row handles are both built in the
 * same top-to-bottom row order (one of each per row, in document order), so
 * index `i` always corresponds to the same column/row in both lists of a
 * pair.
 */
export function applyTableGeometry(measurements: TableGeometryMeasurement[]): void {
  for (const { box, cellRects, rowRects } of measurements) {
    const bars = Array.from(box.querySelectorAll<HTMLElement>(".cm-table-col-bar"));
    const barCount = Math.min(bars.length, cellRects.length);
    for (let i = 0; i < barCount; i++) {
      bars[i].style.left = `${cellRects[i].left}px`;
      bars[i].style.width = `${cellRects[i].width}px`;
    }

    const handles = Array.from(box.querySelectorAll<HTMLElement>(".cm-table-row-handle"));
    const handleCount = Math.min(handles.length, rowRects.length);
    for (let i = 0; i < handleCount; i++) {
      handles[i].style.top = `${rowRects[i].top}px`;
      handles[i].style.height = `${rowRects[i].height}px`;
    }
  }
}

/**
 * Re-measures and repositions every table's column bar and row handles
 * whenever anything that could change their geometry happens. This is
 * deliberately broader than `update.docChanged || update.geometryChanged ||
 * update.viewportChanged` alone: a selection-only transaction can still
 * change a header cell's *rendered width* without tripping any of those
 * three — moving the cursor into a cell reveals its raw markdown (e.g.
 * `**Name**` instead of `Name`, via `isRevealTarget`), which
 * `update.geometryChanged` does not appear to catch, leaving the column
 * bars visibly misaligned until an unrelated edit finally re-triggers a
 * measure. `update.selectionSet`/`update.focusChanged` cover that case (and
 * the mirror-image blur-driven reveal-hide); `requestMeasure`'s own
 * `key`-based dedup means scheduling on every one of these triggers costs
 * nothing extra when several fire in the same update.
 *
 * Scheduling through `view.requestMeasure` — rather than reading
 * `offsetLeft`/`offsetWidth`/`offsetTop`/`offsetHeight` directly inside
 * `update()` — is required, not just tidy: `PluginValue.update()`'s own
 * type comment states it runs *before* the view updates its own DOM and
 * should not read DOM layout, exactly the read `measureTableGeometry` needs
 * to do against the just-rendered header cells and row lines.
 */
export const tableGeometryMeasurePlugin = ViewPlugin.fromClass(
  class {
    constructor(view: EditorView) {
      this.scheduleMeasure(view);
    }

    update(update: ViewUpdate): void {
      if (
        update.docChanged ||
        update.geometryChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        update.focusChanged
      ) {
        this.scheduleMeasure(update.view);
      }
    }

    scheduleMeasure(view: EditorView): void {
      view.requestMeasure({
        key: tableGeometryMeasureKey,
        read: measureTableGeometry,
        write: applyTableGeometry,
      });
    }
  },
);

import { StateEffect, StateField } from "@codemirror/state";
import type { EditorState, StateEffectType, Transaction, TransactionSpec } from "@codemirror/state";
import { EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import type { KeyBinding, ViewUpdate } from "@codemirror/view";
import { findTableContext, insertColumn, insertRow, moveColumn, moveRow } from "./tableEdit";
import type { TableEditContext } from "./tableEdit";
import { collectCellSlots } from "./decorations";
import { tooltip } from "../../ui/tooltip";
import { beginDragLock, endDragLock } from "../../ui/dragLock";

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
 * The row/column currently being dragged, if any — set on `pointerdown` and
 * updated (in the same transaction as the move, see `attachDragReorder`'s
 * `attemptStep`) on every step, so the tint this drives never blanks for a
 * frame between a move landing and the field catching up. Cleared
 * unconditionally on `pointerup` and on `pointercancel` alike, since either
 * one ends the gesture.
 */
const dragTarget = defineTableTargetField();
export const setTableDrag = dragTarget.effect;
export const tableDragField = dragTarget.field;

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
 * The six-dot drag-handle glyph shared by row and column handles, built
 * from real elements (rather than a CSS `::before`/font glyph) so its dot
 * count/layout stays easy to read and adjust in `markdown.css` — a tall 2x3
 * grid for the row handle, a wide 3x2 grid for the column bar (scoped in
 * CSS to `.cm-table-col-bar .cm-table-handle-dots`).
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
 * Wires the pointerenter/pointerleave/click/contextmenu quartet every handle
 * shares: hovering sets (and leaving clears) `tableHoverField`; clicking, or
 * right-clicking to open the context menu, both pin `target` into
 * `tableSelectionField` instead, so it stays highlighted regardless of
 * where the pointer travels afterward (see `tableSelectionField`'s own doc
 * comment for why selection is kept separate from — not merged into —
 * hover; the context menu is exactly the case that comment describes, since
 * the pointer moves off the handle and onto the menu the moment it opens).
 * Also stamps `target`'s identity onto the element as `data-table-handle-*`
 * attributes and lets a right-click bubble normally (only `preventDefault`,
 * never `stopPropagation`) — `EditorPane.svelte`'s document-level
 * context-menu handler reads those attributes via
 * `tableContextFromHandleElement` before falling back to its usual
 * coordinate-based resolution.
 */
function attachHandleInteractions(el: HTMLElement, view: EditorView, target: TableHoverState): void {
  el.dataset.tableHandleTable = String(target.table);
  if (target.row !== null) {
    el.dataset.tableHandleRow = String(target.row);
  }
  if (target.col !== null) {
    el.dataset.tableHandleCol = String(target.col);
  }
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
  el.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    view.dispatch({ effects: setTableSelection.of(target) });
  });
}

/**
 * A `pointerdown`-driven drag gesture shared in shape by row and column
 * reordering: track which slot currently holds the dragged row/column
 * (`current`, updated after every crossed boundary — never the position it
 * started at, since that's exactly the stale-anchor bug the plan's "Identity
 * tracking across steps" note warns about), and on each `pointermove`,
 * compare the pointer's coordinate against the *other* handles' own
 * currently-rendered positions (`measureRectsByIndex`, always re-queried
 * fresh — never cached — since a swap can itself change row heights/column
 * widths).
 *
 * Neighbours are looked up by their own stamped `data-table-handle-row`/
 * `-col` index (`indexDatasetKey`), never by position in the rendered DOM
 * list — CodeMirror only builds `.cm-table-row-handle` elements for rows in
 * its current viewport, so on a table taller than the viewport the
 * *document* row index `current` tracks and the *render-order* position in
 * a `querySelectorAll` result diverge the moment any row above the table
 * (or above the viewport) isn't rendered. Indexing positionally there either
 * silently no-ops (the neighbour "at that position" doesn't exist) or,
 * worse, resolves to the wrong row entirely (the position happens to hold a
 * different, further-away row) — reordering the wrong pair with no error.
 * Looking a neighbour up by its own index and treating a missing lookup as
 * "no step available" (rather than falling back to whatever the DOM
 * position holds) keeps a drag that scrolls past the rendered edge inert
 * instead of silently wrong.
 *
 * `window`-level listeners (matching `EditorPaneSplit.svelte`'s own
 * `startDragResizer` pattern) mean the gesture keeps tracking the pointer
 * correctly even though the handle DOM element under the cursor is reused
 * for whatever content now occupies that slot after a swap, not whatever
 * content the user started dragging.
 *
 * `attemptStep` resolves a fresh `TableEditContext` from `current` and
 * dispatches one `moveRow`/`moveColumn` step — the existing adjacent-swap
 * commands are the whole atomic unit a drag composes, never bypassed with
 * bulk-move logic — returning whether a step actually happened (`null` from
 * `moveRow`/`moveColumn` means the table's own edge was reached, ending
 * the loop for this move event without erroring).
 *
 * `tableDragField` (via the `dragTarget` option, giving each axis its own
 * `TableHoverState` shape) is set on `pointerdown` and carried in the same
 * `view.dispatch` call as each successful step's move transaction — a
 * separate follow-up dispatch would blank the field for a frame on every
 * step, since `defineTableTargetField`'s reducer clears an ungated field on
 * any `docChanged` transaction that doesn't itself carry a matching effect.
 * `document.body`'s `cm-table-dragging-active` class (driving only the drag
 * tint's handle visibility now — the `grabbing` cursor comes from the shared
 * `dragLock.ts` lock instead, the same one every other drag gesture in the
 * app uses), the drag lock, and `tableDragField` are all torn down from one
 * shared `cleanup`, run on `pointerup`, `pointercancel`, and a window `blur`
 * alike — the field going stale is invisible, but the drag lock isn't: it
 * forces `cursor: grabbing` on every element, so missing one of these exit
 * paths would leave the whole app stuck with a grabbing cursor (and text
 * selection blocked) after an OS/browser-level gesture interruption or a
 * mid-drag app/tab switch.
 */
function attachDragReorder(options: {
  el: HTMLElement;
  view: EditorView;
  table: number;
  initial: number;
  pointerCoord: (event: PointerEvent) => number;
  handleSelector: string;
  indexDatasetKey: "tableHandleRow" | "tableHandleCol";
  rectCoords: (rect: DOMRect) => { start: number; end: number };
  attemptStep: (state: EditorState, table: number, current: number, dir: "before" | "after") => { spec: TransactionSpec | null; next: number };
  dragTarget: (index: number) => TableHoverState;
}): void {
  const { el, view, table, initial, pointerCoord, handleSelector, indexDatasetKey, rectCoords } = options;
  el.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    let current = initial;

    document.body.classList.add("cm-table-dragging-active");
    beginDragLock("grabbing");
    view.dispatch({ effects: setTableDrag.of(options.dragTarget(current)) });

    function measureRectsByIndex(): Map<number, DOMRect> {
      const box = el.closest<HTMLElement>(".cm-table-box");
      const out = new Map<number, DOMRect>();
      if (!box) {
        return out;
      }
      for (const handle of Array.from(box.querySelectorAll<HTMLElement>(handleSelector))) {
        const raw = handle.dataset[indexDatasetKey];
        const idx = raw === undefined ? NaN : Number(raw);
        if (Number.isFinite(idx)) {
          out.set(idx, handle.getBoundingClientRect());
        }
      }
      return out;
    }

    function attemptStep(dir: "before" | "after"): boolean {
      const { spec, next } = options.attemptStep(view.state, table, current, dir);
      if (!spec) {
        return false;
      }
      current = next;
      view.dispatch({ ...spec, effects: setTableDrag.of(options.dragTarget(current)) });
      return true;
    }

    function onMove(e: PointerEvent): void {
      const pos = pointerCoord(e);
      let moved = true;
      while (moved) {
        moved = false;
        const rectsByIndex = measureRectsByIndex();
        const prevRect = rectsByIndex.get(current - 1);
        const nextRect = rectsByIndex.get(current + 1);
        if (prevRect) {
          const { start, end } = rectCoords(prevRect);
          if (pos < (start + end) / 2 && attemptStep("before")) {
            moved = true;
            continue;
          }
        }
        if (nextRect) {
          const { start, end } = rectCoords(nextRect);
          if (pos > (start + end) / 2 && attemptStep("after")) {
            moved = true;
          }
        }
      }
    }

    function cleanup(): void {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("blur", onCancel);
      document.body.classList.remove("cm-table-dragging-active");
      endDragLock();
      view.dispatch({ effects: setTableDrag.of(NO_TABLE_HOVER) });
    }

    function onUp(): void {
      cleanup();
    }

    function onCancel(): void {
      cleanup();
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    // A window blur mid-drag (switching apps/tabs) otherwise self-heals only
    // on the next pointerup anywhere, leaving the drag lock's app-wide
    // `grabbing` cursor (and selection block) stuck in the meantime — closed
    // the same way as a real pointercancel.
    window.addEventListener("blur", onCancel);
  });
}

function attachRowDrag(el: HTMLElement, view: EditorView, table: number, initialRow: number): void {
  attachDragReorder({
    el,
    view,
    table,
    initial: initialRow,
    pointerCoord: (e) => e.clientY,
    handleSelector: ".cm-table-row-handle",
    indexDatasetKey: "tableHandleRow",
    rectCoords: (rect) => ({ start: rect.top, end: rect.bottom }),
    attemptStep: (state, tableFrom, row, dir) => {
      const ctx = rowHandleContext(state, tableFrom, row);
      if (!ctx) {
        return { spec: null, next: row };
      }
      const spec = moveRow(state, ctx, dir === "before" ? "up" : "down");
      return { spec, next: dir === "before" ? row - 1 : row + 1 };
    },
    dragTarget: (row) => ({ table, row, col: null }),
  });
}

function attachColumnDrag(el: HTMLElement, view: EditorView, table: number, initialColumn: number): void {
  attachDragReorder({
    el,
    view,
    table,
    initial: initialColumn,
    pointerCoord: (e) => e.clientX,
    handleSelector: ".cm-table-col-bar",
    indexDatasetKey: "tableHandleCol",
    rectCoords: (rect) => ({ start: rect.left, end: rect.right }),
    attemptStep: (state, tableFrom, column, dir) => {
      const ctx = columnBarContext(state, tableFrom, column);
      if (!ctx) {
        return { spec: null, next: column };
      }
      const spec = moveColumn(state, ctx, dir === "before" ? "left" : "right");
      return { spec, next: dir === "before" ? column - 1 : column + 1 };
    },
    dragTarget: (col) => ({ table, row: null, col }),
  });
}

/**
 * A widget at a table row's own physical-line-start position (the same
 * anchor `decorateTableRow`'s leading `tableGap` already uses, so a nested
 * table's blockquote/list-marker handling doesn't need a second special
 * case). `tableGeometryMeasurePlugin` writes this row's own measured `top`/
 * `height` onto the element (see that plugin's own doc comment for why a
 * plain CSS `height: 100%` resolves against the wrong ancestor). Hovering
 * sets `tableHoverField`; clicking (or dragging — see `attachRowDrag`) pins
 * the row into `tableSelectionField`; `decorateTableRow`/`decorateTable`
 * read both back to apply the row-selected outline class to every cell in
 * the row.
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
    attachRowDrag(el, view, this.table, this.row);
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
    attachColumnDrag(el, view, this.table, this.column);
    return el;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/**
 * Re-resolves the `TableEditContext` for row `row` (0-indexed, header
 * included — matching `TableEditContext.rowIndex`'s own convention) of the
 * table identified by `tableFrom`, given only that identity — used by every
 * handle/band that has no cell position of its own to resolve from. Always
 * re-resolved fresh against the current `state` (never cached) so a prior
 * edit's line shift can't leave it pointing at a stale row.
 */
export function rowHandleContext(state: EditorState, tableFrom: number, row: number): TableEditContext | null {
  const ctx = findTableContext(state, tableFrom);
  if (!ctx) {
    return null;
  }
  const targetRow = ctx.rows[row];
  if (!targetRow) {
    return null;
  }
  return findTableContext(state, targetRow.from);
}

/**
 * Re-resolves the `TableEditContext` for a table's own *last* row — the
 * add-row band's own target, which is always "append after whatever the
 * last row currently is," not a fixed row index.
 */
function lastRowContext(state: EditorState, tableFrom: number): TableEditContext | null {
  const ctx = findTableContext(state, tableFrom);
  if (!ctx) {
    return null;
  }
  return rowHandleContext(state, tableFrom, ctx.rows.length - 1);
}

/**
 * Re-resolves the `TableEditContext` for column `column` (0-indexed) of the
 * table identified by `tableFrom`, by resolving from that column's own slot
 * in the header row (`collectCellSlots`, the same per-row column-range
 * lookup `tableEdit.ts`'s own commands already share).
 */
export function columnBarContext(state: EditorState, tableFrom: number, column: number): TableEditContext | null {
  const ctx = findTableContext(state, tableFrom);
  if (!ctx) {
    return null;
  }
  const headerRow = ctx.rows[0];
  const slots = collectCellSlots(headerRow);
  const slot = slots[column];
  if (!slot) {
    return null;
  }
  return findTableContext(state, slot.from);
}

/**
 * Re-resolves the `TableEditContext` for a table's own *last* column, by
 * resolving from the very end of the header row — `findTableContext`'s
 * column resolution falls back to the last column for a position past every
 * cell's own range, which a header row's own end position always is. (Not
 * built on `columnBarContext`: an empty table's header row has no cell
 * slots at all to index into, but its own end position still resolves.)
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
 * Resolves the `TableEditContext` a right-click on a row/column handle
 * targets, given only the DOM element the click landed on (or bubbled
 * through) — `EditorPane.svelte`'s own context-menu handler calls this
 * before falling back to its usual `posAtCoords`-based resolution, since a
 * handle sits outside the table's own text flow (in the margin, or above
 * the table entirely) where a screen coordinate doesn't reliably map back
 * to the row/column it visually represents. Identity is read from
 * `data-table-handle-*` attributes `attachHandleInteractions` sets once,
 * at `toDOM()` time — plain, inspectable DOM state, not a closure a
 * document-level handler couldn't otherwise reach.
 */
export function tableContextFromHandleElement(state: EditorState, target: HTMLElement): TableEditContext | null {
  const handleEl = target.closest<HTMLElement>(".cm-table-row-handle, .cm-table-col-bar");
  if (!handleEl) {
    return null;
  }
  const table = Number(handleEl.dataset.tableHandleTable);
  if (!Number.isFinite(table)) {
    return null;
  }
  if (handleEl.dataset.tableHandleRow !== undefined) {
    return rowHandleContext(state, table, Number(handleEl.dataset.tableHandleRow));
  }
  if (handleEl.dataset.tableHandleCol !== undefined) {
    return columnBarContext(state, table, Number(handleEl.dataset.tableHandleCol));
  }
  return null;
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

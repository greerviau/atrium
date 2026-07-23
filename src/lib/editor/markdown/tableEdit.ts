import type { EditorState, TransactionSpec } from "@codemirror/state";
import type { KeyBinding } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import { collectCellSlots, parseColumnAlignment, type CellSlot, type ColumnAlignment } from "./decorations";

/**
 * Everything a row/column command needs to know about the table under the
 * cursor or right-click, resolved once by `findTableContext` and shared by
 * every command below (and by `EditorPane.svelte`'s context-menu template,
 * which uses `column`/`columnCount`/`rowKind` to decide what's enabled).
 */
export interface TableEditContext {
  table: SyntaxNode;
  row: SyntaxNode;
  rowKind: "header" | "body" | "delimiter";
  rows: SyntaxNode[];
  rowIndex: number;
  column: number;
  columnCount: number;
}

/**
 * The alignment-delimiter row (`| --- | :---: |`) has no `TableCell`
 * children at all — `parseColumnAlignment` reads its raw text directly — so
 * there's no tree to walk for "which column is at this position" the way
 * `collectCellSlots` does for a real row. This re-runs the same `|`-split
 * `parseColumnAlignment` does, but keeps each segment's own trimmed
 * character range instead of discarding it after computing the alignment,
 * giving column operations the same shape of boundary (a `CellSlot`-shaped
 * `{from, to}` range) to insert/delete/swap at as a real row's cells.
 */
function collectDelimiterSegments(state: EditorState, node: SyntaxNode): CellSlot[] {
  const text = state.doc.sliceString(node.from, node.to);
  const segments: CellSlot[] = [];
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === "|") {
      const raw = text.slice(start, i);
      const leading = raw.length - raw.trimStart().length;
      const trimmedLength = raw.trim().length;
      if (trimmedLength > 0) {
        segments.push({ from: node.from + start + leading, to: node.from + start + leading + trimmedLength });
      }
      start = i + 1;
    }
  }
  return segments;
}

/**
 * Resolves which column `pos` falls in among a row's own ordered slots: the
 * first slot whose own end reaches or passes `pos` — so a position inside a
 * gap (before a real cell's own text starts) resolves to the *following*
 * column, matching where that gap visually sits between the two. Falls back
 * to the last column for a position past every slot (e.g. beyond the last
 * cell, clamped per `TableEditContext.column`'s own contract).
 */
function resolveColumnIndex(pos: number, ranges: CellSlot[]): number {
  for (let i = 0; i < ranges.length; i++) {
    if (pos <= ranges[i].to) {
      return i;
    }
  }
  return Math.max(0, ranges.length - 1);
}

/**
 * Resolves the enclosing table context for `pos`, or `null` outside any
 * table. Walks up from the resolved syntax node to find the enclosing
 * `Table`, then scans its direct children (always some mix of one
 * `TableHeader`, one `TableDelimiter`, and zero or more `TableRow`s, in
 * document order) to find which row/delimiter line actually contains `pos` —
 * rather than walking up node-by-node, since a per-pipe `TableDelimiter`
 * mark nested *inside* a data row (see `collectCellSlots`) shares its type
 * name with the table's own outer alignment-delimiter row, and only a
 * direct-child check unambiguously tells them apart.
 */
export function findTableContext(state: EditorState, pos: number): TableEditContext | null {
  let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1);
  let table: SyntaxNode | null = null;
  while (n) {
    if (n.type.name === "Table") {
      table = n;
      break;
    }
    n = n.parent;
  }
  if (!table) {
    return null;
  }

  const rows: SyntaxNode[] = [];
  let delimiterNode: SyntaxNode | null = null;
  let targetRow: SyntaxNode | null = null;
  let rowKind: "header" | "body" | "delimiter" | null = null;

  for (let child = table.firstChild; child; child = child.nextSibling) {
    if (child.type.name === "TableHeader" || child.type.name === "TableRow") {
      rows.push(child);
      if (pos >= child.from && pos <= child.to) {
        targetRow = child;
        rowKind = child.type.name === "TableHeader" ? "header" : "body";
      }
    } else if (child.type.name === "TableDelimiter") {
      delimiterNode = child;
      if (pos >= child.from && pos <= child.to) {
        targetRow = child;
        rowKind = "delimiter";
      }
    }
  }

  if (!targetRow || !rowKind || !delimiterNode) {
    return null;
  }

  const alignment: ColumnAlignment[] = parseColumnAlignment(
    state.doc.sliceString(delimiterNode.from, delimiterNode.to),
  );
  const columnCount = alignment.length;
  const rowIndex = rowKind === "delimiter" ? -1 : rows.indexOf(targetRow);
  const column =
    rowKind === "delimiter"
      ? resolveColumnIndex(pos, collectDelimiterSegments(state, targetRow))
      : resolveColumnIndex(pos, collectCellSlots(targetRow));

  return { table, row: targetRow, rowKind, rows, rowIndex, column, columnCount };
}

function buildEmptyRowText(leadingPrefix: string, columnCount: number): string {
  return `${leadingPrefix}| ${Array(columnCount).fill("").join(" | ")} |`;
}

function leadingPrefixFor(state: EditorState, row: SyntaxNode): string {
  return state.doc.sliceString(state.doc.lineAt(row.from).from, row.from);
}

function insertRowBeforeLine(state: EditorState, lineNumber: number, prefixRow: SyntaxNode, columnCount: number): TransactionSpec {
  const line = state.doc.line(lineNumber);
  const leadingPrefix = leadingPrefixFor(state, prefixRow);
  const rowText = buildEmptyRowText(leadingPrefix, columnCount);
  return {
    changes: { from: line.from, insert: rowText + "\n" },
    selection: { anchor: line.from + leadingPrefix.length + 2 },
  };
}

function insertRowAfterLine(state: EditorState, lineNumber: number, prefixRow: SyntaxNode, columnCount: number): TransactionSpec {
  const leadingPrefix = leadingPrefixFor(state, prefixRow);
  const rowText = buildEmptyRowText(leadingPrefix, columnCount);
  const line = state.doc.line(lineNumber);
  if (lineNumber < state.doc.lines) {
    const nextLineFrom = state.doc.line(lineNumber + 1).from;
    return {
      changes: { from: nextLineFrom, insert: rowText + "\n" },
      selection: { anchor: nextLineFrom + leadingPrefix.length + 2 },
    };
  }
  return {
    changes: { from: line.to, insert: "\n" + rowText },
    selection: { anchor: line.to + 1 + leadingPrefix.length + 2 },
  };
}

/**
 * `above` is only ever valid for a body row (a header/delimiter target has
 * nothing valid above it — see the plan's row-operations table); `below` is
 * valid from every `rowKind`, inserting right after the delimiter's own
 * line when the target is the header or the delimiter itself, so both
 * resolve to the same "first body row" result.
 */
export function insertRow(state: EditorState, ctx: TableEditContext, where: "above" | "below"): TransactionSpec | null {
  if (where === "above") {
    if (ctx.rowKind !== "body") {
      return null;
    }
    return insertRowBeforeLine(state, state.doc.lineAt(ctx.row.from).number, ctx.row, ctx.columnCount);
  }

  if (ctx.rowKind === "body") {
    return insertRowAfterLine(state, state.doc.lineAt(ctx.row.from).number, ctx.row, ctx.columnCount);
  }

  const delimiterNode = ctx.table.getChild("TableDelimiter");
  const headerRow = ctx.rows[0];
  if (!delimiterNode || !headerRow) {
    return null;
  }
  return insertRowAfterLine(state, state.doc.lineAt(delimiterNode.from).number, headerRow, ctx.columnCount);
}

/** `null` for the header/delimiter — deleting either would break the table's own GFM structure. */
export function deleteRow(state: EditorState, ctx: TableEditContext): TransactionSpec | null {
  if (ctx.rowKind !== "body") {
    return null;
  }
  const line = state.doc.lineAt(ctx.row.from);
  const to = line.number < state.doc.lines ? state.doc.line(line.number + 1).from : line.to;
  return { changes: { from: line.from, to } };
}

/**
 * Swaps the target row's whole physical line with the adjacent body row's,
 * in one transaction. `null` whenever that adjacent row is the header, the
 * delimiter, or doesn't exist: a header/delimiter target is `null` in both
 * directions (neither ever has a swappable body row on the far side), and
 * the first body row is `null` only going `up` (its "adjacent" row there is
 * the header, not a swappable one).
 */
export function moveRow(state: EditorState, ctx: TableEditContext, dir: "up" | "down"): TransactionSpec | null {
  if (ctx.rowKind !== "body") {
    return null;
  }
  const adjacentIndex = dir === "up" ? ctx.rowIndex - 1 : ctx.rowIndex + 1;
  if (adjacentIndex <= 0 || adjacentIndex >= ctx.rows.length) {
    return null;
  }

  const currentLine = state.doc.lineAt(ctx.row.from);
  const adjacentLine = state.doc.lineAt(ctx.rows[adjacentIndex].from);
  const currentText = state.doc.sliceString(currentLine.from, currentLine.to);
  const adjacentText = state.doc.sliceString(adjacentLine.from, adjacentLine.to);

  const [upperLine, upperText, lowerLine, lowerText] =
    currentLine.from < adjacentLine.from
      ? [currentLine, adjacentText, adjacentLine, currentText]
      : [adjacentLine, currentText, currentLine, adjacentText];

  return {
    changes: [
      { from: upperLine.from, to: upperLine.to, insert: upperText },
      { from: lowerLine.from, to: lowerLine.to, insert: lowerText },
    ],
  };
}

/**
 * The insertion offset/text for one row's column-splice, shared by every
 * row (header, body, and — via `collectDelimiterSegments`'s same-shaped
 * ranges — the delimiter). `content` is `""` for a real row's freshly
 * inserted empty cell, `"---"` for the delimiter's freshly inserted
 * (left-aligned, GFM's own default) alignment segment.
 *
 * `null` when the anchor column doesn't exist on this row at all: GFM lets
 * a body row have fewer cells than the header (missing trailing cells are
 * implicitly empty — e.g. a row mid-typed or pasted short), and inserting a
 * column somewhere at or past that row's own already-implicit-empty tail
 * needs no edit at all — the row stays exactly as legitimately "short"
 * relative to the table's new, one-larger column count.
 *
 * Every other case inserts `" | "+content` right after the anchor column's
 * own end, relying on the *existing* pipe/content immediately following it
 * (untouched) to close the new segment off — exactly how `deleteColumn`'s
 * mirror-image removal works. The leftmost edge (`left` at column 0) has no
 * preceding column to anchor after, so it instead inserts `content+" | "`
 * immediately before the first column's own start, letting the *existing*
 * leading pipe (or, if the row omits its outer pipe per GFM, nothing at
 * all) stay untouched on its left — column 0 always exists on any row with
 * real content, so this branch never needs the same short-row guard.
 */
function columnInsertionChange(
  ranges: CellSlot[],
  column: number,
  where: "left" | "right",
  content: string,
): { from: number; insert: string } | null {
  if (where === "left" && column === 0) {
    return { from: ranges[0].from, insert: `${content} | ` };
  }
  const anchorIndex = where === "right" ? column : column - 1;
  if (anchorIndex >= ranges.length) {
    return null;
  }
  return { from: ranges[anchorIndex].to, insert: ` | ${content}` };
}

/**
 * Splices a new empty column into every row (and the delimiter's own
 * alignment segment) in one transaction, so it's one undo step. `column`
 * counting matches `TableEditContext.column`: `right` at column `c` and
 * `left` at column `c+1` insert at the identical boundary. A row shorter
 * than the insertion point is left untouched — see `columnInsertionChange`.
 */
export function insertColumn(state: EditorState, ctx: TableEditContext, where: "left" | "right"): TransactionSpec | null {
  const delimiterNode = ctx.table.getChild("TableDelimiter");
  if (!delimiterNode) {
    return null;
  }

  const changes = ctx.rows
    .map((row) => columnInsertionChange(collectCellSlots(row), ctx.column, where, ""))
    .filter((change): change is { from: number; insert: string } => change !== null);
  const delimiterChange = columnInsertionChange(collectDelimiterSegments(state, delimiterNode), ctx.column, where, "---");
  if (delimiterChange) {
    changes.push(delimiterChange);
  }

  return { changes };
}

/**
 * The range to remove for deleting column `column`: its own content plus
 * exactly one adjoining gap, so the row's pipe count drops by exactly one.
 * Column 0 has no gap *before* it to fold in, so it takes its trailing gap
 * (up to the next column's own start) instead — the mirror image of
 * `columnInsertionChange`'s leftmost-edge special case, unless this row's
 * *only* cell is the one being deleted (`ranges.length === 1`), in which
 * case there's no next column's start to fold into either, so just its own
 * content is removed, leaving the row's own pipes as one explicit empty
 * cell.
 *
 * `null` when this row doesn't reach column `column` at all — a short row
 * (see `columnInsertionChange`'s own doc comment) whose own explicit cells
 * all sit before `column` needs no edit: they keep their exact positions
 * relative to the table's new, one-smaller column count.
 */
function columnDeletionRange(ranges: CellSlot[], column: number): { from: number; to: number } | null {
  if (column === 0) {
    if (ranges.length === 0) {
      return null;
    }
    return ranges.length === 1 ? { from: ranges[0].from, to: ranges[0].to } : { from: ranges[0].from, to: ranges[1].from };
  }
  if (ranges.length <= column) {
    return null;
  }
  return { from: ranges[column - 1].to, to: ranges[column].to };
}

/** `null` when there's only one column left — nothing adjacent to fold the removed column's gap into. */
export function deleteColumn(state: EditorState, ctx: TableEditContext): TransactionSpec | null {
  if (ctx.columnCount <= 1) {
    return null;
  }
  const delimiterNode = ctx.table.getChild("TableDelimiter");
  if (!delimiterNode) {
    return null;
  }

  const changes = ctx.rows
    .map((row) => columnDeletionRange(collectCellSlots(row), ctx.column))
    .filter((range): range is { from: number; to: number } => range !== null);
  const delimiterRange = columnDeletionRange(collectDelimiterSegments(state, delimiterNode), ctx.column);
  if (delimiterRange) {
    changes.push(delimiterRange);
  }

  return { changes };
}

/**
 * Swaps columns `a` and `b` (`a < b`) for one row. Three shapes, depending
 * on how far this row's own real cells actually reach:
 *
 * - Both exist (`ranges.length > b`): a plain content swap, same as
 *   `moveRow`'s own line swap — no positions change, just which text sits
 *   where.
 * - Neither exists (`ranges.length <= a`): both sides of the swap are
 *   already implicitly empty for this short row (see `columnInsertionChange`
 *   for the same GFM allowance) — swapping two empties is a genuine no-op.
 * - Only `a` exists (`ranges.length === a + 1`, i.e. `a` is this row's own
 *   *last* real cell — the only way to land here, since `moveColumn` only
 *   ever swaps adjacent columns, `b === a + 1`): this is the one shape with
 *   a real data-integrity hazard. `a`'s real content needs to *relocate* to
 *   `b`'s position, not just vanish — leaving it in place after the
 *   column-wide swap would silently attribute it to whatever column now
 *   renders at index `a` instead of the one it actually belongs to. Column
 *   `a`'s own span is replaced with `" | "+<a's old text>`: the row grows by
 *   one explicit (now-empty) cell at `a` and one explicit cell at `b`
 *   holding the relocated text, using the exact same "insert right after
 *   the existing content, let it close naturally" shape `columnInsertionChange`
 *   already relies on for a plain interior insert.
 */
function swapRangeChanges(
  state: EditorState,
  ranges: CellSlot[],
  a: number,
  b: number,
): { from: number; to: number; insert: string }[] {
  if (ranges.length <= a) {
    return [];
  }
  if (ranges.length <= b) {
    const rangeA = ranges[a];
    const textA = state.doc.sliceString(rangeA.from, rangeA.to);
    return [{ from: rangeA.from, to: rangeA.to, insert: ` | ${textA}` }];
  }

  const rangeA = ranges[a];
  const rangeB = ranges[b];
  const textA = state.doc.sliceString(rangeA.from, rangeA.to);
  const textB = state.doc.sliceString(rangeB.from, rangeB.to);

  const [first, firstText, second, secondText] =
    rangeA.from < rangeB.from ? [rangeA, textB, rangeB, textA] : [rangeB, textA, rangeA, textB];

  return [
    { from: first.from, to: first.to, insert: firstText },
    { from: second.from, to: second.to, insert: secondText },
  ];
}

/**
 * Swaps column `ctx.column`'s own text with its adjacent column's, per row —
 * the delimiter's own alignment segment included, so a column's alignment
 * travels with it exactly as a user moving it would expect. `null` when
 * there's only one column, or the target adjacent column doesn't exist.
 */
export function moveColumn(state: EditorState, ctx: TableEditContext, dir: "left" | "right"): TransactionSpec | null {
  if (ctx.columnCount <= 1) {
    return null;
  }
  const adjacent = dir === "left" ? ctx.column - 1 : ctx.column + 1;
  if (adjacent < 0 || adjacent >= ctx.columnCount) {
    return null;
  }
  const delimiterNode = ctx.table.getChild("TableDelimiter");
  if (!delimiterNode) {
    return null;
  }

  const [lower, upper] = ctx.column < adjacent ? [ctx.column, adjacent] : [adjacent, ctx.column];
  const changes = ctx.rows.flatMap((row) => swapRangeChanges(state, collectCellSlots(row), lower, upper));
  changes.push(...swapRangeChanges(state, collectDelimiterSegments(state, delimiterNode), lower, upper));

  return { changes };
}

/** Clamped to the row's own last real cell — the target row of an Enter/Tab move may have fewer cells than the one the cursor started in (see `columnInsertionChange`'s own doc comment on short rows). */
function cellCursor(row: SyntaxNode, column: number): number {
  const slots = collectCellSlots(row);
  return slots[Math.min(column, slots.length - 1)].from;
}

/**
 * `Tab`/`Shift-Tab`/`Enter`, each self-gated on `findTableContext` finding a
 * navigable (`header`/`body`) cell at the cursor, so every binding falls
 * through untouched (returns `false`, letting `indentWithTab`/`defaultKeymap`
 * run instead) the instant the cursor is anywhere outside a table — the
 * delimiter row included, since it's never a landable cursor position in the
 * live-preview view in the first place (its raw text is always fully
 * hidden, unlike every other cursor-revealed construct — see
 * `decorateTable`), so there's no meaningful "next cell" from there.
 *
 * Must be wired in with `Prec.highest` wherever it's installed — see
 * `livePreviewPlugin.ts`'s own doc comment for why a plain `keymap.of(...)`
 * here would be silently shadowed by `baseExtensions()`'s own `Tab`/`Enter`
 * bindings.
 */
export const tableNavigationKeymap: readonly KeyBinding[] = [
  {
    key: "Tab",
    run(view) {
      const ctx = findTableContext(view.state, view.state.selection.main.head);
      if (!ctx || ctx.rowKind === "delimiter") {
        return false;
      }
      if (ctx.column < ctx.columnCount - 1) {
        view.dispatch({ selection: { anchor: cellCursor(ctx.row, ctx.column + 1) } });
        return true;
      }
      if (ctx.rowIndex < ctx.rows.length - 1) {
        view.dispatch({ selection: { anchor: cellCursor(ctx.rows[ctx.rowIndex + 1], 0) } });
        return true;
      }
      const spec = insertRow(view.state, ctx, "below");
      if (!spec) {
        return false;
      }
      view.dispatch(spec);
      return true;
    },
  },
  {
    key: "Shift-Tab",
    run(view) {
      const ctx = findTableContext(view.state, view.state.selection.main.head);
      if (!ctx || ctx.rowKind === "delimiter") {
        return false;
      }
      if (ctx.column > 0) {
        view.dispatch({ selection: { anchor: cellCursor(ctx.row, ctx.column - 1) } });
        return true;
      }
      if (ctx.rowIndex > 0) {
        const prevRow = ctx.rows[ctx.rowIndex - 1];
        view.dispatch({ selection: { anchor: cellCursor(prevRow, collectCellSlots(prevRow).length - 1) } });
        return true;
      }
      return false;
    },
  },
  {
    key: "Enter",
    run(view) {
      const ctx = findTableContext(view.state, view.state.selection.main.head);
      if (!ctx || ctx.rowKind === "delimiter") {
        return false;
      }
      if (ctx.rowIndex < ctx.rows.length - 1) {
        view.dispatch({ selection: { anchor: cellCursor(ctx.rows[ctx.rowIndex + 1], ctx.column) } });
        return true;
      }
      const spec = insertRow(view.state, ctx, "below");
      if (!spec) {
        return false;
      }
      view.dispatch(spec);
      return true;
    },
  },
];

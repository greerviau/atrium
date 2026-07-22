import type { EditorState, Range } from "@codemirror/state";
import { Decoration } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import { CheckboxWidget, ImageWidget, MermaidWidget } from "./widgets";
import { headingClass, CLASS } from "./theme";
import { extractMermaidSource } from "./mermaid";

const HEADING_LEVELS: Record<string, 1 | 2 | 3 | 4 | 5 | 6> = {
  ATXHeading1: 1,
  ATXHeading2: 2,
  ATXHeading3: 3,
  ATXHeading4: 4,
  ATXHeading5: 5,
  ATXHeading6: 6,
};

/**
 * True if any selection range overlaps the full line(s) spanned by
 * `[from, to)` — per Obsidian-style live preview, a node under the cursor
 * shows its raw markdown source instead of the rendered decoration.
 */
function isUnderCursor(state: EditorState, from: number, to: number): boolean {
  const lineFrom = state.doc.lineAt(from).from;
  const lineTo = state.doc.lineAt(to).to;
  return state.selection.ranges.some((r) => r.from <= lineTo && r.to >= lineFrom);
}

/**
 * True if any selection range overlaps `[from, to)` exactly, with no
 * widening to the enclosing line. Used where a single line contains several
 * independently-editable spans (table cells) and gating on the whole line,
 * like `isUnderCursor` does, would reveal every sibling span at once.
 */
function overlapsSelection(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((r) => r.from <= to && r.to >= from);
}

function decorateHeading(
  state: EditorState,
  node: SyntaxNode,
  level: 1 | 2 | 3 | 4 | 5 | 6,
  out: Range<Decoration>[],
): void {
  const mark = node.getChild("HeaderMark");
  if (!mark) {
    return;
  }
  // With the cursor on this line, keep the heading styled but reveal the
  // marker instead of hiding it (matches the fenced-code/table precedent:
  // container stays visible, only markup-hiding is cursor-gated).
  if (isUnderCursor(state, node.from, node.to)) {
    out.push(Decoration.mark({ class: headingClass(level) }).range(node.from, node.to));
    return;
  }
  // Hide the `#`+space marker (zero-width); mark the remaining text with a
  // heading-level class controlling font-size/weight.
  const textStart = Math.min(mark.to + 1, node.to);
  out.push(Decoration.replace({}).range(mark.from, textStart));
  if (textStart < node.to) {
    out.push(Decoration.mark({ class: headingClass(level) }).range(textStart, node.to));
  }
}

/**
 * Shared shape for Emphasis/StrongEmphasis/Strikethrough/InlineCode: the
 * whole node always gets a CSS class so the inner text gets the style; the
 * delimiter runs (found by `markTypeName`) are hidden unless the cursor is
 * on this line, in which case they're left visible inside the still-styled
 * span (matches the fenced-code/table precedent).
 */
function decorateWrapped(
  state: EditorState,
  node: SyntaxNode,
  markTypeName: string,
  cssClass: string,
  out: Range<Decoration>[],
): void {
  out.push(Decoration.mark({ class: cssClass }).range(node.from, node.to));
  if (isUnderCursor(state, node.from, node.to)) {
    return;
  }
  let child = node.firstChild;
  while (child) {
    if (child.type.name === markTypeName) {
      out.push(Decoration.replace({}).range(child.from, child.to));
    }
    child = child.nextSibling;
  }
}

function decorateLink(state: EditorState, node: SyntaxNode, documentPath: string, out: Range<Decoration>[]): void {
  const marks = node.getChildren("LinkMark");
  if (marks.length < 2) {
    return;
  }
  const openMark = marks[0];
  const closeTextMark = marks[1];
  const urlNode = node.getChild("URL");
  const url = urlNode ? state.doc.sliceString(urlNode.from, urlNode.to) : "";

  out.push(Decoration.replace({}).range(openMark.from, openMark.to));
  out.push(Decoration.replace({}).range(closeTextMark.from, node.to));
  out.push(
    Decoration.mark({
      class: CLASS.link,
      attributes: { "data-href": url, "data-document-path": documentPath },
    }).range(openMark.to, closeTextMark.from),
  );
}

function decorateImage(state: EditorState, node: SyntaxNode, documentPath: string, out: Range<Decoration>[]): void {
  const marks = node.getChildren("LinkMark");
  const urlNode = node.getChild("URL");
  if (marks.length < 2 || !urlNode) {
    return;
  }
  const alt = state.doc.sliceString(marks[0].to, marks[1].from);
  const url = state.doc.sliceString(urlNode.from, urlNode.to);
  out.push(
    Decoration.replace({ widget: new ImageWidget(url, alt, documentPath, node.from) }).range(node.from, node.to),
  );
}

function decorateCodeBlock(
  state: EditorState,
  node: SyntaxNode,
  isFenced: boolean,
  out: Range<Decoration>[],
): void {
  const startLine = state.doc.lineAt(node.from).number;
  const endLine = state.doc.lineAt(node.to).number;
  const hideMarkers = isFenced && !isUnderCursor(state, node.from, node.to);

  const marks = node.getChildren("CodeMark");
  const info = node.getChild("CodeInfo");
  const openMark = marks[0];
  const closeMark = marks[marks.length - 1];
  // While markers are hidden, the fence/language-tag line(s) they belong to
  // are fully `Decoration.replace`d and render nothing, so they must not
  // count toward the block's width. `.length` counts characters (a tab is
  // one character in the doc, same as any other), matching the `ch` unit
  // it feeds below.
  const openMarkLine = hideMarkers && openMark ? state.doc.lineAt(openMark.from).number : -1;
  const closeMarkLine =
    hideMarkers && closeMark && closeMark !== openMark ? state.doc.lineAt(closeMark.from).number : -1;

  let maxChars = 0;
  for (let n = startLine; n <= endLine; n++) {
    if (n === openMarkLine || n === closeMarkLine) {
      continue;
    }
    maxChars = Math.max(maxChars, state.doc.line(n).length);
  }

  for (let n = startLine; n <= endLine; n++) {
    out.push(
      Decoration.line({
        class: CLASS.codeBlock,
        attributes: { style: `width: ${maxChars}ch` },
      }).range(state.doc.line(n).from),
    );
  }

  if (!hideMarkers) {
    return;
  }

  if (openMark) {
    out.push(Decoration.replace({}).range(openMark.from, info ? info.to : openMark.to));
  }
  if (closeMark && closeMark !== openMark) {
    out.push(Decoration.replace({}).range(closeMark.from, closeMark.to));
  }
}

/**
 * The Mermaid source for `node`, but only when it should actually be
 * replaced by a diagram widget: tagged ` ```mermaid ` and the cursor is
 * elsewhere. `null` covers both "not a mermaid block" and "mermaid block
 * under the cursor" — either way the caller falls through to
 * `decorateCodeBlock`'s normal fenced-code handling unchanged.
 *
 * CodeMirror requires block-level (`block: true`) replace decorations to
 * come from a `StateField`, not a `ViewPlugin` — so this check is shared by
 * two call sites: the `ViewPlugin`-driven `buildDecorations` below (which
 * uses it only to skip `decorateCodeBlock`'s container/fence decorations,
 * since there's nothing to decorate underneath a fully-replaced block) and
 * `buildMermaidWidgetDecorations` (which uses it to actually build the
 * widget decoration, from a `StateField` — see `mermaidWidgetField` in
 * `livePreviewPlugin.ts`).
 */
function mermaidWidgetSource(state: EditorState, node: SyntaxNode): string | null {
  const source = extractMermaidSource(state, node);
  if (source === null || isUnderCursor(state, node.from, node.to)) {
    return null;
  }
  return source;
}

/**
 * Node names a ` ```mermaid ` block can be nested under (besides the
 * document root) — every markdown block container that can hold a fenced
 * code block as a descendant. Pruning descent to just these keeps
 * `buildMermaidWidgetDecorations`'s whole-document walk proportional to
 * block/line count rather than total node count, since it never descends
 * into inline content (`Paragraph`, `Emphasis`, ...) at all.
 */
const MERMAID_CONTAINER_NODES = new Set(["Blockquote", "BulletList", "OrderedList", "ListItem"]);

/**
 * Builds block-replace `MermaidWidget` decorations for every ` ```mermaid `
 * block in the document with the cursor elsewhere. Walks the whole
 * document (not viewport-limited like `buildDecorations`) because a
 * `StateField`, which is what this feeds, has no notion of the current
 * viewport — but descent is pruned to markdown block containers
 * (`MERMAID_CONTAINER_NODES`) plus `FencedCode` itself, so realistic
 * documents (far more inline content than fenced blocks) stay cheap.
 */
export function buildMermaidWidgetDecorations(state: EditorState): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  syntaxTree(state).iterate({
    enter(ref) {
      if (ref.name === "FencedCode") {
        const source = mermaidWidgetSource(state, ref.node);
        if (source !== null) {
          decorations.push(
            Decoration.replace({ widget: new MermaidWidget(source, ref.from), block: true }).range(ref.from, ref.to),
          );
        }
        return false;
      }
      if (ref.name !== "Document" && !MERMAID_CONTAINER_NODES.has(ref.name)) {
        return false;
      }
    },
  });
  return Decoration.set(decorations, true);
}

type ColumnAlignment = "left" | "center" | "right";

/**
 * Parses a GFM alignment-delimiter row's raw text (e.g. `"| :--- | :---: | ---: |"`)
 * into one alignment per column, by GFM's own rule: `:` on both ends is
 * `center`, on the trailing end only is `right`, otherwise `left`.
 */
function parseColumnAlignment(text: string): ColumnAlignment[] {
  return text
    .split("|")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      if (segment.startsWith(":") && segment.endsWith(":")) {
        return "center";
      }
      if (segment.endsWith(":")) {
        return "right";
      }
      return "left";
    });
}

/**
 * Decorates one table row (`TableHeader` or `TableRow`, always a single
 * physical line). The row gets an always-visible `Decoration.line`
 * container (`display: table-row`, matching the code-block precedent).
 * Cursor-gating applies per cell, not to the row as a whole: each
 * `TableCell` is checked against the cursor independently, so editing one
 * cell reveals only that cell (and its bordering pipe/gap) while every
 * other cell on the same row keeps its `cm-table-cell`/alignment styling.
 * The gap between two cells reveals if either bordering cell is under the
 * cursor, since the pipe visually belongs to both boundaries.
 */
function decorateTableRow(
  state: EditorState,
  node: SyntaxNode,
  alignment: ColumnAlignment[],
  isHeader: boolean,
  out: Range<Decoration>[],
): void {
  const rowClass = isHeader ? `${CLASS.tableRow} ${CLASS.tableHeaderRow}` : CLASS.tableRow;
  out.push(Decoration.line({ class: rowClass }).range(state.doc.lineAt(node.from).from));

  let prevEnd = node.from;
  let prevCellUnderCursor = false;
  let column = 0;
  let child = node.firstChild;
  while (child) {
    if (child.type.name === "TableCell") {
      const cellUnderCursor = overlapsSelection(state, child.from, child.to);
      const gapUnderCursor = cellUnderCursor || prevCellUnderCursor;
      // Fully consume the gap since the previous cell (its `|` plus any
      // surrounding whitespace) rather than just the pipe character — a
      // leftover whitespace text node would become its own anonymous
      // table-cell once the real cells get `display: table-cell`.
      if (child.from > prevEnd && !gapUnderCursor) {
        out.push(Decoration.replace({}).range(prevEnd, child.from));
      }
      if (!cellUnderCursor) {
        const classes: string[] = [CLASS.tableCell];
        if (isHeader) {
          classes.push(CLASS.tableHeaderCell);
        }
        if (alignment[column] === "center") {
          classes.push(CLASS.tableAlignCenter);
        } else if (alignment[column] === "right") {
          classes.push(CLASS.tableAlignRight);
        }
        out.push(Decoration.mark({ class: classes.join(" ") }).range(child.from, child.to));
      }
      prevEnd = child.to;
      prevCellUnderCursor = cellUnderCursor;
      column++;
    }
    child = child.nextSibling;
  }
  if (node.to > prevEnd && !prevCellUnderCursor) {
    out.push(Decoration.replace({}).range(prevEnd, node.to));
  }
}

/**
 * Decorates an entire `Table` node in one pass: parses per-column alignment
 * from the row-level alignment-delimiter (a direct `TableDelimiter` child),
 * removes that delimiter's line from the render flow entirely, and
 * decorates each `TableHeader`/`TableRow` child. Handled at the `Table`
 * level (rather than per-node in the main switch) so alignment is parsed
 * once and shared across every row, and so the row container stays visible
 * even when the cursor is elsewhere in the same table.
 */
function decorateTable(state: EditorState, node: SyntaxNode, out: Range<Decoration>[]): void {
  const delimiterNode = node.getChild("TableDelimiter");
  const alignment = delimiterNode
    ? parseColumnAlignment(state.doc.sliceString(delimiterNode.from, delimiterNode.to))
    : [];

  let child = node.firstChild;
  while (child) {
    if (child.type.name === "TableHeader") {
      decorateTableRow(state, child, alignment, true, out);
    } else if (child.type.name === "TableRow") {
      decorateTableRow(state, child, alignment, false, out);
    } else if (child.type.name === "TableDelimiter" && child.from === delimiterNode?.from) {
      const line = state.doc.lineAt(child.from);
      out.push(Decoration.line({ class: CLASS.tableDelimiterLine }).range(line.from));
      out.push(Decoration.replace({}).range(child.from, child.to));
    }
    child = child.nextSibling;
  }
}

function decorateTaskMarker(state: EditorState, node: SyntaxNode, out: Range<Decoration>[]): void {
  // `[ ]` / `[x]`: the status character sits at offset 1 of the 3-char marker.
  const statusFrom = node.from + 1;
  const statusTo = node.to - 1;
  const checked = /[xX]/.test(state.doc.sliceString(statusFrom, statusTo));
  out.push(
    Decoration.replace({ widget: new CheckboxWidget(checked, statusFrom, statusTo) }).range(node.from, node.to),
  );
}

/**
 * Builds the full decoration set for the visible viewport. Only nodes
 * intersecting `visibleRanges` are visited — walking the whole document on
 * every keystroke is the main perf risk for large files (plan section 6.1).
 *
 * This is a pure function of `state` and `visibleRanges` (no `EditorView`
 * dependency) precisely so it can be unit-tested directly against fixture
 * markdown strings without a full DOM render.
 */
export function buildDecorations(
  state: EditorState,
  visibleRanges: readonly { from: number; to: number }[],
  documentPath: string,
): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  const tree = syntaxTree(state);

  for (const { from, to } of visibleRanges) {
    tree.iterate({
      from,
      to,
      enter(ref) {
        const name = ref.name;

        if (name === "TaskMarker") {
          // Checkboxes stay interactive even on the active line.
          decorateTaskMarker(state, ref.node, decorations);
          return;
        }

        if (name === "FencedCode" || name === "CodeBlock") {
          // A mermaid-tagged fenced block with the cursor elsewhere is
          // replaced entirely by a diagram widget — built separately by
          // `buildMermaidWidgetDecorations` (a `StateField`, since CodeMirror
          // requires block decorations to come from one), so this only
          // needs to skip its own container/fence decorations for that
          // node; there's nothing to decorate underneath a fully-replaced
          // block. Everything else (non-mermaid blocks, or a mermaid block
          // under the cursor) falls through to the normal fenced-code
          // handling below. The container stays visible even while the
          // cursor is inside the block; only the fence markers/language tag
          // are cursor-gated.
          if (name === "FencedCode" && mermaidWidgetSource(state, ref.node) !== null) {
            return;
          }
          decorateCodeBlock(state, ref.node, name === "FencedCode", decorations);
          return;
        }

        if (name === "Table") {
          // Handled as one unit (see decorateTable) so alignment is parsed
          // once and each row's container stays visible regardless of
          // where the cursor is elsewhere in the same table. Descent
          // continues (bare `return`, not `false`) so inline content nested
          // inside a TableCell — Emphasis, StrongEmphasis, Link, etc. — still
          // reaches the switch below and gets decorated the same way it
          // would inside a paragraph; TableHeader/TableRow/TableCell/
          // TableDelimiter have no case there, so revisiting them is a no-op.
          decorateTable(state, ref.node, decorations);
          return;
        }

        if (name in HEADING_LEVELS) {
          decorateHeading(state, ref.node, HEADING_LEVELS[name], decorations);
          return;
        }

        switch (name) {
          case "Emphasis":
            decorateWrapped(state, ref.node, "EmphasisMark", CLASS.emphasis, decorations);
            break;
          case "StrongEmphasis":
            decorateWrapped(state, ref.node, "EmphasisMark", CLASS.strong, decorations);
            break;
          case "Strikethrough":
            decorateWrapped(state, ref.node, "StrikethroughMark", CLASS.strikethrough, decorations);
            break;
          case "InlineCode":
            decorateWrapped(state, ref.node, "CodeMark", CLASS.inlineCode, decorations);
            break;
          case "Link":
            if (isUnderCursor(state, ref.from, ref.to)) {
              break;
            }
            decorateLink(state, ref.node, documentPath, decorations);
            break;
          case "Image":
            if (isUnderCursor(state, ref.from, ref.to)) {
              break;
            }
            decorateImage(state, ref.node, documentPath, decorations);
            break;
        }
      },
    });
  }

  return Decoration.set(decorations, true);
}

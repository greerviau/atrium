import type { EditorState, Range } from "@codemirror/state";
import { Decoration } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import { CheckboxWidget, ImageWidget } from "./widgets";
import { headingClass, CLASS } from "./theme";

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
  // Hide the `#`+space marker (zero-width); mark the remaining text with a
  // heading-level class controlling font-size/weight.
  const textStart = Math.min(mark.to + 1, node.to);
  out.push(Decoration.replace({}).range(mark.from, textStart));
  if (textStart < node.to) {
    out.push(Decoration.mark({ class: headingClass(level) }).range(textStart, node.to));
  }
}

/**
 * Shared shape for Emphasis/StrongEmphasis/Strikethrough/InlineCode: hide
 * the delimiter runs (found by `markTypeName`), mark the whole node with a
 * CSS class so the inner text gets the style (the hidden marks contribute
 * no visible width, so the class only visually affects the inner text).
 */
function decorateWrapped(node: SyntaxNode, markTypeName: string, cssClass: string, out: Range<Decoration>[]): void {
  out.push(Decoration.mark({ class: cssClass }).range(node.from, node.to));
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

        if (isUnderCursor(state, ref.from, ref.to)) {
          return;
        }

        if (name in HEADING_LEVELS) {
          decorateHeading(state, ref.node, HEADING_LEVELS[name], decorations);
          return;
        }

        switch (name) {
          case "Emphasis":
            decorateWrapped(ref.node, "EmphasisMark", CLASS.emphasis, decorations);
            break;
          case "StrongEmphasis":
            decorateWrapped(ref.node, "EmphasisMark", CLASS.strong, decorations);
            break;
          case "Strikethrough":
            decorateWrapped(ref.node, "StrikethroughMark", CLASS.strikethrough, decorations);
            break;
          case "InlineCode":
            decorateWrapped(ref.node, "CodeMark", CLASS.inlineCode, decorations);
            break;
          case "Link":
            decorateLink(state, ref.node, documentPath, decorations);
            break;
          case "Image":
            decorateImage(state, ref.node, documentPath, decorations);
            break;
          case "TableDelimiter":
            // Only the row-level delimiter (direct child of Table) is the
            // `|---|---|` line; per-cell TableDelimiter nodes nested inside
            // TableHeader/TableRow mark individual `|` separators and are
            // left alone.
            if (ref.node.parent?.type.name === "Table") {
              decorations.push(Decoration.replace({}).range(ref.from, ref.to));
            }
            break;
          case "TableHeader":
            decorations.push(Decoration.mark({ class: CLASS.tableHeader }).range(ref.from, ref.to));
            break;
          case "TableCell":
            decorations.push(Decoration.mark({ class: CLASS.tableCell }).range(ref.from, ref.to));
            break;
        }
      },
    });
  }

  return Decoration.set(decorations, true);
}

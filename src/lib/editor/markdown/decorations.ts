import { countColumn } from "@codemirror/state";
import type { EditorState, Range, RangeSet } from "@codemirror/state";
import { BlockWrapper, Decoration } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import { CheckboxWidget, EmptyCellWidget, ImageWidget, ListBulletWidget, ListMarkerWidget, MermaidWidget } from "./widgets";
import {
  AddColumnBandWidget,
  AddRowBandWidget,
  NO_TABLE_HOVER,
  RowHandleWidget,
  TableColumnBarWidget,
  type TableHoverState,
} from "./tableHandles";
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
 * CommonMark's other heading form — a text line followed by a line of `===`
 * (H1) or `---` (H2) — parses into its own node types, distinct from
 * `HEADING_LEVELS`'s ATX ones. Kept as a separate map (rather than folded
 * into `HEADING_LEVELS`) because the decoration shape genuinely differs: the
 * `HeaderMark` here is the underline on the *following* line, not a leading
 * marker on the same line as the text, so `decorateSetextHeading` needs its
 * own branch rather than reusing `decorateHeading` verbatim.
 */
const SETEXT_HEADING_LEVELS: Record<string, 1 | 2> = {
  SetextHeading1: 1,
  SetextHeading2: 2,
};

/**
 * True if any selection range overlaps the full line(s) spanned by
 * `[from, to)` — per Obsidian-style live preview, a node under the cursor
 * shows its raw markdown source instead of the rendered decoration.
 * Gated on `hasFocus`: an unfocused editor never reveals raw markup,
 * regardless of where the stored selection happens to sit, since there is
 * no "active edit" without focus.
 *
 * Line-granular, which is correct for a paragraph or heading (the line and
 * the thing being edited are the same unit) but wrong for a node that may
 * share its line with another independent markup-bearing construct — a
 * table cell sharing a row with sibling cells, or an inline construct
 * (emphasis, strong, inline code, a link, ...) sharing a paragraph line with
 * sibling constructs — a node in either position should gate through
 * `isRevealTarget` instead, which narrows to the enclosing cell when there
 * is one, otherwise to the node's own span.
 */
function isUnderCursor(state: EditorState, from: number, to: number, hasFocus: boolean): boolean {
  if (!hasFocus) return false;
  const lineFrom = state.doc.lineAt(from).from;
  const lineTo = state.doc.lineAt(to).to;
  return state.selection.ranges.some((r) => r.from <= lineTo && r.to >= lineFrom);
}

/**
 * Walks up from `node` to find its enclosing `TableCell`, if any, stopping
 * at the `Table` boundary. `TableHeader`/`TableRow`'s direct cell children
 * are both named `TableCell` in the syntax tree (already relied on by
 * `collectCellSlots`), so this one walk covers header and body cells alike.
 * Returns `null` for a node outside any table — the walk reaches `Document`
 * without ever finding `Table` or `TableCell`.
 */
function enclosingTableCellRange(node: SyntaxNode): { from: number; to: number } | null {
  let n: SyntaxNode | null = node.parent;
  while (n && n.type.name !== "Table") {
    if (n.type.name === "TableCell") {
      return { from: n.from, to: n.to };
    }
    n = n.parent;
  }
  return null;
}

/**
 * Reveal-gate for an inline construct that may share its physical line with
 * an unrelated sibling construct — a table cell sharing a row with sibling
 * cells, or an inline span (emphasis, strong, inline code, a link, ...)
 * sharing a paragraph line with sibling spans. Narrows to the enclosing
 * table cell's own range when there is one, otherwise to the node's own
 * `[from, to)` range, instead of `isUnderCursor`'s whole-physical-line
 * check — comparing against the whole line would also reveal a sibling
 * cell's or sibling span's markup whenever the cursor sits anywhere else on
 * that shared line.
 */
function isRevealTarget(state: EditorState, node: SyntaxNode, hasFocus: boolean): boolean {
  if (!hasFocus) return false;
  const cell = enclosingTableCellRange(node);
  const range = cell ?? node;
  return state.selection.ranges.some((r) => r.from <= range.to && r.to >= range.from);
}

function decorateHeading(
  state: EditorState,
  node: SyntaxNode,
  level: 1 | 2 | 3 | 4 | 5 | 6,
  out: Range<Decoration>[],
  hasFocus: boolean,
): void {
  const mark = node.getChild("HeaderMark");
  if (!mark) {
    return;
  }
  // With the cursor on this line, keep the heading styled but reveal the
  // marker instead of hiding it (matches the fenced-code/table precedent:
  // container stays visible, only markup-hiding is cursor-gated).
  if (isUnderCursor(state, node.from, node.to, hasFocus)) {
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
 * Decorates a `SetextHeading1`/`SetextHeading2` node: unlike an ATX heading,
 * the `HeaderMark` is the underline on the line *after* the text, not a
 * leading marker on the text's own line. With the cursor elsewhere, the
 * underline's whole physical line is hidden entirely (mirroring the
 * alignment-delimiter-row treatment in `decorateTable`, via
 * `CLASS.setextUnderline`'s `display: none`) and the heading class is
 * applied across the text portion — everything from the node's start up to
 * the end of the line just before the underline, which also covers the rare
 * case of a setext heading whose text spans more than one line. With the
 * cursor on the node (text or underline), both lines stay fully raw, styled
 * as one unit exactly like `decorateHeading`'s reveal branch.
 */
function decorateSetextHeading(
  state: EditorState,
  node: SyntaxNode,
  level: 1 | 2,
  out: Range<Decoration>[],
  hasFocus: boolean,
): void {
  const mark = node.getChild("HeaderMark");
  if (!mark) {
    return;
  }
  if (isUnderCursor(state, node.from, node.to, hasFocus)) {
    out.push(Decoration.mark({ class: headingClass(level) }).range(node.from, node.to));
    return;
  }
  const underlineLine = state.doc.lineAt(mark.from);
  const textEnd = state.doc.line(underlineLine.number - 1).to;
  out.push(Decoration.mark({ class: headingClass(level) }).range(node.from, textEnd));
  out.push(Decoration.line({ class: CLASS.setextUnderline }).range(underlineLine.from));
  out.push(Decoration.replace({}).range(underlineLine.from, underlineLine.to));
}

/**
 * Shared shape for Emphasis/StrongEmphasis/Strikethrough/InlineCode: the
 * whole node always gets a CSS class so the inner text gets the style; the
 * delimiter runs (found by `markTypeName`) are hidden unless the node is a
 * reveal target (matches the fenced-code/table precedent), in which case
 * they're left visible inside the still-styled span. Gated through
 * `isRevealTarget` rather than `isUnderCursor` directly, since this node's
 * own span — not its whole physical line — is what should be compared
 * against the cursor: a paragraph line commonly holds several independent
 * inline constructs, and (as for a table cell sharing a row with sibling
 * cells) the cursor sitting in a sibling construct on the same line
 * shouldn't also reveal this one's delimiters.
 */
function decorateWrapped(
  state: EditorState,
  node: SyntaxNode,
  markTypeName: string,
  cssClass: string,
  out: Range<Decoration>[],
  hasFocus: boolean,
): void {
  out.push(Decoration.mark({ class: cssClass }).range(node.from, node.to));
  if (isRevealTarget(state, node, hasFocus)) {
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

/**
 * An `Escape` node always spans exactly 2 characters: the backslash at
 * `node.from` and the escaped punctuation character at `node.from + 1`
 * (`@lezer/markdown`'s inline parser emits this for any backslash followed
 * by CommonMark-escapable punctuation, table cells included, since GFM
 * table cells get full standard inline parsing). Hiding just the backslash
 * leaves the escaped character to render as plain text, matching GFM's
 * escaping rule. Gated through `isRevealTarget` for the same node-span-scoped
 * reveal behavior as `decorateWrapped`.
 */
function decorateEscape(state: EditorState, node: SyntaxNode, out: Range<Decoration>[], hasFocus: boolean): void {
  if (isRevealTarget(state, node, hasFocus)) {
    return;
  }
  out.push(Decoration.replace({}).range(node.from, node.from + 1));
}

/**
 * A resolved reference-style definition: `[ref]: <url> "title"`. `title` is
 * carried for completeness even though nothing currently surfaces it in the
 * UI (see `resolveReferenceUrl`'s docstring).
 */
interface ReferenceDefinition {
  url: string;
  title?: string;
}

/**
 * Normalizes a reference label per CommonMark's reference-matching rule —
 * case-fold and collapse runs of internal whitespace to a single space —
 * so `[My Ref]`, `[my  ref]`, and `[MY REF]` all key the same map entry.
 */
function normalizeReferenceLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Strips the first and last character off `raw`. Shared by two unrelated
 * uses: a `LinkTitle` node's surrounding quote/paren delimiters (`"..."`,
 * `'...'`, `(...)`) and a `LinkLabel` node's surrounding `[...]` brackets —
 * both are "one delimiter character on each end" in the same way.
 */
function stripOuterDelimiters(raw: string): string {
  if (raw.length >= 2) {
    return raw.slice(1, -1);
  }
  return raw;
}

/**
 * Collects every `[label]: url "title"` reference definition in the
 * document into a label → definition map, keyed by `normalizeReferenceLabel`.
 * Reference definitions can appear anywhere in the document, including below
 * the paragraph that cites them, so this is a single upfront pass over the
 * whole `syntaxTree` (not scoped to `visibleRanges`) rather than something
 * folded into the viewport-scoped walk in `buildDecorations`.
 *
 * Per CommonMark, when multiple definitions share the same normalized label
 * the first one in document order wins — so a label already in the map is
 * never overwritten by a later duplicate.
 *
 * `LinkReference` is a block-level construct that can never appear nested
 * inside inline content (`Paragraph`, `Emphasis`, `Link`, table cells, ...),
 * only inside other block containers — so descent is pruned to
 * `BLOCK_CONTAINER_NODES` (shared with `buildMermaidWidgetDecorations`,
 * which prunes for the same reason), keeping this pass proportional to
 * block/line count rather than total node count on every keystroke.
 */
function collectLinkReferences(state: EditorState): Map<string, ReferenceDefinition> {
  const refs = new Map<string, ReferenceDefinition>();
  syntaxTree(state).iterate({
    enter(ref) {
      if (ref.name === "LinkReference") {
        const labelNode = ref.node.getChild("LinkLabel");
        const urlNode = ref.node.getChild("URL");
        if (labelNode && urlNode) {
          const rawLabel = state.doc.sliceString(labelNode.from, labelNode.to);
          const key = normalizeReferenceLabel(stripOuterDelimiters(rawLabel));
          if (!refs.has(key)) {
            const titleNode = ref.node.getChild("LinkTitle");
            const url = state.doc.sliceString(urlNode.from, urlNode.to);
            const title = titleNode ? stripOuterDelimiters(state.doc.sliceString(titleNode.from, titleNode.to)) : undefined;
            refs.set(key, { url, title });
          }
        }
        return false;
      }
      if (ref.name !== "Document" && !BLOCK_CONTAINER_NODES.has(ref.name)) {
        return false;
      }
    },
  });
  return refs;
}

/**
 * Extracts a `Link`/`Image` node's own reference label — the raw text used
 * to look it up in the map `collectLinkReferences` built — covering all
 * three CommonMark reference forms:
 * - Full: `[text][label]` — label is the `LinkLabel` child's text.
 * - Collapsed: `[label][]` — `LinkLabel` child is present but empty, so the
 *   label is the link's own text instead.
 * - Shortcut: `[label]` — no second bracket group at all, so the label is
 *   the link's own text.
 *
 * Returns `null` when `node` doesn't have the two `LinkMark` children every
 * form requires (shouldn't happen for a real `Link`/`Image` node, but keeps
 * this total).
 */
function referenceLabelFor(state: EditorState, node: SyntaxNode): string | null {
  const marks = node.getChildren("LinkMark");
  if (marks.length < 2) {
    return null;
  }
  const linkLabelNode = node.getChild("LinkLabel");
  if (linkLabelNode) {
    const inner = stripOuterDelimiters(state.doc.sliceString(linkLabelNode.from, linkLabelNode.to));
    if (inner.length > 0) {
      return inner;
    }
  }
  return state.doc.sliceString(marks[0].to, marks[1].from);
}

/**
 * Resolves a reference-style `Link`/`Image` node (one with no `URL` child of
 * its own) against the definitions `collectLinkReferences` gathered.
 * Returns `undefined` for a dangling reference — a label with no matching
 * definition anywhere in the document, which is a real authoring error left
 * unchanged by this resolver (see `decorateLink`/`decorateImage`).
 *
 * `title` is returned for completeness but not currently wired into the UI
 * anywhere (nothing surfaces a link/image title today), so callers are free
 * to ignore it.
 */
function resolveReferenceUrl(
  state: EditorState,
  node: SyntaxNode,
  refs: Map<string, ReferenceDefinition>,
): ReferenceDefinition | undefined {
  const label = referenceLabelFor(state, node);
  if (label === null) {
    return undefined;
  }
  return refs.get(normalizeReferenceLabel(label));
}

/**
 * Footnotes aren't part of CommonMark/GFM and `@lezer/markdown` has no
 * footnote extension, so `[^1]` always parses as an ordinary
 * shortcut-reference `Link` node. When it doesn't resolve against a real
 * `LinkReference` definition (the common case — a footnote *definition*
 * line's body, e.g. `This is the footnote text.`, isn't a valid link
 * destination, so it never registers one), rendering it as a styled,
 * clickable-looking link with an empty `data-href` is actively misleading:
 * it looks exactly like a working link but does nothing on click. A `^`-
 * prefixed label that *does* resolve (e.g. `[^1]: https://example.com`, a
 * definition whose body happens to be a valid URL) is not this case and
 * renders as a normal working link, untouched.
 */
function decorateLink(
  state: EditorState,
  node: SyntaxNode,
  documentPath: string,
  refs: Map<string, ReferenceDefinition>,
  out: Range<Decoration>[],
): void {
  const marks = node.getChildren("LinkMark");
  if (marks.length < 2) {
    return;
  }
  const openMark = marks[0];
  const closeTextMark = marks[1];
  const urlNode = node.getChild("URL");

  let url: string;
  if (urlNode) {
    url = state.doc.sliceString(urlNode.from, urlNode.to);
  } else {
    const resolved = resolveReferenceUrl(state, node, refs);
    if (!resolved) {
      const label = referenceLabelFor(state, node);
      if (label !== null && label.startsWith("^")) {
        return;
      }
    }
    url = resolved?.url ?? "";
  }

  out.push(Decoration.replace({}).range(openMark.from, openMark.to));
  out.push(Decoration.replace({}).range(closeTextMark.from, node.to));
  out.push(
    Decoration.mark({
      class: CLASS.link,
      attributes: { "data-href": url, "data-document-path": documentPath },
    }).range(openMark.to, closeTextMark.from),
  );
}

/**
 * Decorates `<https://example.com>`-style autolinks: mirrors `decorateLink`'s
 * shape (hide the `<`/`>` `LinkMark`s, style the URL text between them as a
 * working link), but always has a real `URL` child of its own — no reference
 * resolution involved.
 */
function decorateAutolink(state: EditorState, node: SyntaxNode, documentPath: string, out: Range<Decoration>[]): void {
  const marks = node.getChildren("LinkMark");
  const urlNode = node.getChild("URL");
  if (marks.length < 2 || !urlNode) {
    return;
  }
  const openMark = marks[0];
  const closeMark = marks[1];
  const url = state.doc.sliceString(urlNode.from, urlNode.to);
  out.push(Decoration.replace({}).range(openMark.from, openMark.to));
  out.push(Decoration.replace({}).range(closeMark.from, closeMark.to));
  out.push(
    Decoration.mark({
      class: CLASS.link,
      attributes: { "data-href": url, "data-document-path": documentPath },
    }).range(openMark.to, closeMark.from),
  );
}

/**
 * Decorates a bare GFM autolink (`https://example.com/path`, no angle
 * brackets) — a standalone `URL` node with no marks to hide, so the text
 * itself just gets styled and made clickable in place. The caller is
 * responsible for excluding a `Link`/`Image`/`Autolink` node's own `URL`
 * child (see the `URL` switch case in `buildDecorations`), since that child
 * is visited independently by `tree.iterate` and is already decorated by
 * its parent.
 */
function decorateBareUrl(state: EditorState, node: SyntaxNode, documentPath: string, out: Range<Decoration>[]): void {
  const url = state.doc.sliceString(node.from, node.to);
  out.push(
    Decoration.mark({
      class: CLASS.link,
      attributes: { "data-href": url, "data-document-path": documentPath },
    }).range(node.from, node.to),
  );
}

function decorateImage(
  state: EditorState,
  node: SyntaxNode,
  documentPath: string,
  refs: Map<string, ReferenceDefinition>,
  out: Range<Decoration>[],
): void {
  const marks = node.getChildren("LinkMark");
  if (marks.length < 2) {
    return;
  }
  const urlNode = node.getChild("URL");
  const url = urlNode ? state.doc.sliceString(urlNode.from, urlNode.to) : resolveReferenceUrl(state, node, refs)?.url;
  if (url === undefined) {
    return;
  }
  const alt = state.doc.sliceString(marks[0].to, marks[1].from);
  out.push(
    Decoration.replace({ widget: new ImageWidget(url, alt, documentPath, node.from) }).range(node.from, node.to),
  );
}

function decorateCodeBlock(
  state: EditorState,
  node: SyntaxNode,
  isFenced: boolean,
  out: Range<Decoration>[],
  hasFocus: boolean,
): void {
  const startLine = state.doc.lineAt(node.from).number;
  const endLine = state.doc.lineAt(node.to).number;
  const hideMarkers = isFenced && !isUnderCursor(state, node.from, node.to, hasFocus);

  const marks = node.getChildren("CodeMark");
  const info = node.getChild("CodeInfo");
  const openMark = marks[0];
  const closeMark = marks[marks.length - 1];
  // While markers are hidden, the fence/language-tag line(s) they belong to
  // are fully `Decoration.replace`d and render nothing, so they must not
  // count toward the block's width.
  const openMarkLine = hideMarkers && openMark ? state.doc.lineAt(openMark.from).number : -1;
  const closeMarkLine =
    hideMarkers && closeMark && closeMark !== openMark ? state.doc.lineAt(closeMark.from).number : -1;

  // `countColumn` walks the line the same way CodeMirror's own rendering
  // does: a tab advances to the next multiple of `state.tabSize` columns
  // instead of counting as a single character, so a tab-indented line's
  // `ch`-based width matches where its text actually reaches on screen
  // (`.cm-content`'s `tab-size` CSS property is set from this same facet).
  let maxColumns = 0;
  for (let n = startLine; n <= endLine; n++) {
    if (n === openMarkLine || n === closeMarkLine) {
      continue;
    }
    maxColumns = Math.max(maxColumns, countColumn(state.doc.line(n).text, state.tabSize));
  }

  for (let n = startLine; n <= endLine; n++) {
    out.push(
      Decoration.line({
        class: CLASS.codeBlock,
        attributes: { style: `width: ${maxColumns}ch` },
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
 * Decorates a `Blockquote` node's full line span with `cm-blockquote`,
 * modeled on `decorateCodeBlock`'s line-span loop. Computed from the node's
 * own `[from, to)` range rather than from `QuoteMark` positions, because a
 * lazy-continuation line (no marker of its own, see `decorateQuoteMark`'s
 * docstring) is still part of the block and still needs its left
 * border/indent.
 */
function decorateBlockquote(state: EditorState, node: SyntaxNode, out: Range<Decoration>[]): void {
  const startLine = state.doc.lineAt(node.from).number;
  const endLine = state.doc.lineAt(node.to).number;
  for (let n = startLine; n <= endLine; n++) {
    out.push(Decoration.line({ class: CLASS.blockquote }).range(state.doc.line(n).from));
  }
}

/**
 * Decorates a `HorizontalRule` node (`---`, `***`, `___` on their own line):
 * always a single physical line. The line always gets `CLASS.horizontalRule`
 * (a `border-top` rule, same container-stays-visible precedent as
 * `decorateCodeBlock`/`decorateBlockquote`), and the raw dash/asterisk text
 * is hidden unless the cursor is on that line, in which case it's left
 * visible so it can be edited.
 */
function decorateHorizontalRule(state: EditorState, node: SyntaxNode, out: Range<Decoration>[], hasFocus: boolean): void {
  const line = state.doc.lineAt(node.from);
  out.push(Decoration.line({ class: CLASS.horizontalRule }).range(line.from));
  if (isUnderCursor(state, node.from, node.to, hasFocus)) {
    return;
  }
  out.push(Decoration.replace({}).range(node.from, node.to));
}

/**
 * The three node types `decorateTableRow`/`decorateTable` treat as owning
 * an entire physical line's leading span: `TableHeader`/`TableRow` (a data
 * row, via `decorateTableRow`'s gap) and `TableDelimiter` (the alignment
 * row, via `decorateTable`'s own line-replace). Any of the three starting
 * on a given physical line means that line's leading span — including a
 * preceding `>` marker or list indent, at any nesting depth — is already
 * spoken for.
 */
const TABLE_ROW_NODE_NAMES = new Set(["TableHeader", "TableRow", "TableDelimiter"]);

/**
 * True when physical line `lineNumber` is the start of a table row or the
 * table's own alignment-delimiter row — i.e. a line `decorateTableRow`'s
 * leading gap (or `decorateTable`'s delimiter-line replace) already fully
 * owns from the line's start. Resolves into the tree at the line's own end
 * (innermost node first) and walks up, rather than walking down from a
 * known ancestor, because for a leading `>` marker the table node is a
 * later sibling in the tree, not a descendant or ancestor of the marker.
 */
function lineOwnedByTableRow(state: EditorState, lineNumber: number): boolean {
  const line = state.doc.line(lineNumber);
  let n: SyntaxNode | null = syntaxTree(state).resolveInner(line.to, -1);
  while (n) {
    if (TABLE_ROW_NODE_NAMES.has(n.type.name) && state.doc.lineAt(n.from).number === lineNumber) {
      return true;
    }
    n = n.parent;
  }
  return false;
}

/**
 * Hides one blockquote `>` marker (plus its optional following space —
 * unlike an ATX heading's `#`, the grammar doesn't require a space after
 * `>`, so it's only consumed when actually present), gated per-line through
 * `isUnderCursor` rather than per-node: a `QuoteMark` is always exactly one
 * character on exactly one line, so gating each one individually already
 * produces the right per-line granularity for a blockquote spanning many
 * lines, without the fenced-code precedent's "reveal the whole block" being
 * a much bigger disruption here.
 *
 * Skips itself whenever `lineOwnedByTableRow` says this marker's physical
 * line is already owned by a table row's own leading span — a second,
 * independent replace decoration here would overlap it. This holds
 * regardless of blockquote nesting depth: a marker on a table-owned line is
 * always inside that line's leading span, whether it's the sole marker or
 * one of several nested `>` markers preceding the row.
 */
function decorateQuoteMark(state: EditorState, node: SyntaxNode, out: Range<Decoration>[], hasFocus: boolean): void {
  if (lineOwnedByTableRow(state, state.doc.lineAt(node.from).number)) {
    return;
  }
  if (isUnderCursor(state, node.from, node.to, hasFocus)) {
    return;
  }
  const hasTrailingSpace = state.doc.sliceString(node.to, node.to + 1) === " ";
  const hideTo = hasTrailingSpace ? node.to + 1 : node.to;
  out.push(Decoration.replace({}).range(node.from, hideTo));
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
function mermaidWidgetSource(state: EditorState, node: SyntaxNode, hasFocus: boolean): string | null {
  const source = extractMermaidSource(state, node);
  if (source === null || isUnderCursor(state, node.from, node.to, hasFocus)) {
    return null;
  }
  return source;
}

/**
 * Node names a block-level construct can be nested under (besides the
 * document root) — every markdown block container that can hold a fenced
 * code block or a `LinkReference` definition as a descendant. Pruning
 * descent to just these keeps a whole-document walk proportional to
 * block/line count rather than total node count, since it never descends
 * into inline content (`Paragraph`, `Emphasis`, ...) at all. Shared by
 * `buildMermaidWidgetDecorations` (pruning its ` ```mermaid ` search) and
 * `collectLinkReferences` (pruning its `LinkReference` search), since both
 * walks have the same shape of problem.
 */
const BLOCK_CONTAINER_NODES = new Set(["Blockquote", "BulletList", "OrderedList", "ListItem"]);

/**
 * Builds block-replace `MermaidWidget` decorations for every ` ```mermaid `
 * block in the document with the cursor elsewhere. Walks the whole
 * document (not viewport-limited like `buildDecorations`) because a
 * `StateField`, which is what this feeds, has no notion of the current
 * viewport — but descent is pruned to markdown block containers
 * (`BLOCK_CONTAINER_NODES`) plus `FencedCode` itself, so realistic
 * documents (far more inline content than fenced blocks) stay cheap.
 */
export function buildMermaidWidgetDecorations(state: EditorState, hasFocus: boolean): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  syntaxTree(state).iterate({
    enter(ref) {
      if (ref.name === "FencedCode") {
        const source = mermaidWidgetSource(state, ref.node, hasFocus);
        if (source !== null) {
          decorations.push(
            Decoration.replace({ widget: new MermaidWidget(source, ref.from), block: true }).range(ref.from, ref.to),
          );
        }
        return false;
      }
      if (ref.name !== "Document" && !BLOCK_CONTAINER_NODES.has(ref.name)) {
        return false;
      }
    },
  });
  return Decoration.set(decorations, true);
}

export type ColumnAlignment = "left" | "center" | "right";

/**
 * Parses a GFM alignment-delimiter row's raw text (e.g. `"| :--- | :---: | ---: |"`)
 * into one alignment per column, by GFM's own rule: `:` on both ends is
 * `center`, on the trailing end only is `right`, otherwise `left`.
 */
export function parseColumnAlignment(text: string): ColumnAlignment[] {
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
 * One column's cell region within a row: either a real `TableCell` node's
 * range, or (for an empty cell) a synthesized range for the whitespace, if
 * any, between the two `TableDelimiter` pipes that bound it — the parser
 * gives an empty cell no `TableCell` node at all, so nothing else marks
 * where it sits.
 */
export interface CellSlot {
  from: number;
  to: number;
}

/**
 * Walks a table row's direct children (always some mix of `TableDelimiter`
 * and `TableCell` — a `TableCell`'s own nested content, e.g. `Emphasis`,
 * isn't a direct child of the row) and returns one `CellSlot` per column, in
 * order, real cells and synthesized empty ones alike. Two `TableDelimiter`
 * siblings with no `TableCell` between them mark an empty column; the slot
 * synthesized for it spans whatever sits between the two pipes (nothing,
 * for `||` with no space at all).
 */
export function collectCellSlots(node: SyntaxNode): CellSlot[] {
  const slots: CellSlot[] = [];
  let lastDelimiterEnd: number | null = null;
  let child = node.firstChild;
  while (child) {
    if (child.type.name === "TableCell") {
      slots.push({ from: child.from, to: child.to });
      lastDelimiterEnd = null;
    } else if (child.type.name === "TableDelimiter") {
      if (lastDelimiterEnd !== null) {
        slots.push({ from: lastDelimiterEnd, to: child.from });
      }
      lastDelimiterEnd = child.to;
    }
    child = child.nextSibling;
  }
  return slots;
}

/**
 * Decorates one table row (`TableHeader` or `TableRow`, always a single
 * physical line). The row gets an always-visible `Decoration.line`
 * container (`display: table-row`, matching the code-block precedent), and
 * every column — including an empty one, via the synthesized slot
 * `collectCellSlots` produces for it — always gets a real, classed
 * `.cm-table-cell` box regardless of cursor position, so a cell's
 * `display: table-cell` styling never drops out from under it and every
 * column occupies a real slot in the row. A slot with real content
 * (`slot.to > slot.from`) gets an ordinary `Decoration.mark`; a genuinely
 * empty slot (two adjacent pipes with nothing between them) gets an
 * `EmptyCellWidget` instead, since `@codemirror/view` rejects a zero-width
 * `Decoration.mark` outright.
 *
 * The gap between columns (each `|` plus its surrounding alignment
 * whitespace) is always replaced away — never cursor-gated. Revealing it
 * would put bare inline text inside a `display: table-row` line, which the
 * browser wraps in its own anonymous table-cell and, since column widths
 * are computed jointly across every row sharing the table, widens every
 * row's shared column grid. Every gap decoration here is tagged
 * `tableGap: true`; `livePreviewPlugin.ts` registers an
 * `EditorView.atomicRanges` provider over exactly those tagged ranges, so
 * the cursor skips past a gap in one motion instead of the old behavior of
 * revealing it to land inside — the reason a gap was ever cursor-gated in
 * the first place. Gaps are computed between `CellSlot`s (never swallowing
 * one) rather than between raw `TableCell` nodes, precisely so an empty
 * column's slot can't be merged into its neighboring gap: doing so would
 * make an empty cell both unreachable by cursor motion (atomic ranges skip
 * over it) and unfillable (a `Decoration.replace` range displaces any
 * insertion made inside it to the range's far end).
 *
 * The gap computation starts from the physical line's own start
 * (`state.doc.lineAt(node.from).from`), not `node.from` itself, because the
 * row's container decoration above is applied to the whole physical line.
 * For a top-level table `node.from` already equals the line's start, so
 * this is a no-op there; for a row nested inside a blockquote or list item,
 * the row node starts partway through the line (after the `>` marker or
 * list indentation), and starting the gap from the line's start instead
 * folds that leading container marker into the same leading `tableGap`
 * replace decoration as the row's own leading pipe/whitespace — otherwise
 * it would be left as bare, undecorated text inside a `display: table-row`
 * line, which the browser folds into its own anonymous leading column.
 */
function decorateTableRow(
  state: EditorState,
  node: SyntaxNode,
  alignment: ColumnAlignment[],
  isHeader: boolean,
  tableFrom: number,
  rowIndex: number,
  hover: TableHoverState,
  out: Range<Decoration>[],
): void {
  const rowClass = isHeader ? `${CLASS.tableRow} ${CLASS.tableHeaderRow}` : CLASS.tableRow;
  out.push(Decoration.line({ class: rowClass }).range(state.doc.lineAt(node.from).from));

  const rowSelected = hover.table === tableFrom && hover.row === rowIndex;

  let prevEnd = state.doc.lineAt(node.from).from;
  let column = 0;
  for (const slot of collectCellSlots(node)) {
    if (slot.from > prevEnd) {
      out.push(Decoration.replace({ tableGap: true }).range(prevEnd, slot.from));
    }
    const classes: string[] = [CLASS.tableCell];
    if (isHeader) {
      classes.push(CLASS.tableHeaderCell);
    }
    if (alignment[column] === "center") {
      classes.push(CLASS.tableAlignCenter);
    } else if (alignment[column] === "right") {
      classes.push(CLASS.tableAlignRight);
    }
    if (rowSelected) {
      classes.push(CLASS.tableRowSelected);
    }
    if (hover.table === tableFrom && hover.col === column) {
      classes.push(CLASS.tableColSelected);
    }
    if (slot.to > slot.from) {
      out.push(Decoration.mark({ class: classes.join(" ") }).range(slot.from, slot.to));
    } else {
      out.push(Decoration.widget({ widget: new EmptyCellWidget(classes.join(" ")), side: 0 }).range(slot.from));
    }
    prevEnd = slot.to;
    column++;
  }
  if (node.to > prevEnd) {
    out.push(Decoration.replace({ tableGap: true }).range(prevEnd, node.to));
  }
}

/**
 * Row-handle widgets use `side: -1000` so they always sort before every
 * column-bar widget anchored at the same header-row position; column bars
 * use their own column index (0, 1, 2, ...) so their left-to-right DOM
 * order always matches column order — `tableColumnBarMeasurePlugin`'s write
 * phase relies on that order to match each bar to its header cell (see its
 * own doc comment in tableHandles.ts). The add-row/add-column bands sort
 * last; their own relative DOM order doesn't matter since neither is
 * matched positionally the way the column bars are.
 */
const ROW_HANDLE_SIDE = -1000;
const ADD_ROW_BAND_SIDE = 9000;
const ADD_COLUMN_BAND_SIDE = 9001;

/**
 * Decorates an entire `Table` node in one pass: parses per-column alignment
 * from the row-level alignment-delimiter (a direct `TableDelimiter` child),
 * removes that delimiter's line from the render flow entirely, and
 * decorates each `TableHeader`/`TableRow` child. Handled at the `Table`
 * level (rather than per-node in the main switch) so alignment is parsed
 * once and shared across every row, and so the row container stays visible
 * even when the cursor is elsewhere in the same table.
 *
 * Also emits phase 2's geometry widgets — a `RowHandleWidget` at every
 * row's own line start, and (at the header row's line start specifically,
 * alongside its own row handle) one `TableColumnBarWidget` per column plus
 * the add-row/add-column band widgets. All anchored to a physical
 * line-start position rather than any cell's own document range, matching
 * `decorateTableRow`'s existing leading-`tableGap` anchor, so nested
 * blockquote/list handling doesn't need a second special case. `node.from`
 * is used as the table's own identity key (`tableFrom`) — stable for the
 * table's lifetime within one decoration pass, and the same value
 * `tableHoverField` keys hover/selection state on.
 */
function decorateTable(state: EditorState, node: SyntaxNode, hover: TableHoverState, out: Range<Decoration>[]): void {
  const delimiterNode = node.getChild("TableDelimiter");
  const alignment = delimiterNode
    ? parseColumnAlignment(state.doc.sliceString(delimiterNode.from, delimiterNode.to))
    : [];
  const tableFrom = node.from;

  let rowIndex = 0;
  let child = node.firstChild;
  while (child) {
    if (child.type.name === "TableHeader") {
      decorateTableRow(state, child, alignment, true, tableFrom, rowIndex, hover, out);
      const headerLineStart = state.doc.lineAt(child.from).from;
      out.push(
        Decoration.widget({ widget: new RowHandleWidget(tableFrom, rowIndex), side: ROW_HANDLE_SIDE }).range(
          headerLineStart,
        ),
      );
      for (let column = 0; column < alignment.length; column++) {
        out.push(
          Decoration.widget({ widget: new TableColumnBarWidget(tableFrom, column), side: column }).range(
            headerLineStart,
          ),
        );
      }
      out.push(
        Decoration.widget({ widget: new AddRowBandWidget(tableFrom), side: ADD_ROW_BAND_SIDE }).range(headerLineStart),
      );
      out.push(
        Decoration.widget({ widget: new AddColumnBandWidget(tableFrom), side: ADD_COLUMN_BAND_SIDE }).range(
          headerLineStart,
        ),
      );
      rowIndex++;
    } else if (child.type.name === "TableRow") {
      decorateTableRow(state, child, alignment, false, tableFrom, rowIndex, hover, out);
      const rowLineStart = state.doc.lineAt(child.from).from;
      out.push(
        Decoration.widget({ widget: new RowHandleWidget(tableFrom, rowIndex), side: ROW_HANDLE_SIDE }).range(
          rowLineStart,
        ),
      );
      rowIndex++;
    } else if (child.type.name === "TableDelimiter" && child.from === delimiterNode?.from) {
      const line = state.doc.lineAt(child.from);
      out.push(Decoration.line({ class: CLASS.tableDelimiterLine }).range(line.from));
      out.push(Decoration.replace({}).range(child.from, child.to));
    }
    child = child.nextSibling;
  }
}

/**
 * Builds one `BlockWrapper` per `Table` node in the whole document — a real
 * `<div class="cm-table-box">` DOM parent of that table's own line rows
 * (`EditorView.blockWrappers`, added in `@codemirror/view` 6.39.0). This is
 * the anchor both the width cap (`max-width: 100cqw` in `markdown.css`) and
 * everything phase 2 draws outside the table's own border rely on.
 *
 * Built from each `Table` node's own `from`/`to` — not `view.visibleRanges`
 * like `buildDecorations` — since a `BlockWrapper`'s range describes DOM
 * structure that should exist for the table as a whole, not just its
 * currently-rendered slice; the practical effect is that a table's rendered
 * column widths still only reflect whichever of its rows CodeMirror has
 * actually built `.cm-line` elements for (pre-existing behavior of the
 * underlying `display: table` auto-layout, not something this changes).
 *
 * Walks the whole document, pruned to `BLOCK_CONTAINER_NODES` the same way
 * `buildMermaidWidgetDecorations`/`collectLinkReferences` are, so a table
 * nested inside a blockquote or list still gets a correctly-anchored
 * wrapper without descending into unrelated inline content.
 */
export function buildTableWrapRanges(state: EditorState): RangeSet<BlockWrapper> {
  const wrappers: Range<BlockWrapper>[] = [];
  syntaxTree(state).iterate({
    enter(ref) {
      if (ref.name === "Table") {
        wrappers.push(BlockWrapper.create({ tagName: "div", attributes: { class: CLASS.tableBox } }).range(ref.from, ref.to));
        return false;
      }
      if (ref.name !== "Document" && !BLOCK_CONTAINER_NODES.has(ref.name)) {
        return false;
      }
    },
  });
  return BlockWrapper.set(wrappers, true);
}

/**
 * Decorates an unordered list item's `ListMark` (`-`/`*`/`+`) with a
 * `ListBulletWidget` — a fixed CSS-generated bullet, since every marker
 * renders the same glyph regardless of position, unlike an ordered marker's
 * computed number. Skips itself (no decoration at all, raw marker left as
 * is) in two cases: the marker's `ListItem` belongs to an `OrderedList`
 * (handled entirely by `decorateOrderedList` instead — pushing both would
 * double-decorate the same range), or the `ListItem` is a task item (its
 * `Task`/`TaskMarker` child already renders a checkbox via
 * `decorateTaskMarker`, and layering a bullet in front of it would regress
 * that already-correct rendering).
 */
function decorateListMark(state: EditorState, node: SyntaxNode, out: Range<Decoration>[], hasFocus: boolean): void {
  const listItem = node.parent;
  if (!listItem) {
    return;
  }
  if (listItem.parent?.type.name === "OrderedList") {
    return;
  }
  if (listItem.getChild("Task")) {
    return;
  }
  if (isUnderCursor(state, node.from, node.to, hasFocus)) {
    return;
  }
  out.push(Decoration.replace({ widget: new ListBulletWidget() }).range(node.from, node.to));
}

/**
 * Decorates every direct `ListItem` child of an `OrderedList` node with its
 * CommonMark-correct rendered number — `start + index`, not the digits
 * literally typed on that item's own line, since CommonMark renumbers every
 * item after the first regardless of what's typed (`1. one` / `1. two` still
 * renders `1.`/`2.`). `start` and the delimiter character (`.` or `)`) are
 * parsed once from the *first* item's own `ListMark` text and reused for
 * every item, since CodeMirror's flat per-line DOM (no real nesting) makes a
 * pure-CSS `counter-*` approach produce wrong numbers across nesting depths
 * (see the plan this implements, gap 5, for the two verified reasons a
 * per-item `ListMarkerWidget` is required instead of CSS).
 *
 * `index` advances for every direct `ListItem`, task items included — a task
 * item still counts toward its own and every later sibling's number, per
 * CommonMark's numbering rule — but the decoration itself (and the cursor
 * reveal check) is skipped for a task item or a revealed item, mirroring
 * `decorateListMark`'s same two skip conditions.
 */
function decorateOrderedList(state: EditorState, node: SyntaxNode, out: Range<Decoration>[], hasFocus: boolean): void {
  const items: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.type.name === "ListItem") {
      items.push(child);
    }
  }
  if (items.length === 0) {
    return;
  }
  const firstMark = items[0].getChild("ListMark");
  if (!firstMark) {
    return;
  }
  const match = /^(\d+)([.)])/.exec(state.doc.sliceString(firstMark.from, firstMark.to));
  if (!match) {
    return;
  }
  const start = parseInt(match[1], 10);
  const delimiter = match[2];

  items.forEach((item, index) => {
    const mark = item.getChild("ListMark");
    if (!mark || item.getChild("Task")) {
      return;
    }
    if (isUnderCursor(state, mark.from, mark.to, hasFocus)) {
      return;
    }
    out.push(
      Decoration.replace({ widget: new ListMarkerWidget(start + index, delimiter) }).range(mark.from, mark.to),
    );
  });
}

/**
 * Decorates raw HTML (`HTMLBlock`/`HTMLTag`) with a muted style, matching
 * the existing inline-code treatment: the tags stay visible as literal
 * text, just visually marked as "recognized but not rendered" rather than
 * looking like broken plain prose. Deliberately never hides, alters, or
 * executes the markup — actually rendering it (`innerHTML` or similar) would
 * run arbitrary script/markup from whatever file is opened (see the plan
 * this implements, gap 6, for the settled decision).
 */
function decorateRawHtml(node: SyntaxNode, out: Range<Decoration>[]): void {
  out.push(Decoration.mark({ class: CLASS.rawHtml }).range(node.from, node.to));
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
  hasFocus: boolean,
  hover: TableHoverState = NO_TABLE_HOVER,
): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  const tree = syntaxTree(state);
  const refs = collectLinkReferences(state);

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
          if (name === "FencedCode" && mermaidWidgetSource(state, ref.node, hasFocus) !== null) {
            return;
          }
          decorateCodeBlock(state, ref.node, name === "FencedCode", decorations, hasFocus);
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
          decorateTable(state, ref.node, hover, decorations);
          return;
        }

        if (name === "Blockquote") {
          // Bare `return` (not `false`) so descent continues into nested
          // content — paragraphs, lists, tables, nested blockquotes all
          // still need their own decoration, same reasoning as Table above.
          decorateBlockquote(state, ref.node, decorations);
          return;
        }

        if (name === "OrderedList") {
          // Handled as one unit (see decorateOrderedList) so the list's
          // start value and delimiter are parsed once and every item's
          // rendered number reflects its position, not its own literal
          // digits. Bare `return` so descent continues into each item's
          // inline content — and into any nested list, which is a separate
          // OrderedList/BulletList node this same walk reaches on its own.
          decorateOrderedList(state, ref.node, decorations, hasFocus);
          return;
        }

        if (name === "HorizontalRule") {
          decorateHorizontalRule(state, ref.node, decorations, hasFocus);
          return;
        }

        if (name in HEADING_LEVELS) {
          decorateHeading(state, ref.node, HEADING_LEVELS[name], decorations, hasFocus);
          return;
        }

        if (name in SETEXT_HEADING_LEVELS) {
          decorateSetextHeading(state, ref.node, SETEXT_HEADING_LEVELS[name], decorations, hasFocus);
          return;
        }

        switch (name) {
          case "Emphasis":
            decorateWrapped(state, ref.node, "EmphasisMark", CLASS.emphasis, decorations, hasFocus);
            break;
          case "StrongEmphasis":
            decorateWrapped(state, ref.node, "EmphasisMark", CLASS.strong, decorations, hasFocus);
            break;
          case "Strikethrough":
            decorateWrapped(state, ref.node, "StrikethroughMark", CLASS.strikethrough, decorations, hasFocus);
            break;
          case "InlineCode":
            decorateWrapped(state, ref.node, "CodeMark", CLASS.inlineCode, decorations, hasFocus);
            break;
          case "Escape":
            decorateEscape(state, ref.node, decorations, hasFocus);
            break;
          case "QuoteMark":
            decorateQuoteMark(state, ref.node, decorations, hasFocus);
            break;
          case "ListMark":
            decorateListMark(state, ref.node, decorations, hasFocus);
            break;
          case "Link":
            if (isRevealTarget(state, ref.node, hasFocus)) {
              break;
            }
            decorateLink(state, ref.node, documentPath, refs, decorations);
            break;
          case "Image":
            if (isRevealTarget(state, ref.node, hasFocus)) {
              break;
            }
            decorateImage(state, ref.node, documentPath, refs, decorations);
            break;
          case "Autolink":
            if (isRevealTarget(state, ref.node, hasFocus)) {
              break;
            }
            decorateAutolink(state, ref.node, documentPath, decorations);
            break;
          case "URL": {
            // Exclude a Link/Image/Autolink node's own URL child — visited
            // independently by tree.iterate, and already decorated by its
            // parent — so only a genuinely bare URL (a standalone node
            // whose parent is Paragraph, Emphasis, TableCell, etc.) reaches
            // decorateBareUrl. See decorateBareUrl's doc comment.
            const parentName = ref.node.parent?.type.name;
            if (parentName === "Link" || parentName === "Image" || parentName === "Autolink") {
              break;
            }
            if (isRevealTarget(state, ref.node, hasFocus)) {
              break;
            }
            decorateBareUrl(state, ref.node, documentPath, decorations);
            break;
          }
          case "HTMLBlock":
          case "HTMLTag":
            decorateRawHtml(ref.node, decorations);
            break;
        }
      },
    });
  }

  return Decoration.set(decorations, true);
}

/**
 * Extracts just the `tableGap`-tagged ranges out of a decoration set built by
 * `buildDecorations`, for use as an `EditorView.atomicRanges` provider
 * (`livePreviewPlugin.ts`). Keeping this here, next to where the tag is
 * produced, means the tag's meaning ("a table gap, always hidden, cursor
 * should skip over it") stays defined in one place.
 */
export function buildTableGapAtomicRanges(state: EditorState, decorations: DecorationSet): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  decorations.between(0, state.doc.length, (from, to, deco) => {
    if (deco.spec.tableGap) {
      ranges.push(deco.range(from, to));
    }
  });
  return Decoration.set(ranges, true);
}

import type { Extension, Transaction } from "@codemirror/state";
import { Prec, RangeSet, StateEffect, StateField } from "@codemirror/state";
import { BlockWrapper, Decoration, EditorView, ViewPlugin, ViewUpdate, keymap, lineNumbers, type DecorationSet } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { syntaxTree } from "@codemirror/language";
import {
  buildCodeBlockWrapRanges,
  buildDecorations,
  buildMermaidWidgetDecorations,
  buildTableGapAtomicRanges,
  buildTableWrapRanges,
} from "./decorations";
import { handleLinkClick } from "./widgets";
import { tableNavigationKeymap } from "./tableEdit";
import {
  clearTableSelectionOnClickElsewhere,
  tableDragField,
  tableGeometryMeasurePlugin,
  tableHoverField,
  tableSelectionField,
  tableSelectionKeymap,
} from "./tableHandles";

/**
 * Tracks whether the editor's `contentDOM` currently has DOM focus, driven
 * by real `focus`/`blur` events rather than anything derivable from
 * `EditorState.selection` — the selection is always present and doesn't
 * change when focus moves elsewhere, so "under cursor" decorations need
 * this as an independent signal to know when to stop revealing raw markup.
 * Defaults to `false`: `EditorPane.svelte` never calls `view.focus()` on
 * mount, so this starts in the state the DOM genuinely starts in.
 */
const setEditorFocus = StateEffect.define<boolean>();

const editorFocusField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setEditorFocus)) value = effect.value;
    }
    return value;
  },
});

/**
 * `focus`/`blur` are non-bubbling DOM events, but `domEventHandlers`
 * attaches directly to `contentDOM` — the exact element that gains/loses
 * focus — so no capture-phase workaround is needed.
 */
const focusTrackingHandlers = EditorView.domEventHandlers({
  focus(_event, view) {
    view.dispatch({ effects: setEditorFocus.of(true) });
  },
  blur(_event, view) {
    view.dispatch({ effects: setEditorFocus.of(false) });
  },
});

/**
 * Recomputes decorations on doc changes, selection changes (cursor-reveal),
 * viewport changes (scrolling reveals previously-unvisited nodes), focus
 * changes (an unfocused editor never reveals raw markup, regardless of
 * where the selection sits), and syntax-tree-identity changes (the
 * background parser finishing a chunk outside the initial synchronous parse
 * window) — never on anything else, since walking the syntax tree is the
 * main perf risk for large files.
 *
 * Also provides `EditorView.atomicRanges` over every `tableGap`-tagged
 * range in that same decoration set (`decorations.ts`'s `decorateTableRow`
 * always hides a table's inter-cell gaps rather than cursor-revealing them,
 * to avoid the layout shift a revealed gap causes — see its docstring), so
 * cursor motion jumps over a hidden gap in one step instead of being able to
 * land inside it.
 *
 * And provides `EditorView.blockWrappers` with a `.cm-table-scroll`/
 * `.cm-table-box` pair per `Table` node (`buildTableWrapRanges`) and one
 * `.cm-code-block-box` per non-mermaid fenced/indented code block
 * (`buildCodeBlockWrapRanges`), all recomputed only on a doc change or
 * syntax-tree-identity change — unlike `decorations`, neither depends on the
 * viewport, selection, or focus, since a `BlockWrapper`'s range is a
 * structural property of the block itself, not of what's currently
 * revealed. `EditorView.blockWrappers` is an ordinary multi-input facet, so
 * the two wrapper sets are provided as two separate facet inputs below
 * rather than merged into one `RangeSet` here.
 *
 * Also rebuilds decorations on a `tableHoverField`/`tableSelectionField`/
 * `tableDragField` change, so hovering, clicking, or dragging a table
 * row/column handle applies its highlight/drag-tint class the same update
 * it's dispatched in — a transaction carrying only one of these effects
 * changes no doc, selection, viewport, or focus, so without this the rebuild
 * guard below would skip it and the drag tint would never appear.
 *
 * When a syntax-tree-identity change with no accompanying doc change
 * actually changes `tableWraps`/`codeBlockWraps` (issue #311), the plugin
 * tries to preserve the user's visual scroll position across it: such a
 * change can retroactively reclassify a block that's already scrolled above
 * the viewport, and CodeMirror's real, DOM-measured scroll-anchor
 * compensation can't see that reclassification for content that's been
 * virtualized away (see the `update` method's own comment for the exact
 * mechanism, its limits, and why a direct edit is excluded).
 */
// `requestMeasure`'s `key` dedups repeated scheduling within the same
// measure cycle (matching `tableGeometryMeasurePlugin`'s own key below) —
// irrelevant in practice here, since a background tree change only
// schedules this once per update, but kept for the same reason that plugin
// keys its own request.
export const livePreviewScrollAnchorKey = Symbol("live-preview-scroll-anchor");

/**
 * DOM *read* phase (see `measureTableGeometry`'s own docstring below for why
 * this must run inside `requestMeasure`'s `read`, not synchronously in
 * `update()`): how far `anchorPos`'s own height-map position has moved since
 * `anchorTopAtCapture` was recorded.
 */
export function computeScrollAnchorDelta(view: EditorView, anchorPos: number, anchorTopAtCapture: number): number {
  return view.lineBlockAt(anchorPos).top - anchorTopAtCapture;
}

/**
 * DOM *write* phase: nudges `scrollDOM.scrollTop` by `diff` — a *relative*
 * correction, not an absolute one. See `scheduleScrollAnchorRestore`'s own
 * docstring for why that distinction is what makes this safe against the
 * user's own in-flight scrolling. `1`px is CodeMirror's own threshold for
 * its equivalent built-in correction (`view/dist/index.js`'s measure loop),
 * kept the same here to avoid correcting sub-pixel noise.
 */
export function applyScrollAnchorDelta(diff: number, view: EditorView): void {
  if (Math.abs(diff) > 1) view.scrollDOM.scrollTop += diff;
}

/**
 * Schedules `computeScrollAnchorDelta`/`applyScrollAnchorDelta` as a single
 * `requestMeasure` read/write pass (the same way `tableGeometryMeasurePlugin`
 * below schedules its own DOM work from `update()`), not
 * `view.scrollSnapshot()` dispatched through a transaction.
 *
 * `scrollSnapshot()`'s effect is an *absolute* rewind (`DocView
 * .scrollIntoView`'s snapshot branch force-writes `scrollDOM.scrollTop`) that
 * only actually lands a full animation frame later, in CodeMirror's own
 * measure pass — long enough for the user's own in-flight scrolling (native
 * wheel/momentum input, which never goes through this plugin, and which a
 * same-tick guard cannot observe: it's delivered as a browser task, and
 * every microtask an update schedules drains before the next task runs) to
 * have moved `scrollDOM.scrollTop` in the meantime. Applying a stale
 * absolute target on top of that reproduces the exact backward jump this
 * guards against — and a pending absolute target also pre-empts CodeMirror's
 * own safe *relative* compensation instead of coexisting with it.
 *
 * Reading `scrollTop` fresh in `read` (rather than trusting a value captured
 * earlier) and writing an additive delta in `write` mirrors that safe
 * mechanism instead of racing it: whatever the user's own scrolling has done
 * by the time this runs, `diff` is added on top of it rather than replacing
 * it.
 */
export function scheduleScrollAnchorRestore(view: EditorView, anchorPos: number, anchorTopAtCapture: number): void {
  view.requestMeasure({
    key: livePreviewScrollAnchorKey,
    read: (readView) => computeScrollAnchorDelta(readView, anchorPos, anchorTopAtCapture),
    write: applyScrollAnchorDelta,
  });
}

function livePreviewPlugin(documentPath: string) {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      tableWraps: RangeSet<BlockWrapper>;
      codeBlockWraps: RangeSet<BlockWrapper>;

      constructor(view: EditorView) {
        this.decorations = buildDecorations(
          view.state,
          view.visibleRanges,
          documentPath,
          view.state.field(editorFocusField),
          view.state.field(tableHoverField),
          view.state.field(tableSelectionField),
          view.state.field(tableDragField),
        );
        this.tableWraps = buildTableWrapRanges(view.state);
        this.codeBlockWraps = buildCodeBlockWrapRanges(view.state);
      }

      update(update: ViewUpdate) {
        const focusChanged = update.startState.field(editorFocusField) !== update.state.field(editorFocusField);
        const hoverChanged = update.startState.field(tableHoverField) !== update.state.field(tableHoverField);
        const selectionChanged = update.startState.field(tableSelectionField) !== update.state.field(tableSelectionField);
        const dragChanged = update.startState.field(tableDragField) !== update.state.field(tableDragField);
        if (
          update.docChanged ||
          update.selectionSet ||
          update.viewportChanged ||
          focusChanged ||
          hoverChanged ||
          selectionChanged ||
          dragChanged ||
          syntaxTree(update.startState) !== syntaxTree(update.state)
        ) {
          this.decorations = buildDecorations(
            update.state,
            update.view.visibleRanges,
            documentPath,
            update.state.field(editorFocusField),
            update.state.field(tableHoverField),
            update.state.field(tableSelectionField),
            update.state.field(tableDragField),
          );
        }

        const treeChanged = syntaxTree(update.startState) !== syntaxTree(update.state);
        if (update.docChanged || treeChanged) {
          // A background-parser tree completion (no doc change, no
          // selection change — the same shape of transaction `forceParsing`
          // simulates for the #85 tests above) can retroactively reclassify
          // a block that's already scrolled above the viewport from plain
          // text into a real `.cm-table-box`/`.cm-code-block-box` wrapper,
          // changing its rendered height at a moment entirely decoupled
          // from the user's own scroll input. CodeMirror's real scroll-anchor
          // compensation (a later, DOM-measured pass, separate from the
          // `StateField`-only detection that only drives the viewport
          // recompute at update time) already handles this correctly for
          // content that's still within the currently-drawn range — but a
          // block reclassified while it's scrolled far enough to have been
          // virtualized away never gets re-measured until it re-enters view,
          // so that case is what this guards. A direct edit is excluded:
          // its own scroll handling already covers the doc-changed case, and
          // `buildTableWrapRanges`/`buildCodeBlockWrapRanges` only ever
          // retroactively affect content the user *isn't* currently editing.
          const backgroundReclassify = treeChanged && !update.docChanged;
          const view = update.view;
          // The first currently-drawn position is the anchor: whatever's at
          // the top of the viewport. `view.visibleRanges` and `lineBlockAt`
          // are both plain reads of CodeMirror's own internal height-map
          // model (not the real DOM), so — unlike `measureTableGeometry`'s
          // real DOM reads elsewhere in this file, which do need to wait for
          // `requestMeasure`'s `read` phase — they're safe to call here, and
          // at this exact point in `update()` they still reflect pre-change
          // heights: this plugin's own wraps are the only thing about to
          // change, and nothing has fed that into the height map yet
          // (that's the underlying bug). `elementAtHeight`/`lineBlockAtHeight`
          // are *not* safe here despite looking similar — CodeMirror gates
          // both behind a "reading the editor layout isn't allowed during an
          // update" check that `lineBlockAt(pos)` doesn't share.
          const anchorPos = backgroundReclassify ? (view.visibleRanges[0]?.from ?? 0) : 0;
          const anchorTopAtCapture = backgroundReclassify ? view.lineBlockAt(anchorPos).top : 0;

          const newTableWraps = buildTableWrapRanges(update.state);
          const newCodeBlockWraps = buildCodeBlockWrapRanges(update.state);
          const wrapsChanged =
            !RangeSet.eq([this.tableWraps], [newTableWraps]) ||
            !RangeSet.eq([this.codeBlockWraps], [newCodeBlockWraps]);
          this.tableWraps = newTableWraps;
          this.codeBlockWraps = newCodeBlockWraps;

          if (backgroundReclassify && wrapsChanged) {
            scheduleScrollAnchorRestore(view, anchorPos, anchorTopAtCapture);
          }
        }
      }
    },
    {
      decorations: (v) => v.decorations,
    },
  );

  return [
    plugin,
    EditorView.atomicRanges.of((view) => {
      const value = view.plugin(plugin);
      return value ? buildTableGapAtomicRanges(view.state, value.decorations) : Decoration.none;
    }),
    EditorView.blockWrappers.of((view) => {
      const value = view.plugin(plugin);
      return value ? value.tableWraps : BlockWrapper.set([]);
    }),
    EditorView.blockWrappers.of((view) => {
      const value = view.plugin(plugin);
      return value ? value.codeBlockWraps : BlockWrapper.set([]);
    }),
  ];
}

/**
 * Block-replace `MermaidWidget` decorations for every ` ```mermaid ` block
 * with the cursor elsewhere. CodeMirror requires block-level replace
 * decorations to come from a `StateField` rather than a `ViewPlugin` (a
 * `RangeError: Block decorations may not be specified via plugins` at
 * runtime otherwise), so this is a separate extension from
 * `livePreviewPlugin` above, recomputed on the same doc-change/
 * selection-change/focus-change/tree-identity triggers.
 */
const mermaidWidgetField = StateField.define<DecorationSet>({
  create(state) {
    return buildMermaidWidgetDecorations(state, state.field(editorFocusField));
  },
  update(decorations, tr: Transaction) {
    // `tr.startState.field(editorFocusField, false)` (not the throwing
    // 2-arg-omitted form): when the view-mode compartment reconfigures
    // `editorFocusField` back into the config (source → rendered), this
    // `update` still runs against the pre-reconfigure `tr.startState`,
    // which genuinely doesn't have the field yet — CodeMirror always
    // derives a reconfigured state's final values via each field's
    // `update`, even for a field that was just freshly created moments
    // earlier in the same transaction's intermediate reconfigure step.
    const focusChanged = tr.startState.field(editorFocusField, false) !== tr.state.field(editorFocusField);
    if (tr.docChanged || tr.selection || focusChanged || syntaxTree(tr.startState) !== syntaxTree(tr.state)) {
      return buildMermaidWidgetDecorations(tr.state, tr.state.field(editorFocusField));
    }
    return decorations.map(tr.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

/**
 * Modifier+click (Cmd on macOS, Ctrl elsewhere — the platform convention for
 * "open this link") on a `cm-link` mark navigates instead of placing the
 * cursor there. This runs on `mousedown`, not `click`: CodeMirror's own
 * built-in mousedown handler places the cursor synchronously and runs
 * *after* plugin-registered `domEventHandlers` (base handlers are appended
 * last), so intercepting here and returning `true` skips it entirely.
 * Skipping it matters because the built-in handler would otherwise move the
 * cursor onto the link's line, which drops its `cm-link` decoration back to
 * raw `[text](url)` source (`decorations.ts`'s `Link` case) before a `click`
 * handler ever got a chance to see the mark. A non-modifier click falls
 * through unhandled here, so it still reaches that built-in handler and
 * gets the normal cursor-placement/raw-source-reveal behavior.
 */
const linkClickHandler = EditorView.domEventHandlers({
  mousedown(event) {
    if (event.button !== 0 || !(event.metaKey || event.ctrlKey)) {
      return false;
    }
    const target = event.target as HTMLElement | null;
    const link = target?.closest<HTMLElement>(".cm-link");
    if (!link) {
      return false;
    }
    const url = link.dataset.href;
    const documentPath = link.dataset.documentPath;
    if (!url || documentPath === undefined) {
      return false;
    }
    event.preventDefault();
    handleLinkClick(url, documentPath);
    return true;
  },
});

/**
 * Full markdown-mode extension set: GFM-flavored language (tables, task
 * lists, strikethrough, autolinks are all part of `markdownLanguage`),
 * fenced-code nested highlighting via `@codemirror/language-data` (colored
 * by the syntax highlight style shared through `EditorPane.svelte`'s theme
 * `Compartment`), focus tracking, and the live-preview decoration plugin.
 *
 * `editorFocusField` must come before `mermaidWidgetField`: CodeMirror
 * computes `StateField`s in declaration order within a transaction, and
 * `mermaidWidgetField.update` reads `editorFocusField`'s value via
 * `tr.state.field(...)`, which only sees the current transaction's
 * already-updated value if `editorFocusField` was declared earlier.
 * `livePreviewPlugin`'s `ViewPlugin` has no such ordering hazard (it reads
 * a fully-resolved `EditorState`, not a `StateField` computing its own
 * value), but keeping `editorFocusField` first for both is simplest to
 * reason about.
 *
 * `tableNavigationKeymap`/`tableSelectionKeymap` are merged into one
 * `keymap.of(...)` wrapped in `Prec.highest`, not a plain `keymap.of(...)`:
 * `EditorPane.svelte` puts `baseExtensions()` — whose own keymap already
 * binds `Tab` (`indentWithTab`) and `Enter` (`insertNewlineAndIndent`, via
 * `defaultKeymap`) — *before* this extension set in its top-level
 * `extensions` array. Two `keymap.of(...)` calls at the same precedence are
 * tried in the order they appear in the flattened extension tree, so
 * without `Prec.highest` here, `baseExtensions()`'s bindings would always
 * win and neither table keymap would ever run. `Prec.highest` is safe (not
 * just convenient) precisely because every binding in both self-gates
 * (on the cursor being inside a table, or on a selection actually being
 * pinned) and falls through (returns `false`) otherwise, so outranking the
 * generic keymap never changes behavior outside those cases.
 *
 * `EditorView.contentAttributes.of({ class: "cm-md-rendered" })` marks this
 * pane's `.cm-content` (the same mechanism `EditorView.lineWrapping` itself
 * uses for `cm-lineWrapping`, and `combineAttrs` concatenates the two into
 * one space-joined class list) so `markdown.css`'s reading-column rules
 * (prose max-width, `.cm-code-block-box`, `.cm-table-scroll`,
 * `.cm-mermaid-diagram`) can be scoped to the rendered pane only.
 * `markdownSourceExtensions` below gains no such marker, so the raw source
 * pane's `.cm-content` never matches those rules and keeps rendering exactly
 * as it does today.
 */
export function markdownExtensions(documentPath: string): Extension[] {
  return [
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    editorFocusField,
    tableHoverField,
    tableSelectionField,
    tableDragField,
    focusTrackingHandlers,
    livePreviewPlugin(documentPath),
    mermaidWidgetField,
    tableGeometryMeasurePlugin,
    clearTableSelectionOnClickElsewhere,
    linkClickHandler,
    EditorView.contentAttributes.of({ class: "cm-md-rendered" }),
    Prec.highest(keymap.of([...tableNavigationKeymap, ...tableSelectionKeymap])),
  ];
}

/**
 * Raw/source markdown extension set: the same GFM-flavored language (so
 * fenced code blocks still get nested-language highlighting) and a
 * line-number gutter, but no decoration plugin and no link-click handler —
 * syntax stays visible, checkboxes and images stay plain text, and links
 * don't navigate. Behaves like editing any other file type.
 */
export function markdownSourceExtensions(_documentPath: string): Extension[] {
  return [markdown({ base: markdownLanguage, codeLanguages: languages }), lineNumbers()];
}

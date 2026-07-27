import type { Extension, RangeSet, Transaction } from "@codemirror/state";
import { Prec, StateEffect, StateField } from "@codemirror/state";
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
 * rebuilds `tableWraps`/`codeBlockWraps` (issue #311), the plugin preserves
 * the user's visual scroll position across it: such a change can
 * retroactively reclassify a block that's already scrolled above the
 * viewport, and CodeMirror's own height-change detection doesn't see it
 * (see the `update` method's own comment for the mechanism and why a direct
 * edit is excluded).
 */
function livePreviewPlugin(documentPath: string) {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      tableWraps: RangeSet<BlockWrapper>;
      codeBlockWraps: RangeSet<BlockWrapper>;
      private destroyed = false;

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
          // from the user's own scroll input. CodeMirror's built-in
          // height-change detection only looks at `StateField`-registered
          // decorations, not these `ViewPlugin`-supplied wraps (see
          // `EditorPane.svelte`'s own comment on the view-mode-toggle case
          // for the same limitation), so nothing else compensates the
          // user's scroll position for it. A direct edit is excluded here:
          // its own scroll handling (cursor-following, `scrollIntoView`
          // from the transaction) already covers the doc-changed case, and
          // `buildTableWrapRanges`/`buildCodeBlockWrapRanges` only ever
          // retroactively affect content the user *isn't* currently editing.
          const preserveScroll = treeChanged && !update.docChanged;
          const snapshot = preserveScroll ? update.view.scrollSnapshot() : null;

          this.tableWraps = buildTableWrapRanges(update.state);
          this.codeBlockWraps = buildCodeBlockWrapRanges(update.state);

          if (snapshot) {
            // `view.dispatch()` cannot be called synchronously from inside
            // a `ViewPlugin.update()` — CodeMirror throws "Calls to
            // EditorView.update are not allowed while an update is in
            // progress" — so the restoring dispatch is deferred to a
            // microtask, which still runs before the browser processes any
            // further scroll input. `scrollSnapshot()`'s effect is
            // anchor-relative (it restores "this document position stays
            // at this pixel offset from the top"), not an absolute scroll
            // position, so re-applying it when nothing above the anchor
            // actually changed height is a no-op — safe to schedule on
            // every qualifying update rather than only when a jump is
            // suspected. `requestMeasure()` afterward matches the same
            // final step the view-mode-toggle fix already uses.
            const view = update.view;
            Promise.resolve().then(() => {
              if (this.destroyed) return;
              view.dispatch({ effects: snapshot });
              view.requestMeasure();
            });
          }
        }
      }

      destroy() {
        this.destroyed = true;
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

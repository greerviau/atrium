import type { Extension, Transaction } from "@codemirror/state";
import { StateField } from "@codemirror/state";
import { EditorView, ViewPlugin, ViewUpdate, lineNumbers, type DecorationSet } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { buildDecorations, buildMermaidWidgetDecorations } from "./decorations";
import { handleLinkClick } from "./widgets";

/**
 * Recomputes decorations on doc changes, selection changes (cursor-reveal),
 * and viewport changes (scrolling reveals previously-unvisited nodes) —
 * never on anything else, since walking the syntax tree is the main perf
 * risk for large files.
 */
function livePreviewPlugin(documentPath: string) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view.state, view.visibleRanges, documentPath);
      }

      update(update: ViewUpdate) {
        if (update.docChanged || update.selectionSet || update.viewportChanged) {
          this.decorations = buildDecorations(update.state, update.view.visibleRanges, documentPath);
        }
      }
    },
    {
      decorations: (v) => v.decorations,
    },
  );
}

/**
 * Block-replace `MermaidWidget` decorations for every ` ```mermaid ` block
 * with the cursor elsewhere. CodeMirror requires block-level replace
 * decorations to come from a `StateField` rather than a `ViewPlugin` (a
 * `RangeError: Block decorations may not be specified via plugins` at
 * runtime otherwise), so this is a separate extension from
 * `livePreviewPlugin` above, recomputed on the same doc-change/
 * selection-change triggers.
 */
const mermaidWidgetField = StateField.define<DecorationSet>({
  create(state) {
    return buildMermaidWidgetDecorations(state);
  },
  update(decorations, tr: Transaction) {
    if (tr.docChanged || tr.selection) {
      return buildMermaidWidgetDecorations(tr.state);
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
 * `Compartment`), and the live-preview decoration plugin.
 */
export function markdownExtensions(documentPath: string): Extension[] {
  return [
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    livePreviewPlugin(documentPath),
    mermaidWidgetField,
    linkClickHandler,
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

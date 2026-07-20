import type { Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, ViewUpdate, lineNumbers, type DecorationSet } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { buildDecorations } from "./decorations";
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

/** Single click handler for every `cm-link` mark, reading the URL/document path stashed in its attributes. */
const linkClickHandler = EditorView.domEventHandlers({
  click(event) {
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
    handleLinkClick(url, documentPath);
    return true;
  },
});

/**
 * Full markdown-mode extension set: GFM-flavored language (tables, task
 * lists, strikethrough, autolinks are all part of `markdownLanguage`),
 * fenced-code nested highlighting via `@codemirror/language-data` (colored
 * by the base syntax highlighting shared from `baseExtensions()`), and the
 * live-preview decoration plugin.
 */
export function markdownExtensions(documentPath: string): Extension[] {
  return [
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    livePreviewPlugin(documentPath),
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

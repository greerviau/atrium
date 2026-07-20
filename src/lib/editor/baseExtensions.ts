import type { Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { history, defaultKeymap, historyKeymap, indentWithTab } from "@codemirror/commands";
import { search, searchKeymap } from "@codemirror/search";
import { autocompletion } from "@codemirror/autocomplete";
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";

/** Themes the gutter/line-number chrome to Atrium's existing dark palette instead of CodeMirror's built-in default. */
function gutterTheme(): Extension {
  return EditorView.theme(
    {
      ".cm-gutters": { backgroundColor: "transparent", border: "none" },
      ".cm-lineNumbers .cm-gutterElement": { color: "var(--atrium-text-muted)" },
    },
    { dark: true },
  );
}

/**
 * Extensions shared by both the markdown and code panes: history, the
 * default/history keymaps, tab-to-indent, the find/replace panel,
 * word-based autocompletion, base syntax highlighting (shared with the
 * markdown pane's fenced code blocks), and gutter theming. Multi-cursor
 * (Alt-click, Cmd-D select-next) is core `EditorView`/`defaultKeymap`
 * behavior and needs no extra extension.
 */
export function baseExtensions(): Extension[] {
  return [
    history(),
    search(),
    autocompletion(),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
    EditorView.lineWrapping,
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    gutterTheme(),
  ];
}

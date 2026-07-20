import type { Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { history, defaultKeymap, historyKeymap, indentWithTab } from "@codemirror/commands";
import { search, searchKeymap } from "@codemirror/search";
import { autocompletion } from "@codemirror/autocomplete";

/**
 * Extensions shared by both the markdown and code panes: history, the
 * default/history keymaps, tab-to-indent, the find/replace panel, and
 * word-based autocompletion. Multi-cursor (Alt-click, Cmd-D select-next) is
 * core `EditorView`/`defaultKeymap` behavior and needs no extra extension.
 * The CM theme and syntax highlight style (theme-driven, not a library
 * default) live in `EditorPane.svelte`'s theme `Compartment` instead, since
 * they need to be reconfigured on a theme change without tearing down
 * everything else in this array.
 */
export function baseExtensions(): Extension[] {
  return [
    history(),
    search(),
    autocompletion(),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
    EditorView.lineWrapping,
  ];
}

import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import type { Theme } from "./tokens";

/**
 * Builds the CodeMirror chrome theme (gutter, selection, cursor,
 * active-line, matching-bracket, and search-match colors) from a `Theme`'s
 * editor-chrome tokens. Includes `gutterTheme()`'s former two rules
 * (`.cm-gutters` background, `.cm-lineNumbers .cm-gutterElement` color) plus
 * everything CodeMirror otherwise leaves at its light-background-tuned
 * library default (section 2.4 of the spec).
 */
export function buildCmTheme(theme: Theme): Extension {
  const t = theme.tokens;
  return EditorView.theme(
    {
      "&": {
        backgroundColor: t.bgBase,
      },
      // CodeMirror's selection layer sits behind `.cm-content`; its
      // transparency keeps app-drawn selection backgrounds visible.
      // `drawSelection()` in `src/lib/editor/baseExtensions.ts` is what makes
      // CodeMirror draw its own cursor as a bordered div instead of relying
      // on the webview's native text caret, so the cursor color takes effect
      // via borderLeftColor here. `.cm-dropCursor` is not drawn by anything
      // today — `dropCursor()` is a deliberate follow-up, not part of this
      // rule's own effect.
      ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: t.cursor,
      },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
        backgroundColor: t.selectionBg,
      },
      ".cm-activeLine": {
        backgroundColor: t.activeLineBg,
      },
      ".cm-matchingBracket, .cm-nonmatchingBracket": {
        backgroundColor: t.matchingBracketBg,
      },
      ".cm-searchMatch, .cm-searchMatch-selected": {
        backgroundColor: t.searchMatchBg,
      },
      ".cm-gutters": {
        backgroundColor: t.gutterBg,
        border: "none",
      },
      ".cm-lineNumbers .cm-gutterElement": {
        color: t.gutterFg,
      },
      ".cm-activeLineGutter": {
        color: t.gutterFgActiveLine,
      },
    },
    { dark: theme.appearance === "dark" },
  );
}

/**
 * Builds the syntax `HighlightStyle` from a `Theme`'s syntax tokens, mapping
 * each `@lezer/highlight` tag to its token color per the spec's tag mapping.
 */
export function buildHighlightStyle(theme: Theme): HighlightStyle {
  const t = theme.tokens;
  return HighlightStyle.define([
    { tag: tags.keyword, color: t.syntaxKeyword },
    { tag: tags.string, color: t.syntaxString },
    { tag: tags.number, color: t.syntaxNumber },
    { tag: tags.comment, color: t.syntaxComment, fontStyle: "italic" },
    { tag: [tags.function(tags.variableName), tags.definition(tags.function(tags.variableName))], color: t.syntaxFunction },
    { tag: [tags.typeName, tags.className], color: t.syntaxType },
    { tag: tags.propertyName, color: t.syntaxProperty },
    { tag: [tags.operator, tags.punctuation], color: t.syntaxOperator },
    { tag: tags.invalid, color: t.syntaxInvalid },
  ]);
}

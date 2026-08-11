import { EditorState, type Extension } from "@codemirror/state";
import { completeAnyWord, type CompletionSource } from "@codemirror/autocomplete";

/** Shortest typed prefix that opens the word list on its own; an explicit `Ctrl-Space` ignores it. */
const MIN_IMPLICIT_PREFIX = 2;

/**
 * Identifier-shaped: what this source offers, and what keeps its list open
 * (as `validFor`). Single-character identifiers (`i`, `x`, `_`) are included
 * — they just can't open the list on their own, since `MIN_IMPLICIT_PREFIX`
 * gates that separately; an explicit `Ctrl-Space` still reaches them.
 */
const IDENTIFIER = /^[\p{Alphabetic}_][\p{Alphabetic}\p{Number}_]*$/u;

/**
 * Three things here are load-bearing and will look removable to a later
 * reader. The `result instanceof Promise` branch is required for
 * `svelte-check` to pass (`CompletionSource`'s declared return type includes
 * a promise even though `completeAnyWord` is synchronous). Dropping `type`
 * from each option is what makes CodeMirror dedupe these against the
 * language pack's entries — do not "restore" `type: "text"`. Passing
 * `IDENTIFIER` as `validFor`, rather than keeping `completeAnyWord`'s own
 * looser pattern, is what makes the 2-character floor hold while the user
 * backspaces.
 */
const documentWordSource: CompletionSource = (context) => {
  const result = completeAnyWord(context);
  if (!result || result instanceof Promise) return result;
  if (!context.explicit && context.pos - result.from < MIN_IMPLICIT_PREFIX) return null;
  return {
    from: result.from,
    validFor: IDENTIFIER,
    options: result.options
      .filter(({ label }) => IDENTIFIER.test(label))
      .map(({ label }) => ({ label })),
  };
};

export const documentWordCompletion: Extension = EditorState.languageData.of(() => [
  { autocomplete: documentWordSource },
]);

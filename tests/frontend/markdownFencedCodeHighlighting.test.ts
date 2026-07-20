import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { syntaxTree, defaultHighlightStyle, LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightTree } from "@lezer/highlight";
import { baseExtensions } from "../../src/lib/editor/baseExtensions";
import { markdownExtensions } from "../../src/lib/editor/markdown/livePreviewPlugin";

describe("fenced code blocks in markdown still highlight after the shared extension moved to baseExtensions()", () => {
  it("colors tokens inside a ```js fenced block", async () => {
    // The markdown language's nested-parser lookup only parses a fenced
    // block's language synchronously once that `LanguageDescription`'s
    // `.load()` has already resolved (otherwise it uses a skipping parser
    // and reparses later) — awaiting the load up front keeps this test
    // synchronous-after-await instead of racing CM6's own reparse cycle.
    await LanguageDescription.matchLanguageName(languages, "js")?.load();

    const doc = "Some text\n\n```js\nfunction greet(name) {\n  return `hi ${name}`;\n}\n```\n";
    const fenceStart = doc.indexOf("function");
    const fenceEnd = doc.indexOf("```\n", fenceStart);

    const state = EditorState.create({
      doc,
      extensions: [...baseExtensions(), ...markdownExtensions("sample.md")],
    });

    const tree = syntaxTree(state);
    const styledRangesInFence: string[] = [];
    highlightTree(tree, defaultHighlightStyle, (from, to, classes) => {
      if (from >= fenceStart && to <= fenceEnd) {
        styledRangesInFence.push(classes);
      }
    });

    expect(styledRangesInFence.length).toBeGreaterThan(0);
  });
});

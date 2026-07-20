import { describe, it, expect, afterEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { baseExtensions } from "../../src/lib/editor/baseExtensions";
import { markdownExtensions } from "../../src/lib/editor/markdown/livePreviewPlugin";

let view: EditorView | undefined;

afterEach(() => {
  view?.destroy();
  view = undefined;
});

describe("fenced code blocks in markdown still highlight after the shared extension moved to baseExtensions()", () => {
  it("renders styled token spans inside a ```js fenced block, via EditorPane's real markdown-mode extension composition", async () => {
    // The markdown language's nested-parser lookup only parses a fenced
    // block's language synchronously once that `LanguageDescription`'s
    // `.load()` has already resolved (otherwise it uses a skipping parser
    // and reparses later) — awaiting the load up front keeps this test
    // synchronous-after-await instead of racing CM6's own reparse cycle.
    await LanguageDescription.matchLanguageName(languages, "js")?.load();

    const doc = "# Heading\n\n```js\nfunction greet(name) {\n  return `hi ${name}`;\n}\n```\n";
    const container = document.createElement("div");
    view = new EditorView({
      state: EditorState.create({
        doc,
        extensions: [baseExtensions(), markdownExtensions("sample.md")],
      }),
      parent: container,
    });

    const fenceLines = Array.from(container.querySelectorAll(".cm-content .cm-line")).filter((line) =>
      line.textContent?.includes("greet"),
    );
    expect(fenceLines.length).toBeGreaterThan(0);

    const styledSpansInFence = fenceLines.flatMap((line) => Array.from(line.querySelectorAll("span[class]")));
    expect(styledSpansInFence.length).toBeGreaterThan(0);
  });
});

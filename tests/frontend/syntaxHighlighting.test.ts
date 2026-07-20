import { describe, it, expect, afterEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { baseExtensions } from "../../src/lib/editor/baseExtensions";
import { codeExtensions } from "../../src/lib/editor/codeExtensions";

interface Case {
  path: string;
  doc: string;
}

const cases: Case[] = [
  { path: "sample.ts", doc: "function greet(name: string) {\n  // say hello\n  return `hi ${name}`;\n}\n" },
  { path: "sample.py", doc: "def greet(name):\n    # say hello\n    return f'hi {name}'\n" },
  { path: "sample.rs", doc: "fn greet(name: &str) -> String {\n    // say hello\n    format!(\"hi {}\", name)\n}\n" },
  { path: "sample.go", doc: "func greet(name string) string {\n\t// say hello\n\treturn \"hi \" + name\n}\n" },
  { path: "sample.json", doc: '{\n  "greeting": "hi",\n  "count": 1\n}\n' },
  { path: "sample.yaml", doc: "greeting: hi\ncount: 1\n" },
  { path: "sample.css", doc: ".greeting {\n  /* say hello */\n  color: red;\n}\n" },
  { path: "sample.html", doc: "<!-- say hello -->\n<div class=\"greeting\">hi</div>\n" },
  { path: "sample.sh", doc: "#!/bin/bash\n# say hello\necho \"hi\"\n" },
];

let view: EditorView | undefined;

afterEach(() => {
  view?.destroy();
  view = undefined;
});

describe("syntax highlighting is wired up for every wired code-file extension", () => {
  for (const { path, doc } of cases) {
    it(`renders styled token spans for ${path}, via EditorPane's real code-mode extension composition`, () => {
      const container = document.createElement("div");
      view = new EditorView({
        state: EditorState.create({
          doc,
          extensions: [baseExtensions(), lineNumbers(), ...codeExtensions(path)],
        }),
        parent: container,
      });

      const styledSpans = container.querySelectorAll(".cm-content .cm-line span[class]");
      expect(styledSpans.length).toBeGreaterThan(0);
    });
  }
});

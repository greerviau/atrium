import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { syntaxTree, defaultHighlightStyle } from "@codemirror/language";
import { highlightTree } from "@lezer/highlight";
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

describe("syntax highlighting is applied to every wired code-file extension", () => {
  for (const { path, doc } of cases) {
    it(`highlights ${path}`, () => {
      const state = EditorState.create({
        doc,
        extensions: codeExtensions(path),
      });

      const tree = syntaxTree(state);
      const styledRanges: string[] = [];
      highlightTree(tree, defaultHighlightStyle, (_from, _to, classes) => {
        styledRanges.push(classes);
      });

      expect(styledRanges.length).toBeGreaterThan(0);
    });
  }
});

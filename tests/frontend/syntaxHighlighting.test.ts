import { describe, it, expect, afterEach } from "vitest";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { syntaxHighlighting } from "@codemirror/language";
import { baseExtensions } from "../../src/lib/editor/baseExtensions";
import { loadCodeExtensions } from "../../src/lib/editor/codeExtensions";
import { buildHighlightStyle } from "../../src/lib/theme/cmTheme";
import { atriumDark } from "../../src/lib/theme/tokens";

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
  { path: "sample.bash", doc: "#!/usr/bin/env bash\n# say hello\necho \"hi\"\n" },
  { path: "sample.toml", doc: "[greeting]\nmessage = \"hi\"\ncount = 1\n" },
  { path: "sample.tf", doc: "resource \"aws_s3_bucket\" \"example\" {\n  bucket = \"atrium-example\"\n}\n" },
  { path: "sample.c", doc: "int main(void) { return 0; }\n" },
  { path: "sample.java", doc: "class Greeting { String message = \"hi\"; }\n" },
  { path: "sample.rb", doc: "def greet(name)\n  puts \"hi #{name}\"\nend\n" },
  { path: "sample.sql", doc: "SELECT message FROM greetings WHERE id = 1;\n" },
  { path: "sample.scss", doc: "$color: red;\n.greeting { color: $color; }\n" },
  { path: "Dockerfile", doc: "FROM node:20\nRUN echo \"hi\"\n" },
];

let view: EditorView | undefined;

afterEach(() => {
  view?.destroy();
  view = undefined;
});

describe("syntax highlighting is wired up for supported code files", () => {
  for (const { path, doc } of cases) {
    it(`renders styled token spans for ${path} after EditorPane's language compartment loads`, async () => {
      const container = document.createElement("div");
      const language = new Compartment();
      view = new EditorView({
        state: EditorState.create({
          doc,
          extensions: [
            baseExtensions(),
            syntaxHighlighting(buildHighlightStyle(atriumDark), { fallback: true }),
            lineNumbers(),
            language.of([]),
          ],
        }),
        parent: container,
      });
      view.dispatch({ effects: language.reconfigure(await loadCodeExtensions(path)) });

      const styledSpans = container.querySelectorAll(".cm-content .cm-line span[class]");
      expect(styledSpans.length).toBeGreaterThan(0);
    });
  }
});

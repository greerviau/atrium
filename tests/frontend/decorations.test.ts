import { describe, it, expect } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { buildDecorations } from "../../src/lib/editor/markdown/decorations";
import { CheckboxWidget, ImageWidget } from "../../src/lib/editor/markdown/widgets";
import { markdownSourceExtensions } from "../../src/lib/editor/markdown/livePreviewPlugin";

function stateFor(doc: string, selection?: number): EditorState {
  return EditorState.create({
    doc,
    selection: selection !== undefined ? EditorSelection.cursor(selection) : undefined,
    extensions: [markdown({ base: markdownLanguage })],
  });
}

interface CollectedDecoration {
  from: number;
  to: number;
  class?: string;
  isReplace: boolean;
  widget?: unknown;
}

function collect(state: EditorState, documentPath = "test.md"): CollectedDecoration[] {
  const decorations = buildDecorations(state, [{ from: 0, to: state.doc.length }], documentPath);
  const out: CollectedDecoration[] = [];
  decorations.between(0, state.doc.length, (from, to, deco) => {
    out.push({
      from,
      to,
      class: deco.spec.class,
      isReplace: (deco as unknown as { isReplace: boolean }).isReplace,
      widget: deco.spec.widget,
    });
  });
  return out;
}

describe("buildDecorations: headings", () => {
  it("hides the marker and applies a heading class when the cursor is elsewhere", () => {
    const doc = "# Hello\nSecond line";
    const state = stateFor(doc, doc.length); // cursor on line 2
    const decos = collect(state);
    const headingDeco = decos.find((d) => d.class === "cm-heading-1");
    expect(headingDeco).toBeTruthy();
    expect(headingDeco?.from).toBe(2); // after "# "
    expect(headingDeco?.to).toBe(7); // end of "Hello"
  });

  it("reveals raw markdown when the cursor is on the heading line", () => {
    const doc = "# Hello\nSecond line";
    const state = stateFor(doc, 3); // cursor inside "Hello"
    const decos = collect(state);
    expect(decos.find((d) => d.class === "cm-heading-1")).toBeUndefined();
  });
});

describe("buildDecorations: emphasis and strong", () => {
  it("marks emphasis and strong text and hides delimiters", () => {
    const doc = "plain *em* and **strong** text\nsecond line";
    const state = stateFor(doc, doc.length);
    const decos = collect(state);
    expect(decos.some((d) => d.class === "cm-em")).toBe(true);
    expect(decos.some((d) => d.class === "cm-strong")).toBe(true);
    // Delimiters (*, **) are hidden via zero-content replace decorations.
    const replaces = decos.filter((d) => d.isReplace && !d.class);
    expect(replaces.length).toBeGreaterThanOrEqual(4);
  });
});

describe("buildDecorations: inline code", () => {
  it("marks inline code and hides backticks", () => {
    const doc = "use `code` here\nsecond line";
    const state = stateFor(doc, doc.length);
    const decos = collect(state);
    const codeDeco = decos.find((d) => d.class === "cm-inline-code");
    expect(codeDeco).toBeTruthy();
  });
});

describe("buildDecorations: links", () => {
  it("hides brackets/url and marks the link text with the target url", () => {
    const doc = "[click here](https://example.com/page)\nsecond line";
    const state = stateFor(doc, doc.length);
    const decorations = buildDecorations(state, [{ from: 0, to: state.doc.length }], "test.md");
    let found: { from: number; to: number; href?: string } | undefined;
    decorations.between(0, state.doc.length, (from, to, deco) => {
      if (deco.spec.class === "cm-link") {
        found = { from, to, href: deco.spec.attributes?.["data-href"] };
      }
    });
    expect(found).toBeTruthy();
    expect(found?.href).toBe("https://example.com/page");
    expect(state.doc.sliceString(found!.from, found!.to)).toBe("click here");
  });
});

describe("buildDecorations: images", () => {
  it("replaces the whole image node with an ImageWidget", () => {
    const doc = "![alt text](./local.png)\nsecond line";
    const state = stateFor(doc, doc.length);
    const decorations = buildDecorations(state, [{ from: 0, to: state.doc.length }], "notes/test.md");
    let widget: ImageWidget | undefined;
    decorations.between(0, state.doc.length, (_f, _t, deco) => {
      if (deco.spec.widget instanceof ImageWidget) {
        widget = deco.spec.widget;
      }
    });
    expect(widget).toBeTruthy();
    expect(widget?.url).toBe("./local.png");
    expect(widget?.alt).toBe("alt text");
  });
});

describe("buildDecorations: task lists", () => {
  it("replaces unchecked and checked markers with CheckboxWidget regardless of cursor", () => {
    const doc = "- [ ] todo\n- [x] done";
    const state = stateFor(doc, 2); // cursor on the first task item's line
    const decorations = buildDecorations(state, [{ from: 0, to: state.doc.length }], "test.md");
    const widgets: CheckboxWidget[] = [];
    decorations.between(0, state.doc.length, (_f, _t, deco) => {
      if (deco.spec.widget instanceof CheckboxWidget) {
        widgets.push(deco.spec.widget);
      }
    });
    expect(widgets).toHaveLength(2);
    expect(widgets[0].checked).toBe(false);
    expect(widgets[1].checked).toBe(true);
  });
});

describe("buildDecorations: tables", () => {
  it("hides the row-level delimiter and marks header/cells", () => {
    const doc = "| A | B |\n| --- | --- |\n| 1 | 2 |\nsecond paragraph";
    const state = stateFor(doc, doc.length);
    const decos = collect(state);
    expect(decos.some((d) => d.class === "cm-table-header")).toBe(true);
    expect(decos.some((d) => d.class === "cm-table-cell")).toBe(true);
    // The delimiter row itself (`| --- | --- |`) should be hidden.
    const delimiterLineFrom = state.doc.line(2).from;
    const delimiterLineTo = state.doc.line(2).to;
    const hidesDelimiterLine = decos.some(
      (d) => d.isReplace && !d.class && d.from <= delimiterLineFrom && d.to >= delimiterLineTo,
    );
    expect(hidesDelimiterLine).toBe(true);
  });
});

describe("buildDecorations: round-trip safety", () => {
  it("never mutates document content", () => {
    const doc = "# Heading\n\n*em* **strong** `code` [link](url) ![img](url)\n\n- [ ] task\n\n| a | b |\n|---|---|\n| 1 | 2 |\n";
    const state = stateFor(doc, 0);
    buildDecorations(state, [{ from: 0, to: state.doc.length }], "test.md");
    expect(state.doc.toString()).toBe(doc);
  });
});

describe("markdownSourceExtensions", () => {
  const fixture =
    "# Heading\n\n*em* **strong** [link](https://example.com) ![img](./local.png)\n\n- [ ] task\n\n```js\nconst x = 1;\n```\n";

  it("keeps the markdown language's syntax tree (fenced code still gets nested highlighting)", () => {
    const state = EditorState.create({ doc: fixture, extensions: markdownSourceExtensions("test.md") });
    const seen = new Set<string>();
    syntaxTree(state).iterate({
      enter(ref) {
        seen.add(ref.name);
      },
    });
    expect(seen.has("ATXHeading1")).toBe(true);
    expect(seen.has("FencedCode")).toBe(true);
  });

  it("renders no decorations or interactive widgets — raw text, untouched", () => {
    const container = document.createElement("div");
    const view = new EditorView({
      state: EditorState.create({ doc: fixture, extensions: markdownSourceExtensions("test.md") }),
      parent: container,
    });
    expect(view.state.doc.toString()).toBe(fixture);
    expect(container.querySelector("input[type=checkbox]")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".cm-heading-1")).toBeNull();
    expect(container.querySelector(".cm-link")).toBeNull();
    expect(container.textContent).toContain("# Heading");
    expect(container.textContent).toContain("![img](./local.png)");
    view.destroy();
  });

  it("includes a line-number gutter", () => {
    const container = document.createElement("div");
    const view = new EditorView({
      state: EditorState.create({ doc: "line one\nline two\n", extensions: markdownSourceExtensions("test.md") }),
      parent: container,
    });
    expect(container.querySelector(".cm-lineNumbers")).not.toBeNull();
    view.destroy();
  });
});

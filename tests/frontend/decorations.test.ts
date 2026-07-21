import { describe, it, expect } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { buildDecorations, buildMermaidWidgetDecorations } from "../../src/lib/editor/markdown/decorations";
import { CheckboxWidget, ImageWidget, MermaidWidget } from "../../src/lib/editor/markdown/widgets";
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
  const alignedDoc =
    "| Name | Role | Score |\n| :--- | :---: | ---: |\n| Alice | Engineer | 92 |\n| Bob | Senior Staff Engineer | 8 |\n";

  it("gives header and body lines a cm-table-row line container", () => {
    const state = stateFor(alignedDoc, alignedDoc.length);
    const decos = collect(state);
    for (const lineNum of [1, 3, 4]) {
      const lineFrom = state.doc.line(lineNum).from;
      expect(decos.some((d) => d.class?.split(" ").includes("cm-table-row") && d.from === lineFrom)).toBe(true);
    }
  });

  it("hides the alignment-delimiter line entirely via display: none", () => {
    const state = stateFor(alignedDoc, alignedDoc.length);
    const decos = collect(state);
    const delimiterLine = state.doc.line(2);
    const hasContainer = decos.some(
      (d) => d.class?.split(" ").includes("cm-table-delimiter-line") && d.from === delimiterLine.from,
    );
    expect(hasContainer).toBe(true);
    const hidesContent = decos.some(
      (d) => d.isReplace && !d.class && d.from <= delimiterLine.from && d.to >= delimiterLine.to,
    );
    expect(hidesContent).toBe(true);
    // Never given a plain cm-table-row container — it's not a row.
    expect(decos.some((d) => d.class?.split(" ").includes("cm-table-row") && d.from === delimiterLine.from)).toBe(
      false,
    );
  });

  it("applies cm-table-header-cell only to header cells, not body cells", () => {
    const state = stateFor(alignedDoc, alignedDoc.length);
    const decos = collect(state);
    const headerCells = decos.filter((d) => d.class?.split(" ").includes("cm-table-header-cell"));
    expect(headerCells).toHaveLength(3);
    for (const cell of headerCells) {
      expect(state.doc.sliceString(cell.from, cell.to)).toMatch(/^(Name|Role|Score)$/);
    }
  });

  it("applies the correct per-column alignment class for :---, :---:, ---:, and plain ---", () => {
    const doc = "| L | C | R | P |\n| :--- | :---: | ---: | --- |\n| a | b | c | d |\n";
    const state = stateFor(doc, doc.length);
    const decos = collect(state);
    const bodyRowFrom = state.doc.line(3).from;
    const bodyRowTo = state.doc.line(3).to;
    const bodyCells = decos
      .filter((d) => d.class?.split(" ").includes("cm-table-cell") && d.from >= bodyRowFrom && d.to <= bodyRowTo)
      .sort((a, b) => a.from - b.from);
    expect(bodyCells).toHaveLength(4);
    expect(bodyCells[0].class?.split(" ")).not.toEqual(expect.arrayContaining(["cm-table-align-center", "cm-table-align-right"]));
    expect(bodyCells[1].class?.split(" ")).toContain("cm-table-align-center");
    expect(bodyCells[2].class?.split(" ")).toContain("cm-table-align-right");
    expect(bodyCells[3].class?.split(" ")).not.toEqual(expect.arrayContaining(["cm-table-align-center", "cm-table-align-right"]));
  });

  it("fully consumes the inter-cell gap, leaving no stray text node between cells", () => {
    const state = stateFor(alignedDoc, alignedDoc.length);
    const decos = collect(state);
    const headerLine = state.doc.line(1);
    const cellsAndReplaces = decos
      .filter((d) => d.from >= headerLine.from && d.to <= headerLine.to && (d.class?.split(" ").includes("cm-table-cell") || (d.isReplace && !d.class)))
      .sort((a, b) => a.from - b.from);
    // The whole line should be exactly covered, back to back, by alternating
    // hidden-gap replace decorations and cell marks — no gap, no overlap.
    let cursor = headerLine.from;
    for (const d of cellsAndReplaces) {
      expect(d.from).toBe(cursor);
      cursor = d.to;
    }
    expect(cursor).toBe(headerLine.to);
  });

  it("reveals raw pipes on the row under the cursor while other rows stay decorated", () => {
    const state = stateFor(alignedDoc, alignedDoc.indexOf("Alice"));
    const decos = collect(state);
    const aliceLine = state.doc.line(3);
    // The cursor's row keeps its cm-table-row container...
    expect(decos.some((d) => d.class?.split(" ").includes("cm-table-row") && d.from === aliceLine.from)).toBe(true);
    // ...but has no cell marks or hidden-gap replacements inside it.
    expect(
      decos.some(
        (d) =>
          d.from >= aliceLine.from &&
          d.to <= aliceLine.to &&
          (d.class?.split(" ").includes("cm-table-cell") || (d.isReplace && !d.class)),
      ),
    ).toBe(false);
    expect(state.doc.sliceString(aliceLine.from, aliceLine.to)).toBe("| Alice | Engineer | 92 |");

    // Every other row is still fully decorated.
    const bobLine = state.doc.line(4);
    expect(decos.some((d) => d.class?.split(" ").includes("cm-table-header-cell") && d.to <= state.doc.line(1).to))
      .toBe(true);
    expect(decos.some((d) => d.class?.split(" ").includes("cm-table-cell") && d.from >= bobLine.from && d.to <= bobLine.to)).toBe(
      true,
    );
  });

  it("keeps two separate tables' alignment independent", () => {
    const doc = "| A | B |\n| ---: | :--- |\n| 1 | 2 |\n\n| C | D |\n| :--- | ---: |\n| 3 | 4 |\n";
    const state = stateFor(doc, doc.length);
    const decos = collect(state);
    const firstBodyRow = state.doc.line(3);
    const secondBodyRow = state.doc.line(7);
    const firstCells = decos
      .filter(
        (d) =>
          d.class?.split(" ").includes("cm-table-cell") && d.from >= firstBodyRow.from && d.to <= firstBodyRow.to,
      )
      .sort((a, b) => a.from - b.from);
    const secondCells = decos
      .filter(
        (d) =>
          d.class?.split(" ").includes("cm-table-cell") && d.from >= secondBodyRow.from && d.to <= secondBodyRow.to,
      )
      .sort((a, b) => a.from - b.from);
    expect(firstCells[0].class?.split(" ")).toContain("cm-table-align-right");
    expect(firstCells[1].class?.split(" ")).not.toContain("cm-table-align-right");
    expect(secondCells[0].class?.split(" ")).not.toContain("cm-table-align-right");
    expect(secondCells[1].class?.split(" ")).toContain("cm-table-align-right");
  });
});

describe("buildDecorations: code blocks", () => {
  it("gives a fenced block a cm-code-block line decoration on every line, cursor elsewhere", () => {
    const doc = "prose\n\n```js\nconst x = 1;\n```\n\nmore prose";
    const state = stateFor(doc, 0); // cursor on the first "prose" line
    const decos = collect(state);
    for (const lineNum of [3, 4, 5]) {
      const lineFrom = state.doc.line(lineNum).from;
      expect(decos.some((d) => d.class === "cm-code-block" && d.from === lineFrom)).toBe(true);
    }
  });

  it("keeps the container decoration on a fenced block when the cursor is inside it", () => {
    const doc = "prose\n\n```js\nconst x = 1;\n```\n\nmore prose";
    const state = stateFor(doc, doc.indexOf("const x"));
    const decos = collect(state);
    for (const lineNum of [3, 4, 5]) {
      const lineFrom = state.doc.line(lineNum).from;
      expect(decos.some((d) => d.class === "cm-code-block" && d.from === lineFrom)).toBe(true);
    }
  });

  it("hides fence markers and the language tag when the cursor is elsewhere", () => {
    const doc = "```js\nconst x = 1;\n```\n\nafter";
    const state = stateFor(doc, doc.indexOf("after"));
    const decos = collect(state);
    const openLine = state.doc.line(1);
    const closeLine = state.doc.line(3);
    const hidesOpen = decos.some(
      (d) => d.isReplace && !d.class && d.from === openLine.from && d.to === openLine.to,
    );
    const hidesClose = decos.some(
      (d) => d.isReplace && !d.class && d.from === closeLine.from && d.to === closeLine.to,
    );
    expect(hidesOpen).toBe(true);
    expect(hidesClose).toBe(true);
  });

  it("reveals fence markers as raw text when the cursor is on the block", () => {
    const doc = "```js\nconst x = 1;\n```\n\nafter";
    const state = stateFor(doc, doc.indexOf("const x"));
    const decos = collect(state);
    const replaces = decos.filter((d) => d.isReplace && !d.class);
    expect(replaces).toHaveLength(0);
    expect(state.doc.toString()).toContain("```js");
    expect(state.doc.toString()).toContain("```\n");
  });

  it("gives an indented code block a container with nothing to hide", () => {
    const doc = "prose\n\n    def legacy():\n        return True\n\nmore";
    const state = stateFor(doc, 0); // cursor outside the block
    const decos = collect(state);
    for (const lineNum of [3, 4]) {
      const lineFrom = state.doc.line(lineNum).from;
      expect(decos.some((d) => d.class === "cm-code-block" && d.from === lineFrom)).toBe(true);
    }
    expect(decos.some((d) => d.isReplace && !d.class)).toBe(false);
  });

  it("doesn't double-hide an unterminated fence at EOF", () => {
    const doc = "prose\n\n```js\nconst x = 1;";
    const state = stateFor(doc, 0); // cursor on the "prose" line, outside the fence
    const decos = collect(state);
    for (const lineNum of [3, 4]) {
      const lineFrom = state.doc.line(lineNum).from;
      expect(decos.some((d) => d.class === "cm-code-block" && d.from === lineFrom)).toBe(true);
    }
    const replaces = decos.filter((d) => d.isReplace && !d.class);
    expect(replaces).toHaveLength(1);
  });

  it("hides a bare fence with no language tag using the openMark-only branch", () => {
    const doc = "```\nconst x = 1;\n```\n\nafter";
    const state = stateFor(doc, doc.indexOf("after"));
    const decos = collect(state);
    const openLine = state.doc.line(1);
    const closeLine = state.doc.line(3);
    expect(decos.some((d) => d.isReplace && !d.class && d.from === openLine.from && d.to === openLine.to)).toBe(
      true,
    );
    expect(decos.some((d) => d.isReplace && !d.class && d.from === closeLine.from && d.to === closeLine.to)).toBe(
      true,
    );
  });

  it("decorates two adjacent fenced blocks independently", () => {
    const doc = "```js\nconst a = 1;\n```\n```py\nb = 2\n```\n\nafter";
    const state = stateFor(doc, doc.indexOf("after"));
    const decos = collect(state);
    for (const lineNum of [1, 2, 3, 4, 5, 6]) {
      const lineFrom = state.doc.line(lineNum).from;
      expect(decos.some((d) => d.class === "cm-code-block" && d.from === lineFrom)).toBe(true);
    }
    const block1Open = state.doc.line(1);
    const block1Close = state.doc.line(3);
    const block2Open = state.doc.line(4);
    const block2Close = state.doc.line(6);
    for (const line of [block1Open, block1Close, block2Open, block2Close]) {
      expect(decos.some((d) => d.isReplace && !d.class && d.from === line.from && d.to === line.to)).toBe(true);
    }
  });

  it("decorates a fenced block and an indented block in the same document", () => {
    const doc = "```js\nconst a = 1;\n```\n\n    def legacy():\n        return True\n\nafter";
    const state = stateFor(doc, doc.indexOf("after"));
    const decos = collect(state);
    for (const lineNum of [1, 2, 3, 5, 6]) {
      const lineFrom = state.doc.line(lineNum).from;
      expect(decos.some((d) => d.class === "cm-code-block" && d.from === lineFrom)).toBe(true);
    }
    const fenceOpen = state.doc.line(1);
    const fenceClose = state.doc.line(3);
    expect(
      decos.some((d) => d.isReplace && !d.class && d.from === fenceOpen.from && d.to === fenceOpen.to),
    ).toBe(true);
    expect(
      decos.some((d) => d.isReplace && !d.class && d.from === fenceClose.from && d.to === fenceClose.to),
    ).toBe(true);
    // The indented block has no fence markup, so nothing within its two
    // lines should be replaced.
    const indentedFrom = state.doc.line(5).from;
    const indentedTo = state.doc.line(6).to;
    expect(decos.some((d) => d.isReplace && !d.class && d.from >= indentedFrom && d.to <= indentedTo)).toBe(false);
  });
});

/**
 * `MermaidWidget` decorations come from `buildMermaidWidgetDecorations` (a
 * `StateField`, per CodeMirror's own requirement that block-level replace
 * decorations can't come from a `ViewPlugin`) rather than `buildDecorations`
 * itself — see `mermaidWidgetSource`'s doc comment in `decorations.ts`.
 */
function collectMermaidWidgets(state: EditorState): CollectedDecoration[] {
  const decorations = buildMermaidWidgetDecorations(state);
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

describe("buildDecorations: mermaid fenced blocks", () => {
  it("replaces a mermaid block with a MermaidWidget spanning the full node when the cursor is elsewhere", () => {
    const doc = "prose\n\n```mermaid\ngraph TD;\nA-->B;\n```\n\nafter";
    const state = stateFor(doc, 0); // cursor on the "prose" line, outside the block

    const widgetDeco = collectMermaidWidgets(state).find((d) => d.widget instanceof MermaidWidget);
    expect(widgetDeco).toBeTruthy();
    const widget = widgetDeco!.widget as MermaidWidget;
    expect(widget.source).toBe("graph TD;\nA-->B;");

    const openFence = state.doc.line(3); // "```mermaid"
    const closeFence = state.doc.line(6); // "```"
    expect(widgetDeco!.from).toBe(openFence.from);
    expect(widgetDeco!.to).toBe(closeFence.to);

    // The block is fully replaced: no leftover cm-code-block container or
    // fence-hiding decoration underneath it in the regular decoration set.
    const decos = collect(state);
    expect(decos.some((d) => d.class === "cm-code-block" && d.from >= openFence.from && d.from <= closeFence.from)).toBe(
      false,
    );
  });

  it("falls back to normal fenced-code decorations when the cursor is on the mermaid block", () => {
    const doc = "```mermaid\ngraph TD;\nA-->B;\n```\n\nafter";
    const state = stateFor(doc, doc.indexOf("A-->B"));

    expect(collectMermaidWidgets(state)).toHaveLength(0);

    const decos = collect(state);
    const openLine = state.doc.line(1);
    const closeLine = state.doc.line(4);
    expect(decos.some((d) => d.class === "cm-code-block" && d.from === openLine.from)).toBe(true);
    expect(decos.some((d) => d.class === "cm-code-block" && d.from === closeLine.from)).toBe(true);
    // Cursor is on the block, so the fence markers stay revealed as raw text.
    expect(decos.some((d) => d.isReplace && !d.class && d.from === openLine.from && d.to === openLine.to)).toBe(
      false,
    );
  });

  it("leaves a non-mermaid fenced block completely unaffected", () => {
    const doc = "```js\nconst x = 1;\n```\n\nafter";
    const state = stateFor(doc, doc.indexOf("after"));

    expect(collectMermaidWidgets(state)).toHaveLength(0);

    const decos = collect(state);
    const openLine = state.doc.line(1);
    const closeLine = state.doc.line(3);
    expect(decos.some((d) => d.class === "cm-code-block" && d.from === openLine.from)).toBe(true);
    expect(decos.some((d) => d.isReplace && !d.class && d.from === openLine.from && d.to === openLine.to)).toBe(true);
    expect(decos.some((d) => d.isReplace && !d.class && d.from === closeLine.from && d.to === closeLine.to)).toBe(
      true,
    );
  });

  it("finds a mermaid block nested inside a blockquote or list item", () => {
    const doc = "> ```mermaid\n> graph TD;\n> A-->B;\n> ```\n\n- item\n\n  ```mermaid\n  graph TD;\n  C-->D;\n  ```\n";
    const state = stateFor(doc, doc.indexOf("item")); // cursor outside both fenced blocks
    const widgets = collectMermaidWidgets(state).filter((d) => d.widget instanceof MermaidWidget);
    expect(widgets).toHaveLength(2);
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
    "# Heading\n\n*em* **strong** [link](https://example.com) ![img](./local.png)\n\n- [ ] task\n\n```js\nconst x = 1;\n```\n\n```mermaid\ngraph TD;\nA-->B;\n```\n";

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

  it("renders a mermaid block as plain unrendered text, with no diagram or error DOM at all", () => {
    const container = document.createElement("div");
    const view = new EditorView({
      state: EditorState.create({ doc: fixture, extensions: markdownSourceExtensions("test.md") }),
      parent: container,
    });
    expect(container.querySelector(".cm-mermaid-diagram")).toBeNull();
    expect(container.querySelector(".cm-mermaid-error")).toBeNull();
    expect(container.querySelector("svg")).toBeNull();
    expect(container.textContent).toContain("```mermaid");
    expect(container.textContent).toContain("graph TD;");
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

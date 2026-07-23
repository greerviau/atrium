import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EditorState, EditorSelection } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { buildDecorations, buildMermaidWidgetDecorations } from "../../src/lib/editor/markdown/decorations";
import { CheckboxWidget, ImageWidget, ListBulletWidget, ListMarkerWidget, MermaidWidget } from "../../src/lib/editor/markdown/widgets";
import { markdownSourceExtensions } from "../../src/lib/editor/markdown/livePreviewPlugin";

const markdownCss = readFileSync(resolve(__dirname, "../../src/styles/markdown.css"), "utf-8");

function ruleBodyFor(selector: string): string {
  const match = markdownCss.match(new RegExp(`${selector.replace(/\./g, "\\.")}\\s*{([^}]*)}`));
  if (!match) throw new Error(`no rule found for selector ${selector}`);
  return match[1];
}

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
  tableGap?: boolean;
}

function collect(state: EditorState, documentPath = "test.md", hasFocus = true): CollectedDecoration[] {
  const decorations = buildDecorations(state, [{ from: 0, to: state.doc.length }], documentPath, hasFocus);
  const out: CollectedDecoration[] = [];
  decorations.between(0, state.doc.length, (from, to, deco) => {
    out.push({
      from,
      to,
      class: deco.spec.class,
      isReplace: (deco as unknown as { isReplace: boolean }).isReplace,
      tableGap: deco.spec.tableGap,
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

  it("keeps the heading class over the whole node, marker included, when the cursor is on its line", () => {
    const doc = "# Hello\nSecond line";
    const state = stateFor(doc, 3); // cursor inside "Hello"
    const decos = collect(state);
    const headingDeco = decos.find((d) => d.class === "cm-heading-1");
    expect(headingDeco).toBeTruthy();
    expect(headingDeco?.from).toBe(0); // start of "# Hello", marker included
    expect(headingDeco?.to).toBe(7); // end of "Hello"
  });

  it("doesn't hide the `#` marker while the cursor is on the heading line", () => {
    const doc = "# Hello\nSecond line";
    const state = stateFor(doc, 3); // cursor inside "Hello"
    const decos = collect(state);
    expect(decos.some((d) => d.isReplace && !d.class)).toBe(false);
    expect(state.doc.toString()).toContain("# Hello");
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

  it("keeps emphasis/strong styled and reveals delimiters when the cursor is on their line", () => {
    const doc = "plain *em* and **strong** text\nsecond line";
    const state = stateFor(doc, doc.indexOf("em"));
    const decos = collect(state);
    expect(decos.some((d) => d.class === "cm-em")).toBe(true);
    expect(decos.some((d) => d.class === "cm-strong")).toBe(true);
    expect(decos.some((d) => d.isReplace && !d.class)).toBe(false);
    expect(state.doc.toString()).toContain("*em*");
    expect(state.doc.toString()).toContain("**strong**");
  });
});

describe("buildDecorations: strikethrough", () => {
  it("marks strikethrough text and hides delimiters when the cursor is elsewhere", () => {
    const doc = "plain ~~gone~~ text\nsecond line";
    const state = stateFor(doc, doc.length);
    const decos = collect(state);
    expect(decos.some((d) => d.class === "cm-strikethrough")).toBe(true);
    expect(decos.some((d) => d.isReplace && !d.class)).toBe(true);
  });

  it("keeps strikethrough styled and reveals delimiters when the cursor is on its line", () => {
    const doc = "plain ~~gone~~ text\nsecond line";
    const state = stateFor(doc, doc.indexOf("gone"));
    const decos = collect(state);
    expect(decos.some((d) => d.class === "cm-strikethrough")).toBe(true);
    expect(decos.some((d) => d.isReplace && !d.class)).toBe(false);
    expect(state.doc.toString()).toContain("~~gone~~");
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

  it("keeps inline code styled and reveals backticks when the cursor is on its line", () => {
    const doc = "use `code` here\nsecond line";
    const state = stateFor(doc, doc.indexOf("code"));
    const decos = collect(state);
    expect(decos.some((d) => d.class === "cm-inline-code")).toBe(true);
    expect(decos.some((d) => d.isReplace && !d.class)).toBe(false);
    expect(state.doc.toString()).toContain("`code`");
  });
});

describe("buildDecorations: escapes", () => {
  it("hides the backslash of an escaped pipe in a table cell, leaving the literal pipe visible", () => {
    const doc = "| a\\|b | normal |\n| --- | --- |\n| x | y |\n";
    const state = stateFor(doc, doc.length); // cursor elsewhere
    const decos = collect(state);
    const backslashPos = doc.indexOf("\\");
    const hidesBackslash = decos.some(
      (d) => d.isReplace && !d.class && d.from === backslashPos && d.to === backslashPos + 1,
    );
    expect(hidesBackslash).toBe(true);
    // Sanity: the cell's raw source still contains the pipe right after the backslash.
    expect(state.doc.sliceString(backslashPos, backslashPos + 2)).toBe("\\|");
  });

  it("reveals the raw backslash while the cursor is in the cell containing the escape", () => {
    const doc = "| a\\|b | normal |\n| --- | --- |\n| x | y |\n";
    const backslashPos = doc.indexOf("\\");
    const state = stateFor(doc, backslashPos + 1); // cursor inside the cell, right after the backslash
    const decos = collect(state);
    const hidesBackslash = decos.some(
      (d) => d.isReplace && !d.class && d.from === backslashPos && d.to === backslashPos + 1,
    );
    expect(hidesBackslash).toBe(false);
    expect(state.doc.sliceString(backslashPos, backslashPos + 2)).toBe("\\|");
  });

  it("keeps a sibling cell's escape hidden when the cursor is elsewhere in the same row", () => {
    const doc = "| a\\|b | normal |\n| --- | --- |\n| x | y |\n";
    const backslashPos = doc.indexOf("\\");
    const state = stateFor(doc, doc.indexOf("normal") + 1); // cursor in the other cell on the same row
    const decos = collect(state);
    const hidesBackslash = decos.some(
      (d) => d.isReplace && !d.class && d.from === backslashPos && d.to === backslashPos + 1,
    );
    expect(hidesBackslash).toBe(true);
  });

  it("hides an escaped character's backslash outside of a table too", () => {
    const doc = "plain \\*text\\* here\nsecond line";
    const state = stateFor(doc, doc.length); // cursor elsewhere
    const decos = collect(state);
    const firstBackslash = doc.indexOf("\\");
    const secondBackslash = doc.indexOf("\\", firstBackslash + 1);
    expect(decos.some((d) => d.isReplace && !d.class && d.from === firstBackslash && d.to === firstBackslash + 1)).toBe(
      true,
    );
    expect(
      decos.some((d) => d.isReplace && !d.class && d.from === secondBackslash && d.to === secondBackslash + 1),
    ).toBe(true);
  });

  it("leaves a backslash followed by a non-punctuation character untouched (no Escape node, parser behavior)", () => {
    const doc = "plain \\A text\nsecond line";
    const state = stateFor(doc, doc.length);
    const decos = collect(state);
    const backslashPos = doc.indexOf("\\");
    expect(decos.some((d) => d.isReplace && !d.class && d.from === backslashPos && d.to === backslashPos + 1)).toBe(
      false,
    );
    expect(state.doc.sliceString(backslashPos, backslashPos + 2)).toBe("\\A");
  });
});

describe("buildDecorations: nested/composited inline constructs under the cursor", () => {
  it("decorates a heading and its nested bold text together when the cursor is on that line", () => {
    const doc = "# Heading with **bold** text\nsecond line";
    const state = stateFor(doc, doc.indexOf("bold"));
    const decos = collect(state);

    const headingDeco = decos.find((d) => d.class === "cm-heading-1");
    expect(headingDeco).toBeTruthy();
    expect(headingDeco?.from).toBe(0);
    expect(headingDeco?.to).toBe(doc.indexOf("\n"));

    const strongDeco = decos.find((d) => d.class === "cm-strong");
    expect(strongDeco).toBeTruthy();
    expect(state.doc.sliceString(strongDeco!.from, strongDeco!.to)).toBe("**bold**");

    expect(decos.some((d) => d.isReplace && !d.class)).toBe(false);
  });

  it("decorates nested emphasis inside strong text together when the cursor is on that line", () => {
    const doc = "**bold and *italic* together**\nsecond line";
    const state = stateFor(doc, doc.indexOf("italic"));
    const decos = collect(state);

    expect(decos.some((d) => d.class === "cm-strong")).toBe(true);
    expect(decos.some((d) => d.class === "cm-em")).toBe(true);
    expect(decos.some((d) => d.isReplace && !d.class)).toBe(false);
  });
});

describe("buildDecorations: links", () => {
  it("hides brackets/url and marks the link text with the target url", () => {
    const doc = "[click here](https://example.com/page)\nsecond line";
    const state = stateFor(doc, doc.length);
    const decorations = buildDecorations(state, [{ from: 0, to: state.doc.length }], "test.md", true);
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

  it("still fully un-renders (no cm-link decoration) when the cursor is on the link's line", () => {
    const doc = "[click here](https://example.com/page)\nsecond line";
    const state = stateFor(doc, doc.indexOf("click"));
    const decos = collect(state);
    expect(decos.some((d) => d.class === "cm-link")).toBe(false);
    expect(state.doc.toString()).toContain("[click here](https://example.com/page)");
  });
});

describe("buildDecorations: images", () => {
  it("replaces the whole image node with an ImageWidget", () => {
    const doc = "![alt text](./local.png)\nsecond line";
    const state = stateFor(doc, doc.length);
    const decorations = buildDecorations(state, [{ from: 0, to: state.doc.length }], "notes/test.md", true);
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

  it("still fully un-renders (no ImageWidget) when the cursor is on the image's line", () => {
    const doc = "![alt text](./local.png)\nsecond line";
    const state = stateFor(doc, doc.indexOf("alt"));
    const decorations = buildDecorations(state, [{ from: 0, to: state.doc.length }], "notes/test.md", true);
    let widget: ImageWidget | undefined;
    decorations.between(0, state.doc.length, (_f, _t, deco) => {
      if (deco.spec.widget instanceof ImageWidget) {
        widget = deco.spec.widget;
      }
    });
    expect(widget).toBeUndefined();
    expect(state.doc.toString()).toContain("![alt text](./local.png)");
  });
});

describe("buildDecorations: reference-style links and images (issue #196)", () => {
  function linkHrefFor(doc: string): string | undefined {
    const state = stateFor(doc, doc.length);
    const decorations = buildDecorations(state, [{ from: 0, to: state.doc.length }], "test.md", true);
    let href: string | undefined;
    decorations.between(0, state.doc.length, (_f, _t, deco) => {
      if (deco.spec.class === "cm-link") {
        href = deco.spec.attributes?.["data-href"];
      }
    });
    return href;
  }

  function imageWidgetFor(doc: string): ImageWidget | undefined {
    const state = stateFor(doc, doc.length);
    const decorations = buildDecorations(state, [{ from: 0, to: state.doc.length }], "test.md", true);
    let widget: ImageWidget | undefined;
    decorations.between(0, state.doc.length, (_f, _t, deco) => {
      if (deco.spec.widget instanceof ImageWidget) {
        widget = deco.spec.widget;
      }
    });
    return widget;
  }

  it("resolves a full reference link ([text][label]) to its definition's URL", () => {
    const doc = 'See [my link][ref] for more.\n\n[ref]: https://example.com "Title"';
    expect(linkHrefFor(doc)).toBe("https://example.com");
  });

  it("resolves a collapsed reference link ([label][]) to its definition's URL", () => {
    const doc = 'See [ref][] for more.\n\n[ref]: https://example.com "Title"';
    expect(linkHrefFor(doc)).toBe("https://example.com");
  });

  it("resolves a shortcut reference link ([label]) to its definition's URL", () => {
    const doc = 'See [ref] for more.\n\n[ref]: https://example.com "Title"';
    expect(linkHrefFor(doc)).toBe("https://example.com");
  });

  it("resolves a reference link even when its definition appears after the citing paragraph", () => {
    const doc = "See [my link][ref] for more.\n\nSome other paragraph.\n\n[ref]: https://example.com";
    expect(linkHrefFor(doc)).toBe("https://example.com");
  });

  it.each([
    ["full", "![alt][ref]"],
    ["collapsed", "![ref][]"],
    ["shortcut", "![ref]"],
  ])("renders a %s reference-style image with the resolved URL instead of leaving raw source visible", (_label, syntax) => {
    const doc = `See ${syntax} for more.\n\n[ref]: https://example.com/img.png`;
    const widget = imageWidgetFor(doc);
    expect(widget).toBeTruthy();
    expect(widget?.url).toBe("https://example.com/img.png");
  });

  it("keeps today's behavior for a dangling link reference: empty data-href, no crash", () => {
    const doc = "See [my link][missing] for more.\nsecond line";
    expect(linkHrefFor(doc)).toBe("");
  });

  it("keeps today's behavior for a dangling image reference: raw source stays visible", () => {
    const doc = "See ![alt][missing] for more.\nsecond line";
    const imageFrom = doc.indexOf("![alt][missing]");
    const imageTo = imageFrom + "![alt][missing]".length;
    expect(imageWidgetFor(doc)).toBeUndefined();
    // No decoration replaces the image's own source range, so it stays
    // visible as plain text rather than being hidden by anything else.
    const decos = collect(stateFor(doc, doc.length));
    expect(decos.some((d) => d.isReplace && d.from <= imageFrom && d.to >= imageTo)).toBe(false);
  });

  it("resolves duplicate labels to the first definition's URL, per CommonMark's first-wins rule", () => {
    const doc = "[a][x]\n\n[x]: https://first.com\n[x]: https://second.com";
    expect(linkHrefFor(doc)).toBe("https://first.com");
  });

  it("resolves a reference link whose definition sits inside a blockquote", () => {
    const doc = "See [my link][ref] for more.\n\n> [ref]: https://example.com";
    expect(linkHrefFor(doc)).toBe("https://example.com");
  });

  it("resolves a reference link whose definition sits inside a list item", () => {
    const doc = "See [my link][ref] for more.\n\n- [ref]: https://example.com";
    expect(linkHrefFor(doc)).toBe("https://example.com");
  });
});

describe("buildDecorations: task lists", () => {
  it("replaces unchecked and checked markers with CheckboxWidget regardless of cursor", () => {
    const doc = "- [ ] todo\n- [x] done";
    const state = stateFor(doc, 2); // cursor on the first task item's line
    const decorations = buildDecorations(state, [{ from: 0, to: state.doc.length }], "test.md", true);
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

  // Regression coverage for issue #110's must-fix round 2: the markdown
  // parser gives an empty cell no `TableCell` node at all, so a row with an
  // empty cell used to have its interior swallowed into the surrounding
  // `tableGap` replace decoration, which both skewed every later column's
  // alignment index (this test) and made the empty cell itself unreachable
  // and unfillable (covered end-to-end in livePreviewPlugin.test.ts).
  it("gives an empty middle cell its own cm-table-cell mark, keeping later columns' alignment correct", () => {
    const doc = "| A | B | C |\n| --- | --- | ---: |\n| Dan |  | 55 |\n";
    const state = stateFor(doc, doc.length);
    const decos = collect(state);
    const bodyLine = state.doc.line(3);
    const bodyCells = decos
      .filter((d) => d.class?.split(" ").includes("cm-table-cell") && d.from >= bodyLine.from && d.to <= bodyLine.to)
      .sort((a, b) => a.from - b.from);

    // Three columns, including the empty one — not two.
    expect(bodyCells).toHaveLength(3);
    expect(state.doc.sliceString(bodyCells[0].from, bodyCells[0].to)).toBe("Dan");
    expect(state.doc.sliceString(bodyCells[1].from, bodyCells[1].to).trim()).toBe("");
    expect(state.doc.sliceString(bodyCells[2].from, bodyCells[2].to)).toBe("55");

    // "55" is column C (right-aligned) — not skewed onto column B's (default) alignment.
    expect(bodyCells[2].class?.split(" ")).toContain("cm-table-align-right");
  });

  it("doesn't break gap coverage on a zero-width empty cell (adjacent pipes, no space at all)", () => {
    // The synthesized slot for this cell has zero width (nothing sits
    // between its two bordering pipes), so — unlike a whitespace-padded
    // empty cell — it gets no cm-table-cell mark of its own (a zero-length
    // mark decoration isn't meaningful); this only asserts that the two
    // adjacent gaps still tile the row with no stray undecorated text.
    const doc = "| A | B |\n| --- | --- |\n| x||\n";
    const state = stateFor(doc, doc.length);
    const decos = collect(state);
    const bodyLine = state.doc.line(3);
    const cellsAndGaps = decos
      .filter(
        (d) => d.from >= bodyLine.from && d.to <= bodyLine.to && (d.class?.split(" ").includes("cm-table-cell") || d.tableGap),
      )
      .sort((a, b) => a.from - b.from);
    let pos = bodyLine.from;
    for (const d of cellsAndGaps) {
      expect(d.from).toBe(pos);
      pos = d.to;
    }
    expect(pos).toBe(bodyLine.to);
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

  // Regression coverage for issue #110: every gap on a row is a `tableGap`
  // replace decoration and is never left as bare inline text, regardless of
  // where the cursor sits. Bare inline text between two `cm-table-cell`
  // marks is exactly what the browser turns into a stray anonymous
  // table-cell, which is what forced every row's later columns to shift
  // right (see `decorateTableRow`'s docstring). This runs across the same
  // cursor positions that the pre-fix code used to special-case (inside the
  // first/last cell of the row, exactly on a cell/gap boundary, and inside a
  // gap directly) to confirm none of them can reopen the leak.
  it.each([
    ["cursor elsewhere", alignedDoc.length],
    ["cursor inside the row's first cell", alignedDoc.indexOf("Alice") + 1],
    ["cursor inside the row's last cell", alignedDoc.lastIndexOf("92") + 1],
    ["cursor exactly on a cell/gap boundary", alignedDoc.indexOf("Alice") + "Alice".length],
    ["cursor directly inside a gap", alignedDoc.indexOf("Alice") + "Alice".length + 2],
  ])("keeps every gap on a row hidden and tagged tableGap, with no undecorated text between cells (%s)", (_label, cursor) => {
    const state = stateFor(alignedDoc, cursor);
    const decos = collect(state);
    const aliceLine = state.doc.line(3);
    const cellsAndGaps = decos
      .filter(
        (d) => d.from >= aliceLine.from && d.to <= aliceLine.to && (d.class?.split(" ").includes("cm-table-cell") || d.tableGap),
      )
      .sort((a, b) => a.from - b.from);

    let pos = aliceLine.from;
    for (const d of cellsAndGaps) {
      expect(d.from).toBe(pos);
      pos = d.to;
    }
    expect(pos).toBe(aliceLine.to);

    // Every gap-covering decoration found above is specifically tagged
    // tableGap (not some other unrelated replace decoration), which is the
    // tag `EditorView.atomicRanges` reads to make the cursor skip over it.
    const gaps = cellsAndGaps.filter((d) => !d.class?.split(" ").includes("cm-table-cell"));
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps.every((d) => d.tableGap)).toBe(true);
  });

  // Regression coverage for issue #126's second root cause: a table row's
  // container decoration is applied to the whole physical line, but the row
  // node itself starts partway through that line whenever a blockquote `>`
  // marker or list-item indentation precedes it — everything between the
  // line's start and the row node's own start used to be left completely
  // uncovered by decorateTableRow's gap computation, leaking as bare text
  // inside a `display: table-row` line (a phantom leading column once the
  // browser computes layout). Anchoring the gap computation at the physical
  // line's start instead of the row node's own start folds that leading
  // span into the same leading tableGap decoration.
  describe("nested in a blockquote or list (issue #126 phantom leading column)", () => {
    it("covers the blockquote marker with a leading tableGap, tiling the header row with no gap", () => {
      const doc = "> | A | B |\n| --- | --- |\n| 1 | 2 |\n";
      const state = stateFor(doc, doc.length);
      const decos = collect(state);
      const headerLine = state.doc.line(1);

      const cellsAndGaps = decos
        .filter(
          (d) =>
            d.from >= headerLine.from && d.to <= headerLine.to && (d.class?.split(" ").includes("cm-table-cell") || d.tableGap),
        )
        .sort((a, b) => a.from - b.from);

      // The leading tableGap starts exactly at the physical line's start —
      // covering the "> " marker — not at the row node's own (later) start.
      const leadingGap = cellsAndGaps[0];
      expect(leadingGap.tableGap).toBe(true);
      expect(leadingGap.from).toBe(headerLine.from);

      // No stray undecorated text anywhere on the row: gaps and cells tile
      // the whole physical line back to back.
      let pos = headerLine.from;
      for (const d of cellsAndGaps) {
        expect(d.from).toBe(pos);
        pos = d.to;
      }
      expect(pos).toBe(headerLine.to);
    });

    it("covers the blockquote's lazy-continuation body row too, with no phantom column", () => {
      const doc = "> | A | B |\n| --- | --- |\n| 1 | 2 |\n";
      const state = stateFor(doc, doc.length);
      const decos = collect(state);
      const bodyLine = state.doc.line(3);

      const cellsAndGaps = decos
        .filter(
          (d) =>
            d.from >= bodyLine.from && d.to <= bodyLine.to && (d.class?.split(" ").includes("cm-table-cell") || d.tableGap),
        )
        .sort((a, b) => a.from - b.from);
      let pos = bodyLine.from;
      for (const d of cellsAndGaps) {
        expect(d.from).toBe(pos);
        pos = d.to;
      }
      expect(pos).toBe(bodyLine.to);
    });

    it("covers a list item's leading indentation with a leading tableGap, no phantom column", () => {
      const doc = "- item\n\n  | A | B |\n  | --- | --- |\n  | 1 | 2 |\n";
      const state = stateFor(doc, doc.length);
      const decos = collect(state);
      const headerLine = state.doc.line(3);

      const cellsAndGaps = decos
        .filter(
          (d) =>
            d.from >= headerLine.from && d.to <= headerLine.to && (d.class?.split(" ").includes("cm-table-cell") || d.tableGap),
        )
        .sort((a, b) => a.from - b.from);

      const leadingGap = cellsAndGaps[0];
      expect(leadingGap.tableGap).toBe(true);
      expect(leadingGap.from).toBe(headerLine.from);

      let pos = headerLine.from;
      for (const d of cellsAndGaps) {
        expect(d.from).toBe(pos);
        pos = d.to;
      }
      expect(pos).toBe(headerLine.to);
    });

    it("leaves a plain top-level table's gap computation byte-identical (no-op in the common case)", () => {
      // For a top-level table, node.from already equals the physical line's
      // start, so anchoring the gap computation there instead is a no-op —
      // this guards that claim by re-asserting the exact same full-line
      // tiling the pre-fix suite already established for a top-level table.
      const state = stateFor(alignedDoc, alignedDoc.length);
      const decos = collect(state);
      const headerLine = state.doc.line(1);
      const cellsAndGaps = decos
        .filter(
          (d) =>
            d.from >= headerLine.from && d.to <= headerLine.to && (d.class?.split(" ").includes("cm-table-cell") || d.tableGap),
        )
        .sort((a, b) => a.from - b.from);
      expect(cellsAndGaps[0].from).toBe(headerLine.from);
      let pos = headerLine.from;
      for (const d of cellsAndGaps) {
        expect(d.from).toBe(pos);
        pos = d.to;
      }
      expect(pos).toBe(headerLine.to);
    });
  });

  it("keeps every cell in a row decorated regardless of cursor position, gaps included", () => {
    const engineerFrom = alignedDoc.indexOf("Engineer");
    const engineerTo = engineerFrom + "Engineer".length;
    const state = stateFor(alignedDoc, engineerFrom + 1); // cursor inside "Engineer"
    const decos = collect(state);
    const aliceLine = state.doc.line(3);

    // The row still keeps its cm-table-row container.
    expect(decos.some((d) => d.class?.split(" ").includes("cm-table-row") && d.from === aliceLine.from)).toBe(true);
    expect(state.doc.sliceString(aliceLine.from, aliceLine.to)).toBe("| Alice | Engineer | 92 |");

    // "Engineer" itself keeps its cell mark...
    expect(
      decos.some(
        (d) => d.class?.split(" ").includes("cm-table-cell") && d.from === engineerFrom && d.to === engineerTo,
      ),
    ).toBe(true);

    // ...and "Alice" and "92" — the other two cells on the same row — keep theirs too.
    const aliceFrom = alignedDoc.indexOf("Alice");
    const aliceTo = aliceFrom + "Alice".length;
    expect(
      decos.some((d) => d.class?.split(" ").includes("cm-table-cell") && d.from === aliceFrom && d.to === aliceTo),
    ).toBe(true);
    const scoreFrom = alignedDoc.lastIndexOf("92");
    const scoreTo = scoreFrom + "92".length;
    expect(
      decos.some(
        (d) =>
          d.class?.split(" ").includes("cm-table-cell") &&
          d.class?.split(" ").includes("cm-table-align-right") &&
          d.from === scoreFrom &&
          d.to === scoreTo,
      ),
    ).toBe(true);

    // The gaps bordering "Engineer" (on both sides) stay hidden — same as
    // with the cursor anywhere else, since gaps are never cursor-gated.
    expect(decos.some((d) => d.tableGap && d.from === aliceTo && d.to === engineerFrom)).toBe(true);
    expect(decos.some((d) => d.tableGap && d.from === engineerTo && d.to === scoreFrom)).toBe(true);

    // Every other row is still fully decorated.
    const bobLine = state.doc.line(4);
    expect(decos.some((d) => d.class?.split(" ").includes("cm-table-header-cell") && d.to <= state.doc.line(1).to))
      .toBe(true);
    expect(
      decos.some((d) => d.class?.split(" ").includes("cm-table-cell") && d.from >= bobLine.from && d.to <= bobLine.to),
    ).toBe(true);
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

  it("renders bold/italic nested inside a table cell instead of leaving raw asterisks (#74)", () => {
    const doc = "| Name | Role |\n| --- | --- |\n| **Alice** | *Engineer* |\n";
    const state = stateFor(doc, doc.length); // cursor away from the table
    const decos = collect(state);

    const strongDeco = decos.find((d) => d.class === "cm-strong");
    expect(strongDeco).toBeTruthy();
    expect(state.doc.sliceString(strongDeco!.from, strongDeco!.to)).toBe("**Alice**");

    const emDeco = decos.find((d) => d.class === "cm-em");
    expect(emDeco).toBeTruthy();
    expect(state.doc.sliceString(emDeco!.from, emDeco!.to)).toBe("*Engineer*");

    // The `**`/`*` marks are hidden via zero-content replace decorations, same as prose.
    const replaces = decos.filter((d) => d.isReplace && !d.class);
    expect(replaces.length).toBeGreaterThanOrEqual(4);
  });

  it("reveals a table cell's emphasis markers on the cursor's cell while other rows stay decorated", () => {
    const doc = "| Name | Role |\n| --- | --- |\n| **Alice** | *Engineer* |\n| **Bob** | *Manager* |\n";
    const state = stateFor(doc, doc.indexOf("Alice"));
    const decos = collect(state);
    const bobLine = state.doc.line(4);

    // The cursor's own cell keeps its cm-table-cell wrapping, and the nested strong
    // decoration still applies, with its `**` marks left visible. This only asserts
    // about the cursor's own cell; whether a same-row sibling cell's own markup
    // stays hidden is covered separately below ("keeps a sibling cell's emphasis
    // delimiters hidden when the cursor is elsewhere in the same row").
    const aliceStrong = decos.find((d) => d.class === "cm-strong");
    expect(aliceStrong).toBeTruthy();
    expect(state.doc.sliceString(aliceStrong!.from, aliceStrong!.to)).toBe("**Alice**");
    expect(
      decos.some(
        (d) =>
          d.class?.split(" ").includes("cm-table-cell") &&
          d.from <= aliceStrong!.from &&
          d.to >= aliceStrong!.to,
      ),
    ).toBe(true);

    // A different row in the same table still renders normally, no cross-row leakage.
    const bobStrong = decos.find((d) => d.class === "cm-strong" && d.from >= bobLine.from && d.to <= bobLine.to);
    expect(bobStrong).toBeTruthy();
    expect(state.doc.sliceString(bobStrong!.from, bobStrong!.to)).toBe("**Bob**");
    expect(
      decos.some(
        (d) => d.class?.split(" ").includes("cm-table-cell") && d.from >= bobLine.from && d.to <= bobLine.to,
      ),
    ).toBe(true);
  });

  // Regression coverage for issue #126's primary root cause: a table row is
  // one physical line shared by several independent cells, so gating an
  // inline node's reveal on the whole line (the old `isUnderCursor` check)
  // reveals a sibling cell's markup whenever the cursor sits anywhere else
  // on that row — widening every column in every row, since column widths
  // are computed jointly across the table. `isRevealTarget` narrows the
  // check to the enclosing cell instead.
  it("keeps a sibling cell's emphasis delimiters hidden when the cursor is elsewhere in the same row", () => {
    const doc = "| Name | Notes |\n| --- | --- |\n| Alice | Leads the **platform** team |\n";
    const state = stateFor(doc, doc.indexOf("Alice") + 1); // cursor in Name, not Notes
    const decos = collect(state);

    const strongDeco = decos.find((d) => d.class === "cm-strong");
    expect(strongDeco).toBeTruthy();
    expect(state.doc.sliceString(strongDeco!.from, strongDeco!.to)).toBe("**platform**");

    // The Notes cell's `**` delimiters stay hidden — the cursor sitting in
    // Name (a different cell on the same row) must not reveal them.
    const notesLine = state.doc.line(3);
    const hiddenMarksInNotes = decos.filter(
      (d) => d.isReplace && !d.class && d.from >= notesLine.from && d.to <= notesLine.to && d.from >= strongDeco!.from && d.to <= strongDeco!.to,
    );
    expect(hiddenMarksInNotes.length).toBeGreaterThanOrEqual(2);
  });

  it("reveals a cell's own emphasis delimiters when the cursor is actually inside that cell", () => {
    const doc = "| Name | Notes |\n| --- | --- |\n| Alice | Leads the **platform** team |\n";
    const state = stateFor(doc, doc.indexOf("platform") + 1); // cursor inside Notes itself
    const decos = collect(state);

    const strongDeco = decos.find((d) => d.class === "cm-strong");
    expect(strongDeco).toBeTruthy();
    expect(state.doc.sliceString(strongDeco!.from, strongDeco!.to)).toBe("**platform**");

    // No hidden replace decoration overlaps the strong node's own range —
    // its `**` delimiters are left visible, unchanged from today's behavior.
    const hiddenMarksInStrong = decos.filter(
      (d) => d.isReplace && !d.class && d.from >= strongDeco!.from && d.to <= strongDeco!.to,
    );
    expect(hiddenMarksInStrong).toHaveLength(0);
  });

  it("renders a link nested inside a table cell with cm-link (same underlying defect as #74)", () => {
    const doc = "| Name | Site |\n| --- | --- |\n| Alice | [site](https://x.com) |\n";
    const state = stateFor(doc, doc.length); // cursor away from the table
    const decorations = buildDecorations(state, [{ from: 0, to: state.doc.length }], "test.md", true);
    let found: { from: number; to: number; href?: string } | undefined;
    decorations.between(0, state.doc.length, (from, to, deco) => {
      if (deco.spec.class === "cm-link") {
        found = { from, to, href: deco.spec.attributes?.["data-href"] };
      }
    });
    expect(found).toBeTruthy();
    expect(found?.href).toBe("https://x.com");
    expect(state.doc.sliceString(found!.from, found!.to)).toBe("site");
  });

  // Same regression as the emphasis case above, but for the Link switch
  // branch in buildDecorations, which gates through isRevealTarget directly
  // rather than via decorateWrapped.
  it("keeps a sibling cell's link rendered as cm-link when the cursor is elsewhere in the same row", () => {
    const doc = "| Name | Site |\n| --- | --- |\n| Alice | [site](https://x.com) |\n";
    const state = stateFor(doc, doc.indexOf("Alice") + 1); // cursor in Name, not Site
    const decos = collect(state);
    const linkDeco = decos.find((d) => d.class === "cm-link");
    expect(linkDeco).toBeTruthy();
    expect(state.doc.sliceString(linkDeco!.from, linkDeco!.to)).toBe("site");
  });
});

/**
 * The `width` inline style lives on `deco.spec.attributes`, which the
 * shared `collect()` helper doesn't surface (same reasoning as the
 * links describe block above, which reads `deco.spec.attributes`
 * directly rather than extending `collect()` for one attribute).
 */
function collectCodeBlockStyles(state: EditorState, hasFocus = true): (string | undefined)[] {
  const decorations = buildDecorations(state, [{ from: 0, to: state.doc.length }], "test.md", hasFocus);
  const styles: (string | undefined)[] = [];
  decorations.between(0, state.doc.length, (from, to, deco) => {
    if (deco.spec.class === "cm-code-block") {
      styles.push(deco.spec.attributes?.style);
    }
  });
  return styles;
}

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

  it("sizes every line in the block to the block's longest line, not each line's own length", () => {
    const shortLine = "const a = 1;";
    const longLine = "const much_longer_name = 2;";
    const doc = `prose\n\n\`\`\`js\n${shortLine}\n${longLine}\n\`\`\``;
    const state = stateFor(doc, 0); // cursor on the "prose" line, outside the block
    const styles = collectCodeBlockStyles(state);
    expect(styles).toHaveLength(4); // open fence, both body lines, close fence
    const expected = `width: ${longLine.length}ch`;
    for (const style of styles) {
      expect(style).toBe(expected);
    }
  });

  it("does not let a hidden fence/language-tag line inflate the computed width", () => {
    const bodyLine = "x;";
    const doc = `\`\`\`javascript\n${bodyLine}\n\`\`\`\n\nafter`;
    const state = stateFor(doc, doc.indexOf("after")); // cursor outside the block, fence hidden
    const styles = collectCodeBlockStyles(state);
    const expected = `width: ${bodyLine.length}ch`;
    for (const style of styles) {
      expect(style).toBe(expected);
    }
  });

  it("recomputes the width to include the fence/language-tag line once the cursor reveals it", () => {
    const bodyLine = "x;";
    const doc = `\`\`\`javascript\n${bodyLine}\n\`\`\`\n\nafter`;
    const state = stateFor(doc, doc.indexOf(bodyLine)); // cursor on the block, fence revealed
    const styles = collectCodeBlockStyles(state);
    const openFenceLength = "```javascript".length;
    const expected = `width: ${openFenceLength}ch`;
    for (const style of styles) {
      expect(style).toBe(expected);
    }
  });

  it("uses the full raw line length, including leading indent, for an indented block", () => {
    const shortLine = "    def legacy():";
    const longLine = "        return True";
    const doc = `prose\n\n${shortLine}\n${longLine}\n\nmore`;
    const state = stateFor(doc, 0); // cursor outside the block
    const styles = collectCodeBlockStyles(state);
    expect(styles).toHaveLength(2);
    const expected = `width: ${longLine.length}ch`;
    for (const style of styles) {
      expect(style).toBe(expected);
    }
  });

  it("sizes a tab-indented line's width by rendered columns, not raw character count", () => {
    const tabLine = '\tfmt.Println("padded")';
    const doc = `\`\`\`go\nfunc main() {\n${tabLine}\n}\n\`\`\``;
    const state = stateFor(doc, 0); // cursor outside the block
    const styles = collectCodeBlockStyles(state);
    // Default tabSize is 4: countColumn(tabLine, 4) is 25, three columns
    // wider than tabLine.length (22) for the one leading tab at column 0.
    const expected = `width: ${tabLine.length + 3}ch`;
    for (const style of styles) {
      expect(style).toBe(expected);
    }
  });
});

// Regression coverage for issues #140/#137 (duplicates): a blockquote used
// to get no live-preview treatment at all — no border/indent and the raw
// `>` marker left as bare text. See decorations.ts's `decorateBlockquote`/
// `decorateQuoteMark` for the design this covers.
describe("buildDecorations: blockquotes", () => {
  it("gives a single-line blockquote's line cm-blockquote and hides the marker plus its trailing space, cursor elsewhere", () => {
    const doc = "> quoted text\nafter";
    const state = stateFor(doc, doc.indexOf("after"));
    const decos = collect(state);
    const line = state.doc.line(1);
    expect(decos.some((d) => d.class === "cm-blockquote" && d.from === line.from)).toBe(true);
    const hidden = decos.find((d) => d.isReplace && !d.class && d.from === line.from);
    expect(hidden).toBeTruthy();
    expect(state.doc.sliceString(hidden!.from, hidden!.to)).toBe("> ");
  });

  it("reveals the marker (leaves it un-hidden) when the cursor is on the blockquote's line", () => {
    const doc = "> quoted text\nafter";
    const state = stateFor(doc, doc.indexOf("quoted"));
    const decos = collect(state);
    const line = state.doc.line(1);
    expect(decos.some((d) => d.class === "cm-blockquote" && d.from === line.from)).toBe(true);
    expect(decos.some((d) => d.isReplace && !d.class && d.from === line.from)).toBe(false);
    expect(state.doc.toString()).toContain("> quoted text");
  });

  it("doesn't eat the first content character when there's no space after the marker", () => {
    const doc = ">no-space-here\nafter";
    const state = stateFor(doc, doc.indexOf("after"));
    const decos = collect(state);
    const line = state.doc.line(1);
    const hidden = decos.find((d) => d.isReplace && !d.class && d.from === line.from);
    expect(hidden).toBeTruthy();
    expect(state.doc.sliceString(hidden!.from, hidden!.to)).toBe(">");
    expect(state.doc.sliceString(hidden!.to, line.to)).toBe("no-space-here");
  });

  it("decorates both lines of a two-line blockquote paragraph, revealing only the cursor's own line's marker", () => {
    const doc = "> line one\n> line two";
    const state = stateFor(doc, doc.indexOf("line one"));
    const decos = collect(state);
    const line1 = state.doc.line(1);
    const line2 = state.doc.line(2);
    expect(decos.some((d) => d.class === "cm-blockquote" && d.from === line1.from)).toBe(true);
    expect(decos.some((d) => d.class === "cm-blockquote" && d.from === line2.from)).toBe(true);
    // The cursor sits on line 1: its own marker is revealed...
    expect(decos.some((d) => d.isReplace && !d.class && d.from === line1.from)).toBe(false);
    // ...but line 2's marker — nested inside the shared Paragraph node, not
    // a sibling of Blockquote — stays hidden, per-line as designed.
    expect(decos.some((d) => d.isReplace && !d.class && d.from === line2.from)).toBe(true);
  });

  it("still gives a lazy-continuation line cm-blockquote even though it has no QuoteMark of its own", () => {
    const doc = "> line one\nlazy continuation";
    const state = stateFor(doc, doc.indexOf("line one"));
    const decos = collect(state);
    const line2 = state.doc.line(2);
    expect(decos.some((d) => d.class === "cm-blockquote" && d.from === line2.from)).toBe(true);
    expect(decos.some((d) => d.isReplace && !d.class && d.from >= line2.from && d.to <= line2.to)).toBe(false);
  });

  it("still decorates inline content nested inside a blockquote (descent isn't blocked)", () => {
    const doc = "> some *emphasis* text";
    const state = stateFor(doc, doc.length);
    const decos = collect(state);
    expect(decos.some((d) => d.class === "cm-blockquote")).toBe(true);
    const emDeco = decos.find((d) => d.class === "cm-em");
    expect(emDeco).toBeTruthy();
    expect(state.doc.sliceString(emDeco!.from, emDeco!.to)).toBe("*emphasis*");
  });

  // Regression coverage for the #126 table-in-blockquote interaction: a
  // second, independent QuoteMark replace decoration must not overlap
  // decorateTableRow's own leading gap, which already swallows a preceding
  // `>` marker. Both tree shapes below were confirmed directly against the
  // parser (see the plan's "Confirmed syntax-tree shapes" section) rather
  // than assumed.
  describe("table nested in a blockquote (issue #126 interaction)", () => {
    it("tiles the header row with no gap or overlap, and gets both cm-table-row and cm-blockquote line decorations (explicit > on every row)", () => {
      const doc = "> | a | b |\n> | - | - |\n> | 1 | 2 |";
      const state = stateFor(doc, doc.length);
      const decos = collect(state);
      const headerLine = state.doc.line(1);
      const cellsAndGaps = decos
        .filter(
          (d) =>
            d.from >= headerLine.from &&
            d.to <= headerLine.to &&
            (d.class?.split(" ").includes("cm-table-cell") || d.tableGap),
        )
        .sort((a, b) => a.from - b.from);
      let pos = headerLine.from;
      for (const d of cellsAndGaps) {
        expect(d.from).toBe(pos);
        pos = d.to;
      }
      expect(pos).toBe(headerLine.to);
      // CodeMirror merges same-position Decoration.line classes into one
      // element only at DOM-render time (verified in the plan against a
      // real mounted EditorView) — buildDecorations itself still produces
      // them as two separate line decorations at the same position, so
      // both are asserted for individually rather than as one merged class.
      expect(decos.some((d) => d.from === headerLine.from && d.class?.split(" ").includes("cm-table-row"))).toBe(
        true,
      );
      expect(decos.some((d) => d.from === headerLine.from && d.class === "cm-blockquote")).toBe(true);
    });

    it("tiles the header row with no gap or overlap, and gets both cm-table-row and cm-blockquote line decorations (lazy leading marker)", () => {
      const doc = "> | A | B |\n| --- | --- |\n| 1 | 2 |\n";
      const state = stateFor(doc, doc.length);
      const decos = collect(state);
      const headerLine = state.doc.line(1);
      const cellsAndGaps = decos
        .filter(
          (d) =>
            d.from >= headerLine.from &&
            d.to <= headerLine.to &&
            (d.class?.split(" ").includes("cm-table-cell") || d.tableGap),
        )
        .sort((a, b) => a.from - b.from);
      let pos = headerLine.from;
      for (const d of cellsAndGaps) {
        expect(d.from).toBe(pos);
        pos = d.to;
      }
      expect(pos).toBe(headerLine.to);
      // CodeMirror merges same-position Decoration.line classes into one
      // element only at DOM-render time (verified in the plan against a
      // real mounted EditorView) — buildDecorations itself still produces
      // them as two separate line decorations at the same position, so
      // both are asserted for individually rather than as one merged class.
      expect(decos.some((d) => d.from === headerLine.from && d.class?.split(" ").includes("cm-table-row"))).toBe(
        true,
      );
      expect(decos.some((d) => d.from === headerLine.from && d.class === "cm-blockquote")).toBe(true);
    });

    // Regression coverage for a review finding on the original PR: a table
    // nested inside a *nested* blockquote (two or more `>` markers before
    // the row) defeated the original guard, which only recognized "marker's
    // parent is Table" and "marker's next sibling is Table" — for the
    // outermost of several nested markers, the next sibling is the *inner*
    // Blockquote, not Table, so neither branch matched and it emitted a
    // stray replace decoration overlapping decorateTableRow's own leading
    // gap. `lineOwnedByTableRow` fixes this by checking whether the row (or
    // the table's alignment-delimiter row) starts on the marker's physical
    // line at all, regardless of nesting depth or tree shape.
    it("tiles the header and delimiter rows with no gap or overlap when the table sits inside a nested blockquote", () => {
      const doc = "> > | a | b |\n> > | - | - |";
      const state = stateFor(doc, doc.length);
      const decos = collect(state);
      for (const lineNum of [1, 2]) {
        const line = state.doc.line(lineNum);
        const covering = decos
          .filter((d) => d.from >= line.from && d.to <= line.to && (d.isReplace || d.tableGap))
          .sort((a, b) => a.from - b.from);
        let pos = line.from;
        for (const d of covering) {
          expect(d.from).toBeGreaterThanOrEqual(pos); // no overlap with the previous decoration
          pos = Math.max(pos, d.to);
        }
      }
      // The header row's line decoration still gets both classes.
      const headerLine = state.doc.line(1);
      expect(decos.some((d) => d.from === headerLine.from && d.class?.split(" ").includes("cm-table-row"))).toBe(
        true,
      );
      expect(decos.some((d) => d.from === headerLine.from && d.class === "cm-blockquote")).toBe(true);
    });
  });

  it("keeps the marker hidden when hasFocus is false, even with the selection on that line", () => {
    const doc = "> quoted text\nafter";
    const state = stateFor(doc, doc.indexOf("quoted"));
    const decos = collect(state, "test.md", false);
    const line = state.doc.line(1);
    expect(decos.some((d) => d.class === "cm-blockquote" && d.from === line.from)).toBe(true);
    expect(decos.some((d) => d.isReplace && !d.class && d.from === line.from)).toBe(true);
  });
});

/**
 * `MermaidWidget` decorations come from `buildMermaidWidgetDecorations` (a
 * `StateField`, per CodeMirror's own requirement that block-level replace
 * decorations can't come from a `ViewPlugin`) rather than `buildDecorations`
 * itself — see `mermaidWidgetSource`'s doc comment in `decorations.ts`.
 */
function collectMermaidWidgets(state: EditorState, hasFocus = true): CollectedDecoration[] {
  const decorations = buildMermaidWidgetDecorations(state, hasFocus);
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

/**
 * `hasFocus: false` must behave like "cursor is nowhere on this document" —
 * raw markup stays hidden and widgets stay rendered — even when the stored
 * selection sits exactly where it would normally trigger a cursor-reveal.
 * This is the fix for issue #108 ("deselecting rendered markdown does not
 * clear the line active edit"): CodeMirror's selection never becomes
 * "empty," it just stops mattering once the editor loses DOM focus.
 */
describe("buildDecorations: hasFocus gating (issue #108)", () => {
  it("hides the heading marker when hasFocus is false, even with the selection on that line", () => {
    const doc = "# Hello\nSecond line";
    const state = stateFor(doc, 3); // cursor inside "Hello" — would normally reveal
    const decos = collect(state, "test.md", false);
    const headingDeco = decos.find((d) => d.class === "cm-heading-1");
    expect(headingDeco).toBeTruthy();
    expect(headingDeco?.from).toBe(2); // after "# ", marker hidden
    expect(headingDeco?.to).toBe(7);
    expect(decos.some((d) => d.isReplace && !d.class)).toBe(true); // the hidden marker itself
  });

  it("hides emphasis and strong delimiters when hasFocus is false, even with the selection on that line", () => {
    const doc = "plain *em* and **strong** text\nsecond line";
    const state = stateFor(doc, doc.indexOf("em"));
    const decos = collect(state, "test.md", false);
    expect(decos.some((d) => d.class === "cm-em")).toBe(true);
    expect(decos.some((d) => d.class === "cm-strong")).toBe(true);
    expect(state.doc.toString()).toContain("*em*"); // doc unchanged, only decorations differ
    const replaces = decos.filter((d) => d.isReplace && !d.class);
    expect(replaces.length).toBeGreaterThanOrEqual(4);
  });

  it("hides strikethrough delimiters when hasFocus is false, even with the selection on that line", () => {
    const doc = "plain ~~gone~~ text\nsecond line";
    const state = stateFor(doc, doc.indexOf("gone"));
    const decos = collect(state, "test.md", false);
    expect(decos.some((d) => d.class === "cm-strikethrough")).toBe(true);
    expect(decos.some((d) => d.isReplace && !d.class)).toBe(true);
  });

  it("hides inline code backticks when hasFocus is false, even with the selection on that line", () => {
    const doc = "use `code` here\nsecond line";
    const state = stateFor(doc, doc.indexOf("code"));
    const decos = collect(state, "test.md", false);
    expect(decos.some((d) => d.class === "cm-inline-code")).toBe(true);
    expect(decos.some((d) => d.isReplace && !d.class)).toBe(true);
  });

  it("still renders a link as cm-link when hasFocus is false, even with the selection on its line", () => {
    const doc = "[click here](https://example.com/page)\nsecond line";
    const state = stateFor(doc, doc.indexOf("click"));
    const decos = collect(state, "test.md", false);
    const linkDeco = decos.find((d) => d.class === "cm-link");
    expect(linkDeco).toBeTruthy();
    expect(state.doc.sliceString(linkDeco!.from, linkDeco!.to)).toBe("click here");
  });

  it("still renders an ImageWidget when hasFocus is false, even with the selection on its line", () => {
    const doc = "![alt text](./local.png)\nsecond line";
    const state = stateFor(doc, doc.indexOf("alt"));
    const decorations = buildDecorations(state, [{ from: 0, to: state.doc.length }], "notes/test.md", false);
    let widget: ImageWidget | undefined;
    decorations.between(0, state.doc.length, (_f, _t, deco) => {
      if (deco.spec.widget instanceof ImageWidget) {
        widget = deco.spec.widget;
      }
    });
    expect(widget).toBeTruthy();
    expect(widget?.url).toBe("./local.png");
  });

  it("hides fenced code fence markers when hasFocus is false, even with the selection inside the block", () => {
    const doc = "```js\nconst x = 1;\n```\n\nafter";
    const state = stateFor(doc, doc.indexOf("const x"));
    const decos = collect(state, "test.md", false);
    const openLine = state.doc.line(1);
    const closeLine = state.doc.line(3);
    expect(decos.some((d) => d.isReplace && !d.class && d.from === openLine.from && d.to === openLine.to)).toBe(
      true,
    );
    expect(decos.some((d) => d.isReplace && !d.class && d.from === closeLine.from && d.to === closeLine.to)).toBe(
      true,
    );
  });

  it("keeps a table cell's cm-table-cell class when hasFocus is false, even with the selection inside it", () => {
    const doc = "| Name | Role |\n| --- | --- |\n| Alice | Engineer |\n";
    const engineerFrom = doc.indexOf("Engineer");
    const state = stateFor(doc, engineerFrom + 1); // cursor inside "Engineer" — would normally reveal the cell
    const decos = collect(state, "test.md", false);
    const engineerTo = engineerFrom + "Engineer".length;
    expect(
      decos.some(
        (d) => d.class?.split(" ").includes("cm-table-cell") && d.from === engineerFrom && d.to === engineerTo,
      ),
    ).toBe(true);
  });

  it("still replaces a mermaid block with a MermaidWidget when hasFocus is false, even with the selection inside it", () => {
    const doc = "```mermaid\ngraph TD;\nA-->B;\n```\n\nafter";
    const state = stateFor(doc, doc.indexOf("A-->B")); // cursor inside the block — would normally fall back to raw
    const widgets = collectMermaidWidgets(state, false).filter((d) => d.widget instanceof MermaidWidget);
    expect(widgets).toHaveLength(1);
  });
});

describe("buildDecorations: horizontal rules", () => {
  it("hides the marker and gives the line a cm-hr container when the cursor is elsewhere", () => {
    const doc = "before\n\n---\n\nafter";
    const state = stateFor(doc, 0); // cursor on the "before" line
    const decos = collect(state);
    const hrLine = state.doc.line(3);
    expect(decos.some((d) => d.class === "cm-hr" && d.from === hrLine.from)).toBe(true);
    expect(decos.some((d) => d.isReplace && !d.class && d.from === hrLine.from && d.to === hrLine.to)).toBe(true);
  });

  it("reveals the raw marker text when the cursor is on the rule's line", () => {
    const doc = "before\n\n---\n\nafter";
    const state = stateFor(doc, doc.indexOf("---"));
    const decos = collect(state);
    const hrLine = state.doc.line(3);
    expect(decos.some((d) => d.class === "cm-hr" && d.from === hrLine.from)).toBe(true);
    expect(decos.some((d) => d.isReplace && !d.class && d.from === hrLine.from)).toBe(false);
    expect(state.doc.toString()).toContain("---");
  });

  it.each([["***"], ["___"]])("recognizes %s as a horizontal rule too", (marker) => {
    const doc = `before\n\n${marker}\n\nafter`;
    const state = stateFor(doc, 0);
    const decos = collect(state);
    const hrLine = state.doc.line(3);
    expect(decos.some((d) => d.class === "cm-hr" && d.from === hrLine.from)).toBe(true);
  });
});

describe("buildDecorations: setext headings", () => {
  it("renders a === underline as an H1, hiding the underline entirely", () => {
    const doc = "Title\n=====\nafter";
    const state = stateFor(doc, doc.indexOf("after"));
    const decos = collect(state);
    const headingDeco = decos.find((d) => d.class === "cm-heading-1");
    expect(headingDeco).toBeTruthy();
    expect(state.doc.sliceString(headingDeco!.from, headingDeco!.to)).toBe("Title");

    const underlineLine = state.doc.line(2);
    expect(decos.some((d) => d.class === "cm-setext-underline" && d.from === underlineLine.from)).toBe(true);
    expect(
      decos.some((d) => d.isReplace && !d.class && d.from === underlineLine.from && d.to === underlineLine.to),
    ).toBe(true);
  });

  it("renders a --- underline as an H2", () => {
    const doc = "Title\n-----\nafter";
    const state = stateFor(doc, doc.indexOf("after"));
    const decos = collect(state);
    const headingDeco = decos.find((d) => d.class === "cm-heading-2");
    expect(headingDeco).toBeTruthy();
    expect(state.doc.sliceString(headingDeco!.from, headingDeco!.to)).toBe("Title");
  });

  it("keeps both lines fully raw, styled as one unit, when the cursor is on the heading", () => {
    const doc = "Title\n=====\nafter";
    const state = stateFor(doc, doc.indexOf("Title"));
    const decos = collect(state);
    const headingDeco = decos.find((d) => d.class === "cm-heading-1");
    expect(headingDeco).toBeTruthy();
    expect(headingDeco?.from).toBe(0);
    expect(headingDeco?.to).toBe(doc.indexOf("\nafter"));
    expect(decos.some((d) => d.isReplace && !d.class)).toBe(false);
    expect(state.doc.toString()).toContain("Title\n=====");
  });
});

describe("buildDecorations: autolinks", () => {
  it("hides the angle brackets and renders the URL as a working link", () => {
    const doc = "See <https://example.com/page> for more.\nsecond line";
    const state = stateFor(doc, doc.length);
    const decorations = buildDecorations(state, [{ from: 0, to: state.doc.length }], "test.md", true);
    let found: { from: number; to: number; href?: string } | undefined;
    decorations.between(0, state.doc.length, (from, to, deco) => {
      if (deco.spec.class === "cm-link") {
        found = { from, to, href: deco.spec.attributes?.["data-href"] };
      }
    });
    expect(found).toBeTruthy();
    expect(found?.href).toBe("https://example.com/page");
    expect(state.doc.sliceString(found!.from, found!.to)).toBe("https://example.com/page");

    const openBracket = doc.indexOf("<");
    const closeBracket = doc.indexOf(">");
    const decos = collect(state);
    expect(
      decos.some((d) => d.isReplace && !d.class && d.from === openBracket && d.to === openBracket + 1),
    ).toBe(true);
    expect(
      decos.some((d) => d.isReplace && !d.class && d.from === closeBracket && d.to === closeBracket + 1),
    ).toBe(true);
  });

  it("fully un-renders when the cursor is on the autolink's line", () => {
    const doc = "See <https://example.com/page> for more.\nsecond line";
    const state = stateFor(doc, doc.indexOf("example"));
    const decos = collect(state);
    expect(decos.some((d) => d.class === "cm-link")).toBe(false);
    expect(state.doc.toString()).toContain("<https://example.com/page>");
  });
});

describe("buildDecorations: bare URLs (GFM autolinks, #141 gap 3)", () => {
  function linkRangeFor(doc: string): { from: number; to: number; href?: string } | undefined {
    const state = stateFor(doc, doc.length);
    const decorations = buildDecorations(state, [{ from: 0, to: state.doc.length }], "test.md", true);
    let found: { from: number; to: number; href?: string } | undefined;
    decorations.between(0, state.doc.length, (from, to, deco) => {
      if (deco.spec.class === "cm-link") {
        found = { from, to, href: deco.spec.attributes?.["data-href"] };
      }
    });
    return found;
  }

  it("renders a bare URL directly in a paragraph as a working link", () => {
    const doc = "See https://example.com/foo for more.\nsecond line";
    const found = linkRangeFor(doc);
    expect(found).toBeTruthy();
    expect(found?.href).toBe("https://example.com/foo");
  });

  it("renders a bare URL nested inside emphasis as a working link", () => {
    const doc = "*https://example.com/foo*\nsecond line";
    const found = linkRangeFor(doc);
    expect(found).toBeTruthy();
    expect(found?.href).toBe("https://example.com/foo");
  });

  it("renders a bare URL inside a table cell as a working link", () => {
    const doc = "| Name | Site |\n| --- | --- |\n| Alice | https://example.com/foo |\n";
    const found = linkRangeFor(doc);
    expect(found).toBeTruthy();
    expect(found?.href).toBe("https://example.com/foo");
  });

  it("does not double-decorate a [text](url) link's own URL child", () => {
    const doc = "[click here](https://example.com/foo)\nsecond line";
    const state = stateFor(doc, doc.length);
    const decos = collect(state);
    const linkMarks = decos.filter((d) => d.class === "cm-link");
    expect(linkMarks).toHaveLength(1);
    expect(state.doc.sliceString(linkMarks[0].from, linkMarks[0].to)).toBe("click here");
  });
});

describe("buildDecorations: footnote-link suppression (#141 gap 4)", () => {
  it("renders an unresolved [^1] citation and its own bogus definition line as plain text, not a working link", () => {
    const doc = "Some text. [^1]\n\ncursor line\n\n[^1]: This is the footnote text.\n";
    const state = stateFor(doc, doc.indexOf("cursor line"));
    const decos = collect(state);
    expect(decos.some((d) => d.class === "cm-link")).toBe(false);
    expect(state.doc.toString()).toContain("[^1]");
    expect(state.doc.toString()).toContain("[^1]: This is the footnote text.");
  });

  it("renders a resolved [^1]: <url> definition's citation as a normal working link", () => {
    const doc = "Some text. [^1]\n\ncursor line\n\n[^1]: https://example.com/footnote\n";
    const state = stateFor(doc, doc.indexOf("cursor line"));
    const decorations = buildDecorations(state, [{ from: 0, to: state.doc.length }], "test.md", true);
    let found: { from: number; to: number; href?: string } | undefined;
    decorations.between(0, state.doc.length, (from, to, deco) => {
      if (deco.spec.class === "cm-link") {
        found = { from, to, href: deco.spec.attributes?.["data-href"] };
      }
    });
    expect(found).toBeTruthy();
    expect(found?.href).toBe("https://example.com/footnote");
  });

  it("also decorates a [^1]: <url> definition line's own URL as a bare autolink (composes with gap 3)", () => {
    const doc = "Some text. [^1]\n\ncursor line\n\n[^1]: https://example.com/footnote\n";
    const state = stateFor(doc, doc.indexOf("cursor line"));
    const decos = collect(state);
    const urlFrom = doc.indexOf("https://example.com/footnote");
    const urlTo = urlFrom + "https://example.com/footnote".length;
    expect(decos.some((d) => d.class === "cm-link" && d.from === urlFrom && d.to === urlTo)).toBe(true);
  });

  it("leaves a non-footnote dangling reference's existing fallback behavior unchanged", () => {
    const doc = "See [my link][missing] for more.\n\ncursor line\nsecond line";
    const state = stateFor(doc, doc.indexOf("cursor line"));
    const decorations = buildDecorations(state, [{ from: 0, to: state.doc.length }], "test.md", true);
    let href: string | undefined;
    decorations.between(0, state.doc.length, (from, to, deco) => {
      if (deco.spec.class === "cm-link") {
        href = deco.spec.attributes?.["data-href"];
      }
    });
    expect(href).toBe("");
  });
});

describe("buildDecorations: unordered list markers (#141 gap 5)", () => {
  function bulletsFor(doc: string, cursor: number): { from: number; to: number }[] {
    const state = stateFor(doc, cursor);
    const decorations = buildDecorations(state, [{ from: 0, to: state.doc.length }], "test.md", true);
    const widgets: { from: number; to: number }[] = [];
    decorations.between(0, state.doc.length, (from, to, deco) => {
      if (deco.spec.widget instanceof ListBulletWidget) {
        widgets.push({ from, to });
      }
    });
    return widgets;
  }

  it("replaces bullet markers with a ListBulletWidget when the cursor is elsewhere", () => {
    const doc = "- item one\n- item two\n\nafter";
    const state = stateFor(doc, doc.indexOf("after"));
    const widgets = bulletsFor(doc, doc.indexOf("after"));
    expect(widgets).toHaveLength(2);
    expect(state.doc.sliceString(widgets[0].from, widgets[0].to)).toBe("-");
    expect(state.doc.sliceString(widgets[1].from, widgets[1].to)).toBe("-");
  });

  it("reveals the raw marker when the cursor is on that item's line, leaving other items decorated", () => {
    const widgets = bulletsFor("- item one\n- item two\n\nafter", "- item one\n- item two\n\nafter".indexOf("item one"));
    expect(widgets).toHaveLength(1);
  });

  it.each([["*"], ["+"]])("recognizes %s as a bullet marker too", (marker) => {
    const doc = `${marker} item\n\nafter`;
    const widgets = bulletsFor(doc, doc.indexOf("after"));
    expect(widgets).toHaveLength(1);
  });
});

describe("buildDecorations: ordered list markers (#141 gap 5)", () => {
  function markersFor(doc: string, cursor: number): { from: number; to: number; widget: ListMarkerWidget }[] {
    const state = stateFor(doc, cursor);
    const decorations = buildDecorations(state, [{ from: 0, to: state.doc.length }], "test.md", true);
    const widgets: { from: number; to: number; widget: ListMarkerWidget }[] = [];
    decorations.between(0, state.doc.length, (from, to, deco) => {
      if (deco.spec.widget instanceof ListMarkerWidget) {
        widgets.push({ from, to, widget: deco.spec.widget });
      }
    });
    return widgets.sort((a, b) => a.from - b.from);
  }

  it("numbers items sequentially from a default start of 1", () => {
    const doc = "1. one\n2. two\n3. three\n\nafter";
    const widgets = markersFor(doc, doc.indexOf("after"));
    expect(widgets.map((w) => w.widget.number)).toEqual([1, 2, 3]);
    expect(widgets.every((w) => w.widget.delimiter === ".")).toBe(true);
  });

  it("numbers items from the list's own start value, ignoring each item's own literal digits", () => {
    const doc = "5. five\n1. six\n1. seven\n\nafter";
    const widgets = markersFor(doc, doc.indexOf("after"));
    expect(widgets.map((w) => w.widget.number)).toEqual([5, 6, 7]);
  });

  it("numbers a nested ordered list independently of its parent", () => {
    const doc = "1. one\n   1. nested a\n   2. nested b\n2. two\n\nafter";
    const widgets = markersFor(doc, doc.indexOf("after"));
    // Document order: outer item 1, nested item 1, nested item 2, outer item 2.
    expect(widgets.map((w) => w.widget.number)).toEqual([1, 1, 2, 2]);
  });

  it("reveals the raw marker when the cursor is on that item's line", () => {
    const doc = "1. one\n2. two\n\nafter";
    const widgets = markersFor(doc, doc.indexOf("one"));
    expect(widgets).toHaveLength(1); // only "two" stays decorated
    expect(widgets[0].widget.number).toBe(2);
    expect(doc).toContain("1. one");
  });
});

describe("buildDecorations: list markers vs task lists (#141 gap 5 interaction)", () => {
  it("keeps a single CheckboxWidget for an unordered task item, with no bullet layered on top", () => {
    const doc = "- [ ] todo\n- plain item\n\nafter";
    const state = stateFor(doc, doc.indexOf("after"));
    const decorations = buildDecorations(state, [{ from: 0, to: state.doc.length }], "test.md", true);
    const checkboxes: unknown[] = [];
    const bullets: unknown[] = [];
    decorations.between(0, state.doc.length, (_f, _t, deco) => {
      if (deco.spec.widget instanceof CheckboxWidget) checkboxes.push(deco.spec.widget);
      if (deco.spec.widget instanceof ListBulletWidget) bullets.push(deco.spec.widget);
    });
    expect(checkboxes).toHaveLength(1);
    expect(bullets).toHaveLength(1); // only the plain second item gets a bullet
  });

  it("keeps a single CheckboxWidget for an ordered task item, with no number layered on top, and still numbers later plain siblings correctly", () => {
    const doc = "1. [ ] todo\n2. plain\n\nafter";
    const state = stateFor(doc, doc.indexOf("after"));
    const decorations = buildDecorations(state, [{ from: 0, to: state.doc.length }], "test.md", true);
    const checkboxes: unknown[] = [];
    const numbers: ListMarkerWidget[] = [];
    decorations.between(0, state.doc.length, (_f, _t, deco) => {
      if (deco.spec.widget instanceof CheckboxWidget) checkboxes.push(deco.spec.widget);
      if (deco.spec.widget instanceof ListMarkerWidget) numbers.push(deco.spec.widget);
    });
    expect(checkboxes).toHaveLength(1);
    expect(numbers).toHaveLength(1); // only the plain second item gets a rendered number
    expect(numbers[0].number).toBe(2); // the task item still counted toward the numbering
  });
});

describe("buildDecorations: raw HTML (#141 gap 6)", () => {
  it("styles an HTML block distinctly without hiding, altering, or removing its markup", () => {
    const doc = "<div>\nhello\n</div>\n\nafter";
    const state = stateFor(doc, doc.indexOf("after"));
    const decos = collect(state);
    const htmlDeco = decos.find((d) => d.class === "cm-raw-html");
    expect(htmlDeco).toBeTruthy();
    expect(state.doc.sliceString(htmlDeco!.from, htmlDeco!.to)).toContain("<div>");
    expect(
      decos.some((d) => d.isReplace && d.from >= htmlDeco!.from && d.to <= htmlDeco!.to),
    ).toBe(false);
    expect(state.doc.toString()).toContain("<div>\nhello\n</div>");
  });

  it("styles inline HTML tags distinctly without hiding, altering, or removing their markup", () => {
    const doc = "inline <span>hi</span> text\nsecond line";
    const state = stateFor(doc, doc.length);
    const decos = collect(state);
    const htmlDecos = decos.filter((d) => d.class === "cm-raw-html");
    expect(htmlDecos.length).toBeGreaterThanOrEqual(2); // opening and closing tag
    expect(decos.some((d) => d.isReplace)).toBe(false);
    expect(state.doc.toString()).toContain("<span>hi</span>");
  });
});

describe("buildDecorations: round-trip safety", () => {
  it("never mutates document content", () => {
    const doc = "# Heading\n\n*em* **strong** `code` [link](url) ![img](url)\n\n- [ ] task\n\n| a | b |\n|---|---|\n| 1 | 2 |\n";
    const state = stateFor(doc, 0);
    buildDecorations(state, [{ from: 0, to: state.doc.length }], "test.md", true);
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

describe("markdown.css: inline code and mermaid error font-family", () => {
  // .cm-inline-code and .cm-mermaid-error-message must inherit font-family
  // from the ambient editor context (CodeMirror's own `monospace` base
  // theme) rather than declaring their own — a declared override resolves
  // to a different browser default font-size bucket than the unset
  // ambient one, producing a visible size/line-height mismatch (issue #63).
  it(".cm-inline-code does not declare its own font-family", () => {
    expect(ruleBodyFor(".cm-inline-code")).not.toMatch(/font-family/);
  });

  it(".cm-mermaid-error-message does not declare its own font-family", () => {
    expect(ruleBodyFor(".cm-mermaid-error-message")).not.toMatch(/font-family/);
  });
});

describe("markdown.css: code block width cap", () => {
  // .cm-code-block's computed `width: <N>ch` (set per-block in decorations.ts)
  // must stay capped at the pane's own width (issue #29 / #89) without
  // reintroducing per-line scrolling (issue #135): `box-sizing: content-box`
  // keeps the `ch` width honest against the block's own padding/border, and
  // neither `overflow-x` nor `max-width` are set on the block itself anymore
  // — a too-wide line now overflows the shared document-level scroller instead.
  it(".cm-code-block uses content-box sizing and does not trap its own overflow", () => {
    const body = ruleBodyFor(".cm-code-block");
    expect(body).toMatch(/box-sizing:\s*content-box/);
    expect(body).not.toMatch(/max-width/);
    expect(body).not.toMatch(/overflow-x/);
    expect(body).toMatch(/white-space:\s*pre/);
  });

  it(".cm-code-block's padding beats CodeMirror's own .cm-line padding via !important", () => {
    const body = ruleBodyFor(".cm-code-block");
    expect(body).toMatch(/padding:\s*0\s*0\.6em\s*!important/);
  });
});

import { describe, it, expect, afterEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { render, cleanup } from "@testing-library/svelte";
import { javascript } from "@codemirror/lang-javascript";
import { buildCmTheme, buildHighlightStyle } from "../../src/lib/theme/cmTheme";
import { atriumDark, atriumLight, atriumHighContrast, themes } from "../../src/lib/theme/tokens";
import { baseExtensions } from "../../src/lib/editor/baseExtensions";
import { tabsState } from "../../src/lib/stores/tabs";
import EditorPane from "../../src/lib/editor/EditorPane.svelte";

let view: EditorView | undefined;

afterEach(() => {
  view?.destroy();
  view = undefined;
  cleanup();
});

/** Injected <style> text across the whole document, where style-mod mounts EditorView.theme() rules. */
function allStyleText(): string {
  return Array.from(document.querySelectorAll("style"))
    .map((el) => el.textContent ?? "")
    .join("\n");
}

describe("buildCmTheme", () => {
  it.each(themes)("mounts CSS containing every gutter/background/caret/selection value for $id", (theme) => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    view = new EditorView({
      state: EditorState.create({ extensions: [buildCmTheme(theme), lineNumbers()] }),
      parent: container,
    });

    const css = allStyleText();
    const t = theme.tokens;
    for (const value of [t.gutterBg, t.gutterFg, t.gutterFgActiveLine, t.cursor, t.selectionBg, t.activeLineBg, t.matchingBracketBg, t.searchMatchBg]) {
      expect(css, `${theme.id}: expected generated CSS to contain ${value}`).toContain(value);
    }
    container.remove();
  });

  it("produces different generated CSS for two different themes", () => {
    const darkExt = buildCmTheme(atriumDark);
    const lightExt = buildCmTheme(atriumLight);
    expect(darkExt).not.toBe(lightExt);
  });
});

describe("buildHighlightStyle", () => {
  it.each(themes)("maps every @lezer/highlight tag to its theme's syntax token color for $id", (theme) => {
    const style = buildHighlightStyle(theme);
    const t = theme.tokens;
    const specs = style.specs;

    expect(specs.find((s) => s.tag === tags.keyword)?.color).toBe(t.syntaxKeyword);
    expect(specs.find((s) => s.tag === tags.string)?.color).toBe(t.syntaxString);
    expect(specs.find((s) => s.tag === tags.number)?.color).toBe(t.syntaxNumber);
    expect(specs.find((s) => s.tag === tags.propertyName)?.color).toBe(t.syntaxProperty);
    expect(specs.find((s) => s.tag === tags.invalid)?.color).toBe(t.syntaxInvalid);

    const commentSpec = specs.find((s) => s.tag === tags.comment);
    expect(commentSpec?.color).toBe(t.syntaxComment);
    expect(commentSpec?.fontStyle).toBe("italic");

    const typeSpec = specs.find((s) => Array.isArray(s.tag) && (s.tag as unknown[]).includes(tags.typeName));
    expect(typeSpec?.color).toBe(t.syntaxType);

    const operatorSpec = specs.find((s) => Array.isArray(s.tag) && (s.tag as unknown[]).includes(tags.operator));
    expect(operatorSpec?.color).toBe(t.syntaxOperator);
  });

  it("renders styled spans for a highlighted document via the real extension composition", () => {
    const container = document.createElement("div");
    view = new EditorView({
      state: EditorState.create({
        doc: "function greet(name) {\n  // hi\n  return `hi ${name}`;\n}\n",
        extensions: [
          baseExtensions(),
          syntaxHighlighting(buildHighlightStyle(atriumDark), { fallback: true }),
          javascript(),
        ],
      }),
      parent: container,
    });

    const styledSpans = container.querySelectorAll(".cm-content .cm-line span[class]");
    expect(styledSpans.length).toBeGreaterThan(0);
  });
});

describe("EditorPane theming (regression guard against section 2.4 recurring)", () => {
  it.each([
    ["Atrium Dark", atriumDark],
    ["Atrium Light", atriumLight],
    ["Atrium High Contrast", atriumHighContrast],
  ] as const)("mounts .cm-gutters with %s's gutter colors, not CM6's un-themed default", async (_name, theme) => {
    tabsState.set({
      tabs: [{ path: "sample.ts", mode: "code", savedDoc: "const x = 1;\n", isDirty: false, hasExternalConflict: false }],
      activeTabPath: "sample.ts",
    });
    const themeModule = await import("../../src/lib/stores/theme");
    themeModule.theme.set(theme);

    const { container } = render(EditorPane, { props: { filePath: "sample.ts", paneId: "pane-1" } });
    const gutters = container.querySelector(".cm-gutters");
    expect(gutters).toBeTruthy();

    const css = allStyleText();
    expect(css, `${theme.id}: expected generated CSS to contain gutterBg`).toContain(theme.tokens.gutterBg);
    expect(css, `${theme.id}: expected generated CSS to contain gutterFg`).toContain(theme.tokens.gutterFg);

    tabsState.set({ tabs: [], activeTabPath: null });
  });
});

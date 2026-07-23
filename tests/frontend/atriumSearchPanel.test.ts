import { describe, it, expect, afterEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { openSearchPanel, getSearchQuery } from "@codemirror/search";
import { inFileSearch } from "../../src/lib/editor/search/atriumSearchPanel";

let view: EditorView | undefined;
let container: HTMLDivElement | undefined;

function setup(doc: string): { view: EditorView; container: HTMLDivElement } {
  container = document.createElement("div");
  document.body.appendChild(container);
  view = new EditorView({
    // `allowMultipleSelections` mirrors `baseExtensions()`'s real wiring
    // (needed for select-all-matches to actually produce more than one
    // range); everything search-specific comes from `inFileSearch()` alone.
    state: EditorState.create({
      doc,
      extensions: [inFileSearch(), EditorState.allowMultipleSelections.of(true)],
    }),
    parent: container,
  });
  openSearchPanel(view);
  return { view, container };
}

function setInputValue(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

afterEach(() => {
  view?.destroy();
  view = undefined;
  container?.remove();
  container = undefined;
});

describe("atriumSearchPanel", () => {
  it("renders no spelled-out-word buttons or labels (guards against regressing to the stock @codemirror/search panel)", () => {
    const { container } = setup("hello world\n");

    expect(container.querySelectorAll("label").length).toBe(0);

    const forbidden = ["next", "previous", "all", "match case", "regexp", "by word", "replace", "replace all"];
    const texts = Array.from(container.querySelectorAll("button")).map((b) =>
      (b.textContent ?? "").trim().toLowerCase(),
    );
    for (const word of forbidden) {
      expect(texts).not.toContain(word);
    }
  });

  it("keeps the replace row out of the DOM until the disclosure toggle is clicked, and removes it again when toggled off", () => {
    const { container } = setup("hello world\n");
    expect(container.querySelector('input[name="replace"]')).toBeNull();

    const disclosure = container.querySelector<HTMLButtonElement>(".cm-atrium-search-disclosure-btn");
    expect(disclosure).not.toBeNull();

    disclosure!.click();
    expect(container.querySelector('input[name="replace"]')).not.toBeNull();

    disclosure!.click();
    expect(container.querySelector('input[name="replace"]')).toBeNull();
  });

  it("disables native autofill/suggestions on both the search and replace inputs (the #56 precedent)", () => {
    const { container } = setup("hello world\n");
    const search = container.querySelector<HTMLInputElement>('input[name="search"]')!;
    for (const attr of ["autocomplete", "autocorrect", "autocapitalize"]) {
      expect(search.getAttribute(attr)).toBe("off");
    }
    expect(search.getAttribute("spellcheck")).toBe("false");

    container.querySelector<HTMLButtonElement>(".cm-atrium-search-disclosure-btn")!.click();
    const replace = container.querySelector<HTMLInputElement>('input[name="replace"]')!;
    for (const attr of ["autocomplete", "autocorrect", "autocapitalize"]) {
      expect(replace.getAttribute(attr)).toBe("off");
    }
    expect(replace.getAttribute("spellcheck")).toBe("false");
  });

  it("opens the panel at the top of the editor (SearchConfig.top)", () => {
    const { container } = setup("hello world\n");
    expect(container.querySelector(".cm-panels")?.classList.contains("cm-panels-top")).toBe(true);
  });

  it("wires the query field to the real @codemirror/search engine: typing updates the shared SearchQuery", () => {
    const { view, container } = setup("foo bar foo baz foo\n");
    const search = container.querySelector<HTMLInputElement>('input[name="search"]')!;
    setInputValue(search, "foo");
    expect(getSearchQuery(view.state).search).toBe("foo");
  });

  it("next/previous move the selection through real matches via findNext/findPrevious", () => {
    const { view, container } = setup("foo bar foo baz foo\n");
    const search = container.querySelector<HTMLInputElement>('input[name="search"]')!;
    setInputValue(search, "foo");

    const nextBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Next match"]')!;
    const prevBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Previous match"]')!;

    nextBtn.click();
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("foo");
    const firstMatch = view.state.selection.main.from;

    nextBtn.click();
    expect(view.state.selection.main.from).toBeGreaterThan(firstMatch);

    prevBtn.click();
    expect(view.state.selection.main.from).toBe(firstMatch);
  });

  it("select-all-matches selects every occurrence via the real selectMatches command", () => {
    const { view, container } = setup("foo bar foo baz foo\n");
    const search = container.querySelector<HTMLInputElement>('input[name="search"]')!;
    setInputValue(search, "foo");

    container.querySelector<HTMLButtonElement>('button[aria-label="Select all matches"]')!.click();
    expect(view.state.selection.ranges.length).toBe(3);
  });

  it("replace and replace-all dispatch real document changes via replaceNext/replaceAll", () => {
    const { view, container } = setup("foo bar foo baz foo\n");
    const search = container.querySelector<HTMLInputElement>('input[name="search"]')!;
    setInputValue(search, "foo");
    container.querySelector<HTMLButtonElement>('button[aria-label="Next match"]')!.click();

    container.querySelector<HTMLButtonElement>(".cm-atrium-search-disclosure-btn")!.click();
    const replace = container.querySelector<HTMLInputElement>('input[name="replace"]')!;
    setInputValue(replace, "X");

    container.querySelector<HTMLButtonElement>('button[aria-label="Replace"]')!.click();
    expect(view.state.doc.toString()).toBe("X bar foo baz foo\n");

    container.querySelector<HTMLButtonElement>('button[aria-label="Replace all"]')!.click();
    expect(view.state.doc.toString()).toBe("X bar X baz X\n");
  });

  it("shows a Zed-style match-count indicator that tracks the current match", () => {
    const { container } = setup("foo bar foo baz foo\n");
    const search = container.querySelector<HTMLInputElement>('input[name="search"]')!;
    setInputValue(search, "foo");
    expect(container.querySelector(".cm-atrium-search-count")?.textContent).toBe("3 found");

    container.querySelector<HTMLButtonElement>('button[aria-label="Next match"]')!.click();
    expect(container.querySelector(".cm-atrium-search-count")?.textContent).toBe("1 of 3");
  });
});

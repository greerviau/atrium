import type { Extension } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import type { Panel, ViewUpdate } from "@codemirror/view";
import {
  search,
  SearchQuery,
  getSearchQuery,
  setSearchQuery,
  findNext,
  findPrevious,
  replaceNext,
  replaceAll,
  selectMatches,
  closeSearchPanel,
} from "@codemirror/search";

/**
 * The in-file (`Mod-f`) search extension, styled and laid out as a single
 * top-anchored Atrium panel instead of `@codemirror/search`'s own bottom
 * two-row default. The search/replace engine (`SearchQuery`, `findNext`,
 * `findPrevious`, `replaceNext`, `replaceAll`, `selectMatches`,
 * `closeSearchPanel`) is `@codemirror/search`'s own, untouched — only the
 * panel's DOM (`createAtriumSearchPanel`) and its `top: true` placement are
 * overridden, both documented `SearchConfig` extension points.
 */
export function inFileSearch(): Extension[] {
  return [search({ top: true, createPanel: createAtriumSearchPanel }), atriumSearchPanelTheme];
}

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag: string, attrs: Record<string, string>): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

/** A 16x16 icon canvas matching the app's other hand-rolled SVG icons (`viewBox="0 0 16 16"`, `stroke="currentColor"`, no fill). */
function iconCanvas(): SVGSVGElement {
  return svgEl("svg", {
    viewBox: "0 0 16 16",
    width: "14",
    height: "14",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.3",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  }) as SVGSVGElement;
}

/** Builds a stroke-only icon from a list of path `d` attributes. */
function icon(...pathData: string[]): SVGSVGElement {
  const node = iconCanvas();
  for (const d of pathData) node.appendChild(svgEl("path", { d }));
  return node;
}

const icons = {
  previous: () => icon("M4 10L8 6L12 10"),
  next: () => icon("M4 6L8 10L12 6"),
  disclosure: () => icon("M6 4L10 8L6 12"),
  close: () => icon("M4 4L12 12", "M12 4L4 12"),
  replaceOne: () => icon("M3 8H11", "M8 5L11 8L8 11"),
  replaceAll: () => icon("M3 5.5H10.5", "M8 3L10.5 5.5L8 8", "M3 10.5H10.5", "M8 8L10.5 10.5L8 13"),
  /** Three cursor carets on a shared baseline, evoking the multi-cursor selection `selectMatches` produces. */
  selectAll: () => {
    const node = iconCanvas();
    node.appendChild(svgEl("path", { d: "M2 13H14" }));
    for (const x of [4, 8, 12]) {
      node.appendChild(svgEl("path", { d: `M${x} 3V11`, "stroke-width": "1.6" }));
    }
    return node;
  },
};

type ElAttrs = Record<string, string | EventListener | boolean | undefined>;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: ElAttrs = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2), value);
    } else if (typeof value === "boolean") {
      if (value) node.setAttribute(key, "");
    } else {
      node.setAttribute(key, value as string);
    }
  }
  for (const child of children) node.append(child);
  return node;
}

function iconButton(
  svg: SVGSVGElement,
  attrs: { "aria-label": string; title?: string; onclick: EventListener },
): HTMLButtonElement {
  const button = el("button", {
    type: "button",
    class: "cm-atrium-search-icon-btn",
    "aria-label": attrs["aria-label"],
    title: attrs.title ?? attrs["aria-label"],
    onclick: attrs.onclick,
  });
  button.appendChild(svg);
  return button;
}

function glyphToggle(glyph: string, ariaLabel: string, onclick: EventListener): HTMLButtonElement {
  return el(
    "button",
    {
      type: "button",
      class: "cm-atrium-search-glyph-btn",
      "aria-label": ariaLabel,
      title: ariaLabel,
      onclick,
    },
    [glyph],
  );
}

/**
 * `@codemirror/search`'s documented `createPanel` extension point. Mirrors
 * the shape of the library's own `SearchPanel` (constructor builds the DOM
 * once; `commit`/`keydown`/`update`/`setQuery`/`mount` drive it afterwards)
 * but replaces the DOM with a single-line, icon-driven, collapsed-by-default
 * layout, and reads/writes the search state entirely through
 * `@codemirror/search`'s public API (`getSearchQuery`, `setSearchQuery`,
 * `findNext`, `findPrevious`, `replaceNext`, `replaceAll`, `selectMatches`).
 */
export function createAtriumSearchPanel(view: EditorView): Panel {
  return new AtriumSearchPanel(view);
}

class AtriumSearchPanel implements Panel {
  dom: HTMLElement;
  top = true;

  private view: EditorView;
  private query: SearchQuery;
  private readonly readOnly: boolean;

  private searchField: HTMLInputElement;
  private replaceField: HTMLInputElement;
  private caseToggle: HTMLButtonElement;
  private regexToggle: HTMLButtonElement;
  private wordToggle: HTMLButtonElement;
  private matchCountDom: HTMLElement;
  private replaceRow: HTMLElement | null = null;
  private disclosureButton: HTMLButtonElement | null = null;
  private replaceExpanded = false;

  private readonly row1: HTMLElement;

  /** A bound field (not a prototype method) so it can be passed directly as an `oninput`/`onchange` handler. */
  private readonly commit = (): void => {
    const query = new SearchQuery({
      search: this.searchField.value,
      caseSensitive: this.isPressed(this.caseToggle),
      regexp: this.isPressed(this.regexToggle),
      wholeWord: this.isPressed(this.wordToggle),
      replace: this.replaceField.value,
    });
    if (!query.eq(this.query)) {
      this.query = query;
      this.view.dispatch({ effects: setSearchQuery.of(query) });
    }
    this.updateMatchCount();
  };

  constructor(view: EditorView) {
    this.view = view;
    this.readOnly = view.state.readOnly;
    this.query = getSearchQuery(view.state);

    this.searchField = el("input", {
      value: this.query.search,
      placeholder: "Find",
      "aria-label": "Find",
      class: "cm-atrium-search-input",
      name: "search",
      "main-field": "true",
      autocomplete: "off",
      autocorrect: "off",
      autocapitalize: "off",
      spellcheck: "false",
      onchange: this.commit,
      oninput: this.commit,
    });

    this.matchCountDom = el("span", { class: "cm-atrium-search-count" });

    this.caseToggle = glyphToggle("Aa", "Match case", () => {
      this.caseToggle.setAttribute("aria-pressed", String(!this.isPressed(this.caseToggle)));
      this.commit();
    });
    this.regexToggle = glyphToggle(".*", "Use regular expression", () => {
      this.regexToggle.setAttribute("aria-pressed", String(!this.isPressed(this.regexToggle)));
      this.commit();
    });
    this.wordToggle = glyphToggle("|ab|", "Match whole word", () => {
      this.wordToggle.setAttribute("aria-pressed", String(!this.isPressed(this.wordToggle)));
      this.commit();
    });
    this.setToggleState(this.caseToggle, this.query.caseSensitive);
    this.setToggleState(this.regexToggle, this.query.regexp);
    this.setToggleState(this.wordToggle, this.query.wholeWord);

    const rowChildren: (Node | string)[] = [
      this.searchField,
      this.matchCountDom,
      iconButton(icons.previous(), {
        "aria-label": "Previous match",
        title: "Previous match (Shift+Enter)",
        onclick: () => findPrevious(this.view),
      }),
      iconButton(icons.next(), {
        "aria-label": "Next match",
        title: "Next match (Enter)",
        onclick: () => findNext(this.view),
      }),
      this.caseToggle,
      this.regexToggle,
      this.wordToggle,
      iconButton(icons.selectAll(), {
        "aria-label": "Select all matches",
        onclick: () => selectMatches(this.view),
      }),
    ];

    this.replaceField = el("input", {
      value: this.query.replace,
      placeholder: "Replace",
      "aria-label": "Replace",
      class: "cm-atrium-search-input",
      name: "replace",
      autocomplete: "off",
      autocorrect: "off",
      autocapitalize: "off",
      spellcheck: "false",
      onchange: this.commit,
      oninput: this.commit,
    });

    if (!this.readOnly) {
      this.disclosureButton = iconButton(icons.disclosure(), {
        "aria-label": "Toggle replace",
        onclick: () => this.toggleReplace(),
      });
      this.disclosureButton.classList.add("cm-atrium-search-disclosure-btn");
      this.disclosureButton.setAttribute("aria-expanded", "false");
      rowChildren.push(this.disclosureButton);
    }

    rowChildren.push(
      iconButton(icons.close(), {
        "aria-label": "Close",
        onclick: () => closeSearchPanel(this.view),
      }),
    );

    this.row1 = el("div", { class: "cm-atrium-search-row" }, rowChildren);
    this.dom = el(
      "div",
      { class: "cm-atrium-search", onkeydown: (e) => this.keydown(e as KeyboardEvent) },
      [this.row1],
    );

    this.updateMatchCount();
  }

  private isPressed(button: HTMLButtonElement): boolean {
    return button.getAttribute("aria-pressed") === "true";
  }

  private setToggleState(button: HTMLButtonElement, pressed: boolean): void {
    button.setAttribute("aria-pressed", String(pressed));
  }

  private toggleReplace(): void {
    if (!this.disclosureButton) return;
    this.replaceExpanded = !this.replaceExpanded;
    this.disclosureButton.setAttribute("aria-expanded", String(this.replaceExpanded));
    if (this.replaceExpanded) {
      this.replaceRow = el("div", { class: "cm-atrium-search-row cm-atrium-search-replace-row" }, [
        this.replaceField,
        iconButton(icons.replaceOne(), {
          "aria-label": "Replace",
          onclick: () => replaceNext(this.view),
        }),
        iconButton(icons.replaceAll(), {
          "aria-label": "Replace all",
          onclick: () => replaceAll(this.view),
        }),
      ]);
      this.dom.appendChild(this.replaceRow);
    } else if (this.replaceRow) {
      this.replaceRow.remove();
      this.replaceRow = null;
    }
  }

  private keydown(event: KeyboardEvent): void {
    if (runScopeHandlers(this.view, event, "search-panel")) {
      event.preventDefault();
    } else if (event.key === "Enter" && event.target === this.searchField) {
      event.preventDefault();
      (event.shiftKey ? findPrevious : findNext)(this.view);
    } else if (event.key === "Enter" && event.target === this.replaceField) {
      event.preventDefault();
      replaceNext(this.view);
    }
  }

  update(update: ViewUpdate): void {
    for (const tr of update.transactions) {
      for (const effect of tr.effects) {
        if (effect.is(setSearchQuery) && !effect.value.eq(this.query)) {
          this.setQuery(effect.value);
        }
      }
    }
    this.updateMatchCount();
  }

  private setQuery(query: SearchQuery): void {
    this.query = query;
    this.searchField.value = query.search;
    this.replaceField.value = query.replace;
    this.setToggleState(this.caseToggle, query.caseSensitive);
    this.setToggleState(this.regexToggle, query.regexp);
    this.setToggleState(this.wordToggle, query.wholeWord);
  }

  /** Recomputes the Zed-style "n of N" indicator via `SearchQuery.getCursor`'s public, documented API. */
  private updateMatchCount(): void {
    if (!this.query.valid || this.query.search === "") {
      this.matchCountDom.textContent = "";
      return;
    }
    const state = this.view.state;
    const sel = state.selection.main;
    const cursor = this.query.getCursor(state);
    let total = 0;
    let current = 0;
    for (let result = cursor.next(); !result.done; result = cursor.next()) {
      total += 1;
      if (result.value.from === sel.from && result.value.to === sel.to) {
        current = total;
      }
    }
    this.matchCountDom.textContent =
      total === 0 ? "No results" : current > 0 ? `${current} of ${total}` : `${total} found`;
  }

  mount(): void {
    this.searchField.focus();
    this.searchField.select();
  }
}

/**
 * Colors and lays out `.cm-atrium-search` from `--atrium-*` CSS custom
 * properties rather than baked `Theme.tokens` values, deliberately breaking
 * from `cmTheme.ts`'s imperative-token convention: `applyThemeToDocument()`
 * already keeps those variables current on every theme switch, so this CSS
 * re-colors itself with no reconfigure/compartment plumbing needed for a
 * panel that only exists while the user has it open.
 */
export const atriumSearchPanelTheme = EditorView.baseTheme({
  ".cm-panel.cm-atrium-search": {
    backgroundColor: "var(--atrium-bg-elevated)",
    borderBottom: "1px solid var(--atrium-border)",
    color: "var(--atrium-text-primary)",
    fontFamily: "inherit",
    fontSize: "13px",
  },
  ".cm-atrium-search-row": {
    display: "flex",
    flexWrap: "nowrap",
    alignItems: "center",
    gap: "4px",
    padding: "5px 8px",
  },
  ".cm-atrium-search-replace-row": {
    borderTop: "1px solid var(--atrium-border)",
  },
  ".cm-atrium-search-input": {
    flex: "1 1 auto",
    minWidth: "80px",
    font: "inherit",
    color: "inherit",
    background: "var(--atrium-bg-surface)",
    border: "1px solid var(--atrium-border)",
    borderRadius: "4px",
    padding: "3px 8px",
    outline: "none",
  },
  ".cm-atrium-search-input:focus": {
    borderColor: "var(--atrium-accent)",
  },
  ".cm-atrium-search-count": {
    flexShrink: "0",
    color: "var(--atrium-text-muted)",
    fontSize: "0.85em",
    whiteSpace: "nowrap",
    padding: "0 2px",
    minWidth: "3.5em",
  },
  ".cm-atrium-search-icon-btn, .cm-atrium-search-glyph-btn": {
    flexShrink: "0",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "22px",
    height: "22px",
    padding: "0",
    background: "transparent",
    border: "1px solid transparent",
    borderRadius: "4px",
    color: "var(--atrium-text-secondary)",
    cursor: "pointer",
  },
  ".cm-atrium-search-glyph-btn": {
    width: "auto",
    minWidth: "22px",
    padding: "0 5px",
    fontSize: "0.8em",
  },
  ".cm-atrium-search-icon-btn:hover, .cm-atrium-search-glyph-btn:hover": {
    background: "var(--atrium-bg-hover)",
    color: "var(--atrium-text-primary)",
  },
  '.cm-atrium-search-icon-btn[aria-pressed="true"], .cm-atrium-search-glyph-btn[aria-pressed="true"]': {
    background: "var(--atrium-bg-active)",
    borderColor: "var(--atrium-accent)",
    color: "var(--atrium-accent)",
  },
  '.cm-atrium-search-disclosure-btn[aria-expanded="true"] svg': {
    transform: "rotate(90deg)",
  },
});

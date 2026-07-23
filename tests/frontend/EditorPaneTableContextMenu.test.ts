import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { tick } from "svelte";
import { render, fireEvent, cleanup } from "@testing-library/svelte";
import { EditorView } from "@codemirror/view";
import EditorPane from "../../src/lib/editor/EditorPane.svelte";
import { tabsState, type Tab } from "../../src/lib/stores/tabs";
import * as clipboardManager from "@tauri-apps/plugin-clipboard-manager";
import * as reveal from "../../src/lib/ipc/reveal";
import * as commands from "../../src/lib/ipc/commands";

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  readText: vi.fn(),
  writeText: vi.fn(),
}));

vi.mock("../../src/lib/ipc/reveal", () => ({
  revealInFinder: vi.fn(),
}));

vi.mock("../../src/lib/ipc/commands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/ipc/commands")>();
  return {
    ...actual,
    fsWriteFile: vi.fn().mockResolvedValue(undefined),
  };
});

const MD_PATH = "/table.md";
const BASIC_TABLE = "| Name  | Role     |\n| ----- | -------- |\n| Alice | Engineer |\n| Bob   | Designer |\n";

function seedMarkdownTab(content: string): void {
  const tab: Tab = {
    path: MD_PATH,
    mode: "markdown",
    savedDoc: content,
    isDirty: false,
    hasExternalConflict: false,
    viewMode: "rendered",
  };
  tabsState.set({ tabs: [tab], activeTabPath: MD_PATH });
}

function findView(container: HTMLElement): EditorView {
  const dom = container.querySelector(".cm-editor") as HTMLElement;
  const view = EditorView.findFromDOM(dom);
  if (!view) throw new Error("expected an EditorView to be mounted");
  return view;
}

/**
 * jsdom has no layout engine, so `EditorView.posAtCoords` throws once it has
 * to resolve a coordinate against real inline text (`markdownLinkClick.test.ts`
 * documents the same gap for `mousedown`'s built-in cursor placement).
 * Stubbing the method directly to the intended document position is this
 * suite's version of that file's own "manually apply what a real click would
 * have resolved to" technique, applied to a right-click instead.
 */
async function openMenuAt(container: HTMLElement, pos: number): Promise<EditorView> {
  const view = findView(container);
  vi.spyOn(view, "posAtCoords").mockReturnValue(pos);
  await fireEvent.contextMenu(container.querySelector(".editor-pane")!);
  return view;
}

function menuItem(container: HTMLElement, label: string): HTMLButtonElement {
  const items = [...container.querySelectorAll('[role="menuitem"]')] as HTMLButtonElement[];
  const item = items.find((el) => el.textContent === label);
  if (!item) throw new Error(`menu item not found: ${label}`);
  return item;
}

function hasMenuItem(container: HTMLElement, label: string): boolean {
  return [...container.querySelectorAll('[role="menuitem"]')].some((el) => el.textContent === label);
}

describe("EditorPane: table context menu", () => {
  beforeEach(() => {
    vi.mocked(clipboardManager.readText).mockReset().mockResolvedValue("");
    vi.mocked(reveal.revealInFinder).mockReset().mockResolvedValue(undefined);
    vi.mocked(commands.fsWriteFile).mockClear();
  });

  afterEach(() => {
    cleanup();
    tabsState.set({ tabs: [], activeTabPath: null });
  });

  it("shows no row/column section when the right-click lands outside a table", async () => {
    seedMarkdownTab("# Heading\n\nplain paragraph\n");
    const { container } = render(EditorPane, { filePath: MD_PATH, paneId: "pane-1" });
    await tick();

    await openMenuAt(container, 3);

    expect(hasMenuItem(container, "Insert Row Above")).toBe(false);
    expect(hasMenuItem(container, "Insert Column Left")).toBe(false);
  });

  it("shows header-specific row buttons disabled, with Insert Row Below enabled", async () => {
    seedMarkdownTab(BASIC_TABLE);
    const { container } = render(EditorPane, { filePath: MD_PATH, paneId: "pane-1" });
    await tick();

    await openMenuAt(container, BASIC_TABLE.indexOf("Name"));

    expect(menuItem(container, "Insert Row Above").disabled).toBe(true);
    expect(menuItem(container, "Insert Row Below").disabled).toBe(false);
    expect(menuItem(container, "Delete Row").disabled).toBe(true);
    expect(menuItem(container, "Move Row Up").disabled).toBe(true);
    expect(menuItem(container, "Move Row Down").disabled).toBe(true);
  });

  it("shows the identical row-button pattern for a right-click on the delimiter row, with column availability matching the header's own", async () => {
    seedMarkdownTab(BASIC_TABLE);
    const { container } = render(EditorPane, { filePath: MD_PATH, paneId: "pane-1" });
    await tick();

    // The first delimiter segment ("-----") is column 0 — the same leftmost
    // edge as the header's own "Name" cell, so Move Column Left is disabled
    // there for the same reason (no column to its left), not because the
    // delimiter rowKind behaves differently.
    await openMenuAt(container, BASIC_TABLE.indexOf("-----"));

    expect(menuItem(container, "Insert Row Above").disabled).toBe(true);
    expect(menuItem(container, "Insert Row Below").disabled).toBe(false);
    expect(menuItem(container, "Delete Row").disabled).toBe(true);
    expect(menuItem(container, "Move Row Up").disabled).toBe(true);
    expect(menuItem(container, "Move Row Down").disabled).toBe(true);
    expect(menuItem(container, "Insert Column Left").disabled).toBe(false);
    expect(menuItem(container, "Insert Column Right").disabled).toBe(false);
    expect(menuItem(container, "Delete Column").disabled).toBe(false);
    expect(menuItem(container, "Move Column Left").disabled).toBe(true);
    expect(menuItem(container, "Move Column Right").disabled).toBe(false);
  });

  it("enables every row button for a body row except what the table's own edges forbid", async () => {
    seedMarkdownTab(BASIC_TABLE);
    const { container } = render(EditorPane, { filePath: MD_PATH, paneId: "pane-1" });
    await tick();

    await openMenuAt(container, BASIC_TABLE.indexOf("Alice"));
    expect(menuItem(container, "Insert Row Above").disabled).toBe(false);
    expect(menuItem(container, "Insert Row Below").disabled).toBe(false);
    expect(menuItem(container, "Delete Row").disabled).toBe(false);
    expect(menuItem(container, "Move Row Up").disabled).toBe(true); // first body row
    expect(menuItem(container, "Move Row Down").disabled).toBe(false);

    await fireEvent.click(document.body);
    await openMenuAt(container, BASIC_TABLE.indexOf("Bob"));
    expect(menuItem(container, "Move Row Up").disabled).toBe(false);
    expect(menuItem(container, "Move Row Down").disabled).toBe(true); // last body row
  });

  it("disables Move Column only at the table's own left/right edges", async () => {
    seedMarkdownTab(BASIC_TABLE);
    const { container } = render(EditorPane, { filePath: MD_PATH, paneId: "pane-1" });
    await tick();

    await openMenuAt(container, BASIC_TABLE.indexOf("Name"));
    expect(menuItem(container, "Insert Column Left").disabled).toBe(false);
    expect(menuItem(container, "Insert Column Right").disabled).toBe(false);
    expect(menuItem(container, "Delete Column").disabled).toBe(false);
    expect(menuItem(container, "Move Column Left").disabled).toBe(true);
    expect(menuItem(container, "Move Column Right").disabled).toBe(false);

    await fireEvent.click(document.body);
    await openMenuAt(container, BASIC_TABLE.indexOf("Role"));
    expect(menuItem(container, "Move Column Left").disabled).toBe(false);
    expect(menuItem(container, "Move Column Right").disabled).toBe(true);
  });

  it("dispatches the expected doc change and closes the menu when Insert Row Below is clicked", async () => {
    seedMarkdownTab(BASIC_TABLE);
    const { container } = render(EditorPane, { filePath: MD_PATH, paneId: "pane-1" });
    await tick();

    const view = await openMenuAt(container, BASIC_TABLE.indexOf("Name"));
    await fireEvent.click(menuItem(container, "Insert Row Below"));

    expect(view.state.doc.toString()).toBe(
      "| Name  | Role     |\n| ----- | -------- |\n|  |  |\n| Alice | Engineer |\n| Bob   | Designer |\n",
    );
    expect(container.querySelector(".context-menu")).toBeNull();
  });

  it("dispatches the expected doc change when Delete Column is clicked", async () => {
    seedMarkdownTab(BASIC_TABLE);
    const { container } = render(EditorPane, { filePath: MD_PATH, paneId: "pane-1" });
    await tick();

    const view = await openMenuAt(container, BASIC_TABLE.indexOf("Name"));
    await fireEvent.click(menuItem(container, "Delete Column"));

    expect(view.state.doc.toString()).toBe("| Role     |\n| -------- |\n| Engineer |\n| Designer |\n");
  });

  it("dispatches the expected doc change when Move Row Down is clicked", async () => {
    seedMarkdownTab(BASIC_TABLE);
    const { container } = render(EditorPane, { filePath: MD_PATH, paneId: "pane-1" });
    await tick();

    const view = await openMenuAt(container, BASIC_TABLE.indexOf("Alice"));
    await fireEvent.click(menuItem(container, "Move Row Down"));

    expect(view.state.doc.toString()).toBe(
      "| Name  | Role     |\n| ----- | -------- |\n| Bob   | Designer |\n| Alice | Engineer |\n",
    );
  });

  it("leaves the document untouched when a disabled item is clicked", async () => {
    seedMarkdownTab(BASIC_TABLE);
    const { container } = render(EditorPane, { filePath: MD_PATH, paneId: "pane-1" });
    await tick();

    const view = await openMenuAt(container, BASIC_TABLE.indexOf("Name"));
    const before = view.state.doc.toString();
    const button = menuItem(container, "Delete Row");
    expect(button.disabled).toBe(true);
    await fireEvent.click(button);
    expect(view.state.doc.toString()).toBe(before);
  });
});

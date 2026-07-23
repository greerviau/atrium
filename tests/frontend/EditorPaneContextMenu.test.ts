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

// jsdom doesn't implement `document.execCommand` at all (not even a stub
// that throws NotSupportedError), so Cut/Copy's real mechanism needs a
// stand-in to observe what the component asked the browser to do.
document.execCommand = vi.fn();

const CODE_PATH = "/main.ts";
const MD_PATH = "/notes.md";

function seedCodeTab(): void {
  const tab: Tab = {
    path: CODE_PATH,
    mode: "code",
    savedDoc: "const x = 1;\n",
    isDirty: false,
    hasExternalConflict: false,
  };
  tabsState.set({ tabs: [tab], activeTabPath: CODE_PATH });
}

function seedMarkdownTab(viewMode: "rendered" | "source" = "rendered"): void {
  const tab: Tab = {
    path: MD_PATH,
    mode: "markdown",
    savedDoc: "# Heading\n",
    isDirty: false,
    hasExternalConflict: false,
    viewMode,
  };
  tabsState.set({ tabs: [tab], activeTabPath: MD_PATH });
}

function findView(container: HTMLElement): EditorView {
  const dom = container.querySelector(".cm-editor") as HTMLElement;
  const view = EditorView.findFromDOM(dom);
  if (!view) throw new Error("expected an EditorView to be mounted");
  return view;
}

async function openMenu(container: HTMLElement): Promise<void> {
  await fireEvent.contextMenu(container.querySelector(".editor-pane")!);
}

describe("EditorPane: context menu", () => {
  beforeEach(() => {
    vi.mocked(clipboardManager.readText).mockReset().mockResolvedValue("");
    vi.mocked(clipboardManager.writeText).mockReset();
    vi.mocked(reveal.revealInFinder).mockReset().mockResolvedValue(undefined);
    vi.mocked(commands.fsWriteFile).mockClear();
    vi.mocked(document.execCommand).mockClear();
  });

  afterEach(() => {
    cleanup();
    tabsState.set({ tabs: [], activeTabPath: null });
  });

  it("opens the four groups, in order, for a markdown tab", async () => {
    seedMarkdownTab();
    const { container } = render(EditorPane, { filePath: MD_PATH, paneId: "pane-1" });
    await tick();

    await openMenu(container);

    const items = [...container.querySelectorAll('[role="menuitem"], [role="separator"]')].map((el) =>
      el.getAttribute("role") === "separator" ? "—" : el.textContent,
    );
    expect(items).toEqual([
      "Cut",
      "Copy",
      "Paste",
      "—",
      "Select All",
      "—",
      "Switch to Source View",
      "—",
      "Save",
      "Reveal in Finder",
    ]);
  });

  it("omits the View group for a non-markdown tab", async () => {
    seedCodeTab();
    const { container } = render(EditorPane, { filePath: CODE_PATH, paneId: "pane-1" });
    await tick();

    await openMenu(container);

    const labels = [...container.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent);
    expect(labels).toEqual(["Cut", "Copy", "Paste", "Select All", "Save", "Reveal in Finder"]);
  });

  it("labels the View item by the tab's current view mode", async () => {
    seedMarkdownTab("source");
    const { container, findByText } = render(EditorPane, { filePath: MD_PATH, paneId: "pane-1" });
    await tick();

    await openMenu(container);

    expect(await findByText("Switch to Rendered View")).toBeTruthy();
  });

  it("disables Cut/Copy with no selection and enables them once there is one", async () => {
    seedCodeTab();
    const { container, findByText } = render(EditorPane, { filePath: CODE_PATH, paneId: "pane-1" });
    await tick();

    await openMenu(container);
    expect(((await findByText("Cut")) as HTMLButtonElement).disabled).toBe(true);
    expect(((await findByText("Copy")) as HTMLButtonElement).disabled).toBe(true);

    await fireEvent.click(document.body);

    const view = findView(container);
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    await openMenu(container);

    expect(((await findByText("Cut")) as HTMLButtonElement).disabled).toBe(false);
    expect(((await findByText("Copy")) as HTMLButtonElement).disabled).toBe(false);
  });

  it("runs execCommand('cut'/'copy') against the focused editor and closes the menu", async () => {
    seedCodeTab();
    const { container, findByText } = render(EditorPane, { filePath: CODE_PATH, paneId: "pane-1" });
    await tick();

    await openMenu(container);
    await fireEvent.click(await findByText("Cut"));

    expect(document.execCommand).toHaveBeenCalledWith("cut");
    expect(container.querySelector(".context-menu")).toBeNull();

    await openMenu(container);
    await fireEvent.click(await findByText("Copy"));

    expect(document.execCommand).toHaveBeenCalledWith("copy");
  });

  it("disables Paste while the clipboard has no text", async () => {
    seedCodeTab();
    vi.mocked(clipboardManager.readText).mockResolvedValue("");
    const { container, findByText } = render(EditorPane, { filePath: CODE_PATH, paneId: "pane-1" });
    await tick();

    await openMenu(container);
    const pasteButton = (await findByText("Paste")) as HTMLButtonElement;
    await tick();
    expect(pasteButton.disabled).toBe(true);
  });

  it("enables Paste once the async clipboard read resolves with text", async () => {
    seedCodeTab();
    vi.mocked(clipboardManager.readText).mockResolvedValue("clipboard contents");
    const { container, findByText } = render(EditorPane, { filePath: CODE_PATH, paneId: "pane-1" });
    await tick();

    await openMenu(container);
    const pasteButton = (await findByText("Paste")) as HTMLButtonElement;
    await vi.waitFor(() => {
      expect(pasteButton.disabled).toBe(false);
    });
  });

  it("pastes clipboard text into the document at the current selection", async () => {
    seedCodeTab();
    vi.mocked(clipboardManager.readText).mockResolvedValue("PASTED");
    const { container, findByText } = render(EditorPane, { filePath: CODE_PATH, paneId: "pane-1" });
    await tick();

    const view = findView(container);
    view.dispatch({ selection: { anchor: 0, head: 5 } }); // selects "const"

    await openMenu(container);
    const pasteButton = (await findByText("Paste")) as HTMLButtonElement;
    await vi.waitFor(() => {
      expect(pasteButton.disabled).toBe(false);
    });
    await fireEvent.click(pasteButton);
    await vi.waitFor(() => {
      expect(view.state.doc.toString()).toBe("PASTED x = 1;\n");
    });
  });

  it("calls toggleMarkdownViewMode and closes the menu when the View item is clicked", async () => {
    seedMarkdownTab("rendered");
    const { container, findByText } = render(EditorPane, { filePath: MD_PATH, paneId: "pane-1" });
    await tick();

    await openMenu(container);
    await fireEvent.click(await findByText("Switch to Source View"));
    await tick();

    expect(container.querySelector(".context-menu")).toBeNull();

    await openMenu(container);
    expect(await findByText("Switch to Rendered View")).toBeTruthy();
  });

  it("saves via the existing save path and closes the menu", async () => {
    seedCodeTab();
    const { container, findByText } = render(EditorPane, { filePath: CODE_PATH, paneId: "pane-1" });
    await tick();

    await openMenu(container);
    await fireEvent.click(await findByText("Save"));

    await vi.waitFor(() => {
      expect(commands.fsWriteFile).toHaveBeenCalledWith("local", CODE_PATH, "const x = 1;\n");
    });
    expect(container.querySelector(".context-menu")).toBeNull();
  });

  it("reveals the open file and closes the menu", async () => {
    seedCodeTab();
    const { container, findByText } = render(EditorPane, { filePath: CODE_PATH, paneId: "pane-1" });
    await tick();

    await openMenu(container);
    await fireEvent.click(await findByText("Reveal in Finder"));

    await vi.waitFor(() => {
      expect(reveal.revealInFinder).toHaveBeenCalledWith(CODE_PATH);
    });
    expect(container.querySelector(".context-menu")).toBeNull();
  });

  it("closes the menu on an outside click", async () => {
    seedCodeTab();
    const { container } = render(EditorPane, { filePath: CODE_PATH, paneId: "pane-1" });
    await tick();

    await openMenu(container);
    expect(container.querySelector(".context-menu")).not.toBeNull();

    await fireEvent.click(document.body);
    expect(container.querySelector(".context-menu")).toBeNull();
  });
});

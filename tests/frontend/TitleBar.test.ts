import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/svelte";
import TitleBar from "../../src/lib/shell/TitleBar.svelte";
import { workspace } from "../../src/lib/stores/workspace";
import { recents } from "../../src/lib/stores/recents";
import { tabsState, type Tab } from "../../src/lib/stores/tabs";
import * as workspaceStore from "../../src/lib/stores/workspace";
import * as tabsStore from "../../src/lib/stores/tabs";

function standaloneTab(path: string): Tab {
  return {
    path,
    workspaceId: "standalone",
    mode: "code",
    savedDoc: "",
    isDirty: false,
    hasExternalConflict: false,
    isExternal: true,
    isDeleted: false,
  };
}

vi.mock("../../src/lib/stores/workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/stores/workspace")>();
  return {
    ...actual,
    openWorkspaceFolder: vi.fn(),
    openWorkspacePath: vi.fn(),
  };
});

vi.mock("../../src/lib/stores/tabs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/stores/tabs")>();
  return {
    ...actual,
    openExternalFile: vi.fn(),
  };
});

const current = { path: "/projects/demo", name: "demo", lastOpenedAt: 3, isFile: false };
const other = { path: "/projects/other-proj", name: "other-proj", lastOpenedAt: 2, isFile: false };
const standaloneFile = { path: "/tmp/scratch/notes.md", name: "notes.md", lastOpenedAt: 4, isFile: true };

describe("TitleBar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspace.set({ id: "local", root: null });
    recents.set([]);
    tabsState.set({ tabs: [], activeTabPath: null });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders no button or menu when no workspace is open", () => {
    const { queryByRole } = render(TitleBar);

    expect(queryByRole("button")).toBeNull();
    expect(queryByRole("menu")).toBeNull();
  });

  it("shows the current project's folder name as the button label", () => {
    workspace.set({ id: "local", root: "/projects/demo" });

    const { getByRole } = render(TitleBar);

    expect(getByRole("button", { name: "Switch project" }).textContent).toContain("demo");
  });

  it("opens a menu listing other recent projects, excluding the current one", async () => {
    workspace.set({ id: "local", root: current.path });
    recents.set([current, other]);

    const { getByRole, findByText, queryByText } = render(TitleBar);
    await fireEvent.click(getByRole("button", { name: "Switch project" }));

    expect(await findByText("other-proj")).toBeTruthy();
    expect(await findByText("/projects/other-proj")).toBeTruthy();
    expect(queryByText("/projects/demo")).toBeNull();
  });

  it("clicking a recent row calls openWorkspacePath with that project's path", async () => {
    workspace.set({ id: "local", root: current.path });
    recents.set([current, other]);

    const { getByRole, findByText } = render(TitleBar);
    await fireEvent.click(getByRole("button", { name: "Switch project" }));
    await fireEvent.click(await findByText("other-proj"));

    expect(workspaceStore.openWorkspacePath).toHaveBeenCalledWith(other.path);
  });

  it("clicking Open Folder… calls openWorkspaceFolder", async () => {
    workspace.set({ id: "local", root: current.path });
    recents.set([current]);

    const { getByRole, findByText } = render(TitleBar);
    await fireEvent.click(getByRole("button", { name: "Switch project" }));
    await fireEvent.click(await findByText("Open Folder…"));

    expect(workspaceStore.openWorkspaceFolder).toHaveBeenCalledOnce();
  });

  it("shows the empty state when there are no other recent projects", async () => {
    workspace.set({ id: "local", root: current.path });
    recents.set([current]);

    const { getByRole, findByText } = render(TitleBar);
    await fireEvent.click(getByRole("button", { name: "Switch project" }));

    expect(await findByText("No other recent projects")).toBeTruthy();
  });

  it("marks the strip as a deep drag region and the switcher as an opt-out, so the dropdown never drags the window", () => {
    workspace.set({ id: "local", root: current.path });

    const { container } = render(TitleBar);

    expect(container.querySelector(".title-bar")?.getAttribute("data-tauri-drag-region")).toBe("deep");
    expect(container.querySelector(".switcher")?.getAttribute("data-tauri-drag-region")).toBe("false");
  });

  it("guards the title bar against accidental text selection (a double-click no longer bleeds a selection highlight into the file explorer)", () => {
    workspace.set({ id: "local", root: current.path });

    const { container } = render(TitleBar);

    const titleBar = container.querySelector(".title-bar");
    expect(titleBar).toBeTruthy();
    expect(window.getComputedStyle(titleBar!).userSelect).toBe("none");
  });

  it("re-enables selection on the switcher dropdown, so a recent project's path stays copyable despite the title bar's guard", async () => {
    workspace.set({ id: "local", root: current.path });
    recents.set([current, other]);

    const { getByRole, container } = render(TitleBar);
    await fireEvent.click(getByRole("button", { name: "Switch project" }));

    const menu = container.querySelector(".switcher-menu");
    expect(menu).toBeTruthy();
    expect(window.getComputedStyle(menu!).userSelect).toBe("text");
  });

  // Issue #325's follow-on defect: in a root-less standalone workspace the
  // switcher used to be entirely absent (gated on `$workspace.root` alone),
  // so there was no in-window way to switch to another project — only the
  // native File menu worked, with no visible affordance for it. It must now
  // be reachable whenever there's a standalone tab open, using that tab's
  // name as the label (there is no folder to name).
  it("shows the switcher in a root-less standalone workspace, labeled with the active tab", () => {
    workspace.set({ id: "local", root: null });
    tabsState.set({ tabs: [standaloneTab("/tmp/notes.md")], activeTabPath: "/tmp/notes.md" });

    const { getByRole } = render(TitleBar);

    expect(getByRole("button", { name: "Switch project" }).textContent).toContain("notes.md");
  });

  it("still shows no button when there is no root and no tab open (the true welcome-screen state)", () => {
    workspace.set({ id: "local", root: null });
    tabsState.set({ tabs: [], activeTabPath: null });

    const { queryByRole } = render(TitleBar);

    expect(queryByRole("button")).toBeNull();
  });

  it("lets Open Folder… be reached from the standalone switcher, satisfying the ability to switch away", async () => {
    workspace.set({ id: "local", root: null });
    tabsState.set({ tabs: [standaloneTab("/tmp/notes.md")], activeTabPath: "/tmp/notes.md" });

    const { getByRole, findByText } = render(TitleBar);
    await fireEvent.click(getByRole("button", { name: "Switch project" }));
    await fireEvent.click(await findByText("Open Folder…"));

    expect(workspaceStore.openWorkspaceFolder).toHaveBeenCalledOnce();
  });

  // Issue #325's follow-on defect: a file opened standalone is now recorded
  // to the same recents list as a folder — clicking it must route through
  // `openExternalFile` (which opens it standalone), not `openWorkspacePath`
  // (which would misinterpret the file path as a directory to switch into).
  it("clicking a recent FILE row opens it via openExternalFile, not openWorkspacePath", async () => {
    workspace.set({ id: "local", root: current.path });
    recents.set([current, standaloneFile]);

    const { getByRole, findByText } = render(TitleBar);
    await fireEvent.click(getByRole("button", { name: "Switch project" }));
    await fireEvent.click(await findByText("notes.md"));

    expect(tabsStore.openExternalFile).toHaveBeenCalledWith("/tmp/scratch/notes.md");
    expect(workspaceStore.openWorkspacePath).not.toHaveBeenCalled();
  });

  it("excludes the active standalone tab's own path from its recents list", async () => {
    workspace.set({ id: "local", root: null });
    tabsState.set({ tabs: [standaloneTab(standaloneFile.path)], activeTabPath: standaloneFile.path });
    recents.set([standaloneFile, other]);

    const { getByRole, findByText, queryByText } = render(TitleBar);
    await fireEvent.click(getByRole("button", { name: "Switch project" }));

    expect(await findByText("other-proj")).toBeTruthy();
    expect(queryByText(standaloneFile.path)).toBeNull();
  });
});

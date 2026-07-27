import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/svelte";
import TitleBar from "../../src/lib/shell/TitleBar.svelte";
import { workspace } from "../../src/lib/stores/workspace";
import { recents } from "../../src/lib/stores/recents";
import * as workspaceStore from "../../src/lib/stores/workspace";

vi.mock("../../src/lib/stores/workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/stores/workspace")>();
  return {
    ...actual,
    openWorkspaceFolder: vi.fn(),
    openWorkspacePath: vi.fn(),
  };
});

const current = { path: "/projects/demo", name: "demo", lastOpenedAt: 3 };
const other = { path: "/projects/other-proj", name: "other-proj", lastOpenedAt: 2 };

describe("TitleBar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspace.set({ id: "local", root: null });
    recents.set([]);
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
});

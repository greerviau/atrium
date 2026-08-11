import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/svelte";
import TitleBar from "../../src/lib/shell/TitleBar.svelte";
import { workspace } from "../../src/lib/stores/workspace";
import { recents } from "../../src/lib/stores/recents";
import { tabsState, type Tab } from "../../src/lib/stores/tabs";
import * as workspaceStore from "../../src/lib/stores/workspace";
import * as commands from "../../src/lib/ipc/commands";

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

vi.mock("../../src/lib/ipc/commands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/ipc/commands")>();
  return {
    ...actual,
    gitGetContext: vi.fn().mockResolvedValue(null),
    gitSwitchBranch: vi.fn().mockResolvedValue(undefined),
  };
});

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
    tabsState.set({ tabs: [], activeTabPath: null });
    vi.mocked(commands.gitGetContext).mockResolvedValue(null);
    vi.mocked(commands.gitSwitchBranch).mockResolvedValue(undefined);
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

  it("heads the project menu with a Recent Projects title, matching the worktree and branch menus", async () => {
    workspace.set({ id: "local", root: current.path });
    recents.set([current, other]);

    const { getByRole, findByText } = render(TitleBar);
    await fireEvent.click(getByRole("button", { name: "Switch project" }));

    expect(await findByText("Recent Projects")).toBeTruthy();
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

  it("shows the current worktree and branch when the project is a git repository", async () => {
    workspace.set({ id: "local", root: current.path });
    vi.mocked(commands.gitGetContext).mockResolvedValue({
      repositoryRoot: "/projects",
      worktreePath: current.path,
      branch: "main",
      head: "abc1234",
      worktrees: [
        { path: current.path, branch: "main", head: "abc1234", isCurrent: true },
        { path: "/projects/feature", branch: "feature/login", head: "def5678", isCurrent: false },
      ],
      branches: [
        { name: "main", worktreePath: current.path, isCurrent: true },
        { name: "feature/login", worktreePath: "/projects/feature", isCurrent: false },
        { name: "local-only", worktreePath: null, isCurrent: false },
      ],
    });

    const { findByRole } = render(TitleBar);
    const worktreeButton = await findByRole("button", { name: "Switch worktree" });
    const branchButton = await findByRole("button", { name: "Switch branch" });

    expect(worktreeButton.textContent).toContain("demo");
    expect(branchButton.textContent).toContain("main");
  });

  it("lists worktrees and branches in the git switcher", async () => {
    workspace.set({ id: "local", root: current.path });
    vi.mocked(commands.gitGetContext).mockResolvedValue({
      repositoryRoot: "/projects",
      worktreePath: current.path,
      branch: "main",
      head: "abc1234",
      worktrees: [
        { path: current.path, branch: "main", head: "abc1234", isCurrent: true },
        { path: "/projects/feature", branch: "feature/login", head: "def5678", isCurrent: false },
      ],
      branches: [
        { name: "main", worktreePath: current.path, isCurrent: true },
        { name: "feature/login", worktreePath: "/projects/feature", isCurrent: false },
        { name: "local-only", worktreePath: null, isCurrent: false },
      ],
    });

    const { container, findByRole, findByText, findAllByText } = render(TitleBar);
    await fireEvent.click(await findByRole("button", { name: "Switch worktree" }));

    expect(await findByText("feature")).toBeTruthy();
    expect(await findByText("feature/login")).toBeTruthy();
    expect(window.getComputedStyle(container.querySelector(".git-menu")!).height).toBe("300px");
    expect(window.getComputedStyle(container.querySelector(".git-menu-list")!).overflowY).toBe("auto");

    await fireEvent.click(await findByRole("button", { name: "Switch branch" }));
    expect(await findAllByText("feature/login")).toHaveLength(1);
    expect(await findByText("local-only")).toBeTruthy();
    expect(window.getComputedStyle(container.querySelector(".git-menu")!).height).toBe("300px");
    expect(window.getComputedStyle(container.querySelector(".git-menu-list")!).overflowY).toBe("auto");
  });

  it("switches to the worktree that owns a selected branch", async () => {
    workspace.set({ id: "local", root: current.path });
    vi.mocked(commands.gitGetContext).mockResolvedValue({
      repositoryRoot: "/projects",
      worktreePath: current.path,
      branch: "main",
      head: "abc1234",
      worktrees: [
        { path: current.path, branch: "main", head: "abc1234", isCurrent: true },
        { path: "/projects/feature", branch: "feature/login", head: "def5678", isCurrent: false },
      ],
      branches: [
        { name: "main", worktreePath: current.path, isCurrent: true },
        { name: "feature/login", worktreePath: "/projects/feature", isCurrent: false },
      ],
    });

    const { findByRole } = render(TitleBar);
    await fireEvent.click(await findByRole("button", { name: "Switch branch" }));
    const branchRows = await findByRole("menuitem", { name: "feature/login in feature" });
    await fireEvent.click(branchRows);

    expect(workspaceStore.openWorkspacePath).toHaveBeenCalledWith("/projects/feature");
    expect(commands.gitSwitchBranch).not.toHaveBeenCalled();
  });

  it("switches to a branch that is not checked out by another worktree", async () => {
    workspace.set({ id: "local", root: current.path });
    vi.mocked(commands.gitGetContext).mockResolvedValue({
      repositoryRoot: "/projects",
      worktreePath: current.path,
      branch: "main",
      head: "abc1234",
      worktrees: [{ path: current.path, branch: "main", head: "abc1234", isCurrent: true }],
      branches: [
        { name: "main", worktreePath: current.path, isCurrent: true },
        { name: "local-only", worktreePath: null, isCurrent: false },
      ],
    });

    const { findByRole } = render(TitleBar);
    await fireEvent.click(await findByRole("button", { name: "Switch branch" }));
    await fireEvent.click(await findByRole("menuitem", { name: "local-only" }));

    expect(commands.gitSwitchBranch).toHaveBeenCalledWith(current.path, "local-only");
  });

  it("shows the empty state when there are no other recent projects", async () => {
    workspace.set({ id: "local", root: current.path });
    recents.set([current]);

    const { getByRole, findByText } = render(TitleBar);
    await fireEvent.click(getByRole("button", { name: "Switch project" }));

    expect(await findByText("No other recent projects")).toBeTruthy();
    expect(await findByText("Recent Projects")).toBeTruthy();
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

  it("lists recent projects from the standalone switcher too, all still switched to via openWorkspacePath", async () => {
    workspace.set({ id: "local", root: null });
    tabsState.set({ tabs: [standaloneTab("/tmp/notes.md")], activeTabPath: "/tmp/notes.md" });
    recents.set([current, other]);

    const { getByRole, findByText } = render(TitleBar);
    await fireEvent.click(getByRole("button", { name: "Switch project" }));
    await fireEvent.click(await findByText("demo"));

    expect(workspaceStore.openWorkspacePath).toHaveBeenCalledWith(current.path);
  });
});

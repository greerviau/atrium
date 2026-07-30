import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/svelte";
import WelcomeScreen from "../../src/lib/welcome/WelcomeScreen.svelte";
import * as commands from "../../src/lib/ipc/commands";
import * as workspaceStore from "../../src/lib/stores/workspace";
import * as tabsStore from "../../src/lib/stores/tabs";

vi.mock("../../src/lib/ipc/commands", () => ({
  workspaceGetRecents: vi.fn(),
  workspaceRemoveRecent: vi.fn(),
}));

vi.mock("../../src/lib/stores/workspace", () => ({
  openWorkspaceFolder: vi.fn(),
  openWorkspacePath: vi.fn(),
}));

vi.mock("../../src/lib/stores/tabs", () => ({
  openExternalFile: vi.fn(),
}));

const project = { path: "/projects/foo", name: "foo", lastOpenedAt: 1, isFile: false };
const standaloneFile = { path: "/tmp/notes.md", name: "notes.md", lastOpenedAt: 2, isFile: true };

describe("WelcomeScreen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("shows the empty state when there are no recent projects", async () => {
    vi.mocked(commands.workspaceGetRecents).mockResolvedValue([]);

    const { findByText } = render(WelcomeScreen);

    expect(await findByText("No recent projects yet")).toBeTruthy();
  });

  it("renders a recent project's name and path", async () => {
    vi.mocked(commands.workspaceGetRecents).mockResolvedValue([project]);

    const { findByText } = render(WelcomeScreen);

    expect(await findByText("foo")).toBeTruthy();
    expect(await findByText("/projects/foo")).toBeTruthy();
  });

  it("clicking Open Folder… calls openWorkspaceFolder", async () => {
    vi.mocked(commands.workspaceGetRecents).mockResolvedValue([]);

    const { findByText } = render(WelcomeScreen);
    await fireEvent.click(await findByText("Open Folder…"));

    expect(workspaceStore.openWorkspaceFolder).toHaveBeenCalledOnce();
  });

  it("clicking a recent row opens it via openWorkspacePath", async () => {
    vi.mocked(commands.workspaceGetRecents).mockResolvedValue([project]);

    const { findByText } = render(WelcomeScreen);
    await fireEvent.click(await findByText("foo"));

    expect(workspaceStore.openWorkspacePath).toHaveBeenCalledWith("/projects/foo");
    expect(tabsStore.openExternalFile).not.toHaveBeenCalled();
  });

  // Issue #325's follow-on defect: a file opened standalone (e.g. from a
  // cold launch) is now recorded to the same recents list as a folder,
  // shown right alongside one (`RecentProject.isFile` is the only way to
  // tell them apart in this list) — clicking it must route through
  // `openExternalFile`, not `openWorkspacePath`, which would misinterpret
  // the file path as a directory to switch into.
  it("clicking a recent file row opens it via openExternalFile, not openWorkspacePath", async () => {
    vi.mocked(commands.workspaceGetRecents).mockResolvedValue([standaloneFile]);

    const { findByText } = render(WelcomeScreen);
    await fireEvent.click(await findByText("notes.md"));

    expect(tabsStore.openExternalFile).toHaveBeenCalledWith("/tmp/notes.md");
    expect(workspaceStore.openWorkspacePath).not.toHaveBeenCalled();
  });

  it("clicking remove calls workspace_remove_recent and does not open the project", async () => {
    vi.mocked(commands.workspaceGetRecents).mockResolvedValue([project]);
    vi.mocked(commands.workspaceRemoveRecent).mockResolvedValue(undefined);

    const { findByLabelText } = render(WelcomeScreen);
    await fireEvent.click(await findByLabelText("Remove foo from recent projects"));

    expect(commands.workspaceRemoveRecent).toHaveBeenCalledWith("/projects/foo");
    expect(workspaceStore.openWorkspacePath).not.toHaveBeenCalled();
  });
});
